// Route test for what the per-request log records.
//
// The proxy forwards the caller's query string to the upstream and preserves the signed query
// GitLab puts on its tarball URLs, so a request URL routinely carries a working download
// credential. Logging it verbatim writes that credential into wherever the logs go, where it
// outlives the signature's own expiry. Both the proxy's own req_in line and Fastify's built-in
// incoming-request line must therefore record the path only.
//
// The server is built here rather than through test/helper.ts because fastify-cli's test
// helper disables the logger, so nothing would be observable. The logger options exported by
// src/app.ts (which fastify-cli applies in production) are reused verbatim apart from the
// capture stream, so the serializer under test is the same one the running proxy uses.
//
// Module-load env vars: TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL are read
// once at module load by src/lib/cache.ts, src/lib/upstreams.ts and
// src/routes/gitlab-npm-proxy.ts, so they are assigned before any src/ import (same
// constraint documented in test/routes/vpm-tarball-convert.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-request-log-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.request-log.example.net";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import app, { options } from "../../src/app";

after(() => {
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

// A value that only ever appears in the query string, so any log line containing it can only
// have come from logging the raw URL.
const SECRET = "SIGNED-QUERY-THAT-MUST-NOT-BE-LOGGED";
const PATH = "/api/v4/groups/g/com.example.pkg/-/com.example.pkg-1.0.0.tgz";

test(
  "リクエストログにクエリ文字列（署名付きURLの資格情報）が出力されない",
  async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      }
    });

    const server = Fastify({
      logger: { ...(options.logger as Record<string, unknown>), level: "info", stream }
    });
    void server.register(app);
    await server.ready();
    try {
      // No upstream is mocked: the request itself fails, which is irrelevant. What matters is
      // the log lines emitted on the way in.
      await server.inject({ method: "GET", url: `${PATH}?signature=${SECRET}` });
    } finally {
      await server.close();
    }

    const reqIn = lines.filter((line) => line.includes("req_in"));
    assert.ok(reqIn.length > 0, "the proxy's own request log line must have been emitted");
    for (const line of reqIn) {
      assert.ok(line.includes(PATH), "req_in must still record the path");
    }
    // Fastify's own incoming-request line, produced by the serializer in src/app.ts.
    const incoming = lines.filter((line) => line.includes("incoming request"));
    assert.ok(incoming.length > 0, "Fastify's own request log line must have been emitted");
    for (const line of incoming) {
      assert.ok(line.includes(PATH), "the serializer must still record the path");
    }

    const leaked = lines.filter((line) => line.includes(SECRET));
    assert.deepEqual(leaked, [], "no log line may carry the query string");
  }
);
