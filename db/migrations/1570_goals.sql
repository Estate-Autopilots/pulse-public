-- migrate:up
-- FOUNDATIONS (owner, 6 Nov 2026; Ditasu asked for it first): goals. A long-term goal for a person, a team or the
-- company, made of projects and tasks, with a target date and, when it has one, a measurable target ("Sign 12 new
-- clients", from 0 to 12). Progress rolls up from what it holds (docs/spec/FOUNDATIONS.md, "Goals"):
--   * with a measurable target, progress is how far the current value has moved from the start towards the target;
--   * otherwise it is the work: done tasks (linked tasks and the tasks of linked projects) and sub-goals' progress.
-- Who sees and changes a goal is decided here, under forced row security:
--   * company goals: every staff member reads them; leadership and admins set and change them;
--   * team goals: every staff member reads them; leadership, admins and the team's head or managers change them;
--   * a person's goals: the person, whoever set it, the people who manage them, HR, leadership and admins read them;
--     the person, their managers, leadership and admins change them.
-- Clients and freelancers never see goals. Goals are dropped (status), never deleted, so history stays.

create table pulse.goal (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  level text not null check (level in ('person', 'team', 'company')),
  title text not null check (length(btrim(title)) between 1 and 160 and title !~ '[[:cntrl:]]'),
  why text check (length(why) <= 2000),
  owner_person_id uuid references pulse.person(id),
  unit_id uuid references pulse.unit(id),
  parent_id uuid references pulse.goal(id),
  target_on date,
  measure_label text check (length(btrim(measure_label)) between 1 and 60 and measure_label !~ '[[:cntrl:]]'),
  start_value numeric(16,2),
  target_value numeric(16,2),
  current_value numeric(16,2),
  status text not null default 'active' check (status in ('active', 'done', 'dropped')),
  created_by uuid not null references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz,
  constraint goal_person_owner check (level <> 'person' or owner_person_id is not null),
  constraint goal_team_unit check ((level = 'team') = (unit_id is not null)),
  constraint goal_not_own_parent check (parent_id is null or parent_id <> id),
  constraint goal_measure check (target_value is null or (measure_label is not null and target_value <> coalesce(start_value, 0)))
);
create index goal_org_level on pulse.goal(org_id, level, status);
create index goal_owner on pulse.goal(org_id, owner_person_id) where owner_person_id is not null;
create index goal_parent on pulse.goal(org_id, parent_id) where parent_id is not null;

-- What a goal holds: one project or one task per row.
create table pulse.goal_link (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  goal_id uuid not null references pulse.goal(id),
  project_id uuid references pulse.project(id),
  task_id uuid references pulse.task(id),
  added_by uuid not null references pulse.person(id),
  added_at timestamptz not null default now(),
  constraint goal_link_one check (num_nonnulls(project_id, task_id) = 1)
);
create unique index goal_link_project on pulse.goal_link(goal_id, project_id) where project_id is not null;
create unique index goal_link_task on pulse.goal_link(goal_id, task_id) where task_id is not null;
create index goal_link_by_task on pulse.goal_link(org_id, task_id) where task_id is not null;
create index goal_link_by_project on pulse.goal_link(org_id, project_id) where project_id is not null;

-- ------------------------------------------------------------------------------------------------ who may
create function pulse.goal_can_see(p_level text, p_owner uuid, p_created_by uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and not viewer_outside_seat()
   and exists(select 1 from person p where p.org_id = current_org() and p.id = current_viewer() and p.side in ('staff', 'agent'))
   and (p_level <> 'person' or p_owner = current_viewer() or p_created_by = current_viewer()
     or viewer_is('admin', 'leadership', 'hr') or manages(p_owner))
$$;

create function pulse.goal_can_edit(p_level text, p_owner uuid, p_unit uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and not viewer_outside_seat()
   and exists(select 1 from person p where p.org_id = current_org() and p.id = current_viewer() and p.side in ('staff', 'agent') and p.status = 'active')
   and (viewer_is('admin', 'leadership')
     or (p_level = 'person' and (p_owner = current_viewer() or manages(p_owner)))
     or (p_level = 'team' and (exists(select 1 from unit u where u.org_id = current_org() and u.id = p_unit and u.head_person_id = current_viewer())
       or exists(select 1 from role_assignment r where r.org_id = current_org() and r.person_id = current_viewer() and r.unit_id = p_unit
         and r.is_manager_of_unit and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')))))
$$;

-- A link may be added or removed by whoever may change its goal (looked up past the viewer's own read rules).
create function pulse.goal_id_can_edit(p_goal uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select goal_can_edit(g.level, g.owner_person_id, g.unit_id) from goal g where g.org_id = current_org() and g.id = p_goal), false)
$$;

-- No loops in the goal tree, and a sub-goal stays in its parent's company (the foreign key) and is visible to the setter.
create function pulse.goal_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare hops int := 0; cur uuid := new.parent_id;
begin
 new.updated_at := now();
 if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then new.done_at := now(); end if;
 if new.status <> 'done' then new.done_at := null; end if;
 while cur is not null loop
  if cur = new.id then raise exception 'A goal cannot sit under itself' using errcode = '22023'; end if;
  hops := hops + 1;
  if hops > 8 then raise exception 'Goals nest at most 8 deep' using errcode = '22023'; end if;
  select parent_id into cur from goal where org_id = new.org_id and id = cur;
 end loop;
 return new;
end $$;
create trigger goal_guard before insert or update on pulse.goal for each row execute function pulse.goal_guard();

-- ------------------------------------------------------------------------------------------------ row security
alter table pulse.goal enable row level security;
alter table pulse.goal force row level security;
create policy tenant_isolation on pulse.goal using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy goal_see on pulse.goal as restrictive for select to pulse_api using (pulse.goal_can_see(level, owner_person_id, created_by));
create policy goal_insert on pulse.goal as restrictive for insert to pulse_api
  with check (created_by = pulse.current_viewer() and pulse.goal_can_edit(level, owner_person_id, unit_id));
create policy goal_update on pulse.goal as restrictive for update to pulse_api
  using (pulse.goal_can_edit(level, owner_person_id, unit_id)) with check (pulse.goal_can_edit(level, owner_person_id, unit_id));

alter table pulse.goal_link enable row level security;
alter table pulse.goal_link force row level security;
create policy tenant_isolation on pulse.goal_link using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- A link is seen with its goal; added only to a goal you may change, and only for work you can see yourself.
create policy goal_link_see on pulse.goal_link as restrictive for select to pulse_api
  using (exists(select 1 from pulse.goal g where g.id = goal_id));
create policy goal_link_insert on pulse.goal_link as restrictive for insert to pulse_api
  with check (added_by = pulse.current_viewer() and pulse.goal_id_can_edit(goal_id)
    and (task_id is null or exists(select 1 from pulse.task t where t.id = task_id))
    and (project_id is null or exists(select 1 from pulse.project p where p.id = project_id)));
create policy goal_link_delete on pulse.goal_link as restrictive for delete to pulse_api using (pulse.goal_id_can_edit(goal_id));

grant select, insert, update (title, why, owner_person_id, unit_id, parent_id, target_on, measure_label, start_value, target_value,
  current_value, status, updated_at, done_at) on pulse.goal to pulse_api;
grant select, insert, delete on pulse.goal_link to pulse_api;

-- ------------------------------------------------------------------------------------------------ roll-up
-- Progress 0..1 as the viewer sees it (counts only the work the viewer may see, under the tables' own row security).
create function pulse.goal_progress(p_goal uuid, p_depth int default 0) returns jsonb
 language plpgsql stable security invoker set search_path=pulse,pg_temp as $$
declare g goal; total int := 0; done int := 0; projects int := 0; kids int := 0; kid_sum numeric := 0; measure numeric; work numeric; p numeric;
 k record; today date := (now() at time zone org_time_zone())::date;
begin
 select * into g from goal where id = p_goal;
 if not found then return null; end if;
 select count(*) filter (where project_id is not null) into projects from goal_link where goal_id = p_goal;
 select count(*), count(*) filter (where t.status in ('done', 'accepted')) into total, done
   from task t where t.status <> 'cancelled' and t.id in (
     select l.task_id from goal_link l where l.goal_id = p_goal and l.task_id is not null
     union select t2.id from task t2 join goal_link l on l.project_id = t2.project_id where l.goal_id = p_goal);
 if p_depth < 8 then
  for k in select c.id from goal c where c.parent_id = p_goal and c.status <> 'dropped' loop
   kids := kids + 1; kid_sum := kid_sum + coalesce((goal_progress(k.id, p_depth + 1) ->> 'progress')::numeric, 0);
  end loop;
 end if;
 if g.target_value is not null then
  measure := greatest(0, least(1, (coalesce(g.current_value, coalesce(g.start_value, 0)) - coalesce(g.start_value, 0)) / (g.target_value - coalesce(g.start_value, 0))));
 end if;
 if total + kids > 0 then work := (done + kid_sum) / (total + kids); end if;
 p := case when g.status = 'done' then 1 else coalesce(measure, work, 0) end;
 return jsonb_build_object('progress', round(p, 4), 'measure', round(measure, 4), 'work', round(work, 4), 'tasks', total, 'tasksDone', done,
   'projects', projects, 'subGoals', kids, 'late', g.status = 'active' and g.target_on is not null and g.target_on < today and p < 1,
   'basis', case when g.status = 'done' then 'done' when measure is not null then 'measure' when work is not null then 'work' else 'none' end);
end $$;
grant execute on function pulse.goal_progress(uuid, int) to pulse_api;

-- Writes through API v1 land in the undo ledger's list (logged; goals are changed back by editing them).
alter table pulse_priv.app_change drop constraint app_change_action_check;
alter table pulse_priv.app_change add constraint app_change_action_check check (action in (
  'profile.correct', 'password.issue', 'invite.send', 'chat.group.create', 'chat.members', 'feedback.status',
  'task.create', 'task.assign', 'task.update', 'task.complete', 'comment.add', 'project.create', 'stage.owner', 'stage.task',
  'chat.message', 'client.create', 'catalog.item.create', 'stock.move', 'quotation.create', 'quotation.revise', 'quotation.submit',
  'quotation.approve', 'quotation.send', 'invoice.create', 'invoice.issue', 'payment.record',
  'project.update', 'project.delete', 'expense.create', 'leave.request',
  'goal.create', 'goal.update', 'goal.link', 'goal.unlink'));

-- migrate:down
-- Forward-only.
