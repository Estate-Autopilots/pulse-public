-- migrate:up
-- BUGKIT-TELEMETRY (owner, 6 Nov 2026: "a much stronger bug reporter, and full product telemetry that finds friction
-- before users even report it"). Builds on telemetry (0983) and the bug reporter (1201); nothing leaves the server.
--   telemetry_setting   one row per organisation (none = the defaults): usage recording on/off (default on), session
--                       replay on/off (default on), how long raw usage and replays are kept (default 30 days), the share of
--                       sessions recorded, whether Pulse may softly offer the reporter when someone looks stuck, whether a
--                       friction alert opens a bug task by itself, and the project (board) bug tasks go to.
--   telemetry_replay    session replay chunks: rrweb events recorded on the device with every typed value, password and
--                       data-private area masked there, gzip-compressed; read by leadership on the Insights friction tab.
--                       reason 'report' is the last minute a person chose to attach to a bug report.
--   friction_alert      a screen or element where people get stuck (rage clicks, dead clicks, errors, abandoned forms,
--                       idle on a form with errors, going back and forth), found hourly from telemetry before anyone
--                       reports it; open, dismissed, or turned into a bug task.
--   reported_bug        + the elements the person picked (selector, component, box, label, a comment thread each), what
--                       offered the reporter (a rage click…), the replay window attached, and an element key for grouping.
-- Retention: pulse.telemetry_retention() deletes replays older than the organisation's retention (default 30 days) and,
-- once an organisation has saved its own retention, raw client usage rows older than it (without a saved setting the
-- 0983 rule of 90 days stands). The daily rollups are kept.
-- Additive; uses only objects defined in this repository's migrations.

create table pulse.telemetry_setting (
  org_id uuid primary key references pulse.org(id),
  enabled boolean not null default true,
  replay boolean not null default true,
  retention_days integer not null default 30 check (retention_days between 7 and 365),
  sample numeric(4,3) not null default 1 check (sample between 0 and 1),
  replay_sample numeric(4,3) not null default 1 check (replay_sample between 0 and 1),
  prompts boolean not null default true,
  auto_task boolean not null default false,
  bug_project_id uuid,
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);

create table pulse.telemetry_replay (
  id bigint generated always as identity primary key,
  org_id uuid not null references pulse.org(id),
  session_id text not null check (session_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  seq integer not null check (seq between 0 and 100000),
  person_id uuid references pulse.person(id),
  route text check (length(route) <= 300),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  events integer not null check (events between 1 and 100000),
  reason text not null default 'sample' check (reason in ('sample', 'report')),
  bytes integer not null check (bytes between 1 and 3145728),
  data bytea not null,
  created_at timestamptz not null default now(),
  unique (org_id, session_id, seq),
  check (ended_at >= started_at)
);
create index telemetry_replay_recent on pulse.telemetry_replay (org_id, created_at desc);
create index telemetry_replay_route on pulse.telemetry_replay (org_id, route, started_at desc);

create table pulse.friction_alert (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  kind text not null check (kind in ('rage', 'dead', 'error', 'abandon', 'stuck', 'back')),
  route text not null check (length(route) between 1 and 300),
  target text not null default '' check (length(target) <= 200),
  label text check (length(label) <= 200),
  hits integer not null default 0 check (hits >= 0),
  people integer not null default 0 check (people >= 0),
  sample_session text check (sample_session ~ '^[A-Za-z0-9_-]{8,64}$'),
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'task', 'dismissed')),
  task_id uuid,
  updated_at timestamptz not null default now(),
  unique (org_id, kind, route, target)
);
create index friction_alert_open on pulse.friction_alert (org_id, status, last_at desc);

alter table pulse.reported_bug
  add column pins jsonb not null default '[]' check (jsonb_typeof(pins) = 'array' and length(pins::text) <= 40000),
  add column trigger text check (trigger in ('rage', 'dead', 'error', 'back', 'stuck')),
  add column replay_session text check (replay_session ~ '^[A-Za-z0-9_-]{8,64}$'),
  add column replay_from timestamptz,
  add column replay_to timestamptz,
  add column element_key text check (length(element_key) <= 400);
create index reported_bug_element on pulse.reported_bug (org_id, element_key);

do $$ declare t text; begin
  foreach t in array array['telemetry_setting', 'telemetry_replay', 'friction_alert'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  end loop;
end $$;
grant select, insert, update on pulse.telemetry_setting to pulse_api;
grant select, insert on pulse.telemetry_replay to pulse_api;
grant select, insert, update on pulse.friction_alert to pulse_api;

/** Hourly (installServerTiming's maintenance): replays past each organisation's retention go, and raw client usage rows
 *  past it when the organisation saved its own retention. Each organisation is read as itself (row security is forced). */
create function pulse.telemetry_retention() returns jsonb
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
revoke execute on function pulse.telemetry_retention() from public;
grant execute on function pulse.telemetry_retention() to pulse_api, pulse_worker;

/** Hourly: where people got stuck in the last 7 days, per screen and element, before anyone reported it. A rage click,
 *  dead click, idle on a form with errors or back-and-forth needs 5 hits from 2 people; an abandoned form 5 from 2; a
 *  script error 10. Existing alerts update their counts; a dismissed one stays dismissed. */
create function pulse.friction_scan() returns integer
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; v_total integer := 0; n integer;
begin
  if not pg_try_advisory_xact_lock(hashtext('pulse.friction_scan')) then return -1; end if;
  for o in select g.id from pulse.org g loop
    perform set_config('pulse.org_id', o.id::text, true);
    insert into friction_alert as a (org_id, kind, route, target, label, hits, people, sample_session, first_at, last_at)
    select o.id, k.kind, k.route, k.target, k.label, k.hits, k.people, k.sample, k.first_at, k.last_at
    from (
      select case when e.kind = 'ui.rage' then 'rage' when e.kind = 'ui.dead' then 'dead' when e.kind = 'ui.stuck' then 'stuck'
          when e.kind = 'ui.form.abandon' then 'abandon' when e.kind = 'nav.backloop' then 'back' else 'error' end as kind,
        coalesce(e.page, '/') as route,
        left(coalesce(case when e.kind like 'error.%' then e.name else e.detail->>'sel' end, ''), 200) as target,
        left(max(e.name), 200) as label, count(*)::int as hits, count(distinct e.person_id)::int as people,
        max(e.session_id) as sample, min(e.at) as first_at, max(e.at) as last_at
      from telemetry_event e
      where e.org_id = o.id and e.source = 'client' and e.at >= now() - interval '7 days'
        and e.kind in ('ui.rage', 'ui.dead', 'ui.stuck', 'ui.form.abandon', 'nav.backloop', 'error.js', 'error.promise', 'error.boundary')
      group by 1, 2, 3
    ) k
    where (k.kind = 'error' and k.hits >= 10) or (k.kind <> 'error' and k.hits >= 5 and k.people >= 2)
    on conflict (org_id, kind, route, target) do update
      set hits = excluded.hits, people = excluded.people, label = excluded.label, sample_session = excluded.sample_session,
        last_at = excluded.last_at, updated_at = now();
    get diagnostics n = row_count; v_total := v_total + n;
  end loop;
  perform set_config('pulse.org_id', '', true);
  return v_total;
end
$$;
revoke execute on function pulse.friction_scan() from public;
grant execute on function pulse.friction_scan() to pulse_api, pulse_worker;

-- migrate:down
drop function if exists pulse.friction_scan();
drop function if exists pulse.telemetry_retention();
alter table pulse.reported_bug drop column if exists pins, drop column if exists trigger, drop column if exists replay_session,
  drop column if exists replay_from, drop column if exists replay_to, drop column if exists element_key;
drop table if exists pulse.friction_alert;
drop table if exists pulse.telemetry_replay;
drop table if exists pulse.telemetry_setting;
