-- migrate:up
-- (Numbered 1003: it first landed as 0996, a number main had already given to 0996_hq_identity_links. Every statement
-- is create or replace, so a database that ran it as 0996 runs it again unchanged.)
-- AI-EMP (24 Oct 2026, owner: "AI employees function idiotically ... a pipeline must choose at least something to
-- respond"): what production's AI employees did wrong, fixed where a run starts and where it ends. Both functions are
-- written out in full: the live definitions (identical on dev and production, md5 5d0fe34b… and 14ca0077…), with the
-- changes below; nothing is patched from the database's own text.
--
-- agent_dispatch
--  1. A direct message from the person who approves this AI is answered directly. On production the Operations
--     Chief answered its owner's "?" by sending that same owner, in that same chat, a card "Savuzo wrote in a direct
--     message: '?' I have not answered there. This is what I would post: Send it / Edit / Don't".
--  2. "newer": a later message of the same conversation already waits for it, so this one is folded into that answer.
--     When the quota came back, three waiting messages ("?", "Hey", "Hello!??") got three near-identical proposals.
--  3. Its conversation leaves out messages with no words (cards) and its own proposal cards, which it read back as
--     things people had said.
--  4. It is told the date and time in the organisation's zone (due dates and "today" were guesses).
--  5. A chat run has 6 minutes (was 3: shorter than the model's own 4-minute wait, so a slow answer could not be
--     posted and the run ended in silence as no_answer).
-- agent_run_finish
--  6. A run over its reservation but within its kind of work's budget (0988: chat 30k in + 4k out, task 300k + 40k,
--     or the organisation's own, plus what its manager allowed for that work) no longer switches the AI employee off
--     until an admin notices; it is still marked over_cap. More than twice that budget (a runaway) still does.
--  7. "runaway" is kept as the run's error (it was recorded as model_error).
-- agent_run_requeue(run, until, reason)
--  8. A retry after a failure that is not a plan's quota (below).

create or replace function pulse.agent_dispatch(p_id uuid, p_token uuid, p_lane text, p_model text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pulse', 'pg_temp'
as $function$
declare me uuid := agent_session(); e agent_event; m agent_member; msg chat_message; why text; busy text; committed int; rid uuid; dl timestamptz;
  ch_kind text; approver uuid; mode text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  m := agent_lock(me);
  select * into e from agent_event where id = p_id and org_id = current_org() and agent_id = me for update;
  if not found or e.state <> 'leased' or e.lease_token is distinct from p_token or e.lease_until <= now() then
    raise exception 'That event is not leased to you any more' using errcode='22023'; end if;
  perform agent_sweep(me);
  select * into msg from chat_message where id = e.subject_id;
  why := case
    when e.subject_type <> 'message' then 'not_chats'
    when msg.id is null or msg.removed_at is not null then 'message_gone'
    when not agent_leader(e.invoked_by) and m.listens_to <> 'everyone' then 'not_leader'
    when not exists(select 1 from chat_member where channel_id = msg.channel_id and person_id = me) then 'agent_left'
    when not exists(select 1 from chat_member where channel_id = msg.channel_id and person_id = e.invoked_by) then 'asker_left'
  end;
  if why is null then
    select coalesce(sum(case when state in ('done','error') then coalesce(tokens, reserved) else reserved end), 0) into committed
      from agent_run where agent_id = me and (started_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date;
    if committed + m.run_reserve > m.daily_token_budget then why := 'budget_spent'; end if;
  end if;
  if why is not null then
    update agent_event set state = 'failed', finished_at = now(), lease_token = null, lease_until = null, reason = why where id = e.id;
    return jsonb_build_object('status', 'refused', 'reason', why);
  end if;
  busy := case
    when m.disabled_at is not null then 'paused'
    when exists(select 1 from agent_run where agent_id = me and state = 'dispatching') then 'one_at_a_time'
    when (select count(*) from agent_run where agent_id = me and started_at > now() - interval '1 hour') >= 60 then 'hourly_limit'
  end;
  if busy is not null then
    update agent_event set state = 'queued', lease_token = null, lease_until = null, retry_at = now() + interval '20 seconds', reason = busy where id = e.id;
    return jsonb_build_object('status', 'busy', 'reason', busy);
  end if;
  -- AI-EMP (5): 6 minutes, longer than the runtime's own 4-minute wait for a chat answer.
  dl := now() + interval '6 minutes';
  insert into agent_run(org_id, agent_id, event_id, lane, model, reserved, deadline)
  values (current_org(), me, e.id, left(coalesce(nullif(p_lane, ''), m.lane), 40), left(coalesce(p_model, ''), 80), m.run_reserve, dl) returning id into rid;
  update agent_event set state = 'dispatching', run_id = rid, lease_token = null, lease_until = null, reason = null where id = e.id;
  -- AI-EMP (1): its approver writing to it directly is answered directly.
  select kind into ch_kind from chat_channel where id = msg.channel_id;
  approver := coalesce(m.approver_person_id, m.owner_person_id);
  mode := agent_mode_for(m, e.event_type);
  if mode = 'approve' and ch_kind = 'direct' and msg.author_id = approver then mode := 'own'; end if;
  return jsonb_build_object('status', 'dispatched', 'runId', rid, 'reserved', m.run_reserve,
    'deadline', to_char(dl at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'context', jsonb_build_object(
      'mode', mode, 'kind', e.event_type, 'askerIsApprover', msg.author_id = approver,
      'approver', (select display_name from person where id = approver),
      -- AI-EMP (4)
      'now', to_char(now() at time zone org_time_zone(), 'FMDay DD Mon YYYY, HH24:MI'), 'timeZone', org_time_zone(),
      -- AI-EMP (2)
      'newer', exists(select 1 from agent_event e2 join chat_message x2 on x2.id = e2.subject_id
                       where e2.org_id = current_org() and e2.agent_id = me and e2.id <> e.id and e2.subject_type = 'message'
                         and e2.state in ('queued', 'leased') and x2.channel_id = msg.channel_id and x2.removed_at is null
                         and x2.created_at > msg.created_at),
      'instructions', left(m.instructions, 8000), 'sops', to_jsonb(m.sop_links),
      'memory', (select coalesce(jsonb_agg(left(x.body, 400) order by x.created_at desc), '[]'::jsonb) from (
                  select body, created_at from agent_memory where agent_id = me and retired_at is null order by created_at desc limit 20) x),
      'message', (select jsonb_build_object('id', x.id, 'channelId', x.channel_id, 'parentId', x.parent_id, 'body', left(x.body, 2000),
                    'author', p.display_name, 'channelKind', ch.kind, 'channelName', case when ch.kind = 'direct' then null else ch.name end)
                  from chat_message x join person p on p.id = x.author_id join chat_channel ch on ch.id = x.channel_id where x.id = msg.id),
      -- AI-EMP (3): no empty messages (cards), none of its own proposal cards.
      'recent', (select coalesce(jsonb_agg(r.j order by r.at), '[]'::jsonb) from (
                  select x.created_at at, jsonb_build_object('author', p.display_name, 'byAgent', p.side = 'agent', 'mine', x.author_id = me,
                           'body', left(x.body, 600)) j
                    from chat_message x join person p on p.id = x.author_id
                   where x.channel_id = msg.channel_id and x.removed_at is null and x.kind = 'text' and x.created_at <= msg.created_at
                     and btrim(coalesce(x.body, '')) <> ''
                     and not exists(select 1 from agent_proposal pr where pr.dm_message_id = x.id)
                   order by x.created_at desc limit 14) r)));
end $function$;

create or replace function pulse.agent_run_finish(p_run uuid, p_state text, p_tokens integer, p_seconds numeric, p_error_code text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pulse', 'pg_temp'
as $function$
declare me uuid := agent_session(); r agent_run; m agent_member; used int; over boolean; code text; kind text; o agent_org_ai; budget bigint;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if p_state is null or p_state not in ('done','error') then raise exception 'Say done or error' using errcode='22023'; end if;
  -- AI-EMP (7)
  code := case when p_state = 'done' then null when p_error_code in ('model_error','no_answer','runaway') then p_error_code else 'model_error' end;
  m := agent_lock(me);
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me for update;
  if not found or r.state <> 'dispatching' then raise exception 'That run is not running' using errcode='22023'; end if;
  over := p_tokens is not null and p_tokens > r.reserved;
  update agent_run set state = p_state, tokens = case when p_tokens is null then null else greatest(0, least(p_tokens, 10000000)) end,
         seconds = greatest(0, least(coalesce(p_seconds, 0), 9999999)), over_cap = over, error_code = code, finished_at = now()
   where id = r.id;
  update agent_event set state = case when p_state = 'done' then 'done' else 'failed' end, finished_at = now(), reason = code where id = r.event_id;
  -- AI-EMP (6): its kind of work's budget (in + out), the organisation's or 0988's default, plus what was allowed for it.
  select case when x.subject_type = 'task' then 'task' else 'chat' end into kind from agent_event x where x.id = r.event_id;
  select * into o from agent_org_ai where org_id = current_org();
  budget := (case when (o.budgets->kind->>'in') ~ '^\d{1,9}$' then (o.budgets->kind->>'in')::bigint when kind = 'task' then 300000 else 30000 end)
          + (case when (o.budgets->kind->>'out') ~ '^\d{1,9}$' then (o.budgets->kind->>'out')::bigint when kind = 'task' then 40000 else 4000 end)
          + coalesce((select sum(g.extra) from agent_budget_grant g where g.event_id = r.event_id), 0);
  if p_tokens is not null and p_tokens > 2 * greatest(budget, r.reserved) then
    update agent_member set disabled_at = coalesce(disabled_at, now()),
           paused_reason = format('A run used %s tokens, more than twice its %s budget; an admin switches it back on', p_tokens, greatest(budget, r.reserved))
     where person_id = me;
  end if;
  select * into m from agent_member where person_id = me;
  select coalesce(sum(case when state in ('done','error') then coalesce(tokens, reserved) else reserved end), 0) into used
    from agent_run where agent_id = me and (started_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date;
  return jsonb_build_object('usedToday', used, 'dailyBudget', m.daily_token_budget, 'reserve', m.run_reserve, 'paused', m.disabled_at is not null);
end $function$;

-- AI-EMP (8): try again later for a reason other than a plan's quota (every engine failed or gave no answer; the
-- runtime retries three times, then says it gave up). The run closes at no cost as model_error, the work waits until
-- then, and its profile is not marked "out of quota". The two-argument form (a plan's quota) is unchanged.
create or replace function pulse.agent_run_requeue(p_run uuid, p_until timestamptz, p_reason text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; at timestamptz := least(coalesce(p_until, now() + interval '5 minutes'), now() + interval '1 day');
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if p_reason is distinct from 'model_error' then return agent_run_requeue(p_run, p_until); end if;
  perform agent_lock(me);
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me for update;
  if not found or r.state <> 'dispatching' then raise exception 'That run is not running' using errcode='22023'; end if;
  update agent_run set state = 'error', tokens = 0, seconds = 0, error_code = 'model_error', finished_at = now() where id = r.id;
  update agent_event set state = 'queued', retry_at = greatest(at, now() + interval '1 minute'), reason = 'model_error', lease_token = null, lease_until = null
   where id = r.event_id;
  return jsonb_build_object('retryAt', to_char(greatest(at, now() + interval '1 minute') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end $$;
revoke all on function pulse.agent_run_requeue(uuid, timestamptz, text) from public;
grant execute on function pulse.agent_run_requeue(uuid, timestamptz, text) to pulse_api;

-- migrate:down
-- Forward-only.
