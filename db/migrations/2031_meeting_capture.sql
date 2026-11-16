-- migrate:up
-- MEETING-CAPTURE (FEATURE-AUDIT gap, 9 Nov 2026; MEETING-DEEP C #20/#21, MASTER-BACKLOG PW-07, conflict C6). One capture
-- engine: slice 4's meeting record (1712). A transcript pasted or uploaded (Wispr Flow, Loom, Otter, .txt, .vtt, .srt)
-- becomes a meeting with its speakers kept, a short summary and draft action items a person confirms into tasks (the same
-- confirm step). "Narrate a problem" is a meeting too (purpose 'problem'): a person pastes or records "this doesn't scroll
-- on the tasks page" and Pulse drafts one bug report (KAZUK-REST slice 5 routes it to the dev board) or one task, with the
-- page named; a person confirms it. Every transcript is kept line by line, searchable only by the people who may see the
-- meeting (row security per meeting), and a task made from a meeting links back to its line.
-- The parsing, summary and drafts are read on this server (services/api/src/transcript-import.ts): nothing goes to an
-- outside AI service, and transcripts never leave the server.
--
--   meeting        + source (recorder, notes, paste, file), source_format, source_name, purpose (meeting, problem),
--                    summary, speakers, held_on (the day it was held, for a transcript brought in later)
--   meeting_action + kind (task, bug), route (the page a problem names), line_no (the transcript line), bug_id
--   meeting_line   the transcript, one row per line (speaker, time, words); forced RLS, a tenant policy, and a restrictive
--                  policy: a line is read only where pulse.meeting_can() lets the viewer see its meeting.

alter table pulse.meeting
 add column source text not null default 'recorder' check (source in ('recorder','notes','paste','file')),
 add column source_format text check (source_format in ('plain','speakers','wispr','loom','otter','vtt','srt')),
 add column source_name text check (length(source_name) between 1 and 200 and source_name !~ '[[:cntrl:]]'),
 add column purpose text not null default 'meeting' check (purpose in ('meeting','problem')),
 add column summary text check (length(summary) <= 2000),
 add column speakers text[] not null default '{}' check (cardinality(speakers) <= 40),
 add column held_on date;
update pulse.meeting set source = 'notes' where kind = 'notes';

alter table pulse.meeting_action
 add column kind text not null default 'task' check (kind in ('task','bug')),
 add column route text check (route ~ '^/[A-Za-z0-9/_.~%-]{0,200}$'),
 add column line_no integer check (line_no between 1 and 100000),
 add column bug_id uuid references pulse.reported_bug(id) on delete set null;
create index meeting_action_task on pulse.meeting_action (org_id, task_id) where task_id is not null;

create table pulse.meeting_line (
 org_id uuid not null, meeting_id uuid not null,
 n integer not null check (n between 1 and 100000),
 speaker text check (length(speaker) between 1 and 80 and speaker !~ '[[:cntrl:]]'),
 at_s integer check (at_s between 0 and 172800),
 words text not null check (length(words) between 1 and 4000),
 search tsvector generated always as (to_tsvector('simple', coalesce(speaker, '') || ' ' || words)) stored,
 primary key (meeting_id, n),
 foreign key (org_id, meeting_id) references pulse.meeting(org_id, id) on delete cascade
);
create index meeting_line_search on pulse.meeting_line using gin (search);
create index meeting_line_org on pulse.meeting_line (org_id, meeting_id);
alter table pulse.meeting_line enable row level security;
alter table pulse.meeting_line force row level security;
create policy tenant_isolation on pulse.meeting_line using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- Row security per meeting, for every role (the SECURITY DEFINER functions below run under it too): a line is read only
-- by someone who may see its meeting (who recorded or brought it in, the people named in it, leadership and admins).
create policy meeting_people on pulse.meeting_line as restrictive for select using (pulse.meeting_can(meeting_id));

-- Start a meeting (recording, or notes only). purpose 'problem': a person records themself describing a problem.
create or replace function pulse.meeting_start(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); v_kind text := coalesce(p->>'kind','recording'); v_purpose text := coalesce(p->>'purpose','meeting');
 v_project uuid; v_client uuid; v_people uuid[]; rid uuid;
begin
 if me is null or not exists(select 1 from person where org_id=current_org() and id=me and side='staff' and status='active') then
  raise exception 'Meetings belong to a staff person' using errcode='42501'; end if;
 if jsonb_typeof(p) is distinct from 'object' or v_kind not in ('recording','notes') or v_purpose not in ('meeting','problem') then
  raise exception 'Choose a recording or notes' using errcode='22023'; end if;
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
 insert into meeting(org_id,title,project_id,client_id,attendees,started_by,kind,consent_at,consent_by,consent_text,mime,state,stopped_at,source,purpose)
 values(current_org(),btrim(coalesce(nullif(btrim(p->>'title'),''),'Meeting')),v_project,v_client,array_remove(v_people,me),me,v_kind,
  case when v_kind='recording' then clock_timestamp() end,case when v_kind='recording' then me end,case when v_kind='recording' then left(p->>'consentText',600) end,
  case when p->>'mime' in ('audio/webm','audio/ogg','audio/mp4') then p->>'mime' else 'audio/webm' end,
  case when v_kind='notes' then 'saved' else 'recording' end, case when v_kind='notes' then clock_timestamp() end,
  case when v_kind='notes' then 'notes' else 'recorder' end, v_purpose)
 returning id into rid;
 return rid;
end $$;

-- The transcript's lines, summary and speakers (read on this server from the transcript): replaced as a whole. Whoever may
-- see the meeting fills them the first time (the server's Whisper finished); after that only who may edit its notes.
create function pulse.meeting_lines_set(p_id uuid, p_lines jsonb, p_summary text, p_speakers text[]) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m meeting; x jsonb; i int := 0;
begin
 select * into m from meeting where org_id=current_org() and id=p_id for update;
 if not found or not meeting_can(p_id) then raise exception 'meeting unavailable' using errcode='42501'; end if;
 if exists(select 1 from meeting_line where meeting_id=p_id) and m.started_by<>current_viewer() and not viewer_is('admin') and coalesce(work_role(),'')<>'leadership' then
  raise exception 'The person who recorded the meeting writes its notes' using errcode='42501'; end if;
 if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)>20000 then raise exception 'Up to 20,000 lines' using errcode='22023'; end if;
 delete from meeting_line where org_id=current_org() and meeting_id=p_id;
 for x in select * from jsonb_array_elements(p_lines) loop
  continue when length(btrim(coalesce(x->>'text',''))) = 0;
  i := i+1;
  insert into meeting_line(org_id,meeting_id,n,speaker,at_s,words)
  values(current_org(),p_id,i,nullif(left(regexp_replace(btrim(coalesce(x->>'speaker','')),'[[:cntrl:]]',' ','g'),80),''),
   case when (x->>'at') ~ '^\d{1,6}$' and (x->>'at')::int <= 172800 then (x->>'at')::int end, left(btrim(x->>'text'),4000));
 end loop;
 update meeting set summary=nullif(left(btrim(coalesce(p_summary,'')),2000),''),
  speakers=(select coalesce(array_agg(s order by o),'{}') from (select distinct on (lower(s)) left(btrim(s),80) s, o from unnest(coalesce(p_speakers,'{}')) with ordinality u(s,o)
   where length(btrim(s)) between 1 and 80 order by lower(s), o limit 40) q)
 where id=p_id;
end $$;

-- A transcript pasted or uploaded (Wispr Flow, Loom, Otter, a .txt, .vtt or .srt), or a problem narrated in words: one
-- meeting, with its lines, summary and speakers; the API reads its drafts next (meeting_actions_set). Staff only.
create function pulse.meeting_import(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); v_purpose text := coalesce(p->>'purpose','meeting'); v_source text := coalesce(p->>'source','paste');
 v_text text := btrim(coalesce(p->>'transcript','')); v_project uuid; v_client uuid; v_people uuid[]; v_name text; rid uuid;
begin
 if me is null or not exists(select 1 from person where org_id=current_org() and id=me and side='staff' and status='active') then
  raise exception 'Meetings belong to a staff person' using errcode='42501'; end if;
 if jsonb_typeof(p) is distinct from 'object' or v_purpose not in ('meeting','problem') or v_source not in ('paste','file') then
  raise exception 'Paste the transcript or choose its file' using errcode='22023'; end if;
 if length(v_text) not between 1 and 400000 then raise exception 'Paste the transcript (up to 400,000 characters)' using errcode='22023'; end if;
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
 v_name := nullif(left(regexp_replace(btrim(coalesce(p->>'sourceName','')),'[[:cntrl:]]',' ','g'),200),'');
 insert into meeting(org_id,title,project_id,client_id,attendees,started_by,kind,state,stopped_at,source,source_format,source_name,purpose,held_on,
  transcript,transcript_state,transcript_at,actions_state)
 values(current_org(),left(btrim(coalesce(nullif(regexp_replace(btrim(p->>'title'),'[[:cntrl:]]',' ','g'),''),'Meeting')),160),v_project,v_client,array_remove(v_people,me),me,
  'notes','saved',clock_timestamp(),v_source,
  case when p->>'format' in ('plain','speakers','wispr','loom','otter','vtt','srt') then p->>'format' end, v_name, v_purpose,
  case when p->>'heldOn' ~ '^\d{4}-\d{2}-\d{2}$' then (p->>'heldOn')::date end,
  v_text,'done',clock_timestamp(),'pending')
 returning id into rid;
 perform meeting_lines_set(rid, coalesce(p->'lines','[]'::jsonb), p->>'summary',
  array(select jsonb_array_elements_text(case when jsonb_typeof(p->'speakers')='array' then p->'speakers' else '[]' end)));
 return rid;
end $$;

-- Typed or pasted notes (a correction too): they become the transcript; its lines are read again by the API, and the
-- undecided drafts are replaced (confirmed ones stay).
create or replace function pulse.meeting_notes_set(p_id uuid,p_text text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m meeting;
begin
 select * into m from meeting where org_id=current_org() and id=p_id for update;
 if not found or not meeting_can(p_id) then raise exception 'meeting unavailable' using errcode='42501'; end if;
 if m.started_by<>current_viewer() and not viewer_is('admin') and coalesce(work_role(),'')<>'leadership' then raise exception 'The person who recorded the meeting writes its notes' using errcode='42501'; end if;
 if p_text is null or length(btrim(p_text)) not between 1 and 400000 then raise exception 'Write the notes (up to 400,000 characters)' using errcode='22023'; end if;
 delete from meeting_line where org_id=current_org() and meeting_id=p_id;
 update meeting set transcript=btrim(p_text),transcript_state='done',transcript_at=clock_timestamp(),segments=null,actions_state='pending',summary=null where id=p_id;
end $$;

-- The drafts read from the transcript: undecided drafts are replaced. A draft is a task, or (a narrated problem) a bug
-- report, with the page it names and the line it came from.
create or replace function pulse.meeting_actions_set(p_id uuid,p_items jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare i int := 0; x jsonb; start int;
begin
 if not meeting_can(p_id) then raise exception 'meeting unavailable' using errcode='42501'; end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>30 then raise exception 'Up to 30 action items' using errcode='22023'; end if;
 delete from meeting_action where org_id=current_org() and meeting_id=p_id and state='draft';
 select coalesce(max(position)+1,0) into start from meeting_action where org_id=current_org() and meeting_id=p_id;
 for x in select * from jsonb_array_elements(p_items) loop
  insert into meeting_action(org_id,meeting_id,position,title,quote,assignee_id,due_on,kind,route,line_no)
  values(current_org(),p_id,start+i,left(btrim(x->>'title'),300),left(x->>'quote',600),
   (select id from person where org_id=current_org() and side='staff' and id::text=x->>'assigneeId'),
   case when x->>'dueOn' ~ '^\d{4}-\d{2}-\d{2}$' then (x->>'dueOn')::date end,
   case when x->>'kind'='bug' then 'bug' else 'task' end,
   case when x->>'route' ~ '^/[A-Za-z0-9/_.~%-]{0,200}$' then x->>'route' end,
   case when (x->>'lineNo') ~ '^\d{1,6}$' and (x->>'lineNo')::int between 1 and 100000 then (x->>'lineNo')::int end);
  i := i+1;
 end loop;
 update meeting set actions_state='done' where org_id=current_org() and id=p_id;
end $$;

-- Confirm a draft or drop it. A task draft becomes a task (on the meeting's project) whose notes link back to the
-- transcript's line. A bug draft is confirmed with the report the API just filed for the viewer (p.bugId, their own
-- report in this company: KAZUK-REST slice 5 routes it to the dev board); p.kind='task' makes a bug draft a task instead.
-- The task's notes say where it came from in one short line; the task page links to the transcript's line
-- (meeting_for_task), so the notes carry no address and the quote only once.
create or replace function pulse.meeting_action_decide(p_meeting uuid,p_action uuid,p_confirm boolean,p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a meeting_action; m meeting; tid uuid; v_title text; v_who uuid; v_due date; v_note text; v_ask text; v_kind text; b record;
begin
 select * into a from meeting_action where org_id=current_org() and id=p_action for update;
 if not found or a.meeting_id is distinct from p_meeting or not meeting_can(a.meeting_id) then raise exception 'action unavailable' using errcode='42501'; end if;
 if a.state<>'draft' then raise exception 'This action item was already decided' using errcode='22023'; end if;
 select * into m from meeting where id=a.meeting_id;
 if not p_confirm then
  update meeting_action set state='dropped',decided_by=current_viewer(),decided_at=clock_timestamp() where id=p_action;
  return jsonb_build_object('state','dropped');
 end if;
 v_kind := case when p->>'kind' in ('task','bug') then p->>'kind' else a.kind end;
 v_title := left(btrim(coalesce(nullif(btrim(p->>'title'),''),a.title)),300);
 if v_kind='bug' then
  select r.id, r.number, r.task_id into b from reported_bug r
   where r.org_id=current_org() and r.id::text=coalesce(p->>'bugId','') and r.person_id=current_viewer();
  if not found then raise exception 'File the bug report first' using errcode='22023'; end if;
  update meeting_action set state='confirmed',kind='bug',bug_id=b.id,task_id=b.task_id,title=v_title,decided_by=current_viewer(),decided_at=clock_timestamp() where id=p_action;
  return jsonb_strip_nulls(jsonb_build_object('state','confirmed','bugId',b.id,'bugNumber',b.number,'taskId',b.task_id));
 end if;
 v_who := coalesce(case when p ? 'assigneeId' then (select id from person where org_id=current_org() and side='staff' and id::text=p->>'assigneeId') else a.assignee_id end,current_viewer());
 v_due := case when p ? 'dueOn' then case when p->>'dueOn' ~ '^\d{4}-\d{2}-\d{2}$' then (p->>'dueOn')::date end else a.due_on end;
 v_note := 'From the meeting “'||m.title||'” on '||coalesce(to_char(m.held_on,'DD Mon YYYY'),to_char(m.started_at at time zone org_time_zone(),'DD Mon YYYY'))||'.'
  ||coalesce(E'\nOn the page: '||a.route,'');
 begin
  tid := task_save(null,jsonb_strip_nulls(jsonb_build_object('title',v_title,'assigneeId',v_who,'projectId',m.project_id,'dueOn',v_due,'notes',v_note)));
 exception when insufficient_privilege then
  -- The person confirming may not give that colleague tasks (Settings → Who can do what): the task is theirs, and says
  -- whom the meeting named, so they hand it over or ask; nothing is assigned past the company's rules.
  v_ask := (select display_name from person where id=v_who); v_who := current_viewer();
  tid := task_save(null,jsonb_strip_nulls(jsonb_build_object('title',v_title,'assigneeId',v_who,'projectId',m.project_id,'dueOn',v_due,
   'notes',v_note||E'\n\nThe meeting named '||v_ask||'. Your role does not give them tasks: ask them, or their lead, to take it.')));
 end;
 update meeting_action set state='confirmed',kind='task',task_id=tid,title=v_title,assignee_id=v_who,due_on=v_due,decided_by=current_viewer(),decided_at=clock_timestamp() where id=p_action;
 return jsonb_strip_nulls(jsonb_build_object('state','confirmed','taskId',tid,'askNeeded',v_ask));
end $$;

-- Delete: the person who recorded it, or an admin. The audio, transcript, its lines and drafts go; confirmed tasks stay.
create or replace function pulse.meeting_remove(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m meeting;
begin
 select * into m from meeting where org_id=current_org() and id=p_id for update;
 if not found or not meeting_can(p_id) then raise exception 'meeting unavailable' using errcode='42501'; end if;
 if m.started_by<>current_viewer() and not viewer_is('admin') then raise exception 'Only the person who recorded it, or an admin, deletes a meeting' using errcode='42501'; end if;
 delete from pulse_priv.meeting_part where org_id=current_org() and meeting_id=p_id;
 delete from meeting_action where org_id=current_org() and meeting_id=p_id and state='draft';
 delete from meeting_line where org_id=current_org() and meeting_id=p_id;   -- before the row is 'removed' (its lines' policy reads it)
 update meeting set state='removed',removed_by=current_viewer(),removed_at=clock_timestamp(),transcript=null,segments=null,summary=null,transcript_state='off',bytes=0,parts=0 where id=p_id;
end $$;

-- One meeting as the viewer sees it (null when they may not), with its lines.
create or replace function pulse.meeting_view(p_id uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',m.id,'title',m.title,'kind',m.kind,'state',m.state,'mime',m.mime,'seconds',m.seconds,'bytes',m.bytes,'startedAt',m.started_at,'stoppedAt',m.stopped_at,
  'by',m.started_by,'byName',(select display_name from person where id=m.started_by),'mine',m.started_by=current_viewer(),
  'canRemove',m.started_by=current_viewer() or viewer_is('admin'),
  'canEdit',m.started_by=current_viewer() or viewer_is('admin') or coalesce(work_role(),'')='leadership',
  'source',m.source,'sourceFormat',m.source_format,'sourceName',m.source_name,'purpose',m.purpose,'summary',m.summary,'speakers',to_jsonb(m.speakers),'heldOn',m.held_on,
  'project',(select jsonb_build_object('id',p.id,'name',coalesce(p.title,p.name)) from project p where p.org_id=m.org_id and p.id=m.project_id),
  'client',(select jsonb_build_object('id',c.id,'name',c.display_name) from client c where c.org_id=m.org_id and c.id=m.client_id),
  'attendees',(select coalesce(jsonb_agg(jsonb_build_object('id',pe.id,'name',pe.display_name) order by pe.display_name),'[]') from person pe where pe.org_id=m.org_id and pe.id=any(m.attendees)),
  'consent',case when m.consent_at is not null then jsonb_build_object('at',m.consent_at,'by',(select display_name from person where id=m.consent_by),'text',m.consent_text) end,
  'transcriptState',m.transcript_state,'transcript',m.transcript,'segments',m.segments,'language',m.language,'actionsState',m.actions_state,
  'lines',(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('n',l.n,'speaker',l.speaker,'at',l.at_s,'text',l.words)) order by l.n),'[]') from meeting_line l where l.meeting_id=m.id),
  'actions',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'title',a.title,'quote',a.quote,'assigneeId',a.assignee_id,
     'assignee',(select display_name from person where id=a.assignee_id),'dueOn',a.due_on,'state',a.state,'taskId',a.task_id,
     'kind',a.kind,'route',a.route,'lineNo',a.line_no,'bugId',a.bug_id,'bugNumber',(select r.number from reported_bug r where r.id=a.bug_id)) order by a.position),'[]')
   from meeting_action a where a.org_id=m.org_id and a.meeting_id=m.id))
 from meeting m where m.org_id=current_org() and m.id=p_id and meeting_can(p_id)
$$;

-- The viewer's meetings, newest first.
create or replace function pulse.meeting_list() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(x order by x->>'startedAt' desc),'[]') from (
  select jsonb_build_object('id',m.id,'title',m.title,'kind',m.kind,'state',m.state,'seconds',m.seconds,'startedAt',m.started_at,'byName',(select display_name from person where id=m.started_by),
   'project',(select coalesce(p.title,p.name) from project p where p.org_id=m.org_id and p.id=m.project_id),
   'client',(select c.display_name from client c where c.org_id=m.org_id and c.id=m.client_id),
   'transcriptState',m.transcript_state,'source',m.source,'purpose',m.purpose,'heldOn',m.held_on,'summary',left(m.summary,240),
   'lines',(select count(*) from meeting_line l where l.meeting_id=m.id),
   'drafts',(select count(*) from meeting_action a where a.meeting_id=m.id and a.state='draft'),
   'tasks',(select count(*) from meeting_action a where a.meeting_id=m.id and a.state='confirmed')) x
  from meeting m where m.org_id=current_org() and m.state<>'removed' and meeting_can(m.id)
  order by m.started_at desc limit 100) s
$$;

-- Search every transcript line the viewer may read (row security on meeting_line keeps it to their meetings).
create function pulse.meeting_search(p_q text) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare q text := left(btrim(coalesce(p_q,'')),120); tq tsquery;
begin
 if length(q) < 2 then return '[]'::jsonb; end if;
 tq := websearch_to_tsquery('simple', q);
 return (select coalesce(jsonb_agg(r order by (r->>'rank')::float8 desc, r->>'startedAt' desc, (r->>'n')::int),'[]') from (
  select jsonb_strip_nulls(jsonb_build_object('meetingId',m.id,'title',m.title,'startedAt',m.started_at,'heldOn',m.held_on,'purpose',m.purpose,
   'n',l.n,'speaker',l.speaker,'at',l.at_s,'text',left(l.words,400),'rank',ts_rank(l.search, tq))) r
  from meeting_line l join meeting m on m.org_id=l.org_id and m.id=l.meeting_id and m.state<>'removed'
  where l.org_id=current_org() and (l.search @@ tq or l.words ilike '%'||replace(replace(replace(q,'\','\\'),'%','\%'),'_','\_')||'%')
  order by ts_rank(l.search, tq) desc, m.started_at desc, l.n limit 60) s);
end $$;

-- The meeting a task was made from (the task page links back to its line), when the viewer may see that meeting.
create function pulse.meeting_for_task(p_task uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_strip_nulls(jsonb_build_object('id',m.id,'title',m.title,'purpose',m.purpose,'line',a.line_no,'kind',a.kind,'bugNumber',(select r.number from reported_bug r where r.id=a.bug_id)))
 from meeting_action a join meeting m on m.org_id=a.org_id and m.id=a.meeting_id
 where a.org_id=current_org() and a.task_id=p_task and a.state='confirmed' and meeting_can(m.id)
 order by a.decided_at desc limit 1
$$;

revoke all on function pulse.meeting_lines_set(uuid,jsonb,text,text[]), pulse.meeting_import(jsonb), pulse.meeting_search(text), pulse.meeting_for_task(uuid) from public;
grant execute on function pulse.meeting_lines_set(uuid,jsonb,text,text[]), pulse.meeting_import(jsonb), pulse.meeting_search(text), pulse.meeting_for_task(uuid) to pulse_api;

-- migrate:down
-- Forward-only: meetings, their transcripts' lines and the tasks made from them are kept.
