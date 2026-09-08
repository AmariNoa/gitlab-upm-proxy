import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { mustEnv } from "./env";

export type UpstreamEntry = {
  baseUrl: string;
  scopes?: string[];
  host: string;
  type: "npm" | "vpm";
};

type RawEntry = {
  baseUrl?: string;
  scopes?: string[];
  type?: string;
};

type RawConfig = {
  default?: RawEntry[] | RawEntry;
  upstreams?: RawEntry[];
};

export type UpstreamConfig = {
  default: UpstreamEntry;
  upstreams: UpstreamEntry[];
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * The parsed YAML is only asserted to have this shape, never checked, so a scopes value written
 * as a bare string instead of a list used to survive all the way to selectUpstream - which
 * iterates it, and therefore iterated its characters. The moment one of them was "*", matchScope
 * matched every package name and the entry silently became a catch-all that took over routing
 * for the whole proxy. A malformed entry has to fail at load, naming itself, rather than quietly
 * change where packages come from.
 */
function toScopes(raw: unknown, context: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((scope) => typeof scope !== "string")) {
    throw new Error(`Invalid scopes in ${context}: expected a list of strings`);
  }
  return raw as string[];
}

function toEntry(raw: RawEntry, context: string): UpstreamEntry {
  if (!raw?.baseUrl) {
    throw new Error(`Missing baseUrl in ${context}`);
  }
  const normalized = normalizeBaseUrl(raw.baseUrl);
  const host = new URL(normalized).host;
  const rawType = typeof raw.type === "string" ? raw.type.toLowerCase() : "npm";
  const type = rawType === "vpm" ? "vpm" : "npm";
  return {
    baseUrl: normalized,
    scopes: toScopes(raw.scopes, context),
    host,
    type
  };
}

let cachedConfig: UpstreamConfig | null = null;

export function getUpstreamConfig(): UpstreamConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = resolve(process.cwd(), mustEnv("UPSTREAM_CONFIG_PATH"));

  const rawText = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(rawText) as RawConfig;

  const rawDefault = parsed.default;
  const rawDefaultList = Array.isArray(rawDefault) ? rawDefault : rawDefault ? [rawDefault] : [];
  if (rawDefaultList.length === 0) {
    throw new Error("Missing default upstream config");
  }

  const upstreams = Array.isArray(parsed.upstreams) ? parsed.upstreams : [];

  cachedConfig = {
    default: toEntry(rawDefaultList[0], "default"),
    upstreams: upstreams.map((u, i) => toEntry(u, `upstreams[${i}]`))
  };

  return cachedConfig;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchScope(name: string, scope: string): boolean {
  if (scope.endsWith(".*")) {
    const base = scope.slice(0, -2);
    if (name === base) return true;
  }
  const pattern = `^${scope.split("*").map(escapeRegExp).join(".*")}$`;
  return new RegExp(pattern).test(name);
}

export function selectUpstream(packageName: string): UpstreamEntry {
  const config = getUpstreamConfig();
  for (const upstream of config.upstreams) {
    for (const scope of upstream.scopes ?? []) {
      if (matchScope(packageName, scope)) return upstream;
    }
  }
  return config.default;
}

export function selectUpstreamForScopeText(scopeText: string): UpstreamEntry {
  const config = getUpstreamConfig();
  for (const upstream of config.upstreams) {
    for (const scope of upstream.scopes ?? []) {
      if (matchScope(scopeText, scope)) return upstream;
    }
  }
  return config.default;
}

/**
 * The package name at the head of a path, handling the two segments of a scoped name.
 *
 * `encoded` says whether the caller's path still carries percent escapes. A route handler's rest
 * path does not - the router decoded it - and decoding it again was wrong twice over: a name
 * holding a literal "%" made decodeURIComponent throw, answering 500 before anything was fetched,
 * and one holding "%41" quietly became "A", selecting a different package than the caller asked
 * for. A path taken out of a URL still is encoded, which is why the flag exists rather than a
 * single rule.
 */
export function extractPackageName(restPath: string, encoded = false): string | null {
  const decode = (value: string): string => {
    if (!encoded) return value;
    try {
      return decodeURIComponent(value);
    } catch {
      // Not valid percent-encoding after all; the literal text is the best answer available.
      return value;
    }
  };
  const trimmed = restPath.replace(/^\/+/, "");
  const parts = trimmed.split("/");
  if (parts.length === 0) return null;
  if (parts[0].startsWith("@")) {
    const decodedFirst = decode(parts[0]);
    if (decodedFirst.includes("/")) return decodedFirst;
    if (parts.length < 2) return null;
    return decode(`${parts[0]}/${parts[1]}`);
  }
  return decode(parts[0]);
}
