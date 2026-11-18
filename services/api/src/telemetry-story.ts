// TOKENS-TELEMETRY (owner, 17 Nov 2026: "The flows, graphs and data that can be visualised and collected properly are not
// there. See that first."): leadership's Insights, one read for the charts on /telemetry/insights:
//   GET /api/v0/telemetry/story?days=30
//     journeys  how sessions really move: their first four places step by step, and where they left (a Sankey)
//     funnels   the key jobs (create a task, quote or invoice, check in): sessions that reached each step in order
//     speed     per day, p50 and p90 of full loads, route changes and API calls as people waited (foreground only)
//     pages     the five most opened places: route change p90 per day
//     struggle  per day: errors, rage and dead clicks, refused actions, slow starts, clicks before the app was ready
//     digest    the last 24 hours against the 7 days before: what got better and what got worse (and which pages)
// Read-only; row security keeps it inside the viewer's company. Shaping is pure (telemetry-story-model.ts).
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, leadership, type Tx } from "./routes.js";
import { ORG_TZ } from "./org-time.js";
import { digest, FUNNELS, funnel, journeys, type Figure, type Row, type View } from "./telemetry-story-model.js";

// Background polls are not things people did (as in struggle-model.ts / telemetry-day.ts).
const POLLS = "^GET /api/v0/(briefs/tick|calls|companion|presence|freshness|notices|work/changed|whats-new)";
const FG = "not (e.detail ? 'bg') and not (e.detail ? 'pf')";

// One read is ~1-3 s of the box on a month of a busy company's rows; leadership's charts are kept 5 minutes per company.
const CACHE = new Map<string, { at: number; data: unknown }>();
const KEEP_MS = 5 * 60000;

export function registerTelemetryStoryRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get("/api/v0/telemetry/story", (request) => tx(request, async (c, v) => {
    if (!leadership(v)) fail(403, "Leadership access required");
    const d = Number((request.query as Record<string, string | undefined>).days ?? 30);
    const days = Number.isInteger(d) && d >= 7 && d <= 60 ? d : 30;
    const key = `${v.org}:${days}`, hit = CACHE.get(key);
    if (hit && Date.now() - hit.at < KEEP_MS) return hit.data;
    const data = await story(c, days);
    if (CACHE.size > 200) CACHE.clear();
    CACHE.set(key, { at: Date.now(), data });
    return data;
  }));
}

async function story(c: PoolClient, days: number) {
  {
    const since = `now() - make_interval(days => ${days})`;
    const zone = (await c.query(`select ${ORG_TZ} as z`)).rows[0].z as string;
    const [views, rows, speed, top, struggle, figs, pages] = await Promise.all([
      c.query(`select e.session_id s, e.name page from pulse.telemetry_event e
        where e.source = 'client' and e.kind in ('nav.load', 'nav.route') and e.at >= ${since} and e.session_id is not null and e.name like '/%'
        order by e.session_id, e.at limit 80000`),
      c.query(`select e.session_id s, (extract(epoch from e.at) * 1000)::float8 t, e.kind, e.name, coalesce(e.page, '') page, e.status::int status
        from pulse.telemetry_event e
        where e.source = 'client' and e.at >= ${since} and e.session_id is not null
          and ((e.kind in ('nav.load', 'nav.route') and e.name ~ '^/(erp|me)') or (e.kind = 'ui.dialog.open' and e.name ~ '^(New task|Today.s attendance)$')
            or (e.kind = 'api' and e.name ~ '^POST /api/v0/(work/tasks|erp/documents|erp/documents/:id|attendance/check-in)$'))
        order by e.session_id, e.at limit 40000`),
      c.query(`select (e.at at time zone ${ORG_TZ})::date::text "day", e.kind, count(*)::int n,
          round(percentile_cont(0.5) within group (order by e.duration_ms))::int p50, round(percentile_cont(0.9) within group (order by e.duration_ms))::int p90
        from pulse.telemetry_event e
        where e.source = 'client' and e.at >= ${since} and e.kind in ('nav.load', 'nav.route', 'api') and e.duration_ms between 0 and 600000 and ${FG}
          and (e.kind <> 'api' or e.name !~ '${POLLS}')
        group by 1, 2 order by 1`),
      c.query(`with top as (select e.name from pulse.telemetry_event e where e.source = 'client' and e.kind = 'nav.route' and e.at >= ${since} and ${FG}
            group by 1 order by count(*) desc limit 5)
        select (e.at at time zone ${ORG_TZ})::date::text "day", e.name page, count(*)::int n, round(percentile_cont(0.9) within group (order by e.duration_ms))::int p90
        from pulse.telemetry_event e join top on top.name = e.name
        where e.source = 'client' and e.kind = 'nav.route' and e.at >= ${since} and e.duration_ms between 0 and 600000 and ${FG}
        group by 1, 2 order by 1`),
      c.query(`select (e.at at time zone ${ORG_TZ})::date::text "day",
          count(*) filter (where e.kind in ('error.js', 'error.promise', 'error.boundary', 'error.resource'))::int errors,
          count(*) filter (where e.kind = 'ui.rage')::int rage, count(*) filter (where e.kind = 'ui.dead')::int dead,
          count(*) filter (where e.kind = 'api' and e.status >= 400 and e.detail->>'during' in ('ui.click', 'ui.submit') and e.name !~ '${POLLS}')::int refused,
          count(*) filter (where e.kind = 'nav.load' and e.duration_ms >= 10000 and not (e.detail ? 'bg'))::int "slowStarts",
          count(*) filter (where e.kind = 'ui.early')::int early,
          count(distinct e.person_id)::int people, count(distinct e.session_id)::int sessions
        from pulse.telemetry_event e where e.source = 'client' and e.at >= ${since}
          and e.kind in ('error.js', 'error.promise', 'error.boundary', 'error.resource', 'ui.rage', 'ui.dead', 'api', 'nav.load', 'nav.route', 'ui.click', 'ui.early')
        group by 1 order by 1`),
      // The digest: the last 24 hours ("now") against the 7 days before ("before", counts per day).
      c.query(`with w as (select e.*, case when e.at >= now() - interval '1 day' then 'now' else 'before' end p
          from pulse.telemetry_event e where e.source = 'client' and e.at >= now() - interval '8 days')
        select p,
          percentile_cont(0.9) within group (order by duration_ms) filter (where kind = 'nav.load' and duration_ms between 0 and 600000 and not (detail ? 'bg')) "load",
          count(*) filter (where kind = 'nav.load' and not (detail ? 'bg'))::int "loadN",
          percentile_cont(0.9) within group (order by duration_ms) filter (where kind = 'nav.route' and duration_ms between 0 and 600000 and not (detail ? 'bg')) "route",
          count(*) filter (where kind = 'nav.route' and not (detail ? 'bg'))::int "routeN",
          percentile_cont(0.9) within group (order by duration_ms) filter (where kind = 'api' and duration_ms between 0 and 600000 and not (detail ? 'bg') and name !~ '${POLLS}') "api",
          count(*) filter (where kind = 'api' and not (detail ? 'bg'))::int "apiN",
          count(*) filter (where kind in ('error.js', 'error.promise', 'error.boundary', 'error.resource'))::int errors,
          count(*) filter (where kind in ('ui.rage', 'ui.dead') or (kind = 'api' and status >= 400 and detail->>'during' in ('ui.click', 'ui.submit') and name !~ '${POLLS}'))::int struggle,
          count(distinct person_id)::int people
        from w group by p`),
      c.query(`with w as (select e.name, e.duration_ms, case when e.at >= now() - interval '1 day' then 'now' else 'before' end p
          from pulse.telemetry_event e where e.source = 'client' and e.kind = 'nav.route' and e.at >= now() - interval '8 days' and e.duration_ms between 0 and 600000 and not (e.detail ? 'bg'))
        select name page, percentile_cont(0.9) within group (order by duration_ms) filter (where p = 'now') "now", count(*) filter (where p = 'now')::int "nowN",
          percentile_cont(0.9) within group (order by duration_ms) filter (where p = 'before') "before", count(*) filter (where p = 'before')::int "beforeN"
        from w group by name having count(*) filter (where p = 'now') >= 5 and count(*) filter (where p = 'before') >= 5`),
    ]);
    // AI work: tokens per model run, the last 24 hours against the 7 days before (agent_run, row security as the viewer).
    const ai = (await c.query(`select case when r.started_at >= now() - interval '1 day' then 'now' else 'before' end p, count(*)::int runs,
        coalesce(sum(coalesce(nullif(coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0), 0), r.tokens, 0)), 0)::float8 tokens
      from pulse.agent_run r where r.started_at >= now() - interval '8 days' group by 1`)).rows as { p: string; runs: number; tokens: number }[];
    const at = (p: string) => (figs.rows.find((r) => r.p === p) ?? {}) as Record<string, number | null>;
    const now = at("now"), before = at("before");
    const aiNow = ai.find((r) => r.p === "now"), aiBefore = ai.find((r) => r.p === "before");
    const perDay = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round((x / 7) * 10) / 10);
    const ms = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x));
    const figures: Figure[] = [
      { key: "load", label: "Opening the app", unit: "ms", now: ms(now.load), before: ms(before.load), lowerIsBetter: true, n: now.loadN ?? 0 },
      { key: "route", label: "Moving between pages", unit: "ms", now: ms(now.route), before: ms(before.route), lowerIsBetter: true, n: now.routeN ?? 0 },
      { key: "api", label: "Waiting for data", unit: "ms", now: ms(now.api), before: ms(before.api), lowerIsBetter: true, n: now.apiN ?? 0 },
      { key: "errors", label: "Errors on screen", unit: "count", now: now.errors ?? null, before: perDay(before.errors), lowerIsBetter: true },
      { key: "struggle", label: "Struggle moments", unit: "count", now: now.struggle ?? null, before: perDay(before.struggle), lowerIsBetter: true },
      { key: "people", label: "People using Pulse", unit: "count", now: now.people ?? null, before: before.people === null || before.people === undefined ? null : Number(before.people), lowerIsBetter: false },
      { key: "aiPerRun", label: "AI tokens per job", unit: "tokens", now: aiNow?.runs ? Math.round(aiNow.tokens / aiNow.runs) : null, before: aiBefore?.runs ? Math.round(aiBefore.tokens / aiBefore.runs) : null, lowerIsBetter: true, n: aiNow?.runs ?? 0 },
    ];
    const pageLines = digest((pages.rows as { page: string; now: number; nowN: number; before: number }[]).map((r) => ({ key: r.page, label: r.page, unit: "ms" as const, now: Math.round(r.now), before: Math.round(r.before), lowerIsBetter: true, n: r.nowN })))
      .filter((x) => x.verdict === "better" || x.verdict === "worse").sort((a, b) => Math.abs(b.change ?? 0) - Math.abs(a.change ?? 0));
    return {
      days, zone,
      journeys: journeys(views.rows as View[], { steps: 4, top: 7 }),
      funnels: FUNNELS.map((f) => ({ key: f.key, label: f.label, steps: funnel((rows.rows as Row[]).map((r) => ({ ...r, t: Number(r.t) })), f.steps) })),
      speed: speed.rows, pages: top.rows, struggle: struggle.rows,
      digest: { lines: digest(figures), pagesWorse: pageLines.filter((x) => x.verdict === "worse").slice(0, 3), pagesBetter: pageLines.filter((x) => x.verdict === "better").slice(0, 3) },
    };
  }
}
