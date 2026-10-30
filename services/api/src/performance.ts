import type { FastifyInstance } from 'fastify';
import { admin, fail, leadership, type Tx } from './routes.js';
import { attendanceEnabled, ATTENDANCE_OFF_MESSAGE } from './attendance-policy.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id=(x:unknown)=>!x?null:UUID.test(String(x))?String(x):fail(400,'Choose a valid record');
export function registerPerformanceRoutes(app:FastifyInstance,{tx}:{tx:Tx}){
 app.get('/api/v0/performance',req=>tx(req,async(c,v)=>{
  const enabled=await attendanceEnabled(c);
  if(!v.person)fail(403,'An individual employee login is required');const q=req.query as {person?:string;scope?:string};if(q.scope==='company'&&!leadership(v))fail(403,'Leadership sees company performance');
  const who=q.person?id(q.person):q.scope==='company'?null:v.person;
  if(who&&who!==v.person&&!leadership(v)&&!(await c.query('select pulse.manages($1) ok',[who])).rows[0].ok)fail(403,'Performance is limited to your own and assigned team');
  await c.query("select pulse.audit_write('restricted_read','performance', $1)",[who]);
  const people=(await c.query(`select p.id,p.display_name name,pp.pod,pp.role,
   (select count(*)::int from pulse.task t where t.owner_id=p.id) "taskCount",
   (select count(*)::int from pulse.task t where t.owner_id=p.id and t.status='done') "doneTasks",
   (select count(*)::int from pulse.task t where t.owner_id=p.id and t.status='blocked') "blockedTasks",
   (select count(*)::int from pulse.task t where t.owner_id=p.id and t.status='unknown') "unknownTasks",
   (select count(*)::int from pulse.activity_observation a where a.actor_id=p.id and a.operation in ('upload','create') and a.at>=now()-interval '84 days') "observedActions",
   (select count(distinct d.file_id)::int from pulse.delivery d join pulse.delivery_actor a using(org_id,file_id) where a.actor_id=p.id and d.delivered_at>=now()-interval '84 days') deliveries,
   (select count(distinct d.file_id)::int from pulse.delivery d join pulse.delivery_actor a using(org_id,file_id) where a.actor_id=p.id) "allTimeDeliveries",
   case when $4::boolean then (select count(*)::int from pulse.attendance_entry e where e.person_id=p.id and e.work_date>=current_date-84) end "attendanceDays",
   (select count(*)::int from pulse.work_event e where e.person_id=p.id and e.observed_at>=now()-interval '84 days') "workEvents",
   (select count(*)::int from pulse.work_unit e where e.person_id=p.id) "workUnits",
   (select count(*)::int from pulse.quality_signal e where e.person_id=p.id and e.observed_at>=now()-interval '84 days') "qualitySignals",
   (select count(*)::int from pulse.outcome_signal e where e.person_id=p.id and e.observed_at>=now()-interval '84 days') "outcomeSignals"
   from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and p.status='active' and ($1::uuid is null or p.id=$1)
   and ($2::boolean or p.id=$3 or pulse.manages(p.id)) order by p.display_name`,[who,leadership(v),v.person,enabled])).rows;
  const weeks=(await c.query(`with subjects as (select p.id from pulse.person p where p.side='staff' and p.status='active' and ($1::uuid is null or p.id=$1) and ($2::boolean or p.id=$3 or pulse.manages(p.id)))
   select s.id "personId",w::date::text week,count(distinct d.file_id)::int deliveries from subjects s cross join generate_series(date_trunc('week',now())-interval '77 days',date_trunc('week',now()),interval '7 days') w
   left join pulse.delivery_actor a on a.actor_id=s.id left join pulse.delivery d on d.file_id=a.file_id and d.delivered_at>=w and d.delivered_at<w+interval '7 days' group by s.id,w order by w`,[who,leadership(v),v.person])).rows;
  const pods=Object.values(people.reduce<Record<string,{name:string;people:number;deliveries:number;taskCount:number;doneTasks:number;observedActions:number;qualitySignals:number;outcomeSignals:number}>>((a,p)=>{const key=p.pod??'Pod not assigned';const x=a[key]??={name:key,people:0,deliveries:0,taskCount:0,doneTasks:0,observedActions:0,qualitySignals:0,outcomeSignals:0};x.people++;for(const f of ['deliveries','taskCount','doneTasks','observedActions','qualitySignals','outcomeSignals'] as const)x[f]+=Number(p[f])||0;return a;},{}));
  return {attendanceEnabled:enabled,people,pods,weeks,period:'Last 12 weeks',taskPeriod:'Imported tracker status snapshots across available history',detail:'Qualified upload/create observations support attribution. Shared accounts and unknown actors stay uncredited. File totals and presence are context, not quality or productivity scores.',connections:[{source:'Drive / tracker / Pulse',state:'Observed data'},{source:'Desktop app',state:'Intake contract prepared; not connected'},{source:'Editing app',state:'Intake contract prepared; not connected'},{source:'Office / CCTV events',state:'Presence metadata intake prepared; not connected'}]};
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/performance/events',{schema:{body:{type:'object'}}},req=>tx(req,async(c,v)=>{
  if(!admin(v))fail(403,'Only an administrator can submit connector observations');
  if(String(req.body.primitive)==='attendance'&&!(await attendanceEnabled(c)))fail(403,ATTENDANCE_OFF_MESSAGE);
  const b=req.body,at=String(b.observedAt??'');if(!Number.isFinite(Date.parse(at))||!['work_unit','work_event','quality_signal','outcome_signal','attendance'].includes(String(b.primitive)))fail(400,'Choose a primitive and valid observation time');
  const result=(await c.query('select pulse.performance_submit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) id',[b.primitive,id(b.personId),id(b.projectId),id(b.workUnitId),b.kind,b.value??null,b.status??'unknown',b.source,b.sourceRef,at,b.confidence??1])).rows[0];return {ok:true,id:result.id,replayed:!result.id};
 }));
}
