-- migrate:up
-- SPEED-5 (owner, 18 Nov 2026: GET /chats, the most server time in Pulse: 3,794 reads in 3 days, avg 396 ms, p90 up to
-- 2 s). Read-only timing on production for the person who opens Chats most (an admin; 39 conversations shown): the list
-- query took 135-190 ms, 106 ms of it in chat_channel's row policy, which ran chat_has (or chat_browsing) once per
-- conversation the company has that an admin may moderate (479), although chat_list_facts (1065) had just chosen exactly
-- those conversations with the same rule; 440 of them (WhatsApp groups the admin is not in) were then dropped.
-- chat_list_channels returns the list's own columns of the conversations chat_list_facts chose, with chat_has's rule
-- applied once for the list: the viewer is active staff (chat_active) and a member, or an admin and the conversation is
-- not a direct chat. That is the whole of chat_channel's read policy for the list (member_read: chat_has, or
-- chat_browsing, which only opens the one conversation a person browses on its own page; tenant_isolation: this
-- company). Additive: one function; nothing else changes.
create function pulse.chat_list_channels()
returns table (id uuid, org_id uuid, key text, name text, kind text, description text, address text, photo_at timestamptz)
language sql stable security definer set search_path = pulse, pg_temp as $$
 with me as materialized (select chat_active() active, viewer_is('admin') admin)
 select c.id, c.org_id, c.key, c.name, c.kind, c.description, c.address, c.photo_at
 from chat_channel c cross join me
 where c.org_id = current_org() and me.active
   and (exists (select 1 from chat_member m where m.org_id = current_org() and m.channel_id = c.id and m.person_id = current_viewer())
        or (me.admin and c.kind <> 'direct'))
$$;
revoke all on function pulse.chat_list_channels() from public;
grant execute on function pulse.chat_list_channels() to pulse_api;

-- migrate:down
-- Forward-only.
