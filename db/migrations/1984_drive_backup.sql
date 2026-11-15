-- migrate:up
-- COMPANY-OPS (owner, 10 Nov 2026: "Backup to Google Drive … extremely important"): a company's Docs are copied into a
-- Google Drive folder, nightly and on demand. Folders are mirrored; each doc goes as a PDF and a Word file, with its files.
-- Pulse signs in to Drive as the install's Google service account (set by the owner on the server, never stored here);
-- the company's admin shares a Drive folder (in a shared drive) with that account and turns the backup on in Settings →
-- Connected apps. The backup reads Docs as that admin (row security): it copies what the admin can open, and nothing else.
--   pulse.drive_backup_setting  one row per company: on or off, the Drive folder, the admin it runs as;
--   pulse.drive_backup_item     what is in Drive already (so a run updates files in place and skips unchanged docs);
--   pulse.drive_backup_run      each run: when, why (nightly or on demand), what it copied, the first problems.
create table pulse.drive_backup_setting (
  org_id uuid primary key references pulse.org(id) on delete cascade,
  enabled boolean not null default false,
  folder_id text check (folder_id is null or folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  run_as uuid references pulse.person(id),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default clock_timestamp(),
  check (not enabled or (folder_id is not null and run_as is not null))
);
create table pulse.drive_backup_item (
  org_id uuid not null references pulse.org(id) on delete cascade,
  kind text not null check (kind in ('root', 'folder', 'doc_pdf', 'doc_docx', 'file')),
  ref_id uuid not null,
  drive_id text not null check (drive_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  parent_drive_id text,
  fingerprint text not null,
  synced_at timestamptz not null default clock_timestamp(),
  primary key (org_id, kind, ref_id)
);
create table pulse.drive_backup_run (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id) on delete cascade,
  reason text not null check (reason in ('nightly', 'on_demand')),
  started_by uuid references pulse.person(id),
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  ok boolean,
  counts jsonb not null default '{}'::jsonb,
  problems jsonb not null default '[]'::jsonb,
  error text check (error is null or length(error) <= 500)
);
create index drive_backup_run_org on pulse.drive_backup_run (org_id, started_at desc);

-- Row security: the company's own rows only. Anyone in the company may read whether its Docs are backed up (the setting
-- holds no secret); only an admin turns it on, runs it, or records what was copied (the nightly run acts as its admin).
alter table pulse.drive_backup_setting enable row level security;
alter table pulse.drive_backup_setting force row level security;
create policy tenant_isolation on pulse.drive_backup_setting using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy drive_backup_setting_admin on pulse.drive_backup_setting as restrictive for insert to pulse_api with check (pulse.viewer_is('admin'));
create policy drive_backup_setting_admin_update on pulse.drive_backup_setting as restrictive for update to pulse_api using (pulse.viewer_is('admin')) with check (pulse.viewer_is('admin'));
revoke all on pulse.drive_backup_setting from public;
grant select, insert, update on pulse.drive_backup_setting to pulse_api;

alter table pulse.drive_backup_item enable row level security;
alter table pulse.drive_backup_item force row level security;
create policy tenant_isolation on pulse.drive_backup_item using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy drive_backup_item_admin on pulse.drive_backup_item as restrictive for all to pulse_api using (pulse.viewer_is('admin')) with check (pulse.viewer_is('admin'));
revoke all on pulse.drive_backup_item from public;
grant select, insert, update, delete on pulse.drive_backup_item to pulse_api;

alter table pulse.drive_backup_run enable row level security;
alter table pulse.drive_backup_run force row level security;
create policy tenant_isolation on pulse.drive_backup_run using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy drive_backup_run_admin on pulse.drive_backup_run as restrictive for all to pulse_api using (pulse.viewer_is('admin')) with check (pulse.viewer_is('admin'));
revoke all on pulse.drive_backup_run from public;
grant select, insert, update on pulse.drive_backup_run to pulse_api;

-- migrate:down
drop table if exists pulse.drive_backup_run;
drop table if exists pulse.drive_backup_item;
drop table if exists pulse.drive_backup_setting;
