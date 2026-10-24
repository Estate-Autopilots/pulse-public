-- migrate:up
-- PULSE-HQ (owner, 23 Oct 2026): the licence register reads from the Pulse organisation (0946), where row-level security
-- (forced on pulse.person) hid every other organisation's people, so Estate Autopilots showed "0 active". The register
-- now counts each hosted organisation's active people from inside that organisation, then steps back.
-- Safe on a live install: one function replaced, same answer shape.

create or replace function pulse.licence_list() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_back text := coalesce(current_setting('pulse.org_id', true), ''); v_people jsonb := '{}'::jsonb; r record; n int;
begin
  if not exists (select 1 from pulse.org o where o.id = current_org()
      and (o.handle = 'pulsehq' or (o.handle = 'estateautopilots' and not exists (select 1 from pulse.org p where p.handle = 'pulsehq')))) then
    raise exception 'Licences are kept by the platform organisation' using errcode = '42501';
  end if;
  for r in select distinct l.org_id from pulse_priv.pulse_licence l where l.hosting = 'central' and l.org_id is not null loop
    perform set_config('pulse.org_id', r.org_id::text, true);
    select count(*) into n from pulse.person p where p.org_id = r.org_id and p.status = 'active';
    v_people := v_people || jsonb_build_object(r.org_id::text, n);
  end loop;
  perform set_config('pulse.org_id', v_back, true);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'key', l.licence_key, 'name', l.org_name, 'handle', l.org_handle, 'orgId', l.org_id, 'hosting', l.hosting,
      'address', l.address, 'plan', l.plan, 'seats', l.seats, 'status', l.status, 'issuedOn', l.issued_on,
      'renewsOn', l.renews_on, 'note', l.note,
      'people', case when l.hosting = 'central' and l.org_id is not null then (v_people ->> l.org_id::text)::int end)
    order by (l.org_handle = 'pulsehq') desc, (l.org_handle = 'estateautopilots') desc, l.issued_on, l.org_name)
    from pulse_priv.pulse_licence l), '[]'::jsonb);
end $$;
revoke all on function pulse.licence_list() from public;
grant execute on function pulse.licence_list() to pulse_api;

-- migrate:down
-- 0946's version stays correct where the register is read from Estate Autopilots itself.
