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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { writeMetadataCache, writeTarballCache, readMetadataCache, type MetadataCache } from "../../src/lib/cache";

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
