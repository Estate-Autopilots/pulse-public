-- migrate:up
-- UX-TENANT (owner, 10 Oct 2026; ADR-0032): a second company (Atlas Crest first) is its own organisation on the
-- same platform, reached at its own address. This migration adds:
--   * pulse.org_domain: the addresses that belong to a company and how people sign in there (Pulse passwords, or
--     Cloudflare Access for the install's own company). pulse.host_org() resolves an address before anyone signs in.
--   * pulse.org_module: per-company switches for tasks, chats and finance (attendance keeps hr_policy.attendance_enabled).
--   * an accent colour in pulse.org_brand, and a "rehearsal" flag on pulse.org (rehearsal companies never send e-mail).
--   * pulse.tenant_setup and the pulse.tenant_* functions behind the setup wizard. The platform operator (an admin of
--     the install's own company) creates the company in status 'setup', fills it step by step (each step previews
--     before it writes and can be rerun), and opens it for sign-in. Every write lands in the new company only, through
--     SECURITY DEFINER functions that check the operator and switch the transaction's tenant for the write.
-- No EA business row is read or copied; nothing here sends e-mail.

alter table pulse.org drop constraint org_status_check;
alter table pulse.org add constraint org_status_check check (status in ('setup','active','suspended','offboarding'));
alter table pulse.org add column rehearsal boolean not null default false;

-- ------------------------------------------------------------------------------------------------- addresses
create table pulse.org_domain (
  host        text primary key check (length(host) <= 253 and host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  org_id      uuid not null references pulse.org(id),
  sign_in     text not null default 'password' check (sign_in in ('password','access')),
  is_primary  boolean not null default true,
  added_by    text not null,
  created_at  timestamptz not null default now()
);
create unique index org_domain_one_primary on pulse.org_domain(org_id) where is_primary;
alter table pulse.org_domain enable row level security;
alter table pulse.org_domain force row level security;
create policy tenant on pulse.org_domain using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- host_org() runs as the schema owner before a tenant is known (like pulse.list_active_orgs and pulse.org's directory).
create policy directory on pulse.org_domain for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));
grant select on pulse.org_domain to pulse_api, pulse_worker;

-- The company an address belongs to. Ports are ignored; an unknown address returns no row (the install's company).
create function pulse.host_org(p_host text) returns table(org_id uuid, sign_in text, status text, rehearsal boolean)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select d.org_id, d.sign_in, o.status, o.rehearsal from pulse.org_domain d join pulse.org o on o.id = d.org_id
   where d.host = lower(split_part(btrim(coalesce(p_host, '')), ':', 1))
$$;
revoke all on function pulse.host_org(text) from public;
grant execute on function pulse.host_org(text) to pulse_api, pulse_worker;

-- The address links in a company's e-mails and pushes point at (null: the install's PULSE_PUBLIC_URL).
create function pulse.org_public_host() returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select host from pulse.org_domain where org_id = pulse.current_org() and is_primary
$$;
revoke all on function pulse.org_public_host() from public;
grant execute on function pulse.org_public_host() to pulse_api, pulse_worker;

-- --------------------------------------------------------------------------------------------------- modules
create table pulse.org_module (
  org_id      uuid not null references pulse.org(id),
  module      text not null check (module in ('tasks','chats','finance')),
  enabled     boolean not null,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  primary key (org_id, module)
);
alter table pulse.org_module enable row level security;
alter table pulse.org_module force row level security;
create policy tenant on pulse.org_module using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.org_module to pulse_api, pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.org_module for each row execute function pulse.audit_mutation();

-- A missing row is on, so every existing company keeps every module. Attendance is the HR policy's own switch.
create function pulse.org_modules() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object(
    'tasks', coalesce((select enabled from org_module where org_id = current_org() and module = 'tasks'), true),
    'chats', coalesce((select enabled from org_module where org_id = current_org() and module = 'chats'), true),
    'finance', coalesce((select enabled from org_module where org_id = current_org() and module = 'finance'), true),
    'attendance', coalesce((select attendance_enabled from hr_policy where org_id = current_org()), false))
$$;
revoke all on function pulse.org_modules() from public;
grant execute on function pulse.org_modules() to pulse_api, pulse_worker;

-- Shared by the company's own admins (Settings) and the setup wizard: one switch, recorded in pulse.record_change.
create function pulse.org_module_write(p_module text, p_enabled boolean) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_before boolean;
begin
  if p_module not in ('tasks','chats','finance','attendance') or p_enabled is null then
    raise exception 'Choose a module: tasks, chats, finance or attendance' using errcode = '22023';
  end if;
  v_before := (org_modules() ->> p_module)::boolean;
  if v_before = p_enabled then return; end if;
  if p_module = 'attendance' then
    insert into hr_policy(org_id) values (current_org()) on conflict (org_id) do nothing;
    update hr_policy set attendance_enabled = p_enabled, updated_at = now() where org_id = current_org();
  else
    insert into org_module(org_id, module, enabled, updated_by) values (current_org(), p_module, p_enabled, current_viewer())
    on conflict (org_id, module) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();
  end if;
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'module.' || p_module, v_before::text, p_enabled::text, current_viewer());
end $$;
revoke all on function pulse.org_module_write(text, boolean) from public;

create function pulse.org_module_set(p_module text, p_enabled boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not viewer_is('admin') or current_viewer() is null then
    raise exception 'An organisation admin turns modules on or off' using errcode = '42501';
  end if;
  perform org_module_write(p_module, p_enabled);
  return org_modules();
end $$;
revoke all on function pulse.org_module_set(text, boolean) from public;
grant execute on function pulse.org_module_set(text, boolean) to pulse_api;

-- ----------------------------------------------------------------------------------------------------- brand
alter table pulse.org_brand add column accent text check (accent ~ '^#[0-9a-f]{6}$');

create function pulse.org_brand_accent(p_accent text) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_version int; v_accent text := nullif(lower(btrim(coalesce(p_accent, ''))), '');
begin
  if not viewer_is('admin') or current_viewer() is null then raise exception 'An individual organisation admin changes the colours' using errcode = '42501'; end if;
  if v_accent is not null and v_accent !~ '^#[0-9a-f]{6}$' then raise exception 'Choose a colour like #5b45d6' using errcode = '22023'; end if;
  insert into org_brand(org_id) values (current_org()) on conflict (org_id) do nothing;
  update org_brand set accent = v_accent, version = version + 1, updated_by = current_viewer(), updated_at = now()
   where org_id = current_org() returning version into v_version;
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'brand.accent', null, coalesce(v_accent, 'removed'), current_viewer());
  return v_version;
end $$;
revoke all on function pulse.org_brand_accent(text) from public;
grant execute on function pulse.org_brand_accent(text) to pulse_api;

-- -------------------------------------------------------------------------------------------- setup records
-- Kept in the operator's company: what is being set up and how far it got. No person data from the new company.
create table pulse.tenant_setup (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references pulse.org(id),
  target_org_id  uuid unique references pulse.org(id),
  name           text not null check (length(name) between 2 and 80),
  status         text not null default 'draft' check (status in ('draft','setup','open')),
  steps          jsonb not null default '{}',
  created_by     uuid not null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table pulse.tenant_setup enable row level security;
alter table pulse.tenant_setup force row level security;
create policy tenant on pulse.tenant_setup using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.tenant_setup to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.tenant_setup for each row execute function pulse.audit_mutation();

-- The platform operator: an individual admin of the install's own company.
create function pulse.tenant_operator() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_org() is not null and current_org() = install_org() and current_viewer() is not null and viewer_is('admin')
$$;
revoke all on function pulse.tenant_operator() from public;
grant execute on function pulse.tenant_operator() to pulse_api;

-- Step into the company being set up for the rest of a function, and back. The operator's viewer id is not carried
-- into the other company: its rows record "Pulse setup" as the actor instead.
create function pulse.tenant_enter(p_setup uuid, p_write boolean) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_target uuid; v_status text; v_org_status text;
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  select target_org_id, status into v_target, v_status from tenant_setup where id = p_setup;
  if not found then raise exception 'Setup not found' using errcode = 'P0002'; end if;
  if v_target is null then raise exception 'Create the company first' using errcode = '22023'; end if;
  select status into v_org_status from org where id = v_target;
  if p_write and (v_status = 'open' or v_org_status <> 'setup') then
    raise exception 'This company is open: its own admins change it in their Settings' using errcode = '42501';
  end if;
  perform set_config('pulse.tenant_return', current_org()::text || '|' || coalesce(current_viewer()::text, '') || '|' || coalesce(current_setting('pulse.actor_account', true), ''), true);
  perform set_config('pulse.org_id', v_target::text, true);
  perform set_config('pulse.viewer_id', '', true);
  perform set_config('pulse.actor_account', 'Pulse setup', true);
  return v_target;
end $$;
revoke all on function pulse.tenant_enter(uuid, boolean) from public;

create function pulse.tenant_leave() returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_back text[] := string_to_array(coalesce(current_setting('pulse.tenant_return', true), ''), '|');
begin
  if coalesce(array_length(v_back, 1), 0) < 3 or v_back[1] = '' then raise exception 'tenant_leave without tenant_enter'; end if;
  perform set_config('pulse.org_id', v_back[1], true);
  perform set_config('pulse.viewer_id', v_back[2], true);
  perform set_config('pulse.actor_account', v_back[3], true);
  perform set_config('pulse.tenant_return', '', true);
end $$;
revoke all on function pulse.tenant_leave() from public;

-- Marks a step done (or records its result) on the operator's setup row.
create function pulse.tenant_step(p_setup uuid, p_step text, p_value jsonb) returns void
  language sql security definer set search_path = pulse, pg_temp as $$
  update tenant_setup set steps = steps || jsonb_build_object(p_step, p_value || jsonb_build_object('at', now())), updated_at = now()
   where id = p_setup
$$;
revoke all on function pulse.tenant_step(uuid, text, jsonb) from public;

create function pulse.tenant_start(p_name text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_id uuid; v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  if length(v_name) not between 2 and 80 then raise exception 'Give the company a name of 2 to 80 characters' using errcode = '22023'; end if;
  insert into tenant_setup(org_id, name, created_by) values (current_org(), v_name, current_viewer()) returning id into v_id;
  return v_id;
end $$;
revoke all on function pulse.tenant_start(text) from public;
grant execute on function pulse.tenant_start(text) to pulse_api;

-- The company step, checked: what would be created and what collides (names, codes and addresses are unique across
-- the platform; the operator is told which, not whose).
create function pulse.tenant_company_check(p_setup uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  v_target uuid; v_problems jsonb := '[]'; v_warnings jsonb := '[]';
  v_name text := regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g');
  v_slug text := lower(btrim(coalesce(p ->> 'slug', '')));
  v_code text := upper(btrim(coalesce(p ->> 'code', '')));
  v_tz text := btrim(coalesce(p ->> 'timeZone', ''));
  v_region text := coalesce(nullif(p ->> 'dataRegion', ''), 'in');
  v_host text := lower(split_part(btrim(coalesce(p ->> 'host', '')), ':', 1));
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  select target_org_id into v_target from tenant_setup where id = p_setup;
  if not found then raise exception 'Setup not found' using errcode = 'P0002'; end if;
  if length(v_name) not between 2 and 80 then v_problems := v_problems || '["Give the company a name of 2 to 80 characters"]'::jsonb; end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' then v_problems := v_problems || '["The short name is 3 to 40 lowercase letters, digits or dashes"]'::jsonb;
  elsif exists (select 1 from org where slug = v_slug and id is distinct from v_target) then v_problems := v_problems || '["Another company on this Pulse already uses this short name"]'::jsonb; end if;
  if v_code !~ '^[A-Z]{2,4}$' then v_problems := v_problems || '["The code is 2 to 4 capital letters (it starts every record number)"]'::jsonb;
  elsif exists (select 1 from org where code = v_code and id is distinct from v_target) then v_problems := v_problems || '["Another company on this Pulse already uses this code"]'::jsonb; end if;
  if v_tz = '' or not exists (select 1 from pg_timezone_names where name = v_tz) then v_problems := v_problems || '["Choose a time zone such as Asia/Kolkata"]'::jsonb;
  elsif v_tz <> 'Asia/Kolkata' then v_warnings := v_warnings || '["Some daily figures (attendance days, due dates) are still counted in India time; a company outside India needs that work first (R51)"]'; end if;
  if v_region not in ('in','eu','us','other') then v_problems := v_problems || '["Choose where the data is kept"]'::jsonb; end if;
  if v_host = '' then v_problems := v_problems || '["Give the company its web address, e.g. pulse.example.com"]'::jsonb;
  elsif v_host !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' or length(v_host) > 253 then v_problems := v_problems || '["The web address is a host name only, e.g. pulse.example.com"]'::jsonb;
  elsif exists (select 1 from org_domain where host = v_host and org_id is distinct from v_target) then v_problems := v_problems || '["Another company on this Pulse already has this web address"]'::jsonb; end if;
  return jsonb_build_object('ok', jsonb_array_length(v_problems) = 0, 'problems', v_problems, 'warnings', v_warnings,
    'creates', case when v_target is null then jsonb_build_array(
      'A new company "' || v_name || '" in status "being set up" (nobody can sign in until you open it)',
      'Its web address ' || v_host || ', signing in with Pulse passwords',
      'Its own HR policy (attendance off), module switches (tasks, chats and finance on) and two-step verification required for admins and HR after 14 days',
      'Nothing is copied from this company: no people, projects, clients, rules or files')
    else jsonb_build_array('Updates the company''s name, code, time zone and web address') end);
end $$;
revoke all on function pulse.tenant_company_check(uuid, jsonb) from public;
grant execute on function pulse.tenant_company_check(uuid, jsonb) to pulse_api;

-- Creates the company the first time (status 'setup') and updates it on later runs. Returns the company's id.
create function pulse.tenant_company(p_setup uuid, p jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  v_check jsonb := tenant_company_check(p_setup, p); v_target uuid; v_op_org uuid := current_org(); v_viewer uuid := current_viewer(); v_actor text;
  v_host text := lower(split_part(btrim(coalesce(p ->> 'host', '')), ':', 1));
begin
  if not (v_check ->> 'ok')::boolean then raise exception '%', v_check -> 'problems' ->> 0 using errcode = '22023'; end if;
  select target_org_id into v_target from tenant_setup where id = p_setup for update;
  if v_target is null then
    perform pg_advisory_xact_lock(hashtext('tenant-create'));
    v_target := gen_random_uuid();
    v_actor := coalesce(current_setting('pulse.actor_account', true), '');
    perform set_config('pulse.org_id', v_target::text, true);
    perform set_config('pulse.viewer_id', '', true);
    perform set_config('pulse.actor_account', 'Pulse setup', true);
    insert into org(id, slug, name, code, time_zone, data_region, status, rehearsal)
    values (v_target, lower(btrim(p ->> 'slug')), regexp_replace(btrim(p ->> 'name'), '\s+', ' ', 'g'), upper(btrim(p ->> 'code')),
            btrim(p ->> 'timeZone'), coalesce(nullif(p ->> 'dataRegion', ''), 'in'), 'setup', coalesce((p ->> 'rehearsal')::boolean, false));
    insert into org_domain(host, org_id, sign_in, is_primary, added_by) values (v_host, v_target, 'password', true, 'Pulse setup');
    insert into hr_policy(org_id, attendance_enabled) values (v_target, false) on conflict (org_id) do nothing;
    insert into org_module(org_id, module, enabled) values (v_target, 'tasks', true), (v_target, 'chats', true), (v_target, 'finance', true);
    insert into pulse_priv.auth_policy(org_id, required, grace_until) values (v_target, true, now() + interval '14 days') on conflict do nothing;
    insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
    values (v_target, 'org', v_target, 'created', null, 'Set up in Pulse by the platform operator', null);
    perform set_config('pulse.org_id', v_op_org::text, true);
    perform set_config('pulse.viewer_id', coalesce(v_viewer::text, ''), true);
    perform set_config('pulse.actor_account', v_actor, true);
    update tenant_setup set target_org_id = v_target, status = 'setup', name = regexp_replace(btrim(p ->> 'name'), '\s+', ' ', 'g'), updated_at = now() where id = p_setup;
  else
    perform tenant_enter(p_setup, true);
    update org set name = regexp_replace(btrim(p ->> 'name'), '\s+', ' ', 'g'), slug = lower(btrim(p ->> 'slug')), code = upper(btrim(p ->> 'code')),
      time_zone = btrim(p ->> 'timeZone'), data_region = coalesce(nullif(p ->> 'dataRegion', ''), 'in') where id = v_target;
    update org_domain set host = v_host where org_id = v_target and is_primary and host <> v_host;
    perform tenant_leave();
    update tenant_setup set name = regexp_replace(btrim(p ->> 'name'), '\s+', ' ', 'g'), updated_at = now() where id = p_setup;
  end if;
  perform tenant_step(p_setup, 'company', jsonb_build_object('host', v_host));
  return v_target;
end $$;
revoke all on function pulse.tenant_company(uuid, jsonb) from public;
grant execute on function pulse.tenant_company(uuid, jsonb) to pulse_api;

-- Brand: the same pictures as Settings → Organisation, plus the accent colour.
create function pulse.tenant_brand(p_setup uuid, p_kind text, p_bytes bytea, p_mime text, p_accent text) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_version int; v_accent text := nullif(lower(btrim(coalesce(p_accent, ''))), '');
begin
  perform tenant_enter(p_setup, true);
  insert into org_brand(org_id) values (current_org()) on conflict (org_id) do nothing;
  if p_kind = 'accent' then
    if v_accent is not null and v_accent !~ '^#[0-9a-f]{6}$' then raise exception 'Choose a colour like #5b45d6' using errcode = '22023'; end if;
    update org_brand set accent = v_accent, version = version + 1, updated_at = now() where org_id = current_org() returning version into v_version;
  else
    if p_kind not in ('mark','logo','logo_dark','logo_png') then raise exception 'Unknown picture' using errcode = '22023'; end if;
    if p_bytes is not null and (p_mime is null or p_mime not in ('image/svg+xml','image/png','image/webp','image/jpeg')) then raise exception 'Choose an SVG, PNG, WebP or JPEG' using errcode = '22023'; end if;
    if p_kind = 'logo_png' and p_bytes is not null and p_mime <> 'image/png' then raise exception 'The e-mail logo is a PNG' using errcode = '22023'; end if;
    execute format('update org_brand set %I=$1%s, version=version+1, updated_at=now() where org_id=current_org() returning version',
      p_kind, case when p_kind = 'logo_png' then '' else format(', %I=$2', p_kind || '_mime') end)
      using p_bytes, case when p_bytes is null then null else p_mime end into v_version;
  end if;
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'brand.' || p_kind, null,
          case when p_kind = 'accent' then coalesce(v_accent, 'removed') when p_bytes is null then 'removed' else p_mime || ' · ' || octet_length(p_bytes) || ' bytes' end, null);
  perform tenant_leave();
  perform tenant_step(p_setup, 'brand', '{}');
  return v_version;
end $$;
revoke all on function pulse.tenant_brand(uuid, text, bytea, text, text) from public;
grant execute on function pulse.tenant_brand(uuid, text, bytea, text, text) to pulse_api;

-- The wizard's preview of the pictures it saved (the public /api/v0/brand answers by address, which the operator's
-- page is not on).
create function pulse.tenant_brand_read(p_setup uuid, p_kind text) returns table(bytes bytea, mime text, version int)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_bytes bytea; v_mime text; v_version int;
begin
  if p_kind not in ('mark','logo','logo_dark','logo_png') then raise exception 'Unknown picture' using errcode = '22023'; end if;
  perform tenant_enter(p_setup, false);
  execute format('select %I, %s, version from org_brand where org_id = current_org()', p_kind,
    case when p_kind = 'logo_png' then quote_literal('image/png') else quote_ident(p_kind || '_mime') end)
    into v_bytes, v_mime, v_version;
  perform tenant_leave();
  return query select v_bytes, v_mime, v_version;
end $$;
revoke all on function pulse.tenant_brand_read(uuid, text) from public;
grant execute on function pulse.tenant_brand_read(uuid, text) to pulse_api;

-- A username in the company's own namespace: first.last, then first.last.2 …
create function pulse.tenant_username(p_name text) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_words text[]; v_base text; v_name text; v_suffix int := 1;
begin
  v_words := regexp_split_to_array(btrim(lower(regexp_replace(coalesce(p_name, ''), '[^a-zA-Z0-9 ]', '', 'g'))), '\s+');
  v_base := left(coalesce(nullif(v_words[1], ''), 'person') || '.' || coalesce(nullif(v_words[array_length(v_words, 1)], ''), 'staff'), 32);
  if v_words[1] is not null and array_length(v_words, 1) = 1 then v_base := left(coalesce(nullif(v_words[1], ''), 'person'), 32); end if;
  if length(v_base) < 3 then v_base := rpad(v_base, 3, '0'); end if;
  v_name := v_base;
  while exists (select 1 from people_profile where org_id = current_org() and username = v_name) loop
    v_suffix := v_suffix + 1; v_name := v_base || '.' || v_suffix;
  end loop;
  return v_name;
end $$;
revoke all on function pulse.tenant_username(text) from public;

-- One staff member in the company being set up (the wizard's own insert; HR's paths need a signed-in HR viewer).
create function pulse.tenant_person_add(p_name text, p_email text, p_title text, p_pod text, p_team text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_id uuid; v_no int;
begin
  insert into person(org_id, display_name, side, status, active_from) values (current_org(), p_name, 'staff', 'active', current_date) returning id into v_id;
  select coalesce(max(user_no), 0) + 1 into v_no from people_profile where org_id = current_org();
  insert into people_profile(org_id, person_id, role, pod, department, email, username, user_no, evidence, field_sources)
  values (current_org(), v_id, coalesce(nullif(p_title, ''), 'Team member'), nullif(p_pod, ''), nullif(p_team, ''), nullif(lower(p_email), ''),
          tenant_username(p_name), v_no, 'Added in company setup', '{}');
  if nullif(p_pod, '') is not null and not exists (select 1 from unit where org_id = current_org() and kind = 'pod' and valid_to is null and lower(name) = lower(p_pod)) then
    insert into unit(org_id, kind, name) values (current_org(), 'pod', p_pod);
  end if;
  return v_id;
end $$;
revoke all on function pulse.tenant_person_add(text, text, text, text, text) from public;

-- The first admin: a person with the admin role and a prepared invitation (the same pulse_priv.staff_invitation row
-- HR's "Invite to Pulse" prepares). Nothing is sent here.
create function pulse.tenant_admin(p_setup uuid, p_name text, p_email text, p_title text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_email text := lower(btrim(coalesce(p_email, '')));
  v_person uuid; v_user text; v_batch uuid := gen_random_uuid(); v_inv text;
begin
  if length(v_name) not between 2 and 80 then raise exception 'Give the admin''s full name' using errcode = '22023'; end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Give the admin''s work e-mail' using errcode = '22023'; end if;
  perform tenant_enter(p_setup, true);
  select pp.person_id into v_person from people_profile pp join person p on p.id = pp.person_id
   where pp.org_id = current_org() and p.status = 'active' and lower(pp.email) = v_email limit 1;
  if v_person is null then
    v_person := tenant_person_add(v_name, v_email, coalesce(nullif(btrim(p_title), ''), 'Admin'), null, null);
  else
    update person set display_name = v_name where id = v_person and display_name <> v_name;
    update people_profile set role = coalesce(nullif(btrim(p_title), ''), role) where person_id = v_person;
  end if;
  if not exists (select 1 from role_assignment where person_id = v_person and role_key = 'admin' and current_date between valid_from and coalesce(valid_to, 'infinity')) then
    insert into role_assignment(org_id, person_id, role_key, valid_from) values (current_org(), v_person, 'admin', current_date);
  end if;
  select username into v_user from people_profile where person_id = v_person;
  select status into v_inv from pulse_priv.staff_invitation where person_id = v_person;
  if v_inv is null or v_inv in ('prepared','blocked','failed') then
    insert into pulse_priv.staff_invitation(org_id, person_id, batch_id, recipient, username, status, prepared_by)
    values (current_org(), v_person, v_batch, v_email, v_user, 'prepared', null)
    on conflict (person_id) do update set batch_id = excluded.batch_id, recipient = excluded.recipient, username = excluded.username,
      status = 'prepared', blocked_reason = null, prepared_at = now(), token_hash = null, expires_at = null;
    v_inv := 'prepared';
  end if;
  perform audit_write('prepare', 'staff_invitation', v_person::text);
  perform tenant_leave();
  perform tenant_step(p_setup, 'admin', jsonb_build_object('person', v_person));
  return jsonb_build_object('personId', v_person, 'username', v_user, 'invitation', v_inv);
end $$;
revoke all on function pulse.tenant_admin(uuid, text, text, text) from public;
grant execute on function pulse.tenant_admin(uuid, text, text, text) to pulse_api;

-- The first admin's invitation: 'link' readies a one-time set-password link to hand over privately; 'send' moves it
-- to sending (the API then sends the e-mail and calls 'sent' or 'failed'). Rehearsal companies never send.
create function pulse.tenant_invite(p_setup uuid, p_action text, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_person uuid; v_row pulse_priv.staff_invitation%rowtype; v_org org%rowtype; v_out jsonb;
begin
  v_person := nullif((select steps -> 'admin' ->> 'person' from tenant_setup where id = p_setup), '')::uuid;
  -- After the company opens, the operator may still hand its first admin a way in, until that admin has signed in.
  perform tenant_enter(p_setup, false);
  select * into v_org from org where id = current_org();
  if v_person is null then raise exception 'Add the first admin first' using errcode = '22023'; end if;
  if p_action in ('link','send') and v_org.status <> 'setup' and (v_org.status <> 'active'
     or exists (select 1 from login_credential where person_id = v_person and status = 'active')) then
    raise exception 'The admin already signs in: the company''s own admins invite people now' using errcode = '42501';
  end if;
  if p_action in ('link','send') and (p_hash is null or p_hash !~ '^[0-9a-f]{64}$') then raise exception 'invalid token' using errcode = '22023'; end if;
  if p_action = 'send' and v_org.rehearsal then raise exception 'A rehearsal company never sends e-mail' using errcode = '42501'; end if;
  if p_action = 'link' then
    update pulse_priv.staff_invitation set token_hash = p_hash, expires_at = now() + interval '7 days'
     where person_id = v_person and status = 'prepared' returning * into v_row;
    if not found then raise exception 'The invitation changed; add the admin again' using errcode = '40001'; end if;
    perform audit_write('prepare_link', 'staff_invitation', v_person::text);
  elsif p_action = 'send' then
    update pulse_priv.staff_invitation set status = 'sending', token_hash = p_hash, expires_at = now() + interval '7 days'
     where person_id = v_person and status = 'prepared' returning * into v_row;
    if not found then raise exception 'The invitation changed; add the admin again' using errcode = '40001'; end if;
    perform audit_write('send_attempt', 'staff_invitation', v_person::text);
  elsif p_action in ('sent','failed') then
    update pulse_priv.staff_invitation set status = case when p_action = 'sent' then 'sent' else 'failed' end,
      sent_at = case when p_action = 'sent' then now() end, token_hash = case when p_action = 'sent' then token_hash end
     where person_id = v_person and status = 'sending' returning * into v_row;
    perform audit_write(case when p_action = 'sent' then 'send' else 'send_failed' end, 'staff_invitation', v_person::text);
  else
    raise exception 'Unknown invitation action' using errcode = '22023';
  end if;
  v_out := jsonb_build_object('recipient', v_row.recipient, 'username', v_row.username, 'status', v_row.status,
    'name', (select display_name from person where id = v_person), 'company', v_org.name, 'host', org_public_host());
  perform tenant_leave();
  if p_action in ('link','sent') then perform tenant_step(p_setup, 'invite', jsonb_build_object('how', p_action)); end if;
  return v_out;
end $$;
revoke all on function pulse.tenant_invite(uuid, text, text) from public;
grant execute on function pulse.tenant_invite(uuid, text, text) to pulse_api;

-- People: rows parsed by the API from a CSV (or a connected directory). Preview first (p_apply false), then apply.
-- A row matches an existing person by e-mail, then by the same name; new people get a username and no sign-in.
create function pulse.tenant_people(p_setup uuid, p_rows jsonb, p_apply boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  r jsonb; v_i int := 0; v_out jsonb := '[]'; v_new int := 0; v_update int := 0; v_skip int := 0; v_pods text[] := '{}'; v_teams text[] := '{}';
  v_name text; v_email text; v_title text; v_pod text; v_team text; v_access text; v_mgr text; v_person uuid; v_problems text[]; v_status text;
  v_seen text[] := '{}'; v_unresolved int := 0; v_roles int := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'Up to 2,000 people at a time' using errcode = '22023'; end if;
  perform tenant_enter(p_setup, true);
  for r in select value from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1; v_problems := '{}';
    v_name := regexp_replace(btrim(coalesce(r ->> 'name', '')), '\s+', ' ', 'g');
    v_email := lower(btrim(coalesce(r ->> 'email', '')));
    v_title := left(btrim(coalesce(r ->> 'title', '')), 80); v_pod := left(btrim(coalesce(r ->> 'pod', '')), 40);
    v_team := left(btrim(coalesce(r ->> 'team', '')), 60); v_access := lower(btrim(coalesce(r ->> 'access', '')));
    v_mgr := lower(btrim(coalesce(r ->> 'manager', '')));
    if length(v_name) < 2 then v_problems := array_append(v_problems, 'No name'::text); end if;
    if v_email <> '' and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then v_problems := array_append(v_problems, 'E-mail is not valid'::text); end if;
    if v_access <> '' and v_access not in ('admin','hr','leadership','finance','manager','member') then v_problems := array_append(v_problems, 'Access is admin, hr, leadership, finance, manager or member'::text); end if;
    if v_access = 'manager' and v_pod = '' then v_problems := array_append(v_problems, 'A manager needs a pod'::text); end if;
    if lower(coalesce(nullif(v_email, ''), v_name)) = any(v_seen) then v_problems := array_append(v_problems, 'Listed twice'::text); end if;
    v_seen := v_seen || lower(coalesce(nullif(v_email, ''), v_name));
    v_person := null;
    if cardinality(v_problems) = 0 then
      select pp.person_id into v_person from people_profile pp join person p on p.id = pp.person_id
       where pp.org_id = current_org() and p.status = 'active' and v_email <> '' and lower(pp.email) = v_email limit 1;
      if v_person is null then
        select p.id into v_person from person p where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'
         and lower(p.display_name) = lower(v_name) limit 1;
      end if;
    end if;
    v_status := case when cardinality(v_problems) > 0 then 'skip' when v_person is null then 'new' else 'update' end;
    if v_status = 'skip' then v_skip := v_skip + 1; elsif v_status = 'new' then v_new := v_new + 1; else v_update := v_update + 1; end if;
    if v_status <> 'skip' and v_pod <> '' and not (lower(v_pod) = any(select lower(x) from unnest(v_pods) x))
       and not exists (select 1 from unit where org_id = current_org() and kind = 'pod' and valid_to is null and lower(name) = lower(v_pod)) then v_pods := v_pods || v_pod; end if;
    if v_status <> 'skip' and v_team <> '' and not (lower(v_team) = any(select lower(x) from unnest(v_teams) x))
       and not exists (select 1 from people_profile where org_id = current_org() and lower(department) = lower(v_team)) then v_teams := v_teams || v_team; end if;
    if p_apply and v_status <> 'skip' then
      if v_person is null then
        v_person := tenant_person_add(v_name, v_email, v_title, v_pod, v_team);
      else
        update people_profile set email = coalesce(email, nullif(v_email, '')), role = case when v_title <> '' then v_title else role end,
          pod = coalesce(nullif(v_pod, ''), pod), department = coalesce(nullif(v_team, ''), department) where person_id = v_person;
        if v_pod <> '' and not exists (select 1 from unit where org_id = current_org() and kind = 'pod' and valid_to is null and lower(name) = lower(v_pod)) then
          insert into unit(org_id, kind, name) values (current_org(), 'pod', v_pod);
        end if;
      end if;
      if v_access in ('admin','hr','leadership','finance','manager') and not exists (select 1 from role_assignment where person_id = v_person and role_key = v_access
         and current_date between valid_from and coalesce(valid_to, 'infinity')) then
        insert into role_assignment(org_id, person_id, role_key, unit_id, is_manager_of_unit, valid_from)
        values (current_org(), v_person, v_access,
                case when v_access = 'manager' then (select id from unit where org_id = current_org() and kind = 'pod' and valid_to is null and lower(name) = lower(v_pod) limit 1) end,
                v_access = 'manager', current_date);
        v_roles := v_roles + 1;
      end if;
    end if;
    if v_i <= 300 then
      v_out := v_out || jsonb_build_object('row', v_i, 'name', v_name, 'email', nullif(v_email, ''), 'title', nullif(v_title, ''), 'pod', nullif(v_pod, ''),
        'team', nullif(v_team, ''), 'access', nullif(v_access, ''), 'manager', nullif(v_mgr, ''), 'status', v_status, 'problems', to_jsonb(v_problems));
    end if;
  end loop;
  -- Managers once everyone exists: by e-mail, then by name.
  for r in select value from jsonb_array_elements(p_rows) loop
    v_mgr := lower(btrim(coalesce(r ->> 'manager', '')));
    continue when v_mgr = '';
    v_email := lower(btrim(coalesce(r ->> 'email', ''))); v_name := regexp_replace(btrim(coalesce(r ->> 'name', '')), '\s+', ' ', 'g');
    select p.id into v_person from person p left join people_profile pp on pp.person_id = p.id where p.org_id = current_org() and p.status = 'active'
      and (lower(pp.email) = v_mgr or lower(p.display_name) = v_mgr) limit 1;
    if v_person is null and not p_apply and exists (select 1 from jsonb_array_elements(p_rows) x
       where lower(btrim(coalesce(x.value ->> 'email', ''))) = v_mgr or lower(regexp_replace(btrim(coalesce(x.value ->> 'name', '')), '\s+', ' ', 'g')) = v_mgr) then continue; end if;
    if v_person is null then v_unresolved := v_unresolved + 1; continue; end if;
    if p_apply then
      update people_profile pp set manager_id = v_person from person p where p.id = pp.person_id and pp.org_id = current_org() and pp.person_id <> v_person
        and pp.manager_id is null and ((v_email <> '' and lower(pp.email) = v_email) or (v_email = '' and lower(p.display_name) = lower(v_name)));
    end if;
  end loop;
  perform tenant_leave();
  if p_apply then perform tenant_step(p_setup, 'people', jsonb_build_object('added', v_new, 'updated', v_update, 'skipped', v_skip)); end if;
  return jsonb_build_object('applied', p_apply, 'new', v_new, 'update', v_update, 'skip', v_skip, 'newPods', to_jsonb(v_pods), 'newTeams', to_jsonb(v_teams),
    'unresolvedManagers', v_unresolved, 'rolesGranted', v_roles, 'rows', v_out, 'total', v_i);
end $$;
revoke all on function pulse.tenant_people(uuid, jsonb, boolean) from public;
grant execute on function pulse.tenant_people(uuid, jsonb, boolean) to pulse_api;

-- Pods, teams and roles: a list of small changes, all or nothing.
--   {op:'pod', name} · {op:'pod-rename', from, to} · {op:'place', personId, pod?, team?, title?}
--   {op:'role', personId, role, grant} · {op:'manager', personId, managerId}
create function pulse.tenant_structure(p_setup uuid, p_ops jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o jsonb; v_n int := 0; v_person uuid; v_name text; v_unit uuid; v_role text;
begin
  if jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) > 500 then raise exception 'Up to 500 changes at a time' using errcode = '22023'; end if;
  perform tenant_enter(p_setup, true);
  for o in select value from jsonb_array_elements(p_ops) loop
    v_n := v_n + 1;
    v_person := case when o ? 'personId' then (o ->> 'personId')::uuid end;
    if v_person is not null and not exists (select 1 from person where id = v_person and org_id = current_org() and side = 'staff' and status = 'active') then
      raise exception 'Choose a person in this company' using errcode = '22023';
    end if;
    case o ->> 'op'
    when 'pod' then
      v_name := regexp_replace(btrim(coalesce(o ->> 'name', '')), '\s+', ' ', 'g');
      if length(v_name) not between 2 and 40 then raise exception 'Give the pod a name of 2 to 40 characters' using errcode = '22023'; end if;
      if not exists (select 1 from unit where org_id = current_org() and kind = 'pod' and valid_to is null and lower(name) = lower(v_name)) then
        insert into unit(org_id, kind, name) values (current_org(), 'pod', v_name);
      end if;
    when 'pod-rename' then
      v_name := regexp_replace(btrim(coalesce(o ->> 'to', '')), '\s+', ' ', 'g');
      if length(v_name) not between 2 and 40 then raise exception 'Give the pod a name of 2 to 40 characters' using errcode = '22023'; end if;
      update unit set name = v_name where org_id = current_org() and kind = 'pod' and valid_to is null and name = o ->> 'from';
      update people_profile set pod = v_name where org_id = current_org() and pod = o ->> 'from';
    when 'place' then
      update people_profile set pod = case when o ? 'pod' then nullif(btrim(o ->> 'pod'), '') else pod end,
        department = case when o ? 'team' then nullif(left(btrim(o ->> 'team'), 60), '') else department end,
        role = case when nullif(btrim(coalesce(o ->> 'title', '')), '') is not null then left(btrim(o ->> 'title'), 80) else role end
       where person_id = v_person;
      if nullif(btrim(coalesce(o ->> 'pod', '')), '') is not null and not exists (select 1 from unit where org_id = current_org() and kind = 'pod' and valid_to is null and lower(name) = lower(btrim(o ->> 'pod'))) then
        insert into unit(org_id, kind, name) values (current_org(), 'pod', btrim(o ->> 'pod'));
      end if;
    when 'role' then
      v_role := o ->> 'role';
      if v_role not in ('admin','hr','leadership','finance','manager') then raise exception 'Choose a role: admin, hr, leadership, finance or manager' using errcode = '22023'; end if;
      if coalesce((o ->> 'grant')::boolean, true) then
        if not exists (select 1 from role_assignment where person_id = v_person and role_key = v_role and current_date between valid_from and coalesce(valid_to, 'infinity')) then
          v_unit := case when v_role = 'manager' then (select u.id from unit u join people_profile pp on pp.pod = u.name and pp.person_id = v_person where u.org_id = current_org() and u.kind = 'pod' and u.valid_to is null limit 1) end;
          if v_role = 'manager' and v_unit is null then raise exception 'Put this person in a pod before making them its manager' using errcode = '22023'; end if;
          insert into role_assignment(org_id, person_id, role_key, unit_id, is_manager_of_unit, valid_from) values (current_org(), v_person, v_role, v_unit, v_role = 'manager', current_date);
        end if;
      else
        if v_role = 'admin' and not exists (select 1 from role_assignment where org_id = current_org() and role_key = 'admin' and person_id <> v_person
           and current_date between valid_from and coalesce(valid_to, 'infinity')) then
          raise exception 'The company keeps at least one admin' using errcode = '22023';
        end if;
        update role_assignment set valid_to = current_date - 1 where person_id = v_person and role_key = v_role and current_date between valid_from and coalesce(valid_to, 'infinity');
      end if;
    when 'manager' then
      if o ->> 'managerId' is not null and not exists (select 1 from person where id = (o ->> 'managerId')::uuid and org_id = current_org() and status = 'active') then
        raise exception 'Choose a manager in this company' using errcode = '22023';
      end if;
      update people_profile set manager_id = nullif(o ->> 'managerId', '')::uuid where person_id = v_person and v_person is distinct from nullif(o ->> 'managerId', '')::uuid;
    else
      raise exception 'Unknown change %', coalesce(o ->> 'op', '(none)') using errcode = '22023';
    end case;
  end loop;
  perform tenant_leave();
  perform tenant_step(p_setup, 'structure', jsonb_build_object('changes', v_n));
  return jsonb_build_object('applied', v_n);
end $$;
revoke all on function pulse.tenant_structure(uuid, jsonb) from public;
grant execute on function pulse.tenant_structure(uuid, jsonb) to pulse_api;

-- Modules on or off and "Who can do what" (UX-TASKS rules; a scope must be one of that rule's options).
create function pulse.tenant_settings(p_setup uuid, p_modules jsonb, p_rules jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k text; r jsonb;
begin
  perform tenant_enter(p_setup, true);
  for k in select key from jsonb_each(coalesce(p_modules, '{}')) loop
    perform org_module_write(k, (p_modules ->> k)::boolean);
  end loop;
  for r in select value from jsonb_array_elements(coalesce(p_rules, '[]')) loop
    if not (r ->> 'scope') = any(coalesce(work_rule_options(r ->> 'role', r ->> 'action'), '{}')) then
      raise exception 'That choice is not available for this rule' using errcode = '22023';
    end if;
    insert into work_rule(org_id, role, action, scope, updated_by) values (current_org(), r ->> 'role', r ->> 'action', r ->> 'scope', null)
    on conflict (org_id, role, action) do update set scope = excluded.scope, updated_by = null, updated_at = now();
  end loop;
  perform tenant_leave();
  perform tenant_step(p_setup, 'settings', '{}');
  return jsonb_build_object('ok', true);
end $$;
revoke all on function pulse.tenant_settings(uuid, jsonb, jsonb) from public;
grant execute on function pulse.tenant_settings(uuid, jsonb, jsonb) to pulse_api;

-- What the wizard shows. While the company is being set up the operator sees its people (to place them and give
-- roles); once it is open, only counts.
create function pulse.tenant_state(p_setup uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_setup tenant_setup%rowtype; v_out jsonb; v_open boolean; v_admin uuid;
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  select * into v_setup from tenant_setup where id = p_setup;
  if not found then raise exception 'Setup not found' using errcode = 'P0002'; end if;
  v_out := jsonb_build_object('id', v_setup.id, 'name', v_setup.name, 'status', v_setup.status, 'steps', v_setup.steps, 'createdAt', v_setup.created_at);
  if v_setup.target_org_id is null then return v_out || jsonb_build_object('org', null); end if;
  v_admin := nullif(v_setup.steps -> 'admin' ->> 'person', '')::uuid;
  perform tenant_enter(p_setup, false);
  v_open := (select status from org where id = current_org()) <> 'setup';
  v_out := v_out || jsonb_build_object(
    'org', (select jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'code', o.code, 'timeZone', o.time_zone, 'dataRegion', o.data_region,
              'status', o.status, 'rehearsal', o.rehearsal, 'host', d.host, 'signIn', d.sign_in)
            from org o left join org_domain d on d.org_id = o.id and d.is_primary where o.id = current_org()),
    'brand', (select jsonb_build_object('version', coalesce(b.version, 0), 'mark', b.mark is not null, 'logo', b.logo is not null,
              'logoDark', b.logo_dark is not null, 'logoPng', b.logo_png is not null, 'accent', b.accent) from (select 1) x left join org_brand b on b.org_id = current_org()),
    'admin', (select jsonb_build_object('personId', p.id, 'name', p.display_name, 'email', pp.email, 'username', pp.username, 'title', pp.role,
              'invitation', i.status, 'linkReady', i.token_hash is not null and i.status = 'prepared', 'sentAt', i.sent_at, 'expiresAt', i.expires_at,
              'signedIn', exists (select 1 from login_credential l where l.person_id = p.id and l.status = 'active'))
            from person p join people_profile pp on pp.person_id = p.id left join pulse_priv.staff_invitation i on i.person_id = p.id where p.id = v_admin),
    'counts', jsonb_build_object(
      'people', (select count(*) from person where org_id = current_org() and side = 'staff' and status = 'active'),
      'withEmail', (select count(*) from people_profile pp join person p on p.id = pp.person_id where pp.org_id = current_org() and p.status = 'active' and pp.email is not null),
      'pods', (select count(*) from unit where org_id = current_org() and kind = 'pod' and valid_to is null),
      'teams', (select count(distinct lower(department)) from people_profile where org_id = current_org() and department is not null),
      'admins', (select count(distinct person_id) from role_assignment where org_id = current_org() and role_key = 'admin' and current_date between valid_from and coalesce(valid_to, 'infinity')),
      'signedIn', (select count(*) from login_credential where org_id = current_org() and status = 'active'),
      'projects', (select count(*) from project where org_id = current_org()),
      'tasks', (select count(*) from task where org_id = current_org())),
    'modules', org_modules(),
    'rules', coalesce((select jsonb_agg(jsonb_build_object('role', w.role, 'action', w.action, 'scope', w.scope)) from work_rule w where w.org_id = current_org()), '[]'),
    'twoStep', (select jsonb_build_object('required', required, 'graceUntil', grace_until) from pulse_priv.auth_policy where org_id = current_org()),
    'pods', coalesce((select jsonb_agg(name order by name) from unit where org_id = current_org() and kind = 'pod' and valid_to is null), '[]'),
    'people', case when v_open then null else coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'email', pp.email, 'title', pp.role,
              'pod', pp.pod, 'team', pp.department, 'managerId', pp.manager_id, 'username', pp.username,
              'roles', coalesce((select jsonb_agg(r.role_key order by r.role_key) from role_assignment r where r.person_id = p.id and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')), '[]'))
              order by p.display_name)
            from person p join people_profile pp on pp.person_id = p.id where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'), '[]') end);
  perform tenant_leave();
  return v_out;
end $$;
revoke all on function pulse.tenant_state(uuid) from public;
grant execute on function pulse.tenant_state(uuid) to pulse_api;

-- Open for sign-in once the blocking gates pass; the isolation self-check result comes from the API, which runs it as
-- the API role inside the new company.
create function pulse.tenant_open(p_setup uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_steps jsonb; v_blocked text[] := '{}';
begin
  select steps into v_steps from tenant_setup where id = p_setup;
  perform tenant_enter(p_setup, true);
  if not exists (select 1 from org_domain where org_id = current_org() and is_primary) then v_blocked := array_append(v_blocked, 'The company has no web address'::text); end if;
  if not exists (select 1 from role_assignment r join people_profile pp on pp.person_id = r.person_id where r.org_id = current_org() and r.role_key = 'admin'
     and pp.email is not null and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')) then v_blocked := array_append(v_blocked, 'The company has no admin with an e-mail'::text); end if;
  if coalesce((v_steps -> 'isolation' ->> 'leaks')::int, -1) <> 0
     or coalesce((v_steps -> 'isolation' ->> 'at')::timestamptz, '-infinity') < now() - interval '1 hour' then
    v_blocked := array_append(v_blocked, 'Run the isolation check (it must find nothing from another company)'::text);
  end if;
  if cardinality(v_blocked) > 0 then
    perform tenant_leave();
    return jsonb_build_object('opened', false, 'blocked', to_jsonb(v_blocked));
  end if;
  update org set status = 'active' where id = current_org();
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'status', 'setup', 'active', null);
  perform tenant_leave();
  update tenant_setup set status = 'open', updated_at = now() where id = p_setup;
  perform tenant_step(p_setup, 'open', '{}');
  return jsonb_build_object('opened', true, 'blocked', '[]'::jsonb);
end $$;
revoke all on function pulse.tenant_open(uuid) from public;
grant execute on function pulse.tenant_open(uuid) to pulse_api;

create function pulse.tenant_isolation_record(p_setup uuid, p_tables int, p_leaks int, p_detail jsonb) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  perform tenant_step(p_setup, 'isolation', jsonb_build_object('tables', p_tables, 'leaks', p_leaks, 'detail', coalesce(p_detail, '[]')));
end $$;
revoke all on function pulse.tenant_isolation_record(uuid, int, int, jsonb) from public;
grant execute on function pulse.tenant_isolation_record(uuid, int, int, jsonb) to pulse_api;

-- The companies list: the install's own company first, then each one set up here, with counts only.
create function pulse.tenant_list() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_out jsonb := '[]'; s record; v_row jsonb;
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  v_out := v_out || jsonb_build_array((select jsonb_build_object('setupId', null, 'own', true, 'name', o.name, 'code', o.code, 'status', o.status, 'rehearsal', o.rehearsal,
    'host', (select host from org_domain where org_id = o.id and is_primary), 'people', (select count(*) from person where org_id = o.id and side = 'staff' and status = 'active'))
    from org o where o.id = current_org()));
  for s in select id, name, status, target_org_id, created_at from tenant_setup where org_id = current_org() order by created_at loop
    if s.target_org_id is null then
      v_out := v_out || jsonb_build_array(jsonb_build_object('setupId', s.id, 'own', false, 'name', s.name, 'status', 'draft', 'createdAt', s.created_at));
      continue;
    end if;
    perform tenant_enter(s.id, false);
    select jsonb_build_object('setupId', s.id, 'own', false, 'name', o.name, 'code', o.code, 'status', o.status, 'rehearsal', o.rehearsal, 'createdAt', s.created_at,
      'host', (select host from org_domain where org_id = o.id and is_primary),
      'people', (select count(*) from person where org_id = o.id and side = 'staff' and status = 'active'),
      'signedIn', (select count(*) from login_credential where org_id = o.id and status = 'active'),
      'modules', org_modules()) into v_row from org o where o.id = current_org();
    perform tenant_leave();
    v_out := v_out || jsonb_build_array(v_row);
  end loop;
  return v_out;
end $$;
revoke all on function pulse.tenant_list() from public;
grant execute on function pulse.tenant_list() to pulse_api;

-- The isolation self-check reads every company table (org_id) through the API role: the list comes from the catalogue.
create function pulse.tenant_tables() returns setof text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
   where n.nspname in ('pulse', 'pulse_priv', 'privacy') and c.relkind in ('r', 'p') and not c.relispartition
     and has_table_privilege('pulse_api', c.oid, 'select')
   order by 1
$$;
revoke all on function pulse.tenant_tables() from public;
grant execute on function pulse.tenant_tables() to pulse_api;

-- The push sender (pulse_worker) and the API's own jobs deliver for every active company, not only the install's.
grant execute on function pulse.list_active_orgs() to pulse_api;

-- migrate:down
-- Forward-only: companies and their addresses must remain auditable.
