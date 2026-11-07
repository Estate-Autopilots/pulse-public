-- migrate:up
-- PR-STUDIO (owner, 6 Nov 2026: "people sometimes feel the work is stopped because it isn't presented visually … keep a
-- running story of all work and turn it into professional creatives and briefs, so the days do not go blank"). Per company:
--   pr_story     the Story: one line per thing that happened (a release, a feature landed, a bug fixed, tasks done, a goal
--                moved, a meeting, a note). Collected from the company's own records by pulse.pr_collect() and added by
--                people and AI employees (API v1 area pr). Editable; hidden, never deleted. told_at: when it was told.
--   pr_chapter   the Story's chapters (a week or a month), with an editable title and summary.
--   pr_brief     morning, evening, update and weekly briefs, for the company (person_id null) or one person.
--   pr_audience  named groups the company tells (a team, testers, clients, the public) with tone, channel and image ratio.
--   pr_draft     a creative pack for one audience: headline, a WhatsApp-formatted copy, a long post and up to three images
--                (drawn from brand templates); planned on a day (a task "Post … to …" for the person), then posted or skipped.
-- Nothing is ever sent from here: people copy and send. Who uses PR Studio is decided here (pulse.pr_can): a company's
-- admins and leadership, and its AI employees (whose keys also need the pr area). A person also reads briefs written for
-- them. Forced row security with the tenant policy on every table. Additive.

create function pulse.pr_can() returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and not viewer_outside_seat()
   and exists(select 1 from person p where p.org_id = current_org() and p.id = current_viewer() and p.status = 'active'
     and (p.side = 'agent' or (p.side = 'staff' and viewer_is('admin', 'leadership'))))
$$;

create table pulse.pr_story (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  happened_on date not null,
  kind text not null check (kind in ('release', 'feature', 'bug', 'task', 'goal', 'meeting', 'note')),
  title text not null check (length(btrim(title)) between 1 and 200 and title !~ '[[:cntrl:]]'),
  body text not null default '' check (length(body) <= 4000),
  source_key text check (length(source_key) between 1 and 200),
  source jsonb not null default '{}' check (jsonb_typeof(source) = 'object' and length(source::text) <= 4000),
  edited boolean not null default false,
  hidden boolean not null default false,
  told_at timestamptz,
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pr_story_source on pulse.pr_story (org_id, source_key) where source_key is not null;
create index pr_story_day on pulse.pr_story (org_id, happened_on desc);
create index pr_story_untold on pulse.pr_story (org_id, happened_on desc) where told_at is null and not hidden;

create table pulse.pr_chapter (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  period text not null check (period in ('week', 'month')),
  starts_on date not null,
  title text not null default '' check (length(title) <= 120 and title !~ '[[:cntrl:]]'),
  summary text not null default '' check (length(summary) <= 4000),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now(),
  unique (org_id, period, starts_on)
);

create table pulse.pr_brief (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('morning', 'evening', 'update', 'weekly')),
  person_id uuid references pulse.person(id),
  day date not null,
  title text not null check (length(btrim(title)) between 1 and 160 and title !~ '[[:cntrl:]]'),
  body text not null check (length(body) between 1 and 8000),
  entry_ids uuid[] not null default '{}' check (cardinality(entry_ids) <= 200),
  written_by text not null default 'auto' check (written_by in ('auto', 'ai', 'person')),
  author_id uuid references pulse.person(id),
  created_at timestamptz not null default now()
);
create index pr_brief_day on pulse.pr_brief (org_id, day desc, created_at desc);
-- One automatic morning and evening brief per company per day (lazily written when PR Studio is opened).
create unique index pr_brief_auto on pulse.pr_brief (org_id, kind, day) where written_by = 'auto' and person_id is null and kind in ('morning', 'evening', 'weekly');

create table pulse.pr_audience (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80 and name !~ '[[:cntrl:]]'),
  tone text not null default 'warm' check (tone in ('warm', 'formal', 'bold', 'plain')),
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'telegram', 'email', 'linkedin', 'x')),
  ratio text not null default '1:1' check (ratio in ('1:1', '4:5', '9:16', '16:9')),
  note text not null default '' check (length(note) <= 500),
  archived boolean not null default false,
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index pr_audience_name on pulse.pr_audience (org_id, lower(name));

create table pulse.pr_draft (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  audience_id uuid not null references pulse.pr_audience(id),
  brief_id uuid references pulse.pr_brief(id),
  entry_ids uuid[] not null default '{}' check (cardinality(entry_ids) <= 200),
  headline text not null check (length(btrim(headline)) between 1 and 160 and headline !~ '[[:cntrl:]]'),
  copy text not null default '' check (length(copy) <= 4000),
  long_post text not null default '' check (length(long_post) <= 8000),
  images jsonb not null default '[]' check (jsonb_typeof(images) = 'array' and jsonb_array_length(images) <= 3 and length(images::text) <= 6000),
  status text not null default 'draft' check (status in ('draft', 'planned', 'posted', 'skipped')),
  plan_on date,
  task_id uuid references pulse.task(id),
  posted_at timestamptz,
  written_by text not null default 'auto' check (written_by in ('auto', 'ai', 'person')),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pr_draft_planned check (status <> 'planned' or plan_on is not null)
);
create index pr_draft_plan on pulse.pr_draft (org_id, plan_on) where plan_on is not null;
create index pr_draft_status on pulse.pr_draft (org_id, status, updated_at desc);

create function pulse.pr_touch() returns trigger language plpgsql set search_path=pulse,pg_temp as $$
begin new.updated_at := now(); return new; end $$;
create trigger pr_story_touch before update on pulse.pr_story for each row execute function pulse.pr_touch();
create trigger pr_audience_touch before update on pulse.pr_audience for each row execute function pulse.pr_touch();
create trigger pr_draft_touch before update on pulse.pr_draft for each row execute function pulse.pr_touch();

-- ------------------------------------------------------------------------------------------------ row security
alter table pulse.pr_story enable row level security;
alter table pulse.pr_story force row level security;
create policy tenant_isolation on pulse.pr_story using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_story_use on pulse.pr_story as restrictive to pulse_api using (pulse.pr_can()) with check (pulse.pr_can());

alter table pulse.pr_chapter enable row level security;
alter table pulse.pr_chapter force row level security;
create policy tenant_isolation on pulse.pr_chapter using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_chapter_use on pulse.pr_chapter as restrictive to pulse_api using (pulse.pr_can()) with check (pulse.pr_can());

alter table pulse.pr_brief enable row level security;
alter table pulse.pr_brief force row level security;
create policy tenant_isolation on pulse.pr_brief using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- A person reads the briefs written for them; PR Studio's users read and write all of the company's.
create policy pr_brief_see on pulse.pr_brief as restrictive for select to pulse_api
  using (pulse.pr_can() or (person_id is not null and person_id = pulse.current_viewer()));
create policy pr_brief_write on pulse.pr_brief as restrictive for insert to pulse_api with check (pulse.pr_can());

alter table pulse.pr_audience enable row level security;
alter table pulse.pr_audience force row level security;
create policy tenant_isolation on pulse.pr_audience using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_audience_use on pulse.pr_audience as restrictive to pulse_api using (pulse.pr_can()) with check (pulse.pr_can());

alter table pulse.pr_draft enable row level security;
alter table pulse.pr_draft force row level security;
create policy tenant_isolation on pulse.pr_draft using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy pr_draft_use on pulse.pr_draft as restrictive to pulse_api using (pulse.pr_can()) with check (pulse.pr_can());

grant select, insert, update (happened_on, kind, title, body, edited, hidden, told_at, updated_at) on pulse.pr_story to pulse_api;
grant select, insert, update (title, summary, updated_by, updated_at) on pulse.pr_chapter to pulse_api;
grant select, insert on pulse.pr_brief to pulse_api;
grant select, insert, update (name, tone, channel, ratio, note, archived, updated_at) on pulse.pr_audience to pulse_api;
grant select, insert, update (headline, copy, long_post, images, status, plan_on, task_id, posted_at, written_by, updated_at) on pulse.pr_draft to pulse_api;

-- ------------------------------------------------------------------------------------------------ the collector
-- Adds to the Story what the company's own records say happened between two days (the company's days), at most 92 days:
-- tasks done (one line per project and day, never a private-looking title), bugs fixed, goals reached or moved, and
-- product versions released. Idempotent by source_key: a line someone edited (edited) or hid is never overwritten.
-- Returns how many lines were added or refreshed. Meetings, notes and landed features come from people and AI employees.
create function pulse.pr_collect(p_from date, p_to date) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := current_org(); tz text := org_time_zone(); n int := 0; k int;
 private text := '(salar|payroll|pay ?slip|payout|appraisal|increment|bonus|incentive|reimburs|resign|terminat|warning|disciplin|medical|health|loan|advance|bank|ifsc|aadha|passport|password|otp|penalt|confidential|private|personal|interview|candidate|offer letter)';
begin
 if not pr_can() then raise exception 'PR Studio is for the company''s admins, leadership and AI employees' using errcode = '42501'; end if;
 if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 92 then raise exception 'Collect up to 92 days at a time' using errcode = '22023'; end if;
 -- Tasks done, one line per project and day.
 insert into pr_story (org_id, happened_on, kind, title, body, source_key, source)
 select org, x.d, 'task',
   case when x.n = 1 then '1 task done' else x.n || ' tasks done' end || coalesce(' in ' || x.project, ''),
   (select string_agg('- ' || t, E'\n') from unnest(x.titles[1:8]) t) || case when x.n > 8 then E'\n- and ' || (x.n - 8) || ' more' else '' end,
   'tasks:' || coalesce(x.project_id::text, 'none') || ':' || x.d, jsonb_build_object('projectId', x.project_id, 'count', x.n)
 from (select t.project_id, coalesce(p.title, p.name) project, (t.done_at at time zone tz)::date d, count(*)::int n,
         array_agg(left(t.title, 120) order by t.done_at) titles
       from task t left join project p on p.id = t.project_id
       where t.org_id = org and t.status in ('done', 'accepted') and t.done_at is not null
         and (t.done_at at time zone tz)::date between p_from and p_to and t.title !~* private
       group by 1, 2, 3) x
 on conflict (org_id, source_key) where source_key is not null do update
   set title = excluded.title, body = excluded.body, source = excluded.source
   where not pr_story.edited and not pr_story.hidden and (pr_story.title, pr_story.body) is distinct from (excluded.title, excluded.body);
 get diagnostics k = row_count; n := n + k;
 -- Bugs fixed (not duplicates).
 insert into pr_story (org_id, happened_on, kind, title, body, source_key, source)
 select org, (b.status_at at time zone tz)::date, 'bug', 'Bug #' || b.number || ' fixed', left(regexp_replace(b.words, '\s+', ' ', 'g'), 280),
   'bug:' || b.id, jsonb_build_object('bugId', b.id, 'number', b.number)
 from reported_bug b
 where b.org_id = org and b.status = 'fixed' and b.duplicate_of is null and (b.status_at at time zone tz)::date between p_from and p_to
 on conflict (org_id, source_key) where source_key is not null do nothing;
 get diagnostics k = row_count; n := n + k;
 -- Goals reached, and measurable goals moved (one line per goal and day it changed).
 insert into pr_story (org_id, happened_on, kind, title, body, source_key, source)
 select org, (coalesce(g.done_at, g.updated_at) at time zone tz)::date, 'goal',
   case when g.status = 'done' then 'Goal reached: ' else 'Goal moved: ' end || left(g.title, 160),
   case when g.target_value is null then coalesce(g.why, '')
     else 'Now ' || trim(to_char(coalesce(g.current_value, g.start_value, 0), 'FM999G999G999G990D99'), '.') || ' of '
       || trim(to_char(g.target_value, 'FM999G999G999G990D99'), '.') || ' ' || g.measure_label end,
   'goal:' || g.id || ':' || g.status || ':' || (coalesce(g.done_at, g.updated_at) at time zone tz)::date,
   jsonb_build_object('goalId', g.id, 'status', g.status)
 from goal g
 where g.org_id = org and g.level in ('company', 'team') and (g.status = 'done' or (g.status = 'active' and g.target_value is not null and g.updated_at > g.created_at + interval '1 minute'))
   and (coalesce(g.done_at, g.updated_at) at time zone tz)::date between p_from and p_to
 on conflict (org_id, source_key) where source_key is not null do nothing;
 get diagnostics k = row_count; n := n + k;
 -- Product versions released (Product Story, 0985).
 insert into pr_story (org_id, happened_on, kind, title, body, source_key, source)
 select org, v.released_on, 'release', left(sp.name || ' ' || v.label || case when v.title <> '' then ': ' || v.title else '' end, 200),
   left(v.summary || coalesce(E'\n' || (select string_agg('- ' || (c->>'text'), E'\n') from jsonb_array_elements(v.changes) c where c ? 'text'), ''), 4000),
   'release:' || v.id, jsonb_build_object('versionId', v.id)
 from story_version v join story_product sp on sp.id = v.product_id
 where v.org_id = org and v.released_on between p_from and p_to
 on conflict (org_id, source_key) where source_key is not null do nothing;
 get diagnostics k = row_count; n := n + k;
 return n;
end $$;
revoke all on function pulse.pr_collect(date, date) from public;
grant execute on function pulse.pr_can(), pulse.pr_collect(date, date) to pulse_api;

-- ------------------------------------------------------------------------------------------------ API v1 area pr
-- pr.read / pr.write (v1-pr.ts). Business and enterprise hold every area (api_tier_scopes' else); no existing key gains it.
create or replace function pulse.v1_scopes() returns text[] language sql immutable as $$
  select array['tasks.read','tasks.write','projects.read','projects.write','people.read','people.write','chats.read','chats.write',
   'docs.read','docs.write','billing.read','billing.write','workflows.read','workflows.write','companies.read','companies.write',
   'search.read','search.write','events.read','events.write','finance.read','finance.write','hr.read','hr.write',
   'contracts.read','contracts.write','connectors.read','connectors.write','pr.read','pr.write']
$$;

-- migrate:down
-- Forward-only.
