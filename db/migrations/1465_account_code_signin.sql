-- migrate:up
-- ACCOUNT-CODE (owner, 2 Nov 2026: Pulse as a SaaS; a person who signed up, like a freelancer or someone with no
-- company yet, could not get in with an e-mailed code, which found only staff of the organisation the address belongs
-- to). Two things, both on the shared address (pulse.estateautopilots.com) and off on a company's own address unless
-- that company allows it (pulse_priv.auth_policy.personal_accounts; the API decides which address it is):
--
--  1. Sign in to a Pulse account with a 6-digit code e-mailed to the account's address. The same "E-mail me a sign-in
--     code" form: the server first looks for the staff person of this organisation (1449, unchanged), and only when
--     there is none for the one Pulse account the typed handle or e-mail means (the match account_sign_in makes). The
--     code is stored hashed (bound to the account), works once, for 10 minutes, dies after five wrong tries; one a
--     minute and five an hour per account (the API adds per address and per typed name), and the answer is the same
--     whether or not anything matched. Using it opens the account session exactly as account_sign_in does (via
--     'account', the organisation this address belongs to first, then the one used last), clears the account's
--     password lockout and confirms its address (email_confirmed_at and 1462's email_verified_at). Accounts whose seats sign in through an organisation (a company
--     password on a seat, the install's own staff, AI co-workers) are left to that organisation's own sign-in and its
--     rules (Google-only, two-step), as the account sign-in link does (1066 acct_link_ok); two-step on a seat refuses.
--  2. Passwordless sign-up: name, e-mail, a handle (suggested), an optional company. A code to the e-mail proves it;
--     then the account (address confirmed, a password only if one was chosen), its organisation (the company named, or
--     a personal workspace to start a company from later: account home, Start your own Pulse) and a session. An
--     address that already has an account gets a note to sign in instead of a code; the API answers the same.
-- Every step is written to pulse_priv.account_auth_event (global and owner-only like the account tables), and a code
-- sign-in also to the audit trail of the organisation it opens.

-- ------------------------------------------------------------------------------------------------ tables
create table pulse_priv.account_signin_code (
  account_id  uuid primary key references pulse_priv.pulse_account(id) on delete cascade,
  code_hash   text check (code_hash is null or length(code_hash) = 64),
  expires_at  timestamptz,
  tries       int not null default 0,
  last_sent   timestamptz,
  hour_start  timestamptz,
  hour_sent   int not null default 0
);
create table pulse_priv.account_signup_code (
  email       text primary key check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(email) <= 254),
  code_hash   text check (code_hash is null or length(code_hash) = 64),
  expires_at  timestamptz,
  tries       int not null default 0,
  last_sent   timestamptz,
  hour_start  timestamptz,
  hour_sent   int not null default 0
);
create table pulse_priv.account_auth_event (
  id          uuid primary key default gen_random_uuid(),
  at          timestamptz not null default now(),
  account_id  uuid references pulse_priv.pulse_account(id) on delete set null,
  action      text not null check (length(action) <= 40),
  device      text check (length(device) <= 120)
);
create index account_auth_event_account on pulse_priv.account_auth_event(account_id, at desc);
revoke all on pulse_priv.account_signin_code, pulse_priv.account_signup_code, pulse_priv.account_auth_event from public;

-- A company lets personal Pulse accounts sign up and sign in with a code at its own address (off unless it says so).
alter table pulse_priv.auth_policy add column personal_accounts boolean not null default false;

-- ------------------------------------------------------------------------------------------------ helpers
create function pulse.acct_event(p_account uuid, p_action text, p_device text default null) returns void
  language sql security definer set search_path = pulse, pg_temp as $$
  insert into pulse_priv.account_auth_event(account_id, action, device) values (p_account, p_action, left(p_device, 120))
$$;

-- Whether a company's own address takes personal accounts (its auth policy says so).
create function pulse.personal_accounts_allowed(p_org uuid) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ok boolean;
begin
  if p_org is null then return false; end if;
  perform acct_enter(p_org, null);
  select coalesce((select personal_accounts from pulse_priv.auth_policy where org_id = p_org), false) into ok;
  perform acct_leave();
  return ok;
end $$;

-- The one Pulse account a typed handle or e-mail means (account_sign_in's match: the account's handle or e-mail, or a
-- member's username or e-mail in any active organisation, each read under its own row security), or null: nobody, more
-- than one, or a staff person of this organisation (their own code, 1449, comes first).
create function pulse.acct_code_target(p_login text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l text := lower(btrim(coalesce(p_login, ''))); cand uuid[] := '{}'; x uuid[]; o record;
begin
  if l = '' or length(l) > 254 then return null; end if;
  if auth_signin_code_actor('staff', l) is not null then return null; end if;
  select coalesce(array_agg(pa.id), '{}') into cand from pulse_priv.pulse_account pa where pa.handle = ltrim(l, '@') or pa.email = l;
  for o in select org.id from org where org.status = 'active' loop
    perform acct_enter(o.id, null);
    select coalesce(array_agg(distinct am.account_id), '{}') into x from people_profile pp
      join pulse_priv.account_member am on am.person_id = pp.person_id and am.member_org = o.id
     where pp.org_id = o.id and (pp.username = l or lower(btrim(pp.email)) = l);
    perform acct_leave();
    cand := cand || x;
  end loop;
  select coalesce(array_agg(distinct u), '{}') into cand from unnest(cand) u;
  return case when cardinality(cand) = 1 then cand[1] end;
end $$;

-- An account a code may open: it has an address, at least one active organisation, and no seat that signs in through
-- its organisation (a company password, the install's own staff, an AI co-worker): those keep their organisation's rules.
create function pulse.acct_code_ok(p_account uuid) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m record; credentialed boolean;
begin
  if not exists (select 1 from pulse_priv.pulse_account where id = p_account and email is not null) then return false; end if;
  if not exists (select 1 from pulse_priv.account_member am join org o on o.id = am.member_org and o.status = 'active' where am.account_id = p_account) then return false; end if;
  for m in select member_org, person_id, kind from pulse_priv.account_member where account_id = p_account loop
    if m.kind = 'agent' or (m.kind = 'staff' and m.member_org = install_org()) then return false; end if;
    perform acct_enter(m.member_org, null);
    select exists (select 1 from login_credential lc where lc.org_id = m.member_org and lc.person_id = m.person_id) into credentialed;
    perform acct_leave();
    if credentialed then return false; end if;
  end loop;
  return true;
end $$;

-- A 6-digit code from 3 random bytes.
create function pulse.acct_code_make() returns text
  language plpgsql volatile set search_path = pulse, public, pg_temp as $$
declare b bytea := gen_random_bytes(3);
begin
  return lpad((((get_byte(b, 0) << 16) | (get_byte(b, 1) << 8) | get_byte(b, 2)) % 1000000)::text, 6, '0');
end $$;

-- ------------------------------------------------------------------------------------------------ 1. code sign-in
-- A new code for the account a typed name means: { code, delivery, handle, account } for the API to e-mail, or null
-- (nobody, a staff person here, an account that signs in through its organisation, or the ration used up).
create function pulse.account_code_issue(p_login text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare a uuid := acct_code_target(p_login); s pulse_priv.account_signin_code%rowtype; code text; acc pulse_priv.pulse_account%rowtype;
begin
  if a is null then perform acct_event(null, 'account_code_requested'); return null; end if;
  if not acct_code_ok(a) then perform acct_event(a, 'account_code_refused'); return null; end if;
  insert into pulse_priv.account_signin_code(account_id) values (a) on conflict do nothing;
  select * into s from pulse_priv.account_signin_code where account_id = a for update;
  if s.last_sent > now() - interval '1 minute' or (s.hour_start > now() - interval '1 hour' and s.hour_sent >= 5) then
    perform acct_event(a, 'account_code_limited'); return null;
  end if;
  code := acct_code_make();
  update pulse_priv.account_signin_code set code_hash = encode(digest(code || ':' || a, 'sha256'), 'hex'),
         expires_at = now() + interval '10 minutes', tries = 0, last_sent = now(),
         hour_sent = case when hour_start > now() - interval '1 hour' then hour_sent + 1 else 1 end,
         hour_start = case when hour_start > now() - interval '1 hour' then hour_start else now() end
   where account_id = a;
  perform acct_event(a, 'account_code_sent');
  select * into acc from pulse_priv.pulse_account where id = a;
  return jsonb_build_object('code', code, 'delivery', acc.email, 'handle', acc.handle, 'account', a);
end $$;

-- Signing in with the code: the account session (as account_sign_in answers), { failed, twoStep } when a seat uses
-- two-step, { failed, noOrg } when no organisation is open to it, or null (wrong, used, expired, five tries, nobody).
-- p_own: the organisation whose own address this is (null on the shared address): landed in first when the account
-- has a seat there.
create function pulse.account_code_finish(p_login text, p_code text, p_hash text, p_device text, p_own uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare a uuid := acct_code_target(p_login); s pulse_priv.account_signin_code%rowtype; acc pulse_priv.pulse_account%rowtype; target uuid; r jsonb;
begin
  if a is null then perform acct_event(null, 'account_code_failed', p_device); return null; end if;
  select * into s from pulse_priv.account_signin_code where account_id = a for update;
  if not found or s.code_hash is null or s.expires_at < now() or s.tries >= 5 then perform acct_event(a, 'account_code_failed', p_device); return null; end if;
  if encode(digest(regexp_replace(coalesce(p_code, ''), '\D', '', 'g') || ':' || a, 'sha256'), 'hex') <> s.code_hash then
    -- The fifth wrong try kills the code: a new one has to be sent.
    update pulse_priv.account_signin_code set tries = tries + 1, code_hash = case when tries + 1 >= 5 then null else code_hash end where account_id = a;
    perform acct_event(a, 'account_code_failed', p_device); return null;
  end if;
  update pulse_priv.account_signin_code set code_hash = null, expires_at = null, tries = 0 where account_id = a;
  if not acct_code_ok(a) then perform acct_event(a, 'account_code_failed', p_device); return null; end if;
  -- The mailbox proved it is them: the account's password lockout ends and its address counts as confirmed.
  update pulse_priv.pulse_account set failed = 0, locked_until = null, email_confirmed_at = coalesce(email_confirmed_at, now()),
         email_verified_at = coalesce(email_verified_at, now()), updated_at = now() where id = a;
  perform acct_event(a, 'account_code_used', p_device);
  if acct_two_step(a) then return jsonb_build_object('failed', true, 'twoStep', true); end if;
  select * into acc from pulse_priv.pulse_account where id = a;
  -- Only an organisation the account holds a seat in (acct_session checks the seat and that the person is active).
  for target in select am.member_org from pulse_priv.account_member am join org on org.id = am.member_org and org.status = 'active'
      where am.account_id = a order by coalesce(am.member_org = p_own, false) desc, (am.member_org = acc.last_org) desc, am.last_used_at desc nulls last loop
    r := acct_session(a, target, p_hash, p_device);
    if r is not null then
      perform acct_enter(target, (r ->> 'person')::uuid);
      perform audit_write('account_code_sign_in', 'person', r ->> 'person');
      perform acct_leave();
      return r;
    end if;
  end loop;
  return jsonb_build_object('failed', true, 'noOrg', true);
end $$;

-- ------------------------------------------------------------------------------------------------ 2. sign-up
-- What would stop this sign-up, before a code is sent (null: nothing). Never whether the e-mail has an account.
create function pulse.account_signup_problem(p jsonb) returns text
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@'));
  e text := lower(btrim(coalesce(p ->> 'email', ''))); o text := regexp_replace(btrim(coalesce(p ->> 'orgName', '')), '\s+', ' ', 'g');
begin
  if length(n) not between 2 and 120 then return 'Give your name'; end if;
  if e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e) > 254 then return 'Give your e-mail address'; end if;
  if h <> '' and h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then return 'A handle is 3 to 30 lower-case letters, digits, dots or underscores'; end if;
  if h <> '' and (exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h)) then return 'Someone already has @' || h || '. Choose another handle.'; end if;
  if o <> '' and length(o) not between 2 and 80 then return 'Give your company a name of 2 to 80 characters, or leave it empty'; end if;
  return null;
end $$;

-- A code for an address signing up: { code, delivery } to e-mail; { existing, delivery } when the address already has
-- an account (the API mails "sign in instead"); null when the ration is used up (one a minute, five an hour).
create function pulse.account_signup_code_issue(p_email text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare e text := lower(btrim(coalesce(p_email, ''))); s pulse_priv.account_signup_code%rowtype; code text; existing uuid;
begin
  if e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e) > 254 then raise exception 'Give your e-mail address' using errcode = '22023'; end if;
  insert into pulse_priv.account_signup_code(email) values (e) on conflict do nothing;
  select * into s from pulse_priv.account_signup_code where email = e for update;
  select id into existing from pulse_priv.pulse_account where email = e;
  if s.last_sent > now() - interval '1 minute' or (s.hour_start > now() - interval '1 hour' and s.hour_sent >= 5) then
    perform acct_event(existing, 'signup_code_limited'); return null;
  end if;
  code := case when existing is null then acct_code_make() end;
  update pulse_priv.account_signup_code set code_hash = case when code is null then null else encode(digest(code || ':' || e, 'sha256'), 'hex') end,
         expires_at = case when code is null then null else now() + interval '10 minutes' end, tries = 0, last_sent = now(),
         hour_sent = case when hour_start > now() - interval '1 hour' then hour_sent + 1 else 1 end,
         hour_start = case when hour_start > now() - interval '1 hour' then hour_start else now() end
   where email = e;
  if existing is not null then perform acct_event(existing, 'signup_code_existing'); return jsonb_build_object('existing', true, 'delivery', e); end if;
  perform acct_event(null, 'signup_code_sent');
  return jsonb_build_object('code', code, 'delivery', e);
end $$;

-- The code typed back: the account (address confirmed; a password only when p has one), its organisation (orgName, or a
-- personal workspace) and a session there, as account_signup answers, plus personal. Null: wrong, used, expired, five
-- tries, or no code for that address. Errors (handle taken, the address has an account) only after a right code.
create function pulse.account_signup_confirm(p jsonb, p_code text, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare e text := lower(btrim(coalesce(p ->> 'email', ''))); s pulse_priv.account_signup_code%rowtype; problem text; r jsonb;
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@'));
  o text := regexp_replace(btrim(coalesce(p ->> 'orgName', '')), '\s+', ' ', 'g'); personal boolean;
begin
  select * into s from pulse_priv.account_signup_code where email = e for update;
  if not found or s.code_hash is null or s.expires_at < now() or s.tries >= 5 then perform acct_event(null, 'signup_code_failed', p_device); return null; end if;
  if encode(digest(regexp_replace(coalesce(p_code, ''), '\D', '', 'g') || ':' || e, 'sha256'), 'hex') <> s.code_hash then
    update pulse_priv.account_signup_code set tries = tries + 1, code_hash = case when tries + 1 >= 5 then null else code_hash end where email = e;
    perform acct_event(null, 'signup_code_failed', p_device); return null;
  end if;
  problem := account_signup_problem(p);
  if problem is not null then raise exception '%', problem using errcode = case when problem like 'Someone already has%' then '23505' else '22023' end; end if;
  update pulse_priv.account_signup_code set code_hash = null, expires_at = null, tries = 0 where email = e;
  if h = '' then h := handle_suggest(n); end if;
  personal := o = '';
  -- No company yet: a personal workspace, where Start your own Pulse opens a company later.
  if personal then o := left(n, 70) || '''s Pulse'; end if;
  r := account_signup(jsonb_build_object('name', n, 'handle', h, 'email', e, 'orgName', o, 'password', nullif(p ->> 'password', '')), p_hash, p_device);
  -- The address is proven (1066's confirmed, 1462's verified: Start your own Pulse asks for it).
  update pulse_priv.pulse_account set email_confirmed_at = now(), email_verified_at = now() where email = e;
  perform acct_event((select id from pulse_priv.pulse_account where email = e), 'signup_code_used', p_device);
  return r || jsonb_build_object('personal', personal);
end $$;

revoke all on function pulse.acct_event(uuid, text, text), pulse.personal_accounts_allowed(uuid), pulse.acct_code_target(text), pulse.acct_code_ok(uuid),
  pulse.acct_code_make(), pulse.account_code_issue(text), pulse.account_code_finish(text, text, text, text, uuid), pulse.account_signup_problem(jsonb),
  pulse.account_signup_code_issue(text), pulse.account_signup_confirm(jsonb, text, text, text) from public;
grant execute on function pulse.personal_accounts_allowed(uuid), pulse.account_code_issue(text), pulse.account_code_finish(text, text, text, text, uuid),
  pulse.account_signup_problem(jsonb), pulse.account_signup_code_issue(text), pulse.account_signup_confirm(jsonb, text, text, text) to pulse_api;

-- migrate:down
drop function if exists pulse.account_signup_confirm(jsonb, text, text, text);
drop function if exists pulse.account_signup_code_issue(text);
drop function if exists pulse.account_signup_problem(jsonb);
drop function if exists pulse.account_code_finish(text, text, text, text, uuid);
drop function if exists pulse.account_code_issue(text);
drop function if exists pulse.acct_code_make();
drop function if exists pulse.acct_code_ok(uuid);
drop function if exists pulse.acct_code_target(text);
drop function if exists pulse.personal_accounts_allowed(uuid);
drop function if exists pulse.acct_event(uuid, text, text);
alter table pulse_priv.auth_policy drop column if exists personal_accounts;
drop table if exists pulse_priv.account_auth_event;
drop table if exists pulse_priv.account_signup_code;
drop table if exists pulse_priv.account_signin_code;
