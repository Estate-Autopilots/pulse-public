-- migrate:up
-- WORK-SPINE round 2 (owner, 10 Nov 2026: "Goals, projects, tasks … must update live. When the DB changes, open screens
-- update within ~1-2 s with no reload"). A change to a task, its checklist, its people, a late reason, a project or a goal
-- tells every API process at once (NOTIFY pulse_work), the same LISTEN-and-stream pattern as Chats (pulse_chat), calls
-- (pulse_call) and the screen (pulse_ui). The note carries only ids:
--   <org>:<kind>:<project or goal>:<person>:<task>
-- kind t (a task or a part of one: its project, its doer or the person the part is about, and the task), p (a project) or
-- g (a goal). The API matches a note to each open Work page (/api/v0/work/events) and sends the browser only "changed";
-- the page then reads the work again through the usual rules, so a note never shows anyone what they may not see.
-- Identical notes in one transaction are sent once (PostgreSQL folds them), so a bulk change is one note per project.

create or replace function pulse.work_live_note() returns trigger language plpgsql set search_path = pulse, pg_temp as $$
declare j jsonb; k text := tg_argv[0]; ref text; who text; task text;
begin
  if tg_op = 'DELETE' then j := to_jsonb(old); else j := to_jsonb(new); end if;
  if k = 'task' then
    ref := j->>'project_id'; who := j->>'assignee_person_id'; task := j->>'id';
    -- A task that moved to another project or another person also leaves the old ones' pages.
    if tg_op = 'UPDATE' and (old.project_id is distinct from new.project_id or old.assignee_person_id is distinct from new.assignee_person_id) then
      perform pg_notify('pulse_work', concat_ws(':', old.org_id, 't', coalesce(old.project_id::text, ''), coalesce(old.assignee_person_id::text, ''), old.id));
    end if;
  elsif k = 'part' then
    -- task_check, task_member, task_delay: the task's project and doer (the row's own project and person when it has them).
    -- The note is never worth failing the change it follows: an unreadable task gives an empty project (every page of
    -- the organisation that shows tasks looks again).
    task := j->>'task_id';
    begin
      select coalesce(j->>'project_id', t.project_id::text), coalesce(j->>'person_id', t.assignee_person_id::text) into ref, who
        from (select 1) one left join pulse.task t on t.id = (j->>'task_id')::uuid;
    exception when others then ref := j->>'project_id'; who := j->>'person_id';
    end;
  elsif k = 'project' then
    ref := coalesce(j->>'project_id', j->>'id');
  else
    ref := coalesce(j->>'goal_id', j->>'id');
  end if;
  perform pg_notify('pulse_work', concat_ws(':', j->>'org_id', case k when 'task' then 't' when 'part' then 't' when 'project' then 'p' else 'g' end,
    coalesce(ref, ''), coalesce(who, ''), coalesce(task, '')));
  return null;
end $$;

do $$
declare x record;
begin
  for x in select * from (values ('task', 'task'), ('task_check', 'part'), ('task_member', 'part'), ('task_delay', 'part'),
      ('work_project', 'project'), ('project', 'project'), ('goal', 'goal'), ('goal_link', 'goal'), ('goal_value', 'goal')) v(tbl, kind) loop
    execute format('drop trigger if exists work_live on pulse.%I', x.tbl);
    execute format('create trigger work_live after insert or update or delete on pulse.%I for each row execute function pulse.work_live_note(%L)', x.tbl, x.kind);
  end loop;
end $$;

comment on function pulse.work_live_note() is
  'WORK-SPINE: NOTIFY pulse_work <org>:<t|p|g>:<project or goal>:<person>:<task> when the work changes, so open Work pages refetch (/api/v0/work/events).';

-- migrate:down
do $$
declare t text;
begin
  foreach t in array array['task','task_check','task_member','task_delay','work_project','project','goal','goal_link','goal_value'] loop
    execute format('drop trigger if exists work_live on pulse.%I', t);
  end loop;
end $$;
drop function if exists pulse.work_live_note();
