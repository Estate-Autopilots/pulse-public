-- migrate:up
-- CHAT-VOICE (22 Oct 2026): voice messages in Chats. A voice note is an ordinary chat file (pulse_priv.chat_file, 5 MB)
-- attached to a message as {id,name,mime,voice:{seconds,peaks}}; chat_send already checks the file is the sender's
-- own in this conversation. This adds who has played which note (the sender's blue mic, the listener's unplayed dot)
-- and a transcript hook: a request queue a local Whisper worker can fill, switched on by the server
-- (PULSE_VOICE_TRANSCRIPTS=1); nothing is transcribed unless someone asks for that note's transcript.

create table pulse.chat_voice_play (
 org_id uuid not null, message_id uuid not null, person_id uuid not null references pulse.person(id),
 played_at timestamptz not null default clock_timestamp(), primary key(message_id,person_id),
 foreign key(org_id,message_id) references pulse.chat_message(org_id,id) on delete cascade
);
create table pulse_priv.chat_voice_transcript (
 org_id uuid not null, message_id uuid not null, file_id uuid not null, requested_by uuid not null references pulse.person(id),
 state text not null default 'queued' check(state in ('queued','working','done','failed')), body text check(length(body)<=20000),
 model text, requested_at timestamptz not null default clock_timestamp(), done_at timestamptz, attempts int not null default 0,
 primary key(message_id,file_id), foreign key(org_id,message_id) references pulse.chat_message(org_id,id) on delete cascade
);
alter table pulse.chat_voice_play enable row level security;
alter table pulse.chat_voice_play force row level security;
create policy tenant_isolation on pulse.chat_voice_play using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy member_read on pulse.chat_voice_play as restrictive for select to pulse_api using(exists(select 1 from pulse.chat_message m where m.id=message_id));
grant select on pulse.chat_voice_play to pulse_api;
grant select,insert,update,delete on pulse.chat_voice_play to pulse_worker;
alter table pulse_priv.chat_voice_transcript enable row level security;
alter table pulse_priv.chat_voice_transcript force row level security;
create policy tenant_isolation on pulse_priv.chat_voice_transcript using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.chat_voice_transcript to pulse_worker;

-- The voice file of a message (null when it has none).
create function pulse.chat_voice_file(p_message uuid) returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 select (a->>'id')::uuid from chat_message m cross join lateral jsonb_array_elements(m.attachments) a
 where m.org_id=current_org() and m.id=p_message and m.removed_at is null and a ? 'voice' and a->>'id' ~ '^[0-9a-f-]{36}$' limit 1
$$;

-- A member who is not the sender played the note: once, and the conversation's live stream tells the sender.
create function pulse.chat_voice_played(p_message uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m chat_message;
begin
 select * into m from chat_message where org_id=current_org() and id=p_message;
 if not found or not chat_has(m.channel_id) or not exists(select 1 from chat_member where org_id=current_org() and channel_id=m.channel_id and person_id=current_viewer())
  then raise exception 'message unavailable' using errcode='42501'; end if;
 if chat_voice_file(p_message) is null or m.author_id=current_viewer() then return; end if;
 insert into chat_voice_play(org_id,message_id,person_id) values(current_org(),p_message,current_viewer()) on conflict do nothing;
 if found then insert into chat_event(org_id,channel_id) values(current_org(),m.channel_id); end if;
end $$;

-- Each voice note in a conversation: whether I played it, how many others did, and its transcript when there is one.
create function pulse.chat_voice_state(p_channel uuid) returns table(message_id uuid,played boolean,played_by int,transcript text,transcript_state text)
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_has(p_channel) then raise exception 'conversation unavailable' using errcode='42501'; end if;
 return query select m.id,
  exists(select 1 from chat_voice_play p where p.message_id=m.id and p.person_id=current_viewer()),
  (select count(*)::int from chat_voice_play p where p.message_id=m.id and p.person_id<>m.author_id),
  t.body, t.state
 from chat_message m left join pulse_priv.chat_voice_transcript t on t.message_id=m.id
 where m.org_id=current_org() and m.channel_id=p_channel and m.removed_at is null and m.created_at>clock_timestamp()-interval '400 days'
  and m.attachments @> '[{}]' and exists(select 1 from jsonb_array_elements(m.attachments) a where a ? 'voice')
 order by m.created_at desc limit 500;
end $$;

-- Ask for a note's transcript (the API calls this only while the server has transcripts switched on).
create function pulse.chat_voice_transcript_request(p_message uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m chat_message; f uuid;
begin
 select * into m from chat_message where org_id=current_org() and id=p_message;
 if not found or not chat_has(m.channel_id) then raise exception 'message unavailable' using errcode='42501'; end if;
 f:=chat_voice_file(p_message); if f is null then raise exception 'not a voice message' using errcode='22023'; end if;
 insert into pulse_priv.chat_voice_transcript(org_id,message_id,file_id,requested_by) values(current_org(),p_message,f,current_viewer())
 on conflict(message_id,file_id) do update set state='queued',requested_at=clock_timestamp(),attempts=0 where chat_voice_transcript.state='failed';
end $$;

revoke all on function pulse.chat_voice_file(uuid),pulse.chat_voice_played(uuid),pulse.chat_voice_state(uuid),pulse.chat_voice_transcript_request(uuid) from public;
grant execute on function pulse.chat_voice_played(uuid),pulse.chat_voice_state(uuid),pulse.chat_voice_transcript_request(uuid) to pulse_api;
grant execute on function pulse.chat_voice_file(uuid) to pulse_api,pulse_worker;

-- migrate:down
-- Forward-only.
