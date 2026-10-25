-- migrate:up
-- Distinct client principals never become staff directory or internal chat members.
create table pulse_priv.portal_principal(id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),username text not null,
 name text not null,password_hash text not null,must_change boolean not null default true,active boolean not null default true,issued_at timestamptz not null default now(),
 locked_until timestamptz,failed int not null default 0,unique(org_id,username),check(username~'^[a-z0-9][a-z0-9._-]{2,59}$'));
create table pulse_priv.portal_session(org_id uuid not null references pulse.org(id),token_hash text primary key,principal_id uuid not null references pulse_priv.portal_principal(id),
 expires_at timestamptz not null,revoked_at timestamptz);
create table pulse_priv.portal_grant(org_id uuid not null references pulse.org(id),principal_id uuid not null references pulse_priv.portal_principal(id),client_id uuid not null references pulse.client(id),
 project_id uuid not null references pulse.project(id),signer boolean not null default false,active boolean not null default true,reason text not null,
 primary key(org_id,principal_id,project_id));
create table pulse_priv.portal_reset(id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),principal_id uuid not null references pulse_priv.portal_principal(id),
 at timestamptz not null default now(),resolved_at timestamptz);
create unique index portal_reset_pending on pulse_priv.portal_reset(org_id,principal_id) where resolved_at is null;
create table pulse_priv.portal_release(id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),project_id uuid not null references pulse.project(id),
 task_id uuid not null references pulse_priv.delivery_task(id),version_id uuid not null references pulse.version(id),fingerprint text not null,title text not null,
 body jsonb not null,active boolean not null default true,at timestamptz not null default now(),unique(org_id,version_id),check(fingerprint~'^[a-f0-9]{64}$'));
create table pulse_priv.portal_feedback(id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),release_id uuid not null references pulse_priv.portal_release(id),
 principal_id uuid not null references pulse_priv.portal_principal(id),request_key text not null,kind text not null check(kind in('comment','change','approval')),body jsonb not null,at timestamptz not null default now(),unique(org_id,principal_id,request_key));
create table pulse_priv.portal_support(id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),project_id uuid not null references pulse.project(id),
 principal_id uuid not null references pulse_priv.portal_principal(id),owner_id uuid not null references pulse.person(id),kind text not null check(kind in('message','change_request','staff_response')),body jsonb not null,at timestamptz not null default now());
create table pulse_priv.portal_document(id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),project_id uuid not null references pulse.project(id),client_id uuid not null references pulse.client(id),
 kind text not null check(kind in('quote','order','invoice','payment','credit','refund')),external_key text not null,revision text not null,body jsonb not null,at timestamptz not null default now(),unique(org_id,external_key,revision));
create table pulse_priv.portal_policy(id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),version int not null,title text not null,body text not null,effective date not null,at timestamptz not null default now(),unique(org_id,version));
create table pulse_priv.portal_ack(org_id uuid not null references pulse.org(id),principal_id uuid not null references pulse_priv.portal_principal(id),policy_id uuid not null references pulse_priv.portal_policy(id),at timestamptz not null default now(),primary key(org_id,principal_id,policy_id));
create table pulse_priv.portal_publication(org_id uuid not null references pulse.org(id),project_id uuid primary key references pulse.project(id),body jsonb not null,active boolean not null default false,at timestamptz not null default now());
create table pulse_priv.review_upload(id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),project_id uuid not null references pulse.project(id),actor uuid not null references pulse.person(id),
 total bigint not null check(total between 1 and 53687091200),received bigint not null default 0,digest text,complete boolean not null default false,expires_at timestamptz not null default now()+interval '24 hours');
do $$ declare t text;begin
 foreach t in array array['portal_principal','portal_session','portal_grant','portal_reset','portal_release','portal_feedback','portal_support','portal_document','portal_policy','portal_ack','portal_publication','review_upload'] loop
 execute format('alter table pulse_priv.%I enable row level security',t);execute format('alter table pulse_priv.%I force row level security',t);
 execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('create trigger audit_mutation after insert or update or delete on pulse_priv.%I for each row execute function pulse.audit_mutation()',t);
 end loop;end $$;
create function pulse.portal_admin() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin if not viewer_is('admin','leadership') then raise exception 'Client access authority required' using errcode='42501';end if;end $$;
create function pulse.portal_issue(p_id uuid,p_username text,p_name text,p_password text) returns uuid language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare result uuid;
begin
 perform portal_admin();if octet_length(p_password) not between 16 and 72 or length(trim(p_name)) not between 1 and 160 then raise exception 'Client name and private temporary secret required' using errcode='22023';end if;
 if p_id is null then insert into pulse_priv.portal_principal(org_id,username,name,password_hash) values(current_org(),lower(trim(p_username)),p_name,crypt(p_password,gen_salt('bf',10))) returning id into result;
 else update pulse_priv.portal_principal set password_hash=crypt(p_password,gen_salt('bf',10)),must_change=true,issued_at=now(),failed=0,locked_until=null where id=p_id and org_id=current_org() returning id into result;
 if result is null then raise exception 'Client login unavailable' using errcode='42501';end if;end if;
 update pulse_priv.portal_session set revoked_at=now() where org_id=current_org() and principal_id=result;
 update pulse_priv.portal_reset set resolved_at=now() where org_id=current_org() and principal_id=result and resolved_at is null;
 return result;
end $$;
create function pulse.portal_grant_save(p uuid,pr uuid,s boolean,a boolean,reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cl uuid;
begin
 perform portal_admin();perform delivery_access(pr);
 select client_id into cl from project where org_id=current_org() and id=pr;
 if cl is null or length(trim(reason))<3 or not exists(select 1 from pulse_priv.portal_principal where id=p and org_id=current_org() and active) then raise exception 'Confirmed client account membership and authority reason required' using errcode='22023';end if;
 insert into pulse_priv.portal_grant values(current_org(),p,cl,pr,s,a,reason) on conflict(org_id,principal_id,project_id) do update set signer=excluded.signer,active=excluded.active,reason=excluded.reason;
end $$;
create function pulse.portal_deactivate(p uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform portal_admin();update pulse_priv.portal_principal set active=false where org_id=current_org() and id=p;update pulse_priv.portal_session set revoked_at=now() where org_id=current_org() and principal_id=p;update pulse_priv.portal_grant set active=false where org_id=current_org() and principal_id=p;end $$;
create function pulse.portal_login(u text,p text,t text) returns jsonb language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare cred pulse_priv.portal_principal%rowtype;
begin
 select * into cred from pulse_priv.portal_principal where org_id=current_org() and username=lower(trim(u)) and active for update;
 if not found or octet_length(p)>72 then perform crypt(left(p,72),gen_salt('bf',10));return null;end if;
 if cred.locked_until>now() or cred.must_change and cred.issued_at<now()-interval '7 days' then return null;end if;
 if cred.password_hash<>crypt(p,cred.password_hash) then update pulse_priv.portal_principal set failed=failed+1,locked_until=case when failed>=4 then now()+interval '15 minutes' else null end where id=cred.id;return null;end if;
 update pulse_priv.portal_principal set failed=0,locked_until=null where id=cred.id;
 insert into pulse_priv.portal_session values(current_org(),t,cred.id,now()+interval '2 hours',null);
 return jsonb_build_object('name',cred.name,'mustChange',cred.must_change,'expiresAt',now()+interval '2 hours');
end $$;
create function pulse.portal_auth(t text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare p pulse_priv.portal_principal%rowtype;
begin
 select c.* into p from pulse_priv.portal_principal c join pulse_priv.portal_session s on s.principal_id=c.id where s.org_id=current_org() and s.token_hash=t and s.revoked_at is null and s.expires_at>now() and c.org_id=current_org() and c.active;
 if not found then raise exception 'Client session ended; sign in again' using errcode='42501';end if;
 perform set_config('pulse.portal_id',p.id::text,true);
 return jsonb_build_object('id',p.id,'name',p.name,'mustChange',p.must_change,'role','client');
end $$;
create function pulse.portal_actor() returns uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare p uuid:=nullif(current_setting('pulse.portal_id',true),'')::uuid;
begin
 if not exists(select 1 from pulse_priv.portal_principal where org_id=current_org() and id=p and active and not must_change) then raise exception 'Change your issued password before opening client work' using errcode='42501';end if;return p;
end $$;
create function pulse.portal_access(pr uuid,signing boolean default false) returns uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare p uuid:=portal_actor();cl uuid;
begin
 select g.client_id into cl from pulse_priv.portal_grant g join project x on x.id=g.project_id and x.client_id=g.client_id where g.org_id=current_org() and x.org_id=current_org() and g.principal_id=p and g.project_id=pr and g.active and (not signing or g.signer);
 if cl is null then raise exception 'Client work unavailable for this account' using errcode='42501';end if;return cl;
end $$;
create function pulse.portal_password(old text,newpass text,token text) returns boolean language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare p uuid:=nullif(current_setting('pulse.portal_id',true),'')::uuid;cred pulse_priv.portal_principal%rowtype;
begin
 select * into cred from pulse_priv.portal_principal where org_id=current_org() and id=p and active for update;
 if octet_length(newpass) not between 10 and 72 or old=newpass then raise exception 'Choose a different password of 10 to 72 bytes' using errcode='22023';end if;
 if not found or cred.password_hash<>crypt(old,cred.password_hash) then return false;end if;
 update pulse_priv.portal_principal set password_hash=crypt(newpass,gen_salt('bf',10)),must_change=false where id=p;
 update pulse_priv.portal_session set revoked_at=now() where org_id=current_org() and principal_id=p and token_hash<>token;return true;
end $$;
create function pulse.portal_forgot(u text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 insert into pulse_priv.portal_reset(org_id,principal_id) select current_org(),id from pulse_priv.portal_principal where org_id=current_org() and username=lower(trim(u)) and active on conflict do nothing;
 -- Verified EA support performs the reset; a request alone cannot lock someone else out.
end $$;
create function pulse.portal_logout(t text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin update pulse_priv.portal_session set revoked_at=now() where org_id=current_org() and token_hash=t;end $$;
create function pulse.portal_staff_state() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform portal_admin();return jsonb_build_object('principals',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'username',username,'active',active,'mustChange',must_change)) from pulse_priv.portal_principal where org_id=current_org()),'[]'),
 'grants',coalesce((select jsonb_agg(to_jsonb(g)-'org_id') from pulse_priv.portal_grant g where org_id=current_org()),'[]'),
 'resets',coalesce((select jsonb_agg(jsonb_build_object('id',id,'principalId',principal_id,'at',at)) from pulse_priv.portal_reset where org_id=current_org() and resolved_at is null),'[]'));
end $$;
create function pulse.portal_release_add(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pr uuid:=(p->>'projectId')::uuid;ver uuid:=(p->>'versionId')::uuid;tid uuid:=(p->>'taskId')::uuid;result uuid;t pulse_priv.delivery_task%rowtype;
begin
 perform delivery_access(pr,true);perform pg_advisory_xact_lock(hashtextextended('delivery:'||current_org()::text,0));
 select * into t from pulse_priv.delivery_task where org_id=current_org() and project_id=pr and id=tid;
 if t.state<>'accepted' or t.body->>'version' is distinct from ver::text or not exists(select 1 from version v join asset a on a.id=v.asset_id where v.id=ver and v.org_id=current_org() and a.org_id=current_org() and a.project_id=pr)
 or p->>'rightsConfirmed' is distinct from 'true' or coalesce(p->>'rights','')='' or coalesce(p->>'sourceHash','')='' or coalesce(p->>'sourceRevision','')='' then raise exception 'Accepted exact version and retained media rights/source evidence required' using errcode='22023';end if;
 if p->>'mediaState'='ready' and not exists(select 1 from pulse_priv.review_upload where org_id=current_org() and project_id=pr and complete and digest=p->>'fingerprint') then raise exception 'Verified retained immutable review copy required' using errcode='22023';end if;
 if p->>'mediaState' not in('ready','permission_blocked','unsupported_codec','awaiting_copy') or (p->>'duration')::numeric<=0 or (p->>'duration')::numeric>86400 then raise exception 'Media duration and disclosed recovery state required' using errcode='22023';end if;
 insert into pulse_priv.portal_release(org_id,project_id,task_id,version_id,fingerprint,title,body) values(current_org(),pr,tid,ver,p->>'fingerprint',p->>'title',p) returning id into result;return result;
end $$;
create function pulse.portal_release_read(r uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x pulse_priv.portal_release%rowtype;
begin select * into x from pulse_priv.portal_release where org_id=current_org() and id=r and active;if not found then raise exception 'Released artifact unavailable' using errcode='42501';end if;perform portal_access(x.project_id);
 if not exists(select 1 from pulse_priv.delivery_task where org_id=current_org() and id=x.task_id and state='accepted' and body->>'version'=x.version_id::text) then raise exception 'Version changed; renewed release and approval required' using errcode='40001';end if;
 return jsonb_build_object('id',x.id,'projectId',x.project_id,'taskId',x.task_id,'versionId',x.version_id,'fingerprint',x.fingerprint,'title',x.title,'number',(select version_no from version where id=x.version_id),'duration',x.body->'duration','mediaState',x.body->>'mediaState','mime',x.body->>'mime','timebase',x.body->'timebase','mapping',x.body->'mapping','rights','Authorized immutable review copy');end $$;
create function pulse.portal_release_withdraw(r uuid,reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pr uuid;begin select project_id into pr from pulse_priv.portal_release where org_id=current_org() and id=r;perform delivery_access(pr,true);if length(trim(reason))<3 then raise exception 'Withdrawal reason required' using errcode='22023';end if;update pulse_priv.portal_release set active=false where org_id=current_org() and id=r;end $$;
create function pulse.portal_feedback_add(r uuid,k text,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x jsonb;pid uuid:=portal_actor();result uuid;previous jsonb;tk pulse_priv.delivery_task%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended('delivery:'||current_org()::text,0));x:=portal_release_read(r);
 if p->>'versionId' is distinct from x->>'versionId' or p->>'fingerprint' is distinct from x->>'fingerprint' or length(coalesce(p->>'requestKey','')) not between 1 and 160 then raise exception 'Exact published version fingerprint and request key required' using errcode='40001';end if;
 if k='approval' then perform portal_access((x->>'projectId')::uuid,true);if x->>'mediaState'<>'ready' then raise exception 'Playable retained review copy required before approval' using errcode='22023';end if;end if;
 if k not in('comment','change','approval') or k in('comment','change') and length(trim(coalesce(p->>'text',''))) not between 1 and 4000 then raise exception 'Review comment or change reason required' using errcode='22023';end if;
 if k='comment' and ((p->>'seconds')::numeric<0 or (p->>'seconds')::numeric>(x->>'duration')::numeric or p->>'timebase' is distinct from 'seconds' or p->>'seconds' is null or (p->>'rangeEnd')::numeric<(p->>'seconds')::numeric or (p->>'rangeEnd')::numeric>(x->>'duration')::numeric) then raise exception 'Timestamp must be on the released timebase' using errcode='22023';end if;
 select id,body into result,previous from pulse_priv.portal_feedback where org_id=current_org() and principal_id=pid and request_key=p->>'requestKey';
 if result is not null then if previous<>p or not exists(select 1 from pulse_priv.portal_feedback where id=result and release_id=r and kind=k) then raise exception 'Review replay differs' using errcode='40001';end if;return result;end if;
 insert into pulse_priv.portal_feedback(org_id,release_id,principal_id,request_key,kind,body) values(current_org(),r,pid,p->>'requestKey',k,p) returning id into result;
 select * into tk from pulse_priv.delivery_task where id=(x->>'taskId')::uuid and org_id=current_org();
 if k='change' then
 update pulse_priv.delivery_task set state='in_progress',revision=revision+1,body=body||jsonb_build_object('reviewVersion',null) where id=tk.id;
 update task set status='in_progress' where id=tk.id;
 insert into pulse_priv.delivery_event(org_id,task_id,kind,body) values(current_org(),tk.id,'client_change',jsonb_build_object('releaseId',r,'versionId',x->>'versionId','feedbackId',result));
 end if;
 return result;
end $$;
create function pulse.portal_project(pr uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cl uuid:=portal_access(pr);pid uuid:=portal_actor();
begin
 return jsonb_build_object('project',jsonb_build_object('id',pr,'title',(select coalesce(title,name) from project where id=pr),'package',(select package from pulse_priv.delivery_plan where project_id=pr),'templateVersion',0),
 'releases',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'projectId',pr,'taskId',r.task_id,'versionId',r.version_id,'fingerprint',r.fingerprint,'title',r.title,'number',(select version_no from version where id=r.version_id),'duration',r.body->'duration','mediaState',case when exists(select 1 from pulse_priv.delivery_task t where t.id=r.task_id and t.state='accepted' and t.body->>'version'=r.version_id::text) then r.body->>'mediaState' else 'changed_version' end,'mime',r.body->>'mime','rights','Authorized review copy','approved',(select jsonb_build_object('name',(select name from pulse_priv.portal_principal where id=f.principal_id),'at',f.at) from pulse_priv.portal_feedback f where f.org_id=current_org() and f.release_id=r.id and f.kind='approval' and not exists(select 1 from pulse_priv.portal_feedback newer where newer.release_id=f.release_id and newer.at>f.at and newer.kind='change') and exists(select 1 from pulse_priv.delivery_task t where t.id=r.task_id and t.state='accepted' and t.body->>'version'=r.version_id::text) order by f.at desc limit 1)) order by r.at desc) from pulse_priv.portal_release r where r.org_id=current_org() and r.project_id=pr and r.active),'[]'),
 'feedback',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'releaseId',f.release_id,'kind',f.kind,'name',(select name from pulse_priv.portal_principal where id=f.principal_id),'at',f.at,'body',f.body)) from pulse_priv.portal_feedback f join pulse_priv.portal_release r on r.id=f.release_id where f.org_id=current_org() and r.project_id=pr and r.active),'[]'),
 'support',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'body',s.body,'at',s.at,'owner',(select display_name from person where id=s.owner_id))) from pulse_priv.portal_support s where s.org_id=current_org() and s.project_id=pr and s.principal_id=pid),'[]'),
 'documents',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'kind',d.kind,'revision',d.revision,'body',d.body)) from pulse_priv.portal_document d where d.org_id=current_org() and d.project_id=pr and d.client_id=cl),'[]'),
 'policy',(select jsonb_build_object('id',p.id,'version',p.version,'title',p.title,'body',p.body,'effective',p.effective,'acknowledged',exists(select 1 from pulse_priv.portal_ack a where a.org_id=current_org() and a.principal_id=pid and a.policy_id=p.id)) from pulse_priv.portal_policy p where p.org_id=current_org() and p.effective<=current_date order by p.version desc limit 1),
 'publication',(select body from pulse_priv.portal_publication where org_id=current_org() and project_id=pr and active),
 'signer',(select signer from pulse_priv.portal_grant where org_id=current_org() and principal_id=pid and project_id=pr and active));
end $$;
create function pulse.portal_projects() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pid uuid:=portal_actor();begin return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'title',coalesce(p.title,p.name),'client',(select display_name from client where id=g.client_id))) from pulse_priv.portal_grant g join project p on p.id=g.project_id and p.client_id=g.client_id where g.org_id=current_org() and p.org_id=current_org() and g.principal_id=pid and g.active),'[]');end $$;
create function pulse.portal_support_add(pr uuid,k text,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pid uuid:=portal_actor();own uuid;result uuid;
begin
 perform portal_access(pr);select owner_id into own from pulse_priv.delivery_plan where org_id=current_org() and project_id=pr;
 if own is null then select owner_id into own from pulse_priv.delivery_task where org_id=current_org() and project_id=pr limit 1;end if;
 if own is null or k not in('message','change_request') or length(trim(coalesce(p->>'text',''))) not between 1 and 4000 then raise exception 'Assigned support owner and explicit requirement required' using errcode='22023';end if;
 insert into pulse_priv.portal_support(org_id,project_id,principal_id,owner_id,kind,body) values(current_org(),pr,pid,own,k,jsonb_build_object('text',p->>'text','links',p->'links','sla','No approved response expectation configured')) returning id into result;
 -- Client DMs are not ingested into task or performance streams.
 return result;
end $$;
create function pulse.portal_policy_publish(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result uuid;ver int;begin perform portal_admin();perform pg_advisory_xact_lock(hashtextextended('portal-policy:'||current_org()::text,0));select coalesce(max(version),0)+1 into ver from pulse_priv.portal_policy where org_id=current_org();
 if p->>'approved' is distinct from 'true' or length(coalesce(p->>'body','')) not between 1 and 20000 or length(coalesce(p->>'title','')) not between 1 and 160 then raise exception 'Explicit approved policy text required' using errcode='22023';end if;
 insert into pulse_priv.portal_policy(org_id,version,title,body,effective) values(current_org(),ver,p->>'title',p->>'body',(p->>'effective')::date) returning id into result;return result;end $$;
create function pulse.portal_policy_ack(p uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pid uuid:=portal_actor();begin if not exists(select 1 from pulse_priv.portal_policy where id=p and org_id=current_org() and effective<=current_date) then raise exception 'Published policy unavailable' using errcode='42501';end if;insert into pulse_priv.portal_ack values(current_org(),pid,p,now()) on conflict do nothing;end $$;
create function pulse.portal_publish(pr uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform portal_admin();perform delivery_access(pr);if p->>'active'='true' and (p->>'optIn' is distinct from 'true' or p->>'precision' is distinct from 'approximate' or length(coalesce(p->>'label',''))<1 or abs((p->>'lat')::numeric)>90 or abs((p->>'lng')::numeric)>180) then raise exception 'Opt-in approximate showcase publication required' using errcode='22023';end if;
 insert into pulse_priv.portal_publication values(current_org(),pr,jsonb_build_object('label',p->>'label','lat',round((p->>'lat')::numeric,2),'lng',round((p->>'lng')::numeric,2),'precision','approximate'),(p->>'active')::boolean,now()) on conflict(project_id) do update set body=excluded.body,active=excluded.active,at=excluded.at;end $$;
create function pulse.review_upload_save(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result pulse_priv.review_upload%rowtype;pr uuid:=(p->>'projectId')::uuid;uid uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid());
begin
 perform delivery_access(pr,true);perform pg_advisory_xact_lock(hashtextextended('review-upload:'||uid::text,0));
 select * into result from pulse_priv.review_upload where org_id=current_org() and id=uid for update;
 if result.id is null then insert into pulse_priv.review_upload(id,org_id,project_id,actor,total) values(uid,current_org(),pr,current_viewer(),(p->>'total')::bigint) returning * into result;
 else if result.actor<>current_viewer() or result.project_id<>pr or result.expires_at<now() or result.complete then raise exception 'Upload lease unavailable' using errcode='42501';end if;
 if (p->>'offset')::bigint<>result.received or p->>'offset' is null or (p->>'received')::bigint<result.received or (p->>'received')::bigint>result.total then raise exception 'Resume from the current upload offset' using errcode='40001';end if;
 update pulse_priv.review_upload set received=(p->>'received')::bigint,complete=coalesce((p->>'complete')::boolean,false),digest=p->>'digest' where id=uid returning * into result;
 if result.complete and (result.received<>result.total or result.digest!~'^[a-f0-9]{64}$' or result.digest is null) then raise exception 'Full retained copy and fingerprint required' using errcode='22023';end if;
 end if;return to_jsonb(result)-'org_id'-'actor';end $$;
-- Harden source replay and exact native version linkage without rewriting commitments.
create function pulse.review_upload_info(u uuid,pr uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pulse_priv.review_upload%rowtype;begin perform delivery_access(pr,true);select * into r from pulse_priv.review_upload where org_id=current_org() and id=u and project_id=pr and actor=current_viewer() and expires_at>now();if not found then raise exception 'Upload lease unavailable' using errcode='42501';end if;return to_jsonb(r)-'org_id'-'actor';end $$;
create function pulse.portal_version_immutable() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin if (new.file_id,new.md5,new.version_no,new.asset_id,new.variant) is distinct from (old.file_id,old.md5,old.version_no,old.asset_id,old.variant) and exists(select 1 from pulse_priv.portal_release where org_id=old.org_id and version_id=old.id) then raise exception 'Published version is immutable; create a new version' using errcode='40001';end if;return new;end $$;
create trigger portal_version_immutable before update on pulse.version for each row execute function pulse.portal_version_immutable();
create function pulse.delivery_exact_version() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if nullif(new.body->>'version','') is not null and not exists(select 1 from version v join asset a on a.id=v.asset_id where v.org_id=new.org_id and a.org_id=new.org_id and a.project_id=new.project_id and v.id::text=new.body->>'version') then raise exception 'Attach a native version belonging to this project' using errcode='22023';end if;return new;end $$;
create trigger exact_version before insert or update on pulse_priv.delivery_task for each row execute function pulse.delivery_exact_version();
create function pulse.portal_approval_gate() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.state in('ready','in_progress') and old.state in('draft','ready','unknown') and exists(select 1 from pulse_priv.delivery_edge e join pulse_priv.delivery_task s on s.id=e.source_id where e.org_id=new.org_id and e.target_id=new.id and e.kind='approval' and e.required and not exists(select 1 from pulse_priv.portal_release r join pulse_priv.portal_feedback f on f.release_id=r.id where r.org_id=new.org_id and r.task_id=s.id and r.version_id::text=s.body->>'version' and r.active and f.kind='approval' and not exists(select 1 from pulse_priv.portal_feedback n where n.release_id=r.id and n.kind='change' and n.at>f.at))) then raise exception 'Exact client approval gate is still pending' using errcode='22023';end if;return new;end $$;
create trigger client_approval_gate before update on pulse_priv.delivery_task for each row execute function pulse.portal_approval_gate();
create or replace function pulse.task_manual_wins() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin if current_viewer() is null then
 if 'title'=any(old.locked) then new.title:=old.title;end if;if 'status'=any(old.locked) then new.status:=old.status;end if;
 if 'owner_id'=any(old.locked) then new.owner_id:=old.owner_id;new.assignee_person_id:=old.assignee_person_id;end if;
 if 'due_label'=any(old.locked) then new.due_label:=old.due_label;new.due_at:=old.due_at;end if;if 'project_id'=any(old.locked) then new.project_id:=old.project_id;end if;
 -- Portal change is an authorized state event, even though it has no staff viewer.
 if nullif(current_setting('pulse.portal_id',true),'') is not null then new.status:='in_progress';end if;
 end if;return new;end $$;
do $$ declare f record;begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pulse' and (p.proname like 'portal_%' or p.proname in('review_upload_save','review_upload_info','delivery_exact_version')) loop
 execute format('revoke all on function %s from public',f.sig);execute format('grant execute on function %s to pulse_api',f.sig);end loop;
end $$;
-- migrate:down
