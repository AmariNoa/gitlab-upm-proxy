// Route test for the raw upstream path when the application is mounted under a prefix.
//
// The upstream request is rebuilt from the raw request URL so the caller's encoding survives. The
// first implementation did that by dropping a fixed number of leading segments, which assumed the
// routes sit exactly where they do today: under a prefix those leading segments are part of the
// prefix, and the upstream ends up being asked for a path that includes it. Counting from the end
// instead - as many segments as the wildcard actually matched - does not care where the routes
// are mounted.
//
// Module-load env vars: TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL are read once
// at module load by src/lib/cache.ts, src/lib/upstreams.ts and src/routes/gitlab-npm-proxy.ts, so
// they are assigned before any src/ import (same constraint documented in
// test/routes/vpm-tarball-convert.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-mounted-prefix-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.mounted.example.net";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import routes from "../../src/routes/gitlab-npm-proxy";

const DEFAULT_ORIGIN = "https://gitlab.example.com";

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

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

test(
  "プレフィックス付きでマウントしても、上流へは正しいrestパスが送られる",
  async () => {
    const packageName = "com.example.mounted";

    // Only the correct upstream path is answered. A rest path that still carried part of the
    // mount prefix would address a different resource and find no interceptor.
    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({
        path: `/api/v4/groups/my-group/-/packages/npm/${packageName}`,
        method: "GET"
      })
      .reply(200, { name: packageName, "dist-tags": { latest: "1.0.0" }, versions: {} }, {
        headers: { "content-type": "application/json" }
      });

    const server = Fastify({ logger: false });
    void server.register(routes, { prefix: "/proxy" });
    await server.ready();
    try {
      const res = await server.inject({
        method: "GET",
        url: `/proxy/api/v4/groups/my-group/${packageName}`,
        headers: { "private-token": "valid-token" }
      });

      assert.equal(res.statusCode, 200, "the mount prefix must not leak into the upstream path");
      assert.equal(res.json().name, packageName);
    } finally {
      await server.close();
    }
  }
);

// Regression for the ninth round of the second review cycle. Locating the raw rest path by
// counting trailing segments looked equivalent to counting leading ones, and is not: an encoded
// slash makes one raw segment decode into two, so a scoped name is one segment in the URL and two
// in the value the router hands over. Counting from the end then took one segment too many and
// swept the group in with it. The previous round's test used an unscoped name and never saw it.
test(
  "スコープ付き名前でも、上流へは正しいrestパスが送られる",
  async () => {
    const packageName = "@scope/mounted";

    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({
        path: `/api/v4/groups/my-group/-/packages/npm/${encodeURIComponent(packageName)}`,
        method: "GET"
      })
      .reply(200, { name: packageName, "dist-tags": { latest: "1.0.0" }, versions: {} }, {
        headers: { "content-type": "application/json" }
      });

    const server = Fastify({ logger: false });
    void server.register(routes);
    await server.ready();
    try {
      const res = await server.inject({
        method: "GET",
        url: `/api/v4/groups/my-group/${encodeURIComponent(packageName)}`,
        headers: { "private-token": "valid-token" }
      });

      assert.equal(res.statusCode, 200, "the group must not be swept into the rest path");
      assert.equal(res.json().name, packageName);
    } finally {
      await server.close();
    }
  }
);

// Regression for the same round: the /self route concatenated the incoming raw URL onto the
// upstream base, so under a mount prefix GitLab was asked for "/proxy/api/v4/..." - a path that
// does not exist there. The endpoint is fixed, so it is built from the endpoint.
test(
  "プレフィックス付きでも /self はGitLabの正しいAPIパスへ中継される",
  async () => {
    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({ path: "/api/v4/personal_access_tokens/self", method: "GET" })
      .reply(200, { id: 7, scopes: ["api"] }, { headers: { "content-type": "application/json" } });

    const server = Fastify({ logger: false });
    void server.register(routes, { prefix: "/proxy" });
    await server.ready();
    try {
      const res = await server.inject({
        method: "GET",
        url: "/proxy/api/v4/personal_access_tokens/self",
        headers: { "private-token": "valid-token" }
      });

      assert.equal(res.statusCode, 200, "the mount prefix must not become part of the API path");
      assert.equal(res.json().id, 7);
    } finally {
      await server.close();
    }
  }
);
