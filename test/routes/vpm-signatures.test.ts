// Route tests verifying that VPM-origin metadata responses persist npm ECDSA
// signatures (dist.integrity / dist.signatures) into the on-disk metadata cache and
// reuse them on later requests instead of recomputing them every time.
//
// Module-load env vars: TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL are
// read exactly once at module load time by src/lib/cache.ts, src/lib/upstreams.ts and
// src/routes/gitlab-npm-proxy.ts, and VPM_PREFETCH_INTERVAL_SEC once per prefetch run by
// src/lib/vpm-prefetch.ts. They are therefore assigned below BEFORE any src/ module is
// imported (see test/routes/gitlab-npm-proxy.test.ts for the same constraint).
//
// Race with the background VPM prefetch: src/app.ts calls startVpmPrefetch(fastify.log)
// on every app build, and that unawaited background task scans every configured VPM
// upstream's index and can rewrite the same metadata.json files this file seeds by
// hand. To stay deterministic without sleeping, every VPM index request made by the
// route handler under test (src/routes/gitlab-npm-proxy.ts fetchVpmIndex) carries a
// distinct "x-vpm-test-route" marker header — buildUpstreamHeadersFor/buildUpstreamHeaders
// forward any request header not on their small deny-list, so the marker reaches the
// mocked upstream. The background prefetch's own index fetch
// (src/lib/vpm-prefetch.ts fetchVpmIndex) never sends any custom headers, so a
// dedicated mock interceptor keyed on "marker absent" always answers it with an empty
// package list, regardless of call ordering, and it never touches the packages under
// test here.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-vpm-sig-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.vpm.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.vpm.example.net";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import { build, TestContext } from "../helper";
import { getProxySigningKey } from "../../src/lib/npm-signatures";
import {
  getMetadataCachePath,
  readMetadataCache,
  writeMetadataCache,
  writeTarballCache,
  type MetadataCache
} from "../../src/lib/cache";

const DEFAULT_ORIGIN = "https://gitlab.example.com";
const VPM_ORIGIN = "https://vpm.example.com";
const VPM_HOST = "vpm.example.com";

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (typeof v === "string") out[key.toLowerCase()] = v;
  }
  return out;
}

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  // The background prefetch never sends a marker header, so it always lands here and
  // gets an empty package list: it never reads or rewrites the caches this file seeds.
  mockAgent
    .get(VPM_ORIGIN)
    .intercept({
      path: "/index.json",
      method: "GET",
      headers(headers) {
        return !normalizeHeaders(headers)["x-vpm-test-route"];
      }
    })
    .reply(200, { packages: {} }, { headers: { "content-type": "application/json" } })
    .persist();

  // Valid PAT for every /api/v4/user check performed by the onRequest hook.
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: "/api/v4/user", method: "GET" })
    .reply(200, { id: 1, username: "tester" })
    .persist();
});

after(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

/** Registers a persistent VPM index response that answers only requests carrying the given x-vpm-test-route marker. */
function mockVpmIndex(marker: string, index: any): void {
  mockAgent
    .get(VPM_ORIGIN)
    .intercept({
      path: "/index.json",
      method: "GET",
      headers(headers) {
        return normalizeHeaders(headers)["x-vpm-test-route"] === marker;
      }
    })
    .reply(200, index, { headers: { "content-type": "application/json" } })
    .persist();
}

async function readDiskMetadata(packageName: string): Promise<MetadataCache> {
  const cache = await readMetadataCache(VPM_HOST, packageName);
  if (!cache) {
    throw new Error(`expected a metadata cache entry for ${packageName}`);
  }
  return cache;
}

// Generated once at module load (after TARBALL_CACHE_DIR is set), same as the route
// handler will lazily generate/read on first use — both share the same cached module.
const proxyKey = getProxySigningKey();
const proxyPublicKey = createPublicKey({
  key: Buffer.from(proxyKey.key, "base64"),
  format: "der",
  type: "spki"
});

test(
  "VPMメタデータのdist署名がキャッシュへ永続化され、2回目以降は再計算されず再利用され、keyid不一致時のみ再署名される",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.pkg";
    const marker = "case-hit";
    const version = "1.0.0";
    const tarballBytes = Buffer.from("vpm-signatures-test-tarball-bytes-for-cache-hit-path");
    const cacheKey = `${packageName}-${version}.tgz`;
    const requestUrl = `/api/v4/groups/my-group/${packageName}`;
    const requestHeaders = { "private-token": "valid-token", "x-vpm-test-route": marker };

    mockVpmIndex(marker, {
      author: "VPM Author",
      packages: {
        [packageName]: {
          versions: {
            [version]: {
              name: packageName,
              version,
              description: "vpm cache-hit test package",
              url: `https://vpm.example.com/dl/${packageName}-${version}.zip`
            }
          }
        }
      }
    });

    const seedCache: MetadataCache = {
      latestVersion: version,
      author: "Test Author",
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            description: "vpm cache-hit test package",
            author: { name: "Test Author" },
            dist: {
              tarball: "",
              shasum: "0000000000000000000000000000000000000000"
            }
          }
        }
      }
    };
    await writeMetadataCache(VPM_HOST, packageName, seedCache);
    await writeTarballCache(VPM_HOST, packageName, cacheKey, tarballBytes);

    // --- (a) cache-hit path: the first request signs the cached tarball and persists it.
    const app1 = await build(t);
    const res1 = await app1.inject({ method: "GET", url: requestUrl, headers: requestHeaders });
    assert.equal(res1.statusCode, 200);
    const body1 = res1.json() as { versions: Record<string, { dist: Record<string, any> }> };
    const dist1 = body1.versions[version].dist;

    const expectedIntegrity = `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}`;
    assert.equal(dist1.integrity, expectedIntegrity);
    assert.equal(dist1.signatures.length, 1);
    assert.equal(dist1.signatures[0].keyid, proxyKey.keyid);
    assert.equal(
      cryptoVerify(
        "sha256",
        Buffer.from(`${packageName}@${version}:${expectedIntegrity}`),
        proxyPublicKey,
        Buffer.from(dist1.signatures[0].sig, "base64")
      ),
      true,
      "signature from the first request must verify against the proxy's published public key"
    );

    const diskAfterFirst = await readDiskMetadata(packageName);
    const diskDistAfterFirst = diskAfterFirst.metadata.versions[version].dist;
    assert.equal(diskDistAfterFirst.integrity, expectedIntegrity);
    assert.deepEqual(diskDistAfterFirst.signatures, dist1.signatures);

    // --- (b) reuse path: mark the persisted signature and confirm a second request
    //     returns it unchanged, proving it was not recomputed.
    const reusedMarker: MetadataCache = JSON.parse(JSON.stringify(diskAfterFirst));
    reusedMarker.metadata.versions[version].dist.signatures[0].sig = "REUSED-MARKER";
    await writeMetadataCache(VPM_HOST, packageName, reusedMarker);

    const app2 = await build(t);
    const res2 = await app2.inject({ method: "GET", url: requestUrl, headers: requestHeaders });
    assert.equal(res2.statusCode, 200);
    const body2 = res2.json() as { versions: Record<string, { dist: Record<string, any> }> };
    const dist2 = body2.versions[version].dist;
    assert.equal(dist2.signatures[0].keyid, proxyKey.keyid);
    assert.equal(dist2.signatures[0].sig, "REUSED-MARKER", "an unchanged keyid must not trigger re-signing");

    const diskAfterReuse = await readDiskMetadata(packageName);
    assert.equal(diskAfterReuse.metadata.versions[version].dist.signatures[0].sig, "REUSED-MARKER");

    // --- (c) keyid-mismatch path: a signature under a different key is treated as
    //     unsigned and replaced with a fresh, verifiable signature under the current key.
    const staleKeyMarker: MetadataCache = JSON.parse(JSON.stringify(diskAfterReuse));
    staleKeyMarker.metadata.versions[version].dist.signatures[0].keyid = "SHA256:not-the-current-proxy-key";
    await writeMetadataCache(VPM_HOST, packageName, staleKeyMarker);

    const app3 = await build(t);
    const res3 = await app3.inject({ method: "GET", url: requestUrl, headers: requestHeaders });
    assert.equal(res3.statusCode, 200);
    const body3 = res3.json() as { versions: Record<string, { dist: Record<string, any> }> };
    const dist3 = body3.versions[version].dist;
    assert.equal(dist3.integrity, expectedIntegrity);
    assert.equal(dist3.signatures[0].keyid, proxyKey.keyid);
    assert.notEqual(dist3.signatures[0].sig, "REUSED-MARKER");
    assert.equal(
      cryptoVerify(
        "sha256",
        Buffer.from(`${packageName}@${version}:${dist3.integrity}`),
        proxyPublicKey,
        Buffer.from(dist3.signatures[0].sig, "base64")
      ),
      true,
      "a mismatched cached keyid must be re-signed under the current proxy key"
    );
  }
);

test(
  "VPMメタデータのキャッシュミス時、tgz済みバージョンの署名は引き継がれtgz未取得バージョンは応答から除外される",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.pkg2";
    const marker = "case-miss";
    const cachedVersion = "1.0.0";
    const newVersion = "2.0.0";

    mockVpmIndex(marker, {
      author: "VPM Author",
      packages: {
        [packageName]: {
          versions: {
            [cachedVersion]: {
              name: packageName,
              version: cachedVersion,
              description: "vpm cache-miss test package",
              author: { name: "Test Author" },
              url: `https://vpm.example.com/dl/${packageName}-${cachedVersion}.zip`
            },
            [newVersion]: {
              name: packageName,
              version: newVersion,
              description: "vpm cache-miss test package",
              author: { name: "Test Author" },
              url: `https://vpm.example.com/dl/${packageName}-${newVersion}.zip`
            }
          }
        }
      }
    });

    // Seed cache is stale (latestVersion still 1.0.0), so the index's 2.0.0 forces the
    // cache-miss branch. 1.0.0 already carries a persisted signature to prove it is
    // carried over rather than recomputed: no tarball is cached for either version here
    // because applyVpmSignaturesFromCache short-circuits via hasProxySignature before
    // ever reading one for 1.0.0, and 2.0.0 is skipped for lacking a shasum entirely.
    const seedCache: MetadataCache = {
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
              shasum: "1111111111111111111111111111111111111111",
              integrity: "sha512-PRESET-CARRIED-OVER",
              signatures: [{ keyid: proxyKey.keyid, sig: "CARRIED-OVER-MARKER" }]
            }
          }
        }
      }
    };
    await writeMetadataCache(VPM_HOST, packageName, seedCache);

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      "dist-tags": Record<string, string>;
      versions: Record<string, { dist: Record<string, any> }>;
    };

    assert.deepEqual(Object.keys(body.versions), [cachedVersion]);
    assert.equal(body["dist-tags"].latest, cachedVersion);
    const dist = body.versions[cachedVersion].dist;
    assert.equal(dist.integrity, "sha512-PRESET-CARRIED-OVER");
    assert.equal(dist.signatures[0].sig, "CARRIED-OVER-MARKER");
    assert.equal(dist.signatures[0].keyid, proxyKey.keyid);
  }
);

// Regression for the eighth review round: when the upstream withdraws a version that is not
// the latest one, latestVersion still matches the cache, so every metadata request takes the
// cache-hit branch. That branch served and rewrote the cached copy without ever consulting
// the index's version list, so the withdrawn version stayed advertised indefinitely.
test(
  "最新版以外が上流から削除された場合、応答とキャッシュの両方から消える",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.withdrawn";
    const withdrawn = "1.0.0";
    const latest = "2.0.0";
    const marker = "withdrawn-non-latest";

    const tarballBytes = Buffer.from("withdrawn-test-tarball-bytes");
    await writeTarballCache(VPM_HOST, packageName, `${packageName}-${latest}.tgz`, tarballBytes);
    await writeTarballCache(VPM_HOST, packageName, `${packageName}-${withdrawn}.tgz`, tarballBytes);

    const signedDist = (sig: string) => ({
      tarball: "",
      original: `${VPM_ORIGIN}/dl/${packageName}.zip`,
      shasum: createHash("sha1").update(tarballBytes).digest("hex"),
      integrity: `sha512-${sig}`,
      signatures: [{ keyid: proxyKey.keyid, sig }]
    });

    // Both versions are cached and signed; latest is 2.0.0.
    await writeMetadataCache(VPM_HOST, packageName, {
      latestVersion: latest,
      metadata: {
        name: packageName,
        "dist-tags": { latest },
        versions: {
          // author present on purpose: without it the route tries to read one out of the
          // tarball, and these bytes are not a real archive.
          [withdrawn]: {
            name: packageName,
            version: withdrawn,
            author: { name: "Test Author" },
            dist: signedDist("ONE")
          },
          [latest]: {
            name: packageName,
            version: latest,
            author: { name: "Test Author" },
            dist: signedDist("TWO")
          }
        }
      }
    });

    // The index no longer lists 1.0.0, but 2.0.0 is unchanged, so latestVersion still
    // matches and the request takes the cache-hit branch.
    mockVpmIndex(marker, {
      packages: {
        [packageName]: {
          versions: {
            [latest]: { name: packageName, version: latest, url: `${VPM_ORIGIN}/dl/${packageName}.zip` }
          }
        }
      }
    });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { versions: Record<string, unknown> };
    assert.deepEqual(
      Object.keys(body.versions),
      [latest],
      "the withdrawn version must not be advertised any more"
    );

    const disk = await readDiskMetadata(packageName);
    assert.equal(
      disk.metadata.versions[withdrawn],
      undefined,
      "the withdrawn version must be gone from the cache as well"
    );
    assert.ok(disk.metadata.versions[latest], "the version still in the index must stay");
  }
);

// Regression for the ninth review round: a package the index does not list was deleted
// outright - metadata and archives - without asking whether this request could possibly know
// that. A malformed index is not evidence of a withdrawal, and neither is an index older
// than a package another writer has just published.
test(
  "packagesを持たない不正なインデックスでは、キャッシュを削除しない",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.malformed";
    const version = "1.0.0";
    const marker = "malformed-index";

    await writeMetadataCache(VPM_HOST, packageName, {
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            author: { name: "Test Author" },
            dist: { tarball: "", shasum: "d".repeat(40), integrity: "sha512-KEEP", signatures: [] }
          }
        }
      }
    });

    // A 200 carrying a structurally useless document.
    mockVpmIndex(marker, {});

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    // A 200 carrying nothing usable is the registry failing to answer, not a statement that
    // the package is gone - reporting absence would tell clients and caches to stop asking.
    assert.equal(res.statusCode, 502, "an unusable index is an upstream failure, not an absence");
    const disk = await readMetadataCache(VPM_HOST, packageName);
    assert.ok(disk, "but the cache must survive it");
    assert.equal(disk!.metadata.versions[version].dist.integrity, "sha512-KEEP");
  }
);

test(
  "インデックスに無いパッケージでも、基準に無ければ削除しない",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.concurrentpkg";
    const version = "1.0.0";
    const marker = "concurrent-package";

    const publishedCache = {
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            author: { name: "Test Author" },
            dist: { tarball: "", shasum: "e".repeat(40), integrity: "sha512-CONCURRENT", signatures: [] }
          }
        }
      }
    };

    // The index this request reads lists another package, not this one - and the package it
    // omits is published by "another writer" from inside this reply, i.e. after the request
    // has taken its baseline and before it sees the index. Written synchronously because a
    // mock reply callback cannot be async.
    mockAgent
      .get(VPM_ORIGIN)
      .intercept({
        path: "/index.json",
        method: "GET",
        headers(headers) {
          return normalizeHeaders(headers)["x-vpm-test-route"] === marker;
        }
      })
      .reply(() => {
        const metadataPath = getMetadataCachePath(VPM_HOST, packageName);
        mkdirSync(dirname(metadataPath), { recursive: true });
        writeFileSync(metadataPath, JSON.stringify(publishedCache, null, 2), "utf-8");
        return {
          statusCode: 200,
          data: {
            packages: {
              "com.example.vpm.other": {
                versions: {
                  "1.0.0": { name: "com.example.vpm.other", version: "1.0.0", url: `${VPM_ORIGIN}/dl/o.zip` }
                }
              }
            }
          },
          responseOptions: { headers: { "content-type": "application/json" } }
        };
      })
      .persist();

    const app = await build(t);

    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    assert.equal(res.statusCode, 404, "this request cannot serve a package its index does not list");
    const disk = await readMetadataCache(VPM_HOST, packageName);
    assert.ok(disk, "but it must not delete what another writer published");
    assert.equal(disk!.metadata.versions[version].dist.integrity, "sha512-CONCURRENT");
  }
);

// Regression for the tenth review round: an index entry that names the package but carries no
// usable versions map is a malformed document, not a withdrawal, and must not delete anything.
test(
  "パッケージを列挙しつつversionsが不正なインデックスでは、キャッシュを削除しない",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.badentry";
    const version = "1.0.0";
    const marker = "bad-entry";

    await writeMetadataCache(VPM_HOST, packageName, {
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            author: { name: "Test Author" },
            dist: { tarball: "", shasum: "f".repeat(40), integrity: "sha512-KEEP-ENTRY", signatures: [] }
          }
        }
      }
    });

    mockVpmIndex(marker, { packages: { [packageName]: {} } });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    assert.equal(res.statusCode, 502, "a malformed entry is an upstream failure, not an absence");
    const disk = await readMetadataCache(VPM_HOST, packageName);
    assert.ok(disk, "a malformed entry must not delete the cache");
    assert.equal(disk!.metadata.versions[version].dist.integrity, "sha512-KEEP-ENTRY");
  }
);

// And a withdrawal of the whole package removes only what the baseline knew about: a version
// another writer published while the index request was in flight has to survive.
test(
  "パッケージ全体の削除でも、基準以後に公開された版は残る",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.partialwithdraw";
    const known = "1.0.0";
    const concurrent = "2.0.0";
    const marker = "partial-withdraw";

    const distFor = (sig: string) => ({
      tarball: "",
      shasum: "9".repeat(40),
      integrity: `sha512-${sig}`,
      signatures: []
    });

    // The baseline: only 1.0.0 is cached when the request starts.
    await writeMetadataCache(VPM_HOST, packageName, {
      latestVersion: known,
      metadata: {
        name: packageName,
        "dist-tags": { latest: known },
        versions: {
          [known]: { name: packageName, version: known, author: { name: "A" }, dist: distFor("KNOWN") }
        }
      }
    });

    // 2.0.0 is published from inside the index reply: after the baseline, before the answer.
    mockAgent
      .get(VPM_ORIGIN)
      .intercept({
        path: "/index.json",
        method: "GET",
        headers(headers) {
          return normalizeHeaders(headers)["x-vpm-test-route"] === marker;
        }
      })
      .reply(() => {
        const metadataPath = getMetadataCachePath(VPM_HOST, packageName);
        mkdirSync(dirname(metadataPath), { recursive: true });
        writeFileSync(
          metadataPath,
          JSON.stringify(
            {
              latestVersion: concurrent,
              metadata: {
                name: packageName,
                "dist-tags": { latest: concurrent },
                versions: {
                  [known]: { name: packageName, version: known, author: { name: "A" }, dist: distFor("KNOWN") },
                  [concurrent]: {
                    name: packageName,
                    version: concurrent,
                    author: { name: "A" },
                    dist: distFor("CONCURRENT")
                  }
                }
              }
            },
            null,
            2
          ),
          "utf-8"
        );
        // The package itself is gone from this (older) index.
        return {
          statusCode: 200,
          data: { packages: {} },
          responseOptions: { headers: { "content-type": "application/json" } }
        };
      })
      .persist();

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    assert.equal(res.statusCode, 404);
    const disk = await readMetadataCache(VPM_HOST, packageName);
    assert.ok(disk, "the package must survive because a version was published concurrently");
    assert.equal(disk!.metadata.versions[known], undefined, "the withdrawn version goes");
    assert.ok(disk!.metadata.versions[concurrent], "the concurrent publication stays");
    assert.equal(disk!.latestVersion, concurrent);
  }
);

// Regression for the tenth review round: an index listing the package with an empty versions
// map is a valid statement that everything was withdrawn, but pickLatestVpmVersion returns
// null for it and the refresh was skipped on that condition - so the response reported the
// withdrawal while the cache kept every version for good.
test(
  "versionsが空のインデックスでも、キャッシュ側の版が反映される",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.emptyversions";
    const version = "1.0.0";
    const marker = "empty-versions";

    await writeMetadataCache(VPM_HOST, packageName, {
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            author: { name: "Test Author" },
            dist: { tarball: "", shasum: "8".repeat(40), integrity: "sha512-GONE", signatures: [] }
          }
        }
      }
    });

    mockVpmIndex(marker, { packages: { [packageName]: { versions: {} } } });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { versions: Record<string, unknown> };
    assert.deepEqual(Object.keys(body.versions), [], "nothing is advertised any more");

    const disk = await readMetadataCache(VPM_HOST, packageName);
    assert.ok(disk, "the cache entry itself may stay");
    assert.equal(
      disk!.metadata.versions[version],
      undefined,
      "but the withdrawn version must be reconciled away, not kept forever"
    );
  }
);

// Regression for cycle 2 round 2: semver.minVersion throws on a range it cannot parse, and
// neither dependency-normalisation loop caught it. One malformed dependency in one old version
// therefore took the whole package's metadata with it - a cold request answered 404 even
// though the other versions were perfectly usable.
test(
  "依存範囲が不正な版があっても、パッケージのメタデータは組み立てられる",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.baddep";
    const broken = "1.0.0";
    const good = "2.0.0";
    const marker = "bad-dependency";

    mockVpmIndex(marker, {
      packages: {
        [packageName]: {
          versions: {
            [broken]: {
              name: packageName,
              version: broken,
              url: `${VPM_ORIGIN}/dl/${packageName}-${broken}.zip`,
              vpmDependencies: { "com.example.dep": "not-a-range" }
            },
            [good]: {
              name: packageName,
              version: good,
              url: `${VPM_ORIGIN}/dl/${packageName}-${good}.zip`,
              vpmDependencies: { "com.example.dep": "1.2.3" }
            }
          }
        }
      }
    });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    assert.equal(res.statusCode, 200, "one unparseable range must not fail the whole package");
    const body = res.json() as { name: string };
    assert.equal(body.name, packageName);
  }
);
