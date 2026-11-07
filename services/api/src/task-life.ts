import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, type Tx, type Viewer } from './routes.js';
import { FROM, TASK } from './tasks.js';
import { workSettings } from './work-domains.js';
import { orgZone, zoneDay } from './org-time.js';

/** TASKS-4B: a task's life after the work is done. Finishing (open subtasks block Done; finished work that still had
 *  them is flagged for the reviewer), reviewing (one quality rating, or acknowledging leadership's and founders' work),
 *  the reviewer's queue wherever they are, and a person's signals. The rules are in the database
 *  (0310_task_finish_review.sql); the defaults and how to change them are in docs/ops/VALUE.md. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
type Row = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const ids = (x: unknown) => Array.isArray(x) ? [...new Set(x.map(id))] : [];
const str = (x: unknown, max = 300) => String(x ?? '').trim().slice(0, max);
const body = { type: 'object' } as const;
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use tasks');
const first = (n: unknown) => String(n ?? 'Someone').replace(/^(mr|mrs|ms|dr|miss)\.?\s+/i, '').split(' ')[0];

export type ReviewPolicy = { reviewBy: 'assigner' | 'head' | 'creator'; reviewScale: 'three' | 'five'; reviewLeaders: 'acknowledge' | 'auto_proof' | 'review'; aboveBonus: number; helpPoints: number; reviewNudgeHours: number };
export async function reviewPolicy(c: PoolClient): Promise<ReviewPolicy> {
  const s = await workSettings(c);
  return { reviewBy: s.reviewBy, reviewScale: s.reviewScale, reviewLeaders: s.reviewLeaders, aboveBonus: s.aboveBonus, helpPoints: s.helpPoints, reviewNudgeHours: s.reviewNudgeHours };
}
/** The quality choices the policy offers, for the task page, the queue and the bell's card. */
export function qualityOptions(scale: ReviewPolicy['reviewScale']) {
  return scale === 'five' ? [1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }))
    : [{ value: 'great', label: 'Great' }, { value: 'good', label: 'Good' }, { value: 'needs_work', label: 'Needs work' }];
}

/** "on time", "2 days early", "1 day late" (days on the company's calendar, as everywhere in Work); null without a deadline. */
export function timing(dueAt: unknown, doneAt: unknown, zone: string): { key: 'early' | 'on_time' | 'late'; days: number; words: string } | null {
  if (!dueAt || !doneAt) return null;
  const due = zoneDay(zone, dueAt as Date | string), done = zoneDay(zone, doneAt as Date | string);
  const days = Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${done}T00:00:00Z`)) / 86400000);
  if (days === 0) return { key: 'on_time', days: 0, words: 'on time' };
  const n = Math.abs(days); const unit = `${n} day${n === 1 ? '' : 's'}`;
  return days > 0 ? { key: 'early', days: n, words: `${unit} early` } : { key: 'late', days: n, words: `${unit} late` };
}
/** "3 h", "2 days": how long finished work has waited for its review. */
export function waited(doneAt: unknown, now = Date.now()) {
  if (!doneAt) return null;
  const h = Math.max(0, (now - Date.parse(String(doneAt))) / 3600000);
  return h < 1 ? 'under an hour' : h < 24 ? `${Math.floor(h)} h` : `${Math.floor(h / 24)} day${Math.floor(h / 24) === 1 ? '' : 's'}`;
}

/** Accept finished work the way the company's policy says: leadership's and founders' work is acknowledged (one tap,
 *  no grade), everyone else's gets one quality rating. The older effort × impact form still works for old clients. */
export async function acceptTask(c: PoolClient, tid: string, b: Body) {
  const t = (await c.query('select pulse.task_is_leader(coalesce(assignee_person_id,owner_id)) leader from pulse.task where id=$1', [tid])).rows[0] ?? fail(404, 'Task not found');
  const pol = await reviewPolicy(c); const note = str(b.note, 1000) || null;
  if (t.leader && pol.reviewLeaders !== 'review') return (await c.query('select pulse.task_acknowledge($1,$2) r', [tid, note])).rows[0].r;
  if (b.acknowledge === true) return (await c.query('select pulse.task_acknowledge($1,$2) r', [tid, note])).rows[0].r;
  if (b.quality !== undefined && b.quality !== null && b.quality !== '')
    return (await c.query('select pulse.task_review($1,$2) r', [tid, JSON.stringify({ quality: String(b.quality), above: b.above === true || b.above === 'true' || b.above === 1, note })])).rows[0].r;
  if (b.effort !== undefined) return (await c.query('select pulse.task_accept($1,$2,$3,$4) r', [tid, Number(b.effort), Number(b.impact), note])).rows[0].r;
  return fail(400, pol.reviewScale === 'five' ? 'Rate the work from 1 to 5' : 'Rate the work: Great, Good or Needs work');
}

/** What the task page needs about finishing and reviewing: open flags, the review mode for this task and the policy. */
export async function lifeFor(c: PoolClient, v: Viewer, task: Row) {
  const tid = String(task.id);
  const flags = (await c.query(`select f.id,f.cause,f.detail,f.raised_at "raisedAt",f.raised_by "raisedBy" from pulse.task_flag f where f.task_id=$1 and f.resolved_at is null order by f.raised_at`, [tid])).rows;
  const pol = await reviewPolicy(c);
  const leaderWork = (await c.query('select pulse.task_is_leader($1) l', [task.assigneeId ?? null])).rows[0].l as boolean;
  const credit = null; // INTEGRITY (0910): accepting work credits no value.
  const acceptedBy = task.acceptedAt ? (await c.query(`select p.id,p.display_name name,(select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id) "photoAt"
    from pulse.task t join pulse.person p on p.id=t.accepted_by where t.id=$1`, [tid])).rows[0] ?? null : null;
  const doneBy = task.doneAt ? (await c.query(`select p.id,p.display_name name from pulse.task_event e join pulse.person p on p.id=e.actor_id
    where e.task_id=$1 and e.kind='status' and e.to_value='done' order by e.at desc limit 1`, [tid])).rows[0] ?? null : null;
  const returned = ['open', 'in_progress', 'blocked'].includes(String(task.status)) ? (await c.query(`select e.note,e.at,p.id "byId",p.display_name "by" from pulse.task_event e
    left join pulse.person p on p.id=e.actor_id where e.task_id=$1 and e.kind='returned' and e.at>coalesce((select max(x.at) from pulse.task_event x where x.task_id=$1 and x.kind='status' and x.to_value='done'),'-infinity')
    order by e.at desc limit 1`, [tid])).rows[0] ?? null : null;
  // The clock: running for this task (whoever does it), the last pause, and what has been captured so far.
  const doer = (task.assigneeId as string | null) ?? null;
  const clock = (await c.query(`select (select jsonb_build_object('startedAt',r.started_at,'personId',r.person_id) from pulse.task_timer r where r.task_id=$1 and r.ended_at is null limit 1) running,
    (select jsonb_build_object('endedAt',r.ended_at,'reason',r.end_reason) from pulse.task_timer r where r.task_id=$1 and r.ended_at is not null and r.person_id is not distinct from $2 order by r.ended_at desc limit 1) last,
    coalesce((select sum(e.minutes) from pulse.time_entry e where e.task_id=$1 and e.retired_at is null and e.status='confirmed'),0)::int captured,
    coalesce((select sum(e.minutes) from pulse.time_entry e where e.task_id=$1 and e.retired_at is null and e.status='proposed'),0)::int proposed,
    (select t.estimate_asked_at from pulse.task t where t.id=$1) "askedAt"`, [tid, doer])).rows[0];
  const askEstimate = !!v.person && v.person === doer && !task.estimateMinutes && !clock.askedAt && ['open', 'in_progress', 'unknown'].includes(String(task.status));
  // UX-5A: before acceptance, what it would credit (shown as the result of the rating).
  const preview = null;
  return { flags, leaderWork, mode: leaderWork && pol.reviewLeaders !== 'review' ? 'acknowledge' as const : 'rate' as const, policy: pol, quality: qualityOptions(pol.reviewScale),
    clock: { running: clock.running, last: clock.last, captured: clock.captured, proposed: clock.proposed, mine: !!v.person && v.person === doer }, askEstimate,
    credit, preview, acceptedBy, doneBy, returned, timing: timing(task.dueAt, task.doneAt, await orgZone(c)), waited: ['done', 'in_review'].includes(String(task.status)) ? waited(task.doneAt) : null, me: v.person };
}

/** The reviewer's queue: their finished work to accept, oldest first, with who, when and how it went. */
export async function reviewQueue(c: PoolClient, me: string) {
  const rows = (await c.query(`select ${TASK},(select ph.updated_at from pulse.person_photo ph where ph.person_id=a.id) "doerPhotoAt",
    pulse.task_is_leader(coalesce(t.assignee_person_id,t.owner_id)) "leaderWork",
    (select count(*)::int from pulse.task_flag f where f.task_id=t.id and f.resolved_at is null) flags,
    pulse.task_open_children(t.id) "openChildren"
   from ${FROM} where t.id in (select pulse.task_review_queue($1)) order by t.done_at nulls last,t.title limit 300`, [me])).rows;
  const zone = await orgZone(c);
  return rows.map((t) => ({ ...t, timing: timing(t.dueAt, t.doneAt, zone), waited: waited(t.doneAt), waitedHours: t.doneAt ? Math.floor((Date.now() - Date.parse(String(t.doneAt))) / 3600000) : null }));
}

/** The bell's "finished this" card: who, how it went against the deadline, how long it has waited, and one tap. */
export async function doneNotice(c: PoolClient, taskId: string, me: string) {
  const t = (await c.query(`select t.id,t.title,t.status,t.review_owner_id "reviewerId",t.due_at "dueAt",t.done_at "doneAt",
    coalesce(t.assignee_person_id,t.owner_id) "doerId",d.display_name "doerName",(select ph.updated_at from pulse.person_photo ph where ph.person_id=d.id) "doerPhotoAt",
    pulse.task_is_leader(coalesce(t.assignee_person_id,t.owner_id)) leader,pulse.task_open_children(t.id) "openChildren",
    (select count(*)::int from pulse.task_flag f where f.task_id=t.id and f.resolved_at is null) flags,
    exists(select 1 from pulse.task_review_queue($2) q where q=t.id) "mine"
   from pulse.task t left join pulse.person d on d.id=coalesce(t.assignee_person_id,t.owner_id) where t.id=$1`, [taskId, me])).rows[0];
  if (!t) return null;
  const pol = await reviewPolicy(c); const when = timing(t.dueAt, t.doneAt, await orgZone(c)); const wait = waited(t.doneAt);
  const title = `${first(t.doerName)} finished “${t.title}”`;
  const body = [when ? `Finished ${when.words}` : 'Finished (no deadline)', wait ? `waiting ${wait}` : null,
    t.flags || t.openChildren ? `${t.openChildren || 'some'} subtask${t.openChildren === 1 ? '' : 's'} still open` : null].filter(Boolean).join(' · ');
  const live = t.mine && ['done', 'in_review'].includes(t.status);
  const actions = !live ? [] : t.leader && pol.reviewLeaders !== 'review'
    ? [{ key: 'acknowledge', label: 'Accept', tone: 'primary' as const, method: 'POST' as const, path: `/api/v0/tasks/${t.id}/accept`, body: { acknowledge: true }, done: 'Accepted' }]
    : [{ key: 'accept', label: 'Accept', tone: 'primary' as const, method: 'POST' as const, path: `/api/v0/tasks/${t.id}/accept`,
      fields: [{ key: 'quality', label: 'How was the work?', type: 'choice' as const, options: qualityOptions(pol.reviewScale), default: pol.reviewScale === 'five' ? '4' : 'good' },
        { key: 'above', label: 'Above and beyond', type: 'flag' as const, default: 0 }], done: 'Accepted' }];
  return { title, body, actions, live, from: { id: t.doerId, name: t.doerName, photoAt: t.doerPhotoAt }, subject: { type: 'task', id: t.id, title: t.title, status: t.status } };
}

export function registerTaskLifeRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // The reviewer's queue (Work → Reviews) and its count for the top bar's chip.
  app.get('/api/v0/tasks/reviews', req => tx(req, async (c, v) => {
    const me = person(v); const pol = await reviewPolicy(c);
    return { rows: await reviewQueue(c, me), policy: pol, quality: qualityOptions(pol.reviewScale), me };
  }));
  // UX-5A: how accepting this task works (rated or acknowledged, the scale, who did it), read-only. INTEGRITY (0910):
  // no points any more; accepting credits nothing.
  app.get<{ Params: { id: string } }>('/api/v0/tasks/:id/credit', req => tx(req, async (c) => {
    const tid = id(req.params.id);
    const r = (await c.query(`select t.id,t.title,t.status,d.id "doerId",d.display_name "doerName",pulse.task_is_leader(coalesce(t.assignee_person_id,t.owner_id)) leader,
      (select ph.updated_at from pulse.person_photo ph where ph.person_id=d.id) "doerPhotoAt"
      from pulse.task t left join pulse.person d on d.id=coalesce(t.assignee_person_id,t.owner_id) where t.id=$1 and t.deleted_at is null and pulse.task_visible(t.id)`, [tid])).rows[0];
    if (!r) fail(404, 'Task not found');
    const pol = await reviewPolicy(c);
    return { mode: r.leader && pol.reviewLeaders !== 'review' ? 'acknowledge' : 'rate', task: { id: r.id, title: r.title, status: r.status },
      doer: r.doerId ? { id: r.doerId, name: r.doerName, photoAt: r.doerPhotoAt } : null, scale: pol.reviewScale };
  }));
  app.get('/api/v0/tasks/reviews/count', req => tx(req, async (c, v) => {
    if (!v.person) return { n: 0, oldestHours: null };
    const r = (await c.query(`select count(*)::int n,floor(extract(epoch from now()-min(t.done_at))/3600)::int "oldestHours" from pulse.task t where t.id in (select pulse.task_review_queue($1))`, [v.person])).rows[0];
    return r;
  }));
  // Accept several at once: leadership's work is acknowledged, everyone else's gets the one rating chosen (Good by default).
  app.post<{ Body: Body }>('/api/v0/tasks/reviews/bulk', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const list = ids(req.body.ids).slice(0, 100); if (!list.length) fail(400, 'Choose finished tasks');
    const quality = str(req.body.quality, 12) || 'good';
    let accepted = 0, acknowledged = 0; const failed: { id: string; title: string | null; error: string }[] = [];
    for (const tid of list) {
      await c.query('savepoint review_one');
      try { const r = await acceptTask(c, tid, { quality }); if (r.kind === 'acknowledged' || r.kind === 'auto') acknowledged++; else accepted++; await c.query('release savepoint review_one'); }
      catch (e) {
        await c.query('rollback to savepoint review_one');
        failed.push({ id: tid, title: (await c.query('select title from pulse.task where id=$1', [tid])).rows[0]?.title ?? null, error: e instanceof Error ? e.message : 'Not accepted' });
      }
    }
    return { accepted, acknowledged, failed };
  }));
  // The reviewer has seen that work was finished with open subtasks (or accepts it knowingly).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/flags/resolve', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return { resolved: (await c.query('select pulse.task_flag_resolve($1,$2) n', [id(req.params.id), str(req.body.note, 500) || null])).rows[0].n };
  }));
  // The clock: the doer's own Start / Pause / Resume (Start moves a To do task to Doing).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/timer', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); return (await c.query('select pulse.task_timer_set($1,$2) r', [id(req.params.id), req.body.on !== false])).rows[0].r;
  }));
  // "About how long will this take?", asked once (minutes, or null to skip).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/estimate', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const m = req.body.minutes === null || req.body.minutes === undefined || req.body.minutes === '' ? null : Math.round(Number(req.body.minutes));
    return (await c.query('select pulse.task_estimate_answer($1,$2) r', [id(req.params.id), m])).rows[0].r;
  }));
  // A person's record: finished, on time, sent back, finished with open subtasks, quality, unlocks (kindly shown).
  app.get<{ Params: { id: string } }>('/api/v0/tasks/signals/:id', req => tx(req, async (c, v) => {
    person(v); const days = Math.max(7, Math.min(400, Number((req.query as { days?: string }).days) || 90));
    const r = (await c.query('select pulse.person_task_signals($1,$2) s,pulse.help_totals($1,$2) h', [id(req.params.id), days])).rows[0];
    return { ...r.s, help: r.h };
  }));
}
