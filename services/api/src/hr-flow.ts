import { ORG_TZ } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { fail, hr, type Tx, type Viewer } from './routes.js';
import { attendanceEnabled, ATTENDANCE_OFF_MESSAGE } from './attendance-policy.js';

const id = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v) ? v : fail(400,'Choose a valid record');
const note = (v: unknown) => String(v ?? '').trim().slice(0,500);
const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0,10)===v ? v : fail(400,'Choose a valid date');
const staff = (v: Viewer) => { if (!hr(v) || !v.person) fail(403,'HR access required'); };
export async function flowQueue(c: PoolClient, v: Viewer) {
 await c.query('select pulse.hr_flow_defaults()');
 const attendance=await attendanceEnabled(c);
 const cofounder=(await c.query('select pulse.hr_is_cofounder() ok')).rows[0].ok;
 const rows=(await c.query(`select f.id,f.person_id "personId",p.display_name name,f.kind,f.source_id "sourceId",f.subject,f.note,f.details,
 f.from_date::text "fromDate",f.to_date::text "toDate",f.status,f.stage,f.needs_hr "needsHr",f.decision_note "decisionNote",f.created_at "createdAt",f.updated_at "updatedAt",
 h.display_name "headName",f.decided_by "decidedBy",
 coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'action',e.action,'note',e.note,'at',e.created_at,'by',a.display_name) order by e.created_at,e.id)
 from pulse.hr_flow_event e left join pulse.person a on a.id=e.actor_id where e.flow_id=f.id),'[]') history,
 (f.person_id<>$1 and (($2 and f.status<>'pending') or (f.stage='cofounder' and pulse.hr_is_cofounder()) or (f.stage='hr' and $2) or (f.stage='pod_head' and ($2 or pulse.hr_head(f.person_id)=$1)))) "canDecide"
 from pulse.hr_flow f join pulse.person p on p.id=f.person_id left join pulse.person h on h.id=pulse.hr_head(f.person_id)
 order by (f.status='pending') desc,f.created_at desc limit 300`,[v.person,hr(v)])).rows;
 return {rows:attendance?rows:rows.filter(r=>r.kind!=='correction'),attendanceEnabled:attendance,me:v.person,staff:hr(v),cofounder};
}
export function registerHrFlowRoutes(app: FastifyInstance,{tx,correction}:{tx:Tx;correction:(c:PoolClient,v:Viewer,sourceId:string)=>Promise<void>}) {
 app.get('/api/v0/hr/flows',req=>tx(req,flowQueue));
 app.get('/api/v0/hr/work-calendar',req=>tx(req,async(c,v)=>{
  const attendance=await attendanceEnabled(c);
  await c.query('select pulse.hr_flow_defaults()');
  const today=(await c.query(`select (now() at time zone ${ORG_TZ})::date::text "day"`)).rows[0].day;
  const days=(await c.query(`select d::date::text "day",h.name holiday,pulse.hr_working($1,d::date,
   coalesce((select s.work_days from pulse.person_shift a join pulse.shift s on s.id=a.shift_id where a.person_id=$1 and a.mode='office' and a.valid_from<=d::date and (a.valid_to is null or a.valid_to>=d::date) order by a.valid_from desc limit 1),p.work_days)) working
   from pulse.hr_policy p cross join generate_series($2::date,$2::date+366,interval '1 day') d left join pulse.holiday h on h.day=d::date and not h.optional`,[v.person,today])).rows;
  const credits=attendance?(await c.query(`select c.id,c.earned_on::text "earnedOn",c.expires_on::text "expiresOn",c.days::float,
   (c.days-coalesce((select sum(u.days) from pulse.hr_comp_use u where u.credit_id=c.id),0))::float remaining
   from pulse.hr_comp_credit c join pulse.hr_flow f on f.id=c.flow_id where c.person_id=$1 and f.status='approved' and exists(select 1 from pulse.attendance_effective e where e.person_id=c.person_id and e.work_date=c.earned_on) order by c.expires_on`,[v.person])).rows:[];
  return {attendanceEnabled:attendance,today,me:v.person,days,credits,patterns:(await c.query(`select w.person_id "personId",p.display_name name,w.work_days "workDays",w.valid_from::text "fromDate",w.valid_to::text "toDate",w.reason from pulse.hr_work_pattern w join pulse.person p on p.id=w.person_id where w.superseded_at is null order by w.valid_from desc`)).rows,
   work:(await c.query(`select f.id,f.person_id "personId",p.display_name name,f.from_date::text "day",f.status from pulse.hr_flow f join pulse.person p on p.id=f.person_id where f.kind='work' and f.status in('approved','pending') and f.from_date>=$1::date-31 order by f.from_date`,[today])).rows,
   compPolicy:(await c.query('select comp_credit::float credit,comp_expiry_days "expiryDays" from pulse.hr_flow_policy')).rows[0]};
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/hr/work-days',req=>tx(req,async(c,v)=>{
  if(!v.person)fail(403,'Sign in with your own account');
  const result=(await c.query('select pulse.hr_work_request($1,$2) id',[date(req.body.day),note(req.body.note)])).rows[0];
  return result;
 }));
 app.post<{Params:{id:string};Body:Record<string,unknown>}>('/api/v0/hr/flows/:id/decision',req=>tx(req,async(c,v)=>{
  const flowId=id(req.params.id),action=String(req.body.action),reason=note(req.body.note);
  const f=(await c.query('select kind,source_id,status,person_id from pulse.hr_flow where id=$1',[flowId])).rows[0];
  if(!f)fail(404,'Request not found');
  if(f.kind==='correction'&&f.source_id&&(await c.query('select exists(select 1 from pulse.attendance_regularisation where id=$1) attendance',[f.source_id])).rows[0].attendance
    &&!(await attendanceEnabled(c)))fail(403,ATTENDANCE_OFF_MESSAGE);
  if(!['approved','rejected','cancelled','ask','forward','reply'].includes(action))fail(400,'Choose a decision');
  if(!['cancelled','reply'].includes(action) && f.person_id===v.person)fail(403,'Someone else must decide your request');
  if((action==='forward'||action==='ask'||action==='reply'||action==='rejected'||(f.status!=='pending'&&action!=='cancelled')) && reason.length<3)fail(400,'Add a reason or question');
  await c.query('select pulse.hr_flow_decide($1,$2,$3)',[flowId,action,reason||null]);
  if(action==='approved' && f.kind==='correction' && f.status!=='approved')await correction(c,v,f.source_id);
  return {id:flowId,action};
 }));
 app.get('/api/v0/hr/flow-settings',req=>tx(req,async(c,v)=>{
  staff(v);await c.query('select pulse.hr_flow_defaults()');
  return {
   attendanceEnabled:await attendanceEnabled(c),
   policy:(await c.query('select * from pulse.hr_flow_policy')).rows[0],
   people:(await c.query(`select p.id,p.display_name name,pp.pod,pp.manager_id "managerId",pp.role,(select ph.updated_at from pulse.person_photo ph where ph.person_id=p.id) "photoAt" from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and p.status='active' order by p.display_name`)).rows,
   pods:(await c.query('select name,head_id "headId" from pulse.hr_pod order by name')).rows,
   cofounders:(await c.query('select person_id "personId",active from pulse.hr_cofounder')).rows,
   patterns:(await c.query('select w.id,w.person_id "personId",p.display_name name,w.work_days "workDays",w.valid_from::text "fromDate",w.valid_to::text "toDate",w.reason from pulse.hr_work_pattern w join pulse.person p on p.id=w.person_id where w.superseded_at is null order by w.valid_from desc')).rows,
   podNames:(await c.query("select name from pulse.unit where kind='pod' and valid_to is null order by name")).rows.map(p=>p.name),
   suggestions:(await c.query(`select id,title,entity_id "personId",proposed,evidence from pulse.review_item where status='pending' and (kind='manager' or (entity_type='person' and proposed ? 'pod')) order by title,id limit 100`)).rows
  };
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/hr/flow-settings',req=>tx(req,async(c,v)=>{
  staff(v);await c.query('select pulse.hr_flow_defaults()');const b=req.body;
  const columns=['leave_approver','correction_approver','work_approver','request_approver','max_leave_days','balance_buffer','comp_credit','comp_expiry_days','reminder_hours'];
  const values:unknown[]=[],sets:string[]=[];
  for(const col of columns)if(col in b){
   const value=col.endsWith('_approver')?String(b[col]):Number(b[col]);
   if(col.endsWith('_approver')&&!['pod_head','hr','cofounder'].includes(String(value)))fail(400,'Choose an approver');
   if(typeof value==='number'&&!Number.isFinite(value))fail(400,'Enter a number');
   values.push(value);sets.push(`${col}=$${values.length}`);
  }
  if(!sets.length)fail(400,'Choose policy settings');
  values.push(v.person);await c.query(`update pulse.hr_flow_policy set ${sets.join(',')},updated_by=$${values.length},updated_at=now()`,values);
  return {ok:true};
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/hr/pod-heads',req=>tx(req,async(c,v)=>{
  staff(v);const name=note(req.body.name).slice(0,80),head=id(req.body.headId);
  const members=Array.isArray(req.body.members)?[...new Set(req.body.members.map(id))]:fail(400,'Choose members');
  if(!name||!members.length)fail(400,'Choose a pod and its members');
  const active=(await c.query(`select id from pulse.person where id=any($1) and side='staff' and status='active'`,[[...members,head]])).rows;
  if(new Set(active.map(p=>p.id)).size!==new Set([...members,head]).size)fail(400,'Choose active staff');
  await c.query('select pulse.hr_pod_set($1,$2,$3)',[name,head,members]);
  return {ok:true};
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/hr/cofounders',req=>tx(req,async(c,v)=>{
  staff(v);const person=id(req.body.personId);
  if(!(await c.query("select id from pulse.person where id=$1 and status='active' and side='staff'",[person])).rows[0])fail(400,'Choose active staff');
  await c.query(`insert into pulse.hr_cofounder(org_id,person_id,active,assigned_by) values($1,$2,$3,$4) on conflict(org_id,person_id) do update set active=excluded.active,assigned_by=excluded.assigned_by,assigned_at=now()`,[v.org,person,req.body.active!==false,v.person]);
  return {ok:true};
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/hr/work-patterns',req=>tx(req,async(c,v)=>{
  staff(v);const b=req.body,days=Array.isArray(b.workDays)?[...new Set(b.workDays.map(Number))].sort():[];
  if(!days.length||days.length>6||days.some(d=>!Number.isInteger(d)||d<1||d>7))fail(400,'Choose one to six working days');
  if(note(b.reason).length<3)fail(400,'Add a reason');
  return (await c.query('select pulse.hr_pattern_set($1,$2,$3,$4,$5) id',[id(b.personId),days,date(b.fromDate),b.toDate?date(b.toDate):null,note(b.reason)])).rows[0];
 }));
}
