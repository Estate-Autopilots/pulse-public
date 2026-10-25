import { ORG_TZ } from './org-time.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PoolClient } from 'pg';
import { admin, fail, hr, leadership, type Tx, type Viewer } from './routes.js';
import { parseQuick, type QuickPerson } from './task-quick.js';
import { assignOrAsk, comments, createWorkTask, projectWork, taskPeople } from './work.js';
import { markDomains } from './work-domains.js';
import { cachedPlan, sameWorkFor, sameWorkPairs, unlocksFor } from './task-focus.js';
import { outcomeCharts, teamOutcomes } from './outcomes.js';
import { acceptTask, lifeFor } from './task-life.js';
import { link, unlink } from './waiting.js';

/** RT1 tasks: one model for tracker rows and new work. Who may do what is decided in the database functions
 *  (0141_task_flow.sql); these routes shape the views: My tasks, the team board, projects, blockers and outcomes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const str = (x: unknown, max = 300) => String(x ?? '').trim().slice(0, max);
/** EST-1072: a task's notes are kept whole up to 20,000 characters (counted as the database counts them); a longer
 *  note is refused in plain words, never cut. */
export const noteText = (x: unknown) => { const s = String(x ?? '').trim(); return [...s].length > 20000 ? fail(400, 'Keep notes under 20,000 characters') : s; };
const page = (q: unknown) => Math.max(0, Math.min(2000, Number((q as { page?: string }).page) || 0));
const body = { type: 'object' } as const;
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use tasks');

/** Same save/move path for screen and v1 calls; the database retains every viewer/assignment/status guard. */
export async function saveTask(c: PoolClient, tid: string | null, b: Body) {
  const fields: Body = tid === null ? { title: str(b.title) } : {};
  if ('title' in b) fields.title = str(b.title);
  if ('assigneeId' in b || 'ownerId' in b) fields.assigneeId = (b.assigneeId ?? b.ownerId) ? id(b.assigneeId ?? b.ownerId) : null;
  for (const k of ['reviewerId', 'projectId', 'parentId']) if (k in b) fields[k] = b[k] ? id(b[k]) : null;
  for (const k of ['dueOn', 'dueAt', 'dueLabel', 'priority', 'notes', 'valueNote']) if (k in b) fields[k] = b[k] === null ? null : k === 'notes' ? noteText(b[k]) : str(b[k], 4000);
  if (tid !== null) {
    if ('tags' in b) fields.tags = Array.isArray(b.tags) ? [...new Set(b.tags.map(x => str(x, 40)).filter(Boolean))].slice(0, 12) : [];
    if ('category' in b) fields.category = b.category ? str(b.category, 40) : null;
  }
  const result = tid === null || Object.keys(fields).length ? (await c.query('select pulse.task_save($1,$2) id', [tid, JSON.stringify(fields)])).rows[0] : { id: tid };
  if (tid !== null && 'status' in b) {
    const next = str(b.status) === 'in_review' ? 'done' : str(b.status);
    if (next !== 'unknown') await c.query('select pulse.task_move($1,$2,$3)', [tid, next, str(b.note, 1000) || null]);
  }
  return result;
}

/** Columns every task card needs. */
export const TASK = `t.id,t.title,t.status,t.priority,t.project_id "projectId",coalesce(pr.title,pr.name) "projectName",t.parent_id "parentId",pt.title "parentTitle",
 coalesce(t.assignee_person_id,t.owner_id) "assigneeId",a.display_name "assigneeName",(select ph.updated_at from pulse.person_photo ph where ph.person_id=a.id) "assigneePhotoAt",
 t.review_owner_id "reviewerId",rv.display_name "reviewerName",t.created_by "createdBy",
 t.due_at "dueAt",(t.due_at at time zone ${ORG_TZ})::date::text "dueOn",t.due_label "dueLabel",t.work_on::text "workOn",t.deliverable_type "type",
 t.started_at "startedAt",t.done_at "doneAt",t.accepted_at "acceptedAt",t.value_note "valueNote",
 t.source,t.source_status "sourceStatus",t.source_period "sourcePeriod",t.project_key "trackerProject",t.owner_label "trackerOwner",case when t.source='quote_followup' then t.source_ref end "sourceRef",
 t.updated_at "updatedAt",t.created_at "createdAt",pulse.task_open_blockers(t.id) "openBlockers",
 (select count(*)::int from pulse.task c where c.parent_id=t.id) subtasks,
 (select count(*)::int from pulse.task c where c.parent_id=t.id and c.status in ('done','accepted','in_review')) "subtasksDone",
 (select count(*)::int from pulse.task c where c.parent_id=t.id and c.status in ('open','in_progress','blocked','unknown')) "subtasksOpen",
 (select count(*)::int from pulse.task_proof p where p.task_id=t.id and p.removed_at is null) proof,
 t.category,t.tags,t.urgency,t.estimate_minutes "estimateMinutes",t.pool_scope "poolScope",t.pool_ref "poolRef",
 t.claimed_by "claimedBy",twp.pod "projectPod",twp.kind "projectKind",tcat.label "categoryLabel",
 (select count(*)::int from pulse.work_comment wc where wc.org_id=t.org_id and wc.task_id=t.id and wc.removed_at is null) comments,
 (select count(*)::int from pulse.task_link wl join pulse.task ww on ww.id=wl.task_id where wl.org_id=t.org_id and wl.blocker_id=t.id and wl.cleared_at is null
   and ww.status in ('open','in_progress','blocked','unknown')) waiting,t.unlocked_at "unlockedAt",
 pcat.key "projectCategory",pcat.label "projectCategoryLabel",coalesce(twp.color,pcat.color) "projectColor",coalesce(twp.icon,pcat.icon) "projectIcon",
 t.review_kind "reviewKind",t.review_quality "reviewQuality",t.review_above "reviewAbove",
 case when t.status in ('done','in_review') then pulse.task_is_leader(coalesce(t.assignee_person_id,t.owner_id)) end "leaderWork"`;
export const FROM = `pulse.task t left join pulse.person a on a.id=coalesce(t.assignee_person_id,t.owner_id)
 left join pulse.task pt on pt.id=t.parent_id and pt.org_id=t.org_id
 left join pulse.person rv on rv.id=t.review_owner_id left join pulse.project pr on pr.id=t.project_id left join pulse.work_project twp on twp.project_id=t.project_id
 left join pulse.work_category tcat on tcat.org_id=t.org_id and tcat.key=t.category
 left join pulse.project_category pcat on pcat.org_id=t.org_id and pcat.key=coalesce(twp.project_category,case twp.kind when 'internal' then 'internal' when 'fulfilment' then 'client' end)`;
const COLUMN: Record<string, string> = { open: 'todo', unknown: 'todo', in_progress: 'doing', blocked: 'blocked', done: 'done', in_review: 'done', accepted: 'accepted', cancelled: 'cancelled' };
const OPEN = `t.status in ('open','in_progress','blocked','unknown')`;
const FINISHED = `t.status in ('done','accepted','in_review')`;

async function today(c: PoolClient) { return (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d,date_trunc('week',now() at time zone ${ORG_TZ})::date::text w`)).rows[0] as { d: string; w: string }; }
/** People the viewer may give a task to: everyone for leadership, HR and admins; their own pod for a pod head; themselves. */
async function giveable(c: PoolClient) {
  return (await c.query(`select p.id,p.display_name name,pp.username,pp.pod,(select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id) "photoAt"
   from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and p.status='active' and pulse.task_can_give(p.id)
   and p.id in (select id from pulse.work_people()) order by p.display_name`)).rows as (QuickPerson & { pod: string | null; photoAt: string | null })[];
}
export async function staffList(c: PoolClient, includeAgents = false) {
  // One record per person (twin records from imports are left out), the one people sign in with.
  const people = (await c.query(`select p.id,p.display_name name,pp.username,false "isAgent" from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and p.status='active'
   and p.id in (select id from pulse.work_people()) order by p.display_name`)).rows as QuickPerson[];
  if (includeAgents) people.push(...(await c.query(`select p.id,p.display_name name,pp.username,true "isAgent" from pulse.person p join pulse.agent_member m on m.person_id=p.id
   left join pulse.people_profile pp on pp.person_id=p.id where pulse.agent_takes_tasks(p.id) order by p.display_name`)).rows);
  return people;
}
export async function projectsMatching(c: PoolClient, text: string, names?: string[]) {
  const tags = names ?? [...text.matchAll(/#([\p{L}\p{N}._&-]+)/gu)].map((m) => m[1].replace(/[-_]/g, ' '));
  if (!tags.length) return [];
  return (await c.query(`select id,coalesce(title,name) name from pulse.project where status<>'cancelled' and (${tags.map((_, i) => `regexp_replace(lower(coalesce(title,name)),'[^a-z0-9]','','g') like '%'||regexp_replace(lower($${i + 1}),'[^a-z0-9]','','g')||'%'`).join(' or ')}) order by ${names ? "(regexp_replace(lower(coalesce(title,name)),'[^a-z0-9]','','g')=regexp_replace(lower($1),'[^a-z0-9]','','g')) desc," : ''} coalesce(title,name) limit 50`, tags)).rows as { id: string; name: string }[];
}
/** Weeks in a row (this week, or up to last week while this one has nothing yet) with at least one task done. */
export function streak(weeks: string[], thisWeek: string) {
  const set = new Set(weeks); let n = 0; let w = thisWeek;
  const back = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  if (!set.has(w)) w = back(w);
  while (set.has(w)) { n++; w = back(w); }
  return n;
}
/** A stored file: never sniffed or cached. Anything but a PDF opens sandboxed; Chrome's PDF viewer draws nothing in a
 *  sandboxed document, so a PDF goes without it. */
export function sendFile(reply: FastifyReply, file: { name: string; mime: string; bytes: Buffer }, inline: boolean) {
  reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
    .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`).type(file.mime);
  if (!(inline && /^application\/pdf\s*(;|$)/i.test(file.mime))) reply.header('content-security-policy', 'sandbox');
  return reply.send(file.bytes);
}
async function blockersOf(c: PoolClient, ids: string[]) {
  if (!ids.length) return [];
  return (await c.query(`select l.task_id "taskId",l.id "linkId",l.note,l.created_at "since",b.id,b.title,b.status,coalesce(b.assignee_person_id,b.owner_id) "assigneeId",bp.display_name "assigneeName",
   pulse.task_visible(b.id) visible from pulse.task_link l join pulse.task b on b.id=l.blocker_id left join pulse.person bp on bp.id=coalesce(b.assignee_person_id,b.owner_id)
   where l.task_id=any($1) and l.cleared_at is null and b.status not in ('done','accepted','cancelled','in_review') order by l.created_at`, [ids])).rows;
}

export function registerTaskRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // The full list: search, filters and pages over every task the viewer can see (the 1,269 tracker rows included).
  app.get('/api/v0/tasks', req => tx(req, async (c, v) => {
    const q = req.query as { project?: string; person?: string; status?: string; column?: string; page?: string; q?: string; mine?: string; size?: string; task?: string; tracker?: string; type?: string };
    const size = Math.max(10, Math.min(400, Number(q.size) || 50)), needle = str(q.q, 80);
    const args: unknown[] = [q.project ? id(q.project) : null, q.person ? id(q.person) : null, v.person, needle ? `%${needle.replace(/[\\%_]/g, m => '\\' + m)}%` : null, q.mine === '1', q.task ? id(q.task) : null, q.tracker ? str(q.tracker, 120) : null, q.type ? str(q.type, 80) : null];
    const base = `($6::uuid is null or t.id=$6) and ($1::uuid is null or t.project_id=$1) and ($2::uuid is null or coalesce(t.assignee_person_id,t.owner_id)=$2)
     and ($4::text is null or t.title ilike $4 or t.owner_label ilike $4 or t.project_key ilike $4 or a.display_name ilike $4 or coalesce(pr.title,pr.name) ilike $4)
     and (not $5::boolean or $3::uuid in (t.owner_id,t.assignee_person_id)) and ($7::text is null or (t.project_id is null and lower(t.project_key)=lower($7))) and ($8::text is null or t.deliverable_type=$8)`;
    const statuses = (await c.query(`select t.status,count(*)::int n from ${FROM} where ${base} group by 1`, args)).rows;
    const column = q.column && Object.values(COLUMN).includes(q.column) ? q.column : null, status = str(q.status) || null;
    const where = `${base} and ($9::text is null or t.status=$9) and ($10::text[] is null or t.status=any($10))`;
    const cols = column ? Object.entries(COLUMN).filter(([, k]) => k === column).map(([s]) => s) : null;
    const total = (await c.query(`select count(*)::int n from ${FROM} where ${where}`, [...args, status, cols])).rows[0].n;
    const mine = v.person ? (await c.query('select count(*)::int n from pulse.task where $1 in (owner_id,assignee_person_id)', [v.person])).rows[0].n : 0;
    const rows = (await c.query(`select t.*,${TASK},a.display_name "ownerName",by.display_name "editedBy"
     from ${FROM} left join pulse.person by on by.id=t.edited_by where ${where}
     order by (t.status in ('open','in_progress','blocked','in_review','done')) desc,coalesce(t.done_at,t.due_at,t.work_on::timestamptz,t.updated_at) desc nulls last,t.title limit $11 offset $12`, [...args, status, cols, size, page(q) * size])).rows;
    const types = (await c.query(`select t.deliverable_type type,count(*)::int n from ${FROM} where ${base} and t.deliverable_type is not null group by 1 order by 2 desc limit 20`, args)).rows;
    return { rows: await markDomains(c, v.person, rows), total, page: page(q), size, statuses, types, mine, me: v.person, canEdit: !!v.person, canLead: leadership(v),
      people: admin(v) ? (await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by display_name")).rows : [],
      projects: admin(v) ? (await c.query('select id,coalesce(title,name) name from pulse.project order by title')).rows : [] };
  }));

  // My tasks: Today / This week / Blocked / Done, plus what waits on me and what I review.
  app.get('/api/v0/tasks/home', req => tx(req, async (c, v) => {
    const me = v.person; const day = await today(c);
    const canLead = leadership(v) || hr(v);
    const workRole = (await c.query('select pulse.work_role() r')).rows[0].r as string;
    if (!me) return { me: null, canLead, workRole, today: day.d, week: day.w, rows: [], blockers: [], waitingOnMe: [], review: [], summary: null };
    await c.query('select pulse.project_category_ensure()');
    const rows = (await c.query(`select ${TASK} from ${FROM} where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status<>'cancelled'
     and (${OPEN} or t.done_at>=now()-interval '120 days' or (${FINISHED} and t.done_at is null)) order by coalesce(t.due_at,t.done_at) nulls last,t.priority='urgent' desc,t.title limit 400`, [me])).rows;
    const blockers = await blockersOf(c, rows.filter((r) => r.status === 'blocked' || r.openBlockers > 0).map((r) => r.id));
    const waitingOnMe = (await c.query(`select ${TASK},l.blocker_id "blockerId",b.title "blockerTitle" from pulse.task_link l join pulse.task b on b.id=l.blocker_id join ${FROM} on t.id=l.task_id
     where l.cleared_at is null and coalesce(b.assignee_person_id,b.owner_id)=$1 and b.status not in ('done','accepted','cancelled','in_review') order by l.created_at limit 50`, [me])).rows;
    const review = (await c.query(`select ${TASK} from ${FROM} where t.review_owner_id=$1 and t.status in ('done','in_review') and coalesce(t.assignee_person_id,t.owner_id) is distinct from $1 order by t.done_at nulls last limit 50`, [me])).rows;
    const weeks = (await c.query(`select distinct date_trunc('week',done_at at time zone ${ORG_TZ})::date::text w from pulse.task where $1 in (assignee_person_id,owner_id) and done_at is not null and done_at>now()-interval '400 days'`, [me])).rows.map((r) => r.w as string);
    const week = (await c.query(`select count(*)::int done,count(*) filter(where status='accepted')::int accepted
     from pulse.task where $1 in (assignee_person_id,owner_id) and done_at>=$2::date::timestamp at time zone ${ORG_TZ}`, [me, day.w])).rows[0];
    // What shipped this week, accepted or waiting for acceptance (no value: INTEGRITY 0910).
    const shipped = (await c.query(`select ${TASK}
     from ${FROM} where coalesce(t.assignee_person_id,t.owner_id)=$1 and ${FINISHED} and t.done_at>=$2::date::timestamp at time zone ${ORG_TZ} order by t.done_at desc limit 12`, [me, day.w])).rows;
    const pending = (await c.query(`select count(*)::int n from pulse.task t
     where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status in ('done','in_review')`, [me])).rows[0];
    const time = (await c.query(`select coalesce(sum(minutes) filter(where status='confirmed'),0)::int confirmed,count(*) filter(where status='proposed')::int proposed
     from pulse.time_entry where person_id=$1 and retired_at is null and work_date>=$2::date`, [me, day.w])).rows[0];
    const mode = (await c.query('select pulse.work_mode($1) mode', [me])).rows[0].mode;
    const asks = (await c.query("select count(*)::int n from pulse.work_ask where to_id=$1 and status='pending'", [me])).rows[0].n as number;
    // UX-TASKS-2: the viewer's domains and pool tasks that fit them.
    const domains = (await c.query(`select d.id,d.title,d.basis,d.status from pulse.work_domain d where d.person_id=$1 and d.status in ('active','proposed') order by d.status='active' desc,d.basis='policy' desc,d.created_at`, [me])).rows;
    // TASKS-4B: the week per day: tasks finished (no value: INTEGRITY 0910).
    const days = (await c.query(`with d as (select generate_series($2::date,$2::date+6,interval '1 day')::date dd)
     select d.dd::text "day",
      (select count(*)::int from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status in ('done','in_review','accepted') and (t.done_at at time zone ${ORG_TZ})::date=d.dd) done
     from d order by d.dd`, [me, day.w])).rows;
    const poolRows = (await c.query(`select t.id,t.category,t.tags,t.project_id "projectId" from pulse.task t where t.pool_scope is not null and t.assignee_person_id is null and t.owner_id is null
      and t.status in ('open','unknown') and pulse.work_pool_eligible(t.pool_scope,t.pool_ref) limit 300`)).rows;
    const pool = { open: poolRows.length, fits: (await markDomains(c, me, poolRows)).filter((t) => t.inDomain).length };
    return { me, canLead, workRole, asks, today: day.d, week: day.w, rows: await markDomains(c, me, rows), blockers, waitingOnMe, review, mode, domains, pool, same: await sameWorkPairs(c, rows),
      summary: { weekDone: week.done, weekAccepted: week.accepted, streak: streak(weeks, day.w), shipped, minutes: time.confirmed, proposals: time.proposed,
        pendingTasks: pending.n, days } };
  }));

  // The team board: To do, Doing, Blocked, Done, Accepted. Drag moves a card through task_move.
  app.get('/api/v0/tasks/board', req => tx(req, async (c, v) => {
    const q = req.query as { scope?: string; project?: string; person?: string; pod?: string };
    await c.query('select pulse.project_category_ensure()');
    const me = v.person; const lead = leadership(v);
    const pods = (await c.query("select name from pulse.unit where kind='pod' and valid_to is null order by name")).rows.map((r) => r.name as string);
    const myPod = me ? (await c.query('select pod from pulse.people_profile where person_id=$1', [me])).rows[0]?.pod ?? null : null;
    const scope = ['mine', 'pod', 'all', 'person'].includes(String(q.scope)) ? String(q.scope) : me ? (myPod ? 'pod' : 'mine') : 'all';
    const pod = q.pod && pods.includes(String(q.pod)) ? String(q.pod) : myPod;
    const filter = scope === 'mine' ? `coalesce(t.assignee_person_id,t.owner_id)=$1` : scope === 'person' ? `coalesce(t.assignee_person_id,t.owner_id)=$4::uuid`
      : scope === 'pod' ? `(exists(select 1 from pulse.people_profile pp where pp.person_id=coalesce(t.assignee_person_id,t.owner_id) and pp.pod=$2) or (coalesce(t.assignee_person_id,t.owner_id) is null and exists(select 1 from pulse.people_profile pp where pp.person_id=t.created_by and pp.pod=$2)))` : 'true';
    const args = [me, pod, q.project ? id(q.project) : null, q.person ? id(q.person) : null];
    // Every parameter is typed even when this scope does not use it.
    const where = `${filter} and ($3::uuid is null or t.project_id=$3) and ($1::uuid is null or true) and ($2::text is null or true) and ($4::uuid is null or true)`;
    const active = (await c.query(`select ${TASK} from ${FROM} where ${where} and t.status in ('open','in_progress','blocked') order by t.priority='urgent' desc,t.priority='high' desc,t.due_at nulls last,t.updated_at desc nulls last limit 450`, args)).rows;
    const finished = (await c.query(`select ${TASK} from ${FROM} where ${where} and ${FINISHED} and coalesce(t.done_at,t.work_on::timestamptz)>=now()-interval '30 days' order by coalesce(t.done_at,t.work_on::timestamptz) desc limit 200`, args)).rows;
    const counts = (await c.query(`select t.status,count(*)::int n from ${FROM} where ${where} group by 1`, args)).rows;
    const columns: Record<string, unknown[]> = { todo: [], doing: [], blocked: [], done: [], accepted: [] };
    for (const t of await markDomains(c, me, [...active, ...finished])) columns[COLUMN[t.status as string]]?.push(t);
    const blockers = await blockersOf(c, active.filter((t) => t.status === 'blocked').map((t) => t.id));
    // TASKS-P0: whose work this is when it is one person's, and the cards that read as the same work.
    const whose = scope === 'person' || scope === 'mine' ? (await c.query(`select p.id,p.display_name name,pp.role,pp.pod,(select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id) "photoAt"
      from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=$1`, [scope === 'person' ? args[3] : me])).rows[0] ?? null : null;
    const same = await sameWorkPairs(c, active as { id: string; title: string; assigneeId: string | null; status: string }[]);
    return { scope, pod, pods, myPod, me, canAll: lead || hr(v), columns, counts, blockers, people: me ? await giveable(c) : [], person: whose, same, today: (await today(c)).d };
  }));

  // Projects with tasks, and tracker names that are not linked to a project yet.
  app.get('/api/v0/tasks/projects', req => tx(req, async (c, v) => {
    const rows = (await c.query(`select pr.id,coalesce(pr.title,pr.name) name,pr.status,pr.requires_proof "requiresProof",c.display_name "clientName",count(*)::int total,
     count(*) filter(where t.status in ('open','unknown'))::int todo,count(*) filter(where t.status='in_progress')::int doing,count(*) filter(where t.status='blocked')::int blocked,
     count(*) filter(where t.status in ('done','in_review'))::int done,count(*) filter(where t.status='accepted')::int accepted,max(coalesce(t.done_at,t.updated_at,t.work_on::timestamptz)) "lastAt",
     count(distinct coalesce(t.assignee_person_id,t.owner_id))::int people
     from pulse.task t join pulse.project pr on pr.id=t.project_id left join pulse.client c on c.id=pr.client_id group by pr.id,c.display_name
     order by (count(*) filter(where t.status in ('open','in_progress','blocked')))>0 desc,max(coalesce(t.done_at,t.updated_at,t.work_on::timestamptz)) desc nulls last limit 400`)).rows;
    const tracker = leadership(v) ? (await c.query(`select lower(btrim(project_key)) key,min(project_key) label,count(*)::int n from pulse.task where project_id is null and coalesce(btrim(project_key),'')<>'' group by 1 order by 3 desc,1 limit 200`)).rows : [];
    const none = (await c.query(`select count(*)::int n from pulse.task where project_id is null and coalesce(btrim(project_key),'')=''`)).rows[0].n;
    return { rows, tracker, none, canLink: leadership(v) };
  }));

  // One project: the task tree (blockers first) and the completion timeline.
  app.get<{ Params: { id: string } }>('/api/v0/tasks/projects/:id', req => tx(req, async (c, v) => {
    const pid = id(req.params.id);
    await c.query('select pulse.project_category_ensure()');
    const project = (await c.query(`select pr.id,coalesce(pr.title,pr.name) name,pr.status,pr.requires_proof "requiresProof",c.display_name "clientName",pr.registry_no "registryNo"
     from pulse.project pr left join pulse.client c on c.id=pr.client_id where pr.id=$1`, [pid])).rows[0] ?? fail(404, 'Project not found');
    const tasks = (await c.query(`select ${TASK} from ${FROM} where t.project_id=$1 order by t.title limit 1500`, [pid])).rows;
    const ids = tasks.map((t) => t.id);
    const links = ids.length ? (await c.query(`select l.task_id "taskId",l.blocker_id "blockerId",b.title "blockerTitle",b.status "blockerStatus",coalesce(b.assignee_person_id,b.owner_id) "blockerOwnerId",bp.display_name "blockerOwner",
     (b.project_id is distinct from $2) "outside",l.created_at "since" from pulse.task_link l join pulse.task b on b.id=l.blocker_id left join pulse.person bp on bp.id=coalesce(b.assignee_person_id,b.owner_id)
     where l.cleared_at is null and (l.task_id=any($1) or l.blocker_id=any($1))`, [ids, pid])).rows : [];
    const timeline = tasks.filter((t) => ['done', 'accepted', 'in_review'].includes(t.status) && (t.doneAt || t.workOn))
      .sort((x, y) => String(x.doneAt ?? x.workOn).localeCompare(String(y.doneAt ?? y.workOn)));
    const people = v.person ? await giveable(c) : [];
    return { project, tasks, links, timeline, people, canEdit: !!v.person, canProof: leadership(v), work: await projectWork(c, v, pid) };
  }));

  // What's blocking us: every open blocker, grouped by who owns the work everyone waits on.
  app.get('/api/v0/tasks/blocking', req => tx(req, async (c, v) => {
    if (!leadership(v) && !hr(v)) fail(403, 'The company-wide blocker view is for leadership');
    const links = (await c.query(`select l.id "linkId",l.created_at "since",l.note,b.id "blockerId",b.title "blockerTitle",b.status "blockerStatus",b.due_at "blockerDueAt",
     coalesce(b.assignee_person_id,b.owner_id) "ownerId",bp.display_name "ownerName",bpp.pod "ownerPod",coalesce(bpr.title,bpr.name) "blockerProject",
     (select ph.updated_at from pulse.person_photo ph where ph.person_id=bp.id) "ownerPhotoAt",
     w.id "waitingId",w.title "waitingTitle",w.priority "waitingPriority",wp.display_name "waitingOwner",wp.id "waitingOwnerId",(select ph.updated_at from pulse.person_photo ph where ph.person_id=wp.id) "waitingPhotoAt",
     coalesce(wpr.title,wpr.name) "waitingProject"
     from pulse.task_link l join pulse.task b on b.id=l.blocker_id join pulse.task w on w.id=l.task_id
     left join pulse.person bp on bp.id=coalesce(b.assignee_person_id,b.owner_id) left join pulse.people_profile bpp on bpp.person_id=bp.id left join pulse.project bpr on bpr.id=b.project_id
     left join pulse.person wp on wp.id=coalesce(w.assignee_person_id,w.owner_id) left join pulse.project wpr on wpr.id=w.project_id
     where l.cleared_at is null and b.status not in ('done','accepted','cancelled','in_review') and w.status not in ('done','accepted','cancelled') order by l.created_at`)).rows;
    const manual = (await c.query(`select ${TASK},(select e.at from pulse.task_event e where e.task_id=t.id and e.to_value='blocked' order by e.at desc limit 1) "blockedSince",
     (select e.note from pulse.task_event e where e.task_id=t.id and e.to_value='blocked' order by e.at desc limit 1) "blockedNote"
     from ${FROM} where t.status='blocked' and pulse.task_open_blockers(t.id)=0 order by t.updated_at nulls last limit 100`)).rows;
    const owners = new Map<string, { ownerId: string | null; ownerName: string; pod: string | null; photoAt: string | null; items: Map<string, { blockerId: string; title: string; status: string; project: string | null; dueAt: string | null; since: string; value: number | null; waiting: unknown[] }> }>();
    for (const l of links) {
      const key = l.ownerId ?? 'nobody';
      if (!owners.has(key)) owners.set(key, { ownerId: l.ownerId, ownerName: l.ownerName ?? 'Nobody yet', pod: l.ownerPod, photoAt: l.ownerPhotoAt, items: new Map() });
      const o = owners.get(key)!;
      if (!o.items.has(l.blockerId)) o.items.set(l.blockerId, { blockerId: l.blockerId, title: l.blockerTitle, status: l.blockerStatus, project: l.blockerProject, dueAt: l.blockerDueAt, since: l.since, value: l.blockerValue, waiting: [] });
      const item = o.items.get(l.blockerId)!; if (l.since < item.since) item.since = l.since;
      item.waiting.push({ id: l.waitingId, title: l.waitingTitle, owner: l.waitingOwner, ownerId: l.waitingOwnerId, photoAt: l.waitingPhotoAt, value: l.waitingValue, project: l.waitingProject, priority: l.waitingPriority, since: l.since, note: l.note });
    }
    const groups = [...owners.values()].map((o) => ({ ...o, items: [...o.items.values()] })).sort((x, y) => y.items.reduce((n, i) => n + i.waiting.length, 0) - x.items.reduce((n, i) => n + i.waiting.length, 0));
    return { groups, manual, waiting: new Set(links.map((l) => l.waitingId)).size + manual.length };
  }));

  // Choices for forms: who I can give tasks to, projects (most used first) and pods.
  app.get('/api/v0/tasks/options', req => tx(req, async (c, v) => ({
    me: v.person, people: v.person ? await giveable(c) : [], reviewers: v.person ? await staffList(c) : [],
    projects: (await c.query(`select pr.id,coalesce(pr.title,pr.name) name,count(t.id)::int tasks from pulse.project pr left join pulse.task t on t.project_id=pr.id
     where pr.status<>'cancelled' group by pr.id order by count(t.id) filter(where t.status in ('open','in_progress','blocked')) desc,count(t.id) desc,coalesce(pr.title,pr.name) limit 800`)).rows,
  })));

  // Quick add: parse the line (preview) or create the task.
  app.post<{ Body: Body }>('/api/v0/tasks/quick', { schema: { body } }, req => tx(req, async (c, v) => {
    const me = person(v); const text = str(req.body.text, 500); const day = await today(c);
    const people = await staffList(c); const self = people.find((p) => p.id === me) ?? null;
    const parsed = parseQuick(text, day.d, people, await projectsMatching(c, text), self);
    if (req.body.preview === true) return { parsed };
    // TASKS-3: what the line's chips settled (a person or project picked from the suggestions, tags, a priority) travels
    // beside the text and wins over what the words say.
    const b = req.body;
    const problems = parsed.problems.filter((p) => !(/@\S/.test(p) && b.assigneeId) && !(/#\S/.test(p) && b.projectId));
    if (problems.length) fail(400, problems[0]);
    const tags = Array.isArray(b.tags) ? [...new Set(b.tags.map((x) => str(x, 40)).filter(Boolean))].slice(0, 12) : [];
    // The same path as + Create, so someone outside the creator's reach is asked instead of refused.
    const made = await createWorkTask(c, v, { title: parsed.title, assigneeId: b.assigneeId ? id(b.assigneeId) : parsed.assignee?.id ?? me,
      projectId: b.projectId ? id(b.projectId) : parsed.project?.id ?? null, dueOn: parsed.dueOn, priority: typeof b.priority === 'string' ? str(b.priority, 10) : parsed.priority, tags,
      ...(b.parentId ? { parentId: id(b.parentId) } : {}) });
    return { ...made, parsed: { ...parsed, title: parsed.title } };
  }));

  app.get<{ Params: { id: string } }>('/api/v0/tasks/:id', req => tx(req, async (c, v) => {
    const tid = id(req.params.id);
    await c.query('select pulse.project_category_ensure()');
    const found = (await c.query(`select ${TASK},t.notes,t.locked,t.confidence,t.evidence->>'source' "evidenceSource",pr.requires_proof "requiresProof",
     pulse.task_can_edit(t.id) "canEdit",pulse.work_can_value(t.id) "canValue",(t.ai_suggestion-'valuePoints'-'breakdown'-'priority') suggestion,t.pooled_at "pooledAt",
     pb.display_name "pooledBy",t.claimed_at "claimedAt",case when t.pool_scope is not null then pulse.work_pool_eligible(t.pool_scope,t.pool_ref) else false end "canClaim"
     from ${FROM} left join pulse.person pb on pb.id=t.pooled_by where t.id=$1`, [tid])).rows[0] ?? fail(404, 'Task not found');
    const task = (await markDomains(c, v.person, [found]))[0];
    const parents = (await c.query(`with recursive up(id,depth) as (select parent_id,1 from pulse.task where id=$1 union all select t.parent_id,u.depth+1 from pulse.task t join up u on t.id=u.id where u.depth<20)
     select t.id,t.title,t.status from up join pulse.task t on t.id=up.id order by up.depth desc`, [tid])).rows;
    const children = (await c.query(`select ${TASK} from ${FROM} where t.parent_id=$1 order by (t.status in ('done','accepted','cancelled','in_review')),t.created_at nulls last,t.title`, [tid])).rows;
    const blockedBy = (await c.query(`select l.id "linkId",l.note,l.created_at "since",l.cleared_at "clearedAt",b.id,b.title,b.status,coalesce(b.assignee_person_id,b.owner_id) "assigneeId",bp.display_name "assigneeName",
     (select ph.updated_at from pulse.person_photo ph where ph.person_id=bp.id) "assigneePhotoAt"
     from pulse.task_link l join pulse.task b on b.id=l.blocker_id left join pulse.person bp on bp.id=coalesce(b.assignee_person_id,b.owner_id) where l.task_id=$1 and l.cleared_at is null order by l.created_at`, [tid])).rows;
    const blocks = (await c.query(`select l.id "linkId",w.id,w.title,w.status,wp.display_name "assigneeName" from pulse.task_link l join pulse.task w on w.id=l.task_id
     left join pulse.person wp on wp.id=coalesce(w.assignee_person_id,w.owner_id) where l.blocker_id=$1 and l.cleared_at is null order by l.created_at`, [tid])).rows;
    const proof = (await c.query(`select p.id,p.kind,p.label,p.url,p.added_at "addedAt",ap.display_name "addedBy" from pulse.task_proof p left join pulse.person ap on ap.id=p.added_by
     where p.task_id=$1 and p.removed_at is null order by p.added_at`, [tid])).rows;
    // READY (0960): the brief, references and screenshots that came with the task; never counted as proof.
    const attachments = (await c.query(`select a.id,a.kind,a.label,a.url,a.added_at "addedAt",ap.display_name "addedBy" from pulse.task_attachment a
     left join pulse.person ap on ap.id=a.added_by where a.task_id=$1 and a.removed_at is null order by a.added_at`, [tid])).rows;
    const time = (await c.query(`select e.id,e.person_id "personId",ep.display_name "personName",e.work_date::text "date",e.minutes,e.note,e.source,e.status from pulse.time_entry e
     left join pulse.person ep on ep.id=e.person_id where e.task_id=$1 and e.retired_at is null and e.status<>'dismissed' order by e.work_date desc,e.created_at desc limit 100`, [tid])).rows;
    // INTEGRITY (0910): the old value events and "N points" in acceptance notes stay in the record, not on screen.
    const events = (await c.query(`select e.kind,e.from_value "from",e.to_value "to",regexp_replace(e.note,' · [0-9]+ points','') note,e.at,ep.display_name "by",ep.id "byId",(select ph.updated_at from pulse.person_photo ph where ph.person_id=ep.id) "byPhotoAt"
     from pulse.task_event e left join pulse.person ep on ep.id=e.actor_id where e.task_id=$1 and e.kind<>'valued' order by e.at desc limit 200`, [tid])).rows;
    const me = v.person;
    const doer = task.assigneeId;
    const canAccept = !!me && me !== doer && ['done', 'in_review'].includes(task.status) && (await c.query(`select exists(select 1 from pulse.task_review_queue($1) q where q=$2)
      or (pulse.task_is_leader($3) and pulse.viewer_is('admin','leadership')) ok`, [me, tid, doer])).rows[0].ok as boolean;
    const { members, asks, watching } = await taskPeople(c, tid, me);
    const project = task.projectId ? (await c.query(`select wp.kind,cl.display_name "clientName",wp.summary,wp.owner_id "ownerId",wp.project_category "category",wp.color,wp.icon
     from pulse.work_project wp join pulse.project pr on pr.id=wp.project_id left join pulse.client cl on cl.id=pr.client_id where wp.project_id=$1`, [task.projectId])).rows[0] ?? null : null;
    const onIt = !!me && (me === doer || me === task.reviewerId || me === task.createdBy || members.some((m) => m.id === me && m.role === 'collaborator'));
    // TASKS-P0: the checklist ticked so far, who may open each protected document, what finishing unlocks, the same
    // work elsewhere, and Pip's kept plan.
    const checks = (await c.query(`select k.step_key "key",k.label,k.done_at "doneAt",dp.display_name "doneBy" from pulse.task_check k left join pulse.person dp on dp.id=k.done_by where k.task_id=$1`, [tid])).rows;
    const guarded = new Map((await c.query('select proof_id,readable,person_name from pulse.task_proof_protected($1)', [tid])).rows.map((r) => [r.proof_id, r]));
    const proofs = proof.map((p) => p.kind === 'document' ? { ...p, readable: !!guarded.get(p.id)?.readable, concerns: guarded.get(p.id)?.person_name ?? null } : { ...p, readable: true });
    const [unlocks, same, plan] = [await unlocksFor(c, tid), await sameWorkFor(c, { id: tid, title: task.title, assigneeId: doer }), await cachedPlan(c, v, tid)];
    // TASKS-4B: open subtasks and flags, how this task is reviewed (rated or acknowledged), the credit, who finished and
    // accepted it, how it went against the deadline and a send-back still waiting for the doer.
    const life = await lifeFor(c, v, task);
    return { task, parents, children, blockedBy, blocks, proof: proofs, attachments, time, events, me, members, asks, watching, project, comments: await comments(c, tid, null), checks, unlocks, same, plan, life,
      // "Take it" is for work nobody is doing (or a pool task the viewer may claim); a leader reassigns with Give to.
      can: { edit: task.canEdit, accept: canAccept, delete: (await c.query('select pulse.task_can_delete($1) ok', [tid])).rows[0].ok as boolean, take: !!me && !doer && (!task.poolScope || !!task.canClaim), review: !!me && (task.reviewerId === me || leadership(v)) && me !== doer,
        value: task.canValue, claim: !!me && !doer && !!task.poolScope && task.canClaim, release: !!me && doer === me && task.claimedBy === me && ['open', 'in_progress', 'blocked'].includes(String(task.status)),
        ask: !!me && task.canEdit && !['done', 'accepted', 'cancelled', 'in_review'].includes(task.status), join: !!me && !onIt && !task.canEdit } };
  }));

  // TASKS-3: delete a task made by mistake. First what is connected, then a soft delete with 30 days to restore.
  app.get<{ Params: { id: string } }>('/api/v0/tasks/:id/delete-preview', req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.task_delete_preview($1) r', [id(req.params.id)])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/delete', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.task_delete($1,$2) r', [id(req.params.id), str(req.body.note, 500) || null])).rows[0].r;
  }));
  app.post<{ Params: { id: string } }>('/api/v0/tasks/:id/restore', req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.task_restore($1) r', [id(req.params.id)])).rows[0].r;
  }));
  app.get('/api/v0/tasks/deleted', req => tx(req, async (c, v) => {
    person(v);
    return { rows: (await c.query(`select id,title,deleted_at "deletedAt",deleted_by "deletedById",deleted_by_name "deletedBy",note,project_name "projectName",subtasks,restore_until "restoreUntil" from pulse.task_deleted_list()`)).rows };
  }));

  app.get<{ Params: { id: string } }>('/api/v0/tasks/attachments/:id', async (req, reply) => {
    const file = await tx(req, async (c) => (await c.query('select * from pulse.task_attachment_read($1)', [id(req.params.id)])).rows[0]);
    if (!file) fail(404, 'File unavailable');
    return sendFile(reply, file, /^(application\/pdf|image\/)/.test(file.mime));
  });
  app.get<{ Params: { id: string } }>('/api/v0/tasks/proof/:id', async (req, reply) => {
    const file = await tx(req, async (c) => (await c.query('select * from pulse.task_proof_read($1)', [id(req.params.id)])).rows[0]);
    if (!file) fail(404, 'File unavailable');
    return sendFile(reply, file, /^(application\/pdf|image\/)/.test(file.mime));
  });

  // Create. Accepts the older admin form (ownerId, dueLabel) as well as the RT1 fields.
  app.post<{ Body: Body }>('/api/v0/tasks', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return saveTask(c, null, req.body);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); await saveTask(c, id(req.params.id), req.body);
    return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/move', { schema: { body } }, req => tx(req, async (c, v) => {
    const me = person(v); const tid = id(req.params.id);
    const result = (await c.query('select pulse.task_move($1,$2,$3) r', [tid, str(req.body.status), str(req.body.note, 1000) || null])).rows[0].r;
    if (result.status !== 'done') return result;
    // A quiet celebration: how many you finished this week, and the streak it keeps.
    const day = await today(c);
    const weeks = (await c.query(`select distinct date_trunc('week',done_at at time zone ${ORG_TZ})::date::text w from pulse.task where $1 in (assignee_person_id,owner_id) and done_at is not null and done_at>now()-interval '400 days'`, [me])).rows.map((r) => r.w as string);
    const weekDone = (await c.query(`select count(*)::int n from pulse.task where $1 in (assignee_person_id,owner_id) and done_at>=$2::date::timestamp at time zone ${ORG_TZ}`, [me, day.w])).rows[0].n;
    return { ...result, weekDone, streak: streak(weeks, day.w) };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/tasks/:id/take', req => tx(req, async (c, v) => {
    const me = person(v); const tid = id(req.params.id);
    // A task in the pool is claimed (the first claim wins); any other task is taken as before.
    const pooled = (await c.query('select pool_scope is not null and assignee_person_id is null and owner_id is null p from pulse.task where id=$1', [tid])).rows[0]?.p;
    if (pooled) return { ok: true, ...(await c.query('select pulse.work_pool_claim($1) r', [tid])).rows[0].r };
    await c.query('select pulse.task_save($1,$2)', [tid, JSON.stringify({ assigneeId: me })]); return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/give', { schema: { body } }, req => tx(req, async (c, v) => {
    // Given at once when the rules allow it; otherwise the person is asked to take it (TASKS-3).
    return { ok: true, ...(await assignOrAsk(c, v, id(req.params.id), req.body.personId ? id(req.body.personId) : null, str(req.body.note, 500) || null)) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/accept', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const tid = id(req.params.id);
    // INTEGRITY (0910): value points sent with an acceptance (older clients) are ignored; accepting credits nothing.
    // TASKS-4B: one quality rating (or acknowledging leadership's work).
    // PROMOTE-4B: the older {effort, impact} body works for old clients only; no Pulse screen sends it. Every use is
    // logged, so whoever still sends it can be found before the form is retired.
    if (req.body.effort !== undefined || req.body.impact !== undefined)
      req.log.warn({ task: tid, person: v.person, quality: req.body.quality ?? null, client: String(req.headers['user-agent'] ?? '').slice(0, 160) }, 'legacy effort/impact accept (compatibility only)');
    const { points: _p, ...r } = await acceptTask(c, tid, req.body); void _p;
    return { ...r, credit: null };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/return', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); await c.query('select pulse.task_return($1,$2)', [id(req.params.id), str(req.body.note, 1000)]); return { ok: true };
  }));
  // Waits on an existing task, or on a new one created for someone ("waiting on Kazuk to share the statement").
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/block', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const tid = id(req.params.id); let blocker = req.body.blockerId ? id(req.body.blockerId) : null;
    if (!blocker) {
      const title = str(req.body.title); if (!title) fail(400, 'Choose the task this waits on, or describe it');
      const parent = (await c.query('select project_id from pulse.task where id=$1', [tid])).rows[0] ?? fail(404, 'Task not found');
      blocker = (await c.query('select pulse.task_save(null,$1) id', [JSON.stringify({ title, assigneeId: req.body.assigneeId ? id(req.body.assigneeId) : null, projectId: parent.project_id })])).rows[0].id;
    }
    return link(c, tid, blocker!, str(req.body.note, 300) || null);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/unblock', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return unlink(c, id(req.params.id), req.body.blockerId ? id(req.body.blockerId) : null);
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/proof', { schema: { body }, bodyLimit: 7200000 }, req => tx(req, async (c, v) => {
    person(v); const b = req.body; const tid = id(req.params.id);
    if (b.bytes !== undefined) {
      const data = String(b.bytes ?? ''); if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > 7000000) fail(400, 'Attach a file up to 5 MB, or link a Drive file');
      const name = str(b.name, 200).replace(/[\x00-\x1f/\\]/g, '_'), mime = str(b.mime, 100).toLowerCase();
      return { id: (await c.query('select pulse.task_proof_add($1,$2,null,$3,$4,$5) id', [tid, str(b.label, 200) || name, Buffer.from(data, 'base64'), name, mime])).rows[0].id };
    }
    return { id: (await c.query('select pulse.task_proof_add($1,$2,$3) id', [tid, str(b.label, 200), str(b.url, 2000)])).rows[0].id };
  }));
  // READY (Datup, 21 Oct): attach the brief while creating a task (and later): a file up to 5 MB or a link. Not proof.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/attachments', { schema: { body }, bodyLimit: 7200000 }, req => tx(req, async (c, v) => {
    person(v); const b = req.body; const tid = id(req.params.id);
    if (b.bytes !== undefined) {
      const data = String(b.bytes ?? ''); if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length > 7000000) fail(400, 'Attach a file up to 5 MB, or link a Drive file');
      const name = str(b.name, 200).replace(/[\x00-\x1f/\\]/g, '_'), mime = str(b.mime, 100).toLowerCase();
      return { id: (await c.query('select pulse.task_attachment_add($1,$2,null,$3,$4,$5) id', [tid, str(b.label, 200) || name, Buffer.from(data, 'base64'), name, mime])).rows[0].id };
    }
    return { id: (await c.query('select pulse.task_attachment_add($1,$2,$3) id', [tid, str(b.label, 200), str(b.url, 2000)])).rows[0].id };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/tasks/attachments/:id/remove', req => tx(req, async (c, v) => {
    person(v); await c.query('select pulse.task_attachment_remove($1)', [id(req.params.id)]); return { ok: true };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/tasks/proof/:id/remove', req => tx(req, async (c, v) => {
    person(v); await c.query('select pulse.task_proof_remove($1)', [id(req.params.id)]); return { ok: true };
  }));
  app.post<{ Body: Body }>('/api/v0/tasks/link-tracker', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!leadership(v)) fail(403, 'Leadership links tracker names to projects');
    return { linked: (await c.query('select pulse.task_link_tracker_project($1,$2) n', [str(req.body.key, 120), id(req.body.projectId)])).rows[0].n };
  }));

  // Time from work: typed in, or proposed from evidence and confirmed by the person.
  app.get('/api/v0/time', req => tx(req, async (c, v) => {
    const me = person(v); const q = req.query as { from?: string };
    const day = await today(c); const from = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from)) ? String(q.from) : day.w;
    const rows = (await c.query(`select e.id,e.work_date::text "date",e.minutes,e.note,e.source,e.status,e.task_id "taskId",t.title "taskTitle",e.project_id "projectId",coalesce(pr.title,pr.name) "projectName",e.evidence
     from pulse.time_entry e left join pulse.task t on t.id=e.task_id left join pulse.project pr on pr.id=e.project_id
     where e.person_id=$1 and e.retired_at is null and e.status<>'dismissed' and (e.status='proposed' or e.work_date>=$2::date) order by e.status='proposed' desc,e.work_date desc,e.created_at desc limit 300`, [me, from])).rows;
    return { from, today: day.d, rows };
  }));
  app.post<{ Body: Body }>('/api/v0/time', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const b = req.body;
    return { id: (await c.query('select pulse.time_log($1) id', [JSON.stringify({ taskId: b.taskId ? id(b.taskId) : null, projectId: b.projectId ? id(b.projectId) : null, date: str(b.date, 10), minutes: Number(b.minutes), note: str(b.note, 500) })])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/time/:id', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const minutes = req.body.minutes === undefined || req.body.minutes === null || req.body.minutes === '' ? null : Number(req.body.minutes);
    await c.query('select pulse.time_decide($1,$2,$3)', [id(req.params.id), str(req.body.decision, 20), minutes]); return { ok: true };
  }));
  app.post<{ Body: Body }>('/api/v0/time/confirm-all', { schema: { body } }, req => tx(req, async (c, v) => {
    const me = person(v); const ids = (await c.query("select id from pulse.time_entry where person_id=$1 and status='proposed' and retired_at is null", [me])).rows.map((r) => r.id);
    for (const e of ids) await c.query("select pulse.time_decide($1,'confirm',null)", [e]);
    return { confirmed: ids.length };
  }));

  // Outcome dashboard: tasks, hours by project, value shipped, KPI progress and a weekly summary.
  app.get('/api/v0/outcomes', req => tx(req, async (c, v) => {
    const q = req.query as { person?: string }; const who = q.person ? id(q.person) : person(v);
    if (who !== v.person && !(leadership(v) || hr(v) || (await c.query('select pulse.manages($1) ok', [who])).rows[0].ok)) fail(403, 'Outcome dashboards are for the person, their pod head, HR and leadership');
    const day = await today(c);
    const profile = (await c.query(`select p.id,p.display_name name,pp.role,pp.pod,(select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id) "photoAt",pulse.work_mode(p.id) "workMode",
     w.role_title "roleTitle",w.role_status "roleStatus",w.weekly_hours_min "hoursMin",w.weekly_hours_max "hoursMax",w.office_days_min "officeMin",w.office_days_max "officeMax",w.other_roles "otherRoles",w.note
     from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id left join pulse.person_work_terms w on w.person_id=p.id where p.id=$1`, [who])).rows[0] ?? fail(404, 'Person not found');
    const weeks = (await c.query(`with w as (select generate_series($2::date-interval '7 weeks',$2::date,interval '1 week')::date wk)
     select w.wk::text week,coalesce((select sum(minutes) from pulse.time_entry e where e.person_id=$1 and e.status='confirmed' and e.retired_at is null and e.work_date>=w.wk and e.work_date<w.wk+7),0)::int minutes,
     coalesce((select sum(minutes) from pulse.time_entry e where e.person_id=$1 and e.status='proposed' and e.retired_at is null and e.work_date>=w.wk and e.work_date<w.wk+7),0)::int proposed,
     (select count(*)::int from pulse.task t where $1 in (t.assignee_person_id,t.owner_id) and t.done_at>=w.wk::timestamp at time zone ${ORG_TZ} and t.done_at<(w.wk+7)::timestamp at time zone ${ORG_TZ}) done
     from w order by w.wk`, [who, day.w])).rows;
    const byProject = (await c.query(`select e.project_id "projectId",coalesce(pr.title,pr.name,'No project') name,sum(e.minutes) filter(where e.status='confirmed')::int minutes,sum(e.minutes) filter(where e.status='proposed')::int proposed
     from pulse.time_entry e left join pulse.project pr on pr.id=e.project_id where e.person_id=$1 and e.retired_at is null and e.status<>'dismissed' and e.work_date>=$2::date-interval '7 weeks'
     group by 1,2 order by coalesce(sum(e.minutes) filter(where e.status='confirmed'),0)+coalesce(sum(e.minutes) filter(where e.status='proposed'),0) desc`, [who, day.w])).rows;
    const value = (await c.query(`select ${TASK} from ${FROM} where coalesce(t.assignee_person_id,t.owner_id)=$1 and ${FINISHED} and (t.value_note is not null or t.status='accepted') order by t.done_at desc nulls last limit 40`, [who])).rows;
    const open = (await c.query(`select ${TASK} from ${FROM} where coalesce(t.assignee_person_id,t.owner_id)=$1 and ${OPEN} order by t.status='blocked' desc,t.due_at nulls last,t.title limit 60`, [who])).rows;
    const done = (await c.query(`select count(*)::int n,count(*) filter(where t.status='accepted')::int accepted from pulse.task t where $1 in (t.assignee_person_id,t.owner_id) and ${FINISHED}`, [who])).rows[0];
    const kpis = (await c.query(`select k.id,k.area,k.title,k.target,k.measure,k.due_on::text "dueOn",k.progress,k.status,k.latest_note "note",k.source,k.updated_at "updatedAt",up.display_name "updatedBy"
     from pulse.kpi k left join pulse.person up on up.id=k.updated_by where k.person_id=$1 order by k.position,k.title`, [who])).rows;
    const proposals = (await c.query(`select count(*)::int n,coalesce(sum(minutes),0)::int minutes from pulse.time_entry where person_id=$1 and status='proposed' and retired_at is null`, [who])).rows[0];
    // UX-TASKS-2: the person's domains (no value credited: INTEGRITY 0910).
    const domains = (await c.query(`select id,title,basis,status,agreed_on::text "agreedOn",effective_from::text "effectiveFrom" from pulse.work_domain where person_id=$1 and status in ('active','proposed')
     order by status='active' desc,basis='policy' desc,created_at`, [who])).rows;
    // TASKS-4B: the person's record, kindly: signals (finished, on time, sent back, open subtasks, quality; outcomes for
    // leadership) and help given (totals only).
    const signals = (await c.query('select pulse.person_task_signals($1,90) s,pulse.help_totals($1,90) h', [who])).rows[0];
    return { today: day.d, week: day.w, self: who === v.person, profile, weeks,
      byProject, value, open, done, kpis, proposals, domains, charts: await outcomeCharts(c, who, day.w, day.d), signals: signals.s, help: signals.h };
  }));
  // TASKS-3: the leader's summary: everyone in view (leadership and HR: everyone; heads and managers: their people).
  app.get('/api/v0/outcomes/team', req => tx(req, async (c, v) => {
    const me = person(v); const day = await today(c); const all = leadership(v) || hr(v);
    const people = (await c.query(`select p.id,p.display_name name,pp.pod,pp.role,pp.department,(select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id) "photoAt"
     from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id in (select id from pulse.work_people()) and p.id<>$2 and ($1 or pulse.manages(p.id))
     order by pp.pod nulls last,p.display_name`, [all, me])).rows;
    const rows = await teamOutcomes(c, people.map((p) => p.id), day.w);
    // TASKS-4B: who helps how much (totals by name, never ranked).
    const help = new Map((await c.query('select person_id,answered,helpful,somewhat,not_helpful "notHelpful" from pulse.help_team(90)')).rows.map((h) => [h.person_id as string, h]));
    return { week: day.w, people: people.map((p) => ({ ...p, ...rows.find((r) => r.id === p.id), help: help.get(p.id) ?? null })) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/kpis/:id', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const b = req.body; const progress = b.progress === undefined || b.progress === null || b.progress === '' ? null : Number(b.progress);
    await c.query('select pulse.kpi_progress($1,$2,$3,$4)', [id(req.params.id), progress, str(b.status, 20), str(b.note, 1000) || null]); return { ok: true };
  }));
  // Work mode and role terms: admins and HR only (checked again in the database).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/people/:id/work-terms', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!admin(v) && v.role !== 'hr') fail(403, 'Only admins and HR set work mode');
    const b = req.body; const fields: Body = {};
    for (const k of ['workMode', 'roleTitle', 'roleStatus', 'weeklyHoursMin', 'weeklyHoursMax', 'officeDaysMin', 'officeDaysMax', 'note']) if (k in b) fields[k] = b[k] === null ? null : str(b[k], 1000);
    if ('otherRoles' in b) fields.otherRoles = Array.isArray(b.otherRoles) ? b.otherRoles.map((x) => str(x, 160)) : String(b.otherRoles ?? '').split(/\n|;/).map((x) => x.trim()).filter(Boolean);
    await c.query('select pulse.work_terms_set($1,$2)', [id(req.params.id), JSON.stringify(fields)]); return { ok: true };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/people/:id/files', req => tx(req, async (c) => ({ rows: (await c.query('select pulse.hr_file_list($1) r', [id(req.params.id)])).rows[0].r })));
  app.get<{ Params: { id: string } }>('/api/v0/people/files/:id', async (req, reply) => {
    const file = await tx(req, async (c) => (await c.query('select * from pulse.hr_file_read($1)', [id(req.params.id)])).rows[0]);
    if (!file) fail(404, 'Document unavailable');
    return sendFile(reply, file, true);
  });
  // HR → Pod heads: every pod card saved at once, accepted suggestions closed with it.
  app.post<{ Body: Body }>('/api/v0/hr/pods', { schema: { body } }, req => tx(req, async (c, v) => {
    if (!hr(v) || !v.person) fail(403, 'HR access required');
    const pods = Array.isArray(req.body.pods) ? req.body.pods.map((p: Body) => ({ name: str(p.name, 80), headId: p.headId ? id(p.headId) : null, members: Array.isArray(p.members) ? [...new Set(p.members.map(id))] : [] })) : fail(400, 'Choose pods');
    const accepted = Array.isArray(req.body.accepted) ? req.body.accepted.map(id) : [];
    return { saved: (await c.query('select pulse.hr_pods_save($1) n', [JSON.stringify({ pods, accepted })])).rows[0].n };
  }));
}
