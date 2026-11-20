-- migrate:up
-- AI-FIX (19 Nov 2026, BUG-CENSUS BC-059; WL-FABLE-AITASKS §3): "aaj aur kal mere kaun kaun se task pending hain?" was
-- answered from the tasks the AI employee itself made. list_tasks under the task row security (task_person) shows an AI
-- employee with operations access only what it made, holds or reviews; for QA Seller it returned 3 of 9 open tasks, and
-- bhrātā named 2 of 4 with no word that more may exist. On production it would leave out every task a person gave them.
--
-- The person asking may read their own tasks; the AI employee answering them now may read those, and only those: their
-- own tasks (assignee or owner), while it is helping them (they wrote to it in the last 30 minutes, in a conversation
-- without a client: agent_ui_helping, the rule its screen tools already use, 1745). Nobody else's tasks, no other time.
-- Same JSON as the triage list (2176), so the API reads it the same way.
create or replace function pulse.agent_asker_tasks(p_person uuid, p_status text, p_take int) returns setof jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  if p_status is null or p_status not in ('open', 'done', 'all') then raise exception 'status is open, done or all' using errcode = '22023'; end if;
  if p_person is null or not exists(select 1 from person where id = p_person and org_id = current_org() and side = 'staff')
     or agent_ui_helping(me, p_person) is null then
    raise exception 'You can list a colleague''s own tasks only while you help them: they wrote to you in the last 30 minutes' using errcode = '42501';
  end if;
  return query
    select jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority,
             'dueAt', to_char(t.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'projectId', t.project_id,
             'project', coalesce(pr.title, pr.name), 'assigneeId', coalesce(t.assignee_person_id, t.owner_id),
             'assignee', a.display_name, 'stage', t.stage)
      from task t
      left join project pr on pr.id = t.project_id and pr.org_id = t.org_id
      left join person a on a.id = coalesce(t.assignee_person_id, t.owner_id) and a.org_id = t.org_id
     where t.org_id = current_org() and t.deleted_at is null and p_person in (t.assignee_person_id, t.owner_id)
       and (p_status = 'all' or (p_status = 'open' and t.status not in ('done', 'accepted', 'cancelled'))
            or (p_status = 'done' and t.status in ('done', 'accepted')))
     order by t.due_at nulls last, t.created_at desc
     limit least(greatest(coalesce(p_take, 50), 1), 100);
end $$;
revoke all on function pulse.agent_asker_tasks(uuid, text, int) from public;
grant execute on function pulse.agent_asker_tasks(uuid, text, int) to pulse_api;

-- Whether the calling AI employee is helping this staff person now (the API asks before it reads their tasks this way).
create or replace function pulse.agent_asker_ok(p_person uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select agent_session() is not null and p_person is not null
     and exists(select 1 from person where id = p_person and org_id = current_org() and side = 'staff')
     and agent_ui_helping(agent_session(), p_person) is not null
$$;
revoke all on function pulse.agent_asker_ok(uuid) from public;
grant execute on function pulse.agent_asker_ok(uuid) to pulse_api;

-- migrate:down
drop function if exists pulse.agent_asker_ok(uuid);
drop function if exists pulse.agent_asker_tasks(uuid, text, int);
