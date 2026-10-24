-- migrate:up
-- FEATURES-1024 (owner, 22 Oct 2026: "if they report to a project coordinator then the agent might DM them what they
-- think"; AI-EMP-V2 "next: route by group or project"): an AI employee asks a chosen person in a chosen group (say the
-- project's coordinator in that project's group) before it posts there, and its approver (or who it reports to)
-- everywhere else. Set on its profile by whoever may change it (agent_manage_ok, 0952). The person must be active
-- staff and in that group; if they leave it or the team, the AI asks its usual approver again.
-- The three functions that choose whom to ask are this repository's latest definitions (0955 agent_propose, 0965
-- agent_propose_task, 0970 agent_event_from_chat) with only that choice changed to agent_approver_for().

alter table pulse.agent_member add column group_approvers jsonb not null default '{}'::jsonb check (jsonb_typeof(group_approvers) = 'object');

-- Whom the AI employee asks about a message in this conversation.
create function pulse.agent_approver_for(p_agent uuid, p_channel uuid) returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(
    (select p.id from agent_member m join person p on p.id = (m.group_approvers ->> p_channel::text)::uuid
      where m.person_id = p_agent and p_channel is not null and p.status = 'active' and p.side = 'staff'
        and exists (select 1 from chat_member cm where cm.channel_id = p_channel and cm.person_id = p.id)),
    (select coalesce(m.approver_person_id, m.owner_person_id) from agent_member m where m.person_id = p_agent))
$$;

-- Set (or clear, with no person) whom it asks in one of its groups.
create function pulse.agent_group_approver_set(p_agent uuid, p_channel uuid, p_person uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not exists (select 1 from agent_member where person_id = p_agent and org_id = current_org()) or not agent_manage_ok(p_agent) then
    raise exception 'Not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from chat_member cm join chat_channel ch on ch.id = cm.channel_id where cm.channel_id = p_channel and cm.person_id = p_agent and ch.kind <> 'direct') then
    raise exception 'It is not in that group' using errcode = '22023'; end if;
  if p_person is not null and not exists (select 1 from person p join chat_member cm on cm.person_id = p.id and cm.channel_id = p_channel
                                           where p.id = p_person and p.status = 'active' and p.side = 'staff') then
    raise exception 'Choose someone from the team who is in that group' using errcode = '22023'; end if;
  update agent_member set group_approvers = case when p_person is null then group_approvers - p_channel::text
    else group_approvers || jsonb_build_object(p_channel::text, p_person) end where person_id = p_agent;
  perform audit_write('update', 'agent_member', p_agent::text);
  return (select group_approvers from agent_member where person_id = p_agent);
end $$;

-- 0955's agent_propose: asks agent_approver_for().
create or replace function pulse.agent_propose(p_run uuid, p_body text, p_why text, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; e agent_event; msg chat_message; m agent_member; ap uuid; dm uuid; k text; mid uuid; pid uuid;
  b text := btrim(coalesce(p_body, '')); w text := left(nullif(btrim(coalesce(p_why, '')), ''), 1000); ch chat_channel; who text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if length(b) not between 1 and 4000 then raise exception 'Write the proposal in up to 4,000 characters' using errcode='22023'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Propose inside the run' using errcode='42501'; end if;
  select id into pid from agent_proposal where run_id = r.id;
  if found then return (select jsonb_build_object('id', x.id, 'messageId', x.dm_message_id, 'chatId', x.dm_channel_id) from agent_proposal x where x.id = pid); end if;
  select * into e from agent_event where id = r.event_id;
  if e.subject_type <> 'message' then raise exception 'That run is not about a message' using errcode='22023'; end if;
  select * into msg from chat_message where id = e.subject_id;
  select * into ch from chat_channel where id = msg.channel_id;
  select * into m from agent_member where person_id = me;
  ap := agent_approver_for(me, msg.channel_id);
  if ap is null then raise exception 'It has nobody to ask' using errcode='22023'; end if;
  k := 'dm:' || least(me::text, ap::text) || ':' || greatest(me::text, ap::text);
  insert into chat_channel(org_id, key, name, kind, description) values (current_org(), k, 'Direct message', 'direct', 'A private conversation')
  on conflict (org_id, key) do update set key = excluded.key returning id into dm;
  insert into chat_member(org_id, channel_id, person_id) values (current_org(), dm, me), (current_org(), dm, ap) on conflict do nothing;
  insert into agent_proposal(org_id, agent_id, run_id, channel_id, source_message_id, approver_id, dm_channel_id, kind, body, why)
  values (current_org(), me, r.id, msg.channel_id, msg.id, ap, dm, 'reply', b, w) returning id into pid;
  select display_name into who from person where id = msg.author_id;
  mid := chat_send(dm, who || ' wrote in ' || case when ch.kind = 'direct' then 'a direct message' else '“' || ch.name || '”' end || ':' || chr(10) || '“'
      || left(regexp_replace(msg.body, '\s+', ' ', 'g'), 280) || case when length(msg.body) > 280 then '…' else '' end
      || '”' || chr(10) || 'I have not answered there. This is what I would post: Send it, Edit, or Don''t (a reply like “fine, send it” works too).', null, '[]'::jsonb, p_client, null);
  update agent_proposal set dm_message_id = mid where id = pid;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  return jsonb_build_object('id', pid, 'messageId', mid, 'chatId', dm);
end $$;

-- 0965's agent_propose_task: asks agent_approver_for().
create or replace function pulse.agent_propose_task(p_run uuid, p jsonb, p_why text, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; e agent_event; msg chat_message; m agent_member; ap uuid; dm uuid; k text; mid uuid; pid uuid;
  w text := left(nullif(btrim(coalesce(p_why, '')), ''), 1000); ch chat_channel; who text; b text;
  v_title text := left(btrim(regexp_replace(coalesce(p->>'title', ''), '\s+', ' ', 'g')), 201);
  v_user text := lower(btrim(coalesce(p->>'assignee', ''), ' @')); v_due date; v_notes text := left(btrim(coalesce(p->>'notes', '')), 2000);
  v_to uuid; v_to_name text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Describe the task' using errcode='22023'; end if;
  select * into m from agent_member where person_id = me;
  if not ('tasks' = any(m.tools)) then raise exception 'Tasks is off in its tools' using errcode='42501'; end if;
  if length(v_title) not between 3 and 200 then raise exception 'Give the task a title of 3 to 200 characters' using errcode='22023'; end if;
  if coalesce(p->>'dueOn', '') <> '' then
    begin v_due := (p->>'dueOn')::date; exception when others then raise exception 'Give the due date as YYYY-MM-DD' using errcode='22023'; end;
  end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Propose inside the run' using errcode='42501'; end if;
  select id into pid from agent_proposal where run_id = r.id;
  if found then return (select jsonb_build_object('id', x.id, 'messageId', x.dm_message_id, 'chatId', x.dm_channel_id) from agent_proposal x where x.id = pid); end if;
  select * into e from agent_event where id = r.event_id;
  if e.subject_type <> 'message' then raise exception 'That run is not about a message' using errcode='22023'; end if;
  select * into msg from chat_message where id = e.subject_id;
  select * into ch from chat_channel where id = msg.channel_id;
  select p2.id, p2.display_name into v_to, v_to_name from person p2 join people_profile pp on pp.person_id = p2.id
   where p2.org_id = current_org() and p2.status = 'active' and p2.side = 'staff' and lower(pp.username) = v_user
     and (m.access = 'operations' or exists(select 1 from chat_member cm where cm.channel_id = msg.channel_id and cm.person_id = p2.id));
  if v_to is null then raise exception 'Choose someone it may give work to, by their @username' using errcode='22023'; end if;
  ap := agent_approver_for(me, msg.channel_id);
  if ap is null then raise exception 'It has nobody to ask' using errcode='22023'; end if;
  k := 'dm:' || least(me::text, ap::text) || ':' || greatest(me::text, ap::text);
  insert into chat_channel(org_id, key, name, kind, description) values (current_org(), k, 'Direct message', 'direct', 'A private conversation')
  on conflict (org_id, key) do update set key = excluded.key returning id into dm;
  insert into chat_member(org_id, channel_id, person_id) values (current_org(), dm, me), (current_org(), dm, ap) on conflict do nothing;
  b := 'Task: ' || v_title || chr(10) || 'For: ' || v_to_name
    || case when v_due is not null then chr(10) || 'Due: ' || to_char(v_due, 'FMDD Mon YYYY') else '' end
    || case when v_notes <> '' then chr(10) || 'Notes: ' || v_notes else '' end;
  insert into agent_proposal(org_id, agent_id, run_id, channel_id, source_message_id, approver_id, dm_channel_id, kind, body, why, action)
  values (current_org(), me, r.id, msg.channel_id, msg.id, ap, dm, 'task', left(b, 4000), w,
    jsonb_build_object('type', 'task.create', 'title', v_title, 'assigneeId', v_to, 'assigneeName', v_to_name, 'dueOn', v_due, 'notes', nullif(v_notes, '')))
  returning id into pid;
  select display_name into who from person where id = msg.author_id;
  mid := chat_send(dm, case when msg.channel_id = dm then 'You asked me:' else who || ' wrote in ' || case when ch.kind = 'direct' then 'a direct message' else '“' || ch.name || '”' end || ':' end
      || chr(10) || '“' || left(regexp_replace(msg.body, '\s+', ' ', 'g'), 280) || case when length(msg.body) > 280 then '…' else '' end || '”' || chr(10)
      || 'I have not created anything. This is the task I would create: Create it, Edit, or Don''t (a reply like “ok” works too).', null, '[]'::jsonb, p_client, null);
  update agent_proposal set dm_message_id = mid where id = pid;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  return jsonb_build_object('id', pid, 'messageId', mid, 'chatId', dm);
end $$;

-- 0970's agent_event_from_chat: the person it would ask in this group does not start a run with their own messages.
create or replace function pulse.agent_event_from_chat() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a record; leader boolean;
begin
  if new.kind <> 'text' or new.removed_at is not null or new.author_id is distinct from current_viewer() then return null; end if;
  if btrim(coalesce(new.body, '')) = '' then return null; end if;
  if exists(select 1 from person where id = new.author_id and side = 'agent') then return null; end if;
  if agent_proposal_from_reply(new.id) then return null; end if;
  leader := agent_leader(new.author_id);
  for a in
    select m.person_id agent, x.kind
      from agent_member m join person p on p.id = m.person_id
      join chat_channel ch on ch.id = new.channel_id
      join chat_member cm on cm.channel_id = new.channel_id and cm.person_id = m.person_id
      cross join lateral (select case when ch.kind = 'direct' then 'chat.message' when m.person_id = any(new.mentions) then 'chat.mention'
          when exists(select 1 from chat_message pm where pm.id = coalesce(new.parent_id, new.quote_id) and pm.author_id = m.person_id) then 'chat.reply'
          else 'chat.group' end kind) x
     where m.org_id = new.org_id and not m.post_only and m.disabled_at is null and p.status = 'active'
       and (ch.kind = 'direct' or m.speak_scope = 'its_groups' or (m.speak_scope = 'listed' and ch.id = any(m.speak_channels)))
       and agent_mode_for(m, x.kind) <> 'off'
       and (leader or m.listens_to = 'everyone')
       and not (x.kind = 'chat.group' and new.author_id = agent_approver_for(m.person_id, new.channel_id))
  loop
    insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
    values (new.org_id, a.agent, a.kind, 'message', new.id, 'message:' || new.id, new.author_id) on conflict do nothing;
  end loop;
  return null;
end $$;

revoke all on function pulse.agent_approver_for(uuid, uuid), pulse.agent_group_approver_set(uuid, uuid, uuid) from public;
grant execute on function pulse.agent_group_approver_set(uuid, uuid, uuid) to pulse_api;

-- migrate:down
-- Forward-only.
