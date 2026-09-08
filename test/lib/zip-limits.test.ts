// Regression tests for the limits placed on an upstream archive.
//
// A VPM package's zip is published by whoever owns that package, not by this proxy, and it used
// to be handed straight to unzipper with no bound on entry count or expanded size and buffered in
// memory with no bound on downloaded bytes. A small, highly compressible archive could therefore
// fill the cache filesystem during a download or a startup prefetch, and a large body could
// exhaust the process before a single byte was written.
//
// The limits are read from the environment on every call (with defaults), so each case below sets
// its own ceiling rather than building a fixture large enough to hit a production default.
import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from "undici";

import { convertZipBufferToTgz, runTempLocked, validateExtractLimits } from "../../src/lib/tgz";
import { fetchBufferWithRedirects, validateDownloadLimits } from "../../src/lib/http";
import { buildStoredZip } from "./zip-fixture";

const workDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-zip-limits-test-"));
const ORIGIN = "https://vpm.example.com";

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;

before(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
});

after(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
  rmSync(workDir, { recursive: true, force: true });
  delete process.env.VPM_MAX_EXTRACT_BYTES;
  delete process.env.VPM_MAX_EXTRACT_ENTRIES;
  delete process.env.VPM_MAX_DOWNLOAD_BYTES;
});

function packageZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  return buildStoredZip([
    {
      name: "package.json",
      data: Buffer.from(JSON.stringify({ name: "com.example.limits", version: "1.0.0" }))
    },
    ...entries
  ]);
}

test(
  "展開後の合計サイズが上限を超えるzipは変換されず、tgzも残らない",
  async () => {
    process.env.VPM_MAX_EXTRACT_BYTES = "512";
    delete process.env.VPM_MAX_EXTRACT_ENTRIES;

    const zip = packageZip([{ name: "big.bin", data: Buffer.alloc(4096, 0x41) }]);
    const target = join(workDir, "over-bytes", "com.example.limits-1.0.0.tgz");

    await assert.rejects(
      () => convertZipBufferToTgz(zip, target, runTempLocked),
      /zip_expanded_too_large/,
      "an archive that expands past the ceiling must be refused"
    );

    const leftovers = await readdir(join(workDir, "over-bytes")).catch(() => [] as string[]);
    assert.deepEqual(
      leftovers.filter((name) => name.endsWith(".tgz")),
      [],
      "no archive may be published from a refused conversion"
    );
  }
);

test(
  "エントリ数が上限を超えるzipは変換されない",
  async () => {
    delete process.env.VPM_MAX_EXTRACT_BYTES;
    process.env.VPM_MAX_EXTRACT_ENTRIES = "2";

    const zip = packageZip([
      { name: "a.txt", data: Buffer.from("a") },
      { name: "b.txt", data: Buffer.from("b") },
      { name: "c.txt", data: Buffer.from("c") }
    ]);
    const target = join(workDir, "over-entries", "com.example.limits-1.0.0.tgz");

    await assert.rejects(
      () => convertZipBufferToTgz(zip, target, runTempLocked),
      /zip_too_many_entries/,
      "an archive with more entries than the ceiling must be refused"
    );
  }
);

test(
  "上限内のzipは従来どおり変換される",
  async () => {
    process.env.VPM_MAX_EXTRACT_BYTES = "65536";
    process.env.VPM_MAX_EXTRACT_ENTRIES = "16";

    const zip = packageZip([{ name: "Runtime/Thing.cs", data: Buffer.from("// thing") }]);
    const target = join(workDir, "within", "com.example.limits-1.0.0.tgz");

    const tgz = await convertZipBufferToTgz(zip, target, runTempLocked);
    assert.ok(tgz.length > 0, "a package inside the limits must still convert");
  }
);

test(
  "本文が上限を超えるダウンロードは、Content-Lengthが無くても打ち切られる",
  async () => {
    process.env.VPM_MAX_DOWNLOAD_BYTES = "1024";

    mockAgent
      .get(ORIGIN)
      .intercept({ path: "/dl/huge.zip", method: "GET" })
      // Chunked: no content-length, so only the running total can catch this.
      .reply(200, Buffer.alloc(8192, 0x42), { headers: { "transfer-encoding": "chunked" } });

    await assert.rejects(
      () => fetchBufferWithRedirects(`${ORIGIN}/dl/huge.zip`),
      /zip_download_too_large/,
      "a body over the ceiling must not be buffered to completion"
    );
  }
);

test(
  "Content-Lengthが上限を超えるダウンロードは本文を読まずに拒否される",
  async () => {
    process.env.VPM_MAX_DOWNLOAD_BYTES = "1024";

    mockAgent
      .get(ORIGIN)
      .intercept({ path: "/dl/declared.zip", method: "GET" })
      .reply(200, Buffer.alloc(4096, 0x43), { headers: { "content-length": "4096" } });

    await assert.rejects(
      () => fetchBufferWithRedirects(`${ORIGIN}/dl/declared.zip`),
      /zip_download_too_large:4096/,
      "a declared size over the ceiling must be refused up front"
    );
  }
);

test(
  "上限内のダウンロードは従来どおり本文を返す",
  async () => {
    process.env.VPM_MAX_DOWNLOAD_BYTES = "8192";

    mockAgent
      .get(ORIGIN)
      .intercept({ path: "/dl/small.zip", method: "GET" })
      .reply(200, Buffer.alloc(256, 0x44));

    const body = await fetchBufferWithRedirects(`${ORIGIN}/dl/small.zip`);
    assert.equal(body.length, 256);
  }
);

// Regression for the fifth round of the second review cycle: README promised that a malformed
// limit stops the proxy at startup, but the limits were only read when an archive was actually
// downloaded or expanded. A typo therefore surfaced hours later as a failed download, and a
// successful start said nothing about whether the setting had been understood.
test(
  "壊れた上限値は起動時の検証で検出される",
  () => {
    process.env.VPM_MAX_DOWNLOAD_BYTES = "not-a-number";
    assert.throws(() => validateDownloadLimits(), /VPM_MAX_DOWNLOAD_BYTES/);
    process.env.VPM_MAX_DOWNLOAD_BYTES = "0";
    assert.throws(() => validateDownloadLimits(), /VPM_MAX_DOWNLOAD_BYTES/);
    delete process.env.VPM_MAX_DOWNLOAD_BYTES;
    assert.doesNotThrow(() => validateDownloadLimits(), "an unset limit falls back to its default");

    process.env.VPM_MAX_EXTRACT_ENTRIES = "-1";
    assert.throws(() => validateExtractLimits(), /VPM_MAX_EXTRACT_ENTRIES/);
    delete process.env.VPM_MAX_EXTRACT_ENTRIES;
    process.env.VPM_MAX_EXTRACT_BYTES = "1.5";
    assert.throws(() => validateExtractLimits(), /VPM_MAX_EXTRACT_BYTES/);
    delete process.env.VPM_MAX_EXTRACT_BYTES;
    assert.doesNotThrow(() => validateExtractLimits(), "unset limits fall back to their defaults");
  }
);
