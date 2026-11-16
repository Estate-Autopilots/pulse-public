-- migrate:up
-- AI-TASKS (owner, 25 Oct 2026: "AI employees working and doing tasks like a real employee would, completely, in Work
-- and tasks; we should be able to assign tasks directly to AI agents as well"). On CHAT-WORK's AI employee (0906: a
-- task given to it is one event, one run, one report), an AI employee now works a task the way a colleague does:
--  * Anyone on the staff gives an AI employee a task (the organisation may narrow it to Who can do what, or to leaders
--    and its manager: work_settings.ai_task_from); its manager hears about every task it is given; reassigning to it
--    works (work_assign_mode).
--  * A person always reviews an AI employee's work (the giver, else its manager); an AI never accepts, rates,
--    acknowledges or returns any task.
--  * It is woken on its task when it is given the task, when someone writes on the task, when the reviewer returns it
--    with a note, when a sub-task it made is finished, when a colleague it asked answers in their direct message, and
--    each working day for its open tasks (priority, then due date). Every wake-up is the existing task event, so the
--    same lease, lock, run and budget rules apply (task.mention, reserved by 0510 and unused, carries the cause).
--  * In a run it plans (the plan is posted on the task and kept as steps it ticks), comments on the task (mentioning
--    colleagues asks them), attaches what it wrote (documents as text files), messages colleagues directly about the
--    task, makes sub-tasks for people when it needs a person, drafts client messages as cards for its approver (never
--    sent by it), moves the task (in progress, waiting, in review) and submits it to its reviewer.
--  * The task page reads its state ("AI working", its plan, whom it waits for, its runs and tokens); its profile reads
--    its queue; admins, leaders and its managers read throughput and cost per AI employee.
-- Functions rewritten whole here are copied from their latest definitions (task_review_check 0310, task_return 0310,
-- agent_takes_tasks 0906, agent_task_dispatch 0952, agent_task_report 0906) with only the lines marked AI-TASKS added;
-- task_save and work_assign_mode are patched in place (their shape is checked). Additive: no column dropped, no row
-- changed; people's rules are unchanged.

-- 1. Who may give an AI employee a task -----------------------------------------------------------------------------
-- The organisation's choice (decision ai-tasks-who-gives): anyone on the staff (the default), like a colleague (Who can
-- do what reaches its pod), or only leaders and its manager (as before). Leaders and its manager always may.
alter table pulse.work_settings add column ai_task_from text not null default 'staff' check (ai_task_from in ('staff','reach','leaders'));
create or replace function pulse.agent_takes_tasks(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
  select agent_session() is null and exists(select 1 from agent_member m join person p on p.id = m.person_id
    where m.org_id = current_org() and m.person_id = p_person and m.disabled_at is null and not m.post_only and p.status = 'active' and p.side = 'agent'
      and 'tasks' = any(m.tools) and (agent_leader(current_viewer()) or m.owner_person_id = current_viewer()
        -- AI-TASKS: or a colleague, as the organisation chose.
        or (exists(select 1 from person v where v.id = current_viewer() and v.org_id = current_org() and v.side = 'staff' and v.status = 'active')
            and case coalesce((select s.ai_task_from from work_settings s where s.org_id = current_org()), 'staff') when 'staff' then true when 'reach' then task_can_give(p_person) else false end)))
$$;

do $$
declare d text; c text;
begin
  -- Reassigning to an AI employee (the task page, bulk): direct when the viewer may give it work, else not at all.
  d := pg_get_functiondef('pulse.work_assign_mode(uuid,uuid,text,text[])'::regprocedure);
  c := replace(d, $x$ if not task_person_ok(p_person) then return jsonb_build_object('mode','none','why','inactive');end if;$x$,
    $x$ -- AI-TASKS: an AI employee takes work at once from whoever may give it work, and from nobody else.
 if exists(select 1 from person where id=p_person and org_id=current_org() and side='agent') then
  return case when agent_takes_tasks(p_person) then jsonb_build_object('mode','direct','why','ai_employee') else jsonb_build_object('mode','none','why','ai_employee') end;
 end if;
 if not task_person_ok(p_person) then return jsonb_build_object('mode','none','why','inactive');end if;$x$);
  if c = d then raise exception 'work_assign_mode changed shape (AI-TASKS)'; end if;
  execute c;

  -- A person always reviews an AI employee's task: the giver when a colleague gives it, else the AI's manager.
  d := pg_get_functiondef('pulse.task_save(uuid,jsonb)'::regprocedure);
  c := replace(d, $x$ if v_reviewer=v_assignee then v_reviewer:=null;end if;$x$,
    $x$ if v_reviewer=v_assignee then v_reviewer:=null;end if;
 -- AI-TASKS: an AI employee's work is always reviewed by a person (never by itself or another AI).
 if v_assignee is not null and exists(select 1 from person where id=v_assignee and side='agent')
  and (v_reviewer is null or not exists(select 1 from person where id=v_reviewer and side='staff' and status='active')) then
  v_reviewer:=coalesce((select id from person where id=me and side='staff' and status='active'),(select owner_person_id from agent_member where person_id=v_assignee));
 end if;$x$);
  if c = d then raise exception 'task_save changed shape (AI-TASKS)'; end if;
  execute c;
end $$;

-- 2. An AI never reviews ------------------------------------------------------------------------------------------
create or replace function pulse.task_review_check(t pulse.task, me uuid) returns void language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 -- AI-TASKS: accepting, rating and acknowledging work is a person's (task_review, task_accept, task_acknowledge).
 if agent_session() is not null then raise exception 'A person reviews work, never an AI employee' using errcode='42501';end if;
 if me=coalesce(t.assignee_person_id,t.owner_id) then raise exception 'Someone else accepts your work' using errcode='42501';end if;
 if not (me=t.review_owner_id or (t.review_owner_id is null and (viewer_is('admin','leadership') or coalesce(manages(t.assignee_person_id),false)))
  or (task_is_leader(coalesce(t.assignee_person_id,t.owner_id)) and viewer_is('admin','leadership'))) then
  raise exception 'Only the reviewer accepts this task' using errcode='42501';end if;
 if t.status not in ('done','in_review') then raise exception 'Mark the task Done before accepting it' using errcode='22023';end if;
 if exists(select 1 from project where id=t.project_id and requires_proof) and not exists(select 1 from task_proof where task_id=t.id and removed_at is null) then
  raise exception 'This project needs proof before acceptance: attach a file or link' using errcode='22023';end if;
end $$;

create or replace function pulse.task_return(p_id uuid, p_note text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;
begin
 -- AI-TASKS: returning work is a person's too.
 if agent_session() is not null then raise exception 'A person reviews work, never an AI employee' using errcode='42501';end if;
 select * into t from task where org_id=current_org() and id=p_id for update;
 if not found or not task_visible(p_id) then raise exception 'Task not found' using errcode='P0002';end if;
 if not (me=t.review_owner_id or viewer_is('admin','leadership')) or me=t.assignee_person_id then raise exception 'Only the reviewer returns this task' using errcode='42501';end if;
 if t.status not in ('done','in_review','accepted') then raise exception 'Only finished work can be returned' using errcode='22023';end if;
 if length(btrim(coalesce(p_note,'')))<3 then raise exception 'Say what still needs doing' using errcode='22023';end if;
 update task set status='in_progress',done_at=null,accepted_at=null,accepted_by=null,updated_at=now(),edited_by=me where id=p_id;
 perform task_event_add(p_id,'returned',t.status,'in_progress',btrim(p_note));
 perform task_notify(coalesce(t.owner_id,t.assignee_person_id),'task.assigned',p_id,p_id||':returned:'||now()::text,'Returned with a note: '||t.title);
end $$;

-- 3. What it keeps per task: its plan, where the work stands, whom it waits for, what it cost --------------------------
create table pulse.agent_task_work (
  org_id uuid not null references pulse.org(id),
  task_id uuid primary key references pulse.task(id),
  agent_id uuid not null references pulse.agent_member(person_id),
  given_by uuid references pulse.person(id),
  phase text not null default 'queued' check (phase in ('queued','working','waiting','in_review','returned','stopped')),
  plan jsonb not null default '[]' check (jsonb_typeof(plan) = 'array' and jsonb_array_length(plan) <= 12),
  waiting_on text check (length(waiting_on) <= 300),
  note text check (length(note) <= 300),
  runs int not null default 0,
  continues int not null default 0,
  continue_day date,
  last_run_id uuid references pulse.agent_run(id),
  last_act_run uuid,
  last_act jsonb,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  updated_at timestamptz not null default now()
);
create index agent_task_work_agent on pulse.agent_task_work (org_id, agent_id, updated_at desc);
alter table pulse.agent_task_work enable row level security;
alter table pulse.agent_task_work force row level security;
create policy tenant on pulse.agent_task_work using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy visible on pulse.agent_task_work as restrictive for select to pulse_api using (pulse.task_visible(task_id));
grant select on pulse.agent_task_work to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.agent_task_work for each row execute function pulse.audit_mutation();

-- Whom it asked about a task (a comment mentioning them, or a direct message), until they answer.
create table pulse.agent_task_ask (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references pulse.task(id),
  agent_id uuid not null references pulse.agent_member(person_id),
  person_id uuid not null references pulse.person(id),
  via text not null check (via in ('comment','direct')),
  dm_channel_id uuid references pulse.chat_channel(id),
  question text not null check (length(btrim(question)) between 1 and 1500),
  run_id uuid references pulse.agent_run(id),
  asked_at timestamptz not null default now(),
  answered_at timestamptz,
  answer text check (length(answer) <= 4000)
);
create index agent_task_ask_open on pulse.agent_task_ask (org_id, person_id, asked_at desc) where answered_at is null;
create index agent_task_ask_task on pulse.agent_task_ask (org_id, task_id, asked_at desc);
alter table pulse.agent_task_ask enable row level security;
alter table pulse.agent_task_ask force row level security;
create policy tenant on pulse.agent_task_ask using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy visible on pulse.agent_task_ask as restrictive for select to pulse_api using (pulse.task_visible(task_id));
grant select on pulse.agent_task_ask to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.agent_task_ask for each row execute function pulse.audit_mutation();

-- 4. Wake-ups -------------------------------------------------------------------------------------------------------
-- One more look at the task for its AI employee: queued unless a look is already waiting (that run reads the latest
-- thread anyway). Never for what it did itself, never on a finished task, never for an AI that is off.
create function pulse.agent_task_wake(p_task uuid, p_cause text, p_ref text, p_by uuid) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t task; queued boolean;
begin
  select * into t from task where id = p_task;
  if t.id is null or t.assignee_person_id is null or t.deleted_at is not null or t.status not in ('open','in_progress','blocked','in_review') then return false; end if;
  if p_by is not distinct from t.assignee_person_id then return false; end if;
  if not exists(select 1 from agent_member m join person p on p.id = m.person_id where m.person_id = t.assignee_person_id and m.org_id = t.org_id and p.side = 'agent'
                  and m.disabled_at is null and not m.post_only and p.status = 'active' and 'tasks' = any(m.tools)) then return false; end if;
  if exists(select 1 from agent_event where org_id = t.org_id and agent_id = t.assignee_person_id and subject_type = 'task' and subject_id = t.id and state = 'queued') then return false; end if;
  insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
  values (t.org_id, t.assignee_person_id, 'task.mention', 'task', t.id, left('task:' || t.id || ':' || p_cause || ':' || coalesce(p_ref, ''), 200), coalesce(p_by, t.created_by))
  on conflict do nothing;
  queued := found;
  if queued then update agent_task_work set phase = case when phase = 'in_review' and p_cause <> 'returned' then phase when p_cause = 'returned' then 'returned' else 'queued' end, updated_at = now() where task_id = t.id; end if;
  return queued;
end $$;

-- Someone wrote on its task (an answer, a question, a note): it reads it. An answer from someone it asked closes the ask.
create function pulse.agent_task_wake_comment() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if new.task_id is null or new.removed_at is not null then return null; end if;
  if not exists(select 1 from task t join person a on a.id = t.assignee_person_id where t.id = new.task_id and a.side = 'agent')
     or not exists(select 1 from person where id = new.author_id and side = 'staff') then return null; end if;
  begin
    update agent_task_ask set answered_at = now(), answer = left(new.body, 4000)
     where org_id = new.org_id and task_id = new.task_id and person_id = new.author_id and answered_at is null;
    perform agent_task_wake(new.task_id, 'comment', new.id::text, new.author_id);
  -- A person's comment is never refused because of this.
  exception when others then
    raise warning 'agent_task_wake_comment: %', sqlerrm;
  end;
  return null;
end $$;
create trigger agent_task_wake after insert on pulse.work_comment for each row execute function pulse.agent_task_wake_comment();

-- The reviewer returned it with a note.
create function pulse.agent_task_wake_returned() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if new.kind <> 'returned' then return null; end if;
  begin
    perform agent_task_wake(new.task_id, 'returned', new.id::text, new.actor_id);
  exception when others then
    raise warning 'agent_task_wake_returned: %', sqlerrm;
  end;
  return null;
end $$;
create trigger agent_task_wake after insert on pulse.task_event for each row execute function pulse.agent_task_wake_returned();

-- A sub-task of its task was finished, sent for review, accepted or cancelled.
create function pulse.agent_task_wake_child() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if new.parent_id is null or new.status is not distinct from old.status or new.status not in ('done','in_review','accepted','cancelled') then return null; end if;
  if old.status in ('done','in_review','accepted','cancelled') and new.status <> 'cancelled' then return null; end if;
  if not exists(select 1 from task t join person a on a.id = t.assignee_person_id where t.id = new.parent_id and a.side = 'agent') then return null; end if;
  begin
    perform agent_task_wake(new.parent_id, 'subtask', new.id::text, coalesce(current_viewer(), new.edited_by, new.created_by));
  exception when others then
    raise warning 'agent_task_wake_child: %', sqlerrm;
  end;
  return null;
end $$;
create trigger agent_task_wake_child after update of status on pulse.task for each row execute function pulse.agent_task_wake_child();

-- A colleague it asked about a task answered in their direct message with it: that message becomes the task's look
-- (instead of a chat answer, so it does not answer twice), and the ask is closed. Runs after the chat and consult
-- triggers (names sort after agent_zconsult_answer). The newest question in that conversation gets the answer: when
-- the AI's consult question there is newer than its task question, the consult keeps it; when the task question is
-- newer, the answer is the task's and a consult this message had just answered for the first time is open again.
-- Imported history never wakes it (like 1051's consult trigger).
create function pulse.agent_task_dm_answer() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a agent_task_ask; t task; cons_id uuid; cons_at timestamptz; moved boolean;
begin
  if new.kind <> 'text' or new.removed_at is not null or btrim(coalesce(new.body, '')) = '' then return null; end if;
  if not exists(select 1 from agent_task_ask where org_id = new.org_id and dm_channel_id = new.channel_id and person_id = new.author_id and via = 'direct'
                  and answered_at is null and asked_at > now() - interval '3 days') then return null; end if;
  if not exists(select 1 from person where id = new.author_id and side = 'staff') then return null; end if;
  begin
  for a in select distinct on (agent_id) * from agent_task_ask
            where org_id = new.org_id and dm_channel_id = new.channel_id and person_id = new.author_id and via = 'direct' and answered_at is null
              and asked_at > now() - interval '3 days' order by agent_id, asked_at desc loop
    select * into t from task where id = a.task_id;
    if t.id is null or t.assignee_person_id is distinct from a.agent_id or t.deleted_at is not null or t.status not in ('open','in_progress','blocked','in_review') then continue; end if;
    if exists(select 1 from agent_event where org_id = new.org_id and agent_id = a.agent_id and event_key = 'message:' || new.id and event_type = 'consult.answer') then
      select c.id, c.created_at into cons_id, cons_at from agent_consult c where c.org_id = new.org_id and c.agent_id = a.agent_id and c.dm_channel_id = new.channel_id
         and c.colleague_id = new.author_id order by c.created_at desc limit 1;
      if cons_at is not null and cons_at > a.asked_at then continue; end if;
      -- Put back only what the consult trigger just did for this message (its first answer); an answered consult stays.
      update agent_consult set state = 'open', answer_message_id = null, answered_at = null
       where id = cons_id and answer_message_id = new.id and state = 'answered' and answered_at = now();
    end if;
    update agent_event set event_type = 'task.mention', subject_type = 'task', subject_id = a.task_id, event_key = left('task:' || a.task_id || ':direct:' || new.id, 200)
     where org_id = new.org_id and agent_id = a.agent_id and event_key = 'message:' || new.id and state = 'queued';
    moved := found;
    update agent_task_ask set answered_at = now(), answer = left(new.body, 4000) where org_id = new.org_id and task_id = a.task_id and person_id = new.author_id and answered_at is null;
    if not moved then perform agent_task_wake(a.task_id, 'direct', new.id::text, new.author_id); end if;
  end loop;
  -- A person's message is never refused because of this.
  exception when others then
    raise warning 'agent_task_dm_answer: %', sqlerrm;
  end;
  return null;
end $$;
create trigger agent_ztask_answer after insert on pulse.chat_message for each row when (new.import_ref is null) execute function pulse.agent_task_dm_answer();

-- Its manager hears about every task a colleague gives it (the manager may change what it works on), and follows it.
create function pulse.agent_task_given() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare boss uuid; giver uuid := current_viewer();
begin
  if new.assignee_person_id is null or (TG_OP = 'UPDATE' and new.assignee_person_id is not distinct from old.assignee_person_id) then return null; end if;
  select m.owner_person_id into boss from agent_member m join person p on p.id = m.person_id where m.person_id = new.assignee_person_id and p.side = 'agent';
  if boss is null then return null; end if;
  begin
  insert into agent_task_work(org_id, task_id, agent_id, given_by) values (new.org_id, new.id, new.assignee_person_id, coalesce(giver, new.created_by))
  on conflict (task_id) do update set agent_id = excluded.agent_id, given_by = excluded.given_by, phase = 'queued', plan = '[]', waiting_on = null, note = null, submitted_at = null, started_at = now(), updated_at = now();
  -- Its manager and whoever gave it follow the task (watchers: they see it and hear when it moves; task.update reaches
  -- only people who follow a task).
  insert into task_member(org_id, task_id, person_id, role, added_by)
  select new.org_id, new.id, x.p, 'watcher', coalesce(giver, boss) from (select boss p union select giver) x
   where x.p is not null and x.p <> new.assignee_person_id and exists(select 1 from person where id = x.p and side = 'staff' and status = 'active')
     and not exists(select 1 from task_member m where m.org_id = new.org_id and m.task_id = new.id and m.person_id = x.p and m.removed_at is null);
  if giver is not null and giver is distinct from boss and giver is distinct from new.assignee_person_id then
    perform work_notify(boss, 'task.update', 'task', new.id, 'ai-given:' || new.id || ':' || new.assignee_person_id,
      work_first_name(giver) || ' gave ' || (select display_name from person where id = new.assignee_person_id) || ' “' || left(new.title, 90) || '”', '/tasks/' || new.id, 'task');
  end if;
  exception when others then
    raise warning 'agent_task_given: %', sqlerrm;
  end;
  return null;
end $$;
create trigger agent_task_given after insert or update of assignee_person_id on pulse.task for each row execute function pulse.agent_task_given();

-- Each working day (from 9 in the morning, the organisation's clock) its open tasks get a look, the most important and
-- soonest due first, when nothing happened on them for 20 hours. Called by its runtime; at most once a task a day.
create function pulse.agent_tasks_daily() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r record; n int := 0; d date := (now() at time zone org_time_zone())::date;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if extract(hour from now() at time zone org_time_zone()) < 9 then return jsonb_build_object('queued', 0, 'why', 'before working hours'); end if;
  for r in select t.id from task t left join agent_task_work w on w.task_id = t.id
            where t.org_id = current_org() and t.assignee_person_id = me and t.deleted_at is null and t.status in ('open','in_progress','blocked')
              and coalesce(w.updated_at, t.updated_at, t.created_at) < now() - interval '20 hours'
              and not exists(select 1 from agent_event e where e.agent_id = me and e.subject_type = 'task' and e.subject_id = t.id and e.state in ('queued','leased','dispatching'))
            order by case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.due_at nulls last, t.created_at
            limit 10 loop
    insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
    values (current_org(), me, 'task.mention', 'task', r.id, 'task:' || r.id || ':daily:' || d, me) on conflict do nothing;
    if found then n := n + 1; end if;
  end loop;
  return jsonb_build_object('queued', n);
end $$;

-- 5. A run on a task: the task, what happened since its last look, the thread, its plan, its asks, sub-tasks, files ------
create or replace function pulse.agent_task_dispatch(p_id uuid, p_token uuid, p_lane text, p_model text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); e agent_event; m agent_member; t task; why text; busy text; committed int; rid uuid; dl timestamptz; cid uuid;
  w agent_task_work; cause text; since timestamptz;
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
    -- AI-TASKS: a task it could not start for today's budget is looked at again tomorrow (agent_tasks_daily).
    if why = 'budget_spent' then update agent_task_work set note = 'Waiting for tomorrow: today''s AI budget is used up', updated_at = now() - interval '21 hours' where task_id = t.id; end if;
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
  -- AI-TASKS: what woke it (assigned, comment, returned, subtask, direct, daily, continue) and since when things are new.
  cause := case when e.event_type = 'task.assigned' then 'assigned' else coalesce(nullif(split_part(e.event_key, ':', 3), ''), 'look') end;
  insert into agent_task_work(org_id, task_id, agent_id) values (current_org(), t.id, me) on conflict (task_id) do nothing;
  select * into w from agent_task_work where task_id = t.id for update;
  since := (select max(r2.started_at) from agent_run r2 join agent_event e2 on e2.id = r2.event_id where r2.agent_id = me and e2.subject_type = 'task' and e2.subject_id = t.id and r2.id <> rid);
  update task set status = 'in_progress', started_at = coalesce(started_at, now()), updated_at = now() where id = t.id and (status = 'open' or (status = 'blocked' and cause in ('comment','returned','subtask','direct')
      and not exists(select 1 from task_link l where l.org_id = current_org() and l.task_id = t.id and l.cleared_at is null)));
  if cause in ('comment','returned','subtask','direct') and t.status = 'blocked' and not exists(select 1 from task_link l where l.org_id = current_org() and l.task_id = t.id and l.cleared_at is null) then perform task_event_add(t.id, 'status', 'blocked', 'in_progress', 'An answer came in'); end if;
  update agent_task_work set agent_id = me, phase = case when t.status = 'in_review' and cause <> 'returned' then 'in_review' else 'working' end, runs = runs + 1, last_run_id = rid, note = null, updated_at = now() where task_id = t.id;
  select * into t from task where id = t.id;
  cid := agent_task_chat(t.id, me);
  return jsonb_build_object('status', 'dispatched', 'runId', rid, 'reserved', m.run_reserve,
    'deadline', to_char(dl at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'context', jsonb_build_object(
      'instructions', left(m.instructions, 8000), 'sops', to_jsonb(m.sop_links),
      'task', jsonb_build_object('id', t.id, 'title', t.title, 'notes', left(coalesce(t.notes, ''), 6000), 'status', t.status, 'priority', t.priority, 'urgency', t.urgency,
        'dueOn', coalesce(t.work_on, (t.due_at at time zone org_time_zone())::date)::text,
        'project', (select coalesce(pr.title, pr.name) from project pr where pr.id = t.project_id),
        'client', (select cl.display_name from project pr join client cl on cl.id = pr.client_id where pr.id = t.project_id),
        'givenBy', (select display_name from person where id = coalesce(w.given_by, e.invoked_by)), 'givenById', coalesce(w.given_by, e.invoked_by),
        'wokenBy', (select display_name from person where id = e.invoked_by), 'manager', (select display_name from person where id = m.owner_person_id),
        'reviewer', (select display_name from person where id = t.review_owner_id), 'createdBy', (select display_name from person where id = t.created_by),
        'parent', (select jsonb_build_object('id', pt.id, 'title', pt.title, 'status', pt.status) from task pt where pt.id = t.parent_id)),
      -- AI-TASKS
      'v', 2, 'cause', cause, 'since', since,
      'work', jsonb_build_object('plan', w.plan, 'runs', w.runs + 1, 'waitingOn', w.waiting_on, 'continues', case when w.continue_day = (now() at time zone org_time_zone())::date then w.continues else 0 end),
      'thread', (select coalesce(jsonb_agg(x.j order by x.at), '[]'::jsonb) from (
                  select c.created_at at, jsonb_build_object('id', c.id, 'at', to_char(c.created_at at time zone org_time_zone(), 'DD Mon HH24:MI'), 'author', p.display_name,
                    'byAgent', p.side = 'agent', 'mine', c.author_id = me, 'new', since is null or c.created_at > since, 'replyTo', c.parent_id, 'body', left(c.body, 1500)) j
                    from work_comment c join person p on p.id = c.author_id where c.org_id = current_org() and c.task_id = t.id and c.removed_at is null
                   order by c.created_at desc limit 25) x),
      'history', (select coalesce(jsonb_agg(x.j order by x.at), '[]'::jsonb) from (
                  select ev.at, jsonb_build_object('at', to_char(ev.at at time zone org_time_zone(), 'DD Mon HH24:MI'), 'kind', ev.kind, 'from', ev.from_value, 'to', ev.to_value,
                    'note', left(ev.note, 600), 'by', (select display_name from person where id = ev.actor_id), 'new', since is null or ev.at > since) j
                    from task_event ev where ev.org_id = current_org() and ev.task_id = t.id order by ev.at desc limit 15) x),
      'subtasks', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'status', c.status, 'assignee', (select display_name from person where id = c.assignee_person_id),
                    'dueOn', (c.due_at at time zone org_time_zone())::date::text) order by c.created_at), '[]'::jsonb)
                   from task c where c.org_id = current_org() and c.parent_id = t.id and c.deleted_at is null),
      'files', (select coalesce(jsonb_agg(jsonb_build_object('label', a.label, 'kind', a.kind, 'byMe', a.added_by = me) order by a.added_at), '[]'::jsonb)
                  from task_attachment a where a.org_id = current_org() and a.task_id = t.id and a.removed_at is null),
      'asks', (select coalesce(jsonb_agg(jsonb_build_object('to', (select display_name from person where id = k.person_id), 'username', (select username from people_profile where person_id = k.person_id),
                  'via', k.via, 'askedAt', to_char(k.asked_at at time zone org_time_zone(), 'DD Mon HH24:MI'), 'question', left(k.question, 400),
                  'answered', k.answered_at is not null, 'answer', left(k.answer, 1500)) order by k.asked_at), '[]'::jsonb)
                 from (select * from agent_task_ask where org_id = current_org() and task_id = t.id order by asked_at desc limit 8) k),
      -- AI-TASKS: groups it is in that this task is about (the chat it was given in, its project's group, a group the task
      -- names): their latest live messages (never imported history), phone numbers masked, as it reads them in Chats.
      'groups', (select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'withClient', chat_client_facing(g.id), 'messages', (
                    select coalesce(jsonb_agg(z.j order by z.at), '[]'::jsonb) from (
                      select x.created_at at, jsonb_build_object('at', to_char(x.created_at at time zone org_time_zone(), 'DD Mon HH24:MI'), 'author', p.display_name,
                        'side', p.side, 'mine', x.author_id = me, 'body', left(regexp_replace(x.body, '\+?[0-9][0-9 -]{8,}[0-9]', '[phone]', 'g'), 600)) j
                        from chat_message x join person p on p.id = x.author_id
                       where x.channel_id = g.id and x.removed_at is null and x.kind = 'text' order by x.created_at desc limit 40) z))), '[]'::jsonb)
                 from (select ch.id, ch.name from chat_channel ch join chat_member cm on cm.channel_id = ch.id and cm.person_id = me
                        where ch.org_id = current_org() and ch.kind <> 'direct'
                          and (ch.id = cid or exists(select 1 from chat_group_info gi where gi.channel_id = ch.id and t.project_id is not null and gi.project_id = t.project_id)
                               or (length(ch.name) >= 4 and position(lower(ch.name) in lower(t.title || ' ' || coalesce(t.notes, ''))) > 0)
                               -- a part of its name ("Sunrise Builders" in "Sunrise Builders (sim) · Towers launch"; never a pod)
                               or exists(select 1 from unnest((string_to_array(replace(replace(ch.name, ' | ', ' · '), ' - ', ' · '), ' · '))[1:3]) seg(x)
                                          where length(btrim(regexp_replace(lower(seg.x), '\([^)]*\)', '', 'g'))) >= 6 and lower(seg.x) !~ '^\s*pod\M'
                                            and position(btrim(regexp_replace(lower(seg.x), '\([^)]*\)', '', 'g')) in regexp_replace(lower(t.title || ' ' || coalesce(t.notes, '')), '\([^)]*\)', '', 'g')) > 0))
                        order by (ch.id = cid) desc, ch.name limit 2) g),
      'chat', case when cid is null then null else (select jsonb_build_object('channelId', ch.id, 'kind', ch.kind, 'name', case when ch.kind = 'direct' then null else ch.name end) from chat_channel ch where ch.id = cid) end,
      'recent', case when cid is null then '[]'::jsonb else (select coalesce(jsonb_agg(r.j order by r.at), '[]'::jsonb) from (
                  select x.created_at at, jsonb_build_object('author', p.display_name, 'byAgent', p.side = 'agent', 'mine', x.author_id = me, 'body', left(x.body, 600)) j
                    from chat_message x join person p on p.id = x.author_id
                   where x.channel_id = cid and x.removed_at is null and x.kind = 'text' order by x.created_at desc limit 14) r) end,
      'memory', (select coalesce(jsonb_agg(left(x.body, 400) order by x.created_at desc), '[]'::jsonb) from (
                  select body, created_at from agent_memory where agent_id = me and retired_at is null order by created_at desc limit 20) x)));
end $$;

-- 6. What it does in a run on a task, in one step (a retry of the same run returns the same result) ---------------------
-- p: {plan: [{label, done}] | [text], comment, files: [{name, text}], subtasks: [{title, assignee, dueOn, notes}],
--     messages: [{to, text}], post: {channel, text}, status: working | waiting | done, waitingOn, continue: bool}.
create function pulse.agent_task_act(p_run uuid, p jsonb, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; e agent_event; t task; m agent_member; w agent_task_work; x jsonb; i int;
  v_status text := coalesce(nullif(btrim(p->>'status'), ''), 'working'); v_plan jsonb; first_plan boolean := false; body text := btrim(coalesce(p->>'comment', ''));
  v_mentions uuid[] := '{}'; who uuid; who_name text; nid uuid; cid uuid; dm uuid; mid uuid; fid uuid; ch chat_channel; ap uuid; pid uuid; chat uuid;
  reviewer uuid; giver uuid; fname text; ftext text; ttitle text; tdue date; done_n int := 0; files_n int := 0; subs jsonb := '[]'; msgs int := 0; cards int := 0;
  skipped jsonb := '[]'; posted boolean := false; open_children int; waiting text := left(nullif(btrim(coalesce(p->>'waitingOn', '')), ''), 300); res jsonb; k int := 0; me_name text; key uuid;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Send what you did' using errcode='22023'; end if;
  if v_status not in ('working','waiting','done') then raise exception 'Say working, waiting or done' using errcode='22023'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Work inside the run' using errcode='42501'; end if;
  select * into e from agent_event where id = r.event_id;
  if e.subject_type <> 'task' then raise exception 'That run is not about a task' using errcode='22023'; end if;
  select * into t from task where id = e.subject_id and org_id = current_org() for update;
  if t.assignee_person_id is distinct from me or t.deleted_at is not null or t.status in ('done','accepted','cancelled') then
    raise exception 'This task is no longer yours to work on' using errcode='42501'; end if;
  select * into m from agent_member where person_id = me;
  select display_name into me_name from person where id = me;
  insert into agent_task_work(org_id, task_id, agent_id) values (current_org(), t.id, me) on conflict (task_id) do nothing;
  select * into w from agent_task_work where task_id = t.id for update;
  if w.last_act_run = r.id then return w.last_act; end if;

  -- Its plan: up to 12 steps; the first plan is posted on the task.
  if jsonb_typeof(p->'plan') = 'array' and jsonb_array_length(p->'plan') > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('label', s.label, 'done', s.done) order by s.o), '[]'::jsonb) into v_plan from (
      select q.o, left(btrim(regexp_replace(coalesce(q.s->>'label', q.s #>> '{}'), '\s+', ' ', 'g')), 200) label,
             coalesce(case when jsonb_typeof(q.s->'done') = 'boolean' then (q.s->>'done')::boolean end, false) done
        from jsonb_array_elements(p->'plan') with ordinality q(s, o) where q.o <= 12) s where length(s.label) between 1 and 200;
    first_plan := jsonb_array_length(w.plan) = 0 and jsonb_array_length(v_plan) > 0;
    update agent_task_work set plan = v_plan where task_id = t.id;
    select count(*) into done_n from jsonb_array_elements(v_plan) s where (s->>'done')::boolean;
    if first_plan then
      body := 'My plan:' || chr(10) || (select string_agg(o || '. ' || (s->>'label'), chr(10) order by o) from jsonb_array_elements(v_plan) with ordinality q(s, o))
              || case when body <> '' then chr(10) || chr(10) || body else '' end;
    end if;
  end if;

  -- A comment on the task: mentioning colleagues (@username) asks them; they hear it and may see the task.
  if body <> '' then
    body := left(body, 4000);
    select coalesce(array_agg(distinct p2.id), '{}') into v_mentions from regexp_matches(body, '@([A-Za-z0-9._-]+)', 'g') mm
      join people_profile pp on lower(pp.username) = lower(rtrim(mm[1], '.')) and pp.org_id = current_org() join person p2 on p2.id = pp.person_id
     where p2.side = 'staff' and p2.status = 'active' and p2.id <> me;
    v_mentions := v_mentions[1:20];
    insert into work_comment(org_id, task_id, author_id, body, mentions) values (current_org(), t.id, me, body, v_mentions) returning id into cid;
    insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'comment', cid) on conflict do nothing;
    foreach who in array v_mentions loop
      if not work_task_person(t.id, who) then insert into task_member(org_id, task_id, person_id, role, added_by) values (current_org(), t.id, who, 'watcher', me) on conflict do nothing; end if;
      perform work_notify(who, 'task.mention', 'comment', cid, cid::text, work_first_name(me) || ' asked you on “' || left(t.title, 70) || '”: ' || left(regexp_replace(body, '\s+', ' ', 'g'), 70), '/tasks/' || t.id, 'mention');
      insert into agent_task_ask(org_id, task_id, agent_id, person_id, via, question, run_id) values (current_org(), t.id, me, who, 'comment', left(body, 1500), r.id);
    end loop;
    for who in select distinct z.p from (select unnest(array[t.owner_id, t.assignee_person_id, t.review_owner_id, t.created_by]) p
                 union select person_id from task_member where org_id = current_org() and task_id = t.id and removed_at is null) z
                where z.p is not null and z.p <> me and not z.p = any(v_mentions) loop
      perform work_notify(who, 'task.comment', 'comment', cid, cid::text, work_first_name(me) || ' on “' || left(t.title, 70) || '”: ' || left(regexp_replace(body, '\s+', ' ', 'g'), 70), '/tasks/' || t.id, 'task');
    end loop;
  end if;

  -- What it wrote, as files on the task (plain text or Markdown), three a run.
  if jsonb_typeof(p->'files') = 'array' then
    for x in select f from jsonb_array_elements(p->'files') f limit 3 loop
      ftext := coalesce(x->>'text', '');
      fname := left(btrim(regexp_replace(coalesce(nullif(btrim(x->>'name'), ''), 'Draft'), '[^A-Za-z0-9 ._()-]+', '-', 'g')), 120);
      if fname !~* '\.(md|txt|csv)$' then fname := fname || '.md'; end if;
      if length(btrim(ftext)) < 1 or octet_length(convert_to(ftext, 'UTF8')) > 400000 then skipped := skipped || jsonb_build_object('file', fname, 'why', 'empty or over 400 KB'); continue; end if;
      if (select count(*) from task_attachment where org_id = current_org() and task_id = t.id and removed_at is null) >= 20 then skipped := skipped || jsonb_build_object('file', fname, 'why', 'the task has 20 attachments'); exit; end if;
      insert into pulse_priv.work_file(org_id, task_id, name, mime, bytes, sha256, added_by)
      values (current_org(), t.id, fname, case when fname ~* '\.csv$' then 'text/csv' else 'text/plain' end, convert_to(ftext, 'UTF8'), encode(sha256(convert_to(ftext, 'UTF8')), 'hex'), me) returning id into fid;
      insert into task_attachment(org_id, task_id, kind, label, file_id, added_by) values (current_org(), t.id, 'file', left(fname, 200), fid, me);
      files_n := files_n + 1;
    end loop;
  end if;

  -- Sub-tasks for people when it needs a person: under this task, reviewed by this task's reviewer, three a run, ten a task.
  if jsonb_typeof(p->'subtasks') = 'array' then
    for x in select s from jsonb_array_elements(p->'subtasks') s limit 3 loop
      ttitle := left(btrim(regexp_replace(coalesce(x->>'title', ''), '\s+', ' ', 'g')), 300);
      select p2.id, p2.display_name into who, who_name from people_profile pp join person p2 on p2.id = pp.person_id
       where pp.org_id = current_org() and lower(pp.username) = lower(btrim(coalesce(x->>'assignee', ''), ' @')) and p2.side = 'staff' and p2.status = 'active';
      if ttitle = '' or who is null then skipped := skipped || jsonb_build_object('subtask', left(ttitle, 80), 'why', case when ttitle = '' then 'no title' else 'no active colleague by that username' end); continue; end if;
      if (select count(*) from task where org_id = current_org() and parent_id = t.id and created_by = me) >= 10 then skipped := skipped || jsonb_build_object('subtask', left(ttitle, 80), 'why', 'ten sub-tasks already'); exit; end if;
      if exists(select 1 from task where org_id = current_org() and parent_id = t.id and created_by = me and lower(title) = lower(ttitle) and deleted_at is null and status not in ('cancelled')) then
        skipped := skipped || jsonb_build_object('subtask', left(ttitle, 80), 'why', 'already made'); continue; end if;
      tdue := case when coalesce(x->>'dueOn', '') ~ '^\d{4}-\d{2}-\d{2}$' then (x->>'dueOn')::date end;
      insert into task(org_id, title, status, project_id, parent_id, owner_id, assignee_person_id, review_owner_id, due_at, priority, notes, source, created_by, created_at, edited_by, updated_at, assigned_at, locked, urgency)
      values (current_org(), ttitle, 'open', t.project_id, t.id, who, who, coalesce(t.review_owner_id, m.owner_person_id),
              case when tdue is not null then (tdue + time '18:00') at time zone org_time_zone() end, coalesce(t.priority, 'normal'),
              nullif(left(btrim(coalesce(x->>'notes', '')), 4000), ''), 'pulse', me, now(), me, now(), now(), '{title,status,owner_id,project_id,due_label}', coalesce(t.urgency, 'normal'))
      returning id into nid;
      perform task_event_add(nid, 'created', null, ttitle);
      perform task_event_add(nid, 'assigned', null, who_name);
      perform work_notify(who, 'task.assigned', 'task', nid, nid || ':assigned', work_first_name(me) || ' (AI) gave you “' || left(ttitle, 90) || '” for “' || left(t.title, 60) || '”', '/tasks/' || nid, 'task');
      insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'task', nid) on conflict do nothing;
      subs := subs || jsonb_build_object('id', nid, 'title', ttitle, 'assignee', who_name);
    end loop;
  end if;

  -- Direct messages to colleagues about the task (a reminder, a question): their answer comes back to this task.
  if jsonb_typeof(p->'messages') = 'array' then
    for x in select s from jsonb_array_elements(p->'messages') s limit 2 loop
      select p2.id, p2.display_name into who, who_name from people_profile pp join person p2 on p2.id = pp.person_id
       where pp.org_id = current_org() and lower(pp.username) = lower(btrim(coalesce(x->>'to', ''), ' @')) and p2.side = 'staff' and p2.status = 'active' and p2.id <> me;
      ftext := left(btrim(coalesce(x->>'text', '')), 3500);
      if who is null or ftext = '' then skipped := skipped || jsonb_build_object('message', coalesce(x->>'to', ''), 'why', case when who is null then 'no active colleague by that username' else 'empty' end); continue; end if;
      k := k + 1; key := md5(p_client::text || ':dm:' || k)::uuid;
      dm := agent_dm_with(me, who);
      mid := chat_send(dm, ftext || chr(10) || chr(10) || '(About the task “' || left(t.title, 120) || '”. Reply here or on the task.)', null,
        jsonb_build_array(jsonb_build_object('task', t.id::text, 'name', left(t.title, 300), 'url', '/tasks/' || t.id)), key, null);
      insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
      insert into agent_task_ask(org_id, task_id, agent_id, person_id, via, dm_channel_id, question, run_id) values (current_org(), t.id, me, who, 'direct', dm, left(ftext, 1500), r.id);
      perform task_event_add(t.id, 'asked', null, who_name, left(ftext, 200));
      msgs := msgs + 1;
    end loop;
  end if;

  -- A message for one of its conversations: a client conversation (or an operations-access AI) gets a card for its
  -- approver (Send it / Edit / Don't, the existing approval flow); an internal group gets the post.
  if jsonb_typeof(p->'post') = 'object' and length(btrim(coalesce(p->'post'->>'text', ''))) > 0 then
    ftext := left(btrim(p->'post'->>'text'), 4000);
    select * into ch from chat_channel where org_id = current_org() and id::text = btrim(coalesce(p->'post'->>'channel', '')) and kind <> 'direct';
    if ch.id is null or not exists(select 1 from chat_member where channel_id = ch.id and person_id = me) then
      skipped := skipped || jsonb_build_object('post', coalesce(p->'post'->>'channel', ''), 'why', 'not one of its conversations');
    elsif not chat_client_facing(ch.id) and m.access <> 'operations' then
      mid := chat_send(ch.id, ftext, null, jsonb_build_array(jsonb_build_object('task', t.id::text, 'name', left(t.title, 300), 'url', '/tasks/' || t.id)), md5(p_client::text || ':post')::uuid, null);
      insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
      posted := true;
    else
      ap := agent_approver_for(me, ch.id);
      if ap is null then skipped := skipped || jsonb_build_object('post', ch.name, 'why', 'nobody approves its messages');
      else
        dm := agent_dm_with(me, ap);
        insert into agent_proposal(org_id, agent_id, run_id, channel_id, source_message_id, approver_id, dm_channel_id, kind, body, why)
        values (current_org(), me, r.id, ch.id, null, ap, dm, 'reply', ftext, left('For the task “' || left(t.title, 120) || '”. ' || coalesce(p->'post'->>'why', ''), 1000)) returning id into pid;
        mid := chat_send(dm, 'For the task “' || left(t.title, 120) || '”, this is what I would post in “' || ch.name || '”' || case when chat_client_facing(ch.id) then ' (a client conversation)' else '' end
          || ': Send it, Edit, or Don''t.', null, '[]'::jsonb, md5(p_client::text || ':card')::uuid, null);
        update agent_proposal set dm_message_id = mid where id = pid;
        insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
        cards := 1;
      end if;
    end if;
  end if;

  -- Where the task goes: still working, waiting for someone, or done: to its reviewer (always a person).
  if t.status = 'in_review' then v_status := 'in_review';
  elsif v_status = 'done' then
    select count(*) into open_children from task where org_id = current_org() and parent_id = t.id and deleted_at is null and status not in ('done','in_review','accepted','cancelled');
    if open_children > 0 then v_status := 'waiting'; waiting := coalesce(waiting, 'its sub-tasks (' || open_children || ' open)'); end if;
  end if;
  if v_status = 'done' then
    giver := (select p2.id from person p2 where p2.id = coalesce(w.given_by, t.created_by) and p2.side = 'staff' and p2.status = 'active');
    reviewer := coalesce((select id from person where id = t.review_owner_id and side = 'staff' and status = 'active'), giver, m.owner_person_id);
    update task set status = 'in_review', review_owner_id = reviewer, done_at = now(), edited_by = me, updated_at = now() where id = t.id;
    perform task_event_add(t.id, 'status', t.status, 'in_review', 'Sent for review');
    perform task_notify(reviewer, 'task.done', t.id, t.id || ':done:' || now()::text, 'Ready to accept: ' || t.title);
    if giver is not null and giver <> reviewer then perform work_notify(giver, 'task.update', 'task', t.id, 'agent-done:' || r.id, me_name || ' finished “' || left(t.title, 90) || '”', '/tasks/' || t.id, 'task'); end if;
    update agent_task_work set phase = 'in_review', waiting_on = null, submitted_at = now() where task_id = t.id;
  elsif v_status = 'waiting' then
    if t.status in ('open','in_progress') then
      update task set status = 'blocked', edited_by = me, updated_at = now() where id = t.id;
      perform task_event_add(t.id, 'status', t.status, 'blocked', left('Waiting for ' || coalesce(waiting, 'an answer'), 1000));
    end if;
    update agent_task_work set phase = 'waiting', waiting_on = coalesce(waiting, 'an answer') where task_id = t.id;
  elsif v_status = 'working' then
    update agent_task_work set phase = 'working', waiting_on = null where task_id = t.id;
    -- More to do right away and nothing to wait for: another look soon, three a task a day.
    if coalesce((p->>'continue')::boolean, false) then
      update agent_task_work set continues = case when continue_day = (now() at time zone org_time_zone())::date then continues + 1 else 1 end,
             continue_day = (now() at time zone org_time_zone())::date where task_id = t.id and (continue_day is distinct from (now() at time zone org_time_zone())::date or continues < 3)
      returning continues into k;
      if found then
        insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by, retry_at)
        values (current_org(), me, 'task.mention', 'task', t.id, left('task:' || t.id || ':continue:' || r.id, 200), coalesce(e.invoked_by, me), now() + interval '30 seconds') on conflict do nothing;
      end if;
    end if;
  else -- in_review: it answered a comment; the task stays with its reviewer
    update agent_task_work set phase = 'in_review' where task_id = t.id;
  end if;

  -- The chat the task was given in hears the milestones (as CHAT-WORK did), never a client conversation.
  chat := agent_task_chat(t.id, me);
  if chat is not null and v_status in ('done','waiting') and not chat_client_facing(chat) then
    mid := chat_send(chat, coalesce('@' || (select username from people_profile where person_id = coalesce(w.given_by, e.invoked_by)) || ' ', '')
      || case when v_status = 'done' then 'Done, for ' || coalesce((select display_name from person where id = (select review_owner_id from task where id = t.id)), 'my reviewer') || '''s review: '
              else 'I am waiting for ' || coalesce(waiting, 'an answer') || ': ' end || left(regexp_replace(coalesce(nullif(btrim(p->>'comment'), ''), t.title), '\s+', ' ', 'g'), 400), null,
      jsonb_build_array(jsonb_build_object('task', t.id::text, 'name', left(t.title, 300), 'url', '/tasks/' || t.id)), md5(p_client::text || ':chat')::uuid, null);
    insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  end if;

  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'task', t.id) on conflict do nothing;
  res := jsonb_build_object('status', (select status from task where id = t.id), 'phase', (select phase from agent_task_work where task_id = t.id), 'commentId', cid,
    'files', files_n, 'subtasks', subs, 'messages', msgs, 'cards', cards, 'posted', posted, 'skipped', skipped);
  update agent_task_work set last_act_run = r.id, last_act = res, updated_at = now() where task_id = t.id;
  return res;
end $$;

-- Its short notes on a task inside a run ("can't do this right now …", retries): on the task's thread, and in the chat
-- it was given in as before. AI-TASKS: the comment on the task is new (a task made on the Work page has no chat).
create or replace function pulse.agent_task_report(p_run uuid, p_state text, p_body text, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; e agent_event; t task; m agent_member; cid uuid; mid uuid; b text := btrim(coalesce(p_body, '')); uname text; com uuid;
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
  if cid is not null and not chat_client_facing(cid) then
    select username into uname from people_profile where person_id = e.invoked_by;
    mid := chat_send(cid, case when p_state in ('done','question','blocked') and uname is not null then '@' || uname || ' ' else '' end || b, null,
      jsonb_build_array(jsonb_build_object('task', t.id::text, 'name', left(t.title, 300), 'url', '/tasks/' || t.id)), p_client, null);
    insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  end if;
  -- AI-TASKS: the same words on the task's thread, once per run and kind of note.
  if not exists(select 1 from agent_output o join work_comment c on c.id = o.subject_id where o.run_id = r.id and o.subject_type = 'comment' and c.body = b) then
    insert into work_comment(org_id, task_id, author_id, body) values (current_org(), t.id, me, b) returning id into com;
    insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'comment', com) on conflict do nothing;
  end if;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'task', t.id) on conflict do nothing;
  if p_state = 'done' and t.status in ('open','in_progress','blocked') and not exists(select 1 from task c where c.parent_id = t.id and c.deleted_at is null and c.status not in ('done','in_review','accepted','cancelled')) then
    -- AI-TASKS: always a person's review.
    update task set status = 'in_review', review_owner_id = coalesce((select id from person where id = review_owner_id and side = 'staff' and status = 'active'), m.owner_person_id),
           done_at = now(), edited_by = me, updated_at = now() where id = t.id;
    update agent_task_work set phase = 'in_review', submitted_at = now(), updated_at = now() where task_id = t.id;
  elsif p_state = 'blocked' and t.status in ('open','in_progress') then
    update task set status = 'blocked', edited_by = me, updated_at = now() where id = t.id;
  end if;
  perform work_notify(m.owner_person_id, 'task.update', 'task', t.id, 'agent-report:' || r.id,
    (select display_name from person where id = me) || case p_state when 'done' then ' finished “' when 'blocked' then ' is blocked on “' when 'question' then ' has a question on “' else ' gave an update on “' end
      || left(t.title, 90) || '”', '/tasks/' || t.id, 'task');
  return jsonb_build_object('messageId', mid, 'chatId', cid, 'commentId', com, 'status', (select status from task where id = t.id));
end $$;

-- 7. What people see -------------------------------------------------------------------------------------------------
-- On a task given to an AI employee: whether it is working, its plan, whom it waits for, its runs and what they cost.
create function pulse.agent_task_status(p_task uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare t task; w agent_task_work; m agent_member;
begin
  select * into t from task where id = p_task and org_id = current_org();
  if t.id is null or t.assignee_person_id is null or not task_visible(p_task) then return null; end if;
  select * into m from agent_member where person_id = t.assignee_person_id and org_id = current_org();
  if m.person_id is null then return null; end if;
  select * into w from agent_task_work where task_id = p_task;
  return jsonb_build_object('agentId', m.person_id, 'name', (select display_name from person where id = m.person_id), 'title', m.title,
    'phase', case when exists(select 1 from agent_event where agent_id = m.person_id and subject_type = 'task' and subject_id = p_task and state in ('leased','dispatching')) then 'working'
                  when t.status in ('done','accepted','cancelled') then 'stopped' else coalesce(w.phase, 'queued') end,
    'running', exists(select 1 from agent_event where agent_id = m.person_id and subject_type = 'task' and subject_id = p_task and state = 'dispatching'),
    'queued', exists(select 1 from agent_event where agent_id = m.person_id and subject_type = 'task' and subject_id = p_task and state in ('queued','leased')),
    'plan', coalesce(w.plan, '[]'::jsonb), 'waitingOn', w.waiting_on, 'note', w.note, 'updatedAt', w.updated_at, 'submittedAt', w.submitted_at,
    'off', m.disabled_at is not null or 'tasks' <> all(m.tools), 'runtime', jsonb_build_object('state', m.runtime_state, 'until', m.runtime_until),
    'runs', (select count(*) from agent_run r join agent_event e on e.id = r.event_id where e.subject_type = 'task' and e.subject_id = p_task and r.agent_id = m.person_id),
    'tokens', (select coalesce(sum(r.tokens), 0) from agent_run r join agent_event e on e.id = r.event_id where e.subject_type = 'task' and e.subject_id = p_task and r.agent_id = m.person_id),
    'lastRun', (select jsonb_build_object('at', r.started_at, 'state', r.state, 'model', r.model, 'tokens', r.tokens, 'seconds', r.seconds, 'errorCode', r.error_code)
                  from agent_run r join agent_event e on e.id = r.event_id where e.subject_type = 'task' and e.subject_id = p_task and r.agent_id = m.person_id order by r.started_at desc limit 1),
    'asks', (select coalesce(jsonb_agg(jsonb_build_object('to', (select display_name from person where id = k.person_id), 'via', k.via, 'at', k.asked_at, 'answered', k.answered_at is not null) order by k.asked_at desc), '[]'::jsonb)
               from (select * from agent_task_ask where task_id = p_task order by asked_at desc limit 5) k));
end $$;

-- Its queue: open tasks the viewer may see, in the order it works them (priority, then due date).
create function pulse.agent_task_queue(p_agent uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
  if pulse.agent_profile(p_agent) is null then return null; end if;
  return (select coalesce(jsonb_agg(x.j order by x.o), '[]'::jsonb) from (
    select row_number() over (order by case t.status when 'in_review' then 1 else 0 end, case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.due_at nulls last, t.created_at) o,
      jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'statusLabel', chat_task_label(t.status), 'priority', t.priority,
        'dueOn', (t.due_at at time zone org_time_zone())::date::text, 'phase', coalesce(w.phase, 'queued'), 'waitingOn', w.waiting_on,
        'running', exists(select 1 from agent_event e where e.agent_id = p_agent and e.subject_type = 'task' and e.subject_id = t.id and e.state = 'dispatching'),
        'givenBy', (select display_name from person where id = t.created_by), 'reviewer', (select display_name from person where id = t.review_owner_id),
        'steps', jsonb_array_length(coalesce(w.plan, '[]')), 'stepsDone', (select count(*) from jsonb_array_elements(coalesce(w.plan, '[]')) s where (s->>'done')::boolean)) j
      from task t left join agent_task_work w on w.task_id = t.id
     where t.org_id = current_org() and t.assignee_person_id = p_agent and t.deleted_at is null and t.status in ('open','in_progress','blocked','in_review')
       and t.id in (select task_visible_ids()) limit 60) x);
end $$;

-- Throughput and cost per AI employee over the last days: given, sent for review, accepted, returned, open, hours to
-- review, runs and tokens on tasks. Admins and leaders see every AI employee; a manager sees theirs.
create function pulse.agent_task_throughput(p_days int) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare d int := greatest(1, least(coalesce(p_days, 14), 90)); since timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 14), 90)));
begin
  if current_viewer() is null or agent_session() is not null then raise exception 'Sign in to see this' using errcode='42501'; end if;
  return jsonb_build_object('days', d, 'agents', (select coalesce(jsonb_agg(x.j order by x.n), '[]'::jsonb) from (
    select p.display_name n, jsonb_build_object('id', m.person_id, 'name', p.display_name, 'title', m.title, 'manager', (select display_name from person where id = m.owner_person_id),
      'given', (select count(*) from task t where t.assignee_person_id = m.person_id and t.deleted_at is null and coalesce(t.assigned_at, t.created_at) >= since),
      'submitted', (select count(*) from agent_task_work w where w.agent_id = m.person_id and w.submitted_at >= since),
      'accepted', (select count(*) from task t where t.assignee_person_id = m.person_id and t.status = 'accepted' and t.accepted_at >= since),
      'returned', (select count(*) from task_event ev join task t on t.id = ev.task_id where t.assignee_person_id = m.person_id and ev.kind = 'returned' and ev.at >= since),
      'open', (select count(*) from task t where t.assignee_person_id = m.person_id and t.deleted_at is null and t.status in ('open','in_progress','blocked')),
      'waiting', (select count(*) from task t where t.assignee_person_id = m.person_id and t.deleted_at is null and t.status = 'blocked'),
      'inReview', (select count(*) from task t where t.assignee_person_id = m.person_id and t.deleted_at is null and t.status = 'in_review'),
      'hoursToReview', (select round((percentile_cont(0.5) within group (order by extract(epoch from w.submitted_at - w.started_at) / 3600))::numeric, 1)
                          from agent_task_work w where w.agent_id = m.person_id and w.submitted_at >= since),
      'subtasks', (select count(*) from task t where t.created_by = m.person_id and t.parent_id is not null and t.created_at >= since),
      'runs', (select count(*) from agent_run r join agent_event e on e.id = r.event_id where r.agent_id = m.person_id and e.subject_type = 'task' and r.started_at >= since),
      'tokens', (select coalesce(sum(r.tokens), 0) from agent_run r join agent_event e on e.id = r.event_id where r.agent_id = m.person_id and e.subject_type = 'task' and r.started_at >= since),
      'failedRuns', (select count(*) from agent_run r join agent_event e on e.id = r.event_id where r.agent_id = m.person_id and e.subject_type = 'task' and r.started_at >= since and r.state <> 'done'),
      'allTokens', (select coalesce(sum(r.tokens), 0) from agent_run r where r.agent_id = m.person_id and r.started_at >= since),
      'perDay', (select coalesce(jsonb_agg(jsonb_build_object('day', z.day, 'tokens', z.tok, 'runs', z.n) order by z.day), '[]'::jsonb) from (
                   select (r.started_at at time zone org_time_zone())::date::text as day, coalesce(sum(r.tokens), 0) as tok, count(*) as n
                     from agent_run r join agent_event e on e.id = r.event_id where r.agent_id = m.person_id and e.subject_type = 'task' and r.started_at >= since group by 1) z)) j
      from agent_member m join person p on p.id = m.person_id
     where m.org_id = current_org() and p.side = 'agent' and (viewer_is('admin','leadership') or m.owner_person_id = current_viewer())) x));
end $$;

revoke all on function pulse.agent_task_wake(uuid,text,text,uuid), pulse.agent_task_wake_comment(), pulse.agent_task_wake_returned(), pulse.agent_task_wake_child(),
  pulse.agent_task_dm_answer(), pulse.agent_task_given(), pulse.agent_tasks_daily(), pulse.agent_task_act(uuid,jsonb,uuid), pulse.agent_task_status(uuid),
  pulse.agent_task_queue(uuid), pulse.agent_task_throughput(int) from public;
grant execute on function pulse.agent_tasks_daily(), pulse.agent_task_act(uuid,jsonb,uuid), pulse.agent_task_status(uuid), pulse.agent_task_queue(uuid),
  pulse.agent_task_throughput(int) to pulse_api;

-- migrate:down
-- Forward-only: what an AI employee did on a task (its plan, asks, comments, files, sub-tasks) stays auditable.
