-- migrate:up
-- API-PLATFORM (owner, 5 Nov 2026: "top-notch, root-level, complete control of Pulse through the API … agents can use
-- it, and tier-wise access can be given"), slice 1. Design: docs/api/PLATFORM.md; coverage: docs/api/COVERAGE.md.
--
--  * Two new API v1 areas: finance (the ledger in Finance → Entries: read, record an expense) and hr (leave requests:
--    read, file; attendance: read). A key reaches an area only when its maker ticked it, so every key that exists today
--    keeps exactly its current reach (grandfathered): nothing gains finance or hr, and people/attendance stays under
--    people.read as before.
--  * Tiers: the company's plan (pulse_priv.platform_plan, set by the platform admin) maps to an API tier: trial → free,
--    starter → pro, growth → business, scale, internal and custom → enterprise. A company without a plan row is
--    grandfathered as enterprise, so nothing that works today stops. The tier is a ceiling where keys are made: a new
--    personal token or bot key may hold only the tier's areas, and bot keys are counted against the tier's AI-agent seats.
--    Existing keys, rotation and OAuth connections are not narrowed by this slice (phase 2: runtime checks with a
--    downgrade grace period, per-tier rate limits and webhooks).
--  * Writes through the new operations are on the app ledger (pulse_priv.app_change, logged, not undone): a project
--    changed or deleted (restored from Work → Deleted for 30 days), an expense recorded, leave requested.
--  * Finance entries made through the API say so (source 'api').

create or replace function pulse.v1_scopes() returns text[] language sql immutable as $$
  select array['tasks.read','tasks.write','projects.read','projects.write','people.read','people.write','chats.read','chats.write',
   'docs.read','docs.write','billing.read','billing.write','workflows.read','workflows.write','companies.read','companies.write',
   'search.read','search.write','events.read','events.write','finance.read','finance.write','hr.read','hr.write']
$$;

alter table pulse_priv.app_change drop constraint app_change_action_check;
alter table pulse_priv.app_change add constraint app_change_action_check check (action in (
  'profile.correct', 'password.issue', 'invite.send', 'chat.group.create', 'chat.members', 'feedback.status',
  'task.create', 'task.assign', 'task.update', 'task.complete', 'comment.add', 'project.create', 'stage.owner', 'stage.task',
  'chat.message', 'client.create', 'catalog.item.create', 'stock.move', 'quotation.create', 'quotation.revise', 'quotation.submit',
  'quotation.approve', 'quotation.send', 'invoice.create', 'invoice.issue', 'payment.record',
  'project.update', 'project.delete', 'expense.create', 'leave.request'));

do $$ declare c text; begin
 for c in select conname from pg_constraint where conrelid = 'pulse.fin_entry'::regclass and contype = 'c'
   and pg_get_constraintdef(oid) ~ 'source' and pg_get_constraintdef(oid) ~ 'whatsapp' loop
  execute format('alter table pulse.fin_entry drop constraint %I', c);
 end loop;
end $$;
alter table pulse.fin_entry add constraint fin_entry_source_check check (source in ('manual', 'quick', 'whatsapp', 'chat', 'api'));

-- ------------------------------------------------------------------------------------------------ tiers
create function pulse.api_tier() returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select case (select plan from pulse_priv.platform_plan where for_org = current_org())
   when 'trial' then 'free' when 'starter' then 'pro' when 'growth' then 'business' else 'enterprise' end
$$;
-- The areas each tier may hand to a key. Business and enterprise hold every area; enterprise differs in its limits.
create function pulse.api_tier_scopes(p_tier text) returns text[] language sql immutable set search_path=pulse,pg_temp as $$
 select case p_tier
  when 'free' then array['tasks.read','tasks.write','projects.read','people.read','chats.read','search.read']
  when 'pro' then array['tasks.read','tasks.write','projects.read','projects.write','people.read','people.write','chats.read','chats.write',
    'search.read','search.write','companies.read','companies.write','events.read','events.write','docs.read','workflows.read']
  else pulse.v1_scopes() end
$$;
create function pulse.api_plan() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('tier', t, 'plan', coalesce((select plan from pulse_priv.platform_plan where for_org = current_org()), 'none'),
   'scopes', to_jsonb(api_tier_scopes(t)),
   'botKeys', case t when 'free' then 1 when 'pro' then 3 when 'business' then 10 else 50 end,
   'perMinute', case t when 'free' then 60 when 'pro' then 120 when 'business' then 300 else 600 end,
   'webhooks', case t when 'free' then 0 when 'pro' then 5 when 'business' then 25 else 100 end,
   'botKeysLive', (select count(*)::int from pulse_priv.api_token where org_id = current_org() and kind = 'bot' and revoked_at is null and expires_at > now()))
 from api_tier() t
$$;

-- 1562's issue, with the tier as a ceiling. A personal token acts as its person and a bot key as its AI member, so a
-- key never reaches past the person (or member) it acts as: row security and the role checks run as them.
create or replace function pulse.api_token_issue(p_kind text, p_name text, p_scopes text[], p_days int, p_agent uuid, p_hash text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); who uuid; tid uuid; plan jsonb; outside text[];
begin
 if me is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on' or coalesce(current_setting('pulse.v1_token_id', true), '') <> ''
   or not exists(select 1 from person where org_id = current_org() and id = me and side = 'staff' and status = 'active')
  then raise exception 'Sign in to Pulse as staff to make a token' using errcode = '42501'; end if;
 if p_kind not in ('personal', 'bot') or p_name is null or length(btrim(p_name)) not between 1 and 60 or p_days is null or p_days not between 1 and 365
   or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' or p_scopes is null or cardinality(p_scopes) = 0 or array_position(p_scopes, null) is not null
   or not (p_scopes <@ v1_scopes()) or cardinality(p_scopes) <> (select count(distinct s) from unnest(p_scopes) s)
  then raise exception 'Choose a name, the areas it may use and an expiry from 1 to 365 days' using errcode = '22023'; end if;
 plan := api_plan();
 outside := array(select s from unnest(p_scopes) s where not (s = any(array(select jsonb_array_elements_text(plan->'scopes')))) order by s);
 if cardinality(outside) > 0 then
  raise exception 'Your company''s plan does not include %; choose fewer areas or change the plan', array_to_string(outside, ', ') using errcode = '42501';
 end if;
 if p_kind = 'personal' then
  if p_agent is not null then raise exception 'A personal token acts as you' using errcode = '22023'; end if;
  who := me;
 else
  if not viewer_is('admin') then raise exception 'Company admins make bot keys' using errcode = '42501'; end if;
  if p_agent is null or not exists(select 1 from agent_member a join person p on p.id = a.person_id where a.org_id = current_org() and a.person_id = p_agent
    and a.disabled_at is null and p.side = 'agent' and p.status = 'active') then raise exception 'Choose an active AI member of this company' using errcode = '22023'; end if;
  if (plan->>'botKeysLive')::int >= (plan->>'botKeys')::int then
   raise exception 'Your company''s plan has % bot keys and all are in use; revoke one or change the plan', plan->>'botKeys' using errcode = '23514';
  end if;
  who := p_agent;
 end if;
 if (select count(*) from pulse_priv.api_token where org_id = current_org() and person_id = who and revoked_at is null and expires_at > now()) >= 20
  then raise exception 'At most 20 live tokens each; revoke one first' using errcode = '23514'; end if;
 insert into pulse_priv.api_token(org_id, kind, person_id, name, scopes, token_sha256, days, created_by, expires_at)
 values (current_org(), p_kind, who, btrim(p_name), p_scopes, p_hash, p_days, me, now() + make_interval(days => p_days)) returning id into tid;
 perform audit_write('api_token_issued', 'api_token', tid::text, p_scopes);
 return tid;
end $$;

revoke all on function pulse.api_tier(), pulse.api_tier_scopes(text), pulse.api_plan() from public;
grant execute on function pulse.api_tier(), pulse.api_tier_scopes(text), pulse.api_plan() to pulse_api;

-- migrate:down
-- Forward-only: the new areas are only reached by keys that were given them; revoke those keys to remove access.
