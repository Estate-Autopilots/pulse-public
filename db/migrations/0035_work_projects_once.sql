-- migrate:up
-- A PGS or manager's scope ("team:<person>") re-ran work_project() for every delivery row, and work_project() walks
-- tasks and reporting lines, so Projects, Clients and the home took minutes for a PGS. The viewer's work projects are
-- now worked out once per transaction and kept for the rest of it (the cache is keyed by tenant and viewer).
create function pulse.work_projects() returns uuid[] language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare
 k text := coalesce(current_setting('pulse.org_id', true), '') || '/' || coalesce(current_setting('pulse.viewer_id', true), '');
 cached text := current_setting('pulse.work_projects_cache', true);
 result uuid[];
begin
 if cached is not null and cached <> '' and split_part(cached, '|', 1) = k then return split_part(cached, '|', 2)::uuid[]; end if;
 -- The same rules as work_project(), set-based: leadership sees all; otherwise the pods the viewer leads, and projects
 -- with tasks or credited deliveries of the viewer or of someone they manage (the rule of manages()).
 if viewer_is('admin', 'leadership') then select coalesce(array_agg(p.id), '{}') into result from project p;
 else
  with lead as (select r.unit_id from role_assignment r where r.person_id = current_viewer() and (r.is_manager_of_unit or r.role_key in ('manager','pgs','head_pgs'))
     and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')),
   team as (select current_viewer() person_id
     union select pp.person_id from people_profile pp where pp.manager_id = current_viewer()
     union select pp.person_id from people_profile pp join unit u on u.name = pp.pod and u.valid_to is null join lead l on l.unit_id = u.id where pp.person_id <> current_viewer())
  select coalesce(array_agg(distinct x.id), '{}') into result from (
   select p.id from project p join lead l on l.unit_id = p.unit_id
   union select t.project_id from task t where t.project_id is not null and (t.owner_id in (select person_id from team) or t.assignee_person_id = current_viewer())
   union select d.project_id from delivery d join delivery_actor a using (org_id, file_id) where d.project_id is not null and a.actor_id in (select person_id from team)) x;
 end if;
 perform set_config('pulse.work_projects_cache', k || '|' || result::text, true);
 return result;
end $$;
revoke all on function pulse.work_projects() from public;
grant execute on function pulse.work_projects() to pulse_api, pulse_worker;

create or replace function pulse.delivery_matches(p_file text,p_scope text) returns boolean language sql stable security invoker set search_path=pulse,pg_temp as $$
 select p_scope is null or case when p_scope like 'person:%' then
 exists(select 1 from delivery_actor a where a.file_id=p_file and a.actor_id=nullif(substr(p_scope,8),'')::uuid)
 when p_scope like 'team:%' then exists(select 1 from delivery d where d.file_id=p_file and d.project_id = any(work_projects()))
 else exists(select 1 from delivery d where d.file_id=p_file and d.uploader_account=p_scope) end
$$;
-- migrate:down
