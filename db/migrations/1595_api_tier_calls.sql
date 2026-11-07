-- migrate:up
-- API-PLATFORM-2 (owner, 5 Nov 2026: "complete control of Pulse through the API, agents, tier-wise access"), phase 2
-- item 2: the company's API tier is checked on every call, not only where keys are made. Design: docs/api/PLATFORM.md
-- section 5.
--
--  * Requests per minute per key follow the tier: free 60, pro 300, business 1,200, enterprise 5,000 (429 with
--    Retry-After beyond it). The front door asks pulse.api_call_plan() on each call's own transaction.
--  * A key's areas outside the tier are refused (403) on every call, after a 14-day grace when the plan goes down: for
--    14 days after a downgrade, calls run at the higher tier (its areas and its rate), then the extra areas close. Keys
--    are still made at the plan's own tier (pulse.api_tier(), unchanged), and the webhook cap follows the plan too.
--  * platform_plan remembers the tier it came down from and when (a trigger, whoever changes the plan).
--  * Fix (phase 1): the platform admin's first edit of a company's limits made its plan row with the table default,
--    'trial', which dropped that company's new keys to Free. The row now starts at the tier the company already had:
--    no row is enterprise, so it starts as 'custom' ('internal' for the install's own company). Set a plan in the same
--    edit and that plan applies, with the grace above when it is lower.
--  * Every company that already has a plan row below enterprise starts a 14-day grace now, so no key that works today
--    stops without notice.

alter table pulse_priv.platform_plan
 add column api_prior_tier text check (api_prior_tier is null or api_prior_tier in ('free', 'pro', 'business', 'enterprise')),
 add column api_downgraded_at timestamptz;

create function pulse.api_tier_of(p_plan text) returns text language sql immutable as $$
 select case p_plan when 'trial' then 'free' when 'starter' then 'pro' when 'growth' then 'business' else 'enterprise' end
$$;
create function pulse.api_tier_rank(p_tier text) returns int language sql immutable as $$
 select case p_tier when 'free' then 0 when 'pro' then 1 when 'business' then 2 when 'enterprise' then 3 end
$$;

-- When a plan change lowers the API tier, remember the tier it came down from (the higher one if a grace is still
-- running) and when. Raising it, or keeping it, ends any grace. Edits that leave the plan alone keep the grace as it is.
create function pulse.platform_plan_tier_grace() returns trigger language plpgsql set search_path = pulse, pg_temp as $$
declare was text; now_tier text := api_tier_of(new.plan);
begin
 if tg_op = 'UPDATE' and new.plan is not distinct from old.plan then return new; end if;
 if tg_op = 'INSERT' then
  was := 'enterprise';   -- no row was enterprise (grandfathered)
 else
  was := api_tier_of(old.plan);
  if old.api_downgraded_at > now() - interval '14 days' and api_tier_rank(old.api_prior_tier) > api_tier_rank(was) then was := old.api_prior_tier; end if;
 end if;
 if api_tier_rank(now_tier) < api_tier_rank(was) then
  new.api_prior_tier := was; new.api_downgraded_at := now();
 else
  new.api_prior_tier := null; new.api_downgraded_at := null;
 end if;
 return new;
end $$;
create trigger platform_plan_tier_grace before insert or update on pulse_priv.platform_plan
 for each row execute function pulse.platform_plan_tier_grace();

-- The tier a call runs at: the plan's tier, or the tier it came down from while the 14-day grace lasts.
create function pulse.api_call_tier() returns text language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when pp.api_downgraded_at > now() - interval '14 days' and api_tier_rank(pp.api_prior_tier) > api_tier_rank(api_tier_of(pp.plan))
   then pp.api_prior_tier else api_tier_of(pp.plan) end
 from (select null) x left join pulse_priv.platform_plan pp on pp.for_org = current_org()
$$;
create function pulse.api_tier_per_minute(p_tier text) returns int language sql immutable as $$
 select case p_tier when 'free' then 60 when 'pro' then 300 when 'business' then 1200 else 5000 end
$$;

-- Called by the API front door on every call, once the key is resolved (the call's company and principal are set):
-- the requests per minute for the key, and a 403 if the operation's areas are outside the tier the call runs at.
create function pulse.api_call_plan(p_scopes text[]) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare t text := api_call_tier(); outside text[];
begin
 if current_org() is null then raise exception 'An API key acts in one company' using errcode = '42501'; end if;
 outside := array(select s from unnest(coalesce(p_scopes, '{}')) s where not (s = any(api_tier_scopes(t))) order by s);
 if cardinality(outside) > 0 then
  raise exception 'Your company''s plan does not include %; ask an admin to change the plan', array_to_string(outside, ', ') using errcode = '42501';
 end if;
 return jsonb_build_object('tier', t, 'perMinute', api_tier_per_minute(t));
end $$;

-- api_plan(): the per-minute figures of this phase, and the grace (Settings → API keys warns the admin).
create or replace function pulse.api_plan() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('tier', t, 'plan', coalesce((select plan from pulse_priv.platform_plan where for_org = current_org()), 'none'),
   'scopes', to_jsonb(api_tier_scopes(t)),
   'botKeys', case t when 'free' then 1 when 'pro' then 3 when 'business' then 10 else 50 end,
   'perMinute', api_tier_per_minute(t),
   'webhooks', case t when 'free' then 0 when 'pro' then 5 when 'business' then 25 else 100 end,
   'botKeysLive', (select count(*)::int from pulse_priv.api_token where org_id = current_org() and kind = 'bot' and revoked_at is null and expires_at > now()),
   'callTier', api_call_tier(),
   'graceUntil', (select to_char((pp.api_downgraded_at + interval '14 days') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from pulse_priv.platform_plan pp
     where pp.for_org = current_org() and pp.api_downgraded_at > now() - interval '14 days' and api_tier_rank(pp.api_prior_tier) > api_tier_rank(t)))
 from api_tier() t
$$;

-- The fix: a company's first plan row keeps the tier it had (no row is enterprise). Otherwise as 1430.
create or replace function pulse.platform_org_set(p_org uuid, p jsonb, p_reason text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org; v_reason text := platform_reason(p_reason); v_changes jsonb := '{}'; v_status text := p ->> 'status'; v_ended int := 0;
begin
  perform platform_guard();
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  if v_status is not null and v_status is distinct from o.status then
    if v_status not in ('active', 'suspended') then raise exception 'Choose active or suspended' using errcode = '22023'; end if;
    if p_org = install_org() then raise exception 'The install''s own organisation cannot be suspended here' using errcode = '22023'; end if;
    if o.status = 'setup' then raise exception 'This organisation is still being set up: finish it under Companies' using errcode = '22023'; end if;
    update org set status = v_status where id = p_org;
    if v_status = 'suspended' then
      perform platform_enter(p_org);
      update login_session set revoked_at = now() where org_id = p_org and revoked_at is null;
      get diagnostics v_ended = row_count;
      perform platform_leave();
    end if;
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_array(o.status, v_status), 'sessionsEnded', v_ended);
  end if;
  if p ? 'plan' or p ? 'seatLimit' or p ? 'aiTokensMonth' or p ? 'trialEnds' or p ? 'note' or p ? 'overrideLimits' then
    -- API-PLATFORM-2: not the table's 'trial' default: a company with no plan row is enterprise for the API.
    insert into pulse_priv.platform_plan(for_org, plan) values (p_org, case when p_org = install_org() then 'internal' else 'custom' end)
      on conflict (for_org) do nothing;
    update pulse_priv.platform_plan set
      plan = case when p ? 'plan' then p ->> 'plan' else plan end,
      seat_limit = case when p ? 'seatLimit' then nullif(p ->> 'seatLimit', '')::int else seat_limit end,
      ai_tokens_month = case when p ? 'aiTokensMonth' then nullif(p ->> 'aiTokensMonth', '')::bigint else ai_tokens_month end,
      trial_ends = case when p ? 'trialEnds' then nullif(p ->> 'trialEnds', '')::date else trial_ends end,
      note = case when p ? 'note' then nullif(btrim(p ->> 'note'), '') else note end,
      override_limits = case when p ? 'overrideLimits' then coalesce((p ->> 'overrideLimits')::boolean, false) else override_limits end,
      updated_at = now(), updated_by = (select display_name from person where id = current_viewer())
     where for_org = p_org;
    v_changes := v_changes || (p - 'status');
  end if;
  perform platform_log(case when v_changes ? 'status' then 'org.' || v_status else 'org.plan' end, p_org, 'org', p_org::text, o.name, v_reason, v_changes);
  return v_changes;
end $$;

-- Companies already below enterprise: 14 days from now before areas outside their tier close.
update pulse_priv.platform_plan set api_prior_tier = 'enterprise', api_downgraded_at = now()
 where pulse.api_tier_of(plan) <> 'enterprise';

revoke all on function pulse.api_call_tier(), pulse.api_call_plan(text[]), pulse.platform_plan_tier_grace() from public;
grant execute on function pulse.api_call_tier(), pulse.api_call_plan(text[]), pulse.api_tier_of(text), pulse.api_tier_rank(text), pulse.api_tier_per_minute(text) to pulse_api;

-- migrate:down
-- Forward only: the per-call check is the API's; dropping api_call_plan stops it (the API then refuses every call).
