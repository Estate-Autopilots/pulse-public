-- migrate:up
-- Raw native evidence expires after 60 days; work-log revisions remain deliberate person declarations.
grant select,delete on pulse.native_event to pulse_worker;
grant delete on pulse.native_push_delivery to pulse_worker;
-- migrate:down
