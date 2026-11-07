-- migrate:up
create table pulse.people_profile (
  org_id uuid not null references pulse.org(id),
  person_id uuid primary key references pulse.person(id),
  role text not null,
  pod text,
  accounts text[] not null default '{}',
  evidence text not null
);
create table pulse.index_file (
  org_id uuid not null references pulse.org(id),
  file_id text not null,
  name text not null,
  mime text not null,
  path text not null,
  project_id uuid references pulse.project(id),
  uploader_account text,
  account_basis text not null,
  created_at timestamptz,
  modified_at timestamptz,
  observed_at timestamptz not null,
  event_seq bigint not null,
  primary key (org_id, file_id)
);
create table pulse.delivery (
  org_id uuid not null references pulse.org(id),
  file_id text not null,
  project_id uuid not null references pulse.project(id),
  uploader_account text,
  kind text not null check (kind in ('draft','final')),
  delivered_at timestamptz not null,
  rule text not null,
  rule_detail text not null,
  event_seq bigint not null,
  primary key (org_id, file_id),
  foreign key (org_id,file_id) references pulse.index_file(org_id,file_id)
);
create index delivery_week on pulse.delivery(org_id,delivered_at);
create index delivery_account on pulse.delivery(org_id,uploader_account,delivered_at);
create table pulse.index_version (
  org_id uuid not null references pulse.org(id),
  file_id text not null,
  modified_at timestamptz not null,
  event_seq bigint not null,
  observed_at timestamptz not null,
  primary key (org_id,file_id,modified_at),
  foreign key (org_id,file_id) references pulse.index_file(org_id,file_id)
);
create table pulse.attendance_entry (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references pulse.person(id),
  checked_in_at timestamptz not null default now(),
  checked_out_at timestamptz,
  check (checked_out_at is null or checked_out_at >= checked_in_at)
);
create unique index attendance_open on pulse.attendance_entry(org_id,person_id) where checked_out_at is null;
create table pulse.leave_request (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references pulse.person(id),
  from_date date not null,
  to_date date not null,
  leave_kind text not null check (leave_kind in ('annual','personal','sick')),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  check (to_date >= from_date)
);
do $$ declare t text; begin
  foreach t in array array['people_profile','index_file','delivery','index_version','attendance_entry','leave_request'] loop
    execute format('alter table pulse.%I enable row level security',t);
    execute format('alter table pulse.%I force row level security',t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())',t);
    execute format('grant select,insert,update,delete on pulse.%I to pulse_worker',t);
    execute format('grant select on pulse.%I to pulse_api',t);
  end loop;
end $$;
grant insert,update on pulse.attendance_entry,pulse.leave_request to pulse_api;
create policy attendance_person on pulse.attendance_entry as restrictive to pulse_api
 using (person_id = pulse.current_viewer() or exists (select 1 from pulse.role_assignment where person_id = pulse.current_viewer() and role_key in ('admin','hr')))
 with check (person_id = pulse.current_viewer() or exists (select 1 from pulse.role_assignment where person_id = pulse.current_viewer() and role_key in ('admin','hr')));
create policy leave_person on pulse.leave_request as restrictive to pulse_api
 using (person_id = pulse.current_viewer() or exists (select 1 from pulse.role_assignment where person_id = pulse.current_viewer() and role_key in ('admin','hr')))
 with check (person_id = pulse.current_viewer() or exists (select 1 from pulse.role_assignment where person_id = pulse.current_viewer() and role_key in ('admin','hr')));
-- migrate:down
