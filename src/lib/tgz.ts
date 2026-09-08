import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import * as tar from "tar";
import * as unzipper from "unzipper";
import { positiveIntEnv } from "./env";

/**
 * Ceilings on what one archive may expand to. The zip is published by whoever owns the package,
 * not by this proxy, and it used to be handed straight to unzipper with no limit at all: a small,
 * highly compressible archive could fill the cache filesystem during a download or a startup
 * prefetch, and the cleanup only ran once extraction had finished or failed. The defaults are far
 * above any real Unity package.
 */
function maxExtractBytes(): number {
  return positiveIntEnv("VPM_MAX_EXTRACT_BYTES", 1024 * 1024 * 1024);
}

function maxExtractEntries(): number {
  return positiveIntEnv("VPM_MAX_EXTRACT_ENTRIES", 20000);
}

/**
 * Resolves an archive entry's path inside targetDir, refusing anything that would land outside
 * it. Absolute paths and `..` segments are a property of the archive, so they are attacker
 * controlled in exactly the same way its size is.
 */
function resolveEntryPath(targetDir: string, entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/");
  if (isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`zip_entry_outside_target:${entryPath}`);
  }
  const base = resolvePath(targetDir);
  const full = resolvePath(base, normalized);
  const rel = relative(base, full);
  // Only a path that actually climbs out is rejected. A leading ".." is not enough on its own:
  // "..notes" and "..assets/file.txt" are ordinary names that resolve inside the target, and
  // refusing them failed the whole conversion for a package that did nothing wrong.
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).includes("..")) {
    throw new Error(`zip_entry_outside_target:${entryPath}`);
  }
  return full;
}

/**
 * Extracts a zip archive (VPM package payload) into targetDir, bounded by entry count and total
 * expanded bytes.
 *
 * The central directory is checked first, so an archive that admits up front how large it is gets
 * rejected before anything is written. Because a zip may understate its own sizes, the bytes
 * actually written are counted as well and the extraction is abandoned the moment they exceed the
 * ceiling. Callers already remove the temp directory on failure, so a partial extraction does not
 * survive the throw.
 *
 * Directory entries are created even when empty. Dropping them would be a silent difference from
 * what the archive holds: a Unity package's empty folder still has a sibling .meta file, so the
 * converted tarball would describe a folder it does not contain.
 */
export async function unzipToDirectory(zipPath: string, targetDir: string): Promise<void> {
  const byteLimit = maxExtractBytes();
  const entryLimit = maxExtractEntries();

  const directory = await unzipper.Open.file(zipPath);
  const directories = directory.files.filter((file) => file.type === "Directory");
  const files = directory.files.filter((file) => file.type !== "Directory");
  if (files.length > entryLimit) {
    throw new Error(`zip_too_many_entries:${files.length}`);
  }
  let declared = 0;
  for (const file of files) {
    const size = Number(file.uncompressedSize);
    if (Number.isFinite(size)) declared += size;
  }
  if (declared > byteLimit) {
    throw new Error(`zip_expanded_too_large:${declared}`);
  }

  // Before the files, so an entry that only exists as a directory record survives even when the
  // archive lists nothing inside it. Their paths go through the same containment check.
  for (const entry of directories) {
    await mkdir(resolveEntryPath(targetDir, entry.path.replace(/\/+$/, "")), { recursive: true });
  }

  let written = 0;
  for (const file of files) {
    const destination = resolveEntryPath(targetDir, file.path);
    await mkdir(dirname(destination), { recursive: true });
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        written += chunk.length;
        if (written > byteLimit) {
          callback(new Error(`zip_expanded_too_large:${written}`));
          return;
        }
        callback(null, chunk);
      }
    });
    await pipeline(file.stream(), counter, createWriteStream(destination));
  }
}

// Locates the package.json root inside an extracted archive (handles a single wrapping directory).
export async function findPackageRoot(extractDir: string): Promise<string> {
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

// Computes the sha1 hex digest used for npm dist.shasum.
export function computeSha1(buffer: Buffer): string {
  return createHash("sha1").update(buffer).digest("hex");
}

export type TempLockRunner = <T>(dir: string, fn: () => Promise<T>) => Promise<T>;

// Creates a per-directory lock table.
function createTempLockRunner(): TempLockRunner {
  const tempLocks = new Map<string, Promise<void>>();

  return async function withTempLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const prev = tempLocks.get(dir) ?? Promise.resolve();
    let release = () => {};
    const next = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    // Store the exact promise object referenced below so the `finally` block's identity
    // check can actually match it (the previous code stored prev.then(() => next), a
    // different object from `next`, so the check never matched and entries piled up).
    const chained = prev.then(() => next);
    tempLocks.set(dir, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tempLocks.get(dir) === chained) {
        tempLocks.delete(dir);
      }
    }
  };
}

// One lock table shared by every caller. Serving a tarball on request and prefetching it
// in the background use the same temp directory for the same package, so they have to
// serialize against each other, not only against themselves.
//
// Like the metadata lock in src/lib/cache.ts, this table is in-process only: it cannot
// stop a second process working in the same temp directory from clobbering the extract
// (see PROJECT_MAP.md, "並行性の前提"). The final tgz is still published by rename, so a
// concurrent reader never sees a half-written archive either way.
export const runTempLocked: TempLockRunner = createTempLockRunner();

// Converts a downloaded zip buffer into an npm-style tgz at targetTgzPath, optionally
// filling in a missing package.json author from the VPM index. Returns the tgz contents.
//
// Callers that go on to hash the result and publish its signature should take the lock
// themselves and call convertZipBufferToTgzUnlocked inside it: publishing the archive and
// publishing the metadata that describes it are one change as far as a client is concerned,
// and releasing the lock in between lets a reader observe the new archive beside the old
// signature.
export async function convertZipBufferToTgz(
  zipBuffer: Buffer,
  targetTgzPath: string,
  runLocked: TempLockRunner,
  vpmAuthor?: unknown
): Promise<Buffer> {
  return await runLocked(dirname(targetTgzPath), () =>
    convertZipBufferToTgzUnlocked(zipBuffer, targetTgzPath, vpmAuthor)
  );
}

// The body of the conversion, without taking the lock. Only call this while already holding
// the per-directory lock for dirname(targetTgzPath) - the lock is not reentrant, so calling
// convertZipBufferToTgz from inside a locked section would deadlock.
export async function convertZipBufferToTgzUnlocked(
  zipBuffer: Buffer,
  targetTgzPath: string,
  vpmAuthor?: unknown
): Promise<Buffer> {
  {
    await mkdir(dirname(targetTgzPath), { recursive: true });
    const tempDir = join(dirname(targetTgzPath), "temp");
    await rm(tempDir, { recursive: true, force: true });
    await mkdir(tempDir, { recursive: true });
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
      // Write to a temp file in the same directory as targetTgzPath first, then rename it
      // into place. rename is atomic within one filesystem, so a reader that bypasses the
      // lock (readTarballCache in the request path, the stat() existence check in the
      // background prefetch) never observes a partially written tgz at the final path.
      const tempTgzPath = join(dirname(targetTgzPath), `${basename(targetTgzPath)}.tmp-${randomUUID()}`);
      try {
        await tar.c(
          {
            gzip: true,
            file: tempTgzPath,
            cwd: rootDir,
            prefix: "package/"
          },
          entries
        );
        await rename(tempTgzPath, targetTgzPath);
      } catch (err) {
        await rm(tempTgzPath, { force: true }).catch(() => {});
        throw err;
      }
      return await readFile(targetTgzPath);
    } finally {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors on Windows
      }
    }
  }
}
