// Unit tests for mergeShasumFromCache in src/routes/gitlab-npm-proxy.ts.
//
// The function decides what a metadata write keeps from the copy already on disk. Every
// caller passes it a snapshot built or read BEFORE some slow work (an upstream request, a
// zip to tgz conversion), so by the time the merge runs the disk may hold newer dist
// fields. Getting this wrong is silent: metadata keeps advertising a hash of an archive the
// proxy no longer serves, and clients reject the download.
//
// Module-load env vars: src/routes/gitlab-npm-proxy.ts reads PUBLIC_BASE_URL,
// TARBALL_CACHE_DIR and UPSTREAM_CONFIG_PATH once at module load, so they are assigned
// before the import (same constraint documented in test/routes/vpm-tarball-convert.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-merge-shasum-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.merge-shasum.example.net";

import { mergeShasumFromCache } from "../../src/routes/gitlab-npm-proxy";
import { getProxySigningKey } from "../../src/lib/npm-signatures";

after(() => {
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

const version = "1.0.0";
const proxyKeyid = getProxySigningKey().keyid;

test(
  "スナップショットにshasumが無い版は、キャッシュ側のshasumと署名を引き継ぐ",
  () => {
    const snapshot = { versions: { [version]: { dist: { tarball: "" } as Record<string, unknown> } } };
    const onDisk = {
      versions: {
        [version]: {
          dist: {
            shasum: "1111111111111111111111111111111111111111",
            integrity: "sha512-CACHED",
            signatures: [{ keyid: proxyKeyid, sig: "CACHED-SIGNATURE" }]
          }
        }
      }
    };

    mergeShasumFromCache(snapshot, onDisk);

    const dist = snapshot.versions[version].dist;
    assert.equal(dist.shasum, "1111111111111111111111111111111111111111");
    assert.equal(dist.integrity, "sha512-CACHED");
    assert.deepEqual(dist.signatures, [{ keyid: proxyKeyid, sig: "CACHED-SIGNATURE" }]);
  }
);

// Regression for the third review round: the function used to skip any version that already
// carried a shasum, so a snapshot taken before the prefetch rebuilt and re-signed an archive
// (which it does to inject a missing author) wrote its older integrity back over the newer
// one, undoing the re-signing fix from the previous round.
test(
  "プロキシが署名し直した新しいdistは、古いスナップショットで上書きされない",
  () => {
    const snapshot = {
      versions: {
        [version]: {
          dist: {
            shasum: "1111111111111111111111111111111111111111",
            integrity: "sha512-OLD-ARCHIVE",
            signatures: [{ keyid: proxyKeyid, sig: "SIGNATURE-OF-THE-OLD-ARCHIVE" }]
          }
        }
      }
    };
    const onDisk = {
      versions: {
        [version]: {
          dist: {
            shasum: "2222222222222222222222222222222222222222",
            integrity: "sha512-REBUILT-ARCHIVE",
            signatures: [{ keyid: proxyKeyid, sig: "SIGNATURE-OF-THE-REBUILT-ARCHIVE" }]
          }
        }
      }
    };

    mergeShasumFromCache(snapshot, onDisk);

    const dist = snapshot.versions[version].dist;
    assert.equal(dist.shasum, "2222222222222222222222222222222222222222");
    assert.equal(dist.integrity, "sha512-REBUILT-ARCHIVE", "the newer proxy-signed integrity must win");
    assert.equal(dist.signatures[0].sig, "SIGNATURE-OF-THE-REBUILT-ARCHIVE");
  }
);

// The replacement above is deliberately limited to archives this proxy signed. On the plain
// npm passthrough the upstream registry's shasum is the authoritative one and a cached value
// must never displace it.
test(
  "プロキシの署名が無いキャッシュは、上流由来のshasumを置き換えない",
  () => {
    const snapshot = {
      versions: { [version]: { dist: { shasum: "3333333333333333333333333333333333333333" } } }
    };
    const onDisk = {
      versions: { [version]: { dist: { shasum: "4444444444444444444444444444444444444444" } } }
    };

    mergeShasumFromCache(snapshot, onDisk);

    assert.equal(
      snapshot.versions[version].dist.shasum,
      "3333333333333333333333333333333333333333",
      "an upstream registry's own shasum must stay authoritative"
    );
  }
);
