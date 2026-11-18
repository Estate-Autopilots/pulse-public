// ERROR-SWEEP (owner, 17 Nov 2026): Telemetry → Error budget. Errors per day per cause for the last 14 days, each
// cause new, back or known (a 28-day look-back tells them apart), with how many people it reached. Leadership and
// admins, as the rest of Telemetry. Grouping rules: telemetry-errors-model.ts.
//   GET /api/v0/telemetry/errors?days=14|7|30
import type { FastifyInstance } from "fastify";
import { fail, leadership, type Tx } from "./routes.js";
import { ORG_TZ } from "./org-time.js";
import { dayList, errorBudget, type ErrorRow } from "./telemetry-errors-model.js";

export function registerTelemetryErrorRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get("/api/v0/telemetry/errors", (request) => tx(request, async (c, v) => {
    if (!leadership(v)) fail(403, "Leadership access required");
    const q = request.query as Record<string, string | undefined>;
    const days = q.days === "7" ? 7 : q.days === "30" ? 30 : 14;
    const look = days + 14;
    const zone = (await c.query(`select ${ORG_TZ} z, (now() at time zone ${ORG_TZ})::date::text today`)).rows[0] as { z: string; today: string };
    // Only error-shaped rows: script and stream errors, and API answers that failed (the kind index, then the status).
    const rows = (await c.query(`select (e.at at time zone $2)::date::text "day", e.kind, e.name, e.status, e.page, e.person_id::text person,
        e.detail->>'err' err, coalesce(e.detail ? 'bg', false) bg, e.detail->>'who' who, count(*)::int n
      from pulse.telemetry_event e
      where e.at >= now() - make_interval(days => $1) and (e.kind like 'error.%' or (e.kind in ('api', 'api.server') and e.status >= 400))
      group by 1, 2, 3, 4, 5, 6, 7, 8, 9`, [look, zone.z])).rows as ErrorRow[];
    const shown = dayList(zone.today, days);
    return { days, zone: zone.z, ...errorBudget(rows, shown) };
  }));
}
