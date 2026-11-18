-- migrate:up
-- TOKENS-2 (orchestrator under the owner's delegation, 17 Nov 2026), after TOKENS-TELEMETRY's audit (2270): the strongest
-- model ran routine work (Opus "thinking" in 155 of 253 runs), no engine had a price (so no rupees and no rupee budget),
-- and the learning loop had no way to turn a repeated success into a rule.
--
-- 1. One price matcher. A price is set per engine name or per model (platform_ai_price, 1430; set from the providers'
--    public price pages on 17 Nov 2026). ai_price_inr (2270) and platform_ai_inr (1430, the admin's AI spend and
--    the AI employees' cost cards) now read prices the same way: the full engine name, else its model (server:claude/
--    sonnet -> sonnet, connection:<id>/gpt-6.1-sol -> gpt-6.1-sol), else "*". Null when nothing is set.
-- 2. Rupee budgets: an AI employee's rupees a month (agent_member.monthly_inr) and the company's (agent_org_ai.monthly_inr).
--    agent_budget_state (1840) adds both meters; at 80% its budget approver and owner are told (agents.ts' existing
--    watch), at 100% agent_lock (1596) refuses new runs as for a spent token budget and the person waiting is told
--    (agent_budget_reply). Rupees are the providers' list prices (an upper bound: cache reads count as full input).
-- 3. The model router's trace: each run records the router's class (small, lookup, action, heavy), the tier it ran on
--    (small, fast, strong), the tier it was escalated from, the tools it called in order and the shape of its answer.
--    A company can change the router (agent_org_ai.router: off, or another tier per class); the runtime reads it with
--    its engines, with how often each class needed a stronger tier here lately (learned: it starts such a class a tier up).
-- 4. Promotion (the one learning loop with FIN-AGENT): ai_pattern_scan finds work done the same way again and again
--    (same kind of work, same tools in the same order, same answer shape; 5+ successful runs in 14 days, none escalated
--    or on a fallback engine) and files it in ai_heuristic as a candidate with its evidence. An admin approves it
--    (ai_heuristic_set, 2270, audited) or dismisses it; the runtime gets the approved ones with its engines and prefers
--    them: the steps go into the prompt as the known way, the run starts on the cheaper tier, and the run records a
--    decision with the tokens it saved. Scripts with code stay FIN-AGENT's agent_skill (proposed -> published with tests);
--    both report into the same trace (ai_decision) and the same registry view.
-- 5. ai_router_report(days): runs per class and per week (on the strongest model, on the strong tier, escalated, rupees),
--    cost per kind of work, and the patterns (candidates and approved). Leadership reads it on Insights → AI cost.

-- 1. -------------------------------------------------------------------------------------------------- prices
create or replace function pulse.ai_price_inr(p_engine text, p_in numeric, p_out numeric) returns numeric
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select round((coalesce(p_in, 0) * pr.inr_per_m_in + coalesce(p_out, 0) * pr.inr_per_m_out) / 1000000.0, 2)
    from pulse_priv.platform_ai_price pr
   where pr.engine in (coalesce(p_engine, ''), regexp_replace(coalesce(p_engine, ''), '^(server|runner|connection|env|local):[^/]*/?', ''), '*')
   order by pr.engine = '*', length(pr.engine) desc limit 1
$$;

create or replace function pulse.platform_ai_inr(p_engine text, p_in numeric, p_out numeric) returns numeric
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select ai_price_inr(p_engine, p_in, p_out)
$$;

-- 2. -------------------------------------------------------------------------------------------------- rupee budgets
alter table pulse.agent_member add column monthly_inr numeric(12, 2) check (monthly_inr is null or monthly_inr between 1 and 10000000);
alter table pulse.agent_org_ai add column monthly_inr numeric(14, 2) check (monthly_inr is null or monthly_inr between 1 and 1000000000);

-- Rupees an AI employee (or, with null, the whole company) has used this month, in the company's month: finished runs at
-- their engine's price, running ones at their reserve as input. Unpriced runs count nothing (never a made-up figure).
create function pulse.agent_month_inr(p_agent uuid) returns numeric language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(sum(coalesce(ai_price_inr(coalesce(r.engine, nullif(r.model, ''), '*'),
           case when r.state in ('done', 'error') then coalesce(r.tokens_in, r.tokens, 0) else coalesce(r.reserved, 0) end,
           case when r.state in ('done', 'error') then coalesce(r.tokens_out, 0) else 0 end), 0)), 0)
    from agent_run r
   where r.org_id = current_org() and (p_agent is null or r.agent_id = p_agent)
     and r.started_at >= (date_trunc('month', now() at time zone org_time_zone()) at time zone org_time_zone())
$$;
revoke all on function pulse.agent_month_inr(uuid) from public;

-- agent_budget_state (1840) keeps its token meters; the rupee meters are added around it.
alter function pulse.agent_budget_state(uuid) rename to agent_budget_state_tokens;
revoke all on function pulse.agent_budget_state_tokens(uuid) from public, pulse_api;
create function pulse.agent_budget_state(p_agent uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare s jsonb := agent_budget_state_tokens(p_agent); v_cap numeric; v_org_cap numeric; v_used numeric; v_org_used numeric;
  sr numeric := 0; so numeric := 0; top numeric; v_per text; tz text := org_time_zone();
begin
  select monthly_inr into v_cap from agent_member where person_id = p_agent and org_id = current_org();
  select monthly_inr into v_org_cap from agent_org_ai where org_id = current_org();
  if v_cap is null and v_org_cap is null then return s || jsonb_build_object('rupees', null, 'orgRupees', null); end if;
  if v_cap is not null then v_used := agent_month_inr(p_agent); sr := v_used / v_cap; end if;
  if v_org_cap is not null then v_org_used := agent_month_inr(null); so := v_org_used / v_org_cap; end if;
  s := s || jsonb_build_object(
    'rupees', case when v_cap is not null then jsonb_build_object('used', round(v_used, 2), 'limit', v_cap, 'share', round(sr * 100)) end,
    'orgRupees', case when v_org_cap is not null then jsonb_build_object('used', round(v_org_used, 2), 'limit', v_org_cap, 'share', round(so * 100)) end);
  top := greatest(sr, so);
  -- The rupee meter speaks when it is the fullest one (the company's plan stop always speaks first).
  if s ->> 'period' <> 'plan' and round(top * 100) > coalesce((s ->> 'share')::numeric, 0) then
    v_per := case when sr >= so then 'rupees' else 'org_rupees' end;
    s := s || jsonb_build_object('period', v_per, 'share', round(top * 100),
      'level', case when top >= 1 then 'out' when top >= 0.8 then 'warn' else 'ok' end,
      'key', v_per || ':' || to_char(now() at time zone tz, 'YYYY-MM'));
  end if;
  return s;
end $$;
revoke all on function pulse.agent_budget_state(uuid) from public;
grant execute on function pulse.agent_budget_state(uuid) to pulse_api;

-- agent_lock (1596): a spent rupee budget (its own or the company's) stops new runs like a spent token budget.
alter function pulse.agent_lock(uuid) rename to agent_lock_tokens;
create function pulse.agent_lock(p_agent uuid) returns pulse.agent_member language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m agent_member := agent_lock_tokens(p_agent); v_org_cap numeric;
begin
  if m.person_id is null or m.daily_token_budget <= 0 then return m; end if;
  select monthly_inr into v_org_cap from agent_org_ai where org_id = current_org();
  if (m.monthly_inr is not null and agent_month_inr(p_agent) >= m.monthly_inr)
     or (v_org_cap is not null and agent_month_inr(null) >= v_org_cap) then
    m.daily_token_budget := 0;
  end if;
  return m;
end $$;

-- An admin or leadership sets the rupees a month for an AI employee (p_agent) or the whole company (null); null clears.
create function pulse.ai_rupee_budget_set(p_agent uuid, p_inr numeric) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or current_viewer() is null or not viewer_is('admin', 'leadership') then
    raise exception 'Admins and leadership set AI budgets' using errcode = '42501'; end if;
  if p_inr is not null and (p_inr < 1 or p_inr > case when p_agent is null then 1000000000 else 10000000 end) then
    raise exception 'Give the rupees a month as a number from 1 to %', case when p_agent is null then '1,00,00,00,000' else '1,00,00,000' end using errcode = '22023'; end if;
  if p_agent is null then
    insert into agent_org_ai(org_id, monthly_inr, updated_by) values (current_org(), round(p_inr, 2), current_viewer())
    on conflict (org_id) do update set monthly_inr = excluded.monthly_inr, updated_by = excluded.updated_by, updated_at = now();
    perform audit_write('update', 'agent_org_ai', current_org()::text);
    return jsonb_build_object('monthlyInr', round(p_inr, 2), 'usedThisMonth', round(agent_month_inr(null), 2));
  end if;
  update agent_member set monthly_inr = round(p_inr, 2) where person_id = p_agent and org_id = current_org();
  if not found then raise exception 'Not found' using errcode = 'P0002'; end if;
  perform audit_write('update', 'agent_member', p_agent::text);
  return jsonb_build_object('monthlyInr', round(p_inr, 2), 'usedThisMonth', round(agent_month_inr(p_agent), 2), 'budget', agent_budget_state(p_agent));
end $$;
revoke all on function pulse.ai_rupee_budget_set(uuid, numeric) from public;
grant execute on function pulse.ai_rupee_budget_set(uuid, numeric) to pulse_api;

-- 3. -------------------------------------------------------------------------------------------------- the router's trace
alter table pulse.agent_run drop constraint if exists agent_run_engine_tier_check;
alter table pulse.agent_run add constraint agent_run_engine_tier_check check (engine_tier in ('small', 'fast', 'strong'));
alter table pulse.agent_run
  add column route_class text check (route_class in ('small', 'lookup', 'action', 'heavy')),
  add column route_why text check (length(route_why) <= 120),
  add column escalated_from text check (escalated_from in ('small', 'fast')),
  add column tools_used text[] check (cardinality(tools_used) <= 40),
  add column answer_shape text check (answer_shape ~ '^[a-z0-9_.:+=-]{1,80}$');
alter table pulse.agent_org_ai add column router jsonb not null default '{}' check (jsonb_typeof(router) = 'object' and length(router::text) <= 2000);
alter table pulse.ai_heuristic add column pattern jsonb check (pattern is null or (jsonb_typeof(pattern) = 'object' and length(pattern::text) <= 4000));

-- The router's settings as saved: {mode: auto|off, tiers: {small|lookup|action|heavy: small|fast|strong}}; anything else dropped.
create function pulse.ai_router_clean(p jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('mode', case when p ->> 'mode' = 'off' then 'off' else 'auto' end,
    'tiers', coalesce((select jsonb_object_agg(k, v) from jsonb_each_text(case when jsonb_typeof(p -> 'tiers') = 'object' then p -> 'tiers' else '{}' end) t(k, v)
                        where k in ('small', 'lookup', 'action', 'heavy') and v in ('small', 'fast', 'strong')), '{}'))
$$;

-- Same as 0988's, plus the router's class, tier, escalation, tools in order and the answer's shape.
create or replace function pulse.agent_run_engine(p_run uuid, p jsonb) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  update agent_run set engine = left(nullif(p->>'engine', ''), 80), engine_tier = case when p->>'tier' in ('small', 'fast', 'strong') then p->>'tier' end,
    tokens_in = case when (p->>'tokensIn') ~ '^\d{1,12}$' then (p->>'tokensIn')::bigint end, tokens_out = case when (p->>'tokensOut') ~ '^\d{1,12}$' then (p->>'tokensOut')::bigint end,
    fallback_from = left(nullif(p->>'fallbackFrom', ''), 300),
    route_class = case when p->>'routeClass' in ('small', 'lookup', 'action', 'heavy') then p->>'routeClass' end,
    route_why = left(nullif(p->>'routeWhy', ''), 120),
    escalated_from = case when p->>'escalatedFrom' in ('small', 'fast') then p->>'escalatedFrom' end,
    tools_used = case when jsonb_typeof(p->'tools') = 'array' then
      (select array_agg(left(t, 60) order by n) from jsonb_array_elements_text(p->'tools') with ordinality x(t, n) where n <= 40 and t ~ '^[a-z][a-z0-9_]{0,59}$') end,
    answer_shape = case when (p->>'shape') ~ '^[a-z0-9_.:+=-]{1,80}$' then p->>'shape' end
   where id = p_run and org_id = current_org() and agent_id = me and started_at > now() - interval '1 day';
  if not found then raise exception 'That run is not yours' using errcode = '42501'; end if;
end $$;

-- Leaders' save (0988) also takes the router and the company's rupees a month.
create or replace function pulse.agent_org_ai_save(p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o agent_org_ai; v_inr numeric;
begin
  if not viewer_is('admin', 'leadership') then raise exception 'Leaders set the organisation''s AI engines and budgets' using errcode = '42501'; end if;
  if p ? 'monthlyInr' and nullif(p->>'monthlyInr', '') is not null then
    if (p->>'monthlyInr') !~ '^\d{1,10}(\.\d{1,2})?$' or (p->>'monthlyInr')::numeric not between 1 and 1000000000 then
      raise exception 'Give the company''s rupees a month as a number from 1 to 1,00,00,00,000' using errcode = '22023'; end if;
    v_inr := (p->>'monthlyInr')::numeric;
  end if;
  insert into agent_org_ai(org_id, engines, budgets, daily_tokens, router, monthly_inr, updated_by)
  values (current_org(), coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'engines', '[]'::jsonb)) x), '{}'),
    coalesce(p->'budgets', '{}'::jsonb), nullif(p->>'dailyTokens', '')::bigint, ai_router_clean(coalesce(p->'router', '{}')), v_inr, current_viewer())
  on conflict (org_id) do update set
    engines = case when p ? 'engines' then excluded.engines else agent_org_ai.engines end,
    budgets = case when p ? 'budgets' then excluded.budgets else agent_org_ai.budgets end,
    daily_tokens = case when p ? 'dailyTokens' then excluded.daily_tokens else agent_org_ai.daily_tokens end,
    router = case when p ? 'router' then excluded.router else agent_org_ai.router end,
    monthly_inr = case when p ? 'monthlyInr' then excluded.monthly_inr else agent_org_ai.monthly_inr end,
    updated_by = excluded.updated_by, updated_at = now()
  returning * into o;
  perform audit_write('update', 'agent_org_ai', current_org()::text);
  return jsonb_build_object('engines', to_jsonb(o.engines), 'budgets', o.budgets, 'dailyTokens', o.daily_tokens, 'router', o.router, 'monthlyInr', o.monthly_inr);
end $$;

create or replace function pulse.agent_org_ai_read() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select jsonb_build_object('engines', to_jsonb(engines), 'budgets', budgets, 'dailyTokens', daily_tokens, 'router', router,
      'monthlyInr', monthly_inr, 'usedThisMonthInr', round(agent_month_inr(null), 2), 'updatedAt', updated_at)
    from agent_org_ai where org_id = current_org()),
    jsonb_build_object('engines', '[]'::jsonb, 'budgets', '{}'::jsonb, 'dailyTokens', null, 'router', '{}'::jsonb, 'monthlyInr', null,
      'usedThisMonthInr', round(agent_month_inr(null), 2)))
$$;

-- What the router learned here: of each class's runs in the last 14 days (5 at least), the share that needed a stronger tier.
create function pulse.ai_router_learned() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_object_agg(route_class, share), '{}') from (
    select route_class, round(100.0 * count(*) filter (where escalated_from is not null) / count(*)) share
      from agent_run where org_id = current_org() and route_class is not null and started_at > now() - interval '14 days'
     group by route_class having count(*) >= 5) x
$$;
revoke all on function pulse.ai_router_learned() from public;

-- Approved patterns of the company, for its AI employees' runtimes.
create function pulse.ai_patterns_active() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', key, 'taskType', task_type, 'title', title, 'tools', pattern -> 'tools',
      'shape', pattern ->> 'shape', 'avgTokens', (pattern ->> 'avgTokens')::bigint, 'tier', pattern ->> 'tier') order by uses desc, key), '[]')
    from ai_heuristic where org_id = current_org() and state = 'active' and pattern is not null
$$;
revoke all on function pulse.ai_patterns_active() from public;

-- 0988's engine view, plus the company's router settings, what it learned, and the approved patterns.
create or replace function pulse.agent_engines_read() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); m agent_member; o agent_org_ai; today date := agent_org_today();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  select * into m from agent_member where person_id = me and org_id = current_org();
  if m.budget_restore is not null and (m.budget_restore->>'day')::date < today then
    update agent_member set daily_token_budget = (m.budget_restore->>'base')::int, budget_restore = null where person_id = me returning * into m;
  end if;
  select * into o from agent_org_ai where org_id = current_org();
  return jsonb_build_object('agent', to_jsonb(m.engines), 'org', to_jsonb(coalesce(o.engines, '{}')), 'budgets', coalesce(o.budgets, '{}'::jsonb),
    'orgDaily', o.daily_tokens,
    'orgUsedToday', (select coalesce(sum(coalesce(r.tokens, r.reserved)), 0) from agent_run r where r.org_id = current_org()
                      and (r.started_at at time zone org_time_zone())::date = today and r.state <> 'dispatching'),
    'connections', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'provider', c.provider, 'name', c.name, 'model', c.default_model,
        'state', c.state, 'until', c.state_until, 'cap', c.monthly_token_cap, 'used', ai_connection_used(c.id)) order by c.created_at)
      from ai_connection c where c.org_id = current_org() and c.removed_at is null), '[]'::jsonb),
    'grants', coalesce((select jsonb_agg(jsonb_build_object('eventId', g.event_id, 'day', g.day, 'extra', g.extra)) from agent_budget_grant g
      where g.agent_id = me and (g.day = today or (g.event_id is not null and g.granted_at > now() - interval '14 days'))), '[]'::jsonb),
    'router', coalesce(o.router, '{}'::jsonb) || jsonb_build_object('learned', ai_router_learned()),
    'patterns', ai_patterns_active());
end $$;

-- 4. -------------------------------------------------------------------------------------------------- promotion
-- Plain words for a kind of work (pattern titles).
create function pulse.ai_task_words(p_tt text) returns text language sql immutable as $$
  select case p_tt
    when 'task.daily' then 'daily task looks' when 'task.assigned' then 'newly assigned tasks' when 'task.mention' then 'tasks it was mentioned on'
    when 'task.comment' then 'task comments' when 'task.returned' then 'tasks sent back to it' when 'task.subtask' then 'sub-task changes'
    when 'chat.quote' then 'quotation chats' when 'chat.money' then 'invoice and payment chats' when 'chat.short' then 'short chat messages'
    when 'chat.ask' then 'chat questions' else replace(p_tt, '.', ' ') end
$$;

-- Work done the same way again and again becomes a candidate (evidence refreshed on every scan; a reviewed state stays).
create function pulse.ai_pattern_scan(p_days int) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_days int := least(greatest(coalesce(p_days, 14), 3), 60); r record; v_key text; v_new boolean; n_new int := 0; n_seen int := 0;
begin
  if agent_session() is null and (current_viewer() is null or not viewer_is('admin', 'leadership')) then
    raise exception 'AI employees and leadership look for repeated work' using errcode = '42501'; end if;
  for r in
    select tt, seq, shape, count(*) n, count(distinct agent_id) agents, round(avg(tok)) avg_tok, mode() within group (order by tier) tier,
           min(started_at) since, max(started_at) last_at
      from (select ai_event_task_type(x.event_id) tt, coalesce(array_to_string(x.tools_used, '>'), '') seq, coalesce(x.answer_shape, '') shape, x.agent_id,
                   coalesce(nullif(coalesce(x.tokens_in, 0) + coalesce(x.tokens_out, 0), 0), x.tokens, 0) tok, coalesce(x.engine_tier, 'strong') tier, x.started_at
              from agent_run x
             where x.org_id = current_org() and x.state = 'done' and x.escalated_from is null and x.fallback_from is null
               and x.started_at > now() - make_interval(days => v_days) and (x.tools_used is not null or x.answer_shape is not null)) y
     where tt is not null and (seq <> '' or shape <> '')
     group by tt, seq, shape having count(*) >= 5
  loop
    v_key := 'pattern:' || r.tt || ':' || left(md5(r.seq || '|' || r.shape), 10);
    insert into ai_heuristic(org_id, key, task_type, kind, state, title, pattern)
    values (current_org(), v_key, r.tt, 'rule', 'candidate',
      left(case when r.seq <> '' then 'Same steps for ' || ai_task_words(r.tt) || ': ' || replace(r.seq, '>', ' → ')
                else 'Same kind of answer for ' || ai_task_words(r.tt) || ' (' || r.shape || ')' end, 200),
      jsonb_build_object('tools', case when r.seq <> '' then to_jsonb(string_to_array(r.seq, '>')) else '[]'::jsonb end, 'shape', nullif(r.shape, ''),
        'runs', r.n, 'agents', r.agents, 'avgTokens', r.avg_tok, 'tier', r.tier, 'since', r.since, 'last', r.last_at, 'days', v_days))
    on conflict (org_id, key) do update set pattern = excluded.pattern
    returning (xmax = 0) into v_new;
    if v_new then n_new := n_new + 1; else n_seen := n_seen + 1; end if;
  end loop;
  return jsonb_build_object('new', n_new, 'seen', n_seen);
end $$;
revoke all on function pulse.ai_pattern_scan(int) from public;
grant execute on function pulse.ai_pattern_scan(int) to pulse_api;

-- An admin approves a candidate with ai_heuristic_set (2270): it keeps the row's own kind of work (2270 made one from the
-- key, and "pattern:task.daily:…" is not a kind of work). Same patch pattern as 2231: the live text is edited, and the
-- migration stops if upstream changed the line.
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.ai_heuristic_set(text,boolean,text)'::regprocedure); was := src;
  src := replace(src, $q$values (current_org(), v_key, split_part(v_key, '.', 1),$q$,
    $q$values (current_org(), v_key, coalesce((select h.task_type from ai_heuristic h where h.org_id = current_org() and h.key = v_key), split_part(v_key, '.', 1)),$q$);
  if src = was then raise exception 'ai_heuristic_set changed upstream: update 2280'; end if;
  execute src;
end $$;

-- 5. -------------------------------------------------------------------------------------------------- the report
-- Read as the caller (row security keeps it inside the company); the API checks leadership.
create function pulse.ai_router_report(p_days int) returns jsonb language plpgsql stable set search_path = pulse, pg_temp as $$
declare v_days int := least(greatest(coalesce(p_days, 30), 1), 120); v_zone text := org_time_zone(); v_since timestamptz; v jsonb;
begin
  v_since := date_trunc('day', now() at time zone v_zone) at time zone v_zone - make_interval(days => v_days - 1);
  with runs as (
    select (r.started_at at time zone v_zone)::date d, r.route_class cls, r.engine_tier tier, r.escalated_from esc, r.engine,
           ai_event_task_type(r.event_id) tt, coalesce(r.tokens_in, r.tokens, 0) tin, coalesce(r.tokens_out, 0) tout,
           coalesce(nullif(coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0), 0), r.tokens, 0) tok,
           coalesce(r.engine, '') ~* '(opus|fable|mythos|astra)' strongest
      from agent_run r where r.started_at >= v_since and r.state in ('done', 'error')
  )
  select jsonb_build_object('days', v_days,
    'classes', (select coalesce(jsonb_agg(jsonb_build_object('class', coalesce(cls, 'unrouted'), 'runs', n, 'strongest', s, 'strong', st, 'escalated', e,
        'tokens', tk, 'inr', inr) order by n desc), '[]') from (
        select cls, count(*) n, count(*) filter (where strongest) s, count(*) filter (where tier = 'strong') st, count(*) filter (where esc is not null) e,
               sum(tok) tk, sum(ai_price_inr(engine, tin, tout)) inr from runs group by cls) c),
    'weeks', (select coalesce(jsonb_agg(jsonb_build_object('week', w, 'runs', n, 'strongest', s, 'routed', rt, 'inr', inr) order by w), '[]') from (
        select to_char(date_trunc('week', d), 'YYYY-MM-DD') w, count(*) n, count(*) filter (where strongest) s, count(*) filter (where cls is not null) rt,
               sum(ai_price_inr(engine, tin, tout)) inr from runs group by 1) k),
    'types', (select coalesce(jsonb_agg(jsonb_build_object('taskType', tt, 'words', ai_task_words(tt), 'runs', n, 'strongest', s, 'tokens', tk, 'inr', inr,
        'inrPerRun', case when n > 0 and inr is not null then round(inr / n, 2) end) order by inr desc nulls last), '[]') from (
        select tt, count(*) n, count(*) filter (where strongest) s, sum(tok) tk, sum(ai_price_inr(engine, tin, tout)) inr from runs where tt is not null group by tt) t),
    'patterns', (select coalesce(jsonb_agg(jsonb_build_object('key', h.key, 'taskType', h.task_type, 'title', h.title, 'state', h.state, 'uses', h.uses,
        'saved', h.saved, 'evidence', h.pattern) order by h.state = 'candidate' desc, (h.pattern ->> 'runs')::int desc nulls last), '[]')
        from ai_heuristic h where h.pattern is not null and h.state <> 'retired'),
    'priced', exists (select 1 from runs where ai_price_inr(engine, tin, tout) is not null))
  into v;
  return v;
end $$;
revoke all on function pulse.ai_router_report(int) from public;
grant execute on function pulse.ai_router_report(int) to pulse_api;

-- migrate:down
-- Forward-only (the rupee budgets, the router's trace and the patterns are data people set and review).
