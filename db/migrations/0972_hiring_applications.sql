-- migrate:up
-- READY (EA AI team lane, 23 Oct 2026; product gap): Hiring had internal jobs (0370, R49) and candidates (0157,
-- LIFECYCLE: a person at stage candidate or offer) but nothing joined them, and there was no interview stage: the AI team
-- made a plain task "Interview Ruvin Durineho (test) for Video Editor (test)" by hand. A job now lists the candidates
-- linked to it, each with a hiring stage (applied → interview → offer → hired, or rejected / withdrawn); the interview
-- stage carries when, who interviews and where, and keeps one task for the interviewer due at that time.
-- HR and admins only (lifecycle_hr, 0157), through four functions; the API never reads the table directly.
-- Uses only functions defined in repo migrations: lifecycle_hr (0157), task_save (0153), current_org/current_viewer.

create table pulse.hiring_application (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 job_id uuid not null references pulse.ats_job(id),
 person_id uuid not null references pulse.person(id),
 stage text not null default 'applied' check (stage in ('applied', 'interview', 'offer', 'hired', 'rejected', 'withdrawn')),
 interview_at timestamptz,
 interviewer_id uuid references pulse.person(id),
 interview_place text check (length(interview_place) <= 200),
 interview_task_id uuid references pulse.task(id),
 note text check (length(note) <= 1000),
 created_by uuid references pulse.person(id),
 created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id),
 updated_at timestamptz not null default now(),
 unique (org_id, job_id, person_id),
 check (stage <> 'interview' or interview_at is not null)
);
alter table pulse.hiring_application enable row level security;
alter table pulse.hiring_application force row level security;
create policy tenant on pulse.hiring_application using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select, insert, update on pulse.hiring_application to pulse_worker;
create trigger audit_mutation after insert or update on pulse.hiring_application for each row execute function pulse.audit_mutation();

/** A job's candidates and stages, and the candidates (stage candidate or offer) not linked to it yet. */
create function pulse.hiring_list(p_job uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if not lifecycle_hr() then raise exception 'Hiring is for HR and admins' using errcode = '42501'; end if;
 if not exists (select 1 from ats_job where org_id = current_org() and id = p_job) then raise exception 'Job not found' using errcode = 'P0002'; end if;
 return jsonb_build_object(
  'applications', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'personId', a.person_id, 'name', p.display_name, 'role', pp.role,
     'stage', a.stage, 'interviewAt', a.interview_at, 'interviewerId', a.interviewer_id, 'interviewer', ip.display_name, 'place', a.interview_place,
     'taskId', a.interview_task_id, 'note', a.note, 'updatedAt', a.updated_at) order by array_position(array['interview', 'offer', 'applied', 'hired', 'rejected', 'withdrawn'], a.stage), a.interview_at nulls last, p.display_name)
   from hiring_application a join person p on p.id = a.person_id left join people_profile pp on pp.person_id = a.person_id left join person ip on ip.id = a.interviewer_id
   where a.org_id = current_org() and a.job_id = p_job), '[]'::jsonb),
  'pool', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'role', pp.role, 'stage', l.stage) order by p.display_name)
   from person_lifecycle l join person p on p.id = l.person_id left join people_profile pp on pp.person_id = p.id
   where l.org_id = current_org() and l.stage in ('candidate', 'offer')
     and not exists (select 1 from hiring_application a where a.org_id = current_org() and a.job_id = p_job and a.person_id = p.id)), '[]'::jsonb),
  'interviewers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by p.display_name)
   from person p where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'), '[]'::jsonb));
end $$;

/** Link a candidate to a job (applied). Linking twice is the same link. */
create function pulse.hiring_link(p_job uuid, p_person uuid) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare aid uuid;
begin
 if not lifecycle_hr() then raise exception 'Hiring is for HR and admins' using errcode = '42501'; end if;
 if not exists (select 1 from ats_job where org_id = current_org() and id = p_job) then raise exception 'Job not found' using errcode = 'P0002'; end if;
 if not exists (select 1 from person_lifecycle where org_id = current_org() and person_id = p_person and stage in ('candidate', 'offer')) then
  raise exception 'Link a candidate (add them under HR → People moves first)' using errcode = '22023';
 end if;
 insert into hiring_application(org_id, job_id, person_id, created_by, updated_by) values (current_org(), p_job, p_person, current_viewer(), current_viewer())
  on conflict (org_id, job_id, person_id) do update set updated_at = now() returning id into aid;
 return aid;
end $$;

/** Move an application: {stage, interviewAt, interviewerId, place, note}. The interview stage needs a time; it keeps one
 *  task "Interview <name> for <job>" for the interviewer, due then (moved when the time changes). */
create function pulse.hiring_update(p_id uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a hiring_application; s text; at timestamptz; who uuid; place text; nm text; job text; tid uuid; body jsonb;
begin
 if not lifecycle_hr() then raise exception 'Hiring is for HR and admins' using errcode = '42501'; end if;
 select * into a from hiring_application where org_id = current_org() and id = p_id for update;
 if not found then raise exception 'Application not found' using errcode = 'P0002'; end if;
 s := coalesce(nullif(p->>'stage', ''), a.stage);
 if s not in ('applied', 'interview', 'offer', 'hired', 'rejected', 'withdrawn') then raise exception 'Choose a stage' using errcode = '22023'; end if;
 at := case when p ? 'interviewAt' then nullif(p->>'interviewAt', '')::timestamptz else a.interview_at end;
 who := case when p ? 'interviewerId' then nullif(p->>'interviewerId', '')::uuid else a.interviewer_id end;
 place := case when p ? 'place' then nullif(btrim(p->>'place'), '') else a.interview_place end;
 if s = 'interview' and at is null then raise exception 'Give the interview a date and time' using errcode = '22023'; end if;
 if who is not null and not exists (select 1 from person where org_id = current_org() and id = who and side = 'staff' and status = 'active') then
  raise exception 'The interviewer must be a current team member' using errcode = '22023';
 end if;
 tid := a.interview_task_id;
 if s = 'interview' then
  select display_name into nm from person where id = a.person_id;
  select title into job from ats_job where id = a.job_id;
  body := jsonb_strip_nulls(jsonb_build_object('title', left('Interview ' || nm || ' for ' || job, 300), 'assigneeId', coalesce(who, current_viewer()),
   'dueAt', at, 'notes', concat_ws(chr(10), 'Hiring: ' || job || '.', case when place is not null then 'Where: ' || place end, '/people/jobs/' || a.job_id)));
  tid := task_save(tid, body);
 end if;
 update hiring_application set stage = s, interview_at = at, interviewer_id = who, interview_place = place, interview_task_id = tid,
  note = case when p ? 'note' then nullif(btrim(p->>'note'), '') else note end, updated_by = current_viewer(), updated_at = now()
  where id = p_id;
 return jsonb_build_object('id', p_id, 'stage', s, 'taskId', tid);
end $$;

revoke all on function pulse.hiring_list(uuid), pulse.hiring_link(uuid, uuid), pulse.hiring_update(uuid, jsonb) from public;
grant execute on function pulse.hiring_list(uuid), pulse.hiring_link(uuid, uuid), pulse.hiring_update(uuid, jsonb) to pulse_api;

-- migrate:down
-- Forward-only.
