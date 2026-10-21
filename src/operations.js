/**
 * The action's operations, each a thin layer over Uptimely's public /v1 API.
 *
 * Every operation takes a context `{ client, inputs, log, sleep, now, randomUUID, github }`
 * and resolves to the outputs it wants set. A partial failure throws an
 * `OperationError` that still carries outputs, so a later `if: always()` step
 * can use whatever was done.
 *
 * Why there is no pause/resume: the API deliberately does not expose pausing
 * (stopping probes). Uptimely's contract (packages/contracts/src/routes/monitors.ts)
 * says pausing "blinds uptime and the status page, and the deploy-window use
 * case it gets reached for is what POST /v1/monitors/{id}/mute exists to
 * serve". So the deploy-window operations here are `mute` / `unmute`: checks
 * keep running, only incidents and alerts stop.
 */
import { createHash } from "node:crypto";
import { UptimelyApiError } from "./client.js";

export const OPERATIONS = ["mute", "unmute", "create-preview-monitor", "delete-monitor", "check"];

/** Monitor names are a 100-character column in Uptimely. */
export const MAX_MONITOR_NAME = 100;

/** The config export caps descriptions at 500 characters, so ours stay within it. */
export const MAX_DESCRIPTION = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_MONITOR_TYPES = new Set(["Website", "API"]);

export class OperationError extends Error {
  constructor(message, outputs = {}) {
    super(message);
    this.name = "OperationError";
    this.outputs = outputs;
  }
}

function assertMonitorId(id) {
  if (!UUID_RE.test(id)) {
    throw new OperationError(`"${id}" is not a monitor id (expected a UUID such as 9f1e6a2c-6a0f-4f4e-9c01-1af1c19a2b3d).`);
  }
  return id;
}

const monitorPath = (id) => `/v1/monitors/${encodeURIComponent(assertMonitorId(id))}`;
const keyOf = (name, type) => `${type}\u0000${name}`;
const sameUrl = (a, b) => normalizeUrl(a) === normalizeUrl(b);

export function normalizeUrl(value) {
  try {
    const u = new URL(String(value).trim());
    u.hash = "";
    let s = u.toString();
    if (u.pathname === "/" && !u.search) s = s.replace(/\/$/, "");
    return s;
  } catch {
    return String(value).trim();
  }
}

/** Default name for a preview monitor: per pull request when there is one, else per URL. */
export function defaultPreviewName(github, url) {
  if (github?.prNumber && github?.repository) {
    // Truncate the repository, never the suffix: the PR number is what keeps
    // two pull requests' monitors apart.
    const suffix = ` PR #${github.prNumber} preview`;
    return github.repository.slice(0, Math.max(0, MAX_MONITOR_NAME - suffix.length)) + suffix;
  }
  return url ? `Preview: ${url}`.slice(0, MAX_MONITOR_NAME) : "";
}

/**
 * The ownership marker stamped into the description of every monitor this
 * action creates, e.g. `[uptimely-action:acme/web#42]`. Uptimely's create
 * endpoint takes no labels, and the description is returned by both
 * GET /v1/monitors and the config export, so it is where ownership lives.
 * Name-based reuse, PATCH and delete only ever touch monitors carrying the
 * marker for this repository and pull request. The closing bracket keeps
 * `#4` from matching `#42`.
 */
export function ownershipMarker(github) {
  const repo = github?.repository || "";
  if (!repo) return "[uptimely-action]";
  return `[uptimely-action:${repo}${github?.prNumber ? `#${github.prNumber}` : ""}]`;
}

const isOwned = (m, marker) => typeof m?.description === "string" && m.description.includes(marker);

/** Oldest first (created_at, then id), so every concurrent run picks the same survivor. */
function byAge(a, b) {
  const d = Date.parse(a.created_at) - Date.parse(b.created_at);
  if (d) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Resolves the monitors a mute/unmute targets: explicit ids, plus every live
 * monitor carrying one of the given labels.
 *
 * Label membership is only visible in GET /v1/monitors/export (config entries
 * carry label NAMES but no ids), and ids only in GET /v1/monitors, so the two
 * are joined on (name, monitor_type). When that pair is shared by several
 * monitors and only some of them carry the label, the join is ambiguous and
 * we refuse rather than mute the wrong one.
 */
export async function resolveMonitorSelection(client, { monitorIds = [], labels = [] }) {
  const ids = new Set(monitorIds.map(assertMonitorId));
  if (labels.length === 0) return [...ids];

  const wanted = new Set(labels.map((l) => l.trim().toLowerCase()).filter(Boolean));
  const [exported, monitors] = await Promise.all([
    client.request("GET", "/v1/monitors/export"),
    client.listAll("/v1/monitors"),
  ]);
  const entries = Array.isArray(exported?.monitors) ? exported.monitors : [];

  const totals = new Map();
  const matching = new Map();
  for (const entry of entries) {
    const key = keyOf(entry.name, entry.monitor_type);
    totals.set(key, (totals.get(key) ?? 0) + 1);
    const hit = (entry.labels ?? []).some((l) => wanted.has(String(l).trim().toLowerCase()));
    if (hit) matching.set(key, (matching.get(key) ?? 0) + 1);
  }

  const idsByKey = new Map();
  for (const m of monitors) {
    const key = keyOf(m.name, m.monitor_type);
    if (!idsByKey.has(key)) idsByKey.set(key, []);
    idsByKey.get(key).push(m.id);
  }

  const ambiguous = [];
  for (const [key, count] of matching) {
    const found = idsByKey.get(key) ?? [];
    if (count === totals.get(key) && count === found.length) {
      for (const id of found) ids.add(id);
    } else {
      ambiguous.push(key.split("\u0000")[1]);
    }
  }
  if (ambiguous.length > 0) {
    throw new OperationError(
      `Several monitors share the name and type of labelled monitor(s) ${ambiguous.map((n) => `"${n}"`).join(", ")}, and only some carry the label, so they cannot be told apart. Rename them or pass monitor-ids instead.`,
    );
  }
  return [...ids];
}

/** Finds monitors by exact name (and optional type) in GET /v1/monitors. */
async function findByName(client, name, monitorType) {
  const all = await client.listAll("/v1/monitors");
  return all.filter((m) => m.name === name && (!monitorType || m.monitor_type === monitorType));
}

async function resolveSingleMonitor(client, inputs, github) {
  if (inputs.monitorId) return assertMonitorId(inputs.monitorId);
  const name = inputs.name || defaultPreviewName(github, inputs.url);
  if (!name) throw new OperationError("Set monitor-id or name.");
  const found = await findByName(client, name);
  if (found.length === 0) throw new OperationError(`No monitor named "${name}" exists in this project.`);
  // Reading is harmless, but when this action's own monitor shares the name
  // with others, prefer it (the oldest copy, as create-preview-monitor keeps).
  const owned = found.filter((m) => isOwned(m, ownershipMarker(github))).sort(byAge);
  if (owned.length > 0) return owned[0].id;
  if (found.length > 1) {
    throw new OperationError(
      `${found.length} monitors are named "${name}" (${found.map((m) => m.id).join(", ")}); pass monitor-id to pick one.`,
    );
  }
  return found[0].id;
}

// ---------------------------------------------------------------- mute / unmute

export async function mute(ctx) {
  const { client, inputs, log, randomUUID } = ctx;
  const ids = await resolveMonitorSelection(client, inputs);
  if (ids.length === 0) {
    throw new OperationError("No monitors selected: set monitor-ids and/or labels (no monitor carries the given labels).");
  }
  const minutes = inputs.muteMinutes;
  const muted = [];
  const failures = [];
  let mutedUntil = "";
  for (const id of ids) {
    try {
      const res = await client.request("POST", `${monitorPath(id)}/mute`, {
        body: { duration_minutes: minutes },
        idempotencyKey: randomUUID(),
      });
      muted.push(res?.monitor_id ?? id);
      log.info(`Muted alerts for monitor ${id} until ${res?.alerts_muted_until ?? "unknown"}.`);
      if (res?.alerts_muted_until && res.alerts_muted_until > mutedUntil) mutedUntil = res.alerts_muted_until;
    } catch (err) {
      failures.push(`${id}: ${err.message}`);
    }
  }
  const outputs = {
    "monitor-ids": muted.join(","),
    "muted-until": mutedUntil,
  };
  if (failures.length > 0) {
    throw new OperationError(
      `Could not mute ${failures.length} of ${ids.length} monitor(s):\n${failures.join("\n")}`,
      outputs,
    );
  }
  return outputs;
}

/**
 * Lifts the mute. Built to run in an `if: always()` step:
 * - no selection at all (e.g. the mute step failed before setting outputs) is a no-op;
 * - a monitor that no longer exists is a warning, not a failure;
 * - every monitor is attempted before the step reports any failure.
 * DELETE /v1/monitors/{id}/mute is a no-op on a monitor that is not muted.
 */
export async function unmute(ctx) {
  const { client, inputs, log } = ctx;
  if (inputs.monitorIds.length === 0 && inputs.labels.length === 0) {
    log.warning("unmute: no monitor-ids or labels given, nothing to unmute.");
    return { "monitor-ids": "" };
  }
  const ids = await resolveMonitorSelection(client, inputs);
  const unmuted = [];
  const failures = [];
  for (const id of ids) {
    try {
      await client.request("DELETE", `${monitorPath(id)}/mute`);
      unmuted.push(id);
      log.info(`Unmuted alerts for monitor ${id}.`);
    } catch (err) {
      if (err instanceof UptimelyApiError && err.status === 404) {
        log.warning(`Monitor ${id} no longer exists; nothing to unmute.`);
        continue;
      }
      failures.push(`${id}: ${err.message}`);
    }
  }
  const outputs = { "monitor-ids": unmuted.join(",") };
  if (failures.length > 0) {
    throw new OperationError(
      `Could not unmute ${failures.length} of ${ids.length} monitor(s); they stay muted until their mute window ends:\n${failures.join("\n")}`,
      outputs,
    );
  }
  return outputs;
}

// ------------------------------------------------------ preview monitor lifecycle

/** Who the marker says owns a monitor, for messages. */
function ownerLabel(github) {
  if (!github?.repository) return "this workflow";
  return `${github.repository}${github.prNumber ? ` PR #${github.prNumber}` : ""}`;
}

/**
 * The create Idempotency-Key, derived from the repository, the pull request
 * and the exact request body (which carries the URL). Uptimely's ledger keys
 * on (project, method, path, key) and refuses a reused key with a different
 * body (422), so a key that hashes the body can only ever collapse identical
 * requests: concurrent runs for the same PR and URL create ONE monitor, the
 * others get a 409 `idempotency_in_progress` (retried) and then a replay of
 * the same 201. The ledger keeps a key for 24 hours.
 */
export function createIdempotencyKey(github, body, salt = "") {
  const digest = createHash("sha256")
    .update(JSON.stringify(["create-preview-monitor", github?.repository || "", github?.prNumber || "", body, salt]))
    .digest("hex");
  return `uptimely-action-${digest}`;
}

/** Export entries carry (name, type, description) but no id; the list carries ids. */
function exportedUrlOf(entries, m) {
  const hits = entries.filter(
    (e) => e.name === m.name && e.monitor_type === m.monitor_type && (e.description ?? null) === (m.description ?? null),
  );
  return hits.length === 1 ? hits[0].url : undefined;
}

async function readExport(client) {
  const exported = await client.request("GET", "/v1/monitors/export");
  return Array.isArray(exported?.monitors) ? exported.monitors : [];
}

/** Deletes every monitor in `extras`; a 404 means another run already did. */
async function deleteDuplicates(client, log, extras, keptId) {
  for (const m of extras) {
    try {
      await client.request("DELETE", monitorPath(m.id));
      log.info(`Deleted duplicate preview monitor ${m.id} (kept ${keptId}).`);
    } catch (err) {
      if (!(err instanceof UptimelyApiError && err.status === 404)) throw err;
    }
  }
}

/**
 * Creates a monitor for a preview URL, or reuses the one a previous run made.
 *
 * Only monitors carrying this run's ownership marker (see ownershipMarker) are
 * ever reused, re-pointed or deleted. A same-named monitor without the marker
 * belongs to someone else: the step fails and leaves it alone.
 *
 * Reuse order: a marked monitor with the same name + type (its URL is updated
 * when the preview moved), else a marked monitor of the same type already
 * watching the URL. Only then is a monitor created, with a deterministic
 * Idempotency-Key. Afterwards the list is read again and any newer marked
 * copies (left by a concurrent run with a different URL) are deleted, keeping
 * the oldest so every run converges on the same monitor.
 */
export async function createPreviewMonitor(ctx) {
  const { client, inputs, log, github } = ctx;
  const url = inputs.url;
  if (!url) throw new OperationError("create-preview-monitor needs the url input.");
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("bad protocol");
  } catch {
    throw new OperationError(`url is not an http(s) URL: ${url}`);
  }
  const monitorType = inputs.monitorType || "Website";
  if (!PREVIEW_MONITOR_TYPES.has(monitorType)) {
    throw new OperationError(`monitor-type must be "Website" or "API" for a preview URL (got "${monitorType}").`);
  }
  const name = (inputs.name || defaultPreviewName(github, url)).slice(0, MAX_MONITOR_NAME);
  const marker = ownershipMarker(github);
  const sameName = (m) => m.name === name && m.monitor_type === monitorType;

  const monitors = await client.listAll("/v1/monitors");
  const foreign = monitors.filter((m) => sameName(m) && !isOwned(m, marker));
  if (foreign.length > 0) {
    throw new OperationError(
      `A ${monitorType} monitor named "${name}" already exists (${foreign.map((m) => m.id).join(", ")}) but was not created by uptimely-action for ${ownerLabel(github)}: its description lacks the marker ${marker}. It was left untouched. Rename or delete it, or set a different name input.`,
    );
  }
  let owned = monitors.filter((m) => sameName(m) && isOwned(m, marker));
  let entries;

  if (owned.length === 0) {
    // A monitor this action made for the same PR under another name (the name
    // input changed) that already watches the URL.
    entries = await readExport(client);
    const urlMatch = monitors
      .filter((m) => m.monitor_type === monitorType && isOwned(m, marker))
      .filter((m) => {
        const current = exportedUrlOf(entries, m);
        return current !== undefined && sameUrl(current, url);
      })
      .sort(byAge);
    if (urlMatch.length > 0) {
      const m = urlMatch[0];
      log.info(`Reused monitor ${m.id} ("${m.name}"), which already watches ${url}.`);
      return { "monitor-id": m.id, "monitor-name": m.name, created: "false", updated: "false" };
    }
  }

  let createdId = "";
  if (owned.length === 0) {
    const base =
      inputs.description ||
      (github?.repository
        ? `Preview monitor created by uptimely-action for ${ownerLabel(github)}.`
        : "Preview monitor created by uptimely-action.");
    const body = {
      name,
      monitor_type: monitorType,
      url,
      description: `${base.slice(0, MAX_DESCRIPTION - marker.length - 1)} ${marker}`,
    };
    if (inputs.monitoringInterval) body.monitoring_interval = inputs.monitoringInterval;
    if (inputs.failureThreshold !== undefined) body.failure_threshold = inputs.failureThreshold;

    let key = createIdempotencyKey(github, body);
    for (let attempt = 0; ; attempt += 1) {
      const created = await client.request("POST", "/v1/monitors", { body, idempotencyKey: key });
      createdId = created.id;
      owned = (await client.listAll("/v1/monitors")).filter((m) => sameName(m) && isOwned(m, marker));
      if (owned.some((m) => m.id === createdId)) break;
      // The key replayed a create from the last 24 hours whose monitor has
      // since been deleted (e.g. the PR was closed and reopened). Derive a new
      // key from the stale id, still deterministic so concurrent runs agree.
      if (attempt > 0) {
        throw new OperationError(`Uptimely reported monitor ${createdId} as created, but it is not in the monitor list.`);
      }
      log.info(`The Idempotency-Key replayed monitor ${createdId}, which no longer exists; creating a new one.`);
      key = createIdempotencyKey(github, body, createdId);
    }
    log.info(`Created ${monitorType} monitor ${createdId} ("${name}") for ${url}.`);
  }

  owned.sort(byAge);
  const keep = owned[0];
  const extras = owned.slice(1);
  if (extras.length > 0) {
    await deleteDuplicates(client, log, extras, keep.id);
    entries = undefined; // re-read: the export still listed the duplicates
  }

  let updated = false;
  if (keep.id !== createdId) {
    entries ??= await readExport(client);
    const current = exportedUrlOf(entries, keep);
    if (current !== undefined && !sameUrl(current, url)) {
      // PATCH sets absolute values, so repeating it is harmless: safe to retry.
      await client.request("PATCH", monitorPath(keep.id), { body: { url }, retry: true });
      updated = true;
      log.info(`Reused monitor ${keep.id} ("${name}") and pointed it at ${url} (was ${current}).`);
    } else {
      log.info(`Reused monitor ${keep.id} ("${name}").`);
    }
  }
  return {
    "monitor-id": keep.id,
    "monitor-name": name,
    created: String(keep.id === createdId),
    updated: String(updated),
  };
}

/**
 * Deletes a monitor by id, or every monitor this action made under a name
 * (defaulting to the same per-PR name create-preview-monitor uses). By name,
 * only monitors carrying this run's ownership marker are deleted. Nothing to
 * delete is success with deleted=false, so a cleanup step on PR close never
 * fails because the monitor is already gone.
 */
export async function deleteMonitor(ctx) {
  const { client, inputs, log, github } = ctx;
  let ids;
  let foreign = [];
  if (inputs.monitorId) {
    ids = [assertMonitorId(inputs.monitorId)];
  } else {
    const name = inputs.name || defaultPreviewName(github, inputs.url);
    if (!name) throw new OperationError("delete-monitor needs monitor-id or name.");
    const marker = ownershipMarker(github);
    const found = await findByName(client, name, inputs.monitorType || undefined);
    foreign = found.filter((m) => !isOwned(m, marker));
    ids = found
      .filter((m) => isOwned(m, marker))
      .sort(byAge)
      .map((m) => m.id);
    if (ids.length === 0) {
      const none = { "monitor-id": "", "monitor-ids": "", deleted: "false" };
      if (foreign.length > 0) {
        throw new OperationError(
          `Monitor(s) named "${name}" exist (${foreign.map((m) => m.id).join(", ")}) but none was created by uptimely-action for ${ownerLabel(github)} (no ${marker} marker in the description), so nothing was deleted. Pass monitor-id to delete one explicitly.`,
          none,
        );
      }
      log.info(`No monitor named "${name}"; nothing to delete.`);
      return none;
    }
  }

  const deleted = [];
  const failures = [];
  for (const id of ids) {
    try {
      await client.request("DELETE", monitorPath(id));
      deleted.push(id);
      log.info(`Deleted monitor ${id}.`);
    } catch (err) {
      if (err instanceof UptimelyApiError && err.status === 404) {
        log.info(`Monitor ${id} does not exist (already deleted).`);
        continue;
      }
      failures.push(`${id}: ${err.message}`);
    }
  }
  if (foreign.length > 0) {
    log.warning(
      `Left ${foreign.length} same-named monitor(s) without this run's ownership marker untouched: ${foreign.map((m) => m.id).join(", ")}.`,
    );
  }
  const outputs = {
    "monitor-id": deleted[0] ?? ids[0],
    "monitor-ids": deleted.join(","),
    deleted: String(deleted.length > 0),
  };
  if (failures.length > 0) {
    throw new OperationError(`Could not delete ${failures.length} of ${ids.length} monitor(s):\n${failures.join("\n")}`, outputs);
  }
  return outputs;
}

// ------------------------------------------------------------------------ check

/**
 * Polls GET /v1/monitors/{id} until the monitor's status is one of
 * `up-statuses`, backed by a check Uptimely ran after this step started, and
 * has stayed so for `stable-for-seconds`; or fails at `timeout-seconds`.
 * Uptimely has no on-demand "check this URL now" endpoint, so this observes
 * the monitor's own scheduled checks.
 *
 * Why the wait for a new check: a monitor is created in the "Operational"
 * state before its first probe, and a monitor whose URL was just changed
 * keeps the status of its old URL until it is probed again. The API exposes
 * no last-check time, but Uptimely's probe sweep writes the monitor's
 * `updated_at` when it claims the monitor for a check and again once the
 * result is recorded (monitor-runtime-service: listDueMonitorProbeTargets,
 * advanceMonitorNextPingAt), while a PATCH leaves it alone. So two advances
 * of `updated_at` after the first poll mean at least one check finished after
 * the step started, and the status then reflects it.
 * `wait-for-new-check: false` turns this off (e.g. for monitor types no probe
 * checks, such as Manual or Incoming Request).
 */
export async function check(ctx) {
  const { client, inputs, log, sleep, now, github } = ctx;
  const id = await resolveSingleMonitor(client, inputs, github);
  const up = new Set(inputs.upStatuses.map((s) => s.trim().toLowerCase()));
  const deadline = now() + inputs.timeoutSeconds * 1000;
  const stableMs = inputs.stableForSeconds * 1000;
  const waitForCheck = inputs.waitForNewCheck !== false;
  let upSince = null;
  let lastStatus = "";
  let lastUpdatedAt;
  let writesSeen = 0;

  for (;;) {
    let monitor;
    try {
      monitor = await client.request("GET", monitorPath(id));
    } catch (err) {
      if (err instanceof UptimelyApiError && err.status === 404) {
        throw new OperationError(`Monitor ${id} does not exist.`, { "monitor-id": id });
      }
      throw err;
    }
    const status = monitor?.status?.name ?? "";
    if (status !== lastStatus) log.info(`Monitor ${id} ("${monitor?.name ?? ""}") status: ${status || "unknown"}.`);
    lastStatus = status;
    if (monitor?.active_monitoring_disabled) {
      throw new OperationError(
        `Monitor ${id} has active monitoring switched off (paused, or inside a maintenance window), so Uptimely is not checking it and its status "${status || "unknown"}" proves nothing. Switch monitoring back on, or gate on another monitor.`,
        { "monitor-id": id, status },
      );
    }

    const updatedAt = Date.parse(monitor?.updated_at ?? "");
    if (lastUpdatedAt === undefined) {
      lastUpdatedAt = updatedAt;
    } else if (updatedAt > lastUpdatedAt) {
      lastUpdatedAt = updatedAt;
      writesSeen += 1;
      if (waitForCheck && writesSeen === 2) log.info(`Monitor ${id} recorded a new check.`);
    }
    const checked = !waitForCheck || writesSeen >= 2;

    const t = now();
    if (checked && up.has(status.toLowerCase())) {
      upSince ??= t;
      if (t - upSince >= stableMs) {
        return { "monitor-id": id, status };
      }
    } else {
      upSince = null;
    }
    if (t >= deadline) {
      if (!checked) {
        throw new OperationError(
          `Monitor ${id} recorded no new check within ${inputs.timeoutSeconds}s, so its status ("${status || "unknown"}") may predate this run. Uptimely checks it on its own schedule (its monitoring interval, 5 minutes by default) and seeing a new check can take two intervals: set timeout-seconds to at least twice that interval, or set wait-for-new-check: false to accept the current status.`,
          { "monitor-id": id, status },
        );
      }
      throw new OperationError(
        `Monitor ${id} was not ${[...inputs.upStatuses].join(" / ")}${stableMs ? ` for ${inputs.stableForSeconds}s` : ""} within ${inputs.timeoutSeconds}s; last status: ${status || "unknown"}.`,
        { "monitor-id": id, status },
      );
    }
    await sleep(Math.min(inputs.intervalSeconds * 1000, Math.max(0, deadline - t)));
  }
}

export const HANDLERS = {
  mute,
  unmute,
  "create-preview-monitor": createPreviewMonitor,
  "delete-monitor": deleteMonitor,
  check,
};
