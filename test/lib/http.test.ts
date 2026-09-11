// Unit tests for the shared upstream fetch helper in src/lib/http.ts.
//
// The route tests in test/routes/vpm-index-fetch.test.ts pin that the VPM index actually goes
// through this helper. What is checked here is what the helper itself guarantees on a redirect
// chain: the caller's credentials stop at the origin the fetch started from, and a chain that
// never ends is bounded rather than followed forever.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

import {
  fetchBufferWithRedirects,
  fetchJsonWithRedirects,
  UpstreamError
} from "../../src/lib/http";

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

// Regression for the tenth round of the second review cycle: the binary fetcher rejected only
// statuses of 400 and above, so an unresolved redirect at the final allowed hop fell through and
// its body was returned as archive bytes - and the redirects-exceeded error below it could never
// be reached. The JSON fetcher had always checked this; the two had drifted apart.
test(
  "リダイレクトが上限を超えた場合、その本文をアーカイブとして返さない",
  async () => {
    mockAgent
      .get(FIRST_ORIGIN)
      .intercept({ path: "/dl/loop.zip", method: "GET" })
      .reply(302, "not an archive", { headers: { location: `${FIRST_ORIGIN}/dl/loop.zip` } })
      .persist();

    await assert.rejects(
      () => fetchBufferWithRedirects(`${FIRST_ORIGIN}/dl/loop.zip`, {}, 2),
      /zip_download_failed:302/,
      "an unfollowed redirect is not a download"
    );
  }
);

// A body that fails midway - headers sent, then the connection drops - is wrapped as an upstream
// failure too, but has no test here: MockAgent raises a throwing reply at dispatch time, which
// the request wrapper already covered, so a test written against it passed with the body
// wrapper removed. Rather than keep a case that proves nothing, it is left out and said so.
//
// And a document that cannot be parsed is the upstream's failure too, not a 500 from here.
test(
  "解析できないJSONは上流の失敗として扱われる",
  async () => {
    mockAgent
      .get(FIRST_ORIGIN)
      .intercept({ path: "/broken.json", method: "GET" })
      .reply(200, '{"packages": {', { headers: { "content-type": "application/json" } });

    await assert.rejects(
      () => fetchJsonWithRedirects(`${FIRST_ORIGIN}/broken.json`, {}, "test_fetch_failed"),
      (err: unknown) => err instanceof UpstreamError,
      "a truncated document is not something this proxy got wrong"
    );
  }
);

// Regression for the real-machine report on 2026-09-11. Bounding the JSON reads replaced undici's
// body.json() with a buffer read and JSON.parse. body.json() decodes through the WHATWG UTF-8
// decode, which drops one leading BOM; Buffer.toString keeps it as U+FEFF and JSON.parse then
// rejects the document. Every upstream JSON - metadata, search, the signing key document, the VPM
// index - came back as a 502 if the registry served a BOM.
test(
  "BOM付きのJSONは、上流が壊れた応答を返したものとして扱われない",
  async () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"packages":{"com.example.pkg":{}}}', "utf-8")
    ]);

    mockAgent
      .get(FIRST_ORIGIN)
      .intercept({ path: "/bom.json", method: "GET" })
      .reply(200, withBom, { headers: { "content-type": "application/json" } });

    const parsed = await fetchJsonWithRedirects<{ packages: Record<string, unknown> }>(
      `${FIRST_ORIGIN}/bom.json`,
      {},
      "test_fetch_failed"
    );

    assert.deepEqual(
      Object.keys(parsed.packages),
      ["com.example.pkg"],
      "a byte order mark is not a parse error"
    );
  }
);
