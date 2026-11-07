-- migrate:up
-- AI-AUTONOMY (owner, 28 Oct 2026): "the PM agent triages EA's unowned and undated tasks into proposals for leadership,
-- posted as one batched card, not 55 approvals." An AI employee that runs work proposes many task changes as ONE card
-- (agent_proposal kind 'batch': who takes each task and by when, with a reason each); its approver presses Apply all and
-- every change goes through task_save as that person (their rights, the task's own history). Its daily triage
-- (agent_member.daily_triage, set by its managers) gives it that job once a working day as a task of its own, when
-- there is work with no owner or no due day.

alter table pulse.agent_member add column if not exists daily_triage boolean not null default false;
alter table pulse.agent_proposal drop constraint if exists agent_proposal_kind_check;
alter table pulse.agent_proposal add constraint agent_proposal_kind_check check (kind in ('reply', 'task', 'summary', 'budget', 'batch'));

-- Its managers switch the daily triage on or off.
create or replace function pulse.agent_daily_triage_set(p_agent uuid, p_on boolean) returns boolean language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or not agent_manage_ok(p_agent) then raise exception 'Admins, HR, leadership or its manager change an AI employee' using errcode = '42501'; end if;
  update agent_member set daily_triage = coalesce(p_on, false) where person_id = p_agent and org_id = current_org();
  if not found then raise exception 'Choose an AI employee' using errcode = '22023'; end if;
  return coalesce(p_on, false);
end $$;

-- One card with many task changes, inside a run. Items: [{taskId, assignee (username), dueOn, why}] (up to 80).
create or replace function pulse.agent_propose_batch(p_run uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); r agent_run; m agent_member; ap uuid; dm uuid; k text; it jsonb; items jsonb := '[]'::jsonb; b text := ''; n int := 0;
  t task; who uuid; who_name text; due date; pid uuid; mid uuid; title text := left(btrim(coalesce(p->>'title', '')), 160);
begin
  if me is null or not agent_acts(me) then raise exception 'This AI employee does not run work itself' using errcode = '42501'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me;
  if not found then raise exception 'Propose inside one of your runs' using errcode = '42501'; end if;
  select id into pid from agent_proposal where run_id = r.id and kind = 'batch';
  if pid is not null then return (select jsonb_build_object('id', x.id, 'messageId', x.dm_message_id, 'chatId', x.dm_channel_id, 'items', jsonb_array_length(x.action->'items')) from agent_proposal x where x.id = pid); end if;
  if jsonb_typeof(p->'items') is distinct from 'array' then raise exception 'Send the changes' using errcode = '22023'; end if;
  for it in select x from jsonb_array_elements(p->'items') x limit 80 loop
    begin
      select * into t from task where id = (it->>'taskId')::uuid and org_id = current_org() and deleted_at is null;
    exception when others then t := null; end;
    if t.id is null then continue; end if;
    who := null; who_name := null; due := null;
    if coalesce(it->>'assignee', '') <> '' then
      select pe.id, pe.display_name into who, who_name from people_profile pp join person pe on pe.id = pp.person_id
       where pp.org_id = current_org() and lower(pp.username) = lower(btrim(it->>'assignee', ' @')) and pe.status = 'active' and pe.side = 'staff';
    end if;
    if coalesce(it->>'dueOn', '') ~ '^\d{4}-\d{2}-\d{2}$' then due := (it->>'dueOn')::date; end if;
    if who is null and due is null then continue; end if;
    n := n + 1;
    items := items || jsonb_build_object('taskId', t.id, 'title', left(t.title, 120), 'assigneeId', who, 'assigneeName', who_name, 'dueOn', due, 'why', left(coalesce(it->>'why', ''), 200));
    b := b || n || '. ' || left(t.title, 90) || ' → ' || concat_ws(', ', who_name, case when due is not null then 'due ' || to_char(due, 'FMDD Mon') end)
         || case when coalesce(it->>'why', '') <> '' then ' (' || left(it->>'why', 80) || ')' else '' end || chr(10);
  end loop;
  if n = 0 then raise exception 'None of the changes names a task and a person or a due day' using errcode = '22023'; end if;
  select * into m from agent_member where person_id = me;
  ap := coalesce(m.approver_person_id, m.owner_person_id);
  k := 'dm:' || least(me::text, ap::text) || ':' || greatest(me::text, ap::text);
  insert into chat_channel(org_id, key, name, kind, description) values (current_org(), k, 'Direct message', 'direct', 'A private conversation')
  on conflict (org_id, key) do update set key = excluded.key returning id into dm;
  insert into chat_member(org_id, channel_id, person_id) values (current_org(), dm, me), (current_org(), dm, ap) on conflict do nothing;
  insert into agent_proposal(org_id, agent_id, run_id, channel_id, source_message_id, approver_id, dm_channel_id, kind, body, why, action)
  values (current_org(), me, r.id, dm, null, ap, dm, 'batch', left(coalesce(nullif(title, ''), n || ' task changes') || chr(10) || b, 4000),
    left(nullif(btrim(coalesce(p->>'why', '')), ''), 1000), jsonb_build_object('type', 'task.batch', 'items', items))
  returning id into pid;
  mid := chat_send(dm, coalesce(nullif(title, ''), 'Triage') || ': ' || n || ' changes in one card. Apply all, or tell me what to change (a reply like "ok" works too).', null, '[]'::jsonb, gen_random_uuid(), null);
  update agent_proposal set dm_message_id = mid where id = pid;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  return jsonb_build_object('id', pid, 'messageId', mid, 'chatId', dm, 'items', n);
end $$;

-- The decision: a batch is applied change by change as the person who decided (task_save: their rights); everything else
-- is decided as before (the definition 0988 left, kept as agent_proposal_decide_one).
do $$
declare src text;
begin
  if to_regprocedure('pulse.agent_proposal_decide_one(uuid,text,text,text)') is null then
    src := pg_get_functiondef('pulse.agent_proposal_decide(uuid,text,text,text)'::regprocedure);
    src := replace(src, 'FUNCTION pulse.agent_proposal_decide(', 'FUNCTION pulse.agent_proposal_decide_one(');
    execute src;
  end if;
end $$;
create or replace function pulse.agent_proposal_decide(p_id uuid, p_action text, p_body text, p_via text default 'button') returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pr agent_proposal; me uuid := current_viewer(); it jsonb; ok int := 0; bad int := 0; note text := '';
begin
  select * into pr from agent_proposal where id = p_id and org_id = current_org();
  if not found or pr.kind <> 'batch' then return agent_proposal_decide_one(p_id, p_action, p_body, p_via); end if;
  if agent_session() is not null or me is null then raise exception 'A person decides' using errcode = '42501'; end if;
  select * into pr from agent_proposal where id = p_id for update;
  if pr.approver_id <> me and not agent_manage_ok(pr.agent_id) then raise exception 'Not found' using errcode = 'P0002'; end if;
  if p_action is null or p_action not in ('send', 'dismiss') then raise exception 'Apply them or don''t' using errcode = '22023'; end if;
  if pr.state <> 'pending' then return jsonb_build_object('state', pr.state, 'channelId', pr.channel_id); end if;
  if p_action = 'dismiss' then
    update agent_proposal set state = 'dismissed', decided_by = me, decided_at = now(), decided_via = coalesce(p_via, 'button') where id = pr.id;
    return jsonb_build_object('state', 'dismissed', 'channelId', pr.channel_id);
  end if;
  for it in select x from jsonb_array_elements(pr.action->'items') x loop
    begin
      perform task_save((it->>'taskId')::uuid, jsonb_strip_nulls(jsonb_build_object('assigneeId', it->>'assigneeId', 'dueOn', it->>'dueOn')));
      ok := ok + 1;
    exception when others then
      bad := bad + 1; note := note || '• ' || left(it->>'title', 60) || ': ' || left(sqlerrm, 80) || chr(10);
    end;
  end loop;
  update agent_proposal set state = 'sent', decided_by = me, decided_at = now(), decided_via = coalesce(p_via, 'button'),
    sent_body = left('Applied ' || ok || ' of ' || (ok + bad) || case when bad > 0 then '. Not applied:' || chr(10) || note else '' end, 4000) where id = pr.id;
  return jsonb_build_object('state', 'sent', 'applied', ok, 'failed', bad, 'channelId', pr.channel_id);
end $$;

-- AGENT tasks: an AI employee that runs work may give itself its daily triage (0965/AI-TASKS: AIs never give AIs work).
CREATE OR REPLACE FUNCTION pulse.agent_takes_tasks(p_person uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $$
  -- AI-AUTONOMY (1351): or an AI employee that runs work, giving itself its daily triage.
  select (agent_session() = p_person and agent_acts(p_person) and exists(select 1 from agent_member m where m.person_id = p_person and 'tasks' = any(m.tools) and m.disabled_at is null))
  or agent_session() is null and exists(select 1 from agent_member m join person p on p.id = m.person_id
    where m.org_id = current_org() and m.person_id = p_person and m.disabled_at is null and not m.post_only and p.status = 'active' and p.side = 'agent'
      and 'tasks' = any(m.tools) and (agent_leader(current_viewer()) or m.owner_person_id = current_viewer()
        -- AI-TASKS: or a colleague, as the organisation chose.
        or (exists(select 1 from person v where v.id = current_viewer() and v.org_id = current_org() and v.side = 'staff' and v.status = 'active')
            and case coalesce((select s.ai_task_from from work_settings s where s.org_id = current_org()), 'staff') when 'staff' then true when 'reach' then task_can_give(p_person) else false end)))
$$;

-- Its daily triage: once a working day, when work has no owner or due day, a task of its own to propose the fixes in one
-- card (its runtime works the task like any other).
create or replace function pulse.agent_triage_start() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); m agent_member; n int; tid uuid; ap uuid;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  select * into m from agent_member where person_id = me;
  if not m.daily_triage or not agent_acts(me) then return null; end if;
  if extract(hour from now() at time zone org_time_zone()) < 9 then return null; end if;
  if exists(select 1 from task where org_id = current_org() and created_by = me and title like 'Daily triage:%'
             and (created_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date) then return null; end if;
  select count(*) into n from task t where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled')
    and (t.assignee_person_id is null or t.due_at is null) and coalesce(t.created_by, '00000000-0000-0000-0000-000000000000'::uuid) <> me;
  if n = 0 then return jsonb_build_object('tasks', 0); end if;
  ap := coalesce(m.approver_person_id, m.owner_person_id);
  tid := task_save(null, jsonb_build_object('title', 'Daily triage: ' || n || ' tasks with no owner or due day (' || to_char(now() at time zone org_time_zone(), 'FMDD Mon') || ')',
    'assigneeId', me, 'reviewerId', ap, 'dueOn', (now() at time zone org_time_zone())::date,
    'notes', 'Look at the work view''s attention list. For each task with no owner or no due day, propose who takes it (by their role, pod and load) and by when, '
          || 'in ONE card: {"type": "propose.batch", "title": "Triage ' || to_char(now() at time zone org_time_zone(), 'FMDD Mon') || '", "items": [{"taskId", "assignee", "dueOn", "why"}]}. Do not change the tasks yourself; then mark this task done.'));
  return jsonb_build_object('tasks', n, 'taskId', tid);
end $$;

-- The batch action, for its runtime (agent_chief_act).
do $$
declare src text;
begin
  src := pg_get_functiondef('pulse.agent_chief_act(uuid,jsonb)'::regprocedure);
  if position('propose.batch' in src) = 0 then
    src := replace(src, $q$      elsif t = 'request' then$q$, $q$      elsif t = 'propose.batch' then
        res := jsonb_build_object('type', t, 'ok', true) || agent_propose_batch(p_run, a);
      elsif t = 'request' then$q$);
    execute src;
  end if;
end $$;

revoke all on function pulse.agent_daily_triage_set(uuid, boolean), pulse.agent_propose_batch(uuid, jsonb), pulse.agent_triage_start(),
  pulse.agent_proposal_decide_one(uuid, text, text, text) from public;
grant execute on function pulse.agent_daily_triage_set(uuid, boolean), pulse.agent_propose_batch(uuid, jsonb), pulse.agent_triage_start(),
  pulse.agent_proposal_decide_one(uuid, text, text, text) to pulse_api;

-- migrate:down
-- Forward-only.
