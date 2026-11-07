-- migrate:up
-- Settings in the app: an organisation admin renames the organisation, creates and renames pods, and grants or
-- ends the admin and HR roles. Pods are pulse.unit rows; people_profile.pod and project.unit_id follow a rename.
grant update (name) on pulse.org to pulse_api;
grant insert, update (name, valid_to) on pulse.unit to pulse_api;
grant insert, update (valid_to) on pulse.role_assignment to pulse_api;
create policy settings_admin on pulse.org as restrictive for update to pulse_api
  using (pulse.viewer_is('admin')) with check (pulse.viewer_is('admin'));
create policy settings_insert on pulse.unit as restrictive for insert to pulse_api with check (pulse.viewer_is('admin'));
create policy settings_update on pulse.unit as restrictive for update to pulse_api
  using (pulse.viewer_is('admin')) with check (pulse.viewer_is('admin'));
create policy role_grant on pulse.role_assignment as restrictive for insert to pulse_api
  with check (pulse.viewer_is('admin') and role_key in ('admin','hr'));
create policy role_end on pulse.role_assignment as restrictive for update to pulse_api
  using (pulse.viewer_is('admin') and role_key in ('admin','hr')) with check (pulse.viewer_is('admin'));
alter table pulse.record_change drop constraint record_change_entity_type_check,
  add constraint record_change_entity_type_check check (entity_type in ('person','client','contact','project','org','pod','role'));
-- migrate:down
