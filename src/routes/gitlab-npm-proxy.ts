import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import * as semver from "semver";
import * as tar from "tar";
import { request } from "undici";
import {
  fetchBufferWithRedirects,
  fetchJsonWithRedirects,
  isSameOrigin,
  readUpstreamBody,
  readUpstreamJson,
  requestUpstream,
  UpstreamError,
  withoutCredentials,
  withoutResponseNarrowing
} from "../lib/http";
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
import { computeSha1, convertZipBufferToTgzUnlocked, runTempLocked } from "../lib/tgz";
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
    // Only a 200 counts as "this token is valid". undici does not follow redirects, so a
    // GitLab URL that answers with a 301/302 - an http to https hop, or a redirect to a
    // login page - used to make every token, valid or not, pass this hook. Anything other
    // than the documented 200 means the check did not actually happen.
    if (res.statusCode !== 200) {
      reply.code(401).send({ error: "invalid_token" });
      return false;
    }
  } catch {
    reply.code(401).send({ error: "token_check_failed" });
    return false;
  }

  return true;
}

/**
 * Headers that describe the connection they arrived on rather than the resource. They belong to
 * the proxy-to-upstream hop and say nothing about the client's own connection - forwarding an
 * upstream "Connection: close" told the client to close a connection that was never the one being
 * described.
 */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
];

/**
 * Validators and digests computed over the upstream's bytes. When the proxy rewrites a body -
 * tarball URLs replaced, enrichment fields added, JSON re-serialized - these describe bytes the
 * client is not receiving, so a client that checks them fails, and one that revalidates against
 * the ETag is told nothing changed when the representation did.
 */
const BODY_DEPENDENT_HEADERS = ["content-length", "etag", "content-md5", "digest", "content-digest", "repr-digest"];

/**
 * Reconciles a snapshot about to be written against what is on disk right now.
 *
 * Exported and shared because two writers persist VPM metadata - the metadata route and search -
 * and every time one of them gained a rule the other kept the old behaviour until a later review
 * round found it. There is one rule set now, and both call it.
 */
export function reconcileAgainstDisk(metadata: any, cached: any, baseline?: any): void {
  if (!cached) return;
  mergeShasumFromCache(metadata, cached);
  clearAvailabilityDroppedOnDisk(metadata, cached);
  insertVersionsAddedSinceBaseline(metadata, cached, baseline);
}

/**
 * Copies an upstream response's headers onto the reply.
 *
 * `bodyRewritten` says the body being sent is the proxy's own rendering rather than the upstream's
 * bytes, which is what makes the digests and validators above wrong to pass on.
 */
function applyUpstreamHeaders(
  reply: any,
  headers: Record<string, unknown>,
  bodyRewritten: boolean
): void {
  // Fields the upstream's own Connection header nominates are hop-by-hop for this response only.
  const connection = headers["connection"];
  const nominated = new Set(
    String(Array.isArray(connection) ? connection.join(",") : (connection ?? ""))
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );

  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") continue;
    const key = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.includes(key)) continue;
    if (nominated.has(key)) continue;
    if (bodyRewritten && BODY_DEPENDENT_HEADERS.includes(key)) continue;
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

// The index is not the resource the caller asked for: they asked for one package document (or a
// search), and this is the whole catalogue the proxy derives it from. So their conditional
// headers and Range must not reach it - an `If-None-Match: *` would otherwise turn the index
// into a 304 with no body, and a Range into a fragment of JSON. Redirects are followed here
// because undici does not, and an unfollowed 301 used to be parsed as the index itself.
// fetchJsonWithRedirects handles both, and drops the caller's credentials if the chain leaves
// the origin the index URL named.
async function fetchVpmIndex(
  upstream: UpstreamEntry,
  headers: Record<string, string>
): Promise<VpmIndex> {
  return fetchJsonWithRedirects<VpmIndex>(getVpmIndexUrl(upstream), headers, "vpm_index_failed");
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
      // semver.minVersion throws on a range it cannot parse, and one such dependency in one
      // old version used to take the whole package's metadata with it - a cold request
      // answered 404 even though every other version was fine. A dependency the proxy
      // cannot express is dropped from the normalised set instead.
      try {
        const min = semver.minVersion(normalizedRange);
        if (min) {
          normalizedDeps[depName] = min.version;
        }
      } catch {
        // unparseable range: leave this dependency out rather than fail the version
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

// A version that is on disk but missing from what this request is about to write is one of
// two very different things, and the disk alone cannot tell them apart:
//
//   - it was published by a prefetch pass running alongside this request, after the request
//     read the cache. Writing without it deletes it, and the next request rebuilds it from
//     the index without the shasum that was just discarded, so it disappears from every
//     response until some other writer restores it.
//   - it was in the cache when this request started and the upstream index no longer lists
//     it. The upstream withdrew it, and restoring it would resurrect it permanently -
//     including as `latest`, since latestVersion is chosen from what gets written.
//
// The baseline - the cache as this request first read it - separates the two: anything on
// disk that the baseline did not have arrived concurrently and is kept; anything the
// baseline did have is this request's to drop.
// Removes the versions the upstream index no longer lists. Only versions the baseline knew
// about are candidates: anything else appeared on disk after this request read the cache and
// belongs to another writer, whose index may well be newer than the one read here.
function dropVersionsWithdrawnFromIndex(
  target: any,
  indexVersions: Record<string, any> | undefined,
  baseline: any
): void {
  if (!target?.versions || typeof target.versions !== "object") return;
  if (!indexVersions || typeof indexVersions !== "object") return;
  const baselineVersions =
    baseline?.versions && typeof baseline.versions === "object" ? baseline.versions : {};
  for (const version of Object.keys(target.versions)) {
    if (indexVersions[version] !== undefined) continue;
    if (baselineVersions[version] === undefined) continue;
    delete target.versions[version];
  }
}

function insertVersionsAddedSinceBaseline(target: any, cached: any, baseline: any): void {
  if (!cached?.versions || typeof cached.versions !== "object") return;
  const baselineVersions =
    baseline?.versions && typeof baseline.versions === "object" ? baseline.versions : {};
  target.versions = target.versions && typeof target.versions === "object" ? target.versions : {};
  for (const [version, node] of Object.entries<any>(cached.versions)) {
    if (target.versions[version] !== undefined) continue;
    if (baselineVersions[version] !== undefined) continue;
    target.versions[version] = node;
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
    // The same rule pickLatestVpmVersion applies: semver among the versions that are semver, and
    // a lexical fallback only when none are. Sorting every key with semver.rcompare threw on the
    // first key it could not parse - a VPM index may legitimately publish "nightly" - and the
    // caller turned that into a 404 for the whole package, archives and all.
    const latest = pickLatestVpmVersion(filtered);
    if (latest) {
      metadata["dist-tags"] = { latest };
    } else {
      delete metadata["dist-tags"];
    }
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

// VPM only, and deliberately not part of mergeShasumFromCache, which the npm passthrough
// also uses: there the upstream registry's fields are authoritative. Here the proxy owns
// them, and a version that is on disk WITHOUT a shasum has had its availability cleared -
// the prefetch does that when it deletes an archive whose metadata it could not publish.
// mergeShasumFromCache skips such an entry (it has nothing to copy), so a snapshot taken
// before the rollback would otherwise write its own shasum and signature back and undo the
// cleanup permanently. A snapshot can never hold a NEWER shasum than disk on this path: the
// metadata route only ever reuses shasums, it does not compute them.
function clearAvailabilityDroppedOnDisk(target: any, cached: any): void {
  if (!isPlainObject(target?.versions) || !isPlainObject(cached?.versions)) return;
  for (const [version, node] of Object.entries<any>(target.versions)) {
    const cachedDist = cached.versions[version]?.dist;
    if (!cachedDist || cachedDist.shasum) continue;
    if (!node?.dist) continue;
    delete node.dist.shasum;
    delete node.dist.integrity;
    delete node.dist.signatures;
  }
}

// Exported for tests, like mergeShasumFromCache: the interleaving it has to survive (a
// prefetch publishing a version between this request's snapshot and its write) cannot be
// driven deterministically through the HTTP routes.
export async function refreshCachedVpmMetadata(
  upstream: UpstreamEntry,
  packageName: string,
  metadata: any,
  // The cache as this request first read it, used to tell a concurrently published version
  // from one the upstream withdrew. Omitted (or null) means every version on disk that is
  // missing from `metadata` was withdrawn - correct for callers whose `metadata` IS the
  // cache they just read.
  baseline?: any
): Promise<void> {
  // Re-read the cache under the lock and merge in whatever shasum/integrity/signatures
  // are present there but missing on `metadata` (which was rebuilt from the VPM index,
  // possibly using a metadata cache read that is now stale). Without this, a version
  // signed/hashed by a concurrent request or prefetch pass between that earlier read and
  // this write would have its dist fields silently discarded.
  await updateMetadataCache(upstream.host, packageName, (current) => {
    reconcileAgainstDisk(metadata, current?.metadata, baseline);
    // Chosen after the merge, so a version added by a concurrent writer can still be the
    // latest one rather than being rolled back to whatever this snapshot knew.
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

  // Read under the same per-directory lock a conversion holds, so this never serves an
  // archive from the middle of someone else's transaction: the conversion publishes the new
  // tgz by rename and only then writes the metadata that describes it, and a lock-free read
  // landing between the two hands the client new bytes with the previous signature. Waiting
  // here serializes concurrent downloads of the same package (local file reads, so the cost
  // is small) and blocks while that package is being converted, which is the point.
  const cachedBuffer = await runTempLocked(
    dirname(getTarballCachePath(vpmUpstream.host, decodedName, cacheKey)),
    () => readTarballCache(vpmUpstream.host, decodedName, cacheKey)
  );
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
      withoutResponseNarrowing(headersForDownload(tarballUrl, vpmUpstream, headers))
    );
    const tgzPath = getTarballCachePath(vpmUpstream.host, decodedName, cacheKey);
    // Converting the archive, hashing it and publishing what that hash describes is one
    // change from a client's point of view, so it is one critical section: releasing the
    // lock between the conversion's rename and the metadata write would let a reader see
    // the new archive beside the old signature. The unlocked conversion helper is used
    // because the lock is not reentrant.
    const tgzBuffer = await runTempLocked(dirname(tgzPath), async () => {
      // The cache miss that led here was observed before the lock, and the download that
      // followed is slow: another request (or a prefetch pass) can have converted and
      // published this very version in the meantime. Converting again would replace a
      // published archive with different bytes - author injection rewrites package.json, so
      // two conversions do not agree byte for byte - and a client holding the first
      // archive's metadata would then download the second one and fail verification.
      const alreadyPublished = await readTarballCache(vpmUpstream.host, decodedName, cacheKey);
      if (!alreadyPublished) {
        await convertZipBufferToTgzUnlocked(buffer, tgzPath, vpmAuthor);
      }
      const bytes = alreadyPublished ?? (await readFile(tgzPath));
      try {
      const shasum = computeSha1(bytes);
      const distUpdate: Record<string, unknown> = { shasum };
      applyPackageSignature(decodedName, decodedVersion, bytes, distUpdate);

      const fallbackMetadata = cachedMetadata?.metadata;
      if (fallbackMetadata?.versions && typeof fallbackMetadata.versions === "object") {
        // Re-read the cache under the metadata lock: `cachedMetadata` was read before the
        // (slow) network fetch and tgz conversion above, so it may be stale by now. Only
        // the freshly read version node's dist fields and author are set, so a concurrent
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
      } catch (err) {
        // The archive this call published is already in place; leaving it there with the
        // metadata still describing the previous one would have the cache serve bytes no
        // signature matches, and nothing repairs that afterwards. Drop it so the next
        // request converts again.
        if (!alreadyPublished) {
          await rm(tgzPath, { force: true }).catch(() => {});
        }
        throw err;
      }

      return bytes;
    });

    reply.code(200);
    applyTarballHeaders(reply, tgzBuffer.length);
    if (req.method.toUpperCase() === "HEAD") {
      reply.send();
    } else {
      reply.send(tgzBuffer);
    }
    return true;
  } catch (err) {
    // Same reasoning as the metadata path: a download, conversion or publication failure is not
    // evidence that the archive does not exist.
    req.log.info({ err, packageName: decodedName, version: decodedVersion }, "vpm_tarball_failed");
    reply.code(failureStatus(err)).send();
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

// The published tarball URLs keep whatever query the upstream put on them (a signed
// download parameter, typically), so the request that comes back carries it - but the
// upstream URL is rebuilt from route parameters alone and used to drop it. The raw string
// is appended verbatim: re-encoding a signature invalidates it.
function appendRawQuery(url: string, req: any): string {
  const raw = String(req?.raw?.url ?? "");
  const queryStart = raw.indexOf("?");
  if (queryStart < 0) return url;
  const query = raw.slice(queryStart + 1);
  if (!query) return url;
  return url.includes("?") ? `${url}&${query}` : `${url}?${query}`;
}

/**
 * Re-encodes a route parameter as a single URL path segment.
 *
 * Fastify decodes route parameters, so a nested group or a project path written as "team%2Fsub"
 * arrives here as "team/sub" despite the parameter's name. Interpolating that into a URL splits it
 * into two segments: the upstream request then addresses a group that does not exist, and a
 * rewritten tarball URL grows a segment that the next request reads as part of the package path.
 */
function asSinglePathSegment(value: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // A malformed percent escape is not ours to repair; encode what we were given.
  }
  return encodeURIComponent(decoded);
}

function getUpstreamBaseForGroup(
  upstream: UpstreamEntry,
  groupEnc: string,
  restPath: string
): string {
  const normalizedRest = restPath.replace(/^\/+/, "");
  if (upstream.baseUrl === defaultUpstream.baseUrl) {
    return `${upstream.baseUrl}/api/v4/groups/${asSinglePathSegment(groupEnc)}/-/packages/npm/${normalizedRest}`;
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
    // Only what this proxy can actually route back. getUpstreamBaseForGroup rebuilds the
    // upstream URL as `${upstream.baseUrl}/${rest}`, so a tarball hosted anywhere else - a
    // CDN the registry points at, typically - cannot be reconstructed from the rewritten
    // path: the proxy URL would resolve to a different resource on the registry itself, and
    // the download fails after metadata that looked fine. Those URLs are published as they
    // are, and the client fetches them directly.
    const base = new URL(upstream.baseUrl);
    if (parsed.origin !== base.origin) {
      return tarballUrl;
    }
    // The rewritten URL is served back to us on the group route, where its first path
    // segment is read as the package name. Keeping the registry's own base path in it makes
    // that segment the base path - "registry" instead of "com.example.pkg" - so the request
    // is routed to the default upstream and 404s, or has the base path applied twice.
    // Whatever getUpstreamBaseForGroup will put back in front has to come off here.
    const basePath = upstreamBasePath(upstream);
    let path = parsed.pathname;
    if (basePath) {
      if (path !== basePath && !path.startsWith(`${basePath}/`)) {
        // Same origin but outside the registry's own path: not ours to route either.
        return tarballUrl;
      }
      path = path.slice(basePath.length);
    }
    const tarPath = `${path}${parsed.search}`.replace(/^\/+/, "");
    // Last check, and the one that actually matters: the rewritten URL comes back on the
    // group route, which reads its first path segment as the package name and picks the
    // upstream from that. A tarball filed under some other prefix - ".../registry/downloads/
    // pkg-1.0.0.tgz" - passes the origin and base-path tests and still resolves to a
    // different upstream, turning a working download into a broken proxy URL. If the round
    // trip does not land back here, publish the upstream's own URL.
    // tarPath comes out of a URL, so it is still percent-encoded here.
    const roundTripName = extractPackageName(tarPath, true);
    if (!roundTripName || selectUpstream(roundTripName).baseUrl !== upstream.baseUrl) {
      return tarballUrl;
    }
    return `${PUBLIC_BASE_URL}/api/v4/groups/${asSinglePathSegment(groupEnc)}/${tarPath}`;
  } catch {
    return tarballUrl;
  }
}

/** The path portion of an upstream's baseUrl, without a trailing slash ("" when there is none). */
function upstreamBasePath(upstream: UpstreamEntry): string {
  try {
    return new URL(upstream.baseUrl).pathname.replace(/\/+$/, "");
  } catch {
    return "";
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

// `typeof null` and `typeof []` are both "object", and an index whose `packages` is either
// of those is malformed rather than empty. Nothing destructive may be derived from it.
function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Applies a package-level withdrawal. Deleting the whole package would take versions the
 * request never saw - published by another writer from a newer index while this one was in
 * flight - so only the versions the baseline knew about are removed, together with their
 * archives. The package itself goes only when that leaves nothing behind.
 */
// Exported so a test can drive the withdrawal directly and race a concurrent publication
// against it; the HTTP route reaches it only through a full metadata request.
export async function removeWithdrawnPackage(
  upstream: UpstreamEntry,
  packageName: string,
  baselineMetadata: any
): Promise<void> {
  const baselineVersions = isPlainObject(baselineMetadata?.versions)
    ? baselineMetadata.versions
    : {};
  // Both locks, in the order the prefetch takes them (archive, then metadata), and held across the
  // decision AND the deletion. Deciding "nothing is left" under the metadata lock and then
  // releasing it before deleting the directory left a window in which a concurrent prefetch could
  // publish a new version - and the delete took that version's metadata and archive with it.
  const packageDir = getPackageCacheDir(upstream.host, packageName);
  await runTempLocked(packageDir, async () => {
    await updateMetadataCache(upstream.host, packageName, async (current) => {
      const target = current?.metadata;
      if (!isPlainObject(target?.versions)) {
        await deletePackageCache(upstream, packageName);
        return null;
      }
      const removed: string[] = [];
      for (const version of Object.keys(target.versions)) {
        if (baselineVersions[version] === undefined) continue;
        delete target.versions[version];
        removed.push(version);
      }
      if (Object.keys(target.versions).length === 0) {
        // Re-read under the lock, so this is the current state and not the one the caller saw.
        await deletePackageCache(upstream, packageName);
        return null;
      }
      for (const version of removed) {
        const path = getTarballCachePath(upstream.host, packageName, `${packageName}-${version}.tgz`);
        await rm(path, { force: true }).catch(() => {});
      }
      return {
        latestVersion: pickLatestVpmVersion(target.versions) ?? "",
        author: current?.author,
        displayName: current?.displayName,
        metadata: target
      };
    });
  });
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
 * 404. No scan direction gets this right on its own, because the filename is genuinely
 * ambiguous: "pkg-1.0.0-beta.1" is the package "pkg" at a prerelease version, while
 * "pkg-1.2.3-4.5.6" is most likely the package "pkg-1.2.3" at version "4.5.6" - and
 * "pkg-1.0.0-2.3.4" could be either, since both halves are valid semver. Candidates are
 * therefore listed from the last dash backwards and resolved against what the proxy
 * actually knows, in splitTarballCandidates' caller.
 */
function splitTarballCandidates(base: string): Array<{ name: string; version: string }> {
  const candidates: Array<{ name: string; version: string }> = [];
  for (let i = base.lastIndexOf("-"); i > 0; i = base.lastIndexOf("-", i - 1)) {
    const version = base.slice(i + 1);
    if (semver.valid(version)) {
      candidates.push({ name: base.slice(0, i), version });
    }
  }
  const lastDash = base.lastIndexOf("-");
  if (lastDash > 0) {
    const fallback = { name: base.slice(0, lastDash), version: base.slice(lastDash + 1) };
    // The historical behaviour, kept last so filenames whose version is not valid semver
    // still resolve exactly as they always did.
    if (!candidates.some((c) => c.name === fallback.name && c.version === fallback.version)) {
      candidates.push(fallback);
    }
  }
  return candidates;
}

/**
 * Picks the candidate split that the proxy can actually corroborate: the name must belong
 * to a VPM upstream, and that upstream's metadata cache must already list the version. Only
 * when nothing can be corroborated - a cold cache, typically - does it fall back to the
 * first candidate, which is the previous behaviour.
 */
async function resolveTarballBasename(
  base: string,
  log?: { info: (obj: any, msg?: string) => void }
): Promise<{ name: string; version: string } | null> {
  const candidates = splitTarballCandidates(base);
  if (candidates.length === 0) return null;

  const corroborated: Array<{ name: string; version: string }> = [];
  for (const candidate of candidates) {
    if (!isSafePackageName(candidate.name)) continue;
    const upstream = selectUpstream(candidate.name);
    if (upstream.type !== "vpm") continue;
    const cached = await readMetadataCache(upstream.host, candidate.name);
    if (cached?.metadata?.versions?.[candidate.version]) {
      corroborated.push(candidate);
    }
  }

  if (corroborated.length > 1) {
    // Two real packages can generate the same filename - "amb" at "1.0.0-2.3.4" and
    // "amb-1.0.0" at "2.3.4" both produce "amb-1.0.0-2.3.4.tgz" - and this URL format
    // carries nothing that tells them apart. The first candidate is served, which means the
    // other package's clients get an archive whose integrity will not match. Nothing can be
    // decided here; the collision is logged so it is at least visible, and PROJECT_MAP
    // records the limitation.
    log?.info(
      { basename: base, candidates: corroborated.map((c) => `${c.name}@${c.version}`) },
      "tarball_name_collision"
    );
  }

  return corroborated[0] ?? candidates[0];
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
/** The path of a request URL with any query string removed, for logging. */
export function pathWithoutQuery(url: unknown): string {
  const raw = typeof url === "string" ? url : "";
  const queryStart = raw.indexOf("?");
  return queryStart < 0 ? raw : raw.slice(0, queryStart);
}

/** Statuses HTTP defines as carrying no message body, whatever Content-Type accompanies them. */
function isBodylessStatus(statusCode: number): boolean {
  return statusCode === 204 || statusCode === 205 || statusCode === 304;
}

/**
 * Errors raised by the upstream side of a request rather than by this proxy's own work.
 *
 * The distinction matters because a 404 is a statement about the package: it says the upstream
 * confirmed the thing does not exist. A registry answering 503, a connection that failed, or a
 * body over the ceiling say nothing of the sort - reporting them as absence tells a client to stop
 * asking, and lets an intermediary cache that answer.
 */
/**
 * Asks the upstream whether this caller may have this package, before an archive is served from
 * cache.
 *
 * The PAT check on every request only establishes that the token is a valid GitLab token. It says
 * nothing about which packages that user can see. The tarball cache is keyed on the upstream host
 * and the package name - no group, no user - so once anyone fetches a package, a cache hit used to
 * hand it to any caller with any valid token, including one who could not have fetched it
 * themselves. Only the upstream knows who may see what, so the upstream is asked.
 *
 * The question is only meaningful for the default GitLab upstream. Requests to other registries go
 * out with the caller's credentials stripped, so there is no per-caller authorisation there to
 * consult - the proxy reaches them as itself.
 *
 * Returns true when the archive may be served. On a refusal it has already answered the caller
 * with the upstream's own status. A failure to reach the upstream is thrown rather than swallowed:
 * falling back to the cache there would be exactly the silent bypass this exists to close.
 */
async function callerMayReadCachedPackage(
  req: any,
  reply: any,
  upstream: UpstreamEntry,
  metadataUrl: string
): Promise<boolean> {
  if (upstream.baseUrl !== defaultUpstream.baseUrl) return true;

  let res;
  try {
    res = await requestUpstream(metadataUrl, {
      method: "HEAD",
      headers: withoutResponseNarrowing(buildUpstreamHeadersFor(upstream, req.headers as any))
    });
    await res.body.dump();
  } catch (err) {
    // Classified here rather than left to bubble: the npm relay this sits in has no failure
    // mapping of its own, so an unreachable authority would surface as a 500 - and, more to the
    // point, must never fall through to serving the cache.
    req.log.info({ err, path: pathWithoutQuery(req.url) }, "cached_tarball_authz_failed");
    reply.code(failureStatus(err)).send();
    return false;
  }
  if (res.statusCode >= 200 && res.statusCode < 300) return true;

  req.log.info(
    { status: res.statusCode, path: pathWithoutQuery(req.url) },
    "cached_tarball_denied"
  );
  reply.code(res.statusCode);
  applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, true);
  reply.send();
  return false;
}

/**
 * 404 only when an upstream actually said the thing is not there, 502 when it failed to answer,
 * 500 when the failure was ours. Everything used to collapse into 404, which told clients and
 * caches that a package was gone whenever a registry was merely unwell.
 *
 * Read from the error's own fields, not from its message. The first version of this matched a
 * trailing three-digit number, which called a 404-byte body over the ceiling an absent package and
 * missed a refused connection entirely - a message is prose, and prose is not a status code.
 */
function failureStatus(err: unknown): number {
  if (!(err instanceof UpstreamError)) return 500;
  if (err.kind === "status" && (err.status === 404 || err.status === 410)) return 404;
  return 502;
}

function isCompleteTarballResponse(statusCode: number, headers: Record<string, unknown>): boolean {
  if (statusCode !== 200) return false;
  if (headers["content-range"] !== undefined) return false;
  // The cache stores bytes and serves them back with no Content-Encoding of its own, so an
  // encoded body must not go in: the first caller would decode it correctly from the forwarded
  // header, and every later one would receive the still-encoded bytes labelled as the archive.
  // A .tgz is already compressed, so this only ever fires on an upstream that gzips it again.
  const encoding = headers["content-encoding"];
  if (encoding !== undefined) {
    const value = (Array.isArray(encoding) ? encoding.join(",") : String(encoding)).trim();
    if (value !== "" && value.toLowerCase() !== "identity") return false;
  }
  return true;
}

/**
 * The filename at the end of a route's rest path - "pkg/-/pkg-1.0.0.tgz" gives "pkg-1.0.0.tgz".
 *
 * The value arrives already decoded: the router decodes route parameters, wildcards included.
 * Decoding it a second time was wrong twice over - a filename holding a literal "%" made
 * decodeURIComponent throw, turning a valid request into a 500 before anything was fetched, and
 * one holding "%41" quietly became "A", selecting a different cache entry than the one asked for.
 */
function extractTarballFilenameFromPath(restPath: string): string | null {
  const parts = restPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1];
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
  // This is the proxy's own download, not a relay of the caller's request, so anything but
  // a complete 200 must not reach the cache. Redirects are not followed here: their body
  // would otherwise be stored under the tarball's name and served as the archive, and a
  // forwarded Range could turn the response into a 206 fragment.
  if (!isCompleteTarballResponse(res.statusCode, res.headers as Record<string, unknown>)) {
    await res.body.dump();
    throw new UpstreamError(
      `Tarball download failed: ${res.statusCode}`,
      "status",
      res.statusCode
    );
  }
  const buffer = await readUpstreamBody(res as any);
  return await writeTarballCache(upstream.host, packageName, filename, buffer);
}

/** No hand-written package.json approaches this; anything larger is not a manifest. */
const MAX_PACKAGE_JSON_BYTES = 8 * 1024 * 1024;

async function readPackageInfoFromTarballPath(
  tarballPath: string
): Promise<{ author?: string; displayName?: string }> {
  await mkdir(TARBALL_CACHE_DIR, { recursive: true });
  const tempDir = await mkdtemp(join(TARBALL_CACHE_DIR, "extract-"));
  try {
    await tar.x({
      file: tarballPath,
      cwd: tempDir,
      // Size-bounded as well as name-bounded: the archive comes from whoever publishes the
      // package, and a package.json larger than this is not a manifest anyone wrote. Enrichment
      // is best effort, so an archive that exceeds it simply yields nothing rather than being
      // expanded onto the cache volume.
      filter: (p, entry) =>
        p === "package/package.json" && Number((entry as any)?.size ?? 0) <= MAX_PACKAGE_JSON_BYTES
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

/**
 * True when the cached archive is the one the upstream's own metadata describes. A missing
 * or non-string shasum means the upstream said nothing to check against, and the cached
 * bytes cannot be attributed to this response - the safe answer there is "no".
 */
async function cachedTarballMatchesShasum(
  upstream: UpstreamEntry,
  packageName: string,
  filename: string,
  expectedShasum: unknown
): Promise<boolean> {
  if (typeof expectedShasum !== "string" || !expectedShasum) return false;
  const cached = await readTarballCache(upstream.host, packageName, filename);
  if (!cached) return false;
  return computeSha1(cached) === expectedShasum;
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
        // The archive cache is keyed on the upstream host, the package name and the
        // filename - no group in it - so two GitLab groups publishing the same name at the
        // same version share one entry. Reading it blind would take the author and
        // displayName out of the OTHER group's archive and put them in this caller's
        // response. The shasum the upstream just told us about is what says the cached
        // bytes are the ones this response is about; without a match, fetch our own copy.
        const cachedTarball =
          (await hasTarballCache(upstream.host, packageName, filename)) &&
          (await cachedTarballMatchesShasum(
            upstream,
            packageName,
            filename,
            versionNode?.dist?.shasum
          ));
        if (!cachedTarball) {
          tarballPath = await downloadTarballToCache(
            tarballUrl,
            upstream,
            packageName,
            withoutResponseNarrowing(headersForDownload(tarballUrl, upstream, headers))
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
// Upper bound on how many rows a single upstream search may be asked for, so a caller's
// `from` cannot be turned into an unbounded request. npm's own registry caps `size` at 250.
const UPSTREAM_SEARCH_MAX_SIZE = 250;

async function handleSearch(req: any, reply: any, groupEnc: string): Promise<void> {
  const groupEncOnce = asSinglePathSegment(groupEnc);

  const text = (req.query.text ?? "").toString();
  const from = Number.parseInt((req.query.from ?? "0").toString(), 10) || 0;
  const sizeRaw = Number.parseInt((req.query.size ?? "20").toString(), 10) || 20;
  const size = Math.min(Math.max(sizeRaw, 1), 250);
  // The enumeration is an input to the merged search result, not the resource the caller asked
  // for, so their validators describe something else entirely. An `If-None-Match: *` would turn
  // the page into a bodyless 304 and fail the whole search; a Range would truncate the JSON.
  const headers = withoutResponseNarrowing(
    buildUpstreamHeadersFor(defaultUpstream, req.headers as any)
  );

  const base = `${defaultUpstream.baseUrl}/api/v4/groups/${groupEncOnce}/packages`;
  const perPage = 100;
  const maxPages = 50;
  const all: any[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const u = new URL(base);
    u.searchParams.set("package_type", "npm");
    // Push the search text upstream as well. The enumeration below is capped, and it filters
    // by text only after the cap has already been applied - so a matching package that first
    // appears past the cap is reported as "no results" rather than as truncation. Narrowing
    // the enumeration is what keeps it inside the cap. GitLab's own filter is a substring
    // match, the same as the local one, which stays as the backstop for a server that
    // ignores the parameter.
    if (text) {
      u.searchParams.set("package_name", text);
    }
    u.searchParams.set("exclude_subgroups", "false");
    u.searchParams.set("per_page", String(perPage));
    u.searchParams.set("page", String(page));
    u.searchParams.set("order_by", "name");
    u.searchParams.set("sort", "asc");

    const res = await request(u.toString(), { method: "GET", headers });

    if (res.statusCode >= 400) {
      // Bounded like every other upstream read: an error body is still a body the upstream
      // chooses the size of, and this one is copied into the response the client receives.
      const body = (await readUpstreamBody(res as any)).toString("utf-8");
      reply.code(res.statusCode).type("application/json").send({
        error: "gitlab_packages_api_failed",
        status: res.statusCode,
        body
      });
      return;
    }

    const items = await readUpstreamJson<any[]>(res as any);
    all.push(...items);
    if (items.length < perPage) break;
    if (page === maxPages) {
      // The enumeration stopped at the cap with more still available upstream, so what
      // follows describes a truncated set. Silently reporting it as complete is what made
      // a package past the cap look like it does not exist.
      req.log.info(
        { groupEnc, text, enumerated: all.length, maxPages, perPage },
        "gitlab_packages_enumeration_truncated"
      );
    }
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
          // Before anything is read, written or advertised: a VPM index lists whatever its
          // publisher put in it, and a package this upstream does not own is one the
          // metadata route will send somewhere else. Advertising it promises a package the
          // proxy will not serve, and seeding a cache entry for it under this upstream's
          // host would put that promise on disk too.
          if (selectUpstream(name).baseUrl !== upstream.baseUrl) continue;
          const versions = pkg?.versions;
          if (!versions) continue;
          const cached = await readMetadataCache(upstream.host, name);
          const cachedVersions = cached?.metadata?.versions ?? {};
          const needsPrefetch = Object.keys(versions).some((version) => {
            const cachedNode = cachedVersions?.[version];
            return !cachedNode?.dist?.shasum;
          });
          if (needsPrefetch) {
            // The lifecycle belongs to the server this request arrived at, so closing that
            // server stops the pass this triggers - and closing a different one does not.
            startVpmPrefetchForPackage(
              req.log,
              upstream,
              name,
              versions,
              vpmAuthor,
              req.server?.vpmPrefetchLifecycle
            );
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
            // No baseline on purpose. Search walks packages out of an index it has already
            // fetched, so any per-package cache read happens after that fetch and cannot tell a
            // concurrent publication from a withdrawal - using one would delete versions another
            // writer had just published. Everything on disk is kept instead, and withdrawals are
            // reconciled by the metadata route, which does read its baseline before the fetch.
            reconcileAgainstDisk(metadata, current?.metadata, undefined);
            return {
              latestVersion: pickLatestVpmVersion(metadata?.versions) ?? latestVersion,
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
      // The same number of rows on every page, deliberately not derived from `from`. The
      // merged list is sorted by name and then sliced, so what each page contains depends on
      // which rows were fetched - and fetching a different-length prefix of the upstream's
      // own (relevance) ordering per page made pages overlap and skip, with a `total` that
      // moved as the caller paged. A fixed window keeps the merged list identical for every
      // page of one search; results beyond it are not reachable, which is the same bound npm
      // registries themselves apply.
      u.searchParams.set("size", String(UPSTREAM_SEARCH_MAX_SIZE));
      const res = await request(u.toString(), {
        method: "GET",
        // Same reason as the GitLab enumeration above: this registry's answer is one input to a
        // merged result. A 304 here was swallowed by the catch below, silently dropping the
        // registry's packages from the search instead of failing.
        headers: withoutResponseNarrowing(buildUpstreamHeadersFor(upstream, req.headers as any))
      });
      const contentType = String(res.headers["content-type"] ?? "");
      if (res.statusCode >= 400 || !contentType.includes("application/json")) {
        // Skipping this upstream still means releasing its body.
        await res.body.dump();
        continue;
      }
      const payload = await readUpstreamJson<any>(res as any);
      const normalized = normalizeSearchResponse(payload);
      for (const obj of normalized.objects) {
        const pkg = obj?.package ?? obj;
        const name = String(pkg?.name ?? "");
        // Only what this upstream would actually serve. A registry configured for one scope
        // can return anything its own search matched, and advertising those names here
        // promises something the metadata route will not deliver: it routes by scope, so the
        // request goes to a different upstream and 404s. Checking with selectUpstream also
        // makes the precedence here agree with routing, instead of "whoever was merged last".
        if (!name || selectUpstream(name).baseUrl !== upstream.baseUrl) continue;
        upstreamResults.push({
          name,
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
    // Same ownership rule as the upstream results below: GitLab used to be merged last and
    // therefore won every shared name, even one routed to a configured registry - so search
    // could advertise a version the metadata route would never serve.
    if (!item.name || selectUpstream(item.name).baseUrl !== defaultUpstream.baseUrl) continue;
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
 * Re-encodes a decoded rest path segment by segment, for the case where the raw path could not be
 * recovered. Interpolating the decoded value itself is what the recovery exists to avoid: a "#" or
 * "?" in it silently truncates the upstream path. Segment boundaries are preserved, so a scoped
 * name stays two segments and every other character is escaped.
 */
function encodeRestSegments(decodedRest: string): string {
  return decodedRest
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * The still-encoded portion of the request path after its first `skip` segments.
 *
 * Route parameters arrive decoded, and interpolating a decoded path back into an upstream URL
 * changes which resource is asked for: a name holding "%23" comes back as "#", so URL parsing
 * treats the rest as a fragment and the upstream sees a shorter path; "%3F" becomes a query
 * delimiter the same way. Forwarding the bytes the caller actually sent avoids having to decide
 * how to re-encode anything - the decoded values stay in use for routing and cache lookup.
 */
function rawRestFromRequest(req: any, decodedRest: string): string | null {
  const raw =
    typeof req?.raw?.url === "string" ? req.raw.url : typeof req?.url === "string" ? req.url : "";
  // Empty segments are kept: a trailing or doubled slash is part of the path the router
  // matched, and dropping it made the comparison below fail for every such request - which
  // sent the caller to the fallback, and the fallback is the decoded path this whole helper
  // exists to avoid forwarding.
  const rawSegments = pathWithoutQuery(raw).replace(/^\/+/, "").split("/");
  const target = decodedRest.replace(/^\/+/, "");
  if (target === "") return null;
  // Found by decoding, not by counting. Neither a fixed number of leading segments (which assumes
  // the routes are mounted exactly where they are today) nor a matching count of trailing ones
  // works: an encoded slash makes one raw segment decode into two, so "%40scope%2Fpkg" is one
  // segment in the URL and two in the value the router hands over. The shortest trailing run whose
  // decoding is the rest path is the rest path, wherever the routes are mounted and whatever the
  // caller encoded.
  for (let take = 1; take <= rawSegments.length; take++) {
    const candidate = rawSegments.slice(rawSegments.length - take);
    let decoded: string;
    try {
      decoded = candidate.map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      // Not valid percent-encoding, so it cannot be the decoded value the router produced.
      continue;
    }
    if (decoded === target) return candidate.join("/");
  }
  return null;
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
    // Segments arrive decoded, so a scoped name occupies two of them and must not be decoded
    // again: "@scope%2Fpkg" reaches here as "@scope/pkg", and decoding a name holding a literal
    // "%" threw outright.
    const parts = normalizedRest.split("/").filter(Boolean);
    const rest = parts.slice(1);
    const dashIndex = rest.indexOf("-");
    if ((dashIndex === 1 || (dashIndex === 2 && (rest[0] ?? "").startsWith("@"))) && rest.length > dashIndex + 1) {
      const decodedName = rest.slice(0, dashIndex).join("/");
      // Everything after the separator, not just the next segment: the filename of a scoped
      // package carries the scope too, so it spans two segments once the router has decoded the
      // slash. Taking one segment left "@scope" as the whole filename and the request fell
      // through to the ordinary npm upstream.
      const decodedFile = rest.slice(dashIndex + 1).join("/");
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
    // Same decoding boundary as the npm/ branch above: the segments are already decoded, and a
    // scoped name spans two of them.
    const parts = normalizedRest.split("/").filter(Boolean);
    const rest = parts.slice(1);
    const scoped = (rest[0] ?? "").startsWith("@") && rest.length >= 3;
    const decodedName = scoped ? `${rest[0]}/${rest[1]}` : (rest[0] ?? "");
    // Same reason as the npm/ branch: this form also accepts a full filename in place of a bare
    // version, and a scoped one spans two segments.
    const decodedFile = rest.slice(scoped ? 2 : 1).join("/");
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
  // The same rest path, in the encoding the caller sent rather than the decoded copy used for
  // routing above.
  const rawRest = rawRestFromRequest(req, normalizedRest) ?? encodeRestSegments(normalizedRest);
  const upstreamUrl = appendRawQuery(
    getUpstreamBaseForGroup(upstream, groupEnc, rawRest),
    req
  );

  if (upstream.type === "vpm") {
    if (!packageName) {
      reply.code(404).send();
      return;
    }

    try {
      // Read before the index fetch, not after: that request is slow enough for another
      // writer to publish a version while it is in flight, and a version that appears on
      // disk after this point must not be mistaken for one the upstream withdrew.
      const baselineCache = await readMetadataCache(upstream.host, packageName);
      const index = await fetchVpmIndex(upstream, buildUpstreamHeadersFor(upstream, req.headers as any));
      const vpmAuthor = index.author;
      // An index without a usable `packages` map says nothing about what the upstream
      // still publishes - it is a malformed or truncated document, and fetchVpmIndex only
      // checks the status code and content type. Treating it as "everything is withdrawn"
      // would delete the whole package, archives included, on a 200 carrying `{}`.
      if (!isPlainObject(index.packages)) {
        // ...and it is not an absence either, so it must not be reported as one. A 200 carrying
        // "{}" means the registry answered without saying anything usable, which is a failure on
        // its side, not a package that is gone. Nothing cached is deleted here.
        throw new UpstreamError("vpm_index_malformed:packages", "status");
      }
      const listed = Object.prototype.hasOwnProperty.call(index.packages, packageName);
      const listedVersions = listed ? (index.packages as any)[packageName]?.versions : undefined;
      if (listed && !isPlainObject(listedVersions)) {
        // The index does name this package but the entry is unusable. That says the document is
        // malformed, not that the package was withdrawn, so nothing is removed - and not that it
        // is absent either, so the answer is a gateway failure rather than a 404.
        throw new UpstreamError("vpm_index_malformed:versions", "status");
      }
      const versions = listedVersions as Record<string, any> | undefined;
      if (!versions) {
        // Same rule as for individual versions: only what the baseline knew about may be
        // treated as withdrawn. Versions that appeared on disk after this request read the
        // cache were published by another writer, whose index is at least as fresh as the
        // one read here, so they survive - and the package as a whole is only removed once
        // nothing is left.
        if (baselineCache) {
          await removeWithdrawnPackage(upstream, packageName, baselineCache.metadata);
        }
        reply.code(404).send();
        return;
      }

      const latestVersion = pickLatestVpmVersion(versions);
      const cached = await readMetadataCache(upstream.host, packageName);
      if (cached && latestVersion && cached.latestVersion === latestVersion) {
        const response = JSON.parse(JSON.stringify(cached.metadata));
        // The cached copy is served as-is on this branch, so this is the only place that can
        // notice a withdrawal which left the latest version untouched: without it, a version
        // the upstream removed keeps being advertised for as long as `latest` stays put.
        dropVersionsWithdrawnFromIndex(response, versions, baselineCache?.metadata);
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
          await refreshCachedVpmMetadata(upstream, packageName, response, baselineCache?.metadata);
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
      // Unconditional on purpose. An index that lists the package with an empty versions map
      // is a valid statement - everything was withdrawn - and pickLatestVpmVersion returns
      // null for it. Skipping the refresh there left every cached version on disk, so the
      // withdrawal was reported to the caller but never reconciled, for good.
      //
      // baselineCache, not cachedForMerge: the baseline has to predate the index fetch, or a
      // version published while that request was in flight looks like a withdrawal.
      await refreshCachedVpmMetadata(upstream, packageName, metadata, baselineCache?.metadata);

      reply.code(200);
      reply.header("cache-control", "no-cache");
      reply.type("application/json").send(stripVpmOriginal(filterMetadataByShasum(metadata)));
      return;
    } catch (err) {
      // Not 404: nothing here established that the package is absent. The index fetch failing, a
      // body over the ceiling or a conversion error are all failures to answer, and saying "not
      // found" invites the client - and any cache between - to believe the package is gone.
      req.log.info({ err, packageName }, "vpm_metadata_failed");
      reply.code(failureStatus(err)).send();
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
      // Asked before a byte is served: a valid token is not the same as permission to see this
      // package, and the cache is keyed on neither the group nor the caller.
      const allowed = await callerMayReadCachedPackage(
        req,
        reply,
        upstream,
        getUpstreamBaseForGroup(upstream, groupEnc, encodeRestSegments(packageName))
      );
      if (!allowed) return;
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
    // A tarball is relayed byte for byte, so the caller's validators describe the same
    // representation the upstream holds and belong on that request. Metadata does not: the proxy
    // rewrites tarball URLs and re-serializes it, so an upstream 304 would say nothing about
    // whether the document this proxy renders has changed. Asking unconditionally is the only
    // answer that is actually true.
    headers: isTarball
      ? buildUpstreamHeadersFor(upstream, req.headers as any)
      : withoutResponseNarrowing(buildUpstreamHeadersFor(upstream, req.headers as any)),
    body: body as any
  });
  const contentType = String(res.headers["content-type"] ?? "");

  if (res.statusCode === 404 && packageName) {
    await deletePackageCache(upstream, packageName);
  }

  // A HEAD response carries the JSON content type but no body, so parsing it throws and the
  // caller gets a 500 for a request the upstream answered perfectly well. Status and headers
  // are all a HEAD can return anyway - and the same holds for any status defined to carry no
  // body: a client's If-None-Match is forwarded, so a successful revalidation comes back as
  // a bodyless 304 with the JSON content type still on it.
  if (method === "HEAD" || isBodylessStatus(res.statusCode)) {
    await res.body.dump();
    reply.code(res.statusCode);
    applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, true);
    reply.send();
    return;
  }

  if (contentType.includes("application/json")) {
    const json = await readUpstreamJson<any>(res as any);

    if (json && typeof json === "object" && json.versions && typeof json.versions === "object") {
      if (packageName) {
        const latestVersion = getLatestVersionFromMetadata(json);
        // The response GitLab just authorized for THIS caller is the only thing that may be
        // served. Returning the cached document instead - which is what a matching latest
        // version used to trigger - crosses group boundaries: the cache is keyed on the
        // upstream host and the package name, with no group in it, so two groups holding a
        // package of the same name at the same latest version share one entry, and whoever
        // populated it first decided what everyone else sees. It also hid every change that
        // left `latest` alone, a new prerelease or a removed version among them. Only the
        // dist fields the proxy itself computed are carried over, below.
        const cached = await readMetadataCache(upstream.host, packageName);

        // Enrichment only fills in author and displayName from inside the tarball, so a
        // failure here must not take the metadata response with it. It downloads the
        // archive to do that, and everything about that download can fail for reasons that
        // say nothing about the metadata: the upstream answers with a redirect (which this
        // proxy will not follow and will not cache), the host is unreachable, the archive
        // is not readable as a tar. Before this was caught, any of those turned a perfectly
        // good metadata response into a 500.
        //
        // Headers for the upstream that owns this package, not the default one: the
        // enrichment step may download the tarball, and a header set built for the default
        // upstream would carry the caller's credentials to another registry.
        try {
          await mergeMetadataIfNeeded(
            json,
            packageName,
            upstream,
            buildUpstreamHeadersFor(upstream, req.headers as any)
          );
        } catch (err) {
          req.log.info({ err, packageName }, "metadata_enrichment_failed");
        }

        // After enrichment, not before it. The archive cache has no group in its key, so
        // enrichment decides whether a cached archive belongs to this response by comparing
        // it against the shasum the UPSTREAM reported. Merging the cached shasum in first
        // put another group's checksum there for a version the upstream did not hash, and
        // the comparison then matched that group's archive - defeating the check entirely.
        if (cached?.metadata) {
          mergeShasumFromCache(json, cached.metadata);
        }

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
  const buffer = await readUpstreamBody(res as any);
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

  // The whole wildcard is the filename here, already decoded by the router: the public tarball
  // URL puts the entire name into one encoded segment. Splitting it on "/" and taking the last
  // part dropped the scope of a scoped package - "@scope/pkg-1.0.0.tgz" was resolved as "pkg" and
  // answered 404 even with the right archive cached.
  const decodedFile = normalizedRest;
  const base = decodedFile.slice(0, -4);
  const split = await resolveTarballBasename(base, req.log);
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

/** The endpoint this route stands for, whatever path the application is mounted under. */
const PERSONAL_ACCESS_TOKEN_SELF_PATH = "/api/v4/personal_access_tokens/self";

async function proxyDefaultGitlabApi(req: any, reply: any): Promise<void> {
  // Built from the endpoint, not from the incoming URL: concatenating the raw URL sent GitLab the
  // application's own mount prefix as part of its API path, so the request went nowhere real.
  const upstreamUrl = appendRawQuery(
    `${defaultUpstream.baseUrl}${PERSONAL_ACCESS_TOKEN_SELF_PATH}`,
    req
  );
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : (req.body as any);

  const res = await request(upstreamUrl, {
    method,
    headers: buildUpstreamHeadersFor(defaultUpstream, req.headers as any),
    body: body as any
  });

  reply.code(res.statusCode);
  applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, false);
  if (method === "HEAD" || isBodylessStatus(res.statusCode)) {
    reply.send();
    return;
  }
  const buffer = await readUpstreamBody(res as any);
  reply.send(buffer);
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    // Path only. Tarball URLs carry whatever query the upstream signed them with, and the
    // proxy now deliberately preserves it end to end - so logging the URL verbatim wrote a
    // working download credential into the application log on every request.
    req.log.info({ method: req.method, path: pathWithoutQuery(req.url) }, "req_in");
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

        // Forwarded in the encoding the caller sent, for the same reason as the group route.
        const rawRest = rawRestFromRequest(req, restPath) ?? encodeRestSegments(restPath);
        const upstreamUrl = appendRawQuery(
          `${defaultUpstream.baseUrl}/api/v4/projects/${asSinglePathSegment(projectId)}/packages/npm/${rawRest}`,
          req
        );
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
            // Same question as the group route: this cache entry is not evidence that this caller
            // is allowed to have it.
            const allowed = await callerMayReadCachedPackage(
              req,
              reply,
              defaultUpstream,
              `${defaultUpstream.baseUrl}/api/v4/projects/${asSinglePathSegment(projectId)}/packages/npm/${encodeRestSegments(packageName)}`
            );
            if (!allowed) return;
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

        // Same split as the group route: conditionals belong on a byte-for-byte tarball relay,
        // not on metadata the proxy re-renders.
        const res = await request(upstreamUrl, {
          method,
          headers: isTarball ? headers : withoutResponseNarrowing(headers),
          body: body as any
        });
        const contentType = String(res.headers["content-type"] ?? "");

        // Same as the group route: a HEAD, and any status defined to carry no body, arrive
        // with the JSON content type and nothing to parse - turning a perfectly good
        // upstream answer into a 500.
        if (method === "HEAD" || isBodylessStatus(res.statusCode)) {
          await res.body.dump();
          reply.code(res.statusCode);
          applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, true);
          reply.send();
          return;
        }

        if (contentType.includes("application/json")) {
          const json = await readUpstreamJson<any>(res as any);

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
        const buffer = await readUpstreamBody(res as any);
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
