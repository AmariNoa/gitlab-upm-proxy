import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import * as semver from "semver";
import * as tar from "tar";
import { request } from "undici";
import {
  deleteMetadataCache,
  getPackageCacheDir,
  getTarballCachePath,
  hasTarballCache,
  readMetadataCache,
  readTarballCache,
  writeMetadataCache,
  writeTarballCache
} from "../lib/cache";
import {
  extractPackageName,
  getUpstreamConfig,
  selectUpstream,
  UpstreamEntry
} from "../lib/upstreams";

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const PUBLIC_BASE_URL = mustEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
const TARBALL_CACHE_DIR = process.env.TARBALL_CACHE_DIR ?? "./data/cache";

const upstreamConfig = getUpstreamConfig();
const defaultUpstream = upstreamConfig.default;

/**
 * Unity → 中継で受けたヘッダから upstream に転送するヘッダを構築
 * - string のみ転送（string[] / undefined は捨てる）
 * - hop-by-hop を除外
 * - 認証ヘッダは「1種類だけ」残して確実に透過（Authorization / PRIVATE-TOKEN）
 */
function buildUpstreamHeaders(reqHeaders: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(reqHeaders)) {
    if (typeof v === "string") out[k] = v;
  }

  delete out["host"];
  delete out["connection"];
  delete out["content-length"];
  delete out["transfer-encoding"];

  const auth =
    (typeof reqHeaders["authorization"] === "string" ? (reqHeaders["authorization"] as string) : "") ||
    (typeof reqHeaders["Authorization"] === "string" ? (reqHeaders["Authorization"] as string) : "");

  const token =
    (typeof reqHeaders["private-token"] === "string" ? (reqHeaders["private-token"] as string) : "") ||
    (typeof reqHeaders["PRIVATE-TOKEN"] === "string" ? (reqHeaders["PRIVATE-TOKEN"] as string) : "") ||
    (typeof reqHeaders["Private-Token"] === "string" ? (reqHeaders["Private-Token"] as string) : "");

  delete out["authorization"];
  delete out["Authorization"];
  delete out["private-token"];
  delete out["Private-Token"];
  delete out["PRIVATE-TOKEN"];

  if (auth) out["Authorization"] = auth;
  if (token) out["PRIVATE-TOKEN"] = token;

  return out;
}

function applyUpstreamHeaders(
  reply: any,
  headers: Record<string, unknown>,
  skipContentLength: boolean
): void {
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string") continue;
    if (skipContentLength && k.toLowerCase() === "content-length") continue;
    reply.header(k, v);
  }
}

function compareVersions(a: string, b: string): number {
  const aValid = semver.valid(a);
  const bValid = semver.valid(b);
  if (aValid && bValid) return semver.compare(aValid, bValid);
  return a.localeCompare(b);
}

function pickLatestByName(items: any[]): any[] {
  const byName = new Map<string, any>();
  for (const item of items) {
    const name = String(item?.name ?? "");
    const current = byName.get(name);
    if (!current) {
      byName.set(name, item);
      continue;
    }
    const currentVersion = String(current?.version ?? "");
    const itemVersion = String(item?.version ?? "");
    if (compareVersions(currentVersion, itemVersion) < 0) {
      byName.set(name, item);
    }
  }

  return Array.from(byName.values()).sort((a, b) =>
    String(a?.name ?? "").localeCompare(String(b?.name ?? ""))
  );
}

function getLatestVersionFromMetadata(metadata: any): string | null {
  const distTags = metadata?.["dist-tags"];
  if (distTags && typeof distTags.latest === "string") return distTags.latest;
  const versions = metadata?.versions;
  if (!versions || typeof versions !== "object") return null;
  const keys = Object.keys(versions);
  if (keys.length === 0) return null;
  const valid = keys.filter((v) => semver.valid(v));
  if (valid.length > 0) return valid.sort(semver.rcompare)[0];
  return keys.sort().at(-1) ?? null;
}

function extractAuthor(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return undefined;
}

function getUpstreamBaseForGroup(
  upstream: UpstreamEntry,
  groupEnc: string,
  restPath: string
): string {
  const normalizedRest = restPath.replace(/^\/+/, "");
  if (upstream.baseUrl === defaultUpstream.baseUrl) {
    const groupPath = decodeURIComponent(groupEnc);
    const groupEncOnce = encodeURIComponent(groupPath);
    return `${upstream.baseUrl}/api/v4/groups/${groupEncOnce}/-/packages/npm/${normalizedRest}`;
  }
  return `${upstream.baseUrl}/${normalizedRest}`;
}

function rewriteTarballUrl(
  tarballUrl: string,
  upstream: UpstreamEntry,
  groupEnc: string
): string {
  if (upstream.baseUrl === defaultUpstream.baseUrl) {
    if (tarballUrl.startsWith(upstream.baseUrl)) {
      return tarballUrl.replace(upstream.baseUrl, PUBLIC_BASE_URL);
    }
    return tarballUrl;
  }

  try {
    const parsed = new URL(tarballUrl);
    const tarPath = `${parsed.pathname}${parsed.search}`.replace(/^\/+/, "");
    return `${PUBLIC_BASE_URL}/api/v4/groups/${groupEnc}/${tarPath}`;
  } catch {
    return tarballUrl;
  }
}

function rewriteTarballUrlsInMetadata(
  metadata: any,
  upstream: UpstreamEntry,
  groupEnc: string
): void {
  if (!metadata || typeof metadata !== "object") return;
  if (!metadata.versions || typeof metadata.versions !== "object") return;
  for (const v of Object.values<any>(metadata.versions)) {
    const tar = v?.dist?.tarball;
    if (typeof tar === "string") {
      v.dist.tarball = rewriteTarballUrl(tar, upstream, groupEnc);
    }
  }
}

async function deletePackageCache(upstream: UpstreamEntry, packageName: string): Promise<void> {
  await deleteMetadataCache(upstream.host, packageName);
  await rm(getPackageCacheDir(upstream.host, packageName), { recursive: true, force: true });
}

function extractTarballFilenameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    return decodeURIComponent(parts[parts.length - 1]);
  } catch {
    return null;
  }
}

function extractTarballFilenameFromPath(restPath: string): string | null {
  const parts = restPath.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  return decodeURIComponent(parts[parts.length - 1]);
}

async function downloadTarballToCache(
  tarballUrl: string,
  upstream: UpstreamEntry,
  packageName: string,
  headers: Record<string, string>
): Promise<string> {
  const filename = extractTarballFilenameFromUrl(tarballUrl);
  if (!filename) {
    throw new Error("Tarball filename not found");
  }
  const res = await request(tarballUrl, { method: "GET", headers });
  if (res.statusCode >= 400) {
    throw new Error(`Tarball download failed: ${res.statusCode}`);
  }
  const buffer = Buffer.from(await res.body.arrayBuffer());
  return await writeTarballCache(upstream.host, packageName, filename, buffer);
}

async function readPackageInfoFromTarballPath(
  tarballPath: string
): Promise<{ author?: string; displayName?: string }> {
  await mkdir(TARBALL_CACHE_DIR, { recursive: true });
  const tempDir = await mkdtemp(join(TARBALL_CACHE_DIR, "extract-"));
  try {
    await tar.x({
      file: tarballPath,
      cwd: tempDir,
      filter: (p) => p === "package/package.json"
    });

    const packageJsonPath = join(tempDir, "package", "package.json");
    const raw = await readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    return {
      author: extractAuthor(parsed.author),
      displayName: typeof parsed.displayName === "string" ? parsed.displayName : undefined
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function mergeMetadataIfNeeded(
  metadata: any,
  packageName: string,
  upstream: UpstreamEntry,
  headers: Record<string, string>
): Promise<void> {
  const latestVersion = getLatestVersionFromMetadata(metadata);
  if (!latestVersion) return;

  const versionNode =
    metadata?.versions && typeof metadata.versions === "object"
      ? metadata.versions[latestVersion]
      : undefined;

  const upstreamAuthor = extractAuthor(metadata?.author ?? versionNode?.author);
  const upstreamDisplayName =
    typeof metadata?.displayName === "string"
      ? metadata.displayName
      : typeof versionNode?.displayName === "string"
        ? versionNode.displayName
        : undefined;

  let author = upstreamAuthor ?? undefined;
  let displayName = upstreamDisplayName ?? undefined;

  if (!author || !displayName) {
    const tarballUrl = versionNode?.dist?.tarball;
    if (typeof tarballUrl === "string") {
      const filename = extractTarballFilenameFromUrl(tarballUrl);
      if (filename) {
        let tarballPath = getTarballCachePath(upstream.host, packageName, filename);
        const cachedTarball = await hasTarballCache(upstream.host, packageName, filename);
        if (!cachedTarball) {
          tarballPath = await downloadTarballToCache(tarballUrl, upstream, packageName, headers);
        }
        const info = await readPackageInfoFromTarballPath(tarballPath);
        author = author ?? info.author;
        displayName = displayName ?? info.displayName;
      }
    }
  }

  if (author) {
    metadata.author = author;
    if (versionNode) versionNode.author = author;
  }
  if (displayName) {
    metadata.displayName = displayName;
    if (versionNode) versionNode.displayName = displayName;
  }
}

/**
 * npm search の実装本体（groupEnc を受け取って GitLab Packages API から列挙）
 */
async function handleSearch(req: any, reply: any, groupEnc: string): Promise<void> {
  const groupPath = decodeURIComponent(groupEnc);
  const groupEncOnce = encodeURIComponent(groupPath);

  const text = (req.query.text ?? "").toString();
  const from = Number.parseInt((req.query.from ?? "0").toString(), 10) || 0;
  const sizeRaw = Number.parseInt((req.query.size ?? "20").toString(), 10) || 20;
  const size = Math.min(Math.max(sizeRaw, 1), 250);

  const base = `${defaultUpstream.baseUrl}/api/v4/groups/${groupEncOnce}/packages`;
  const headers = buildUpstreamHeaders(req.headers as any);

  const perPage = 100;
  const maxPages = 50;
  const all: any[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const u = new URL(base);
    u.searchParams.set("package_type", "npm");
    u.searchParams.set("exclude_subgroups", "false");
    u.searchParams.set("per_page", String(perPage));
    u.searchParams.set("page", String(page));
    u.searchParams.set("order_by", "name");
    u.searchParams.set("sort", "asc");

    const res = await request(u.toString(), { method: "GET", headers });

    if (res.statusCode >= 400) {
      const body = await res.body.text();
      reply.code(res.statusCode).type("application/json").send({
        error: "gitlab_packages_api_failed",
        status: res.statusCode,
        body
      });
      return;
    }

    const items = (await res.body.json()) as any[];
    all.push(...items);
    if (items.length < perPage) break;
  }

  const filtered = all
    .filter((p) => p?.package_type === "npm")
    .filter((p) => {
      if (!text) return true;
      const name = String(p?.name ?? "");
      return name.includes(text);
    });

  const latestOnly = pickLatestByName(filtered);
  const sliced = latestOnly.slice(from, from + size);
  const now = new Date().toISOString();

  reply.type("application/json").send({
    objects: sliced.map((p) => ({
      package: {
        name: String(p?.name ?? ""),
        version: String(p?.version ?? ""),
        description: String(p?.description ?? ""),
        date: p?.created_at ?? now
      },
      score: { final: 1, detail: {} },
      searchScore: 1
    })),
    total: latestOnly.length,
    time: now
  });
}

/**
 * npm registry 透過（groupEnc を受け取って upstream npm registry に中継）
 */
async function proxyGroupNpm(
  req: any,
  reply: any,
  groupEnc: string,
  restPath: string
): Promise<void> {
  const packageName = extractPackageName(restPath);
  const upstream = packageName ? selectUpstream(packageName) : defaultUpstream;
  const upstreamUrl = getUpstreamBaseForGroup(upstream, groupEnc, restPath);
  const headers = buildUpstreamHeaders(req.headers as any);

  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : (req.body as any);
  const isTarball = (method === "GET" || method === "HEAD") && restPath.endsWith(".tgz");
  const tarballFilename = isTarball ? extractTarballFilenameFromPath(restPath) : null;

  if (isTarball && packageName && tarballFilename) {
    const cachedBuffer = await readTarballCache(upstream.host, packageName, tarballFilename);
    if (cachedBuffer) {
      reply.code(200);
      reply.header("content-type", "application/octet-stream");
      reply.header("content-length", String(cachedBuffer.length));
      if (method === "HEAD") {
        reply.send();
      } else {
        reply.send(cachedBuffer);
      }
      return;
    }
  }

  const res = await request(upstreamUrl, { method, headers, body: body as any });
  const contentType = String(res.headers["content-type"] ?? "");

  if (res.statusCode === 404 && packageName) {
    await deletePackageCache(upstream, packageName);
  }

  if (contentType.includes("application/json")) {
    const json = (await res.body.json()) as any;

    if (json && typeof json === "object" && json.versions && typeof json.versions === "object") {
      if (packageName) {
        const latestVersion = getLatestVersionFromMetadata(json);
        const cached = await readMetadataCache(upstream.host, packageName);
        if (cached && latestVersion && cached.latestVersion === latestVersion) {
          const cachedMetadata = JSON.parse(JSON.stringify(cached.metadata));
          rewriteTarballUrlsInMetadata(cachedMetadata, upstream, groupEnc);
          reply.code(res.statusCode);
          applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, true);
          reply.type("application/json").send(cachedMetadata);
          return;
        }

        await mergeMetadataIfNeeded(json, packageName, upstream, headers);

        const cacheMetadata = JSON.parse(JSON.stringify(json));
        rewriteTarballUrlsInMetadata(json, upstream, groupEnc);

        if (latestVersion) {
          await writeMetadataCache(upstream.host, packageName, {
            latestVersion,
            author: extractAuthor(json?.author),
            displayName: typeof json?.displayName === "string" ? json.displayName : undefined,
            metadata: cacheMetadata
          });
        }
      } else {
        rewriteTarballUrlsInMetadata(json, upstream, groupEnc);
      }
    }

    reply.code(res.statusCode);
    applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, true);
    reply.type("application/json").send(json);
    return;
  }

  reply.code(res.statusCode);
  applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, false);
  const buffer = Buffer.from(await res.body.arrayBuffer());
  if (isTarball && method === "GET" && packageName && tarballFilename && res.statusCode < 400) {
    await writeTarballCache(upstream.host, packageName, tarballFilename, buffer);
  }
  reply.send(buffer);
}

const routes: FastifyPluginAsync = async (app) => {
  app.register(
    async (r) => {
      r.get<{
        Params: { groupEnc: string };
        Querystring: { text?: string; from?: string; size?: string };
      }>("/-/v1/search", async (req, reply) => {
        await handleSearch(req, reply, req.params.groupEnc);
      });

      r.all("/*", async (req, reply) => {
        const groupEnc = (req.params as any).groupEnc as string;
        const restPath = (req.params as any)["*"] as string;
        await proxyGroupNpm(req, reply, groupEnc, restPath);
      });
    },
    { prefix: "/api/v4/groups/:groupEnc" }
  );

  app.register(
    async (r) => {
      r.all("/*", async (req, reply) => {
        const projectId = (req.params as any).projectId as string;
        const restPath = (req.params as any)["*"] as string;
        const packageName = extractPackageName(restPath);

        const upstreamUrl = `${defaultUpstream.baseUrl}/api/v4/projects/${projectId}/packages/npm/${restPath}`;
        const headers = buildUpstreamHeaders(req.headers as any);

        const method = req.method.toUpperCase();
        const body = method === "GET" || method === "HEAD" ? undefined : (req.body as any);
        const isTarball = (method === "GET" || method === "HEAD") && restPath.endsWith(".tgz");
        const tarballFilename = isTarball ? extractTarballFilenameFromPath(restPath) : null;

        if (isTarball && packageName && tarballFilename) {
          const cachedBuffer = await readTarballCache(
            defaultUpstream.host,
            packageName,
            tarballFilename
          );
          if (cachedBuffer) {
            reply.code(200);
            reply.header("content-type", "application/octet-stream");
            reply.header("content-length", String(cachedBuffer.length));
            if (method === "HEAD") {
              reply.send();
            } else {
              reply.send(cachedBuffer);
            }
            return;
          }
        }

        const res = await request(upstreamUrl, { method, headers, body: body as any });
        const contentType = String(res.headers["content-type"] ?? "");

        if (contentType.includes("application/json")) {
          const json = (await res.body.json()) as any;

          if (json && typeof json === "object" && json.versions && typeof json.versions === "object") {
            for (const v of Object.values<any>(json.versions)) {
              const tar = v?.dist?.tarball;
              if (typeof tar === "string" && tar.startsWith(defaultUpstream.baseUrl)) {
                v.dist.tarball = tar.replace(defaultUpstream.baseUrl, PUBLIC_BASE_URL);
              }
            }
          }

          reply.code(res.statusCode);
          applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, true);
          reply.type("application/json").send(json);
          return;
        }

        reply.code(res.statusCode);
        applyUpstreamHeaders(reply, res.headers as Record<string, unknown>, false);
        const buffer = Buffer.from(await res.body.arrayBuffer());
        if (isTarball && method === "GET" && packageName && tarballFilename && res.statusCode < 400) {
          await writeTarballCache(defaultUpstream.host, packageName, tarballFilename, buffer);
        }
        reply.send(buffer);
      });
    },
    { prefix: "/api/v4/projects/:projectId/packages/npm" }
  );
};

export default routes;
