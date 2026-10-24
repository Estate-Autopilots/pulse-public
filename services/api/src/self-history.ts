import type {FastifyInstance} from 'fastify';
import {fail,type Tx} from './routes.js';
import {attendanceEnabled} from './attendance-policy.js';
import {context} from './hr.js';

/**
 * R43: My desk → History. One person's own past, each part with where it came from. The route takes no person: it is
 * bound to the signed-in individual, so there is no URL to guess a colleague's history from.
 *  - Attendance: the months Pulse recorded, and the imported monthly reports whose owner is resolved (hr_month_self,
 *    migration 0251). Unresolved reports stay with HR; the person only learns how many.
 *  - Payslips: the months HR issued one. Salary records are never turned into a payslip here.
 */
export function registerSelfHistoryRoutes(app:FastifyInstance,{tx}:{tx:Tx}) {
 app.get('/api/v0/hr/self/history',req=>tx(req,async(c,v)=>{
  if(!v.person)fail(403,'History belongs to one person. This is a shared login; sign in with your own account to see your history.');
  const me=v.person as string,x=await context(c),enabled=await attendanceEnabled(c);
  const staff=(await c.query("select pp.joined_on::text \"joinedOn\" from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=$1 and p.side='staff'",[me])).rows[0];
  if(!staff)fail(404,'Your staff record was not found. Ask HR to link your account.');
  await c.query("select pulse.audit_write('restricted_read','hr.self_history',$1)",[me]);
  const months=enabled?(await c.query(`select to_char(work_date,'YYYY-MM') "month",count(distinct work_date)::int days,
    count(distinct work_date) filter(where mode='wfh')::int wfh,count(distinct work_date) filter(where mode='field')::int field,
    count(distinct work_date) filter(where source='regularised')::int corrected
    from pulse.attendance_effective where person_id=$1 group by 1 order by 1 desc`,[me])).rows:[];
  const imported=(await c.query(`select source_key "key",month::text "month",month_label "monthLabel",leave_days::float "leaveDays",wfh_days::float "wfhDays",
    half_days::float "halfDays",attendance_dates "coverage",basis,sheet,entered_by_hr "enteredByHr",resolved from pulse.hr_month_self() order by month desc nulls last,month_label`)).rows;
  const start=x.policy.leaveYearStart;
  const leave=(await c.query(`select (extract(year from from_date)::int-(case when extract(month from from_date)<$2 then 1 else 0 end)) "year",leave_kind kind,
    coalesce(sum(days) filter(where status='approved'),0)::float approved,coalesce(sum(days) filter(where status='pending'),0)::float pending,
    count(*) filter(where status in ('rejected','cancelled'))::int closed,count(*)::int requests
    from pulse.leave_request where person_id=$1 group by 1,2 order by 1 desc,2`,[me,start])).rows;
  const requests=(await c.query(`select id,kind,status,stage,subject,from_date::text "fromDate",to_date::text "toDate",updated_at "updatedAt"
    from pulse.hr_flow where person_id=$1 order by created_at desc limit 40`,[me])).rows;
  const counts=(await c.query(`select count(*)::int total,count(*) filter(where status='pending')::int pending from pulse.hr_flow where person_id=$1`,[me])).rows[0];
  const tickets=(await c.query(`select count(*)::int total,count(*) filter(where status not in ('resolved','closed'))::int open from pulse.hr_ticket where person_id=$1`,[me])).rows[0];
  const profile=(await c.query('select pulse.hr_self_profile() data')).rows[0]?.data;
  const files=(await c.query('select pulse.hr_file_list($1) r',[me])).rows[0].r??[];
  const policies=(await c.query(`select d.kind,d.title,d.version,a.at from pulse.policy_ack a join pulse.policy_document d on d.id=a.document_id
    where a.person_id=$1 order by a.at desc limit 40`,[me])).rows;
  const payslips=(await c.query('select pulse.hr_self_payslips() r')).rows[0].r??[];
  const first=months.length?months[months.length-1].month:null;
  return {today:x.today,attendanceEnabled:enabled,joinedOn:staff.joinedOn,leaveYearStart:start,
   coverage:{pulseFrom:first,trackingFrom:x.policy.trackingFrom,importedMonths:imported.filter(r=>r.resolved).length,withHr:imported.filter(r=>!r.resolved).length},
   attendance:months,imported:imported.filter(r=>r.resolved).map(({resolved:_,...r})=>r),leave,
   requests:{rows:requests,total:counts.total,pending:counts.pending},tickets,
   documents:{onFile:profile?.documents??[],files,policies},payslips};
 }));
}
