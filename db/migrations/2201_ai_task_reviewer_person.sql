-- migrate:up
-- WL-ONBOARD (17 Nov 2026): Sakobe asked bhrātā (Willow Lane) "assign Savuzo a task … by today EOD" and Pulse refused,
-- three times: "Choose an active reviewer". bhrātā's approver is Savuzo, the assignee, so 1690 left the reviewer out,
-- and task_save's default for a new task is its creator: the AI employee itself, which is not an active staff member.
-- So an AI employee could not give a task to its own approver or owner. The reviewer is now the first of the AI's
-- approver and owner who is not the assignee (a person), and none ('' = no reviewer) when both are the assignee; it is
-- never the AI employee. Same patch pattern as 1351/1410/1690.
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.agent_chief_act(uuid,jsonb)'::regprocedure); was := src;
  src := replace(src, $q$'reviewerId', nullif((select coalesce(m.approver_person_id, m.owner_person_id) from agent_member m where m.person_id = me), who),$q$,
    $q$'reviewerId', coalesce((select (case when coalesce(m.approver_person_id, m.owner_person_id) is distinct from who then coalesce(m.approver_person_id, m.owner_person_id)
        when m.owner_person_id is distinct from who then m.owner_person_id end)::text from agent_member m where m.person_id = me), ''),$q$);
  if src = was then raise exception 'agent_chief_act changed upstream: update 2201'; end if;
  execute src;
end $$;

-- migrate:down
do $$
declare src text;
begin
  src := pg_get_functiondef('pulse.agent_chief_act(uuid,jsonb)'::regprocedure);
  execute replace(src, $q$'reviewerId', coalesce((select (case when coalesce(m.approver_person_id, m.owner_person_id) is distinct from who then coalesce(m.approver_person_id, m.owner_person_id)
        when m.owner_person_id is distinct from who then m.owner_person_id end)::text from agent_member m where m.person_id = me), ''),$q$,
    $q$'reviewerId', nullif((select coalesce(m.approver_person_id, m.owner_person_id) from agent_member m where m.person_id = me), who),$q$);
end $$;
