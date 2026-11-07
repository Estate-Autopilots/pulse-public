-- migrate:up
-- ORG (owner, 22 Oct 2026): one Pulse account per human across organisations on the same Pulse.
--
--  * Every organisation gets a handle (@estateautopilots): pulse.org.handle, unique, in one namespace with people's
--    handles (pulse_priv.handle_name), so "@name" always means one thing.
--  * pulse_priv.pulse_account is the sign-in identity of a human; pulse_priv.account_member links it to the person it is
--    in each organisation (staff, freelancer, client, agent). Nothing in an organisation is copied or shared by this:
--    the person rows stay in their own organisation under its row-level security.
--  * Switching organisation mints an ordinary pulse.login_session in the other organisation for the linked person
--    (via 'account'), so every request keeps running inside exactly one organisation.
--  * The portable profile (headline, about, skills, links), badges and the history highlights a person chooses to
--    carry live on the account; each organisation sees only what the person shares with it (pulse_priv.account_share).
--  * pulse_priv.org_invite: an organisation's invitations (to a handle, or as a private link) for staff, freelancers
--    and clients. "Start your own Pulse" creates an organisation owned by the account (account_start_org).
-- The account tables carry no org_id: they are global, owner-only (no grants to any runtime role) and reached only
-- through the SECURITY DEFINER functions below (allow-listed in tests/core/test_acceptance_isolation.py).
-- Safe on a live install: additive; the one existing organisation gets a handle; nobody gets an account until they
-- claim one.

-- ------------------------------------------------------------------------------------------------ handles
alter table pulse.org add column handle text;
alter table pulse.org add constraint org_handle_check check (handle is null or handle ~ '^[a-z0-9][a-z0-9._]{2,29}$');
create unique index org_handle_key on pulse.org(handle) where handle is not null;

create table pulse_priv.handle_name (
  handle      text primary key check (handle ~ '^[a-z0-9][a-z0-9._]{2,29}$'),
  kind        text not null check (kind in ('org','person')),
  ref         uuid not null,
  created_at  timestamptz not null default now()
);

-- A handle from any text: lower-case letters and digits, at least three, made unique with a number.
create function pulse.handle_suggest(p_base text) returns text
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v_base text := left(regexp_replace(lower(coalesce(p_base, '')), '[^a-z0-9]', '', 'g'), 26); v text; n int := 1;
begin
  if length(v_base) < 3 then v_base := rpad(coalesce(nullif(v_base, ''), 'pulse'), 3, '0'); end if;
  v := v_base;
  while exists (select 1 from pulse_priv.handle_name where handle = v) or exists (select 1 from org where handle = v) loop
    n := n + 1; v := v_base || n;
  end loop;
  return v;
end $$;

-- Every existing organisation gets a handle from its name (Estate Autopilots → estateautopilots).
do $$ declare o record; h text; begin
  for o in select id, name from pulse.org order by created_at, id loop
    h := pulse.handle_suggest(o.name);
    perform set_config('pulse.org_id', o.id::text, true);
    update pulse.org set handle = h where id = o.id and handle is null;
    insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'org', o.id) on conflict do nothing;
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;

-- Every new organisation (the setup wizard, Start your own Pulse, an install's first company) gets a handle too.
create function pulse.org_handle_default() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if tg_op = 'INSERT' and new.handle is null then new.handle := handle_suggest(new.name); end if;
  if new.handle is not null and not exists (select 1 from pulse_priv.handle_name where handle = new.handle) then
    insert into pulse_priv.handle_name(handle, kind, ref) values (new.handle, 'org', new.id);
  end if;
  return new;
end $$;
create trigger org_handle_default before insert on pulse.org for each row execute function pulse.org_handle_default();
revoke all on function pulse.org_handle_default() from public;

-- ------------------------------------------------------------------------------------------------ accounts
create table pulse_priv.pulse_account (
  id             uuid primary key default gen_random_uuid(),
  handle         text not null unique check (handle ~ '^[a-z0-9][a-z0-9._]{2,29}$'),
  display_name   text not null check (length(btrim(display_name)) between 1 and 120),
  email          text unique check (email is null or email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  password_hash  text,                                   -- bcrypt; null: signs in through an organisation only
  last_org       uuid references pulse.org(id),
  failed         int not null default 0,
  locked_until   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create table pulse_priv.account_member (
  account_id    uuid not null references pulse_priv.pulse_account(id) on delete cascade,
  member_org    uuid not null references pulse.org(id),
  person_id     uuid not null unique references pulse.person(id) on delete cascade,
  kind          text not null check (kind in ('staff','freelancer','client','agent')),
  joined_at     timestamptz not null default now(),
  last_used_at  timestamptz,
  primary key (account_id, member_org)
);
create table pulse_priv.account_profile (
  account_id  uuid primary key references pulse_priv.pulse_account(id) on delete cascade,
  headline    text check (length(headline) <= 120),
  about       text check (length(about) <= 2000),
  skills      text[] not null default '{}',
  links       jsonb not null default '[]',
  updated_at  timestamptz not null default now()
);
create table pulse_priv.account_badge (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references pulse_priv.pulse_account(id) on delete cascade,
  from_org       uuid references pulse.org(id),
  from_org_name  text not null,
  title          text not null check (length(btrim(title)) between 2 and 80),
  note           text check (length(note) <= 300),
  given_by_name  text,
  earned_on      date not null default current_date,
  carried        boolean not null default true,
  created_at     timestamptz not null default now()
);
create table pulse_priv.account_highlight (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references pulse_priv.pulse_account(id) on delete cascade,
  from_org       uuid references pulse.org(id),
  from_org_name  text not null,
  title          text not null check (length(btrim(title)) between 2 and 160),
  detail         text check (length(detail) <= 500),
  on_date        date,
  created_at     timestamptz not null default now()
);
create table pulse_priv.account_share (
  account_id  uuid not null references pulse_priv.pulse_account(id) on delete cascade,
  member_org  uuid not null references pulse.org(id),
  profile     boolean not null default true,
  skills      boolean not null default true,
  badges      boolean not null default true,
  highlights  boolean not null default true,
  primary key (account_id, member_org)
);
revoke all on pulse_priv.handle_name, pulse_priv.pulse_account, pulse_priv.account_member, pulse_priv.account_profile,
  pulse_priv.account_badge, pulse_priv.account_highlight, pulse_priv.account_share from public;

-- Sessions minted by an account switch are marked (via 'account'); they need no organisation password of their own.
do $$ declare c text; begin
  for c in select conname from pg_constraint where conrelid = 'pulse.login_session'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%via%' loop
    execute format('alter table pulse.login_session drop constraint %I', c);
  end loop;
end $$;
alter table pulse.login_session add constraint login_session_via_check check (via in ('password','google','account'));
-- The schema owner (SECURITY DEFINER functions) may find which organisation a live session belongs to.
create policy directory on pulse.login_session for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));

-- ------------------------------------------------------------------------------------------------ invitations
create table pulse_priv.org_invite (
  org_id            uuid not null references pulse.org(id),
  id                uuid primary key default gen_random_uuid(),
  kind              text not null check (kind in ('staff','freelancer','client')),
  title             text check (length(title) <= 80),
  to_handle         text,
  token_hash        text unique,
  status            text not null default 'open' check (status in ('open','accepted','revoked')),
  invited_by        uuid references pulse.person(id),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null default now() + interval '14 days',
  accepted_account  uuid references pulse_priv.pulse_account(id),
  accepted_person   uuid references pulse.person(id),
  accepted_at       timestamptz
);
create index org_invite_handle on pulse_priv.org_invite(to_handle) where status = 'open';
alter table pulse_priv.org_invite enable row level security;
alter table pulse_priv.org_invite force row level security;
create policy tenant on pulse_priv.org_invite using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy directory on pulse_priv.org_invite for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));

-- ------------------------------------------------------------------------------------------------ helpers
-- Step into another organisation for the rest of a function and back (like tenant_enter, without the operator).
create function pulse.acct_enter(p_org uuid, p_viewer uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform set_config('pulse.acct_return', coalesce(current_setting('pulse.org_id', true), '') || '|' || coalesce(current_setting('pulse.viewer_id', true), ''), true);
  perform set_config('pulse.org_id', p_org::text, true);
  perform set_config('pulse.viewer_id', coalesce(p_viewer::text, ''), true);
end $$;
create function pulse.acct_leave() returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b text[] := string_to_array(coalesce(current_setting('pulse.acct_return', true), ''), '|');
begin
  perform set_config('pulse.org_id', coalesce(b[1], ''), true);
  perform set_config('pulse.viewer_id', coalesce(b[2], ''), true);
  perform set_config('pulse.acct_return', '', true);
end $$;
revoke all on function pulse.acct_enter(uuid, uuid), pulse.acct_leave(), pulse.handle_suggest(text) from public;

create function pulse.account_of_viewer() returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select account_id from pulse_priv.account_member where member_org = current_org() and person_id = current_viewer()
$$;
revoke all on function pulse.account_of_viewer() from public;

-- The member kind of a person, from its side in its organisation.
create function pulse.acct_kind(p_side text) returns text language sql immutable as $$
  select case p_side when 'freelancer' then 'freelancer' when 'client' then 'client' when 'agent' then 'agent' else 'staff' end
$$;

-- An account for the signed-in person, made on first use: a handle from their username or name, their work e-mail when
-- no other account uses it.
create function pulse.account_ensure() returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); r record; h text;
begin
  if v is not null then return v; end if;
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  select p.display_name, p.side, pp.username, lower(pp.email) email into r from person p left join people_profile pp on pp.person_id = p.id where p.id = current_viewer();
  h := handle_suggest(coalesce(nullif(split_part(coalesce(r.username, ''), '.', 1) || split_part(coalesce(r.username, ''), '.', 2), ''), r.display_name));
  insert into pulse_priv.pulse_account(handle, display_name, email, last_org)
  values (h, r.display_name, case when r.email is not null and not exists (select 1 from pulse_priv.pulse_account a where a.email = r.email) then r.email end, current_org())
  returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind, last_used_at) values (v, current_org(), current_viewer(), acct_kind(r.side), now());
  return v;
end $$;
revoke all on function pulse.account_ensure() from public;

-- A session for the account's person in an organisation (the caller hashes the token). Null when it may not sign in there.
create function pulse.acct_session(p_account uuid, p_org uuid, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m record; o record; ok boolean;
begin
  select * into m from pulse_priv.account_member where account_id = p_account and member_org = p_org;
  if not found then return null; end if;
  select id, name, handle, status, activation into o from org where id = p_org;
  if o.status <> 'active' then return null; end if;
  perform acct_enter(p_org, null);
  select exists (select 1 from person where id = m.person_id and status = 'active') into ok;
  if ok then
    insert into login_session(org_id, person_id, token_hash, expires_at, device, remembered, via)
    values (p_org, m.person_id, p_hash, now() + interval '30 days', left(coalesce(p_device, 'Browser'), 120), true, 'account');
  end if;
  perform acct_leave();
  if not ok then return null; end if;
  update pulse_priv.account_member set last_used_at = now() where account_id = p_account and member_org = p_org;
  update pulse_priv.pulse_account set last_org = p_org, updated_at = now() where id = p_account;
  return jsonb_build_object('org', p_org, 'name', o.name, 'handle', o.handle, 'person', m.person_id, 'kind', m.kind, 'install', p_org = install_org());
end $$;
revoke all on function pulse.acct_session(uuid, uuid, text, text) from public;

-- ------------------------------------------------------------------------------------------------ the API's calls
-- Which organisation a live account session belongs to (the API's front door, before the request picks its
-- organisation). Only sessions a Pulse account opened (via 'account') travel to the shared address: a session signed in
-- at a company's own address stays at that address (test_tenant_isolation).
create function pulse.session_org(p_hash text) returns table(org_id uuid, status text, rehearsal boolean)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select s.org_id, o.status, o.rehearsal from login_session s join org o on o.id = s.org_id
   where s.token_hash = p_hash and s.via = 'account' and s.revoked_at is null and s.expires_at > now()
$$;

-- The signed-in person's account, organisations and invitations waiting for them.
create function pulse.account_me() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); a record; r record; v_suggest text;
begin
  if current_viewer() is null then return null; end if;
  if v is null then
    select p.display_name, pp.username into r from person p left join people_profile pp on pp.person_id = p.id where p.id = current_viewer();
    v_suggest := handle_suggest(coalesce(nullif(replace(coalesce(r.username, ''), '.', ''), ''), r.display_name));
    return jsonb_build_object('account', null, 'suggestion', v_suggest,
      'orgs', jsonb_build_array((select jsonb_build_object('id', o.id, 'name', o.name, 'handle', o.handle, 'code', o.code, 'kind', 'staff', 'current', true) from org o where o.id = current_org())),
      'invites', '[]'::jsonb);
  end if;
  select * into a from pulse_priv.pulse_account where id = v;
  return jsonb_build_object(
    'account', jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.display_name, 'email', a.email, 'hasPassword', a.password_hash is not null),
    'orgs', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'handle', o.handle, 'code', o.code, 'kind', m.kind,
        'current', o.id = current_org(), 'lastUsedAt', m.last_used_at, 'install', o.id = install_org()) order by (o.id = current_org()) desc, m.last_used_at desc nulls last, o.name)
      from pulse_priv.account_member m join org o on o.id = m.member_org where m.account_id = v and o.status = 'active'), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'org', o.name, 'orgHandle', o.handle, 'kind', i.kind, 'title', i.title, 'at', i.created_at) order by i.created_at desc)
      from pulse_priv.org_invite i join org o on o.id = i.org_id
      where i.to_handle = a.handle and i.status = 'open' and i.expires_at > now() and o.status = 'active'
        and not exists (select 1 from pulse_priv.account_member m where m.account_id = v and m.member_org = i.org_id)), '[]'::jsonb));
end $$;

-- Claim (or change) the handle, and optionally set the account password (the caller checks its strength).
create function pulse.account_claim(p_handle text, p_password text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
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
end $$;

-- Switch: a session in another organisation of the same account.
create function pulse.account_switch(p_org uuid, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); r jsonb;
begin
  if v is null then v := account_ensure(); end if;
  r := acct_session(v, p_org, p_hash, p_device);
  if r is null then raise exception 'You are not a member of that organisation' using errcode = '42501'; end if;
  return r;
end $$;

-- Sign in with the account (handle or e-mail and its password) at the shared address: into the last organisation used.
create function pulse.account_sign_in(p_login text, p_password text, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare a pulse_priv.pulse_account%rowtype; l text := lower(btrim(coalesce(p_login, ''))); target uuid; r jsonb;
begin
  select * into a from pulse_priv.pulse_account where handle = ltrim(l, '@') or email = l limit 1;
  if not found or a.password_hash is null then perform crypt('x', gen_salt('bf', 10)); return null; end if;
  if a.locked_until > now() then return jsonb_build_object('failed', true, 'locked', true); end if;
  if crypt(coalesce(p_password, ''), a.password_hash) <> a.password_hash then
    update pulse_priv.pulse_account set failed = case when failed >= 4 then 0 else failed + 1 end,
      locked_until = case when failed >= 4 then now() + interval '15 minutes' end where id = a.id;
    return jsonb_build_object('failed', true);
  end if;
  update pulse_priv.pulse_account set failed = 0, locked_until = null where id = a.id;
  for target in select m.member_org from pulse_priv.account_member m join org o on o.id = m.member_org and o.status = 'active'
      where m.account_id = a.id order by (m.member_org = a.last_org) desc, m.last_used_at desc nulls last loop
    r := acct_session(a.id, target, p_hash, p_device);
    if r is not null then return r; end if;
  end loop;
  return jsonb_build_object('failed', true, 'noOrg', true);
end $$;

-- Link the signed-in person (in this organisation) to an existing account, proven by that account's password.
create function pulse.account_link(p_login text, p_password text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare a pulse_priv.pulse_account%rowtype; l text := lower(btrim(coalesce(p_login, ''))); s text;
begin
  if current_viewer() is null then raise exception 'Sign in as a person first' using errcode = '42501'; end if;
  if account_of_viewer() is not null then raise exception 'You already have a Pulse account here' using errcode = '23505'; end if;
  select * into a from pulse_priv.pulse_account where handle = ltrim(l, '@') or email = l limit 1;
  if not found or a.password_hash is null or crypt(coalesce(p_password, ''), a.password_hash) <> a.password_hash then
    raise exception 'That handle and password do not match a Pulse account' using errcode = '28000'; end if;
  if exists (select 1 from pulse_priv.account_member where account_id = a.id and member_org = current_org()) then
    raise exception 'That account already has someone in this organisation' using errcode = '23505'; end if;
  select side into s from person where id = current_viewer();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind, last_used_at) values (a.id, current_org(), current_viewer(), acct_kind(s), now());
  return account_me();
end $$;

-- ------------------------------------------------------------------------------------------------ invitations
create function pulse.org_invite_create(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_kind text := coalesce(p ->> 'kind', 'staff'); v_handle text := nullif(lower(ltrim(btrim(coalesce(p ->> 'toHandle', '')), '@')), ''); v_id uuid;
begin
  if not viewer_is('admin', 'leadership', 'hr') then raise exception 'Admins, HR and leadership invite people into the organisation' using errcode = '42501'; end if;
  if v_kind not in ('staff', 'freelancer', 'client') then raise exception 'Choose staff, freelancer or client' using errcode = '22023'; end if;
  if v_handle is not null and not exists (select 1 from pulse_priv.handle_name where handle = v_handle and kind = 'person') then
    raise exception 'Nobody on Pulse has @%', v_handle using errcode = 'P0002'; end if;
  if v_handle is null and coalesce(p ->> 'hash', '') = '' then raise exception 'Invite a handle or make a private link' using errcode = '22023'; end if;
  if v_handle is not null and exists (select 1 from pulse_priv.account_member m join pulse_priv.pulse_account a on a.id = m.account_id where a.handle = v_handle and m.member_org = current_org()) then
    raise exception '@% is already in this organisation', v_handle using errcode = '23505'; end if;
  insert into pulse_priv.org_invite(org_id, kind, title, to_handle, token_hash, invited_by)
  values (current_org(), v_kind, nullif(left(btrim(coalesce(p ->> 'title', '')), 80), ''), v_handle, case when v_handle is null then p ->> 'hash' end, current_viewer())
  returning id into v_id;
  perform audit_write('invite', 'org_invite', v_id::text);
  return jsonb_build_object('id', v_id, 'kind', v_kind, 'toHandle', v_handle);
end $$;

create function pulse.org_invite_list() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title, 'toHandle', i.to_handle, 'link', i.token_hash is not null,
    'status', case when i.status = 'open' and i.expires_at <= now() then 'expired' else i.status end, 'at', i.created_at, 'expiresAt', i.expires_at,
    'by', (select display_name from person where id = i.invited_by), 'who', (select display_name from person where id = i.accepted_person)) order by i.created_at desc), '[]'::jsonb)
  from pulse_priv.org_invite i where i.org_id = current_org() and viewer_is('admin', 'leadership', 'hr') and i.created_at > now() - interval '90 days'
$$;

create function pulse.org_invite_revoke(p_id uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not viewer_is('admin', 'leadership', 'hr') then raise exception 'Admins, HR and leadership manage invitations' using errcode = '42501'; end if;
  update pulse_priv.org_invite set status = 'revoked' where id = p_id and org_id = current_org() and status = 'open';
end $$;

-- What a private invitation link is for (shown before anyone signs in): the organisation and the kind, nothing else.
create function pulse.org_invite_peek(p_hash text) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('org', o.name, 'orgHandle', o.handle, 'kind', i.kind, 'title', i.title)
  from pulse_priv.org_invite i join org o on o.id = i.org_id
  where i.token_hash = p_hash and i.status = 'open' and i.expires_at > now() and o.status = 'active'
$$;

-- Joining: the account gets its own person in the organisation (side from the kind), then a session there.
create function pulse.acct_join(p_account uuid, p_invite uuid, p_hash text, p_device text) returns jsonb
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
    values (i.org_id, v_person, coalesce(i.title, initcap(i.kind)), a.email, v_user, v_no, 'Joined with an invitation (@' || a.handle || ')', '{}');
  end if;
  update pulse_priv.org_invite set status = 'accepted', accepted_account = p_account, accepted_person = v_person, accepted_at = now() where id = i.id;
  perform acct_leave();
  if v_new then insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, i.org_id, v_person, i.kind); end if;
  return acct_session(p_account, i.org_id, p_hash, p_device);
end $$;
revoke all on function pulse.acct_join(uuid, uuid, text, text) from public;

-- Signed in: accept an invitation to my handle (by id) or a private link (by its hash).
create function pulse.org_invite_accept(p_id uuid, p_link text, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); i uuid;
begin
  if p_id is not null then select id into i from pulse_priv.org_invite where id = p_id and to_handle = (select handle from pulse_priv.pulse_account where id = v);
  else select id into i from pulse_priv.org_invite where token_hash = p_link; end if;
  if i is null then raise exception 'This invitation is no longer open' using errcode = '22023'; end if;
  return acct_join(v, i, p_hash, p_device);
end $$;

-- Signed out: a new account from a private invitation link (name, handle, e-mail, password), then into the organisation.
create function pulse.account_join(p_link text, p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare i uuid; v uuid; h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@')); e text := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g');
begin
  select id into i from pulse_priv.org_invite where token_hash = p_link and status = 'open' and expires_at > now() and to_handle is null;
  if i is null then raise exception 'This invitation is no longer open' using errcode = '22023'; end if;
  if length(n) not between 2 and 120 then raise exception 'Give your name' using errcode = '22023'; end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  if e is not null and e !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Give a valid e-mail or leave it empty' using errcode = '22023'; end if;
  if e is not null and exists (select 1 from pulse_priv.pulse_account where email = e) then raise exception 'That e-mail already has a Pulse account: sign in instead' using errcode = '23505'; end if;
  insert into pulse_priv.pulse_account(handle, display_name, email, password_hash) values (h, n, e, crypt(p ->> 'password', gen_salt('bf', 10))) returning id into v;
  insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v);
  return acct_join(v, i, p_hash, p_device);
end $$;

-- ------------------------------------------------------------------------------------------------ start your own Pulse
create function pulse.account_start_org(p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); a pulse_priv.pulse_account%rowtype; v_org uuid := gen_random_uuid(); v_person uuid;
  n text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'); h text := lower(ltrim(btrim(coalesce(p ->> 'handle', '')), '@'));
  v_code text; v_letters text; k int := 0; v_pack jsonb := p -> 'pack'; v_slug text;
begin
  if length(n) not between 2 and 80 then raise exception 'Give your organisation a name of 2 to 80 characters' using errcode = '22023'; end if;
  if h = '' then h := handle_suggest(n); end if;
  if h !~ '^[a-z0-9][a-z0-9._]{2,29}$' then raise exception 'A handle is 3 to 30 lower-case letters, digits, dots or underscores' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.handle_name where handle = h) or exists (select 1 from org where handle = h) then raise exception 'Someone already has @%', h using errcode = '23505'; end if;
  if (select count(*) from pulse_priv.handle_name hn join pulse_priv.account_member m on m.member_org = hn.ref where hn.kind = 'org' and m.account_id = v
        and hn.created_at > now() - interval '1 day') >= 3 then
    raise exception 'You started three organisations today; try again tomorrow' using errcode = '54000'; end if;
  select * into a from pulse_priv.pulse_account where id = v;
  -- The code (2 to 4 capitals, unique): the name's initials, then more of its letters.
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

-- ------------------------------------------------------------------------------------------------ portable profile
create function pulse.account_profile_get() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer();
begin
  if v is null then return null; end if;
  return jsonb_build_object(
    'profile', coalesce((select jsonb_build_object('headline', headline, 'about', about, 'skills', to_jsonb(skills), 'links', links) from pulse_priv.account_profile where account_id = v),
      jsonb_build_object('headline', null, 'about', null, 'skills', '[]'::jsonb, 'links', '[]'::jsonb)),
    'orgSkills', coalesce((select to_jsonb(skills) from people_profile where person_id = current_viewer()), '[]'::jsonb),
    'badges', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'note', note, 'from', from_org_name, 'by', given_by_name, 'on', earned_on, 'carried', carried, 'here', from_org = current_org()) order by earned_on desc) from pulse_priv.account_badge where account_id = v), '[]'::jsonb),
    'highlights', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'detail', detail, 'from', from_org_name, 'on', on_date) order by coalesce(on_date, created_at::date) desc) from pulse_priv.account_highlight where account_id = v), '[]'::jsonb),
    'shares', coalesce((select jsonb_agg(jsonb_build_object('org', o.id, 'name', o.name, 'current', o.id = current_org(),
        'profile', coalesce(s.profile, true), 'skills', coalesce(s.skills, true), 'badges', coalesce(s.badges, true), 'highlights', coalesce(s.highlights, true)) order by o.name)
      from pulse_priv.account_member m join org o on o.id = m.member_org left join pulse_priv.account_share s on s.account_id = v and s.member_org = m.member_org where m.account_id = v), '[]'::jsonb));
end $$;

create function pulse.account_profile_save(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); v_skills text[];
begin
  select coalesce(array_agg(distinct left(btrim(x), 60)) filter (where btrim(x) <> ''), '{}') into v_skills
    from (select jsonb_array_elements_text(case when jsonb_typeof(p -> 'skills') = 'array' then p -> 'skills' else '[]' end) x limit 40) s;
  insert into pulse_priv.account_profile(account_id, headline, about, skills, links, updated_at)
  values (v, nullif(left(btrim(coalesce(p ->> 'headline', '')), 120), ''), nullif(left(btrim(coalesce(p ->> 'about', '')), 2000), ''), v_skills,
          case when jsonb_typeof(p -> 'links') = 'array' then (select coalesce(jsonb_agg(x), '[]') from (select x from jsonb_array_elements(p -> 'links') x where x ->> 'url' ~ '^https://' limit 8) l) else '[]' end, now())
  on conflict (account_id) do update set headline = excluded.headline, about = excluded.about, skills = excluded.skills, links = excluded.links, updated_at = now();
  return account_profile_get();
end $$;

create function pulse.account_share_save(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); o uuid := coalesce(nullif(p ->> 'org', '')::uuid, current_org());
begin
  if not exists (select 1 from pulse_priv.account_member where account_id = v and member_org = o) then raise exception 'Not one of your organisations' using errcode = '42501'; end if;
  insert into pulse_priv.account_share(account_id, member_org, profile, skills, badges, highlights)
  values (v, o, coalesce((p ->> 'profile')::boolean, true), coalesce((p ->> 'skills')::boolean, true), coalesce((p ->> 'badges')::boolean, true), coalesce((p ->> 'highlights')::boolean, true))
  on conflict (account_id, member_org) do update set profile = excluded.profile, skills = excluded.skills, badges = excluded.badges, highlights = excluded.highlights;
  return account_profile_get();
end $$;

-- Things I finished here that I may carry: my own done tasks in this organisation (titles only).
create function pulse.account_highlight_choices() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'on', t.updated_at::date) order by t.updated_at desc), '[]'::jsonb)
  from (select id, title, coalesce(done_at, updated_at) updated_at from task where org_id = current_org() and assignee_person_id = current_viewer() and status = 'done' order by 3 desc limit 40) t
$$;

create function pulse.account_highlight_add(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_ensure(); t record; v_org text := (select name from org where id = current_org());
begin
  if nullif(p ->> 'taskId', '') is not null then
    select title, coalesce(done_at, updated_at)::date d into t from task where id = (p ->> 'taskId')::uuid and org_id = current_org() and assignee_person_id = current_viewer() and status = 'done';
    if not found then raise exception 'Choose one of your finished tasks' using errcode = 'P0002'; end if;
    insert into pulse_priv.account_highlight(account_id, from_org, from_org_name, title, detail, on_date) values (v, current_org(), v_org, left(t.title, 160), nullif(left(btrim(coalesce(p ->> 'detail', '')), 500), ''), t.d);
  else
    insert into pulse_priv.account_highlight(account_id, from_org, from_org_name, title, detail, on_date)
    values (v, current_org(), v_org, left(btrim(coalesce(p ->> 'title', '')), 160), nullif(left(btrim(coalesce(p ->> 'detail', '')), 500), ''), nullif(p ->> 'on', '')::date);
  end if;
  return account_profile_get();
end $$;

create function pulse.account_item_set(p_kind text, p_id uuid, p_value boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer();
begin
  if p_kind = 'highlight-remove' then delete from pulse_priv.account_highlight where id = p_id and account_id = v;
  elsif p_kind = 'badge-carry' then update pulse_priv.account_badge set carried = p_value where id = p_id and account_id = v;
  else raise exception 'Unknown change' using errcode = '22023'; end if;
  return account_profile_get();
end $$;

-- A badge from this organisation to one of its people who has a Pulse account (admins, HR, leadership, managers).
create function pulse.org_badge_give(p_person uuid, p_title text, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid; v_id uuid;
begin
  if not (viewer_is('admin', 'leadership', 'hr') or manages(p_person)) then raise exception 'Leaders, HR and the person''s manager give badges' using errcode = '42501'; end if;
  if p_person = current_viewer() then raise exception 'Badges come from someone else' using errcode = '42501'; end if;
  select account_id into v from pulse_priv.account_member where member_org = current_org() and person_id = p_person;
  if v is null then raise exception 'This person has no Pulse account yet: badges travel with an account' using errcode = 'P0002'; end if;
  insert into pulse_priv.account_badge(account_id, from_org, from_org_name, title, note, given_by_name)
  values (v, current_org(), (select name from org where id = current_org()), btrim(p_title), nullif(left(btrim(coalesce(p_note, '')), 300), ''), (select display_name from person where id = current_viewer()))
  returning id into v_id;
  perform audit_write('give', 'account_badge', v_id::text);
  return jsonb_build_object('id', v_id);
end $$;

-- What a person of this organisation shares with it from their account: never another organisation's records, only
-- what they wrote or chose (their profile, skills, carried badges and highlights) and only what they allow here.
create function pulse.account_card(p_person uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v uuid; s record; a record;
begin
  if current_viewer() is null or not exists (select 1 from person where id = p_person and org_id = current_org()) then return null; end if;
  select account_id into v from pulse_priv.account_member where member_org = current_org() and person_id = p_person;
  if v is null then return null; end if;
  select coalesce(sh.profile, true) profile, coalesce(sh.skills, true) skills, coalesce(sh.badges, true) badges, coalesce(sh.highlights, true) highlights
    into s from (select 1) one left join pulse_priv.account_share sh on sh.account_id = v and sh.member_org = current_org();
  select handle into a from pulse_priv.pulse_account where id = v;
  return jsonb_build_object('handle', a.handle, 'self', p_person = current_viewer(),
    'headline', case when s.profile then (select headline from pulse_priv.account_profile where account_id = v) end,
    'about', case when s.profile then (select about from pulse_priv.account_profile where account_id = v) end,
    'links', case when s.profile then (select links from pulse_priv.account_profile where account_id = v) end,
    'skills', case when s.skills then (select to_jsonb(skills) from pulse_priv.account_profile where account_id = v) end,
    'badges', coalesce((select jsonb_agg(jsonb_build_object('title', title, 'note', note, 'from', from_org_name, 'by', given_by_name, 'on', earned_on, 'here', from_org = current_org()) order by earned_on desc)
      from pulse_priv.account_badge where account_id = v and (from_org = current_org() or (s.badges and carried))), '[]'::jsonb),
    'highlights', case when s.highlights then coalesce((select jsonb_agg(jsonb_build_object('title', title, 'detail', detail, 'from', from_org_name, 'on', on_date) order by coalesce(on_date, created_at::date) desc)
      from pulse_priv.account_highlight where account_id = v), '[]'::jsonb) else '[]'::jsonb end);
end $$;

revoke all on function pulse.session_org(text), pulse.account_me(), pulse.account_claim(text, text), pulse.account_switch(uuid, text, text),
  pulse.account_sign_in(text, text, text, text), pulse.account_link(text, text), pulse.org_invite_create(jsonb), pulse.org_invite_list(),
  pulse.org_invite_revoke(uuid), pulse.org_invite_peek(text), pulse.org_invite_accept(uuid, text, text, text), pulse.account_join(text, jsonb, text, text),
  pulse.account_start_org(jsonb, text, text), pulse.account_profile_get(), pulse.account_profile_save(jsonb), pulse.account_share_save(jsonb),
  pulse.account_highlight_choices(), pulse.account_highlight_add(jsonb), pulse.account_item_set(text, uuid, boolean), pulse.org_badge_give(uuid, text, text),
  pulse.account_card(uuid) from public;
grant execute on function pulse.session_org(text), pulse.account_me(), pulse.account_claim(text, text), pulse.account_switch(uuid, text, text),
  pulse.account_sign_in(text, text, text, text), pulse.account_link(text, text), pulse.org_invite_create(jsonb), pulse.org_invite_list(),
  pulse.org_invite_revoke(uuid), pulse.org_invite_peek(text), pulse.org_invite_accept(uuid, text, text, text), pulse.account_join(text, jsonb, text, text),
  pulse.account_start_org(jsonb, text, text), pulse.account_profile_get(), pulse.account_profile_save(jsonb), pulse.account_share_save(jsonb),
  pulse.account_highlight_choices(), pulse.account_highlight_add(jsonb), pulse.account_item_set(text, uuid, boolean), pulse.org_badge_give(uuid, text, text),
  pulse.account_card(uuid) to pulse_api;

-- migrate:down
