-- CASE-STUDIES (owner, 10 Nov 2026): the case-study journey as an app inside Vitals OS (Growth → Case studies).
-- Each company in the journey has one case file: profile, sector and tags, the 8 stages' checklist, starting numbers
-- (month by month, with where they came from), pain points, results after 45 days, and links to records the company
-- already keeps elsewhere: Meetings (talks and podcasts), Docs (the offer, the published story), Goals, Clients,
-- projects and AI employees. Nothing is copied: a link holds the record's id, and the API reads its name live.
-- An organisation-only module (`case_studies`, services/api/src/modules.ts ORG_ONLY), switched on in the Vitals
-- organisation (handle vitalstechnologies) and seeded there with the five founders'-circle names (names only).
-- Leaders and admins only: row security below, and case-studies.ts says so in words first.

-- migrate:up
create table pulse.case_study (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120 and name !~ '[[:cntrl:]]'),
  sector text check (sector is null or (length(btrim(sector)) between 1 and 60 and sector !~ '[[:cntrl:]]')),
  aim text not null default '' check (length(aim) <= 300),
  -- 1..8 = the stage it is in (case-studies-model.ts STAGES); 9 = all 8 done.
  stage smallint not null default 1 check (stage between 1 and 9),
  started_on date not null,
  lead_person_id uuid references pulse.person(id),
  client_id uuid references pulse.client(id),
  problems text[] not null default '{}' check (cardinality(problems) <= 8),
  moves text[] not null default '{}' check (cardinality(moves) <= 8),
  pains jsonb not null default '[]' check (jsonb_typeof(pains) = 'array' and jsonb_array_length(pains) <= 10 and pg_column_size(pains) < 4096),
  -- Ticked checklist items: {"convince.offer": true, ...}.
  checks jsonb not null default '{}' check (jsonb_typeof(checks) = 'object' and pg_column_size(checks) < 4096),
  -- Starting numbers: [{"month": "2026-08", "revenue": 420000, "clients": 6, "leads": 40}], up to 24 months, rupees a month.
  months jsonb not null default '[]' check (jsonb_typeof(months) = 'array' and jsonb_array_length(months) <= 24 and pg_column_size(months) < 8192),
  numbers_from text not null default 'owner' check (numbers_from in ('owner', 'export', 'finance', 'workbench')),
  -- After 45 days, on the same measures: {"revenue": …, "clients": …, "leads": …, "note": "…"}.
  after jsonb not null default '{}' check (jsonb_typeof(after) = 'object' and pg_column_size(after) < 2048),
  story_doc_id uuid references pulse.doc(id),
  published_at timestamptz,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index case_study_org on pulse.case_study(org_id, stage, sort);

create table pulse.case_study_link (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references pulse.case_study(id) on delete cascade,
  kind text not null check (kind in ('meeting', 'doc', 'goal', 'client', 'project', 'ai_employee')),
  ref_id uuid not null,
  -- A line about why it is linked; for a podcast, the clip ("12:30-13:10 'We doubled our leads'").
  note text not null default '' check (length(note) <= 200 and note !~ '[[:cntrl:]]'),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  unique (case_id, kind, ref_id)
);
create index case_study_link_case on pulse.case_study_link(org_id, case_id, kind);

-- Row security: the tenant first, then leaders and admins only (as the funding list, 1845).
do $$ declare t text; begin
  foreach t in array array['case_study', 'case_study_link'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('create policy case_study_leaders on pulse.%I as restrictive to pulse_api using (pulse.viewer_is(''admin'',''leadership'')) with check (pulse.viewer_is(''admin'',''leadership''))', t);
    execute format('grant select, insert, update, delete on pulse.%I to pulse_api', t);
  end loop;
end $$;

-- Switch the module on in the Vitals organisation and seed the five founders'-circle names, all in stage 1 (Convince).
-- Names only, no numbers. The two aims are the owner's own words (10 Nov 2026). Nothing happens on an install without
-- this organisation, and nothing is added twice.
do $$
declare v_org uuid; mods jsonb; v_day date; v_client uuid;
begin
  select id into v_org from pulse.org where handle = 'vitalstechnologies';
  if v_org is null then return; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  select body into mods from pulse.tenant_config where org_id = v_org and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
  if mods is null then
    insert into pulse.tenant_config(org_id, doc_kind, doc_key, version, body, is_active) values (v_org, 'tenant', 'modules', 1, '{"off": [], "on": ["case_studies"]}'::jsonb, true);
  elsif not coalesce(mods->'on', '[]'::jsonb) ? 'case_studies' then
    update pulse.tenant_config set body = jsonb_set(body, '{on}', coalesce(body->'on', '[]'::jsonb) || '["case_studies"]'::jsonb)
     where org_id = v_org and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
  end if;
  if exists (select 1 from pulse.case_study where org_id = v_org) then return; end if;
  v_day := (now() at time zone pulse.org_time_zone(v_org))::date;
  -- Willow Lane is already a client of the Vitals organisation on some installs: link that record instead of a copy.
  select id into v_client from pulse.client where org_id = v_org and display_name ilike 'willow lane%' order by display_name limit 1;
  insert into pulse.case_study(org_id, name, aim, stage, started_on, client_id, sort) values
    (v_org, 'Datup', '', 1, v_day, null, 0),
    (v_org, 'Sakipa', '', 1, v_day, null, 1),
    (v_org, 'Kavita Putig', 'Bring revenue from ₹4–7 L back to ₹15–20 L a month', 1, v_day, null, 2),
    (v_org, 'Akabod (Willow Lane)', 'Automate the business end to end', 1, v_day, v_client, 3),
    (v_org, 'Dhanashree', '', 1, v_day, null, 4);
end $$;

-- migrate:down
-- Forward-only, like 2030: the case files and their links are kept.
