-- migrate:up
-- PULSE-HQ (owner, 23 Oct 2026): fast, Notion-like editing in Pulse HQ and a new module, Stack Intelligence.
--   hq_idea      gains its own order (sort, drag to reorder), a product area, an owner and a long description (details)
--   hq_feature   gains an owner (bulk edit of status, area and owner)
--   sheet_view   each person's named views of a sheet (filters, sorts, group-by, view kind), per sheet (scope)
--   stack_tool   Stack Intelligence: the tools, services, infrastructure and AI models an organisation weighs, with
--                cost (USD and INR), free tier and limits, pros and cons, a tech-radar verdict (adopt / trial / assess /
--                hold), a status (idea → evaluating → trial → adopted → dropped), sources and benchmarks
--   stack_set    named stacks: a set of tools, each with the plan and monthly cost it has in that stack
-- Every organisation can keep its own (row-level security forced like every company table). A stack can be shared:
-- pulse_priv.stack_share keeps a read-only snapshot under a private link and, when published, in the Pulse stack
-- directory every signed-in organisation can browse and copy from ("Use this stack"). It is owner-only (no runtime
-- grants) and reached only through the SECURITY DEFINER functions below, which check the caller's organisation.
-- Only functions defined in this repository's migrations are called (pulse.current_org, 0001).
-- Safe on a live install: additive.

alter table pulse.hq_idea add column sort integer not null default 0;
alter table pulse.hq_idea add column area text check (area is null or area in ('home','work','flows','chats','people','finance','clients','creative','xray','network','apps','admin','platform'));
alter table pulse.hq_idea add column owner_id uuid references pulse.person(id) on delete set null;
alter table pulse.hq_idea add column details text not null default '' check (length(details) <= 8000);
alter table pulse.hq_feature add column owner_id uuid references pulse.person(id) on delete set null;
-- Existing ideas get their order (newest first) in 0974, inside the Pulse organisation (row-level security is forced).

create table pulse.sheet_view (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id) on delete cascade,
  scope text not null check (scope ~ '^[a-z][a-z0-9_-]{1,40}$'),
  name text not null check (length(btrim(name)) between 1 and 60),
  body jsonb not null default '{}' check (jsonb_typeof(body) = 'object' and length(body::text) <= 20000),
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sheet_view_mine on pulse.sheet_view (org_id, person_id, scope, sort);

create table pulse.stack_tool (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  name text not null check (length(btrim(name)) between 2 and 80),
  category text not null default 'other' check (category in ('compute','hosting','ci','monitoring','llm-observability','device-testing','video-voice','ai-models','storage','credits','dev-tools','other')),
  use_case text not null default '' check (length(use_case) <= 600),
  plan text not null default '' check (length(plan) <= 300),
  cost_usd numeric(12,2) check (cost_usd is null or cost_usd >= 0),
  cost_inr numeric(14,2) check (cost_inr is null or cost_inr >= 0),
  free_tier text not null default '' check (length(free_tier) <= 1000),
  limits text not null default '' check (length(limits) <= 2000),
  pros text not null default '' check (length(pros) <= 2000),
  cons text not null default '' check (length(cons) <= 2000),
  best_for text not null default '' check (length(best_for) <= 300),
  verdict text not null default 'assess' check (verdict in ('adopt','trial','assess','hold')),
  verdict_note text not null default '' check (length(verdict_note) <= 400),
  status text not null default 'idea' check (status in ('idea','evaluating','trial','adopted','dropped')),
  owner_id uuid references pulse.person(id) on delete set null,
  sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'),
  benchmark text not null default '' check (length(benchmark) <= 4000),
  metrics jsonb not null default '[]' check (jsonb_typeof(metrics) = 'array'),
  url text check (url is null or url ~ '^https://[^\s]{3,290}$'),
  sort integer not null default 0,
  created_by uuid references pulse.person(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index stack_tool_name on pulse.stack_tool (org_id, lower(name));
create index stack_tool_sort on pulse.stack_tool (org_id, sort);

create table pulse.stack_set (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  name text not null check (length(btrim(name)) between 2 and 80),
  blurb text not null default '' check (length(blurb) <= 600),
  -- [{ toolId, plan, usd, inr, note, existing }]: the plan and monthly cost each tool has in this stack.
  items jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
  sort integer not null default 0,
  share_token text,
  shared_public boolean not null default false,
  copied_from text check (copied_from is null or length(copied_from) <= 200),
  created_by uuid references pulse.person(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stack_set_sort on pulse.stack_set (org_id, sort, created_at);

do $$
declare t text;
begin
  foreach t in array array['sheet_view','stack_tool','stack_set'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select, insert, update, delete on pulse.%I to pulse_api', t);
  end loop;
end $$;

-- Shared stacks: a snapshot (the stack and its tools as they were when shared), under a private link; `public` also
-- lists it in the Pulse stack directory. Owner-only like the account tables.
create table pulse_priv.stack_share (
  token text primary key check (token ~ '^[0-9a-f]{64}$'),
  org_id uuid not null references pulse.org(id),
  stack_id uuid not null unique,
  org_name text not null default '',
  name text not null,
  blurb text not null default '',
  body jsonb not null default '[]' check (jsonb_typeof(body) = 'array'),
  public boolean not null default false,
  published_by text not null default '',
  published_at timestamptz not null default now(),
  uses integer not null default 0
);
create index stack_share_public on pulse_priv.stack_share (public, published_at desc);
alter table pulse_priv.stack_share enable row level security;
revoke all on pulse_priv.stack_share from public;

-- Share (or re-share after a change) one of this organisation's stacks; p_public lists it in the directory.
create function pulse.stack_share(p_stack uuid, p_public boolean, p_by text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s pulse.stack_set%rowtype; v_body jsonb; v_org_name text; v_token text;
begin
  if current_org() is null then raise exception 'Sign in to an organisation first' using errcode = '42501'; end if;
  select * into s from stack_set where id = p_stack and org_id = current_org();
  if not found then raise exception 'Stack not found' using errcode = 'P0002'; end if;
  select o.name into v_org_name from org o where o.id = current_org();
  select coalesce(jsonb_agg(jsonb_build_object('name', t.name, 'category', t.category, 'useCase', t.use_case, 'plan', coalesce(nullif(i->>'plan', ''), t.plan),
      'toolPlan', t.plan, 'costUsd', t.cost_usd, 'costInr', t.cost_inr, 'usd', i->'usd', 'inr', i->'inr', 'note', coalesce(i->>'note', ''),
      'existing', coalesce((i->>'existing')::boolean, false), 'freeTier', t.free_tier, 'limits', t.limits, 'pros', t.pros, 'cons', t.cons,
      'bestFor', t.best_for, 'verdict', t.verdict, 'verdictNote', t.verdict_note, 'status', t.status, 'sources', t.sources,
      'benchmark', t.benchmark, 'metrics', t.metrics, 'url', t.url) order by e.o), '[]'::jsonb) into v_body
  from jsonb_array_elements(s.items) with ordinality as e(i, o)
  join stack_tool t on t.org_id = current_org() and t.id::text = e.i->>'toolId';
  v_token := coalesce(s.share_token, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
  insert into pulse_priv.stack_share(token, org_id, stack_id, org_name, name, blurb, body, public, published_by, published_at)
  values (v_token, current_org(), s.id, coalesce(v_org_name, ''), s.name, s.blurb, v_body, coalesce(p_public, false), left(coalesce(p_by, ''), 80), now())
  on conflict (stack_id) do update set name = excluded.name, blurb = excluded.blurb, body = excluded.body, public = excluded.public,
    org_name = excluded.org_name, published_by = excluded.published_by, published_at = now()
  returning token into v_token;
  update stack_set set share_token = v_token, shared_public = coalesce(p_public, false) where id = s.id;
  return jsonb_build_object('token', v_token, 'public', coalesce(p_public, false));
end $$;

-- Stop sharing: the link and the directory entry go.
create function pulse.stack_unshare(p_stack uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if current_org() is null then raise exception 'Sign in to an organisation first' using errcode = '42501'; end if;
  delete from pulse_priv.stack_share where stack_id = p_stack and org_id = current_org();
  update stack_set set share_token = null, shared_public = false where id = p_stack and org_id = current_org();
end $$;

-- The Pulse stack directory: every published stack, for anyone signed in to an organisation.
create function pulse.stack_directory() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_org() is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('token', s.token, 'orgName', s.org_name, 'name', s.name, 'blurb', s.blurb,
      'tools', jsonb_array_length(s.body), 'body', s.body, 'publishedBy', s.published_by, 'publishedAt', s.published_at, 'uses', s.uses,
      'mine', s.org_id = current_org()) order by s.published_at desc)
    from (select * from pulse_priv.stack_share where public order by published_at desc limit 200) s), '[]'::jsonb);
end $$;

-- One shared stack by its link, for anyone signed in to an organisation (null when there is none).
create function pulse.stack_shared(p_token text) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_org() is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
  return (select jsonb_build_object('token', s.token, 'orgName', s.org_name, 'name', s.name, 'blurb', s.blurb, 'body', s.body,
      'publishedBy', s.published_by, 'publishedAt', s.published_at, 'uses', s.uses, 'public', s.public, 'mine', s.org_id = current_org())
    from pulse_priv.stack_share s where s.token = p_token);
end $$;

-- Counts a copy into another organisation ("Use this stack").
create function pulse.stack_share_used(p_token text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if current_org() is null then return; end if;
  update pulse_priv.stack_share set uses = uses + 1 where token = p_token and org_id <> current_org();
end $$;

revoke all on function pulse.stack_share(uuid, boolean, text), pulse.stack_unshare(uuid), pulse.stack_directory(), pulse.stack_shared(text), pulse.stack_share_used(text) from public;
grant execute on function pulse.stack_share(uuid, boolean, text), pulse.stack_unshare(uuid), pulse.stack_directory(), pulse.stack_shared(text), pulse.stack_share_used(text) to pulse_api;

-- migrate:down
drop function if exists pulse.stack_share_used(text);
drop function if exists pulse.stack_shared(text);
drop function if exists pulse.stack_directory();
drop function if exists pulse.stack_unshare(uuid);
drop function if exists pulse.stack_share(uuid, boolean, text);
drop table if exists pulse_priv.stack_share;
drop table if exists pulse.stack_set;
drop table if exists pulse.stack_tool;
drop table if exists pulse.sheet_view;
alter table pulse.hq_feature drop column if exists owner_id;
alter table pulse.hq_idea drop column if exists details;
alter table pulse.hq_idea drop column if exists owner_id;
alter table pulse.hq_idea drop column if exists area;
alter table pulse.hq_idea drop column if exists sort;
