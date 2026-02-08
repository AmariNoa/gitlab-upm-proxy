import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import * as semver from "semver";
import * as tar from "tar";
import * as unzipper from "unzipper";
import { request } from "undici";
import {
  deleteMetadataCache,
  getPackageCacheDir,
  getTarballCachePath,
  hasTarballCache,
  readMetadataCache,
  readTarballCache,
  writeMetadataCache,
  writeTarballCache
} from "../lib/cache";
import {
  extractPackageName,
  getUpstreamConfig,
  selectUpstream,
  selectUpstreamForScopeText,
  UpstreamEntry
} from "../lib/upstreams";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const PUBLIC_BASE_URL = mustEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
const TARBALL_CACHE_DIR = mustEnv("TARBALL_CACHE_DIR");

const upstreamConfig = getUpstreamConfig();
const defaultUpstream = upstreamConfig.default;

/**
 * Unity → 中継で受けたヘッダから upstream に転送するヘッダを構築
 * - string のみ転送（string[] / undefined は捨てる）
 * - hop-by-hop を除外
 * - 認証ヘッダは「1種類だけ」残して確実に透過（Authorization / PRIVATE-TOKEN）
 */
function buildUpstreamHeaders(reqHeaders: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(reqHeaders)) {
    if (typeof v === "string") out[k] = v;
  }

  delete out["host"];
  delete out["connection"];
  delete out["content-length"];
  delete out["transfer-encoding"];
  delete out["accept-encoding"];

  const auth =
    (typeof reqHeaders["authorization"] === "string" ? (reqHeaders["authorization"] as string) : "") ||
    (typeof reqHeaders["Authorization"] === "string" ? (reqHeaders["Authorization"] as string) : "");

  const token =
    (typeof reqHeaders["private-token"] === "string" ? (reqHeaders["private-token"] as string) : "") ||
    (typeof reqHeaders["PRIVATE-TOKEN"] === "string" ? (reqHeaders["PRIVATE-TOKEN"] as string) : "") ||
    (typeof reqHeaders["Private-Token"] === "string" ? (reqHeaders["Private-Token"] as string) : "");

  delete out["authorization"];
  delete out["Authorization"];
  delete out["private-token"];
  delete out["Private-Token"];
  delete out["PRIVATE-TOKEN"];

  if (auth) out["Authorization"] = auth;
  if (token) out["PRIVATE-TOKEN"] = token;

  return out;
}

function applyUpstreamHeaders(
  reply: any,
  headers: Record<string, unknown>,
  skipContentLength: boolean
): void {
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") continue;
    const key = k.toLowerCase();
    if (key === "transfer-encoding") continue;
    if (skipContentLength && key === "content-length") continue;
    reply.header(k, v);
  }
}

function applyTarballHeaders(reply: any, size: number): void {
  reply.header("content-type", "application/octet-stream");
  reply.header("content-length", String(size));
  reply.header("accept-ranges", "bytes");
}

function compareVersions(a: string, b: string): number {
  const aValid = semver.valid(a);
  const bValid = semver.valid(b);
  if (aValid && bValid) return semver.compare(aValid, bValid);
  return a.localeCompare(b);
}

function pickLatestByName(items: any[]): any[] {
  const byName = new Map<string, any>();
  for (const item of items) {
    const name = String(item?.name ?? "");
    const current = byName.get(name);
    if (!current) {
      byName.set(name, item);
      continue;
    }
    const currentVersion = String(current?.version ?? "");
    const itemVersion = String(item?.version ?? "");
    if (compareVersions(currentVersion, itemVersion) < 0) {
      byName.set(name, item);
    }
  }

  return Array.from(byName.values()).sort((a, b) =>
    String(a?.name ?? "").localeCompare(String(b?.name ?? ""))
  );
}

function sendEmptySearch(reply: any): void {
  const now = new Date().toISOString();
  reply.type("application/json").send({
    objects: [],
    total: 0,
    time: now
  });
}

type VpmIndex = {
  packages?: Record<string, { versions?: Record<string, any> }>;
};

function getVpmIndexUrl(upstream: UpstreamEntry): string {
  return upstream.baseUrl.endsWith(".json")
    ? upstream.baseUrl
    : `${upstream.baseUrl.replace(/\/+$/, "")}/index.json`;
}

async function fetchVpmIndex(
  upstream: UpstreamEntry,
  headers: Record<string, string>
): Promise<VpmIndex> {
  const res = await request(getVpmIndexUrl(upstream), { method: "GET", headers });
  if (res.statusCode >= 400) {
    throw new Error(`vpm_index_failed:${res.statusCode}`);
  }
  return (await res.body.json()) as VpmIndex;
}

function pickLatestVpmVersion(versions: Record<string, any> | undefined): string | null {
  if (!versions) return null;
  const keys = Object.keys(versions);
  if (keys.length === 0) return null;
  const valid = keys.filter((v) => semver.valid(v));
  if (valid.length > 0) return valid.sort(semver.rcompare)[0];
  return keys.sort().at(-1) ?? null;
}

function buildVpmSearchResult(
  packageName: string,
  versions: Record<string, any> | undefined
): { name: string; version: string; description: string; date: string } | null {
  const latest = pickLatestVpmVersion(versions);
  if (!latest) return null;
  const latestNode = versions?.[latest];
  return {
    name: packageName,
    version: String(latestNode?.version ?? latest),
    description: String(latestNode?.description ?? ""),
    date: new Date().toISOString()
  };
}

function buildNpmMetadataFromVpm(
  packageName: string,
  versions: Record<string, any> | undefined
): any {
  const latest = pickLatestVpmVersion(versions);
  const out: any = {
    name: packageName,
    "dist-tags": {},
    versions: {}
  };
  if (latest) out["dist-tags"].latest = latest;

  if (!versions) return out;

  for (const [version, node] of Object.entries<any>(versions)) {
    const sourceUrl = typeof node?.url === "string" ? node.url : "";
    out.versions[version] = {
      name: String(node?.name ?? packageName),
      version: String(node?.version ?? version),
      description: typeof node?.description === "string" ? node.description : "",
      displayName: typeof node?.displayName === "string" ? node.displayName : undefined,
      author: node?.author ?? undefined,
      dist: {
        tarball: "",
        original: sourceUrl
      }
    };
  }

  if (latest && out.versions[latest]) {
    out.author = out.versions[latest].author;
    out.displayName = out.versions[latest].displayName;
  }

  return out;
}

function mergeShasumFromCache(target: any, cached: any): void {
  if (!target?.versions || typeof target.versions !== "object") return;
  if (!cached?.versions || typeof cached.versions !== "object") return;
  for (const [version, node] of Object.entries<any>(target.versions)) {
    if (!node?.dist || node.dist.shasum) continue;
    const cachedNode = cached.versions[version];
    const cachedShasum = cachedNode?.dist?.shasum;
    if (cachedShasum) {
      node.dist.shasum = cachedShasum;
    }
  }
}

function filterMetadataByShasum(metadata: any): any {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (!metadata.versions || typeof metadata.versions !== "object") return metadata;
  const filtered: Record<string, any> = {};
  for (const [version, node] of Object.entries<any>(metadata.versions)) {
    if (node?.dist?.shasum) {
      filtered[version] = node;
    }
  }
  metadata.versions = filtered;
  const versions = Object.keys(filtered);
  if (versions.length === 0) {
    delete metadata["dist-tags"];
  } else {
    const latest = versions.sort(semver.rcompare)[0];
    metadata["dist-tags"] = { latest };
  }
  return metadata;
}

function buildVpmTarballProxyUrl(
  groupEnc: string,
  packageName: string,
  version: string
): string {
  const encodedName = encodeURIComponent(packageName);
  const encodedVersion = encodeURIComponent(`${packageName}-${version}.tgz`);
  return `${PUBLIC_BASE_URL}/api/v4/groups/${groupEnc}/npm/${encodedName}/-/${encodedVersion}`;
}

async function unzipToDirectory(zipPath: string, targetDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(zipPath).pipe(unzipper.Extract({ path: targetDir }));
    stream.on("close", () => resolve());
    stream.on("error", (err) => reject(err));
  });
}

async function convertZipBufferToTgz(
  zipBuffer: Buffer,
  targetTgzPath: string,
  tempRoot: string
): Promise<void> {
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
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function stripVpmOriginal(metadata: any): any {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (!metadata.versions || typeof metadata.versions !== "object") return metadata;
  for (const v of Object.values<any>(metadata.versions)) {
    if (v?.dist && typeof v.dist === "object" && "original" in v.dist) {
      delete v.dist.original;
    }
  }
  return metadata;
}

function computeSha1(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex");
}

async function serveVpmTarball(
  req: any,
  reply: any,
  path: string,
  decodedName: string,
  decodedVersion: string,
  cacheKey: string,
  headers: Record<string, string>
): Promise<boolean> {
  const vpmUpstream = selectUpstream(decodedName);
  if (vpmUpstream.type !== "vpm") {
    return false;
  }

  req.log.info({ path, method: req.method }, "vpm_tarball_request");

  const cachedBuffer = await readTarballCache(vpmUpstream.host, decodedName, cacheKey);
  if (cachedBuffer) {
    reply.code(200);
    applyTarballHeaders(reply, cachedBuffer.length);
    if (req.method.toUpperCase() === "HEAD") {
      reply.send();
    } else {
      reply.send(cachedBuffer);
    }
    return true;
  }

  const cachedMetadata = await readMetadataCache(vpmUpstream.host, decodedName);
  const versionNode =
    cachedMetadata?.metadata?.versions && typeof cachedMetadata.metadata.versions === "object"
      ? cachedMetadata.metadata.versions[decodedVersion]
      : undefined;
  const tarballUrl = typeof versionNode?.dist?.original === "string" ? versionNode.dist.original : "";
  if (!tarballUrl) {
    reply.code(404).send();
    return true;
  }

  try {
    const buffer = await fetchBufferWithRedirects(tarballUrl, headers);
    const tgzPath = getTarballCachePath(vpmUpstream.host, decodedName, cacheKey);
    await convertZipBufferToTgz(buffer, tgzPath, TARBALL_CACHE_DIR);
    const tgzBuffer = await readFile(tgzPath);
    const shasum = computeSha1(tgzBuffer);

    if (cachedMetadata?.metadata?.versions && typeof cachedMetadata.metadata.versions === "object") {
      const cachedVersionNode = cachedMetadata.metadata.versions[decodedVersion];
      if (cachedVersionNode?.dist) {
        cachedVersionNode.dist.shasum = shasum;
        await writeMetadataCache(vpmUpstream.host, decodedName, {
          latestVersion: cachedMetadata.latestVersion,
          author: cachedMetadata.author,
          displayName: cachedMetadata.displayName,
          metadata: cachedMetadata.metadata
        });
      }
    }

    reply.code(200);
    applyTarballHeaders(reply, tgzBuffer.length);
    if (req.method.toUpperCase() === "HEAD") {
      reply.send();
    } else {
      reply.send(tgzBuffer);
    }
    return true;
  } catch {
    reply.code(404).send();
    return true;
  }
}

async function fetchBufferWithRedirects(
  url: string,
  headers: Record<string, string>,
  maxRedirects = 5
): Promise<Buffer> {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await request(current, { method: "GET", headers });
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

function normalizeSearchResponse(payload: any): { objects: any[]; total: number; time: string } {
  const now = new Date().toISOString();
  if (!payload || typeof payload !== "object") {
    return { objects: [], total: 0, time: now };
  }

  if (Array.isArray(payload.objects)) {
    const objects = payload.objects.map((obj: any) => {
      const pkg = obj?.package ?? obj;
      return {
        package: {
          name: String(pkg?.name ?? ""),
          version: String(pkg?.version ?? ""),
          description: String(pkg?.description ?? ""),
          date: pkg?.date ?? now
        },
        score: obj?.score ?? { final: 1, detail: {} },
        searchScore: obj?.searchScore ?? 1
      };
    });
    return {
      objects,
      total: typeof payload.total === "number" ? payload.total : objects.length,
      time: typeof payload.time === "string" ? payload.time : now
    };
  }

  return { objects: [], total: 0, time: now };
}

function getLatestVersionFromMetadata(metadata: any): string | null {
  const distTags = metadata?.["dist-tags"];
  if (distTags && typeof distTags.latest === "string") return distTags.latest;
  const versions = metadata?.versions;
  if (!versions || typeof versions !== "object") return null;
  const keys = Object.keys(versions);
  if (keys.length === 0) return null;
  const valid = keys.filter((v) => semver.valid(v));
  if (valid.length > 0) return valid.sort(semver.rcompare)[0];
  return keys.sort().at(-1) ?? null;
}

function extractAuthor(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}

function getUpstreamBaseForGroup(
  upstream: UpstreamEntry,
  groupEnc: string,
  restPath: string
): string {
  const normalizedRest = restPath.replace(/^\/+/, "");
  if (upstream.baseUrl === defaultUpstream.baseUrl) {
    const groupPath = decodeURIComponent(groupEnc);
    const groupEncOnce = encodeURIComponent(groupPath);
    return `${upstream.baseUrl}/api/v4/groups/${groupEncOnce}/-/packages/npm/${normalizedRest}`;
  }
  return `${upstream.baseUrl}/${normalizedRest}`;
}

function rewriteTarballUrl(
  tarballUrl: string,
  upstream: UpstreamEntry,
  groupEnc: string
): string {
  if (upstream.baseUrl === defaultUpstream.baseUrl) {
    if (tarballUrl.startsWith(upstream.baseUrl)) {
      return tarballUrl.replace(upstream.baseUrl, PUBLIC_BASE_URL);
    }
    return tarballUrl;
  }

  try {
    const parsed = new URL(tarballUrl);
    const tarPath = `${parsed.pathname}${parsed.search}`.replace(/^\/+/, "");
    return `${PUBLIC_BASE_URL}/api/v4/groups/${groupEnc}/${tarPath}`;
  } catch {
    return tarballUrl;
  }
}

function rewriteTarballUrlsInMetadata(
  metadata: any,
  upstream: UpstreamEntry,
  groupEnc: string
): void {
  if (!metadata || typeof metadata !== "object") return;
  if (!metadata.versions || typeof metadata.versions !== "object") return;
  for (const v of Object.values<any>(metadata.versions)) {
    const tar = v?.dist?.tarball;
    if (typeof tar === "string") {
      v.dist.tarball = rewriteTarballUrl(tar, upstream, groupEnc);
    }
  }
}

async function deletePackageCache(upstream: UpstreamEntry, packageName: string): Promise<void> {
  await deleteMetadataCache(upstream.host, packageName);
  await rm(getPackageCacheDir(upstream.host, packageName), { recursive: true, force: true });
}

function extractTarballFilenameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    return decodeURIComponent(parts[parts.length - 1]);
  } catch {
    return null;
  }
}

function extractTarballFilenameFromPath(restPath: string): string | null {
  const parts = restPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return decodeURIComponent(parts[parts.length - 1]);
}

async function downloadTarballToCache(
  tarballUrl: string,
  upstream: UpstreamEntry,
  packageName: string,
  headers: Record<string, string>
): Promise<string> {
  const filename = extractTarballFilenameFromUrl(tarballUrl);
  if (!filename) {
    throw new Error("Tarball filename not found");
  }
  const res = await request(tarballUrl, { method: "GET", headers });
  if (res.statusCode >= 400) {
    throw new Error(`Tarball download failed: ${res.statusCode}`);
  }
  const buffer = Buffer.from(await res.body.arrayBuffer());
  return await writeTarballCache(upstream.host, packageName, filename, buffer);
}

async function readPackageInfoFromTarballPath(
  tarballPath: string
): Promise<{ author?: string; displayName?: string }> {
  await mkdir(TARBALL_CACHE_DIR, { recursive: true });
  const tempDir = await mkdtemp(join(TARBALL_CACHE_DIR, "extract-"));
  try {
    await tar.x({
      file: tarballPath,
      cwd: tempDir,
      filter: (p) => p === "package/package.json"
    });

    const packageJsonPath = join(tempDir, "package", "package.json");
    const raw = await readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    return {
      author: extractAuthor(parsed.author),
      displayName: typeof parsed.displayName === "string" ? parsed.displayName : undefined
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function mergeMetadataIfNeeded(
  metadata: any,
  packageName: string,
  upstream: UpstreamEntry,
  headers: Record<string, string>
): Promise<void> {
  const latestVersion = getLatestVersionFromMetadata(metadata);
  if (!latestVersion) return;

  const versionNode =
    metadata?.versions && typeof metadata.versions === "object"
      ? metadata.versions[latestVersion]
      : undefined;

  const upstreamAuthor = extractAuthor(metadata?.author ?? versionNode?.author);
  const upstreamDisplayName =
    typeof metadata?.displayName === "string"
      ? metadata.displayName
      : typeof versionNode?.displayName === "string"
        ? versionNode.displayName
        : undefined;

  let author = upstreamAuthor ?? undefined;
  let displayName = upstreamDisplayName ?? undefined;

  if (!author || !displayName) {
    const tarballUrl = versionNode?.dist?.tarball;
    if (typeof tarballUrl === "string") {
      const filename = extractTarballFilenameFromUrl(tarballUrl);
      if (filename) {
        let tarballPath = getTarballCachePath(upstream.host, packageName, filename);
        const cachedTarball = await hasTarballCache(upstream.host, packageName, filename);
        if (!cachedTarball) {
          tarballPath = await downloadTarballToCache(tarballUrl, upstream, packageName, headers);
        }
        const info = await readPackageInfoFromTarballPath(tarballPath);
        author = author ?? info.author;
        displayName = displayName ?? info.displayName;
      }
    }
  }

  if (author) {
    metadata.author = author;
    if (versionNode) versionNode.author = author;
  }
  if (displayName) {
    metadata.displayName = displayName;
    if (versionNode) versionNode.displayName = displayName;
  }
}

/**
 * npm search の実装本体（groupEnc を受け取って GitLab Packages API から列挙）
 */
async function handleSearch(req: any, reply: any, groupEnc: string): Promise<void> {
  const groupPath = decodeURIComponent(groupEnc);
  const groupEncOnce = encodeURIComponent(groupPath);

  const text = (req.query.text ?? "").toString();
  const searchUpstream = text ? selectUpstreamForScopeText(text) : defaultUpstream;
  const from = Number.parseInt((req.query.from ?? "0").toString(), 10) || 0;
  const sizeRaw = Number.parseInt((req.query.size ?? "20").toString(), 10) || 20;
  const size = Math.min(Math.max(sizeRaw, 1), 250);

  if (searchUpstream.type === "vpm") {
    const headers = buildUpstreamHeaders(req.headers as any);
    try {
      const index = await fetchVpmIndex(searchUpstream, headers);
      const packages = index.packages ?? {};
      const matches = Object.entries(packages)
        .filter(([name]) => (text ? name.includes(text) : true))
        .map(([name, pkg]) => buildVpmSearchResult(name, pkg?.versions))
        .filter((v): v is { name: string; version: string; description: string; date: string } => !!v);

      for (const [name, pkg] of Object.entries(packages)) {
        if (text && !name.includes(text)) continue;
        const versions = pkg?.versions;
        if (!versions) continue;
        const latestVersion = pickLatestVpmVersion(versions);
        if (!latestVersion) continue;
        const metadata = buildNpmMetadataFromVpm(name, versions);
        const cached = await readMetadataCache(searchUpstream.host, name);
        if (cached?.metadata) {
          mergeShasumFromCache(metadata, cached.metadata);
        }
        if (metadata?.versions && typeof metadata.versions === "object") {
          for (const [version, node] of Object.entries<any>(metadata.versions)) {
            node.dist = node.dist ?? {};
            node.dist.tarball = buildVpmTarballProxyUrl(groupEnc, name, version);
          }
        }
        await writeMetadataCache(searchUpstream.host, name, {
          latestVersion,
          author: extractAuthor(metadata?.author),
          displayName: typeof metadata?.displayName === "string" ? metadata.displayName : undefined,
          metadata
        });
      }

      const sliced = matches.slice(from, from + size);
      const now = new Date().toISOString();
      reply.type("application/json").send({
        objects: sliced.map((p) => ({
          package: {
            name: p.name,
            version: p.version,
            description: p.description,
            date: p.date
          },
          score: { final: 1, detail: {} },
          searchScore: 1
        })),
        total: matches.length,
        time: now
      });
      return;
    } catch {
      reply.code(200);
      sendEmptySearch(reply);
      return;
    }
  }

  if (searchUpstream.baseUrl !== defaultUpstream.baseUrl) {
    const u = new URL(`${searchUpstream.baseUrl}/-/v1/search`);
    u.searchParams.set("text", text);
    u.searchParams.set("from", String(from));
    u.searchParams.set("size", String(size));

    const headers = buildUpstreamHeaders(req.headers as any);
    let res;
    try {
      res = await request(u.toString(), { method: "GET", headers });
    } catch {
      reply.code(200);
      sendEmptySearch(reply);
      return;
    }
    const contentType = String(res.headers["content-type"] ?? "");

    if (res.statusCode >= 400 || !contentType.includes("application/json")) {
      reply.code(200);
      sendEmptySearch(reply);
      return;
    }

    try {
      const payload = await res.body.json();
      const normalized = normalizeSearchResponse(payload);
      reply.code(200);
      reply.type("application/json").send(normalized);
    } catch {
      reply.code(200);
      sendEmptySearch(reply);
    }
    return;
  }

  const base = `${defaultUpstream.baseUrl}/api/v4/groups/${groupEncOnce}/packages`;
  const headers = buildUpstreamHeaders(req.headers as any);

  const perPage = 100;
  const maxPages = 50;
  const all: any[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const u = new URL(base);
    u.searchParams.set("package_type", "npm");
    u.searchParams.set("exclude_subgroups", "false");
    u.searchParams.set("per_page", String(perPage));
    u.searchParams.set("page", String(page));
    u.searchParams.set("order_by", "name");
    u.searchParams.set("sort", "asc");

    const res = await request(u.toString(), { method: "GET", headers });

    if (res.statusCode >= 400) {
      const body = await res.body.text();
      reply.code(res.statusCode).type("application/json").send({
        error: "gitlab_packages_api_failed",
        status: res.statusCode,
        body
      });
      return;
    }

    const items = (await res.body.json()) as any[];
    all.push(...items);
    if (items.length < perPage) break;
  }

  const filtered = all
    .filter((p) => p?.package_type === "npm")
    .filter((p) => {
      if (!text) return true;
      const name = String(p?.name ?? "");
      return name.includes(text);
    });

  const latestOnly = pickLatestByName(filtered);
  const sliced = latestOnly.slice(from, from + size);
  const now = new Date().toISOString();

  reply.type("application/json").send({
    objects: sliced.map((p) => ({
      package: {
        name: String(p?.name ?? ""),
        version: String(p?.version ?? ""),
        description: String(p?.description ?? ""),
        date: p?.created_at ?? now
      },
      score: { final: 1, detail: {} },
      searchScore: 1
    })),
    total: latestOnly.length,
    time: now
  });
}

/**
 * npm registry 透過（groupEnc を受け取って upstream npm registry に中継）
 */
async function proxyGroupNpm(
  req: any,
  reply: any,
  groupEnc: string,
  restPath: string
): Promise<void> {
  const normalizedRest = restPath.replace(/^\/+/, "");
  const headers = buildUpstreamHeaders(req.headers as any);

  if (normalizedRest.startsWith("npm/")) {
    const parts = normalizedRest.split("/").filter(Boolean);
    if (parts.length >= 4 && parts[2] === "-") {
      const decodedName = decodeURIComponent(parts[1] ?? "");
      const decodedFile = decodeURIComponent(parts[3] ?? "");
      const prefix = `${decodedName}-`;
      if (decodedName && decodedFile.startsWith(prefix) && decodedFile.endsWith(".tgz")) {
        const decodedVersion = decodedFile.slice(prefix.length, -4);
        const handled = await serveVpmTarball(
          req,
          reply,
          normalizedRest,
          decodedName,
          decodedVersion,
          decodedFile,
          headers
        );
        if (handled) {
          return;
        }
      }
    }
  }

  if (normalizedRest.startsWith("vpm/")) {
    const parts = normalizedRest.split("/").filter(Boolean);
    const encodedName = parts[1] ?? "";
    const encodedVersion = parts[2] ?? "";
    const decodedName = decodeURIComponent(encodedName);
    const decodedFile = decodeURIComponent(encodedVersion);
    let decodedVersion = "";
    let cacheKey = "";
    if (decodedFile.endsWith(".tgz")) {
      const base = decodedFile.slice(0, -4);
      const prefix = `${decodedName}-`;
      decodedVersion = base.startsWith(prefix) ? base.slice(prefix.length) : base;
      cacheKey = decodedFile;
    } else {
      decodedVersion = decodedFile;
      cacheKey = decodedFile ? `${decodedFile}.tgz` : "";
    }

    if (!decodedName) {
      reply.code(404).send();
      return;
    }

    if (!decodedVersion || !cacheKey) {
      reply.code(404).send();
      return;
    }

    const handled = await serveVpmTarball(
      req,
      reply,
      normalizedRest,
      decodedName,
      decodedVersion,
      cacheKey,
      headers
    );
    if (!handled) {
      reply.code(404).send();
    }
    return;
  }

  const packageName = extractPackageName(normalizedRest);
  const upstream = packageName ? selectUpstream(packageName) : defaultUpstream;
  const upstreamUrl = getUpstreamBaseForGroup(upstream, groupEnc, normalizedRest);

  if (upstream.type === "vpm") {
    if (!packageName) {
      reply.code(404).send();
      return;
    }

    try {
      const index = await fetchVpmIndex(upstream, headers);
      const versions = index.packages?.[packageName]?.versions;
      if (!versions) {
        await deletePackageCache(upstream, packageName);
        reply.code(404).send();
        return;
      }

      const latestVersion = pickLatestVpmVersion(versions);
      const cached = await readMetadataCache(upstream.host, packageName);
      if (cached && latestVersion && cached.latestVersion === latestVersion) {
        const response = JSON.parse(JSON.stringify(cached.metadata));
        if (response?.versions && typeof response.versions === "object") {
          for (const [version, node] of Object.entries<any>(response.versions)) {
            node.dist = node.dist ?? {};
            node.dist.tarball = buildVpmTarballProxyUrl(groupEnc, packageName, version);
          }
        }
        try {
          await writeMetadataCache(upstream.host, packageName, {
            latestVersion: cached.latestVersion,
            author: cached.author,
            displayName: cached.displayName,
            metadata: response
          });
        } catch {
          // cache update is best-effort
        }
        reply.code(200);
        reply.type("application/json").send(stripVpmOriginal(filterMetadataByShasum(response)));
        return;
      }

      const metadata = buildNpmMetadataFromVpm(packageName, versions);
      const cachedForMerge = await readMetadataCache(upstream.host, packageName);
      if (cachedForMerge?.metadata) {
        mergeShasumFromCache(metadata, cachedForMerge.metadata);
      }
      if (metadata?.versions && typeof metadata.versions === "object") {
        for (const [version, node] of Object.entries<any>(metadata.versions)) {
          node.dist = node.dist ?? {};
          node.dist.tarball = buildVpmTarballProxyUrl(groupEnc, packageName, version);
        }
      }

      if (latestVersion) {
        await writeMetadataCache(upstream.host, packageName, {
          latestVersion,
          author: extractAuthor(metadata?.author),
          displayName: typeof metadata?.displayName === "string" ? metadata.displayName : undefined,
          metadata
        });
      }

      reply.code(200);
      reply.header("cache-control", "no-cache");
      reply.type("application/json").send(stripVpmOriginal(filterMetadataByShasum(metadata)));
      return;
    } catch {
      reply.code(404).send();
      return;
    }
  }

  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : (req.body as any);
  const isTarball =
    (method === "GET" || method === "HEAD") &&
    (normalizedRest.endsWith(".tgz") || normalizedRest.endsWith(".zip"));
  const tarballFilename = isTarball ? extractTarballFilenameFromPath(normalizedRest) : null;

  if (isTarball && packageName && tarballFilename) {
    const cachedBuffer = await readTarballCache(upstream.host, packageName, tarballFilename);
    if (cachedBuffer) {
      reply.code(200);
      reply.header("content-type", "application/octet-stream");
      reply.header("content-length", String(cachedBuffer.length));
      if (method === "HEAD") {
        reply.send();
      } else {
        reply.send(cachedBuffer);
      }
      return;
    }
  }

  const res = await request(upstreamUrl, { method, headers, body: body as any });
  const contentType = String(res.headers["content-type"] ?? "");

  if (res.statusCode === 404 && packageName) {
    await deletePackageCache(upstream, packageName);
  }

  if (contentType.includes("application/json")) {
    const json = (await res.body.json()) as any;

    if (json && typeof json === "object" && json.versions && typeof json.versions === "object") {
      if (packageName) {
        const latestVersion = getLatestVersionFromMetadata(json);
        const cached = await readMetadataCache(upstream.host, packageName);
        if (cached && latestVersion && cached.latestVersion === latestVersion) {
          const cachedMetadata = JSON.parse(JSON.stringify(cached.metadata));
          rewriteTarballUrlsInMetadata(cachedMetadata, upstream, groupEnc);
          reply.code(res.statusCode);
          applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, true);
          reply.type("application/json").send(cachedMetadata);
          return;
        }

        await mergeMetadataIfNeeded(json, packageName, upstream, headers);

        const cacheMetadata = JSON.parse(JSON.stringify(json));
        rewriteTarballUrlsInMetadata(json, upstream, groupEnc);

        if (latestVersion) {
          await writeMetadataCache(upstream.host, packageName, {
            latestVersion,
            author: extractAuthor(json?.author),
            displayName: typeof json?.displayName === "string" ? json.displayName : undefined,
            metadata: cacheMetadata
          });
        }
      } else {
        rewriteTarballUrlsInMetadata(json, upstream, groupEnc);
      }
    }

    reply.code(res.statusCode);
    applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, true);
    reply.type("application/json").send(json);
    return;
  }

  reply.code(res.statusCode);
  applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, false);
  const buffer = Buffer.from(await res.body.arrayBuffer());
  if (isTarball && method === "GET" && packageName && tarballFilename && res.statusCode < 400) {
    await writeTarballCache(upstream.host, packageName, tarballFilename, buffer);
  }
  reply.send(buffer);
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, _reply) => {
    req.log.info({ method: req.method, url: req.url }, "req_in");
  });

  app.register(
    async (r) => {
      r.get<{
        Params: { groupEnc: string };
        Querystring: { text?: string; from?: string; size?: string };
      }>("/-/v1/search", async (req, reply) => {
        await handleSearch(req, reply, req.params.groupEnc);
      });

      r.all("/*", async (req, reply) => {
        const groupEnc = (req.params as any).groupEnc as string;
        const restPath = (req.params as any)["*"] as string;
        await proxyGroupNpm(req, reply, groupEnc, restPath);
      });
    },
    { prefix: "/api/v4/groups/:groupEnc" }
  );

  app.register(
    async (r) => {
      r.all("/*", async (req, reply) => {
        const projectId = (req.params as any).projectId as string;
        const restPath = (req.params as any)["*"] as string;
        const packageName = extractPackageName(restPath);

        const upstreamUrl = `${defaultUpstream.baseUrl}/api/v4/projects/${projectId}/packages/npm/${restPath}`;
        const headers = buildUpstreamHeaders(req.headers as any);

        const method = req.method.toUpperCase();
        const body = method === "GET" || method === "HEAD" ? undefined : (req.body as any);
        const isTarball = (method === "GET" || method === "HEAD") && restPath.endsWith(".tgz");
        const tarballFilename = isTarball ? extractTarballFilenameFromPath(restPath) : null;

        if (isTarball && packageName && tarballFilename) {
          const cachedBuffer = await readTarballCache(
            defaultUpstream.host,
            packageName,
            tarballFilename
          );
          if (cachedBuffer) {
            reply.code(200);
            reply.header("content-type", "application/octet-stream");
            reply.header("content-length", String(cachedBuffer.length));
            if (method === "HEAD") {
              reply.send();
            } else {
              reply.send(cachedBuffer);
            }
            return;
          }
        }

        const res = await request(upstreamUrl, { method, headers, body: body as any });
        const contentType = String(res.headers["content-type"] ?? "");

        if (contentType.includes("application/json")) {
          const json = (await res.body.json()) as any;

          if (json && typeof json === "object" && json.versions && typeof json.versions === "object") {
            for (const v of Object.values<any>(json.versions)) {
              const tar = v?.dist?.tarball;
              if (typeof tar === "string" && tar.startsWith(defaultUpstream.baseUrl)) {
                v.dist.tarball = tar.replace(defaultUpstream.baseUrl, PUBLIC_BASE_URL);
              }
            }
          }

          reply.code(res.statusCode);
          applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, true);
          reply.type("application/json").send(json);
          return;
        }

        reply.code(res.statusCode);
        applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, false);
        const buffer = Buffer.from(await res.body.arrayBuffer());
        if (isTarball && method === "GET" && packageName && tarballFilename && res.statusCode < 400) {
          await writeTarballCache(defaultUpstream.host, packageName, tarballFilename, buffer);
        }
        reply.send(buffer);
      });
    },
    { prefix: "/api/v4/projects/:projectId/packages/npm" }
  );
};

export default routes;
