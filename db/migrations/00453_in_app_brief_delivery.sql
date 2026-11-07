-- migrate:up
-- The immutable packet and its delivery marker are separate: only this one column is mutable.
alter table pulse.role_brief add column delivered_at timestamptz;
grant update(delivered_at) on pulse.role_brief to pulse_api;
-- migrate:down
