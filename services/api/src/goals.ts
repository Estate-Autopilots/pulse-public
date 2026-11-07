// FOUNDATIONS (owner, 6 Nov 2026; Ditasu asked first): goals for a person, a team or the company, made of projects and
// tasks, with a target date, an optional measurable target and progress rolled up from what they hold (1570). One model
// serves the screens (/api/v0/goals…, below) and API v1 / MCP / the CLI (v1-goals.ts). Who sees and changes which goal
// is decided in the database (pulse.goal_can_see, pulse.goal_can_edit, row security); this file only shapes the words.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx } from './routes.js';

export type GoalLevel = 'person' | 'team' | 'company';
export const LEVELS: readonly GoalLevel[] = ['person', 'team', 'company'];
export const STATUSES = ['active', 'done', 'dropped'] as const;
type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const goalId = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(404, 'Goal not found');

export type Progress = { progress: number; measure: number | null; work: number | null; tasks: number; tasksDone: number; projects: number; subGoals: number; late: boolean;
  basis: 'measure' | 'work' | 'done' | 'none' };
export type Goal = { id: string; level: GoalLevel; title: string; why: string | null; ownerId: string | null; owner: string | null; teamId: string | null; team: string | null;
  parentId: string | null; parent: string | null; targetOn: string | null; measure: { label: string; start: number; target: number; current: number } | null;
  status: (typeof STATUSES)[number]; createdBy: string; createdAt: string; updatedAt: string; doneAt: string | null; canEdit: boolean; progress: Progress };

const num = (v: unknown) => v === null || v === undefined ? null : Number(v);
const SELECT = `select g.id,g.level,g.title,g.why,g.owner_person_id "ownerId",o.display_name owner,g.unit_id "teamId",u.name team,g.parent_id "parentId",
    pg.title parent,g.target_on::text "targetOn",g.measure_label "measureLabel",g.start_value "startValue",g.target_value "targetValue",
    g.current_value "currentValue",g.status,g.created_by "createdBy",g.created_at::text "createdAt",g.updated_at::text "updatedAt",g.done_at::text "doneAt",
    pulse.goal_can_edit(g.level,g.owner_person_id,g.unit_id) "canEdit",pulse.goal_progress(g.id) progress
  from pulse.goal g left join pulse.person o on o.id=g.owner_person_id left join pulse.unit u on u.id=g.unit_id left join pulse.goal pg on pg.id=g.parent_id`;

export function goalOut(r: Row): Goal {
  const p = (r.progress ?? {}) as Row;
  return { id: String(r.id), level: r.level as GoalLevel, title: String(r.title), why: (r.why as string) ?? null, ownerId: (r.ownerId as string) ?? null,
    owner: (r.owner as string) ?? null, teamId: (r.teamId as string) ?? null, team: (r.team as string) ?? null, parentId: (r.parentId as string) ?? null,
    parent: (r.parent as string) ?? null, targetOn: (r.targetOn as string) ?? null,
    measure: r.targetValue === null || r.targetValue === undefined ? null
      : { label: String(r.measureLabel ?? ''), start: num(r.startValue) ?? 0, target: Number(r.targetValue), current: num(r.currentValue) ?? num(r.startValue) ?? 0 },
    status: r.status as Goal['status'], createdBy: String(r.createdBy), createdAt: String(r.createdAt), updatedAt: String(r.updatedAt), doneAt: (r.doneAt as string) ?? null,
    canEdit: r.canEdit === true,
    progress: { progress: Number(p.progress ?? 0), measure: num(p.measure), work: num(p.work), tasks: Number(p.tasks ?? 0), tasksDone: Number(p.tasksDone ?? 0),
      projects: Number(p.projects ?? 0), subGoals: Number(p.subGoals ?? 0), late: p.late === true, basis: (p.basis as Progress['basis']) ?? 'none' } };
}

export type ListFilter = { level?: GoalLevel; who?: 'me' | 'all'; status?: string; ownerId?: string; parentId?: string; after?: string | null; take?: number };
/** Goals the viewer may see (row security), newest-first by level: company, team, then people. */
export async function listGoals(c: PoolClient, f: ListFilter): Promise<Goal[]> {
  const r = await c.query(`${SELECT}
    where ($1::text is null or g.level=$1) and ($2::boolean is false or g.owner_person_id=pulse.current_viewer() or g.created_by=pulse.current_viewer())
      and ($3::text is null or g.status=$3) and ($4::uuid is null or g.owner_person_id=$4) and ($5::uuid is null or g.parent_id=$5)
      and ($6::uuid is null or g.id>$6)
    order by ${f.after !== undefined ? 'g.id' : `array_position(array['company','team','person'],g.level),g.status<>'active',g.target_on nulls last,g.created_at desc`}
    limit $7`, [f.level ?? null, f.who === 'me', f.status ?? null, f.ownerId ?? null, f.parentId ?? null, f.after ?? null, Math.min(Math.max(f.take ?? 200, 1), 300)]);
  return r.rows.map(goalOut);
}

export async function getGoal(c: PoolClient, id: string): Promise<Goal> {
  const r = (await c.query(`${SELECT} where g.id=$1`, [goalId(id)])).rows[0];
  return r ? goalOut(r) : fail(404, 'Goal not found');
}

export type GoalWork = { links: { id: string; kind: 'project' | 'task'; projectId: string | null; taskId: string | null; title: string; status: string; who: string | null;
  dueOn: string | null; tasks: number; tasksDone: number }[]; subGoals: Goal[] };
/** What a goal holds: its linked projects (with their task counts) and tasks, and its sub-goals, as the viewer sees them. */
export async function goalWork(c: PoolClient, id: string): Promise<GoalWork> {
  const links = (await c.query(`select l.id,case when l.project_id is null then 'task' else 'project' end kind,l.project_id "projectId",l.task_id "taskId",
      coalesce(coalesce(p.title,p.name),t.title,'Hidden from you') title,coalesce(p.status,t.status,'unknown') status,a.display_name who,
      coalesce(p.ends_on::text,(t.due_at at time zone pulse.org_time_zone())::date::text) "dueOn",
      (select count(*) from pulse.task x where x.project_id=l.project_id and x.status<>'cancelled')::int tasks,
      (select count(*) from pulse.task x where x.project_id=l.project_id and x.status in ('done','accepted'))::int "tasksDone"
    from pulse.goal_link l left join pulse.project p on p.id=l.project_id left join pulse.task t on t.id=l.task_id
      left join pulse.person a on a.id=coalesce(t.assignee_person_id,p.lead_person_id)
    where l.goal_id=$1 order by l.project_id is null, l.added_at`, [id])).rows;
  return { links: links.map(l => ({ id: String(l.id), kind: l.kind, projectId: l.projectId ?? null, taskId: l.taskId ?? null, title: String(l.title), status: String(l.status),
    who: l.who ?? null, dueOn: l.dueOn ?? null, tasks: Number(l.tasks ?? 0), tasksDone: Number(l.tasksDone ?? 0) })), subGoals: await listGoals(c, { parentId: id }) };
}

const clean = (v: unknown, max: number) => v === null || v === undefined ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null;
const amount = (v: unknown, what: string) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) < 1e14 ? Math.round(n * 100) / 100 : fail(400, `${what} is a number`);
};

/** Make a goal (id null) or change the fields sent. The database refuses what the viewer may not do (403). */
export async function saveGoal(c: PoolClient, id: string | null, b: Row): Promise<string> {
  const viewer: string | null = (await c.query('select pulse.current_viewer() v')).rows[0]?.v ?? null;
  const me = viewer ?? fail(403, 'Sign in with your own account to set goals');
  const old = id ? await getGoal(c, id) : null;
  if (old && !old.canEdit) fail(403, 'You can read this goal but not change it');
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const level = (has('level') ? String(b.level) : old?.level ?? 'person') as GoalLevel;
  if (!LEVELS.includes(level)) fail(400, 'Choose whose goal it is: yours or a person\'s, a team\'s, or the company\'s');
  if (old && has('level') && level !== old.level) fail(400, 'A goal keeps its level; make a new one instead');
  const title = has('title') ? clean(b.title, 160) : old?.title ?? null;
  if (!title) fail(400, 'Give the goal a name');
  const why = has('why') ? clean(b.why, 2000) : old?.why ?? null;
  const ownerId = has('ownerId') ? (b.ownerId === null ? null : UUID.test(String(b.ownerId)) ? String(b.ownerId) : fail(400, 'Choose a person'))
    : old ? old.ownerId : level === 'person' ? me : null;
  if (level === 'person' && !ownerId) fail(400, 'A person\'s goal needs its person');
  const teamId = level !== 'team' ? null : has('teamId') ? (UUID.test(String(b.teamId)) ? String(b.teamId) : fail(400, 'Choose a team')) : old?.teamId ?? fail(400, 'Choose a team');
  const parentId = has('parentId') ? (b.parentId === null ? null : UUID.test(String(b.parentId)) ? String(b.parentId) : fail(400, 'Choose a goal')) : old?.parentId ?? null;
  if (parentId) {
    if (parentId === id) fail(400, 'A goal cannot sit under itself');
    if (!(await c.query('select 1 from pulse.goal where id=$1', [parentId])).rowCount) fail(400, 'The goal above it is not one you can see');
  }
  const targetOn = has('targetOn') ? (b.targetOn === null || b.targetOn === '' ? null : DAY.test(String(b.targetOn)) ? String(b.targetOn) : fail(400, 'The target date is YYYY-MM-DD')) : old?.targetOn ?? null;
  const m = old?.measure;
  const label = has('measureLabel') ? clean(b.measureLabel, 60) : m?.label ?? null;
  const target = has('targetValue') ? amount(b.targetValue, 'The target') : m ? m.target : null;
  const start = has('startValue') ? amount(b.startValue, 'The starting value') ?? 0 : m ? m.start : target === null ? null : 0;
  const current = has('currentValue') ? amount(b.currentValue, 'The value now') : m ? m.current : start;
  if (target !== null && !label) fail(400, 'Say what the target counts (for example "clients signed")');
  if (target !== null && target === (start ?? 0)) fail(400, 'The target must differ from where it starts');
  const measure = target === null ? { label: null, start: null, target: null, current: null } : { label, start, target, current };
  const status = has('status') ? String(b.status) : old?.status ?? 'active';
  if (!(STATUSES as readonly string[]).includes(status)) fail(400, 'A goal is active, done or dropped');
  const allowed = (await c.query('select pulse.goal_can_edit($1,$2,$3) v', [level, ownerId, teamId])).rows[0]?.v === true;
  if (!allowed) fail(403, level === 'company' ? 'Leadership and admins set the company\'s goals'
    : level === 'team' ? 'Leadership, admins and the team\'s heads set its goals' : 'You set your own goals; managers set their people\'s');
  const args = [level, title, why, ownerId, teamId, parentId, targetOn, measure.label, measure.start, measure.target, measure.current, status];
  if (!old) {
    return (await c.query(`insert into pulse.goal(org_id,level,title,why,owner_person_id,unit_id,parent_id,target_on,measure_label,start_value,target_value,current_value,status,created_by)
      values(pulse.current_org(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,pulse.current_viewer()) returning id`, args)).rows[0].id;
  }
  const r = await c.query(`update pulse.goal set title=$2,why=$3,owner_person_id=$4,unit_id=$5,parent_id=$6,target_on=$7,measure_label=$8,start_value=$9,target_value=$10,
      current_value=$11,status=$12 where id=$13 and level=$1 returning id`, [...args, old.id]);
  return r.rows[0]?.id ?? fail(403, 'You can read this goal but not change it');
}

/** Put a project or a task under a goal. Both the goal (you may change it) and the work (you can see it) are checked. */
export async function linkGoal(c: PoolClient, id: string, b: Row): Promise<string> {
  const g = await getGoal(c, id);
  if (!g.canEdit) fail(403, 'You can read this goal but not change it');
  const projectId = b.projectId ? (UUID.test(String(b.projectId)) ? String(b.projectId) : fail(400, 'Choose a project')) : null;
  const taskId = b.taskId ? (UUID.test(String(b.taskId)) ? String(b.taskId) : fail(400, 'Choose a task')) : null;
  if ((projectId ? 1 : 0) + (taskId ? 1 : 0) !== 1) fail(400, 'Choose one project or one task');
  if (projectId && !(await c.query('select 1 from pulse.project where id=$1', [projectId])).rowCount) fail(404, 'That project is not one you can see');
  if (taskId && !(await c.query('select 1 from pulse.task where id=$1', [taskId])).rowCount) fail(404, 'That task is not one you can see');
  const had = (await c.query('select id from pulse.goal_link where goal_id=$1 and (project_id=$2 or task_id=$3)', [g.id, projectId, taskId])).rows[0]?.id;
  if (had) return String(had);
  return (await c.query(`insert into pulse.goal_link(org_id,goal_id,project_id,task_id,added_by) values(pulse.current_org(),$1,$2,$3,pulse.current_viewer()) returning id`,
    [g.id, projectId, taskId])).rows[0].id;
}

export async function unlinkGoal(c: PoolClient, id: string, linkId: string): Promise<boolean> {
  const g = await getGoal(c, id);
  if (!g.canEdit) fail(403, 'You can read this goal but not change it');
  if (!UUID.test(linkId)) fail(404, 'That link is not on this goal');
  const r = await c.query('delete from pulse.goal_link where id=$1 and goal_id=$2 returning id', [linkId, g.id]);
  return r.rowCount ? true : fail(404, 'That link is not on this goal');
}

/** Goals that hold a task or project (for the task and project pages). */
export async function goalsHolding(c: PoolClient, by: { taskId?: string; projectId?: string }) {
  return (await c.query(`select distinct g.id,g.title,g.level from pulse.goal g join pulse.goal_link l on l.goal_id=g.id
    where g.status='active' and (l.task_id=$1 or l.project_id=$2 or l.project_id=(select t.project_id from pulse.task t where t.id=$1)) limit 20`,
    [by.taskId ?? null, by.projectId ?? null])).rows as { id: string; title: string; level: GoalLevel }[];
}

// ------------------------------------------------------------------------------------------------ screens
type Body = Record<string, unknown>;
const body = { type: 'object' } as const;
const TODAY = `(now() at time zone pulse.org_time_zone())::date::text`;
export function registerGoalRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // The goals page and My day's card: goals the viewer may see, the teams for a team goal, and whether they set the company's.
  app.get<{ Querystring: Record<string, string> }>('/api/v0/goals', req => tx(req, async c => {
    const q = req.query;
    const level = LEVELS.includes(q.level as GoalLevel) ? q.level as GoalLevel : undefined;
    const status = (STATUSES as readonly string[]).includes(q.status) ? q.status : undefined;
    const goals = await listGoals(c, { level, status, who: q.who === 'me' ? 'me' : 'all' });
    const flags = (await c.query(`select pulse.goal_can_edit('company',null,null) company,pulse.current_viewer() me,${TODAY} today,
      (select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'canEdit',pulse.goal_can_edit('team',null,u.id)) order by u.name),'[]') from pulse.unit u
        where u.kind in ('department','team','pod') and (u.valid_to is null or u.valid_to>=current_date)) teams`)).rows[0];
    return { goals, me: flags.me, today: flags.today, canCompany: flags.company === true, teams: flags.teams };
  }));
  app.post<{ Body: Body }>('/api/v0/goals', { schema: { body } }, req => tx(req, async c => ({ goal: await getGoal(c, await saveGoal(c, null, req.body ?? {})) })));
  app.get<{ Params: { id: string } }>('/api/v0/goals/:id', req => tx(req, async c => {
    const goal = await getGoal(c, req.params.id);
    const extra = (await c.query(`select ${TODAY} today,pulse.goal_can_edit('company',null,null) company,
      (select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'canEdit',pulse.goal_can_edit('team',null,u.id)) order by u.name),'[]') from pulse.unit u
        where u.kind in ('department','team','pod') and (u.valid_to is null or u.valid_to>=current_date)) teams`)).rows[0];
    return { goal, ...(await goalWork(c, goal.id)), today: extra.today, canCompany: extra.company === true, teams: extra.teams };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/goals/:id', { schema: { body } }, req => tx(req, async c => ({ goal: await getGoal(c, await saveGoal(c, goalId(req.params.id), req.body ?? {})) })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/goals/:id/links', { schema: { body } }, req => tx(req, async c => {
    const linkId = await linkGoal(c, goalId(req.params.id), req.body ?? {});
    return { linkId, goal: await getGoal(c, req.params.id) };
  }));
  app.post<{ Params: { id: string; linkId: string } }>('/api/v0/goals/:id/links/:linkId/remove', req => tx(req, async c => {
    await unlinkGoal(c, goalId(req.params.id), req.params.linkId);
    return { ok: true, goal: await getGoal(c, req.params.id) };
  }));
  // What may be put under a goal: projects and open tasks the viewer can see, matching a few letters.
  app.get<{ Querystring: Record<string, string> }>('/api/v0/goals-pick', req => tx(req, async c => {
    const q = String(req.query.q ?? '').trim().slice(0, 80);
    const like = `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    const projects = (await c.query(`select id,coalesce(title,name) title,status from pulse.project where coalesce(title,name) ilike $1 and status not in ('cancelled')
      order by updated_at desc limit 8`, [like])).rows;
    const tasks = (await c.query(`select id,title,status from pulse.task where title ilike $1 and status not in ('cancelled','done','accepted')
      order by coalesce(updated_at,created_at) desc nulls last limit 8`, [like])).rows;
    return { projects, tasks };
  }));
}
