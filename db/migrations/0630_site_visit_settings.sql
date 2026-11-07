-- migrate:up
-- EST-1407 (Willow Lane hand-off #3, contract 1.0.0-rc.1 §1): Settings → Site visit as numbered versions. Each save adds
-- the next version for the organisation and nothing is overwritten, so a visit can keep the field set it started with.
-- No row means version 1, the defaults (services/api/src/site-visit-settings.ts). The API checks the body's shape; this
-- function also makes sure only an admin saves, that the save was made from the newest version (40001, answered 409)
-- and that no visit-type or field key of the newest version is left out (keys are archived, never removed).

create table pulse.site_visit_field_set (
  org_id     uuid not null references pulse.org(id),
  version    int not null check (version >= 2),
  body       jsonb not null check (jsonb_typeof(body) = 'object' and jsonb_typeof(body -> 'visitTypes') = 'array'
                                   and jsonb_typeof(body -> 'fields') = 'array' and jsonb_typeof(body -> 'banner') = 'object'),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  primary key (org_id, version)
);
alter table pulse.site_visit_field_set enable row level security;
alter table pulse.site_visit_field_set force row level security;
create policy tenant on pulse.site_visit_field_set using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.site_visit_field_set to pulse_api, pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.site_visit_field_set for each row execute function pulse.audit_mutation();

create function pulse.site_visit_settings_save(p_edited int, p_body jsonb) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_current int; v_before jsonb; v_missing text[];
begin
  if not viewer_is('admin') or current_viewer() is null then
    raise exception 'An organisation admin changes the site-visit settings' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('site_visit_field_set:' || current_org()::text));
  select version, body into v_current, v_before from site_visit_field_set where org_id = current_org() order by version desc limit 1;
  v_current := coalesce(v_current, 1);
  if p_edited is distinct from v_current then
    raise exception 'Someone saved these settings since you opened them: reload and try again' using errcode = '40001';
  end if;
  select array_agg(k) into v_missing from (
    select e ->> 'key' k from jsonb_array_elements(coalesce(v_before -> 'visitTypes', '[]')) e
    where not exists (select 1 from jsonb_array_elements(p_body -> 'visitTypes') n where n ->> 'key' = e ->> 'key')
    union all
    select e ->> 'key' from jsonb_array_elements(coalesce(v_before -> 'fields', '[]')) e
    where not exists (select 1 from jsonb_array_elements(p_body -> 'fields') n where n ->> 'key' = e ->> 'key')) gone;
  if v_missing is not null then
    raise exception 'Keys are never removed: archive a field or visit type instead' using errcode = '22023';
  end if;
  insert into site_visit_field_set(org_id, version, body, created_by) values (current_org(), v_current + 1, p_body, current_viewer());
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'site_visit.field_set_version', v_current::text, (v_current + 1)::text, current_viewer());
  return v_current + 1;
end $$;
revoke all on function pulse.site_visit_settings_save(int, jsonb) from public;
grant execute on function pulse.site_visit_settings_save(int, jsonb) to pulse_api;

-- migrate:down
-- Forward-only: versions are history.
