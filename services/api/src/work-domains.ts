import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, hr, leadership, type Tx, type Viewer } from './routes.js';
import { FROM, TASK } from './tasks.js';
import { taskScorer, type Suggestion } from './ai/task-scorer.js';
import { MODELS, workLabels } from './work-model.js';
import { connectedContacts } from './connect-contacts.js';

/** UX-TASKS-2: the company's work settings, responsibility domains, the pool, value, what a client project includes,
 *  and the person view leaders drill into. Who may do what is decided in the database (0153–0155); these routes shape
 *  it for the screens. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const optId = (x: unknown) => x === undefined || x === null || x === '' ? null : id(x);
const str = (x: unknown, max = 300) => String(x ?? '').trim().slice(0, max);
const strs = (x: unknown, max = 40) => Array.isArray(x) ? [...new Set(x.map((v) => str(v, max)).filter(Boolean))] : [];
const body = { type: 'object' } as const;
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use Work');
const PHOTO = (alias: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${alias}.id)`;
const OPEN = `t.status in ('open','in_progress','blocked')`;
const TODAY = `(now() at time zone ${ORG_TZ})::date`;
const first = (n: unknown) => String(n ?? 'Someone').replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, '').split(' ')[0];

async function today(c: PoolClient) {
  return (await c.query(`select ${TODAY}::text d,date_trunc('week',now() at time zone ${ORG_TZ})::date::text w`)).rows[0] as { d: string; w: string };
}
export async function workSettings(c: PoolClient) {
  const s = (await c.query('select pulse.work_settings_get() s')).rows[0].s;
  return { ...s, labels: workLabels(s.businessModel, s.teamLabel) };
}
export async function categories(c: PoolClient) {
  // A company gets the shared kinds of work on first use (0156); reading them for a screen counts.
  await c.query('select pulse.work_category_ensure()');
  return (await c.query('select key,label,active,position from pulse.work_category order by position,label')).rows as { key: string; label: string; active: boolean }[];
}

/** INTEGRITY (0910, owner 22 Oct 2026): a task carries no value. Pip's suggestion keeps importance, effort and why;
 *  never value points, the points each signal added, or a priority worked out from them. */
export type PublicSuggestion = Omit<Suggestion, 'valuePoints' | 'breakdown' | 'priority'>;
export function withoutValue<T extends Suggestion>(s: T): Omit<T, 'valuePoints' | 'breakdown' | 'priority'> {
  const { valuePoints: _v, breakdown: _b, priority: _p, ...rest } = s; void _v; void _b; void _p;
  return { ...rest, basis: rest.basis.filter((b) => !/\bpoints?\b|\bvalued\b/i.test(b)) };
}

/** Pip's suggestion: importance and effort with a one-line reason (no value: withoutValue). */
export async function suggestFor(c: PoolClient, v: Viewer, x: { title: string; category?: string | null; projectId?: string | null; dueOn?: string | null; priority?: string | null;
  /** TASKS-4B: an existing task (what waits on it counts) and the estimate someone gave. */ taskId?: string | null; estimateMinutes?: number | null }): Promise<PublicSuggestion & { category: string | null; categoryLabel: string | null }> {
  const day = await today(c);
  const category = x.category || (await c.query('select pulse.work_category_guess($1) k', [x.title])).rows[0].k as string | null;
  const label = category ? (await c.query('select label from pulse.work_category where key=$1', [category])).rows[0]?.label ?? null : null;
  const project = x.projectId ? (await c.query(`select coalesce(pr.title,pr.name) name,wp.kind,pulse.work_package_band(pr.id) band from pulse.project pr left join pulse.work_project wp on wp.project_id=pr.id
   where pr.id=$1`, [x.projectId])).rows[0] ?? null : null;
  const sim = (await c.query('select pulse.work_similar_effort($1,$2) s', [category, x.title])).rows[0].s;
  // TASKS-4B: what waits on it and how estimates ran; never a value (INTEGRITY 0910).
  const unlocks = x.taskId ? (await c.query(`select count(*)::int tasks,0 value
    from pulse.task_link l join pulse.task w on w.id=l.task_id where l.blocker_id=$1 and l.cleared_at is null and w.status in ('open','in_progress','blocked','unknown')`, [x.taskId])).rows[0] : null;
  const learnt = (await c.query('select pulse.work_estimate_calibration() k')).rows[0];
  const s = await taskScorer().suggest({ title: x.title, category, categoryLabel: label, priority: x.priority ?? null, dueOn: x.dueOn ?? null, today: day.d,
    project: project ? { name: project.name, kind: project.kind ?? null, packageBand: project.band ?? null } : null,
    similar: sim && sim.n ? { n: sim.n, minutes: sim.minutes, minutesN: sim.minutesN, cycleDays: sim.cycleDays, value: null, points: null } : null,
    estimateMinutes: x.estimateMinutes ?? null, unlocks, baseline: null, learning: null,
    calibration: learnt.k?.n ? { n: learnt.k.n, ratio: learnt.k.ratio === null ? null : Number(learnt.k.ratio) } : null });
  // The package's value band is leadership's: others see "client work" without it.
  if (!leadership(v)) s.basis = s.basis.map((b) => b.replace(/ \(package in the \w+ quarter by value\)/, ''));
  return { ...withoutValue(s), category, categoryLabel: label };
}

type Domain = { id: string; title: string; basis: string; categories: string[]; tags: string[]; pod: string | null; project_id: string | null; client_id: string | null };
/** "In your domain": the viewer's active domains matched against task rows in one pass (the same rule as
 *  pulse.work_domain_match, with a project's tags, pod and client, and the client projects it is linked under). */
export async function markDomains<T extends Row>(c: PoolClient, me: string | null, rows: T[]): Promise<(T & { inDomain: { id: string; title: string; basis: string } | null })[]> {
  const out = rows.map((r) => ({ ...r, inDomain: null as { id: string; title: string; basis: string } | null }));
  if (!me || !rows.length) return out;
  const doms = (await c.query(`select id,title,basis,categories,tags,pod,project_id,client_id from pulse.work_domain where person_id=$1 and status='active'
   and coalesce(effective_from,'-infinity')<=${TODAY} order by basis='policy' desc,created_at`, [me])).rows as Domain[];
  if (!doms.length) return out;
  const pids = [...new Set(rows.map((r) => r.projectId as string | null).filter(Boolean))] as string[];
  const info = new Map<string, { served: string[]; pods: string[]; clients: string[]; tags: string[] }>();
  if (pids.length) {
    const rs = (await c.query(`select p.id,wp.tags,array_remove(array[p.id]||array_agg(l.client_project_id),null) served,
      array_remove(array[wp.pod]||array_agg(lw.pod),null) pods,array_remove(array[p.client_id]||array_agg(lp.client_id),null) clients
     from pulse.project p left join pulse.work_project wp on wp.project_id=p.id left join pulse.work_project_link l on l.project_id=p.id and l.status='linked'
     left join pulse.work_project lw on lw.project_id=l.client_project_id left join pulse.project lp on lp.id=l.client_project_id where p.id=any($1) group by p.id,wp.tags,wp.pod,p.client_id`, [pids])).rows;
    for (const r of rs) info.set(r.id, { served: r.served, pods: r.pods, clients: r.clients, tags: r.tags ?? [] });
  }
  for (const r of out) {
    const p = r.projectId ? info.get(r.projectId as string) : undefined;
    const tags = [...((r.tags as string[] | undefined) ?? []), ...(p?.tags ?? [])];
    const d = doms.find((d) => (!d.categories.length || d.categories.includes(String(r.category))) && (!d.tags.length || d.tags.some((t) => tags.includes(t)))
      && (!d.pod || !!p?.pods.includes(d.pod)) && (!d.project_id || !!p?.served.includes(d.project_id)) && (!d.client_id || !!p?.clients.includes(d.client_id)));
    if (d) r.inDomain = { id: d.id, title: d.title, basis: d.basis };
  }
  return out;
}

const DOMAIN = `d.id,d.person_id "personId",d.title,d.basis,d.categories,d.tags,d.pod,d.project_id "projectId",coalesce(pr.title,pr.name) "projectName",d.client_id "clientId",cl.display_name "clientName",
 d.note,d.status,d.proposed_side "proposedSide",d.proposed_by "proposedById",pb.display_name "proposedBy",d.effective_from::text "effectiveFrom",d.agreed_on::text "agreedOn",
 d.company_agreed_by "companyAgreedById",ca.display_name "companyAgreedBy",d.answer_note "answerNote",d.ended_at "endedAt",eb.display_name "endedBy",d.end_note "endNote",d.created_at "createdAt",
 (select coalesce(jsonb_agg(c.label order by c.position),'[]') from pulse.work_category c where c.key=any(d.categories)) "categoryLabels"`;
const DOMAIN_FROM = `pulse.work_domain d left join pulse.project pr on pr.id=d.project_id left join pulse.client cl on cl.id=d.client_id left join pulse.person pb on pb.id=d.proposed_by
 left join pulse.person ca on ca.id=d.company_agreed_by left join pulse.person eb on eb.id=d.ended_by`;
/** The buttons a viewer has on one domain. */
async function domainActions(c: PoolClient, me: string, d: Row) {
  const company = (await c.query('select pulse.work_domain_company($1) ok', [d.personId])).rows[0].ok as boolean;
  const policyMaker = me !== d.personId && (await c.query("select pulse.viewer_is('admin','leadership','hr') ok")).rows[0].ok as boolean;
  const acts: { key: string; label: string; tone: 'primary' | 'neutral' | 'danger'; path: string; fields?: { key: string; label: string; type: 'text' }[]; done: string }[] = [];
  if (d.status === 'proposed') {
    if ((d.proposedSide === 'company' && me === d.personId) || (d.proposedSide === 'employee' && company)) acts.push(
      { key: 'accept', label: 'Agree', tone: 'primary', path: `/api/v0/work/domains/${d.id}/accept`, done: 'Agreed' },
      { key: 'decline', label: 'Decline', tone: 'neutral', path: `/api/v0/work/domains/${d.id}/decline`, fields: [{ key: 'note', label: 'A short reason (optional)', type: 'text' }], done: 'Declined' });
    if (d.proposedById === me) acts.push({ key: 'withdraw', label: 'Withdraw', tone: 'neutral', path: `/api/v0/work/domains/${d.id}/withdraw`, done: 'Withdrawn' });
  } else if (d.status === 'active' && ((d.basis === 'policy' && policyMaker) || (d.basis === 'agreement' && (me === d.personId || company)))) {
    acts.push({ key: 'end', label: 'End', tone: 'danger', path: `/api/v0/work/domains/${d.id}/end`, fields: [{ key: 'note', label: 'Why it ends', type: 'text' }], done: 'Ended' });
  }
  return acts;
}

/** The notification panel's card for a domain proposal, answer, policy or ending. */
export async function domainNotice(c: PoolClient, me: string, n: Row, state: string) {
  const d = (await c.query(`select ${DOMAIN} from ${DOMAIN_FROM} where d.id=$1`, [n.subjectId])).rows[0];
  if (!d) return {};
  const actions = n.eventType === 'domain.proposed' ? (await domainActions(c, me, d)).filter((a) => a.key === 'accept' || a.key === 'decline').map((a) => ({ ...a, method: 'POST' as const })) : [];
  return { subject: { type: 'domain', id: d.id, title: d.title, personId: d.personId }, from: { id: d.proposedById, name: d.proposedBy, photoAt: null }, body: d.answerNote ?? d.endNote ?? d.note ?? null,
    actions, state: d.status === 'proposed' ? state : ({ active: 'accepted', declined: 'declined', withdrawn: 'withdrawn', ended: 'done' } as Record<string, string>)[String(d.status)] ?? state };
}

/** Domains a person seems to carry already, from the work they finished (and the trackers PEOPLE-LIVE read), for one
 *  click to propose. Never created on their own. */
async function domainSuggestions(c: PoolClient, who: string, existing: Row[]) {
  const rows = (await c.query(`with done as (select t.category,wp.pod from pulse.task t left join pulse.work_project wp on wp.project_id=t.project_id
     where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status in ('done','accepted','in_review') and t.category is not null and coalesce(t.done_at,t.updated_at)>now()-interval '240 days'),
   tot as (select count(*) n from done)
   select d.category,c.label,count(*)::int n,round(100.0*count(*)/nullif((select n from tot),0))::int share,mode() within group(order by d.pod) pod,
    (select pod from pulse.people_profile where person_id=$1) "ownPod"
   from done d join pulse.work_category c on c.key=d.category group by d.category,c.label having count(*)>=5 order by 3 desc limit 4`, [who])).rows;
  const trackers = (await c.query(`select distinct group_label from pulse.people_work_link where person_id=$1 and kind in ('task','project') and status in ('accepted','suggested') and retired_at is null
   and group_label is not null limit 12`, [who])).rows.map((r) => String(r.group_label));
  return rows.filter((r) => r.share >= 15 && !existing.some((d) => ['active', 'proposed'].includes(String(d.status)) && (d.categories as string[]).includes(r.category)))
    .map((r) => {
      const pod = r.pod ?? r.ownPod ?? null;
      const words = String(r.label).toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const tracker = trackers.find((t) => words.some((w) => t.toLowerCase().includes(w.slice(0, 5))));
      return { title: `${r.label}${pod ? ` for ${pod} clients` : ''}`, categories: [r.category], pod,
        evidence: [`${r.n} ${String(r.label).toLowerCase()} tasks finished in the last eight months (${r.share}% of their finished work)`, ...(tracker ? [`Their tracker “${tracker}”`] : [])] };
    });
}

export function registerWorkDomainRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // Company work settings: the business model names things; Pip's low-value automatic acceptance.
  app.get('/api/v0/work/settings', req => tx(req, async (c) => ({ ...(await workSettings(c)), models: MODELS, categories: await categories(c) })));
  app.post<{ Body: Body }>('/api/v0/work/settings', { schema: { body } }, req => tx(req, async (c) => {
    const b = req.body; const p: Body = {};
    if ('businessModel' in b) p.businessModel = str(b.businessModel, 20);
    if ('aiAutoAcceptMax' in b) p.aiAutoAcceptMax = b.aiAutoAcceptMax === null || b.aiAutoAcceptMax === '' ? null : Number(b.aiAutoAcceptMax);
    if ('teamLabel' in b) p.teamLabel = str(b.teamLabel, 20);
    // TASKS-4B: how reviews work (docs/ops/VALUE.md): who reviews, the rating scale, leadership's work, bonus, help, nudge.
    for (const k of ['reviewBy', 'reviewScale', 'reviewLeaders']) if (k in b) p[k] = str(b[k], 20);
    // UX-5B: whether Pulse finishes a task by itself when every confirmed signal has happened ("on") or asks ("ask").
    if ('autoDone' in b) p.autoDone = str(b.autoDone, 10);
    for (const k of ['aboveBonus', 'helpPoints', 'reviewNudgeHours']) if (k in b) p[k] = Number(b[k]);
    const s = (await c.query('select pulse.work_settings_set($1) s', [JSON.stringify(p)])).rows[0].s;
    return { ...s, labels: workLabels(s.businessModel, s.teamLabel) };
  }));
  app.post<{ Body: Body }>('/api/v0/work/categories', { schema: { body } }, req => tx(req, async (c) => {
    const b = req.body;
    await c.query('select pulse.work_category_save($1)', [JSON.stringify({ key: str(b.key, 40), label: str(b.label, 60), ...('words' in b ? { words: strs(b.words) } : {}),
      ...('active' in b ? { active: b.active !== false } : {}), ...('position' in b ? { position: Number(b.position) || 100 } : {}) })]);
    return { ok: true, categories: await categories(c) };
  }));

  // A person's domains: active, waiting for an answer, ended; with the buttons the viewer has and suggestions from work.
  app.get('/api/v0/work/domains', req => tx(req, async (c, v) => {
    const me = person(v); const q = req.query as { person?: string };
    const who = q.person ? id(q.person) : me;
    const p = (await c.query(`select p.id,p.display_name name,pp.pod,pp.department,${PHOTO('p')} "photoAt" from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.id=$1`, [who])).rows[0] ?? fail(404, 'Person not found');
    const rows = (await c.query(`select ${DOMAIN} from ${DOMAIN_FROM} where d.person_id=$1 order by d.status='proposed' desc,d.status='active' desc,d.basis='policy' desc,d.created_at desc limit 60`, [who])).rows;
    const company = who !== me && (await c.query('select pulse.work_domain_company($1) ok', [who])).rows[0].ok as boolean;
    const policy = who !== me && (await c.query("select pulse.viewer_is('admin','leadership','hr') ok")).rows[0].ok as boolean;
    const domains = await Promise.all(rows.map(async (d) => ({ ...d, actions: await domainActions(c, me, d) })));
    const options = who === me || company ? {
      categories: (await categories(c)).filter((x) => x.active),
      pods: (await c.query("select distinct pod from pulse.people_profile where pod is not null union select name from pulse.unit where kind='pod' and valid_to is null order by 1")).rows.map((r) => r.pod as string),
      clients: (await c.query("select id,display_name name from pulse.client where client_type<>'internal' and coalesce(status,'active')<>'churned' order by display_name limit 800")).rows,
      projects: (await c.query(`select pr.id,coalesce(pr.title,pr.name) name,pr.kind from pulse.project pr join pulse.work_project wp on wp.project_id=pr.id
        where pr.status not in ('done','cancelled') and wp.status not in ('done','cancelled') order by pr.kind,coalesce(pr.title,pr.name) limit 900`)).rows } : null;
    return { person: p, self: who === me, domains, can: { propose: who === me || company, policy }, options,
      suggestions: who === me || company ? await domainSuggestions(c, who, rows) : [] };
  }));
  app.post<{ Body: Body }>('/api/v0/work/domains', { schema: { body } }, req => tx(req, async (c, v) => {
    const me = person(v); const b = req.body;
    const fields = { title: str(b.title, 160), basis: str(b.basis, 20) || 'agreement', categories: strs(b.categories), tags: strs(b.tags), pod: str(b.pod, 80) || null,
      projectId: optId(b.projectId), clientId: optId(b.clientId), effectiveFrom: str(b.effectiveFrom, 10) || null, note: str(b.note, 500) || null };
    return { id: (await c.query('select pulse.work_domain_propose($1,$2) id', [optId(b.personId) ?? me, JSON.stringify(fields)])).rows[0].id };
  }));
  for (const [action, accept] of [['accept', true], ['decline', false]] as const)
    app.post<{ Params: { id: string }; Body: Body }>(`/api/v0/work/domains/:id/${action}`, { schema: { body } }, req => tx(req, async (c, v) => {
      person(v); return (await c.query('select pulse.work_domain_answer($1,$2,$3) r', [id(req.params.id), accept, str(req.body?.note, 500) || null])).rows[0].r;
    }));
  app.post<{ Params: { id: string } }>('/api/v0/work/domains/:id/withdraw', req => tx(req, async (c, v) => {
    person(v); await c.query('select pulse.work_domain_withdraw($1)', [id(req.params.id)]); return { ok: true };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/domains/:id/end', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); await c.query('select pulse.work_domain_end($1,$2)', [id(req.params.id), str(req.body?.note, 500) || null]); return { ok: true };
  }));

  // While someone types a task: the kind of work, whether it lands directly or as a request, and Pip's suggestion.
  app.post<{ Body: Body }>('/api/v0/work/tasks/preview', { schema: { body } }, req => tx(req, async (c, v) => {
    const me = person(v); const b = req.body; const title = str(b.title);
    if (!title) return { category: null, categoryLabel: null, mode: null, suggestion: null };
    const projectId = optId(b.projectId); const tags = strs(b.tags);
    const s = await suggestFor(c, v, { title, category: str(b.category, 40) || null, projectId, dueOn: str(b.dueOn, 10) || null, priority: str(b.priority, 10) || null });
    const to = optId(b.assigneeId);
    // CONNECT 2: a connected organisation's contact gets it at once, through the connection.
    const contact = to && to !== me && (await c.query('select side from pulse.person where id=$1', [to])).rows[0]?.side !== 'staff' ? (await connectedContacts(c, v)).find((x) => x.id === to) : undefined;
    const mode = contact ? { mode: 'direct', why: 'connection', org: contact.org } : to && to !== me ? (await c.query('select pulse.work_assign_mode($1,$2,$3,$4) m', [to, projectId, s.category, tags])).rows[0].m : { mode: to ? 'self' : null };
    const { category, categoryLabel, ...suggestion } = s;
    // LIFECYCLE: who fits this work best, each with one line of reasons.
    const fit = (await c.query('select pulse.fit_people($1) f', [{ title, project: projectId, category, limit: 3 }])).rows[0].f.people;
    return { category, categoryLabel, mode, suggestion, fit };
  }));

  // Importance, urgency and the estimate: set by leadership, HR, the doer's head, the reviewer or the creator; nobody
  // sets their own. A task has no value any more (INTEGRITY 0910): value points sent here are refused.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/tasks/:id/value', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const b = req.body; const p: Body = {};
    if (b.valuePoints !== undefined && b.valuePoints !== null && b.valuePoints !== '') fail(400, 'Tasks no longer carry value points');
    if ('estimateMinutes' in b) p.estimateMinutes = b.estimateMinutes === null || b.estimateMinutes === '' ? null : Number(b.estimateMinutes);
    for (const k of ['importance', 'urgency']) if (k in b) p[k] = str(b[k], 10);
    if (b.useSuggestion === true) p.useSuggestion = true;
    return (await c.query('select pulse.task_value_set($1,$2) r', [id(req.params.id), JSON.stringify(p)])).rows[0].r;
  }));
  // Ask Pip again for one task (the creator, the people on it or leadership).
  app.post<{ Params: { id: string } }>('/api/v0/work/tasks/:id/suggest', req => tx(req, async (c, v) => {
    person(v); const tid = id(req.params.id);
    const t = (await c.query(`select t.title,t.category,t.project_id "projectId",(t.due_at at time zone ${ORG_TZ})::date::text "dueOn",t.priority,t.id "taskId",t.estimate_minutes "estimateMinutes"
     from pulse.task t where t.id=$1`, [tid])).rows[0] ?? fail(404, 'Task not found');
    const s = await suggestFor(c, v, t);
    const { category: _c, categoryLabel: _l, ...suggestion } = s; void _c; void _l;
    const saved = (await c.query('select pulse.task_suggestion_save($1,$2) r', [tid, JSON.stringify(suggestion)])).rows[0].r;
    return { suggestion, applied: saved.applied };
  }));

  // The pool: tasks with nobody yet, sorted by urgency, importance and the deadline, with "fits my domains".
  app.get('/api/v0/work/pool', req => tx(req, async (c, v) => {
    const me = person(v); const q = req.query as { fits?: string; scope?: string; task?: string };
    const mine = (await c.query('select pp.pod,pp.department,pulse.work_my_pods() pods,pulse.work_role() role from pulse.people_profile pp right join (select 1) x on pp.person_id=$1', [me])).rows[0];
    const rows = (await c.query(`select ${TASK},t.pooled_at "pooledAt",pb.display_name "pooledBy",${PHOTO('pb')} "pooledByPhotoAt",t.pooled_by "pooledById",
      t.ai_suggestion->>'reason' "suggestionReason",(t.ai_suggestion->>'effortMinutes')::int "suggestedMinutes",
      pulse.work_pool_eligible(t.pool_scope,t.pool_ref) "canClaim"
     from ${FROM} left join pulse.person pb on pb.id=t.pooled_by where t.pool_scope is not null and t.assignee_person_id is null and t.owner_id is null and t.status in ('open','unknown','in_progress','blocked')
      and ($1::text is null or t.pool_scope=$1)
     order by t.urgency='high' desc,t.priority='urgent' desc,t.priority='high' desc,t.due_at nulls last,t.pooled_at limit 300`,
      [['company', 'department', 'pod'].includes(String(q.scope)) ? q.scope : null])).rows;
    const marked = await markDomains(c, me, rows);
    // LIFECYCLE: heads, HR and leadership see who fits each pooled task best (and why), to nudge the right person.
    if (hr(v) || (mine.pods ?? []).length) for (const t of marked.slice(0, 40)) {
      const best = (await c.query('select pulse.fit_people($1) f', [{ task: t.id, limit: 1 }])).rows[0].f.people[0];
      (t as Row).bestFit = best ? { id: best.id, name: best.name, why: best.why, photoAt: best.photoAt } : null;
    }
    const fits = marked.filter((t) => t.inDomain).length;
    const list = q.fits === '1' ? marked.filter((t) => t.inDomain) : marked;
    const claimedWeek = (await c.query(`select count(*)::int n from pulse.task t where t.claimed_by=$1 and t.claimed_at>=date_trunc('week',now() at time zone ${ORG_TZ}) at time zone ${ORG_TZ}`, [me])).rows[0];
    const where = (await c.query(`select x.scope,x.ref from (select 'company' scope,null::text ref union select 'department',d from (select distinct department d from pulse.people_profile where department is not null) a
      union select 'pod',p from (select distinct pod p from pulse.people_profile where pod is not null union select name from pulse.unit where kind='pod' and valid_to is null) b) x
      where pulse.work_can_pool(x.scope,x.ref) order by x.scope<>'company',x.scope,x.ref`)).rows;
    return { rows: list, total: marked.length, fits, me, mine: { pod: mine.pod, department: mine.department, pods: mine.pods, role: mine.role }, claimedWeek, canPool: where.length > 0, pools: where };
  }));
  app.post<{ Params: { id: string } }>('/api/v0/work/pool/:id/claim', req => tx(req, async (c, v) => {
    person(v); const { valuePoints: _v, ...r } = (await c.query('select pulse.work_pool_claim($1) r', [id(req.params.id)])).rows[0].r; void _v; return r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/work/pool/:id/release', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); await c.query('select pulse.work_pool_release($1,$2)', [id(req.params.id), str(req.body?.note, 300) || null]); return { ok: true };
  }));

  // What a client project includes: linked projects with their progress, and (for leadership) suggestions with evidence.
  app.get('/api/v0/work/links', req => tx(req, async (c, v) => {
    const q = req.query as { clientProject?: string };
    const pkg = id(q.clientProject);
    return { ...(await packageLinks(c, v, pkg)), canDecide: leadership(v) };
  }));
  app.get('/api/v0/work/links/review', req => tx(req, async (c, v) => {
    if (!leadership(v) && !hr(v)) fail(403, 'Link suggestions are for leadership');
    const rows = (await c.query(`select l.id,l.source,l.confidence::float confidence,l.evidence,l.created_at "createdAt",l.client_project_id "clientProjectId",coalesce(c.title,c.name) "clientProjectName",
      cl.display_name "clientName",to_char(c.start_month,'FMMon YYYY') "clientProjectMonth",l.project_id "projectId",coalesce(p.title,p.name) "projectName",p.kind "projectKind",
      to_char(p.start_month,'FMMon YYYY') "projectMonth",(select count(*)::int from pulse.task t where t.project_id=p.id) tasks
     from pulse.work_project_link l join pulse.project c on c.id=l.client_project_id join pulse.project p on p.id=l.project_id left join pulse.client cl on cl.id=c.client_id
     where l.status='suggested' and l.retired_at is null order by l.confidence desc,l.created_at limit 200`)).rows;
    const counts = (await c.query("select count(*) filter(where status='linked')::int linked,count(*) filter(where status='dismissed')::int dismissed from pulse.work_project_link")).rows[0];
    return { rows, ...counts, canDecide: leadership(v) };
  }));
  app.post('/api/v0/work/links/detect', req => tx(req, async (c) => (await c.query('select pulse.work_link_suggest() r')).rows[0].r));
  for (const action of ['link', 'dismiss'] as const)
    app.post<{ Params: { id: string } }>(`/api/v0/work/links/:id/${action}`, req => tx(req, async (c) => (await c.query('select pulse.work_link_decide($1,$2) r', [id(req.params.id), action])).rows[0].r));
  app.post<{ Body: Body }>('/api/v0/work/links', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return { id: (await c.query('select pulse.work_link_set($1,$2,$3) id', [id(req.body.clientProjectId), id(req.body.projectId), req.body.on !== false])).rows[0].id };
  }));
  // The seam for automatic capture through the admin Google connection (docs/ops/TASKS.md § What a client project
  // includes): a collector posts a suggestion with evidence; leadership still decides.
  app.post<{ Body: Body }>('/api/v0/work/links/capture', { schema: { body } }, req => tx(req, async (c) => {
    const b = req.body;
    const evidence = Array.isArray(b.evidence) ? b.evidence.slice(0, 10).map((e) => ({ text: str((e as Body)?.text, 300), ref: str((e as Body)?.ref, 300) || undefined })) : [];
    return { id: (await c.query('select pulse.work_link_capture($1) id', [JSON.stringify({ clientProjectId: optId(b.clientProjectId), projectId: optId(b.projectId), confidence: b.confidence, evidence })])).rows[0].id };
  }));

  // One person, for leaders: what they are on now, how much, the hours their tasks took, the value credited, domains.
  app.get<{ Params: { id: string } }>('/api/v0/work/people/:id', req => tx(req, async (c, v) => personView(c, v, id(req.params.id))));
}

/** Linked projects under a client project, with progress; leadership also gets the open suggestions. */
export async function packageLinks(c: PoolClient, v: Viewer, pkg: string) {
  const linked = (await c.query(`select l.id,p.id "projectId",coalesce(p.title,p.name) name,p.kind,wp.status,wp.owner_id "ownerId",o.display_name "ownerName",l.source,l.decided_at "linkedAt",
    to_char(p.start_month,'FMMon YYYY') "month",count(t.id) filter(where t.status<>'cancelled')::int total,count(t.id) filter(where t.status in ('done','accepted','in_review'))::int finished,
    count(t.id) filter(where t.status in ('open','in_progress','blocked'))::int open,count(t.id) filter(where t.status in ('open','in_progress','blocked') and (t.due_at at time zone ${ORG_TZ})::date<${TODAY})::int overdue
   from pulse.work_project_link l join pulse.project p on p.id=l.project_id left join pulse.work_project wp on wp.project_id=p.id left join pulse.person o on o.id=wp.owner_id left join pulse.task t on t.project_id=p.id
   where l.client_project_id=$1 and l.status='linked' group by l.id,p.id,wp.status,wp.owner_id,o.display_name order by p.kind,coalesce(p.title,p.name)`, [pkg])).rows;
  const suggestions = leadership(v) || hr(v) ? (await c.query(`select l.id,l.source,l.confidence::float confidence,l.evidence,l.project_id "projectId",coalesce(p.title,p.name) name,p.kind,
    to_char(p.start_month,'FMMon YYYY') "month" from pulse.work_project_link l join pulse.project p on p.id=l.project_id
    where l.client_project_id=$1 and l.status='suggested' and l.retired_at is null order by l.confidence desc`, [pkg])).rows : [];
  const parent = (await c.query(`select c.id,coalesce(c.title,c.name) name from pulse.work_project_link l join pulse.project c on c.id=l.client_project_id where l.project_id=$1 and l.status='linked' limit 1`, [pkg])).rows[0] ?? null;
  const total = linked.reduce((n, r) => n + r.total, 0), finished = linked.reduce((n, r) => n + r.finished, 0);
  return { linked, suggestions, parent, totals: { projects: linked.length, total, finished, open: linked.reduce((n, r) => n + r.open, 0), overdue: linked.reduce((n, r) => n + r.overdue, 0) } };
}

async function personView(c: PoolClient, v: Viewer, who: string) {
  const me = person(v);
  if (who !== me && !(leadership(v) || hr(v) || (await c.query('select pulse.manages($1) ok', [who])).rows[0].ok)) fail(403, 'This view is for the person, their head, HR and leadership');
  const day = await today(c);
  const p = (await c.query(`select p.id,p.display_name name,pp.pod,pp.department,pp.role,${PHOTO('p')} "photoAt",pulse.work_mode(p.id) "workMode" from pulse.person p
   left join pulse.people_profile pp on pp.person_id=p.id where p.id=$1`, [who])).rows[0] ?? fail(404, 'Person not found');
  const now = (await c.query(`select ${TASK} from ${FROM} where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status='in_progress' order by t.started_at desc nulls last limit 6`, [who])).rows;
  const open = (await c.query(`select ${TASK} from ${FROM} where coalesce(t.assignee_person_id,t.owner_id)=$1 and ${OPEN} order by t.status='blocked' desc,t.due_at nulls last,t.priority='urgent' desc limit 30`, [who])).rows;
  const weeks = (await c.query(`with w as (select generate_series($2::date-interval '7 weeks',$2::date,interval '1 week')::date wk)
   select w.wk::text week,
    coalesce((select sum(e.minutes) from pulse.time_entry e where e.person_id=$1 and e.status='confirmed' and e.retired_at is null and e.work_date>=w.wk and e.work_date<w.wk+7),0)::int minutes,
    coalesce((select sum(e.minutes) from pulse.time_entry e where e.person_id=$1 and e.status='proposed' and e.retired_at is null and e.work_date>=w.wk and e.work_date<w.wk+7),0)::int proposed,
    (select count(*)::int from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status in ('done','accepted','in_review') and t.done_at>=w.wk::timestamp at time zone ${ORG_TZ} and t.done_at<(w.wk+7)::timestamp at time zone ${ORG_TZ}) done
   from w order by w.wk`, [who, day.w])).rows;
  const domains = (await c.query(`select ${DOMAIN} from ${DOMAIN_FROM} where d.person_id=$1 and d.status in ('active','proposed') order by d.status='active' desc,d.basis='policy' desc,d.created_at`, [who])).rows;
  const estimate = (await c.query(`select coalesce(sum(estimate_minutes),0)::int minutes,count(*) filter(where estimate_minutes is null)::int unestimated from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=$1 and ${OPEN}`, [who])).rows[0];
  const pool = (await c.query(`select count(*)::int n from pulse.task t where t.claimed_by=$1 and t.status in ('done','accepted')`, [who])).rows[0];
  // TASKS-4A: what they finished this week, day by day (no value: INTEGRITY 0910).
  const shipped = (await c.query(`select t.id,t.title,t.status,(t.done_at at time zone ${ORG_TZ})::date::text "doneOn"
    from pulse.task t where coalesce(t.assignee_person_id,t.owner_id)=$1 and t.status in ('done','accepted','in_review') and t.done_at>=$2::date::timestamp at time zone ${ORG_TZ}
    order by t.done_at desc limit 40`, [who, day.w])).rows;
  return { today: day.d, week: day.w, self: who === me, person: p, now: await markDomains(c, who, now), open: await markDomains(c, who, open), weeks, domains, estimate, pool, shipped,
    firstName: first(p.name) };
}
