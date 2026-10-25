-- migrate:up
-- CI (23 Oct 2026): since 0968 a chat read skips the membership refresh when one finished in the last 2 seconds, so a
-- person whose role, pod, team, group or status had just changed kept the old memberships for that window: someone
-- removed from leadership could still open the leadership group (test_companion_messaging, "removed membership refuses
-- notification click-through"). A change to anything chat_refresh() (0165) reads now clears the organisation's
-- last-refresh mark, so the next read refreshes at once; reads with nothing changed still skip it (0968's speed-up).
-- No function body is copied.

create function pulse.chat_refresh_stale() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 delete from chat_refresh_state where org_id = coalesce((to_jsonb(new) ->> 'org_id')::uuid, (to_jsonb(old) ->> 'org_id')::uuid);
 return null;
end $$;
revoke all on function pulse.chat_refresh_stale() from public;

do $$
declare t text;
begin
 foreach t in array array['account', 'people_profile', 'person_lifecycle', 'role_assignment', 'unit', 'workspace_group', 'person'] loop
  execute format('create trigger %I after insert or update or delete on pulse.%I for each row execute function pulse.chat_refresh_stale()',
   t || '_chat_refresh_stale', t);
 end loop;
end $$;

-- migrate:down
-- Forward-only.
