import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import * as core from "@actions/core";
import { createClient, DEFAULT_API_URL } from "./client.js";
import { HANDLERS, OPERATIONS, OperationError } from "./operations.js";

/** Splits a comma- or newline-separated input into trimmed, non-empty items. */
export function parseList(value) {
  return String(value ?? "")
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseIntInput(name, value, { min, max, fallback }) {
  const raw = String(value ?? "").trim();
  if (raw === "") return fallback;
  if (!/^-?\d+$/.test(raw)) throw new OperationError(`${name} must be a whole number (got "${raw}").`);
  const n = Number(raw);
  if ((min !== undefined && n < min) || (max !== undefined && n > max)) {
    throw new OperationError(`${name} must be between ${min} and ${max} (got ${n}).`);
  }
  return n;
}

/** Repository and pull-request number of the workflow run, when present. */
export function readGithubContext(env = process.env) {
  let prNumber;
  try {
    if (env.GITHUB_EVENT_PATH) {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
      prNumber = event?.pull_request?.number ?? (event?.issue?.pull_request ? event.issue.number : undefined);
    }
  } catch {
    // No readable event payload (e.g. a local run): fall back to no PR context.
  }
  return { repository: env.GITHUB_REPOSITORY || "", prNumber };
}

export function readInputs(getInput = core.getInput) {
  return {
    operation: getInput("operation", { required: true }).trim(),
    apiKey: getInput("api-key", { required: true }).trim(),
    apiUrl: getInput("api-url").trim() || DEFAULT_API_URL,
    monitorIds: parseList(getInput("monitor-ids")),
    labels: parseList(getInput("labels")),
    muteMinutes: parseIntInput("mute-minutes", getInput("mute-minutes"), { min: 1, max: 43200, fallback: 30 }),
    url: getInput("url").trim(),
    name: getInput("name").trim(),
    monitorType: getInput("monitor-type").trim(),
    description: getInput("description").trim(),
    monitoringInterval: getInput("monitoring-interval").trim(),
    failureThreshold: parseIntInput("failure-threshold", getInput("failure-threshold"), {
      min: 1,
      max: 10,
      fallback: undefined,
    }),
    monitorId: getInput("monitor-id").trim(),
    timeoutSeconds: parseIntInput("timeout-seconds", getInput("timeout-seconds"), { min: 1, max: 21600, fallback: 600 }),
    intervalSeconds: parseIntInput("interval-seconds", getInput("interval-seconds"), { min: 5, max: 3600, fallback: 15 }),
    upStatuses: parseList(getInput("up-statuses")).length ? parseList(getInput("up-statuses")) : ["Operational"],
    stableForSeconds: parseIntInput("stable-for-seconds", getInput("stable-for-seconds"), {
      min: 0,
      max: 21600,
      fallback: 0,
    }),
  };
}

/**
 * @param {{ core?: typeof core, fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => number, env?: NodeJS.ProcessEnv }} [deps]
 */
export async function run(deps = {}) {
  const c = deps.core ?? core;
  let outputs = {};
  try {
    // Mask the key before anything else can log it.
    const rawKey = c.getInput("api-key");
    if (rawKey) c.setSecret(rawKey.trim());

    const inputs = readInputs(c.getInput);
    if (!OPERATIONS.includes(inputs.operation)) {
      throw new OperationError(`Unknown operation "${inputs.operation}". Use one of: ${OPERATIONS.join(", ")}.`);
    }
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const log = { info: c.info, warning: c.warning, debug: c.debug };
    const client = createClient({
      apiKey: inputs.apiKey,
      baseUrl: inputs.apiUrl,
      fetchImpl: deps.fetchImpl,
      sleep,
      log,
    });
    outputs = await HANDLERS[inputs.operation]({
      client,
      inputs,
      log,
      sleep,
      now: deps.now ?? Date.now,
      randomUUID,
      github: readGithubContext(deps.env ?? process.env),
    });
  } catch (err) {
    if (err instanceof OperationError) outputs = err.outputs;
    for (const [k, v] of Object.entries(outputs ?? {})) c.setOutput(k, v);
    c.setFailed(err instanceof Error ? err.message : String(err));
    return;
  }
  for (const [k, v] of Object.entries(outputs)) c.setOutput(k, v);
}
