// Regression test for the window between deciding a package is empty and deleting it.
//
// removeWithdrawnPackage used to make that decision inside the metadata lock, release the lock,
// and only then remove the package directory. A prefetch publishing a new version in between had
// its metadata and its archive deleted by a decision taken before that version existed. This is
// not the excluded case where an old prefetch snapshot reinserts a withdrawn version: here a
// genuinely new publication is destroyed.
//
// Module-load env vars: TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL are read once
// at module load by src/lib/cache.ts, src/lib/upstreams.ts and src/routes/gitlab-npm-proxy.ts, so
// they are assigned before any src/ import (same constraint documented in
// test/routes/vpm-tarball-convert.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-withdrawal-race-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.vpm.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.withdrawal.example.net";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import { removeWithdrawnPackage } from "../../src/routes/gitlab-npm-proxy";
import {
  hasTarballCache,
  readMetadataCache,
  updateMetadataCache,
  writeMetadataCache,
  writeTarballCache,
  type MetadataCache
} from "../../src/lib/cache";
import type { UpstreamEntry } from "../../src/lib/upstreams";

const upstream: UpstreamEntry = {
  baseUrl: "https://vpm.example.com/index.json",
  host: "vpm.example.com",
  type: "vpm"
};

after(() => {
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

function nodeFor(packageName: string, version: string, marker: string): any {
  return {
    name: packageName,
    version,
    author: { name: "A" },
    dist: { tarball: "", shasum: "a".repeat(40), integrity: `sha512-${marker}` }
  };
}

test(
  "撤回の判定と削除の間に公開された版は消されない",
  async () => {
    const packageName = "com.example.vpm.race";
    const known = "1.0.0";
    const concurrent = "2.0.0";

    // The cache the request read as its baseline: one version, all of it withdrawn upstream.
    const baseline: MetadataCache = {
      latestVersion: known,
      metadata: {
        name: packageName,
        "dist-tags": { latest: known },
        versions: { [known]: nodeFor(packageName, known, "KNOWN") }
      }
    };
    await writeMetadataCache(upstream.host, packageName, baseline);
    await writeTarballCache(
      upstream.host,
      packageName,
      `${packageName}-${known}.tgz`,
      Buffer.from("known archive")
    );

    // The withdrawal and a concurrent publication of a brand new version, started together. The
    // publication takes the same metadata lock, so with the decision and the deletion both held
    // under it the two are serialized whichever order they arrive in - and the new version
    // survives. With the deletion outside the lock, the publication lands in the gap and is
    // deleted by a decision taken before it existed.
    const withdrawal = removeWithdrawnPackage(upstream, packageName, baseline.metadata);
    // One macrotask, so the withdrawal is demonstrably inside its critical section before the
    // publication asks for the lock. Without this the two can arrive in either order, and the
    // order where the publication goes first never exercises the window at all.
    await new Promise((resolve) => setImmediate(resolve));
    const publication = (async () => {
      await updateMetadataCache(upstream.host, packageName, (current) => {
        const metadata = current?.metadata ?? {
          name: packageName,
          "dist-tags": {},
          versions: {} as Record<string, any>
        };
        metadata.versions = metadata.versions ?? {};
        metadata.versions[concurrent] = nodeFor(packageName, concurrent, "CONCURRENT");
        return {
          latestVersion: concurrent,
          author: current?.author,
          displayName: current?.displayName,
          metadata
        };
      });
      await writeTarballCache(
        upstream.host,
        packageName,
        `${packageName}-${concurrent}.tgz`,
        Buffer.from("concurrent archive")
      );
    })();

    await Promise.all([withdrawal, publication]);

    const disk = await readMetadataCache(upstream.host, packageName);
    assert.ok(disk, "the package must not be gone: a version was published during the withdrawal");
    assert.ok(
      disk!.metadata.versions[concurrent],
      "the concurrently published version must still be described"
    );
    assert.equal(
      await hasTarballCache(upstream.host, packageName, `${packageName}-${concurrent}.tgz`),
      true,
      "and its archive must still be there"
    );
  }
);
