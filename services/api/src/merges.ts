import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { ORG_TZ } from './org-time.js';
import { fail, hr, leadership, type Tx, type Viewer } from './routes.js';
import { createWorkTask } from './work.js';
import { briefNotes, propose, type Cosine, type MTask, type Proposal } from './merge-model.js';

/** TASK-MERGE (owner, 7 Nov 2026: "merge clutter into clarity"). Several tasks merge into ONE task or brief, keeping
 *  their lineage: the originals close as "Merged into …" (never deleted) and keep their history; links, proof, ticked
 *  steps, subtasks and goal links move to the merged task (pulse.work_merge_tasks, migration "work_merge"). The merge
 *  suggester (merge-model.ts) proposes duplicates and clusters for one person's tasks; a person accepts (merges) or
 *  rejects; managers, HR, leadership and admins can run it for their team. The screens (v0 below) and API v1 / MCP / CLI
 *  (v1-merges.ts) share these functions; every read runs as the viewer, so row security decides what shows. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const str = (x: unknown, max = 300) => String(x ?? '').trim().slice(0, max);
const body = { type: 'object' } as const;
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own account to merge work');
const OPEN = `('open','in_progress','blocked','unknown')`;
const RANK: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** The decision model (embeddings) is used only when the company turned it on and vectors exist; otherwise words only. */
async function cosineFor(c: PoolClient, ids: string[]): Promise<Cosine | undefined> {
  if (ids.length < 2) return undefined;
  const on = (await c.query(`select to_regclass('pulse.task_embedding') is not null t`)).rows[0]?.t === true;
  if (!on) return undefined;
  const flag = (await c.query(`select pulse.merge_model_on() ok`)).rows[0]?.ok === true;
  if (!flag) return undefined;
  const rows = (await c.query(`select a.task_id a,b.task_id b,1-(a.embedding<=>b.embedding) cos from pulse.task_embedding a
      join pulse.task_embedding b on b.task_id>a.task_id and b.model=a.model where a.task_id=any($1) and b.task_id=any($1)`, [ids])).rows;
  if (!rows.length) return undefined;
  const m = new Map(rows.map((r) => [`${r.a}:${r.b}`, Number(r.cos)]));
  return (a, b) => m.get(a < b ? `${a}:${b}` : `${b}:${a}`) ?? null;
}

/** Whether the viewer may look at this person's tasks for merges (themselves, their manager, HR, leadership, admins). */
async function inReach(c: PoolClient, who: string) {
  return (await c.query('select pulse.merge_person_in_reach($1) ok', [who])).rows[0]?.ok === true;
}

/** Scan one person's open tasks and keep the proposals (a rejected set is never reopened). */
export async function scanPerson(c: PoolClient, who: string) {
  if (!(await inReach(c, who))) fail(403, 'Only the person, their manager, HR or leadership look at their tasks');
  const tasks = (await c.query(`select t.id,t.title,t.project_id "projectId",coalesce(pr.title,pr.name) "projectName",t.category,
      (t.due_at at time zone ${ORG_TZ})::date::text "dueOn",t.parent_id "parentId"
    from pulse.task t left join pulse.project pr on pr.id=t.project_id
    where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status in ${OPEN} and t.deleted_at is null order by t.created_at desc limit 400`, [who])).rows as MTask[];
  const ids = tasks.map((t) => t.id);
  const apart = new Set<string>(ids.length ? (await c.query(`select task_a||':'||task_b k from pulse.task_same where state='dismissed' and task_a=any($1) and task_b=any($1)`, [ids])).rows.map((r) => r.k as string) : []);
  const found = propose(tasks, { apart, cosine: await cosineFor(c, ids) });
  const open = (await c.query('select pulse.merge_suggestion_save($1,$2) n', [who, JSON.stringify(found)])).rows[0].n as number;
  return { personId: who, tasks: tasks.length, found: found.length, open };
}

/** Everyone whose tasks the viewer may scan besides themselves: all active staff for admins, HR and leadership, the
 *  people they manage for a manager. With their open task and open suggestion counts. */
export async function teamOf(c: PoolClient, v: Viewer) {
  const wide = leadership(v) || hr(v);
  return (await c.query(`select p.id,p.display_name name,
      (select count(*)::int from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=p.id and t.status in ${OPEN} and t.deleted_at is null) open,
      (select count(*)::int from pulse.merge_suggestion s where s.person_id=p.id and s.status='open') suggestions
    from pulse.person p where p.side='staff' and p.status='active' and p.id is distinct from $1::uuid
      and ($2 or coalesce(pulse.manages(p.id),false)) order by 3 desc,2 limit 300`, [v.person, wide])).rows as { id: string; name: string; open: number; suggestions: number }[];
}

export async function scanTeam(c: PoolClient, v: Viewer) {
  const people = (await teamOf(c, v)).filter((p) => p.open >= 2);
  if (!people.length && !(leadership(v) || hr(v))) fail(403, 'Only managers, HR and leadership look at a team');
  let found = 0, open = 0;
  for (const p of people.slice(0, 150)) { const r = await scanPerson(c, p.id); found += r.found; open += r.open; }
  return { people: people.length, found, open };
}

/** Open suggestions for one person, with their tasks (only tasks the viewer can see; a proposal missing one is left out). */
export async function suggestionsFor(c: PoolClient, who: string) {
  const rows = (await c.query(`select s.id,s.kind,s.task_ids "taskIds",s.score::float score,s.method,s.title,s.reason,s.shape,s.created_at "createdAt"
    from pulse.merge_suggestion s where s.person_id=$1 and s.status='open' order by s.kind='duplicate' desc,s.score desc limit 60`, [who])).rows;
  const ids = [...new Set(rows.flatMap((r) => r.taskIds as string[]))];
  const tasks = ids.length ? (await c.query(`select t.id,t.title,t.status,coalesce(pr.title,pr.name) "projectName",(t.due_at at time zone ${ORG_TZ})::date::text "dueOn",t.priority
    from pulse.task t left join pulse.project pr on pr.id=t.project_id where t.id=any($1) and t.status in ${OPEN}`, [ids])).rows : [];
  const byId = new Map(tasks.map((t) => [t.id as string, t]));
  return rows.filter((r) => (r.taskIds as string[]).every((i) => byId.has(i))).map((r) => ({ ...r, tasks: (r.taskIds as string[]).map((i) => byId.get(i)) }));
}

export async function rejectSuggestion(c: PoolClient, sid: string) {
  return { rejected: (await c.query('select pulse.merge_suggestion_reject($1) ok', [sid])).rows[0].ok === true };
}

/** Merge tasks. Without targetId a new task (or brief) is made as the viewer: the originals' common owner and project
 *  when they share one, the earliest due day, the highest priority, and notes that list every original. */
export async function mergeTasks(c: PoolClient, v: Viewer, b: Body) {
  person(v);
  const taskIds = [...new Set((Array.isArray(b.taskIds) ? b.taskIds : []).map(id))];
  if (taskIds.length < 2 && !b.targetId) fail(400, 'Choose at least two tasks to merge');
  if (taskIds.length > 30) fail(400, 'Merge at most 30 tasks at a time');
  const shape = b.shape === 'brief' ? 'brief' : 'task';
  const reason = str(b.reason, 2000) || null;
  const suggestionId = b.suggestionId ? id(b.suggestionId) : null;
  let targetId = b.targetId ? id(b.targetId) : null;
  const sources = (await c.query(`select t.id,t.title,t.notes,t.status,t.priority,t.project_id "projectId",coalesce(t.assignee_person_id,t.owner_id) "personId",
      (t.due_at at time zone ${ORG_TZ})::date::text "dueOn" from pulse.task t where t.id=any($1) and t.deleted_at is null`, [taskIds])).rows as Row[];
  if (sources.length !== taskIds.length) fail(404, 'Choose tasks you can see');
  const ordered = taskIds.map((i) => sources.find((s) => s.id === i)!).filter((s) => s.id !== targetId);
  if (!ordered.length) fail(400, 'Choose the tasks to merge into this one');
  let madeNew = false;
  if (!targetId) {
    const one = <T>(xs: T[]) => xs.length && xs.every((x) => x === xs[0]) ? xs[0] : null;
    const dues = ordered.map((s) => s.dueOn as string | null).filter(Boolean).sort() as string[];
    const title = str(b.title, 300) || (shape === 'brief' ? `Brief: ${String(ordered[0].title)}` : String(ordered[0].title));
    const made = await createWorkTask(c, v, { title, assigneeId: b.assigneeId ? id(b.assigneeId) : one(ordered.map((s) => s.personId)) ?? v.person,
      projectId: b.projectId ? id(b.projectId) : one(ordered.map((s) => s.projectId)), dueOn: dues[0] ?? null,
      priority: ordered.map((s) => String(s.priority)).sort((x, y) => (RANK[y] ?? 1) - (RANK[x] ?? 1))[0] ?? 'normal',
      notes: briefNotes(ordered.map((s) => ({ title: String(s.title), dueOn: (s.dueOn as string) ?? null, notes: (s.notes as string) ?? null })), shape, reason) }) as Row;
    targetId = String(made.id); madeNew = true;
  }
  const mergeId = (await c.query('select pulse.work_merge_tasks($1,$2,$3,$4,$5,$6) id', [targetId, ordered.map((s) => s.id), reason, shape, madeNew, suggestionId])).rows[0].id as string;
  return { mergeId, targetId, madeNew, merged: ordered.length };
}

export async function undoMerge(c: PoolClient, mid: string) {
  return { reopened: (await c.query('select pulse.work_merge_undo($1) n', [mid])).rows[0].n as number };
}

type GNode = { key: string; id: string; title: string; status: string; role: 'source' | 'target' | 'earlier' | 'later'; mergeId: string | null };
type GEdge = { from: string; to: string; mergeId: string };

/** The merge story: what was merged, into what, why, by whom, what moved, and the lineage around it (earlier merges that
 *  made its originals, and a later merge that took the result further). */
export async function mergeStory(c: PoolClient, v: Viewer, mid: string) {
  const m = (await c.query(`select m.id,m.kind,m.target_id "targetId",m.made_new "madeNew",m.shape,m.title,m.reason,m.method,m.created_at "createdAt",
      m.undone_at "undoneAt",u.display_name "undoneBy",p.display_name "createdBy",m.created_by "createdById",
      m.created_at>now()-interval '7 days' and m.undone_at is null and (m.created_by=$2 or pulse.task_can_edit(m.target_id)) "canUndo",
      s.score::float "suggestedScore",s.reason "suggestedReason"
    from pulse.work_merge m left join pulse.person p on p.id=m.created_by left join pulse.person u on u.id=m.undone_by
    left join pulse.merge_suggestion s on s.id=m.suggestion_id where m.id=$1`, [mid, v.person])).rows[0] ?? fail(404, 'Merge not found');
  const target = (await c.query(`select t.id,t.title,case when t.status='cancelled' and t.closed_as is not null then t.closed_as else t.status end status,
      a.display_name "personName",coalesce(pr.title,pr.name) "projectName",(t.due_at at time zone ${ORG_TZ})::date::text "dueOn"
    from pulse.task t left join pulse.person a on a.id=coalesce(t.assignee_person_id,t.owner_id) left join pulse.project pr on pr.id=t.project_id where t.id=$1`, [m.targetId])).rows[0] ?? null;
  const sources = (await c.query(`select s.source_id id,s.position,s.title,s.status_before "statusBefore",s.due_on::text "dueOn",s.moved,
      a.display_name "personName",coalesce(pr.title,pr.name) "projectName",
      case when t.status='cancelled' and t.closed_as is not null then t.closed_as else t.status end "statusNow"
    from pulse.work_merge_source s left join pulse.task t on t.id=s.source_id left join pulse.person a on a.id=s.person_id left join pulse.project pr on pr.id=s.project_id
    where s.merge_id=$1 order by s.position`, [mid])).rows;
  const moved = sources.reduce((n: Record<string, number>, s) => { for (const [k, x] of Object.entries(s.moved as Record<string, number>)) n[k] = (n[k] ?? 0) + Number(x); return n; }, {});
  // Lineage: up to three merges back from each original, and the next merge forward from the result.
  const nodes = new Map<string, GNode>(), edges: GEdge[] = [];
  nodes.set(String(m.targetId), { key: `t:${m.targetId}`, id: String(m.targetId), title: String(target?.title ?? m.title), status: String(target?.status ?? 'open'), role: 'target', mergeId: mid });
  for (const s of sources) { nodes.set(String(s.id), { key: `t:${s.id}`, id: String(s.id), title: String(s.title), status: String(s.statusNow ?? 'merged'), role: 'source', mergeId: mid }); edges.push({ from: `t:${s.id}`, to: `t:${m.targetId}`, mergeId: mid }); }
  let frontier = sources.map((s) => String(s.id));
  for (let hop = 0; hop < 3 && frontier.length && nodes.size < 120; hop++) {
    const up = (await c.query(`select m.id "mergeId",m.target_id target,s.source_id id,s.title,coalesce(case when t.status='cancelled' and t.closed_as is not null then t.closed_as else t.status end,'merged') status
      from pulse.work_merge m join pulse.work_merge_source s on s.merge_id=m.id left join pulse.task t on t.id=s.source_id
      where m.target_id=any($1) and m.undone_at is null limit 200`, [frontier])).rows;
    frontier = [];
    for (const r of up) {
      if (!nodes.has(String(r.id))) { nodes.set(String(r.id), { key: `t:${r.id}`, id: String(r.id), title: String(r.title), status: String(r.status), role: 'earlier', mergeId: String(r.mergeId) }); frontier.push(String(r.id)); }
      edges.push({ from: `t:${r.id}`, to: `t:${r.target}`, mergeId: String(r.mergeId) });
    }
  }
  const later = (await c.query(`select m.id "mergeId",m.target_id id,t.title,case when t.status='cancelled' and t.closed_as is not null then t.closed_as else t.status end status
    from pulse.work_merge_source s join pulse.work_merge m on m.id=s.merge_id join pulse.task t on t.id=m.target_id
    where s.source_id=$1 and m.undone_at is null order by m.created_at desc limit 1`, [m.targetId])).rows[0];
  if (later && !nodes.has(String(later.id))) {
    nodes.set(String(later.id), { key: `t:${later.id}`, id: String(later.id), title: String(later.title), status: String(later.status), role: 'later', mergeId: String(later.mergeId) });
    edges.push({ from: `t:${m.targetId}`, to: `t:${later.id}`, mergeId: String(later.mergeId) });
  }
  return { merge: m, target, sources, moved, graph: { nodes: [...nodes.values()], edges } };
}

/** For a task page: what it was merged into, and what it was made from. */
export async function mergesForTask(c: PoolClient, tid: string) {
  const into = (await c.query(`select m.id "mergeId",m.target_id "targetId",t.title,m.created_at "at",p.display_name "by"
    from pulse.work_merge_source s join pulse.work_merge m on m.id=s.merge_id left join pulse.task t on t.id=m.target_id left join pulse.person p on p.id=m.created_by
    where s.source_id=$1 and m.undone_at is null order by m.created_at desc limit 1`, [tid])).rows[0] ?? null;
  const from = (await c.query(`select m.id "mergeId",m.shape,m.created_at "at",count(s.source_id)::int count from pulse.work_merge m join pulse.work_merge_source s on s.merge_id=m.id
    where m.target_id=$1 and m.undone_at is null group by m.id order by m.created_at desc limit 5`, [tid])).rows;
  return { mergedInto: into, madeFrom: from };
}

export function registerMergeRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // Open suggestions for a person (default: the viewer), and who else the viewer may look at.
  app.get('/api/v0/merges/suggestions', req => tx(req, async (c, v) => {
    const q = req.query as { person?: string };
    if (!v.person) return { person: null, rows: [], team: [], canTeam: false };
    const who = q.person ? id(q.person) : v.person;
    if (who !== v.person && !(await inReach(c, who))) fail(403, 'Only the person, their manager, HR or leadership look at their tasks');
    const name = (await c.query('select display_name n from pulse.person where id=$1', [who])).rows[0]?.n ?? fail(404, 'Person not found');
    const team = await teamOf(c, v);
    const open = (await c.query(`select t.id,t.title,coalesce(pr.title,pr.name) "projectName",(t.due_at at time zone ${ORG_TZ})::date::text "dueOn"
      from pulse.task t left join pulse.project pr on pr.id=t.project_id where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status in ${OPEN} and t.deleted_at is null
      order by t.due_at nulls last,t.created_at desc limit 300`, [who])).rows;
    const lastScan = (await c.query('select max(created_at) at from pulse.merge_suggestion where person_id=$1', [who])).rows[0]?.at ?? null;
    return { person: { id: who, name, me: who === v.person }, rows: await suggestionsFor(c, who), open, team, canTeam: team.length > 0, lastScan };
  }));
  // Look again: one person's tasks, or (managers, HR, leadership, admins) everyone they look after.
  app.post<{ Body: Body }>('/api/v0/merges/suggestions/scan', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const b = req.body ?? {};
    if (b.team === true) return scanTeam(c, v);
    return scanPerson(c, b.person ? id(b.person) : v.person!);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/merges/suggestions/:id/reject', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return rejectSuggestion(c, id(req.params.id));
  }));
  app.post<{ Body: Body }>('/api/v0/merges', { schema: { body } }, req => tx(req, async (c, v) => mergeTasks(c, v, req.body ?? {})));
  app.get<{ Params: { id: string } }>('/api/v0/merges/task/:id', req => tx(req, async (c) => mergesForTask(c, id(req.params.id))));
  app.get<{ Params: { id: string } }>('/api/v0/merges/:id', req => tx(req, async (c, v) => mergeStory(c, v, id(req.params.id))));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/merges/:id/undo', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return undoMerge(c, id(req.params.id));
  }));
}

export type { Proposal };
