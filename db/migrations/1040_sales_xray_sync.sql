-- migrate:up
-- XRAY-LINK (owner, 25 Oct 2026: "send calls from Pulse to be analysed in Sales X-Ray, and connect it for lead
-- management and data sync"). Until now Pulse stored nothing from Sales X-Ray (0710); with lead sync on, a company keeps
-- a copy of its Sales X-Ray leads and links them to its clients, and links Sales X-Ray calls to clients and people.
--   sales_xray_sync      one row per company: lead sync on or off, whose connection reads and writes (an owner or admin
--                        of the Sales X-Ray organisation, connected in Pulse), what becomes a client, the last run
--   sales_xray_lead      Sales X-Ray's leads as last read (name, company, city, phone, e-mail, stage, owner, revision),
--                        each linked to a Pulse client once one exists; leads Pulse sent carry their Pulse client
--   sales_xray_call      a Sales X-Ray call linked to a Pulse client, person and/or Pulse call, with its analysis state
--                        and a short summary (score, objections, promises) so pages can show it without a live read
--   sales_xray_sync_log  what each run did, per lead and direction (in: Sales X-Ray to Pulse, out: Pulse to Sales X-Ray)
-- Who owns what (services/api/src/sales-xray-sync.ts): Sales X-Ray owns a lead's stage, owner and lead details; Pulse
-- owns the client. A client field is filled from Sales X-Ray only while it is empty and not kept (client.locked); a
-- different value on both sides is logged as a conflict and Pulse's value stays. Row-level security is forced like
-- every company table; the background sync visits each active company (pulse.list_active_orgs) with its org set.
-- Safe on a live install: additive.
create table pulse.sales_xray_sync (
  org_id uuid primary key references pulse.org(id),
  enabled boolean not null default false,
  runner_person_id uuid references pulse.person(id) on delete set null,
  workspace text not null default '' check (length(workspace) <= 200),
  -- 'won': a lead becomes a client when it is won; 'all': every lead is a prospect client from the start
  make_clients text not null default 'won' check (make_clients in ('won','all')),
  push_clients boolean not null default false,
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_error text check (length(last_error) <= 500),
  last_counts jsonb not null default '{}' check (jsonb_typeof(last_counts) = 'object' and length(last_counts::text) <= 2000),
  updated_by uuid references pulse.person(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table pulse.sales_xray_lead (
  org_id uuid not null references pulse.org(id),
  sx_lead_id uuid not null,
  revision int not null default 0,
  name text not null default '' check (length(name) <= 200),
  company text check (length(company) <= 200),
  city text check (length(city) <= 120),
  phone text check (length(phone) <= 40),
  email text check (length(email) <= 320),
  interest text check (length(interest) <= 200),
  stage text not null default 'new' check (length(stage) <= 40),
  stage_label text check (length(stage_label) <= 80),
  owner_name text check (length(owner_name) <= 200),
  source_label text check (length(source_label) <= 200),
  sx_created_at timestamptz,
  client_id uuid references pulse.client(id) on delete set null,
  origin text not null default 'sales_xray' check (origin in ('sales_xray','pulse')),
  gone_at timestamptz,
  seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, sx_lead_id)
);
create index sales_xray_lead_client on pulse.sales_xray_lead (org_id, client_id) where client_id is not null;

create table pulse.sales_xray_call (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  sx_call_id uuid not null,
  title text check (length(title) <= 200),
  call_at timestamptz,
  duration_seconds int,
  client_id uuid references pulse.client(id) on delete set null,
  person_id uuid references pulse.person(id) on delete set null,
  pulse_call_id uuid,
  sx_lead_id uuid,
  -- sent: Pulse sent the recording; waiting: Sales X-Ray has it and asks its person to start the analysis there;
  -- analysing; ready: the report exists; failed
  status text not null default 'ready' check (status in ('sent','waiting','analysing','ready','failed')),
  summary jsonb not null default '{}' check (jsonb_typeof(summary) = 'object' and length(summary::text) <= 12000),
  open_url text check (length(open_url) <= 400),
  linked_by uuid references pulse.person(id) on delete set null,
  linked_at timestamptz not null default now(),
  checked_at timestamptz,
  unique (org_id, sx_call_id)
);
create index sales_xray_call_client on pulse.sales_xray_call (org_id, client_id) where client_id is not null;
create index sales_xray_call_person on pulse.sales_xray_call (org_id, person_id) where person_id is not null;

create table pulse.sales_xray_sync_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references pulse.org(id),
  run_id uuid not null,
  at timestamptz not null default now(),
  direction text not null check (direction in ('in','out','run')),
  action text not null check (action in ('created','updated','linked','unchanged','conflict','gone','sent','failed','started','finished')),
  sx_lead_id uuid,
  client_id uuid,
  detail text not null default '' check (length(detail) <= 500)
);
create index sales_xray_sync_log_recent on pulse.sales_xray_sync_log (org_id, at desc);

do $$ declare t text; begin
  foreach t in array array['sales_xray_sync','sales_xray_lead','sales_xray_call','sales_xray_sync_log'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select, insert, update, delete on pulse.%I to pulse_api', t);
  end loop;
end $$;

-- migrate:down
drop table pulse.sales_xray_sync_log, pulse.sales_xray_call, pulse.sales_xray_lead, pulse.sales_xray_sync;
