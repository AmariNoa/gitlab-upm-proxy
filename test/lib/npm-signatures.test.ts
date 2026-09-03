import * as assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
// Must stay above the npm-signatures import: it sets NPM_SIGNATURE_PRIVATE_KEY_PEM.
import { testKeyPair } from "./signing-key-env";
import * as mod from "../../src/lib/npm-signatures";
import type { UpstreamEntry } from "../../src/lib/upstreams";

const expectedPublicDer = createPublicKey(testKeyPair.publicKey).export({ type: "spki", format: "der" }) as Buffer;
const expectedKeyId = `SHA256:${createHash("sha256").update(expectedPublicDer).digest("base64").replace(/=+$/, "")}`;

describe("npm-signatures", () => {
  describe("getProxySigningKey", () => {
    it("derives the npm keys entry from the configured private key", () => {
      const key = mod.getProxySigningKey();
      assert.equal(key.keyid, expectedKeyId);
      assert.equal(key.keytype, "ecdsa-sha2-nistp256");
      assert.equal(key.scheme, "ecdsa-sha2-nistp256");
      assert.equal(key.expires, null);
      assert.equal(key.key, expectedPublicDer.toString("base64"));
    });

    it("returns the same key object on repeated calls", () => {
      assert.strictEqual(mod.getProxySigningKey(), mod.getProxySigningKey());
    });
  });

  describe("applyPackageSignature", () => {
    it("sets sha512 integrity and a signature verifiable with the published key", () => {
      const tarball = Buffer.from("dummy tarball bytes");
      const dist: Record<string, any> = { shasum: "unchanged" };

      mod.applyPackageSignature("com.example.pkg", "1.2.3", tarball, dist);

      const expectedIntegrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
      assert.equal(dist.integrity, expectedIntegrity);
      assert.equal(dist.shasum, "unchanged");
      assert.equal(dist.signatures.length, 1);
      assert.equal(dist.signatures[0].keyid, expectedKeyId);

      const payload = Buffer.from(`com.example.pkg@1.2.3:${expectedIntegrity}`);
      const publicKey = createPublicKey({ key: expectedPublicDer, format: "der", type: "spki" });
      const ok = cryptoVerify("sha256", payload, publicKey, Buffer.from(dist.signatures[0].sig, "base64"));
      assert.equal(ok, true);
    });

    it("produces a signature that does not verify for a different version", () => {
      const tarball = Buffer.from("dummy tarball bytes");
      const dist: Record<string, any> = {};
      mod.applyPackageSignature("com.example.pkg", "1.2.3", tarball, dist);

      const wrongPayload = Buffer.from(`com.example.pkg@9.9.9:${dist.integrity}`);
      const publicKey = createPublicKey({ key: expectedPublicDer, format: "der", type: "spki" });
      const ok = cryptoVerify("sha256", wrongPayload, publicKey, Buffer.from(dist.signatures[0].sig, "base64"));
      assert.equal(ok, false);
    });
  });

  describe("mergeSigningKeys", () => {
    it("deduplicates by keyid keeping the last occurrence", () => {
      const a = { expires: null, keyid: "SHA256:a", keytype: "ecdsa-sha2-nistp256", scheme: "ecdsa-sha2-nistp256", key: "AAA" } as const;
      const aNewer = { ...a, key: "AAA2" };
      const b = { ...a, keyid: "SHA256:b", key: "BBB" };

      const merged = mod.mergeSigningKeys([a, b, aNewer]);

      assert.deepEqual(
        merged.keys.map((k) => [k.keyid, k.key]),
        [
          ["SHA256:a", "AAA2"],
          ["SHA256:b", "BBB"]
        ]
      );
    });
  });

  describe("fetchUpstreamSigningKeys", () => {
    const upstream: UpstreamEntry = {
      baseUrl: "https://registry.example.com",
      host: "registry.example.com",
      type: "npm"
    };
    const originalDispatcher = getGlobalDispatcher();
    let mockAgent: MockAgent;

    before(() => {
      mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      setGlobalDispatcher(mockAgent);
    });

    after(async () => {
      setGlobalDispatcher(originalDispatcher);
      await mockAgent.close();
    });

    it("returns only well-formed keys from a JSON response", async () => {
      const valid = { expires: null, keyid: "SHA256:up", keytype: "ecdsa-sha2-nistp256", scheme: "ecdsa-sha2-nistp256", key: "UP" };
      mockAgent
        .get("https://registry.example.com")
        .intercept({ path: "/-/npm/v1/keys", method: "GET" })
        .reply(200, { keys: [valid, { keyid: "broken" }, "not-an-object"] }, {
          headers: { "content-type": "application/json" }
        });

      const keys = await mod.fetchUpstreamSigningKeys(upstream, {});
      assert.deepEqual(keys, [valid]);
    });

    it("returns an empty list on HTTP errors", async () => {
      mockAgent
        .get("https://registry.example.com")
        .intercept({ path: "/-/npm/v1/keys", method: "GET" })
        .reply(404, "not found", { headers: { "content-type": "text/plain" } });

      const keys = await mod.fetchUpstreamSigningKeys(upstream, {});
      assert.deepEqual(keys, []);
    });

    it("returns an empty list when the response is not JSON", async () => {
      mockAgent
        .get("https://registry.example.com")
        .intercept({ path: "/-/npm/v1/keys", method: "GET" })
        .reply(200, "<html></html>", { headers: { "content-type": "text/html" } });

      const keys = await mod.fetchUpstreamSigningKeys(upstream, {});
      assert.deepEqual(keys, []);
    });
  });
});
