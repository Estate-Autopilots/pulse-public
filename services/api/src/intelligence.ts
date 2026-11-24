import { orgZone } from './org-time.js';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { admin, leadership, hr, fail, type Tx, type Viewer } from './routes.js';
import { digest, makeInsight, rank, SURFACES, RULE_VERSION, surfaceFor, workingDaysLate, type Candidate, type Fact, type Insight } from './intelligence-model.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const receiptSubject=(p:Insight)=>{const id=p.cause_key.split(':')[1];return UUID.test(id)?id:null;};
const stamp=(value:unknown)=>value instanceof Date?value.toISOString():String(value??'');
export const taskScope=`(pulse.viewer_is('admin','leadership') or t.owner_id=pulse.current_viewer() or t.assignee_person_id=pulse.current_viewer() or t.review_owner_id=pulse.current_viewer() or pulse.manages(t.owner_id) or t.project_id=any(pulse.work_projects()))`;
export async function surfaceAllowed(c:PoolClient,v:Viewer,surface:string) {
 const domain=SURFACES[surface]?.domain;
 if(v.role==='client')return false; // distinct portal principal/projection is a later intake; fail closed now
 if(domain==='finance')return !!(await c.query("select pulse.money_can('money.read') ok")).rows[0].ok;
 if(domain==='payroll')return !!(await c.query("select pulse.hr_can('hr.salary.read') ok")).rows[0].ok;
 if(domain==='hr')return hr(v);
 if(domain==='review')return hr(v);
 if(domain==='audit')return leadership(v);
 if(domain==='work'||domain==='identity')return v.role!=='hr';
 return !!v.person;
}
export async function receiptAllowed(c:PoolClient,v:Viewer,p:Insight) {
 if(!v.person||p.audience_scope!==`person:${v.person}`||p.org_id!==v.org||!await surfaceAllowed(c,v,p.surface))return false;
 for(const f of p.facts) {
  if(f.source_ref.kind==='task'&&!(await c.query(`select 1 from pulse.task t where id=$1 and ${taskScope}`,[f.source_ref.id])).rows.length)return false;
  if(f.source_ref.kind==='review'&&!admin(v))return false;
  if(f.source_ref.kind==='assertion'&&(!admin(v)||!(await c.query('select 1 from pulse.identity_assertion where id=$1',[f.source_ref.id])).rows.length))return false;
 }
 return true;
}
export async function projectIntelligence(c:PoolClient,v:Viewer,surface:string,subject:string|null=null):Promise<Insight[]> {
 if(!v.person||!await surfaceAllowed(c,v,surface))return [];
 const now=stamp((await c.query('select now() as now_at')).rows[0].now_at),meta=SURFACES[surface];
 const candidates:Candidate[]=[];
 const fact=(kind:string,id:string,href:string,statement:string,version:string,observed:string,freshness:Fact['freshness']='current',occurred:string|null=null,classification:Fact['classification']='work'):Fact=>({id:digest([kind,id,version,statement,freshness]),source_ref:{kind,id,href},occurred_at:occurred,observed_at:observed,subject_ref:`${kind}:${id}`,classification,freshness,override_version:version,statement});
 const add=(cause:string,headline:string,meaning:string,facts:Fact[],action:Candidate['next_action'],extra:Partial<Candidate>={})=>candidates.push({cause_key:`${surface}:${subject??"all"}:${cause}:${RULE_VERSION}`,surface,headline,meaning,facts,next_action:action,subject_refs:facts.map(f=>f.subject_ref),sample_n:facts.length,coverage:'Selected authorized records; completeness not established',confidence_label:'Confirmed fact',baseline:'No performance baseline is assumed.',hypotheses:[],exclusions:['Private chat, salary values and financial amounts are excluded.'],correction_href:meta.href,severity:1,urgency:1,actionability:2,evidence_strength:3,...extra});
 const action=(label:string,href:string,owner:string|null=null,effect='Open the exact source before changing it.')=>({label,href,owner,authority:admin(v)?'An individual admin can correct this record.':'Read-only here; ask the record owner for corrections.',effect});
 if(surface==='demo'){
  const sample=(id:string,statement:string,freshness:Fact['freshness']='current')=>fact('demo',id,'/insights-demo',statement,'synthetic-1','2026-10-06T09:00:00Z',freshness,'2026-10-02T12:00:00Z');
  const sampleAction=action('Inspect this synthetic receipt','/insights-demo','Synthetic backup reviewer','Review the packet; this example changes no business record.');
  add('review','Synthetic review missed its agreed window','A recorded approval window passed; confirm the dependency before changing a launch plan.',[sample('review','Synthetic task: Launch approval; owner: Synthetic reviewer; due 2026-10-02 17:30 company time; one working day late at 2026-10-06 17:30, excluding the synthetic 5 October holiday.')],sampleAction,{severity:3,coverage:'One wholly synthetic review with an explicit working calendar.',baseline:'Monday–Friday calendar; synthetic 5 October holiday; agreed due time.',hypotheses:['The reviewer may await an input.','An external source delay is also possible.']});
  add('stale','Synthetic source disconnected','Confirm source availability before interpreting the review delay.',[sample('stale','The synthetic review source has no current observation.','stale')],sampleAction,{severity:2,coverage:'Wholly synthetic outage; reviewer activity is unknown.',baseline:'A stale source produces a data-health task.'});
  add('identity','Synthetic names alone remain unresolved','Contact A and Contact A Full need selected independent evidence before a merge can be reviewed.',[sample('names','Synthetic Contact A and Contact A Full have names only; no verified scoped identifier is recorded.')],sampleAction,{coverage:'Two synthetic person contacts; names alone never match.'});
  add('identifier','Synthetic verified CRM evidence supports comparison','A matching scoped CRM ID opens a reviewed comparison; the person stays separate from represented firms.',[sample('identifier','Two synthetic person contacts carry verified CRM ID contact-42 within synthetic.crm.contacts.')],sampleAction,{severity:1,coverage:'One trusted scoped identifier family; no calibrated probability.'});
  add('done','Synthetic completion retires the overdue condition','A source completion changes the recorded state; it does not establish that the recommendation caused the improvement.',[sample('done','Synthetic Launch approval is now recorded done in a revised source receipt.')],sampleAction,{severity:0,urgency:0,coverage:'Wholly synthetic observed completion; no causal estimate.'});
 }
 if(['dashboard','projects','tasks','leadership'].includes(surface)) {
  const tasks=(await c.query(`select t.id,t.title,t.status,t.source,t.source_ref,t.updated_at,t.review_due_at,t.review_calendar,t.review_work_days,
    t.review_owner_id,pe.display_name owner, t.project_id,
    (select upstream_at from pulse.sync_run where source=t.source and ok order by started_at desc limit 1) upstream,
    (select ok from pulse.sync_run where source=t.source order by started_at desc limit 1) source_ok
    from pulse.task t left join pulse.person pe on pe.id=t.review_owner_id
    where ${taskScope} and ($1::uuid is null or t.project_id=$1 or t.id=$1)
    and t.status='in_review' order by t.review_due_at nulls last,t.id limit 100`,[subject])).rows;
  const holidays=(await c.query('select day::text as "day" from pulse.holiday where not optional' )).rows.map(r=>r.day);
  const late=tasks.filter(t=>t.review_due_at&&Date.parse(stamp(t.review_due_at))<Date.parse(now));
  // Related overdue symptoms share one queue card; preview contains the scoped affected records.
  const rows=late.slice(0,12);
  if(rows.length) {
   const isStale=(t:typeof rows[number])=>t.source!=='pulse'&&(!t.upstream||t.source_ok===false||Date.parse(now)-Date.parse(stamp(t.upstream))>1800000);
   const stale=rows.some(isStale);
   const facts=rows.map(t=>fact('task',t.id,`/tasks?task=${t.id}`,isStale(t)?`Source stale for review: ${t.title}`:`${t.title}: review agreed by ${stamp(t.review_due_at)} (${t.review_calendar}); ${t.owner??'review owner missing'}; ${workingDaysLate(stamp(t.review_due_at),now,t.review_calendar,t.review_work_days,holidays)} working days after the due date.`,stamp(t.updated_at)+':'+stamp(t.review_due_at)+':'+t.review_owner_id+':'+t.status,stamp(t.updated_at),isStale(t)?'stale':'current',stamp(t.review_due_at)));
   add('review-window',stale?'Review source stale':`${rows.length} review${rows.length===1?'':'s'} past the agreed window`,stale?'Reconnect or confirm the source before interpreting the delay.':'The recorded review window has passed; confirm the handoff before changing the plan.',facts,action(stale?'Inspect review source':'Preview affected reviews','/tasks?status=in_review',rows[0].owner),{severity:stale?2:3,urgency:3,coverage:`${rows.length} of ${late.length} overdue agreed reviews shown; ${tasks.filter(t=>!t.review_due_at).length} lack an agreement in the selected queue.`,baseline:'Explicit agreed review deadline, using recorded work days, timezone and company holidays.',hypotheses:stale?['The source may be disconnected.']:['A reviewer may be waiting on an input.','The external source may be delayed.'],exclusions:['Deadline labels without explicit agreement are excluded.','No launch dependency or employee inactivity is inferred.']});
  }
  const incomplete=tasks.filter(t=>!t.review_due_at||!t.review_owner_id);
  if(incomplete.length)add('review-input','Review agreement missing','Record the reviewer and agreed window before assessing review risk.',incomplete.slice(0,3).map(t=>fact('task',t.id,`/tasks?task=${t.id}`,`${t.title}: ${!t.review_due_at?'agreed deadline missing':''}${!t.review_owner_id?' reviewer missing':''}.`,stamp(t.updated_at),stamp(t.updated_at))),action('Complete review agreement','/tasks?status=in_review'),{coverage:`${incomplete.length} incomplete review agreements in a queue capped at 100.`,evidence_strength:2});
  const done=(await c.query(`select t.id,t.title,t.updated_at from pulse.task t where ${taskScope} and t.status='done' and t.updated_at>now()-interval '7 days' and ($1::uuid is null or t.project_id=$1 or t.id=$1) order by updated_at desc limit 1`,[subject])).rows[0];
  if(done)add('progress:'+done.id,'A completed task is recorded','A recorded completion is available to check against the delivery handoff.',[fact('task',done.id,`/tasks?task=${done.id}`,`${done.title}: recorded status done.`,stamp(done.updated_at),stamp(done.updated_at))],action('Open completed task',`/tasks?task=${done.id}`),{severity:0,urgency:0});
 }
 if(surface==='clients') {
  const gaps=(await c.query("select id,display_name,entity_kind,relationship_owner_id,updated_at,renewal_on::text as renewal from pulse.client where ($1::uuid is null or id=$1) and (entity_kind='unknown' or relationship_owner_id is null or renewal_on<=current_date+30) and not exists(select 1 from pulse.record_merge where entity_type='client' and gone_id=client.id and undone_at is null) order by renewal_on nulls last,display_name limit 1",[subject])).rows;
  if(gaps.length){const g=gaps[0],due=g.renewal&&g.renewal<=now.slice(0,10);add('master:'+g.id,due?'Client term needs a decision':'Client identity needs confirmation','Confirm shared identity and an accountable owner before preparing a client action.',[fact('client',g.id,`/clients/${g.id}?tab=identity`,`${g.display_name}: entity kind ${g.entity_kind}; relationship owner ${g.relationship_owner_id?'assigned':'missing'}${g.renewal?'; explicit term date '+g.renewal:''}.`,stamp(g.updated_at),stamp(g.updated_at),'current',null,'identity')],action('Open identity & health',`/clients/${g.id}?tab=identity`),{severity:due?2:1,coverage:'One selected account; accounting history and contact authority require separate evidence.'});}
 }
 if(surface==='clients'||surface==='contacts') {
  if(admin(v)&&surface==='clients') {
   const pairs=(await c.query(`select a.id assertion_id,a.entity_id,b.entity_id other_id,cl.display_name name,a.observed_at
    from pulse.identity_assertion a join pulse.identity_assertion b on a.entity_type=b.entity_type and a.kind=b.kind and a.source_scope=b.source_scope and a.value=b.value and a.entity_id<b.entity_id
    join pulse.client cl on cl.id=a.entity_id
    where a.entity_type='client' and a.verified and b.verified and not a.shared and not b.shared and a.kind in ('external_id','organization','email','phone')
    and ($1::uuid is null or a.entity_id=$1 or b.entity_id=$1)
    and not exists(select 1 from pulse.record_merge where entity_type='client' and gone_id in(a.entity_id,b.entity_id) and undone_at is null)
    order by a.observed_at desc limit 3`,[subject])).rows;
   if(pairs.length)add('independent-identity','Independent identity evidence needs review','Verified scoped evidence supports comparison; conflicting kinds or identifiers can still block a merge.',pairs.map(p=>fact('assertion',p.assertion_id,`/clients/${p.entity_id}?tab=identity`,`Selected verified identity assertion for ${p.name}.`,p.assertion_id,stamp(p.observed_at),'current',null,'identity')),action('Compare identity evidence','/clients?tab=master&section=Identity+reviews'),{severity:2,coverage:'Up to three independent identity receipts; correlated copies do not create percentage confidence.',baseline:'Verified scoped identifiers or confirmed organisation; names alone are excluded.'});
  }
  if(admin(v)) {
   const reviews=(await c.query("select id,title,entity_id from pulse.review_item where status='pending' and kind='duplicate' and entity_type=$1 and ($2::uuid is null or entity_id=$2) order by id limit 3",[surface==='clients'?'client':'contact',subject])).rows;
   if(reviews.length)add('identity-review','Identity suggestions need review','Inspect independent evidence and association effects before choosing a survivor.',reviews.map(r=>fact('review',r.id,surface==='contacts'?'/contacts/identity':'/clients?tab=master',`Pending identity review: ${r.title}`,r.id,now,'unknown',null,'identity')),action('Review identity evidence',surface==='contacts'?'/contacts/identity':'/clients?tab=master'),{coverage:`${reviews.length} pending suggestions shown; rule confidence is not a probability.`});
  }
 }
 if(surface==='map') {
  const pins=(await c.query("select id,coalesce(name,geo_key) name,precision,updated_at from pulse.project_location where precision in ('city','locality') and ($1::uuid is null or id=$1) order by updated_at desc limit 1",[subject])).rows;
  if(pins.length)add('pin:'+pins[0].id,'This pin is approximate','Confirm a shoot site before using the point for readiness or travel.',pins.map(p=>fact('location',p.id,`/map?location=${p.id}`,`${p.name}: ${p.precision} precision.`,stamp(p.updated_at),stamp(p.updated_at))),action('Inspect pin precision',`/map?location=${pins[0].id}`),{coverage:'One selected approximate location; demand comparison maturity is unknown.'});
 }
 if(surface==='money') {
  const health=(await c.query('select pulse.finance_health() data')).rows[0].data as {sources:number;decisions:number;cases:number;closes:number};
  add('finance-controls',health.cases?'Finance cases need a reviewed resolution':health.closes?'Finance close receipts are available':'Finance sources need certification',
   'Account coverage and source decisions determine close readiness. Financial values stay inside Finance.',
   [fact('finance_controls','metadata-v1','/finance?tab=reconcile',`${health.sources} prepared source snapshots; ${health.decisions} active allocation receipts; ${health.cases} open cases; ${health.closes} close vintages.`,JSON.stringify(health),now.slice(0,10)+'T00:00:00Z','current',null,'finance_metadata')],
   action('Review Finance controls','/finance?tab=reconcile'),{coverage:'Counts reflect scoped recorded evidence; no cash total or forecast is inferred.',baseline:'Signed opening / inflow / outflow / closing controls are checked in Finance.',exclusions:['Amounts, source labels and individual payroll evidence stay out of general intelligence.'],severity:health.cases?2:1});
 }
 // Truthful setup state for each registered page, including private domain providers with no values.
 if(!candidates.length) {
  const classification:Fact['classification']=meta.domain==='hr'||meta.domain==='payroll'?'hr':meta.domain==='finance'?'finance_metadata':meta.domain==='identity'?'identity':'work';
  add('coverage',`${meta.label}: coverage needed`,meta.caveat,[fact('provider',surface,meta.href,meta.caveat,RULE_VERSION,now.slice(0,10)+'T00:00:00Z','unknown',null,classification)],action(meta.action,subject&&surface==='clients'?`/clients/${subject}?tab=identity`:meta.href),{confidence_label:'Interpretation',coverage:'Domain inputs insufficient for a stronger conclusion.',evidence_strength:1,baseline:'No comparable baseline available.',exclusions:['Missing or stale inputs never become a performance alarm.']});
 }
 return rank(candidates.map(candidate=>makeInsight(v.org,v.person!,candidate,now)));
}
export async function persistInsights(c:PoolClient,v:Viewer,surface:string,subject:string|null=null) {
 const cards=await projectIntelligence(c,v,surface,subject);
 if(!v.person)return [];
 await c.query('select pg_advisory_xact_lock(hashtext($1))',[v.org+':insights:'+v.person]);
 // Refresh all scoped current packets for this surface; a profile refresh must not retire another profile's cards.
 const previous=(await c.query("select id,cause_key,packet from pulse.insight_receipt where surface=$1 and lifecycle='active'",[surface])).rows;
 for(const card of cards) {
  const old=previous.find(p=>p.cause_key===card.cause_key);
  if(old&&old.id!==card.id) {await c.query("update pulse.insight_receipt set lifecycle='superseded',retired_at=now() where id=$1",[old.id]);card.supersedes_id=old.id;}
  const saved=(await c.query(`insert into pulse.insight_receipt(org_id,id,viewer_id,cause_key,surface,packet,supersedes_id) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do update set lifecycle='active',retired_at=null returning packet`,[v.org,card.id,v.person,card.cause_key,surface,JSON.stringify(card),card.supersedes_id])).rows[0];
  // Stable receipts retain their original vintage; a reappearing condition can become active again.
  Object.assign(card,saved.packet);
 }
 for(const old of previous)if(old.cause_key.startsWith(`${surface}:${subject??'all'}:`)&&!cards.some(c=>c.cause_key===old.cause_key))await c.query("update pulse.insight_receipt set lifecycle='retired',retired_at=now() where id=$1",[old.id]);
 const decisions=(await c.query("select receipt_id,action,until_at from pulse.insight_decision where action in ('dismiss','complete') or (action='snooze' and until_at>now())")).rows;
 return cards.filter(c=>!decisions.some(d=>d.receipt_id===c.id));
}
export function registerIntelligenceRoutes(app:FastifyInstance,{tx}:{tx:Tx}) {
 app.get('/api/v0/intelligence/providers',req=>tx(req,async(c,v)=>({providers:await Promise.all(Object.entries(SURFACES).map(async([key,p])=>({key,label:p.label,allowed:await surfaceAllowed(c,v,key)}))),version:RULE_VERSION,narrative_enabled:false})));
 app.get('/api/v0/intelligence',req=>tx(req,async(c,v)=>{
  const q=req.query as {surface?:string;subject?:string;path?:string;tab?:string};const surface=q.path?surfaceFor(q.path,q.tab):q.surface??'dashboard';
  if(q.path&&q.path.length>300)fail(400,'Choose a valid page');
  if(!q.subject&&q.path){const key=q.path.split('/').find(p=>UUID.test(p));if(key)q.subject=key;}
  if(!SURFACES[surface])fail(400,'Choose a registered insight surface');
  if(q.subject&&!UUID.test(q.subject))fail(400,'Choose a valid subject');
  const cards=await persistInsights(c,v,surface,q.subject??null);
  return {surface,version:RULE_VERSION,cards:cards.slice(0,3),backlog:cards.slice(3),state:cards.length?'ready':'No authorized insight yet',narrative_enabled:false};
 }));
 app.get<{Params:{id:string}}>('/api/v0/intelligence/receipts/:id',req=>tx(req,async(c,v)=>{
  const r=(await c.query('select packet,lifecycle from pulse.insight_receipt where id=$1',[req.params.id])).rows[0];
  if(!r||!await receiptAllowed(c,v,r.packet))fail(404,'Evidence is unavailable for this account');
  await c.query("select pulse.audit_write('evidence_read','insight_receipt',$1)",[req.params.id]);
  const fresh=await projectIntelligence(c,v,r.packet.surface,receiptSubject(r.packet));
  const current=fresh.find(x=>x.cause_key===r.packet.cause_key);
  return {...r.packet,lifecycle:r.lifecycle,revised:!!current&&current.id!==req.params.id,current_id:current?.id??null};
 }));
 app.post<{Params:{id:string};Body:{action?:string;reason?:string}}>('/api/v0/intelligence/:id/decision',req=>tx(req,async(c,v)=>{
  const r=(await c.query('select packet,lifecycle from pulse.insight_receipt where id=$1 for update',[req.params.id])).rows[0];
  if(!r||!await receiptAllowed(c,v,r.packet))fail(404,'Insight is unavailable');
  const action=req.body.action??'',reason=String(req.body.reason??'').trim();
  if(!['dismiss','snooze','complete','useful','irrelevant','false'].includes(action)||reason.length<3||reason.length>500)fail(400,'Choose an action and record a short reason');
  if(action==='complete') {
   const current=await projectIntelligence(c,v,r.packet.surface,receiptSubject(r.packet));
   if(current.some(x=>x.cause_key===r.packet.cause_key))fail(409,'Complete the source action first; this condition is still present');
  }
  await c.query(`insert into pulse.insight_decision(org_id,viewer_id,receipt_id,action,reason,until_at) values($1,$2,$3,$4,$5,case when $4='snooze' then now()+interval '1 day' end) on conflict do nothing`,[v.org,v.person,req.params.id,action,reason]);
  if(action==='complete')await c.query("update pulse.insight_receipt set lifecycle='retired',retired_at=coalesce(retired_at,now()) where id=$1 and lifecycle='active'",[req.params.id]);
  await c.query("select pulse.audit_write('insight_decision','insight_receipt',$1,array[$2])",[req.params.id,action]);return {ok:true};
 }));
 app.post<{Params:{id:string};Body:{ownerId?:string;dueAt?:string;timezone?:string;workDays?:number[]}}>('/api/v0/tasks/:id/review-agreement',req=>tx(req,async(c,v)=>{
  if(!admin(v)||!v.person)fail(403,'An individual admin records review agreements');
  const b=req.body;if(!UUID.test(req.params.id)||!UUID.test(b.ownerId??'')||!/^\d{4}-\d{2}-\d{2}T/.test(b.dueAt??'')||!Number.isFinite(Date.parse(b.dueAt??'')))fail(400,'Choose a reviewer and an explicit deadline');
  const timezone=b.timezone??await orgZone(c),days=b.workDays??[1,2,3,4,5,6];try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{fail(400,'Choose a valid timezone');}
  if(!Array.isArray(days)||!days.length||days.some(d=>!Number.isInteger(d)||d<1||d>7)||new Set(days).size!==days.length)fail(400,'Choose unique working days');
  if(!(await c.query("select 1 from pulse.person where id=$1 and side='staff' and status='active'",[b.ownerId])).rows.length)fail(400,'Choose an active reviewer');
  const r=await c.query("update pulse.task set review_owner_id=$1,review_due_at=$2,review_calendar=$3,review_work_days=$4,locked=array(select distinct unnest(locked||'{review_owner_id,review_due_at,review_calendar,review_work_days}'::text[])),updated_at=now() where id=$5 returning id",[b.ownerId,b.dueAt,timezone,days,req.params.id]);if(!r.rows.length)fail(404,'Task unavailable');
  await c.query("select pulse.audit_write('review_agreement','task',$1,array['review_owner_id','review_due_at','review_calendar','review_work_days'])",[req.params.id]);return {ok:true};
 }));
}
