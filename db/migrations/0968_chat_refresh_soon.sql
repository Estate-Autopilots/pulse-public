-- migrate:up
-- E2E-4P (owner check, 23 Oct 2026): Chats hung on a spinner on a loaded server. Every chat read (the list, a thread's
-- messages, the companion inbox, notices) ran chat_refresh(), which recomputes every pod/team/Google-group membership
-- under one advisory lock per organisation, so all of an organisation's readers queued behind each other (~90 ms each
-- under CPU steal, seconds with a few open tabs polling). Reads now call chat_refresh_soon(): it skips the refresh when
-- one finished in the last 2 seconds, or when another request is refreshing right now (it never waits on the lock).
-- (0148's 30-second chat_refresh_soon() was taken off the reads by CHATS-2 because membership went stale; it is
-- redefined here with a 2-second window.) Writes keep chat_refresh() as before. No function body is copied: chat_refresh() (0165) is called as it is.

create or replace function pulse.chat_refresh_soon() returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if not chat_active() then raise exception 'individual staff account required' using errcode = '42501'; end if;
 if exists (select 1 from chat_refresh_state where org_id = current_org() and refreshed_at > clock_timestamp() - interval '2 seconds') then return; end if;
 if not pg_try_advisory_xact_lock(hashtext('chat-members:' || current_org()::text)) then return; end if;
 perform chat_refresh();
 insert into chat_refresh_state (org_id, refreshed_at) values (current_org(), clock_timestamp())
  on conflict (org_id) do update set refreshed_at = excluded.refreshed_at;
end $$;

-- migrate:down
-- Forward-only (0148's version can be restored by re-running its definition).
