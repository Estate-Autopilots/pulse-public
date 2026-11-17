-- migrate:up
-- Private auth state is never granted to service roles. All entrypoints scope the tenant and actor.
create table pulse_priv.auth_key(org_id uuid primary key references pulse.org(id), key bytea not null);
create table pulse_priv.auth_account(org_id uuid not null references pulse.org(id), realm text not null check(realm in('staff','client')), actor uuid not null,
 delivery text, totp bytea, pending_totp bytea, recovery text[] not null default '{}', last_step bigint not null default -1,
 primary key(org_id,realm,actor));
create table pulse_priv.auth_link(org_id uuid not null references pulse.org(id), realm text not null, actor uuid not null, kind text not null check(kind in('reset','invite','email')),
 token_hash text unique not null check(token_hash~'^[a-f0-9]{64}$'), expires_at timestamptz not null, used_at timestamptz, delivery text,
 primary key(org_id,realm,actor,kind));
create table pulse_priv.auth_challenge(org_id uuid not null, realm text not null, actor uuid not null, hash text primary key,
 expires_at timestamptz not null, remember boolean not null, device text not null, used_at timestamptz);
create table pulse_priv.auth_event(org_id uuid not null, realm text not null, actor uuid, id uuid primary key default gen_random_uuid(),
 at timestamptz not null default now(), action text not null, device text);
create table pulse_priv.auth_policy(org_id uuid primary key references pulse.org(id), required boolean not null default false,
 grace_until timestamptz, exempt_owner uuid references pulse.person(id));
alter table pulse.login_session add column id uuid not null default gen_random_uuid(), add column device text not null default 'Browser',
 add column last_active_at timestamptz not null default now(), add column remembered boolean not null default false;
alter table pulse_priv.portal_session add column id uuid not null default gen_random_uuid(),add column created_at timestamptz not null default now(),
 add column device text not null default 'Browser',add column last_active_at timestamptz not null default now(),add column remembered boolean not null default false;
alter table pulse_priv.portal_principal add column delivery_email text,add column last_login_at timestamptz;
-- Serialize account mutations with authentication, including challenges created before a password reset.
create function pulse.auth_lock(r text,a uuid) returns void language sql volatile security definer set search_path=pulse,pg_temp as $$
 select pg_advisory_xact_lock(hashtextextended('auth:'||current_org()||':'||r||':'||a,0))
$$;
revoke all on function pulse.auth_lock(text,uuid) from public;
-- Separate auth history is also projected into the existing audit ledger. Never include capabilities or credentials.
create function pulse.auth_event_add(r text,a uuid,event text,d text default null) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 insert into pulse_priv.auth_event(org_id,realm,actor,action,device) values(current_org(),r,a,event,left(d,120));
 perform audit_write(event,r||'_auth',a::text);
end $$;
create function pulse.auth_delivery(r text,a uuid) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select delivery from pulse_priv.auth_account where org_id=current_org() and realm=r and actor=a),
 case when r='staff' then (select coalesce(nullif(pp.email,''),nullif(hc.personal_email,'')) from people_profile pp left join pulse_priv.hr_contact hc on hc.person_id=pp.person_id where pp.org_id=current_org() and pp.person_id=a)
 else (select delivery_email from pulse_priv.portal_principal where org_id=current_org() and id=a) end)
$$;
create function pulse.auth_manage(r text,a uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if r='staff' then
  if not viewer_is('admin','hr') or current_viewer() is null then raise exception 'HR or admin required' using errcode='42501';end if;
  if not exists(select 1 from person where org_id=current_org() and id=a and side='staff') then raise exception 'Person unavailable' using errcode='42501';end if;
  if not viewer_is('admin') and exists(select 1 from role_assignment where org_id=current_org() and person_id=a and role_key in('admin','leadership') and current_date between valid_from and coalesce(valid_to,'infinity')) then raise exception 'An admin manages leadership accounts' using errcode='42501';end if;
 else
  if not viewer_is('admin') or not exists(select 1 from pulse_priv.portal_principal where org_id=current_org() and id=a) then raise exception 'Admin required for client accounts' using errcode='42501';end if;
 end if;
end $$;
create function pulse.auth_end_sessions(r text,a uuid,except_hash text default '') returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if r='staff' then
  update login_session set revoked_at=now() where org_id=current_org() and person_id=a and revoked_at is null and token_hash<>except_hash;
  -- Native tokens must follow password changes and offboarding, too.
  update pulse_priv.native_token set revoked_at=now() where org_id=current_org() and person_id=a and revoked_at is null;
 else update pulse_priv.portal_session set revoked_at=now() where org_id=current_org() and principal_id=a and revoked_at is null and token_hash<>except_hash;
 end if;
 update pulse_priv.auth_challenge set used_at=now() where org_id=current_org() and realm=r and actor=a and used_at is null;
end $$;
create function pulse.auth_totp(secret bytea,step bigint) returns text language plpgsql immutable set search_path=public,pg_temp as $$
declare mac bytea:=hmac(int8send(step),secret,'sha1'); offset_n int; n bigint;
begin
 offset_n:=get_byte(mac,19)&15;
 n:=((get_byte(mac,offset_n)&127)::bigint<<24)|(get_byte(mac,offset_n+1)::bigint<<16)|(get_byte(mac,offset_n+2)::bigint<<8)|get_byte(mac,offset_n+3)::bigint;
 return lpad((n%1000000)::text,6,'0');
end $$;
create function pulse.auth_otp(r text,a uuid,code text,pending boolean default false) returns boolean language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare ac pulse_priv.auth_account%rowtype; key_hex text; secret bytea; step bigint:=floor(extract(epoch from clock_timestamp())/30); s bigint; h text;
begin
 select * into ac from pulse_priv.auth_account where org_id=current_org() and realm=r and actor=a for update;
 if not found or (case when pending then ac.pending_totp else ac.totp end) is null then return false;end if;
 if not pending then
  h:=encode(digest(lower(replace(trim(code),'-','')),'sha256'),'hex');
  if h=any(ac.recovery) then
   update pulse_priv.auth_account set recovery=array_remove(recovery,h) where org_id=current_org() and realm=r and actor=a;
   perform auth_event_add(r,a,'recovery_code_used');return true;
  end if;
 end if;
 if code !~ '^[0-9]{6}$' then return false;end if;
 select encode(key,'hex') into key_hex from pulse_priv.auth_key where org_id=current_org();
 secret:=pgp_sym_decrypt_bytea(case when pending then ac.pending_totp else ac.totp end,key_hex);
 for s in step-1..step+1 loop
  if s>ac.last_step and auth_totp(secret,s)=code then
   update pulse_priv.auth_account set last_step=s where org_id=current_org() and realm=r and actor=a;return true;
  end if;
 end loop;
 return false;
end $$;
create function pulse.auth_session(r text,a uuid,h text,remember boolean,d text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare expiry timestamptz:=now()+case when remember then interval '30 days' else interval '12 hours' end; need boolean;
begin
 if r='staff' then
  if not exists(select 1 from person p join login_credential l on l.person_id=p.id where p.org_id=current_org() and p.id=a and p.status='active' and l.status='active') then return null;end if;
  select must_change into need from login_credential where person_id=a;
  insert into login_session(org_id,person_id,token_hash,expires_at,device,remembered) values(current_org(),a,h,expiry,left(d,120),remember);
  update login_credential set last_login_at=now() where person_id=a;
  perform set_config('pulse.viewer_id',a::text,true);
 else
  if not exists(select 1 from pulse_priv.portal_principal where org_id=current_org() and id=a and active) then return null;end if;
  select must_change into need from pulse_priv.portal_principal where id=a;
  insert into pulse_priv.portal_session(org_id,principal_id,token_hash,expires_at,device,remembered) values(current_org(),a,h,expiry,left(d,120),remember);
  update pulse_priv.portal_principal set last_login_at=now() where id=a;
 end if;
 perform auth_event_add(r,a,'sign_in',d);
 return jsonb_build_object('expiresAt',expiry,'maxAge',case when remember then 2592000 else 43200 end,'mustChange',need);
end $$;
-- Login returns a short-lived second-factor challenge instead of a session when enrolled.
create function pulse.auth_login(r text,u text,p text,challenge_hash text,session_hash text,remember boolean,d text) returns jsonb language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare a uuid; known_actor uuid; ac record; result jsonb; last_seen timestamptz; pol pulse_priv.auth_policy%rowtype;
begin
 if r='staff' then
  select person_id into a from people_profile where org_id=current_org() and username=lower(trim(u));
  known_actor:=a;if a is not null then perform auth_lock(r,a);end if;
  select last_login_at into last_seen from login_credential where org_id=current_org() and person_id=a;
  select person_id into a from login_verify(u,p);
 else
  select id into a from pulse_priv.portal_principal where org_id=current_org() and username=lower(trim(u));
  known_actor:=a;if a is not null then perform auth_lock(r,a);end if;a:=null;
  select * into ac from pulse_priv.portal_principal where org_id=current_org() and username=lower(trim(u)) and active for update;
  if not found then perform crypt(left(p,72),gen_salt('bf',10));
  elsif ac.locked_until>now() or ac.must_change and ac.issued_at<now()-interval '7 days' or octet_length(p)>72 then perform crypt(left(p,72),gen_salt('bf',10));
  elsif ac.password_hash=crypt(p,ac.password_hash) then
   a:=ac.id;update pulse_priv.portal_principal set failed=0,locked_until=null where id=a;
  else
   update pulse_priv.portal_principal set failed=case when failed>=4 then 0 else failed+1 end,locked_until=case when failed>=4 then now()+interval '15 minutes' end where id=ac.id;
  end if;
 end if;
 if a is null then
  if r='staff' then select lc.person_id into a from login_credential lc join people_profile pp on pp.person_id=lc.person_id where lc.org_id=current_org() and pp.username=lower(trim(u)) and lc.locked_until between now()+interval '14 minutes 55 seconds' and now()+interval '15 minutes';
  else select id into a from pulse_priv.portal_principal where org_id=current_org() and username=lower(trim(u)) and locked_until between now()+interval '14 minutes 55 seconds' and now()+interval '15 minutes';end if;
  if a is not null and exists(select 1 from pulse_priv.auth_event where org_id=current_org() and realm=r and actor=a and action='account_locked' and at>now()-interval '15 minutes') then a:=null;end if;
  perform auth_event_add(r,coalesce(a,known_actor),case when a is null then 'sign_in_failed' else 'account_locked' end,d);
  return jsonb_build_object('failed',true,'actor',a,'delivery',case when a is not null then auth_delivery(r,a) end);
 end if;
 if exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm=r and actor=a and totp is not null) then
  if r='staff' then update login_credential set last_login_at=last_seen where org_id=current_org() and person_id=a;end if;
  insert into pulse_priv.auth_challenge values(current_org(),r,a,challenge_hash,now()+interval '5 minutes',remember,left(d,120),null);
  perform auth_event_add(r,a,'two_step_challenge',d);return jsonb_build_object('twoStep',true);
 end if;
 result:=auth_session(r,a,session_hash,remember,d);
 select * into pol from pulse_priv.auth_policy where org_id=current_org();
 if r='staff' and pol.required and a is distinct from pol.exempt_owner and exists(select 1 from role_assignment where org_id=current_org() and person_id=a and role_key in('admin','hr','leadership') and current_date between valid_from and coalesce(valid_to,'infinity')) then
  result:=result||jsonb_build_object('enrollmentRequired',true,'graceUntil',pol.grace_until);
 end if;
 return result||jsonb_build_object('actor',a,'delivery',auth_delivery(r,a));
end $$;
create function pulse.auth_challenge_finish(r text,h text,code text,session_hash text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare ch pulse_priv.auth_challenge%rowtype; result jsonb;
begin
 select actor into ch.actor from pulse_priv.auth_challenge where org_id=current_org() and realm=r and hash=h;
 if ch.actor is not null then perform auth_lock(r,ch.actor);end if;
 select * into ch from pulse_priv.auth_challenge where org_id=current_org() and realm=r and hash=h and expires_at>now() and used_at is null for update;
 if not found then return null;end if;
 if not auth_allow('otp:'||r||':'||ch.actor,5) or not auth_otp(r,ch.actor,code) then perform auth_event_add(r,ch.actor,'two_step_failed');return null;end if;
 update pulse_priv.auth_challenge set used_at=now() where hash=h;
 result:=auth_session(r,ch.actor,session_hash,ch.remember,ch.device);
 return result||jsonb_build_object('actor',ch.actor,'delivery',auth_delivery(r,ch.actor));
end $$;
-- One capability per account and purpose; replacement invalidates the old link atomically.
create function pulse.auth_link_make(r text,a uuid,k text,h text,email text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare u text; d text; expiry timestamptz:=now()+case when k='invite' then interval '7 days' else interval '60 minutes' end;
begin
 perform auth_lock(r,a);
 if r not in('staff','client') or k not in('invite','reset','email') or h !~ '^[a-f0-9]{64}$' then raise exception 'Invalid link request' using errcode='22023';end if;
 if r='staff' then
  select pp.username into u from person p join people_profile pp on pp.person_id=p.id where p.org_id=current_org() and p.id=a and p.side='staff' and p.status='active' and not exists(select 1 from login_credential where person_id=a and status='disabled');
 else select username into u from pulse_priv.portal_principal where org_id=current_org() and id=a and active;
 end if;
 if u is null then raise exception 'Account is unavailable or disabled' using errcode='22023';end if;
 d:=coalesce(email,auth_delivery(r,a));
 if k in('reset','invite') then update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm=r and actor=a and kind in('reset','invite');end if;
 insert into pulse_priv.auth_link values(current_org(),r,a,k,h,expiry,null,email)
 on conflict(org_id,realm,actor,kind) do update set token_hash=h,expires_at=expiry,used_at=null,delivery=email;
 if r='staff' and k in('reset','invite') then update pulse_priv.staff_invitation set token_hash=null,expires_at=null where org_id=current_org() and person_id=a and used_at is null;end if;
 perform auth_event_add(r,a,case when email is not null then 'email_confirmation_requested' else k||'_link_issued' end);
 return jsonb_build_object('actor',a,'username',u,'delivery',d,'expiresAt',expiry);
end $$;
create function pulse.auth_recover(r text,input text,k text,h text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid; u text; d text; n int;
begin
 if r='staff' then
  select count(*),min(p.id::text)::uuid into n,a from person p join people_profile pp on pp.person_id=p.id join login_credential lc on lc.person_id=p.id
  where p.org_id=current_org() and p.status='active' and p.side='staff' and lc.status='active' and (pp.username=lower(trim(input)) or lower(auth_delivery(r,p.id))=lower(trim(input)));
 else
  select count(*),min(id::text)::uuid into n,a from pulse_priv.portal_principal where org_id=current_org() and active and (username=lower(trim(input)) or lower(auth_delivery(r,id))=lower(trim(input)));
 end if;
 if n<>1 then perform auth_event_add(r,null,'recovery_requested');return null;end if;
 if not auth_allow('recovery-account:'||r||':'||a,3) then return null;end if;
 d:=auth_delivery(r,a);
 if r='staff' then select username into u from people_profile where person_id=a;else select username into u from pulse_priv.portal_principal where id=a;end if;
 perform auth_event_add(r,a,'recovery_requested');
 if d is null or d='' then
  if r='staff' and k='reset' then perform login_forgot(u);elsif r='client' and k='reset' then perform portal_forgot(u);end if;return null;
 end if;
 if k='username' then return jsonb_build_object('username',u,'delivery',d,'actor',a);end if;
 return auth_link_make(r,a,'reset',h);
end $$;
create function pulse.auth_redeem(r text,h text,password text,code text,session_hash text,d text) returns jsonb language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare link pulse_priv.auth_link%rowtype; a uuid; result jsonb;
begin
 select actor into a from pulse_priv.auth_link where org_id=current_org() and realm=r and token_hash=h;
 if a is null and r='staff' then select person_id into a from pulse_priv.staff_invitation where org_id=current_org() and token_hash=h;end if;
 if a is not null then perform auth_lock(r,a);end if;a:=null;
 select * into link from pulse_priv.auth_link where org_id=current_org() and realm=r and token_hash=h and kind in('reset','invite') and used_at is null and expires_at>now() for update;
 if not found then
  -- Existing seven-day invitations remain valid, but cannot bypass a previously enrolled factor.
  if r='staff' then
   select person_id into a from pulse_priv.staff_invitation where org_id=current_org() and token_hash=h and used_at is null and expires_at>now() and status in('prepared','sent') for update;
  end if;
  if a is null then perform auth_event_add(r,null,'reset_failed');return null;end if;
 else a:=link.actor;
 end if;
 if exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm=r and actor=a and totp is not null) and (not auth_allow('reset-otp:'||r||':'||a,5) or not auth_otp(r,a,code)) then
  perform auth_event_add(r,a,'reset_two_step_failed');return jsonb_build_object('twoStep',true);
 end if;
 if octet_length(password) not between 10 and 72 then return null;end if;
 if r='staff' then
  if not exists(select 1 from person where org_id=current_org() and id=a and status='active') or exists(select 1 from login_credential where org_id=current_org() and person_id=a and status='disabled') then return null;end if;
  insert into login_credential(org_id,person_id,password_hash,must_change) values(current_org(),a,crypt(password,gen_salt('bf',10)),false)
  on conflict(person_id) do update set password_hash=excluded.password_hash,must_change=false,failed_attempts=0,locked_until=null,issued_at=now();
  update password_reset_request set status='resolved',resolved_at=now() where org_id=current_org() and person_id=a and status='pending';
  update pulse_priv.staff_invitation set token_hash=null,status='used',used_at=now() where org_id=current_org() and person_id=a;
 else
  update pulse_priv.portal_principal set password_hash=crypt(password,gen_salt('bf',10)),must_change=false,failed=0,locked_until=null where org_id=current_org() and id=a and active;
  if not found then return null;end if;
  update pulse_priv.portal_reset set resolved_at=now() where org_id=current_org() and principal_id=a and resolved_at is null;
 end if;
 update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm=r and actor=a and kind in('reset','invite');
 perform auth_end_sessions(r,a);perform auth_event_add(r,a,'password_changed',d);
 result:=auth_session(r,a,session_hash,false,d);
 return result||jsonb_build_object('actor',a,'delivery',auth_delivery(r,a));
end $$;
create function pulse.auth_sessions(r text,a uuid,h text) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare sessions jsonb;
begin
 if r='staff' then
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'device',device,'lastActive',last_active_at,'expiresAt',expires_at,'remembered',remembered,'thisDevice',token_hash=h) order by last_active_at desc),'[]') into sessions from login_session where org_id=current_org() and person_id=a and revoked_at is null and expires_at>now();
  return sessions||coalesce((select jsonb_agg(jsonb_build_object('id',id,'device',name||' · Native app · '||platform,'lastActive',last_active,'expiresAt',expires,'remembered',true,'thisDevice',false)) from (
   select d.id,d.name,d.platform,max(t.at) last_active,max(t.refresh_until) expires from native_device d join pulse_priv.native_token t on t.device_id=d.id and t.org_id=d.org_id
   where d.org_id=current_org() and d.person_id=a and d.revoked_at is null and t.revoked_at is null and t.used_at is null and t.refresh_until>now() group by d.id,d.name,d.platform)x),'[]');
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'device',device,'lastActive',last_active_at,'expiresAt',expires_at,'remembered',remembered,'thisDevice',token_hash=h) order by last_active_at desc),'[]') from pulse_priv.portal_session where org_id=current_org() and principal_id=a and revoked_at is null and expires_at>now());
end $$;
revoke all on function pulse.auth_sessions(text,uuid,text) from public;

-- Authenticated account API, shared by staff and client principals, with separate identities and tables.
create function pulse.auth_account_action(r text,op text,b jsonb,current_hash text) returns jsonb language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare a uuid; ac pulse_priv.auth_account%rowtype; old_hash text; key_hex text; secret bytea; codes text[]; event text; result jsonb; link pulse_priv.auth_link%rowtype;
begin
 if r='staff' then a:=current_viewer();else a:=nullif(current_setting('pulse.portal_id',true),'')::uuid;end if;
 if a is null or r not in('staff','client') then raise exception 'Sign in required' using errcode='42501';end if;
 if op<>'state' then
  perform auth_lock(r,a);
  if r='staff' and not exists(select 1 from login_session where org_id=current_org() and person_id=a and token_hash=current_hash and revoked_at is null and expires_at>now())
  or r='client' and not exists(select 1 from pulse_priv.portal_session where org_id=current_org() and principal_id=a and token_hash=current_hash and revoked_at is null and expires_at>now()) then raise exception 'Your session has ended. Sign in again.' using errcode='42501';end if;
 end if;
 if op='state' then
  select * into ac from pulse_priv.auth_account where org_id=current_org() and realm=r and actor=a;
  return jsonb_build_object('delivery',auth_delivery(r,a),'twoStep',ac.totp is not null,'recoveryRemaining',coalesce(cardinality(ac.recovery),0),
   'sessions',auth_sessions(r,a,current_hash),
   'activity',(select coalesce(jsonb_agg(x),'[]') from (select action,at,device from pulse_priv.auth_event where org_id=current_org() and realm=r and actor=a order by at desc limit 30)x));
 end if;
 if op='sign-out-others' then perform auth_end_sessions(r,a,current_hash);perform auth_event_add(r,a,'other_sessions_ended');return jsonb_build_object('ok',true);end if;
 if op='session-end' then
  if r='staff' then update login_session set revoked_at=now() where org_id=current_org() and person_id=a and id=(b->>'id')::uuid and revoked_at is null;
   update pulse_priv.native_token set revoked_at=now() where org_id=current_org() and person_id=a and device_id=(b->>'id')::uuid and revoked_at is null;
  else update pulse_priv.portal_session set revoked_at=now() where org_id=current_org() and principal_id=a and id=(b->>'id')::uuid and revoked_at is null;end if;
  perform auth_event_add(r,a,'session_ended');return jsonb_build_object('ok',true);
 end if;
 -- All sensitive changes require the current password, with a persistent per-account rate limit.
 if not auth_allow('account-sensitive:'||r||':'||a,10) then return jsonb_build_object('error','Too many attempts. Try again in 15 minutes.');end if;
 if r='staff' then select password_hash into old_hash from login_credential where org_id=current_org() and person_id=a and status='active' for update;
 else select password_hash into old_hash from pulse_priv.portal_principal where org_id=current_org() and id=a and active for update;end if;
 if old_hash is null or octet_length(coalesce(b->>'current',''))>72 or old_hash<>crypt(coalesce(b->>'current',''),old_hash) then perform auth_event_add(r,a,'account_verification_failed');return jsonb_build_object('error','The current password is not right');end if;
 if op='change-password' then
  if b->>'current'=b->>'next' or octet_length(b->>'next') not between 10 and 72 then return jsonb_build_object('error','Choose a different password of 10 to 72 bytes');end if;
  if r='staff' then update login_credential set password_hash=crypt(b->>'next',gen_salt('bf',10)),must_change=false where person_id=a;
  else update pulse_priv.portal_principal set password_hash=crypt(b->>'next',gen_salt('bf',10)),must_change=false where id=a;end if;
  update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm=r and actor=a and kind in('reset','invite');
  update pulse_priv.staff_invitation set token_hash=null where r='staff' and org_id=current_org() and person_id=a;
  if coalesce((b->>'signOutOthers')::boolean,true) then perform auth_end_sessions(r,a,current_hash);end if;
  event:='password_changed';
 elsif op='email-start' then
  if b->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(b->>'email')>254 then return jsonb_build_object('error','Enter a delivery email address');end if;
  return auth_link_make(r,a,'email',b->>'hash',lower(b->>'email'));
 elsif op='totp-start' then
  if exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm=r and actor=a and totp is not null) then return jsonb_build_object('error','Two-step verification is already enabled');end if;
  insert into pulse_priv.auth_key values(current_org(),gen_random_bytes(32)) on conflict do nothing;
  select encode(key,'hex') into key_hex from pulse_priv.auth_key where org_id=current_org();secret:=gen_random_bytes(20);
  insert into pulse_priv.auth_account(org_id,realm,actor,pending_totp) values(current_org(),r,a,pgp_sym_encrypt_bytea(secret,key_hex))
  on conflict(org_id,realm,actor) do update set pending_totp=excluded.pending_totp,last_step=-1;
  perform auth_event_add(r,a,'two_step_setup_started');return jsonb_build_object('secretHex',encode(secret,'hex'));
 elsif op='totp-enable' then
  if not auth_otp(r,a,b->>'code',true) then perform auth_event_add(r,a,'two_step_setup_failed');return jsonb_build_object('error','Enter a fresh authenticator code');end if;
  codes:=array(select encode(gen_random_bytes(8),'hex') from generate_series(1,10));
  update pulse_priv.auth_account set totp=pending_totp,pending_totp=null,recovery=array(select encode(digest(c,'sha256'),'hex') from unnest(codes)c) where org_id=current_org() and realm=r and actor=a;
  perform auth_end_sessions(r,a,current_hash);perform auth_event_add(r,a,'two_step_enabled');return jsonb_build_object('recoveryCodes',codes);
 elsif op='totp-disable' then
  if not auth_otp(r,a,b->>'code') then perform auth_event_add(r,a,'two_step_disable_failed');return jsonb_build_object('error','Enter an authenticator or recovery code');end if;
  if r='staff' and exists(select 1 from pulse_priv.auth_policy where org_id=current_org() and required and a is distinct from exempt_owner) and exists(select 1 from role_assignment where org_id=current_org() and person_id=a and role_key in('admin','hr','leadership') and current_date between valid_from and coalesce(valid_to,'infinity')) then return jsonb_build_object('error','Two-step verification is required for this role');end if;
  update pulse_priv.auth_account set totp=null,pending_totp=null,recovery='{}' where org_id=current_org() and realm=r and actor=a;event:='two_step_disabled';
 else raise exception 'Unknown account action' using errcode='22023';
 end if;
 perform auth_event_add(r,a,event);return jsonb_build_object('ok',true,'actor',a,'delivery',auth_delivery(r,a));
end $$;
create function pulse.auth_email_confirm(r text,h text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l pulse_priv.auth_link%rowtype; old_email text;
begin
 select actor into l.actor from pulse_priv.auth_link where org_id=current_org() and realm=r and token_hash=h and kind='email';
 if l.actor is not null then perform auth_lock(r,l.actor);end if;
 select * into l from pulse_priv.auth_link where org_id=current_org() and realm=r and kind='email' and token_hash=h and used_at is null and expires_at>now() for update;
 if not found then return null;end if;
 if r='staff' and not exists(select 1 from person p join login_credential c on c.person_id=p.id where p.org_id=current_org() and p.id=l.actor and p.status='active' and c.status='active') or r='client' and not exists(select 1 from pulse_priv.portal_principal where org_id=current_org() and id=l.actor and active) then return null;end if;
 old_email:=auth_delivery(r,l.actor);
 insert into pulse_priv.auth_account(org_id,realm,actor,delivery) values(current_org(),r,l.actor,l.delivery) on conflict(org_id,realm,actor) do update set delivery=excluded.delivery;
 update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm=r and actor=l.actor and kind in('email','reset','invite');
 perform auth_event_add(r,l.actor,'delivery_email_changed');return jsonb_build_object('oldDelivery',old_email,'delivery',l.delivery,'actor',l.actor);
end $$;
create function pulse.auth_admin(r text,a uuid,op text,b jsonb) returns jsonb language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare result jsonb;
begin
 perform auth_manage(r,a);
 if op<>'history' then perform auth_lock(r,a);end if;
 if op='history' then return jsonb_build_object('delivery',auth_delivery(r,a),'activity',(select coalesce(jsonb_agg(x),'[]') from (select action,at,device from pulse_priv.auth_event where org_id=current_org() and realm=r and actor=a order by at desc limit 50)x)) || coalesce((select e from jsonb_array_elements(pulse.auth_admin_state(r)) e where e->>'id'=a::text),'{}');end if;
 if op in('reset','invite','copy') then
  if r='staff' then perform login_identity(a);end if;
  if op='copy' and coalesce(b->>'confirmed','')<>'true' then raise exception 'Confirm private link delivery first' using errcode='22023';end if;
  result:=auth_link_make(r,a,case when op='invite' then 'invite' else 'reset' end,b->>'hash');
  if op<>'copy' and coalesce(result->>'delivery','')='' then raise exception 'No delivery email. Use the private copy fallback' using errcode='22023';end if;
  if op='copy' then perform auth_event_add(r,a,'private_link_copied');end if;return result;
 end if;
 if op in('disable','two-step-reset') and a=current_viewer() then raise exception 'Ask another admin to review your account' using errcode='42501';end if;
 if op='disable' and exists(select 1 from pulse_priv.auth_policy where org_id=current_org() and exempt_owner=a) then raise exception 'Owner offboarding needs a successor first' using errcode='42501';end if;
 if op='disable' then
  if r='staff' then
   insert into login_credential(org_id,person_id,password_hash,must_change) values(current_org(),a,crypt(encode(gen_random_bytes(24),'hex'),gen_salt('bf',10)),true) on conflict do nothing;
   perform login_disable(a);else update pulse_priv.portal_principal set active=false where org_id=current_org() and id=a;end if;
  perform auth_end_sessions(r,a);update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm=r and actor=a;
  update pulse_priv.staff_invitation set token_hash=null where r='staff' and org_id=current_org() and person_id=a;
 elsif op='enable' then
  if r='staff' then
   if not exists(select 1 from person where org_id=current_org() and id=a and status='active') then raise exception 'Activate the staff record first' using errcode='22023';end if;
   update login_credential set status='active',failed_attempts=0,locked_until=null where org_id=current_org() and person_id=a;
  else update pulse_priv.portal_principal set active=true,failed=0,locked_until=null where org_id=current_org() and id=a;end if;
 elsif op='unlock' then
  if r='staff' then update login_credential set failed_attempts=0,locked_until=null where org_id=current_org() and person_id=a;
  else update pulse_priv.portal_principal set failed=0,locked_until=null where org_id=current_org() and id=a;end if;
 elsif op='sign-out-all' then perform auth_end_sessions(r,a);
 elsif op='two-step-reset' then
  if length(trim(coalesce(b->>'reason','')))<10 or coalesce(b->>'confirmed','')<>'true' then raise exception 'Confirm the identity check and give its reason' using errcode='22023';end if;
  update pulse_priv.auth_account set totp=null,pending_totp=null,recovery='{}' where org_id=current_org() and realm=r and actor=a;
  perform auth_end_sessions(r,a);
 else raise exception 'Unknown account action' using errcode='22023';end if;
 perform auth_event_add(r,a,'admin_'||op);return jsonb_build_object('ok',true);
end $$;
create function pulse.auth_admin_state(r text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if r='staff' then
  if not viewer_is('admin','hr') then raise exception 'HR or admin required' using errcode='42501';end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'delivery',auth_delivery(r,p.id),'lastLoginAt',lc.last_login_at,'twoStep',ac.totp is not null,
    'authStatus',case when lc.status='disabled' or p.status<>'active' then 'disabled' when lc.locked_until>now() then 'locked' when lc.status='active' and not lc.must_change then 'active'
     when coalesce(l.expires_at,i.expires_at)<now() then 'link expired' when l.used_at is null and l.token_hash is not null or i.used_at is null and i.token_hash is not null then 'invited' else 'not invited' end))
   from person p join people_profile pp on pp.person_id=p.id left join login_credential lc on lc.person_id=p.id
   left join pulse_priv.staff_invitation i on i.person_id=p.id left join pulse_priv.auth_link l on l.org_id=p.org_id and l.realm=r and l.actor=p.id and l.kind='invite'
   left join pulse_priv.auth_account ac on ac.org_id=p.org_id and ac.realm=r and ac.actor=p.id where p.org_id=current_org() and p.side='staff'),'[]');
 end if;
 if not viewer_is('admin') then raise exception 'Admin required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'username',p.username,'delivery',auth_delivery(r,p.id),'lastLoginAt',p.last_login_at,'authStatus',case when not p.active then 'disabled' when p.locked_until>now() then 'locked' when not p.must_change then 'active' when l.expires_at<now() then 'link expired' when l.used_at is null and l.token_hash is not null then 'invited' else 'not invited' end)) from pulse_priv.portal_principal p left join pulse_priv.auth_link l on l.org_id=p.org_id and l.realm=r and l.actor=p.id and l.kind='invite' where p.org_id=current_org()),'[]');
end $$;
create function pulse.auth_policy_save(b jsonb default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare p pulse_priv.auth_policy%rowtype;
begin
 if not viewer_is('admin') then raise exception 'Owner admin required' using errcode='42501';end if;
 if b is not null then
  -- The first owner to configure enforcement is permanently exempt until a deliberate succession migration.
  insert into pulse_priv.auth_policy values(current_org(),coalesce((b->>'required')::boolean,false),now()+interval '14 days',current_viewer())
  on conflict(org_id) do update set required=excluded.required,grace_until=case when not auth_policy.required and excluded.required then now()+interval '14 days' else auth_policy.grace_until end;
  perform auth_event_add('staff',current_viewer(),'two_step_policy_changed');
 end if;
 select * into p from pulse_priv.auth_policy where org_id=current_org();return jsonb_build_object('required',coalesce(p.required,false),'graceUntil',p.grace_until);
end $$;
create function pulse.auth_enforcement(a uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from pulse_priv.auth_policy where org_id=current_org() and required and grace_until<now() and a is distinct from exempt_owner)
 and exists(select 1 from role_assignment where org_id=current_org() and person_id=a and role_key in('admin','hr','leadership') and current_date between valid_from and coalesce(valid_to,'infinity'))
 and not exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm='staff' and actor=a and totp is not null)
$$;
-- Safe failed-login hints are identical for unknown, disabled and locked accounts. Equalize bcrypt work for locked rows.
do $$ declare def text;begin
 def:=pg_get_functiondef('pulse.login_verify(text,text)'::regprocedure);
 def:=replace(def,'then return;end if;', 'then perform crypt(left(p_password,72),gen_salt(''bf'',10));return;end if;');execute def;
end $$;
-- Disable always invalidates browser, native and pending challenges, including existing offboarding callers.
create function pulse.auth_credential_disabled() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.status='disabled' and old.status<>'disabled' then
  perform auth_end_sessions('staff',new.person_id);update pulse_priv.auth_link set used_at=now() where org_id=new.org_id and realm='staff' and actor=new.person_id;
 end if;return new;
end $$;
create trigger auth_credential_disabled after update of status on pulse.login_credential for each row execute function pulse.auth_credential_disabled();
-- Internal helpers are deliberately not callable by the API login.
revoke all on function pulse.auth_event_add(text,uuid,text,text),pulse.auth_delivery(text,uuid),pulse.auth_manage(text,uuid),pulse.auth_end_sessions(text,uuid,text),pulse.auth_totp(bytea,bigint),pulse.auth_otp(text,uuid,text,boolean),pulse.auth_session(text,uuid,text,boolean,text),pulse.auth_link_make(text,uuid,text,text,text),pulse.auth_credential_disabled() from public;
revoke all on function pulse.auth_login(text,text,text,text,text,boolean,text),pulse.auth_challenge_finish(text,text,text,text),pulse.auth_recover(text,text,text,text),pulse.auth_redeem(text,text,text,text,text,text),pulse.auth_account_action(text,text,jsonb,text),pulse.auth_email_confirm(text,text),pulse.auth_admin(text,uuid,text,jsonb),pulse.auth_admin_state(text),pulse.auth_policy_save(jsonb),pulse.auth_enforcement(uuid) from public;
grant execute on function pulse.auth_login(text,text,text,text,text,boolean,text),pulse.auth_challenge_finish(text,text,text,text),pulse.auth_recover(text,text,text,text),pulse.auth_redeem(text,text,text,text,text,text),pulse.auth_account_action(text,text,jsonb,text),pulse.auth_email_confirm(text,text),pulse.auth_admin(text,uuid,text,jsonb),pulse.auth_admin_state(text),pulse.auth_policy_save(jsonb),pulse.auth_enforcement(uuid) to pulse_api;
create table pulse_priv.auth_seen_device(org_id uuid not null,realm text not null,actor uuid not null,device text not null,device_id text not null, primary key(org_id,realm,actor,device_id));
create function pulse.auth_new_device(r text,a uuid,d text,device_id text) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 insert into pulse_priv.auth_seen_device values(current_org(),r,a,d,device_id) on conflict do nothing;return found;
end $$;
create function pulse.auth_mail_event(r text,a uuid,ok boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform auth_event_add(r,a,case when ok then 'security_email_sent' else 'security_email_failed' end);end $$;
revoke all on function pulse.auth_new_device(text,uuid,text,text),pulse.auth_mail_event(text,uuid,boolean) from public;
grant execute on function pulse.auth_new_device(text,uuid,text,text),pulse.auth_mail_event(text,uuid,boolean) to pulse_api;

create function pulse.auth_portal_touch(h text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin update pulse_priv.portal_session set last_active_at=now() where org_id=current_org() and token_hash=h and principal_id=nullif(current_setting('pulse.portal_id',true),'')::uuid and last_active_at<now()-interval '1 minute';end $$;
revoke all on function pulse.auth_portal_touch(text) from public;
grant execute on function pulse.auth_portal_touch(text) to pulse_api;
do $$ declare t text;begin
 foreach t in array array['auth_key','auth_account','auth_link','auth_challenge','auth_event','auth_policy','auth_seen_device'] loop
  execute format('alter table pulse_priv.%I enable row level security',t);
  execute format('alter table pulse_priv.%I force row level security',t);
  execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 end loop;
end $$;
create function pulse.auth_client_create(u text,n text,email text,h text) returns jsonb language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare a uuid;
begin
 if not viewer_is('admin') then raise exception 'Admin required for client accounts' using errcode='42501';end if;
 if coalesce(email,'')<>'' and email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid delivery email' using errcode='22023';end if;
 a:=portal_issue(null,u,n,encode(gen_random_bytes(24),'hex'));
 update pulse_priv.portal_principal set delivery_email=nullif(lower(email),'') where org_id=current_org() and id=a;
 return auth_link_make('client',a,'invite',h);
end $$;
revoke all on function pulse.auth_client_create(text,text,text,text) from public;
grant execute on function pulse.auth_client_create(text,text,text,text) to pulse_api;
create function pulse.auth_stuck() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin','hr','leadership') then raise exception 'HR or leadership required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'status',case when coalesce(l.expires_at,i.expires_at)<now() then 'link expired' else 'invited' end,'nextAction','Resend link'))
 from person p left join login_credential c on c.person_id=p.id left join pulse_priv.staff_invitation i on i.person_id=p.id and i.org_id=p.org_id
 left join pulse_priv.auth_link l on l.org_id=p.org_id and l.realm='staff' and l.actor=p.id and l.kind='invite'
 where p.org_id=current_org() and p.status='active' and coalesce(c.status,'active')='active' and (c.person_id is null or c.must_change)
 and (i.used_at is null and i.token_hash is not null or l.used_at is null and l.token_hash is not null)),'[]');
end $$;
revoke all on function pulse.auth_stuck() from public;
grant execute on function pulse.auth_stuck() to pulse_api;
create function pulse.auth_invitation_replaced() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.token_hash is not null and new.token_hash is distinct from old.token_hash then
  update pulse_priv.auth_link set used_at=now() where org_id=new.org_id and realm='staff' and actor=new.person_id and kind in('reset','invite');
 end if;return new;
end $$;
create trigger auth_invitation_replaced after update of token_hash on pulse_priv.staff_invitation for each row execute function pulse.auth_invitation_replaced();
revoke all on function pulse.auth_invitation_replaced() from public;
-- The legacy DB capability cannot bypass an authenticator enrolled through the new account flow.
do $$ declare def text;begin
 def:=pg_get_functiondef('pulse.invitation_redeem(text,text)'::regprocedure);
 def:=replace(def,'perform set_config(''pulse.viewer_id'',who::text,true);','if exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm=''staff'' and actor=who and totp is not null) then return null;end if; perform set_config(''pulse.viewer_id'',who::text,true);');
 execute def;
end $$;
-- Existing database-only and offboarding callers use the same account lock order.
do $$ declare signature text;def text;begin
 foreach signature in array array['pulse.login_disable(uuid)','pulse.login_issue(uuid,text)','pulse.login_change(text,text)','pulse.offboard_access()'] loop
  def:=pg_get_functiondef(signature::regprocedure);
  if signature='pulse.offboard_access()' then def:=replace(def,'begin','begin perform pulse.auth_lock(''staff'',new.id);');
  elsif signature='pulse.login_change(text,text)' then def:=replace(def,'begin','begin perform pulse.auth_lock(''staff'',pulse.current_viewer());');
  else def:=replace(def,'begin','begin perform pulse.auth_lock(''staff'',p_person);');end if;
  execute def;
 end loop;
end $$;
create function pulse.auth_logout(r text,h text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid;
begin
 if r='staff' then select person_id into a from login_session where org_id=current_org() and token_hash=h and revoked_at is null;
 elsif r='client' then select principal_id into a from pulse_priv.portal_session where org_id=current_org() and token_hash=h and revoked_at is null;end if;
 if a is null then return;end if;perform auth_lock(r,a);
 if r='staff' then update login_session set revoked_at=now() where org_id=current_org() and token_hash=h;
 else update pulse_priv.portal_session set revoked_at=now() where org_id=current_org() and token_hash=h;end if;
 perform auth_event_add(r,a,'sign_out');
end $$;
revoke all on function pulse.auth_logout(text,text) from public;
grant execute on function pulse.auth_logout(text,text) to pulse_api;
-- Native exchange/refresh share the revocation lock and recheck the originating browser session.
create function pulse.auth_native_issue(dev uuid,ah text,rh text,h text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform auth_lock('staff',current_viewer());
 if not exists(select 1 from login_session where org_id=current_org() and person_id=current_viewer() and token_hash=h and revoked_at is null and expires_at>now()) then raise exception 'Your session has ended' using errcode='42501';end if;
 return native_token_issue(dev,ah,rh);
end $$;
revoke all on function pulse.auth_native_issue(uuid,text,text,text) from public;
grant execute on function pulse.auth_native_issue(uuid,text,text,text) to pulse_api;
do $$ declare def text;begin
 def:=pg_get_functiondef('pulse.native_token_rotate(text,text,text)'::regprocedure);
 def:=replace(def,'begin','begin select person_id into t.person_id from pulse_priv.native_token where org_id=current_org() and refresh_hash=rh; if t.person_id is not null then perform pulse.auth_lock(''staff'',t.person_id);end if;');execute def;
end $$;
create index auth_event_actor_time on pulse_priv.auth_event(org_id,realm,actor,at desc);
create index auth_challenge_actor on pulse_priv.auth_challenge(org_id,realm,actor) where used_at is null;
create index login_session_account on pulse.login_session(org_id,person_id) where revoked_at is null;
create index portal_session_account on pulse_priv.portal_session(org_id,principal_id) where revoked_at is null;
-- migrate:down
