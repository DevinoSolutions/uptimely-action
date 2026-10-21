import { describe, expect, it } from "vitest";
import {
  check,
  createPreviewMonitor,
  defaultPreviewName,
  deleteMonitor,
  mute,
  normalizeUrl,
  OperationError,
  resolveMonitorSelection,
  unmute,
} from "../src/operations.js";
import { baseInputs, fakeUUID, json, M1, M2, M3, makeClient, makeLog, monitor, page, problem } from "./helpers.js";

const MUTE_RESPONSE = (call) =>
  json(200, { monitor_id: call.path.split("/")[3], alerts_muted_until: "2026-10-21T12:30:00.000Z" });
const UNMUTE_RESPONSE = (call) => json(200, { monitor_id: call.path.split("/")[3], alerts_muted_until: null });

function ctx(client, inputs, extra = {}) {
  const { log, lines } = makeLog();
  return { c: { client, inputs: baseInputs(inputs), log, randomUUID: fakeUUID, github: {}, ...extra }, lines };
}

const EXPORT = json(200, {
  version: 1,
  monitors: [
    { name: "API", monitor_type: "API", url: "https://api.example.com/health", labels: ["production"] },
    { name: "Marketing", monitor_type: "Website", url: "https://example.com", labels: ["marketing"] },
    { name: "Web", monitor_type: "Website", url: "https://app.example.com", labels: ["Production", "web"] },
  ],
});
const LIST = page([
  monitor(M1, "API", { monitor_type: "API" }),
  monitor(M2, "Marketing"),
  monitor(M3, "Web"),
]);

describe("selecting monitors for mute/unmute", () => {
  it("takes explicit ids without calling the API", async () => {
    const { client, calls } = makeClient({});
    await expect(resolveMonitorSelection(client, { monitorIds: [M1, M2], labels: [] })).resolves.toEqual([M1, M2]);
    expect(calls).toHaveLength(0);
  });

  it("refuses an id that is not a UUID (no path injection)", async () => {
    const { client } = makeClient({});
    await expect(resolveMonitorSelection(client, { monitorIds: ["../usage"], labels: [] })).rejects.toThrow(/not a monitor id/);
  });

  it("resolves labels (case-insensitive) by joining the export with the list", async () => {
    const { client } = makeClient({ "GET /v1/monitors/export": EXPORT, "GET /v1/monitors": LIST });
    const ids = await resolveMonitorSelection(client, { monitorIds: [M2], labels: ["production"] });
    expect(ids.sort()).toEqual([M1, M2, M3].sort());
  });

  it("refuses when a name+type pair is shared and only some copies carry the label", async () => {
    const { client } = makeClient({
      "GET /v1/monitors/export": json(200, {
        version: 1,
        monitors: [
          { name: "Web", monitor_type: "Website", labels: ["production"] },
          { name: "Web", monitor_type: "Website", labels: [] },
        ],
      }),
      "GET /v1/monitors": page([monitor(M1, "Web"), monitor(M2, "Web")]),
    });
    await expect(resolveMonitorSelection(client, { monitorIds: [], labels: ["production"] })).rejects.toThrow(/cannot be told apart/);
  });

  it("selects every copy when all copies of a shared name carry the label", async () => {
    const { client } = makeClient({
      "GET /v1/monitors/export": json(200, {
        version: 1,
        monitors: [
          { name: "Web", monitor_type: "Website", labels: ["production"] },
          { name: "Web", monitor_type: "Website", labels: ["production"] },
        ],
      }),
      "GET /v1/monitors": page([monitor(M1, "Web"), monitor(M2, "Web")]),
    });
    await expect(resolveMonitorSelection(client, { monitorIds: [], labels: ["production"] })).resolves.toEqual([M1, M2]);
  });
});

describe("mute", () => {
  it("mutes each monitor for mute-minutes with its own Idempotency-Key", async () => {
    const { client, calls } = makeClient({ [`POST /v1/monitors/${M1}/mute`]: MUTE_RESPONSE, [`POST /v1/monitors/${M2}/mute`]: MUTE_RESPONSE });
    const { c } = ctx(client, { monitorIds: [M1, M2], muteMinutes: 45 });
    const out = await mute(c);
    expect(out).toEqual({ "monitor-ids": `${M1},${M2}`, "muted-until": "2026-10-21T12:30:00.000Z" });
    expect(calls.map((x) => x.body)).toEqual([{ duration_minutes: 45 }, { duration_minutes: 45 }]);
    const keys = calls.map((x) => x.headers["Idempotency-Key"]);
    expect(new Set(keys).size).toBe(2);
  });

  it("mutes monitors selected by label", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors/export": EXPORT,
      "GET /v1/monitors": LIST,
      [`POST /v1/monitors/${M2}/mute`]: MUTE_RESPONSE,
    });
    const { c } = ctx(client, { labels: ["marketing"] });
    await expect(mute(c)).resolves.toMatchObject({ "monitor-ids": M2 });
    expect(calls.filter((x) => x.method === "POST")).toHaveLength(1);
  });

  it("fails when nothing is selected", async () => {
    const { client } = makeClient({ "GET /v1/monitors/export": EXPORT, "GET /v1/monitors": LIST });
    const { c } = ctx(client, { labels: ["nope"] });
    await expect(mute(c)).rejects.toThrow(/No monitors selected/);
  });

  it("keeps going after one failure, reports it, and still outputs what was muted", async () => {
    const { client } = makeClient({
      [`POST /v1/monitors/${M1}/mute`]: problem(403, "feature_not_enabled", "Writes are off"),
      [`POST /v1/monitors/${M2}/mute`]: MUTE_RESPONSE,
    });
    const { c } = ctx(client, { monitorIds: [M1, M2] });
    const err = await mute(c).catch((e) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect(err.message).toMatch(/1 of 2/);
    expect(err.message).toMatch(/Writes are off/);
    expect(err.outputs["monitor-ids"]).toBe(M2);
  });
});

describe("unmute", () => {
  it("unmutes each monitor with DELETE .../mute", async () => {
    const { client, calls } = makeClient({ [`DELETE /v1/monitors/${M1}/mute`]: UNMUTE_RESPONSE, [`DELETE /v1/monitors/${M2}/mute`]: UNMUTE_RESPONSE });
    const { c } = ctx(client, { monitorIds: [M1, M2] });
    await expect(unmute(c)).resolves.toEqual({ "monitor-ids": `${M1},${M2}` });
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([`DELETE /v1/monitors/${M1}/mute`, `DELETE /v1/monitors/${M2}/mute`]);
  });

  it("is a no-op with a warning when no selection is given (safe in if: always())", async () => {
    const { client, calls } = makeClient({});
    const { c, lines } = ctx(client, {});
    await expect(unmute(c)).resolves.toEqual({ "monitor-ids": "" });
    expect(calls).toHaveLength(0);
    expect(lines.warning[0]).toMatch(/nothing to unmute/);
  });

  it("treats a deleted monitor as a warning, not a failure", async () => {
    const { client } = makeClient({
      [`DELETE /v1/monitors/${M1}/mute`]: problem(404, "resource_not_found", "gone"),
      [`DELETE /v1/monitors/${M2}/mute`]: UNMUTE_RESPONSE,
    });
    const { c, lines } = ctx(client, { monitorIds: [M1, M2] });
    await expect(unmute(c)).resolves.toEqual({ "monitor-ids": M2 });
    expect(lines.warning[0]).toMatch(/no longer exists/);
  });

  it("retries a transient failure, attempts every monitor, then fails naming the rest", async () => {
    const { client, calls } = makeClient({
      [`DELETE /v1/monitors/${M1}/mute`]: problem(403, "insufficient_scope", "needs monitors:write"),
      [`DELETE /v1/monitors/${M2}/mute`]: [problem(503, "internal_error", "blip"), UNMUTE_RESPONSE],
    });
    const { c } = ctx(client, { monitorIds: [M1, M2] });
    const err = await unmute(c).catch((e) => e);
    expect(err.message).toMatch(/Could not unmute 1 of 2/);
    expect(err.message).toMatch(/stay muted until their mute window ends/);
    expect(err.outputs["monitor-ids"]).toBe(M2);
    expect(calls.filter((x) => x.path.includes(M2))).toHaveLength(2);
  });
});

describe("create-preview-monitor", () => {
  const github = { repository: "acme/web", prNumber: 42 };
  const URL1 = "https://web-git-feat-acme.vercel.app";

  it("creates a Website monitor named after the PR, with an Idempotency-Key", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": page([]),
      "GET /v1/monitors/export": json(200, { version: 1, monitors: [] }),
      "POST /v1/monitors": json(201, { id: M1, slug: "x", name: "acme/web PR #42 preview", monitor_type: "Website" }),
    });
    const { c } = ctx(client, { url: URL1, monitoringInterval: "* * * * *", failureThreshold: 1 }, { github });
    const out = await createPreviewMonitor(c);
    expect(out).toEqual({ "monitor-id": M1, "monitor-name": "acme/web PR #42 preview", created: "true", updated: "false" });
    const post = calls.find((x) => x.method === "POST");
    expect(post.body).toEqual({
      name: "acme/web PR #42 preview",
      monitor_type: "Website",
      url: URL1,
      description: "Preview monitor created by uptimely-action for acme/web PR #42.",
      monitoring_interval: "* * * * *",
      failure_threshold: 1,
    });
    expect(post.headers["Idempotency-Key"]).toBeTruthy();
  });

  it("reuses the monitor with the same name and type (idempotent re-run)", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": page([monitor(M1, "acme/web PR #42 preview")]),
      "GET /v1/monitors/export": json(200, { version: 1, monitors: [{ name: "acme/web PR #42 preview", monitor_type: "Website", url: `${URL1}/` }] }),
    });
    const { c } = ctx(client, { url: URL1 }, { github });
    await expect(createPreviewMonitor(c)).resolves.toEqual({
      "monitor-id": M1,
      "monitor-name": "acme/web PR #42 preview",
      created: "false",
      updated: "false",
    });
    expect(calls.some((x) => x.method !== "GET")).toBe(false);
  });

  it("points a reused monitor at the new preview URL when it changed", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": page([monitor(M1, "acme/web PR #42 preview")]),
      "GET /v1/monitors/export": json(200, { version: 1, monitors: [{ name: "acme/web PR #42 preview", monitor_type: "Website", url: "https://old.vercel.app" }] }),
      [`PATCH /v1/monitors/${M1}`]: json(200, monitor(M1, "acme/web PR #42 preview")),
    });
    const { c } = ctx(client, { url: URL1 }, { github });
    await expect(createPreviewMonitor(c)).resolves.toMatchObject({ created: "false", updated: "true" });
    expect(calls.find((x) => x.method === "PATCH").body).toEqual({ url: URL1 });
  });

  it("reuses a monitor that already watches the same URL under another name", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": page([monitor(M2, "Hand-made preview")]),
      "GET /v1/monitors/export": json(200, { version: 1, monitors: [{ name: "Hand-made preview", monitor_type: "Website", url: URL1 }] }),
    });
    const { c } = ctx(client, { url: URL1, name: "My preview" }, { github });
    await expect(createPreviewMonitor(c)).resolves.toEqual({
      "monitor-id": M2,
      "monitor-name": "Hand-made preview",
      created: "false",
      updated: "false",
    });
    expect(calls.some((x) => x.method === "POST")).toBe(false);
  });

  it("does not reuse a monitor of a different type", async () => {
    const { client } = makeClient({
      "GET /v1/monitors": page([monitor(M2, "x", { monitor_type: "API" })]),
      "GET /v1/monitors/export": json(200, { version: 1, monitors: [{ name: "x", monitor_type: "API", url: URL1 }] }),
      "POST /v1/monitors": json(201, { id: M1, slug: "s", name: "x", monitor_type: "Website" }),
    });
    const { c } = ctx(client, { url: URL1, name: "x" });
    await expect(createPreviewMonitor(c)).resolves.toMatchObject({ "monitor-id": M1, created: "true" });
  });

  it("refuses a bad URL, a non-HTTP monitor type, and duplicate names", async () => {
    const { client } = makeClient({
      "GET /v1/monitors": page([monitor(M1, "dup"), monitor(M2, "dup")]),
      "GET /v1/monitors/export": json(200, { version: 1, monitors: [] }),
    });
    await expect(createPreviewMonitor(ctx(client, {}).c)).rejects.toThrow(/needs the url/);
    await expect(createPreviewMonitor(ctx(client, { url: "ftp://x" }).c)).rejects.toThrow(/not an http/);
    await expect(createPreviewMonitor(ctx(client, { url: URL1, monitorType: "Ping" }).c)).rejects.toThrow(/Website" or "API/);
    await expect(createPreviewMonitor(ctx(client, { url: URL1, name: "dup" }).c)).rejects.toThrow(/2 Website monitors are named "dup"/);
  });

  it("surfaces the plan / write-gate refusal from the API", async () => {
    const { client } = makeClient({
      "GET /v1/monitors": page([]),
      "GET /v1/monitors/export": json(200, { version: 1, monitors: [] }),
      "POST /v1/monitors": problem(403, "feature_not_enabled", "Monitor limit reached for the Free plan"),
    });
    await expect(createPreviewMonitor(ctx(client, { url: URL1 }).c)).rejects.toThrow(/Monitor limit reached/);
  });
});

describe("delete-monitor", () => {
  it("deletes by id", async () => {
    const { client, calls } = makeClient({ [`DELETE /v1/monitors/${M1}`]: json(200, { id: M1, deleted: true }) });
    await expect(deleteMonitor(ctx(client, { monitorId: M1 }).c)).resolves.toEqual({ "monitor-id": M1, deleted: "true" });
    expect(calls).toHaveLength(1);
  });

  it("treats an already-deleted monitor as success with deleted=false", async () => {
    const { client } = makeClient({ [`DELETE /v1/monitors/${M1}`]: problem(404, "resource_not_found", "gone") });
    await expect(deleteMonitor(ctx(client, { monitorId: M1 }).c)).resolves.toEqual({ "monitor-id": M1, deleted: "false" });
  });

  it("finds the PR's preview monitor by its default name", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": page([monitor(M2, "acme/web PR #42 preview"), monitor(M3, "Other")]),
      [`DELETE /v1/monitors/${M2}`]: json(200, { id: M2, deleted: true }),
    });
    const { c } = ctx(client, {}, { github: { repository: "acme/web", prNumber: 42 } });
    await expect(deleteMonitor(c)).resolves.toEqual({ "monitor-id": M2, deleted: "true" });
    expect(calls.at(-1).path).toBe(`/v1/monitors/${M2}`);
  });

  it("is a no-op when no monitor has the name", async () => {
    const { client, calls } = makeClient({ "GET /v1/monitors": page([]) });
    await expect(deleteMonitor(ctx(client, { name: "gone" }).c)).resolves.toEqual({ "monitor-id": "", deleted: "false" });
    expect(calls.some((x) => x.method === "DELETE")).toBe(false);
  });

  it("refuses to guess between monitors sharing a name, and needs some selector", async () => {
    const { client } = makeClient({ "GET /v1/monitors": page([monitor(M1, "dup"), monitor(M2, "dup")]) });
    await expect(deleteMonitor(ctx(client, { name: "dup" }).c)).rejects.toThrow(/pass monitor-id/);
    await expect(deleteMonitor(ctx(client, {}).c)).rejects.toThrow(/needs monitor-id or name/);
  });

  it("surfaces a non-404 error", async () => {
    const { client } = makeClient({ [`DELETE /v1/monitors/${M1}`]: problem(403, "insufficient_scope", "needs monitors:write") });
    await expect(deleteMonitor(ctx(client, { monitorId: M1 }).c)).rejects.toThrow(/needs monitors:write/);
  });
});

describe("check", () => {
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms) => void (t += ms) };
  }

  it("passes as soon as the monitor is Operational", async () => {
    const { client, calls } = makeClient({ [`GET /v1/monitors/${M1}`]: json(200, monitor(M1, "Web")) });
    const { c } = ctx(client, { monitorId: M1 }, clock());
    await expect(check(c)).resolves.toEqual({ "monitor-id": M1, status: "Operational" });
    expect(calls).toHaveLength(1);
  });

  it("polls until the monitor recovers", async () => {
    const offline = json(200, monitor(M1, "Web", { status: { name: "Offline", color: null } }));
    const { client, calls } = makeClient({ [`GET /v1/monitors/${M1}`]: [offline, offline, json(200, monitor(M1, "Web"))] });
    const { c, lines } = ctx(client, { monitorId: M1, intervalSeconds: 10 }, clock());
    await expect(check(c)).resolves.toMatchObject({ status: "Operational" });
    expect(calls).toHaveLength(3);
    expect(lines.info.join("\n")).toMatch(/Offline[\s\S]*Operational/);
  });

  it("requires the status to stay up for stable-for-seconds", async () => {
    const up = json(200, monitor(M1, "Web"));
    const down = json(200, monitor(M1, "Web", { status: { name: "Offline", color: null } }));
    const { client, calls } = makeClient({ [`GET /v1/monitors/${M1}`]: [up, down, up, up, up, up] });
    const { c } = ctx(client, { monitorId: M1, intervalSeconds: 10, stableForSeconds: 30 }, clock());
    await expect(check(c)).resolves.toMatchObject({ status: "Operational" });
    // up(0) down(10) up(20) up(30) up(40) up(50): stable since t=20, passes at t=50.
    expect(calls).toHaveLength(6);
  });

  it("fails at the timeout with the last status", async () => {
    const { client } = makeClient({
      [`GET /v1/monitors/${M1}`]: json(200, monitor(M1, "Web", { status: { name: "Degraded", color: null } })),
    });
    const { c } = ctx(client, { monitorId: M1, timeoutSeconds: 60, intervalSeconds: 15 }, clock());
    const err = await check(c).catch((e) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect(err.message).toMatch(/within 60s; last status: Degraded/);
    expect(err.outputs).toEqual({ "monitor-id": M1, status: "Degraded" });
  });

  it("accepts custom up-statuses, case-insensitively", async () => {
    const { client } = makeClient({
      [`GET /v1/monitors/${M1}`]: json(200, monitor(M1, "Web", { status: { name: "Degraded", color: null } })),
    });
    const { c } = ctx(client, { monitorId: M1, upStatuses: ["operational", "degraded"] }, clock());
    await expect(check(c)).resolves.toMatchObject({ status: "Degraded" });
  });

  it("looks the monitor up by name", async () => {
    const { client } = makeClient({
      "GET /v1/monitors": page([monitor(M2, "Web")]),
      [`GET /v1/monitors/${M2}`]: json(200, monitor(M2, "Web")),
    });
    await expect(check(ctx(client, { name: "Web" }, clock()).c)).resolves.toMatchObject({ "monitor-id": M2 });
  });

  it("fails fast on an unknown monitor and an unknown name", async () => {
    const { client } = makeClient({
      [`GET /v1/monitors/${M1}`]: problem(404, "resource_not_found", "No such monitor"),
      "GET /v1/monitors": page([]),
    });
    await expect(check(ctx(client, { monitorId: M1 }, clock()).c)).rejects.toThrow(/does not exist/);
    await expect(check(ctx(client, { name: "nope" }, clock()).c)).rejects.toThrow(/No monitor named "nope"/);
    await expect(check(ctx(client, {}, clock()).c)).rejects.toThrow(/Set monitor-id or name/);
  });

  it("warns when the monitor's probing is switched off", async () => {
    const { client } = makeClient({
      [`GET /v1/monitors/${M1}`]: json(200, monitor(M1, "Web", { active_monitoring_disabled: true })),
    });
    const { c, lines } = ctx(client, { monitorId: M1 }, clock());
    await check(c);
    expect(lines.warning[0]).toMatch(/active monitoring switched off/);
  });
});

describe("helpers", () => {
  it("names preview monitors per PR, else per URL, within 100 characters", () => {
    expect(defaultPreviewName({ repository: "a/b", prNumber: 7 }, "https://x")).toBe("a/b PR #7 preview");
    expect(defaultPreviewName({}, "https://x.dev")).toBe("Preview: https://x.dev");
    expect(defaultPreviewName({}, `https://${"x".repeat(200)}.dev`)).toHaveLength(100);
    expect(defaultPreviewName({}, "")).toBe("");
  });

  it("compares URLs ignoring a trailing root slash and fragment", () => {
    expect(normalizeUrl("https://a.dev/")).toBe(normalizeUrl("https://a.dev"));
    expect(normalizeUrl("https://a.dev/x#y")).toBe("https://a.dev/x");
    expect(normalizeUrl("not a url ")).toBe("not a url");
  });
});
