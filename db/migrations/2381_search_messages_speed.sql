-- migrate:up
-- SPEED-4 (owner, 18 Nov 2026: "make the slowest real actions fast"): Ctrl+K search (GET /api/v0/search) took 1.7-28 s on
-- production for real people (p50 3.5 s over 3 days). Read-only timing of its parts for a person in 302 conversations:
-- tasks 70 ms, files 0.36 s, imported history 1.5 s, and the chat messages part 9.5-12.8 s. That part asked for the 8 newest
-- messages with the words; chat_message's row policies (member_read: chat_has or chat_browsing; imported_read:
-- chat_import_reads) are security-definer calls that run on every message of every conversation before the words are
-- compared (neither ILIKE nor a text match is leakproof), ~100,000 rows x three calls.
-- chat_message_find returns the same messages with the same rules applied once per conversation instead of once per
-- message: the viewer's own conversations (as the old query joined chat_member on the viewer) that chat_has lets them
-- read (chat_browsing only opens one conversation at a time on its own page, never a search), messages not removed, and
-- imported history only for those chat_import_reads allows. Additive: one function; nothing else changes.
create function pulse.chat_message_find(p_pats text[], p_limit int default 8)
returns table (id uuid, channel_id uuid, name text, body text, created_at timestamptz)
language sql stable security definer set search_path = pulse, pg_temp as $$
 with chans as materialized (
   select ch.id, ch.name from chat_channel ch
   join chat_member m on m.org_id = ch.org_id and m.channel_id = ch.id and m.person_id = current_viewer()
   where ch.org_id = current_org() and current_viewer() is not null and chat_has(ch.id)
 ), reads as materialized (select chat_import_reads() ok)
 select msg.id, msg.channel_id, c.name, msg.body, msg.created_at
 from chans c join chat_message msg on msg.org_id = current_org() and msg.channel_id = c.id
 where msg.removed_at is null and (msg.import_ref is null or (select ok from reads))
   and coalesce(array_length(p_pats, 1), 0) > 0 and msg.body ilike any(p_pats)
 order by msg.created_at desc
 limit least(greatest(coalesce(p_limit, 8), 1), 50)
$$;
revoke all on function pulse.chat_message_find(text[], int) from public;
grant execute on function pulse.chat_message_find(text[], int) to pulse_api;

-- migrate:down
-- Forward-only.
