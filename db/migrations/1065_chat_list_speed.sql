-- migrate:up
-- VISIBLE (owner, 25 Oct 2026: "can't see all chats"): the chat list (GET /api/v0/chats) is fast again now that 440
-- imported WhatsApp groups are native chats (1051). It called security-definer functions once per conversation, or once
-- per member: wa_native_channel (and wa_reader in it), chat_current for every member of every chat, connect_chat_label,
-- chat_history_count and chat_client_facing, and counted members through chat_member's row policy row by row.
-- Production, an admin in 451 chats: the list's SQL took 11.3 s, telemetry p90 20 s, and the browser gave up at 15 s.
-- These two functions return the same values for the whole list at once; each column follows the function it
-- replaces, written over a set. Additive: two functions; nothing else changes.

-- chat_current(p) for every person of the company at once: who counts as a current member of a chat.
create function pulse.chat_current_people() returns setof uuid
language sql stable security definer set search_path = pulse, pg_temp as $$
 select p.id from person p where p.org_id = current_org() and p.status = 'active'
  and (p.active_to is null or p.active_to >= lifecycle_today())
  and not exists (select 1 from person_lifecycle l where l.org_id = p.org_id and l.person_id = p.id and l.stage = 'left')
  and not exists (select 1 from hr_employment e where e.org_id = p.org_id and e.person_id = p.id and e.last_working_day < lifecycle_today())
$$;

-- The facts of every conversation the viewer's chat list can hold: exactly chat_has (0025: staff or a seat, and a
-- member, or an admin on a group; keep the two in step), with the viewer's own membership row (read here once instead of
-- through chat_member's row policy per chat), members (chat_current), chat_client_facing, connect_chat_label,
-- chat_history_count and wa_native_channel. client_group: the groups hub's type (chat_group_info.kind) says client, or the import linked the
-- WhatsApp group to a client record (for its readers), so the Chats list's "Clients" view holds the client groups that
-- came from WhatsApp (they have no client-side member).
create function pulse.chat_list_facts() returns table (channel_id uuid, member boolean, my_role text, read_through timestamptz,
  pinned_at timestamptz, muted_until timestamptz, archived_at timestamptz, marked_unread_at timestamptz,
  members int, client_facing boolean, with_org text, imported int, whatsapp jsonb, client_group boolean)
language sql stable security definer set search_path = pulse, pg_temp as $$
 with me as (select chat_active() active, viewer_is('admin') admin, connect_is_seat(current_viewer()) seat, chat_import_reads() reads,
          exists (select 1 from person p join client_contact_optin o on o.org_id = p.org_id and o.person_id = p.id
                   where p.id = current_viewer() and p.side = 'client' and p.status = 'active' and o.state = 'opted_in' and 'chat_history' = any(o.scope)) client_optin),
 mine as (select m.* from chat_member m where m.org_id = current_org() and m.person_id = current_viewer()),
 ch as (select c.id, c.org_id, c.id in (select channel_id from mine) member from chat_channel c, me
         where c.org_id = current_org() and me.active and (c.id in (select channel_id from mine) or (me.admin and c.kind <> 'direct'))),
 cur as (select chat_current_people() id),
 memb as (select cm.channel_id, count(*)::int n from chat_member cm join person p on p.id = cm.person_id
           where cm.org_id = current_org() and cm.channel_id in (select id from ch) and p.id in (select id from cur) group by 1),
 cf as (select distinct cm.channel_id from chat_member cm join person p on p.id = cm.person_id
         where cm.org_id = current_org() and cm.channel_id in (select id from ch) and p.side not in ('staff', 'agent')),
 lbl as (select distinct on (s.ref) s.ref, s.connection_id from pulse_priv.connect_share s
          where s.host_org = current_org() and s.kind = 'chat' and s.ref in (select id from ch) order by s.ref),
 hist as (select m.channel_id, count(*)::int n from pulse_priv.chat_import_message m
           join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
          where m.org_id = current_org() and m.channel_id in (select id from ch) group by 1),
 -- wa_reader(chat) (1015) over the set: staff (chat_active) who are admins or members, or an opted-in client member;
 -- and chat_import_reads(), as wa_native_channel asks.
 wr as (select c.channel_id, c.id, c.messages, c.first_at, c.last_at, c.client_id, n.chat_id native_chat, n.messages native_messages, n.synced_at,
          ((me.active and (me.admin or ch.member)) or (me.client_optin and ch.member)) and me.reads ok
          from pulse_priv.wa_chat c join ch on ch.id = c.channel_id cross join me
          left join pulse_priv.wa_native n on n.org_id = c.org_id and n.chat_id = c.id
         where c.org_id = current_org()),
 gu as (select g.channel_id, count(*)::int n from chat_guest g where g.org_id = current_org() and g.channel_id in (select channel_id from wr where ok) group by 1)
 select ch.id, ch.member, my.role, my.read_through, my.pinned_at, my.muted_until, my.archived_at, my.marked_unread_at,
   coalesce(memb.n, 0),
   cf.channel_id is not null,
   case when lbl.ref is null then null when (select seat from me) then (select name from org where id = current_org()) else connect_other_name(lbl.connection_id) end,
   case when hist.n is null then 0 when chat_history_reader(ch.id) then hist.n else 0 end,
   case when wr.ok then jsonb_build_object('chatId', wr.id, 'messages', wr.messages, 'firstAt', wr.first_at, 'lastAt', wr.last_at,
     'native', wr.native_chat is not null, 'nativeMessages', wr.native_messages, 'syncedAt', wr.synced_at, 'guests', coalesce(gu.n, 0)) end,
   exists (select 1 from chat_group_info gi where gi.org_id = ch.org_id and gi.channel_id = ch.id and gi.kind = 'client') or coalesce(wr.ok and wr.client_id is not null, false)
 from ch left join mine my on my.channel_id = ch.id left join memb on memb.channel_id = ch.id left join cf on cf.channel_id = ch.id left join lbl on lbl.ref = ch.id
   left join hist on hist.channel_id = ch.id left join wr on wr.channel_id = ch.id left join gu on gu.channel_id = ch.id
$$;

revoke all on function pulse.chat_current_people(), pulse.chat_list_facts() from public;
grant execute on function pulse.chat_current_people(), pulse.chat_list_facts() to pulse_api;

-- migrate:down
-- Forward-only.
