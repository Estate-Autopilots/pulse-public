-- migrate:up
-- Remember the latest emitted metadata revision per Drive file so index re-listing is idempotent.
create table pulse.drive_backfill_emission (
  org_id uuid not null references pulse.org(id),
  file_id text not null check (length(trim(file_id)) > 0),
  source_ref text not null check (length(trim(source_ref)) > 0),
  emitted_at timestamptz not null default now(),
  primary key (org_id, file_id)
);
alter table pulse.drive_backfill_emission enable row level security;
alter table pulse.drive_backfill_emission force row level security;
create policy tenant_isolation on pulse.drive_backfill_emission
  using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse.drive_backfill_emission from public, pulse_api, pulse_ingest, pulse_privacy;
grant select, insert, update on pulse.drive_backfill_emission to pulse_worker;
