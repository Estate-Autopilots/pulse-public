-- migrate:up
-- TOKENS-TELEMETRY (owner, 17 Nov 2026: "1 million tokens is not enough for anything ... we spend a lot of tokens on very
-- small tasks. Reuse, repurpose, learn, so each time it gets cheaper and cheaper.")
--
-- The production audit (read-only, every AI run since 21 Oct: 253 runs, 6.26M tokens, 4 companies) found that the
-- biggest single waste is the **daily look**: every open task of an AI employee was handed to the model once a day at
-- ~27k tokens a look, even when nothing had happened on it since its last look. 105 daily looks = 2.89M tokens (46% of
-- all AI tokens); 104 of them had nothing new (no comment, task change or sub-task move by anyone else since the AI's
-- previous run on the task), and 16 were on tasks the AI had already handed to its reviewer. Replaying the real history
-- under the rules below keeps 27 of the 105 looks and saves 2.1M tokens (34% of everything).
--
-- 1. pulse.ai_decision: the decision trace for what an AI employee did WITHOUT a model call: a typed rule, a learned skill
--    (FIN-AGENT's agent_skill) or a look it skipped. Model runs are already traced one row each in agent_run (tokens,
--    engine, outcome); ai_task_type() gives both the same task types, so cost per task type reads both.
-- 2. pulse.ai_heuristic: the rules registry per company (key, task type, active/retired, uses, tokens saved). Built-in
--    rules are on until an admin retires one (ai_heuristic_set, audited).
-- 3. agent_tasks_daily(): the daily look keeps its old filters (open, idle 20 h, nothing queued, 10 a call) and two rules:
--    - task.with_reviewer: no look while the AI has handed the task to its reviewer (a person moves it next);
--    - task.quiet: nothing new since the last look -> look again after 1, 2 and 4 more days (it reminds whom it waits
--      for at most three times), then not until something happens on the task. Anything new resets it.
--    Each skipped look writes one decision a task a day, with the tokens the agent's usual task look costs.
-- 4. ai_cost_report(days): cost per task type per day (model runs, rule/skill decisions, tokens, rupees where a price is
--    set, tokens saved), per AI employee against its daily budget (today, p90 day, a suggested budget, the 80% warning)
--    and the work waiting for budget, so nothing fails silently. Read under row security (the API checks leadership).
-- 5. ai_decision_note(p): an AI employee's runtime (or FIN-AGENT's skill runner) records a decision.

create table pulse.ai_decision (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  agent_id uuid references pulse.agent_member(person_id),
  run_id uuid references pulse.agent_run(id),
  task_type text not null check (task_type ~ '^[a-z][a-z0-9_.-]{0,59}$'),
  route text not null check (route in ('rule', 'skill', 'skip', 'cache')),
  rule_key text not null check (rule_key ~ '^[a-z][a-z0-9_:.@/-]{0,119}$'),
  tokens bigint not null default 0 check (tokens >= 0 and tokens <= 100000000),
  saved_est bigint not null default 0 check (saved_est >= 0 and saved_est <= 100000000),
  outcome text not null default 'done' check (outcome in ('done', 'error', 'skipped')),
  subject_id uuid,
  dedupe text check (length(dedupe) <= 200),
  at timestamptz not null default now()
);
create unique index ai_decision_dedupe on pulse.ai_decision (org_id, dedupe) where dedupe is not null;
create index ai_decision_day on pulse.ai_decision (org_id, at);

create table pulse.ai_heuristic (
  org_id uuid not null references pulse.org(id),
  key text not null check (key ~ '^[a-z][a-z0-9_:.@/-]{0,119}$'),
  task_type text not null check (task_type ~ '^[a-z][a-z0-9_.-]{0,59}$'),
  kind text not null default 'rule' check (kind in ('rule', 'skill', 'memory')),
  state text not null default 'active' check (state in ('candidate', 'active', 'retired')),
  title text not null check (length(title) between 1 and 200),
  uses bigint not null default 0 check (uses >= 0),
  saved bigint not null default 0 check (saved >= 0),
  first_at timestamptz not null default now(),
  last_at timestamptz,
  changed_by uuid references pulse.person(id),
  changed_at timestamptz,
  note text check (length(note) <= 300),
  primary key (org_id, key)
);

do $$
declare t text;
begin
  foreach t in array array['pulse.ai_decision', 'pulse.ai_heuristic'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  end loop;
end $$;
grant select on pulse.ai_decision, pulse.ai_heuristic to pulse_api;

-- The built-in rules: what each one does, in plain words (the dashboard shows these).
create function pulse.ai_rule_title(p_key text) returns text language sql immutable as $$
  select case p_key
    when 'task.with_reviewer' then 'No daily look while the task is with its reviewer'
    when 'task.quiet' then 'Quiet task: look again after 1, 2 and 4 days, then only when something happens'
    when 'chat.screen_direct' then 'Plain screen requests ("open Finance") done without a model'
    when 'chat.memory_intent' then 'Remember, recall and forget asks done without a model'
    when 'chat.fold_newer' then 'Messages sent in a row answered once'
    when 'chat.small_model' then 'Greetings and short asks on the smallest model'
    else p_key end
$$;

-- What kind of work a run (or a decision) was: the same names for model runs and rules, so cost per task type adds up.
create function pulse.ai_task_type(p_event_type text, p_subject_type text, p_event_key text, p_body text) returns text
  language sql immutable as $$
  select case
    when p_subject_type = 'task' then 'task.' || case when p_event_type = 'task.assigned' then 'assigned'
      when coalesce(split_part(p_event_key, ':', 3), '') ~ '^(daily|comment|returned|subtask|direct|continue|mention)$' then split_part(p_event_key, ':', 3)
      when p_event_type = 'task.mention' then 'mention' else 'look' end
    when p_body is null then 'chat.other'
    when p_body ~* '(quot|estimate|कोटेशन|क्वोटेशन|दरपत्रक|अंदाजपत्रक|एस्टिमेट|kotation)' then 'chat.quote'
    when p_body ~* '(invoice|payment|bill|gst|बिल|पेमेंट)' then 'chat.money'
    when length(btrim(p_body)) <= 40 then 'chat.short'
    else 'chat.ask' end
$$;

-- A run's task type from its event (reads the asking message's words to type it; returns only the type).
create function pulse.ai_event_task_type(p_event uuid) returns text language sql stable security definer set search_path = pulse, pg_temp as $$
  select ai_task_type(e.event_type, e.subject_type, e.event_key,
           case when e.subject_type = 'message' then (select m.body from chat_message m where m.id = e.subject_id and m.org_id = e.org_id) end)
    from agent_event e where e.id = p_event and e.org_id = current_org()
$$;
revoke all on function pulse.ai_event_task_type(uuid) from public;
grant execute on function pulse.ai_event_task_type(uuid) to pulse_api;

-- Whether a built-in rule is on for the current company (on unless an admin retired it).
create function pulse.ai_rule_on(p_key text) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select not exists (select 1 from ai_heuristic where org_id = current_org() and key = p_key and state = 'retired')
$$;

-- One decision, once (dedupe), and the rule's running count. Internal: callers check who they are.
create function pulse.ai_decision_add(p_agent uuid, p_task_type text, p_route text, p_rule text, p_subject uuid, p_dedupe text,
  p_saved bigint, p_tokens bigint default 0, p_outcome text default 'done', p_run uuid default null) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_id uuid;
begin
  insert into ai_decision(org_id, agent_id, run_id, task_type, route, rule_key, tokens, saved_est, outcome, subject_id, dedupe)
  values (current_org(), p_agent, p_run, p_task_type, p_route, p_rule, greatest(coalesce(p_tokens, 0), 0), greatest(coalesce(p_saved, 0), 0),
          coalesce(p_outcome, 'done'), p_subject, p_dedupe)
  on conflict (org_id, dedupe) where dedupe is not null do nothing returning id into v_id;
  if v_id is not null then
    insert into ai_heuristic(org_id, key, task_type, kind, title, uses, saved, last_at)
    values (current_org(), p_rule, p_task_type, case when p_route = 'skill' then 'skill' else 'rule' end, left(ai_rule_title(p_rule), 200), 1, greatest(coalesce(p_saved, 0), 0), now())
    on conflict (org_id, key) do update set uses = ai_heuristic.uses + 1, saved = ai_heuristic.saved + excluded.saved, last_at = now();
  end if;
  return v_id;
end $$;
revoke all on function pulse.ai_decision_add(uuid, text, text, text, uuid, text, bigint, bigint, text, uuid) from public;

-- An AI employee's runtime records what it did without a model call (or a skill run): its own session only.
-- p: { taskType, route: rule|skill|skip|cache, ruleKey, tokens?, savedEst?, outcome?, runId?, subjectId?, dedupe? }
create function pulse.ai_decision_note(p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); v_tt text := btrim(coalesce(p ->> 'taskType', '')); v_route text := coalesce(p ->> 'route', 'rule');
  v_rule text := btrim(coalesce(p ->> 'ruleKey', '')); v_run uuid; v_id uuid; v_saved bigint; v_tokens bigint;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  if v_tt !~ '^[a-z][a-z0-9_.-]{0,59}$' then raise exception 'Name the kind of work (taskType)' using errcode = '22023'; end if;
  if v_route not in ('rule', 'skill', 'skip', 'cache') then raise exception 'route is rule, skill, skip or cache' using errcode = '22023'; end if;
  if v_rule !~ '^[a-z][a-z0-9_:.@/-]{0,119}$' then raise exception 'Name the rule or skill (ruleKey)' using errcode = '22023'; end if;
  if coalesce(p ->> 'runId', '') ~ '^[0-9a-f-]{36}$' then
    select id into v_run from agent_run where id = (p ->> 'runId')::uuid and agent_id = me;
  end if;
  v_saved := case when coalesce(p ->> 'savedEst', '') ~ '^\d{1,9}$' then (p ->> 'savedEst')::bigint else 0 end;
  v_tokens := case when coalesce(p ->> 'tokens', '') ~ '^\d{1,9}$' then (p ->> 'tokens')::bigint else 0 end;
  v_id := ai_decision_add(me, v_tt, v_route, v_rule,
    case when coalesce(p ->> 'subjectId', '') ~ '^[0-9a-f-]{36}$' then (p ->> 'subjectId')::uuid end,
    nullif(left(btrim(coalesce(p ->> 'dedupe', '')), 200), ''), v_saved, v_tokens,
    case when p ->> 'outcome' in ('done', 'error', 'skipped') then p ->> 'outcome' else 'done' end, v_run);
  return jsonb_build_object('id', v_id, 'recorded', v_id is not null);
end $$;
revoke all on function pulse.ai_decision_note(jsonb) from public;
grant execute on function pulse.ai_decision_note(jsonb) to pulse_api;

-- An admin turns a rule off (or back on). Audited.
create function pulse.ai_heuristic_set(p_key text, p_on boolean, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_key text := btrim(coalesce(p_key, ''));
begin
  if not exists (select 1 from role_assignment ra where ra.org_id = current_org() and ra.person_id = current_viewer() and ra.role_key = 'admin'
                   and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')) then
    raise exception 'Only an admin can turn an AI rule on or off' using errcode = '42501'; end if;
  if v_key !~ '^[a-z][a-z0-9_:.@/-]{0,119}$' then raise exception 'Choose a rule' using errcode = '22023'; end if;
  insert into ai_heuristic(org_id, key, task_type, title, state, changed_by, changed_at, note)
  values (current_org(), v_key, split_part(v_key, '.', 1), left(ai_rule_title(v_key), 200), case when p_on then 'active' else 'retired' end, current_viewer(), now(), left(nullif(btrim(coalesce(p_note, '')), ''), 300))
  on conflict (org_id, key) do update set state = excluded.state, changed_by = excluded.changed_by, changed_at = now(), note = excluded.note;
  insert into audit_event(org_id, actor_id, action, resource, resource_id, fields, changes)
  values (current_org(), current_viewer(), case when p_on then 'ai_rule.on' else 'ai_rule.off' end, 'ai_heuristic', v_key, array['state'],
          jsonb_build_object('state', case when p_on then 'active' else 'retired' end, 'note', p_note));
  return jsonb_build_object('key', v_key, 'state', case when p_on then 'active' else 'retired' end);
end $$;
revoke all on function pulse.ai_heuristic_set(text, boolean, text) from public;
grant execute on function pulse.ai_heuristic_set(text, boolean, text) to pulse_api;

-- The daily look, with the two rules. Same signature, owner and grants as 1064's.
create or replace function pulse.agent_tasks_daily() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r record; n int := 0; held int := 0; d date := (now() at time zone org_time_zone())::date; est bigint;
  review_on boolean := ai_rule_on('task.with_reviewer'); quiet_on boolean := ai_rule_on('task.quiet');
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if extract(hour from now() at time zone org_time_zone()) < 9 then return jsonb_build_object('queued', 0, 'why', 'before working hours'); end if;
  -- What one of its task looks usually costs (the last 14 days), for the tokens a skipped look saves.
  select coalesce(percentile_cont(0.5) within group (order by coalesce(nullif(coalesce(ar.tokens_in, 0) + coalesce(ar.tokens_out, 0), 0), ar.tokens)), 25000)::bigint into est
    from agent_run ar join agent_event ae on ae.id = ar.event_id
   where ar.agent_id = me and ae.subject_type = 'task' and ar.state = 'done' and ar.started_at > now() - interval '14 days'
     and coalesce(nullif(coalesce(ar.tokens_in, 0) + coalesce(ar.tokens_out, 0), 0), ar.tokens) > 100;
  for r in
    with due as (
      select t.id, t.priority, t.due_at, t.created_at, w.phase, coalesce(w.updated_at, t.updated_at, t.created_at) looked
        from task t left join agent_task_work w on w.task_id = t.id
       where t.org_id = current_org() and t.assignee_person_id = me and t.deleted_at is null and t.status in ('open','in_progress','blocked')
         and coalesce(w.updated_at, t.updated_at, t.created_at) < now() - interval '20 hours'
         and not exists(select 1 from agent_event e where e.agent_id = me and e.subject_type = 'task' and e.subject_id = t.id and e.state in ('queued','leased','dispatching'))
    ), seen as (
      select due.*, q.quiet from due cross join lateral (
        select count(*) quiet from agent_event e
         where e.agent_id = me and e.subject_type = 'task' and e.subject_id = due.id and e.event_key like 'task:%:daily:%' and e.run_id is not null
           and e.created_at > coalesce(greatest(
             (select max(c.created_at) from work_comment c where c.task_id = due.id and c.author_id <> me and c.removed_at is null),
             (select max(te.at) from task_event te where te.task_id = due.id and te.actor_id is distinct from me),
             (select max(te.at) from task_event te join task s on s.id = te.task_id where s.parent_id = due.id)), '-infinity')) q
    )
    select seen.*, case
        when review_on and seen.phase = 'in_review' then 'task.with_reviewer'
        when quiet_on and seen.quiet >= 3 then 'task.quiet'
        when quiet_on and seen.quiet > 0 and seen.looked > now() - (interval '1 day' * power(2, seen.quiet) - interval '4 hours') then 'task.quiet'
      end rule
      from seen
     order by case seen.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, seen.due_at nulls last, seen.created_at
  loop
    if r.rule is not null then
      if ai_decision_add(me, 'task.daily', 'skip', r.rule, r.id, 'daily:' || r.id || ':' || d, est) is not null then held := held + 1; end if;
      continue;
    end if;
    exit when n >= 10;
    insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
    values (current_org(), me, 'task.mention', 'task', r.id, 'task:' || r.id || ':daily:' || d, me) on conflict do nothing;
    if found then n := n + 1; end if;
  end loop;
  return case when held > 0 then jsonb_build_object('queued', n, 'held', held) else jsonb_build_object('queued', n) end;
end $$;

-- Rupees for tokens on an engine (its price, else "*"; null when no price is set). Prices are platform admins'.
create function pulse.ai_price_inr(p_engine text, p_in numeric, p_out numeric) returns numeric
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select round((coalesce(p_in, 0) * pr.inr_per_m_in + coalesce(p_out, 0) * pr.inr_per_m_out) / 1000000.0, 2)
    from pulse_priv.platform_ai_price pr
   where pr.engine in (regexp_replace(coalesce(p_engine, ''), '^(server|runner):[^/]*/?', ''), coalesce(p_engine, ''), '*')
   order by pr.engine = '*', length(pr.engine) desc limit 1
$$;
revoke all on function pulse.ai_price_inr(text, numeric, numeric) from public;
grant execute on function pulse.ai_price_inr(text, numeric, numeric) to pulse_api;

-- The AI cost report (leadership; the API checks). Runs as the caller: row security keeps it inside the company.
create function pulse.ai_cost_report(p_days int) returns jsonb language plpgsql stable set search_path = pulse, pg_temp as $$
declare v_days int := least(greatest(coalesce(p_days, 30), 1), 120); v_since timestamptz; v_zone text := org_time_zone(); v jsonb;
begin
  v_since := date_trunc('day', now() at time zone v_zone) at time zone v_zone - make_interval(days => v_days - 1);
  with runs as (
    select r.id, r.agent_id, (r.started_at at time zone v_zone)::date d, r.state, r.error_code, r.engine, r.fallback_from is not null fell_back,
           ai_event_task_type(e.id) tt,
           coalesce(nullif(coalesce(r.tokens_in, 0) + coalesce(r.tokens_out, 0), 0), r.tokens, 0) tok,
           coalesce(r.tokens_in, r.tokens, 0) tin, coalesce(r.tokens_out, 0) tout, r.seconds, e.subject_id
      from agent_run r join agent_event e on e.id = r.event_id
     where r.started_at >= v_since
       and not exists (select 1 from ai_decision x where x.run_id = r.id)   -- done by a rule: counted once, below
  ), dec as (
    select x.agent_id, (x.at at time zone v_zone)::date d, x.task_type tt, x.route, x.rule_key, x.tokens, x.saved_est
      from ai_decision x where x.at >= v_since
  ), types as (
    select d, tt, count(*) runs, sum(tok) tokens, sum(tin) tin, sum(tout) tout, count(*) filter (where state <> 'done') failed,
           sum(ai_price_inr(engine, tin, tout)) inr, count(*) filter (where ai_price_inr(engine, tin, tout) is null and tok > 0) unpriced
      from runs group by d, tt
  ), dtypes as (
    select d, tt, count(*) ruled, sum(tokens) rtokens, sum(saved_est) saved from dec group by d, tt
  ), days as (
    select coalesce(t.d, x.d) d, coalesce(t.tt, x.tt) tt, coalesce(t.runs, 0) runs, coalesce(t.tokens, 0) tokens, coalesce(t.tin, 0) tin, coalesce(t.tout, 0) tout,
           coalesce(t.failed, 0) failed, t.inr, coalesce(t.unpriced, 0) unpriced, coalesce(x.ruled, 0) ruled, coalesce(x.rtokens, 0) rtokens, coalesce(x.saved, 0) saved
      from types t full join dtypes x on x.d = t.d and x.tt = t.tt
  ), today as (
    select agent_id, sum(tok) tok from runs where d = (now() at time zone v_zone)::date group by agent_id
  ), perday as (
    select agent_id, d, sum(tok) tok from runs group by agent_id, d
  ), agents as (
    select am.person_id id, p.display_name name, am.title, am.daily_token_budget budget, am.provider, am.disabled_at is not null paused,
           coalesce((select tok from today where today.agent_id = am.person_id), 0) today,
           (select percentile_cont(0.9) within group (order by tok) from perday where perday.agent_id = am.person_id) p90,
           (select count(*) from runs where runs.agent_id = am.person_id) runs,
           (select coalesce(sum(tok), 0) from runs where runs.agent_id = am.person_id) tokens,
           (select sum(ai_price_inr(engine, tin, tout)) from runs where runs.agent_id = am.person_id) inr,
           (select count(*) from runs where runs.agent_id = am.person_id and runs.state <> 'done') failed,
           (select count(*) from dec where dec.agent_id = am.person_id) ruled,
           (select coalesce(sum(saved_est), 0) from dec where dec.agent_id = am.person_id) saved,
           (select count(*) from agent_event e where e.agent_id = am.person_id and e.state = 'failed' and e.reason = 'budget_spent' and e.created_at >= v_since) waited
      from agent_member am join person p on p.id = am.person_id
  ), waste as (
    select 'failed' k, count(*) n, coalesce(sum(tok), 0) tokens from runs where state <> 'done'
    union all select 'fallback', count(*), coalesce(sum(tok), 0) from runs where fell_back
    union all select 'repeat', count(*), coalesce(sum(tok), 0) from (select tok, row_number() over (partition by agent_id, subject_id order by d) rn from runs where tt like 'task.%') z where rn > 1
    union all select 'daily', count(*), coalesce(sum(tok), 0) from runs where tt = 'task.daily'
  )
  select jsonb_build_object(
    'days', v_days, 'since', (v_since at time zone v_zone)::date, 'zone', v_zone,
    'byDay', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'type', tt, 'runs', runs, 'tokens', tokens, 'tokensIn', tin, 'tokensOut', tout,
        'failed', failed, 'inr', inr, 'unpriced', unpriced, 'ruled', ruled, 'ruledTokens', rtokens, 'saved', saved) order by d, tt) from days), '[]'::jsonb),
    'agents', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'title', title, 'budget', budget, 'provider', provider, 'paused', paused,
        'today', today, 'p90Day', round(coalesce(p90, 0)), 'runs', runs, 'tokens', tokens, 'inr', inr, 'failed', failed, 'ruled', ruled, 'saved', saved,
        'waitedForBudget', waited, 'warn', budget > 0 and today >= budget * 0.8,
        -- A budget that fits its real days: its 1-in-10 busiest day with half again as room, in steps of 50,000 (100,000 at least).
        'suggested', greatest(100000, ceil(coalesce(p90, 0) * 1.5 / 50000.0) * 50000)) order by tokens desc) from agents where runs > 0 or budget is not null), '[]'::jsonb),
    'waste', coalesce((select jsonb_object_agg(k, jsonb_build_object('runs', n, 'tokens', tokens)) from waste), '{}'::jsonb),
    'rules', coalesce((select jsonb_agg(jsonb_build_object('key', h.key, 'title', h.title, 'type', h.task_type, 'kind', h.kind, 'state', h.state, 'uses', h.uses, 'saved', h.saved, 'lastAt', h.last_at) order by h.saved desc) from ai_heuristic h), '[]'::jsonb),
    'priced', exists (select 1 from runs where ai_price_inr(engine, tin, tout) is not null))
  into v;
  return v;
end $$;
revoke all on function pulse.ai_cost_report(int) from public;
grant execute on function pulse.ai_cost_report(int) to pulse_api;

-- migrate:down
-- Additive; agent_tasks_daily goes back to 1064's text by re-running that function from 1064.
