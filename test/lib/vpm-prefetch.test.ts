// Verifies that the VPM prefetch pass does not re-sign a tarball whose cached dist
// already carries a signature from the currently active proxy key (fix for: prefetch used
// to call applyPackageSignature unconditionally, re-hashing and re-signing every cached
// tarball on every prefetch pass regardless of whether it was already correctly signed).
//
// TARBALL_CACHE_DIR is read once at module load time by src/lib/cache.ts and
// src/lib/npm-signatures.ts, so it is set below before any src/ module is imported (same
// constraint documented in test/routes/vpm-signatures.test.ts). This file calls
// prefetchForPackage directly instead of going through the HTTP route + background
// startVpmPrefetchForPackage, so the prefetch pass can be awaited deterministically
// instead of polled.
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { after, describe, it } from "node:test";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-vpm-prefetch-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;

import { getProxySigningKey } from "../../src/lib/npm-signatures";
import { prefetchForPackage } from "../../src/lib/vpm-prefetch";
import { writeMetadataCache, writeTarballCache, readMetadataCache, type MetadataCache } from "../../src/lib/cache";
import { computeSha1 } from "../../src/lib/tgz";
import type { UpstreamEntry } from "../../src/lib/upstreams";

const upstream: UpstreamEntry = {
  baseUrl: "https://vpm.example.com/index.json",
  host: "vpm-prefetch-test.example.com",
  type: "vpm"
};

const proxyKey = getProxySigningKey();
const proxyPublicKey = createPublicKey({
  key: Buffer.from(proxyKey.key, "base64"),
  format: "der",
  type: "spki"
});

const noopLog = { info: () => {} };

after(() => {
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

describe("vpm-prefetch: skips re-signing already-signed cached tarballs", () => {
  it("leaves a version's signature untouched when it already carries the current proxy key's keyid", async () => {
    const packageName = "com.example.prefetch.reuse";
    const version = "1.0.0";
    const tarballBytes = Buffer.from("vpm-prefetch-reuse-test-tarball-bytes");
    const cacheKey = `${packageName}-${version}.tgz`;
    const sourceUrl = `https://vpm.example.com/dl/${packageName}-${version}.zip`;

    await writeTarballCache(upstream.host, packageName, cacheKey, tarballBytes);

    const seedCache: MetadataCache = {
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            author: { name: "Test Author" },
            dist: {
              tarball: "",
              original: sourceUrl,
              shasum: "0000000000000000000000000000000000000000",
              integrity: "sha512-PRESET-SHOULD-NOT-CHANGE",
              signatures: [{ keyid: proxyKey.keyid, sig: "PRESIGNED-MARKER" }]
            }
          }
        }
      }
    };
    await writeMetadataCache(upstream.host, packageName, seedCache);

    await prefetchForPackage(
      upstream,
      packageName,
      { [version]: { name: packageName, version, url: sourceUrl } },
      undefined,
      0,
      noopLog
    );

    const after1 = await readMetadataCache(upstream.host, packageName);
    const dist = after1?.metadata.versions[version].dist;
    assert.ok(dist, "expected the version's dist to still be present");
    assert.equal(dist.shasum, computeSha1(tarballBytes), "shasum must still be (re)computed from the tgz on disk");
    assert.equal(dist.integrity, "sha512-PRESET-SHOULD-NOT-CHANGE", "integrity must not be recomputed when already signed");
    assert.equal(dist.signatures.length, 1);
    assert.equal(dist.signatures[0].keyid, proxyKey.keyid);
    assert.equal(dist.signatures[0].sig, "PRESIGNED-MARKER", "an already-current-key signature must not be replaced");
  });

  it("re-signs a version whose cached signature is under a different (stale) key", async () => {
    const packageName = "com.example.prefetch.resign";
    const version = "1.0.0";
    const tarballBytes = Buffer.from("vpm-prefetch-resign-test-tarball-bytes");
    const cacheKey = `${packageName}-${version}.tgz`;
    const sourceUrl = `https://vpm.example.com/dl/${packageName}-${version}.zip`;

    await writeTarballCache(upstream.host, packageName, cacheKey, tarballBytes);

    const seedCache: MetadataCache = {
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            author: { name: "Test Author" },
            dist: {
              tarball: "",
              original: sourceUrl,
              shasum: "1111111111111111111111111111111111111111",
              integrity: "sha512-STALE",
              signatures: [{ keyid: "SHA256:not-the-current-proxy-key", sig: "STALE-MARKER" }]
            }
          }
        }
      }
    };
    await writeMetadataCache(upstream.host, packageName, seedCache);

    await prefetchForPackage(
      upstream,
      packageName,
      { [version]: { name: packageName, version, url: sourceUrl } },
      undefined,
      0,
      noopLog
    );

    const after1 = await readMetadataCache(upstream.host, packageName);
    const dist = after1?.metadata.versions[version].dist;
    assert.ok(dist, "expected the version's dist to still be present");

    const expectedIntegrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
    assert.equal(dist.integrity, expectedIntegrity);
    assert.equal(dist.signatures[0].keyid, proxyKey.keyid);
    assert.notEqual(dist.signatures[0].sig, "STALE-MARKER");
    assert.equal(
      cryptoVerify(
        "sha256",
        Buffer.from(`${packageName}@${version}:${expectedIntegrity}`),
        proxyPublicKey,
        Buffer.from(dist.signatures[0].sig, "base64")
      ),
      true,
      "a stale-key cached signature must be replaced with a fresh, verifiable signature under the current proxy key"
    );
  });
});
