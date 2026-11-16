-- migrate:up
-- LOGIN-OTP (1585; owner, 6 Nov 2026: "Everyone, including me, is able to log in with our emails, with one-time login, just by
-- putting it in there ... they can select their own username as well"). After the 5 Nov account merge, "E-mail me a
-- sign-in code" answered "sent" for the owner's Gmail and Vitals addresses but nothing went out: 1465's acct_code_ok
-- refused every account with a staff seat in the install's own organisation or a company password on any seat, and the
-- addresses of the accounts merged away were gone (only the kept account's e-mail survived). Now:
--  1. Linked sign-in e-mails (pulse_priv.account_login_email): a merge keeps the dropped account's *verified* e-mail as a
--     sign-in e-mail of the kept account (account_merge wraps 1535's, account_unmerge takes it back), and
--     account_login_email_restore adds them from the records of a merge run before this. A code asked for with a linked
--     e-mail goes to that e-mail and signs in to that account. No other account can take the address.
--  2. The policy is explicit and per company: pulse_priv.auth_policy.email_codes (default on): "people here may sign in
--     with a code e-mailed to them". Off, the company's seats keep its own sign-in: its staff code (1449) is off and no
--     account holding a seat there gets an account code. Google-only for linked people (google_password_allowed) still
--     holds per seat. The blanket "install staff" and "has a company password" refusals are gone; for an account with a
--     company password the code goes only to a verified address or to the work e-mail that company has for the seat.
--  3. Same answer either way (the API), the same per-account ration (one a minute, five an hour), five tries, ten minutes.
--     The account's own e-mail counts as confirmed after a code only when the code went to it.
--  4. The @handle: account_claim keeps the old handle reserved for the account (as a merge does), refuses reserved
--     names, and lets a person take back a handle of their own.

-- ------------------------------------------------------------------------------------------------ 1. linked e-mails
create table pulse_priv.account_login_email (
  email       text primary key check (email ~ '^[^[:space:]@A-Z]+@[^[:space:]@A-Z]+\.[^[:space:]@A-Z]+$' and length(email) <= 254),
  account_id  uuid not null references pulse_priv.pulse_account(id) on delete cascade,
  verified_at timestamptz not null,
  source      text not null check (source in ('merge', 'restore')),
  created_at  timestamptz not null default now()
);
create index account_login_email_account on pulse_priv.account_login_email(account_id);
revoke all on pulse_priv.account_login_email from public;

-- An address is one account's: no account takes an e-mail another account signs in with.
create function pulse.acct_login_email_guard() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.email is not null and exists (select 1 from pulse_priv.account_login_email where email = lower(btrim(new.email)) and account_id <> new.id) then
    raise exception 'This e-mail already signs in to a Pulse account. Sign in with an e-mailed code instead.' using errcode = '23505';
  end if;
  return new;
end $$;
create trigger pulse_account_login_email_guard before insert or update of email on pulse_priv.pulse_account
  for each row execute function pulse.acct_login_email_guard();

-- The code ration and what was sent to: the account's e-mail is confirmed by a code only when the code went there.
alter table pulse_priv.account_signin_code add column sent_to text check (sent_to is null or length(sent_to) <= 254);

-- A merge keeps the dropped account's verified e-mail as a sign-in e-mail of the kept account (1535's merge is the core).
alter function pulse.account_merge(uuid, uuid, text, text, text) rename to acct_merge_core;
alter function pulse.account_unmerge(jsonb, text) rename to acct_unmerge_core;

create function pulse.account_merge(p_keep uuid, p_drop uuid, p_handle text, p_actor text, p_same_org text default 'refuse')
  returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d pulse_priv.pulse_account%rowtype; k pulse_priv.pulse_account%rowtype; rec jsonb; e text; linked text := null;
begin
  select * into d from pulse_priv.pulse_account where id = p_drop;
  select * into k from pulse_priv.pulse_account where id = p_keep;
  rec := acct_merge_core(p_keep, p_drop, p_handle, p_actor, p_same_org);
  e := lower(btrim(coalesce(d.email, '')));
  if e <> '' and coalesce(d.email_verified_at, d.email_confirmed_at) is not null and not coalesce((rec ->> 'email_moved')::boolean, false)
     and e is distinct from lower(btrim(coalesce(k.email, ''))) then
    insert into pulse_priv.account_login_email(email, account_id, verified_at, source)
    values (e, p_keep, coalesce(d.email_verified_at, d.email_confirmed_at), 'merge') on conflict (email) do nothing;
    if found then linked := e; end if;
  end if;
  return rec || jsonb_build_object('login_email', linked);
end $$;

create function pulse.account_unmerge(p_record jsonb, p_actor text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare e text := lower(btrim(coalesce(p_record #>> '{drop_account,email}', '')));
begin
  -- The e-mail goes back to the returning account (a record from before LOGIN-OTP has no login_email: same e-mail).
  delete from pulse_priv.account_login_email where email = e and account_id = (p_record ->> 'keep')::uuid and source in ('merge', 'restore');
  return acct_unmerge_core(p_record, p_actor);
end $$;

-- Merges run before this one: their records (pulse-accounts.py's records-apply-*.json, or one record) give the dropped
-- accounts' verified e-mails back to the kept accounts as sign-in e-mails. Run by the operator; repeatable.
create function pulse.account_login_email_restore(p_records jsonb, p_actor text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r jsonb; list jsonb; e text; v timestamptz; keep uuid; done jsonb := '[]'; skipped jsonb := '[]';
begin
  if coalesce(btrim(p_actor), '') = '' then raise exception 'account_login_email_restore: say who runs it (actor)' using errcode = '22023'; end if;
  list := case when jsonb_typeof(p_records) = 'array' then p_records when p_records ? 'records' then p_records -> 'records' else jsonb_build_array(p_records) end;
  for r in select * from jsonb_array_elements(list) loop
    if r ->> 'contract' is distinct from 'pulse-account-merge.v1' then continue; end if;
    keep := (r ->> 'keep')::uuid;
    e := lower(btrim(coalesce(r #>> '{drop_account,email}', '')));
    v := coalesce((r #>> '{drop_account,email_verified_at}')::timestamptz, (r #>> '{drop_account,email_confirmed_at}')::timestamptz);
    if e = '' or v is null or coalesce((r ->> 'email_moved')::boolean, false) then skipped := skipped || to_jsonb(coalesce(nullif(e, ''), '(none)') || ': not verified, none or moved'); continue; end if;
    if not exists (select 1 from pulse_priv.pulse_account where id = keep) then skipped := skipped || to_jsonb(e || ': kept account gone'); continue; end if;
    if exists (select 1 from pulse_priv.pulse_account where lower(btrim(email)) = e) then skipped := skipped || to_jsonb(e || ': an account has it'); continue; end if;
    insert into pulse_priv.account_login_email(email, account_id, verified_at, source) values (e, keep, v, 'restore') on conflict (email) do nothing;
    if found then
      done := done || to_jsonb(e);
      perform acct_event(keep, 'login_email_linked');
    else
      skipped := skipped || to_jsonb(e || ': already linked');
    end if;
  end loop;
  return jsonb_build_object('linked', done, 'skipped', skipped, 'actor', left(p_actor, 300));
end $$;

-- ------------------------------------------------------------------------------------------------ 2. company policy
alter table pulse_priv.auth_policy add column email_codes boolean not null default true;

-- Whether a company lets its people sign in with an e-mailed code (no policy row: yes).
create function pulse.org_email_codes(p_org uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select email_codes from pulse_priv.auth_policy where org_id = p_org), true)
$$;

-- 1449's staff match, now also off where the company turned e-mail codes off.
create or replace function pulse.auth_signin_code_actor(r text, input text) returns uuid
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v text := lower(btrim(coalesce(input, ''))); n int; a uuid;
begin
  if r <> 'staff' or v = '' then return null; end if;
  if not org_email_codes(current_org()) then return null; end if;
  if v ~ '^@[^@]+$' then v := substr(v, 2); end if;
  select count(*), min(p.id::text)::uuid into n, a from person p join people_profile pp on pp.person_id = p.id
    join login_credential lc on lc.org_id = p.org_id and lc.person_id = p.id
   where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' and lc.status = 'active'
     and (pp.username = v or lower(auth_delivery(r, p.id)) = v);
  return case when n = 1 then a end;
end $$;

-- The one Pulse account a typed handle or e-mail means: 1465's match (the account's handle or e-mail, a member's username
-- or e-mail in any active organisation), plus its linked sign-in e-mails and the handles it kept (a merge, a rename).
-- Null: nobody, more than one, or a staff person of this organisation (their own code, 1449, comes first).
create or replace function pulse.acct_code_target(p_login text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l text := lower(btrim(coalesce(p_login, ''))); cand uuid[] := '{}'; x uuid[]; o record;
begin
  if l = '' or length(l) > 254 then return null; end if;
  if auth_signin_code_actor('staff', l) is not null then return null; end if;
  select coalesce(array_agg(pa.id), '{}') into cand from pulse_priv.pulse_account pa where pa.handle = ltrim(l, '@') or lower(pa.email) = l;
  cand := cand || coalesce((select array_agg(account_id) from pulse_priv.account_login_email where email = l), '{}')
               || coalesce((select array_agg(h.ref) from pulse_priv.handle_name h join pulse_priv.pulse_account pa on pa.id = h.ref
                             where h.handle = ltrim(l, '@') and h.kind = 'person'), '{}');
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

-- An account a code may open: it has somewhere to send it, at least one active organisation, no AI co-worker seat, and
-- every organisation it holds a seat in allows e-mail codes for that seat (the company's email_codes, and Google-only for
-- people linked to Google). A refusal anywhere refuses the account: a code-opened account session can switch to any of
-- its organisations, so each company's rule has to hold before the code goes out.
create or replace function pulse.acct_code_ok(p_account uuid) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m record; allowed boolean;
begin
  if not exists (select 1 from pulse_priv.pulse_account where id = p_account and email is not null)
     and not exists (select 1 from pulse_priv.account_login_email where account_id = p_account) then return false; end if;
  if not exists (select 1 from pulse_priv.account_member am join org o on o.id = am.member_org and o.status = 'active' where am.account_id = p_account) then return false; end if;
  for m in select member_org, person_id, kind from pulse_priv.account_member where account_id = p_account loop
    if m.kind = 'agent' then return false; end if;
    perform acct_enter(m.member_org, null);
    select org_email_codes(m.member_org) and google_password_allowed(m.person_id) into allowed;
    perform acct_leave();
    if not allowed then return false; end if;
  end loop;
  return true;
end $$;

-- Where a code for this account goes, given what was typed: the linked sign-in e-mail typed, else the account's own e-mail.
-- An account with a company password on a seat gets it only at a verified address, or at the work e-mail that company
-- has for the seat (the address its own staff code, 1449, would use). Null: nowhere safe.
create function pulse.acct_code_delivery(p_account uuid, p_login text) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l text := lower(btrim(coalesce(p_login, ''))); acc pulse_priv.pulse_account%rowtype; e text; m record; credentialed boolean := false; work_match boolean := false; c boolean; w text;
begin
  if exists (select 1 from pulse_priv.account_login_email where email = l and account_id = p_account) then return l; end if;
  select * into acc from pulse_priv.pulse_account where id = p_account;
  e := lower(btrim(coalesce(acc.email, '')));
  if e = '' then return null; end if;
  if coalesce(acc.email_verified_at, acc.email_confirmed_at) is not null then return e; end if;
  for m in select member_org, person_id from pulse_priv.account_member where account_id = p_account loop
    perform acct_enter(m.member_org, null);
    select exists (select 1 from login_credential lc where lc.org_id = m.member_org and lc.person_id = m.person_id and lc.status = 'active') into c;
    w := case when c then lower(btrim(coalesce(auth_delivery('staff', m.person_id), ''))) end;
    perform acct_leave();
    if c then credentialed := true; if w = e then work_match := true; end if; end if;
  end loop;
  return case when not credentialed or work_match then e end;
end $$;

-- ------------------------------------------------------------------------------------------------ 3. issue and finish
create or replace function pulse.account_code_issue(p_login text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare a uuid := acct_code_target(p_login); s pulse_priv.account_signin_code%rowtype; code text; acc pulse_priv.pulse_account%rowtype; d text;
begin
  if a is null then perform acct_event(null, 'account_code_requested'); return null; end if;
  if not acct_code_ok(a) then perform acct_event(a, 'account_code_refused'); return null; end if;
  d := acct_code_delivery(a, p_login);
  if d is null then perform acct_event(a, 'account_code_refused'); return null; end if;
  insert into pulse_priv.account_signin_code(account_id) values (a) on conflict do nothing;
  select * into s from pulse_priv.account_signin_code where account_id = a for update;
  if s.last_sent > now() - interval '1 minute' or (s.hour_start > now() - interval '1 hour' and s.hour_sent >= 5) then
    perform acct_event(a, 'account_code_limited'); return null;
  end if;
  code := acct_code_make();
  update pulse_priv.account_signin_code set code_hash = encode(digest(code || ':' || a, 'sha256'), 'hex'),
         expires_at = now() + interval '10 minutes', tries = 0, last_sent = now(), sent_to = d,
         hour_sent = case when hour_start > now() - interval '1 hour' then hour_sent + 1 else 1 end,
         hour_start = case when hour_start > now() - interval '1 hour' then hour_start else now() end
   where account_id = a;
  perform acct_event(a, 'account_code_sent');
  select * into acc from pulse_priv.pulse_account where id = a;
  return jsonb_build_object('code', code, 'delivery', d, 'handle', acc.handle, 'account', a);
end $$;

create or replace function pulse.account_code_finish(p_login text, p_code text, p_hash text, p_device text, p_own uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare a uuid := acct_code_target(p_login); s pulse_priv.account_signin_code%rowtype; acc pulse_priv.pulse_account%rowtype; target uuid; r jsonb; own_mail boolean;
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
  -- The company rules still hold, and the address the code went to is still one a code may go to (a company password
  -- given to a seat since: only a verified or work address).
  if not acct_code_ok(a) or (s.sent_to is not null and acct_code_delivery(a, s.sent_to) is distinct from s.sent_to) then
    perform acct_event(a, 'account_code_failed', p_device); return null;
  end if;
  select * into acc from pulse_priv.pulse_account where id = a;
  -- The mailbox proved it is them: the password lockout ends; the account's own address counts as confirmed only when
  -- the code went there (a code from before LOGIN-OTP has no sent_to: it went there).
  own_mail := s.sent_to is null or s.sent_to = lower(btrim(coalesce(acc.email, '')));
  update pulse_priv.pulse_account set failed = 0, locked_until = null,
         email_confirmed_at = case when own_mail then coalesce(email_confirmed_at, now()) else email_confirmed_at end,
         email_verified_at = case when own_mail then coalesce(email_verified_at, now()) else email_verified_at end, updated_at = now() where id = a;
  perform acct_event(a, 'account_code_used', p_device);
  if acct_two_step(a) then return jsonb_build_object('failed', true, 'twoStep', true); end if;
  select * into acc from pulse_priv.pulse_account where id = a;
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

-- ------------------------------------------------------------------------------------------------ 4. the @handle
-- Names nobody takes as a handle (people would read them as Pulse speaking).
create function pulse.handle_reserved(p_handle text) returns boolean
  language sql immutable set search_path = pulse, pg_temp as $$
  select lower(coalesce(p_handle, '')) = any (array['admin', 'administrator', 'root', 'system', 'support', 'help', 'helpdesk', 'pulse',
    'vitals', 'official', 'security', 'billing', 'abuse', 'postmaster', 'webmaster', 'noreply', 'no.reply', 'no_reply', 'api', 'www',
    'mail', 'login', 'signin', 'signup', 'account', 'accounts', 'settings', 'orgs', 'everyone', 'staff', 'owner', 'team', 'null', 'undefined'])
$$;

-- 0920's claim, keeping the old handle reserved for the account (as a merge does: @old still means this person), refusing
-- reserved names, and letting a person go back to a handle that is already theirs.
create or replace function pulse.account_claim(p_handle text, p_password text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare v uuid; h text := lower(ltrim(btrim(coalesce(p_handle, '')), '@')); cur text;
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if h <> '' and h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  v := account_ensure();
  select handle into cur from pulse_priv.pulse_account where id = v;
  if h <> '' and h <> cur then
    if handle_reserved(h) then raise exception '@% is reserved. Choose another handle.', h using errcode = '23505'; end if;
    if exists (select 1 from pulse_priv.handle_name where handle = h and not (kind = 'person' and ref = v)) or exists (select 1 from org where handle = h) then
      raise exception 'Someone already has @%', h using errcode = '23505'; end if;
    insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v) on conflict do nothing;
    update pulse_priv.pulse_account set handle = h, updated_at = now() where id = v;
    update pulse_priv.org_invite set to_handle = h where to_handle = cur and status = 'open';
    perform acct_event(v, 'handle_changed');
  end if;
  if coalesce(p_password, '') <> '' then
    update pulse_priv.pulse_account set password_hash = crypt(p_password, gen_salt('bf', 10)), failed = 0, locked_until = null, updated_at = now() where id = v;
  end if;
  return account_me();
end $$;

-- The sign-up "is this @handle free?" also says reserved names are taken.
create or replace function pulse.handle_check(p_handle text) returns text
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare h text := lower(ltrim(btrim(coalesce(p_handle, '')), '@'));
begin
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then return 'invalid'; end if;
  if handle_reserved(h) or exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h)
     or exists (select 1 from pulse_priv.pulse_account where handle = h) then return 'taken'; end if;
  return 'available';
end $$;

-- 1465's sign-up check, with the reserved names.
create or replace function pulse.account_signup_problem(p jsonb) returns text
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@'));
  e text := lower(btrim(coalesce(p ->> 'email', ''))); o text := regexp_replace(btrim(coalesce(p ->> 'orgName', '')), '\s+', ' ', 'g');
begin
  if length(n) not between 2 and 120 then return 'Give your name'; end if;
  if e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e) > 254 then return 'Give your e-mail address'; end if;
  if h <> '' and h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then return 'A handle is 3 to 30 lower-case letters, digits, dots or underscores'; end if;
  if h <> '' and (handle_reserved(h) or exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h)) then return 'Someone already has @' || h || '. Choose another handle.'; end if;
  if o <> '' and length(o) not between 2 and 80 then return 'Give your company a name of 2 to 80 characters, or leave it empty'; end if;
  return null;
end $$;

revoke all on function pulse.acct_login_email_guard(), pulse.account_merge(uuid, uuid, text, text, text), pulse.account_unmerge(jsonb, text),
  pulse.account_login_email_restore(jsonb, text), pulse.org_email_codes(uuid), pulse.acct_code_delivery(uuid, text), pulse.handle_reserved(text) from public;
revoke all on function pulse.acct_merge_core(uuid, uuid, text, text, text), pulse.acct_unmerge_core(jsonb, text) from public;

-- ------------------------------------------------------------------------------------------------ 5. two-step at the shared address
-- AC-MERGE (owner, 6 Nov 2026: Datup must sign in at app.vitalsos.ai "one click simple as it is as it was before"): an
-- account with an authenticator on a seat was refused at the shared address ("use your organisation's own address").
-- Now the right password (or e-mailed code) opens a five-minute account challenge, and the authenticator (or a backup)
-- code of that seat finishes it: the same per-person try limit as the company's own two-step (auth_allow 'otp:staff:',
-- five a quarter hour, shared with it), single use, then the account session as account_sign_in opens it (30 days,
-- remembered), marked as two-step verified.
create table pulse_priv.account_challenge (
  hash        text primary key check (length(hash) = 64),
  account_id  uuid not null references pulse_priv.pulse_account(id) on delete cascade,
  org_id      uuid not null references pulse.org(id) on delete cascade,
  person_id   uuid not null,
  own_org     uuid,
  device      text check (length(device) <= 120),
  expires_at  timestamptz not null,
  used_at     timestamptz
);
create index account_challenge_account on pulse_priv.account_challenge(account_id);
revoke all on pulse_priv.account_challenge from public;

-- A challenge for an account whose seat uses an authenticator: the seat whose code is asked (the organisation of this
-- address first, then the one used last). False: no such seat.
create function pulse.acct_challenge_begin(p_account uuid, p_challenge text, p_device text, p_own uuid) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m record; acc pulse_priv.pulse_account%rowtype; yes boolean;
begin
  if p_challenge is null or length(p_challenge) <> 64 then return false; end if;
  select * into acc from pulse_priv.pulse_account where id = p_account;
  for m in select am.member_org, am.person_id from pulse_priv.account_member am join org on org.id = am.member_org and org.status = 'active'
      where am.account_id = p_account order by coalesce(am.member_org = p_own, false) desc, (am.member_org = acc.last_org) desc, am.last_used_at desc nulls last loop
    perform acct_enter(m.member_org, null);
    select exists (select 1 from pulse_priv.auth_account where org_id = m.member_org and realm = 'staff' and actor = m.person_id and totp is not null) into yes;
    perform acct_leave();
    if yes then
      delete from pulse_priv.account_challenge where account_id = p_account and (used_at is not null or expires_at < now());
      insert into pulse_priv.account_challenge(hash, account_id, org_id, person_id, own_org, device, expires_at)
      values (p_challenge, p_account, m.member_org, m.person_id, p_own, left(p_device, 120), now() + interval '5 minutes');
      perform acct_event(p_account, 'account_two_step_asked', p_device);
      return true;
    end if;
  end loop;
  return false;
end $$;

-- The authenticator (or backup) code for an account challenge: the account session (as account_sign_in answers), or null
-- (wrong, used, expired, too many tries).
create function pulse.account_two_step_finish(p_challenge text, p_code text, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare ch pulse_priv.account_challenge%rowtype; ok boolean; acc pulse_priv.pulse_account%rowtype; target uuid; r jsonb;
begin
  select * into ch from pulse_priv.account_challenge where hash = p_challenge for update;
  if not found or ch.used_at is not null or ch.expires_at < now() then return null; end if;
  perform acct_enter(ch.org_id, null);
  perform auth_lock('staff', ch.person_id);
  ok := auth_allow('otp:staff:' || ch.person_id, 5) and auth_otp('staff', ch.person_id, coalesce(p_code, ''));
  if not ok then perform auth_event_add('staff', ch.person_id, 'two_step_failed'); end if;
  perform acct_leave();
  if not ok then perform acct_event(ch.account_id, 'account_two_step_failed', p_device); return null; end if;
  update pulse_priv.account_challenge set used_at = now() where hash = p_challenge;
  update pulse_priv.pulse_account set failed = 0, locked_until = null where id = ch.account_id;
  select * into acc from pulse_priv.pulse_account where id = ch.account_id;
  perform acct_event(ch.account_id, 'account_two_step_used', p_device);
  for target in select am.member_org from pulse_priv.account_member am join org on org.id = am.member_org and org.status = 'active'
      where am.account_id = ch.account_id order by coalesce(am.member_org = ch.own_org, false) desc, (am.member_org = acc.last_org) desc, am.last_used_at desc nulls last loop
    r := acct_session(ch.account_id, target, p_hash, coalesce(p_device, ch.device));
    if r is not null then
      perform acct_enter(target, (r ->> 'person')::uuid);
      update login_session set second_factor_verified = true where org_id = target and token_hash = p_hash;
      perform audit_write('account_two_step_sign_in', 'person', r ->> 'person');
      perform acct_leave();
      return r;
    end if;
  end loop;
  return jsonb_build_object('failed', true, 'noOrg', true);
end $$;

-- The account sign-in with a challenge: where it said "two-step: use your organisation's own address", it opens an
-- account challenge (p_challenge, the hash of what the API hands back) and answers { twoStep, challenge }. The 4-argument
-- form stays as it was. LAND-CAPTAIN (6 Nov 2026): the body is WL-MOVE's (1569 account_sign_in_first_account), not
-- 1442's, so staff with a password and no Pulse account still get their account on the first right sign-in here too
-- (the API calls this 5-argument form); only the two-step branch differs.
create function pulse.account_sign_in(p_login text, p_password text, p_hash text, p_device text, p_challenge text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare own uuid := (select d.org_id from org_domain d where d.org_id = nullif(current_setting('pulse.org_id', true), '')::uuid limit 1);
  l text := lower(btrim(coalesce(p_login, ''))); cand uuid[] := '{}'; x uuid[]; o record; a pulse_priv.pulse_account%rowtype;
  cid uuid; hit uuid; hits int := 0; locked boolean := false; matched jsonb; hit_match jsonb; m record; target uuid; r jsonb; members int;
  lone_org uuid[] := '{}'; lone_person uuid[] := '{}'; y uuid[]; pid uuid; i int; new_org uuid; new_person uuid;
  nu_username text; nu_email text; nu_name text; h text;
begin
  if l = '' or coalesce(p_password, '') = '' or octet_length(p_password) > 72 then perform crypt('x', gen_salt('bf', 10)); return null; end if;
  select coalesce(array_agg(pa.id), '{}') into cand from pulse_priv.pulse_account pa where pa.handle = ltrim(l, '@') or pa.email = l;
  -- A member's username or e-mail in any organisation, each read under its own organisation's row security.
  for o in select org.id from org where org.status = 'active' loop
    perform acct_enter(o.id, null);
    select coalesce(array_agg(distinct am.account_id), '{}') into x from people_profile pp
      join pulse_priv.account_member am on am.person_id = pp.person_id and am.member_org = o.id
     where pp.org_id = o.id and (pp.username = l or lower(btrim(pp.email)) = l);
    -- WL-MOVE: staff with an active password here and no Pulse account yet.
    select coalesce(array_agg(distinct pp.person_id), '{}') into y from people_profile pp
      join person p on p.id = pp.person_id and p.org_id = o.id and p.status = 'active' and p.side = 'staff'
     where pp.org_id = o.id and (pp.username = l or lower(btrim(pp.email)) = l)
       and exists (select 1 from login_credential lc where lc.org_id = o.id and lc.person_id = pp.person_id and lc.status = 'active')
       and not exists (select 1 from pulse_priv.account_member am where am.person_id = pp.person_id and am.member_org = o.id);
    perform acct_leave();
    cand := cand || x;
    foreach pid in array y loop lone_org := lone_org || o.id; lone_person := lone_person || pid; end loop;
  end loop;
  select coalesce(array_agg(distinct u), '{}') into cand from unnest(cand) u;
  if cardinality(cand) = 0 and cardinality(lone_person) = 0 then perform crypt('x', gen_salt('bf', 10)); return null; end if;
  foreach cid in array cand loop
    select * into a from pulse_priv.pulse_account where pulse_account.id = cid;
    if a.locked_until > now() then locked := true; continue; end if;
    matched := null;
    if a.password_hash is not null then
      if a.password_hash = crypt(p_password, a.password_hash) then matched := jsonb_build_object('account', true); end if;
    else
      for m in select am.member_org, am.person_id from pulse_priv.account_member am join org on org.id = am.member_org and org.status = 'active'
          where am.account_id = a.id order by coalesce(am.member_org = own, false) desc, (am.member_org = a.last_org) desc, am.last_used_at desc nulls last loop
        matched := acct_cred_match(m.member_org, m.person_id, p_password);
        exit when matched is not null;
      end loop;
    end if;
    if matched is not null then hits := hits + 1; hit := a.id; hit_match := matched; end if;
  end loop;
  -- WL-MOVE: each account-less person's own organisation credential, the same check.
  for i in 1 .. cardinality(lone_person) loop
    matched := acct_cred_match(lone_org[i], lone_person[i], p_password);
    if matched is not null then hits := hits + 1; hit := null; hit_match := matched; new_org := lone_org[i]; new_person := lone_person[i]; end if;
  end loop;
  if hits = 0 then
    if cardinality(cand) = 1 then
      update pulse_priv.pulse_account set failed = case when failed >= 4 then 0 else failed + 1 end,
        locked_until = case when failed >= 4 then now() + interval '15 minutes' end where pulse_account.id = cand[1] and password_hash is not null;
    end if;
    return jsonb_build_object('failed', true, 'locked', locked and cardinality(cand) = 1);
  end if;
  -- The same login and password open two different people: nobody is guessed, the organisation's own sign-in decides.
  if hits > 1 then return jsonb_build_object('failed', true, 'ambiguous', true); end if;
  -- WL-MOVE: the one account-less person whose password this is gets their Pulse account now (1291's backfill, step 2).
  if hit is null then
    perform acct_enter(new_org, null);
    select lower(nullif(btrim(pp.username), '')), lower(nullif(btrim(pp.email), '')), per.display_name into nu_username, nu_email, nu_name
      from person per left join people_profile pp on pp.person_id = per.id and pp.org_id = per.org_id
     where per.id = new_person and per.org_id = new_org;
    perform acct_leave();
    h := handle_suggest(coalesce(nullif(split_part(coalesce(nu_username, ''), '.', 1) || split_part(coalesce(nu_username, ''), '.', 2), ''), nu_name));
    insert into pulse_priv.pulse_account(handle, display_name, email, last_org)
    values (h, nu_name, case when nu_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      and not exists (select 1 from pulse_priv.pulse_account x2 where lower(x2.email) = nu_email) then nu_email end, new_org) returning id into hit;
    insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', hit);
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (hit, new_org, new_person, 'staff');
    perform acct_enter(new_org, null);
    perform audit_write('account_link', 'person', new_person::text, array['first_sign_in']);
    perform acct_leave();
  end if;
  if acct_two_step(hit) then
    if acct_challenge_begin(hit, p_challenge, p_device, own) then return jsonb_build_object('twoStep', true, 'challenge', true); end if;
    return jsonb_build_object('failed', true, 'twoStep', true);
  end if;
  update pulse_priv.pulse_account set failed = 0, locked_until = null where pulse_account.id = hit;
  select * into a from pulse_priv.pulse_account where pulse_account.id = hit;
  select count(*) into members from pulse_priv.account_member where account_id = hit;
  -- A company-issued password to change first lands in that company, where the change is asked.
  if coalesce((hit_match ->> 'mustChange')::boolean, false) then
    r := acct_session(hit, (hit_match ->> 'org')::uuid, p_hash, p_device);
    return case when r is null then jsonb_build_object('failed', true, 'noOrg', true) else r || jsonb_build_object('mustChange', true) end;
  end if;
  for target in select am.member_org from pulse_priv.account_member am join org on org.id = am.member_org and org.status = 'active'
      where am.account_id = hit order by coalesce(am.member_org = own, false) desc, (am.member_org = a.last_org) desc, am.last_used_at desc nulls last loop
    -- Never land where a password still waits to be changed, unless that is the one typed.
    perform acct_enter(target, null);
    if exists (select 1 from login_credential lc join pulse_priv.account_member am on am.person_id = lc.person_id
                where am.account_id = hit and am.member_org = target and lc.org_id = target and lc.status = 'active' and lc.must_change)
       and target is distinct from (hit_match ->> 'org')::uuid then
      perform acct_leave(); continue;
    end if;
    perform acct_leave();
    r := acct_session(hit, target, p_hash, p_device);
    if r is not null then
      return r || jsonb_build_object('unify', a.password_hash is null and members > 1);
    end if;
  end loop;
  return jsonb_build_object('failed', true, 'noOrg', true);
end $$;

-- The e-mailed account code, with the same challenge when a seat uses an authenticator (6 arguments; the 5-argument form
-- above stays for callers without a challenge and still refuses).
create function pulse.account_code_finish(p_login text, p_code text, p_hash text, p_device text, p_own uuid, p_challenge text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare r jsonb; a uuid;
begin
  r := account_code_finish(p_login, p_code, p_hash, p_device, p_own);
  if r is not null and coalesce((r ->> 'twoStep')::boolean, false) then
    a := acct_code_target(p_login);
    if a is not null and acct_challenge_begin(a, p_challenge, p_device, p_own) then return jsonb_build_object('twoStep', true, 'challenge', true); end if;
  end if;
  return r;
end $$;

revoke all on function pulse.acct_challenge_begin(uuid, text, text, uuid), pulse.account_two_step_finish(text, text, text, text),
  pulse.account_sign_in(text, text, text, text, text), pulse.account_code_finish(text, text, text, text, uuid, text) from public;
grant execute on function pulse.account_two_step_finish(text, text, text, text), pulse.account_sign_in(text, text, text, text, text),
  pulse.account_code_finish(text, text, text, text, uuid, text) to pulse_api;

-- migrate:down
drop function if exists pulse.account_code_finish(text, text, text, text, uuid, text);
drop function if exists pulse.account_sign_in(text, text, text, text, text);
drop function if exists pulse.account_two_step_finish(text, text, text, text);
drop function if exists pulse.acct_challenge_begin(uuid, text, text, uuid);
drop table if exists pulse_priv.account_challenge;
drop function if exists pulse.account_login_email_restore(jsonb, text);
drop function if exists pulse.account_merge(uuid, uuid, text, text, text);
drop function if exists pulse.account_unmerge(jsonb, text);
alter function pulse.acct_merge_core(uuid, uuid, text, text, text) rename to account_merge;
alter function pulse.acct_unmerge_core(jsonb, text) rename to account_unmerge;
drop function if exists pulse.acct_code_delivery(uuid, text);
drop trigger if exists pulse_account_login_email_guard on pulse_priv.pulse_account;
drop function if exists pulse.acct_login_email_guard();
alter table pulse_priv.account_signin_code drop column if exists sent_to;
-- The functions as they were before (1449, 1465, 0920, 1535), then the helpers they no longer use.
CREATE OR REPLACE FUNCTION pulse.auth_signin_code_actor(r text, input text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare v text := lower(btrim(coalesce(input, ''))); n int; a uuid;
begin
  if r <> 'staff' or v = '' then return null; end if;
  if v ~ '^@[^@]+$' then v := substr(v, 2); end if;
  select count(*), min(p.id::text)::uuid into n, a from person p join people_profile pp on pp.person_id = p.id
    join login_credential lc on lc.org_id = p.org_id and lc.person_id = p.id
   where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' and lc.status = 'active'
     and (pp.username = v or lower(auth_delivery(r, p.id)) = v);
  return case when n = 1 then a end;
end $function$
;

CREATE OR REPLACE FUNCTION pulse.acct_code_target(p_login text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION pulse.acct_code_ok(p_account uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION pulse.account_code_issue(p_login text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'public', 'pg_temp'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION pulse.account_code_finish(p_login text, p_code text, p_hash text, p_device text, p_own uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'public', 'pg_temp'
AS $function$
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
end $function$
;

CREATE OR REPLACE FUNCTION pulse.account_claim(p_handle text, p_password text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'public', 'pg_temp'
AS $function$
declare v uuid; h text := lower(btrim(coalesce(p_handle, ''))); cur text;
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if h <> '' and h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  v := account_ensure();
  select handle into cur from pulse_priv.pulse_account where id = v;
  if h <> '' and h <> cur then
    if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then
      raise exception 'Someone already has @%', h using errcode = '23505'; end if;
    delete from pulse_priv.handle_name where handle = cur and kind = 'person' and ref = v;
    insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
    update pulse_priv.pulse_account set handle = h, updated_at = now() where id = v;
    update pulse_priv.org_invite set to_handle = h where to_handle = cur and status = 'open';
  end if;
  if coalesce(p_password, '') <> '' then
    update pulse_priv.pulse_account set password_hash = crypt(p_password, gen_salt('bf', 10)), failed = 0, locked_until = null, updated_at = now() where id = v;
  end if;
  return account_me();
end $function$
;

CREATE OR REPLACE FUNCTION pulse.handle_check(p_handle text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare h text := lower(ltrim(btrim(coalesce(p_handle, '')), '@'));
begin
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then return 'invalid'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h)
     or exists (select 1 from pulse_priv.pulse_account where handle = h) then
    return 'taken';
  end if;
  return 'available';
end $function$
;

CREATE OR REPLACE FUNCTION pulse.account_signup_problem(p jsonb)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@'));
  e text := lower(btrim(coalesce(p ->> 'email', ''))); o text := regexp_replace(btrim(coalesce(p ->> 'orgName', '')), '\s+', ' ', 'g');
begin
  if length(n) not between 2 and 120 then return 'Give your name'; end if;
  if e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e) > 254 then return 'Give your e-mail address'; end if;
  if h <> '' and h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then return 'A handle is 3 to 30 lower-case letters, digits, dots or underscores'; end if;
  if h <> '' and (exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h)) then return 'Someone already has @' || h || '. Choose another handle.'; end if;
  if o <> '' and length(o) not between 2 and 80 then return 'Give your company a name of 2 to 80 characters, or leave it empty'; end if;
  return null;
end $function$
;

drop function if exists pulse.org_email_codes(uuid);
drop function if exists pulse.handle_reserved(text);
alter table pulse_priv.auth_policy drop column if exists email_codes;
drop table if exists pulse_priv.account_login_email;
