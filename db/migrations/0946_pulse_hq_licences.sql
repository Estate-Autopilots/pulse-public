-- migrate:up
-- PULSE-HQ (owner, 23 Oct 2026): Pulse is its own business, and the Pulse organisation (@pulsehq, 0944) owns the
-- platform. The licence register (0943) answers there, inside Pulse HQ. Estate Autopilots keeps reading it until the
-- Pulse organisation exists on the install, so nothing breaks before it opens. The Pulse organisation gets its own
-- licence (PL-PU-0000, platform owner) and Estate Autopilots becomes the founding customer it is.
-- Safe on a live install: additive (one function replaced with a wider check, one row added, one plan renamed).

create or replace function pulse.licence_list() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if not exists (select 1 from pulse.org o where o.id = current_org()
      and (o.handle = 'pulsehq' or (o.handle = 'estateautopilots' and not exists (select 1 from pulse.org p where p.handle = 'pulsehq')))) then
    raise exception 'Licences are kept by the platform organisation' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'key', l.licence_key, 'name', l.org_name, 'handle', l.org_handle, 'orgId', l.org_id, 'hosting', l.hosting,
      'address', l.address, 'plan', l.plan, 'seats', l.seats, 'status', l.status, 'issuedOn', l.issued_on,
      'renewsOn', l.renews_on, 'note', l.note,
      'people', case when l.hosting = 'central' and l.org_id is not null
        then (select count(*) from pulse.person p where p.org_id = l.org_id and p.status = 'active') end)
    order by (l.org_handle = 'pulsehq') desc, (l.org_handle = 'estateautopilots') desc, l.issued_on, l.org_name)
    from pulse_priv.pulse_licence l), '[]'::jsonb);
end $$;
revoke all on function pulse.licence_list() from public;
grant execute on function pulse.licence_list() to pulse_api;

insert into pulse_priv.pulse_licence (licence_key, org_name, org_handle, org_id, hosting, address, plan, seats, status, issued_on, note)
select 'PL-PU-0000', 'Pulse', 'pulsehq', (select id from pulse.org where handle = 'pulsehq'), 'central', 'https://pulse.estateautopilots.com',
  'Platform owner', null, 'active', date '2026-10-23',
  'The business of Pulse: holds the register, the feature catalogue, the offers and the update channel for every licensed install.'
on conflict do nothing;
update pulse_priv.pulse_licence set plan = 'Founding customer · hosted',
  note = 'The first company on Pulse, and where it was built. Hosted on the original install.'
 where org_handle = 'estateautopilots' and plan = 'Platform owner';

-- migrate:down
update pulse_priv.pulse_licence set plan = 'Platform owner' where org_handle = 'estateautopilots' and plan = 'Founding customer · hosted';
delete from pulse_priv.pulse_licence where licence_key = 'PL-PU-0000';

