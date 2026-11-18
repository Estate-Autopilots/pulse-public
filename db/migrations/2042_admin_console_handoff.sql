-- migrate:up
-- SETTINGS-APPLE (owner, 13 Nov 2026, T1.3.4: "if I have to log in again, that's a very hectic job. When you click on the
-- admin console of any company, if you are an admin or leadership, you should be directly on the admin console. There
-- should be no problem message."). The admin console (apps/admin, its own address) kept its own session, so a platform
-- admin already signed in to Pulse signed in a second time there; and from any company other than the install's own,
-- the menu had no Admin console at all (pulse.platform_admin() answers inside the install's own company only).
--
-- 1. pulse.account_platform_seat(): the signed-in account's seat in the install's own company when that seat is a platform
--    admin there (pulse.platform_admin() read as that seat, then put back), from whichever company the person is in now.
-- 2. A one-time hand-off: Pulse (signed in, any company) makes a 256-bit token for that seat (only its sha256 is kept),
--    valid for two minutes and once; the admin site redeems it for its own session of that seat in the install's own
--    company (via 'account', 12 hours, not remembered). No password travels and no second sign-in or two-step happens:
--    the person proved both to Pulse already. Every step is in the auth history (auth_event) and the audit.
create table pulse_priv.admin_handoff(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),        -- the install's own company: where the console's session lives
  person_id uuid not null references pulse.person(id), -- the platform admin's seat there
  from_org uuid,                                        -- the company the click came from (for the audit only)
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 minutes',
  used_at timestamptz,
  used_device text);
alter table pulse_priv.admin_handoff enable row level security;
alter table pulse_priv.admin_handoff force row level security;
create policy tenant on pulse_priv.admin_handoff using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on table pulse_priv.admin_handoff from public;

create function pulse.account_platform_seat() returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare home uuid := install_org(); s record; ok boolean;
begin
  if current_viewer() is null or home is null then return null; end if;
  if current_org() = home then return case when platform_admin() then current_viewer() end; end if;
  for s in select seat_person from account_seats() where seat_org = home and seat_kind = 'staff' limit 1 loop
    perform acct_enter(home, s.seat_person);
    ok := platform_admin();
    perform acct_leave();
    if ok then return s.seat_person; end if;
  end loop;
  return null;
end $$;

-- The signed-in person asks for a hand-off (any company). Null when they are not a platform admin.
create function pulse.admin_handoff_create(p_token text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare seat uuid := account_platform_seat(); home uuid := install_org(); here uuid := current_org();
begin
  if seat is null then return null; end if;
  if coalesce(p_token, '') !~ '^[a-f0-9]{64}$' then raise exception 'Bad hand-off' using errcode = '22023'; end if;
  perform acct_enter(home, seat);
  insert into pulse_priv.admin_handoff(org_id, person_id, from_org, token_hash) values (home, seat, here, p_token);
  perform auth_event_add('staff', seat, 'admin_console_handoff');
  perform acct_leave();
  return jsonb_build_object('ok', true);
end $$;

-- The admin site redeems it (a public route of the install's own company; the API limits tries per address). Null when
-- the token is unknown, used, expired, or its seat is no longer a platform admin.
create function pulse.admin_handoff_redeem(p_token text, p_session text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare row pulse_priv.admin_handoff%rowtype; ok boolean; vw text := coalesce(current_setting('pulse.viewer_id', true), '');
begin
  if coalesce(p_token, '') !~ '^[a-f0-9]{64}$' or coalesce(p_session, '') !~ '^[a-f0-9]{64}$' then return null; end if;
  if current_org() is distinct from install_org() then return null; end if;
  select * into row from pulse_priv.admin_handoff where token_hash = p_token and used_at is null and expires_at > now() for update;
  if not found then perform auth_event_add('staff', null, 'admin_console_handoff_failed', p_device); return null; end if;
  update pulse_priv.admin_handoff set used_at = now(), used_device = left(p_device, 120) where id = row.id;
  perform set_config('pulse.viewer_id', row.person_id::text, true);
  ok := platform_admin() and exists (select 1 from person where id = row.person_id and status = 'active');
  perform set_config('pulse.viewer_id', vw, true);
  if not ok then perform auth_event_add('staff', row.person_id, 'admin_console_handoff_failed', p_device); return null; end if;
  insert into login_session(org_id, person_id, token_hash, expires_at, device, remembered, via)
    values (row.org_id, row.person_id, p_session, now() + interval '12 hours', left(coalesce(nullif(p_device, ''), 'Admin console'), 120), false, 'account');
  perform auth_event_add('staff', row.person_id, 'admin_console_signed_in', p_device);
  return jsonb_build_object('ok', true);
end $$;

revoke all on function pulse.account_platform_seat(), pulse.admin_handoff_create(text), pulse.admin_handoff_redeem(text, text, text) from public;
grant execute on function pulse.account_platform_seat(), pulse.admin_handoff_create(text), pulse.admin_handoff_redeem(text, text, text) to pulse_api;

-- migrate:down
drop function if exists pulse.admin_handoff_redeem(text, text, text);
drop function if exists pulse.admin_handoff_create(text);
drop function if exists pulse.account_platform_seat();
drop table if exists pulse_priv.admin_handoff;
