-- migrate:up
-- Classify configured aliases separately from Google-generated domain aliases.
alter table pulse.workspace_alias add column editable boolean not null default true;
grant insert,update on pulse.hr_month_history to pulse_api;
create policy history_write on pulse.hr_month_history as restrictive for insert to pulse_api with check(pulse.viewer_is('admin','hr','leadership'));
create policy history_update on pulse.hr_month_history as restrictive for update to pulse_api using(pulse.viewer_is('admin','hr','leadership')) with check(pulse.viewer_is('admin','hr','leadership'));
-- migrate:down
