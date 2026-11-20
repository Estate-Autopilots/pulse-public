-- migrate:up
-- AI-AGENTS-2 (owner, 17 Nov 2026: "the daily triage reports to only one person"): an AI employee's daily triage (1351,
-- 2143) made one task a day, reviewed by its approver, and its one card went to that approver. Its managers can now name
-- up to 10 more people who receive the triage: each is a watcher of the day's triage task, so they see the AI's list
-- and proposals there and hear when it is done (0144's watcher note). One person still decides (Apply all stays with
-- the approver); a recipient who left, or is not an active staff member of this company, is skipped.
alter table pulse.agent_member add column if not exists triage_watchers uuid[] not null default '{}';
alter table pulse.agent_member add constraint agent_member_triage_watchers_check check (cardinality(triage_watchers) <= 10);

-- Its managers set who else receives the daily triage (the same check as switching the triage on).
create or replace function pulse.agent_triage_watchers_set(p_agent uuid, p_people uuid[]) returns uuid[] language plpgsql security definer set search_path = pulse, pg_temp as $$
declare keep uuid[];
begin
  if agent_session() is not null or not agent_manage_ok(p_agent) then raise exception 'Admins, HR, leadership or its manager change an AI employee' using errcode = '42501'; end if;
  if cardinality(coalesce(p_people, '{}')) > 10 then raise exception 'Choose up to 10 people to receive the daily triage' using errcode = '22023'; end if;
  select coalesce(array_agg(p.id order by p.display_name), '{}') into keep
    from person p where p.org_id = current_org() and p.id = any(coalesce(p_people, '{}')) and p.status = 'active' and p.side = 'staff' and p.id <> p_agent;
  if cardinality(keep) <> cardinality(array(select distinct x from unnest(coalesce(p_people, '{}')) x)) then
    raise exception 'Choose active colleagues of this company' using errcode = '22023'; end if;
  update agent_member set triage_watchers = keep where person_id = p_agent and org_id = current_org();
  if not found then raise exception 'Choose an AI employee' using errcode = '22023'; end if;
  return keep;
end $$;
revoke all on function pulse.agent_triage_watchers_set(uuid, uuid[]) from public;
grant execute on function pulse.agent_triage_watchers_set(uuid, uuid[]) to pulse_api;

-- The day's triage task gets them as watchers (2143's body otherwise unchanged; stops if upstream changed the line).
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.agent_triage_start()'::regprocedure); was := src;
  src := replace(src, $q$  return jsonb_build_object('tasks', n, 'taskId', tid);$q$,
    $q$  insert into task_member(org_id, task_id, person_id, role, added_by)
    select current_org(), tid, p.id, 'watcher', me from person p
     where p.org_id = current_org() and p.id = any(m.triage_watchers) and p.status = 'active' and p.side = 'staff' and p.id is distinct from ap
    on conflict do nothing;
  return jsonb_build_object('tasks', n, 'taskId', tid, 'watchers', (select count(*) from task_member w where w.task_id = tid and w.role = 'watcher' and w.removed_at is null));$q$);
  if src = was then raise exception 'agent_triage_start changed upstream: update 2232'; end if;
  execute src;
end $$;

-- migrate:down
do $$
declare src text;
begin
  src := pg_get_functiondef('pulse.agent_triage_start()'::regprocedure);
  execute replace(src, $q$  insert into task_member(org_id, task_id, person_id, role, added_by)
    select current_org(), tid, p.id, 'watcher', me from person p
     where p.org_id = current_org() and p.id = any(m.triage_watchers) and p.status = 'active' and p.side = 'staff' and p.id is distinct from ap
    on conflict do nothing;
  return jsonb_build_object('tasks', n, 'taskId', tid, 'watchers', (select count(*) from task_member w where w.task_id = tid and w.role = 'watcher' and w.removed_at is null));$q$,
    $q$  return jsonb_build_object('tasks', n, 'taskId', tid);$q$);
end $$;
drop function if exists pulse.agent_triage_watchers_set(uuid, uuid[]);
alter table pulse.agent_member drop constraint if exists agent_member_triage_watchers_check;
alter table pulse.agent_member drop column if exists triage_watchers;
