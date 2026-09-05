// Regression tests for two of the concurrency fixes applied to src/lib/tgz.ts:
//
//   (Fix A) convertZipBufferToTgz used to hand tar.c the FINAL tgz path directly, so a
//   reader that bypasses the per-directory lock (readTarballCache on the request path,
//   the plain stat() existence check in the background prefetch) could observe a
//   partially written file. It now writes to a uniquely named temp file in the same
//   directory and only publishes it at the final path via an atomic rename.
//
//   (Fix C) createTempLockRunner's lock table used to compare the wrong promise
//   reference in its cleanup step (`tempLocks.get(dir) === next` could never match what
//   was actually stored), so entries for a directory were never removed once the
//   original caller was done with it. The table is private to the module, so this file
//   cannot inspect it directly; instead it exercises two conversions that share a lock
//   key (and, more importantly, share the "temp" extraction subdirectory used while
//   converting) to confirm the lock still serializes access correctly. See the comment
//   on that test for why this is only an indirect check of the leak fix itself.
//
// convertZipBufferToTgz and runTempLocked have no environment-variable dependency at
// module load time (unlike src/lib/cache.ts / src/lib/upstreams.ts), so this file needs
// no special env setup before importing them.
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import * as tarForTypes from "tar";
// Raw CommonJS require of node:fs/promises, kept as a second handle alongside the
// named imports above. Both resolve to the exact same cached core-module object, so
// mutating a property on this handle (rename, below) is visible to src/lib/tgz.ts's own
// compiled call sites too -- TypeScript's CJS output for a named import from a core
// module reads the function off the shared required object at each call site rather
// than capturing a private copy (verified against dist/lib/tgz.js), and unlike the
// third-party "tar" package's own exports (whose `c` property turned out to be a
// non-configurable, getter-only alias into a fully bundled, non-shared internal copy of
// its create() implementation -- not mutable from outside at all), core modules like
// node:fs/promises expose plain writable/configurable properties.
// eslint-disable-next-line @typescript-eslint/no-var-requires
import fsPromises = require("node:fs/promises");

import { convertZipBufferToTgz, runTempLocked } from "../../src/lib/tgz";

// ---------------------------------------------------------------------------------
// Minimal, dependency-free ZIP (stored/uncompressed, method 0) builder. Copied from
// test/routes/vpm-tarball-convert.test.ts's own copy rather than shared, matching this
// codebase's existing convention of self-contained test files.
// ---------------------------------------------------------------------------------
function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuf, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirOffset = offset;
  const centralDirSize = centralDirectory.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

async function readPackageJsonFromTgz(tgzBuffer: Buffer): Promise<Record<string, unknown>> {
  const workDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-tgz-read-"));
  try {
    const tgzPath = join(workDir, "download.tgz");
    await writeFile(tgzPath, tgzBuffer);
    const outDir = join(workDir, "out");
    await mkdir(outDir, { recursive: true });
    await tarForTypes.x({ file: tgzPath, cwd: outDir });
    const raw = await readFile(join(outDir, "package", "package.json"), "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------
// Fix A: the final tgz path must not exist until conversion is fully done.
// ---------------------------------------------------------------------------------
test(
  "変換の完了前は最終パスにファイルが存在せず、renameが呼ばれた後にのみ現れる(fix A)",
  async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-tgz-fixa-"));
    const originalRename = fsPromises.rename;
    try {
      const packageJson = Buffer.from(
        JSON.stringify({ name: "com.example.tgz.fixa", version: "1.0.0" }, null, 2),
        "utf-8"
      );
      const zipBuffer = buildStoredZip([{ name: "package.json", data: packageJson }]);
      const targetTgzPath = join(workDir, "com.example.tgz.fixa-1.0.0.tgz");

      // Wrap node:fs/promises' rename so it pauses on a gate this test controls right
      // when convertZipBufferToTgz calls it -- i.e. exactly at the point tar.c has
      // finished writing the temp tgz file in full, but before that content is
      // published at targetTgzPath. `reached` resolves the instant that call happens,
      // so the test can await it directly instead of polling on a timer: this removes
      // any real-time race from the assertion that follows (no window to miss).
      let markReached: (() => void) | null = null;
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      let releaseGate: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let capturedTempPath = "";
      fsPromises.rename = (async (src: string, dest: string) => {
        capturedTempPath = src;
        markReached!();
        await gate;
        return originalRename(src, dest);
      }) as typeof fsPromises.rename;

      const conversionPromise = convertZipBufferToTgz(zipBuffer, targetTgzPath, runTempLocked);
      await reached;

      // rename() has been called (with the temp path as source, per Fix A) and is
      // paused at the gate: the temp file must exist with the full converted content,
      // while the final path must not exist yet, deterministically, since nothing has
      // renamed it there.
      assert.ok(capturedTempPath.includes(".tmp-"), "rename's source must be the uniquely named temp file");
      const tempStat = await stat(capturedTempPath);
      assert.ok(tempStat.isFile() && tempStat.size > 0, "the temp file must already hold the full converted content");
      await assert.rejects(() => stat(targetTgzPath), "the final path must not exist before rename runs");

      releaseGate!();
      const result = await conversionPromise;

      const finalStat = await stat(targetTgzPath);
      assert.ok(finalStat.isFile());
      assert.ok(result.length > 0);
      assert.ok(result[0] === 0x1f && result[1] === 0x8b, "result must be gzip-compressed");

      const remaining = await readdir(workDir);
      assert.ok(
        !remaining.some((e) => e.includes(".tmp-")),
        "no leftover temp tgz file after a successful conversion"
      );
    } finally {
      fsPromises.rename = originalRename;
      rmSync(workDir, { recursive: true, force: true });
    }
  }
);

// ---------------------------------------------------------------------------------
// Fix C: createTempLockRunner's lock table is private to src/lib/tgz.ts, so this test
// cannot assert directly that an entry was removed after use. As a fallback, it
// confirms that two conversions sharing a lock key (same target directory, and
// therefore the same "temp" extraction subdirectory used internally) still serialize
// correctly when run concurrently -- which is the externally observable behaviour the
// lock exists to provide. This does NOT prove the leaked-entry bug is fixed (the
// original bug left a resolved, harmless promise in the table forever, which does not
// break serialization for a small number of directories -- only accumulates memory
// across many distinct ones over a long process lifetime).
// ---------------------------------------------------------------------------------
test(
  "同一ディレクトリ(同一ロックキー)への並行変換が正しく直列化され、互いを破壊しない(fix Cの間接確認)",
  async () => {
    const workDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-tgz-fixc-"));
    try {
      const nameA = "com.example.tgz.fixc.a";
      const nameB = "com.example.tgz.fixc.b";
      const zipA = buildStoredZip([
        { name: "package.json", data: Buffer.from(JSON.stringify({ name: nameA, version: "1.0.0" }), "utf-8") }
      ]);
      const zipB = buildStoredZip([
        { name: "package.json", data: Buffer.from(JSON.stringify({ name: nameB, version: "2.0.0" }), "utf-8") }
      ]);

      const targetA = join(workDir, `${nameA}-1.0.0.tgz`);
      const targetB = join(workDir, `${nameB}-2.0.0.tgz`);

      const [bufA, bufB] = await Promise.all([
        convertZipBufferToTgz(zipA, targetA, runTempLocked),
        convertZipBufferToTgz(zipB, targetB, runTempLocked)
      ]);

      await stat(targetA);
      await stat(targetB);

      const parsedA = await readPackageJsonFromTgz(bufA);
      const parsedB = await readPackageJsonFromTgz(bufB);
      assert.equal(parsedA.name, nameA, "the first conversion must keep its own content");
      assert.equal(parsedB.name, nameB, "the second conversion must keep its own content, not the first's");

      const remaining = await readdir(workDir);
      assert.ok(
        !remaining.some((e) => e.includes(".tmp-")),
        "no leftover temp files after two conversions sharing a lock key"
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
);
