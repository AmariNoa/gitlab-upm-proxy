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
