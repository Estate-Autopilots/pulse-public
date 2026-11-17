-- migrate:up
create or replace function pulse.portal_issue(p_id uuid,p_username text,p_name text,p_password text) returns uuid language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare result uuid;
begin
 perform portal_admin();if octet_length(p_password) not between 16 and 72 or (p_id is null and length(trim(p_name)) not between 1 and 160) then raise exception 'Client name and private temporary secret required' using errcode='22023';end if;
 if p_id is null then insert into pulse_priv.portal_principal(org_id,username,name,password_hash) values(current_org(),lower(trim(p_username)),p_name,crypt(p_password,gen_salt('bf',10))) returning id into result;
 else update pulse_priv.portal_principal set password_hash=crypt(p_password,gen_salt('bf',10)),must_change=true,issued_at=now(),failed=0,locked_until=null where id=p_id and org_id=current_org() returning id into result;
 if result is null then raise exception 'Client login unavailable' using errcode='42501';end if;end if;
 update pulse_priv.portal_session set revoked_at=now() where org_id=current_org() and principal_id=result;
 update pulse_priv.portal_reset set resolved_at=now() where org_id=current_org() and principal_id=result and resolved_at is null;
 return result;
end $$;
create function pulse.portal_document_add(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pr uuid:=(p->>'projectId')::uuid;cl uuid;k text:=p->>'kind';par pulse_priv.portal_document%rowtype;b jsonb;src pulse_priv.finance_source%rowtype;result uuid;previous jsonb;
begin
 perform finance_authorize(true);perform delivery_access(pr);select client_id into cl from project where org_id=current_org() and id=pr;
 if cl is null or k not in('quote','order','invoice') or p->>'reviewed' is distinct from 'true' or length(coalesce(p->>'authority',''))<3 or length(coalesce(p->>'externalKey','')) not between 1 and 160 or length(coalesce(p->>'revision','')) not between 1 and 80 then raise exception 'Reviewed scoped finance projection and source authority required' using errcode='22023';end if;
 if k in('order','invoice') then select * into par from pulse_priv.portal_document where org_id=current_org() and id=(p->>'parentId')::uuid and project_id=pr and client_id=cl;
 if par.id is null or par.kind<>(case k when 'order' then 'quote' else 'order' end) or par.body->>'status' not in('accepted','issued') then raise exception 'Exact accepted quote revision and order lineage required' using errcode='22023';end if;end if;
 if k='invoice' then
 select * into src from pulse_priv.finance_source where org_id=current_org() and id=(p->>'sourceId')::uuid;
 if src.id is null or src.body->>'kind'<>'invoice' or src.body->>'validation'<>'validated' or src.body->>'projectId' is distinct from pr::text or src.body->>'clientId' is distinct from cl::text or src.body->>'partyConfirmed' is distinct from 'true' then raise exception 'Approved finance invoice source in this client project required' using errcode='22023';end if;
 b:=jsonb_build_object('sourceId',src.id,'minor',(src.body->>'minor')::numeric,'currency',src.body->>'currency','scale',(src.body->>'scale')::int,'dueDate',src.body->>'dueDate','status','issued');
 else
 if p->>'currency'!~'^[A-Z]{3}$' or (p->>'scale')::int not between 0 and 4 or (p->>'minor')::numeric<0 or (p->>'minor')::numeric<>trunc((p->>'minor')::numeric) or (p->>'minor')::numeric>9e12 or p->>'minor' is null then raise exception 'Quote currency and integer minor units required' using errcode='22023';end if;
 b:=jsonb_build_object('minor',(p->>'minor')::numeric,'currency',p->>'currency','scale',(p->>'scale')::int,'status',case k when 'quote' then 'accepted' else 'issued' end);
 end if;
 b:=b||jsonb_build_object('parentId',par.id,'parentRevision',par.revision,'label',left(p->>'label',240),'authority',left(p->>'authority',500),'termsVersion',p->>'termsVersion','sourceRevision',p->>'revision');
 if k='order' and (b->'minor' is distinct from par.body->'minor' or b->>'currency' is distinct from par.body->>'currency' or b->>'scale' is distinct from par.body->>'scale') then raise exception 'Order must match the accepted quote revision' using errcode='22023';end if;
 insert into pulse_priv.portal_document(org_id,project_id,client_id,kind,external_key,revision,body) values(current_org(),pr,cl,k,p->>'externalKey',p->>'revision',b) on conflict(org_id,external_key,revision) do nothing returning id into result;
 if result is null then select id,body into result,previous from pulse_priv.portal_document where org_id=current_org() and external_key=p->>'externalKey' and revision=p->>'revision';if previous<>b then raise exception 'Immutable projection changed; create a revision' using errcode='40001';end if;end if;return result;
end $$;
create function pulse.portal_document_read(d uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare doc pulse_priv.portal_document%rowtype;paid numeric:=0;returned numeric:=0;total numeric;body jsonb;
begin
 select * into doc from pulse_priv.portal_document where org_id=current_org() and id=d;if not found then raise exception 'Client document unavailable' using errcode='42501';end if;
 perform portal_access(doc.project_id);body:=doc.body;
 if doc.kind='invoice' then
 select coalesce(sum(a.minor) filter(where dec.body->>'treatment'='payment'),0),coalesce(sum(a.minor) filter(where dec.body->>'treatment'='refund'),0) into paid,returned
 from pulse_priv.finance_allocation a join pulse_priv.finance_decision dec on dec.id=a.decision_id and dec.org_id=a.org_id where a.org_id=current_org() and a.source_id=(body->>'sourceId')::uuid and a.role='obligation' and a.active and dec.active;
 total:=(body->>'minor')::numeric;body:=body||jsonb_build_object('paid',paid,'refunded',returned,'balance',greatest(0,total-paid+returned),'status',case when paid-returned>=total then 'settled' when paid>returned then 'partially_settled' else 'issued' end);
 end if;
 return jsonb_build_object('id',doc.id,'kind',doc.kind,'revision',doc.revision,'body',body);
end $$;
create function pulse.portal_refund_request(pr uuid,d uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cl uuid:=portal_access(pr);pid uuid:=portal_actor();result uuid;doc pulse_priv.portal_document%rowtype;
begin
 select * into doc from pulse_priv.portal_document where org_id=current_org() and id=d and project_id=pr and client_id=cl and kind='invoice';
 if not found or length(trim(coalesce(p->>'reason','')))<3 or length(coalesce(p->>'requestKey','')) not between 1 and 160 or (p->>'minor')::numeric<0 or (p->>'minor')::numeric<>trunc((p->>'minor')::numeric) or (p->>'minor')::numeric>(doc.body->>'minor')::numeric then raise exception 'Scoped invoice and refund review requirement required' using errcode='22023';end if;
 insert into pulse_priv.portal_document(org_id,project_id,client_id,kind,external_key,revision,body) values(current_org(),pr,cl,'refund','refund:'||pid::text||':'||(p->>'requestKey'),'requested',jsonb_build_object('invoiceId',d,'principalId',pid,'minor',(p->>'minor')::numeric,'currency',doc.body->>'currency','scale',doc.body->'scale','status','requested','reason',p->>'reason','cashChanged',false)) on conflict(org_id,external_key,revision) do nothing returning id into result;
 if result is null then select id into result from pulse_priv.portal_document where org_id=current_org() and external_key='refund:'||pid::text||':'||(p->>'requestKey') and revision='requested';end if;return result;
end $$;
-- Staff can read/respond only to explicitly client support conversations; no internal DMs are projected.
create function pulse.portal_support_staff(pr uuid,p jsonb default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare original pulse_priv.portal_support%rowtype;result uuid;
begin
 perform delivery_access(pr,true);
 if p is not null then select * into original from pulse_priv.portal_support where org_id=current_org() and project_id=pr and id=(p->>'requestId')::uuid;
 if original.id is null or length(trim(coalesce(p->>'text',''))) not between 1 and 4000 then raise exception 'Scoped support requirement and reply required' using errcode='22023';end if;
 insert into pulse_priv.portal_support(org_id,project_id,principal_id,owner_id,kind,body) values(current_org(),pr,original.principal_id,original.owner_id,'staff_response',jsonb_build_object('text',p->>'text','replyTo',original.id,'sla','No approved response expectation configured')) returning id into result;end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'principal',(select name from pulse_priv.portal_principal where id=s.principal_id),'owner',(select display_name from person where id=s.owner_id),'kind',s.kind,'body',s.body,'at',s.at)) from pulse_priv.portal_support s where s.org_id=current_org() and s.project_id=pr),'[]');
end $$;
-- Return only released finance documents and one support owner; never the underlying ledger.
create or replace function pulse.portal_project(pr uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cl uuid:=portal_access(pr);pid uuid:=portal_actor();
begin
 return jsonb_build_object('project',jsonb_build_object('id',pr,'title',(select coalesce(title,name) from project where id=pr),'package',(select package from pulse_priv.delivery_plan where project_id=pr),'templateVersion',0),
 'releases',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'projectId',pr,'taskId',r.task_id,'versionId',r.version_id,'fingerprint',r.fingerprint,'title',r.title,'number',(select version_no from version where id=r.version_id),'duration',r.body->'duration','mediaState',case when exists(select 1 from pulse_priv.delivery_task t where t.id=r.task_id and t.state='accepted' and t.body->>'version'=r.version_id::text) then r.body->>'mediaState' else 'changed_version' end,'mime',r.body->>'mime','rights','Authorized review copy','approved',(select jsonb_build_object('name',(select name from pulse_priv.portal_principal where id=f.principal_id),'at',f.at) from pulse_priv.portal_feedback f where f.org_id=current_org() and f.release_id=r.id and f.kind='approval' and not exists(select 1 from pulse_priv.portal_feedback newer where newer.release_id=f.release_id and newer.at>f.at and newer.kind='change') and exists(select 1 from pulse_priv.delivery_task t where t.id=r.task_id and t.state='accepted' and t.body->>'version'=r.version_id::text) order by f.at desc limit 1)) order by r.at desc) from pulse_priv.portal_release r where r.org_id=current_org() and r.project_id=pr and r.active),'[]'),
 'feedback',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'releaseId',f.release_id,'kind',f.kind,'name',(select name from pulse_priv.portal_principal where id=f.principal_id),'at',f.at,'body',f.body)) from pulse_priv.portal_feedback f join pulse_priv.portal_release r on r.id=f.release_id where f.org_id=current_org() and r.project_id=pr and r.active),'[]'),
 'support',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'body',s.body,'at',s.at,'owner',(select display_name from person where id=s.owner_id))) from pulse_priv.portal_support s where s.org_id=current_org() and s.project_id=pr and s.principal_id=pid),'[]'),
 'documents',coalesce((select jsonb_agg(portal_document_read(d.id)) from pulse_priv.portal_document d where d.org_id=current_org() and d.project_id=pr and d.client_id=cl),'[]'),
 'policy',(select jsonb_build_object('id',p.id,'version',p.version,'title',p.title,'body',p.body,'effective',p.effective,'acknowledged',exists(select 1 from pulse_priv.portal_ack a where a.org_id=current_org() and a.principal_id=pid and a.policy_id=p.id)) from pulse_priv.portal_policy p where p.org_id=current_org() and p.effective<=current_date order by p.version desc limit 1),
 'publication',(select body from pulse_priv.portal_publication where org_id=current_org() and project_id=pr and active),
 'supportOwner',coalesce((select display_name from person where id=(select owner_id from pulse_priv.delivery_plan where org_id=current_org() and project_id=pr)),(select display_name from person where id=(select owner_id from pulse_priv.delivery_task where org_id=current_org() and project_id=pr limit 1))),
 'signer',(select signer from pulse_priv.portal_grant where org_id=current_org() and principal_id=pid and project_id=pr and active));
end $$;

revoke all on function pulse.portal_document_add(jsonb),pulse.portal_document_read(uuid),pulse.portal_refund_request(uuid,uuid,jsonb),pulse.portal_support_staff(uuid,jsonb) from public;
grant execute on function pulse.portal_document_add(jsonb),pulse.portal_document_read(uuid),pulse.portal_refund_request(uuid,uuid,jsonb),pulse.portal_support_staff(uuid,jsonb) to pulse_api;
-- migrate:down
