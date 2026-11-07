-- migrate:up
-- AI-EMP-2 (owner, 25 Oct 2026): "AI agents must work autonomously, talk to colleagues before messaging clients, manage
-- tasks, coordinate clients, understand intent, and handle voice calls." What an AI employee now follows up by itself
-- (always through a person: nothing reaches a client without someone pressing Send it):
--   * A card nobody decides (SIM-CLIENTS S7): its approver gets one reminder in the same direct message (after 1 hour
--     when a client is waiting, 4 hours otherwise, 15 minutes when the card is urgent), then a leader of that conversation
--     (or the AI employee's manager) is asked to decide it (after 4 hours / a day / 45 minutes). Only in working hours
--     (the organisation's working rules: work days, shift start and end) unless the card is urgent. Cards still expire
--     after 72 h.
--   * A client who has gone quiet for 3 days while we wait on them: the AI employee of that group drafts a follow-up as a
--     card for its approver (at most two follow-ups in a row; groups quiet for over two weeks are left alone).
--   * A missed call from a client in a group: the AI employee proposes a time to call back (a card) and a task.
--   * Urgent: an AI employee may mark a card urgent (a client's time-critical message, often after hours); the card says
--     so and its reminders do not wait for the morning. Its questions to colleagues from that work are urgent too: a
--     reminder after 15 minutes, then its approver (or, when it asked its approver, a leader of that conversation).
--   * One card per conversation: a newer card replaces its cards still waiting there (two people asking opposite
--     things got two cards that disagreed).
--   * Workload: what each AI employee did today, its cards waiting, its questions to colleagues waiting, and the mistakes
--     people caught (cards edited or turned down, runs that failed), for admins, leaders and its managers.
--
-- Additive: columns on agent_proposal and agent_consult, functions, one trigger on chat_call. Replaced: agent_consults_sweep
-- (1035, with urgent timings and the leader fallback), the agent_event checks (widened from their live values: every
-- earlier kind and reason kept, consult.answer / not_consult / no_consult included), the agent_proposal_run index (several
-- task proposals may come from one run about a recorded call), and two text patches (agent_propose_task,
-- agent_proposal_from_reply) that raise a notice and leave the function as it is when its shape has changed.

alter table pulse.agent_proposal
  add column if not exists urgent boolean not null default false,
  add column if not exists reminded_at timestamptz,
  add column if not exists escalated_at timestamptz,
  add column if not exists escalated_to uuid references pulse.person(id),
  add column if not exists escalation_message_id uuid;
create index if not exists agent_proposal_escalation on pulse.agent_proposal (escalation_message_id) where escalation_message_id is not null;
create index if not exists agent_proposal_waiting on pulse.agent_proposal (org_id, agent_id, created_at) where state = 'pending';
alter table pulse.agent_consult add column if not exists urgent boolean not null default false;

-- Work an AI employee starts itself (a quiet client, a missed call, a recorded call) and its refusals: added to the
-- kinds and reasons the checks allow now (read from the live constraints, so nothing another migration added is lost;
-- consult.answer, not_consult and no_consult stay).
do $do$
declare k text[]; r text[];
begin
  select array_agg(distinct v order by v) into k from (
    select (regexp_matches(pg_get_constraintdef(oid), '''([^'']+)''', 'g'))[1] v from pg_constraint where conrelid = 'pulse.agent_event'::regclass and conname = 'agent_event_event_type_check'
    union select unnest(array['consult.answer','client.silent','call.missed','call.recorded'])) x;
  select array_agg(distinct v order by v) into r from (
    select (regexp_matches(pg_get_constraintdef(oid), '''([^'']+)''', 'g'))[1] v from pg_constraint where conrelid = 'pulse.agent_event'::regclass and conname = 'agent_event_reason_check'
    union select unnest(array['not_consult','no_consult','not_own','not_needed'])) x;
  alter table pulse.agent_event drop constraint agent_event_event_type_check;
  execute format('alter table pulse.agent_event add constraint agent_event_event_type_check check (event_type = any (%L::text[]))', k);
  alter table pulse.agent_event drop constraint agent_event_reason_check;
  execute format('alter table pulse.agent_event add constraint agent_event_reason_check check (reason = any (%L::text[]))', r);
end $do$;

-- One reply proposal per run; task proposals one per title (a recorded call may give several pieces of work).
drop index if exists pulse.agent_proposal_run;
create unique index agent_proposal_run on pulse.agent_proposal (run_id, kind, (case when kind = 'task' then coalesce(action->>'title', '') else '' end)) where run_id is not null;

/** Whether an AI employee works in this group the way a client's message there would reach it: in the group, switched
 *  on, it speaks there, it is not an observer or an @-only assistant, and it acts in groups (or coordinates this one). */
create or replace function pulse.agent_works_in(p_agent uuid, p_channel uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
  select exists(select 1 from agent_member m join person p on p.id = m.person_id join chat_channel ch on ch.id = p_channel
     join chat_member cm on cm.channel_id = p_channel and cm.person_id = m.person_id
     left join chat_group_agent ga on ga.channel_id = p_channel and ga.agent_id = m.person_id
    where m.person_id = p_agent and ch.kind <> 'direct' and not m.post_only and m.disabled_at is null and p.status = 'active'
      and (m.speak_scope = 'its_groups' or (m.speak_scope = 'listed' and p_channel = any(m.speak_channels)))
      and (agent_mode_for(m, 'chat.group') <> 'off' or ga.role = 'coordinator')
      and coalesce(ga.role, '') not in ('observer', 'assistant'))
$$;

/** Working hours for follow-ups: the organisation's working rules (HR → Policies: work days, shift start and end, in
 *  its zone); without them 10:00-19:00, Monday to Saturday. */
create or replace function pulse.agent_work_hours(p_at timestamptz default now()) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
  select extract(isodow from l)::int = any(coalesce(p.work_days, '{1,2,3,4,5,6}')) and l::time >= coalesce(p.shift_start, '10:00') and l::time < coalesce(p.shift_end, '19:00')
    from (select p_at at time zone org_time_zone() l) x left join hr_policy p on p.org_id = current_org()
$$;
/** "10:00-19:00, Monday to Saturday": the same rules in words, for the AI employee's prompt. */
create or replace function pulse.agent_work_hours_words() returns text language sql stable security definer set search_path=pulse,pg_temp as $$
  select to_char(coalesce(p.shift_start, '10:00'), 'HH24:MI') || '-' || to_char(coalesce(p.shift_end, '19:00'), 'HH24:MI') || ', '
      || coalesce((select string_agg(to_char(date '2026-10-26' + d - 1, 'FMDy'), ' ' order by d) from unnest(p.work_days) d), 'Mon Tue Wed Thu Fri Sat')
    from (select 1) x left join hr_policy p on p.org_id = current_org()
$$;

/** The client people of a conversation, newest writer first. */
create or replace function pulse.agent_channel_clients(p_channel uuid) returns uuid[] language sql stable security definer set search_path=pulse,pg_temp as $$
  select coalesce(array_agg(x.id order by x.last desc nulls last), '{}') from (
    select p.id, (select max(created_at) from chat_message where channel_id = p_channel and author_id = p.id) last
      from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = p_channel and p.side not in ('staff', 'agent') and p.status = 'active') x
$$;

/** The short line a card about work it started itself opens with (also used on task cards from that work). */
create or replace function pulse.agent_own_line(p_kind text, p_msg uuid) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
  select case p_kind
    when 'client.silent' then 'Follow-up in “' || ch.name || '”: ' || coalesce((select string_agg(display_name, ', ') from person where id = any(agent_channel_clients(ch.id))), 'the client')
      || ' has not written since ' || coalesce(to_char((select max(x.created_at) from chat_message x join person xp on xp.id = x.author_id where x.channel_id = ch.id and xp.side not in ('staff','agent')) at time zone org_time_zone(), 'FMDD Mon'), 'they joined')
      || '. We last wrote:'
    when 'call.missed' then 'Missed call in “' || ch.name || '” at ' || to_char(m.created_at at time zone org_time_zone(), 'FMHH12:MI am, FMDD Mon') || ':'
    when 'call.recorded' then 'From the recorded call in “' || ch.name || '” (' || to_char(m.created_at at time zone org_time_zone(), 'FMDD Mon, FMHH12:MI am') || '):'
    else 'In “' || ch.name || '”:' end
    from chat_message m join chat_channel ch on ch.id = m.channel_id where m.id = p_msg
$$;

/** What it follows up on its own (its runtime calls this every few minutes, as that AI employee): reminders and
 *  escalation of its cards nobody decided, and quiet clients. p_only (a test install's "askOnly": pulse-dev holds a copy
 *  of real people) limits whom it reminds, escalates to and brings a follow-up card. Returns what it did. */
create or replace function pulse.agent_follow_up(p_only text[] default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); pr agent_proposal; ch chat_channel; facing boolean; age interval; to_id uuid; dm uuid; mid uuid; who text; ap text; client text;
  reminded int := 0; escalated int := 0; quiet int := 0; g record; lm chat_message; asker uuid; inrow int; hours boolean := agent_work_hours();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  -- 1. Its cards nobody decided: one reminder to its approver (quoting the card), then a leader or its manager.
  -- (Not a card about its approver's own direct message with it: they are reading that conversation already.)
  for pr in select * from agent_proposal where org_id = current_org() and agent_id = me and state = 'pending' and kind in ('reply','task','summary')
              and channel_id <> dm_channel_id and (reminded_at is null or escalated_at is null) and created_at > now() - interval '72 hours' order by created_at for update skip locked loop
    if not (pr.urgent or hours) then continue; end if;
    if p_only is not null and not exists(select 1 from people_profile where person_id = pr.approver_id and username = any(p_only)) then continue; end if;
    select * into ch from chat_channel where id = pr.channel_id;
    facing := chat_client_facing(pr.channel_id); age := now() - pr.created_at;
    select display_name into client from person where id = (select author_id from chat_message where id = pr.source_message_id) and side not in ('staff','agent');
    select display_name into ap from person where id = pr.approver_id;
    if pr.reminded_at is null and age > (case when pr.urgent then interval '15 minutes' when facing then interval '1 hour' else interval '4 hours' end) then
      mid := chat_send(pr.dm_channel_id, case when pr.urgent then 'Urgent, still waiting for you' else 'Still waiting for you' end
          || ' since ' || to_char(pr.created_at at time zone org_time_zone(), 'FMHH12:MI am') || case when age > interval '20 hours' then to_char(pr.created_at at time zone org_time_zone(), ' (FMDD Mon)') else '' end
          || case when client is not null then ': ' || client || ' has had no answer in “' || ch.name || '” yet.' when facing then ': it is for a client conversation, “' || ch.name || '”.' else '.' end
          || ' ' || case when pr.kind = 'task' then 'Create it, Edit, or Don''t' else 'Send it, Edit, or Don''t' end || ' on the card (a reply like “fine, send it” works too).',
        null, '[]'::jsonb, gen_random_uuid(), pr.dm_message_id);
      update agent_proposal set reminded_at = now() where id = pr.id; reminded := reminded + 1;
    elsif pr.reminded_at is not null and pr.escalated_at is null and pr.reminded_at < now() - interval '10 minutes'
          and age > (case when pr.urgent then interval '45 minutes' when facing then interval '4 hours' else interval '24 hours' end) then
      -- A leader of that conversation first (they can decide any card), else its manager; never the approver again.
      select p.id into to_id from chat_member cm join person p on p.id = cm.person_id left join people_profile pp on pp.person_id = p.id
       where cm.channel_id = pr.channel_id and p.side = 'staff' and p.status = 'active' and p.id <> pr.approver_id and agent_leader(p.id)
         and (p_only is null or pp.username = any(p_only)) order by p.display_name limit 1;
      if to_id is null then
        select p.id into to_id from agent_member m join person p on p.id = m.owner_person_id left join people_profile pp on pp.person_id = p.id
         where m.person_id = me and p.status = 'active' and p.id <> pr.approver_id and (p_only is null or pp.username = any(p_only));
      end if;
      update agent_proposal set escalated_at = now(), escalated_to = to_id where id = pr.id;
      if to_id is null then continue; end if;
      dm := agent_dm_with(me, to_id);
      mid := chat_send(dm, ap || ' has not decided this since ' || to_char(pr.created_at at time zone org_time_zone(), 'FMHH12:MI am, FMDD Mon')
          || case when client is not null then ', and ' || client || ' is waiting for an answer in “' || ch.name || '”' when facing then ' (for a client conversation, “' || ch.name || '”)' else ' (for “' || ch.name || '”)' end
          || '. Can you decide it? ' || case when pr.kind = 'task' then 'Create it, Edit, or Don''t.' else 'Send it, Edit, or Don''t.' end
          || case when pr.why is not null then chr(10) || 'Why I wrote it: ' || left(pr.why, 300) else '' end, null, '[]'::jsonb, gen_random_uuid(), null);
      update agent_proposal set escalation_message_id = mid where id = pr.id; escalated := escalated + 1;
    end if;
  end loop;
  -- 2. Quiet clients: in its client groups, our side wrote last, three days ago or more (and under two weeks), nothing of
  --    the client's since; at most two follow-ups in a row. Made in working hours only.
  if hours then
    for g in select ch2.id from chat_channel ch2 join chat_member cm on cm.channel_id = ch2.id and cm.person_id = me
              where ch2.org_id = current_org() and ch2.kind <> 'direct' and chat_client_facing(ch2.id) and agent_works_in(me, ch2.id) loop
      select * into lm from chat_message where channel_id = g.id and removed_at is null and kind = 'text' and (btrim(coalesce(body, '')) <> '' or attachments <> '[]'::jsonb)
       order by created_at desc limit 1;
      if lm.id is null or lm.created_at > now() - interval '72 hours' or lm.created_at < now() - interval '14 days' then continue; end if;
      if exists(select 1 from person where id = lm.author_id and side not in ('staff','agent')) then continue; end if;
      select count(*) into inrow from agent_event e where e.org_id = current_org() and e.agent_id = me and e.event_type = 'client.silent'
         and e.subject_id in (select id from chat_message where channel_id = g.id
                               and created_at > coalesce((select max(x.created_at) from chat_message x join person xp on xp.id = x.author_id where x.channel_id = g.id and xp.side not in ('staff','agent')), '-infinity'));
      if inrow >= 2 then continue; end if;
      asker := (agent_channel_clients(g.id))[1];
      if asker is null then continue; end if;
      if p_only is not null and not exists(select 1 from people_profile where person_id = agent_approver_for(me, g.id) and username = any(p_only)) then continue; end if;
      insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
      values (current_org(), me, 'client.silent', 'message', lm.id, 'silent:' || lm.id, asker) on conflict do nothing;
      if found then quiet := quiet + 1; end if;
    end loop;
  end if;
  return jsonb_build_object('reminded', reminded, 'escalated', escalated, 'quiet', quiet);
end $$;

/** A client called in a group and nobody answered: the AI employees working in that group are asked to propose a time
 *  to call back (call.missed). A call is never refused because of this. */
create or replace function pulse.agent_call_missed() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid;
begin
  if new.state <> 'ended' or old.state = 'ended' or new.answered_at is not null or new.message_id is null then return null; end if;
  if not exists(select 1 from person where id = new.started_by and side not in ('staff','agent')) then return null; end if;
  for a in select cm.person_id from chat_member cm join agent_member m on m.person_id = cm.person_id where cm.channel_id = new.channel_id and agent_works_in(cm.person_id, new.channel_id) loop
    insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
    values (new.org_id, a, 'call.missed', 'message', new.message_id, 'call-missed:' || new.id, new.started_by) on conflict do nothing;
  end loop;
  return null;
exception when others then
  raise warning 'agent_call_missed: %', sqlerrm;
  return null;
end $$;
create trigger agent_call_missed after update of state on pulse.chat_call for each row execute function pulse.agent_call_missed();

/** What a run about work it started itself knows besides the conversation: the quiet client, the missed call, the
 *  recorded call (1057 adds the recording). */
create or replace function pulse.agent_own_context(p_kind text, p_msg uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare m chat_message; c chat_call; out jsonb;
begin
  select * into m from chat_message where id = p_msg;
  if p_kind = 'client.silent' then
    return jsonb_build_object('clients', (select coalesce(jsonb_agg(display_name), '[]'::jsonb) from person where id = any(agent_channel_clients(m.channel_id))),
      'clientLast', (select jsonb_build_object('author', p.display_name, 'body', left(x.body, 600), 'at', to_char(x.created_at at time zone org_time_zone(), 'FMDay DD Mon, HH24:MI'))
                       from chat_message x join person p on p.id = x.author_id where x.channel_id = m.channel_id and p.side not in ('staff','agent') and x.removed_at is null order by x.created_at desc limit 1),
      'ourLast', jsonb_build_object('author', (select display_name from person where id = m.author_id), 'body', left(m.body, 800), 'at', to_char(m.created_at at time zone org_time_zone(), 'FMDay DD Mon, HH24:MI')),
      'quietDays', floor(extract(epoch from now() - m.created_at) / 86400),
      'followUpsSoFar', (select count(*) from agent_proposal pr where pr.channel_id = m.channel_id and pr.agent_id = agent_session() and pr.state = 'sent'
                           and pr.posted_message_id in (select id from chat_message where channel_id = m.channel_id and created_at >= m.created_at)));
  elsif p_kind = 'call.missed' then
    select * into c from chat_call where message_id = p_msg order by created_at desc limit 1;
    return jsonb_build_object('caller', (select display_name from person where id = c.started_by), 'video', c.video,
      'at', to_char(c.created_at at time zone org_time_zone(), 'FMDay DD Mon, HH24:MI'),
      'rang', (select coalesce(jsonb_agg(p.display_name order by p.display_name), '[]'::jsonb) from chat_call_party pa join person p on p.id = pa.person_id where pa.call_id = c.id and pa.person_id <> c.started_by),
      'missedToday', (select count(*) from chat_call c2 where c2.channel_id = c.channel_id and c2.started_by = c.started_by and c2.answered_at is null and c2.state = 'ended'
                        and (c2.created_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date),
      'workHours', agent_work_hours(), 'callNowOk', agent_work_hours(now() + interval '30 minutes'));
  elsif p_kind = 'call.recorded' and to_regprocedure('pulse.agent_recorded_context(uuid)') is not null then
    -- 1057 (after CALLS-V2's recordings): the recording, its people and its transcript.
    execute 'select pulse.agent_recorded_context($1)' into out using p_msg;
    return out;
  end if;
  return null;
end $$;

/** Dispatch of work it started itself (client.silent, call.missed, call.recorded): like agent_consult_dispatch (lease,
 *  budget, one run at a time), always asking first (a card for its approver), with the whole conversation up to now.
 *  Work that is no longer needed (the client wrote, someone called back) closes at no cost. */
create or replace function pulse.agent_own_dispatch(p_id uuid, p_token uuid, p_lane text, p_model text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); e agent_event; m agent_member; msg chat_message; ch chat_channel; why text; busy text; committed int; rid uuid; dl timestamptz;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  m := agent_lock(me);
  select * into e from agent_event where id = p_id and org_id = current_org() and agent_id = me for update;
  if not found or e.state <> 'leased' or e.lease_token is distinct from p_token or e.lease_until <= now() then
    raise exception 'That event is not leased to you any more' using errcode='22023'; end if;
  perform agent_sweep(me);
  select * into msg from chat_message where id = e.subject_id;
  select * into ch from chat_channel where id = msg.channel_id;
  why := case
    when e.event_type not in ('client.silent','call.missed','call.recorded') or e.subject_type <> 'message' then 'not_own'
    when msg.id is null or msg.removed_at is not null then 'message_gone'
    when not exists(select 1 from chat_member where channel_id = msg.channel_id and person_id = me) then 'agent_left'
    -- A quiet client wrote meanwhile, or someone of ours already followed up.
    when e.event_type = 'client.silent' and exists(select 1 from chat_message x where x.channel_id = msg.channel_id and x.created_at > msg.created_at and x.removed_at is null and x.kind = 'text') then 'not_needed'
    -- A missed call: someone answered a later call, or the team wrote or called since.
    when e.event_type = 'call.missed' and (exists(select 1 from chat_call c where c.channel_id = msg.channel_id and c.created_at > msg.created_at and (c.answered_at is not null or exists(select 1 from person where id = c.started_by and side = 'staff')))
         or exists(select 1 from chat_message x join person xp on xp.id = x.author_id where x.channel_id = msg.channel_id and x.created_at > msg.created_at and x.removed_at is null and x.kind = 'text' and xp.side = 'staff')) then 'not_needed'
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
  dl := now() + interval '6 minutes';
  insert into agent_run(org_id, agent_id, event_id, lane, model, reserved, deadline)
  values (current_org(), me, e.id, left(coalesce(nullif(p_lane, ''), m.lane), 40), left(coalesce(p_model, ''), 80), m.run_reserve, dl) returning id into rid;
  update agent_event set state = 'dispatching', run_id = rid, lease_token = null, lease_until = null, reason = null where id = e.id;
  return jsonb_build_object('status', 'dispatched', 'runId', rid, 'reserved', m.run_reserve,
    'deadline', to_char(dl at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'context', jsonb_build_object('mode', 'approve', 'kind', e.event_type, 'askerIsApprover', false, 'groupRole', agent_group_role(me, msg.channel_id),
      'approver', (select display_name from person where id = agent_approver_for(me, msg.channel_id)),
      'now', to_char(now() at time zone org_time_zone(), 'FMDay DD Mon YYYY, HH24:MI'), 'timeZone', org_time_zone(), 'newer', false, 'workHours', agent_work_hours(), 'workHoursWords', agent_work_hours_words(),
      'instructions', left(m.instructions, 8000), 'sops', to_jsonb(m.sop_links),
      'memory', (select coalesce(jsonb_agg(left(x.body, 400) order by x.created_at desc), '[]'::jsonb) from (
                  select body, created_at from agent_memory where agent_id = me and retired_at is null order by created_at desc limit 20) x),
      'message', (select jsonb_build_object('id', x.id, 'channelId', x.channel_id, 'parentId', null, 'body', left(x.body, 2000),
                    'author', p.display_name, 'channelKind', ch.kind, 'channelName', ch.name)
                  from chat_message x join person p on p.id = x.author_id where x.id = msg.id),
      'recent', (select coalesce(jsonb_agg(r.j order by r.at), '[]'::jsonb) from (
                  select x.created_at at, jsonb_build_object('author', p.display_name, 'byAgent', p.side = 'agent', 'client', p.side not in ('staff','agent'), 'mine', x.author_id = me,
                           'at', to_char(x.created_at at time zone org_time_zone(), 'DD Mon HH24:MI'), 'body', left(x.body, 600)) j
                    from chat_message x join person p on p.id = x.author_id
                   where x.channel_id = msg.channel_id and x.removed_at is null and x.kind = 'text' and btrim(coalesce(x.body, '')) <> ''
                   order by x.created_at desc limit 12) r),
      'own', agent_own_context(e.event_type, msg.id)));
end $$;

/** Inside a run about work it started itself: the card for its approver (Send it / Edit / Don't), saying why it writes. */
create or replace function pulse.agent_propose_own(p_run uuid, p_body text, p_why text, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; e agent_event; msg chat_message; ch chat_channel; ap uuid; dm uuid; mid uuid; pid uuid;
  b text := btrim(coalesce(p_body, '')); w text := left(nullif(btrim(coalesce(p_why, '')), ''), 1000);
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if length(b) not between 1 and 4000 then raise exception 'Write the proposal in up to 4,000 characters' using errcode='22023'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Propose inside the run' using errcode='42501'; end if;
  select id into pid from agent_proposal where run_id = r.id and kind = 'reply';
  if found then return (select jsonb_build_object('id', x.id, 'messageId', x.dm_message_id, 'chatId', x.dm_channel_id) from agent_proposal x where x.id = pid); end if;
  select * into e from agent_event where id = r.event_id;
  if e.event_type not in ('client.silent','call.missed','call.recorded') then raise exception 'That run is not work it started itself' using errcode='22023'; end if;
  select * into msg from chat_message where id = e.subject_id;
  select * into ch from chat_channel where id = msg.channel_id;
  ap := agent_approver_for(me, msg.channel_id);
  if ap is null then raise exception 'It has nobody to ask' using errcode='22023'; end if;
  dm := agent_dm_with(me, ap);
  insert into agent_proposal(org_id, agent_id, run_id, channel_id, source_message_id, approver_id, dm_channel_id, kind, body, why)
  values (current_org(), me, r.id, msg.channel_id, msg.id, ap, dm, 'reply', b, w) returning id into pid;
  mid := chat_send(dm, agent_own_line(e.event_type, msg.id) || case when e.event_type = 'client.silent'
        then chr(10) || '“' || left(regexp_replace(msg.body, '\s+', ' ', 'g'), 280) || case when length(msg.body) > 280 then '…' else '' end || '”' || chr(10) || 'This is the follow-up I would post'
        when e.event_type = 'call.missed' then chr(10) || 'Nobody answered. This is the reply I would post, with a time to call back'
        else chr(10) || 'This is the summary and the next steps I would post for the client' end
      || ': Send it, Edit, or Don''t (a reply like “fine, send it” works too).', null, '[]'::jsonb, p_client, null);
  update agent_proposal set dm_message_id = mid where id = pid;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  return jsonb_build_object('id', pid, 'messageId', mid, 'chatId', dm);
end $$;

/** Inside a run: its reply card is urgent (a client's time-critical message): the card says so and its reminders do not
 *  wait for working hours. */
create or replace function pulse.agent_proposal_urgent(p_run uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); n int;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if not exists(select 1 from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now()) then
    raise exception 'Mark it inside the run' using errcode='42501'; end if;
  update agent_proposal set urgent = true where run_id = p_run and agent_id = me and state = 'pending';
  get diagnostics n = row_count;
  -- Its questions to colleagues from this run are urgent too: the question says so, and its reminder comes sooner.
  update chat_message set body = 'Urgent: ' || body where id in (select question_message_id from agent_consult where run_id = p_run and agent_id = me and not urgent) and body not like 'Urgent:%';
  update agent_consult set urgent = true where run_id = p_run and agent_id = me and state = 'open';
  return jsonb_build_object('urgent', n);
end $$;

/** Its cards still waiting for a person in one conversation (for its prompt: a newer card replaces them). */
create or replace function pulse.agent_cards_waiting(p_channel uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'body', left(body, 800), 'since', to_char(created_at at time zone org_time_zone(), 'DD Mon HH24:MI')) order by created_at), '[]'::jsonb)
    from agent_proposal where org_id = current_org() and agent_id = me and channel_id = p_channel and state = 'pending' and kind in ('reply','task') and created_at > now() - interval '72 hours');
end $$;

/** Inside a run: its newer card for this conversation replaces these waiting ones (they close as expired), so its
 *  approver has one up-to-date card instead of two that may disagree. Only its own pending cards of that conversation. */
create or replace function pulse.agent_proposals_replace(p_run uuid, p_ids uuid[]) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; ch uuid; n int;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Replace inside the run' using errcode='42501'; end if;
  select m.channel_id into ch from agent_event e join chat_message m on m.id = e.subject_id where e.id = r.event_id and e.subject_type = 'message';
  update agent_proposal set state = 'expired' where org_id = current_org() and agent_id = me and state = 'pending' and id = any(p_ids)
     and channel_id = ch and coalesce(run_id, '00000000-0000-0000-0000-000000000000') <> p_run;
  get diagnostics n = row_count;
  return n;
end $$;

/** SIM-CLIENTS (1035) follow-up of its questions to colleagues, now also urgent ones: a reminder after 15 minutes (else
 *  2 hours), then its approver after 45 minutes (else 6 hours); when the colleague it asked is its approver, a leader of
 *  the conversation the question came from is asked instead. Closed after 3 days. */
create or replace function pulse.agent_consults_sweep() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); c agent_consult; ap uuid; dm uuid; nudged int := 0; escalated int := 0; expired int := 0; who text; col text; cid uuid; mid uuid;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  update agent_consult set state = 'expired' where org_id = current_org() and agent_id = me and state = 'open' and created_at < now() - interval '3 days';
  get diagnostics expired = row_count;
  for c in select * from agent_consult where org_id = current_org() and agent_id = me and state = 'open' and nudged_at is null
             and created_at < now() - case when urgent then interval '15 minutes' else interval '2 hours' end for update skip locked loop
    select display_name into who from person where id = c.asker_id;
    mid := chat_send(c.dm_channel_id, case when c.urgent then 'Urgent, a reminder: ' else 'A gentle reminder: ' end || coalesce(who, 'someone') || ' is still waiting on this.' || chr(10) || '“' || left(c.question, 400) || '”',
      null, '[]'::jsonb, gen_random_uuid(), c.question_message_id);
    update agent_consult set nudged_at = now() where id = c.id; nudged := nudged + 1;
  end loop;
  for c in select * from agent_consult where org_id = current_org() and agent_id = me and state = 'open' and escalated_at is null and nudged_at is not null
             and created_at < now() - case when urgent then interval '45 minutes' else interval '6 hours' end for update skip locked loop
    ap := agent_approver_for(me, c.source_channel_id);
    if ap = c.colleague_id then
      select p.id into ap from chat_member cm join person p on p.id = cm.person_id
       where cm.channel_id = c.source_channel_id and p.side = 'staff' and p.status = 'active' and p.id <> c.colleague_id and agent_leader(p.id) order by p.display_name limit 1;
    end if;
    update agent_consult set escalated_at = now() where id = c.id;
    if ap is null or ap = c.colleague_id then continue; end if;
    select display_name into who from person where id = c.asker_id;
    select display_name into col from person where id = c.colleague_id;
    dm := agent_dm_with(me, ap);
    insert into agent_consult(org_id, agent_id, run_id, source_channel_id, source_message_id, source_kind, asker_id, colleague_id, dm_channel_id, question, escalated_from, urgent)
    values (current_org(), me, c.run_id, c.source_channel_id, c.source_message_id, c.source_kind, c.asker_id, ap, dm, c.question, c.id, c.urgent) returning id into cid;
    mid := chat_send(dm, case when c.urgent then 'Urgent: ' else '' end || col || ' has not answered my question for ' || coalesce(who, 'someone') || ' since ' || to_char(c.created_at at time zone org_time_zone(), 'FMDD Mon, HH24:MI')
      || ':' || chr(10) || '“' || left(c.question, 600) || '”' || chr(10) || 'Can you answer it, or tell me who can? Reply here and I will take it from there.', null, '[]'::jsonb, gen_random_uuid(), null);
    update agent_consult set question_message_id = mid where id = cid;
    escalated := escalated + 1;
  end loop;
  return jsonb_build_object('nudged', nudged, 'escalated', escalated, 'expired', expired);
end $$;

-- agent_propose_task: a run about a recorded call may propose several tasks (one per title, at most six); the card
-- about work it started itself opens with what it is about (a call, a quiet client) instead of "X wrote".
do $do$
declare d text := pg_get_functiondef('pulse.agent_propose_task(uuid,jsonb,text,uuid)'::regprocedure);
  a text := 'select id into pid from agent_proposal where run_id = r.id and kind = ''task'';';
  b text := 'mid := chat_send(dm, case when msg.channel_id = dm then ''You asked me:''';
begin
  if position(a in d) = 0 or position(b in d) = 0 then raise notice '1056: agent_propose_task changed; left as it is'; return; end if;
  d := replace(d, a, 'select id into pid from agent_proposal where run_id = r.id and kind = ''task''
    and (action->>''title'' = v_title or (select event_type from agent_event where id = r.event_id) <> ''call.recorded'') order by created_at limit 1;
  if not found and (select count(*) from agent_proposal where run_id = r.id and kind = ''task'') >= 6 then raise exception ''Six tasks from one call are enough'' using errcode=''22023''; end if;');
  d := replace(d, b, 'mid := chat_send(dm, case when (select event_type from agent_event where id = r.event_id) in (''client.silent'',''call.missed'',''call.recorded'') then agent_own_line((select event_type from agent_event where id = r.event_id), msg.id) when msg.channel_id = dm then ''You asked me:''');
  execute d;
end $do$;

-- agent_proposal_from_reply: its reminder (an AI message quoting the card) does not hide the card from a "fine, send
-- it"; the person a card was escalated to may decide it by a reply in their direct message too.
do $do$
declare d text := pg_get_functiondef('pulse.agent_proposal_from_reply(uuid)'::regprocedure);
  a text := 'select * into pr from agent_proposal where org_id = current_org() and dm_channel_id = x.channel_id and approver_id = x.author_id and state = ''pending''
     and (x.quote_id = dm_message_id or (x.quote_id is null and not exists(select 1 from chat_message card join chat_message y on y.channel_id = card.channel_id
         and y.author_id = card.author_id and y.id <> card.id and y.created_at > card.created_at and y.created_at < x.created_at and y.removed_at is null
       where card.id = agent_proposal.dm_message_id))) order by created_at desc limit 1;';
begin
  if position(a in d) = 0 then raise notice '1056: agent_proposal_from_reply changed; left as it is'; return; end if;
  execute replace(d, a, 'select * into pr from agent_proposal where org_id = current_org() and state = ''pending''
     and ((dm_channel_id = x.channel_id and approver_id = x.author_id)
       or (escalated_to = x.author_id and exists(select 1 from chat_message em where em.id = agent_proposal.escalation_message_id and em.channel_id = x.channel_id)))
     and (x.quote_id in (dm_message_id, escalation_message_id) or (x.quote_id is null and not exists(select 1 from chat_message card join chat_message y on y.channel_id = card.channel_id
         and y.author_id = card.author_id and y.id <> card.id and y.quote_id is distinct from card.id and y.created_at > card.created_at and y.created_at < x.created_at and y.removed_at is null
       where card.id = case when agent_proposal.dm_channel_id = x.channel_id then agent_proposal.dm_message_id else agent_proposal.escalation_message_id end))) order by created_at desc limit 1;');
end $do$;

-- SIM-CLIENTS R138: a group made for a connection may have the organisation's AI employees in it from the start (as
-- Add people allows later); they are listed there by 1035's agent_listed_on_join.
do $do$
declare d text := pg_get_functiondef('pulse.connect_group_create(uuid,text,uuid[])'::regprocedure);
  a text := 'and (p.side = ''staff'' or exists (select 1 from pulse_priv.connect_seat s where s.connection_id = p_conn and s.seat_person = p.id and s.seat_org = current_org() and s.removed_at is null))';
begin
  if position(a in d) = 0 then raise notice '1056: connect_group_create changed; left as it is'; return; end if;
  execute replace(d, a, 'and (p.side = ''staff'' or (p.side = ''agent'' and exists (select 1 from agent_member am where am.person_id = p.id and am.disabled_at is null))
    or exists (select 1 from pulse_priv.connect_seat s where s.connection_id = p_conn and s.seat_person = p.id and s.seat_org = current_org() and s.removed_at is null))');
end $do$;

/** AI workload (admins and leaders see every AI employee; a manager sees the ones they manage): for one day in the
 *  organisation's zone, what each did (runs, replies, cards and what people did with them, tasks, questions to
 *  colleagues, follow-ups), its cards still waiting, its questions still waiting, and the mistakes people caught. */
create or replace function pulse.agent_workload(p_day date default null) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); d date := coalesce(p_day, (now() at time zone org_time_zone())::date); everyone boolean;
  t0 timestamptz; t1 timestamptz;
begin
  if agent_session() is not null or me is null then raise exception 'A person reads this' using errcode='42501'; end if;
  everyone := viewer_is('admin','leadership');
  if not everyone and not exists(select 1 from agent_member where org_id = current_org() and owner_person_id = me) then raise exception 'Leaders and AI employees'' managers see this' using errcode='42501'; end if;
  t0 := d::timestamp at time zone org_time_zone(); t1 := (d + 1)::timestamp at time zone org_time_zone();
  return jsonb_build_object('day', d, 'timeZone', org_time_zone(), 'agents', (select coalesce(jsonb_agg(a.j order by a.n), '[]'::jsonb) from (
    select p.display_name n, jsonb_build_object(
      'id', m.person_id, 'name', p.display_name, 'title', m.title, 'employeeId', m.employee_id,
      'approver', (select display_name from person where id = coalesce(m.approver_person_id, m.owner_person_id)),
      'manager', (select display_name from person where id = m.owner_person_id),
      'status', case when p.status <> 'active' or m.disabled_at is not null then 'off' when m.paused_reason is not null then 'paused' else 'on' end,
      'runtime', jsonb_build_object('state', m.runtime_state, 'until', m.runtime_until, 'provider', m.provider),
      'did', (select jsonb_build_object(
          'runs', count(*), 'tokens', coalesce(sum(coalesce(r.tokens, 0)), 0), 'failed', count(*) filter (where r.state = 'error'),
          'answered', count(*) filter (where e.event_type in ('chat.message','chat.mention','chat.reply','chat.group')),
          'tasks', count(*) filter (where e.subject_type = 'task'), 'afterAnswers', count(*) filter (where e.event_type = 'consult.answer'),
          'quietClients', count(*) filter (where e.event_type = 'client.silent'), 'missedCalls', count(*) filter (where e.event_type = 'call.missed'),
          'recordedCalls', count(*) filter (where e.event_type = 'call.recorded'))
        from agent_run r join agent_event e on e.id = r.event_id where r.agent_id = m.person_id and r.started_at >= t0 and r.started_at < t1),
      'posted', (select count(*) from agent_output o join agent_run r on r.id = o.run_id join chat_message x on x.id = o.subject_id
                  where r.agent_id = m.person_id and r.started_at >= t0 and r.started_at < t1 and o.subject_type = 'message'
                    and not exists(select 1 from agent_proposal pr where pr.dm_message_id = x.id) and not exists(select 1 from agent_consult c where c.question_message_id = x.id)),
      'cards', (select jsonb_build_object('made', count(*), 'replies', count(*) filter (where kind = 'reply'), 'tasks', count(*) filter (where kind = 'task'),
          'sent', count(*) filter (where state = 'sent' and (sent_body is null or sent_body = body)), 'edited', count(*) filter (where state = 'sent' and sent_body is not null and sent_body <> body),
          'turnedDown', count(*) filter (where state = 'dismissed'), 'expired', count(*) filter (where state = 'expired'), 'waiting', count(*) filter (where state = 'pending'),
          'reminded', count(*) filter (where reminded_at is not null), 'escalated', count(*) filter (where escalation_message_id is not null), 'urgent', count(*) filter (where urgent))
        from agent_proposal where agent_id = m.person_id and kind in ('reply','task','summary') and created_at >= t0 and created_at < t1),
      'asked', (select jsonb_build_object('asked', count(*), 'answered', count(*) filter (where answered_at is not null), 'relayed', count(*) filter (where state = 'relayed'),
          'reminded', count(*) filter (where nudged_at is not null), 'escalated', count(*) filter (where escalated_from is not null))
        from agent_consult where agent_id = m.person_id and created_at >= t0 and created_at < t1),
      'waitingCards', (select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'kind', pr.kind, 'body', left(pr.body, 240), 'why', left(pr.why, 240), 'urgent', pr.urgent,
            'channel', ch.name, 'channelId', pr.channel_id, 'client', chat_client_facing(pr.channel_id), 'approver', ap.display_name,
            'since', pr.created_at, 'reminded', pr.reminded_at, 'escalatedTo', (select display_name from person where id = pr.escalated_to),
            'messageId', pr.dm_message_id, 'chatId', pr.dm_channel_id) order by pr.created_at), '[]'::jsonb)
          from agent_proposal pr join chat_channel ch on ch.id = pr.channel_id join person ap on ap.id = pr.approver_id
         where pr.agent_id = m.person_id and pr.state = 'pending' and pr.kind in ('reply','task','summary')),
      'waitingQuestions', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'colleague', col.display_name, 'question', left(c.question, 240), 'for', ask.display_name,
            'channel', ch.name, 'client', chat_client_facing(c.source_channel_id), 'since', c.created_at, 'state', c.state, 'reminded', c.nudged_at, 'escalated', c.escalated_at,
            'chatId', c.dm_channel_id) order by c.created_at), '[]'::jsonb)
          from agent_consult c join person col on col.id = c.colleague_id left join person ask on ask.id = c.asker_id join chat_channel ch on ch.id = c.source_channel_id
         where c.agent_id = m.person_id and c.state in ('open','answered') and c.created_at > now() - interval '3 days'),
      'caught', (select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) from (
          select pr.decided_at at, jsonb_build_object('at', pr.decided_at, 'kind', case when pr.state = 'dismissed' then 'turned_down' else 'edited' end,
              'by', (select display_name from person where id = pr.decided_by), 'channel', (select name from chat_channel where id = pr.channel_id),
              'wrote', left(pr.body, 300), 'sent', case when pr.state = 'sent' then left(pr.sent_body, 300) end) j
            from agent_proposal pr where pr.agent_id = m.person_id and pr.decided_at >= t0 and pr.decided_at < t1 and pr.kind in ('reply','task','summary')
             and (pr.state = 'dismissed' or (pr.state = 'sent' and pr.sent_body is not null and pr.sent_body <> pr.body))
          union all
          select r.started_at, jsonb_build_object('at', r.started_at, 'kind', coalesce(r.error_code, 'error'), 'by', null, 'channel', null, 'wrote', null, 'sent', null)
            from agent_run r where r.agent_id = m.person_id and r.started_at >= t0 and r.started_at < t1 and r.state = 'error'
          order by 1 desc limit 30) x),
      'timeline', (select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) from (
          select r.started_at at, jsonb_build_object('at', r.started_at, 'kind', e.event_type, 'state', r.state, 'error', r.error_code, 'tokens', r.tokens, 'seconds', r.seconds,
              'about', case when e.subject_type = 'task' then (select title from task where id = e.subject_id)
                            else (select left(regexp_replace(body, '\s+', ' ', 'g'), 140) from chat_message where id = e.subject_id) end,
              'from', (select display_name from person where id = e.invoked_by),
              'where', (select case when ch.kind = 'direct' then 'a direct message' else ch.name end from chat_message x join chat_channel ch on ch.id = x.channel_id where x.id = e.subject_id and e.subject_type = 'message'),
              'did', (select coalesce(jsonb_agg(z.w), '[]'::jsonb) from (
                  select 'card:' || pr.kind || ':' || pr.state w from agent_proposal pr where pr.run_id = r.id
                  union all select 'asked:' || col.display_name from agent_consult c join person col on col.id = c.colleague_id where c.run_id = r.id and c.escalated_from is null) z)) j
            from agent_run r join agent_event e on e.id = r.event_id where r.agent_id = m.person_id and r.started_at >= t0 and r.started_at < t1
           order by r.started_at desc limit 40) x)) j
      from agent_member m join person p on p.id = m.person_id
     where m.org_id = current_org() and (everyone or m.owner_person_id = me)) a));
end $$;

revoke all on function pulse.agent_works_in(uuid, uuid), pulse.agent_work_hours(timestamptz), pulse.agent_work_hours_words(), pulse.agent_channel_clients(uuid), pulse.agent_own_line(text, uuid),
  pulse.agent_follow_up(text[]), pulse.agent_call_missed(), pulse.agent_own_context(text, uuid), pulse.agent_own_dispatch(uuid, uuid, text, text),
  pulse.agent_propose_own(uuid, text, text, uuid), pulse.agent_proposal_urgent(uuid), pulse.agent_workload(date), pulse.agent_cards_waiting(uuid), pulse.agent_proposals_replace(uuid, uuid[]) from public;
grant execute on function pulse.agent_follow_up(text[]), pulse.agent_own_dispatch(uuid, uuid, text, text), pulse.agent_work_hours_words(), pulse.agent_propose_own(uuid, text, text, uuid),
  pulse.agent_proposal_urgent(uuid), pulse.agent_workload(date), pulse.agent_cards_waiting(uuid), pulse.agent_proposals_replace(uuid, uuid[]) to pulse_api;

-- migrate:down
-- Forward-only.
