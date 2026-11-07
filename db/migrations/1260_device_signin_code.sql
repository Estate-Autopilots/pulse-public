-- migrate:up
-- MOBILE-READY (owner, 27 Oct 2026): "Sign in this device". A signed-in admin makes a one-time code (a 6-digit code
-- and a QR link) under Settings → Devices → Add a test device. A phone (the Pulse app's sign-in → "Sign in with a code
-- from another device") uses it within 10 minutes to sign in as that same admin. One live code per admin, used once,
-- cancellable, audited (auth_event + audit), and the session it makes is an ordinary device in the devices list, so it
-- is revoked there like any other. No password travels and no login is hard-coded anywhere. Only admins, and only for
-- their own account. Two-step accounts still give their authenticator code on the phone.
create table pulse_priv.device_signin_code(
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references pulse.org(id),
 actor uuid not null references pulse.person(id),
 code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
 token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '10 minutes',
 used_at timestamptz,
 used_device text,
 cancelled_at timestamptz);
create index device_signin_code_live on pulse_priv.device_signin_code(org_id,code_hash) where used_at is null and cancelled_at is null;
alter table pulse_priv.device_signin_code enable row level security;
revoke all on table pulse_priv.device_signin_code from public;

create function pulse.device_code_is_admin(a uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from role_assignment where org_id=current_org() and person_id=a and role_key='admin'
   and current_date between valid_from and coalesce(valid_to,'infinity'))
$$;

-- The signed-in admin makes a code for their own account (any earlier live code of theirs is cancelled).
create function pulse.device_code_create(p_code text,p_token text,d text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid:=current_viewer(); row pulse_priv.device_signin_code%rowtype;
begin
 if a is null or not device_code_is_admin(a) then raise exception 'Admin required' using errcode='42501';end if;
 if p_code !~ '^[a-f0-9]{64}$' or p_token !~ '^[a-f0-9]{64}$' then raise exception 'Bad code' using errcode='22023';end if;
 if not exists(select 1 from person p join login_credential l on l.person_id=p.id where p.org_id=current_org() and p.id=a and p.status='active' and l.status='active') then
  return jsonb_build_object('error','Your account has no Pulse password yet, so it cannot sign in another device. Set a password in Settings → Security first.');end if;
 if exists(select 1 from pulse_priv.device_signin_code where org_id=current_org() and code_hash=p_code and used_at is null and cancelled_at is null and expires_at>now()) then
  return jsonb_build_object('retry',true);end if;
 update pulse_priv.device_signin_code set cancelled_at=now() where org_id=current_org() and actor=a and used_at is null and cancelled_at is null;
 insert into pulse_priv.device_signin_code(org_id,actor,code_hash,token_hash) values(current_org(),a,p_code,p_token) returning * into row;
 perform auth_event_add('staff',a,'device_code_created',d);
 return jsonb_build_object('id',row.id,'expiresAt',row.expires_at);
end $$;

-- The admin's own live code (for the dialog after a reload), never the code itself.
create function pulse.device_code_live() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select jsonb_build_object('id',id,'expiresAt',expires_at) from pulse_priv.device_signin_code
   where org_id=current_org() and actor=current_viewer() and used_at is null and cancelled_at is null and expires_at>now() order by created_at desc limit 1),'null'::jsonb)
$$;

create function pulse.device_code_cancel(i uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid:=current_viewer();
begin
 if a is null or not device_code_is_admin(a) then raise exception 'Admin required' using errcode='42501';end if;
 update pulse_priv.device_signin_code set cancelled_at=now() where org_id=current_org() and id=i and actor=a and used_at is null and cancelled_at is null;
 if found then perform auth_event_add('staff',a,'device_code_cancelled');end if;
 return jsonb_build_object('ok',true);
end $$;

-- The phone redeems a code (typed) or a QR token. Public route, limited per address and per company in the API.
create function pulse.device_code_sign_in(p_code text,p_token text,otp text,session_hash text,d text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare row pulse_priv.device_signin_code%rowtype; result jsonb;
begin
 if session_hash !~ '^[a-f0-9]{64}$' or (coalesce(p_code,'') !~ '^[a-f0-9]{64}$' and coalesce(p_token,'') !~ '^[a-f0-9]{64}$') then return null;end if;
 select * into row from pulse_priv.device_signin_code where org_id=current_org() and used_at is null and cancelled_at is null and expires_at>now()
   and (token_hash=p_token or code_hash=p_code) order by created_at desc limit 1 for update;
 if not found then perform auth_event_add('staff',null,'device_code_failed',d);return null;end if;
 if not device_code_is_admin(row.actor) then
  update pulse_priv.device_signin_code set cancelled_at=now() where id=row.id;
  perform auth_event_add('staff',row.actor,'device_code_failed',d);return null;end if;
 perform auth_lock('staff',row.actor);
 if exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm='staff' and actor=row.actor and totp is not null) then
  if coalesce(otp,'')='' then return jsonb_build_object('twoStep',true);end if;
  if not auth_allow('device-code-otp:'||row.actor,5) or not auth_otp('staff',row.actor,otp) then
   perform auth_event_add('staff',row.actor,'device_code_two_step_failed',d);return jsonb_build_object('twoStep',true,'failed',true);end if;
 end if;
 update pulse_priv.device_signin_code set used_at=now(),used_device=left(d,120) where id=row.id;
 result:=auth_session('staff',row.actor,session_hash,true,d);
 if result is null then return null;end if;
 perform auth_event_add('staff',row.actor,'device_code_used',d);
 return result;
end $$;

revoke all on function pulse.device_code_is_admin(uuid),pulse.device_code_create(text,text,text),pulse.device_code_live(),pulse.device_code_cancel(uuid),
 pulse.device_code_sign_in(text,text,text,text,text) from public;
grant execute on function pulse.device_code_create(text,text,text),pulse.device_code_live(),pulse.device_code_cancel(uuid),
 pulse.device_code_sign_in(text,text,text,text,text) to pulse_api;

-- migrate:down
-- Forward-only.
