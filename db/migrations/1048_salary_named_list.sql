-- migrate:up
-- SHIP-2: salary access by a named list, per organisation (decision integrity-h5-salary-access = "Named list I approve",
-- 25 Oct 2026, keeping the existing grants; INTEGRITY H5 rest; from OPS's parked 1011 on ops/salary-named-list).
-- Until now everyone holding the HR or leadership role read and changed every salary just by that role; admins needed
-- a named grant. An organisation can now switch "salary by named list" on: then hr.salary.read and hr.salary.write
-- need a named grant (pulse.sensitive_permission, Settings -> Roles & permissions) for HR, leadership and admins alike.
--  * Off by default for every organisation, so nobody loses access when this ships. Turning it on is an admin's
--    choice in Settings (it shows who holds salary by role only and would lose it), recorded with their name.
--  * Only an admin who holds salary access changes the switch (the people who manage the named grants), and only one
--    holding a named "Read salary" grant turns it on (otherwise they would lose access themselves and nobody could
--    turn it back). Nobody writes the switch directly: it changes only through pulse.salary_named_list_set.
--  * The other three HR permissions (contact read/write, documents) are unchanged. Nothing is granted or revoked here;
--    every named grant stays as it is.
-- hr_can and comp_perm are the repository's definitions (0023, 0440) with only the salary branch added.

create table pulse.comp_salary_list (                        -- one row per organisation that has used the switch
 org_id uuid primary key references pulse.org(id),
 named_list boolean not null default false,
 changed_by uuid,                                           -- no foreign key (as 0211: smoke cleanups delete people)
 changed_at timestamptz not null default now());
alter table pulse.comp_salary_list enable row level security;
alter table pulse.comp_salary_list force row level security;
create policy tenant_isolation on pulse.comp_salary_list using (org_id=pulse.current_org()) with check (org_id=pulse.current_org());
revoke all on pulse.comp_salary_list from public;
grant select on pulse.comp_salary_list to pulse_api;              -- read for Settings; written only by the function below
-- 0965's guard for comp_ tables (it covered the tables that existed then).
create trigger ea_ai_no_delete before delete on pulse.comp_salary_list for each statement execute function pulse.agent_guard();
create trigger ea_ai_no_write before insert or update on pulse.comp_salary_list for each statement execute function pulse.agent_guard();

create function pulse.salary_named_list() returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select named_list from comp_salary_list where org_id=current_org()),false)
$$;

create or replace function pulse.hr_can(p_permission text) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_permission=any(array['hr.salary.read','hr.salary.write','hr.contact.read','hr.contact.write','hr.documents.read']) and
 case when p_permission in ('hr.salary.read','hr.salary.write') and salary_named_list()
  -- 1048: salary by named list, for every role.
  then viewer_is('hr','leadership','admin') and exists(select 1 from sensitive_permission where org_id=current_org() and person_id=current_viewer() and permission=p_permission and revoked_at is null)
  else (viewer_is('hr','leadership') or viewer_is('admin') and exists(select 1 from sensitive_permission where person_id=current_viewer() and permission=p_permission and revoked_at is null))
 end
$$;

create or replace function pulse.comp_perm(p_who uuid, p_perm text) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_who is not null and exists(select 1 from person where org_id=current_org() and id=p_who and side='staff' and status='active')
  and case when p_perm in ('hr.salary.read','hr.salary.write') and salary_named_list()
   -- 1048: the same rule as hr_can, for another person.
   then comp_has_role(p_who,'hr','leadership','admin') and exists(select 1 from sensitive_permission
    where org_id=current_org() and person_id=p_who and permission=p_perm and revoked_at is null)
   else (comp_has_role(p_who,'hr','leadership') or comp_has_role(p_who,'admin') and exists(select 1 from sensitive_permission
    where org_id=current_org() and person_id=p_who and permission=p_perm and revoked_at is null))
  end
$$;

-- Changes the switch and records the change (record_change: org / salary_named_list, old -> new); asking for the value
-- it already has changes and records nothing.
create function pulse.salary_named_list_set(p_on boolean) returns boolean
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare was boolean;
begin
 if current_viewer() is null or not (viewer_is('admin') and hr_can('hr.salary.read')) then
  raise exception 'Only an organisation admin who holds salary access changes who sees salaries' using errcode='42501'; end if;
 if p_on is null then raise exception 'Say whether salary access is by named list' using errcode='22023'; end if;
 if p_on and not exists(select 1 from sensitive_permission where org_id=current_org() and person_id=current_viewer() and permission='hr.salary.read' and revoked_at is null) then
  raise exception 'Hold a named “Read salary” grant yourself first, or you would lose salary access too' using errcode='42501'; end if;
 insert into comp_salary_list(org_id) values(current_org()) on conflict (org_id) do nothing;
 select named_list into was from comp_salary_list where org_id=current_org() for update;
 if was is distinct from p_on then
  update comp_salary_list set named_list=p_on,changed_by=current_viewer(),changed_at=now() where org_id=current_org();
  insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by)
   values(current_org(),'org',current_org(),'salary_named_list',was::text,p_on::text,current_viewer());
 end if;
 return p_on;
end $$;
revoke all on function pulse.salary_named_list(), pulse.salary_named_list_set(boolean) from public;
grant execute on function pulse.salary_named_list(), pulse.salary_named_list_set(boolean) to pulse_api;

-- migrate:down
-- Back to salary by role (0023 / 0440 definitions).
create or replace function pulse.hr_can(p_permission text) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_permission=any(array['hr.salary.read','hr.salary.write','hr.contact.read','hr.contact.write','hr.documents.read']) and
 (viewer_is('hr','leadership') or viewer_is('admin') and exists(select 1 from sensitive_permission where person_id=current_viewer() and permission=p_permission and revoked_at is null))
$$;
create or replace function pulse.comp_perm(p_who uuid, p_perm text) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_who is not null and exists(select 1 from person where org_id=current_org() and id=p_who and side='staff' and status='active')
  and (comp_has_role(p_who,'hr','leadership') or comp_has_role(p_who,'admin') and exists(select 1 from sensitive_permission
   where org_id=current_org() and person_id=p_who and permission=p_perm and revoked_at is null))
$$;
drop function pulse.salary_named_list_set(boolean);
drop function pulse.salary_named_list();
drop table pulse.comp_salary_list;
