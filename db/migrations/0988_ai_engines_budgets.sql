-- migrate:up
-- FEATURES-1024 (owner, 24 Oct 2026: "AI employees behave stupidly when their preferred subscription is out of quota ...
-- and some runs burn 500k to several million tokens"). The runtime (services/coworker) now routes each run to the first
-- engine of a chain that is healthy and has quota, falls back once mid-run, and keeps every run inside a budget. This
-- holds what it needs from Pulse:
--   agent_member.engines        the AI employee's own ordered engine chain (empty: its organisation's, else the default)
--   agent_org_ai                the organisation's default chain, run budgets by kind of work, and a daily token cap
--   agent_run.engine ...        which engine actually ran (and which it fell back from), tokens in and out
--   agent_budget_grant          extra budget a manager allowed ("needs more budget": one tap on the card, or "ok")
--   agent_proposal kind budget  that card, in the manager's direct message with the AI employee
-- Engines are named "server:claude", "server:codex" (this server's subscriptions), "connection:<id>" (an AI connection
-- of the organisation, Settings -> AI), "env:anthropic|openai|openrouter" (a key the runtime holds, from Infisical) and
-- "local:ollama". Only objects from this repository's migrations are used; agent_proposal_decide is 0965's with one
-- branch added. Additive.

alter table pulse.agent_member add column engines text[] not null default '{}'
  check (cardinality(engines) <= 12 and array_to_string(engines, ',') ~ '^((server:(claude|codex)|connection:[0-9a-f-]{36}|env:(anthropic|openai|openrouter)|local:ollama)(,|$))*$');
-- Today's allowance raised by an approval: {base, day} restores it the next day (agent_engines_read).
alter table pulse.agent_member add column budget_restore jsonb check (budget_restore is null or jsonb_typeof(budget_restore) = 'object');

alter table pulse.agent_run add column engine text check (length(engine) <= 80);
alter table pulse.agent_run add column engine_tier text check (engine_tier in ('fast','strong'));
alter table pulse.agent_run add column tokens_in bigint check (tokens_in >= 0);
alter table pulse.agent_run add column tokens_out bigint check (tokens_out >= 0);
alter table pulse.agent_run add column fallback_from text check (length(fallback_from) <= 300);
alter table pulse.agent_run drop constraint agent_run_error_code_check;
alter table pulse.agent_run add constraint agent_run_error_code_check check (error_code in ('model_error','no_answer','stuck','out_of_quota','needs_budget','runaway'));

alter table pulse.agent_proposal drop constraint agent_proposal_kind_check;
alter table pulse.agent_proposal add constraint agent_proposal_kind_check check (kind in ('reply','task','summary','budget'));

create table pulse.agent_org_ai (
  org_id uuid primary key references pulse.org(id),
  engines text[] not null default '{}'
    check (cardinality(engines) <= 12 and array_to_string(engines, ',') ~ '^((server:(claude|codex)|connection:[0-9a-f-]{36}|env:(anthropic|openai|openrouter)|local:ollama)(,|$))*$'),
  -- {"chat": {"in": 30000, "out": 4000, "tier": "fast"}, "task": {"in": 300000, "out": 40000, "tier": "strong"}}
  budgets jsonb not null default '{}' check (jsonb_typeof(budgets) = 'object' and length(budgets::text) <= 4000),
  daily_tokens bigint check (daily_tokens between 1000 and 1000000000),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);
create table pulse.agent_budget_grant (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references pulse.agent_member(person_id),
  event_id uuid references pulse.agent_event(id),
  day date,
  extra bigint not null check (extra between 1 and 100000000),
  proposal_id uuid references pulse.agent_proposal(id),
  granted_by uuid references pulse.person(id),
  granted_at timestamptz not null default now(),
  check (event_id is not null or day is not null)
);
create index agent_budget_grant_event on pulse.agent_budget_grant (org_id, event_id);
do $$
declare t text;
begin
  foreach t in array array['agent_org_ai','agent_budget_grant'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select on pulse.%I to pulse_api', t);
  end loop;
end $$;

-- The organisation's company day (its own zone).
create function pulse.agent_org_today() returns date language sql stable security definer set search_path = pulse, pg_temp as $$
  select (now() at time zone org_time_zone())::date
$$;

-- What the runtime reads before a run (the AI employee's own session): its chain, its organisation's chain, budgets and
-- daily cap with what was used today, and the organisation's AI connections (never a secret). Today's raised allowance
-- goes back to its usual amount once the day has passed.
create function pulse.agent_engines_read() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
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
      where g.agent_id = me and (g.day = today or (g.event_id is not null and g.granted_at > now() - interval '14 days'))), '[]'::jsonb));
end $$;

-- Inside its live run: one of its organisation's connections to fall back to (CONNECT-AI's handover, for a chosen one).
create function pulse.agent_run_connection_pick(p_run uuid, p_connection uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); r agent_run; m agent_member; c ai_connection; w ai_workspace; used bigint;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Ask inside the run' using errcode = '42501'; end if;
  select * into m from agent_member where person_id = me;
  select * into c from ai_connection where id = p_connection and org_id = current_org() and removed_at is null;
  if not found then return jsonb_build_object('status', 'missing'); end if;
  if m.ai_workspace_id is not null then select * into w from ai_workspace where id = m.ai_workspace_id and org_id = current_org() and removed_at is null; end if;
  used := ai_connection_used(c.id);
  if c.monthly_token_cap is not null and used >= c.monthly_token_cap then
    return jsonb_build_object('status', 'cap', 'used', used, 'cap', c.monthly_token_cap, 'until', date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' + interval '1 month');
  end if;
  update agent_run set connection_id = c.id where id = r.id;
  return jsonb_build_object('status', 'ok', 'connection', jsonb_build_object('id', c.id, 'kind', c.kind, 'provider', c.provider, 'baseUrl', c.base_url,
      'model', c.default_model, 'keyId', c.secret_key_id, 'wrapped', encode(c.secret_wrapped, 'base64'), 'sealed', encode(c.secret_sealed, 'base64'),
      'cap', c.monthly_token_cap, 'used', used),
    'workspace', case when w.id is null or c.kind = 'api' then null else jsonb_build_object('id', w.id, 'host', w.host, 'port', w.port, 'username', w.username, 'hostKey', w.host_key,
      'keyId', w.key_id, 'keyWrapped', encode(w.key_wrapped, 'base64'), 'keySealed', encode(w.key_sealed, 'base64')) end);
end $$;

-- Which engine ran its run (and which it fell back from), at which tier, with tokens in and out.
create function pulse.agent_run_engine(p_run uuid, p jsonb) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  update agent_run set engine = left(nullif(p->>'engine', ''), 80), engine_tier = case when p->>'tier' in ('fast','strong') then p->>'tier' end,
    tokens_in = case when (p->>'tokensIn') ~ '^\d{1,12}$' then (p->>'tokensIn')::bigint end, tokens_out = case when (p->>'tokensOut') ~ '^\d{1,12}$' then (p->>'tokensOut')::bigint end,
    fallback_from = left(nullif(p->>'fallbackFrom', ''), 300)
   where id = p_run and org_id = current_org() and agent_id = me and started_at > now() - interval '1 day';
  if not found then raise exception 'That run is not yours' using errcode = '42501'; end if;
end $$;

-- "Needs more budget": the AI employee asks its manager (or approver) with why and an estimate, in their direct
-- message, as a card (Allow it / Don't, or a reply "ok"). For one piece of work (scope run: the run closes at no
-- cost and the work waits for the answer) or for today (scope day: its daily allowance is spent). One open ask at a time
-- for the same work or day.
create function pulse.agent_budget_ask(p_run uuid, p jsonb, p_client uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); m agent_member; r agent_run; ap uuid; dm uuid; k text; pid uuid; mid uuid; scope text := coalesce(p->>'scope', 'run');
  est bigint; why text := left(btrim(coalesce(p->>'why', '')), 900); today date := agent_org_today(); ev uuid; b text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  if scope not in ('run','day') then raise exception 'Ask for this work or for today' using errcode = '22023'; end if;
  if coalesce(p->>'estimate', '') !~ '^\d{3,9}$' then raise exception 'Give an estimate in tokens' using errcode = '22023'; end if;
  est := (p->>'estimate')::bigint;
  select * into m from agent_member where person_id = me and org_id = current_org();
  perform agent_lock(me);
  if scope = 'run' then
    select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' for update;
    if not found then raise exception 'Ask inside the run' using errcode = '42501'; end if;
    ev := r.event_id;
    select id into pid from agent_proposal where agent_id = me and kind = 'budget' and state = 'pending' and action->>'eventId' = ev::text;
    update agent_run set state = 'error', tokens = 0, seconds = 0, error_code = 'needs_budget', finished_at = now() where id = r.id;
    update agent_event set state = 'queued', retry_at = now() + interval '14 days', attempts = 0, reason = 'budget_spent', lease_token = null, lease_until = null where id = ev;
  else
    select id into pid from agent_proposal where agent_id = me and kind = 'budget' and state = 'pending' and action->>'scope' = 'day' and action->>'day' = today::text;
  end if;
  if pid is not null then return jsonb_build_object('id', pid, 'existing', true); end if;
  ap := coalesce(m.owner_person_id, m.approver_person_id);
  if ap is null then raise exception 'It has nobody to ask' using errcode = '22023'; end if;
  k := 'dm:' || least(me::text, ap::text) || ':' || greatest(me::text, ap::text);
  insert into chat_channel(org_id, key, name, kind, description) values (current_org(), k, 'Direct message', 'direct', 'A private conversation')
  on conflict (org_id, key) do update set key = excluded.key returning id into dm;
  insert into chat_member(org_id, channel_id, person_id) values (current_org(), dm, me), (current_org(), dm, ap) on conflict do nothing;
  b := case when scope = 'day' then 'Needs more budget today: about ' else 'Needs more budget for this work: about ' end || to_char(est, 'FM999,999,999') || ' tokens'
    || case when why <> '' then chr(10) || why else '' end;
  insert into agent_proposal(org_id, agent_id, run_id, channel_id, approver_id, dm_channel_id, kind, body, why, action)
  values (current_org(), me, case when scope = 'run' then r.id end, dm, ap, dm, 'budget', left(b, 4000), nullif(why, ''),
    jsonb_build_object('type', 'budget', 'scope', scope, 'eventId', ev, 'day', case when scope = 'day' then today end, 'estimate', est))
  returning id into pid;
  mid := chat_send(dm, b || chr(10) || 'Allow it, or Don''t (a reply like "ok" works too).', null, '[]'::jsonb, p_client, null);
  update agent_proposal set dm_message_id = mid where id = pid;
  return jsonb_build_object('id', pid, 'messageId', mid, 'chatId', dm);
end $$;

-- An allowed ask: the grant is kept; work waiting for it runs again now; today's allowance grows until the day ends.
create function pulse.agent_budget_grant_apply(pr pulse.agent_proposal, p_by uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare est bigint := (pr.action->>'estimate')::bigint; scope text := pr.action->>'scope'; ev uuid := nullif(pr.action->>'eventId', '')::uuid; today date := agent_org_today();
begin
  insert into agent_budget_grant(org_id, agent_id, event_id, day, extra, proposal_id, granted_by)
  values (pr.org_id, pr.agent_id, case when scope = 'run' then ev end, case when scope = 'day' then today end, est, pr.id, p_by);
  if scope = 'day' then
    update agent_member set budget_restore = coalesce(budget_restore, jsonb_build_object('base', daily_token_budget, 'day', today)),
      daily_token_budget = least(2000000, daily_token_budget + est::int), runtime_state = 'ready', runtime_until = null where person_id = pr.agent_id;
  elsif ev is not null then
    update agent_event set retry_at = now(), reason = null where id = ev and state = 'queued';
  end if;
end $$;

-- Leaders' and its managers' view of spend: per run (engine, tier, tokens in/out, state) and per day by engine.
create function pulse.agent_spend(p_agent uuid, p_days int default 14) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare d int := least(greatest(coalesce(p_days, 14), 1), 90);
begin
  if p_agent is null and not viewer_is('admin', 'leadership') then raise exception 'Leaders see the organisation''s AI spend' using errcode = '42501'; end if;
  if p_agent is not null and not agent_manage_ok(p_agent) then raise exception 'Not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'runs', coalesce((select jsonb_agg(x order by x->>'at' desc) from (select jsonb_build_object('id', r.id, 'agentId', r.agent_id, 'at', r.started_at, 'state', r.state,
        'errorCode', r.error_code, 'engine', coalesce(r.engine, nullif(r.model, '')), 'tier', r.engine_tier, 'fallbackFrom', r.fallback_from, 'tokens', r.tokens,
        'tokensIn', r.tokens_in, 'tokensOut', r.tokens_out, 'seconds', r.seconds, 'kind', e.subject_type) x
      from agent_run r join agent_event e on e.id = r.event_id
      where r.org_id = current_org() and (p_agent is null or r.agent_id = p_agent) and r.started_at > now() - make_interval(days => d)
      order by r.started_at desc limit 200) y), '[]'::jsonb),
    'days', coalesce((select jsonb_agg(jsonb_build_object('day', day, 'engine', engine, 'runs', n, 'tokens', t, 'tokensIn', ti, 'tokensOut', tt, 'fallbacks', fb, 'held', held) order by day desc, engine)
      from (select (r.started_at at time zone org_time_zone())::date as day, coalesce(r.engine, nullif(r.model, ''), 'unknown') as engine, count(*) n, coalesce(sum(r.tokens), 0) t,
              coalesce(sum(r.tokens_in), 0) ti, coalesce(sum(r.tokens_out), 0) tt, count(*) filter (where r.fallback_from is not null) fb,
              count(*) filter (where r.error_code in ('needs_budget','out_of_quota','runaway')) held
            from agent_run r where r.org_id = current_org() and (p_agent is null or r.agent_id = p_agent) and r.started_at > now() - make_interval(days => d)
            group by 1, 2) z), '[]'::jsonb));
end $$;

-- Its own chain (whoever may change it), and the organisation's default chain, budgets and daily cap (leaders).
create function pulse.agent_engines_set(p_agent uuid, p_engines text[]) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not agent_manage_ok(p_agent) then raise exception 'Not found' using errcode = 'P0002'; end if;
  update agent_member set engines = coalesce(p_engines, '{}') where person_id = p_agent and org_id = current_org();
  perform audit_write('update', 'agent_member', p_agent::text);
end $$;
create function pulse.agent_org_ai_save(p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o agent_org_ai;
begin
  if not viewer_is('admin', 'leadership') then raise exception 'Leaders set the organisation''s AI engines and budgets' using errcode = '42501'; end if;
  insert into agent_org_ai(org_id, engines, budgets, daily_tokens, updated_by)
  values (current_org(), coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(p->'engines', '[]'::jsonb)) x), '{}'),
    coalesce(p->'budgets', '{}'::jsonb), nullif(p->>'dailyTokens', '')::bigint, current_viewer())
  on conflict (org_id) do update set
    engines = case when p ? 'engines' then excluded.engines else agent_org_ai.engines end,
    budgets = case when p ? 'budgets' then excluded.budgets else agent_org_ai.budgets end,
    daily_tokens = case when p ? 'dailyTokens' then excluded.daily_tokens else agent_org_ai.daily_tokens end,
    updated_by = excluded.updated_by, updated_at = now()
  returning * into o;
  perform audit_write('update', 'agent_org_ai', current_org()::text);
  return jsonb_build_object('engines', to_jsonb(o.engines), 'budgets', o.budgets, 'dailyTokens', o.daily_tokens);
end $$;
create function pulse.agent_org_ai_read() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select jsonb_build_object('engines', to_jsonb(engines), 'budgets', budgets, 'dailyTokens', daily_tokens, 'updatedAt', updated_at)
    from agent_org_ai where org_id = current_org()), jsonb_build_object('engines', '[]'::jsonb, 'budgets', '{}'::jsonb, 'dailyTokens', null))
$$;

-- 0965's agent_proposal_decide with the budget branch (FEATURES-1024); everything else as it was.
create or replace function pulse.agent_proposal_decide(p_id uuid, p_action text, p_body text, p_via text default 'button') returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pr agent_proposal; me uuid := current_viewer(); b text; posted uuid; src chat_message; was text; tid uuid; v_title text; aname text;
begin
  if agent_session() is not null or me is null then raise exception 'A person decides' using errcode='42501'; end if;
  select * into pr from agent_proposal where id = p_id and org_id = current_org() for update;
  if not found or (pr.approver_id <> me and not agent_manage_ok(pr.agent_id)) then raise exception 'Not found' using errcode='P0002'; end if;
  if p_action is null or p_action not in ('send','dismiss') then raise exception 'Send it or don''t' using errcode='22023'; end if;
  if pr.state <> 'pending' then
    return jsonb_build_object('state', pr.state, 'postedMessageId', pr.posted_message_id, 'channelId', pr.channel_id, 'taskId', pr.task_id);
  end if;
  if p_action = 'dismiss' then
    update agent_proposal set state = 'dismissed', decided_by = me, decided_at = now(), decided_via = coalesce(p_via, 'button') where id = pr.id;
    return jsonb_build_object('state', 'dismissed', 'channelId', pr.channel_id);
  end if;
  -- FEATURES-1024 (0988): "needs more budget": allowing it grants the estimate (to that piece of work, or today) and the
  -- work runs again at once; nothing else changes.
  if pr.kind = 'budget' then
    perform agent_budget_grant_apply(pr, me);
    update agent_proposal set state = 'sent', decided_by = me, decided_at = now(), decided_via = coalesce(p_via, 'button') where id = pr.id;
    return jsonb_build_object('state', 'sent', 'channelId', pr.channel_id);
  end if;
  if not exists(select 1 from agent_member am join person p on p.id = am.person_id where am.person_id = pr.agent_id and am.disabled_at is null and p.status = 'active') then
    raise exception 'It is switched off' using errcode='22023'; end if;
  select * into src from chat_message where id = pr.source_message_id and removed_at is null;
  if pr.kind = 'task' then
    -- Edited: the first line is the task's title ("Task: " may stay).
    v_title := btrim(regexp_replace(split_part(coalesce(nullif(btrim(coalesce(p_body, '')), ''), ''), chr(10), 1), '^\s*Task:\s*', '', 'i'));
    v_title := coalesce(nullif(v_title, ''), pr.action->>'title');
    select display_name into aname from person where id = pr.agent_id;
    tid := task_save(null, jsonb_strip_nulls(jsonb_build_object('title', v_title, 'assigneeId', pr.action->>'assigneeId', 'dueOn', pr.action->>'dueOn', 'reviewerId', me,
      'notes', concat_ws(chr(10), pr.action->>'notes', 'Proposed by ' || aname || ' (AI employee); created by ' || (select display_name from person where id = me) || ' with Create it.'))));
    -- The task's card goes into the conversation it was asked in, from the person who created it (as Tasks does when a
    -- task is made from a chat message), never into a conversation with a client; the person it is for answers on it.
    if not chat_client_facing(pr.channel_id) and exists(select 1 from chat_member where channel_id = pr.channel_id and person_id = me) then
      posted := chat_send(pr.channel_id, '', null, jsonb_build_array(jsonb_build_object('task', tid::text, 'name', v_title, 'url', '/tasks/' || tid)), pr.id, src.id);
      begin
        perform chat_task_handshake_open(tid, pr.channel_id, posted, nullif(pr.action->>'assigneeId', '')::uuid);
      exception when others then null; -- the card stands without the take-it buttons
      end;
    end if;
    update agent_proposal set state = 'sent', sent_body = case when v_title <> pr.action->>'title' then 'Task: ' || v_title end, task_id = tid,
      decided_by = me, decided_at = now(), decided_via = coalesce(p_via, 'button'), posted_message_id = posted where id = pr.id;
    return jsonb_build_object('state', 'sent', 'taskId', tid, 'postedMessageId', posted, 'channelId', pr.channel_id);
  end if;
  b := btrim(coalesce(nullif(btrim(coalesce(p_body, '')), ''), pr.body));
  if length(b) > 4000 then raise exception 'Up to 4,000 characters' using errcode='22023'; end if;
  if not exists(select 1 from chat_member where channel_id = pr.channel_id and person_id = pr.agent_id) then
    raise exception 'It is no longer in that conversation or is switched off' using errcode='22023'; end if;
  -- Posted as the AI employee (its session for this one message), then back to the person who decided.
  was := coalesce(current_setting('pulse.agent_session', true), '');
  perform set_config('pulse.viewer_id', pr.agent_id::text, true);
  perform set_config('pulse.agent_session', 'on', true);
  perform set_config('pulse.agent_approved', pr.id::text, true);
  posted := chat_send(pr.channel_id, b, src.parent_id, '[]'::jsonb, pr.id, src.id);
  perform set_config('pulse.agent_approved', '', true);
  perform set_config('pulse.agent_session', was, true);
  perform set_config('pulse.viewer_id', me::text, true);
  update agent_proposal set state = 'sent', sent_body = b, decided_by = me, decided_at = now(), decided_via = coalesce(p_via, 'button'), posted_message_id = posted where id = pr.id;
  return jsonb_build_object('state', 'sent', 'postedMessageId', posted, 'channelId', pr.channel_id);
end $$;

revoke all on function pulse.agent_org_today(), pulse.agent_engines_read(), pulse.agent_run_connection_pick(uuid, uuid), pulse.agent_run_engine(uuid, jsonb),
  pulse.agent_budget_ask(uuid, jsonb, uuid), pulse.agent_budget_grant_apply(pulse.agent_proposal, uuid), pulse.agent_spend(uuid, int),
  pulse.agent_engines_set(uuid, text[]), pulse.agent_org_ai_save(jsonb), pulse.agent_org_ai_read() from public;
grant execute on function pulse.agent_engines_read(), pulse.agent_run_connection_pick(uuid, uuid), pulse.agent_run_engine(uuid, jsonb),
  pulse.agent_budget_ask(uuid, jsonb, uuid), pulse.agent_spend(uuid, int), pulse.agent_engines_set(uuid, text[]), pulse.agent_org_ai_save(jsonb),
  pulse.agent_org_ai_read() to pulse_api;

-- migrate:down
-- Forward-only.
