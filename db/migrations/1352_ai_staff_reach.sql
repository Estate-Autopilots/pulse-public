-- migrate:up
-- AI-AUTONOMY (orchestrator, under the owner's standing delegation, 28 Oct 2026; QA-BULK P-10): every active staff member
-- can DM and @mention AI employees, not only leadership. "Listens to: leaders" now means the organisation's staff (its
-- colleagues); "everyone" adds clients and other organisations' people. Managing an AI employee (settings, risk policy)
-- stays with admins, HR, leadership and its manager. The API lists AI employees to all staff (chats.ts).
--   chat_direct            a staff member may open a direct message with an active AI employee
--   agent_event_from_chat  a staff member's message (direct, mention, reply) reaches it
--   agent_dispatch         a staff member's message is no longer refused as "not_leader" (someone who left still is)
--   agent_profile          its profile for every active colleague; GET /api/v0/agents/team for all staff
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.chat_direct(uuid)'::regprocedure); was := src;
  src := replace(src, '(agent_leader(current_viewer()) and exists(select 1 from agent_member m',
    '(exists(select 1 from person v where v.id=current_viewer() and v.status=''active'' and v.side=''staff'') and exists(select 1 from agent_member m');
  if src = was then raise exception 'chat_direct changed upstream: update 1352'; end if;
  execute src;

  src := pg_get_functiondef('pulse.agent_event_from_chat()'::regprocedure); was := src;
  src := replace(src, 'and (leader or m.listens_to = ''everyone'')',
    'and (leader or m.listens_to = ''everyone'' or exists(select 1 from person au where au.id = new.author_id and au.side = ''staff'' and au.status = ''active''))');
  if src = was then raise exception 'agent_event_from_chat changed upstream: update 1352'; end if;
  execute src;

  src := pg_get_functiondef('pulse.agent_dispatch(uuid,uuid,text,text)'::regprocedure); was := src;
  src := replace(src, 'when not agent_leader(e.invoked_by) and m.listens_to <> ''everyone'' then ''not_leader''',
    'when not agent_leader(e.invoked_by) and m.listens_to <> ''everyone'' and not exists(select 1 from person au where au.id = e.invoked_by and au.side = ''staff'' and au.status = ''active'') then ''not_leader''');
  if src = was then raise exception 'agent_dispatch changed upstream: update 1352'; end if;
  execute src;

  -- Its profile (People → the AI employee, with Message) for every active colleague, not only leadership and those who
  -- share a conversation with it.
  src := pg_get_functiondef('pulse.agent_profile(uuid)'::regprocedure); was := src;
  src := replace(src, 'and (agent_leader(current_viewer()) or exists(',
    'and (agent_leader(current_viewer()) or exists(select 1 from person v where v.id = current_viewer() and v.side = ''staff'' and v.status = ''active'') or exists(');
  if src = was then raise exception 'agent_profile changed upstream: update 1352'; end if;
  execute src;
end $$;

-- migrate:down
-- Forward-only.
