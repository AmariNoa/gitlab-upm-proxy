import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import * as semver from "semver";
import * as tar from "tar";
import { request } from "undici";
import {
  deleteMetadataCache,
  getPackageCacheDir,
  getTarballCachePath,
  getUpstreamCacheDir,
  hasTarballCache,
  isSafePackageName,
  readMetadataCache,
  readTarballCache,
  updateMetadataCache,
  writeTarballCache
} from "../lib/cache";
import {
  extractPackageName,
  getUpstreamConfig,
  selectUpstream,
  UpstreamEntry
} from "../lib/upstreams";
import {
  applyPackageSignature,
  fetchUpstreamSigningKeys,
  getProxySigningKey,
  hasProxySignature,
  isAuthenticUpstreamSigningKey,
  mergeSigningKeys
} from "../lib/npm-signatures";
import { startVpmPrefetchForPackage } from "../lib/vpm-prefetch";
import { computeSha1, convertZipBufferToTgz, runTempLocked } from "../lib/tgz";
import { mustEnv } from "../lib/env";

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

function buildUpstreamHeadersFor(
  upstream: UpstreamEntry,
  reqHeaders: Record<string, unknown>
): Record<string, string> {
  const headers = buildUpstreamHeaders(reqHeaders);
  if (upstream.baseUrl !== defaultUpstream.baseUrl) {
    // Nothing that identifies the caller goes to a registry other than the one they
    // authenticated against - the session cookie included.
    return withoutCredentials(headers);
  }
  return headers;
}

// Credentials belong to the upstream the caller authenticated against, and to nobody
// else. A VPM package's dist.original points at whatever host the VPM index names (a
// release asset host, a CDN, an arbitrary third party), so the caller's PAT must not ride
// along on that download - nor on a redirect that leaves the origin we started from.
function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  const stripped = { ...headers };
  delete stripped["Authorization"];
  delete stripped["PRIVATE-TOKEN"];
  // buildUpstreamHeaders copies the request's headers verbatim, so a session cookie rides
  // along unless it is removed here too. It identifies the caller just as much as the PAT
  // does, and has no business reaching a host outside the upstream we authenticated to.
  for (const name of Object.keys(stripped)) {
    if (name.toLowerCase() === "cookie") delete stripped[name];
  }
  return stripped;
}

function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function headersForDownload(
  targetUrl: string,
  upstream: UpstreamEntry,
  headers: Record<string, string>
): Record<string, string> {
  return isSameOrigin(targetUrl, upstream.baseUrl) ? headers : withoutCredentials(headers);
}

function extractPat(reqHeaders: Record<string, unknown>): string | null {
  const auth =
    (typeof reqHeaders["authorization"] === "string" ? (reqHeaders["authorization"] as string) : "") ||
    (typeof reqHeaders["Authorization"] === "string" ? (reqHeaders["Authorization"] as string) : "");
  if (auth) return auth;
  const token =
    (typeof reqHeaders["private-token"] === "string" ? (reqHeaders["private-token"] as string) : "") ||
    (typeof reqHeaders["PRIVATE-TOKEN"] === "string" ? (reqHeaders["PRIVATE-TOKEN"] as string) : "") ||
    (typeof reqHeaders["Private-Token"] === "string" ? (reqHeaders["Private-Token"] as string) : "");
  if (token) return `PRIVATE-TOKEN ${token}`;
  return null;
}

async function validateGitlabPat(req: any, reply: any): Promise<boolean> {
  const pat = extractPat(req.headers as Record<string, unknown>);
  if (!pat) {
    reply.code(401).send({ error: "missing_token" });
    return false;
  }

  const headers: Record<string, string> = {};
  if (pat.startsWith("PRIVATE-TOKEN ")) {
    headers["PRIVATE-TOKEN"] = pat.slice("PRIVATE-TOKEN ".length);
  } else {
    headers["Authorization"] = pat;
  }

  try {
    const res = await request(`${defaultUpstream.baseUrl}/api/v4/user`, {
      method: "GET",
      headers
    });
    // This runs on every single request and only the status code is of interest, so the
    // body must be discarded explicitly: an undici response whose body is never read holds
    // its connection until the socket is reclaimed, and at request rate that is enough to
    // exhaust the pool to the default upstream.
    await res.body.dump();
    if (res.statusCode >= 400) {
      reply.code(401).send({ error: "invalid_token" });
      return false;
    }
  } catch {
    reply.code(401).send({ error: "token_check_failed" });
    return false;
  }

  return true;
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

type VpmIndex = {
  author?: unknown;
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
    await res.body.dump();
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

// Exported for tests: the interleaving this guards against (a snapshot written back over a
// freshly re-signed archive) is impractical to drive through the HTTP routes.
export function mergeShasumFromCache(target: any, cached: any): void {
  if (!target?.versions || typeof target.versions !== "object") return;
  if (!cached?.versions || typeof cached.versions !== "object") return;
  for (const [version, node] of Object.entries<any>(target.versions)) {
    if (!node?.dist) continue;
    const cachedNode = cached.versions[version];
    const cachedDist = cachedNode?.dist;
    if (!cachedDist?.shasum) continue;
    if (node.dist.shasum) {
      // `target` is a snapshot taken before the slow work that precedes this merge, so a
      // shasum differing from disk means the archive was rebuilt and re-signed in the
      // meantime (the prefetch does that to inject a missing author). Writing the
      // snapshot back would advertise the hash of an archive the proxy no longer serves.
      // Only the proxy's own archives are replaced this way: for a plain npm passthrough
      // the upstream registry's shasum is authoritative and must not be overwritten by a
      // cached value.
      if (node.dist.shasum === cachedDist.shasum) continue;
      if (!hasProxySignature(cachedDist)) continue;
    }
    node.dist.shasum = cachedDist.shasum;
    // Signatures computed earlier (prefetch / tarball download) are reused so that
    // metadata responses do not re-sign every cached tarball on each request.
    if (typeof cachedDist.integrity === "string" && Array.isArray(cachedDist.signatures)) {
      node.dist.integrity = cachedDist.integrity;
      node.dist.signatures = cachedDist.signatures;
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

async function fillAuthorFromTgzIfNeeded(
  upstream: UpstreamEntry,
  packageName: string,
  version: string,
  node: any
): Promise<void> {
  if (node?.author) return;
  const cacheKey = `${packageName}-${version}.tgz`;
  const hasCache = await hasTarballCache(upstream.host, packageName, cacheKey);
  if (!hasCache) return;
  const tgzPath = getTarballCachePath(upstream.host, packageName, cacheKey);
  const info = await readPackageInfoFromTarballPath(tgzPath);
  if (info.author) {
    node.author = { name: info.author };
  }
}

async function refreshCachedVpmMetadata(
  upstream: UpstreamEntry,
  packageName: string,
  metadata: any
): Promise<void> {
  // Re-read the cache under the lock and merge in whatever shasum/integrity/signatures
  // are present there but missing on `metadata` (which was rebuilt from the VPM index,
  // possibly using a metadata cache read that is now stale). Without this, a version
  // signed/hashed by a concurrent request or prefetch pass between that earlier read and
  // this write would have its dist fields silently discarded.
  await updateMetadataCache(upstream.host, packageName, (current) => {
    if (current?.metadata) {
      mergeShasumFromCache(metadata, current.metadata);
    }
    const latestVersion = pickLatestVpmVersion(metadata?.versions);
    return {
      latestVersion: latestVersion ?? "",
      author: extractAuthor(metadata?.author),
      displayName: typeof metadata?.displayName === "string" ? metadata.displayName : undefined,
      metadata
    };
  });
}

function buildVpmTarballProxyUrl(
  packageName: string,
  version: string
): string {
  const encodedVersion = encodeURIComponent(`${packageName}-${version}.tgz`);
  return `${PUBLIC_BASE_URL}/-/${encodedVersion}`;
}

function stripVpmOriginal(metadata: any): any {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (!metadata.versions || typeof metadata.versions !== "object") return metadata;
  for (const v of Object.values<any>(metadata.versions)) {
    if (v?.dist && typeof v.dist === "object" && "original" in v.dist) {
      delete v.dist.original;
    }
  }
  if ("_vpmAuthor" in metadata) {
    delete metadata._vpmAuthor;
  }
  return metadata;
}

/**
 * Signs cached VPM tarballs that are not yet signed with the current proxy key.
 * Versions already carrying a signature by this key are left untouched so the
 * (expensive) hashing and signing runs once per tarball, not once per request.
 * Returns true when at least one version was signed.
 */
async function applyVpmSignaturesFromCache(
  upstream: UpstreamEntry,
  packageName: string,
  metadata: any
): Promise<boolean> {
  if (!metadata?.versions || typeof metadata.versions !== "object") return false;
  let changed = false;
  for (const [version, node] of Object.entries<any>(metadata.versions)) {
    if (!node?.dist?.shasum) continue;
    if (hasProxySignature(node.dist)) continue;
    const cacheKey = `${packageName}-${version}.tgz`;
    const cachedBuffer = await readTarballCache(upstream.host, packageName, cacheKey);
    if (!cachedBuffer) continue;
    applyPackageSignature(
      String(node.name ?? packageName),
      String(node.version ?? version),
      cachedBuffer,
      node.dist
    );
    changed = true;
  }
  return changed;
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
  const vpmAuthor = cachedMetadata?.metadata?._vpmAuthor;
  const tarballUrl = typeof versionNode?.dist?.original === "string" ? versionNode.dist.original : "";
  if (!tarballUrl) {
    reply.code(404).send();
    return true;
  }

  try {
    const buffer = await fetchBufferWithRedirects(
      tarballUrl,
      headersForDownload(tarballUrl, vpmUpstream, headers)
    );
    const tgzPath = getTarballCachePath(vpmUpstream.host, decodedName, cacheKey);
    await convertZipBufferToTgz(buffer, tgzPath, runTempLocked, vpmAuthor);
    const tgzBuffer = await readFile(tgzPath);
    const shasum = computeSha1(tgzBuffer);
    const distUpdate: Record<string, unknown> = { shasum };
    applyPackageSignature(decodedName, decodedVersion, tgzBuffer, distUpdate);

    const fallbackMetadata = cachedMetadata?.metadata;
    if (fallbackMetadata?.versions && typeof fallbackMetadata.versions === "object") {
      // Re-read the cache under the lock: `cachedMetadata` was read before the (slow)
      // network fetch and tgz conversion above, so it may be stale by now. Only the
      // freshly read version node's dist fields and author are set, so a concurrent
      // update to a different version is not overwritten.
      await updateMetadataCache(vpmUpstream.host, decodedName, (current) => {
        const target = current?.metadata ?? fallbackMetadata;
        const freshVersionNode =
          target?.versions && typeof target.versions === "object"
            ? target.versions[decodedVersion]
            : undefined;
        if (!freshVersionNode?.dist) return null;
        freshVersionNode.dist.shasum = distUpdate.shasum;
        if (typeof distUpdate.integrity === "string") {
          freshVersionNode.dist.integrity = distUpdate.integrity;
        }
        if (Array.isArray(distUpdate.signatures)) {
          freshVersionNode.dist.signatures = distUpdate.signatures;
        }
        applyAuthorIfMissing(freshVersionNode, vpmAuthor);
        return {
          latestVersion: current?.latestVersion ?? cachedMetadata?.latestVersion ?? "",
          author: current?.author ?? cachedMetadata?.author,
          displayName: current?.displayName ?? cachedMetadata?.displayName,
          metadata: target
        };
      });
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

// The keys endpoint publishes public key material only, so no upstream needs (or should
// receive) the caller's credentials for it: forwarding Authorization/PRIVATE-TOKEN/Cookie
// etc. here would leak them to unrelated registries for no benefit.
const SIGNING_KEY_REQUEST_HEADERS: Record<string, string> = { accept: "application/json" };

/** Collects every configured npm-type upstream (default included), de-duplicated by baseUrl. */
function collectNpmUpstreams(): UpstreamEntry[] {
  const seen = new Set<string>();
  const result: UpstreamEntry[] = [];
  for (const upstream of [defaultUpstream, ...upstreamConfig.upstreams]) {
    if (upstream.type !== "npm") continue;
    if (seen.has(upstream.baseUrl)) continue;
    seen.add(upstream.baseUrl);
    result.push(upstream);
  }
  return result;
}

async function handleNpmSigningKeys(_req: any, reply: any): Promise<void> {
  const proxyKey = getProxySigningKey();
  const keys = [proxyKey];

  for (const upstream of collectNpmUpstreams()) {
    try {
      const upstreamKeys = await fetchUpstreamSigningKeys(upstream, SIGNING_KEY_REQUEST_HEADERS);
      for (const key of upstreamKeys) {
        // The proxy's own key always wins: an upstream must never be able to shadow it by
        // claiming the same keyid, and any key that cannot prove it actually owns the
        // keyid it advertises (wrong curve, malformed material, or a hash mismatch) is
        // dropped rather than trusted.
        if (key.keyid === proxyKey.keyid) continue;
        if (!isAuthenticUpstreamSigningKey(key)) continue;
        keys.push(key);
      }
    } catch {
      // Missing keys on one upstream must not break signatures from other registries.
    }
  }

  reply.code(200);
  reply.type("application/json").send(mergeSigningKeys(keys));
}

async function fetchBufferWithRedirects(
  url: string,
  headers: Record<string, string>,
  maxRedirects = 5
): Promise<Buffer> {
  let current = url;
  let currentHeaders = headers;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await request(current, { method: "GET", headers: currentHeaders });
    const status = res.statusCode;
    if (status >= 300 && status < 400 && res.headers.location && i < maxRedirects) {
      const next = new URL(res.headers.location, current).toString();
      // Follow-the-credentials is how tokens end up in someone else's logs: once the
      // redirect chain leaves the origin we were authorized for, drop them for good.
      if (!isSameOrigin(next, url)) {
        currentHeaders = withoutCredentials(currentHeaders);
      }
      // The redirect's own body is of no interest, but it still has to be released before
      // the next hop, or each redirect leaves a connection tied up.
      await res.body.dump();
      current = next;
      continue;
    }
    if (status >= 400) {
      await res.body.dump();
      throw new Error(`zip_download_failed:${status}`);
    }
    return Buffer.from(await res.body.arrayBuffer());
  }
  throw new Error("zip_download_redirects_exceeded");
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
  // Second line of defence behind isSafePackageName: the recursive delete must only ever
  // run on a strict descendant of this upstream's cache directory. A path that escaped
  // would take the sibling packages - and the signing key stored under
  // TARBALL_CACHE_DIR - with it.
  const dir = getPackageCacheDir(upstream.host, packageName);
  const rel = relative(getUpstreamCacheDir(upstream.host), dir);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to delete outside the package cache: ${JSON.stringify(packageName)}`);
  }
  await deleteMetadataCache(upstream.host, packageName);
  await rm(dir, { recursive: true, force: true });
}

/**
 * Splits "<name>-<version>" (a tarball filename without its .tgz suffix) back into its
 * two parts. Splitting at the LAST dash is wrong for prerelease versions: it turns
 * "com.example.pkg-1.0.0-beta.1" into the package "com.example.pkg-1.0.0" at version
 * "beta.1", so a URL this proxy generated itself could not be resolved back and answered
 * 404. Candidates are tried from the LAST dash backwards, taking the first whose version
 * half is a complete semver, and the plain last-dash split remains the fallback when none
 * is. That ordering resolves both shapes correctly: "pkg-1.0.0-beta.1" finds nothing at
 * "beta.1" and settles on "1.0.0-beta.1", while a package whose own name ends in something
 * version-like ("pkg-1.2.3" at version "4.5.6") still splits at the last dash, exactly as
 * it did before. Searching from the earliest dash instead would read that filename as the
 * package "pkg" at version "1.2.3-4.5.6", since that is valid semver too.
 */
function splitTarballBasename(base: string): { name: string; version: string } | null {
  for (let i = base.lastIndexOf("-"); i > 0; i = base.lastIndexOf("-", i - 1)) {
    const version = base.slice(i + 1);
    if (semver.valid(version)) {
      return { name: base.slice(0, i), version };
    }
  }
  const lastDash = base.lastIndexOf("-");
  if (lastDash <= 0) return null;
  return { name: base.slice(0, lastDash), version: base.slice(lastDash + 1) };
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

/**
 * True only for a response that carries the whole tarball. The caller's Range header is
 * forwarded upstream (and the proxy advertises accept-ranges), so a cold-cache ranged
 * request can come back as a 206 holding a few bytes. Caching that would publish it as a
 * complete archive to every later request - and now that publication is atomic, it would do
 * so reliably.
 */
function isCompleteTarballResponse(statusCode: number, headers: Record<string, unknown>): boolean {
  if (statusCode !== 200) return false;
  return headers["content-range"] === undefined;
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
    await res.body.dump();
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
          tarballPath = await downloadTarballToCache(
            tarballUrl,
            upstream,
            packageName,
            headersForDownload(tarballUrl, upstream, headers)
          );
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
  const from = Number.parseInt((req.query.from ?? "0").toString(), 10) || 0;
  const sizeRaw = Number.parseInt((req.query.size ?? "20").toString(), 10) || 20;
  const size = Math.min(Math.max(sizeRaw, 1), 250);
  const headers = buildUpstreamHeadersFor(defaultUpstream, req.headers as any);

  const base = `${defaultUpstream.baseUrl}/api/v4/groups/${groupEncOnce}/packages`;
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

  const gitlabFiltered = all
    .filter((p) => p?.package_type === "npm")
    .filter((p) => {
      if (!text) return true;
      const name = String(p?.name ?? "");
      return name.includes(text);
    });
  const gitlabLatest = pickLatestByName(gitlabFiltered).map((p) => ({
    name: String(p?.name ?? ""),
    version: String(p?.version ?? ""),
    description: String(p?.description ?? ""),
    date: p?.created_at ?? new Date().toISOString()
  }));

  const upstreamResults: Array<{ name: string; version: string; description: string; date: string }> =
    [];
  const upstreams = upstreamConfig.upstreams.filter((u) => u.baseUrl !== defaultUpstream.baseUrl);

  for (const upstream of upstreams) {
    if (upstream.type === "vpm") {
      try {
        const index = await fetchVpmIndex(upstream, buildUpstreamHeadersFor(upstream, req.headers as any));
        const vpmAuthor = index.author;
        const packages = index.packages ?? {};
        for (const [name, pkg] of Object.entries(packages)) {
          if (text && !name.includes(text)) continue;
          const versions = pkg?.versions;
          if (!versions) continue;
          const cached = await readMetadataCache(upstream.host, name);
          const cachedVersions = cached?.metadata?.versions ?? {};
          const needsPrefetch = Object.keys(versions).some((version) => {
            const cachedNode = cachedVersions?.[version];
            return !cachedNode?.dist?.shasum;
          });
          if (needsPrefetch) {
            startVpmPrefetchForPackage(req.log, upstream, name, versions, vpmAuthor);
          }
          const latestVersion = pickLatestVpmVersion(versions);
          if (!latestVersion) continue;
          const metadata = buildNpmMetadataFromVpm(name, versions);
          if (vpmAuthor) {
            metadata._vpmAuthor = vpmAuthor;
          }
          if (cached?.metadata) {
            mergeShasumFromCache(metadata, cached.metadata);
          }
          if (metadata?.versions && typeof metadata.versions === "object") {
            for (const [version, node] of Object.entries<any>(metadata.versions)) {
              node.dist = node.dist ?? {};
              node.dist.tarball = buildVpmTarballProxyUrl(name, version);
            }
          }
          // Re-read under the lock and merge in any shasum/integrity/signatures already
          // on disk that `metadata` (rebuilt fresh from the VPM index) is missing, so a
          // concurrent writer's update is not discarded by this write.
          await updateMetadataCache(upstream.host, name, (current) => {
            if (current?.metadata) {
              mergeShasumFromCache(metadata, current.metadata);
            }
            return {
              latestVersion,
              author: extractAuthor(metadata?.author),
              displayName: typeof metadata?.displayName === "string" ? metadata.displayName : undefined,
              metadata
            };
          });
          const result = buildVpmSearchResult(name, versions);
          if (result) {
            upstreamResults.push(result);
          }
        }
      } catch {
        // ignore upstream failures
      }
      continue;
    }

    try {
      const u = new URL(`${upstream.baseUrl}/-/v1/search`);
      u.searchParams.set("text", text);
      u.searchParams.set("from", "0");
      u.searchParams.set("size", String(size));
      const res = await request(u.toString(), {
        method: "GET",
        headers: buildUpstreamHeadersFor(upstream, req.headers as any)
      });
      const contentType = String(res.headers["content-type"] ?? "");
      if (res.statusCode >= 400 || !contentType.includes("application/json")) {
        // Skipping this upstream still means releasing its body.
        await res.body.dump();
        continue;
      }
      const payload = await res.body.json();
      const normalized = normalizeSearchResponse(payload);
      for (const obj of normalized.objects) {
        const pkg = obj?.package ?? obj;
        upstreamResults.push({
          name: String(pkg?.name ?? ""),
          version: String(pkg?.version ?? ""),
          description: String(pkg?.description ?? ""),
          date: pkg?.date ?? new Date().toISOString()
        });
      }
    } catch {
      // ignore upstream failures
    }
  }

  const merged = new Map<string, { name: string; version: string; description: string; date: string }>();
  for (const item of upstreamResults) {
    if (!item.name) continue;
    merged.set(item.name, item);
  }
  for (const item of gitlabLatest) {
    if (!item.name) continue;
    merged.set(item.name, item);
  }

  const mergedList = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
  const sliced = mergedList.slice(from, from + size);
  const now = new Date().toISOString();

  reply.type("application/json").send({
    objects: sliced.map((p) => ({
      package: {
        name: p.name,
        version: p.version,
        description: p.description,
        date: p.date ?? now
      },
      score: { final: 1, detail: {} },
      searchScore: 1
    })),
    total: mergedList.length,
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
  // No function-wide header set on purpose: each branch below builds headers for the
  // upstream it actually talks to. A single set built for the default upstream is how the
  // caller's credentials used to reach other registries and third-party download hosts.

  if (normalizedRest.startsWith("npm/")) {
    const parts = normalizedRest.split("/").filter(Boolean);
    if (parts.length >= 4 && parts[2] === "-") {
      const decodedName = decodeURIComponent(parts[1] ?? "");
      const decodedFile = decodeURIComponent(parts[3] ?? "");
      const prefix = `${decodedName}-`;
      if (decodedName && decodedFile.startsWith(prefix) && decodedFile.endsWith(".tgz")) {
        const decodedVersion = decodedFile.slice(prefix.length, -4);
        // Build the headers for the upstream that actually owns this package, the same
        // way the vpm/ branch below does. `headers` above targets the default upstream
        // and carries the caller's PAT; handing those to a VPM download would send them
        // to whatever host the VPM index points at.
        const npmFormVpmUpstream = selectUpstream(decodedName);
        const handled = await serveVpmTarball(
          req,
          reply,
          normalizedRest,
          decodedName,
          decodedVersion,
          decodedFile,
          buildUpstreamHeadersFor(npmFormVpmUpstream, req.headers as any)
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
    if (decodedFile.endsWith(".tgz")) {
      const base = decodedFile.slice(0, -4);
      const prefix = `${decodedName}-`;
      decodedVersion = base.startsWith(prefix) ? base.slice(prefix.length) : base;
    } else {
      decodedVersion = decodedFile;
    }
    // Always the canonical "<name>-<version>.tgz" key, whichever spelling of this legacy
    // URL was used. The bare-version form used to key its cache on "<version>.tgz", a
    // second archive for the same version: serving it rebuilt the tgz (with a different
    // package.json timestamp once the author is injected) and wrote that archive's
    // integrity into the version node the canonical archive is advertised under, so the
    // published signature stopped matching the bytes metadata-directed clients download.
    const cacheKey = decodedVersion ? `${decodedName}-${decodedVersion}.tgz` : "";

    if (!decodedName) {
      reply.code(404).send();
      return;
    }

    if (!decodedVersion || !cacheKey) {
      reply.code(404).send();
      return;
    }

    const vpmUpstream = selectUpstream(decodedName);
    const handled = await serveVpmTarball(
      req,
      reply,
      normalizedRest,
      decodedName,
      decodedVersion,
      cacheKey,
      buildUpstreamHeadersFor(vpmUpstream, req.headers as any)
    );
    if (!handled) {
      reply.code(404).send();
    }
    return;
  }

  const packageName = extractPackageName(normalizedRest);
  // A dot-segment package name has no valid cache path, and every downstream helper
  // would throw on it. Answer 404 here so the request fails as "no such package"
  // instead of surfacing as a 500.
  if (packageName && !isSafePackageName(packageName)) {
    reply.code(404).send();
    return;
  }
  const upstream = packageName ? selectUpstream(packageName) : defaultUpstream;
  const upstreamUrl = getUpstreamBaseForGroup(upstream, groupEnc, normalizedRest);

  if (upstream.type === "vpm") {
    if (!packageName) {
      reply.code(404).send();
      return;
    }

    try {
      const index = await fetchVpmIndex(upstream, buildUpstreamHeadersFor(upstream, req.headers as any));
      const vpmAuthor = index.author;
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
            node.dist.tarball = buildVpmTarballProxyUrl(packageName, version);
            await fillAuthorFromTgzIfNeeded(upstream, packageName, version, node);
          }
        }
        // Sign before refreshing the cache so signatures persist and are not recomputed next time.
        // The cache write has to stay ahead of the response filters below: both mutate this very
        // object, and the cache needs what they remove. filterMetadataByShasum drops versions
        // whose tgz has not been fetched yet, and stripVpmOriginal drops the dist.original that
        // tarball requests resolve from plus the _vpmAuthor used to fill in a missing author.
        await applyVpmSignaturesFromCache(upstream, packageName, response);
        try {
          await refreshCachedVpmMetadata(upstream, packageName, response);
        } catch {
          // cache update is best-effort
        }
        reply.code(200);
        reply.type("application/json").send(stripVpmOriginal(filterMetadataByShasum(response)));
        return;
      }

      const metadata = buildNpmMetadataFromVpm(packageName, versions);
      if (vpmAuthor) {
        metadata._vpmAuthor = vpmAuthor;
      }
      const cachedForMerge = await readMetadataCache(upstream.host, packageName);
      if (cachedForMerge?.metadata) {
        mergeShasumFromCache(metadata, cachedForMerge.metadata);
      }
      if (metadata?.versions && typeof metadata.versions === "object") {
        for (const [version, node] of Object.entries<any>(metadata.versions)) {
          node.dist = node.dist ?? {};
          node.dist.tarball = buildVpmTarballProxyUrl(packageName, version);
          await fillAuthorFromTgzIfNeeded(upstream, packageName, version, node);
        }
      }

      // Sign before refreshing the cache so signatures persist and are not recomputed next time.
      // As on the cache-hit path above, the cache write has to stay ahead of the response filters
      // below, which mutate this very object and remove what the cache needs: versions without a
      // tgz yet, the dist.original that tarball requests resolve from, and the _vpmAuthor used to
      // fill in a missing author.
      await applyVpmSignaturesFromCache(upstream, packageName, metadata);
      if (latestVersion) {
        await refreshCachedVpmMetadata(upstream, packageName, metadata);
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

  const res = await request(upstreamUrl, {
    method,
    headers: buildUpstreamHeadersFor(upstream, req.headers as any),
    body: body as any
  });
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

        // Headers for the upstream that owns this package, not the default one: the
        // enrichment step may download the tarball, and `headers` above targets the
        // default upstream and carries the caller's credentials.
        await mergeMetadataIfNeeded(
          json,
          packageName,
          upstream,
          buildUpstreamHeadersFor(upstream, req.headers as any)
        );

        const cacheMetadata = JSON.parse(JSON.stringify(json));
        rewriteTarballUrlsInMetadata(json, upstream, groupEnc);

        if (latestVersion) {
          // Re-read under the lock and merge in any shasum/integrity/signatures already
          // on disk that `cacheMetadata` is missing, so a concurrent writer's update to
          // this package is not discarded by this write.
          await updateMetadataCache(upstream.host, packageName, (current) => {
            if (current?.metadata) {
              mergeShasumFromCache(cacheMetadata, current.metadata);
            }
            return {
              latestVersion,
              author: extractAuthor(json?.author),
              displayName: typeof json?.displayName === "string" ? json.displayName : undefined,
              metadata: cacheMetadata
            };
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
  if (
    isTarball &&
    method === "GET" &&
    packageName &&
    tarballFilename &&
    isCompleteTarballResponse(res.statusCode, res.headers as Record<string, unknown>)
  ) {
    await writeTarballCache(upstream.host, packageName, tarballFilename, buffer);
  }
  reply.send(buffer);
}

async function proxyGlobalTarball(req: any, reply: any, restPath: string): Promise<void> {
  const normalizedRest = restPath.replace(/^\/+/, "");
  if (!normalizedRest.endsWith(".tgz")) {
    reply.code(404).send();
    return;
  }

  const filename = extractTarballFilenameFromPath(normalizedRest);
  if (!filename) {
    reply.code(404).send();
    return;
  }

  const decodedFile = decodeURIComponent(filename);
  if (!decodedFile.endsWith(".tgz")) {
    reply.code(404).send();
    return;
  }

  const base = decodedFile.slice(0, -4);
  const split = splitTarballBasename(base);
  if (!split) {
    reply.code(404).send();
    return;
  }

  const { name: decodedName, version: decodedVersion } = split;
  const upstream = selectUpstream(decodedName);
  if (upstream.type !== "vpm") {
    reply.code(404).send();
    return;
  }

  const headers = buildUpstreamHeadersFor(upstream, req.headers as any);
  const handled = await serveVpmTarball(
    req,
    reply,
    `-/${decodedFile}`,
    decodedName,
    decodedVersion,
    decodedFile,
    headers
  );
  if (!handled) {
    reply.code(404).send();
  }
}

async function proxyDefaultGitlabApi(req: any, reply: any): Promise<void> {
  const rawUrl = typeof req.raw?.url === "string" ? req.raw.url : req.url;
  const upstreamUrl = `${defaultUpstream.baseUrl}${rawUrl}`;
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : (req.body as any);

  const res = await request(upstreamUrl, {
    method,
    headers: buildUpstreamHeadersFor(defaultUpstream, req.headers as any),
    body: body as any
  });

  reply.code(res.statusCode);
  applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, false);
  if (method === "HEAD") {
    reply.send();
    return;
  }
  const buffer = Buffer.from(await res.body.arrayBuffer());
  reply.send(buffer);
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    req.log.info({ method: req.method, url: req.url }, "req_in");
    const ok = await validateGitlabPat(req, reply);
    if (!ok) return reply;
  });

  app.register(async (r) => {
    r.get("/-/npm/v1/keys", async (req, reply) => {
      await handleNpmSigningKeys(req, reply);
    });

    r.all("/-/*", async (req, reply) => {
      const restPath = (req.params as any)["*"] as string;
      await proxyGlobalTarball(req, reply, restPath);
    });
  });

  app.register(
    async (r) => {
      r.all("/self", async (req, reply) => {
        await proxyDefaultGitlabApi(req, reply);
      });
    },
    { prefix: "/api/v4/personal_access_tokens" }
  );

  app.register(
    async (r) => {
      r.get<{
        Params: { groupEnc: string };
        Querystring: { text?: string; from?: string; size?: string };
      }>("/-/v1/search", async (req, reply) => {
        await handleSearch(req, reply, req.params.groupEnc);
      });

      r.get("/-/npm/v1/keys", async (req, reply) => {
        await handleNpmSigningKeys(req, reply);
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
        if (packageName && !isSafePackageName(packageName)) {
          reply.code(404).send();
          return;
        }

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
        if (
          isTarball &&
          method === "GET" &&
          packageName &&
          tarballFilename &&
          isCompleteTarballResponse(res.statusCode, res.headers as Record<string, unknown>)
        ) {
          await writeTarballCache(defaultUpstream.host, packageName, tarballFilename, buffer);
        }
        reply.send(buffer);
      });
    },
    { prefix: "/api/v4/projects/:projectId/packages/npm" }
  );
};

export default routes;
