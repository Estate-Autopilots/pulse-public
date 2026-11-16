-- migrate:up
-- ONBOARD-SELF (owner, 2 Nov 2026: "start your company on Pulse", no operator needed): a new company signs up, sets
-- itself up, invites its people by seat, and finds a first-run guide inside. One install, many organisations (ADR-0032):
-- nothing here reads or copies another organisation's rows, and a self-serve company never claims an address
-- (pulse.org_domain stays the operator's, docs/ops/TENANTS.md).
--
--  * pulse_priv.pulse_account.email_verified_at: the account's e-mail was proven (a 6-digit code to it, an invitation
--    mailed to it, or the Cloudflare Access identity that carries it). Starting an organisation needs it.
--  * pulse_priv.email_code: the 6-digit codes (hashed, 15 minutes, five tries, one a minute and five an hour per address).
--    Global and owner-only like the account tables (an e-mail is checked before any organisation exists).
--  * pulse.org_onboarding: which organisations started themselves, from which account and templates (the per-account and
--    install-wide limits count it); pulse.onboarding_person: each person's seat, the first-run items ticked by hand and
--    whether they put the guide away.
--  * pulse_priv.org_invite gains to_email and seat: invitations by e-mail per seat (leadership, manager, staff, sales,
--    freelancer, client); accepting adds a seat to the account the address already has, or makes one.
--  * pulse.onboard_org: the organisation, its owner (admin and leadership), time zone, working days and hours, module
--    switches, industry pack and starter projects, in one transaction, ready to use (status active, never setup).

-- ------------------------------------------------------------------------------------------------ verified e-mail
alter table pulse_priv.pulse_account add column email_verified_at timestamptz;

create table pulse_priv.email_code (
  email        text primary key check (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(email) <= 254),
  purpose      text not null check (purpose in ('signup','verify')),
  account_id   uuid references pulse_priv.pulse_account(id) on delete cascade,
  code_hash    text not null check (length(code_hash) = 64),
  sent_at      timestamptz not null default now(),
  expires_at   timestamptz not null,
  tries        int not null default 0,
  sends        int not null default 1,
  window_from  timestamptz not null default now()
);
revoke all on pulse_priv.email_code from public;

-- A code may go to this address now (one a minute, five an hour); the caller made the code and sends it.
create function pulse.email_code_issue(p_email text, p_purpose text, p_account uuid, p_hash text) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r pulse_priv.email_code%rowtype; e text := lower(btrim(coalesce(p_email, '')));
begin
  if e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e) > 254 then raise exception 'Give a valid e-mail address' using errcode = '22023'; end if;
  select * into r from pulse_priv.email_code where email = e for update;
  if found then
    if r.sent_at > now() - interval '1 minute' then return false; end if;
    if r.window_from > now() - interval '1 hour' and r.sends >= 5 then return false; end if;
    update pulse_priv.email_code set purpose = p_purpose, account_id = p_account, code_hash = p_hash, sent_at = now(),
      expires_at = now() + interval '15 minutes', tries = 0,
      sends = case when window_from > now() - interval '1 hour' then sends + 1 else 1 end,
      window_from = case when window_from > now() - interval '1 hour' then window_from else now() end
     where email = e;
  else
    insert into pulse_priv.email_code(email, purpose, account_id, code_hash, expires_at) values (e, p_purpose, p_account, p_hash, now() + interval '15 minutes');
  end if;
  return true;
end $$;

-- Whether the code is right (five wrong tries end it); p_consume uses it up.
create function pulse.email_code_check(p_email text, p_purpose text, p_account uuid, p_hash text, p_consume boolean) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r pulse_priv.email_code%rowtype; e text := lower(btrim(coalesce(p_email, '')));
begin
  select * into r from pulse_priv.email_code where email = e for update;
  if not found or r.purpose <> p_purpose or r.account_id is distinct from p_account or r.expires_at <= now() or r.tries >= 5 then return false; end if;
  if r.code_hash <> coalesce(p_hash, '') then
    update pulse_priv.email_code set tries = tries + 1 where email = e;
    return false;
  end if;
  if p_consume then delete from pulse_priv.email_code where email = e; end if;
  return true;
end $$;
revoke all on function pulse.email_code_issue(text, text, uuid, text), pulse.email_code_check(text, text, uuid, text, boolean) from public;

create function pulse.account_email_ok(p_account uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select email is not null and email_verified_at is not null from pulse_priv.pulse_account where id = p_account), false)
$$;
revoke all on function pulse.account_email_ok(uuid) from public;

-- Signed in: the account's e-mail and whether it is proven.
create function pulse.account_email_state() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); a record; s text; e text;
begin
  if current_viewer() is null then return null; end if;
  if v is null then
    select lower(pp.email) into e from people_profile pp where pp.person_id = current_viewer();
    return jsonb_build_object('email', case when e is not null and not exists (select 1 from pulse_priv.pulse_account where email = e) then e end, 'verified', false);
  end if;
  select email, email_verified_at into a from pulse_priv.pulse_account where id = v;
  select email into s from pulse_priv.email_code where account_id = v and purpose = 'verify' and expires_at > now() order by sent_at desc limit 1;
  return jsonb_build_object('email', a.email, 'verified', a.email is not null and a.email_verified_at is not null, 'pending', s);
end $$;

-- Signed in: a code to confirm the account's e-mail (or a new one no other account uses). Answers whether it may go now.
create function pulse.account_email_verify_start(p_email text, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); a record; e text;
begin
  select email, email_verified_at into a from pulse_priv.pulse_account where id = v;
  e := coalesce(nullif(lower(btrim(coalesce(p_email, ''))), ''), a.email);
  if e is null then raise exception 'Add your e-mail address' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.pulse_account where email = e and id <> v) then
    raise exception 'That e-mail belongs to another Pulse account. Sign in with it instead' using errcode = '23505'; end if;
  if a.email = e and a.email_verified_at is not null then return jsonb_build_object('email', e, 'verified', true, 'send', false); end if;
  return jsonb_build_object('email', e, 'verified', false, 'send', email_code_issue(e, 'verify', v, p_hash));
end $$;

create function pulse.account_email_verify_finish(p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); e text;
begin
  select email into e from pulse_priv.email_code where account_id = v and purpose = 'verify' order by sent_at desc limit 1;
  if e is null or not email_code_check(e, 'verify', v, p_hash, true) then return jsonb_build_object('ok', false); end if;
  if exists (select 1 from pulse_priv.pulse_account where email = e and id <> v) then
    raise exception 'That e-mail belongs to another Pulse account. Sign in with it instead' using errcode = '23505'; end if;
  update pulse_priv.pulse_account set email = e, email_verified_at = now(), updated_at = now() where id = v;
  return jsonb_build_object('ok', true, 'email', e, 'verified', true);
end $$;

-- Signed in through Cloudflare Access: the identity proves its e-mail. It proves the account's own (or gives an account
-- without one that e-mail when no other account has it); a different address proves nothing.
create function pulse.account_email_proven(p_email text) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); e text := lower(btrim(coalesce(p_email, ''))); cur text;
begin
  if e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then return false; end if;
  select email into cur from pulse_priv.pulse_account where id = v;
  if cur is null and not exists (select 1 from pulse_priv.pulse_account where email = e) then
    update pulse_priv.pulse_account set email = e, email_verified_at = now(), updated_at = now() where id = v; return true;
  end if;
  if cur = e then update pulse_priv.pulse_account set email_verified_at = coalesce(email_verified_at, now()) where id = v; return true; end if;
  return false;
end $$;

-- Signed out: a code to the address before an account exists (nothing is sent when the address already has one).
create function pulse.signup_code_send(p_email text, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare e text := lower(btrim(coalesce(p_email, '')));
begin
  if exists (select 1 from pulse_priv.pulse_account where email = e) then return jsonb_build_object('exists', true, 'send', false); end if;
  return jsonb_build_object('exists', false, 'send', email_code_issue(e, 'signup', null, p_hash));
end $$;
create function pulse.signup_code_check(p_email text, p_hash text) returns boolean
  language sql security definer set search_path = pulse, pg_temp as $$
  select email_code_check(p_email, 'signup', null, p_hash, false)
$$;

-- ------------------------------------------------------------------------------------------------ onboarding records
create table pulse.org_onboarding (
  org_id              uuid primary key references pulse.org(id),
  started_by_account  uuid not null,
  started_by          uuid references pulse.person(id),
  templates           text[] not null default '{}',
  created_at          timestamptz not null default now()
);
alter table pulse.org_onboarding enable row level security;
alter table pulse.org_onboarding force row level security;
create policy tenant on pulse.org_onboarding using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- The schema owner (the start function) counts what one account and the whole install started lately.
create policy directory on pulse.org_onboarding for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));

create table pulse.onboarding_person (
  org_id        uuid not null references pulse.org(id),
  person_id     uuid primary key references pulse.person(id),
  seat          text not null check (seat in ('leadership','manager','staff','sales','freelancer','client')),
  done          text[] not null default '{}',
  dismissed_at  timestamptz,
  created_at    timestamptz not null default now()
);
alter table pulse.onboarding_person enable row level security;
alter table pulse.onboarding_person force row level security;
create policy tenant on pulse.onboarding_person using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- ------------------------------------------------------------------------------------------------ invitations by e-mail
alter table pulse_priv.org_invite
  add column to_email text check (to_email is null or (to_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(to_email) <= 254)),
  add column seat text check (seat is null or seat in ('leadership','manager','staff','sales','freelancer','client')),
  add column mailed_at timestamptz;
create index org_invite_email on pulse_priv.org_invite(org_id, to_email) where status = 'open';

-- ------------------------------------------------------------------------------------------------ start a company
-- The organisation for an account (signed in, or just signed up), set up and ready: the caller checked the account's
-- e-mail. p: name, handle, pack (packPayload or null), templates, timeZone, workDays, dayStart, dayEnd, modulesDoc
-- (the tenant/modules document), companyModules {chats, finance}, starters [{key, name, summary, steps}].
create function pulse.onboard_org(p_account uuid, p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a pulse_priv.pulse_account%rowtype; v_org uuid := gen_random_uuid(); v_person uuid; v_pid uuid; v_tid uuid;
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@'));
  v_code text; v_letters text; k int := 0; v_slug text; v_pack jsonb := p -> 'pack'; v_tz text := coalesce(nullif(p ->> 'timeZone', ''), 'Asia/Kolkata');
  v_days int[]; v_start time; v_end time; x jsonb; s text; i int; v_templates text[];
begin
  select * into a from pulse_priv.pulse_account where id = p_account;
  if not found then raise exception 'Sign in first' using errcode = '42501'; end if;
  if a.email is null or a.email_verified_at is null then raise exception 'Confirm your e-mail first: Pulse sends a 6-digit code to it' using errcode = '42501'; end if;
  if length(n) not between 2 and 80 then raise exception 'Give your company a name of 2 to 80 characters' using errcode = '22023'; end if;
  if h = '' then h := handle_suggest(n); end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  -- Abuse limits: three a day and five a month per account (as Start your own Pulse), and a calm ceiling for the install.
  if (select count(*) from pulse_priv.handle_name hn join pulse_priv.account_member m on m.member_org = hn.ref where hn.kind = 'org' and m.account_id = p_account
        and hn.created_at > now() - interval '1 day') >= 3
     or (select count(*) from org_onboarding where started_by_account = p_account and created_at > now() - interval '1 day') >= 3 then
    raise exception 'You started three companies today; try again tomorrow' using errcode = '54000'; end if;
  if (select count(*) from org_onboarding where started_by_account = p_account and created_at > now() - interval '30 days') >= 5 then
    raise exception 'You started five companies this month. Write to Pulse support to start another' using errcode = '54000'; end if;
  if (select count(*) from org_onboarding where created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Pulse is starting many companies right now; try again in an hour' using errcode = '54000'; end if;
  if not exists (select 1 from pg_timezone_names where name = v_tz) then raise exception 'Choose a time zone' using errcode = '22023'; end if;
  begin
    v_days := array(select distinct d::int from jsonb_array_elements_text(coalesce(p -> 'workDays', '[1,2,3,4,5]'::jsonb)) d order by 1);
    v_start := coalesce(nullif(p ->> 'dayStart', ''), '09:30')::time; v_end := coalesce(nullif(p ->> 'dayEnd', ''), '18:30')::time;
  exception when others then raise exception 'Choose working days and hours' using errcode = '22023'; end;
  if cardinality(v_days) = 0 or exists (select 1 from unnest(v_days) d where d not between 1 and 7) then raise exception 'Choose at least one working day' using errcode = '22023'; end if;
  if v_end <= v_start then raise exception 'The working day ends after it starts' using errcode = '22023'; end if;
  v_templates := array(select left(t, 40) from jsonb_array_elements_text(coalesce(p -> 'templates', '[]'::jsonb)) t limit 5);

  -- The code (2 to 4 capitals, unique): the name's initials, then more of its letters (as account_start_org).
  v_letters := upper(regexp_replace(n, '[^A-Za-z]', '', 'g')) || 'PULSEXYZ';
  v_code := left(upper(regexp_replace(initcap(n), '[^A-Z]', '', 'g')) || substr(v_letters, 2), 3);
  if length(v_code) < 2 then v_code := left(v_letters, 3); end if;
  while exists (select 1 from org where code = v_code) loop
    k := k + 1; v_code := left(v_code, 2) || chr(65 + ((k - 1) % 26)) || case when k > 26 then chr(65 + ((k - 1) / 26 - 1) % 26) else '' end;
    if k > 700 then raise exception 'Could not find a free company code' using errcode = '54000'; end if;
  end loop;
  v_slug := h; while exists (select 1 from org where slug = v_slug) loop v_slug := v_slug || 'x'; end loop;

  perform acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'Pulse account @' || a.handle, true);
  insert into org(id, slug, name, code, handle, time_zone, status) values (v_org, v_slug, n, v_code, h, v_tz, 'active');
  insert into hr_policy(org_id, attendance_enabled, work_days, shift_start, shift_end) values (v_org, false, v_days, v_start, v_end)
    on conflict (org_id) do update set work_days = excluded.work_days, shift_start = excluded.shift_start, shift_end = excluded.shift_end;
  insert into org_module(org_id, module, enabled) values (v_org, 'tasks', true),
    (v_org, 'chats', coalesce((p -> 'companyModules' ->> 'chats')::boolean, true)), (v_org, 'finance', coalesce((p -> 'companyModules' ->> 'finance')::boolean, true));
  if jsonb_typeof(p -> 'modulesDoc') = 'object' then
    insert into tenant_config(org_id, doc_kind, doc_key, version, body, is_active) values (v_org, 'tenant', 'modules', 1, p -> 'modulesDoc', true);
  end if;
  insert into person(org_id, display_name, side, status, active_from) values (v_org, a.display_name, 'staff', 'active', current_date) returning id into v_person;
  insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
  values (v_org, v_person, 'Owner', a.email, a.handle, 1, 'Started this company on Pulse (@' || a.handle || ')', '{}');
  insert into role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, 'admin', current_date), (v_org, v_person, 'leadership', current_date);
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (v_org, 'person', v_person, 'created', null, 'Started the company from a Pulse account', null);
  perform set_config('pulse.viewer_id', v_person::text, true);
  if v_pack is not null and jsonb_typeof(v_pack) = 'object' then perform flow_pack_write(v_pack, true); end if;
  -- Starter projects from the chosen templates: an internal project each, owned by the founder, with its first steps.
  for x in select e from jsonb_array_elements(coalesce(p -> 'starters', '[]'::jsonb)) e limit 5 loop
    v_pid := (work_project_save(null, jsonb_build_object('type', 'internal', 'name', left(btrim(coalesce(x ->> 'name', 'Getting started')), 200),
      'summary', left(coalesce(x ->> 'summary', ''), 1000), 'ownerId', v_person, 'startsOn', current_date::text)) ->> 'id')::uuid;
    update work_project set template_key = left('starter:' || coalesce(nullif(x ->> 'key', ''), 'team'), 40) where org_id = v_org and project_id = v_pid;
    i := 0;
    for s in select left(btrim(t), 200) from jsonb_array_elements_text(coalesce(x -> 'steps', '[]'::jsonb)) t where length(btrim(t)) >= 2 limit 12 loop
      i := i + 1;
      insert into task(org_id, title, status, project_id, source, created_by, created_at, edited_by, updated_at, priority, position, locked)
      values (v_org, s, 'open', v_pid, 'pulse', v_person, now(), v_person, now(), 'normal', i, '{title,status,owner_id,project_id,due_label}') returning id into v_tid;
      perform task_event_add(v_tid, 'created', null, s, 'A starter step of ' || left(coalesce(x ->> 'name', 'the project'), 80));
    end loop;
  end loop;
  insert into org_onboarding(org_id, started_by_account, started_by, templates) values (v_org, p_account, v_person, v_templates);
  insert into onboarding_person(org_id, person_id, seat) values (v_org, v_person, 'leadership');
  perform audit_write('org_onboard', 'org', v_org::text);
  perform acct_leave();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, v_org, v_person, 'staff');
  return acct_session(p_account, v_org, p_hash, p_device) || jsonb_build_object('code', v_code);
end $$;
revoke all on function pulse.onboard_org(uuid, jsonb, text, text) from public;

-- Signed in: start a company from my account (its e-mail proven).
create function pulse.account_onboard(p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure();
begin
  if not account_email_ok(v) then raise exception 'Confirm your e-mail first: Pulse sends a 6-digit code to it' using errcode = '42501'; end if;
  return onboard_org(v, p, p_hash, p_device);
end $$;

-- Signed out: a new account (its e-mail proven by the code) and its company, then a session there.
create function pulse.account_signup_onboard(p_account jsonb, p_company jsonb, p_code text, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare v uuid; h text := lower(ltrim(btrim(coalesce(p_account ->> 'handle', '')), '@')); e text := lower(btrim(coalesce(p_account ->> 'email', '')));
  n text := regexp_replace(btrim(coalesce(p_account ->> 'name', '')), '\s+', ' ', 'g');
begin
  if length(n) not between 2 and 120 then raise exception 'Give your name' using errcode = '22023'; end if;
  if h = '' then h := handle_suggest(n); end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  if exists (select 1 from pulse_priv.pulse_account where email = e) then raise exception 'That e-mail already has a Pulse account: sign in, then start your company from there' using errcode = '23505'; end if;
  if not email_code_check(e, 'signup', null, p_code, true) then return jsonb_build_object('badCode', true); end if;
  insert into pulse_priv.pulse_account(handle, display_name, email, password_hash, email_verified_at)
  values (h, n, e, crypt(p_account ->> 'password', gen_salt('bf', 10)), now()) returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  return onboard_org(v, p_company, p_hash, p_device);
end $$;

-- Start your own Pulse (0920) keeps its one step, and now needs a proven e-mail too.
create or replace function pulse.account_start_org(p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); a pulse_priv.pulse_account%rowtype; v_org uuid := gen_random_uuid(); v_person uuid;
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@'));
  v_code text; v_letters text; k int := 0; v_pack jsonb := p -> 'pack'; v_slug text;
begin
  if not account_email_ok(v) then raise exception 'Confirm your e-mail first: Pulse sends a 6-digit code to it' using errcode = '42501'; end if;
  if length(n) not between 2 and 80 then raise exception 'Give your organisation a name of 2 to 80 characters' using errcode = '22023'; end if;
  if h = '' then h := handle_suggest(n); end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  if (select count(*) from pulse_priv.handle_name hn join pulse_priv.account_member m on m.member_org = hn.ref where hn.kind = 'org' and m.account_id = v
        and hn.created_at > now() - interval '1 day') >= 3 then
    raise exception 'You started three organisations today; try again tomorrow' using errcode = '54000'; end if;
  select * into a from pulse_priv.pulse_account where id = v;
  v_letters := upper(regexp_replace(n, '[^A-Za-z]', '', 'g')) || 'PULSEXYZ';
  v_code := left(upper(regexp_replace(initcap(n), '[^A-Z]', '', 'g')) || substr(v_letters, 2), 3);
  if length(v_code) < 2 then v_code := left(v_letters, 3); end if;
  while exists (select 1 from org where code = v_code) loop
    k := k + 1; v_code := left(v_code, 2) || chr(65 + ((k - 1) % 26)) || case when k > 26 then chr(65 + ((k - 1) / 26 - 1) % 26) else '' end;
    if k > 700 then raise exception 'Could not find a free organisation code' using errcode = '54000'; end if;
  end loop;
  v_slug := h; while exists (select 1 from org where slug = v_slug) loop v_slug := v_slug || 'x'; end loop;
  perform acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'Pulse account @' || a.handle, true);
  insert into org(id, slug, name, code, handle) values (v_org, v_slug, n, v_code, h);
  insert into hr_policy(org_id, attendance_enabled) values (v_org, false) on conflict (org_id) do nothing;
  insert into org_module(org_id, module, enabled) values (v_org, 'tasks', true), (v_org, 'chats', true), (v_org, 'finance', true);
  insert into person(org_id, display_name, side, status, active_from) values (v_org, a.display_name, 'staff', 'active', current_date) returning id into v_person;
  insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
  values (v_org, v_person, 'Owner', a.email, a.handle, 1, 'Started this organisation (@' || a.handle || ')', '{}');
  insert into role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, 'admin', current_date);
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (v_org, 'person', v_person, 'created', null, 'Started the organisation from a Pulse account', null);
  if v_pack is not null and jsonb_typeof(v_pack) = 'object' then
    perform set_config('pulse.viewer_id', v_person::text, true);
    perform flow_pack_write(v_pack, true);
  end if;
  perform acct_leave();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (v, v_org, v_person, 'staff');
  return acct_session(v, v_org, p_hash, p_device) || jsonb_build_object('code', v_code);
end $$;

-- ------------------------------------------------------------------------------------------------ invite by e-mail
-- Admins, HR and leadership invite people by e-mail and seat: one link each (the caller hashed its token and mails it).
-- An address already in the organisation is skipped; inviting an address again replaces its open link.
create function pulse.onboard_invites(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare x jsonb; e text; s text; v_out jsonb := '[]'::jsonb; v_id uuid; v_today int; v_n int := jsonb_array_length(coalesce(p -> 'rows', '[]'::jsonb));
begin
  if current_viewer() is null or not viewer_is('admin', 'leadership', 'hr') then
    raise exception 'Admins, HR and leadership invite people into the organisation' using errcode = '42501'; end if;
  if v_n = 0 then raise exception 'Add at least one e-mail address' using errcode = '22023'; end if;
  if v_n > 50 then raise exception 'Invite up to 50 people at a time' using errcode = '22023'; end if;
  select count(*) into v_today from pulse_priv.org_invite where org_id = current_org() and created_at > now() - interval '1 day';
  if v_today + v_n > 200 then raise exception 'Up to 200 invitations a day; send the rest tomorrow' using errcode = '54000'; end if;
  for x in select * from jsonb_array_elements(p -> 'rows') loop
    e := lower(btrim(coalesce(x ->> 'email', ''))); s := coalesce(nullif(x ->> 'seat', ''), 'staff');
    if s not in ('leadership','manager','staff','sales','freelancer','client') then raise exception 'Choose a seat for %', e using errcode = '22023'; end if;
    if e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(e) > 254 or coalesce(x ->> 'hash', '') !~ '^[0-9a-f]{64}$' then
      v_out := v_out || jsonb_build_object('email', e, 'seat', s, 'status', 'invalid'); continue; end if;
    if exists (select 1 from people_profile pp join person pe on pe.id = pp.person_id where pp.org_id = current_org() and lower(pp.email) = e and pe.status = 'active')
       or exists (select 1 from pulse_priv.account_member m join pulse_priv.pulse_account a on a.id = m.account_id where m.member_org = current_org() and a.email = e) then
      v_out := v_out || jsonb_build_object('email', e, 'seat', s, 'status', 'member'); continue; end if;
    update pulse_priv.org_invite set status = 'revoked' where org_id = current_org() and to_email = e and status = 'open';
    insert into pulse_priv.org_invite(org_id, kind, title, to_email, seat, token_hash, invited_by)
    values (current_org(), case s when 'freelancer' then 'freelancer' when 'client' then 'client' else 'staff' end,
      nullif(left(btrim(coalesce(x ->> 'title', '')), 80), ''), e, s, x ->> 'hash', current_viewer())
    returning id into v_id;
    perform audit_write('invite', 'org_invite', v_id::text);
    v_out := v_out || jsonb_build_object('id', v_id, 'email', e, 'seat', s, 'status', 'created',
      'hasAccount', exists (select 1 from pulse_priv.pulse_account where email = e));
  end loop;
  return v_out;
end $$;

create function pulse.onboard_invite_mailed(p_ids uuid[]) returns void
  language sql security definer set search_path = pulse, pg_temp as $$
  update pulse_priv.org_invite set mailed_at = now() where org_id = current_org() and id = any(p_ids) and status = 'open'
$$;

create or replace function pulse.org_invite_list() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'toHandle', i.to_handle, 'link', i.token_hash is not null,
    'email', i.to_email, 'seat', i.seat, 'mailed', i.mailed_at is not null,
    'status', case when i.status = 'open' and i.expires_at <= now() then 'expired' else i.status end, 'at', i.created_at, 'expiresAt', i.expires_at,
    'by', (select display_name from person where id = i.invited_by), 'who', (select display_name from person where id = i.accepted_person)) order by i.created_at desc), '[]'::jsonb)
  from pulse_priv.org_invite i where i.org_id = current_org() and viewer_is('admin', 'leadership', 'hr') and i.created_at > now() - interval '90 days'
$$;

-- What an invitation link is for: the organisation, the kind and seat, the address it was sent to and whether that
-- address already has a Pulse account (then the person signs in and accepts; nobody makes a second account).
create or replace function pulse.org_invite_peek(p_hash text) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('org', o.name, 'orgHandle', o.handle, 'kind', i.kind, 'title', i.title)
    || case when i.to_email is null then '{}'::jsonb else jsonb_build_object('seat', i.seat, 'email', i.to_email,
      'hasAccount', exists (select 1 from pulse_priv.pulse_account a where a.email = i.to_email)) end
  from pulse_priv.org_invite i join org o on o.id = i.org_id
  where i.token_hash = p_hash and i.status = 'open' and i.expires_at > now() and o.status = 'active'
$$;

-- Joining (0920) now also gives the seat's role (leadership, manager), records the seat for the first-run guide, and
-- proves the account's e-mail when the invitation was mailed to it.
create or replace function pulse.acct_join(p_account uuid, p_invite uuid, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare i pulse_priv.org_invite%rowtype; a pulse_priv.pulse_account%rowtype; v_org uuid; v_person uuid; v_no int; v_user text; n int := 1; v_new boolean := false;
begin
  select org_id into v_org from pulse_priv.org_invite where id = p_invite;
  if v_org is null then raise exception 'This invitation is no longer open' using errcode = '22023'; end if;
  perform acct_enter(v_org, null);
  select * into i from pulse_priv.org_invite where id = p_invite for update;
  if not found or i.status <> 'open' or i.expires_at <= now() then raise exception 'This invitation is no longer open' using errcode = '22023'; end if;
  select * into a from pulse_priv.pulse_account where id = p_account;
  if i.to_handle is not null and i.to_handle <> a.handle then raise exception 'This invitation is for someone else' using errcode = '42501'; end if;
  select person_id into v_person from pulse_priv.account_member where account_id = p_account and member_org = i.org_id;
  if v_person is null then
    v_new := true;
    insert into person(org_id, display_name, side, status, active_from) values (i.org_id, a.display_name, i.kind, 'active', current_date) returning id into v_person;
    select coalesce(max(user_no), 0) + 1 into v_no from people_profile where org_id = i.org_id;
    v_user := a.handle;
    while exists (select 1 from people_profile where org_id = i.org_id and username = v_user) loop n := n + 1; v_user := a.handle || '.' || n; end loop;
    insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
    values (i.org_id, v_person, coalesce(i.title, initcap(i.kind)), coalesce(a.email, i.to_email), v_user, v_no, 'Joined with an invitation (@' || a.handle || ')', '{}');
    if i.seat in ('leadership', 'manager') then
      insert into role_assignment(org_id, person_id, role_key, valid_from) values (i.org_id, v_person, i.seat, current_date);
    end if;
    if i.seat is not null and exists (select 1 from org_onboarding where org_id = i.org_id) then
      insert into onboarding_person(org_id, person_id, seat) values (i.org_id, v_person, i.seat) on conflict (person_id) do nothing;
    end if;
  end if;
  update pulse_priv.org_invite set status = 'accepted', accepted_account = p_account, accepted_person = v_person, accepted_at = now() where id = i.id;
  perform acct_leave();
  if v_new then insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, i.org_id, v_person, i.kind); end if;
  if i.to_email is not null and i.to_email = a.email then
    update pulse_priv.pulse_account set email_verified_at = coalesce(email_verified_at, now()) where id = p_account;
  end if;
  return acct_session(p_account, i.org_id, p_hash, p_device);
end $$;

-- Signed out: a new account from an invitation link. An invitation mailed to an address makes the account with that
-- address (proven by the link); when the address already has an account, the person signs in with it instead.
create or replace function pulse.account_join(p_link text, p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare i uuid; v_to text; v uuid; h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@')); e text := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g');
begin
  select id, to_email into i, v_to from pulse_priv.org_invite where token_hash = p_link and status = 'open' and expires_at > now() and to_handle is null;
  if i is null then raise exception 'This invitation is no longer open' using errcode = '22023'; end if;
  if v_to is not null then
    if exists (select 1 from pulse_priv.pulse_account where email = v_to) then
      raise exception 'That e-mail already has a Pulse account: sign in with it, then open this link again' using errcode = '23505'; end if;
    e := v_to;
  end if;
  if length(n) not between 2 and 120 then raise exception 'Give your name' using errcode = '22023'; end if;
  if h = '' and v_to is not null then h := handle_suggest(n); end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  if e is not null and e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Give a valid e-mail or leave it empty' using errcode = '22023'; end if;
  if e is not null and exists (select 1 from pulse_priv.pulse_account where email = e) then raise exception 'That e-mail already has a Pulse account: sign in instead' using errcode = '23505'; end if;
  insert into pulse_priv.pulse_account(handle, display_name, email, password_hash, email_verified_at)
  values (h, n, e, crypt(p ->> 'password', gen_salt('bf', 10)), case when v_to is not null then now() end) returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  return acct_join(v, i, p_hash, p_device);
end $$;

-- ------------------------------------------------------------------------------------------------ first-run guide
-- The seat a person reads tips for: the one they were invited to, else from their roles and side.
create function pulse.onboarding_seat(p_person uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select seat from onboarding_person where org_id = current_org() and person_id = p_person),
    case when viewer_is('admin', 'leadership') then 'leadership'
         when (select side from person where id = p_person) in ('freelancer', 'client') then (select side from person where id = p_person)
         when viewer_is('manager') then 'manager' else 'staff' end)
$$;
revoke all on function pulse.onboarding_seat(uuid) from public;

-- The signed-in person's first-run guide in a company that started itself (null elsewhere): their seat, whether they put
-- it away, and for leadership the checklist (invite the team, a first project of your own, targets, the phone app),
-- each found done from the company's own rows or ticked by hand.
create function pulse.onboarding_state() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); o org_onboarding%rowtype; r onboarding_person%rowtype; v_lead boolean; d text[];
begin
  if me is null then return null; end if;
  select * into o from org_onboarding where org_id = current_org();
  if not found then return null; end if;
  select * into r from onboarding_person where org_id = current_org() and person_id = me;
  d := coalesce(r.done, '{}');
  v_lead := viewer_is('admin', 'leadership');
  return jsonb_build_object('org', (select name from org where id = current_org()), 'seat', onboarding_seat(me), 'lead', v_lead,
    'dismissed', r.dismissed_at is not null, 'templates', to_jsonb(o.templates), 'startedAt', o.created_at,
    'items', case when not v_lead then '[]'::jsonb else jsonb_build_array(
      jsonb_build_object('key', 'invite', 'done', 'invite' = any(d) or exists (select 1 from pulse_priv.org_invite where org_id = current_org())
        or (select count(*) from person where org_id = current_org() and status = 'active') > 1),
      jsonb_build_object('key', 'project', 'done', 'project' = any(d) or exists (select 1 from work_project where org_id = current_org() and coalesce(template_key, '') not like 'starter:%')),
      jsonb_build_object('key', 'targets', 'done', 'targets' = any(d) or exists (select 1 from work_project where org_id = current_org() and due_on is not null)),
      jsonb_build_object('key', 'app', 'done', 'app' = any(d) or exists (select 1 from native_device where org_id = current_org() and person_id = me and revoked_at is null))) end);
end $$;

-- Tick an item by hand (or untick it), or put the guide away (or bring it back).
create function pulse.onboarding_mark(p_item text, p_done boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  if me is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if not exists (select 1 from org_onboarding where org_id = current_org()) then raise exception 'This company has no getting-started guide' using errcode = 'P0002'; end if;
  if p_item not in ('invite', 'project', 'targets', 'app', 'dismissed') then raise exception 'Choose an item' using errcode = '22023'; end if;
  insert into onboarding_person(org_id, person_id, seat) values (current_org(), me, onboarding_seat(me)) on conflict (person_id) do nothing;
  if p_item = 'dismissed' then
    update onboarding_person set dismissed_at = case when p_done then now() end where org_id = current_org() and person_id = me;
  else
    update onboarding_person set done = case when p_done then array(select distinct x from unnest(done || p_item) x) else array_remove(done, p_item) end
     where org_id = current_org() and person_id = me;
  end if;
  return onboarding_state();
end $$;

revoke all on function pulse.account_email_state(), pulse.account_email_verify_start(text, text), pulse.account_email_verify_finish(text),
  pulse.account_email_proven(text), pulse.signup_code_send(text, text), pulse.signup_code_check(text, text), pulse.account_onboard(jsonb, text, text),
  pulse.account_signup_onboard(jsonb, jsonb, text, text, text), pulse.onboard_invites(jsonb), pulse.onboard_invite_mailed(uuid[]),
  pulse.onboarding_state(), pulse.onboarding_mark(text, boolean) from public;
grant execute on function pulse.account_email_state(), pulse.account_email_verify_start(text, text), pulse.account_email_verify_finish(text),
  pulse.account_email_proven(text), pulse.signup_code_send(text, text), pulse.signup_code_check(text, text), pulse.account_onboard(jsonb, text, text),
  pulse.account_signup_onboard(jsonb, jsonb, text, text, text), pulse.onboard_invites(jsonb), pulse.onboard_invite_mailed(uuid[]),
  pulse.onboarding_state(), pulse.onboarding_mark(text, boolean) to pulse_api;

-- migrate:down
-- Forward-only: started companies, invitations and proven e-mails are kept.
