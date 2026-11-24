-- migrate:up
-- SPEED-5 (owner, 18 Nov 2026: search's imported-history part, the largest part of Ctrl+K search after SPEED-4).
-- wa_history_search chose the imported chats a person may read by calling wa_reader and chat_browse once per chat of
-- the company: in Estate Autopilots 440 calls, ~160 ms of the 350-475 ms the history part takes (read-only, as the
-- function's owner, production, 18 Nov; 0.9-1.5 s on the loaded server as the API).
-- wa_readable_chats() is the same set worked out once for the list: wa_reader's rule (active staff who are admins or
-- members, or an opted-in client member) or chat_browse's (a client group the setting opens to this person, exactly
-- chat_browse_ids()). wa_history_search reads it; the rest of the search (ranking, previews) is unchanged.
create function pulse.wa_readable_chats() returns setof uuid
language sql stable security definer set search_path = pulse, pg_temp as $$
 with me as materialized (select chat_active() active, viewer_is('admin') admin,
        exists (select 1 from person p join client_contact_optin o on o.org_id = p.org_id and o.person_id = p.id
                 where p.id = current_viewer() and p.side = 'client' and p.status = 'active' and o.state = 'opted_in' and 'chat_history' = any(o.scope)) optin),
      browse as materialized (select chat_browse_ids() id)
 select x.id from pulse_priv.wa_chat x cross join me
  where x.org_id = current_org()
    and ((me.active and (me.admin or exists (select 1 from chat_member m where m.org_id = x.org_id and m.channel_id = x.channel_id and m.person_id = current_viewer())))
      or (me.optin and exists (select 1 from chat_member m where m.channel_id = x.channel_id and m.person_id = current_viewer()))
      or x.channel_id in (select id from browse))
$$;
revoke all on function pulse.wa_readable_chats() from public;

create or replace function pulse.wa_history_search(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare ids uuid[];
begin
 if not chat_import_reads() then return '[]'::jsonb; end if;
 select array_agg(k.id) into ids from pulse_priv.wa_chunk k join pulse_priv.wa_chat c on c.org_id = k.org_id and c.id = k.chat_id
  where k.org_id = current_org()
    and (p->>'client' is null or k.client_id = (p->>'client')::uuid)
    and (p->>'project' is null or k.project_id = (p->>'project')::uuid)
    and (p->>'channel' is null or c.channel_id = (p->>'channel')::uuid)
    and c.id in (select wa_readable_chats());
 if ids is null then return '[]'::jsonb; end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
     'chunkId', k.id, 'score', r.score, 'channelId', c.channel_id, 'chat', c.title, 'clientId', k.client_id, 'client', cl.display_name,
     'projectId', k.project_id, 'project', coalesce(pr.title, pr.name), 'stage', k.stage, 'firstAt', k.first_at, 'lastAt', k.last_at,
     'messages', cardinality(k.messages),
     'messageId', (select m.id from chat_message m where m.org_id = k.org_id and m.channel_id = c.channel_id and m.import_ref = k.messages[1]),
     'preview', (select coalesce(jsonb_agg(jsonb_build_object('author', case when m.guest_id is not null then g.label else a.display_name end, 'at', m.created_at, 'text', left(m.body, 280)) order by m.created_at), '[]'::jsonb)
                 from (select m.* from chat_message m where m.org_id = k.org_id and m.channel_id = c.channel_id and m.import_ref = any(k.messages[1:6])
                         and m.removed_at is null and coalesce(m.body, '') <> '' order by m.created_at limit 3) m
                 left join person a on a.id = m.author_id left join chat_guest g on g.id = m.guest_id)) order by r.score desc)
   from wa_chunk_rank(ids, p->>'q', p->>'vec', coalesce((p->>'limit')::int, 8)) r
   join pulse_priv.wa_chunk k on k.id = r.id join pulse_priv.wa_chat c on c.org_id = k.org_id and c.id = k.chat_id
   left join client cl on cl.id = k.client_id left join project pr on pr.id = k.project_id), '[]'::jsonb);
end $$;

-- migrate:down
-- Forward-only.
