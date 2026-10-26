// TELEMETRY (owner, 24 Oct 2026): every movement in the app is measured so response times can be improved.
//   POST /api/v0/telemetry                 a browser's batch (the signed-in person's session; 256 KB, 300 events, a budget
//                                          per person a minute); rows are stored in the viewer's company as that person
//   GET  /api/v0/telemetry                 leadership's overview: slowest pages, interactions and API routes (p50/p75/p95),
//                                          errors, people and roles, web vitals, trends by day and by app version
//   GET  /api/v0/telemetry/sessions/:id    one session's timeline: every route, click and API call in order, each API
//                                          call joined to the API's own timing by its request id
// installServerTiming (server.ts) times every API request (route template, status, duration, database time, the browser's
// request id) and writes the rows in small batches every few seconds, never on the request's path; it also runs
// pulse.telemetry_maintain() (rollups and retention, migration 0983) every hour.
import { AsyncLocalStorage } from "node:async_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import pg, { type Pool, type PoolClient } from "pg";
import { fail, leadership, type Tx, type Viewer } from "./routes.js";
import { requestCompany } from "./tenant-context.js";
import { ORG_TZ } from "./org-time.js";
import { cleanBatch, TelemetryBudget, type TelemetryRow } from "./telemetry-model.js";
import { createHash } from "node:crypto";

export const TELEMETRY_PATH = "/api/v0/telemetry";
const INSERT = `insert into pulse.telemetry_event (org_id, at, source, kind, name, page, duration_ms, value, status, session_id, request_id,
    person_id, role, app_version, shell_version, platform, device, detail)
  select pulse.current_org(), e.at, $2, e.kind, e.name, e.page, e.duration_ms, e.value, e.status, e.session_id, e.request_id,
    coalesce(e.person_id, $3::uuid), coalesce(e.role, $4), e.app_version, e.shell_version, e.platform, e.device, e.detail
  from jsonb_to_recordset($1::jsonb) as e(at timestamptz, kind text, name text, page text, duration_ms integer, value double precision,
    status integer, session_id text, request_id text, person_id uuid, role text, app_version text, shell_version text, platform text,
    device text, detail jsonb)`;
const enabled = () => process.env.PULSE_TELEMETRY !== "0";
const AGENT_SAMPLE = 50;

// ---------------------------------------------------------------------------------------------------- server timing
type Timing = { db: number; q: number; org: string | null; person: string | null; role: string | null; cold?: boolean };
const timing = new AsyncLocalStorage<Timing>();
const TIMED = Symbol("pulse.timing");
const USED = Symbol("pulse.used");

/** routes.ts's tx: the request's viewer, so the API's own timing row names the company, person and role. */
export function noteViewer(v: Pick<Viewer, "org" | "person" | "role">) {
  const t = timing.getStore();
  if (t) { t.org = v.org; t.person = v.person; t.role = v.role; }
}

let patched = false;
/** Database time per request: every promise query on a pg client is timed into the request that issued it. */
function timeQueries() {
  if (patched) return;
  patched = true;
  const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = proto.query;
  proto.query = function query(this: unknown, ...args: unknown[]) {
    const t = timing.getStore();
    // PERF: a connection's first query (a new connection: no cached catalog or plans yet) marks its request cold.
    const client = this as Record<symbol, boolean>;
    const fresh = !client[USED];
    client[USED] = true;
    const result = original.apply(this, args);
    if (!t || !result || typeof (result as Promise<unknown>).then !== "function") return result;
    const start = performance.now();
    t.q++;
    if (fresh) t.cold = true;
    return (result as Promise<unknown>).finally(() => { t.db += performance.now() - start; });
  };
}

/** Requests the API times: its own routes, but not health, the telemetry ingest itself or a live event stream. */
const timed = (url: string) => /^\/(api\/)?v[01]\//.test(url) && !url.startsWith(TELEMETRY_PATH) && !/\/events(\?|$)/.test(url);

type ServerRow = TelemetryRow & { org: string; person_id: string | null; role: string | null };

/** Times every API request and writes the rows in batches (every `everyMs`, at most `max` waiting; the rest are dropped
 *  and counted). Runs telemetry_maintain() after a minute and then hourly. Stops with the app. */
export function installServerTiming(app: FastifyInstance, pool: Pool, { everyMs = 5000, max = 5000, maintainMs = 3_600_000 } = {}) {
  if (!enabled()) return { flush: async () => {} };
  timeQueries();
  const waiting: ServerRow[] = [];
  let dropped = 0, flushing: Promise<void> | null = null, warnedAt = 0, agentCalls = 0;
  const version = process.env.PULSE_RELEASE ?? "dev";
  app.addHook("onRequest", (request, _reply, done) => {
    if (!timed(request.url)) { done(); return; }
    const t: Timing = { db: 0, q: 0, org: null, person: null, role: null };
    (request as unknown as Record<symbol, Timing>)[TIMED] = t;
    timing.run(t, done);
  });
  app.addHook("preHandler", (request, _reply, done) => {
    const t = (request as unknown as Record<symbol, Timing | undefined>)[TIMED];
    if (t && !t.org) { const rc = requestCompany(); t.org = rc?.company?.org ?? rc?.hostOrg ?? rc?.installOrg ?? null; }
    done();
  });
  app.addHook("onResponse", (request: FastifyRequest, reply, done) => {
    const t = (request as unknown as Record<symbol, Timing | undefined>)[TIMED];
    const route = request.routeOptions?.url;
    // AI co-workers' runtime polls its routes many times a minute: one in AGENT_SAMPLE is kept (and every 5xx), marked.
    const sampled = route?.startsWith("/api/v0/agent/") && reply.statusCode < 500;
    if (t && t.org && route && (!sampled || ++agentCalls % AGENT_SAMPLE === 0)) {
      if (waiting.length >= max) dropped++;
      else {
        const id = request.headers["x-pulse-request-id"];
        const elapsed = reply.elapsedTime;
        waiting.push({
          org: t.org, person_id: t.person, role: t.role,
          at: new Date(Date.now() - elapsed).toISOString(), kind: "api.server", name: `${request.method} ${route}`.slice(0, 200), page: null,
          duration_ms: Math.round(elapsed), value: Math.round(t.db * 10) / 10, status: reply.statusCode, session_id: null,
          request_id: typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null,
          app_version: version, shell_version: null, platform: "server", device: null, detail: { q: t.q, ...(t.cold ? { cold: 1 } : {}), ...(sampled ? { sample: AGENT_SAMPLE } : {}) },
        });
      }
    }
    done();
  });
  const warn = (what: string, error: unknown) => {
    if (Date.now() - warnedAt < 60_000) return;
    warnedAt = Date.now();
    app.log.warn({ code: (error as { code?: string })?.code ?? "unknown", dropped }, what);
  };
  const write = async () => {
    const rows = waiting.splice(0, waiting.length);
    const byOrg = new Map<string, ServerRow[]>();
    for (const row of rows) byOrg.set(row.org, [...(byOrg.get(row.org) ?? []), row]);
    for (const [org, list] of byOrg) {
      let c: PoolClient | undefined;
      try {
        c = await pool.connect();
        await c.query("begin");
        await c.query("select set_config('pulse.org_id',$1,true)", [org]);
        for (let i = 0; i < list.length; i += 500) await c.query(INSERT, [JSON.stringify(list.slice(i, i + 500)), "server", null, null]);
        await c.query("commit");
      } catch (error) {
        await c?.query("rollback").catch(() => {});
        dropped += list.length;
        warn("API timing rows not written", error);
      } finally { c?.release(); }
    }
  };
  const flush = () => {
    if (!flushing && waiting.length) flushing = write().finally(() => { flushing = null; });
    return flushing ?? Promise.resolve();
  };
  const maintain = async () => {
    try { await pool.query("select pulse.telemetry_maintain()"); } catch (error) { warn("Telemetry rollup failed", error); }
  };
  const timer = setInterval(() => void flush(), everyMs);
  const first = setTimeout(() => void maintain(), 60_000);
  const hourly = setInterval(() => void maintain(), maintainMs);
  for (const t of [timer, first, hourly]) t.unref();
  app.addHook("onClose", async () => { clearInterval(timer); clearTimeout(first); clearInterval(hourly); await flush(); await flushing; });
  return { flush };
}

// ---------------------------------------------------------------------------------------------------- routes
const budget = new TelemetryBudget();
const DAYS = [1, 7, 30] as const;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;

/** Who a batch's budget belongs to, before the session is read: the session, the Access identity or the address. */
function budgetKey(request: FastifyRequest): string {
  const h = request.headers;
  const who = [h["x-pulse-session"], h["cf-access-authenticated-user-email"], h["x-pulse-client-ip"], request.ip].find((x) => typeof x === "string" && x);
  return createHash("sha256").update(String(who ?? "anonymous")).digest("hex").slice(0, 32);
}

export function registerTelemetryRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.post(TELEMETRY_PATH, { bodyLimit: 262_144, config: { keepsCache: true } }, (request) => {
    const batch = cleanBatch(request.body);
    return tx(request, async (c, v) => {
      if (!batch) fail(400, "Send a telemetry batch");
      if (!budget.take(budgetKey(request), batch!.rows.length)) fail(429, "Too many telemetry events; Pulse sends them again shortly");
      if (enabled() && batch!.rows.length) await c.query(INSERT, [JSON.stringify(batch!.rows), "client", v.person, v.role]);
      return { accepted: enabled() ? batch!.rows.length : 0, dropped: batch!.dropped };
    });
  });

  app.get(TELEMETRY_PATH, (request) => tx(request, async (c, v) => {
    if (!leadership(v)) fail(403, "Leadership access required");
    const q = request.query as Record<string, string | undefined>;
    const days = DAYS.find((d) => String(d) === q.days) ?? 7;
    const platform = ["web", "android", "ios", "desktop"].includes(q.platform ?? "") ? q.platform! : null;
    const since = `now() - make_interval(days => ${days})`;
    const where = `e.at >= ${since} and ($1::text is null or e.platform = $1 or e.source = 'server')`;
    const rows = async <T>(sql: string, args: unknown[] = []) => (await c.query(sql, [platform, ...args])).rows as T[];
    const pct = (col: string) => `round(percentile_cont(0.5) within group (order by ${col}))::int p50, round(percentile_cont(0.75) within group (order by ${col}))::int p75, round(percentile_cont(0.95) within group (order by ${col}))::int p95`;
    const zone = (await c.query(`select ${ORG_TZ} as z`)).rows[0].z as string;
    const [totals] = await rows<Record<string, number>>(`select count(*)::int events, count(distinct e.session_id)::int sessions, count(distinct e.person_id) filter (where e.source = 'client')::int people,
        count(*) filter (where e.kind in ('nav.load','nav.route'))::int views, count(*) filter (where e.kind in ('ui.click','ui.submit'))::int actions,
        count(*) filter (where e.kind = 'api')::int "apiCalls",
        count(*) filter (where e.kind like 'error.%' or (e.kind = 'api' and (e.status = 0 or e.status >= 500)))::int errors,
        round(percentile_cont(0.75) within group (order by e.duration_ms) filter (where e.kind in ('nav.load','nav.route')))::int "viewP75",
        round(percentile_cont(0.75) within group (order by e.duration_ms) filter (where e.kind in ('ui.click','ui.submit')))::int "actionP75",
        round(percentile_cont(0.75) within group (order by e.duration_ms) filter (where e.kind = 'api.server'))::int "serverP75"
      from pulse.telemetry_event e where ${where}`);
    const pages = await rows(`select e.name, e.kind, count(*)::int n, ${pct("e.duration_ms")}
      from pulse.telemetry_event e where ${where} and e.kind in ('nav.load','nav.route') and e.duration_ms is not null
      group by e.name, e.kind order by p75 desc nulls last, n desc limit 25`);
    const actions = await rows(`select e.page, e.name, e.kind, count(*)::int n, ${pct("e.duration_ms")}
      from pulse.telemetry_event e where ${where} and e.kind in ('ui.click','ui.submit') and e.duration_ms is not null
      group by e.page, e.name, e.kind order by p75 desc nulls last, n desc limit 25`);
    const server = await rows(`select e.name, count(*)::int n, ${pct("e.duration_ms")}, round(percentile_cont(0.5) within group (order by e.value))::int "dbP50",
        count(*) filter (where e.status >= 500)::int errors
      from pulse.telemetry_event e where ${where} and e.kind = 'api.server'
      group by e.name order by p95 desc nulls last, n desc limit 25`);
    const client = await rows(`select e.name, count(*)::int n, ${pct("e.duration_ms")}, count(*) filter (where e.status = 0 or e.status >= 500)::int errors,
        round(avg((e.detail->>'bytes')::numeric))::int bytes
      from pulse.telemetry_event e where ${where} and e.kind = 'api'
      group by e.name order by p95 desc nulls last, n desc limit 25`);
    const vitals = await rows(`select e.kind, count(*)::int n, ${pct("e.duration_ms")}, round((percentile_cont(0.75) within group (order by e.value))::numeric, 3)::float8 "valueP75"
      from pulse.telemetry_event e where ${where} and e.kind like 'vital.%' group by e.kind order by e.kind`);
    const longTasks = await rows(`select e.page, count(*)::int n, sum(e.duration_ms)::int as total, max(e.duration_ms)::int as max
      from pulse.telemetry_event e where ${where} and e.kind = 'perf.longtask' group by e.page order by total desc limit 10`);
    const errors = await rows(`select e.kind, coalesce(e.name, '') as name, e.page, count(*)::int n, max(e.at) as last
      from pulse.telemetry_event e where ${where} and (e.kind like 'error.%' or (e.kind in ('api','api.server') and (e.status = 0 or e.status >= 500)))
      group by e.kind, e.name, e.page order by n desc, last desc limit 25`);
    const people = await rows(`select e.person_id "personId", p.display_name as name, max(e.role) as role, count(*)::int events, count(distinct e.session_id)::int sessions,
        count(*) filter (where e.kind in ('nav.load','nav.route'))::int views, count(*) filter (where e.kind in ('ui.click','ui.submit'))::int actions,
        count(*) filter (where e.kind like 'error.%' or (e.kind = 'api' and (e.status = 0 or e.status >= 500)))::int errors,
        round(percentile_cont(0.75) within group (order by e.duration_ms) filter (where e.kind in ('ui.click','ui.submit')))::int "actionP75", max(e.at) as last
      from pulse.telemetry_event e left join pulse.person p on p.id = e.person_id
      where ${where} and e.source = 'client' and e.person_id is not null group by e.person_id, p.display_name order by events desc limit 50`);
    const roles = await rows(`select coalesce(e.role, 'unknown') as role, count(distinct e.person_id)::int people, count(distinct e.session_id)::int sessions, count(*)::int events,
        round(percentile_cont(0.75) within group (order by e.duration_ms) filter (where e.kind in ('nav.load','nav.route')))::int "viewP75",
        round(percentile_cont(0.75) within group (order by e.duration_ms) filter (where e.kind in ('ui.click','ui.submit')))::int "actionP75",
        round(percentile_cont(0.75) within group (order by e.duration_ms) filter (where e.kind = 'api'))::int "apiP75"
      from pulse.telemetry_event e where ${where} and e.source = 'client' group by 1 order by events desc`);
    const sessions = await rows(`select e.session_id as id, max(p.display_name) as name, max(e.role) as role, max(e.platform) as platform, max(e.app_version) as version,
        min(e.at) as start, max(e.at) as "end", count(*)::int as events,
        count(*) filter (where e.kind like 'error.%' or (e.kind = 'api' and (e.status = 0 or e.status >= 500)))::int errors
      from pulse.telemetry_event e left join pulse.person p on p.id = e.person_id
      where ${where} and e.source = 'client' and e.session_id is not null group by e.session_id order by max(e.at) desc limit 40`);
    // Trends: the hourly rollups (telemetry_daily), all names together.
    const trend = await rows(`select d.day::text as day,
        sum(d.events) filter (where d.source = 'client')::int events, sum(d.errors)::int errors,
        max(d.people) filter (where d.source = 'client')::int people,
        round(max(d.p75_ms) filter (where d.kind = 'nav.route'))::int "routeP75", round(max(d.p75_ms) filter (where d.kind = 'nav.load'))::int "loadP75",
        round(max(d.p75_ms) filter (where d.kind = 'ui.click'))::int "clickP75", round(max(d.p75_ms) filter (where d.kind = 'api'))::int "apiP75",
        round(max(d.p75_ms) filter (where d.kind = 'api.server'))::int "serverP75"
      from pulse.telemetry_daily d where d.day >= (now() at time zone $2)::date - $3::int and d.name = '*' and d.platform = '*' and d.role = '*'
        and ($1::text is null or true)
      group by d.day order by d.day`, [zone, Math.max(days, 14)]);
    const versions = await rows(`select d.app_version as version, d.platform, sum(d.events)::int events, sum(d.errors)::int errors, min(d.day)::text as first, max(d.day)::text as last,
        round(max(d.p75_ms) filter (where d.kind in ('nav.route')))::int "routeP75", round(max(d.p75_ms) filter (where d.kind = 'ui.click'))::int "clickP75",
        round(max(d.p75_ms) filter (where d.kind = 'api'))::int "apiP75", round(max(d.p75_ms) filter (where d.kind = 'api.server'))::int "serverP75"
      from pulse.telemetry_daily d where d.day >= (now() at time zone $2)::date - $3::int and d.name = '*' and d.role = '*' and d.platform <> '*'
        and ($1::text is null or d.platform = $1 or d.platform = 'server')
      group by d.app_version, d.platform order by max(d.day) desc, events desc limit 20`, [zone, days]);
    return { days, platform, zone, totals, pages, actions, server, client, vitals, longTasks, errors, people, roles, sessions, trend, versions };
  }));

  // PERF: the slowest things now against the day before. Pages and API routes by p50/p95 (the last 24 hours beside the
  // 24 before), the browser's wait beside the API's own time (the difference is the network and the web server), the
  // slowest single movements with what they waited for, and what a page's server render waited on (the API calls that
  // carry the document's request id, set by the web's proxy.ts).
  app.get(`${TELEMETRY_PATH}/slowest`, (request) => tx(request, async (c, v) => {
    if (!leadership(v)) fail(403, "Leadership access required");
    const q = request.query as Record<string, string | undefined>;
    const platform = ["web", "android", "ios", "desktop"].includes(q.platform ?? "") ? q.platform! : null;
    // Every query reads the platform ($1); server rows (platform 'server') always pass.
    const rows = async <T>(sql: string) => (await c.query(sql, [platform])).rows as T[];
    const plat = `($1::text is null or e.platform = $1 or e.source = 'server')`;
    const now = `e.at >= now() - interval '24 hours'`;
    const both = (col: string) => `count(*) filter (where cur)::int n,
        round(percentile_cont(0.5) within group (order by ${col}) filter (where cur))::int p50,
        round(percentile_cont(0.95) within group (order by ${col}) filter (where cur))::int p95,
        count(*) filter (where not cur)::int "nBefore",
        round(percentile_cont(0.5) within group (order by ${col}) filter (where not cur))::int "p50Before",
        round(percentile_cont(0.95) within group (order by ${col}) filter (where not cur))::int "p95Before"`;
    const pages = await rows(`select e.name, e.kind, ${both("e.duration_ms")}
      from (select e.*, ${now} as cur from pulse.telemetry_event e where e.at >= now() - interval '48 hours' and ${plat}
              and e.kind in ('nav.load','nav.route') and e.duration_ms is not null) e
      group by e.name, e.kind having count(*) filter (where cur) > 0 order by p95 desc nulls last, n desc limit 30`);
    const server = await rows<{ name: string; n: number; p50: number | null; p95: number | null; nBefore: number; p50Before: number | null; p95Before: number | null; dbP50: number | null; queries: number | null; errors: number; totalMs: number }>(
      `select e.name, ${both("e.duration_ms")}, round(percentile_cont(0.5) within group (order by e.value) filter (where cur))::int "dbP50",
        round(avg((e.detail->>'q')::numeric) filter (where cur), 1)::float8 queries, count(*) filter (where cur and e.status >= 500)::int errors,
        coalesce(sum(e.duration_ms) filter (where cur), 0)::int "totalMs"
      from (select e.*, ${now} as cur from pulse.telemetry_event e where e.at >= now() - interval '48 hours' and ${plat} and e.kind = 'api.server') e
      group by e.name having count(*) filter (where cur) > 0 order by p95 desc nulls last, n desc limit 40`);
    // The browser's wait for the same request, joined on the request id the browser sent.
    const waits = await rows<{ name: string; n: number; browserP50: number | null; browserP95: number | null; netP50: number | null }>(
      `select s.name, count(*)::int n, round(percentile_cont(0.5) within group (order by e.duration_ms))::int "browserP50",
        round(percentile_cont(0.95) within group (order by e.duration_ms))::int "browserP95",
        round(percentile_cont(0.5) within group (order by greatest(0, e.duration_ms - s.duration_ms)))::int "netP50"
      from pulse.telemetry_event e join pulse.telemetry_event s on s.request_id = e.request_id and s.source = 'server' and s.kind = 'api.server'
      where ${now} and ${plat} and e.kind = 'api' and e.request_id is not null and e.duration_ms is not null
      group by s.name`);
    const wait = new Map(waits.map((w) => [w.name, w]));
    const api = server.map((s) => ({ ...s, browserP50: wait.get(s.name)?.browserP50 ?? null, browserP95: wait.get(s.name)?.browserP95 ?? null, netP50: wait.get(s.name)?.netP50 ?? null }));
    const [network] = await rows<{ n: number; p50: number | null; p95: number | null }>(`select count(*)::int n,
        round(percentile_cont(0.5) within group (order by greatest(0, e.duration_ms - s.duration_ms)))::int p50,
        round(percentile_cont(0.95) within group (order by greatest(0, e.duration_ms - s.duration_ms)))::int p95
      from pulse.telemetry_event e join pulse.telemetry_event s on s.request_id = e.request_id and s.source = 'server' and s.kind = 'api.server'
      where ${now} and ${plat} and e.kind = 'api' and e.request_id is not null and e.duration_ms is not null`);
    // A request whose database connection was new (no cached catalog or plans): how many, and their time beside the rest.
    const [connections] = await rows<{ n: number; cold: number; coldP50: number | null; warmP50: number | null }>(`select count(*)::int n,
        count(*) filter (where e.detail ? 'cold')::int cold,
        round(percentile_cont(0.5) within group (order by e.duration_ms) filter (where e.detail ? 'cold'))::int "coldP50",
        round(percentile_cont(0.5) within group (order by e.duration_ms) filter (where not e.detail ? 'cold'))::int "warmP50"
      from pulse.telemetry_event e where ${now} and ${plat} and e.kind = 'api.server'`);
    // Each person's Cloudflare location and the round trip to it alone (perf.edge): what the network costs before Pulse.
    const edges = await rows(`select e.name as colo, count(*)::int n, round(percentile_cont(0.5) within group (order by e.duration_ms))::int p50,
        round(percentile_cont(0.95) within group (order by e.duration_ms))::int p95, count(distinct e.person_id)::int people
      from pulse.telemetry_event e where e.at >= now() - interval '7 days' and ${plat} and e.kind = 'perf.edge' and e.duration_ms is not null
      group by e.name order by n desc limit 12`);
    const moments = await rows(`select e.at, e.kind, e.name, e.page, e.duration_ms "durationMs", e.session_id "sessionId", e.platform,
        e.detail->>'pending' as pending, e.detail->>'wait' as wait, e.detail->>'cut' as cut, (e.detail->>'api')::int as api
      from pulse.telemetry_event e where ${now} and ${plat} and e.kind in ('ui.click','ui.submit','ui.key','nav.route','nav.load') and e.duration_ms is not null
      order by e.duration_ms desc limit 25`);
    // A document's first byte: the browser's TTFB beside the server-side API calls its render made (same request id).
    const renders = await rows(`select e.name, count(*)::int n,
        round(percentile_cont(0.5) within group (order by (e.detail->>'ttfb')::int))::int "ttfbP50",
        round(percentile_cont(0.95) within group (order by (e.detail->>'ttfb')::int))::int "ttfbP95",
        round(percentile_cont(0.5) within group (order by s.calls))::int "callsP50",
        round(percentile_cont(0.5) within group (order by s.span))::int "apiP50",
        round(percentile_cont(0.5) within group (order by e.duration_ms))::int "readyP50"
      from pulse.telemetry_event e
      left join lateral (select count(*)::int calls,
          extract(epoch from max(x.at + make_interval(secs => x.duration_ms / 1000.0)) - min(x.at)) * 1000 as span
        from pulse.telemetry_event x where x.request_id = e.request_id and x.source = 'server') s on true
      where ${now} and ${plat} and e.kind = 'nav.load' and e.request_id is not null
      group by e.name order by "ttfbP50" desc nulls last limit 25`);
    return { platform, network: network ?? { n: 0, p50: null, p95: null }, connections, edges, pages, api, moments, renders };
  }));

  app.get<{ Params: { id: string } }>(`${TELEMETRY_PATH}/sessions/:id`,(request) => tx(request, async (c, v) => {
    if (!leadership(v)) fail(403, "Leadership access required");
    const id = request.params.id;
    if (!SESSION.test(id)) fail(400, "Choose a session");
    const events = (await c.query(`select e.id::text, e.at, e.kind, e.name, e.page, e.duration_ms "durationMs", e.value, e.status, e.request_id "requestId",
        e.platform, e.app_version as version, e.detail, s.duration_ms "serverMs", s.value "dbMs", s.name "serverRoute"
      from pulse.telemetry_event e
      left join lateral (select x.duration_ms, x.value, x.name from pulse.telemetry_event x
        where e.request_id is not null and x.request_id = e.request_id and x.source = 'server' order by x.at limit 1) s on true
      where e.session_id = $1 and e.source = 'client' order by e.at, e.id limit 2000`, [id])).rows;
    const who = (await c.query(`select p.display_name as name, e.role, min(e.at) as start, max(e.at) as "end" from pulse.telemetry_event e
      left join pulse.person p on p.id = e.person_id where e.session_id = $1 and e.source = 'client' group by p.display_name, e.role limit 1`, [id])).rows[0] ?? null;
    const zone = (await c.query(`select ${ORG_TZ} as z`)).rows[0].z as string;
    return { id, zone, who, events };
  }));
}
