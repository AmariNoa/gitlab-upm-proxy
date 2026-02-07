import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export type UpstreamEntry = {
  baseUrl: string;
  scopes?: string[];
  host: string;
};

type RawEntry = {
  baseUrl?: string;
  scopes?: string[];
};

type RawConfig = {
  default?: RawEntry[] | RawEntry;
  upstreams?: RawEntry[];
};

export type UpstreamConfig = {
  default: UpstreamEntry;
  upstreams: UpstreamEntry[];
};

const DEFAULT_CONFIG_PATH = resolve(process.cwd(), "config", "upstreams.yml");

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function toEntry(raw: RawEntry, context: string): UpstreamEntry {
  if (!raw?.baseUrl) {
    throw new Error(`Missing baseUrl in ${context}`);
  }
  const normalized = normalizeBaseUrl(raw.baseUrl);
  const host = new URL(normalized).host;
  return {
    baseUrl: normalized,
    scopes: raw.scopes ?? [],
    host
  };
}

let cachedConfig: UpstreamConfig | null = null;

export function getUpstreamConfig(): UpstreamConfig {
  if (cachedConfig) return cachedConfig;

  const configPath = process.env.UPSTREAM_CONFIG_PATH
    ? resolve(process.cwd(), process.env.UPSTREAM_CONFIG_PATH)
    : DEFAULT_CONFIG_PATH;

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
