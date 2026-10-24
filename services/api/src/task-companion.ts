import type { FastifyInstance } from 'fastify';
import { fail, type Tx, type Viewer } from './routes.js';
import { run } from './ats.js';

/** UX-5B: the task companion. The task in a few lines wherever the person is (its steps, its signals, Mark done), where
 *  it sends people, the signals that show it is done (confirmed by a person), what just happened on the viewer's open
 *  tasks, and Undo when Pulse finished one by itself. The rules live in the database (0420_task_companion.sql): events
 *  come from the database's own triggers, never from this API or the browser. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEST = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const EVENT = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/;
type Body = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid task');
const body = { type: 'object' } as const;
const person = (v: Viewer) => v.person ?? fail(403, 'Sign in with your own staff account to use tasks');

/** The change a person asks for, checked for shape; the database checks the rest (registered events, declared data). */
export function companionChange(b: Body): Body {
  const out: Body = {};
  if ('target' in b) {
    if (b.target !== null && (typeof b.target !== 'string' || !DEST.test(b.target) || b.target.length > 120)) fail(400, 'Choose a place in Pulse');
    out.target = b.target;
    const events = Array.isArray(b.targetEvents) ? b.targetEvents : [];
    if (events.length > 12 || events.some((e) => typeof e !== 'string' || !EVENT.test(e))) fail(400, 'Unknown event for that place');
    out.targetEvents = events;
  }
  if ('autoDone' in b) { if (typeof b.autoDone !== 'boolean') fail(400, 'Say whether Pulse may finish it by itself'); out.autoDone = b.autoDone; }
  if (b.dismiss === true) out.dismiss = true;
  if ('signals' in b) {
    if (!Array.isArray(b.signals) || !b.signals.length || b.signals.length > 6) fail(400, 'Confirm one to six signals');
    out.signals = (b.signals as unknown[]).map((s) => {
      const x = (s ?? {}) as Body;
      if (typeof x.event !== 'string' || !EVENT.test(x.event)) fail(400, 'Unknown signal');
      const need = x.need === undefined ? 1 : Number(x.need);
      if (!Number.isInteger(need) || need < 1 || need > 50) fail(400, 'A signal counts 1 to 50');
      return { event: x.event, label: String(x.label ?? '').trim().slice(0, 200), need, distinct: x.distinct === 'subject' ? 'subject' : null,
        where: x.where && typeof x.where === 'object' && !Array.isArray(x.where) ? x.where : {} };
    });
  }
  if (!Object.keys(out).length) fail(400, 'Say what to change');
  return out;
}

export function registerTaskCompanionRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // The task as the companion shows it: title, status, the notes (for steps), ticked steps, what may be done here.
  app.get<{ Params: { id: string } }>('/api/v0/tasks/:id/companion', req => tx(req, async (c, v) => {
    const me = person(v); const tid = id(req.params.id);
    const companion = (await run(() => c.query('select pulse.task_companion_read($1) d', [tid]))).rows[0].d;
    const task = (await c.query(`select t.id,t.title,t.status,t.notes,t.priority,t.due_at "dueAt",t.due_at::date::text "dueOn",t.assignee_person_id "assigneeId",
      coalesce(t.assignee_person_id,t.owner_id)=$2 doer,pulse.task_can_edit(t.id) "canEdit",coalesce(pr.requires_proof,false) "requiresProof",
      (select count(*)::int from pulse.task_proof p where p.task_id=t.id and p.removed_at is null) proofs,pulse.task_open_children(t.id) "openSubtasks",
      ap.display_name "assigneeName",t.project_id "projectId",coalesce(pr.title,pr.name) "projectName",t.created_by=$2 creator
      from pulse.task t left join pulse.project pr on pr.id=t.project_id left join pulse.person ap on ap.id=coalesce(t.assignee_person_id,t.owner_id)
      where t.id=$1 and t.deleted_at is null`, [tid, me])).rows[0] ?? fail(404, 'Task not found');
    const checks = (await c.query('select step_key "key" from pulse.task_check where task_id=$1 and done_at is not null', [tid])).rows.map((r) => r.key as string);
    const repeat = (await c.query('select pulse.task_repeat_of($1) every', [tid])).rows[0].every as string | null;
    return { task, checks, companion, repeat, me };
  }));
  // Where it sends people, and/or the signals a person confirms (Pip proposes them on the task page).
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/companion', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const tid = id(req.params.id);
    return (await run(() => c.query('select pulse.task_companion_set($1,$2) d', [tid, JSON.stringify(companionChange(req.body ?? {}))]))).rows[0].d;
  }));
  app.post<{ Params: { id: string } }>('/api/v0/tasks/:id/companion/seen', req => tx(req, async (c, v) => {
    person(v); await run(() => c.query('select pulse.task_companion_seen($1)', [id(req.params.id)])); return { ok: true };
  }));
  // Repeating work: every day, week or month (null stops it); the next one is made when this one is finished.
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/tasks/:id/repeat', { schema: { body } }, req => tx(req, async (c, v) => {
    person(v); const every = req.body?.every ?? null;
    if (every !== null && !['day', 'week', 'month'].includes(String(every))) fail(400, 'Repeat every day, week or month');
    return (await run(() => c.query('select pulse.task_repeat_set($1,$2) d', [id(req.params.id), every]))).rows[0].d;
  }));
  app.post<{ Params: { id: string } }>('/api/v0/tasks/:id/auto-done/undo', req => tx(req, async (c, v) => {
    person(v); return (await run(() => c.query('select pulse.task_auto_done_undo($1) d', [id(req.params.id)]))).rows[0].d;
  }));
  // What lights the companion up: events on the viewer's open tasks, and tasks Pulse finished for them.
  app.get('/api/v0/work/companion', req => tx(req, async (c, v) => {
    if (!v.person) return { hits: [], auto: [] };
    return (await c.query('select pulse.task_companion_attention() d')).rows[0].d;
  }));
}
