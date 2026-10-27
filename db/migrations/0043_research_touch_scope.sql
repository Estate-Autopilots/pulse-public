-- migrate:up
-- Operational corrections need a role as well as project scope. A personal delivery does not grant call editing.
drop policy touch_write on pulse.lead_touch;
create policy touch_write on pulse.lead_touch as restrictive for update to pulse_api
 using(pulse.viewer_is('admin','leadership') or (pulse.viewer_is('manager','pgs','head_pgs') and exists(select 1 from pulse.lead l join pulse.project p on p.id=l.project_id where l.id=lead_id and (p.lead_person_id=pulse.current_viewer() or p.id=any(pulse.work_projects())))))
 with check(pulse.viewer_is('admin','leadership') or (pulse.viewer_is('manager','pgs','head_pgs') and exists(select 1 from pulse.lead l join pulse.project p on p.id=l.project_id where l.id=lead_id and (p.lead_person_id=pulse.current_viewer() or p.id=any(pulse.work_projects())))));
-- migrate:down
