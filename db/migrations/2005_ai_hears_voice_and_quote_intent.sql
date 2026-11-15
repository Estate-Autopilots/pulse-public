-- migrate:up
-- WL-QUOTE-LIVE (10 Nov 2026, owner: "a salesperson talks or types, or a meeting is listened to; Bharata makes the
-- quotation"). Two gaps on production:
-- 1. A voice note sent to an AI employee never reached it: agent_event_from_chat skips a message with no text, and the
--    finished transcript (tools/voice-transcribe.py, the server's own Whisper) woke nobody. Now a voice note in a
--    conversation with an AI employee is queued for its transcript at once, the AI employee is woken when the
--    transcript is done (or failed, so it can ask them to type), and what it reads is the transcript (its run context
--    and its recent history). Routing is the same as for a typed message (one function for both).
-- 2. Listening (company-wide by default) only drafted a quotation when the session was started as "quotation". Now a
--    typed rule (no model), for an AI employee with Billing, hears "quote / quotation / estimate / कोटेशन / दरपत्रक / अंदाजपत्रक …" in any session's window
--    and asks the AI employee to draft it and submit it for approval to the person who started listening.

-- The text an AI employee reads for a chat message: its words, and a voice note's transcript (or that it could not be
-- heard). Null when there is nothing to read.
create function pulse.agent_message_text(p_message uuid, p_body text) returns text
language sql stable security definer set search_path = pulse, pg_temp as $$
  select nullif(concat_ws(E'\n\n', nullif(btrim(coalesce(p_body, '')), ''),
    case when t.state = 'done' and btrim(coalesce(t.body, '')) <> '' then '🎙 Voice note, transcribed on our server: ' || btrim(t.body)
         when t.state in ('done', 'failed') then '🎙 Voice note (it could not be transcribed: ask them to type it or send it again)' end), '')
  from (select 1) one
  left join pulse_priv.chat_voice_transcript t on t.message_id = p_message and t.org_id = current_org()
$$;
revoke all on function pulse.agent_message_text(uuid, text) from public;

-- Who is woken by a message (a typed one, or a voice note once it is transcribed): the AI employees in that
-- conversation that answer it. Moved out of agent_event_from_chat unchanged (its loop as on dev/live b117b3f5f).
create function pulse.agent_event_route(new pulse.chat_message) returns int
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a record; leader boolean; n int := 0;
begin
  leader := agent_leader(new.author_id);
  for a in
    select m.person_id agent, x.kind
      from agent_member m join person p on p.id = m.person_id
      join chat_channel ch on ch.id = new.channel_id
      join chat_member cm on cm.channel_id = new.channel_id and cm.person_id = m.person_id
      cross join lateral (select case when ch.kind = 'direct' then 'chat.message' when m.person_id = any(new.mentions) then 'chat.mention'
          when exists(select 1 from chat_message pm where pm.id = coalesce(new.parent_id, new.quote_id) and pm.author_id = m.person_id) then 'chat.reply'
          else 'chat.group' end kind) x
      left join chat_group_agent ga on ga.channel_id = new.channel_id and ga.agent_id = m.person_id
     where m.org_id = new.org_id and not m.post_only and m.disabled_at is null and p.status = 'active'
       and (ch.kind = 'direct' or m.speak_scope = 'its_groups' or (m.speak_scope = 'listed' and ch.id = any(m.speak_channels)))
       and (agent_mode_for(m, x.kind) <> 'off' or (x.kind = 'chat.group' and ga.role = 'coordinator'))
       and coalesce(ga.role, '') <> 'observer'
       and not (x.kind = 'chat.group' and coalesce(ga.role, '') = 'assistant')
       and (leader or m.listens_to = 'everyone' or exists(select 1 from person au where au.id = new.author_id and au.side = 'staff' and au.status = 'active'))
       and not (x.kind = 'chat.group' and new.author_id = agent_approver_for(m.person_id, new.channel_id))
  loop
    insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
    values (new.org_id, a.agent, a.kind, 'message', new.id, 'message:' || new.id, new.author_id) on conflict do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function pulse.agent_event_route(pulse.chat_message) from public;

create or replace function pulse.agent_event_from_chat() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.kind <> 'text' or new.removed_at is not null or new.author_id is distinct from current_viewer() then return null; end if;
  if exists(select 1 from person where id = new.author_id and side = 'agent') then return null; end if;
  -- WL-QUOTE-LIVE: a voice note in a conversation with an AI employee waits for its transcript (queued here, made by the
  -- server's own Whisper); agent_event_from_voice wakes the AI employee when it is done. Its words, if any, go with it.
  if chat_voice_file(new.id) is not null and exists(select 1 from chat_member cm join person p on p.id = cm.person_id
       where cm.channel_id = new.channel_id and p.side = 'agent' and p.status = 'active') then
    begin
      insert into pulse_priv.chat_voice_transcript(org_id, message_id, file_id, requested_by)
      values (new.org_id, new.id, chat_voice_file(new.id), new.author_id) on conflict (message_id, file_id) do nothing;
    exception when others then raise warning 'agent_event_from_chat voice: %', sqlerrm; -- the message is never refused for this
    end;
    return null;
  end if;
  if btrim(coalesce(new.body, '')) = '' then return null; end if;
  if agent_proposal_from_reply(new.id) then return null; end if;
  perform agent_event_route(new);
  return null;
end $$;

-- A voice note's transcript is done (or could not be made): its AI employees are woken, as for a typed message. Only a
-- note from the last day (a Transcript tap on an old note wakes nobody), never one an AI employee sent.
create function pulse.agent_event_from_voice() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m chat_message;
begin
  if new.state not in ('done', 'failed') or old.state in ('done', 'failed') then return null; end if;
  select * into m from chat_message where id = new.message_id and org_id = new.org_id;
  if not found or m.removed_at is not null or m.kind <> 'text' or m.created_at < clock_timestamp() - interval '1 day' then return null; end if;
  if exists(select 1 from person where id = m.author_id and side = 'agent') then return null; end if;
  begin
    perform agent_event_route(m);
  exception when others then raise warning 'agent_event_from_voice: %', sqlerrm; -- a transcript is never lost for this
  end;
  return null;
end $$;
create trigger agent_event_from_voice after update of state on pulse_priv.chat_voice_transcript
  for each row execute function pulse.agent_event_from_voice();

-- What the AI employee reads: the message it answers and its recent history carry the transcript.
do $$
declare d text; c text;
begin
  d := pg_get_functiondef('pulse.agent_dispatch(uuid,uuid,text,text)'::regprocedure);
  c := replace(d, $x$'parentId', x.parent_id, 'body', left(x.body, 2000),$x$,
                  $x$'parentId', x.parent_id, 'body', left(agent_message_text(x.id, x.body), 2000), 'voice', chat_voice_file(x.id) is not null,$x$);
  c := replace(c, $x$'body', left(x.body, 600)) j$x$, $x$'body', left(agent_message_text(x.id, x.body), 600)) j$x$);
  c := replace(c, $x$and btrim(coalesce(x.body, '')) <> ''$x$, $x$and agent_message_text(x.id, x.body) is not null$x$);
  if c = d or c !~ 'agent_message_text\(x\.id, x\.body\), 2000' or c !~ 'agent_message_text\(x\.id, x\.body\), 600' or c !~ 'agent_message_text\(x\.id, x\.body\) is not null'
    then raise exception 'agent_dispatch changed shape (WL-QUOTE-LIVE)'; end if;
  execute c;
end $$;

-- Listening: "quote for X" heard in any session. A typed rule, Hindi, Marathi and English (the words Whisper writes).
create function pulse.listen_quote_intent(p_text text) returns boolean
language sql immutable set search_path = pulse, pg_temp as $$
  select coalesce(p_text, '') ~* '(\m(quote|quotes|quotation|quotations|estimate|proforma|kotation|quotesion)\M|कोटेशन|कोटेसन|क्वोटेशन|क्वोट|दरपत्रक|अंदाजपत्रक|एस्टिमेट|एस्टीमेट|इस्टिमेट|प्रोफार्मा)'
$$;

do $$
declare d text; c text;
begin
  d := pg_get_functiondef('pulse.listen_forward()'::regprocedure);
  c := replace(d, $x$ask := case s.purpose$x$,
    $x$ask := case when s.purpose <> 'quotation' and listen_quote_intent(body)
          and exists(select 1 from agent_member am where am.person_id = s.agent_id and 'billing' = any(am.tools)) then 'quotation' else s.purpose end;
      ask := case ask$x$);
  c := replace(c, $x$and create a task for anything promised.'$x$,
    $x$and create a task for anything promised. When the draft is ready, submit it for approval to me (the person listening) and tell me its link.'$x$);
  if c = d or c !~ 'listen_quote_intent\(body\)' or c !~ 'submit it for approval to me'
    then raise exception 'listen_forward changed shape (WL-QUOTE-LIVE)'; end if;
  execute c;
end $$;

-- migrate:down
-- Forward-only.
