// Route tests fixing the current behaviour of the zip -> tgz conversion path used to
// serve VPM-origin tarballs, so that a later extraction of the conversion logic into a
// shared module has a safety net. These tests describe the CURRENT behaviour, not the
// desired one.
//
// Module-load env vars: TARBALL_CACHE_DIR / UPSTREAM_CONFIG_PATH / PUBLIC_BASE_URL are
// read exactly once at module load time by src/lib/cache.ts, src/lib/upstreams.ts and
// src/routes/gitlab-npm-proxy.ts, and VPM_PREFETCH_INTERVAL_SEC once per prefetch run by
// src/lib/vpm-prefetch.ts. They are therefore assigned below BEFORE any src/ module is
// imported (see test/routes/vpm-signatures.test.ts for the same constraint).
//
// Race with the background VPM prefetch: src/app.ts calls startVpmPrefetch(fastify.log)
// on every app build, and that unawaited background task scans the configured VPM
// upstream's index (with no custom headers) and could otherwise touch the same package
// caches this file seeds by hand. As in test/routes/vpm-signatures.test.ts, the mocked
// VPM index always answers with an empty package list, so the background task never
// reads or rewrites anything under test here (the tarball-serving route path exercised
// below never itself fetches the VPM index — it reads dist.original straight out of the
// metadata cache seeded per test).
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import * as tar from "tar";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-vpm-convert-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.vpm.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.vpm-convert.example.net";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import { build, TestContext } from "../helper";
import { buildStoredZip } from "../lib/zip-fixture";
import { getTarballCachePath, readMetadataCache, writeMetadataCache, type MetadataCache } from "../../src/lib/cache";
import { getProxySigningKey } from "../../src/lib/npm-signatures";

const DEFAULT_ORIGIN = "https://gitlab.example.com";
const VPM_ORIGIN = "https://vpm.example.com";
const VPM_HOST = "vpm.example.com";

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);

  // The background prefetch fetches the VPM index with no custom headers; answering it
  // with an empty package list keeps it from touching the caches seeded in this file.
  mockAgent
    .get(VPM_ORIGIN)
    .intercept({ path: "/index.json", method: "GET" })
    .reply(200, { packages: {} }, { headers: { "content-type": "application/json" } })
    .persist();

  // Valid PAT for every /api/v4/user check performed by the onRequest hook.
  mockAgent
    .get(DEFAULT_ORIGIN)
    .intercept({ path: "/api/v4/user", method: "GET" })
    .reply(200, { id: 1, username: "tester" })
    .persist();
});

const tempExtractDirs: string[] = [];

after(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
  rmSync(tarballCacheDir, { recursive: true, force: true });
  for (const dir of tempExtractDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------------

/** Recursively lists every regular file under `dir`, as posix-style relative paths, sorted. */
async function listFilesRecursive(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(join(dir, entry.name), rel)));
    } else {
      out.push(rel);
    }
  }
  return out.sort();
}

/** Extracts a gzip tar buffer into a fresh temp directory and returns its path. */
async function extractTgzToTempDir(tgzBuffer: Buffer): Promise<string> {
  const workDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-vpm-convert-extract-"));
  tempExtractDirs.push(workDir);
  const tgzPath = join(workDir, "download.tgz");
  await writeFile(tgzPath, tgzBuffer);
  const outDir = join(workDir, "out");
  await mkdir(outDir, { recursive: true });
  await tar.x({ file: tgzPath, cwd: outDir });
  return outDir;
}

function mockZipDownload(path: string, zipBuffer: Buffer): void {
  mockAgent
    .get(VPM_ORIGIN)
    .intercept({ path, method: "GET" })
    .reply(200, zipBuffer, { headers: { "content-type": "application/zip" } });
}

async function seedVpmTarballMetadata(
  packageName: string,
  version: string,
  originalZipUrl: string,
  vpmAuthor?: string
): Promise<void> {
  const cache: MetadataCache = {
    latestVersion: version,
    metadata: {
      name: packageName,
      "dist-tags": { latest: version },
      ...(vpmAuthor ? { _vpmAuthor: vpmAuthor } : {}),
      versions: {
        [version]: {
          name: packageName,
          version,
          dist: {
            tarball: "",
            original: originalZipUrl
          }
        }
      }
    }
  };
  await writeMetadataCache(VPM_HOST, packageName, cache);
}

const proxyKeyid = getProxySigningKey().keyid;

// ---------------------------------------------------------------------------------
// (a) zip の直下に package.json がある場合
// ---------------------------------------------------------------------------------
test(
  "zip直下にpackage.jsonがある場合、package/配下へtar化されキャッシュと署名が書き戻される",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.conv.flat";
    const version = "1.0.0";
    const cacheKey = `${packageName}-${version}.tgz`;
    const zipPath = `/dl/${packageName}-${version}.zip`;
    const zipUrl = `${VPM_ORIGIN}${zipPath}`;

    const originalPackageJson = Buffer.from(
      JSON.stringify(
        { name: packageName, version, displayName: "Flat Package", author: { name: "Zip Author" } },
        null,
        2
      ),
      "utf-8"
    );
    const readmeContent = Buffer.from("hello from flat package\n", "utf-8");
    const zipBuffer = buildStoredZip([
      { name: "package.json", data: originalPackageJson },
      { name: "README.md", data: readmeContent }
    ]);

    mockZipDownload(zipPath, zipBuffer);
    await seedVpmTarballMetadata(packageName, version, zipUrl);

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/-/${encodeURIComponent(`${packageName}-${version}.tgz`)}`,
      headers: { "private-token": "valid-token" }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/octet-stream");
    const bodyBuffer = res.rawPayload;
    assert.ok(bodyBuffer.length > 2 && bodyBuffer[0] === 0x1f && bodyBuffer[1] === 0x8b, "response body must be gzip-compressed");

    const outDir = await extractTgzToTempDir(bodyBuffer);
    const files = await listFilesRecursive(outDir);
    assert.deepEqual(files, ["package/README.md", "package/package.json"]);

    const extractedPackageJson = await readFile(join(outDir, "package", "package.json"));
    assert.deepEqual(extractedPackageJson, originalPackageJson, "package.json content must be unchanged when an author is already present");
    const extractedReadme = await readFile(join(outDir, "package", "README.md"));
    assert.deepEqual(extractedReadme, readmeContent);

    // The tgz must be written to the on-disk tarball cache.
    const cachedTgzPath = getTarballCachePath(VPM_HOST, packageName, cacheKey);
    const cachedTgz = await readFile(cachedTgzPath);
    assert.deepEqual(cachedTgz, bodyBuffer, "the cached tgz must be byte-identical to the served response");

    // shasum + signature must be written back into the metadata cache.
    const diskMetadata = await readMetadataCache(VPM_HOST, packageName);
    assert.ok(diskMetadata, "expected a metadata cache entry");
    const dist = diskMetadata!.metadata.versions[version].dist;
    assert.equal(typeof dist.shasum, "string");
    assert.equal(dist.shasum.length, 40, "shasum must be a sha1 hex digest");
    assert.equal(typeof dist.integrity, "string");
    assert.ok(dist.integrity.startsWith("sha512-"));
    assert.equal(dist.signatures.length, 1);
    assert.equal(dist.signatures[0].keyid, proxyKeyid);
  }
);

// ---------------------------------------------------------------------------------
// (b) zip の中身が単一のサブディレクトリに入っている場合
// ---------------------------------------------------------------------------------
test(
  "zipの中身が単一サブディレクトリの場合、そのサブディレクトリがrootとして扱われサブディレクトリ名は現れない",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.conv.nested";
    const version = "2.0.0";
    const zipPath = `/dl/${packageName}-${version}.zip`;
    const zipUrl = `${VPM_ORIGIN}${zipPath}`;

    const packageJsonContent = Buffer.from(
      JSON.stringify({ name: packageName, version, author: { name: "Nested Author" } }, null, 2),
      "utf-8"
    );
    const runtimeContent = Buffer.from("public class X {}\n", "utf-8");
    const zipBuffer = buildStoredZip([
      { name: "root/package.json", data: packageJsonContent },
      { name: "root/Runtime/x.cs", data: runtimeContent }
    ]);

    mockZipDownload(zipPath, zipBuffer);
    await seedVpmTarballMetadata(packageName, version, zipUrl);

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/-/${encodeURIComponent(`${packageName}-${version}.tgz`)}`,
      headers: { "private-token": "valid-token" }
    });

    assert.equal(res.statusCode, 200);
    const outDir = await extractTgzToTempDir(res.rawPayload);
    const files = await listFilesRecursive(outDir);
    assert.deepEqual(files, ["package/Runtime/x.cs", "package/package.json"]);

    // The subdirectory name ("root") must not appear anywhere in the extracted tree.
    const topLevel = await readdir(outDir);
    assert.deepEqual(topLevel, ["package"]);

    const extractedPackageJson = await readFile(join(outDir, "package", "package.json"));
    assert.deepEqual(extractedPackageJson, packageJsonContent);
    const extractedRuntime = await readFile(join(outDir, "package", "Runtime", "x.cs"));
    assert.deepEqual(extractedRuntime, runtimeContent);
  }
);

// ---------------------------------------------------------------------------------
// (c) zip の package.json に author が無く、VPM index の author がキャッシュ側にある場合
// ---------------------------------------------------------------------------------
test(
  "zip側のpackage.jsonにauthorが無い場合、metadataキャッシュの_vpmAuthorが注入される",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.conv.author";
    const version = "1.0.0";
    const zipPath = `/dl/${packageName}-${version}.zip`;
    const zipUrl = `${VPM_ORIGIN}${zipPath}`;
    const vpmAuthor = "Case C VPM Author";

    const originalPackageJson = Buffer.from(
      JSON.stringify({ name: packageName, version }, null, 2),
      "utf-8"
    );
    const zipBuffer = buildStoredZip([{ name: "package.json", data: originalPackageJson }]);

    mockZipDownload(zipPath, zipBuffer);
    await seedVpmTarballMetadata(packageName, version, zipUrl, vpmAuthor);

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/-/${encodeURIComponent(`${packageName}-${version}.tgz`)}`,
      headers: { "private-token": "valid-token" }
    });

    assert.equal(res.statusCode, 200);
    const outDir = await extractTgzToTempDir(res.rawPayload);
    const extractedPackageJsonRaw = await readFile(join(outDir, "package", "package.json"), "utf-8");
    const extractedPackageJson = JSON.parse(extractedPackageJsonRaw) as Record<string, unknown>;
    assert.deepEqual(extractedPackageJson.author, { name: vpmAuthor });

    // The rest of the original package.json content must be preserved.
    assert.equal(extractedPackageJson.name, packageName);
    assert.equal(extractedPackageJson.version, version);
  }
);

// ---------------------------------------------------------------------------------
// (d) プレリリース版（バージョンにダッシュを含む）
// ---------------------------------------------------------------------------------
// Regression for the second review round: the filename was split at the LAST dash, so
// "com.example.vpm.pre-1.0.0-beta.1.tgz" was read as the package
// "com.example.vpm.pre-1.0.0" at version "beta.1". That package matches no VPM scope, so
// a URL this proxy generated itself answered 404.
test(
  "バージョンにダッシュを含むプレリリース版でも、パッケージ名と版が正しく分割される",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.pre";
    const version = "1.0.0-beta.1";
    const cacheKey = `${packageName}-${version}.tgz`;
    const zipPath = `/dl/${packageName}-${version}.zip`;
    const zipUrl = `${VPM_ORIGIN}${zipPath}`;

    const zipBuffer = buildStoredZip([
      {
        name: "package.json",
        data: Buffer.from(JSON.stringify({ name: packageName, version, author: { name: "Zip Author" } }, null, 2), "utf-8")
      }
    ]);

    mockZipDownload(zipPath, zipBuffer);
    await seedVpmTarballMetadata(packageName, version, zipUrl);

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/-/${encodeURIComponent(cacheKey)}`,
      headers: { "private-token": "valid-token" }
    });

    assert.equal(res.statusCode, 200, "a prerelease tarball URL must resolve");
    const bodyBuffer = res.rawPayload;
    assert.ok(bodyBuffer.length > 2 && bodyBuffer[0] === 0x1f && bodyBuffer[1] === 0x8b, "response body must be gzip-compressed");

    // It must have been filed under the prerelease version, not under a truncated name.
    const cachedTgz = await readFile(getTarballCachePath(VPM_HOST, packageName, cacheKey));
    assert.deepEqual(cachedTgz, bodyBuffer);

    const diskMetadata = await readMetadataCache(VPM_HOST, packageName);
    const dist = diskMetadata?.metadata.versions[version].dist;
    assert.ok(dist, "the prerelease version's dist must be the one updated");
    assert.equal(dist.signatures[0].keyid, proxyKeyid);
  }
);
