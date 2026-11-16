-- migrate:up
-- BLOCKERS-MAP (owner, 7 Nov 2026: "dependencies must work across tasks, projects and goals: any of them can block any
-- other"). Until now only a task could wait on a task (pulse.task_link, 0141); a project or a goal could neither wait on
-- nor block anything, so "the Apple account waits on the company registration project" or "this goal waits on that
-- task" had nowhere to live. pulse.work_dependency holds every link that has a project or a goal at either end. A task
-- waiting on a task stays in pulse.task_link, because the task flow (blocked status, nudges, unlocks) is built on it; the
-- dependency map reads both. Rows change only through the two functions below (no insert or update grant).
create table pulse.work_dependency (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  waiter_kind text not null check (waiter_kind in ('task', 'project', 'goal')),   -- the work that waits
  waiter_id uuid not null,
  blocker_kind text not null check (blocker_kind in ('task', 'project', 'goal')), -- the work it waits on
  blocker_id uuid not null,
  note text check (length(note) <= 300),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by uuid references pulse.person(id),
  constraint work_dependency_not_self check (waiter_id <> blocker_id),
  constraint work_dependency_not_task_pair check (not (waiter_kind = 'task' and blocker_kind = 'task'))
);
create unique index work_dependency_open on pulse.work_dependency(org_id, waiter_kind, waiter_id, blocker_kind, blocker_id) where cleared_at is null;
create index work_dependency_by_waiter on pulse.work_dependency(org_id, waiter_id) where cleared_at is null;
create index work_dependency_by_blocker on pulse.work_dependency(org_id, blocker_id) where cleared_at is null;

-- Whether a piece of work exists in the viewer's company and the viewer may see it (the tables' own read rules decide:
-- security invoker, so row security applies).
create function pulse.work_item_visible(p_kind text, p_id uuid) returns boolean
 language sql stable security invoker set search_path=pulse,pg_temp as $$
 select case p_kind
   when 'task' then exists(select 1 from task t where t.id = p_id and t.status <> 'cancelled')
   when 'project' then exists(select 1 from project p where p.id = p_id)
   when 'goal' then exists(select 1 from goal g where g.id = p_id)
   else false end
$$;

-- Whether the viewer may make this piece of work wait on something (the same people who may change it).
create function pulse.work_item_can_edit(p_kind text, p_id uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and case p_kind
   when 'task' then coalesce(task_can_edit(p_id), false)
   when 'project' then exists(select 1 from project p where p.org_id = current_org() and p.id = p_id)
     and (viewer_is('admin', 'leadership') or coalesce(work_project_can_manage(p_id), false))
   when 'goal' then goal_id_can_edit(p_id)
   else false end
$$;

alter table pulse.work_dependency enable row level security;
alter table pulse.work_dependency force row level security;
create policy tenant_isolation on pulse.work_dependency using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- A link is seen when the viewer may see both ends.
create policy work_dependency_see on pulse.work_dependency as restrictive for select to pulse_api
  using (pulse.work_item_visible(waiter_kind, waiter_id) and pulse.work_item_visible(blocker_kind, blocker_id));
grant select on pulse.work_dependency to pulse_api;

-- Make one piece of work wait on another. The caller (services/api/src/dependencies.ts) has already checked, as the
-- viewer, that both ends are visible; here: the ends exist in this company, the viewer may change the waiting one, and
-- the link closes no loop through task links or other dependencies. A task waiting on a task goes to task_block.
create function pulse.work_dependency_add(p_waiter_kind text, p_waiter uuid, p_blocker_kind text, p_blocker uuid, p_note text default null)
 returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); lid uuid;
begin
 if me is null then raise exception 'Sign in to link work' using errcode = '42501'; end if;
 if p_waiter_kind not in ('task', 'project', 'goal') or p_blocker_kind not in ('task', 'project', 'goal') then
  raise exception 'Choose a task, a project or a goal' using errcode = '22023'; end if;
 if p_waiter_kind = 'task' and p_blocker_kind = 'task' then return task_block(p_waiter, p_blocker, p_note); end if;
 if p_waiter = p_blocker then raise exception 'Work cannot wait on itself' using errcode = '22023'; end if;
 if not (case p_waiter_kind when 'task' then exists(select 1 from task where org_id = current_org() and id = p_waiter)
     when 'project' then exists(select 1 from project where org_id = current_org() and id = p_waiter)
     else exists(select 1 from goal where org_id = current_org() and id = p_waiter) end)
  or not (case p_blocker_kind when 'task' then exists(select 1 from task where org_id = current_org() and id = p_blocker)
     when 'project' then exists(select 1 from project where org_id = current_org() and id = p_blocker)
     else exists(select 1 from goal where org_id = current_org() and id = p_blocker) end)
 then raise exception 'Choose work from this company' using errcode = '22023'; end if;
 if not work_item_can_edit(p_waiter_kind, p_waiter) then
  raise exception 'Only someone who may change this work can make it wait on something' using errcode = '42501'; end if;
 -- No loop: walk what the blocker waits on (both kinds of link) and refuse if the waiting work is on that chain.
 if exists(with recursive chain(kind, id, depth) as (
     select p_blocker_kind, p_blocker, 1
     union
     select e.bk, e.bid, c.depth + 1 from chain c join (
       select 'task'::text wk, l.task_id wid, 'task'::text bk, l.blocker_id bid from task_link l where l.org_id = current_org() and l.cleared_at is null
       union all select d.waiter_kind, d.waiter_id, d.blocker_kind, d.blocker_id from work_dependency d where d.org_id = current_org() and d.cleared_at is null
     ) e on e.wk = c.kind and e.wid = c.id where c.depth < 200)
   select 1 from chain where kind = p_waiter_kind and id = p_waiter)
 then raise exception 'That would make the two wait on each other' using errcode = '22023'; end if;
 insert into work_dependency(org_id, waiter_kind, waiter_id, blocker_kind, blocker_id, note, created_by)
 values (current_org(), p_waiter_kind, p_waiter, p_blocker_kind, p_blocker, nullif(btrim(coalesce(p_note, '')), ''), me)
 on conflict (org_id, waiter_kind, waiter_id, blocker_kind, blocker_id) where cleared_at is null do nothing returning id into lid;
 if lid is null then raise exception 'This already waits on that' using errcode = '23505'; end if;
 return lid;
end $$;

-- Take a link off: whoever may change the waiting work, or whoever made the link.
create function pulse.work_dependency_clear(p_id uuid) returns boolean
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); d work_dependency;
begin
 if me is null then raise exception 'Sign in to change links' using errcode = '42501'; end if;
 select * into d from work_dependency where org_id = current_org() and id = p_id and cleared_at is null;
 if not found then raise exception 'That link is gone already' using errcode = '22023'; end if;
 if d.created_by is distinct from me and not work_item_can_edit(d.waiter_kind, d.waiter_id) then
  raise exception 'Only someone who may change this work can take the link off' using errcode = '42501'; end if;
 update work_dependency set cleared_at = now(), cleared_by = me where id = p_id;
 return true;
end $$;

revoke all on function pulse.work_dependency_add(text, uuid, text, uuid, text) from public;
revoke all on function pulse.work_dependency_clear(uuid) from public;
revoke all on function pulse.work_item_can_edit(text, uuid) from public;
grant execute on function pulse.work_dependency_add(text, uuid, text, uuid, text) to pulse_api;
grant execute on function pulse.work_dependency_clear(uuid) to pulse_api;
grant execute on function pulse.work_item_can_edit(text, uuid) to pulse_api;
grant execute on function pulse.work_item_visible(text, uuid) to pulse_api;

-- migrate:down
drop function if exists pulse.work_dependency_clear(uuid);
drop function if exists pulse.work_dependency_add(text, uuid, text, uuid, text);
drop table if exists pulse.work_dependency;
drop function if exists pulse.work_item_can_edit(text, uuid);
drop function if exists pulse.work_item_visible(text, uuid);
