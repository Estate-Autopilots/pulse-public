-- migrate:up
-- EA-AI (owner, 23 Oct 2026): a real AI team for Estate Autopilots, safe by construction. Enforced here, in the database,
-- whatever an AI employee's instructions or the runtime say:
--  * access: 'standard' (the people in its conversations) or 'operations' (the whole company, like a COO). Only an admin
--    gives operations access, and an AI employee with it always asks first: "on its own" is refused when saved and
--    read as "ask first" at dispatch (agent_mode_for).
--  * an AI session never deletes the company's records, and never writes money, pay, roles, sign-ins, organisation or
--    security settings (statement triggers: agent_guard);
--  * an AI employee writes in a conversation with a client (anyone not staff) only after a person approved that very
--    message (agent_client_guard; agent_proposal_decide sets pulse.agent_approved for the one post);
--  * it may propose a task (kind 'task'): its approver creates it with Create it / Edit / Don't (or a reply "ok"), as
--    themselves, with their own rights (task_save), and the task's card follows in the conversation it was asked in.-- Functions referenced here are all defined in repo migrations (0001, 0148, 0153, 0510, 0905, 0952).

alter table pulse.agent_member add column access text not null default 'standard' check (access in ('standard','operations'));
alter table pulse.agent_proposal add column action jsonb check (action is null or jsonb_typeof(action) = 'object'),
  add column task_id uuid references pulse.task(id);

-- How it acts on one kind of message; operations access never acts on its own.
create or replace function pulse.agent_mode_for(m pulse.agent_member, p_event_type text) returns text language sql stable set search_path=pulse,pg_temp as $$
  select case when s.x = 'own' and m.access = 'operations' then 'approve' else s.x end
    from (select coalesce(nullif(m.autonomy->>(case p_event_type when 'chat.message' then 'direct' when 'chat.group' then 'group' else 'mention' end), ''), 'off') x) s
$$;

-- Saved settings: operations access only from an admin (or a migration), never from an AI session; with it, nothing
-- is set to "on its own".
create function pulse.agent_access_rules() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.access is distinct from old.access then
    if agent_session() is not null then raise exception 'An AI employee does not change its own access' using errcode='42501'; end if;
    if current_viewer() is not null and not viewer_is('admin') then raise exception 'Only an admin changes an AI employee''s access' using errcode='42501'; end if;
  end if;
  if tg_op = 'INSERT' and new.access <> 'standard' and current_viewer() is not null and not viewer_is('admin') then
    raise exception 'Only an admin gives an AI employee operations access' using errcode='42501'; end if;
  if new.access = 'operations' and exists(select 1 from jsonb_each_text(new.autonomy) x where x.value = 'own') then
    raise exception 'An AI employee with operations access always asks first: choose Asks first or Stays out' using errcode='22023'; end if;
  return new;
end $$;
create trigger agent_access_rules before insert or update of access, autonomy on pulse.agent_member for each row execute function pulse.agent_access_rules();

create function pulse.agent_access_set(p_agent uuid, p_access text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if agent_session() is not null or not viewer_is('admin') then raise exception 'Only an admin changes an AI employee''s access' using errcode='42501'; end if;
  if p_access is null or p_access not in ('standard','operations') then raise exception 'Choose standard or operations access' using errcode='22023'; end if;
  perform agent_lock(p_agent);
  update agent_member set access = p_access,
    autonomy = case when p_access = 'operations' then (select jsonb_object_agg(k, case when v = 'own' then 'approve' else v end) from jsonb_each_text(autonomy) a(k, v)) else autonomy end
   where person_id = p_agent and org_id = current_org();
  if not found then raise exception 'Choose an AI employee' using errcode='22023'; end if;
  perform audit_write('agent_access_set', 'agent_member', p_agent::text || ':' || p_access);
end $$;

-- A conversation with anyone who is not staff (a client, a connected organisation's seat, a partner, talent).
create function pulse.chat_client_facing(p_channel uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
  select exists(select 1 from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = p_channel and p.side not in ('staff','agent'))
$$;

-- No AI session deletes the company's records or touches money, pay, roles, sign-ins, organisation or security settings.
create function pulse.agent_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if agent_session() is not null then
    raise exception 'An AI employee cannot % in %: it never deletes, moves money or changes access or security settings', lower(tg_op), tg_table_name using errcode='42501';
  end if;
  return null;
end $$;

-- What an AI employee posts to a client is a message a person approved (Send it on its proposal), never its own.
create function pulse.agent_client_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if agent_session() is not null and new.author_id = agent_session() and coalesce(current_setting('pulse.agent_approved', true), '') = ''
     and chat_client_facing(new.channel_id) then
    raise exception 'An AI employee writes to clients only after a person approves the message' using errcode='42501';
  end if;
  return new;
end $$;
create trigger agent_client_guard before insert on pulse.chat_message for each row execute function pulse.agent_client_guard();

do $$
declare t record;
begin
  -- Deletes: the company's records.
  for t in select n.nspname s, c.relname r from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p') and not c.relispartition and (
      (n.nspname = 'pulse' and c.relname ~ '^(task|project|project_member|person|people_profile|chat_channel|chat_message|chat_member|org|org_module|role_assignment|account|tenant_config|agent_member|agent_proposal|agent_memory|ai_connection|ai_setting|ai_workspace|hr_.*|leave.*|attendance.*|ats_.*|client.*|fin_.*|comp_.*|payroll.*|invoice.*|payment.*|expense.*)$')
      or (n.nspname = 'pulse_priv' and c.relname ~ '^(agent_key|pulse_account|account_member|handle_name|connect_.*|finance_.*|cash_.*|accountant_access)$'))
  loop
    execute format('create or replace trigger ea_ai_no_delete before delete on %I.%I for each statement execute function pulse.agent_guard()', t.s, t.r);
  end loop;
  -- Any write: money, pay, roles, sign-ins, organisation and security settings.
  for t in select n.nspname s, c.relname r from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r','p') and not c.relispartition and (
      (n.nspname = 'pulse' and c.relname ~ '^(role_assignment|account|account_claim|login_credential|login_session|tenant_config|org|org_module|hr_policy|ai_setting|ai_workspace|fin_.*|comp_.*|payroll.*|invoice.*|payment.*|expense.*)$')
      or (n.nspname = 'pulse_priv' and c.relname ~ '^(pulse_account|account_member|handle_name|connect_.*|finance_.*|cash_.*|accountant_access)$'))
  loop
    execute format('create or replace trigger ea_ai_no_write before insert or update on %I.%I for each statement execute function pulse.agent_guard()', t.s, t.r);
  end loop;
end $$;

-- Who it may give work to, for its runtime: everyone active on the staff with operations access; otherwise the staff
-- in that conversation (one it is a member of).
create function pulse.agent_directory(p_channel uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); m agent_member;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  select * into m from agent_member where person_id = me;
  if m.access <> 'operations' and (p_channel is null or not exists(select 1 from chat_member where channel_id = p_channel and person_id = me)) then
    return '[]'::jsonb; end if;
  return (select coalesce(jsonb_agg(x.j order by x.n), '[]'::jsonb) from (
    select p.display_name n, jsonb_build_object('name', p.display_name, 'username', pp.username, 'role', pp.role, 'pod', pp.pod, 'team', pp.department) j
      from person p join people_profile pp on pp.person_id = p.id
     where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' and pp.username is not null
       and (m.access = 'operations' or exists(select 1 from chat_member cm where cm.channel_id = p_channel and cm.person_id = p.id))
     order by p.display_name limit 300) x);
end $$;

-- Its proposal of a task, inside a run on a message: nothing is created; its approver gets a direct message with the
-- task (title, for whom, due, notes) on a card: Create it / Edit / Don't.
create function pulse.agent_propose_task(p_run uuid, p jsonb, p_why text, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
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
  ap := coalesce(m.approver_person_id, m.owner_person_id);
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

-- 0952's decision, plus: a task proposal creates the task as the person who decided (their rights, task_save; they
-- review it), its card follows in the conversation it was asked in (not one with a client); and the one message a
-- person approved may reach a client (pulse.agent_approved, read by agent_client_guard).
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

revoke all on function pulse.agent_access_rules(), pulse.agent_access_set(uuid,text), pulse.chat_client_facing(uuid), pulse.agent_guard(),
  pulse.agent_client_guard(), pulse.agent_directory(uuid), pulse.agent_propose_task(uuid,jsonb,text,uuid) from public;
grant execute on function pulse.agent_access_set(uuid,text), pulse.chat_client_facing(uuid), pulse.agent_directory(uuid),
  pulse.agent_propose_task(uuid,jsonb,text,uuid) to pulse_api;

-- migrate:down
-- Forward-only: proposals and who decided them stay auditable; give an AI employee standard access to narrow it.
