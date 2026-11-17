-- migrate:up
-- LISTEN-FAST (owner, 14 Nov 2026: "I'm waiting fifteen seconds... it is very, very slow. Not snappy"): Listen's words
-- show about a second after they are said. The browser streams the sound to Google's live speech-to-text
-- (gemini-3.5-transcribe-live) with a short-lived token the API makes from the server's key, so the key never reaches the
-- browser and the sound never sits on our server. The browser hands each finished sentence back here as a line of the
-- transcript (listen_words_add), and everything after that (the AI helper's windows, Keep as a meeting, retention) is
-- unchanged. The server's own Whisper stays the fallback: no key, the company switched it off, the month's budget is
-- spent, or the stream fails, and the room records pieces for Whisper as before.
--
-- * agent_channel_settings.listen_live: admins can keep the sound on the company's own server (slower words).
-- * pulse_priv.listen_live_use: one row per live stream (at most 12 minutes each: Google's sessions last 10), touched
--   while it runs. No content, only times: it is the meter that keeps the owner's speech bill under the monthly cap.
--   It is not removed with a deleted transcript, so deleting a session never gives budget back.
-- * listen_live_minutes_month(): the minutes streamed this calendar month (UTC) across every company on this install,
--   read one company at a time under row-level security (the projectors' pattern: ids from pulse.org, then
--   SET LOCAL pulse.org_id); it returns one number.
-- * listen_live_begin(session, cap) / listen_live_beat(use): start a stream if the cap leaves 10 minutes, and keep its
--   meter running; a beat after the cap says stop.
-- * listen_chunk_done: a Whisper piece after live words starts where the live words ended (the timing base is the later
--   of the earlier pieces' length and the last word's end).
-- * listen_forward: the AI helper reads the new words every 30 seconds (was 45) once 20 seconds of speech are new
--   (was 30), so what it does shows up sooner.

alter table pulse.agent_channel_settings add column listen_live boolean not null default true;

create table pulse_priv.listen_live_use (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  person_id uuid not null references pulse.person(id),
  started_at timestamptz not null default clock_timestamp(),
  last_at timestamptz not null default clock_timestamp(),
  check (last_at >= started_at and last_at <= started_at + interval '12 minutes')
);
create index listen_live_use_month on pulse_priv.listen_live_use(org_id, started_at);
create index listen_live_use_session on pulse_priv.listen_live_use(session_id);
alter table pulse_priv.listen_live_use enable row level security;
alter table pulse_priv.listen_live_use force row level security;
create policy tenant_isolation on pulse_priv.listen_live_use using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create function pulse.listen_live_minutes_month() returns numeric
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o uuid; mine text := current_setting('pulse.org_id', true); total numeric := 0;
        since timestamptz := date_trunc('month', clock_timestamp() at time zone 'UTC') at time zone 'UTC';
begin
  for o in select id from org order by id loop
    perform set_config('pulse.org_id', o::text, true);
    total := total + coalesce((select sum(extract(epoch from (u.last_at - u.started_at))) from pulse_priv.listen_live_use u
                                where u.org_id = o and u.started_at >= since), 0);
  end loop;
  perform set_config('pulse.org_id', coalesce(mine, ''), true);
  return round(total / 60, 1);
end $$;

create function pulse.listen_live_begin(p_session uuid, p_cap_minutes int) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s listen_session; st agent_channel_settings; used numeric; uid uuid;
begin
  select * into s from listen_session where org_id = current_org() and id = p_session;
  if not found or s.person_id is distinct from current_viewer() then raise exception 'Listening session not found' using errcode = 'P0002'; end if;
  if s.stopped_at is not null then raise exception 'This session has stopped' using errcode = '54000'; end if;
  select * into st from agent_channel_settings where org_id = current_org();
  if not coalesce(st.listen_live, true) then return jsonb_build_object('ok', false, 'why', 'off'); end if;
  used := listen_live_minutes_month();
  if used + 10 > greatest(coalesce(p_cap_minutes, 0), 0) then
    return jsonb_build_object('ok', false, 'why', 'budget', 'usedMinutes', used, 'capMinutes', p_cap_minutes);
  end if;
  -- Each stream's meter stops at its own last beat, so a new stream (Google's 10-minute session ended) needs no closing.
  insert into pulse_priv.listen_live_use (org_id, session_id, person_id) values (current_org(), s.id, s.person_id) returning id into uid;
  return jsonb_build_object('ok', true, 'useId', uid, 'usedMinutes', used, 'capMinutes', p_cap_minutes);
end $$;

create function pulse.listen_live_beat(p_use uuid, p_cap_minutes int) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare u pulse_priv.listen_live_use; used numeric;
begin
  select * into u from pulse_priv.listen_live_use where org_id = current_org() and id = p_use for update;
  if not found or u.person_id is distinct from current_viewer() then raise exception 'Live words not found' using errcode = 'P0002'; end if;
  update pulse_priv.listen_live_use set last_at = least(clock_timestamp(), started_at + interval '12 minutes') where id = u.id;
  used := listen_live_minutes_month();
  return jsonb_build_object('ok', true, 'stop', used >= greatest(coalesce(p_cap_minutes, 0), 0)
    or clock_timestamp() >= u.started_at + interval '12 minutes'
    or exists (select 1 from listen_session s where s.id = u.session_id and s.stopped_at is not null), 'usedMinutes', used);
end $$;

-- A finished sentence from the live words: one line of the transcript (part 0 of its own seq). A sentence may land a
-- moment after Stop, so a session stopped in the last two minutes still takes it.
create function pulse.listen_words_add(p_session uuid, p_seq int, p_start_ms int, p_end_ms int, p_text text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s listen_session; t text := btrim(regexp_replace(coalesce(p_text, ''), '[[:cntrl:]]', ' ', 'g'));
begin
  select * into s from listen_session where org_id = current_org() and id = p_session;
  if not found or s.person_id is distinct from current_viewer() then raise exception 'Listening session not found' using errcode = 'P0002'; end if;
  if s.stopped_at is not null and s.stopped_at < clock_timestamp() - interval '2 minutes' then raise exception 'This session has stopped' using errcode = '54000'; end if;
  if p_seq is null or p_seq not between 0 and 100000 then raise exception 'Send the lines in order' using errcode = '22023'; end if;
  if t = '' then return jsonb_build_object('ok', true, 'empty', true); end if;
  insert into listen_segment (org_id, session_id, seq, part, start_ms, end_ms, text)
  values (current_org(), s.id, p_seq, 0, greatest(0, least(coalesce(p_start_ms, 0), 21600000)),
          greatest(0, least(coalesce(p_end_ms, p_start_ms, 0), 21600000)), left(t, 4000))
  on conflict (session_id, seq, part) do nothing;
  return jsonb_build_object('ok', true);
end $$;

do $$
declare d text; c text;
begin
  -- The settings say whether live words are on; admins switch them.
  d := pg_get_functiondef('pulse.agent_channels_settings()'::regprocedure);
  c := replace(d, $x$'retentionDays', coalesce(s.listen_retention_days, 30))$x$,
                  $x$'retentionDays', coalesce(s.listen_retention_days, 30), 'live', coalesce(s.listen_live, true))$x$);
  if c = d then raise exception 'agent_channels_settings changed shape (LISTEN-FAST)'; end if;
  execute c;

  d := pg_get_functiondef('pulse.agent_channels_settings_set(jsonb)'::regprocedure);
  c := replace(d, $x$listen_on = coalesce((p->>'listenOn')::boolean, listen_on),$x$,
                  $x$listen_on = coalesce((p->>'listenOn')::boolean, listen_on),
    listen_live = coalesce((p->>'listenLive')::boolean, listen_live),$x$);
  if c = d then raise exception 'agent_channels_settings_set changed shape (LISTEN-FAST)'; end if;
  execute c;

  d := pg_get_functiondef('pulse.listen_chunk_done(uuid,integer,jsonb,text)'::regprocedure);
  c := replace(d, $x$select coalesce(sum(ms), 0) into base from pulse_priv.listen_chunk where session_id = k.session_id and seq < k.seq;$x$,
                  $x$select coalesce(sum(ms), 0) into base from pulse_priv.listen_chunk where session_id = k.session_id and seq < k.seq;
  base := greatest(base, coalesce((select max(end_ms) from listen_segment where session_id = k.session_id and seq < k.seq), 0));$x$);
  if c = d then raise exception 'listen_chunk_done changed shape (LISTEN-FAST)'; end if;
  execute c;

  d := pg_get_functiondef('pulse.listen_forward()'::regprocedure);
  c := replace(replace(d, $x$span < 30000$x$, $x$span < 20000$x$), $x$interval '45 seconds'$x$, $x$interval '30 seconds'$x$);
  if c = d or c ~ 'span < 30000' or c ~ $x$interval '45 seconds'$x$ then raise exception 'listen_forward changed shape (LISTEN-FAST)'; end if;
  execute c;
end $$;

revoke all on function pulse.listen_live_minutes_month(), pulse.listen_live_begin(uuid, int), pulse.listen_live_beat(uuid, int),
  pulse.listen_words_add(uuid, int, int, int, text) from public;
grant execute on function pulse.listen_live_begin(uuid, int), pulse.listen_live_beat(uuid, int), pulse.listen_words_add(uuid, int, int, int, text) to pulse_api;

-- migrate:down
-- Forward-only (the patched functions keep working without the new column's meaning).
