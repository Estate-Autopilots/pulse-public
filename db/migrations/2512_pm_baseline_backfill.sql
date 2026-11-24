-- migrate:up
-- PM-BUILD-3 (22 Nov 2026): 2510's back-fill of task.baseline_due_at ran with no company set, so the tasks' forced row
-- security hid every row and it changed nothing (pulse_dev: 0 of 164 dated plan steps). Each active company in turn
-- (pulse.list_active_orgs, as 2485 does): a dated plan step without a baseline keeps its due date as its baseline. New
-- steps already get theirs from 2510's trigger. Running it again changes nothing.
do $$
declare o uuid; previous_org text := current_setting('pulse.org_id', true);
begin
  for o in select * from pulse.list_active_orgs() loop
    perform set_config('pulse.org_id', o::text, true);
    update pulse.task set baseline_due_at = due_at
     where org_id = o and template_step is not null and due_at is not null and baseline_due_at is null and deleted_at is null;
  end loop;
  perform set_config('pulse.org_id', coalesce(previous_org, ''), true);
end $$;

-- migrate:down
-- Nothing to undo: a baseline is the first due date the step had.
