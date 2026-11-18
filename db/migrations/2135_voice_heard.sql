-- migrate:up
-- CHAT-VOICE-FIX (owner, 14 Nov 2026): "transcripts must be right or hidden". Kazuk speaks Marathi, Hindi and English
-- in one note; Whisper large-v3-turbo wrote confident nonsense for it. The worker (tools/voice-transcribe.py) now runs
-- AI4Bharat's Indian-language engines beside Whisper and records how sure it is: `clear` (the engines agree enough for
-- a reader to trust the words), `confidence` (0-1), the language it heard, the engine, and a one-line English gist.
-- A transcript that is not clear is not shown ("Transcript not clear — listen", and the gist when there is one) and
-- an AI employee is told the note was not clear instead of reading the guess as words. Old transcripts (engine null)
-- are made again by the worker in place (their state stays done, so nobody is woken again).
alter table pulse_priv.chat_voice_transcript
 add column clear boolean,
 add column confidence numeric(4,3) check(confidence between 0 and 1),
 add column gist text check(length(gist)<=300),
 add column language text check(length(language)<=16),
 add column engine text check(length(engine)<=120);

-- How sure the server is of each transcript in a conversation (beside chat_voice_state, which keeps its shape).
create function pulse.chat_voice_heard(p_channel uuid) returns table(message_id uuid,clear boolean,confidence numeric,gist text,language text)
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_reads(p_channel) then raise exception 'conversation unavailable' using errcode='42501'; end if;
 return query select t.message_id,t.clear,t.confidence,t.gist,t.language
  from pulse_priv.chat_voice_transcript t join chat_message m on m.id=t.message_id and m.org_id=t.org_id
  where t.org_id=current_org() and m.channel_id=p_channel and m.removed_at is null and t.state='done' and m.created_at>clock_timestamp()-interval '400 days'
  order by m.created_at desc limit 500;
end $$;

-- Search: voice notes whose words (a clear transcript) or English gist hold the searched words, in one conversation
-- the viewer reads, or in all their conversations (p_channel null). A snippet around the first match.
create function pulse.chat_voice_search(p_q text,p_channel uuid,p_limit int default 60) returns table(message_id uuid,snippet text)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 with q as (select btrim(p_q) w,'%'||replace(replace(replace(btrim(p_q),'\','\\'),'%','\%'),'_','\_')||'%' pat where length(btrim(coalesce(p_q,'')))>=2),
 hit as (select t.message_id,m.created_at,case when coalesce(t.clear,true) and t.body ilike q.pat then t.body else t.gist end said,q.w
  from q,pulse_priv.chat_voice_transcript t join chat_message m on m.id=t.message_id and m.org_id=t.org_id
  where t.org_id=current_org() and t.state='done' and m.removed_at is null
   and ((coalesce(t.clear,true) and t.body ilike q.pat) or t.gist ilike q.pat)
   and case when p_channel is null then m.channel_id in (select cm.channel_id from chat_member cm where cm.org_id=current_org() and cm.person_id=current_viewer())
            else m.channel_id=p_channel and chat_reads(p_channel) end)
 select h.message_id,left(substr(h.said,greatest(1,position(lower(h.w) in lower(h.said))-40)),160) from hit h
 order by h.created_at desc limit greatest(1,least(coalesce(p_limit,60),200))
$$;

-- What an AI employee reads for a voice note: the words when they are clear; when not, that the note was not clear
-- (with the gist, marked as rough), so it asks instead of acting on a guess.
create or replace function pulse.agent_message_text(p_message uuid, p_body text) returns text
language sql stable security definer set search_path = pulse, pg_temp as $$
  select nullif(concat_ws(E'\n\n', nullif(btrim(coalesce(p_body, '')), ''),
    case when t.state = 'done' and t.clear is false then '🎙 Voice note (not clear enough to transcribe: ask them to type the key points)'
           || coalesce('. Rough English gist: ' || nullif(btrim(t.gist), ''), '')
         when t.state = 'done' and btrim(coalesce(t.body, '')) <> '' then '🎙 Voice note, transcribed on our server: ' || btrim(t.body)
         when t.state in ('done', 'failed') then '🎙 Voice note (it could not be transcribed: ask them to type it or send it again)' end), '')
  from (select 1) one
  left join pulse_priv.chat_voice_transcript t on t.message_id = p_message and t.org_id = current_org()
$$;

revoke all on function pulse.chat_voice_heard(uuid),pulse.chat_voice_search(text,uuid,int) from public;
grant execute on function pulse.chat_voice_heard(uuid),pulse.chat_voice_search(text,uuid,int) to pulse_api;
-- migrate:down
-- Forward-only.
