import { orgZone } from './org-time.js';
import type {FastifyInstance} from 'fastify';import type {PoolClient} from 'pg';
import {fail,hr,type Tx,type Viewer} from './routes.js';import {briefSlot,type Schedule} from './brief-model.js';
import {persistInsights,projectIntelligence,receiptAllowed} from './intelligence.js';import {digest,RULE_VERSION,type Insight} from './intelligence-model.js';
const VERSION='role-brief-1';
async function authority(c:PoolClient,v:Viewer) {const projects=(await c.query('select unnest(pulse.work_projects())::text id')).rows.map(r=>r.id).sort();const grants=(await c.query("select pulse.money_can('money.read') money,pulse.hr_can('hr.salary.read') salary")).rows[0];return digest([v.org,v.person,v.role,projects,grants]);}
async function schedule(c:PoolClient,v:Viewer) {
 const pref=(await c.query('select * from pulse.brief_preference')).rows[0],zone=await orgZone(c);
 const now=new Date((await c.query('select now() as now_at')).rows[0].now_at);
 const shift=(await c.query('select s.start_time::text start,s.end_time::text as end_time,s.work_days from pulse.person_shift ps join pulse.shift s on s.id=ps.shift_id where ps.person_id=$1 and ps.valid_from<=(now() at time zone $2)::date and (ps.valid_to is null or ps.valid_to>=(now() at time zone $2)::date) order by ps.valid_from desc limit 1',[v.person,pref?.timezone??zone])).rows[0];
 const holidays=(await c.query('select day::text as date_key from pulse.holiday where not optional')).rows.map(r=>r.date_key);
 const leaveDates=(await c.query("select from_date::text as from_day,to_date::text as to_day from pulse.leave_request where person_id=$1 and status='approved'",[v.person])).rows.map(r=>({from:r.from_day,to:r.to_day}));
 const s:Schedule={subscribed:pref?.subscribed??true,timezone:pref?.timezone??zone,dailyTime:pref?.daily_time??null,weeklyDay:pref?.weekly_day??1,quietStart:(pref?.quiet_start??'22:00').slice(0,5),quietEnd:(pref?.quiet_end??'07:00').slice(0,5),shift:shift?{start:shift.start.slice(0,5),end:shift.end_time.slice(0,5),workDays:shift.work_days}:null,holidays,leaveDates};
 return {settings:s,slot:briefSlot(now,s),now};
}
const focus=(v:Viewer)=>hr(v)&&v.role==='hr'?'HR approval, calendar and correction actions':['manager','pgs'].includes(v.role)?'Blockers, review windows and launch decisions':v.role==='leadership'?'Authorized portfolio and data-health decisions':'Own deliverables, reviews and personal progress';
async function readBriefs(c:PoolClient,v:Viewer){
  if(!v.person)fail(403,'An individual account receives role briefs');
  const s=await schedule(c,v),scope=await authority(c,v);
  if(s.slot.ready) {
   await c.query('select pg_advisory_xact_lock(hashtext($1))',[v.org+':brief:'+v.person]);
   const surface=v.role==='hr'?'hr':v.role==='leadership'?'leadership':'dashboard';
   const cards=await persistInsights(c,v,surface),positive=cards.find(x=>x.severity===0),priorities=cards.filter(x=>x.severity>0).slice(0,3);
   const sourceCaveats=cards.flatMap(x=>x.facts.filter(f=>f.freshness!=='current').map(f=>({fact_id:f.id,freshness:f.freshness,statement:f.statement})));
   const old=(await c.query('select packet from pulse.role_brief where authority=$1 order by created_at desc limit 1',[scope])).rows[0]?.packet;
   const changed=old?cards.flatMap(card=>{const before=(old.snapshots as Insight[]).find(x=>x.cause_key===card.cause_key);return before&&before.id!==card.id?[{prior_id:before.id,current_id:card.id,label:'Source facts revised'}]:[]}):[];
   for(const kind of ['daily',...(s.slot.dow===s.settings.weeklyDay?['weekly']:[])]) {
    const id=digest([v.org,v.person,kind,s.slot.workDate,VERSION]);
    const packet={version:VERSION,rule_version:RULE_VERSION,focus:focus(v),as_of:s.now.toISOString(),priorities:priorities.map(x=>x.id),positive:positive?.id??null,missing_input:cards.find(x=>x.facts.some(f=>f.freshness==='unknown'||f.freshness==='stale'))?.id??null,snapshots:cards,source_caveats:sourceCaveats,weekly:{trend:'Insufficient comparable complete weekly periods; no trend alarm.',unresolved_decision:priorities[0]?.id??null,next_experiment:'Confirm the highest-impact missing source, then rate the recommendation after observing the result.',source_changes:changed},caveat:'No model-derived causal or probability claim. External delivery channels are disabled.'};
    await c.query('insert into pulse.role_brief(org_id,id,viewer_id,kind,work_date,version,authority,packet) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing',[v.org,id,v.person,kind,s.slot.workDate,VERSION,scope,JSON.stringify(packet)]);
   }
  }
  const rows=(await c.query('select id,kind,work_date::text,version,authority,packet,created_at from pulse.role_brief order by work_date desc,kind limit 20')).rows;
  const briefs=[];for(const r of rows) {
   if(r.authority!==scope){briefs.push({id:r.id,kind:r.kind,work_date:r.work_date,state:'Access changed; frozen packet withheld',packet:null});continue;}
   const allowed=[];for(const p of r.packet.snapshots as Insight[])if(await receiptAllowed(c,v,p))allowed.push(p);
   if(allowed.length!==r.packet.snapshots.length){briefs.push({id:r.id,kind:r.kind,work_date:r.work_date,state:'Permission revoked; delivery cancelled',packet:null});continue;}
   const revisions=[];for(const p of allowed){const current=(await projectIntelligence(c,v,p.surface)).find(x=>x.cause_key===p.cause_key);if(current&&current.id!==p.id)revisions.push({id:p.id,state:'Source revised since this brief'});else if(!current)revisions.push({id:p.id,state:'Condition no longer present'});}
   briefs.push({...r,authority:undefined,state:'Frozen evidence vintage',revisions});
  }
  return {briefs,settings:s.settings,schedule:s.slot,channel:'in_app_only',focus:focus(v),pilot:{state:'Proposed two-week pilot; no recipient outcome collected yet',target:'At least 70% rate one card useful; measure irrelevant and false alerts before expansion.'}};
 }
export function registerBriefRoutes(app:FastifyInstance,{tx}:{tx:Tx}) {
 app.get('/api/v0/briefs',req=>tx(req,readBriefs));
 app.get('/api/v0/briefs/tick',req=>tx(req,async(c,v)=>{
  const data=await readBriefs(c,v),ids=[];
  for(const b of data.briefs)if(b.packet&&b.work_date===data.schedule.workDate&&data.schedule.ready){const delivered=(await c.query('update pulse.role_brief set delivered_at=now() where id=$1 and delivered_at is null returning id',[b.id])).rows[0];if(delivered){ids.push(delivered.id);await c.query("select pulse.audit_write('brief_delivered','in_app_brief',$1)",[delivered.id]);}}
  return {ready_ids:ids,label:'Your role brief is ready',href:'/briefs',channel:'in_app_only'};
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/briefs/preferences',req=>tx(req,async(c,v)=>{
  if(!v.person)fail(403,'An individual account sets its brief schedule');const b=req.body,tz=String(b.timezone??await orgZone(c)),time=b.dailyTime?String(b.dailyTime):null,qs=String(b.quietStart??'22:00'),qe=String(b.quietEnd??'07:00'),weekday=Number(b.weeklyDay??1);
  try{new Intl.DateTimeFormat('en',{timeZone:tz});}catch{fail(400,'Choose a valid timezone');}
  if([time,qs,qe].some(t=>t&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(t))||!Number.isInteger(weekday)||weekday<1||weekday>7)fail(400,'Choose valid local times and a weekly work day');
  await c.query('insert into pulse.brief_preference(org_id,viewer_id,subscribed,timezone,daily_time,weekly_day,quiet_start,quiet_end) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(viewer_id) do update set subscribed=excluded.subscribed,timezone=excluded.timezone,daily_time=excluded.daily_time,weekly_day=excluded.weekly_day,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end,updated_at=now()',[v.org,v.person,b.subscribed!==false,tz,time,weekday,qs,qe]);
  await c.query("select pulse.audit_write('brief_preference','own_brief')");return {ok:true};
 }));
}
