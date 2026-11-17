import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { ORG_TZ } from './org-time.js';
import { fail, type Tx, type Viewer } from './routes.js';

/** BLOCKERS-MAP (7 Nov 2026): the dependency map. Any piece of work (a task, a project or a goal) can wait on any other.
 *  A task waiting on a task lives in pulse.task_link (the task flow's own link); every link with a project or a goal at
 *  an end lives in pulse.work_dependency (migration "work_dependency"). The map reads both, plus "feeds" lines from the
 *  work under a goal to the goal. Everything is read as the viewer, so row security decides what shows; a link whose
 *  other end the viewer cannot see is left out. Adding and taking off links is decided in the database functions. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
type Kind = 'task' | 'project' | 'goal';
const KINDS: Kind[] = ['task', 'project', 'goal'];
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const kindOf = (x: unknown): Kind => KINDS.includes(String(x) as Kind) ? String(x) as Kind : fail(400, 'Choose a task, a project or a goal');
const str = (x: unknown, max = 300) => String(x ?? '').trim().slice(0, max);
const body = { type: 'object' } as const;
const DONE_TASK = ['done', 'accepted', 'in_review'];
const MAX_NODES = 450;

export type DepState = 'done' | 'active' | 'blocked' | 'open';
export type DepNode = { key: string; kind: Kind; id: string; title: string; status: string; state: DepState; personName: string | null;
  dueOn: string | null; late: boolean; href: string; context: string | null; minutes: number };
export type DepEdge = { id: string; from: string; to: string; type: 'blocks' | 'feeds'; table: 'task' | 'work' | 'goal'; done: boolean; note: string | null };
type Link = { id: string; wk: Kind; wid: string; bk: Kind; bid: string; table: 'task' | 'work'; note: string | null };

const key = (k: Kind, i: string) => `${k}:${i}`;

/** Links touching the given work (both tables), open ones and task links whose blocker finished. */
async function linksAround(c: PoolClient, ids: string[]): Promise<Link[]> {
  if (!ids.length) return [];
  const tasks = (await c.query(`select l.id,'task' wk,l.task_id wid,'task' bk,l.blocker_id bid,'task' "table",l.note from pulse.task_link l
      join pulse.task a on a.id=l.task_id join pulse.task b on b.id=l.blocker_id
      where (l.task_id=any($1) or l.blocker_id=any($1)) and a.status<>'cancelled' and b.status<>'cancelled'
        and (l.cleared_at is null or b.status in ('done','accepted','in_review')) limit 2000`, [ids])).rows as Link[];
  const work = (await c.query(`select d.id,d.waiter_kind wk,d.waiter_id wid,d.blocker_kind bk,d.blocker_id bid,'work' "table",d.note from pulse.work_dependency d
      where d.cleared_at is null and (d.waiter_id=any($1) or d.blocker_id=any($1)) limit 2000`, [ids])).rows as Link[];
  return [...tasks, ...work];
}

/** The map for a project, a goal, a person or the whole company (every open link). */
export async function dependencyGraph(c: PoolClient, v: Viewer, q: { project?: string | null; goal?: string | null; person?: string | null; all?: boolean }) {
  const seed = new Map<string, Kind>();
  const feeds: DepEdge[] = [];
  if (q.project) {
    seed.set(q.project, 'project');
    for (const r of (await c.query(`select id from pulse.task where project_id=$1 and status<>'cancelled' order by created_at limit 400`, [q.project])).rows) seed.set(r.id, 'task');
  } else if (q.goal) {
    seed.set(q.goal, 'goal');
    for (const r of (await c.query(`select l.id,l.project_id,l.task_id from pulse.goal_link l where l.goal_id=$1`, [q.goal])).rows) {
      const k: Kind = r.project_id ? 'project' : 'task', i = r.project_id ?? r.task_id;
      seed.set(i, k); feeds.push({ id: `feed:${r.id}`, from: key(k, i), to: key('goal', q.goal), type: 'feeds', table: 'goal', done: false, note: null });
    }
    for (const r of (await c.query(`select id from pulse.goal where parent_id=$1 and status<>'dropped' limit 60`, [q.goal])).rows) {
      seed.set(r.id, 'goal'); feeds.push({ id: `sub:${r.id}`, from: key('goal', r.id), to: key('goal', q.goal), type: 'feeds', table: 'goal', done: false, note: null });
    }
  } else if (q.person) {
    for (const r of (await c.query(`select id from pulse.task where coalesce(assignee_person_id,owner_id)=$1
        and (status in ('open','in_progress','blocked','unknown') or done_at>now()-interval '30 days') limit 400`, [q.person])).rows) seed.set(r.id, 'task');
  } else if (q.all) {
    for (const r of (await c.query(`select task_id a,blocker_id b from pulse.task_link where cleared_at is null limit 1500`)).rows) { seed.set(r.a, 'task'); seed.set(r.b, 'task'); }
    for (const r of (await c.query(`select waiter_kind wk,waiter_id wid,blocker_kind bk,blocker_id bid from pulse.work_dependency where cleared_at is null limit 1500`)).rows) { seed.set(r.wid, r.wk); seed.set(r.bid, r.bk); }
  }
  // Follow the links out from the seed: one step each way (what it waits on, what waits on it), then only upstream, the
  // whole chain of what stands in front (up to 8 steps), within a size limit. What the outside work unblocks elsewhere
  // is not this map's business.
  const links = new Map<string, Link>();
  let frontier = [...seed.keys()];
  for (let hop = 0; hop < 8 && frontier.length && seed.size < MAX_NODES; hop++) {
    const front = new Set(frontier);
    const found = await linksAround(c, frontier);
    const next: string[] = [];
    for (const l of found) {
      const upstream = front.has(l.wid);
      if (hop > 0 && !upstream) continue;
      links.set(`${l.table}:${l.id}`, l);
      for (const [k, i] of [[l.wk, l.wid], [l.bk, l.bid]] as [Kind, string][]) if (!seed.has(i) && seed.size < MAX_NODES) { seed.set(i, k); next.push(i); }
    }
    frontier = next;
  }
  const byKind = (k: Kind) => [...seed.entries()].filter(([, kk]) => kk === k).map(([i]) => i);
  const today = (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d`)).rows[0].d as string;
  const raw: Omit<DepNode, 'state' | 'late'>[] = [];
  const taskIds = byKind('task'), projectIds = byKind('project'), goalIds = byKind('goal');
  if (taskIds.length) raw.push(...(await c.query(`select 'task' kind,t.id,t.title,t.status,a.display_name "personName",(t.due_at at time zone ${ORG_TZ})::date::text "dueOn",
      '/tasks/'||t.id href,case when t.project_id is distinct from $2::uuid then coalesce(pr.title,pr.name) end context,coalesce(t.estimate_minutes,0)::int minutes
      from pulse.task t left join pulse.person a on a.id=coalesce(t.assignee_person_id,t.owner_id) left join pulse.project pr on pr.id=t.project_id
      where t.id=any($1) and t.status<>'cancelled'`, [taskIds, q.project ?? null])).rows);
  if (projectIds.length) raw.push(...(await c.query(`select 'project' kind,p.id,coalesce(p.title,p.name) title,coalesce(wp.status,p.status) status,a.display_name "personName",
      wp.due_on::text "dueOn",case when wp.project_id is not null then '/tasks/projects/'||p.id else '/projects/'||p.id end href,null context,0 minutes
      from pulse.project p left join pulse.work_project wp on wp.project_id=p.id left join pulse.person a on a.id=coalesce(wp.owner_id,p.lead_person_id)
      where p.id=any($1) and coalesce(wp.status,p.status)<>'cancelled'`, [projectIds])).rows);
  if (goalIds.length) raw.push(...(await c.query(`select 'goal' kind,g.id,g.title,g.status,a.display_name "personName",g.target_on::text "dueOn",'/goals/'||g.id href,
      initcap(g.level)||' goal' context,0 minutes from pulse.goal g left join pulse.person a on a.id=g.owner_person_id where g.id=any($1) and g.status<>'dropped'`, [goalIds])).rows);
  const known = new Map(raw.map((n) => [key(n.kind, n.id), n]));
  const isDone = (n: Omit<DepNode, 'state' | 'late'>) => n.kind === 'task' ? DONE_TASK.includes(n.status) : n.status === 'done';
  const edges: DepEdge[] = [...links.values()].map((l): DepEdge => ({ id: l.id, from: key(l.bk, l.bid), to: key(l.wk, l.wid), type: 'blocks', table: l.table, done: false, note: l.note }))
    .concat(feeds).filter((e) => known.has(e.from) && known.has(e.to));
  for (const e of edges) e.done = isDone(known.get(e.from)!);
  const waiting = new Set(edges.filter((e) => e.type === 'blocks' && !e.done).map((e) => e.to));
  const nodes: DepNode[] = raw.map((n) => {
    const done = isDone(n);
    const state: DepState = done ? 'done' : n.status === 'blocked' || n.status === 'paused' || waiting.has(key(n.kind, n.id)) ? 'blocked'
      : n.status === 'in_progress' || (n.kind !== 'task' && n.status === 'active') ? 'active' : 'open';
    return { ...n, key: key(n.kind, n.id), state, late: !done && !!n.dueOn && n.dueOn < today };
  });
  // A project's own node shows only when something links to it (its tasks are already the map).
  const linked = new Set(edges.flatMap((e) => [e.from, e.to]));
  const shown = nodes.filter((n) => !(q.project && n.kind === 'project' && n.id === q.project && !linked.has(n.key)));
  return { nodes: shown, edges, today, me: v.person };
}

export function registerDependencyRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // The map: ?project= | ?goal= | ?person= | ?all=1 (default: the viewer's own work).
  app.get('/api/v0/dependencies/graph', req => tx(req, async (c, v) => {
    const q = req.query as Record<string, string | undefined>;
    const project = q.project ? id(q.project) : null, goal = !project && q.goal ? id(q.goal) : null;
    const all = !project && !goal && q.all === '1';
    const person = !project && !goal && !all ? (q.person ? id(q.person) : v.person) : null;
    const scope = project ? 'project' : goal ? 'goal' : all ? 'all' : 'person';
    const scopeId = project ?? goal ?? person;
    const title = project ? (await c.query('select coalesce(title,name) n from pulse.project where id=$1', [project])).rows[0]?.n ?? fail(404, 'Project not found')
      : goal ? (await c.query('select title n from pulse.goal where id=$1', [goal])).rows[0]?.n ?? fail(404, 'Goal not found')
      : person ? (await c.query('select display_name n from pulse.person where id=$1', [person])).rows[0]?.n ?? fail(404, 'Person not found') : 'Whole company';
    const graph = await dependencyGraph(c, v, { project, goal, person, all });
    // What can be linked from here: the map's own work, plus projects and goals the viewer can see.
    const projects = (await c.query(`select p.id,coalesce(p.title,p.name) title,count(l.id)::int links from pulse.project p left join pulse.work_project wp on wp.project_id=p.id
        left join pulse.task t on t.project_id=p.id left join pulse.task_link l on l.task_id=t.id and l.cleared_at is null
        where coalesce(wp.status,p.status) not in ('done','cancelled') group by p.id order by 3 desc,2 limit 200`)).rows as { id: string; title: string; links: number }[];
    const goals = (await c.query(`select id,title from pulse.goal where status='active' order by updated_at desc limit 120`)).rows as { id: string; title: string }[];
    return { ...graph, scope, id: scopeId, title, projects, goals };
  }));
  // Make one piece of work wait on another (any kind on any kind).
  app.post<{ Body: Body }>('/api/v0/dependencies', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in with your own account to link work');
    const b = req.body ?? {};
    const wk = kindOf(b.waiterKind), wid = id(b.waiterId), bk = kindOf(b.blockerKind), bid = id(b.blockerId);
    // Both ends must be work the viewer can see (read as the viewer, under row security).
    const seen = (await c.query('select pulse.work_item_visible($1,$2) a,pulse.work_item_visible($3,$4) b', [wk, wid, bk, bid])).rows[0];
    if (!seen.a || !seen.b) fail(404, 'Choose work you can see');
    const linkId = (await c.query('select pulse.work_dependency_add($1,$2,$3,$4,$5) id', [wk, wid, bk, bid, str(b.note, 300) || null])).rows[0].id as string;
    return { linkId, table: wk === 'task' && bk === 'task' ? 'task' : 'work' };
  }));
  // Take a link off: a task link through the task flow (it reopens the waiting task), any other through its own function.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/dependencies/:id/remove', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!v.person) fail(403, 'Sign in with your own account to change links');
    const lid = id(req.params.id), b = req.body ?? {};
    if (b.table === 'task') {
      const l = (await c.query('select task_id,blocker_id from pulse.task_link where id=$1 and cleared_at is null', [lid])).rows[0] ?? fail(404, 'That link is gone already');
      return { cleared: (await c.query('select pulse.task_unblock($1,$2) n', [l.task_id, l.blocker_id])).rows[0].n };
    }
    return { cleared: (await c.query('select pulse.work_dependency_clear($1) ok', [lid])).rows[0].ok ? 1 : 0 };
  }));
}
