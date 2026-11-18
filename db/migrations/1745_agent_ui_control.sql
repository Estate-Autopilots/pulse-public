-- migrate:up
-- AGENT-UI-CONTROL (owner, 7 Nov 2026: "every AI employee must be able to control the whole Pulse screen for the person
-- it is helping, the way a human would"). An AI employee sends typed screen actions (open a page or a file beside the chat,
-- open or close the sidebar, open a tab, point at a control, type or add an emoji in the message box, open a form, ask
-- for a file, start or stop the microphone) to the browser of the person it is helping. Every action is checked here and
-- kept as a row (the audit trail); the person's browser hears about it over the realtime channel (NOTIFY pulse_ui, the
-- same LISTEN-and-stream pattern as chats) and reports back what happened.
--
-- 1. Who it may drive: only a person it is helping right now (they wrote, in the last 30 minutes, in a conversation the
--    AI employee is in). A person's own token drives only their own screen. Never a client's conversation.
-- 2. How far, per AI employee (pulse.agent_ui_level): off < view (show things: pages, the side panel, the sidebar, tabs,
--    point) < act (do things in the screen for them: type, emoji, forms, files, microphone) < admin (also Settings and
--    admin screens). Default view. Admins and leadership set it.
-- 3. Above its level it asks: one prompt in the top bar ("Pip wants to open … — Allow once / Always"). Admins and
--    leadership decide any prompt, and "Always" keeps that kind of action allowed (pulse.agent_ui_allow); the person it is
--    helping may allow once anything up to act on their own screen. Prompts end after 10 minutes.
-- 4. When it lacks something (a client is not in Clients), it posts an interactive card in the chat (Add client / Add task
--    / Add project / pick one) instead of failing; the person fills it in as themselves (their own permissions decide),
--    the card is marked done and a short line in the chat tells the AI employee to carry on.

-- ------------------------------------------------------------------------------------------------------ tables
create table pulse.agent_ui_level (
  org_id uuid not null references pulse.org(id),
  agent_id uuid not null references pulse.person(id),
  level text not null default 'view' check (level in ('off', 'view', 'act', 'admin')),
  set_by uuid references pulse.person(id),
  set_at timestamptz not null default clock_timestamp(),
  primary key (org_id, agent_id)
);
create table pulse.agent_ui_allow (
  org_id uuid not null references pulse.org(id),
  agent_id uuid not null references pulse.person(id),
  action text not null check (action ~ '^[a-z]+\.[a-z]+$'),
  level text not null check (level in ('view', 'act', 'admin')),
  granted_by uuid not null references pulse.person(id),
  granted_at timestamptz not null default clock_timestamp(),
  primary key (org_id, agent_id, action)
);
create table pulse.agent_ui_action (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  agent_id uuid references pulse.person(id),
  target_id uuid not null references pulse.person(id),
  action text not null check (action ~ '^[a-z]+\.[a-z]+$'),
  args jsonb not null default '{}' check (jsonb_typeof(args) = 'object' and length(args::text) <= 4000),
  needed text not null check (needed in ('view', 'act', 'admin')),
  why text check (why is null or length(why) <= 300),
  channel_id uuid,
  state text not null check (state in ('asked', 'sent', 'claimed', 'done', 'failed', 'refused', 'expired')),
  decision text check (decision is null or decision in ('once', 'always', 'no')),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  claimed_at timestamptz,
  done_at timestamptz,
  expires_at timestamptz not null,
  result jsonb check (result is null or length(result::text) <= 4000),
  error text check (error is null or length(error) <= 300)
);
create index agent_ui_action_target on pulse.agent_ui_action (org_id, target_id, created_at desc);
create index agent_ui_action_agent on pulse.agent_ui_action (org_id, agent_id, created_at desc);
create index agent_ui_action_asked on pulse.agent_ui_action (org_id, created_at desc) where state = 'asked';
create table pulse.agent_ui_card (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  message_id uuid not null unique,
  channel_id uuid not null,
  agent_id uuid not null references pulse.person(id),
  for_person_id uuid references pulse.person(id),
  kind text not null check (kind in ('client.add', 'task.add', 'project.add', 'choice')),
  title text not null check (length(title) between 1 and 160),
  fields jsonb not null default '{}' check (jsonb_typeof(fields) = 'object' and length(fields::text) <= 4000),
  state text not null default 'open' check (state in ('open', 'done', 'dismissed')),
  result jsonb check (result is null or length(result::text) <= 2000),
  done_by uuid references pulse.person(id),
  done_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

alter table pulse.agent_ui_level enable row level security;
alter table pulse.agent_ui_level force row level security;
create policy tenant_isolation on pulse.agent_ui_level using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create trigger audit_mutation after insert or update or delete on pulse.agent_ui_level for each row execute function pulse.audit_mutation();
revoke all on pulse.agent_ui_level from public;
alter table pulse.agent_ui_allow enable row level security;
alter table pulse.agent_ui_allow force row level security;
create policy tenant_isolation on pulse.agent_ui_allow using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create trigger audit_mutation after insert or update or delete on pulse.agent_ui_allow for each row execute function pulse.audit_mutation();
revoke all on pulse.agent_ui_allow from public;
alter table pulse.agent_ui_action enable row level security;
alter table pulse.agent_ui_action force row level security;
create policy tenant_isolation on pulse.agent_ui_action using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create trigger audit_mutation after insert or update or delete on pulse.agent_ui_action for each row execute function pulse.audit_mutation();
revoke all on pulse.agent_ui_action from public;
alter table pulse.agent_ui_card enable row level security;
alter table pulse.agent_ui_card force row level security;
create policy tenant_isolation on pulse.agent_ui_card using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create trigger audit_mutation after insert or update or delete on pulse.agent_ui_card for each row execute function pulse.audit_mutation();
revoke all on pulse.agent_ui_card from public;
-- A card's change wakes the conversation's live streams (as a poll's vote does).
create trigger chat_touch after insert or update or delete on pulse.agent_ui_card for each row execute function pulse.chat_touch();

-- ------------------------------------------------------------------------------------------------------ helpers
create function pulse.agent_ui_rank(p_level text) returns int language sql immutable as $$
  select case p_level when 'off' then 0 when 'view' then 1 when 'act' then 2 when 'admin' then 3 else -1 end
$$;

/** Admins and leadership (a person, never an AI employee's own session) manage screen control and decide prompts. */
create function pulse.agent_ui_can_manage() returns boolean
language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and coalesce(current_setting('pulse.agent_session', true), '') <> 'on' and viewer_is('admin', 'leadership')
$$;

/** The level each action needs (the catalogue's levels: services/api/data/agent-ui-actions.json). Settings and admin
 *  screens need admin; so does a form for adding a person or an AI employee. Null: not an action. */
create function pulse.agent_ui_action_level(p_action text, p_args jsonb) returns text language sql immutable as $$
  select case
    when p_action in ('page.open', 'panel.open', 'tab.open') then
      case when coalesce(p_args->>'path', p_args->>'target', '') ~* '^(https?://[^/]+)?/(settings|admin|platform)(/|\?|#|$)' then 'admin' else 'view' end
    when p_action in ('panel.close', 'sidebar.set', 'point.at', 'mic.stop') then 'view'
    when p_action = 'form.open' then case when coalesce(p_args->>'form', '') in ('person', 'ai_employee') then 'admin' else 'act' end
    when p_action in ('composer.insert', 'emoji.insert', 'file.pick', 'mic.start') then 'act'
    else null end
$$;

create function pulse.agent_ui_level_of(p_agent uuid) returns text
language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select level from agent_ui_level where org_id = current_org() and agent_id = p_agent), 'view')
$$;

/** The conversation where p_person wrote last (in the last 30 minutes) among the ones the AI employee is in, never one
 *  with a client in it; null when it is not helping them right now. */
create function pulse.agent_ui_helping(p_agent uuid, p_person uuid) returns uuid
language sql stable security definer set search_path = pulse, pg_temp as $$
  select m.channel_id from chat_member a
  join lateral (select x.channel_id, x.created_at from chat_message x where x.org_id = a.org_id and x.channel_id = a.channel_id and x.author_id = p_person
                  and x.removed_at is null and x.created_at > clock_timestamp() - interval '30 minutes' order by x.created_at desc limit 1) m on true
  where a.org_id = current_org() and a.person_id = p_agent and p_agent <> p_person and not chat_client_facing(a.channel_id)
  order by m.created_at desc limit 1
$$;

create function pulse.agent_ui_wake(p_target uuid, p_ask boolean) returns void
language sql security definer set search_path = pulse, pg_temp as $$
  select pg_notify('pulse_ui', current_org()::text || ':' || p_target::text || case when p_ask then ':ask' else '' end)
$$;

/** What a browser shows of one action. */
create function pulse.agent_ui_row(r pulse.agent_ui_action) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('id', r.id, 'action', r.action, 'args', r.args, 'needed', r.needed, 'why', r.why, 'state', r.state, 'channelId', r.channel_id,
    'agent', jsonb_build_object('id', r.agent_id, 'name', coalesce((select display_name from person where id = r.agent_id), 'You')),
    'target', jsonb_build_object('id', r.target_id, 'name', (select display_name from person where id = r.target_id)),
    'decision', r.decision, 'decidedBy', (select display_name from person where id = r.decided_by),
    'createdAt', r.created_at, 'expiresAt', r.expires_at, 'doneAt', r.done_at, 'result', r.result, 'error', r.error)
$$;

-- ------------------------------------------------------------------------------------------------------ the agent asks
/** One screen action from the current principal: an AI employee (its own session) for a person it is helping, or a person
 *  for their own screen. Sent at once within its level (or a kept "Always"), otherwise a prompt. */
create function pulse.agent_ui_request(p_target uuid, p_action text, p_args jsonb, p_why text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); agent uuid := agent_session(); target uuid := coalesce(p_target, current_viewer());
  needed text := agent_ui_action_level(p_action, coalesce(p_args, '{}')); lvl text; chan uuid; st text; rid uuid; prior agent_ui_action;
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if needed is null then raise exception 'Pulse has no screen action called %', left(coalesce(p_action, ''), 40) using errcode = '22023'; end if;
  if p_args is null or jsonb_typeof(p_args) <> 'object' or length(p_args::text) > 4000 then raise exception 'Give the action''s details as an object of at most 4,000 characters' using errcode = '22023'; end if;
  if agent is null then
    if target <> me then raise exception 'Your own key drives only your own screen' using errcode = '42501'; end if;
    st := 'sent';
  else
    if agent_paused() or not exists(select 1 from agent_member m where m.org_id = current_org() and m.person_id = agent and m.disabled_at is null) then
      raise exception 'This AI employee is paused' using errcode = '42501'; end if;
    lvl := agent_ui_level_of(agent);
    if lvl = 'off' then raise exception 'Screen control is off for you. An admin or leadership can turn it on in your profile, under AI and then Capabilities.' using errcode = '42501'; end if;
    if not exists(select 1 from person p where p.id = target and p.org_id = current_org() and p.status = 'active' and p.side = 'staff') then
      raise exception 'You can drive the screen only of a colleague you are helping' using errcode = '42501'; end if;
    chan := agent_ui_helping(agent, target);
    if chan is null then raise exception 'You can drive someone''s screen only while you help them: they wrote to you in the last 30 minutes' using errcode = '42501'; end if;
    if (select count(*) from agent_ui_action where org_id = current_org() and agent_id = agent and target_id = target and created_at > clock_timestamp() - interval '1 minute') >= 30 then
      raise exception 'Too many screen actions in one minute; wait a little' using errcode = '54000'; end if;
    if agent_ui_rank(lvl) >= agent_ui_rank(needed) or exists(select 1 from agent_ui_allow w where w.org_id = current_org() and w.agent_id = agent and w.action = p_action
         and agent_ui_rank(w.level) >= agent_ui_rank(needed)) then st := 'sent'; else st := 'asked'; end if;
    -- The same open prompt is not asked twice.
    if st = 'asked' then
      select * into prior from agent_ui_action where org_id = current_org() and agent_id = agent and target_id = target and action = p_action and args = p_args
        and state = 'asked' and expires_at > clock_timestamp() order by created_at desc limit 1;
      if found then return agent_ui_row(prior) || jsonb_build_object('message', 'Already asked; waiting for a yes.'); end if;
    end if;
  end if;
  insert into agent_ui_action (org_id, agent_id, target_id, action, args, needed, why, channel_id, state, sent_at, expires_at)
  values (current_org(), agent, target, p_action, p_args, needed, nullif(left(btrim(coalesce(p_why, '')), 300), ''), chan, st,
          case when st = 'sent' then clock_timestamp() end, clock_timestamp() + case when st = 'asked' then interval '10 minutes' else interval '2 minutes' end)
  returning id into rid;
  perform agent_ui_wake(target, st = 'asked');
  return agent_ui_row((select a from agent_ui_action a where a.id = rid)) || jsonb_build_object('message', case st
    when 'sent' then 'Sent to their screen.'
    else format('Above your screen level (%s; this needs %s): %s was asked in the top bar. Tell them you asked; it runs when someone says yes.', lvl, needed,
      (select display_name from person where id = target)) end);
end $$;

/** How an action went, for the AI employee that sent it (or the person, for their own). A prompt nobody answered and an
 *  action no browser took end on their own. */
create function pulse.agent_ui_status(p_id uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r agent_ui_action;
begin
  update agent_ui_action set state = 'expired' where id = p_id and org_id = current_org() and state in ('asked', 'sent') and expires_at <= clock_timestamp();
  select * into r from agent_ui_action where id = p_id and org_id = current_org()
    and (agent_id = current_viewer() or (agent_id is null and target_id = current_viewer()) or agent_ui_can_manage());
  if not found then raise exception 'No such screen action' using errcode = 'P0002'; end if;
  return agent_ui_row(r);
end $$;

-- ------------------------------------------------------------------------------------------------------ the browser
/** What this person's browser should do now (actions sent to them) and the prompts they may answer (their own, up to act;
 *  every open prompt in the company for admins and leadership). */
create function pulse.agent_ui_pending() returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); mgr boolean := agent_ui_can_manage();
begin
  if me is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on' then return jsonb_build_object('actions', '[]'::jsonb, 'asks', '[]'::jsonb); end if;
  update agent_ui_action set state = 'expired' where org_id = current_org() and state in ('asked', 'sent') and expires_at <= clock_timestamp()
    and (target_id = me or (mgr and state = 'asked'));
  return jsonb_build_object(
    'actions', coalesce((select jsonb_agg(agent_ui_row(a) order by a.created_at) from agent_ui_action a where a.org_id = current_org() and a.target_id = me and a.state = 'sent'), '[]'::jsonb),
    'asks', coalesce((select jsonb_agg(agent_ui_row(a) || jsonb_build_object('mine', a.target_id = me, 'canAlways', mgr and a.agent_id is not null) order by a.created_at desc)
      from agent_ui_action a where a.org_id = current_org() and a.state = 'asked' and (mgr or (a.target_id = me and agent_ui_rank(a.needed) <= 2))), '[]'::jsonb),
    'manager', mgr);
end $$;

/** The first of the person's open tabs to take an action does it (the others see it taken). */
create function pulse.agent_ui_claim(p_id uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r agent_ui_action;
begin
  update agent_ui_action set state = 'claimed', claimed_at = clock_timestamp()
  where id = p_id and org_id = current_org() and target_id = current_viewer() and state = 'sent' and expires_at > clock_timestamp()
    and coalesce(current_setting('pulse.agent_session', true), '') <> 'on'
  returning * into r;
  return case when found then agent_ui_row(r) else null end;
end $$;

create function pulse.agent_ui_done(p_id uuid, p_ok boolean, p_result jsonb, p_error text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r agent_ui_action;
begin
  if p_result is not null and (jsonb_typeof(p_result) <> 'object' or length(p_result::text) > 4000) then raise exception 'The result is an object of at most 4,000 characters' using errcode = '22023'; end if;
  update agent_ui_action set state = case when p_ok then 'done' else 'failed' end, done_at = clock_timestamp(), result = p_result,
    error = case when p_ok then null else left(coalesce(nullif(btrim(p_error), ''), 'It did not work on the screen'), 300) end
  where id = p_id and org_id = current_org() and target_id = current_viewer() and state = 'claimed'
  returning * into r;
  if not found then raise exception 'That screen action is not waiting for you' using errcode = 'P0002'; end if;
  return agent_ui_row(r);
end $$;

/** A prompt answered: once (this time), always (this kind of action from now on: admins and leadership) or no. */
create function pulse.agent_ui_decide(p_id uuid, p_decision text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); mgr boolean := agent_ui_can_manage(); r agent_ui_action;
begin
  if me is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on' then raise exception 'A person decides this' using errcode = '42501'; end if;
  if p_decision not in ('once', 'always', 'no') then raise exception 'Choose once, always or no' using errcode = '22023'; end if;
  select * into r from agent_ui_action where id = p_id and org_id = current_org() for update;
  if not found then raise exception 'No such request' using errcode = 'P0002'; end if;
  if r.state <> 'asked' or r.expires_at <= clock_timestamp() then raise exception 'This request has ended' using errcode = '55000'; end if;
  if not mgr and not (r.target_id = me and agent_ui_rank(r.needed) <= 2) then raise exception 'An admin or leadership decides this one' using errcode = '42501'; end if;
  if p_decision = 'always' and not mgr then raise exception 'Only admins and leadership can always allow it' using errcode = '42501'; end if;
  if p_decision = 'always' then
    insert into agent_ui_allow (org_id, agent_id, action, level, granted_by) values (current_org(), r.agent_id, r.action, r.needed, me)
    on conflict (org_id, agent_id, action) do update set level = case when agent_ui_rank(excluded.level) > agent_ui_rank(agent_ui_allow.level) then excluded.level else agent_ui_allow.level end,
      granted_by = excluded.granted_by, granted_at = excluded.granted_at;
  end if;
  update agent_ui_action set state = case when p_decision = 'no' then 'refused' else 'sent' end, decision = p_decision, decided_by = me, decided_at = clock_timestamp(),
    sent_at = case when p_decision = 'no' then null else clock_timestamp() end,
    expires_at = case when p_decision = 'no' then expires_at else clock_timestamp() + interval '2 minutes' end
  where id = p_id returning * into r;
  perform agent_ui_wake(r.target_id, true);
  return agent_ui_row(r);
end $$;

-- ------------------------------------------------------------------------------------------------------ settings
create function pulse.agent_ui_settings(p_agent uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare owner uuid;
begin
  select m.owner_person_id into owner from agent_member m where m.org_id = current_org() and m.person_id = p_agent;
  if not found then raise exception 'No such AI employee' using errcode = 'P0002'; end if;
  if not (agent_ui_can_manage() or (owner = current_viewer() and coalesce(current_setting('pulse.agent_session', true), '') <> 'on')) then
    raise exception 'Admins, leadership and its manager see its screen control' using errcode = '42501'; end if;
  return jsonb_build_object('level', agent_ui_level_of(p_agent), 'canChange', agent_ui_can_manage(),
    'allows', coalesce((select jsonb_agg(jsonb_build_object('action', w.action, 'level', w.level, 'by', (select display_name from person where id = w.granted_by), 'at', w.granted_at) order by w.action)
      from agent_ui_allow w where w.org_id = current_org() and w.agent_id = p_agent), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(agent_ui_row(a) order by a.created_at desc) from agent_ui_action a where a.id in (select x.id from agent_ui_action x
      where x.org_id = current_org() and x.agent_id = p_agent order by x.created_at desc limit 30)), '[]'::jsonb));
end $$;

create function pulse.agent_ui_level_set(p_agent uuid, p_level text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not agent_ui_can_manage() then raise exception 'Admins and leadership set how far an AI employee drives the screen' using errcode = '42501'; end if;
  if p_level not in ('off', 'view', 'act', 'admin') then raise exception 'Choose off, view, act or admin' using errcode = '22023'; end if;
  if not exists(select 1 from agent_member where org_id = current_org() and person_id = p_agent) then raise exception 'No such AI employee' using errcode = 'P0002'; end if;
  insert into agent_ui_level (org_id, agent_id, level, set_by) values (current_org(), p_agent, p_level, current_viewer())
  on conflict (org_id, agent_id) do update set level = excluded.level, set_by = excluded.set_by, set_at = clock_timestamp();
  -- Off also ends what it was still waiting for.
  if p_level = 'off' then
    update agent_ui_action set state = 'refused', decision = 'no', decided_by = current_viewer(), decided_at = clock_timestamp()
    where org_id = current_org() and agent_id = p_agent and state in ('asked', 'sent');
  end if;
  return agent_ui_settings(p_agent);
end $$;

/** What the caller may do on a screen: an AI employee its level and its kept "Always" allows; a person (their own
 *  screen only) everything. */
create function pulse.agent_ui_mine() returns jsonb
language plpgsql security definer stable set search_path = pulse, pg_temp as $$
declare agent uuid := agent_session();
begin
  if current_viewer() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if agent is null then return jsonb_build_object('level', 'admin', 'own', true, 'allows', '[]'::jsonb); end if;
  return jsonb_build_object('level', agent_ui_level_of(agent), 'own', false,
    'allows', coalesce((select jsonb_agg(jsonb_build_object('action', w.action, 'level', w.level) order by w.action) from agent_ui_allow w
      where w.org_id = current_org() and w.agent_id = agent), '[]'::jsonb));
end $$;

create function pulse.agent_ui_allow_remove(p_agent uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not agent_ui_can_manage() then raise exception 'Admins and leadership change what an AI employee may always do' using errcode = '42501'; end if;
  delete from agent_ui_allow where org_id = current_org() and agent_id = p_agent and action = p_action;
  return agent_ui_settings(p_agent);
end $$;

-- ------------------------------------------------------------------------------------------------------ chat cards
/** The AI employee posts an interactive card in the conversation where the person it helps wrote last (instead of
 *  failing): its words as the message, the card under it. Kept in the audit trail as a card.show action. */
create function pulse.agent_ui_card_post(p_target uuid, p_kind text, p_body text, p_title text, p_fields jsonb, p_client uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare agent uuid := agent_session(); chan uuid; mid uuid; cid uuid; opts jsonb;
begin
  if agent is null then raise exception 'Cards are posted by AI employees' using errcode = '42501'; end if;
  if agent_paused() or not exists(select 1 from agent_member m where m.org_id = current_org() and m.person_id = agent and m.disabled_at is null) then
    raise exception 'This AI employee is paused' using errcode = '42501'; end if;
  if agent_ui_level_of(agent) = 'off' then raise exception 'Screen control is off for you. An admin or leadership can turn it on in your profile, under AI and then Capabilities.' using errcode = '42501'; end if;
  if p_kind not in ('client.add', 'task.add', 'project.add', 'choice') then raise exception 'A card is client.add, task.add, project.add or choice' using errcode = '22023'; end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or length(p_fields::text) > 4000 then raise exception 'Give the card''s fields as an object' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_title, ''))) not between 1 and 160 then raise exception 'Give the card a title of up to 160 characters' using errcode = '22023'; end if;
  if p_kind = 'choice' then
    opts := p_fields->'options';
    if jsonb_typeof(opts) is distinct from 'array' or jsonb_array_length(opts) not between 2 and 6
       or exists(select 1 from jsonb_array_elements(opts) o where jsonb_typeof(o) <> 'string' or length(o #>> '{}') not between 1 and 80) then
      raise exception 'A choice card has 2 to 6 options of up to 80 characters' using errcode = '22023'; end if;
  end if;
  chan := agent_ui_helping(agent, p_target);
  if chan is null then raise exception 'You can post a card only for someone you are helping: they wrote to you in the last 30 minutes' using errcode = '42501'; end if;
  mid := chat_send(chan, left(btrim(coalesce(nullif(p_body, ''), p_title)), 2000), null, '[]'::jsonb, coalesce(p_client, gen_random_uuid()), null);
  insert into agent_ui_card (org_id, message_id, channel_id, agent_id, for_person_id, kind, title, fields)
  values (current_org(), mid, chan, agent, p_target, p_kind, btrim(p_title), p_fields)
  on conflict (message_id) do nothing returning id into cid;
  if cid is null then select id into cid from agent_ui_card where message_id = mid; end if;
  insert into agent_ui_action (org_id, agent_id, target_id, action, args, needed, channel_id, state, sent_at, done_at, expires_at, result)
  values (current_org(), agent, p_target, 'card.show', jsonb_build_object('kind', p_kind, 'title', btrim(p_title)), 'view', chan, 'done',
          clock_timestamp(), clock_timestamp(), clock_timestamp(), jsonb_build_object('cardId', cid, 'messageId', mid));
  return jsonb_build_object('cardId', cid, 'messageId', mid, 'channelId', chan, 'state', 'open');
end $$;

/** The card filled in, as the person (their own permissions decide: adding a client is for admins, leadership and the
 *  Finance role, as on Clients). The card is done and one line in the chat tells the AI employee to carry on. */
create function pulse.agent_ui_card_submit(p_card uuid, p_values jsonb) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); k agent_ui_card; v jsonb := coalesce(p_values, '{}'); res jsonb; said text; x uuid; pj jsonb; nm text; mid uuid;
begin
  if me is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on' then raise exception 'A person fills in this card' using errcode = '42501'; end if;
  if jsonb_typeof(v) <> 'object' or length(v::text) > 4000 then raise exception 'Fill in the card''s fields' using errcode = '22023'; end if;
  select * into k from agent_ui_card where id = p_card and org_id = current_org() for update;
  if not found or not chat_has(k.channel_id) then raise exception 'No such card' using errcode = 'P0002'; end if;
  if k.state <> 'open' then raise exception 'This card is already %', case k.state when 'done' then 'done' else 'closed' end using errcode = '55000'; end if;
  nm := left(btrim(regexp_replace(coalesce(v->>'name', v->>'title', ''), '\s+', ' ', 'g')), 200);
  if k.kind = 'client.add' then
    x := v1_client_create(jsonb_build_object('name', nm, 'company', v->>'company', 'phone', v->>'phone', 'email', v->>'email', 'city', v->>'city'));
    res := jsonb_build_object('clientId', x, 'name', nm); said := format('Added the client “%s”.', nm);
  elsif k.kind = 'task.add' then
    if length(nm) < 2 then raise exception 'Name the task' using errcode = '22023'; end if;
    x := task_save(null, jsonb_strip_nulls(jsonb_build_object('title', nm, 'notes', nullif(v->>'notes', ''), 'dueOn', nullif(v->>'dueOn', ''))));
    res := jsonb_build_object('taskId', x, 'title', nm); said := format('Made the task “%s”.', nm);
  elsif k.kind = 'project.add' then
    pj := work_project_save(null, jsonb_strip_nulls(jsonb_build_object('type', 'internal', 'name', nm, 'summary', nullif(v->>'summary', ''))));
    res := jsonb_build_object('projectId', coalesce(pj->>'id', pj->>'projectId'), 'name', nm); said := format('Made the project “%s”.', nm);
  else
    if not exists(select 1 from jsonb_array_elements_text(k.fields->'options') o where o = v->>'choice') then raise exception 'Pick one of the options' using errcode = '22023'; end if;
    res := jsonb_build_object('choice', v->>'choice'); said := v->>'choice';
  end if;
  update agent_ui_card set state = 'done', result = res, done_by = me, done_at = clock_timestamp() where id = k.id;
  mid := chat_send(k.channel_id, said, null, '[]'::jsonb, gen_random_uuid(), null);
  return jsonb_build_object('state', 'done', 'result', res, 'messageId', mid);
end $$;

create function pulse.agent_ui_card_dismiss(p_card uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k agent_ui_card;
begin
  if current_viewer() is null or coalesce(current_setting('pulse.agent_session', true), '') = 'on' then raise exception 'A person closes this card' using errcode = '42501'; end if;
  select * into k from agent_ui_card where id = p_card and org_id = current_org() for update;
  if not found or not chat_has(k.channel_id) then raise exception 'No such card' using errcode = 'P0002'; end if;
  if k.state = 'open' then update agent_ui_card set state = 'dismissed', done_by = current_viewer(), done_at = clock_timestamp() where id = k.id; end if;
  return jsonb_build_object('state', case when k.state = 'open' then 'dismissed' else k.state end);
end $$;

-- The chat reads a message's card with the message (under the person's own row security).
create policy agent_ui_card_see on pulse.agent_ui_card as restrictive for select to pulse_api using (pulse.chat_has(channel_id) or pulse.agent_ui_can_manage());
grant select on pulse.agent_ui_card to pulse_api;

revoke all on function pulse.agent_ui_can_manage(), pulse.agent_ui_level_of(uuid), pulse.agent_ui_helping(uuid, uuid), pulse.agent_ui_wake(uuid, boolean),
  pulse.agent_ui_row(pulse.agent_ui_action), pulse.agent_ui_request(uuid, text, jsonb, text), pulse.agent_ui_status(uuid), pulse.agent_ui_pending(),
  pulse.agent_ui_claim(uuid), pulse.agent_ui_done(uuid, boolean, jsonb, text), pulse.agent_ui_decide(uuid, text), pulse.agent_ui_settings(uuid),
  pulse.agent_ui_level_set(uuid, text), pulse.agent_ui_mine(), pulse.agent_ui_allow_remove(uuid, text), pulse.agent_ui_card_post(uuid, text, text, text, jsonb, uuid),
  pulse.agent_ui_card_submit(uuid, jsonb), pulse.agent_ui_card_dismiss(uuid) from public;
grant execute on function pulse.agent_ui_rank(text), pulse.agent_ui_action_level(text, jsonb), pulse.agent_ui_can_manage(), pulse.agent_ui_level_of(uuid),
  pulse.agent_ui_request(uuid, text, jsonb, text), pulse.agent_ui_status(uuid), pulse.agent_ui_pending(), pulse.agent_ui_claim(uuid),
  pulse.agent_ui_done(uuid, boolean, jsonb, text), pulse.agent_ui_decide(uuid, text), pulse.agent_ui_settings(uuid), pulse.agent_ui_level_set(uuid, text), pulse.agent_ui_mine(),
  pulse.agent_ui_allow_remove(uuid, text), pulse.agent_ui_card_post(uuid, text, text, text, jsonb, uuid), pulse.agent_ui_card_submit(uuid, jsonb),
  pulse.agent_ui_card_dismiss(uuid) to pulse_api;

-- migrate:down
drop function if exists pulse.agent_ui_card_dismiss(uuid), pulse.agent_ui_card_submit(uuid, jsonb), pulse.agent_ui_card_post(uuid, text, text, text, jsonb, uuid),
  pulse.agent_ui_allow_remove(uuid, text), pulse.agent_ui_mine(), pulse.agent_ui_level_set(uuid, text), pulse.agent_ui_settings(uuid), pulse.agent_ui_decide(uuid, text),
  pulse.agent_ui_done(uuid, boolean, jsonb, text), pulse.agent_ui_claim(uuid), pulse.agent_ui_pending(), pulse.agent_ui_status(uuid),
  pulse.agent_ui_request(uuid, text, jsonb, text), pulse.agent_ui_row(pulse.agent_ui_action), pulse.agent_ui_wake(uuid, boolean), pulse.agent_ui_helping(uuid, uuid),
  pulse.agent_ui_level_of(uuid), pulse.agent_ui_action_level(text, jsonb), pulse.agent_ui_can_manage(), pulse.agent_ui_rank(text);
drop table if exists pulse.agent_ui_card, pulse.agent_ui_action, pulse.agent_ui_allow, pulse.agent_ui_level;
