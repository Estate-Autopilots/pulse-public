-- migrate:up
-- KAZUK-REST slice 5 (E1/E2, Kazuk's 3 Nov meeting): bug reports from every company also land on the Pulse dev team's
-- board, in one organisation the platform names (the Pulse dev organisation: by default Vitals Technologies), with the reporting company noted and a
-- way back to the original. Nothing private is copied: no words the person typed, no picture, recording, replay, errors,
-- calls, steps, names, e-mail addresses or phone numbers. Only the kind, a short title (the item's own board title with
-- addresses and numbers masked, else "Bug on <screen>"), the screen's route pattern, the severity, whether it stopped
-- work, the app, browser and system, and counts. The full report stays in its company; a platform admin opens it in the
-- admin console (/bugs/<org>/<id>), where every look is written to the platform audit log.
--   pulse_priv.dev_board      the setting: which organisation is the Pulse dev organisation (one row). A platform admin
--                             changes it with pulse.platform_dev_board_set (GET/POST /api/v0/platform/dev-board). It is
--                             seeded below with the handle vitalstechnologies (Vitals Technologies), used once that
--                             organisation exists; with no row, or no such organisation, reports stay where they are.
--   pulse.dev_bug_inbox       the routed summaries: rows of the dev organisation (forced row security, tenant policy),
--                             made into the dev organisation's own task there. There is ONE triage status per report:
--                             BUGKIT's (pulse.reported_bug.status in the reporting company). The inbox row mirrors it
--                             (trigger reported_bug_status_mirror), and the dev organisation's status change is written
--                             to the original report, in its history as "Pulse dev team" (pulse.dev_bug_inbox_set), so
--                             the company, the admin console and the dev board never disagree.
--   reported_bug_route        AFTER INSERT on reported_bug: copies the summary into the dev organisation's inbox. It
--                             composes with BUGKIT-TELEMETRY's task in the reporting company (made by the API after the
--                             insert), and it never fails a report: an error while routing is only a warning.
create table pulse_priv.dev_board (
  one boolean primary key default true check (one),
  dev_org uuid references pulse.org(id),                          -- the named organisation, else the one with dev_handle
  dev_handle text check (dev_handle ~ '^[a-z0-9][a-z0-9._]{2,29}$'),
  set_by text not null check (length(set_by) between 1 and 120),
  set_at timestamptz not null default now()
);
-- Install-level and owner-only like pulse_priv.platform_admin (no org_id, no runtime grants): read through
-- pulse.dev_board_org() and written through pulse.platform_dev_board_set() only; on the global allow-list of
-- tests/core/test_acceptance_isolation.py.
revoke all on pulse_priv.dev_board from public;
alter table pulse_priv.dev_board add check (dev_org is not null or dev_handle is not null);
-- The default (platform data, not code): Vitals Technologies, by its handle.
insert into pulse_priv.dev_board (one, dev_handle, set_by) values (true, 'vitalstechnologies', 'Pulse default (migration 1708)');

create table pulse.dev_bug_inbox (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),                 -- the Pulse dev organisation
  source_org uuid not null references pulse.org(id),
  source_org_name text not null check (length(source_org_name) between 1 and 200),
  source_report uuid not null unique,                             -- pulse.reported_bug(id) in source_org (never readable here)
  source_number integer not null check (source_number > 0),
  kind text not null default 'bug' check (kind in ('bug', 'tool_needed', 'feature')),
  title text not null check (length(btrim(title)) between 3 and 160),
  route text not null check (length(route) between 1 and 300),
  severity text check (severity in ('blocker', 'high', 'medium', 'low')),
  blocks_work boolean not null default false,
  platform text not null default 'web' check (platform in ('web', 'android', 'ios', 'desktop')),
  app_version text check (length(app_version) <= 60),
  browser text check (length(browser) <= 40),
  os text check (length(os) <= 40),
  signed_out boolean not null default false,
  by_agent boolean not null default false,
  error_count integer not null default 0 check (error_count >= 0),
  call_count integer not null default 0 check (call_count >= 0),
  step_count integer not null default 0 check (step_count >= 0),
  reported_at timestamptz not null,
  status text not null default 'new' check (status in ('new', 'triaged', 'fixing', 'fixed', 'wontfix')),
  status_at timestamptz not null default now(),
  task_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (source_org <> org_id)
);
create index dev_bug_inbox_recent on pulse.dev_bug_inbox (org_id, status, reported_at desc);
alter table pulse.dev_bug_inbox enable row level security;
alter table pulse.dev_bug_inbox force row level security;
create policy tenant on pulse.dev_bug_inbox using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- The dev organisation's leadership reads and triages its inbox (the API checks leadership); rows arrive only through the
-- trigger below, so the API role may not insert or delete.
grant select, update (task_id, updated_at) on pulse.dev_bug_inbox to pulse_api;   -- status only through pulse.dev_bug_inbox_set

/** The Pulse dev organisation: the one the setting names (by id, else by handle), else none. */
create function pulse.dev_board_org() returns uuid
language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(d.dev_org, (select g.id from pulse.org g where g.handle = d.dev_handle)) from pulse_priv.dev_board d where d.one
$$;
revoke all on function pulse.dev_board_org() from public;
grant execute on function pulse.dev_board_org() to pulse_api;

/** The title the dev team sees: the item's own short board title with e-mail addresses and long numbers masked, else
 *  "Bug on <screen>". Never the words the person typed. */
create function pulse.dev_bug_title(p_kind text, p_title text, p_route text) returns text
language sql immutable set search_path = pulse, pg_temp as $$
  select left(coalesce(
    nullif(btrim(regexp_replace(regexp_replace(regexp_replace(coalesce(p_title, ''), '[[:cntrl:]]+', ' ', 'g'),
      '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+', '[email]', 'g'), '\+?[0-9][0-9 ().-]{6,}[0-9]', '[number]', 'g')), ''),
    case p_kind when 'feature' then 'Idea' when 'tool_needed' then 'Tool needed' else 'Bug' end || ' on ' || coalesce(nullif(p_route, ''), '/')), 160)
$$;
revoke all on function pulse.dev_bug_title(text, text, text) from public;
grant execute on function pulse.dev_bug_title(text, text, text) to pulse_api;

create function pulse.reported_bug_route() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_dev uuid; v_back text := coalesce(current_setting('pulse.org_id', true), ''); v_name text;
begin
  v_dev := dev_board_org();
  if v_dev is null or v_dev = new.org_id then return null; end if;
  begin
    select g.name into v_name from org g where g.id = new.org_id;   -- read as the reporting company (row security on org)
    perform set_config('pulse.org_id', v_dev::text, true);
    insert into dev_bug_inbox (org_id, source_org, source_org_name, source_report, source_number, kind, title, route, severity, blocks_work,
        platform, app_version, browser, os, signed_out, by_agent, error_count, call_count, step_count, reported_at)
    values (v_dev, new.org_id, left(coalesce(nullif(btrim(v_name), ''), 'A company'), 200), new.id, new.number, coalesce(new.kind, 'bug'),
        dev_bug_title(new.kind, new.title, new.route), left(new.route, 300), new.severity, new.blocks_work, new.platform, new.app_version,
        nullif(left(new.context ->> 'browser', 40), ''), nullif(left(new.context ->> 'os', 40), ''), new.signed_out, coalesce(new.by_agent, false),
        jsonb_array_length(new.errors), jsonb_array_length(new.network), jsonb_array_length(new.trail), new.created_at)
    on conflict (source_report) do nothing;
    perform set_config('pulse.org_id', v_back, true);
  exception when others then
    -- Routing never loses the report: the block (and the organisation it switched to) is undone, and the report stays.
    raise warning 'reported_bug_route: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end $$;
revoke all on function pulse.reported_bug_route() from public;
create trigger reported_bug_route after insert on pulse.reported_bug for each row execute function pulse.reported_bug_route();

/** The setting as the admin console shows it: the organisation (if found), the handle, who set it and when. */
create function pulse.platform_dev_board() returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare d pulse_priv.dev_board; v_org uuid; v_name text;
begin
  perform platform_guard();
  select * into d from pulse_priv.dev_board where one;
  v_org := dev_board_org();
  select g.name into v_name from org g where g.id = v_org;
  return jsonb_build_object('orgId', v_org, 'name', v_name, 'handle', d.dev_handle, 'found', v_org is not null,
    'setBy', d.set_by, 'setAt', d.set_at);
end $$;
revoke all on function pulse.platform_dev_board() from public;
grant execute on function pulse.platform_dev_board() to pulse_api;

/** A platform admin names the Pulse dev organisation (null: back to the default, Vitals Technologies by handle). */
create function pulse.platform_dev_board_set(p_org uuid) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_name text;
begin
  perform platform_guard();
  if p_org is null then
    -- Back to the default: Vitals Technologies, by its handle.
    insert into pulse_priv.dev_board (one, dev_org, dev_handle, set_by) values (true, null, 'vitalstechnologies', 'Pulse default')
      on conflict (one) do update set dev_org = null, dev_handle = excluded.dev_handle, set_by = excluded.set_by, set_at = now();
    perform platform_log('dev_board.clear', null, 'org', null, null, null, '{}');
    return platform_dev_board();
  end if;
  select g.name into v_name from org g where g.id = p_org;
  if v_name is null then
    perform platform_enter(p_org); select g.name into v_name from org g where g.id = p_org; perform platform_leave();
  end if;
  if v_name is null then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  insert into pulse_priv.dev_board (one, dev_org, dev_handle, set_by) values (true, p_org, (select g.handle from org g where g.id = p_org),
      left(coalesce((select display_name from person where id = current_viewer()), 'Pulse platform admin'), 120))
    on conflict (one) do update set dev_org = excluded.dev_org, dev_handle = excluded.dev_handle, set_by = excluded.set_by, set_at = now();
  perform platform_log('dev_board.set', p_org, 'org', p_org::text, v_name, null, '{}');
  return platform_dev_board();
end $$;
revoke all on function pulse.platform_dev_board_set(uuid) from public;
grant execute on function pulse.platform_dev_board_set(uuid) to pulse_api;

/** BUGKIT's triage of the original (in its company, or the admin console) shows on the dev board: one status per report. */
create function pulse.reported_bug_status_mirror() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_dev uuid; v_back text := coalesce(current_setting('pulse.org_id', true), '');
begin
  if new.status is not distinct from old.status then return null; end if;
  v_dev := dev_board_org();
  if v_dev is null or v_dev = new.org_id then return null; end if;
  begin
    perform set_config('pulse.org_id', v_dev::text, true);
    update dev_bug_inbox set status = new.status, status_at = now(), updated_at = now()
      where source_report = new.id and status is distinct from new.status;
    perform set_config('pulse.org_id', v_back, true);
  exception when others then
    raise warning 'reported_bug_status_mirror: % (%)', sqlerrm, sqlstate;
  end;
  return null;
end $$;
revoke all on function pulse.reported_bug_status_mirror() from public;
create trigger reported_bug_status_mirror after update of status on pulse.reported_bug for each row execute function pulse.reported_bug_status_mirror();

/** The dev organisation triages a routed report: the status is written to the original report (BUGKIT's one triage),
 *  with a line in its history from "Pulse dev team", and mirrored here. Only from the dev organisation itself; the API
 *  checks leadership first. Returns the inbox row's id, or null when it is not this organisation's. */
create function pulse.dev_bug_inbox_set(p_id uuid, p_status text) returns uuid
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare i dev_bug_inbox; v_back text := coalesce(current_setting('pulse.org_id', true), '');
begin
  if p_status is null or p_status not in ('new', 'triaged', 'fixing', 'fixed', 'wontfix') then raise exception 'Choose a status' using errcode = '22023'; end if;
  if current_org() is null or dev_board_org() is distinct from current_org() then return null; end if;
  select * into i from dev_bug_inbox where id = p_id and org_id = current_org() for update;
  if not found then return null; end if;
  if i.status = p_status then return i.id; end if;
  update dev_bug_inbox set status = p_status, status_at = now(), updated_at = now() where id = i.id;
  perform set_config('pulse.org_id', i.source_org::text, true);
  update reported_bug set status = p_status, status_at = now(), updated_at = now() where id = i.source_report and org_id = i.source_org and status <> p_status;
  if found then
    insert into reported_bug_event (org_id, report_id, kind, value, note) values (i.source_org, i.source_report, 'status', p_status, 'Pulse dev team');
  end if;
  perform set_config('pulse.org_id', v_back, true);
  return i.id;
end $$;
revoke all on function pulse.dev_bug_inbox_set(uuid, text) from public;
grant execute on function pulse.dev_bug_inbox_set(uuid, text) to pulse_api;

-- migrate:down
drop function if exists pulse.dev_bug_inbox_set(uuid, text);
drop trigger if exists reported_bug_status_mirror on pulse.reported_bug;
drop function if exists pulse.reported_bug_status_mirror();
drop function if exists pulse.platform_dev_board_set(uuid);
drop function if exists pulse.platform_dev_board();
drop trigger if exists reported_bug_route on pulse.reported_bug;
drop function if exists pulse.reported_bug_route();
drop function if exists pulse.dev_bug_title(text, text, text);
drop function if exists pulse.dev_board_org();
drop table if exists pulse.dev_bug_inbox;
drop table if exists pulse_priv.dev_board;
