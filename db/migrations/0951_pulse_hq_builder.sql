-- migrate:up
-- PULSE-HQ (owner, 23 Oct 2026): Offer Studio becomes a guided builder (Hormozi's grand slam offer: customer and dream
-- outcome, the problems in the way, a solution for each mapped to Pulse features, delivery vehicles, bonuses, guarantee,
-- scarcity and urgency, naming, price and anchors) and the brand keeps its history.
--   hq_offer.problems   [{ problem, solution, features: [feature keys] }]
--   hq_offer.delivery   ["Done-for-you setup in 30 days", ...]
--   hq_brand_version    every saved brand document, to compare and restore
-- The three seeded draft offers are redone through the builder's steps so each problem maps to the features that solve it.
-- Safe on a live install: additive; the seeded offers change only while they are untouched drafts without problems.

alter table pulse.hq_offer add column problems jsonb not null default '[]' check (jsonb_typeof(problems) = 'array');
alter table pulse.hq_offer add column delivery jsonb not null default '[]' check (jsonb_typeof(delivery) = 'array');

create table pulse.hq_brand_version (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  saved_by uuid references pulse.person(id),
  saved_at timestamptz not null default now()
);
create index hq_brand_version_recent on pulse.hq_brand_version (org_id, saved_at desc);
alter table pulse.hq_brand_version enable row level security;
alter table pulse.hq_brand_version force row level security;
create policy tenant_isolation on pulse.hq_brand_version using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select, insert on pulse.hq_brand_version to pulse_api;

do $$
declare v_org uuid;
begin
  select id into v_org from pulse.org where handle = 'pulsehq';
  if v_org is null then return; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  -- The brand as it stands is version one.
  insert into pulse.hq_brand_version(org_id, body, saved_by, saved_at)
  select b.org_id, b.body, b.updated_by, b.updated_at from pulse.hq_brand b
   where b.org_id = v_org and not exists (select 1 from pulse.hq_brand_version v where v.org_id = v_org);

  update pulse.hq_offer set problems = $j$[
    {"problem": "Deadlines slip because nobody owns the next step", "solution": "Every client deliverable is a task with an owner, a due date and a reviewer", "features": ["tasks-views", "task-review", "team-dashboard"]},
    {"problem": "Client work is scattered across WhatsApp groups", "solution": "Client chats, files and approvals live with the project, and clients see their own portal", "features": ["team-chats", "chat-tasks", "client-portal"]},
    {"problem": "Only the founder knows how things are done", "solution": "The agency's SOPs become processes that run step by step on every job", "features": ["processes-library", "sop-import", "runs", "my-steps"]},
    {"problem": "Nobody can see who is overloaded and who is idle", "solution": "The team dashboard and outcomes show load and what each person delivered", "features": ["team-dashboard", "outcomes", "leadership-people"]},
    {"problem": "Invoices go out late and payments are chased by hand", "solution": "Billing and the finance overview show what is owed, by whom and since when", "features": ["billing-documents", "finance-overview"]},
    {"problem": "Attendance and payroll take days every month", "solution": "Attendance checks itself in; leave and payroll run from the same records", "features": ["auto-attendance", "leave-shifts", "payroll"]}
  ]$j$::jsonb, delivery = $j$["Done-for-you setup in 30 days", "A weekly launch call with the founder", "Pulse for the whole team on web, phone and desktop", "Process templates for agencies", "Your WhatsApp history imported"]$j$::jsonb,
    updated_at = now()
  where org_id = v_org and name = 'Agency Autopilot' and problems = '[]'::jsonb and draft;

  update pulse.hq_offer set problems = $j$[
    {"problem": "Site surveys come back as scattered WhatsApp photos", "solution": "Phone field forms with geotagged photos, signatures and checklists for every visit", "features": ["field-forms", "site-visits", "phone-app"]},
    {"problem": "Quotations go out and are never followed up", "solution": "Every quotation gets a follow-up task until the customer answers", "features": ["quote-followups", "billing-documents"]},
    {"problem": "Subsidy and net-metering paperwork gets stuck", "solution": "Each document is a step of the installation process, owned and dated", "features": ["processes-library", "runs", "my-steps"]},
    {"problem": "The owner cannot see which sites are stuck", "solution": "Every site's stage on one screen and on the map", "features": ["runs", "pulse-map", "team-dashboard"]},
    {"problem": "Field attendance is guesswork", "solution": "Attendance checks itself in when installers reach the site or the office", "features": ["auto-attendance", "leave-shifts"]},
    {"problem": "Customers keep calling for updates", "solution": "A customer portal shows the stage, the documents and the payments", "features": ["client-portal"]}
  ]$j$::jsonb, delivery = $j$["The solar process pack, pre-built", "A field-team onboarding day", "The Android app on every installer's phone", "A monthly review with the owner"]$j$::jsonb,
    updated_at = now()
  where org_id = v_org and name = 'Solar Installer OS' and problems = '[]'::jsonb and draft;

  update pulse.hq_offer set problems = $j$[
    {"problem": "Our data cannot leave our own servers", "solution": "Pulse runs on your server, on your domain, with personal data sealed", "features": ["self-hosted", "sealed-documents"]},
    {"problem": "Internal tools go stale without a team behind them", "solution": "Updates arrive from the Pulse release channel with one command, and the register checks you are current", "features": ["self-hosted", "licences-register"]},
    {"problem": "Every tool has its own logins and permissions", "solution": "One account, roles enforced in the database, sign-in your way", "features": ["roles-permissions", "sign-in-security", "org-switcher"]},
    {"problem": "Our other systems need to talk to it", "solution": "The API, signed webhooks and connectors with your own credentials", "features": ["api-v1", "webhooks", "company-connectors"]},
    {"problem": "Moving off our current tools feels risky", "solution": "Data importers and a guided setup, rehearsed before anyone is affected", "features": ["data-import", "company-setup"]}
  ]$j$::jsonb, delivery = $j$["Installation and hardening by our team", "Data migration from your current tools", "Admin training", "The priority update channel", "A quarterly roadmap call"]$j$::jsonb,
    updated_at = now()
  where org_id = v_org and name = 'Pulse Self-Hosted' and problems = '[]'::jsonb and draft;
  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
drop table if exists pulse.hq_brand_version;
alter table pulse.hq_offer drop column if exists delivery;
alter table pulse.hq_offer drop column if exists problems;
