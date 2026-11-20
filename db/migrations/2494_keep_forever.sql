-- migrate:up
-- NO-DATA-LOSS-4 (owner, 20 Nov 2026 ~21:35 IST: "Vitals OS needs to keep all the data forever ... to make the
-- experience better"; the new notice texts approved ~21:50 IST, "Yes, approve it", and shipped in the same land).
-- Screen replays, usage, the listening sound and the phone/desktop apps' raw readings are no longer deleted because of
-- their age or size. Each function below is its latest definition with only those deletes taken out:
--   telemetry_retention   (2300): replays past replay_days (7 by default), usage past retention_days (30) and, over 80%
--                                 of the server's replay cap, the oldest replays of any company went every hour; now
--                                 nothing is deleted.
--   telemetry_replay_room (2300): a company's oldest replay chunks were deleted to keep it under its budget (1 GiB);
--                                 now nothing is deleted and the company budget no longer applies. The server's hard
--                                 cap (telemetry_replay_cap, 3 GiB on disk) still refuses NEW chunks above it, except a
--                                 bug report's, so replays can never fill the disk; nothing stored is removed.
--   telemetry_maintain    (2105): raw usage older than 90 days (app) and 30 days (server) was deleted after the daily
--                                 rollup; the rollup is unchanged and the raw rows are kept.
--   listen_chunk_done     (1685, timing base 2092): the recorded sound was thrown away once it was written down (or after 3 failed
--                                 tries); now it is kept with the words. Instant-words mode is unchanged: there the
--                                 sound goes from the browser to Google and never reaches Pulse.
--   native_prune          (0103): the apps' raw readings, their ingest receipts and batches went after 7 days (or the
--                                 company notice's rawDays); now kept. Kept as before: readings collected under a
--                                 purpose notice that was withdrawn are erased (consent withdrawn), and expired sign-in
--                                 tokens go.
-- A person's erasure request, switching an optional feature off, revoking a device, and a person's own delete are
-- unchanged. Settings that chose how long to keep usage and replays (telemetry_setting.retention_days, replay_days,
-- replay_budget_mb) stay in the table but no longer delete anything; the screens no longer offer them.
-- Undo: re-apply the definitions from the migrations named above.

create or replace function pulse.telemetry_retention() returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  -- NO-DATA-LOSS-4: replays and usage are kept whatever their age or size (the friction scan still runs after it).
  return jsonb_build_object('replays', 0, 'events', 0, 'trimmedBatches', 0, 'kept', true);
end
$$;

/** Before a chunk of p_bytes is stored in this company: it fits unless the server's replays are over the hard cap (a
 *  bug report's chunk still goes). Nothing stored is deleted to make room (NO-DATA-LOSS-4). */
create or replace function pulse.telemetry_replay_room(p_bytes integer, p_reason text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare used bigint; disk bigint := pg_total_relation_size('pulse.telemetry_replay');
begin
  select coalesce(sum(bytes), 0) into used from telemetry_replay where org_id = current_org();
  return jsonb_build_object('fits', disk < telemetry_replay_cap() or p_reason = 'report', 'used', used, 'budget', null, 'freed', 0, 'disk', disk);
end $$;

create or replace function pulse.telemetry_maintain(p_client_days integer default 90, p_server_days integer default 30)
returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  o record; v_today date; v_from date; n integer; v_rolled integer := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('pulse.telemetry_maintain')) then return jsonb_build_object('skipped', true); end if;
  for o in select id, time_zone from org loop
    perform set_config('pulse.org_id', o.id::text, true);
    v_today := (now() at time zone o.time_zone)::date;
    v_from := greatest(v_today - 7, least(v_today - 1, coalesce((select max(day) from telemetry_daily where org_id = o.id), v_today - 7)));
    -- The last week's rollup is rebuilt from the raw rows (derived figures, not history).
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
    -- NO-DATA-LOSS-4: the raw usage rows are kept whatever their age (p_client_days and p_server_days no longer delete).
  end loop;
  return jsonb_build_object('rolled', v_rolled, 'removed', 0);
end $$;

create or replace function pulse.listen_chunk_done(p_session uuid, p_seq int, p_segments jsonb, p_error text default null) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k pulse_priv.listen_chunk; base int; x jsonb; i int := 0;
begin
  select * into k from pulse_priv.listen_chunk where org_id = current_org() and session_id = p_session and seq = p_seq for update;
  if not found then return; end if;
  if p_error is not null then
    -- After 3 failed tries the piece is marked failed; its sound is kept (NO-DATA-LOSS-4).
    update pulse_priv.listen_chunk set state = case when attempts >= 3 then 'failed' else 'queued' end
     where session_id = k.session_id and seq = k.seq;
    return;
  end if;
  select coalesce(sum(ms), 0) into base from pulse_priv.listen_chunk where session_id = k.session_id and seq < k.seq;
  -- LISTEN-FAST (2092): a Whisper piece after live words starts where the live words ended.
  base := greatest(base, coalesce((select max(end_ms) from listen_segment where session_id = k.session_id and seq < k.seq), 0));
  for x in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb)) loop
    if coalesce(btrim(x->>'t'), '') <> '' then
      insert into listen_segment (org_id, session_id, seq, part, start_ms, end_ms, text)
      values (current_org(), k.session_id, k.seq, i, base + round(coalesce((x->>'s')::numeric, 0) * 1000)::int, base + round(coalesce((x->>'e')::numeric, 0) * 1000)::int, left(btrim(x->>'t'), 4000))
      on conflict (session_id, seq, part) do nothing;
      i := i + 1;
    end if;
  end loop;
  -- NO-DATA-LOSS-4: the sound is kept with the words (it used to be dropped here once written down).
  update pulse_priv.listen_chunk set state = 'done' where session_id = k.session_id and seq = k.seq;
end $$;

create or replace function pulse.native_prune() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare raw integer;tokens integer;begin
 -- Readings collected under a purpose notice that was withdrawn are erased (consent withdrawn). NO-DATA-LOSS-4: the
 -- others, their ingest receipts and batches are kept whatever their age.
 delete from native_event e where e.org_id=current_org() and exists(
 select 1 from native_permission p join pulse_priv.fair_notice n on n.id=p.notice_id and n.org_id=p.org_id
 where p.id=e.consent_receipt and p.org_id=e.org_id and n.withdrawn_at is not null);
 get diagnostics raw=row_count;
 delete from pulse_priv.native_token where org_id=current_org() and refresh_until<now()-interval '7 days';get diagnostics tokens=row_count;
 return jsonb_build_object('eventsRemoved',raw,'sourceAcksRemoved',0,'batchesRemoved',0,'expiredTokensRemoved',tokens);
end $$;

-- migrate:down
-- Forward-only: nothing is removed by age any more.
