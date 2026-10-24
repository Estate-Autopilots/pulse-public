-- migrate:up
-- TASKS-4B: the review queue holds work finished in Pulse, not the team trackers' history. Imported tracker rows marked
-- Done (1,834 on pulse_dev, none with a reviewer or a finish time) had landed in every leader's queue ("Reviews 1834").
-- They stay as they are and can still be accepted from their page; they are just not waiting for anyone.
create or replace function pulse.task_review_queue(p_person uuid) returns setof uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 select t.id from task t where t.org_id=current_org() and t.deleted_at is null and t.status in ('done','in_review')
  and t.source is distinct from 'imported' and t.done_at is not null
  and coalesce(t.assignee_person_id,t.owner_id) is distinct from p_person
  and (t.review_owner_id=p_person
   or (t.review_owner_id is null and (exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p_person and r.role_key in ('admin','leadership')
      and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) or exists(select 1 from people_profile pp where pp.org_id=current_org()
      and pp.person_id=coalesce(t.assignee_person_id,t.owner_id) and (pp.manager_id=p_person or hr_head(pp.person_id)=p_person)))))
$$;

-- migrate:down
-- Forward-only.
