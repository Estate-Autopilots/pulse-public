-- migrate:up
-- CONNECT (owner, 23 Oct 2026): client connections between organisations on the same Pulse.
--
--  * A client request (pulse_priv.connect_request): when an organisation closes a deal it prepares everything the client
--    needs (company, contact, project, deal summary, its own point of contact) and gets a private link (shown once; the
--    dev mail is a sink, nothing is e-mailed). The client opens it, signs in or makes a Pulse account, sets up their own
--    organisation from the pre-filled details (or uses one they already run, or joins as an individual) and accepts.
--  * Accepting makes a connection (pulse_priv.org_connection) and a referral (pulse_priv.org_referral: the inviting
--    organisation brought the client to Pulse).
--  * Cross-organisation work goes through explicit shared objects only. Each side's points of contact get a SEAT in the
--    other organisation (pulse_priv.connect_seat): an ordinary person there with side 'client' (the client restrictions
--    of ORG apply: tasks and chats shared with them, nothing else), linked to their one Pulse account (kind 'client' for
--    the client's people, 'partner' for the inviting organisation's). Groups and tasks made for the connection live in
--    the organisation that made them and are recorded in pulse_priv.connect_share; the other side reaches them through
--    their seat. Nothing else of either organisation is visible to the other.
-- The tables carry no org_id: global, owner-only, reached only through the SECURITY DEFINER functions below
-- (allow-listed in tests/core/test_acceptance_isolation.py like ORG's).

alter table pulse_priv.account_member drop constraint if exists account_member_kind_check;
alter table pulse_priv.account_member add constraint account_member_kind_check check (kind in ('staff','freelancer','client','agent','partner'));

create table pulse_priv.connect_request (
  id               uuid primary key default gen_random_uuid(),
  from_org         uuid not null references pulse.org(id),
  token_hash       text not null unique,
  status           text not null default 'open' check (status in ('open','accepted','revoked')),
  company_name     text not null check (length(btrim(company_name)) between 2 and 80),
  contact_name     text not null check (length(btrim(contact_name)) between 2 and 120),
  contact_email    text check (contact_email is null or contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  contact_phone    text check (length(contact_phone) <= 40),
  project          text check (length(project) <= 160),
  summary          text check (length(summary) <= 2000),
  poc_person       uuid not null references pulse.person(id),
  created_by       uuid references pulse.person(id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '30 days',
  accepted_account uuid references pulse_priv.pulse_account(id),
  accepted_at      timestamptz,
  connection_id    uuid
);
create index connect_request_org on pulse_priv.connect_request(from_org, created_at desc);

create table pulse_priv.org_connection (
  id          uuid primary key default gen_random_uuid(),
  a_org       uuid not null references pulse.org(id),               -- the organisation that sent the request
  b_org       uuid references pulse.org(id),                        -- the client's organisation (null: an individual)
  b_account   uuid references pulse_priv.pulse_account(id),         -- the individual client (when b_org is null)
  kind        text not null default 'client' check (kind in ('client')),
  status      text not null default 'active' check (status in ('active','ended')),
  request_id  uuid references pulse_priv.connect_request(id),
  created_at  timestamptz not null default now(),
  check (b_org is distinct from a_org),
  check (b_org is not null or b_account is not null)
);
create unique index org_connection_pair on pulse_priv.org_connection(a_org, b_org) where b_org is not null and status = 'active';

create table pulse_priv.connect_seat (
  connection_id  uuid not null references pulse_priv.org_connection(id) on delete cascade,
  account_id     uuid not null references pulse_priv.pulse_account(id),
  home_org       uuid references pulse.org(id),          -- where they work (null: an individual client)
  home_person    uuid references pulse.person(id),
  seat_org       uuid not null references pulse.org(id), -- the other organisation
  seat_person    uuid not null references pulse.person(id),
  created_at     timestamptz not null default now(),
  primary key (connection_id, account_id)
);
create index connect_seat_person on pulse_priv.connect_seat(seat_person);

create table pulse_priv.connect_share (
  id             uuid primary key default gen_random_uuid(),
  connection_id  uuid not null references pulse_priv.org_connection(id) on delete cascade,
  host_org       uuid not null references pulse.org(id),
  kind           text not null check (kind in ('chat','task')),
  ref            uuid not null,
  created_by     uuid references pulse.person(id),
  created_at     timestamptz not null default now(),
  unique (host_org, kind, ref)
);

create table pulse_priv.org_referral (
  id                uuid primary key default gen_random_uuid(),
  referrer_org      uuid not null references pulse.org(id),
  referred_org      uuid references pulse.org(id),
  referred_account  uuid references pulse_priv.pulse_account(id),
  request_id        uuid references pulse_priv.connect_request(id),
  new_org           boolean not null,
  new_account       boolean not null,
  created_at        timestamptz not null default now()
);
revoke all on pulse_priv.connect_request, pulse_priv.org_connection, pulse_priv.connect_seat, pulse_priv.connect_share, pulse_priv.org_referral from public;

-- ------------------------------------------------------------------------------------------------ helpers
-- The Pulse account of a person in an organisation, made on first use (like account_ensure, for any person).
create function pulse.connect_account_of(p_org uuid, p_person uuid) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid; r record; h text;
begin
  select account_id into v from pulse_priv.account_member where member_org = p_org and person_id = p_person;
  if v is not null then return v; end if;
  perform acct_enter(p_org, null);
  select p.display_name, p.side, pp.username, lower(pp.email) email into r from person p left join people_profile pp on pp.person_id = p.id where p.id = p_person and p.org_id = p_org;
  perform acct_leave();
  if r.display_name is null then raise exception 'That person is not in this organisation' using errcode = 'P0002'; end if;
  h := handle_suggest(coalesce(nullif(replace(coalesce(r.username, ''), '.', ''), ''), r.display_name));
  insert into pulse_priv.pulse_account(handle, display_name, email, last_org)
  values (h, r.display_name, case when r.email is not null and not exists (select 1 from pulse_priv.pulse_account a where a.email = r.email) then r.email end, p_org)
  returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (v, p_org, p_person, acct_kind(r.side));
  return v;
end $$;

-- A seat for an account in the other organisation of a connection: its person there (side client: the ORG client rules
-- apply), linked to the account. Reuses the person when the account already has one there.
create function pulse.connect_seat_make(p_conn uuid, p_account uuid, p_home_org uuid, p_home_person uuid, p_seat_org uuid, p_kind text, p_title text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_person uuid; a pulse_priv.pulse_account%rowtype; v_no int; v_user text; n int := 1; v_kind text;
begin
  select person_id, kind into v_person, v_kind from pulse_priv.account_member where account_id = p_account and member_org = p_seat_org;
  if v_person is not null and v_kind not in ('client', 'partner') then
    raise exception 'This account is already on the team of the other organisation' using errcode = '23505'; end if;
  if v_person is null then
    select * into a from pulse_priv.pulse_account where id = p_account;
    perform acct_enter(p_seat_org, null);
    insert into person(org_id, display_name, side, status, active_from) values (p_seat_org, a.display_name, 'client', 'active', current_date) returning id into v_person;
    select coalesce(max(user_no), 0) + 1 into v_no from people_profile where org_id = p_seat_org;
    v_user := a.handle;
    while exists (select 1 from people_profile where org_id = p_seat_org and username = v_user) loop n := n + 1; v_user := a.handle || '.' || n; end loop;
    insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
    values (p_seat_org, v_person, left(p_title, 80), a.email, v_user, v_no, 'Connected organisation contact (@' || a.handle || ')', '{}');
    perform acct_leave();
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, p_seat_org, v_person, p_kind);
  end if;
  insert into pulse_priv.connect_seat(connection_id, account_id, home_org, home_person, seat_org, seat_person)
  values (p_conn, p_account, p_home_org, p_home_person, p_seat_org, v_person) on conflict do nothing;
  return v_person;
end $$;

-- A new organisation owned by an account, from the client request's details (Start your own Pulse, for an account that
-- may not be signed in anywhere yet). Returns its id.
create function pulse.connect_org_create(p_account uuid, p_name text, p_handle text, p_pack jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a pulse_priv.pulse_account%rowtype; v_org uuid := gen_random_uuid(); v_person uuid;
  n text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p_handle, '')), '@'));
  v_code text; v_letters text; k int := 0; v_slug text;
begin
  if length(n) not between 2 and 80 then raise exception 'Give your organisation a name of 2 to 80 characters' using errcode = '22023'; end if;
  if h = '' then h := handle_suggest(n); end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'An organisation handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%: choose another handle for your organisation', h using errcode = '23505'; end if;
  select * into a from pulse_priv.pulse_account where id = p_account;
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
  values (v_org, v_person, 'Owner', a.email, a.handle, 1, 'Started this organisation from a client invitation (@' || a.handle || ')', '{}');
  insert into role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, 'admin', current_date);
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (v_org, 'person', v_person, 'created', null, 'Started the organisation from a client invitation', null);
  if p_pack is not null and jsonb_typeof(p_pack) = 'object' then
    perform set_config('pulse.viewer_id', v_person::text, true);
    perform flow_pack_write(p_pack, true);
  end if;
  perform acct_leave();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, v_org, v_person, 'staff');
  return v_org;
end $$;

-- Accepting a client request for an account: the client's organisation (new, existing or none), the connection, both
-- sides' seats, the referral. Returns the organisation to open next and the connection.
create function pulse.connect_accept_core(p_account uuid, p_request uuid, p jsonb, p_new_account boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare q pulse_priv.connect_request%rowtype; v_mode text := coalesce(p ->> 'mode', 'new'); v_org uuid; v_conn uuid; v_new_org boolean := false;
  v_poc uuid; v_home uuid; v_from_name text; v_client_name text; ok boolean;
begin
  select * into q from pulse_priv.connect_request where id = p_request for update;
  if not found or q.status <> 'open' or q.expires_at <= now() then raise exception 'This client link is no longer open. Ask for a new one.' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.account_member where account_id = p_account and member_org = q.from_org and kind not in ('client', 'partner')) then
    raise exception 'You are on the team of the organisation that sent this link: send it to the client instead' using errcode = '42501'; end if;
  select name into v_from_name from org where id = q.from_org;
  if v_mode = 'new' then
    v_org := connect_org_create(p_account, coalesce(nullif(btrim(p ->> 'orgName'), ''), q.company_name), p ->> 'orgHandle', p -> 'pack');
    v_new_org := true;
  elsif v_mode = 'existing' then
    v_org := nullif(p ->> 'org', '')::uuid;
    select m.person_id into v_home from pulse_priv.account_member m where m.account_id = p_account and m.member_org = v_org and m.kind = 'staff';
    if v_home is null then raise exception 'Choose one of your organisations' using errcode = '42501'; end if;
    if v_org = q.from_org then raise exception 'That is the organisation that invited you' using errcode = '22023'; end if;
    perform acct_enter(v_org, v_home);
    ok := viewer_is('admin', 'leadership');
    perform acct_leave();
    if not ok then raise exception 'Only an admin or leader of that organisation connects it' using errcode = '42501'; end if;
    if exists (select 1 from pulse_priv.org_connection where a_org = q.from_org and b_org = v_org and status = 'active') then
      raise exception 'Your organisation is already connected with %', v_from_name using errcode = '23505'; end if;
  elsif v_mode = 'individual' then v_org := null;
  else raise exception 'Choose how you join' using errcode = '22023'; end if;
  select name into v_client_name from org where id = v_org;
  insert into pulse_priv.org_connection(a_org, b_org, b_account, request_id) values (q.from_org, v_org, case when v_org is null then p_account end, q.id) returning id into v_conn;
  v_home := (select person_id from pulse_priv.account_member where account_id = p_account and member_org = v_org);
  -- The client's seat in the inviting organisation.
  perform connect_seat_make(v_conn, p_account, v_org, v_home, q.from_org, 'client', 'Client · ' || coalesce(v_client_name, q.company_name));
  -- The inviting organisation's point of contact's seat in the client's organisation.
  if v_org is not null then
    v_poc := connect_account_of(q.from_org, q.poc_person);
    if v_poc = p_account then raise exception 'You are this link''s point of contact: send it to the client instead' using errcode = '42501'; end if;
    perform connect_seat_make(v_conn, v_poc, q.from_org, q.poc_person, v_org, 'partner', v_from_name || ' · point of contact');
  end if;
  update pulse_priv.connect_request set status = 'accepted', accepted_account = p_account, accepted_at = now(), connection_id = v_conn where id = q.id;
  insert into pulse_priv.org_referral(referrer_org, referred_org, referred_account, request_id, new_org, new_account)
  values (q.from_org, v_org, p_account, q.id, v_new_org, p_new_account);
  return jsonb_build_object('connection', v_conn, 'org', coalesce(v_org, q.from_org), 'newOrg', v_new_org);
end $$;
revoke all on function pulse.connect_account_of(uuid, uuid), pulse.connect_seat_make(uuid, uuid, uuid, uuid, uuid, text, text),
  pulse.connect_org_create(uuid, text, text, jsonb), pulse.connect_accept_core(uuid, uuid, jsonb, boolean) from public;

-- Is this person a seat of an active connection here (a connected organisation's contact)?
create function pulse.connect_is_seat(p_person uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from pulse_priv.connect_seat s join pulse_priv.org_connection c on c.id = s.connection_id and c.status = 'active'
                 where s.seat_person = p_person and s.seat_org = current_org())
    and exists (select 1 from person where id = p_person and org_id = current_org() and status = 'active')
$$;

-- Chats: a connected organisation's contact chats in the groups shared with them (CHAT rules otherwise unchanged).
create or replace function pulse.chat_active() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists(select 1 from person where id = current_viewer() and status = 'active' and side = 'staff') or agent_session() is not null
    or (current_viewer() is not null and connect_is_seat(current_viewer()))
$$;

-- Tasks: a connected organisation's contact works on the tasks given to them here (move, finish, comment); what they see
-- stays the ORG client rule (their own tasks only, task_visible_ids).
create or replace function pulse.task_person_ok(p_person uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists(select 1 from person where org_id = current_org() and id = p_person and side = 'staff' and status = 'active')
    or (p_person is not null and connect_is_seat(p_person))
$$;

-- ------------------------------------------------------------------------------------------------ the inviting side
create function pulse.connect_request_create(p jsonb, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_id uuid; v_poc uuid := coalesce(nullif(p ->> 'poc', '')::uuid, current_viewer()); e text := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
begin
  if not viewer_is('admin', 'leadership', 'hr') then raise exception 'Admins, HR and leadership send client requests' using errcode = '42501'; end if;
  if length(btrim(coalesce(p ->> 'company', ''))) not between 2 and 80 then raise exception 'Give the client''s company name' using errcode = '22023'; end if;
  if length(btrim(coalesce(p ->> 'contact', ''))) not between 2 and 120 then raise exception 'Give the client contact''s name' using errcode = '22023'; end if;
  if e is not null and e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Give a valid e-mail or leave it empty' using errcode = '22023'; end if;
  if not exists (select 1 from person where id = v_poc and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Choose a point of contact from your team' using errcode = '22023'; end if;
  insert into pulse_priv.connect_request(from_org, token_hash, company_name, contact_name, contact_email, contact_phone, project, summary, poc_person, created_by)
  values (current_org(), p_hash, btrim(p ->> 'company'), btrim(p ->> 'contact'), e, nullif(left(btrim(coalesce(p ->> 'phone', '')), 40), ''),
          nullif(left(btrim(coalesce(p ->> 'project', '')), 160), ''), nullif(left(btrim(coalesce(p ->> 'summary', '')), 2000), ''), v_poc, current_viewer())
  returning id into v_id;
  perform audit_write('invite', 'connect_request', v_id::text);
  return jsonb_build_object('id', v_id, 'org', (select name from org where id = current_org()), 'poc', (select display_name from person where id = v_poc));
end $$;

create function pulse.connect_request_list() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'company', q.company_name, 'contact', q.contact_name, 'email', q.contact_email, 'project', q.project,
    'status', case when q.status = 'open' and q.expires_at <= now() then 'expired' else q.status end, 'at', q.created_at, 'expiresAt', q.expires_at,
    'poc', (select display_name from person where id = q.poc_person), 'by', (select display_name from person where id = q.created_by),
    'joined', (select display_name from pulse_priv.pulse_account where id = q.accepted_account), 'connection', q.connection_id) order by q.created_at desc), '[]'::jsonb)
  from pulse_priv.connect_request q where q.from_org = current_org() and viewer_is('admin', 'leadership', 'hr') and q.created_at > now() - interval '180 days'
$$;

create function pulse.connect_request_revoke(p_id uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not viewer_is('admin', 'leadership', 'hr') then raise exception 'Admins, HR and leadership manage client requests' using errcode = '42501'; end if;
  update pulse_priv.connect_request set status = 'revoked' where id = p_id and from_org = current_org() and status = 'open';
end $$;

-- ------------------------------------------------------------------------------------------------ the client side
-- What a client link is for (before anyone signs in): who invites, the pre-filled details, nothing else.
create function pulse.connect_peek(p_hash text) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('from', o.name, 'fromHandle', o.handle, 'company', q.company_name, 'contact', q.contact_name, 'email', q.contact_email,
    'phone', q.contact_phone, 'project', q.project, 'summary', q.summary, 'poc', (select display_name from person where id = q.poc_person),
    'handleSuggestion', handle_suggest(q.company_name))
  from pulse_priv.connect_request q join org o on o.id = q.from_org
  where q.token_hash = p_hash and q.status = 'open' and q.expires_at > now() and o.status = 'active'
$$;

-- Signed in: accept with this account (a session in the organisation to open next is minted for the caller's token).
create function pulse.connect_accept(p_link text, p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); q uuid; r jsonb;
begin
  select id into q from pulse_priv.connect_request where token_hash = p_link;
  if q is null then raise exception 'This client link is no longer open. Ask for a new one.' using errcode = '22023'; end if;
  r := connect_accept_core(v, q, p, false);
  return acct_session(v, (r ->> 'org')::uuid, p_hash, p_device) || jsonb_build_object('connection', r -> 'connection', 'newOrg', r -> 'newOrg');
end $$;

-- Signed out: a new Pulse account (name, handle, e-mail, password), then accept with it.
create function pulse.connect_join(p_link text, p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare q uuid; v uuid; h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@')); e text := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); r jsonb;
begin
  select id into q from pulse_priv.connect_request where token_hash = p_link and status = 'open' and expires_at > now();
  if q is null then raise exception 'This client link is no longer open. Ask for a new one.' using errcode = '22023'; end if;
  if length(n) not between 2 and 120 then raise exception 'Give your name' using errcode = '22023'; end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'Your handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  if e is not null and e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Give a valid e-mail or leave it empty' using errcode = '22023'; end if;
  if e is not null and exists (select 1 from pulse_priv.pulse_account where email = e) then raise exception 'That e-mail already has a Pulse account: sign in instead' using errcode = '23505'; end if;
  insert into pulse_priv.pulse_account(handle, display_name, email, password_hash) values (h, n, e, crypt(p ->> 'password', gen_salt('bf', 10))) returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  r := connect_accept_core(v, q, p, true);
  return acct_session(v, (r ->> 'org')::uuid, p_hash, p_device) || jsonb_build_object('connection', r -> 'connection', 'newOrg', r -> 'newOrg');
end $$;

-- ------------------------------------------------------------------------------------------------ both sides
-- The other party of a connection as this organisation sees it.
create function pulse.connect_other_name(p_conn uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when c.a_org = current_org() then coalesce((select name from org where id = c.b_org), (select display_name from pulse_priv.pulse_account where id = c.b_account))
              else (select name from org where id = c.a_org) end
  from pulse_priv.org_connection c where c.id = p_conn
$$;

-- "with <organisation>" for a chat shared through a connection, from where the viewer stands: their seat's view names
-- the organisation they are visiting; everyone else sees the other party.
create function pulse.connect_chat_label(p_channel uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when connect_is_seat(current_viewer()) then (select name from org where id = current_org()) else connect_other_name(s.connection_id) end
  from pulse_priv.connect_share s where s.host_org = current_org() and s.kind = 'chat' and s.ref = p_channel limit 1
$$;

-- One shared object as the viewer may see it (title, state, where it lives), or null.
create function pulse.connect_share_card(p_share uuid, p_viewer uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s pulse_priv.connect_share%rowtype; r jsonb; v_name text;
begin
  select * into s from pulse_priv.connect_share where id = p_share;
  if not found then return null; end if;
  select name into v_name from org where id = s.host_org;
  perform acct_enter(s.host_org, p_viewer);
  if s.kind = 'chat' then
    select jsonb_build_object('id', s.id, 'kind', 'chat', 'ref', ch.id, 'title', ch.name, 'hostOrg', s.host_org, 'hostName', v_name,
      'members', (select count(*)::int from chat_member cm where cm.channel_id = ch.id),
      'lastAt', (select max(created_at) from chat_message where channel_id = ch.id),
      'last', (select left(m.body, 140) from chat_message m where m.channel_id = ch.id and m.removed_at is null and m.kind = 'text' order by m.created_at desc limit 1),
      'lastBy', (select p.display_name from chat_message m join person p on p.id = m.author_id where m.channel_id = ch.id and m.removed_at is null and m.kind = 'text' order by m.created_at desc limit 1))
    into r from chat_channel ch
    where ch.id = s.ref and (exists (select 1 from chat_member cm where cm.channel_id = ch.id and cm.person_id = p_viewer) or viewer_is('admin', 'leadership'));
  else
    select jsonb_build_object('id', s.id, 'kind', 'task', 'ref', t.id, 'title', t.title, 'hostOrg', s.host_org, 'hostName', v_name, 'status', t.status,
      'assignee', (select display_name from person where id = t.assignee_person_id), 'by', (select display_name from person where id = t.created_by),
      'dueAt', t.due_at, 'doneAt', t.done_at, 'updatedAt', t.updated_at)
    into r from task t
    where t.id = s.ref and t.deleted_at is null and (p_viewer in (t.owner_id, t.assignee_person_id, t.review_owner_id, t.created_by) or viewer_is('admin', 'leadership'));
  end if;
  perform acct_leave();
  return r;
end $$;
revoke all on function pulse.connect_share_card(uuid, uuid) from public;

-- This organisation's connections: the other party, both sides' points of contact, and the groups and tasks shared
-- in it that the viewer takes part in (here, or there through their own seat).
create function pulse.connect_list() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out jsonb := '[]'; c record; v_acct uuid := account_of_viewer(); v_seat uuid; v_items jsonb; x record; card jsonb;
begin
  if current_viewer() is null then return out; end if;
  for c in select * from pulse_priv.org_connection where status = 'active' and (a_org = current_org() or b_org = current_org()) order by created_at desc loop
    v_items := '[]';
    for x in select id, host_org from pulse_priv.connect_share where connection_id = c.id order by created_at desc loop
      v_seat := null;
      if x.host_org <> current_org() then
        select seat_person into v_seat from pulse_priv.connect_seat where connection_id = c.id and account_id = v_acct and seat_org = x.host_org;
        if v_seat is null then continue; end if;
        card := connect_share_card(x.id, v_seat);
      else
        card := connect_share_card(x.id, current_viewer());
      end if;
      if card is not null then v_items := v_items || jsonb_build_array(card || jsonb_build_object('here', x.host_org = current_org())); end if;
    end loop;
    out := out || jsonb_build_array(jsonb_build_object(
      'id', c.id, 'since', c.created_at, 'kind', c.kind, 'weInvited', c.a_org = current_org(),
      'other', jsonb_build_object('org', case when c.a_org = current_org() then c.b_org else c.a_org end, 'name', connect_other_name(c.id),
        'handle', (select handle from org where id = case when c.a_org = current_org() then c.b_org else c.a_org end), 'individual', c.b_org is null),
      'project', (select project from pulse_priv.connect_request where id = c.request_id),
      'summary', (select summary from pulse_priv.connect_request where id = c.request_id),
      -- Our people with a seat there (their names as we know them), and their people with a seat here (assignable here).
      'ours', coalesce((select jsonb_agg(jsonb_build_object('person', s.home_person, 'name', (select display_name from person where id = s.home_person), 'me', s.home_person = current_viewer()))
        from pulse_priv.connect_seat s where s.connection_id = c.id and s.home_org = current_org()), '[]'::jsonb),
      'theirs', coalesce((select jsonb_agg(jsonb_build_object('person', s.seat_person, 'name', p.display_name, 'role', pp.role))
        from pulse_priv.connect_seat s join person p on p.id = s.seat_person left join people_profile pp on pp.person_id = p.id where s.connection_id = c.id and s.seat_org = current_org()), '[]'::jsonb),
      'mySeat', exists (select 1 from pulse_priv.connect_seat s where s.connection_id = c.id and s.account_id = v_acct and s.seat_org <> current_org()),
      'shared', v_items));
  end loop;
  return out;
end $$;

-- Groups shared with the viewer from other organisations (their seat is a member), for their own Chats list.
create function pulse.connect_shared_chats() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out jsonb := '[]'; v_acct uuid := account_of_viewer(); x record; card jsonb;
begin
  if v_acct is null then return out; end if;
  for x in select sh.id, s.seat_person from pulse_priv.connect_seat s join pulse_priv.org_connection c on c.id = s.connection_id and c.status = 'active'
            join pulse_priv.connect_share sh on sh.connection_id = s.connection_id and sh.host_org = s.seat_org and sh.kind = 'chat'
            where s.account_id = v_acct and s.seat_org <> current_org() and s.home_org is not distinct from current_org() loop
    card := connect_share_card(x.id, x.seat_person);
    if card is not null then out := out || jsonb_build_array(card); end if;
  end loop;
  return out;
end $$;

-- A group for a connection, in this organisation: our people and their seats here, nobody else's.
create function pulse.connect_group_create(p_conn uuid, p_name text, p_members uuid[]) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid; n text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); theirs int;
begin
  if not exists (select 1 from pulse_priv.org_connection where id = p_conn and status = 'active' and current_org() in (a_org, b_org)) then
    raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from person where id = current_viewer() and side = 'staff' and status = 'active') then
    raise exception 'Groups for a connection are made by the team' using errcode = '42501'; end if;
  if length(n) not between 2 and 60 then raise exception 'Name the group (2 to 60 characters)' using errcode = '22023'; end if;
  if coalesce(cardinality(p_members), 0) = 0 or cardinality(p_members) > 256 then raise exception 'Add between 1 and 256 people' using errcode = '22023'; end if;
  select count(*) into theirs from pulse_priv.connect_seat s where s.connection_id = p_conn and s.seat_org = current_org() and s.seat_person = any(p_members);
  if theirs = 0 then raise exception 'Add at least one person from %', connect_other_name(p_conn) using errcode = '22023'; end if;
  insert into chat_channel(org_id, key, name, kind, description, created_by)
  values (current_org(), 'custom:' || gen_random_uuid(), n, 'custom', 'Shared with ' || connect_other_name(p_conn), current_viewer()) returning id into cid;
  insert into chat_member(org_id, channel_id, person_id, role) values (current_org(), cid, current_viewer(), 'admin');
  insert into chat_member(org_id, channel_id, person_id) select current_org(), cid, p.id from person p
  where p.org_id = current_org() and p.id = any(p_members) and p.id <> current_viewer() and p.status = 'active'
    and (p.side = 'staff' or exists (select 1 from pulse_priv.connect_seat s where s.connection_id = p_conn and s.seat_person = p.id and s.seat_org = current_org()))
  on conflict do nothing;
  insert into pulse_priv.connect_share(connection_id, host_org, kind, ref, created_by) values (p_conn, current_org(), 'chat', cid, current_viewer());
  perform chat_event_line(cid, current_viewer(), 'created the group “' || n || '” with ' || connect_other_name(p_conn));
  perform audit_write('create', 'connect_share', cid::text);
  return cid;
end $$;

-- A task for the other organisation's contact (their seat here). It lives here; the giver reviews it.
create function pulse.connect_task_give(p_conn uuid, p jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_to uuid := nullif(p ->> 'assigneeId', '')::uuid; tid uuid; me uuid := current_viewer();
begin
  if not exists (select 1 from pulse_priv.org_connection where id = p_conn and status = 'active' and current_org() in (a_org, b_org)) then
    raise exception 'Connection not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from person where id = me and side = 'staff' and status = 'active') then
    raise exception 'Tasks for a connection are given by the team' using errcode = '42501'; end if;
  if not exists (select 1 from pulse_priv.connect_seat s where s.connection_id = p_conn and s.seat_org = current_org() and s.seat_person = v_to) then
    raise exception 'Choose a contact of %', connect_other_name(p_conn) using errcode = '22023'; end if;
  tid := task_save(null, jsonb_build_object('title', p ->> 'title', 'notes', coalesce(p ->> 'notes', ''), 'dueOn', nullif(p ->> 'dueOn', ''), 'assigneeId', me, 'reviewerId', null));
  update task set assignee_person_id = v_to, owner_id = v_to, review_owner_id = me, assigned_at = now() where id = tid;
  perform task_event_add(tid, 'assigned', null, (select display_name from person where id = v_to) || ' (' || connect_other_name(p_conn) || ')');
  insert into pulse_priv.connect_share(connection_id, host_org, kind, ref, created_by) values (p_conn, current_org(), 'task', tid, me);
  return tid;
end $$;

revoke all on function pulse.connect_is_seat(uuid), pulse.connect_request_create(jsonb, text), pulse.connect_request_list(), pulse.connect_request_revoke(uuid),
  pulse.connect_peek(text), pulse.connect_accept(text, jsonb, text, text), pulse.connect_join(text, jsonb, text, text), pulse.connect_other_name(uuid),
  pulse.connect_chat_label(uuid), pulse.connect_list(), pulse.connect_shared_chats(), pulse.connect_group_create(uuid, text, uuid[]), pulse.connect_task_give(uuid, jsonb) from public;
grant execute on function pulse.connect_is_seat(uuid), pulse.connect_request_create(jsonb, text), pulse.connect_request_list(), pulse.connect_request_revoke(uuid),
  pulse.connect_peek(text), pulse.connect_accept(text, jsonb, text, text), pulse.connect_join(text, jsonb, text, text), pulse.connect_other_name(uuid),
  pulse.connect_chat_label(uuid), pulse.connect_list(), pulse.connect_shared_chats(), pulse.connect_group_create(uuid, text, uuid[]), pulse.connect_task_give(uuid, jsonb) to pulse_api;

-- migrate:down
