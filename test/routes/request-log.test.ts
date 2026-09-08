// Route test for what the per-request log records.
//
// The proxy forwards the caller's query string to the upstream and preserves the signed query
// GitLab puts on its tarball URLs, so a request URL routinely carries a working download
// credential. Logging it verbatim writes that credential into wherever the logs go, where it
// outlives the signature's own expiry. Both the proxy's own req_in line and Fastify's built-in
// incoming-request line must therefore record the path only.
//
// The second test below drives the real startup command instead of a hand-built server,
// because the serializer only reaches Fastify when fastify-cli is told to read the options
// src/app.ts exports - and for one round it was not: the exported serializer was correct and
// completely inert in production.
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cliHelper = require("fastify-cli/helper.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageJson = require("../../package.json");

const APP_PATH = join(__dirname, "..", "..", "src", "app.ts");

after(() => {
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

// A value that only ever appears in the query string, so any log line containing it can only
// have come from logging the raw URL.
const SECRET = "SIGNED-QUERY-THAT-MUST-NOT-BE-LOGGED";
const PATH = "/api/v4/groups/g/com.example.pkg/-/com.example.pkg-1.0.0.tgz";

function captureStream(lines: string[]): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    }
  });
}

/**
 * The fastify-cli arguments of an npm script, with the built entry point swapped for the
 * TypeScript source so the test drives the same flags production does. The script is expected
 * to end with a single `fastify start ...` invocation.
 */
function fastifyArgsOf(scriptName: string): string[] {
  const script = String(packageJson.scripts[scriptName]);
  const invocation = script.split("&&").pop()!.trim().split(/\s+/);
  assert.deepEqual(
    invocation.slice(0, 2),
    ["fastify", "start"],
    `expected the ${scriptName} script to end with a fastify start invocation`
  );
  return invocation.slice(2).map((arg) => (arg.endsWith("app.js") ? APP_PATH : arg));
}

test(
  "リクエストログにクエリ文字列（署名付きURLの資格情報）が出力されない",
  async () => {
    const lines: string[] = [];
    const server = Fastify({
      logger: { ...(options.logger as Record<string, unknown>), level: "info", stream: captureStream(lines) }
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

// Regression for the fourth round of the second review cycle. fastify-cli only merges the
// `options` a server module exports when the command line says --options, and the start
// commands did not. The serializer above was therefore correct and entirely inert in the
// running proxy: Fastify's built-in incoming-request line kept printing signed tarball URLs.
// This test runs the flags the npm start script actually carries, so dropping --options from it
// fails here.
test(
  "npm start が実際に渡すフラグで起動しても、クエリ文字列がログへ出力されない",
  async () => {
    const lines: string[] = [];
    const args = fastifyArgsOf("start");

    // The third argument is merged into the server options before the module's own exported
    // options, exactly as a --logging-module would be, so only the capture stream is injected;
    // whether the serializer arrives is decided by the flags in args.
    const server = await cliHelper.build(args, { skipOverride: true }, {
      logger: { level: "info", stream: captureStream(lines) }
    });
    try {
      await server.inject({ method: "GET", url: `${PATH}?signature=${SECRET}` });
    } finally {
      await server.close();
    }

    const incoming = lines.filter((line) => line.includes("incoming request"));
    assert.ok(incoming.length > 0, "Fastify's own request log line must have been emitted");
    for (const line of incoming) {
      assert.ok(line.includes(PATH), "the serializer must still record the path");
    }
    const leaked = lines.filter((line) => line.includes(SECRET));
    assert.deepEqual(leaked, [], "no log line may carry the query string");
  }
);

// The development start command has to carry the same flag; it is not exercised above because
// its -P (pretty logs) reformats the output this test reads.
test("dev:start も --options を渡す", () => {
  assert.ok(
    fastifyArgsOf("dev:start").includes("--options"),
    "the dev:start script must read the options exported by src/app.ts"
  );
});
