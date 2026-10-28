-- migrate:up
-- KAZUK (28 Oct 2026): Kazuk's "EA Projects TAB under Pulse", screens 5 and 6.
--  * Pause, hold, discontinue and what's next: the project's lead (PGS), its manager or leadership sets the status with a
--    reason. Paused = the client asked to stop for a while; On hold = EA's own decision (payment pending, MahaRERA
--    missing); both keep project.status 'paused' and say which in pulse.project_status_change. Restarting can move every
--    open task by the paused days. Discontinued (project.status 'cancelled') cancels the open tasks, kept for history,
--    and gives the lead a final-numbers report task and an assets-and-access handover task.
--  * Timeline: changing a task's dates needs a reason (client delay, our delay, client paused, EA hold, scope change,
--    other) and can move what waits for it (pulse.task_link); every change is kept in pulse.project_date_change.
create table pulse.project_status_change(
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references pulse.project(id),
  from_status text,
  to_status text not null check (to_status in ('active','paused','on_hold','discontinued')),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  starts_on date,
  restart_on date,
  stops jsonb not null default '{}'::jsonb check (jsonb_typeof(stops) = 'object' and pg_column_size(stops) < 4000),
  shifted_days int,
  changed_by uuid references pulse.person(id),
  changed_at timestamptz not null default now());
create index project_status_change_project on pulse.project_status_change(org_id, project_id, changed_at desc);
alter table pulse.project_status_change enable row level security;
alter table pulse.project_status_change force row level security;
create policy tenant on pulse.project_status_change using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create table pulse.project_date_change(
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references pulse.project(id),
  task_id uuid not null references pulse.task(id),
  from_start date, from_due date, to_start date, to_due date,
  reason_kind text not null check (reason_kind in ('client_delay','our_delay','client_paused','ea_hold','scope_change','other')),
  note text check (length(note) <= 300),
  moved uuid[] not null default '{}',
  changed_by uuid references pulse.person(id),
  changed_at timestamptz not null default now());
create index project_date_change_project on pulse.project_date_change(org_id, project_id, changed_at desc);
alter table pulse.project_date_change enable row level security;
alter table pulse.project_date_change force row level security;
create policy tenant on pulse.project_date_change using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.project_status_change, pulse.project_date_change to pulse_api;

-- Who runs a project: its lead (PGS), whoever may manage its work, admins and leadership.
create function pulse.project_can_run(p_project uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select pulse.current_viewer() is not null and (pulse.viewer_is('admin','leadership') or pulse.work_project_can_manage(p_project)
    or exists(select 1 from pulse.project p where p.org_id = pulse.current_org() and p.id = p_project and p.lead_person_id = pulse.current_viewer()))
$$;

create function pulse.project_set_status(p_project uuid, p_status text, p_reason text, p_from date, p_restart date, p_stops jsonb, p_shift boolean)
  returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); pr pulse.project; cur text; last pulse.project_status_change; days int := null; n int := 0;
  r text := btrim(coalesce(p_reason, '')); lead uuid; tz text := pulse.org_time_zone();
begin
  select * into pr from pulse.project where org_id = pulse.current_org() and id = p_project and deleted_at is null;
  if pr.id is null then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership change its status' using errcode = '42501'; end if;
  if p_status not in ('active','paused','on_hold','discontinued') then raise exception 'Choose Active, Paused, On hold or Discontinued' using errcode = '22023'; end if;
  if length(r) not between 3 and 500 then raise exception 'Give the reason in a few words' using errcode = '22023'; end if;
  select * into last from pulse.project_status_change where org_id = pulse.current_org() and project_id = p_project order by changed_at desc limit 1;
  cur := case when pr.status = 'cancelled' then 'discontinued' when pr.status = 'paused' then coalesce(case when last.to_status in ('paused','on_hold') then last.to_status end, 'paused') else 'active' end;
  if cur = p_status then raise exception 'The project is already %', replace(p_status, '_', ' ') using errcode = '22023'; end if;
  lead := coalesce(pr.lead_person_id, (select owner_id from pulse.work_project where project_id = p_project), me);
  if p_status in ('paused','on_hold') then
    update pulse.project set status = 'paused', updated_at = now() where id = p_project;
    update pulse.work_project set status = 'paused', updated_at = now(), updated_by = me where project_id = p_project and status <> 'paused';
  elsif p_status = 'active' then
    if cur in ('paused','on_hold') and coalesce(p_shift, false) then
      days := greatest(0, (now() at time zone tz)::date - coalesce(last.starts_on, (last.changed_at at time zone tz)::date));
      if days > 0 then
        with moved as (update pulse.task t set due_at = t.due_at + make_interval(days => days), work_on = t.work_on + days, updated_at = now(), edited_by = me
          where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.status in ('open','in_progress','blocked') and t.due_at is not null returning t.id)
        insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note)
          select pulse.current_org(), id, me, 'edited', 'due', format('+%s days', days), left('Project restarted after a pause: ' || r, 1000) from moved;
        get diagnostics n = row_count;
      end if;
    end if;
    update pulse.project set status = 'active', updated_at = now() where id = p_project;
    update pulse.work_project set status = 'active', updated_at = now(), updated_by = me where project_id = p_project;
  else
    with gone as (update pulse.task t set status = 'cancelled', updated_at = now(), edited_by = me
      where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.status in ('open','in_progress','blocked','in_review') returning t.id)
    insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note)
      select pulse.current_org(), id, me, 'status', 'open', 'cancelled', left('Project discontinued: ' || r, 1000) from gone;
    get diagnostics n = row_count;
    update pulse.project set status = 'cancelled', updated_at = now(), ends_on = coalesce(p_from, ends_on) where id = p_project;
    update pulse.work_project set status = 'cancelled', updated_at = now(), updated_by = me where project_id = p_project;
    -- What's next: the lead closes the numbers and hands over assets and access (Kazuk's screen 6).
    with made as (insert into pulse.task(org_id, project_id, title, assignee_person_id, created_by, created_at, assigned_at, due_at, priority, notes)
      select pulse.current_org(), p_project, x.title, lead, me, now(), now(), ((now() at time zone tz)::date + 3 + time '18:00') at time zone tz, 'high', x.notes
      from (values (format('Final numbers report: %s', coalesce(pr.title, pr.name)), format('The project was discontinued: %s. Share the final numbers with the client and leadership.', r)),
                   (format('Assets and access handover: %s', coalesce(pr.title, pr.name)), 'Hand the client''s files, ad accounts and logins back, and remove access that is no longer needed. Ask Accounts to check any refund or settlement.')) x(title, notes)
      returning id, title)
    insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value) select pulse.current_org(), id, me, 'created', title from made;
  end if;
  insert into pulse.project_status_change(org_id, project_id, from_status, to_status, reason, starts_on, restart_on, stops, shifted_days, changed_by)
    values (pulse.current_org(), p_project, cur, p_status, r, coalesce(p_from, (now() at time zone tz)::date), p_restart, coalesce(p_stops, '{}'::jsonb), days, me);
  perform pulse.audit_write('project_set_status', 'project', p_project::text);
  return jsonb_build_object('status', p_status, 'from', cur, 'tasks', n, 'shiftedDays', days);
end $$;

create function pulse.project_reschedule(p_task uuid, p_start date, p_due date, p_reason text, p_note text, p_cascade boolean)
  returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); t pulse.task; tz text := pulse.org_time_zone(); old_start date; old_due date; shift int; moved uuid[] := '{}';
  note text := nullif(btrim(coalesce(p_note, '')), ''); clock time;
begin
  select * into t from pulse.task where org_id = pulse.current_org() and id = p_task and deleted_at is null;
  if t.id is null or t.project_id is null then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if not (pulse.project_can_run(t.project_id) or me in (t.created_by, t.review_owner_id)) then
    raise exception 'Only the project''s lead, its manager and leadership change its dates' using errcode = '42501'; end if;
  if p_reason not in ('client_delay','our_delay','client_paused','ea_hold','scope_change','other') then raise exception 'Choose why the dates change' using errcode = '22023'; end if;
  if p_reason = 'other' and note is null then raise exception 'Say why the dates change' using errcode = '22023'; end if;
  if note is not null and length(note) > 300 then raise exception 'Keep the note under 300 letters' using errcode = '22023'; end if;
  if p_due is null then raise exception 'Choose the new end date' using errcode = '22023'; end if;
  if p_start is not null and p_start > p_due then raise exception 'The start must be on or before the end' using errcode = '22023'; end if;
  old_start := coalesce(t.work_on, (t.started_at at time zone tz)::date);
  old_due := (t.due_at at time zone tz)::date;
  clock := coalesce((t.due_at at time zone tz)::time, time '18:00');
  update pulse.task set due_at = (p_due + clock) at time zone tz, work_on = coalesce(p_start, work_on), updated_at = now(), edited_by = me where id = p_task;
  insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note)
    values (pulse.current_org(), p_task, me, 'edited', format('dates %s → %s', coalesce(old_start::text, '?'), coalesce(old_due::text, 'none')),
      format('dates %s → %s', coalesce(p_start::text, coalesce(old_start::text, '?')), p_due), left(replace(p_reason, '_', ' ') || coalesce(': ' || note, ''), 1000));
  shift := case when old_due is null then 0 else p_due - old_due end;
  if coalesce(p_cascade, false) and shift > 0 then
    with recursive waits(id) as (
        select l.task_id from pulse.task_link l where l.org_id = pulse.current_org() and l.blocker_id = p_task and l.cleared_at is null
        union select l.task_id from pulse.task_link l join waits w on l.blocker_id = w.id where l.org_id = pulse.current_org() and l.cleared_at is null),
      up as (update pulse.task x set due_at = x.due_at + make_interval(days => shift), work_on = x.work_on + shift, updated_at = now(), edited_by = me
        from waits w where x.id = w.id and x.deleted_at is null and x.status in ('open','in_progress','blocked') and x.due_at is not null and x.id <> p_task returning x.id)
    select coalesce(array_agg(id), '{}') into moved from up;
    insert into pulse.task_event(org_id, task_id, actor_id, kind, from_value, to_value, note)
      select pulse.current_org(), m, me, 'edited', 'due', format('+%s days', shift), left('Moved with the task it waits for: ' || replace(p_reason, '_', ' '), 1000) from unnest(moved) m;
  end if;
  insert into pulse.project_date_change(org_id, project_id, task_id, from_start, from_due, to_start, to_due, reason_kind, note, moved, changed_by)
    values (pulse.current_org(), t.project_id, p_task, old_start, old_due, coalesce(p_start, old_start), p_due, p_reason, note, moved, me);
  perform pulse.audit_write('project_reschedule', 'task', p_task::text);
  return jsonb_build_object('task', p_task, 'due', p_due, 'moved', cardinality(moved));
end $$;
revoke all on function pulse.project_can_run(uuid), pulse.project_set_status(uuid, text, text, date, date, jsonb, boolean),
  pulse.project_reschedule(uuid, date, date, text, text, boolean) from public;
grant execute on function pulse.project_can_run(uuid), pulse.project_set_status(uuid, text, text, date, date, jsonb, boolean),
  pulse.project_reschedule(uuid, date, date, text, text, boolean) to pulse_api;

-- migrate:down
drop function pulse.project_reschedule(uuid, date, date, text, text, boolean);
drop function pulse.project_set_status(uuid, text, text, date, date, jsonb, boolean);
drop function pulse.project_can_run(uuid);
drop table pulse.project_date_change;
drop table pulse.project_status_change;
