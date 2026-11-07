import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, hr, type Tx, type Viewer } from './routes.js';

/** LIFECYCLE: who is joining, who is leaving, the checklists that go with each, and HR's review of people who have
 *  probably left. Who may do what is decided in the database (0157); these routes shape it for the screens. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const body = { type: 'object' } as const;
const PHOTO = (alias: string) => `(select ph.updated_at from pulse.person_photo ph where ph.person_id=${alias}.id)`;
export const STAGES = ['candidate', 'offer', 'joining', 'probation', 'active', 'notice', 'left'] as const;
const STEP_KEYS = /^[a-z]{3,20}$/;
const desk = (v: Viewer) => { if (!hr(v) || !v.person) fail(403, 'People moves are for HR, leadership and admins'); };
/** Moves, checklists and reviews are HR's and admins' to record (the database checks the same). */
const actor = (v: Viewer) => { if (!['hr', 'admin'].includes(v.role) || !v.person) fail(403, 'HR or an admin records people moves'); };

/** Current staff to hand work, projects, reports and pods to: active, not themselves, not "possibly left". */
async function people(c: PoolClient, except: string | null) {
  return (await c.query(`select p.id,p.display_name name,pp.role,pp.pod,pp.department,${PHOTO('p')} "photoAt" from pulse.person p join pulse.people_profile pp on pp.person_id=p.id
   where p.side='staff' and p.status='active' and p.id is distinct from $1 and not pulse.lifecycle_possibly_left(p.id) order by p.display_name`, [except])).rows;
}

export async function personLifecycle(c: PoolClient, v: Viewer, person: string) {
  const row = (await c.query(`select pulse.lifecycle_stage(p.id) stage,l.since,l.left_type "leftType",l.left_on "leftOn",p.status,
    e.probation_from "probationFrom",e.probation_to "probationTo",e.notice_from "noticeFrom",e.last_working_day "lastWorkingDay",e.payroll_from "payrollFrom"
    from pulse.person p left join pulse.person_lifecycle l on l.person_id=p.id left join pulse.hr_employment e on e.person_id=p.id where p.id=$1 and p.side='staff'`, [person])).rows[0];
  if (!row) return null;
  const events = (await c.query(`select e.id,e.kind,e.from_stage "from",e.to_stage "to",e.effective_on "on",e.left_type "leftType",e.detail,e.note,e.at,a.display_name "by"
    from pulse.person_lifecycle_event e left join pulse.person a on a.id=e.actor where e.person_id=$1 order by e.at desc limit 60`, [person])).rows;
  // Without a visible lifecycle row (a colleague's view) only current or not current is shown, as everywhere else.
  const visible = (await c.query('select 1 from pulse.person_lifecycle_event where person_id=$1 limit 1', [person])).rows.length > 0 || hr(v) || v.person === person;
  const cases = hr(v) ? (await c.query(`select id,kind,status,effective_on "effectiveOn",opened_at "openedAt" from pulse.lifecycle_case where person_id=$1 order by opened_at desc`, [person])).rows : [];
  const review = (await c.query(`select status,confidence,proposed_on "proposedOn",proposed_type "proposedType",reasons from pulse.lifecycle_review where person_id=$1 and status='open'`, [person])).rows[0] ?? null;
  const today = (await c.query('select pulse.lifecycle_today()::text d')).rows[0].d as string;
  return {
    today, stage: visible ? row.stage : row.status === 'active' ? 'active' : 'left', since: visible ? row.since : null,
    leftType: row.leftType, leftOn: row.leftOn ?? null,
    employment: visible ? { probationFrom: row.probationFrom, probationTo: row.probationTo, noticeFrom: row.noticeFrom, lastWorkingDay: row.lastWorkingDay, payrollFrom: row.payrollFrom } : null,
    events, cases, review, canMove: hr(v) && v.role !== 'leadership' && v.person !== person,
  };
}

export function registerLifecycleRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  // The People moves desk: stages, open cases with their progress, HR's review list and recent moves.
  app.get('/api/v0/lifecycle', req => tx(req, async (c, v) => {
    desk(v);
    const today = (await c.query('select pulse.lifecycle_today()::text d')).rows[0].d as string;
    const everyone = (await c.query(`select p.id,p.display_name name,pp.role,pp.pod,pp.department,p.status,${PHOTO('p')} "photoAt",pulse.lifecycle_stage(p.id) stage,
      l.since,l.left_type "leftType",coalesce(l.left_on,p.active_to) "leftOn",e.last_working_day "lastWorkingDay",pp.joined_on "joinedOn"
      from pulse.person p join pulse.people_profile pp on pp.person_id=p.id left join pulse.person_lifecycle l on l.person_id=p.id left join pulse.hr_employment e on e.person_id=p.id
      where p.side='staff' and not exists(select 1 from pulse.record_merge m where m.entity_type='person' and m.gone_id=p.id and m.undone_at is null)
      order by p.display_name`)).rows;
    const counts = Object.fromEntries(STAGES.map((s) => [s, everyone.filter((p) => p.stage === s).length]));
    const open = (await c.query(`select id from pulse.lifecycle_case where status='open' order by effective_on`)).rows;
    const cases = [];
    for (const o of open) {
      const view = (await c.query('select pulse.lifecycle_case_view($1) v', [o.id])).rows[0].v;
      const next = view.steps.find((s: { status: string }) => s.status === 'todo');
      cases.push({ id: view.id, kind: view.kind, effectiveOn: view.effectiveOn, leftType: view.leftType, person: view.person, done: view.done, total: view.total, next: next?.key ?? null });
    }
    const review = (await c.query(`select r.person_id "personId",p.display_name name,pp.role,pp.pod,${PHOTO('p')} "photoAt",p.status,r.confidence,r.proposed_on "proposedOn",
      r.proposed_type "proposedType",r.already_inactive "alreadyInactive",r.reasons,r.opened_at "openedAt",r.refreshed_at "refreshedAt"
      from pulse.lifecycle_review r join pulse.person p on p.id=r.person_id left join pulse.people_profile pp on pp.person_id=p.id
      where r.status='open' order by r.already_inactive,array_position(array['high','medium','low'],r.confidence),p.display_name`)).rows;
    const decided = (await c.query(`select r.person_id "personId",p.display_name name,r.status,r.decision_note note,r.decided_at "decidedAt",d.display_name "by"
      from pulse.lifecycle_review r join pulse.person p on p.id=r.person_id left join pulse.person d on d.id=r.decided_by where r.status in ('confirmed','dismissed') order by r.decided_at desc limit 12`)).rows;
    const unmatched = (await c.query(`select written_name name,kind,observed_on "on",summary from pulse.lifecycle_signal where person_id is null and retired_at is null order by observed_on desc limit 20`)).rows;
    const moves = (await c.query(`select e.id,e.person_id "personId",p.display_name name,e.kind,e.from_stage "from",e.to_stage "to",e.effective_on "on",e.left_type "leftType",e.detail,e.note,e.at,a.display_name "by"
      from pulse.person_lifecycle_event e join pulse.person p on p.id=e.person_id left join pulse.person a on a.id=e.actor order by e.at desc limit 30`)).rows;
    const lastScan = (await c.query(`select max(seen_at) at from pulse.lifecycle_signal`)).rows[0].at;
    const canReview = (await c.query("select pulse.viewer_is('admin','hr') ok")).rows[0].ok as boolean;
    const pods = (await c.query("select name from pulse.unit where kind='pod' and valid_to is null order by name")).rows.map((r) => r.name as string);
    return {
      today, counts, pods, cases, review: canReview ? review : null, decided: canReview ? decided : [], unmatched: canReview ? unmatched : [], lastScan, moves,
      pipeline: everyone.filter((p) => ['candidate', 'offer', 'joining', 'probation', 'notice'].includes(p.stage)),
      alumni: everyone.filter((p) => p.stage === 'left').sort((a, b) => String(b.leftOn ?? '').localeCompare(String(a.leftOn ?? ''))),
      can: { act: canReview, review: canReview },
    };
  }));
  app.get<{ Params: { id: string } }>('/api/v0/lifecycle/cases/:id', req => tx(req, async (c, v) => {
    desk(v);
    const view = (await c.query('select pulse.lifecycle_case_view($1) v', [id(req.params.id)])).rows[0].v;
    const categories = Object.fromEntries((await c.query('select key,label from pulse.work_category')).rows.map((r) => [r.key, r.label]));
    return { ...view, people: view.canAct ? await people(c, view.person.id) : [], categories };
  }));
  app.post<{ Params: { id: string; key: string }; Body: Body }>('/api/v0/lifecycle/cases/:id/steps/:key', { schema: { body } }, req => tx(req, async (c, v) => {
    actor(v);
    if (!STEP_KEYS.test(req.params.key)) fail(400, 'Unknown step');
    return (await c.query('select pulse.lifecycle_step_run($1,$2,$3) r', [id(req.params.id), req.params.key, req.body ?? {}])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/lifecycle/people/:id/move', { schema: { body } }, req => tx(req, async (c, v) => {
    actor(v);
    const to = String(req.body?.to ?? '');
    if (!(STAGES as readonly string[]).includes(to)) fail(400, 'Choose a stage');
    return (await c.query('select pulse.lifecycle_move($1,$2,$3) r', [id(req.params.id), to, req.body ?? {}])).rows[0].r;
  }));
  app.post<{ Body: Body }>('/api/v0/lifecycle/candidates', { schema: { body } }, req => tx(req, async (c, v) => {
    actor(v);
    return { id: (await c.query('select pulse.lifecycle_candidate($1) id', [req.body ?? {}])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/lifecycle/reviews/:id', { schema: { body } }, req => tx(req, async (c, v) => {
    actor(v);
    const action = String(req.body?.action ?? '');
    if (!['confirm', 'dismiss'].includes(action)) fail(400, 'Confirm or dismiss');
    return (await c.query('select pulse.lifecycle_review_decide($1,$2,$3) r', [id(req.params.id), action, req.body ?? {}])).rows[0].r;
  }));
  // Pulse's own evidence (sheets, quiet weeks) is read again on demand; mail and Workspace come from the scanner.
  app.post('/api/v0/lifecycle/refresh', req => tx(req, async (c, v) => {
    actor(v);
    return { people: (await c.query('select pulse.lifecycle_detect() n')).rows[0].n };
  }));
  // READY (0972): Hiring joins candidates to internal jobs, with an interview stage (when, who, where; one task for the
  // interviewer). HR and admins; the database decides.
  app.get<{ Params: { id: string } }>('/api/v0/hiring/jobs/:id', req => tx(req, async (c, v) => {
    actor(v);
    return (await c.query('select pulse.hiring_list($1) r', [id(req.params.id)])).rows[0].r;
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/hiring/jobs/:id/applications', { schema: { body } }, req => tx(req, async (c, v) => {
    actor(v);
    return { id: (await c.query('select pulse.hiring_link($1,$2) id', [id(req.params.id), id(String(req.body?.personId ?? ''))])).rows[0].id };
  }));
  app.post<{ Params: { id: string }; Body: Body }>('/api/v0/hiring/applications/:id', { schema: { body } }, req => tx(req, async (c, v) => {
    actor(v);
    const b = req.body ?? {}, at = b.interviewAt === undefined || b.interviewAt === null || b.interviewAt === '' ? b.interviewAt : String(b.interviewAt);
    if (typeof at === 'string' && Number.isNaN(Date.parse(at))) fail(400, 'Give the interview a date and time');
    return (await c.query('select pulse.hiring_update($1,$2) r', [id(req.params.id), JSON.stringify({ ...b, ...(at !== undefined ? { interviewAt: at } : {}) })])).rows[0].r;
  }));
  app.get<{ Params: { id: string } }>('/api/v0/people/:id/lifecycle', req => tx(req, async (c, v) => {
    const out = await personLifecycle(c, v, id(req.params.id));
    return out ?? fail(404, 'Person not found');
  }));
}
