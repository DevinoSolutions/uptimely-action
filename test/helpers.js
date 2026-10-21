import { createClient } from "../src/client.js";

export const KEY = "uptimely_live_test_key_not_real";

export const M1 = "11111111-1111-4111-8111-111111111111";
export const M2 = "22222222-2222-4222-8222-222222222222";
export const M3 = "33333333-3333-4333-8333-333333333333";

export function json(status, body, headers = {}) {
  return { status, body, headers };
}

export function problem(status, code, detail, headers = {}) {
  return json(status, { type: `https://getuptimely.com/problems/${code}`, title: code, status, code, detail, request_id: "req_123" }, headers);
}

/**
 * A fake fetch. `routes` maps "METHOD /path" to either a response, an array of
 * responses (consumed in order, the last one repeats) or a function
 * (call) => response. Responses may be an Error to simulate a network failure.
 */
export function mockFetch(routes) {
  const calls = [];
  const queues = new Map(Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]));
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const call = {
      method: init.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const key = `${init.method} ${u.pathname}`;
    let entry = queues.get(key);
    if (entry === undefined) throw new Error(`unexpected request ${key}`);
    if (Array.isArray(entry)) entry = entry.length > 1 ? entry.shift() : entry[0];
    const res = typeof entry === "function" ? entry(call) : entry;
    if (res instanceof Error) throw res;
    const text = res.body === undefined ? "" : JSON.stringify(res.body);
    return new Response(text, { status: res.status, headers: { "content-type": "application/json", ...res.headers } });
  };
  return { fetchImpl, calls };
}

export function makeClient(routes, extra = {}) {
  const { fetchImpl, calls } = mockFetch(routes);
  const sleeps = [];
  const warnings = [];
  const client = createClient({
    apiKey: KEY,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: { warning: (m) => warnings.push(m) },
    ...extra,
  });
  return { client, calls, sleeps, warnings };
}

export function makeLog() {
  const lines = { info: [], warning: [] };
  return {
    lines,
    log: { info: (m) => lines.info.push(m), warning: (m) => lines.warning.push(m), debug: () => {} },
  };
}

export function monitor(id, name, extra = {}) {
  return {
    id,
    name,
    description: null,
    monitor_type: "Website",
    status: { name: "Operational", color: "#2ab27b" },
    active_monitoring_disabled: false,
    failure_threshold: 2,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

export function page(data, next = null) {
  return json(200, { data, has_more: next !== null, next_cursor: next });
}

export function baseInputs(over = {}) {
  return {
    monitorIds: [],
    labels: [],
    muteMinutes: 30,
    url: "",
    name: "",
    monitorType: "",
    description: "",
    monitoringInterval: "",
    failureThreshold: undefined,
    monitorId: "",
    timeoutSeconds: 600,
    intervalSeconds: 15,
    upStatuses: ["Operational"],
    stableForSeconds: 0,
    ...over,
  };
}

let uuidCounter = 0;
export const fakeUUID = () => `idem-${++uuidCounter}`;
