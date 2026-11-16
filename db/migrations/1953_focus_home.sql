-- migrate:up
-- (UX-GAMIFY: numbered 1905, above dev/live's 1897.)
-- UX-GAMIFY (owner, 9 Nov 2026). Two things for Focus, both small:
--
-- 1. pulse.account_module_home(module): where an organisation-only module (focus, funding, pulse_hq) is switched on for
--    the signed-in account, so /focus typed or kept in another organisation opens that organisation's Focus instead of a
--    dead "not switched on" page (COMMON.md UI QUALITY GATE, rule 6). It answers only for the account's own staff seats
--    where the person is an admin today, and only the organisation's id and name. Each organisation is read under its
--    own row security, as pulse.account_seat_looks (1601) reads it: pulse.org_id is set to the seat's organisation (no
--    viewer) and put back afterwards.
--
-- 2. The owner's collector (tools/focus/collect.py on the EA server, every 5 minutes) gets its ingest key, so Focus
--    stops saying "No reading" (FOCUS-P1 left this as an errand). Only the key's sha256 is here, the same thing
--    pulse_priv.focus_ingest_key stores when an admin presses "Make a key"; the key itself never left the server
--    (~eadev/.config/focus/ingest.key, mode 600). Nothing is replaced: an organisation that already made a key keeps it,
--    and "Make a new key" in Focus → Settings replaces this one at any time. Nothing happens on an install without the
--    owner's own workspace.
create function pulse.account_module_home(p_module text) returns jsonb
  language plpgsql security definer set search_path to 'pulse', 'pg_temp' as $function$
declare
  o text := coalesce(current_setting('pulse.org_id', true), '');
  vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  s record; mods jsonb; is_admin boolean; found jsonb := null;
begin
  if current_viewer() is null or p_module not in ('focus', 'funding', 'pulse_hq') then return null; end if;
  for s in select seat_org, seat_person, org_name, seat_kind from account_seats() where seat_kind = 'staff' and not is_current limit 24 loop
    perform set_config('pulse.org_id', s.seat_org::text, true);
    perform set_config('pulse.viewer_id', '', true);
    select body into mods from tenant_config where org_id = s.seat_org and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
    select exists (select 1 from role_assignment r where r.person_id = s.seat_person and r.role_key = 'admin'
      and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')) into is_admin;
    perform set_config('pulse.org_id', o, true);
    perform set_config('pulse.viewer_id', vw, true);
    if is_admin and coalesce(mods->'on', '[]'::jsonb) ? p_module and not coalesce(mods->'off', '[]'::jsonb) ? p_module then
      found := jsonb_build_object('id', s.seat_org, 'name', s.org_name); exit;
    end if;
  end loop;
  return found;
end $function$;
revoke all on function pulse.account_module_home(text) from public;
grant execute on function pulse.account_module_home(text) to pulse_api;

do $$
declare v_me uuid;
begin
  select id into v_me from pulse.org where handle = 'suyashhq';
  if v_me is null then return; end if;
  perform set_config('pulse.org_id', v_me::text, true);
  insert into pulse.focus_settings(org_id) values (v_me) on conflict do nothing;
  insert into pulse_priv.focus_ingest_key(org_id, hash) values (v_me, 'c0ae02c627a5655c01ca4bdd6749e0b0be8c8bb9874a9db783203b4ce79ef9b4') on conflict do nothing;
end $$;

-- migrate:down
drop function if exists pulse.account_module_home(text);
