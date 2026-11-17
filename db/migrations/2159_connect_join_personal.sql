-- migrate:up
-- BUG-SWEEP-2 (15 Nov 2026; hosted CI test_connect_clients, reported by LAND-CAPTAIN-12). ACCOUNT-META (2125) promised
-- "Joining or signing up gives a personal first session" and wrapped account_join, account_signup and
-- account_signup_confirm so. A client who joins through a company's connect link (0953 connect_join) also makes their
-- account there, with a password of their own, but that first session stayed company-only: their next switch into
-- their own new company was refused ("To open your other companies, sign in as yourself …"). The same wrapper as 2125's:
-- the session this join makes is the person's own.
alter function pulse.connect_join(text, jsonb, text, text) rename to acct_connect_join_core;
revoke all on function pulse.acct_connect_join_core(text, jsonb, text, text) from public, pulse_api;
create function pulse.connect_join(p_link text, p jsonb, p_hash text, p_device text) returns jsonb
  language plpgsql security definer set search_path = pulse, public, pg_temp as $$
declare r jsonb := acct_connect_join_core(p_link, p, p_hash, p_device);
begin
  if r ? 'org' then perform acct_mark_personal((r ->> 'org')::uuid, p_hash); end if;
  return r;
end $$;
revoke all on function pulse.connect_join(text, jsonb, text, text) from public;
grant execute on function pulse.connect_join(text, jsonb, text, text) to pulse_api;

-- migrate:down
drop function if exists pulse.connect_join(text, jsonb, text, text);
alter function pulse.acct_connect_join_core(text, jsonb, text, text) rename to connect_join;
grant execute on function pulse.connect_join(text, jsonb, text, text) to pulse_api;
