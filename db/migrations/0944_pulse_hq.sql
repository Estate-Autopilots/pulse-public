-- migrate:up
-- PULSE-HQ (owner, 23 Oct 2026): the business of Pulse, run in Pulse. A separate organisation, "Pulse" (@pulsehq), next
-- to Estate Autopilots and Atlas Crest, owned by the founder's Pulse account (@savuzo), opened the way "Start your
-- own Pulse" opens one (0920 pulse.account_start_org). Its own module, pulse_hq (/hq, /api/v0/hq), is switched on only
-- there: an organisation-only module stays off unless the organisation's tenant/modules document names it in `on`
-- (services/api/src/modules.ts ORG_ONLY), so Estate Autopilots, Atlas Crest and every licensed company never see it.
-- Four company tables, row-level security forced like every company table:
--   hq_feature   the catalogue of every Pulse feature (category, promise, what, who, status, proof)
--   hq_idea      the ideation board (problem, for whom, impact and effort, status, linked features) and its votes
--   hq_offer     Offer Studio: an offer's customer, value equation, deliverables, bonuses, guarantee, scarcity,
--                naming, price anchors and price, positioning and brand notes, and its tiers of features
--   hq_brand     the organisation's positioning and brand (one row)
-- Safe on a live install: additive. Where neither the @savuzo account nor the founder's person exists (a fresh or CI
-- database) no organisation is opened and nothing is seeded.

create table pulse.hq_feature (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  key text not null check (key ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  category text not null check (category in ('home','work','flows','chats','people','finance','clients','creative','xray','network','apps','admin','platform')),
  name text not null check (length(btrim(name)) between 2 and 80),
  promise text not null default '' check (length(promise) <= 200),
  what text not null default '' check (length(what) <= 600),
  who text not null default '' check (length(who) <= 120),
  status text not null default 'live' check (status in ('live','beta','building','idea')),
  icon text not null default 'Sparkles' check (icon ~ '^[A-Z][A-Za-z0-9]{1,40}$'),
  proof text not null default '' check (length(proof) <= 300),
  screenshot text check (screenshot is null or length(screenshot) <= 300),
  sort int not null default 0,
  draft boolean not null default false,
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);
create index hq_feature_category on pulse.hq_feature (org_id, category, sort);

create table pulse.hq_idea (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  title text not null check (length(btrim(title)) between 2 and 120),
  problem text not null default '' check (length(problem) <= 1000),
  for_whom text not null default '' check (length(for_whom) <= 160),
  impact smallint not null default 3 check (impact between 1 and 5),
  effort smallint not null default 3 check (effort between 1 and 5),
  status text not null default 'new' check (status in ('new','exploring','planned','building','shipped','parked')),
  feature_keys text[] not null default '{}' check (cardinality(feature_keys) <= 20),
  feature_id uuid references pulse.hq_feature(id) on delete set null,
  draft boolean not null default false,
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index hq_idea_recent on pulse.hq_idea (org_id, created_at desc);

create table pulse.hq_idea_vote (
  org_id uuid not null references pulse.org(id),
  idea_id uuid not null references pulse.hq_idea(id) on delete cascade,
  person_id uuid not null references pulse.person(id),
  created_at timestamptz not null default now(),
  primary key (idea_id, person_id)
);

create table pulse.hq_offer (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  name text not null check (length(btrim(name)) between 2 and 80),
  status text not null default 'draft' check (status in ('draft','testing','ready','retired')),
  icp text not null default '' check (length(icp) <= 600),
  dream_outcome text not null default '' check (length(dream_outcome) <= 600),
  -- Hormozi's value equation, each 1 to 10: (dream outcome x perceived likelihood) / (time delay x effort and sacrifice).
  -- Time delay and effort are scored as felt by the buyer: 1 is instant and effortless, 10 is slow and hard.
  v_dream smallint not null default 7 check (v_dream between 1 and 10),
  v_likelihood smallint not null default 6 check (v_likelihood between 1 and 10),
  v_time smallint not null default 4 check (v_time between 1 and 10),
  v_effort smallint not null default 4 check (v_effort between 1 and 10),
  deliverables jsonb not null default '[]' check (jsonb_typeof(deliverables) = 'array'),
  bonuses jsonb not null default '[]' check (jsonb_typeof(bonuses) = 'array'),
  guarantee text not null default '' check (length(guarantee) <= 600),
  scarcity text not null default '' check (length(scarcity) <= 400),
  urgency text not null default '' check (length(urgency) <= 400),
  naming jsonb not null default '{}' check (jsonb_typeof(naming) = 'object'),
  anchors jsonb not null default '[]' check (jsonb_typeof(anchors) = 'array'),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  price numeric(14,2) check (price is null or price >= 0),
  billing text not null default 'month' check (billing in ('month','year','once','seat-month')),
  positioning text not null default '' check (length(positioning) <= 800),
  brand_notes text not null default '' check (length(brand_notes) <= 800),
  tiers jsonb not null default '[]' check (jsonb_typeof(tiers) = 'array'),
  accent text not null default '#6b4cf0' check (accent ~ '^#[0-9a-f]{6}$'),
  sort int not null default 0,
  draft boolean not null default false,
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index hq_offer_sort on pulse.hq_offer (org_id, sort, created_at);

create table pulse.hq_brand (
  org_id uuid primary key references pulse.org(id),
  body jsonb not null default '{}' check (jsonb_typeof(body) = 'object'),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['hq_feature','hq_idea','hq_idea_vote','hq_offer','hq_brand'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select, insert, update, delete on pulse.%I to pulse_api', t);
  end loop;
end $$;

-- ------------------------------------------------------------------------------------------------ the Pulse organisation
-- Opened like pulse.account_start_org (0920) for the founder's Pulse account (@savuzo). Where that account does not exist
-- yet (accounts are made on first use, 0920 pulse.account_ensure), it is made here the same way for the founder's person
-- in Estate Autopilots: the one signing in as user-668d21b6@estateautopilots.com (their Google account) or with that work e-mail.
do $$
declare a pulse_priv.pulse_account%rowtype; v_org uuid := gen_random_uuid(); v_person uuid; v_code text := 'PUL'; k int := 0;
  v_ea uuid; v_founder uuid; v_acct uuid; r record; h text;
begin
  select id into v_ea from pulse.org where handle = 'estateautopilots';
  if v_ea is null or exists (select 1 from pulse.org where handle = 'pulsehq') or exists (select 1 from pulse_priv.handle_name where handle = 'pulsehq') then
    return;
  end if;
  select * into a from pulse_priv.pulse_account where handle = 'savuzo';
  if not found then
    perform pulse.acct_enter(v_ea, null);
    select coalesce(
      (select x.holder_person_id from pulse.account x join pulse.person p on p.id = x.holder_person_id
        where x.org_id = v_ea and lower(x.handle) = 'user-668d21b6@estateautopilots.com' and p.status = 'active' limit 1),
      (select pp.person_id from pulse.people_profile pp join pulse.person p on p.id = pp.person_id
        where pp.org_id = v_ea and lower(pp.email) = 'user-668d21b6@estateautopilots.com' and p.status = 'active' limit 1)) into v_founder;
    if v_founder is not null then
      select p.display_name, pp.username, lower(pp.email) email into r from pulse.person p left join pulse.people_profile pp on pp.person_id = p.id where p.id = v_founder;
    end if;
    perform pulse.acct_leave();
    if v_founder is null then return; end if;
    select account_id into v_acct from pulse_priv.account_member where member_org = v_ea and person_id = v_founder;
    if v_acct is null then
      h := case when not exists (select 1 from pulse_priv.handle_name where handle = 'savuzo') then 'savuzo'
        else pulse.handle_suggest(coalesce(nullif(replace(coalesce(r.username, ''), '.', ''), ''), r.display_name)) end;
      insert into pulse_priv.pulse_account(handle, display_name, email, last_org)
      values (h, r.display_name, case when r.email is not null and not exists (select 1 from pulse_priv.pulse_account x where x.email = r.email) then r.email end, v_ea)
      returning id into v_acct;
      insert into pulse_priv.handle_name(handle, kind, ref) values (h, 'person', v_acct);
      insert into pulse_priv.account_member(account_id, member_org, person_id, kind, last_used_at) values (v_acct, v_ea, v_founder, 'staff', now());
    end if;
    select * into a from pulse_priv.pulse_account where id = v_acct;
  end if;
  while exists (select 1 from pulse.org where code = v_code) loop
    k := k + 1; v_code := 'P' || chr(65 + (k % 26)) || chr(65 + ((k / 26) % 26));
  end loop;
  perform pulse.acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'Pulse account @' || a.handle, true);
  insert into pulse.org(id, slug, name, code, handle) values (v_org, 'pulsehq', 'Pulse', v_code, 'pulsehq');
  insert into pulse.hr_policy(org_id, attendance_enabled) values (v_org, false) on conflict (org_id) do nothing;
  insert into pulse.org_module(org_id, module, enabled) values (v_org, 'tasks', true), (v_org, 'chats', true), (v_org, 'finance', true);
  insert into pulse.person(org_id, display_name, side, status, active_from) values (v_org, a.display_name, 'staff', 'active', current_date) returning id into v_person;
  insert into pulse.people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
  values (v_org, v_person, 'Founder', a.email, a.handle, 1, 'Opened the Pulse organisation (@' || a.handle || ')', '{}');
  insert into pulse.role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, 'admin', current_date);
  insert into pulse.record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (v_org, 'person', v_person, 'created', null, 'Opened the Pulse organisation for the business of Pulse', null);
  -- Pulse HQ is this organisation's own module (organisation-only: off everywhere that does not switch it on).
  insert into pulse.tenant_config(org_id, doc_kind, doc_key, version, body, is_active)
  values (v_org, 'tenant', 'modules', 1, '{"off": [], "on": ["pulse_hq"]}'::jsonb, true);
  perform pulse.acct_leave();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (a.id, v_org, v_person, 'staff');
end $$;

-- migrate:down
drop table if exists pulse.hq_brand;
drop table if exists pulse.hq_offer;
drop table if exists pulse.hq_idea_vote;
drop table if exists pulse.hq_idea;
drop table if exists pulse.hq_feature;
