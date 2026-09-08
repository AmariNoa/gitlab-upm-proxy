// Route tests for who may receive a tarball that is already in the cache.
//
// The PAT check on every request establishes only that the token is a valid GitLab token. It says
// nothing about which packages that user can see. The tarball cache is keyed on the upstream host
// and the package name - no group, no user - so once anyone fetched a package, a cache hit handed
// it to any caller with any valid token, including one who could not have fetched it themselves.
// Only the upstream knows who may see what, so the upstream is asked before the bytes are served.
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
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-cached-authz-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.cached-authz.example.net";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import { build, TestContext } from "../helper";
import { writeTarballCache } from "../../src/lib/cache";

const DEFAULT_ORIGIN = "https://gitlab.example.com";
const DEFAULT_HOST = "gitlab.example.com";
const PACKAGE_NAME = "com.example.guarded";
const FILENAME = `${PACKAGE_NAME}-1.0.0.tgz`;
const CACHED_BYTES = Buffer.from("the archive someone else already fetched");

const GROUP_URL = `/api/v4/groups/my-group/${PACKAGE_NAME}/-/${FILENAME}`;
const GROUP_METADATA_PATH = `/api/v4/groups/my-group/-/packages/npm/${PACKAGE_NAME}`;
const PROJECT_URL = `/api/v4/projects/123/packages/npm/${PACKAGE_NAME}/-/${FILENAME}`;
const PROJECT_METADATA_PATH = `/api/v4/projects/123/packages/npm/${PACKAGE_NAME}`;

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

before(async () => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  // Every request's PAT check passes: the token is valid, which is exactly the situation where
  // the old behaviour handed over the archive.
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: "/api/v4/user", method: "GET" })
    .reply(200, { id: 1, username: "tester" })
    .persist();

  await writeTarballCache(DEFAULT_HOST, PACKAGE_NAME, FILENAME, CACHED_BYTES);
});

after(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

test(
  "上流がアクセスを拒否する呼び出し元には、キャッシュ済みtarballを返さない",
  async (t: TestContext) => {
    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({ path: GROUP_METADATA_PATH, method: "HEAD" })
      .reply(403, "", { headers: { "content-type": "application/json" } });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: GROUP_URL,
      headers: { "private-token": "valid-but-unauthorized" }
    });

    assert.equal(res.statusCode, 403, "the upstream's refusal is what the caller gets");
    assert.notDeepEqual(res.rawPayload, CACHED_BYTES, "and never the cached bytes");
  }
);

test(
  "上流がアクセスを認める呼び出し元には、キャッシュ済みtarballがそのまま返る",
  async (t: TestContext) => {
    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({ path: GROUP_METADATA_PATH, method: "HEAD" })
      .reply(200, "", { headers: { "content-type": "application/json" } });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: GROUP_URL,
      headers: { "private-token": "valid-and-authorized" }
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.rawPayload, CACHED_BYTES, "the archive still comes from cache");
    // No interceptor for the tarball itself was registered, so a cache miss would have failed.
  }
);

test(
  "認可確認そのものが到達できない場合、キャッシュへフォールバックせず502になる",
  async (t: TestContext) => {
    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({ path: GROUP_METADATA_PATH, method: "HEAD" })
      .replyWithError(new Error("connect ECONNREFUSED 203.0.113.1:443"));

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: GROUP_URL,
      headers: { "private-token": "valid-token" }
    });

    assert.equal(res.statusCode, 502, "an unreachable authority must not become a silent bypass");
    assert.notDeepEqual(res.rawPayload, CACHED_BYTES);
  }
);

test(
  "プロジェクトスコープ経路でも、拒否された呼び出し元にキャッシュは返らない",
  async (t: TestContext) => {
    await writeTarballCache(DEFAULT_HOST, PACKAGE_NAME, FILENAME, CACHED_BYTES);
    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({ path: PROJECT_METADATA_PATH, method: "HEAD" })
      .reply(404, "", { headers: { "content-type": "application/json" } });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: PROJECT_URL,
      headers: { "private-token": "valid-but-unauthorized" }
    });

    assert.equal(res.statusCode, 404, "GitLab answers 404 for a package the caller cannot see");
    assert.notDeepEqual(res.rawPayload, CACHED_BYTES);
  }
);
