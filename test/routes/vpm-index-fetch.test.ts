// Route tests for how the VPM index itself is fetched.
//
// The index is not the resource the caller asked for. They ask for one package document; the
// index is the whole catalogue the proxy derives it from. Two consequences were wrong:
//
//  - the caller's headers were forwarded verbatim, so a conditional request (Unity revalidates
//    what it has cached) turned the index into a 304 with no body, which was then parsed as
//    JSON and surfaced as a 404 for a package that exists;
//  - undici does not follow redirects, so an index URL answered with a 301 had the redirect
//    body parsed as the index, with the same result.
//
// Module-load env vars: TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL are read
// once at module load by src/lib/cache.ts, src/lib/upstreams.ts and
// src/routes/gitlab-npm-proxy.ts, and VPM_PREFETCH_INTERVAL_SEC once per prefetch run by
// src/lib/vpm-prefetch.ts, so they are assigned before any src/ import (same constraint
// documented in test/routes/vpm-tarball-convert.test.ts).
//
// Race with the background prefetch: src/app.ts starts it on every build, and it fetches the
// same index. It never sends custom headers, so the interceptors below are keyed on a marker
// header the route path carries and the prefetch cannot, exactly as in
// test/routes/vpm-signatures.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-vpm-index-fetch-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.vpm.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.vpm-index.example.net";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import { build, TestContext } from "../helper";
import { writeMetadataCache, type MetadataCache } from "../../src/lib/cache";

const DEFAULT_ORIGIN = "https://gitlab.example.com";
const VPM_ORIGIN = "https://vpm.example.com";

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

function indexWith(packageName: string, version: string): any {
  return {
    packages: {
      [packageName]: {
        versions: {
          [version]: {
            name: packageName,
            version,
            description: "vpm index fetch test package",
            author: { name: "Test Author" },
            url: `${VPM_ORIGIN}/dl/${packageName}-${version}.zip`
          }
        }
      }
    }
  };
}

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  // The background prefetch carries no marker, so it always lands here and sees nothing.
  mockAgent
    .get(VPM_ORIGIN)
    .intercept({
      path: "/index.json",
      method: "GET",
      headers: (headers) => !normalizeHeaders(headers)["x-vpm-test-route"]
    })
    .reply(200, { packages: {} }, { headers: { "content-type": "application/json" } })
    .persist();

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

// A registry that honours conditional requests answers the index with a 304 when the caller
// sends `If-None-Match: *`. The caller's validator describes the package document they hold,
// not the catalogue, so forwarding it asks the wrong question of the wrong resource.
test(
  "呼び出し元の条件付きヘッダはVPMインデックス取得へ転送されない",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.conditional";
    const marker = "case-conditional";

    // Answers only a request that still carries a response-narrowing header. If one reaches the
    // index, this interceptor wins and the route gets a bodyless 304.
    mockAgent
      .get(VPM_ORIGIN)
      .intercept({
        path: "/index.json",
        method: "GET",
        headers(headers) {
          const h = normalizeHeaders(headers);
          return h["x-vpm-test-route"] === marker && Boolean(h["if-none-match"] || h["range"]);
        }
      })
      .reply(304, "", { headers: { "content-type": "application/json" } })
      .persist();

    mockAgent
      .get(VPM_ORIGIN)
      .intercept({
        path: "/index.json",
        method: "GET",
        headers(headers) {
          const h = normalizeHeaders(headers);
          return h["x-vpm-test-route"] === marker && !h["if-none-match"] && !h["range"];
        }
      })
      .reply(200, indexWith(packageName, "1.0.0"), {
        headers: { "content-type": "application/json" }
      })
      .persist();

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: {
        "private-token": "valid-token",
        "x-vpm-test-route": marker,
        "if-none-match": "*",
        range: "bytes=0-10"
      }
    });

    assert.equal(res.statusCode, 200, "a conditional request must not turn the index into a 304");
    // The version list itself is filtered down to what has a cached archive, so the document
    // being built at all - rather than the 500 an unparsable 304 body produces - is the signal.
    assert.equal(res.json().name, packageName, "the package document must be built from the index");
  }
);

// undici does not follow redirects, so the 301 body was parsed as the index.
test(
  "VPMインデックスのリダイレクトは追従され、移動先のインデックスが使われる",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.redirected";
    const marker = "case-redirect";

    mockAgent
      .get(VPM_ORIGIN)
      .intercept({
        path: "/index.json",
        method: "GET",
        headers: (headers) => normalizeHeaders(headers)["x-vpm-test-route"] === marker
      })
      // A redirect body that parses as JSON but is not an index. Parsing it instead of
      // following the Location is exactly the defect, and it yields a 404 for a listed package.
      .reply(301, { moved: true }, {
        headers: { location: "/moved/index.json", "content-type": "application/json" }
      })
      .persist();

    mockAgent
      .get(VPM_ORIGIN)
      .intercept({
        path: "/moved/index.json",
        method: "GET",
        headers: (headers) => normalizeHeaders(headers)["x-vpm-test-route"] === marker
      })
      .reply(200, indexWith(packageName, "2.0.0"), {
        headers: { "content-type": "application/json" }
      })
      .persist();

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    assert.equal(res.statusCode, 200, "the redirect must be followed to the real index");
    assert.equal(
      res.json().name,
      packageName,
      "the package document must come from the redirect target, not the redirect body"
    );
  }
);

// Regression for the eighth round of the second review cycle: the response filter picked its
// dist-tags.latest by sorting every retained key with semver.rcompare, which throws on the first
// key it cannot parse. A VPM index may legitimately publish a version like "nightly" - every other
// part of the code tolerates one - and that single key turned the whole package into a 404, with
// its perfectly usable archives along with it.
test(
  "semverでないバージョンが混ざっていてもパッケージ全体が404にならない",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.nonsemver";
    const marker = "case-nonsemver";

    mockAgent
      .get(VPM_ORIGIN)
      .intercept({
        path: "/index.json",
        method: "GET",
        headers: (headers) => normalizeHeaders(headers)["x-vpm-test-route"] === marker
      })
      .reply(
        200,
        {
          packages: {
            [packageName]: {
              versions: {
                "1.0.0": { name: packageName, version: "1.0.0", author: { name: "A" } },
                nightly: { name: packageName, version: "nightly", author: { name: "A" } }
              }
            }
          }
        },
        { headers: { "content-type": "application/json" } }
      )
      .persist();

    // Both versions already have an archive, so both survive the response filter and the sort has
    // a non-semver key to trip over.
    const seeded: MetadataCache = {
      latestVersion: "1.0.0",
      metadata: {
        name: packageName,
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: packageName,
            version: "1.0.0",
            author: { name: "A" },
            dist: { tarball: "", shasum: "a".repeat(40) }
          },
          nightly: {
            name: packageName,
            version: "nightly",
            author: { name: "A" },
            dist: { tarball: "", shasum: "b".repeat(40) }
          }
        }
      }
    };
    await writeMetadataCache("vpm.example.com", packageName, seeded);

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    assert.equal(res.statusCode, 200, "one unparsable version must not hide the whole package");
    const body = res.json();
    assert.ok(body.versions["1.0.0"], "the semver version must still be published");
    assert.equal(
      body["dist-tags"].latest,
      "1.0.0",
      "latest is chosen among the versions that are semver"
    );
  }
);

// Regression for the eighth round of the second review cycle: an index that answered 503, a
// connection that failed and a body over the ceiling all reached the same empty 404 as a package
// that genuinely does not exist. That tells the client - and any cache between - to stop asking
// for something that is merely temporarily unavailable.
test(
  "VPMインデックスが503を返した場合は404ではなく502になる",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.unavailable";
    const marker = "case-unavailable";

    mockAgent
      .get(VPM_ORIGIN)
      .intercept({
        path: "/index.json",
        method: "GET",
        headers: (headers) => normalizeHeaders(headers)["x-vpm-test-route"] === marker
      })
      .reply(503, "upstream is unwell", { headers: { "content-type": "text/plain" } })
      .persist();

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    assert.equal(res.statusCode, 502, "an upstream that failed to answer is not an absent package");
  }
);

// The other half of the same rule: an index that answers perfectly well and does not list the
// package is a confirmed absence, and must stay a 404.
test(
  "インデックスに載っていないパッケージは従来どおり404になる",
  async (t: TestContext) => {
    const marker = "case-absent";

    mockAgent
      .get(VPM_ORIGIN)
      .intercept({
        path: "/index.json",
        method: "GET",
        headers: (headers) => normalizeHeaders(headers)["x-vpm-test-route"] === marker
      })
      .reply(200, { packages: {} }, { headers: { "content-type": "application/json" } })
      .persist();

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: "/api/v4/groups/my-group/com.example.vpm.absent",
      headers: { "private-token": "valid-token", "x-vpm-test-route": marker }
    });

    assert.equal(res.statusCode, 404, "a healthy index that omits the package does mean absent");
  }
);
