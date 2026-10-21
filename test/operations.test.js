import { describe, expect, it } from "vitest";
import {
  check,
  createIdempotencyKey,
  createPreviewMonitor,
  defaultPreviewName,
  deleteMonitor,
  mute,
  normalizeUrl,
  OperationError,
  ownershipMarker,
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
  const NAME = "acme/web PR #42 preview";
  const MARK = "[uptimely-action:acme/web#42]";
  const OWNED = `Preview monitor created by uptimely-action for acme/web PR #42. ${MARK}`;
  const URL1 = "https://web-git-feat-acme.vercel.app";
  const owned = (id, extra = {}) => monitor(id, NAME, { description: OWNED, ...extra });
  const exportOf = (...entries) => json(200, { version: 1, monitors: entries });
  const entry = (url, extra = {}) => ({ name: NAME, monitor_type: "Website", description: OWNED, url, ...extra });

  it("creates a Website monitor named after the PR, stamped with the ownership marker", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": [page([]), page([owned(M1)])],
      "GET /v1/monitors/export": exportOf(),
      "POST /v1/monitors": json(201, { id: M1, slug: "x", name: NAME, monitor_type: "Website" }),
    });
    const { c } = ctx(client, { url: URL1, monitoringInterval: "* * * * *", failureThreshold: 1 }, { github });
    const out = await createPreviewMonitor(c);
    expect(out).toEqual({ "monitor-id": M1, "monitor-name": NAME, created: "true", updated: "false" });
    const post = calls.find((x) => x.method === "POST");
    expect(post.body).toEqual({
      name: NAME,
      monitor_type: "Website",
      url: URL1,
      description: OWNED,
      monitoring_interval: "* * * * *",
      failure_threshold: 1,
    });
  });

  it("appends the marker to a custom description and keeps it within 500 characters", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": [page([]), (call) => page([monitor(M1, NAME, { description: calls.find((x) => x.method === "POST").body.description })])],
      "GET /v1/monitors/export": exportOf(),
      "POST /v1/monitors": json(201, { id: M1, slug: "x", name: NAME, monitor_type: "Website" }),
    });
    await createPreviewMonitor(ctx(client, { url: URL1, description: "d".repeat(600) }, { github }).c);
    const description = calls.find((x) => x.method === "POST").body.description;
    expect(description).toHaveLength(500);
    expect(description.endsWith(` ${MARK}`)).toBe(true);
  });

  it("derives the Idempotency-Key from repo, PR and request, so concurrent runs send the same key", async () => {
    const keys = [];
    for (let run = 0; run < 2; run += 1) {
      const { client, calls } = makeClient({
        "GET /v1/monitors": [page([]), page([owned(M1)])],
        "GET /v1/monitors/export": exportOf(),
        "POST /v1/monitors": json(201, { id: M1, slug: "x", name: NAME, monitor_type: "Website" }),
      });
      await createPreviewMonitor(ctx(client, { url: URL1 }, { github }).c);
      keys.push(calls.find((x) => x.method === "POST").headers["Idempotency-Key"]);
    }
    expect(keys[0]).toMatch(/^uptimely-action-[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    const body = { name: NAME, monitor_type: "Website", url: URL1, description: OWNED };
    expect(createIdempotencyKey(github, body)).toBe(keys[0]);
    expect(createIdempotencyKey({ ...github, prNumber: 43 }, body)).not.toBe(keys[0]);
    expect(createIdempotencyKey(github, { ...body, url: "https://other.app" })).not.toBe(keys[0]);
  });

  it("collapses a concurrent create: retries the 409 in-progress and gets the same monitor", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": [page([]), page([owned(M1)])],
      "GET /v1/monitors/export": exportOf(),
      "POST /v1/monitors": [
        problem(409, "idempotency_in_progress", "The first request with this Idempotency-Key is still executing"),
        json(201, { id: M1, slug: "x", name: NAME, monitor_type: "Website" }, { "idempotency-replayed": "true" }),
      ],
    });
    await expect(createPreviewMonitor(ctx(client, { url: URL1 }, { github }).c)).resolves.toMatchObject({ "monitor-id": M1 });
    const posts = calls.filter((x) => x.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1].headers["Idempotency-Key"]).toBe(posts[0].headers["Idempotency-Key"]);
  });

  it("after creating, deletes newer marked duplicates and keeps the oldest, re-pointing it at this URL", async () => {
    const older = owned(M2, { created_at: "2026-10-21T10:00:00.000Z" });
    const mine = owned(M1, { created_at: "2026-10-21T10:00:05.000Z" });
    const { client, calls } = makeClient({
      "GET /v1/monitors": [page([]), page([mine, older])],
      "GET /v1/monitors/export": [exportOf(), exportOf(entry("https://other-push.vercel.app"))],
      "POST /v1/monitors": json(201, { id: M1, slug: "x", name: NAME, monitor_type: "Website" }),
      [`DELETE /v1/monitors/${M1}`]: json(200, { id: M1, deleted: true }),
      [`PATCH /v1/monitors/${M2}`]: json(200, older),
    });
    const out = await createPreviewMonitor(ctx(client, { url: URL1 }, { github }).c);
    expect(out).toEqual({ "monitor-id": M2, "monitor-name": NAME, created: "false", updated: "true" });
    expect(calls.filter((x) => x.method === "DELETE").map((x) => x.path)).toEqual([`/v1/monitors/${M1}`]);
    expect(calls.find((x) => x.method === "PATCH").body).toEqual({ url: URL1 });
  });

  it("creates again under a derived key when the key replays a monitor that was since deleted", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": [page([]), page([]), page([owned(M3)])],
      "GET /v1/monitors/export": exportOf(),
      "POST /v1/monitors": [
        json(201, { id: M2, slug: "old", name: NAME, monitor_type: "Website" }),
        json(201, { id: M3, slug: "new", name: NAME, monitor_type: "Website" }),
      ],
    });
    await expect(createPreviewMonitor(ctx(client, { url: URL1 }, { github }).c)).resolves.toMatchObject({ "monitor-id": M3, created: "true" });
    const keys = calls.filter((x) => x.method === "POST").map((x) => x.headers["Idempotency-Key"]);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("reuses its own monitor with the same name and type (idempotent re-run)", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": page([owned(M1)]),
      "GET /v1/monitors/export": exportOf(entry(`${URL1}/`)),
    });
    await expect(createPreviewMonitor(ctx(client, { url: URL1 }, { github }).c)).resolves.toEqual({
      "monitor-id": M1,
      "monitor-name": NAME,
      created: "false",
      updated: "false",
    });
    expect(calls.some((x) => x.method !== "GET")).toBe(false);
  });

  it("points its own reused monitor at the new preview URL when it changed", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": page([owned(M1)]),
      "GET /v1/monitors/export": exportOf(entry("https://old.vercel.app")),
      [`PATCH /v1/monitors/${M1}`]: json(200, owned(M1)),
    });
    await expect(createPreviewMonitor(ctx(client, { url: URL1 }, { github }).c)).resolves.toMatchObject({ created: "false", updated: "true" });
    expect(calls.find((x) => x.method === "PATCH").body).toEqual({ url: URL1 });
  });

  it("never patches or reuses a same-named monitor without the marker, and fails clearly", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": page([monitor(M1, NAME, { description: "Hand-made by the team" })]),
      "GET /v1/monitors/export": exportOf(entry("https://old.vercel.app", { description: "Hand-made by the team" })),
    });
    const err = await createPreviewMonitor(ctx(client, { url: URL1 }, { github }).c).catch((e) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect(err.message).toMatch(/not created by uptimely-action for acme\/web PR #42/);
    expect(err.message).toContain(MARK);
    expect(calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("does not treat another PR's marker as its own", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": page([monitor(M1, NAME, { description: "x [uptimely-action:acme/web#4]" })]),
    });
    await expect(createPreviewMonitor(ctx(client, { url: URL1 }, { github }).c)).rejects.toThrow(/left untouched/);
    expect(calls.every((x) => x.method === "GET")).toBe(true);
  });

  it("reuses its own monitor already watching the URL under another name, but not an unmarked one", async () => {
    const mine = monitor(M2, "Old preview name", { description: OWNED });
    const theirs = monitor(M3, "Hand-made preview");
    const { client, calls } = makeClient({
      "GET /v1/monitors": page([mine, theirs]),
      "GET /v1/monitors/export": exportOf(
        { name: "Hand-made preview", monitor_type: "Website", description: null, url: URL1 },
        { name: "Old preview name", monitor_type: "Website", description: OWNED, url: URL1 },
      ),
    });
    await expect(createPreviewMonitor(ctx(client, { url: URL1, name: "My preview" }, { github }).c)).resolves.toEqual({
      "monitor-id": M2,
      "monitor-name": "Old preview name",
      created: "false",
      updated: "false",
    });
    expect(calls.some((x) => x.method === "POST")).toBe(false);

    const only = makeClient({
      "GET /v1/monitors": [page([theirs]), page([monitor(M1, "My preview", { description: OWNED })])],
      "GET /v1/monitors/export": exportOf({ name: "Hand-made preview", monitor_type: "Website", description: null, url: URL1 }),
      "POST /v1/monitors": json(201, { id: M1, slug: "s", name: "My preview", monitor_type: "Website" }),
    });
    await expect(createPreviewMonitor(ctx(only.client, { url: URL1, name: "My preview" }, { github }).c)).resolves.toMatchObject({
      "monitor-id": M1,
      created: "true",
    });
  });

  it("does not reuse a monitor of a different type", async () => {
    const { client } = makeClient({
      "GET /v1/monitors": [page([owned(M2, { monitor_type: "API" })]), page([owned(M1)])],
      "GET /v1/monitors/export": exportOf(entry(URL1, { monitor_type: "API" })),
      "POST /v1/monitors": json(201, { id: M1, slug: "s", name: NAME, monitor_type: "Website" }),
    });
    await expect(createPreviewMonitor(ctx(client, { url: URL1 }, { github }).c)).resolves.toMatchObject({ "monitor-id": M1, created: "true" });
  });

  it("refuses a bad URL and a non-HTTP monitor type", async () => {
    const { client } = makeClient({});
    await expect(createPreviewMonitor(ctx(client, {}).c)).rejects.toThrow(/needs the url/);
    await expect(createPreviewMonitor(ctx(client, { url: "ftp://x" }).c)).rejects.toThrow(/not an http/);
    await expect(createPreviewMonitor(ctx(client, { url: URL1, monitorType: "Ping" }).c)).rejects.toThrow(/Website" or "API/);
  });

  it("surfaces the plan / write-gate refusal from the API", async () => {
    const { client } = makeClient({
      "GET /v1/monitors": page([]),
      "GET /v1/monitors/export": exportOf(),
      "POST /v1/monitors": problem(403, "feature_not_enabled", "Monitor limit reached for the Free plan"),
    });
    await expect(createPreviewMonitor(ctx(client, { url: URL1 }).c)).rejects.toThrow(/Monitor limit reached/);
  });
});

describe("delete-monitor", () => {
  const github = { repository: "acme/web", prNumber: 42 };
  const NAME = "acme/web PR #42 preview";
  const OWNED = "Preview monitor [uptimely-action:acme/web#42]";

  it("deletes by id", async () => {
    const { client, calls } = makeClient({ [`DELETE /v1/monitors/${M1}`]: json(200, { id: M1, deleted: true }) });
    await expect(deleteMonitor(ctx(client, { monitorId: M1 }).c)).resolves.toEqual({ "monitor-id": M1, "monitor-ids": M1, deleted: "true" });
    expect(calls).toHaveLength(1);
  });

  it("treats an already-deleted monitor as success with deleted=false", async () => {
    const { client } = makeClient({ [`DELETE /v1/monitors/${M1}`]: problem(404, "resource_not_found", "gone") });
    await expect(deleteMonitor(ctx(client, { monitorId: M1 }).c)).resolves.toEqual({ "monitor-id": M1, "monitor-ids": "", deleted: "false" });
  });

  it("deletes every marked monitor for the PR (duplicates included), never the unmarked one", async () => {
    const { client, calls } = makeClient({
      "GET /v1/monitors": page([
        monitor(M2, NAME, { description: OWNED, created_at: "2026-10-21T10:00:00.000Z" }),
        monitor(M3, NAME, { description: OWNED, created_at: "2026-10-21T10:00:09.000Z" }),
        monitor(M1, NAME, { description: "made by hand" }),
      ]),
      [`DELETE /v1/monitors/${M2}`]: json(200, { id: M2, deleted: true }),
      [`DELETE /v1/monitors/${M3}`]: json(200, { id: M3, deleted: true }),
    });
    const { c, lines } = ctx(client, {}, { github });
    await expect(deleteMonitor(c)).resolves.toEqual({ "monitor-id": M2, "monitor-ids": `${M2},${M3}`, deleted: "true" });
    expect(calls.filter((x) => x.method === "DELETE").map((x) => x.path)).toEqual([`/v1/monitors/${M2}`, `/v1/monitors/${M3}`]);
    expect(lines.warning[0]).toMatch(new RegExp(`untouched: ${M1}`));
  });

  it("fails without deleting when only an unmarked same-named monitor exists", async () => {
    const { client, calls } = makeClient({ "GET /v1/monitors": page([monitor(M1, NAME, { description: "made by hand" })]) });
    const err = await deleteMonitor(ctx(client, {}, { github }).c).catch((e) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect(err.message).toMatch(/nothing was deleted/);
    expect(calls.some((x) => x.method === "DELETE")).toBe(false);
  });

  it("is a no-op when no monitor has the name", async () => {
    const { client, calls } = makeClient({ "GET /v1/monitors": page([]) });
    await expect(deleteMonitor(ctx(client, { name: "gone" }).c)).resolves.toEqual({ "monitor-id": "", "monitor-ids": "", deleted: "false" });
    expect(calls.some((x) => x.method === "DELETE")).toBe(false);
  });

  it("needs some selector", async () => {
    const { client } = makeClient({});
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
  const at = (iso, extra = {}) => json(200, monitor(M1, "Web", { updated_at: iso, ...extra }));
  const T0 = "2026-10-21T10:00:00.000Z";
  const CLAIM = "2026-10-21T10:01:00.000Z";
  const RECORDED = "2026-10-21T10:01:02.000Z";

  it("does not pass a fresh monitor on its initial Operational state before any check", async () => {
    const { client, calls } = makeClient({ [`GET /v1/monitors/${M1}`]: at(T0, { created_at: T0 }) });
    const { c } = ctx(client, { monitorId: M1, timeoutSeconds: 60, intervalSeconds: 15 }, clock());
    const err = await check(c).catch((e) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect(err.message).toMatch(/recorded no new check within 60s/);
    expect(err.outputs).toEqual({ "monitor-id": M1, status: "Operational" });
    expect(calls.length).toBeGreaterThan(1);
  });

  it("does not pass on the probe claim alone, only once the result is recorded", async () => {
    const { client, calls } = makeClient({ [`GET /v1/monitors/${M1}`]: [at(T0), at(T0), at(CLAIM), at(RECORDED)] });
    const { c, lines } = ctx(client, { monitorId: M1, intervalSeconds: 10 }, clock());
    await expect(check(c)).resolves.toEqual({ "monitor-id": M1, status: "Operational" });
    expect(calls).toHaveLength(4);
    expect(lines.info.join("\n")).toMatch(/recorded a new check/);
  });

  it("does not pass a re-pointed monitor on the old URL's status", async () => {
    // PATCH leaves updated_at alone; the old URL's "Operational" must not count.
    const offline = { status: { name: "Offline", color: null } };
    const { client } = makeClient({ [`GET /v1/monitors/${M1}`]: [at(T0), at(CLAIM), at(RECORDED, offline)] });
    const { c } = ctx(client, { monitorId: M1, intervalSeconds: 10, timeoutSeconds: 30 }, clock());
    const err = await check(c).catch((e) => e);
    expect(err.message).toMatch(/was not Operational within 30s; last status: Offline/);
  });

  it("passes at once when wait-for-new-check is off", async () => {
    const { client, calls } = makeClient({ [`GET /v1/monitors/${M1}`]: json(200, monitor(M1, "Web")) });
    const { c } = ctx(client, { monitorId: M1, waitForNewCheck: false }, clock());
    await expect(check(c)).resolves.toEqual({ "monitor-id": M1, status: "Operational" });
    expect(calls).toHaveLength(1);
  });

  it("polls until the monitor recovers", async () => {
    const offline = { status: { name: "Offline", color: null } };
    const { client, calls } = makeClient({ [`GET /v1/monitors/${M1}`]: [at(T0, offline), at(CLAIM, offline), at(RECORDED)] });
    const { c, lines } = ctx(client, { monitorId: M1, intervalSeconds: 10 }, clock());
    await expect(check(c)).resolves.toMatchObject({ status: "Operational" });
    expect(calls).toHaveLength(3);
    expect(lines.info.join("\n")).toMatch(/Offline[\s\S]*Operational/);
  });

  it("requires the status to stay up for stable-for-seconds", async () => {
    const up = json(200, monitor(M1, "Web"));
    const down = json(200, monitor(M1, "Web", { status: { name: "Offline", color: null } }));
    const { client, calls } = makeClient({ [`GET /v1/monitors/${M1}`]: [up, down, up, up, up, up] });
    const { c } = ctx(client, { monitorId: M1, intervalSeconds: 10, stableForSeconds: 30, waitForNewCheck: false }, clock());
    await expect(check(c)).resolves.toMatchObject({ status: "Operational" });
    // up(0) down(10) up(20) up(30) up(40) up(50): stable since t=20, passes at t=50.
    expect(calls).toHaveLength(6);
  });

  it("fails at the timeout with the last status", async () => {
    const { client } = makeClient({
      [`GET /v1/monitors/${M1}`]: json(200, monitor(M1, "Web", { status: { name: "Degraded", color: null } })),
    });
    const { c } = ctx(client, { monitorId: M1, timeoutSeconds: 60, intervalSeconds: 15, waitForNewCheck: false }, clock());
    const err = await check(c).catch((e) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect(err.message).toMatch(/within 60s; last status: Degraded/);
    expect(err.outputs).toEqual({ "monitor-id": M1, status: "Degraded" });
  });

  it("accepts custom up-statuses, case-insensitively", async () => {
    const { client } = makeClient({
      [`GET /v1/monitors/${M1}`]: json(200, monitor(M1, "Web", { status: { name: "Degraded", color: null } })),
    });
    const { c } = ctx(client, { monitorId: M1, upStatuses: ["operational", "degraded"], waitForNewCheck: false }, clock());
    await expect(check(c)).resolves.toMatchObject({ status: "Degraded" });
  });

  it("looks the monitor up by name, preferring the action's own copy", async () => {
    const { client } = makeClient({
      "GET /v1/monitors": page([monitor(M2, "Web")]),
      [`GET /v1/monitors/${M2}`]: json(200, monitor(M2, "Web")),
    });
    await expect(check(ctx(client, { name: "Web", waitForNewCheck: false }, clock()).c)).resolves.toMatchObject({ "monitor-id": M2 });

    const shared = makeClient({
      "GET /v1/monitors": page([monitor(M1, "Web"), monitor(M3, "Web", { description: "x [uptimely-action:acme/web#42]" })]),
      [`GET /v1/monitors/${M3}`]: json(200, monitor(M3, "Web")),
    });
    const { c } = ctx(shared.client, { name: "Web", waitForNewCheck: false }, { ...clock(), github: { repository: "acme/web", prNumber: 42 } });
    await expect(check(c)).resolves.toMatchObject({ "monitor-id": M3 });
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

  it("fails at once, without polling, when the monitor's probing is switched off", async () => {
    const { client, calls } = makeClient({
      [`GET /v1/monitors/${M1}`]: json(200, monitor(M1, "Web", { active_monitoring_disabled: true })),
    });
    const err = await check(ctx(client, { monitorId: M1 }, clock()).c).catch((e) => e);
    expect(err).toBeInstanceOf(OperationError);
    expect(err.message).toMatch(/active monitoring switched off/);
    expect(err.outputs).toEqual({ "monitor-id": M1, status: "Operational" });
    expect(calls).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("names preview monitors per PR, else per URL, within 100 characters", () => {
    expect(defaultPreviewName({ repository: "a/b", prNumber: 7 }, "https://x")).toBe("a/b PR #7 preview");
    expect(defaultPreviewName({}, "https://x.dev")).toBe("Preview: https://x.dev");
    expect(defaultPreviewName({}, `https://${"x".repeat(200)}.dev`)).toHaveLength(100);
    expect(defaultPreviewName({}, "")).toBe("");
  });

  it("truncates a long repository name but keeps the PR suffix", () => {
    const name = defaultPreviewName({ repository: `acme/${"r".repeat(120)}`, prNumber: 12345 }, "https://x");
    expect(name).toHaveLength(100);
    expect(name.endsWith(" PR #12345 preview")).toBe(true);
    expect(name.startsWith("acme/rrr")).toBe(true);
  });

  it("builds an ownership marker per repo and PR", () => {
    expect(ownershipMarker({ repository: "acme/web", prNumber: 42 })).toBe("[uptimely-action:acme/web#42]");
    expect(ownershipMarker({ repository: "acme/web" })).toBe("[uptimely-action:acme/web]");
    expect(ownershipMarker({})).toBe("[uptimely-action]");
  });

  it("compares URLs ignoring a trailing root slash and fragment", () => {
    expect(normalizeUrl("https://a.dev/")).toBe(normalizeUrl("https://a.dev"));
    expect(normalizeUrl("https://a.dev/x#y")).toBe("https://a.dev/x");
    expect(normalizeUrl("not a url ")).toBe("not a url");
  });
});
