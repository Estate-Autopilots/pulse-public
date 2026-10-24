-- migrate:up
-- FEATURES-1024 (owner, 23 Oct 2026: "a project for project documentation, documenting the first idea to the current
-- version with tutorials and videos evolving with it, and a comparison of each single version ... a proper feature of
-- Pulse"): Product Story, for any organisation.
--   story_product  a product or project whose story is kept (name, what it is, where its code lives)
--   story_version  each version from the first idea to now: label (Idea, v0.3.74 …), stage, date, summary, what changed
--                  (new / improved / fixed / removed), media (screenshots, videos, tutorials, docs, demos as links),
--                  how its tests went and the release it is (a tag or commit)
-- Row-level security is forced like every company table. Pulse's own story (from this repository's release tags and
-- release notes) is added in the Pulse organisation (@pulsehq) only; elsewhere nothing happens. Plain SQL over tables
-- defined in this repository's migrations (0001, 0944 and this file). Safe on a live install: additive.

create table pulse.story_product (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  name text not null check (length(btrim(name)) between 2 and 80),
  blurb text not null default '' check (length(blurb) <= 600),
  repo_url text check (repo_url is null or repo_url ~ '^https://[^\s]{3,290}$'),
  sort integer not null default 0,
  created_by uuid references pulse.person(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index story_product_name on pulse.story_product (org_id, lower(name));

create table pulse.story_version (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 40),
  title text not null default '' check (length(title) <= 120),
  stage text not null default 'live' check (stage in ('idea','prototype','beta','live','retired')),
  released_on date,
  summary text not null default '' check (length(summary) <= 4000),
  -- [{ kind: new | improved | fixed | removed, text }]
  changes jsonb not null default '[]' check (jsonb_typeof(changes) = 'array' and length(changes::text) <= 40000),
  -- [{ kind: screenshot | video | tutorial | doc | demo, url, label }]
  media jsonb not null default '[]' check (jsonb_typeof(media) = 'array' and length(media::text) <= 20000),
  -- { passed, failed, note, url }
  tests jsonb not null default '{}' check (jsonb_typeof(tests) = 'object' and length(tests::text) <= 2000),
  release_ref text not null default '' check (length(release_ref) <= 120),
  created_by uuid references pulse.person(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index story_version_label on pulse.story_version (org_id, product_id, lower(label));
create index story_version_order on pulse.story_version (org_id, product_id, released_on desc nulls last, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['story_product','story_version'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select, insert, update, delete on pulse.%I to pulse_api', t);
  end loop;
end $$;

-- Pulse's own story, in the Pulse organisation: the idea, the release milestones (tags and release notes in this
-- repository) and what is on dev now. Added once (by label).
do $$
declare v_org uuid; v_product uuid;
begin
  select id into v_org from pulse.org where handle = 'pulsehq';
  if v_org is null then return; end if;
  perform set_config('pulse.org_id', v_org::text, true);

  insert into pulse.story_product(org_id, name, blurb, repo_url, sort)
  values (v_org, 'Pulse', 'The social network of work: one place where a company''s work, people, clients and money live, sensed from the tools it already uses.', null, 0)
  on conflict (org_id, lower(name)) do nothing;
  select id into v_product from pulse.story_product where org_id = v_org and lower(name) = 'pulse';

  insert into pulse.story_version(org_id, product_id, label, title, stage, released_on, summary, changes, release_ref)
  select v_org, v_product, x.label, x.title, x.stage, x.on_date::date, x.summary, x.changes::jsonb, x.ref
  from (values
    ('Idea', 'The idea and the spec', 'idea', '2026-10-04',
     'Pulse starts as a written spec for Estate Autopilots: sense an agency''s work, people and money from the tools it already uses (Drive, WhatsApp, attendance) instead of asking everyone to type it in.',
     '[{"kind":"new","text":"Vision, domain model, core schema and the event envelope"},{"kind":"new","text":"Architecture, sensing and intelligence chapters (eight models and their governance)"}]', 'cb6eb677'),
    ('v0.1.0', 'First install for Estate Autopilots', 'prototype', '2026-10-05',
     'The first working Pulse on EA''s own data: delivery views, People, editor accounts and HR workflows, signed in with Workspace accounts only.',
     '[{"kind":"new","text":"Delivery views from Drive, People and editor accounts"},{"kind":"new","text":"Pod board and Leadership view"},{"kind":"new","text":"HR workflows"},{"kind":"improved","text":"Sign-in restricted to the company''s Workspace accounts"}]', 'v0.1.0'),
    ('v0.3.0', 'Map, live chats and a validation browser', 'beta', '2026-10-05',
     'Releases start to be checked on the real address before they count: map alerts, live chat streaming and the content security policy in a real browser.',
     '[{"kind":"new","text":"Map alerts and live chat streaming on the real origin"},{"kind":"improved","text":"Every release checked in a WebGL-capable browser"}]', 'v0.3.0'),
    ('v0.3.20', 'Phones: the companion app', 'beta', '2026-10-08',
     'Pulse reaches phones: Android and iPhone pairing, attendance accepted on staging before release, and Pip on the lock screen.',
     '[{"kind":"new","text":"Companion pairing handshake verified on staging"},{"kind":"new","text":"Attendance controls exercised on a real iPhone"},{"kind":"improved","text":"Installers published only after the Android runner accepts them"}]', 'v0.3.20'),
    ('v0.3.40', 'Finance', 'beta', '2026-10-09',
     'Money comes in: an audited Accountant desk, invoice registers that read on a phone, and the mobile shell release.',
     '[{"kind":"new","text":"Audited Accountant desk"},{"kind":"improved","text":"Invoice registers readable on phones"},{"kind":"fixed","text":"All invoice vendors included"}]', 'v0.3.40'),
    ('v0.3.60', 'Release 6: hardening', 'live', '2026-10-15',
     'Strict CI, layout and style gates on every release commit; the staging smoke knows each company''s time zone.',
     '[{"kind":"improved","text":"Strict CI on the release commit (lint, secrets)"},{"kind":"improved","text":"Layout and style gates on the pay pages"},{"kind":"fixed","text":"Page headers and drawers open without moving or hydration mismatches"}]', 'v0.3.60'),
    ('v0.3.70', 'Screens per role', 'live', '2026-10-19',
     'Admins decide which screens each role sees; WhatsApp sender names are matched to colleagues before a chat import.',
     '[{"kind":"new","text":"Hide screens for each role in Settings → Modules → Screens and menu"},{"kind":"new","text":"A private screen to match WhatsApp sender names to colleagues"},{"kind":"new","text":"Bank details on quotations"}]', 'v0.3.70'),
    ('v0.3.71', 'Sales home', 'live', '2026-10-19',
     'Salespeople get a simpler home with urgent tasks, today''s follow-up calls and their latest quotations.',
     '[{"kind":"new","text":"Admins choose per role: Dashboard or the sales home"},{"kind":"fixed","text":"A second tap can no longer make a duplicate proforma or tax invoice"},{"kind":"improved","text":"Only Mark sent marks a quotation sent"}]', 'v0.3.71'),
    ('v0.3.72', 'WhatsApp names', 'live', '2026-10-19',
     'Leadership and HR load names from their own chat exports; exports are read on the computer and only names and counts are sent.',
     '[{"kind":"new","text":"Load names from your own WhatsApp exports"},{"kind":"improved","text":"Senders shown as phone numbers are left out"}]', 'v0.3.72'),
    ('v0.3.73', 'Updates and AI employees', 'live', '2026-10-20',
     'An Updates page with a bell entry and push for each update; AI employees join the team through Add member.',
     '[{"kind":"new","text":"Updates: a card on Home, an Updates page, a bell entry and push"},{"kind":"new","text":"Add member asks whether the person is an AI employee"},{"kind":"new","text":"AI co-workers post progress and results back in the same chat"},{"kind":"improved","text":"Each quote on its own page"}]', 'v0.3.73'),
    ('v0.3.74', 'Pulse v0.3.74', 'live', '2026-10-20', 'The last tagged release before the chat-first Pulse.', '[]', 'v0.3.74'),
    ('Now', 'Chat-first Pulse, AI employees and client connections', 'beta', '2026-10-24',
     'What is on dev and shipping to production as it passes CI: Pulse becomes chat-first, AI employees work as team members, companies connect to each other, and Pulse runs as its own business (Pulse HQ).',
     '[{"kind":"new","text":"Chat-first workspace with a side panel, Needs you and slash commands"},{"kind":"new","text":"Voice notes and calls, a calls list and missed calls in Needs you"},{"kind":"new","text":"AI employees with the same profile as people; they ask before they post"},{"kind":"new","text":"Client connections: one company becomes the client of another, with shared groups and tasks"},{"kind":"new","text":"One account across organisations, with an organisation switcher"},{"kind":"new","text":"Pulse HQ: feature catalogue, Offer Studio, Brand, Licences and Ideas"},{"kind":"new","text":"Stack Intelligence and Product Story"},{"kind":"new","text":"Connect AI: subscriptions, API keys and agent servers"},{"kind":"improved","text":"Finance opens on a simple cash book"},{"kind":"improved","text":"Hiring links candidates to jobs, with an interview stage"}]', 'dev/live')
  ) as x(label, title, stage, on_date, summary, changes, ref)
  where v_product is not null
  on conflict (org_id, product_id, lower(label)) do nothing;

  -- Product Story joins the feature catalogue (a draft until the founder reviews it) and its idea is being built.
  insert into pulse.hq_feature(org_id, key, category, name, promise, what, who, status, icon, proof, sort, draft, href)
  values (v_org, 'product-story', 'platform', 'Product Story', 'Every version of a product from the first idea to now, side by side',
    'A timeline of versions with what changed (new, improved, fixed, removed), screenshots, videos and tutorials, how the tests went and the release it is; compare any two versions.',
    'Founders, product and engineering teams', 'beta', 'BookOpen', '/story, story.ts, Product Story migration', 41, true, '/story')
  on conflict (org_id, key) do nothing;
  update pulse.hq_idea set status = 'building', updated_at = now() where org_id = v_org and title = 'Product Story module' and status in ('new','exploring','planned');

  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
-- Forward-only.
