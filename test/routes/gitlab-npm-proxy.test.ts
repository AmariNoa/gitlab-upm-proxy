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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as tar from "tar";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";
import { build, TestContext } from "../helper";

// Temp directories built by the enrichment test; removed with the cache dir below.
const enrichTempDirs: string[] = [];

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
  for (const dir of enrichTempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
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

// Regression for the fourth review round: the check used to accept anything below 400.
// undici does not follow redirects, so a GitLab URL answering with a 302 - an http to https
// hop, or a redirect to a login page - let every token through, valid or not.
test("GitLabの/api/v4/userがリダイレクトを返す場合も401 invalid_tokenを返す", async (t: TestContext) => {
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: "/api/v4/user", method: "GET" })
    .reply(302, "", { headers: { location: "https://gitlab.example.com/users/sign_in" } });

  const app = await build(t);

  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/-/v1/search?text=widget",
    headers: { "private-token": "any-token" }
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
    headers: {
      "private-token": "valid-token",
      authorization: "Bearer valid-token",
      cookie: "_gitlab_session=super-secret-session"
    }
  });

  assert.equal(res.statusCode, 200);
  assert.equal(scopedCallHeaders["private-token"], undefined);
  assert.equal(scopedCallHeaders["authorization"], undefined);
  // A session cookie identifies the caller just as much as the PAT does.
  assert.equal(scopedCallHeaders["cookie"], undefined);
});

// Regression for the third review round: the metadata enrichment step downloads the latest
// version's tarball when author/displayName are missing, and it used to do so with the
// headers built for the DEFAULT upstream. dist.tarball here points at the non-default
// registry's OWN origin, which is what makes this discriminating: the cross-origin strip in
// headersForDownload does not apply, so only building the headers for the owning upstream
// keeps the caller's credentials out of the request.
test("非defaultアップストリームのメタデータ補完で、tarball取得先へ認証情報が送られない", async (t: TestContext) => {
  mockValidUser();
  const packageName = "com.example.other.enrich";
  const version = "1.0.0";
  const downloadOrigin = SCOPED_ORIGIN;
  const downloadPath = `/assets/${packageName}-${version}.tgz`;

  // A real tgz, so the enrichment step can actually read package.json out of it.
  const sourceDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-enrich-src-"));
  mkdirSync(join(sourceDir, "package"), { recursive: true });
  writeFileSync(
    join(sourceDir, "package", "package.json"),
    JSON.stringify({ name: packageName, version, author: { name: "Tarball Author" }, displayName: "Tarball Display" }),
    "utf-8"
  );
  const tgzPath = join(sourceDir, "package.tgz");
  await tar.c({ gzip: true, file: tgzPath, cwd: sourceDir }, ["package"]);
  const tgzBytes = readFileSync(tgzPath);
  enrichTempDirs.push(sourceDir);

  mockAgent
    .get(SCOPED_ORIGIN)
    .intercept({ path: `/${packageName}`, method: "GET" })
    .reply(
      200,
      {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            dist: { tarball: `${downloadOrigin}${downloadPath}` }
          }
        }
      },
      { headers: { "content-type": "application/json" } }
    );

  let downloadHeaders: Record<string, string> = {};
  mockAgent
    .get(downloadOrigin)
    .intercept({
      path: downloadPath,
      method: "GET",
      headers(headers) {
        downloadHeaders = normalizeHeaders(headers);
        return true;
      }
    })
    .reply(200, tgzBytes, { headers: { "content-type": "application/octet-stream" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: `/api/v4/groups/my-group/${packageName}`,
    headers: {
      "private-token": "super-secret-token",
      authorization: "Bearer super-secret-token",
      cookie: "_gitlab_session=super-secret-session"
    }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json() as { author?: string };
  assert.equal(body.author, "Tarball Author", "precondition: the enrichment download must have happened");

  assert.notDeepEqual(downloadHeaders, {}, "the tarball download must have been attempted");
  assert.equal(downloadHeaders["private-token"], undefined);
  assert.equal(downloadHeaders["authorization"], undefined);
  assert.equal(downloadHeaders["cookie"], undefined);
  assert.ok(
    !JSON.stringify(downloadHeaders).includes("super-secret"),
    "no header value may carry the caller's credentials to the download host"
  );
});

// Regression for the fourth review round: the enrichment download is the proxy's own
// request, but it was built from the caller's headers and cached anything below 400. A
// caller's Range turned it into a 206 fragment, and a redirect's body was stored under the
// tarball's name - either way a later request would be served that as the archive.
test("メタデータ補完のダウンロードはRangeを転送せず、リダイレクトをキャッシュしない", async (t: TestContext) => {
  mockValidUser();
  const packageName = "com.example.other.narrow";
  const version = "1.0.0";
  const downloadPath = `/assets/${packageName}-${version}.tgz`;

  const sourceDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-narrow-src-"));
  mkdirSync(join(sourceDir, "package"), { recursive: true });
  writeFileSync(
    join(sourceDir, "package", "package.json"),
    JSON.stringify({ name: packageName, version, author: { name: "Tarball Author" } }),
    "utf-8"
  );
  const tgzPath = join(sourceDir, "package.tgz");
  await tar.c({ gzip: true, file: tgzPath, cwd: sourceDir }, ["package"]);
  const tgzBytes = readFileSync(tgzPath);
  enrichTempDirs.push(sourceDir);

  mockAgent
    .get(SCOPED_ORIGIN)
    .intercept({ path: `/${packageName}`, method: "GET" })
    .reply(
      200,
      {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: { name: packageName, version, dist: { tarball: `${SCOPED_ORIGIN}${downloadPath}` } }
        }
      },
      { headers: { "content-type": "application/json" } }
    );

  let downloadHeaders: Record<string, string> = {};
  mockAgent
    .get(SCOPED_ORIGIN)
    .intercept({
      path: downloadPath,
      method: "GET",
      headers(headers) {
        downloadHeaders = normalizeHeaders(headers);
        return true;
      }
    })
    .reply(200, tgzBytes, { headers: { "content-type": "application/octet-stream" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: `/api/v4/groups/my-group/${packageName}`,
    // A metadata request carrying Range: the enrichment download must not inherit it.
    headers: { "private-token": "valid-token", range: "bytes=0-9", "if-none-match": "\"etag\"" }
  });

  assert.equal(res.statusCode, 200);
  assert.notDeepEqual(downloadHeaders, {}, "the enrichment download must have been attempted");
  assert.equal(downloadHeaders["range"], undefined, "Range must not narrow the proxy's own download");
  assert.equal(downloadHeaders["if-none-match"], undefined, "conditional headers must not be forwarded either");

  const cachedPath = join(tarballCacheDir, "npm.example.org", packageName, `${packageName}-${version}.tgz`);
  assert.deepEqual(readFileSync(cachedPath), tgzBytes, "the complete archive must be what lands in the cache");
});

// Regression for the third review round: the caller's Range header is forwarded upstream
// (and the proxy advertises accept-ranges), while the cache-write condition accepted any
// status below 400. A cold-cache ranged request therefore stored a few bytes as the whole
// archive, and every later request was served that truncated file as a complete 200.
test("Range付きの部分応答(206)はキャッシュされず、後続の通常GETが完全な内容を返す", async (t: TestContext) => {
  mockValidUser();
  const fullBytes = Buffer.from("0123456789-full-tarball-content");
  const partialBytes = fullBytes.subarray(0, 10);
  const path = "/api/v4/projects/123/packages/npm/ranged/-/ranged-1.0.0.tgz";

  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path, method: "GET", headers: { range: "bytes=0-9" } })
    .reply(206, partialBytes, {
      headers: {
        "content-type": "application/octet-stream",
        "content-range": `bytes 0-9/${fullBytes.length}`
      }
    });

  const app = await build(t);
  const partial = await app.inject({
    method: "GET",
    url: path,
    headers: { "private-token": "valid-token", range: "bytes=0-9" }
  });

  assert.equal(partial.statusCode, 206);
  assert.deepEqual(partial.rawPayload, partialBytes, "the partial response is still passed through");

  // Nothing may have been cached, so the next ordinary request goes upstream again.
  // mockValidUser registers a single-use intercept, so the second request needs its own.
  mockValidUser();
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path, method: "GET" })
    .reply(200, fullBytes, { headers: { "content-type": "application/octet-stream" } });

  const full = await app.inject({
    method: "GET",
    url: path,
    headers: { "private-token": "valid-token" }
  });

  assert.equal(full.statusCode, 200);
  assert.deepEqual(full.rawPayload, fullBytes, "a later request must not be served the truncated bytes");

  const cachedPath = join(tarballCacheDir, DEFAULT_HOST, "ranged", "ranged-1.0.0.tgz");
  assert.deepEqual(readFileSync(cachedPath), fullBytes, "only the complete archive may be cached");
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
