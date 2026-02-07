import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CACHE_DIR = process.env.TARBALL_CACHE_DIR ?? "./data/cache";

export type MetadataCache = {
  latestVersion: string;
  author?: string;
  displayName?: string;
  metadata: any;
};

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export function getPackageCacheDir(upstreamHost: string, packageName: string): string {
  const safeHost = upstreamHost.replace(/:/g, "_");
  return join(CACHE_DIR, safeHost, encodeSegment(packageName));
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cache, null, 2), "utf-8");
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
