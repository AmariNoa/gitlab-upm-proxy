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

const CACHE_DIR = process.env.TARBALL_CACHE_DIR ?? "./data/cache";
const KEY_PATH = process.env.NPM_SIGNATURE_KEY_PATH ?? join(CACHE_DIR, "npm-signing-key.pem");

let cachedPrivateKeyPem: string | null = null;
let cachedPublicKey: NpmSigningKey | null = null;

function readOrCreatePrivateKeyPem(): string {
  if (cachedPrivateKeyPem) return cachedPrivateKeyPem;

  const envKey = process.env.NPM_SIGNATURE_PRIVATE_KEY_PEM;
  if (envKey) {
    cachedPrivateKeyPem = envKey.replace(/\\n/g, "\n");
    return cachedPrivateKeyPem;
  }

  if (existsSync(KEY_PATH)) {
    cachedPrivateKeyPem = readFileSync(KEY_PATH, "utf-8");
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

export async function fetchUpstreamSigningKeys(
  upstream: UpstreamEntry,
  headers: Record<string, string>
): Promise<NpmSigningKey[]> {
  const res = await request(`${upstream.baseUrl}/-/npm/v1/keys`, {
    method: "GET",
    headers
  });
  if (res.statusCode >= 400) return [];
  const contentType = String(res.headers["content-type"] ?? "");
  if (contentType && !contentType.includes("application/json")) return [];
  const body = (await res.body.json()) as Partial<NpmKeysResponse>;
  return Array.isArray(body.keys) ? body.keys.filter(isNpmSigningKey) : [];
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
