-- migrate:up
-- PM-BUILD-4 (EA #36, Project Coordinator, 23 Nov 2026 09:20 IST): "Passing the saved nextCursor back returned 400
-- 'Invalid cursor or limit' twice". The v1 pager (services/api/src/v1-paging.ts) sealed its cursors with a key the API
-- process made at start, so every restart (each release: five between the Coordinator's 22 Nov and 23 Nov runs) made
-- every saved cursor invalid, and the Coordinator spent 2 of its 3 tool rounds a run on refusals. The key now lives here:
-- made once by this migration, read by the API at its first page. Cursors keep their binding (company, key, viewer,
-- operation, path, filters) and their row security; only a restart no longer breaks them.
create table pulse_priv.v1_cursor_key (
  one boolean primary key default true check (one),
  key bytea not null check (octet_length(key) = 32),
  created_at timestamptz not null default now()
);
revoke all on pulse_priv.v1_cursor_key from public;
-- One install-wide key, no organisation: row security on with no policy (no runtime role reads a row), not forced so the
-- owner's SECURITY DEFINER reader below sees it; allow-listed in tests/core/test_acceptance_isolation.py with this reason.
alter table pulse_priv.v1_cursor_key enable row level security;
insert into pulse_priv.v1_cursor_key (key) values (gen_random_bytes(32)) on conflict do nothing;

-- Read only: the key is made above, so a read-only request transaction can call this.
create function pulse.v1_cursor_key() returns bytea
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select key from pulse_priv.v1_cursor_key where one
$$;
revoke all on function pulse.v1_cursor_key() from public;
grant execute on function pulse.v1_cursor_key() to pulse_api;

-- migrate:down
drop function if exists pulse.v1_cursor_key();
drop table if exists pulse_priv.v1_cursor_key;
