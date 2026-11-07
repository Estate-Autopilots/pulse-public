-- migrate:up
-- TASKS-4B: mark the existing cases of work finished with subtasks still open, once per company. 0310's own insert ran
-- without a company set, so row security showed it no tasks (the migration role does not bypass it): nothing was
-- flagged on pulse_dev, and nothing would have been on production. Flags only; no task changes. Safe to repeat.
do $$ declare o uuid;begin
 for o in select id from pulse.org loop
  perform set_config('pulse.org_id',o::text,true);
  insert into pulse.task_flag(org_id,task_id,person_id,kind,cause,detail,raised_by)
  select t.org_id,t.id,coalesce(t.assignee_person_id,t.owner_id),'open_subtasks','finished',
   jsonb_build_object('open',(select jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'status',c.status) order by c.created_at) from pulse.task c
    where c.org_id=t.org_id and c.parent_id=t.id and c.deleted_at is null and c.status in ('open','in_progress','blocked','unknown'))),'migration'
  from pulse.task t where t.org_id=o and t.deleted_at is null and t.status in ('done','in_review','accepted')
   and exists(select 1 from pulse.task c where c.org_id=t.org_id and c.parent_id=t.id and c.deleted_at is null and c.status in ('open','in_progress','blocked','unknown'))
  on conflict do nothing;
 end loop;
end $$;

-- migrate:down
-- Forward-only.
