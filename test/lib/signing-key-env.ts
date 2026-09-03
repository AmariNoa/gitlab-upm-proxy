// Test-only bootstrap: generates a throwaway ECDSA key and exposes it to src/lib/npm-signatures
// through NPM_SIGNATURE_PRIVATE_KEY_PEM. The signing module reads the env lazily on first use and
// caches the key for the process lifetime, so this module must be imported before it.
import { generateKeyPairSync } from "node:crypto";

export const testKeyPair = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
});

process.env.NPM_SIGNATURE_PRIVATE_KEY_PEM = testKeyPair.privateKey;
