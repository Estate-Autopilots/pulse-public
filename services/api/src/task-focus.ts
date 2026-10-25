import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, hr, leadership, type Tx, type Viewer } from './routes.js';
import { heuristicPlanner, planHash, type PlanPerson, type TaskPlanner } from './ai/task-planner.js';
import { FROM, TASK } from './tasks.js';

/** TASKS-P0 (11 Oct 2026): what a task page needs to answer "what, by when, how" — the checklist from the notes, Pip's
 *  plan, what finishing it unlocks, the same work elsewhere — plus the unlock map, the biggest blockers and the
 *  company's project categories. Decisions stay in the database functions of 0162. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const str = (x: unknown, max = 300) => String(x ?? '').trim().slice(0, max);
const body = { type: 'object' } as const;
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use tasks');
const OPEN = `('open','in_progress','blocked','unknown')`;
const PHOTO = (a: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${a}.id)`;
export const planner: TaskPlanner = heuristicPlanner;

// ------------------------------------------------------------------------------------------------ the same work
// The same rule as apps/web/app/lib/task-sense.mjs (sameWork); test/task-focus.test.mjs keeps the two in step.
const STOP = new Set(['a', 'an', 'and', 'the', 'to', 'of', 'for', 'on', 'in', 'with', 'that', 'this', 'it', 'is', 'by', 'at', 'or', 'be', 'from', 'our', 'your', 'all', 'every', 'any']);
const VERSION = /^(v\d+|\d+(\.\d+)*|draft|final|new)$/;
export function stem(w: string) {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}
export function workTokens(title: string) {
  return [...new Set(String(title).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/)
    .map(stem).filter((w) => w.length > 1 && !STOP.has(w) && !VERSION.test(w)))];
}
export function sameWork(a: string, b: string) {
  const x = workTokens(a), y = workTokens(b), ys = new Set(y);
  const shared = x.filter((w) => ys.has(w)).length;
  if (shared < 3 || !x.length || !y.length) return 0;
  const c = shared / Math.min(x.length, y.length);
  const pairs = (t: string[]) => new Set(t.slice(1, -1).map((w, i) => `${w} ${t[i + 2]}`));
  const py = pairs(y), phrase = [...pairs(x)].some((p) => py.has(p));
  return Math.round((x[0] === y[0] ? (phrase || c >= 0.8 ? c : 0) : c >= 0.8 ? c * 0.9 : 0) * 100) / 100;
}
export const SAME_WORK_AT = 0.6;

/** Open tasks of the same person that read as the same work as `task`, with what people already decided about them. */
export async function sameWorkFor(c: PoolClient, task: { id: string; title: string; assigneeId: string | null }) {
  if (!task.assigneeId) return [];
  const rows = (await c.query(`select t.id,t.title,t.status,coalesce(pr.title,pr.name) "projectName",t.project_id "projectId",s.state
    from pulse.task t left join pulse.project pr on pr.id=t.project_id
    left join pulse.task_same s on s.org_id=t.org_id and s.task_a=least(t.id,$1::uuid) and s.task_b=greatest(t.id,$1::uuid)
    where coalesce(t.assignee_person_id,t.owner_id)=$2 and t.id<>$1 and (t.status in ${OPEN} or s.state in ('linked','merged')) limit 400`, [task.id, task.assigneeId])).rows;
  return rows.map((r) => ({ ...r, score: sameWork(task.title, String(r.title)) }))
    .filter((r) => (r.state === 'linked' || r.state === 'merged') || (r.state !== 'dismissed' && r.score >= SAME_WORK_AT)).sort((a, b) => b.score - a.score).slice(0, 4);
}

/** Pairs of the same work among a list of open tasks (for badges on the board): task id → the other's id and title. */
export async function sameWorkPairs(c: PoolClient, tasks: { id: string; title: string; assigneeId: string | null; status: string }[]) {
  const open = tasks.filter((t) => t.assigneeId && ['open', 'in_progress', 'blocked', 'unknown'].includes(t.status));
  const decided = open.length ? (await c.query(`select task_a,task_b,state from pulse.task_same where task_a=any($1) or task_b=any($1)`, [open.map((t) => t.id)])).rows : [];
  const said = new Map(decided.map((d) => [`${d.task_a}:${d.task_b}`, d.state as string]));
  const out: Record<string, { id: string; title: string; linked: boolean }> = {};
  for (let i = 0; i < open.length; i++) for (let j = i + 1; j < open.length; j++) {
    const a = open[i], b = open[j]; if (a.assigneeId !== b.assigneeId) continue;
    const key = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`; const state = said.get(key);
    if (state === 'dismissed' || state === 'merged') continue;
    if (state === 'linked' || sameWork(a.title, b.title) >= SAME_WORK_AT) { out[a.id] ??= { id: b.id, title: b.title, linked: state === 'linked' }; out[b.id] ??= { id: a.id, title: a.title, linked: state === 'linked' }; }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ what it unlocks
/** Open tasks that wait on this one: who does them, what they are worth, and whether this is their last blocker. The
 *  chain beyond them is summed too ("and 3 more later down the chain"). Only tasks the viewer can see are counted. */
export async function unlocksFor(c: PoolClient, taskId: string) {
  const direct = (await c.query(`select w.id,w.title,w.status,coalesce(w.assignee_person_id,w.owner_id) "personId",wp.display_name "personName",${PHOTO('wp')} "photoAt",
    w.estimate_minutes "estimateMinutes",(w.due_at at time zone ${ORG_TZ})::date::text "dueOn",w.due_at "dueAt",
    pulse.task_open_blockers(w.id) "openBlockers"
    from pulse.task_link l join pulse.task w on w.id=l.task_id left join pulse.person wp on wp.id=coalesce(w.assignee_person_id,w.owner_id)
    where l.blocker_id=$1 and l.cleared_at is null and w.status in ${OPEN} order by w.due_at nulls last,w.title`, [taskId])).rows;
  const chain = (await c.query(`with recursive down(id,depth) as (select l.task_id,1 from pulse.task_link l where l.blocker_id=$1 and l.cleared_at is null
     union select l.task_id,d.depth+1 from pulse.task_link l join down d on l.blocker_id=d.id where l.cleared_at is null and d.depth<12)
    select count(distinct t.id)::int n,0 value,coalesce(sum(distinct_minutes),0)::int minutes,count(distinct coalesce(t.assignee_person_id,t.owner_id))::int people
    from (select distinct id from down) d join pulse.task t on t.id=d.id
    cross join lateral (select coalesce(t.estimate_minutes,0) distinct_minutes) v where t.status in ${OPEN}`, [taskId])).rows[0];
  const people = new Set(direct.map((r) => r.personId).filter(Boolean));
  return { tasks: direct, now: direct.filter((r) => Number(r.openBlockers) <= 1).length, people: people.size,
    value: 0, minutes: direct.reduce((n, r) => n + Number(r.estimateMinutes ?? 0), 0),
    chain: { tasks: chain.n, value: chain.value, minutes: chain.minutes, people: chain.people } };
}

// ------------------------------------------------------------------------------------------------ Pip's plan
async function planInput(c: PoolClient, v: Viewer, taskId: string) {
  const t = (await c.query(`select ${TASK},t.notes from ${FROM} where t.id=$1`, [taskId])).rows[0] ?? fail(404, 'Task not found');
  const staff = (await c.query(`select p.id,p.display_name name,pp.role,pp.pod,pp.department from pulse.person p join pulse.people_profile pp on pp.person_id=p.id
    where p.side='staff' and p.status='active' order by p.display_name`)).rows as PlanPerson[];
  const who = (pid: unknown) => staff.find((p) => p.id === pid) ?? null;
  const waiting = (await c.query(`select w.title,coalesce(w.assignee_person_id,w.owner_id) pid from pulse.task_link l join pulse.task w on w.id=l.task_id
    where l.blocker_id=$1 and l.cleared_at is null and w.status in ${OPEN}`, [taskId])).rows.map((r) => ({ title: r.title, person: who(r.pid) }));
  const blockers = (await c.query(`select b.title,coalesce(b.assignee_person_id,b.owner_id) pid from pulse.task_link l join pulse.task b on b.id=l.blocker_id
    where l.task_id=$1 and l.cleared_at is null and b.status in ${OPEN}`, [taskId])).rows.map((r) => ({ title: r.title, person: who(r.pid) }));
  const related = t.assigneeId ? (await c.query(`select t.id,t.title,t.review_owner_id "reviewerId",(t.due_at at time zone ${ORG_TZ})::date::text "dueOn"
    from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.id<>$2 and t.status in ('open','in_progress','unknown') order by t.due_at nulls last limit 60`, [t.assigneeId, taskId])).rows : [];
  const day = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
  const overdue = !!t.dueAt && Date.parse(t.dueAt) < Date.now();
  const dueText = t.dueOn ? (t.dueOn === day ? 'Due today' : overdue ? 'Overdue' : `Due ${t.dueOn}`) : null;
  const input = { title: t.title, notes: t.notes, valueNote: t.valueNote, dueText, overdue, estimateMinutes: t.estimateMinutes ?? null,
    doer: who(t.assigneeId), reviewer: who(t.reviewerId), viewerIsDoer: v.person === t.assigneeId, waiting, blockers,
    related: related.map((r) => ({ id: r.id, title: r.title, reviewerId: r.reviewerId, dueText: r.dueOn ? `Due ${r.dueOn}` : null })), staff };
  const hash = planHash({ p: planner.name, v: planner.version, title: t.title, notes: t.notes, valueNote: t.valueNote, dueOn: t.dueOn, est: t.estimateMinutes,
    doer: t.assigneeId, reviewer: t.reviewerId, waiting: waiting.map((w) => w.title), blockers: blockers.map((b) => b.title), day: overdue ? day : null });
  return { input, hash };
}
/** The plan kept for this task: `fresh` when nothing it depends on has changed since. */
export async function cachedPlan(c: PoolClient, v: Viewer, taskId: string) {
  const row = (await c.query('select input_hash,plan,created_at "at" from pulse.task_plan where task_id=$1', [taskId])).rows[0];
  if (!row) return null;
  const { hash } = await planInput(c, v, taskId);
  return { ...row.plan, at: row.at, fresh: row.input_hash === hash };
}

// ------------------------------------------------------------------------------------------------ the unlock map
type MapNode = Row & { id: string; title: string; status: string; minutes: number; value: number };
/** A dependency graph per project or per person: every open link around their tasks, laid out in columns by depth.
 *  The critical path is the longest chain of open work (by estimated time, else by count). */
export async function unlockMap(c: PoolClient, q: { project?: string | null; person?: string | null }) {
  const seed = q.project ? (await c.query(`select id from pulse.task where project_id=$1 and status<>'cancelled' limit 600`, [q.project])).rows.map((r) => r.id)
    : q.person ? (await c.query(`select id from pulse.task where coalesce(assignee_person_id,owner_id)=$1 and (status in ${OPEN} or done_at>now()-interval '30 days') limit 600`, [q.person])).rows.map((r) => r.id) : [];
  if (!seed.length) return { nodes: [], edges: [], critical: [] };
  // Links touching the seed, and one step out on each side (who they wait on, who waits on them), finished links too.
  const links = (await c.query(`select distinct l.task_id "from",l.blocker_id "to" from pulse.task_link l join pulse.task a on a.id=l.task_id join pulse.task b on b.id=l.blocker_id
    where (l.task_id=any($1) or l.blocker_id=any($1)) and a.status<>'cancelled' and b.status<>'cancelled'
      and (l.cleared_at is null or b.status in ('done','accepted','in_review'))`, [seed])).rows as { from: string; to: string }[];
  // Only work in a chain: a task that waits on nothing and blocks nothing is not on the map.
  const ids = [...new Set(links.flatMap((l) => [l.from, l.to]))];
  if (!ids.length) return { nodes: [], edges: [], critical: [] };
  const nodes = (await c.query(`select t.id,t.title,t.status,t.priority,coalesce(t.assignee_person_id,t.owner_id) "personId",a.display_name "personName",${PHOTO('a')} "photoAt",
    (t.due_at at time zone ${ORG_TZ})::date::text "dueOn",t.due_at "dueAt",0 value,coalesce(t.estimate_minutes,0)::int minutes,
    t.project_id "projectId",coalesce(pr.title,pr.name) "projectName",t.unlocked_at "unlockedAt"
    from pulse.task t left join pulse.person a on a.id=coalesce(t.assignee_person_id,t.owner_id) left join pulse.project pr on pr.id=t.project_id where t.id=any($1)`, [ids])).rows as MapNode[];
  const known = new Set(nodes.map((n) => n.id));
  const edges = links.filter((l) => known.has(l.from) && known.has(l.to));
  // Depth: a task sits one column right of everything it waits on (blockers on the left, what they unlock to the right).
  const waitsOn = new Map<string, string[]>(); for (const e of edges) waitsOn.set(e.from, [...(waitsOn.get(e.from) ?? []), e.to]);
  const depth = new Map<string, number>();
  const depthOf = (n: string, seen = new Set<string>()): number => {
    if (depth.has(n)) return depth.get(n)!; if (seen.has(n)) return 0; seen.add(n);
    const d = Math.max(-1, ...(waitsOn.get(n) ?? []).map((b) => depthOf(b, seen))) + 1; depth.set(n, d); return d;
  };
  for (const n of nodes) n.depth = depthOf(n.id);
  // Critical path: the heaviest chain of open work (minutes, else one per task), walked from its last task back.
  const open = new Set(nodes.filter((n) => ['open', 'in_progress', 'blocked', 'unknown'].includes(n.status)).map((n) => n.id));
  const weight = (n: MapNode) => (n.minutes || 30);
  const best = new Map<string, { w: number; prev: string | null }>();
  for (const n of [...nodes].sort((a, b) => Number(a.depth) - Number(b.depth))) {
    if (!open.has(n.id)) continue;
    const before = (waitsOn.get(n.id) ?? []).filter((b) => open.has(b)).map((b) => ({ b, w: best.get(b)?.w ?? 0 })).sort((a, b) => b.w - a.w)[0];
    best.set(n.id, { w: weight(n) + (before?.w ?? 0), prev: before?.b ?? null });
  }
  const end = [...best.entries()].sort((a, b) => b[1].w - a[1].w)[0];
  const critical: string[] = [];
  for (let at: string | null = end?.[0] ?? null; at; at = best.get(at)?.prev ?? null) critical.unshift(at);
  return { nodes, edges, critical: critical.length > 1 ? critical : [] };
}

/** Open tasks with the most work waiting on them (directly or down the chain), for leaders (no value: INTEGRITY 0910). */
export async function biggestBlockers(c: PoolClient, limit = 8) {
  return (await c.query(`with recursive down(root,id,depth) as (
      select l.blocker_id,l.task_id,1 from pulse.task_link l join pulse.task b on b.id=l.blocker_id where l.cleared_at is null and b.status in ${OPEN}
      union select d.root,l.task_id,d.depth+1 from pulse.task_link l join down d on l.blocker_id=d.id where l.cleared_at is null and d.depth<12)
    select b.id,b.title,b.status,coalesce(b.assignee_person_id,b.owner_id) "personId",bp.display_name "personName",${PHOTO('bp')} "photoAt",
      (b.due_at at time zone ${ORG_TZ})::date::text "dueOn",b.due_at "dueAt",coalesce(pr.title,pr.name) "projectName",
      count(distinct w.id)::int waiting,count(distinct coalesce(w.assignee_person_id,w.owner_id))::int people,
      0 value,coalesce(sum(w.estimate_minutes),0)::int minutes
    from (select distinct root,id from down) d join pulse.task b on b.id=d.root join pulse.task w on w.id=d.id and w.status in ${OPEN}
    left join pulse.person bp on bp.id=coalesce(b.assignee_person_id,b.owner_id) left join pulse.project pr on pr.id=b.project_id
    group by b.id,bp.id,pr.id order by 10 desc,11 desc,13 desc,b.due_at nulls last limit $1`, [limit])).rows;
}

// ------------------------------------------------------------------------------------------------ names
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Projects with nearly the same name, and tidier names to choose from. */
export async function nameCheck(c: PoolClient, name: string, except: string | null) {
  const n = tidy(name); if (n.length < 2) return { similar: [], suggestions: [] };
  const words = workTokens(n);
  const rows = (await c.query(`select pr.id,coalesce(pr.title,pr.name) name,(select count(*)::int from pulse.task t where t.project_id=pr.id) tasks,wp.kind
    from pulse.project pr join pulse.work_project wp on wp.project_id=pr.id where pr.status<>'cancelled' and ($1::uuid is null or pr.id<>$1) limit 2000`, [except])).rows;
  const similar = rows.map((r) => {
    const other = workTokens(String(r.name)); const shared = words.filter((w) => other.includes(w) || other.some((o) => o.startsWith(w) || w.startsWith(o))).length;
    const score = shared / Math.max(1, Math.min(words.length, other.length));
    return { ...r, score: tidy(String(r.name)).toLowerCase() === n.toLowerCase() ? 1 : score };
  }).filter((r) => r.score >= 0.67 && words.length).sort((a, b) => b.score - a.score || b.tasks - a.tasks).slice(0, 4);
  const suggestions = new Set<string>();
  const cased = n.replace(/\b(and)\b/gi, '&').replace(/^./, (x) => x.toUpperCase());
  if (cased !== n) suggestions.add(cased);
  if (/\b(project|work|tasks?)$/i.test(n)) suggestions.add(n.replace(/\s*\b(project|work|tasks?)$/i, ''));
  if (/\b20\d\d\b/.test(n) === false && /\b(launch|roadmap|plan|campaign|onboarding)\b/i.test(n)) suggestions.add(`${cased} ${new Date().getFullYear()}`);
  return { similar, suggestions: [...suggestions].filter((s) => s && s !== n).slice(0, 3) };
}

// ------------------------------------------------------------------------------------------------ routes
export function registerTaskFocusRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // Tick or untick a step from the notes (the doer, or anyone who may edit the task).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/checks', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const b = req.body;
    return (await c.query('select pulse.task_check_set($1,$2,$3,$4) r', [id(req.params.id), str(b.key, 12), str(b.label, 500), b.done === true])).rows[0].r;
  }));
  // Pip's plan: the kept one (GET), or plan now and keep it (POST). Never sends anything.
  app.get<{ Params: { id: string } }>('/api/v0/tasks/:id/plan', req => tx(req, async (c, v) => ({ plan: await cachedPlan(c, v, id(req.params.id)) })));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/plan', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const tid = id(req.params.id);
    if (req.body.refresh !== true) { const kept = await cachedPlan(c, v, tid); if (kept?.fresh) return { plan: kept }; }
    const { input, hash } = await planInput(c, v, tid);
    const plan = await planner.plan(input);
    await c.query('select pulse.task_plan_save($1,$2,$3,$4)', [tid, hash, `${plan.planner}@${plan.version}`, JSON.stringify(plan)]);
    return { plan: { ...plan, at: new Date().toISOString(), fresh: true } };
  }));
  // The same work: link, dismiss the suggestion, or merge the other task into this one (by hand only).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/same', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const state = str(req.body.state, 20); if (!['linked', 'dismissed'].includes(state)) fail(400, 'Link them, or say they are different');
    await c.query('select pulse.task_same_set($1,$2,$3)', [id(req.params.id), id(req.body.otherId), state]); return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/merge', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.task_merge($1,$2) r', [id(req.params.id), id(req.body.otherId)])).rows[0].r;
  }));
  // The unlock map for a project or a person.
  app.get('/api/v0/tasks/map', req => tx(req, async (c, v) => {
    const q = req.query as { project?: string; person?: string };
    const project = q.project ? id(q.project) : null, who = q.person ? id(q.person) : project ? null : v.person;
    if (!project && !who) return { nodes: [], edges: [], critical: [], scope: 'person', id: null, title: 'Nobody', today: null, me: null, projects: [] };
    const map = await unlockMap(c, { project, person: who });
    const title = project ? (await c.query('select coalesce(title,name) n from pulse.project where id=$1', [project])).rows[0]?.n ?? fail(404, 'Project not found')
      : (await c.query('select display_name n from pulse.person where id=$1', [who])).rows[0]?.n ?? fail(404, 'Person not found');
    const today = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d;
    return { ...map, scope: project ? 'project' : 'person', id: project ?? who, title, today, me: v.person,
      projects: (await c.query(`select pr.id,coalesce(pr.title,pr.name) name,count(*)::int links from pulse.task_link l join pulse.task t on t.id=l.task_id join pulse.project pr on pr.id=t.project_id
        where l.cleared_at is null group by pr.id order by 3 desc limit 30`)).rows };
  }));
  // Leaders: the open tasks with the most work waiting on them.
  app.get('/api/v0/tasks/biggest-blockers', req => tx(req, async (c, v) => {
    if (!leadership(v) && !hr(v)) fail(403, 'The biggest blockers are for leadership');
    return { rows: await biggestBlockers(c, 12) };
  }));
  // Project categories: the company's own (defaults on first use); leadership names them.
  app.get('/api/v0/work/project-categories', req => tx(req, async (c, v) => {
    await c.query('select pulse.project_category_ensure()');
    const rows = (await c.query(`select pc.key,pc.label,pc.icon,pc.color,pc.sort,pc.retired_at is not null retired,
      (select count(*)::int from pulse.work_project wp where wp.project_category=pc.key or (wp.project_category is null and pc.key=case when wp.kind='internal' then 'internal' else 'client' end)) projects
      from pulse.project_category pc order by pc.retired_at is not null,pc.sort,pc.label`)).rows;
    return { rows, canEdit: leadership(v) };
  }));
  app.post<{ Body: Body }>('/api/v0/work/project-categories', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const b = req.body; const p: Body = { label: str(b.label, 60) };
    for (const k of ['key', 'icon', 'color']) if (b[k]) p[k] = str(b[k], 40);
    if (b.sort !== undefined && b.sort !== null && b.sort !== '') p.sort = Number(b.sort);
    if (b.retired === true) p.retired = true;
    return { key: (await c.query('select pulse.project_category_save($1) k', [JSON.stringify(p)])).rows[0].k };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/projects/:id/style', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const p: Body = {};
    for (const k of ['category', 'color', 'icon']) if (k in req.body) p[k] = req.body[k] === null ? '' : str(req.body[k], 40);
    await c.query('select pulse.work_project_style($1,$2)', [id(req.params.id), JSON.stringify(p)]); return { ok: true };
  }));
  app.get('/api/v0/work/projects/name-check', req => tx(req, async (c) => {
    const q = req.query as { name?: string; id?: string };
    return nameCheck(c, str(q.name, 200), q.id ? id(q.id) : null);
  }));
}
