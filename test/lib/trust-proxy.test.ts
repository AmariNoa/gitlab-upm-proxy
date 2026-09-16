// Unit tests for the optional reverse proxy trust setting, and for the one thing a unit test of
// the parser cannot show: that src/app.ts actually wires the environment variable into the server
// options. The test helper starts the application through fastify-cli without --options, so the
// wiring is not exercised by any of the route tests - which is exactly how a setting can look
// correct in isolation and do nothing in production.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-trust-proxy-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.test.yml";
process.env.PUBLIC_BASE_URL = "https://upm.example.com";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";
// Read once, when src/app.ts is first imported below.
process.env.TRUST_PROXY = "127.0.0.1, 10.0.0.0/8";

import Fastify from "fastify";
import { resolveTrustProxy } from "../../src/lib/env";
import { options } from "../../src/app";

after(() => {
  delete process.env.TRUST_PROXY;
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

test("設定が無いか空なら、Fastify の既定を変えない", () => {
  for (const raw of [undefined, "", "   ", "\t"]) {
    assert.equal(resolveTrustProxy(raw), undefined, JSON.stringify(raw));
  }
});

test("真偽値とホップ数は、そのまま Fastify の形式で返る", () => {
  assert.equal(resolveTrustProxy("true"), true);
  assert.equal(resolveTrustProxy("TRUE"), true);
  assert.equal(resolveTrustProxy(" false "), false);
  assert.equal(resolveTrustProxy("0"), 0);
  assert.equal(resolveTrustProxy("2"), 2);
});

test("アドレスと範囲、および proxy-addr の別名を受け付ける", () => {
  assert.equal(resolveTrustProxy("127.0.0.1"), "127.0.0.1");
  assert.equal(resolveTrustProxy(" 10.0.0.0/8 , 172.16.0.0/12 "), "10.0.0.0/8,172.16.0.0/12");
  assert.equal(resolveTrustProxy("::1"), "::1");
  assert.equal(resolveTrustProxy("fd00::/8"), "fd00::/8");
  assert.equal(resolveTrustProxy("loopback"), "loopback");
  assert.equal(resolveTrustProxy("uniquelocal"), "uniquelocal");
});

// A malformed value must stop the process rather than quietly trust more or less than intended.
// Silently falling back would leave an operator believing a boundary is in force that is not.
test("解釈できない値は起動時の設定エラーになる", () => {
  const bad: Array<[string, string]> = [
    ["負数", "-1"],
    ["小数", "1.5"],
    ["指数表記", "1e3"],
    ["安全な整数を超える値", "99999999999999999999"],
    ["ホスト名", "proxy.example.com"],
    ["空の要素", "127.0.0.1,,10.0.0.1"],
    ["末尾のカンマ", "127.0.0.1,"],
    ["範囲の桁が不正", "10.0.0.0/33"],
    ["範囲の指定が非数値", "10.0.0.0/x"],
    ["アドレスが不正", "10.0.0.256"],
    // proxy-addr refuses these, so accepting them would move the failure to server construction.
    ["長さ 0 の範囲", "0.0.0.0/0"],
    ["長さ 0 の範囲（IPv6）", "::/0"]
  ];
  for (const [name, value] of bad) {
    assert.throws(() => resolveTrustProxy(value), /Invalid env: TRUST_PROXY/, name);
  }
});

// The parser and Fastify must agree on what is valid. Checking the return value alone would let a
// value pass here and then throw when the server is constructed, where the message no longer says
// which setting was at fault.
test("受け付けた値は、Fastify がそのまま受理する", () => {
  const accepted = [
    "true",
    "false",
    "0",
    "3",
    "127.0.0.1",
    "10.0.0.0/8, 172.16.0.0/12",
    "::1",
    "fd00::/8",
    "loopback",
    "linklocal",
    "uniquelocal"
  ];
  for (const raw of accepted) {
    const value = resolveTrustProxy(raw);
    assert.doesNotThrow(() => {
      const server = Fastify({ trustProxy: value as any });
      void server.close();
    }, `Fastify must accept ${raw}`);
  }
});

// The wiring, not the parser. If src/app.ts stopped reading the variable, every unit test above
// would still pass and req.ip would silently go back to being the front end's address.
test("src/app.ts の options が TRUST_PROXY を反映している", () => {
  assert.equal(
    (options as any).trustProxy,
    "127.0.0.1,10.0.0.0/8",
    "the exported server options must carry the resolved setting"
  );
});
