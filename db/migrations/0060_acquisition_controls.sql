-- migrate:up
create function pulse.acq_source_control(s uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare src pulse_priv.acq_source%rowtype;tid uuid;
begin
 select * into src from pulse_priv.acq_source where org_id=current_org() and id=s for update;
 if not acq_can(src.project_id,true) or (p->>'revision')::int<>src.revision or p->>'revision' is null then raise exception 'Current scoped source review required' using errcode='40001';end if;
 if coalesce(p->>'state','') not in('authorized','syncing','current','stale','revoked','failed') or length(coalesce(p->>'reason',''))<3 then raise exception 'Access check or revocation reason required' using errcode='22023';end if;
 if src.state='revoked' and p->>'state'<>'authorized' then raise exception 'Reauthorization and grant test required before replay' using errcode='42501';end if;
 if p->>'state' in('authorized','current') and (p->>'endpoint' is null or p->>'grantTest' is distinct from 'passed' or p->>'complete' is distinct from 'true' or p->>'account' is distinct from src.account or p->>'kind' is distinct from src.kind) then raise exception 'Actual requested endpoint account and complete controls required' using errcode='22023';end if;
 if p->>'state'='current' and(p->>'cutoff' is null or p->>'controlCount' is null or(p->>'controlCount')::int<0 or(p->>'cutoff')::timestamptz>now()+interval '1 minute') then raise exception 'Completed cutoff and source controls required' using errcode='22023';end if;
 if p->>'state' in('revoked','failed','stale') and not exists(select 1 from task where org_id=current_org() and source_key='acq-reconnect:'||s::text and status not in('done','cancelled')) then
 insert into task(org_id,project_id,title,owner_id,assignee_person_id,status,source,source_key) values(current_org(),src.project_id,'Reconnect source: '||src.label,src.owner_id,src.owner_id,'open','pulse','acq-reconnect:'||s::text) returning id into tid;end if;
 update pulse_priv.acq_source set state=p->>'state',revision=revision+1,expires=case when p->>'state'='revoked' then null else coalesce(nullif(p->>'expires','')::timestamptz,expires) end,
 cutoff=case when p->>'state'='current' then(p->>'cutoff')::timestamptz else cutoff end,cursor=case when p->>'state'='current' then coalesce(p->>'cursor',cursor) else cursor end,
 body=body||jsonb_build_object('lastAccessCheck',now(),'reason',p->>'reason','grantTest',p->>'grantTest','endpoint',p->>'endpoint','controlCount',p->'controlCount','currency',p->>'currency','timezone',p->>'timezone','apiVersion',p->>'apiVersion','attribution',p->>'attribution','scheduledAccess',p->>'state'<>'revoked','reconnectTask',coalesce(tid,(body->>'reconnectTask')::uuid)) where id=s;
 perform audit_write('acquisition.source_control',s::text);
end $$;
create function pulse.acq_retry(e uuid,p_reason text,p_delay int) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare env pulse_priv.acq_envelope%rowtype;src pulse_priv.acq_source%rowtype;
begin
 select * into env from pulse_priv.acq_envelope where org_id=current_org() and id=e for update;select * into src from pulse_priv.acq_source where id=env.source_id and org_id=current_org();
 if not acq_can(src.project_id,true) or src.state='revoked' or env.state in('resolved','withdrawn') or p_delay not between 1 and 21600 then raise exception 'Retry source unavailable or final' using errcode='42501';end if;
 update pulse_priv.acq_envelope set attempts=attempts+1,next_at=now()+make_interval(secs=>p_delay),state=case when attempts>=7 then 'dead_letter' else 'quarantined' end,reason=left(p_reason,240) where id=e;
end $$;
create function pulse.acq_spend_add(s uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare src pulse_priv.acq_source%rowtype;old jsonb;
begin
 select * into src from pulse_priv.acq_source where org_id=current_org() and id=s;
 if not acq_can(src.project_id,true) or src.purpose<>'reporting' or src.state='revoked' then raise exception 'Authorized reporting source required' using errcode='42501';end if;
 if coalesce(p->>'basis','') not in('funded','billed','delivered') or (p->>'minor')::numeric<0 or (p->>'minor')::numeric>9e12 or(p->>'minor')::numeric<>trunc((p->>'minor')::numeric) or(p->>'scale')::int not between 0 and 4 or p->>'currency' !~ '^[A-Z]{3}$' or (src.body->>'currency' is not null and src.body->>'currency'<>p->>'currency') or length(coalesce(p->>'window',''))<3 or length(coalesce(p->>'adId',''))<1 or length(coalesce(p->>'vintage',''))<1 or length(coalesce(p->>'evidence',''))<3 then raise exception 'Ad-level daily money units attribution and evidence required' using errcode='22023';end if;
 select body into old from pulse_priv.acq_spend where org_id=current_org() and source_id=s and day=(p->>'day')::date and ad_id=p->>'adId' and vintage=p->>'vintage';
 if old is not null and old<>p then raise exception 'Spend vintage is immutable' using errcode='40001';end if;
 insert into pulse_priv.acq_spend values(current_org(),s,(p->>'day')::date,p->>'adId',p->>'vintage',now(),p) on conflict do nothing;
end $$;
create function pulse.acq_link_add(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
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
-- Pages are committed as a complete source snapshot, never individually. Manual crosswalk decisions are separate.
create function pulse.acq_snapshot_apply(s uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare src pulse_priv.acq_source%rowtype;r jsonb;
begin
 select * into src from pulse_priv.acq_source where org_id=current_org() and id=s for update;
 if not acq_can(src.project_id,true) or src.state='revoked' or src.purpose not in('calendar','contacts','meet') then raise exception 'Selected work source required' using errcode='42501';end if;
 if p->>'complete' is distinct from 'true' or p->>'cursor' is null or jsonb_typeof(p->'objects')<>'array' or jsonb_array_length(p->'objects')>1000 then raise exception 'Complete validated pagination required before cursor' using errcode='22023';end if;
 if p->>'expectedCursor' is distinct from coalesce(src.cursor,'') then raise exception 'Source cursor changed; retry from current snapshot' using errcode='40001';end if;
 if p->>'resync'='true' then update pulse_priv.acq_snapshot set deleted=true where org_id=current_org() and source_id=s;end if;
 for r in select value from jsonb_array_elements(p->'objects') loop
 if length(coalesce(r->>'id',''))<1 or length(coalesce(r->>'version',''))<1 then raise exception 'Stable source object and version required' using errcode='22023';end if;
 if exists(select 1 from jsonb_object_keys(r->'body') k where k not in('label','reason','state','timezone','start','end','instanceId','resourceName','artifact','availability','notice','projectId','sourcePermission','organizedBy','explicitSubmission')) then raise exception 'Only allowed work metadata may enter snapshots' using errcode='22023';end if;
 if r->'body'->>'projectId' is distinct from src.project_id::text then raise exception 'Selected source project crosswalk required' using errcode='42501';end if;
 insert into pulse_priv.acq_snapshot(org_id,source_id,object_id,version,body,deleted) values(current_org(),s,r->>'id',r->>'version',r->'body',coalesce((r->>'deleted')::boolean,false)) on conflict(org_id,source_id,object_id) do update set version=excluded.version,body=excluded.body,deleted=excluded.deleted;
 end loop;
 update pulse_priv.acq_source set cursor=p->>'cursor',cutoff=now(),state='current',revision=revision+1 where id=s;
end $$;
create function pulse.acq_snapshot_review(s uuid,o text,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare src pulse_priv.acq_source%rowtype;r pulse_priv.acq_snapshot%rowtype;
begin
 select * into src from pulse_priv.acq_source where org_id=current_org() and id=s;select * into r from pulse_priv.acq_snapshot where org_id=current_org() and source_id=s and object_id=o for update;
 if not acq_can(src.project_id,true) or r.deleted or src.state='revoked' or r.object_id is null then raise exception 'Selected current work object required' using errcode='42501';end if;
 if exists(select 1 from jsonb_object_keys(p) k where k not in('taskId','wrapped','footageAccepted','evidence','contactId','submittedAction')) or length(coalesce(p->>'evidence',''))<3 then raise exception 'Reviewed crosswalk and evidence required' using errcode='22023';end if;
 if p->>'taskId' is not null and not exists(select 1 from task where id=(p->>'taskId')::uuid and project_id=src.project_id) then raise exception 'Linked project task unavailable' using errcode='42501';end if;
 if src.purpose='meet' and p->>'submittedAction' is not null and (r.body->>'explicitSubmission'<>'true' or length(coalesce(r.body->>'notice',''))<3) then raise exception 'Participant notice and explicit action submission required' using errcode='22023';end if;
 if src.purpose='contacts' and p->>'contactId' is not null and not exists(select 1 from person where id=(p->>'contactId')::uuid and org_id=current_org() and side<>'staff' and exists(select 1 from contact_profile where person_id=person.id)) then raise exception 'Existing authorized contact required' using errcode='42501';end if;
 update pulse_priv.acq_snapshot set manual=manual||p where org_id=current_org() and source_id=s and object_id=o;perform audit_write('acquisition.work_review',s::text);
end $$;
revoke all on function pulse.acq_source_control(uuid,jsonb),pulse.acq_retry(uuid,text,int),pulse.acq_spend_add(uuid,jsonb),pulse.acq_link_add(jsonb),pulse.acq_snapshot_apply(uuid,jsonb),pulse.acq_snapshot_review(uuid,text,jsonb) from public;
grant execute on function pulse.acq_source_control(uuid,jsonb),pulse.acq_retry(uuid,text,int),pulse.acq_spend_add(uuid,jsonb),pulse.acq_link_add(jsonb),pulse.acq_snapshot_apply(uuid,jsonb),pulse.acq_snapshot_review(uuid,text,jsonb) to pulse_api;
