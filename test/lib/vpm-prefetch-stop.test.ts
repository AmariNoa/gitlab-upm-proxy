// Verifies that closing the application actually stops the background VPM prefetch.
//
// Nothing awaits the prefetch: src/app.ts starts it and returns. Without a shutdown hook a
// closed server kept downloading archives and writing them into the cache directory the process
// was finished with, and the pacing timer kept the process alive on its own. The test drives the
// real wiring - it builds the app plugin, waits until the prefetch has demonstrably started, and
// then closes the server and checks that the downloads stop.
//
// Module-load env vars: TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL are read once
// at module load by src/lib/cache.ts, src/lib/upstreams.ts and src/routes/gitlab-npm-proxy.ts,
// and VPM_PREFETCH_INTERVAL_SEC once per prefetch run by src/lib/vpm-prefetch.ts, so they are
// assigned before any src/ import (same constraint documented in
// test/routes/vpm-tarball-convert.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-prefetch-stop-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.vpm.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.prefetch-stop.example.net";
// Paced slowly enough that a pass is always mid-flight when the server closes, and slowly
// enough that an unstopped pass keeps downloading well past the close.
process.env.VPM_PREFETCH_INTERVAL_SEC = "0.05";

import app from "../../src/app";
import { buildStoredZip } from "./zip-fixture";

const VPM_ORIGIN = "https://vpm.example.com";
const PACKAGE_NAME = "com.example.vpm.stopping";
// Enough versions that the pass cannot possibly finish before the close below.
const VERSIONS = Array.from({ length: 40 }, (_, i) => `1.0.${i}`);

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;
let downloads = 0;

function zipFor(version: string): Buffer {
  return buildStoredZip([
    {
      name: "package.json",
      data: Buffer.from(
        JSON.stringify({
          name: PACKAGE_NAME,
          version,
          author: { name: "Test Author" }
        })
      )
    }
  ]);
}

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  const versions: Record<string, any> = {};
  for (const version of VERSIONS) {
    versions[version] = {
      name: PACKAGE_NAME,
      version,
      description: "prefetch shutdown test package",
      author: { name: "Test Author" },
      url: `${VPM_ORIGIN}/dl/${PACKAGE_NAME}-${version}.zip`
    };
  }

  mockAgent
    .get(VPM_ORIGIN)
    .intercept({ path: "/index.json", method: "GET" })
    .reply(200, { packages: { [PACKAGE_NAME]: { versions } } }, {
      headers: { "content-type": "application/json" }
    })
    .persist();

  for (const version of VERSIONS) {
    mockAgent
      .get(VPM_ORIGIN)
      .intercept({ path: `/dl/${PACKAGE_NAME}-${version}.zip`, method: "GET" })
      .reply(200, () => {
        downloads += 1;
        return zipFor(version);
      })
      .persist();
  }
});

after(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test(
  "サーバーを閉じるとバックグラウンドprefetchが停止し、以降のダウンロードが発生しない",
  async () => {
    const server = Fastify({ logger: false });
    void server.register(app);
    await server.ready();

    // Wait until the prefetch has demonstrably started, so the close below interrupts a pass
    // rather than racing its start. Bounded, so a prefetch that never runs fails the assertion
    // instead of hanging.
    for (let i = 0; i < 100 && downloads === 0; i++) {
      await wait(20);
    }
    assert.ok(downloads > 0, "the background prefetch must have started before the close");

    await server.close();
    const afterClose = downloads;

    // Long enough for several more paced downloads had the pass kept running.
    await wait(400);

    assert.equal(
      downloads,
      afterClose,
      "no archive may be downloaded after the server finished closing"
    );
    assert.ok(
      afterClose < VERSIONS.length,
      "the pass must have been interrupted, not merely finished on its own"
    );
  }
);

// Regression for the fifth round of the second review cycle: cancelling the pacing sleep resolves
// it normally, and the pass went straight from there into the download it was pausing before. So
// closing a prefetch that was doing nothing but waiting still started one more download, and
// close() then waited for it.
//
// The interval is raised for this case so the close reliably lands inside a sleep: the pass waits
// PACED_INTERVAL_MS before each download, and the settle below is far longer than converting one
// tiny archive but far shorter than that wait.
const PACED_INTERVAL_MS = 400;

test(
  "ペーシング待機中に閉じても、新しいダウンロードは始まらない",
  async () => {
    process.env.VPM_PREFETCH_INTERVAL_SEC = String(PACED_INTERVAL_MS / 1000);
    const startedAt = downloads;
    const server = Fastify({ logger: false });
    void server.register(app);
    await server.ready();

    // The count is incremented when a download is dispatched, so seeing it move means the pass is
    // downloading, not sleeping. Bounded, so a prefetch that never runs fails the assertion.
    for (let i = 0; i < 100 && downloads === startedAt; i++) {
      await wait(20);
    }
    assert.ok(downloads > startedAt, "the background prefetch must have started before the close");

    // Long enough for that download and its conversion to finish, short enough that the pass is
    // still inside the pacing wait before the next one.
    await wait(120);
    const beforeClose = downloads;

    await server.close();
    await wait(PACED_INTERVAL_MS + 400);

    assert.equal(
      downloads,
      beforeClose,
      "cancelling the pacing wait must not release the pass into another download"
    );
  }
);

// Regression for the same round: the stop signal, the tracked passes and the pacing timers used to
// be module-level, so two servers in one process shared them. Closing the first stopped the
// second's prefetch as well.
test(
  "あるサーバーを閉じても、同一プロセスの別サーバーのprefetchは止まらない",
  async () => {
    const first = Fastify({ logger: false });
    void first.register(app);
    await first.ready();

    const second = Fastify({ logger: false });
    void second.register(app);
    await second.ready();

    for (let i = 0; i < 100 && downloads === 0; i++) {
      await wait(20);
    }
    assert.ok(downloads > 0, "at least one prefetch must have started");

    await first.close();
    const afterFirstClose = downloads;

    // The second server is untouched, so its pass keeps going.
    for (let i = 0; i < 100 && downloads === afterFirstClose; i++) {
      await wait(20);
    }
    assert.ok(
      downloads > afterFirstClose,
      "closing one server must not stop the prefetch belonging to another"
    );

    await second.close();
    const afterSecondClose = downloads;
    await wait(400);
    assert.equal(downloads, afterSecondClose, "closing the second server stops its own prefetch");
  }
);
