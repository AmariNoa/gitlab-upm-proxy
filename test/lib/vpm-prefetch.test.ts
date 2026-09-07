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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-vpm-prefetch-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;

import { getProxySigningKey } from "../../src/lib/npm-signatures";
import { prefetchForPackage, prefetchForUpstream } from "../../src/lib/vpm-prefetch";
import {
  getMetadataCachePath,
  getTarballCachePath,
  readMetadataCache,
  readTarballCache,
  updateMetadataCache,
  writeMetadataCache,
  writeTarballCache,
  type MetadataCache
} from "../../src/lib/cache";
import { computeSha1, runTempLocked } from "../../src/lib/tgz";
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

  // Regression for the fifth review round: comparing shasums catches an archive that
  // changed BEFORE the read, not one that changes after it. This test drives that exact
  // order - the prefetch reads the archive, and only then does another writer replace it
  // and publish the replacement's signature - by hooking the lock the prefetch has to take
  // before it may publish. Without holding that lock across read-and-publish, the prefetch
  // writes the old archive's hash over the newer metadata.
  it("読み取り後にアーカイブが差し替えられても、古い署名で新しいメタデータを上書きしない", async () => {
    const packageName = "com.example.prefetch.interleaved";
    const version = "1.0.0";
    const cacheKey = `${packageName}-${version}.tgz`;
    const sourceUrl = `${ZIP_ORIGIN}/dl/${packageName}-${version}.zip`;

    const oldBytes = Buffer.from("the-archive-present-when-the-pass-starts");
    const newBytes = Buffer.from("the-archive-another-writer-publishes-later");
    await writeTarballCache(upstream.host, packageName, cacheKey, oldBytes);

    const oldIntegrity = `sha512-${createHash("sha512").update(oldBytes).digest("base64")}`;
    const newIntegrity = `sha512-${createHash("sha512").update(newBytes).digest("base64")}`;

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
              shasum: computeSha1(oldBytes),
              integrity: oldIntegrity,
              signatures: [{ keyid: proxyKey.keyid, sig: "SIGNATURE-OF-THE-OLD-ARCHIVE" }]
            }
          }
        }
      }
    };
    await writeMetadataCache(upstream.host, packageName, seedCache);

    // Racing the two writers and inspecting the outcome cannot pin this down: whether the
    // bad interleaving happens is up to the event loop. What CAN be pinned is the property
    // that prevents it - the prefetch must not publish while another writer holds the
    // package's lock. So the lock is taken here first and held; with the fix the prefetch
    // blocks on it and cannot finish, and without it the prefetch sails past and publishes
    // the old archive's hash over what this block just wrote.
    const packageDir = dirname(getTarballCachePath(upstream.host, packageName, cacheKey));
    let releaseLock = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = () => resolve();
    });
    const holder = runTempLocked(packageDir, async () => {
      // Stand in for another writer that has replaced the archive and published its
      // signature, and is still inside its own critical section.
      await writeTarballCache(upstream.host, packageName, cacheKey, newBytes);
      await updateMetadataCache(upstream.host, packageName, (current) => {
        const target = current?.metadata;
        if (!target?.versions?.[version]?.dist) return null;
        target.versions[version].dist.shasum = computeSha1(newBytes);
        target.versions[version].dist.integrity = newIntegrity;
        target.versions[version].dist.signatures = [
          { keyid: proxyKey.keyid, sig: "SIGNATURE-OF-THE-NEW-ARCHIVE" }
        ];
        return {
          latestVersion: current?.latestVersion ?? version,
          author: current?.author,
          displayName: current?.displayName,
          metadata: target
        };
      });
      await lockHeld;
    });

    const prefetch = prefetchForPackage(
      upstream,
      packageName,
      { [version]: { name: packageName, version, url: sourceUrl } },
      undefined,
      0,
      noopLog
    );

    // Everything the prefetch does here is local filesystem work, so if it is going to
    // finish without the lock it finishes well inside this window.
    const stillBlocked = Symbol("still blocked");
    const raced = await Promise.race([
      prefetch.then(() => "finished" as const),
      new Promise<typeof stillBlocked>((resolve) => setTimeout(() => resolve(stillBlocked), 300))
    ]);
    assert.equal(raced, stillBlocked, "the prefetch must not publish while another writer holds the lock");

    releaseLock();
    await holder;
    await prefetch;

    // And once it does run, what it publishes must describe the archive on disk.
    const finalCache = await readMetadataCache(upstream.host, packageName);
    const dist = finalCache?.metadata.versions[version].dist;
    assert.ok(dist);
    const served = await readTarballCache(upstream.host, packageName, cacheKey);
    assert.ok(served);
    assert.equal(dist.shasum, computeSha1(served!), "the published shasum must match the archive on disk");
    assert.equal(
      dist.integrity,
      `sha512-${createHash("sha512").update(served!).digest("base64")}`,
      "the published integrity must match the archive on disk"
    );
    assert.equal(oldIntegrity === newIntegrity, false, "precondition: the two archives must differ");
  });

  // Regression for the fifth review round: the startup pass took the cached snapshot
  // wholesale, so its work list only ever held versions that were already cached. A version
  // published since the last run was never fetched, never got a shasum, and was therefore
  // filtered out of every metadata response until a search request happened to trigger the
  // per-package prefetch instead.
  it("起動時パスは、インデックスに現れた新しいバージョンも取り込む", async () => {
    const packageName = "com.example.prefetch.newversion";
    const cachedVersion = "1.0.0";
    const newVersion = "2.0.0";
    const indexPath = "/new-version-index.json";
    const newZipPath = `/dl/${packageName}-${newVersion}.zip`;
    const flushUpstream: UpstreamEntry = {
      baseUrl: `${ZIP_ORIGIN}${indexPath}`,
      host: "vpm-prefetch-newversion.example.com",
      type: "vpm"
    };

    // Already cached and signed: 1.0.0 only.
    const cachedBytes = Buffer.from("the-already-cached-archive");
    await writeTarballCache(
      flushUpstream.host,
      packageName,
      `${packageName}-${cachedVersion}.tgz`,
      cachedBytes
    );
    await writeMetadataCache(flushUpstream.host, packageName, {
      latestVersion: cachedVersion,
      metadata: {
        name: packageName,
        "dist-tags": { latest: cachedVersion },
        versions: {
          [cachedVersion]: {
            name: packageName,
            version: cachedVersion,
            author: { name: "Test Author" },
            dist: {
              tarball: "",
              original: `${ZIP_ORIGIN}/dl/${packageName}-${cachedVersion}.zip`,
              shasum: computeSha1(cachedBytes),
              integrity: `sha512-${createHash("sha512").update(cachedBytes).digest("base64")}`,
              signatures: [{ keyid: proxyKey.keyid, sig: "SIGNATURE-OF-THE-CACHED-ARCHIVE" }]
            }
          }
        }
      }
    });

    // The index has both, including the newly published 2.0.0.
    mockAgent
      .get(ZIP_ORIGIN)
      .intercept({ path: indexPath, method: "GET" })
      .reply(
        200,
        {
          packages: {
            [packageName]: {
              versions: {
                [cachedVersion]: {
                  name: packageName,
                  version: cachedVersion,
                  url: `${ZIP_ORIGIN}/dl/${packageName}-${cachedVersion}.zip`
                },
                [newVersion]: {
                  name: packageName,
                  version: newVersion,
                  url: `${ZIP_ORIGIN}${newZipPath}`
                }
              }
            }
          }
        },
        { headers: { "content-type": "application/json" } }
      );

    const zipBuffer = buildStoredZip([
      {
        name: "package.json",
        data: Buffer.from(
          JSON.stringify({ name: packageName, version: newVersion, author: { name: "Zip Author" } }, null, 2),
          "utf-8"
        )
      }
    ]);
    mockAgent
      .get(ZIP_ORIGIN)
      .intercept({ path: newZipPath, method: "GET" })
      .reply(200, zipBuffer, { headers: { "content-type": "application/zip" } });

    await prefetchForUpstream(flushUpstream, 0, noopLog);

    const finalCache = await readMetadataCache(flushUpstream.host, packageName);
    const newDist = finalCache?.metadata.versions[newVersion]?.dist;
    assert.ok(newDist, "the newly published version must be present in the cache");
    assert.equal(typeof newDist.shasum, "string");
    assert.equal(newDist.shasum.length, 40, "the new version must have been fetched and hashed");
    assert.equal(newDist.signatures[0].keyid, proxyKey.keyid);

    // The already-cached version keeps its own signature.
    const cachedDist = finalCache?.metadata.versions[cachedVersion]?.dist;
    assert.ok(cachedDist);
    assert.equal(cachedDist.signatures[0].sig, "SIGNATURE-OF-THE-CACHED-ARCHIVE");
  });

  // Regression for the seventh review round: the decision to download is taken before the
  // lock, and the download is slow enough for another writer to publish the same version in
  // the meantime. Converting anyway replaces a published archive with different bytes -
  // author injection rewrites package.json, so two conversions do not agree byte for byte -
  // and a client holding the first archive's metadata can no longer verify what it gets.
  it("ロック取得前にダウンロードしても、既に公開済みのアーカイブは作り直さない", async () => {
    const packageName = "com.example.prefetch.recheck";
    const version = "1.0.0";
    const cacheKey = `${packageName}-${version}.tgz`;
    const zipPath = `/dl/${packageName}-${version}.zip`;
    const sourceUrl = `${ZIP_ORIGIN}${zipPath}`;

    // No archive yet, so the pass decides to download.
    await writeMetadataCache(upstream.host, packageName, {
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            author: { name: "Test Author" },
            dist: { tarball: "", original: sourceUrl }
          }
        }
      }
    });

    const zipBuffer = buildStoredZip([
      {
        name: "package.json",
        data: Buffer.from(JSON.stringify({ name: packageName, version }, null, 2), "utf-8")
      }
    ]);

    // Published by "another writer" while this pass is downloading: the reply callback runs
    // at exactly that point, and writes synchronously so it lands before the lock is taken.
    const publishedBytes = Buffer.from("archive-published-by-another-writer");
    mockAgent
      .get(ZIP_ORIGIN)
      .intercept({ path: zipPath, method: "GET" })
      .reply(() => {
        writeFileSync(getTarballCachePath(upstream.host, packageName, cacheKey), publishedBytes);
        return { statusCode: 200, data: zipBuffer };
      });

    await prefetchForPackage(
      upstream,
      packageName,
      { [version]: { name: packageName, version, url: sourceUrl } },
      undefined,
      0,
      noopLog
    );

    const served = await readTarballCache(upstream.host, packageName, cacheKey);
    assert.ok(served);
    assert.deepEqual(served, publishedBytes, "the already-published archive must not be replaced");

    // And the metadata must describe those same bytes.
    const cache = await readMetadataCache(upstream.host, packageName);
    const dist = cache?.metadata.versions[version].dist;
    assert.ok(dist);
    assert.equal(dist.shasum, computeSha1(publishedBytes));
    assert.equal(
      dist.integrity,
      `sha512-${createHash("sha512").update(publishedBytes).digest("base64")}`
    );
  });

  // Regression for the seventh review round: the conversion renames the new archive into
  // place before the metadata that describes it is written. If that write fails, the cache
  // was left serving the new bytes under the previous signature, and nothing repaired it -
  // the signature reuse check passes because the keyid still matches.
  it("メタデータ書き込みが失敗した場合、公開したアーカイブを残さない", async () => {
    const packageName = "com.example.prefetch.publishfail";
    const version = "1.0.0";
    const cacheKey = `${packageName}-${version}.tgz`;
    const zipPath = `/dl/${packageName}-${version}.zip`;
    const sourceUrl = `${ZIP_ORIGIN}${zipPath}`;

    await writeMetadataCache(upstream.host, packageName, {
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            author: { name: "Test Author" },
            dist: { tarball: "", original: sourceUrl }
          }
        }
      }
    });

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

    // Make the metadata write fail: a directory where the JSON file has to go cannot be
    // replaced by a file, so writeJsonAtomic's rename throws.
    const metadataPath = getMetadataCachePath(upstream.host, packageName);
    rmSync(metadataPath, { force: true });
    mkdirSync(metadataPath, { recursive: true });

    await prefetchForPackage(
      upstream,
      packageName,
      { [version]: { name: packageName, version, url: sourceUrl } },
      undefined,
      0,
      noopLog
    );

    const served = await readTarballCache(upstream.host, packageName, cacheKey);
    assert.equal(
      served,
      null,
      "an archive whose metadata could not be published must not be left in the cache"
    );

    rmSync(metadataPath, { recursive: true, force: true });
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
