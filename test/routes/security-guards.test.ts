// Route tests for two reachable defects found by the second independent review round:
//
//  - a package name that decodes to a dot segment ("..") used to resolve to the cache
//    root, so the recursive delete performed on an upstream 404 wiped every package and
//    the signing key stored next to them;
//  - the npm-form VPM tarball URL built its upstream headers for the DEFAULT upstream and
//    handed them to the VPM download, sending the caller's PAT to whatever host the VPM
//    index names in dist.original.
//
// Module-load env vars: TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL are
// read once at module load by src/lib/cache.ts, src/lib/upstreams.ts and
// src/routes/gitlab-npm-proxy.ts, so they are assigned before any src/ import (same
// constraint as test/routes/vpm-tarball-convert.test.ts).
import { request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-security-guards-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.vpm.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.security-guards.example.net";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import { build, TestContext } from "../helper";
import { readMetadataCache, writeMetadataCache, type MetadataCache } from "../../src/lib/cache";
import { getProxySigningKey } from "../../src/lib/npm-signatures";

const DEFAULT_ORIGIN = "https://gitlab.example.com";
const DEFAULT_HOST = "gitlab.example.com";
const VPM_ORIGIN = "https://vpm.example.com";
const VPM_HOST = "vpm.example.com";
// Deliberately a third host: neither the default upstream nor the VPM upstream itself.
const DOWNLOAD_ORIGIN = "https://dl.example.org";

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  // The background prefetch fetches the VPM index with no custom headers; an empty
  // package list keeps it away from the caches seeded here.
  mockAgent
    .get(VPM_ORIGIN)
    .intercept({ path: "/index.json", method: "GET" })
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

// A real HTTP request against a listening server, NOT app.inject. light-my-request
// normalizes a "%2E%2E" segment away ("/api/v4/groups/my-group/%2E%2E" becomes
// "/api/v4/groups/"), so inject cannot reach the handler with a dot-segment package name
// at all. A real Fastify server does route it: every one of "%2E%2E", "%2e%2e", "..",
// and ".%2E" arrives at the wildcard with the parameter decoded to "..". Testing this
// through inject would therefore assert nothing about the guard.
// node:http is used deliberately: undici's MockAgent (disableNetConnect) governs undici
// only, so the core http client still reaches the loopback server.
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test(
  "ドットセグメントのパッケージ名は404で拒否され、キャッシュと署名鍵は削除されない",
  async (t: TestContext) => {
    // Force the signing key file into existence: it lives directly under
    // TARBALL_CACHE_DIR, which is exactly what the unguarded delete used to remove.
    getProxySigningKey();
    const signingKeyPath = join(tarballCacheDir, "npm-signing-key.pem");
    assert.ok(existsSync(signingKeyPath), "precondition: the signing key file must exist");

    const bystander = "com.example.keepme";
    const bystanderCache: MetadataCache = {
      latestVersion: "1.0.0",
      metadata: {
        name: bystander,
        "dist-tags": { latest: "1.0.0" },
        versions: { "1.0.0": { name: bystander, version: "1.0.0", dist: { tarball: "" } } }
      }
    };
    await writeMetadataCache(DEFAULT_HOST, bystander, bystanderCache);

    const app = await build(t);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    assert.ok(port > 0, "the test server must be listening");

    // Every encoding of a dot segment that a client can put on the wire.
    for (const encoded of ["%2E%2E", "%2e%2e", "..", ".%2E"]) {
      const res = await rawGet(port, `/api/v4/groups/my-group/${encoded}`, {
        "private-token": "valid-token"
      });

      assert.equal(res.statusCode, 404, `expected 404 for ${encoded}`);
      // An empty body proves our handler answered; Fastify's own router 404 sends JSON.
      assert.equal(res.body, "", `the route handler must be the one answering 404 for ${encoded}`);

      assert.ok(existsSync(signingKeyPath), `the signing key must survive ${encoded}`);
      const survivor = await readMetadataCache(DEFAULT_HOST, bystander);
      assert.ok(survivor, `an unrelated package's cache must survive ${encoded}`);
      assert.equal(survivor!.metadata.name, bystander);
    }
  }
);

test(
  "npm形式のVPM tarball URLでは、dist.originalのホストへ認証ヘッダが送られない",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.guard";
    const version = "1.0.0";
    const zipPath = "/releases/guard-1.0.0.zip";

    const cache: MetadataCache = {
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            dist: { tarball: "", original: `${DOWNLOAD_ORIGIN}${zipPath}` }
          }
        }
      }
    };
    await writeMetadataCache(VPM_HOST, packageName, cache);

    let observedHeaders: Record<string, unknown> | null = null;
    mockAgent
      .get(DOWNLOAD_ORIGIN)
      .intercept({ path: zipPath, method: "GET" })
      .reply((opts) => {
        observedHeaders = (opts.headers ?? {}) as Record<string, unknown>;
        // Answering 404 keeps this test focused on the request headers: the conversion
        // path is already covered by test/routes/vpm-tarball-convert.test.ts.
        return { statusCode: 404, data: "" };
      });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/npm/${packageName}/-/${packageName}-${version}.tgz`,
      headers: { "private-token": "super-secret-token", authorization: "Bearer super-secret-token" }
    });

    assert.equal(res.statusCode, 404, "a failed download must surface as 404");
    assert.ok(observedHeaders, "the download must actually have been attempted");

    const sent = observedHeaders as unknown as Record<string, unknown>;
    const names = Object.keys(sent).map((name) => name.toLowerCase());
    assert.ok(!names.includes("authorization"), "Authorization must not reach the download host");
    assert.ok(!names.includes("private-token"), "PRIVATE-TOKEN must not reach the download host");
    const serialized = JSON.stringify(sent);
    assert.ok(
      !serialized.includes("super-secret-token"),
      "no header value may carry the caller's token to the download host"
    );
  }
);
