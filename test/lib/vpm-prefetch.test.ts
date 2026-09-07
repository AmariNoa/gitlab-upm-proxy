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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-vpm-prefetch-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;

import { getProxySigningKey } from "../../src/lib/npm-signatures";
import { prefetchForPackage, prefetchForUpstream } from "../../src/lib/vpm-prefetch";
import {
  getMetadataCachePath,
  readMetadataCache,
  readTarballCache,
  writeMetadataCache,
  writeTarballCache,
  type MetadataCache
} from "../../src/lib/cache";
import { computeSha1 } from "../../src/lib/tgz";
import { buildStoredZip } from "./zip-fixture";
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

const ZIP_ORIGIN = "https://vpm.example.com";

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

after(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
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
              // Must match the bytes on disk: the reuse this test pins is only correct
              // while the cached signature actually describes the cached archive. Seeding a
              // shasum that disagrees with the file (as this test used to) asserted an
              // inconsistent state - updated shasum, stale integrity - as the desired one.
              shasum: computeSha1(tarballBytes),
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
    assert.equal(dist.shasum, computeSha1(tarballBytes), "shasum must still be (re)computed from the tgz on disk and be unchanged");
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

  // Regression for the second review round: reusing the cached signature purely because
  // it carries the current keyid is wrong when the archive itself was just rebuilt. The
  // author-injection path deliberately re-downloads and re-converts an existing tgz, so
  // its bytes change and the cached integrity - a hash of the previous archive - stops
  // matching what the proxy now serves.
  it("re-signs a version whose archive was regenerated to inject the VPM author", async () => {
    const packageName = "com.example.prefetch.reconvert";
    const version = "1.0.0";
    const cacheKey = `${packageName}-${version}.tgz`;
    const zipPath = `/dl/${packageName}-${version}.zip`;
    const sourceUrl = `${ZIP_ORIGIN}${zipPath}`;

    // A cached "tgz" with no author inside: readAuthorFromTgz finds nothing, so the
    // prefetch pass regenerates the archive from the zip below.
    const staleBytes = Buffer.from("not-a-real-tgz-so-it-carries-no-author");
    await writeTarballCache(upstream.host, packageName, cacheKey, staleBytes);

    const zipBuffer = buildStoredZip([
      {
        name: "package.json",
        data: Buffer.from(JSON.stringify({ name: packageName, version }, null, 2), "utf-8")
      }
    ]);
    mockAgent
      .get(ZIP_ORIGIN)
      .intercept({ path: zipPath, method: "GET" })
      .reply(200, zipBuffer, { headers: { "content-type": "application/zip" } });

    // Signed under the current key, but for the STALE bytes.
    const staleIntegrity = `sha512-${createHash("sha512").update(staleBytes).digest("base64")}`;
    const seedCache: MetadataCache = {
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            dist: {
              tarball: "",
              original: sourceUrl,
              shasum: computeSha1(staleBytes),
              integrity: staleIntegrity,
              signatures: [{ keyid: proxyKey.keyid, sig: "SIGNATURE-OF-THE-OLD-ARCHIVE" }]
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
      { name: "VPM Index Author" },
      0,
      noopLog
    );

    const served = await readTarballCache(upstream.host, packageName, cacheKey);
    assert.ok(served, "expected the regenerated tgz on disk");
    assert.notDeepEqual(served, staleBytes, "precondition: the archive must have been rebuilt");

    const updated = await readMetadataCache(upstream.host, packageName);
    const dist = updated?.metadata.versions[version].dist;
    assert.ok(dist, "expected the version's dist to still be present");

    const expectedIntegrity = `sha512-${createHash("sha512").update(served!).digest("base64")}`;
    assert.equal(dist.shasum, computeSha1(served!));
    assert.equal(dist.integrity, expectedIntegrity, "integrity must describe the archive actually served");
    assert.notEqual(dist.signatures[0].sig, "SIGNATURE-OF-THE-OLD-ARCHIVE");
    assert.equal(
      cryptoVerify(
        "sha256",
        Buffer.from(`${packageName}@${version}:${expectedIntegrity}`),
        proxyPublicKey,
        Buffer.from(dist.signatures[0].sig, "base64")
      ),
      true,
      "the regenerated archive must carry a signature that verifies against its own integrity"
    );
  });

  // Regression for the fourth review round: the previous round only re-signed when THIS
  // pass rebuilt the archive. Two prefetch passes can overlap - one rebuilds the archive to
  // inject an author and publishes the new signature, while the other still holds a
  // snapshot signed for the old bytes. That second pass then hashes the new archive, keeps
  // the old signature because the keyid still matches, and writes the mismatched node back.
  it("別の書き手がアーカイブを差し替えた場合も、shasumの変化を見て再署名する", async () => {
    const packageName = "com.example.prefetch.replaced";
    const version = "1.0.0";
    const cacheKey = `${packageName}-${version}.tgz`;
    const sourceUrl = `${ZIP_ORIGIN}/dl/${packageName}-${version}.zip`;

    // The archive currently on disk: what the other writer left behind.
    const newBytes = Buffer.from("archive-rebuilt-by-another-prefetch-pass");
    await writeTarballCache(upstream.host, packageName, cacheKey, newBytes);

    // The snapshot this pass carries: signed under the current key, for the OLD bytes.
    const oldBytes = Buffer.from("the-archive-this-pass-still-believes-in");
    const seedCache: MetadataCache = {
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            // An author is present, so this pass has no reason to re-download.
            author: { name: "Test Author" },
            dist: {
              tarball: "",
              original: sourceUrl,
              shasum: computeSha1(oldBytes),
              integrity: `sha512-${createHash("sha512").update(oldBytes).digest("base64")}`,
              signatures: [{ keyid: proxyKey.keyid, sig: "SIGNATURE-OF-THE-REPLACED-ARCHIVE" }]
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

    const updated = await readMetadataCache(upstream.host, packageName);
    const dist = updated?.metadata.versions[version].dist;
    assert.ok(dist);

    const expectedIntegrity = `sha512-${createHash("sha512").update(newBytes).digest("base64")}`;
    assert.equal(dist.shasum, computeSha1(newBytes));
    assert.equal(dist.integrity, expectedIntegrity, "integrity must follow the archive on disk");
    assert.notEqual(dist.signatures[0].sig, "SIGNATURE-OF-THE-REPLACED-ARCHIVE");
    assert.equal(
      cryptoVerify(
        "sha256",
        Buffer.from(`${packageName}@${version}:${expectedIntegrity}`),
        proxyPublicKey,
        Buffer.from(dist.signatures[0].sig, "base64")
      ),
      true,
      "the signature must verify against the integrity published beside it"
    );
  });

  // Regression for the second review round: the pass ends by flushing the snapshot it
  // read at the start back to disk. Doing that as a wholesale replacement undid whatever
  // another writer stored while the pass was running - here, the shasum and signature a
  // request-path download had just written for a version this pass failed to fetch.
  it("最終書き戻しは、パス実行中に別の書き手が更新したバージョンを上書きしない", async () => {
    const packageName = "com.example.prefetch.flush";
    const skipped = "1.0.0";
    const zipPath = `/dl/${packageName}-${skipped}.zip`;
    const sourceUrl = `${ZIP_ORIGIN}${zipPath}`;
    const indexPath = "/flush-index.json";
    const flushUpstream: UpstreamEntry = {
      baseUrl: `${ZIP_ORIGIN}${indexPath}`,
      host: "vpm-prefetch-flush.example.com",
      type: "vpm"
    };

    const buildCache = (dist: Record<string, unknown>): MetadataCache => ({
      latestVersion: skipped,
      metadata: {
        name: packageName,
        "dist-tags": { latest: skipped },
        versions: { [skipped]: { name: packageName, version: skipped, dist } }
      }
    });

    // What the pass reads at the start: no shasum, no signature yet.
    await writeMetadataCache(
      flushUpstream.host,
      packageName,
      buildCache({ tarball: "", original: sourceUrl })
    );

    mockAgent
      .get(ZIP_ORIGIN)
      .intercept({ path: indexPath, method: "GET" })
      .reply(
        200,
        { packages: { [packageName]: { versions: { [skipped]: { name: packageName, version: skipped, url: sourceUrl } } } } },
        { headers: { "content-type": "application/json" } }
      );

    // The download is where the concurrent writer lands: it stores a fully signed version
    // node and then fails, so this pass skips the version and keeps its stale local copy.
    mockAgent
      .get(ZIP_ORIGIN)
      .intercept({ path: zipPath, method: "GET" })
      .reply(() => {
        // Written synchronously (undici's reply callback cannot be async) straight to the
        // metadata path, which already exists from the seed write above.
        writeFileSync(
          getMetadataCachePath(flushUpstream.host, packageName),
          JSON.stringify(
            buildCache({
              tarball: "",
              original: sourceUrl,
              shasum: "2222222222222222222222222222222222222222",
              integrity: "sha512-WRITTEN-BY-THE-CONCURRENT-WRITER",
              signatures: [{ keyid: proxyKey.keyid, sig: "CONCURRENT-WRITER-SIGNATURE" }]
            }),
            null,
            2
          ),
          "utf-8"
        );
        return { statusCode: 500, data: "" };
      });

    await prefetchForUpstream(flushUpstream, 0, noopLog);

    const finalCache = await readMetadataCache(flushUpstream.host, packageName);
    const dist = finalCache?.metadata.versions[skipped].dist;
    assert.ok(dist, "expected the version to still be present");
    assert.equal(dist.integrity, "sha512-WRITTEN-BY-THE-CONCURRENT-WRITER", "the concurrent writer's integrity must survive the final flush");
    assert.equal(dist.signatures[0].sig, "CONCURRENT-WRITER-SIGNATURE", "the concurrent writer's signature must survive the final flush");
    assert.equal(dist.shasum, "2222222222222222222222222222222222222222");
  });
});
