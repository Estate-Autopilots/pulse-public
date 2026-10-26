-- migrate:up
-- EST-2536: make migrated organisations reachable through the existing operator setup/check/readiness path.
create or replace function pulse.tenant_list() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_out jsonb := '[]'; s record; v_row jsonb;
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  -- Migrated companies have no wizard record. Attach operator-owned tracking only; do not
  -- change their status, activation, domains, people or business rows. The existing private
  -- owner directory enumerates organisations; runtime SELECT policies stay tenant scoped.
  insert into tenant_setup(org_id, target_org_id, name, status, created_by)
    select current_org(), o.id,
      case when length(btrim(o.name)) < 2 then o.code else left(btrim(o.name), 80) end,
      case when o.status = 'setup' then 'setup' when o.activation = 'live' then 'live' else 'open' end,
      current_viewer()
    from org o left join tenant_setup tracked on tracked.target_org_id = o.id
    where o.id <> current_org() and tracked.id is null
    on conflict (target_org_id) do nothing;
  v_out := v_out || jsonb_build_array((select jsonb_build_object('setupId', null, 'own', true, 'name', o.name, 'code', o.code, 'status', o.status, 'rehearsal', o.rehearsal,
    'activation', o.activation, 'host', (select host from org_domain where org_id = o.id and is_primary),
    'people', (select count(*) from person where org_id = o.id and side = 'staff' and status = 'active'))
    from org o where o.id = current_org()));
  for s in select id, name, status, target_org_id, created_at from tenant_setup where org_id = current_org() order by created_at loop
    if s.target_org_id is null then
      v_out := v_out || jsonb_build_array(jsonb_build_object('setupId', s.id, 'own', false, 'name', s.name, 'status', 'draft', 'createdAt', s.created_at));
      continue;
    end if;
    perform tenant_enter(s.id, false);
    select jsonb_build_object('setupId', s.id, 'own', false, 'name', o.name, 'code', o.code, 'status', o.status, 'rehearsal', o.rehearsal, 'createdAt', s.created_at,
      'activation', o.activation, 'host', (select host from org_domain where org_id = o.id and is_primary),
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

-- migrate:down
-- Forward only: operator tracking and isolation evidence must be retained.
