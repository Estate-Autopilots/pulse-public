-- migrate:up
-- TG-VOICE (7 Nov 2026): "create a task for the site visit, assigned to me", said to an AI employee by the person it
-- reports to, failed with "Choose a reviewer other than the person doing the task": the AI employee's task.create
-- always named its approver (else its owner) as the reviewer, and here that is the assignee. The reviewer is now left to
-- task_save's own default when it would be the assignee. Same patch pattern as 1351/1410.
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.agent_chief_act(uuid,jsonb)'::regprocedure); was := src;
  src := replace(src, $q$'reviewerId', (select coalesce(m.approver_person_id, m.owner_person_id) from agent_member m where m.person_id = me),$q$,
    $q$'reviewerId', nullif((select coalesce(m.approver_person_id, m.owner_person_id) from agent_member m where m.person_id = me), who),$q$);
  if src = was then raise exception 'agent_chief_act changed upstream: update 1690'; end if;
  execute src;
end $$;

-- migrate:down
do $$
declare src text;
begin
  src := pg_get_functiondef('pulse.agent_chief_act(uuid,jsonb)'::regprocedure);
  execute replace(src, $q$'reviewerId', nullif((select coalesce(m.approver_person_id, m.owner_person_id) from agent_member m where m.person_id = me), who),$q$,
    $q$'reviewerId', (select coalesce(m.approver_person_id, m.owner_person_id) from agent_member m where m.person_id = me),$q$);
end $$;
