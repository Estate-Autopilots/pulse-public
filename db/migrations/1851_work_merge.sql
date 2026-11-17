-- migrate:up
-- TASK-MERGE (owner, 7 Nov 2026: "merge clutter into clarity"). Several tasks become ONE task (or one brief: a task whose
-- notes list the originals as steps), keeping their lineage. The originals are never deleted: each is closed as
-- "Merged into <the new one>" (status cancelled, closed_as 'merged', so every rule that already treats Cancelled as closed
-- (blockers, notifications, flows, lists) keeps working), keeps its own history, comments and files, and points at the
-- merge. What waited on an original now waits on the merged task; its proof, ticked steps, subtasks and goal links move.
-- The pairwise merge of 0162 (task_merge) stays for the task page's "Merge into this…".
--
-- pulse.work_merge        one merge: what it made (kind + target), why, who, when, and whether it was undone.
-- pulse.work_merge_source each original as it was at the merge (title, status, owner, project, due day, what moved).
-- pulse.merge_suggestion  the merge suggester's proposals for one person's tasks (duplicates and clusters), accepted or
--                         rejected by a person; a rejected set is never proposed again.
-- Rows change only through the functions below (no insert or update grant).

-- closed_as: 'merged' joins 'not_applicable' (1684).
do $$
declare c text;
begin
 for c in select conname from pg_constraint where conrelid = 'pulse.task'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%closed_as%' loop
  execute format('alter table pulse.task drop constraint %I', c);
 end loop;
end $$;
alter table pulse.task add constraint task_closed_as_check check (closed_as in ('not_applicable', 'merged'));
comment on column pulse.task.closed_as is 'Why a cancelled task was closed: not_applicable (the task did not apply) or merged (it became part of another task: pulse.work_merge_source). Cleared whenever the status leaves cancelled.';

create table pulse.work_merge (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('task', 'project', 'goal')),     -- what was merged (tasks today; the columns allow more)
  target_id uuid not null,                                            -- the one piece of work they became
  made_new boolean not null default false,                            -- the target was made by this merge
  shape text not null default 'task' check (shape in ('task', 'brief')),
  title text not null check (length(btrim(title)) between 1 and 300), -- the target's title at the merge
  reason text check (length(reason) <= 2000),                         -- why, in the person's words (or the suggester's)
  method text not null default 'by_hand' check (method in ('by_hand', 'suggested')),
  suggestion_id uuid,
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references pulse.person(id)
);
create index work_merge_target on pulse.work_merge(org_id, target_id);

create table pulse.work_merge_source (
  org_id uuid not null references pulse.org(id),
  merge_id uuid not null references pulse.work_merge(id),
  kind text not null check (kind in ('task', 'project', 'goal')),
  source_id uuid not null,
  position smallint not null default 0,
  title text not null check (length(title) <= 600),
  status_before text not null check (length(status_before) <= 40),
  person_id uuid references pulse.person(id),                         -- who had it
  project_id uuid,
  due_on date,
  moved jsonb not null default '{}',                                  -- what moved to the target: links, proof, steps, subtasks, goals
  primary key (merge_id, source_id)
);
create index work_merge_source_by on pulse.work_merge_source(org_id, source_id);

create table pulse.merge_suggestion (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references pulse.person(id),                -- whose tasks
  kind text not null check (kind in ('duplicate', 'cluster')),
  task_ids uuid[] not null check (cardinality(task_ids) between 2 and 30),
  key text not null check (length(key) = 32),                         -- md5 of the sorted task ids: one proposal per set, ever
  score numeric(4, 3) not null check (score between 0 and 1),
  method text not null check (method in ('words', 'embedding', 'model')),
  title text not null check (length(btrim(title)) between 1 and 300),
  reason text check (length(reason) <= 1000),
  shape text not null default 'task' check (shape in ('task', 'brief')),
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'stale')),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  merge_id uuid references pulse.work_merge(id)
);
create unique index merge_suggestion_once on pulse.merge_suggestion(org_id, key);
create index merge_suggestion_person on pulse.merge_suggestion(org_id, person_id, status);

-- Whether the viewer may see a piece of work (read as the viewer: the tables' own read rules decide).
create function pulse.merge_item_visible(p_kind text, p_id uuid) returns boolean
 language sql stable security invoker set search_path=pulse,pg_temp as $$
 select case p_kind
   when 'task' then exists(select 1 from task t where t.id = p_id)
   when 'project' then exists(select 1 from project p where p.id = p_id)
   when 'goal' then exists(select 1 from goal g where g.id = p_id)
   else false end
$$;
-- Whether the viewer looks after this person's tasks: themselves, their manager, HR, leadership or an admin.
create function pulse.merge_person_in_reach(p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (current_viewer() = p_person or viewer_is('admin', 'leadership', 'hr') or coalesce(manages(p_person), false))
$$;

do $$
declare t text;
begin
 foreach t in array array['work_merge', 'work_merge_source', 'merge_suggestion'] loop
  execute format('alter table pulse.%I enable row level security', t);
  execute format('alter table pulse.%I force row level security', t);
  execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('grant select on pulse.%I to pulse_api', t);
 end loop;
end $$;
-- A merge is seen by whoever may see what it made; an original's row by whoever may see the original or the merge.
create policy work_merge_see on pulse.work_merge as restrictive for select to pulse_api using (pulse.merge_item_visible(kind, target_id));
create policy work_merge_source_see on pulse.work_merge_source as restrictive for select to pulse_api
  using (pulse.merge_item_visible(kind, source_id) or exists(select 1 from pulse.work_merge m where m.id = merge_id));
-- Suggestions: the person, their manager, HR, leadership and admins.
create policy merge_suggestion_see on pulse.merge_suggestion as restrictive for select to pulse_api using (pulse.merge_person_in_reach(person_id));

-- Keep the suggester's proposals for one person. p_rows: [{kind, taskIds, score, method, title, reason, shape}]. A set
-- proposed before keeps its decision (accepted or rejected sets are never reopened); open proposals of this person that
-- the new scan no longer finds become stale. Returns how many are open now.
create function pulse.merge_suggestion_save(p_person uuid, p_rows jsonb) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); r jsonb; ids uuid[]; k text; keys text[] := '{}'; n int;
begin
 if me is null then raise exception 'Sign in to look for merges' using errcode = '42501'; end if;
 if not merge_person_in_reach(p_person) then raise exception 'Only the person, their manager, HR or leadership look at their tasks' using errcode = '42501'; end if;
 if jsonb_typeof(coalesce(p_rows, '[]')) <> 'array' or jsonb_array_length(coalesce(p_rows, '[]')) > 200 then raise exception 'Too many proposals' using errcode = '22023'; end if;
 for r in select * from jsonb_array_elements(coalesce(p_rows, '[]')) loop
  ids := array(select distinct x::uuid from jsonb_array_elements_text(r->'taskIds') x order by 1);
  if cardinality(ids) < 2 or cardinality(ids) > 30 then continue; end if;
  -- Every task is this person's, open, in this company.
  if (select count(*) from task t where t.org_id = current_org() and t.id = any(ids) and coalesce(t.assignee_person_id, t.owner_id) = p_person
      and t.status in ('open', 'in_progress', 'blocked', 'unknown') and t.deleted_at is null) <> cardinality(ids) then continue; end if;
  k := md5(array_to_string(ids, ','));
  keys := keys || k;
  insert into merge_suggestion(org_id, person_id, kind, task_ids, key, score, method, title, reason, shape, created_by)
  values (current_org(), p_person, case when r->>'kind' = 'duplicate' then 'duplicate' else 'cluster' end, ids, k,
          least(1, greatest(0, coalesce((r->>'score')::numeric, 0))), case when r->>'method' in ('embedding', 'model') then r->>'method' else 'words' end,
          left(coalesce(nullif(btrim(r->>'title'), ''), 'Merged work'), 300), left(r->>'reason', 1000),
          case when r->>'shape' = 'brief' then 'brief' else 'task' end, me)
  on conflict (org_id, key) do update set score = excluded.score, method = excluded.method, title = excluded.title, reason = excluded.reason,
    shape = excluded.shape, status = 'open', decided_by = null, decided_at = null
   where merge_suggestion.status in ('open', 'stale');
 end loop;
 update merge_suggestion set status = 'stale' where org_id = current_org() and person_id = p_person and status = 'open' and not (key = any(keys));
 select count(*) into n from merge_suggestion where org_id = current_org() and person_id = p_person and status = 'open';
 return n;
end $$;

-- Say no to a proposal: it is never proposed again (the same set of tasks).
create function pulse.merge_suggestion_reject(p_id uuid) returns boolean
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); s merge_suggestion;
begin
 if me is null then raise exception 'Sign in to decide' using errcode = '42501'; end if;
 select * into s from merge_suggestion where org_id = current_org() and id = p_id;
 if not found or not merge_person_in_reach(s.person_id) then raise exception 'Suggestion not found' using errcode = 'P0002'; end if;
 if s.status not in ('open', 'stale') then raise exception 'This was decided already' using errcode = '22023'; end if;
 update merge_suggestion set status = 'rejected', decided_by = me, decided_at = now() where id = p_id;
 -- Two tasks said to be different stay apart on the task page too (0162's "Not the same").
 if cardinality(s.task_ids) = 2 then
  insert into task_same(org_id, task_a, task_b, state, decided_by) values (current_org(), s.task_ids[1], s.task_ids[2], 'dismissed', me)
  on conflict (org_id, task_a, task_b) do update set state = 'dismissed', decided_by = me, decided_at = now() where task_same.state not in ('merged', 'linked');
 end if;
 return true;
end $$;

-- Merge tasks into one. p_target is the task they become (made just before by the API as the viewer when p_made_new, or
-- one of the viewer's existing tasks). The viewer must be able to change every task; accepted, cancelled and deleted work
-- is never merged away. Returns the merge's id.
create function pulse.work_merge_tasks(p_target uuid, p_sources uuid[], p_reason text, p_shape text, p_made_new boolean, p_suggestion uuid default null)
 returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := task_require_viewer(); k task; g task; mid uuid; srcs uuid[]; s uuid; pos int := 0;
  n_links int; n_proof int; n_checks int; n_subs int; n_goals int; n int; total int := 0;
begin
 srcs := array(select distinct x from unnest(p_sources) x where x is not null and x <> p_target);
 if cardinality(srcs) < 1 then raise exception 'Choose the tasks to merge' using errcode = '22023'; end if;
 if cardinality(srcs) > 30 then raise exception 'Merge at most 30 tasks at a time' using errcode = '22023'; end if;
 k := task_for_edit(p_target);
 if k.status in ('accepted', 'cancelled') or k.deleted_at is not null then raise exception 'Merge into open work' using errcode = '22023'; end if;
 insert into work_merge(org_id, kind, target_id, made_new, shape, title, reason, method, suggestion_id, created_by)
 values (current_org(), 'task', p_target, coalesce(p_made_new, false), case when p_shape = 'brief' then 'brief' else 'task' end, left(k.title, 300),
   nullif(left(btrim(coalesce(p_reason, '')), 2000), ''), case when p_suggestion is null then 'by_hand' else 'suggested' end, p_suggestion, me)
 returning id into mid;
 foreach s in array srcs loop
  pos := pos + 1;
  g := task_for_edit(s);
  if g.status in ('accepted', 'cancelled') or g.deleted_at is not null then
   raise exception 'Accepted, cancelled or deleted work is not merged: %', left(g.title, 120) using errcode = '22023'; end if;
  -- Links: whatever waited on the original now waits on the target, and the target waits on what the original waited on.
  update task_link l set blocker_id = p_target where l.org_id = current_org() and l.blocker_id = s and l.cleared_at is null and l.task_id <> p_target
   and not (l.task_id = any(srcs))
   and not exists(select 1 from task_link x where x.org_id = l.org_id and x.task_id = l.task_id and x.blocker_id = p_target and x.cleared_at is null);
  get diagnostics n_links = row_count;
  update task_link l set task_id = p_target where l.org_id = current_org() and l.task_id = s and l.cleared_at is null and l.blocker_id <> p_target
   and not (l.blocker_id = any(srcs))
   and not exists(select 1 from task_link x where x.org_id = l.org_id and x.task_id = p_target and x.blocker_id = l.blocker_id and x.cleared_at is null);
  get diagnostics n = row_count; n_links := n_links + n;
  update task_link set cleared_at = now(), cleared_by = me where org_id = current_org() and cleared_at is null and (task_id = s or blocker_id = s);
  update task_proof set task_id = p_target where org_id = current_org() and task_id = s and removed_at is null;
  get diagnostics n_proof = row_count;
  insert into task_check(org_id, task_id, step_key, label, done_at, done_by)
   select org_id, p_target, step_key, label, done_at, done_by from task_check where org_id = current_org() and task_id = s on conflict do nothing;
  get diagnostics n_checks = row_count;
  update task set parent_id = p_target, updated_at = now() where org_id = current_org() and parent_id = s and id <> p_target and not (id = any(srcs));
  get diagnostics n_subs = row_count;
  update goal_link gl set task_id = p_target where gl.org_id = current_org() and gl.task_id = s
   and not exists(select 1 from goal_link x where x.org_id = gl.org_id and x.goal_id = gl.goal_id and x.task_id = p_target);
  get diagnostics n_goals = row_count;
  insert into work_merge_source(org_id, merge_id, kind, source_id, position, title, status_before, person_id, project_id, due_on, moved)
  values (current_org(), mid, 'task', s, pos, left(g.title, 600), g.status, coalesce(g.assignee_person_id, g.owner_id), g.project_id,
    (g.due_at at time zone org_time_zone())::date,
    jsonb_build_object('links', n_links, 'proof', n_proof, 'steps', n_checks, 'subtasks', n_subs, 'goals', n_goals,
      'comments', (select count(*) from work_comment c where c.org_id = current_org() and c.task_id = s and c.removed_at is null)));
  update task set status = 'cancelled', closed_as = 'merged', updated_at = now(), edited_by = me,
   locked = array(select distinct unnest(locked || '{status}'::text[])) where id = s;
  perform task_event_add(s, 'merged', g.status, 'cancelled', left('Merged into: ' || k.title, 1000));
  insert into task_same(org_id, task_a, task_b, state, decided_by) values (current_org(), least(p_target, s), greatest(p_target, s), 'merged', me)
  on conflict (org_id, task_a, task_b) do update set state = 'merged', decided_by = me, decided_at = now();
  total := total + 1;
 end loop;
 perform task_event_add(p_target, 'merged', null, format('%s %s', total, case when total = 1 then 'task' else 'tasks' end), left(format('Made from %s %s', total, case when total = 1 then 'task' else 'tasks' end)
   || coalesce(': ' || nullif(btrim(coalesce(p_reason, '')), ''), ''), 1000));
 if p_suggestion is not null then
  update merge_suggestion set status = 'accepted', decided_by = me, decided_at = now(), merge_id = mid
   where org_id = current_org() and id = p_suggestion and status in ('open', 'stale') and merge_person_in_reach(person_id);
 end if;
 if task_open_blockers(p_target) > 0 and k.status in ('open', 'in_progress', 'unknown') then
  update task set status = 'blocked', updated_at = now() where id = p_target;
 end if;
 return mid;
end $$;

-- Undo a merge (whoever made it, or anyone who may change the merged task, within 7 days): each original still closed as
-- merged opens again in the status it had. Links, proof and steps stay on the merged task; a task the merge made is
-- cancelled when nothing else happened to it.
create function pulse.work_merge_undo(p_id uuid) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := task_require_viewer(); m work_merge; r record; n int := 0;
begin
 select * into m from work_merge where org_id = current_org() and id = p_id for update;
 if not found or not task_visible(m.target_id) then raise exception 'Merge not found' using errcode = 'P0002'; end if;
 if m.undone_at is not null then raise exception 'This merge was undone already' using errcode = '22023'; end if;
 if m.created_at < now() - interval '7 days' then raise exception 'A merge can be undone for 7 days' using errcode = '22023'; end if;
 if m.created_by is distinct from me and not task_can_edit(m.target_id) then
  raise exception 'Only whoever merged, or someone who may change the merged task, can undo it' using errcode = '42501'; end if;
 for r in select s.source_id, s.status_before from work_merge_source s join task t on t.id = s.source_id
   where s.org_id = current_org() and s.merge_id = p_id and t.status = 'cancelled' and t.closed_as = 'merged' loop
  update task set status = case when r.status_before in ('open', 'in_progress', 'blocked', 'unknown', 'in_review', 'done') then r.status_before else 'open' end,
   updated_at = now(), edited_by = me where id = r.source_id;
  perform task_event_add(r.source_id, 'status', 'cancelled', r.status_before, 'Merge undone');
  n := n + 1;
 end loop;
 update work_merge set undone_at = now(), undone_by = me where id = p_id;
 if m.made_new and not exists(select 1 from task_event e where e.org_id = current_org() and e.task_id = m.target_id and e.kind in ('status', 'proof', 'accepted') and e.at > m.created_at) then
  update task set status = 'cancelled', updated_at = now(), edited_by = me where id = m.target_id and status not in ('accepted', 'cancelled');
 end if;
 perform task_event_add(m.target_id, 'edited', null, null, format('Merge undone: %s %s opened again', n, case when n = 1 then 'task' else 'tasks' end));
 return n;
end $$;

revoke all on function pulse.merge_suggestion_save(uuid, jsonb), pulse.merge_suggestion_reject(uuid), pulse.work_merge_tasks(uuid, uuid[], text, text, boolean, uuid),
  pulse.work_merge_undo(uuid), pulse.merge_person_in_reach(uuid) from public;
grant execute on function pulse.merge_suggestion_save(uuid, jsonb), pulse.merge_suggestion_reject(uuid), pulse.work_merge_tasks(uuid, uuid[], text, text, boolean, uuid),
  pulse.work_merge_undo(uuid), pulse.merge_person_in_reach(uuid), pulse.merge_item_visible(text, uuid) to pulse_api;

-- migrate:down
-- Forward-only: merges and their originals are history; an original is opened again with work_merge_undo.
