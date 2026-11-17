-- migrate:up
-- KAZUK-REST slice 7 (6 Nov 2026): training courses for the team and for dealers / channel partners (Learn → Training).
-- Learn Pulse's tutorials are about Pulse itself and live in code; a company's own training lives here:
--   pulse.training_course       a course (draft, published, archived) with a pass mark for its quiz
--   pulse.training_video        its videos, in order: a link (YouTube, Vimeo, Drive or any https page) or an uploaded clip
--   pulse.training_video_file   an uploaded clip's bytes (up to 25 MB; longer videos are linked)
--   pulse.training_question     the quiz's multiple-choice questions (2 to 6 choices) and the right choice
--   pulse.training_assignment   who must take it: one person, everyone on a side (staff, channel partners/dealers,
--                               freelancers …) or everyone holding a work role (member, team head, HR, leadership)
--   pulse.training_progress     how much of each video a person watched (the highest %, watched at 90 %)
--   pulse.training_attempt      every quiz attempt, scored in the database
-- Every table has forced row security with the tenant policy, and pulse_api has no grant on any of them: every read and
-- write goes through the functions below, which decide who may do what. Course managers (training_manager) are the
-- company's admins, leadership and HR. A learner reads only the published courses assigned to them (never the right
-- answers), and keeps only their own progress and attempts.

create function pulse.training_manager() returns boolean
language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and not viewer_outside_seat() and viewer_is('admin', 'leadership', 'hr')
$$;

create table pulse.training_course (
  org_id      uuid not null references pulse.org(id),
  id          uuid not null default gen_random_uuid(),
  title       text not null check (length(btrim(title)) between 1 and 160 and title !~ '[[:cntrl:]]'),
  summary     text not null default '' check (length(summary) <= 2000),
  pass_mark   int not null default 70 check (pass_mark between 1 and 100),
  status      text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_by  uuid references pulse.person(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (org_id, id)
);

create table pulse.training_video (
  org_id      uuid not null references pulse.org(id),
  id          uuid not null default gen_random_uuid(),
  course_id   uuid not null,
  position    int not null default 0,
  title       text not null check (length(btrim(title)) between 1 and 160 and title !~ '[[:cntrl:]]'),
  kind        text not null check (kind in ('link', 'upload')),
  url         text check (url is null or (url ~ '^https://[^/@[:space:]]+(/[^[:space:]]*)?$' and length(url) <= 500)),
  provider    text not null default 'web' check (provider in ('youtube', 'vimeo', 'drive', 'web', 'upload')),
  minutes     int check (minutes between 1 and 600),
  created_at  timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, course_id) references pulse.training_course(org_id, id) on delete cascade,
  check ((kind = 'link') = (url is not null))
);
create index training_video_course on pulse.training_video(org_id, course_id, position);

create table pulse.training_video_file (
  org_id      uuid not null references pulse.org(id),
  video_id    uuid not null,
  name        text not null check (length(name) between 1 and 200),
  mime        text not null check (mime in ('video/mp4', 'video/webm', 'video/quicktime')),
  size        int not null check (size between 1 and 26214400),
  bytes       bytea not null,
  created_at  timestamptz not null default now(),
  primary key (org_id, video_id),
  foreign key (org_id, video_id) references pulse.training_video(org_id, id) on delete cascade
);

create table pulse.training_question (
  org_id      uuid not null references pulse.org(id),
  id          uuid not null default gen_random_uuid(),
  course_id   uuid not null,
  position    int not null,
  prompt      text not null check (length(btrim(prompt)) between 1 and 500),
  options     text[] not null check (cardinality(options) between 2 and 6),
  answer      int not null check (answer >= 0 and answer < cardinality(options)),
  primary key (org_id, id),
  foreign key (org_id, course_id) references pulse.training_course(org_id, id) on delete cascade
);
create index training_question_course on pulse.training_question(org_id, course_id, position);

create table pulse.training_assignment (
  org_id      uuid not null references pulse.org(id),
  id          uuid not null default gen_random_uuid(),
  course_id   uuid not null,
  target_kind text not null check (target_kind in ('person', 'side', 'role')),
  person_id   uuid references pulse.person(id) on delete cascade,
  target      text,
  due_on      date,
  assigned_by uuid references pulse.person(id),
  created_at  timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, course_id) references pulse.training_course(org_id, id) on delete cascade,
  check ((target_kind = 'person') = (person_id is not null) and (target_kind = 'person') = (target is null)),
  check (target_kind <> 'side' or target in ('staff', 'freelancer', 'channel_partner', 'vendor', 'talent', 'other')),
  check (target_kind <> 'role' or target in ('member', 'pod_head', 'hr', 'leadership'))
);
create unique index training_assignment_one on pulse.training_assignment(org_id, course_id, target_kind, coalesce(person_id::text, target));

create table pulse.training_progress (
  org_id       uuid not null references pulse.org(id),
  person_id    uuid not null references pulse.person(id) on delete cascade,
  video_id     uuid not null,
  percent      int not null check (percent between 0 and 100),
  completed_at timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (org_id, person_id, video_id),
  foreign key (org_id, video_id) references pulse.training_video(org_id, id) on delete cascade
);

create table pulse.training_attempt (
  org_id      uuid not null references pulse.org(id),
  id          uuid not null default gen_random_uuid(),
  course_id   uuid not null,
  person_id   uuid not null references pulse.person(id) on delete cascade,
  answers     int[] not null,
  score       int not null check (score between 0 and 100),
  passed      boolean not null,
  created_at  timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, course_id) references pulse.training_course(org_id, id) on delete cascade
);
create index training_attempt_person on pulse.training_attempt(org_id, course_id, person_id, created_at desc);

do $$ declare t text; begin
  foreach t in array array['training_course', 'training_video', 'training_video_file', 'training_question', 'training_assignment',
    'training_progress', 'training_attempt'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  end loop;
end $$;
-- No table grants to pulse_api: the functions below are the only way in.

-- Is this published course assigned to this person (directly, by their side, or by their work role)?
create function pulse.training_assigned(p_course uuid, p_person uuid) returns boolean
language sql stable security definer set search_path = pulse, pg_temp as $$
  select p_person is not null and exists(
    select 1 from training_course c join person p on p.org_id = c.org_id and p.id = p_person and p.status = 'active'
    where c.org_id = current_org() and c.id = p_course and c.status = 'published' and exists(
      select 1 from training_assignment a where a.org_id = c.org_id and a.course_id = c.id and (
        (a.target_kind = 'person' and a.person_id = p.id)
        or (a.target_kind = 'side' and a.target = p.side)
        or (a.target_kind = 'role' and p.side = 'staff' and a.target = work_role(p.id)))))
$$;

-- One person's standing in one course: videos watched (90 % counts), the quiz (best score, passed) and done.
create function pulse.training_standing(p_course uuid, p_person uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
  with v as (select v.id, coalesce(g.percent, 0) pct, g.updated_at seen from training_video v
      left join training_progress g on g.org_id = v.org_id and g.video_id = v.id and g.person_id = p_person
      where v.org_id = current_org() and v.course_id = p_course),
    q as (select count(*) n from training_question where org_id = current_org() and course_id = p_course),
    a as (select max(score) best, coalesce(bool_or(passed), false) passed, count(*) tries, max(created_at) last_at from training_attempt
      where org_id = current_org() and course_id = p_course and person_id = p_person)
  select jsonb_build_object(
    'videos', (select count(*) from v), 'watched', (select count(*) from v where pct >= 90),
    'percent', (select coalesce(round(avg(case when pct >= 90 then 100 else pct end))::int, 0) from v),
    'questions', (select n from q), 'best', (select best from a), 'tries', (select tries from a), 'passed', (select passed from a),
    'done', (select count(*) from v where pct < 90) = 0 and ((select n from q) = 0 or (select passed from a))
      and ((select count(*) from v) > 0 or (select n from q) > 0),
    'lastAt', greatest((select last_at from a), (select max(seen) from v)))
$$;

create function pulse.training_course_row(p_course uuid) returns pulse.training_course
language sql stable security definer set search_path = pulse, pg_temp as $$
  select * from training_course where org_id = current_org() and id = p_course
$$;

create function pulse.training_must_manage() returns void
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if not training_manager() then raise exception 'Training courses are managed by admins, leadership and HR' using errcode = '42501'; end if;
end $$;

-- The viewer's training: published courses assigned to them, with their standing and the earliest due day.
create function pulse.training_mine() returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer();
begin
  if me is null then raise exception 'Sign in to see your training' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'summary', c.summary, 'passMark', c.pass_mark,
      'dueOn', (select min(a.due_on)::text from training_assignment a where a.org_id = c.org_id and a.course_id = c.id),
      'standing', training_standing(c.id, me)) order by c.title), '[]')
    from training_course c where c.org_id = current_org() and training_assigned(c.id, me));
end $$;

-- Who must take a course (every assignment expanded to active people) and where each stands.
create function pulse.training_people(p_course uuid) returns table(id uuid, name text, side text)
language sql stable security definer set search_path = pulse, pg_temp as $$
  select p.id, p.display_name, p.side from person p where p.org_id = current_org() and p.status = 'active' and p.side <> 'agent' and exists(
    select 1 from training_assignment a where a.org_id = p.org_id and a.course_id = p_course and (
      (a.target_kind = 'person' and a.person_id = p.id) or (a.target_kind = 'side' and a.target = p.side)
      or (a.target_kind = 'role' and p.side = 'staff' and a.target = work_role(p.id))))
$$;

create function pulse.training_report(p_course uuid) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  perform training_must_manage();
  if (training_course_row(p_course)).id is null then raise exception 'Course not found' using errcode = 'P0002'; end if;
  return (select coalesce(jsonb_agg(x order by (x -> 'standing' ->> 'done')::boolean, x ->> 'name'), '[]') from (
    select jsonb_build_object('id', p.id, 'name', p.name, 'side', p.side, 'standing', training_standing(p_course, p.id)) x from training_people(p_course) p) s);
end $$;

-- Every course, for managers: its videos, questions, people assigned and how many are done.
create function pulse.training_courses() returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  perform training_must_manage();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'status', c.status, 'passMark', c.pass_mark, 'updatedAt', c.updated_at,
      'videos', (select count(*) from training_video v where v.org_id = c.org_id and v.course_id = c.id),
      'questions', (select count(*) from training_question q where q.org_id = c.org_id and q.course_id = c.id),
      'people', (select count(*) from training_people(c.id)),
      'done', (select count(*) from training_people(c.id) p where (training_standing(c.id, p.id) ->> 'done')::boolean)) order by c.status = 'archived', c.updated_at desc), '[]')
    from training_course c where c.org_id = current_org());
end $$;

-- One course: for a manager everything (answers and assignments included); for an assigned learner the published course,
-- its videos and questions without answers, and their own standing.
create function pulse.training_course_get(p_course uuid) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); mgr boolean := training_manager(); c training_course;
begin
  c := training_course_row(p_course);
  if c.id is null or not (mgr or training_assigned(p_course, me)) then raise exception 'Course not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', c.id, 'title', c.title, 'summary', c.summary, 'passMark', c.pass_mark, 'status', c.status, 'manage', mgr,
    'videos', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'title', v.title, 'kind', v.kind, 'url', v.url, 'provider', v.provider, 'minutes', v.minutes,
        'mime', f.mime, 'size', f.size, 'percent', coalesce(g.percent, 0)) order by v.position, v.created_at), '[]')
      from training_video v left join training_video_file f on f.org_id = v.org_id and f.video_id = v.id
      left join training_progress g on g.org_id = v.org_id and g.video_id = v.id and g.person_id = me
      where v.org_id = c.org_id and v.course_id = c.id),
    'questions', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'prompt', q.prompt, 'options', to_jsonb(q.options))
        || case when mgr then jsonb_build_object('answer', q.answer) else '{}' end order by q.position), '[]')
      from training_question q where q.org_id = c.org_id and q.course_id = c.id),
    'assignments', case when mgr then (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.target_kind, 'personId', a.person_id, 'name', p.display_name,
        'target', a.target, 'dueOn', a.due_on::text) order by a.created_at), '[]')
      from training_assignment a left join person p on p.org_id = a.org_id and p.id = a.person_id where a.org_id = c.org_id and a.course_id = c.id) end,
    -- the people a manager may assign it to (active, not AI employees), with their side
    'people', case when mgr then (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'side', p.side) order by p.display_name), '[]')
      from (select * from person p where p.org_id = c.org_id and p.status = 'active' and p.side <> 'agent' order by p.display_name limit 1000) p) end,
    'assigned', training_assigned(c.id, me),
    'standing', case when training_assigned(c.id, me) then training_standing(c.id, me) end);
end $$;

-- Make or change a course (a manager).
create function pulse.training_course_save(p_course uuid, p_title text, p_summary text, p_pass_mark int, p_status text) returns uuid
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out uuid;
begin
  perform training_must_manage();
  if p_course is null then
    insert into training_course(org_id, title, summary, pass_mark, status, created_by)
    values (current_org(), btrim(p_title), coalesce(p_summary, ''), coalesce(p_pass_mark, 70), coalesce(p_status, 'draft'), current_viewer()) returning id into out;
  else
    update training_course set title = btrim(p_title), summary = coalesce(p_summary, ''), pass_mark = coalesce(p_pass_mark, pass_mark),
      status = coalesce(p_status, status), updated_at = now() where org_id = current_org() and id = p_course returning id into out;
    if out is null then raise exception 'Course not found' using errcode = 'P0002'; end if;
  end if;
  return out;
end $$;

-- Add a video: a link (p_url, its provider decided by the API) or an uploaded clip (p_file_*).
create function pulse.training_video_add(p_course uuid, p_title text, p_url text, p_provider text, p_minutes int,
  p_file_name text default null, p_file_mime text default null, p_file bytea default null) returns uuid
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare vid uuid; pos int;
begin
  perform training_must_manage();
  if (training_course_row(p_course)).id is null then raise exception 'Course not found' using errcode = 'P0002'; end if;
  if (p_url is null) = (p_file is null) then raise exception 'Give a link or upload a video' using errcode = '22023'; end if;
  if (select count(*) from training_video where org_id = current_org() and course_id = p_course) >= 30 then
    raise exception 'A course has up to 30 videos' using errcode = '22023'; end if;
  select coalesce(max(position) + 1, 0) into pos from training_video where org_id = current_org() and course_id = p_course;
  insert into training_video(org_id, course_id, position, title, kind, url, provider, minutes)
  values (current_org(), p_course, pos, btrim(p_title), case when p_file is null then 'link' else 'upload' end, p_url,
    case when p_file is null then coalesce(p_provider, 'web') else 'upload' end, p_minutes) returning id into vid;
  if p_file is not null then
    insert into training_video_file(org_id, video_id, name, mime, size, bytes) values (current_org(), vid, p_file_name, p_file_mime, octet_length(p_file), p_file);
  end if;
  update training_course set updated_at = now() where org_id = current_org() and id = p_course;
  return vid;
end $$;

create function pulse.training_video_remove(p_video uuid) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform training_must_manage();
  delete from training_video where org_id = current_org() and id = p_video;
  if not found then raise exception 'Video not found' using errcode = 'P0002'; end if;
end $$;

-- An uploaded clip, for a manager or a person the course is assigned to.
create function pulse.training_video_file_read(p_video uuid) returns table(name text, mime text, size int, bytes bytea)
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare course uuid;
begin
  select v.course_id into course from training_video v where v.org_id = current_org() and v.id = p_video;
  if course is null or not (training_manager() or training_assigned(course, current_viewer())) then raise exception 'Video not found' using errcode = 'P0002'; end if;
  return query select f.name, f.mime, f.size, f.bytes from training_video_file f where f.org_id = current_org() and f.video_id = p_video;
end $$;

-- Assign a course to one person, a side (e.g. channel partners) or a work role; and take an assignment back.
create function pulse.training_assign(p_course uuid, p_kind text, p_person uuid, p_target text, p_due date) returns uuid
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out uuid;
begin
  perform training_must_manage();
  if (training_course_row(p_course)).id is null then raise exception 'Course not found' using errcode = 'P0002'; end if;
  if p_kind = 'person' and not exists(select 1 from person where org_id = current_org() and id = p_person and status = 'active' and side <> 'agent') then
    raise exception 'Person not found' using errcode = 'P0002'; end if;
  insert into training_assignment(org_id, course_id, target_kind, person_id, target, due_on, assigned_by)
  values (current_org(), p_course, p_kind, case when p_kind = 'person' then p_person end, case when p_kind <> 'person' then p_target end, p_due, current_viewer())
  on conflict (org_id, course_id, target_kind, coalesce(person_id::text, target)) do update set due_on = excluded.due_on
  returning id into out;
  return out;
end $$;

create function pulse.training_unassign(p_assignment uuid) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform training_must_manage();
  delete from training_assignment where org_id = current_org() and id = p_assignment;
  if not found then raise exception 'Assignment not found' using errcode = 'P0002'; end if;
end $$;

-- A learner watched part of a video: the highest share is kept; 90 % or more counts as watched.
create function pulse.training_video_seen(p_video uuid, p_percent int) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); course uuid; kept int;
begin
  if me is null then raise exception 'Sign in to keep your progress' using errcode = '42501'; end if;
  if p_percent is null or p_percent not between 0 and 100 then raise exception 'Give a share from 0 to 100' using errcode = '22023'; end if;
  select course_id into course from training_video where org_id = current_org() and id = p_video;
  if course is null or not training_assigned(course, me) then raise exception 'This video is not in your training' using errcode = '42501'; end if;
  insert into training_progress(org_id, person_id, video_id, percent, completed_at) values (current_org(), me, p_video, p_percent, case when p_percent >= 90 then now() end)
  on conflict (org_id, person_id, video_id) do update set percent = greatest(training_progress.percent, excluded.percent),
    completed_at = coalesce(training_progress.completed_at, excluded.completed_at), updated_at = now()
  returning percent into kept;
  return jsonb_build_object('percent', kept, 'standing', training_standing(course, me));
end $$;

-- A learner answers the quiz: one choice per question, in order. Scored here; the right answers never leave the database.
create function pulse.training_attempt(p_course uuid, p_answers int[]) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); n int; right_n int; mark int; pct int; wrong int[];
begin
  if me is null or not training_assigned(p_course, me) then raise exception 'This course is not in your training' using errcode = '42501'; end if;
  select count(*) into n from training_question where org_id = current_org() and course_id = p_course;
  if n = 0 then raise exception 'This course has no quiz' using errcode = '22023'; end if;
  if p_answers is null or cardinality(p_answers) <> n or array_position(p_answers, null) is not null then
    raise exception 'Answer every question' using errcode = '22023'; end if;
  if (select count(*) from training_attempt where org_id = current_org() and course_id = p_course and person_id = me and created_at > now() - interval '1 minute') >= 5 then
    raise exception 'Too many tries: wait a minute' using errcode = '54000'; end if;
  with q as (select qq.answer, row_number() over (order by qq.position, qq.id)::int i from training_question qq where qq.org_id = current_org() and qq.course_id = p_course)
  select count(*) filter (where q.answer = p_answers[q.i]), coalesce(array_agg(q.i order by q.i) filter (where q.answer <> p_answers[q.i]), '{}')
    into right_n, wrong from q;
  mark := (training_course_row(p_course)).pass_mark;
  pct := round(100.0 * right_n / n);
  insert into training_attempt(org_id, course_id, person_id, answers, score, passed) values (current_org(), p_course, me, p_answers, pct, pct >= mark);
  return jsonb_build_object('score', pct, 'passed', pct >= mark, 'passMark', mark, 'right', right_n, 'questions', n, 'wrong', to_jsonb(wrong),
    'standing', training_standing(p_course, me));
end $$;

-- The quiz, replaced as a whole by a manager: [{prompt, options[], answer}] (answer: the right option's index from 0).
create function pulse.training_quiz_set(p_course uuid, p_questions jsonb) returns int
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare q jsonb; i int := 0; opts text[];
begin
  perform training_must_manage();
  if (training_course_row(p_course)).id is null then raise exception 'Course not found' using errcode = 'P0002'; end if;
  if jsonb_typeof(p_questions) is distinct from 'array' or jsonb_array_length(p_questions) > 20 then raise exception 'A quiz has up to 20 questions' using errcode = '22023'; end if;
  delete from training_question where org_id = current_org() and course_id = p_course;
  for q in select * from jsonb_array_elements(p_questions) loop
    if jsonb_typeof(q -> 'options') is distinct from 'array' then raise exception 'Each question needs 2 to 6 choices' using errcode = '22023'; end if;
    select array_agg(btrim(o)) into opts from jsonb_array_elements_text(q -> 'options') o where btrim(o) <> '';
    if coalesce(cardinality(opts), 0) not between 2 and 6 then raise exception 'Each question needs 2 to 6 choices' using errcode = '22023'; end if;
    if jsonb_typeof(q -> 'answer') is distinct from 'number' or (q ->> 'answer')::numeric not between 0 and cardinality(opts) - 1 then
      raise exception 'Mark the right choice for every question' using errcode = '22023'; end if;
    if length(btrim(coalesce(q ->> 'prompt', ''))) not between 1 and 500 then raise exception 'Write each question' using errcode = '22023'; end if;
    insert into training_question(org_id, course_id, position, prompt, options, answer) values (current_org(), p_course, i, btrim(q ->> 'prompt'), opts, (q ->> 'answer')::int);
    i := i + 1;
  end loop;
  update training_course set updated_at = now() where org_id = current_org() and id = p_course;
  return i;
end $$;

-- training_standing, training_people, training_course_row and training_must_manage are only called by the functions here.
revoke all on function pulse.training_manager(), pulse.training_assigned(uuid, uuid), pulse.training_standing(uuid, uuid), pulse.training_course_row(uuid),
  pulse.training_must_manage(), pulse.training_mine(), pulse.training_people(uuid), pulse.training_report(uuid), pulse.training_courses(),
  pulse.training_course_get(uuid), pulse.training_course_save(uuid, text, text, int, text), pulse.training_video_add(uuid, text, text, text, int, text, text, bytea),
  pulse.training_video_remove(uuid), pulse.training_video_file_read(uuid), pulse.training_assign(uuid, text, uuid, text, date), pulse.training_unassign(uuid),
  pulse.training_video_seen(uuid, int), pulse.training_attempt(uuid, int[]), pulse.training_quiz_set(uuid, jsonb) from public;
grant execute on function pulse.training_manager(), pulse.training_mine(), pulse.training_report(uuid), pulse.training_courses(),
  pulse.training_course_get(uuid), pulse.training_course_save(uuid, text, text, int, text), pulse.training_video_add(uuid, text, text, text, int, text, text, bytea),
  pulse.training_video_remove(uuid), pulse.training_video_file_read(uuid), pulse.training_assign(uuid, text, uuid, text, date), pulse.training_unassign(uuid),
  pulse.training_video_seen(uuid, int), pulse.training_attempt(uuid, int[]), pulse.training_quiz_set(uuid, jsonb) to pulse_api;

-- migrate:down
-- Forward-only: courses, uploaded clips, progress and quiz attempts people made are kept.
