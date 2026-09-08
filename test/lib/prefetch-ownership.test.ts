// Regression test for which packages a VPM prefetch pass may write into the cache.
//
// The pass checked only whether a package matched its own entry's scopes. Scopes can overlap and
// selectUpstream picks the first entry that matches, so a package can match a VPM entry while
// being served by an npm entry listed before it. The tarball cache is keyed on the upstream's HOST
// and the package name, so two entries on the same host share one directory: the prefetch would
// publish its converted archive exactly where a download from the other registry finds it, and
// that download would be answered from cache without the registry ever being asked.
//
// Module-load env vars: TARBALL_CACHE_DIR is read once at module load by src/lib/cache.ts, and
// UPSTREAM_CONFIG_PATH at first use by src/lib/upstreams.ts, so both are assigned before any src/
// import (same constraint documented in test/routes/vpm-tarball-convert.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-prefetch-owner-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.shared-host.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.prefetch-owner.example.net";

import { prefetchForUpstream } from "../../src/lib/vpm-prefetch";
import { getUpstreamConfig, selectUpstream } from "../../src/lib/upstreams";
import { hasTarballCache, readMetadataCache } from "../../src/lib/cache";
import { buildStoredZip } from "./zip-fixture";

const SHARED_ORIGIN = "https://registry.example.org";
const PACKAGE_NAME = "com.example.shared.pkg";
const VERSION = "1.0.0";

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;
let zipDownloads = 0;

const noopLog = { info: () => {} };

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  mockAgent
    .get(SHARED_ORIGIN)
    .intercept({ path: "/vpm.json", method: "GET" })
    .reply(
      200,
      {
        packages: {
          [PACKAGE_NAME]: {
            versions: {
              [VERSION]: {
                name: PACKAGE_NAME,
                version: VERSION,
                author: { name: "A" },
                url: `${SHARED_ORIGIN}/dl/${PACKAGE_NAME}-${VERSION}.zip`
              }
            }
          }
        }
      },
      { headers: { "content-type": "application/json" } }
    )
    .persist();

  mockAgent
    .get(SHARED_ORIGIN)
    .intercept({ path: `/dl/${PACKAGE_NAME}-${VERSION}.zip`, method: "GET" })
    .reply(200, () => {
      zipDownloads += 1;
      return buildStoredZip([
        {
          name: "package.json",
          data: Buffer.from(JSON.stringify({ name: PACKAGE_NAME, version: VERSION }))
        }
      ]);
    })
    .persist();
});

after(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

test(
  "別のupstreamが担当するパッケージは、同じホストを共有していてもprefetchされない",
  async () => {
    const config = getUpstreamConfig();
    const vpmUpstream = config.upstreams.find((entry) => entry.type === "vpm");
    assert.ok(vpmUpstream, "the fixture must define a VPM upstream");
    // The premise: both entries match this name, they share a host, and the npm one wins.
    assert.equal(
      selectUpstream(PACKAGE_NAME).baseUrl,
      `${SHARED_ORIGIN}/npm`,
      "the npm entry is the one that would serve this package"
    );
    assert.equal(selectUpstream(PACKAGE_NAME).host, vpmUpstream!.host, "and they share a host");

    await prefetchForUpstream(vpmUpstream!, 0, noopLog);

    assert.equal(zipDownloads, 0, "the archive of a package this upstream does not serve");
    assert.equal(
      await hasTarballCache(vpmUpstream!.host, PACKAGE_NAME, `${PACKAGE_NAME}-${VERSION}.tgz`),
      false,
      "nothing may be published where the other registry's download would find it"
    );
    assert.equal(
      await readMetadataCache(vpmUpstream!.host, PACKAGE_NAME),
      null,
      "and no metadata may be written for it either"
    );
  }
);
