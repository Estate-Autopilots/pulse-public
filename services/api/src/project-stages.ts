import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { fail, work, type Tx, type Viewer } from './routes.js';
import { planState, plansFor, templates } from './project-plan.js';
import { STARTERS, startersFor } from './project-starters.js';

/** PROJECTS-STAGES (owner, 4 Nov 2026; Kazuk's 3 Nov meeting, B2-B9, migration 1485). Projects as groups of tasks run in
 *  stages with owners at three levels (the project's lead, each stage's owner, each task's doer):
 *  - starter delivery templates by industry, so every company gets stages, not only the first one;
 *  - stage owners, and a task placed on a stage wherever it was given (B9);
 *  - late project work asks its doer why (B4) and rolls up to the lead and the stage owner until one acts (B5);
 *  - each person's load: projects they lead, stages they own, open, late and this week's work (B6). */
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use Projects');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uid = (x: unknown, what = 'record') => typeof x === 'string' && UUID.test(x) ? x : fail(400, `Choose a valid ${what}`);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (x: unknown) => x === null || x === undefined || x === '' ? null : typeof x === 'string' && DAY.test(x) ? x : fail(400, 'Enter the date as a date');
const stageNo = (x: unknown) => { const n = Number(x); return Number.isInteger(n) && n >= 0 && n <= 40 ? n : fail(400, 'Choose a stage'); };

export const REASONS: Record<string, string> = {
  waiting_client: 'Waiting on the client', waiting_team: 'Waiting on a colleague', more_work: 'More work than planned',
  other_work: 'Other work came first', away: 'On leave or unwell', other: 'Other',
};

export type DelayRow = { id: string; taskId: string; whoId: string; answeredAt: string | null; action: string | null; actedAt: string | null; escalatedId: string | null; canAct: boolean };
/** Whether a delay waits on this viewer to act (B5): nobody acted yet; or it was chased and the doer answered since, or
 *  2 days passed without an answer; or it was escalated to the viewer. Pure, so it is unit-tested. */
export function needsAct(d: DelayRow, me: string, now: number) {
  if (!d.canAct) return false;
  if (d.action === 'escalated') return d.escalatedId === me;
  if (d.action === 'chased') {
    const acted = d.actedAt ? Date.parse(d.actedAt) : 0;
    return (!!d.answeredAt && Date.parse(d.answeredAt) > acted) || now - acted > 2 * 86400000;
  }
  return d.action === null;
}

export type LoadRow = { id: string; name: string; role: string | null; pod: string | null; open: number; late: number; week: number; inProjects: number; leads: number; stages: number };
/** Each person's load (B6), heaviest first, with the bar as a share of the busiest person's open work. Pure. */
export function loadOf(rows: LoadRow[]) {
  const shown = rows.filter((r) => r.open || r.leads || r.stages);
  const top = Math.max(1, ...shown.map((r) => r.open));
  return shown.map((r) => ({ ...r, share: Math.round((r.open / top) * 100), state: r.late ? 'late' : r.week >= 5 ? 'full' : r.open ? 'ok' : 'free' }))
    .sort((a, b) => b.late - a.late || b.open - a.open || a.name.localeCompare(b.name));
}

/** The stages of a project's plan with their owners and the stage it is in; empty when it has no plan. */
export async function projectStages(c: PoolClient, id: string) {
  const day_ = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
  const p = (await plansFor(c, [id])).get(id);
  const t = p ? (await templates(c)).find((x) => x.key === p.plan.templateKey) : null;
  if (!p || !t) return { stages: [] as { n: number; label: string; ownerId: string | null; owner: string | null }[], current: null as number | null };
  const owners = (await c.query(`select o.stage,o.person_id id,pe.display_name name from pulse.project_stage_owner o join pulse.person pe on pe.id=o.person_id where o.project_id=$1`, [id])).rows;
  const s = planState(t, p.plan, p.tasks, day_);
  return { current: s.stage, stages: t.stages.map((x) => { const o = owners.find((r) => r.stage === x.n); return { n: x.n, label: x.label, ownerId: o?.id ?? null, owner: o?.name ?? null }; }) };
}

const DELAYS = `select d.id,d.task_id "taskId",t.title,d.project_id "projectId",coalesce(p.title,p.name) project,d.due_on::text "dueOn",
    ((now() at time zone ${ORG_TZ})::date-d.due_on)::int "daysLate",d.person_id "whoId",(select display_name from pulse.person where id=d.person_id) who,
    d.reason,d.note,d.can_by::text "canBy",d.answered_at::text "answeredAt",d.asked_at::text "askedAt",d.action,d.acted_at::text "actedAt",d.chases,
    d.escalated_to "escalatedId",(select display_name from pulse.person where id=d.escalated_to) escalated,pulse.task_stage(d.task_id) stage,
    pulse.task_delay_can_act(d.id) "canAct",coalesce(p.lead_person_id,(select owner_id from pulse.work_project where project_id=p.id)) "leadId"
  from pulse.task_delay d join pulse.task t on t.id=d.task_id join pulse.project p on p.id=d.project_id
  where d.closed_at is null`;

/** Reads only: the questions are asked by runDelays (every 10 minutes), so a page read never writes or sends a notice. */
export async function delaysFor(c: PoolClient, me: string, project: string | null) {
  const rows = (await c.query(`${DELAYS} ${project ? 'and d.project_id=$1' : ''} order by d.due_on,t.title limit 300`, project ? [project] : [])).rows as (DelayRow & Record<string, unknown>)[];
  const now = Date.now();
  const list = rows.map((r) => ({ ...r, reasonLabel: r.reason ? REASONS[String(r.reason)] ?? null : null, mine: r.whoId === me, needsMe: needsAct(r, me, now) }));
  return { toAct: list.filter((r) => r.needsMe), mine: list.filter((r) => r.mine && !r.answeredAt), all: list };
}

/** B4: late project work asks its doer why, one company's transaction at a time (as chats' runDue does). Each question is
 *  asked once per task and due day, so two API processes running it at once ask nothing twice. */
export async function runDelays(pool: Pool) {
  let n = 0;
  const orgs = (await pool.query('select pulse.list_active_orgs() org')).rows.map((r) => r.org as string);
  for (const org of orgs) {
    const c = await pool.connect();
    try {
      await c.query('begin'); await c.query("select set_config('pulse.org_id',$1,true)", [org]);
      await c.query("set local statement_timeout = '20s'");
      n += (await c.query('select pulse.task_delays_sync() n')).rows[0].n as number; await c.query('commit');
    } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
  }
  return n;
}

export function registerProjectStageRoutes(app: FastifyInstance, { tx, pool }: { tx: Tx; pool?: Pool }) {
  // Every 10 minutes, and once a minute after start (PULSE_TASK_DELAYS=0 turns it off, as PULSE_CHAT_DUE does for chats).
  let busy = false;
  const ask = () => { if (busy || !pool) return; busy = true; void runDelays(pool).then((n) => { if (n) app.log.info({ asked: n }, 'Late project work: doers asked why'); })
    .catch(() => app.log.warn('Late project work: asking unavailable')).finally(() => { busy = false; }); };
  const on = !!pool && process.env.PULSE_TASK_DELAYS !== '0';
  const tick = on ? setInterval(ask, 600_000) : null, start = on ? setTimeout(ask, 60_000) : null;
  tick?.unref(); start?.unref();
  // B7/B8: starters by industry, the company's own pack first.
  app.get<{ Querystring: { project?: string } }>('/api/v0/projects/starters', req => tx(req, async (c, v) => {
    work(v); person(v);
    const pack = (await c.query('select pack_key from pulse.org_pack where org_id=pulse.current_org()')).rows[0]?.pack_key ?? null;
    const have = (await c.query('select key from pulse.delivery_template')).rows.map((r) => r.key as string);
    const project = req.query.project && UUID.test(req.query.project) ? req.query.project : null;
    // Once the company has a template, more are for admins and leadership (as delivery_template_adopt checks).
    const canAdopt = (await c.query(`select pulse.viewer_is('admin','leadership') or ($1::uuid is not null and $2::int=0 and pulse.project_can_run($1::uuid)) ok`, [project, have.length])).rows[0].ok as boolean;
    return { pack, templates: have.length, canAdopt, starters: startersFor(pack, have) };
  }));
  app.post<{ Params: { key: string }; Body: Record<string, unknown> }>('/api/v0/projects/starters/:key', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v);
    const s = STARTERS.find((x) => x.key === req.params.key) ?? fail(404, 'Starter not found');
    const project = req.body?.projectId ? uid(req.body.projectId, 'project') : null;
    return (await c.query('select pulse.delivery_template_adopt($1,$2,$3::jsonb,$4) r', [s.key, s.name, JSON.stringify(s.template), project])).rows[0].r;
  }));
  // B2: a project's stages with their owners; the stage owner set by the lead.
  app.get<{ Params: { id: string } }>('/api/v0/projects/:id/stages', req => tx(req, async (c, v) => {
    work(v); person(v); const id = uid(req.params.id);
    if (!(await c.query('select 1 from pulse.project where id=$1 and deleted_at is null', [id])).rows[0]) fail(404, 'Project not found');
    return projectStages(c, id);
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/stage-owner', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = uid(req.params.id); const b = req.body ?? {};
    return (await c.query('select pulse.project_stage_owner_set($1,$2,$3) r', [id, stageNo(b.stage), b.personId ? uid(b.personId, 'person') : null])).rows[0].r;
  }));
  // B9: a task placed on a stage of its project.
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/:id/task-stage', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = uid(req.params.id); const b = req.body ?? {}; const task = uid(b.taskId, 'task');
    if (!(await c.query('select 1 from pulse.task where id=$1 and project_id=$2 and deleted_at is null', [task, id])).rows[0]) fail(404, 'Task not found');
    return (await c.query('select pulse.project_task_stage($1,$2) r', [task, stageNo(b.stage)])).rows[0].r;
  }));
  // B4/B5: late work and its reasons; what waits on the viewer to act; the viewer's own late work to explain.
  app.get<{ Querystring: { project?: string } }>('/api/v0/projects/delays', req => tx(req, async (c, v) => {
    work(v); const me = person(v); const project = req.query.project ? uid(req.query.project, 'project') : null;
    const d = await delaysFor(c, me, project);
    return { reasons: REASONS, ...d, all: project ? d.all : undefined };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/projects/delays/:id', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = uid(req.params.id); const b = req.body ?? {};
    const action = ['chased', 'rescheduled', 'escalated'].includes(String(b.action)) ? String(b.action) : fail(400, 'Choose Chase, New date or Escalate');
    return (await c.query('select pulse.task_delay_act($1,$2,$3,$4,$5) r', [id, action, day(b.due), b.note ? String(b.note).slice(0, 300) : null, b.toId ? uid(b.toId, 'person') : null])).rows[0].r;
  }));
  // Who a delay can be escalated to: active staff who may open its task (1455), so the pick offers no one it would refuse.
  app.get<{ Params: { id: string } }>('/api/v0/projects/delays/:id/targets', req => tx(req, async (c, v) => {
    work(v); person(v); const id = uid(req.params.id);
    const people = (await c.query('select id,name from pulse.task_delay_targets($1)', [id])).rows;
    return { people };
  }));
  // A task's place in its project's plan (its stage, the stages to choose from) and its open delay, for the task page.
  app.get<{ Params: { id: string } }>('/api/v0/tasks/:id/plan-place', req => tx(req, async (c, v) => {
    work(v); const me = person(v); const id = uid(req.params.id, 'task');
    const t = (await c.query(`select t.project_id "projectId",pulse.task_stage(t.id) stage,coalesce(t.assignee_person_id,t.owner_id) doer,t.created_by "createdBy" from pulse.task t where t.id=$1 and t.deleted_at is null`, [id])).rows[0] ?? fail(404, 'Task not found');
    if (!t.projectId) return { stages: [], stage: null, canSet: false, delay: null, reasons: REASONS };
    const s = await projectStages(c, t.projectId);
    const canSet = s.stages.length > 0 && (me === t.doer || me === t.createdBy || s.stages.some((x) => x.ownerId === me) || (await c.query('select pulse.project_can_run($1) ok', [t.projectId])).rows[0].ok === true);
    const delay = (await delaysFor(c, me, t.projectId)).all.find((x) => x.taskId === id) ?? null;
    return { projectId: t.projectId, stages: s.stages, current: s.current, stage: t.stage, canSet, delay, reasons: REASONS };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/tasks/:id/delay', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    work(v); person(v); const id = uid(req.params.id, 'task'); const b = req.body ?? {};
    return (await c.query('select pulse.task_delay_answer($1,$2,$3,$4) r', [id, String(b.reason ?? '').slice(0, 30), b.note ? String(b.note).slice(0, 300) : null, day(b.by)])).rows[0].r;
  }));
  // B6: each person's load. Leadership and HR see everyone, a pod head their pods, everyone else themselves.
  app.get<{ Querystring: { pod?: string } }>('/api/v0/projects/load', req => tx(req, async (c, v) => {
    work(v); const me = person(v);
    const { role, pods } = (await c.query('select pulse.work_role() role,pulse.work_head_pods() pods')).rows[0] as { role: string; pods: string[] | null };
    const everyone = role === 'leadership' || role === 'hr';
    const rows = (await c.query(`with t as (select coalesce(t.assignee_person_id,t.owner_id) pid,t.project_id,t.status,(t.due_at at time zone ${ORG_TZ})::date due
          from pulse.task t where t.deleted_at is null and t.status in ('open','in_progress','blocked')),
        live as (select id,lead_person_id from pulse.project where deleted_at is null and coalesce(status,'active') not in ('paused','done','cancelled'))
      select p.id,p.display_name name,pp.role,nullif(pp.pod,'') pod,
        count(t.pid)::int open,count(t.pid) filter(where t.due<(now() at time zone ${ORG_TZ})::date)::int late,
        count(t.pid) filter(where t.due between (now() at time zone ${ORG_TZ})::date and (now() at time zone ${ORG_TZ})::date+6)::int week,
        count(t.pid) filter(where t.project_id is not null)::int "inProjects",
        (select count(*)::int from live where live.lead_person_id=p.id) leads,
        (select count(*)::int from pulse.project_stage_owner o join live on live.id=o.project_id where o.person_id=p.id) stages
      from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id left join t on t.pid=p.id
      where p.side='staff' and p.status='active' and not exists(select 1 from pulse.agent_member am where am.person_id=p.id)
        and ($1::boolean or p.id=$2::uuid or ($3::text[] is not null and nullif(pp.pod,'')=any($3::text[])))
      group by p.id,p.display_name,pp.role,pp.pod`, [everyone, me, role === 'pod_head' ? pods ?? [] : null])).rows as LoadRow[];
    const pod = typeof req.query.pod === 'string' && req.query.pod ? req.query.pod.slice(0, 80) : null;
    return { scope: everyone ? 'all' : role === 'pod_head' ? 'pod' : 'mine', people: loadOf(pod ? rows.filter((r) => r.pod === pod) : rows) };
  }));
}
