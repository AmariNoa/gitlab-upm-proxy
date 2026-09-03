import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import * as tar from "tar";
import * as unzipper from "unzipper";

// Extracts a zip archive (VPM package payload) into targetDir.
export async function unzipToDirectory(zipPath: string, targetDir: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(zipPath).pipe(unzipper.Extract({ path: targetDir }));
    stream.on("close", () => resolve());
    stream.on("error", (err) => reject(err));
  });
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

// Creates a per-directory lock table. Callers hold their own runner instance, which
// preserves the behaviour these helpers had while they lived in each calling module.
export function createTempLockRunner(): TempLockRunner {
  const tempLocks = new Map<string, Promise<void>>();

  return async function withTempLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const prev = tempLocks.get(dir) ?? Promise.resolve();
    let release = () => {};
    const next = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    tempLocks.set(dir, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tempLocks.get(dir) === next) {
        tempLocks.delete(dir);
      }
    }
  };
}

// Converts a downloaded zip buffer into an npm-style tgz at targetTgzPath, optionally
// filling in a missing package.json author from the VPM index. Returns the tgz contents.
export async function convertZipBufferToTgz(
  zipBuffer: Buffer,
  targetTgzPath: string,
  runLocked: TempLockRunner,
  vpmAuthor?: unknown
): Promise<Buffer> {
  return await runLocked(dirname(targetTgzPath), async () => {
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
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors on Windows
      }
    }
  });
}
