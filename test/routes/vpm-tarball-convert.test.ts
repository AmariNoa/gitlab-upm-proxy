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
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as tar from "tar";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-vpm-convert-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;
process.env.UPSTREAM_CONFIG_PATH = "test/fixtures/upstreams.vpm.test.yml";
process.env.PUBLIC_BASE_URL = "https://proxy.vpm-convert.example.net";
process.env.VPM_PREFETCH_INTERVAL_SEC = "0";

import { build, TestContext } from "../helper";
import { buildStoredZip } from "../lib/zip-fixture";
import {
  getTarballCachePath,
  readMetadataCache,
  writeMetadataCache,
  writeTarballCache,
  type MetadataCache
} from "../../src/lib/cache";
import { runTempLocked } from "../../src/lib/tgz";
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
// (h) キャッシュヒット時の読み取りもロックの下で行う
// ---------------------------------------------------------------------------------
// Regression for the sixth review round: a conversion publishes the rebuilt archive by
// rename and writes the metadata describing it a moment later, both inside the package's
// lock. Serving the cached archive without taking that lock let a request land in between
// and receive the new bytes with the previous signature. What is pinned here is the
// mechanism: while the lock is held, the tarball route cannot answer from cache.
test(
  "キャッシュ済みtarballの配信は、パッケージのロックを取ってから行われる",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.lockedread";
    const version = "1.0.0";
    const cacheKey = `${packageName}-${version}.tgz`;
    const zipUrl = `${VPM_ORIGIN}/dl/${packageName}-${version}.zip`;

    // Already cached, so the request takes the cache-hit path and never converts anything.
    const cachedBytes = Buffer.from("already-cached-archive-bytes");
    await writeTarballCache(VPM_HOST, packageName, cacheKey, cachedBytes);
    await seedVpmTarballMetadata(packageName, version, zipUrl);

    const packageDir = dirname(getTarballCachePath(VPM_HOST, packageName, cacheKey));
    let releaseLock = () => {};
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = () => resolve();
    });
    const holder = runTempLocked(packageDir, () => lockHeld);

    const app = await build(t);
    const pending = app.inject({
      method: "GET",
      url: `/-/${encodeURIComponent(cacheKey)}`,
      headers: { "private-token": "valid-token" }
    });

    // Reading a local file is fast, so if the route were not waiting for the lock it would
    // have answered well inside this window.
    const stillBlocked = Symbol("still blocked");
    const raced = await Promise.race([
      pending.then(() => "answered" as const),
      new Promise<typeof stillBlocked>((resolve) => setTimeout(() => resolve(stillBlocked), 300))
    ]);
    assert.equal(raced, stillBlocked, "the cache-hit path must wait for the package's lock");

    releaseLock();
    await holder;
    const res = await pending;

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.rawPayload, cachedBytes);
  }
);

// ---------------------------------------------------------------------------------
// (g) 名前と版のどちらにもダッシュが現れ、分割が曖昧なケース
// ---------------------------------------------------------------------------------
// Regression for the fourth review round: "com.example.vpm.amb-1.0.0-2.3.4.tgz" splits two
// ways that are both valid semver - the package "com.example.vpm.amb" at the prerelease
// version "1.0.0-2.3.4", or the package "com.example.vpm.amb-1.0.0" at version "2.3.4". No
// scan direction settles it; only the metadata the proxy already holds does.
test(
  "分割が曖昧なファイル名は、メタデータキャッシュに実在する組み合わせで解決される",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.amb";
    const version = "1.0.0-2.3.4";
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
    // Only this combination exists, so the other reading of the filename must lose.
    await seedVpmTarballMetadata(packageName, version, zipUrl);

    const app = await build(t);
    const res = await app.inject({
      method: "GET",
      url: `/-/${encodeURIComponent(cacheKey)}`,
      headers: { "private-token": "valid-token" }
    });

    assert.equal(res.statusCode, 200, "the split corroborated by the metadata cache must win");

    const cachedTgz = await readFile(getTarballCachePath(VPM_HOST, packageName, cacheKey));
    assert.deepEqual(cachedTgz, res.rawPayload);

    const diskMetadata = await readMetadataCache(VPM_HOST, packageName);
    const dist = diskMetadata?.metadata.versions[version].dist;
    assert.ok(dist, "the update must land on the prerelease version node");
    assert.equal(dist.signatures[0].keyid, proxyKeyid);
  }
);

// ---------------------------------------------------------------------------------
// (f) 名前自体がバージョンらしい接尾辞で終わるパッケージ
// ---------------------------------------------------------------------------------
// Regression for the third review round: the previous round replaced the last-dash split
// with a search from the EARLIEST dash, which reads
// "com.example.vpm.pkg-1.2.3-4.5.6.tgz" as the package "com.example.vpm.pkg" at version
// "1.2.3-4.5.6" - also valid semver. Searching from the last dash resolves both this and
// the prerelease case below.
test(
  "名前がバージョン風の接尾辞で終わるパッケージでも、末尾側の分割が優先される",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.pkg-1.2.3";
    const version = "4.5.6";
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

    assert.equal(res.statusCode, 200, "the package name's version-like suffix must not be split off");
    const cachedTgz = await readFile(getTarballCachePath(VPM_HOST, packageName, cacheKey));
    assert.deepEqual(cachedTgz, res.rawPayload);

    const diskMetadata = await readMetadataCache(VPM_HOST, packageName);
    assert.ok(diskMetadata?.metadata.versions[version].dist, "the update must land on the real version node");
  }
);

// ---------------------------------------------------------------------------------
// (e) 旧形式エイリアス（/vpm/<package>/<version>）
// ---------------------------------------------------------------------------------
// Regression for the third review round: the bare-version spelling of this legacy URL keyed
// its cache on "<version>.tgz" while metadata advertises "<name>-<version>.tgz". That is a
// second archive for the same version, and serving it wrote its own integrity into the
// version node the canonical archive is published under.
test(
  "旧形式の /vpm/<package>/<version> は正規のキャッシュキーを使い、別アーカイブを作らない",
  async (t: TestContext) => {
    const packageName = "com.example.vpm.alias";
    const version = "1.0.0";
    const canonicalKey = `${packageName}-${version}.tgz`;
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
      url: `/api/v4/groups/my-group/vpm/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
      headers: { "private-token": "valid-token" }
    });

    assert.equal(res.statusCode, 200);
    const bodyBuffer = res.rawPayload;

    // The bytes must be filed under the canonical name, and no "<version>.tgz" alias file
    // may exist beside it.
    const canonicalTgz = await readFile(getTarballCachePath(VPM_HOST, packageName, canonicalKey));
    assert.deepEqual(canonicalTgz, bodyBuffer, "the alias must publish the canonical archive");
    await assert.rejects(
      () => readFile(getTarballCachePath(VPM_HOST, packageName, `${version}.tgz`)),
      "no separate archive may be written for the legacy alias"
    );

    // The signature stored for the version must describe those same canonical bytes.
    const diskMetadata = await readMetadataCache(VPM_HOST, packageName);
    const dist = diskMetadata?.metadata.versions[version].dist;
    assert.ok(dist);
    assert.equal(dist.integrity, `sha512-${createHash("sha512").update(canonicalTgz).digest("base64")}`);
    assert.equal(dist.signatures[0].keyid, proxyKeyid);
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

// ---------------------------------------------------------------------------------
// (g) グローバル経路のファイル名のデコード境界
// ---------------------------------------------------------------------------------
// Regression for the sixth round of the second review cycle. The router already decodes the
// wildcard, and the public tarball URL puts the whole filename into one encoded segment - but the
// handler split that on "/" and decoded it a second time. A scoped package therefore lost its
// scope (resolved as "pkg", answered 404 with the right archive cached), and a filename holding a
// literal "%" made the second decode throw, turning a request into a 500.
test(
  "スコープ付きパッケージのグローバルtarball URLはスコープを保って解決される",
  async (t: TestContext) => {
    const packageName = "@vpmscope/pkg";
    const version = "1.0.0";
    const cacheKey = `${packageName}-${version}.tgz`;
    const zipPath = "/dl/vpmscope-pkg-1.0.0.zip";
    const zipUrl = `${VPM_ORIGIN}${zipPath}`;

    const zipBuffer = buildStoredZip([
      {
        name: "package.json",
        data: Buffer.from(
          JSON.stringify({ name: packageName, version, author: { name: "Zip Author" } }, null, 2),
          "utf-8"
        )
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

    assert.equal(res.statusCode, 200, "the scope must survive the route's filename resolution");
    const cachedTgz = await readFile(getTarballCachePath(VPM_HOST, packageName, cacheKey));
    assert.deepEqual(cachedTgz, res.rawPayload);
  }
);

test(
  "パーセント記号を含むファイル名でも500にならず、通常どおり解決される",
  async (t: TestContext) => {
    // The name ends in a literal "%", so decoding the already-decoded filename again sees "%-1"
    // and throws.
    const packageName = "com.example.vpm.pct%";
    const version = "1.0.0";
    const cacheKey = `${packageName}-${version}.tgz`;
    const zipPath = "/dl/pct-1.0.0.zip";
    const zipUrl = `${VPM_ORIGIN}${zipPath}`;

    const zipBuffer = buildStoredZip([
      {
        name: "package.json",
        data: Buffer.from(
          JSON.stringify({ name: packageName, version, author: { name: "Zip Author" } }, null, 2),
          "utf-8"
        )
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

    assert.equal(res.statusCode, 200, "a literal percent sign must not fail the request");
    const cachedTgz = await readFile(getTarballCachePath(VPM_HOST, packageName, cacheKey));
    assert.deepEqual(cachedTgz, res.rawPayload);
  }
);
