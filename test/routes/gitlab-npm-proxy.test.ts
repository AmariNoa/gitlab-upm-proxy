// Route tests for src/routes/gitlab-npm-proxy.ts
//
// All calls to upstream GitLab / npm / VPM services go through undici's
// global dispatcher, which is replaced here with a MockAgent
// (disableNetConnect) so the suite never touches a real network.
//
// NOTE on TARBALL_CACHE_DIR: src/lib/cache.ts and src/routes/gitlab-npm-proxy.ts
// read process.env.TARBALL_CACHE_DIR exactly once, at module load time. Since
// node:test runs this whole file in a single process (module cache is shared
// across every test() below), a fresh cache dir cannot be created per test
// case. Instead a single temp directory is created for the whole file before
// the app is built for the first time, and removed again after all tests
// finish.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { build, TestContext } from "../helper";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;

const DEFAULT_ORIGIN = "https://gitlab.example.com";
const DEFAULT_HOST = "gitlab.example.com";
const SCOPED_ORIGIN = "https://npm.example.org";

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
});

after(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

/** Mocks GET {default}/api/v4/user returning 200 (valid PAT), returns a getter for the headers GitLab received. */
function mockValidUser(): { headers: () => Record<string, string> } {
  let captured: Record<string, string> = {};
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({
      path: "/api/v4/user",
      method: "GET",
      headers(headers) {
        captured = normalizeHeaders(headers);
        return true;
      }
    })
    .reply(200, { id: 1, username: "tester" });
  return { headers: () => captured };
}

/** Mocks GET {default}/api/v4/user returning 401 (invalid PAT). */
function mockInvalidUser(): void {
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: "/api/v4/user", method: "GET" })
    .reply(401, { message: "401 Unauthorized" });
}

test("PATヘッダが無い場合は401 missing_tokenを返す", async (t: TestContext) => {
  const app = await build(t);

  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/-/v1/search?text=widget"
  });

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "missing_token" });
});

test("GitLabの/api/v4/userが401を返す場合は401 invalid_tokenを返す", async (t: TestContext) => {
  mockInvalidUser();
  const app = await build(t);

  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/-/v1/search?text=widget",
    headers: { "private-token": "bad-token" }
  });

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "invalid_token" });
});

test("有効なPATでsearchがレスポンスを返し、GitLabへPATヘッダが転送される", async (t: TestContext) => {
  const user = mockValidUser();
  let packagesCallHeaders: Record<string, string> = {};
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({
      path: (path) => path.startsWith("/api/v4/groups/my-group/packages"),
      method: "GET",
      headers(headers) {
        packagesCallHeaders = normalizeHeaders(headers);
        return true;
      }
    })
    .reply(200, [
      {
        package_type: "npm",
        name: "widget",
        version: "1.0.0",
        created_at: "2024-01-01T00:00:00Z"
      }
    ]);

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/-/v1/search?text=widget",
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json() as { objects: Array<{ package: { name: string } }>; total: number };
  assert.equal(body.total, 1);
  assert.equal(body.objects[0]?.package.name, "widget");
  assert.equal(user.headers()["private-token"], "valid-token");
  assert.equal(packagesCallHeaders["private-token"], "valid-token");
});

test("グループスコープのnpmメタデータ中継がJSONを返す", async (t: TestContext) => {
  mockValidUser();
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: "/api/v4/groups/my-group/-/packages/npm/widget", method: "GET" })
    .reply(
      200,
      {
        name: "widget",
        "dist-tags": { latest: "1.0.0" },
        versions: {
          "1.0.0": {
            name: "widget",
            version: "1.0.0",
            author: { name: "Test Author" },
            displayName: "Widget",
            dist: {
              tarball: `${DEFAULT_ORIGIN}/api/v4/groups/my-group/-/packages/npm/widget/-/widget-1.0.0.tgz`,
              shasum: "deadbeef"
            }
          }
        }
      },
      { headers: { "content-type": "application/json" } }
    );

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/widget",
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-type"]), /application\/json/);
  const body = res.json() as { name: string; versions: Record<string, unknown> };
  assert.equal(body.name, "widget");
  assert.ok(body.versions["1.0.0"]);
});

test("スコープに一致する非defaultアップストリーム(npm型)への中継では認証ヘッダが転送されない", async (t: TestContext) => {
  mockValidUser();
  let scopedCallHeaders: Record<string, string> = {};
  mockAgent
    .get(SCOPED_ORIGIN)
    .intercept({
      path: "/com.example.other.thing",
      method: "GET",
      headers(headers) {
        scopedCallHeaders = normalizeHeaders(headers);
        return true;
      }
    })
    .reply(200, { name: "com.example.other.thing" }, { headers: { "content-type": "application/json" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/com.example.other.thing",
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(scopedCallHeaders["private-token"], undefined);
  assert.equal(scopedCallHeaders["authorization"], undefined);
});

test("プロジェクトスコープのtarball中継はレスポンスをそのまま返しキャッシュへ書き込む", async (t: TestContext) => {
  mockValidUser();
  const tarballBytes = Buffer.from("fake-tarball-content");
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({
      path: "/api/v4/projects/123/packages/npm/widget/-/widget-1.0.0.tgz",
      method: "GET"
    })
    .reply(200, tarballBytes, { headers: { "content-type": "application/octet-stream" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/api/v4/projects/123/packages/npm/widget/-/widget-1.0.0.tgz",
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.rawPayload, tarballBytes);

  const cachedPath = join(tarballCacheDir, DEFAULT_HOST, "widget", "widget-1.0.0.tgz");
  assert.ok(existsSync(cachedPath), `cache file was not written: ${cachedPath}`);
  assert.deepEqual(readFileSync(cachedPath), tarballBytes);
});
