import { request } from "undici";
import { positiveIntEnv } from "./env";

/**
 * Ceiling on how many bytes one upstream archive download may produce. The archive is buffered
 * in memory before conversion, and its size is chosen by whoever published the package, not by
 * this proxy - without a ceiling a single entry can exhaust the process. 512 MiB is far above
 * any real Unity package and still bounded.
 */
function maxDownloadBytes(): number {
  return positiveIntEnv("VPM_MAX_DOWNLOAD_BYTES", 512 * 1024 * 1024);
}

/**
 * Ceiling on any other upstream body this proxy buffers whole: the npm passthrough relays and the
 * metadata enrichment download. Those are archives published by whoever owns the package too, and
 * they were read into memory with no bound at all. Separate from the VPM ceiling because the two
 * are configured for different traffic, and because changing what an existing VPM_* variable
 * governs would be a silent semantic change.
 */
function maxUpstreamBodyBytes(): number {
  return positiveIntEnv("MAX_UPSTREAM_BODY_BYTES", 512 * 1024 * 1024);
}

/**
 * Reads an undici response body into memory, refusing to buffer more than `limit` bytes. A
 * declared Content-Length over the ceiling is rejected before a byte is read, and the running
 * total is checked as the body arrives so a missing or understated one cannot get past it.
 */
export async function readBodyWithLimit(
  res: { headers: Record<string, unknown>; body: any },
  limit: number,
  errorPrefix: string
): Promise<Buffer> {
  const declared = Number(res.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    await res.body.dump();
    throw new Error(`${errorPrefix}:${declared}`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limit) {
      res.body.destroy();
      throw new Error(`${errorPrefix}:${total}`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

/** Buffers an upstream body under the shared ceiling, for callers that already have a response. */
export async function readUpstreamBody(res: {
  headers: Record<string, unknown>;
  body: any;
}): Promise<Buffer> {
  return readBodyWithLimit(res, maxUpstreamBodyBytes(), "upstream_body_too_large");
}

/** Reads the limit once so a malformed value stops the process at startup. */
export function validateUpstreamBodyLimit(): void {
  maxUpstreamBodyBytes();
}

/**
 * Reads the limit once so a malformed value stops the process at startup. The limit is otherwise
 * only read when an archive is actually downloaded, which meant a typo surfaced as a failed
 * download hours later - and an operator could not read a successful start as evidence that the
 * setting was understood.
 */
export function validateDownloadLimits(): void {
  maxDownloadBytes();
}

/**
 * Request headers that narrow what the upstream sends back. The proxy forwards the caller's
 * headers so a conditional GET or a Range request works end to end on the resource the caller
 * actually asked for - but when the proxy fetches something else on their behalf (an archive it
 * is going to cache, a VPM index it is going to derive a package document from), the caller's
 * validators belong to a different representation and would only truncate the answer.
 */
const RESPONSE_NARROWING_HEADERS = [
  "range",
  "if-range",
  "if-none-match",
  "if-modified-since",
  "if-match",
  "if-unmodified-since"
];

export function withoutResponseNarrowing(headers: Record<string, string>): Record<string, string> {
  const out = { ...headers };
  for (const name of Object.keys(out)) {
    if (RESPONSE_NARROWING_HEADERS.includes(name.toLowerCase())) delete out[name];
  }
  return out;
}

/**
 * Credentials belong to the upstream the caller authenticated against, and to nobody else. A
 * VPM package's dist.original points at whatever host the VPM index names (a release asset host,
 * a CDN, an arbitrary third party), so the caller's PAT must not ride along on that download -
 * nor on a redirect that leaves the origin we started from.
 */
export function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  const stripped = { ...headers };
  delete stripped["Authorization"];
  delete stripped["PRIVATE-TOKEN"];
  // The request's headers are copied verbatim, so a session cookie rides along unless it is
  // removed here too. It identifies the caller just as much as the PAT does, and has no
  // business reaching a host outside the upstream we authenticated to.
  for (const name of Object.keys(stripped)) {
    if (name.toLowerCase() === "cookie") delete stripped[name];
  }
  return stripped;
}

export function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Fetches a JSON document, following redirects up to a bounded number of hops and dropping the
 * caller's credentials as soon as the chain leaves the origin it started from.
 *
 * undici does not follow redirects on its own, so without this a registry that answers its index
 * URL with a 301 got its redirect body parsed as JSON. Response-narrowing headers are removed
 * before the first hop: the document fetched here is not the one the caller asked for, so their
 * validators would only produce a 304 with a body that cannot be parsed.
 *
 * `errorPrefix` names the failing fetch in the thrown error, so callers keep the error strings
 * they already log and test against.
 */
export async function fetchJsonWithRedirects<T>(
  url: string,
  headers: Record<string, string>,
  errorPrefix: string,
  maxRedirects = 5
): Promise<T> {
  let current = url;
  let currentHeaders = withoutResponseNarrowing(headers);
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await request(current, { method: "GET", headers: currentHeaders });
    const status = res.statusCode;
    if (status >= 300 && status < 400 && res.headers.location && i < maxRedirects) {
      // Released before the Location is parsed: a malformed one makes the URL constructor
      // throw, and doing this afterwards would leave the body unread on exactly the path where
      // the request is abandoned.
      await res.body.dump();
      const next = new URL(String(res.headers.location), current).toString();
      if (!isSameOrigin(next, url)) {
        currentHeaders = withoutCredentials(currentHeaders);
      }
      current = next;
      continue;
    }
    if (status < 200 || status >= 300 || status === 204 || status === 205) {
      // Anything that is not a plain successful response carries no document to parse - an
      // unfollowed redirect included, which is what a chain longer than maxRedirects ends on.
      await res.body.dump();
      throw new Error(`${errorPrefix}:${status}`);
    }
    return (await res.body.json()) as T;
  }
  throw new Error(`${errorPrefix}_redirects_exceeded`);
}

/**
 * Downloads a binary body, following redirects up to a bounded number of hops, dropping the
 * caller's authorization as soon as the chain leaves the origin it started from, and refusing to
 * buffer more than the configured ceiling.
 *
 * The size limit matters because the body is an archive published by whoever owns the package,
 * not by this proxy: it is read fully into memory and then expanded onto the cache filesystem.
 * A declared Content-Length over the ceiling is rejected before a single byte is read, and the
 * running total is checked as the body streams in so a missing or lying Content-Length cannot
 * get past it.
 */
export async function fetchBufferWithRedirects(
  url: string,
  headers: Record<string, string> = {},
  maxRedirects = 5
): Promise<Buffer> {
  const limit = maxDownloadBytes();
  let current = url;
  let currentHeaders = headers;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await request(current, { method: "GET", headers: currentHeaders });
    const status = res.statusCode;
    if (status >= 300 && status < 400 && res.headers.location && i < maxRedirects) {
      // Released before the Location is parsed: a malformed one makes the URL constructor
      // throw, and doing this afterwards would leave the body unread on exactly the path where
      // the request is abandoned.
      await res.body.dump();
      const next = new URL(String(res.headers.location), current).toString();
      // Follow-the-credentials is how tokens end up in someone else's logs: once the redirect
      // chain leaves the origin we were authorized for, drop them for good.
      if (!isSameOrigin(next, url)) {
        currentHeaders = withoutCredentials(currentHeaders);
      }
      current = next;
      continue;
    }
    if (status >= 400) {
      await res.body.dump();
      throw new Error(`zip_download_failed:${status}`);
    }
    return readBodyWithLimit(res as any, limit, "zip_download_too_large");
  }
  throw new Error("zip_download_redirects_exceeded");
}
