-- migrate:up
-- PR-PIPELINE (owner, 6 Nov 2026): PR as a continuous pipeline on top of PR Studio (1597), for any company on Pulse.
-- "Measure all work as it happens and turn it into PR: ideas, briefs, a calendar, designed creatives and approvals."
-- Three kinds of brand, each its own workspace with its own kit, calendar and approvals (pr_brand):
--   company   the organisation's own brand;
--   personal  a person's own brand (their work here, and "My career" from their account when PROFILE-UNIFY is there);
--   client    an agency's or freelancer's client brand. Its members (pr_brand_member) see only that brand; a client
--             person who is an approver on it approves posts inside Pulse. Client brands never see each other.
-- Per company (forced row security and the tenant policy on every table):
--   pr_pipeline       the switch and settings (AI help, the weekly report's person, the hourly value for estimates).
--   pr_brand          brand workspaces: kit (colours, fonts, logo), industry, goals, posts a week, work sources.
--   pr_brand_member   who works on a brand that is not everyone's (agency staff, freelancers, client approvers).
--   pr_work_event     work as it happens, attributed to people, each with a proof link: commits, merges, releases,
--                     deploys, lane reports (pulse.pr_work_ingest, the host collector) and tasks done, deliveries, goals,
--                     meetings, client outcomes and bugs fixed (pulse.pr_work_collect, from the company's own records).
--                     Deduplicated by source key and by fingerprint (a rebased commit is the same work).
--   pr_milestone      events grouped into something worth telling (a lane or topic, a release, a goal, a client).
--   pr_pow_score      a daily "proof of work" snapshot per company, brand and person (velocity, shipped, impact, streak).
--   pr_creative       designed images made from templates (carousel, stat card, quote, before/after, release, weekly
--                     card), rendered on the server with automatic checks (contrast, 360px legibility, crop safety,
--                     spelling, privacy) and attached to a brief and its draft.
--   pr_post_metric    the performance log after posting (entered by hand now; an API source later).
--   pr_work_report    the weekly "what I did" report of a person: a draft until the person shares it, by hand, with
--                     chosen people in another company they lead in (pulse.pr_report_share). Never sent by itself.
-- PR Studio's tables gain a brand (pr_brief, pr_draft, pr_audience), ideas (pr_brief kind 'idea': hook, angle, proof,
-- format) and an approval flow on drafts: draft -> review -> approved -> posted, with "needs the client's OK" on
-- anything that names a client. Nothing here posts or sends anything: people copy and post.
-- Plan limits (brands, creatives a month, AI help a month) follow the company's API tier (API-PLATFORM-2: pulse.api_tier).

-- ------------------------------------------------------------------------------------------------ settings and brands
create table pulse.pr_pipeline (
  org_id uuid primary key references pulse.org(id),
  enabled boolean not null default false,
  ai_assist boolean not null default false,
  report_person_id uuid references pulse.person(id),
  hourly_value numeric(10,2) not null default 1500 check (hourly_value > 0 and hourly_value <= 100000),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  last_collect_at timestamptz,
  last_tick_at timestamptz,
  last_digest_on date,
  last_report_week date,
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);

create table pulse.pr_brand (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('company', 'personal', 'client')),
  name text not null check (length(btrim(name)) between 1 and 80 and name !~ '[[:cntrl:]]'),
  byline text not null default '' check (length(byline) <= 120 and byline !~ '[[:cntrl:]]'),
  industry text not null default 'other' check (industry in ('software', 'real_estate', 'agency', 'consulting', 'ecommerce', 'education', 'creator', 'other')),
  owner_person_id uuid references pulse.person(id),
  client_id uuid references pulse.client(id),
  kit jsonb not null default '{}' check (jsonb_typeof(kit) = 'object' and length(kit::text) <= 70000),
  goals jsonb not null default '[]' check (jsonb_typeof(goals) = 'array' and jsonb_array_length(goals) <= 12 and length(goals::text) <= 4000),
  sources jsonb not null default '{}' check (jsonb_typeof(sources) = 'object' and length(sources::text) <= 8000),
  posts_per_week int not null default 3 check (posts_per_week between 1 and 7),
  client_ok boolean not null default false,
  archived boolean not null default false,
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pr_brand_personal check (kind <> 'personal' or owner_person_id is not null),
  constraint pr_brand_client check (kind <> 'client' or client_ok)
);
create unique index pr_brand_name on pulse.pr_brand (org_id, lower(name));

create table pulse.pr_brand_member (
  org_id uuid not null references pulse.org(id),
  brand_id uuid not null references pulse.pr_brand(id) on delete cascade,
  person_id uuid not null references pulse.person(id),
  role text not null check (role in ('manager', 'editor', 'approver')),
  added_by uuid references pulse.person(id),
  added_at timestamptz not null default now(),
  primary key (brand_id, person_id)
);

-- ------------------------------------------------------------------------------------------------ work events, milestones, scores
create table pulse.pr_work_event (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('commit', 'merge', 'release', 'deploy', 'lane_report', 'task', 'delivery', 'goal', 'meeting', 'outcome', 'bug', 'career', 'harvest')),
  source_key text not null check (length(source_key) between 1 and 200),
  fingerprint text not null check (length(fingerprint) between 1 and 64),
  happened_at timestamptz not null,
  brand_id uuid references pulse.pr_brand(id),
  person_id uuid references pulse.person(id),
  actor text not null default '' check (length(actor) <= 120 and actor !~ '[[:cntrl:]]'),
  topic text not null default '' check (length(topic) <= 120 and topic !~ '[[:cntrl:]]'),
  title text not null check (length(btrim(title)) between 1 and 240 and title !~ '[[:cntrl:]]'),
  detail text not null default '' check (length(detail) <= 2000),
  proof_url text not null check (length(proof_url) between 1 and 500 and proof_url ~ '^(https://|/|report:|git:)' and proof_url !~ '\s'),
  repo text not null default '' check (length(repo) <= 120),
  client_named text not null default '' check (length(client_named) <= 120),
  hours numeric(8,2) not null default 0 check (hours >= 0 and hours <= 2000),
  value numeric(14,2) not null default 0 check (value >= 0),
  created_at timestamptz not null default now()
);
create unique index pr_work_event_key on pulse.pr_work_event (org_id, source_key);
create unique index pr_work_event_fp on pulse.pr_work_event (org_id, fingerprint);
create index pr_work_event_at on pulse.pr_work_event (org_id, happened_at desc);
create index pr_work_event_topic on pulse.pr_work_event (org_id, topic, happened_at desc);

create table pulse.pr_milestone (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references pulse.pr_brand(id),
  key text not null check (length(key) between 1 and 160),
  kind text not null check (kind in ('topic', 'release', 'project', 'goal', 'client', 'meetings', 'career', 'harvest')),
  title text not null check (length(btrim(title)) between 1 and 200),
  summary text not null default '' check (length(summary) <= 4000),
  started_on date not null,
  ended_on date not null,
  events int not null default 0,
  people int not null default 0,
  hours numeric(10,2) not null default 0,
  value numeric(16,2) not null default 0,
  proof jsonb not null default '[]' check (jsonb_typeof(proof) = 'array' and jsonb_array_length(proof) <= 12),
  shipped boolean not null default false,
  client_named text not null default '',
  status text not null default 'open' check (status in ('open', 'ready', 'ideated', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, brand_id, key)
);
create index pr_milestone_status on pulse.pr_milestone (org_id, status, updated_at desc);

create table pulse.pr_pow_score (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  day date not null,
  brand_id uuid references pulse.pr_brand(id),
  person_id uuid references pulse.person(id),
  events_7d int not null default 0,
  velocity numeric(8,2) not null default 0,
  shipped_7d int not null default 0,
  hours_30d numeric(10,2) not null default 0,
  value_30d numeric(16,2) not null default 0,
  streak int not null default 0,
  score int not null default 0 check (score between 0 and 100),
  created_at timestamptz not null default now()
);
create unique index pr_pow_score_day on pulse.pr_pow_score (org_id, day, brand_id, person_id) nulls not distinct;

-- ------------------------------------------------------------------------------------------------ PR Studio gains brands, ideas and approvals
alter table pulse.pr_audience add column brand_id uuid references pulse.pr_brand(id);
alter table pulse.pr_brief drop constraint pr_brief_kind_check;
alter table pulse.pr_brief add constraint pr_brief_kind_check check (kind in ('morning', 'evening', 'update', 'weekly', 'idea', 'digest', 'report'));
alter table pulse.pr_brief
  add column brand_id uuid references pulse.pr_brand(id),
  add column milestone_id uuid references pulse.pr_milestone(id),
  add column hook text not null default '' check (length(hook) <= 280),
  add column angle text check (angle in ('social_proof', 'authority', 'curiosity', 'contrast', 'before_after')),
  add column format text check (format in ('carousel', 'single', 'thread', 'case_study', 'release_note', 'customer_story')),
  add column proof jsonb not null default '[]' check (jsonb_typeof(proof) = 'array' and jsonb_array_length(proof) <= 12 and length(proof::text) <= 6000),
  add column needs_client_ok boolean not null default false;
create unique index pr_brief_idea on pulse.pr_brief (org_id, milestone_id, brand_id) where kind = 'idea' and written_by = 'auto';
create unique index pr_brief_digest on pulse.pr_brief (org_id, day) where kind = 'digest' and written_by = 'auto';

alter table pulse.pr_draft
  add column brand_id uuid references pulse.pr_brand(id),
  add column format text check (format in ('carousel', 'single', 'thread', 'case_study', 'release_note', 'customer_story')),
  add column pipeline boolean not null default false,
  add column approval text not null default 'draft' check (approval in ('draft', 'review', 'approved', 'posted')),
  add column needs_client_ok boolean not null default false,
  add column client_named text not null default '' check (length(client_named) <= 120),
  add column client_ok_by uuid references pulse.person(id),
  add column client_ok_at timestamptz,
  add column client_ok_note text not null default '' check (length(client_ok_note) <= 500),
  add column reviewed_by uuid references pulse.person(id),
  add column approved_by uuid references pulse.person(id),
  add column approved_at timestamptz,
  add column posted_url text check (posted_url is null or (length(posted_url) <= 500 and posted_url ~ '^https://'));
create index pr_draft_brand on pulse.pr_draft (org_id, brand_id, plan_on);

create table pulse.pr_creative (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references pulse.pr_brand(id),
  brief_id uuid references pulse.pr_brief(id),
  draft_id uuid references pulse.pr_draft(id),
  report_id uuid,
  template text not null check (template in ('carousel', 'stat', 'quote', 'before_after', 'release', 'weekly')),
  slide int not null default 1 check (slide between 1 and 10),
  slides int not null default 1 check (slides between 1 and 10),
  size text not null default 'portrait' check (size in ('square', 'portrait', 'x', 'story', 'card')),
  theme text not null default 'dark' check (theme in ('dark', 'surface', 'light', 'accent')),
  layout text not null default '' check (length(layout) <= 40),
  slots jsonb not null default '{}' check (jsonb_typeof(slots) = 'object' and length(slots::text) <= 8000),
  status text not null default 'queued' check (status in ('queued', 'rendered', 'failed')),
  png bytea check (octet_length(png) <= 4194304),
  checks jsonb not null default '{}' check (jsonb_typeof(checks) = 'object' and length(checks::text) <= 8000),
  checks_ok boolean,
  error text not null default '' check (length(error) <= 500),
  rendered_at timestamptz,
  created_at timestamptz not null default now()
);
create index pr_creative_queue on pulse.pr_creative (org_id, created_at) where status = 'queued';
create index pr_creative_draft on pulse.pr_creative (org_id, draft_id, slide);

create table pulse.pr_post_metric (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references pulse.pr_draft(id),
  recorded_on date not null,
  source text not null default 'manual' check (source in ('manual', 'api')),
  impressions int check (impressions >= 0),
  reactions int check (reactions >= 0),
  comments int check (comments >= 0),
  shares int check (shares >= 0),
  clicks int check (clicks >= 0),
  followers int check (followers >= 0),
  note text not null default '' check (length(note) <= 500),
  recorded_by uuid references pulse.person(id),
  created_at timestamptz not null default now()
);
create index pr_post_metric_draft on pulse.pr_post_metric (org_id, draft_id, recorded_on desc);

create table pulse.pr_work_report (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references pulse.person(id),
  brand_id uuid references pulse.pr_brand(id),
  week_start date not null,
  title text not null check (length(btrim(title)) between 1 and 160),
  body text not null check (length(body) between 1 and 12000),
  numbers jsonb not null default '{}' check (jsonb_typeof(numbers) = 'object'),
  proof jsonb not null default '[]' check (jsonb_typeof(proof) = 'array' and jsonb_array_length(proof) <= 40),
  next text not null default '' check (length(next) <= 4000),
  status text not null default 'draft' check (status in ('draft', 'shared')),
  shared jsonb not null default '[]' check (jsonb_typeof(shared) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, person_id, week_start)
);
alter table pulse.pr_creative add constraint pr_creative_report foreign key (report_id) references pulse.pr_work_report(id);

create trigger pr_brand_touch before update on pulse.pr_brand for each row execute function pulse.pr_touch();
create trigger pr_milestone_touch before update on pulse.pr_milestone for each row execute function pulse.pr_touch();
create trigger pr_work_report_touch before update on pulse.pr_work_report for each row execute function pulse.pr_touch();

-- ------------------------------------------------------------------------------------------------ who works on which brand
-- PR Studio's users (pr_can: admins, leadership, AI employees) work on every brand of the company. Anyone else works on
-- the brands they are a member of: a manager or editor writes, an approver (a colleague or the client) reads and approves.
create function pulse.pr_brand_role(p_brand uuid) returns text
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select case when p_brand is null then null when pr_can() then 'manager' else
   (select m.role from pr_brand_member m join person p on p.id = m.person_id and p.status = 'active'
     where m.org_id = current_org() and m.brand_id = p_brand and m.person_id = current_viewer() and not viewer_outside_seat()) end
$$;
create function pulse.pr_brand_see(p_brand uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select pr_brand_role(p_brand) is not null $$;
create function pulse.pr_brand_edit(p_brand uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select pr_brand_role(p_brand) in ('manager', 'editor') $$;

-- ------------------------------------------------------------------------------------------------ row security
alter table pulse.pr_pipeline enable row level security;
alter table pulse.pr_pipeline force row level security;
create policy tenant_isolation on pulse.pr_pipeline using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_pipeline_use on pulse.pr_pipeline as restrictive to pulse_api using (pulse.pr_can()) with check (pulse.pr_can());

alter table pulse.pr_brand enable row level security;
alter table pulse.pr_brand force row level security;
create policy tenant_isolation on pulse.pr_brand using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_brand_read on pulse.pr_brand as restrictive for select to pulse_api using (pulse.pr_brand_see(id));
create policy pr_brand_ins on pulse.pr_brand as restrictive for insert to pulse_api with check (pulse.pr_can());
create policy pr_brand_upd on pulse.pr_brand as restrictive for update to pulse_api using (pulse.pr_brand_role(id) = 'manager') with check (pulse.pr_brand_role(id) = 'manager');

alter table pulse.pr_brand_member enable row level security;
alter table pulse.pr_brand_member force row level security;
create policy tenant_isolation on pulse.pr_brand_member using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_brand_member_use on pulse.pr_brand_member as restrictive to pulse_api
  using (pulse.pr_brand_see(brand_id)) with check (pulse.pr_brand_role(brand_id) = 'manager');

alter table pulse.pr_work_event enable row level security;
alter table pulse.pr_work_event force row level security;
create policy tenant_isolation on pulse.pr_work_event using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_work_event_use on pulse.pr_work_event as restrictive to pulse_api
  using (pulse.pr_can() or (brand_id is not null and pulse.pr_brand_see(brand_id))) with check (pulse.pr_can());

alter table pulse.pr_milestone enable row level security;
alter table pulse.pr_milestone force row level security;
create policy tenant_isolation on pulse.pr_milestone using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_milestone_use on pulse.pr_milestone as restrictive to pulse_api using (pulse.pr_brand_see(brand_id)) with check (pulse.pr_brand_edit(brand_id));

alter table pulse.pr_pow_score enable row level security;
alter table pulse.pr_pow_score force row level security;
create policy tenant_isolation on pulse.pr_pow_score using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_pow_score_use on pulse.pr_pow_score as restrictive to pulse_api
  using (pulse.pr_can() or (brand_id is not null and pulse.pr_brand_see(brand_id)) or person_id = pulse.current_viewer()) with check (pulse.pr_can());

alter table pulse.pr_creative enable row level security;
alter table pulse.pr_creative force row level security;
create policy tenant_isolation on pulse.pr_creative using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_creative_use on pulse.pr_creative as restrictive to pulse_api using (pulse.pr_brand_see(brand_id)) with check (pulse.pr_brand_edit(brand_id));

alter table pulse.pr_post_metric enable row level security;
alter table pulse.pr_post_metric force row level security;
create policy tenant_isolation on pulse.pr_post_metric using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_post_metric_use on pulse.pr_post_metric as restrictive to pulse_api
  using (exists (select 1 from pulse.pr_draft d where d.id = draft_id))
  with check (exists (select 1 from pulse.pr_draft d where d.id = draft_id and (d.brand_id is null and pulse.pr_can() or pulse.pr_brand_edit(d.brand_id))));

alter table pulse.pr_work_report enable row level security;
alter table pulse.pr_work_report force row level security;
create policy tenant_isolation on pulse.pr_work_report using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- A person's weekly report is theirs: they (and the company's PR Studio users) read it; only they change or share it.
create policy pr_work_report_see on pulse.pr_work_report as restrictive for select to pulse_api using (person_id = pulse.current_viewer() or pulse.pr_can());
create policy pr_work_report_ins on pulse.pr_work_report as restrictive for insert to pulse_api with check (pulse.pr_can());
create policy pr_work_report_upd on pulse.pr_work_report as restrictive for update to pulse_api using (person_id = pulse.current_viewer()) with check (person_id = pulse.current_viewer());

-- PR Studio's drafts, briefs and audiences: a brand's members work on that brand's (and only that brand's) too.
drop policy pr_draft_use on pulse.pr_draft;
create policy pr_draft_use on pulse.pr_draft as restrictive to pulse_api
  using (pulse.pr_can() or (brand_id is not null and pulse.pr_brand_see(brand_id)))
  with check (pulse.pr_can() or (brand_id is not null and pulse.pr_brand_see(brand_id)));
drop policy pr_audience_use on pulse.pr_audience;
create policy pr_audience_use on pulse.pr_audience as restrictive to pulse_api
  using (pulse.pr_can() or (brand_id is not null and pulse.pr_brand_see(brand_id)))
  with check (pulse.pr_can() or (brand_id is not null and pulse.pr_brand_edit(brand_id)));
drop policy pr_brief_see on pulse.pr_brief;
create policy pr_brief_see on pulse.pr_brief as restrictive for select to pulse_api
  using (pulse.pr_can() or (person_id is not null and person_id = pulse.current_viewer()) or (brand_id is not null and pulse.pr_brand_see(brand_id)));

grant select, insert, update (name, byline, industry, kit, goals, sources, posts_per_week, client_ok, archived, updated_at) on pulse.pr_brand to pulse_api;
grant select, insert, delete on pulse.pr_brand_member to pulse_api;
grant update (role) on pulse.pr_brand_member to pulse_api;
grant select on pulse.pr_pipeline, pulse.pr_work_event, pulse.pr_pow_score to pulse_api;
grant select, update (status) on pulse.pr_milestone to pulse_api;
grant select (org_id, id, brand_id, brief_id, draft_id, report_id, template, slide, slides, size, theme, layout, slots, status, png, checks, checks_ok, error, rendered_at, created_at) on pulse.pr_creative to pulse_api;
grant update (slots, status, theme, layout) on pulse.pr_creative to pulse_api;
grant select, insert on pulse.pr_post_metric to pulse_api;
grant select, insert, update (title, body, next, updated_at) on pulse.pr_work_report to pulse_api;
grant update (brand_id, format, posted_url) on pulse.pr_draft to pulse_api;
grant update (brand_id) on pulse.pr_audience to pulse_api;
-- The worker (the pipeline tick and the host collector) works through the functions below and reads the creative queue.
grant select on pulse.pr_pipeline, pulse.pr_brand, pulse.pr_creative, pulse.pr_work_event, pulse.pr_milestone to pulse_worker;
grant update (png, checks, checks_ok, status, error, rendered_at) on pulse.pr_creative to pulse_worker;

-- ------------------------------------------------------------------------------------------------ plans and templates
-- What the company's plan allows a month (API-PLATFORM-2 tiers), and what it used.
create function pulse.pr_limits() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 with t as (select coalesce(api_tier(), 'free') tier),
 l as (select tier, case tier when 'free' then 1 when 'pro' then 3 when 'business' then 15 else 100 end brands,
          case tier when 'free' then 20 when 'pro' then 150 when 'business' then 1000 else 10000 end creatives,
          case tier when 'free' then 0 when 'pro' then 30 when 'business' then 200 else 2000 end ai from t)
 select jsonb_build_object('tier', l.tier, 'brands', l.brands, 'creativesPerMonth', l.creatives, 'aiPerMonth', l.ai,
   'used', jsonb_build_object(
     'brands', (select count(*) from pr_brand where org_id = current_org() and not archived),
     'creatives', (select count(distinct coalesce(draft_id, id)) from pr_creative where org_id = current_org() and created_at >= date_trunc('month', now())),
     'ai', (select count(*) from task where org_id = current_org() and source = 'pr-pipeline' and created_at >= date_trunc('month', now()))))
 from l
$$;

-- Sensible starting points per industry: audiences (name, tone, channel, image shape), goals, posts a week and the
-- angles that work for it. Generic words only; the wizard shows them and the company changes anything.
create function pulse.pr_industry_template(p_industry text) returns jsonb language sql immutable as $$
 select case p_industry
  when 'software' then '{"postsPerWeek":3,"angles":["before_after","authority","curiosity"],"formats":["release_note","carousel","thread"],
    "audiences":[{"name":"Customers","tone":"plain","channel":"email","ratio":"16:9"},{"name":"LinkedIn followers","tone":"bold","channel":"linkedin","ratio":"4:5"},{"name":"Developers on X","tone":"plain","channel":"x","ratio":"16:9"}],
    "goals":["Show what shipped every week","Turn releases into customer updates","Grow trust with proof"]}'
  when 'real_estate' then '{"postsPerWeek":3,"angles":["social_proof","before_after","contrast"],"formats":["customer_story","carousel","single"],
    "audiences":[{"name":"Buyers and investors","tone":"warm","channel":"whatsapp","ratio":"4:5"},{"name":"LinkedIn followers","tone":"formal","channel":"linkedin","ratio":"4:5"},{"name":"Channel partners","tone":"plain","channel":"whatsapp","ratio":"1:1"}],
    "goals":["Show delivered projects","Share happy-client stories","Keep partners informed"]}'
  when 'agency' then '{"postsPerWeek":3,"angles":["social_proof","before_after","authority"],"formats":["case_study","carousel","single"],
    "audiences":[{"name":"Prospective clients","tone":"bold","channel":"linkedin","ratio":"4:5"},{"name":"Client updates","tone":"warm","channel":"email","ratio":"16:9"}],
    "goals":["Show results for clients","Win new clients with case studies"]}'
  when 'consulting' then '{"postsPerWeek":2,"angles":["authority","curiosity","contrast"],"formats":["thread","case_study","single"],
    "audiences":[{"name":"LinkedIn followers","tone":"formal","channel":"linkedin","ratio":"4:5"},{"name":"Newsletter","tone":"warm","channel":"email","ratio":"16:9"}],
    "goals":["Be known for one expertise","Share lessons from real work"]}'
  when 'ecommerce' then '{"postsPerWeek":4,"angles":["social_proof","contrast","curiosity"],"formats":["carousel","single","customer_story"],
    "audiences":[{"name":"Customers","tone":"warm","channel":"whatsapp","ratio":"1:1"},{"name":"Followers","tone":"bold","channel":"x","ratio":"4:5"}],
    "goals":["Launch products with a story","Share customer love"]}'
  when 'education' then '{"postsPerWeek":3,"angles":["before_after","social_proof","authority"],"formats":["carousel","customer_story","single"],
    "audiences":[{"name":"Students and parents","tone":"warm","channel":"whatsapp","ratio":"4:5"},{"name":"LinkedIn followers","tone":"formal","channel":"linkedin","ratio":"4:5"}],
    "goals":["Show student outcomes","Share what is new in the programme"]}'
  when 'creator' then '{"postsPerWeek":4,"angles":["curiosity","before_after","authority"],"formats":["thread","carousel","single"],
    "audiences":[{"name":"LinkedIn followers","tone":"bold","channel":"linkedin","ratio":"4:5"},{"name":"Followers on X","tone":"plain","channel":"x","ratio":"16:9"}],
    "goals":["Build in public","Show proof of work every week"]}'
  else '{"postsPerWeek":2,"angles":["social_proof","before_after","curiosity"],"formats":["single","carousel"],
    "audiences":[{"name":"LinkedIn followers","tone":"warm","channel":"linkedin","ratio":"4:5"},{"name":"Customers","tone":"plain","channel":"whatsapp","ratio":"1:1"}],
    "goals":["Show the work every week"]}' end::jsonb
$$;

-- Set up a brand in one step (the three-step wizard's last click): the brand and its kit, audiences and goals from the
-- industry template (or as sent), its work sources, and the pipeline switched on. p: {name, kind, industry, byline,
-- ownerPersonId, clientId, kit, goals, audiences:[{name,tone,channel,ratio}], postsPerWeek, sources, approvers:[person ids]}.
create function pulse.pr_brand_setup(p jsonb) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := current_org(); me uuid := current_viewer(); tpl jsonb; b uuid; kind text := coalesce(p->>'kind', 'company');
  lim jsonb := pr_limits(); a jsonb; n int := 0; ind text := coalesce(p->>'industry', 'other'); aud uuid;
begin
 if not pr_can() or coalesce((select side from person where id = me), '') <> 'staff' then
   raise exception 'Brands are set up by the company''s admins and leadership' using errcode = '42501'; end if;
 if (lim->'used'->>'brands')::int >= (lim->>'brands')::int then
   raise exception 'Your plan includes % brand(s); upgrade the plan for more', lim->>'brands' using errcode = '53400'; end if;
 tpl := pr_industry_template(ind);
 insert into pr_brand (org_id, kind, name, byline, industry, owner_person_id, client_id, kit, goals, sources, posts_per_week, client_ok, created_by)
 values (org, kind, btrim(p->>'name'), coalesce(p->>'byline', ''), ind,
   case when kind = 'personal' then coalesce((p->>'ownerPersonId')::uuid, me) end,
   case when kind = 'client' then (p->>'clientId')::uuid end,
   coalesce(p->'kit', '{}'), coalesce(p->'goals', tpl->'goals', '[]'), coalesce(p->'sources', '{}'),
   coalesce((p->>'postsPerWeek')::int, (tpl->>'postsPerWeek')::int, 3), kind = 'client' or coalesce((p->>'clientOk')::boolean, false), me)
 returning id into b;
 for a in select * from jsonb_array_elements(coalesce(p->'audiences', tpl->'audiences')) loop
   n := n + 1; exit when n > 6;
   insert into pr_audience (org_id, name, tone, channel, ratio, brand_id, created_by)
   values (org, left(btrim(a->>'name') || ' · ' || btrim(p->>'name'), 80), coalesce(a->>'tone', 'warm'), coalesce(a->>'channel', 'linkedin'), coalesce(a->>'ratio', '4:5'), b, me)
   on conflict (org_id, lower(name)) do nothing returning id into aud;
 end loop;
 insert into pr_brand_member (org_id, brand_id, person_id, role, added_by)
 select org, b, x::uuid, 'approver', me from jsonb_array_elements_text(coalesce(p->'approvers', '[]')) x
   join person pp on pp.id = x::uuid and pp.org_id = org and pp.status = 'active'
 on conflict do nothing;
 insert into pr_pipeline (org_id, enabled, report_person_id, updated_by) values (org, true, case when kind = 'personal' then coalesce((p->>'ownerPersonId')::uuid, me) end, me)
 on conflict (org_id) do update set enabled = true, report_person_id = coalesce(pr_pipeline.report_person_id, excluded.report_person_id), updated_by = me, updated_at = now();
 return b;
end $$;

-- The pipeline's switches: on/off, AI help (the company's PR agents sharpen new ideas, within the plan and the agents'
-- own budgets), whose weekly report is written, and the hourly value used for impact estimates.
create function pulse.pr_pipeline_set(p jsonb) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not pr_can() or coalesce((select side from person where id = current_viewer()), '') <> 'staff' then
   raise exception 'The pipeline is set by the company''s admins and leadership' using errcode = '42501'; end if;
 insert into pr_pipeline (org_id, updated_by) values (current_org(), current_viewer()) on conflict (org_id) do nothing;
 update pr_pipeline set
   enabled = coalesce((p->>'enabled')::boolean, enabled),
   ai_assist = coalesce((p->>'aiAssist')::boolean, ai_assist),
   report_person_id = case when p ? 'reportPersonId' then nullif(p->>'reportPersonId', '')::uuid else report_person_id end,
   hourly_value = coalesce((p->>'hourlyValue')::numeric, hourly_value),
   currency = coalesce(p->>'currency', currency),
   updated_by = current_viewer(), updated_at = now()
 where org_id = current_org();
 return (select to_jsonb(x) - 'org_id' from pr_pipeline x where org_id = current_org());
end $$;

-- ------------------------------------------------------------------------------------------------ work events in
-- Hours a person would need for the same work (the EV-01 replacement-value method: count what shipped, estimate the
-- hours of a conventional team for it, value at the company's hourly value). Deliberately conservative.
create function pulse.pr_hours_for(p_source text, p_detail jsonb) returns numeric language sql immutable as $$
 select coalesce((p_detail->>'hours')::numeric, case p_source when 'commit' then 0.5 when 'merge' then 1 when 'release' then 4 when 'deploy' then 1
   when 'lane_report' then case when p_detail->>'status' = 'DONE' then 16 else 6 end when 'task' then coalesce((p_detail->>'estimateMinutes')::numeric / 60, 1)
   when 'delivery' then 2 when 'goal' then 8 when 'outcome' then 4 when 'bug' then 2 when 'meeting' then 1 else 0 end)
$$;

-- Titles that look private are never collected (pay, HR, health, family, IDs, contact numbers).
create function pulse.pr_private(p text) returns boolean language sql immutable as $$
 select coalesce(p, '') ~* '(salar|payroll|pay ?slip|payout|appraisal|increment|bonus|incentive|reimburs|resign|terminat|warning letter|disciplin|medical|health|pregnan|family|wife|husband|loan|advance|bank|ifsc|aadha|pan card|passport|password|otp|penalt|confidential|private|personal|interview|candidate|offer letter)'
   or coalesce(p, '') ~ '(\+?\d[\d\s().-]{8,}\d)'
$$;

create function pulse.pr_fingerprint(p_source text, p_title text, p_day date, p_key text) returns text language sql immutable as $$
 select md5(case when p_source in ('commit', 'merge') then p_source || ':' || lower(regexp_replace(p_title, '\W+', '', 'g'))
   else p_key end)
$$;

-- The host collector's way in (worker role, one tenant per transaction): a JSON array of events
-- [{source, key, at, title, detail, proof, repo, topic, actor, person, brand, client, hours, status}]. Unknown or private
-- lines are skipped; a known key or fingerprint is skipped. Returns how many were added.
create function pulse.pr_work_ingest(p jsonb) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := current_org(); e jsonb; n int := 0; k int; rate numeric; br uuid;
begin
 if org is null then raise exception 'No company' using errcode = '42501'; end if;
 if coalesce(current_setting('pulse.viewer_id', true), '') <> '' and not pr_can() then raise exception 'Not allowed' using errcode = '42501'; end if;
 if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 5000 then raise exception 'Send up to 5000 events as a list' using errcode = '22023'; end if;
 select hourly_value into rate from pr_pipeline where org_id = org and enabled;
 if rate is null then return 0; end if;
 for e in select * from jsonb_array_elements(p) loop
   continue when e->>'source' is null or e->>'key' is null or coalesce(btrim(e->>'title'), '') = '' or coalesce(e->>'proof', '') = '';
   continue when pr_private(e->>'title') or pr_private(e->>'detail');
   br := (select id from pr_brand where org_id = org and id = nullif(e->>'brand', '')::uuid);
   insert into pr_work_event (org_id, source, source_key, fingerprint, happened_at, brand_id, person_id, actor, topic, title, detail, proof_url, repo, client_named, hours, value)
   values (org, e->>'source', left(e->>'key', 200), pr_fingerprint(e->>'source', e->>'title', (e->>'at')::timestamptz::date, left(e->>'key', 200)),
     (e->>'at')::timestamptz, br,
     (select id from person where org_id = org and id = nullif(e->>'person', '')::uuid),
     left(coalesce(e->>'actor', ''), 120), left(coalesce(e->>'topic', ''), 120), left(regexp_replace(btrim(e->>'title'), '[[:cntrl:]]', ' ', 'g'), 240),
     left(coalesce(e->>'detail', ''), 2000), e->>'proof', left(coalesce(e->>'repo', ''), 120), left(coalesce(e->>'client', ''), 120),
     least(pr_hours_for(e->>'source', e), 2000), least(pr_hours_for(e->>'source', e), 2000) * rate)
   on conflict do nothing;
   get diagnostics k = row_count; n := n + k;
 end loop;
 return n;
end $$;

-- The company's own records since a time (at most 92 days back): tasks done (one event per task, to its assignee; never
-- a private-looking title), deliveries (per project and day), goals reached or moved, product releases, bugs fixed,
-- client approvals (an outcome that names the client) and meetings told in the Story. Idempotent by source key.
create function pulse.pr_work_collect(p_since timestamptz) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := current_org(); tz text := org_time_zone(); since timestamptz := greatest(coalesce(p_since, now() - interval '30 days'), now() - interval '92 days');
  rate numeric; n int := 0; k int; company uuid;
begin
 if coalesce(current_setting('pulse.viewer_id', true), '') <> '' and not pr_can() then raise exception 'Not allowed' using errcode = '42501'; end if;
 select hourly_value into rate from pr_pipeline where org_id = org and enabled;
 if rate is null then return 0; end if;
 select id into company from pr_brand where org_id = org and kind = 'company' and not archived order by created_at limit 1;
 -- Tasks done (client brands: a task in a project of the client's goes to that brand).
 insert into pr_work_event (org_id, source, source_key, fingerprint, happened_at, brand_id, person_id, actor, topic, title, detail, proof_url, client_named, hours, value)
 select org, 'task', 'task:' || t.id, md5('task:' || t.id), t.done_at,
   coalesce((select b.id from pr_brand b join project pj on pj.id = t.project_id where b.org_id = org and b.kind = 'client' and not b.archived
       and (b.sources->'projects') ? t.project_id::text limit 1), company),
   t.assignee_person_id, coalesce((select display_name from person where id = t.assignee_person_id), ''),
   'project:' || coalesce(t.project_id::text, 'none'), left(t.title, 240), coalesce('In ' || (select coalesce(pj.title, pj.name) from project pj where pj.id = t.project_id), ''),
   '/tasks/' || t.id, '', pr_hours_for('task', jsonb_build_object('estimateMinutes', t.estimate_minutes)),
   pr_hours_for('task', jsonb_build_object('estimateMinutes', t.estimate_minutes)) * rate
 from task t
 where t.org_id = org and t.status in ('done', 'accepted') and t.done_at >= since and t.deleted_at is null and not t.leadership_only
   and not pr_private(t.title) and coalesce(t.source, '') <> 'pr-pipeline'
 on conflict do nothing;
 get diagnostics k = row_count; n := n + k;
 -- Deliveries, one event per project and day.
 insert into pr_work_event (org_id, source, source_key, fingerprint, happened_at, brand_id, topic, title, proof_url, hours, value)
 select org, 'delivery', 'delivery:' || coalesce(d.project_id::text, 'none') || ':' || d.dday, md5('delivery:' || coalesce(d.project_id::text, 'none') || ':' || d.dday),
   d.last_at, company, 'project:' || coalesce(d.project_id::text, 'none'),
   d.n || case when d.n = 1 then ' delivery' else ' deliveries' end || coalesce(' in ' || d.project, ''),
   coalesce('/projects/' || d.project_id, '/projects'), 2 * d.n, 2 * d.n * rate
 from (select dl.project_id, (dl.delivered_at at time zone tz)::date as dday, max(dl.delivered_at) last_at, count(*)::int n,
         (select coalesce(pj.title, pj.name) from project pj where pj.id = dl.project_id) project
       from delivery dl where dl.org_id = org and dl.delivered_at >= since group by 1, 2) d
 on conflict do nothing;
 get diagnostics k = row_count; n := n + k;
 -- Goals reached (company and team goals).
 insert into pr_work_event (org_id, source, source_key, fingerprint, happened_at, brand_id, person_id, topic, title, detail, proof_url, hours, value)
 select org, 'goal', 'goal:' || g.id || ':' || g.status, md5('goal:' || g.id || ':' || g.status), coalesce(g.done_at, g.updated_at), company, g.owner_person_id,
   'goal:' || g.id, 'Goal reached: ' || left(g.title, 200),
   case when g.target_value is null then left(coalesce(g.why, ''), 2000) else 'Target ' || trim(to_char(g.target_value, 'FM999G999G999G990D99'), '.') || ' ' || coalesce(g.measure_label, '') end,
   '/goals/' || g.id, 8, 8 * rate
 from goal g where g.org_id = org and g.level in ('company', 'team') and g.status = 'done' and coalesce(g.done_at, g.updated_at) >= since and not pr_private(g.title)
 on conflict do nothing;
 get diagnostics k = row_count; n := n + k;
 -- Product releases (Product Story).
 insert into pr_work_event (org_id, source, source_key, fingerprint, happened_at, brand_id, topic, title, detail, proof_url, hours, value)
 select org, 'release', 'release:' || v.id, md5('release:' || v.id), v.released_on::timestamp at time zone tz, company, 'release:' || v.label,
   left(sp.name || ' ' || v.label || case when v.title <> '' then ': ' || v.title else '' end, 240), left(coalesce(v.summary, ''), 2000), '/story', 4, 4 * rate
 from story_version v join story_product sp on sp.id = v.product_id
 where v.org_id = org and v.released_on >= (since at time zone tz)::date
 on conflict do nothing;
 get diagnostics k = row_count; n := n + k;
 -- Bugs fixed.
 insert into pr_work_event (org_id, source, source_key, fingerprint, happened_at, brand_id, person_id, topic, title, proof_url, hours, value)
 select org, 'bug', 'bug:' || b.id, md5('bug:' || b.id), b.status_at, company, b.assignee_id, 'bugs',
   'Bug #' || b.number || ' fixed', '/bugs?bug=' || b.id, 2, 2 * rate
 from reported_bug b where b.org_id = org and b.status = 'fixed' and b.duplicate_of is null and b.status_at >= since
 on conflict do nothing;
 get diagnostics k = row_count; n := n + k;
 -- Client outcomes: a deliverable the client approved. It names the client, so anything told from it needs their OK.
 insert into pr_work_event (org_id, source, source_key, fingerprint, happened_at, brand_id, person_id, topic, title, proof_url, client_named, hours, value)
 select org, 'outcome', 'outcome:' || cd.id || ':' || cd.version, md5('outcome:' || cd.id || ':' || cd.version), cd.decided_at,
   coalesce((select b.id from pr_brand b where b.org_id = org and b.kind = 'client' and b.client_id = cd.client_id and not b.archived limit 1), company),
   cd.owner_id, 'client:' || cd.client_id, 'Approved by the client: ' || left(cd.title, 200), '/clients/' || cd.client_id,
   left(coalesce((select c.display_name from client c where c.id = cd.client_id), ''), 120), 4, 4 * rate
 from client_deliverable cd where cd.org_id = org and cd.state = 'approved' and cd.decided_at >= since and not pr_private(cd.title)
 on conflict do nothing;
 get diagnostics k = row_count; n := n + k;
 -- Meetings told in the Story (PR Studio): people and AI employees add them.
 insert into pr_work_event (org_id, source, source_key, fingerprint, happened_at, brand_id, topic, title, detail, proof_url, hours, value)
 select org, 'meeting', 'meeting:' || s.id, md5('meeting:' || s.id), s.happened_on::timestamp at time zone tz, company, 'meetings',
   left(s.title, 240), left(s.body, 2000), '/pr?tab=story&line=' || s.id, 1, rate
 from pr_story s where s.org_id = org and s.kind = 'meeting' and not s.hidden and s.created_at >= since and not pr_private(s.title)
 on conflict do nothing;
 get diagnostics k = row_count; n := n + k;
 update pr_pipeline set last_collect_at = now() where org_id = org;
 return n;
end $$;

-- A person's personal brand: "My career" from their account (PROFILE-UNIFY's pulse.account_career, when it is there)
-- adds their highlights across companies as events of their personal brand here. Only the person runs it for themselves.
create function pulse.pr_career_import(p_brand uuid) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := current_org(); me uuid := current_viewer(); c jsonb; s jsonb; h jsonb; n int := 0; k int;
begin
 if not exists (select 1 from pr_brand where id = p_brand and org_id = org and kind = 'personal' and owner_person_id = me) then
   raise exception 'Only the owner of a personal brand adds their career to it' using errcode = '42501'; end if;
 if to_regprocedure('pulse.account_career()') is null then return 0; end if;
 execute 'select pulse.account_career()' into c;
 for s in select * from jsonb_array_elements(coalesce(c->'career', '[]')) loop
   for h in select * from jsonb_array_elements(coalesce(s->'highlights', '[]')) loop
     continue when coalesce(h->>'title', h->>'text', '') = '' or pr_private(coalesce(h->>'title', h->>'text'));
     insert into pr_work_event (org_id, source, source_key, fingerprint, happened_at, brand_id, person_id, topic, title, proof_url)
     values (org, 'career', 'career:' || md5(coalesce(s->>'org', '') || coalesce(h->>'title', h->>'text')), md5('career:' || coalesce(s->>'org', '') || coalesce(h->>'title', h->>'text')),
       coalesce((h->>'at')::timestamptz, (s->>'from')::timestamptz, now()), p_brand, me, 'career:' || coalesce(s->>'org', ''),
       left(coalesce(h->>'title', h->>'text'), 240), '/me/career')
     on conflict do nothing;
     get diagnostics k = row_count; n := n + k;
   end loop;
 end loop;
 return n;
end $$;

-- ------------------------------------------------------------------------------------------------ milestones and scores
-- Which brands an event counts for: its own brand (or the company brand), and the personal brand of the person it is
-- attributed to.
create function pulse.pr_event_brands() returns table (brand_id uuid, event_id uuid)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(e.brand_id, (select id from pr_brand where org_id = current_org() and kind = 'company' and not archived order by created_at limit 1)), e.id
   from pr_work_event e where e.org_id = current_org()
 union
 select b.id, e.id from pr_work_event e join pr_brand b on b.org_id = e.org_id and b.kind = 'personal' and not b.archived and b.owner_person_id = e.person_id
   where e.org_id = current_org()
$$;

-- Group events into milestones per brand and topic (a lane, a project, a release, a goal, a client, the week's
-- meetings), keep their numbers and proof current, and mark a milestone ready to tell once it has shipped: a lane report
-- said DONE, a release or a deploy, a goal reached, a client approval, or five or more events and a quiet day since.
create function pulse.pr_milestones_build() returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := current_org(); n int;
begin
 with x as (
   select eb.brand_id, e.source, e.happened_at, e.person_id, e.hours, e.value, e.detail, e.client_named, e.title, e.proof_url,
     case when e.source in ('release', 'deploy') and e.topic <> '' then e.topic
          when e.source = 'meeting' then 'meetings:' || to_char(date_trunc('week', e.happened_at), 'IYYY-IW')
          when e.topic like 'project:%' then e.topic || ':' || to_char(date_trunc('week', e.happened_at), 'IYYY-IW')
          when e.topic <> '' then e.topic else e.source || ':' || to_char(date_trunc('week', e.happened_at), 'IYYY-IW') end mkey
   from pr_event_brands() eb join pr_work_event e on e.id = eb.event_id where eb.brand_id is not null),
 g as (
   select brand_id, mkey, min(happened_at) first_at, max(happened_at) last_at, count(*)::int events, count(distinct person_id)::int people,
     sum(hours) hours, sum(value) value,
     bool_or(source in ('release', 'deploy', 'goal', 'outcome') or (source = 'lane_report' and detail ~ '^DONE')) shipped_flag,
     max(client_named) filter (where client_named <> '') client,
     (array_agg(title order by case source when 'lane_report' then 0 when 'release' then 1 when 'goal' then 2 when 'outcome' then 3 else 9 end, happened_at desc))[1] lead_title,
     (array_agg(source order by case source when 'lane_report' then 0 when 'release' then 1 when 'goal' then 2 when 'outcome' then 3 else 9 end, happened_at desc))[1] lead_source,
     (select jsonb_agg(p) from (select jsonb_build_object('label', left(x2.title, 120), 'url', x2.proof_url) p from x x2
        where x2.brand_id = x.brand_id and x2.mkey = x.mkey order by case x2.source when 'lane_report' then 0 when 'release' then 1 when 'merge' then 2 else 5 end, x2.happened_at desc limit 8) q) proof
   from x group by brand_id, mkey)
 insert into pr_milestone (org_id, brand_id, key, kind, title, summary, started_on, ended_on, events, people, hours, value, proof, shipped, client_named, status)
 select org, g.brand_id, left(g.mkey, 160),
   case when g.mkey like 'release:%' or g.lead_source in ('release', 'deploy') then 'release' when g.mkey like 'project:%' then 'project' when g.mkey like 'goal:%' then 'goal'
        when g.mkey like 'client:%' then 'client' when g.mkey like 'meetings:%' then 'meetings' when g.mkey like 'career:%' then 'career'
        when g.lead_source = 'harvest' then 'harvest' else 'topic' end,
   left(g.lead_title, 200), '', (g.first_at at time zone org_time_zone())::date, (g.last_at at time zone org_time_zone())::date,
   g.events, g.people, g.hours, g.value, coalesce(g.proof, '[]'),
   g.shipped_flag or g.lead_source = 'harvest', coalesce(g.client, ''),
   case when g.shipped_flag or g.lead_source = 'harvest' or (g.events >= 5 and g.last_at < now() - interval '1 day') then 'ready' else 'open' end
 from g
 on conflict (org_id, brand_id, key) do update set
   events = excluded.events, people = excluded.people, hours = excluded.hours, value = excluded.value, proof = excluded.proof,
   ended_on = excluded.ended_on, shipped = pr_milestone.shipped or excluded.shipped, client_named = excluded.client_named,
   title = case when pr_milestone.status = 'open' then excluded.title else pr_milestone.title end,
   status = case when pr_milestone.status = 'open' then excluded.status else pr_milestone.status end
 where (pr_milestone.events, pr_milestone.hours, pr_milestone.status, pr_milestone.proof) is distinct from (excluded.events, excluded.hours, excluded.status, excluded.proof);
 get diagnostics n = row_count;
 return n;
end $$;

-- Proof of work, once a day per company (brand null, person null), per brand and per person: events in 7 days, velocity
-- (events a day), milestones shipped in 7 days, hours and value in 30 days, the streak of days with work, and a 0-100
-- score (35 activity, 30 shipping, 20 streak, 15 impact). The trend is the score against the one 7 days before.
create function pulse.pr_pow_snapshot() returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := current_org(); tz text := org_time_zone(); today date := (now() at time zone tz)::date; n int;
begin
 with eb as (select eb.brand_id, e.person_id, e.happened_at, (e.happened_at at time zone tz)::date d, e.hours, e.value
             from pr_event_brands() eb join pr_work_event e on e.id = eb.event_id),
 scopes as (
   select null::uuid brand_id, null::uuid person_id union
   select brand_id, null from eb where brand_id is not null union
   select null, person_id from eb where person_id is not null),
 m as (
   select s.brand_id, s.person_id,
     (select count(*) from eb where (s.brand_id is null or eb.brand_id = s.brand_id) and (s.person_id is null or eb.person_id = s.person_id) and eb.d > today - 7)::int ev7,
     (select coalesce(sum(hours), 0) from (select distinct on (eb.happened_at, eb.hours, eb.person_id) eb.* from eb where (s.brand_id is null or eb.brand_id = s.brand_id) and (s.person_id is null or eb.person_id = s.person_id) and eb.d > today - 30) h) h30,
     (select coalesce(sum(value), 0) from (select distinct on (eb.happened_at, eb.hours, eb.person_id) eb.* from eb where (s.brand_id is null or eb.brand_id = s.brand_id) and (s.person_id is null or eb.person_id = s.person_id) and eb.d > today - 30) h) v30,
     (select count(*) from pr_milestone mi where mi.org_id = org and mi.shipped and mi.ended_on > today - 7 and (s.brand_id is null or mi.brand_id = s.brand_id) and s.person_id is null)::int sh7,
     (with days as (select distinct eb.d from eb where (s.brand_id is null or eb.brand_id = s.brand_id) and (s.person_id is null or eb.person_id = s.person_id) and eb.d > today - 120)
      select count(*) from generate_series(0, 119) i where (select bool_and(exists(select 1 from days where days.d = today - j)) from generate_series(0, i) j))::int streak
   from scopes s)
 insert into pr_pow_score (org_id, day, brand_id, person_id, events_7d, velocity, shipped_7d, hours_30d, value_30d, streak, score)
 select org, today, m.brand_id, m.person_id, m.ev7, round(m.ev7 / 7.0, 2), m.sh7, m.h30, m.v30, m.streak,
   least(100, round(35 * least(1, m.ev7 / 35.0) + 30 * least(1, m.sh7 / 3.0) + 20 * least(1, m.streak / 7.0) + 15 * least(1, m.h30 / 160.0)))::int
 from m
 on conflict (org_id, day, brand_id, person_id) do update set events_7d = excluded.events_7d, velocity = excluded.velocity, shipped_7d = excluded.shipped_7d,
   hours_30d = excluded.hours_30d, value_30d = excluded.value_30d, streak = excluded.streak, score = excluded.score;
 get diagnostics n = row_count;
 return n;
end $$;

-- ------------------------------------------------------------------------------------------------ ideas, the calendar and creatives
-- The next free day on a brand's calendar from a day: posts-a-week spread over the week (2: Tue Thu; 3: Mon Wed Fri;
-- 4: Mon Tue Thu Fri; 5: weekdays; 6-7: and the weekend), one pipeline post a day per brand.
create function pulse.pr_next_slot(p_brand uuid, p_from date) returns date
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select d::date from generate_series(p_from, p_from + 60, interval '1 day') d
 where extract(isodow from d)::int = any(case (select posts_per_week from pr_brand where id = p_brand)
     when 1 then array[3] when 2 then array[2, 4] when 3 then array[1, 3, 5] when 4 then array[1, 2, 4, 5] when 5 then array[1, 2, 3, 4, 5]
     when 6 then array[1, 2, 3, 4, 5, 6] else array[1, 2, 3, 4, 5, 6, 7] end)
   and not exists (select 1 from pr_draft x where x.org_id = current_org() and x.brand_id = p_brand and x.pipeline and x.plan_on = d::date and x.status <> 'skipped')
 order by d limit 1
$$;

-- Number words: 1234 -> "1,234".
create function pulse.pr_num(p numeric) returns text language sql immutable as $$
 select trim(to_char(round(coalesce(p, 0)), 'FM999G999G999G990')) $$;

-- Turn ready milestones into ideas (a PR Studio brief of kind 'idea' per brand: hook, angle, proof, format), a draft
-- planned on the brand's calendar and its creatives queued for rendering. At most p_max a run, and never more creatives
-- than the plan allows a month. The words are composed here from the facts; with AI help on, the company's PR agent is
-- given a task to sharpen them (its runtime and budget caps apply). Returns how many ideas were made.
create function pulse.pr_ideate(p_max int) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := current_org(); tz text := org_time_zone(); today date := (now() at time zone tz)::date; m record; b record;
  lim jsonb := pr_limits(); left_creatives int; n int := 0; angle text; fmt text; hook text; body text; tpl jsonb; brief uuid; draft uuid; aud uuid;
  plan date; big text; we text; who text; proof jsonb; client_ok boolean; agent uuid; ai_left int;
begin
 left_creatives := (lim->>'creativesPerMonth')::int - (lim->'used'->>'creatives')::int;
 ai_left := (lim->>'aiPerMonth')::int - (lim->'used'->>'ai')::int;
 for m in select * from pr_milestone where org_id = org and status = 'ready' order by shipped desc, value desc, ended_on desc limit greatest(1, least(coalesce(p_max, 6), 20)) loop
   exit when left_creatives <= 0;
   select * into b from pr_brand where id = m.brand_id and not archived;
   if b.id is null then update pr_milestone set status = 'dismissed' where id = m.id; continue; end if;
   tpl := pr_industry_template(b.industry);
   we := case when b.kind = 'personal' then 'I' else 'We' end;
   who := case when b.kind = 'personal' then 'my' else 'our' end;
   fmt := case m.kind when 'release' then 'release_note' when 'client' then 'customer_story' when 'goal' then 'single' when 'meetings' then 'thread'
            when 'harvest' then 'case_study' when 'career' then 'single' else case when m.events >= 8 then 'carousel' else 'single' end end;
   angle := case m.kind when 'client' then 'social_proof' when 'release' then 'before_after' when 'goal' then 'social_proof'
            when 'harvest' then 'authority' else (tpl->'angles'->>(abs(hashtext(m.key)) % greatest(1, jsonb_array_length(tpl->'angles'))))::text end;
   big := case when m.hours >= 1 then pr_num(m.hours) else pr_num(m.events) end;
   hook := left(case angle
     when 'social_proof' then m.title || ': done, with proof.'
     when 'authority' then pr_num(m.events) || ' pieces of work, ' || pr_num(m.hours) || ' hours of effort: ' || m.title
     when 'curiosity' then 'What it took to ship "' || left(m.title, 120) || '"'
     when 'contrast' then 'The usual way vs ' || who || ' way: ' || m.title
     else 'Before: done by hand. Now: ' || m.title end, 280);
   proof := m.proof;
   client_ok := m.client_named <> '' or b.kind = 'client' and b.client_ok;
   body := hook || E'\n\n' || 'What happened: ' || m.title || E'\n' ||
     'Numbers: ' || pr_num(m.events) || ' events from ' || to_char(m.started_on, 'DD Mon') || ' to ' || to_char(m.ended_on, 'DD Mon') ||
     case when m.hours > 0 then ', about ' || pr_num(m.hours) || ' hours of work' else '' end || E'.\n' ||
     'Proof: ' || coalesce((select string_agg(p->>'label' || ' <' || (p->>'url') || '>', '; ') from jsonb_array_elements(proof) p), '') || E'\n' ||
     'Angle: ' || replace(angle, '_', ' ') || '. Format: ' || replace(fmt, '_', ' ') || '.' ||
     case when client_ok then E'\nNames a client: get their OK before posting.' else '' end;
   insert into pr_brief (org_id, kind, day, title, body, written_by, brand_id, milestone_id, hook, angle, format, proof, needs_client_ok)
   values (org, 'idea', today, left(b.name || ': ' || m.title, 160), left(body, 8000), 'auto', b.id, m.id, hook, angle, fmt, proof, client_ok)
   on conflict do nothing returning id into brief;
   if brief is null then update pr_milestone set status = 'ideated' where id = m.id; continue; end if;
   select id into aud from pr_audience where org_id = org and brand_id = b.id and not archived order by (channel = 'linkedin') desc, created_at limit 1;
   if aud is null then
     insert into pr_audience (org_id, name, tone, channel, ratio, brand_id) values (org, left('Followers · ' || b.name, 80), 'warm', 'linkedin', '4:5', b.id)
     on conflict (org_id, lower(name)) do update set brand_id = coalesce(pr_audience.brand_id, excluded.brand_id) returning id into aud;
   end if;
   plan := pr_next_slot(b.id, today + 1);
   insert into pr_draft (org_id, audience_id, brief_id, headline, copy, long_post, status, plan_on, written_by, brand_id, format, pipeline, needs_client_ok, client_named)
   values (org, aud, brief, left(hook, 160),
     left(hook || E'\n\n' || m.title || case when m.hours > 0 then E'\n*' || pr_num(m.hours) || ' hours of work*' else '' end || E'\n\nProof: ' || coalesce(proof->0->>'url', ''), 4000),
     left(body, 8000), case when plan is null then 'draft' else 'planned' end, plan, 'auto', b.id, fmt, true, client_ok, m.client_named)
   returning id into draft;
   -- Creatives: a carousel (hook, number, proof steps, ask) or one card in the format's template.
   if fmt = 'carousel' then
     insert into pr_creative (org_id, brand_id, brief_id, draft_id, template, slide, slides, size, theme, layout, slots) values
      (org, b.id, brief, draft, 'carousel', 1, 4, 'portrait', 'dark', 'slide-hook', jsonb_build_object('label', upper(replace(angle, '_', ' ')), 'title', hook, 'title_size', case when length(hook) > 90 then 's' else '' end)),
      (org, b.id, brief, draft, 'carousel', 2, 4, 'portrait', 'surface', 'slide-number', jsonb_build_object('label', 'The numbers', 'number', big, 'unit', case when m.hours >= 1 then 'hours of work' else 'pieces of work' end, 'sub', m.title)),
      (org, b.id, brief, draft, 'carousel', 3, 4, 'portrait', 'light', 'slide-steps', jsonb_build_object('label', 'The proof', 'title', 'What shipped',
         'steps', coalesce((select jsonb_agg(jsonb_build_object('head', left(p->>'label', 90), 'tick', true)) from (select p from jsonb_array_elements(proof) p limit 4) q), '[]'))),
      (org, b.id, brief, draft, 'carousel', 4, 4, 'portrait', 'accent', 'slide-cta', jsonb_build_object('label', 'Next', 'title', 'Want the details?', 'body', 'Every claim here links to its proof.'));
     left_creatives := left_creatives - 1;
   else
     insert into pr_creative (org_id, brand_id, brief_id, draft_id, template, size, theme, layout, slots)
     values (org, b.id, brief, draft,
       case fmt when 'release_note' then 'release' when 'customer_story' then 'quote' when 'case_study' then 'before_after' else 'stat' end,
       'portrait', 'dark',
       case fmt when 'release_note' then 'slide-steps' when 'customer_story' then 'post-quote' when 'case_study' then 'post-ba' else 'post-stat' end,
       case fmt
         when 'release_note' then jsonb_build_object('label', 'Release', 'title', m.title,
           'steps', coalesce((select jsonb_agg(jsonb_build_object('head', left(p->>'label', 90), 'tick', true)) from (select p from jsonb_array_elements(proof) p limit 4) q), '[]'))
         when 'customer_story' then jsonb_build_object('quote', m.title, 'who', coalesce(nullif(m.client_named, ''), b.name), 'role', 'Client outcome', 'fact', pr_num(m.events) || ' deliverables')
         when 'case_study' then jsonb_build_object('label', 'Case study', 'title', m.title, 'before_tag', 'Before', 'before', 'Done by hand', 'after_tag', 'After',
           'after', pr_num(m.hours) || ' hours of work delivered', 'after_items', coalesce((select jsonb_agg(left(p->>'label', 80)) from (select p from jsonb_array_elements(proof) p limit 3) q), '[]'))
         else jsonb_build_object('label', upper(replace(angle, '_', ' ')), 'number', big, 'unit', case when m.hours >= 1 then 'hours of work' else 'pieces of work' end, 'sub', m.title) end);
     left_creatives := left_creatives - 1;
   end if;
   update pr_milestone set status = 'ideated' where id = m.id;
   n := n + 1;
   -- AI help: the company's PR agent sharpens the idea (a task to it; its runtime, budget and the plan's AI limit apply).
   if ai_left > 0 and coalesce((select ai_assist from pr_pipeline where org_id = org), false) then
     select am.person_id into agent from agent_member am join person p on p.id = am.person_id and p.status = 'active'
      where am.org_id = org and am.disabled_at is null and lower(am.title) in ('pr manager', 'creative strategist', 'social media manager')
      order by (lower(am.title) = 'creative strategist') desc limit 1;
     if agent is not null then
       begin
         insert into task (org_id, title, assignee_person_id, owner_id, status, source, source_key, notes, priority, created_at, assigned_at)
         values (org, left('Sharpen the PR idea: ' || m.title, 200), agent, (select owner_person_id from agent_member where person_id = agent), 'open', 'pr-pipeline',
           'pr-idea:' || brief, 'PR Studio idea ' || brief || ' for the brand ' || b.name || '. Rewrite the hook and the draft ' || draft ||
           ' with the PR tools (write_pr_brief, create_pr_draft). Keep every claim tied to its proof link; never name a client without their OK; never post.', 'normal', now(), now());
         ai_left := ai_left - 1;
       exception when others then null;  -- AI help is best-effort; the idea stands without it
       end;
     end if;
   end if;
 end loop;
 return n;
end $$;

-- ------------------------------------------------------------------------------------------------ approvals
-- draft -> review (anyone on the brand, AI employees too) -> approved (a person who manages the brand, or an approver)
-- -> posted (a person on the brand, once approved and, when it names a client, once the client said OK). Back to draft
-- from review or approved ("changes asked"). Recorded on the draft; posting marks it posted in PR Studio too.
create function pulse.pr_draft_move(p_draft uuid, p_to text, p_note text default '', p_url text default null) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d pr_draft; role text; side text := (select side from person where id = current_viewer());
begin
 select * into d from pr_draft where id = p_draft and org_id = current_org();
 if d.id is null then raise exception 'Draft not found' using errcode = 'P0002'; end if;
 role := case when d.brand_id is null then case when pr_can() then 'manager' end else pr_brand_role(d.brand_id) end;
 if role is null then raise exception 'Not your brand' using errcode = '42501'; end if;
 if p_to = 'review' then
   if d.approval not in ('draft') or role = 'approver' then raise exception 'Only a draft goes to review' using errcode = '22023'; end if;
   update pr_draft set approval = 'review', reviewed_by = current_viewer() where id = d.id;
 elsif p_to = 'approved' then
   if d.approval <> 'review' then raise exception 'Send it to review first' using errcode = '22023'; end if;
   if side = 'agent' or role = 'editor' then raise exception 'A person who manages or approves the brand approves it' using errcode = '42501'; end if;
   update pr_draft set approval = 'approved', approved_by = current_viewer(), approved_at = now(),
     client_ok_by = case when side = 'client' then current_viewer() else client_ok_by end,
     client_ok_at = case when side = 'client' then now() else client_ok_at end,
     client_ok_note = case when side = 'client' then left(coalesce(p_note, ''), 500) else client_ok_note end
   where id = d.id;
 elsif p_to = 'client_ok' then
   if not d.needs_client_ok then raise exception 'This draft names no client' using errcode = '22023'; end if;
   if side = 'agent' or role = 'editor' then raise exception 'The client, or a person who manages the brand on their word, gives the OK' using errcode = '42501'; end if;
   if side <> 'client' and coalesce(btrim(p_note), '') = '' then raise exception 'Say how the client gave their OK (for example "by e-mail on 6 Nov")' using errcode = '22023'; end if;
   update pr_draft set client_ok_by = current_viewer(), client_ok_at = now(), client_ok_note = left(p_note, 500) where id = d.id;
 elsif p_to = 'posted' then
   if d.approval <> 'approved' then raise exception 'Approve it before posting' using errcode = '22023'; end if;
   if d.needs_client_ok and d.client_ok_at is null then raise exception 'It names a client: get their OK first' using errcode = '22023'; end if;
   if side not in ('staff') then raise exception 'A person posts it' using errcode = '42501'; end if;
   update pr_draft set approval = 'posted', status = 'posted', posted_at = coalesce(posted_at, now()), posted_url = coalesce(p_url, posted_url) where id = d.id;
   update pr_story set told_at = coalesce(told_at, now()) where org_id = current_org() and id = any(d.entry_ids);
 elsif p_to = 'draft' then
   if d.approval = 'posted' then raise exception 'It is posted already' using errcode = '22023'; end if;
   update pr_draft set approval = 'draft', approved_by = null, approved_at = null where id = d.id;
 else raise exception 'Move it to draft, review, approved, client_ok or posted' using errcode = '22023';
 end if;
 return (select approval from pr_draft where id = d.id);
end $$;

-- The backstop: a pipeline draft (or any draft that names a client) is never marked posted without its approval and
-- the client's OK, whichever way it is written (PR Studio's "I posted it", API v1, MCP).
create function pulse.pr_draft_gate() returns trigger language plpgsql set search_path=pulse,pg_temp as $$
begin
 if new.status = 'posted' and old.status is distinct from 'posted' then
   if new.needs_client_ok and new.client_ok_at is null then raise exception 'It names a client: get their OK first' using errcode = '22023'; end if;
   if new.pipeline and new.approval not in ('approved', 'posted') then raise exception 'Approve it before posting' using errcode = '22023'; end if;
   new.approval := 'posted';
 end if;
 return new;
end $$;
create trigger pr_draft_gate before update on pulse.pr_draft for each row execute function pulse.pr_draft_gate();

-- ------------------------------------------------------------------------------------------------ digest and the weekly report
-- A daily digest brief (once a day, from 09:00 company time): what was done since yesterday, per brand.
create function pulse.pr_digest() returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := current_org(); tz text := org_time_zone(); today date := (now() at time zone tz)::date; body text; n int;
begin
 if extract(hour from now() at time zone tz) < 9 or exists (select 1 from pr_brief where org_id = org and kind = 'digest' and day = today and written_by = 'auto') then return 0; end if;
 select count(*) into n from pr_work_event where org_id = org and happened_at > now() - interval '1 day';
 if n = 0 then return 0; end if;
 select '*Since yesterday:* ' || pr_num(n) || case when n = 1 then ' piece of work' else ' pieces of work' end || E'\n' ||
   coalesce((select string_agg('- ' || s.source || ': ' || s.c, E'\n' order by s.c desc) from (select source, count(*) c from pr_work_event where org_id = org and happened_at > now() - interval '1 day' group by 1) s), '') ||
   coalesce(E'\n\n*Ready to tell:*\n' || (select string_agg('- ' || title, E'\n') from (select title from pr_milestone where org_id = org and status in ('ready', 'ideated') and updated_at > now() - interval '1 day' order by value desc limit 6) q), '')
 into body;
 insert into pr_brief (org_id, kind, day, title, body, written_by) values (org, 'digest', today, 'Work digest ' || to_char(today, 'DD Mon'), left(body, 8000), 'auto')
 on conflict do nothing;
 return 1;
end $$;

-- The weekly "what I did" report for the pipeline's report person: on Monday from 09:00 company time, for the week
-- before (Monday to Sunday). Shipped milestones, impact numbers, proof links, what is next, and a one-page summary card
-- queued for rendering. A draft: the person reads it, edits it and shares it by hand (pr_report_share).
create function pulse.pr_weekly_report(p_force boolean default false) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := current_org(); tz text := org_time_zone(); now_l timestamp := now() at time zone tz; wk date; pp pr_pipeline; rid uuid;
  ev int; hrs numeric; val numeric; nship int; body text; next text; proof jsonb; brand uuid; nm text;
begin
 select * into pp from pr_pipeline where org_id = org and enabled;
 if pp.org_id is null or pp.report_person_id is null then return null; end if;
 wk := (date_trunc('week', now_l) - interval '7 days')::date;
 if not p_force and (extract(isodow from now_l) <> 1 or extract(hour from now_l) < 9 or pp.last_report_week = wk) then return null; end if;
 if not p_force and extract(isodow from now_l) <> 1 then return null; end if;
 select id into brand from pr_brand where org_id = org and kind = 'personal' and owner_person_id = pp.report_person_id and not archived limit 1;
 brand := coalesce(brand, (select id from pr_brand where org_id = org and kind = 'company' and not archived order by created_at limit 1));
 select count(*), coalesce(sum(hours), 0), coalesce(sum(value), 0) into ev, hrs, val from pr_work_event
   where org_id = org and happened_at >= wk::timestamp at time zone tz and happened_at < (wk + 7)::timestamp at time zone tz
     and (person_id = pp.report_person_id or person_id is null);
 select count(*) into nship from pr_milestone where org_id = org and shipped and ended_on between wk and wk + 6 and (brand is null or brand_id = brand);
 select coalesce(jsonb_agg(p), '[]') into proof from (select jsonb_build_object('label', left(m.title, 120), 'url', m.proof->0->>'url', 'hours', m.hours) p
   from pr_milestone m where m.org_id = org and m.shipped and m.ended_on between wk and wk + 6 and (brand is null or m.brand_id = brand) and jsonb_array_length(m.proof) > 0
   order by m.value desc limit 12) q;
 select display_name into nm from person where id = pp.report_person_id;
 body := '## Shipped' || E'\n' || coalesce((select string_agg('- ' || (p->>'label') || ' (' || pr_num((p->>'hours')::numeric) || ' h) <' || (p->>'url') || '>', E'\n') from jsonb_array_elements(proof) p), '- Nothing shipped this week') ||
   E'\n\n## Impact\n- ' || pr_num(ev) || ' pieces of work, ' || pr_num(nship) || ' milestones shipped' ||
   E'\n- About ' || pr_num(hrs) || ' hours of work, worth about ' || pp.currency || ' ' || pr_num(val) || ' at ' || pp.currency || ' ' || pr_num(pp.hourly_value) || ' an hour (estimate)';
 next := coalesce((select string_agg('- ' || title, E'\n') from (select title from pr_milestone where org_id = org and status = 'open' and (brand is null or brand_id = brand) order by updated_at desc limit 5) q), '');
 insert into pr_work_report (org_id, person_id, brand_id, week_start, title, body, numbers, proof, next)
 values (org, pp.report_person_id, brand, wk, left('What ' || coalesce(nm, 'I') || ' did, week of ' || to_char(wk, 'DD Mon'), 160), left(body, 12000),
   jsonb_build_object('events', ev, 'hours', hrs, 'value', val, 'currency', pp.currency, 'shipped', nship,
     'score', (select score from pr_pow_score where org_id = org and person_id = pp.report_person_id and brand_id is null order by day desc limit 1)),
   proof, left(next, 4000))
 on conflict (org_id, person_id, week_start) do update set numbers = excluded.numbers, proof = excluded.proof,
   body = case when pr_work_report.status = 'draft' then excluded.body else pr_work_report.body end, next = case when pr_work_report.status = 'draft' then excluded.next else pr_work_report.next end
 returning id into rid;
 if brand is not null and not exists (select 1 from pr_creative where report_id = rid) then
   insert into pr_creative (org_id, brand_id, report_id, template, size, theme, layout, slots)
   values (org, brand, rid, 'weekly', 'card', 'dark', 'weekly-card', jsonb_build_object('week', 'Week of ' || to_char(wk, 'DD Mon YYYY'), 'title', 'What shipped',
     'tiles', jsonb_build_array(jsonb_build_object('num', pr_num(nship), 'text', 'milestones shipped'), jsonb_build_object('num', pr_num(ev), 'text', 'pieces of work'),
        jsonb_build_object('num', pr_num(hrs), 'text', 'hours of work')),
     'groups', jsonb_build_array(jsonb_build_object('name', 'Shipped', 'color', 'var(--ok)', 'items', coalesce((select jsonb_agg(left(p->>'label', 80)) from (select p from jsonb_array_elements(proof) p limit 5) q), '[]'))),
     'asks_label', 'Next', 'asks', jsonb_build_array(jsonb_build_object('who', 'Next week', 'items', coalesce((select jsonb_agg(left(t, 80)) from unnest(string_to_array(nullif(replace(next, '- ', ''), ''), E'\n')) t limit 4), '[]'::jsonb)))));
 end if;
 update pr_pipeline set last_report_week = wk where org_id = org;
 return rid;
end $$;

-- Where a person may share their weekly report: the other companies their account has a seat in where they use PR
-- Studio (admin or leadership), with the colleagues there who would read it (active staff in leadership or admin).
create function pulse.pr_report_share_targets() returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare o text := current_setting('pulse.org_id', true); vw text := current_setting('pulse.viewer_id', true); acct uuid := account_of_viewer(); r record; out jsonb := '[]'; ok boolean; people jsonb;
begin
 if acct is null then return out; end if;
 for r in select am.member_org org, am.person_id person, g.name from pulse_priv.account_member am join org g on g.id = am.member_org and g.status = 'active'
     where am.account_id = acct and am.member_org <> current_org() order by g.name limit 20 loop
   perform set_config('pulse.org_id', r.org::text, true); perform set_config('pulse.viewer_id', r.person::text, true);
   ok := pr_can() and coalesce((select side from person where id = r.person), '') = 'staff';
   if ok then
     select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by p.display_name), '[]') into people
       from person p where p.org_id = r.org and p.status = 'active' and p.side = 'staff' and p.id <> r.person
         and exists (select 1 from role_assignment ra where ra.person_id = p.id and ra.role_key in ('admin', 'leadership') and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity'));
     out := out || jsonb_build_object('orgId', r.org, 'org', r.name, 'people', people);
   end if;
 end loop;
 perform set_config('pulse.org_id', o, true); perform set_config('pulse.viewer_id', vw, true);
 return out;
end $$;

-- Share a weekly report, by the person's own click, with chosen colleagues in another company of theirs: each gets it as
-- a PR Studio brief written for them (kind 'report'), authored by the person's seat there. Nothing is sent anywhere else.
create function pulse.pr_report_share(p_report uuid, p_org uuid, p_people uuid[]) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare o text := current_setting('pulse.org_id', true); vw text := current_setting('pulse.viewer_id', true); acct uuid := account_of_viewer();
  rep pr_work_report; there uuid; n int; ids uuid[]; orgname text;
begin
 select * into rep from pr_work_report where id = p_report and org_id = current_org() and person_id = current_viewer();
 if rep.id is null then raise exception 'Only the person whose report it is shares it' using errcode = '42501'; end if;
 if cardinality(coalesce(p_people, '{}')) = 0 or cardinality(p_people) > 20 then raise exception 'Choose up to 20 people' using errcode = '22023'; end if;
 select person_id into there from pulse_priv.account_member where account_id = acct and member_org = p_org;
 if there is null or p_org = current_org() then raise exception 'You have no seat in that company' using errcode = '42501'; end if;
 perform set_config('pulse.org_id', p_org::text, true); perform set_config('pulse.viewer_id', there::text, true);
 if not pr_can() or coalesce((select side from person where id = there), '') <> 'staff' then raise exception 'You share there as an admin or leader' using errcode = '42501'; end if;
 select array_agg(p.id) into ids from person p where p.org_id = p_org and p.status = 'active' and p.side = 'staff' and p.id = any(p_people);
 if cardinality(coalesce(ids, '{}')) <> cardinality(p_people) then raise exception 'Choose colleagues of that company' using errcode = '22023'; end if;
 insert into pr_brief (org_id, kind, person_id, day, title, body, written_by, author_id, proof)
 select p_org, 'report', x, (now() at time zone org_time_zone())::date, rep.title,
   left(rep.body || case when rep.next <> '' then E'\n\n## Next\n' || rep.next else '' end, 8000), 'person', there, rep.proof
 from unnest(ids) x;
 get diagnostics n = row_count;
 select name into orgname from org where id = p_org;
 perform set_config('pulse.org_id', o, true); perform set_config('pulse.viewer_id', vw, true);
 update pr_work_report set status = 'shared', shared = shared || jsonb_build_object('orgId', p_org, 'org', orgname, 'people', to_jsonb(ids), 'at', now())
  where id = rep.id;
 return jsonb_build_object('shared', n, 'org', orgname);
end $$;

-- ------------------------------------------------------------------------------------------------ the tick
-- One run of the pipeline for the company (the worker every hour; the host collector after it adds events; "Run now" in
-- PR Studio): the company's records every 6 hours (or when forced), milestones, today's proof-of-work scores, up to 6
-- new ideas, the daily digest and, on Monday mornings, the weekly report. Does nothing while the pipeline is off.
create function pulse.pr_pipeline_tick(p_force boolean default false) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := current_org(); pp pr_pipeline; r jsonb := '{}'; collected int := 0;
begin
 if coalesce(current_setting('pulse.viewer_id', true), '') <> '' and not pr_can() then raise exception 'Not allowed' using errcode = '42501'; end if;
 select * into pp from pr_pipeline where org_id = org and enabled;
 if pp.org_id is null then return jsonb_build_object('enabled', false); end if;
 perform pg_advisory_xact_lock(hashtext(org::text || ':pr-pipeline'));
 if p_force or pp.last_collect_at is null or pp.last_collect_at < now() - interval '6 hours' then
   collected := pr_work_collect(coalesce(pp.last_collect_at - interval '1 day', now() - interval '30 days'));
 end if;
 r := jsonb_build_object('enabled', true, 'collected', collected, 'milestones', pr_milestones_build(), 'scores', pr_pow_snapshot(),
   'ideas', pr_ideate(6), 'digest', pr_digest(), 'report', pr_weekly_report(false));
 update pr_pipeline set last_tick_at = now() where org_id = org;
 return r;
end $$;

-- The renderer's queue (worker role): queued creatives with their brand's kit and the company's mark.
create function pulse.pr_creative_queue(p_limit int) returns table (id uuid, brand_id uuid, brand jsonb, template text, slide int, slides int, size text, theme text, layout text, slots jsonb, mark text, mark_mime text)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select c.id, c.brand_id, jsonb_build_object('name', b.name, 'byline', b.byline, 'kind', b.kind, 'industry', b.industry, 'kit', b.kit),
   c.template, c.slide, c.slides, c.size, c.theme, c.layout, c.slots,
   case when b.kind = 'company' and coalesce((b.kit->>'useCompanyMark')::boolean, true) then encode(coalesce(ob.mark, ob.logo_dark), 'base64') end,
   case when b.kind = 'company' then coalesce(ob.mark_mime, ob.logo_dark_mime) end
 from pr_creative c join pr_brand b on b.id = c.brand_id left join org_brand ob on ob.org_id = c.org_id
 where c.org_id = current_org() and c.status = 'queued' order by c.created_at limit greatest(1, least(coalesce(p_limit, 20), 100))
$$;

create function pulse.pr_creative_rendered(p_id uuid, p_png bytea, p_checks jsonb, p_ok boolean, p_error text) returns void
 language sql security definer set search_path=pulse,pg_temp as $$
 update pr_creative set png = p_png, checks = coalesce(p_checks, '{}'), checks_ok = p_ok, error = left(coalesce(p_error, ''), 500),
   status = case when p_png is null then 'failed' else 'rendered' end, rendered_at = now()
 where id = p_id and org_id = current_org()
$$;

revoke all on function pulse.pr_brand_role(uuid), pulse.pr_brand_see(uuid), pulse.pr_brand_edit(uuid), pulse.pr_limits(), pulse.pr_brand_setup(jsonb),
  pulse.pr_pipeline_set(jsonb), pulse.pr_work_ingest(jsonb), pulse.pr_work_collect(timestamptz), pulse.pr_career_import(uuid), pulse.pr_event_brands(),
  pulse.pr_milestones_build(), pulse.pr_pow_snapshot(), pulse.pr_next_slot(uuid, date), pulse.pr_ideate(int), pulse.pr_draft_move(uuid, text, text, text),
  pulse.pr_digest(), pulse.pr_weekly_report(boolean), pulse.pr_report_share_targets(), pulse.pr_report_share(uuid, uuid, uuid[]),
  pulse.pr_pipeline_tick(boolean), pulse.pr_creative_queue(int), pulse.pr_creative_rendered(uuid, bytea, jsonb, boolean, text) from public;
grant execute on function pulse.pr_brand_role(uuid), pulse.pr_brand_see(uuid), pulse.pr_brand_edit(uuid), pulse.pr_limits(), pulse.pr_brand_setup(jsonb),
  pulse.pr_pipeline_set(jsonb), pulse.pr_career_import(uuid), pulse.pr_draft_move(uuid, text, text, text), pulse.pr_report_share_targets(),
  pulse.pr_report_share(uuid, uuid, uuid[]), pulse.pr_pipeline_tick(boolean), pulse.pr_industry_template(text), pulse.pr_next_slot(uuid, date) to pulse_api;
grant execute on function pulse.pr_work_ingest(jsonb), pulse.pr_pipeline_tick(boolean), pulse.pr_weekly_report(boolean), pulse.pr_creative_queue(int),
  pulse.pr_creative_rendered(uuid, bytea, jsonb, boolean, text), pulse.pr_brand_see(uuid), pulse.pr_brand_role(uuid) to pulse_worker;

-- migrate:down
-- Forward-only.
