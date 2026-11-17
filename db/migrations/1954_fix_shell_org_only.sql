-- migrate:up
-- FIX-SHELL (owner walkthrough, 10 Nov 2026).
-- 1. "Funding: the owner can't reach it from Estate Autopilots. Make Focus/Funding reachable from any org: a link that
--    switches over. Never show a dead page." pulse.account_org_only() gives, for each of the signed-in account's staff
--    seats (pulse.account_seats, 1460), the organisation-only modules that organisation has switched on (pulse_hq,
--    focus, funding, product_map: services/api/src/modules.ts ORG_ONLY). The menu then links Focus and Funding to the
--    company that has them (/@handle/focus) instead of a "not switched on" page. Each organisation is read under its
--    own row security, as pulse.account_seat_looks (1601) reads it: pulse.org_id is set to the seat's organisation (no
--    viewer) and put back afterwards. Module names only; nothing else crosses organisations.
-- 2. "Product map shouldn't appear for Estate Autopilots (it's an internal tool)": product_map is organisation-only now,
--    switched on in the platform's own organisations (vitalstechnologies, suyashhq) and off everywhere else.
create function pulse.account_org_only() returns jsonb
  language plpgsql security definer set search_path to 'pulse', 'pg_temp' as $function$
declare
  o text := coalesce(current_setting('pulse.org_id', true), '');
  vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  s record; mods jsonb; on_list jsonb; out jsonb := '[]'::jsonb;
begin
  if current_viewer() is null then return out; end if;
  for s in select seat_org from account_seats() where seat_kind = 'staff' limit 24 loop
    perform set_config('pulse.org_id', s.seat_org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    select body into mods from tenant_config where org_id = s.seat_org and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
    perform set_config('pulse.org_id', o, true);
    perform set_config('pulse.viewer_id', vw, true);
    -- "off" wins over "on", as readModules decides.
    select coalesce(jsonb_agg(m), '[]'::jsonb) into on_list
      from jsonb_array_elements_text(case when jsonb_typeof(mods -> 'on') = 'array' then mods -> 'on' else '[]'::jsonb end) m
     where m in ('pulse_hq', 'focus', 'funding', 'product_map')
       and not (case when jsonb_typeof(mods -> 'off') = 'array' then mods -> 'off' else '[]'::jsonb end) ? m;
    if jsonb_array_length(on_list) > 0 then out := out || jsonb_build_array(jsonb_build_object('id', s.seat_org, 'on', on_list)); end if;
  end loop;
  return out;
end $function$;
revoke all on function pulse.account_org_only() from public;
grant execute on function pulse.account_org_only() to pulse_api;

do $$
declare v_org uuid; mods jsonb; h text;
begin
  foreach h in array array['vitalstechnologies', 'suyashhq'] loop
    select id into v_org from pulse.org where handle = h;
    continue when v_org is null;
    perform set_config('pulse.org_id', v_org::text, true);
    select body into mods from pulse.tenant_config where org_id = v_org and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
    if mods is null then
      insert into pulse.tenant_config(org_id, doc_kind, doc_key, version, body, is_active)
      values (v_org, 'tenant', 'modules', 1, '{"off": [], "on": ["product_map"]}'::jsonb, true);
    elsif not coalesce(mods -> 'on', '[]'::jsonb) ? 'product_map' then
      update pulse.tenant_config set body = jsonb_set(body, '{on}', coalesce(body -> 'on', '[]'::jsonb) || '["product_map"]'::jsonb)
       where org_id = v_org and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
    end if;
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
drop function if exists pulse.account_org_only();
