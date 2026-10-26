import type {FastifyInstance} from 'fastify';import type {PoolClient} from 'pg';
import {admin,work,fail,type Tx,type Viewer} from './routes.js';
import {compareIdentity,validIdentitySourceRef,type Identity,type Assertion} from './client-identity-model.js';
import {movementSummary,type FinanceState} from './finance-model.js';
import {digest} from './intelligence-model.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const key=(x:unknown)=>UUID.test(String(x))?String(x):fail(400,'Choose a valid identity');
const text=(x:unknown,n=300)=>String(x??'').trim().slice(0,n);
const must=(v:Viewer)=>{if(!admin(v)||!v.person)fail(403,'An individual admin reviews client identity');};
const KEPT=['display_name','company_name','website','email','phone','city','business_roles','legal_org_id','entity_kind','relationship_owner_id','renewal_on','locked','updated_at'] as const;
const snapshot=(r:Record<string,unknown>)=>Object.fromEntries(KEPT.map(k=>[k,r[k] instanceof Date?(k==='renewal_on'?(r[k] as Date).toISOString().slice(0,10):(r[k] as Date).toISOString()):r[k]??null]));
async function identities(c:PoolClient,entity='client') {
 const rows=entity==='client'?(await c.query(`select id,display_name name,entity_kind kind,legal_org_id "legalOrgId" from pulse.client where not exists(select 1 from pulse.record_merge m where entity_type='client' and gone_id=client.id and undone_at is null) order by display_name`)).rows:(await c.query("select id,display_name name,'person' kind,null::uuid \"legalOrgId\" from pulse.person where side<>'staff' and status='active' order by display_name")).rows;
 const assertions=(await c.query('select a.*,coalesce(m.keep_id,a.entity_id) resolved_id from pulse.identity_assertion a left join pulse.record_merge m on m.entity_type=a.entity_type and m.gone_id=a.entity_id and m.undone_at is null where a.entity_type=$1',[entity])).rows as Assertion[];
 return rows.map(r=>({...r,assertions:assertions.filter(a=>(a as Assertion&{resolved_id:string}).resolved_id===r.id)})) as Identity[];
}
async function pair(c:PoolClient,keep:string,gone:string,entity='client') {
 const rows=await identities(c,entity),a=rows.find(r=>r.id===keep),b=rows.find(r=>r.id===gone);if(!a||!b||keep===gone)fail(404,'Choose two current identities');
 return {a:a!,b:b!,...compareIdentity(a!,b!)};
}
async function preview(c:PoolClient,keep:string,gone:string) {
 const comparison=await pair(c,keep,gone);
 const rows=(await c.query('select * from pulse.client where id in ($1,$2) order by id for update',[keep,gone])).rows;
 const a=rows.find(r=>r.id===keep)!,b=rows.find(r=>r.id===gone)!;
 const projects=(await c.query('select id,coalesce(title,name) name from pulse.project where client_id=$1 order by id',[gone])).rows;
 const tasks=(await c.query('select t.id,t.title from pulse.task t join pulse.project p on p.id=t.project_id where p.client_id=$1 order by t.id',[gone])).rows;
 const contacts=(await c.query('select cc.person_id id,p.display_name name from pulse.client_contact cc join pulse.person p on p.id=cc.person_id where cc.client_id=$1 order by cc.person_id',[gone])).rows;
 const relationships=(await c.query('select id,kind,authority,to_jsonb(r) snapshot from pulse.client_relationship r where client_id=$1 order by id',[gone])).rows;
 const associations={projects,tasks,contacts,relationships,invoices:'Invoice identity intake is not connected. Project-based authorized rollups follow the retained account relationship; no invoice source is edited.',approvals:'No approval entity intake is connected; project-scoped tasks follow the same project.',permissions:'Portal memberships and grants remain explicit. A merge grants no portal access.'};
 const [left,right]=[keep,gone].sort();const rejected=(await c.query("select 1 from pulse.identity_pair_decision where entity_type='client' and left_id=$1 and right_id=$2 and evidence_version=$3 and action='rejected'",[left,right,comparison.evidenceVersion])).rows.length>0;
 const aliases=(await c.query("select raw_value as raw from pulse.identity_link where entity_type='client' and entity_id in($1,$2)",[keep,gone])).rows;
 return {...comparison,keep:{id:keep,name:a.display_name,fields:snapshot(a),locked:a.locked},gone:{id:gone,name:b.display_name,fields:snapshot(b),locked:b.locked},aliases,associations,token:digest([snapshot(a),snapshot(b),comparison.evidenceVersion,associations]),fields:KEPT.filter(k=>!['locked','updated_at','entity_kind'].includes(k)),canMerge:comparison.candidate&&!comparison.mergeBlocked&&!rejected};
}
export function registerClientMasterRoutes(app:FastifyInstance,{tx}:{tx:Tx}) {
 app.get('/api/v0/client-master',req=>tx(req,async(c,v)=>{
  work(v);const rows=(await c.query(`with delivery_scope as materialized (select p.client_id,max(d.delivered_at) last from pulse.delivery d join pulse.project p on p.id=d.project_id where ($1::text is null or pulse.delivery_matches(d.file_id,$1)) group by p.client_id), project_counts as materialized (select client_id,count(*)::int engagements from pulse.project group by client_id) select cl.id,cl.display_name name,cl.entity_kind "entityKind",cl.business_roles roles,cl.company_name "companyName",cl.relationship_owner_id "ownerId",pe.display_name "ownerName",cl.renewal_on::text "renewalOn",cl.legal_org_id "legalOrgId",cl.locked,
   (case when entity_kind<>'unknown' then 1 else 0 end + case when relationship_owner_id is not null then 1 else 0 end + case when company_name is not null then 1 else 0 end + case when cardinality(business_roles)>0 then 1 else 0 end)::int completeness,
   coalesce(pc.engagements,0) engagements,ds.last "lastDeliveryAt"
   from pulse.client cl left join pulse.person pe on pe.id=cl.relationship_owner_id left join delivery_scope ds on ds.client_id=cl.id left join project_counts pc on pc.client_id=cl.id where not exists(select 1 from pulse.record_merge m where entity_type='client' and gone_id=cl.id and undone_at is null) order by cl.display_name`,[v.role==='admin'||v.role==='leadership'?null:v.person?`person:${v.person}`:v.email])).rows;
  let pairs:unknown[]=[];
  if(admin(v)) {
   const entities=await identities(c);const rejected=(await c.query("select * from pulse.identity_pair_decision where entity_type='client' and action='rejected'")).rows;
   // Block by verified identifiers or organisation; never generate a Cartesian name-similarity queue.
   const blocks=new Map<string,Identity[]>();for(const e of entities)for(const a of e.assertions)if(a.verified&&!a.shared&&['external_id','organization','email','phone'].includes(a.kind)){const key=a.kind+':'+a.source_scope+':'+a.value;blocks.set(key,[...(blocks.get(key)??[]),e]);}
   const seen=new Set<string>();
   for(const block of blocks.values())for(let i=0;i<block.length;i++)for(let j=i+1;j<block.length;j++) {
    const [a,b]=[block[i],block[j]].sort((a,b)=>a.id.localeCompare(b.id));if(a.id===b.id)continue;const pkey=a.id+':'+b.id;if(seen.has(pkey))continue;seen.add(pkey);const p=compareIdentity(a,b);
    if(p.candidate&&!rejected.some(r=>r.left_id===a.id&&r.right_id===b.id&&r.evidence_version===p.evidenceVersion))pairs.push({left:a,right:b,...p});
   }
  }
  const reviewCounts=new Map<string,number>();for(const p of pairs as {left:Identity;right:Identity}[])for(const id of [p.left.id,p.right.id])reviewCounts.set(id,(reviewCounts.get(id)??0)+1);
  return {rows:rows.map(r=>({...r,reviewCount:reviewCounts.get(r.id)??0})),pairs:pairs.slice(0,100),pairTotal:pairs.length,canEdit:admin(v)&&!!v.person,definition:'Completeness: entity kind, owner, company name and confirmed business roles (0–4); not a quality score.'};
 }));
 app.get<{Params:{id:string}}>('/api/v0/client-master/:id',req=>tx(req,async(c,v)=>{
  work(v);const id=key(req.params.id);const row=(await c.query('select * from pulse.client where id=$1',[id])).rows[0];if(!row)fail(404,'Client unavailable');
  const contactAuthority=(await c.query("select exists(select 1 from pulse.client_relationship where client_id=$1 and authority in ('contact','decision') and kind='service_contact' and valid_from<=current_date and (valid_to is null or valid_to>=current_date)) ok",[id])).rows[0].ok;
  const commercial=row.renewal_on?{state:'Term recorded',reason:`Recorded term date: ${row.renewal_on.toISOString().slice(0,10)}; confirm contract and contact authority.`}:{state:'Unknown',reason:'No explicit term date or invoice dispute source.'};
  const last=(await c.query('select max(d.delivered_at) as observed_at from pulse.delivery d join pulse.project p on p.id=d.project_id where p.client_id=$1 and pulse.delivery_matches(d.file_id,$2)',[id,v.role==='admin'||v.role==='leadership'?null:v.person?`person:${v.person}`:v.email])).rows[0].observed_at;
  const health={service:{state:'Unknown',reason:'Missed commitments and unresolved feedback are not completely connected.'},commercial,relationship:{state:last?'Observed delivery':'Unknown',reason:last?`Latest authorized delivery: ${last.toISOString().slice(0,10)}. This is not a contact or churn event.`:'No authorized delivery recency available.'},ltv:{state:'Unknown',reason:'Certified invoices, bank applications and an approved net-revenue policy are required. Covered history is not declared complete.'},canPrepare:!!row.relationship_owner_id&&contactAuthority&&!!row.renewal_on};
  const assertions=admin(v)?(await c.query("select * from pulse.identity_assertion where entity_type='client' and (entity_id=$1 or entity_id in(select gone_id from pulse.record_merge where keep_id=$1 and entity_type='client' and undone_at is null)) order by observed_at desc",[id])).rows:[];
  const financeAllowed=(await c.query("select pulse.money_can('money.read') and pulse.money_can('money.amount.read') ok")).rows[0].ok;
  const financeState:FinanceState|null=financeAllowed?(await c.query('select pulse.finance_state() data')).rows[0].data:null;
  const financeCollections=financeState?movementSummary(financeState,new Date().toISOString().slice(0,7),'INR',2).clientCollections.filter(f=>f.clientId===id):null;
  return {financeCollections,client:{id,name:row.display_name,entityKind:row.entity_kind,roles:row.business_roles,legalOrgId:row.legal_org_id,ownerId:row.relationship_owner_id,renewalOn:row.renewal_on?.toISOString().slice(0,10)??null,locked:row.locked},health,assertions,relationships:admin(v)?(await c.query('select * from pulse.client_relationship where client_id=$1',[id])).rows:[],organizations:admin(v)?(await c.query('select id,display_name name from pulse.legal_organization order by display_name')).rows:[],contacts:admin(v)?(await c.query("select id,display_name name from pulse.person where side<>'staff' and status='active' order by display_name")).rows:[],people:admin(v)?(await c.query("select id,display_name name from pulse.person where side='staff' and status='active' order by display_name")).rows:[],merges:admin(v)?(await c.query("select id,keep_id,gone_id,merged_at,undone_at from pulse.record_merge where entity_type='client' and keep_id=$1 order by merged_at desc",[id])).rows:[],canEdit:admin(v)&&!!v.person};
 }));
 app.post<{Params:{id:string};Body:Record<string,unknown>}>('/api/v0/client-master/:id',req=>tx(req,async(c,v)=>{
  must(v);const id=key(req.params.id),b=req.body,kind=text(b.entityKind),roles=Array.isArray(b.roles)?b.roles:[],owner=b.ownerId?key(b.ownerId):null,org=b.legalOrgId?key(b.legalOrgId):null,renewal=b.renewalOn?text(b.renewalOn):null;
  if(!['unknown','person','company'].includes(kind)||roles.some(r=>!['developer','channel_partner','other'].includes(String(r))))fail(400,'Choose the entity kind and confirmed roles');
  if(renewal&&(!/^\d{4}-\d{2}-\d{2}$/.test(renewal)||new Date(renewal).toISOString().slice(0,10)!==renewal))fail(400,'Choose a valid term date');
  if(org&&kind!=='company')fail(400,'Link a legal organisation only to a company account');
  if(owner&&!(await c.query("select 1 from pulse.person where id=$1 and status='active' and side='staff'",[owner])).rows.length)fail(400,'Choose an active relationship owner');
  if(org&&!(await c.query('select 1 from pulse.legal_organization where id=$1',[org])).rows.length)fail(400,'Organisation unavailable');
  const before=(await c.query('select entity_kind,business_roles,legal_org_id,relationship_owner_id,renewal_on from pulse.client where id=$1 for update',[id])).rows[0];if(!before)fail(404,'Client unavailable');
  await c.query(`update pulse.client set entity_kind=$1,business_roles=$2,relationship_owner_id=$3,legal_org_id=$4,renewal_on=$5,locked=array(select distinct unnest(locked||'{entity_kind,business_roles,relationship_owner_id,legal_org_id,renewal_on}'::text[])),updated_at=now() where id=$6`,[kind,[...new Set(roles)],owner,org,renewal,id]);
  await c.query("select pulse.audit_write('client_master_update','client',$1,array['entity_kind','business_roles','relationship_owner_id','legal_org_id','renewal_on'])",[id]);return {ok:true};
 }));
 app.post<{Body:Record<string,unknown>}>('/api/v0/client-master/organizations',req=>tx(req,async(c,v)=>{must(v);const name=text(req.body.name);if(name.length<2)fail(400,'Name the legal organisation');const row=(await c.query('insert into pulse.legal_organization(org_id,display_name,original_script_name) values($1,$2,$2) returning id',[v.org,name])).rows[0];await c.query("select pulse.audit_write('legal_organization_created','organization',$1)",[row.id]);return row;}));
 app.post<{Body:Record<string,unknown>}>('/api/v0/client-master/bind-external',req=>tx(req,async(c,v)=>{
  must(v);const id=key(req.body.entityId),scope=text(req.body.sourceScope),external=text(req.body.externalId),ref=text(req.body.sourceRef);if(!scope||!external||!validIdentitySourceRef(ref))fail(400,'Record the trusted scoped external ID and receipt');
  if(!(await c.query('select 1 from pulse.client where id=$1',[id])).rows.length)fail(404,'Client unavailable');
  await c.query('select pg_advisory_xact_lock(hashtext($1))',[v.org+':external:'+scope+':'+external]);
  const old=(await c.query("select entity_id from pulse.external_identity_binding where entity_type='client' and source_scope=$1 and external_id=$2",[scope,external])).rows[0];
  if(old&&old.entity_id!==id)fail(409,'This trusted external ID already belongs to another record; review the identities');
  await c.query("insert into pulse.external_identity_binding(org_id,source_scope,external_id,entity_type,entity_id,source_ref,bound_by) values($1,$2,$3,'client',$4,$5,$6) on conflict do nothing",[v.org,scope,external,id,ref,v.person]);
  const redirected=(await c.query("select keep_id from pulse.record_merge where entity_type='client' and gone_id=$1 and undone_at is null",[id])).rows[0];
  await c.query("select pulse.audit_write('external_identity_binding','client',$1)",[id]);return {entityId:redirected?.keep_id??id,replayed:!!old,method:'trusted_scoped_external_id'};
 }));
 app.post<{Params:{id:string};Body:Record<string,unknown>}>('/api/v0/client-master/:id/assertions',req=>tx(req,async(c,v)=>{
  must(v);const id=key(req.params.id),b=req.body,kind=text(b.kind),value=text(b.value),scope=text(b.sourceScope),ref=text(b.sourceRef),family=text(b.sourceFamily);
  if(!['external_id','email','phone','organization','entity_kind','alias'].includes(kind)||!value||!scope||!validIdentitySourceRef(ref)||!family)fail(400,'Record the assertion, source scope, receipt and independent source family');
  if(!(await c.query('select 1 from pulse.client where id=$1',[id])).rows.length)fail(404,'Client unavailable');
  const saved=(await c.query(`insert into pulse.identity_assertion(org_id,entity_type,entity_id,kind,value,verified,shared,source_scope,source_ref,source_family,asserted_by) values($1,'client',$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing returning id`,[v.org,id,kind,value,b.verified===true||b.verified==='true',b.shared===true||b.shared==='true',scope,ref,family,v.person])).rows[0];
  await c.query("select pulse.audit_write('identity_assertion','client',$1,array[$2])",[id,kind]);return {ok:true,id:saved?.id??null};
 }));
 app.post<{Params:{id:string};Body:Record<string,unknown>}>('/api/v0/client-master/:id/relationships',req=>tx(req,async(c,v)=>{
  must(v);const id=key(req.params.id),b=req.body,kind=text(b.kind),authority=text(b.authority),ref=text(b.sourceRef),person=b.personId?key(b.personId):null,org=b.legalOrgId?key(b.legalOrgId):null;
  if(!['ownership','billing','service_contact'].includes(kind)||!['unconfirmed','contact','decision','billing'].includes(authority)||!validIdentitySourceRef(ref)||(!person&&!org)||(person&&org))fail(400,'Choose one person or organisation, relationship, authority and source');
  if(!(await c.query('select 1 from pulse.client where id=$1',[id])).rows.length)fail(404,'Client unavailable');
  if(person&&!(await c.query("select 1 from pulse.person where id=$1 and side<>'staff'",[person])).rows.length)fail(400,'Choose an external person');
  if(org&&!(await c.query('select 1 from pulse.legal_organization where id=$1',[org])).rows.length)fail(400,'Organisation unavailable');
  const row=(await c.query(`insert into pulse.client_relationship(org_id,client_id,person_id,legal_org_id,kind,authority,valid_from,source_ref,confirmed_by) values($1,$2,$3,$4,$5,$6,current_date,$7,$8) returning id`,[v.org,id,person,org,kind,authority,ref,v.person])).rows[0];
  if(person&&text(b.effectiveRole)){const client=(await c.query('select legal_org_id from pulse.client where id=$1',[id])).rows[0];if(client?.legal_org_id)await c.query('insert into pulse.organization_contact(org_id,legal_org_id,person_id,effective_role,authority,valid_from,source_ref,confirmed_by) values($1,$2,$3,$4,$5,current_date,$6,$7)',[v.org,client.legal_org_id,person,text(b.effectiveRole),authority,ref,v.person]);}
  await c.query("select pulse.audit_write('client_relationship','client',$1,array[$2])",[id,kind]);return row;
 }));
 app.post<{Body:{keepId:string;goneId:string}}>('/api/v0/client-master/preview',req=>tx(req,async(c,v)=>{must(v);return preview(c,key(req.body.keepId),key(req.body.goneId));}));
 app.post<{Body:{keepId:string;goneId:string;token:string;fields?:string[];reason?:string}}>('/api/v0/client-master/merge',req=>tx(req,async(c,v)=>{
  must(v);const keep=key(req.body.keepId),gone=key(req.body.goneId),token=text(req.body.token),reason=text(req.body.reason,500);if(reason.length<3)fail(400,'Record the reviewed merge reason');
  await c.query('select pg_advisory_xact_lock(hashtext($1))',[v.org+':client-master']);
  const replay=(await c.query("select id,review_version from pulse.record_merge where entity_type='client' and keep_id=$1 and gone_id=$2 and undone_at is null",[keep,gone])).rows[0];if(replay){if(replay.review_version!==token)fail(409,'A different merge review is already recorded');return {id:replay.id,redirect:`/clients/${keep}`,undoToken:replay.id,replayed:true};}
  const p=await preview(c,keep,gone);if(!p.canMerge)fail(409,'Independent evidence and matching confirmed entity kinds are required');if(p.token!==token)fail(409,'The identity or associations changed; preview again');
  const fields=req.body.fields??[];if(!Array.isArray(fields)||fields.some(f=>!p.fields.includes(f as typeof KEPT[number])))fail(400,'Choose only previewed survivor fields');
  const before=p.keep.fields,after={...before};for(const field of fields)after[field]=p.gone.fields[field];
  const mid=(await c.query("select pulse.merge_records('client',$1,$2) id",[keep,gone])).rows[0].id;
  const assignments=fields.map((field,i)=>`"${field}"=$${i+1}`);if(assignments.length)await c.query(`update pulse.client set ${assignments.join(',')},locked=array(select distinct unnest(locked||$${fields.length+1}::text[])),updated_at=now() where id=$${fields.length+2}`,[...fields.map(f=>after[f]),fields,keep]);
  const final=snapshot((await c.query('select * from pulse.client where id=$1',[keep])).rows[0]);
  await c.query('update pulse.record_merge set kept_fields_before=$1,kept_fields_after=$2,review_version=$3 where id=$4',[JSON.stringify(before),JSON.stringify(final),token,mid]);
  const [left,right]=[keep,gone].sort();await c.query("insert into pulse.identity_pair_decision(org_id,entity_type,left_id,right_id,evidence_version,action,reason,decided_by) values($1,'client',$2,$3,$4,'merged',$5,$6) on conflict do nothing",[v.org,left,right,p.evidenceVersion,reason,v.person]);
  return {id:mid,redirect:`/clients/${keep}`,undoToken:mid};
 }));
 app.post<{Body:{leftId:string;rightId:string;evidenceVersion:string;reason:string}}>('/api/v0/client-master/reject',req=>tx(req,async(c,v)=>{
  must(v);const [left,right]=[key(req.body.leftId),key(req.body.rightId)].sort(),p=await pair(c,left,right),reason=text(req.body.reason,500);if(reason.length<3)fail(400,'Record why this pair is different');if(p.evidenceVersion!==req.body.evidenceVersion)fail(409,'Evidence changed; review again');
  await c.query("insert into pulse.identity_pair_decision(org_id,entity_type,left_id,right_id,evidence_version,action,reason,decided_by) values($1,'client',$2,$3,$4,'rejected',$5,$6) on conflict do nothing",[v.org,left,right,p.evidenceVersion,reason,v.person]);await c.query("select pulse.audit_write('identity_pair_rejected','client',$1)",[left]);return {ok:true};
 }));
 app.post<{Params:{id:string};Body:{reason?:string}}>('/api/v0/client-master/:id/renewal-task',req=>tx(req,async(c,v)=>{
  must(v);const id=key(req.params.id),row=(await c.query('select display_name,relationship_owner_id,renewal_on from pulse.client where id=$1 for update',[id])).rows[0];if(!row)fail(404,'Client unavailable');
  if(!row.relationship_owner_id||!row.renewal_on||!(await c.query("select 1 from pulse.client_relationship where client_id=$1 and kind='service_contact' and authority in ('contact','decision') and valid_from<=current_date and (valid_to is null or valid_to>=current_date)",[id])).rows.length)fail(409,'Confirm a relationship owner, term date and contact authority first');
  const sourceKey='renewal:'+id+':'+row.renewal_on.toISOString().slice(0,10);
  const task=(await c.query("insert into pulse.task(org_id,title,status,owner_id,assignee_person_id,due_at,source_key,source,evidence) values($1,$2,'open',$3,$3,$4,$5,'pulse',$6) on conflict(org_id,source_key) do update set source_key=excluded.source_key returning id",[v.org,'Prepare renewal: '+row.display_name,row.relationship_owner_id,row.renewal_on,sourceKey,JSON.stringify({clientId:id,source:'explicit_term',noOutreach:true})])).rows[0];await c.query("select pulse.audit_write('renewal_task','client',$1)",[id]);return {...task,href:'/tasks?q='+encodeURIComponent('Prepare renewal: '+row.display_name)};
 }));
}
