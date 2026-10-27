-- migrate:up
-- AI-AUTONOMY (owner, 27 Oct 2026): "AI employees must be highly independent, autonomous and actually working." On
-- production the Operations Chief (AI) got "hi" from the CEO in a direct message and, instead of answering him, sent its
-- approver a card ("I have not answered there. This is what I would post: Send it / Edit / Don't"). The cause: every AI
-- employee with operations access was forced to "ask first" on everything (0965), and most were set to ask first on
-- direct messages too. Asking first now applies only to the actions that are genuinely risky, set per AI employee:
--   agent_member.risk_policy  {"internal": "send" | "ask",       colleagues' chats and direct messages (default send)
--                              "clients": "ask" | "send",        messages to clients (send only once the organisation allows it)
--                              "money": "ask" | "send",          prices, discounts, refunds, payments, invoices
--                              "delete": "ask",                  deleting data (always a person; Pulse refuses an AI delete)
--                              "legalHr": "ask" | "send",        legal and HR decisions (contracts, hiring, pay, warnings)
--                              "costLimit": rupees}              any amount above this asks first, whatever "money" says
--   agent_org_policy          per organisation: whether any AI employee may write to clients on its own (off by default).
-- Leadership's direct messages are always answered directly (agent_dispatch), whatever the settings. The risk of each
-- message is judged by the runtime (services/coworker/risk-policy.mjs: the model's own "risk" list and plain patterns);
-- a risky message becomes one card for its approver, the colleague hears that it is being confirmed.
-- Existing AI employees move to the new default: "ask first" on direct messages and mentions becomes "on its own".

alter table pulse.agent_member add column if not exists risk_policy jsonb not null default '{}'::jsonb
  check (jsonb_typeof(risk_policy) = 'object' and length(risk_policy::text) <= 2000);

create table if not exists pulse.agent_org_policy (
  org_id uuid primary key references pulse.org(id),
  clients_on boolean not null default false,
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);
alter table pulse.agent_org_policy enable row level security;
alter table pulse.agent_org_policy force row level security;
create policy tenant on pulse.agent_org_policy using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.agent_org_policy to pulse_api;
create or replace trigger ea_ai_no_write before insert or update or delete on pulse.agent_org_policy for each statement execute function pulse.agent_guard();

-- The defaults, then the AI employee's own choices, then the organisation's switch for clients.
create or replace function pulse.agent_policy_of(m pulse.agent_member) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select p || jsonb_build_object('clientsAllowed', o.on_, 'clients', case when o.on_ then coalesce(p->>'clients', 'ask') else 'ask' end, 'delete', 'ask')
    from (select '{"internal":"send","clients":"ask","money":"ask","delete":"ask","legalHr":"ask","costLimit":25000}'::jsonb || coalesce(m.risk_policy, '{}'::jsonb) p) x,
         (select coalesce((select clients_on from agent_org_policy where org_id = m.org_id), false) on_) o
$$;
create or replace function pulse.agent_policy(p_agent uuid) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select agent_policy_of(m) from agent_member m where m.person_id = p_agent and m.org_id = current_org()
$$;
-- Whether this AI employee may post in a conversation with a client without a person's yes.
create or replace function pulse.agent_clients_ok(p_agent uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select agent_policy(p_agent)->>'clients' = 'send'), false)
$$;

-- 0965's rule "operations access always asks first" is gone: access says what it may see and touch; the risk policy says
-- when it asks.
create or replace function pulse.agent_mode_for(m pulse.agent_member, p_event_type text) returns text language sql stable set search_path = pulse, pg_temp as $$
  select coalesce(nullif(m.autonomy->>(case p_event_type when 'chat.message' then 'direct' when 'chat.group' then 'group' else 'mention' end), ''), 'off')
$$;
create or replace function pulse.agent_access_rules() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.access is distinct from old.access then
    if agent_session() is not null then raise exception 'An AI employee does not change its own access' using errcode='42501'; end if;
    if current_viewer() is not null and not viewer_is('admin') then raise exception 'Only an admin changes an AI employee''s access' using errcode='42501'; end if;
  end if;
  if tg_op = 'INSERT' and new.access <> 'standard' and current_viewer() is not null and not viewer_is('admin') then
    raise exception 'Only an admin gives an AI employee operations access' using errcode='42501'; end if;
  if tg_op = 'UPDATE' and new.risk_policy is distinct from old.risk_policy and agent_session() is not null then
    raise exception 'An AI employee does not change its own risk policy' using errcode='42501'; end if;
  return new;
end $$;
drop trigger if exists agent_access_rules on pulse.agent_member;
create trigger agent_access_rules before insert or update of access, autonomy, risk_policy on pulse.agent_member for each row execute function pulse.agent_access_rules();
create or replace function pulse.agent_access_set(p_agent uuid, p_access text) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or not viewer_is('admin') then raise exception 'Only an admin changes an AI employee''s access' using errcode='42501'; end if;
  if p_access is null or p_access not in ('standard','operations') then raise exception 'Choose standard or operations access' using errcode='22023'; end if;
  perform agent_lock(p_agent);
  update agent_member set access = p_access where person_id = p_agent and org_id = current_org();
  if not found then raise exception 'Choose an AI employee' using errcode='22023'; end if;
  perform audit_write('agent_access_set', 'agent_member', p_agent::text || ':' || p_access);
end $$;

-- An AI employee posts to a client on its own only when its organisation and its risk policy allow it; otherwise a
-- message a person approved (0965).
create or replace function pulse.agent_client_guard() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null and new.author_id = agent_session() and coalesce(current_setting('pulse.agent_approved', true), '') = ''
     and chat_client_facing(new.channel_id) and not agent_clients_ok(new.author_id) then
    raise exception 'An AI employee writes to clients only after a person approves the message' using errcode='42501';
  end if;
  return new;
end $$;

-- The organisation's switch (admins and leadership), audited.
create or replace function pulse.agent_org_policy_set(p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or not viewer_is('admin', 'leadership') then raise exception 'Admins and leadership set what AI employees may do on their own' using errcode='42501'; end if;
  if jsonb_typeof(p) is distinct from 'object' or jsonb_typeof(p->'clientsOn') is distinct from 'boolean' then raise exception 'Say whether AI employees may write to clients on their own' using errcode='22023'; end if;
  insert into agent_org_policy(org_id, clients_on, updated_by, updated_at) values (current_org(), (p->>'clientsOn')::boolean, current_viewer(), now())
  on conflict (org_id) do update set clients_on = excluded.clients_on, updated_by = excluded.updated_by, updated_at = now();
  perform audit_write('agent_org_policy_set', 'agent_org_policy', 'clientsOn:' || (p->>'clientsOn'));
  return jsonb_build_object('clientsOn', (p->>'clientsOn')::boolean);
end $$;
create or replace function pulse.agent_org_policy_read() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('clientsOn', coalesce((select clients_on from agent_org_policy where org_id = current_org()), false))
$$;

-- 0954's settings, plus its risk policy. Its managers may make it ask first more often; letting it act on its own on a
-- risky kind of action is for admins and leadership.
create or replace function pulse.agent_ai_save(p_agent uuid, p jsonb) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k text; v text; a uuid; l text; cur jsonb;
begin
  if not agent_manage_ok(p_agent) then raise exception 'Admins, HR, leadership or its manager change an AI employee' using errcode='42501'; end if;
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Send the settings' using errcode='22023'; end if;
  perform agent_lock(p_agent);
  if p ? 'listensTo' then
    if p->>'listensTo' not in ('leaders','everyone') then raise exception 'Choose leaders or everyone' using errcode='22023'; end if;
    update agent_member set listens_to = p->>'listensTo' where person_id = p_agent;
  end if;
  if p ? 'autonomy' then
    if jsonb_typeof(p->'autonomy') is distinct from 'object' then raise exception 'Choose how it acts' using errcode='22023'; end if;
    for k, v in select key, value from jsonb_each_text(p->'autonomy') loop
      if k not in ('direct','mention','group') or v not in ('own','approve','off') then raise exception 'Choose on its own, ask first or stay out' using errcode='22023'; end if;
    end loop;
    update agent_member set autonomy = autonomy || (p->'autonomy') where person_id = p_agent;
  end if;
  if p ? 'riskPolicy' then
    if jsonb_typeof(p->'riskPolicy') is distinct from 'object' then raise exception 'Choose when it asks first' using errcode='22023'; end if;
    select risk_policy into cur from agent_member where person_id = p_agent;
    for k, v in select key, value from jsonb_each_text(p->'riskPolicy') loop
      if k = 'costLimit' then
        if v !~ '^\d{1,9}$' then raise exception 'Give the cost limit in whole rupees' using errcode='22023'; end if;
        if v::bigint > coalesce((cur->>'costLimit')::bigint, 25000) and not viewer_is('admin', 'leadership') then
          raise exception 'Admins and leadership raise the cost limit' using errcode='42501'; end if;
      elsif k = 'delete' then
        if v <> 'ask' then raise exception 'Deleting data always waits for a person' using errcode='22023'; end if;
      elsif k in ('internal', 'clients', 'money', 'legalHr') then
        if v not in ('send', 'ask') then raise exception 'Choose on its own or ask first' using errcode='22023'; end if;
        if v = 'send' and k <> 'internal' and coalesce(cur->>k, 'ask') <> 'send' and not viewer_is('admin', 'leadership') then
          raise exception 'Admins and leadership let an AI employee act on its own there' using errcode='42501'; end if;
      else raise exception 'Unknown risk: %', k using errcode='22023';
      end if;
    end loop;
    update agent_member set risk_policy = risk_policy || (p->'riskPolicy')
      || case when p->'riskPolicy' ? 'costLimit' then jsonb_build_object('costLimit', (p->'riskPolicy'->>'costLimit')::bigint) else '{}'::jsonb end
     where person_id = p_agent;
    perform audit_write('agent_risk_policy', 'agent_member', p_agent::text);
  end if;
  if p ? 'approverId' then
    a := nullif(p->>'approverId', '')::uuid;
    if a is not null and not exists(select 1 from person where id = a and org_id = current_org() and side = 'staff' and status = 'active') then
      raise exception 'Its approver is an active person in this company' using errcode='22023'; end if;
    update agent_member set approver_person_id = a where person_id = p_agent;
  end if;
  if p ? 'instructions' then
    if length(coalesce(p->>'instructions', '')) > 8000 then raise exception 'Instructions of up to 8,000 characters' using errcode='22023'; end if;
    update agent_member set instructions = btrim(coalesce(p->>'instructions', '')) where person_id = p_agent;
  end if;
  if p ? 'sopLinks' then
    if jsonb_typeof(p->'sopLinks') is distinct from 'array' or jsonb_array_length(p->'sopLinks') > 20 then raise exception 'Up to 20 SOP links' using errcode='22023'; end if;
    for l in select jsonb_array_elements_text(p->'sopLinks') loop
      if length(l) > 1000 or l !~ '^(https?://[^[:space:]]+|/[^[:space:]]+)$' then raise exception 'An SOP link is a web address or a Pulse page' using errcode='22023'; end if;
    end loop;
    update agent_member set sop_links = array(select distinct x from jsonb_array_elements_text(p->'sopLinks') x) where person_id = p_agent;
  end if;
  if p ? 'mcpServers' then
    if jsonb_typeof(p->'mcpServers') is distinct from 'array' or jsonb_array_length(p->'mcpServers') > 20 then raise exception 'Up to 20 MCP servers' using errcode='22023'; end if;
    for l in select jsonb_array_elements_text(p->'mcpServers') loop
      if l !~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,60}$' then raise exception 'Name each MCP server in letters, digits, dots and dashes' using errcode='22023'; end if;
    end loop;
    update agent_member set mcp_servers = array(select distinct btrim(x) from jsonb_array_elements_text(p->'mcpServers') x) where person_id = p_agent;
  end if;
end $$;

-- 1051's dispatch (the live definition), with the risk policy deciding the mode (AI-AUTONOMY lines) and in its context.
create or replace function pulse.agent_dispatch(p_id uuid, p_token uuid, p_lane text, p_model text)
 returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); e agent_event; m agent_member; msg chat_message; why text; busy text; committed int; rid uuid; dl timestamptz;
  ch_kind text; approver uuid; mode text; cf boolean; pol jsonb; is_lead boolean;
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
  if mode = 'off' and e.event_type = 'chat.group' and agent_group_role(me, msg.channel_id) = 'coordinator' then mode := 'approve'; end if;
  if mode = 'approve' and ch_kind = 'direct' and msg.author_id = approver then mode := 'own'; end if;
  -- AI-AUTONOMY (1230): with colleagues it acts on its own (its risk policy holds back only the risky messages, in the
  -- runtime); leadership's direct messages are always answered; with a client it asks first unless allowed.
  cf := chat_client_facing(msg.channel_id); pol := agent_policy_of(m); is_lead := agent_leader(msg.author_id);
  if not cf then
    if ch_kind = 'direct' and (is_lead or msg.author_id = approver) then mode := 'own';
    elsif mode = 'approve' and pol->>'internal' = 'send' then mode := 'own';
    elsif mode = 'own' and pol->>'internal' = 'ask' then mode := 'approve';
    end if;
  elsif mode = 'own' and pol->>'clients' <> 'send' then mode := 'approve';
  end if;
  return jsonb_build_object('status', 'dispatched', 'runId', rid, 'reserved', m.run_reserve,
    'deadline', to_char(dl at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'context', jsonb_build_object(
      'mode', mode, 'kind', e.event_type, 'askerIsApprover', msg.author_id = approver, 'askerIsLeader', is_lead, 'clientFacing', cf, 'policy', pol, 'groupRole', agent_group_role(me, msg.channel_id),
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
                   where x.channel_id = msg.channel_id and x.removed_at is null and x.kind = 'text' and x.created_at <= msg.created_at and x.import_ref is null
                     and btrim(coalesce(x.body, '')) <> ''
                     and not exists(select 1 from agent_proposal pr where pr.dm_message_id = x.id)
                   order by x.created_at desc limit 14) r)));
end $$;

-- Existing AI employees: "ask first" on direct messages and mentions becomes "on its own" (its risk policy still holds
-- back the risky messages; a client conversation still asks first).
update pulse.agent_member set autonomy = autonomy
  || case when autonomy->>'direct' = 'approve' then '{"direct":"own"}'::jsonb else '{}'::jsonb end
  || case when autonomy->>'mention' = 'approve' then '{"mention":"own"}'::jsonb else '{}'::jsonb end
 where autonomy->>'direct' = 'approve' or autonomy->>'mention' = 'approve';
alter table pulse.agent_member alter column autonomy set default '{"direct":"own","mention":"own","group":"off"}'::jsonb;

revoke all on function pulse.agent_policy_of(pulse.agent_member), pulse.agent_policy(uuid), pulse.agent_clients_ok(uuid),
  pulse.agent_org_policy_set(jsonb), pulse.agent_org_policy_read() from public;
grant execute on function pulse.agent_policy_of(pulse.agent_member), pulse.agent_policy(uuid), pulse.agent_clients_ok(uuid), pulse.agent_org_policy_set(jsonb), pulse.agent_org_policy_read() to pulse_api;

-- migrate:down
-- Forward-only: the policy and who changed it stay auditable; set an AI employee's risks to "ask" to narrow it.
