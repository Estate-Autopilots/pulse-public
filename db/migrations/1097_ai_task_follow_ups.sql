-- migrate:up
-- AI-TASKS (seen on pulse-dev with the real model, 26 Oct 2026): "summarise the group and create follow-ups" — the AI
-- made the follow-ups as sub-tasks of its own task, and a task cannot go for review while a sub-task is open, so the
-- finished summary waited for every follow-up. An AI employee now has two kinds of work for colleagues:
--  * sub-tasks (as before): what must be done before it can finish its task;
--  * follow-ups: new tasks for colleagues that come out of its task (same project, reviewed by the person who gave it the
--    task, the assignee told); they do not hold its task. Five a run, fifteen a task; the same title twice is skipped.
-- agent_task_act is patched in place (its shape is checked); nothing else changes.
do $$
declare d text; c text;
begin
  d := pg_get_functiondef('pulse.agent_task_act(uuid,jsonb,uuid)'::regprocedure);
  c := replace(d, $x$skipped jsonb := '[]';$x$, $x$skipped jsonb := '[]'; fups jsonb := '[]'; fnote text;$x$);
  c := replace(c, $x$  -- Direct messages to colleagues about the task$x$, $x$  -- AI-TASKS 1097: follow-ups for colleagues: new tasks that come out of this one (they do not hold it).
  if jsonb_typeof(p->'followups') = 'array' then
    for x in select s from jsonb_array_elements(p->'followups') s limit 5 loop
      ttitle := left(btrim(regexp_replace(coalesce(x->>'title', ''), '\s+', ' ', 'g')), 300);
      select p2.id, p2.display_name into who, who_name from people_profile pp join person p2 on p2.id = pp.person_id
       where pp.org_id = current_org() and lower(pp.username) = lower(btrim(coalesce(x->>'assignee', ''), ' @')) and p2.side = 'staff' and p2.status = 'active';
      if ttitle = '' or who is null then skipped := skipped || jsonb_build_object('followup', left(ttitle, 80), 'why', case when ttitle = '' then 'no title' else 'no active colleague by that username' end); continue; end if;
      fnote := 'Follow-up from “' || left(t.title, 200) || '” (/tasks/' || t.id || ')';
      if (select count(*) from task where org_id = current_org() and created_by = me and parent_id is null and position(t.id::text in coalesce(notes, '')) > 0) >= 15 then
        skipped := skipped || jsonb_build_object('followup', left(ttitle, 80), 'why', 'fifteen follow-ups already'); exit; end if;
      if exists(select 1 from task where org_id = current_org() and created_by = me and parent_id is null and lower(title) = lower(ttitle) and deleted_at is null and status <> 'cancelled'
                  and position(t.id::text in coalesce(notes, '')) > 0) then
        skipped := skipped || jsonb_build_object('followup', left(ttitle, 80), 'why', 'already made'); continue; end if;
      tdue := case when coalesce(x->>'dueOn', '') ~ '^\d{4}-\d{2}-\d{2}$' then (x->>'dueOn')::date end;
      insert into task(org_id, title, status, project_id, parent_id, owner_id, assignee_person_id, review_owner_id, due_at, priority, notes, source, created_by, created_at, edited_by, updated_at, assigned_at, locked, urgency)
      values (current_org(), ttitle, 'open', t.project_id, null, who, who,
              coalesce((select p3.id from person p3 where p3.id = coalesce(w.given_by, t.created_by) and p3.side = 'staff' and p3.status = 'active' and p3.id <> who), t.review_owner_id, m.owner_person_id),
              case when tdue is not null then (tdue + time '18:00') at time zone org_time_zone() end, 'normal',
              left(fnote || coalesce(chr(10) || chr(10) || nullif(btrim(coalesce(x->>'notes', '')), ''), ''), 4000), 'pulse', me, now(), me, now(), now(), '{title,status,owner_id,project_id,due_label}', 'normal')
      returning id into nid;
      perform task_event_add(nid, 'created', null, ttitle);
      perform task_event_add(nid, 'assigned', null, who_name);
      perform work_notify(who, 'task.assigned', 'task', nid, nid || ':assigned', me_name || ' gave you “' || left(ttitle, 90) || '”, a follow-up from “' || left(t.title, 60) || '”', '/tasks/' || nid, 'task');
      insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'task', nid) on conflict do nothing;
      fups := fups || jsonb_build_object('id', nid, 'title', ttitle, 'assignee', who_name);
    end loop;
  end if;

  -- Direct messages to colleagues about the task$x$);
  c := replace(c, $x$'subtasks', subs,$x$, $x$'subtasks', subs, 'followups', fups,$x$);
  if c = d or position('fups jsonb' in c) = 0 or position('AI-TASKS 1097' in c) = 0 or position($x$'followups', fups$x$ in c) = 0 then
    raise exception 'agent_task_act changed shape (AI-TASKS 1097)'; end if;
  execute c;
end $$;

-- migrate:down
-- Forward-only.
