-- migrate:up
-- CHAT-WORK part 1 (owner, 22 Oct 2026: "all things can be done via chat"). A task given in a chat is answered there by
-- the person it went to: take it, decline it (with a reason; it goes back to whoever gave it) or ask a question (a real
-- message in the chat, quoting the task's card and @mentioning whoever gave it). Each answer is a line in the chat with
-- the task's live card, and whoever gave it is told. A step of a live Flow run that is finished, sent for review or
-- blocked says so in its project's pod group, with its task's card. Additive: tasks, asks and chats keep their rules.

create table pulse.chat_task_handshake (
  org_id uuid not null references pulse.org(id),
  task_id uuid not null references pulse.task(id),
  channel_id uuid not null references pulse.chat_channel(id),
  person_id uuid not null references pulse.person(id),      -- who answers
  asked_by uuid not null references pulse.person(id),       -- who gave it
  message_id uuid,                                          -- the card in the chat (a question quotes it)
  state text not null default 'waiting' check (state in ('waiting','accepted','declined','question')),
  note text check (length(note) <= 500),
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  primary key (task_id, channel_id, person_id)
);
create index chat_task_handshake_person on pulse.chat_task_handshake (org_id, person_id) where state in ('waiting','question');
alter table pulse.chat_task_handshake enable row level security;
alter table pulse.chat_task_handshake force row level security;
create policy tenant_isolation on pulse.chat_task_handshake using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy member_read on pulse.chat_task_handshake as restrictive for select to pulse_api using (pulse.chat_has(channel_id));
grant select on pulse.chat_task_handshake to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.chat_task_handshake for each row execute function pulse.audit_mutation();

-- Whoever gave a task in a chat asks the person it went to for an answer there. Only when that person is in the chat
-- (otherwise they answer in Tasks as before) and is a person (an AI employee's status shows on the card instead).
create function pulse.chat_task_handshake_open(p_task uuid, p_channel uuid, p_message uuid, p_person uuid) returns void
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer();
begin
  if me is null or not exists(select 1 from chat_member where org_id = current_org() and channel_id = p_channel and person_id = me) then
    raise exception 'conversation unavailable' using errcode='42501'; end if;
  if p_person is null or p_person = me then return; end if;
  if not exists(select 1 from task where org_id = current_org() and id = p_task and me in (created_by, owner_id)) then
    raise exception 'Only whoever gave the task asks for an answer' using errcode='42501'; end if;
  if not exists(select 1 from chat_member cm join person p on p.id = cm.person_id
                 where cm.org_id = current_org() and cm.channel_id = p_channel and cm.person_id = p_person and p.side = 'staff' and p.status = 'active') then return; end if;
  if p_message is not null and not exists(select 1 from chat_message where id = p_message and channel_id = p_channel) then
    raise exception 'That card is not in this chat' using errcode='22023'; end if;
  insert into chat_task_handshake(org_id, task_id, channel_id, person_id, asked_by, message_id)
  values (current_org(), p_task, p_channel, p_person, me, p_message) on conflict do nothing;
end $$;

-- The answer. Take it: a pending request to take it is accepted (consent, as in Tasks), otherwise it is already theirs.
-- Decline: the request is declined, or the task goes back to whoever gave it. Ask: the question is posted as the
-- person's own message (mentions, notifications and edits as any message) and the answer stays open. A given yes or no
-- is final; the same answer again changes nothing.
create function pulse.chat_task_respond(p_task uuid, p_channel uuid, p_answer text, p_note text) returns jsonb
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := task_require_viewer(); h chat_task_handshake; t task; ask uuid; v_note text := nullif(btrim(coalesce(p_note, '')), '');
        card jsonb; mid uuid; uname text; what text;
begin
  if p_answer is null or p_answer not in ('accept','decline','ask') then raise exception 'Take it, decline it or ask a question' using errcode='22023'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'Keep it to 500 characters' using errcode='22023'; end if;
  if not exists(select 1 from chat_member where org_id = current_org() and channel_id = p_channel and person_id = me) then
    raise exception 'conversation unavailable' using errcode='42501'; end if;
  select * into h from chat_task_handshake where org_id = current_org() and task_id = p_task and channel_id = p_channel and person_id = me for update;
  if not found then raise exception 'This task is not waiting for your answer here' using errcode='42501'; end if;
  select * into t from task where org_id = current_org() and id = p_task;
  if not found or t.deleted_at is not null then raise exception 'That task is gone' using errcode='22023'; end if;
  if h.state in ('accepted','declined') then
    if h.state = (case p_answer when 'accept' then 'accepted' when 'decline' then 'declined' end) then return jsonb_build_object('state', h.state); end if;
    raise exception 'You already % it', (case h.state when 'accepted' then 'took' else 'declined' end) using errcode='22023';
  end if;
  card := jsonb_build_array(jsonb_build_object('task', t.id::text, 'name', left(t.title, 300), 'url', '/tasks/' || t.id));
  what := '“' || left(t.title, 200) || '”';
  select id into ask from work_ask where org_id = current_org() and task_id = p_task and to_id = me and kind = 'take' and status = 'pending' order by created_at desc limit 1;
  if p_answer = 'ask' then
    if v_note is null then raise exception 'Write your question' using errcode='22023'; end if;
    select username into uname from people_profile where org_id = current_org() and person_id = h.asked_by;
    mid := chat_send(p_channel, case when uname is not null and h.asked_by <> me then '@' || uname || ' ' else '' end || v_note, null, '[]'::jsonb, gen_random_uuid(),
                     case when exists(select 1 from chat_message where id = h.message_id and channel_id = p_channel and removed_at is null) then h.message_id end);
    update chat_task_handshake set state = 'question', note = v_note, answered_at = now()
     where org_id = current_org() and task_id = h.task_id and channel_id = h.channel_id and person_id = me;
    return jsonb_build_object('state', 'question', 'messageId', mid);
  end if;
  if p_answer = 'accept' then
    if ask is not null then perform work_ask_answer(ask, true, v_note);
    elsif coalesce(t.assignee_person_id, t.owner_id) is distinct from me then raise exception 'This task is no longer yours to take' using errcode='22023'; end if;
    update chat_task_handshake set state = 'accepted', note = v_note, answered_at = now()
     where org_id = current_org() and task_id = h.task_id and channel_id = h.channel_id and person_id = me;
    perform chat_event_line(p_channel, me, 'took ' || what || coalesce(': ' || v_note, ''), card);
    if ask is null then
      perform work_notify(h.asked_by, 'task.accepted', 'task', t.id, 'chat-take:' || t.id || ':' || me, work_first_name(me) || ' took ' || left(what, 100), '/tasks/' || t.id, 'task');
    end if;
    return jsonb_build_object('state', 'accepted');
  end if;
  if ask is not null then perform work_ask_answer(ask, false, v_note);
  elsif coalesce(t.assignee_person_id, t.owner_id) = me and h.asked_by <> me then
    update task set assignee_person_id = h.asked_by, owner_id = h.asked_by, assigned_at = now(), edited_by = me, updated_at = now() where id = t.id;
    perform task_event_add(t.id, 'assigned', (select display_name from person where id = me), (select display_name from person where id = h.asked_by), 'Declined in Chats');
  end if;
  update chat_task_handshake set state = 'declined', note = v_note, answered_at = now()
   where org_id = current_org() and task_id = h.task_id and channel_id = h.channel_id and person_id = me;
  perform chat_event_line(p_channel, me, 'declined ' || what || coalesce(': ' || v_note, ''), card);
  if ask is null then
    perform work_notify(h.asked_by, 'task.update', 'task', t.id, 'chat-decline:' || t.id || ':' || me,
      work_first_name(me) || ' declined ' || left(what, 90) || coalesce(' · ' || left(v_note, 60), ''), '/tasks/' || t.id, 'task');
  end if;
  return jsonb_build_object('state', 'declined');
end $$;

-- Flow steps surface in their group: a live run's step that is finished, sent for review or blocked writes one line in
-- the pod group of the run's project, as the person who moved it (only when they are in that group; nobody else speaks
-- for them), with the step's task card when it has one.
create function pulse.chat_flow_step_line() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r flow_run; cid uuid; me uuid := current_viewer(); line text;
begin
  if me is null then return null; end if;
  line := case
    when new.state is distinct from old.state and new.state = 'done' then 'finished'
    when new.state is distinct from old.state and new.state = 'in_review' then 'sent for review'
    when new.blocked_at is not null and old.blocked_at is null then 'is blocked on' end;
  if line is null then return null; end if;
  select * into r from flow_run where id = new.run_id;
  if r.mode <> 'live' or r.project_id is null then return null; end if;
  select ch.id into cid from work_project wp join unit u on u.kind = 'pod' and u.valid_to is null and u.name = wp.pod and u.org_id = wp.org_id
    join chat_channel ch on ch.org_id = wp.org_id and ch.key = 'pod:' || u.id
   where wp.org_id = new.org_id and wp.project_id = r.project_id limit 1;
  if cid is null or not exists(select 1 from chat_member where channel_id = cid and person_id = me) then return null; end if;
  perform chat_event_line(cid, me, line || ' “' || left(new.title, 120) || '” in ' || left(r.name, 120),
    case when new.task_id is not null then jsonb_build_array(jsonb_build_object('task', new.task_id::text, 'name', left(new.title, 300), 'url', '/tasks/' || new.task_id)) else '[]'::jsonb end);
  return null;
end $$;
create trigger chat_flow_step_line after update of state, blocked_at on pulse.flow_run_step for each row execute function pulse.chat_flow_step_line();

revoke all on function pulse.chat_task_handshake_open(uuid,uuid,uuid,uuid), pulse.chat_task_respond(uuid,uuid,text,text), pulse.chat_flow_step_line() from public;
grant execute on function pulse.chat_task_handshake_open(uuid,uuid,uuid,uuid), pulse.chat_task_respond(uuid,uuid,text,text) to pulse_api;

-- migrate:down
-- Forward-only: answers given in chats stay with their tasks.
