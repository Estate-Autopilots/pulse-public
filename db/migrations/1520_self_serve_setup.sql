-- migrate:up
-- SELF-SERVE (owner, 4 Nov 2026: "anyone can open Pulse, make an account and manage their life or work by their
-- type"). Four things, on top of ONBOARD-SELF (1462) and ACCOUNT-CODE (1465):
--
--  1. Who the person is: "Which describes you?" (employed, professional practice, freelancer, creator, business owner,
--     student, other; several at once), kept on the account (pulse_priv.account_kinds) and changed in Settings.
--  2. The space the sign-up makes: a personal space or an organisation of a kind (practice, agency, shop, maker,
--     real estate, school, NGO, other), set up from the answers by pulse.onboard_org (modules, the words for the people
--     served, starter projects) and here: its kind, its client types (pulse.record_type) and the getting-started cards
--     on its home (pulse.org_setup), all editable later. Passwordless sign-up (the 1465 code) makes the account and
--     the space in one step (account_signup_setup); a signed-in person starts another space (account_setup_start).
--  3. A professional's clients: appointments (pulse.client_appointment) the team books and the client sees in their
--     space; and the client's one-click way in: the invitation e-mailed to their address makes their account with no
--     password and opens their space (connect_join_quick). Only with the key that went into the e-mail alone (the
--     mailbox proves the address; the link shown to the professional to share has no key); an address that already has an account signs in first (a code to it), then opens the link.
--  4. The first-run guide reads the space's own cards (each found done from the space's rows, or ticked by hand).
-- Synthetic data only in tests; nothing here sends mail (the API does, through the mail sink in tests).

-- ------------------------------------------------------------------------------------------------ tables
create table pulse_priv.account_kinds (
  account_id  uuid primary key references pulse_priv.pulse_account(id) on delete cascade,
  kinds       text[] not null default '{}' check (kinds <@ array['employee','professional','freelancer','creator','owner','student','other']::text[] and cardinality(kinds) <= 7),
  updated_at  timestamptz not null default now()
);
revoke all on pulse_priv.account_kinds from public;

create table pulse.org_setup (
  org_id      uuid primary key references pulse.org(id),
  space       text not null check (space in ('personal','practice','agency','shop','maker','real_estate','school','ngo','other')),
  profiles    text[] not null default '{}' check (cardinality(profiles) <= 7),
  served      text not null default 'clients' check (served ~ '^[a-z_]{2,20}$'),
  cards       jsonb not null default '[]' check (jsonb_typeof(cards) = 'array' and jsonb_array_length(cards) <= 8 and pg_column_size(cards) < 8192),
  home        text check (home is null or home ~ '^/[a-z0-9/_-]{0,60}$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table pulse.org_setup enable row level security;
alter table pulse.org_setup force row level security;
create policy tenant on pulse.org_setup using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create table pulse.client_appointment (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  client_id     uuid not null references pulse.client(id) on delete cascade,
  starts_at     timestamptz not null,
  minutes       int not null default 50 check (minutes between 5 and 600),
  place         text check (place is null or length(place) <= 300),
  note          text check (note is null or length(note) <= 1000),
  status        text not null default 'booked' check (status in ('booked','cancelled')),
  created_by    uuid,                                      -- no foreign key (release smoke cleanup deletes people)
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz
);
create index client_appointment_org on pulse.client_appointment(org_id, starts_at);
create index client_appointment_client on pulse.client_appointment(client_id, starts_at);
alter table pulse.client_appointment enable row level security;
alter table pulse.client_appointment force row level security;
create policy tenant on pulse.client_appointment using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create trigger audit_mutation after insert or update or delete on pulse.client_appointment for each row execute function pulse.audit_mutation();

-- ------------------------------------------------------------------------------------------------ the space's setup
-- Inside a space just started (as its founder): its kind, cards and home, and its own client types (and neutral contact
-- types, so the install's real-estate defaults never appear in it). p: { space, profiles, served, clientTypes, cards, home }.
create function pulse.org_setup_apply(p_org uuid, p_person uuid, p jsonb) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare x jsonb; i int := 0;
begin
  if jsonb_typeof(p) <> 'object' then return; end if;
  perform acct_enter(p_org, p_person);
  insert into org_setup(org_id, space, profiles, served, cards, home)
  values (p_org, p ->> 'space', array(select left(k, 20) from jsonb_array_elements_text(coalesce(p -> 'profiles', '[]')) k limit 7),
    coalesce(nullif(p ->> 'served', ''), 'clients'), coalesce(p -> 'cards', '[]'), nullif(p ->> 'home', ''))
  on conflict (org_id) do nothing;
  for x in select e from jsonb_array_elements(coalesce(p -> 'clientTypes', '[]')) e limit 8 loop
    i := i + 1;
    insert into record_type(org_id, entity, key, label, plural, color, hint, sort, system)
    values (p_org, 'client', x ->> 'key', left(x ->> 'label', 40), left(x ->> 'plural', 48), coalesce(x ->> 'color', 'slate'), left(x ->> 'hint', 160), i * 10, false)
    on conflict do nothing;
  end loop;
  insert into record_type(org_id, entity, key, label, plural, color, hint, sort, system) values
    (p_org, 'client', 'internal', 'Internal', 'Internal', 'indigo', 'The organisation’s own work.', 800, true),
    (p_org, 'client', 'other', 'Other', 'Other', 'slate', 'Anyone else.', 900, true),
    (p_org, 'contact', 'vendor', 'Vendor', 'Vendors', 'amber', 'Supplies a service or goods.', 40, false),
    (p_org, 'contact', 'other', 'Other', 'Other', 'slate', 'Anyone else.', 900, true)
  on conflict do nothing;
  perform acct_leave();
end $$;
revoke all on function pulse.org_setup_apply(uuid, uuid, jsonb) from public;

-- The account's types, kept (several; the empty list clears them).
create function pulse.acct_profile_write(p_account uuid, p jsonb) returns text[]
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k text[];
begin
  if jsonb_typeof(p) <> 'array' then return null; end if;
  k := array(select distinct left(x, 20) from jsonb_array_elements_text(p) x);
  if not k <@ array['employee','professional','freelancer','creator','owner','student','other']::text[] then
    raise exception 'Choose from the listed kinds of person' using errcode = '22023'; end if;
  insert into pulse_priv.account_kinds(account_id, kinds) values (p_account, k)
  on conflict (account_id) do update set kinds = excluded.kinds, updated_at = now();
  return k;
end $$;
revoke all on function pulse.acct_profile_write(uuid, jsonb) from public;

-- Signed out: the 1465 sign-up code typed back with the details and the setup plan (services/api/src/self-serve-setup.ts):
-- the account (address proven, a password only when chosen), its types, its first space set up, and a session there.
-- Null for a wrong, used or expired code (as account_signup_confirm); refusals after a right code.
create function pulse.account_signup_setup(p jsonb, p_code text, p_hash text, p_device text, p_plan jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare e text := lower(btrim(coalesce(p ->> 'email', ''))); s pulse_priv.account_signup_code%rowtype; problem text; r jsonb; v uuid;
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@'));
  pw text := nullif(p ->> 'password', ''); v_person uuid;
begin
  select * into s from pulse_priv.account_signup_code where email = e for update;
  if not found or s.code_hash is null or s.expires_at < now() or s.tries >= 5 then perform acct_event(null, 'signup_code_failed', p_device); return null; end if;
  if encode(digest(regexp_replace(coalesce(p_code, ''), '\D', '', 'g') || ':' || e, 'sha256'), 'hex') <> s.code_hash then
    update pulse_priv.account_signup_code set tries = tries + 1, code_hash = case when tries + 1 >= 5 then null else code_hash end where email = e;
    perform acct_event(null, 'signup_code_failed', p_device); return null;
  end if;
  problem := account_signup_problem(p - 'orgName');
  if problem is not null then raise exception '%', problem using errcode = case when problem like 'Someone already has%' then '23505' else '22023' end; end if;
  if exists (select 1 from pulse_priv.pulse_account where email = e) then
    raise exception 'That e-mail already has a Pulse account: sign in with an e-mailed code instead' using errcode = '23505'; end if;
  if jsonb_typeof(p_plan) <> 'object' or jsonb_typeof(p_plan -> 'setup') <> 'object' then raise exception 'Choose what you will use Pulse for' using errcode = '22023'; end if;
  update pulse_priv.account_signup_code set code_hash = null, expires_at = null, tries = 0 where email = e;
  if h = '' then h := handle_suggest(n); end if;
  insert into pulse_priv.pulse_account(handle, display_name, email, password_hash, email_confirmed_at, email_verified_at)
  values (h, n, e, case when pw is null then null else crypt(pw, gen_salt('bf', 10)) end, now(), now()) returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  perform acct_profile_write(v, p_plan -> 'setup' -> 'profiles');
  r := onboard_org(v, p_plan, p_hash, p_device);
  select person_id into v_person from pulse_priv.account_member where account_id = v and member_org = (r ->> 'org')::uuid;
  perform org_setup_apply((r ->> 'org')::uuid, v_person, p_plan -> 'setup');
  perform acct_event(v, 'signup_code_used', p_device);
  return r || jsonb_build_object('personal', p_plan -> 'setup' ->> 'space' = 'personal', 'home', coalesce(p_plan -> 'setup' ->> 'home', '/'));
end $$;

-- Signed in: another space of mine (its e-mail proven, as account_onboard), set up from the second question.
create function pulse.account_setup_start(p_plan jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); r jsonb; v_person uuid;
begin
  if not account_email_ok(v) then raise exception 'Confirm your e-mail first: Pulse sends a 6-digit code to it' using errcode = '42501'; end if;
  if jsonb_typeof(p_plan) <> 'object' or jsonb_typeof(p_plan -> 'setup') <> 'object' then raise exception 'Choose what you will use Pulse for' using errcode = '22023'; end if;
  if jsonb_array_length(coalesce(p_plan -> 'setup' -> 'profiles', '[]')) > 0 then perform acct_profile_write(v, p_plan -> 'setup' -> 'profiles'); end if;
  r := onboard_org(v, p_plan, p_hash, p_device);
  select person_id into v_person from pulse_priv.account_member where account_id = v and member_org = (r ->> 'org')::uuid;
  perform org_setup_apply((r ->> 'org')::uuid, v_person, p_plan -> 'setup');
  return r || jsonb_build_object('home', coalesce(p_plan -> 'setup' ->> 'home', '/'));
end $$;

-- About you (Settings): the account's types, and this space's kind and words; the types are changed here.
create function pulse.account_about() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); o org_setup%rowtype;
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  select * into o from org_setup where org_id = current_org();
  return jsonb_build_object('profiles', coalesce(to_jsonb((select kinds from pulse_priv.account_kinds where account_id = v)), '[]'::jsonb),
    'account', v is not null,
    'space', case when o.org_id is null then null else jsonb_build_object('kind', o.space, 'served', o.served, 'since', o.created_at) end,
    'words', (select words from org_pack where org_id = current_org()),
    'admin', viewer_is('admin', 'leadership'));
end $$;
create function pulse.account_about_save(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure();
begin
  perform acct_profile_write(v, coalesce(p -> 'profiles', '[]'));
  return account_about();
end $$;

-- ------------------------------------------------------------------------------------------------ first-run guide
-- 1462's guide, now reading the space's own cards when it has a setup (labels, links and notes come with them). Card
-- keys found done from the space's rows: client, appointment, invoice, invite, project, todo, app; words by hand.
create or replace function pulse.onboarding_state() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); o org_onboarding%rowtype; r onboarding_person%rowtype; v_lead boolean; d text[]; s org_setup%rowtype;
  x jsonb; items jsonb := '[]'; k text; ok boolean;
begin
  if me is null then return null; end if;
  select * into o from org_onboarding where org_id = current_org();
  if not found then return null; end if;
  select * into r from onboarding_person where org_id = current_org() and person_id = me;
  d := coalesce(r.done, '{}');
  v_lead := viewer_is('admin', 'leadership');
  select * into s from org_setup where org_id = current_org();
  if v_lead then
    for x in select e from jsonb_array_elements(case when s.org_id is null then
        '[{"key":"invite"},{"key":"project"},{"key":"targets"},{"key":"app"}]'::jsonb else s.cards end) e loop
      k := x ->> 'key';
      ok := k = any(d) or case k
        when 'invite' then exists (select 1 from pulse_priv.org_invite where org_id = current_org())
          or (select count(*) from person where org_id = current_org() and status = 'active' and side = 'staff') > 1
        when 'project' then exists (select 1 from work_project where org_id = current_org() and coalesce(template_key, '') not like 'starter:%')
        when 'targets' then exists (select 1 from work_project where org_id = current_org() and due_on is not null)
        when 'app' then exists (select 1 from native_device where org_id = current_org() and person_id = me and revoked_at is null)
        when 'client' then exists (select 1 from client where org_id = current_org() and client_type <> 'internal')
        when 'appointment' then exists (select 1 from client_appointment where org_id = current_org())
        when 'invoice' then exists (select 1 from erp_document where org_id = current_org() and doc_type = 'invoice' and status <> 'draft')
        when 'todo' then (select count(*) from task t where t.org_id = current_org() and t.created_by = me
          and not exists (select 1 from work_project w where w.org_id = current_org() and w.project_id = t.project_id and coalesce(w.template_key, '') like 'starter:%')) >= 3
        else false end;
      items := items || (x || jsonb_build_object('key', k, 'done', ok));
    end loop;
  end if;
  return jsonb_build_object('org', (select name from org where id = current_org()), 'seat', onboarding_seat(me), 'lead', v_lead,
    'dismissed', r.dismissed_at is not null, 'templates', to_jsonb(o.templates), 'startedAt', o.created_at,
    'space', s.space, 'cards', s.org_id is not null, 'items', items);
end $$;

create or replace function pulse.onboarding_mark(p_item text, p_done boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  if me is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if not exists (select 1 from org_onboarding where org_id = current_org()) then raise exception 'This company has no getting-started guide' using errcode = 'P0002'; end if;
  if p_item not in ('invite', 'project', 'targets', 'app', 'dismissed', 'client', 'appointment', 'invoice', 'todo', 'words') then raise exception 'Choose an item' using errcode = '22023'; end if;
  insert into onboarding_person(org_id, person_id, seat) values (current_org(), me, onboarding_seat(me)) on conflict (person_id) do nothing;
  if p_item = 'dismissed' then
    update onboarding_person set dismissed_at = case when p_done then now() end where org_id = current_org() and person_id = me;
  else
    update onboarding_person set done = case when p_done then array(select distinct x from unnest(done || p_item) x) else array_remove(done, p_item) end
     where org_id = current_org() and person_id = me;
  end if;
  return onboarding_state();
end $$;

-- ------------------------------------------------------------------------------------------------ appointments
-- The team (any active staff colleague) books, moves and cancels a client's appointments; leadership and admins see
-- every one, a colleague the ones they booked or for clients they own.
create function pulse.appt_row(a pulse.client_appointment) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('id', a.id, 'clientId', a.client_id, 'client', (select display_name from client where id = a.client_id),
    'startsAt', a.starts_at, 'minutes', a.minutes, 'place', a.place, 'note', a.note, 'status', a.status,
    'by', (select display_name from person where id = a.created_by))
$$;
revoke all on function pulse.appt_row(pulse.client_appointment) from public;

create function pulse.appt_staff() returns uuid
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  if me is null or not exists (select 1 from person where id = me and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Appointments are booked by the team' using errcode = '42501'; end if;
  return me;
end $$;
revoke all on function pulse.appt_staff() from public;

-- Whose appointments a colleague may see, book, move and cancel (review, 5 Nov 2026: one rule for all four): admins and
-- leadership all of them; anyone else the ones they booked and those of the clients they look after.
create function pulse.appt_mine(p_client uuid, p_by uuid, p_me uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select viewer_is('admin', 'leadership') or (p_by is not null and p_by = p_me)
    or exists (select 1 from client c where c.id = p_client and c.org_id = current_org() and c.relationship_owner_id = p_me)
$$;
revoke all on function pulse.appt_mine(uuid, uuid, uuid) from public;

-- The kind of space this organisation was set up as by sign-up (null for every company set up another way, e.g. EA, AC,
-- WL): the menus offer Appointments and Add and invite only in such a space (review, 5 Nov 2026).
create function pulse.org_space() returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select space from org_setup where org_id = current_org()
$$;
revoke all on function pulse.org_space() from public;
grant execute on function pulse.org_space() to pulse_api;

create function pulse.appointment_save(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := appt_staff(); a client_appointment%rowtype; v_id uuid := nullif(p ->> 'id', '')::uuid; v_client uuid := nullif(p ->> 'clientId', '')::uuid;
  v_at timestamptz; v_min int;
begin
  begin v_at := (p ->> 'startsAt')::timestamptz; exception when others then v_at := null; end;
  if v_at is null then raise exception 'Choose the day and the time' using errcode = '22023'; end if;
  if v_at < now() - interval '1 day' then raise exception 'Choose a time from today on' using errcode = '22023'; end if;
  v_min := coalesce(nullif(p ->> 'minutes', '')::int, 50);
  if v_min not between 5 and 600 then raise exception 'An appointment lasts 5 minutes to 10 hours' using errcode = '22023'; end if;
  if v_id is null then
    if v_client is null or not exists (select 1 from client where id = v_client and org_id = current_org()) then raise exception 'Choose a client' using errcode = '22023'; end if;
    if not appt_mine(v_client, null, me) then raise exception 'You can book only for the clients you look after' using errcode = '42501'; end if;
    insert into client_appointment(org_id, client_id, starts_at, minutes, place, note, created_by)
    values (current_org(), v_client, v_at, v_min, nullif(left(btrim(coalesce(p ->> 'place', '')), 300), ''), nullif(left(btrim(coalesce(p ->> 'note', '')), 1000), ''), me)
    returning * into a;
  else
    update client_appointment set starts_at = v_at, minutes = v_min, place = nullif(left(btrim(coalesce(p ->> 'place', '')), 300), ''),
      note = nullif(left(btrim(coalesce(p ->> 'note', '')), 1000), '')
     where id = v_id and org_id = current_org() and status = 'booked' and appt_mine(client_id, created_by, me) returning * into a;
    if a.id is null then raise exception 'Appointment not found' using errcode = 'P0002'; end if;
  end if;
  return appt_row(a);
end $$;

create function pulse.appointment_cancel(p_id uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := appt_staff(); a client_appointment%rowtype;
begin
  update client_appointment set status = 'cancelled', cancelled_at = now()
   where id = p_id and org_id = current_org() and status = 'booked' and appt_mine(client_id, created_by, me) returning * into a;
  if a.id is null or me is null then raise exception 'Appointment not found' using errcode = 'P0002'; end if;
  return appt_row(a);
end $$;

-- Upcoming (from yesterday on) and the last 20 past, for the team; with the clients to book for.
create function pulse.appointment_list(p_client uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := appt_staff(); v_all boolean := viewer_is('admin', 'leadership');
begin
  return jsonb_build_object(
    'upcoming', coalesce((select jsonb_agg(appt_row(a) order by a.starts_at) from client_appointment a
      where a.org_id = current_org() and a.status = 'booked' and a.starts_at >= now() - interval '2 hours' and (p_client is null or a.client_id = p_client)
        and appt_mine(a.client_id, a.created_by, me)), '[]'::jsonb),
    'past', coalesce((select jsonb_agg(x.j order by x.s desc) from (select appt_row(a) j, a.starts_at s from client_appointment a
      where a.org_id = current_org() and (a.starts_at < now() - interval '2 hours' or a.status = 'cancelled') and (p_client is null or a.client_id = p_client)
        and appt_mine(a.client_id, a.created_by, me)
      order by a.starts_at desc limit 20) x), '[]'::jsonb),
    'clients', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.display_name) order by c.display_name) from (select id, display_name from client
      where org_id = current_org() and client_type <> 'internal' and coalesce(status, 'active') <> 'archived' and (v_all or relationship_owner_id = me)
      order by display_name limit 500) c), '[]'::jsonb));
end $$;

-- The client's own appointments, in their space (their client record's only).
create function pulse.cp_appointments() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v_conn uuid := cp_viewer_conn(); v_client uuid;
begin
  if v_conn is null then return '[]'::jsonb; end if;
  select client_id into v_client from pulse_priv.org_connection where id = v_conn;
  if v_client is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'startsAt', a.starts_at, 'minutes', a.minutes, 'place', a.place, 'note', a.note,
      'with', (select display_name from person where id = a.created_by)) order by a.starts_at)
    from client_appointment a where a.org_id = current_org() and a.client_id = v_client and a.status = 'booked' and a.starts_at >= now() - interval '2 hours'), '[]'::jsonb);
end $$;

-- ------------------------------------------------------------------------------------------------ one-click join
-- The proof of the address is a second secret that only the mailbox gets (review, 5 Nov 2026: the link the professional
-- copies or shares on WhatsApp is not proof that whoever opens it owns the address). The API makes it when it e-mails
-- the invitation, puts it in the e-mailed link only, never in its reply to the person who added the client, and keeps
-- its hash here. One click needs it; it works once. The shared link (no key) asks for details, as before.
alter table pulse_priv.connect_request add column quick_key_hash text;

create function pulse.client_invite_quick_key(p_request uuid, p_key text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if p_key is null or length(p_key) < 40 then raise exception 'Not possible' using errcode = '22023'; end if;
  update pulse_priv.connect_request set quick_key_hash = p_key
   where id = p_request and from_org = current_org() and status = 'open' and kind = 'client' and emailed_to is not null;
end $$;

-- What the invitation page needs to offer one click: the e-mailed link (the client link and the mailbox's key), for one
-- person, and whether that address already has an account (then: sign in first). Without the key: no one click.
create function pulse.connect_quick_peek(p_link text, p_key text) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when q.emailed_to is not null and q.kind = 'client' and q.join_connection is null and q.quick_key_hash is not null
      and p_key is not null and q.quick_key_hash = p_key
    then jsonb_build_object('oneClick', true, 'email', q.emailed_to,
      'hasAccount', exists (select 1 from pulse_priv.pulse_account a where a.email = q.emailed_to))
    else jsonb_build_object('oneClick', false) end
  from pulse_priv.connect_request q where q.token_hash = p_link and q.status = 'open' and q.expires_at > now()
$$;

-- One click: the account for the e-mailed address (no password, the address proven by the mailbox's key, a handle from
-- the name), the client's seat as an individual, and a session in their space. The key is spent.
create function pulse.connect_join_quick(p_link text, p_key text, p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare q pulse_priv.connect_request%rowtype; v uuid; h text; n text; r jsonb;
begin
  select * into q from pulse_priv.connect_request where token_hash = p_link and status = 'open' and expires_at > now() for update;
  if not found then raise exception 'This client link is no longer open. Ask for a new one.' using errcode = '22023'; end if;
  if q.emailed_to is null or q.kind <> 'client' or q.join_connection is not null or q.quick_key_hash is null
     or p_key is null or q.quick_key_hash <> p_key then
    raise exception 'This link needs your details: fill them in below' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.pulse_account where email = q.emailed_to) then
    raise exception 'That e-mail already has a Pulse account: sign in with an e-mailed code, then open this link again' using errcode = '23505'; end if;
  n := regexp_replace(btrim(coalesce(nullif(p ->> 'name', ''), q.contact_name)), '\s+', ' ', 'g');
  if length(n) not between 2 and 120 then raise exception 'Give your name' using errcode = '22023'; end if;
  update pulse_priv.connect_request set quick_key_hash = null where id = q.id;
  h := handle_suggest(n);
  insert into pulse_priv.pulse_account(handle, display_name, email, password_hash, email_confirmed_at, email_verified_at)
  values (h, n, q.emailed_to, null, now(), now()) returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  perform acct_event(v, 'client_join_quick', p_device);
  r := connect_accept_core(v, q.id, jsonb_build_object('mode', 'individual', 'history', coalesce(p ->> 'history', 'no')), true);
  return acct_session(v, (r ->> 'org')::uuid, p_hash, p_device) || jsonb_build_object('connection', r -> 'connection', 'newOrg', false, 'home', r -> 'home');
end $$;

revoke all on function pulse.account_signup_setup(jsonb, text, text, text, jsonb), pulse.account_setup_start(jsonb, text, text), pulse.account_about(),
  pulse.account_about_save(jsonb), pulse.appointment_save(jsonb), pulse.appointment_cancel(uuid), pulse.appointment_list(uuid), pulse.cp_appointments(),
  pulse.connect_quick_peek(text, text), pulse.connect_join_quick(text, text, jsonb, text, text), pulse.client_invite_quick_key(uuid, text) from public;
grant execute on function pulse.account_signup_setup(jsonb, text, text, text, jsonb), pulse.account_setup_start(jsonb, text, text), pulse.account_about(),
  pulse.account_about_save(jsonb), pulse.appointment_save(jsonb), pulse.appointment_cancel(uuid), pulse.appointment_list(uuid), pulse.cp_appointments(),
  pulse.connect_quick_peek(text, text), pulse.connect_join_quick(text, text, jsonb, text, text), pulse.client_invite_quick_key(uuid, text) to pulse_api;

-- migrate:down
-- Forward-only: accounts, spaces, their setup and appointments are kept.
