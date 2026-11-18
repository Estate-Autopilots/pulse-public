-- migrate:up
-- AI-AUTONOMY (battery 08, 28 Oct): a colleague's NEW message in their direct message with an AI employee was taken as
-- the "answer" to any question the AI had asked them in the last three days, even one already answered and relayed:
-- Meera's "attach Tanvi's offer letter (here)" became an answer to an old question, and the AI never saw her request or
-- its file. Only a question still waiting (open) takes the colleague's next message as its answer.
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.agent_consult_answer()'::regprocedure); was := src;
  src := replace(src, 'and colleague_id = new.author_id and state in (''open'',''answered'',''relayed'')',
    'and colleague_id = new.author_id and state = ''open''');
  if src = was then raise exception 'agent_consult_answer changed upstream: update 1411'; end if;
  execute src;
end $$;

-- migrate:down
-- Forward-only.
