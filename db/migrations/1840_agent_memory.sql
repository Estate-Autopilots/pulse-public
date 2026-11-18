-- migrate:up
-- AGENT-MEMORY (8 Nov 2026). Bugs seen live in the 7 Nov demo with AI employees, fixed with typed rules (no model guess):
--  1. "Can you remember that?" made a task. The runtime now reads remember / note / "keep in mind" / "from now on" before
--     any model call (services/coworker/intent.mjs) and saves a note here (agent_remember), about a person or a topic,
--     says "Saved to my notes about …" and can undo it ("undo" within 30 minutes, or the Knowledge tab).
--  2. "I have noted that every quotation …" was not kept. A standing instruction ("always …", "never …", "every quotation
--     should …") from the AI employee's owner, approver, an admin or leadership becomes a behaviour rule (agent_rule) with
--     who set it and when; every later run is given its rules, and a quotation rule that names what to include is
--     written into the terms of every quotation draft it makes (agent_rule_quote: a trigger, so every path obeys it).
--     From anyone else it is kept as a note about that person, and the reply says who can make it a rule.
--  3. Out of budget it went silent. agent_budget_state says where its budgets stand (today, this month, the company's),
--     agent_budget_reply answers the person in words when a message waits on budget ("I've used this month's budget.
--     <Owner> can add more here: <link>") and tells the owner once, agent_budget_notify warns at 80%, and
--     agent_budget_add is the admins' one-click "Add budget" (the held messages are then answered).
--  4. Activity: pulse.activity_chats lists group, pod and team conversation activity, as the viewer (chat row security
--     keeps it to their own conversations).
--  5. Final approver per action type: agent_member.final_approvers {message, task, quotation, budget}; unset, the
--     message and task approver is its approver (else its owner), and quotations and budget go to its owner.
--  6. One assistant identity per role with notes per person: agent_memory.about_person_id ("How Bevit works"); those notes
--     are given only to runs with that person (agent_notes_for), never to every conversation.
-- New tables have forced row security with the tenant policy. Additive; the dispatch functions change only in their notes
-- query (per-person notes left out).

-- 1. Notes per person and topic ----------------------------------------------------------------------------------------
alter table pulse.agent_memory add column about_person_id uuid references pulse.person(id);
alter table pulse.agent_memory add column topic text check (topic is null or length(btrim(topic)) between 1 and 80);
alter table pulse.agent_memory add column said_by uuid references pulse.person(id);
alter table pulse.agent_memory add column channel_id uuid;
alter table pulse.agent_memory add column message_id uuid;
alter table pulse.agent_memory add column edited_at timestamptz;
alter table pulse.agent_memory add column edited_by uuid references pulse.person(id);
alter table pulse.agent_memory drop constraint agent_memory_source_check;
alter table pulse.agent_memory add constraint agent_memory_source_check check (source in ('manager', 'agent', 'chat'));
create index agent_memory_about on pulse.agent_memory (org_id, agent_id, about_person_id) where retired_at is null and about_person_id is not null;

-- The general notes every run gets leave out notes about one person (agent_notes_for gives those to runs with them).
do $$
declare f record; d text; c text; n int := 0;
begin
  for f in select p.oid from pg_proc p join pg_namespace s on s.oid = p.pronamespace
            where s.nspname = 'pulse' and p.prosrc like '%from agent_memory where agent_id = me and retired_at is null order by%' loop
    d := pg_get_functiondef(f.oid);
    c := replace(d, 'from agent_memory where agent_id = me and retired_at is null order by',
                    'from agent_memory where agent_id = me and retired_at is null and about_person_id is null order by');
    if c <> d then execute c; n := n + 1; end if;
  end loop;
  if n = 0 then raise exception 'no dispatch function reads agent_memory as expected (AGENT-MEMORY)'; end if;
end $$;

-- 2. Behaviour rules ---------------------------------------------------------------------------------------------------
-- Who gives the final approval per kind of action (section 3); rule setters include them.
alter table pulse.agent_member add column final_approvers jsonb not null default '{}'::jsonb
  check (jsonb_typeof(final_approvers) = 'object' and final_approvers - array['message', 'task', 'quotation', 'budget'] = '{}'::jsonb);
create table pulse.agent_rule (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references pulse.agent_member(person_id),
  body text not null check (length(btrim(body)) between 3 and 600),
  scope text not null default 'all' check (scope in ('all', 'quotation', 'invoice', 'task', 'chat')),
  -- What every quotation must carry (from "every quotation should mention …"); null: a rule for the model only.
  include_text text check (include_text is null or length(btrim(include_text)) between 2 and 300),
  set_by uuid not null references pulse.person(id),
  set_at timestamptz not null default now(),
  source text not null check (source in ('chat', 'profile')),
  channel_id uuid, message_id uuid, run_id uuid references pulse.agent_run(id),
  edited_at timestamptz, edited_by uuid references pulse.person(id),
  retired_at timestamptz, retired_by uuid references pulse.person(id)
);
create index agent_rule_live on pulse.agent_rule (org_id, agent_id, set_at) where retired_at is null;
alter table pulse.agent_rule enable row level security;
alter table pulse.agent_rule force row level security;
create policy tenant on pulse.agent_rule using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.agent_rule to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.agent_rule for each row execute function pulse.audit_mutation();

-- What a rule is about and what a quotation must then include, read from its words (typed, no model).
create function pulse.agent_rule_parse(p_body text) returns jsonb language plpgsql immutable set search_path = pulse, pg_temp as $$
declare b text := btrim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g')); m text[]; inc text;
begin
  m := regexp_match(b, '\m(?:every|each|all|any)\s+(?:quotations?|quotes?)\s+(?:should|must|shall|will|has to|have to|needs? to)\s+(?:always\s+)?(?:include|mention|state|show|say|carry|contain|have|add|list)\s*(?:that\s+|this:?\s*|:\s*)?(.+)$', 'i');
  if m is null then
    m := regexp_match(b, '\malways\s+(?:include|mention|state|show|add|put|write)\s+(.+?)\s+(?:in|on|into)\s+(?:every|each|all|any|the|our)?\s*(?:quotations?|quotes?)\M', 'i');
  end if;
  if m is not null then
    inc := btrim(regexp_replace(m[1], '[\s.!;,]+$', ''));
    inc := btrim(regexp_replace(inc, '^["“'']+|["”'']+$', '', 'g'));
    if length(inc) between 2 and 300 then inc := upper(left(inc, 1)) || substr(inc, 2); else inc := null; end if;
  end if;
  return jsonb_build_object('scope', case
      when b ~* '\m(quotations?|quotes?|estimates?)\M' then 'quotation'
      when b ~* '\m(invoices?|bills?)\M' then 'invoice'
      when b ~* '\mtasks?\M' then 'task'
      when b ~* '\m(chats?|messages?|replies|reply|groups?)\M' then 'chat'
      else 'all' end,
    'include', inc);
end $$;

-- Who may set a rule for this AI employee: its owner, its approver (any kind), an admin or leadership.
create function pulse.agent_rule_setter_ok(p_agent uuid, p_person uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select p_person is not null and exists (select 1 from person p where p.id = p_person and p.org_id = current_org() and p.side = 'staff' and p.status = 'active')
   and (exists (select 1 from agent_member m where m.person_id = p_agent and m.org_id = current_org()
                 and (p_person in (m.owner_person_id, m.approver_person_id)
                      or exists (select 1 from jsonb_each_text(m.final_approvers) a where a.value = p_person::text)))
        or exists (select 1 from role_assignment r where r.person_id = p_person and r.role_key in ('admin', 'leadership')
                    and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')))
$$;

-- 3. Final approver per action type (the column is added with the rules above) ---------------------------------------

-- Who gives the final approval for this AI employee's kind of action. message: the group's own approver first (0987),
-- then the one chosen for messages, its approver, its owner. task: the one chosen for tasks, the group's, its approver,
-- its owner. quotation and budget: the one chosen, else its owner. Only active staff count.
create function pulse.agent_final_approver(p_agent uuid, p_action text, p_channel uuid) returns uuid
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare m agent_member; pick uuid; grp uuid;
begin
  select * into m from agent_member where person_id = p_agent;
  if not found then return null; end if;
  select p.id into pick from person p where p.id = nullif(m.final_approvers ->> p_action, '')::uuid and p.status = 'active' and p.side = 'staff';
  if p_channel is not null then
    select p.id into grp from person p where p.id = nullif(m.group_approvers ->> p_channel::text, '')::uuid and p.status = 'active' and p.side = 'staff'
      and exists (select 1 from chat_member cm where cm.channel_id = p_channel and cm.person_id = p.id);
  end if;
  return case p_action
    when 'message' then coalesce(grp, pick, m.approver_person_id, m.owner_person_id)
    when 'task' then coalesce(pick, grp, m.approver_person_id, m.owner_person_id)
    else coalesce(pick, m.owner_person_id, m.approver_person_id) end;
end $$;

-- 0987's choice of whom to ask about a message is now the final approver for messages.
create or replace function pulse.agent_approver_for(p_agent uuid, p_channel uuid) returns uuid
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select agent_final_approver(p_agent, 'message', p_channel)
$$;

-- Task proposals and budget asks go to their own final approver.
do $$
declare d text; c text;
begin
  d := pg_get_functiondef('pulse.agent_propose_task(uuid,jsonb,text,uuid)'::regprocedure);
  c := replace(d, 'agent_approver_for(me, ', 'agent_final_approver(me, ''task'', ');
  if c = d then raise exception 'agent_propose_task changed shape (AGENT-MEMORY)'; end if;
  execute c;
  d := pg_get_functiondef('pulse.agent_budget_ask(uuid,jsonb,uuid)'::regprocedure);
  c := replace(d, 'ap := coalesce(m.owner_person_id, m.approver_person_id);', 'ap := agent_final_approver(me, ''budget'', null);');
  if c = d then raise exception 'agent_budget_ask changed shape (AGENT-MEMORY)'; end if;
  execute c;
end $$;

-- Set (or clear, with no person) who gives the final approval for one kind of action; whoever may change it (0952).
create function pulse.agent_final_approver_set(p_agent uuid, p_action text, p_person uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not agent_manage_ok(p_agent) then raise exception 'Not found' using errcode = 'P0002'; end if;
  if p_action not in ('message', 'task', 'quotation', 'budget') then raise exception 'Choose messages, tasks, quotations or budget' using errcode = '22023'; end if;
  if p_person is not null and not exists (select 1 from person where id = p_person and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Choose an active colleague' using errcode = '22023'; end if;
  update agent_member set final_approvers = case when p_person is null then final_approvers - p_action
    else final_approvers || jsonb_build_object(p_action, p_person) end where person_id = p_agent and org_id = current_org();
  perform audit_write('update', 'agent_member', p_agent::text);
  return agent_final_approvers(p_agent);
end $$;

-- Who approves each kind of action now, and whether it is the default.
create function pulse.agent_final_approvers(p_agent uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare m agent_member;
begin
  select * into m from agent_member where person_id = p_agent and org_id = current_org();
  if not found or (agent_session() is distinct from p_agent and not exists (select 1 from person where id = current_viewer() and org_id = current_org() and side = 'staff' and status = 'active')) then
    raise exception 'Not found' using errcode = 'P0002'; end if;
  return (select jsonb_agg(jsonb_build_object('action', a, 'personId', agent_final_approver(p_agent, a, null),
      'name', (select display_name from person where id = agent_final_approver(p_agent, a, null)),
      'chosen', m.final_approvers ? a,
      'usual', case when a in ('message', 'task') then (select display_name from person where id = coalesce(m.approver_person_id, m.owner_person_id))
                    else (select display_name from person where id = coalesce(m.owner_person_id, m.approver_person_id)) end) order by o)
    from unnest(array['message', 'task', 'quotation', 'budget']) with ordinality x(a, o));
end $$;

-- 4. Remember, inside a run ----------------------------------------------------------------------------------------------
-- The message the run answers and who wrote it (never the model's word).
create function pulse.agent_run_message(p_run uuid) returns pulse.chat_message language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); e agent_event; msg chat_message;
begin
  select ev.* into e from agent_run r join agent_event ev on ev.id = r.event_id
   where r.id = p_run and r.org_id = current_org() and r.agent_id = me and r.state = 'dispatching';
  if not found then raise exception 'Do this inside the run' using errcode = '42501'; end if;
  if e.subject_type = 'message' then select * into msg from chat_message where id = e.subject_id; end if;
  return msg;
end $$;

-- p: {kind: note | rule, body, aboutSelf | aboutUsername | aboutPersonId, topic}. Who asked is the run's message's author. A rule from someone who may
-- not set rules is kept as a note about them (downgraded). Returns what was kept, about whom, and until when undo works.
create function pulse.agent_remember(p_run uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); msg chat_message; kind text := coalesce(nullif(p->>'kind', ''), 'note');
  b text := btrim(regexp_replace(coalesce(p->>'body', ''), '\s+', ' ', 'g')); about uuid; v_topic text := nullif(left(btrim(coalesce(p->>'topic', '')), 80), '');
  nid uuid; parsed jsonb; down boolean := false; who person;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  if kind not in ('note', 'rule') then raise exception 'Keep a note or a rule' using errcode = '22023'; end if;
  if length(b) < 3 then raise exception 'Say what to remember' using errcode = '22023'; end if;
  msg := agent_run_message(p_run);
  if msg.id is null then raise exception 'Only a chat message is remembered this way' using errcode = '22023'; end if;
  select * into who from person where id = msg.author_id and org_id = current_org();
  if who.side is distinct from 'staff' or who.status <> 'active' then raise exception 'Only colleagues ask me to remember things' using errcode = '42501'; end if;
  if (select count(*) from agent_memory where agent_id = me and run_id = p_run) + (select count(*) from agent_rule where agent_id = me and run_id = p_run) >= 5 then
    raise exception 'Five notes a run at most' using errcode = '22023'; end if;
  -- About whom: the person who wrote (aboutSelf), a colleague by username, or by id.
  if p->>'aboutSelf' = 'true' then about := who.id;
  elsif nullif(p->>'aboutUsername', '') is not null then
    select p2.id into about from person p2 join people_profile pp on pp.person_id = p2.id
     where lower(pp.username) = lower(ltrim(p->>'aboutUsername', '@')) and p2.org_id = current_org() and p2.side in ('staff', 'agent') and p2.status = 'active';
  elsif nullif(p->>'aboutPersonId', '') ~ '^[0-9a-f-]{36}$' then
    select id into about from person where id = (p->>'aboutPersonId')::uuid and org_id = current_org() and side in ('staff', 'agent') and status = 'active';
  end if;
  if kind = 'rule' and not agent_rule_setter_ok(me, who.id) then kind := 'note'; down := true; about := who.id; end if;
  if kind = 'rule' then
    parsed := agent_rule_parse(b);
    insert into agent_rule(org_id, agent_id, body, scope, include_text, set_by, source, channel_id, message_id, run_id)
    values (current_org(), me, left(b, 600), parsed->>'scope', parsed->>'include', who.id, 'chat', msg.channel_id, msg.id, p_run) returning id into nid;
    return jsonb_build_object('kind', 'rule', 'id', nid, 'scope', parsed->>'scope', 'include', parsed->>'include', 'setBy', who.display_name,
      'undoUntil', now() + interval '30 minutes');
  end if;
  insert into agent_memory(org_id, agent_id, body, source, run_id, created_by, about_person_id, topic, said_by, channel_id, message_id)
  values (current_org(), me, left(b, 1000), 'chat', p_run, who.id, about, case when about is null then v_topic end, who.id, msg.channel_id, msg.id) returning id into nid;
  return jsonb_build_object('kind', 'note', 'id', nid, 'about', case when about is not null then jsonb_build_object('id', about, 'name', (select display_name from person where id = about)) end,
    'topic', case when about is null then v_topic end, 'downgraded', down,
    'canSetRules', case when down then (select display_name from person where id = (select owner_person_id from agent_member where person_id = me)) end,
    'undoUntil', now() + interval '30 minutes');
end $$;

-- "Undo": the newest note or rule this person asked it to keep in this conversation in the last 30 minutes is removed.
create function pulse.agent_remember_undo(p_run uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); msg chat_message; n agent_memory; r agent_rule;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  msg := agent_run_message(p_run);
  if msg.id is null then raise exception 'Only a chat message is undone this way' using errcode = '22023'; end if;
  select * into n from agent_memory where agent_id = me and org_id = current_org() and source = 'chat' and said_by = msg.author_id and channel_id = msg.channel_id
     and retired_at is null and created_at > now() - interval '30 minutes' order by created_at desc limit 1;
  select * into r from agent_rule where agent_id = me and org_id = current_org() and source = 'chat' and set_by = msg.author_id and channel_id = msg.channel_id
     and retired_at is null and set_at > now() - interval '30 minutes' order by set_at desc limit 1;
  if r.id is not null and (n.id is null or r.set_at >= n.created_at) then
    update agent_rule set retired_at = now(), retired_by = msg.author_id where id = r.id;
    return jsonb_build_object('undone', true, 'kind', 'rule', 'body', r.body);
  elsif n.id is not null then
    update agent_memory set retired_at = now(), retired_by = msg.author_id where id = n.id;
    return jsonb_build_object('undone', true, 'kind', 'note', 'body', n.body);
  end if;
  return jsonb_build_object('undone', false);
end $$;

-- For its prompt: its rules (every run) and its notes about the person it works with now.
create function pulse.agent_notes_for(p_person uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'rules', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'body', r.body, 'scope', r.scope, 'include', r.include_text, 'setBy', p.display_name,
        'setOn', to_char(r.set_at at time zone org_time_zone(), 'FMDD Mon')) order by r.set_at)
      from agent_rule r join person p on p.id = r.set_by where r.agent_id = me and r.org_id = current_org() and r.retired_at is null), '[]'::jsonb),
    'person', (select display_name from person where id = p_person and org_id = current_org()),
    'about', coalesce((select jsonb_agg(x.body order by x.created_at desc) from (select body, created_at from agent_memory
      where agent_id = me and org_id = current_org() and about_person_id = p_person and retired_at is null order by created_at desc limit 20) x), '[]'::jsonb));
end $$;

-- 5. The Knowledge tab: its rules and its notes by person and topic, editable by whoever manages it -------------------------
create function pulse.agent_knowledge(p_agent uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or not exists (select 1 from agent_member where person_id = p_agent and org_id = current_org())
     or not exists (select 1 from person where id = current_viewer() and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'canEdit', agent_manage_ok(p_agent), 'canRule', agent_rule_setter_ok(p_agent, current_viewer()),
    'rules', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'body', r.body, 'scope', r.scope, 'include', r.include_text, 'source', r.source,
        'setBy', p.display_name, 'setAt', r.set_at, 'editedAt', r.edited_at) order by r.set_at desc)
      from agent_rule r join person p on p.id = r.set_by where r.agent_id = p_agent and r.org_id = current_org() and r.retired_at is null), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'body', a.body, 'source', a.source, 'at', a.created_at, 'by', p.display_name,
        'aboutId', a.about_person_id, 'about', ab.display_name, 'topic', a.topic, 'taskId', a.task_id, 'editedAt', a.edited_at) order by a.created_at desc)
      from agent_memory a join person p on p.id = a.created_by left join person ab on ab.id = a.about_person_id
      where a.agent_id = p_agent and a.org_id = current_org() and a.retired_at is null), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by p.display_name)
      from person p where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'), '[]'::jsonb));
end $$;

-- Add or edit a note (p: {id, body, aboutPersonId, topic}); whoever may change the AI employee (0952).
create function pulse.agent_note_save(p_agent uuid, p jsonb) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b text := btrim(coalesce(p->>'body', '')); about uuid; v_topic text := nullif(left(btrim(coalesce(p->>'topic', '')), 80), ''); nid uuid;
begin
  if not agent_manage_ok(p_agent) then raise exception 'Not found' using errcode = 'P0002'; end if;
  if length(b) not between 1 and 1000 then raise exception 'Write the note in up to 1,000 characters' using errcode = '22023'; end if;
  if nullif(p->>'aboutPersonId', '') is not null then
    select id into about from person where id = (p->>'aboutPersonId')::uuid and org_id = current_org() and side in ('staff', 'agent');
    if about is null then raise exception 'Choose a colleague' using errcode = '22023'; end if;
  end if;
  if nullif(p->>'id', '') is not null then
    update agent_memory set body = b, about_person_id = about, topic = case when about is null then v_topic end, edited_at = now(), edited_by = current_viewer()
     where id = (p->>'id')::uuid and agent_id = p_agent and org_id = current_org() and retired_at is null returning id into nid;
    if nid is null then raise exception 'Not found' using errcode = 'P0002'; end if;
    return nid;
  end if;
  insert into agent_memory(org_id, agent_id, body, source, created_by, about_person_id, topic)
  values (current_org(), p_agent, b, 'manager', current_viewer(), about, case when about is null then v_topic end) returning id into nid;
  return nid;
end $$;

-- Add or edit a rule (p: {id, body}); its owner, approvers, admins and leadership.
create function pulse.agent_rule_save(p_agent uuid, p jsonb) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b text := btrim(regexp_replace(coalesce(p->>'body', ''), '\s+', ' ', 'g')); parsed jsonb; nid uuid;
begin
  if agent_session() is not null or not exists (select 1 from agent_member where person_id = p_agent and org_id = current_org()) then
    raise exception 'Not found' using errcode = 'P0002'; end if;
  if not agent_rule_setter_ok(p_agent, current_viewer()) then
    raise exception 'Its owner, its approvers, admins and leadership set its rules' using errcode = '42501'; end if;
  if length(b) not between 3 and 600 then raise exception 'Write the rule in 3 to 600 characters' using errcode = '22023'; end if;
  parsed := agent_rule_parse(b);
  if nullif(p->>'id', '') is not null then
    update agent_rule set body = b, scope = parsed->>'scope', include_text = parsed->>'include', edited_at = now(), edited_by = current_viewer()
     where id = (p->>'id')::uuid and agent_id = p_agent and org_id = current_org() and retired_at is null returning id into nid;
    if nid is null then raise exception 'Not found' using errcode = 'P0002'; end if;
    return nid;
  end if;
  insert into agent_rule(org_id, agent_id, body, scope, include_text, set_by, source)
  values (current_org(), p_agent, b, parsed->>'scope', parsed->>'include', current_viewer(), 'profile') returning id into nid;
  return nid;
end $$;

create function pulse.agent_rule_retire(p_id uuid) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a uuid;
begin
  select agent_id into a from agent_rule where id = p_id and org_id = current_org() and retired_at is null;
  if a is null or agent_session() is not null or not agent_rule_setter_ok(a, current_viewer()) then raise exception 'Not found' using errcode = 'P0002'; end if;
  update agent_rule set retired_at = now(), retired_by = current_viewer() where id = p_id;
end $$;

-- 6. A quotation rule is obeyed on every quotation draft the AI employee makes or changes ---------------------------------
-- "Every quotation should mention 50% advance with the order" puts "50% advance with the order" in the draft's terms when
-- neither its terms nor its notes say it already. Only for drafts written by the AI employee itself (a person's own
-- quotation is theirs to word).
create function pulse.agent_rule_quote() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); x record; have text;
begin
  if me is null or not exists (select 1 from agent_member where person_id = me and org_id = new.org_id) then return new; end if;
  for x in select include_text from agent_rule where org_id = new.org_id and agent_id = me and retired_at is null and scope = 'quotation' and include_text is not null order by set_at loop
    have := lower(coalesce(new.terms, '') || ' ' || coalesce(new.notes, ''));
    if position(lower(x.include_text) in have) = 0 then
      new.terms := left(concat_ws(chr(10), nullif(btrim(coalesce(new.terms, '')), ''), x.include_text), 3000);
    end if;
  end loop;
  return new;
end $$;
create trigger agent_rule_quote before insert or update on pulse.erp_document for each row
  when (new.doc_type = 'quotation' and new.status = 'draft') execute function pulse.agent_rule_quote();

-- 7. Budget: where it stands, a clear answer when it is out, a warning at 80%, one-click more --------------------------------
create table pulse.agent_budget_notice (
  org_id uuid not null references pulse.org(id),
  agent_id uuid not null references pulse.agent_member(person_id),
  period text not null check (length(period) <= 80),     -- 'month:2026-11', 'day:2026-11-08', 'event:<id>'
  level text not null check (level in ('warn', 'out')),
  at timestamptz not null default now(),
  primary key (agent_id, period, level)
);
alter table pulse.agent_budget_notice enable row level security;
alter table pulse.agent_budget_notice force row level security;
create policy tenant on pulse.agent_budget_notice using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- {day, month, org: {used, limit, share}, level ok|warn|out, period day|month|org|plan, key, owner, canAdd}. The AI employee
-- itself, or any active colleague (the meter is shown in chat too); canAdd: admins and leadership.
create function pulse.agent_budget_state(p_agent uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare m agent_member; tz text := org_time_zone(); d_used bigint; m_used bigint; cap bigint; o_used bigint; o_cap bigint; blocked boolean;
  sd numeric; sm numeric; so numeric; top numeric; per text; lvl text; own uuid;
begin
  select * into m from agent_member where person_id = p_agent and org_id = current_org();
  if not found or (agent_session() is distinct from p_agent and (agent_session() is not null
     or not exists (select 1 from person where id = current_viewer() and org_id = current_org() and side = 'staff' and status = 'active'))) then
    raise exception 'Not found' using errcode = 'P0002'; end if;
  select coalesce(sum(case when r.state in ('done', 'error') then coalesce(r.tokens, r.reserved) else r.reserved end), 0) into d_used from agent_run r
   where r.org_id = current_org() and r.agent_id = p_agent and (r.started_at at time zone tz)::date = (now() at time zone tz)::date;
  m_used := agent_month_tokens(p_agent);
  select monthly_tokens into cap from pulse_priv.ai_employee_cap where org_id = current_org() and person_id = p_agent;
  select daily_tokens into o_cap from agent_org_ai where org_id = current_org();
  if o_cap is not null then
    select coalesce(sum(case when r.state in ('done', 'error') then coalesce(r.tokens, r.reserved) else r.reserved end), 0) into o_used from agent_run r
     where r.org_id = current_org() and (r.started_at at time zone tz)::date = (now() at time zone tz)::date;
  end if;
  blocked := coalesce(org_ai_blocked(), false);
  sd := case when m.daily_token_budget > 0 then d_used::numeric / m.daily_token_budget else 1 end;
  sm := case when cap > 0 then m_used::numeric / cap else 0 end;
  so := case when o_cap > 0 then o_used::numeric / o_cap else 0 end;
  per := case when blocked then 'plan' when sm >= 1 then 'month' when so >= 1 then 'org' when sd >= 1 then 'day'
              when sm >= greatest(sd, so) and cap is not null then 'month' when so >= sd and o_cap is not null then 'org' else 'day' end;
  top := case when blocked then 1 else greatest(sd, sm, so) end;
  lvl := case when top >= 1 then 'out' when top >= 0.8 then 'warn' else 'ok' end;
  own := agent_final_approver(p_agent, 'budget', null);
  return jsonb_build_object(
    'day', jsonb_build_object('used', d_used, 'limit', m.daily_token_budget, 'share', round(sd * 100)),
    'month', case when cap is not null then jsonb_build_object('used', m_used, 'limit', cap, 'share', round(sm * 100)) else jsonb_build_object('used', m_used, 'limit', null, 'share', null) end,
    'org', case when o_cap is not null then jsonb_build_object('used', o_used, 'limit', o_cap, 'share', round(so * 100)) end,
    'level', lvl, 'period', per, 'share', round(top * 100),
    'key', case when per = 'month' then 'month:' || to_char(now() at time zone tz, 'YYYY-MM') else per || ':' || to_char(now() at time zone tz, 'YYYY-MM-DD') end,
    'owner', jsonb_build_object('id', own, 'name', (select display_name from person where id = own)),
    'canAdd', agent_session() is null and viewer_is('admin', 'leadership'));
end $$;

-- Tells a person in a direct message from the AI employee (made if missing), as the AI employee.
create function pulse.agent_tell(p_to uuid, p_body text, p_client uuid) returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); k text; dm uuid;
begin
  if me is null or p_to is null then return null; end if;
  k := 'dm:' || least(me::text, p_to::text) || ':' || greatest(me::text, p_to::text);
  insert into chat_channel(org_id, key, name, kind, description) values (current_org(), k, 'Direct message', 'direct', 'A private conversation')
  on conflict (org_id, key) do update set key = excluded.key returning id into dm;
  insert into chat_member(org_id, channel_id, person_id) values (current_org(), dm, me), (current_org(), dm, p_to) on conflict do nothing;
  return chat_send(dm, left(p_body, 4000), null, '[]'::jsonb, p_client, null);
end $$;

-- Once per period and level: tells its budget approver and its owner (p_text, worded by the API with the link). True
-- when this call told them.
create function pulse.agent_budget_notify(p_level text, p_key text, p_text text) returns boolean language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); m agent_member; ap uuid; n int;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  if p_level not in ('warn', 'out') or p_key !~ '^(month|day|org|plan):[0-9-]{7,10}$' then raise exception 'Not a budget period' using errcode = '22023'; end if;
  insert into agent_budget_notice(org_id, agent_id, period, level) values (current_org(), me, p_key, p_level) on conflict do nothing;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  select * into m from agent_member where person_id = me;
  ap := agent_final_approver(me, 'budget', null);
  perform agent_tell(ap, p_text, md5('budget:' || me || ':' || p_key || ':' || p_level || ':' || ap)::uuid);
  if m.owner_person_id is distinct from ap then perform agent_tell(m.owner_person_id, p_text, md5('budget:' || me || ':' || p_key || ':' || p_level || ':' || m.owner_person_id)::uuid); end if;
  return true;
end $$;

-- A message waits on budget: the person hears it in words in that conversation (once per message; never in a
-- conversation with a client, where its approver hears instead). p_lease: a claimed event (the runtime knows the budget is
-- out before it dispatches); null: an event dispatch just refused for budget. When the budget is not out after all, a
-- claimed event goes back to the queue.
create function pulse.agent_budget_reply(p_event uuid, p_lease uuid, p_text text) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); e agent_event; msg chat_message; mid uuid; n int;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  select * into e from agent_event where id = p_event and org_id = current_org() and agent_id = me for update;
  if not found then raise exception 'Not found' using errcode = 'P0002'; end if;
  if p_lease is not null then
    if e.state <> 'leased' or e.lease_token is distinct from p_lease then raise exception 'That lease has ended' using errcode = '42501'; end if;
    if agent_budget_state(me)->>'level' <> 'out' then
      update agent_event set state = 'queued', lease_token = null, lease_until = null, retry_at = null where id = e.id;
      return jsonb_build_object('status', 'not_out');
    end if;
    update agent_event set state = 'failed', finished_at = now(), lease_token = null, lease_until = null, reason = 'budget_spent' where id = e.id;
  elsif e.state <> 'failed' or e.reason is distinct from 'budget_spent' or e.finished_at < now() - interval '15 minutes' then
    raise exception 'That message is not waiting on budget' using errcode = '22023';
  end if;
  insert into agent_budget_notice(org_id, agent_id, period, level) values (current_org(), me, 'event:' || e.id, 'out') on conflict do nothing;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('status', 'already'); end if;
  if e.subject_type = 'message' then select * into msg from chat_message where id = e.subject_id; end if;
  if msg.id is not null and not chat_client_facing(msg.channel_id) then
    mid := chat_send(msg.channel_id, left(p_text, 4000), msg.parent_id, '[]'::jsonb, md5('budget-reply:' || e.id)::uuid, null);
  end if;
  return jsonb_build_object('status', 'told', 'messageId', mid);
end $$;

-- "Add budget", one click for admins and leadership: this month's cap grows by half (at least 100,000 tokens) when the
-- month is what ran out or nears it, else today's limit grows by half (at least 50,000; 2,000,000 at most). The messages
-- held for budget in the last day are answered now.
create function pulse.agent_budget_add(p_agent uuid, p_scope text) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s jsonb; scope text := coalesce(nullif(p_scope, ''), 'auto'); cap bigint; m agent_member; added bigint;
begin
  if agent_session() is not null or not viewer_is('admin', 'leadership') then raise exception 'Admins and leadership add budget' using errcode = '42501'; end if;
  select * into m from agent_member where person_id = p_agent and org_id = current_org() for update;
  if not found then raise exception 'Not found' using errcode = 'P0002'; end if;
  s := agent_budget_state(p_agent);
  select monthly_tokens into cap from pulse_priv.ai_employee_cap where org_id = current_org() and person_id = p_agent;
  if scope = 'auto' then scope := case when cap is not null and coalesce((s->'month'->>'share')::numeric, 0) >= 80 then 'month' else 'day' end; end if;
  if scope not in ('month', 'day') then raise exception 'Add to this month or today' using errcode = '22023'; end if;
  if scope = 'month' then
    if cap is null then raise exception 'It has no monthly cap; add to today instead' using errcode = '22023'; end if;
    added := greatest(cap / 2, 100000);
    update pulse_priv.ai_employee_cap set monthly_tokens = least(100000000000, monthly_tokens + added), set_by = current_viewer(), set_at = now() where person_id = p_agent;
    perform app_change_add('ai_employee.cap', p_agent, jsonb_build_object('monthlyTokens', cap + added));
  else
    if m.daily_token_budget >= 2000000 then raise exception 'Today''s limit is already the highest (2,000,000 tokens)' using errcode = '22023'; end if;
    added := least(2000000 - m.daily_token_budget, greatest(m.daily_token_budget / 2, 50000));
    update agent_member set daily_token_budget = daily_token_budget + added::int where person_id = p_agent;
  end if;
  update agent_member set runtime_state = 'ready', runtime_until = null where person_id = p_agent and runtime_state = 'out_of_quota';
  update agent_event set state = 'queued', retry_at = now(), reason = null, attempts = 0, finished_at = null
   where org_id = current_org() and agent_id = p_agent and state = 'failed' and reason = 'budget_spent' and finished_at > now() - interval '1 day';
  perform audit_write('update', 'agent_member', p_agent::text);
  return jsonb_build_object('scope', scope, 'added', added, 'budget', agent_budget_state(p_agent));
end $$;

-- 8. Activity: group, pod and team conversations ----------------------------------------------------------------------------
-- Newest first, as the viewer: chat row security (member_read) keeps it to their own conversations; direct messages are
-- never listed. p_kind: all, group, pod or team.
create function pulse.activity_chats(p_kind text, p_limit int, p_offset int) returns jsonb language sql stable security invoker set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(x order by x->>'at' desc), '[]'::jsonb) from (
    select jsonb_build_object('id', msg.id, 'at', msg.created_at, 'channelId', ch.id, 'channel', ch.name, 'kind', ch.kind,
      'authorId', msg.author_id, 'author', p.display_name, 'byAi', p.side = 'agent', 'client', p.side not in ('staff', 'agent'),
      'text', left(regexp_replace(msg.body, '\s+', ' ', 'g'), 220), 'reply', msg.parent_id is not null,
      'files', jsonb_array_length(coalesce(msg.attachments, '[]'::jsonb))) x
    from chat_message msg join chat_channel ch on ch.id = msg.channel_id join person p on p.id = msg.author_id
    where ch.kind <> 'direct' and (coalesce(p_kind, 'all') = 'all' or ch.kind = p_kind)
      and chat_has(ch.id)
    order by msg.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 100) offset greatest(coalesce(p_offset, 0), 0)) y
$$;

revoke all on function pulse.agent_rule_parse(text), pulse.agent_rule_setter_ok(uuid, uuid), pulse.agent_final_approver(uuid, text, uuid),
  pulse.agent_final_approver_set(uuid, text, uuid), pulse.agent_final_approvers(uuid), pulse.agent_run_message(uuid), pulse.agent_remember(uuid, jsonb),
  pulse.agent_remember_undo(uuid), pulse.agent_notes_for(uuid), pulse.agent_knowledge(uuid), pulse.agent_note_save(uuid, jsonb),
  pulse.agent_rule_save(uuid, jsonb), pulse.agent_rule_retire(uuid), pulse.agent_rule_quote(), pulse.agent_budget_state(uuid),
  pulse.agent_tell(uuid, text, uuid), pulse.agent_budget_notify(text, text, text), pulse.agent_budget_reply(uuid, uuid, text),
  pulse.agent_budget_add(uuid, text), pulse.activity_chats(text, int, int) from public;
grant execute on function pulse.agent_rule_parse(text), pulse.agent_final_approver(uuid, text, uuid), pulse.agent_final_approver_set(uuid, text, uuid),
  pulse.agent_final_approvers(uuid), pulse.agent_remember(uuid, jsonb), pulse.agent_remember_undo(uuid), pulse.agent_notes_for(uuid),
  pulse.agent_knowledge(uuid), pulse.agent_note_save(uuid, jsonb), pulse.agent_rule_save(uuid, jsonb), pulse.agent_rule_retire(uuid),
  pulse.agent_budget_state(uuid), pulse.agent_budget_notify(text, text, text), pulse.agent_budget_reply(uuid, uuid, text),
  pulse.agent_budget_add(uuid, text), pulse.activity_chats(text, int, int) to pulse_api;

-- migrate:down
-- Forward only: notes and rules people set stay auditable (retire them instead); the final approvers fall back to the
-- approver and owner when the column is cleared.
