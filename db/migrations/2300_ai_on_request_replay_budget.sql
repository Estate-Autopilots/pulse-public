-- migrate:up
-- DITASU-2 (orchestrator decisions under the owner's delegation, 17 Nov 2026). Three decisions, each additive:
--
-- A. AI employees and tasks they are not on (decision 4). An AI employee with operations access may change a task it is
--    not on ONLY when a person who may change that task asked for it: their comment on that task, or on a task that
--    names it (the comment carries its link or id, it is a sub-task of it, or a doc linked to the comment's task holds its
--    chip: Kazuk's decision comment on "Review overdue tasks and decide", whose doc lists each task). The API sets
--    pulse.ai_request (the comment's id) for an AI principal's task writes; task_can_edit lets the AI in when
--    task_ai_request() finds the request counts, which checks the commenter's own right to change the task (as them).
--    Each change made that way is written in the task's history: "done by <AI> at <person>'s request" (kind on_request).
--    Its "asks first" rules still apply: the runtime does not act on a request that carries money, deletion or legal/HR
--    risk its policy holds (services/coworker), deletes stay refused for AI employees, and nothing else widens.
-- B. Read-only attendance for an AI employee an admin chooses (decision 5, the HR Assistant's attendance review):
--    agent_member.reads ('attendance'). Its check-ins, breaks, corrections and leave are readable company-wide like HR's;
--    it can never write them (restrictive update/delete policies), and nothing else (no pay, bank details or documents:
--    those tables are untouched). Set by an admin (agent_reads_set, audited).
-- C. Session replay storage (decision 3): replays are kept 7 days (telemetry_setting.replay_days; usage rows keep
--    retention_days), sent for 10% of sessions (replay_sample's default, and saved settings still at the old 100%) and,
--    for every other session, only for a window around a struggle moment the device detects (reason 'struggle': about
--    60 s before and after). Each company has a disk budget (replay_budget_mb, default 1 GiB): telemetry_replay_room()
--    deletes its oldest chunks first (bug-report chunks last) until a new chunk fits; and the whole server has a hard cap
--    (3 GiB on disk): above it new chunks are refused (a bug report's still goes) and the hourly retention trims the
--    oldest across companies. telemetry_replay_usage() says what is stored, for the Telemetry screen.

-- A ------------------------------------------------------------------------------------------------------------------
select pulse.check_values_add('pulse.task_event'::regclass, 'task_event_kind_check', 'kind', array['on_request']);

/** The request an AI session acts on (pulse.ai_request: a comment id the API sets for an AI principal), when it lets
 *  the AI change p_task: {comment, by, byName, onTask}; null when there is none or it does not count. While it checks,
 *  the request is cleared (so task row security never asks it again) and the scope and the right to change the task are
 *  checked as the person who commented, never as the AI. */
create function pulse.task_ai_request(p_task uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare req uuid; req_task text; me uuid; c record; ok boolean := false; v_viewer text; v_agent text;
begin
  begin req := nullif(current_setting('pulse.ai_request', true), '')::uuid; exception when others then return null; end;
  if req is null or p_task is null then return null; end if;
  me := agent_session();
  if me is null or not exists (select 1 from agent_member m where m.org_id = current_org() and m.person_id = me and m.access = 'operations'
      and m.disabled_at is null) then return null; end if;
  req_task := current_setting('pulse.ai_request_task', true);
  perform set_config('pulse.ai_request', '', true); perform set_config('pulse.ai_request_task', '', true);
  select wc.id, wc.task_id, wc.author_id, wc.body into c from work_comment wc join person p on p.id = wc.author_id
   where wc.id = req and wc.org_id = current_org() and wc.removed_at is null and wc.task_id is not null
     and p.side = 'staff' and p.status = 'active' and wc.created_at > now() - interval '14 days';
  if found then
    v_viewer := current_setting('pulse.viewer_id', true); v_agent := current_setting('pulse.agent_session', true);
    perform set_config('pulse.viewer_id', c.author_id::text, true); perform set_config('pulse.agent_session', '', true);
    begin
      ok := (c.task_id = p_task
          or position(p_task::text in coalesce(c.body, '')) > 0
          or exists (select 1 from task t where t.org_id = current_org() and t.id = p_task and t.parent_id = c.task_id)
          or exists (select 1 from doc_link l join doc d on d.id = l.doc_id and d.archived_at is null
                      where l.org_id = current_org() and l.kind = 'task' and l.ref_id = c.task_id and position(p_task::text in d.body_html) > 0))
        and coalesce(task_can_edit(p_task), false);
    exception when others then ok := false; end;
    perform set_config('pulse.viewer_id', coalesce(v_viewer, ''), true); perform set_config('pulse.agent_session', coalesce(v_agent, ''), true);
  end if;
  perform set_config('pulse.ai_request', req::text, true); perform set_config('pulse.ai_request_task', coalesce(req_task, ''), true);
  if not ok then return null; end if;
  return jsonb_build_object('comment', c.id, 'by', c.author_id, 'byName', (select display_name from person where id = c.author_id), 'onTask', c.task_id);
end $$;
revoke all on function pulse.task_ai_request(uuid) from public;
grant execute on function pulse.task_ai_request(uuid) to pulse_api;

/** The one task an AI's API call is about at a colleague's request (pulse.ai_request_task), when that request counts:
 *  task row security and task_visible_row let the AI see it for that call. Null (at once) otherwise. */
create function pulse.task_ai_requested_id() returns uuid language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare t uuid;
begin
  if coalesce(current_setting('pulse.ai_request', true), '') = '' then return null; end if;
  begin t := nullif(current_setting('pulse.ai_request_task', true), '')::uuid; exception when others then return null; end;
  if t is null or task_ai_request(t) is null then return null; end if;
  return t;
end $$;
grant execute on function pulse.task_ai_requested_id() to pulse_api, pulse_worker;

drop policy task_person on pulse.task;
create policy task_person on pulse.task as restrictive for select to pulse_api using((select pulse.viewer_is('admin','leadership','hr')) or id in (select pulse.task_visible_ids())
  or id = (select pulse.task_ai_requested_id()));

-- 0153's rules, plus the requested task (only while the API set a request for an AI principal: nothing else pays for it).
create or replace function pulse.task_visible_row(p_id uuid,p_owner uuid,p_assignee uuid,p_reviewer uuid,p_creator uuid,p_project uuid,p_parent uuid)
 returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('admin','leadership','hr')
 or current_viewer() in (p_owner,p_assignee,p_reviewer,p_creator)
 or exists(select 1 from task_member m where m.org_id=current_org() and m.task_id=p_id and m.person_id=current_viewer() and m.removed_at is null)
 or exists(select 1 from work_ask a where a.org_id=current_org() and a.task_id=p_id and a.to_id=current_viewer() and a.status='pending')
 or coalesce(manages(p_owner),false) or coalesce(manages(p_assignee),false)
 or exists(select 1 from people_profile me join people_profile them on them.org_id=me.org_id and them.pod=me.pod
  where me.org_id=current_org() and me.person_id=current_viewer() and me.pod is not null and them.person_id=coalesce(p_assignee,p_owner,p_creator))
 or exists(select 1 from project pr join role_assignment r on r.unit_id=pr.unit_id where pr.id=p_project and r.person_id=current_viewer()
  and (r.is_manager_of_unit or r.role_key in ('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))
 or work_project_in(p_project)
 or exists(select 1 from task_link l join task b on b.id=l.task_id where l.org_id=current_org() and l.blocker_id=p_id and l.cleared_at is null
  and current_viewer() in (b.owner_id,b.assignee_person_id,b.review_owner_id,b.created_by))
 or exists(select 1 from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and l.task_id=p_id and l.cleared_at is null
  and current_viewer() in (b.owner_id,b.assignee_person_id))
 or exists(select 1 from task par where par.org_id=current_org() and par.id=p_parent and current_viewer() in (par.owner_id,par.assignee_person_id,par.review_owner_id,par.created_by))
 or (p_owner is null and p_assignee is null and exists(select 1 from task x where x.org_id=current_org() and x.id=p_id and x.pool_scope is not null
  and x.status not in ('done','accepted','cancelled','in_review') and work_pool_eligible(x.pool_scope,x.pool_ref)))
 or (coalesce(current_setting('pulse.ai_request',true),'')<>'' and p_id=task_ai_requested_id()))
$$;

-- 0153's rule, plus the request.
create or replace function pulse.task_can_edit(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from task t where t.org_id=current_org() and t.id=p_id and current_viewer() is not null and (viewer_is('admin','leadership','hr')
 or current_viewer() in (t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by)
 or coalesce(manages(t.assignee_person_id),false) or coalesce(manages(t.owner_id),false)
 or exists(select 1 from task_member m where m.org_id=current_org() and m.task_id=t.id and m.person_id=current_viewer() and m.role='collaborator' and m.removed_at is null)
 or (t.project_id is not null and work_project_can_manage(t.project_id))
 or (t.assignee_person_id is null and t.owner_id is null and (t.pool_scope is null or current_viewer()=t.pooled_by or work_can_pool(t.pool_scope,t.pool_ref))
  and task_visible_row(t.id,t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by,t.project_id,t.parent_id))
 or (coalesce(current_setting('pulse.ai_request',true),'')<>'' and task_ai_request(t.id) is not null)))
$$;

/** After a change the AI made at someone's request: the task's history says so ("did this at Kazuk's request: …"). */
create function pulse.task_on_request_note(p_task uuid, p_what text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r jsonb := task_ai_request(p_task);
begin
  if r is null then raise exception 'This change was not made at a colleague''s request' using errcode = '42501'; end if;
  insert into task_event (org_id, task_id, actor_id, kind, from_value, to_value, note)
  values (current_org(), p_task, current_viewer(), 'on_request', r->>'comment', left(r->>'byName', 200), left(nullif(btrim(coalesce(p_what, '')), ''), 600));
  return r;
end $$;
revoke all on function pulse.task_on_request_note(uuid, text) from public;
grant execute on function pulse.task_on_request_note(uuid, text) to pulse_api;

-- B ------------------------------------------------------------------------------------------------------------------
alter table pulse.agent_member add column if not exists reads text[] not null default '{}'::text[]
  check (reads <@ array['attendance']::text[]);

/** This AI session may read `p_area` (an admin's choice on its profile). */
create function pulse.ai_reads(p_area text) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(current_setting('pulse.agent_session', true), '') = 'on' and exists (
    select 1 from agent_member m join person p on p.id = m.person_id
     where m.org_id = current_org() and m.person_id = current_viewer() and m.disabled_at is null and p.status = 'active' and p.side = 'agent'
       and p_area = any(m.reads))
$$;
grant execute on function pulse.ai_reads(text) to pulse_api;

/** An admin lets an AI employee read an area (read only), or stops it. */
create function pulse.agent_reads_set(p_agent uuid, p_area text, p_on boolean) returns text[] language plpgsql security definer set search_path = pulse, pg_temp as $$
declare out text[];
begin
  if agent_session() is not null or not viewer_is('admin') then raise exception 'Only an admin changes what an AI employee may read' using errcode = '42501'; end if;
  if p_area is null or p_area not in ('attendance') then raise exception 'Choose what it may read: attendance' using errcode = '22023'; end if;
  perform agent_lock(p_agent);
  update agent_member set reads = case when coalesce(p_on, false) then (select array_agg(distinct x order by x) from unnest(reads || p_area) x) else array_remove(reads, p_area) end
   where person_id = p_agent and org_id = current_org() returning reads into out;
  if not found then raise exception 'Choose an AI employee' using errcode = '22023'; end if;
  perform audit_write('agent_reads_set', 'agent_member', p_agent::text || ':' || p_area || ':' || case when coalesce(p_on, false) then 'on' else 'off' end);
  return out;
end $$;
revoke all on function pulse.agent_reads_set(uuid, text, boolean) from public;
grant execute on function pulse.agent_reads_set(uuid, text, boolean) to pulse_api;

-- Reading widens (own_or_team's USING); writing never (its WITH CHECK is untouched, and two restrictive policies refuse
-- an AI reader's update and delete).
do $$ declare t text; q text; w text; begin
  foreach t in array array['attendance_entry', 'attendance_break', 'attendance_regularisation', 'leave_request'] loop
    select p.qual, p.with_check into q, w from pg_policies p where p.schemaname = 'pulse' and p.tablename = t and p.policyname = 'own_or_team';
    if q is null or w is null then raise exception 'own_or_team (with its check) is missing on %', t; end if;
    execute format('alter policy own_or_team on pulse.%I using ((%s) or pulse.ai_reads(''attendance''))', t, q);
    execute format('create policy ai_reads_no_update on pulse.%I as restrictive for update to pulse_api using (not pulse.ai_reads(''attendance''))', t);
    execute format('create policy ai_reads_no_delete on pulse.%I as restrictive for delete to pulse_api using (not pulse.ai_reads(''attendance''))', t);
  end loop;
end $$;

-- C ------------------------------------------------------------------------------------------------------------------
select pulse.check_values_add('pulse.telemetry_replay'::regclass, 'telemetry_replay_reason_check', 'reason', array['struggle']);
alter table pulse.telemetry_setting
  add column replay_days integer not null default 7 check (replay_days between 1 and 30),
  add column replay_budget_mb integer not null default 1024 check (replay_budget_mb between 64 and 8192),
  alter column replay_sample set default 0.1;
grant update (replay_days, replay_budget_mb) on pulse.telemetry_setting to pulse_api;
create index telemetry_replay_age on pulse.telemetry_replay (org_id, created_at, id) include (bytes, reason);

-- Saved settings still at the old "every session" become 10% (decision 3); a company that chose another share keeps it.
do $$ declare o record; begin
  for o in select g.id from pulse.org g loop
    perform set_config('pulse.org_id', o.id::text, true);
    update pulse.telemetry_setting set replay_sample = 0.1 where org_id = o.id and replay_sample = 1;
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;

/** The server's hard cap for replays on disk (all companies). */
create function pulse.telemetry_replay_cap() returns bigint language sql immutable as $$ select 3221225472::bigint $$;

/** Before a chunk of p_bytes is stored in this company: its oldest chunks go first (bug-report chunks last) until it
 *  fits the company's budget; refused when the server is over its hard cap (a bug report's chunk still goes). */
create function pulse.telemetry_replay_room(p_bytes integer, p_reason text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare budget bigint; used bigint; freed bigint := 0; n bigint; disk bigint := pg_total_relation_size('pulse.telemetry_replay');
begin
  select coalesce((select s.replay_budget_mb from telemetry_setting s where s.org_id = current_org()), 1024)::bigint * 1048576 into budget;
  select coalesce(sum(bytes), 0) into used from telemetry_replay where org_id = current_org();
  for i in 1..400 loop
    exit when used + p_bytes <= budget;
    with gone as (delete from telemetry_replay where id in (select r.id from telemetry_replay r where r.org_id = current_org()
                    order by (r.reason = 'report'), r.created_at, r.id limit 20) returning bytes)
    select coalesce(sum(bytes), 0) into n from gone;
    exit when n = 0;
    used := used - n; freed := freed + n;
  end loop;
  return jsonb_build_object('fits', used + p_bytes <= budget and (disk < telemetry_replay_cap() or p_reason = 'report'), 'used', used, 'budget', budget, 'freed', freed, 'disk', disk);
end $$;
revoke all on function pulse.telemetry_replay_room(integer, text) from public;
grant execute on function pulse.telemetry_replay_room(integer, text) to pulse_api;

/** What this company's replays take now, for the Telemetry screen (leadership and admins read it through the API). */
create function pulse.telemetry_replay_usage() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('bytes', coalesce(sum(r.bytes), 0), 'chunks', count(*), 'sessions', count(distinct r.session_id),
    'struggle', count(*) filter (where r.reason = 'struggle'), 'sampled', count(*) filter (where r.reason = 'sample'), 'reports', count(*) filter (where r.reason = 'report'),
    'oldest', min(r.created_at), 'budgetBytes', coalesce((select s.replay_budget_mb from telemetry_setting s where s.org_id = current_org()), 1024)::bigint * 1048576,
    'days', coalesce((select s.replay_days from telemetry_setting s where s.org_id = current_org()), 7),
    'sample', coalesce((select s.replay_sample from telemetry_setting s where s.org_id = current_org()), 0.1)::float8,
    'serverBytes', pg_total_relation_size('pulse.telemetry_replay'), 'serverCap', telemetry_replay_cap())
  from telemetry_replay r where r.org_id = current_org()
$$;
grant execute on function pulse.telemetry_replay_usage() to pulse_api;

/** Hourly: replays past each company's replay_days (7 by default) and raw usage past its saved retention (1682), then,
 *  when the server's replays are over 80% of the hard cap, the oldest across companies until under it. */
create or replace function pulse.telemetry_retention() returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; v_days integer; v_rdays integer; v_saved boolean; v_replays integer := 0; v_events integer := 0; n integer; total bigint := 0; b bigint;
  oldest_org uuid; oldest_at timestamptz; at1 timestamptz; trimmed integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('pulse.telemetry_retention')) then return jsonb_build_object('skipped', true); end if;
  for o in select g.id from pulse.org g loop
    perform set_config('pulse.org_id', o.id::text, true);
    v_days := null; v_rdays := null; v_saved := null;
    select s.retention_days, s.replay_days, true into v_days, v_rdays, v_saved from telemetry_setting s where s.org_id = o.id;
    v_days := coalesce(v_days, 30); v_rdays := coalesce(v_rdays, 7); v_saved := coalesce(v_saved, false);
    delete from telemetry_replay where org_id = o.id and created_at < now() - make_interval(days => v_rdays);
    get diagnostics n = row_count; v_replays := v_replays + n;
    if v_saved then
      delete from telemetry_event where org_id = o.id and source = 'client' and at < now() - make_interval(days => v_days);
      get diagnostics n = row_count; v_events := v_events + n;
    end if;
    select coalesce(sum(bytes), 0) into b from telemetry_replay where org_id = o.id; total := total + b;
  end loop;
  -- Over 80% of the hard cap: the oldest chunk across companies goes first, 50 at a time.
  for i in 1..200 loop
    exit when total <= telemetry_replay_cap() * 8 / 10;
    oldest_org := null; oldest_at := null;
    for o in select g.id from pulse.org g loop
      perform set_config('pulse.org_id', o.id::text, true);
      select min(created_at) into at1 from telemetry_replay where org_id = o.id;
      if at1 is not null and (oldest_at is null or at1 < oldest_at) then oldest_at := at1; oldest_org := o.id; end if;
    end loop;
    exit when oldest_org is null;
    perform set_config('pulse.org_id', oldest_org::text, true);
    with gone as (delete from telemetry_replay where id in (select r.id from telemetry_replay r where r.org_id = oldest_org order by r.created_at, r.id limit 50) returning bytes)
    select coalesce(sum(bytes), 0) into b from gone;
    exit when b = 0;
    total := total - b; trimmed := trimmed + 1;
  end loop;
  perform set_config('pulse.org_id', '', true);
  return jsonb_build_object('replays', v_replays, 'events', v_events, 'replayBytes', total, 'trimmedBatches', trimmed);
end
$$;
revoke execute on function pulse.telemetry_retention() from public;
grant execute on function pulse.telemetry_retention() to pulse_api, pulse_worker;

-- migrate:down
-- C
create or replace function pulse.telemetry_retention() returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; v_days integer; v_saved boolean; v_replays integer := 0; v_events integer := 0; n integer;
begin
  if not pg_try_advisory_xact_lock(hashtext('pulse.telemetry_retention')) then return jsonb_build_object('skipped', true); end if;
  for o in select g.id from pulse.org g loop
    perform set_config('pulse.org_id', o.id::text, true);
    select s.retention_days, true into v_days, v_saved from telemetry_setting s where s.org_id = o.id;
    v_days := coalesce(v_days, 30); v_saved := coalesce(v_saved, false);
    delete from telemetry_replay where org_id = o.id and created_at < now() - make_interval(days => v_days);
    get diagnostics n = row_count; v_replays := v_replays + n;
    if v_saved then
      delete from telemetry_event where org_id = o.id and source = 'client' and at < now() - make_interval(days => v_days);
      get diagnostics n = row_count; v_events := v_events + n;
    end if;
  end loop;
  perform set_config('pulse.org_id', '', true);
  return jsonb_build_object('replays', v_replays, 'events', v_events);
end
$$;
drop function if exists pulse.telemetry_replay_usage();
drop function if exists pulse.telemetry_replay_room(integer, text);
drop function if exists pulse.telemetry_replay_cap();
drop index if exists pulse.telemetry_replay_age;
do $$ declare o record; begin
  for o in select g.id from pulse.org g loop
    perform set_config('pulse.org_id', o.id::text, true);
    delete from pulse.telemetry_replay where org_id = o.id and reason = 'struggle';
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;
alter table pulse.telemetry_replay drop constraint telemetry_replay_reason_check;
alter table pulse.telemetry_replay add constraint telemetry_replay_reason_check check (reason = any (array['report', 'sample']::text[]));
alter table pulse.telemetry_setting alter column replay_sample set default 1, drop column if exists replay_budget_mb, drop column if exists replay_days;
-- B
do $$ declare t text; q text; begin
  foreach t in array array['attendance_entry', 'attendance_break', 'attendance_regularisation', 'leave_request'] loop
    execute format('drop policy if exists ai_reads_no_update on pulse.%I', t);
    execute format('drop policy if exists ai_reads_no_delete on pulse.%I', t);
    select p.qual into q from pg_policies p where p.schemaname = 'pulse' and p.tablename = t and p.policyname = 'own_or_team';
    q := regexp_replace(q, '^\((.*) OR (pulse\.)?ai_reads\(''attendance''::text\)\)$', '\1');
    execute format('alter policy own_or_team on pulse.%I using (%s)', t, q);
  end loop;
end $$;
drop function if exists pulse.agent_reads_set(uuid, text, boolean);
drop function if exists pulse.ai_reads(text);
alter table pulse.agent_member drop column if exists reads;
-- A
drop function if exists pulse.task_on_request_note(uuid, text);
create or replace function pulse.task_can_edit(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from task t where t.org_id=current_org() and t.id=p_id and current_viewer() is not null and (viewer_is('admin','leadership','hr')
 or current_viewer() in (t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by)
 or coalesce(manages(t.assignee_person_id),false) or coalesce(manages(t.owner_id),false)
 or exists(select 1 from task_member m where m.org_id=current_org() and m.task_id=t.id and m.person_id=current_viewer() and m.role='collaborator' and m.removed_at is null)
 or (t.project_id is not null and work_project_can_manage(t.project_id))
 or (t.assignee_person_id is null and t.owner_id is null and (t.pool_scope is null or current_viewer()=t.pooled_by or work_can_pool(t.pool_scope,t.pool_ref))
  and task_visible_row(t.id,t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by,t.project_id,t.parent_id))))
$$;
drop policy task_person on pulse.task;
create policy task_person on pulse.task as restrictive for select to pulse_api using((select pulse.viewer_is('admin','leadership','hr')) or id in (select pulse.task_visible_ids()));
create or replace function pulse.task_visible_row(p_id uuid,p_owner uuid,p_assignee uuid,p_reviewer uuid,p_creator uuid,p_project uuid,p_parent uuid)
 returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('admin','leadership','hr')
 or current_viewer() in (p_owner,p_assignee,p_reviewer,p_creator)
 or exists(select 1 from task_member m where m.org_id=current_org() and m.task_id=p_id and m.person_id=current_viewer() and m.removed_at is null)
 or exists(select 1 from work_ask a where a.org_id=current_org() and a.task_id=p_id and a.to_id=current_viewer() and a.status='pending')
 or coalesce(manages(p_owner),false) or coalesce(manages(p_assignee),false)
 or exists(select 1 from people_profile me join people_profile them on them.org_id=me.org_id and them.pod=me.pod
  where me.org_id=current_org() and me.person_id=current_viewer() and me.pod is not null and them.person_id=coalesce(p_assignee,p_owner,p_creator))
 or exists(select 1 from project pr join role_assignment r on r.unit_id=pr.unit_id where pr.id=p_project and r.person_id=current_viewer()
  and (r.is_manager_of_unit or r.role_key in ('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))
 or work_project_in(p_project)
 or exists(select 1 from task_link l join task b on b.id=l.task_id where l.org_id=current_org() and l.blocker_id=p_id and l.cleared_at is null
  and current_viewer() in (b.owner_id,b.assignee_person_id,b.review_owner_id,b.created_by))
 or exists(select 1 from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and l.task_id=p_id and l.cleared_at is null
  and current_viewer() in (b.owner_id,b.assignee_person_id))
 or exists(select 1 from task par where par.org_id=current_org() and par.id=p_parent and current_viewer() in (par.owner_id,par.assignee_person_id,par.review_owner_id,par.created_by))
 or (p_owner is null and p_assignee is null and exists(select 1 from task x where x.org_id=current_org() and x.id=p_id and x.pool_scope is not null
  and x.status not in ('done','accepted','cancelled','in_review') and work_pool_eligible(x.pool_scope,x.pool_ref))))
$$;
drop function if exists pulse.task_ai_requested_id();
drop function if exists pulse.task_ai_request(uuid);
