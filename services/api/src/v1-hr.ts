// API-PLATFORM (owner, 5 Nov 2026: "complete control of Pulse through the API"): HR over API v1. Leave requests (read
// and file) and attendance (read), each through the screen's own code (hr.ts: context, fileLeave) as the key's
// principal, so the leave rules, balances, the HR flow and row security decide exactly what People → Leave decides: a
// person reads and files their own; HR and admins read everyone's and file for someone. hr.read and hr.write are their own
// area: a key that held people.read before keeps people/attendance exactly as it was (grandfathered).
import { ORG_TZ } from './org-time.js';
import { context, fileLeave } from './hr.js';
import { pageResponse, PAGE_QUERY, pageV1 } from './v1-paging.js';
import { defineV1Operation, v1Fail, type V1Context } from './v1.js';
import { bool, change, day, maybe, member, num, object, one, rows, str, text, uuid, viewerOf, type Row } from './v1-kit.js';

const LEAVE = object({ id: uuid, personId: uuid, person: str, kind: str, fromDate: str, toDate: str, halfDay: maybe, days: num, status: str, reason: maybe,
  createdAt: str, decidedBy: maybe, decidedAt: maybe });
const leaveOut = (r: Row) => ({ id: String(r.id), personId: String(r.personId), person: String(r.person ?? ''), kind: String(r.kind), fromDate: String(r.fromDate), toDate: String(r.toDate),
  halfDay: (r.halfDay as string) ?? null, days: Number(r.days ?? 0), status: String(r.status), reason: (r.reason as string) ?? null, createdAt: String(r.createdAt),
  decidedBy: (r.decidedBy as string) ?? null, decidedAt: (r.decidedAt as string) ?? null });
const LEAVE_SQL = `select l.id,l.person_id "personId",p.display_name person,l.leave_kind kind,l.from_date::text "fromDate",l.to_date::text "toDate",l.half_day "halfDay",
    coalesce(l.days,(l.to_date-l.from_date)+1)::float days,l.status,l.reason,l.created_at::text "createdAt",d.display_name "decidedBy",l.decided_at::text "decidedAt"
  from pulse.leave_request l join pulse.person p on p.id=l.person_id left join pulse.person d on d.id=l.decided_by`;
/** HR and admins see everyone's leave (the leave_person policy decides); everyone else only their own. */
const staffOnly = async (ctx: V1Context) => {
  await member(ctx);
  if (await one<string>(ctx, 'select side v from pulse.person where id=pulse.current_viewer()') !== 'staff') v1Fail(403, 'Leave and attendance are for staff');
};

defineV1Operation({ operationId: 'listLeaveRequests', method: 'GET', path: '/api/v1/hr/leave', scope: 'hr.read',
  summary: 'Leave requests: yours, or everyone\'s for HR and admins',
  query: object({ ...PAGE_QUERY, who: { enum: ['me', 'everyone'] }, personId: uuid, status: { enum: ['pending', 'approved', 'rejected', 'cancelled'] }, from: day, to: day }, []),
  response: pageResponse(LEAVE),
  mcp: { name: 'list_leave_requests', title: 'List leave requests',
    description: 'Lists leave requests. who "me" (default) is yours; "everyone" (or personId) is everyone you may see: HR and admins see all staff. status pending, approved, rejected or cancelled; from and to (YYYY-MM-DD) keep leave overlapping those dates. Pages of up to 100 with nextCursor.' },
  handler: async (ctx, input) => {
    await staffOnly(ctx);
    const q = input.query, mine = (q.who ?? (q.personId ? 'everyone' : 'me')) === 'me';
    return pageV1(ctx, 'listLeaveRequests', input, async (after, take) => (await rows(ctx, `${LEAVE_SQL}
        where ($1::uuid is null or l.id>$1) and ($2::boolean is false or l.person_id=pulse.current_viewer()) and ($3::uuid is null or l.person_id=$3)
          and ($4::text is null or l.status=$4) and ($5::date is null or l.to_date>=$5) and ($6::date is null or l.from_date<=$6)
        order by l.id limit $7`, [after, mine, q.personId ?? null, q.status ?? null, q.from ?? null, q.to ?? null, take])).map(leaveOut));
  },
});

defineV1Operation({ operationId: 'listLeaveTypes', method: 'GET', path: '/api/v1/hr/leave/types', scope: 'hr.read',
  summary: 'The company\'s leave types (the kinds a request may use)',
  response: object({ items: { type: 'array', items: object({ key: str, name: str, paid: bool, annualDays: { type: ['number', 'null'] }, active: bool }) } }),
  mcp: { name: 'list_leave_types', title: 'Leave types', description: 'Lists the company\'s leave types: the key to use in request_leave, its name, whether it is paid, its yearly allowance and whether it is in use.' },
  handler: async ctx => {
    await staffOnly(ctx);
    const x = await context(ctx.client);
    return { items: x.types.map(t => ({ key: t.key, name: t.name, paid: !!t.paid, annualDays: t.annualDays === null || t.annualDays === undefined ? null : Number(t.annualDays), active: !!t.active })) };
  },
});

defineV1Operation({ operationId: 'requestLeave', method: 'POST', path: '/api/v1/hr/leave', scope: 'hr.write',
  summary: 'Ask for leave (HR may file it for someone); it goes to the usual approver',
  body: object({ kind: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,23}$' }, fromDate: day, toDate: day, halfDay: { enum: ['first', 'second'] }, reason: text(500, 0), personId: uuid },
    ['kind', 'fromDate', 'toDate']),
  response: object({ leave: LEAVE, flowId: maybe, changeId: maybe }), authorize: staffOnly,
  mcp: { name: 'request_leave', title: 'Ask for leave',
    description: 'Files a leave request as you, exactly as People → Leave does: kind is a key from list_leave_types, fromDate and toDate YYYY-MM-DD (halfDay first or second for one date), an optional reason. HR may file for someone with personId. It waits for the usual approver; overlapping leave is refused.' },
  handler: async (ctx, { body }) => {
    const made = await fileLeave(ctx.client, await viewerOf(ctx), body as Record<string, unknown>) as Row;
    const id = String(made.id);
    const changeId = await change(ctx, 'leave.request', id, { fromDate: (body as Row).fromDate, toDate: (body as Row).toDate });
    const r = (await rows(ctx, `${LEAVE_SQL} where l.id=$1`, [id]))[0] ?? v1Fail(404, 'Leave request not found');
    return { leave: leaveOut(r), flowId: (made.flowId as string) ?? null, changeId };
  },
});

const DAY = object({ date: str, personId: uuid, name: str, checkedInAt: maybe, checkedOutAt: maybe, mode: maybe, lateMinutes: { type: ['integer', 'null'] } });
defineV1Operation({ operationId: 'listAttendance', method: 'GET', path: '/api/v1/hr/attendance', scope: 'hr.read',
  summary: 'Check-ins and check-outs: yours, or everyone\'s you may see (HR, managers and leadership)',
  query: object({ who: { enum: ['me', 'team'] }, personId: uuid, from: day, to: day }, []),
  response: object({ from: str, to: str, items: { type: 'array', items: DAY } }),
  mcp: { name: 'list_attendance', title: 'Attendance',
    description: 'Lists check-in and check-out times between from and to (YYYY-MM-DD; default today, at most 62 days). who "me" (default) is yours; "team" (or personId) is everyone you may see. Read only: people check in themselves in the app.' },
  handler: async (ctx, { query }) => {
    await staffOnly(ctx);
    const today = await one<string>(ctx, `select (now() at time zone ${ORG_TZ})::date::text v`);
    const from = query.from ?? today, to = query.to ?? query.from ?? today;
    if (to < from || (Date.parse(to) - Date.parse(from)) / 864e5 > 62) v1Fail(400, 'from and to are dates (YYYY-MM-DD), to not before from, at most 62 days');
    const team = query.who === 'team' || !!query.personId;
    const r = await rows(ctx, `select a.work_date::text date,a.person_id "personId",p.display_name name,a.checked_in_at::text "checkedInAt",a.checked_out_at::text "checkedOutAt",a.mode,a.late_minutes "lateMinutes"
      from pulse.attendance_effective a join pulse.person p on p.id=a.person_id where a.work_date between $1 and $2 and ($3::boolean or a.person_id=pulse.current_viewer())
        and ($4::uuid is null or a.person_id=$4)
      order by a.work_date desc,p.display_name limit 500`, [from, to, team, query.personId ?? null]);
    return { from, to, items: r.map(x => ({ date: String(x.date), personId: String(x.personId), name: String(x.name), checkedInAt: (x.checkedInAt as string) ?? null,
      checkedOutAt: (x.checkedOutAt as string) ?? null, mode: (x.mode as string) ?? null, lateMinutes: x.lateMinutes === null || x.lateMinutes === undefined ? null : Number(x.lateMinutes) })) };
  },
});
