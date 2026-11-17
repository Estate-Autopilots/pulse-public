-- migrate:up
-- PRIVACY (owner, 2 Nov 2026: "who sees what"). Three rules on top of the role and pod rules that already decide what a
-- person sees; each one only takes away, never adds.
--  1. A project says who sees it: org (everyone, as before; the default, so nothing changes for existing projects),
--     members (the people on it: members and watchers, its owner, its lead and whoever created it; and admins) or
--     leadership (leadership and admins, and the people on it). Its work project, people, tasks, time, files,
--     deliveries, discussion, asks and linked group chats follow it. Someone doing one of its tasks (owner, assignee,
--     reviewer, creator or collaborator) keeps seeing that task.
--  2. A task can be leadership-only: leadership and admins, and the people on that task.
--  3. A seat from outside the staff (person.side 'freelancer' or 'client') sees only the projects they are on and their
--     own tasks: theirs to do, review or follow, made by them or asked of them (the API also keeps a freelancer or a
--     client to their own work: routes.ts).
-- Enforced as restrictive SELECT policies for pulse_api. The SECURITY DEFINER functions below run as the owner, which
-- these policies do not name, so they never recurse. Every set is computed once per statement (an InitPlan) and is
-- empty in the common case (no restricted project, no leadership-only task), so the policies cost one indexed probe.

alter table pulse.project add column if not exists visibility text not null default 'org';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'project_visibility_check' and conrelid = 'pulse.project'::regclass) then
    alter table pulse.project add constraint project_visibility_check check (visibility in ('org', 'members', 'leadership'));
  end if;
end $$;
create index if not exists project_restricted on pulse.project (org_id) where visibility <> 'org';
alter table pulse.task add column if not exists leadership_only boolean not null default false;
create index if not exists task_leadership_only on pulse.task (org_id) where leadership_only;
create index if not exists task_owner_person on pulse.task (org_id, owner_id) where owner_id is not null;
create index if not exists task_created_person on pulse.task (org_id, created_by) where created_by is not null;

-- Who the viewer is, for these rules ----------------------------------------------------------------------------------
-- A seat from outside the staff: a freelancer, or a client of the organisation.
create or replace function pulse.viewer_outside_seat() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select p.side in ('freelancer', 'client') from person p where p.org_id = current_org() and p.id = current_viewer()), false)
$$;
-- On the project: a current member or watcher, its owner, its lead or whoever created it.
create or replace function pulse.project_on(p_project uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and p_project is not null and (
    exists (select 1 from project_member m where m.org_id = current_org() and m.project_id = p_project and m.person_id = current_viewer() and m.left_at is null)
    or exists (select 1 from work_project wp where wp.org_id = current_org() and wp.project_id = p_project and current_viewer() in (wp.owner_id, wp.created_by))
    or exists (select 1 from project pr where pr.org_id = current_org() and pr.id = p_project and pr.lead_person_id = current_viewer()))
$$;
-- The restricted projects this viewer may not see (not used for a freelancer or client, who see only project_mine()).
create or replace function pulse.project_hidden_ids() returns uuid[] language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(array_agg(pr.id), '{}') from project pr
   where pr.org_id = current_org() and pr.visibility <> 'org'
     and not (current_viewer() is not null and (viewer_is('admin') or (pr.visibility = 'leadership' and viewer_is('leadership')) or project_on(pr.id)))
$$;
-- The projects a freelancer or client is on.
create or replace function pulse.project_mine() returns uuid[] language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(array_agg(distinct x.id), '{}') from (
    select m.project_id id from project_member m where m.org_id = current_org() and m.person_id = current_viewer() and m.left_at is null
    union all select wp.project_id from work_project wp where wp.org_id = current_org() and current_viewer() in (wp.owner_id, wp.created_by)
    union all select pr.id from project pr where pr.org_id = current_org() and pr.lead_person_id = current_viewer()) x
  where current_viewer() is not null
$$;
-- Whether the viewer sees a project by these rules (one project; the policies use the sets above).
create or replace function pulse.project_sees(p_project uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select p_project is null or case when viewer_outside_seat() then p_project = any(project_mine()) else not (p_project = any(project_hidden_ids())) end
$$;
-- The tasks these rules hide from this viewer (not used for a freelancer): tasks of hidden projects and leadership-only
-- tasks, except the ones the viewer is on.
create or replace function pulse.task_hidden_ids() returns uuid[] language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v uuid := current_viewer(); hp uuid[] := project_hidden_ids(); lead boolean := v is not null and viewer_is('admin', 'leadership'); r uuid[];
begin
  if cardinality(hp) = 0 and (lead or not exists (select 1 from task where org_id = current_org() and leadership_only)) then return '{}'; end if;
  select coalesce(array_agg(distinct x.id), '{}') into r from (
    select t.id, t.owner_id, t.assignee_person_id, t.review_owner_id, t.created_by from task t where t.org_id = current_org() and t.project_id = any(hp)
    union all
    select t.id, t.owner_id, t.assignee_person_id, t.review_owner_id, t.created_by from task t where t.org_id = current_org() and t.leadership_only and not lead) x
  -- (coalesce: a task's empty roles are nulls, and "v in (…, null)" is null, not false)
  where v is null or not (coalesce(v in (x.owner_id, x.assignee_person_id, x.review_owner_id, x.created_by), false)
    or exists (select 1 from task_member m where m.org_id = current_org() and m.task_id = x.id and m.person_id = v and m.removed_at is null));
  return r;
end $$;
-- A freelancer's or client's tasks: theirs to do, review or follow, made by them, or asked of them.
create or replace function pulse.task_mine() returns uuid[] language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(array_agg(distinct x.id), '{}') from (
    select t.id from task t where t.org_id = current_org() and t.assignee_person_id = current_viewer()
    union all select t.id from task t where t.org_id = current_org() and t.owner_id = current_viewer()
    union all select t.id from task t where t.org_id = current_org() and t.review_owner_id = current_viewer()
    union all select t.id from task t where t.org_id = current_org() and t.created_by = current_viewer()
    union all select m.task_id from task_member m where m.org_id = current_org() and m.person_id = current_viewer() and m.removed_at is null
    union all select a.task_id from work_ask a where a.org_id = current_org() and a.to_id = current_viewer() and a.status = 'pending' and a.task_id is not null) x
  where current_viewer() is not null
$$;
create or replace function pulse.task_sees(p_task uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select p_task is null or case when viewer_outside_seat() then p_task = any(task_mine()) else not (p_task = any(task_hidden_ids())) end
$$;

-- The policies --------------------------------------------------------------------------------------------------------
-- (select …) makes each set an InitPlan: computed once per statement, only when a row needs it.
drop policy if exists privacy on pulse.project;
create policy privacy on pulse.project as restrictive for select to pulse_api using (
  case when (select pulse.viewer_outside_seat()) then id = any((select pulse.project_mine())::uuid[]) else not (id = any((select pulse.project_hidden_ids())::uuid[])) end);
drop policy if exists privacy on pulse.work_project;
create policy privacy on pulse.work_project as restrictive for select to pulse_api using (
  case when (select pulse.viewer_outside_seat()) then project_id = any((select pulse.project_mine())::uuid[]) else not (project_id = any((select pulse.project_hidden_ids())::uuid[])) end);
drop policy if exists privacy on pulse.project_member;
create policy privacy on pulse.project_member as restrictive for select to pulse_api using (
  case when (select pulse.viewer_outside_seat()) then project_id = any((select pulse.project_mine())::uuid[]) else not (project_id = any((select pulse.project_hidden_ids())::uuid[])) end);
drop policy if exists privacy on pulse.task;
create policy privacy on pulse.task as restrictive for select to pulse_api using (
  case when (select pulse.viewer_outside_seat()) then id = any((select pulse.task_mine())::uuid[]) else not (id = any((select pulse.task_hidden_ids())::uuid[])) end);
do $$ declare t text; begin
  -- Rows of one task: they follow the task.
  foreach t in array array['task_member', 'task_event', 'task_proof', 'task_attachment', 'task_check', 'task_link'] loop
    if to_regclass('pulse.' || t) is not null and exists (select 1 from information_schema.columns where table_schema = 'pulse' and table_name = t and column_name = 'task_id') then
      execute format('drop policy if exists privacy on pulse.%I', t);
      execute format('create policy privacy on pulse.%I as restrictive for select to pulse_api using (
        case when (select pulse.viewer_outside_seat()) then task_id = any((select pulse.task_mine())::uuid[]) else not (task_id = any((select pulse.task_hidden_ids())::uuid[])) end)', t);
    end if;
  end loop;
  -- Rows of one project (files and deliveries may have none: a freelancer sees none of those).
  foreach t in array array['index_file', 'delivery', 'chat_group_info', 'project_contact'] loop
    if to_regclass('pulse.' || t) is not null and exists (select 1 from information_schema.columns where table_schema = 'pulse' and table_name = t and column_name = 'project_id') then
      execute format('drop policy if exists privacy on pulse.%I', t);
      execute format('create policy privacy on pulse.%I as restrictive for select to pulse_api using (
        case when (select pulse.viewer_outside_seat()) then coalesce(project_id = any((select pulse.project_mine())::uuid[]), %L)
             else project_id is null or not (project_id = any((select pulse.project_hidden_ids())::uuid[])) end)', t, t = 'chat_group_info');
    end if;
  end loop;
end $$;
-- Discussion and asks: on a task or a project; the two people of an ask always see it.
drop policy if exists privacy on pulse.work_comment;
create policy privacy on pulse.work_comment as restrictive for select to pulse_api using (
  case when (select pulse.viewer_outside_seat())
       then coalesce(task_id = any((select pulse.task_mine())::uuid[]), project_id = any((select pulse.project_mine())::uuid[]), false)
       else (task_id is null or not (task_id = any((select pulse.task_hidden_ids())::uuid[]))) and (project_id is null or not (project_id = any((select pulse.project_hidden_ids())::uuid[]))) end);
drop policy if exists privacy on pulse.work_ask;
create policy privacy on pulse.work_ask as restrictive for select to pulse_api using (
  (select pulse.current_viewer()) in (from_id, to_id)
  or case when (select pulse.viewer_outside_seat())
       then coalesce(task_id = any((select pulse.task_mine())::uuid[]), project_id = any((select pulse.project_mine())::uuid[]), false)
       else (task_id is null or not (task_id = any((select pulse.task_hidden_ids())::uuid[]))) and (project_id is null or not (project_id = any((select pulse.project_hidden_ids())::uuid[]))) end);
-- Time: a person's own entries always; others' follow their task and project.
drop policy if exists privacy on pulse.time_entry;
create policy privacy on pulse.time_entry as restrictive for select to pulse_api using (
  person_id = (select pulse.current_viewer())
  or (not (select pulse.viewer_outside_seat())
      and (task_id is null or not (task_id = any((select pulse.task_hidden_ids())::uuid[])))
      and (project_id is null or not (project_id = any((select pulse.project_hidden_ids())::uuid[])))));

-- The definer reads used by the task screens follow the same rules: a hidden task is not visible, so it cannot be
-- opened, commented on or followed through them either.
create or replace function pulse.task_visible(p_id uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from task t where t.org_id = current_org() and t.id = p_id and t.deleted_at is null
    and task_visible_row(t.id, t.owner_id, t.assignee_person_id, t.review_owner_id, t.created_by, t.project_id, t.parent_id))
    and task_sees(p_id)
$$;

-- Who may change it -------------------------------------------------------------------------------------------------
-- Project: whoever manages it (owner, head of its pod, leadership); leadership-only is set and lifted by leadership and
-- admins. Someone who makes a project members-only joins it, so they keep seeing it.
create or replace function pulse.project_visibility_set(p_project uuid, p_visibility text) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); old text;
begin
  if me is null then raise exception 'Sign in to change who sees a project' using errcode = '42501'; end if;
  if p_visibility is null or p_visibility not in ('org', 'members', 'leadership') then raise exception 'Choose who sees the project: everyone, its members or leadership' using errcode = '22023'; end if;
  select visibility into old from project where org_id = current_org() and id = p_project and deleted_at is null for update;
  if not found or not project_sees(p_project) then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if not (viewer_is('admin', 'leadership') or work_project_can_manage(p_project)) then
    raise exception 'Only the project owner, the head of its pod or leadership can change who sees it' using errcode = '42501'; end if;
  if (p_visibility = 'leadership' or old = 'leadership') and not viewer_is('admin', 'leadership') then
    raise exception 'Only leadership can make a project leadership-only, or open it again' using errcode = '42501'; end if;
  if old is distinct from p_visibility then
    if p_visibility = 'members' and not viewer_is('admin') and not project_on(p_project) then
      insert into project_member (org_id, project_id, person_id, role, added_by) values (current_org(), p_project, me, 'member', me) on conflict do nothing;
    end if;
    update project set visibility = p_visibility, updated_at = now() where org_id = current_org() and id = p_project;
    insert into record_change (org_id, entity_type, entity_id, field, old_value, new_value, changed_by) values (current_org(), 'project', p_project, 'visibility', old, p_visibility, me);
    perform audit_write('project_visibility', 'project', p_project::text);
  end if;
  return jsonb_build_object('visibility', p_visibility);
end $$;
-- Task: leadership and admins.
create or replace function pulse.task_leadership_only_set(p_task uuid, p_on boolean) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); old boolean;
begin
  if me is null or not viewer_is('admin', 'leadership') then raise exception 'Only leadership can make a task leadership-only' using errcode = '42501'; end if;
  select leadership_only into old from task where org_id = current_org() and id = p_task and deleted_at is null for update;
  if not found or not task_sees(p_task) then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if old is distinct from coalesce(p_on, false) then
    update task set leadership_only = coalesce(p_on, false), updated_at = now() where org_id = current_org() and id = p_task;
    perform audit_write(case when p_on then 'task_leadership_only' else 'task_open_to_team' end, 'task', p_task::text);
  end if;
  return jsonb_build_object('leadershipOnly', coalesce(p_on, false));
end $$;

-- Sales (owner: "sales reps see only their own leads, calls and follow-ups; their manager and leadership see them; team
-- boards show totals only"). Sales X-Ray's copies in Pulse follow the rep: the lead copy by its Sales X-Ray owner's name
-- (the copy carries no person id), the linked call and the activity signals by person. Totals for the team come from
-- sales_xray_stage_totals() (a definer read of counts, no rows). A request with no person (a connected app's key, the
-- sync) reads them as before.
-- The viewer and the people they manage: as their direct manager, or as manager / PGS of their pod (not HR's reach).
create or replace function pulse.sales_team_ids() returns uuid[] language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(array_agg(p.id), '{}') from person p
   where p.org_id = current_org() and current_viewer() is not null
     and (p.id = current_viewer()
       or exists (select 1 from people_profile pp where pp.org_id = current_org() and pp.person_id = p.id and pp.manager_id = current_viewer())
       or exists (select 1 from people_profile pp join unit u on u.org_id = pp.org_id and u.kind = 'pod' and u.name = pp.pod
           join role_assignment r on r.org_id = u.org_id and r.unit_id = u.id and r.person_id = current_viewer()
            and (r.is_manager_of_unit or r.role_key in ('manager', 'pgs', 'head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')
          where pp.org_id = current_org() and pp.person_id = p.id))
$$;
create or replace function pulse.sales_owner_names() returns text[] language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(array_agg(distinct lower(btrim(p.display_name))), '{}') from person p where p.org_id = current_org() and p.id = any(sales_team_ids()) and p.display_name is not null
$$;
create or replace function pulse.sales_xray_stage_totals() returns table (stage text, n int, linked int) language sql stable security definer set search_path = pulse, pg_temp as $$
  select l.stage, count(*)::int, count(l.client_id)::int from sales_xray_lead l where l.org_id = current_org() and l.gone_at is null and current_viewer() is not null group by 1 order by 2 desc
$$;
do $$ begin
  if to_regclass('pulse.sales_xray_lead') is not null then
    drop policy if exists privacy on pulse.sales_xray_lead;
    create policy privacy on pulse.sales_xray_lead as restrictive for select to pulse_api using (
      (select pulse.current_viewer()) is null or (select pulse.viewer_is('admin', 'leadership')) or lower(btrim(owner_name)) = any((select pulse.sales_owner_names())::text[]));
  end if;
  if to_regclass('pulse.sales_xray_call') is not null then
    drop policy if exists privacy on pulse.sales_xray_call;
    create policy privacy on pulse.sales_xray_call as restrictive for select to pulse_api using (
      (select pulse.current_viewer()) is null or linked_by = (select pulse.current_viewer()) or (select pulse.viewer_is('admin', 'leadership')) or person_id = any((select pulse.sales_team_ids())::uuid[]));
  end if;
  if to_regclass('pulse.connect_signal') is not null then
    drop policy if exists privacy on pulse.connect_signal;
    create policy privacy on pulse.connect_signal as restrictive for select to pulse_api using (
      (select pulse.current_viewer()) is null or (select pulse.viewer_is('admin', 'leadership')) or person_id = any((select pulse.sales_team_ids())::uuid[]));
  end if;
end $$;

revoke all on function pulse.sales_team_ids(), pulse.sales_owner_names(), pulse.sales_xray_stage_totals() from public;
grant execute on function pulse.sales_team_ids(), pulse.sales_owner_names(), pulse.sales_xray_stage_totals() to pulse_api;
revoke all on function pulse.viewer_outside_seat(), pulse.project_on(uuid), pulse.project_hidden_ids(), pulse.project_mine(), pulse.project_sees(uuid),
  pulse.task_hidden_ids(), pulse.task_mine(), pulse.task_sees(uuid), pulse.project_visibility_set(uuid, text), pulse.task_leadership_only_set(uuid, boolean) from public;
grant execute on function pulse.viewer_outside_seat(), pulse.project_on(uuid), pulse.project_hidden_ids(), pulse.project_mine(), pulse.project_sees(uuid),
  pulse.task_hidden_ids(), pulse.task_mine(), pulse.task_sees(uuid), pulse.project_visibility_set(uuid, text), pulse.task_leadership_only_set(uuid, boolean) to pulse_api;

-- migrate:down
do $$ declare t text; begin
  foreach t in array array['project', 'work_project', 'project_member', 'task', 'task_member', 'task_event', 'task_proof', 'task_attachment', 'task_check', 'task_link',
    'index_file', 'delivery', 'chat_group_info', 'project_contact', 'work_comment', 'work_ask', 'time_entry',
    'sales_xray_lead', 'sales_xray_call', 'connect_signal'] loop
    if to_regclass('pulse.' || t) is not null then execute format('drop policy if exists privacy on pulse.%I', t); end if;
  end loop;
end $$;
create or replace function pulse.task_visible(p_id uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from task t where t.org_id = current_org() and t.id = p_id and t.deleted_at is null
    and task_visible_row(t.id, t.owner_id, t.assignee_person_id, t.review_owner_id, t.created_by, t.project_id, t.parent_id))
$$;
drop function if exists pulse.sales_xray_stage_totals();
drop function if exists pulse.sales_owner_names();
drop function if exists pulse.sales_team_ids();
drop function if exists pulse.project_visibility_set(uuid, text);
drop function if exists pulse.task_leadership_only_set(uuid, boolean);
drop function if exists pulse.task_sees(uuid);
drop function if exists pulse.task_mine();
drop function if exists pulse.task_hidden_ids();
drop function if exists pulse.project_sees(uuid);
drop function if exists pulse.project_mine();
drop function if exists pulse.project_hidden_ids();
drop function if exists pulse.project_on(uuid);
drop function if exists pulse.viewer_outside_seat();
drop index if exists pulse.task_created_person;
drop index if exists pulse.task_owner_person;
drop index if exists pulse.task_leadership_only;
alter table pulse.task drop column if exists leadership_only;
drop index if exists pulse.project_restricted;
alter table pulse.project drop constraint if exists project_visibility_check;
alter table pulse.project drop column if exists visibility;
