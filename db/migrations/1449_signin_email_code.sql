-- migrate:up
-- SIGNIN-CODE (owner, 2 Nov 2026: locked out at the sign-in page; "anyone with access to their work e-mail should get
-- in in a few clicks"): sign in with a 6-digit code e-mailed to the address on record instead of the password. Staff
-- only. The code is stored hashed (bound to the person), works once, for 10 minutes, and dies after five wrong tries; a
-- new code replaces the old one. Sending is rationed per person (one a minute, five an hour) here and per address in
-- the API, which answers the same whether or not anyone matched. The password lockout does not block it, and a code
-- sign-in clears the lockout. Disabled, inactive or offboarded people, and people whose organisation turned passwords
-- off for Google-linked accounts, get nothing. Two-step still applies to an authenticator or a passkey; e-mailed codes
-- as the second step go to this same mailbox, so the sign-in code covers them.
create table pulse_priv.auth_signin_code (
  org_id uuid not null references pulse.org(id), realm text not null check (realm = 'staff'), actor uuid not null,
  code_hash text, expires_at timestamptz, tries int not null default 0,
  last_sent timestamptz, hour_start timestamptz, hour_sent int not null default 0,
  primary key (org_id, realm, actor));
alter table pulse_priv.auth_signin_code enable row level security;
alter table pulse_priv.auth_signin_code force row level security;
create policy tenant on pulse_priv.auth_signin_code using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- Who a typed name means: the one active staff person with an active Pulse login whose username (with or without a
-- leading @) or e-mail on record it is (the match Forgot your password uses). Anyone else: null.
create function pulse.auth_signin_code_actor(r text, input text) returns uuid
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v text := lower(btrim(coalesce(input, ''))); n int; a uuid;
begin
  if r <> 'staff' or v = '' then return null; end if;
  if v ~ '^@[^@]+$' then v := substr(v, 2); end if;
  select count(*), min(p.id::text)::uuid into n, a from person p join people_profile pp on pp.person_id = p.id
    join login_credential lc on lc.org_id = p.org_id and lc.person_id = p.id
   where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' and lc.status = 'active'
     and (pp.username = v or lower(auth_delivery(r, p.id)) = v);
  return case when n = 1 then a end;
end $$;
revoke all on function pulse.auth_signin_code_actor(text, text) from public;

-- A new code for the person a typed name means: { code, delivery, username, actor } for the API to e-mail, or null
-- (no such person, no address on record, passwords off for them, or the ration used up). The API answers the same.
create function pulse.auth_signin_code_issue(r text, input text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare a uuid := auth_signin_code_actor(r, input); d text; s pulse_priv.auth_signin_code%rowtype; b bytea := gen_random_bytes(3); code text;
begin
  if a is null then perform auth_event_add(r, null, 'signin_code_requested'); return null; end if;
  perform auth_lock(r, a);
  d := auth_delivery(r, a);
  if d is null or d = '' or not google_password_allowed(a) then perform auth_event_add(r, a, 'signin_code_refused'); return null; end if;
  insert into pulse_priv.auth_signin_code(org_id, realm, actor) values (current_org(), r, a) on conflict do nothing;
  select * into s from pulse_priv.auth_signin_code where org_id = current_org() and realm = r and actor = a for update;
  if s.last_sent > now() - interval '1 minute' or (s.hour_start > now() - interval '1 hour' and s.hour_sent >= 5) then
    perform auth_event_add(r, a, 'signin_code_limited'); return null;
  end if;
  code := lpad((((get_byte(b, 0) << 16) | (get_byte(b, 1) << 8) | get_byte(b, 2)) % 1000000)::text, 6, '0');
  update pulse_priv.auth_signin_code set code_hash = encode(digest(code || ':' || a, 'sha256'), 'hex'),
         expires_at = now() + interval '10 minutes', tries = 0, last_sent = now(),
         hour_sent = case when hour_start > now() - interval '1 hour' then hour_sent + 1 else 1 end,
         hour_start = case when hour_start > now() - interval '1 hour' then hour_start else now() end
   where org_id = current_org() and realm = r and actor = a;
  perform auth_event_add(r, a, 'signin_code_sent');
  return jsonb_build_object('code', code, 'delivery', d, 'actor', a,
    'username', (select username from people_profile where org_id = current_org() and person_id = a));
end $$;

-- Signing in with the code: the session (as auth_login answers), { twoStep: true } when an authenticator or a passkey
-- still has to finish it (the waiting sign-in is challenge_hash, five minutes, as after a password), or null.
create function pulse.auth_signin_code_finish(r text, input text, code text, challenge_hash text, session_hash text, remember boolean, d text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare a uuid := auth_signin_code_actor(r, input); s pulse_priv.auth_signin_code%rowtype; result jsonb; pol pulse_priv.auth_policy%rowtype;
begin
  if a is null then perform auth_event_add(r, null, 'signin_code_failed', d); return null; end if;
  perform auth_lock(r, a);
  select * into s from pulse_priv.auth_signin_code where org_id = current_org() and realm = r and actor = a for update;
  if not found or s.code_hash is null or s.expires_at < now() or s.tries >= 5 then perform auth_event_add(r, a, 'signin_code_failed', d); return null; end if;
  if encode(digest(regexp_replace(coalesce(code, ''), '\D', '', 'g') || ':' || a, 'sha256'), 'hex') <> s.code_hash then
    -- The fifth wrong try kills the code: a new one has to be sent.
    update pulse_priv.auth_signin_code set tries = tries + 1, code_hash = case when tries + 1 >= 5 then null else code_hash end
     where org_id = current_org() and realm = r and actor = a;
    perform auth_event_add(r, a, 'signin_code_failed', d); return null;
  end if;
  update pulse_priv.auth_signin_code set code_hash = null, expires_at = null, tries = 0 where org_id = current_org() and realm = r and actor = a;
  if not google_password_allowed(a) then perform auth_event_add(r, a, 'signin_code_failed', d); return null; end if;
  -- The mailbox proved it is them: the password lockout ends.
  update login_credential set failed_attempts = 0, locked_until = null where org_id = current_org() and person_id = a;
  perform auth_event_add(r, a, 'signin_code_used', d);
  if exists (select 1 from pulse_priv.auth_account where org_id = current_org() and realm = r and actor = a and totp is not null)
     or exists (select 1 from pulse_priv.auth_passkey where org_id = current_org() and realm = r and actor = a) then
    insert into pulse_priv.auth_challenge values (current_org(), r, a, challenge_hash, now() + interval '5 minutes', remember, left(coalesce(d, ''), 120), null);
    perform auth_event_add(r, a, 'two_step_challenge', d);
    return jsonb_build_object('twoStep', true);
  end if;
  result := auth_session(r, a, session_hash, remember, d);
  if result is null then return null; end if;
  if exists (select 1 from pulse_priv.auth_account where org_id = current_org() and realm = r and actor = a and email_factor) then
    update login_session set second_factor_verified = true where org_id = current_org() and person_id = a and token_hash = session_hash;
  end if;
  select * into pol from pulse_priv.auth_policy where org_id = current_org();
  if pol.required and a is distinct from pol.exempt_owner and not auth_second_factor(r, a) and exists (select 1 from role_assignment where org_id = current_org()
       and person_id = a and role_key in ('admin', 'hr', 'leadership') and current_date between valid_from and coalesce(valid_to, 'infinity')) then
    result := result || jsonb_build_object('enrollmentRequired', true, 'graceUntil', pol.grace_until);
  end if;
  return result || jsonb_build_object('actor', a, 'delivery', auth_delivery(r, a));
end $$;

revoke all on function pulse.auth_signin_code_issue(text, text), pulse.auth_signin_code_finish(text, text, text, text, text, boolean, text) from public;
grant execute on function pulse.auth_signin_code_issue(text, text), pulse.auth_signin_code_finish(text, text, text, text, text, boolean, text) to pulse_api;

-- migrate:down
drop function if exists pulse.auth_signin_code_finish(text, text, text, text, text, boolean, text);
drop function if exists pulse.auth_signin_code_issue(text, text);
drop function if exists pulse.auth_signin_code_actor(text, text);
drop table if exists pulse_priv.auth_signin_code;
