/**
 * A small client for Uptimely's public /v1 REST API.
 *
 * Auth is sent exactly as Uptimely's Zapier app sends it:
 * `Authorization: Bearer uptimely_live_…` plus `Accept: application/json`.
 * /v1 only accepts project API keys (OAuth tokens are refused with 403
 * `unsupported_credential_type`), and every resource is scoped to the project
 * the key belongs to, so there is no project parameter anywhere.
 *
 * Errors are RFC 9457 problem documents: `{ code, title, detail, request_id,
 * errors: [{ pointer, message }] }`.
 *
 * Retries: only for calls that are safe to repeat (GET, DELETE, a PATCH that
 * sets absolute values, and a POST that carries an Idempotency-Key). Retried
 * on network errors, 5xx, a burst 429 (`rate_limited`) and a 409
 * `idempotency_in_progress`. A 429 `quota_exhausted` is NOT retried: the
 * monthly allowance does not come back within a CI job.
 */

export const DEFAULT_API_URL = "https://app.getuptimely.com";
export const USER_AGENT = "uptimely-action/1.0.0 (+https://github.com/DevinoSolutions/uptimely-action)";

/** Hard ceiling on pages read by a full-list scan (100 items each). */
export const MAX_LIST_PAGES = 20;

/** Longest single wait we accept from a Retry-After header. */
const MAX_RETRY_AFTER_SECONDS = 60;
const REQUEST_TIMEOUT_MS = 30_000;

export class UptimelyApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, requestId?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "UptimelyApiError";
    this.status = details.status;
    this.code = details.code;
    this.requestId = details.requestId;
  }
}

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

function parseProblem(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function hint(status, code) {
  if (status === 401) {
    return " Check the api-key input: it must be an Uptimely project API key (uptimely_live_…) from Settings → API Keys.";
  }
  if (code === "insufficient_scope") {
    return " Give the API key the scopes this operation needs (see the README).";
  }
  if (code === "feature_not_enabled") {
    return " Writes need the Pro plan and the project's \"Allow AI write operations\" switch (Settings → API Keys).";
  }
  if (code === "quota_exhausted") {
    return " The project's monthly API allowance is used up.";
  }
  return "";
}

function problemMessage(method, path, status, problem) {
  const headline = problem.detail ?? problem.title ?? `HTTP ${status}`;
  const fieldErrors = Array.isArray(problem.errors)
    ? problem.errors
        .map((e) => [e?.pointer, e?.message].filter(Boolean).join(": "))
        .filter(Boolean)
    : [];
  const parts = [`Uptimely ${method} ${path} failed (${status}${problem.code ? ` ${problem.code}` : ""}): ${headline}`, ...fieldErrors];
  if (problem.request_id) parts.push(`(request id ${problem.request_id})`);
  return parts.join(" ") + hint(status, problem.code);
}

/** Seconds from a Retry-After header (delta-seconds or HTTP date), or undefined. */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, (date - nowMs) / 1000);
  return undefined;
}

/**
 * @param {{
 *   apiKey: string,
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   maxRetries?: number,
 *   baseDelayMs?: number,
 *   log?: { debug?: (m: string) => void, warning?: (m: string) => void },
 * }} options
 */
export function createClient(options) {
  const {
    apiKey,
    baseUrl = DEFAULT_API_URL,
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxRetries = 4,
    baseDelayMs = 1000,
    log = {},
  } = options;

  if (!apiKey) throw new Error("The api-key input is required.");
  const root = normalizeBaseUrl(baseUrl);

  function backoffMs(attempt, retryAfterSeconds) {
    if (retryAfterSeconds !== undefined) return Math.ceil(retryAfterSeconds * 1000);
    const exp = baseDelayMs * 2 ** attempt;
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }

  /**
   * @param {"GET"|"POST"|"PATCH"|"DELETE"} method
   * @param {string} path
   * @param {{ query?: Record<string, string|number|undefined>, body?: unknown, idempotencyKey?: string, retry?: boolean }} [opts]
   * @returns {Promise<any>}
   */
  async function request(method, path, opts = {}) {
    const { query, body, idempotencyKey } = opts;
    const retry =
      opts.retry ?? (method === "GET" || method === "DELETE" || (method === "POST" && Boolean(idempotencyKey)));

    const url = new URL(root + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    for (let attempt = 0; ; attempt += 1) {
      const canRetry = retry && attempt < maxRetries;
      let response;
      try {
        response = await fetchImpl(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (!canRetry) {
          throw new UptimelyApiError(`Uptimely ${method} ${path} failed: network error: ${reason}`);
        }
        const wait = backoffMs(attempt);
        log.warning?.(`Uptimely ${method} ${path}: network error (${reason}); retrying in ${Math.round(wait / 1000)}s.`);
        await sleep(wait);
        continue;
      }

      const text = await response.text();
      if (response.ok) {
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new UptimelyApiError(`Uptimely ${method} ${path} returned a body that is not JSON.`, {
            status: response.status,
          });
        }
      }

      const problem = parseProblem(text);
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      const transient =
        RETRYABLE_STATUSES.has(response.status) ||
        (response.status === 429 && problem.code !== "quota_exhausted") ||
        (response.status === 409 && problem.code === "idempotency_in_progress" && Boolean(idempotencyKey));
      const waitTooLong = retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_SECONDS;

      if (transient && canRetry && !waitTooLong) {
        const wait = backoffMs(attempt, retryAfter);
        log.warning?.(
          `Uptimely ${method} ${path} answered ${response.status}${problem.code ? ` ${problem.code}` : ""}; retrying in ${Math.max(1, Math.round(wait / 1000))}s (attempt ${attempt + 2} of ${maxRetries + 1}).`,
        );
        await sleep(wait);
        continue;
      }

      throw new UptimelyApiError(problemMessage(method, path, response.status, problem), {
        status: response.status,
        code: problem.code,
        requestId: problem.request_id,
      });
    }
  }

  /** Reads every page of a cursor-paginated /v1 list endpoint. */
  async function listAll(path) {
    const items = [];
    let after;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const res = await request("GET", path, { query: { limit: 100, after } });
      items.push(...(res?.data ?? []));
      if (!res?.has_more || !res.next_cursor) return items;
      after = res.next_cursor;
    }
    throw new UptimelyApiError(
      `More than ${MAX_LIST_PAGES * 100} items are listed at ${path}; this action reads at most ${MAX_LIST_PAGES * 100}.`,
    );
  }

  return { request, listAll, baseUrl: root };
}

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`api-url is not a valid URL: ${value}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("api-url must use https (the API key travels in a header).");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}
