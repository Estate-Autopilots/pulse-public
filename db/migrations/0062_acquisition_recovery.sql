-- migrate:up
-- Manual source controls and reviewed recovery preserve provider truth and downstream conservation.
create or replace function pulse.acq_state() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or viewer_is('hr') then raise exception 'Acquisition work authority required' using errcode='42501';end if;
 return jsonb_build_object(
 'leads',coalesce((select jsonb_agg(l.body||jsonb_build_object('id',l.id,'buyerId',l.subject_id,'label','Enquiry '||l.external_id,'path',l.path,'controller',l.controller,'projectId',l.project_id,'project',coalesce(pr.title,pr.name),'source',s.label,'sourceId',s.id,'sourceState',s.state,'externalId',l.external_id,'occurred',l.occurred,'received',l.received,'ownerId',l.owner_id,'owner',p.display_name,'withdrawn',l.withdrawn,'revision',l.revision,
 'events',coalesce((select jsonb_agg((case when l.path='agency' and not money_can('money.amount.read') then t.body-array['minor','currency','scale'] else t.body end)||jsonb_build_object('id',t.id,'stage',t.stage,'effective',t.effective,'recorded',t.recorded,'recorder',p2.display_name,'verification',t.verification,'evidence',t.evidence,'confidence',t.confidence,'reverses',t.reverses,'active',case when t.stage in('invoice','collection') then exists(select 1 from pulse_priv.acq_link al join pulse_priv.finance_source inv on inv.id=al.invoice_id left join pulse_priv.finance_decision fd on fd.id=al.decision_id where al.org_id=current_org() and al.id=nullif(t.body->>'linkId','')::uuid and (al.decision_id is null or fd.active) and not exists(select 1 from pulse_priv.finance_source newer where newer.org_id=current_org() and newer.external_key=inv.external_key and newer.created_at>inv.created_at)) else true end) order by t.effective,t.recorded,t.id) from pulse_priv.acq_stage t join person p2 on p2.id=t.actor where t.org_id=current_org() and t.enquiry_id=l.id),'[]'),
 'evidence',coalesce((select jsonb_agg('Envelope '||e.object_id||' · '||e.vintage) from pulse_priv.acq_envelope e where e.org_id=current_org() and e.enquiry_id=l.id),'[]')) order by l.occurred,l.id)
 from pulse_priv.acq_enquiry l join project pr on pr.id=l.project_id join pulse_priv.acq_source s on s.id=l.source_id join person p on p.id=l.owner_id where l.org_id=current_org() and not l.withdrawn and acq_can(l.project_id) and(l.owner_id=current_viewer() or acq_can(l.project_id,true))),'[]'),
 'sources',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'label',s.label,'controller',s.controller,'projectId',s.project_id,'path',s.path,'purpose',s.purpose,'account',s.account,'state',case when s.state='current' and(s.expires<=now() or s.cutoff<now()-interval '1 day') then 'stale' else s.state end,'cutoff',s.cutoff,'cursor',s.cursor,'revision',s.revision,'backlog',(select count(*) from pulse_priv.acq_envelope e where e.source_id=s.id and e.state in('pending','quarantined','dead_letter')),'owner',p.display_name,'body',s.body)) from pulse_priv.acq_source s join person p on p.id=s.owner_id where s.org_id=current_org() and acq_can(s.project_id,true)),'[]'),
 'reviews',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'kind',s.purpose,'label','Source object '||e.object_id,'reason',e.reason,'owner',p.display_name,'state',e.state,'sourceId',s.id,'body',e.body-array['aliases','contact'],'attempts',e.attempts,'nextAt',e.next_at)) from pulse_priv.acq_envelope e join pulse_priv.acq_source s on s.id=e.source_id join person p on p.id=s.owner_id where e.org_id=current_org() and acq_can(s.project_id,true) and(s.purpose<>'finance' or money_can('money.amount.read')) and e.state in('pending','quarantined','dead_letter')),'[]'),
 'spend',coalesce((select jsonb_agg(d.body||jsonb_build_object('sourceId',d.source_id,'day',d.day,'adId',d.ad_id,'vintage',d.vintage,'received',d.received)) from pulse_priv.acq_spend d join pulse_priv.acq_source s on s.id=d.source_id where d.org_id=current_org() and acq_can(s.project_id,true)),'[]'),
 'links',case when money_can('money.amount.read') then coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'enquiryId',x.enquiry_id,'invoiceId',x.invoice_id,'decisionId',x.decision_id,'minor',x.minor,'currency',inv.body->>'currency','scale',inv.body->'scale','contract',x.contract,'reference',x.reference,'active',coalesce(d.active,true) and not exists(select 1 from pulse_priv.finance_source newer where newer.org_id=current_org() and newer.external_key=inv.external_key and newer.created_at>inv.created_at),'path',l.path)) from pulse_priv.acq_link x join pulse_priv.acq_enquiry l on l.id=x.enquiry_id join pulse_priv.finance_source inv on inv.id=x.invoice_id left join pulse_priv.finance_decision d on d.id=x.decision_id where x.org_id=current_org() and acq_can(l.project_id,true)),'[]') else '[]'::jsonb end,
 'workspace',coalesce((select jsonb_agg(jsonb_build_object('id',s.object_id,'kind',src.purpose,'label',coalesce(s.body->>'label',s.object_id),'reason',coalesce(s.body->>'reason','Review source crosswalk'),'owner',p.display_name,'state',coalesce(s.body->>'state','review'),'sourceId',s.source_id,'body',s.body||s.manual,'version',s.version)) from pulse_priv.acq_snapshot s join pulse_priv.acq_source src on src.id=s.source_id join person p on p.id=src.owner_id where s.org_id=current_org() and not s.deleted and src.state<>'revoked' and acq_can(src.project_id,true)),'[]'));
end $$;
create or replace function pulse.acq_source_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare sid uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid());pr uuid:=(p->>'projectId')::uuid;ct uuid:=(p->>'controller')::uuid;old pulse_priv.acq_source%rowtype;
begin
 if not acq_can(pr,true) then raise exception 'Acquisition source authority required' using errcode='42501';end if;
 if coalesce(p->>'path','') not in('buyer','agency') or (p->>'path'='buyer' and not exists(select 1 from project where id=pr and client_id=ct)) or(p->>'path'='agency' and ct<>current_org()) then raise exception 'Named client controller or EA agency required' using errcode='22023';end if;
 if not exists(select 1 from person where id=(p->>'ownerId')::uuid and org_id=current_org() and side='staff' and status='active') or length(coalesce(p->>'account','')) not between 1 and 160 or length(coalesce(p->>'label','')) not between 1 and 160 or coalesce(p->>'kind','') not in('manual','manual_reporting','landing','meta_leads','meta_delivery','google_forms','google_ads','crm','zoho','gmail','calendar','contacts','meet','whatsapp_structured')
 or coalesce(p->>'purpose','') not in('lead','reporting','finance','calendar','contacts','meet') or length(coalesce(p->>'authority',''))<3 then raise exception 'Account owner purpose and controller permission evidence required' using errcode='22023';end if;
 if (p->>'kind' in('manual','landing','meta_leads','google_forms','crm','whatsapp_structured') and p->>'purpose'<>'lead') or (p->>'kind' in('meta_delivery','google_ads','manual_reporting') and p->>'purpose'<>'reporting') or(p->>'kind' in('zoho','gmail') and p->>'purpose'<>'finance') or(p->>'kind' in('calendar','contacts','meet') and p->>'purpose'<>p->>'kind') then raise exception 'Source purpose does not match selected lane' using errcode='22023';end if;
 select * into old from pulse_priv.acq_source where org_id=current_org() and id=sid for update;
 if old.id is not null and (old.project_id<>pr or old.controller<>ct or old.path<>p->>'path' or old.kind<>p->>'kind' or old.account<>p->>'account') then raise exception 'Source scope is immutable' using errcode='40001';end if;
 insert into pulse_priv.acq_source(id,org_id,controller,project_id,path,kind,account,purpose,owner_id,label,body) values(sid,current_org(),ct,pr,p->>'path',p->>'kind',p->>'account',p->>'purpose',(p->>'ownerId')::uuid,p->>'label',jsonb_build_object('namespace',coalesce(p->>'namespace',sid::text),'authority',p->>'authority','policy',p->>'policy','notice',p->>'notice','calendar',coalesce(p->'calendar','[]'),'sourceFields',p->'sourceFields','selectedLabels',p->'selectedLabels','regionalHost',p->>'regionalHost','product',p->>'product'))
 on conflict(id) do update set owner_id=excluded.owner_id,label=excluded.label,body=pulse_priv.acq_source.body||excluded.body,revision=pulse_priv.acq_source.revision+1;
 perform audit_write('acquisition.source',sid::text);return sid;
end $$;
create function pulse.acq_manual_close(s uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare src pulse_priv.acq_source%rowtype;n int;total numeric;
begin
 select * into src from pulse_priv.acq_source where id=s and org_id=current_org() for update;
 if not acq_can(src.project_id,true) or src.kind not in('manual','manual_reporting') or src.state='revoked' then raise exception 'Selected manual source authority required' using errcode='42501';end if;
 if src.kind='manual' then
 select count(*) into n from pulse_priv.acq_envelope where org_id=current_org() and source_id=s and state='resolved';
 if exists(select 1 from pulse_priv.acq_envelope where org_id=current_org() and source_id=s and state in('pending','quarantined','dead_letter')) then raise exception 'Resolve the manual export backlog before closing controls' using errcode='22023';end if;
 else
 select count(*),sum((x.body->>'minor')::numeric) into n,total from (select distinct on(day,ad_id,body->>'basis') body from pulse_priv.acq_spend where org_id=current_org() and source_id=s and day between(p->>'from')::date and(p->>'to')::date order by day,ad_id,body->>'basis',received desc) x where x.body->>'basis'='delivered';
 if total is null or total is distinct from(p->>'deliveredMinor')::numeric or exists(select 1 from pulse_priv.acq_spend where source_id=s and(body->>'currency' is distinct from p->>'currency' or(body->>'scale')::int is distinct from(p->>'scale')::int)) then raise exception 'Delivered daily totals and API currency units do not tie out' using errcode='22023';end if;
 end if;
 if n is distinct from(p->>'controlCount')::int or n=0 or p->>'cutoff' is null or length(coalesce(p->>'evidence',''))<3 then raise exception 'Independent complete export control count and evidence required' using errcode='22023';end if;
 perform acq_source_control(s,jsonb_build_object('revision',src.revision,'state','current','reason',p->>'evidence','grantTest','passed','complete',true,'account',src.account,'kind',src.kind,'endpoint','manual reviewed export','controlCount',n,'cutoff',p->>'cutoff','currency',p->>'currency','timezone',p->>'timezone','cursor',p->>'cursor'));
 update pulse_priv.acq_source set body=body||jsonb_build_object('transport','manual reviewed export','providerAccess','not connected') where id=s;
end $$;
create function pulse.acq_queue_recover(e uuid,reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare env pulse_priv.acq_envelope%rowtype;src pulse_priv.acq_source%rowtype;
begin
 select * into env from pulse_priv.acq_envelope where id=e and org_id=current_org() for update;select * into src from pulse_priv.acq_source where id=env.source_id and org_id=current_org();
 if not acq_can(src.project_id,true) or src.state='revoked' or(src.expires is not null and src.expires<=now()) or env.state in('resolved','withdrawn') then raise exception 'Current source and review authority required' using errcode='42501';end if;
 if length(coalesce(reason,''))<3 then raise exception 'Recovery review reason required' using errcode='22023';end if;
 update pulse_priv.acq_envelope set state='pending',next_at=now(),reason='Reviewed recovery: '||left(reason,200) where id=e;
 perform audit_write('acquisition.queue_recovery',e::text);
end $$;
-- Recurring source snapshots cannot claim actual wrap from future plans or silently attach another work lane.
create or replace function pulse.acq_snapshot_review(s uuid,o text,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare src pulse_priv.acq_source%rowtype;r pulse_priv.acq_snapshot%rowtype;
begin
 select * into src from pulse_priv.acq_source where org_id=current_org() and id=s;select * into r from pulse_priv.acq_snapshot where org_id=current_org() and source_id=s and object_id=o for update;
 if not acq_can(src.project_id,true) or r.deleted or src.state='revoked' or r.object_id is null then raise exception 'Selected current work object required' using errcode='42501';end if;
 if exists(select 1 from jsonb_object_keys(p) k where k not in('taskId','wrapped','footageAccepted','evidence','contactId','submittedAction')) or length(coalesce(p->>'evidence',''))<3 then raise exception 'Reviewed crosswalk and evidence required' using errcode='22023';end if;
 if p->>'taskId' is not null and not exists(select 1 from task where id=(p->>'taskId')::uuid and project_id=src.project_id) then raise exception 'Linked project task unavailable' using errcode='42501';end if;
 if(p->>'wrapped'='true' or p->>'footageAccepted'='true') and(src.purpose<>'calendar' or r.body->>'start' is null or(r.body->>'start')::timestamptz>now()) then raise exception 'Actual work evidence cannot come from a future plan' using errcode='22023';end if;
 if src.purpose='meet' and nullif(p->>'submittedAction','') is not null and(r.body->>'explicitSubmission' is distinct from 'true' or length(coalesce(r.body->>'notice',''))<3) then raise exception 'Participant notice and explicit action submission required' using errcode='22023';end if;
 if p->>'contactId' is not null and(src.purpose<>'contacts' or not exists(select 1 from person pp join contact_profile cp on cp.person_id=pp.id where pp.id=(p->>'contactId')::uuid and pp.org_id=current_org() and pp.side<>'staff')) then raise exception 'Existing authorized external contact required' using errcode='42501';end if;
 update pulse_priv.acq_snapshot set manual=manual||p where org_id=current_org() and source_id=s and object_id=o;perform audit_write('acquisition.work_review',s::text);
end $$;
revoke all on function pulse.acq_manual_close(uuid,jsonb),pulse.acq_queue_recover(uuid,text) from public;
grant execute on function pulse.acq_manual_close(uuid,jsonb),pulse.acq_queue_recover(uuid,text) to pulse_api;
create or replace function pulse.acq_document_resolve(e uuid,reason text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare env pulse_priv.acq_envelope%rowtype;src pulse_priv.acq_source%rowtype;b jsonb;f jsonb;sid uuid;proposal jsonb;
begin
 perform finance_authorize(true);
 select * into env from pulse_priv.acq_envelope where org_id=current_org() and id=e for update;select * into src from pulse_priv.acq_source where org_id=current_org() and id=env.source_id;
 if not acq_can(src.project_id,true) or src.purpose<>'finance' or src.state='revoked' or env.state='withdrawn' then raise exception 'Designated authorized finance review required' using errcode='42501';end if;
 if env.state='resolved' then return env.finance_source_id;end if;
 b:=env.body;f:=b->'fields';
 if b->>'malware' is distinct from 'clean' or b->>'parserVersion' is distinct from 'finance-v1' or b->>'ambiguous' is distinct from 'false' or coalesce((b->'confidence'->>'currency')::numeric,0)<0.99 or coalesce((b->'confidence'->>'minor')::numeric,0)<0.99 or coalesce(b->>'contentHash','') !~ '^[a-f0-9]{64}$' or f->>'currency' !~ '^[A-Z]{3}$' or(f->>'minor')::numeric<0 or(f->>'minor')::numeric>9e12 or(f->>'minor')::numeric<>trunc((f->>'minor')::numeric) or(f->>'scale')::int not between 0 and 4 or length(coalesce(reason,''))<3 then raise exception 'Isolated clean scan and certified unambiguous amount required' using errcode='22023';end if;
 perform(f->>'date')::date;
 if f->>'serviceFrom' is null or f->>'serviceTo' is null or(f->>'serviceFrom')::date>(f->>'serviceTo')::date then raise exception 'Certified service period required' using errcode='22023';end if;
 -- A bill is an obligation, never bank cash. A duplicate in another mailbox supports this same document.
 proposal:=jsonb_build_object('externalKey','bill:'||src.controller::text||':'||(b->>'contentHash'),'vintage','scan-finance-v1','kind','bill','account','','party','vendor:'||(f->>'vendor'),'partyConfirmed',false,'currency',f->>'currency','scale',f->'scale','minor',f->'minor','direction','outflow','cashDate','','invoiceDate',f->>'date','dueDate','','serviceFrom',f->>'serviceFrom','serviceTo',f->>'serviceTo','dateBasis','Reviewed bill source date','reference',b->>'contentHash','label',b->>'label','documentBasis',reason,'dataset','acquisition-finance-lane','observationId',b->>'contentHash','category','unassigned','projectId','','clientId','','validation','validated','issues','[]'::jsonb);
 -- First certified amount authority survives replay and additional mailbox evidence.
 select id into sid from pulse_priv.finance_source where org_id=current_org() and external_key=proposal->>'externalKey' and vintage='scan-finance-v1';
 if sid is null then sid:=finance_source_add(proposal);else
 if exists(select 1 from pulse_priv.finance_source where id=sid and(body->>'currency'<>f->>'currency' or body->'minor'<>f->'minor' or body->'scale'<>f->'scale')) then raise exception 'Duplicate bill amounts conflict; review existing authority' using errcode='40001';end if;end if;
 update pulse_priv.acq_envelope set state='resolved',finance_source_id=sid,reason='Certified supporting bill; no extra cash' where id=e;
 perform audit_write('acquisition.finance_review',e::text);return sid;
end $$;
create function pulse.acq_document_certify(e uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare env pulse_priv.acq_envelope%rowtype;src pulse_priv.acq_source%rowtype;f jsonb;sid uuid;
begin
 perform finance_authorize(true);select * into env from pulse_priv.acq_envelope where id=e and org_id=current_org() for update;select * into src from pulse_priv.acq_source where id=env.source_id and org_id=current_org();
 if not acq_can(src.project_id,true) or src.purpose<>'finance' or src.state='revoked' or env.state='withdrawn' or env.body->>'malware' is distinct from 'clean' or env.body->>'parserVersion' is distinct from 'finance-v1' then raise exception 'Designated clean finance source and reviewer required' using errcode='42501';end if;
 if p->>'certified' is distinct from 'true' or length(coalesce(p->>'reason',''))<3 then raise exception 'Explicit amount currency and service certification required' using errcode='22023';end if;
 f:=env.body->'fields'||jsonb_build_object('serviceFrom',p->>'serviceFrom','serviceTo',p->>'serviceTo');
 if coalesce((env.body->>'ambiguous')::boolean,true) then
 if p->>'currency' is null or p->>'minor' is null then raise exception 'Ambiguous parser amount and currency need explicit reviewed correction' using errcode='22023';end if;
 f:=f||jsonb_build_object('currency',p->>'currency','minor',p->'minor','scale',p->'scale');end if;
 if env.state='resolved' then
 if env.body->'fields' is distinct from f then raise exception 'Certified bill authority changed; use a new source vintage' using errcode='40001';end if;return env.finance_source_id;end if;
 update pulse_priv.acq_envelope set body=body||jsonb_build_object('parserProposal',coalesce(body->'parserProposal',body),'fields',f,'ambiguous',false,'confidence',jsonb_build_object('currency',1,'minor',1),'certification',jsonb_build_object('actor',current_viewer(),'reason',p->>'reason','at',now())) where id=e;
 sid:=acq_document_resolve(e,p->>'reason');return sid;
end $$;
revoke all on function pulse.acq_document_certify(uuid,jsonb) from public;
grant execute on function pulse.acq_document_certify(uuid,jsonb) to pulse_api;
create or replace function pulse.acq_spend_add(s uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare src pulse_priv.acq_source%rowtype;old jsonb;previous_vintage text;
begin
 perform pg_advisory_xact_lock(hashtextextended('acq-spend:'||current_org()::text,0));
 select * into src from pulse_priv.acq_source where org_id=current_org() and id=s;
 if not acq_can(src.project_id,true) or src.purpose<>'reporting' or src.state='revoked' then raise exception 'Authorized reporting source required' using errcode='42501';end if;
 if coalesce(p->>'basis','') not in('funded','billed','delivered') or (p->>'minor')::numeric<0 or (p->>'minor')::numeric>9e12 or(p->>'minor')::numeric<>trunc((p->>'minor')::numeric) or(p->>'scale')::int not between 0 and 4 or p->>'currency' !~ '^[A-Z]{3}$' or (src.body->>'currency' is not null and src.body->>'currency'<>p->>'currency') or length(coalesce(p->>'window',''))<3 or length(coalesce(p->>'adId',''))<1 or length(coalesce(p->>'vintage',''))<1 or length(coalesce(p->>'evidence',''))<3 then raise exception 'Ad-level daily money units attribution and evidence required' using errcode='22023';end if;
 select body into old from pulse_priv.acq_spend where org_id=current_org() and source_id=s and day=(p->>'day')::date and ad_id=p->>'adId' and vintage=p->>'vintage';
 if old is null then
 select x.vintage into previous_vintage from pulse_priv.acq_spend x where x.org_id=current_org() and x.source_id=s and x.day=(p->>'day')::date and x.ad_id=p->>'adId' and x.body->>'basis'=p->>'basis' and not exists(select 1 from pulse_priv.acq_spend newer where newer.org_id=x.org_id and newer.source_id=x.source_id and newer.day=x.day and newer.ad_id=x.ad_id and newer.body->>'basis'=x.body->>'basis' and newer.body->>'supersedes'=x.vintage);
 if previous_vintage is not null and p->>'supersedes' is distinct from previous_vintage then raise exception 'Restatement must supersede the exact current ad day vintage' using errcode='40001';end if;
 if previous_vintage is null and nullif(p->>'supersedes','') is not null then raise exception 'Prior spend vintage unavailable' using errcode='22023';end if;end if;
 if old is not null and old<>p then raise exception 'Spend vintage is immutable' using errcode='40001';end if;
 insert into pulse_priv.acq_spend values(current_org(),s,(p->>'day')::date,p->>'adId',p->>'vintage',now(),p) on conflict do nothing;
end $$;
alter table pulse_priv.acq_spend add constraint spend_units_required check(
 body->>'minor' is not null and jsonb_typeof(body->'minor')='number' and(body->>'minor')::numeric between 0 and 9e12 and(body->>'minor')::numeric=trunc((body->>'minor')::numeric)
 and body->>'currency' is not null and body->>'currency' ~ '^[A-Z]{3}$' and body->>'scale' is not null and(body->>'scale')::int between 0 and 4 and body->>'window' is not null and body->>'basis' is not null and body->>'basis' in('delivered','billed','funded'));
create or replace function pulse.acq_receive(s uuid,p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 if eid is not null and p->'normalized'->>'quarantine'='true' then update pulse_priv.acq_envelope set state='quarantined',reason=left(coalesce(p->'normalized'->'issues'->>0,'Source validation needs review'),240) where id=eid;end if;
 if eid is null then select id,body into eid,previous from pulse_priv.acq_envelope where org_id=current_org() and source_id=s and object_id=p->>'objectId' and vintage=p->>'vintage';if (previous-array['contact','aliases']) is distinct from ((p->'normalized')-array['contact','aliases']) then raise exception 'Envelope replay changed; new vintage required' using errcode='40001';end if;end if;
 return jsonb_build_object('id',eid,'durable',true,'state',(select state from pulse_priv.acq_envelope where id=eid));
end $$;
create or replace function pulse.acq_resolve(e uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 if b->>'quarantine'='true' then update pulse_priv.acq_envelope set state='quarantined',reason='Correct source validation or import a reviewed source vintage' where id=e;return jsonb_build_object('quarantined',true);end if;
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
create or replace function pulse.acq_can(p uuid,w boolean default false) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and not viewer_is('hr') and exists(select 1 from person where id=current_viewer() and org_id=current_org() and side='staff' and status='active')
 and exists(select 1 from project where id=p and org_id=current_org()) and (viewer_is('admin','leadership') or work_project(p))
 and (not w or viewer_is('admin','leadership') or exists(select 1 from project pr join role_assignment r on r.unit_id=pr.unit_id where pr.id=p and r.person_id=current_viewer() and(r.is_manager_of_unit or r.role_key in('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity')))
$$;
create or replace function pulse.acq_edit(p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l pulse_priv.acq_enquiry%rowtype;own uuid;alias jsonb;
begin
 select * into l from pulse_priv.acq_enquiry where org_id=current_org() and id=(p->>'id')::uuid for update;
 if not acq_can(l.project_id,true) or l.revision<>(p->>'revision')::int or p->>'revision' is null then raise exception 'Scoped current review required' using errcode='40001';end if;
 own:=coalesce(nullif(p->>'ownerId','')::uuid,l.owner_id);
 if not exists(select 1 from person where id=own and org_id=current_org() and side='staff' and status='active') then raise exception 'Active assigned staff required' using errcode='22023';end if;
 if length(coalesce(p->>'reason',''))<3 then raise exception 'Reviewed correction reason required' using errcode='22023';end if;
 if p->'protectedContact' is not null then
 if exists(select 1 from pulse_priv.acq_identity i join jsonb_array_elements(p->'aliases') a on i.key_version=a->>'version' and i.keyed=a->>'key' where i.org_id=current_org() and i.controller=l.controller and i.path=l.path and i.subject_id<>l.subject_id) then raise exception 'Contact matches another scoped buyer; review identity before changing' using errcode='40001';end if;
 update pulse_priv.acq_subject set contact=p->'protectedContact' where id=l.subject_id and org_id=current_org();
 for alias in select value from jsonb_array_elements(p->'aliases') loop insert into pulse_priv.acq_identity values(current_org(),l.controller,l.path,alias->>'version',alias->>'key',l.subject_id) on conflict do nothing;end loop;end if;
 update pulse_priv.acq_enquiry set owner_id=own,revision=revision+1,body=body||jsonb_build_object('consent',coalesce(p->'consent',body->'consent'),'optOut',coalesce(p->'optOut',body->'optOut'),'phoneAvailable',coalesce(p->'phoneAvailable',body->'phoneAvailable'),'manualOverride',true,'correctionReason',p->>'reason') where id=l.id;
 if l.body->>'taskId' is not null then update task set owner_id=own,assignee_person_id=own,locked=array(select distinct x from unnest(locked||array['owner_id','assignee_person_id']) x) where id=(l.body->>'taskId')::uuid;end if;
 perform audit_write('acquisition.correction',l.id::text);
end $$;
create or replace function pulse.acq_link_add(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l pulse_priv.acq_enquiry%rowtype;inv pulse_priv.finance_source%rowtype;d pulse_priv.finance_decision%rowtype;did uuid:=nullif(p->>'decisionId','')::uuid;n numeric:=(p->>'minor')::numeric;used numeric;available numeric;sid uuid;old pulse_priv.acq_link%rowtype;
begin
 perform finance_authorize(true);perform pg_advisory_xact_lock(hashtextextended('acq-finance:'||current_org()::text,0));
 select * into l from pulse_priv.acq_enquiry where org_id=current_org() and id=(p->>'enquiryId')::uuid for update;
 if not acq_can(l.project_id,true) or l.withdrawn then raise exception 'Scoped commercial reviewer required' using errcode='42501';end if;
 if length(coalesce(p->>'contract',''))<3 or length(coalesce(p->>'reference',''))<3 or length(coalesce(p->>'requestKey',''))<1 or n is null or n<=0 or n<>trunc(n) then raise exception 'Reviewed contract order or booking reference and integer allocation required' using errcode='22023';end if;
 select * into old from pulse_priv.acq_link where org_id=current_org() and request_key=p->>'requestKey';
 if old.id is not null then if old.enquiry_id<>l.id or old.invoice_id<>(p->>'invoiceId')::uuid or old.decision_id is distinct from did or old.minor<>n or old.contract<>p->>'contract' or old.reference<>p->>'reference' then raise exception 'Commercial receipt replay differs' using errcode='40001';end if;return old.id;end if;
 select * into inv from pulse_priv.finance_source where org_id=current_org() and id=(p->>'invoiceId')::uuid;
 if inv.id is null or inv.body->>'kind'<>'invoice' or inv.body->>'direction'<>'inflow' or inv.body->>'validation'<>'validated' or(inv.body->>'projectId' is not null and inv.body->>'projectId'<>'' and inv.body->>'projectId'<>l.project_id::text) or(inv.body->>'clientId' is not null and inv.body->>'clientId'<>'' and not exists(select 1 from project where id=l.project_id and client_id::text=inv.body->>'clientId')) then raise exception 'Validated authorized EA invoice required' using errcode='22023';end if;
 if exists(select 1 from pulse_priv.finance_source newer where newer.org_id=current_org() and newer.external_key=inv.external_key and newer.created_at>inv.created_at) then raise exception 'Invoice vintage was superseded; reviewed current authority required' using errcode='40001';end if;
 if l.path='buyer' and(p->>'feePermitted' is distinct from 'true' or not exists(select 1 from pulse_priv.acq_stage t where org_id=current_org() and enquiry_id=l.id and stage in('booking','sale') and verification='verified' and not exists(select 1 from pulse_priv.acq_stage r where r.reverses=t.id))) then raise exception 'Active verified booking and contractual EA fee permission required' using errcode='22023';end if;
 if did is not null then
 select * into d from pulse_priv.finance_decision where org_id=current_org() and id=did and active;
 if d.id is null or d.body->>'treatment'<>'payment' or d.body->>'direction'<>'inflow' then raise exception 'Active verified Round 10 bank payment required' using errcode='22023';end if;
 select sum(minor) into available from pulse_priv.finance_allocation where org_id=current_org() and decision_id=did and source_id=inv.id and role='obligation' and active;
 select coalesce(sum(minor),0) into used from pulse_priv.acq_link where org_id=current_org() and invoice_id=inv.id and decision_id=did;
 else available:=(inv.body->>'minor')::numeric;select coalesce(sum(minor),0) into used from pulse_priv.acq_link where org_id=current_org() and invoice_id=inv.id and decision_id is null;end if;
 if available is null or used+n>available then raise exception 'Reviewed invoice or payment allocations must conserve values' using errcode='22023';end if;
 insert into pulse_priv.acq_link(org_id,enquiry_id,invoice_id,decision_id,minor,contract,reference,actor,request_key) values(current_org(),l.id,inv.id,did,n,p->>'contract',p->>'reference',current_viewer(),p->>'requestKey') returning id into sid;
 insert into pulse_priv.acq_stage(org_id,enquiry_id,request_key,stage,effective,actor,verification,evidence,confidence,body) values(current_org(),l.id,'link:'||sid::text,case when did is null then 'invoice' else 'collection' end,now(),current_viewer(),'verified','Reviewed EA fee link '||sid::text,'Round 10 reviewed conserved allocation',jsonb_build_object('linkId',sid,'minor',n,'currency',inv.body->>'currency','scale',inv.body->'scale'));
 perform audit_write('acquisition.commercial_link',sid::text);return sid;
end $$;
