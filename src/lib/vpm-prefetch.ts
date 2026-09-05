import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as tar from "tar";
import { request } from "undici";
import * as semver from "semver";
import { getTarballCachePath, readMetadataCache, updateMetadataCache, type MetadataCache } from "./cache";
import { applyPackageSignature } from "./npm-signatures";
import { getUpstreamConfig, matchScope, UpstreamEntry } from "./upstreams";
import { mustEnv } from "./env";
import { computeSha1, convertZipBufferToTgz, runTempLocked } from "./tgz";

type VpmIndex = {
  author?: unknown;
  packages?: Record<string, { versions?: Record<string, any> }>;
};

function getPublicBaseUrl(): string {
  return mustEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
}

function buildTarballUrl(packageName: string, version: string): string {
  const base = getPublicBaseUrl();
  const encodedVersion = encodeURIComponent(`${packageName}-${version}.tgz`);
  return `${base}/-/${encodedVersion}`;
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
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
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
    const deps =
      node?.dependencies && typeof node.dependencies === "object" ? node.dependencies : undefined;
    const vpmDeps =
      node?.vpmDependencies && typeof node.vpmDependencies === "object"
        ? node.vpmDependencies
        : undefined;
    const mergedDeps = { ...(deps ?? {}), ...(vpmDeps ?? {}) };
    const normalizedDeps: Record<string, string> = {};
    for (const [depName, depRange] of Object.entries(mergedDeps)) {
      if (typeof depRange !== "string") continue;
      const exact = semver.valid(depRange);
      if (exact) {
        normalizedDeps[depName] = exact;
        continue;
      }
      const normalizedRange = depRange.replace(
        /<(\d+\.\d+\.\d+)-[A-Za-z][^ ]*/g,
        "<$1-0"
      );
      const min = semver.minVersion(normalizedRange);
      if (min) {
        normalizedDeps[depName] = min.version;
      }
    }
    out.versions[version] = {
      name: String(node?.name ?? packageName),
      version: String(node?.version ?? version),
      description: typeof node?.description === "string" ? node.description : "",
      displayName: typeof node?.displayName === "string" ? node.displayName : undefined,
      author: normalizeAuthor(node?.author),
      dependencies: Object.keys(normalizedDeps).length > 0 ? normalizedDeps : undefined,
      dist: {
        tarball: buildTarballUrl(packageName, version),
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
    const targetNode = target.versions[version];
    if (!targetNode) {
      target.versions[version] = node;
      continue;
    }
    if (!targetNode.dependencies && node?.dependencies) {
      targetNode.dependencies = node.dependencies;
    }
    if (!targetNode.dist?.tarball && node?.dist?.tarball) {
      targetNode.dist = targetNode.dist ?? {};
      targetNode.dist.tarball = node.dist.tarball;
    }
    if (!targetNode.dist?.original && node?.dist?.original) {
      targetNode.dist = targetNode.dist ?? {};
      targetNode.dist.original = node.dist.original;
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

// Builds the MetadataCache record to persist from a full in-memory metadata object.
function buildMetadataCacheEntry(target: any): MetadataCache {
  return {
    latestVersion: pickLatestWithShasum(target),
    author: typeof target?.author === "string" ? target.author : undefined,
    displayName: typeof target?.displayName === "string" ? target.displayName : undefined,
    metadata: target
  };
}

// Grafts the given version nodes onto `target.versions`, leaving every other key of
// `target` (including versions this call does not know about) untouched. Used inside
// updateMetadataCache's mutate callback so a freshly re-read cache entry only receives
// the specific version updates this caller computed, instead of being replaced wholesale
// by a possibly-stale in-memory snapshot.
function mergeVersionsInto(target: any, versionNodes: Record<string, any>): void {
  target.versions = target.versions && typeof target.versions === "object" ? target.versions : {};
  for (const [version, node] of Object.entries(versionNodes)) {
    target.versions[version] = node;
  }
}

async function prefetchForUpstream(
  upstream: UpstreamEntry,
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
      node.dist = node.dist ?? {};
      node.dist.tarball = node.dist.tarball || buildTarballUrl(name, version);
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
          await convertZipBufferToTgz(zipBuffer, tgzPath, runTempLocked, vpmAuthor);
          log.info({ packageName: name, version }, "vpm_prefetch_done");
        } catch (err) {
          log.info({ err, packageName: name, version }, "vpm_prefetch_skip");
          continue;
        }
      }
      const tgzBuffer = await readFile(tgzPath);
      node.dist.shasum = computeSha1(tgzBuffer);
      applyPackageSignature(name, version, tgzBuffer, node.dist);
      applyAuthorIfMissing(node, vpmAuthor);
      // Re-read the cache under the lock instead of blindly writing our locally-built
      // `metadata` snapshot: another writer (a request handler serving this package's
      // tarball, or another prefetch pass) may have updated a DIFFERENT version's dist
      // fields on disk since we last read. Merge in only the version we just processed.
      await updateMetadataCache(upstream.host, name, (current) => {
        const target = current?.metadata ?? metadata;
        if (target !== metadata) {
          mergeVersionsInto(target, { [version]: node });
        }
        return buildMetadataCacheEntry(target);
      });
    }
  }

  for (const [name, metadata] of metadataByPackage.entries()) {
    await updateMetadataCache(upstream.host, name, (current) => {
      const target = current?.metadata ?? metadata;
      if (target !== metadata) {
        mergeVersionsInto(target, metadata.versions ?? {});
      }
      return buildMetadataCacheEntry(target);
    });
  }
}

async function prefetchForPackage(
  upstream: UpstreamEntry,
  packageName: string,
  versions: Record<string, any>,
  vpmAuthor: unknown,
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
    node.dist = node.dist ?? {};
    node.dist.tarball = node.dist.tarball || buildTarballUrl(packageName, version);
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
        await convertZipBufferToTgz(zipBuffer, tgzPath, runTempLocked, vpmAuthor);
        log.info({ packageName, version }, "vpm_prefetch_done");
      } catch (err) {
        log.info({ err, packageName, version }, "vpm_prefetch_skip");
        continue;
      }
    }
    const tgzBuffer = await readFile(tgzPath);
    node.dist.shasum = computeSha1(tgzBuffer);
    applyPackageSignature(packageName, version, tgzBuffer, node.dist);
    applyAuthorIfMissing(node, vpmAuthor);
    // Same re-read-and-merge as prefetchForUpstream above: only graft this version's
    // node onto whatever is currently on disk, so a concurrent writer's update to a
    // different version of this same package is not lost.
    await updateMetadataCache(upstream.host, packageName, (current) => {
      const target = current?.metadata ?? metadata;
      if (target !== metadata) {
        mergeVersionsInto(target, { [version]: node });
      }
      return buildMetadataCacheEntry(target);
    });
  }
}

async function prefetchVpmShasums(
  log: { info: (obj: any, msg?: string) => void }
): Promise<void> {
  const config = getUpstreamConfig();
  const upstreams = [config.default, ...config.upstreams].filter((u) => u.type === "vpm");
  if (upstreams.length === 0) return;

  const intervalSec = parseFloatEnv("VPM_PREFETCH_INTERVAL_SEC");
  const intervalMs = Math.max(0, intervalSec * 1000);

  for (const upstream of upstreams) {
    log.info({ host: upstream.host }, "vpm_prefetch_start");
    await prefetchForUpstream(upstream, intervalMs, log);
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
      const intervalSec = parseFloatEnv("VPM_PREFETCH_INTERVAL_SEC");
      const intervalMs = Math.max(0, intervalSec * 1000);
      await prefetchForPackage(upstream, packageName, versions, vpmAuthor, intervalMs, log);
    } catch (err) {
      log.info({ err, packageName }, "vpm_prefetch_failed");
    } finally {
      runningPrefetch.delete(key);
    }
  })();
}
