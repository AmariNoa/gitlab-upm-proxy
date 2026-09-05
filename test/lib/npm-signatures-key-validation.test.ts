// Verifies that a misconfigured NPM_SIGNATURE_PRIVATE_KEY_PEM (a key that is not EC
// P-256/prime256v1 - here an RSA key) fails fast with a clear configuration error,
// instead of being silently published as if it were an ecdsa-sha2-nistp256 key.
//
// This lives in its own file (rather than test/lib/npm-signatures.test.ts) because the
// module under test caches the parsed private key in a module-level variable on first
// use, and node's test runner executes each file listed on the command line in its own
// process - so this file can safely set its own (invalid) NPM_SIGNATURE_PRIVATE_KEY_PEM
// before importing src/lib/npm-signatures without disturbing the valid-key fixture the
// other test file relies on.
import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { after, describe, it } from "node:test";

const tarballCacheDir = mkdtempSync(join(tmpdir(), "gitlab-upm-proxy-key-validation-test-"));
process.env.TARBALL_CACHE_DIR = tarballCacheDir;

const rsaKeyPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});
process.env.NPM_SIGNATURE_PRIVATE_KEY_PEM = rsaKeyPair.privateKey;

import * as mod from "../../src/lib/npm-signatures";

describe("npm-signatures private key curve validation", () => {
  after(() => {
    rmSync(tarballCacheDir, { recursive: true, force: true });
  });

  it("rejects a non-P-256 NPM_SIGNATURE_PRIVATE_KEY_PEM (RSA key) with a configuration error instead of publishing it", () => {
    assert.throws(
      () => mod.getProxySigningKey(),
      (err: unknown) => {
        assert.ok(err instanceof Error, "expected an Error to be thrown");
        assert.match(err.message, /P-256|prime256v1/, "error should explain the expected key type");
        assert.match(err.message, /NPM_SIGNATURE_PRIVATE_KEY_PEM/, "error should name the offending source");
        assert.doesNotMatch(err.message, /-----BEGIN/, "error must not leak the key material");
        return true;
      }
    );
  });
});
