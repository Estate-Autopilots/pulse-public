-- migrate:up
-- AI-AUTONOMY (owner, 27 Oct 2026): "a top Admin / Chief of Staff AI employee with leadership- and admin-level function:
-- it can read and edit nearly anything in Pulse through the app's own APIs, with the same authz and audit as a human
-- admin." An admin makes an AI employee the Chief of Staff (agent_chief_set). An AI holds no role (agent_no_role, 0510),
-- so agent_member.chief says it, and viewer_is('admin') answers yes for it inside its own session: every check in
-- Pulse then treats it as an admin. Its runtime gets:
--   agent_chief_snapshot()   what an admin sees at a glance: work that needs an owner, a due day or is late; projects;
--                            people (names, roles, pods, teams; nothing secret); the bug and feature board; the AI
--                            employees (state, today's runs, cards waiting); people not signed in yet
--   agent_chief_act(run, p)  its actions, each through Pulse's own functions as itself: create a task (task_save), change
--                            a task's owner, due day or title (task_save), move a task (task_move), a direct message to a
--                            colleague (chat_send), a request on the board (agent_request_file); recorded as the AI.
-- The guard of 0965 still holds for it: no AI session deletes, moves money, or changes roles, sign-ins or security
-- settings. Its risk policy (1230) still holds back risky messages.

alter table pulse.agent_member add column if not exists chief boolean not null default false;

-- 0004's viewer_is, plus: the Chief of Staff, in its own session, is an admin.
create or replace function pulse.viewer_is(variadic roles text[]) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (
    select 1 from role_assignment
     where org_id = pulse.current_org() and person_id = pulse.current_viewer() and role_key = any(roles)
       and current_date between valid_from and coalesce(valid_to, 'infinity'))
  or ('admin' = any(roles) and coalesce(current_setting('pulse.agent_session', true), '') = 'on' and exists (
    select 1 from agent_member m where m.org_id = pulse.current_org() and m.person_id = pulse.current_viewer()
       and m.chief and m.disabled_at is null))
$$;

-- Who runs work itself (the work actions below): the Chief of Staff, and AI employees with operations access.
create or replace function pulse.agent_acts(p_agent uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select (m.chief or m.access = 'operations') and m.disabled_at is null from agent_member m where m.org_id = current_org() and m.person_id = p_agent), false)
$$;
-- Who sees the work view: those, and AI employees with the Projects or Tasks tool (the work they may see).
create or replace function pulse.agent_sees(p_agent uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select m.disabled_at is null and (m.chief or m.access = 'operations' or m.tools && array['projects', 'tasks']) from agent_member m where m.org_id = current_org() and m.person_id = p_agent), false)
$$;

create or replace function pulse.agent_chief(p_agent uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select m.chief and m.disabled_at is null from agent_member m where m.org_id = current_org() and m.person_id = p_agent), false)
$$;

-- An admin (a person) makes an AI employee the Chief of Staff, or takes it back. An AI never changes it. Audited.
create or replace function pulse.agent_chief_set(p_agent uuid, p_on boolean) returns boolean language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or current_viewer() is null or not viewer_is('admin') then
    raise exception 'Only an admin makes an AI employee the Chief of Staff' using errcode = '42501'; end if;
  update agent_member set chief = coalesce(p_on, false),
    tools = case when p_on then array(select distinct t from unnest(tools || array['tasks', 'chats', 'memory']) t) else tools end
   where person_id = p_agent and org_id = current_org();
  if not found then raise exception 'Choose an AI employee' using errcode = '22023'; end if;
  perform audit_write('agent_chief_set', 'agent_member', p_agent::text || ':' || coalesce(p_on, false)::text);
  return coalesce(p_on, false);
end $$;
create or replace function pulse.agent_chief_guard() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.chief is distinct from old.chief and agent_session() is not null then
    raise exception 'An AI employee does not make itself the Chief of Staff' using errcode = '42501'; end if;
  return new;
end $$;
drop trigger if exists agent_chief_guard on pulse.agent_member;
create trigger agent_chief_guard before update of chief on pulse.agent_member for each row execute function pulse.agent_chief_guard();

-- Tasks are worked by team members (task_require_viewer); the Chief of Staff, in its own session, is one of them, so
-- task_save and task_move run their own checks for it (as an admin, through viewer_is above).
create or replace function pulse.task_require_viewer() returns uuid language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if current_viewer() is null or not (task_person_ok(current_viewer()) or (agent_session() = current_viewer() and agent_acts(current_viewer()))) then
  raise exception 'Sign in as a team member to manage tasks' using errcode='42501';end if;
 return current_viewer();
end $$;

-- Who may give whom work (work_scope) reads work_role; the Chief of Staff works at leadership's level.
create or replace function pulse.work_role(p_person uuid default pulse.current_viewer()) returns text
  language sql stable security definer set search_path to 'pulse', 'pg_temp' as $$
 select case when p_person is null then 'none'
  when exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p_person and r.role_key in ('admin','leadership') and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) then 'leadership'
  when exists(select 1 from agent_member m where m.org_id=current_org() and m.person_id=p_person and (m.chief or m.access = 'operations') and m.disabled_at is null) then 'leadership'
  when exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p_person and r.role_key='hr' and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) then 'hr'
  when hr_is_pod_head(p_person) or exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p_person and (r.is_manager_of_unit or r.role_key in ('manager','pgs','head_pgs'))
   and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) or exists(select 1 from people_profile where org_id=current_org() and manager_id=p_person) then 'pod_head'
  else 'member' end
$$;

create or replace function pulse.agent_chief_snapshot() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null or not agent_sees(me) then raise exception 'This AI employee has no view of the work' using errcode = '42501'; end if;
  return jsonb_build_object(
    'now', to_char(now() at time zone org_time_zone(), 'FMDay DD Mon YYYY, HH24:MI'),
    'tasks', (select jsonb_build_object('open', count(*), 'late', count(*) filter (where t.due_at < now()),
        'noOwner', count(*) filter (where t.assignee_person_id is null), 'noDueDay', count(*) filter (where t.due_at is null),
        'waitingReview', count(*) filter (where t.status = 'in_review'))
       from task t where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled') and (agent_acts(me) or task_visible(t.id))),
    -- What each person holds (open, late, finished this week), for "how is X doing" and a week's summary per person.
    'byPerson', (select coalesce(jsonb_agg(x.j order by x.n), '[]'::jsonb) from (
        select p.display_name n, jsonb_build_object('name', p.display_name, 'username', pp.username,
          'open', count(t.id) filter (where t.status not in ('done', 'accepted', 'cancelled')),
          'late', count(t.id) filter (where t.status not in ('done', 'accepted', 'cancelled') and t.due_at < now()),
          'finishedThisWeek', count(t.id) filter (where t.status in ('done', 'accepted') and t.updated_at > now() - interval '7 days'),
          'tasks', coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'title', left(t.title, 120), 'status', t.status, 'due', t.due_at::date) order by t.due_at nulls last)
                     filter (where t.id is not null and t.status not in ('cancelled') and (t.status not in ('done', 'accepted') or t.updated_at > now() - interval '7 days')), '[]'::jsonb)) j
          from person p join people_profile pp on pp.person_id = p.id
          left join task t on t.assignee_person_id = p.id and t.org_id = current_org() and t.deleted_at is null and (agent_acts(me) or task_visible(t.id))
         where p.org_id = current_org() and p.status = 'active' and p.side = 'staff'
         group by p.id, p.display_name, pp.username order by p.display_name limit 60) x),
    'attention', (select coalesce(jsonb_agg(x.j order by x.k), '[]'::jsonb) from (
        select case when t.due_at < now() then 0 when t.assignee_person_id is null then 1 else 2 end k,
          jsonb_build_object('id', t.id, 'title', left(t.title, 160), 'status', t.status, 'due', t.due_at::date,
            'owner', (select display_name from person where id = t.assignee_person_id), 'project', (select coalesce(title, name) from project where id = t.project_id),
            'why', case when t.due_at < now() then 'late' when t.assignee_person_id is null then 'no owner' else 'no due day' end) j
          from task t where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled')
            and (t.due_at < now() or t.assignee_person_id is null or t.due_at is null) and (agent_acts(me) or task_visible(t.id))
          order by 1, t.due_at nulls last limit 25) x),
    'projects', (select coalesce(jsonb_agg(x.j), '[]'::jsonb) from (
        select jsonb_build_object('id', pr.id, 'name', coalesce(pr.title, pr.name), 'openTasks', (select count(*) from task t where t.project_id = pr.id and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled'))) j
          from project pr where pr.org_id = current_org() order by pr.updated_at desc limit 20) x),
    'people', (select coalesce(jsonb_agg(x.j order by x.n), '[]'::jsonb) from (
        select p.display_name n, jsonb_build_object('name', p.display_name, 'username', pp.username, 'role', pp.role, 'pod', pp.pod, 'team', pp.department,
          'leader', agent_leader(p.id)) j
          from person p join people_profile pp on pp.person_id = p.id
         where p.org_id = current_org() and p.status = 'active' and p.side = 'staff' order by p.display_name limit 120) x),
    'board', (select coalesce(jsonb_agg(jsonb_build_object('number', b.number, 'kind', b.kind, 'title', coalesce(b.title, left(b.words, 100)), 'status', b.status, 'votes', b.votes) order by b.votes desc), '[]'::jsonb)
       from (select * from reported_bug where org_id = current_org() and status in ('new', 'triaged', 'fixing') and duplicate_of is null order by votes desc, created_at desc limit 10) b),
    'aiEmployees', (select coalesce(jsonb_agg(jsonb_build_object('name', p.display_name, 'title', m.title, 'state', coalesce(m.runtime_state, 'unknown'),
          'runsToday', (select count(*) from agent_run r where r.agent_id = m.person_id and (r.started_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date),
          'cardsWaiting', (select count(*) from agent_proposal pr where pr.agent_id = m.person_id and pr.state = 'pending')) order by p.display_name), '[]'::jsonb)
       from agent_member m join person p on p.id = m.person_id where m.org_id = current_org() and m.disabled_at is null and p.status = 'active'),
    -- Who is off in the next three weeks (approved or asked; never the reason).
    'leave', (select coalesce(jsonb_agg(jsonb_build_object('name', p.display_name, 'from', l.from_date, 'to', l.to_date, 'kind', l.leave_kind, 'status', l.status, 'halfDay', l.half_day) order by l.from_date), '[]'::jsonb)
       from leave_request l join person p on p.id = l.person_id
      where l.org_id = current_org() and l.status in ('approved', 'pending') and l.to_date >= current_date and l.from_date <= current_date + 21),
    'notSignedIn', (select count(*) from person p where p.org_id = current_org() and p.status = 'active' and p.side = 'staff'
        and not exists(select 1 from people_profile pp where pp.person_id = p.id and pp.username is not null)));
end $$;

-- Its actions, at most 10 a run, each on its own (one failing does not undo the others), each through Pulse's own checks.
create or replace function pulse.agent_chief_act(p_run uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); a jsonb; out_ jsonb := '[]'::jsonb; t text; who uuid; tid uuid; dm uuid; patch jsonb; res jsonb;
begin
  if me is null or not agent_sees(me) then raise exception 'This AI employee has no work actions' using errcode = '42501'; end if;
  if not exists(select 1 from agent_run where id = p_run and org_id = current_org() and agent_id = me) then raise exception 'Act inside one of your runs' using errcode = '42501'; end if;
  if jsonb_typeof(p->'actions') is distinct from 'array' then raise exception 'Send the actions' using errcode = '22023'; end if;
  for a in select x from jsonb_array_elements(p->'actions') x limit 10 loop
    t := coalesce(a->>'type', '');
    begin
      who := null;
      if coalesce(a->>'assignee', a->>'to', '') <> '' then
        select pp.person_id into who from people_profile pp join person pe on pe.id = pp.person_id
         where pp.org_id = current_org() and lower(pp.username) = lower(btrim(coalesce(a->>'assignee', a->>'to'), ' @')) and pe.status = 'active' and pe.side = 'staff';
        if who is null then raise exception 'No colleague with that username' using errcode = '22023'; end if;
      end if;
      if t like 'task.%' and not agent_acts(me) then raise exception 'This AI employee does not run work itself' using errcode = '42501'; end if;
      if t = 'task.create' then
        tid := task_save(null, jsonb_strip_nulls(jsonb_build_object('title', a->>'title', 'assigneeId', who, 'dueOn', nullif(a->>'dueOn', ''),
          'reviewerId', (select coalesce(m.approver_person_id, m.owner_person_id) from agent_member m where m.person_id = me),
          'notes', concat_ws(chr(10), nullif(a->>'notes', ''), 'Created by ' || (select display_name from person where id = me) || ' (Chief of Staff, AI).'))));
        res := jsonb_build_object('type', t, 'ok', true, 'taskId', tid);
      elsif t = 'task.update' then
        patch := jsonb_strip_nulls(jsonb_build_object('assigneeId', who, 'dueOn', nullif(a->>'dueOn', ''), 'title', nullif(a->>'title', '')));
        if patch = '{}'::jsonb then raise exception 'Say what to change' using errcode = '22023'; end if;
        tid := task_save((a->>'taskId')::uuid, patch);
        res := jsonb_build_object('type', t, 'ok', true, 'taskId', tid);
      elsif t = 'task.move' then
        perform task_move((a->>'taskId')::uuid, a->>'status', nullif(left(coalesce(a->>'note', ''), 1000), ''));
        res := jsonb_build_object('type', t, 'ok', true, 'taskId', a->>'taskId');
      elsif t = 'dm' then
        if who is null or length(btrim(coalesce(a->>'text', ''))) not between 1 and 4000 then raise exception 'Say whom and what' using errcode = '22023'; end if;
        dm := agent_dm_with(me, who);
        perform chat_send(dm, btrim(a->>'text'), null, '[]'::jsonb, gen_random_uuid(), null);
        res := jsonb_build_object('type', t, 'ok', true, 'to', a->>'to');
      elsif t = 'call' then
        if who is null then raise exception 'Say whom to call' using errcode = '22023'; end if;
        res := jsonb_build_object('type', t, 'ok', true, 'to', a->>'to') || coalesce(call_ai_ring(who, left(coalesce(a->>'reason', ''), 300)), '{}'::jsonb);
      elsif t = 'request' then
        res := jsonb_build_object('type', t, 'ok', true) || agent_request_file(p_run, a);
      else
        raise exception 'Unknown action' using errcode = '22023';
      end if;
    exception when others then
      res := jsonb_build_object('type', t, 'ok', false, 'error', left(sqlerrm, 200));
    end;
    out_ := out_ || res;
  end loop;
  return jsonb_build_object('results', out_);
end $$;

revoke all on function pulse.agent_acts(uuid), pulse.agent_sees(uuid), pulse.agent_chief(uuid), pulse.agent_chief_set(uuid, boolean), pulse.agent_chief_snapshot(), pulse.agent_chief_act(uuid, jsonb) from public;
grant execute on function pulse.agent_acts(uuid), pulse.agent_sees(uuid), pulse.agent_chief(uuid), pulse.agent_chief_set(uuid, boolean), pulse.agent_chief_snapshot(), pulse.agent_chief_act(uuid, jsonb) to pulse_api;

-- migrate:down
-- Forward-only: take it back with agent_chief_set(agent, false).
