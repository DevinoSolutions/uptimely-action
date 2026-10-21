import { describe, expect, it } from "vitest";
import { createClient, normalizeBaseUrl, parseRetryAfter, UptimelyApiError, MAX_LIST_PAGES } from "../src/client.js";
import { KEY, json, makeClient, mockFetch, page, problem, monitor, M1 } from "./helpers.js";

describe("the API client", () => {
  it("sends the project API key as a Bearer token, like the Zapier app", async () => {
    const { client, calls } = makeClient({ "GET /v1/usage": json(200, { plan: "PRO" }) });
    await client.request("GET", "/v1/usage");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(calls[0].headers.Accept).toBe("application/json");
    expect(calls[0].headers["User-Agent"]).toMatch(/^uptimely-action\//);
  });

  it("talks to app.getuptimely.com by default", async () => {
    let seen;
    const client = createClient({
      apiKey: KEY,
      fetchImpl: async (url) => {
        seen = String(url);
        return new Response("{}", { status: 200 });
      },
    });
    await client.request("GET", "/v1/usage");
    expect(seen).toBe("https://app.getuptimely.com/v1/usage");
  });

  it("refuses a missing key and a non-https api-url", () => {
    expect(() => createClient({ apiKey: "" })).toThrow(/api-key/);
    expect(() => normalizeBaseUrl("http://example.com")).toThrow(/https/);
    expect(() => normalizeBaseUrl("not a url")).toThrow(/valid URL/);
    expect(normalizeBaseUrl("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normalizeBaseUrl("https://api.example.com/base/")).toBe("https://api.example.com/base");
  });

  it("retries a GET on 503 with backoff, then succeeds", async () => {
    const { client, calls, sleeps } = makeClient({
      "GET /v1/usage": [problem(503, "internal_error", "down"), problem(502, "internal_error", "down"), json(200, { plan: "PRO" })],
    });
    await expect(client.request("GET", "/v1/usage")).resolves.toEqual({ plan: "PRO" });
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("gives up after maxRetries and reports the problem detail and request id", async () => {
    const { client, calls } = makeClient({ "GET /v1/usage": problem(500, "internal_error", "boom") });
    const err = await client.request("GET", "/v1/usage").catch((e) => e);
    expect(err).toBeInstanceOf(UptimelyApiError);
    expect(err.status).toBe(500);
    expect(err.message).toContain("boom");
    expect(err.message).toContain("req_123");
    expect(calls).toHaveLength(5);
  });

  it("does not retry a POST without an Idempotency-Key", async () => {
    const { client, calls } = makeClient({ "POST /v1/monitors": problem(503, "internal_error", "down") });
    await expect(client.request("POST", "/v1/monitors", { body: {} })).rejects.toThrow(/503/);
    expect(calls).toHaveLength(1);
  });

  it("retries a POST that carries an Idempotency-Key, re-sending the same key", async () => {
    const { client, calls } = makeClient({
      "POST /v1/monitors": [problem(503, "internal_error", "down"), json(201, { id: M1 })],
    });
    await client.request("POST", "/v1/monitors", { body: { name: "x" }, idempotencyKey: "k-1" });
    expect(calls.map((c) => c.headers["Idempotency-Key"])).toEqual(["k-1", "k-1"]);
  });

  it("retries 409 idempotency_in_progress only for keyed requests", async () => {
    const { client, calls } = makeClient({
      "POST /v1/monitors": [problem(409, "idempotency_in_progress", "still running"), json(201, { id: M1 })],
    });
    await expect(client.request("POST", "/v1/monitors", { body: {}, idempotencyKey: "k" })).resolves.toEqual({ id: M1 });
    expect(calls).toHaveLength(2);
  });

  it("honours Retry-After on a burst 429", async () => {
    const { client, sleeps } = makeClient({
      "GET /v1/usage": [problem(429, "rate_limited", "slow down", { "retry-after": "7" }), json(200, {})],
    });
    await client.request("GET", "/v1/usage");
    expect(sleeps).toEqual([7000]);
  });

  it("does not retry 429 quota_exhausted, and says why", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": problem(429, "quota_exhausted", "Monthly allowance used", { "retry-after": "86400" }),
    });
    const err = await client.request("GET", "/v1/monitors").catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err.code).toBe("quota_exhausted");
    expect(err.message).toMatch(/monthly API allowance/);
  });

  it("does not wait out a Retry-After longer than a minute", async () => {
    const { client, calls } = makeClient({ "GET /v1/usage": problem(429, "rate_limited", "x", { "retry-after": "600" }) });
    await expect(client.request("GET", "/v1/usage")).rejects.toThrow(/429/);
    expect(calls).toHaveLength(1);
  });

  it("retries network errors on idempotent calls", async () => {
    const { client, calls } = makeClient({ "GET /v1/usage": [new TypeError("fetch failed"), json(200, { ok: 1 })] });
    await expect(client.request("GET", "/v1/usage")).resolves.toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it("does not retry 4xx client errors", async () => {
    const { client, calls } = makeClient({ "GET /v1/monitors/x": problem(404, "resource_not_found", "No such monitor") });
    const err = await client.request("GET", "/v1/monitors/x").catch((e) => e);
    expect(err.status).toBe(404);
    expect(calls).toHaveLength(1);
  });

  it("adds actionable hints for 401, missing scope and the write gate", async () => {
    const { client } = makeClient({
      "GET /a": problem(401, "invalid_api_key", "bad key"),
      "GET /b": problem(403, "insufficient_scope", "needs monitors:write"),
      "GET /c": problem(403, "feature_not_enabled", "writes off"),
    });
    await expect(client.request("GET", "/a")).rejects.toThrow(/uptimely_live_/);
    await expect(client.request("GET", "/b")).rejects.toThrow(/scopes/);
    await expect(client.request("GET", "/c")).rejects.toThrow(/Allow AI write operations/);
  });

  it("never puts the API key in an error message", async () => {
    const { client } = makeClient({ "GET /v1/usage": problem(401, "invalid_api_key", "bad") });
    const err = await client.request("GET", "/v1/usage").catch((e) => e);
    expect(err.message).not.toContain(KEY);
  });

  it("includes field errors from a validation problem", async () => {
    const { client } = makeClient({
      "POST /v1/monitors": json(400, { code: "validation_failed", detail: "Invalid body", errors: [{ pointer: "/url", message: "Invalid URL" }] }),
    });
    await expect(client.request("POST", "/v1/monitors", { body: {} })).rejects.toThrow("/url: Invalid URL");
  });

  it("handles a non-JSON error body", async () => {
    const { fetchImpl } = mockFetch({});
    const client = createClient({
      apiKey: KEY,
      fetchImpl: async () => new Response("<html>bad gateway</html>", { status: 400 }),
    });
    await expect(client.request("GET", "/v1/usage")).rejects.toThrow(/HTTP 400/);
    expect(fetchImpl).toBeTypeOf("function");
  });

  it("reads every page of a cursor-paginated list", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": (call) =>
        call.query.after === "c2" ? page([monitor("b", "B")]) : page([monitor("a", "A")], "c2"),
    });
    const all = await client.listAll("/v1/monitors");
    expect(all.map((m) => m.id)).toEqual(["a", "b"]);
    expect(calls[0].query).toEqual({ limit: "100" });
    expect(calls[1].query).toEqual({ limit: "100", after: "c2" });
  });

  it("refuses to read an unbounded list", async () => {
    const { client, calls } = makeClient({ "GET /v1/monitors": page([monitor("a", "A")], "more") });
    await expect(client.listAll("/v1/monitors")).rejects.toThrow(/at most/);
    expect(calls).toHaveLength(MAX_LIST_PAGES);
  });

  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 0)).toBe(10);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
