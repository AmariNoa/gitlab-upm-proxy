import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import * as tar from "tar";
import * as unzipper from "unzipper";
import { request } from "undici";
import * as semver from "semver";
import { getTarballCachePath, readMetadataCache, writeMetadataCache } from "./cache";
import { getUpstreamConfig, matchScope, UpstreamEntry } from "./upstreams";

type VpmIndex = {
  author?: unknown;
  packages?: Record<string, { versions?: Record<string, any> }>;
};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function getVpmIndexUrl(upstream: UpstreamEntry): string {
  return upstream.baseUrl.endsWith(".json")
    ? upstream.baseUrl
    : `${upstream.baseUrl.replace(/\/+$/, "")}/index.json`;
}

function parseFloatEnv(name: string): number {
  const raw = mustEnv(name);
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid env: ${name}`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchVpmIndex(upstream: UpstreamEntry): Promise<VpmIndex> {
  const res = await request(getVpmIndexUrl(upstream), { method: "GET" });
  if (res.statusCode >= 400) {
    throw new Error(`vpm_index_failed:${res.statusCode}`);
  }
  return (await res.body.json()) as VpmIndex;
}

function computeSha1(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex");
}

async function unzipToDirectory(zipPath: string, targetDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(zipPath).pipe(unzipper.Extract({ path: targetDir }));
    stream.on("close", () => resolve());
    stream.on("error", (err) => reject(err));
  });
}

async function findPackageRoot(extractDir: string): Promise<string> {
  try {
    await stat(join(extractDir, "package.json"));
    return extractDir;
  } catch {
    // continue
  }

  const entries = await readdir(extractDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  if (dirs.length === 1) {
    const candidate = join(extractDir, dirs[0]);
    try {
      await stat(join(candidate, "package.json"));
      return candidate;
    } catch {
      return candidate;
    }
  }

  return extractDir;
}

async function readAuthorFromTgz(tgzPath: string): Promise<unknown> {
  const tempDir = await mkdtemp(join(dirname(tgzPath), "extract-"));
  try {
    await tar.x({
      file: tgzPath,
      cwd: tempDir,
      filter: (p) => p === "package/package.json"
    });
    const packageJsonPath = join(tempDir, "package", "package.json");
    const raw = await readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.author;
  } catch {
    return undefined;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function convertZipBufferToTgz(
  zipBuffer: Buffer,
  targetTgzPath: string,
  tempRoot: string,
  vpmAuthor?: unknown
): Promise<Buffer> {
  await mkdir(tempRoot, { recursive: true });
  await mkdir(dirname(targetTgzPath), { recursive: true });
  const tempDir = await mkdtemp(join(tempRoot, "vpm-"));
  const zipPath = join(tempDir, "package.zip");
  const extractDir = join(tempDir, "extract");
  try {
    await mkdir(extractDir, { recursive: true });
    await writeFile(zipPath, zipBuffer);
    await unzipToDirectory(zipPath, extractDir);
    const rootDir = await findPackageRoot(extractDir);
    if (vpmAuthor) {
      const packageJsonPath = join(rootDir, "package.json");
      try {
        const raw = await readFile(packageJsonPath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed.author) {
          const normalized =
            typeof vpmAuthor === "string"
              ? { name: vpmAuthor }
              : vpmAuthor && typeof vpmAuthor === "object" && "name" in vpmAuthor
                ? vpmAuthor
                : null;
          if (normalized) {
            parsed.author = normalized;
          }
          await writeFile(packageJsonPath, JSON.stringify(parsed, null, 2), "utf-8");
        }
      } catch {
        // ignore when package.json is missing or invalid
      }
    }
    const entries = await readdir(rootDir);
    await tar.c(
      {
        gzip: true,
        file: targetTgzPath,
        cwd: rootDir,
        prefix: "package/"
      },
      entries
    );
    return await readFile(targetTgzPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function fetchBufferWithRedirects(url: string, maxRedirects = 5): Promise<Buffer> {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await request(current, { method: "GET" });
    const status = res.statusCode;
    if (status >= 300 && status < 400 && res.headers.location && i < maxRedirects) {
      const next = new URL(res.headers.location, current).toString();
      current = next;
      continue;
    }
    if (status >= 400) {
      throw new Error(`zip_download_failed:${status}`);
    }
    return Buffer.from(await res.body.arrayBuffer());
  }
  throw new Error("zip_download_redirects_exceeded");
}

function buildNpmMetadataFromVpm(
  packageName: string,
  versions: Record<string, any> | undefined
): any {
  const out: any = {
    name: packageName,
    "dist-tags": {},
    versions: {}
  };

  if (!versions) return out;

  for (const [version, node] of Object.entries<any>(versions)) {
    const sourceUrl = typeof node?.url === "string" ? node.url : "";
    out.versions[version] = {
      name: String(node?.name ?? packageName),
      version: String(node?.version ?? version),
      description: typeof node?.description === "string" ? node.description : "",
      displayName: typeof node?.displayName === "string" ? node.displayName : undefined,
      author: normalizeAuthor(node?.author),
      dist: {
        tarball: "",
        original: sourceUrl
      }
    };
  }

  return out;
}

function normalizeAuthor(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    return { name: value };
  }
  if (value && typeof value === "object" && "name" in value) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function applyAuthorIfMissing(node: any, authorValue: unknown): void {
  if (!node || node.author) return;
  const normalized = normalizeAuthor(authorValue);
  if (normalized && typeof normalized.name === "string" && normalized.name.length > 0) {
    node.author = normalized;
  }
}

function mergeMissingVersions(target: any, source: any): void {
  if (!target?.versions || typeof target.versions !== "object") return;
  if (!source?.versions || typeof source.versions !== "object") return;
  for (const [version, node] of Object.entries<any>(source.versions)) {
    if (!target.versions[version]) {
      target.versions[version] = node;
    }
  }
}

const runningPrefetch = new Set<string>();

function shouldIncludePackage(name: string, scopes: string[] | undefined): boolean {
  if (!scopes || scopes.length === 0) return true;
  return scopes.some((scope) => matchScope(name, scope));
}

function pickLatestWithShasum(metadata: any): string {
  const versions = metadata?.versions;
  if (!versions || typeof versions !== "object") return "";
  const keys = Object.keys(versions).filter((version) => versions[version]?.dist?.shasum);
  if (keys.length === 0) return "";
  const valid = keys.filter((v) => semver.valid(v));
  if (valid.length > 0) return valid.sort(semver.rcompare)[0];
  return keys.sort().at(-1) ?? "";
}

async function prefetchForUpstream(
  upstream: UpstreamEntry,
  cacheRoot: string,
  intervalMs: number,
  log: { info: (obj: any, msg?: string) => void }
): Promise<void> {
  const index = await fetchVpmIndex(upstream);
  const vpmAuthor = index.author;
  const packages = index.packages ?? {};
  const metadataByPackage = new Map<string, any>();
  const delay = async () => {
    if (intervalMs > 0) await sleep(intervalMs);
  };

  for (const [name, pkg] of Object.entries(packages)) {
    if (!shouldIncludePackage(name, upstream.scopes)) continue;
    const versions = pkg?.versions;
    if (!versions) continue;
    const cached = await readMetadataCache(upstream.host, name);
    const metadata = cached?.metadata ?? buildNpmMetadataFromVpm(name, versions);
    if (vpmAuthor) {
      metadata._vpmAuthor = vpmAuthor;
    }
    metadataByPackage.set(name, metadata);

    const versionEntries = Object.entries<any>(metadata.versions ?? {}).sort(([a], [b]) => {
      const aValid = semver.valid(a);
      const bValid = semver.valid(b);
      if (aValid && bValid) return semver.rcompare(aValid, bValid);
      return b.localeCompare(a);
    });

    for (const [version, node] of versionEntries) {
      const sourceUrl = typeof node?.dist?.original === "string" ? node.dist.original : "";
      if (!sourceUrl) continue;
      const cacheKey = `${name}-${version}.tgz`;
      const tgzPath = getTarballCachePath(upstream.host, name, cacheKey);
      const exists = await stat(tgzPath).then(() => true).catch(() => false);
      const hasAuthor = !!node?.author;
      let needsDownload = !exists;
      if (!needsDownload && !hasAuthor && vpmAuthor) {
        const currentAuthor = await readAuthorFromTgz(tgzPath);
        if (!currentAuthor) {
          needsDownload = true;
        }
      }
      if (needsDownload) {
        try {
          await delay();
          const zipBuffer = await fetchBufferWithRedirects(sourceUrl);
          await convertZipBufferToTgz(zipBuffer, tgzPath, cacheRoot, vpmAuthor);
          log.info({ packageName: name, version }, "vpm_prefetch_done");
        } catch (err) {
          log.info({ err, packageName: name, version }, "vpm_prefetch_skip");
          continue;
        }
      }
      const tgzBuffer = await readFile(tgzPath);
      node.dist.shasum = computeSha1(tgzBuffer);
      applyAuthorIfMissing(node, vpmAuthor);
      await writeMetadataCache(upstream.host, name, {
        latestVersion: pickLatestWithShasum(metadata),
        author: typeof metadata?.author === "string" ? metadata.author : undefined,
        displayName: typeof metadata?.displayName === "string" ? metadata.displayName : undefined,
        metadata
      });
    }
  }

  for (const [name, metadata] of metadataByPackage.entries()) {
    await writeMetadataCache(upstream.host, name, {
      latestVersion: pickLatestWithShasum(metadata),
      author: typeof metadata?.author === "string" ? metadata.author : undefined,
      displayName: typeof metadata?.displayName === "string" ? metadata.displayName : undefined,
      metadata
    });
  }
}

async function prefetchForPackage(
  upstream: UpstreamEntry,
  packageName: string,
  versions: Record<string, any>,
  vpmAuthor: unknown,
  cacheRoot: string,
  intervalMs: number,
  log: { info: (obj: any, msg?: string) => void }
): Promise<void> {
  const cached = await readMetadataCache(upstream.host, packageName);
  const fresh = buildNpmMetadataFromVpm(packageName, versions);
  const metadata = cached?.metadata ? cached.metadata : fresh;
  if (cached?.metadata) {
    mergeMissingVersions(metadata, fresh);
  }
  if (vpmAuthor) {
    metadata._vpmAuthor = vpmAuthor;
  }

  const versionEntries = Object.entries<any>(metadata.versions ?? {}).sort(([a], [b]) => {
    const aValid = semver.valid(a);
    const bValid = semver.valid(b);
    if (aValid && bValid) return semver.rcompare(aValid, bValid);
    return b.localeCompare(a);
  });

  for (const [version, node] of versionEntries) {
    const sourceUrl = typeof node?.dist?.original === "string" ? node.dist.original : "";
    if (!sourceUrl) continue;
    const cacheKey = `${packageName}-${version}.tgz`;
    const tgzPath = getTarballCachePath(upstream.host, packageName, cacheKey);
    const exists = await stat(tgzPath).then(() => true).catch(() => false);
    const hasAuthor = !!node?.author;
    let needsDownload = !exists;
    if (!needsDownload && !hasAuthor && vpmAuthor) {
      const currentAuthor = await readAuthorFromTgz(tgzPath);
      if (!currentAuthor) {
        needsDownload = true;
      }
    }
    if (needsDownload) {
      if (intervalMs > 0) await sleep(intervalMs);
      try {
        const zipBuffer = await fetchBufferWithRedirects(sourceUrl);
        await convertZipBufferToTgz(zipBuffer, tgzPath, cacheRoot, vpmAuthor);
        log.info({ packageName, version }, "vpm_prefetch_done");
      } catch (err) {
        log.info({ err, packageName, version }, "vpm_prefetch_skip");
        continue;
      }
    }
    const tgzBuffer = await readFile(tgzPath);
    node.dist.shasum = computeSha1(tgzBuffer);
    applyAuthorIfMissing(node, vpmAuthor);
    await writeMetadataCache(upstream.host, packageName, {
      latestVersion: pickLatestWithShasum(metadata),
      author: typeof metadata?.author === "string" ? metadata.author : undefined,
      displayName: typeof metadata?.displayName === "string" ? metadata.displayName : undefined,
      metadata
    });
  }
}

async function prefetchVpmShasums(
  log: { info: (obj: any, msg?: string) => void }
): Promise<void> {
  const config = getUpstreamConfig();
  const upstreams = [config.default, ...config.upstreams].filter((u) => u.type === "vpm");
  if (upstreams.length === 0) return;

  const cacheRoot = mustEnv("TARBALL_CACHE_DIR");
  const intervalSec = parseFloatEnv("VPM_PREFETCH_INTERVAL_SEC");
  const intervalMs = Math.max(0, intervalSec * 1000);

  for (const upstream of upstreams) {
    log.info({ host: upstream.host }, "vpm_prefetch_start");
    await prefetchForUpstream(upstream, cacheRoot, intervalMs, log);
    log.info({ host: upstream.host }, "vpm_prefetch_complete");
  }
}

export function startVpmPrefetch(
  log: { info: (obj: any, msg?: string) => void }
): void {
  void (async () => {
    try {
      await prefetchVpmShasums(log);
    } catch (err) {
      log.info({ err }, "vpm_prefetch_failed");
    }
  })();
}

export function startVpmPrefetchForPackage(
  log: { info: (obj: any, msg?: string) => void },
  upstream: UpstreamEntry,
  packageName: string,
  versions: Record<string, any>,
  vpmAuthor: unknown
): void {
  const key = `${upstream.host}|${packageName}`;
  if (runningPrefetch.has(key)) return;
  runningPrefetch.add(key);
  void (async () => {
    try {
      const cacheRoot = mustEnv("TARBALL_CACHE_DIR");
      const intervalSec = parseFloatEnv("VPM_PREFETCH_INTERVAL_SEC");
      const intervalMs = Math.max(0, intervalSec * 1000);
      await prefetchForPackage(upstream, packageName, versions, vpmAuthor, cacheRoot, intervalMs, log);
    } catch (err) {
      log.info({ err, packageName }, "vpm_prefetch_failed");
    } finally {
      runningPrefetch.delete(key);
    }
  })();
}
