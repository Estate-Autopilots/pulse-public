-- migrate:up
-- CHAT-WORK part 2 (owner, 22 Oct 2026: "AI employees are added just like humans: nothing separate is created"). On
-- EST-1035's co-workers (agent_member, its keys, events, runs) and EST-1733's AI employee IDs, an AI employee is a
-- member like anyone: a person with a profile (role, pod, team, reports to), in its pod's and team's groups like a
-- person, and given tasks. What is set only for AI: its runtime (Claude or Codex on this server, model, effort), limits,
-- tools, which groups it may speak in and whether it may join in unasked. It keeps a memory (notes from its manager and
-- from its own runs, given to every run) and a history (its runs and tasks). A task given to it becomes one event its
-- runtime works on: it reports in the task's chat, moves the task to review (its manager reviews) or says what blocks it.
-- Its runtime says honestly when its plan is out of quota (until when); its work then waits and is not lost. Additive:
-- people's rules are unchanged; an older runner that does not ask for tasks never gets one.

alter table pulse.agent_member
  add column provider text not null default 'codex' check (provider in ('codex','claude','stub')),
  add column effort text not null default 'low' check (effort in ('low','medium','high','xhigh')),
  add column tools text[] not null default '{chats}' check (tools <@ array['chats','tasks','memory','board','drive','web']::text[]),
  add column speak_scope text not null default 'its_groups' check (speak_scope in ('its_groups','listed','direct_only')),
  add column speak_channels uuid[] not null default '{}' check (cardinality(speak_channels) <= 100),
  add column interject text not null default 'when_asked' check (interject in ('when_asked','when_relevant')),
  add column runtime_state text not null default 'unknown' check (runtime_state in ('unknown','ready','out_of_quota','error')),
  add column runtime_until timestamptz,
  add column runtime_seen_at timestamptz,
  add column runtime_detail text check (length(runtime_detail) <= 200);

alter table pulse.agent_run drop constraint agent_run_error_code_check;
alter table pulse.agent_run add constraint agent_run_error_code_check check (error_code in ('model_error','no_answer','stuck','out_of_quota'));
alter table pulse.agent_event drop constraint agent_event_reason_check;
alter table pulse.agent_event add constraint agent_event_reason_check check (reason in ('message_gone','not_leader','agent_left','asker_left','budget_spent',
  'not_chats','expired','gave_up','stuck','model_error','no_answer','released','one_at_a_time','hourly_limit','paused','out_of_quota','task_gone','not_assigned'));
alter table pulse.agent_output drop constraint agent_output_subject_type_check;
alter table pulse.agent_output add constraint agent_output_subject_type_check check (subject_type in ('message','comment','task'));

-- What it knows: short notes from its manager or admins, or from its own runs, given to every run (newest first).
create table pulse.agent_memory (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references pulse.agent_member(person_id),
  body text not null check (length(btrim(body)) between 1 and 1000),
  source text not null check (source in ('manager','agent')),
  task_id uuid references pulse.task(id),
  run_id uuid references pulse.agent_run(id),
  created_by uuid not null references pulse.person(id),
  created_at timestamptz not null default now(),
  retired_at timestamptz,
  retired_by uuid references pulse.person(id)
);
create index agent_memory_live on pulse.agent_memory (org_id, agent_id, created_at desc) where retired_at is null;
alter table pulse.agent_memory enable row level security;
alter table pulse.agent_memory force row level security;
create policy tenant on pulse.agent_memory using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.agent_memory to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.agent_memory for each row execute function pulse.audit_mutation();

-- Who manages an AI employee: an admin, or the person it reports to. Never an AI session.
create function pulse.agent_manage_ok(p_agent uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
  select agent_session() is null and current_viewer() is not null and exists(select 1 from agent_member m where m.org_id = current_org() and m.person_id = p_agent
    and (viewer_is('admin') or m.owner_person_id = current_viewer()))
$$;

-- Whether the viewer may give this person a task as an AI employee: it is on, takes tasks, and the viewer leads or manages it.
create function pulse.agent_takes_tasks(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
  select agent_session() is null and exists(select 1 from agent_member m join person p on p.id = m.person_id
    where m.org_id = current_org() and m.person_id = p_person and m.disabled_at is null and not m.post_only and p.status = 'active' and p.side = 'agent'
      and 'tasks' = any(m.tools) and (agent_leader(current_viewer()) or m.owner_person_id = current_viewer()))
$$;

-- Its settings, by its manager or an admin. Only the keys given change; every value is checked.
create function pulse.agent_settings_save(p_agent uuid, p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m agent_member; v_owner uuid; v_title text; v_channels uuid[]; t text;
begin
  if not agent_manage_ok(p_agent) then raise exception 'Its manager or an admin changes an AI employee' using errcode='42501'; end if;
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Send the settings' using errcode='22023'; end if;
  m := agent_lock(p_agent);
  if p ? 'title' then
    v_title := btrim(coalesce(p->>'title', ''));
    if length(v_title) not between 1 and 120 then raise exception 'A role of 1 to 120 characters is required' using errcode='22023'; end if;
    update agent_member set title = v_title where person_id = p_agent;
    update people_profile set role = v_title where org_id = current_org() and person_id = p_agent;
  end if;
  if p ? 'ownerId' then
    v_owner := nullif(p->>'ownerId', '')::uuid;
    if v_owner is null or not exists(select 1 from person where id = v_owner and org_id = current_org() and side = 'staff' and status = 'active') then
      raise exception 'It reports to an active person in this company' using errcode='22023'; end if;
    update agent_member set owner_person_id = v_owner where person_id = p_agent;
    update people_profile set manager_id = v_owner where org_id = current_org() and person_id = p_agent;
  end if;
  if p ? 'pod' then update people_profile set pod = nullif(btrim(p->>'pod'), '') where org_id = current_org() and person_id = p_agent; end if;
  if p ? 'department' then update people_profile set department = left(nullif(btrim(p->>'department'), ''), 80) where org_id = current_org() and person_id = p_agent; end if;
  if p ? 'provider' then
    if p->>'provider' not in ('codex','claude') then raise exception 'Choose Claude or Codex' using errcode='22023'; end if;
    update agent_member set provider = p->>'provider' where person_id = p_agent;
  end if;
  if p ? 'model' then
    if coalesce(p->>'model', '') !~ '^[A-Za-z0-9._:-]{0,80}$' then raise exception 'Name the model in letters, digits, dots and dashes' using errcode='22023'; end if;
    update agent_member set runtime = coalesce(p->>'model', '') where person_id = p_agent;
  end if;
  if p ? 'effort' then
    if p->>'effort' not in ('low','medium','high','xhigh') then raise exception 'Choose low, medium, high or extra high effort' using errcode='22023'; end if;
    update agent_member set effort = p->>'effort' where person_id = p_agent;
  end if;
  if p ? 'lane' then
    if p->>'lane' not in ('quick','thinking') then raise exception 'Choose the quick or thinking lane' using errcode='22023'; end if;
    update agent_member set lane = p->>'lane' where person_id = p_agent;
  end if;
  if p ? 'dailyTokenBudget' then
    if coalesce(p->>'dailyTokenBudget', '') !~ '^[0-9]{4,7}$' or (p->>'dailyTokenBudget')::int not between 1000 and 2000000 then
      raise exception 'A daily limit of 1,000 to 2,000,000 tokens' using errcode='22023'; end if;
    update agent_member set daily_token_budget = (p->>'dailyTokenBudget')::int where person_id = p_agent;
  end if;
  if p ? 'runReserve' then
    if coalesce(p->>'runReserve', '') !~ '^[0-9]{4,6}$' or (p->>'runReserve')::int not between 1000 and 200000 then
      raise exception 'Each run reserves 1,000 to 200,000 tokens' using errcode='22023'; end if;
    update agent_member set run_reserve = (p->>'runReserve')::int where person_id = p_agent;
  end if;
  if p ? 'tools' then
    if jsonb_typeof(p->'tools') is distinct from 'array' then raise exception 'Choose its tools' using errcode='22023'; end if;
    for t in select jsonb_array_elements_text(p->'tools') loop
      if t not in ('chats','tasks','memory','board','drive','web') then raise exception 'Unknown tool %', left(t, 20) using errcode='22023'; end if;
    end loop;
    update agent_member set tools = array(select distinct x from jsonb_array_elements_text(p->'tools') x order by 1) where person_id = p_agent;
  end if;
  if p ? 'speakScope' then
    if p->>'speakScope' not in ('its_groups','listed','direct_only') then raise exception 'Choose where it may speak' using errcode='22023'; end if;
    update agent_member set speak_scope = p->>'speakScope' where person_id = p_agent;
  end if;
  if p ? 'speakChannels' then
    if jsonb_typeof(p->'speakChannels') is distinct from 'array' or jsonb_array_length(p->'speakChannels') > 100 then raise exception 'Choose up to 100 groups' using errcode='22023'; end if;
    v_channels := array(select distinct x::uuid from jsonb_array_elements_text(p->'speakChannels') x);
    if exists(select 1 from unnest(v_channels) c where not exists(select 1 from chat_channel ch where ch.id = c and ch.org_id = current_org() and ch.kind <> 'direct')) then
      raise exception 'Choose groups of this company' using errcode='22023'; end if;
    update agent_member set speak_channels = v_channels where person_id = p_agent;
  end if;
  if p ? 'interject' then
    if p->>'interject' not in ('when_asked','when_relevant') then raise exception 'Choose when it may speak up' using errcode='22023'; end if;
    update agent_member set interject = p->>'interject' where person_id = p_agent;
  end if;
end $$;

-- A note it keeps: from its manager or an admin, or from one of its own runs (its key, inside that run).
create function pulse.agent_memory_add(p_agent uuid, p_body text, p_run uuid default null) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); nid uuid; v_task uuid; b text := btrim(coalesce(p_body, ''));
begin
  if length(b) not between 1 and 1000 then raise exception 'Write the note in up to 1,000 characters' using errcode='22023'; end if;
  if me is not null then
    if me <> p_agent then raise exception 'An AI employee keeps its own notes' using errcode='42501'; end if;
    select case when e.subject_type = 'task' then e.subject_id end into v_task from agent_run r join agent_event e on e.id = r.event_id
     where r.id = p_run and r.agent_id = me and r.state = 'dispatching' and r.deadline > now();
    if not found then raise exception 'Keep a note inside one of your runs' using errcode='42501'; end if;
    if (select count(*) from agent_memory where agent_id = me and run_id = p_run) >= 5 then raise exception 'Five notes a run at most' using errcode='22023'; end if;
    insert into agent_memory(org_id, agent_id, body, source, task_id, run_id, created_by) values (current_org(), me, b, 'agent', v_task, p_run, me) returning id into nid;
  else
    if not agent_manage_ok(p_agent) then raise exception 'Its manager or an admin adds to what it knows' using errcode='42501'; end if;
    insert into agent_memory(org_id, agent_id, body, source, created_by) values (current_org(), p_agent, b, 'manager', current_viewer()) returning id into nid;
  end if;
  return nid;
end $$;
create function pulse.agent_memory_retire(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid;
begin
  select agent_id into a from agent_memory where id = p_id and org_id = current_org() and retired_at is null;
  if a is null or not agent_manage_ok(a) then raise exception 'Its manager or an admin removes a note' using errcode='42501'; end if;
  update agent_memory set retired_at = now(), retired_by = current_viewer() where id = p_id;
end $$;

-- Its runtime says how it is: ready, out of quota (until when, when the plan says), or failing; Pulse shows it as said.
create function pulse.agent_runtime_report(p_state text, p_until timestamptz, p_detail text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if p_state is null or p_state not in ('ready','out_of_quota','error') then raise exception 'Say ready, out_of_quota or error' using errcode='22023'; end if;
  update agent_member set runtime_state = p_state, runtime_seen_at = now(),
         runtime_until = case when p_state = 'out_of_quota' then least(p_until, now() + interval '14 days') end,
         runtime_detail = left(nullif(btrim(coalesce(p_detail, '')), ''), 200)
   where person_id = me and org_id = current_org();
end $$;

-- A run its plan refused (out of quota): the run closes without using the budget and the work waits, queued again for
-- when the plan resets (or an hour), its tries counted afresh, so nothing is lost or done twice.
create function pulse.agent_run_requeue(p_run uuid, p_until timestamptz) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; at timestamptz := least(coalesce(p_until, now() + interval '1 hour'), now() + interval '14 days');
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  perform agent_lock(me);
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me for update;
  if not found or r.state <> 'dispatching' then raise exception 'That run is not running' using errcode='22023'; end if;
  update agent_run set state = 'error', tokens = 0, seconds = 0, error_code = 'out_of_quota', finished_at = now() where id = r.id;
  update agent_event set state = 'queued', retry_at = greatest(at, now() + interval '1 minute'), attempts = 0, reason = 'out_of_quota', lease_token = null, lease_until = null
   where id = r.event_id;
  update agent_member set runtime_state = 'out_of_quota', runtime_until = at, runtime_seen_at = now() where person_id = me;
  return jsonb_build_object('retryAt', to_char(greatest(at, now() + interval '1 minute') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end $$;

-- A task given to an AI employee is one event for its runtime (again when it is given to it afresh).
create function pulse.agent_task_event() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if new.assignee_person_id is null or (TG_OP = 'UPDATE' and new.assignee_person_id is not distinct from old.assignee_person_id) then return null; end if;
  if new.status not in ('open','in_progress','blocked') or new.deleted_at is not null then return null; end if;
  if not exists(select 1 from agent_member m join person p on p.id = m.person_id where m.person_id = new.assignee_person_id and m.org_id = new.org_id
                  and m.disabled_at is null and not m.post_only and p.status = 'active' and 'tasks' = any(m.tools)) then return null; end if;
  insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
  values (new.org_id, new.assignee_person_id, 'task.assigned', 'task', new.id,
          'task:' || new.id || ':' || floor(extract(epoch from coalesce(new.assigned_at, now())))::bigint, coalesce(current_viewer(), new.created_by))
  on conflict do nothing;
  return null;
end $$;
create trigger agent_task_event after insert or update of assignee_person_id on pulse.task for each row execute function pulse.agent_task_event();

-- The latest chat this task's card is in that the AI employee belongs to (where it reports), or null.
create function pulse.agent_task_chat(p_task uuid, p_agent uuid) returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
  select m.channel_id from chat_message m join chat_member cm on cm.channel_id = m.channel_id and cm.person_id = p_agent
   where m.org_id = current_org() and m.attachments @> jsonb_build_array(jsonb_build_object('task', p_task::text)) and m.removed_at is null
   order by m.created_at desc limit 1
$$;

-- Dispatch a task: the same lease, lock, budget and run rules as a chat question (agent_dispatch), with the task, the
-- chat it was given in (its recent messages) and what the AI employee knows as the context.
create function pulse.agent_task_dispatch(p_id uuid, p_token uuid, p_lane text, p_model text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); e agent_event; m agent_member; t task; why text; busy text; committed int; rid uuid; dl timestamptz; cid uuid;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  m := agent_lock(me);
  select * into e from agent_event where id = p_id and org_id = current_org() and agent_id = me for update;
  if not found or e.state <> 'leased' or e.lease_token is distinct from p_token or e.lease_until <= now() then
    raise exception 'That event is not leased to you any more' using errcode='22023'; end if;
  if e.subject_type <> 'task' then raise exception 'Dispatch a chat question with agent_dispatch' using errcode='22023'; end if;
  perform agent_sweep(me);
  select * into t from task where id = e.subject_id and org_id = current_org();
  why := case
    when t.id is null or t.deleted_at is not null or t.status in ('done','accepted','cancelled') then 'task_gone'
    when t.assignee_person_id is distinct from me then 'not_assigned' end;
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
    when (select count(*) from agent_run where agent_id = me and started_at > now() - interval '1 hour') >= 60 then 'hourly_limit' end;
  if busy is not null then
    update agent_event set state = 'queued', lease_token = null, lease_until = null, retry_at = now() + interval '20 seconds', reason = busy where id = e.id;
    return jsonb_build_object('status', 'busy', 'reason', busy);
  end if;
  dl := now() + interval '9 minutes';
  insert into agent_run(org_id, agent_id, event_id, lane, model, reserved, deadline)
  values (current_org(), me, e.id, left(coalesce(nullif(p_lane, ''), m.lane), 40), left(coalesce(p_model, ''), 80), m.run_reserve, dl) returning id into rid;
  update agent_event set state = 'dispatching', run_id = rid, lease_token = null, lease_until = null, reason = null where id = e.id;
  update task set status = 'in_progress', updated_at = now() where id = t.id and status = 'open';
  cid := agent_task_chat(t.id, me);
  return jsonb_build_object('status', 'dispatched', 'runId', rid, 'reserved', m.run_reserve,
    'deadline', to_char(dl at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'context', jsonb_build_object(
      'task', jsonb_build_object('id', t.id, 'title', t.title, 'notes', left(coalesce(t.notes, ''), 3000), 'status', t.status, 'priority', t.priority,
        'dueOn', coalesce(t.work_on, (t.due_at at time zone org_time_zone())::date)::text,
        'project', (select coalesce(pr.title, pr.name) from project pr where pr.id = t.project_id),
        'givenBy', (select display_name from person where id = e.invoked_by), 'manager', (select display_name from person where id = m.owner_person_id)),
      'chat', case when cid is null then null else (select jsonb_build_object('channelId', ch.id, 'kind', ch.kind, 'name', case when ch.kind = 'direct' then null else ch.name end) from chat_channel ch where ch.id = cid) end,
      'recent', case when cid is null then '[]'::jsonb else (select coalesce(jsonb_agg(r.j order by r.at), '[]'::jsonb) from (
                  select x.created_at at, jsonb_build_object('author', p.display_name, 'byAgent', p.side = 'agent', 'mine', x.author_id = me, 'body', left(x.body, 600)) j
                    from chat_message x join person p on p.id = x.author_id
                   where x.channel_id = cid and x.removed_at is null and x.kind = 'text' order by x.created_at desc limit 14) r) end,
      'memory', (select coalesce(jsonb_agg(left(x.body, 400) order by x.created_at desc), '[]'::jsonb) from (
                  select body, created_at from agent_memory where agent_id = me and retired_at is null order by created_at desc limit 20) x)));
end $$;

-- Its report on a task, inside the run: posted in the task's chat (as its own message, with the task's card) and the
-- task moved: done goes to review (its manager reviews; nothing marks it accepted), blocked says so, progress and a
-- question leave it in progress. Its manager is told. The run's client key makes a retry the same message.
create function pulse.agent_task_report(p_run uuid, p_state text, p_body text, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; e agent_event; t task; m agent_member; cid uuid; mid uuid; b text := btrim(coalesce(p_body, '')); uname text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if p_state is null or p_state not in ('done','progress','blocked','question') then raise exception 'Say done, progress, blocked or question' using errcode='22023'; end if;
  if length(b) not between 1 and 4000 then raise exception 'Write the report in up to 4,000 characters' using errcode='22023'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Report inside the run' using errcode='42501'; end if;
  select * into e from agent_event where id = r.event_id;
  if e.subject_type <> 'task' then raise exception 'That run is not about a task' using errcode='22023'; end if;
  select * into t from task where id = e.subject_id and org_id = current_org() for update;
  select * into m from agent_member where person_id = me;
  cid := agent_task_chat(t.id, me);
  if cid is not null then
    select username into uname from people_profile where person_id = e.invoked_by;
    mid := chat_send(cid, case when p_state in ('done','question','blocked') and uname is not null then '@' || uname || ' ' else '' end || b, null,
      jsonb_build_array(jsonb_build_object('task', t.id::text, 'name', left(t.title, 300), 'url', '/tasks/' || t.id)), p_client, null);
    insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  end if;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'task', t.id) on conflict do nothing;
  if p_state = 'done' and t.status in ('open','in_progress','blocked') then
    update task set status = 'in_review', review_owner_id = coalesce(review_owner_id, m.owner_person_id), edited_by = me, updated_at = now() where id = t.id;
  elsif p_state = 'blocked' and t.status in ('open','in_progress') then
    update task set status = 'blocked', edited_by = me, updated_at = now() where id = t.id;
  end if;
  perform work_notify(m.owner_person_id, 'task.update', 'task', t.id, 'agent-report:' || r.id,
    (select display_name from person where id = me) || case p_state when 'done' then ' finished “' when 'blocked' then ' is blocked on “' when 'question' then ' has a question on “' else ' gave an update on “' end
      || left(t.title, 90) || '”', '/tasks/' || t.id, 'task');
  return jsonb_build_object('messageId', mid, 'chatId', cid, 'status', (select status from task where id = t.id));
end $$;

-- Claim for a runtime that says what it handles: an older runner (chat questions only) never leases a task. Work that
-- waits for a plan's quota is not given up after a day.
do $$
declare d text; c text;
begin
  d := pg_get_functiondef('pulse.agent_events_claim(int)'::regprocedure);
  c := replace(d, 'FUNCTION pulse.agent_events_claim(p_limit integer)', 'FUNCTION pulse.agent_events_claim_kinds(p_limit integer, p_tasks boolean)');
  c := replace(c, $x$     and (created_at < now() - interval '1 day' or attempts >= 5);$x$,
                  $x$     and (p_tasks or subject_type = 'message')
     and ((created_at < now() - interval '1 day' and reason is distinct from 'out_of_quota') or attempts >= 5);$x$);
  c := replace(c, $x$    select id from agent_event
     where org_id = current_org() and agent_id = me
$x$, $x$    select id from agent_event
     where org_id = current_org() and agent_id = me and (p_tasks or subject_type = 'message')
$x$);
  if c = d or position('agent_events_claim_kinds' in c) = 0 or position('reason is distinct from' in c) = 0 or position('me and (p_tasks or' in c) = 0 then
    raise exception 'agent_events_claim changed shape (CHAT-WORK)'; end if;
  execute c;

  -- A chat run is given what it knows too.
  d := pg_get_functiondef('pulse.agent_dispatch(uuid,uuid,text,text)'::regprocedure);
  c := replace(d, $x$    'context', jsonb_build_object($x$, $x$    'context', jsonb_build_object(
      'memory', (select coalesce(jsonb_agg(left(x.body, 400) order by x.created_at desc), '[]'::jsonb) from (
                  select body, created_at from agent_memory where agent_id = me and retired_at is null order by created_at desc limit 20) x),$x$);
  if c = d then raise exception 'agent_dispatch changed shape (CHAT-WORK)'; end if;
  execute c;

  -- Where it may speak: every group it is in, the listed groups only, or direct messages only.
  d := pg_get_functiondef('pulse.agent_event_from_chat()'::regprocedure);
  c := replace(d, $x$     where m.org_id = new.org_id and not m.post_only and m.disabled_at is null and p.status = 'active'$x$,
    $x$     where m.org_id = new.org_id and not m.post_only and m.disabled_at is null and p.status = 'active'
       and (ch.kind = 'direct' or m.speak_scope = 'its_groups' or (m.speak_scope = 'listed' and ch.id = any(m.speak_channels)))$x$);
  if c = d then raise exception 'agent_event_from_chat changed shape (CHAT-WORK)'; end if;
  execute c;

  -- A task can be given to an AI employee that takes tasks, by a leader or its manager, at once (no request to accept).
  d := pg_get_functiondef('pulse.task_save(uuid,jsonb)'::regprocedure);
  c := replace(d, $x$  if not task_person_ok(v_assignee) then raise exception 'Choose an active team member' using errcode='22023';end if;
  mode:=work_assign_mode(v_assignee,v_project,v_category,v_tags);$x$,
    $x$  if not (task_person_ok(v_assignee) or agent_takes_tasks(v_assignee)) then raise exception 'Choose an active team member' using errcode='22023';end if;
  mode:=case when agent_takes_tasks(v_assignee) then '{"mode":"direct"}'::jsonb else work_assign_mode(v_assignee,v_project,v_category,v_tags) end;$x$);
  if c = d then raise exception 'task_save changed shape (CHAT-WORK)'; end if;
  execute c;

  -- An AI employee sits in its pod's and its team's groups like a person (custom groups stay with their admins).
  d := pg_get_functiondef('pulse.chat_refresh()'::regprocedure);
  c := replace(d, $x$ where ch.org_id=current_org() and p.side='staff' and chat_current(p.id)$x$,
    $x$ where ch.org_id=current_org() and (p.side='staff' or p.side='agent' and ch.kind in ('pod','team') and exists(select 1 from agent_member am where am.person_id=p.id and am.disabled_at is null and not am.post_only)) and chat_current(p.id)$x$);
  if c = d then raise exception 'chat_refresh changed shape (CHAT-WORK)'; end if;
  execute c;
end $$;

-- Everything its profile shows, to whoever may see the AI employee (agent_profile's rule): settings, groups, notes,
-- runs, tasks and how its runtime is.
create function pulse.agent_detail(p_agent uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare m agent_member; pp people_profile;
begin
  if pulse.agent_profile(p_agent) is null then return null; end if;
  select * into m from agent_member where person_id = p_agent and org_id = current_org();
  select * into pp from people_profile where person_id = p_agent and org_id = current_org();
  return jsonb_build_object(
    'canManage', agent_manage_ok(p_agent), 'canGiveTasks', agent_takes_tasks(p_agent),
    'settings', jsonb_build_object('provider', m.provider, 'model', m.runtime, 'effort', m.effort, 'lane', m.lane, 'tools', to_jsonb(m.tools),
      'speakScope', m.speak_scope, 'speakChannels', to_jsonb(m.speak_channels), 'interject', m.interject, 'dailyTokenBudget', m.daily_token_budget,
      'runReserve', m.run_reserve, 'ownerId', m.owner_person_id, 'pod', pp.pod, 'department', pp.department, 'title', m.title),
    'runtime', jsonb_build_object('state', m.runtime_state, 'until', m.runtime_until, 'seenAt', m.runtime_seen_at, 'detail', m.runtime_detail,
      'keyUsedAt', (select max(k.last_used_at) from pulse_priv.agent_key k where k.person_id = p_agent and k.revoked_at is null and k.expires_at > now()),
      'keys', (select count(*) from pulse_priv.agent_key k where k.person_id = p_agent and k.revoked_at is null and k.expires_at > now()),
      'lastRun', (select jsonb_build_object('at', r.started_at, 'lane', r.lane, 'model', r.model, 'state', r.state, 'errorCode', r.error_code) from agent_run r
                   where r.agent_id = p_agent order by r.started_at desc limit 1)),
    'groups', (select coalesce(jsonb_agg(jsonb_build_object('id', ch.id, 'name', ch.name, 'kind', ch.kind) order by ch.kind, ch.name), '[]'::jsonb)
                 from chat_member cm join chat_channel ch on ch.id = cm.channel_id where cm.person_id = p_agent and ch.kind <> 'direct'),
    'memory', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'body', x.body, 'source', x.source, 'at', x.created_at, 'by', x.by, 'taskId', x.task_id) order by x.created_at desc), '[]'::jsonb)
                 from (select a.id, a.body, a.source, a.created_at, a.task_id, p.display_name by from agent_memory a join person p on p.id = a.created_by
                        where a.agent_id = p_agent and a.retired_at is null order by a.created_at desc limit 50) x),
    'runs', (select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) from (
               select r.started_at at, jsonb_build_object('id', r.id, 'at', r.started_at, 'state', r.state, 'lane', r.lane, 'model', r.model, 'tokens', r.tokens, 'seconds', r.seconds,
                 'errorCode', r.error_code, 'kind', e.event_type, 'taskId', case when e.subject_type = 'task' then e.subject_id end,
                 'taskTitle', (select tt.title from task tt where e.subject_type = 'task' and tt.id = e.subject_id and tt.id in (select task_visible_ids()))) j
                 from agent_run r join agent_event e on e.id = r.event_id where r.agent_id = p_agent order by r.started_at desc limit 25) x),
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object('id', tt.id, 'title', tt.title, 'status', tt.status, 'statusLabel', chat_task_label(tt.status), 'updatedAt', coalesce(tt.updated_at, tt.created_at))
                 order by coalesce(tt.updated_at, tt.created_at) desc), '[]'::jsonb)
                from (select * from task where assignee_person_id = p_agent and deleted_at is null and id in (select task_visible_ids()) order by coalesce(updated_at, created_at) desc limit 30) tt));
end $$;

revoke all on function pulse.agent_manage_ok(uuid), pulse.agent_takes_tasks(uuid), pulse.agent_settings_save(uuid,jsonb), pulse.agent_memory_add(uuid,text,uuid),
  pulse.agent_memory_retire(uuid), pulse.agent_runtime_report(text,timestamptz,text), pulse.agent_run_requeue(uuid,timestamptz), pulse.agent_task_event(),
  pulse.agent_task_chat(uuid,uuid), pulse.agent_task_dispatch(uuid,uuid,text,text), pulse.agent_task_report(uuid,text,text,uuid),
  pulse.agent_events_claim_kinds(int,boolean), pulse.agent_detail(uuid) from public;
grant execute on function pulse.agent_manage_ok(uuid), pulse.agent_takes_tasks(uuid), pulse.agent_settings_save(uuid,jsonb), pulse.agent_memory_add(uuid,text,uuid),
  pulse.agent_memory_retire(uuid), pulse.agent_runtime_report(text,timestamptz,text), pulse.agent_run_requeue(uuid,timestamptz),
  pulse.agent_task_dispatch(uuid,uuid,text,text), pulse.agent_task_report(uuid,text,text,uuid), pulse.agent_events_claim_kinds(int,boolean), pulse.agent_detail(uuid) to pulse_api;

-- migrate:down
-- Forward-only: an AI employee's notes, runs and reports stay auditable; switch it off instead.
