-- migrate:up
-- TWO-STEP-FACTORS (owner, 30 Oct 2026: "add a passkey adder ... two-step can also be an email code they get ... getting
-- in should be easy"): beside the authenticator app, a passkey (WebAuthn; the API verifies it with @simplewebauthn/server
-- and keeps only the public key here) or a 6-digit code e-mailed to the delivery address counts as the second step.
-- Backup codes cover all three. Staff only; client portal accounts keep the authenticator.
create table pulse_priv.auth_passkey (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null, realm text not null, actor uuid not null,
  credential_id text not null unique, public_key bytea not null, sign_count bigint not null default 0,
  transports text[] not null default '{}', name text not null default 'Passkey',
  created_at timestamptz not null default now(), last_used_at timestamptz);
create index auth_passkey_actor on pulse_priv.auth_passkey (org_id, realm, actor);
-- One WebAuthn challenge per ceremony, five minutes: adding a passkey (signed in) or the second step of a sign-in
-- (tied to that sign-in's challenge).
create table pulse_priv.auth_webauthn (
  org_id uuid not null, challenge text not null, realm text not null, actor uuid not null,
  purpose text not null check (purpose in ('register', 'two-step')), login_hash text,
  expires_at timestamptz not null default now() + interval '5 minutes', primary key (org_id, challenge));
alter table pulse_priv.auth_account add column email_factor boolean not null default false,
  add column email_code_hash text, add column email_code_expires timestamptz, add column email_code_tries int not null default 0;

-- Whether this person has a second step: an authenticator, a passkey, or e-mailed codes.
create function pulse.auth_second_factor(r text, a uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from pulse_priv.auth_account where org_id = current_org() and realm = r and actor = a and (totp is not null or email_factor))
      or exists (select 1 from pulse_priv.auth_passkey where org_id = current_org() and realm = r and actor = a)
$$;
revoke all on function pulse.auth_second_factor(text, uuid) from public;
grant execute on function pulse.auth_second_factor(text, uuid) to pulse_api;

-- The guided window asks (once the grace period has ended) until any second step is set up.
create or replace function pulse.auth_two_step_due(a uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from pulse_priv.auth_policy where org_id = current_org() and required and grace_until < now() and a is distinct from exempt_owner)
     and exists (select 1 from role_assignment where org_id = current_org() and person_id = a and role_key in ('admin', 'hr', 'leadership')
                  and current_date between valid_from and coalesce(valid_to, 'infinity'))
     and exists (select 1 from login_credential where org_id = current_org() and person_id = a and status = 'active')
     and not auth_second_factor('staff', a)
$$;

-- What the account page and the guided window show: each way to do the second step (never a secret).
create function pulse.auth_factors() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object(
    'authenticator', coalesce((select totp is not null from pulse_priv.auth_account where org_id = current_org() and realm = 'staff' and actor = current_viewer()), false),
    'emailCodes', coalesce((select email_factor from pulse_priv.auth_account where org_id = current_org() and realm = 'staff' and actor = current_viewer()), false),
    'delivery', auth_delivery('staff', current_viewer()) is not null,
    'passkeys', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'createdAt', created_at, 'lastUsedAt', last_used_at) order by created_at)
                            from pulse_priv.auth_passkey where org_id = current_org() and realm = 'staff' and actor = current_viewer()), '[]'))
  where current_viewer() is not null
$$;
revoke all on function pulse.auth_factors() from public;
grant execute on function pulse.auth_factors() to pulse_api;

-- Sign-in asks for the second step whoever has any of the three (it asked only those with an authenticator).
do $$ declare f text; def text; fixed text; begin
  foreach f in array array['pulse.auth_login(text,text,text,text,text,boolean,text)', 'pulse.google_sign_in(text,text,text,text,text)'] loop
    def := pg_get_functiondef(f::regprocedure);
    fixed := regexp_replace(def, 'if exists\(select 1 from pulse_priv\.auth_account where org_id=current_org\(\) and realm=(r|''staff'') and actor=a and totp is not null\) then',
                            'if auth_second_factor(\1,a) then');
    if fixed = def then raise exception '%: the two-step check was not found', f; end if;
    execute fixed;
  end loop;
end $$;

-- Starting a WebAuthn ceremony: for adding a passkey, the signed-in person; for a sign-in's second step, the person of
-- that waiting sign-in. Answers the person's names and the passkeys they already have.
create function pulse.auth_passkey_begin(r text, purpose text, p_login text, p_challenge text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a uuid; v_org uuid := current_org();
begin
  if r <> 'staff' then return null; end if;
  delete from pulse_priv.auth_webauthn where expires_at < now();
  if purpose = 'register' then a := current_viewer();
  elsif purpose = 'two-step' then
    select actor into a from pulse_priv.auth_challenge where org_id = v_org and realm = r and hash = p_login and expires_at > now() and used_at is null;
  end if;
  if a is null then return null; end if;
  if purpose = 'two-step' and not exists (select 1 from pulse_priv.auth_passkey where org_id = v_org and realm = r and actor = a) then return null; end if;
  insert into pulse_priv.auth_webauthn(org_id, challenge, realm, actor, purpose, login_hash) values (v_org, p_challenge, r, a, purpose, p_login);
  return jsonb_build_object('actor', a,
    'name', coalesce((select username from people_profile where org_id = v_org and person_id = a), 'pulse'),
    'display', coalesce((select display_name from person where org_id = v_org and id = a), 'Pulse'),
    'credentials', coalesce((select jsonb_agg(jsonb_build_object('id', credential_id, 'transports', to_jsonb(transports)))
                               from pulse_priv.auth_passkey where org_id = v_org and realm = r and actor = a), '[]'));
end $$;

-- Adding a verified passkey for the signed-in person (the API checked the WebAuthn answer against this challenge).
-- The first second step also makes the backup codes, shown once.
create function pulse.auth_passkey_add(r text, p_challenge text, cred jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare w pulse_priv.auth_webauthn%rowtype; codes text[]; have int;
begin
  select * into w from pulse_priv.auth_webauthn where org_id = current_org() and challenge = p_challenge and purpose = 'register' and expires_at > now() for update;
  if not found or w.actor is distinct from current_viewer() or w.realm <> r then return jsonb_build_object('error', 'This passkey request expired. Try again.'); end if;
  delete from pulse_priv.auth_webauthn where org_id = current_org() and challenge = p_challenge;
  if exists (select 1 from pulse_priv.auth_passkey where credential_id = cred->>'id') then return jsonb_build_object('error', 'This passkey is already added.'); end if;
  insert into pulse_priv.auth_passkey(org_id, realm, actor, credential_id, public_key, sign_count, transports, name)
  values (current_org(), r, w.actor, cred->>'id', decode(cred->>'publicKey', 'base64'), coalesce((cred->>'counter')::bigint, 0),
          coalesce(array(select jsonb_array_elements_text(coalesce(cred->'transports', '[]'))), '{}'), left(coalesce(nullif(btrim(cred->>'name'), ''), 'Passkey'), 60));
  insert into pulse_priv.auth_account(org_id, realm, actor) values (current_org(), r, w.actor) on conflict do nothing;
  select coalesce(cardinality(recovery), 0) into have from pulse_priv.auth_account where org_id = current_org() and realm = r and actor = w.actor;
  if have = 0 then
    codes := array(select encode(gen_random_bytes(8), 'hex') from generate_series(1, 10));
    update pulse_priv.auth_account set recovery = array(select encode(digest(c, 'sha256'), 'hex') from unnest(codes) c)
     where org_id = current_org() and realm = r and actor = w.actor;
  end if;
  perform auth_event_add(r, w.actor, 'passkey_added');
  return jsonb_build_object('ok', true) || case when codes is null then '{}'::jsonb else jsonb_build_object('recoveryCodes', to_jsonb(codes)) end;
end $$;

-- A sign-in's second step with a passkey: the stored key for that credential, only for the person of that waiting
-- sign-in and this ceremony's challenge.
create function pulse.auth_passkey_for(r text, p_challenge text, p_login text, p_credential text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare w pulse_priv.auth_webauthn%rowtype; k pulse_priv.auth_passkey%rowtype;
begin
  select * into w from pulse_priv.auth_webauthn where org_id = current_org() and challenge = p_challenge and purpose = 'two-step' and login_hash = p_login and expires_at > now();
  if not found then return null; end if;
  select * into k from pulse_priv.auth_passkey where org_id = current_org() and realm = r and actor = w.actor and credential_id = p_credential;
  if not found then return null; end if;
  return jsonb_build_object('publicKey', encode(k.public_key, 'base64'), 'counter', k.sign_count, 'transports', to_jsonb(k.transports));
end $$;

-- Finishing a sign-in with a verified passkey (as auth_challenge_finish does with a code).
create function pulse.auth_challenge_finish_passkey(r text, h text, p_challenge text, p_credential text, new_count bigint, session_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ch pulse_priv.auth_challenge%rowtype; result jsonb; n int;
begin
  delete from pulse_priv.auth_webauthn where org_id = current_org() and challenge = p_challenge and purpose = 'two-step' and login_hash = h;
  get diagnostics n = row_count; if n = 0 then return null; end if;
  select * into ch from pulse_priv.auth_challenge where org_id = current_org() and realm = r and hash = h and expires_at > now() and used_at is null for update;
  if not found then return null; end if;
  if ch.via = 'google' and not exists (select 1 from pulse_priv.google_identity i join pulse_priv.google_settings s using (org_id)
    where i.org_id = current_org() and i.person_id = ch.actor and s.enabled and i.domain = any(s.allowed_domains)) then return null; end if;
  update pulse_priv.auth_passkey set sign_count = greatest(sign_count, new_count), last_used_at = now()
   where org_id = current_org() and realm = r and actor = ch.actor and credential_id = p_credential;
  get diagnostics n = row_count; if n = 0 then return null; end if;
  update pulse_priv.auth_challenge set used_at = now() where hash = h;
  result := auth_session(r, ch.actor, session_hash, ch.remember, ch.device);
  if r = 'staff' and result is not null then
    update login_session set second_factor_verified = true, via = ch.via where org_id = current_org() and person_id = ch.actor and token_hash = session_hash;
  end if;
  perform auth_event_add(r, ch.actor, 'two_step_passkey');
  return result || jsonb_build_object('actor', ch.actor, 'delivery', auth_delivery(r, ch.actor));
end $$;

-- The ways a waiting sign-in can finish (the sign-in page shows only these).
create function pulse.auth_challenge_methods(r text, h text) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object(
    'authenticator', exists (select 1 from pulse_priv.auth_account ac where ac.org_id = current_org() and ac.realm = r and ac.actor = ch.actor and ac.totp is not null),
    'passkey', exists (select 1 from pulse_priv.auth_passkey k where k.org_id = current_org() and k.realm = r and k.actor = ch.actor),
    'email', exists (select 1 from pulse_priv.auth_account ac where ac.org_id = current_org() and ac.realm = r and ac.actor = ch.actor and ac.email_factor)
             and auth_delivery(r, ch.actor) is not null)
    from pulse_priv.auth_challenge ch where ch.org_id = current_org() and ch.realm = r and ch.hash = h and ch.expires_at > now() and ch.used_at is null
$$;

-- An e-mailed code for a waiting sign-in: at most three per 15 minutes, ten minutes long, five tries. The API sends it.
create function pulse.auth_email_code(r text, h text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare a uuid; d text; b bytea := gen_random_bytes(3); code text;
begin
  select actor into a from pulse_priv.auth_challenge where org_id = current_org() and realm = r and hash = h and expires_at > now() and used_at is null;
  if a is null or not exists (select 1 from pulse_priv.auth_account where org_id = current_org() and realm = r and actor = a and email_factor) then return null; end if;
  d := auth_delivery(r, a);
  if d is null then return null; end if;
  if not auth_allow('email-code:' || r || ':' || a, 3) then return jsonb_build_object('error', 'Three codes were sent in the last 15 minutes. Use the newest one, or a backup code.'); end if;
  code := lpad((((get_byte(b, 0) << 16) | (get_byte(b, 1) << 8) | get_byte(b, 2)) % 1000000)::text, 6, '0');
  update pulse_priv.auth_account set email_code_hash = encode(digest(code || ':' || h, 'sha256'), 'hex'), email_code_expires = now() + interval '10 minutes', email_code_tries = 0
   where org_id = current_org() and realm = r and actor = a;
  perform auth_event_add(r, a, 'email_code_sent');
  return jsonb_build_object('delivery', d, 'code', code, 'actor', a);
end $$;

-- Finishing a sign-in with the e-mailed code.
create function pulse.auth_challenge_finish_email(r text, h text, code text, session_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare ch pulse_priv.auth_challenge%rowtype; ac pulse_priv.auth_account%rowtype; result jsonb;
begin
  select * into ch from pulse_priv.auth_challenge where org_id = current_org() and realm = r and hash = h and expires_at > now() and used_at is null for update;
  if not found then return null; end if;
  select * into ac from pulse_priv.auth_account where org_id = current_org() and realm = r and actor = ch.actor for update;
  if not found or not ac.email_factor or ac.email_code_hash is null or ac.email_code_expires < now() or ac.email_code_tries >= 5 then return null; end if;
  if encode(digest(regexp_replace(coalesce(code, ''), '\D', '', 'g') || ':' || h, 'sha256'), 'hex') <> ac.email_code_hash then
    update pulse_priv.auth_account set email_code_tries = email_code_tries + 1 where org_id = current_org() and realm = r and actor = ch.actor;
    perform auth_event_add(r, ch.actor, 'two_step_failed');
    return null;
  end if;
  update pulse_priv.auth_account set email_code_hash = null, email_code_expires = null, email_code_tries = 0 where org_id = current_org() and realm = r and actor = ch.actor;
  update pulse_priv.auth_challenge set used_at = now() where hash = h;
  result := auth_session(r, ch.actor, session_hash, ch.remember, ch.device);
  if r = 'staff' and result is not null then
    update login_session set second_factor_verified = true, via = ch.via where org_id = current_org() and person_id = ch.actor and token_hash = session_hash;
  end if;
  perform auth_event_add(r, ch.actor, 'two_step_email');
  return result || jsonb_build_object('actor', ch.actor, 'delivery', auth_delivery(r, ch.actor));
end $$;

-- Backup codes work for people without an authenticator (a passkey or e-mailed codes only): auth_otp no longer stops
-- at a missing authenticator before it reads the backup codes; the 6-digit path still needs one.
do $$ declare def text := pg_get_functiondef('pulse.auth_otp(text,uuid,text,boolean)'::regprocedure); fixed text; begin
  fixed := replace(replace(def,
    ' if not found or (case when pending then ac.pending_totp else ac.totp end) is null then return false;end if;',
    ' if not found then return false;end if;'),
    ' if code !~ ''^[0-9]{6}$'' then return false;end if;',
    ' if code !~ ''^[0-9]{6}$'' or (case when pending then ac.pending_totp else ac.totp end) is null then return false;end if;');
  if position(' if not found then return false;end if;' in fixed) = 0
     or position('or (case when pending then ac.pending_totp else ac.totp end) is null then return false' in fixed) = 0 then
    raise exception 'auth_otp: the lines to change were not found'; end if;
  execute fixed;
end $$;

-- Account security (after the password check): e-mailed codes on or off, a passkey removed, and a passkey ceremony
-- allowed to start. Turning e-mail codes on needs a delivery address; the first second step makes the backup codes.
do $$ declare def text := pg_get_functiondef('pulse.auth_account_action'::regproc); fixed text; begin
  fixed := replace(def, ' elsif op=''totp-start'' then', ' elsif op=''passkey-begin'' then
  return jsonb_build_object(''ok'',true);
 elsif op=''passkey-remove'' then
  delete from pulse_priv.auth_passkey where org_id=current_org() and realm=r and actor=a and id::text=b->>''id'';
  perform auth_event_add(r,a,''passkey_removed'');return jsonb_build_object(''ok'',true);
 elsif op=''email-factor-on'' then
  if auth_delivery(r,a) is null then return jsonb_build_object(''error'',''Add a delivery email first: codes go there.'');end if;
  insert into pulse_priv.auth_account(org_id,realm,actor) values(current_org(),r,a) on conflict do nothing;
  update pulse_priv.auth_account set email_factor=true where org_id=current_org() and realm=r and actor=a;
  if coalesce((select cardinality(recovery) from pulse_priv.auth_account where org_id=current_org() and realm=r and actor=a),0)=0 then
   codes:=array(select encode(gen_random_bytes(8),''hex'') from generate_series(1,10));
   update pulse_priv.auth_account set recovery=array(select encode(digest(c,''sha256''),''hex'') from unnest(codes)c) where org_id=current_org() and realm=r and actor=a;
  end if;
  perform auth_event_add(r,a,''email_codes_on'');return jsonb_build_object(''ok'',true)||case when codes is null then ''{}''::jsonb else jsonb_build_object(''recoveryCodes'',codes) end;
 elsif op=''email-factor-off'' then
  update pulse_priv.auth_account set email_factor=false,email_code_hash=null where org_id=current_org() and realm=r and actor=a;
  perform auth_event_add(r,a,''email_codes_off'');return jsonb_build_object(''ok'',true);
 elsif op=''totp-start'' then');
  if fixed = def then raise exception 'auth_account_action: the totp-start branch was not found'; end if;
  execute fixed;
end $$;

revoke all on function pulse.auth_passkey_begin(text, text, text, text), pulse.auth_passkey_add(text, text, jsonb),
  pulse.auth_passkey_for(text, text, text, text), pulse.auth_challenge_finish_passkey(text, text, text, text, bigint, text),
  pulse.auth_challenge_methods(text, text), pulse.auth_email_code(text, text), pulse.auth_challenge_finish_email(text, text, text, text) from public;
grant execute on function pulse.auth_passkey_begin(text, text, text, text), pulse.auth_passkey_add(text, text, jsonb),
  pulse.auth_passkey_for(text, text, text, text), pulse.auth_challenge_finish_passkey(text, text, text, text, bigint, text),
  pulse.auth_challenge_methods(text, text), pulse.auth_email_code(text, text), pulse.auth_challenge_finish_email(text, text, text, text) to pulse_api;

-- migrate:down
do $$ declare f text; def text; begin
  foreach f in array array['pulse.auth_login(text,text,text,text,text,boolean,text)', 'pulse.google_sign_in(text,text,text,text,text)'] loop
    def := pg_get_functiondef(f::regprocedure);
    execute regexp_replace(def, 'if auth_second_factor\((r|''staff''),a\) then',
                           'if exists(select 1 from pulse_priv.auth_account where org_id=current_org() and realm=\1 and actor=a and totp is not null) then');
  end loop;
  def := pg_get_functiondef('pulse.auth_account_action'::regproc);
  execute regexp_replace(def, ' elsif op=''passkey-begin'' then.*? elsif op=''totp-start'' then', ' elsif op=''totp-start'' then');
  def := pg_get_functiondef('pulse.auth_otp(text,uuid,text,boolean)'::regprocedure);
  execute replace(replace(def, ' if not found then return false;end if;',
    ' if not found or (case when pending then ac.pending_totp else ac.totp end) is null then return false;end if;'),
    ' if code !~ ''^[0-9]{6}$'' or (case when pending then ac.pending_totp else ac.totp end) is null then return false;end if;',
    ' if code !~ ''^[0-9]{6}$'' then return false;end if;');
end $$;
create or replace function pulse.auth_two_step_due(a uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from pulse_priv.auth_policy where org_id = current_org() and required and grace_until < now() and a is distinct from exempt_owner)
     and exists (select 1 from role_assignment where org_id = current_org() and person_id = a and role_key in ('admin', 'hr', 'leadership')
                  and current_date between valid_from and coalesce(valid_to, 'infinity'))
     and exists (select 1 from login_credential where org_id = current_org() and person_id = a and status = 'active')
     and not exists (select 1 from pulse_priv.auth_account where org_id = current_org() and realm = 'staff' and actor = a and totp is not null)
$$;
drop function if exists pulse.auth_challenge_finish_email(text, text, text, text);
drop function if exists pulse.auth_email_code(text, text);
drop function if exists pulse.auth_challenge_methods(text, text);
drop function if exists pulse.auth_challenge_finish_passkey(text, text, text, text, bigint, text);
drop function if exists pulse.auth_passkey_for(text, text, text, text);
drop function if exists pulse.auth_passkey_add(text, text, jsonb);
drop function if exists pulse.auth_passkey_begin(text, text, text, text);
drop function if exists pulse.auth_factors();
drop function if exists pulse.auth_second_factor(text, uuid);
alter table pulse_priv.auth_account drop column if exists email_code_tries, drop column if exists email_code_expires,
  drop column if exists email_code_hash, drop column if exists email_factor;
drop table if exists pulse_priv.auth_webauthn;
drop table if exists pulse_priv.auth_passkey;
