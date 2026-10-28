import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, hr, leadership, type Tx, type Viewer } from './routes.js';
import { FROM, noteText, TASK } from './tasks.js';
import { categories, domainNotice, packageLinks, suggestFor, workSettings } from './work-domains.js';
import { doneNotice, waited } from './task-life.js';
import { connectedContacts } from './connect-contacts.js';

/** UX-TASKS: clients are a separate world. Client projects (the packages sold) live under Clients; their fulfilment
 *  projects and the company's internal projects live under Work with one task model. Who may do what is decided in
 *  the database (0144_work_structure.sql): these routes shape the Create dialog, projects, asks, comments, the rule
 *  matrix, the migration review and the management dashboard. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const optId = (x: unknown) => x === undefined || x === null || x === '' ? null : id(x);
const str = (x: unknown, max = 300) => String(x ?? '').trim().slice(0, max);
const day = (x: unknown) => x === undefined || x === null || x === '' ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(x)) ? String(x) : fail(400, 'Choose a valid date');
const ids = (x: unknown) => Array.isArray(x) ? [...new Set(x.map(id))] : [];
const body = { type: 'object' } as const;
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use Work');
const PHOTO = (alias: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${alias}.id)`;
export const ROLE_LABEL: Record<string, string> = { leadership: 'Leadership and admins', hr: 'HR', pod_head: 'Pod heads', member: 'Members' };
const OPEN = `t.status in ('open','in_progress','blocked')`;
const FINISHED = `t.status in ('done','accepted','in_review')`;
const DUE = `(t.due_at at time zone ${ORG_TZ})::date`;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Fri 16 Oct", with the year when it is not this year's. */
export function dayLabel(d: unknown, today: string) {
  const x = new Date(`${String(d).slice(0, 10)}T00:00:00Z`); if (Number.isNaN(x.getTime())) return String(d ?? '');
  return `${DAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}${String(d).slice(0, 4) !== today.slice(0, 4) ? ` ${String(d).slice(0, 4)}` : ''}`;
}
async function today(c: PoolClient) {
  return (await c.query(`select (now() at time zone ${ORG_TZ})::date::text d,date_trunc('week',now() at time zone ${ORG_TZ})::date::text w`)).rows[0] as { d: string; w: string };
}

/** A request someone can act on, in the shape the notification panel renders: what, from whom, and the buttons. */
/** Fields: `text`, `choice` (one of `options`, shown with the shared Rating) and `flag` (a yes/no toggle, sent as true or
 *  false). The older `rating` fields (effort and impact from 1 to 5) are gone: no Pulse screen renders them (PROMOTE-4B). */
export type NoticeAction = { key: string; label: string; tone: 'primary' | 'neutral' | 'danger'; method: 'POST'; path: string; body?: Row;
  fields?: { key: string; label: string; type: 'text' | 'choice' | 'flag'; default?: number | string; options?: { value: string; label: string }[] }[]; done: string;
  /** UX-5A's credit preview: always absent now (INTEGRITY 0910: accepting credits nothing). */ preview?: Row };
function askActions(a: Row, me: string | null): NoticeAction[] {
  if (a.status !== 'pending') return [];
  if (a.toId === me) return [
    { key: 'accept', label: a.kind === 'take' ? 'Take it' : a.kind === 'join' ? 'Let them join' : 'Join', tone: 'primary', method: 'POST', path: `/api/v0/work/asks/${a.id}/accept`, done: a.kind === 'take' ? 'It’s yours' : 'Accepted' },
    { key: 'decline', label: 'Decline', tone: 'neutral', method: 'POST', path: `/api/v0/work/asks/${a.id}/decline`, fields: [{ key: 'note', label: 'A short reason (optional)', type: 'text' }], done: 'Declined' },
  ];
  if (a.fromId === me) return [{ key: 'withdraw', label: 'Withdraw', tone: 'neutral', method: 'POST', path: `/api/v0/work/asks/${a.id}/withdraw`, done: 'Withdrawn' }];
  return [];
}
const ASK = `a.id,a.kind,a.status,a.note,a.answer_note "answerNote",a.created_at "createdAt",a.decided_at "decidedAt",a.from_id "fromId",fp.display_name "fromName",${PHOTO('fp')} "fromPhotoAt",
 a.to_id "toId",tp.display_name "toName",${PHOTO('tp')} "toPhotoAt",a.task_id "taskId",t.title "taskTitle",t.status "taskStatus",(t.due_at at time zone ${ORG_TZ})::date::text "taskDueOn",
 a.project_id "projectId",coalesce(pr.title,pr.name,tpr.title,tpr.name) "projectName",coalesce(wp.kind,twp.kind) "projectKind"`;
const ASK_FROM = `pulse.work_ask a join pulse.person fp on fp.id=a.from_id join pulse.person tp on tp.id=a.to_id left join pulse.task t on t.id=a.task_id
 left join pulse.project pr on pr.id=a.project_id left join pulse.work_project wp on wp.project_id=a.project_id
 left join pulse.project tpr on tpr.id=t.project_id left join pulse.work_project twp on twp.project_id=t.project_id`;
type AskCard = Row & { title: string; href: string; incoming: boolean; actions: NoticeAction[] };
function askCard(a: Row, me: string | null): AskCard {
  const first = (n: unknown) => String(n ?? 'Someone').replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, '').split(' ')[0];
  const what = a.taskId ? `“${a.taskTitle}”` : `the project ${a.projectName}`;
  const incoming = a.toId === me;
  const title = a.kind === 'take' ? (incoming ? `${first(a.fromName)} asks you to take ${what}` : `You asked ${first(a.toName)} to take ${what}`)
    : a.kind === 'invite' ? (incoming ? `${first(a.fromName)} invites you to join ${what}` : `You invited ${first(a.toName)} to join ${what}`)
    : (incoming ? `${first(a.fromName)} asks to join ${what}` : `You asked ${first(a.toName)} to let you join ${what}`);
  const href = a.taskId ? `/tasks/${a.taskId}?ask=${a.id}` : `/tasks/projects/${a.projectId}?ask=${a.id}`;
  return { ...a, title, href, incoming, actions: askActions(a, me) };
}

/** Words that keep a task title out of anyone's examples (pay, HR, identity documents, credentials); \y is a word edge in PostgreSQL. */
export const PRIVATE_WORDS = String.raw`(salar|payroll|pay ?slip|payout|offer|roster|\ypay\y|\ypaid\y|ctc|apprais|increment|\yhike|bonus|incentive|stipend|reimburs|offer letter|appointment letter|resign|terminat|warning|disciplin|\yleave\y|\yleft\y|leaver|joining|joiner|onboard|hire|hiring|interview|candidate|notice period|relieving|attendance|medical|health|loan|advance|bank|ifsc|account no|aadha|\ypan\y|passport|password|\yotp\y|penalt|\yfine\y|\ypf\y|\yesi\y|\ytds\y|\yhr\y|personal|private|confidential)`;

export function registerWorkRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // Everything the "+ Create" dialog needs in one read: people (with who you can assign directly), projects (recent
  // first), client projects whose fulfilment is not set up, templates and your rules.
  app.get('/api/v0/work/options', req => tx(req, async (c, v) => {
    const me = person(v);
    const people = (await c.query(`select p.id,p.display_name name,pp.username,pp.pod,pp.role,${PHOTO('p')} "photoAt",pulse.task_can_give(p.id) "canAssign",false agent
     from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and p.status='active' and p.id in (select id from pulse.work_people())
     order by p.id=$1 desc,p.display_name`, [me])).rows;
    // CHAT-WORK: AI employees the viewer may give work to (leaders and their managers), after the people.
    people.push(...(await c.query(`select p.id,p.display_name name,pp.username,pp.pod,pp.role,${PHOTO('p')} "photoAt",true "canAssign",true agent
     from pulse.person p join pulse.agent_member m on m.person_id=p.id left join pulse.people_profile pp on pp.person_id=p.id where pulse.agent_takes_tasks(p.id) order by p.display_name`)).rows);
    // CONNECT 2: the connected organisations' contacts, last, marked with their organisation.
    people.push(...(await connectedContacts(c, v)).filter((x) => !people.some((p) => p.id === x.id)).map((x) => ({ id: x.id, name: x.name, username: null, pod: null,
      role: [x.role, x.org].filter(Boolean).join(' · '), photoAt: null, canAssign: true, agent: false, org: x.org, connectionId: x.connectionId })));
    const projects = (await c.query(`with recent as (select project_id,max(coalesce(updated_at,created_at)) at from pulse.task where project_id is not null and (created_by=$1 or $1 in (owner_id,assignee_person_id)) group by 1)
     select wp.project_id id,coalesce(pr.title,pr.name) name,wp.kind,cl.display_name "clientName",r.at is not null recent,
      (wp.owner_id=$1 or exists(select 1 from pulse.project_member m where m.project_id=wp.project_id and m.person_id=$1 and m.left_at is null)) mine
     from pulse.work_project wp join pulse.project pr on pr.id=wp.project_id left join pulse.client cl on cl.id=pr.client_id left join recent r on r.project_id=wp.project_id
     where wp.status not in ('done','cancelled') and pr.status<>'cancelled'
     order by r.at desc nulls last,(wp.owner_id=$1 or exists(select 1 from pulse.project_member m where m.project_id=wp.project_id and m.person_id=$1 and m.left_at is null)) desc,
      (wp.set_up_at is not null) desc,coalesce(pr.title,pr.name) limit 900`, [me])).rows;
    const rules = (await c.query('select pulse.work_rules() r')).rows[0].r;
    const canCreate = rules.scopes['project.create'] !== 'none';
    const clientProjects = canCreate ? (await c.query(`select pr.id,coalesce(pr.title,pr.name) name,cl.display_name "clientName",wp.set_up_at is not null "setUp",pr.registry_no "registryNo"
     from pulse.project pr join pulse.work_project wp on wp.project_id=pr.id left join pulse.client cl on cl.id=pr.client_id
     where pr.kind='client_work' and pr.status not in ('done','cancelled') order by (wp.set_up_at is not null),pr.start_month desc nulls last,coalesce(pr.title,pr.name) limit 700`)).rows : [];
    const pods = (await c.query("select name from pulse.unit where kind='pod' and valid_to is null order by name")).rows.map((r) => r.name as string);
    const mine = (await c.query('select pulse.work_my_pods() p,pulse.work_head_pods() h')).rows[0];
    const day = await today(c);
    // UX-TASKS-2: who already has domains (their work is assigned by domain), the kinds of work, where the viewer may pool.
    const withDomains = new Set((await c.query("select distinct person_id from pulse.work_domain where status='active'")).rows.map((r) => r.person_id as string));
    const pools = (await c.query(`select x.scope,x.ref from (select 'company' scope,null::text ref union select 'department',d from (select distinct department d from pulse.people_profile where department is not null) a
      union select 'pod',p from (select distinct pod p from pulse.people_profile where pod is not null union select name from pulse.unit where kind='pod' and valid_to is null) b) x
      where pulse.work_can_pool(x.scope,x.ref) order by x.scope<>'company',x.scope,x.ref`)).rows;
    const settings = await workSettings(c);
    // TASKS-4A: the title field's rotating examples, from recent work the viewer can see. Never private: nothing from HR,
    // nothing about pay, people leaving or joining, documents, money amounts or passwords.
    const examples = (await c.query(`select t.title from pulse.task t where t.status<>'cancelled' and t.created_at>now()-interval '120 days' and coalesce(t.category,'')<>'hr'
      and length(t.title) between 14 and 70 and t.title !~* $1 and t.title !~ '(₹|[0-9]{4,})' order by t.created_at desc limit 80`, [PRIVATE_WORDS])).rows.map((r) => String(r.title));
    return { me, today: day.d, people: people.map((p) => ({ ...p, hasDomains: withDomains.has(p.id) })), projects, clientProjects: settings.businessModel === 'internal' ? [] : clientProjects, examples,
      templates: (await c.query('select pulse.work_templates() t')).rows[0].t,
      role: rules.role, roleLabel: ROLE_LABEL[rules.role] ?? 'Members', scopes: rules.scopes, canCreateProject: canCreate, pods, myPods: mine.p, headPods: mine.h,
      categories: (await categories(c)).filter((x) => x.active), pools, labels: settings.labels, aiAutoAcceptMax: settings.aiAutoAcceptMax };
  }));

  // Create a task in three fields. Inside the person's domains (or within Who can do what, before anyone agreed
  // domains) they get it at once and are told; otherwise they are asked (a request to join) and it stays yours until
  // they accept. With nobody chosen and a pool, it goes to the pool. Pip's suggestion is kept beside it.
  app.post<{ Body: Body }>('/api/v0/work/tasks', { schema: { body } }, req => tx(req, async (c, v) => createWorkTask(c, v, req.body)));

  // TASKS-3: the one way to give a task to someone: theirs at once when the rules allow, else a request to take it.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/tasks/:id/assign', { schema: { body } }, req => tx(req, async (c, v) =>
    assignOrAsk(c, v, id(req.params.id), optId(req.body.personId), str(req.body.note, 500) || null)));
  // Several tasks at once (My tasks' selection): move to a project, set a day or priority, give, or mark done. Each task
  // is checked on its own; one the viewer may not change is reported and the rest still change.
  app.post<{ Body: Body }>('/api/v0/work/tasks/bulk', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const list = ids(req.body.ids).slice(0, 100); const set = (req.body.set && typeof req.body.set === 'object' ? req.body.set : {}) as Body;
    if (!list.length) fail(400, 'Choose tasks');
    const fields: Body = {};
    if ('projectId' in set) fields.projectId = optId(set.projectId);
    if ('dueOn' in set) fields.dueOn = day(set.dueOn);
    if ('priority' in set) fields.priority = str(set.priority, 10);
    const status = 'status' in set ? str(set.status, 20) : null;
    const remove = set.delete === true;
    const assignee = 'assigneeId' in set ? optId(set.assigneeId) : undefined;
    let changed = 0, asked = 0; const failed: { id: string; title: string | null; error: string }[] = [];
    for (const tid of list) {
      await c.query('savepoint bulk_one');
      try {
        if (Object.keys(fields).length) await c.query('select pulse.task_save($1,$2)', [tid, JSON.stringify(fields)]);
        if (assignee !== undefined) { const r = await assignOrAsk(c, v, tid, assignee, null); if (r.asked) asked++; }
        if (status) await c.query('select pulse.task_move($1,$2,null)', [tid, status]);
        // Deleting several at once: each is checked like one (creator, admin or project owner); subtasks go with it.
        if (remove && (await c.query('select deleted_at is null live from pulse.task where id=$1', [tid])).rows[0]?.live) await c.query('select pulse.task_delete($1,null)', [tid]);
        await c.query('release savepoint bulk_one'); changed++;
      } catch (e) {
        await c.query('rollback to savepoint bulk_one');
        const title = (await c.query('select title from pulse.task where id=$1', [tid])).rows[0]?.title ?? null;
        failed.push({ id: tid, title, error: e instanceof Error ? e.message : 'Not changed' });
      }
    }
    return { changed, asked, failed };
  }));
  // People on a task: collaborators added at once when the viewer may assign them, invited otherwise.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/tasks/:id/people', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.work_task_people($1,$2,$3) r', [id(req.params.id), ids(req.body.add), ids(req.body.remove)])).rows[0].r;
  }));
  // Tags in use, most used first: for the tag box's suggestions.
  app.get('/api/v0/work/tags', req => tx(req, async (c) => ({
    rows: (await c.query(`select x.tag,count(*)::int n from pulse.task t,unnest(t.tags) x(tag) where t.status<>'cancelled' group by 1 order by 2 desc,1 limit 80`)).rows,
  })));

  // Work projects: internal and fulfilment, with progress from the tasks the viewer can see.
  app.get('/api/v0/work/projects', req => tx(req, async (c, v) => {
    const q = req.query as { kind?: string; q?: string; mine?: string; page?: string; show?: string; cat?: string };
    const me = v.person; const kind = q.kind === 'internal' || q.kind === 'fulfilment' ? q.kind : null;
    await c.query('select pulse.project_category_ensure()');
    const cat = /^[a-z][a-z0-9_]{1,39}$/.test(String(q.cat ?? '')) ? String(q.cat) : null;
    const needle = str(q.q, 80); const size = 200; const page = Math.max(0, Math.min(200, Number(q.page) || 0));
    // "Active" (default): projects with open work, set up in Pulse, or yours. "All" lists every one.
    const all = q.show === 'all';
    const where = `($1::text is null or wp.kind=$1) and ($2::text is null or coalesce(pr.title,pr.name) ilike $2 or cl.display_name ilike $2 or o.display_name ilike $2)
     and (not $3::boolean or wp.owner_id=$4 or exists(select 1 from pulse.project_member m where m.project_id=wp.project_id and m.person_id=$4 and m.left_at is null))
     and ($5::boolean or s.open>0 or wp.set_up_at is not null or wp.owner_id=$4 or exists(select 1 from pulse.project_member m where m.project_id=wp.project_id and m.person_id=$4 and m.left_at is null))
     and ($6::text is null or pc.key=$6)`;
    // TASKS-P0: each project's category (the company's own), colour and icon; unset ones follow their kind.
    const base = `pulse.work_project wp join pulse.project pr on pr.id=wp.project_id left join pulse.client cl on cl.id=pr.client_id left join pulse.person o on o.id=wp.owner_id
     left join pulse.project_category pc on pc.org_id=wp.org_id and pc.key=coalesce(wp.project_category,case wp.kind when 'internal' then 'internal' when 'fulfilment' then 'client' end)
     left join (select t.project_id,count(*) filter(where t.status<>'cancelled')::int total,count(*) filter(where ${FINISHED})::int finished,count(*) filter(where ${OPEN})::int open,
      count(*) filter(where ${OPEN} and ${DUE}<(now() at time zone ${ORG_TZ})::date)::int overdue,count(*) filter(where t.status='blocked')::int blocked,
      count(*) filter(where t.status='in_progress')::int doing,
      min(${DUE}) filter(where ${OPEN} and ${DUE}>=(now() at time zone ${ORG_TZ})::date)::text "nextDue",max(coalesce(t.done_at,t.updated_at)) "lastAt"
      from pulse.task t where t.project_id is not null group by 1) s on s.project_id=wp.project_id`;
    const args = [kind, needle ? `%${needle.replace(/[\\%_]/g, (m) => '\\' + m)}%` : null, q.mine === '1', me, all, cat];
    const total = (await c.query(`select count(*)::int n from ${base} where ${where}`, args)).rows[0].n;
    const rows = (await c.query(`select wp.project_id id,coalesce(pr.title,pr.name) name,wp.kind,wp.status,wp.pod,wp.due_on::text "dueOn",wp.starts_on::text "startsOn",wp.set_up_at is not null "setUp",
      pr.kind "projectKind",pr.registry_no "registryNo",pr.status "packageStatus",cl.id "clientId",cl.display_name "clientName",wp.owner_id "ownerId",o.display_name "ownerName",${PHOTO('o')} "ownerPhotoAt",
      coalesce(s.total,0) total,coalesce(s.finished,0) finished,coalesce(s.open,0) open,coalesce(s.overdue,0) overdue,coalesce(s.blocked,0) blocked,coalesce(s.doing,0) doing,s."nextDue",s."lastAt",
      (select count(*)::int from pulse.project_member m where m.project_id=wp.project_id and m.role='member' and m.left_at is null) members,
      (select jsonb_build_object('id',c.id,'name',coalesce(c.title,c.name)) from pulse.work_project_link l join pulse.project c on c.id=l.client_project_id where l.project_id=wp.project_id and l.status='linked' limit 1) "partOf",
      (select count(*)::int from pulse.work_project_link l where l.client_project_id=wp.project_id and l.status='linked') includes,
      (wp.owner_id=$4 or exists(select 1 from pulse.project_member m where m.project_id=wp.project_id and m.person_id=$4 and m.left_at is null)) mine,
      pc.key category,pc.label "categoryLabel",coalesce(wp.color,pc.color) color,coalesce(wp.icon,pc.icon) icon,wp.summary
     from ${base} where ${where}
     order by (coalesce(s.open,0)>0) desc,(wp.owner_id=$4) desc,coalesce(s.overdue,0) desc,s."nextDue" nulls last,s."lastAt" desc nulls last,coalesce(pr.title,pr.name) limit ${size} offset ${page * size}`, args)).rows;
    const counts = (await c.query(`select count(*) filter(where wp.kind='internal')::int internal,count(*) filter(where wp.kind='fulfilment')::int fulfilment,count(*)::int "all"
     from ${base} where ($1::boolean or s.open>0 or wp.set_up_at is not null or wp.owner_id=$2 or exists(select 1 from pulse.project_member m where m.project_id=wp.project_id and m.person_id=$2 and m.left_at is null))`, [all, me])).rows[0];
    const review = leadership(v) || hr(v) ? (await c.query("select count(*)::int n from pulse.work_review where status='pending'")).rows[0].n : 0;
    const linkReview = leadership(v) || hr(v) ? (await c.query("select count(*)::int n from pulse.work_project_link where status='suggested' and retired_at is null")).rows[0].n : 0;
    const scopes = (await c.query('select pulse.work_rules() r')).rows[0].r.scopes;
    const categories = (await c.query(`select pc.key,pc.label,pc.icon,pc.color,count(wp.project_id)::int projects from pulse.project_category pc
      left join pulse.work_project wp on wp.org_id=pc.org_id and coalesce(wp.project_category,case wp.kind when 'internal' then 'internal' when 'fulfilment' then 'client' end)=pc.key
      where pc.retired_at is null group by pc.key,pc.label,pc.icon,pc.color,pc.sort order by pc.sort,pc.label`)).rows;
    return { rows, total, page, size, counts, review, linkReview, canCreate: !!me && scopes['project.create'] !== 'none', canDecide: leadership(v), labels: (await workSettings(c)).labels, categories };
  }));

  app.post<{ Body: Body }>('/api/v0/work/projects', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.work_project_save(null,$1) r', [JSON.stringify(projectFields(req.body))])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/projects/:id', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.work_project_save($1,$2) r', [id(req.params.id), JSON.stringify(projectFields(req.body))])).rows[0].r;
  }));
  // TASKS-4B: delete a project (internal): what is connected first, then one soft delete with its tasks, restorable 30 days.
  app.get<{ Params: { id: string } }>('/api/v0/work/projects/:id/delete-preview', req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.project_delete_preview($1) r', [id(req.params.id)])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/projects/:id/delete', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.project_delete($1,$2) r', [id(req.params.id), str(req.body.note, 500) || null])).rows[0].r;
  }));
  app.post<{ Params: { id: string } }>('/api/v0/work/projects/:id/restore', req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.project_restore($1) r', [id(req.params.id)])).rows[0].r;
  }));
  app.get('/api/v0/work/projects/deleted', req => tx(req, async (c, v) => {
    person(v); return { rows: (await c.query(`select id,name,deleted_at "deletedAt",deleted_by_name "deletedBy",note,tasks,restore_until "restoreUntil" from pulse.project_deleted_list()`)).rows };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/projects/:id/people', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.work_project_people($1,$2,$3) r', [id(req.params.id), ids(req.body.add), ids(req.body.remove)])).rows[0].r;
  }));
  app.post<{ Body: Body }>('/api/v0/work/watch', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); await c.query('select pulse.work_watch($1,$2,$3)', [optId(req.body.taskId), optId(req.body.projectId), req.body.on !== false]); return { ok: true, on: req.body.on !== false };
  }));

  // Asks: incoming and sent, each with the buttons the person can press.
  app.get('/api/v0/work/asks', req => tx(req, async (c, v) => {
    const me = person(v);
    const rows = (await c.query(`select ${ASK} from ${ASK_FROM} where (a.to_id=$1 or a.from_id=$1) and (a.status='pending' or a.decided_at>now()-interval '14 days') order by a.status='pending' desc,a.created_at desc limit 100`, [me])).rows;
    const cards = rows.map((a) => askCard(a, me));
    return { incoming: cards.filter((a) => a.incoming && a.status === 'pending'), outgoing: cards.filter((a) => !a.incoming && a.status === 'pending'), recent: cards.filter((a) => a.status !== 'pending').slice(0, 20) };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/work/asks/:id', req => tx(req, async (c, v) => {
    const me = person(v);
    const a = (await c.query(`select ${ASK} from ${ASK_FROM} where a.id=$1`, [id(req.params.id)])).rows[0] ?? fail(404, 'This request is not available');
    return askCard(a, me);
  }));
  app.post<{ Body: Body }>('/api/v0/work/asks', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const b = req.body; const kind = str(b.kind, 10);
    return { id: (await c.query('select pulse.work_ask_create($1,$2,$3,$4,$5) id', [kind, optId(b.taskId), optId(b.projectId), optId(b.toId), str(b.note, 500) || null])).rows[0].id };
  }));
  for (const [action, accept] of [['accept', true], ['decline', false]] as const)
    app.post<{ Params: { id: string }; Body: Body }>(`/api/v0/work/asks/:id/${action}`, { schema: { body } }, req => tx(req, async (c, v) => {
      person(v); return (await c.query('select pulse.work_ask_answer($1,$2,$3) r', [id(req.params.id), accept, str(req.body?.note, 500) || null])).rows[0].r;
    }));
  app.post<{ Params: { id: string } }>('/api/v0/work/asks/:id/withdraw', req => tx(req, async (c, v) => {
    person(v); await c.query('select pulse.work_ask_withdraw($1)', [id(req.params.id)]); return { ok: true };
  }));

  // Comments with @mentions on a task or a project.
  app.get('/api/v0/work/comments', req => tx(req, async (c) => {
    const q = req.query as { task?: string; project?: string };
    return { rows: await comments(c, q.task ? id(q.task) : null, q.project ? id(q.project) : null) };
  }));
  app.post<{ Body: Body }>('/api/v0/work/comments', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const b = req.body;
    // TASKS-4B: a reply (parentId) or a request for help (kind help) goes through work_comment_post.
    if (b.parentId || b.kind === 'help') return { id: (await c.query('select pulse.work_comment_post($1) id', [JSON.stringify({ taskId: optId(b.taskId), projectId: optId(b.projectId),
      parentId: optId(b.parentId), kind: b.kind === 'help' ? 'help' : 'comment', body: str(b.body, 4000), mentions: ids(b.mentions) })])).rows[0].id };
    return { id: (await c.query('select pulse.work_comment_add($1,$2,$3,$4) id', [optId(b.taskId), optId(b.projectId), str(b.body, 4000), ids(b.mentions)])).rows[0].id };
  }));
  // TASKS-4B: resolve or reopen a thread; the asker rates each helper of a resolved help thread (privately).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/comments/:id/resolve', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.work_thread_resolve($1,$2) r', [id(req.params.id), req.body.on !== false])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/comments/:id/rate', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.work_help_rate($1,$2,$3) r', [id(req.params.id), id(req.body.helperId), str(req.body.rating, 12)])).rows[0].r;
  }));
  // Who "Ask for help" tells, before asking.
  app.get<{ Params: { id: string } }>('/api/v0/work/tasks/:id/help-people', req => tx(req, async (c, v) => {
    person(v);
    return { rows: (await c.query(`select h.person_id id,p.display_name name,${PHOTO('p')} "photoAt",h.why from pulse.work_help_people($1) h join pulse.person p on p.id=h.person_id order by p.display_name`, [id(req.params.id)])).rows };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/work/comments/:id/remove', req => tx(req, async (c, v) => {
    person(v); await c.query('select pulse.work_comment_remove($1)', [id(req.params.id)]); return { ok: true };
  }));

  // Who can do what: the matrix everyone reads and HR and admins adjust.
  app.get('/api/v0/work/rules', req => tx(req, async (c) => {
    const r = (await c.query('select pulse.work_rules() r')).rows[0].r;
    const roles = (await c.query(`select pulse.work_role(p.id) role,count(*)::int n from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and p.status='active' group by 1`)).rows;
    return { ...r, roleLabel: ROLE_LABEL[r.role] ?? 'Members', people: Object.fromEntries(roles.map((x) => [x.role, x.n])) };
  }));
  app.post<{ Body: Body }>('/api/v0/work/rules', { schema: { body } }, req => tx(req, async (c) => {
    await c.query('select pulse.work_rule_set($1,$2,$3)', [str(req.body.role, 20), str(req.body.action, 30), str(req.body.scope, 10)]); return { ok: true };
  }));

  // The migration's open questions: client packages without a client, and kinds that disagree with their client.
  app.get('/api/v0/work/review', req => tx(req, async (c, v) => {
    if (!leadership(v) && !hr(v)) fail(403, 'The filing review is for leadership');
    const rows = (await c.query(`select r.id,r.reason,r.detail,r.created_at "createdAt",p.id "projectId",coalesce(p.title,p.name) name,p.registry_no "registryNo",p.kind,p.status,
      p.storage_root is not null "hasDrive",cl.display_name "clientName",(select count(*)::int from pulse.task t where t.project_id=p.id) tasks
     from pulse.work_review r join pulse.project p on p.id=r.project_id left join pulse.client cl on cl.id=p.client_id where r.status='pending'
     order by (select count(*) from pulse.task t where t.project_id=p.id) desc,coalesce(p.title,p.name) limit 200`)).rows;
    const decided = (await c.query("select count(*)::int n from pulse.work_review where status='decided'")).rows[0].n;
    const clients = (await c.query("select id,display_name name from pulse.client where coalesce(status,'active')<>'churned' and client_type<>'internal' order by display_name")).rows;
    return { rows, decided, clients, canDecide: leadership(v) };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/review/:id', { schema: { body } }, req => tx(req, async (c) => {
    await c.query('select pulse.work_review_decide($1,$2,$3)', [id(req.params.id), str(req.body.decision, 20), optId(req.body.clientId)]); return { ok: true };
  }));

  // A client project as the package sold, with its fulfilment's progress beside it.
  app.get<{ Params: { id: string } }>('/api/v0/work/package/:id', req => tx(req, async (c, v) => {
    const pid = id(req.params.id);
    const p = (await c.query(`select pr.id,coalesce(pr.title,pr.name) title,pr.kind,pr.status,pr.scope,pr.starts_on::text "startsOn",pr.ends_on::text "endsOn",pr.start_month::text "startMonth",
      pr.package_key "package",pr.registry_no "registryNo",cl.id "clientId",cl.display_name "clientName",pulse.client_project_value(pr.id) value,
      wp.owner_id "ownerId",o.display_name "ownerName",wp.status "workStatus",wp.due_on::text "dueOn",wp.set_up_at is not null "setUp",wp.pod
     from pulse.project pr left join pulse.client cl on cl.id=pr.client_id left join pulse.work_project wp on wp.project_id=pr.id left join pulse.person o on o.id=wp.owner_id
     where pr.id=$1`, [pid])).rows[0] ?? fail(404, 'Client project not found');
    const progress = (await c.query(`select count(*) filter(where t.status<>'cancelled')::int total,count(*) filter(where ${FINISHED})::int finished,count(*) filter(where ${OPEN})::int open,
      count(*) filter(where ${OPEN} and ${DUE}<(now() at time zone ${ORG_TZ})::date)::int overdue,count(*) filter(where t.status='blocked')::int blocked,
      min(${DUE}) filter(where ${OPEN} and ${DUE}>=(now() at time zone ${ORG_TZ})::date)::text "nextDue" from pulse.task t where t.project_id=$1`, [pid])).rows[0];
    const contacts = (await c.query(`select distinct on (p.id) p.id,p.display_name name,coalesce(pc.role,case when cc.is_primary then 'Primary contact' else 'Client contact' end) role from pulse.person p
      left join pulse.project_contact pc on pc.person_id=p.id and pc.project_id=$1 left join pulse.client_contact cc on cc.person_id=p.id and cc.client_id=$2
      where pc.project_id is not null or cc.client_id is not null order by p.id,cc.is_primary desc nulls last limit 12`, [pid, p.clientId])).rows;
    // UX-TASKS-2: what the package includes (linked projects and client folders), with combined progress.
    const links = await packageLinks(c, v, pid);
    const combined = { total: progress.total + links.totals.total, finished: progress.finished + links.totals.finished, open: progress.open + links.totals.open, overdue: progress.overdue + links.totals.overdue };
    return { ...p, progress, contacts, canEdit: leadership(v), links, combined };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/package/:id', { schema: { body } }, req => tx(req, async (c) => {
    const b = req.body; const fields: Body = {};
    for (const k of ['scope', 'status', 'valueAmount', 'valueCurrency']) if (k in b) fields[k] = b[k] === null ? null : str(b[k], 2000);
    for (const k of ['startsOn', 'endsOn']) if (k in b) fields[k] = day(b[k]);
    await c.query('select pulse.client_project_save($1,$2)', [id(req.params.id), JSON.stringify(fields)]); return { ok: true };
  }));

  app.get('/api/v0/work/dashboard', req => tx(req, async (c, v) => dashboard(c, v, req.query as { pod?: string; group?: string; department?: string })));

  // The notification panel's contract (UX-NOTIFY): one card per task or project notification, with what happened,
  // who did it, and the actions the reader can take there. Authorization is rechecked here and by every action.
  app.get('/api/v0/work/notices', req => tx(req, async (c, v) => {
    const me = person(v); const q = req.query as { id?: string; limit?: string };
    const limit = Math.max(1, Math.min(100, Number(q.limit) || 30));
    const rows = (await c.query(`select n.id,n.event_type "eventType",n.subject_type "subjectType",n.subject_id "subjectId",n.title,n.href,n.read_at "readAt",n.created_at "at",n.expires_at>clock_timestamp() active
     from pulse.notification n where n.person_id=$1 and n.dismissed_at is null and pulse.notification_authorized(n.id,$1) and ($2::uuid is null or n.id=$2)
     and (n.event_type like 'task.%' or n.event_type like 'project.%' or n.event_type like 'domain.%' or n.event_type like 'pool.%' or n.event_type='ask.answered') order by n.created_at desc limit $3`, [me, optId(q.id), limit])).rows;
    const pre = await noticePrefetch(c, rows);
    return { rows: await Promise.all(rows.map((n) => noticeCard(c, n, me, pre))) };
  }));
}

function projectFields(b: Body): Body {
  const f: Body = {};
  for (const k of ['type', 'name', 'summary', 'templateKey', 'pod', 'status']) if (k in b) f[k] = b[k] === null ? null : str(b[k], 1000);
  for (const k of ['clientProjectId', 'ownerId']) if (k in b) f[k] = optId(b[k]);
  for (const k of ['startsOn', 'dueOn']) if (k in b) f[k] = day(b[k]);
  if ('memberIds' in b) f.memberIds = ids(b.memberIds);
  return f;
}

export async function comments(c: PoolClient, task: string | null, project: string | null) {
  // TASKS-4B: threads (parentId), help requests (kind help), resolved threads, and for a resolved help thread the people
  // who answered with the viewer's own ratings (ratings are private: the viewer reads only their own).
  return (await c.query(`select w.id,w.body,w.mentions,w.created_at "at",w.author_id "authorId",a.display_name "authorName",${PHOTO('a')} "authorPhotoAt",
    w.author_id=pulse.current_viewer() mine,coalesce((select jsonb_agg(jsonb_build_object('id',m.id,'name',m.display_name,'photoAt',${PHOTO('m')})) from pulse.person m where m.id=any(w.mentions)),'[]') people,
    w.parent_id "parentId",w.kind,w.resolved_at "resolvedAt",rb.display_name "resolvedBy",
    case when w.kind='help' and w.parent_id is null then (select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'name',h.display_name,'photoAt',${PHOTO('h')},
      'rating',(select r.rating from pulse.help_rating r where r.root_id=w.id and r.helper_id=h.id))),'[]')
      from pulse.person h where h.id in (select x.author_id from pulse.work_comment x where x.removed_at is null and x.author_id<>w.author_id and x.id<>w.id and pulse.work_comment_root(x.id)=w.id)) end helpers
   from pulse.work_comment w join pulse.person a on a.id=w.author_id left join pulse.person rb on rb.id=w.resolved_by
   where (($1::uuid is not null and w.task_id=$1) or ($2::uuid is not null and w.project_id=$2)) and w.removed_at is null order by w.created_at limit 300`, [task, project])).rows;
}

/** People on a task (collaborators, watchers) and the asks about it the viewer may see. */
export async function taskPeople(c: PoolClient, tid: string, me: string | null) {
  const members = (await c.query(`select m.person_id id,p.display_name name,m.role,${PHOTO('p')} "photoAt" from pulse.task_member m join pulse.person p on p.id=m.person_id
   where m.task_id=$1 and m.removed_at is null order by m.role,p.display_name`, [tid])).rows;
  const asks = (await c.query(`select ${ASK} from ${ASK_FROM} where a.task_id=$1 and a.status='pending' order by a.created_at`, [tid])).rows.map((a) => askCard(a, me));
  return { members, asks, watching: members.some((m) => m.id === me) };
}

/** A work project's own fields, people, asks and comments, for the project page. */
export async function projectWork(c: PoolClient, v: Viewer, pid: string) {
  const me = v.person;
  const work = (await c.query(`select wp.kind,wp.status,wp.pod,wp.starts_on::text "startsOn",wp.due_on::text "dueOn",wp.summary,wp.template_key "templateKey",wp.set_up_at is not null "setUp",
    wp.owner_id "ownerId",o.display_name "ownerName",${PHOTO('o')} "ownerPhotoAt",pr.kind "projectKind",pr.status "packageStatus",pr.scope,pr.starts_on::text "packageStartsOn",pr.ends_on::text "packageEndsOn",
    cl.id "clientId",cl.display_name "clientName",pulse.work_project_can_manage(wp.project_id) "canManage",pulse.work_project_in(wp.project_id) "inside",
    pulse.work_project_person(wp.project_id,$2) "onIt",pc.key category,pc.label "categoryLabel",coalesce(wp.color,pc.color) color,coalesce(wp.icon,pc.icon) icon,
    wp.project_category is not null "categorySet"
   from pulse.work_project wp join pulse.project pr on pr.id=wp.project_id left join pulse.client cl on cl.id=pr.client_id left join pulse.person o on o.id=wp.owner_id
   left join pulse.project_category pc on pc.org_id=wp.org_id and pc.key=coalesce(wp.project_category,case wp.kind when 'internal' then 'internal' when 'fulfilment' then 'client' end)
   where wp.project_id=$1`, [pid, me])).rows[0] ?? null;
  if (!work) return null;
  const members = (await c.query(`select m.person_id id,p.display_name name,m.role,${PHOTO('p')} "photoAt",pp.pod from pulse.project_member m join pulse.person p on p.id=m.person_id
   left join pulse.people_profile pp on pp.person_id=p.id where m.project_id=$1 and m.left_at is null order by m.role,p.display_name`, [pid])).rows;
  const asks = (await c.query(`select ${ASK} from ${ASK_FROM} where a.project_id=$1 and a.status='pending' order by a.created_at`, [pid])).rows.map((a) => askCard(a, me));
  return { ...work, members, asks, watching: members.some((m) => m.id === me), comments: work.inside ? await comments(c, null, pid) : [] };
}

const NOTICE_TASK = `select t.id,t.title,t.status,t.review_owner_id "reviewerId",coalesce(t.assignee_person_id,t.owner_id) "doerId",d.display_name "doerName",${PHOTO('d')} "doerPhotoAt"
     from pulse.task t left join pulse.person d on d.id=coalesce(t.assignee_person_id,t.owner_id)`;
/** PERF: the tasks and projects a page of notices is about, read at once (the bell read each one apart: ~100 queries for
 *  a person with many task notices, 155-300 ms). noticeCard falls back to its own read for anything not here. */
export async function noticePrefetch(c: PoolClient, rows: Row[]): Promise<NoticePrefetch> {
  const ids = (type: string) => [...new Set(rows.filter((n) => n.subjectType === type && n.subjectId).map((n) => String(n.subjectId)))];
  const tasks = ids('task'), projects = ids('project');
  return {
    tasks: new Map(tasks.length ? (await c.query(`${NOTICE_TASK} where t.id=any($1::uuid[])`, [tasks])).rows.map((t) => [String(t.id), t]) : []),
    projects: new Map(projects.length ? (await c.query('select id,coalesce(title,name) title from pulse.project where id=any($1::uuid[])', [projects])).rows.map((p) => [String(p.id), p]) : []),
  };
}
export type NoticePrefetch = { tasks: Map<string, Row>; projects: Map<string, Row> };

export async function noticeCard(c: PoolClient, n: Row, me: string, pre?: NoticePrefetch) {
  const card: Row & { actions: NoticeAction[]; state: string } = { ...n, actions: [], state: n.active ? 'open' : 'expired', body: null, from: null, subject: null };
  if (n.subjectType === 'work_ask') {
    const a = (await c.query(`select ${ASK} from ${ASK_FROM} where a.id=$1`, [n.subjectId])).rows[0];
    if (a) { const k = askCard(a, me); Object.assign(card, { body: a.note ?? a.answerNote ?? null, from: { id: a.fromId, name: a.fromName, photoAt: a.fromPhotoAt }, subject: a.taskId ? { type: 'task', id: a.taskId, title: a.taskTitle } : { type: 'project', id: a.projectId, title: a.projectName }, state: a.status === 'pending' ? card.state : String(a.status), actions: n.eventType === 'ask.answered' ? [] : k.actions }); }
  } else if (n.subjectType === 'comment') {
    const w = (await c.query(`select w.body,w.task_id "taskId",w.project_id "projectId",a.id "authorId",a.display_name "authorName",${PHOTO('a')} "authorPhotoAt",coalesce(t.title,coalesce(pr.title,pr.name)) "subjectTitle"
     from pulse.work_comment w join pulse.person a on a.id=w.author_id left join pulse.task t on t.id=w.task_id left join pulse.project pr on pr.id=w.project_id where w.id=$1`, [n.subjectId])).rows[0];
    if (w) Object.assign(card, { body: w.body, from: { id: w.authorId, name: w.authorName, photoAt: w.authorPhotoAt }, subject: w.taskId ? { type: 'task', id: w.taskId, title: w.subjectTitle } : { type: 'project', id: w.projectId, title: w.subjectTitle },
      // TASKS-4B: a reply from the bell goes under the comment it answers (its author is told as the one answered).
      actions: [{ key: 'reply', label: n.eventType === 'task.help' ? 'Help' : 'Reply', tone: 'primary', method: 'POST', path: '/api/v0/work/comments', body: { parentId: n.subjectId },
        fields: [{ key: 'body', label: n.eventType === 'task.help' ? 'Your answer' : 'Reply', type: 'text' }], done: 'Replied' }] });
  } else if (n.subjectType === 'task') {
    const t = pre ? pre.tasks.get(String(n.subjectId)) : (await c.query(`${NOTICE_TASK} where t.id=$1`, [n.subjectId])).rows[0];
    if (t) {
      Object.assign(card, { subject: { type: 'task', id: t.id, title: t.title, status: t.status }, from: t.doerId && t.doerId !== me ? { id: t.doerId, name: t.doerName, photoAt: t.doerPhotoAt } : null });
      // TASKS-4B: "Kedab finished …" with their photo, how it went against the deadline and how long it has waited; one
      // quality rating (or Acknowledge for leadership's work) replaces the effort and impact dropdowns.
      if (n.eventType === 'task.done') {
        const d = await doneNotice(c, t.id, me);
        if (d) Object.assign(card, { title: d.title, body: d.body, from: d.from, actions: d.actions });
      } else if (n.eventType === 'task.blocked' && !['done', 'accepted', 'cancelled', 'in_review'].includes(t.status)) card.actions = [{ key: 'unblock', label: 'Mine is done: unblock', tone: 'primary', method: 'POST', path: `/api/v0/tasks/${t.id}/move`, body: { status: 'done' }, done: 'Done · unblocked' }];
      if (['done', 'accepted', 'cancelled'].includes(t.status) && n.eventType !== 'task.update' && !card.actions.length) card.state = card.state === 'open' ? 'done' : card.state;
    }
  } else if (n.eventType === 'task.review_nudge') {
    // The daily nudge: what waits now (it may have changed since the notice was written).
    const q = (await c.query(`select count(*)::int n,min(t.done_at) oldest,(array_agg(t.title order by t.done_at))[1] title,(array_agg(p.display_name order by t.done_at))[1] who
     from pulse.task t left join pulse.person p on p.id=coalesce(t.assignee_person_id,t.owner_id) where t.id in (select pulse.task_review_queue($1))`, [me])).rows[0];
    Object.assign(card, { title: q.n ? `${q.n} finished task${q.n === 1 ? '' : 's'} wait${q.n === 1 ? 's' : ''} for your review` : 'Reviews: all caught up',
      body: q.n ? `Oldest: “${q.title}” by ${String(q.who ?? 'someone').split(' ')[0]}, waiting ${waited(q.oldest)}` : null, state: q.n ? card.state : 'done' });
  } else if (n.subjectType === 'project') {
    const p = pre ? pre.projects.get(String(n.subjectId)) : (await c.query('select id,coalesce(title,name) title from pulse.project where id=$1', [n.subjectId])).rows[0];
    if (p) card.subject = { type: 'project', id: p.id, title: p.title };
  } else if (n.subjectType === 'work_domain') {
    Object.assign(card, await domainNotice(c, me, n, card.state));
  }
  // UX-TASKS-2: a pool task that fits your domains offers Claim while nobody has it.
  if (n.eventType === 'pool.match' && card.subject) {
    const t = (await c.query('select assignee_person_id is null and owner_id is null and pool_scope is not null free,pulse.work_pool_eligible(pool_scope,pool_ref) ok from pulse.task where id=$1', [n.subjectId])).rows[0];
    if (t?.free && t.ok) card.actions = [{ key: 'claim', label: 'Claim', tone: 'primary', method: 'POST', path: `/api/v0/work/pool/${n.subjectId}/claim`, done: 'It’s yours' }];
    else card.state = card.state === 'open' ? 'done' : card.state;
  }
  return card;
}

/** The management dashboard: leadership and HR see everyone, a pod head their pods; one screen of what needs acting on. */
async function dashboard(c: PoolClient, v: Viewer, q: { pod?: string; group?: string; department?: string }) {
  const me = person(v); const day = await today(c);
  const role = (await c.query('select pulse.work_role() r,pulse.work_head_pods() pods')).rows[0];
  const everyone = role.r === 'leadership' || role.r === 'hr';
  if (!everyone && role.r !== 'pod_head') fail(403, 'The team dashboard is for leadership, HR and pod heads');
  const pods = everyone ? (await c.query("select name from pulse.unit where kind='pod' and valid_to is null order by name")).rows.map((r) => r.name as string) : role.pods as string[];
  const pod = q.pod && pods.includes(q.pod) ? q.pod : null;
  const weekEnd = new Date(Date.parse(`${day.w}T00:00:00Z`) + 6 * 86400000).toISOString().slice(0, 10);
  // People in view: everyone (or one pod) for leadership and HR; a pod head's pods and the people they manage.
  const people = (await c.query(`select p.id,p.display_name name,pp.pod,${PHOTO('p')} "photoAt" from pulse.person p join pulse.people_profile pp on pp.person_id=p.id
   where p.side='staff' and p.status='active' and ($1::boolean or pp.pod=any(pulse.work_head_pods()) or pulse.manages(p.id) or p.id=$2) and ($3::text is null or pp.pod=$3)
    and ($4::text is null or coalesce(pp.department,'')=$4) order by p.display_name`, [everyone, me, pod, q.department === undefined ? null : str(q.department, 80)])).rows;
  const scope = people.map((p) => p.id as string);
  // Every query below reads the people in view as one more parameter after its own ("work_scope" and "$scope").
  const run = (sql: string, args: unknown[] = []) => { const n = `$${args.length + 1}::uuid[]`;
    return c.query(sql.replaceAll('work_scope', `(select unnest(${n}) id)`).replaceAll('$scope', n), [...args, scope]); };
  const T = `pulse.task t join work_scope s on s.id=coalesce(t.assignee_person_id,t.owner_id)`;
  // Everyone's view also counts work nobody owns yet; a pod's view counts its people's.
  const whole = everyone && !pod && q.department === undefined;
  const ALL = whole ? `pulse.task t where (coalesce(t.assignee_person_id,t.owner_id) in (select s.id from work_scope s) or coalesce(t.assignee_person_id,t.owner_id) is null) and` : `${T} where`;
  const workload = (await run(`select s.id,s.name,s.pod,s."photoAt",count(t.id) filter(where ${OPEN})::int open,count(t.id) filter(where t.status='in_progress')::int doing,
    count(t.id) filter(where ${OPEN} and ${DUE} between $1::date and $2::date)::int "dueWeek",count(t.id) filter(where ${OPEN} and ${DUE}<$1::date)::int overdue,
    count(t.id) filter(where t.status='blocked')::int blocked,count(t.id) filter(where ${FINISHED} and coalesce(t.done_at,t.work_on::timestamptz)>=$3::date::timestamp at time zone ${ORG_TZ})::int "doneWeek",
    count(t.id) filter(where t.status='unknown')::int untriaged
   from (select p.id,p.display_name name,pp.pod,${PHOTO('p')} "photoAt" from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=any($scope)) s
   left join pulse.task t on coalesce(t.assignee_person_id,t.owner_id)=s.id group by s.id,s.name,s.pod,s."photoAt"
   order by count(t.id) filter(where ${OPEN} and ${DUE}<$1::date) desc,count(t.id) filter(where ${OPEN}) desc,s.name`, [day.d, weekEnd, day.w])).rows;
  const totals = (await run(`select count(*) filter(where ${OPEN})::int open,count(*) filter(where ${OPEN} and ${DUE} between $1::date and $2::date)::int "dueWeek",
    count(*) filter(where ${OPEN} and ${DUE}<$1::date)::int overdue,count(*) filter(where t.status='blocked')::int blocked,
    count(*) filter(where ${FINISHED} and coalesce(t.done_at,t.work_on::timestamptz)>=$3::date::timestamp at time zone ${ORG_TZ})::int "doneWeek",
    count(*) filter(where ${FINISHED} and coalesce(t.done_at,t.work_on::timestamptz)>=($3::date-7)::timestamp at time zone ${ORG_TZ} and coalesce(t.done_at,t.work_on::timestamptz)<$3::date::timestamp at time zone ${ORG_TZ})::int "doneLastWeek",
    count(*) filter(where t.status='unknown')::int untriaged,count(*) filter(where ${OPEN} and coalesce(t.assignee_person_id,t.owner_id) is null)::int unowned from ${ALL} true`, [day.d, weekEnd, day.w])).rows[0];
  const throughput = (await run(`with w as (select generate_series($1::date-interval '7 weeks',$1::date,interval '1 week')::date wk)
    select w.wk::text week,(select count(*)::int from ${ALL} ${FINISHED} and coalesce(t.done_at,t.work_on::timestamptz)>=w.wk::timestamp at time zone ${ORG_TZ} and coalesce(t.done_at,t.work_on::timestamptz)<(w.wk+7)::timestamp at time zone ${ORG_TZ}) done,
     (select count(*)::int from ${ALL} t.created_at>=w.wk::timestamp at time zone ${ORG_TZ} and t.created_at<(w.wk+7)::timestamp at time zone ${ORG_TZ}) added
    from w order by w.wk`, [day.w])).rows;
  // Blocked work, grouped by the person everyone is waiting on.
  const waits = (await run(`select l.created_at since,b.id "blockerId",b.title "blockerTitle",coalesce(b.assignee_person_id,b.owner_id) "ownerId",bp.display_name "ownerName",${PHOTO('bp')} "ownerPhotoAt",
    w.id "waitingId",w.title "waitingTitle",wp.display_name "waitingOwner" from pulse.task_link l join pulse.task b on b.id=l.blocker_id join pulse.task w on w.id=l.task_id
    join work_scope s on s.id=coalesce(w.assignee_person_id,w.owner_id) left join pulse.person bp on bp.id=coalesce(b.assignee_person_id,b.owner_id) left join pulse.person wp on wp.id=coalesce(w.assignee_person_id,w.owner_id)
    where l.cleared_at is null and b.status not in ('done','accepted','cancelled','in_review') and w.status not in ('done','accepted','cancelled') order by l.created_at`)).rows;
  const blockers = new Map<string, { ownerId: string | null; ownerName: string; ownerPhotoAt: string | null; waiting: Row[]; oldest: string }>();
  for (const w of waits) {
    const k = String(w.ownerId ?? 'nobody');
    if (!blockers.has(k)) blockers.set(k, { ownerId: w.ownerId as string | null, ownerName: String(w.ownerName ?? 'Nobody yet'), ownerPhotoAt: w.ownerPhotoAt as string | null, waiting: [], oldest: String(w.since) });
    blockers.get(k)!.waiting.push({ id: w.waitingId, title: w.waitingTitle, owner: w.waitingOwner, blockerId: w.blockerId, blockerTitle: w.blockerTitle, since: w.since });
  }
  const manualBlocked = (await run(`select ${TASK},(select e.at from pulse.task_event e where e.task_id=t.id and e.to_value='blocked' order by e.at desc limit 1) "blockedSince"
    from ${FROM} join work_scope s on s.id=coalesce(t.assignee_person_id,t.owner_id) where t.status='blocked' and pulse.task_open_blockers(t.id)=0 order by t.updated_at limit 20`)).rows;
  // Client projects: fulfilment progress, next deadline, at risk.
  const clientWork = (await run(`select wp.project_id id,coalesce(pr.title,pr.name) name,cl.display_name "clientName",wp.owner_id "ownerId",o.display_name "ownerName",wp.due_on::text "dueOn",
    count(t.id) filter(where t.status<>'cancelled')::int total,count(t.id) filter(where ${FINISHED})::int finished,count(t.id) filter(where ${OPEN})::int open,
    count(t.id) filter(where ${OPEN} and ${DUE}<$1::date)::int overdue,count(t.id) filter(where t.status='blocked')::int blocked,
    least(min(${DUE}) filter(where ${OPEN} and ${DUE}>=$1::date),case when wp.due_on>=$1::date then wp.due_on end)::text "nextDue"
   from pulse.work_project wp join pulse.project pr on pr.id=wp.project_id left join pulse.client cl on cl.id=pr.client_id left join pulse.person o on o.id=wp.owner_id
   left join pulse.task t on t.project_id=wp.project_id or t.project_id in (select l.project_id from pulse.work_project_link l where l.client_project_id=wp.project_id and l.status='linked')
   where wp.kind='fulfilment' and wp.status in ('planned','active','paused') and pr.status not in ('done','cancelled')
    and not exists(select 1 from pulse.work_project_link l join pulse.project c on c.id=l.client_project_id where l.project_id=wp.project_id and l.status='linked' and c.kind='client_work')
    and ($2::boolean or wp.pod=any(pulse.work_head_pods()) or exists(select 1 from work_scope s where s.id in (wp.owner_id,coalesce(t.assignee_person_id,t.owner_id))))
    and ($3::text is null or wp.pod=$3 or exists(select 1 from work_scope s where s.id=coalesce(t.assignee_person_id,t.owner_id)))
   group by wp.project_id,pr.title,pr.name,cl.display_name,wp.owner_id,o.display_name,wp.due_on,wp.set_up_at
   having count(t.id) filter(where ${OPEN})>0 or (wp.set_up_at is not null and count(t.id) filter(where ${FINISHED})<count(t.id) filter(where t.status<>'cancelled'))`, [day.d, everyone && !pod, pod])).rows
    .map((p) => {
      const pct = p.total ? Math.round(100 * p.finished / p.total) : 0;
      const soon = p.nextDue && Date.parse(p.nextDue) - Date.parse(day.d) <= 7 * 86400000;
      const late = p.dueOn && p.dueOn < day.d && p.open > 0;
      const risk = p.overdue ? `${p.overdue} overdue` : p.blocked ? `${p.blocked} blocked` : late ? 'Past its due date' : soon && pct < 60 ? `${pct}% done, due soon` : null;
      return { ...p, percent: pct, atRisk: !!risk, risk };
    }).sort((a, b) => Number(b.atRisk) - Number(a.atRisk) || String(a.nextDue ?? '9999').localeCompare(String(b.nextDue ?? '9999')) || b.open - a.open);
  // Who needs help: overdue work piling up, blocked for days, or carrying far more than the team.
  const opens = workload.map((w) => w.open as number).filter((n) => n > 0).sort((a, b) => a - b);
  const median = opens.length ? opens[Math.floor(opens.length / 2)] : 0;
  const waitedOn = new Map<string, number>(); for (const w of waits) { const k = String((w as Row).waitingOwner ?? ''); waitedOn.set(k, (waitedOn.get(k) ?? 0) + 1); }
  const help = workload.flatMap((w) => {
    const reasons: string[] = [];
    if ((w.overdue as number) >= 2) reasons.push(`${w.overdue} overdue`);
    if ((w.blocked as number) >= 1) reasons.push(`${w.blocked} blocked`);
    if ((w.open as number) >= Math.max(8, median * 2)) reasons.push(`${w.open} open, about ${Math.round((w.open as number) / Math.max(1, median))}× the team’s usual`);
    return reasons.length ? [{ id: w.id, name: w.name, pod: w.pod, photoAt: w.photoAt, reasons, score: (w.overdue as number) * 3 + (w.blocked as number) * 2 + (w.open as number) / Math.max(1, median) }] : [];
  }).sort((a, b) => b.score - a.score).slice(0, 6);
  // UX-TASKS-2, the leader's view: hours from task time (outcome-based people included), work accepted by someone else
  // (one per task, never points: INTEGRITY 0910), what each person is on now; rolled up by pod and department with eight
  // weeks of output.
  const extra = new Map((await run(`select s.id,pp.department,pulse.work_mode(s.id) "workMode",
    coalesce((select sum(e.minutes) from pulse.time_entry e where e.person_id=s.id and e.status='confirmed' and e.retired_at is null and e.work_date between $1::date and $2::date),0)::int minutes,
    coalesce((select sum(e.minutes) from pulse.time_entry e where e.person_id=s.id and e.status='proposed' and e.retired_at is null and e.work_date between $1::date and $2::date),0)::int proposed,
    (select count(*) from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=s.id and t.status='accepted' and t.deleted_at is null and t.accepted_by is not null and t.accepted_by<>s.id and (t.accepted_at at time zone ${ORG_TZ})::date between $1::date and $2::date)::int value,
    (select count(*) from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=s.id and t.status='accepted' and t.deleted_at is null and t.accepted_by is not null and t.accepted_by<>s.id and (t.accepted_at at time zone ${ORG_TZ})::date>=$1::date-49)::int "value8",
    coalesce((select sum(t.estimate_minutes) from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=s.id and ${OPEN}),0)::int "estimateOpen",
    (select jsonb_build_object('id',t.id,'title',t.title) from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=s.id and t.status='in_progress' order by t.started_at desc nulls last limit 1) now
   from work_scope s left join pulse.people_profile pp on pp.person_id=s.id`, [day.w, weekEnd])).rows.map((r) => [r.id as string, r]));
  const people2 = workload.map((w) => ({ ...w, ...(extra.get(w.id as string) ?? {}) })) as (Row & { open: number; doing: number; overdue: number; doneWeek: number; minutes: number; proposed: number; value: number; value8: number; estimateOpen: number })[];
  const valueTotals = (await run(`select count(*) filter(where (t.accepted_at at time zone ${ORG_TZ})::date between $1::date and $2::date)::int week,count(*) filter(where (t.accepted_at at time zone ${ORG_TZ})::date between $1::date-7 and $1::date-1)::int "lastWeek"
   from work_scope s join pulse.task t on coalesce(t.assignee_person_id,t.owner_id)=s.id and t.status='accepted' and t.deleted_at is null and t.accepted_by is not null and t.accepted_by<>s.id and (t.accepted_at at time zone ${ORG_TZ})::date>=$1::date-7`, [day.w, weekEnd])).rows[0];
  const series = async (key: 'pod' | 'department') => {
    const done = (await run(`select date_trunc('week',coalesce(t.done_at,t.work_on::timestamptz) at time zone ${ORG_TZ})::date::text week,coalesce(pp.${key},'') g,count(*)::int n
     from pulse.task t join work_scope s on s.id=coalesce(t.assignee_person_id,t.owner_id) left join pulse.people_profile pp on pp.person_id=s.id
     where ${FINISHED} and coalesce(t.done_at,t.work_on::timestamptz)>=($1::date-49)::timestamp at time zone ${ORG_TZ} group by 1,2`, [day.w])).rows;
    const value = (await run(`select date_trunc('week',(t.accepted_at at time zone ${ORG_TZ})::date)::date::text week,coalesce(pp.${key},'') g,count(*)::int n from work_scope s join pulse.task t on coalesce(t.assignee_person_id,t.owner_id)=s.id and t.status='accepted' and t.deleted_at is null and t.accepted_by is not null and t.accepted_by<>s.id
     and (t.accepted_at at time zone ${ORG_TZ})::date>=$1::date-49 left join pulse.people_profile pp on pp.person_id=s.id group by 1,2`, [day.w])).rows;
    const weeks = throughput.map((w) => String(w.week));
    const names = [...new Set(people2.map((p) => String(p[key] ?? '')))];
    return names.map((g) => {
      const mine = people2.filter((p) => String(p[key] ?? '') === g);
      const sum = (k: 'open' | 'doing' | 'overdue' | 'doneWeek' | 'minutes' | 'proposed' | 'value' | 'estimateOpen') => mine.reduce((n, p) => n + (Number(p[k]) || 0), 0);
      return { name: g || (key === 'pod' ? 'No pod' : 'No team'), people: mine.length, open: sum('open'), doing: sum('doing'), overdue: sum('overdue'), doneWeek: sum('doneWeek'),
        minutes: sum('minutes'), proposed: sum('proposed'), value: sum('value'), estimateOpen: sum('estimateOpen'),
        weeks: weeks.map((wk) => ({ week: wk, done: done.find((d) => d.week === wk && d.g === g)?.n ?? 0, value: value.find((d) => d.week === wk && d.g === g)?.n ?? 0 })) };
    }).sort((a, b) => b.value - a.value || b.doneWeek - a.doneWeek || b.open - a.open || a.name.localeCompare(b.name));
  };
  const groups = { pod: await series('pod'), department: await series('department') };
  const group = q.group === 'pod' || q.group === 'department' ? q.group : 'person';
  // The ten things to act on today.
  const asks = (await c.query(`select ${ASK} from ${ASK_FROM} where a.to_id=$1 and a.status='pending' order by a.created_at limit 5`, [me])).rows.map((a) => askCard(a, me));
  const review = (await c.query(`select ${TASK} from ${FROM} where t.review_owner_id=$1 and t.status in ('done','in_review') and coalesce(t.assignee_person_id,t.owner_id) is distinct from $1 order by t.done_at nulls last limit 5`, [me])).rows;
  const overdue = (await run(`select ${TASK} from ${FROM} join work_scope s on s.id=coalesce(t.assignee_person_id,t.owner_id) where ${OPEN} and ${DUE}<$1::date
    order by t.priority='urgent' desc,t.priority='high' desc,t.due_at limit 6`, [day.d])).rows;
  const unowned = (await c.query(`select ${TASK} from ${FROM} where ${OPEN} and t.assignee_person_id is null and t.owner_id is null and ${DUE}<=$1::date+2 and t.project_id is not null
    and ($2::boolean or pulse.work_project_in(t.project_id)) order by t.due_at limit 4`, [day.d, everyone])).rows;
  const pending = everyone ? (await c.query("select count(*)::int n from pulse.work_review where status='pending'")).rows[0].n : 0;
  const daysSince = (iso: unknown) => Math.max(0, Math.round((Date.parse(`${day.d}T12:00:00Z`) - Date.parse(String(iso))) / 86400000));
  const daysLate = (d: unknown) => Math.max(1, Math.round((Date.parse(day.d) - Date.parse(String(d))) / 86400000));
  const first = (n: unknown) => String(n ?? '').split(' ')[0];
  const act: { kind: string; title: string; detail: string; href: string; action: string; score: number }[] = [
    // One line per request or review while there are a few; a single grouped line when they pile up.
    ...(asks.length <= 2 ? asks.map((a) => ({ kind: 'ask', title: String(a.title), detail: a.note ? `“${a.note}”` : 'Waiting for your answer', href: String(a.href), action: 'Answer', score: 100 }))
      : [{ kind: 'ask', title: `${asks.length}${asks.length === 5 ? '+' : ''} requests wait for your answer`, detail: `Oldest: ${asks[0].title}`, href: '/tasks?view=me#asks', action: 'Answer', score: 100 }]),
    ...(review.length <= 2 ? review.map((t) => ({ kind: 'review', title: `Accept “${t.title}”`, detail: `${first(t.assigneeName) || 'Someone'} finished it${t.doneAt ? ` ${daysSince(t.doneAt) ? `${daysSince(t.doneAt)} days ago` : 'today'}` : ''}`, href: `/tasks/${t.id}`, action: 'Review', score: 90 }))
      : [{ kind: 'review', title: `Accept ${review.length}${review.length === 5 ? '+' : ''} finished tasks`, detail: `Oldest: “${review[0].title}” by ${first(review[0].assigneeName) || 'someone'}${review[0].doneAt ? `, ${daysSince(review[0].doneAt)} days ago` : ''}`, href: '/tasks?view=me&tab=today', action: 'Review', score: 90 }]),
    ...overdue.map((t) => ({ kind: 'overdue', title: `“${t.title}” is ${daysLate(t.dueOn)} day${daysLate(t.dueOn) === 1 ? '' : 's'} late`, detail: `${t.assigneeName ?? 'Nobody'}${t.projectName ? ` · ${t.projectName}` : ''}`, href: `/tasks/${t.id}`, action: 'Open', score: 70 + (t.priority === 'urgent' ? 15 : t.priority === 'high' ? 8 : 0) + Math.min(10, daysLate(t.dueOn)) })),
    ...[...blockers.values()].slice(0, 3).map((b) => ({ kind: 'blocked', title: `${b.waiting.length} task${b.waiting.length === 1 ? '' : 's'} waiting on ${b.ownerName}`, detail: `“${b.waiting[0].blockerTitle}” ${daysSince(b.oldest) ? `for ${daysSince(b.oldest)} day${daysSince(b.oldest) === 1 ? '' : 's'}` : 'since today'}`, href: `/tasks/${b.waiting[0].blockerId}`, action: 'Nudge', score: 60 + Math.min(20, daysSince(b.oldest)) })),
    ...unowned.map((t) => ({ kind: 'unowned', title: `Nobody has “${t.title}”`, detail: `Due ${t.dueOn === day.d ? 'today' : dayLabel(t.dueOn, day.d)}${t.projectName ? ` · ${t.projectName}` : ''}`, href: `/tasks/${t.id}`, action: 'Assign', score: 65 })),
    ...clientWork.filter((p) => p.atRisk).slice(0, 3).map((p) => ({ kind: 'risk', title: `${p.name} is at risk`, detail: `${p.risk}${p.nextDue ? ` · next due ${dayLabel(p.nextDue, day.d)}` : ''}`, href: `/tasks/projects/${p.id}`, action: 'Open', score: 55 + (p.overdue as number) })),
    ...(totals.untriaged && everyone ? [{ kind: 'tidy', title: `${totals.untriaged} tracker tasks have no status`, detail: 'Give each To do, Doing or Done once; Pulse keeps your choice', href: '/tasks?view=all&status=unknown', action: 'Tidy up', score: 20 }] : []),
    ...(pending ? [{ kind: 'file', title: `File ${pending} client project${pending === 1 ? '' : 's'} without a client`, detail: 'One click each: client package, or internal work', href: '/tasks/projects?review=1', action: 'Review', score: 25 }] : []),
  ].sort((a, b) => b.score - a.score).slice(0, 10);
  return { today: day.d, week: day.w, weekEnd, role: role.r, roleLabel: ROLE_LABEL[role.r], pods, pod, department: q.department ?? null, scope: q.department ? (q.department || 'No team') : pod ?? (everyone ? 'Everyone' : (role.pods as string[]).join(' & ') || 'Your team'),
    totals: { ...totals, minutes: people2.reduce((n, p) => n + p.minutes, 0), proposed: people2.reduce((n, p) => n + p.proposed, 0), value: valueTotals.week, valueLastWeek: valueTotals.lastWeek },
    workload: people2, groups, group, labels: (await workSettings(c)).labels,
    throughput, blockers: [...blockers.values()].sort((a, b) => b.waiting.length - a.waiting.length).slice(0, 6), manualBlocked: manualBlocked.length,
    clientWork: clientWork.slice(0, 12), clientCount: clientWork.length, atRisk: clientWork.filter((p) => p.atRisk).length, help, act };
}

/** Create a task in a few fields. Inside the person's domains (or within Who can do what, before anyone agreed
 *  domains) they get it at once and are told; otherwise they are asked (a request to join) and it stays the creator's
 *  until they accept. With nobody chosen and a pool, it goes to the pool. Pip's suggestion is kept beside it. Used by
 *  + Create, the quick-add line and every other place that makes a task. */
export async function createWorkTask(c: PoolClient, v: Viewer, b: Body) {
  const me = person(v);
  const pb = b.pool && typeof b.pool === 'object' ? b.pool as Body : null;
  const pool = pb ? { scope: str(pb.scope, 20), ref: str(pb.ref, 80) || null } : null;
  const assignee = pool ? null : optId(b.assigneeId) ?? me;
  const projectId = optId(b.projectId);
  const tags = Array.isArray(b.tags) ? [...new Set(b.tags.map((x) => str(x, 40)).filter(Boolean))] : [];
  // CONNECT 2: a connected organisation's contact gets the task through the connection (shared with them, reviewed by
  // the giver); a chat card follows when it was made from a chat.
  const contact = assignee && assignee !== me && (await c.query('select side from pulse.person where id=$1', [assignee])).rows[0]?.side !== 'staff'
    ? (await connectedContacts(c, v)).find((x) => x.id === assignee) : undefined;
  if (contact) return giveToContact(c, b, contact);
  const category = str(b.category, 40) || (await c.query('select pulse.work_category_guess($1) k', [str(b.title)])).rows[0].k;
  // CHAT-WORK: an AI employee the viewer may give work to takes it at once (no request; its runtime starts on it).
  const toAgent = !!assignee && assignee !== me && (await c.query('select pulse.agent_takes_tasks($1) ok', [assignee])).rows[0].ok === true;
  const mode = toAgent ? { mode: 'direct', why: 'ai_employee' } : assignee && assignee !== me ? (await c.query('select pulse.work_assign_mode($1,$2,$3,$4) m', [assignee, projectId, category, tags])).rows[0].m : { mode: assignee ? 'self' : 'pool' };
  const direct = !assignee || ['self', 'direct'].includes(mode.mode);
  // TASKS-4A: a due time is optional; with one, the task is due at that moment (dueAt, with its offset), else at 18:00 on the company's clock.
  const dueAt = b.dueAt ? (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(String(b.dueAt)) && !Number.isNaN(Date.parse(String(b.dueAt))) ? String(b.dueAt) : fail(400, 'Choose a valid due time')) : null;
  const fields: Body = { title: str(b.title), assigneeId: pool ? null : direct ? assignee : me, projectId, dueOn: dueAt ? null : day(b.dueOn), ...(dueAt ? { dueAt } : {}), priority: str(b.priority, 10) || 'normal', category, tags };
  if (pool) fields.pool = pool;
  if (b.urgency) fields.urgency = str(b.urgency, 10);
  if (b.estimateMinutes !== undefined && b.estimateMinutes !== null && b.estimateMinutes !== '') fields.estimateMinutes = Number(b.estimateMinutes);
  if (b.reviewerId) fields.reviewerId = id(b.reviewerId);
  if (b.parentId) fields.parentId = id(b.parentId);
  if (b.notes) fields.notes = noteText(b.notes);
  // CHATS-2: made from a chat message. The task links back to the message, its card goes into the conversation
  // quoting it, and (when its owner opts in) the task's updates follow into that chat.
  const chat = optId(b.chatChannelId), from = chat ? optId(b.chatMessageId) : null;
  let fromFiles: Row[] = [];
  if (from) {
    const m = (await c.query("select left(regexp_replace(m.body,'\\s+',' ','g'),400) body,p.display_name name,m.attachments from pulse.chat_message m join pulse.person p on p.id=m.author_id where m.id=$1 and m.channel_id=$2 and m.removed_at is null", [from, chat])).rows[0];
    if (!m) fail(404, 'That message is no longer in the chat');
    // CHAT-WORK: an attachment becomes a task too; its files stay in the chat (members only) and the task names them.
    fromFiles = (Array.isArray(m.attachments) ? m.attachments as Row[] : []).filter((a) => !a.task);
    const files = fromFiles.map((a) => `• ${String(a.name ?? 'File').slice(0, 120)}${a.url ? ` (${String(a.url).slice(0, 300)})` : ''}`);
    const fromChat = `${m.body ? `“${m.body}” — ${m.name}\n` : ''}${files.length ? `Attached in the chat:\n${files.join('\n')}\n` : ''}From Chats: /chats?channel=${chat}&message=${from}`;
    // DATUP-TASKS: details typed while making it come first; the chat it came from stays named under them.
    fields.notes = fields.notes ? `${fields.notes}\n\n${fromChat}` : fromChat;
  }
  const task = (await c.query('select pulse.task_save(null,$1) id', [JSON.stringify(fields)])).rows[0].id as string;
  // J3: the message's files and links go onto the task itself (its files), each on its own: one the task cannot hold
  // (a type it does not take) stays named in the notes and in the chat.
  const filed: string[] = [];
  for (const a of fromFiles.slice(0, 5)) {
    await c.query('savepoint chat_file_to_task');
    try {
      if (a.id) {
        const f = (await c.query('select name,mime,bytes from pulse.chat_file_read($1)', [String(a.id)])).rows[0];
        if (f) { await c.query('select pulse.task_attachment_add($1,$2,null,$3,$4,$5)', [task, `From the chat: ${String(f.name).slice(0, 180)}`, f.bytes, f.name, f.mime]); filed.push(String(f.name)); }
      } else if (a.url) { await c.query('select pulse.task_attachment_add($1,$2,$3)', [task, String(a.name ?? 'Link').slice(0, 200), String(a.url)]); filed.push(String(a.name ?? a.url)); }
      await c.query('release savepoint chat_file_to_task');
    } catch { await c.query('rollback to savepoint chat_file_to_task'); }
  }
  const ask = direct ? null : (await c.query("select pulse.work_ask_create('take',$1,null,$2,$3) id", [task, assignee, str(b.note, 500) || null])).rows[0].id as string;
  const to = !assignee || assignee === me ? null : (await c.query('select display_name name from pulse.person where id=$1', [assignee])).rows[0]?.name ?? null;
  if (chat) {
    const card = (await c.query('select pulse.chat_send($1,$2,null,$3,gen_random_uuid(),$4) id', [chat, '', JSON.stringify([{ task, name: str(fields.title), url: `/tasks/${task}` }]), from])).rows[0].id as string;
    if (b.chatFollow === true) await c.query('select pulse.chat_task_follow_set($1,$2,true)', [task, chat]);
    // CHAT-WORK: the person it went to answers on the card (take it, decline, ask a question).
    if (assignee && assignee !== me) await c.query('select pulse.chat_task_handshake_open($1,$2,$3,$4)', [task, chat, card, assignee]);
  }
  // Pip's suggestion (importance and effort, never a value: INTEGRITY 0910) kept beside the task; importance set up front
  // by whoever may set it.
  const canValue = (await c.query('select pulse.work_can_value($1) ok', [task])).rows[0].ok as boolean;
  const { category: _cat, categoryLabel: _label, ...suggestion } = await suggestFor(c, v, { title: str(b.title), category, projectId, dueOn: dueAt ? dueAt.slice(0, 10) : day(b.dueOn), priority: str(b.priority, 10) || null });
  void _cat; void _label;
  const kept = (await c.query('select pulse.task_suggestion_save($1,$2) r', [task, JSON.stringify(suggestion)])).rows[0].r;
  let valued: Row | null = null;
  if (canValue && (b.useSuggestion === true || b.importance)) {
    const p: Body = b.useSuggestion === true ? { useSuggestion: true } : {};
    if (b.importance) p.importance = str(b.importance, 10);
    valued = (await c.query('select pulse.task_value_set($1,$2) r', [task, JSON.stringify(p)])).rows[0].r;
  }
  return { id: task, assigned: direct && !!assignee && assignee !== me, asked: ask ? { id: ask, to } : null, assigneeName: direct ? to : null, pooled: pool, filed,
    mode, category, suggestion, applied: kept.applied, valued, canValue };
}

/** CONNECT 2: a new task for a connected organisation's contact, from the ordinary Create form or a chat. */
async function giveToContact(c: PoolClient, b: Body, contact: { id: string; name: string; org: string; connectionId: string }) {
  if (b.pool) fail(400, 'A task for a connected organisation goes to one of their contacts, not a pool');
  const dueOn = b.dueAt ? String(b.dueAt).slice(0, 10) : day(b.dueOn);
  const task = (await c.query('select pulse.connect_task_give($1,$2) id', [contact.connectionId, JSON.stringify({ title: str(b.title), notes: b.notes ? noteText(b.notes) : '', dueOn, assigneeId: contact.id })])).rows[0].id as string;
  const chat = optId(b.chatChannelId), from = chat ? optId(b.chatMessageId) : null;
  if (chat) await c.query('select pulse.chat_send($1,$2,null,$3,gen_random_uuid(),$4) id', [chat, '', JSON.stringify([{ task, name: str(b.title), url: `/tasks/${task}` }]), from]);
  return { id: task, assigned: true, asked: null, assigneeName: contact.name, pooled: null, filed: [], mode: { mode: 'direct', why: 'connection', org: contact.org }, connection: { id: contact.connectionId, org: contact.org },
    category: null, suggestion: null, applied: false, valued: null, canValue: false };
}

/** Give an existing task to someone: at once when the rules allow it, else a request they accept or decline. Never an
 *  error just because the person is outside the giver's reach (the owner's "nothing is working"). */
export async function assignOrAsk(c: PoolClient, v: Viewer, taskId: string, personId: string | null, note: string | null) {
  const me = person(v);
  const t = (await c.query('select id,title,project_id,category,tags,coalesce(assignee_person_id,owner_id) doer from pulse.task where id=$1', [taskId])).rows[0] ?? fail(404, 'Task not found');
  if (!personId) { await c.query('select pulse.task_save($1,$2)', [taskId, JSON.stringify({ assigneeId: null })]); return { assigned: false, asked: null, assigneeName: null }; }
  if (personId === t.doer) return { assigned: true, asked: null, assigneeName: null, unchanged: true };
  const name = (await c.query('select display_name name from pulse.person where id=$1', [personId])).rows[0]?.name ?? null;
  const mode = personId === me ? { mode: 'self' } : (await c.query('select pulse.work_assign_mode($1,$2,$3,$4) m', [personId, t.project_id, t.category, t.tags ?? []])).rows[0].m;
  if (['self', 'direct'].includes(mode.mode)) {
    await c.query('select pulse.task_save($1,$2)', [taskId, JSON.stringify({ assigneeId: personId })]);
    return { assigned: true, asked: null, assigneeName: name, mode };
  }
  if (mode.mode === 'request') {
    const pending = (await c.query("select id from pulse.work_ask where task_id=$1 and to_id=$2 and kind='take' and status='pending'", [taskId, personId])).rows[0];
    const ask = pending?.id ?? (await c.query("select pulse.work_ask_create('take',$1,null,$2,$3) id", [taskId, personId, note])).rows[0].id;
    return { assigned: false, asked: { id: ask, to: name }, assigneeName: null, mode };
  }
  // AI-TASKS: an AI employee takes work from its manager, leaders and whoever may give its pod work (agent_takes_tasks).
  if (mode.why === 'ai_employee') return fail(403, `${String(name ?? 'This AI employee')} takes tasks from its manager, leaders and whoever may give its pod work, and only while its Tasks tool is on.`);
  return fail(403, `Your role does not reach ${String(name ?? 'them').split(' ')[0]}. HR can change this in Settings → Who can do what.`);
}
