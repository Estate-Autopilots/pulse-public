-- migrate:up
-- FIX-PEOPLE-MONEY C2 (owner walkthrough, 10 Nov 2026: "It's unclear who reports to whom. Top level: Kazuk, Datup and
-- Sakipa, with Savuzo also at the top as advisor. Everyone else goes under them ... let admins drag to fix it"):
--  * people_profile.org_place puts a person on the org chart's top row ('top': a founder or partner who reports to
--    nobody) or in its advisors band ('advisor': set apart, outside the reporting lines). Null is everyone else, placed
--    by manager_id as before.
--  * org_place_set(person, place) is HR's and admins' (as org_line_set): placing someone at the top or as an advisor
--    clears their manager (and their pending manager proposal); null takes them back into the lines. Each change is
--    locked against imports (as manager_id) and written to the audit log.
-- The column is on an existing tenant table (forced row security and its tenant policy already apply).
alter table pulse.people_profile add column org_place text check (org_place in ('top','advisor'));

create function pulse.org_place_set(p_person uuid, p_place text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();
begin
 if me is null or not viewer_is('admin','hr') then raise exception 'HR and admins place people on the org chart' using errcode='42501';end if;
 if p_place is not null and p_place not in ('top','advisor') then raise exception 'Choose the top of the company or an advisor' using errcode='22023';end if;
 if not exists(select 1 from people_profile where org_id=current_org() and person_id=p_person) then raise exception 'Choose a team member' using errcode='22023';end if;
 update people_profile set org_place=p_place, manager_id=case when p_place is null then manager_id else null end, updated_at=now(),
   locked=array(select distinct unnest(locked||array['manager_id']))
  where org_id=current_org() and person_id=p_person;
 if p_place is not null then
  update org_line_proposal set status='retired' where org_id=current_org() and kind='manager' and person_id=p_person and status='pending';
 end if;
 perform audit_write('reporting_line','person',p_person::text,array['org_place','manager_id']);
end $$;

revoke all on function pulse.org_place_set(uuid,text) from public;
grant execute on function pulse.org_place_set(uuid,text) to pulse_api;

-- migrate:down
-- Forward-only.
