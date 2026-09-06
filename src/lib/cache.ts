import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mustEnv } from "./env";

const CACHE_DIR = mustEnv("TARBALL_CACHE_DIR");

export type MetadataCache = {
  latestVersion: string;
  author?: string;
  displayName?: string;
  metadata: any;
};

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

// Writes JSON to `path` atomically: the content lands in a uniquely-named temp file in
// the same directory first, then an fs rename publishes it at `path`. A reader can never
// observe a partially written file this way (rename is atomic within one filesystem).
async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
    await rename(tempPath, path);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

type LockRunner = <T>(key: string, fn: () => Promise<T>) => Promise<T>;

// Per-key async lock table, used to serialize metadata cache read-modify-write cycles
// for the same (upstreamHost, packageName) pair. Mirrors the shape of
// src/lib/tgz.ts's createTempLockRunner, but stores the exact chained promise it later
// compares against so table entries are actually removed once the holder releases
// (tgz.ts's original version compared against a different object and leaked entries).
//
// The table lives in this process's memory, so the serialization it provides is
// in-process only: two processes pointed at the same TARBALL_CACHE_DIR can still
// interleave their read-modify-write cycles and lose one of the two updates. The proxy
// is written for a single writer per cache directory (see PROJECT_MAP.md, "並行性の前提").
// Sharing one cache directory across processes would need a filesystem-level lock here.
function createLockRunner(): LockRunner {
  const locks = new Map<string, Promise<void>>();

  return async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    let release = () => {};
    const next = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const chained = prev.then(() => next);
    locks.set(key, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(key) === chained) {
        locks.delete(key);
      }
    }
  };
}

const runMetadataLocked: LockRunner = createLockRunner();

function metadataLockKey(upstreamHost: string, packageName: string): string {
  return `${upstreamHost}|${packageName}`;
}

export function getUpstreamCacheDir(upstreamHost: string): string {
  return join(CACHE_DIR, upstreamHost.replace(/:/g, "_"));
}

// encodeURIComponent leaves "." and ".." untouched, so a package name that decodes to a
// dot segment would not stay inside its own directory: join() normalizes it away and
// getPackageCacheDir would hand back the upstream directory (or CACHE_DIR itself for a
// scoped-looking "..\/.."). Every filesystem helper in this module routes through
// getPackageCacheDir, so rejecting the name here closes the whole class at once -
// including the recursive delete the routes layer performs on an upstream 404, which
// would otherwise wipe the cache and the signing key stored next to it. Names that only
// *contain* dots or slashes are fine: encodeSegment escapes the separators, leaving a
// single (odd-looking but harmless) directory name.
export function isSafePackageName(packageName: string): boolean {
  if (!packageName) return false;
  const encoded = encodeSegment(packageName);
  return encoded !== "." && encoded !== "..";
}

export function getPackageCacheDir(upstreamHost: string, packageName: string): string {
  if (!isSafePackageName(packageName)) {
    throw new Error(`Unsafe package name for cache path: ${JSON.stringify(packageName)}`);
  }
  return join(getUpstreamCacheDir(upstreamHost), encodeSegment(packageName));
}

export function getMetadataCachePath(upstreamHost: string, packageName: string): string {
  return join(getPackageCacheDir(upstreamHost, packageName), "metadata.json");
}

export async function readMetadataCache(
  upstreamHost: string,
  packageName: string
): Promise<MetadataCache | null> {
  const path = getMetadataCachePath(upstreamHost, packageName);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as MetadataCache;
  } catch {
    return null;
  }
}

export async function writeMetadataCache(
  upstreamHost: string,
  packageName: string,
  cache: MetadataCache
): Promise<void> {
  const path = getMetadataCachePath(upstreamHost, packageName);
  await writeJsonAtomic(path, cache);
}

// Package-scoped read-modify-write: takes the per-package lock, re-reads the metadata
// cache from disk (picking up whatever the most recent writer left, not a stale
// snapshot the caller may have read earlier), lets `mutate` derive the next value from
// that fresh read, and writes it back atomically. Returning null from `mutate` skips the
// write entirely (used when the fresh read shows there is nothing left to update).
//
// Callers must keep network requests and tgz conversion OUTSIDE of `mutate` — it should
// only do the (fast) work of merging fields into the freshly read value and the disk
// write itself, so the lock is held for as short a time as possible.
export async function updateMetadataCache(
  upstreamHost: string,
  packageName: string,
  mutate: (current: MetadataCache | null) => MetadataCache | null | Promise<MetadataCache | null>
): Promise<void> {
  await runMetadataLocked(metadataLockKey(upstreamHost, packageName), async () => {
    const current = await readMetadataCache(upstreamHost, packageName);
    const next = await mutate(current);
    if (next === null) return;
    const path = getMetadataCachePath(upstreamHost, packageName);
    await writeJsonAtomic(path, next);
  });
}

export async function deleteMetadataCache(
  upstreamHost: string,
  packageName: string
): Promise<void> {
  const path = getMetadataCachePath(upstreamHost, packageName);
  await rm(path, { force: true });
}

export function getTarballCachePath(
  upstreamHost: string,
  packageName: string,
  filename: string
): string {
  return join(getPackageCacheDir(upstreamHost, packageName), encodeSegment(filename));
}

export async function hasTarballCache(
  upstreamHost: string,
  packageName: string,
  filename: string
): Promise<boolean> {
  const path = getTarballCachePath(upstreamHost, packageName, filename);
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function readTarballCache(
  upstreamHost: string,
  packageName: string,
  filename: string
): Promise<Buffer | null> {
  const path = getTarballCachePath(upstreamHost, packageName, filename);
  try {
    return await readFile(path);
  } catch {
    return null;
  }
}

export async function writeTarballCache(
  upstreamHost: string,
  packageName: string,
  filename: string,
  data: Buffer
): Promise<string> {
  const path = getTarballCachePath(upstreamHost, packageName, filename);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  return path;
}
