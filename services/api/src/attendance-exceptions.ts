// ATT (21 Oct 2026): HR's attendance exceptions. Pulse settles confident days by itself (migration 0861); HR sees only
// what it could not: a missing check-out it closed at the shift's end, a question nobody answered, breaks beyond the
// allowance, and the check-out proposals Pulse once made by mistake. Each comes with its evidence (which signals, when)
// and one tap: Confirm, Fix (the time they left) or Dismiss. Corrections people asked for stay in Approvals (counted).
import type { FastifyInstance } from 'fastify';
import { attendanceEnabled } from './attendance-policy.js';
import { ORG_TZ } from './org-time.js';
import { fail, hr, type Tx, type Viewer } from './routes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const mustHr = (v: Viewer) => { if (!hr(v) || !v.person || v.nativeDevice) fail(403, 'Attendance exceptions are for HR and organisation admins'); };

export function registerAttendanceExceptionRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
  app.get('/api/v0/hr/attendance/exceptions', req => tx(req, async (c, v) => {
    mustHr(v);
    if (!(await attendanceEnabled(c))) return { attendanceEnabled: false, open: [], stale: [], counts: { open: 0, settled: 0, corrections: 0 } };
    const open = (await c.query(`select x.id,x.person_id "personId",p.display_name name,x.work_date::text "date",x.kind,x.summary,x.evidence,x.proposed_out "proposedOut",x.opened_at "openedAt",
      e.checked_in_at "in",e.checked_out_at "out",e.client->>'via' "inVia",e.out_client->>'via' "outVia",
      to_char(coalesce(e.checked_out_at,x.proposed_out) at time zone ${ORG_TZ},'HH24:MI') "outClock",to_char(e.checked_in_at at time zone ${ORG_TZ},'HH24:MI') "inClock",
      (select coalesce(jsonb_agg(jsonb_build_object('kind',a.kind,'at',a.at,'clock',to_char(a.at at time zone ${ORG_TZ},'HH24:MI'),'signals',a.signals,'detail',a.detail) order by a.at),'[]')
        from pulse.attendance_event a where a.person_id=x.person_id and a.work_date=x.work_date and a.kind<>'reminder') timeline
      from pulse.attendance_exception x join pulse.person p on p.id=x.person_id left join pulse.attendance_entry e on e.id=x.entry_id
      where x.resolved_at is null order by x.work_date desc,p.display_name limit 100`)).rows;
    const stale = (await c.query(`select s.id,s.person_id "personId",p.display_name name,s.work_date::text "date",to_char(s.out_time,'HH24:MI') "outTime",to_char(s.checked_in,'HH24:MI') "inTime",s.flow_id "flowId"
      from pulse.attendance_stale_proposals() s join pulse.person p on p.id=s.person_id`)).rows;
    const counts = (await c.query(`select
      (select count(*)::int from pulse.attendance_entry e where e.work_date>=(now() at time zone ${ORG_TZ})::date-7 and e.voided_at is null and e.checked_out_at is not null
        and not exists(select 1 from pulse.attendance_exception x where x.entry_id=e.id)) settled,
      (select count(*)::int from pulse.attendance_regularisation r where r.status='pending' and r.reason not like 'Auto check-out at last presence%') corrections`)).rows[0];
    return { attendanceEnabled: true, open, stale, counts: { open: open.length, settled: counts.settled, corrections: counts.corrections } };
  }));
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/v0/hr/attendance/exceptions/:id', { schema: { body: { type: 'object' } } }, req => tx(req, async (c, v) => {
    mustHr(v);
    if (req.params.id === 'stale') {
      if (req.body?.action !== 'withdraw') fail(400, 'Withdraw them all, or leave them');
      return { ok: true, withdrawn: (await c.query('select pulse.attendance_stale_withdraw() n')).rows[0].n };
    }
    if (!UUID.test(req.params.id)) fail(404, 'Unknown exception');
    const action = String(req.body?.action ?? '');
    if (!['confirm', 'fix', 'dismiss'].includes(action)) fail(400, 'Confirm, fix or dismiss');
    let out: string | null = null;
    if (action === 'fix') {
      const time = String(req.body?.outTime ?? '');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail(400, 'Give the time they left, like 18:40');
      const x = (await c.query('select work_date::text d from pulse.attendance_exception where id=$1', [req.params.id])).rows[0];
      if (!x) fail(404, 'Unknown exception');
      out = (await c.query(`select (($1::date+$2::time) at time zone ${ORG_TZ})::text t`, [x.d, time])).rows[0].t;
    }
    try { return (await c.query('select pulse.attendance_exception_resolve($1,$2,$3,$4) r', [req.params.id, action, out, typeof req.body?.note === 'string' ? req.body.note.slice(0, 300) : null])).rows[0].r; }
    catch (e) { const err = e as { code?: string; message?: string }; if (err.code === '22023' || err.code === '42501' || err.code === 'P0002') fail(err.code === '42501' ? 403 : err.code === 'P0002' ? 404 : 400, String(err.message)); throw e; }
  }));
}
