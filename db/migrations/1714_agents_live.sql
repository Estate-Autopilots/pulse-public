-- migrate:up
-- AGENTS-LIVE (1714, 7 Nov 2026). The owner found AI employees "not active" in tasks and discussions in Willow Lane and the
-- test companies, with no switch on the AI employee's page and no way to see whom he can call. Causes found:
--  1. A chat run's budget defaulted to 34,000 tokens (30,000 in + 4,000 out, 1003), and a run over twice that switched
--     the AI employee off. A quotation from one chat line (the playbook, the tool catalogue, three or four model calls)
--     uses 70,000 to 90,000, so Willow Lane's Quotation & Finance agent switched itself off after its first real quote.
--     Chat runs now default to 150,000 in + 12,000 out, like a small task run; an organisation's own budgets still win.
--  2. Pickers listed only AI employees already able to take the work (on, with the tool), so one that was off simply
--     vanished, and @mentions offered only the conversation's members, so an AI employee outside the discussion
--     "isn't in this conversation: it won't be told". Now pulse.agent_reach says, for the viewer, every AI employee's
--     state, whether it is in this conversation and whether the viewer may call it, give it work, add it here or
--     switch it on; pulse.agent_activate does it (the "Activate … for this discussion? Allow" step).

-- 1. Chat runs' default budget ---------------------------------------------------------------------------------------
do $$
declare d text; c text;
begin
  d := pg_get_functiondef('pulse.agent_run_finish(uuid,text,integer,numeric,text)'::regprocedure);
  c := replace(replace(d,
    $x$when kind = 'task' then 300000 else 30000 end$x$, $x$when kind = 'task' then 300000 else 150000 end$x$),
    $x$when kind = 'task' then 40000 else 4000 end$x$, $x$when kind = 'task' then 40000 else 12000 end$x$);
  if c = d then raise exception 'agent_run_finish changed shape (AGENTS-LIVE)'; end if;
  execute c;
end $$;

-- 2. Who the viewer can call, and where ----------------------------------------------------------------------------
-- Every AI employee of the organisation that answers (not a post-only notice sender), for a staff viewer. state: on,
-- paused (switched off by a guard or an admin, with the reason) or off (its person is not active). inChat: a member of
-- p_channel. canCall: it answers this viewer (it listens to everyone, or the viewer leads or manages it). canTask: the
-- viewer may give it a task now. canAdd: the viewer may bring it into p_channel. canSwitch: the viewer may switch it
-- on (admins and leadership, and its manager).
create function pulse.agent_reach(p_channel uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); lead boolean; admin boolean; here boolean := false; k text;
begin
  if me is null or agent_session() is not null
     or not exists (select 1 from person where id = me and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Sign in to see this' using errcode = '42501'; end if;
  lead := agent_leader(me); admin := viewer_is('admin', 'leadership');
  if p_channel is not null then
    select ch.kind into k from chat_channel ch where ch.id = p_channel and ch.org_id = current_org();
    here := k is not null and k <> 'direct' and exists (select 1 from chat_member where channel_id = p_channel and person_id = me);
  end if;
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.person_id, 'name', p.display_name, 'username', pp.username, 'employeeId', m.employee_id, 'title', m.title,
      'state', case when p.status <> 'active' then 'off' when m.disabled_at is not null then 'paused' else 'on' end,
      'pausedReason', m.paused_reason, 'runtime', m.runtime_state, 'runtimeSeenAt', m.runtime_seen_at,
      'tools', to_jsonb(m.tools),
      'inChat', p_channel is not null and exists (select 1 from chat_member x where x.channel_id = p_channel and x.person_id = m.person_id),
      'canCall', m.listens_to = 'everyone' or lead or m.owner_person_id = me,
      'canTask', agent_takes_tasks(m.person_id),
      'canAdd', here and (m.listens_to = 'everyone' or lead or m.owner_person_id = me),
      'canSwitch', admin or m.owner_person_id = me) order by m.employee_no), '[]'::jsonb)
    from agent_member m join person p on p.id = m.person_id left join people_profile pp on pp.person_id = m.person_id
   where m.org_id = current_org() and not m.post_only and p.status = 'active');
end $$;

-- 3. Activate an AI employee where the viewer wants it ---------------------------------------------------------------
-- p_for: 'chat' (answer in p_channel) or 'tasks' (take tasks). Switches it on when it is paused (admins, leadership and
-- its manager only), gives it the tool the place needs, and brings it into p_channel (the viewer must be in it, and
-- may call it). Recorded in the conversation and the audit log. Returns its reach row.
create function pulse.agent_activate(p_agent uuid, p_channel uuid, p_for text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); m agent_member; nm text; k text; tool text; switched boolean := false; added boolean := false;
begin
  if me is null or agent_session() is not null
     or not exists (select 1 from person where id = me and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Use your own Vitals account' using errcode = '42501'; end if;
  if coalesce(p_for, '') not in ('chat', 'tasks') then raise exception 'Say chat or tasks' using errcode = '22023'; end if;
  select a.* into m from agent_member a join person p on p.id = a.person_id
   where a.person_id = p_agent and a.org_id = current_org() and not a.post_only and p.status = 'active' and p.side = 'agent';
  if m.person_id is null then raise exception 'Choose an AI employee of this company' using errcode = '22023'; end if;
  if not (m.listens_to = 'everyone' or agent_leader(me) or m.owner_person_id = me) then
    raise exception 'This AI employee answers its manager and leadership; ask one of them to add it' using errcode = '42501'; end if;
  m := agent_lock(p_agent);
  select display_name into nm from person where id = p_agent;
  tool := case when p_for = 'tasks' then 'tasks' else 'chats' end;
  if m.disabled_at is not null or not (tool = any(m.tools)) then
    if not (viewer_is('admin', 'leadership') or m.owner_person_id = me) then
      raise exception '% is switched off. An admin or its manager switches it on.', nm using errcode = '42501'; end if;
    update agent_member set disabled_at = null, paused_reason = null,
           tools = array(select distinct x from unnest(tools || array[tool]) x order by 1)
     where person_id = p_agent;
    switched := true;
  end if;
  if p_channel is not null then
    select kind into k from chat_channel where id = p_channel and org_id = current_org();
    if k is null or k = 'direct' then raise exception 'Choose a group conversation' using errcode = '22023'; end if;
    if not exists (select 1 from chat_member where channel_id = p_channel and person_id = me) then
      raise exception 'Only the conversation''s members add someone to it' using errcode = '42501'; end if;
    if not exists (select 1 from chat_member where channel_id = p_channel and person_id = p_agent) then
      insert into chat_member (org_id, channel_id, person_id) values (current_org(), p_channel, p_agent);
      if k = 'custom' then
        insert into chat_group_agent (org_id, channel_id, agent_id, role, added_by) values (current_org(), p_channel, p_agent, 'assistant', me)
        on conflict (channel_id, agent_id) do nothing;
      end if;
      perform chat_event_line(p_channel, me, 'added ' || nm || ' (AI)');
      added := true;
    end if;
    -- It may speak here even when it speaks only in listed groups (or only in direct messages).
    update agent_member set speak_channels = array(select distinct x from unnest(speak_channels || array[p_channel]) x),
           speak_scope = case when speak_scope = 'direct_only' then 'listed' else speak_scope end
     where person_id = p_agent and speak_scope <> 'its_groups' and not (p_channel = any(speak_channels));
  end if;
  if switched or added then
    perform audit_write('agent_activate', 'agent_member', p_agent::text || ':' || p_for || coalesce(':' || p_channel::text, ''));
  end if;
  return (select x from jsonb_array_elements(agent_reach(p_channel)) x where x->>'id' = p_agent::text);
end $$;

-- 4. The On/Off switch on its profile: admins, leadership and its manager (agent_switch, for the co-worker list, stays
-- admins'). Switching on clears what paused it; switching off keeps its settings. Audited.
create function pulse.agent_power(p_agent uuid, p_on boolean) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or not (viewer_is('admin', 'leadership')
     or exists (select 1 from agent_member where person_id = p_agent and org_id = current_org() and owner_person_id = current_viewer())) then
    raise exception 'Admins, leadership or its manager switch an AI employee on or off' using errcode = '42501'; end if;
  if p_on is null then raise exception 'Switch it on or off' using errcode = '22023'; end if;
  if not exists (select 1 from agent_member where person_id = p_agent and org_id = current_org() and not post_only) then
    raise exception 'Choose an AI employee of this company' using errcode = '22023'; end if;
  perform agent_lock(p_agent);
  update agent_member set disabled_at = case when p_on then null else coalesce(disabled_at, now()) end,
         paused_reason = case when p_on then null else paused_reason end
   where person_id = p_agent and org_id = current_org();
  perform audit_write('agent_power', 'agent_member', p_agent::text || case when p_on then ':on' else ':off' end);
end $$;

-- 5. AI employees in a task's discussion and on its people ------------------------------------------------------------
-- The owner's "not active": an @mention of an AI employee in a task's (or project's) discussion raised "Mention active
-- team members" (work_comment_add / work_comment_post check task_person_ok, which is staff only), and adding one to a
-- task's people raised "Choose active team members". Now an AI employee of this company may be mentioned and added;
-- one that is switched off (or has Tasks off) is refused with its name and what to do, never "not active".
create function pulse.work_mention_ok(p_person uuid) returns void
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare a agent_member; nm text;
begin
  if task_person_ok(p_person) then return; end if;
  select m.* into a from agent_member m join person p on p.id = m.person_id
   where m.person_id = p_person and m.org_id = current_org() and not m.post_only and p.status = 'active' and p.side = 'agent';
  if a.person_id is null then raise exception 'Mention active team members' using errcode = '22023'; end if;
  select display_name into nm from person where id = p_person;
  if a.disabled_at is not null then raise exception '% is switched off. Activate it, then mention it again.', nm using errcode = '22023'; end if;
  if not ('tasks' = any(a.tools)) then raise exception '% does not work on tasks yet. Activate it for tasks, then mention it again.', nm using errcode = '22023'; end if;
end $$;

-- Why an AI employee cannot be given a task, in words (task_save's refusal); people keep "Choose an active team member".
create function pulse.work_assign_refusal(p_person uuid) returns void
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare a agent_member; nm text;
begin
  select m.* into a from agent_member m join person p on p.id = m.person_id
   where m.person_id = p_person and m.org_id = current_org() and not m.post_only and p.status = 'active' and p.side = 'agent';
  if a.person_id is null then raise exception 'Choose an active team member' using errcode = '22023'; end if;
  select display_name into nm from person where id = p_person;
  if a.disabled_at is not null then raise exception '% is switched off. Activate it to give it tasks.', nm using errcode = '22023'; end if;
  if not ('tasks' = any(a.tools)) then raise exception '% does not take tasks yet. Activate it for tasks.', nm using errcode = '22023'; end if;
  raise exception '% takes tasks from its manager and leadership in this company', nm using errcode = '42501';
end $$;

do $$
declare d text; c text; f text;
begin
  foreach f in array array['pulse.work_comment_add(uuid,uuid,text,uuid[])', 'pulse.work_comment_post(jsonb)'] loop
    d := pg_get_functiondef(f::regprocedure);
    c := replace(d, $x$if not task_person_ok(m) then raise exception 'Mention active team members' using errcode='22023';end if;$x$,
      $x$perform work_mention_ok(m); -- AGENTS-LIVE: an AI employee of this company may be mentioned$x$);
    if c = d then raise exception '% changed shape (AGENTS-LIVE)', f; end if;
    execute c;
  end loop;
  d := pg_get_functiondef('pulse.work_task_people(uuid,uuid[],uuid[])'::regprocedure);
  c := replace(d, $x$if not task_person_ok(m) then raise exception 'Choose active team members' using errcode='22023';end if;$x$,
    $x$if not task_person_ok(m) then perform work_mention_ok(m); end if; -- AGENTS-LIVE: an AI employee may be on a task's people$x$);
  if c = d then raise exception 'work_task_people changed shape (AGENTS-LIVE)'; end if;
  execute c;
  d := pg_get_functiondef('pulse.task_save(uuid,jsonb)'::regprocedure);
  c := replace(d, $x$if not (task_person_ok(v_assignee) or agent_takes_tasks(v_assignee)) then raise exception 'Choose an active team member' using errcode='22023';end if;$x$,
    $x$if not (task_person_ok(v_assignee) or agent_takes_tasks(v_assignee)) then perform work_assign_refusal(v_assignee); end if;$x$);
  if c = d then raise exception 'task_save changed shape (AGENTS-LIVE)'; end if;
  execute c;
end $$;

-- An @mentioned AI employee that is not the task's assignee is woken on the task (the assignee already is, by
-- agent_task_wake_comment): one look per comment, from a person's comment only.
create function pulse.agent_task_wake_mention() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m uuid;
begin
  if new.task_id is null or new.removed_at is not null or cardinality(new.mentions) = 0
     or not exists (select 1 from person where id = new.author_id and side = 'staff') then return null; end if;
  begin
    foreach m in array new.mentions loop
      if exists (select 1 from agent_member a join person p on p.id = a.person_id join task t on t.id = new.task_id
                  where a.person_id = m and a.org_id = new.org_id and p.side = 'agent' and p.status = 'active' and a.disabled_at is null
                    and not a.post_only and 'tasks' = any(a.tools) and t.assignee_person_id is distinct from m) then
        insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
        values (new.org_id, m, 'task.mention', 'task', new.task_id, left('task:' || new.task_id || ':mention:' || new.id, 200), new.author_id)
        on conflict do nothing;
      end if;
    end loop;
  -- A person's comment is never refused because of this.
  exception when others then raise warning 'agent_task_wake_mention: %', sqlerrm;
  end;
  return null;
end $$;
create trigger agent_task_wake_mention after insert on pulse.work_comment for each row execute function pulse.agent_task_wake_mention();

-- Its run on that mention: it reads the task (as on its own) and answers in the discussion; the task's status, plan and
-- work record stay the assignee's.
do $$
declare d text; c text; n text;
begin
  d := pg_get_functiondef('pulse.agent_task_dispatch(uuid,uuid,text,text)'::regprocedure);
  foreach n in array array[$x$when t.assignee_person_id is distinct from me then 'not_assigned' end;$x$,
      $x$insert into agent_task_work(org_id, task_id, agent_id) values (current_org(), t.id, me) on conflict (task_id) do nothing;$x$,
      $x$update task set status = 'in_progress', started_at = coalesce(started_at, now()), updated_at = now() where id = t.id and (status = 'open'$x$,
      $x$runs = runs + 1, last_run_id = rid, note = null, updated_at = now() where task_id = t.id;$x$] loop
    if position(n in d) = 0 then raise exception 'agent_task_dispatch changed shape (AGENTS-LIVE): %', left(n, 60); end if;
  end loop;
  c := replace(replace(replace(replace(d,
    $x$when t.assignee_person_id is distinct from me then 'not_assigned' end;$x$,
    $x$when t.assignee_person_id is distinct from me and split_part(e.event_key, ':', 3) <> 'mention' then 'not_assigned' end;$x$),
    $x$insert into agent_task_work(org_id, task_id, agent_id) values (current_org(), t.id, me) on conflict (task_id) do nothing;$x$,
    $x$insert into agent_task_work(org_id, task_id, agent_id) select current_org(), t.id, me where t.assignee_person_id = me on conflict (task_id) do nothing;$x$),
    $x$update task set status = 'in_progress', started_at = coalesce(started_at, now()), updated_at = now() where id = t.id and (status = 'open'$x$,
    $x$update task set status = 'in_progress', started_at = coalesce(started_at, now()), updated_at = now() where id = t.id and t.assignee_person_id = me and (status = 'open'$x$),
    $x$runs = runs + 1, last_run_id = rid, note = null, updated_at = now() where task_id = t.id;$x$,
    $x$runs = runs + 1, last_run_id = rid, note = null, updated_at = now() where task_id = t.id and t.assignee_person_id = me;$x$);
  execute c;
  d := pg_get_functiondef('pulse.agent_task_act(uuid,jsonb,uuid)'::regprocedure);
  c := replace(replace(d,
    $x$if t.assignee_person_id is distinct from me or t.deleted_at is not null$x$,
    $x$if (t.assignee_person_id is distinct from me and split_part(e.event_key, ':', 3) <> 'mention') or t.deleted_at is not null$x$),
    $x$select display_name into me_name from person where id = me;$x$,
    $x$select display_name into me_name from person where id = me;
  -- AGENTS-LIVE: called by a colleague's @mention on a task that is not its own: it answers in the discussion, nothing more.
  if t.assignee_person_id is distinct from me then return agent_task_mention_reply(r, t, p); end if;$x$);
  if c = d then raise exception 'agent_task_act changed shape (AGENTS-LIVE)'; end if;
  execute c;
end $$;

-- Its answer to that mention: a comment on the task (its @mentions of colleagues tell them), once per run.
create function pulse.agent_task_mention_reply(r pulse.agent_run, t pulse.task, p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := r.agent_id; body text := left(btrim(coalesce(p->>'comment', '')), 4000); v uuid[]; cid uuid; who uuid; nm text;
begin
  select o.subject_id into cid from agent_output o where o.run_id = r.id and o.subject_type = 'comment' limit 1;
  if cid is null and body <> '' then
    select coalesce(array_agg(distinct p2.id), '{}') into v from regexp_matches(body, '@([A-Za-z0-9._-]+)', 'g') mm
      join people_profile pp on lower(pp.username) = lower(rtrim(mm[1], '.')) and pp.org_id = current_org() join person p2 on p2.id = pp.person_id
     where p2.side = 'staff' and p2.status = 'active' and p2.id <> me;
    v := v[1:20];
    insert into work_comment(org_id, task_id, author_id, body, mentions) values (current_org(), t.id, me, body, v) returning id into cid;
    insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'comment', cid) on conflict do nothing;
    select display_name into nm from person where id = me;
    foreach who in array v loop
      perform work_notify(who, 'task.mention', 'comment', cid, cid::text, nm || ' on “' || left(t.title, 70) || '”: ' || left(regexp_replace(body, '\s+', ' ', 'g'), 70), '/tasks/' || t.id, 'mention');
    end loop;
  end if;
  return jsonb_build_object('status', t.status, 'phase', null, 'commentId', cid, 'files', 0, 'subtasks', '[]'::jsonb, 'followups', '[]'::jsonb,
    'messages', 0, 'cards', 0, 'posted', false, 'skipped', '[]'::jsonb);
end $$;
revoke all on function pulse.work_mention_ok(uuid), pulse.work_assign_refusal(uuid), pulse.agent_task_wake_mention(),
  pulse.agent_task_mention_reply(pulse.agent_run, pulse.task, jsonb) from public;

revoke all on function pulse.agent_reach(uuid), pulse.agent_activate(uuid, uuid, text), pulse.agent_power(uuid, boolean) from public;
grant execute on function pulse.agent_reach(uuid), pulse.agent_activate(uuid, uuid, text), pulse.agent_power(uuid, boolean) to pulse_api;

-- migrate:down
do $$
declare d text; f text;
begin
  foreach f in array array['pulse.work_comment_add(uuid,uuid,text,uuid[])', 'pulse.work_comment_post(jsonb)'] loop
    execute replace(pg_get_functiondef(f::regprocedure), $x$perform work_mention_ok(m); -- AGENTS-LIVE: an AI employee of this company may be mentioned$x$,
      $x$if not task_person_ok(m) then raise exception 'Mention active team members' using errcode='22023';end if;$x$);
  end loop;
  execute replace(pg_get_functiondef('pulse.work_task_people(uuid,uuid[],uuid[])'::regprocedure),
    $x$if not task_person_ok(m) then perform work_mention_ok(m); end if; -- AGENTS-LIVE: an AI employee may be on a task's people$x$,
    $x$if not task_person_ok(m) then raise exception 'Choose active team members' using errcode='22023';end if;$x$);
  execute replace(pg_get_functiondef('pulse.task_save(uuid,jsonb)'::regprocedure),
    $x$if not (task_person_ok(v_assignee) or agent_takes_tasks(v_assignee)) then perform work_assign_refusal(v_assignee); end if;$x$,
    $x$if not (task_person_ok(v_assignee) or agent_takes_tasks(v_assignee)) then raise exception 'Choose an active team member' using errcode='22023';end if;$x$);
  d := pg_get_functiondef('pulse.agent_task_dispatch(uuid,uuid,text,text)'::regprocedure);
  execute replace(replace(replace(replace(d,
    $x$ and split_part(e.event_key, ':', 3) <> 'mention' then 'not_assigned'$x$, $x$ then 'not_assigned'$x$),
    $x$select current_org(), t.id, me where t.assignee_person_id = me on conflict$x$, $x$values (current_org(), t.id, me) on conflict$x$),
    $x$where id = t.id and t.assignee_person_id = me and (status = 'open'$x$, $x$where id = t.id and (status = 'open'$x$),
    $x$where task_id = t.id and t.assignee_person_id = me;$x$, $x$where task_id = t.id;$x$);
  d := pg_get_functiondef('pulse.agent_task_act(uuid,jsonb,uuid)'::regprocedure);
  execute replace(replace(d,
    $x$if (t.assignee_person_id is distinct from me and split_part(e.event_key, ':', 3) <> 'mention') or t.deleted_at is not null$x$,
    $x$if t.assignee_person_id is distinct from me or t.deleted_at is not null$x$),
    $x$
  -- AGENTS-LIVE: called by a colleague's @mention on a task that is not its own: it answers in the discussion, nothing more.
  if t.assignee_person_id is distinct from me then return agent_task_mention_reply(r, t, p); end if;$x$, '');
end $$;
drop trigger if exists agent_task_wake_mention on pulse.work_comment;
drop function if exists pulse.agent_task_wake_mention(), pulse.agent_task_mention_reply(pulse.agent_run, pulse.task, jsonb),
  pulse.work_mention_ok(uuid), pulse.work_assign_refusal(uuid);
drop function if exists pulse.agent_power(uuid, boolean);
drop function if exists pulse.agent_activate(uuid, uuid, text);
drop function if exists pulse.agent_reach(uuid);
do $$
declare d text;
begin
  d := pg_get_functiondef('pulse.agent_run_finish(uuid,text,integer,numeric,text)'::regprocedure);
  execute replace(replace(d,
    $x$when kind = 'task' then 300000 else 150000 end$x$, $x$when kind = 'task' then 300000 else 30000 end$x$),
    $x$when kind = 'task' then 40000 else 12000 end$x$, $x$when kind = 'task' then 40000 else 4000 end$x$);
end $$;
