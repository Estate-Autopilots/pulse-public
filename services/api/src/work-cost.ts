import type { FastifyInstance } from 'fastify';
import { fail, leadership, type Tx } from './routes.js';
import { ACCEPTED_BY_OTHERS, addDays } from './outcomes.js';
import { ORG_TZ } from './org-time.js';

/** FIX-PEOPLE-MONEY C5 (owner, 10 Nov 2026: "cost per task and project"): the tasks finished in the last N days (accepted
 *  by someone other than who did them, as Outcomes counts them), one row each: its project (null when it has none: it
 *  still counts when a person's pay is split over their tasks), who did it, whether that
 *  was an AI employee, and the tokens its AI used on it. The web works out the rupees (People → Work and cost): a
 *  person's share of the team's average pay over their tasks; AI in tokens until the platform has a price. Leadership
 *  and admins only; row security still applies to every table read. */
export function registerWorkCostRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // ?since=YYYY-MM-DD (the first day of the People card's first week, in the company's time zone) counts the same
  // calendar weeks as Outcomes; without it, the last ?days=N days (1-90, default 28).
  app.get<{ Querystring: { days?: string; since?: string } }>('/api/v0/work/cost/projects', (req) => tx(req, async (c, v) => {
    if (!leadership(v)) fail(403, 'Leadership and admins see what each project cost');
    const asked = Number(req.query.days);
    const days = Number.isInteger(asked) && asked >= 1 && asked <= 90 ? asked : 28;
    const today = new Date().toISOString().slice(0, 10);
    const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since ?? '') && !Number.isNaN(Date.parse(String(req.query.since)))
      && String(req.query.since) >= addDays(today, -120) && String(req.query.since) <= today ? String(req.query.since) : null;
    const rows = (await c.query(`select t.project_id "projectId", coalesce(pr.title, pr.name) "project", coalesce(t.assignee_person_id, t.owner_id) "who",
        (am.person_id is not null) "ai",
        (select coalesce(sum(r.tokens), 0)::bigint from pulse.agent_run r join pulse.agent_event e on e.id = r.event_id
          where e.subject_type = 'task' and e.subject_id = t.id) "tokens"
      from pulse.task t left join pulse.project pr on pr.id = t.project_id
      left join pulse.agent_member am on am.person_id = coalesce(t.assignee_person_id, t.owner_id)
      where ${ACCEPTED_BY_OTHERS('t', 'coalesce(t.assignee_person_id, t.owner_id)')}
        and t.accepted_at >= coalesce($2::date::timestamp at time zone ${ORG_TZ}, now() - make_interval(days => $1))
      order by t.accepted_at desc limit 5000`, [days, since])).rows as { projectId: string | null; project: string | null; who: string; ai: boolean; tokens: string | number }[];
    return { days, since, tasks: rows.map((r) => ({ projectId: r.projectId, project: r.projectId ? r.project ?? 'A project' : null, who: r.who, ai: r.ai, tokens: Number(r.tokens) || 0 })) };
  }));
}
