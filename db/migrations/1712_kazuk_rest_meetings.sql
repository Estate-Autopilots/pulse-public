-- migrate:up
-- KAZUK-REST slice 4 (Kazuk, 3 Nov meeting, backlog D1-D3): an in-person meeting, recorded in Pulse, transcribed on this
-- server and turned into tasks a person confirms, attached to a project or a client. Started from Meetings or from Pip
-- ("Start a meeting"). Built on the call recorder's pieces (1033): the browser records in parts and uploads them as it
-- goes; tools/voice-transcribe.py (the server's own Whisper, nothing leaves the server) transcribes a saved meeting when
-- the API has PULSE_VOICE_TRANSCRIPTS=1; otherwise the person types or pastes the notes and gets the same action items.
--
-- Consent: a meeting cannot start without the person confirming that everyone present was told it is recorded and
-- agreed (consent_at, consent_by, consent_text are kept on the row; a meeting with no recording, notes only, needs none).
--
--   meeting          one meeting: who, when, for which project or client, its audio's parts, transcript and actions state.
--   meeting_part     the audio, in order (pulse_priv: read only through meeting_audio()).
--   meeting_action   an action item read from the transcript: a draft until a person confirms it (a task) or drops it.
--
-- Who sees a meeting: the person who recorded it, the people named in it, and leadership and admins (meeting_can).

create table pulse.meeting (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 title text not null check (length(btrim(title)) between 1 and 160 and title !~ '[[:cntrl:]]'),
 project_id uuid, client_id uuid,
 attendees uuid[] not null default '{}' check (cardinality(attendees) <= 40),
 started_by uuid not null references pulse.person(id), started_at timestamptz not null default clock_timestamp(), stopped_at timestamptz,
 kind text not null default 'recording' check (kind in ('recording','notes')),
 consent_at timestamptz, consent_by uuid references pulse.person(id), consent_text text check (length(consent_text) <= 600),
 state text not null default 'recording' check (state in ('recording','saved','failed','removed')),
 mime text not null default 'audio/webm' check (mime in ('audio/webm','audio/ogg','audio/mp4')),
 seconds integer check (seconds between 0 and 86400), bytes bigint not null default 0, parts integer not null default 0, last_part_at timestamptz,
 transcript_state text not null default 'none' check (transcript_state in ('none','queued','working','done','failed','off')),
 transcript text check (length(transcript) <= 400000), segments jsonb check (segments is null or jsonb_typeof(segments)='array'), language text check (length(language) <= 12),
 transcript_at timestamptz, transcript_error text check (length(transcript_error) <= 300), attempts smallint not null default 0,
 actions_state text not null default 'none' check (actions_state in ('none','pending','done')),
 removed_by uuid references pulse.person(id), removed_at timestamptz,
 unique (org_id, id),
 -- A recording needs the consent notice confirmed first; notes typed afterwards need none.
 check (kind = 'notes' or (consent_at is not null and consent_by is not null and length(btrim(coalesce(consent_text,''))) > 0))
);
create index meeting_recent on pulse.meeting (org_id, started_at desc);
create index meeting_transcripts on pulse.meeting (org_id, transcript_state) where transcript_state in ('queued','working');

create table pulse_priv.meeting_part (
 org_id uuid not null, meeting_id uuid not null, seq integer not null check (seq between 0 and 20000),
 bytes bytea not null check (octet_length(bytes) between 1 and 1048576), created_at timestamptz not null default clock_timestamp(),
 primary key (meeting_id, seq),
 foreign key (org_id, meeting_id) references pulse.meeting(org_id, id) on delete cascade
);

create table pulse.meeting_action (
 org_id uuid not null, id uuid primary key default gen_random_uuid(), meeting_id uuid not null,
 position smallint not null check (position between 0 and 99),
 title text not null check (length(btrim(title)) between 1 and 300),
 quote text check (length(quote) <= 600),
 assignee_id uuid references pulse.person(id), due_on date,
 state text not null default 'draft' check (state in ('draft','confirmed','dropped')),
 task_id uuid, decided_by uuid references pulse.person(id), decided_at timestamptz,
 unique (meeting_id, position),
 foreign key (org_id, meeting_id) references pulse.meeting(org_id, id) on delete cascade
);

do $$ declare t text; begin
 foreach t in array array['pulse.meeting','pulse_priv.meeting_part','pulse.meeting_action'] loop
  execute format('alter table %s enable row level security',t);
  execute format('alter table %s force row level security',t);
  execute format('create policy tenant_isolation on %s using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select,insert,update,delete on %s to pulse_worker',t);
 end loop;
end $$;
create trigger audit_mutation after insert or update or delete on pulse.meeting for each row execute function pulse.audit_mutation();
create trigger audit_mutation after insert or update or delete on pulse.meeting_action for each row execute function pulse.audit_mutation();

-- May the viewer see this meeting: who recorded it, the people named in it, leadership and admins.
create function pulse.meeting_can(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from meeting m where m.org_id=current_org() and m.id=p_id and m.state<>'removed'
  and (m.started_by=current_viewer() or current_viewer()=any(m.attendees) or viewer_is('admin') or coalesce(work_role(),'')='leadership'))
$$;

-- Start a meeting (recording, or notes only). Staff only; the project and client must be this company's.
create function pulse.meeting_start(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); v_kind text := coalesce(p->>'kind','recording'); v_project uuid; v_client uuid; v_people uuid[]; rid uuid;
begin
 if me is null or not exists(select 1 from person where org_id=current_org() and id=me and side='staff' and status='active') then
  raise exception 'Meetings belong to a staff person' using errcode='42501'; end if;
 if jsonb_typeof(p) is distinct from 'object' or v_kind not in ('recording','notes') then raise exception 'Choose a recording or notes' using errcode='22023'; end if;
 if v_kind='recording' and (p->>'consent') is distinct from 'true' then
  raise exception 'Tell everyone present that the meeting is recorded, and confirm they agreed, before you start' using errcode='22023'; end if;
 if coalesce(p->>'projectId','')<>'' then
  v_project := (p->>'projectId')::uuid;
  if not exists(select 1 from project where org_id=current_org() and id=v_project and deleted_at is null) then raise exception 'Project not found' using errcode='P0002'; end if;
  select client_id into v_client from project where id=v_project;
 end if;
 if coalesce(p->>'clientId','')<>'' then
  v_client := (p->>'clientId')::uuid;
  if not exists(select 1 from client where org_id=current_org() and id=v_client) then raise exception 'Client not found' using errcode='P0002'; end if;
 end if;
 select coalesce(array_agg(distinct pe.id),'{}') into v_people from jsonb_array_elements_text(case when jsonb_typeof(p->'attendees')='array' then p->'attendees' else '[]' end) a(x)
  join person pe on pe.org_id=current_org() and pe.id::text=a.x and pe.side='staff';
 insert into meeting(org_id,title,project_id,client_id,attendees,started_by,kind,consent_at,consent_by,consent_text,mime,state,stopped_at)
 values(current_org(),btrim(coalesce(nullif(btrim(p->>'title'),''),'Meeting')),v_project,v_client,array_remove(v_people,me),me,v_kind,
  case when v_kind='recording' then clock_timestamp() end,case when v_kind='recording' then me end,case when v_kind='recording' then left(p->>'consentText',600) end,
  case when p->>'mime' in ('audio/webm','audio/ogg','audio/mp4') then p->>'mime' else 'audio/webm' end,
  case when v_kind='notes' then 'saved' else 'recording' end, case when v_kind='notes' then clock_timestamp() end)
 returning id into rid;
 return rid;
end $$;

-- A part of the audio from the recorder's browser, in order (again is harmless); taken while it records and two minutes after.
create function pulse.meeting_part_add(p_id uuid,p_seq int,p_bytes bytea) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m meeting; n int;
begin
 select * into m from meeting where org_id=current_org() and id=p_id for update;
 if not found or m.started_by<>current_viewer() or m.kind<>'recording' then raise exception 'meeting unavailable' using errcode='42501'; end if;
 if not (m.state='recording' or (m.state in ('saved','failed') and m.stopped_at>clock_timestamp()-interval '2 minutes')) then raise exception 'This recording has ended' using errcode='22023'; end if;
 if p_seq is null or p_seq<0 or p_seq>20000 or p_bytes is null or octet_length(p_bytes) not between 1 and 1048576 then raise exception 'invalid part' using errcode='22023'; end if;
 if m.bytes+octet_length(p_bytes)>134217728 then raise exception 'The recording is too long' using errcode='22023'; end if;
 insert into pulse_priv.meeting_part(org_id,meeting_id,seq,bytes) values(current_org(),p_id,p_seq,p_bytes) on conflict do nothing;
 get diagnostics n = row_count;
 if n=0 then return; end if;
 update meeting set parts=parts+1,bytes=bytes+octet_length(p_bytes),last_part_at=clock_timestamp(),state=case when state='failed' then 'saved' else state end,
  transcript_state=case when state='failed' and transcript_state='queued' then 'queued' else transcript_state end where id=p_id;
end $$;

-- Stop: what was uploaded is kept; the transcript is queued for the server's Whisper when it is switched on (p_transcribe).
create function pulse.meeting_stop(p_id uuid,p_seconds int,p_transcribe boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m meeting;
begin
 select * into m from meeting where org_id=current_org() and id=p_id for update;
 if not found or m.started_by<>current_viewer() then raise exception 'meeting unavailable' using errcode='42501'; end if;
 if m.state<>'recording' then return; end if;
 update meeting set state=case when parts>0 then 'saved' else 'failed' end,stopped_at=clock_timestamp(),
  seconds=coalesce(least(greatest(p_seconds,0),86400),greatest(0,extract(epoch from clock_timestamp()-started_at))::int),
  transcript_state=case when coalesce(p_transcribe,false) then 'queued' else 'off' end where id=p_id;
end $$;

-- Typed or pasted notes (transcripts off, a meeting not recorded, or a correction): they become the transcript and the
-- action items are read again (the drafts not yet decided are replaced; confirmed ones stay).
create function pulse.meeting_notes_set(p_id uuid,p_text text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m meeting;
begin
 select * into m from meeting where org_id=current_org() and id=p_id for update;
 if not found or not meeting_can(p_id) then raise exception 'meeting unavailable' using errcode='42501'; end if;
 if m.started_by<>current_viewer() and not viewer_is('admin') and coalesce(work_role(),'')<>'leadership' then raise exception 'The person who recorded the meeting writes its notes' using errcode='42501'; end if;
 if p_text is null or length(btrim(p_text)) not between 1 and 400000 then raise exception 'Write the notes (up to 400,000 characters)' using errcode='22023'; end if;
 update meeting set transcript=btrim(p_text),transcript_state='done',transcript_at=clock_timestamp(),segments=null,actions_state='pending' where id=p_id;
end $$;

-- The action items read from the transcript (services/api/src/meeting-actions.ts), as drafts: undecided drafts are replaced.
create function pulse.meeting_actions_set(p_id uuid,p_items jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare i int := 0; x jsonb; start int;
begin
 if not meeting_can(p_id) then raise exception 'meeting unavailable' using errcode='42501'; end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>30 then raise exception 'Up to 30 action items' using errcode='22023'; end if;
 delete from meeting_action where org_id=current_org() and meeting_id=p_id and state='draft';
 select coalesce(max(position)+1,0) into start from meeting_action where org_id=current_org() and meeting_id=p_id;
 for x in select * from jsonb_array_elements(p_items) loop
  insert into meeting_action(org_id,meeting_id,position,title,quote,assignee_id,due_on)
  values(current_org(),p_id,start+i,left(btrim(x->>'title'),300),left(x->>'quote',600),
   (select id from person where org_id=current_org() and side='staff' and id::text=x->>'assigneeId'),
   case when x->>'dueOn' ~ '^\d{4}-\d{2}-\d{2}$' then (x->>'dueOn')::date end);
  i := i+1;
 end loop;
 update meeting set actions_state='done' where org_id=current_org() and id=p_id;
end $$;

-- Confirm a draft: it becomes a task (on the meeting's project when it has one), with what the person changed; or drop it.
create function pulse.meeting_action_decide(p_meeting uuid,p_action uuid,p_confirm boolean,p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a meeting_action; m meeting; tid uuid; v_title text; v_who uuid; v_due date; v_note text; v_ask text;
begin
 select * into a from meeting_action where org_id=current_org() and id=p_action for update;
 if not found or a.meeting_id is distinct from p_meeting or not meeting_can(a.meeting_id) then raise exception 'action unavailable' using errcode='42501'; end if;
 if a.state<>'draft' then raise exception 'This action item was already decided' using errcode='22023'; end if;
 select * into m from meeting where id=a.meeting_id;
 if not p_confirm then
  update meeting_action set state='dropped',decided_by=current_viewer(),decided_at=clock_timestamp() where id=p_action;
  return jsonb_build_object('state','dropped');
 end if;
 v_title := left(btrim(coalesce(nullif(btrim(p->>'title'),''),a.title)),300);
 v_who := coalesce(case when p ? 'assigneeId' then (select id from person where org_id=current_org() and side='staff' and id::text=p->>'assigneeId') else a.assignee_id end,current_viewer());
 v_due := case when p ? 'dueOn' then case when p->>'dueOn' ~ '^\d{4}-\d{2}-\d{2}$' then (p->>'dueOn')::date end else a.due_on end;
 v_note := 'From the meeting “'||m.title||'” on '||to_char(m.started_at at time zone org_time_zone(),'DD Mon YYYY')||coalesce(': “'||left(a.quote,300)||'”','');
 begin
  tid := task_save(null,jsonb_strip_nulls(jsonb_build_object('title',v_title,'assigneeId',v_who,'projectId',m.project_id,'dueOn',v_due,'notes',v_note)));
 exception when insufficient_privilege then
  -- The person confirming may not give that colleague tasks (Settings → Who can do what): the task is theirs, and says
  -- whom the meeting named, so they hand it over or ask; nothing is assigned past the company's rules.
  v_ask := (select display_name from person where id=v_who); v_who := current_viewer();
  tid := task_save(null,jsonb_strip_nulls(jsonb_build_object('title',v_title,'assigneeId',v_who,'projectId',m.project_id,'dueOn',v_due,
   'notes',v_note||E'\n\nThe meeting named '||v_ask||'. Your role does not give them tasks: ask them, or their lead, to take it.')));
 end;
 update meeting_action set state='confirmed',task_id=tid,title=v_title,assignee_id=v_who,due_on=v_due,decided_by=current_viewer(),decided_at=clock_timestamp() where id=p_action;
 return jsonb_strip_nulls(jsonb_build_object('state','confirmed','taskId',tid,'askNeeded',v_ask));
end $$;

-- Delete: the person who recorded it, or an admin. The audio, transcript and drafts go; confirmed tasks stay.
create function pulse.meeting_remove(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m meeting;
begin
 select * into m from meeting where org_id=current_org() and id=p_id for update;
 if not found or not meeting_can(p_id) then raise exception 'meeting unavailable' using errcode='42501'; end if;
 if m.started_by<>current_viewer() and not viewer_is('admin') then raise exception 'Only the person who recorded it, or an admin, deletes a meeting' using errcode='42501'; end if;
 delete from pulse_priv.meeting_part where org_id=current_org() and meeting_id=p_id;
 delete from meeting_action where org_id=current_org() and meeting_id=p_id and state='draft';
 update meeting set state='removed',removed_by=current_viewer(),removed_at=clock_timestamp(),transcript=null,segments=null,transcript_state='off',bytes=0,parts=0 where id=p_id;
end $$;

-- One meeting as the viewer sees it (null when they may not).
create function pulse.meeting_view(p_id uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',m.id,'title',m.title,'kind',m.kind,'state',m.state,'mime',m.mime,'seconds',m.seconds,'bytes',m.bytes,'startedAt',m.started_at,'stoppedAt',m.stopped_at,
  'by',m.started_by,'byName',(select display_name from person where id=m.started_by),'mine',m.started_by=current_viewer(),
  'canRemove',m.started_by=current_viewer() or viewer_is('admin'),
  'canEdit',m.started_by=current_viewer() or viewer_is('admin') or coalesce(work_role(),'')='leadership',
  'project',(select jsonb_build_object('id',p.id,'name',coalesce(p.title,p.name)) from project p where p.org_id=m.org_id and p.id=m.project_id),
  'client',(select jsonb_build_object('id',c.id,'name',c.display_name) from client c where c.org_id=m.org_id and c.id=m.client_id),
  'attendees',(select coalesce(jsonb_agg(jsonb_build_object('id',pe.id,'name',pe.display_name) order by pe.display_name),'[]') from person pe where pe.org_id=m.org_id and pe.id=any(m.attendees)),
  'consent',case when m.consent_at is not null then jsonb_build_object('at',m.consent_at,'by',(select display_name from person where id=m.consent_by),'text',m.consent_text) end,
  'transcriptState',m.transcript_state,'transcript',m.transcript,'segments',m.segments,'language',m.language,'actionsState',m.actions_state,
  'actions',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,'quote',a.quote,'assigneeId',a.assignee_id,
     'assignee',(select display_name from person where id=a.assignee_id),'dueOn',a.due_on,'state',a.state,'taskId',a.task_id) order by a.position),'[]')
   from meeting_action a where a.org_id=m.org_id and a.meeting_id=m.id))
 from meeting m where m.org_id=current_org() and m.id=p_id and meeting_can(p_id)
$$;

-- The viewer's meetings, newest first.
create function pulse.meeting_list() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(x order by x->>'startedAt' desc),'[]') from (
  select jsonb_build_object('id',m.id,'title',m.title,'kind',m.kind,'state',m.state,'seconds',m.seconds,'startedAt',m.started_at,'byName',(select display_name from person where id=m.started_by),
   'project',(select coalesce(p.title,p.name) from project p where p.org_id=m.org_id and p.id=m.project_id),
   'client',(select c.display_name from client c where c.org_id=m.org_id and c.id=m.client_id),
   'transcriptState',m.transcript_state,
   'drafts',(select count(*) from meeting_action a where a.meeting_id=m.id and a.state='draft'),
   'tasks',(select count(*) from meeting_action a where a.meeting_id=m.id and a.state='confirmed')) x
  from meeting m where m.org_id=current_org() and m.state<>'removed' and meeting_can(m.id)
  order by m.started_at desc limit 100) s
$$;

-- The audio, in one piece.
create function pulse.meeting_audio(p_id uuid) returns table(mime text,bytes bytea) language sql stable security definer set search_path=pulse,pg_temp as $$
 select m.mime,(select string_agg(p.bytes,''::bytea order by p.seq) from pulse_priv.meeting_part p where p.meeting_id=m.id)
 from meeting m where m.org_id=current_org() and m.id=p_id and m.state='saved' and meeting_can(p_id)
$$;

revoke all on function pulse.meeting_can(uuid), pulse.meeting_start(jsonb), pulse.meeting_part_add(uuid,int,bytea), pulse.meeting_stop(uuid,int,boolean),
 pulse.meeting_notes_set(uuid,text), pulse.meeting_actions_set(uuid,jsonb), pulse.meeting_action_decide(uuid,uuid,boolean,jsonb), pulse.meeting_remove(uuid),
 pulse.meeting_view(uuid), pulse.meeting_list(), pulse.meeting_audio(uuid) from public;
grant execute on function pulse.meeting_can(uuid), pulse.meeting_start(jsonb), pulse.meeting_part_add(uuid,int,bytea), pulse.meeting_stop(uuid,int,boolean),
 pulse.meeting_notes_set(uuid,text), pulse.meeting_actions_set(uuid,jsonb), pulse.meeting_action_decide(uuid,uuid,boolean,jsonb), pulse.meeting_remove(uuid),
 pulse.meeting_view(uuid), pulse.meeting_list(), pulse.meeting_audio(uuid) to pulse_api;
-- The transcriber (tools/voice-transcribe.py) works the queue with its own grants on the tables above.

-- migrate:down
-- Forward-only: meetings, their audio and the tasks made from them are kept.
