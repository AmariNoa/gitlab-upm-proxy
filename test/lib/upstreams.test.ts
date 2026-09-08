// Unit tests for the upstreams config loader.
//
// The YAML is only type-asserted, never checked, so a malformed entry used to survive parsing
// and change routing at request time instead of failing at load. The case that matters is a
// scopes value written as a bare string: selectUpstream iterates it, which iterates its
// characters, and the "*" in a scope like "com.example.*" then matches every package name -
// turning one entry into a catch-all for the whole proxy, silently.
//
// getUpstreamConfig caches its result in a module-level variable but reads UPSTREAM_CONFIG_PATH
// on every call, and a throw leaves the cache empty, so each case below can point the loader at
// its own fixture. The valid case must therefore run last.
import test from "node:test";
import assert from "node:assert/strict";

process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.test.yml";

import { getUpstreamConfig, selectUpstream } from "../../src/lib/upstreams";

test(
  "scopesが配列でない設定は読み込み時に該当項目を示して失敗する",
  () => {
    process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.bad-scopes.test.yml";
    assert.throws(
      () => getUpstreamConfig(),
      /Invalid scopes in upstreams\[0\]/,
      "a scalar scopes value must be rejected, not iterated character by character"
    );
  }
);

test(
  "scopesに文字列以外が混ざった設定も読み込み時に失敗する",
  () => {
    process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.nonstring-scopes.test.yml";
    assert.throws(
      () => getUpstreamConfig(),
      /Invalid scopes in upstreams\[0\]/,
      "a non-string entry must be rejected at load, not at match time"
    );
  }
);

// Ordered last: this one populates the module-level cache, and the throwing cases above rely on
// it still being empty.
test(
  "正しい設定は従来どおり読み込まれ、スコープ選択も変わらない",
  () => {
    process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.vpm.test.yml";
    const config = getUpstreamConfig();
    assert.equal(config.default.baseUrl, "https://gitlab.example.com");
    assert.deepEqual(config.upstreams[0].scopes, ["com.example.vpm.*"]);
    // An entry without a scopes key keeps defaulting to an empty list rather than failing.
    assert.deepEqual(config.default.scopes, []);
    assert.equal(selectUpstream("com.example.vpm.pkg").type, "vpm");
    assert.equal(selectUpstream("com.other.pkg").baseUrl, config.default.baseUrl);
  }
);
