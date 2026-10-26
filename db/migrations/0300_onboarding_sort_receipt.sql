-- migrate:up
create table pulse.onboarding_sort_receipt (
 org_id uuid primary key references pulse.org(id) on delete cascade,
 last_run_at timestamptz not null default clock_timestamp(),
 folders integer not null default 0 check(folders>=0),
 matched_existing integer not null default 0 check(matched_existing>=0),
 proposals integer not null default 0 check(proposals>=0),
 skipped_reason text check(skipped_reason is null or length(skipped_reason)<=80)
);

alter table pulse.onboarding_sort_receipt enable row level security;
alter table pulse.onboarding_sort_receipt force row level security;
create policy tenant_isolation on pulse.onboarding_sort_receipt
 using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select on pulse.onboarding_sort_receipt to pulse_api;
grant select,insert,update on pulse.onboarding_sort_receipt to pulse_worker;

-- migrate:down
drop table pulse.onboarding_sort_receipt;
