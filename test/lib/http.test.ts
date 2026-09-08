// Unit tests for the shared upstream fetch helper in src/lib/http.ts.
//
// The route tests in test/routes/vpm-index-fetch.test.ts pin that the VPM index actually goes
// through this helper. What is checked here is what the helper itself guarantees on a redirect
// chain: the caller's credentials stop at the origin the fetch started from, and a chain that
// never ends is bounded rather than followed forever.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

import { fetchJsonWithRedirects } from "../../src/lib/http";

const FIRST_ORIGIN = "https://registry.example.com";
const OTHER_ORIGIN = "https://cdn.example.org";

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
});

// Follow-the-credentials is how tokens end up in someone else's logs. The PAT authorizes the
// registry the caller pointed at; a redirect to a CDN is a different party entirely.
test(
  "オリジンをまたぐリダイレクトでは資格情報が落とされる",
  async () => {
    mockAgent
      .get(FIRST_ORIGIN)
      .intercept({ path: "/index.json", method: "GET" })
      .reply(302, "", { headers: { location: `${OTHER_ORIGIN}/index.json` } });

    let seen: Record<string, string> = {};
    mockAgent
      .get(OTHER_ORIGIN)
      .intercept({
        path: "/index.json",
        method: "GET",
        headers(headers) {
          seen = normalizeHeaders(headers);
          return true;
        }
      })
      .reply(200, { ok: true }, { headers: { "content-type": "application/json" } });

    const body = await fetchJsonWithRedirects<{ ok: boolean }>(
      `${FIRST_ORIGIN}/index.json`,
      {
        Authorization: "Bearer secret-token",
        "PRIVATE-TOKEN": "secret-pat",
        cookie: "session=secret-session",
        accept: "application/json"
      },
      "test_fetch_failed"
    );

    assert.equal(body.ok, true);
    assert.equal(seen["authorization"], undefined, "the bearer token must not cross origins");
    assert.equal(seen["private-token"], undefined, "the PAT must not cross origins");
    assert.equal(seen["cookie"], undefined, "the session cookie must not cross origins");
    assert.equal(seen["accept"], "application/json", "unrelated headers still travel");
  }
);

// A registry that redirects to itself forever must not hang the request.
test(
  "リダイレクトが上限を超えると、本文を解析せずエラーになる",
  async () => {
    mockAgent
      .get(FIRST_ORIGIN)
      .intercept({ path: "/loop.json", method: "GET" })
      .reply(301, "", { headers: { location: `${FIRST_ORIGIN}/loop.json` } })
      .persist();

    await assert.rejects(
      () => fetchJsonWithRedirects(`${FIRST_ORIGIN}/loop.json`, {}, "test_fetch_failed", 2),
      /test_fetch_failed:301/
    );
  }
);

// A bodyless success is not a document, and parsing one used to be how a 304 became a 500.
test(
  "本文を持たない成功応答は解析されずエラーになる",
  async () => {
    mockAgent
      .get(FIRST_ORIGIN)
      .intercept({ path: "/empty.json", method: "GET" })
      .reply(204, "", { headers: { "content-type": "application/json" } });

    await assert.rejects(
      () => fetchJsonWithRedirects(`${FIRST_ORIGIN}/empty.json`, {}, "test_fetch_failed"),
      /test_fetch_failed:204/
    );
  }
);
