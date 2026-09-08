// Regression test for the concurrency fix (fix B) applied to
// updateMetadataCache/writeMetadataCache in src/lib/cache.ts: metadata cache
// read-modify-write cycles for the same (upstreamHost, packageName) pair now go
// through a per-package lock that re-reads the current on-disk value before mutating
// and writing it back, instead of blindly overwriting whatever the caller read earlier.
// Without that lock, two concurrent updates to different versions of the same package
// would race (last writer wins wholesale), silently losing whichever update lost the
// race -- exactly the scenario this test drives.
//
// Module-load env vars: TARBALL_CACHE_DIR is read exactly once at module load time by
// src/lib/cache.ts, so it is assigned below BEFORE that module is imported (same
// constraint documented in test/routes/vpm-tarball-convert.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-cache-update-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;

import {
  getPackageCacheDir,
  getTarballCachePath,
  getUpstreamCacheDir,
  isSafePackageName,
  readMetadataCache,
  readTarballCache,
  updateMetadataCache,
  writeMetadataCache,
  writeTarballCache,
  type MetadataCache
} from "../../src/lib/cache";

after(() => {
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

// Regression for the second review round: writeTarballCache used to write straight to the
// final path, so a reader that takes no lock (hasTarballCache / readTarballCache) could
// observe a half-written tarball. Publication now goes through a temp file and rename, so
// the final path only ever holds a complete archive.
test(
  "writeTarballCacheは書き込み中の内容を最終パスへ晒さず、renameの後にのみ完全な内容が現れる",
  async () => {
    const host = "gitlab.atomic-tarball.example.com";
    const packageName = "com.example.atomic";
    const filename = "com.example.atomic-1.0.0.tgz";
    // Large enough that a direct write would be observable in pieces.
    const payload = Buffer.alloc(4 * 1024 * 1024, 0x41);

    const finalPath = getTarballCachePath(host, packageName, filename);
    const observedSizes: number[] = [];
    let polling = true;
    const poller = (async () => {
      while (polling) {
        try {
          observedSizes.push((await stat(finalPath)).size);
        } catch {
          // not published yet
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();

    await writeTarballCache(host, packageName, filename, payload);
    polling = false;
    await poller;

    // Whenever the final path existed at all, it already held the complete archive.
    //
    // The poller has to have seen it at least once, or this proves nothing: an empty
    // observation list satisfies the loop below trivially, and the assertions after it hold
    // for a direct write too. Catching the partial state itself remains best effort - the
    // guarantee is that no partial size is ever observed, not that the window is always hit.
    assert.ok(observedSizes.length > 0, "the poller must have observed the published file");
    for (const size of observedSizes) {
      assert.equal(size, payload.length, "the final path must never expose a partial tarball");
    }
    const published = await readTarballCache(host, packageName, filename);
    assert.equal(published?.length, payload.length);

    // No temp file may be left behind next to it.
    const leftovers = (await readdir(dirname(finalPath))).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "the temp file must not survive a successful write");
  }
);

test(
  "ドットセグメントのパッケージ名はキャッシュパスへ解決されず、getPackageCacheDirが失敗する",
  () => {
    const host = "gitlab.dot-segment.example.com";

    // encodeURIComponent leaves these untouched, so join() would normalize them into the
    // upstream directory or the cache root itself.
    for (const unsafe of ["", ".", ".."]) {
      assert.equal(isSafePackageName(unsafe), false, `expected ${JSON.stringify(unsafe)} to be rejected`);
      assert.throws(
        () => getPackageCacheDir(host, unsafe),
        /Unsafe package name/,
        `expected getPackageCacheDir to refuse ${JSON.stringify(unsafe)}`
      );
    }

    // Names that merely contain dots or separators stay inside their own directory: the
    // separators are percent-encoded, so they cannot climb out.
    const upstreamDir = getUpstreamCacheDir(host);
    for (const safe of ["...", "a..b", "../../x", "@scope/name", "com.example.pkg"]) {
      assert.equal(isSafePackageName(safe), true, `expected ${JSON.stringify(safe)} to be accepted`);
      const dir = getPackageCacheDir(host, safe);
      assert.equal(
        dirname(dir),
        upstreamDir,
        `expected ${JSON.stringify(safe)} to resolve directly under the upstream directory`
      );
      assert.notEqual(dir, upstreamDir);
    }
  }
);

test(
  "updateMetadataCacheへの並行呼び出しは互いの更新を失わずディスクへ残す(fix B)",
  async () => {
    const host = "vpm.cache-update.example.com";
    const packageName = "com.example.cache.update";

    const initial: MetadataCache = {
      latestVersion: "1.0.0",
      metadata: {
        name: packageName,
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": { name: packageName, version: "1.0.0", dist: { tarball: "" } },
          "2.0.0": { name: packageName, version: "2.0.0", dist: { tarball: "" } }
        }
      }
    };
    await writeMetadataCache(host, packageName, initial);

    // Two concurrent updates, each setting a different version's dist.shasum. If the
    // read-modify-write cycle were not locked, both would read the same pre-update
    // snapshot, and whichever finishes writing last would silently discard the other's
    // shasum -- the same failure mode the task description calls out for the real
    // callers (a version missing dist.shasum gets filtered out of what Unity sees).
    await Promise.all([
      updateMetadataCache(host, packageName, (current) => {
        const metadata = current?.metadata;
        assert.ok(metadata?.versions?.["1.0.0"]?.dist, "expected a fresh read with version 1.0.0 present");
        metadata.versions["1.0.0"].dist.shasum = "shasum-for-1.0.0";
        return {
          latestVersion: current?.latestVersion ?? initial.latestVersion,
          author: current?.author,
          displayName: current?.displayName,
          metadata
        };
      }),
      updateMetadataCache(host, packageName, (current) => {
        const metadata = current?.metadata;
        assert.ok(metadata?.versions?.["2.0.0"]?.dist, "expected a fresh read with version 2.0.0 present");
        metadata.versions["2.0.0"].dist.shasum = "shasum-for-2.0.0";
        return {
          latestVersion: current?.latestVersion ?? initial.latestVersion,
          author: current?.author,
          displayName: current?.displayName,
          metadata
        };
      })
    ]);

    const result = await readMetadataCache(host, packageName);
    assert.ok(result, "expected a metadata cache entry after both updates");
    assert.equal(result!.metadata.versions["1.0.0"].dist.shasum, "shasum-for-1.0.0");
    assert.equal(result!.metadata.versions["2.0.0"].dist.shasum, "shasum-for-2.0.0");
  }
);

test(
  "updateMetadataCacheはmutateがnullを返した場合ディスクへ書き込まない",
  async () => {
    const host = "vpm.cache-update-null.example.com";
    const packageName = "com.example.cache.update.null";

    await updateMetadataCache(host, packageName, () => null);
    const result = await readMetadataCache(host, packageName);
    assert.equal(result, null, "no cache entry should have been created");
  }
);
