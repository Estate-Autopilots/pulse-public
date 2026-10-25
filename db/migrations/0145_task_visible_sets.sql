-- migrate:up
-- UX-TASKS: task visibility as one set per query. RT1's policy asked task_visible_row() once per row; with 2,133 tasks a
-- member's every task query cost 1.5–2.8 s on the dev box. task_visible_ids() computes the same rule (0144's version of
-- task_visible_row) once, set-based, and the policies look rows up in it. task_visible_row() stays for single checks;
-- tests/core/test_work_structure.py holds the two to the same answer for every role.
create function pulse.task_visible_ids() returns setof uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare v uuid:=current_viewer();
begin
 if v is null then return;end if;
 if viewer_is('admin','leadership','hr') then return query select t.id from task t where t.org_id=current_org();return;end if;
 return query
 with mine as (select t.id from task t where t.org_id=current_org() and v in (t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by)),
 managed as (select pp.person_id p from people_profile pp where pp.org_id=current_org() and pp.person_id<>v and manages(pp.person_id)),
 podmates as (select them.person_id p from people_profile self join people_profile them on them.org_id=self.org_id and them.pod=self.pod
  where self.org_id=current_org() and self.person_id=v and self.pod is not null),
 unit_projects as (select pr.id from project pr join role_assignment r on r.unit_id=pr.unit_id where pr.org_id=current_org() and r.person_id=v
  and (r.is_manager_of_unit or r.role_key in ('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity')),
 in_projects as (select m.project_id id from project_member m where m.org_id=current_org() and m.person_id=v and m.left_at is null
  union select wp.project_id from work_project wp where wp.org_id=current_org() and (wp.owner_id=v or (wp.pod is not null and wp.pod=any(work_head_pods()))))
 select mine.id from mine
 union select m.task_id from task_member m where m.org_id=current_org() and m.person_id=v and m.removed_at is null
 union select a.task_id from work_ask a where a.org_id=current_org() and a.to_id=v and a.status='pending' and a.task_id is not null
 union select t.id from task t where t.org_id=current_org() and (t.owner_id in (select p from managed) or t.assignee_person_id in (select p from managed)
  or coalesce(t.assignee_person_id,t.owner_id,t.created_by) in (select p from podmates)
  or t.project_id in (select id from unit_projects) or t.project_id in (select id from in_projects) or t.parent_id in (select id from mine))
 union select l.blocker_id from task_link l join task b on b.id=l.task_id where l.org_id=current_org() and l.cleared_at is null and v in (b.owner_id,b.assignee_person_id,b.review_owner_id,b.created_by)
 union select l.task_id from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and l.cleared_at is null and v in (b.owner_id,b.assignee_person_id);
end $$;
revoke all on function pulse.task_visible_ids() from public;
grant execute on function pulse.task_visible_ids() to pulse_api,pulse_worker;

-- The sub-selects run once per query (an InitPlan and a hashed SubPlan), not once per row.
drop policy task_person on pulse.task;
create policy task_person on pulse.task as restrictive for select to pulse_api using((select pulse.viewer_is('admin','leadership','hr')) or id in (select pulse.task_visible_ids()));
drop policy visible on pulse.task_link;
create policy visible on pulse.task_link as restrictive for select to pulse_api using((select pulse.viewer_is('admin','leadership','hr'))
 or task_id in (select pulse.task_visible_ids()) or blocker_id in (select pulse.task_visible_ids()));
drop policy visible on pulse.task_proof;
create policy visible on pulse.task_proof as restrictive for select to pulse_api using((select pulse.viewer_is('admin','leadership','hr')) or task_id in (select pulse.task_visible_ids()));
drop policy visible on pulse.task_event;
create policy visible on pulse.task_event as restrictive for select to pulse_api using((select pulse.viewer_is('admin','leadership','hr')) or task_id in (select pulse.task_visible_ids()));
drop policy visible on pulse.task_member;
create policy visible on pulse.task_member as restrictive for select to pulse_api using((select pulse.viewer_is('admin','leadership','hr')) or task_id in (select pulse.task_visible_ids()));
drop policy visible on pulse.work_comment;
create policy visible on pulse.work_comment as restrictive for select to pulse_api using(removed_at is null and
 ((task_id is not null and ((select pulse.viewer_is('admin','leadership','hr')) or task_id in (select pulse.task_visible_ids()))) or (project_id is not null and pulse.work_project_in(project_id))));
drop policy visible on pulse.work_ask;
create policy visible on pulse.work_ask as restrictive for select to pulse_api using((select pulse.viewer_is('admin','leadership','hr')) or (select pulse.current_viewer()) in (from_id,to_id)
 or (task_id is not null and task_id in (select pulse.task_visible_ids())) or (project_id is not null and pulse.work_project_in(project_id)));
-- migrate:down
-- Forward-only.
