-- migrate:up
-- Pulse as the system of record: people, clients, contacts and projects are records that sources (Drive today)
-- seed and enrich and that people complete in the app. `locked` lists the fields edited in the app; a sync never
-- overwrites a locked field. Sign-in for staff without a company e-mail: username + password, reset by an admin.

create function pulse.viewer_is(variadic roles text[]) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (
    select 1 from role_assignment
     where org_id = pulse.current_org() and person_id = pulse.current_viewer() and role_key = any(roles)
       and current_date between valid_from and coalesce(valid_to, 'infinity'))
$$;

-- ------------------------------------------------------------------------------------------------ staff records
alter table pulse.people_profile
  add column user_no    int,                                  -- display "EA-P007"
  add column username   text,                                 -- Pulse sign-in name, lower-case
  add column manager_id uuid references pulse.person(id),
  add column joined_on  date,
  add column email      text,
  add column phone      text,
  add column notes      text,
  add column locked     text[] not null default '{}',
  add column updated_at timestamptz not null default now(),
  add constraint people_profile_username_format check (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$');
create unique index people_profile_user_no on pulse.people_profile (org_id, user_no);
create unique index people_profile_username on pulse.people_profile (org_id, username);

create table pulse.person_photo (
  org_id     uuid not null references pulse.org(id),
  person_id  uuid primary key references pulse.person(id) on delete cascade,
  mime       text not null check (mime in ('image/jpeg','image/png','image/webp')),
  bytes      bytea not null check (octet_length(bytes) <= 400000),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------------------------------------- clients and contacts
alter table pulse.client
  add column company_name text,                               -- legal or trading name when known
  add column type_basis   text not null default 'manual' check (type_basis in ('manual','source','inferred')),
  add column website      text,
  add column email        text,
  add column phone        text,
  add column city         text,
  add column notes        text,
  add column source       text not null default 'manual',     -- 'drive_folder_name' for records seeded from Drive
  add column locked       text[] not null default '{}',
  add column created_at   timestamptz not null default now(),
  add column updated_at   timestamptz not null default now();

create table pulse.contact_profile (                          -- an external person: developer, CP, talent, other
  org_id       uuid not null references pulse.org(id),
  person_id    uuid primary key references pulse.person(id) on delete cascade,
  contact_type text check (contact_type in ('developer','channel_partner','talent','other')),   -- null: not set
  designation  text,
  email        text,
  phone        text,
  city         text,
  notes        text,
  source       text not null default 'manual',
  locked       text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create table pulse.client_contact (
  org_id     uuid not null references pulse.org(id),
  client_id  uuid not null references pulse.client(id) on delete cascade,
  person_id  uuid not null references pulse.person(id) on delete cascade,
  is_primary boolean not null default false,
  primary key (client_id, person_id)
);
create index client_contact_person on pulse.client_contact (org_id, person_id);
create table pulse.project_contact (                          -- e.g. the model of a shoot
  org_id     uuid not null references pulse.org(id),
  project_id uuid not null references pulse.project(id) on delete cascade,
  person_id  uuid not null references pulse.person(id) on delete cascade,
  role       text not null,
  source     text not null default 'manual',
  primary key (project_id, person_id, role)
);
create index project_contact_person on pulse.project_contact (org_id, person_id);

alter table pulse.project
  add column title       text,                                -- display name; `name` keeps the source folder name
  add column location    text,
  add column segment     text,
  add column project_key text,                                -- same key = the same real project sold again
  add column serial_no   int,
  add column kind        text not null default 'client_work' check (kind in ('client_work','internal')),
  add column locked      text[] not null default '{}',
  add column updated_at  timestamptz not null default now();
create index project_client on pulse.project (org_id, client_id);

create table pulse.record_change (                            -- who changed which field of a record in the app
  org_id      uuid not null references pulse.org(id),
  id          uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('person','client','contact','project')),
  entity_id   uuid not null,
  field       text not null,
  old_value   text,
  new_value   text,
  changed_by  uuid references pulse.person(id),
  changed_at  timestamptz not null default now()
);
create index record_change_entity on pulse.record_change (org_id, entity_type, entity_id, changed_at desc);

-- ------------------------------------------------------------------------------------------------------- sync
create table pulse.sync_run (                                 -- one row per source refresh, written by the collector
  org_id      uuid not null references pulse.org(id),
  id          uuid primary key default gen_random_uuid(),
  source      text not null,
  started_at  timestamptz not null,
  finished_at timestamptz,
  ok          boolean,
  upstream_at timestamptz,                                    -- when the source itself was last read (Drive crawl)
  stats       jsonb not null default '{}',
  error       text
);
create index sync_run_recent on pulse.sync_run (org_id, source, started_at desc);

-- ---------------------------------------------------------------------------------------- username + password
create table pulse.login_credential (
  org_id          uuid not null references pulse.org(id),
  person_id       uuid primary key references pulse.person(id) on delete cascade,
  password_hash   text not null,                              -- bcrypt (pgcrypto); never granted to a service role
  must_change     boolean not null default true,
  status          text not null default 'active' check (status in ('active','disabled')),
  issued_by       uuid references pulse.person(id),
  issued_at       timestamptz not null default now(),
  last_login_at   timestamptz,
  failed_attempts int not null default 0,
  locked_until    timestamptz
);
create table pulse.login_session (
  org_id     uuid not null references pulse.org(id),
  token_hash text primary key,                                -- sha256 of the cookie value
  person_id  uuid not null references pulse.person(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create table pulse.password_reset_request (
  org_id       uuid not null references pulse.org(id),
  id           uuid primary key default gen_random_uuid(),
  username     text not null,                                 -- as typed; person_id is null when nobody matches
  person_id    uuid references pulse.person(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','resolved','dismissed')),
  requested_at timestamptz not null default now(),
  resolved_by  uuid references pulse.person(id),
  resolved_at  timestamptz
);
create index password_reset_pending on pulse.password_reset_request (org_id, status, requested_at desc);

do $$ declare t text; begin
  foreach t in array array['person_photo','contact_profile','client_contact','project_contact','record_change',
                           'sync_run','login_credential','login_session','password_reset_request'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  end loop;
  foreach t in array array['person_photo','contact_profile','client_contact','project_contact','record_change','sync_run'] loop
    execute format('grant select, insert, update, delete on pulse.%I to pulse_worker', t);
    execute format('grant select on pulse.%I to pulse_api', t);
  end loop;
end $$;

-- The API may write records; restrictive policies say who. Workers (the sync) are not restricted by them.
grant insert, update on pulse.person, pulse.people_profile, pulse.client, pulse.contact_profile to pulse_api;
grant insert, update, delete on pulse.person_photo, pulse.client_contact, pulse.project_contact to pulse_api;
grant update (title, client_id, unit_id, status, location, segment, locked, updated_at) on pulse.project to pulse_api;
grant update (holder_person_id, purpose) on pulse.account to pulse_api;
grant insert on pulse.record_change, pulse.identity_link to pulse_api;
grant select (org_id, person_id, must_change, status, issued_by, issued_at, last_login_at, locked_until)
  on pulse.login_credential to pulse_api;
grant select, insert, update on pulse.login_session to pulse_api;
grant select, update on pulse.password_reset_request to pulse_api;

do $$ declare t text; begin
  foreach t in array array['person','people_profile'] loop                       -- staff records: admin and HR
    execute format($f$create policy record_insert on pulse.%I as restrictive for insert to pulse_api with check (pulse.viewer_is('admin','hr'))$f$, t);
    execute format($f$create policy record_update on pulse.%I as restrictive for update to pulse_api using (pulse.viewer_is('admin','hr')) with check (pulse.viewer_is('admin','hr'))$f$, t);
  end loop;
  foreach t in array array['client','contact_profile','client_contact','project_contact','project','account'] loop   -- admin
    execute format($f$create policy record_insert on pulse.%I as restrictive for insert to pulse_api with check (pulse.viewer_is('admin'))$f$, t);
    execute format($f$create policy record_update on pulse.%I as restrictive for update to pulse_api using (pulse.viewer_is('admin')) with check (pulse.viewer_is('admin'))$f$, t);
    execute format($f$create policy record_delete on pulse.%I as restrictive for delete to pulse_api using (pulse.viewer_is('admin'))$f$, t);
  end loop;
end $$;
create policy photo_insert on pulse.person_photo as restrictive for insert to pulse_api
  with check (person_id = pulse.current_viewer() or pulse.viewer_is('admin','hr'));
create policy photo_update on pulse.person_photo as restrictive for update to pulse_api
  using (person_id = pulse.current_viewer() or pulse.viewer_is('admin','hr'))
  with check (person_id = pulse.current_viewer() or pulse.viewer_is('admin','hr'));
create policy photo_delete on pulse.person_photo as restrictive for delete to pulse_api
  using (person_id = pulse.current_viewer() or pulse.viewer_is('admin','hr'));
create policy change_author on pulse.record_change as restrictive for insert to pulse_api
  with check (changed_by = pulse.current_viewer());
create policy reset_admin on pulse.password_reset_request as restrictive to pulse_api
  using (pulse.viewer_is('admin')) with check (pulse.viewer_is('admin'));
create policy credential_visible on pulse.login_credential as restrictive for select to pulse_api
  using (person_id = pulse.current_viewer() or pulse.viewer_is('admin'));

-- Passwords never leave the database: the API calls these functions and cannot read password_hash.
create function pulse.login_issue(p_person uuid, p_password text) returns void
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
begin
  if not pulse.viewer_is('admin') then raise exception 'admin required' using errcode = '42501'; end if;
  if length(p_password) < 10 then raise exception 'password too short' using errcode = '22023'; end if;
  insert into login_credential(org_id, person_id, password_hash, issued_by)
    values (pulse.current_org(), p_person, crypt(p_password, gen_salt('bf', 10)), pulse.current_viewer())
    on conflict (person_id) do update set password_hash = excluded.password_hash, must_change = true, status = 'active',
      issued_by = excluded.issued_by, issued_at = now(), failed_attempts = 0, locked_until = null;
  update login_session set revoked_at = now() where person_id = p_person and revoked_at is null;
  update password_reset_request set status = 'resolved', resolved_by = pulse.current_viewer(), resolved_at = now()
    where person_id = p_person and status = 'pending';
end $$;

create function pulse.login_disable(p_person uuid) returns void
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
begin
  if not pulse.viewer_is('admin') then raise exception 'admin required' using errcode = '42501'; end if;
  update login_credential set status = 'disabled' where person_id = p_person;
  update login_session set revoked_at = now() where person_id = p_person and revoked_at is null;
end $$;

-- Returns the person when the password is right. Five wrong passwords lock the login for 15 minutes.
create function pulse.login_verify(p_username text, p_password text)
  returns table (person_id uuid, must_change boolean)
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare c login_credential%rowtype;
begin
  select lc.* into c from login_credential lc
    join people_profile pp on pp.person_id = lc.person_id join person pe on pe.id = lc.person_id
   where pp.org_id = pulse.current_org() and pp.username = lower(trim(p_username))
     and lc.status = 'active' and pe.status = 'active' for update of lc;
  if not found then perform crypt(p_password, gen_salt('bf', 10)); return; end if;      -- same cost either way
  if c.locked_until is not null and c.locked_until > now() then return; end if;
  if c.password_hash = crypt(p_password, c.password_hash) then
    update login_credential set failed_attempts = 0, locked_until = null, last_login_at = now() where login_credential.person_id = c.person_id;
    return query select c.person_id, c.must_change;
  else
    update login_credential set failed_attempts = case when c.failed_attempts >= 4 then 0 else c.failed_attempts + 1 end,
      locked_until = case when c.failed_attempts >= 4 then now() + interval '15 minutes' end
      where login_credential.person_id = c.person_id;
  end if;
end $$;

-- The signed-in person sets their own password (the viewer is the session's person).
create function pulse.login_change(p_old text, p_new text) returns boolean
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare c login_credential%rowtype;
begin
  if length(p_new) < 10 then raise exception 'password too short' using errcode = '22023'; end if;
  select * into c from login_credential where person_id = pulse.current_viewer() and status = 'active' for update;
  if not found or c.password_hash <> crypt(p_old, c.password_hash) then return false; end if;
  update login_credential set password_hash = crypt(p_new, gen_salt('bf', 10)), must_change = false where person_id = c.person_id;
  return true;
end $$;

-- "Forgot password": queues a request for an admin. It answers the same whether or not the username exists.
create function pulse.login_forgot(p_username text) returns void
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare who uuid; name text := left(lower(trim(p_username)), 40);
begin
  if name = '' then return; end if;
  select person_id into who from people_profile where org_id = pulse.current_org() and username = name;
  if exists (select 1 from password_reset_request where org_id = pulse.current_org() and username = name and status = 'pending') then return; end if;
  if (select count(*) from password_reset_request where org_id = pulse.current_org() and requested_at > now() - interval '1 hour') >= 30 then return; end if;
  insert into password_reset_request(org_id, username, person_id) values (pulse.current_org(), name, who);
end $$;

revoke all on function pulse.login_issue(uuid, text), pulse.login_disable(uuid), pulse.login_verify(text, text),
  pulse.login_change(text, text), pulse.login_forgot(text) from public;
grant execute on function pulse.viewer_is(text[]) to pulse_api, pulse_worker;
grant execute on function pulse.login_issue(uuid, text), pulse.login_disable(uuid), pulse.login_verify(text, text),
  pulse.login_change(text, text), pulse.login_forgot(text) to pulse_api;
-- migrate:down
