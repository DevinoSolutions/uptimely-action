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
import { UptimelyApiError } from "./client.js";

export const OPERATIONS = ["mute", "unmute", "create-preview-monitor", "delete-monitor", "check"];

/** Monitor names are a 100-character column in Uptimely. */
export const MAX_MONITOR_NAME = 100;

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
  const name =
    github?.prNumber && github?.repository
      ? `${github.repository} PR #${github.prNumber} preview`
      : url
        ? `Preview: ${url}`
        : "";
  return name.slice(0, MAX_MONITOR_NAME);
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

/**
 * Creates a monitor for a preview URL, or reuses the one a previous run made.
 * Reuse order: same name + type (and, if its URL changed, the URL is updated
 * so the monitor follows the newest preview deployment), else the same URL +
 * type. Only then is a monitor created, with an Idempotency-Key so a retried
 * POST cannot create it twice.
 */
export async function createPreviewMonitor(ctx) {
  const { client, inputs, log, github, randomUUID } = ctx;
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

  const monitors = await client.listAll("/v1/monitors");
  const byName = monitors.filter((m) => m.name === name && m.monitor_type === monitorType);
  if (byName.length > 1) {
    throw new OperationError(
      `${byName.length} ${monitorType} monitors are named "${name}" (${byName.map((m) => m.id).join(", ")}); delete the extras or set a different name.`,
    );
  }

  // URLs are only visible in the config export; ids only in the list.
  const exported = await client.request("GET", "/v1/monitors/export");
  const entries = Array.isArray(exported?.monitors) ? exported.monitors : [];

  if (byName.length === 1) {
    const existing = byName[0];
    const entry = entries.find((e) => e.name === name && e.monitor_type === monitorType);
    let updated = false;
    if (entry && entry.url && !sameUrl(entry.url, url)) {
      // PATCH sets absolute values, so repeating it is harmless: safe to retry.
      await client.request("PATCH", monitorPath(existing.id), { body: { url }, retry: true });
      updated = true;
      log.info(`Reused monitor ${existing.id} ("${name}") and pointed it at ${url} (was ${entry.url}).`);
    } else {
      log.info(`Reused monitor ${existing.id} ("${name}").`);
    }
    return { "monitor-id": existing.id, "monitor-name": name, created: "false", updated: String(updated) };
  }

  const urlMatches = entries.filter((e) => e.monitor_type === monitorType && e.url && sameUrl(e.url, url));
  for (const entry of urlMatches) {
    const candidates = monitors.filter((m) => m.name === entry.name && m.monitor_type === monitorType);
    if (candidates.length === 1) {
      log.info(`Reused monitor ${candidates[0].id} ("${entry.name}"), which already watches ${url}.`);
      return { "monitor-id": candidates[0].id, "monitor-name": entry.name, created: "false", updated: "false" };
    }
  }

  const body = { name, monitor_type: monitorType, url };
  const description =
    inputs.description ||
    (github?.repository
      ? `Preview monitor created by uptimely-action for ${github.repository}${github.prNumber ? ` PR #${github.prNumber}` : ""}.`
      : "Preview monitor created by uptimely-action.");
  body.description = description.slice(0, 1000);
  if (inputs.monitoringInterval) body.monitoring_interval = inputs.monitoringInterval;
  if (inputs.failureThreshold !== undefined) body.failure_threshold = inputs.failureThreshold;

  const created = await client.request("POST", "/v1/monitors", { body, idempotencyKey: randomUUID() });
  log.info(`Created ${monitorType} monitor ${created.id} ("${name}") for ${url}.`);
  return { "monitor-id": created.id, "monitor-name": name, created: "true", updated: "false" };
}

/**
 * Deletes a monitor by id, or by name (defaulting to the same per-PR name
 * create-preview-monitor uses). Missing is success with deleted=false, so a
 * cleanup step on PR close never fails because the monitor is already gone.
 */
export async function deleteMonitor(ctx) {
  const { client, inputs, log, github } = ctx;
  let id = inputs.monitorId ? assertMonitorId(inputs.monitorId) : "";
  if (!id) {
    const name = inputs.name || defaultPreviewName(github, inputs.url);
    if (!name) throw new OperationError("delete-monitor needs monitor-id or name.");
    const found = await findByName(client, name, inputs.monitorType || undefined);
    if (found.length === 0) {
      log.info(`No monitor named "${name}"; nothing to delete.`);
      return { "monitor-id": "", deleted: "false" };
    }
    if (found.length > 1) {
      throw new OperationError(
        `${found.length} monitors are named "${name}" (${found.map((m) => m.id).join(", ")}); pass monitor-id to pick one.`,
      );
    }
    id = found[0].id;
  }
  try {
    await client.request("DELETE", monitorPath(id));
  } catch (err) {
    if (err instanceof UptimelyApiError && err.status === 404) {
      log.info(`Monitor ${id} does not exist (already deleted).`);
      return { "monitor-id": id, deleted: "false" };
    }
    throw err;
  }
  log.info(`Deleted monitor ${id}.`);
  return { "monitor-id": id, deleted: "true" };
}

// ------------------------------------------------------------------------ check

/**
 * Polls GET /v1/monitors/{id} until the monitor's status is one of
 * `up-statuses` and has stayed so for `stable-for-seconds`, or fails at
 * `timeout-seconds`. Uptimely has no on-demand "check this URL now"
 * endpoint, so this observes the monitor's own probes.
 *
 * Caveat: a monitor starts in its "Operational" status at creation, before
 * its first probe. When gating on a freshly created monitor, set
 * stable-for-seconds to at least one check interval.
 */
export async function check(ctx) {
  const { client, inputs, log, sleep, now, github } = ctx;
  const id = await resolveSingleMonitor(client, inputs, github);
  const up = new Set(inputs.upStatuses.map((s) => s.trim().toLowerCase()));
  const deadline = now() + inputs.timeoutSeconds * 1000;
  const stableMs = inputs.stableForSeconds * 1000;
  let upSince = null;
  let lastStatus = "";
  let warnedDisabled = false;

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
    if (monitor?.active_monitoring_disabled && !warnedDisabled) {
      warnedDisabled = true;
      log.warning(`Monitor ${id} has active monitoring switched off, so its status will not change on its own.`);
    }

    const t = now();
    if (up.has(status.toLowerCase())) {
      upSince ??= t;
      if (t - upSince >= stableMs) {
        return { "monitor-id": id, status };
      }
    } else {
      upSince = null;
    }
    if (t >= deadline) {
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
