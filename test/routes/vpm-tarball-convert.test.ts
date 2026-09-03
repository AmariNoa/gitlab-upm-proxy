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
// Minimal, dependency-free ZIP (stored/uncompressed, method 0) builder: local file
// headers + data, followed by a central directory and an End Of Central Directory
// record. No directory entries are written; unzipper.Extract creates parent
// directories from file paths on its own. CRC-32 is computed with the standard
// bit-by-bit algorithm (fast enough for the tiny fixtures used here).
// ---------------------------------------------------------------------------------
function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

function buildStoredZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0, 6); // general purpose bit flag
    localHeader.writeUInt16LE(0, 8); // compression method: 0 = stored
    localHeader.writeUInt16LE(0, 10); // last mod file time
    localHeader.writeUInt16LE(0, 12); // last mod file date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18); // compressed size
    localHeader.writeUInt32LE(size, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    localParts.push(localHeader, nameBuf, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central file header signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0, 8); // general purpose bit flag
    centralHeader.writeUInt16LE(0, 10); // compression method
    centralHeader.writeUInt16LE(0, 12); // last mod file time
    centralHeader.writeUInt16LE(0, 14); // last mod file date
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20); // compressed size
    centralHeader.writeUInt32LE(size, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirOffset = offset;
  const centralDirSize = centralDirectory.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8); // number of central directory records on this disk
  eocd.writeUInt16LE(entries.length, 10); // total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

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
