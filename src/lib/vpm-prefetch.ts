import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as tar from "tar";
import * as semver from "semver";
import { getTarballCachePath, readMetadataCache, updateMetadataCache, type MetadataCache } from "./cache";
import { applyPackageSignature, hasProxySignature } from "./npm-signatures";
import { getUpstreamConfig, matchScope, UpstreamEntry } from "./upstreams";
import { mustEnv } from "./env";
import { computeSha1, convertZipBufferToTgzUnlocked, runTempLocked } from "./tgz";
import { fetchBufferWithRedirects, fetchJsonWithRedirects } from "./http";

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

// Prefetch runs in the background, outside any request, so nothing awaits it and nothing used
// to stop it: closing the server left it downloading archives and writing them into a cache
// directory the process was done with, and its pacing timer kept the process alive on its own.
// The flag below is the shutdown signal; every loop checks it between items, and a pass in its
// pacing sleep is woken immediately rather than waited out.
//
// The state belongs to one server, not to the process. A first attempt kept it in module-level
// variables, which meant closing one server stopped a second one built in the same process, and
// starting the second cleared the first one's stop. Each application registration creates its own
// lifecycle and stops that one.
export type PrefetchLifecycle = {
  stopping: boolean;
  sleeps: Set<{ cancel: () => void }>;
  passes: Set<Promise<unknown>>;
  running: Set<string>;
};

export function createPrefetchLifecycle(): PrefetchLifecycle {
  return { stopping: false, sleeps: new Set(), passes: new Set(), running: new Set() };
}

// Used by callers that drive a pass directly and own its completion themselves - the tests that
// await prefetchForUpstream, and the fallback below when no lifecycle was threaded through. It is
// never stopped, which is correct for a pass whose caller is already waiting for it.
const detachedLifecycle = createPrefetchLifecycle();

/** True once shutdown started, so a loop can stop between items instead of mid-write. */
function stopRequested(lifecycle: PrefetchLifecycle): boolean {
  return lifecycle.stopping;
}

function sleep(ms: number, lifecycle: PrefetchLifecycle): Promise<void> {
  if (lifecycle.stopping) return Promise.resolve();
  return new Promise((resolve) => {
    const entry = { cancel: () => {} };
    const done = () => {
      lifecycle.sleeps.delete(entry);
      resolve();
    };
    const timer = setTimeout(done, ms);
    // Pacing between downloads is not a reason to hold the process open.
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    entry.cancel = () => {
      clearTimeout(timer);
      done();
    };
    lifecycle.sleeps.add(entry);
  });
}

/**
 * Waits out the pacing interval and reports whether the pass may go on. Cancelling a sleep
 * resolves it normally, so without the check here shutdown woke the pass straight into the
 * download it was pausing before - closing an idle, sleeping prefetch started one more download
 * and made close() wait for it.
 */
async function pacedContinue(ms: number, lifecycle: PrefetchLifecycle): Promise<boolean> {
  if (ms > 0) await sleep(ms, lifecycle);
  return !stopRequested(lifecycle);
}

/** Tracks a background pass so shutdown can wait for the critical section it is inside. */
function track<T>(lifecycle: PrefetchLifecycle, pass: Promise<T>): Promise<T> {
  lifecycle.passes.add(pass);
  void pass.catch(() => {}).finally(() => lifecycle.passes.delete(pass));
  return pass;
}

/**
 * Stops one server's background prefetch and waits for whatever it is in the middle of. Called
 * from that application's onClose hook, so a closed server leaves nothing writing behind it.
 * Publication is already atomic and holds a per-package lock, so waiting here is what keeps a
 * half-finished conversion from being abandoned rather than completed.
 *
 * The wait is bounded: passes only shrink the set (no new one starts while stopping), so a couple
 * of rounds settle it, and the cap keeps a wedged pass from blocking shutdown forever.
 */
export async function stopVpmPrefetch(lifecycle: PrefetchLifecycle): Promise<void> {
  lifecycle.stopping = true;
  for (const entry of Array.from(lifecycle.sleeps)) entry.cancel();
  for (let round = 0; round < 5 && lifecycle.passes.size > 0; round++) {
    await Promise.allSettled(Array.from(lifecycle.passes));
  }
}

// Redirects are followed here for the same reason as on the request path: undici does not
// follow them, so an index URL answered with a 301 had its redirect body parsed as the index.
// The prefetch carries no caller headers, so there is nothing to strip - the shared helper still
// drops credentials on a cross-origin hop if that ever changes.
async function fetchVpmIndex(upstream: UpstreamEntry): Promise<VpmIndex> {
  return fetchJsonWithRedirects<VpmIndex>(getVpmIndexUrl(upstream), {}, "vpm_index_failed");
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

// Called when an archive was published and the metadata describing it could not be written,
// so the archive has just been deleted again. Restoring the version's previous dist would be
// wrong: on a rebuild, the rename already replaced the archive those fields described, and
// nothing on disk matches them any more. Everything that makes the version look available is
// stripped instead, in the local snapshot and - best effort - in the persisted metadata, so
// the version is filtered out of responses until it is fetched again. Neither the response
// filter nor the signature reuse check would notice otherwise: one only looks for a shasum,
// the other only at the keyid.
async function clearVersionAvailability(
  upstream: UpstreamEntry,
  packageName: string,
  version: string,
  node: any
): Promise<void> {
  if (node?.dist) {
    delete node.dist.shasum;
    delete node.dist.integrity;
    delete node.dist.signatures;
  }
  try {
    await updateMetadataCache(upstream.host, packageName, (current) => {
      const dist = current?.metadata?.versions?.[version]?.dist;
      if (!dist) return null;
      delete dist.shasum;
      delete dist.integrity;
      delete dist.signatures;
      return current!;
    });
  } catch {
    // The write that failed a moment ago may well fail again; the local snapshot is
    // already clean, which is what keeps this pass from publishing the version.
  }
}

// Re-runs, under the lock, the same question that was answered before it: does this archive
// still have to be built? Another writer may have published it, or injected the author into
// it, while this pass was downloading. Rebuilding on top of that would replace a published
// archive with different bytes.
async function stillNeedsConversion(
  tgzPath: string,
  node: any,
  vpmAuthor: unknown
): Promise<boolean> {
  const exists = await stat(tgzPath).then(() => true).catch(() => false);
  if (!exists) return true;
  if (node?.author || !vpmAuthor) return false;
  const currentAuthor = await readAuthorFromTgz(tgzPath);
  return !currentAuthor;
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
      // See the same loop in src/routes/gitlab-npm-proxy.ts: minVersion throws on a range it
      // cannot parse. Here the exception escaped the package loop as well, so one bad
      // dependency stopped the pass from processing every package after it.
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

// Insert-only counterpart of mergeVersionsInto: leaves every version already present on
// disk exactly as it is. Used for the final flush, whose source is the snapshot this pass
// read at the start. Versions this pass actually processed have been merged one by one
// already; replacing the rest wholesale would undo whatever another writer (a request
// serving the tarball, or another prefetch) stored while this pass was running - dropping
// the shasum and signature it had just written, which in turn hides the version from
// filtered metadata.
function insertMissingVersionsInto(target: any, versionNodes: Record<string, any>): void {
  target.versions = target.versions && typeof target.versions === "object" ? target.versions : {};
  for (const [version, node] of Object.entries(versionNodes)) {
    if (target.versions[version] === undefined) {
      target.versions[version] = node;
    }
  }
}

// Exported (like prefetchForPackage below) so tests can await one full pass over an
// upstream deterministically, instead of polling the fire-and-forget background task.
export async function prefetchForUpstream(
  upstream: UpstreamEntry,
  intervalMs: number,
  log: { info: (obj: any, msg?: string) => void },
  lifecycle: PrefetchLifecycle = detachedLifecycle
): Promise<void> {
  const index = await fetchVpmIndex(upstream);
  const vpmAuthor = index.author;
  const packages = index.packages ?? {};
  const metadataByPackage = new Map<string, any>();

  for (const [name, pkg] of Object.entries(packages)) {
    if (stopRequested(lifecycle)) return;
    if (!shouldIncludePackage(name, upstream.scopes)) continue;
    const versions = pkg?.versions;
    if (!versions) continue;
    const cached = await readMetadataCache(upstream.host, name);
    const fresh = buildNpmMetadataFromVpm(name, versions);
    const metadata = cached?.metadata ?? fresh;
    if (cached?.metadata) {
      // Same merge prefetchForPackage does. Taking the cached snapshot alone means the
      // work list below only ever contains versions that were already cached, so a version
      // published since the last run is never fetched here. It then has no shasum, gets
      // filtered out of every metadata response, and stays invisible until a search request
      // happens to trigger the per-package prefetch. Merging is insert-only for existing
      // nodes, so the signing fields already on disk are preserved.
      mergeMissingVersions(metadata, fresh);
    }
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
      if (stopRequested(lifecycle)) return;
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
      // The zip download stays outside the lock - it is the slow part and needs nothing
      // from the cache directory.
      let zipBuffer: Buffer | null = null;
      if (needsDownload) {
        if (!(await pacedContinue(intervalMs, lifecycle))) return;
        try {
          zipBuffer = await fetchBufferWithRedirects(sourceUrl);
        } catch (err) {
          log.info({ err, packageName: name, version }, "vpm_prefetch_skip");
          continue;
        }
      }
      // Converting the archive, hashing it and publishing what that hash describes is one
      // change from a client's point of view, so it is one critical section. Releasing the
      // lock between the conversion's rename and the metadata write would let a reader
      // observe the new archive beside the old signature. Comparing against the previous
      // shasum, on its own, only catches an archive that changed BEFORE the read.
      // convertZipBufferToTgzUnlocked is used because the lock is not reentrant.
      try {
        await runTempLocked(dirname(tgzPath), async () => {
          // needsDownload was decided before the lock, and the download since then is slow
          // enough for another writer to have published this version. Rebuilding on top of
          // that would replace a published archive with different bytes (author injection
          // rewrites package.json, so two conversions do not agree byte for byte), leaving
          // a client that already has the first archive's metadata unable to verify the
          // second one.
          const converted = zipBuffer !== null && (await stillNeedsConversion(tgzPath, node, vpmAuthor));
          if (converted) {
            await convertZipBufferToTgzUnlocked(zipBuffer!, tgzPath, vpmAuthor);
            log.info({ packageName: name, version }, "vpm_prefetch_done");
          }
          // See prefetchForPackage: once the new archive is published, a failure to write
          // the metadata that describes it would leave the cache serving those bytes under
          // the previous signature, with nothing to repair it later. Drop the archive on
          // that path instead - and strip what makes this version look available, because
          // the final flush at the end of the pass would otherwise publish signing fields
          // for an archive that no longer exists.
          try {
          const tgzBuffer = await readFile(tgzPath);
          const previousShasum = node.dist.shasum;
          node.dist.shasum = computeSha1(tgzBuffer);
          // See prefetchForPackage: the cached signature may only be reused when the
          // archive was neither rebuilt by this pass nor changed underneath it.
          if (converted || previousShasum !== node.dist.shasum || !hasProxySignature(node.dist)) {
            applyPackageSignature(name, version, tgzBuffer, node.dist);
          }
          applyAuthorIfMissing(node, vpmAuthor);
          // Re-read the cache under the metadata lock instead of blindly writing our
          // locally-built `metadata` snapshot: another writer may have updated a DIFFERENT
          // version's dist fields on disk since we last read. Merge in only the version we
          // just processed.
          await updateMetadataCache(upstream.host, name, (current) => {
              const target = current?.metadata ?? metadata;
              if (target !== metadata) {
                mergeVersionsInto(target, { [version]: node });
              }
              return buildMetadataCacheEntry(target);
            });
          } catch (err) {
            if (converted) {
              await rm(tgzPath, { force: true }).catch(() => {});
              await clearVersionAvailability(upstream, name, version, node);
            }
            throw err;
          }
        });
      } catch (err) {
        log.info({ err, packageName: name, version }, "vpm_prefetch_skip");
        continue;
      }
    }
  }

  // Final flush: make sure every package seen in the index has a cache entry, including
  // packages whose versions were all skipped. Insert-only, so it never overwrites a
  // version node that is already on disk.
  for (const [name, metadata] of metadataByPackage.entries()) {
    await updateMetadataCache(upstream.host, name, (current) => {
      const target = current?.metadata ?? metadata;
      if (target !== metadata) {
        insertMissingVersionsInto(target, metadata.versions ?? {});
      }
      return buildMetadataCacheEntry(target);
    });
  }
}

// Exported (in addition to startVpmPrefetchForPackage) so tests can await a single
// prefetch pass directly instead of polling the background fire-and-forget task started
// by startVpmPrefetchForPackage for completion.
export async function prefetchForPackage(
  upstream: UpstreamEntry,
  packageName: string,
  versions: Record<string, any>,
  vpmAuthor: unknown,
  intervalMs: number,
  log: { info: (obj: any, msg?: string) => void },
  lifecycle: PrefetchLifecycle = detachedLifecycle
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
    if (stopRequested(lifecycle)) return;
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
    // The download stays outside the lock: it is the slow part and needs nothing from the
    // cache directory.
    let zipBuffer: Buffer | null = null;
    if (needsDownload) {
      if (!(await pacedContinue(intervalMs, lifecycle))) return;
      try {
        zipBuffer = await fetchBufferWithRedirects(sourceUrl);
      } catch (err) {
        log.info({ err, packageName, version }, "vpm_prefetch_skip");
        continue;
      }
    }
    // Convert, hash and publish as one critical section, under the same per-directory lock
    // the conversion takes on its own: releasing it between the conversion's rename and the
    // metadata write would let a reader see the new archive beside the old signature. The
    // unlocked conversion helper is used because the lock is not reentrant.
    try {
      await runTempLocked(dirname(tgzPath), async () => {
        // See prefetchForUpstream: needsDownload was decided before the lock, and another
        // writer may have published this version while the download ran. Rebuilding over it
        // would replace a published archive with different bytes.
        const converted = zipBuffer !== null && (await stillNeedsConversion(tgzPath, node, vpmAuthor));
        if (converted) {
          await convertZipBufferToTgzUnlocked(zipBuffer!, tgzPath, vpmAuthor);
          log.info({ packageName, version }, "vpm_prefetch_done");
        }
        // From here on the new archive is already published. If the metadata write fails -
        // the disk filling up while the temp JSON is created, say - the cache would be left
        // serving these bytes under the previous signature, and nothing repairs that later:
        // the signature reuse check passes because the keyid still matches. Dropping the
        // archive on that path is the safe outcome; the next request fetches it again.
        try {
        const tgzBuffer = await readFile(tgzPath);
        const previousShasum = node.dist.shasum;
        node.dist.shasum = computeSha1(tgzBuffer);
        // The signature must always describe the bytes just hashed. Reusing the cached one
        // is only correct when nothing about the archive moved: this pass did not rebuild
        // it (needsDownload), the hash still matches what the snapshot carried, and it is
        // signed under the current key. A differing hash means someone else rebuilt the
        // archive before this read - keeping the old integrity there would publish a hash
        // of an archive nobody serves any more, and every client would reject the download.
        if (converted || previousShasum !== node.dist.shasum || !hasProxySignature(node.dist)) {
          applyPackageSignature(packageName, version, tgzBuffer, node.dist);
        }
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
        } catch (err) {
          if (converted) {
            await rm(tgzPath, { force: true }).catch(() => {});
            // Same as prefetchForUpstream: this pass keeps going to the next version, and
            // the fallback write there takes the whole local snapshot when the cache is
            // still absent - which would publish this version's signing fields for an
            // archive that has just been deleted.
            await clearVersionAvailability(upstream, packageName, version, node);
          }
          throw err;
        }
      });
    } catch (err) {
      log.info({ err, packageName, version }, "vpm_prefetch_skip");
      continue;
    }
  }
}

async function prefetchVpmShasums(
  log: { info: (obj: any, msg?: string) => void },
  lifecycle: PrefetchLifecycle
): Promise<void> {
  const config = getUpstreamConfig();
  const upstreams = [config.default, ...config.upstreams].filter((u) => u.type === "vpm");
  if (upstreams.length === 0) return;

  const intervalSec = parseFloatEnv("VPM_PREFETCH_INTERVAL_SEC");
  const intervalMs = Math.max(0, intervalSec * 1000);

  for (const upstream of upstreams) {
    if (stopRequested(lifecycle)) return;
    log.info({ host: upstream.host }, "vpm_prefetch_start");
    await prefetchForUpstream(upstream, intervalMs, log, lifecycle);
    log.info({ host: upstream.host }, "vpm_prefetch_complete");
  }
}

export function startVpmPrefetch(
  log: { info: (obj: any, msg?: string) => void },
  lifecycle: PrefetchLifecycle
): void {
  track(
    lifecycle,
    (async () => {
      try {
        await prefetchVpmShasums(log, lifecycle);
      } catch (err) {
        log.info({ err }, "vpm_prefetch_failed");
      }
    })()
  );
}

export function startVpmPrefetchForPackage(
  log: { info: (obj: any, msg?: string) => void },
  upstream: UpstreamEntry,
  packageName: string,
  versions: Record<string, any>,
  vpmAuthor: unknown,
  lifecycle: PrefetchLifecycle = detachedLifecycle
): void {
  // Unlike startVpmPrefetch this is triggered by a request, not by startup, so it must not
  // revive a prefetch the shutdown just stopped.
  if (stopRequested(lifecycle)) return;
  const key = `${upstream.host}|${packageName}`;
  // Dedupe is per lifecycle for the same reason the stop signal is: two servers in one process
  // have separate caches of in-flight work as far as their own shutdown is concerned.
  if (lifecycle.running.has(key)) return;
  lifecycle.running.add(key);
  track(
    lifecycle,
    (async () => {
      try {
        const intervalSec = parseFloatEnv("VPM_PREFETCH_INTERVAL_SEC");
        const intervalMs = Math.max(0, intervalSec * 1000);
        await prefetchForPackage(
          upstream,
          packageName,
          versions,
          vpmAuthor,
          intervalMs,
          log,
          lifecycle
        );
      } catch (err) {
        log.info({ err, packageName }, "vpm_prefetch_failed");
      } finally {
        lifecycle.running.delete(key);
      }
    })()
  );
}
