-- migrate:up
-- PROJECTS-STAGES (owner, 4 Nov 2026; Kazuk's 3 Nov meeting, backlog B2-B9): a project is a group of tasks run in
-- stages, with owners at three levels, for every business, not one company.
--  * pulse.project_stage_owner: each stage of a project's delivery plan can have its own owner (the project owner is the
--    project's lead, each task keeps its doer). Owners hear when they are given a stage.
--  * pulse.project_task_stage: a task given in Work (or anywhere) is placed on a stage of its project's plan, so it shows
--    in the project (B9, "I assign a task, but where does it show up?").
--  * pulse.delivery_template_adopt: a company without a delivery template takes a starter for its industry (the starters
--    are pack data in services/api/src/project-starters.ts); the names stay the company's to change.
--  * pulse.task_delay: a project task past its due day asks its doer why (B4) and when it can be done; the answer is kept
--    on the task. The delay rolls up to the project's lead and the stage's owner and stays there until one of them acts
--    (B5): chase the doer, give it a new date, or escalate to someone. A chase that gets no answer comes back in 2 days.
--    A chase asks the doer again (their earlier answer stays on the task's history). The API asks every 10 minutes, not
--    on a page read, and only about work that fell late in the last 7 days, so the first run after a deploy does not
--    send a notice for every month-old overdue task.
--  * Privacy (1455): both tables follow their task or project, and a notice or an escalation goes only to someone who
--    may open the task.
create table pulse.project_stage_owner(
  org_id uuid not null references pulse.org(id),
  project_id uuid not null references pulse.project(id),
  stage int not null check (stage between 0 and 40),
  person_id uuid not null references pulse.person(id),
  set_by uuid references pulse.person(id),
  set_at timestamptz not null default now(),
  primary key (project_id, stage));
create index project_stage_owner_person on pulse.project_stage_owner(org_id, person_id);
alter table pulse.project_stage_owner enable row level security;
alter table pulse.project_stage_owner force row level security;
create policy tenant on pulse.project_stage_owner using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.project_stage_owner to pulse_api;

create table pulse.task_delay(
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references pulse.task(id),
  project_id uuid not null references pulse.project(id),
  due_on date not null,
  person_id uuid not null references pulse.person(id),
  asked_at timestamptz not null default now(),
  reason text check (reason in ('waiting_client','waiting_team','more_work','other_work','away','other')),
  note text check (length(note) <= 300),
  can_by date,
  answered_at timestamptz,
  action text check (action in ('chased','rescheduled','escalated')),
  chases int not null default 0,
  acted_by uuid references pulse.person(id),
  acted_at timestamptz,
  escalated_to uuid references pulse.person(id),
  closed_at timestamptz,
  unique (org_id, task_id, due_on));
create index task_delay_open on pulse.task_delay(org_id, project_id) where closed_at is null;
create index task_delay_person on pulse.task_delay(org_id, person_id) where closed_at is null;
alter table pulse.task_delay enable row level security;
alter table pulse.task_delay force row level security;
create policy tenant on pulse.task_delay using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.task_delay to pulse_api;
-- 1455's rules: a stage owner follows the project, a delay follows its task.
create policy privacy on pulse.project_stage_owner as restrictive for select to pulse_api using (
  case when (select pulse.viewer_outside_seat()) then project_id = any((select pulse.project_mine())::uuid[]) else not (project_id = any((select pulse.project_hidden_ids())::uuid[])) end);
create policy privacy on pulse.task_delay as restrictive for select to pulse_api using (
  case when (select pulse.viewer_outside_seat()) then task_id = any((select pulse.task_mine())::uuid[]) else not (task_id = any((select pulse.task_hidden_ids())::uuid[])) end);

-- Whether a person other than the viewer may open a task or a project by the role, pod and privacy rules. Those rules
-- read the viewer, so they are asked as that person for a moment (as chat_due sends as a message's author, 1005).
create function pulse.sees_as(p_person uuid, p_task uuid, p_project uuid) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare was text := coalesce(current_setting('pulse.viewer_id', true), ''); was_agent text := coalesce(current_setting('pulse.agent_session', true), ''); ok boolean;
begin
  if p_person is null then return false; end if;
  perform set_config('pulse.viewer_id', p_person::text, true);
  perform set_config('pulse.agent_session', '', true);
  ok := (p_task is null or pulse.task_visible(p_task)) and (p_project is null or pulse.project_sees(p_project));
  perform set_config('pulse.viewer_id', was, true);
  perform set_config('pulse.agent_session', was_agent, true);
  return coalesce(ok, false);
end $$;

-- Two notices: task.late (a late task's doer, the project's lead, its stage owners and whoever it was escalated to) and
-- project.stage (a stage's owner). notification_recipient_allowed gets one clause by a checked text patch (as 1066 does).
select pulse.check_values_add('pulse.notification'::regclass, 'notification_event_type_check', 'event_type', array['task.late', 'project.stage']);
create function pulse.project_notice_allowed(p_person uuid, p_type text, p_subject text, p_id uuid) returns boolean
  language sql security definer set search_path = pulse, pg_temp as $$
  select case
    when p_type = 'task.late' then p_subject = 'task' and pulse.sees_as(p_person, p_id, null) and exists(select 1 from pulse.task_delay d join pulse.project p on p.id = d.project_id
      where d.org_id = pulse.current_org() and d.task_id = p_id and (p_person in (d.person_id, d.escalated_to, p.lead_person_id)
        or exists(select 1 from pulse.work_project wp where wp.project_id = p.id and wp.owner_id = p_person)
        or exists(select 1 from pulse.project_stage_owner o where o.project_id = d.project_id and o.person_id = p_person)))
    when p_type = 'project.stage' then p_subject = 'project' and pulse.sees_as(p_person, null, p_id)
      and exists(select 1 from pulse.project_stage_owner o where o.org_id = pulse.current_org() and o.project_id = p_id and o.person_id = p_person)
    else false end
$$;
revoke all on function pulse.project_notice_allowed(uuid, text, text, uuid) from public;
do $$
declare definition text; anchor text;
begin
  definition := pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
  anchor := $r$ if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active') then return false;end if;$r$;
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'migration 1485: notification_recipient_allowed changed shape'; end if;
  execute replace(definition, anchor, anchor || $r$
 -- PROJECTS-STAGES (1485): late project work and stage owners.
 if p_type in ('task.late','project.stage') then return project_notice_allowed(p_person,p_type,p_subject,p_id);end if;$r$);
end $$;

-- A company takes a starter delivery template (stages, packages, categories, steps). Admins and leadership, or whoever
-- runs the project it is being set up for, while the company has none yet: in a small company that is the owner's first
-- project. Once it has one, more templates are admins' and leadership's to add (they show in every lead's plan setup).
create function pulse.delivery_template_adopt(p_key text, p_name text, p_definition jsonb, p_project uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); added int := 0;
begin
  if me is null then raise exception 'Sign in with your own staff account' using errcode = '42501'; end if;
  if not (pulse.viewer_is('admin','leadership') or (p_project is not null and pulse.project_can_run(p_project)
      and not exists(select 1 from pulse.delivery_template where org_id = pulse.current_org()))) then
    raise exception 'Only admins, leadership and a project''s lead choose how projects run' using errcode = '42501'; end if;
  if p_key is null or p_key !~ '^[a-z0-9-]{2,40}$' then raise exception 'Choose a starter' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then raise exception 'Name the template' using errcode = '22023'; end if;
  if p_definition is null or jsonb_typeof(p_definition) <> 'object' or jsonb_typeof(p_definition->'stages') <> 'array' or jsonb_array_length(p_definition->'stages') < 2
    or jsonb_typeof(p_definition->'steps') <> 'array' or jsonb_array_length(p_definition->'steps') < 1 or jsonb_typeof(p_definition->'packages') <> 'array'
    or jsonb_array_length(p_definition->'packages') < 1 or jsonb_typeof(p_definition->'bandwidth') <> 'object' then
    raise exception 'That template is incomplete' using errcode = '22023'; end if;
  insert into pulse.delivery_template(org_id, key, name, definition, updated_by) values (pulse.current_org(), p_key, btrim(p_name), p_definition, me)
    on conflict (org_id, key) do nothing;
  get diagnostics added = row_count;
  if added > 0 then perform pulse.audit_write('delivery_template_adopt', 'delivery_template', p_key); end if;
  return jsonb_build_object('key', p_key, 'added', added > 0);
end $$;

-- The stage of a project's plan, from its template (null when the project has no plan or the stage is not one of it).
create function pulse.project_stage_label(p_project uuid, p_stage int) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select x->>'label' from pulse.project_plan pl join pulse.delivery_template d on d.org_id = pl.org_id and d.key = pl.template_key,
    jsonb_array_elements(d.definition->'stages') x
  where pl.org_id = pulse.current_org() and pl.project_id = p_project and (x->>'n')::int = p_stage limit 1
$$;

-- The stage a task is on: its phase (s<n>), else the stage of its plan step.
create function pulse.task_stage(p_task uuid) returns int
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(case when t.phase_key ~ '^s[0-9]{1,2}$' then substr(t.phase_key, 2)::int end,
    (select (x->>'stage')::int from pulse.project_plan pl join pulse.delivery_template d on d.org_id = pl.org_id and d.key = pl.template_key,
      jsonb_array_elements(d.definition->'steps') x where pl.project_id = t.project_id and x->>'id' = t.template_step limit 1))
  from pulse.task t where t.org_id = pulse.current_org() and t.id = p_task
$$;

create function pulse.project_stage_owner_set(p_project uuid, p_stage int, p_person uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); pr pulse.project; label text;
begin
  select * into pr from pulse.project where org_id = pulse.current_org() and id = p_project and deleted_at is null;
  if pr.id is null then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership give a stage its owner' using errcode = '42501'; end if;
  label := pulse.project_stage_label(p_project, p_stage);
  if label is null then raise exception 'Choose a stage of the project''s plan' using errcode = '22023'; end if;
  if p_person is null then
    delete from pulse.project_stage_owner where org_id = pulse.current_org() and project_id = p_project and stage = p_stage;
  else
    if not exists(select 1 from pulse.person where org_id = pulse.current_org() and id = p_person and side = 'staff' and status = 'active') then
      raise exception 'Choose an active member of staff' using errcode = '22023'; end if;
    insert into pulse.project_stage_owner(org_id, project_id, stage, person_id, set_by) values (pulse.current_org(), p_project, p_stage, p_person, me)
      on conflict (project_id, stage) do update set person_id = excluded.person_id, set_by = excluded.set_by, set_at = now();
    perform pulse.work_notify(p_person, 'project.stage', 'project', p_project, format('stage-owner:%s:%s:%s', p_project, p_stage, now()),
      format('You own stage %s · %s of “%s”', p_stage, label, coalesce(pr.title, pr.name)), '/tasks/projects/' || p_project, 'task');
  end if;
  perform pulse.audit_write('project_stage_owner_set', 'project', p_project::text);
  return jsonb_build_object('project', p_project, 'stage', p_stage, 'owner', p_person);
end $$;

create function pulse.project_task_stage(p_task uuid, p_stage int) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); t pulse.task; label text; step_stage int;
begin
  select * into t from pulse.task where org_id = pulse.current_org() and id = p_task and deleted_at is null;
  if t.id is null or t.project_id is null then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if not (pulse.project_can_run(t.project_id) or me in (t.created_by, t.assignee_person_id, t.owner_id)
      or exists(select 1 from pulse.project_stage_owner o where o.project_id = t.project_id and o.person_id = me)) then
    raise exception 'Only the task''s people, the stage owners and the project''s lead place it on a stage' using errcode = '42501'; end if;
  -- A subtask goes with its parent; a task of the delivery loop's phases (0052, pulse.phase) keeps its phase.
  if t.parent_id is not null then raise exception 'A subtask stays with its parent task' using errcode = '22023'; end if;
  if t.phase_key is not null and t.phase_key !~ '^s[0-9]{1,2}$' then raise exception 'This task is on the project''s delivery phase; it stays there' using errcode = '22023'; end if;
  label := pulse.project_stage_label(t.project_id, p_stage);
  if label is null then raise exception 'Choose a stage of the project''s plan' using errcode = '22023'; end if;
  if t.template_step is not null then
    select (x->>'stage')::int into step_stage from pulse.project_plan pl join pulse.delivery_template d on d.org_id = pl.org_id and d.key = pl.template_key,
      jsonb_array_elements(d.definition->'steps') x where pl.project_id = t.project_id and x->>'id' = t.template_step;
    if step_stage is not null and step_stage <> p_stage then raise exception 'This task is plan step %; it stays in stage %', t.template_step, step_stage using errcode = '22023'; end if;
  end if;
  update pulse.task set phase_key = 's' || p_stage, updated_at = now(), edited_by = me where id = p_task;
  insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note) values (pulse.current_org(), p_task, me, 'step', 's' || p_stage, left(format('Stage %s · %s', p_stage, label), 1000));
  return jsonb_build_object('task', p_task, 'stage', p_stage, 'label', label);
end $$;

-- Late project work asks its doer why. The API runs it for each company every 10 minutes (project-stages.ts), never on a
-- page read; it only adds a question once per task and due day, only for work due in the last 7 days (older overdue work
-- is not asked about all at once after a deploy), and closes what is no longer late. With p_task, that one task and no
-- notice (its doer is answering it).
create function pulse.task_delays_sync(p_task uuid default null) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare tz text := pulse.org_time_zone(); today date := (now() at time zone tz)::date; n int := 0; r record;
begin
  if pulse.current_org() is null then return 0; end if;
  update pulse.task_delay d set closed_at = now()
    from pulse.task t where d.org_id = pulse.current_org() and t.id = d.task_id and d.closed_at is null and (p_task is null or d.task_id = p_task)
      and (t.deleted_at is not null or t.project_id is distinct from d.project_id or t.status not in ('open','in_progress','blocked') or t.due_at is null
        or (t.due_at at time zone tz)::date <> d.due_on);
  for r in select t.id, t.project_id, t.title, coalesce(t.assignee_person_id, t.owner_id) who, (t.due_at at time zone tz)::date due
      from pulse.task t join pulse.project p on p.id = t.project_id and p.deleted_at is null and coalesce(p.status, 'active') not in ('paused','done','cancelled')
      join pulse.person pe on pe.id = coalesce(t.assignee_person_id, t.owner_id) and pe.side = 'staff' and pe.status = 'active'
      where t.org_id = pulse.current_org() and t.deleted_at is null and t.status in ('open','in_progress','blocked') and t.due_at is not null
        and t.due_at >= ((today - 7) + time '00:00') at time zone tz and (t.due_at at time zone tz)::date < today and (p_task is null or t.id = p_task)
        and not exists(select 1 from pulse.task_delay d where d.org_id = t.org_id and d.task_id = t.id and d.due_on = (t.due_at at time zone tz)::date)
      order by t.due_at limit 200 loop
    insert into pulse.task_delay(org_id, task_id, project_id, due_on, person_id) values (pulse.current_org(), r.id, r.project_id, r.due, r.who) on conflict do nothing;
    if p_task is null then perform pulse.notification_emit(r.who, 'task.late', 'task', r.id, left(format('delay:%s:%s', r.id, r.due), 200),
      left(format('Late since %s: “%s”. Say why, and when it can be done', to_char(r.due, 'DD Mon'), r.title), 160), '/tasks/' || r.id, 'task'); end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Who acts on a delay: the project's lead (and whoever runs the project), the owner of the task's stage, or the person
-- it was escalated to.
create function pulse.task_delay_can_act(p_delay uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select pulse.current_viewer() is not null and exists(select 1 from pulse.task_delay d where d.org_id = pulse.current_org() and d.id = p_delay
    and (pulse.project_can_run(d.project_id) or d.escalated_to = pulse.current_viewer()
      or exists(select 1 from pulse.project_stage_owner o where o.project_id = d.project_id and o.person_id = pulse.current_viewer() and o.stage = pulse.task_stage(d.task_id))))
$$;

-- Who a delay can be escalated to: active staff who may open its task, for whoever acts on it (the pick in the app).
create function pulse.task_delay_targets(p_delay uuid) returns table(id uuid, name text)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d pulse.task_delay;
begin
  select * into d from pulse.task_delay x where x.org_id = pulse.current_org() and x.id = p_delay and x.closed_at is null;
  if d.id is null then raise exception 'Delay not found' using errcode = 'P0002'; end if;
  if not pulse.task_delay_can_act(p_delay) then raise exception 'Only the project''s lead, the stage''s owner and whoever it was escalated to act on it' using errcode = '42501'; end if;
  return query select p.id, p.display_name::text from pulse.person p
    where p.org_id = pulse.current_org() and p.side = 'staff' and p.status = 'active' and p.id is distinct from pulse.current_viewer()
      and not exists(select 1 from pulse.agent_member am where am.person_id = p.id) and pulse.sees_as(p.id, d.task_id, null)
    order by p.display_name limit 300;
end $$;

create function pulse.task_delay_answer(p_task uuid, p_reason text, p_note text, p_by date) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); t pulse.task; d pulse.task_delay; tz text := pulse.org_time_zone(); today date := (now() at time zone tz)::date;
  n text := nullif(btrim(coalesce(p_note, '')), ''); lead uuid; stage_owner uuid; words text;
begin
  select * into t from pulse.task where org_id = pulse.current_org() and id = p_task and deleted_at is null;
  if t.id is null then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if me is null or me is distinct from coalesce(t.assignee_person_id, t.owner_id) then raise exception 'Only the person doing the task answers this' using errcode = '42501'; end if;
  if p_reason is null or p_reason not in ('waiting_client','waiting_team','more_work','other_work','away','other') then raise exception 'Choose why it is late' using errcode = '22023'; end if;
  if p_reason = 'other' and n is null then raise exception 'Say why it is late' using errcode = '22023'; end if;
  if n is not null and length(n) > 300 then raise exception 'Keep the note under 300 letters' using errcode = '22023'; end if;
  if p_by is not null and p_by < today then raise exception 'Choose today or a later day' using errcode = '22023'; end if;
  perform pulse.task_delays_sync(p_task);
  select * into d from pulse.task_delay where org_id = pulse.current_org() and task_id = p_task and closed_at is null order by asked_at desc limit 1;
  if d.id is null then raise exception 'This task is not late' using errcode = '22023'; end if;
  update pulse.task_delay set reason = p_reason, note = n, can_by = p_by, answered_at = now() where id = d.id;
  words := case p_reason when 'waiting_client' then 'waiting on the client' when 'waiting_team' then 'waiting on a colleague' when 'more_work' then 'more work than planned'
    when 'other_work' then 'other work came first' when 'away' then 'on leave or unwell' else 'other' end;
  insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note)
    values (pulse.current_org(), p_task, me, 'edited', 'late', left(words || coalesce(': ' || n, '') || coalesce(format(' · can be done by %s', to_char(p_by, 'DD Mon')), ''), 1000));
  select coalesce(p.lead_person_id, (select owner_id from pulse.work_project where project_id = p.id)) into lead from pulse.project p where p.id = d.project_id;
  select o.person_id into stage_owner from pulse.project_stage_owner o where o.project_id = d.project_id and o.stage = pulse.task_stage(p_task);
  perform pulse.work_notify(x, 'task.late', 'task', p_task, format('delay-answer:%s:%s', d.id, now()),
      left(format('%s: “%s” is late, %s%s', pulse.work_first_name(me), t.title, words, coalesce(format('. Can be done by %s', to_char(p_by, 'DD Mon')), '')), 160), '/tasks/' || p_task, 'task')
    from (select distinct x from unnest(array[lead, stage_owner]) x where x is not null) s;
  return jsonb_build_object('task', p_task, 'delay', d.id, 'reason', p_reason, 'canBy', p_by);
end $$;

create function pulse.task_delay_act(p_delay uuid, p_action text, p_due date, p_note text, p_to uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); d pulse.task_delay; t pulse.task; tz text := pulse.org_time_zone(); today date := (now() at time zone tz)::date;
  n text := nullif(btrim(coalesce(p_note, '')), ''); clock time; late int;
begin
  select * into d from pulse.task_delay where org_id = pulse.current_org() and id = p_delay;
  if d.id is null then raise exception 'Delay not found' using errcode = 'P0002'; end if;
  if d.closed_at is not null then raise exception 'This delay is already settled' using errcode = '22023'; end if;
  if not pulse.task_delay_can_act(p_delay) then raise exception 'Only the project''s lead, the stage''s owner and whoever it was escalated to act on it' using errcode = '42501'; end if;
  if n is not null and length(n) > 300 then raise exception 'Keep the note under 300 letters' using errcode = '22023'; end if;
  select * into t from pulse.task where id = d.task_id;
  late := today - d.due_on;
  if p_action = 'chased' then
    -- The doer is asked again, so their answer is open again (the earlier one stays in the task's history and is shown
    -- until they give a new one).
    update pulse.task_delay set action = 'chased', chases = chases + 1, acted_by = me, acted_at = now(), answered_at = null where id = p_delay;
    perform pulse.notification_emit(d.person_id, 'task.late', 'task', d.task_id, left(format('delay-chase:%s:%s', d.id, now()), 200),
      left(format('%s asks: “%s” is %s days late. Why, and when can it be done?', pulse.work_first_name(me), t.title, late), 160), '/tasks/' || d.task_id, 'task');
  elsif p_action = 'rescheduled' then
    if p_due is null or p_due < today then raise exception 'Choose today or a later day' using errcode = '22023'; end if;
    clock := coalesce((t.due_at at time zone tz)::time, time '18:00');
    update pulse.task set due_at = (p_due + clock) at time zone tz, updated_at = now(), edited_by = me where id = d.task_id;
    insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note)
      values (pulse.current_org(), d.task_id, me, 'edited', format('due %s', d.due_on), format('due %s', p_due), left('Late: given a new date' || coalesce(': ' || n, ''), 1000));
    insert into pulse.project_date_change(org_id, project_id, task_id, from_start, from_due, to_start, to_due, reason_kind, note, changed_by)
      values (pulse.current_org(), d.project_id, d.task_id, t.work_on, d.due_on, t.work_on, p_due, case when d.reason = 'waiting_client' then 'client_delay' else 'our_delay' end, n, me);
    update pulse.task_delay set action = 'rescheduled', acted_by = me, acted_at = now(), closed_at = now() where id = p_delay;
    if d.person_id is distinct from me then
      perform pulse.work_notify(d.person_id, 'task.late', 'task', d.task_id, format('delay-new-date:%s', d.id), left(format('New date for “%s”: %s', t.title, to_char(p_due, 'DD Mon')), 160), '/tasks/' || d.task_id, 'task');
    end if;
  elsif p_action = 'escalated' then
    if p_to is null or p_to = me or not exists(select 1 from pulse.person where org_id = pulse.current_org() and id = p_to and side = 'staff' and status = 'active') then
      raise exception 'Choose who to escalate it to' using errcode = '22023'; end if;
    if not pulse.sees_as(p_to, d.task_id, null) then
      raise exception 'They cannot open this task; escalate it to someone who can' using errcode = '22023'; end if;
    update pulse.task_delay set action = 'escalated', escalated_to = p_to, acted_by = me, acted_at = now() where id = p_delay;
    perform pulse.work_notify(p_to, 'task.late', 'task', d.task_id, format('delay-escalate:%s:%s', d.id, p_to),
      left(format('%s escalated: “%s” is %s days late%s', pulse.work_first_name(me), t.title, late, coalesce(': ' || n, '')), 160), '/tasks/' || d.task_id, 'task');
  else
    raise exception 'Choose Chase, New date or Escalate' using errcode = '22023';
  end if;
  insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note) values (pulse.current_org(), d.task_id, me, 'step', 'late: ' || p_action, n);
  perform pulse.audit_write('task_delay_act', 'task', d.task_id::text);
  return jsonb_build_object('delay', p_delay, 'action', p_action);
end $$;

revoke all on function pulse.sees_as(uuid, uuid, uuid) from public;
revoke all on function pulse.delivery_template_adopt(text, text, jsonb, uuid), pulse.project_stage_label(uuid, int), pulse.task_stage(uuid),
  pulse.project_stage_owner_set(uuid, int, uuid), pulse.project_task_stage(uuid, int), pulse.task_delays_sync(uuid), pulse.task_delay_can_act(uuid),
  pulse.task_delay_targets(uuid), pulse.task_delay_answer(uuid, text, text, date), pulse.task_delay_act(uuid, text, date, text, uuid) from public;
grant execute on function pulse.delivery_template_adopt(text, text, jsonb, uuid), pulse.project_stage_label(uuid, int), pulse.task_stage(uuid),
  pulse.project_stage_owner_set(uuid, int, uuid), pulse.project_task_stage(uuid, int), pulse.task_delays_sync(uuid), pulse.task_delay_can_act(uuid),
  pulse.task_delay_targets(uuid), pulse.task_delay_answer(uuid, text, text, date), pulse.task_delay_act(uuid, text, date, text, uuid) to pulse_api;

-- migrate:down
do $$
declare definition text;
begin
  definition := pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
  execute replace(definition, $r$
 -- PROJECTS-STAGES (1485): late project work and stage owners.
 if p_type in ('task.late','project.stage') then return project_notice_allowed(p_person,p_type,p_subject,p_id);end if;$r$, '');
end $$;
drop function pulse.project_notice_allowed(uuid, text, text, uuid);
drop function pulse.sees_as(uuid, uuid, uuid);
drop function pulse.task_delay_act(uuid, text, date, text, uuid);
drop function pulse.task_delay_answer(uuid, text, text, date);
drop function pulse.task_delay_targets(uuid);
drop function pulse.task_delay_can_act(uuid);
drop function pulse.task_delays_sync(uuid);
drop function pulse.project_task_stage(uuid, int);
drop function pulse.project_stage_owner_set(uuid, int, uuid);
drop function pulse.task_stage(uuid);
drop function pulse.project_stage_label(uuid, int);
drop function pulse.delivery_template_adopt(text, text, jsonb, uuid);
drop table pulse.task_delay;
drop table pulse.project_stage_owner;
