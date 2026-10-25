-- migrate:up
-- TELEMETRY (owner, 24 Oct 2026): "every single movement in the app must be tracked, so we can improve response times".
--   telemetry_event   one row per movement: a page load or route change (with the time until its content painted), a
--                     click or tap (element identifier, time until the screen settled), a form submit (field names only),
--                     a dialog, panel or tab, scroll depth, web vitals (LCP, INP, CLS, TTFB, FCP) and long tasks, every
--                     API call the browser made (route template, status, duration, size, request id) and the API's own
--                     timing of every request (source 'server', with its database time), JS errors and failed fetches,
--                     going offline or to the background. Never typed text, message bodies, file contents, passwords or
--                     tokens: the collector and the API both reduce names to templates and drop anything else.
--   telemetry_daily   daily rollups (count, errors, people, sessions, p50/p75/p95/avg/max) per kind and route, per app
--                     version and platform, and per role; kept after the raw rows expire.
-- Retention: telemetry_maintain() rolls up and deletes raw client rows after 90 days and server timing after 30; the API
-- calls it hourly. Row-level security is forced like every company table; the API inserts within the viewer's company.
-- Leadership and admins read it in Pulse at /telemetry. Uses only objects defined in this repository's migrations
-- (pulse.org 0001, pulse.current_org 0001). Safe on a live install: additive.

create table pulse.telemetry_event (
  id bigint generated always as identity primary key,
  org_id uuid not null references pulse.org(id),
  at timestamptz not null,
  received_at timestamptz not null default now(),
  source text not null check (source in ('client', 'server')),
  kind text not null check (length(kind) <= 40 and kind ~ '^[a-z]+(\.[a-z0-9_]+){0,2}$'),
  name text check (length(name) <= 200),
  page text check (length(page) <= 200),
  duration_ms integer check (duration_ms between 0 and 86400000),
  value double precision,
  status smallint check (status between 0 and 999),
  session_id text check (session_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  request_id text check (request_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  person_id uuid,
  role text check (length(role) <= 40),
  app_version text check (length(app_version) <= 60),
  shell_version text check (length(shell_version) <= 30),
  platform text check (platform in ('web', 'android', 'ios', 'desktop', 'server')),
  device text check (device in ('phone', 'tablet', 'desktop')),
  detail jsonb check (detail is null or (jsonb_typeof(detail) = 'object' and length(detail::text) <= 4000))
);
create index telemetry_event_at on pulse.telemetry_event using brin (at);
create index telemetry_event_kind on pulse.telemetry_event (org_id, kind, at);
create index telemetry_event_session on pulse.telemetry_event (org_id, session_id, at) where session_id is not null;
create index telemetry_event_person on pulse.telemetry_event (org_id, person_id, at) where person_id is not null;
create index telemetry_event_request on pulse.telemetry_event (request_id) where request_id is not null;
alter table pulse.telemetry_event enable row level security;
alter table pulse.telemetry_event force row level security;
create policy tenant on pulse.telemetry_event using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select, insert on pulse.telemetry_event to pulse_api;
grant usage on sequence pulse.telemetry_event_id_seq to pulse_api;

create table pulse.telemetry_daily (
  org_id uuid not null references pulse.org(id),
  day date not null,
  source text not null,
  kind text not null,
  name text not null default '*',
  platform text not null default '*',
  app_version text not null default '*',
  role text not null default '*',
  events integer not null,
  errors integer not null,
  people integer not null,
  sessions integer not null,
  p50_ms double precision,
  p75_ms double precision,
  p95_ms double precision,
  avg_ms double precision,
  max_ms double precision,
  primary key (org_id, day, source, kind, name, platform, app_version, role)
);
alter table pulse.telemetry_daily enable row level security;
alter table pulse.telemetry_daily force row level security;
create policy tenant on pulse.telemetry_daily using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.telemetry_daily to pulse_api;

/** Rolls up each organisation's telemetry by day (from the last rolled day, at most a week back, in the organisation's
 *  time zone) and deletes raw rows past retention. One run at a time; a second caller returns {skipped:true}. */
create function pulse.telemetry_maintain(p_client_days integer default 90, p_server_days integer default 30)
returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  o record; v_today date; v_from date; n integer; v_rolled integer := 0; v_removed integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('pulse.telemetry_maintain')) then return jsonb_build_object('skipped', true); end if;
  for o in select id, time_zone from org loop
    perform set_config('pulse.org_id', o.id::text, true);
    v_today := (now() at time zone o.time_zone)::date;
    v_from := greatest(v_today - 7, least(v_today - 1, coalesce((select max(day) from telemetry_daily where org_id = o.id), v_today - 7)));
    delete from telemetry_daily where org_id = o.id and day >= v_from;
    insert into telemetry_daily (org_id, day, source, kind, name, platform, app_version, role, events, errors, people, sessions,
                                 p50_ms, p75_ms, p95_ms, avg_ms, max_ms)
    select o.id, x.d, x.source, x.kind,
           case when grouping(x.name) = 0 then coalesce(x.name, '') else '*' end,
           case when grouping(x.platform) = 0 then coalesce(x.platform, '') else '*' end,
           case when grouping(x.app_version) = 0 then coalesce(x.app_version, '') else '*' end,
           case when grouping(x.role) = 0 then coalesce(x.role, '') else '*' end,
           count(*)::int,
           (count(*) filter (where x.kind like 'error.%' or (x.kind in ('api', 'api.server') and (x.status = 0 or x.status >= 500))))::int,
           count(distinct x.person_id)::int, count(distinct x.session_id)::int,
           percentile_cont(0.5) within group (order by x.duration_ms), percentile_cont(0.75) within group (order by x.duration_ms),
           percentile_cont(0.95) within group (order by x.duration_ms), avg(x.duration_ms), max(x.duration_ms)
      from (select e.source, e.kind, e.name, e.platform, e.app_version, e.role, e.status, e.person_id, e.session_id, e.duration_ms,
                   (e.at at time zone o.time_zone)::date d
              from telemetry_event e
             where e.org_id = o.id and e.at >= (v_from::timestamp at time zone o.time_zone)) x
     group by x.d, x.source, x.kind, grouping sets ((x.name), (x.platform, x.app_version), (x.role), ());
    get diagnostics n = row_count; v_rolled := v_rolled + n;
    delete from telemetry_event where org_id = o.id and source = 'client' and at < now() - make_interval(days => p_client_days);
    get diagnostics n = row_count; v_removed := v_removed + n;
    delete from telemetry_event where org_id = o.id and source = 'server' and at < now() - make_interval(days => p_server_days);
    get diagnostics n = row_count; v_removed := v_removed + n;
  end loop;
  return jsonb_build_object('rolled', v_rolled, 'removed', v_removed);
end $$;
revoke execute on function pulse.telemetry_maintain(integer, integer) from public;
grant execute on function pulse.telemetry_maintain(integer, integer) to pulse_api, pulse_worker;

-- migrate:down
-- Forward-only.
