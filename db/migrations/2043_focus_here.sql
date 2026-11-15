-- migrate:up
-- SETTINGS-APPLE (owner, 13 Nov 2026, T1.4.2: "Focus just redirected me to my Savuzo HQ. What the hell? ... If Focus is
-- just for Savuzo HQ, why is it here? And if it is available here as well, why not open it for Estate Autopilots
-- itself?"). Focus is the owner's AI capacity across his companies; its data lives in one organisation (his own
-- workspace). From another company the menu used to switch company to it (/@suyashhq/focus), and the way back showed
-- "This page is in Savuzo HQ".
--
-- pulse.focus_enter_home(): from any company the signed-in account works in, move this transaction to the account's
-- Focus organisation (pulse.account_module_home('focus'), 1953: a staff seat where the person is an admin and focus is
-- switched on), as that seat. The API's /api/v0/account/focus routes then read and change that Focus under its own row
-- security (admins only, 1845), exactly as /api/v0/focus does there, and the page shows the company the person is in.
-- Null when the account has no Focus; nothing moves then. The settings are transaction-local (set_config(..., true)).
create function pulse.focus_enter_home() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare home jsonb := account_module_home('focus'); seat uuid;
begin
  if home is null then return null; end if;
  select seat_person into seat from account_seats() where seat_org = (home->>'id')::uuid and seat_kind = 'staff' limit 1;
  if seat is null then return null; end if;
  perform set_config('pulse.org_id', home->>'id', true);
  perform set_config('pulse.viewer_id', seat::text, true);
  return home || jsonb_build_object('seat', seat);
end $$;
revoke all on function pulse.focus_enter_home() from public;
grant execute on function pulse.focus_enter_home() to pulse_api;

-- migrate:down
drop function if exists pulse.focus_enter_home();
