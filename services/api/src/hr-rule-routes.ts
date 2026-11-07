import { ORG_TZ, orgZone } from './org-time.js';
import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import {fail,hr,type Tx,type Viewer} from './routes.js';
import {activeRule,noticeFlag,proposalsFor,validateConfig,type Rule,type RuleKey} from './hr-rules.js';
const staff=(v:Viewer)=>{if(!hr(v)||!v.person)fail(403,'HR access required');};
const date=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v?v:fail(400,'Choose a valid date');
const id=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(v)?v:fail(400,'Choose a person');
export async function ruleVersions(c:PoolClient):Promise<Rule[]> {return (await c.query('select key,version,config,effective_from::text "effectiveFrom",confirmed_at "confirmedAt" from pulse.hr_rule_version order by key,version')).rows;}
export async function ruleNotice(c:PoolClient,person:string,from:string,to:string,days:number,today:string) {
 const rule=activeRule(await ruleVersions(c),'advance_notice',today);
 const n=(await c.query(`select count(*)::int n from generate_series($2::date+1,$3::date,interval '1 day') d where pulse.hr_person_working($1,d::date)`,[person,today,from])).rows[0].n;
 return {flag:noticeFlag(rule,days,n,Math.floor((Date.parse(from)-Date.parse(today))/86400000)),days,from,to};
}
export function registerHrRuleRoutes(app:FastifyInstance,{tx}:{tx:Tx}) {
 app.get('/api/v0/hr/rules',req=>tx(req,async(c,v)=>{
  staff(v);await c.query('select pulse.hr_emergency_remind()');const today=(await c.query(`select (now() at time zone ${ORG_TZ})::date::text today`)).rows[0].today;
  return {proposals:proposalsFor(await orgZone(c)),versions:await ruleVersions(c),today,
   people:(await c.query(`select p.id,p.display_name name,e.probation_from::text "probationFrom",e.probation_to::text "probationTo",e.notice_from::text "noticeFrom",e.notice_to::text "noticeTo",e.last_working_day::text "lastWorkingDay",e.settlement_target::text "settlementTarget",coalesce(e.handover,'[]') handover,e.pt_category "ptCategory",e.pt_state "ptState",coalesce(e.pt_exempt,false) "ptExempt" from pulse.person p join pulse.people_profile pp on pp.person_id=p.id left join pulse.hr_employment e on e.person_id=p.id where p.side='staff' order by p.display_name`)).rows,
   emergencies:(await c.query(`select e.id,e.person_id "personId",p.display_name name,e.from_date::text "fromDate",e.return_date::text "returnDate",e.record_by::text "recordBy",e.leave_id "leaveId",e.reason,e.record_by<$1::date and e.leave_id is null overdue from pulse.hr_emergency e join pulse.person p on p.id=e.person_id order by e.record_by`,[today])).rows};
 }));
 for(const action of ['preview','confirm'])app.post<{Body:Record<string,unknown>}>('/api/v0/hr/rules/'+action,{schema:{body:{type:'object',additionalProperties:true}}},req=>tx(req,async(c,v)=>{
  staff(v);const b=req.body,key=String(b.key) as RuleKey;let config:Record<string,unknown>;
  const zone=await orgZone(c);try{config=validateConfig(key,b.config,zone);}catch(e){fail(400,e instanceof Error?e.message:'Check the settings');}
  const effective=date(b.effectiveFrom);
  if(action==='preview') {
   if(key!=='leave_balance')fail(400,'Only balances need a preview');
   return (await c.query('select pulse.hr_balance_preview($1,$2) data',[JSON.stringify(config!),effective])).rows[0].data;
  }
  if(b.confirm!==true)fail(400,'Confirm and turn on this rule');
  if(!Number.isInteger(b.version)||Number(b.version)<0)fail(400,'Refresh the current rule version');
  return (await c.query('select pulse.hr_rule_confirm($1,$2,$3,$4,$5) version',[key,JSON.stringify(config!),effective,b.version,b.previewHash??null])).rows[0];
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/hr/rules/waive',{schema:{body:{type:'object',additionalProperties:true}}},req=>tx(req,async(c,v)=>{
  staff(v);await c.query('select pulse.hr_late_waive($1,$2,$3)',[id(req.body.personId),date(req.body.date),String(req.body.reason??'').trim()]);return {ok:true};
 }));
 app.post<{Params:{id:string};Body:Record<string,unknown>}>('/api/v0/hr/employment/:id',{schema:{body:{type:'object',additionalProperties:true}}},req=>tx(req,async(c,v)=>{
  staff(v);const data={...req.body};
  for(const key of ['probationFrom','probationTo','noticeFrom','noticeTo','lastWorkingDay','settlementTarget'])data[key]=data[key]?date(data[key]):null;
  const today=(await c.query(`select (now() at time zone ${ORG_TZ})::date::text today`)).rows[0].today;
  const rule=activeRule(await ruleVersions(c),'exit',today);
  if(rule&&data.noticeFrom&&!data.noticeTo) {
   const probation=!!data.probationFrom&&String(data.probationFrom)<=String(data.noticeFrom)&&String(data.probationTo)>=String(data.noticeFrom);
   data.noticeTo=new Date(Date.parse(String(data.noticeFrom))+(Number(probation?rule.config.probationDays:rule.config.confirmedDays)-1)*86400000).toISOString().slice(0,10);
  }
  if(rule&&data.lastWorkingDay&&!data.settlementTarget)data.settlementTarget=new Date(Date.parse(String(data.lastWorkingDay))+Number(rule.config.settlementDays)*86400000).toISOString().slice(0,10);
  if(!Array.isArray(data.handover)||data.handover.length>30||data.handover.some(item=>!item||typeof item!=='object'||typeof item.label!=='string'||item.label.trim().length<1||item.label.length>200||typeof item.done!=='boolean'))fail(400,'Add a checklist of labels and completion status');
  await c.query('select pulse.hr_employment_save($1,$2)',[id(req.params.id),JSON.stringify(data)]);return {ok:true};
 }));
 app.get<{Querystring:{from:string;to:string;kind:string;half?:string}}>('/api/v0/leave/notice',req=>tx(req,async(c,v)=>{
  if(!v.person)fail(403,'Sign in');const from=date(req.query.from),to=date(req.query.to);if(to<from||Date.parse(to)-Date.parse(from)>366*86400000)fail(400,'Check the dates');
  const today=(await c.query(`select (now() at time zone ${ORG_TZ})::date::text today`)).rows[0].today;
  const days=(await c.query(`select count(*)::int n from generate_series($2::date,$3::date,interval '1 day') d where pulse.hr_person_working($1,d::date)`,[v.person,from,to])).rows[0].n*(req.query.half&&from===to?.5:1);
  return ruleNotice(c,v.person!,from,to,days,today);
 }));
 app.get('/api/v0/leave/emergencies',req=>tx(req,async(c,v)=>({rows:(await c.query(`select id,from_date::text "fromDate",return_date::text "returnDate",record_by::text "recordBy",leave_id "leaveId" from pulse.hr_emergency where person_id=$1 order by notified_at desc`,[v.person])).rows,rule:activeRule(await ruleVersions(c),'emergency',(await c.query(`select (now() at time zone ${ORG_TZ})::date::text today`)).rows[0].today)??null})));
 app.post<{Body:Record<string,unknown>}>('/api/v0/leave/emergency',{schema:{body:{type:'object',additionalProperties:true}}},req=>tx(req,async(c)=> (await c.query('select pulse.hr_emergency_notify($1,$2,$3) id',[date(req.body.fromDate),date(req.body.returnDate),String(req.body.reason??'').trim()])).rows[0]));
 app.get<{Params:{id:string};Querystring:{month?:string}}>('/api/v0/hr/payslip/:id',req=>tx(req,async(c,v)=>{
  const who=id(req.params.id);if(who!==v.person&&!hr(v))fail(403,'Payslips are private');
  const month=req.query.month??new Date().toISOString().slice(0,7);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail(400,'Choose a month');
  // R43: an employee reads only payslips HR issued; projecting one from salary records is HR's review step (0251).
  // My desk asks with issued=1, so HR's own desk shows their issued slips too, not a projection.
  const q=req.query as {projection?:string;issued?:string};
  const salary=hr(v)&&q.issued!=='1'&&(await c.query("select pulse.hr_can('hr.salary.read') ok")).rows[0].ok;
  const issued=(await c.query('select pulse.hr_payslip_read($1,$2) data',[who,`${month}-01`])).rows[0].data;
  if(!salary&&!issued)fail(404,'No payslip has been issued for this month');
  const data=salary&&q.projection==='1'?null:issued;
  const result=data??(await c.query('select pulse.hr_payslip_project($1,$2) data',[who,`${month}-01`])).rows[0].data;
  if(!result)fail(404,'No salary entry for this month');
  return {...result,canIssue:salary&&(await c.query("select pulse.hr_can('hr.salary.write') ok")).rows[0].ok};
 }));
 app.post<{Params:{id:string};Body:Record<string,unknown>}>('/api/v0/hr/payslip/:id',{schema:{body:{type:'object',additionalProperties:true}}},req=>tx(req,async(c,v)=>{
  staff(v);if(req.body.confirm!==true)fail(400,'Confirm the reviewed payslip');
  const month=String(req.body.month??'');if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail(400,'Choose a salary month');
  return (await c.query('select pulse.hr_payslip_issue($1,$2,$3) data',[id(req.params.id),`${month}-01`,req.body.previewHash??null])).rows[0].data;
 }));
}
