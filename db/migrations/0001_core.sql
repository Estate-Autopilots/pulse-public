-- migrate:up
-- =====================================================================================================================
-- Pulse core schema v1: the Event Core (spec appendix A v0.3, 02-domain-model, 05 §6-§9, 06 §8).
--
-- Applied by pulse-migrate (dbmate-compatible file format and schema_migrations table) as the database's owner role
-- (SET ROLE by the runner: pulse_owner for production, pulse_<env>_owner for staging and dev, so a login for one
-- environment owns nothing in another), after db/roles.sql (appendix A0) and the extensions exist.
-- Forward-only: never edit this file once applied anywhere; add 0002_… instead.
--
-- Differences from appendix A (v0.2 draft), decided while building the Event Core:
--   * Writers insert with ON CONFLICT DO NOTHING (no conflict target, no RETURNING), so the API and ingest roles
--     need no SELECT privilege at all on the log; event.org_id references pulse.org.
--   * The event registry lives in the database too (pulse.event_type, synced from packages/schemas/registry.yaml by
--     pulse-migrate). A trigger on both log tables rejects unknown types, events without a purpose or with a purpose
--     outside the type's list, sensitivity below the floor, visibility looser than the floor, emitters not allowed,
--     malformed subjects, missing required and undeclared data fields (ADR-0025), and sets the retention class.
--     Every writer (ingest, API, workers, SQL functions) gets the same checks, not only the ingest service.
--   * Projection ids are deterministic (uuid v5 from natural keys) and foreign keys into projection tables are
--     DEFERRABLE, so a rebuild deletes and replays a tenant's projections in one transaction and produces identical
--     rows (02 §5 rebuild rule).
--   * pulse.folder (Drive folder tree under bound project roots), asset.legacy_key, version.md5/evidence,
--     attribution.version_id/evidence are added for detection and attribution.
--   * Partition maintenance, partition drops and retention redaction are SECURITY DEFINER functions with fixed
--     rules (callers cannot pass a date that would delete unexpired data).
--   * resolve_route() refuses to switch a transaction that already belongs to another tenant.
--   * Partitions are created after the grants, so no runtime role holds privileges on a partition directly
--     (all access goes through the parent tables, where row-level security applies). Partition functions pin
--     TimeZone = UTC and DateStyle = ISO; the trigger rejects times outside [now - 210 d, now + 24 h] and resets
--     the system columns (seq, tx_id, recorded_at, redacted_at, redaction_hash).
--   * pulse.projection_error quarantines events a projection cannot apply, so one bad event never stops a tenant.
--   * Retention overrides must be whole numbers between the class's legal floor (min_days) and its ceiling.
-- =====================================================================================================================

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'vector') then
    raise exception 'extension vector is missing: the database administrator creates vector, pg_trgm and pgcrypto first';
  end if;
  if (select rolsuper or rolbypassrls or rolcanlogin from pg_roles where rolname = current_user) then
    raise exception 'run migrations as the owner group role (pulse-migrate sets it), not as % directly', current_user;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'pulse_api') then
    raise exception 'service roles are missing: run db/roles.sql (appendix A0) first';
  end if;
end $$;

create schema pulse;
create schema pulse_priv;
create schema privacy;
create schema pulse_route;                       -- no RLS; reachable only through SECURITY DEFINER functions

-- ------------------------------------------------------------------------------------------------- session helpers
-- Every transaction of the API, ingest and workers runs with  SET LOCAL pulse.org_id = '<uuid>'
-- (and pulse.viewer_id for the API). Unset or empty means "no tenant": every tenant table then returns no rows.
create function pulse.current_org() returns uuid
  language sql stable as $$ select nullif(current_setting('pulse.org_id', true), '')::uuid $$;
create function pulse.current_viewer() returns uuid
  language sql stable as $$ select nullif(current_setting('pulse.viewer_id', true), '')::uuid $$;
create function pulse.visibility_rank(v text) returns int
  language sql immutable as $$ select case v when 'person' then 0 when 'team' then 1 when 'org' then 2 end $$;
-- A date from event data, or null when it is not a valid ISO date (one bad event never breaks a query).
create function pulse.safe_date(v text) returns date
  language plpgsql stable as $$
begin
  return case when v ~ '^\d{4}-\d{2}-\d{2}$' then v::date end;
exception when others then
  return null;
end $$;

-- ---------------------------------------------------------------------------------------------------- tenancy
create table pulse.org (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  code          text not null unique check (code ~ '^[A-Z]{2,4}$'),   -- CID prefix, e.g. EA
  time_zone     text not null default 'Asia/Kolkata',
  data_region   text not null default 'in' check (data_region in ('in','eu','us','other')),
  status        text not null default 'active' check (status in ('active','suspended','offboarding')),
  created_at    timestamptz not null default now()
);

create table pulse.tenant_config (                          -- versioned configuration documents (02 §6)
  org_id        uuid not null references pulse.org(id),
  doc_kind      text not null check (doc_kind in ('tenant','role_pack','phase_plan','folder_rules','benchmarks',
                                                  'packages','visibility_policy','retention_policy','rubric')),
  doc_key       text not null,
  version       int  not null,
  body          jsonb not null,                             -- validated against packages/schemas/config/<doc_kind>.json
  is_active     boolean not null default false,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  primary key (org_id, doc_kind, doc_key, version)
);
create unique index tenant_config_one_active on pulse.tenant_config (org_id, doc_kind, doc_key) where is_active;

-- ---------------------------------------------------------------------------------------------------- people
create table pulse.unit (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  parent_id     uuid references pulse.unit(id),
  kind          text not null check (kind in ('org','department','team','pod','project_team')),
  name          text not null,
  head_person_id uuid,
  valid_from    date not null default current_date,
  valid_to      date
);

create table pulse.person (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  display_name  text not null,
  side          text not null check (side in ('staff','freelancer','client','channel_partner','talent','vendor','other')),
  status        text not null default 'active' check (status in ('active','inactive','offboarded')),
  tracking_excluded boolean not null default false,         -- e.g. under 18 (DPDP s.9(3)); no person-level collection
  active_from   date,
  active_to     date,
  created_at    timestamptz not null default now()
);
alter table pulse.unit add constraint unit_head_fk foreign key (head_person_id) references pulse.person(id);

create table pulse_priv.person_private (                    -- contact data; never KYC, salary or bank data
  person_id     uuid primary key references pulse.person(id),
  org_id        uuid not null references pulse.org(id),
  legal_name    text,
  work_email    text,
  phone_e164    text,
  phone_hash    text,
  locale        text default 'en-IN'
);

create table pulse.role_assignment (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  person_id     uuid not null references pulse.person(id),
  unit_id       uuid references pulse.unit(id),
  role_key      text not null,
  is_manager_of_unit boolean not null default false,
  capacity_share numeric(3,2) not null default 1.00 check (capacity_share > 0 and capacity_share <= 1),
  valid_from    date not null,
  valid_to      date
);
create index role_assignment_person on pulse.role_assignment (org_id, person_id);

create table pulse.account (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  provider      text not null,
  handle        text not null,                              -- lower-case for e-mail handles
  holder_person_id uuid references pulse.person(id),        -- null for shared accounts
  is_shared     boolean not null default false,
  is_company_owned boolean not null default true,
  purpose       text,
  unique (org_id, provider, handle),
  check (not (is_shared and holder_person_id is not null))  -- a shared login never resolves to one person (02 §4.1)
);

create table pulse.device (                                 -- enrolled computers running the Pulse agent
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  default_person_id uuid references pulse.person(id),       -- null for shared edit stations
  platform      text not null check (platform in ('windows','macos','linux')),
  label         text,
  agent_version text,
  public_key    text not null,                              -- Ed25519 raw public key, base64
  enrolled_at   timestamptz not null default now(),
  revoked_at    timestamptz
);
create table pulse.device_assignment (                      -- who is working on a device (shared-station switcher)
  org_id        uuid not null references pulse.org(id),
  device_id     uuid not null references pulse.device(id),
  person_id     uuid not null references pulse.person(id),
  valid_from    timestamptz not null,
  valid_to      timestamptz,
  primary key (device_id, valid_from)
);

create table pulse.enrolment_code (                         -- one-time codes for devices and bot linking (05 §8.3)
  code_hash     text primary key,                           -- sha256 of the code; the code itself is never stored
  org_id        uuid not null references pulse.org(id),
  person_id     uuid not null references pulse.person(id),
  kind          text not null check (kind in ('device','telegram','whatsapp')),
  expires_at    timestamptz not null,                       -- 15 minutes after creation
  used_at       timestamptz
);

-- The identity map (02 §4): source keys -> Pulse entities, with method, confidence, validity and evidence.
-- Person links for logins use entity_type 'person', source 'account', source_key '<provider>:<handle>'.
create table pulse.identity_link (
  org_id        uuid not null references pulse.org(id),
  entity_type   text not null check (entity_type in ('person','account','device','client','offering','project',
                                                     'place','party_org','buyer','asset','campaign','ad')),
  entity_id     uuid not null,
  source        text not null,
  source_key    text not null,
  raw_value     text,
  method        text not null check (method in ('exact','normalised','fuzzy','via_relation','evidence','manual')),
  confidence    numeric(3,2) not null default 1.0,
  valid_from    timestamptz not null default '-infinity',
  valid_to      timestamptz,
  evidence      jsonb not null default '{}',
  confirmed_by  uuid references pulse.person(id),
  confirmed_at  timestamptz,
  primary key (org_id, entity_type, source, source_key, valid_from)
);
create index identity_link_entity on pulse.identity_link (org_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------------------------- clients and work
create table pulse.party_org (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  name          text not null,
  kind          text not null check (kind in ('developer','channel_partner','agency','vendor','other')),
  domain        text,
  aliases       text[] not null default '{}'
);

create table pulse.place (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  name          text not null,
  kind          text not null default 'micro_market' check (kind in ('micro_market','city','region','country')),
  parent_id     uuid references pulse.place(id),
  aliases       text[] not null default '{}'
);

create table pulse.client (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  display_name  text not null,
  client_type   text not null default 'other' check (client_type in ('developer','channel_partner','agent','brand','internal','other')),
  party_org_id  uuid references pulse.party_org(id),
  primary_contact_id uuid references pulse.person(id),
  email_domains text[] not null default '{}',               -- used to recognise client replies and shares
  status        text check (status in ('prospect','active','paused','churned'))
);

create table pulse.offering (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  name          text,
  party_org_id  uuid references pulse.party_org(id),
  place_id      uuid references pulse.place(id),
  segment       text,
  attributes    jsonb not null default '{}'
);

create table pulse.project (                                -- one piece of client work (first tenant: engagement)
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  registry_no   int  not null check (registry_no > 0),      -- display "EA-0584"; in CIDs "EA0584" (02 §4.4)
  client_id     uuid references pulse.client(id),
  offering_id   uuid references pulse.offering(id),
  name          text not null,
  package_key   text,
  capacity_units numeric(3,1),
  lead_person_id uuid references pulse.person(id),          -- first tenant: PGS
  unit_id       uuid references pulse.unit(id),
  start_month   date,
  status        text not null default 'active' check (status in ('onboarding','active','paused','done','cancelled')),
  storage_root  text,                                       -- bound root, e.g. gdrive:<folder id> (never parsed from names)
  unique (org_id, registry_no)
);

create table pulse.phase (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  project_id    uuid not null references pulse.project(id),
  phase_key     text not null,
  planned_start date, planned_end date,
  status        text not null default 'not_started' check (status in ('not_started','in_progress','blocked','done','skipped')),
  unique (project_id, phase_key)
);

-- Projection (from task.* events). Ids come from the events' subjects.
create table pulse.task (
  id            uuid primary key,
  org_id        uuid not null references pulse.org(id),
  project_id    uuid references pulse.project(id),
  phase_key     text,
  template_step text,
  title         text not null,
  assignee_person_id uuid references pulse.person(id),
  role_key      text,
  deliverable_type text,
  planned_units numeric(5,2),
  assigned_at   timestamptz,
  due_at        timestamptz,
  status        text not null default 'open' check (status in ('open','in_progress','blocked','in_review','done','cancelled')),
  source        text not null default 'pulse',              -- pulse | ops_tool | imported
  source_ref    text
);
create index task_assignee on pulse.task (org_id, assignee_person_id, status);

create table pulse.cid_counter (                            -- allocates <nn> per project and type (02 §4.4)
  org_id        uuid not null references pulse.org(id),
  project_id    uuid not null references pulse.project(id),
  type_code     text not null check (type_code ~ '^[A-Z]{2}$'),
  last_num      int  not null default 0,
  primary key (org_id, project_id, type_code)
);

-- Projection: Drive folders under bound project roots, classified by the tenant's folder rules (appendix F.1).
create table pulse.folder (
  org_id        uuid not null references pulse.org(id),
  store         text not null,                              -- gdrive
  store_id      text not null,
  parent_store_id text,
  name          text,
  project_id    uuid references pulse.project(id),          -- set when the folder is (under) a bound root
  path          text[],                                     -- normalised names below the root (root excluded)
  role          text,                                       -- root | deliverables | input:<kind> | other | ignore
  version_kind  text check (version_kind in ('draft','final')),
  trashed       boolean not null default false,
  last_seq      bigint not null,
  primary key (org_id, store, store_id)
);
create index folder_parent on pulse.folder (org_id, store, parent_store_id);

-- Projection: files in their stores (bytes stay there). Id = uuid v5 of (org, store, store_id).
create table pulse.file (
  id            uuid primary key,
  org_id        uuid not null references pulse.org(id),
  store         text not null,
  store_id      text not null,
  name          text,
  mime          text,
  size_bytes    bigint,
  md5           text, sha256 text,
  duration_ms   int, width int, height int,
  parent_store_id text,
  owner_account_id uuid references pulse.account(id),
  created_at    timestamptz,
  trashed_at    timestamptz,
  first_seq     bigint not null,
  last_seq      bigint not null,
  unique (org_id, store, store_id)
);
create index file_md5 on pulse.file (org_id, md5) where md5 is not null;

-- Projection (asset.issued events, CID detection, legacy deliverables). An asset is one deliverable across versions.
create table pulse.asset (
  id            uuid primary key,
  org_id        uuid not null references pulse.org(id),
  project_id    uuid references pulse.project(id),
  task_id       uuid references pulse.task(id) deferrable initially immediate,
  cid           text,                                       -- EA0584-HK03 (version and variant live on version)
  legacy_key    text,                                       -- file:gdrive:<id> for a legacy-named deliverable
  deliverable_type text not null,                           -- role-pack type code, 'unknown' for legacy names
  family        text,
  title         text,
  parent_asset_id uuid references pulse.asset(id) deferrable initially immediate,
  issued_by     text not null default 'api' check (issued_by in ('api','detection','import')),
  status        text not null default 'in_progress' check (status in ('planned','in_progress','in_review','client_review',
                                                         'approved','live','dropped')),
  first_seq     bigint not null,
  unique (org_id, cid),
  unique (org_id, legacy_key),
  check (cid is not null or legacy_key is not null)
);

-- Projection: one iteration of an asset. Id = uuid v5 of (asset, version_no, variant).
create table pulse.version (
  id            uuid primary key,
  org_id        uuid not null references pulse.org(id),
  asset_id      uuid not null references pulse.asset(id) deferrable initially immediate,
  version_no    int  not null,
  variant       text,                                       -- 9x16, 1x1 … (from the CID suffix)
  kind          text not null check (kind in ('draft','revision','final','variant','reupload')),
  file_id       uuid references pulse.file(id) deferrable initially immediate,
  md5           text,                                       -- content fingerprint: the same bytes are the same version
  created_at    timestamptz not null,
  creator_person_id uuid references pulse.person(id),
  attribution_p numeric(4,3),
  existence_confidence numeric(4,3),                        -- 03 §9.1
  evidence      jsonb not null default '{}',                -- which signals support existence (no person-only detail)
  ready_at      timestamptz,                                -- creator marked "ready for review"
  shared_with_client_at timestamptz,
  approved_at   timestamptz,
  unique nulls not distinct (asset_id, version_no, variant)
);
create index version_md5 on pulse.version (org_id, md5) where md5 is not null;
create index version_file on pulse.version (org_id, file_id);

create table pulse.input (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  project_id    uuid not null references pulse.project(id),
  asset_id      uuid references pulse.asset(id) deferrable initially immediate,
  input_kind    text not null,                              -- raw_footage, approved_script, blueprint, brochure, brand_guide …
  expected_at   timestamptz,
  received_at   timestamptz,
  file_count    int,
  storage_ref   text,
  paired_by     text check (paired_by in ('rule','declared'))
);

create table pulse.blocker (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  task_id       uuid references pulse.task(id) deferrable initially immediate,
  project_id    uuid references pulse.project(id),
  blocker_key   text not null,
  opened_at     timestamptz not null,
  closed_at     timestamptz,
  owner_side    text not null check (owner_side in ('client','internal','external','person','unknown')),
  source        text not null check (source in ('rule','declared','manager')),
  status        text not null default 'open' check (status in ('open','confirmed','disputed','closed')),
  confirmed_by  uuid references pulse.person(id),           -- or rule id in evidence when auto-confirmed
  evidence      jsonb not null default '{}',
  rule_version  int
);

create table pulse.milestone (                              -- projection: first_draft / final / approved per asset
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  asset_id      uuid not null references pulse.asset(id) deferrable initially immediate,
  task_id       uuid references pulse.task(id) deferrable initially immediate,
  version_id    uuid references pulse.version(id) deferrable initially immediate,
  person_id     uuid references pulse.person(id),
  kind          text not null,                              -- from the role pack: first_draft, final, approved
  deliverable_type text not null,
  unit_credit   numeric(5,2) not null,
  achieved_at   timestamptz not null,
  projection_version int not null,
  unique (org_id, asset_id, kind, projection_version)
);

create table pulse.review (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  version_id    uuid not null references pulse.version(id) deferrable initially immediate,
  reviewer_kind text not null check (reviewer_kind in ('ai','human','client')),
  reviewer_person_id uuid references pulse.person(id),
  model_name    text, model_version text, rubric_key text, rubric_version int,
  verdict       text check (verdict in ('approved','revision_required','review_blocked')),
  scores        jsonb not null default '{}',
  strengths     jsonb not null default '[]',
  escalations   jsonb not null default '[]',
  missing_inputs text[] not null default '{}',
  is_beta       boolean not null default false,
  cost_usd      numeric(8,4),
  created_at    timestamptz not null default now()
);

create table pulse.review_note (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  review_id     uuid not null references pulse.review(id),
  t_start_ms    int, t_end_ms int,
  region        jsonb,
  dimension     text not null,
  change_required text not null,
  why           text not null,
  severity      smallint not null check (severity between 1 and 3),
  confidence    numeric(3,2),
  response      text check (response in ('done','accepted','rejected','not_applicable')),   -- rejected = "disagree"
  response_reason text,
  usefulness    text check (usefulness in ('useful','not_useful','unknown')),               -- 04 M2.4
  embedding     vector(1024)
);

-- -------------------------------------------------------------------------------------------- ads and funnel
create table pulse.campaign (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  platform      text not null check (platform in ('meta','google','youtube','linkedin','other')),
  platform_id   text not null,
  ad_account    text,
  project_id    uuid references pulse.project(id),
  name          text not null,
  objective     text,
  unique (org_id, platform, platform_id)
);
create table pulse.ad_set (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  campaign_id   uuid not null references pulse.campaign(id),
  platform_id   text not null,
  name          text,
  audience_kind text,
  daily_budget  numeric(12,2),
  study_id      text, cell_id text,                         -- Meta ad_studies membership (Tier A evidence)
  unique (org_id, campaign_id, platform_id)
);
create table pulse.ad (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  ad_set_id     uuid not null references pulse.ad_set(id),
  platform_id   text not null,
  name          text not null,
  cid           text,
  version_id    uuid references pulse.version(id) deferrable initially immediate,
  link_method   text check (link_method in ('cid','upload_id','name','manual','unresolved')),
  unique (org_id, ad_set_id, platform_id)
);
create table pulse.ad_metric_day (
  org_id        uuid not null references pulse.org(id),
  ad_id         uuid not null references pulse.ad(id),
  day           date not null,
  placement     text not null default 'all',
  spend         numeric(12,2), currency text,
  impressions   bigint, reach bigint,
  video_3s_plays bigint, thruplays bigint,
  link_clicks   bigint, leads int,
  attribution_setting text,
  pulled_at     timestamptz not null default now(),
  primary key (org_id, ad_id, day, placement)
);

create table pulse_priv.buyer (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  phone_hash    text not null,
  full_name     text, phone_e164 text, email text, city text,
  unique (org_id, phone_hash)
);
create table pulse.lead (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  buyer_id      uuid not null,                              -- -> pulse_priv.buyer(id)
  project_id    uuid references pulse.project(id),
  ad_id         uuid references pulse.ad(id),
  cid           text,
  platform_lead_id text,
  created_at    timestamptz not null,
  status        text check (status in ('new','contacted','no_answer','not_interested','qualified','visit_planned',
                                       'visited','negotiating','booked','lost')),
  unique (org_id, platform_lead_id)
);
create table pulse.visit (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  lead_id       uuid not null references pulse.lead(id),
  planned_at    timestamptz, done_at timestamptz,
  status        text check (status in ('planned','done','no_show','cancelled')),
  source        text not null
);
create table pulse.booking (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  lead_id       uuid not null references pulse.lead(id),
  booked_on     date,
  source        text not null
);

-- ------------------------------------------------------------------------------------------------------ privacy
create table privacy.purpose (                              -- global, canonical list (02 §3.2)
  code          text primary key,
  description   text not null,
  basis_in      text not null check (basis_in in ('employment','consent','not_personal','contract','legal_obligation')),
  basis_eu      text
);
insert into privacy.purpose (code, description, basis_in, basis_eu) values
  ('delivery',         'Deliverables, versions, attribution, milestones, blockers, delivery score', 'employment', 'legitimate_interest'),
  ('quality',          'AI and human reviews of drafts, skill map, experiments',                    'employment', 'legitimate_interest'),
  ('coaching',         'Coach messages, micro-lessons, nudges',                                      'employment', 'legitimate_interest'),
  ('voice',            'Transcription of voice notes a person chooses to send',                      'consent',    'consent'),
  ('workload',         'Open work, deadlines, after-hours work artefacts, workload radar',           'employment', 'legitimate_interest'),
  ('outcomes',         'Ad and sales results linked to creatives',                                   'employment', 'legitimate_interest'),
  ('activity_context', 'Desktop agent hourly category totals (person-only)',                         'employment', 'consent'),
  ('after_hours',      'Desktop agent capture outside working hours',                                'consent',    'consent'),
  ('work_delta',       'Counts of changes between saves of editing project files (person-first)',   'employment', 'consent'),
  ('command_counts',   'Hourly counts of named editing commands in allow-listed creative apps',     'consent',    'not_offered'),
  ('wellbeing',        'On-device break reminders',                                                  'consent',    'consent'),
  ('presence',         'Day-level attendance',                                                       'employment', 'legitimate_interest'),
  ('office',           'Anonymous zone occupancy and environment',                                   'not_personal','legitimate_interest'),
  ('security',         'Security and access logs',                                                   'legal_obligation','legal_obligation'),
  ('privacy',          'Notices, consents, privacy requests, redactions',                            'legal_obligation','legal_obligation'),
  ('billing',          'Tenant billing (Pulse operator)',                                            'contract',   'contract');

create table privacy.retention_class (                      -- global; tenants choose values in [min_days, max_days]
  code          text primary key,
  min_days      int  not null check (min_days >= 1),        -- legal floor (06 §8), at least 1 day
  max_days      int  not null,
  default_days  int  not null check (default_days between min_days and max_days),
  action        text not null check (action in ('drop_partition','redact','aggregate_then_drop'))
);
insert into privacy.retention_class (code, min_days, max_days, default_days, action) values
  ('activity_raw',        1,   90,   60,  'drop_partition'),
  ('voice_raw',           1,   30,    7,  'redact'),
  ('work_metadata',       1,  730,  395,  'redact'),
  ('work_record',         1, 1095,  730,  'redact'),
  ('outcome',             1, 1825, 1125,  'redact'),
  ('office_aggregate',    1,  730,  395,  'redact'),
  ('security_log',      365,  730,  395,  'redact'),        -- Rule 6(e): logs kept at least one year
  ('legal',            2555, 2555, 2555,  'redact');        -- 7 years (unconfirmed; counsel, 06 §8)

create table privacy.notice (
  org_id        uuid not null references pulse.org(id),
  id            text not null,                              -- '2026-10-staff-v1'
  language      text not null,                              -- en, mr, hi …
  body_md       text not null,
  purposes      text[] not null,
  published_at  timestamptz not null,
  primary key (org_id, id, language)
);
create table privacy.notice_ack (
  org_id        uuid not null references pulse.org(id),
  person_id     uuid not null references pulse.person(id),
  notice_id     text not null,
  language      text not null,
  acknowledged_at timestamptz not null,
  channel       text not null,
  primary key (org_id, person_id, notice_id),
  foreign key (org_id, notice_id, language) references privacy.notice (org_id, id, language)
);
create table privacy.consent (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  person_id     uuid not null references pulse.person(id),
  purpose       text not null references privacy.purpose(code),
  scope         jsonb not null default '{}',
  notice_id     text, notice_language text,
  granted_at    timestamptz not null,
  withdrawn_at  timestamptz,
  channel       text not null,
  foreign key (org_id, notice_id, notice_language) references privacy.notice (org_id, id, language)
);
create table privacy.access_log (
  id            bigint generated always as identity primary key,
  org_id        uuid not null,
  viewer_id     uuid not null,
  subject_person_id uuid,
  resource      text not null,
  grain         text not null,
  purpose       text not null,
  at            timestamptz not null default now()
);
create table privacy.request (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  person_id     uuid not null references pulse.person(id),
  kind          text not null check (kind in ('access','correction','erasure','grievance','nomination','withdraw_consent')),
  status        text not null default 'open' check (status in ('open','in_progress','done','rejected')),
  opened_at     timestamptz not null default now(),
  due_at        timestamptz not null,
  closed_at     timestamptz
);

-- --------------------------------------------------------------------------------------------- event registry
-- Global (no org_id): the registry is a product artefact. Synced from packages/schemas/registry.yaml by pulse-migrate
-- after every migration run; the trigger below enforces it on every insert into the log.
create table pulse.event_type (
  type          text primary key,
  purposes      text[] not null check (cardinality(purposes) > 0),
  sensitivity   smallint not null check (sensitivity between 0 and 2),   -- floor
  visibility    text not null check (visibility in ('person','team','org')),   -- floor (loosest allowed)
  retention     text not null references privacy.retention_class(code),
  emitters      text[] not null,                            -- source prefixes, e.g. /agent, /collectors/gdrive_audit
  subject_re    text not null,                              -- anchored regex derived from the subject template
  data_required text[] not null default '{}',
  data_allowed  text[] not null default '{}',               -- required + optional: nothing else may be stored
  registry_version int not null,
  synced_at     timestamptz not null default now()
);

-- --------------------------------------------------------------------------------------------------- events
create table pulse.raw_inbox (                              -- provider payloads exactly as received (kept 30 days)
  id            bigint generated always as identity primary key,
  org_id        uuid not null references pulse.org(id),
  source        text not null,
  source_ref    text not null,
  received_at   timestamptz not null default now(),
  signature_ok  boolean,
  payload       jsonb not null,
  processed_at  timestamptz,
  attempts      int not null default 0,
  error         text,                                       -- dead letter after attempts >= the runtime's limit
  unique (org_id, source, source_ref)
);
create index raw_inbox_todo on pulse.raw_inbox (org_id, received_at) where processed_at is null;

create table pulse.collector_cursor (                       -- one cursor per collector scope (05 §5.2)
  org_id        uuid not null references pulse.org(id),
  collector     text not null,
  scope_key     text not null,                              -- impersonated user, folder id, ad account …
  cursor        jsonb not null,
  updated_at    timestamptz not null default now(),
  primary key (org_id, collector, scope_key)
);

create sequence pulse.event_seq_global;                     -- one order across event and event_ephemeral
create table pulse.event (                                  -- the immutable log (CloudEvents 1.0 + extensions)
  seq           bigint not null default nextval('pulse.event_seq_global'),
  tx_id         xid8   not null default pg_current_xact_id(),  -- consumers read only below pg_snapshot_xmin (05 §6)
  org_id        uuid not null references pulse.org(id),
  id            text not null,                              -- deterministic for collector events (02 §3.2)
  source        text not null,
  type          text not null,
  time          timestamptz not null,
  recorded_at   timestamptz not null default now(),
  subject       text not null,
  actor         text,
  actor_kind    text check (actor_kind in ('person','account','device','system','ai','external')),
  project_id    uuid,
  confidence    real not null default 1.0 check (confidence between 0 and 1),
  purpose       text[] not null check (cardinality(purpose) > 0),
  consent_ref   text,
  sensitivity   smallint not null check (sensitivity between 0 and 2),   -- 3 (special) is never stored
  visibility    text not null check (visibility in ('person','team','org')),
  retention     text not null references privacy.retention_class(code),   -- set by the registry trigger
  causation_id  text,
  correlation_id text,
  supersedes    text,
  data          jsonb not null default '{}',
  data_schema   text,
  collector_ver text,
  redacted_at   timestamptz,
  redaction_hash text,                                      -- sha256 of the original row, set by redaction only
  primary key (seq, time),
  unique (org_id, source, id, time)                         -- idempotency: emitters resend the same id and time
) partition by range (time);
create index event_org_type_time on pulse.event (org_id, type, time);
create index event_org_subject on pulse.event (org_id, subject);
create index event_org_project_time on pulse.event (org_id, project_id, time);
create index event_org_tx_seq on pulse.event (org_id, tx_id, seq);           -- consumer reads (05 §6)
create index event_org_md5 on pulse.event (org_id, (data->>'md5')) where data ? 'md5';   -- render/upload hash joins

create table pulse.event_ephemeral (like pulse.event including defaults including constraints including indexes)
  partition by range (time);                                -- activity_raw class, daily partitions, dropped after 60 days
alter table pulse.event_ephemeral add foreign key (retention) references privacy.retention_class(code);
alter table pulse.event_ephemeral add foreign key (org_id) references pulse.org(id);

-- Registry enforcement for every writer. Raises check_violation (SQLSTATE 23514) with the reason.
create function pulse.event_check() returns trigger
  language plpgsql set search_path = pulse, pg_temp as $$
declare t pulse.event_type%rowtype;
begin
  -- System columns belong to the database, never to the writer (a forged redacted_at would escape retention).
  new.seq := nextval('pulse.event_seq_global');
  new.tx_id := pg_current_xact_id();
  new.recorded_at := now();
  new.redacted_at := null;
  new.redaction_hash := null;
  -- Outside this window there is no log partition: the row would land in the default partition and block
  -- partition maintenance for every tenant.
  if new.time is null or new.time > now() + interval '24 hours' or new.time < now() - interval '210 days' then
    raise exception using errcode = 'check_violation',
      message = format('event rejected: time %s outside the accepted window (210 days back, 24 hours ahead)', new.time);
  end if;
  if new.purpose is null or cardinality(new.purpose) = 0 then
    raise exception using errcode = 'check_violation', message = 'event rejected: no purpose';
  end if;
  select * into t from pulse.event_type where type = new.type;
  if not found then
    raise exception using errcode = 'check_violation', message = format('event rejected: unknown type %s', new.type);
  end if;
  if not (new.purpose <@ t.purposes) then
    raise exception using errcode = 'check_violation',
      message = format('event rejected: purpose %s not allowed for %s (allowed: %s)', new.purpose, new.type, t.purposes);
  end if;
  if new.sensitivity < t.sensitivity then
    raise exception using errcode = 'check_violation',
      message = format('event rejected: sensitivity %s below the floor %s of %s', new.sensitivity, t.sensitivity, new.type);
  end if;
  if pulse.visibility_rank(new.visibility) > pulse.visibility_rank(t.visibility) then
    raise exception using errcode = 'check_violation',
      message = format('event rejected: visibility %s looser than the floor %s of %s', new.visibility, t.visibility, new.type);
  end if;
  if not exists (select 1 from unnest(t.emitters) e where new.source = e or starts_with(new.source, e || '/')) then
    raise exception using errcode = 'check_violation',
      message = format('event rejected: source %s may not emit %s', new.source, new.type);
  end if;
  if new.subject !~ t.subject_re then
    raise exception using errcode = 'check_violation',
      message = format('event rejected: subject %s does not match %s', new.subject, t.subject_re);
  end if;
  if not (new.data ?& t.data_required) then
    raise exception using errcode = 'check_violation',
      message = format('event rejected: data lacks required fields of %s (%s)', new.type, t.data_required);
  end if;
  if exists (select 1 from jsonb_object_keys(new.data) k where not (k = any(t.data_allowed))) then
    raise exception using errcode = 'check_violation',
      message = format('event rejected: data has undeclared fields for %s (allowed: %s)', new.type, t.data_allowed);
  end if;
  if tg_argv[0] = 'ephemeral' and t.retention <> 'activity_raw' then
    raise exception using errcode = 'check_violation',
      message = format('event rejected: %s belongs in pulse.event, not event_ephemeral', new.type);
  elsif tg_argv[0] = 'event' and t.retention = 'activity_raw' then
    raise exception using errcode = 'check_violation',
      message = format('event rejected: %s (activity_raw) belongs in pulse.event_ephemeral', new.type);
  end if;
  new.retention := t.retention;
  return new;
end $$;
create trigger event_check before insert on pulse.event
  for each row execute function pulse.event_check('event');
create trigger event_check before insert on pulse.event_ephemeral
  for each row execute function pulse.event_check('ephemeral');

create unlogged table pulse.ingest_nonce (                  -- replay protection for signed batches (05 §8.3)
  device_id     uuid not null,
  nonce         text not null,
  seen_at       timestamptz not null default now(),
  primary key (device_id, nonce)
);

create table pulse.projection_cursor (                      -- per tenant, per projection version (05 §6)
  org_id        uuid not null references pulse.org(id),
  name          text not null,
  version       int  not null,
  last_tx       xid8 not null default '0'::xid8,
  last_seq      bigint not null default 0,
  status        text not null default 'building' check (status in ('building','live','retired')),
  updated_at    timestamptz not null default now(),
  primary key (org_id, name, version)
);

create table pulse.projection_error (                       -- quarantine: apply() failed, the cursor moved on (02 §5)
  org_id        uuid not null references pulse.org(id),
  name          text not null,
  version       int  not null,
  event_seq     bigint not null,
  event_time    timestamptz not null,
  event_type    text not null,
  error         text not null,
  failed_at     timestamptz not null default now(),
  primary key (org_id, name, version, event_seq)
);

create table pulse.attribution (                            -- delivery event -> maker, recomputable (02 §4.3, 03 §9.4)
  org_id        uuid not null,
  event_seq     bigint not null,
  event_time    timestamptz not null,
  version_id    uuid references pulse.version(id) deferrable initially immediate,
  person_id     uuid references pulse.person(id),           -- the decided maker, or the top candidate if unresolved
  probability   numeric(4,3) not null,
  method        text not null check (method in ('individual_account','device','evidence','declared','manual','unresolved')),
  resolver_version text not null,
  evidence      jsonb not null default '[]',                -- signal groups and ratios (person-only detail stays out)
  decided_at    timestamptz not null,                       -- time of the event that produced this decision
  primary key (org_id, event_seq, resolver_version)
);

-- --------------------------------------------------------------------------------------- models, scores, corrections
create table pulse.model_registry (                         -- global (no org_id): model versions are product artefacts
  name          text not null,
  version       text not null,
  kind          text not null check (kind in ('rules','statistical','ml','llm_prompt')),
  artifact_uri  text,
  eval_report   jsonb not null default '{}',
  status        text not null default 'candidate' check (status in ('candidate','shadow','live','retired')),
  created_at    timestamptz not null default now(),
  primary key (name, version)
);

create table pulse.score (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  subject_type  text not null check (subject_type in ('person','unit','project','asset','version','ad','task')),
  subject_id    uuid not null,
  metric        text not null,                              -- delivery_ratio, quality_index, … (04)
  period_start  date not null, period_end date not null,
  value         double precision,
  ci_low        double precision, ci_high double precision,
  n_effective   double precision,
  sufficiency   text not null check (sufficiency in ('enough','thin','none')),
  explanation   jsonb not null,
  model_name    text not null, model_version text not null,
  projection_versions jsonb not null default '{}',
  visibility    text not null check (visibility in ('person','team','org')),
  computed_at   timestamptz not null default now(),
  check (not (subject_type = 'person' and visibility = 'org'))   -- person-level scores are never org-wide
);
create index score_subject on pulse.score (org_id, subject_type, subject_id, metric, period_end);

create table pulse.correction (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  opened_by     uuid not null references pulse.person(id),
  target_type   text not null,
  target_ref    text not null,
  claim         text not null,
  proposed      jsonb not null default '{}',
  status        text not null default 'open' check (status in ('open','accepted','rejected','auto_applied')),
  resolver_person_id uuid references pulse.person(id),
  resolution_note text,
  opened_at     timestamptz not null default now(),
  resolved_at   timestamptz
);

create table pulse.notification_pref (                      -- per person; mutes are never shown to managers
  org_id        uuid not null references pulse.org(id),
  person_id     uuid not null references pulse.person(id),
  channel       text not null default 'telegram' check (channel in ('telegram','whatsapp','google_chat','web')),
  channel_handle text,                                      -- chat id after linking
  review_ready_notify boolean not null default true,
  muted_until   timestamptz,
  primary key (org_id, person_id)
);

-- ------------------------------------------------------------------------------------------------------ office
create table pulse.space (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  name          text not null
);
create table pulse.zone (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references pulse.org(id),
  space_id      uuid not null references pulse.space(id),
  name          text not null,
  capacity      int  not null check (capacity >= 1),
  reporting_min_capacity int not null default 4
);

-- --------------------------------------------------------------------------------------- partitions (maintenance)
-- Partitions have explicit UTC bounds and are created BEFORE any ingest: a row in a default partition makes it
-- impossible to create the matching range later. SECURITY DEFINER: partitions always belong to the owner role,
-- whoever calls (the migration, the owner's tooling, or the worker through pulse.maintain_partitions()).
create function pulse.ensure_event_partitions(first_month date, months int) returns int
  language plpgsql security definer set search_path = pulse, pg_temp set timezone = 'UTC'
  set datestyle = 'ISO, YMD' as $$
declare m date; lo timestamptz; name text; made int := 0;
begin
  for i in 0 .. months - 1 loop
    m  := (date_trunc('month', first_month) + make_interval(months => i))::date;
    lo := make_timestamptz(extract(year from m)::int, extract(month from m)::int, 1, 0, 0, 0, 'UTC');
    name := format('event_%s', to_char(m, 'YYYY_MM'));
    if to_regclass('pulse.' || name) is null then
      execute format('create table pulse.%I partition of pulse.event for values from (%L) to (%L)',
                     name, lo, lo + interval '1 month');
      made := made + 1;
    end if;
  end loop;
  return made;
end $$;

create function pulse.ensure_ephemeral_partitions(first_day date, days int) returns int
  language plpgsql security definer set search_path = pulse, pg_temp set timezone = 'UTC'
  set datestyle = 'ISO, YMD' as $$
declare d date; lo timestamptz; name text; made int := 0;
begin
  for i in 0 .. days - 1 loop
    d  := first_day + i;
    lo := make_timestamptz(extract(year from d)::int, extract(month from d)::int, extract(day from d)::int, 0, 0, 0, 'UTC');
    name := format('event_eph_%s', to_char(d, 'YYYY_MM_DD'));
    if to_regclass('pulse.' || name) is null then
      execute format('create table pulse.%I partition of pulse.event_ephemeral for values from (%L) to (%L)',
                     name, lo, lo + interval '1 day');
      made := made + 1;
    end if;
  end loop;
  return made;
end $$;

-- Daily job (worker): log partitions for this month and the next 3, ephemeral days for the next 14; reports rows
-- that fell into a default partition (must stay 0; alert otherwise).
create function pulse.maintain_partitions() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp set timezone = 'UTC'
  set datestyle = 'ISO, YMD' as $$
declare made_event int; made_eph int; d_event bigint; d_eph bigint; err_event text; err_eph text;
begin
  begin                                                    -- each kind independently: one failure never stops the other
    made_event := pulse.ensure_event_partitions((now() at time zone 'UTC')::date, 4);
  exception when others then err_event := sqlerrm;
  end;
  begin
    made_eph := pulse.ensure_ephemeral_partitions((now() at time zone 'UTC')::date, 15);
  exception when others then err_eph := sqlerrm;
  end;
  -- Counts across tenants, without reading rows: the default partitions have no RLS-protected access from here.
  execute 'select count(*) from only pulse.event_default' into d_event;
  execute 'select count(*) from only pulse.event_ephemeral_default' into d_eph;
  return jsonb_strip_nulls(jsonb_build_object(
    'event_partitions_created', made_event, 'ephemeral_partitions_created', made_eph,
    'event_default_rows', d_event, 'ephemeral_default_rows', d_eph,
    'event_error', err_event, 'ephemeral_error', err_eph));
end $$;

-- ------------------------------------------------------------------------------------- privacy: redaction, retention
-- The only mutations of the log. Each keeps a SHA-256 of the original row and records itself as an event.
create function privacy.redact_event(p_seq bigint, p_time timestamptz, p_reason text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r pulse.event%rowtype;
begin
  select * into r from pulse.event where seq = p_seq and time = p_time and org_id = pulse.current_org();
  if not found or r.redacted_at is not null then return; end if;
  update pulse.event
     set data = '{}', actor = null, redacted_at = now(),
         redaction_hash = encode(sha256(convert_to(row_to_json(r)::text, 'UTF8')), 'hex')
   where seq = p_seq and time = p_time and org_id = r.org_id;
  insert into pulse.event (org_id, id, source, type, time, subject, actor_kind, purpose, sensitivity, visibility,
                           causation_id, data)
  values (r.org_id, gen_random_uuid()::text, '/system/privacy', 'privacy.event.redacted', now(),
          'event:pulse:' || p_seq, 'system', array['privacy'], 1, 'person', r.id,
          jsonb_build_object('reason', p_reason, 'type', r.type));
end $$;

-- Days a tenant keeps a retention class: its retention_policy value when it is a whole number between the legal floor
-- and the ceiling, else the default (with a warning; a bad value never aborts retention or shortens it below the floor).
create function privacy.retention_days(p_class text) returns int
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare rc privacy.retention_class%rowtype; v jsonb; d int;
begin
  select * into rc from privacy.retention_class where code = p_class;
  if not found then return null; end if;
  select c.body -> p_class into v from pulse.tenant_config c
   where c.org_id = pulse.current_org() and c.doc_kind = 'retention_policy' and c.is_active
   order by c.version desc limit 1;
  if v is null then return rc.default_days; end if;
  if jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^\d{1,6}$' then
    d := (v #>> '{}')::int;
    if d between rc.min_days and rc.max_days then return d; end if;
  end if;
  raise warning 'retention_policy.% = % ignored: allowed % to % days; using the default %',
    p_class, v, rc.min_days, rc.max_days, rc.default_days;
  return rc.default_days;
end $$;

-- Daily retention for the current tenant: redacts every expired event of every 'redact' class (and activity_raw
-- rows older than the tenant's own, shorter period), one summary event per class. Expiry is always computed from
-- now(), so a caller cannot redact unexpired data. Returns {class: count}.
create function privacy.redact_expired() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare rc record; n bigint; cutoff timestamptz; result jsonb := '{}'; o uuid := pulse.current_org();
begin
  if o is null then raise exception 'privacy.redact_expired: no tenant (set pulse.org_id)'; end if;
  for rc in select code, action from privacy.retention_class order by code loop
    cutoff := now() - make_interval(days => privacy.retention_days(rc.code));
    if rc.action = 'redact' then
      update pulse.event e
         set data = '{}', actor = null, redacted_at = now(),
             redaction_hash = encode(sha256(convert_to(row_to_json(e)::text, 'UTF8')), 'hex')
       where e.org_id = o and e.retention = rc.code and e.time < cutoff and e.redacted_at is null
         and e.type <> 'privacy.event.redacted';
    else
      update pulse.event_ephemeral e
         set data = '{}', actor = null, redacted_at = now(),
             redaction_hash = encode(sha256(convert_to(row_to_json(e)::text, 'UTF8')), 'hex')
       where e.org_id = o and e.retention = rc.code and e.time < cutoff and e.redacted_at is null;
    end if;
    get diagnostics n = row_count;
    if n > 0 then
      insert into pulse.event (org_id, id, source, type, time, subject, actor_kind, purpose, sensitivity, visibility, data)
      values (o, gen_random_uuid()::text, '/system/retention', 'privacy.event.redacted', now(),
              'event:pulse:retention:' || rc.code, 'system', array['privacy'], 1, 'person',
              jsonb_build_object('reason', 'retention', 'type', '*', 'class', rc.code, 'count', n,
                                 'before', cutoff));
      result := result || jsonb_build_object(rc.code, n);
    end if;
  end loop;
  return result;
end $$;

-- Daily, all tenants: drops ephemeral day partitions older than the activity_raw default period. The cutoff is fixed
-- by the retention class, not by the caller. Returns the dropped partition names.
create function privacy.drop_expired_ephemeral() returns text[]
  language plpgsql security definer set search_path = pulse, pg_temp set timezone = 'UTC' as $$
declare p record; upper_bound date; cutoff date; dropped text[] := '{}';
begin
  select (now() at time zone 'UTC')::date - default_days into cutoff
    from privacy.retention_class where code = 'activity_raw';
  for p in
    select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
     where i.inhparent = 'pulse.event_ephemeral'::regclass and c.relname ~ '^event_eph_\d{4}_\d{2}_\d{2}$'
     order by c.relname
  loop
    upper_bound := to_date(substr(p.relname, 11), 'YYYY_MM_DD') + 1;
    if upper_bound <= cutoff then
      execute format('drop table pulse.%I', p.relname);
      dropped := dropped || p.relname::text;
    end if;
  end loop;
  return dropped;
end $$;

-- --------------------------------------------------------------------------------- routing before tenant is known
-- Used by ingest (device batches, provider webhooks) and by unauthenticated code redemption. No RLS in this schema;
-- no runtime role has direct access; the functions below are the only way in.
create table pulse_route.route (
  kind          text not null check (kind in ('device','enrolment_code','hook')),
  route_key     text not null,                              -- device uuid | sha256(code) | '<source>:<key>' e.g. 'meta_page:12345'
  org_id        uuid not null,
  expires_at    timestamptz,
  primary key (kind, route_key)
);

-- Resolves a route and sets the tenant for the rest of the transaction; returns the org id (null if unknown or
-- expired). A transaction that already belongs to a tenant cannot be switched to another one.
create function pulse.resolve_route(p_kind text, p_key text) returns uuid
  language plpgsql security definer set search_path = pulse_route, pg_temp as $$
declare o uuid; cur uuid := pulse.current_org();
begin
  select org_id into o from pulse_route.route
   where kind = p_kind and route_key = p_key and (expires_at is null or expires_at > now());
  if o is null then return null; end if;
  if cur is not null and cur <> o then
    raise exception using errcode = 'insufficient_privilege',
      message = 'resolve_route: this transaction already belongs to another tenant';
  end if;
  perform set_config('pulse.org_id', o::text, true);
  return o;
end $$;

-- Keep device routes in sync with pulse.device.
create function pulse.device_route_sync() returns trigger
  language plpgsql security definer set search_path = pulse_route, pg_temp as $$
begin
  if new.revoked_at is null then
    insert into pulse_route.route (kind, route_key, org_id) values ('device', new.id::text, new.org_id)
    on conflict (kind, route_key) do update set org_id = excluded.org_id, expires_at = null;
  else
    update pulse_route.route set expires_at = new.revoked_at where kind = 'device' and route_key = new.id::text;
  end if;
  return new;
end $$;
create trigger device_route_sync after insert or update on pulse.device
  for each row execute function pulse.device_route_sync();

create function pulse.enrolment_route_sync() returns trigger
  language plpgsql security definer set search_path = pulse_route, pg_temp as $$
begin
  insert into pulse_route.route (kind, route_key, org_id, expires_at)
  values ('enrolment_code', new.code_hash, new.org_id, coalesce(new.used_at, new.expires_at))
  on conflict (kind, route_key) do update set expires_at = excluded.expires_at;
  return new;
end $$;
create trigger enrolment_route_sync after insert or update on pulse.enrolment_code
  for each row execute function pulse.enrolment_route_sync();

-- Tenant ids for jobs that loop over tenants (projectors, retention). Ids only; each tenant's rows are then read with
-- SET LOCAL pulse.org_id under row-level security.
create function pulse.list_active_orgs() returns setof uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select id from pulse.org where status in ('active', 'offboarding') order by id
$$;

-- ------------------------------------------------------------------------------------------- row-level security
-- Tenant isolation on every table that has org_id (partitions excluded: access goes through the parent tables).
-- FORCE makes the table owner subject to RLS too.
do $$
declare t record;
begin
  for t in
    select n.nspname, c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
     where n.nspname in ('pulse', 'pulse_priv', 'privacy') and c.relkind in ('r', 'p') and not c.relispartition
  loop
    execute format('alter table %I.%I enable row level security', t.nspname, t.relname);
    execute format('alter table %I.%I force row level security', t.nspname, t.relname);
    execute format('create policy tenant_isolation on %I.%I using (org_id = pulse.current_org()) '
                   'with check (org_id = pulse.current_org())', t.nspname, t.relname);
  end loop;
end $$;
alter table pulse.org enable row level security;
alter table pulse.org force row level security;
create policy own_org on pulse.org using (id = pulse.current_org()) with check (id = pulse.current_org());
-- The tenant directory for pulse.list_active_orgs() (SECURITY DEFINER, runs as the schema owner); runtime roles
-- are never the owner.
create policy directory on pulse.org for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));

-- Visibility backstop for the API role (06 §5). Workers and privacy roles are not restricted by these policies.
create function pulse.can_view_person(subject uuid) returns boolean   -- viewer manages subject's unit now
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (
    select 1 from role_assignment m join role_assignment r on r.unit_id = m.unit_id
    where m.person_id = pulse.current_viewer() and m.is_manager_of_unit
      and r.person_id = subject
      and m.org_id = pulse.current_org()
      and current_date between m.valid_from and coalesce(m.valid_to, 'infinity')
      and current_date between r.valid_from and coalesce(r.valid_to, 'infinity'))
$$;

create policy person_first on pulse.score as restrictive for select to pulse_api
  using (subject_type <> 'person'
         or subject_id = pulse.current_viewer()
         or (sufficiency = 'enough'
             and visibility = 'team'
             and (period_end - period_start) >= 6                       -- week grain or coarser
             and pulse.can_view_person(subject_id)));

create function pulse.can_view_version(v uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (
    select 1 from version ver
    join asset a on a.id = ver.asset_id
    left join project p on p.id = a.project_id
    where ver.id = v and ver.org_id = pulse.current_org()
      and ( ver.creator_person_id = pulse.current_viewer()
         or ( (ver.ready_at is not null or ver.shared_with_client_at is not null)
              and ( p.lead_person_id = pulse.current_viewer()
                 or pulse.can_view_person(ver.creator_person_id) ) ) ))
$$;
create policy creator_first on pulse.review as restrictive for select to pulse_api
  using (pulse.can_view_version(version_id));
create policy creator_first on pulse.review_note as restrictive for select to pulse_api
  using (exists (select 1 from pulse.review r where r.id = review_id));     -- inherits review's policy
-- The API reads attribution only through person-safe endpoints; the evidence column holds no person-only detail.

-- ------------------------------------------------------------------------------------------------------- grants
revoke all on schema pulse, pulse_priv, privacy, pulse_route from public;
revoke execute on all functions in schema pulse, privacy, pulse_route from public;
grant usage on schema pulse, privacy to pulse_api, pulse_worker, pulse_ingest, pulse_privacy;
grant usage on schema pulse_priv to pulse_worker, pulse_privacy;
grant usage on sequence pulse.event_seq_global to pulse_api, pulse_worker, pulse_ingest, pulse_privacy;
grant execute on function pulse.current_org(), pulse.current_viewer(), pulse.visibility_rank(text),
                          pulse.safe_date(text),
                          pulse.can_view_person(uuid), pulse.can_view_version(uuid)
  to pulse_api, pulse_worker, pulse_ingest, pulse_privacy;
grant execute on function pulse.event_check() to pulse_api, pulse_worker, pulse_ingest, pulse_privacy;
grant execute on function pulse.resolve_route(text, text) to pulse_api, pulse_ingest;
grant execute on function pulse.list_active_orgs() to pulse_worker, pulse_privacy;
grant execute on function pulse.maintain_partitions() to pulse_worker;
grant execute on function privacy.redact_event(bigint, timestamptz, text), privacy.redact_expired(),
                          privacy.drop_expired_ephemeral(), privacy.retention_days(text) to pulse_privacy;
grant select on pulse.event_type to pulse_api, pulse_worker, pulse_ingest, pulse_privacy;

grant select on all tables in schema pulse to pulse_api;
revoke select on pulse.event, pulse.event_ephemeral, pulse.raw_inbox, pulse.collector_cursor, pulse.ingest_nonce,
                 pulse.folder, pulse.projection_error from pulse_api;
grant insert on pulse.event, pulse.correction, pulse.cid_counter, pulse.project,
                pulse.enrolment_code, pulse.device, pulse.device_assignment, pulse.notification_pref to pulse_api;
grant update on pulse.cid_counter, pulse.enrolment_code, pulse.device, pulse.notification_pref,
                pulse.correction to pulse_api;
grant select, insert on privacy.consent, privacy.notice_ack, privacy.request, privacy.access_log to pulse_api;
grant update (withdrawn_at) on privacy.consent to pulse_api;
grant select on privacy.notice, privacy.purpose to pulse_api;

grant select, insert, update, delete on all tables in schema pulse to pulse_worker;
revoke update, delete on pulse.event, pulse.event_ephemeral from pulse_worker;
revoke insert, update, delete on pulse.event_type, pulse.model_registry from pulse_worker;
grant select, insert, update on all tables in schema pulse_priv to pulse_worker;
grant select on all tables in schema privacy to pulse_worker;

grant insert on pulse.raw_inbox, pulse.event, pulse.event_ephemeral to pulse_ingest;
grant select (org_id, source, source_ref) on pulse.raw_inbox to pulse_ingest;
grant select on pulse.device, pulse.person, pulse.device_assignment to pulse_ingest;
grant select, insert, delete on pulse.ingest_nonce to pulse_ingest;
grant select on privacy.purpose, privacy.notice, privacy.notice_ack, privacy.consent to pulse_ingest;

grant select on all tables in schema pulse, pulse_priv, privacy to pulse_privacy;
grant delete on pulse.raw_inbox to pulse_privacy;
grant update, delete on all tables in schema privacy to pulse_privacy;
revoke update, delete on privacy.purpose, privacy.retention_class from pulse_privacy;

-- ------------------------------------------------------------------------------------------ partitions (initial)
-- Created after the grants on purpose: partitions carry no privileges of their own.
create table pulse.event_default partition of pulse.event default;                     -- must stay empty
create table pulse.event_ephemeral_default partition of pulse.event_ephemeral default; -- must stay empty
-- 7 months back (covers the 180-day Drive audit backfill) to 3 months ahead; the maintenance job extends daily.
select pulse.ensure_event_partitions((date_trunc('month', now() at time zone 'UTC') - interval '7 months')::date, 11);
select pulse.ensure_ephemeral_partitions((now() at time zone 'UTC')::date - 20, 35);

-- migrate:down
-- Forward-only (see db/migrations/README.md).
