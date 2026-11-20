-- migrate:up
-- The full company roster and HR records. Every person carries the sources that name them and a flag where the
-- sources disagree. Salary, personal contact details and HR document names live in pulse_priv: the API role has no
-- access to that schema and reads them only through the functions below, which require the HR or admin role AND a
-- separate permission, and write every read to privacy.access_log. Government ID numbers and scans are never
-- imported; pulse_priv.hr_document records only that such a document is on file.

alter table pulse.people_profile
  add column department      text,
  add column employment_type text check (employment_type in ('full_time','part_time','intern','contract','freelance')),
  add column field_sources   jsonb not null default '{}';     -- field -> {source, detail, confirm}

create table pulse.person_source (                            -- one row per place a person is named
  org_id       uuid not null references pulse.org(id),
  person_id    uuid not null references pulse.person(id) on delete cascade,
  source       text not null,                                 -- ops_hub | groups_roster | workspace_directory | hr_document | pulse
  source_ref   text not null,                                 -- stable key inside the source (group, file id and sheet)
  label        text not null,                                 -- shown to people: "Planned groups roster · pod2@"
  written_name text not null,
  role         text,
  grp          text,                                          -- pod, department or group as the source states it
  last_seen    date,                                          -- the month the source speaks about, when it has one
  restricted   boolean not null default false,                -- HR documents: listed for HR and admins only
  seen_at      timestamptz not null default now(),
  primary key (person_id, source, source_ref)
);
create index person_source_org on pulse.person_source (org_id, person_id);

create table pulse.person_flag (                              -- "needs confirmation": sources disagree about a field
  org_id       uuid not null references pulse.org(id),
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid not null references pulse.person(id) on delete cascade,
  field        text not null,                                 -- pod | role | identity | status | joined_on | name
  summary      text not null,
  options      jsonb not null default '[]',                   -- [{value, source}]
  status       text not null default 'open' check (status in ('open','resolved')),
  resolution   text,
  resolved_by  uuid references pulse.person(id),
  resolved_at  timestamptz,
  created_at   timestamptz not null default now(),
  unique (person_id, field)
);
create index person_flag_open on pulse.person_flag (org_id, status);

create table pulse.sensitive_permission (                     -- the column-level permission, separate from the role
  org_id     uuid not null references pulse.org(id),
  person_id  uuid not null references pulse.person(id) on delete cascade,
  permission text not null check (permission in ('hr.salary.read','hr.contact.read','hr.contact.write','hr.documents.read')),
  granted_by text not null,
  granted_at timestamptz not null default now(),
  primary key (person_id, permission)
);

create table pulse_priv.hr_compensation (
  org_id          uuid not null references pulse.org(id),
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references pulse.person(id) on delete cascade,
  effective_month date not null,
  kind            text not null check (kind in ('monthly','current','increment','total')),
  amount          numeric(12,2) not null check (amount > 0),
  currency        text not null default 'INR',
  source_file_id  text not null,
  source_name     text not null,
  source_sheet    text not null,
  basis           text not null,                              -- how the figure was read from the sheet
  imported_at     timestamptz not null default now(),
  unique (person_id, kind, effective_month, source_file_id, source_sheet)
);
create index hr_compensation_person on pulse_priv.hr_compensation (org_id, person_id, effective_month desc);

create table pulse_priv.hr_contact (                          -- personal contact details
  org_id         uuid not null references pulse.org(id),
  person_id      uuid primary key references pulse.person(id) on delete cascade,
  personal_email text,
  personal_phone text,
  emergency      text,
  source         text not null default 'Entered in Pulse',
  updated_by     uuid references pulse.person(id),
  updated_at     timestamptz not null default now()
);

create table pulse_priv.hr_document (                         -- names only; ID documents: on file yes/no, no name
  org_id    uuid not null references pulse.org(id),
  id        uuid primary key default gen_random_uuid(),
  person_id uuid not null references pulse.person(id) on delete cascade,
  doc_type  text not null check (doc_type in ('appointment_letter','joining_letter','offer_letter','salary_certificate',
                                              'relieving_letter','resume','id_aadhaar','id_pan','id_passport','bank_details')),
  file_id   text,                                             -- null for ID and bank documents
  file_name text,                                             -- null for ID and bank documents
  location  text,                                             -- the Drive folder, without the file name
  seen_at   timestamptz not null default now()
);
create unique index hr_document_once on pulse_priv.hr_document (person_id, doc_type, coalesce(file_id, ''));

do $$ declare t text; begin
  foreach t in array array['person_source','person_flag','sensitive_permission'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select, insert, update, delete on pulse.%I to pulse_worker', t);
    execute format('grant select on pulse.%I to pulse_api', t);
  end loop;
  foreach t in array array['hr_compensation','hr_contact','hr_document'] loop
    execute format('alter table pulse_priv.%I enable row level security', t);
    execute format('alter table pulse_priv.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse_priv.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select, insert, update, delete on pulse_priv.%I to pulse_worker', t);
  end loop;
end $$;
grant update (status, resolution, resolved_by, resolved_at) on pulse.person_flag to pulse_api;
create policy flag_resolve on pulse.person_flag as restrictive for update to pulse_api
  using (pulse.viewer_is('admin','hr')) with check (pulse.viewer_is('admin','hr'));
-- HR-document sources are listed for HR and admins only.
create policy source_visible on pulse.person_source as restrictive for select to pulse_api
  using (not restricted or pulse.viewer_is('admin','hr'));

-- The viewer holds the HR or admin role and has been given this permission by name.
create function pulse.hr_can(p_permission text) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select pulse.viewer_is('admin','hr') and exists (
    select 1 from sensitive_permission
     where org_id = pulse.current_org() and person_id = pulse.current_viewer() and permission = p_permission)
$$;

-- Row-level security on the restricted tables binds every reader except the sync worker, the function owner included.
do $$ begin
  execute format($f$create policy salary_reader on pulse_priv.hr_compensation as restrictive for select to %I
    using (pulse.hr_can('hr.salary.read'))$f$, current_user);
  execute format($f$create policy contact_reader on pulse_priv.hr_contact as restrictive for select to %I
    using (pulse.hr_can('hr.contact.read'))$f$, current_user);
  execute format($f$create policy contact_writer on pulse_priv.hr_contact as restrictive for insert to %I
    with check (pulse.hr_can('hr.contact.write'))$f$, current_user);
  execute format($f$create policy contact_updater on pulse_priv.hr_contact as restrictive for update to %I
    using (pulse.hr_can('hr.contact.write')) with check (pulse.hr_can('hr.contact.write'))$f$, current_user);
  execute format($f$create policy document_reader on pulse_priv.hr_document as restrictive for select to %I
    using (pulse.hr_can('hr.documents.read'))$f$, current_user);
end $$;

create function pulse.hr_log(p_subject uuid, p_resource text, p_purpose text) returns void
  language sql security definer set search_path = pulse, pg_temp as $$
  insert into privacy.access_log(org_id, viewer_id, subject_person_id, resource, grain, purpose)
  values (pulse.current_org(), pulse.current_viewer(), p_subject, p_resource, 'person', p_purpose)
$$;

-- Salary history of one person. Every call is written to the access log before any row is returned.
create function pulse.hr_salary_read(p_person uuid)
  returns table (id uuid, effective_month date, kind text, amount numeric, currency text,
                 source_name text, source_sheet text, basis text, imported_at timestamptz)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not pulse.hr_can('hr.salary.read') then raise exception 'salary access denied' using errcode = '42501'; end if;
  perform pulse.hr_log(p_person, 'hr.salary', 'hr_profile_view');
  return query select c.id, c.effective_month, c.kind, c.amount, c.currency, c.source_name, c.source_sheet, c.basis, c.imported_at
    from pulse_priv.hr_compensation c where c.person_id = p_person
    order by c.effective_month desc, c.kind, c.source_name;
end $$;

create function pulse.hr_contact_read(p_person uuid)
  returns table (personal_email text, personal_phone text, emergency text, source text, updated_at timestamptz)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not pulse.hr_can('hr.contact.read') then raise exception 'contact access denied' using errcode = '42501'; end if;
  perform pulse.hr_log(p_person, 'hr.contact', 'hr_profile_view');
  return query select c.personal_email, c.personal_phone, c.emergency, c.source, c.updated_at
    from pulse_priv.hr_contact c where c.person_id = p_person;
end $$;

create function pulse.hr_contact_write(p_person uuid, p_email text, p_phone text, p_emergency text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not pulse.hr_can('hr.contact.write') then raise exception 'contact access denied' using errcode = '42501'; end if;
  perform pulse.hr_log(p_person, 'hr.contact', 'hr_profile_edit');
  insert into pulse_priv.hr_contact(org_id, person_id, personal_email, personal_phone, emergency, updated_by)
    values (pulse.current_org(), p_person, nullif(trim(p_email), ''), nullif(trim(p_phone), ''), nullif(trim(p_emergency), ''), pulse.current_viewer())
    on conflict (person_id) do update set personal_email = excluded.personal_email, personal_phone = excluded.personal_phone,
      emergency = excluded.emergency, source = 'Entered in Pulse', updated_by = excluded.updated_by, updated_at = now();
end $$;

create function pulse.hr_documents_read(p_person uuid)
  returns table (doc_type text, file_id text, file_name text, location text, seen_at timestamptz)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not pulse.hr_can('hr.documents.read') then raise exception 'document access denied' using errcode = '42501'; end if;
  perform pulse.hr_log(p_person, 'hr.documents', 'hr_profile_view');
  return query select d.doc_type, d.file_id, d.file_name, d.location, d.seen_at
    from pulse_priv.hr_document d where d.person_id = p_person order by d.doc_type, d.file_name;
end $$;

-- Who read restricted HR data, newest first: for the people who may read it themselves.
create function pulse.hr_access_log(p_person uuid, p_limit int default 20)
  returns table (at timestamptz, viewer text, resource text, purpose text)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not pulse.hr_can('hr.salary.read') then raise exception 'access denied' using errcode = '42501'; end if;
  return query select l.at, p.display_name, l.resource, l.purpose from privacy.access_log l
    left join pulse.person p on p.id = l.viewer_id
    where l.org_id = pulse.current_org() and l.subject_person_id = p_person and l.resource like 'hr.%'
    order by l.at desc limit least(p_limit, 100);
end $$;

revoke all on function pulse.hr_can(text), pulse.hr_log(uuid, text, text), pulse.hr_salary_read(uuid),
  pulse.hr_contact_read(uuid), pulse.hr_contact_write(uuid, text, text, text), pulse.hr_documents_read(uuid),
  pulse.hr_access_log(uuid, int) from public;
grant execute on function pulse.hr_can(text), pulse.hr_salary_read(uuid), pulse.hr_contact_read(uuid),
  pulse.hr_contact_write(uuid, text, text, text), pulse.hr_documents_read(uuid), pulse.hr_access_log(uuid, int) to pulse_api;
grant execute on function pulse.hr_can(text) to pulse_worker;
-- migrate:down
