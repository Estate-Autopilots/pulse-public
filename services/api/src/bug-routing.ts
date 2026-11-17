// KAZUK-REST slice 5 (E1/E2, migration 1708): bug reports from every company also land on the Pulse dev team's board,
// in the organisation the platform setting names as the Pulse dev organisation (pulse.dev_board_org(); by default the
// organisation with the handle vitalstechnologies, changed by a platform admin at /api/v0/platform/dev-board). The database copies a summary when a
// report is made (trigger reported_bug_route): the company, the report's number, its kind, a masked title, the screen,
// severity, the app, browser and system, and counts. No words, pictures, replays, errors, names or contacts.
//   GET  /api/v0/bug-reports/dev-inbox?status=   the dev organisation's leadership: the routed reports and counts
//                                                (anyone else: devOrg false, no rows)
//   POST /api/v0/bug-reports/dev-inbox/:id       triage one: { status }. One status per report: it is BUGKIT's
//                                                (the original's), written there by pulse.dev_bug_inbox_set and mirrored back
//   POST /api/v0/bug-reports/dev-inbox/:id/task  the dev organisation's own task for it, linking back to the original
// The link back is the admin console's page for the original report (/bugs/<org>/<id>), opened by platform admins and
// written to the platform audit log there. The dev organisation's task goes to its own bug project, chosen as BUGKIT
// chooses it (bugProject in bug-reports.ts).
import type { FastifyInstance } from 'fastify';
import { fail, leadership, type Tx, type Viewer } from './routes.js';
import { bugProject } from './bug-reports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DEV_STATUSES = ['new', 'triaged', 'fixing', 'fixed', 'wontfix'] as const;
type DevStatus = (typeof DEV_STATUSES)[number];

/** The admin console's page for the original report: a path only (the console has its own address). */
export const adminPath = (org: string, report: string) => `/bugs/${org}/${report}`;

/** The status filter of the list: one status, every open one (default) or all. */
export function statusFilter(raw: unknown): DevStatus | 'open' | 'all' {
  const s = typeof raw === 'string' ? raw : '';
  return (DEV_STATUSES as readonly string[]).includes(s) ? (s as DevStatus) : s === 'all' ? 'all' : 'open';
}

/** The dev organisation's task for a routed report: its title and notes carry only what was routed, and the way back. */
export function devTask(r: { sourceOrgName: string; sourceNumber: number; title: string; route: string; severity: string | null; blocksWork: boolean;
  sourceOrg: string; sourceReport: string; platform: string; browser: string | null; errorCount: number; callCount: number }) {
  const title = `${r.sourceOrgName} bug #${r.sourceNumber}: ${r.title}`.slice(0, 200);
  const notes = [`Reported in ${r.sourceOrgName} (#${r.sourceNumber}) on ${r.route}${r.blocksWork ? ', and it stopped their work' : ''}.`,
    `${r.platform}${r.browser ? ` · ${r.browser}` : ''} · ${r.errorCount} errors · ${r.callCount} failed calls.`,
    `The full report stays in that company. Platform admins open it in the admin console: ${adminPath(r.sourceOrg, r.sourceReport)}`].join('\n');
  return { title, notes, priority: r.severity === 'blocker' || r.severity === 'high' || r.blocksWork ? 'high' : 'normal' };
}

const ROW = `i.id, i.source_org "sourceOrg", i.source_org_name "sourceOrgName", i.source_report "sourceReport", i.source_number "sourceNumber",
  i.kind, i.title, i.route, i.severity, i.blocks_work "blocksWork", i.platform, i.app_version "appVersion", i.browser, i.os, i.signed_out "signedOut",
  i.by_agent "byAgent", i.error_count "errorCount", i.call_count "callCount", i.step_count "stepCount", i.reported_at "reportedAt", i.status,
  i.status_at "statusAt", i.task_id "taskId"`;

const lead = (v: Viewer) => { if (!leadership(v)) fail(403, 'Bug triage is for leadership and admins'); };

export function registerBugRoutingRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/bug-reports/dev-inbox', (req) => tx(req, async (c, v) => {
    lead(v);
    const devOrg = (await c.query('select pulse.dev_board_org() = pulse.current_org() as ok')).rows[0].ok === true;
    if (!devOrg) return { devOrg: false, status: 'open', rows: [], counts: null };
    const status = statusFilter((req.query as Record<string, unknown>).status);
    const rows = (await c.query(`select ${ROW} from pulse.dev_bug_inbox i
      where ($1 = 'all' or ($1 = 'open' and i.status in ('new', 'triaged', 'fixing')) or i.status = $1)
      order by case i.severity when 'blocker' then 0 when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 2 end, i.blocks_work desc, i.reported_at desc limit 300`, [status])).rows
      .map((r) => ({ ...r, adminPath: adminPath(r.sourceOrg, r.sourceReport) }));
    const counts = (await c.query(`select count(*) filter (where status = 'new')::int "new", count(*) filter (where status in ('triaged', 'fixing'))::int handling,
      count(*) filter (where status = 'fixed')::int fixed, count(*)::int "all", count(distinct source_org)::int companies from pulse.dev_bug_inbox`)).rows[0];
    return { devOrg: true, status, rows, counts };
  }));

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/bug-reports/dev-inbox/:id', { schema: { body: { type: 'object', maxProperties: 5 } } }, (req) => tx(req, async (c, v) => {
    lead(v);
    const id = UUID.test(req.params.id) ? req.params.id : fail(404, 'Report not found');
    const status = String(req.body?.status ?? '');
    if (!(DEV_STATUSES as readonly string[]).includes(status)) fail(400, 'Choose new, triaged, fixing, fixed or won’t fix');
    const done = (await c.query('select pulse.dev_bug_inbox_set($1, $2) id', [id, status])).rows[0]?.id;
    if (!done) fail(404, 'Report not found');
    const row = (await c.query(`select ${ROW} from pulse.dev_bug_inbox i where i.id = $1`, [id])).rows[0];
    if (!row) fail(404, 'Report not found');
    return { ...row, adminPath: adminPath(row.sourceOrg, row.sourceReport) };
  }));

  app.post<{ Params: { id: string } }>('/api/v0/bug-reports/dev-inbox/:id/task', (req) => tx(req, async (c, v) => {
    lead(v);
    if (!v.person) fail(403, 'Making a task needs your own Pulse sign-in');
    const id = UUID.test(req.params.id) ? req.params.id : fail(404, 'Report not found');
    const r = (await c.query(`select ${ROW} from pulse.dev_bug_inbox i where i.id = $1 for update`, [id])).rows[0];
    if (!r) fail(404, 'Report not found');
    if (r.taskId) return { taskId: r.taskId, existing: true };
    const t = devTask(r);
    const taskId = (await c.query('select pulse.task_save(null, $1) id', [JSON.stringify({ ...t, projectId: await bugProject(c) })])).rows[0].id as string;
    await c.query('update pulse.dev_bug_inbox set task_id = $2, updated_at = now() where id = $1', [id, taskId]);
    if (r.status === 'new') await c.query("select pulse.dev_bug_inbox_set($1, 'triaged')", [id]);
    return { taskId };
  }));
}
