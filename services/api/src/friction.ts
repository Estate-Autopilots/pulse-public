// BUGKIT-TELEMETRY (owner, 6 Nov 2026): Insights → App friction, from telemetry (0983) and replays (1682). Leadership and
// admins; per-person adoption is admins' only, with its purpose said on the page.
//   GET  /api/v0/telemetry/friction?days=7|30   time per screen (active and idle), slowest actions, funnels, drop-off
//                                               points, rage/dead/error hotspots per screen, friction alerts, replays
//   POST /api/v0/telemetry/friction/:id         an alert: {status: 'dismissed'|'open'} or {task: true} (a Pulse task on
//                                               the company's bug project; with automatic tasks on, the dashboard opens
//                                               them for up to three new alerts as it loads)
//   GET  /api/v0/telemetry/heat?route=&days=    click, rage and dead points on one screen (fractions of the viewport)
//                                               and the newest replay frame of that screen to draw them over
//   GET  /api/v0/telemetry/replays?route=&days= sessions with a replay
//   GET  /api/v0/telemetry/replay/:sid          one session's replay chunks; /:seq one chunk's gzip bytes (masked on the
//                                               device and checked by the API before it was stored)
//   GET  /api/v0/telemetry/adoption?days=       admins: each person's sessions, active minutes, screens and features
// Alerts are found hourly by pulse.friction_scan() (installServerTiming's maintenance).
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, leadership, type Tx, type Viewer } from "./routes.js";
import { ORG_TZ } from "./org-time.js";
import { settingsOf } from "./replay.js";
import { alertTask, featureOf, FUNNELS, funnelCounts, funnelPrefilter, heatPoints, type AlertRow, type FunnelEvent } from "./friction-model.js";
import { pathTemplate } from "./telemetry-model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION = /^[A-Za-z0-9_-]{8,64}$/;
export const ADOPTION_PURPOSE = "To see who may need help getting started with Pulse. Not for performance reviews.";
const lead = (v: Viewer) => { if (!leadership(v)) fail(403, "Leadership access required"); };
const daysOf = (q: Record<string, string | undefined>) => (q.days === "30" ? 30 : q.days === "1" ? 1 : 7);
/** A detail number, or null when the field is missing or not a number. */
const num = (key: string) => `(case when jsonb_typeof(e.detail->'${key}') = 'number' then (e.detail->>'${key}')::numeric end)`;
const ERRORISH = `(e.kind like 'error.%' or (e.kind = 'api' and (e.status = 0 or e.status >= 500)))`;

async function openTask(c: PoolClient, id: string, projectId: string | null) {
  const a = (await c.query(`select id, kind, route, target, label, hits, people, sample_session, task_id from pulse.friction_alert where id = $1 for update`, [id])).rows[0] as (AlertRow & { task_id: string | null }) | undefined;
  if (!a) fail(404, "Alert not found");
  if (a!.task_id) return a!.task_id;
  const taskId = (await c.query("select pulse.task_save(null, $1) id", [JSON.stringify(alertTask(a!, projectId))])).rows[0].id as string;
  await c.query("update pulse.friction_alert set status = 'task', task_id = $2, updated_at = now() where id = $1", [id, taskId]);
  return taskId;
}

export function registerFrictionRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get("/api/v0/telemetry/friction", (request) => tx(request, async (c, v) => {
    lead(v);
    const days = daysOf(request.query as Record<string, string | undefined>);
    const since = `e.at >= now() - make_interval(days => ${days})`;
    const client = `${since} and e.source = 'client'`;
    const zone = (await c.query(`select ${ORG_TZ} as z`)).rows[0].z as string;
    const settings = await settingsOf(c);
    // Automatic bug tasks: up to three new alerts each time the dashboard loads.
    const auto: string[] = [];
    if (settings.autoTask && v.person) {
      for (const r of (await c.query("select id from pulse.friction_alert where status = 'open' and task_id is null order by last_at desc limit 3")).rows) auto.push(await openTask(c, r.id, settings.bugProjectId));
    }
    const rows = async <T>(sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows as T[];
    const timePerScreen = await rows(`select coalesce(e.name, e.page) as page, count(*)::int views, coalesce(sum(e.duration_ms), 0)::float8 "totalMs",
        coalesce(sum(${num("act")}), 0)::float8 "activeMs", coalesce(sum(${num("idle")}), 0)::float8 "idleMs",
        round(percentile_cont(0.5) within group (order by coalesce(${num("act")}, e.duration_ms)))::int "medianActiveMs"
      from pulse.telemetry_event e where ${client} and e.kind = 'nav.leave' and coalesce(e.name, e.page) is not null
      group by 1 order by "activeMs" desc, "totalMs" desc, views desc limit 30`);
    const slowestActions = await rows(`select e.page, e.name, e.kind, count(*)::int n,
        round(percentile_cont(0.5) within group (order by e.duration_ms))::int p50, round(percentile_cont(0.75) within group (order by e.duration_ms))::int p75
      from pulse.telemetry_event e where ${client} and e.kind in ('ui.click', 'ui.submit') and e.duration_ms is not null
      group by e.page, e.name, e.kind having count(*) >= 2 order by p75 desc nulls last, n desc limit 20`);
    // Funnels: the events any step could match, per session, oldest first; matched in order in friction-model.ts.
    const pre = funnelPrefilter();
    const funnelRows = await rows<FunnelEvent & { sid: string }>(`select e.session_id sid, e.kind, e.name, e.page from pulse.telemetry_event e
      where ${client} and e.session_id is not null and e.kind = any($1::text[]) and (e.kind = 'app.session' or coalesce(e.name, '') ~* $2 or coalesce(e.page, '') ~* $2)
      order by e.session_id, e.at, e.id limit 100000`, [pre.kinds, pre.pattern]);
    const bySession = new Map<string, FunnelEvent[]>();
    for (const r of funnelRows) { const list = bySession.get(r.sid) ?? []; list.push({ kind: r.kind, name: r.name, page: r.page }); bySession.set(r.sid, list); }
    const funnels = funnelCounts(FUNNELS, bySession);
    const forms = await rows(`select e.page, e.name, count(*) filter (where e.kind = 'ui.form.start')::int starts,
        count(*) filter (where e.kind = 'ui.form.abandon')::int abandons, count(*) filter (where e.kind = 'ui.form.error')::int errors
      from pulse.telemetry_event e where ${client} and e.kind in ('ui.form.start', 'ui.form.abandon', 'ui.form.error')
      group by e.page, e.name having count(*) filter (where e.kind = 'ui.form.abandon') > 0 order by abandons desc limit 20`);
    const exits = await rows(`select s.page, count(*)::int sessions from (
        select distinct on (e.session_id) e.session_id, coalesce(e.page, e.name) as page from pulse.telemetry_event e
        where ${client} and e.session_id is not null and e.kind in ('nav.load', 'nav.route', 'nav.leave') order by e.session_id, e.at desc, e.id desc) s
      where s.page is not null group by s.page order by sessions desc limit 15`);
    const hotspots = await rows<{ route: string; rage: number; dead: number; stuck: number; back: number; errors: number; toasts: number; people: number }>(`select coalesce(e.page, '/') route,
        count(*) filter (where e.kind = 'ui.rage')::int rage, count(*) filter (where e.kind = 'ui.dead')::int dead,
        count(*) filter (where e.kind = 'ui.stuck')::int stuck, count(*) filter (where e.kind = 'nav.backloop')::int back,
        count(*) filter (where ${ERRORISH})::int errors, count(*) filter (where e.kind = 'ui.toast.error')::int toasts, count(distinct e.person_id)::int people
      from pulse.telemetry_event e where ${client} and (e.kind in ('ui.rage', 'ui.dead', 'ui.stuck', 'nav.backloop', 'ui.toast.error') or ${ERRORISH})
      group by 1 order by count(*) desc limit 20`);
    const targets = await rows<{ route: string; kind: string; sel: string; label: string | null; n: number }>(`select coalesce(e.page, '/') route, e.kind, coalesce(e.detail->>'sel', '') sel, max(e.name) label, count(*)::int n
      from pulse.telemetry_event e where ${client} and e.kind in ('ui.rage', 'ui.dead') group by 1, 2, 3 order by n desc limit 60`);
    const byRoute = new Map<string, typeof targets>();
    for (const t of targets) byRoute.set(t.route, [...(byRoute.get(t.route) ?? []), t].slice(0, 5));
    const alerts = await rows(`select a.id, a.kind, a.route, a.target, a.label, a.hits, a.people, a.sample_session "sampleSession", a.first_at "firstAt", a.last_at "lastAt",
        a.status, a.task_id "taskId" from pulse.friction_alert a where a.status in ('open', 'task')
      order by (a.status = 'open') desc, a.last_at desc limit 50`);
    const replays = await rows(`select r.session_id sid, max(p.display_name) who, (array_agg(r.route order by r.seq))[1] route, min(r.started_at) started, max(r.ended_at) ended,
        count(*)::int chunks, max(r.reason) reason,
        (select count(*)::int from pulse.telemetry_event e where e.session_id = r.session_id and e.source = 'client' and (e.kind in ('ui.rage', 'ui.dead', 'ui.stuck') or ${ERRORISH})) friction
      from pulse.telemetry_replay r left join pulse.person p on p.id = r.person_id
      where r.created_at >= now() - make_interval(days => ${days}) group by r.session_id order by max(r.ended_at) desc limit 30`);
    return { days, zone, settings: { autoTask: settings.autoTask, replay: settings.enabled && settings.replay, enabled: settings.enabled, retentionDays: settings.retentionDays },
      autoTasks: auto.length, timePerScreen, slowestActions, funnels, dropOffs: { forms, exits },
      hotspots: hotspots.map((h) => ({ ...h, targets: byRoute.get(h.route) ?? [] })), alerts, replays, canSeeAdoption: v.role === "admin" };
  }));

  app.post<{ Params: { id: string } }>("/api/v0/telemetry/friction/:id", { schema: { body: { type: "object", maxProperties: 4 } } }, (request) => tx(request, async (c, v) => {
    lead(v);
    const id = UUID.test(request.params.id) ? request.params.id : fail(404, "Alert not found");
    const b = (request.body ?? {}) as Record<string, unknown>;
    if (b.task === true) {
      if (!v.person) fail(403, "Making a task needs your own Pulse sign-in");
      const taskId = await openTask(c, id, (await settingsOf(c)).bugProjectId);
      return { id, status: "task", taskId };
    }
    if (b.status !== "dismissed" && b.status !== "open") fail(400, "Choose dismiss or reopen, or make a task");
    const r = await c.query("update pulse.friction_alert set status = $2, updated_at = now() where id = $1 and status <> 'task' returning id, status", [id, b.status]);
    if (!r.rowCount) fail(404, "Alert not found or already a task");
    return r.rows[0];
  }));

  app.get("/api/v0/telemetry/heat", (request) => tx(request, async (c, v) => {
    lead(v);
    const q = request.query as Record<string, string | undefined>;
    const route = pathTemplate(q.route);
    if (!route) fail(400, "Choose a screen");
    const days = daysOf(q) === 1 ? 7 : daysOf(q);
    const raw = (await c.query(`select e.kind, e.detail->>'fx' fx, e.detail->>'fy' fy from pulse.telemetry_event e
      where e.at >= now() - make_interval(days => ${days}) and e.source = 'client' and e.page = $1 and e.kind in ('ui.click', 'ui.rage', 'ui.dead')
        and jsonb_typeof(e.detail->'fx') = 'number' and jsonb_typeof(e.detail->'fy') = 'number' order by e.at desc limit 2000`, [route])).rows;
    const frame = (await c.query(`select r.session_id sid, r.seq from pulse.telemetry_replay r
      where r.route = $1 or split_part(r.route, '?', 1) = split_part($1, '?', 1) order by (r.route = $1) desc, r.started_at desc, r.seq limit 1`, [route])).rows[0] ?? null;
    const vp = (await c.query(`select ${num("vw")}::int w, ${num("vh")}::int h, count(*) n from pulse.telemetry_event e
      where e.at >= now() - make_interval(days => ${days}) and e.source = 'client' and e.kind = 'nav.load' and e.page = $1 and ${num("vw")} is not null
      group by 1, 2 order by n desc limit 1`, [route])).rows[0];
    return { route, days, points: heatPoints(raw), frame, viewport: vp ? { width: vp.w, height: vp.h } : { width: 1440, height: 900 } };
  }));

  app.get("/api/v0/telemetry/replays", (request) => tx(request, async (c, v) => {
    lead(v);
    const q = request.query as Record<string, string | undefined>;
    const route = q.route ? pathTemplate(q.route) : null;
    const days = daysOf(q);
    const zone = (await c.query(`select ${ORG_TZ} as z`)).rows[0].z as string;
    const rows = (await c.query(`select r.session_id sid, max(p.display_name) who, (array_agg(r.route order by r.seq))[1] route, min(r.started_at) started,
        max(r.ended_at) ended, count(*)::int chunks, max(r.reason) reason, sum(r.bytes)::int bytes
      from pulse.telemetry_replay r left join pulse.person p on p.id = r.person_id
      where r.created_at >= now() - make_interval(days => ${days}) and ($1::text is null or r.route = $1)
      group by r.session_id order by max(r.ended_at) desc limit 100`, [route])).rows;
    return { days, zone, route, rows };
  }));

  app.get<{ Params: { sid: string } }>("/api/v0/telemetry/replay/:sid", (request) => tx(request, async (c, v) => {
    lead(v);
    const sid = SESSION.test(request.params.sid) ? request.params.sid : fail(404, "Replay not found");
    const chunks = (await c.query(`select r.seq, r.route, r.started_at "startedAt", r.ended_at "endedAt", r.events, r.bytes, r.reason
      from pulse.telemetry_replay r where r.session_id = $1 order by r.seq limit 500`, [sid])).rows;
    if (!chunks.length) fail(404, "Replay not found");
    const who = (await c.query(`select p.display_name name from pulse.telemetry_replay r join pulse.person p on p.id = r.person_id where r.session_id = $1 limit 1`, [sid])).rows[0]?.name ?? null;
    const zone = (await c.query(`select ${ORG_TZ} as z`)).rows[0].z as string;
    return { sid, zone, who, chunks };
  }));

  app.get<{ Params: { sid: string; seq: string } }>("/api/v0/telemetry/replay/:sid/:seq", async (request, reply) => {
    const sid = request.params.sid, seq = Number(request.params.seq);
    const row = await tx(request, async (c, v) => {
      lead(v);  // the role first: someone outside leadership gets 403 whatever the address, as on /replay/:sid
      if (!SESSION.test(sid) || !Number.isInteger(seq) || seq < 0 || seq > 100_000) fail(404, "Replay not found");
      return (await c.query("select data from pulse.telemetry_replay where session_id = $1 and seq = $2", [sid, seq])).rows[0] as { data: Buffer } | undefined;
    });
    if (!row) fail(404, "Replay not found");
    return reply.header("content-type", "application/gzip").header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox").send(row!.data);
  });

  app.get("/api/v0/telemetry/adoption", (request) => tx(request, async (c, v) => {
    if (v.role !== "admin") fail(403, "Per-person usage is for admins only");
    const days = daysOf(request.query as Record<string, string | undefined>);
    const zone = (await c.query(`select ${ORG_TZ} as z`)).rows[0].z as string;
    const people = (await c.query<{ personId: string; name: string | null; role: string | null; sessions: number; activeMinutes: number; pages: string[]; lastSeen: string }>(`select e.person_id "personId", max(p.display_name) name, max(e.role) role,
        count(distinct e.session_id)::int sessions, round(coalesce(sum(${num("act")}) filter (where e.kind = 'nav.leave'), 0) / 60000.0, 1)::float8 "activeMinutes",
        coalesce(array_agg(distinct e.page) filter (where e.kind in ('nav.load', 'nav.route') and e.page is not null), '{}') pages, max(e.at) "lastSeen"
      from pulse.telemetry_event e left join pulse.person p on p.id = e.person_id
      where e.at >= now() - make_interval(days => ${days}) and e.source = 'client' and e.person_id is not null
      group by e.person_id order by "activeMinutes" desc, sessions desc limit 300`)).rows;
    const notSeen = (await c.query(`select p.id "personId", p.display_name name from pulse.person p
      where p.side = 'staff' and p.status = 'active' and not exists (select 1 from pulse.telemetry_event e where e.person_id = p.id and e.source = 'client'
        and e.at >= now() - make_interval(days => ${days})) order by p.display_name limit 200`)).rows;
    return { days, zone, purpose: ADOPTION_PURPOSE,
      people: people.map(({ pages, ...p }) => { const features = [...new Set(pages.map(featureOf))]; return { ...p, screens: pages.length, features: features.length, featureList: features.slice(0, 8) }; }),
      notSeen };
  }));
}
