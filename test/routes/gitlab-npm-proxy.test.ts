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
import { createHash } from "node:crypto";
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
test("メタデータ補完のダウンロードはRangeや条件付きヘッダを転送しない", async (t: TestContext) => {
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

// Regression for the fifth review round: enrichment only fills in author and displayName,
// but its download throwing - which a redirect now does, since the proxy neither follows nor
// caches one - propagated out of the route handler and turned the whole metadata response
// into a 500.
test("メタデータ補完のダウンロードがリダイレクトで失敗しても、メタデータ応答は成功する", async (t: TestContext) => {
  mockValidUser();
  const packageName = "com.example.other.redirect";
  const version = "1.0.0";
  const downloadPath = `/assets/${packageName}-${version}.tgz`;

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

  // An ordinary redirect to a CDN: not followed, not cached, and it must not be fatal.
  mockAgent
    .get(SCOPED_ORIGIN)
    .intercept({ path: downloadPath, method: "GET" })
    .reply(302, "", { headers: { location: "https://cdn.example.org/assets/pkg.tgz" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: `/api/v4/groups/my-group/${packageName}`,
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200, "a failed enrichment download must not fail the metadata request");
  const body = res.json() as { name: string; author?: string; versions: Record<string, unknown> };
  assert.equal(body.name, packageName);
  assert.ok(body.versions[version], "the upstream metadata must still be returned");
  assert.equal(body.author, undefined, "author simply stays unfilled when enrichment cannot run");

  // Nothing may have been cached from the redirect.
  const cachedPath = join(tarballCacheDir, "npm.example.org", packageName, `${packageName}-${version}.tgz`);
  assert.equal(existsSync(cachedPath), false, "a redirect response must not be cached as the archive");
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

// Regression for the second cycle: the npm passthrough used to discard the response GitLab
// had just authorized and serve the cached document in its place whenever the latest version
// matched. The cache is keyed on the upstream host and the package name with no group in it,
// so two groups holding a package of the same name at the same latest version share one
// entry - and the caller authorized for one group was shown the other group's metadata.
test("npm中継はグループごとに認可された上流応答を返し、キャッシュで差し替えない", async (t: TestContext) => {
  const packageName = "shared-name";
  const version = "1.0.0";

  const metadataFor = (group: string) => ({
    name: packageName,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name: packageName,
        version,
        // author and displayName present so the enrichment step has nothing to fetch.
        author: { name: "Test Author" },
        displayName: "Shared Name",
        // The give-away: whose package this actually is.
        repository: { url: `https://gitlab.example.com/${group}/${packageName}` },
        dist: { tarball: `${DEFAULT_ORIGIN}/api/v4/groups/${group}/npm/${packageName}/-/${packageName}-${version}.tgz` }
      }
    }
  });

  // Group A asks first and populates the cache.
  mockValidUser();
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: `/api/v4/groups/group-a/-/packages/npm/${packageName}`, method: "GET" })
    .reply(200, metadataFor("group-a"), { headers: { "content-type": "application/json" } });

  const app = await build(t);
  const resA = await app.inject({
    method: "GET",
    url: `/api/v4/groups/group-a/${packageName}`,
    headers: { "private-token": "valid-token" }
  });
  assert.equal(resA.statusCode, 200);
  const bodyA = resA.json() as { versions: Record<string, { repository: { url: string } }> };
  assert.match(bodyA.versions[version].repository.url, /group-a/);

  // Group B asks next. GitLab authorizes and returns B's package, at the same latest version.
  mockValidUser();
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: `/api/v4/groups/group-b/-/packages/npm/${packageName}`, method: "GET" })
    .reply(200, metadataFor("group-b"), { headers: { "content-type": "application/json" } });

  const resB = await app.inject({
    method: "GET",
    url: `/api/v4/groups/group-b/${packageName}`,
    headers: { "private-token": "valid-token" }
  });

  assert.equal(resB.statusCode, 200);
  const bodyB = resB.json() as { versions: Record<string, { repository: { url: string } }> };
  assert.match(
    bodyB.versions[version].repository.url,
    /group-b/,
    "the caller must get the metadata GitLab authorized for their own group"
  );
});

// Regression for the second cycle: HEAD was forwarded upstream and then, because the response
// carries the JSON content type, parsed as JSON. A HEAD response has no body, so parsing threw
// and the caller got a 500 for a request the upstream had answered.
test("JSONリソースへのHEADは上流の状態をそのまま返す", async (t: TestContext) => {
  mockValidUser();
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: "/api/v4/groups/my-group/-/packages/npm/widget", method: "HEAD" })
    .reply(200, "", { headers: { "content-type": "application/json" } });

  const app = await build(t);
  const res = await app.inject({
    method: "HEAD",
    url: "/api/v4/groups/my-group/widget",
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200, "a HEAD must not be turned into a server error");
});

// Regression for the second cycle: the upstream URL is rebuilt from route parameters, which
// dropped the query string. The tarball URLs this proxy publishes keep whatever query the
// upstream put on them - a signed download parameter, typically - so the download that comes
// back has to carry it upstream too.
test("上流への中継でクエリ文字列が保持される", async (t: TestContext) => {
  mockValidUser();
  const tarballBytes = Buffer.from("signed-download-bytes");
  let seenPath = "";
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({
      path: (path) => {
        if (!path.startsWith("/api/v4/groups/my-group/-/packages/npm/signed/-/signed-1.0.0.tgz")) {
          return false;
        }
        seenPath = path;
        return true;
      },
      method: "GET"
    })
    .reply(200, tarballBytes, { headers: { "content-type": "application/octet-stream" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/signed/-/signed-1.0.0.tgz?signature=abc&expires=1",
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200);
  assert.match(seenPath, /signature=abc/, "the signed parameter must reach the upstream verbatim");
  assert.match(seenPath, /expires=1/);
});

// Regression for the second cycle: search took every name a configured registry returned,
// without asking whether that registry is the one the metadata route would use for it. A
// registry scoped to "com.example.other.*" advertising an unrelated name promises something
// the proxy will not deliver - the metadata request routes by scope and goes elsewhere.
test("検索結果は、そのupstreamがスコープ上担当する名前だけを含む", async (t: TestContext) => {
  mockValidUser();
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: (path) => path.startsWith("/api/v4/groups/my-group/packages"), method: "GET" })
    .reply(200, []);

  mockAgent
    .get(SCOPED_ORIGIN)
    .intercept({ path: (path) => path.startsWith("/-/v1/search"), method: "GET" })
    .reply(
      200,
      {
        objects: [
          { package: { name: "com.example.other.mine", version: "1.0.0", description: "in scope" } },
          { package: { name: "unrelated.pkg", version: "2.0.0", description: "out of scope" } }
        ],
        total: 2
      },
      { headers: { "content-type": "application/json" } }
    );

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/-/v1/search?text=e&from=0&size=20",
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json() as { objects: Array<{ package: { name: string } }>; total: number };
  const names = body.objects.map((o) => o.package.name);
  assert.deepEqual(names, ["com.example.other.mine"], "only names this upstream would serve");
  assert.equal(body.total, 1);
});

// Regression for the second cycle: every upstream was queried from 0 with the caller's page
// size, and the merged list was then sliced by the caller's `from`. Asking for the second page
// therefore sliced past everything that had been fetched and came back empty.
test("検索の2ページ目以降もupstreamの結果を返す", async (t: TestContext) => {
  mockValidUser();
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: (path) => path.startsWith("/api/v4/groups/my-group/packages"), method: "GET" })
    .reply(200, []);

  // 30 in-scope packages, named so the sort order is predictable.
  const objects = Array.from({ length: 30 }, (_, i) => ({
    package: {
      name: `com.example.other.p${String(i).padStart(2, "0")}`,
      version: "1.0.0",
      description: `pkg ${i}`
    }
  }));

  let requestedSize = "";
  mockAgent
    .get(SCOPED_ORIGIN)
    .intercept({
      path: (path) => {
        if (!path.startsWith("/-/v1/search")) return false;
        requestedSize = new URL(path, SCOPED_ORIGIN).searchParams.get("size") ?? "";
        return true;
      },
      method: "GET"
    })
    .reply(200, { objects, total: objects.length }, { headers: { "content-type": "application/json" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/-/v1/search?text=p&from=20&size=10",
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json() as { objects: Array<{ package: { name: string } }>; total: number };
  assert.equal(requestedSize, "250", "the same window is fetched for every page of one search");
  assert.equal(body.objects.length, 10, "the second page must not be empty");
  assert.equal(body.objects[0].package.name, "com.example.other.p20");
  assert.equal(body.total, 30);
});

// Regression for cycle 2 round 2: asking each upstream for `from + size` rows made the fetched
// prefix a different length on every page. The merged list is sorted by name and then sliced,
// so pages built from different prefixes of the upstream's own ordering overlapped and skipped
// entries, and `total` moved as the caller paged.
test("検索のページ分割は、ページ間で重複や欠落を生じない", async (t: TestContext) => {
  // Deliberately returned in an order that is not the sorted one.
  const objects = [
    { package: { name: "com.example.other.zz", version: "1.0.0", description: "z" } },
    { package: { name: "com.example.other.aa", version: "1.0.0", description: "a" } }
  ];

  const pageOf = async (from: number) => {
    mockValidUser();
    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({ path: (path) => path.startsWith("/api/v4/groups/my-group/packages"), method: "GET" })
      .reply(200, []);
    // Honours `size` the way a real registry does: that is what makes the fetched prefix
    // depend on the page, which is the whole point of this test.
    let requestedSize = 0;
    mockAgent
      .get(SCOPED_ORIGIN)
      .intercept({
        path: (path) => {
          if (!path.startsWith("/-/v1/search")) return false;
          requestedSize = Number(new URL(path, SCOPED_ORIGIN).searchParams.get("size") ?? "0");
          return true;
        },
        method: "GET"
      })
      .reply(() => ({
        statusCode: 200,
        data: { objects: objects.slice(0, requestedSize), total: objects.length },
        responseOptions: { headers: { "content-type": "application/json" } }
      }));

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/-/v1/search?text=&from=${from}&size=1`,
      headers: { "private-token": "valid-token" }
    });
    assert.equal(res.statusCode, 200);
    return res.json() as { objects: Array<{ package: { name: string } }>; total: number };
  };

  const first = await pageOf(0);
  const second = await pageOf(1);

  assert.equal(first.total, 2, "total must describe the whole result set");
  assert.equal(second.total, 2, "and must not change between pages");
  assert.equal(first.objects[0].package.name, "com.example.other.aa");
  assert.equal(
    second.objects[0].package.name,
    "com.example.other.zz",
    "the second page must continue where the first ended, not repeat it"
  );
});

// Regression for cycle 2 round 2: the wholesale cache substitution was removed last round,
// but enrichment still read the archive cache blind. That cache is keyed on host, package name
// and filename with no group in it, so one group's archive supplied the author and displayName
// for another group's response.
test("メタデータ補完は、shasumが一致しないキャッシュ済みアーカイブを使わない", async (t: TestContext) => {
  const packageName = "cross-group-enrich";
  const version = "1.0.0";
  const filename = `${packageName}-${version}.tgz`;

  // Group A's archive, carrying A's author, already in the cache.
  const sourceDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-crossgroup-"));
  mkdirSync(join(sourceDir, "package"), { recursive: true });
  writeFileSync(
    join(sourceDir, "package", "package.json"),
    JSON.stringify({ name: packageName, version, author: { name: "Group A Author" } }),
    "utf-8"
  );
  const tgzPath = join(sourceDir, "a.tgz");
  await tar.c({ gzip: true, file: tgzPath, cwd: sourceDir }, ["package"]);
  const groupABytes = readFileSync(tgzPath);
  enrichTempDirs.push(sourceDir);

  const cacheDir = join(tarballCacheDir, DEFAULT_HOST, packageName);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, filename), groupABytes);

  // Group B's own archive, with a different author, served from its own upstream path.
  const sourceDirB = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-crossgroup-b-"));
  mkdirSync(join(sourceDirB, "package"), { recursive: true });
  writeFileSync(
    join(sourceDirB, "package", "package.json"),
    JSON.stringify({ name: packageName, version, author: { name: "Group B Author" } }),
    "utf-8"
  );
  const tgzPathB = join(sourceDirB, "b.tgz");
  await tar.c({ gzip: true, file: tgzPathB, cwd: sourceDirB }, ["package"]);
  const groupBBytes = readFileSync(tgzPathB);
  enrichTempDirs.push(sourceDirB);

  const shasumB = createHash("sha1").update(groupBBytes).digest("hex");
  const tarballUrl = `${DEFAULT_ORIGIN}/api/v4/groups/group-b/-/packages/npm/${packageName}/-/${filename}`;

  mockValidUser();
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: `/api/v4/groups/group-b/-/packages/npm/${packageName}`, method: "GET" })
    .reply(
      200,
      {
        name: packageName,
        "dist-tags": { latest: version },
        // No author and no displayName: enrichment has to go and read an archive.
        versions: {
          [version]: { name: packageName, version, dist: { tarball: tarballUrl, shasum: shasumB } }
        }
      },
      { headers: { "content-type": "application/json" } }
    );
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: `/api/v4/groups/group-b/-/packages/npm/${packageName}/-/${filename}`, method: "GET" })
    .reply(200, groupBBytes, { headers: { "content-type": "application/octet-stream" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: `/api/v4/groups/group-b/${packageName}`,
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json() as { author?: string };
  assert.equal(body.author, "Group B Author", "the author must come from this group's own archive");
});

// Regression for cycle 2 round 2: the ownership check added last round covered only the
// non-default npm results. GitLab's own results were merged last and therefore won every
// shared name, including names routed to a configured registry.
test("検索でGitLabの結果も、スコープ上の担当upstreamでなければ採用されない", async (t: TestContext) => {
  mockValidUser();
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: (path) => path.startsWith("/api/v4/groups/my-group/packages"), method: "GET" })
    .reply(200, [
      // Routed to the scoped registry by com.example.other.*, not to GitLab.
      { package_type: "npm", name: "com.example.other.thing", version: "9.0.0", created_at: "2024-01-01T00:00:00Z" },
      { package_type: "npm", name: "gitlab-owned", version: "1.0.0", created_at: "2024-01-01T00:00:00Z" }
    ]);

  mockAgent
    .get(SCOPED_ORIGIN)
    .intercept({ path: (path) => path.startsWith("/-/v1/search"), method: "GET" })
    .reply(
      200,
      { objects: [{ package: { name: "com.example.other.thing", version: "1.0.0", description: "from the registry" } }] },
      { headers: { "content-type": "application/json" } }
    );

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/-/v1/search?text=&from=0&size=20",
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json() as { objects: Array<{ package: { name: string; version: string } }> };
  const byName = new Map(body.objects.map((o) => [o.package.name, o.package.version]));
  assert.equal(
    byName.get("com.example.other.thing"),
    "1.0.0",
    "the registry that owns the scope must win, not GitLab"
  );
  assert.equal(byName.get("gitlab-owned"), "1.0.0", "names GitLab does own are still listed");
});

// Regression for cycle 2 round 3: enrichment decides whether a cached archive belongs to this
// response by comparing it against the shasum the upstream reported. Merging the cached shasum
// in beforehand put the other group's checksum there for a version the upstream did not hash,
// so the comparison matched that group's archive and the check was defeated.
test("上流がshasumを返さない版では、キャッシュ由来のshasumで補完を通さない", async (t: TestContext) => {
  const packageName = "no-shasum-enrich";
  const version = "1.0.0";
  const filename = `${packageName}-${version}.tgz`;

  // Another group's archive and its cached metadata, carrying that group's author and shasum.
  const sourceDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-noshasum-"));
  mkdirSync(join(sourceDir, "package"), { recursive: true });
  writeFileSync(
    join(sourceDir, "package", "package.json"),
    JSON.stringify({ name: packageName, version, author: { name: "Other Group Author" } }),
    "utf-8"
  );
  const tgzPath = join(sourceDir, "other.tgz");
  await tar.c({ gzip: true, file: tgzPath, cwd: sourceDir }, ["package"]);
  const otherBytes = readFileSync(tgzPath);
  enrichTempDirs.push(sourceDir);

  const cacheDir = join(tarballCacheDir, DEFAULT_HOST, packageName);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, filename), otherBytes);
  writeFileSync(
    join(cacheDir, "metadata.json"),
    JSON.stringify({
      latestVersion: version,
      metadata: {
        name: packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: packageName,
            version,
            dist: { tarball: "", shasum: createHash("sha1").update(otherBytes).digest("hex") }
          }
        }
      }
    }),
    "utf-8"
  );

  // This group's upstream response has no shasum at all, and no author to enrich from.
  const tarballUrl = `${DEFAULT_ORIGIN}/api/v4/groups/group-c/-/packages/npm/${packageName}/-/${filename}`;
  mockValidUser();
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: `/api/v4/groups/group-c/-/packages/npm/${packageName}`, method: "GET" })
    .reply(
      200,
      {
        name: packageName,
        "dist-tags": { latest: version },
        versions: { [version]: { name: packageName, version, dist: { tarball: tarballUrl } } }
      },
      { headers: { "content-type": "application/json" } }
    );

  // Its own archive, with its own author, is what enrichment has to go and fetch.
  const ownDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-noshasum-own-"));
  mkdirSync(join(ownDir, "package"), { recursive: true });
  writeFileSync(
    join(ownDir, "package", "package.json"),
    JSON.stringify({ name: packageName, version, author: { name: "Own Group Author" } }),
    "utf-8"
  );
  const ownTgz = join(ownDir, "own.tgz");
  await tar.c({ gzip: true, file: ownTgz, cwd: ownDir }, ["package"]);
  const ownBytes = readFileSync(ownTgz);
  enrichTempDirs.push(ownDir);

  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: `/api/v4/groups/group-c/-/packages/npm/${packageName}/-/${filename}`, method: "GET" })
    .reply(200, ownBytes, { headers: { "content-type": "application/octet-stream" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: `/api/v4/groups/group-c/${packageName}`,
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200);
  const body = res.json() as { author?: string };
  assert.equal(body.author, "Own Group Author", "a cache-supplied shasum must not authorize the reuse");
});

// Regression for cycle 2 round 3: the proxy forwards the caller's conditional headers, so a
// successful revalidation comes back as a bodyless 304 that still carries the JSON content
// type. Parsing it threw, and the caller got a 500 for the cheapest possible upstream answer.
test("条件付きリクエストの304は、そのまま304として返る", async (t: TestContext) => {
  mockValidUser();
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: "/api/v4/groups/my-group/-/packages/npm/widget", method: "GET" })
    .reply(304, "", { headers: { "content-type": "application/json", etag: '"abc"' } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/widget",
    headers: { "private-token": "valid-token", "if-none-match": '"abc"' }
  });

  assert.equal(res.statusCode, 304, "a revalidation must not be turned into a server error");
});

// Regression for the fifth round of the second review cycle: both search sources were queried
// with the caller's headers copied verbatim, response-narrowing ones included. Those validators
// describe the search result the caller holds, not the upstream enumeration the proxy merges into
// one - so a client revalidating its cached search turned the GitLab page into a bodyless 304
// (failing the whole search) and the registry's page into one the catch silently dropped.
test("検索の条件付きヘッダは上流の列挙へ転送されない", async (t: TestContext) => {
  mockValidUser();

  // Both interceptors answer only when no narrowing header survived; a request that still carries
  // one finds no interceptor and fails the search outright.
  const withoutNarrowing = (headers: unknown) => {
    const h = normalizeHeaders(headers);
    return !h["if-none-match"] && !h["range"] && !h["if-modified-since"];
  };

  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({
      path: (path) => path.startsWith("/api/v4/groups/my-group/packages"),
      method: "GET",
      headers: withoutNarrowing
    })
    .reply(200, [
      {
        package_type: "npm",
        name: "gitlab.merged",
        version: "1.0.0",
        created_at: "2024-01-01T00:00:00Z"
      }
    ]);

  mockAgent
    .get(SCOPED_ORIGIN)
    .intercept({
      path: (path) => path.startsWith("/-/v1/search"),
      method: "GET",
      headers: withoutNarrowing
    })
    .reply(
      200,
      { objects: [{ package: { name: "com.example.other.mine", version: "1.0.0" } }], total: 1 },
      { headers: { "content-type": "application/json" } }
    );

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/api/v4/groups/my-group/-/v1/search?text=e&from=0&size=20",
    headers: {
      "private-token": "valid-token",
      "if-none-match": "*",
      "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT",
      range: "bytes=0-10"
    }
  });

  assert.equal(res.statusCode, 200, "a conditional search request must still be answered");
  const names = (res.json() as { objects: Array<{ package: { name: string } }> }).objects
    .map((o) => o.package.name)
    .sort();
  assert.deepEqual(
    names,
    ["com.example.other.mine", "gitlab.merged"],
    "both sources must contribute to the merged result"
  );
});

// Regression for the sixth round of the second review cycle: extractTarballFilenameFromPath
// decoded the rest path's last segment, which the router had already decoded. A package whose
// tarball filename holds a literal "%" made that second decode throw, and the relay answered 500
// before it ever reached the upstream.
test("パーセント記号を含むtarballファイル名でも中継が500にならない", async (t: TestContext) => {
  mockValidUser();
  const packageName = "pct%pkg";
  const filename = `${packageName}-1.0.0.tgz`;
  const tarballBytes = Buffer.from("percent-in-the-filename");

  // The upstream sees the path exactly as the caller encoded it: the request is rebuilt from the
  // raw URL, not from the decoded route parameters. Forwarding the decoded form sent "%" through
  // as a literal, and a decoded "#" or "?" would have truncated the upstream path outright.
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({
      path: `/api/v4/groups/my-group/-/packages/npm/${encodeURIComponent(packageName)}/-/${encodeURIComponent(filename)}`,
      method: "GET"
    })
    .reply(200, tarballBytes, { headers: { "content-type": "application/octet-stream" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: `/api/v4/groups/my-group/${encodeURIComponent(packageName)}/-/${encodeURIComponent(filename)}`,
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200, "a literal percent sign must not fail the relay");
  assert.deepEqual(res.rawPayload, tarballBytes);
});

// Regression for the sixth round of the second review cycle: a 200 carrying Content-Encoding was
// cached as the raw HTTP-encoded bytes. The cache miss forwarded the header, so that caller could
// decode it - but the cache serves its bytes back with no encoding header at all, so every later
// request received the still-encoded body labelled as the archive.
test("Content-Encodingの付いたtarball応答はキャッシュされない", async (t: TestContext) => {
  mockValidUser();
  const path = "/api/v4/groups/my-group/encoded/-/encoded-1.0.0.tgz";
  const upstreamPath = "/api/v4/groups/my-group/-/packages/npm/encoded/-/encoded-1.0.0.tgz";
  const encodedBytes = Buffer.from("pretend-this-is-gzipped");

  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: upstreamPath, method: "GET" })
    .reply(200, encodedBytes, {
      headers: { "content-type": "application/octet-stream", "content-encoding": "gzip" }
    });

  const app = await build(t);
  const first = await app.inject({
    method: "GET",
    url: path,
    headers: { "private-token": "valid-token" }
  });

  assert.equal(first.statusCode, 200, "the response is still relayed to the caller");

  const cachedPath = join(tarballCacheDir, DEFAULT_HOST, "encoded", "encoded-1.0.0.tgz");
  assert.ok(
    !existsSync(cachedPath),
    "an encoded body must not be stored as the archive: the cache serves it back undeclared"
  );

  // Proof that it was not cached: the next request has to go upstream again.
  mockValidUser();
  const plainBytes = Buffer.from("the-real-archive");
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: upstreamPath, method: "GET" })
    .reply(200, plainBytes, { headers: { "content-type": "application/octet-stream" } });

  const second = await app.inject({
    method: "GET",
    url: path,
    headers: { "private-token": "valid-token" }
  });

  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.rawPayload, plainBytes, "the identity response is what gets served");
  assert.deepEqual(readFileSync(cachedPath), plainBytes, "and it is the one that gets cached");
});

// Regression for the sixth round of the second review cycle: the npm relay read the whole
// upstream body into memory with no bound, so an oversized archive - published by whoever owns
// the package, not by this proxy - could exhaust the process on a single authenticated request.
// The VPM ceiling added two rounds earlier did not cover this path.
test("上限を超える上流ボディは中継されずキャッシュもされない", async (t: TestContext) => {
  process.env.MAX_UPSTREAM_BODY_BYTES = "1024";
  try {
    mockValidUser();
    const path = "/api/v4/groups/my-group/oversized/-/oversized-1.0.0.tgz";
    const upstreamPath =
      "/api/v4/groups/my-group/-/packages/npm/oversized/-/oversized-1.0.0.tgz";

    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({ path: upstreamPath, method: "GET" })
      .reply(200, Buffer.alloc(8192, 0x41), {
        headers: { "content-type": "application/octet-stream" }
      });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: path,
      headers: { "private-token": "valid-token" }
    });

    assert.notEqual(res.statusCode, 200, "an oversized body must not be relayed as the archive");

    const cachedPath = join(tarballCacheDir, DEFAULT_HOST, "oversized", "oversized-1.0.0.tgz");
    assert.ok(!existsSync(cachedPath), "and nothing may reach the cache");
  } finally {
    delete process.env.MAX_UPSTREAM_BODY_BYTES;
  }
});

// Regression for the seventh round of the second review cycle: the ceiling added the round before
// covered the binary paths only. Every JSON read still went through undici's body.json(), which
// reads to the end with no bound - so an upstream could exhaust memory with a large metadata or
// search document, including a VPM index fetched at startup with no request behind it.
test("上限を超えるJSON応答も読み込まれない", async (t: TestContext) => {
  process.env.MAX_UPSTREAM_BODY_BYTES = "1024";
  try {
    mockValidUser();
    const oversized = JSON.stringify({ name: "huge", filler: "x".repeat(8192) });

    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({
        path: "/api/v4/groups/my-group/-/packages/npm/huge",
        method: "GET"
      })
      // No content-length: only the running total can catch this one.
      .reply(200, oversized, {
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" }
      });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: "/api/v4/groups/my-group/huge",
      headers: { "private-token": "valid-token" }
    });

    assert.notEqual(res.statusCode, 200, "an oversized JSON document must not be parsed");
  } finally {
    delete process.env.MAX_UPSTREAM_BODY_BYTES;
  }
});

test("Content-Lengthが上限を超えるJSON応答は本文を読まずに拒否される", async (t: TestContext) => {
  process.env.MAX_UPSTREAM_BODY_BYTES = "1024";
  try {
    mockValidUser();
    const oversized = JSON.stringify({ name: "declared", filler: "y".repeat(8192) });

    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({
        path: "/api/v4/groups/my-group/-/packages/npm/declared",
        method: "GET"
      })
      .reply(200, oversized, {
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(oversized))
        }
      });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: "/api/v4/groups/my-group/declared",
      headers: { "private-token": "valid-token" }
    });

    assert.notEqual(res.statusCode, 200, "a declared size over the ceiling must be refused");
  } finally {
    delete process.env.MAX_UPSTREAM_BODY_BYTES;
  }
});

// Regression for the seventh round of the second review cycle. Forwarding the decoded rest path
// did not merely change the spelling of the upstream URL: a name holding "%23" came back as "#",
// so URL parsing cut the path there and treated the rest as a fragment - the upstream was asked
// for a different, shorter resource. The request is now rebuilt from the raw URL.
test("エンコードされた#を含む名前でも、上流へは同じパスが送られる", async (t: TestContext) => {
  mockValidUser();
  const packageName = "hash#pkg";
  const filename = `${packageName}-1.0.0.tgz`;
  const tarballBytes = Buffer.from("hash-in-the-name");

  // Only the fully encoded path is answered. Forwarding the decoded form would request
  // "/api/v4/groups/my-group/-/packages/npm/hash" with the rest as a fragment.
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({
      path: `/api/v4/groups/my-group/-/packages/npm/${encodeURIComponent(packageName)}/-/${encodeURIComponent(filename)}`,
      method: "GET"
    })
    .reply(200, tarballBytes, { headers: { "content-type": "application/octet-stream" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: `/api/v4/groups/my-group/${encodeURIComponent(packageName)}/-/${encodeURIComponent(filename)}`,
    headers: { "private-token": "valid-token" }
  });

  assert.equal(res.statusCode, 200, "the upstream must be asked for the path the caller sent");
  assert.deepEqual(res.rawPayload, tarballBytes);
});
