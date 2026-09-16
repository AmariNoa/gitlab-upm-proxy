import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { requestUpstream, UpstreamError } from "../lib/http";
import { getUpstreamConfig } from "../lib/upstreams";

/**
 * OAuth relay for the Unity package registry manager.
 *
 * This file is deliberately separate from the package routes. Those register their PAT check as an
 * onRequest hook on their own plugin, and because neither file is wrapped in fastify-plugin, the
 * encapsulation boundary AutoLoad creates keeps that hook out of here. The authorization start and
 * the token exchange have to be reachable before anyone holds a token, and the package routes have
 * to keep refusing unauthenticated callers - separate files give both without touching either.
 *
 * What this does NOT do is become an authorization server. GitLab issues the tokens and decides
 * what they may read; every route here forwards to GitLab and shapes the answer.
 */

const PROTOCOL_VERSION = 1;

/** Ceiling on an upstream OAuth response. A token document is small; the shared 512 MiB ceiling
 * that suits archives has no business on this path. */
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_BODY_BYTES = 8 * 1024;
const MAX_AUTHORIZE_QUERY_BYTES = 4 * 1024;
const UPSTREAM_TIMEOUT_MS = 30_000;
/** Covers the whole exchange, not just the gaps between packets. An upstream that dribbles a
 * response out slowly enough never trips a per-read timeout, and would otherwise hold one of the
 * concurrency slots for as long as it liked. */
const TOTAL_DEADLINE_MS = 35_000;

const MAX_CONCURRENT_TOKEN_REQUESTS = 16;
const RATE_LIMIT_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60_000;
const RATE_ENTRY_TTL_MS = 10 * 60_000;
const RATE_SWEEP_INTERVAL_MS = 30_000;
const MAX_RATE_ENTRIES = 10_000;

const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const MIN_STATE_LENGTH = 43;

type OAuthConfig = {
  clientId: string;
  redirectUris: string[];
  scopes: string[];
  gitlabBaseUrl: string;
};

/** A failure this proxy is willing to describe to the caller. Anything not raised as one of these
 * is reported as internal_error with no detail, because the detail could be the upstream's body. */
class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number
  ) {
    super(code);
    this.name = "OAuthError";
  }
}

function isLoopbackHttp(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  return url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
}

/**
 * Resolves the configuration, or explains why OAuth is off.
 *
 * Every variable here is optional on purpose. The required ones are read at module load by the
 * package routes and a missing one stops the process; adding another of those would take down
 * every existing deployment the moment it restarted. A deployment that has not configured OAuth
 * must keep working exactly as before, so an incomplete configuration disables this feature and
 * nothing else.
 */
function resolveConfig(): { config: OAuthConfig | null; reason: string } {
  const clientId = (process.env.OAUTH_CLIENT_ID || "").trim();
  if (!clientId) return { config: null, reason: "OAUTH_CLIENT_ID is not set" };

  const rawRedirects = (process.env.OAUTH_REDIRECT_URIS || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (rawRedirects.length === 0) return { config: null, reason: "OAUTH_REDIRECT_URIS is empty" };

  for (const raw of rawRedirects) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return { config: null, reason: "a redirect URI is not an absolute URI" };
    }
    // Anything other than https or a loopback address would let an authorization code travel in
    // the clear to a host on the network.
    if (parsed.protocol !== "https:" && !isLoopbackHttp(parsed)) {
      return { config: null, reason: "a redirect URI is neither https nor loopback http" };
    }
  }

  const scopes = (process.env.OAUTH_SCOPES || "read_api")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (scopes.length === 0) return { config: null, reason: "OAUTH_SCOPES is empty" };

  let gitlabBaseUrl: string;
  try {
    gitlabBaseUrl = getUpstreamConfig().default.baseUrl.replace(/\/+$/, "");
  } catch {
    return { config: null, reason: "the default upstream is not configured" };
  }
  if (!gitlabBaseUrl.startsWith("https://")) {
    return { config: null, reason: "the default upstream is not https" };
  }

  const publicBase = (process.env.PUBLIC_BASE_URL || "").trim();
  if (!publicBase.startsWith("https://")) {
    return { config: null, reason: "PUBLIC_BASE_URL is not https" };
  }

  return { config: { clientId, redirectUris: rawRedirects, scopes, gitlabBaseUrl }, reason: "" };
}

function requireConfig(): OAuthConfig {
  const { config } = resolveConfig();
  if (!config) throw new OAuthError("oauth_not_configured", 404);
  return config;
}

/**
 * Reads one query parameter, refusing a repeated one.
 *
 * A repeated parameter is how a caller smuggles a second value past a check that only looked at
 * the first. Since every upstream request here is rebuilt from named values rather than forwarded,
 * a duplicate can only be an attempt to confuse this layer.
 */
function singleQuery(query: any, name: string): string | undefined {
  const value = query?.[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new OAuthError("invalid_request", 400);
  if (typeof value !== "string") throw new OAuthError("invalid_request", 400);
  return value;
}

function singleBody(body: any, name: string): string | undefined {
  const value = body?.[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new OAuthError("invalid_request", 400);
  if (typeof value !== "string") throw new OAuthError("invalid_request", 400);
  return value;
}

function requireBody(body: any, name: string): string {
  const value = singleBody(body, name);
  if (!value) throw new OAuthError("invalid_request", 400);
  return value;
}

/** Exact match against the configured list. A prefix test here is an open redirect. */
function requireAllowedRedirect(config: OAuthConfig, value: string | undefined): string {
  if (!value) throw new OAuthError("invalid_request", 400);
  if (!config.redirectUris.includes(value)) throw new OAuthError("invalid_request", 400);
  return value;
}

/** The requested scopes must be a subset of what the operator allowed; silence means all of them. */
function resolveScopes(config: OAuthConfig, requested: string | undefined): string {
  if (!requested) return config.scopes.join(" ");
  const parts = requested.split(/[\s,]+/).filter((s) => s.length > 0);
  if (parts.length === 0) throw new OAuthError("invalid_request", 400);
  for (const part of parts) {
    if (!config.scopes.includes(part)) throw new OAuthError("invalid_request", 400);
  }
  return parts.join(" ");
}

/**
 * Parses an upstream OAuth response without letting any of it into an error.
 *
 * readUpstreamJson cannot be used here. It puts the JSON.parse message into the error it throws,
 * and Node includes a slice of the input in that message - measured: `Unexpected token '﻿',
 * "﻿{"a":1}" is not valid JSON`. On this path the input is a token document, so that slice
 * could be a token, and it would reach the log.
 */
function parseOAuthJson(buffer: Buffer): any {
  try {
    return JSON.parse(buffer.toString("utf-8"));
  } catch {
    throw new OAuthError("upstream_invalid_response", 502);
  }
}

/**
 * Checks that an upstream token document is one a client can actually use.
 *
 * The refresh_token requirement is not pedantry: GitLab invalidates both the old access token and
 * the old refresh token when a refresh succeeds, so a response missing the new refresh token would
 * leave the client with nothing usable and no way to notice until the next refresh failed.
 */
function validateTokenDocument(doc: any): Record<string, unknown> {
  if (!doc || typeof doc !== "object") throw new OAuthError("upstream_invalid_response", 502);
  const accessToken = doc.access_token;
  const tokenType = doc.token_type;
  const expiresIn = doc.expires_in;
  const refreshToken = doc.refresh_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthError("upstream_invalid_response", 502);
  }
  // GitLab's documented response spells it in lower case.
  if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
    throw new OAuthError("upstream_invalid_response", 502);
  }
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new OAuthError("upstream_invalid_response", 502);
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    throw new OAuthError("upstream_invalid_response", 502);
  }
  const out: Record<string, unknown> = {
    access_token: accessToken,
    token_type: tokenType,
    expires_in: expiresIn,
    refresh_token: refreshToken
  };
  if (typeof doc.created_at === "number") out.created_at = doc.created_at;
  if (typeof doc.scope === "string") out.scope = doc.scope;
  return out;
}

/**
 * Counts recent requests per caller, forgetting them so the table cannot grow without bound.
 *
 * Created per plugin instance rather than per module. A counter shared across instances would
 * carry one server's traffic into another's budget, which in a test run means the order of the
 * cases decides whether a request is admitted.
 */
function createRateLimiter() {
  const buckets = new Map<string, number[]>();
  let lastSweep = 0;
  return function rateLimited(key: string, now: number): boolean {
    // Sweeping on a timer rather than on every request. Walking ten thousand entries to answer
    // one call would turn a flood of refusals into work for the event loop - which is the thing
    // a rate limit is supposed to prevent.
    if (now - lastSweep >= RATE_SWEEP_INTERVAL_MS) {
      lastSweep = now;
      for (const [k, times] of buckets) {
        const kept = times.filter((t) => now - t < RATE_ENTRY_TTL_MS);
        if (kept.length === 0) buckets.delete(k);
        else buckets.set(k, kept);
      }
    }
    if (!buckets.has(key) && buckets.size >= MAX_RATE_ENTRIES) {
      // The table is full of other callers. Refusing is the safe answer; admitting would let a
      // flood of forged addresses push real callers out.
      return true;
    }
    const times = buckets.get(key) || [];
    const recent = times.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT_PER_MINUTE) {
      buckets.set(key, recent);
      return true;
    }
    recent.push(now);
    buckets.set(key, recent);
    return false;
  };
}

/**
 * Identifies the caller for rate limiting.
 *
 * The socket address, not a forwarded header. A header is written by whoever is talking to us and
 * is only meaningful when a trusted front end put it there; treating it as identity by default
 * lets one caller appear as thousands.
 */
function rateKey(req: FastifyRequest): string {
  return (req.raw.socket && (req.raw.socket as any).remoteAddress) || "unknown";
}

/** Runs one upstream exchange under a single deadline covering both the request and the read. */
async function withDeadline<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOTAL_DEADLINE_MS);
  (timer as any).unref?.();
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads an upstream OAuth response, refusing an oversized one at once.
 *
 * The shared reader drains an oversized body before reporting it, which is right when the point
 * is to keep the connection reusable. Here it is not: an upstream that declares more than a token
 * document could ever be is not one to keep talking to, and draining it is exactly the wait this
 * path must not take.
 */
async function readOAuthBody(res: any): Promise<Buffer> {
  const declared = Number(res.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_OAUTH_RESPONSE_BYTES) {
    res.body.destroy();
    throw new OAuthError("upstream_invalid_response", 502);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_OAUTH_RESPONSE_BYTES) {
        res.body.destroy();
        throw new OAuthError("upstream_invalid_response", 502);
      }
      chunks.push(buf);
    }
  } catch (err) {
    if (err instanceof OAuthError) throw err;
    // Including an aborted read: the deadline fired, which is an upstream problem from here.
    throw new OAuthError("upstream_failed", 502);
  }
  return Buffer.concat(chunks, total);
}

async function postForm(
  url: string,
  params: Record<string, string>,
  signal: AbortSignal
): Promise<any> {
  const body = new URLSearchParams(params).toString();
  return requestUpstream(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "content-length": String(Buffer.byteLength(body))
    },
    body,
    signal,
    headersTimeout: UPSTREAM_TIMEOUT_MS,
    bodyTimeout: UPSTREAM_TIMEOUT_MS
  });
}

/** Maps an upstream status onto the one error code that describes it, discarding the body. */
function tokenErrorFor(status: number): OAuthError {
  if (status === 400 || status === 401) return new OAuthError("invalid_grant", 400);
  return new OAuthError("upstream_failed", 502);
}

const routes: FastifyPluginAsync = async (app) => {
  // Per instance, not per module: two servers in one process must not share a budget.
  const rateLimited = createRateLimiter();
  let inFlightTokenRequests = 0;

  // A token must not be written to a shared cache, and an error on this path must not be either -
  // the header goes on before the payload is known, so it cannot be forgotten on one branch.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("pragma", "no-cache");
    return payload;
  });

  // The package routes register their own error handler on their own plugin, which does not reach
  // here. Without this, Fastify's default would put the exception message in the response - and on
  // this path an exception message can carry an upstream body.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof OAuthError) {
      req.log.info({ oauthError: err.code }, "oauth_request_rejected");
      reply.code(err.status).send({ error: err.code });
      return;
    }
    if (err instanceof UpstreamError) {
      req.log.warn({ kind: err.kind }, "oauth_upstream_failed");
      reply.code(502).send({ error: "upstream_failed" });
      return;
    }
    if ((err as any)?.statusCode === 413 || (err as any)?.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      reply.code(413).send({ error: "invalid_request" });
      return;
    }
    if ((err as any)?.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      reply.code(415).send({ error: "unsupported_media_type" });
      return;
    }
    // Everything else the content type parsers raise is a malformed request, not a fault here.
    // Reporting those as internal_error would both mislead the caller and fill the error log
    // with entries an operator cannot act on.
    if (typeof (err as any)?.code === "string" && (err as any).code.startsWith("FST_ERR_CTP")) {
      req.log.info({ oauthError: "invalid_request" }, "oauth_request_rejected");
      reply.code(400).send({ error: "invalid_request" });
      return;
    }
    // Nothing is said about what went wrong. The message is not ours to trust.
    req.log.error({ name: (err as any)?.name }, "oauth_internal_error");
    reply.code(500).send({ error: "internal_error" });
  });

  // OAuth token requests arrive form-encoded by convention. Parsing it here avoids a dependency,
  // and rejecting a repeated key is easier before the shape is flattened.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: MAX_TOKEN_BODY_BYTES },
    (_req, body, done) => {
      try {
        const params = new URLSearchParams(body as string);
        const out: Record<string, string | string[]> = {};
        for (const key of new Set(params.keys())) {
          const all = params.getAll(key);
          out[key] = all.length > 1 ? all : all[0];
        }
        done(null, out);
      } catch {
        done(new OAuthError("invalid_request", 400), undefined);
      }
    }
  );

  /**
   * Tells a client whether OAuth is available here and what it may send.
   *
   * Reachable before anyone holds a token, by necessity. It exposes the public client id, the
   * scopes and the redirect URIs - all of which the client would otherwise have to be configured
   * with by hand - and nothing about the upstream beyond that.
   */
  app.get("/auth/config", async (_req, reply) => {
    const { config } = resolveConfig();
    if (!config) {
      reply.send({ protocolVersion: PROTOCOL_VERSION, oauth: { enabled: false } });
      return;
    }
    reply.send({
      protocolVersion: PROTOCOL_VERSION,
      oauth: {
        enabled: true,
        grantTypes: ["authorization_code", "refresh_token"],
        clientId: config.clientId,
        scopes: config.scopes,
        redirectUris: config.redirectUris,
        codeChallengeMethods: ["S256"],
        // Built from the prefix this plugin was registered under. Hard-coding /auth would hand a
        // client the wrong paths on any deployment that mounts the proxy below the root, and the
        // client has no other way to find out.
        endpoints: {
          authorize: `${app.prefix}/auth/authorize`,
          token: `${app.prefix}/auth/token`,
          user: `${app.prefix}/auth/user`
        },
        // Said plainly because the opposite is the natural assumption: the proxy passes state
        // through untouched, and whoever terminates the callback is the one who can match it.
        stateVerifiedBy: "client",
        // One application serves every user of this deployment, so the client id identifies the
        // deployment, not the caller, and the scopes it may ever request are fixed at the GitLab
        // application rather than here.
        clientIsShared: true
      }
    });
  });

  /**
   * Starts the authorization by redirecting to GitLab.
   *
   * The upstream URL is built from named values, never from the query as received. That is the
   * difference between a redirect this proxy authored and one a caller dictated.
   */
  app.get("/auth/authorize", async (req, reply) => {
    const config = requireConfig();
    const rawQuery = req.raw.url?.split("?")[1] || "";
    if (Buffer.byteLength(rawQuery) > MAX_AUTHORIZE_QUERY_BYTES) {
      throw new OAuthError("invalid_request", 400);
    }
    const query = req.query as any;

    const redirectUri = requireAllowedRedirect(config, singleQuery(query, "redirect_uri"));
    const state = singleQuery(query, "state");
    if (!state || state.length < MIN_STATE_LENGTH) throw new OAuthError("invalid_request", 400);
    const challenge = singleQuery(query, "code_challenge");
    if (!challenge || !VERIFIER_PATTERN.test(challenge)) {
      throw new OAuthError("invalid_request", 400);
    }
    const method = singleQuery(query, "code_challenge_method");
    if (method !== undefined && method !== "S256") throw new OAuthError("invalid_request", 400);
    const scope = resolveScopes(config, singleQuery(query, "scope"));
    // response_type and client_id are not accepted from the caller at all. Taking them would let
    // a caller ask for an implicit grant, or point the consent screen at another application.
    const responseType = singleQuery(query, "response_type");
    if (responseType !== undefined && responseType !== "code") {
      throw new OAuthError("invalid_request", 400);
    }
    if (singleQuery(query, "client_id") !== undefined) throw new OAuthError("invalid_request", 400);

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      scope,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });
    reply.code(302).header("location", `${config.gitlabBaseUrl}/oauth/authorize?${params}`).send();
  });

  /** Exchanges a code, or refreshes. Both are rebuilt from named values and sent to GitLab. */
  app.post(
    "/auth/token",
    { bodyLimit: MAX_TOKEN_BODY_BYTES },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const config = requireConfig();
      if (rateLimited(rateKey(req), Date.now())) {
        reply.code(429).send({ error: "rate_limited" });
        return;
      }
      if (inFlightTokenRequests >= MAX_CONCURRENT_TOKEN_REQUESTS) {
        reply.code(503).send({ error: "busy" });
        return;
      }

      // Form encoding only. A JSON object cannot express a repeated key, so accepting JSON here
      // would mean the duplicate-parameter check silently does not apply to it.
      const contentType = String(req.headers["content-type"] || "");
      if (!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
        reply.code(415).send({ error: "unsupported_media_type" });
        return;
      }

      const body = req.body as any;
      const grantType = requireBody(body, "grant_type");
      if (singleBody(body, "client_id") !== undefined) throw new OAuthError("invalid_request", 400);

      let params: Record<string, string>;
      if (grantType === "authorization_code") {
        const verifier = requireBody(body, "code_verifier");
        if (!VERIFIER_PATTERN.test(verifier)) throw new OAuthError("invalid_request", 400);
        params = {
          grant_type: "authorization_code",
          client_id: config.clientId,
          code: requireBody(body, "code"),
          code_verifier: verifier,
          redirect_uri: requireAllowedRedirect(config, singleBody(body, "redirect_uri"))
        };
      } else if (grantType === "refresh_token") {
        // Deliberately not requiring the old access token: it may already have expired, which is
        // the normal reason to be here at all.
        params = {
          grant_type: "refresh_token",
          client_id: config.clientId,
          refresh_token: requireBody(body, "refresh_token")
        };
        const redirect = singleBody(body, "redirect_uri");
        if (redirect !== undefined) params.redirect_uri = requireAllowedRedirect(config, redirect);
      } else {
        throw new OAuthError("unsupported_grant_type", 400);
      }

      inFlightTokenRequests += 1;
      try {
        const document = await withDeadline(async (signal) => {
          const res = await postForm(`${config.gitlabBaseUrl}/oauth/token`, params, signal);
          const buffer = await readOAuthBody(res);
          if (res.statusCode < 200 || res.statusCode >= 300) throw tokenErrorFor(res.statusCode);
          return validateTokenDocument(parseOAuthJson(buffer));
        });
        reply.send(document);
      } finally {
        inFlightTokenRequests -= 1;
      }
    }
  );

  /**
   * Confirms who the caller is, using the same endpoint the PAT check uses.
   *
   * Not the personal-access-token self endpoint: that one describes a PAT and has nothing to say
   * about an OAuth grant. Only three fields come back, because the rest of a GitLab user document
   * is more than a package client needs to know.
   */
  app.get("/auth/user", async (req, reply) => {
    const config = requireConfig();
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || auth.length === 0) {
      reply.code(401).send({ error: "missing_token" });
      return;
    }
    const outcome = await withDeadline(async (signal) => {
      const res = await requestUpstream(`${config.gitlabBaseUrl}/api/v4/user`, {
        method: "GET",
        headers: { Authorization: auth, accept: "application/json" },
        signal,
        headersTimeout: UPSTREAM_TIMEOUT_MS,
        bodyTimeout: UPSTREAM_TIMEOUT_MS
      });
      const buffer = await readOAuthBody(res);
      return { status: res.statusCode as number, buffer };
    });
    if (outcome.status === 401 || outcome.status === 403) {
      reply.code(401).send({ error: "invalid_token" });
      return;
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      throw new OAuthError("upstream_failed", 502);
    }
    const doc = parseOAuthJson(outcome.buffer);
    if (!doc || typeof doc !== "object" || typeof doc.username !== "string") {
      throw new OAuthError("upstream_invalid_response", 502);
    }
    reply.send({
      id: typeof doc.id === "number" ? doc.id : undefined,
      username: doc.username,
      name: typeof doc.name === "string" ? doc.name : undefined
    });
  });
};

export default routes;
export { resolveConfig, validateTokenDocument, OAuthError };
