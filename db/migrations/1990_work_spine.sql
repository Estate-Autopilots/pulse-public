-- migrate:up
-- WORK-SPINE (owner, 10 Nov 2026): goals → projects → tasks, one clear flow.
--
-- 1. ONE project type. A project is Internal (the company's own work), Client (client delivery) or Personal, and
--    work_project.project_type is the one place that says so. Until now three fields disagreed:
--      * 1640's backfill ran without an organisation set, so forced row security matched no rows and every project
--        kept the column default 'internal' (EA's 577 client folders read "Internal" on the work page);
--      * 1640's trigger forced every 'fulfilment' back to client delivery, so "Internal" could never be chosen for one;
--      * project.kind ('client_work' | 'internal') and work_project.kind ('fulfilment' | 'internal') follow different
--        writers (the Drive index, the 5 Nov import), so an internal company project opened as a "client package".
--    Now the type and both kinds follow each other both ways: a changed type sets the kinds, a changed kind sets the
--    type, and a new row takes its kind's type. The backfill decides each project once, per organisation:
--      personal stays personal; internal stays internal; a fulfilment is client delivery when it has a client, a client
--      folder, an explicit client-delivery type or a linked client package; otherwise (no client, no folder, nothing it
--      delivers) it is the company's own work: internal.
-- 2. STARTED BY AI. Projects an AI employee or an approved automation made (actor "agent:…" or "… · approver: …")
--    are kept apart: Work hides them by default under a "Started by AI" filter until a person keeps one. The same rule
--    marks new ones as they are made. work_project_started_set() keeps one (or moves it back), with its history.

-- ------------------------------------------------------------------------------------------------ 1. one type
create or replace function pulse.work_project_type_follow() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if (select kind from org where id = new.org_id) = 'personal' then
    new.project_type := 'personal';
    new.kind := 'internal';
  elsif tg_op = 'INSERT' then
    if new.project_type = 'personal' then new.kind := 'internal';
    else new.project_type := case when new.kind = 'fulfilment' then 'client_delivery' else 'internal' end;
    end if;
  elsif new.project_type is distinct from old.project_type then
    new.kind := case when new.project_type = 'client_delivery' then 'fulfilment' else 'internal' end;
  elsif new.kind is distinct from old.kind then
    new.project_type := case when new.kind = 'fulfilment' then 'client_delivery' when old.project_type = 'personal' then 'personal' else 'internal' end;
  end if;
  return new;
end $$;
revoke all on function pulse.work_project_type_follow() from public;

-- The package row's kind follows the type too (work_project_follow already copies project.kind the other way; both
-- updates are guarded, so the pair settles after one step).
create function pulse.work_project_kind_to_project() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare want text := case when new.project_type = 'client_delivery' then 'client_work' else 'internal' end;
begin
  update project set kind = want, updated_at = now() where id = new.project_id and org_id = new.org_id and kind is distinct from want;
  return null;
end $$;
revoke all on function pulse.work_project_kind_to_project() from public;
create trigger work_project_kind_to_project after insert or update of kind, project_type on pulse.work_project
  for each row execute function pulse.work_project_kind_to_project();

-- ------------------------------------------------------------------------------------------------ 2. started by AI
alter table pulse.work_project add column started_by text not null default 'person' check (started_by in ('person', 'ai'));

-- An AI employee's or an approved automation's new project is marked as started by AI.
create function pulse.work_project_started_by() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare actor text := coalesce(current_setting('pulse.actor_account', true), '');
begin
  if actor like 'agent:%' or actor like '% · approver:%'
     or exists (select 1 from person p where p.id = coalesce(new.created_by, current_viewer()) and p.side = 'agent') then
    new.started_by := 'ai';
  end if;
  return new;
end $$;
revoke all on function pulse.work_project_started_by() from public;
create trigger work_project_started_by before insert on pulse.work_project for each row execute function pulse.work_project_started_by();

-- Keep a project in the main list ('person'), or move it back under "Started by AI" ('ai'). Whoever may manage it.
create function pulse.work_project_started_set(p_project uuid, p_by text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := task_require_viewer(); was text;
begin
  if p_by not in ('person', 'ai') then raise exception 'Choose person or ai' using errcode = '22023'; end if;
  select started_by into was from work_project where org_id = current_org() and project_id = p_project and deleted_at is null for update;
  if not found then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if not work_project_can_manage(p_project) then raise exception 'Only the project owner, the head of its team or leadership can move this project' using errcode = '42501'; end if;
  if was is distinct from p_by then
    update work_project set started_by = p_by, updated_by = me, updated_at = now() where project_id = p_project;
    insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
    values (current_org(), 'project', p_project, 'started_by', was, p_by, me);
    perform audit_write('work_project_started_set', 'project', p_project::text);
  end if;
  return jsonb_build_object('id', p_project, 'startedBy', p_by);
end $$;
revoke all on function pulse.work_project_started_set(uuid, text) from public;
grant execute on function pulse.work_project_started_set(uuid, text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ backfill, per org
-- Forced row security filters by the organisation, so each organisation is done with its own setting. Owner only (the
-- migration runs it once over every organisation; a test runs it on its own synthetic one). Returns what it changed.
create function pulse.work_project_type_backfill(p_orgs uuid[] default null) returns jsonb
  language plpgsql set search_path = pulse, pg_temp as $$
declare o record; was text := current_setting('pulse.org_id', true); n int; typed int := 0; kinds int := 0; packages int := 0; ai int := 0;
begin
  for o in select id from org where p_orgs is null union select unnest(p_orgs) loop
    perform set_config('pulse.org_id', o.id::text, true);
    with want as (
      select wp.project_id, case
          when wp.project_type = 'personal' then 'personal'
          when wp.kind = 'internal' then 'internal'
          when p.client_id is not null or p.storage_root is not null or wp.project_type = 'client_delivery'
            or exists (select 1 from work_project_link l where l.org_id = o.id and l.project_id = wp.project_id and l.status = 'linked') then 'client_delivery'
          else 'internal' end t
        from work_project wp join project p on p.id = wp.project_id
       where wp.org_id = o.id)
    update work_project wp set project_type = want.t from want
     where wp.project_id = want.project_id and wp.org_id = o.id and wp.project_type is distinct from want.t;
    get diagnostics n = row_count; typed := typed + n;
    -- A project whose type already matched still gets kinds that agree with it.
    update work_project wp set kind = case when wp.project_type = 'client_delivery' then 'fulfilment' else 'internal' end
     where wp.org_id = o.id and wp.kind is distinct from case when wp.project_type = 'client_delivery' then 'fulfilment' else 'internal' end;
    get diagnostics n = row_count; kinds := kinds + n;
    update project p set kind = case when wp.project_type = 'client_delivery' then 'client_work' else 'internal' end
      from work_project wp
     where wp.project_id = p.id and p.org_id = o.id and wp.org_id = o.id
       and p.kind is distinct from case when wp.project_type = 'client_delivery' then 'client_work' else 'internal' end;
    get diagnostics n = row_count; packages := packages + n;
    -- Started by AI: made by an AI employee, or by an approved automation (from the audit's actor).
    update work_project wp set started_by = 'ai'
      from (select distinct a.resource_id from audit_event a
             where a.org_id = o.id and a.resource = 'project' and a.action in ('insert', 'work_project_create')
               and (a.actor_account like 'agent:%' or a.actor_account like '% · approver:%')) a
     where wp.org_id = o.id and a.resource_id = wp.project_id::text and wp.started_by <> 'ai';
    get diagnostics n = row_count; ai := ai + n;
    update work_project wp set started_by = 'ai'
     where wp.org_id = o.id and wp.started_by <> 'ai'
       and exists (select 1 from person p where p.id = wp.created_by and p.side = 'agent');
    get diagnostics n = row_count; ai := ai + n;
  end loop;
  perform set_config('pulse.org_id', coalesce(was, ''), true);
  return jsonb_build_object('typed', typed, 'kinds', kinds, 'packages', packages, 'ai', ai);
end $$;
revoke all on function pulse.work_project_type_backfill(uuid[]) from public;
select pulse.work_project_type_backfill();

-- migrate:down
-- Forward-only: project types and who started a project are company records.
