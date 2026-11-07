-- migrate:up
-- CALLS-V2 (25 Oct 2026): recording a call, its transcript and, when the company allows it, a short summary with action
-- items written by an AI employee. Additive on 0896 (calls) and 1032 (quality, screen sharing).
--
-- Recording is opt-in, call by call: someone of the team in the call presses Record (never automatic). Everyone in the
-- call sees "Recording" for as long as it runs and gets a consent notice (stay, or leave the call); who acknowledged it
-- is kept. The recorder's browser mixes the call's voices and uploads them in parts while it records, so a dropped
-- browser loses seconds, not the call. The recording is a line in the conversation ("Call recording · 4:32") for the
-- conversation's members; its transcript is made on this server (whisper, nothing leaves it); the summary goes to an
-- AI employee's engine only as the company's policy says (decision calls-ai-summary: team calls only by default).
--
--   chat_call_policy            per company: who may record (staff in the call, or nobody), transcripts on or off, AI summaries
--                               (off, team calls only, every recorded call).
--   chat_call_recording         one recording of a call: who, when, how long, its parts, transcript and summary state.
--   chat_call_recording_part    the audio, in order (pulse_priv: bytes are read only through chat_call_recording_audio()).
--   chat_call_recording_ack     who in the call saw the notice and stayed.

create table pulse.chat_call_policy (
 org_id uuid primary key references pulse.org(id),
 recording text not null default 'staff' check (recording in ('off','staff')),
 transcripts boolean not null default true,
 ai_summary text not null default 'staff' check (ai_summary in ('off','staff','all')),
 updated_by uuid references pulse.person(id), updated_at timestamptz not null default now()
);

create table pulse.chat_call_recording (
 org_id uuid not null, id uuid primary key default gen_random_uuid(), call_id uuid not null, channel_id uuid not null,
 started_by uuid not null references pulse.person(id), started_at timestamptz not null default clock_timestamp(), stopped_at timestamptz,
 state text not null default 'recording' check (state in ('recording','saved','failed','removed')),
 mime text not null default 'audio/webm' check (mime in ('audio/webm','audio/ogg','audio/mp4')),
 seconds integer check (seconds between 0 and 86400), bytes bigint not null default 0, parts integer not null default 0, last_part_at timestamptz,
 message_id uuid,
 transcript_state text not null default 'none' check (transcript_state in ('none','queued','working','done','failed','off')),
 transcript text check (length(transcript) <= 400000), segments jsonb check (segments is null or jsonb_typeof(segments)='array'), language text check (length(language) <= 12),
 transcript_at timestamptz, transcript_error text check (length(transcript_error) <= 300), attempts smallint not null default 0,
 summary_state text not null default 'none' check (summary_state in ('none','queued','working','done','failed','off')),
 summary jsonb check (summary is null or (jsonb_typeof(summary)='object' and length(summary::text) <= 20000)),
 summary_by uuid references pulse.person(id), summary_at timestamptz, summary_error text check (length(summary_error) <= 300), summary_lease timestamptz,
 removed_by uuid references pulse.person(id), removed_at timestamptz,
 unique (org_id, id),
 foreign key (org_id, call_id) references pulse.chat_call(org_id, id) on delete cascade,
 foreign key (org_id, channel_id) references pulse.chat_channel(org_id, id) on delete cascade
);
create unique index chat_call_recording_live on pulse.chat_call_recording (call_id) where state = 'recording';
create index chat_call_recording_channel on pulse.chat_call_recording (org_id, channel_id, started_at desc);
create index chat_call_recording_transcripts on pulse.chat_call_recording (org_id, transcript_state) where transcript_state in ('queued','working');
create index chat_call_recording_summaries on pulse.chat_call_recording (org_id, summary_state) where summary_state in ('queued','working');

create table pulse_priv.chat_call_recording_part (
 org_id uuid not null, recording_id uuid not null, seq integer not null check (seq between 0 and 20000),
 bytes bytea not null check (octet_length(bytes) between 1 and 1048576), created_at timestamptz not null default clock_timestamp(),
 primary key (recording_id, seq),
 foreign key (org_id, recording_id) references pulse.chat_call_recording(org_id, id) on delete cascade
);

create table pulse.chat_call_recording_ack (
 org_id uuid not null, recording_id uuid not null, person_id uuid not null references pulse.person(id), at timestamptz not null default clock_timestamp(),
 primary key (recording_id, person_id),
 foreign key (org_id, recording_id) references pulse.chat_call_recording(org_id, id) on delete cascade
);

do $$ declare t text; begin
 foreach t in array array['pulse.chat_call_policy','pulse.chat_call_recording','pulse_priv.chat_call_recording_part','pulse.chat_call_recording_ack'] loop
  execute format('alter table %s enable row level security',t);
  execute format('alter table %s force row level security',t);
  execute format('create policy tenant_isolation on %s using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select,insert,update,delete on %s to pulse_worker',t);
 end loop;
end $$;
create trigger audit_mutation after insert or update or delete on pulse.chat_call_recording for each row execute function pulse.audit_mutation();
create trigger audit_mutation after insert or update or delete on pulse.chat_call_policy for each row execute function pulse.audit_mutation();

-- The company's call policy (the defaults until an admin changes it).
create function pulse.chat_call_policy_get() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('recording',coalesce(p.recording,'staff'),'transcripts',coalesce(p.transcripts,true),'aiSummary',coalesce(p.ai_summary,'staff'),
  'updatedAt',p.updated_at,'updatedBy',(select display_name from person where id=p.updated_by))
 from (select 1) one left join chat_call_policy p on p.org_id=current_org()
$$;
create function pulse.chat_call_policy_set(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin') then raise exception 'Admins set the call policy' using errcode='42501'; end if;
 if jsonb_typeof(p) is distinct from 'object' or coalesce(p->>'recording','staff') not in ('off','staff') or coalesce(p->>'aiSummary','staff') not in ('off','staff','all')
   or (p ? 'transcripts' and jsonb_typeof(p->'transcripts')<>'boolean') then raise exception 'Choose who may record, transcripts and AI summaries' using errcode='22023'; end if;
 insert into chat_call_policy(org_id,recording,transcripts,ai_summary,updated_by,updated_at)
 values(current_org(),coalesce(p->>'recording','staff'),coalesce((p->>'transcripts')::boolean,true),coalesce(p->>'aiSummary','staff'),current_viewer(),now())
 on conflict(org_id) do update set recording=excluded.recording,transcripts=excluded.transcripts,ai_summary=excluded.ai_summary,updated_by=excluded.updated_by,updated_at=now();
 return chat_call_policy_get();
end $$;

-- May I start a recording in this call: of the team, in the call, the company allows it.
create function pulse.chat_call_may_record(p_call uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select recording from chat_call_policy where org_id=current_org()),'staff')<>'off'
  and exists(select 1 from person where id=current_viewer() and side='staff' and status='active')
  and (p_call is null or exists(select 1 from chat_call_party pa join chat_call c on c.id=pa.call_id where pa.org_id=current_org() and pa.call_id=p_call and pa.person_id=current_viewer() and pa.state='joined' and c.state<>'ended'))
$$;

-- The recording's line in the conversation, rewritten as it goes.
create function pulse.chat_call_record_line(p_rec uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r chat_call_recording; v_body text;
begin
 select * into r from chat_call_recording where org_id=current_org() and id=p_rec;
 if not found or r.message_id is null then return; end if;
 v_body:=case r.state when 'recording' then 'Call recording · recording now' when 'saved' then 'Call recording'||coalesce(' · '||(r.seconds/60)||':'||lpad((r.seconds%60)::text,2,'0'),'')
  when 'failed' then 'Call recording · nothing was saved' else 'Call recording · deleted' end;
 update chat_message set body=v_body,attachments=jsonb_build_array(jsonb_build_object('recording',r.id,'name','Call recording','recordingState',r.state,'seconds',r.seconds,
   'transcript',r.transcript_state,'summary',r.summary_state)),updated_at=clock_timestamp()
 where org_id=current_org() and id=r.message_id;
end $$;

-- A recording is over (stopped, the call ended, or its browser went quiet): what was uploaded is kept; the transcript and
-- the summary are asked for as the policy says.
create function pulse.chat_call_record_close(p_rec uuid,p_seconds int) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r chat_call_recording; pol chat_call_policy; staff_only boolean;
begin
 select * into r from chat_call_recording where org_id=current_org() and id=p_rec for update;
 if not found or r.state<>'recording' then return; end if;
 select * into pol from chat_call_policy where org_id=current_org();
 select not exists(select 1 from chat_call_party pa join person pe on pe.id=pa.person_id where pa.call_id=r.call_id and pa.joined_at is not null and pe.side<>'staff') into staff_only;
 update chat_call_recording set state=case when parts>0 then 'saved' else 'failed' end,stopped_at=clock_timestamp(),
  seconds=coalesce(least(greatest(p_seconds,0),86400),greatest(0,extract(epoch from clock_timestamp()-started_at))::int),
  transcript_state=case when parts>0 and coalesce(pol.transcripts,true) then 'queued' else 'off' end,
  summary_state=case when parts>0 and coalesce(pol.transcripts,true) and (coalesce(pol.ai_summary,'staff')='all' or (coalesce(pol.ai_summary,'staff')='staff' and staff_only)) then 'queued' else 'off' end
 where id=p_rec;
 perform chat_call_record_line(p_rec); perform chat_call_touch(r.call_id);
end $$;

-- Start recording: the call's people hear it at once (the call's state carries it) and the conversation gets its line.
create function pulse.chat_call_record_start(p_call uuid,p_mime text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c chat_call; rid uuid; mid uuid;
begin
 select * into c from chat_call where org_id=current_org() and id=p_call for update;
 if not found or not exists(select 1 from chat_call_party where call_id=p_call and person_id=current_viewer()) then raise exception 'call unavailable' using errcode='42501'; end if;
 if c.state<>'live' then raise exception 'Recording starts once the call is answered' using errcode='22023'; end if;
 if not chat_call_may_record(p_call) then raise exception 'Recording is not allowed here' using errcode='42501'; end if;
 if exists(select 1 from chat_call_recording where call_id=p_call and state='recording') then raise exception 'This call is already being recorded' using errcode='22023'; end if;
 insert into chat_call_recording(org_id,call_id,channel_id,started_by,mime) values(current_org(),p_call,c.channel_id,current_viewer(),
  case when p_mime in ('audio/webm','audio/ogg','audio/mp4') then p_mime else 'audio/webm' end) returning id into rid;
 insert into chat_call_recording_ack(org_id,recording_id,person_id) values(current_org(),rid,current_viewer());
 mid:=chat_event_line(c.channel_id,current_viewer(),'Call recording · recording now',jsonb_build_array(jsonb_build_object('recording',rid,'name','Call recording','recordingState','recording')));
 update chat_call_recording set message_id=mid where id=rid;
 perform chat_call_touch(p_call);
 return rid;
end $$;

-- A part of the audio, in order, from the recorder's browser (again is harmless). Parts are taken while it records and
-- for two minutes after it stopped (the last part may arrive after the hang-up). At most 64 MB a recording.
create function pulse.chat_call_record_part(p_rec uuid,p_seq int,p_bytes bytea) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r chat_call_recording; n int;
begin
 select * into r from chat_call_recording where org_id=current_org() and id=p_rec for update;
 if not found or r.started_by<>current_viewer() then raise exception 'recording unavailable' using errcode='42501'; end if;
 if not (r.state='recording' or (r.state='saved' and r.stopped_at>clock_timestamp()-interval '2 minutes') or (r.state='failed' and r.stopped_at>clock_timestamp()-interval '2 minutes')) then
  raise exception 'This recording has ended' using errcode='22023'; end if;
 if p_seq is null or p_seq<0 or p_seq>20000 or p_bytes is null or octet_length(p_bytes) not between 1 and 1048576 then raise exception 'invalid part' using errcode='22023'; end if;
 if r.bytes+octet_length(p_bytes)>67108864 then raise exception 'The recording is too long' using errcode='22023'; end if;
 insert into pulse_priv.chat_call_recording_part(org_id,recording_id,seq,bytes) values(current_org(),p_rec,p_seq,p_bytes) on conflict do nothing;
 get diagnostics n = row_count;
 if n=0 then return; end if;
 update chat_call_recording set parts=parts+1,bytes=bytes+octet_length(p_bytes),last_part_at=clock_timestamp(),
  state=case when state='failed' then 'saved' else state end,
  transcript_state=case when state='failed' and transcript_state='off' and coalesce((select transcripts from chat_call_policy where org_id=current_org()),true) then 'queued' else transcript_state end
 where id=p_rec;
 if r.state='failed' then perform chat_call_record_line(p_rec); end if;
end $$;

-- Stop: the recorder, or anyone in the call (stopping only ever keeps what was recorded).
create function pulse.chat_call_record_stop(p_rec uuid,p_seconds int) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r chat_call_recording;
begin
 select * into r from chat_call_recording where org_id=current_org() and id=p_rec;
 if not found or not exists(select 1 from chat_call_party where call_id=r.call_id and person_id=current_viewer()) then raise exception 'recording unavailable' using errcode='42501'; end if;
 perform chat_call_record_close(p_rec,case when r.started_by=current_viewer() then p_seconds end);
end $$;

-- I saw the notice and stay in the call.
create function pulse.chat_call_record_ack(p_rec uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r chat_call_recording;
begin
 select * into r from chat_call_recording where org_id=current_org() and id=p_rec;
 if not found or not exists(select 1 from chat_call_party where call_id=r.call_id and person_id=current_viewer()) then raise exception 'recording unavailable' using errcode='42501'; end if;
 insert into chat_call_recording_ack(org_id,recording_id,person_id) values(current_org(),p_rec,current_viewer()) on conflict do nothing;
end $$;

-- Delete: the recorder or an admin. The audio and its transcript go; the line says it was deleted.
create function pulse.chat_call_record_remove(p_rec uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r chat_call_recording;
begin
 select * into r from chat_call_recording where org_id=current_org() and id=p_rec for update;
 if not found or not chat_has(r.channel_id) then raise exception 'recording unavailable' using errcode='42501'; end if;
 if r.started_by<>current_viewer() and not viewer_is('admin') then raise exception 'Only the person who recorded it, or an admin, deletes a recording' using errcode='42501'; end if;
 if r.state='recording' then perform chat_call_record_close(p_rec,null); end if;
 delete from pulse_priv.chat_call_recording_part where org_id=current_org() and recording_id=p_rec;
 update chat_call_recording set state='removed',removed_by=current_viewer(),removed_at=clock_timestamp(),transcript=null,segments=null,summary=null,
  transcript_state='off',summary_state='off',bytes=0,parts=0 where id=p_rec;
 perform chat_call_record_line(p_rec);
end $$;

-- A recording as the conversation's members see it. AI notes are the team's: in a conversation with a client in it,
-- someone from the client's side sees the recording and its transcript (their own words) but not the AI's notes (AI
-- text reaches a client only through a person's approval; AI-EMP-2's recap cards do that).
create function pulse.chat_call_recording_view(p_rec uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 with notes as (select exists(select 1 from person where id=current_viewer() and side='staff') or not chat_client_facing(r.channel_id) ok from chat_call_recording r where r.id=p_rec)
 select jsonb_build_object('id',r.id,'callId',r.call_id,'channelId',r.channel_id,'state',r.state,'mime',r.mime,'seconds',r.seconds,'bytes',r.bytes,
  'startedAt',r.started_at,'stoppedAt',r.stopped_at,'by',r.started_by,'byName',(select display_name from person where id=r.started_by),
  'canRemove',r.state<>'removed' and (r.started_by=current_viewer() or viewer_is('admin')),
  'transcriptState',r.transcript_state,'transcript',r.transcript,'segments',r.segments,'language',r.language,
  'summaryState',case when (select ok from notes) then r.summary_state else 'off' end,'summary',case when (select ok from notes) then r.summary end,
  'summaryBy',case when (select ok from notes) then (select display_name from person where id=r.summary_by) end,
  'acks',(select coalesce(jsonb_agg(pe.display_name order by a.at),'[]') from chat_call_recording_ack a join person pe on pe.id=a.person_id where a.recording_id=r.id),
  'people',(select coalesce(jsonb_agg(pe.display_name order by pa.joined_at),'[]') from chat_call_party pa join person pe on pe.id=pa.person_id where pa.call_id=r.call_id and pa.joined_at is not null))
 from chat_call_recording r where r.org_id=current_org() and r.id=p_rec and chat_has(r.channel_id)
$$;
-- The audio, in one piece (the conversation's members).
create function pulse.chat_call_recording_audio(p_rec uuid) returns table(mime text,bytes bytea) language sql stable security definer set search_path=pulse,pg_temp as $$
 select r.mime,(select string_agg(p.bytes,''::bytea order by p.seq) from pulse_priv.chat_call_recording_part p where p.recording_id=r.id)
 from chat_call_recording r where r.org_id=current_org() and r.id=p_rec and r.state='saved' and chat_has(r.channel_id)
$$;

-- The call as its people see it (1032), and the recording going on, if any.
create or replace function pulse.chat_call_view(p_call uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',c.id,'channelId',c.channel_id,'channelKind',ch.kind,'channelName',case when ch.kind='direct' then null else ch.name end,
  'video',c.video,'state',c.state,'endReason',c.end_reason,'startedBy',c.started_by,'messageId',c.message_id,
  'createdAt',c.created_at,'answeredAt',c.answered_at,'endedAt',c.ended_at,'now',clock_timestamp(),
  'parties',(select jsonb_agg(jsonb_build_object('id',p.person_id,'name',pe.display_name,'photoAt',(select ph.updated_at from person_photo ph where ph.person_id=p.person_id),
    'state',p.state,'muted',p.muted,'video',p.video,'screen',p.screen and p.state='joined','joinedAt',p.joined_at,'invitedBy',p.invited_by) order by p.invited_at,pe.display_name)
   from chat_call_party p join person pe on pe.id=p.person_id where p.call_id=c.id),
  'recording',(select jsonb_build_object('id',r.id,'by',r.started_by,'byName',(select display_name from person where id=r.started_by),'startedAt',r.started_at,
     'acked',exists(select 1 from chat_call_recording_ack a where a.recording_id=r.id and a.person_id=current_viewer()))
   from chat_call_recording r where r.call_id=c.id and r.state='recording' limit 1),
  'mayRecord',chat_call_may_record(c.id),
  -- Would a recording of this call get AI notes (the company's policy and who is in it)? The notice says so.
  'aiNotes',coalesce((select transcripts from chat_call_policy where org_id=current_org()),true) and case coalesce((select ai_summary from chat_call_policy where org_id=current_org()),'staff')
    when 'all' then true when 'staff' then not exists(select 1 from chat_call_party pa join person pe on pe.id=pa.person_id where pa.call_id=c.id and pa.joined_at is not null and pe.side<>'staff') else false end,
  -- AI-EMP-2 (1045): in a conversation with a client and an AI employee in it, a recording's transcript becomes a recap the
  -- AI employee drafts for the team to check before anything is shared (an approval card); the notice says so.
  'aiRecap',chat_client_facing(c.channel_id) and coalesce((select transcripts from chat_call_policy where org_id=current_org()),true)
    and coalesce((select ai_summary from chat_call_policy where org_id=current_org()),'staff')<>'off'
    and exists(select 1 from chat_member cm join agent_member am on am.person_id=cm.person_id where cm.channel_id=c.channel_id and am.disabled_at is null),
  -- Ringing more people in is for the team (a client's people call their team from their own chats).
  'mayInvite',exists(select 1 from person where id=current_viewer() and side='staff' and status='active'))
 from chat_call c join chat_channel ch on ch.id=c.channel_id
 where c.org_id=current_org() and c.id=p_call and exists(select 1 from chat_call_party me where me.call_id=c.id and me.person_id=current_viewer())
$$;

-- The call's line (1032); an ended call also ends its recording (the recorder's last part may still arrive).
create or replace function pulse.chat_call_line(p_call uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c chat_call; secs int; st text; label text; rid uuid;
begin
 select * into c from chat_call where org_id=current_org() and id=p_call;
 if not found or c.message_id is null then return; end if;
 if c.state='ended' and c.end_reason='completed' and (select count(*) from chat_call_party where call_id=c.id)=2
   and exists(select 1 from chat_call_quality where org_id=current_org() and call_id=c.id and kind='failure' and reason='no-connect')
   and not exists(select 1 from chat_call_quality where org_id=current_org() and call_id=c.id and kind='setup') then
  update chat_call set end_reason='failed' where id=c.id; c.end_reason:='failed';
 end if;
 if c.state='ended' then for rid in select id from chat_call_recording where call_id=c.id and state='recording' loop perform chat_call_record_close(rid,null); end loop; end if;
 secs:=case when c.answered_at is not null then greatest(0,extract(epoch from coalesce(c.ended_at,clock_timestamp())-c.answered_at))::int end;
 st:=case when c.state<>'ended' then c.state else c.end_reason end;
 label:=case when c.video then 'Video call' else 'Voice call' end;
 update chat_message set body=case st when 'completed' then label||' · '||(secs/60)||':'||lpad((secs%60)::text,2,'0')
   when 'missed' then 'Missed '||lower(label) when 'declined' then label||' · declined' when 'busy' then label||' · busy' when 'failed' then label||' · not connected'
   when 'live' then label||' · on now' else label end,
  attachments=jsonb_build_array(jsonb_build_object('call',c.id,'name',label,'video',c.video,'state',st,'seconds',secs)),updated_at=clock_timestamp()
 where org_id=current_org() and id=c.message_id;
end $$;

-- Rings nobody answered, people whose Pulse went quiet, old events (0896); and a recording whose browser stopped sending
-- for three minutes is closed with what it sent.
create or replace function pulse.chat_call_expire() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record; p record;
begin
 for r in select distinct pa.call_id from chat_call_party pa join chat_call c on c.id=pa.call_id
  where pa.org_id=current_org() and c.org_id=current_org() and c.state<>'ended'
  and ((pa.state='ringing' and pa.invited_at<clock_timestamp()-interval '45 seconds') or (pa.state='joined' and pa.seen_at<clock_timestamp()-interval '30 seconds')) loop
  for p in select person_id from chat_call_party where call_id=r.call_id and state='ringing' and invited_at<clock_timestamp()-interval '45 seconds' loop
   update chat_call_party set state='missed',left_at=clock_timestamp() where call_id=r.call_id and person_id=p.person_id;
   perform chat_call_unring(r.call_id,p.person_id,true);
  end loop;
  update chat_call_party set state='left',left_at=clock_timestamp() where call_id=r.call_id and state='joined' and seen_at<clock_timestamp()-interval '30 seconds';
  perform chat_call_settle(r.call_id); perform chat_call_line(r.call_id); perform chat_call_touch(r.call_id);
 end loop;
 for r in select id from chat_call_recording where org_id=current_org() and state='recording' and coalesce(last_part_at,started_at)<clock_timestamp()-interval '3 minutes' loop
  perform chat_call_record_close(r.id,null);
 end loop;
 delete from chat_call_event where org_id=current_org() and created_at<clock_timestamp()-interval '10 minutes';
end $$;

-- AI employees' runtime: the next recorded call to summarise (its transcript, who was in it, the conversation), within
-- the AI employee's daily budget. Phone numbers are masked. Any of the company's AI employees may take it; the summary
-- names who wrote it.
create function pulse.chat_call_summary_claim() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r chat_call_recording; m agent_member; used int;
begin
 if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
 update chat_call_recording set summary_state='queued',summary_lease=null where org_id=current_org() and summary_state='working' and summary_lease<clock_timestamp();
 select * into m from agent_member where person_id = me;
 if not found then return null; end if;
 select coalesce(sum(coalesce(tokens, reserved)), 0)::int into used from agent_run
  where agent_id = me and (started_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date;
 if used + 30000 > m.daily_token_budget then return null; end if;
 select * into r from chat_call_recording where org_id=current_org() and summary_state='queued' and transcript_state='done' and state='saved'
  order by stopped_at limit 1 for update skip locked;
 if not found then return null; end if;
 update chat_call_recording set summary_state='working',summary_lease=clock_timestamp()+interval '12 minutes' where id=r.id;
 return jsonb_build_object('id',r.id,'seconds',r.seconds,'language',r.language,
  'when',to_char(r.started_at at time zone org_time_zone(),'FMDay DD Mon YYYY, HH24:MI'),
  'conversation',(select case when ch.kind='direct' then 'a one-to-one call' else 'a call in the group "'||ch.name||'"' end from chat_channel ch where ch.id=r.channel_id),
  'people',(select coalesce(jsonb_agg(jsonb_build_object('name',pe.display_name,'side',pe.side) order by pa.joined_at),'[]') from chat_call_party pa join person pe on pe.id=pa.person_id where pa.call_id=r.call_id and pa.joined_at is not null),
  'transcript',regexp_replace(left(r.transcript,60000),'\+?\d[\d \-]{8,}\d','[number]','g'));
end $$;
create function pulse.chat_call_summary_finish(p_rec uuid,p_ok boolean,p_summary jsonb,p_error text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); ch uuid;
begin
 if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
 update chat_call_recording set summary_state=case when p_ok then 'done' else 'failed' end,summary=case when p_ok then p_summary end,summary_by=me,summary_at=clock_timestamp(),
  summary_error=case when p_ok then null else left(p_error,300) end,summary_lease=null
 where org_id=current_org() and id=p_rec and summary_state='working' returning channel_id into ch;
 if ch is null then raise exception 'This summary is not waiting' using errcode='22023'; end if;
 perform chat_call_record_line(p_rec);
 return ch;
end $$;

revoke all on function pulse.chat_call_policy_get(),pulse.chat_call_policy_set(jsonb),pulse.chat_call_may_record(uuid),pulse.chat_call_record_line(uuid),pulse.chat_call_record_close(uuid,int),
 pulse.chat_call_record_start(uuid,text),pulse.chat_call_record_part(uuid,int,bytea),pulse.chat_call_record_stop(uuid,int),pulse.chat_call_record_ack(uuid),pulse.chat_call_record_remove(uuid),
 pulse.chat_call_recording_view(uuid),pulse.chat_call_recording_audio(uuid),pulse.chat_call_summary_claim(),pulse.chat_call_summary_finish(uuid,boolean,jsonb,text) from public;
grant execute on function pulse.chat_call_policy_get(),pulse.chat_call_policy_set(jsonb),pulse.chat_call_may_record(uuid),pulse.chat_call_record_start(uuid,text),pulse.chat_call_record_part(uuid,int,bytea),
 pulse.chat_call_record_stop(uuid,int),pulse.chat_call_record_ack(uuid),pulse.chat_call_record_remove(uuid),pulse.chat_call_recording_view(uuid),pulse.chat_call_recording_audio(uuid),
 pulse.chat_call_summary_claim(),pulse.chat_call_summary_finish(uuid,boolean,jsonb,text) to pulse_api;
-- The transcript worker (tools/voice-transcribe.py) closes stale recordings with the expiry and writes transcripts.
grant execute on function pulse.chat_call_record_line(uuid) to pulse_worker;

-- migrate:down
-- Forward-only.
