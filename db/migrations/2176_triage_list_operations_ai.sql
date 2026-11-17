-- migrate:up
-- BUG-SWEEP-3 (Agent Lab #2, its Project Manager AI, 16 Nov 2026: "list_triage_tasks({"limit":"100"}) and
-- list_triage_tasks({}) both returned {} ... Prepared the proposal from the three qualifying tasks in the supplied work
-- view"). The daily triage (agent_triage_start, 2143) is made only for an AI employee that runs work itself (agent_acts:
-- the Chief of Staff, or Operations access). It counts every open task of the company with no owner or no due day, and
-- the work view it reads (agent_chief_snapshot, 1350) shows such an AI employee every task ("agent_acts(me) or
-- task_visible"). list_triage_tasks (2143's API v1 list) read the same tasks under the AI's own row security, so the
-- tasks in projects it is not on were counted and shown in the work view but listed as none.
-- This is the triage list by the work view's own rule, for those AI employees only: the same tasks, in the same order,
-- that agent_triage_start counts. Every other caller (people, AI employees that only propose) keeps its row security in
-- the API and is refused here. Nothing is written.
create or replace function pulse.agent_triage_page(p_needs text, p_after uuid, p_take int) returns setof jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null or not agent_acts(me) then
    raise exception 'Only an AI employee that runs work itself reads the whole triage list' using errcode = '42501'; end if;
  if p_needs is null or p_needs not in ('owner', 'due', 'either') then
    raise exception 'needs is owner, due or either' using errcode = '22023'; end if;
  return query
    select jsonb_build_object('id', t.id, 'title', t.title, 'status', t.status, 'priority', t.priority,
             'dueAt', to_char(t.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'projectId', t.project_id,
             'project', coalesce(pr.title, pr.name), 'assigneeId', coalesce(t.assignee_person_id, t.owner_id),
             'assignee', a.display_name, 'stage', t.stage)
      from task t
      left join project pr on pr.id = t.project_id and pr.org_id = t.org_id
      left join person a on a.id = coalesce(t.assignee_person_id, t.owner_id) and a.org_id = t.org_id
     where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled')
       and ((p_needs = 'owner' and t.assignee_person_id is null) or (p_needs = 'due' and t.due_at is null)
            or (p_needs = 'either' and (t.assignee_person_id is null or t.due_at is null)))
       and coalesce(t.created_by, '00000000-0000-0000-0000-000000000000'::uuid) <> me
       and (p_after is null or t.id > p_after)
     order by t.id
     limit least(greatest(coalesce(p_take, 101), 1), 101);
end $$;
revoke all on function pulse.agent_triage_page(text, uuid, int) from public;
grant execute on function pulse.agent_triage_page(text, uuid, int) to pulse_api;

-- migrate:down
drop function if exists pulse.agent_triage_page(text, uuid, int);
