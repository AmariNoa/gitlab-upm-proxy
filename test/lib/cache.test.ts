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
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-cache-update-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;

import { readMetadataCache, updateMetadataCache, writeMetadataCache, type MetadataCache } from "../../src/lib/cache";

after(() => {
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

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
