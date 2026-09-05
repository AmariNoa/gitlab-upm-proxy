import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign
} from "node:crypto";
import { request } from "undici";
import { mustEnv } from "./env";
import { UpstreamEntry } from "./upstreams";

type NpmSigningKey = {
  expires: null;
  keyid: string;
  keytype: "ecdsa-sha2-nistp256";
  scheme: "ecdsa-sha2-nistp256";
  key: string;
};

type NpmKeysResponse = {
  keys: NpmSigningKey[];
};

const KEY_PATH =
  process.env.NPM_SIGNATURE_KEY_PATH ?? join(mustEnv("TARBALL_CACHE_DIR"), "npm-signing-key.pem");

let cachedPrivateKeyPem: string | null = null;
let cachedPublicKey: NpmSigningKey | null = null;

// Guards against a misconfigured signing key (e.g. an RSA key dropped into
// NPM_SIGNATURE_PRIVATE_KEY_PEM or NPM_SIGNATURE_KEY_PATH): this module always publishes
// its public key as an ecdsa-sha2-nistp256 npm signing key, so the private key backing it
// must actually be an EC P-256 (prime256v1) key or every published signature would be
// silently inconsistent with the advertised key type. Only checked on the read paths
// below; a freshly generated key always satisfies this by construction.
function assertPrivateKeyIsP256(pem: string, source: string): void {
  let keyObject;
  try {
    keyObject = createPrivateKey(pem);
  } catch {
    throw new Error(`Invalid NPM signing private key from ${source}: not a valid PEM private key`);
  }
  const isEc = keyObject.asymmetricKeyType === "ec";
  const curve = keyObject.asymmetricKeyDetails?.namedCurve;
  if (!isEc || curve !== "prime256v1") {
    throw new Error(
      `Invalid NPM signing private key from ${source}: expected an EC P-256 (prime256v1) key`
    );
  }
}

function readOrCreatePrivateKeyPem(): string {
  if (cachedPrivateKeyPem) return cachedPrivateKeyPem;

  const envKey = process.env.NPM_SIGNATURE_PRIVATE_KEY_PEM;
  if (envKey) {
    const pem = envKey.replace(/\\n/g, "\n");
    assertPrivateKeyIsP256(pem, "NPM_SIGNATURE_PRIVATE_KEY_PEM");
    cachedPrivateKeyPem = pem;
    return cachedPrivateKeyPem;
  }

  if (existsSync(KEY_PATH)) {
    const pem = readFileSync(KEY_PATH, "utf-8");
    assertPrivateKeyIsP256(pem, KEY_PATH);
    cachedPrivateKeyPem = pem;
    return cachedPrivateKeyPem;
  }

  const pair = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, pair.privateKey, { encoding: "utf-8", mode: 0o600 });
  cachedPrivateKeyPem = pair.privateKey;
  return cachedPrivateKeyPem;
}

function base64NoPadding(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=+$/, "");
}

export function getProxySigningKey(): NpmSigningKey {
  if (cachedPublicKey) return cachedPublicKey;

  const privateKey = createPrivateKey(readOrCreatePrivateKeyPem());
  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const keyid = `SHA256:${base64NoPadding(createHash("sha256").update(publicDer).digest())}`;

  cachedPublicKey = {
    expires: null,
    keyid,
    keytype: "ecdsa-sha2-nistp256",
    scheme: "ecdsa-sha2-nistp256",
    key: publicDer.toString("base64")
  };
  return cachedPublicKey;
}

export function applyPackageSignature(
  packageName: string,
  version: string,
  tarballBuffer: Buffer,
  dist: Record<string, any>
): void {
  const integrity = `sha512-${createHash("sha512").update(tarballBuffer).digest("base64")}`;
  const key = getProxySigningKey();
  const privateKey = createPrivateKey(readOrCreatePrivateKeyPem());
  const payload = `${packageName}@${version}:${integrity}`;
  const sig = cryptoSign("sha256", Buffer.from(payload), privateKey).toString("base64");

  dist.integrity = integrity;
  dist.signatures = [{ keyid: key.keyid, sig }];
}

/**
 * True when a signature entry in a package's dist.signatures was produced by this
 * process's currently active proxy signing key (i.e. the version does not need to be
 * re-signed). Only checks the keyid marker, not the signature bytes themselves - callers
 * that already trust the cached dist blob use this purely to decide whether the
 * (expensive) hash-and-sign step can be skipped.
 */
export function hasProxySignature(dist: any): boolean {
  if (!dist || typeof dist.integrity !== "string" || !Array.isArray(dist.signatures)) return false;
  const keyid = getProxySigningKey().keyid;
  return dist.signatures.some(
    (entry: any) => entry && entry.keyid === keyid && typeof entry.sig === "string"
  );
}

export async function fetchUpstreamSigningKeys(
  upstream: UpstreamEntry,
  headers: Record<string, string>
): Promise<NpmSigningKey[]> {
  const res = await request(`${upstream.baseUrl}/-/npm/v1/keys`, {
    method: "GET",
    headers
  });
  if (res.statusCode >= 400) {
    await res.body.dump();
    return [];
  }
  const contentType = String(res.headers["content-type"] ?? "");
  if (contentType && !contentType.includes("application/json")) {
    await res.body.dump();
    return [];
  }
  const body = (await res.body.json()) as Partial<NpmKeysResponse>;
  return Array.isArray(body.keys) ? body.keys.filter(isNpmSigningKey) : [];
}

/**
 * Verifies that an upstream-advertised signing key is internally consistent: its keyid
 * must be the SHA256 fingerprint of its own public key material, and that public key must
 * be an EC P-256 (prime256v1) key (the only kind this proxy ever publishes or expects).
 * A key that fails this cannot be trusted to actually correspond to the keyid it claims -
 * whether because it is malformed, uses a different curve/algorithm, or (most importantly)
 * an upstream is trying to claim someone else's keyid without holding the matching key.
 */
export function isAuthenticUpstreamSigningKey(key: NpmSigningKey): boolean {
  let der: Buffer;
  try {
    der = Buffer.from(key.key, "base64");
  } catch {
    return false;
  }
  let publicKey;
  try {
    publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    return false;
  }
  if (publicKey.asymmetricKeyType !== "ec") return false;
  if (publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false;
  const expectedKeyid = `SHA256:${base64NoPadding(createHash("sha256").update(der).digest())}`;
  return expectedKeyid === key.keyid;
}

function isNpmSigningKey(value: unknown): value is NpmSigningKey {
  if (!value || typeof value !== "object") return false;
  const key = value as Partial<NpmSigningKey>;
  return (
    key.expires === null &&
    typeof key.keyid === "string" &&
    key.keytype === "ecdsa-sha2-nistp256" &&
    key.scheme === "ecdsa-sha2-nistp256" &&
    typeof key.key === "string"
  );
}

export function mergeSigningKeys(keys: NpmSigningKey[]): NpmKeysResponse {
  const byId = new Map<string, NpmSigningKey>();
  for (const key of keys) {
    byId.set(key.keyid, key);
  }
  return { keys: Array.from(byId.values()) };
}
