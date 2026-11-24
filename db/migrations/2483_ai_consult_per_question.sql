-- migrate:up
-- AI-FIX-5 (BC-173, 20 Nov 2026): an AI employee that has asked one colleague several things in the same direct message
-- (one question for Rifob, then one for Kavya) tied the colleague's answers to the wrong question. Every lookup took
-- "the newest question in this direct message", not the one the message answered:
--   agent_consult_answer   a reply to Rifob's question (quoted, or in its thread) became the answer to Kavya's, the newest
--   agent_consult_context  the run about the colleague's 2nd answer (now tied to Rifob's question) was still given
--                          Kavya's question, so it relayed Rifob's answer into Kavya's conversation
--   agent_consult_ask      a follow-up asked in that run said "(For Kavya …)" on Rifob's question
--   agent_propose_task     the task card offered the people of Kavya's conversation, not Rifob's
--   agent_task_dm_answer   compared a task question with the newest question, not the one that took the message
-- Now each answer belongs to one question: the one it quotes or replies in the thread of, else the newest waiting one
-- (as before); everything after that reads the question that took this message (answer_message_id), falling back to
-- the newest as before. Patched in place (as 1410 and 1411 do); each patch refuses to run if the text moved upstream.
do $$
declare src text; was text;
begin
  -- 1. The question this message answers: the one it quotes or replies to (even one already answered: a correction),
  --    else the newest still waiting. A message that quotes one of its questions never answers another one.
  src := pg_get_functiondef('pulse.agent_consult_answer()'::regprocedure); was := src;
  src := replace(src,
    'for c in select distinct on (agent_id) * from agent_consult
            where org_id = new.org_id and dm_channel_id = new.channel_id and colleague_id = new.author_id and state = ''open''
              and created_at > now() - interval ''3 days'' order by agent_id, created_at desc loop',
    'for c in select distinct on (x.agent_id) x.* from agent_consult x
            where x.org_id = new.org_id and x.dm_channel_id = new.channel_id and x.colleague_id = new.author_id
              and x.created_at > now() - interval ''3 days''
              and (x.question_message_id in (new.quote_id, new.parent_id) and x.state in (''open'',''answered'',''relayed'')
                   or x.state = ''open'' and not exists(select 1 from agent_consult q where q.org_id = new.org_id and q.agent_id = x.agent_id
                                                         and q.dm_channel_id = new.channel_id and q.question_message_id in (new.quote_id, new.parent_id)))
            order by x.agent_id, coalesce(x.question_message_id in (new.quote_id, new.parent_id), false) desc, x.created_at desc loop');
  if src = was then raise exception 'agent_consult_answer changed upstream: update 2483'; end if;
  execute src;

  -- 2. The run about the answer reads the question that took it.
  src := pg_get_functiondef('pulse.agent_consult_context(uuid)'::regprocedure); was := src;
  src := replace(src, 'where m.id = p_msg and c.state in (''answered'',''relayed'',''open'') order by c.created_at desc limit 1',
    'where m.id = p_msg and c.state in (''answered'',''relayed'',''open'') order by coalesce(c.answer_message_id = m.id, false) desc, c.created_at desc limit 1');
  if src = was then raise exception 'agent_consult_context changed upstream: update 2483'; end if;
  execute src;

  -- 3. A follow-up question carries that question's asker and conversation in its footer.
  src := pg_get_functiondef('pulse.agent_consult_ask(uuid,text,text,uuid)'::regprocedure); was := src;
  src := replace(src, 'and e.event_type = ''consult.answer'' order by created_at desc limit 1;',
    'and e.event_type = ''consult.answer'' order by coalesce(answer_message_id = msg.id, false) desc, created_at desc limit 1;');
  if src = was then raise exception 'agent_consult_ask changed upstream: update 2483'; end if;
  execute src;

  -- 4. A task card from that run offers the people of that question's conversation.
  src := pg_get_functiondef('pulse.agent_propose_task(uuid,jsonb,text,uuid)'::regprocedure); was := src;
  src := replace(src, 'and c.dm_channel_id = msg.channel_id and c.answer_message_id is not null order by c.created_at desc limit 1)',
    'and c.dm_channel_id = msg.channel_id and c.answer_message_id is not null order by coalesce(c.answer_message_id = msg.id, false) desc, c.created_at desc limit 1)');
  if src = was then raise exception 'agent_propose_task changed upstream: update 2483'; end if;
  execute src;

  -- 5. A task question asked after the question that took the message wins it (compared with that question).
  src := pg_get_functiondef('pulse.agent_task_dm_answer()'::regprocedure); was := src;
  src := replace(src, 'and c.colleague_id = new.author_id order by c.created_at desc limit 1;',
    'and c.colleague_id = new.author_id order by coalesce(c.answer_message_id = new.id, false) desc, c.created_at desc limit 1;');
  if src = was then raise exception 'agent_task_dm_answer changed upstream: update 2483'; end if;
  execute src;
end $$;

-- migrate:down
-- Forward-only.
