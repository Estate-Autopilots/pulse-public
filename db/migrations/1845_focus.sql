-- migrate:up
-- FOCUS (owner, 7 Nov 2026, Focus OS proposal Phase 1): one private place for the owner's AI capacity, and a funding list.
-- Two organisation-only modules (services/api/src/modules.ts ORG_ONLY), each off unless the organisation's own modules
-- document names it in `on`:
--   * focus   - the capacity board (every AI and cloud account: % used, reset time, which company it serves, status, a
--               burn graph per company), the companies and their weights, the lanes, and the daily plan the allocator
--               recommends (services/api/src/focus-plan.ts). PRIVATE: organisation admins only (row security below), and
--               switched on only in the owner's own workspace (handle suyashhq) by this migration.
--   * funding - startup programmes and credits (amount, who can apply, documents, deadline, status, what blocks it);
--               leaders and admins. Switched on in the Vitals organisation (handle vitalstechnologies) and seeded there.
-- Collectors on the owner's machines post numbers only (never a credential) to /api/v0/focus-ingest with an ingest key;
-- only its sha256 is kept (pulse_priv.focus_ingest_key), and the definer functions below are the only way in with it.
-- "Who pays for which subscription" waits for Contracts (owner): no column for it yet.

create table pulse.focus_company (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z0-9-]{2,32}$'),
  name text not null check (length(btrim(name)) between 1 and 80),
  weight int not null default 10 check (weight between 0 and 100),
  hue int not null default 270 check (hue between 0 and 360),
  sort int not null default 0,
  unique (org_id, key)
);

create table pulse.focus_account (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[a-z0-9-]{2,40}$'),
  name text not null check (length(btrim(name)) between 1 and 80),
  kind text not null default 'ai' check (kind in ('ai', 'api', 'cloud')),
  provider text not null default '' check (length(provider) <= 40),
  own_company text,                                  -- focus_company.key it belongs to (null: the owner's own)
  companies text[] not null default '{}',            -- companies it may serve (empty: any)
  urgent_only text[] not null default '{}',          -- companies it may serve for urgent work only
  tiers text[] not null default '{T0,T1,T2,T3}' check (tiers <@ '{T0,T1,T2,T3}'::text[]),
  cost text not null default 'sunk' check (cost in ('sunk', 'metered')),
  source text not null default 'manual' check (source in ('statusline', 'claude-logs', 'codex-logs', 'api', 'manual')),
  status text not null default 'ok' check (status in ('ok', 'limited', 'off')),
  warm_lanes text[] not null default '{}',
  note text not null default '' check (length(note) <= 300),
  sort int not null default 0,
  unique (org_id, key)
);

-- One reading of one account's window: '5h' and '7d' are % used with the reset time; 'balance' is money left; 'tokens'
-- is a count of tokens in the last hour (the burn). company says whose work burned it, when the collector knows.
create table pulse.focus_sample (
  org_id uuid not null references pulse.org(id),
  id bigint generated always as identity primary key,
  account_id uuid not null references pulse.focus_account(id) on delete cascade,
  at timestamptz not null default now(),
  win text not null check (win in ('5h', '7d', 'balance', 'tokens')),
  used_pct numeric(5,1) check (used_pct between 0 and 100),
  resets_at timestamptz,
  amount numeric(14,4),
  currency text check (currency ~ '^[A-Z]{3}$'),
  company text,
  source text not null default 'manual' check (length(source) <= 40)
);
create index focus_sample_recent on pulse.focus_sample(org_id, account_id, win, at desc);

create table pulse.focus_lane (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  key text not null check (key ~ '^[A-Za-z0-9._-]{2,60}$'),
  title text not null check (length(btrim(title)) between 1 and 160),
  company text not null,
  value int not null default 5 check (value between 1 and 10),
  size text not null default 'M' check (size in ('S', 'M', 'L', 'XL')),
  need text not null default 'T2' check (need in ('T0', 'T1', 'T2', 'T3')),
  due_on date,
  urgent boolean not null default false,
  blocked_by text check (length(blocked_by) <= 160),
  status text not null default 'ready' check (status in ('ready', 'running', 'done', 'parked')),
  account text,
  unblocks int not null default 0 check (unblocks between 0 and 99),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);

create table pulse.focus_settings (
  org_id uuid primary key references pulse.org(id),
  reserve_5h int not null default 20 check (reserve_5h between 0 and 90),
  reserve_7d int not null default 15 check (reserve_7d between 0 and 90),
  auto_weights boolean not null default true,
  ingest_at timestamptz
);

-- The collector key's sha256, outside row security: a collector has no organisation until its key names one.
create table pulse_priv.focus_ingest_key (
  org_id uuid primary key references pulse.org(id),
  hash text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  made_at timestamptz not null default now()
);
revoke all on pulse_priv.focus_ingest_key from public;

-- The plan the allocator recommended for a day (the company's own day), kept as sent.
create table pulse.focus_plan (
  org_id uuid not null references pulse.org(id),
  day date not null,
  body jsonb not null,
  made_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (org_id, day)
);

create table pulse.funding_program (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  kind text not null default 'credits' check (kind in ('credits', 'grant', 'seed', 'scheme', 'membership')),
  amount text not null default '' check (length(amount) <= 80),
  eligibility text not null default '' check (length(eligibility) <= 400),
  docs text not null default '' check (length(docs) <= 400),
  deadline text not null default '' check (length(deadline) <= 80),
  status text not null default 'blocked' check (status in ('blocked', 'ready', 'drafting', 'applied', 'approved', 'rejected', 'active', 'not_fit')),
  blocked_by text check (length(blocked_by) <= 120),
  project_id uuid references pulse.project(id),
  url text check (url ~ '^https://[^\s]+$' and length(url) between 11 and 308),   -- 3 to 300 after https:// (Postgres allows no repetition count above 255)
  note text not null default '' check (length(note) <= 600),
  sort int not null default 0,
  updated_at timestamptz not null default now()
);
create index funding_program_org on pulse.funding_program(org_id, sort);

-- Row security: the tenant first; then the capacity board is the organisation admins' alone and funding is leaders'.
do $$ declare t text; begin
  foreach t in array array['focus_company','focus_account','focus_sample','focus_lane','focus_settings','focus_plan','funding_program'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    if t = 'funding_program' then
      execute format('create policy funding_leaders on pulse.%I as restrictive to pulse_api using (pulse.viewer_is(''admin'',''leadership'')) with check (pulse.viewer_is(''admin'',''leadership''))', t);
    else
      execute format('create policy focus_owner on pulse.%I as restrictive to pulse_api using (pulse.viewer_is(''admin'')) with check (pulse.viewer_is(''admin''))', t);
    end if;
    execute format('grant select, insert, update, delete on pulse.%I to pulse_api', t);
  end loop;
end $$;

-- Collectors: the ingest key's hash picks the organisation; the numbers go in through these functions only.
create function pulse.focus_ingest(p_hash text, p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_org uuid; a jsonb; s jsonb; l jsonb; v_acc uuid; n int := 0; m int := 0; v_plan_due boolean;
begin
  select org_id into v_org from pulse_priv.focus_ingest_key where hash = p_hash;
  if v_org is null then raise exception 'Unknown ingest key' using errcode = '28000'; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  update focus_settings set ingest_at = now() where org_id = v_org;
  for s in select * from jsonb_array_elements(coalesce(p->'samples', '[]'::jsonb)) limit 500 loop
    select id into v_acc from focus_account where org_id = v_org and key = s->>'account';
    if v_acc is null then continue; end if;
    insert into focus_sample(org_id, account_id, at, win, used_pct, resets_at, amount, currency, company, source)
    values (v_org, v_acc, coalesce(nullif(s->>'at', '')::timestamptz, now()), s->>'window',
      least(100, greatest(0, nullif(s->>'usedPct', '')::numeric)), nullif(s->>'resetsAt', '')::timestamptz,
      nullif(s->>'amount', '')::numeric, nullif(s->>'currency', ''), nullif(s->>'company', ''), left(coalesce(s->>'source', 'collector'), 40));
    if s->>'status' in ('ok', 'limited') then update focus_account set status = s->>'status' where id = v_acc and status <> 'off'; end if;
    n := n + 1;
  end loop;
  for l in select * from jsonb_array_elements(coalesce(p->'lanes', '[]'::jsonb)) limit 100 loop
    insert into focus_lane(org_id, key, title, company, status, account, blocked_by, updated_at)
    values (v_org, l->>'key', left(coalesce(nullif(l->>'title', ''), l->>'key'), 160), coalesce(nullif(l->>'company', ''), 'vitals'),
      coalesce(nullif(l->>'status', ''), 'running'), nullif(l->>'account', ''), nullif(left(l->>'blockedBy', 160), ''), now())
    on conflict (org_id, key) do update set status = excluded.status, account = coalesce(excluded.account, focus_lane.account),
      blocked_by = excluded.blocked_by, updated_at = now();
    m := m + 1;
  end loop;
  -- Readings older than 35 days are dropped: the burn graph shows 7.
  delete from focus_sample where org_id = v_org and at < now() - interval '35 days';
  -- the company's own clock (pulse.org_time_zone, 0179): 08:30 there, once a day there
  v_plan_due := (now() at time zone pulse.org_time_zone(v_org))::time >= time '08:30'
    and not exists (select 1 from focus_plan where org_id = v_org and day = (now() at time zone pulse.org_time_zone(v_org))::date);
  return jsonb_build_object('org', v_org, 'samples', n, 'lanes', m, 'planDue', v_plan_due);
end $$;

-- What the allocator reads, for the ingest path (no viewer): the same rows the board shows its admin.
create function pulse.focus_inputs(p_hash text) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_org uuid;
begin
  select org_id into v_org from pulse_priv.focus_ingest_key where hash = p_hash;
  if v_org is null then raise exception 'Unknown ingest key' using errcode = '28000'; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  return jsonb_build_object(
    'settings', (select to_jsonb(x) from (select reserve_5h "reserve5h", reserve_7d "reserve7d", auto_weights "autoWeights" from focus_settings where org_id = v_org) x),
    'companies', coalesce((select jsonb_agg(to_jsonb(x) order by x.sort) from (select key, name, weight, hue, sort from focus_company where org_id = v_org) x), '[]'),
    'accounts', coalesce((select jsonb_agg(to_jsonb(x)) from (select a.key, a.name, a.kind, a.own_company "ownCompany", a.companies, a.urgent_only "urgentOnly", a.tiers, a.cost,
        a.status, a.warm_lanes "warmLanes", a.source,
        (select jsonb_object_agg(w.win, jsonb_build_object('usedPct', w.used_pct, 'resetsAt', w.resets_at, 'amount', w.amount, 'at', w.at))
           from (select distinct on (win) win, used_pct, resets_at, amount, at from focus_sample where account_id = a.id and win in ('5h', '7d', 'balance')
                 order by win, at desc) w) latest
      from focus_account a where a.org_id = v_org) x), '[]'),
    'lanes', coalesce((select jsonb_agg(to_jsonb(x)) from (select key, title, company, value, size, need, due_on "dueOn", urgent, blocked_by "blockedBy", status, account, unblocks
      from focus_lane where org_id = v_org and status in ('ready', 'running')) x), '[]'));
end $$;

-- The day's plan, kept once. The Vitals OS bot (services/workers vitals_bot.py) then tells each admin whose Telegram
-- chat is linked that it is ready, with counts only and a link (focus_plan_outbound); unlinked, it stays in Pulse.
create function pulse.focus_plan_publish(p_hash text, p_body jsonb) returns boolean language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_org uuid; v_day date;
begin
  select org_id into v_org from pulse_priv.focus_ingest_key where hash = p_hash;
  if v_org is null then raise exception 'Unknown ingest key' using errcode = '28000'; end if;
  v_day := (now() at time zone pulse.org_time_zone(v_org))::date;
  perform set_config('pulse.org_id', v_org::text, true);
  insert into focus_plan(org_id, day, body) values (v_org, v_day, p_body) on conflict do nothing;
  return found;
end $$;

create function pulse.focus_plan_outbound() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out jsonb := '[]'::jsonb; pl focus_plan;
begin
  for pl in select * from focus_plan where org_id = current_org() and sent_at is null and made_at > now() - interval '12 hours' for update loop
    out := out || coalesce((select jsonb_agg(jsonb_build_object('chatId', t.chat_id, 'placed', jsonb_array_length(coalesce(pl.body->'placed', '[]')),
        'waiting', jsonb_array_length(coalesce(pl.body->'waiting', '[]')), 'blocked', jsonb_array_length(coalesce(pl.body->'blocked', '[]'))))
      from pulse_priv.telegram_person t join role_assignment r on r.org_id = t.org_id and r.person_id = t.person_id and r.role_key = 'admin'
        and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')
      where t.org_id = current_org()), '[]'::jsonb);
    update focus_plan set sent_at = now() where org_id = pl.org_id and day = pl.day;
  end loop;
  return out;
end $$;
-- An admin makes (or replaces) the organisation's collector key; Pulse keeps its hash only.
create function pulse.focus_key_set(p_hash text) returns timestamptz language plpgsql security definer set search_path = pulse, pg_temp as $$
declare t timestamptz;
begin
  if not viewer_is('admin') then raise exception 'Only the owner of this workspace makes a collector key' using errcode = '42501'; end if;
  insert into focus_settings(org_id) values (current_org()) on conflict do nothing;
  insert into pulse_priv.focus_ingest_key(org_id, hash) values (current_org(), p_hash)
    on conflict (org_id) do update set hash = excluded.hash, made_at = now() returning made_at into t;
  return t;
end $$;
create function pulse.focus_key_made() returns timestamptz language sql stable security definer set search_path = pulse, pg_temp as $$
  select made_at from pulse_priv.focus_ingest_key where org_id = pulse.current_org() and pulse.viewer_is('admin')
$$;
revoke all on function pulse.focus_ingest(text, jsonb), pulse.focus_inputs(text), pulse.focus_plan_publish(text, jsonb) from public;
grant execute on function pulse.focus_ingest(text, jsonb), pulse.focus_inputs(text), pulse.focus_plan_publish(text, jsonb) to pulse_api;

-- Switch the modules on and seed them where they belong. Nothing happens on an install without these organisations.
do $$
declare v_me uuid; v_vitals uuid; v_proj uuid; mods jsonb;
begin
  select id into v_me from pulse.org where handle = 'suyashhq';
  if v_me is not null then
    perform set_config('pulse.org_id', v_me::text, true);
    select body into mods from pulse.tenant_config where org_id = v_me and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
    if mods is null then
      insert into pulse.tenant_config(org_id, doc_kind, doc_key, version, body, is_active) values (v_me, 'tenant', 'modules', 1, '{"off": [], "on": ["focus"]}'::jsonb, true);
    elsif not coalesce(mods->'on', '[]'::jsonb) ? 'focus' then
      update pulse.tenant_config set body = jsonb_set(body, '{on}', coalesce(body->'on', '[]'::jsonb) || '["focus"]'::jsonb)
       where org_id = v_me and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
    end if;
    insert into pulse.focus_settings(org_id) values (v_me) on conflict do nothing;
    -- Owner's weights (7 Nov 2026), a starting point he edits; the plan adjusts them each day.
    insert into pulse.focus_company(org_id, key, name, weight, hue, sort) values
      (v_me, 'ac', 'Atlas Crest / Sales X-Ray', 30, 24, 0),
      (v_me, 'vitals', 'Vitals', 25, 268, 1),
      (v_me, 'ea', 'Estate Autopilots', 22, 205, 2),
      (v_me, 'wl', 'Willow Lane', 13, 150, 3),
      (v_me, 'adiguru', 'Adiguru', 6, 45, 4),
      (v_me, 'nayagrowth', 'NayaGrowth', 4, 330, 5)
    on conflict do nothing;
    insert into pulse.focus_account(org_id, key, name, kind, provider, own_company, companies, urgent_only, tiers, cost, source, sort) values
      (v_me, 'claude-team', 'Claude Team', 'ai', 'Anthropic', 'vitals', '{vitals,nayagrowth,ac,ea,adiguru,wl}', '{}', '{T0,T1,T2,T3}', 'sunk', 'statusline', 0),
      (v_me, 'claude-ea', 'Claude Max (EA)', 'ai', 'Anthropic', 'ea', '{ea,vitals}', '{}', '{T0,T1,T2,T3}', 'sunk', 'claude-logs', 1),
      (v_me, 'claude-wl', 'Claude Max (Willow Lane)', 'ai', 'Anthropic', 'wl', '{wl}', '{}', '{T0,T1,T2,T3}', 'sunk', 'statusline', 2),
      (v_me, 'claude-ultra', 'Claude Max Ultra', 'ai', 'Anthropic', null, '{vitals,ac,nayagrowth,adiguru}', '{wl,ea}', '{T0,T1,T2,T3}', 'sunk', 'statusline', 3),
      (v_me, 'codex-ac', 'Codex / ChatGPT (AC)', 'ai', 'OpenAI', 'ac', '{ac}', '{}', '{T0,T1,T2,T3}', 'sunk', 'codex-logs', 4),
      (v_me, 'codex-ea', 'Codex / ChatGPT (EA)', 'ai', 'OpenAI', 'ea', '{ea,vitals}', '{}', '{T0,T1,T2,T3}', 'sunk', 'codex-logs', 5),
      (v_me, 'antigravity', 'Antigravity', 'ai', 'Google', null, '{}', '{}', '{T0,T1,T2}', 'sunk', 'manual', 6),
      (v_me, 'openrouter', 'OpenRouter', 'api', 'OpenRouter', null, '{}', '{}', '{T0,T1}', 'metered', 'api', 7),
      (v_me, 'deepseek', 'DeepSeek', 'api', 'DeepSeek', null, '{}', '{}', '{T0,T1}', 'metered', 'api', 8),
      (v_me, 'kimi', 'Kimi', 'api', 'Moonshot', null, '{}', '{}', '{T0,T1}', 'metered', 'api', 9),
      (v_me, 'glm', 'GLM', 'api', 'Zhipu', null, '{}', '{}', '{T0,T1}', 'metered', 'manual', 10),
      (v_me, 'qwen', 'Qwen', 'api', 'Alibaba', null, '{}', '{}', '{T0,T1}', 'metered', 'manual', 11),
      (v_me, 'cloudflare', 'Cloudflare', 'cloud', 'Cloudflare', null, '{}', '{}', '{}', 'metered', 'manual', 12),
      (v_me, 'hostinger', 'Hostinger', 'cloud', 'Hostinger', null, '{}', '{}', '{}', 'metered', 'manual', 13),
      (v_me, 'github', 'GitHub', 'cloud', 'GitHub', null, '{}', '{}', '{}', 'metered', 'manual', 14)
    on conflict do nothing;
  end if;

  select id into v_vitals from pulse.org where handle = 'vitalstechnologies';
  if v_vitals is not null then
    perform set_config('pulse.org_id', v_vitals::text, true);
    select body into mods from pulse.tenant_config where org_id = v_vitals and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
    if mods is null then
      insert into pulse.tenant_config(org_id, doc_kind, doc_key, version, body, is_active) values (v_vitals, 'tenant', 'modules', 1, '{"off": [], "on": ["funding"]}'::jsonb, true);
    elsif not coalesce(mods->'on', '[]'::jsonb) ? 'funding' then
      update pulse.tenant_config set body = jsonb_set(body, '{on}', coalesce(body->'on', '[]'::jsonb) || '["funding"]'::jsonb)
       where org_id = v_vitals and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
    end if;
    select id into v_proj from pulse.project where org_id = v_vitals and name ilike 'Developer accounts%' order by registry_no limit 1;  -- (pulse.project has no created_at)
    if not exists (select 1 from pulse.funding_program where org_id = v_vitals) then
      insert into pulse.funding_program(org_id, name, kind, amount, eligibility, docs, deadline, blocked_by, project_id, url, sort) values
        (v_vitals, 'Cloudflare for Startups (Tier 3)', 'credits', '$10,000', 'Registered company under 10 years old, live website, company email. Agencies cannot apply.', 'Company proof, website, company email', 'Rolling (about 48 hours)', 'Company registration', v_proj, 'https://www.cloudflare.com/forstartups/', 0),
        (v_vitals, 'AWS Activate Founders', 'credits', '$1,000 to $5,000', 'Self-funded, before Series B, under 10 years old, paid AWS account.', 'Company proof, website, AWS account ID', 'Rolling (5 to 10 days)', 'Company registration', v_proj, 'https://aws.amazon.com/startups/credits', 1),
        (v_vitals, 'Microsoft for Startups (Azure)', 'credits', '$1,000 now + $4,000 later', 'New to Azure. Registered company.', 'Company proof, website, LinkedIn page', 'Rolling', 'Company registration', v_proj, 'https://www.microsoft.com/startups', 2),
        (v_vitals, 'Google for Startups Cloud (Start)', 'credits', 'About $2,000', 'No outside funding needed. Registered company.', 'Company proof, website, company email', 'Rolling', 'Company registration', v_proj, 'https://cloud.google.com/startup', 3),
        (v_vitals, 'NVIDIA Inception', 'membership', 'Membership and partner credits', 'Registered company, website, at least 1 developer listed.', 'Company proof, website, team list', 'Rolling', 'Company registration', v_proj, 'https://www.nvidia.com/en-us/startups/', 4),
        (v_vitals, 'ElevenLabs Startup Grants', 'credits', 'About 33M credits', 'Fewer than 25 people, not an agency, show their logo for 12 months.', 'Company proof, product link', 'Rolling (about 1 week)', 'Company registration', v_proj, 'https://elevenlabs.io/startup-grants', 5),
        (v_vitals, 'DPIIT startup recognition', 'scheme', 'Opens the other India schemes', 'Pvt Ltd or LLP under 10 years old, turnover under ₹200 crore, a new idea.', 'Certificate of incorporation, PAN, pitch note', 'Rolling', 'Company registration', v_proj, 'https://www.startupindia.gov.in/', 6),
        (v_vitals, 'Startup India Seed Fund (SISFS)', 'seed', 'Up to ₹20 lakh grant + ₹50 lakh debt', 'DPIIT recognised, registered under 2 years, apply through an incubator.', 'DPIIT certificate, pitch deck, incubator letter', 'Check the site (dates differ)', 'Company registration', v_proj, 'https://seedfund.startupindia.gov.in/', 7);
    end if;
  end if;
end $$;

-- migrate:down
-- Forward-only: the owner's capacity readings and the funding list are kept; drop by hand only with the code that reads them.
