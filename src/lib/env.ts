// Reads a required environment variable, failing fast when it is missing so a
// misconfigured deployment stops at startup instead of silently using a different path.
export function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
