-- migrate:up
-- R54 (PLAN P27 steps 7–10 and P28, owner 8 Oct 2026): a company's trial is its pilot, and its readiness says so. On
-- R53's setup gates (0480) and R52's connectors (0470). Additive: nothing existing is rewritten or deleted.
--   * pulse.org_pilot_check: what the company's admins and HR tried during the trial. A device check per platform (pair,
--     check in and out, offline, revoke, a notification) and HR's walkthrough sign-off, each with the kind of evidence it
--     is: mock, simulator, installed device, or HR reading the company's real data (read only). A real company needs an
--     installed device and HR's real-data walkthrough; a rehearsal can close them with synthetic evidence and stays a
--     rehearsal. Records are kept (no update or delete).
--   * Pilot feedback (P28: does Pulse save effort, feel fair, feel calm, is it easy). Pulse keeps only the totals: one
--     row per question and score, and apart from it who has answered (so nobody answers twice). No answer is ever stored
--     with a person, and nothing about it is audited per person. Admins and HR see the totals as of the last multiple of
--     five answers, never below five.
--   * Source health in the registry: a connector whose source access was removed (R44's access_lost, a broken cursor
--     or a failing root) or that has not caught up for a day is not ready; what it delivered stays.
--   * The setup gates (and so activation) add the pilot: devices tested and HR's walkthrough signed off.

-- ------------------------------------------------------------------------------------------------- pilot checks
create function pulse.pilot_covers(p_kind text) returns text[] language sql immutable as $$
  select case p_kind
    when 'device' then array['pair','check_in','check_out','offline','notification','revoke']
    when 'walkthrough' then array['people','roles','policies','leave','attendance','tasks','sources','payroll']
    else '{}'::text[] end
$$;

create table pulse.org_pilot_check (
  org_id      uuid not null references pulse.org(id),
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('device','walkthrough')),
  platform    text check (platform in ('android','ios','macos','windows','chrome','web')),
  evidence    text not null check (evidence in ('mock','simulator','installed_device','real_data_read_only')),
  result      text not null check (result in ('passed','failed')),
  covers      text[] not null default '{}' check (covers <@ pulse.pilot_covers(kind)),
  note        text check (length(note) between 3 and 300),
  recorded_by uuid not null references pulse.person(id),
  recorded_at timestamptz not null default now(),
  check ((kind = 'device') = (platform is not null)),
  check (kind <> 'device' or evidence in ('mock','simulator','installed_device')),
  check (kind <> 'walkthrough' or evidence in ('mock','real_data_read_only')),
  check (result <> 'passed' or cardinality(covers) > 0)
);
create index org_pilot_check_latest on pulse.org_pilot_check(org_id, kind, platform, recorded_at desc);
alter table pulse.org_pilot_check enable row level security;
alter table pulse.org_pilot_check force row level security;
create policy tenant on pulse.org_pilot_check using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.org_pilot_check to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.org_pilot_check for each row execute function pulse.audit_mutation();

-- p: { kind: device | walkthrough, platform?, evidence, result, covers: [], note? }. Devices: the company's admins and
-- HR. The walkthrough is HR's sign-off (P27 step 9), so only HR records it.
create function pulse.company_pilot_check(p jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  v_kind text := btrim(coalesce(p ->> 'kind', '')); v_platform text := nullif(btrim(coalesce(p ->> 'platform', '')), '');
  v_evidence text := btrim(coalesce(p ->> 'evidence', '')); v_result text := btrim(coalesce(p ->> 'result', ''));
  v_note text := nullif(regexp_replace(btrim(coalesce(p ->> 'note', '')), '\s+', ' ', 'g'), ''); v_covers text[]; v_id uuid;
begin
  if current_viewer() is null or not viewer_is('admin','hr') then raise exception 'Company admins and HR record what the pilot tried' using errcode = '42501'; end if;
  if not exists (select 1 from org_handover where org_id = current_org()) then raise exception 'This company was not set up with the checklist' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p, 'null')) <> 'object' then raise exception 'Nothing to record' using errcode = '22023'; end if;
  if v_kind not in ('device','walkthrough') then raise exception 'Record a device check or HR''s walkthrough' using errcode = '22023'; end if;
  if v_kind = 'walkthrough' and not viewer_is('hr') then raise exception 'HR signs off the walkthrough' using errcode = '42501'; end if;
  if v_kind = 'device' and coalesce(v_platform, '') not in ('android','ios','macos','windows','chrome','web') then
    raise exception 'Choose the platform: Android, iPhone or iPad, Mac, Windows, Chrome or the web' using errcode = '22023';
  end if;
  if v_kind = 'walkthrough' then v_platform := null; end if;
  if v_kind = 'device' and v_evidence not in ('mock','simulator','installed_device') then
    raise exception 'Say how it was tried: a mock, a simulator or an installed device' using errcode = '22023';
  elsif v_kind = 'walkthrough' and v_evidence not in ('mock','real_data_read_only') then
    raise exception 'Say what HR walked through: synthetic data, or the company''s real data read only' using errcode = '22023';
  end if;
  if v_result not in ('passed','failed') then raise exception 'It passed or it failed' using errcode = '22023'; end if;
  if jsonb_typeof(p -> 'covers') = 'array' then
    v_covers := array(select distinct x from jsonb_array_elements_text(p -> 'covers') x order by x);
  elsif p ? 'covers' and jsonb_typeof(p -> 'covers') <> 'null' then
    raise exception 'What it covered is a list' using errcode = '22023';
  else v_covers := '{}'; end if;
  if not (v_covers <@ pilot_covers(v_kind)) then
    raise exception 'It covers %', array_to_string(pilot_covers(v_kind), ', ') using errcode = '22023';
  end if;
  if v_result = 'passed' and cardinality(v_covers) = 0 then raise exception 'Say what was tried' using errcode = '22023'; end if;
  if v_note is not null and length(v_note) not between 3 and 300 then raise exception 'The note is 3 to 300 characters' using errcode = '22023'; end if;
  insert into org_pilot_check(org_id, kind, platform, evidence, result, covers, note, recorded_by)
  values (current_org(), v_kind, v_platform, v_evidence, v_result, v_covers, v_note, current_viewer()) returning id into v_id;
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'pilot.' || v_kind, null, concat_ws(' ', v_platform, v_result, v_evidence), current_viewer());
  return v_id;
end $$;
revoke all on function pulse.company_pilot_check(jsonb) from public;
grant execute on function pulse.company_pilot_check(jsonb) to pulse_api;

-- ----------------------------------------------------------------------------------------------- pilot feedback
create function pulse.pilot_questions() returns jsonb language sql immutable as $$
  select '[{"key":"effort","label":"Pulse saves me effort"},{"key":"fair","label":"Pulse treats me fairly"},
           {"key":"calm","label":"Pulse feels calm, not pushy"},{"key":"easy","label":"Pulse is easy to use"}]'::jsonb
$$;
-- Fewer answers than this are never shown (P28: small groups are not broken down).
create function pulse.pilot_feedback_min() returns int language sql immutable as $$ select 5 $$;

-- The totals: one row per question and score. No person, no time.
create table pulse.pilot_feedback_tally (
  org_id   uuid not null references pulse.org(id),
  question text not null check (question in ('effort','fair','calm','easy')),
  score    smallint not null check (score between 1 and 5),
  answers  int not null default 0 check (answers >= 0),
  primary key (org_id, question, score)
);
-- Who has answered (one answer per person), kept apart from what they answered.
create table pulse.pilot_feedback_given (
  org_id    uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  primary key (org_id, person_id)
);
-- What admins and HR see: the totals as of the last multiple of five answers, so one new answer never shows alone.
create table pulse.pilot_feedback_shown (
  org_id     uuid primary key references pulse.org(id),
  answers    int not null check (answers >= 5),
  questions  jsonb not null,
  updated_on date not null default current_date
);
do $$ declare t text; begin
  foreach t in array array['pilot_feedback_tally','pilot_feedback_given','pilot_feedback_shown'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  end loop;
end $$;
-- No grants: only the functions below read or write them, and none of them is audited per person.

create function pulse.pilot_feedback_summary() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('answers', (select count(*) from pilot_feedback_given where org_id = current_org()),
    'minimum', pilot_feedback_min(), 'shownAnswers', s.answers, 'shownOn', s.updated_on, 'questions', coalesce(s.questions, '[]'))
  from (select 1) one left join pilot_feedback_shown s on s.org_id = current_org()
$$;
revoke all on function pulse.pilot_feedback_summary() from public;

-- The signed-in person's own view: whether the pilot asks, and whether they have answered (never what).
create function pulse.pilot_feedback_mine() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  return jsonb_build_object('open', current_viewer() is not null and exists (select 1 from org_handover where org_id = current_org())
                                     and exists (select 1 from person where id = current_viewer() and org_id = current_org() and side = 'staff' and status = 'active'),
    'given', exists (select 1 from pilot_feedback_given where org_id = current_org() and person_id = current_viewer()),
    'questions', pilot_questions(), 'minimum', pilot_feedback_min());
end $$;
revoke all on function pulse.pilot_feedback_mine() from public;
grant execute on function pulse.pilot_feedback_mine() to pulse_api;

-- p: { effort, fair, calm, easy }, each 1 (disagree) to 5 (agree). Once per person; only the totals change.
create function pulse.pilot_feedback_give(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare q jsonb; v_score int; v_n int;
begin
  if not exists (select 1 from org_handover where org_id = current_org()) then raise exception 'Your company has no pilot questions' using errcode = '22023'; end if;
  if current_viewer() is null or not exists (select 1 from person where id = current_viewer() and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Sign in with your own Pulse account to answer' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p, 'null')) <> 'object' then raise exception 'Answer each question from 1 to 5' using errcode = '22023'; end if;
  for q in select value from jsonb_array_elements(pilot_questions()) loop
    if coalesce(p ->> (q ->> 'key'), '') !~ '^[1-5]$' then raise exception 'Answer each question from 1 to 5' using errcode = '22023'; end if;
  end loop;
  insert into pilot_feedback_given(org_id, person_id) values (current_org(), current_viewer()) on conflict do nothing;
  if not found then raise exception 'You have already answered: thank you' using errcode = '23505'; end if;
  for q in select value from jsonb_array_elements(pilot_questions()) loop
    v_score := (p ->> (q ->> 'key'))::int;
    insert into pilot_feedback_tally(org_id, question, score, answers) values (current_org(), q ->> 'key', v_score, 1)
    on conflict (org_id, question, score) do update set answers = pilot_feedback_tally.answers + 1;
  end loop;
  select count(*) into v_n from pilot_feedback_given where org_id = current_org();
  if v_n >= pilot_feedback_min() and v_n % pilot_feedback_min() = 0 then
    insert into pilot_feedback_shown(org_id, answers, questions, updated_on)
    select current_org(), v_n, jsonb_agg(jsonb_build_object('key', x.item ->> 'key', 'label', x.item ->> 'label',
             'average', (select round(sum(t.score * t.answers)::numeric / nullif(sum(t.answers), 0), 1) from pilot_feedback_tally t where t.org_id = current_org() and t.question = x.item ->> 'key'),
             'agree', (select round(100.0 * coalesce(sum(t.answers) filter (where t.score >= 4), 0) / nullif(sum(t.answers), 0) / 10) * 10
                         from pilot_feedback_tally t where t.org_id = current_org() and t.question = x.item ->> 'key')) order by x.pos), current_date
      from jsonb_array_elements(pilot_questions()) with ordinality as x(item, pos)
    on conflict (org_id) do update set answers = excluded.answers, questions = excluded.questions, updated_on = excluded.updated_on;
  end if;
  return jsonb_build_object('given', true);
end $$;
revoke all on function pulse.pilot_feedback_give(jsonb) from public;
grant execute on function pulse.pilot_feedback_give(jsonb) to pulse_api;

-- ------------------------------------------------------------------------------------------- source health (P27.7)
-- As 0480, plus: a connector source whose access was removed at the source, whose cursor broke or whose root keeps
-- failing, or that has not caught up for a day, is not ready. What it delivered stays (nothing here deletes).
create or replace function pulse.org_source_view(s pulse.org_source) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare
  i connector_install%rowtype; v_sensitive text[] := array(select unnest(s.categories) intersect select unnest(org_source_sensitive()) order by 1);
  v_ready boolean := false; v_why text; v_install jsonb; v_roots int := 0; v_lost int := 0; v_lag int; v_health jsonb;
begin
  if s.decision = 'declined' then
    v_ready := true; v_why := 'Not used by this company';
  elsif s.kind in ('google_drive','plugin') then
    select * into i from connector_install where org_id = s.org_id and connector_key = s.connector and status = 'active' order by approved_at desc nulls last limit 1;
    if not found then
      v_why := case when exists (select 1 from connector_install where org_id = s.org_id and connector_key = s.connector and status = 'preview')
        then 'Installed, waiting for the admin''s grant in Settings, Connected sources, Connectors'
        else 'Not installed yet: the company admin installs it in Settings, Connected sources, Connectors' end;
    else
      select count(*) into v_roots from connector_source cs where cs.install_id = i.id and cs.status = 'approved' and cs.entities && i.granted_entities;
      select count(*) filter (where d.status in ('access_lost','cursor_invalid','error')),
             max(extract(epoch from now() - d.caught_up_at))::int
        into v_lost, v_lag
        from connector_source cs join drive_source d on d.id = cs.drive_source_id
       where cs.install_id = i.id and cs.status = 'approved';
      v_health := jsonb_build_object('lost', v_lost, 'lagSeconds', case when v_lag is not null then greatest(v_lag, 0) end);
      v_install := jsonb_build_object('id', i.id, 'status', i.status, 'keyInstalled', i.credential_fingerprint is not null,
        'missingEntities', to_jsonb(array(select unnest(connector_entity_types(i.manifest)) except select unnest(i.granted_entities) order by 1)),
        'approvedRoots', v_roots, 'health', v_health);
      if i.credential_fingerprint is null then v_why := 'Its key is not installed on the server yet (the platform operator''s step, owner errand E13)';
      elsif not (connector_entity_types(i.manifest) <@ i.granted_entities) then v_why := 'Not everything it delivers is granted yet';
      elsif v_roots = 0 then v_why := 'No shared drive or folder approved yet';
      elsif v_lost > 0 then v_why := format('Access to %s lost at the source (permission removed or the root failing): what it delivered stays; the company grants access again or stops the root',
                                             case when v_lost = 1 then '1 root' else v_lost || ' roots' end);
      elsif v_lag > 86400 then v_why := format('Behind: last caught up %s hours ago', v_lag / 3600);
      elsif cardinality(v_sensitive) > 0 and s.decision <> 'approved' then v_why := 'It brings ' || array_to_string(v_sensitive, ', ') || ': the admin approves that specifically';
      else v_ready := true; v_why := 'Granted: ' || v_roots || case when v_roots = 1 then ' root approved' else ' roots approved' end;
      end if;
    end if;
  elsif s.decision = 'approved' then
    v_ready := true; v_why := 'Approved by the company admin';
  else
    v_why := 'Waiting for the company admin''s approval';
  end if;
  return jsonb_build_object('id', s.id, 'key', s.key, 'kind', s.kind, 'label', s.label, 'connector', s.connector,
    'categories', to_jsonb(s.categories), 'sensitive', to_jsonb(v_sensitive), 'grants', s.grants, 'decision', s.decision,
    'decidedAt', s.decided_at, 'note', s.note, 'install', v_install, 'ready', v_ready, 'why', v_why);
end $$;

-- ------------------------------------------------------------------------------------------------ the gates
-- The pilot as two gates: one per platform tried (its latest check passed; a real company needs an installed device)
-- and HR's walkthrough (its latest sign-off passed; a real company needs HR to have read its real data). Facts and
-- the latest result per platform only: no notes and no names (the operator reads this too).
create function pulse.pilot_state() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare o org%rowtype; v_devices jsonb; w org_pilot_check%rowtype; n_plat int; n_pass int; n_inst int; v_dev_ok boolean; v_walk_ok boolean;
begin
  select * into o from org where id = current_org();
  select coalesce(jsonb_agg(jsonb_build_object('platform', platform, 'evidence', evidence, 'result', result, 'on', recorded_at::date) order by platform), '[]'),
         count(*), count(*) filter (where result = 'passed'), count(*) filter (where result = 'passed' and evidence = 'installed_device')
    into v_devices, n_plat, n_pass, n_inst
    from (select distinct on (platform) platform, evidence, result, recorded_at from org_pilot_check
           where org_id = o.id and kind = 'device' order by platform, recorded_at desc, id desc) d;
  select * into w from org_pilot_check where org_id = o.id and kind = 'walkthrough' order by recorded_at desc, id desc limit 1;
  v_dev_ok := n_plat > 0 and n_pass = n_plat and (o.rehearsal or n_inst > 0);
  v_walk_ok := coalesce(w.result = 'passed' and (o.rehearsal or w.evidence = 'real_data_read_only'), false);
  return jsonb_build_object('devices', v_devices, 'platforms', n_plat, 'passed', n_pass, 'installed', n_inst, 'devicesOk', v_dev_ok,
    'walkthrough', case when w.id is null then null else jsonb_build_object('evidence', w.evidence, 'result', w.result, 'on', w.recorded_at::date) end,
    'walkthroughOk', v_walk_ok, 'feedback', pilot_feedback_summary());
end $$;
revoke all on function pulse.pilot_state() from public;

-- As 0480, plus the pilot's two gates, the pilot's facts and the feedback totals.
create or replace function pulse.setup_gates() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare
  o org%rowtype; h org_handover%rowtype; v_sources jsonb; v_gates jsonb; v_pilot jsonb; v_word jsonb;
  n_admins int; n_signed int; n_two int; n_people int; n_email int; n_dup_names int; n_dup_emails int; n_src int; n_ready int;
  v_iso boolean; v_backup boolean; v_hand boolean; v_terms boolean;
begin
  select * into o from org where id = current_org();
  if not found then raise exception 'No company in scope' using errcode = '42501'; end if;
  select * into h from org_handover where org_id = o.id;
  select count(*),
         count(*) filter (where l.last_login_at is not null),
         count(*) filter (where l.last_login_at is not null and exists (select 1 from pulse_priv.auth_account x
                            where x.org_id = o.id and x.realm = 'staff' and x.actor = a.person_id and x.totp is not null))
    into n_admins, n_signed, n_two
    from (select distinct r.person_id from role_assignment r join person p on p.id = r.person_id and p.status = 'active'
           where r.org_id = o.id and r.role_key = 'admin' and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')) a
    left join login_credential l on l.person_id = a.person_id and l.status = 'active';
  select count(*), count(pp.email) into n_people, n_email
    from person p left join people_profile pp on pp.person_id = p.id where p.org_id = o.id and p.side = 'staff' and p.status = 'active';
  select count(*) into n_dup_names from (select 1 from person where org_id = o.id and side = 'staff' and status = 'active'
    group by lower(btrim(display_name)) having count(*) > 1) d;
  select count(*) into n_dup_emails from (select 1 from people_profile pp join person p on p.id = pp.person_id
    where pp.org_id = o.id and p.status = 'active' and pp.email is not null group by lower(pp.email) having count(*) > 1) d;
  select coalesce(jsonb_agg(org_source_view(s) order by s.key), '[]') into v_sources from org_source s where s.org_id = o.id;
  select count(*) filter (where x ->> 'decision' <> 'declined'), count(*) filter (where x ->> 'decision' <> 'declined' and (x ->> 'ready')::boolean)
    into n_src, n_ready from jsonb_array_elements(v_sources) x;
  v_iso := coalesce(h.isolation_leaks = 0 and h.isolation_at > now() - interval '1 hour', false);
  v_backup := coalesce(h.restore_result = 'passed' and h.restore_isolated and h.restore_on >= current_date - 90 and h.restore_ref is not null, false);
  v_hand := coalesce(h.operator_named and h.support_route is not null, false);
  v_terms := o.rehearsal or coalesce(h.terms_ref is not null and h.rollout_ref is not null, false);
  v_pilot := pilot_state();
  v_word := '{"mock":"mock","simulator":"simulator","installed_device":"installed device","real_data_read_only":"real data, read only"}';
  v_gates := jsonb_build_array(
    jsonb_build_object('key', 'admin', 'ok', n_two > 0, 'label', 'An admin signed in with two-step verification',
      'detail', format('%s admins: %s signed in, %s with two-step verification', n_admins, n_signed, n_two)),
    jsonb_build_object('key', 'identity', 'ok', n_people > 0 and n_dup_names = 0 and n_dup_emails = 0, 'label', 'Every person is one clear identity',
      'detail', case when n_people = 0 then 'Nobody added yet'
        when n_dup_names + n_dup_emails = 0 then format('%s people, %s with an e-mail; no shared name or e-mail', n_people, n_email)
        else format('%s names used by more than one person, %s e-mails shared', n_dup_names, n_dup_emails) end),
    jsonb_build_object('key', 'sources', 'ok', n_src > 0 and n_ready = n_src, 'label', 'Every source has its rights',
      'detail', case when n_src = 0 then 'No source registered: register the sources this company uses' else format('%s of %s sources ready', n_ready, n_src) end),
    jsonb_build_object('key', 'devices', 'ok', (v_pilot ->> 'devicesOk')::boolean, 'label', 'Pilot devices tested',
      'detail', case when (v_pilot ->> 'platforms')::int = 0 then 'No pilot device tested yet (owner errand E03: named pilot devices)'
        else (select string_agg(initcap(d ->> 'platform') || ' ' || (d ->> 'result') || ' (' || (v_word ->> (d ->> 'evidence')) || ')', '; ' order by d ->> 'platform')
                from jsonb_array_elements(v_pilot -> 'devices') d)
             || case when (v_pilot ->> 'passed')::int < (v_pilot ->> 'platforms')::int then '. Test a failed platform again' else '' end
             || case when not o.rehearsal and (v_pilot ->> 'installed')::int = 0 then '. A real company needs at least one installed device: mocks and simulators do not count' else '' end end),
    jsonb_build_object('key', 'walkthrough', 'ok', (v_pilot ->> 'walkthroughOk')::boolean, 'label', 'HR walked through it and signed off',
      'detail', case when v_pilot -> 'walkthrough' = 'null'::jsonb then 'HR has not walked through it yet (owner errand E18: the company''s HR, with HR''s rules from E06)'
        when v_pilot -> 'walkthrough' ->> 'result' = 'failed' then format('HR''s walkthrough on %s failed: fix what it found and walk through again', v_pilot -> 'walkthrough' ->> 'on')
        when not o.rehearsal and v_pilot -> 'walkthrough' ->> 'evidence' <> 'real_data_read_only' then 'Signed off on synthetic data only: a real company needs HR to walk through its real data, read only'
        else format('Signed off by HR on %s (%s)', v_pilot -> 'walkthrough' ->> 'on', v_word ->> (v_pilot -> 'walkthrough' ->> 'evidence')) end),
    jsonb_build_object('key', 'isolation', 'ok', v_iso, 'label', 'A fresh isolation check found nothing from another company',
      'detail', case when h.isolation_at is null then 'Not run yet'
        else format('%s tables, %s rows from another company, %s', h.isolation_tables, h.isolation_leaks,
                    case when h.isolation_at > now() - interval '1 hour' then 'within the hour' else 'over an hour ago: run it again' end) end),
    jsonb_build_object('key', 'backup', 'ok', v_backup, 'label', 'A passed restore drill in the last 90 days',
      'detail', case when h.restore_on is null then 'No restore drill recorded (owner errand E19)'
        else format('%s on %s, %s minutes, %s', h.restore_result, h.restore_on, h.restore_minutes,
                    case when h.restore_isolated then 'isolated target' else 'not an isolated target' end) end),
    jsonb_build_object('key', 'handover', 'ok', v_hand, 'label', 'A responsible operator and a support route',
      'detail', case when v_hand then 'Operator named; support: ' || h.support_route
        else concat_ws('; ', case when not coalesce(h.operator_named, false) then 'No operator named' end,
                       case when h.support_route is null then 'no support route' end) end),
    jsonb_build_object('key', 'terms', 'ok', v_terms, 'label', 'Privacy terms and the owner''s rollout instruction',
      'detail', case when o.rehearsal then 'Rehearsal: synthetic people only, so no live terms are needed'
        else concat_ws('; ', case when h.terms_ref is null then 'Privacy and processor terms not recorded (owner errand E08)' end,
                       case when h.rollout_ref is null then 'No rollout instruction from the owner recorded (E18)' end,
                       case when h.terms_ref is not null and h.rollout_ref is not null then 'Recorded' end) end));
  return jsonb_build_object(
    'company', jsonb_build_object('name', o.name, 'status', o.status, 'activation', o.activation, 'rehearsal', o.rehearsal,
      'host', (select host from org_domain where org_id = o.id and is_primary), 'prefix', (select object_prefix from org_storage where org_id = o.id)),
    'facts', jsonb_build_object('admins', n_admins, 'adminsSignedIn', n_signed, 'adminsTwoStep', n_two, 'people', n_people, 'withEmail', n_email,
      'duplicateNames', n_dup_names, 'sharedEmails', n_dup_emails, 'sources', n_src, 'sourcesReady', n_ready,
      'offices', (select count(*) from presence_office where org_id = o.id and active),
      'hrConfirmed', coalesce((select confirmed_at is not null from hr_policy where org_id = o.id), false),
      'attendance', coalesce((select attendance_enabled from hr_policy where org_id = o.id), false),
      'signIns', (select count(*) from login_credential where org_id = o.id and status = 'active'),
      'invitationsSent', (select count(*) from pulse_priv.staff_invitation where org_id = o.id and status in ('sent','used')),
      'devices', (select count(*) from native_device where org_id = o.id and revoked_at is null),
      'connectorsActive', (select count(*) from connector_install where org_id = o.id and status = 'active')),
    'sources', v_sources,
    'pilot', v_pilot,
    'handover', jsonb_build_object('operatorNamed', coalesce(h.operator_named, false), 'supportRoute', h.support_route,
      'restore', case when h.restore_on is null then null else jsonb_build_object('on', h.restore_on, 'minutes', h.restore_minutes,
        'result', h.restore_result, 'isolated', h.restore_isolated, 'ref', h.restore_ref) end,
      'termsRef', h.terms_ref, 'rolloutRef', h.rollout_ref, 'isolationAt', h.isolation_at, 'activatedAt', h.activated_at),
    'gates', v_gates,
    'ready', not exists (select 1 from jsonb_array_elements(v_gates) g where not (g ->> 'ok')::boolean),
    'blocked', (select coalesce(jsonb_agg(g ->> 'label'), '[]') from jsonb_array_elements(v_gates) g where not (g ->> 'ok')::boolean));
end $$;

-- The company's own side, as 0480, plus what its pilot tried (with notes and who recorded it: company side only).
create or replace function pulse.company_setup_state() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or not viewer_is('admin','hr') then raise exception 'Company admins and HR see the setup checklist' using errcode = '42501'; end if;
  if not exists (select 1 from org_handover where org_id = current_org()) then return jsonb_build_object('managed', false); end if;
  return setup_gates() || jsonb_build_object('managed', true, 'canEdit', viewer_is('admin'), 'canSignOff', viewer_is('hr'),
    'duplicateNames', (select coalesce(jsonb_agg(n order by n), '[]') from (select min(display_name) n from person
       where org_id = current_org() and side = 'staff' and status = 'active' group by lower(btrim(display_name)) having count(*) > 1 limit 50) d),
    'sharedEmails', (select coalesce(jsonb_agg(names order by names), '[]') from (select string_agg(p.display_name, ' and ' order by p.display_name) names
       from people_profile pp join person p on p.id = pp.person_id where pp.org_id = current_org() and p.status = 'active' and pp.email is not null
       group by lower(pp.email) having count(*) > 1 limit 50) d),
    'pilotChecks', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'platform', c.platform, 'evidence', c.evidence,
       'result', c.result, 'covers', to_jsonb(c.covers), 'note', c.note, 'by', p.display_name, 'at', c.recorded_at) order by c.recorded_at desc), '[]')
       from (select * from org_pilot_check where org_id = current_org() order by recorded_at desc limit 50) c left join person p on p.id = c.recorded_by));
end $$;

-- migrate:down
-- Forward-only: pilot records and feedback totals must remain auditable.
