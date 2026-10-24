-- migrate:up
-- PEOPLE-CONTACTS part 3 (owner, 11 Oct 2026): "account access like Google Admin: easily reset a password, or send a
-- one-time login link". HR and admins (pulse.auth_manage: an admin for leadership accounts) get, per person:
--  * a one-time sign-in link (kind 'signin'): sent by e-mail only on an explicit click, to the person's delivery
--    address; it works once, within 15 minutes, for an active account that already has a password, and still asks for
--    the authenticator code when two-step is on. Older sign-in links stop working; password links are untouched.
--  * the devices signed in (browser sessions and the Pulse apps) with the last sign-in, and revoking one device:
--    a browser session ends; an app device is unpaired and its tokens and windows end (it must pair again).
-- Every action is an auth_event (shown in the person's account history) and an audit_event.
alter table pulse_priv.auth_link drop constraint auth_link_kind_check;
alter table pulse_priv.auth_link add constraint auth_link_kind_check check (kind in ('reset','invite','email','signin'));

create or replace function pulse.auth_link_make(r text,a uuid,k text,h text,email text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare u text; d text; expiry timestamptz:=now()+case when k='invite' then interval '7 days' when k='signin' then interval '15 minutes' else interval '60 minutes' end;
begin
 perform auth_lock(r,a);
 if r not in('staff','client') or k not in('invite','reset','email','signin') or h !~ '^[a-f0-9]{64}$' then raise exception 'Invalid link request' using errcode='22023';end if;
 if r='staff' then
  select pp.username into u from person p join people_profile pp on pp.person_id=p.id where p.org_id=current_org() and p.id=a and p.side='staff' and p.status='active' and not exists(select 1 from login_credential where person_id=a and status='disabled');
 else select username into u from pulse_priv.portal_principal where org_id=current_org() and id=a and active;
 end if;
 if u is null then raise exception 'Account is unavailable or disabled' using errcode='22023';end if;
 if k='email' then perform auth_email_available(r,a,email);end if;
 d:=coalesce(email,auth_delivery(r,a));
 if k in('reset','invite') then update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm=r and actor=a and kind in('reset','invite');end if;
 insert into pulse_priv.auth_link values(current_org(),r,a,k,h,expiry,null,email)
 on conflict(org_id,realm,actor,kind) do update set token_hash=h,expires_at=expiry,used_at=null,delivery=email;
 if r='staff' and k in('reset','invite') then update pulse_priv.staff_invitation set token_hash=null,expires_at=null where org_id=current_org() and person_id=a and used_at is null;end if;
 perform auth_event_add(r,a,case when email is not null then 'email_confirmation_requested' else k||'_link_issued' end);
 return jsonb_build_object('actor',a,'username',u,'delivery',d,'expiresAt',expiry);
end $$;

-- What an admin sees of someone's devices: browser sessions and app devices, and where they last signed in.
create function pulse.auth_devices(r text,a uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('sessions',auth_sessions(r,a,''),
  'lastSignIn',(select jsonb_build_object('at',e.at,'device',e.device) from pulse_priv.auth_event e where e.org_id=current_org() and e.realm=r and e.actor=a and e.action in ('sign_in','signin_link_used') order by e.at desc limit 1),
  'twoStep',exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm=r and actor=a and totp is not null),
  'signinLink',(select jsonb_build_object('expiresAt',l.expires_at,'used',l.used_at is not null) from pulse_priv.auth_link l where l.org_id=current_org() and l.realm=r and l.actor=a and l.kind='signin' and l.expires_at>now()-interval '1 day'))
$$;

do $$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('pulse.auth_admin(text,uuid,text,jsonb)'::regprocedure);
 if position($r$ if op in('disable','two-step-reset') and a=current_viewer() then$r$ in definition)=0 or position($r$ if op='history' then return jsonb_build_object('delivery',auth_delivery(r,a),$r$ in definition)=0 then
  raise exception 'auth_admin changed shape'; end if;
 -- History carries the devices and the last sign-in; three new operations come before the account-state ones.
 changed:=replace(definition,$r$ if op='history' then return jsonb_build_object('delivery',auth_delivery(r,a),$r$,$r$ if op='history' then return auth_devices(r,a) || jsonb_build_object('delivery',auth_delivery(r,a),$r$);
 changed:=replace(changed,$r$ if op in('disable','two-step-reset') and a=current_viewer() then$r$,$r$ if op='signin' then
  -- A one-time sign-in link: for an active account with a password; the API e-mails it (never shown on screen).
  if r<>'staff' then raise exception 'Sign-in links are for staff accounts' using errcode='22023';end if;
  if exists(select 1 from login_credential where org_id=current_org() and person_id=a and status='disabled') then
   raise exception 'This account is suspended. Restore it first' using errcode='22023';end if;
  if not exists(select 1 from login_credential where org_id=current_org() and person_id=a and status='active') then
   raise exception 'This person has no password yet: send an invitation instead' using errcode='22023';end if;
  result:=auth_link_make(r,a,'signin',b->>'hash');
  if coalesce(result->>'delivery','')='' then raise exception 'No delivery email. Add or confirm one first' using errcode='22023';end if;
  return result;
 end if;
 if op='device-end' then
  -- One device: a browser session ends; a Pulse app device is unpaired (tokens and its windows end; it pairs again).
  if r='staff' and exists(select 1 from native_device where org_id=current_org() and id=(b->>'id')::uuid and person_id=a) then
   update pulse_priv.native_token set revoked_at=now() where org_id=current_org() and device_id=(b->>'id')::uuid and revoked_at is null;
   update login_session set revoked_at=now() where org_id=current_org() and native_device_id=(b->>'id')::uuid and revoked_at is null;
   update native_device set revoked_at=now(),paused=true,purposes='{}',push_token=null,consent_epoch=gen_random_uuid() where org_id=current_org() and id=(b->>'id')::uuid and revoked_at is null;
   perform auth_event_add(r,a,'admin_device_removed');
  elsif r='staff' then
   update login_session set revoked_at=now() where org_id=current_org() and person_id=a and id=(b->>'id')::uuid and revoked_at is null;
   if not found then raise exception 'That device is already signed out' using errcode='22023';end if;
   perform auth_event_add(r,a,'admin_session_ended');
  else
   update pulse_priv.portal_session set revoked_at=now() where org_id=current_org() and principal_id=a and id=(b->>'id')::uuid and revoked_at is null;
   if not found then raise exception 'That device is already signed out' using errcode='22023';end if;
   perform auth_event_add(r,a,'admin_session_ended');
  end if;
  return auth_devices(r,a);
 end if;
 if op in('disable','two-step-reset') and a=current_viewer() then$r$);
 execute changed;
end $$;

-- Redeeming a sign-in link: once, in time, for an active account; with two-step on, only with a fresh code (the link
-- stays usable for its 15 minutes until the code is right). Returns a session like a password sign-in.
create function pulse.auth_link_sign_in(r text,h text,code text,session_hash text,d text) returns jsonb language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare link pulse_priv.auth_link%rowtype; a uuid; result jsonb;
begin
 if r<>'staff' or h !~ '^[a-f0-9]{64}$' or session_hash !~ '^[a-f0-9]{64}$' then return null;end if;
 select actor into a from pulse_priv.auth_link where org_id=current_org() and realm=r and token_hash=h and kind='signin';
 if a is null then perform auth_event_add(r,null,'signin_link_failed');return null;end if;
 perform auth_lock(r,a);
 select * into link from pulse_priv.auth_link where org_id=current_org() and realm=r and token_hash=h and kind='signin' and used_at is null and expires_at>now() for update;
 if not found then perform auth_event_add(r,a,'signin_link_failed');return null;end if;
 if not exists(select 1 from person p join login_credential c on c.person_id=p.id where p.org_id=current_org() and p.id=a and p.status='active' and c.status='active') then
  perform auth_event_add(r,a,'signin_link_failed');return null;end if;
 if exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm=r and actor=a and totp is not null) then
  if coalesce(code,'')='' then return jsonb_build_object('twoStep',true);end if;
  if not auth_allow('signin-link-otp:'||r||':'||a,5) or not auth_otp(r,a,code) then perform auth_event_add(r,a,'signin_link_two_step_failed');return jsonb_build_object('twoStep',true,'failed',true);end if;
 end if;
 update pulse_priv.auth_link set used_at=now() where org_id=current_org() and realm=r and actor=a and kind='signin';
 update login_credential set failed_attempts=0,locked_until=null where org_id=current_org() and person_id=a;
 result:=auth_session(r,a,session_hash,false,d);
 if result is null then return null;end if;
 perform auth_event_add(r,a,'signin_link_used',d);
 return result||jsonb_build_object('actor',a,'delivery',auth_delivery(r,a));
end $$;

revoke all on function pulse.auth_devices(text,uuid),pulse.auth_link_sign_in(text,text,text,text,text) from public;
grant execute on function pulse.auth_link_sign_in(text,text,text,text,text) to pulse_api;

-- migrate:down
-- Forward-only.
