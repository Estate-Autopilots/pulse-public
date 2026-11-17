-- migrate:up
-- PRODUCT-MAP (owner, 25 Oct 2026: "connect any app to Pulse; Pulse extracts features, screens, tabs and buttons,
-- creates user journeys on its own, lets us plan new journeys by picking features and screens, finds issues and missing
-- links, and lets us ideate there so the app team can fetch it and build it in the next version. Friendly for people
-- and AI agents. Who are the app's users: how many types, age group, skill level, and which features each needs").
-- A product is Product Story's product (story_product, 0985); its map lives in these tables:
--   product_map_source    a connection of the product: repo scan (a checkout this server may read, by key), live
--                         crawl (an address and a test account, sealed), manifest (/.well-known/pulse-product-map.json
--                         or pushed with a token), telemetry (Pulse's own collector, 0983) or hand edits
--   product_map_screen    a screen: route, title, purpose, who may open it, screenshot; proposed screens are ideas
--   product_map_element   a tab, button, link, form or field on a screen, with its label and where it goes
--   product_map_edge      a way from one screen to another (a link, the navigation, real usage with counts)
--   product_map_feature   screens grouped into what the product can do
--   product_map_persona   a user type: role, goals, age group, skill and tech comfort, how often, what it may open,
--                         with the evidence and how sure Pulse is
--   product_map_journey   ordered steps (persona, screen, action, expected outcome); discovered | auto | drafted |
--                         planned | shipped; a planned one can target a Product Story version
--   product_map_issue     dead ends, unreachable screens, buttons that go nowhere, missing links between features,
--                         permission mismatches, slow steps; each with its evidence
--   product_map_idea      ideas and planned changes with votes and comments, priority and target version
--   product_map_token     read (and push) tokens for the build team's tools and AI agents (only a hash is kept)
--   product_map_ai_job    an AI pass over the map's summary, run by an AI employee's runtime within a budget
--   product_map_shot      a screen's screenshot
-- Row-level security is forced like every company table. Everyone in the organisation reads and edits; leaders remove
-- and manage tokens (services/api/src/product-map.ts). Plain SQL over tables from this repository's migrations (0001,
-- 0944, 0985 and this file). Safe on a live install: additive.

create table pulse.product_map_source (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  kind text not null check (kind in ('repo','crawl','manifest','telemetry','push')),
  label text not null default '' check (length(label) <= 120),
  -- repo: {repo: <server key>, path?}; crawl: {baseUrl, startPaths[], pageBudget, signIn: {url, userField, passField}};
  -- manifest: {url}; telemetry: {org: 'self'}; push: {}
  config jsonb not null default '{}' check (jsonb_typeof(config) = 'object' and length(config::text) <= 8000),
  -- crawl only: the test account, sealed with the document keyring (document-keys.ts); never returned by the API
  secret jsonb check (secret is null or jsonb_typeof(secret) = 'object'),
  status text not null default 'new' check (status in ('new','queued','running','ok','failed')),
  last_run_at timestamptz,
  last_result jsonb not null default '{}' check (jsonb_typeof(last_result) = 'object' and length(last_result::text) <= 20000),
  created_by uuid references pulse.person(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index product_map_source_product on pulse.product_map_source (org_id, product_id);

create table pulse.product_map_screen (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  key text not null check (length(key) between 1 and 200),
  route text not null default '' check (length(route) <= 200),
  title text not null default '' check (length(title) <= 160),
  purpose text not null default '' check (length(purpose) <= 1000),
  area text not null default '' check (length(area) <= 80),
  -- who may open it: role keys of the app ('all' when anyone signed in may)
  access text[] not null default '{}' check (cardinality(access) <= 30),
  proposed boolean not null default false,
  status text not null default 'live' check (status in ('live','proposed','removed')),
  sources text[] not null default '{}' check (cardinality(sources) <= 10),
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object' and length(meta::text) <= 8000),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index product_map_screen_key on pulse.product_map_screen (org_id, product_id, key);

create table pulse.product_map_element (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  screen_id uuid not null references pulse.product_map_screen(id) on delete cascade,
  key text not null check (length(key) between 1 and 300),
  kind text not null check (kind in ('button','tab','link','form','field','menu','dialog')),
  label text not null default '' check (length(label) <= 160),
  -- a screen key it opens, or an action it does ("save", "delete", "submit"); '' when nothing is known
  target text not null default '' check (length(target) <= 200),
  destructive boolean not null default false,
  proposed boolean not null default false,
  sources text[] not null default '{}' check (cardinality(sources) <= 10),
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object' and length(meta::text) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index product_map_element_key on pulse.product_map_element (org_id, screen_id, key);
create index product_map_element_product on pulse.product_map_element (org_id, product_id);

create table pulse.product_map_edge (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  from_key text not null check (length(from_key) between 1 and 200),
  to_key text not null check (length(to_key) between 1 and 200),
  kind text not null check (kind in ('link','nav','redirect','usage','proposed')),
  label text not null default '' check (length(label) <= 160),
  count integer not null default 0 check (count >= 0),
  median_ms integer check (median_ms >= 0),
  sources text[] not null default '{}' check (cardinality(sources) <= 10),
  updated_at timestamptz not null default now()
);
create unique index product_map_edge_key on pulse.product_map_edge (org_id, product_id, from_key, to_key, kind);

create table pulse.product_map_feature (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  key text not null check (length(key) between 1 and 80),
  name text not null check (length(btrim(name)) between 1 and 120),
  description text not null default '' check (length(description) <= 1000),
  screens text[] not null default '{}' check (cardinality(screens) <= 200),
  proposed boolean not null default false,
  origin text not null default 'manual' check (origin in ('scan','auto','ai','manual')),
  sort integer not null default 0,
  created_by uuid references pulse.person(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index product_map_feature_key on pulse.product_map_feature (org_id, product_id, key);

create table pulse.product_map_persona (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  key text not null check (length(key) between 1 and 80),
  name text not null check (length(btrim(name)) between 1 and 120),
  role text not null default '' check (length(role) <= 80),
  description text not null default '' check (length(description) <= 1000),
  goals text[] not null default '{}' check (cardinality(goals) <= 12),
  age_group text not null default '' check (length(age_group) <= 40),
  skill_level text not null default '' check (skill_level in ('','beginner','intermediate','expert')),
  tech_comfort text not null default '' check (tech_comfort in ('','low','medium','high')),
  frequency text not null default '' check (frequency in ('','daily','weekly','monthly','rarely')),
  device text not null default '' check (device in ('','phone','desktop','both')),
  -- screen keys it may open (empty: everything signed in) and the features it needs
  permissions text[] not null default '{}' check (cardinality(permissions) <= 300),
  features text[] not null default '{}' check (cardinality(features) <= 100),
  -- [{kind: screen|element|telemetry|code|note, ref, text}]
  evidence jsonb not null default '[]' check (jsonb_typeof(evidence) = 'array' and length(evidence::text) <= 12000),
  confidence real check (confidence between 0 and 1),
  origin text not null default 'manual' check (origin in ('scan','auto','ai','manual')),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index product_map_persona_key on pulse.product_map_persona (org_id, product_id, key);

create table pulse.product_map_journey (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  key text not null check (length(key) between 1 and 120),
  persona_key text not null default '' check (length(persona_key) <= 80),
  title text not null check (length(btrim(title)) between 1 and 160),
  goal text not null default '' check (length(goal) <= 1000),
  status text not null default 'drafted' check (status in ('discovered','auto','drafted','planned','shipped')),
  -- [{screen, action, element, expected, proposed, note}]
  steps jsonb not null default '[]' check (jsonb_typeof(steps) = 'array' and length(steps::text) <= 40000),
  evidence jsonb not null default '[]' check (jsonb_typeof(evidence) = 'array' and length(evidence::text) <= 12000),
  confidence real check (confidence between 0 and 1),
  -- discovered from telemetry: {sessions, medianMs, people}
  usage jsonb not null default '{}' check (jsonb_typeof(usage) = 'object' and length(usage::text) <= 2000),
  origin text not null default 'manual' check (origin in ('scan','telemetry','auto','ai','manual')),
  priority text not null default '' check (priority in ('','now','next','later')),
  target_version_id uuid references pulse.story_version(id) on delete set null,
  acceptance text[] not null default '{}' check (cardinality(acceptance) <= 30),
  created_by uuid references pulse.person(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index product_map_journey_key on pulse.product_map_journey (org_id, product_id, key);

create table pulse.product_map_issue (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  fingerprint text not null check (length(fingerprint) between 1 and 300),
  kind text not null check (kind in ('dead_end','orphan','no_op','missing_link','permission','slow','error','other')),
  severity text not null default 'medium' check (severity in ('high','medium','low')),
  title text not null check (length(btrim(title)) between 1 and 200),
  detail text not null default '' check (length(detail) <= 2000),
  screen_key text not null default '' check (length(screen_key) <= 200),
  journey_key text not null default '' check (length(journey_key) <= 120),
  evidence jsonb not null default '[]' check (jsonb_typeof(evidence) = 'array' and length(evidence::text) <= 8000),
  confidence real check (confidence between 0 and 1),
  origin text not null default 'auto' check (origin in ('auto','ai','manual')),
  status text not null default 'open' check (status in ('open','accepted','fixed','dismissed')),
  seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index product_map_issue_fp on pulse.product_map_issue (org_id, product_id, fingerprint);

create table pulse.product_map_idea (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  title text not null check (length(btrim(title)) between 2 and 200),
  body text not null default '' check (length(body) <= 4000),
  kind text not null default 'change' check (kind in ('screen','feature','journey','change','fix')),
  screens text[] not null default '{}' check (cardinality(screens) <= 50),
  persona_key text not null default '' check (length(persona_key) <= 80),
  journey_key text not null default '' check (length(journey_key) <= 120),
  issue_id uuid references pulse.product_map_issue(id) on delete set null,
  priority text not null default 'next' check (priority in ('now','next','later')),
  status text not null default 'new' check (status in ('new','planned','building','shipped','parked')),
  target_version_id uuid references pulse.story_version(id) on delete set null,
  origin text not null default 'manual' check (origin in ('auto','ai','manual')),
  created_by uuid references pulse.person(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index product_map_idea_product on pulse.product_map_idea (org_id, product_id, created_at desc);

create table pulse.product_map_idea_vote (
  org_id uuid not null references pulse.org(id),
  idea_id uuid not null references pulse.product_map_idea(id) on delete cascade,
  person_id uuid not null references pulse.person(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (idea_id, person_id)
);

create table pulse.product_map_comment (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  idea_id uuid not null references pulse.product_map_idea(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 2000),
  created_by uuid references pulse.person(id) on delete set null,
  created_at timestamptz not null default now()
);
create index product_map_comment_idea on pulse.product_map_comment (org_id, idea_id, created_at);

create table pulse.product_map_token (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 80),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  can_push boolean not null default false,
  created_by uuid references pulse.person(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create unique index product_map_token_hash on pulse.product_map_token (hash);
create index product_map_token_product on pulse.product_map_token (org_id, product_id);

create table pulse.product_map_ai_job (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  product_id uuid not null references pulse.story_product(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','done','failed','cancelled')),
  -- the map summary's hash: the same summary is not sent again while a finished pass for it exists (the cache)
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  estimate integer not null check (estimate between 0 and 200000),
  max_out integer not null check (max_out between 100 and 50000),
  requested_by uuid references pulse.person(id) on delete set null,
  agent_id uuid references pulse.person(id) on delete set null,
  lease_until timestamptz,
  engine text check (length(engine) <= 120),
  tokens_in integer check (tokens_in >= 0),
  tokens_out integer check (tokens_out >= 0),
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and length(result::text) <= 200000)),
  error text check (length(error) <= 500),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index product_map_ai_job_queue on pulse.product_map_ai_job (org_id, status, created_at);

create table pulse.product_map_shot (
  screen_id uuid primary key references pulse.product_map_screen(id) on delete cascade,
  org_id uuid not null references pulse.org(id),
  mime text not null check (mime in ('image/png','image/jpeg','image/webp')),
  bytes bytea not null check (octet_length(bytes) between 1 and 1500000),
  width integer check (width between 1 and 10000),
  height integer check (height between 1 and 40000),
  captured_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['product_map_source','product_map_screen','product_map_element','product_map_edge','product_map_feature',
    'product_map_persona','product_map_journey','product_map_issue','product_map_idea','product_map_idea_vote','product_map_comment',
    'product_map_token','product_map_ai_job','product_map_shot'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select, insert, update, delete on pulse.%I to pulse_api', t);
  end loop;
end $$;

-- Product map joins Pulse's feature catalogue (a draft until the founder reviews it), in the Pulse organisation only.
do $$
declare v_org uuid;
begin
  select id into v_org from pulse.org where handle = 'pulsehq';
  if v_org is null then return; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  insert into pulse.hq_feature(org_id, key, category, name, promise, what, who, status, icon, proof, sort, draft, href)
  values (v_org, 'product-map', 'platform', 'Product map', 'Connect an app and see every screen, user type, journey and gap',
    'Connect any app (its code, a test account, a manifest or Pulse telemetry): Pulse lists its screens, tabs, buttons and features, finds who uses it and their journeys, flags dead ends and missing links, and lets the team plan the next version for people and AI agents to build.',
    'Founders, product, design and engineering teams', 'beta', 'Map', '/product-map, product-map.ts, Product map migration', 42, true, '/product-map')
  on conflict (org_id, key) do nothing;
  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
-- Forward-only.
