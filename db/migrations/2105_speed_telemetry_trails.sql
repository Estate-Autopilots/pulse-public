-- migrate:up
-- SPEED-TELEMETRY (owner, 14 Nov 2026: "every movement tracked: load time, how people move in the app, maps and trails, so
-- we can build AI models and smart features ... speed is very, very important"). Builds on telemetry (0983) and
-- BUGKIT-TELEMETRY (1682); no new table, nothing leaves the server.
--   telemetry_maintain() also rolls each day's movements into telemetry_daily, kept after the raw rows expire:
--     trail.move   name "<from> > <to>": moves from one screen to the next (nav.route's x.from), with the people and
--                  sessions that made them and the time the next screen took (p50/p75/p95/avg/max); errors = moves cut
--                  off after 10 s
--     trail.time   name = screen: active time on it per page view (nav.leave's x.act; idle time is not counted)
--     trail.exit   name = screen: where sessions ended that day (the last screen of each session)
--   Speed figures leave out movements the page spent partly hidden (x.bg: a phone asleep, a background tab), which the
--   collector now marks: one API call "took" 91 minutes, and 17 of 82 page loads in a day were background tabs. Counts
--   still include them.
-- Same signature, owner and grants; additive (only rows of the re-rolled last week change). Uses only objects defined in
-- this repository's migrations (telemetry_event and telemetry_daily 0983, org 0001).

create or replace function pulse.telemetry_maintain(p_client_days integer default 90, p_server_days integer default 30)
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
           percentile_cont(0.5) within group (order by x.duration_ms) filter (where not x.bg),
           percentile_cont(0.75) within group (order by x.duration_ms) filter (where not x.bg),
           percentile_cont(0.95) within group (order by x.duration_ms) filter (where not x.bg),
           avg(x.duration_ms) filter (where not x.bg), max(x.duration_ms) filter (where not x.bg)
      from (select e.source, e.kind, e.name, e.platform, e.app_version, e.role, e.status, e.person_id, e.session_id, e.duration_ms,
                   coalesce(e.detail ? 'bg', false) as bg, (e.at at time zone o.time_zone)::date d
              from telemetry_event e
             where e.org_id = o.id and e.at >= (v_from::timestamp at time zone o.time_zone)) x
     group by x.d, x.source, x.kind, grouping sets ((x.name), (x.platform, x.app_version), (x.role), ());
    get diagnostics n = row_count; v_rolled := v_rolled + n;

    -- How people move: screen to screen, active time per screen, and where sessions end.
    insert into telemetry_daily (org_id, day, source, kind, name, events, errors, people, sessions, p50_ms, p75_ms, p95_ms, avg_ms, max_ms)
    select o.id, m.d, 'client', 'trail.move', m.move, count(*)::int,
           (count(*) filter (where m.cut = 'timeout'))::int, count(distinct m.person_id)::int, count(distinct m.session_id)::int,
           percentile_cont(0.5) within group (order by m.duration_ms) filter (where not m.bg),
           percentile_cont(0.75) within group (order by m.duration_ms) filter (where not m.bg),
           percentile_cont(0.95) within group (order by m.duration_ms) filter (where not m.bg),
           avg(m.duration_ms) filter (where not m.bg), max(m.duration_ms) filter (where not m.bg)
      from (select left((e.detail->>'from') || ' > ' || e.name, 200) as move, e.person_id, e.session_id, e.duration_ms, e.detail->>'cut' as cut,
                   coalesce(e.detail ? 'bg', false) as bg, (e.at at time zone o.time_zone)::date d
              from telemetry_event e
             where e.org_id = o.id and e.source = 'client' and e.kind = 'nav.route' and e.name is not null and e.detail->>'from' is not null
               and e.at >= (v_from::timestamp at time zone o.time_zone)) m
     group by m.d, m.move;
    get diagnostics n = row_count; v_rolled := v_rolled + n;
    insert into telemetry_daily (org_id, day, source, kind, name, events, errors, people, sessions, p50_ms, p75_ms, p95_ms, avg_ms, max_ms)
    select o.id, t.d, 'client', 'trail.time', t.name, count(*)::int, 0, count(distinct t.person_id)::int, count(distinct t.session_id)::int,
           percentile_cont(0.5) within group (order by t.act), percentile_cont(0.75) within group (order by t.act),
           percentile_cont(0.95) within group (order by t.act), avg(t.act), max(t.act)
      from (select e.name, e.person_id, e.session_id, (e.detail->>'act')::double precision as act, (e.at at time zone o.time_zone)::date d
              from telemetry_event e
             where e.org_id = o.id and e.source = 'client' and e.kind = 'nav.leave' and e.name is not null
               and jsonb_typeof(e.detail->'act') = 'number' and e.at >= (v_from::timestamp at time zone o.time_zone)) t
     group by t.d, t.name;
    get diagnostics n = row_count; v_rolled := v_rolled + n;
    insert into telemetry_daily (org_id, day, source, kind, name, events, errors, people, sessions)
    select o.id, l.d, 'client', 'trail.exit', l.name, count(*)::int, 0, count(distinct l.person_id)::int, count(distinct l.session_id)::int
      from (select distinct on (e.session_id, (e.at at time zone o.time_zone)::date) e.session_id, e.person_id, e.name, (e.at at time zone o.time_zone)::date d
              from telemetry_event e
             where e.org_id = o.id and e.source = 'client' and e.kind in ('nav.load', 'nav.route') and e.session_id is not null and e.name is not null
               and e.at >= (v_from::timestamp at time zone o.time_zone)
             order by e.session_id, (e.at at time zone o.time_zone)::date, e.at desc, e.id desc) l
     group by l.d, l.name;
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

-- The platform admin's telemetry (1390) counts movements and ranks the slowest places from the same rollups: the trail
-- rows above are left out of both (a screen's time-on-page is not slowness). Otherwise exactly as in 1390.
create or replace function pulse.platform_telemetry(p_days int) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; v_days int := least(greatest(coalesce(p_days, 7), 1), 90); v_since date; v_orgs jsonb := '[]'; v_places jsonb := '[]'; v_part jsonb;
begin
  perform platform_guard();
  v_since := current_date - v_days;
  for o in select id, name from org where status = 'active' order by name loop
    perform platform_enter(o.id);
    select jsonb_build_object('id', o.id, 'name', o.name, 'events', coalesce(sum(events), 0), 'errors', coalesce(sum(errors), 0),
        'people', coalesce(max(people), 0), 'sessions', coalesce(sum(sessions), 0),
        'pageP75', (select round(avg(p75_ms)::numeric) from telemetry_daily t2 where t2.org_id = o.id and t2.day >= v_since and t2.kind = 'page'),
        'platforms', (select coalesce(jsonb_agg(distinct platform), '[]') from telemetry_daily t3 where t3.org_id = o.id and t3.day >= v_since and platform is not null))
      into v_part from telemetry_daily where org_id = o.id and day >= v_since and kind not like 'trail.%';
    if (v_part ->> 'events')::bigint > 0 then v_orgs := v_orgs || jsonb_build_array(v_part); end if;
    select coalesce(jsonb_agg(jsonb_build_object('org', o.name, 'kind', kind, 'name', name, 'events', events, 'errors', errors, 'p75', p75)), '[]')
      into v_part from (select kind, name, sum(events) events, sum(errors) errors, round(avg(p75_ms)::numeric) p75
                          from telemetry_daily where org_id = o.id and day >= v_since and kind not like 'trail.%' group by kind, name
                          order by sum(errors) desc, avg(p75_ms) desc nulls last limit 15) x;
    v_places := v_places || v_part;
    perform platform_leave();
  end loop;
  return jsonb_build_object('days', v_days, 'orgs', v_orgs,
    'slowest', (select coalesce(jsonb_agg(x order by (x ->> 'p75')::numeric desc nulls last), '[]') from (select x from jsonb_array_elements(v_places) x where x ->> 'p75' is not null order by (x ->> 'p75')::numeric desc limit 15) s),
    'failing', (select coalesce(jsonb_agg(x order by (x ->> 'errors')::numeric desc), '[]') from (select x from jsonb_array_elements(v_places) x where (x ->> 'errors')::numeric > 0 order by (x ->> 'errors')::numeric desc limit 15) s));
end $$;
revoke all on function pulse.platform_telemetry(int) from public;
grant execute on function pulse.platform_telemetry(int) to pulse_api;

-- migrate:down
-- Forward-only.
