-- migrate:up
-- TASK-CLEAN (owner, 17 Nov 2026): "there are stupid tasks: 'report bug 36', bug this, bug that, 'Video 3 add leads',
-- 'Video 12 upload a recording', dev tasks. If I see all these listed it's hectic. Merge things that are too small into
-- one task with sub-tasks." Tasks made by automation (AI employees, service keys, other people's connected AI apps, the
-- AC task route's watchers, tutorial tool and orchestrators) no longer pile up on a person one by one:
--   * a task automation makes UNDER a task the person already has becomes a sub-task of that task with nobody on it:
--     the person sees the one task, its small steps sit inside it;
--   * a watcher (bug alerts, bug radar, cost finder, real-use and speed checks) gives a person one task only: its first
--     task for them is its summary task, and everything after goes under it as sub-tasks with nobody on them;
--   * any other automation gives a person at most 3 open top-level tasks; the next ones go under its summary task.
-- The task is still made (the caller keeps its id, its marker and its later moves); it just is not the person's own
-- row. "Move out" on the task page (life.tsx) gives it back to someone by hand. People's own tasks (a web or phone
-- session, the e-mail or pulse:<username> actor) are never touched, nor an AI employee's own tasks.
-- Every task automation makes carries auto_source (who made it), so the rule and the lists can tell.

alter table pulse.task add column if not exists auto_source text check (auto_source is null or length(auto_source) between 1 and 200);
comment on column pulse.task.auto_source is 'TASK-CLEAN (2198): the automation that made the task (the request''s actor label: agent:, service:, app:, bot:, or a route label with " · "); null when a person made it (or approved the run).';
alter table pulse.task add column if not exists auto_digest boolean not null default false;
comment on column pulse.task.auto_digest is 'TASK-CLEAN (2198): a summary task that holds one automation''s smaller tasks for one person as its sub-tasks.';
create index if not exists task_auto_open on pulse.task (org_id, auto_source, coalesce(assignee_person_id, owner_id))
  where auto_source is not null and deleted_at is null and status in ('open', 'in_progress', 'blocked', 'unknown');

-- The automation behind this write, or null for a person. The API sets pulse.actor_account for every request: a person's
-- sign-in e-mail or pulse:<username>; agent:<name> for an AI employee; service:<key> for a service key; app:<app>:<user>
-- for a connected AI app; routes write "<route> · <caller>" (the AC task route: "AC tasks route (AUT-2207) · ac-bug-alerts").
-- A host tool a person approved for one run ("<tool> · approver: <who>", e.g. a meeting import or a backfill) is that
-- person's deliberate act and is not grouped.
create or replace function pulse.task_auto_source() returns text
 language sql stable set search_path = pulse, pg_temp as $$
 select case when a ~ '^(agent|service|app|bot):' or a ~* '^ac tasks route' or (a like '% · %' and a not like '% · approver%') then left(a, 200) end
   from (select btrim(coalesce(current_setting('pulse.actor_account', true), '')) a) x
$$;

-- A plain name for an automation, for its summary task's title.
create or replace function pulse.task_auto_source_name(p_source text) returns text
 language sql immutable set search_path = pulse, pg_temp as $$
 select left(coalesce(nullif(btrim(case
   when p_source ~ '^agent:' then substr(p_source, 7)
   when p_source ~ '^service:' then 'A connected app'
   when p_source ~ '^app:' then split_part(p_source, ':', 2)
   when p_source ~* '^ac tasks route' then 'AC ' || replace(regexp_replace(split_part(p_source, ' · ', 2), '^ac-', ''), '-', ' ')
   when p_source like '% · %' then split_part(p_source, ' · ', 1)
   else p_source end), ''), 'Automation'), 80)
$$;

-- A watcher: it reports what it saw (bugs, layout radar, costs, errors, speed). Its items never become a person's own tasks.
create or replace function pulse.task_auto_watcher(p_source text) returns boolean
 language sql immutable set search_path = pulse, pg_temp as $$
 select coalesce(p_source ~* '(bug|radar|alert|cost-detect|telemetry|real.?use|speed|monitor|watch)', false)
$$;

create or replace function pulse.task_auto_group() returns trigger
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare src text; who uuid; holder uuid; n int; d uuid; cap constant int := 3;
begin
 if coalesce(current_setting('pulse.task_auto_group', true), '') = 'off' then return new; end if;
 src := task_auto_source();
 if src is null then return new; end if;
 new.auto_source := coalesce(new.auto_source, src);
 who := coalesce(new.assignee_person_id, new.owner_id);
 if who is null or new.auto_digest or new.status not in ('open', 'in_progress', 'blocked', 'unknown') then return new; end if;
 -- An AI employee's own task (its key, for itself) stays its own: it works from it.
 if coalesce(current_setting('pulse.agent_session', true), '') = 'on' and who = current_viewer() then return new; end if;
 -- A person's own connected AI app (app:<app>:<them>) making tasks for that same person is the person at work.
 if src ~ '^app:' and who = current_viewer() then return new; end if;
 if new.parent_id is not null then
  -- Under a task the person already has (or one already grouped for them): a small step inside it, with nobody on it.
  select coalesce(t.assignee_person_id, t.owner_id, nullif(t.evidence -> 'autoGrouped' ->> 'for', '')::uuid) into holder from task t
   where t.org_id = new.org_id and t.id = new.parent_id and t.deleted_at is null;
  if holder = who or task_auto_watcher(src) then
   new.assignee_person_id := null; new.owner_id := null; new.assigned_at := null;
   new.evidence := coalesce(new.evidence, '{}') || jsonb_build_object('autoGrouped', jsonb_build_object('into', new.parent_id, 'for', who, 'source', src));
  end if;
  return new;
 end if;
 -- The person's summary task for this automation, while open.
 select t.id into d from task t where t.org_id = new.org_id and t.auto_digest and t.auto_source = src and coalesce(t.assignee_person_id, t.owner_id) = who
  and t.deleted_at is null and t.status in ('open', 'in_progress', 'blocked', 'unknown') order by t.created_at limit 1;
 if d is null and task_auto_watcher(src) then
  -- A watcher's first task for this person is its summary task (a route that looks its root up by title keeps finding it).
  new.auto_digest := true;
  new.evidence := coalesce(new.evidence, '{}') || jsonb_build_object('autoDigest', src);
  return new;
 end if;
 if d is null then
  select count(*) into n from task t where t.org_id = new.org_id and t.auto_source = src and not t.auto_digest and t.parent_id is null
   and coalesce(t.assignee_person_id, t.owner_id) = who and t.deleted_at is null and t.status in ('open', 'in_progress', 'blocked', 'unknown');
  if n < cap then return new; end if;
  perform set_config('pulse.task_auto_group', 'off', true);
  insert into task (org_id, title, status, owner_id, assignee_person_id, assigned_at, source, created_by, created_at, edited_by, updated_at, notes, priority,
                    auto_source, auto_digest, locked, evidence)
  values (new.org_id, left(task_auto_source_name(src) || ': automatic items', 300), 'open', who, who, now(), 'pulse', new.created_by, now(), new.created_by, now(),
          'Pulse keeps what ' || task_auto_source_name(src) || ' makes for you here, as sub-tasks, so they do not fill your lists one by one. '
          || 'Open a sub-task to work it, or "Move out" to make it a task of its own.', 'normal', src, true, '{title,status,owner_id}', jsonb_build_object('autoDigest', src))
  returning id into d;
  perform set_config('pulse.task_auto_group', '', true);
  perform task_event_add(d, 'created', null, null, left('Summary task for ' || task_auto_source_name(src) || ' (TASK-CLEAN rule)', 1000));
 end if;
 new.parent_id := d;
 new.assignee_person_id := null; new.owner_id := null; new.assigned_at := null;
 new.evidence := coalesce(new.evidence, '{}') || jsonb_build_object('autoGrouped', jsonb_build_object('into', d, 'for', who, 'source', src));
 return new;
end $$;

drop trigger if exists task_auto_group on pulse.task;
create trigger task_auto_group before insert on pulse.task for each row execute function pulse.task_auto_group();

revoke all on function pulse.task_auto_group(), pulse.task_auto_source(), pulse.task_auto_source_name(text), pulse.task_auto_watcher(text) from public;
grant execute on function pulse.task_auto_source(), pulse.task_auto_source_name(text), pulse.task_auto_watcher(text) to pulse_api, pulse_worker;

-- migrate:down
-- Forward-only: drop the trigger to stop grouping (drop trigger task_auto_group on pulse.task); the columns stay.
