-- migrate:up
-- AI-EMPLOYEES v2 (owner, 23 Oct 2026). An AI employee is a person on the same profile as everyone; being AI adds one
-- "AI" section: its model and thinking, tools, what it does on its own and what it asks a person first, who approves,
-- its instructions and SOP links, limits and status. In a conversation it is a member of, it sees what is said. For each
-- kind of message (a direct message, being @mentioned or replied to, anything else said in its groups) it is set to
-- act on its own, to ask first, or to stay out. Asking first: it does not post in the group; it sends the person who
-- approves for it (its approver, or who it reports to) a direct message with what it would post and why, with Send it /
-- Edit / Don't (or a reply such as "fine, send it"). Sent, it posts in the group as itself; every proposal keeps who
-- decided, how and when. It can be a project's coordinator or co-coordinator like a person. Additive: an AI employee
-- added before this keeps acting as it did (leaders only, on its own, nothing unasked).

alter table pulse.agent_member
  add column listens_to text not null default 'leaders' check (listens_to in ('leaders','everyone')),
  add column autonomy jsonb not null default '{"direct":"own","mention":"own","group":"off"}'::jsonb
    check (jsonb_typeof(autonomy) = 'object' and autonomy ?& array['direct','mention','group']),
  add column approver_person_id uuid references pulse.person(id),
  add column instructions text not null default '' check (length(instructions) <= 8000),
  add column sop_links text[] not null default '{}' check (cardinality(sop_links) <= 20),
  add column mcp_servers text[] not null default '{}' check (cardinality(mcp_servers) <= 20);

alter table pulse.agent_member drop constraint agent_member_provider_check;
alter table pulse.agent_member add constraint agent_member_provider_check check (provider in ('codex','claude','stub','anthropic_api','openai_api'));
alter table pulse.agent_member drop constraint agent_member_tools_check;
alter table pulse.agent_member add constraint agent_member_tools_check check (tools <@ array['chats','tasks','memory','board','drive','web','server','mcp','projects']::text[]);
alter table pulse.agent_event drop constraint agent_event_event_type_check;
alter table pulse.agent_event add constraint agent_event_event_type_check check (event_type in ('chat.message','chat.mention','chat.reply','chat.group','task.mention','task.assigned'));
alter table pulse.project_member drop constraint project_member_role_check;
alter table pulse.project_member add constraint project_member_role_check check (role in ('member','watcher','coordinator','co_coordinator'));

-- What it would post, waiting for its approver: where, in answer to what, what and why; then who decided, how and when.
create table pulse.agent_proposal (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references pulse.agent_member(person_id),
  run_id uuid references pulse.agent_run(id),
  channel_id uuid not null references pulse.chat_channel(id),
  source_message_id uuid,
  approver_id uuid not null references pulse.person(id),
  dm_channel_id uuid not null references pulse.chat_channel(id),
  dm_message_id uuid,
  kind text not null default 'reply' check (kind in ('reply','task','summary')),
  body text not null check (length(btrim(body)) between 1 and 4000),
  why text check (length(why) <= 1000),
  state text not null default 'pending' check (state in ('pending','sent','dismissed','expired')),
  sent_body text check (length(sent_body) <= 4000),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  decided_via text check (decided_via in ('button','reply')),
  decision_message_id uuid,
  posted_message_id uuid,
  created_at timestamptz not null default now()
);
create unique index agent_proposal_run on pulse.agent_proposal (run_id) where run_id is not null;
create index agent_proposal_dm on pulse.agent_proposal (org_id, dm_channel_id, created_at desc) where state = 'pending';
create index agent_proposal_agent on pulse.agent_proposal (org_id, agent_id, created_at desc);
create index agent_proposal_dm_message on pulse.agent_proposal (dm_message_id);
create index agent_proposal_posted on pulse.agent_proposal (posted_message_id);
alter table pulse.agent_proposal enable row level security;
alter table pulse.agent_proposal force row level security;
create policy tenant on pulse.agent_proposal using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.agent_proposal to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.agent_proposal for each row execute function pulse.audit_mutation();

-- Who changes an AI employee: admins, HR and leadership, or the person it reports to. Never an AI session.
create or replace function pulse.agent_manage_ok(p_agent uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
  select agent_session() is null and current_viewer() is not null and exists(select 1 from agent_member m where m.org_id = current_org() and m.person_id = p_agent
    and (viewer_is('admin','hr','leadership') or m.owner_person_id = current_viewer()))
$$;

-- How it acts on one kind of message: 'own', 'approve' or 'off'.
create function pulse.agent_mode_for(m pulse.agent_member, p_event_type text) returns text language sql stable set search_path=pulse,pg_temp as $$
  select coalesce(nullif(m.autonomy->>(case p_event_type when 'chat.message' then 'direct' when 'chat.group' then 'group' else 'mention' end), ''), 'off')
$$;

-- Its v2 settings, by whoever may change it (agent_manage_ok). Only the keys given change; every value is checked.
create function pulse.agent_ai_save(p_agent uuid, p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k text; v text; a uuid; l text;
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
      if l !~ '^(https?://[^[:space:]]{3,1000}|/[^[:space:]]{1,500})$' then raise exception 'An SOP link is a web address or a Pulse page' using errcode='22023'; end if;
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

-- A project's coordinator or co-coordinator, a person or an AI employee, set by a leader (null role: back to member).
create function pulse.project_coordinator_set(p_project uuid, p_person uuid, p_role text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if agent_session() is not null or not agent_leader(current_viewer()) then raise exception 'Leaders choose a project''s coordinators' using errcode='42501'; end if;
  if p_role is not null and p_role not in ('coordinator','co_coordinator') then raise exception 'Choose coordinator or co-coordinator' using errcode='22023'; end if;
  if not exists(select 1 from project where id = p_project and org_id = current_org()) then raise exception 'Choose a project' using errcode='22023'; end if;
  if not exists(select 1 from person where id = p_person and org_id = current_org() and status = 'active' and side in ('staff','agent')) then
    raise exception 'Choose an active person or AI employee' using errcode='22023'; end if;
  update project_member set role = coalesce(p_role, 'member') where org_id = current_org() and project_id = p_project and person_id = p_person and left_at is null;
  if not found and p_role is not null then
    insert into project_member(org_id, project_id, person_id, role, added_by) values (current_org(), p_project, p_person, p_role, current_viewer());
  end if;
end $$;

-- Its proposal, inside a run on a message: the run's conversation, never posted there; a direct message to its
-- approver (its approver, or who it reports to) with the context, and the proposal on that message's card.
create function pulse.agent_propose(p_run uuid, p_body text, p_why text, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
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
  ap := coalesce(m.approver_person_id, m.owner_person_id);
  if ap is null then raise exception 'It has nobody to ask' using errcode='22023'; end if;
  k := 'dm:' || least(me::text, ap::text) || ':' || greatest(me::text, ap::text);
  insert into chat_channel(org_id, key, name, kind, description) values (current_org(), k, 'Direct message', 'direct', 'A private conversation')
  on conflict (org_id, key) do update set key = excluded.key returning id into dm;
  insert into chat_member(org_id, channel_id, person_id) values (current_org(), dm, me), (current_org(), dm, ap) on conflict do nothing;
  insert into agent_proposal(org_id, agent_id, run_id, channel_id, source_message_id, approver_id, dm_channel_id, kind, body, why)
  values (current_org(), me, r.id, msg.channel_id, msg.id, ap, dm, 'reply', b, w) returning id into pid;
  select display_name into who from person where id = msg.author_id;
  mid := chat_send(dm, who || ' wrote in ' || case when ch.kind = 'direct' then 'a direct message' else '“' || ch.name || '”' end || ': “'
      || left(regexp_replace(msg.body, '\s+', ' ', 'g'), 280) || case when length(msg.body) > 280 then '…' else '' end
      || '”. I have not answered. Here is what I would post there; Send it, Edit or Don''t (or just reply “fine, send it”).', null, '[]'::jsonb, p_client, null);
  update agent_proposal set dm_message_id = mid where id = pid;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  return jsonb_build_object('id', pid, 'messageId', mid, 'chatId', dm);
end $$;

-- Its approver decides (or anyone who may change it): send (as written, or edited) or don't. Sent, it is posted in the
-- group as the AI employee, quoting what it answers. Deciding twice changes nothing.
create function pulse.agent_proposal_decide(p_id uuid, p_action text, p_body text, p_via text default 'button') returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pr agent_proposal; me uuid := current_viewer(); b text; posted uuid; src chat_message; was text;
begin
  if agent_session() is not null or me is null then raise exception 'A person decides' using errcode='42501'; end if;
  select * into pr from agent_proposal where id = p_id and org_id = current_org() for update;
  if not found or (pr.approver_id <> me and not agent_manage_ok(pr.agent_id)) then raise exception 'Not found' using errcode='P0002'; end if;
  if p_action is null or p_action not in ('send','dismiss') then raise exception 'Send it or don''t' using errcode='22023'; end if;
  if pr.state <> 'pending' then
    return jsonb_build_object('state', pr.state, 'postedMessageId', pr.posted_message_id, 'channelId', pr.channel_id);
  end if;
  if p_action = 'dismiss' then
    update agent_proposal set state = 'dismissed', decided_by = me, decided_at = now(), decided_via = coalesce(p_via, 'button') where id = pr.id;
    return jsonb_build_object('state', 'dismissed', 'channelId', pr.channel_id);
  end if;
  b := btrim(coalesce(nullif(btrim(coalesce(p_body, '')), ''), pr.body));
  if length(b) > 4000 then raise exception 'Up to 4,000 characters' using errcode='22023'; end if;
  if not exists(select 1 from chat_member where channel_id = pr.channel_id and person_id = pr.agent_id)
     or not exists(select 1 from agent_member am join person p on p.id = am.person_id where am.person_id = pr.agent_id and am.disabled_at is null and p.status = 'active') then
    raise exception 'It is no longer in that conversation or is switched off' using errcode='22023'; end if;
  select * into src from chat_message where id = pr.source_message_id and removed_at is null;
  -- Posted as the AI employee (its session for this one message), then back to the person who decided.
  was := coalesce(current_setting('pulse.agent_session', true), '');
  perform set_config('pulse.viewer_id', pr.agent_id::text, true);
  perform set_config('pulse.agent_session', 'on', true);
  posted := chat_send(pr.channel_id, b, src.parent_id, '[]'::jsonb, pr.id, src.id);
  perform set_config('pulse.agent_session', was, true);
  perform set_config('pulse.viewer_id', me::text, true);
  update agent_proposal set state = 'sent', sent_body = b, decided_by = me, decided_at = now(), decided_via = coalesce(p_via, 'button'), posted_message_id = posted where id = pr.id;
  return jsonb_build_object('state', 'sent', 'postedMessageId', posted, 'channelId', pr.channel_id);
end $$;

-- "fine, send it" / "don't" from its approver in their direct message settles the latest waiting proposal there.
create function pulse.agent_proposal_from_reply(p_msg uuid) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x chat_message; pr agent_proposal; verdict text;
begin
  select * into x from chat_message where id = p_msg;
  if x.id is null or x.kind <> 'text' then return false; end if;
  select * into pr from agent_proposal where org_id = current_org() and dm_channel_id = x.channel_id and approver_id = x.author_id and state = 'pending'
     and (x.quote_id is null or x.quote_id = dm_message_id) order by created_at desc limit 1;
  if not found then return false; end if;
  verdict := case
    when x.body ~* '^\W*(no|nope|don''?t|do not|skip|leave it|not now|ignore)\M' then 'dismiss'
    when x.body ~* '^\W*(ok|okay|fine|yes|yep|yeah|sure|go|go ahead|approved?|lgtm|send|post|looks good|perfect|great)\M'
         and x.body !~* '\m(don''?t|do not|wait|hold|change|edit|but)\M' then 'send' end;
  if verdict is null then return false; end if;
  update agent_proposal set decision_message_id = x.id where id = pr.id;
  perform agent_proposal_decide(pr.id, verdict, null, 'reply');
  return true;
end $$;

-- What makes it act: a person's message (anyone's, when it listens to everyone; a leader's otherwise) of a kind it
-- does not stay out of, where it may speak. A reply that settles a proposal is a decision, not a question.
create or replace function pulse.agent_event_from_chat() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a record; leader boolean;
begin
  if new.kind <> 'text' or new.removed_at is not null or new.author_id is distinct from current_viewer() then return null; end if;
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
       and not (x.kind = 'chat.group' and new.author_id = coalesce(m.approver_person_id, m.owner_person_id))
  loop
    insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
    values (new.org_id, a.agent, a.kind, 'message', new.id, 'message:' || new.id, new.author_id) on conflict do nothing;
  end loop;
  return null;
end $$;

do $$
declare d text; c text;
begin
  -- A run on a message from anyone it listens to; the run is told how to act (own / approve), who approves, and its
  -- instructions and SOP links.
  d := pg_get_functiondef('pulse.agent_dispatch(uuid,uuid,text,text)'::regprocedure);
  c := replace(d, $x$when not agent_leader(e.invoked_by) then 'not_leader'$x$, $x$when not agent_leader(e.invoked_by) and m.listens_to <> 'everyone' then 'not_leader'$x$);
  c := replace(c, $x$    'context', jsonb_build_object($x$, $x$    'context', jsonb_build_object(
      'mode', agent_mode_for(m, e.event_type), 'kind', e.event_type,
      'approver', (select display_name from person where id = coalesce(m.approver_person_id, m.owner_person_id)),
      'instructions', left(m.instructions, 8000), 'sops', to_jsonb(m.sop_links),$x$);
  if c = d or position('m.listens_to <> ''everyone''' in c) = 0 or position('agent_mode_for(m, e.event_type)' in c) = 0 then
    raise exception 'agent_dispatch changed shape (AI-EMPLOYEES v2)'; end if;
  execute c;

  d := pg_get_functiondef('pulse.agent_task_dispatch(uuid,uuid,text,text)'::regprocedure);
  c := replace(d, $x$    'context', jsonb_build_object($x$, $x$    'context', jsonb_build_object(
      'instructions', left(m.instructions, 8000), 'sops', to_jsonb(m.sop_links),$x$);
  if c = d then raise exception 'agent_task_dispatch changed shape (AI-EMPLOYEES v2)'; end if;
  execute c;

  -- More runtimes (an API key on this server; shown "not connected" until one is) and tools.
  d := pg_get_functiondef('pulse.agent_settings_save(uuid,jsonb)'::regprocedure);
  c := replace(d, $x$if p->>'provider' not in ('codex','claude') then raise exception 'Choose Claude or Codex'$x$,
                  $x$if p->>'provider' not in ('codex','claude','anthropic_api','openai_api','stub') then raise exception 'Choose a runtime'$x$);
  c := replace(c, $x$if t not in ('chats','tasks','memory','board','drive','web') then$x$, $x$if t not in ('chats','tasks','memory','board','drive','web','server','mcp','projects') then$x$);
  c := replace(c, $x$if not agent_manage_ok(p_agent) then raise exception 'Its manager or an admin changes an AI employee'$x$,
                  $x$if not agent_manage_ok(p_agent) then raise exception 'Admins, HR, leadership or its manager change an AI employee'$x$);
  if c = d or position('anthropic_api' in c) = 0 or position('''server'',''mcp''' in c) = 0 then raise exception 'agent_settings_save changed shape (AI-EMPLOYEES v2)'; end if;
  execute c;

  -- Its profile shows the v2 settings, its proposals (who decided) and the projects it coordinates.
  d := pg_get_functiondef('pulse.agent_detail(uuid)'::regprocedure);
  c := replace(d, $x$'department', pp.department, 'title', m.title),$x$, $x$'department', pp.department, 'title', m.title,
      'listensTo', m.listens_to, 'autonomy', m.autonomy, 'approverId', m.approver_person_id,
      'approverName', (select display_name from person where id = coalesce(m.approver_person_id, m.owner_person_id)),
      'instructions', m.instructions, 'sopLinks', to_jsonb(m.sop_links), 'mcpServers', to_jsonb(m.mcp_servers), 'paused', m.disabled_at is not null),$x$);
  c := replace(c, $x$    'groups', (select$x$, $x$    'proposals', (select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) from (
               select pr.created_at at, jsonb_build_object('id', pr.id, 'at', pr.created_at, 'state', pr.state, 'body', left(coalesce(pr.sent_body, pr.body), 300),
                 'channelId', pr.channel_id, 'channelName', (select case when c2.kind = 'direct' then 'a direct message' else c2.name end from chat_channel c2 where c2.id = pr.channel_id),
                 'approver', (select display_name from person where id = pr.approver_id), 'decidedBy', (select display_name from person where id = pr.decided_by),
                 'decidedAt', pr.decided_at, 'via', pr.decided_via, 'edited', pr.sent_body is not null and pr.sent_body <> pr.body) j
                 from agent_proposal pr where pr.agent_id = p_agent and (agent_manage_ok(p_agent) or pr.approver_id = current_viewer()) order by pr.created_at desc limit 20) x),
    'projects', (select coalesce(jsonb_agg(jsonb_build_object('id', pr.id, 'title', coalesce(pr.title, pr.name), 'role', pm.role) order by coalesce(pr.title, pr.name)), '[]'::jsonb)
                 from project_member pm join project pr on pr.id = pm.project_id where pm.person_id = p_agent and pm.left_at is null),
    'groups', (select$x$);
  if c = d or position('''listensTo''' in c) = 0 or position('''proposals''' in c) = 0 then raise exception 'agent_detail changed shape (AI-EMPLOYEES v2)'; end if;
  execute c;
end $$;

revoke all on function pulse.agent_mode_for(pulse.agent_member,text), pulse.agent_ai_save(uuid,jsonb), pulse.project_coordinator_set(uuid,uuid,text),
  pulse.agent_propose(uuid,text,text,uuid), pulse.agent_proposal_decide(uuid,text,text,text), pulse.agent_proposal_from_reply(uuid) from public;
grant execute on function pulse.agent_mode_for(pulse.agent_member,text), pulse.agent_ai_save(uuid,jsonb), pulse.project_coordinator_set(uuid,uuid,text),
  pulse.agent_propose(uuid,text,text,uuid), pulse.agent_proposal_decide(uuid,text,text,text) to pulse_api;

-- migrate:down
-- Forward-only: proposals and who decided them stay auditable; set an AI employee to stay out instead.
