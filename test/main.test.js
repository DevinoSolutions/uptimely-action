import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseBoolInput, parseIntInput, parseList, readGithubContext, run } from "../src/main.js";
import { json, KEY, M1, M2, mockFetch, monitor, page, problem } from "./helpers.js";

function fakeCore(inputs) {
  const state = { secrets: [], outputs: {}, failed: null, info: [], warning: [], order: [] };
  const core = {
    getInput(name, opts) {
      const v = inputs[name] ?? "";
      if (opts?.required && !v) throw new Error(`Input required and not supplied: ${name}`);
      return v;
    },
    setSecret: (s) => {
      state.order.push("setSecret");
      state.secrets.push(s);
    },
    setOutput: (k, v) => (state.outputs[k] = v),
    setFailed: (m) => (state.failed = m),
    info: (m) => state.info.push(m),
    warning: (m) => state.warning.push(m),
    debug: () => {},
  };
  return { core, state };
}

const tmp = mkdtempSync(join(tmpdir(), "uptimely-action-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("run()", () => {
  it("masks the API key before making any request", async () => {
    const { core, state } = fakeCore({
      operation: "check",
      "api-key": ` ${KEY} `,
      "monitor-id": M1,
      "wait-for-new-check": "false",
    });
    const { fetchImpl, calls } = mockFetch({ [`GET /v1/monitors/${M1}`]: json(200, monitor(M1, "Web")) });
    const wrapped = async (...a) => {
      state.order.push("fetch");
      return fetchImpl(...a);
    };
    await run({ core, fetchImpl: wrapped, sleep: async () => {}, env: {} });
    expect(state.secrets).toEqual([KEY]);
    expect(state.order[0]).toBe("setSecret");
    expect(calls[0].headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(state.failed).toBeNull();
    expect(state.outputs).toEqual({ "monitor-id": M1, status: "Operational" });
  });

  it("fails on an unknown operation and lists the valid ones", async () => {
    const { core, state } = fakeCore({ operation: "pause", "api-key": KEY });
    await run({ core, fetchImpl: async () => new Response("{}"), env: {} });
    expect(state.failed).toMatch(/Unknown operation "pause".*mute, unmute, create-preview-monitor, delete-monitor, check/);
  });

  it("fails clearly when the API key is missing", async () => {
    const { core, state } = fakeCore({ operation: "check" });
    await run({ core, env: {} });
    expect(state.failed).toMatch(/api-key/);
  });

  it("fails on a malformed number input", async () => {
    const { core, state } = fakeCore({ operation: "mute", "api-key": KEY, "monitor-ids": M1, "mute-minutes": "soon" });
    await run({ core, env: {} });
    expect(state.failed).toMatch(/mute-minutes must be a whole number/);
  });

  it("sets partial outputs before failing, so an if: always() step can use them", async () => {
    const { core, state } = fakeCore({ operation: "mute", "api-key": KEY, "monitor-ids": `${M1}\n${M2}` });
    const { fetchImpl } = mockFetch({
      [`POST /v1/monitors/${M1}/mute`]: json(200, { monitor_id: M1, alerts_muted_until: "2026-10-21T12:00:00.000Z" }),
      [`POST /v1/monitors/${M2}/mute`]: problem(403, "insufficient_scope", "needs monitors:write"),
    });
    await run({ core, fetchImpl, sleep: async () => {}, env: {} });
    expect(state.outputs["monitor-ids"]).toBe(M1);
    expect(state.failed).toMatch(/Could not mute 1 of 2/);
  });

  it("reports an API error (e.g. a 401) as a failed step without leaking the key", async () => {
    const { core, state } = fakeCore({ operation: "delete-monitor", "api-key": KEY, "monitor-id": M1 });
    const { fetchImpl } = mockFetch({ [`DELETE /v1/monitors/${M1}`]: problem(401, "invalid_api_key", "The bearer credential could not be verified.") });
    await run({ core, fetchImpl, sleep: async () => {}, env: {} });
    expect(state.failed).toMatch(/401/);
    expect(state.failed).not.toContain(KEY);
  });

  it("uses the pull request from the event payload for the default preview name", async () => {
    const eventPath = join(tmp, "event.json");
    writeFileSync(eventPath, JSON.stringify({ action: "closed", pull_request: { number: 9 } }));
    const { core, state } = fakeCore({ operation: "delete-monitor", "api-key": KEY });
    const { fetchImpl } = mockFetch({
      "GET /v1/monitors": page([monitor(M1, "acme/site PR #9 preview", { description: "x [uptimely-action:acme/site#9]" })]),
      [`DELETE /v1/monitors/${M1}`]: json(200, { id: M1, deleted: true }),
    });
    await run({ core, fetchImpl, env: { GITHUB_REPOSITORY: "acme/site", GITHUB_EVENT_PATH: eventPath } });
    expect(state.failed).toBeNull();
    expect(state.outputs).toEqual({ "monitor-id": M1, "monitor-ids": M1, deleted: "true" });
  });

  it("with fail-on-error false, an unmute that still fails after retries warns instead of failing", async () => {
    const { core, state } = fakeCore({ operation: "unmute", "api-key": KEY, "monitor-ids": M1, "fail-on-error": "false" });
    const { fetchImpl, calls } = mockFetch({ [`DELETE /v1/monitors/${M1}/mute`]: problem(503, "internal_error", "down for maintenance") });
    await run({ core, fetchImpl, sleep: async () => {}, env: {} });
    expect(calls).toHaveLength(5); // first try + 4 retries
    expect(state.failed).toBeNull();
    expect(state.warning.at(-1)).toMatch(/Could not unmute 1 of 1[\s\S]*fail-on-error is false/);
    expect(state.outputs).toEqual({ "monitor-ids": "" });
  });

  it("fails the step on the same error by default", async () => {
    const { core, state } = fakeCore({ operation: "unmute", "api-key": KEY, "monitor-ids": M1 });
    const { fetchImpl } = mockFetch({ [`DELETE /v1/monitors/${M1}/mute`]: problem(403, "feature_not_enabled", "Writes are off") });
    await run({ core, fetchImpl, sleep: async () => {}, env: {} });
    expect(state.failed).toMatch(/Writes are off/);
  });

  it("rejects a fail-on-error value that is not true or false", async () => {
    const { core, state } = fakeCore({ operation: "unmute", "api-key": KEY, "fail-on-error": "maybe" });
    await run({ core, env: {} });
    expect(state.failed).toMatch(/fail-on-error must be true or false/);
  });
});

describe("input parsing", () => {
  it("splits lists on commas and newlines", () => {
    expect(parseList(" a, b\nc ,,\n")).toEqual(["a", "b", "c"]);
    expect(parseList(undefined)).toEqual([]);
  });

  it("parses bounded integers with a fallback", () => {
    expect(parseIntInput("x", "", { min: 1, max: 5, fallback: 3 })).toBe(3);
    expect(parseIntInput("x", "4", { min: 1, max: 5 })).toBe(4);
    expect(() => parseIntInput("x", "9", { min: 1, max: 5 })).toThrow(/between 1 and 5/);
    expect(() => parseIntInput("x", "1.5", { min: 1, max: 5 })).toThrow(/whole number/);
  });

  it("parses booleans with a fallback", () => {
    expect(parseBoolInput("x", "", true)).toBe(true);
    expect(parseBoolInput("x", " FALSE ", true)).toBe(false);
    expect(parseBoolInput("x", "true", false)).toBe(true);
    expect(() => parseBoolInput("x", "yes", true)).toThrow(/true or false/);
  });

  it("reads the repository and PR number, tolerating a missing event file", () => {
    expect(readGithubContext({ GITHUB_REPOSITORY: "a/b", GITHUB_EVENT_PATH: join(tmp, "missing.json") })).toEqual({
      repository: "a/b",
      prNumber: undefined,
    });
    const p = join(tmp, "issue.json");
    writeFileSync(p, JSON.stringify({ issue: { number: 3, pull_request: {} } }));
    expect(readGithubContext({ GITHUB_REPOSITORY: "a/b", GITHUB_EVENT_PATH: p }).prNumber).toBe(3);
  });
});
