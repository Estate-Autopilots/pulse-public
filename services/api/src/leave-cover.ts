// KAZUK-REST slice 6 (F11, migration 1713): the leave and work-from-home SOP with a fallback, and HR policy
// acknowledgement tracking.
//   GET  /api/v0/cover                         the cover page: asks waiting for me, cover for my own requests, and (HR,
//                                              managers) asks that went up and need a fallback; the company's cover rule
//   POST /api/v0/cover/ask {kind,sourceId,coverId,note}   name who covers a leave request or WFH day (the person, or HR)
//   POST /api/v0/cover/:id/answer {accept,note}           the colleague asked accepts or declines (a decline goes up)
//   POST /api/v0/cover/policy {hours,required}            HR: hours to answer, and whether naming a cover is required
//   GET  /api/v0/hr/policies/:id/acks          HR: who acknowledged a policy version and who has not yet
//   POST /api/v0/hr/policies/:id/remind        HR: remind everyone who has not (each at most once a day; in Pulse only)
// Leave (hr.ts fileLeave) and WFH requests (hr/regularisations) take an optional coverId and ask through askCover.
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, hr, type Tx, type Viewer } from './routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (raw: unknown, what: string) => (typeof raw === 'string' && UUID.test(raw) ? raw : fail(400, `Choose a ${what}`));

/** The cover rule's input, checked before the database checks it again. `sop`: HR's steps (null keeps them as they
 *  are, an empty text goes back to the standard steps). */
export function coverPolicyInput(body: unknown): { hours: number; required: boolean; sop: string | null } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const hours = Number(b.hours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) fail(400, 'Choose 1 to 168 hours');
  let sop: string | null = null;
  if (b.sop !== undefined && b.sop !== null) {
    if (typeof b.sop !== 'string') fail(400, 'Write the steps as text');
    sop = (b.sop as string).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim();
    if (sop.length > 4000) fail(400, 'Keep the steps under 4,000 characters');
  }
  return { hours, required: b.required === true, sop };
}

/** An optional "HH:MM" time (the hours covered); both or neither. */
export function coverTimes(start: unknown, end: unknown): [string | null, string | null] {
  const t = (x: unknown) => (x === undefined || x === null || x === '' ? null : typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x) ? x : fail(400, 'Use a time such as 10:00'));
  const s = t(start), e = t(end);
  if ((s === null) !== (e === null)) fail(400, 'Give both times, or neither');
  return [s, e];
}

/** A short note, one line, at most 300 characters. */
export const coverNote = (raw: unknown) => (typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300) : '');

/** Ask the named colleague to cover (leave or a WFH day); with no colleague, refuse when the company requires one. */
export async function askCover(c: PoolClient, kind: 'leave' | 'wfh', sourceId: string, coverId: unknown) {
  if (coverId === undefined || coverId === null || coverId === '') {
    const required = (await c.query('select coalesce((select cover_required from pulse.hr_flow_policy), false) r')).rows[0].r as boolean;
    if (required) fail(400, 'Name the colleague who covers for you while you are away');
    return null;
  }
  return (await c.query('select pulse.leave_cover_ask($1, $2, $3, null) id', [kind, sourceId, id(coverId, 'colleague who covers')])).rows[0].id as string;
}

const COVER = `c.id, c.kind, c.source_id "sourceId", c.person_id "personId", p.display_name "personName", c.cover_id "coverId", cv.display_name "coverName",
  c.from_date::text "fromDate", c.to_date::text "toDate", to_char(c.cover_start, 'HH24:MI') "coverStart", to_char(c.cover_end, 'HH24:MI') "coverEnd", c.note, c.status, c.respond_by "respondBy", c.answered_at "answeredAt", c.answer_note "answerNote",
  c.escalated_at "escalatedAt", c.escalated_why "escalatedWhy", c.created_at "createdAt"`;
const FROM = 'pulse.leave_cover c join pulse.person p on p.id = c.person_id join pulse.person cv on cv.id = c.cover_id';
const me = (v: Viewer) => { if (!v.person) fail(403, 'A shared login cannot act for a person'); return v.person as string; };

export function registerLeaveCoverRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/cover', (req) => tx(req, async (c, v) => {
    const who = me(v);
    await c.query('select pulse.leave_cover_escalate_due()');
    const today = (await c.query("select (now() at time zone pulse.org_time_zone())::date::text d")).rows[0].d as string;
    const policy = (await c.query(`select coalesce((select cover_hours from pulse.hr_flow_policy), 24) hours, coalesce((select cover_required from pulse.hr_flow_policy), false) required,
      (select cover_sop from pulse.hr_flow_policy) sop, (select to_char(shift_start, 'HH24:MI') from pulse.hr_policy) "shiftStart", (select to_char(shift_end, 'HH24:MI') from pulse.hr_policy) "shiftEnd"`)).rows[0];
    const asked = (await c.query(`select ${COVER} from ${FROM} where c.cover_id = $1 and c.status in ('asked', 'accepted') and c.to_date >= $2::date order by c.from_date limit 50`, [who, today])).rows;
    const mine = (await c.query(`select ${COVER} from ${FROM} where c.person_id = $1 and c.status <> 'cancelled' and c.to_date >= $2::date order by c.from_date limit 50`, [who, today])).rows;
    // Row security shows managers their people's and HR everyone's; the list is what went up and needs a fallback.
    const up = (await c.query(`select ${COVER} from ${FROM} where c.status = 'escalated' and c.person_id <> $1 and c.to_date >= $2::date order by c.from_date limit 100`, [who, today])).rows;
    // Requests of mine still open with no cover named (to offer "Name who covers").
    const uncovered = (await c.query(`select 'leave' kind, l.id "sourceId", l.from_date::text "fromDate", l.to_date::text "toDate", l.leave_kind "what" from pulse.leave_request l
        where l.person_id = $1 and l.status in ('pending', 'approved') and l.to_date >= $2::date
          and not exists (select 1 from pulse.leave_cover c where c.source_id = l.id and c.status <> 'cancelled')
      union all
      select 'wfh', a.id, a.work_date::text, a.work_date::text, 'wfh' from pulse.attendance_regularisation a
        where a.person_id = $1 and a.kind = 'wfh' and a.status in ('pending', 'approved') and a.work_date >= $2::date
          and not exists (select 1 from pulse.leave_cover c where c.source_id = a.id and c.status <> 'cancelled')
      order by 3 limit 20`, [who, today])).rows;
    const people = (await c.query("select id, display_name name from pulse.person where side = 'staff' and status = 'active' and id <> $1 order by display_name limit 500", [who])).rows;
    return { today, policy, asked, mine, up, uncovered, people, canSet: hr(v) };
  }));

  app.post<{ Body: Record<string, unknown> }>('/api/v0/cover/ask', { schema: { body: { type: 'object', maxProperties: 10 } } }, (req) => tx(req, async (c, v) => {
    me(v);
    const b = req.body ?? {};
    const kind = b.kind === 'leave' || b.kind === 'wfh' ? b.kind : fail(400, 'Choose leave or work from home');
    const [start, end] = coverTimes(b.startTime, b.endTime);
    const cid = (await c.query('select pulse.leave_cover_ask($1, $2, $3, $4, $5::time, $6::time) id', [kind, id(b.sourceId, 'request'), id(b.coverId, 'colleague who covers'), coverNote(b.note) || null, start, end])).rows[0].id;
    return { id: cid, status: 'asked' };
  }));

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/cover/:id/answer', { schema: { body: { type: 'object', maxProperties: 4 } } }, (req) => tx(req, async (c, v) => {
    me(v);
    const status = (await c.query('select pulse.leave_cover_answer($1, $2, $3) s', [id(req.params.id, 'cover ask'), req.body?.accept === true, coverNote(req.body?.note) || null])).rows[0].s;
    return { id: req.params.id, status };
  }));

  app.post<{ Body: Record<string, unknown> }>('/api/v0/cover/policy', { schema: { body: { type: 'object', maxProperties: 4 } } }, (req) => tx(req, async (c, v) => {
    if (!hr(v) || !v.person) fail(403, 'HR sets the cover rule');
    const p = coverPolicyInput(req.body);
    return (await c.query('select pulse.leave_cover_policy_set($1, $2, $3) r', [p.hours, p.required, p.sop])).rows[0].r;
  }));

  app.get<{ Params: { id: string } }>('/api/v0/hr/policies/:id/acks', (req) => tx(req, async (c, v) => {
    if (!hr(v) || !v.person) fail(403, 'HR tracks acknowledgements');
    return (await c.query('select pulse.policy_ack_status($1) s', [id(req.params.id, 'policy')])).rows[0].s;
  }));

  app.post<{ Params: { id: string } }>('/api/v0/hr/policies/:id/remind', (req) => tx(req, async (c, v) => {
    if (!hr(v) || !v.person) fail(403, 'HR reminds people to acknowledge');
    const reminded = (await c.query('select pulse.policy_ack_remind($1) n', [id(req.params.id, 'policy')])).rows[0].n as number;
    return { reminded };
  }));
}
