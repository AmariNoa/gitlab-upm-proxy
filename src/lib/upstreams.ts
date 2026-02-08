import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

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
    scopes: raw.scopes ?? [],
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

export function extractPackageName(restPath: string): string | null {
  const trimmed = restPath.replace(/^\/+/, "");
  const parts = trimmed.split("/");
  if (parts.length === 0) return null;
  if (parts[0].startsWith("@")) {
    const decodedFirst = decodeURIComponent(parts[0]);
    if (decodedFirst.includes("/")) return decodedFirst;
    if (parts.length < 2) return null;
    return decodeURIComponent(`${parts[0]}/${parts[1]}`);
  }
  return decodeURIComponent(parts[0]);
}
