-- migrate:up
-- First run of a new install (ADR-0031 §2): the operator creates the company and its first admin in one transaction.
-- Nothing here has a default: the company's name, slug, code and time zone and the admin's name and email are required.
create function pulse.install_init(p_name text, p_slug text, p_code text, p_time_zone text,
                                   p_admin_email text, p_admin_name text, p_actor text)
  returns table(org_id uuid, person_id uuid, username text, temporary_password text)
  language plpgsql security definer set search_path=pulse,public,pg_temp as $$
declare
  v_org uuid := gen_random_uuid();
  v_person uuid;
  v_password text;
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_admin text := btrim(regexp_replace(coalesce(p_admin_name, ''), '\s+', ' ', 'g'));
  v_email text := lower(btrim(coalesce(p_admin_email, '')));
  v_actor text := btrim(coalesce(p_actor, ''));
begin
  if exists (select 1 from install) then raise exception 'Pulse is already initialised' using errcode = '23505'; end if;
  if length(v_name) not between 2 and 80 then raise exception 'Company name must be 2 to 80 characters' using errcode = '22023'; end if;
  if coalesce(p_slug, '') !~ '^[a-z0-9][a-z0-9-]{1,39}$' then
    raise exception 'Slug must be 2 to 40 lowercase letters, digits or dashes' using errcode = '22023';
  end if;
  if coalesce(p_code, '') !~ '^[A-Z]{2,4}$' then raise exception 'Company code must be 2 to 4 capital letters' using errcode = '22023'; end if;
  if not exists (select 1 from pg_timezone_names where name = p_time_zone) then
    raise exception 'Time zone must be an IANA name such as Europe/London' using errcode = '22023';
  end if;
  if v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email) > 120 then
    raise exception 'Enter a valid admin email address' using errcode = '22023';
  end if;
  if length(v_admin) not between 2 and 120 then raise exception 'Admin name must be 2 to 120 characters' using errcode = '22023'; end if;
  if length(v_actor) not between 1 and 60 then raise exception 'Actor is required' using errcode = '22023'; end if;

  -- Tenant rows are written under the new company's id (RLS); the audit trail names the operator, not a person.
  perform set_config('pulse.org_id', v_org::text, true);
  perform set_config('pulse.actor_account', v_actor, true);
  perform set_config('pulse.viewer_id', '', true);
  insert into org(id, slug, name, code, time_zone) values (v_org, p_slug, v_name, p_code, p_time_zone);
  insert into install(org_id, initialised_by) values (v_org, v_actor);
  insert into person(org_id, display_name, side) values (v_org, v_admin, 'staff') returning id into v_person;
  insert into people_profile(org_id, person_id, role, email, evidence, locked)
  values (v_org, v_person, 'Admin', v_email, 'Created by the operator at install.', '{name,role,status}');
  insert into role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, 'admin', current_date);

  -- The sign-in comes from the same path as an admin-issued account: login_issue (username, temporary password,
  -- must_change). It acts for an admin viewer, which is the new admin themselves until the first sign-in.
  perform set_config('pulse.viewer_id', v_person::text, true);
  v_password := translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_');
  perform login_issue(v_person, v_password);
  perform set_config('pulse.viewer_id', '', true);
  perform audit_write('install_init', 'org', v_org::text, array['name', 'slug', 'code', 'time_zone', 'admin']);

  return query select v_org, v_person, pp.username, v_password from people_profile pp where pp.person_id = v_person;
end $$;
revoke all on function pulse.install_init(text, text, text, text, text, text, text) from public;
grant execute on function pulse.install_init(text, text, text, text, text, text, text) to pulse_api;

-- Operator rename of the install's company (the same rule as POST /api/v0/settings/org).
create function pulse.operator_org_set(p_name text, p_actor text) returns void
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare
  v_org uuid;
  v_before text;
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_actor text := btrim(coalesce(p_actor, ''));
begin
  select i.org_id into v_org from install i where i.id;
  if v_org is null then raise exception 'Pulse is not initialised' using errcode = 'P0002'; end if;
  if length(v_name) not between 2 and 80 then raise exception 'Company name must be 2 to 80 characters' using errcode = '22023'; end if;
  if length(v_actor) not between 1 and 60 then raise exception 'Actor is required' using errcode = '22023'; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  perform set_config('pulse.actor_account', v_actor, true);
  perform set_config('pulse.viewer_id', '', true);
  select name into v_before from org where id = v_org for update;
  if v_before is distinct from v_name then
    update org set name = v_name where id = v_org;
    insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value)
    values (v_org, 'org', v_org, 'name', v_before, v_name);
  end if;
  perform audit_write('operator_org_set', 'org', v_org::text, array['name']);
end $$;
revoke all on function pulse.operator_org_set(text, text) from public;
grant execute on function pulse.operator_org_set(text, text) to pulse_api;

-- migrate:down
-- Forward-only: an install's first-run record and its audit trail must remain.
