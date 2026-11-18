// PEOPLE-LIVE: a person's projects, tasks, deliveries and documents from evidence links (migration 0142), with what is
// still unknown and how to fix it. Row-level security shows links to the person, their manager or pod lead,
// leadership and HR. Work shows tasks and hours, never pay. Decisions go through pulse.people_work_decide*.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, hr, type Tx, type Viewer } from './routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Row = Record<string, unknown>;
const LINK = `l.id "linkId",l.status,l.auto_accepted "auto",l.confidence::float confidence,l.basis,l.source,l.group_key "groupKey",l.group_label "groupLabel",
 l.decided_at "decidedAt",(select r.id from pulse.people_work_receipt r where r.link_id=l.id order by r.at desc limit 1) "receiptId"`;
const live = `l.retired_at is null and l.status in ('accepted','suggested')`;
const month = (d: unknown) => d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 7) : null;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** A tracker tab's month ("VOV Mar 2026", "sept 2026", "Ridihu (March)") when a task row has no date of its own. */
export function tabMonth(label: unknown, year = new Date().getUTCFullYear()): string | null {
  const words = String(label ?? '').toLowerCase().match(/[a-z]+|\d{2,4}/g) ?? [];
  const m = words.findIndex(w => MONTHS.includes(w.slice(0, 3)) && /^[a-z]+$/.test(w)); if (m < 0) return null;
  const y = words.map(w => /^\d{4}$/.test(w) ? Number(w) : /^\d{2}$/.test(w) && Number(w) >= 20 && Number(w) <= 39 ? 2000 + Number(w) : null).find(Boolean) ?? year;
  return `${y}-${String(MONTHS.indexOf(words[m].slice(0, 3)) + 1).padStart(2, '0')}`;
}
const taskMonth = (t: Row) => month(t.day) ?? tabMonth(t.period);

/** What a person works on: links and the existing task, project and delivery rows, for the person page. */
export async function personWork(c: PoolClient, v: Viewer, person: string) {
  const who = (await c.query(`select p.id,p.display_name name,pp.pod,pp.role,pulse.person_work_access(p.id) or pulse.viewer_is('hr') visible,
   (select work_mode from pulse.person_work_terms t where t.person_id=p.id) "workMode",(select count(*)::int from pulse.account a where a.holder_person_id=p.id and not a.is_shared) accounts
   from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=$1 and p.side='staff'`, [person])).rows[0];
  if (!who) fail(404, 'Person not found');
  const can = { view: !!who.visible, review: hr(v) && !!v.person };
  if (!can.view) return { can, person: { id: who.id, name: who.name } };
  // Tasks: the ones the person owns (as RT1 shows them) and suggested ones whose owner is still open. Titles only.
  const tasks = (await c.query(`select * from (
    select t.id,t.title,t.status,t.project_id "projectId",coalesce(pr.title,pr.name) "projectName",cl.display_name "clientName",
     coalesce(t.work_on,t.done_at::date,t.assigned_at::date,t.created_at::date)::text "day",t.source_period "period",coalesce(t.owner_role,t.role_key) role,
     (select round(sum(e.minutes)/60.0,1)::float from pulse.time_entry e where e.task_id=t.id and e.person_id=$1 and e.status='confirmed' and e.retired_at is null) hours,
     coalesce((select jsonb_build_object('linkId',l.id,'status',l.status,'auto',l.auto_accepted,'confidence',l.confidence,'basis',l.basis,'groupKey',l.group_key,
       'receiptId',(select r.id from pulse.people_work_receipt r where r.link_id=l.id order by r.at desc limit 1)) from pulse.people_work_link l
       where l.task_id=t.id and l.person_id=$1 and l.status='accepted' order by l.decided_at desc limit 1),'{"status":"owned"}'::jsonb) link
    from pulse.task t left join pulse.project pr on pr.id=t.project_id left join pulse.client cl on cl.id=pr.client_id
    where (t.owner_id=$1 or t.assignee_person_id=$1) and t.parent_id is null and t.status<>'cancelled'
    union all
    select t.id,l.title,t.status,l.project_id,coalesce(pr.title,pr.name),cl.display_name,coalesce(l.period_from,t.work_on)::text,t.source_period,l.role,null::float,
     jsonb_build_object('linkId',l.id,'status',l.status,'auto',false,'confidence',l.confidence,'basis',l.basis,'groupKey',l.group_key)
    from pulse.people_work_link l left join pulse.task t on t.id=l.task_id left join pulse.project pr on pr.id=l.project_id left join pulse.client cl on cl.id=pr.client_id
    where l.person_id=$1 and l.kind='task' and l.status='suggested' and l.retired_at is null
   ) x order by "day" desc nulls last,title limit 500`, [person])).rows;
  // Projects: links (with role and period), the person's own tasks, and deliveries credited to them.
  const projects = (await c.query(`with ev as (
    select l.project_id,l.status='accepted' sure,l.confidence,l.role,l.period_from f,l.period_to t,l.basis,l.id link,l.status,l.group_key,l.auto_accepted auto from pulse.people_work_link l
     where l.person_id=$1 and l.kind='project' and ${live}
    union all select t.project_id,true,1,coalesce(t.owner_role,'Task owner'),coalesce(t.work_on,t.done_at::date,t.assigned_at::date),coalesce(t.work_on,t.done_at::date,t.assigned_at::date),'Owns tasks on this project',null,'owned',null,false
     from pulse.task t where (t.owner_id=$1 or t.assignee_person_id=$1) and t.project_id is not null and t.status<>'cancelled'
    union all select d.project_id,true,1,'Credited deliveries',d.delivered_at::date,d.delivered_at::date,'Deliveries credited to this person',null,'credited',null,false
     from pulse.delivery d where pulse.delivery_matches(d.file_id,$2))
   select pr.id "projectId",coalesce(pr.title,pr.name) title,pr.status "projectStatus",cl.display_name "clientName",u.name pod,
    bool_or(ev.sure) accepted,(bool_or(ev.sure) and pr.status in ('active','onboarding') and max(ev.t)>=current_date-90) active,max(ev.confidence)::float confidence,array_remove(array_agg(distinct lower(ev.role)),null) roles,min(ev.f)::text "from",max(ev.t)::text "to",
    (select count(*)::int from pulse.task t where t.project_id=pr.id and (t.owner_id=$1 or t.assignee_person_id=$1)) tasks,
    (select count(*)::int from pulse.delivery d where d.project_id=pr.id and pulse.delivery_matches(d.file_id,$2)) deliveries,
    jsonb_agg(distinct jsonb_build_object('basis',ev.basis,'status',ev.status,'linkId',ev.link,'groupKey',ev.group_key,'auto',ev.auto)) evidence
   from ev join pulse.project pr on pr.id=ev.project_id left join pulse.client cl on cl.id=pr.client_id left join pulse.unit u on u.id=pr.unit_id
   group by pr.id,cl.display_name,u.name order by bool_or(ev.sure) desc,max(ev.t) desc nulls last,title limit 300`, [person, `person:${person}`])).rows;
  const deliveries = (await c.query(`select l.file_id "fileId",coalesce(f.display_name,f.name,l.title) "fileName",d.kind,d.delivered_at "deliveredAt",
   l.project_id "projectId",coalesce(pr.title,pr.name) "projectName",d.uploader_account "uploaderAccount",${LINK}
   from pulse.people_work_link l left join pulse.delivery d on d.file_id=l.file_id left join pulse.index_file f on f.file_id=l.file_id left join pulse.project pr on pr.id=l.project_id
   where l.person_id=$1 and l.kind='delivery' and ${live} order by (l.status='accepted') desc,d.delivered_at desc nulls last limit 300`, [person])).rows;
  const documents = (await c.query(`select l.file_id "fileId",l.title,l.role,l.period_to::text "modifiedOn",l.evidence->>'mime' mime,l.project_id "projectId",
   coalesce(pr.title,pr.name) "projectName",${LINK} from pulse.people_work_link l left join pulse.project pr on pr.id=l.project_id
   where l.person_id=$1 and l.kind='document' and ${live} order by (l.status='accepted') desc,l.period_to desc nulls last,l.title limit 400`, [person])).rows;
  const pods = (await c.query(`select l.pod,${LINK} from pulse.people_work_link l where l.person_id=$1 and l.kind='pod' and ${live} order by l.decided_at desc nulls last`, [person])).rows;
  const credited = (await c.query(`select date_trunc('month',d.delivered_at)::date::text m,count(*)::int n from pulse.delivery d
   where pulse.delivery_matches(d.file_id,$1) and d.delivered_at>=date_trunc('month',now())-interval '5 months' group by 1`, [`person:${person}`])).rows;
  const summary = summarise(tasks, projects, deliveries, credited);
  const first = String(who.name).split(/\s+/)[0];
  const outcome = who.workMode === 'outcome' || who.pod === 'Leadership';
  const missing: Record<string, string> = {};
  if (!tasks.length) missing.tasks = `No tracker row or Pulse task names ${first} yet. Fix: create ${first}'s tasks in Tasks, or write ${first}'s name in the assignee column of their tracker sheet; the next import (every six hours) picks it up.`;
  if (!projects.length) missing.projects = `No source ties ${first} to a project yet: no task, PM column, client sheet or upload names them. Fix: give ${first} a task on the project, or name them as the assigned PM in the tracker.`;
  if (!deliveries.length && !summary.creditedDeliveries) missing.deliveries = who.accounts ? `Nothing ${first} uploaded is in a delivery folder yet, and no shared-login upload matches ${first}'s tasks.`
    : `Deliveries arrive through shared logins, so none is credited to ${first}. Fix: link ${first}'s own Google account under Overview → Accounts, or accept suggested deliveries in Review data.`;
  if (!documents.length) missing.documents = `No Drive file is owned or last edited by an account known to be ${first}'s. Fix: link ${first}'s Google account under Overview → Accounts.`;
  if (!who.pod && !pods.length) missing.pod = `No Workspace pod group names ${first}. Fix: add ${first} to pod1@ or pod2@ (creative@ or production@ for work across pods), or set the pod with Edit.`;
  return { can, person: { id: who.id, name: who.name, pod: who.pod, role: who.role, outcome }, summary, tasks, projects, deliveries, documents, pods, missing,
    counts: { tasks: tasks.length, projects: projects.length, deliveries: deliveries.length + summary.creditedDeliveries, documents: documents.length,
      suggested: [...tasks.map(t => (t.link as Row)?.status), ...deliveries.map(d => d.status), ...documents.map(d => d.status), ...projects.map(p => p.accepted ? 'accepted' : 'suggested')].filter(s => s === 'suggested').length } };
}

/** Overview: what they work on, the six-month output trend and the main clients. Suggested work is counted apart. */
export function summarise(tasks: Row[], projects: Row[], deliveries: Row[], credited: { m: string; n: number }[]) {
  const sure = (t: Row) => (t.link as Row)?.status !== 'suggested';
  const kinds = new Map<string, number>(); const counted = tasks.some(sure) ? tasks.filter(sure) : tasks;
  for (const t of counted) { const k = String(t.title ?? '').split(' — ')[0].trim() || String(t.role ?? ''); if (k && k.length <= 40) kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  const clients = new Map<string, number>();
  for (const p of projects) { const k = String(p.clientName ?? p.title ?? ''); if (k) clients.set(k, (clients.get(k) ?? 0) + (p.accepted ? 1000 : 0) + Math.max(1, Number(p.tasks) || 0)); }   // confirmed work first
  const now = new Date(); const months = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + i, 1)).toISOString().slice(0, 7));
  const trend = months.map(m => ({ month: m,
    tasks: tasks.filter(t => sure(t) && taskMonth(t) === m && ['done', 'accepted', 'in_review'].includes(String(t.status))).length,
    suggested: tasks.filter(t => !sure(t) && taskMonth(t) === m).length,
    deliveries: (credited.find(x => x.m.slice(0, 7) === m)?.n ?? 0) + deliveries.filter(d => d.status === 'accepted' && month(d.deliveredAt) === m).length }));
  return { workingOnSuggested: !tasks.some(sure) && tasks.length > 0, workingOn: [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => ({ kind: k, tasks: n })),
    clients: [...clients.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name]) => name),
    activeProjects: projects.filter(p => p.active).length,
    trend, creditedDeliveries: credited.reduce((n, x) => n + x.n, 0) };
}

export function registerPeopleWork(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get<{ Params: { id: string } }>('/api/v0/people/:id/work', req => tx(req, async (c, v) => {
    if (!UUID.test(req.params.id)) fail(404, 'Person not found');
    return personWork(c, v, req.params.id);
  }));
  // Accept, dismiss or undo links (up to 600), or accept/dismiss a whole review group in one click. Each writes receipts.
  // Who may decide is checked first (the database checks again); then the request.
  app.post<{ Body: Row }>('/api/v0/people/work/decide', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    if (!hr(v) || !v.person) fail(403, 'HR or leadership decides work suggestions');
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(String) : [];
    if (!ids.length || ids.length > 600 || ids.some(x => !UUID.test(x)) || !['accept', 'dismiss', 'undo'].includes(String(req.body.action))) fail(400, 'Choose up to 600 suggestions and accept, dismiss or undo');
    return (await c.query('select pulse.people_work_decide($1::uuid[],$2) result', [ids, req.body.action])).rows[0].result;
  }));
  app.post<{ Body: Row }>('/api/v0/people/work/group', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    if (!hr(v) || !v.person) fail(403, 'HR or leadership decides work suggestions');
    const group = String(req.body.group ?? ''), person = req.body.personId ? String(req.body.personId) : null;
    if (group.length < 3 || group.length > 200 || (person && !UUID.test(person)) || !['accept', 'dismiss'].includes(String(req.body.action))) fail(400, 'Choose a review group and accept or dismiss');
    return (await c.query('select pulse.people_work_decide_group($1,$2,$3) result', [group, person, req.body.action])).rows[0].result;
  }));
}
