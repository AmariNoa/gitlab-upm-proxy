// Route tests for the OAuth relay added for the Unity package registry manager.
//
// Three things here are not obvious from reading the routes alone, and each has a test that fails
// if it stops holding:
//
//  - the OAuth routes must be reachable without a token while the package routes must not be, and
//    that separation comes from AutoLoad's encapsulation rather than from anything either file
//    says, so it is checked against the real application rather than a hand-built instance;
//  - a token must never reach a response body or a log, including when the upstream answer is
//    malformed - which is exactly when a naive error message would quote it;
//  - the upstream request is rebuilt from named values, so a caller cannot smuggle a different
//    client_id, a wider scope, a plain challenge or a second copy of a parameter past the checks.
//
// Module-load env vars: TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL are read once
// at module load by src/lib/cache.ts, src/lib/upstreams.ts and src/routes/gitlab-npm-proxy.ts, so
// they are assigned before any src/ import.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-oauth-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.test.yml";
process.env.PUBLIC_BASE_URL = "https://upm.example.com";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import Fastify from "fastify";
import { Writable } from "node:stream";
import { build, TestContext } from "../helper";
import application, { options } from "../../src/app";

const GITLAB_ORIGIN = "https://gitlab.example.com";
const REDIRECT = "http://127.0.0.1:8765/callback";
const OTHER_REDIRECT = "https://upm.example.com/auth/done";
const CHALLENGE = "a".repeat(43);
const VERIFIER = "b".repeat(64);
const STATE = "c".repeat(43);

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

function enableOAuth(): void {
  process.env.OAUTH_CLIENT_ID = "client-id-for-tests";
  process.env.OAUTH_REDIRECT_URIS = `${REDIRECT},${OTHER_REDIRECT}`;
  process.env.OAUTH_SCOPES = "read_api";
}

function disableOAuth(): void {
  delete process.env.OAUTH_CLIENT_ID;
  delete process.env.OAUTH_REDIRECT_URIS;
  delete process.env.OAUTH_SCOPES;
}

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  enableOAuth();
});

after(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
  disableOAuth();
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

function tokenBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

const FORM = { "content-type": "application/x-www-form-urlencoded" };

// A deployment that never configures OAuth must be unaffected. The variables are optional for
// exactly this reason: a required one would stop the process at module load on every existing
// installation the moment it restarted.
test("OAuthが未構成なら、対応していないと答え他の経路は404になる", async (t: TestContext) => {
  disableOAuth();
  t.after(() => enableOAuth());
  const app = await build(t);

  const config = await app.inject({ method: "GET", url: "/auth/config" });
  assert.equal(config.statusCode, 200);
  assert.deepEqual(config.json(), { protocolVersion: 1, oauth: { enabled: false } });

  const authorize = await app.inject({ method: "GET", url: "/auth/authorize" });
  assert.equal(authorize.statusCode, 404);
  assert.deepEqual(authorize.json(), { error: "oauth_not_configured" });

  const token = await app.inject({
    method: "POST",
    url: "/auth/token",
    headers: FORM,
    payload: tokenBody({ grant_type: "refresh_token", refresh_token: "r" })
  });
  assert.equal(token.statusCode, 404);
});

// A redirect URI that is neither https nor loopback would carry an authorization code in the clear.
// Refusing the whole feature is the safe reading: the alternative is a deployment that believes
// OAuth is configured while codes travel over plain HTTP.
test("平文HTTPの非loopback redirect URIが混じると、OAuthだけが無効になる", async (t: TestContext) => {
  process.env.OAUTH_REDIRECT_URIS = `${REDIRECT},http://example.org/callback`;
  t.after(() => enableOAuth());
  const app = await build(t);

  const res = await app.inject({ method: "GET", url: "/auth/config" });
  assert.equal(res.statusCode, 200);
  assert.equal((res.json() as any).oauth.enabled, false, "an unsafe redirect URI disables OAuth");
});

test("構成が有効なら、Unityが必要とする契約を返す", async (t: TestContext) => {
  const app = await build(t);
  const res = await app.inject({ method: "GET", url: "/auth/config" });
  assert.equal(res.statusCode, 200);
  const body = (res.json() as any).oauth;
  assert.equal(body.enabled, true);
  assert.equal(body.clientId, "client-id-for-tests");
  assert.deepEqual(body.scopes, ["read_api"]);
  assert.deepEqual(body.redirectUris, [REDIRECT, OTHER_REDIRECT]);
  assert.deepEqual(body.codeChallengeMethods, ["S256"]);
  // Both of these exist to stop a false assumption: that the proxy checks state, and that the
  // client id belongs to one user.
  assert.equal(body.stateVerifiedBy, "client");
  assert.equal(body.clientIsShared, true);
  assert.equal(res.headers["cache-control"], "no-store");
});

test("認可開始は、設定値から組み立てた上流URLへリダイレクトする", async (t: TestContext) => {
  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: `/auth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&state=${STATE}&code_challenge=${CHALLENGE}&code_challenge_method=S256`
  });
  assert.equal(res.statusCode, 302);
  const location = new URL(String(res.headers.location));
  assert.equal(location.origin + location.pathname, `${GITLAB_ORIGIN}/oauth/authorize`);
  assert.equal(location.searchParams.get("client_id"), "client-id-for-tests");
  assert.equal(location.searchParams.get("response_type"), "code");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.equal(location.searchParams.get("redirect_uri"), REDIRECT);
  assert.equal(location.searchParams.get("scope"), "read_api");
  assert.equal(location.searchParams.get("state"), STATE);
});

// Each of these is a way to get the proxy to author a request it did not intend. An exact-match
// redirect list is what keeps this from being an open redirect; a subset check is what keeps a
// caller from asking for api when the operator allowed read_api.
test("認可開始は、迂回を狙った入力をすべて拒否する", async (t: TestContext) => {
  const app = await build(t);
  const base = `redirect_uri=${encodeURIComponent(REDIRECT)}&state=${STATE}&code_challenge=${CHALLENGE}`;
  const cases: Array<[string, string]> = [
    ["許可外のredirect_uri", `redirect_uri=${encodeURIComponent("https://evil.example.net/cb")}&state=${STATE}&code_challenge=${CHALLENGE}`],
    ["redirect_uriの前方一致", `redirect_uri=${encodeURIComponent(REDIRECT + ".evil")}&state=${STATE}&code_challenge=${CHALLENGE}`],
    ["scopeの昇格", `${base}&scope=api`],
    ["plainのchallenge", `${base}&code_challenge_method=plain`],
    ["client_idの上書き", `${base}&client_id=other`],
    ["response_typeの上書き", `${base}&response_type=token`],
    ["redirect_uriの重複", `redirect_uri=${encodeURIComponent(REDIRECT)}&redirect_uri=${encodeURIComponent(OTHER_REDIRECT)}&state=${STATE}&code_challenge=${CHALLENGE}`],
    ["短すぎるstate", `redirect_uri=${encodeURIComponent(REDIRECT)}&state=short&code_challenge=${CHALLENGE}`],
    ["形式が不正なchallenge", `redirect_uri=${encodeURIComponent(REDIRECT)}&state=${STATE}&code_challenge=${"!".repeat(43)}`],
    ["challengeの欠落", `redirect_uri=${encodeURIComponent(REDIRECT)}&state=${STATE}`]
  ];
  for (const [name, query] of cases) {
    const res = await app.inject({ method: "GET", url: `/auth/authorize?${query}` });
    assert.equal(res.statusCode, 400, `${name} は拒否される`);
    assert.deepEqual(res.json(), { error: "invalid_request" }, `${name} の応答は最小形`);
  }
});

test("code交換は、上流のtoken応答を検証して返す", async (t: TestContext) => {
  mockAgent
    .get(GITLAB_ORIGIN)
    .intercept({ path: "/oauth/token", method: "POST" })
    .reply(
      200,
      {
        access_token: "at-value",
        token_type: "bearer",
        refresh_token: "rt-value",
        expires_in: 7200,
        created_at: 1_700_000_000,
        scope: "read_api"
      },
      { headers: { "content-type": "application/json" } }
    );

  const app = await build(t);
  const res = await app.inject({
    method: "POST",
    url: "/auth/token",
    headers: FORM,
    payload: tokenBody({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT
    })
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as any;
  // token_type arrives lower case from GitLab and is accepted as such.
  assert.equal(body.token_type, "bearer");
  assert.equal(body.access_token, "at-value");
  assert.equal(body.refresh_token, "rt-value");
  assert.equal(body.expires_in, 7200);
  assert.equal(res.headers["cache-control"], "no-store", "a token must not be cached");
});

// GitLab invalidates the old refresh token when a refresh succeeds. A response without a new one
// leaves the client holding nothing usable, so it is an upstream failure rather than a success.
test("refresh応答に新しいrefresh_tokenが無ければ、成功として返さない", async (t: TestContext) => {
  mockAgent
    .get(GITLAB_ORIGIN)
    .intercept({ path: "/oauth/token", method: "POST" })
    .reply(200, { access_token: "at", token_type: "bearer", expires_in: 7200 }, {
      headers: { "content-type": "application/json" }
    });

  const app = await build(t);
  const res = await app.inject({
    method: "POST",
    url: "/auth/token",
    headers: FORM,
    payload: tokenBody({ grant_type: "refresh_token", refresh_token: "old-rt" })
  });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { error: "upstream_invalid_response" });
});

test("tokenの入力は、grantごとに必要な項目だけを受け付ける", async (t: TestContext) => {
  const app = await build(t);
  const cases: Array<[string, Record<string, string>, string]> = [
    ["未知のgrant", { grant_type: "password", username: "u", password: "p" }, "unsupported_grant_type"],
    ["code_verifierの欠落", { grant_type: "authorization_code", code: "c", redirect_uri: REDIRECT }, "invalid_request"],
    ["許可外のredirect_uri", { grant_type: "authorization_code", code: "c", code_verifier: VERIFIER, redirect_uri: "https://evil.example.net/cb" }, "invalid_request"],
    ["client_idの上書き", { grant_type: "refresh_token", refresh_token: "r", client_id: "other" }, "invalid_request"],
    ["refresh_tokenの欠落", { grant_type: "refresh_token" }, "invalid_request"],
    ["形式が不正なverifier", { grant_type: "authorization_code", code: "c", code_verifier: "short", redirect_uri: REDIRECT }, "invalid_request"]
  ];
  for (const [name, params, expected] of cases) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/token",
      headers: FORM,
      payload: tokenBody(params)
    });
    assert.equal(res.statusCode, 400, `${name} は 400`);
    assert.deepEqual(res.json(), { error: expected }, `${name} の分類`);
  }
});

test("同じパラメータが2つ来た場合は受け付けない", async (t: TestContext) => {
  const app = await build(t);
  const res = await app.inject({
    method: "POST",
    url: "/auth/token",
    headers: FORM,
    payload: "grant_type=refresh_token&refresh_token=one&refresh_token=two"
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: "invalid_request" });
});

test("上流がgrantを拒否した場合はinvalid_grantとして返す", async (t: TestContext) => {
  mockAgent
    .get(GITLAB_ORIGIN)
    .intercept({ path: "/oauth/token", method: "POST" })
    .reply(400, { error: "invalid_grant", error_description: "detail from upstream" }, {
      headers: { "content-type": "application/json" }
    });

  const app = await build(t);
  const res = await app.inject({
    method: "POST",
    url: "/auth/token",
    headers: FORM,
    payload: tokenBody({ grant_type: "refresh_token", refresh_token: "old" })
  });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { error: "invalid_grant" }, "上流の説明文を転載しない");
});

// The reason this test exists: readUpstreamJson puts the JSON.parse message into its error, and
// Node includes a slice of the input in that message. On this path the input is a token document.
// A malformed answer must therefore be reported without any of it.
test("上流の壊れた応答を返すとき、その中身を応答へ載せない", async (t: TestContext) => {
  const secret = "token-value-SHOULD-NOT-APPEAR";
  mockAgent
    .get(GITLAB_ORIGIN)
    .intercept({ path: "/oauth/token", method: "POST" })
    .reply(200, `{"access_token":"${secret}",`, {
      headers: { "content-type": "application/json" }
    });

  const app = await build(t);
  const res = await app.inject({
    method: "POST",
    url: "/auth/token",
    headers: FORM,
    payload: tokenBody({ grant_type: "refresh_token", refresh_token: "old" })
  });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { error: "upstream_invalid_response" });
  assert.ok(!res.body.includes(secret), "上流の本文が応答へ出ない");
  assert.ok(!res.body.includes("access_token"), "断片も出ない");
});

test("本人確認は、トークン無しを拒否し最小限の属性だけ返す", async (t: TestContext) => {
  mockAgent
    .get(GITLAB_ORIGIN)
    .intercept({ path: "/api/v4/user", method: "GET" })
    .reply(
      200,
      { id: 7, username: "tester", name: "Tester", email: "secret@example.com", is_admin: true },
      { headers: { "content-type": "application/json" } }
    );

  const app = await build(t);
  const missing = await app.inject({ method: "GET", url: "/auth/user" });
  assert.equal(missing.statusCode, 401);
  assert.deepEqual(missing.json(), { error: "missing_token" });

  const res = await app.inject({
    method: "GET",
    url: "/auth/user",
    headers: { authorization: "Bearer some-token" }
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { id: 7, username: "tester", name: "Tester" });
  assert.ok(!res.body.includes("email"), "email を転載しない");
  assert.ok(!res.body.includes("is_admin"), "権限の別は返さない");
});

test("上流が本人確認を拒否したら401として返す", async (t: TestContext) => {
  mockAgent
    .get(GITLAB_ORIGIN)
    .intercept({ path: "/api/v4/user", method: "GET" })
    .reply(401, { message: "401 Unauthorized" }, { headers: { "content-type": "application/json" } });

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/auth/user",
    headers: { authorization: "Bearer expired" }
  });
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { error: "invalid_token" });
});

// The separation this checks is structural, not stated: the package routes register their PAT hook
// on their own plugin, and AutoLoad gives each route file its own encapsulation context. If either
// file were ever wrapped in fastify-plugin, the hook would escape and this would fail.
test("OAuth経路は認証不要のまま、既存のパッケージ経路は認証を要求し続ける", async (t: TestContext) => {
  const app = await build(t);

  const config = await app.inject({ method: "GET", url: "/auth/config" });
  assert.equal(config.statusCode, 200, "OAuth の構成取得はトークン無しで通る");

  const pkg = await app.inject({ method: "GET", url: "/api/v4/groups/my-group/widget" });
  assert.equal(pkg.statusCode, 401, "パッケージ経路はトークン無しを拒否し続ける");
  assert.deepEqual(pkg.json(), { error: "missing_token" });
});

// The limiter is per plugin instance, so this budget is this application's alone. A module-level
// counter would make the outcome depend on what the other cases in this file did first.
test("tokenの要求は、同一の呼び出し元に対して毎分の上限で頭打ちになる", async (t: TestContext) => {
  const app = await build(t);
  const send = () =>
    app.inject({
      method: "POST",
      url: "/auth/token",
      headers: FORM,
      payload: tokenBody({ grant_type: "refresh_token" })
    });

  // Each of these is rejected as invalid_request before any upstream call, but still counted.
  for (let i = 0; i < 10; i += 1) {
    const res = await send();
    assert.equal(res.statusCode, 400, `${i + 1} 回目は上限内`);
  }
  const limited = await send();
  assert.equal(limited.statusCode, 429, "11 回目は上限に達する");
  assert.deepEqual(limited.json(), { error: "rate_limited" });
  assert.equal(limited.headers["cache-control"], "no-store");
});

function captureStream(lines: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    }
  });
}

// What reaches GitLab has to be built from the named values, not forwarded. Matching only the path
// and the method - as the other cases here do - would pass even if the caller's client_id, an
// unknown extra parameter, or the wrong grant went upstream.
test("上流へ送る項目は、許可したものだけで組み立て直される", async (t: TestContext) => {
  let seenBody = "";
  let seenContentType = "";
  mockAgent
    .get(GITLAB_ORIGIN)
    .intercept({ path: "/oauth/token", method: "POST" })
    .reply(
      200,
      (opts: any) => {
        seenBody = String(opts.body || "");
        seenContentType = String((opts.headers || {})["content-type"] || "");
        return {
          access_token: "at",
          token_type: "bearer",
          refresh_token: "rt",
          expires_in: 7200
        };
      },
      { headers: { "content-type": "application/json" } }
    );

  const app = await build(t);
  const res = await app.inject({
    method: "POST",
    url: "/auth/token",
    headers: FORM,
    payload: tokenBody({
      grant_type: "authorization_code",
      code: "the-code",
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      // Neither of these may survive: one is fixed by configuration, the other is not ours.
      extra_param: "should-be-dropped",
      scope: "api"
    })
  });
  assert.equal(res.statusCode, 200);

  const sent = new URLSearchParams(seenBody);
  assert.equal(seenContentType, "application/x-www-form-urlencoded");
  assert.equal(sent.get("client_id"), "client-id-for-tests", "設定値の client_id を使う");
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("code"), "the-code");
  assert.equal(sent.get("code_verifier"), VERIFIER);
  assert.equal(sent.get("redirect_uri"), REDIRECT);
  assert.equal(sent.get("extra_param"), null, "未知の項目を転送しない");
  assert.equal(sent.get("scope"), null, "token 要求に scope を持ち込ませない");
  assert.deepEqual(
    [...new Set(sent.keys())].sort(),
    ["client_id", "code", "code_verifier", "grant_type", "redirect_uri"],
    "送られるのは許可した 5 項目だけ"
  );
});

test("本人確認では、呼び出し元のAuthorizationがそのまま上流へ渡る", async (t: TestContext) => {
  let seenAuth = "";
  mockAgent
    .get(GITLAB_ORIGIN)
    .intercept({ path: "/api/v4/user", method: "GET" })
    .reply(
      200,
      (opts: any) => {
        const headers = (opts.headers || {}) as Record<string, string>;
        seenAuth = String(headers.Authorization || headers.authorization || "");
        return { id: 1, username: "u", name: "n" };
      },
      { headers: { "content-type": "application/json" } }
    );

  const app = await build(t);
  const res = await app.inject({
    method: "GET",
    url: "/auth/user",
    headers: { authorization: "Bearer the-callers-token" }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(seenAuth, "Bearer the-callers-token");
});

// A JSON object cannot carry a repeated key, so allowing JSON would mean the duplicate check
// applies to one encoding and not the other.
test("フォーム以外の形式でのtoken要求は受け付けない", async (t: TestContext) => {
  const app = await build(t);
  const res = await app.inject({
    method: "POST",
    url: "/auth/token",
    headers: { "content-type": "application/json" },
    payload: { grant_type: "refresh_token", refresh_token: "r" }
  });
  assert.equal(res.statusCode, 415);
  assert.deepEqual(res.json(), { error: "unsupported_media_type" });
});

test("上流が過大な応答を宣言した場合、読み切らずに失敗として返す", async (t: TestContext) => {
  mockAgent
    .get(GITLAB_ORIGIN)
    .intercept({ path: "/oauth/token", method: "POST" })
    .reply(200, "x".repeat(200_000), {
      headers: { "content-type": "application/json", "content-length": "200000" }
    });

  const app = await build(t);
  const res = await app.inject({
    method: "POST",
    url: "/auth/token",
    headers: FORM,
    payload: tokenBody({ grant_type: "refresh_token", refresh_token: "old" })
  });
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), { error: "upstream_invalid_response" });
});

// Under a mount prefix the client has no way to discover the real paths except from here, and a
// hard-coded /auth would send it to routes that do not exist.
test("マウント配下では、構成が返す経路もprefixを含む", async () => {
  const server = Fastify();
  void server.register(application, { prefix: "/proxy" });
  await server.ready();
  try {
    const res = await server.inject({ method: "GET", url: "/proxy/auth/config" });
    assert.equal(res.statusCode, 200);
    const endpoints = (res.json() as any).oauth.endpoints;
    assert.deepEqual(endpoints, {
      authorize: "/proxy/auth/authorize",
      token: "/proxy/auth/token",
      user: "/proxy/auth/user"
    });

    const authorize = await server.inject({
      method: "GET",
      url: `${endpoints.authorize}?redirect_uri=${encodeURIComponent(REDIRECT)}&state=${STATE}&code_challenge=${CHALLENGE}`
    });
    assert.equal(authorize.statusCode, 302, "構成が示した経路に実体がある");
  } finally {
    await server.close();
  }
});

// The design requires that no secret reaches a log on any path. This drives the real logger
// configuration and inspects every line, because the response body alone would not show it.
test("どの失敗経路でも、code・verifier・トークンがログへ出ない", async () => {
  const CODE = "CODE-THAT-MUST-NOT-BE-LOGGED";
  const VERIFIER_SECRET = "v".repeat(50) + "SECRET";
  const UPSTREAM_TOKEN = "upstream-token-THAT-MUST-NOT-BE-LOGGED";

  mockAgent
    .get(GITLAB_ORIGIN)
    .intercept({ path: "/oauth/token", method: "POST" })
    .reply(200, `{"access_token":"${UPSTREAM_TOKEN}",`, {
      headers: { "content-type": "application/json" }
    })
    .times(2);

  const lines: string[] = [];
  const server = Fastify({
    logger: {
      ...(options.logger as Record<string, unknown>),
      level: "info",
      stream: captureStream(lines)
    }
  });
  void server.register(application);
  await server.ready();
  try {
    // A malformed upstream answer: the branch where a quoted parse error would carry the token.
    await server.inject({
      method: "POST",
      url: "/auth/token",
      headers: FORM,
      payload: tokenBody({
        grant_type: "authorization_code",
        code: CODE,
        code_verifier: VERIFIER_SECRET.slice(0, 56),
        redirect_uri: REDIRECT
      })
    });
    // A rejected request: the branch that logs oauth_request_rejected.
    await server.inject({
      method: "POST",
      url: "/auth/token",
      headers: FORM,
      payload: tokenBody({ grant_type: "authorization_code", code: CODE, redirect_uri: REDIRECT })
    });
    // The authorization start, whose query carries the state and the challenge.
    await server.inject({
      method: "GET",
      url: `/auth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&state=${STATE}&code_challenge=${CHALLENGE}`
    });
  } finally {
    await server.close();
  }

  assert.ok(lines.length > 0, "ログが実際に出ていること");
  for (const secret of [CODE, VERIFIER_SECRET.slice(0, 56), UPSTREAM_TOKEN]) {
    const leaked = lines.filter((line) => line.includes(secret));
    assert.deepEqual(leaked, [], `秘密がログへ出ない: ${secret.slice(0, 12)}`);
  }
});
