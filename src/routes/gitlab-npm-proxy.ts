import type { FastifyPluginAsync } from "fastify";
import { request } from "undici";

function mustEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

const PUBLIC_BASE_URL = mustEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
const GITLAB_BASE_URL = mustEnv("GITLAB_BASE_URL").replace(/\/+$/, "");

/**
 * Unity → 中継で受けたヘッダから、GitLab upstream に転送するヘッダを構築
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

/**
 * npm search の実装本体（groupEnc を受け取って GitLab Packages API から列挙）
 */
async function handleSearch(
    req: any,
    reply: any,
    groupEnc: string
): Promise<void> {
    const groupPath = decodeURIComponent(groupEnc);
    const groupEncOnce = encodeURIComponent(groupPath);

    const text = (req.query.text ?? "").toString();
    const from = Number.parseInt((req.query.from ?? "0").toString(), 10) || 0;
    const sizeRaw = Number.parseInt((req.query.size ?? "20").toString(), 10) || 20;
    const size = Math.min(Math.max(sizeRaw, 1), 250);

    const base = `${GITLAB_BASE_URL}/api/v4/groups/${groupEncOnce}/packages`;
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

    const sliced = filtered.slice(from, from + size);
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
        total: filtered.length,
        time: now
    });
}

/**
 * npm registry 透過（groupEnc を受け取って GitLab group-level npm registry に中継）
 */
async function proxyGroupNpm(
    req: any,
    reply: any,
    groupEnc: string,
    restPath: string
): Promise<void> {
    const groupPath = decodeURIComponent(groupEnc);
    const groupEncOnce = encodeURIComponent(groupPath);

    const upstream = `${GITLAB_BASE_URL}/api/v4/groups/${groupEncOnce}/-/packages/npm/${restPath}`;
    const headers = buildUpstreamHeaders(req.headers as any);

    const method = req.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : (req.body as any);

    const res = await request(upstream, { method, headers, body: body as any });
    const contentType = String(res.headers["content-type"] ?? "");

    if (contentType.includes("application/json")) {
        const json = (await res.body.json()) as any;

        if (json && typeof json === "object" && json.versions && typeof json.versions === "object") {
            for (const v of Object.values<any>(json.versions)) {
                const tar = v?.dist?.tarball;
                if (typeof tar === "string" && tar.startsWith(GITLAB_BASE_URL)) {
                    v.dist.tarball = tar.replace(GITLAB_BASE_URL, PUBLIC_BASE_URL);
                }
            }
        }

        reply.code(res.statusCode);
        for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") reply.header(k, v);
        }
        reply.type("application/json").send(json);
        return;
    }

    reply.code(res.statusCode);
    for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === "string") reply.header(k, v);
    }
    reply.send(Buffer.from(await res.body.arrayBuffer()));
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

                const upstream = `${GITLAB_BASE_URL}/api/v4/projects/${projectId}/packages/npm/${restPath}`;
                const headers = buildUpstreamHeaders(req.headers as any);

                const method = req.method.toUpperCase();
                const body = method === "GET" || method === "HEAD" ? undefined : (req.body as any);

                const res = await request(upstream, { method, headers, body: body as any });
                const contentType = String(res.headers["content-type"] ?? "");

                if (contentType.includes("application/json")) {
                    const json = (await res.body.json()) as any;

                    if (json && typeof json === "object" && json.versions && typeof json.versions === "object") {
                        for (const v of Object.values<any>(json.versions)) {
                            const tar = v?.dist?.tarball;
                            if (typeof tar === "string" && tar.startsWith(GITLAB_BASE_URL)) {
                                v.dist.tarball = tar.replace(GITLAB_BASE_URL, PUBLIC_BASE_URL);
                            }
                        }
                    }

                    reply.code(res.statusCode);
                    for (const [k, v] of Object.entries(res.headers)) {
                        if (typeof v === "string") reply.header(k, v);
                    }
                    reply.type("application/json").send(json);
                    return;
                }

                reply.code(res.statusCode);
                for (const [k, v] of Object.entries(res.headers)) {
                    if (typeof v === "string") reply.header(k, v);
                }
                reply.send(Buffer.from(await res.body.arrayBuffer()));
            });
        },
        { prefix: "/api/v4/projects/:projectId/packages/npm" }
    );
};

export default routes;
