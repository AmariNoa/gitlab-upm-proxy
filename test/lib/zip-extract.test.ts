// Regression tests for what the zip extraction reproduces.
//
// The extraction was rewritten to enforce size and entry limits, and in doing so it changed from
// unzipper's own Extract stream to an explicit walk of the central directory. Two differences
// came with that and are pinned here: directory entries were dropped, so an empty folder in the
// archive vanished from the converted tarball while its sibling .meta file survived; and the
// containment check rejected any relative path merely starting with two dots, which fails a
// package holding an ordinary file named "..notes".
//
// The containment check itself has to keep working, so the traversal case is asserted alongside.
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import assert from "node:assert/strict";

import { unzipToDirectory } from "../../src/lib/tgz";
import { buildStoredZip } from "./zip-fixture";

const workDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-zip-extract-test-"));

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let caseId = 0;

async function extract(entries: Array<{ name: string; data: Buffer }>): Promise<string> {
  const id = `case-${caseId++}`;
  const zipPath = join(workDir, `${id}.zip`);
  const outDir = join(workDir, id);
  await writeFile(zipPath, buildStoredZip(entries));
  await unzipToDirectory(zipPath, outDir);
  return outDir;
}

test(
  "zip内の空ディレクトリは展開先にも作られる",
  async () => {
    const outDir = await extract([
      { name: "package.json", data: Buffer.from(JSON.stringify({ name: "com.example.dirs" })) },
      { name: "EmptyFolder/", data: Buffer.alloc(0) },
      { name: "EmptyFolder.meta", data: Buffer.from("guid: 0") }
    ]);

    const names = (await readdir(outDir, { withFileTypes: true })).map(
      (entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`
    );
    assert.ok(
      names.includes("EmptyFolder/"),
      `the empty directory must survive extraction, got ${JSON.stringify(names)}`
    );
    assert.ok(names.includes("EmptyFolder.meta"), "its sibling .meta file must survive too");
  }
);

test(
  "二つのドットで始まるだけの名前は拒否されない",
  async () => {
    const outDir = await extract([
      { name: "package.json", data: Buffer.from(JSON.stringify({ name: "com.example.dots" })) },
      { name: "..notes", data: Buffer.from("not a traversal") },
      { name: "..assets/file.txt", data: Buffer.from("also not a traversal") }
    ]);

    const names = (await readdir(outDir)).sort();
    assert.deepEqual(names, ["..assets", "..notes", "package.json"]);
  }
);

test(
  "展開先の外へ出るエントリは拒否される",
  async () => {
    await assert.rejects(
      () =>
        extract([
          { name: "package.json", data: Buffer.from("{}") },
          { name: "../escaped.txt", data: Buffer.from("nope") }
        ]),
      /zip_entry_outside_target/,
      "a path climbing out of the target must still be refused"
    );

    await assert.rejects(
      () =>
        extract([
          { name: "package.json", data: Buffer.from("{}") },
          { name: "nested/../../escaped.txt", data: Buffer.from("nope") }
        ]),
      /zip_entry_outside_target/,
      "a path climbing out through a nested segment must still be refused"
    );
  }
);
