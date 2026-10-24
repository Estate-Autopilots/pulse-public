-- migrate:up
-- EST-1396 / frozen rc.1 §3: no email matching, public provisioning or browser-supplied proof.
create table pulse_priv.google_settings(org_id uuid primary key references pulse.org(id),enabled boolean not null default false,
 allowed_domains text[] not null default '{}',trust_google_2_step boolean not null default false,password_sign_in text not null default 'on' check(password_sign_in in('on','off_for_linked')));
create table pulse_priv.google_identity(org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),
 issuer text not null check(issuer='https://accounts.google.com'),subject text not null check(length(subject) between 1 and 255),email text not null,domain text not null,
 linked_at timestamptz not null default now(),last_used_at timestamptz,primary key(org_id,issuer,subject),unique(org_id,person_id));
create table pulse_priv.google_link_attempt(org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),
 state_hash text primary key check(state_hash~'^[a-f0-9]{64}$'),cookie_hash text not null check(cookie_hash~'^[a-f0-9]{64}$'),session_hash text not null,
 nonce text not null,verifier text not null,expires_at timestamptz not null default now()+interval '10 minutes');
alter table pulse.login_session add column via text not null default 'password' check(via in('password','google'));
do $$ declare t text;begin
 foreach t in array array['google_settings','google_identity','google_link_attempt'] loop
  execute format('alter table pulse_priv.%I enable row level security',t);
  execute format('alter table pulse_priv.%I force row level security',t);
  execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 end loop;
end $$;
-- Server-only reads for the OIDC session adapter; these never grant table access or match email.
create function pulse.google_policy() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select jsonb_build_object('enabled',enabled,'allowedDomains',allowed_domains,'trustGoogle2Step',trust_google_2_step,'passwordSignIn',password_sign_in) from pulse_priv.google_settings where org_id=current_org()),'{"enabled":false,"allowedDomains":[],"trustGoogle2Step":false,"passwordSignIn":"on"}'::jsonb)
$$;
create function pulse.google_identity_resolve(iss text,sub text,used boolean default false) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid;d text;s pulse_priv.google_settings%rowtype;begin
 -- Turning Google off or removing a domain stops existing links too, not only new ones.
 select * into s from pulse_priv.google_settings where org_id=current_org();
 if s.enabled is distinct from true then return jsonb_build_object('error','provider_error');end if;
 select person_id into a from pulse_priv.google_identity where org_id=current_org() and issuer=iss and subject=sub;
 if a is null then return jsonb_build_object('error','not_linked');end if;
 perform auth_lock('staff',a);
 select domain into d from pulse_priv.google_identity where org_id=current_org() and person_id=a and issuer=iss and subject=sub;
 if not found then return jsonb_build_object('error','not_linked');end if;
 if not d=any(s.allowed_domains) then return jsonb_build_object('error','domain_not_allowed');end if;
 if not exists(select 1 from person p join login_credential c on c.person_id=p.id and c.org_id=p.org_id where p.org_id=current_org() and p.id=a and p.status='active' and p.side='staff' and c.status='active') then return jsonb_build_object('error','account_disabled');end if;
 if used then update pulse_priv.google_identity set last_used_at=clock_timestamp() where org_id=current_org() and person_id=a and issuer=iss and subject=sub;end if;
 return jsonb_build_object('personId',a);
end $$;
create function pulse.google_settings(b jsonb default null,otp text default '') returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pulse_priv.google_settings%rowtype;domains text[];notices jsonb:='[]';
begin
 if current_viewer() is null or not viewer_is('admin') then raise exception 'Admin required' using errcode='42501';end if;
 perform auth_lock('staff',current_viewer());
 insert into pulse_priv.google_settings(org_id) values(current_org()) on conflict do nothing;
 select * into s from pulse_priv.google_settings where org_id=current_org() for update;
 if b is not null then
  if jsonb_typeof(b)<>'object' or not b ?& array['enabled','allowedDomains','trustGoogle2Step','passwordSignIn'] or b-array['enabled','allowedDomains','trustGoogle2Step','passwordSignIn']<>'{}'
   or jsonb_typeof(b->'enabled')<>'boolean' or jsonb_typeof(b->'trustGoogle2Step')<>'boolean' or jsonb_typeof(b->'allowedDomains')<>'array' or b->>'passwordSignIn' is null or b->>'passwordSignIn' not in('on','off_for_linked') then raise exception 'Invalid Google settings' using errcode='22023';end if;
  select array_agg(value) into domains from jsonb_array_elements_text(b->'allowedDomains');domains:=coalesce(domains,'{}');
  if cardinality(domains)>10 or cardinality(domains)<>(select count(distinct d) from unnest(domains)d) or exists(select 1 from unnest(domains)d where length(d)>253 or d !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$')
   or (b->>'enabled')::boolean and cardinality(domains)=0 then raise exception 'Allowed Workspace domains required' using errcode='22023';end if;
  if b->>'passwordSignIn'='off_for_linked' and (not (b->>'enabled')::boolean or exists(select 1 from pulse_priv.google_identity where org_id=current_org() and not(domain=any(domains)))) then raise exception 'Keep a password recovery path' using errcode='22023';end if;
  if s.trust_google_2_step is distinct from (b->>'trustGoogle2Step')::boolean then
   if exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm='staff' and actor=current_viewer() and totp is not null)
    and (not auth_allow('google-policy-otp:'||current_viewer(),5) or not auth_otp('staff',current_viewer(),otp)) then raise exception 'Fresh Pulse two-step required' using errcode='42501';end if;
   select coalesce(jsonb_agg(jsonb_build_object('actor',p.id,'delivery',auth_delivery('staff',p.id))),'[]') into notices from person p where p.org_id=current_org() and p.status='active' and exists(select 1 from role_assignment r where r.org_id=p.org_id and r.person_id=p.id and r.role_key='admin' and current_date between r.valid_from and coalesce(r.valid_to,'infinity'));
  end if;
  update pulse_priv.google_settings set enabled=(b->>'enabled')::boolean,allowed_domains=domains,trust_google_2_step=(b->>'trustGoogle2Step')::boolean,password_sign_in=b->>'passwordSignIn' where org_id=current_org() returning * into s;
  perform auth_event_add('staff',current_viewer(),'google_policy_changed');
 end if;
 return jsonb_build_object('enabled',s.enabled,'allowedDomains',s.allowed_domains,'trustGoogle2Step',s.trust_google_2_step,'passwordSignIn',s.password_sign_in,'notices',notices);
end $$;
create function pulse.google_link_state() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('email',email,'linkedAt',linked_at,'lastUsedAt',last_used_at) from pulse_priv.google_identity where org_id=current_org() and person_id=current_viewer()
$$;
-- Only the server callback uses this API. Hash both the browser cookie and state; never return PKCE to a route.
create function pulse.google_link_attempt(op text,b jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a pulse_priv.google_link_attempt%rowtype;s pulse_priv.google_settings%rowtype;proof jsonb:=b->'proof';
begin
 if op='begin' then
  if current_viewer() is null then raise exception 'Account session required' using errcode='42501';end if;
  a.person_id:=current_viewer();
 else select * into a from pulse_priv.google_link_attempt where org_id=current_org() and state_hash=b->>'stateHash' and cookie_hash=b->>'cookieHash' and expires_at>clock_timestamp();
  if not found then return jsonb_build_object('error','state_invalid');end if;
 end if;
 perform auth_lock('staff',a.person_id);
 select * into s from pulse_priv.google_settings where org_id=current_org() for update;
 if op='finish' then
  delete from pulse_priv.google_link_attempt where org_id=current_org() and state_hash=a.state_hash and expires_at>clock_timestamp() returning * into a;
  if not found then return jsonb_build_object('error','state_invalid');end if;
 end if;
 if s.enabled is distinct from true then return jsonb_build_object('error','provider_error');end if;
 if not exists(select 1 from login_session l join person p on p.id=l.person_id and p.org_id=l.org_id join login_credential c on c.person_id=p.id and c.org_id=p.org_id
  where l.org_id=current_org() and p.id=a.person_id and p.side='staff' and p.status='active' and c.status='active' and not c.must_change and l.via='password' and l.revoked_at is null and l.expires_at>now() and l.token_hash=case when op='begin' then b->>'sessionHash' else a.session_hash end) then return jsonb_build_object('error','account_disabled');end if;
 if op='begin' then
  delete from pulse_priv.google_link_attempt where org_id=current_org() and (expires_at<=now() or person_id=a.person_id);
  insert into pulse_priv.google_link_attempt(org_id,person_id,state_hash,cookie_hash,session_hash,nonce,verifier) values(current_org(),a.person_id,b->>'stateHash',b->>'cookieHash',b->>'sessionHash',b->>'nonce',b->>'verifier');return jsonb_build_object('ok',true);
 elsif op='read' then return jsonb_build_object('nonce',a.nonce,'verifier',a.verifier);
 elsif op<>'finish' then raise exception 'Invalid link action' using errcode='22023';end if;
 if proof->>'iss' is distinct from 'https://accounts.google.com' or proof->'email_verified' is distinct from 'true'::jsonb or coalesce(length(proof->>'sub'),0) not between 1 and 255
  or proof->>'email' is null or coalesce((proof->>'auth_time')::numeric,0) not between extract(epoch from clock_timestamp())-300 and extract(epoch from clock_timestamp())+60 then return jsonb_build_object('error','provider_error');end if;
 if not coalesce(proof->>'hd'=any(s.allowed_domains),false) then return jsonb_build_object('error','domain_not_allowed');end if;
 insert into pulse_priv.google_identity(org_id,person_id,issuer,subject,email,domain) values(current_org(),a.person_id,proof->>'iss',proof->>'sub',proof->>'email',proof->>'hd') on conflict do nothing;
 if not found then return jsonb_build_object('error','already_linked');end if;
 perform auth_event_add('staff',a.person_id,'google_linked');return jsonb_build_object('ok',true);
end $$;
create function pulse.google_unlink(a uuid default pulse.current_viewer()) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or a is null or a<>current_viewer() and not viewer_is('admin') then raise exception 'Account owner or admin required' using errcode='42501';end if;
 perform auth_lock('staff',a);
 if not exists(select 1 from person where org_id=current_org() and id=a and side='staff') then raise exception 'Person unavailable' using errcode='42501';end if;
 delete from pulse_priv.google_link_attempt where org_id=current_org() and person_id=a;
 delete from pulse_priv.google_identity where org_id=current_org() and person_id=a;
 update login_session set revoked_at=now() where org_id=current_org() and person_id=a and via='google' and revoked_at is null;
 perform auth_event_add('staff',a,'google_unlinked');return jsonb_build_object('ok',true);
end $$;
create function pulse.google_password_allowed(a uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select not exists(select 1 from pulse_priv.google_settings s join pulse_priv.google_identity i using(org_id) where s.org_id=current_org() and i.person_id=a and s.password_sign_in='off_for_linked')
 or exists(select 1 from role_assignment where org_id=current_org() and person_id=a and role_key='admin' and current_date between valid_from and coalesce(valid_to,'infinity'))
$$;
-- Apply policy to every caller of password verification, including native sign-in. Recovery admins stay allowed.
alter function pulse.login_verify(text,text) rename to google_password_verify;
revoke all on function pulse.google_password_verify(text,text) from public,pulse_api;
create function pulse.login_verify(p_username text,p_password text) returns table(person_id uuid,must_change boolean) language sql volatile security definer set search_path=pulse,pg_temp as $$
 select v.* from google_password_verify(p_username,p_password) v where google_password_allowed(v.person_id)
$$;
revoke all on function pulse.google_policy(),pulse.google_identity_resolve(text,text,boolean),pulse.google_settings(jsonb,text),pulse.google_link_state(),pulse.google_link_attempt(text,jsonb),pulse.google_unlink(uuid),pulse.google_password_allowed(uuid),pulse.login_verify(text,text) from public;
grant execute on function pulse.google_policy(),pulse.google_identity_resolve(text,text,boolean),pulse.google_settings(jsonb,text),pulse.google_link_state(),pulse.google_link_attempt(text,jsonb),pulse.google_unlink(uuid),pulse.google_password_allowed(uuid),pulse.login_verify(text,text) to pulse_api;
-- migrate:down
drop function pulse.login_verify(text,text);
alter function pulse.google_password_verify(text,text) rename to login_verify;
grant execute on function pulse.login_verify(text,text) to pulse_api;
drop function pulse.google_policy(),pulse.google_identity_resolve(text,text,boolean),pulse.google_settings(jsonb,text),pulse.google_link_state(),pulse.google_link_attempt(text,jsonb),pulse.google_unlink(uuid),pulse.google_password_allowed(uuid);
alter table pulse.login_session drop column via;
drop table pulse_priv.google_link_attempt,pulse_priv.google_identity,pulse_priv.google_settings;
