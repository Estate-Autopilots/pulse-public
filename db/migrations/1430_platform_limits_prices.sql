-- migrate:up
-- PULSE-ADMIN (owner, 28 Oct 2026): plan limits are enforced, and AI spend has a price.
--
-- Seats: the organisation's active team members (staff, not AI employees). At 80% of its plan's seats its admins see a
-- warning; at 100% a new team member is refused with a clear sentence. AI tokens: at 80% of its monthly AI tokens its
-- admins are warned; at 100% its AI employees take no new runs this month (they answer "budget spent", as for a daily
-- budget). A platform admin can lift both for one organisation (platform_plan.override_limits). An organisation without
-- a limit in its plan is never stopped.
--
-- Price: pulse_priv.platform_ai_price, rupees per million tokens in and out for each engine (the engine name the runtime
-- records; "*" is the price for any other), kept by platform admins in the admin site.

alter table pulse_priv.platform_plan add column override_limits boolean not null default false;

create table pulse_priv.platform_ai_price(
  engine text primary key check (engine = '*' or engine ~ '^[A-Za-z0-9][A-Za-z0-9:/._ -]{0,79}$'),
  inr_per_m_in numeric(12, 2) not null check (inr_per_m_in >= 0 and inr_per_m_in <= 1000000),
  inr_per_m_out numeric(12, 2) not null check (inr_per_m_out >= 0 and inr_per_m_out <= 1000000),
  note text check (note is null or length(note) <= 200),
  updated_at timestamptz not null default now(),
  updated_by text);
revoke all on pulse_priv.platform_ai_price from public;

-- -------------------------------------------------------------------------------------------- the current organisation
-- Seats used (active team members who are not AI employees), and this month's AI tokens, against the plan.
create function pulse.org_limits() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object(
    'seats', (select count(*) from person p where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'
                and not exists (select 1 from agent_member a where a.person_id = p.id)),
    'seatLimit', pp.seat_limit, 'aiTokens', platform_ai_tokens(date_trunc('month', now())), 'aiTokensMonth', pp.ai_tokens_month,
    'override', coalesce(pp.override_limits, false))
  from (select 1) x left join pulse_priv.platform_plan pp on pp.for_org = current_org()
$$;
revoke all on function pulse.org_limits() from public;
grant execute on function pulse.org_limits() to pulse_api;

-- True when the current organisation has used its plan's AI tokens for this month (and nobody lifted the limit).
create function pulse.org_ai_blocked() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select not pp.override_limits and pp.ai_tokens_month is not null and platform_ai_tokens(date_trunc('month', now())) >= pp.ai_tokens_month
                     from pulse_priv.platform_plan pp where pp.for_org = current_org()), false)
$$;
revoke all on function pulse.org_ai_blocked() from public;
grant execute on function pulse.org_ai_blocked() to pulse_api;

-- Every AI employee claim (0510 … 1230) locks its member row with agent_lock and refuses a run once the day's budget is
-- spent; an organisation over its monthly plan limit has no budget left today.
create or replace function pulse.agent_lock(p_agent uuid) returns pulse.agent_member
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m agent_member;
begin
  select * into m from agent_member where person_id = p_agent and org_id = current_org() for update;
  if found and org_ai_blocked() then m.daily_token_budget := 0; end if;
  return m;
end $$;

-- A new team member beyond the plan's seats is refused when the change commits (an AI employee created in the same
-- transaction is not a seat).
create function pulse.org_seat_check() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_limit int; v_override boolean; v_used int;
begin
  if new.side <> 'staff' or new.status <> 'active' or exists (select 1 from agent_member where person_id = new.id) then return null; end if;
  select seat_limit, override_limits into v_limit, v_override from pulse_priv.platform_plan where for_org = new.org_id;
  if v_limit is null or v_override then return null; end if;
  select count(*) into v_used from person p where p.org_id = new.org_id and p.side = 'staff' and p.status = 'active'
    and not exists (select 1 from agent_member a where a.person_id = p.id);
  if v_used > v_limit then
    raise exception 'This organisation has used all % seats of its plan. Ask Pulse for more seats, or make someone inactive first.', v_limit using errcode = '23514';
  end if;
  return null;
end $$;
revoke all on function pulse.org_seat_check() from public;
create constraint trigger person_seat_limit after insert or update of status, side on pulse.person
  deferrable initially deferred for each row execute function pulse.org_seat_check();

-- Admins (and leadership) of an organisation see a calm warning from 80% of a limit (the platform notices card).
create or replace function pulse.platform_notices() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  with l as (select org_limits() v where current_viewer() is not null and viewer_is('admin', 'leadership')),
  limit_notes as (
    select jsonb_build_object('id', 'limit-seats-' || (case when (v ->> 'seats')::int >= (v ->> 'seatLimit')::int then 'full' else 'near' end),
        'tone', 'warning', 'link', null,
        'title', case when (v ->> 'seats')::int >= (v ->> 'seatLimit')::int then 'All ' || (v ->> 'seatLimit') || ' seats of your plan are in use'
                      else (v ->> 'seats') || ' of ' || (v ->> 'seatLimit') || ' seats of your plan are in use' end,
        'body', case when (v ->> 'seats')::int >= (v ->> 'seatLimit')::int then 'New team members can''t be added until Pulse adds seats or someone is made inactive.'
                     else 'At ' || (v ->> 'seatLimit') || ', new team members can''t be added. Ask Pulse for more seats in time.' end) n
      from l where not (v ->> 'override')::boolean and v ->> 'seatLimit' is not null and (v ->> 'seats')::numeric >= 0.8 * (v ->> 'seatLimit')::numeric
    union all
    select jsonb_build_object('id', 'limit-ai-' || to_char(now(), 'YYYY-MM') || (case when (v ->> 'aiTokens')::numeric >= (v ->> 'aiTokensMonth')::numeric then '-full' else '-near' end),
        'tone', 'warning', 'link', null,
        'title', case when (v ->> 'aiTokens')::numeric >= (v ->> 'aiTokensMonth')::numeric then 'Your AI employees have used this month''s AI allowance'
                      else 'Your AI employees have used ' || round(100 * (v ->> 'aiTokens')::numeric / (v ->> 'aiTokensMonth')::numeric) || '% of this month''s AI allowance' end,
        'body', case when (v ->> 'aiTokens')::numeric >= (v ->> 'aiTokensMonth')::numeric then 'They take no new work until next month, or until Pulse raises the allowance.'
                     else 'At 100% they pause until next month. Ask Pulse to raise the allowance in time.' end) n
      from l where not (v ->> 'override')::boolean and v ->> 'aiTokensMonth' is not null and (v ->> 'aiTokens')::numeric >= 0.8 * (v ->> 'aiTokensMonth')::numeric)
  select coalesce((select jsonb_agg(n) from limit_notes), '[]') || coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'body', body, 'tone', tone, 'link', link) order by starts_at desc)
    from (select * from pulse_priv.platform_announcement
           where current_viewer() is not null and ended_at is null and starts_at <= now() and (ends_at is null or ends_at > now())
             and (audience = 'everyone' or viewer_is('admin'))
           order by starts_at desc limit 3) a), '[]')
$$;

-- -------------------------------------------------------------------------------------------- the platform's side
-- Plan changes may lift the limits for one organisation (overrideLimits).
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
    insert into pulse_priv.platform_plan(for_org) values (p_org) on conflict (for_org) do nothing;
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

-- The organisation detail carries the limits as they stand (usage, override).
create function pulse.platform_org_limits(p_org uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v jsonb;
begin
  perform platform_guard();
  perform platform_enter(p_org);
  v := org_limits();
  perform platform_leave();
  return v;
end $$;
revoke all on function pulse.platform_org_limits(uuid) from public;
grant execute on function pulse.platform_org_limits(uuid) to pulse_api;

-- Prices.
create function pulse.platform_ai_prices() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform platform_guard();
  return (select coalesce(jsonb_agg(jsonb_build_object('engine', engine, 'inPerM', inr_per_m_in, 'outPerM', inr_per_m_out, 'note', note, 'updatedAt', updated_at, 'updatedBy', updated_by)
    order by engine = '*', engine), '[]') from pulse_priv.platform_ai_price);
end $$;
revoke all on function pulse.platform_ai_prices() from public;
grant execute on function pulse.platform_ai_prices() to pulse_api;

-- { engine, inPerM, outPerM, note } sets a price; { engine, remove: true } removes it.
create function pulse.platform_ai_price_set(p jsonb) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_engine text := btrim(coalesce(p ->> 'engine', '')); v_name text;
begin
  perform platform_guard();
  if v_engine = '' then raise exception 'Name the engine (or * for any other)' using errcode = '22023'; end if;
  select display_name into v_name from person where id = current_viewer();
  if coalesce((p ->> 'remove')::boolean, false) then
    delete from pulse_priv.platform_ai_price where engine = v_engine;
  else
    insert into pulse_priv.platform_ai_price(engine, inr_per_m_in, inr_per_m_out, note, updated_by)
    values (v_engine, (p ->> 'inPerM')::numeric, (p ->> 'outPerM')::numeric, nullif(btrim(coalesce(p ->> 'note', '')), ''), v_name)
    on conflict (engine) do update set inr_per_m_in = excluded.inr_per_m_in, inr_per_m_out = excluded.inr_per_m_out, note = excluded.note,
      updated_at = now(), updated_by = excluded.updated_by;
  end if;
  perform platform_log('price.' || case when coalesce((p ->> 'remove')::boolean, false) then 'remove' else 'set' end, null, 'price', v_engine, v_engine, null, p);
end $$;
revoke all on function pulse.platform_ai_price_set(jsonb) from public;
grant execute on function pulse.platform_ai_price_set(jsonb) to pulse_api;

-- Rupees for tokens on an engine: its own price, else "*", else nothing known (null).
create function pulse.platform_ai_inr(p_engine text, p_in numeric, p_out numeric) returns numeric
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select round((p_in * pr.inr_per_m_in + p_out * pr.inr_per_m_out) / 1000000.0, 2)
    from pulse_priv.platform_ai_price pr where pr.engine in (p_engine, '*') order by pr.engine = '*' limit 1
$$;
revoke all on function pulse.platform_ai_inr(text, numeric, numeric) from public;

-- AI spend with rupees: every row (organisation × feature × engine) carries its price; and month by month per organisation.
create or replace function pulse.platform_ai_spend(p_days int) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; v_days int := least(greatest(coalesce(p_days, 30), 1), 365); v_since timestamptz; v_rows jsonb := '[]'; v_months jsonb := '[]'; v_part jsonb;
begin
  perform platform_guard();
  v_since := now() - make_interval(days => v_days);
  for o in select id, name from org order by name loop
    perform platform_enter(o.id);
    select coalesce(jsonb_agg(jsonb_build_object('orgId', o.id, 'org', o.name, 'source', source, 'engine', engine, 'runs', runs, 'tokensIn', tin, 'tokensOut', tout, 'failed', failed,
        'inr', platform_ai_inr(engine, tin, tout))), '[]')
      into v_part from (
        select 'AI employees' source, coalesce(engine, model, 'unknown') engine, count(*) runs, sum(coalesce(tokens_in, 0)) tin,
               sum(coalesce(tokens_out, 0) + case when coalesce(tokens_in, 0) + coalesce(tokens_out, 0) = 0 then coalesce(tokens, 0) else 0 end) tout,
               count(*) filter (where state = 'error') failed
          from agent_run where org_id = o.id and started_at >= v_since group by 2
        union all
        select 'Group summaries', coalesce(engine, 'unknown'), count(*), sum(coalesce(tokens_in, 0)), sum(coalesce(tokens_out, 0)), count(*) filter (where status in ('error', 'failed'))
          from chat_group_ai_job where org_id = o.id and created_at >= v_since group by 2
        union all
        select 'Product map', coalesce(engine, 'unknown'), count(*), sum(coalesce(tokens_in, 0)), sum(coalesce(tokens_out, 0)), count(*) filter (where status in ('error', 'failed'))
          from product_map_ai_job where org_id = o.id and created_at >= v_since group by 2) s;
    v_rows := v_rows || v_part;
    select coalesce(jsonb_agg(jsonb_build_object('orgId', o.id, 'org', o.name, 'month', ym, 'tokens', tin + tout, 'inr', inr) order by ym desc), '[]')
      into v_part from (
        select to_char(m, 'YYYY-MM') as ym, sum(tin) tin, sum(tout) tout, sum(platform_ai_inr(engine, tin, tout)) inr from (
          select date_trunc('month', started_at) m, coalesce(engine, model, 'unknown') engine, sum(coalesce(tokens_in, 0)) tin,
                 sum(coalesce(tokens_out, 0) + case when coalesce(tokens_in, 0) + coalesce(tokens_out, 0) = 0 then coalesce(tokens, 0) else 0 end) tout
            from agent_run where org_id = o.id and started_at >= date_trunc('month', now()) - interval '5 months' group by 1, 2
          union all
          select date_trunc('month', created_at), coalesce(engine, 'unknown'), sum(coalesce(tokens_in, 0)), sum(coalesce(tokens_out, 0))
            from chat_group_ai_job where org_id = o.id and created_at >= date_trunc('month', now()) - interval '5 months' group by 1, 2
          union all
          select date_trunc('month', created_at), coalesce(engine, 'unknown'), sum(coalesce(tokens_in, 0)), sum(coalesce(tokens_out, 0))
            from product_map_ai_job where org_id = o.id and created_at >= date_trunc('month', now()) - interval '5 months' group by 1, 2) e
        group by 1) mm;
    v_months := v_months || v_part;
    perform platform_leave();
  end loop;
  return jsonb_build_object('days', v_days, 'rows', v_rows, 'months', v_months,
    'priced', exists (select 1 from pulse_priv.platform_ai_price));
end $$;

-- migrate:down
drop function pulse.platform_ai_inr(text, numeric, numeric);
drop function pulse.platform_ai_price_set(jsonb);
drop function pulse.platform_ai_prices();
drop function pulse.platform_org_limits(uuid);
drop trigger person_seat_limit on pulse.person;
drop function pulse.org_seat_check();
drop function pulse.org_ai_blocked();
drop function pulse.org_limits();
drop table pulse_priv.platform_ai_price;
alter table pulse_priv.platform_plan drop column override_limits;
