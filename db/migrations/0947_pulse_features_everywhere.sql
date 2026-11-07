-- migrate:up
-- PULSE-HQ (owner, 23 Oct 2026): every organisation sees what Pulse can do. The catalogue is kept in the Pulse
-- organisation (0944/0945); pulse.pulse_features() reads its live entries (not archived, not drafts of new ideas) for
-- whichever organisation asks, read only. Pulse's editors archive a feature instead of losing it.
-- Safe on a live install: additive (one column, one function).

alter table pulse.hq_feature add column archived boolean not null default false;

-- Row-level security is forced on the catalogue, so the function steps into the Pulse organisation for the read and back.
create function pulse.pulse_features() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_org uuid; v_back text := coalesce(current_setting('pulse.org_id', true), ''); r jsonb;
begin
  if current_org() is null then return '[]'::jsonb; end if;
  select id into v_org from org where handle = 'pulsehq';
  if v_org is null then return '[]'::jsonb; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'key', f.key, 'category', f.category, 'name', f.name, 'promise', f.promise,
      'what', f.what, 'who', f.who, 'status', f.status, 'icon', f.icon, 'proof', f.proof, 'sort', f.sort)
    order by f.category, f.sort, f.name), '[]'::jsonb) into r
  from hq_feature f where f.org_id = v_org and not f.archived;
  perform set_config('pulse.org_id', v_back, true);
  return r;
end $$;
revoke all on function pulse.pulse_features() from public;
grant execute on function pulse.pulse_features() to pulse_api;

-- migrate:down
drop function if exists pulse.pulse_features();
alter table pulse.hq_feature drop column if exists archived;
