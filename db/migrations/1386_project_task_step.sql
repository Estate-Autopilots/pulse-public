-- migrate:up
-- KAZUK (28 Oct 2026): Kazuk's screen 3, "how a chat task lands in the project". A task made with /task in a project's
-- chat takes the step of the project's delivery plan it belongs to (suggested from its words), so it shows on the
-- project page with its step, stage and, when it has none, the step's due day from the kick-off.
create function pulse.project_task_step(p_task uuid, p_step text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); t pulse.task; pl pulse.project_plan; st jsonb; tz text := pulse.org_time_zone();
begin
  select * into t from pulse.task where org_id = pulse.current_org() and id = p_task and deleted_at is null;
  if t.id is null or t.project_id is null then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if not (pulse.project_can_run(t.project_id) or me in (t.created_by, t.assignee_person_id, t.owner_id)) then
    raise exception 'Only the task''s people and the project''s lead place it on a step' using errcode = '42501'; end if;
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = t.project_id;
  if pl.project_id is null then raise exception 'This project has no delivery plan' using errcode = '22023'; end if;
  select x into st from pulse.delivery_template d, jsonb_array_elements(d.definition->'steps') x
    where d.org_id = pulse.current_org() and d.key = pl.template_key and x->>'id' = p_step;
  if st is null then raise exception 'Choose a step of the plan' using errcode = '22023'; end if;
  update pulse.task set template_step = p_step, phase_key = 's' || (st->>'stage'), role_key = coalesce(role_key, left(st->>'owner', 60)),
      due_at = coalesce(due_at, case when st->>'end' is null then null else ((pl.kickoff + (st->>'end')::int) + time '18:00') at time zone tz end),
      updated_at = now(), edited_by = me
    where id = p_task;
  insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note) values (pulse.current_org(), p_task, me, 'step', p_step, left(st->>'title', 1000));
  return jsonb_build_object('task', p_task, 'step', p_step);
end $$;
revoke all on function pulse.project_task_step(uuid, text) from public;
grant execute on function pulse.project_task_step(uuid, text) to pulse_api;

-- migrate:down
drop function pulse.project_task_step(uuid, text);
