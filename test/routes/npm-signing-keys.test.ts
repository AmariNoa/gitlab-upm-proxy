// Route tests for GET /-/npm/v1/keys covering three fixes:
//  - the proxy's own signing key always wins over an upstream advertising the same keyid
//    (and an upstream key that cannot prove it owns its claimed keyid is dropped);
//  - the default upstream's key is included in the aggregation (and de-duplicated when its
//    baseUrl also appears in the upstreams list);
//  - only minimal headers (no PAT / cookie / other request headers) are forwarded to
//    upstreams when fetching their signing keys, since the endpoint is public information.
//
// Module-load env vars (TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL) are
// read once at module load time by src/lib/cache.ts, src/lib/upstreams.ts and
// src/routes/gitlab-npm-proxy.ts, so they are assigned below before any src/ module is
// imported (same constraint as test/routes/vpm-signatures.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-npm-signing-keys-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.npm-keys.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.npm-keys.example.net";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import { build, TestContext } from "../helper";
import { getProxySigningKey } from "../../src/lib/npm-signatures";

const DEFAULT_ORIGIN = "https://gitlab.example.com";
const NPM_A_ORIGIN = "https://npm-a.example.org";
const NPM_B_ORIGIN = "https://npm-b.example.org";
const NPM_C_ORIGIN = "https://npm-c.example.org";

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

function keyEntryFor(publicPem: string) {
  const der = createPublicKey(publicPem).export({ type: "spki", format: "der" }) as Buffer;
  const keyid = `SHA256:${createHash("sha256").update(der).digest("base64").replace(/=+$/, "")}`;
  return {
    entry: {
      expires: null,
      keyid,
      keytype: "ecdsa-sha2-nistp256" as const,
      scheme: "ecdsa-sha2-nistp256" as const,
      key: der.toString("base64")
    },
    keyid
  };
}

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  // The fixture's vpm-type upstream is irrelevant to these tests, but src/app.ts always
  // kicks off a background startVpmPrefetch on build(); answer its index fetch with an
  // empty package list so it exits quietly instead of failing against unmocked network.
  mockAgent
    .get("https://vpm.example.com")
    .intercept({ path: "/index.json", method: "GET" })
    .reply(200, { packages: {} }, { headers: { "content-type": "application/json" } })
    .persist();
});

after(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

const proxyKey = getProxySigningKey();

// A second, genuine EC P-256 keypair used to prove that a legitimate upstream key (correct
// keyid, correct curve) is still accepted through the new validation.
const genuineUpstreamPair = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const { entry: genuineUpstreamKey } = keyEntryFor(genuineUpstreamPair.publicKey);

// A third EC P-256 keypair whose *advertised* keyid does not match its own key material
// (simulates a tampered/incorrect response) - must be rejected.
const tamperedPair = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const tamperedDer = createPublicKey(tamperedPair.publicKey).export({ type: "spki", format: "der" }) as Buffer;
const tamperedKey = {
  expires: null,
  keyid: "SHA256:this-does-not-match-the-key-material-below",
  keytype: "ecdsa-sha2-nistp256" as const,
  scheme: "ecdsa-sha2-nistp256" as const,
  key: tamperedDer.toString("base64")
};

// A genuine default-upstream key, distinct from both the proxy's own key and the upstream
// keys above.
const defaultUpstreamPair = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
const { entry: defaultUpstreamKey } = keyEntryFor(defaultUpstreamPair.publicKey);

test(
  "GET /-/npm/v1/keysはdefaultアップストリームの鍵を重複排除して集約し、プロキシと同じkeyidを名乗る鍵とkeyid不一致の鍵は除外する",
  async (t: TestContext) => {
    let defaultCallCount = 0;
    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({
        path: "/-/npm/v1/keys",
        method: "GET",
        headers() {
          defaultCallCount++;
          return true;
        }
      })
      .reply(200, { keys: [defaultUpstreamKey] }, { headers: { "content-type": "application/json" } })
      .persist();

    // Same keyid as the proxy's own key, but different (bogus) key material: must not be
    // able to shadow the proxy's key in the merged response.
    const spoofedKey = {
      expires: null,
      keyid: proxyKey.keyid,
      keytype: "ecdsa-sha2-nistp256" as const,
      scheme: "ecdsa-sha2-nistp256" as const,
      key: Buffer.from("not-the-real-proxy-public-key").toString("base64")
    };
    mockAgent
      .get(NPM_A_ORIGIN)
      .intercept({ path: "/-/npm/v1/keys", method: "GET" })
      .reply(200, { keys: [spoofedKey] }, { headers: { "content-type": "application/json" } });

    mockAgent
      .get(NPM_B_ORIGIN)
      .intercept({ path: "/-/npm/v1/keys", method: "GET" })
      .reply(200, { keys: [genuineUpstreamKey] }, { headers: { "content-type": "application/json" } });

    mockAgent
      .get(NPM_C_ORIGIN)
      .intercept({ path: "/-/npm/v1/keys", method: "GET" })
      .reply(200, { keys: [tamperedKey] }, { headers: { "content-type": "application/json" } });

    // Valid PAT for the onRequest hook's /api/v4/user check.
    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({ path: "/api/v4/user", method: "GET" })
      .reply(200, { id: 1, username: "tester" });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: "/-/npm/v1/keys",
      headers: { "private-token": "valid-token" }
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { keys: Array<{ keyid: string; key: string }> };

    const byKeyid = new Map(body.keys.map((k) => [k.keyid, k]));
    assert.equal(byKeyid.size, body.keys.length, "no duplicate keyids expected in the response");

    // The proxy's own key must be present and untouched by the spoofed same-keyid entry.
    assert.ok(byKeyid.has(proxyKey.keyid));
    assert.equal(byKeyid.get(proxyKey.keyid)?.key, proxyKey.key);

    // The default upstream's genuine key must be aggregated.
    assert.ok(byKeyid.has(defaultUpstreamKey.keyid));
    assert.equal(byKeyid.get(defaultUpstreamKey.keyid)?.key, defaultUpstreamKey.key);

    // A genuine (correct keyid, correct curve) third-party upstream key is still accepted.
    assert.ok(byKeyid.has(genuineUpstreamKey.keyid));
    assert.equal(byKeyid.get(genuineUpstreamKey.keyid)?.key, genuineUpstreamKey.key);

    // The tampered (keyid does not match key material) key must be dropped entirely.
    assert.ok(!byKeyid.has(tamperedKey.keyid));

    // Exactly proxy + default + genuine-B: the spoofed and tampered keys are excluded.
    assert.equal(body.keys.length, 3);

    // The fixture lists the default upstream's baseUrl a second time (as a scoped
    // upstream) on purpose: it must be fetched only once.
    assert.equal(defaultCallCount, 1, "the default upstream's key endpoint must be fetched only once, even though its baseUrl is duplicated in the config");
  }
);

test(
  "GET /-/npm/v1/keysは鍵取得時にPAT・Cookie等を転送せずaccept以外のヘッダを送らない",
  async (t: TestContext) => {
    let capturedDefaultHeaders: Record<string, string> = {};
    let capturedUpstreamHeaders: Record<string, string> = {};

    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({
        path: "/-/npm/v1/keys",
        method: "GET",
        headers(headers) {
          capturedDefaultHeaders = normalizeHeaders(headers);
          return true;
        }
      })
      .reply(200, { keys: [] }, { headers: { "content-type": "application/json" } })
      .persist();

    mockAgent
      .get(NPM_A_ORIGIN)
      .intercept({
        path: "/-/npm/v1/keys",
        method: "GET",
        headers(headers) {
          capturedUpstreamHeaders = normalizeHeaders(headers);
          return true;
        }
      })
      .reply(200, { keys: [] }, { headers: { "content-type": "application/json" } });

    mockAgent
      .get(NPM_B_ORIGIN)
      .intercept({ path: "/-/npm/v1/keys", method: "GET" })
      .reply(200, { keys: [] }, { headers: { "content-type": "application/json" } });

    mockAgent
      .get(NPM_C_ORIGIN)
      .intercept({ path: "/-/npm/v1/keys", method: "GET" })
      .reply(200, { keys: [] }, { headers: { "content-type": "application/json" } });

    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({ path: "/api/v4/user", method: "GET" })
      .reply(200, { id: 1, username: "tester" });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: "/-/npm/v1/keys",
      headers: {
        "private-token": "valid-token",
        cookie: "session=super-secret-session-id",
        "x-custom-app-header": "should-not-be-forwarded"
      }
    });

    assert.equal(res.statusCode, 200);

    for (const captured of [capturedDefaultHeaders, capturedUpstreamHeaders]) {
      assert.equal(captured["accept"], "application/json");
      assert.equal(captured["private-token"], undefined);
      assert.equal(captured["authorization"], undefined);
      assert.equal(captured["cookie"], undefined);
      assert.equal(captured["x-custom-app-header"], undefined);
    }
  }
);
