-- migrate:up
-- R51: the last column defaults that named India count in the company's own zone (pulse.org_time_zone(): the request's
-- or set_tenant's company, as 0299 did for ERP's dates). EA's zone is Asia/Kolkata, so EA's new rows get the same
-- values as before. Only defaults change; no row is rewritten. pulse.org.time_zone keeps its default: it is the
-- company's own setting, and the setup wizard always fills it (tests/core/test_org_time_zone.py checks both).
alter table pulse.attendance_entry alter column work_date set default ((now() at time zone pulse.org_time_zone())::date);
alter table pulse.hr_policy alter column tracking_from set default ((date_trunc('month', now() at time zone pulse.org_time_zone()))::date);
alter table pulse.task alter column review_calendar set default pulse.org_time_zone();
alter table pulse.attendance_close_policy alter column timezone set default pulse.org_time_zone();
alter table pulse.brief_preference alter column timezone set default pulse.org_time_zone();
alter table pulse.notification_reminder_policy alter column timezone set default pulse.org_time_zone();

-- migrate:down
-- Forward-only.
