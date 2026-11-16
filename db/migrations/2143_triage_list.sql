-- migrate:up
-- BUG-SWEEP-2 (EA #13, Project Coordinator, 28 Oct: "the supplied work view truncates during Kazuk's task list, before
-- attention appears ... cannot identify the remaining tasks in the stated 281-task scope"). The daily triage task (1351)
-- sent its AI employee to "the work view's attention list", which the runtime cuts at its size limit long before a big
-- company's list ends. API v1 now lists the complete set, a page at a time (list_triage_tasks, the same tasks this
-- function counts); the task's words send it there. Only the notes change; everything else is 1351's body.
create or replace function pulse.agent_triage_start() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); m agent_member; n int; tid uuid; ap uuid;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  select * into m from agent_member where person_id = me;
  if not m.daily_triage or not agent_acts(me) then return null; end if;
  if extract(hour from now() at time zone org_time_zone()) < 9 then return null; end if;
  if exists(select 1 from task where org_id = current_org() and created_by = me and title like 'Daily triage:%'
             and (created_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date) then return null; end if;
  select count(*) into n from task t where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled')
    and (t.assignee_person_id is null or t.due_at is null) and coalesce(t.created_by, '00000000-0000-0000-0000-000000000000'::uuid) <> me;
  if n = 0 then return jsonb_build_object('tasks', 0); end if;
  ap := coalesce(m.approver_person_id, m.owner_person_id);
  tid := task_save(null, jsonb_build_object('title', 'Daily triage: ' || n || ' tasks with no owner or due day (' || to_char(now() at time zone org_time_zone(), 'FMDD Mon') || ')',
    'assigneeId', me, 'reviewerId', ap, 'dueOn', (now() at time zone org_time_zone())::date,
    'notes', 'List every task with no owner or no due day with list_triage_tasks (pass nextCursor back until it is null: the work view''s attention list is cut short in a big company). For each one, propose who takes it (by their role, pod and load) and by when, '
          || 'in ONE card: {"type": "propose.batch", "title": "Triage ' || to_char(now() at time zone org_time_zone(), 'FMDD Mon') || '", "items": [{"taskId", "assignee", "dueOn", "why"}]}. Do not change the tasks yourself; then mark this task done.'));
  return jsonb_build_object('tasks', n, 'taskId', tid);
end $$;
-- migrate:down
-- Forward-only.
