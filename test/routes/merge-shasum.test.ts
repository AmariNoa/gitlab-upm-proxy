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

import {
  mergeShasumFromCache,
  pathWithoutQuery,
  reconcileAgainstDisk,
  refreshCachedVpmMetadata
} from "../../src/routes/gitlab-npm-proxy";
import { getProxySigningKey } from "../../src/lib/npm-signatures";
import { readMetadataCache, writeMetadataCache, type MetadataCache } from "../../src/lib/cache";
import type { UpstreamEntry } from "../../src/lib/upstreams";

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

// Regression for the sixth review round: refreshCachedVpmMetadata writes the request's
// snapshot back to disk, and mergeShasumFromCache only visits versions that snapshot already
// contains. A version published by a concurrent prefetch was therefore absent from the
// write and got deleted, taking its shasum with it - after which every response filtered it
// out until another writer restored it.
test(
  "refreshCachedVpmMetadataは、スナップショットに無い版をディスクから削除しない",
  async () => {
    const upstream: UpstreamEntry = {
      baseUrl: "https://vpm.example.com/index.json",
      host: "vpm-refresh-merge.example.com",
      type: "vpm"
    };
    const packageName = "com.example.refresh.merge";

    // What a concurrent prefetch has already published: 1.0.0 and a signed 2.0.0.
    const onDisk: MetadataCache = {
      latestVersion: "2.0.0",
      metadata: {
        name: packageName,
        "dist-tags": { latest: "2.0.0" },
        versions: {
          "1.0.0": { name: packageName, version: "1.0.0", dist: { tarball: "", shasum: "a".repeat(40) } },
          "2.0.0": {
            name: packageName,
            version: "2.0.0",
            dist: {
              tarball: "",
              shasum: "b".repeat(40),
              integrity: "sha512-PUBLISHED-BY-THE-PREFETCH",
              signatures: [{ keyid: proxyKeyid, sig: "PREFETCH-SIGNATURE" }]
            }
          }
        }
      }
    };
    await writeMetadataCache(upstream.host, packageName, onDisk);

    // What this request built from an older index read: 1.0.0 only.
    const staleSnapshot = {
      name: packageName,
      versions: {
        "1.0.0": { name: packageName, version: "1.0.0", dist: { tarball: "" } }
      }
    };

    await refreshCachedVpmMetadata(upstream, packageName, staleSnapshot);

    const result = await readMetadataCache(upstream.host, packageName);
    assert.ok(result, "expected a metadata cache entry");
    const versions = result!.metadata.versions;
    assert.ok(versions["2.0.0"], "the concurrently published version must survive the refresh");
    assert.equal(versions["2.0.0"].dist.integrity, "sha512-PUBLISHED-BY-THE-PREFETCH");
    assert.equal(versions["2.0.0"].dist.signatures[0].sig, "PREFETCH-SIGNATURE");
    assert.equal(result!.latestVersion, "2.0.0", "latestVersion must not roll back to the snapshot's newest");
    // The version the snapshot did know about still picks up its cached shasum.
    assert.equal(versions["1.0.0"].dist.shasum, "a".repeat(40));
  }
);

// Regression for the seventh review round: the previous round kept every version that was on
// disk but missing from the write, which also resurrected versions the upstream had
// deliberately withdrawn - permanently, and as `latest`, since latestVersion is chosen from
// what gets written. The baseline (the cache as the request first read it) separates a
// concurrent publication from a withdrawal.
test(
  "refreshCachedVpmMetadataは、上流が削除した版を基準スナップショットと照合して復活させない",
  async () => {
    const upstream: UpstreamEntry = {
      baseUrl: "https://vpm.example.com/index.json",
      host: "vpm-refresh-withdraw.example.com",
      type: "vpm"
    };
    const packageName = "com.example.refresh.withdraw";

    const signedNode = (version: string, sig: string) => ({
      name: packageName,
      version,
      dist: {
        tarball: "",
        shasum: "c".repeat(40),
        integrity: `sha512-${sig}`,
        signatures: [{ keyid: proxyKeyid, sig }]
      }
    });

    // The request's baseline: 1.0.0 and 2.0.0 were both cached when it started.
    const baseline = {
      name: packageName,
      versions: {
        "1.0.0": signedNode("1.0.0", "ONE"),
        "2.0.0": signedNode("2.0.0", "TWO")
      }
    };

    // Meanwhile a prefetch published 3.0.0, so disk now holds all three.
    await writeMetadataCache(upstream.host, packageName, {
      latestVersion: "3.0.0",
      metadata: {
        name: packageName,
        "dist-tags": { latest: "3.0.0" },
        versions: {
          "1.0.0": signedNode("1.0.0", "ONE"),
          "2.0.0": signedNode("2.0.0", "TWO"),
          "3.0.0": signedNode("3.0.0", "THREE")
        }
      }
    });

    // The index this request read no longer lists 2.0.0: the upstream withdrew it.
    const rebuiltFromIndex = {
      name: packageName,
      versions: { "1.0.0": { name: packageName, version: "1.0.0", dist: { tarball: "" } } }
    };

    await refreshCachedVpmMetadata(upstream, packageName, rebuiltFromIndex, baseline);

    const result = await readMetadataCache(upstream.host, packageName);
    assert.ok(result);
    const versions = result!.metadata.versions;
    assert.ok(versions["1.0.0"], "a version still in the index must stay");
    assert.equal(versions["2.0.0"], undefined, "a version the upstream withdrew must not be restored");
    assert.ok(versions["3.0.0"], "a version published concurrently must survive");
    assert.equal(versions["3.0.0"].dist.signatures[0].sig, "THREE");
    assert.equal(result!.latestVersion, "3.0.0", "latestVersion must not come from the withdrawn version");
  }
);

// Regression for the tenth review round: when a prefetch deletes an archive whose metadata it
// could not publish, it clears that version's availability on disk. A metadata request holding
// a snapshot from before that cleanup would write its own shasum and signature back, undoing
// the cleanup for good - mergeShasumFromCache cannot help, because the cleared disk entry has
// nothing left to copy.
test(
  "ディスク側で可用性が消された版は、古いスナップショットの署名で復活しない",
  async () => {
    const upstream: UpstreamEntry = {
      baseUrl: "https://vpm.example.com/index.json",
      host: "vpm-refresh-cleared.example.com",
      type: "vpm"
    };
    const packageName = "com.example.refresh.cleared";
    const version = "1.0.0";

    // What the rollback left: the version is still listed, but nothing says it is available.
    await writeMetadataCache(upstream.host, packageName, {
      latestVersion: "",
      metadata: {
        name: packageName,
        "dist-tags": {},
        versions: {
          [version]: { name: packageName, version, dist: { tarball: "", original: "https://vpm.example.com/dl/x.zip" } }
        }
      }
    });

    // What the request still believes: signed, under the current key.
    const staleSnapshot = {
      name: packageName,
      versions: {
        [version]: {
          name: packageName,
          version,
          dist: {
            tarball: "",
            shasum: "7".repeat(40),
            integrity: "sha512-BEFORE-THE-ROLLBACK",
            signatures: [{ keyid: proxyKeyid, sig: "BEFORE-THE-ROLLBACK" }]
          }
        }
      }
    };

    await refreshCachedVpmMetadata(upstream, packageName, staleSnapshot, staleSnapshot);

    const result = await readMetadataCache(upstream.host, packageName);
    const dist = result?.metadata.versions[version]?.dist;
    assert.ok(dist, "the version itself stays listed");
    assert.equal(dist.shasum, undefined, "the cleared availability must not be written back");
    assert.equal(dist.integrity, undefined);
    assert.equal(dist.signatures, undefined);
  }
);

// Regression for the third round of the second review cycle: the per-request log printed
// req.url verbatim. Tarball URLs carry the query the upstream signed them with - which this
// proxy deliberately preserves end to end - so every tarball request wrote a working download
// credential into the log, where it outlives the signature's own expiry.
test("pathWithoutQueryはログへ出すパスからクエリ文字列を落とす", () => {
  assert.equal(
    pathWithoutQuery("/api/v4/groups/g/com.example.pkg/-/com.example.pkg-1.0.0.tgz?signature=s&expires=1"),
    "/api/v4/groups/g/com.example.pkg/-/com.example.pkg-1.0.0.tgz"
  );
  assert.equal(pathWithoutQuery("/api/v4/groups/g/com.example.pkg"), "/api/v4/groups/g/com.example.pkg");
  assert.equal(pathWithoutQuery("/?a=b"), "/");
  // A non-string url (never expected from Fastify, but the logger must not throw).
  assert.equal(pathWithoutQuery(undefined), "");
});

// Regression for the tenth round of the second review cycle: search wrote VPM metadata with only
// two of the three reconciliation rules the metadata route applies, so a snapshot taken before a
// failed prefetch rolled a version back would write its shasum, integrity and signatures straight
// back over the cleanup - leaving metadata advertising an archive that is not on disk, and a
// shasum that stops the next prefetch from repairing it.
//
// The rules are one shared function now, which is what actually prevents the two writers drifting
// again; this pins what that function does.
test("reconcileAgainstDiskは、ディスク側で消された可用性フィールドを復活させない", () => {
  const rolledBack = {
    versions: {
      "1.0.0": { dist: { tarball: "" } }
    }
  };
  const staleSnapshot = {
    versions: {
      "1.0.0": {
        dist: {
          tarball: "",
          shasum: "9".repeat(40),
          integrity: "sha512-STALE",
          signatures: [{ keyid: proxyKeyid, sig: "STALE-SIGNATURE" }]
        }
      }
    }
  };

  reconcileAgainstDisk(staleSnapshot, rolledBack);

  const dist = staleSnapshot.versions["1.0.0"].dist as Record<string, unknown>;
  assert.equal(dist.shasum, undefined, "a rolled-back version must not regain its shasum");
  assert.equal(dist.integrity, undefined, "nor its integrity");
  assert.equal(dist.signatures, undefined, "nor its signatures");
});

test("reconcileAgainstDiskは、ディスク側にしかない版とshasumを保つ", () => {
  const onDisk = {
    versions: {
      "1.0.0": { dist: { shasum: "1".repeat(40) } },
      "2.0.0": { name: "x", version: "2.0.0", dist: { shasum: "2".repeat(40) } }
    }
  };
  const snapshot = { versions: { "1.0.0": { dist: { tarball: "" } as Record<string, unknown> } } };

  reconcileAgainstDisk(snapshot, onDisk);

  assert.equal(snapshot.versions["1.0.0"].dist.shasum, "1".repeat(40), "cached shasums are kept");
  assert.ok(
    (snapshot.versions as Record<string, any>)["2.0.0"],
    "a version only on disk survives the write"
  );
});
