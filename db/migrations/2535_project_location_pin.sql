-- migrate:up
-- USER-INSIGHT (RMA onboarding, 23 Nov 2026; 2535: PM-BUILD-4 has 2532): an admin could not put a project on the Map. "Link map development"
-- (POST /api/v0/projects/:id/location) inserted into project_location and project_location_member as pulse_api, which
-- 0010 lets only read them (and move an existing pin): "permission denied for table project_location", every company.
-- The API login keeps no write grant on either table; this one admin-only function is the door. It runs as the table
-- owner, which does not bypass row security (the tables FORCE it), so the tenant policy still holds every statement to
-- the caller's company, and each statement also names the company itself.
-- A pin also says how exact it is (RMA gap 2): exact, building, street, locality or city (the column already allowed them).
create function pulse.pin_project_location(p_project uuid, p_location uuid, p_lat double precision, p_lng double precision,
                                           p_precision text, p_note text)
returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  v_org uuid := current_org();
  v_name text;
  v_loc uuid;
  v_old record;
  v_source text;
begin
  if not viewer_is('admin') or current_viewer() is null then
    raise exception 'admin required' using errcode = '42501';
  end if;
  select coalesce(title, name) into v_name from project where id = p_project and org_id = v_org;
  if not found then raise exception 'project not found' using errcode = 'P0002'; end if;
  if p_location is not null then
    perform 1 from project_location where id = p_location and org_id = v_org;
    if not found then raise exception 'location not found' using errcode = 'P0002'; end if;
    v_loc := p_location;
  else
    if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
      raise exception 'give a valid latitude and longitude' using errcode = '22023';
    end if;
    if p_precision is null or p_precision not in ('exact', 'building', 'street', 'locality', 'city') then
      raise exception 'precision is exact, building, street, locality or city' using errcode = '22023';
    end if;
    if nullif(btrim(coalesce(p_note, '')), '') is null then
      raise exception 'say where the point comes from' using errcode = '22023';
    end if;
    v_source := 'pulse_pin:' || left(btrim(p_note), 300);
    select id, lat, lng, precision, source into v_old from project_location
      where org_id = v_org and geo_key = 'pulse:' || p_project for update;
    insert into project_location (org_id, geo_key, name, lat, lng, precision, source, pinned_by, pinned_at)
      values (v_org, 'pulse:' || p_project, v_name, p_lat, p_lng, p_precision, v_source, current_viewer(), now())
      on conflict (org_id, geo_key) do update set lat = excluded.lat, lng = excluded.lng, precision = excluded.precision,
        source = excluded.source, pinned_by = excluded.pinned_by, pinned_at = now(), updated_at = now()
      returning id into v_loc;
    insert into project_location_change (org_id, location_id, action, old_lat, old_lng, old_precision, old_source,
                                         new_lat, new_lng, new_precision, new_source, note, changed_by)
      values (v_org, v_loc, 'pin', v_old.lat, v_old.lng, v_old.precision, v_old.source,
              p_lat, p_lng, p_precision, v_source, left(btrim(p_note), 300), current_viewer());
  end if;
  insert into project_location_member (org_id, project_id, location_id, basis) values (v_org, p_project, v_loc, 'pulse')
    on conflict (project_id) do update set location_id = excluded.location_id, basis = 'pulse'
    where project_location_member.org_id = v_org;
  return v_loc;
end $$;
revoke all on function pulse.pin_project_location(uuid, uuid, double precision, double precision, text, text) from public;
grant execute on function pulse.pin_project_location(uuid, uuid, double precision, double precision, text, text) to pulse_api;

-- migrate:down
drop function if exists pulse.pin_project_location(uuid, uuid, double precision, double precision, text, text);
