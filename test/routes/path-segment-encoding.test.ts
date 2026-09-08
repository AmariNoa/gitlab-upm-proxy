// Route tests for how a group or project identifier is put back into a URL.
//
// GitLab addresses nested groups and projects by their full path, URL-encoded into one segment:
// "team%2Fsub". Fastify decodes route parameters, so by the time a handler sees it the value is
// "team/sub" despite the parameter's name. Interpolating that straight into a URL splits it into
// two segments, and two things broke:
//
//  - the project route addressed /projects/team/sub/packages/npm/... upstream, which is not that
//    project;
//  - a rewritten tarball URL grew an extra segment, which the next request reads as part of the
//    package path.
//
// Module-load env vars: TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL are read once
// at module load by src/lib/cache.ts, src/lib/upstreams.ts and src/routes/gitlab-npm-proxy.ts, so
// they are assigned before any src/ import (same constraint documented in
// test/routes/vpm-tarball-convert.test.ts).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-path-segment-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.basepath.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.path-segment.example.net";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import { build, TestContext } from "../helper";

const DEFAULT_ORIGIN = "https://gitlab.example.com";
const ROOTED_ORIGIN = "https://npm2.example.org";
const PUBLIC_BASE_URL = "https://proxy.path-segment.example.net";
// A nested group: one identifier, two path components once decoded.
const GROUP_PATH = "team/subgroup";
const GROUP_ENC = encodeURIComponent(GROUP_PATH);

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
  "入れ子プロジェクトのIDは1セグメントとして上流URLへ渡される",
  async (t: TestContext) => {
    const projectPath = "team/subgroup/widget";
    const packageName = "com.example.project";

    // Only a request that keeps the identifier in one segment is answered. Anything that splits
    // it addresses a different path and finds no interceptor.
    mockAgent
      .get(DEFAULT_ORIGIN)
      .intercept({
        path: `/api/v4/projects/${encodeURIComponent(projectPath)}/packages/npm/${packageName}`,
        method: "GET"
      })
      .reply(200, { name: packageName, "dist-tags": { latest: "1.0.0" }, versions: {} }, {
        headers: { "content-type": "application/json" }
      });

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/projects/${encodeURIComponent(projectPath)}/packages/npm/${packageName}`,
      headers: { "private-token": "valid-token" }
    });

    assert.equal(res.statusCode, 200, "the upstream request must address the nested project");
    assert.equal(res.json().name, packageName);
  }
);

test(
  "入れ子グループでも、書き換え後のtarball URLはグループを1セグメントに保つ",
  async (t: TestContext) => {
    const packageName = "com.example.rooted.pkg";
    const version = "1.0.0";
    const upstreamTarball = `${ROOTED_ORIGIN}/${packageName}/-/${packageName}-${version}.tgz`;

    mockAgent
      .get(ROOTED_ORIGIN)
      .intercept({ path: `/${packageName}`, method: "GET" })
      .reply(
        200,
        {
          name: packageName,
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              name: packageName,
              version,
              dist: { tarball: upstreamTarball, shasum: "a".repeat(40) }
            }
          }
        },
        { headers: { "content-type": "application/json" } }
      );

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/api/v4/groups/${GROUP_ENC}/${packageName}`,
      headers: { "private-token": "valid-token" }
    });

    assert.equal(res.statusCode, 200);
    const rewritten = res.json().versions[version].dist.tarball;
    assert.equal(
      rewritten,
      `${PUBLIC_BASE_URL}/api/v4/groups/${GROUP_ENC}/${packageName}/-/${packageName}-${version}.tgz`,
      "the group must stay one segment, or the next request reads part of it as the package name"
    );
  }
);
