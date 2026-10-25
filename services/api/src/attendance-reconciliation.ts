import { orgZone } from './org-time.js';
import type { PoolClient } from 'pg';
import { attendanceStatistics, type Session } from './attendance-statistics.js';
/** The suggested policy before HR keeps one, on the company's clock (the column defaults to its zone too). */
export const suggestedClosePolicy = (timezone:string) => ({version:1,timezone,promptMinutes:120,capMinutes:960,minimumDays:10,mode:'suggestion' as const,approved:false});
export type ComparableSession = Session & { comparable: string };
export function currentBaseline(entries:ComparableSession[],personId:string,today:string,comparable:string,expectedDays:number,fallbackMinutes:number|null,minimumDays=10,now=Date.now()) {
 const from=new Date(Date.parse(today+'T00:00:00Z')-27*86400000).toISOString().slice(0,10);
 // Evaluate all sessions before selecting the shift so overlaps/mixed days cannot hide anomalies.
 const all=entries.filter(e=>e.personId===personId),rows=all.filter(e=>e.date>=from&&e.date<=today),stats=attendanceStatistics(all,now);
 const recorded=[...stats.days.values()].filter(d=>d.date>=from&&d.date<=today&&rows.filter(e=>e.date===d.date).every(e=>e.comparable===comparable));
 const values=recorded.filter(d=>d.eligible).map(d=>d.minutes!).sort((a,b)=>a-b),n=values.length;
 const median=n?(values[Math.floor((n-1)/2)]+values[Math.floor(n/2)])/2:null;
 return {from,to:today,windowDays:28,sampleDays:n,recordedDays:recorded.length,expectedDays,coverage:expectedDays?n/expectedDays:null,
  recordedCoverage:recorded.length?n/recorded.length:null,minimumDays,medianMinutes:n>=minimumDays?median:null,
  minutes:n>=minimumDays?median:fallbackMinutes,source:n>=minimumDays?'accepted_comparable_shifts':fallbackMinutes===null?'unknown':'confirmed_shift_policy',
  provisional:true,label:'Current 28-day baseline',comparable};
}
export function closeSuggestion(start:string|Date,end:string|Date,now:number,policy:{promptMinutes:number;capMinutes:number;approved:boolean},longShift=false) {
 const a=new Date(start).getTime(),z=new Date(end).getTime();
 if(!Number.isFinite(a)||!Number.isFinite(z)||a>now||z<a)return {state:'needs_review',proposedEnd:null,payrollApproved:false};
 const cap=a+policy.capMinutes*60000,proposed=Math.min(z,cap);
 return {state:longShift?'long_shift_review':now>=cap?'provisional_close_suggestion':now>=z+policy.promptMinutes*60000?'done_for_day_prompt':'waiting',
  proposedEnd:new Date(proposed).toISOString(),policyApproved:policy.approved,payrollApproved:false};
}
/** Suggestion worker: SELECTs only. Caller can enforce a read-only transaction. No attendance/outbox writes. */
export async function attendanceDryRun(c:PoolClient,who:string) {
 const policy=(await c.query(`select version,timezone,prompt_minutes "promptMinutes",cap_minutes "capMinutes",minimum_days "minimumDays",mode,approved_at is not null approved
 from pulse.attendance_close_policy order by version desc limit 1`)).rows[0]??suggestedClosePolicy(await orgZone(c));
 const rows=(await c.query(`select e.id,e.work_date::text date,e.checked_in_at "in",p.proposed_end "proposedEnd",e.checked_out_at "originalOut",
 coalesce(s.end_time,h.shift_end) "shiftEnd",coalesce(s.start_time,h.shift_start) "shiftStart",extract(epoch from now())*1000 "nowMs"
 from pulse.attendance_entry e join pulse.hr_policy h on h.org_id=e.org_id
 left join pulse.attendance_provisional_close p on p.entry_id=e.id
 left join lateral(select s.* from pulse.person_shift a join pulse.shift s on s.id=a.shift_id where a.person_id=e.person_id and a.mode=e.mode and a.valid_from<=e.work_date and (a.valid_to is null or a.valid_to>=e.work_date) order by a.valid_from desc limit 1)s on true
 where e.person_id=$1 and e.voided_at is null and (e.checked_out_at is null or e.missed_out)
 and not exists(select 1 from pulse.attendance_correction_time t join pulse.attendance_regularisation r on r.id=t.regularisation_id where t.entry_id=e.id and r.status='approved' and r.kind<>'late') order by e.work_date`,[who])).rows;
 const queue=[];
 for(const r of rows){
  const end=(await c.query(`select (($1::date+case when $3::time<=$4::time then 1 else 0 end+$3::time) at time zone $2) stamp`,[r.date,policy.timezone,r.shiftEnd,r.shiftStart])).rows[0].stamp;
  queue.push({...r,suggestion:closeSuggestion(r.in,end,Number(r.nowMs),policy,new Date(end).getTime()-new Date(r.in).getTime()>policy.capMinutes*60000)});
 }
 return {policy,automaticClosureEnabled:false,dryRun:true,queue};
}
export async function reconciliationBundle(c:PoolClient,who:string,today:string,mode="office") {
 const dry=await attendanceDryRun(c,who),from=new Date(Date.parse(today+'T00:00:00Z')-27*86400000).toISOString().slice(0,10);
 const shifts=(await c.query(`select d::date::text date,coalesce(s.id::text,'org')||':'||$4::text comparable,
 pulse.hr_working($1,d::date,coalesce(s.work_days,h.work_days)) working,
 case when h.confirmed_at is not null then (extract(epoch from (coalesce(s.end_time,h.shift_end)-coalesce(s.start_time,h.shift_start)))::int/60+1440)%1440 else null end "fallbackMinutes"
 from pulse.hr_policy h cross join generate_series($2::date,$3::date,interval '1 day')d
 left join lateral(select s.* from pulse.person_shift a join pulse.shift s on s.id=a.shift_id where a.person_id=$1 and a.mode=$4 and a.valid_from<=d::date and (a.valid_to is null or a.valid_to>=d::date) order by a.valid_from desc limit 1)s on true`,[who,from,today,mode])).rows;
 const key=shifts.find(d=>d.date===today)?.comparable??'org:'+mode;
 const rows=(await c.query(`select e.id,e.person_id "personId",e.work_date::text date,e.checked_in_at "in",e.checked_out_at "out",e.missed_out "missedOut",0 worked,
 coalesce(s.id::text,'org')||':'||e.mode comparable,
 exists(select 1 from pulse.attendance_regularisation r where r.person_id=e.person_id and r.work_date=e.work_date and r.status='pending' and r.kind='missed_punch') "pendingCorrection",
 coalesce((select jsonb_agg(jsonb_build_object('in',b.started_at,'out',b.ended_at)) from pulse.attendance_break b where b.entry_id=e.id),'[]') breaks
 from pulse.attendance_effective e left join lateral(select a.shift_id id from pulse.person_shift a where a.person_id=e.person_id and a.mode=e.mode and a.valid_from<=e.work_date and (a.valid_to is null or a.valid_to>=e.work_date) order by a.valid_from desc limit 1)s on true
 where e.person_id=$1 and (e.work_date between $2::date and $3::date or exists(select 1 from pulse.attendance_effective peer
 where peer.person_id=e.person_id and peer.work_date between $2::date and $3::date
 and e.checked_in_at<coalesce(peer.checked_out_at,now()) and coalesce(e.checked_out_at,now())>peer.checked_in_at))`,[who,from,today])).rows;
 const eligibility=attendanceStatistics(rows);
 for(const r of rows){
  const flagged=eligibility.sessions.get(r.id)!;
  if(!flagged.eligible&&!dry.queue.some(q=>q.id===r.id)){
   const original=(await c.query('select checked_in_at "in",checked_out_at "originalOut" from pulse.attendance_entry where id=$1',[r.id])).rows[0];
   dry.queue.push({...r,...original,proposedEnd:null,suggestion:{state:'needs_review',proposedEnd:null,payrollApproved:false},reasons:flagged.labels});
  }
 }
 const baseline=currentBaseline(rows,who,today,key,shifts.filter(d=>d.working&&d.comparable===key).length,shifts.find(d=>d.date===today)?.fallbackMinutes??null,dry.policy.minimumDays);
 const historicalMonthly=(await c.query(`select month::text "month",source_key "sourceKey",month_label "monthLabel",leave_days "leaveDays",wfh_days "wfhDays",half_days "halfDays",basis,confidence from pulse.hr_month_history h where person_id=$1 and month is not null and pulse.hr_month_resolved(h) order by month desc limit 12`,[who])).rows;
 return {...dry,baseline,historicalMonthly:{label:'Historical monthly reports — separate from daily baseline',dailyPunchesDerived:false,summary:monthlyBaseline(historicalMonthly),rows:historicalMonthly}};
}

/** Monthly count summaries retain monthly units; conflicting duplicate months and unknowns are excluded. */
export function monthlyBaseline(rows:{month:string;leaveDays:number|string|null;wfhDays:number|string|null;halfDays:number|string|null}[]) {
 const months=new Map<string,typeof rows>();
 for(const r of rows)months.set(r.month,[...(months.get(r.month)??[]),r]);
 const result:Record<string,{median:number|null;sampleMonths:number}>={};
 for(const key of ['leaveDays','wfhDays','halfDays'] as const){
  const values:number[]=[];
  for(const group of months.values()){
   const counts=group.map(r=>r[key]===null?null:Number(r[key]));
   if(counts.some(n=>n===null||!Number.isFinite(n)||Number(n)<0)||new Set(counts).size!==1)continue;
   values.push(counts[0]!);
  }
  values.sort((a,b)=>a-b);const n=values.length;
  result[key]={median:n?(values[Math.floor((n-1)/2)]+values[Math.floor(n/2)])/2:null,sampleMonths:n};
 }
 return {label:'Reported monthly count baseline',identityAndEligibilityApproved:false,hoursBaseline:null,counts:result};
}
