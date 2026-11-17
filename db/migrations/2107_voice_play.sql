-- migrate:up
-- CHAT-VOICE-FIX (owner, 14 Nov 2026: "voice notes must always play"). A voice note recorded in Chrome or Edge is a
-- MediaRecorder WebM: it carries no length and no cues, so players read its duration as Infinity and seek badly, and
-- Safari on iPhone and Mac does not play WebM/Opus at all. The server's own ffmpeg (tools/voice-transcribe.py, the
-- worker that already transcribes the notes on this server) makes two playable copies of every audio chat file soon
-- after it is uploaded, and keeps the original untouched:
--   webm: the same Opus audio remuxed (no re-encoding) into a WebM with its length and cues;
--   aac:  an AAC copy (.m4a, moov first) every browser plays, Safari and iPhone included.
-- A copy ffmpeg could not make is kept as a row without bytes and its error, so it is never retried in a loop.
-- The API streams a note with range requests (GET /api/v0/chats/files/:id/play) through pulse.chat_voice_open, which
-- checks access exactly as pulse.chat_file_read does and falls back to the original while a copy is not there yet.
create table pulse_priv.chat_file_play (
 org_id uuid not null,
 file_id uuid not null references pulse_priv.chat_file(id) on delete cascade,
 kind text not null check(kind in ('webm','aac')),
 mime text not null check(mime in ('audio/webm','audio/mp4')),
 bytes bytea check(octet_length(bytes)<=10485760),
 seconds numeric(9,2) check(seconds>=0),
 error text check(length(error)<=300),
 made_at timestamptz not null default clock_timestamp(),
 primary key(file_id,kind),
 check((bytes is null)=(error is not null))
);
create index chat_file_play_org on pulse_priv.chat_file_play(org_id,made_at);
alter table pulse_priv.chat_file_play enable row level security;
alter table pulse_priv.chat_file_play force row level security;
create policy tenant_isolation on pulse_priv.chat_file_play using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.chat_file_play to pulse_worker;
-- The worker's queue: audio chat files of the last 400 days without their copies, newest first.
create index chat_file_audio_recent on pulse_priv.chat_file(org_id,created_at desc) where mime like 'audio/%';

-- A voice note to play: the copy asked for (webm or aac) when it is there, else the original. Access as chat_file_read
-- (a reader of the conversation; a file only its uploader or an attached message reveals). `p_audit` writes the
-- download line once per play (the first range), not once per range request.
create function pulse.chat_voice_open(p_file uuid,p_kind text,p_audit boolean)
 returns table(name text,mime text,bytes bytea,kind text,seconds numeric,original_mime text)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if p_kind not in ('webm','aac','original') then raise exception 'choose webm, aac or original' using errcode='22023'; end if;
 if not exists(select 1 from pulse_priv.chat_file f where f.id=p_file and f.mime like 'audio/%' and chat_reads(f.channel_id) and
  (f.person_id=current_viewer() or exists(select 1 from chat_message m where m.channel_id=f.channel_id and m.removed_at is null and m.attachments @> jsonb_build_array(jsonb_build_object('id',p_file::text)))))
 then return; end if;
 if p_audit then perform audit_write('download','chat_file',p_file::text); end if;
 return query select f.name,coalesce(p.mime,f.mime),coalesce(p.bytes,f.bytes),coalesce(p.kind,'original'),p.seconds,f.mime
  from pulse_priv.chat_file f left join pulse_priv.chat_file_play p on p.file_id=f.id and p.kind=p_kind and p.bytes is not null
  where f.id=p_file;
end $$;
revoke all on function pulse.chat_voice_open(uuid,text,boolean) from public;
grant execute on function pulse.chat_voice_open(uuid,text,boolean) to pulse_api;
-- migrate:down
-- Forward-only.
