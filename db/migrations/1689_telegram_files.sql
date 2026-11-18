-- migrate:up
-- TG-VOICE (7 Nov 2026): Telegram is a full chat with an AI employee, files included. A photo, PDF or other file the
-- person sends the bot goes into their direct chat with the AI employee as their attachment (5 MB, the chat's limit);
-- the AI employee's files (an image, a PDF it attached) and its links come back to Telegram. Functions only: the files
-- stay in pulse_priv.chat_file (forced RLS + tenant policy since 0022), and the worker reads only a file the chat's AI
-- employee attached in that chat.

create function pulse.telegram_agent_inbound_file(p_chat text, p_name text, p_mime text, p_bytes bytea, p_caption text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l pulse_priv.telegram_agent_link; fid uuid; fname text; agent_name text;
begin
  select * into l from pulse_priv.telegram_agent_link where org_id = current_org() and chat_id = p_chat;
  if not found or p_bytes is null then return null; end if;
  if not exists (select 1 from person where id = l.person_id and status = 'active') then return null; end if;
  perform set_config('pulse.viewer_id', l.person_id::text, true);
  fname := left(coalesce(nullif(btrim(regexp_replace(coalesce(p_name, ''), '[\r\n/\\]+', ' ', 'g')), ''), 'file'), 200);
  fid := chat_file_add(l.channel_id, fname, left(coalesce(nullif(btrim(p_mime), ''), 'application/octet-stream'), 120), p_bytes);
  perform chat_send(l.channel_id, left(coalesce(p_caption, ''), 4000), null,
    jsonb_build_array(jsonb_build_object('id', fid::text, 'name', fname)), gen_random_uuid());
  select display_name into agent_name from person where id = l.agent_id;
  return jsonb_build_object('agent', agent_name, 'file', fid);
end $$;

-- The AI employees' new replies for their Telegram chats, now with their files and links (and replies that are only a
-- file); the cursor moves past them as before.
create or replace function pulse.telegram_agent_outbound() returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out jsonb := '[]'::jsonb; l pulse_priv.telegram_agent_link; rows jsonb; last timestamptz;
begin
  for l in select * from pulse_priv.telegram_agent_link where org_id = current_org() loop
    select jsonb_agg(jsonb_build_object('chatId', l.chat_id, 'agent', p.display_name, 'body', left(coalesce(m.body, ''), 3500),
             'files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'mime', f.mime, 'size', octet_length(f.bytes)))
                                  from jsonb_array_elements(m.attachments) a join pulse_priv.chat_file f on f.id::text = a->>'id' and f.channel_id = m.channel_id), '[]'::jsonb),
             'links', coalesce((select jsonb_agg(jsonb_build_object('url', a->>'url', 'name', a->>'name'))
                                  from jsonb_array_elements(m.attachments) a where a ? 'url'), '[]'::jsonb))
             order by m.created_at), max(m.created_at)
      into rows, last
      from (select * from chat_message where org_id = current_org() and channel_id = l.channel_id and author_id = l.agent_id
              and created_at > l.relayed_until and removed_at is null
              and (coalesce(btrim(body), '') <> '' or jsonb_array_length(attachments) > 0) order by created_at limit 10) m
      join person p on p.id = l.agent_id;
    if rows is not null then
      out := out || rows;
      update pulse_priv.telegram_agent_link set relayed_until = last where org_id = l.org_id and person_id = l.person_id and agent_id = l.agent_id;
    end if;
  end loop;
  return out;
end $$;

-- One file of the chat's AI employee's messages, for the bot to send to Telegram; nothing else is readable this way.
create function pulse.telegram_agent_file(p_chat text, p_file uuid) returns table(name text, mime text, bytes bytea)
language sql security definer stable set search_path = pulse, pg_temp as $$
  select f.name, f.mime, f.bytes
    from pulse_priv.telegram_agent_link l
    join pulse_priv.chat_file f on f.id = p_file and f.org_id = l.org_id and f.channel_id = l.channel_id
   where l.org_id = current_org() and l.chat_id = p_chat
     and exists (select 1 from chat_message m where m.org_id = l.org_id and m.channel_id = l.channel_id and m.author_id = l.agent_id
                   and m.removed_at is null and m.attachments @> jsonb_build_array(jsonb_build_object('id', p_file::text)))
   limit 1
$$;

revoke all on function pulse.telegram_agent_inbound_file(text, text, text, bytea, text), pulse.telegram_agent_file(text, uuid) from public;
grant execute on function pulse.telegram_agent_inbound_file(text, text, text, bytea, text), pulse.telegram_agent_file(text, uuid) to pulse_worker;

-- migrate:down
drop function if exists pulse.telegram_agent_file(text, uuid), pulse.telegram_agent_inbound_file(text, text, text, bytea, text);
create or replace function pulse.telegram_agent_outbound() returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out jsonb := '[]'::jsonb; l pulse_priv.telegram_agent_link; rows jsonb; last timestamptz;
begin
  for l in select * from pulse_priv.telegram_agent_link where org_id = current_org() loop
    select jsonb_agg(jsonb_build_object('chatId', l.chat_id, 'agent', p.display_name, 'body', left(m.body, 3500)) order by m.created_at), max(m.created_at)
      into rows, last
      from (select * from chat_message where org_id = current_org() and channel_id = l.channel_id and author_id = l.agent_id
              and created_at > l.relayed_until and removed_at is null and coalesce(btrim(body), '') <> '' order by created_at limit 10) m
      join person p on p.id = l.agent_id;
    if rows is not null then
      out := out || rows;
      update pulse_priv.telegram_agent_link set relayed_until = last where org_id = l.org_id and person_id = l.person_id and agent_id = l.agent_id;
    end if;
  end loop;
  return out;
end $$;
