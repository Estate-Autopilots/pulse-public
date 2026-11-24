-- migrate:up
-- Restricted acquisition ingestion. No direct API table grants and no raw payload/token storage.
create table pulse_priv.acq_source(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),controller uuid not null,
 project_id uuid not null references pulse.project(id),path text not null check(path in('buyer','agency')),kind text not null,
 account text not null,purpose text not null check(purpose in('lead','reporting','finance','calendar','contacts','meet')),
 owner_id uuid not null references pulse.person(id),label text not null,state text not null default 'setup' check(state in('setup','authorized','syncing','current','stale','revoked','failed')),
 body jsonb not null default '{}',cutoff timestamptz,cursor text,expires timestamptz,revision int not null default 1,
 unique(org_id,controller,kind,account),unique(org_id,id));
create table pulse_priv.acq_subject(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),controller uuid not null,path text not null,
 contact jsonb not null default '{}',unique(org_id,id));
create table pulse_priv.acq_identity(
 org_id uuid not null,controller uuid not null,path text not null,key_version text not null,keyed text not null,subject_id uuid not null,
 primary key(org_id,controller,path,key_version,keyed),foreign key(org_id,subject_id) references pulse_priv.acq_subject(org_id,id));
create table pulse_priv.acq_enquiry(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),controller uuid not null,path text not null,
 project_id uuid not null references pulse.project(id),subject_id uuid not null,source_id uuid not null,namespace text not null,external_id text not null,
 occurred timestamptz not null,received timestamptz not null default now(),owner_id uuid not null references pulse.person(id),
 body jsonb not null,withdrawn boolean not null default false,revision int not null default 1,
 unique(org_id,controller,path,namespace,external_id),unique(org_id,id),
 foreign key(org_id,subject_id) references pulse_priv.acq_subject(org_id,id),foreign key(org_id,source_id) references pulse_priv.acq_source(org_id,id));
create table pulse_priv.acq_envelope(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),source_id uuid not null,object_id text not null,vintage text not null,
 occurred timestamptz not null,received timestamptz not null default now(),schema_version int not null default 1,batch_hash text not null,
 body jsonb not null,state text not null default 'pending' check(state in('pending','quarantined','resolved','dead_letter','withdrawn')),
 reason text not null default 'Needs scoped review',attempts int not null default 0,next_at timestamptz not null default now(),
 enquiry_id uuid,unique(org_id,source_id,object_id,vintage),unique(org_id,id),
 foreign key(org_id,source_id) references pulse_priv.acq_source(org_id,id),foreign key(org_id,enquiry_id) references pulse_priv.acq_enquiry(org_id,id));
create table pulse_priv.acq_stage(
 id uuid primary key default gen_random_uuid(),org_id uuid not null,enquiry_id uuid not null,request_key text not null,
 stage text not null,effective timestamptz not null,recorded timestamptz not null default now(),actor uuid not null references pulse.person(id),
 verification text not null check(verification in('reported','verified')),evidence text not null,confidence text not null,body jsonb not null default '{}',reverses uuid,
 unique(org_id,enquiry_id,request_key),unique(org_id,id),foreign key(org_id,enquiry_id) references pulse_priv.acq_enquiry(org_id,id),
 foreign key(org_id,reverses) references pulse_priv.acq_stage(org_id,id));
create table pulse_priv.acq_spend(
 org_id uuid not null,source_id uuid not null,day date not null,ad_id text not null,vintage text not null,received timestamptz not null default now(),body jsonb not null,
 primary key(org_id,source_id,day,ad_id,vintage),foreign key(org_id,source_id) references pulse_priv.acq_source(org_id,id));
create table pulse_priv.acq_link(
 id uuid primary key default gen_random_uuid(),org_id uuid not null,enquiry_id uuid not null,invoice_id uuid not null,
 decision_id uuid,minor numeric not null check(minor>0 and minor=trunc(minor)),contract text not null,reference text not null,actor uuid not null references pulse.person(id),
 request_key text not null,at timestamptz not null default now(),unique(org_id,request_key),
 foreign key(org_id,enquiry_id) references pulse_priv.acq_enquiry(org_id,id),foreign key(org_id,invoice_id) references pulse_priv.finance_source(org_id,id),
 foreign key(org_id,decision_id) references pulse_priv.finance_decision(org_id,id));
create table pulse_priv.acq_snapshot(
 org_id uuid not null,source_id uuid not null,object_id text not null,version text not null,body jsonb not null,manual jsonb not null default '{}',deleted boolean not null default false,
 primary key(org_id,source_id,object_id),foreign key(org_id,source_id) references pulse_priv.acq_source(org_id,id));
do $$ declare t text;begin
 foreach t in array array['acq_source','acq_subject','acq_identity','acq_enquiry','acq_envelope','acq_stage','acq_spend','acq_link','acq_snapshot'] loop
 execute format('alter table pulse_priv.%I enable row level security',t);execute format('alter table pulse_priv.%I force row level security',t);
 execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 end loop;end $$;
create function pulse.acq_can(p uuid,w boolean default false) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and not viewer_is('hr') and exists(select 1 from person where id=current_viewer() and org_id=current_org() and side='staff' and status='active')
 and exists(select 1 from project where id=p and org_id=current_org()) and (viewer_is('admin','leadership') or work_project(p))
 and (not w or viewer_is('admin','leadership','pgs','head_pgs','manager'))
$$;
create function pulse.acq_source_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare sid uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid());pr uuid:=(p->>'projectId')::uuid;ct uuid:=(p->>'controller')::uuid;old pulse_priv.acq_source%rowtype;
begin
 if not acq_can(pr,true) then raise exception 'Acquisition source authority required' using errcode='42501';end if;
 if coalesce(p->>'path','') not in('buyer','agency') or (p->>'path'='buyer' and not exists(select 1 from project where id=pr and client_id=ct)) or(p->>'path'='agency' and ct<>current_org()) then raise exception 'Named client controller or EA agency required' using errcode='22023';end if;
 if not exists(select 1 from person where id=(p->>'ownerId')::uuid and org_id=current_org() and side='staff' and status='active') or length(coalesce(p->>'account','')) not between 1 and 160 or length(coalesce(p->>'label','')) not between 1 and 160 or coalesce(p->>'kind','') not in('manual','landing','meta_leads','meta_delivery','google_forms','google_ads','crm','zoho','gmail','calendar','contacts','meet','whatsapp_structured')
 or coalesce(p->>'purpose','') not in('lead','reporting','finance','calendar','contacts','meet') or length(coalesce(p->>'authority',''))<3 then raise exception 'Account owner purpose and controller permission evidence required' using errcode='22023';end if;
 if (p->>'kind' in('manual','landing','meta_leads','google_forms','crm','whatsapp_structured') and p->>'purpose'<>'lead') or (p->>'kind' in('meta_delivery','google_ads') and p->>'purpose'<>'reporting') or(p->>'kind' in('zoho','gmail') and p->>'purpose'<>'finance') or(p->>'kind' in('calendar','contacts','meet') and p->>'purpose'<>p->>'kind') then raise exception 'Source purpose does not match selected lane' using errcode='22023';end if;
 select * into old from pulse_priv.acq_source where org_id=current_org() and id=sid for update;
 if old.id is not null and (old.project_id<>pr or old.controller<>ct or old.path<>p->>'path' or old.kind<>p->>'kind' or old.account<>p->>'account') then raise exception 'Source scope is immutable' using errcode='40001';end if;
 insert into pulse_priv.acq_source(id,org_id,controller,project_id,path,kind,account,purpose,owner_id,label,body) values(sid,current_org(),ct,pr,p->>'path',p->>'kind',p->>'account',p->>'purpose',(p->>'ownerId')::uuid,p->>'label',jsonb_build_object('namespace',coalesce(p->>'namespace',sid::text),'authority',p->>'authority','policy',p->>'policy','notice',p->>'notice','calendar',coalesce(p->'calendar','[]')))
 on conflict(id) do update set owner_id=excluded.owner_id,label=excluded.label,body=pulse_priv.acq_source.body||excluded.body,revision=pulse_priv.acq_source.revision+1;
 perform audit_write('acquisition.source',sid::text);return sid;
end $$;
-- Durable restricted envelope before acknowledgement. Input is an allowlisted metadata object, encrypted contact, or document proposal.
create function pulse.acq_receive(s uuid,p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare src pulse_priv.acq_source%rowtype;eid uuid;previous jsonb;
begin
 select * into src from pulse_priv.acq_source where org_id=current_org() and id=s for update;
 if src.id is null or src.state='revoked' or(src.expires is not null and src.expires<=now()) then raise exception 'Source unavailable or revoked' using errcode='42501';end if;
 if current_viewer() is not null and not acq_can(src.project_id,true) then raise exception 'Scoped intake authority required' using errcode='42501';end if;
 if current_viewer() is null and(src.state not in('authorized','syncing','current','stale') or src.kind='manual') then raise exception 'Transport source not authorized' using errcode='42501';end if;
 if (select count(*) from pulse_priv.acq_envelope where source_id=s and state in('pending','quarantined','dead_letter'))>=10000 then raise exception 'Restricted queue at capacity' using errcode='54000';end if;
 if length(coalesce(p->>'objectId','')) not between 1 and 160 or length(coalesce(p->>'vintage','')) not between 1 and 160 or coalesce(p->>'batchHash','') !~ '^[a-f0-9]{64}$' or p->'normalized' is null then raise exception 'Stable source identity and schema required' using errcode='22023';end if;
 if src.purpose='lead' and (p->'normalized'->>'path' is distinct from src.path or p->'normalized'->>'namespace' is distinct from src.body->>'namespace') then raise exception 'Revenue paths cannot mix' using errcode='22023';end if;
 if src.purpose='lead' and exists(select 1 from pulse_priv.acq_enquiry l where l.org_id=current_org() and l.controller=src.controller and l.path=src.path and l.namespace=p->'normalized'->>'namespace' and l.external_id=p->'normalized'->>'leadId' and l.withdrawn) then raise exception 'Withdrawn lead cannot replay without a new reviewed authority' using errcode='42501';end if;
 insert into pulse_priv.acq_envelope(org_id,source_id,object_id,vintage,occurred,batch_hash,body) values(current_org(),s,p->>'objectId',p->>'vintage',(p->>'occurred')::timestamptz,p->>'batchHash',p->'normalized') on conflict(org_id,source_id,object_id,vintage) do nothing returning id into eid;
 if eid is null then select id,body into eid,previous from pulse_priv.acq_envelope where org_id=current_org() and source_id=s and object_id=p->>'objectId' and vintage=p->>'vintage';if (previous-array['contact','aliases']) is distinct from ((p->'normalized')-array['contact','aliases']) then raise exception 'Envelope replay changed; new vintage required' using errcode='40001';end if;end if;
 return jsonb_build_object('id',eid,'durable',true,'state',(select state from pulse_priv.acq_envelope where id=eid));
end $$;
create function pulse.acq_resolve(e uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare env pulse_priv.acq_envelope%rowtype;src pulse_priv.acq_source%rowtype;b jsonb;subject uuid;eq uuid;alias jsonb;old pulse_priv.acq_enquiry%rowtype;tid uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('acq:'||current_org()::text,0));
 select * into env from pulse_priv.acq_envelope where org_id=current_org() and id=e for update;select * into src from pulse_priv.acq_source where org_id=current_org() and id=env.source_id;
 if not acq_can(src.project_id,true) or src.state='revoked' or (src.expires is not null and src.expires<=now()) then raise exception 'Authorized scoped review required' using errcode='42501';end if;
 if env.state='withdrawn' then raise exception 'Withdrawn evidence cannot replay' using errcode='42501';end if;
 if env.state='resolved' then return jsonb_build_object('id',env.enquiry_id,'duplicate',true);end if;
 if src.purpose<>'lead' then raise exception 'Use the typed document or work reviewer' using errcode='22023';end if;
 b:=env.body;
 if length(coalesce(b->>'leadId','')) not between 1 and 160 or length(coalesce(b->>'namespace','')) not between 1 and 200 or coalesce(b->>'identityBasis','')='ephemeral' then
 update pulse_priv.acq_envelope set state='quarantined',reason='Authorized source lead or row ID required' where id=e;return jsonb_build_object('quarantined',true);end if;
 select * into old from pulse_priv.acq_enquiry where org_id=current_org() and controller=src.controller and path=src.path and namespace=b->>'namespace' and external_id=b->>'leadId';
 if old.id is not null then
 if old.project_id<>src.project_id then raise exception 'Source lead project conflict needs review' using errcode='40001';end if;
 eq:=old.id;subject:=old.subject_id;
 else
 if (select count(distinct i.subject_id) from pulse_priv.acq_identity i join jsonb_array_elements(coalesce(b->'aliases','[]')) a on i.key_version=a->>'version' and i.keyed=a->>'key' where i.org_id=current_org() and i.controller=src.controller and i.path=src.path)>1 then update pulse_priv.acq_envelope set state='quarantined',reason='Phone and email map to different scoped identities' where id=e;return jsonb_build_object('quarantined',true);end if;
 for alias in select value from jsonb_array_elements(coalesce(b->'aliases','[]')) loop
 select subject_id into subject from pulse_priv.acq_identity where org_id=current_org() and controller=src.controller and path=src.path and key_version=alias->>'version' and keyed=alias->>'key';exit when subject is not null;end loop;
 if subject is null then insert into pulse_priv.acq_subject(org_id,controller,path,contact) values(current_org(),src.controller,src.path,coalesce(b->'contact','{}')) returning id into subject;end if;
 for alias in select value from jsonb_array_elements(coalesce(b->'aliases','[]')) loop
 insert into pulse_priv.acq_identity values(current_org(),src.controller,src.path,alias->>'version',alias->>'key',subject) on conflict do nothing;end loop;
 insert into pulse_priv.acq_enquiry(org_id,controller,path,project_id,subject_id,source_id,namespace,external_id,occurred,owner_id,body)
 values(current_org(),src.controller,src.path,src.project_id,subject,src.id,b->>'namespace',b->>'leadId',env.occurred,src.owner_id,b-array['aliases','contact','leadId','namespace','identityBasis']) returning id into eq;
 insert into pulse_priv.acq_stage(org_id,enquiry_id,request_key,stage,effective,actor,verification,evidence,confidence) values(current_org(),eq,'intake','enquiry',env.occurred,current_viewer(),'verified','Authorized source ID '||(b->>'leadId'),'Verified intake only; no commercial outcome');
 if coalesce((b->>'consent')::boolean,false) and not coalesce((b->>'optOut')::boolean,false) and coalesce((b->>'phoneAvailable')::boolean,false) and not coalesce((b->>'test')::boolean,false) then
 insert into pulse.task(org_id,project_id,title,owner_id,assignee_person_id,status,source) values(current_org(),src.project_id,'Follow up enquiry '||(b->>'leadId'),src.owner_id,src.owner_id,'open','pulse') returning id into tid;
 update pulse_priv.acq_enquiry set body=body||jsonb_build_object('taskId',tid) where id=eq;end if;
 end if;
 update pulse_priv.acq_envelope set state='resolved',enquiry_id=eq,reason='Reviewed scoped source ID' where id=e;
 perform audit_write('acquisition.resolve',e::text);return jsonb_build_object('id',eq,'duplicate',old.id is not null);
end $$;
create function pulse.acq_stage_add(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l pulse_priv.acq_enquiry%rowtype;s pulse_priv.acq_stage%rowtype;sid uuid;st text:=p->>'stage';v text:=p->>'verification';b jsonb;prev jsonb;src pulse_priv.acq_source%rowtype;
begin
 select * into l from pulse_priv.acq_enquiry where org_id=current_org() and id=(p->>'enquiryId')::uuid for update;
 if not acq_can(l.project_id) or not(l.owner_id=current_viewer() or acq_can(l.project_id,true)) or l.withdrawn then raise exception 'Assigned staff or scoped reviewer required' using errcode='42501';end if;
 if coalesce(st,'') not in('attempt','connected','visit_planned','visit_completed','booking','sale','opportunity','contract','callback','cancelled','outcome_coverage') or coalesce(v,'') not in('reported','verified') or length(coalesce(p->>'evidence','')) not between 3 and 1000 or length(coalesce(p->>'requestKey','')) not between 1 and 160 or length(coalesce(p->>'confidence','')) not between 1 and 240 or p->>'effective' is null or (p->>'effective')::timestamptz>now()+interval '366 days' then raise exception 'Stage date evidence confidence and request identity required' using errcode='22023';end if;
 if (l.path='buyer' and st in('opportunity','contract')) or(l.path='agency' and st in('visit_planned','visit_completed','booking','sale')) then raise exception 'Stage belongs to a different revenue path' using errcode='22023';end if;
 if coalesce(st,'') not in('visit_planned','callback') and (p->>'effective')::timestamptz>now() then raise exception 'Actual outcome cannot be future dated' using errcode='22023';end if;
 if v='verified' and st in('visit_completed','booking','sale','contract','cancelled','outcome_coverage') then
 if not acq_can(l.project_id,true) or coalesce(p->>'evidenceClass','') not in('approved_crm','approved_register','signed_contract') then raise exception 'Approved register CRM or contract and scoped reviewer required' using errcode='42501';end if;end if;
 if st='connected' and coalesce(p->>'callOutcome','') not in('consultation','callback_requested','no_interest','wrong_number','other_logged') then raise exception 'Explicit logged call outcome required' using errcode='22023';end if;
 if st='cancelled' then select * into s from pulse_priv.acq_stage where id=nullif(p->>'reverses','')::uuid and org_id=current_org() and enquiry_id=l.id;
 if s.id is null or s.stage not in('booking','sale','contract') or (s.verification='verified' and v<>'verified') or exists(select 1 from pulse_priv.acq_stage where org_id=current_org() and enquiry_id=l.id and reverses=s.id and request_key<>p->>'requestKey') then raise exception 'Cancellation must reverse one unreversed stage with adequate verification' using errcode='22023';end if;
 elsif nullif(p->>'reverses','') is not null then raise exception 'Only explicit cancellation reverses history' using errcode='22023';end if;
 if p ? 'minor' and (st not in('booking','sale','contract') or (p->>'minor')::numeric<0 or (p->>'minor')::numeric>9e12 or (p->>'minor')::numeric<>trunc((p->>'minor')::numeric) or p->>'currency' !~ '^[A-Z]{3}$') then raise exception 'Valid scoped commercial value required' using errcode='22023';end if;
 if st='callback' and(not coalesce((l.body->>'consent')::boolean,false) or coalesce((l.body->>'optOut')::boolean,false) or not coalesce((l.body->>'phoneAvailable')::boolean,false)) then raise exception 'Contact authority and phone required for callback' using errcode='22023';end if;
 b:=jsonb_build_object('evidenceClass',p->>'evidenceClass','callOutcome',p->>'callOutcome','minor',p->'minor','currency',p->>'currency','scale',p->'scale');
 select id,to_jsonb(x) into sid,prev from pulse_priv.acq_stage x where org_id=current_org() and enquiry_id=l.id and request_key=p->>'requestKey';
 if sid is not null then if prev->>'stage'<>st or prev->>'verification'<>v or prev->>'evidence'<>p->>'evidence' or (prev->>'effective')::timestamptz<>(p->>'effective')::timestamptz or prev->'body'<>b or prev->>'confidence'<>p->>'confidence' or (prev->>'reverses') is distinct from nullif(p->>'reverses','') then raise exception 'Stage receipt replay changed' using errcode='40001';end if;return sid;end if;
 insert into pulse_priv.acq_stage(org_id,enquiry_id,request_key,stage,effective,actor,verification,evidence,confidence,body,reverses) values(current_org(),l.id,p->>'requestKey',st,(p->>'effective')::timestamptz,current_viewer(),v,p->>'evidence',p->>'confidence',b,nullif(p->>'reverses','')::uuid) returning id into sid;
 update pulse_priv.acq_enquiry set revision=revision+1,body=body||case when st='callback' then jsonb_build_object('callback',p->>'effective') when st='outcome_coverage' then jsonb_build_object('coverage',true) else '{}'::jsonb end where id=l.id;
 if st='callback' and l.body->>'taskId' is not null then update task set due_label=(p->>'effective')::timestamptz::date::text,locked=array(select distinct x from unnest(locked||array['due_label']) x) where id=(l.body->>'taskId')::uuid;end if;
 select * into src from pulse_priv.acq_source where id=l.source_id;
 perform audit_write('acquisition.stage',sid::text);return sid;
end $$;
create function pulse.acq_edit(p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l pulse_priv.acq_enquiry%rowtype;own uuid;
begin
 select * into l from pulse_priv.acq_enquiry where org_id=current_org() and id=(p->>'id')::uuid for update;
 if not acq_can(l.project_id,true) or l.revision<>(p->>'revision')::int or p->>'revision' is null then raise exception 'Scoped current review required' using errcode='40001';end if;
 own:=coalesce(nullif(p->>'ownerId','')::uuid,l.owner_id);
 if not exists(select 1 from person where id=own and org_id=current_org() and side='staff' and status='active') then raise exception 'Active assigned staff required' using errcode='22023';end if;
 if length(coalesce(p->>'reason',''))<3 then raise exception 'Reviewed correction reason required' using errcode='22023';end if;
 update pulse_priv.acq_enquiry set owner_id=own,revision=revision+1,body=body||jsonb_build_object('consent',coalesce(p->'consent',body->'consent'),'optOut',coalesce(p->'optOut',body->'optOut'),'manualOverride',true,'correctionReason',p->>'reason') where id=l.id;
 if l.body->>'taskId' is not null then update task set owner_id=own,assignee_person_id=own,locked=array(select distinct x from unnest(locked||array['owner_id','assignee_person_id']) x) where id=(l.body->>'taskId')::uuid;end if;
 perform audit_write('acquisition.correction',l.id::text);
end $$;
create function pulse.acq_withdraw(e uuid,reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l pulse_priv.acq_enquiry%rowtype;
begin
 select * into l from pulse_priv.acq_enquiry where org_id=current_org() and id=e for update;
 if not acq_can(l.project_id,true) or length(coalesce(reason,''))<3 then raise exception 'Scoped withdrawal reason required' using errcode='42501';end if;
 update pulse_priv.acq_enquiry set withdrawn=true,body=body||jsonb_build_object('withdrawalReason',reason),revision=revision+1 where id=e;
 update pulse_priv.acq_envelope set state='withdrawn',body=body-array['contact','aliases'] where enquiry_id=e and org_id=current_org();
 if not exists(select 1 from pulse_priv.acq_enquiry where org_id=current_org() and subject_id=l.subject_id and not withdrawn) then update pulse_priv.acq_subject set contact='{}' where id=l.subject_id;end if;
 if l.body->>'taskId' is not null then update task set status='cancelled',locked=array(select distinct x from unnest(locked||array['status']) x) where id=(l.body->>'taskId')::uuid;end if;
 perform audit_write('acquisition.withdraw',e::text);
end $$;
create function pulse.acq_contact(e uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l pulse_priv.acq_enquiry%rowtype;
begin
 select * into l from pulse_priv.acq_enquiry where id=e and org_id=current_org();
 if l.id is null or l.withdrawn or not acq_can(l.project_id) or (l.owner_id<>current_viewer() and not acq_can(l.project_id,true)) then raise exception 'Assigned staff contact access required' using errcode='42501';end if;
 perform audit_write('restricted_read','acquisition.contact:'||e::text);
 return(select contact from pulse_priv.acq_subject where org_id=current_org() and id=l.subject_id);
end $$;
create function pulse.acq_state() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or viewer_is('hr') then raise exception 'Acquisition work authority required' using errcode='42501';end if;
 return jsonb_build_object(
 'leads',coalesce((select jsonb_agg(l.body||jsonb_build_object('id',l.id,'buyerId',l.subject_id,'label','Enquiry '||l.external_id,'path',l.path,'controller',l.controller,'projectId',l.project_id,'project',coalesce(pr.title,pr.name),'source',s.label,'sourceId',s.id,'sourceState',s.state,'externalId',l.external_id,'occurred',l.occurred,'received',l.received,'ownerId',l.owner_id,'owner',p.display_name,'withdrawn',l.withdrawn,'revision',l.revision,
 'events',coalesce((select jsonb_agg(t.body||jsonb_build_object('id',t.id,'stage',t.stage,'effective',t.effective,'recorded',t.recorded,'recorder',p2.display_name,'verification',t.verification,'evidence',t.evidence,'confidence',t.confidence,'reverses',t.reverses) order by t.effective,t.recorded,t.id) from pulse_priv.acq_stage t join person p2 on p2.id=t.actor where t.org_id=current_org() and t.enquiry_id=l.id),'[]'),
 'evidence',coalesce((select jsonb_agg('Envelope '||e.object_id||' · '||e.vintage) from pulse_priv.acq_envelope e where e.org_id=current_org() and e.enquiry_id=l.id),'[]')) order by l.occurred,l.id)
 from pulse_priv.acq_enquiry l join project pr on pr.id=l.project_id join pulse_priv.acq_source s on s.id=l.source_id join person p on p.id=l.owner_id where l.org_id=current_org() and not l.withdrawn and acq_can(l.project_id) and(l.owner_id=current_viewer() or acq_can(l.project_id,true))),'[]'),
 'sources',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'label',s.label,'controller',s.controller,'projectId',s.project_id,'path',s.path,'purpose',s.purpose,'state',case when s.state='current' and(s.expires<=now() or s.cutoff<now()-interval '1 day') then 'stale' else s.state end,'cutoff',s.cutoff,'cursor',s.cursor,'revision',s.revision,'backlog',(select count(*) from pulse_priv.acq_envelope e where e.source_id=s.id and e.state in('pending','quarantined','dead_letter')),'owner',p.display_name,'body',s.body)) from pulse_priv.acq_source s join person p on p.id=s.owner_id where s.org_id=current_org() and acq_can(s.project_id,true)),'[]'),
 'reviews',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'kind',s.purpose,'label','Source object '||e.object_id,'reason',e.reason,'owner',p.display_name,'state',e.state,'sourceId',s.id,'body',e.body-array['aliases','contact'],'attempts',e.attempts,'nextAt',e.next_at)) from pulse_priv.acq_envelope e join pulse_priv.acq_source s on s.id=e.source_id join person p on p.id=s.owner_id where e.org_id=current_org() and acq_can(s.project_id,true) and e.state in('pending','quarantined','dead_letter')),'[]'),
 'spend',coalesce((select jsonb_agg(d.body||jsonb_build_object('sourceId',d.source_id,'day',d.day,'adId',d.ad_id,'vintage',d.vintage,'received',d.received)) from pulse_priv.acq_spend d join pulse_priv.acq_source s on s.id=d.source_id where d.org_id=current_org() and acq_can(s.project_id,true)),'[]'),
 'links',case when money_can('money.amount.read') then coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'enquiryId',x.enquiry_id,'invoiceId',x.invoice_id,'decisionId',x.decision_id,'minor',x.minor,'contract',x.contract,'reference',x.reference,'active',coalesce(d.active,true),'path',l.path)) from pulse_priv.acq_link x join pulse_priv.acq_enquiry l on l.id=x.enquiry_id left join pulse_priv.finance_decision d on d.id=x.decision_id where x.org_id=current_org() and acq_can(l.project_id,true)),'[]') else '[]'::jsonb end,
 'workspace',coalesce((select jsonb_agg(jsonb_build_object('id',s.object_id,'kind',src.purpose,'label',coalesce(s.body->>'label',s.object_id),'reason',coalesce(s.body->>'reason','Review source crosswalk'),'owner',p.display_name,'state',coalesce(s.body->>'state','review'),'sourceId',s.source_id,'body',s.body||s.manual,'version',s.version)) from pulse_priv.acq_snapshot s join pulse_priv.acq_source src on src.id=s.source_id join person p on p.id=src.owner_id where s.org_id=current_org() and not s.deleted and src.state<>'revoked' and acq_can(src.project_id,true)),'[]'));
end $$;
revoke all on function pulse.acq_can(uuid,boolean),pulse.acq_source_save(jsonb),pulse.acq_receive(uuid,jsonb),pulse.acq_resolve(uuid),pulse.acq_stage_add(jsonb),pulse.acq_edit(jsonb),pulse.acq_withdraw(uuid,text),pulse.acq_contact(uuid),pulse.acq_state() from public;
grant execute on function pulse.acq_can(uuid,boolean),pulse.acq_source_save(jsonb),pulse.acq_receive(uuid,jsonb),pulse.acq_resolve(uuid),pulse.acq_stage_add(jsonb),pulse.acq_edit(jsonb),pulse.acq_withdraw(uuid,text),pulse.acq_contact(uuid),pulse.acq_state() to pulse_api;
