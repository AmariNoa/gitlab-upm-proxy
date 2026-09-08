// Route test for the tarball URL rewriting applied to non-default npm upstreams.
//
// A registry served under a path ("https://npm.example.org/registry") publishes tarball URLs
// under that path. The proxy rewrites them to its own group route, whose first path segment is
// read back as the package name - so the registry's base path has to come off, or the request
// routes to the default upstream instead and the package cannot be downloaded at all.
//
// Module-load env vars: TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL are read
// once at module load by src/lib/cache.ts, src/lib/upstreams.ts and
// src/routes/gitlab-npm-proxy.ts, so they are assigned before any src/ import (same
// constraint documented in test/routes/vpm-tarball-convert.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-basepath-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.basepath.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.basepath.example.net";

import { build, TestContext } from "../helper";

const DEFAULT_ORIGIN = "https://gitlab.example.com";
const SCOPED_ORIGIN = "https://npm.example.org";
const PUBLIC_BASE_URL = "https://proxy.basepath.example.net";

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: "/api/v4/user", method: "GET" })
    .reply(200, { id: 1, username: "tester" })
    .persist();
});

after(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
  rmSync(tarballCacheDir, { recursive: true, force: true });
});

test(
  "ベースパスを持つupstreamのtarball URLは、そのベースパスを含まない形へ書き換えられる",
  async (t: TestContext) => {
    const packageName = "com.example.based.pkg";
    const version = "1.0.0";
    const upstreamTarball = `${SCOPED_ORIGIN}/registry/${packageName}/-/${packageName}-${version}.tgz`;

    mockAgent
      .get(SCOPED_ORIGIN)
      .intercept({ path: `/registry/${packageName}`, method: "GET" })
      .reply(
        200,
        {
          name: packageName,
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              name: packageName,
              version,
              author: { name: "Test Author" },
              displayName: "Based Package",
              dist: { tarball: upstreamTarball, shasum: "0".repeat(40) }
            }
          }
        },
        { headers: { "content-type": "application/json" } }
      );

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/my-group/${packageName}`,
      headers: { "private-token": "valid-token" }
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { versions: Record<string, { dist: { tarball: string } }> };
    const rewritten = body.versions[version].dist.tarball;

    assert.equal(
      rewritten,
      `${PUBLIC_BASE_URL}/api/v4/groups/my-group/${packageName}/-/${packageName}-${version}.tgz`,
      "the registry's base path must not survive into the proxy's own route"
    );

    // The decisive part: the URL the proxy published has to route back to this package, and
    // therefore to the registry that owns it - not to the default upstream.
    let downloadedFrom = "";
    mockAgent
      .get(SCOPED_ORIGIN)
      .intercept({
        path: (path) => {
          if (!path.startsWith(`/registry/${packageName}/-/`)) return false;
          downloadedFrom = path;
          return true;
        },
        method: "GET"
      })
      .reply(200, Buffer.from("tarball-bytes"), {
        headers: { "content-type": "application/octet-stream" }
      });

    const download = await app.inject({
      method: "GET",
      url: new URL(rewritten).pathname,
      headers: { "private-token": "valid-token" }
    });

    assert.equal(download.statusCode, 200, "the published URL must resolve");
    assert.equal(
      downloadedFrom,
      `/registry/${packageName}/-/${packageName}-${version}.tgz`,
      "and it must reach the registry that owns the package"
    );
  }
);
