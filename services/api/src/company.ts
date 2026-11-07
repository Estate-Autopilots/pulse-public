import { registerFinanceRoutes } from './finance-routes.js';
import { hostCompany } from './tenant-context.js';
import { financeWorkspace, type MoneyRow } from './finance.js';
import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { googleBridge as bridge } from './google.js';
import { attachment, inbox } from './email.js';
import { admin, leadership, manager, fail, hr, work, type Tx, type Viewer } from './routes.js';
import type { PoolClient } from 'pg';
import { wordEditor } from './policy-word.js';

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Body = Record<string, unknown>;
const str = (x: unknown, max = 200) => String(x ?? '').trim().slice(0, max);
const id = (x: unknown) => UUID.test(String(x)) ? String(x) : fail(400, 'Choose a valid record');
const must = (v: Viewer) => { if (!admin(v) || !v.person) fail(403, 'An individual organisation admin manages company data'); };
const page = (q: unknown) => Math.max(0, Math.min(20000, Number((q as { page?: string }).page) || 0));
const datasets = ['money_sheet_transactions','money_monthly_expenses','money_drive_bills','money_gmail_receipts','money_payroll_aggregates','money_cost_assumptions','subscriptions','recurring'];
const tables: Record<string,string> = { client: 'pulse.client', project: 'pulse.project', person: 'pulse.person', contact: 'pulse.person' };
async function exists(c: PoolClient, entity: string, key: string) {
  if (!tables[entity]) fail(400, 'Unknown record type');
  if (!(await c.query(`select 1 from ${tables[entity]} where id=$1`, [id(key)])).rows[0]) fail(404, 'Record not found');
}
async function correction(c:PoolClient,v:Viewer,entity:string,key:string,field:string,before:unknown,next:unknown) {
  await c.query('insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values($1,$2,$3,$4,$5,$6,$7)',[v.org,entity,key,field,before??null,next??null,v.person]);
}

// One review decision per item, as the item's kind requires; also used to decide a whole group (review-groups.ts).
export async function decideReview(c:PoolClient,v:Viewer,ids:string[],body:Body) {
  if(body.individual===true&&(body.allHighConfidence===true||ids.length!==1)) fail(400,'Accept one suggestion at a time');
  if(body.action==='accept'&&body.individual!==true){const fillSuggestion=(await c.query("select 1 from pulse.review_item where id=any($1::uuid[]) and status='pending' and (kind='onboard_project_fill' or source_key like 'onboard_project_fill:%' or (kind='project_pod' and evidence ? 'ruleId')) limit 1",[ids])).rows[0];if(fillSuggestion)fail(400,'Fill suggestions need individual acceptance until rule confidence is calibrated');}
  for(const key of ids) {
   const r=(await c.query("select * from pulse.review_item where id=$1 and status='pending' for update",[key])).rows[0]; if(!r) fail(409,'A suggestion has already been decided');
   if(!admin(v)&&!['manager','holiday','opening_balance'].includes(r.kind)) fail(403,'Admins manage this suggestion');
   // R55: which model a name means, or which project a shoot was for; the database applies and keeps the decision.
   if(r.kind==='talent'){ if(!['accept','dismiss'].includes(String(body.action))) fail(400,'Choose accept or dismiss');
    await c.query('select pulse.talent_decide($1,$2,$3)',[key,body.action==='accept',body.choice?id(body.choice):null]); continue; }
   // R55: a pin or a micro-market centre its own evidence contradicts: accept moves it (to the proposal or a given point).
   if(r.kind==='geocode'){ if(!['accept','dismiss'].includes(String(body.action))) fail(400,'Choose accept or dismiss');
    const lat=body.lat===undefined||body.lat===null?null:Number(body.lat),lng=body.lng===undefined||body.lng===null?null:Number(body.lng);
    if((lat===null)!==(lng===null)||(lat!==null&&(!Number.isFinite(lat)||!Number.isFinite(lng!)||Math.abs(lat)>90||Math.abs(lng!)>180))) fail(400,'Give a latitude and longitude such as 18.5204, 73.8567');
    await c.query('select pulse.geo_review_decide($1,$2,$3,$4)',[key,body.action==='accept',lat,lng]); continue; }
   let createdProject:string|null=null;
   if(body.action==='accept') {
    const proposal=r.kind==='onboard_project_new'?r.proposed:
     body.proposed&&typeof body.proposed==='object'?{...r.proposed,...body.proposed as Body}:r.proposed;
    if(r.kind==='project_pod') {
     if(!proposal.pod&&!(body.confirmPgs===true&&proposal.pgsId)) fail(400,'Choose a pod or confirm an individual PGS before accepting');
     if(proposal.pod) {
      const u=(await c.query("select id from pulse.unit where kind='pod' and name=$1 and valid_to is null",[proposal.pod])).rows[0]; if(!u) fail(400,'Choose an existing pod');
      const before=(await c.query('select u.name from pulse.project p left join pulse.unit u on u.id=p.unit_id where p.id=$1',[r.entity_id])).rows[0]?.name;
      await correction(c,v,'project',r.entity_id,'pod',before,proposal.pod);
      await c.query("update pulse.project set unit_id=$1,locked=array(select distinct unnest(locked||'unit_id'::text)),updated_at=now() where id=$2",[u.id,r.entity_id]);
     }
     // Only an explicitly chosen person becomes PGS. The performance marketer candidate is not enough.
     if(body.confirmPgs===true&&proposal.pgsId) { await exists(c,'person',id(proposal.pgsId)); const before=(await c.query('select lead_person_id from pulse.project where id=$1',[r.entity_id])).rows[0]?.lead_person_id; await correction(c,v,'project',r.entity_id,'pgsId',before,proposal.pgsId); await c.query("update pulse.project set lead_person_id=$1,locked=array(select distinct unnest(locked||'lead_person_id'::text)),updated_at=now() where id=$2",[proposal.pgsId,r.entity_id]); }
    } else if(r.kind==='contact_type') {
     const type=str(proposal.contactType); if(!['developer','channel_partner','talent','vendor','other'].includes(type)) fail(400,'Choose a contact type');
     const before=(await c.query('select contact_type from pulse.contact_profile where person_id=$1',[r.entity_id])).rows[0]?.contact_type;
     await correction(c,v,'contact',r.entity_id,'contactType',before,type);
     await c.query("update pulse.contact_profile set contact_type=$1,type_status='confirmed',locked=array(select distinct unnest(locked||'contact_type'::text)),updated_at=now() where person_id=$2",[type,r.entity_id]);
    } else if(r.kind==='manager') {
     const manager=id(proposal.managerId); await exists(c,'person',manager); if(manager===r.entity_id) fail(400,'A person cannot report to themself');
     if((await c.query(`with recursive chain as(select person_id,manager_id from pulse.people_profile where person_id=$1 union select p.person_id,p.manager_id from pulse.people_profile p join chain x on p.person_id=x.manager_id) select 1 from chain where person_id=$2`,[manager,r.entity_id])).rows[0]) fail(400,'This reporting line would make a loop');
     const before=(await c.query('select manager_id from pulse.people_profile where person_id=$1',[r.entity_id])).rows[0]?.manager_id;
     await correction(c,v,'person',r.entity_id,'managerId',before,manager);
     await c.query("update pulse.people_profile set manager_id=$1,locked=array(select distinct unnest(locked||'manager_id'::text)) where person_id=$2",[manager,r.entity_id]);
    } else if(r.kind==='opening_balance') {
     const person=id(proposal.personId);await exists(c,'person',person);if(person===v.person)fail(403,'Someone else confirms your own leave balance');const days=Number(proposal.days);if(!Number.isFinite(days)||days<0||days>365)fail(400,'Confirm valid leave days');
     await c.query("insert into pulse.leave_adjustment(org_id,person_id,type_key,leave_year,days,reason) values($1,$2,'annual',2026,$3,$4)",[v.org,person,days,'Provisional opening at 1 Oct 2026; explicit older carry-forward note, HR identity confirmation.']);
    } else if(r.kind==='duplicate') {if(['client','contact'].includes(proposal.entity))fail(409,'Open identity review to preview evidence and associations before merging');await c.query('select pulse.merge_records($1,$2,$3)',[proposal.entity,id(proposal.keepId),id(proposal.goneId)]);}
    else if(r.kind==='holiday') {
     await c.query('insert into pulse.holiday(org_id,day,name,optional) values($1,$2,$3,$4) on conflict do nothing',[v.org,proposal.day,proposal.name,!!proposal.optional]);
    } else if(r.kind==='onboard_project_new') {
     const projectId=id(proposal.projectId),folderPath=str(r.evidence?.folderPath,500),projectName=str(proposal.projectName,160);
     const storageRoot=str(proposal.storageRoot,520),clientKey=str(proposal.clientKey,200)||null;
     const clientId=proposal.clientId?id(proposal.clientId):null,clientName=str(proposal.clientName,120)||null;
     if(!folderPath||!projectName)fail(400,'The proposed Drive project root is missing');
     createdProject=(await c.query('select pulse.company_create_drive_project($1,$2,$3,$4,$5,$6,$7) id',
      [projectId,folderPath,storageRoot,projectName,clientKey,clientId,clientName])).rows[0].id;
    } else if(r.kind==='onboard_project_fill') {
     if(r.entity_type!=='project'||!r.entity_id) fail(400,'This fill suggestion is missing its project');
     const clientKey=str(proposal.clientKey,200)||null,clientId=proposal.clientId?id(proposal.clientId):null;
     const clientName=str(proposal.clientName,120)||null,deliverableType=str(proposal.deliverableType,120)||null;
     // Deliverable types are per-org rule config; company_fill_project checks the value's shape.
     if(!clientKey&&!deliverableType) fail(400,'The proposed project field is missing');
     try { await c.query('select pulse.company_fill_project($1,$2,$3,$4,$5)',[r.entity_id,clientKey,clientId,clientName,deliverableType]); }
     catch(e) { const code=(e as {code?:string}).code;
      if(code==='40001'||code==='P0002') fail(409,'The project changed since this suggestion was made. Run Fill again.');
      if(code==='22023') fail(400,(e as Error).message);
      throw e; }
    } else if(r.kind==='wa_contact') { await c.query('select pulse.wa_contact_apply($1)',[key]); // WA-INTEL (1070): fills what is still empty
    } else if(r.kind==='correction'||r.kind==='data_gap') { /* The admin fills or corrects the record itself; accepting marks the item done. */ }
    else fail(400,'Open the record to resolve this identity suggestion');
   } else if(body.action!=='dismiss') fail(400,'Choose accept or dismiss');
   await c.query("update pulse.review_item set entity_type=case when $4::uuid is null then entity_type else 'project' end,entity_id=coalesce($4,entity_id),status=$1,decided_by=$2,decided_at=now() where id=$3",[body.action==='accept'?'accepted':'dismissed',v.person,key,createdProject]);
  }
}

export function registerCompanyRoutes(app: FastifyInstance, { tx }: { tx: Tx }) {
 registerFinanceRoutes(app,{tx});
 const body = { type: 'object' } as const;
 app.get('/api/v0/company/imports', req => tx(req, async(c,v)=> { must(v); return { imports: (await c.query('select dataset,row_count "rows",sha256,imported_at "at" from pulse.import_batch order by imported_at desc')).rows }; }));
 app.post<{Body:Body}>('/api/v0/projects',{schema:{body}},req=>tx(req,async(c,v)=> {
  must(v);const title=str(req.body.title,160);if(!title) fail(400,'Name the project');const client=req.body.clientId?id(req.body.clientId):null;
  if(client)await exists(c,'client',client);
  return (await c.query('select pulse.company_create_project($1,$2,null,$3) id',[title,client,str(req.body.location,100)||null])).rows[0];
 }));
 app.get<{Params:{file:string}}>('/api/v0/files/:file',req=>tx(req,async(c,v)=> {
  work(v);const key=str(req.params.file);const row=(await c.query(`select f.file_id "fileId",coalesce(f.display_name,f.name) "displayName",f.name "sourceName",f.path,
   f.project_id "projectId",coalesce(p.title,p.name) "projectName",fc.wrong_reason "wrongReason",by.display_name "editedBy",fc.updated_at "editedAt"
   from pulse.index_file f left join pulse.project p on p.id=f.project_id left join pulse.file_correction fc on fc.org_id=f.org_id and fc.file_id=f.file_id left join pulse.person by on by.id=fc.edited_by
   where f.file_id=$1 and ($2::boolean or exists(select 1 from pulse.delivery d where d.file_id=f.file_id and d.uploader_account=$3))`,[key,admin(v),v.email])).rows[0];if(!row)fail(404,'File not found');
  return {...row,canEdit:admin(v),projects:admin(v)?(await c.query('select id,coalesce(title,name) name from pulse.project order by title')).rows:[],actors:(await c.query('select at,operation,actor_account,actor_label,actor_kind,human_attribution,basis from pulse.activity_observation where file_id=$1 order by at desc limit 20',[key])).rows};
 }));
 // Tasks moved to tasks.ts (RT1): one model for tracker rows and new work.
 app.get('/api/v0/tracking-signals',req=>tx(req,async(c,v)=>{
  work(v);const people=(await c.query(`select p.id,p.display_name name,pp.role,
   (select count(*)::int from pulse.activity_observation a where a.actor_id=p.id and a.operation in ('upload','create','created')) actions,
   (select count(*)::int from pulse.task t where t.owner_id=p.id) tasks
   from pulse.person p left join pulse.people_profile pp on pp.person_id=p.id where p.side='staff' and p.status='active' and ($1::boolean or p.id=$2 or pulse.manages(p.id)) order by p.display_name`,[leadership(v),v.person])).rows;
  return {people,signals:[{role:'Editor / designer',starting:'Completed tasks, attributable uploads, revision follow-ups',connected:'Individual upload/create observations and tracker tasks; shared logins remain uncredited',pending:'Creative approval, revision reasons and quality need explicit workflow records'},
   {role:'PGS / pod lead',starting:'Delivery commitments, blocked tasks, project coverage',connected:'Imported project pods and assigned tracker tasks; role and reporting lines require confirmation',pending:'Client approvals and commitments are not inferred from file counts'},
   {role:'Performance marketing',starting:'Campaign tasks, launches, reporting cadence',connected:'Named tracker ownership and project assignments',pending:'Ad performance, spend and leads need authorised campaign integrations'},
   {role:'Developer',starting:'Completed tasks, releases, defects',connected:'Named tracker tasks and qualified activity',pending:'Code review, release and incident events need connections'},
   {role:'HR / operations',starting:'Attendance coverage, pending requests, resolutions',connected:'Imported monthly history and Pulse attendance/leave/HR requests (restricted)',pending:'Historical date grids do not prove absences or who approved leave'}]};
 }));
 // MODULES-1024: who the viewer may see is decided once per distinct actor (a few hundred), not once per observation
 // (74k rows: a pod lead waited 27 s, an admin 2 s); viewer_is runs once as an init plan.
 app.get('/api/v0/activity',req=>tx(req,async(c,v)=> {
  work(v); const q=req.query as {person?:string;project?:string;page?:string}; const who=q.person?id(q.person):leadership(v)||manager(v)?null:v.person;
  if(!leadership(v)&&who!==null&&who!==v.person&&!(await c.query('select pulse.manages($1) ok',[who])).rows[0].ok) fail(403,'Activity is limited to your performance scope');
  const rows=(await c.query(`select a.*,p.display_name "personName",coalesce(pr.title,pr.name) "projectName",coalesce(f.display_name,f.name) "fileName"
   from pulse.activity_observation a left join pulse.person p on p.id=a.actor_id left join pulse.project pr on pr.id=a.project_id left join pulse.index_file f on f.file_id=a.file_id
   where ($1::uuid is null or a.actor_id=$1) and ((select pulse.viewer_is('admin','leadership')) or a.actor_id in (select s.actor_id from (select distinct actor_id from pulse.activity_observation where actor_id is not null) s where s.actor_id=pulse.current_viewer() or pulse.manages(s.actor_id))) and ($2::uuid is null or a.project_id=$2) order by a.at desc nulls last limit 50 offset $3`,[who,q.project?id(q.project):null,page(q)*50])).rows;
  const counts=(await c.query(`select count(*)::int observations,count(*) filter(where actor_id is not null)::int named,
   count(*) filter(where actor_kind='shared_account')::int shared,count(*) filter(where actor_id is null)::int unknown from pulse.activity_observation where ($1::uuid is null or actor_id=$1) and ((select pulse.viewer_is('admin','leadership')) or actor_id in (select s.actor_id from (select distinct actor_id from pulse.activity_observation where actor_id is not null) s where s.actor_id=pulse.current_viewer() or pulse.manages(s.actor_id)))`,[who])).rows[0];
  return {rows,counts,page:page(q),detail:'Individual accounts can provide qualified attribution. Shared logins and missing actors never receive personal credit. Operation time is distinct from snapshot delivery time.'};
 }));
 app.get('/api/v0/hr/imported-history',req=>tx(req,async(c,v)=> {
  const q=req.query as {person?:string;page?:string}; const who=q.person?id(q.person):hr(v)?null:v.person;
  if(!hr(v)&&who!==v.person&&!(await c.query('select pulse.manages($1) ok',[who])).rows[0].ok) fail(403,'Attendance history is restricted');
  await c.query("select pulse.audit_write('restricted_read','hr.imported_history',$1)",[who]);
  // R43: outside HR only reports whose owner is settled (0251 hr_month_resolved); the rest wait for HR's review.
  const rows=(await c.query(`select h.*,p.display_name "personName" from pulse.hr_month_history h left join pulse.person p on p.id=h.person_id where ($1::uuid is null or person_id=$1) and ($3::boolean or pulse.hr_month_resolved(h)) order by month desc nulls last,person_label limit 50 offset $2`,[who,page(q)*50,hr(v)])).rows;
  return {rows,canEdit:hr(v)&&!!v.person,people:hr(v)?(await c.query("select id,display_name name from pulse.person where side='staff' order by display_name")).rows:[],page:page(q),total:(await c.query('select count(*)::int n from pulse.hr_month_history h where ($1::uuid is null or person_id=$1) and ($2::boolean or pulse.hr_month_resolved(h))',[who,hr(v)])).rows[0].n,detail:hr(v)?'Reported monthly history. Blank counts remain unknown; unanchored years stay explicit. Date coverage is not a leave or absence decision.':'Monthly reports HR confirmed as yours. Blank counts remain unknown; unanchored years stay explicit. Reports not yet matched to a person stay with HR.'};
 }));
 app.post<{Body:Body}>('/api/v0/hr/imported-history',{schema:{body}},req=>tx(req,async(c,v)=>{
  if(!hr(v)||!v.person)fail(403,'HR records monthly history');const b=req.body,person=id(b.personId),month=str(b.month);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||month>new Date().toISOString().slice(0,7))fail(400,'Choose a current or past month');
  const p=(await c.query("select display_name name from pulse.person where id=$1 and side='staff'",[person])).rows[0];if(!p)fail(404,'Person unavailable');
  const number=(raw:unknown)=>{if(raw===null||raw===undefined||raw==='')return null;const n=Number(raw);if(!Number.isFinite(n)||n<0||n>31)fail(400,'Days must be between 0 and 31, or blank when unknown');return n;};
  const reason=str(b.reason,500);if(reason.length<5)fail(400,'Record the source or reason for this historical entry');
  await c.query(`insert into pulse.hr_month_history(org_id,source_key,person_id,person_label,month_label,month,leave_days,wfh_days,half_days,attendance_dates,confidence,basis,evidence)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12) on conflict(org_id,source_key) do update set leave_days=excluded.leave_days,wfh_days=excluded.wfh_days,half_days=excluded.half_days,attendance_dates=excluded.attendance_dates,basis=excluded.basis,evidence=excluded.evidence`,
   [v.org,'pulse-month:'+person+':'+month,person,p.name,month,month+'-01',number(b.leaveDays),number(b.wfhDays),number(b.halfDays),str(b.coverage,2000)||null,reason,JSON.stringify({source:'manual_hr_history',enteredBy:v.person,enteredAt:new Date().toISOString(),reason})]);return {ok:true};
 }));
 app.get('/api/v0/hr/policies',req=>tx(req,async(c,v)=>{
  if(!v.person)fail(403,'An employee login is required');const edit=hr(v);
  const rows=(await c.query(`select distinct on(d.kind) d.*,p.display_name author,e.display_name editor,pb.display_name publisher,exists(select 1 from pulse.policy_ack a where a.document_id=d.id and a.person_id=$1) acknowledged,
   (select count(*)::int from pulse.policy_ack a where a.document_id=d.id) "ackCount" from pulse.policy_document d left join pulse.person p on p.id=d.created_by
   left join pulse.person e on e.id=d.updated_by left join pulse.person pb on pb.id=d.published_by
   where ($2::boolean or d.status='published') order by d.kind,d.version desc`,[v.person,edit])).rows;
  const headcount=(await c.query("select count(*)::int n from pulse.person where side='staff' and status='active'")).rows[0].n;
  // R41: HR also learns whether Word editing is on (and why not); the Word file's name and hash ride on each version.
  return {rows,canEdit:edit,headcount,word:edit?(await wordEditor()).status:null,versions:edit?(await c.query('select id,kind,title,version,status,created_at,published_at,docx_name,docx_sha256 from pulse.policy_document order by kind,version desc')).rows:[],acks:edit?(await c.query('select a.*,p.display_name name from pulse.policy_ack a join pulse.person p on p.id=a.person_id order by a.at desc')).rows:[]};
 }));
 app.post<{Body:Body}>('/api/v0/hr/policies',{schema:{body}},req=>tx(req,async(c,v)=>{
  if(!hr(v)||!v.person)fail(403,'HR or leadership edits policy documents');
  const b=req.body;const result=(await c.query('select pulse.policy_save($1,$2,$3,$4,$5) id',[str(b.kind),str(b.title,100),str(b.body,30000),str(b.status),Number(b.version)])).rows[0];return result;
 }));
 // The editor's autosave: into the latest draft, or a new draft version on top of a published one (migration 0127).
 app.post<{Body:Body}>('/api/v0/hr/policies/draft',{schema:{body}},req=>tx(req,async(c,v)=>{
  if(!hr(v)||!v.person)fail(403,'HR or leadership edits policy documents');
  const b=req.body,version=Number(b.version),revision=Number(b.revision??1),text=typeof b.body==='string'?b.body.replace(/\r\n?/g,'\n').trim():'';
  if(!Number.isInteger(version)||version<0||!Number.isInteger(revision)||revision<1)fail(400,'Refresh the policy before editing');
  if(text.length>30000)fail(400,'A policy can be at most 30,000 characters');
  return (await c.query('select pulse.policy_draft_save($1,$2,$3,$4,$5) r',[str(b.kind)||null,str(b.title,100),text,version,revision])).rows[0].r;
 }));
 // Publishing asks every employee to acknowledge this version on My desk → Policies. Saving a draft never changes its
 // status, so nothing that reacts to a published policy runs before HR presses Publish.
 app.post<{Body:Body}>('/api/v0/hr/policies/publish',{schema:{body}},req=>tx(req,async(c,v)=>{
  if(!hr(v)||!v.person)fail(403,'HR or leadership publishes policy documents');
  const revision=Number(req.body.revision);if(!Number.isInteger(revision)||revision<1)fail(400,'Refresh the policy before publishing');
  return (await c.query('select pulse.policy_publish($1,$2) r',[id(req.body.documentId),revision])).rows[0].r;
 }));
 // HR desk → Policies → "Needs your attention": counts only, each answered on the page it links to.
 app.get('/api/v0/hr/policy-attention',req=>tx(req,async(c,v)=>{
  if(!hr(v))fail(403,'HR and organisation admins only');
  return (await c.query(`select coalesce((select confirmed_at is null from pulse.hr_policy limit 1),true) "rulesUnconfirmed",
   (select count(*)::int from pulse.review_item where status='pending' and kind='holiday') holidays,
   (select count(*)::int from pulse.review_item where status='pending' and kind='opening_balance') "openingBalances",
   (select count(*)::int from pulse.hr_month_history where person_id is null) "historyUnlinked",
   (select count(*)::int from pulse.unit u where u.kind='pod' and u.valid_to is null and not exists(select 1 from pulse.hr_pod h where h.name=u.name and h.head_id is not null)) "podsWithoutHead",
   (select count(*)::int from pulse.presence_office where active) offices`)).rows[0];
 }));
 app.post<{Body:Body}>('/api/v0/hr/policies/acknowledge',{schema:{body}},req=>tx(req,async(c)=>{await c.query('select pulse.policy_acknowledge($1)',[id(req.body.documentId)]);return {ok:true};}));
 app.get('/api/v0/money',req=>tx(req,async(c)=> {
  const permissions=(await c.query("select pulse.money_can('money.read') read,pulse.money_can('money.amount.read') amounts,pulse.money_can('money.plan.write') write")).rows[0];
  if(!permissions.read) fail(403,'Leadership with an explicit Money permission can view this page');
  const q=req.query as {dataset?:string;page?:string;tab?:string}; const dataset=q.dataset??datasets[0]; if(!datasets.includes(dataset)) fail(400,'Unknown money dataset');
  const summary=(await c.query('select pulse.money_summary() data')).rows[0].data;
  const data=(await c.query('select pulse.money_read($1,$2) data',[dataset,page(q)*50])).rows[0].data;
  const observations:MoneyRow[]=permissions.amounts?(await c.query('select pulse.money_workspace() data')).rows[0].data:[];
  if(data.rows) data.rows=data.rows.map((row:MoneyRow)=>{const match=observations.find(o=>o.dataset===row.dataset&&o.id===row.id);return {...row,projectId:match?.projectId,projectName:match?.projectName,clientId:match?.clientId,clientName:match?.clientName};});
  const workspace=permissions.amounts?financeWorkspace(observations,undefined,(await c.query('select pulse.money_cash_balances() data')).rows[0].data):null;
  const payroll=q.tab==='payroll'&&permissions.amounts&&(await c.query("select pulse.hr_can('hr.salary.read') ok")).rows[0].ok?(await c.query('select person_id,effective_month::text "month",kind,amount::float,currency from pulse.hr_salary_overview()')).rows:null;
  const payrollTrend=payroll?(await c.query('select pulse.payroll_cost_trend() data')).rows[0].data:null;
  return {...data,workspace,payroll,payrollTrend,aaEnabled:process.env.PULSE_AA_ENABLED==='1',summary,permissions,dataset,datasets,page:page(q),plans:(await c.query('select pulse.money_plans_read() data')).rows[0].data,projects:permissions.write?(await c.query('select id,coalesce(title,name) name from pulse.project order by title')).rows:[],people:permissions.write?(await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by display_name")).rows:[],grants:permissions.write?(await c.query('select person_id,permission,revoked_at from pulse.money_permission')).rows:[]};
 }));
 app.post<{Body:Body}>('/api/v0/money/import',{schema:{body},bodyLimit:8*1024*1024},req=>tx(req,async(c,v)=>{
  const allowed=(await c.query("select pulse.money_can('money.plan.write') and pulse.money_can('money.amount.read') ok")).rows[0].ok;if(!allowed)fail(403,'Finance import permission is required');
  if(req.body.action==='save') {
   if(!Array.isArray(req.body.rows)||req.body.rows.length>2000)fail(400,'Preview up to 2,000 transactions');
   const rows=(req.body.rows as unknown[]).map(raw=>{const r=raw as Body;if(!/^[a-f0-9]{64}$/.test(String(r.reference_hash)))fail(400,'Preview the statement first');return {date:r.date,vendor:r.vendor,amount:r.amount,direction:r.direction,currency:r.currency,category:r.category,reference_hash:r.reference_hash,account_digest:r.account_digest,source_file_digest:r.source_file_digest,file_replay_key:r.file_replay_key,date_basis:r.date_basis,minor_unit_scale:r.minor_unit_scale,original_amount_unit:r.original_amount_unit,reference_kind:r.reference_kind,parser_issues:r.parser_issues,...(r.account_last4?{account_last4:r.account_last4}:{})};});
   const saved=(await c.query('select pulse.money_statement_save($1,$2) saved',[JSON.stringify(rows),str(req.body.sourceType)])).rows[0].saved;return {ok:true,saved,duplicates:rows.length-saved};
  }
  if(!['csv','xlsx','xls','pdf'].includes(str(req.body.format))||typeof req.body.content!=='string'||req.body.content.length>7*1024*1024)fail(400,'Choose a CSV, Excel (.xlsx) or PDF file under 5 MB');
  const parsed=await new Promise<Body>((done,reject)=>{const child=execFile(process.env.PULSE_WORKER_PYTHON??resolve('.venv/bin/python'),[resolve('tools/statement-parse.py')],{timeout:30000,maxBuffer:2*1024*1024},(err,out)=>err?reject(new Error('Statement parser unavailable')):done(JSON.parse(out)));child.stdin?.end(JSON.stringify({content:req.body.content,sourceScope:v.org,sourceType:req.body.sourceType,accountAlias:req.body.accountAlias,format:req.body.format,currency:req.body.currency,amountUnit:req.body.amountUnit,defaultDirection:req.body.defaultDirection,accountLast4:req.body.accountLast4,mapping:req.body.mapping}));});
  if(parsed.error)fail(400,str(parsed.error,250));
  const known=(await c.query('select pulse.money_workspace() data')).rows[0].data as {id:string;dataset:string;data:Body;projectId?:string;projectName?:string}[];
  const rows=(parsed.rows as Body[]).map(r=>{const matches=known.filter(k=>k.dataset==='money_sheet_transactions'&&k.data.date===r.date&&k.data.currency===r.currency&&k.data.direction===r.direction&&Number(k.data.amount)===Number(r.amount));return {...r,matches:matches.map(k=>({id:k.id,projectId:k.projectId,projectName:k.projectName})),matchStatus:matches.length?'Possible duplicate — review':'New observation'};});
  await c.query("select pulse.audit_write('restricted_read','money.statement.preview')");return {...parsed,rows};
 }));
 app.post<{Body:Body}>('/api/v0/money/tool',{schema:{body}},req=>tx(req,async(c)=>{
  if(!(await c.query("select pulse.money_can('money.plan.write') ok")).rows[0].ok)fail(403,'Finance edit permission is required');
  const b=req.body;const num=(raw:unknown)=>raw===null||raw===undefined||raw===''?null:Number(raw);const seats=num(b.seats),used=num(b.used_seats);if([seats,used].some(x=>x!==null&&(!Number.isInteger(x)||x<0||x>100000)))fail(400,'Seat counts must be non-negative whole numbers');
  const renewal=str(b.renewal_date);if(renewal&&!/^\d{4}-\d{2}-\d{2}$/.test(renewal))fail(400,'Choose a valid renewal date');
  await c.query('select pulse.money_tool_save($1,$2,$3,$4,$5)',[str(b.dataset),str(b.id),renewal||null,seats,used]);return {ok:true};
 }));
 app.post<{Body:Body}>('/api/v0/money/cash-balance',{schema:{body}},req=>tx(req,async(c)=>{
  if(!(await c.query("select pulse.money_can('money.plan.write') ok")).rows[0].ok)fail(403,'Finance edit permission is required');
  const b=req.body,amount=Number(b.amount);if(b.amount===''||!Number.isFinite(amount)||amount<0||!/^\d{4}-\d{2}-\d{2}$/.test(str(b.asOf))||! /^[A-Z]{3}$/.test(str(b.currency)))fail(400,'Check balance, currency and verification date');
  await c.query('select pulse.money_cash_balance($1,$2,$3,$4)',[b.currency,amount,b.asOf,b.historyReconciled==='yes']);return {ok:true};
 }));
 app.post<{Body:Body}>('/api/v0/money/category',{schema:{body}},req=>tx(req,async(c)=>{await c.query('select pulse.money_category_save($1,$2,$3)',[str(req.body.dataset),str(req.body.id),str(req.body.category,80)]);return {ok:true};}));
 app.post<{Body:Body}>('/api/v0/money/link',{schema:{body}},req=>tx(req,async(c)=>{await c.query('select pulse.money_link($1,$2,$3)',[str(req.body.dataset),str(req.body.id),id(req.body.projectId)]);return {ok:true};}));
 app.post<{Body:Body}>('/api/v0/money/approve',{schema:{body}},req=>tx(req,async(c)=> {
  const ds=str(req.body.dataset); if(!datasets.includes(ds)) fail(400,'Unknown dataset');
  await c.query('select pulse.money_approve($1,$2,$3)',[ds,str(req.body.id),req.body.approved===true]); return {ok:true};
 }));
 app.post<{Body:Body}>('/api/v0/money/budget/approve',{schema:{body}},req=>tx(req,async(c)=>{
  if(!(await c.query("select pulse.money_can('money.plan.write') ok")).rows[0].ok)fail(403,'Finance edit permission is required');
  const b=req.body;if(!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(str(b.month))||!Array.isArray(b.rows)||!b.rows.length||b.rows.length>100)fail(400,'Choose a budget month and up to 100 categories');
  for(const raw of b.rows as unknown[]){const r=raw as Body;const amount=Number(r.amount);if(!str(r.category)||!Number.isFinite(amount)||amount<0||amount>1e14||! /^[A-Z]{3}$/.test(str(r.currency)))fail(400,'Check each category, amount and currency');await c.query('select pulse.money_plan_save($1,$2,$3,$4,$5,$6)',[b.month,str(r.category,80),amount,r.currency,'budget',str(r.basis,1000)]);}
  await c.query("select pulse.audit_write('approve','money.budget',$1)",[str(b.month)]);return {ok:true};
 }));
 app.post<{Body:Body}>('/api/v0/money/plan',{schema:{body}},req=>tx(req,async(c)=> {
  const b=req.body; const amount=Number(b.amount); if(b.amount===''||!Number.isFinite(amount)||amount<0) fail(400,'Enter a valid amount');
  if(!/^\d{4}-\d{2}-01$/.test(str(b.month))||!['budget','next_month'].includes(str(b.kind))||!str(b.category)) fail(400,'Choose a month, category and plan kind');
  if(!/^[A-Z]{3}$/.test(str(b.currency))) fail(400,'Use a currency code');
  await c.query('select pulse.money_plan_save($1,$2,$3,$4,$5,$6)',[b.month,str(b.category),amount,b.currency,b.kind,str(b.note,1000)]); return {ok:true};
 }));
 app.post<{Body:Body}>('/api/v0/money/permissions',{schema:{body}},req=>tx(req,async(c,v)=> {
  must(v); if(!(await c.query("select pulse.money_can('money.plan.write') ok")).rows[0].ok) fail(403,'Money permission management requires money write permission');
  const who=id(req.body.personId),permission=str(req.body.permission); if(!['money.read','money.amount.read','money.plan.write'].includes(permission)) fail(400,'Unknown permission');
  await exists(c,'person',who); await c.query(`insert into pulse.money_permission(org_id,person_id,permission,granted_by,revoked_at) values($1,$2,$3,$4,$5)
   on conflict(org_id,person_id,permission) do update set granted_by=excluded.granted_by,revoked_at=excluded.revoked_at`,[v.org,who,permission,v.person,req.body.action==='revoke'?new Date():null]); return {ok:true};
 }));
 app.get('/api/v0/audit',req=>tx(req,async(c,v)=> {
  // MODULES-1024: only admins read audit rows (RLS audit_admin, 0011); a leader without admin waited 8-10 s for an empty list.
  if(!admin(v)||!v.person)fail(403,'Admins read the company audit'); const q=req.query as {action?:string;resource?:string;actor?:string;from?:string;to?:string;page?:string;view?:string};
  // EST-1733: an AI employee's actions read "<name> · <code>-AI-nnn".
  const rows=(await c.query(`select a.*,p.display_name||coalesce(' · '||am.employee_id,'') "actorName",am.employee_id "actorEmployeeId" from pulse.audit_event a left join pulse.person p on p.id=a.actor_id
   left join pulse.agent_member am on am.person_id=a.actor_id
   where ($1::text is null or a.action=$1) and ($2::text is null or a.resource ilike '%'||$2||'%')
   and ($3::text is null or a.actor_account ilike '%'||$3||'%' or p.display_name ilike '%'||$3||'%' or am.employee_id ilike '%'||$3||'%')
   and (case when $7='reads' then a.action in ('restricted_read','read','download') when $7='all' then true else a.action not in ('restricted_read','read','download') end)
   and ($4::date is null or a.at >= $4::date) and ($5::date is null or a.at < $5::date+1) order by a.at desc limit 200 offset $6`,
   [str(q.action)||null,str(q.resource)||null,str(q.actor)||null,/^\d{4}-\d{2}-\d{2}$/.test(q.from??'')?q.from:null,/^\d{4}-\d{2}-\d{2}$/.test(q.to??'')?q.to:null,page(q)*200,['reads','all'].includes(q.view??'')?q.view:'changes'])).rows;
  const keys=new Set<string>();for(const r of rows){if(UUID.test(r.resource_id??''))keys.add(r.resource_id);for(const diff of Object.values(r.changes??{}) as {before:unknown;after:unknown}[]){for(const value of [diff.before,diff.after])if(typeof value==='string'&&UUID.test(value))keys.add(value);}}
  const names=keys.size?(await c.query(`select id::text,display_name name from pulse.person where id=any($1::uuid[]) union all select id::text,coalesce(title,name) name from pulse.project where id=any($1::uuid[]) union all select id::text,display_name name from pulse.client where id=any($1::uuid[]) union all select id::text,name from pulse.unit where id=any($1::uuid[])`,[[...keys]])).rows:[];
  const labels=new Map(names.map(n=>[n.id,n.name]));for(const r of rows){r.resourceLabel=labels.get(r.resource_id);for(const diff of Object.values(r.changes??{}) as {before:unknown;after:unknown}[]){if(typeof diff.before==='string'&&labels.has(diff.before))diff.before=labels.get(diff.before);if(typeof diff.after==='string'&&labels.has(diff.after))diff.after=labels.get(diff.after);}}
  return {rows,page:page(q),hooks:'Desktop and office events can POST /api/v0/audit/events; authenticated event types only, no payload contents.'};
 }));
 app.post<{Body:Body}>('/api/v0/audit/events',{schema:{body}},req=>tx(req,async(c,v)=> {
  if(!v.person) fail(403,'Use an individual login'); const event=str(req.body.event); if(!['desktop.connected','desktop.disconnected','office.arrived','office.departed'].includes(event)) fail(400,'Unknown event type');
  await c.query("select pulse.audit_write($1,'device_event')",[event]); return {ok:true};
 }));
 app.get('/api/v0/review-data',req=>tx(req,async(c,v)=> {
  if(!hr(v)) fail(403,'HR and admins manage suggestions'); const q=req.query as {kind?:string;page?:string};
  const rows=(await c.query(`select r.*,coalesce(pr.title,pr.name) "projectName" from pulse.review_item r left join pulse.project pr on pr.id=r.entity_id
   where r.status='pending' and ($1::text is null or r.kind=$1) and ($2::boolean or r.kind in ('manager','holiday','opening_balance')) order by case r.kind when 'correction' then -1 when 'identity' then 0 when 'data_gap' then 7 when 'opening_balance' then 1 when 'manager' then 2 when 'duplicate' then 3 when 'project_pod' then 4 when 'contact_type' then 5 when 'onboard_project_fill' then 6 else 7 end,r.confidence desc nulls last,r.title limit 50 offset $3`,[str(q.kind)||null,admin(v),page(q)*50])).rows;
  const groups=(await c.query("select kind,count(*)::int total,count(*) filter(where status='pending')::int pending,count(*) filter(where status='accepted')::int accepted,count(*) filter(where status='dismissed')::int dismissed,count(*) filter(where status='pending' and confidence>=0.9 and not (kind='onboard_project_fill' or source_key like 'onboard_project_fill:%' or (kind='project_pod' and evidence ? 'ruleId')))::int high from pulse.review_item where ($1::boolean or kind in ('manager','holiday','opening_balance')) group by kind",[admin(v)])).rows;
  return {rows,groups,rules:admin(v)?(await c.query('select * from pulse.review_rule')).rows:[],canRule:admin(v),page:page(q),total:(await c.query("select count(*)::int n from pulse.review_item where status='pending' and ($1::text is null or kind=$1) and ($2::boolean or kind in ('manager','holiday','opening_balance'))",[str(q.kind)||null,admin(v)])).rows[0].n,
   pods:(await c.query("select id,name from pulse.unit where kind='pod' and valid_to is null order by name")).rows,
   people:(await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by display_name")).rows};
 }));
 app.get('/api/v0/admin/onboarding/receipt',req=>tx(req,async(c,v)=>{
  must(v);
  const receipt=(await c.query(`select last_run_at "lastRunAt",folders,matched_existing "matchedExisting",
   proposals,skipped_reason "skippedReason" from pulse.onboarding_sort_receipt where org_id=$1`,[v.org])).rows[0]??null;
  return {receipt};
 }));
 app.post<{Body:Body}>('/api/v0/admin/onboarding/run',{schema:{body}},req=>tx(req,async(_c,v)=>{
  must(v);const step=str(req.body.step);if(!['sort','fill'].includes(step)||('dryRun' in req.body&&typeof req.body.dryRun!=='boolean'))fail(400,'Choose the sort or fill step and a boolean dryRun value');
  const args=['onboard','--org',v.org,'--step',step,...(req.body.dryRun===true?['--dry-run']:[])];
  try {const {stdout}=await run(process.env.PULSE_WORKER_COMMAND??'pulse-worker',args,{timeout:120000,maxBuffer:200000,env:process.env});return JSON.parse(stdout.trim());}
  catch {fail(503,'Onboarding could not complete. Check the worker service.');}
 }));
 app.post<{Body:Body}>('/api/v0/review-data/rules',{schema:{body}},req=>tx(req,async(c,v)=>{
  must(v);const kind=str(req.body.kind),threshold=Number(req.body.threshold??.95);if(!['project_pod','contact_type','onboard_project_new','onboard_project_fill'].includes(kind)||!Number.isFinite(threshold)||threshold<.9||threshold>1)fail(400,'Choose a supported rule and confidence of at least 90%');if(kind==='onboard_project_fill'&&req.body.enabled===true)fail(400,'Fill suggestions require individual acceptance until rule confidence is calibrated');
  await c.query('insert into pulse.review_rule(org_id,kind,threshold,enabled,created_by) values($1,$2,$3,$4,$5) on conflict(org_id,kind) do update set threshold=excluded.threshold,enabled=excluded.enabled,created_by=excluded.created_by,updated_at=now()',[v.org,kind,threshold,req.body.enabled===true,v.person]);
  return {ok:true,accepted:(await c.query('select pulse.review_apply_rules() n')).rows[0].n};
 }));
 // Admin: look for missing record details again (migration 0037); filled gaps close themselves.
 app.post('/api/v0/review-data/gaps',req=>tx(req,async(c,v)=>{must(v);return {flagged:(await c.query('select pulse.review_flag_gaps() n')).rows[0].n};}));
 app.post<{Body:Body}>('/api/v0/review-data/decide',{schema:{body}},req=>tx(req,async(c,v)=> {
  if(!hr(v)||!v.person) fail(403,'HR or an individual admin manages suggestions');
  const ids=req.body.allHighConfidence===true&&admin(v)?(await c.query("select id from pulse.review_item where kind='project_pod' and status='pending' and confidence>=0.9 and proposed->>'pod' is not null and not (source_key like 'onboard_project_fill:%' or evidence ? 'ruleId')")).rows.map(r=>r.id):Array.isArray(req.body.ids)?req.body.ids.map(id):[]; if(!ids.length||ids.length>600) fail(400,'Select up to 600 suggestions');
  await decideReview(c,v,ids,req.body);
  return {ok:true,count:ids.length};
 }));
 app.get<{Params:{entity:string;id:string}}>('/api/v0/stewardship/:entity/:id',req=>tx(req,async(c,v)=> {
  if(req.params.entity==='person') { if(!hr(v)&&v.person!==req.params.id) fail(403,'This record is restricted'); } else work(v);
  const {entity,id:key}=req.params; await exists(c,entity,key);
  const annotation=(await c.query('select a.*,p.display_name "editedBy" from pulse.record_annotation a left join pulse.person p on p.id=a.edited_by where entity_type=$1 and entity_id=$2',[entity,key])).rows[0]??null;
  const links=(await c.query('select l.*,p.display_name "editedBy" from pulse.record_link l left join pulse.person p on p.id=l.edited_by where entity_type=$1 and entity_id=$2 order by kind,label',[entity,key])).rows;
  const merged=(await c.query('select id,keep_id "keepId",gone_id "goneId",merged_at "at",undone_at "undoneAt" from pulse.record_merge where entity_type=$1 and (gone_id=$2 or keep_id=$2) order by merged_at desc',[entity,key])).rows;
  const locations=entity==='project'?(await c.query('select l.id,l.name,l.lat,l.lng,l.precision,l.pinned_by "editedBy" from pulse.project_location_member m join pulse.project_location l on l.id=m.location_id where m.project_id=$1',[key])).rows:
   entity==='client'?(await c.query('select distinct l.id,l.name,l.lat,l.lng,l.precision,l.pinned_by "editedBy" from pulse.project p join pulse.project_location_member m on m.project_id=p.id join pulse.project_location l on l.id=m.location_id where p.client_id=$1',[key])).rows:[];
  return {annotation,links,merged,locations,availableLocations:admin(v)?(await c.query("select id,coalesce(name,geo_key) name from pulse.project_location order by name")).rows:[],canEdit:admin(v)&&!!v.person};
 }));
 app.post<{Params:{entity:string;id:string};Body:Body}>('/api/v0/stewardship/:entity/:id',{schema:{body}},req=>tx(req,async(c,v)=> {
  must(v); const {entity,id:key}=req.params; await exists(c,entity,key);
  const old=(await c.query('select address,wrong_reason from pulse.record_annotation where entity_type=$1 and entity_id=$2 for update',[entity,key])).rows[0];
  await c.query(`insert into pulse.record_annotation(org_id,entity_type,entity_id,address,wrong_reason,edited_by) values($1,$2,$3,$4,$5,$6)
   on conflict(org_id,entity_type,entity_id) do update set address=excluded.address,wrong_reason=excluded.wrong_reason,edited_by=excluded.edited_by,updated_at=now()`,[v.org,entity,key,'address' in req.body?str(req.body.address,500)||null:old?.address??null,'wrongReason' in req.body?str(req.body.wrongReason,500)||null:old?.wrong_reason??null,v.person]);return {ok:true};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/projects/:id/location',{schema:{body}},req=>tx(req,async(c,v)=>{
  must(v);await exists(c,'project',req.params.id);const location=req.body.locationId?id(req.body.locationId):null;
  if(location){if(!(await c.query('select 1 from pulse.project_location where id=$1',[location])).rows[0])fail(404,'Location not found');
   await c.query("insert into pulse.project_location_member(org_id,project_id,location_id,basis) values($1,$2,$3,'pulse') on conflict(project_id) do update set location_id=excluded.location_id,basis='pulse'",[v.org,req.params.id,location]);return {ok:true};}
  const lat=Number(req.body.lat),lng=Number(req.body.lng);if(!str(req.body.lat)||!str(req.body.lng)||!Number.isFinite(lat)||!Number.isFinite(lng)||Math.abs(lat)>90||Math.abs(lng)>180||!str(req.body.note))fail(400,'Choose a location, or give valid coordinates and a source note');
  const p=(await c.query('select coalesce(title,name) name from pulse.project where id=$1',[req.params.id])).rows[0];
  const row=(await c.query("insert into pulse.project_location(org_id,geo_key,name,lat,lng,precision,source,pinned_by,pinned_at) values($1,$2,$3,$4,$5,'exact',$6,$7,now()) on conflict(org_id,geo_key) do update set lat=excluded.lat,lng=excluded.lng,source=excluded.source,pinned_by=excluded.pinned_by,pinned_at=now() returning id",[v.org,'pulse:'+req.params.id,p.name,lat,lng,'pulse_pin:'+str(req.body.note,300),v.person])).rows[0];
  await c.query("insert into pulse.project_location_member(org_id,project_id,location_id,basis) values($1,$2,$3,'pulse') on conflict(project_id) do update set location_id=excluded.location_id,basis='pulse'",[v.org,req.params.id,row.id]);return {ok:true};
 }));
 // Anyone with their own sign-in suggests a correction; it lands in Review data for an admin (migration 0036).
 app.post<{Body:Body}>('/api/v0/corrections/suggest',{schema:{body}},req=>tx(req,async(c,v)=> {
  if(!v.person) fail(403,'Sign in with your own account to suggest a correction');
  const b=req.body; return {id:(await c.query('select pulse.suggest_correction($1,$2,$3,$4,$5) id',[str(b.entity),id(b.entityId),str(b.field),str(b.value,300),str(b.note,1000)])).rows[0].id};
 }));
 app.post<{Body:Body}>('/api/v0/record-links',{schema:{body}},req=>tx(req,async(c,v)=> {
  must(v); const b=req.body,entity=str(b.entity),key=id(b.entityId); await exists(c,entity,key);
  if(b.action==='delete') {await c.query('delete from pulse.record_link where id=$1 and entity_id=$2 and entity_type=$3',[id(b.id),key,entity]);return {ok:true};}
  const old=b.id?(await c.query('select kind,value,label from pulse.record_link where id=$1 and entity_id=$2 and entity_type=$3 for update',[id(b.id),key,entity])).rows[0]:null;if(b.id&&!old)fail(404,'Link not found');
  const kind=str('kind' in b?b.kind:old?.kind),value=str('value' in b?b.value:old?.value,1000),label=str('label' in b?b.label:old?.label); if(!['drive_file','drive_folder','video','maps','rera','website','campaign'].includes(kind)||!value||!label) fail(400,'Choose a kind, label and value');
  if(kind!=='rera'&&!/^https?:\/\//i.test(value)) fail(400,'Use an http or https link');
  if(b.id) await c.query('update pulse.record_link set kind=$1,label=$2,value=$3,edited_by=$4,updated_at=now() where id=$5 and entity_id=$6 and entity_type=$7',[kind,label,value,v.person,id(b.id),key,entity]);
  else await c.query('insert into pulse.record_link(org_id,entity_type,entity_id,kind,label,value,edited_by) values($1,$2,$3,$4,$5,$6,$7)',[v.org,entity,key,kind,label,value,v.person]); return {ok:true};
 }));
 app.post<{Body:Body}>('/api/v0/records/merge',{schema:{body}},req=>tx(req,async(c,v)=> {must(v);if(['client','contact'].includes(str(req.body.entity)))fail(409,'Open identity review to preview evidence and associations before merging');return {id:(await c.query('select pulse.merge_records($1,$2,$3) id',[str(req.body.entity),id(req.body.keepId),id(req.body.goneId)])).rows[0].id};}));
 app.post<{Body:Body}>('/api/v0/records/undo-merge',{schema:{body}},req=>tx(req,async(c,v)=> {must(v);await c.query('select pulse.undo_merge($1)',[id(req.body.id)]);return {ok:true};}));
 app.post<{Params:{file:string};Body:Body}>('/api/v0/files/:file/correct',{schema:{body}},req=>tx(req,async(c,v)=> {
  must(v); const old=(await c.query('select display_name,project_id,wrong_reason from pulse.file_correction where file_id=$1 for update',[str(req.params.file)])).rows[0];
  await c.query('select pulse.correct_file($1,$2,$3,$4)',[str(req.params.file),'displayName' in req.body?str(req.body.displayName,300)||null:old?.display_name??null,'projectId' in req.body?(req.body.projectId?id(req.body.projectId):null):old?.project_id??null,'wrongReason' in req.body?str(req.body.wrongReason,500)||null:old?.wrong_reason??null]); return {ok:true};
 }));
 app.get('/api/v0/shifts',req=>tx(req,async(c,v)=> {if(!hr(v)) fail(403,'HR manages shifts');return {shifts:(await c.query("select id,name,to_char(start_time,'HH24:MI') start,to_char(end_time,'HH24:MI') end,grace_minutes grace,work_days days from pulse.shift order by name")).rows,assignments:(await c.query('select s.*,p.display_name name from pulse.person_shift s join pulse.person p on p.id=s.person_id order by valid_from desc')).rows,people:(await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by display_name")).rows};}));
 app.post<{Body:Body}>('/api/v0/shifts',{schema:{body}},req=>tx(req,async(c,v)=> {
  if(!hr(v)||!v.person) fail(403,'HR manages shifts');const b=req.body;
  if(b.personId) {
   const who=id(b.personId),shift=id(b.shiftId),from=str(b.from),mode=str(b.mode); if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!['office','wfh','field'].includes(mode)) fail(400,'Choose mode and effective date');
   await exists(c,'person',who); if(!(await c.query('select 1 from pulse.shift where id=$1',[shift])).rows[0]) fail(404,'Shift not found');
   await c.query('update pulse.person_shift set valid_to=$1::date-1 where person_id=$2 and mode=$3 and valid_from<$1 and (valid_to is null or valid_to >=$1)',[from,who,mode]);
   await c.query('insert into pulse.person_shift(org_id,person_id,shift_id,mode,valid_from) values($1,$2,$3,$4,$5) on conflict(org_id,person_id,mode,valid_from) do update set shift_id=excluded.shift_id',[v.org,who,shift,mode,from]);
  } else { const old=b.id?(await c.query("select name,to_char(start_time,'HH24:MI') start,to_char(end_time,'HH24:MI') end,grace_minutes grace from pulse.shift where id=$1 for update",[id(b.id)])).rows[0]:null;if(b.id&&!old)fail(404,'Shift not found');for(const field of ['name','start','end','grace'])if(!(field in b)&&old)b[field]=old[field];if(!str(b.name)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(str(b.start))||!/^([01]\d|2[0-3]):[0-5]\d$/.test(str(b.end))) fail(400,'Name the shift and use HH:MM times'); const grace=Number(b.grace??15);if(!Number.isInteger(grace)||grace<0||grace>240) fail(400,'Grace is 0–240 minutes');
   // POLISH-2 (QA-E2E P2-15): a shift's working days (ISO 1 = Monday … 7 = Sunday); unchanged when not given.
   const days=b.days===undefined?null:Array.isArray(b.days)&&b.days.length&&b.days.length<=7&&b.days.every(d=>Number.isInteger(d)&&Number(d)>=1&&Number(d)<=7)?[...new Set(b.days as number[])].sort():fail(400,'Choose the working days (1 = Monday … 7 = Sunday)');
   if(b.id)await c.query('update pulse.shift set name=$1,start_time=$2,end_time=$3,grace_minutes=$4,work_days=coalesce($6::int[],work_days) where id=$5',[str(b.name,80),b.start,b.end,grace,id(b.id),days]);else await c.query("insert into pulse.shift(org_id,name,start_time,end_time,grace_minutes,work_days) values($1,$2,$3,$4,$5,coalesce($6::int[],'{1,2,3,4,5,6}')) on conflict(org_id,name) do update set start_time=excluded.start_time,end_time=excluded.end_time,grace_minutes=excluded.grace_minutes,work_days=coalesce($6::int[],pulse.shift.work_days)",[v.org,str(b.name,80),b.start,b.end,grace,days]); }
  return {ok:true};
 }));
 app.post<{Body:Body}>('/api/v0/notifications/payroll-access',{schema:{body}},req=>tx(req,async(c,v)=>{
  if(v.nativeDevice)fail(403,'Use your administrator web account');
  must(v);
  if(typeof req.body.revoke!=='boolean')fail(400,'Specify whether to revoke the accounts grant');
  await c.query('select pulse.payroll_notice_grant($1,$2)',[id(req.body.personId),req.body.revoke]);return {ok:true};
 }));
 app.post<{Body:Body}>('/api/v0/notifications/payroll-processed',{schema:{body}},req=>tx(req,async(c,v)=>{
  if(v.nativeDevice)fail(403,'Use your accounts web account');
  if(process.env.PULSE_PAYROLL_NOTICES_ENABLED!=='1')fail(503,'Accounts processed notices await approved activation');
  if(typeof req.body.month!=='string'||!/^20[0-9]{2}-(0[1-9]|1[0-2])-01$/.test(req.body.month)||typeof req.body.sourceKey!=='string'||! /^[A-Za-z0-9._:-]{1,100}$/.test(req.body.sourceKey)||req.body.confirmation!=='accounts_processed')fail(400,'Confirm the accounts processed state, month and source key');
  const result=(await c.query('select pulse.payroll_notice_processed($1,$2,$3) id',[id(req.body.personId),req.body.month,req.body.sourceKey])).rows[0];return {id:result.id,state:'processed'};
 }));
 app.get('/api/v0/notifications/connections',req=>tx(req,async(c,v)=>{must(v);return {people:(await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by display_name")).rows,connections:(await c.query('select pulse.telegram_connections() data')).rows[0].data};}));
 app.post<{Body:Body}>('/api/v0/notifications/connect',{schema:{body}},req=>tx(req,async(c,v)=>{must(v);if(req.body.confirmation!=='verified_private_recipient')fail(400,'Confirm the person owns this private chat');const chat=str(req.body.chatId);if(chat&&!/^[1-9][0-9]{4,15}$/.test(chat))fail(400,'Use a private Telegram chat ID');await c.query('select pulse.telegram_connect($1,$2)',[id(req.body.personId),chat||null]);return {ok:true};}));
 app.get('/api/v0/notifications',req=>tx(req,async(c)=>{const event=(req.query as {event?:unknown}).event;return {rows:(await c.query('select id,title,href,event_type "eventType",subject_type "subjectType",subject_id "subjectId",expires_at "expiresAt",expires_at>clock_timestamp() "active",snoozed_until "snoozedUntil",1 "contractVersion",read_at "readAt",created_at "at",telegram_status "telegramStatus",pulse.hr_notification_mail(id) "emailStatus",coalesce((select jsonb_agg(jsonb_build_object(\'channel\',d.channel,\'status\',d.status,\'acceptedAt\',d.accepted_at)) from pulse.notification_delivery d where d.notification_id=notification.id),\'[]\'::jsonb) deliveries from pulse.notification where pulse.notification_authorized(id,pulse.current_viewer()) and dismissed_at is null and ($1::uuid is null or id=$1) order by created_at desc limit 30',[event===undefined?null:id(event)])).rows};}));
 app.post<{Body:Body}>('/api/v0/notifications/read',{schema:{body}},req=>tx(req,async(c)=> {const result=await c.query('update pulse.notification set read_at=coalesce(read_at,now()) where id=$1 and pulse.notification_authorized(id,pulse.current_viewer())',[id(req.body.id)]);if(!result.rowCount)fail(404,'Notification unavailable');return {ok:true};}));
 app.get('/api/v0/communication',req=>tx(req,async(c,v)=> {
  const a=(await c.query("select handle,is_shared from pulse.account where provider='google' and handle=$1 and purpose like 'Workspace%'",[v.email])).rows[0];
  return {account:v.email,mailConnected:!!a&&!a.is_shared&&!!v.person,sendEnabled:process.env.PULSE_GMAIL_SEND_ENABLED==='1',uploadEnabled:process.env.PULSE_DRIVE_UPLOAD_ENABLED==='1',channels:[{name:'Email',state:a&&!a.is_shared?'Read-only Gmail':'Individual Workspace account required'},{name:'WhatsApp Business',state:'Awaiting business number and provider'}]};
 }));
 app.get('/api/v0/inbox',req=>tx(req,(c,v)=>inbox(c,v,req.query as Record<string,string>)));
 // Inline images and attachments of the viewer's own mail: raster images preview inline, anything else downloads.
 app.get('/api/v0/inbox/attachment',async(req,reply)=>{
  const f=await tx(req,(c,v)=>attachment(c,v,req.query as Record<string,string>));const inline=/^image\/(png|jpeg|gif|webp)$/.test(f.mime);
  reply.header('cache-control','private, max-age=3600').header('x-content-type-options','nosniff').header('content-security-policy','sandbox').header('content-disposition',`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`).type(inline?f.mime:'application/octet-stream');return reply.send(f.bytes);
 });
 app.post<{Body:Body}>('/api/v0/inbox/send',{schema:{body}},req=>tx(req,async(c,v)=> {
  if(process.env.PULSE_GMAIL_SEND_ENABLED!=='1') fail(403,'Sending is disabled until the owner authorises gmail.send domain-wide delegation');
  const a=(await c.query("select 1 from pulse.account where provider='google' and handle=$1 and holder_person_id=$2 and not is_shared and purpose like 'Workspace%'",[v.email,v.person])).rows[0];if(!a) fail(403,'Use your individual Workspace sign-in');
  const b=req.body,to=str(b.to,250);if(!/^[^\s@,;\r\n]+@[^\s@,;\r\n]+\.[^\s@,;\r\n]+$/.test(to)||/[\r\n]/.test(String(b.subject??''))||!str(b.subject)) fail(400,'Use one email recipient and a subject');
  const result=await bridge('send',{subject:v.email,to,title:str(b.subject),body:str(b.body,20000)});await c.query("select pulse.audit_write('send','gmail.message')");return result;
 }));
 app.get<{Params:{id:string}}>('/api/v0/projects/:id/upload',req=>tx(req,async(c,v)=> {
  work(v);await exists(c,'project',req.params.id);const p=(await c.query('select folder_id from pulse.project_location_member where project_id=$1',[req.params.id])).rows[0];
  const explicit=(await c.query("select value from pulse.record_link where entity_type='project' and entity_id=$1 and kind='drive_folder' order by updated_at desc limit 1",[req.params.id])).rows[0]?.value;
  const folder=explicit?.match(/folders\/([A-Za-z0-9_-]+)/)?.[1]??p?.folder_id;
  return {enabled:process.env.PULSE_DRIVE_UPLOAD_ENABLED==='1'&&!!folder&&!!v.person,folder,reason:process.env.PULSE_DRIVE_UPLOAD_ENABLED!=='1'?'Drive writing is disabled until an authorised drive.file scope and folder access are configured.':!folder?'Confirm the project Drive folder first.':'Signed-in person will be recorded as uploader.'};
 }));
 app.post<{Params:{id:string};Body:Body}>('/api/v0/projects/:id/upload',{schema:{body},bodyLimit:8000000},req=>tx(req,async(c,v)=> {
  work(v);if(process.env.PULSE_DRIVE_UPLOAD_ENABLED!=='1'||!v.person) fail(403,'Upload is disabled until Drive write access is configured');await exists(c,'project',req.params.id);
  if(!admin(v)&&!(await c.query('select 1 from pulse.delivery where project_id=$1 and uploader_account=$2',[req.params.id,v.email])).rows[0]) fail(403,'Use a project you work on');
  const p=(await c.query('select folder_id from pulse.project_location_member where project_id=$1',[req.params.id])).rows[0];
  const explicit=(await c.query("select value from pulse.record_link where entity_type='project' and entity_id=$1 and kind='drive_folder' order by updated_at desc limit 1",[req.params.id])).rows[0]?.value;
  const folder=explicit?.match(/folders\/([A-Za-z0-9_-]+)/)?.[1]??p?.folder_id;if(!folder) fail(409,'Confirm the project Drive folder first');
  const b=req.body;if(!/^[A-Za-z0-9+/]*={0,2}$/.test(str(b.bytes,8000000))||!str(b.name)) fail(400,'Choose a file (up to 5 MB)');
  const result=await bridge('upload',{subject:v.email,folder,name:str(b.name,300),mime:str(b.mime)||'application/octet-stream',bytes:str(b.bytes,8000000)});
  await c.query(`insert into pulse.activity_observation(org_id,source_key,file_id,project_id,at,operation,actor_account,actor_id,actor_kind,human_attribution,basis,evidence) values($1,$2,$3,$4,now(),'upload',$5,$6,'individual','qualified','Signed-in Pulse uploader',$7) on conflict do nothing`,[v.org,'pulse-upload:'+result.id,result.id,req.params.id,v.email,v.person,JSON.stringify({source:'pulse_upload',folder})]);
  await c.query("select pulse.audit_write('upload','drive.file',$1,array['project_id','uploader'])",[result.id]);return result;
 }));
 // UX-TENANT: the Ops Hub folder holds the install's own company's backups; no other company lists or imports them.
 const ownOpsHub=()=>{if(hostCompany())fail(403,'The Ops Hub import folder belongs to this install\'s own company');};
 app.get('/api/v0/opshub',req=>tx(req,async(_c,v)=> {
  must(v);ownOpsHub(); const dir=process.env.PULSE_OPSHUB_DIR??'/home/eadev/ea-research/data/opshub'; const files=await readdir(dir).catch(()=>[]);
  return {files:files.filter(f=>f.endsWith('.json')),instructions:'Export the Ops Hub backup JSON (clients, tasks, team, phases) to ~/ea-research/data/opshub/. Pulse imports stable IDs and preserves manual corrections.'};
 }));
 app.post<{Body:Body}>('/api/v0/opshub/import',{schema:{body}},req=>tx(req,async(c,v)=> {
  must(v);ownOpsHub();const dir=process.env.PULSE_OPSHUB_DIR??'/home/eadev/ea-research/data/opshub';const file=str(req.body.file);if(!/^[A-Za-z0-9_. -]+\.json$/.test(file)||file.includes('..')) fail(400,'Choose a backup from the Ops Hub import folder');
  try {const {stdout}=await run(process.env.PULSE_WORKER_PYTHON??resolve('.venv/bin/python'),['-m','pulse_workers.opshub_seed','--file',resolve(dir,file),'--org',v.org],{timeout:45000,maxBuffer:200000,env:process.env});await c.query("select pulse.audit_write('import','opshub')");return JSON.parse(stdout);}catch {fail(503,'Ops Hub import could not complete. Check the backup format; no source contents are logged.');}
 }));
}
