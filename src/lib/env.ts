import { isIP } from "node:net";

// Reads a required environment variable, failing fast when it is missing so a
// misconfigured deployment stops at startup instead of silently using a different path.
export function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

/**
 * Reads an optional positive-integer limit, falling back to its built-in default when unset so
 * an existing deployment keeps working without touching its configuration. A value that is
 * present but not a positive integer is a configuration error and fails rather than being
 * silently replaced by the default, which would leave the operator believing a limit is in
 * force that is not.
 */
export function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid env: ${name} must be a positive integer`);
  }
  return parsed;
}

/** proxy-addr accepts these as shorthand for the usual private ranges. */
const TRUST_PROXY_PRESETS = ["loopback", "linklocal", "uniquelocal"];

function isAddressOrRange(value: string): boolean {
  if (TRUST_PROXY_PRESETS.includes(value)) return true;
  const slash = value.lastIndexOf("/");
  if (slash < 0) return isIP(value) !== 0;
  const address = value.slice(0, slash);
  const prefix = value.slice(slash + 1);
  const family = isIP(address);
  if (family === 0) return false;
  if (!/^[0-9]{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  // proxy-addr refuses a zero-length prefix, so accepting one here would produce a value that
  // passes this check and then throws when Fastify is constructed - a configuration error found
  // at a point where it no longer says which setting caused it. Measured: 0.0.0.0/0 and ::/0 are
  // both rejected with "invalid range on address".
  return bits >= 1 && bits <= (family === 4 ? 32 : 128);
}

/**
 * Reads the optional reverse proxy trust setting for Fastify.
 *
 * Unset means the setting is not applied at all, which leaves Fastify's default in place and
 * therefore leaves `req.ip` as the socket address - the behaviour every existing deployment
 * already has.
 *
 * The value decides who may claim to be the client. `true` trusts every address, which means
 * `req.ip` becomes the leftmost X-Forwarded-For entry - a value the caller writes. That is only
 * safe when the front end overwrites the header and the application port cannot be reached
 * directly, so the documented setting is a list of addresses or ranges instead. A malformed value
 * stops the process rather than quietly trusting more or less than intended, which is how the
 * other limits in this file behave.
 */
export function resolveTrustProxy(raw: string | undefined): boolean | number | string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === "") return undefined;

  const lower = value.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;

  if (/^[0-9]+$/.test(value)) {
    const hops = Number(value);
    if (!Number.isSafeInteger(hops)) {
      throw new Error("Invalid env: TRUST_PROXY hop count is out of range");
    }
    return hops;
  }

  const parts = value.split(",").map((part) => part.trim());
  if (parts.some((part) => part === "")) {
    throw new Error("Invalid env: TRUST_PROXY has an empty entry");
  }
  for (const part of parts) {
    if (!isAddressOrRange(part)) {
      throw new Error(
        "Invalid env: TRUST_PROXY must be true, false, a hop count, or a list of addresses or CIDR ranges"
      );
    }
  }
  return parts.join(",");
}
