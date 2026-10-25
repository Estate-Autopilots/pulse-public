-- migrate:up
-- SIM-CLIENTS (owner, 25 Oct 2026): "AI employees should talk to other employees before sending a message, and if
-- told to, do it." An AI employee that needs a colleague's input before it can answer someone (a client asking when the
-- drone shots are ready) asks that colleague in a direct message first ("consult"), waits for the answer, and then acts on
-- it: it drafts the reply to the person who asked (with a client, a person still approves it: Send it / Edit / Don't),
-- it can also propose a task, and it reminds the colleague once, then tells its approver, when nobody answers. A staff
-- member who tells it in a direct message to say something in one of its conversations ("tell Anil the reels go live on
-- Friday") gets it done: posted in an internal conversation, or, with a client in it, put in front of that same staff
-- member as one card to send.
--
-- Additive: a table, functions, two triggers. The only replaced objects are agent_propose / agent_propose_task (one
-- reply proposal and one task proposal may now come from the same run; the unique index moves from run to run + kind).
-- agent_dispatch and agent_event_from_chat are not touched: a colleague's answer becomes an event of its own type
-- (consult.answer) dispatched by agent_consult_dispatch.

create table pulse.agent_consult (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references pulse.agent_member(person_id),
  run_id uuid references pulse.agent_run(id),
  source_channel_id uuid not null references pulse.chat_channel(id),
  source_message_id uuid references pulse.chat_message(id),
  source_kind text not null default 'chat.group',
  asker_id uuid references pulse.person(id),
  colleague_id uuid not null references pulse.person(id),
  dm_channel_id uuid not null references pulse.chat_channel(id),
  question text not null check (length(btrim(question)) between 3 and 1500),
  question_message_id uuid,
  state text not null default 'open' check (state in ('open','answered','relayed','closed','expired')),
  answer_message_id uuid,
  answered_at timestamptz,
  nudged_at timestamptz,
  escalated_at timestamptz,
  escalated_from uuid references pulse.agent_consult(id),
  relay_proposal_id uuid,
  relay_message_id uuid,
  created_at timestamptz not null default now()
);
create index agent_consult_dm on pulse.agent_consult (org_id, agent_id, dm_channel_id, colleague_id, created_at desc) where state in ('open','answered');
create index agent_consult_open on pulse.agent_consult (org_id, agent_id, created_at) where state = 'open';
create index agent_consult_run on pulse.agent_consult (run_id);
alter table pulse.agent_consult enable row level security;
alter table pulse.agent_consult force row level security;
create policy tenant on pulse.agent_consult using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.agent_consult to pulse_api;

-- One reply proposal and one task proposal per run (a revision: "noted, the editor is on it" and the editor's task).
drop index if exists pulse.agent_proposal_run;
create unique index agent_proposal_run on pulse.agent_proposal (run_id, kind) where run_id is not null;

/** The direct conversation between two people (made when missing; both are members). */
create or replace function pulse.agent_dm_with(p_a uuid, p_b uuid) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k text := 'dm:' || least(p_a::text, p_b::text) || ':' || greatest(p_a::text, p_b::text); dm uuid;
begin
  insert into chat_channel(org_id, key, name, kind, description) values (current_org(), k, 'Direct message', 'direct', 'A private conversation')
  on conflict (org_id, key) do update set key = excluded.key returning id into dm;
  insert into chat_member(org_id, channel_id, person_id) values (current_org(), dm, p_a), (current_org(), dm, p_b) on conflict do nothing;
  return dm;
end $$;
revoke all on function pulse.agent_dm_with(uuid, uuid) from public;

/** Who an AI employee may ask before it answers: the active staff of its organisation, by @username, with role, pod
 *  and team, and the people of the conversation first. Names only, nothing private. */
create or replace function pulse.agent_colleagues(p_channel uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  return (select coalesce(jsonb_agg(x.j order by x.here desc, x.n), '[]'::jsonb) from (
    select p.display_name n, exists(select 1 from chat_member cm where cm.channel_id = p_channel and cm.person_id = p.id) here,
           jsonb_strip_nulls(jsonb_build_object('name', p.display_name, 'username', pp.username, 'role', nullif(pp.role, ''), 'pod', nullif(pp.pod, ''),
             'team', nullif(pp.department, ''), 'inThisChat', case when exists(select 1 from chat_member cm where cm.channel_id = p_channel and cm.person_id = p.id) then true end,
             'leader', case when agent_leader(p.id) then true end)) j
      from person p join people_profile pp on pp.person_id = p.id
     where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' and pp.username is not null and p.id <> me
     order by 2 desc, p.display_name limit 80) x);
end $$;

/** Its conversations (groups it is in), for "tell X in Y": id, name, whether a client is in it. */
create or replace function pulse.agent_conversations() returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', ch.id, 'name', ch.name, 'withClient', chat_client_facing(ch.id)) order by ch.name), '[]'::jsonb)
    from chat_channel ch join chat_member cm on cm.channel_id = ch.id and cm.person_id = me
   where ch.org_id = current_org() and ch.kind <> 'direct');
end $$;

/** Inside a run about a message: ask a colleague (by @username) in a direct message before answering. Returns the
 *  consult; the same run asking the same colleague again returns the first one. At most three per run. */
create or replace function pulse.agent_consult_ask(p_run uuid, p_to text, p_question text, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; e agent_event; msg chat_message; ch chat_channel; to_id uuid; to_name text; dm uuid; mid uuid; cid uuid;
  q text := left(btrim(regexp_replace(coalesce(p_question, ''), '[ \t]+', ' ', 'g')), 1500); who text; src_ch uuid; src_msg uuid; src_kind text; asker uuid; prior agent_consult;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if length(q) < 3 then raise exception 'Write the question' using errcode='22023'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Ask inside the run' using errcode='42501'; end if;
  select * into e from agent_event where id = r.event_id;
  if e.subject_type <> 'message' then raise exception 'That run is not about a message' using errcode='22023'; end if;
  select * into msg from chat_message where id = e.subject_id;
  select p.id, p.display_name into to_id, to_name from person p join people_profile pp on pp.person_id = p.id
   where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' and lower(pp.username) = lower(btrim(coalesce(p_to, ''), ' @')) and p.id <> me;
  if to_id is null then raise exception 'Choose a colleague by their @username' using errcode='22023'; end if;
  -- Asked while answering a colleague's answer (a consult.answer run): the new question carries the original asker's place.
  select * into prior from agent_consult where org_id = current_org() and agent_id = me and dm_channel_id = msg.channel_id and answer_message_id is not null
     and e.event_type = 'consult.answer' order by created_at desc limit 1;
  if prior.id is not null then src_ch := prior.source_channel_id; src_msg := prior.source_message_id; src_kind := prior.source_kind; asker := prior.asker_id;
  else src_ch := msg.channel_id; src_msg := msg.id; src_kind := e.event_type; asker := msg.author_id; end if;
  select id into cid from agent_consult where run_id = r.id and colleague_id = to_id;
  if found then return (select jsonb_build_object('id', c.id, 'chatId', c.dm_channel_id, 'messageId', c.question_message_id, 'to', to_name) from agent_consult c where c.id = cid); end if;
  if (select count(*) from agent_consult where run_id = r.id) >= 3 then raise exception 'Three questions per answer are enough' using errcode='22023'; end if;
  select * into ch from chat_channel where id = src_ch;
  select display_name into who from person where id = asker;
  dm := agent_dm_with(me, to_id);
  insert into agent_consult(org_id, agent_id, run_id, source_channel_id, source_message_id, source_kind, asker_id, colleague_id, dm_channel_id, question)
  values (current_org(), me, r.id, src_ch, src_msg, coalesce(src_kind, 'chat.group'), asker, to_id, dm, q) returning id into cid;
  mid := chat_send(dm, q || chr(10) || chr(10) || '(For ' || coalesce(who, 'someone') || ' in ' || case when ch.kind = 'direct' then 'a direct message' else '“' || ch.name || '”' end
      || case when chat_client_facing(src_ch) then ', a client conversation' else '' end || '. Reply here and I will take it from there.)', null, '[]'::jsonb, p_client, null);
  update agent_consult set question_message_id = mid where id = cid;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  return jsonb_build_object('id', cid, 'chatId', dm, 'messageId', mid, 'to', to_name);
end $$;

/** A colleague's answer in the direct message it asked in becomes that AI employee's work (consult.answer), whatever
 *  it listens to otherwise; an answer that decided one of its cards ("fine, send it") is left alone. Runs after
 *  agent_event_from_chat (trigger names sort), so the event that trigger made for the same message is turned into this one. */
create or replace function pulse.agent_consult_answer() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c agent_consult;
begin
  if new.kind <> 'text' or new.removed_at is not null or btrim(coalesce(new.body, '')) = '' then return null; end if;
  if exists(select 1 from person where id = new.author_id and side <> 'staff') then return null; end if;
  if exists(select 1 from agent_proposal where decision_message_id = new.id) then return null; end if;
  for c in select distinct on (agent_id) * from agent_consult
            where org_id = new.org_id and dm_channel_id = new.channel_id and colleague_id = new.author_id and state in ('open','answered')
              and created_at > now() - interval '3 days' order by agent_id, created_at desc loop
    if not exists(select 1 from agent_member m join person p on p.id = m.person_id where m.person_id = c.agent_id and m.disabled_at is null and p.status = 'active') then continue; end if;
    update agent_consult set state = 'answered', answer_message_id = coalesce(answer_message_id, new.id), answered_at = coalesce(answered_at, now()) where id = c.id;
    update agent_event set event_type = 'consult.answer' where org_id = new.org_id and agent_id = c.agent_id and event_key = 'message:' || new.id and state = 'queued';
    if not found then
      insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
      values (new.org_id, c.agent_id, 'consult.answer', 'message', new.id, 'message:' || new.id, new.author_id) on conflict do nothing;
    end if;
  end loop;
  return null;
end $$;
create trigger agent_zconsult_answer after insert on pulse.chat_message for each row execute function pulse.agent_consult_answer();

/** The context of a consult.answer run: the colleague's answer, the direct message so far, the question and the
 *  conversation it came from (who asked, what they said, whether a client is in it, who approves there). */
create or replace function pulse.agent_consult_context(p_msg uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
  select jsonb_build_object('id', c.id, 'question', c.question, 'colleague', col.display_name, 'asker', ask.display_name,
    'sourceChannelId', c.source_channel_id, 'sourceChannelName', case when sch.kind = 'direct' then 'a direct message' else sch.name end,
    'sourceMessage', left(sm.body, 1500), 'clientFacing', chat_client_facing(c.source_channel_id),
    'approver', (select display_name from person where id = agent_approver_for(c.agent_id, c.source_channel_id)),
    'sourceRecent', (select coalesce(jsonb_agg(r.j order by r.at), '[]'::jsonb) from (
        select x.created_at at, jsonb_build_object('author', p.display_name, 'mine', x.author_id = c.agent_id, 'body', left(x.body, 500)) j
          from chat_message x join person p on p.id = x.author_id
         where x.channel_id = c.source_channel_id and x.removed_at is null and x.kind = 'text' and btrim(coalesce(x.body, '')) <> ''
         order by x.created_at desc limit 8) r))
    from chat_message m join agent_consult c on c.dm_channel_id = m.channel_id and c.colleague_id = m.author_id and c.agent_id = agent_session()
    join person col on col.id = c.colleague_id left join person ask on ask.id = c.asker_id
    join chat_channel sch on sch.id = c.source_channel_id left join chat_message sm on sm.id = c.source_message_id
   where m.id = p_msg and c.state in ('answered','relayed','open') order by c.created_at desc limit 1
$$;

/** Dispatch of a consult.answer event: like agent_dispatch (lease, budget, one run at a time), without "listens to
 *  leaders only" (it asked this colleague itself), in its own direct message with them (it answers them directly). */
create or replace function pulse.agent_consult_dispatch(p_id uuid, p_token uuid, p_lane text, p_model text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); e agent_event; m agent_member; msg chat_message; why text; busy text; committed int; rid uuid; dl timestamptz;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  m := agent_lock(me);
  select * into e from agent_event where id = p_id and org_id = current_org() and agent_id = me for update;
  if not found or e.state <> 'leased' or e.lease_token is distinct from p_token or e.lease_until <= now() then
    raise exception 'That event is not leased to you any more' using errcode='22023'; end if;
  perform agent_sweep(me);
  select * into msg from chat_message where id = e.subject_id;
  why := case
    when e.event_type <> 'consult.answer' or e.subject_type <> 'message' then 'not_consult'
    when msg.id is null or msg.removed_at is not null then 'message_gone'
    when not exists(select 1 from chat_member where channel_id = msg.channel_id and person_id = me) then 'agent_left'
    when not exists(select 1 from agent_consult c where c.agent_id = me and c.dm_channel_id = msg.channel_id and c.colleague_id = msg.author_id) then 'no_consult'
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
    'context', jsonb_build_object('mode', 'own', 'kind', 'consult.answer', 'askerIsApprover', false,
      'approver', (select display_name from person where id = coalesce(m.approver_person_id, m.owner_person_id)),
      'now', to_char(now() at time zone org_time_zone(), 'FMDay DD Mon YYYY, HH24:MI'), 'timeZone', org_time_zone(), 'newer', false,
      'instructions', left(m.instructions, 8000), 'sops', to_jsonb(m.sop_links),
      'memory', (select coalesce(jsonb_agg(left(x.body, 400) order by x.created_at desc), '[]'::jsonb) from (
                  select body, created_at from agent_memory where agent_id = me and retired_at is null order by created_at desc limit 20) x),
      'message', (select jsonb_build_object('id', x.id, 'channelId', x.channel_id, 'parentId', x.parent_id, 'body', left(x.body, 2000),
                    'author', p.display_name, 'channelKind', ch.kind, 'channelName', null)
                  from chat_message x join person p on p.id = x.author_id join chat_channel ch on ch.id = x.channel_id where x.id = msg.id),
      'recent', (select coalesce(jsonb_agg(r.j order by r.at), '[]'::jsonb) from (
                  select x.created_at at, jsonb_build_object('author', p.display_name, 'byAgent', p.side = 'agent', 'mine', x.author_id = me, 'body', left(x.body, 600)) j
                    from chat_message x join person p on p.id = x.author_id
                   where x.channel_id = msg.channel_id and x.removed_at is null and x.kind = 'text' and x.created_at <= msg.created_at
                     and btrim(coalesce(x.body, '')) <> '' and not exists(select 1 from agent_proposal pr where pr.dm_message_id = x.id)
                   order by x.created_at desc limit 10) r),
      'consult', agent_consult_context(msg.id)));
end $$;

/** After the colleague answered: the reply to whoever asked, in the conversation they asked in. With a client there, or
 *  where it asks first, a card for its approver there (Send it / Edit / Don't, saying whom it checked with); in an
 *  internal conversation where it answers on its own, posted. */
create or replace function pulse.agent_consult_relay(p_run uuid, p_consult uuid, p_body text, p_why text, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; c agent_consult; m agent_member; b text := btrim(coalesce(p_body, '')); ap uuid; dm uuid; pid uuid; mid uuid; ch chat_channel;
  who text; col text; ans text; w text := left(nullif(btrim(coalesce(p_why, '')), ''), 900);
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if length(b) not between 1 and 4000 then raise exception 'Write the reply in up to 4,000 characters' using errcode='22023'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Relay inside the run' using errcode='42501'; end if;
  select * into c from agent_consult where id = p_consult and org_id = current_org() and agent_id = me for update;
  if not found then raise exception 'Not found' using errcode='P0002'; end if;
  if c.relay_proposal_id is not null or c.relay_message_id is not null then
    return jsonb_build_object('consult', c.id, 'proposal', c.relay_proposal_id, 'messageId', c.relay_message_id); end if;
  if not exists(select 1 from chat_member where channel_id = c.source_channel_id and person_id = me) then raise exception 'It is no longer in that conversation' using errcode='22023'; end if;
  select * into m from agent_member where person_id = me;
  select * into ch from chat_channel where id = c.source_channel_id;
  if not chat_client_facing(c.source_channel_id) and agent_mode_for(m, c.source_kind) = 'own' then
    mid := chat_send(c.source_channel_id, b, null, '[]'::jsonb, p_client, c.source_message_id);
    insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
    update agent_consult set state = 'relayed', relay_message_id = mid where id = c.id;
    update agent_consult set state = 'closed' where org_id = current_org() and agent_id = me and source_message_id = c.source_message_id and state in ('open','answered') and id <> c.id;
    return jsonb_build_object('consult', c.id, 'messageId', mid);
  end if;
  ap := agent_approver_for(me, c.source_channel_id);
  if ap is null then raise exception 'It has nobody to ask' using errcode='22023'; end if;
  dm := agent_dm_with(me, ap);
  select display_name into who from person where id = c.asker_id;
  select display_name into col from person where id = c.colleague_id;
  select left(regexp_replace(body, '\s+', ' ', 'g'), 280) into ans from chat_message where id = c.answer_message_id;
  insert into agent_proposal(org_id, agent_id, run_id, channel_id, source_message_id, approver_id, dm_channel_id, kind, body, why)
  values (current_org(), me, r.id, c.source_channel_id, c.source_message_id, ap, dm, 'reply', b,
    left(concat_ws(' ', 'Checked with ' || col || ' first' || coalesce(': “' || ans || '”', '') || '.', w), 1000)) returning id into pid;
  mid := chat_send(dm, coalesce(who, 'Someone') || ' asked in ' || case when ch.kind = 'direct' then 'a direct message' else '“' || ch.name || '”' end || ':' || chr(10) || '“'
      || left(regexp_replace(coalesce((select body from chat_message where id = c.source_message_id), ''), '\s+', ' ', 'g'), 280) || '”' || chr(10)
      || 'I asked ' || col || ' first' || case when ap = c.colleague_id then ' (you)' else '' end || ' and wrote the answer from theirs. This is what I would post: Send it, Edit, or Don''t (a reply like “fine, send it” works too).',
      null, '[]'::jsonb, p_client, null);
  update agent_proposal set dm_message_id = mid where id = pid;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  update agent_consult set state = 'relayed', relay_proposal_id = pid where id = c.id;
  update agent_consult set state = 'closed' where org_id = current_org() and agent_id = me and source_message_id = c.source_message_id and state in ('open','answered') and id <> c.id;
  return jsonb_build_object('consult', c.id, 'proposal', pid, 'messageId', mid, 'chatId', dm);
end $$;

/** A staff member told it, in a direct message, to say something in one of its conversations: in an internal
 *  conversation where it answers on its own it posts; with a client in it (or where it asks first), the card goes to
 *  the person who told it, in that same direct message, when they are in that conversation or lead; else to its approver. */
create or replace function pulse.agent_relay_instructed(p_run uuid, p_channel uuid, p_body text, p_why text, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; e agent_event; msg chat_message; m agent_member; b text := btrim(coalesce(p_body, '')); ap uuid; dm uuid; pid uuid; mid uuid; ch chat_channel; boss text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if length(b) not between 1 and 4000 then raise exception 'Write the message in up to 4,000 characters' using errcode='22023'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Post inside the run' using errcode='42501'; end if;
  select * into e from agent_event where id = r.event_id;
  select * into msg from chat_message where id = e.subject_id;
  if e.subject_type <> 'message' or (select kind from chat_channel where id = msg.channel_id) <> 'direct'
     or not exists(select 1 from person where id = msg.author_id and side = 'staff' and status = 'active') then
    raise exception 'Only a colleague''s direct message can ask it to say something elsewhere' using errcode='42501'; end if;
  select * into ch from chat_channel where id = p_channel and org_id = current_org();
  if ch.id is null or ch.kind = 'direct' or not exists(select 1 from chat_member where channel_id = p_channel and person_id = me) then
    raise exception 'Choose one of its conversations' using errcode='22023'; end if;
  select * into m from agent_member where person_id = me;
  if not chat_client_facing(p_channel) and m.access <> 'operations' then
    mid := chat_send(p_channel, b, null, '[]'::jsonb, p_client, null);
    insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
    return jsonb_build_object('messageId', mid, 'channelId', p_channel, 'posted', true);
  end if;
  ap := case when exists(select 1 from chat_member where channel_id = p_channel and person_id = msg.author_id) or agent_leader(msg.author_id)
                  or msg.author_id = agent_approver_for(me, p_channel) then msg.author_id else agent_approver_for(me, p_channel) end;
  if ap is null then raise exception 'It has nobody to ask' using errcode='22023'; end if;
  dm := agent_dm_with(me, ap);
  select display_name into boss from person where id = msg.author_id;
  insert into agent_proposal(org_id, agent_id, run_id, channel_id, source_message_id, approver_id, dm_channel_id, kind, body, why)
  values (current_org(), me, r.id, p_channel, null, ap, dm, 'reply', b, left(coalesce('Asked by ' || boss || '. ', '') || coalesce(p_why, ''), 1000)) returning id into pid;
  mid := chat_send(dm, case when ap = msg.author_id then 'Ready to post in “' || ch.name || '”' || case when chat_client_facing(p_channel) then ' (a client conversation)' else '' end || ': Send it, Edit, or Don''t.'
      else boss || ' asked me to post this in “' || ch.name || '”. Send it, Edit, or Don''t.' end, null, '[]'::jsonb, p_client, null);
  update agent_proposal set dm_message_id = mid where id = pid;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  return jsonb_build_object('proposal', pid, 'messageId', mid, 'chatId', dm, 'posted', false);
end $$;

/** Follow-up on its open questions (the runtime calls this every few minutes): unanswered after 2 hours, one gentle
 *  reminder to the colleague; after 6 hours, its approver is asked to answer or say who can (that becomes a question
 *  of its own); after 3 days, closed as expired. Returns what it did. */
create or replace function pulse.agent_consults_sweep() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); c agent_consult; ap uuid; dm uuid; nudged int := 0; escalated int := 0; expired int := 0; who text; col text; cid uuid; mid uuid;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  update agent_consult set state = 'expired' where org_id = current_org() and agent_id = me and state = 'open' and created_at < now() - interval '3 days';
  get diagnostics expired = row_count;
  for c in select * from agent_consult where org_id = current_org() and agent_id = me and state = 'open' and nudged_at is null and created_at < now() - interval '2 hours' for update skip locked loop
    select display_name into who from person where id = c.asker_id;
    mid := chat_send(c.dm_channel_id, 'A gentle reminder: ' || coalesce(who, 'someone') || ' is still waiting on this.' || chr(10) || '“' || left(c.question, 400) || '”',
      null, '[]'::jsonb, null, c.question_message_id);
    update agent_consult set nudged_at = now() where id = c.id; nudged := nudged + 1;
  end loop;
  for c in select * from agent_consult where org_id = current_org() and agent_id = me and state = 'open' and escalated_at is null and nudged_at is not null
             and created_at < now() - interval '6 hours' for update skip locked loop
    ap := agent_approver_for(me, c.source_channel_id);
    update agent_consult set escalated_at = now() where id = c.id;
    if ap is null or ap = c.colleague_id then continue; end if;
    select display_name into who from person where id = c.asker_id;
    select display_name into col from person where id = c.colleague_id;
    dm := agent_dm_with(me, ap);
    insert into agent_consult(org_id, agent_id, run_id, source_channel_id, source_message_id, source_kind, asker_id, colleague_id, dm_channel_id, question, escalated_from)
    values (current_org(), me, c.run_id, c.source_channel_id, c.source_message_id, c.source_kind, c.asker_id, ap, dm, c.question, c.id) returning id into cid;
    mid := chat_send(dm, col || ' has not answered my question for ' || coalesce(who, 'someone') || ' since ' || to_char(c.created_at at time zone org_time_zone(), 'FMDD Mon, HH24:MI')
      || ':' || chr(10) || '“' || left(c.question, 600) || '”' || chr(10) || 'Can you answer it, or tell me who can? Reply here and I will take it from there.', null, '[]'::jsonb, null, null);
    update agent_consult set question_message_id = mid where id = cid;
    escalated := escalated + 1;
  end loop;
  return jsonb_build_object('nudged', nudged, 'escalated', escalated, 'expired', expired);
end $$;

/** Added to a group by a person, an AI employee that speaks only in listed conversations gets that group on its list
 *  (people added it there to work there; before, it stayed silent there until an admin also listed the group). */
create or replace function pulse.agent_listed_on_join() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if agent_session() is not null then return null; end if;
  update agent_member set speak_channels = array_append(speak_channels, new.channel_id)
   where person_id = new.person_id and speak_scope = 'listed' and not (new.channel_id = any(speak_channels))
     and exists(select 1 from chat_channel where id = new.channel_id and kind <> 'direct');
  return null;
end $$;
create trigger agent_listed_on_join after insert on pulse.chat_member for each row execute function pulse.agent_listed_on_join();

-- agent_propose / agent_propose_task: as 0987, with the run's existing proposal looked up by kind (one of each).
do $do$
declare d text;
begin
  d := pg_get_functiondef('pulse.agent_propose(uuid,text,text,uuid)'::regprocedure);
  if position('select id into pid from agent_proposal where run_id = r.id;' in d) = 0 then raise exception 'agent_propose changed; update 1035'; end if;
  execute replace(d, 'select id into pid from agent_proposal where run_id = r.id;', 'select id into pid from agent_proposal where run_id = r.id and kind = ''reply'';');
  d := pg_get_functiondef('pulse.agent_propose_task(uuid,jsonb,text,uuid)'::regprocedure);
  if position('select id into pid from agent_proposal where run_id = r.id;' in d) = 0 then raise exception 'agent_propose_task changed; update 1035'; end if;
  execute replace(d, 'select id into pid from agent_proposal where run_id = r.id;', 'select id into pid from agent_proposal where run_id = r.id and kind = ''task'';');
end $do$;

-- SIM-CLIENTS: a client in a shared group (a connection's seat) is rung by a group call and can call the team. The seat
-- clause in chat_call_start / chat_call_invite never matched: notification_chat_member_current() counts staff only.
do $do$
declare d text;
begin
  d := pg_get_functiondef('pulse.chat_call_start(uuid,boolean,uuid[])'::regprocedure);
  if position('and notification_chat_member_current(p_channel,cm.person_id);' in d) = 0 then raise notice '1035: chat_call_start changed; clients are not rung (left as it is)'; else execute replace(d, 'and notification_chat_member_current(p_channel,cm.person_id);', 'and (notification_chat_member_current(p_channel,cm.person_id) or connect_is_seat(cm.person_id));'); end if;
  d := pg_get_functiondef('pulse.chat_call_invite(uuid,uuid[])'::regprocedure);
  if position('if kind<>''direct'' and not notification_chat_member_current(c.channel_id,p) then continue; end if;' in d) = 0 then raise notice '1035: chat_call_invite changed; left as it is'; else execute replace(d, 'if kind<>''direct'' and not notification_chat_member_current(c.channel_id,p) then continue; end if;',
    'if kind<>''direct'' and not notification_chat_member_current(c.channel_id,p) and not (connect_is_seat(p) and exists(select 1 from chat_member where channel_id=c.channel_id and person_id=p)) then continue; end if;'); end if;
end $do$;

-- SIM-CLIENTS: 1018 (GROUPS-HUB) left every AI employee without a group role deaf in groups: "not (group and role =
-- 'assistant')" is null when it has no role there, so no event was made (found when a client's complaint got no answer).
do $do$
declare d text := pg_get_functiondef('pulse.agent_event_from_chat()'::regprocedure);
begin
  if position('and not (x.kind = ''chat.group'' and ga.role = ''assistant'')' in d) > 0 then
    execute replace(d, 'and not (x.kind = ''chat.group'' and ga.role = ''assistant'')', 'and not (x.kind = ''chat.group'' and coalesce(ga.role, '''') = ''assistant'')');
  end if;
end $do$;

-- SIM-CLIENTS: a bare "yes, send it" to the AI's newest message in a direct message decided an older card instead (seen:
-- Tara answered the AI's question about Friday with "Yes ... Send it." and an unrelated Diwali reply went to the client).
-- A reply decides a card when it quotes the card, or when the card is the AI's newest message there.
do $do$
declare d text := pg_get_functiondef('pulse.agent_proposal_from_reply(uuid)'::regprocedure);
  a text := 'and (x.quote_id is null or x.quote_id = dm_message_id) order by created_at desc limit 1;';
begin
  if position(a in d) = 0 then raise notice '1035: agent_proposal_from_reply changed; left as it is'; return; end if;
  execute replace(d, a, 'and (x.quote_id = dm_message_id or (x.quote_id is null and not exists(select 1 from chat_message card join chat_message y on y.channel_id = card.channel_id
         and y.author_id = card.author_id and y.id <> card.id and y.created_at > card.created_at and y.created_at < x.created_at and y.removed_at is null
       where card.id = agent_proposal.dm_message_id))) order by created_at desc limit 1;');
end $do$;

revoke all on function pulse.agent_colleagues(uuid), pulse.agent_conversations(), pulse.agent_consult_ask(uuid, text, text, uuid), pulse.agent_consult_answer(),
  pulse.agent_consult_context(uuid), pulse.agent_consult_dispatch(uuid, uuid, text, text), pulse.agent_consult_relay(uuid, uuid, text, text, uuid),
  pulse.agent_relay_instructed(uuid, uuid, text, text, uuid), pulse.agent_consults_sweep(), pulse.agent_listed_on_join() from public;
grant execute on function pulse.agent_colleagues(uuid), pulse.agent_conversations(), pulse.agent_consult_ask(uuid, text, text, uuid),
  pulse.agent_consult_dispatch(uuid, uuid, text, text), pulse.agent_consult_relay(uuid, uuid, text, text, uuid),
  pulse.agent_relay_instructed(uuid, uuid, text, text, uuid), pulse.agent_consults_sweep() to pulse_api;

-- migrate:down
-- Forward-only.
