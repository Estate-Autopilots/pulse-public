// DITASU-FIX (owner, 17 Nov 2026): one person's day, for leadership (the same people who see /telemetry):
//   GET /api/v0/telemetry/day?person=<id>&date=YYYY-MM-DD
//     the people with usage in the last 30 days (to choose from), and for the chosen person and day (the company's own
//     calendar day): their sessions with the replay each has, the day as plain steps, the moments they struggled (found
//     by struggle-model.ts) and what was slow for them. Read-only; row security keeps it inside the viewer's company.
import type { FastifyInstance } from "fastify";
import { fail, leadership, type Tx } from "./routes.js";
import { ORG_TZ } from "./org-time.js";
import { buildDay, type DayRow } from "./struggle-model.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 8000;

export function registerTelemetryDayRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get("/api/v0/telemetry/day", (request) => tx(request, async (c, v) => {
    if (!leadership(v)) fail(403, "Leadership access required");
    const q = request.query as Record<string, string | undefined>;
    const zone = (await c.query(`select ${ORG_TZ} as z`)).rows[0].z as string;
    // Beside each person, a hint of trouble in the last 7 days: actions refused (a failed call during a click or form,
    // background polls left out as in struggle-model.ts) and full loads that took 10 s or more.
    const people = (await c.query(`select e.person_id "id", p.display_name "name", count(distinct (e.at at time zone ${ORG_TZ})::date)::int "days",
        max(e.at) "last",
        count(*) filter (where e.at > now() - interval '7 days' and e.kind = 'api' and e.status >= 400 and e.detail->>'during' in ('ui.click', 'ui.submit')
          and e.name !~ '^GET /api/v0/(briefs/tick|calls|companion|presence|freshness|notices|work/changed|whats-new)')::int "refused",
        count(*) filter (where e.at > now() - interval '7 days' and e.kind = 'nav.load' and e.duration_ms >= 10000 and not coalesce(e.detail ? 'bg', false))::int "slowStarts"
      from pulse.telemetry_event e join pulse.person p on p.id = e.person_id
      where e.source = 'client' and e.at > now() - interval '30 days' and e.person_id is not null
      group by e.person_id, p.display_name order by max(e.at) desc limit 200`)).rows as { id: string; name: string; days: number; last: string; refused: number; slowStarts: number }[];
    const person = q.person && UUID.test(q.person) ? q.person : null;
    if (q.person && !person) fail(400, "Choose a person");
    if (q.date && !DATE.test(q.date)) fail(400, "Choose a day");
    if (!person) return { zone, people, person: null };
    const name = people.find((p) => p.id === person)?.name
      ?? (await c.query("select display_name from pulse.person where id = $1", [person])).rows[0]?.display_name ?? null;
    if (!name) fail(404, "That person is not in this company");
    // The chosen day, or the person's last day with usage.
    const date = q.date ?? ((await c.query(`select (max(at) at time zone ${ORG_TZ})::date::text d from pulse.telemetry_event where person_id = $1 and source = 'client'`, [person])).rows[0]?.d as string | null)
      ?? (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
    const days = (await c.query(`select (at at time zone ${ORG_TZ})::date::text d, count(*)::int n from pulse.telemetry_event
      where person_id = $1 and source = 'client' and at > now() - interval '30 days' group by 1 order by 1`, [person])).rows as { d: string; n: number }[];
    const rows = (await c.query(`select e.at, e.session_id "sessionId", e.kind, e.name, e.page, e.duration_ms "durationMs", e.value, e.status,
        e.request_id "requestId", e.platform, e.detail
      from pulse.telemetry_event e
      where e.person_id = $1 and e.source = 'client' and e.kind <> 'error.stream'
        and e.at >= ($2::date::timestamp at time zone ${ORG_TZ}) and e.at < (($2::date + 1)::timestamp at time zone ${ORG_TZ})
      order by e.at, e.id limit ${MAX_ROWS}`, [person, date])).rows.map((r) => ({ ...r, at: new Date(r.at).toISOString() })) as DayRow[];
    const sessions = (await c.query(`select s.id, s.start, s."end", s.platform, s.device, r.from_at "replayFrom", r.to_at "replayTo", r.chunks
      from (select session_id id, min(at) start, max(at) "end", max(platform) platform, max(device) device from pulse.telemetry_event
        where person_id = $1 and source = 'client' and session_id is not null
          and at >= ($2::date::timestamp at time zone ${ORG_TZ}) and at < (($2::date + 1)::timestamp at time zone ${ORG_TZ}) group by session_id) s
      left join lateral (select min(started_at) from_at, max(ended_at) to_at, count(*)::int chunks from pulse.telemetry_replay x where x.session_id = s.id) r on true
      order by s.start`, [person, date])).rows.map((s) => ({ id: s.id as string, start: s.start, end: s.end, platform: s.platform, device: s.device,
        replay: s.chunks ? { from: s.replayFrom, to: s.replayTo, chunks: s.chunks as number } : null }));
    return { zone, people, person: { id: person, name }, date, days, sessions, truncated: rows.length >= MAX_ROWS, ...buildDay(rows) };
  }));
}
