-- migrate:up
-- AI-AUTONOMY (28 Oct 2026, orchestrator round 3):
-- 1. Questions a colleague has not answered no longer become one more question in the approver's direct message each
--    (that question then swallowed the approver's next message as its "answer": Kavya's own request went out as
--    "(For Rifob …)"). They gather in ONE message per approver a day, kept up to date (agent_waiting_digest), and an
--    approver's message is never taken as the answer to an old question. Open escalated questions close.
-- 2. A question's footer names the person who asked; a colleague's answer carries the original asker only when that
--    colleague is the one answering.
-- 3. Two tools the board asked for (Agent Lab #1 and the offer letter):
--    person.propose    a new colleague's profile (name, title, pod, team, work e-mail, manager) as one card; Apply (an
--                      admin or HR) creates the person and their profile and a private one-time join link for them
--                      (shown in that card only; nothing is e-mailed)
--    document.attach   a file someone sent it in a conversation (an offer letter, a resume…) filed in a colleague's HR
--                      documents as one card; Apply (an admin or HR with document rights) files it
--    Its runtime sees the files of the message it answers (id, name, type) to name them.

-- ---------------------------------------------------------------------------------------------- 1. waiting digest
create table if not exists pulse.agent_waiting_digest (
  org_id uuid not null references pulse.org(id),
  agent_id uuid not null references pulse.person(id),
  approver_id uuid not null references pulse.person(id),
  day date not null,
  message_id uuid,
  items jsonb not null default '[]' check (jsonb_typeof(items) = 'array'),
  primary key (agent_id, approver_id, day)
);
alter table pulse.agent_waiting_digest enable row level security;
alter table pulse.agent_waiting_digest force row level security;
create policy tenant on pulse.agent_waiting_digest using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create or replace function pulse.agent_consults_sweep() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); c agent_consult; ap uuid; dm uuid; nudged int := 0; escalated int := 0; expired int := 0; who text; col text; mid uuid;
  d agent_waiting_digest; v_body text; today date := (now() at time zone org_time_zone())::date; r record;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  update agent_consult set state = 'expired' where org_id = current_org() and agent_id = me and state = 'open' and created_at < now() - interval '3 days';
  get diagnostics expired = row_count;
  for c in select * from agent_consult where org_id = current_org() and agent_id = me and state = 'open' and nudged_at is null and escalated_from is null
             and created_at < now() - case when urgent then interval '15 minutes' else interval '2 hours' end for update skip locked loop
    select display_name into who from person where id = c.asker_id;
    mid := chat_send(c.dm_channel_id, case when c.urgent then 'Urgent, a reminder: ' else 'A gentle reminder: ' end || coalesce(who, 'someone') || ' is still waiting on this.' || chr(10) || '“' || left(c.question, 400) || '”',
      null, '[]'::jsonb, gen_random_uuid(), c.question_message_id);
    update agent_consult set nudged_at = now() where id = c.id; nudged := nudged + 1;
  end loop;
  -- Still unanswered after the reminder: on the approver's one waiting list for the day (no new question to answer).
  for c in select * from agent_consult where org_id = current_org() and agent_id = me and state = 'open' and escalated_at is null and nudged_at is not null
             and escalated_from is null and created_at < now() - case when urgent then interval '45 minutes' else interval '6 hours' end for update skip locked loop
    ap := agent_approver_for(me, c.source_channel_id);
    update agent_consult set escalated_at = now() where id = c.id;
    if ap is null or ap = c.colleague_id then continue; end if;
    insert into agent_waiting_digest(org_id, agent_id, approver_id, day) values (current_org(), me, ap, today) on conflict do nothing;
    select * into d from agent_waiting_digest where agent_id = me and approver_id = ap and day = today for update;
    select display_name into who from person where id = c.asker_id;
    select display_name into col from person where id = c.colleague_id;
    update agent_waiting_digest set items = items || jsonb_build_object('consult', c.id, 'colleague', col, 'asker', who, 'urgent', c.urgent,
      'since', to_char(c.created_at at time zone org_time_zone(), 'FMDD Mon, HH24:MI'), 'question', left(c.question, 300))
     where agent_id = me and approver_id = ap and day = today returning * into d;
    v_body := 'Still waiting on colleagues (' || jsonb_array_length(d.items) || '), for your eyes, nothing to approve:';
    for r in select x, n from jsonb_array_elements(d.items) with ordinality t(x, n) loop
      v_body := v_body || chr(10) || r.n || '. ' || case when (r.x->>'urgent')::boolean then 'Urgent: ' else '' end || coalesce(r.x->>'colleague', 'A colleague')
        || ' has not answered, since ' || (r.x->>'since') || ', for ' || coalesce(r.x->>'asker', 'someone') || ': “' || left(r.x->>'question', 200) || '”';
    end loop;
    v_body := left(v_body || chr(10) || 'If you know the answer, tell me here which one it is for; or nudge them.', 4000);
    if d.message_id is not null and exists(select 1 from chat_message where id = d.message_id and removed_at is null) then
      update chat_message set body = v_body, edited_at = now(), updated_at = now() where id = d.message_id;
    else
      dm := agent_dm_with(me, ap);
      mid := chat_send(dm, v_body, null, '[]'::jsonb, gen_random_uuid(), null);
      update agent_waiting_digest set message_id = mid where agent_id = me and approver_id = ap and day = today;
    end if;
    escalated := escalated + 1;
  end loop;
  return jsonb_build_object('nudged', nudged, 'escalated', escalated, 'expired', expired);
end $$;

-- Escalated questions still open (the old way) close: an approver's next message is theirs again.
do $$
declare o record;
begin
  for o in select id from pulse.org loop
    perform set_config('pulse.org_id', o.id::text, true);
    update pulse.agent_consult set state = 'expired' where org_id = o.id and escalated_from is not null and state = 'open';
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;

-- ------------------------------------------------------------------------------- 2. the footer names the asker
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.agent_consult_ask(uuid,text,text,uuid)'::regprocedure); was := src;
  src := replace(src, 'and dm_channel_id = msg.channel_id and answer_message_id is not null',
    'and dm_channel_id = msg.channel_id and answer_message_id is not null and colleague_id = msg.author_id');
  if src = was then raise exception 'agent_consult_ask changed upstream: update 1410'; end if;
  execute src;
end $$;

-- ----------------------------------------------------------------------------------- 3. person and document cards
alter table pulse.agent_proposal drop constraint if exists agent_proposal_kind_check;
alter table pulse.agent_proposal add constraint agent_proposal_kind_check check (kind in ('reply', 'task', 'summary', 'budget', 'batch', 'person', 'document'));

-- A card for the approver, inside a run (shared by both tools).
create or replace function pulse.agent_card(p_run uuid, p_kind text, p_body text, p_why text, p_action jsonb, p_note text) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); r agent_run; m agent_member; ap uuid; k text; dm uuid; pid uuid; mid uuid;
begin
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me;
  if not found then raise exception 'Propose inside one of your runs' using errcode = '42501'; end if;
  select id into pid from agent_proposal where run_id = r.id and kind = p_kind;
  if pid is not null then return (select jsonb_build_object('id', x.id, 'messageId', x.dm_message_id, 'chatId', x.dm_channel_id) from agent_proposal x where x.id = pid); end if;
  select * into m from agent_member where person_id = me;
  ap := coalesce(m.approver_person_id, m.owner_person_id);
  k := 'dm:' || least(me::text, ap::text) || ':' || greatest(me::text, ap::text);
  insert into chat_channel(org_id, key, name, kind, description) values (current_org(), k, 'Direct message', 'direct', 'A private conversation')
  on conflict (org_id, key) do update set key = excluded.key returning id into dm;
  insert into chat_member(org_id, channel_id, person_id) values (current_org(), dm, me), (current_org(), dm, ap) on conflict do nothing;
  insert into agent_proposal(org_id, agent_id, run_id, channel_id, source_message_id, approver_id, dm_channel_id, kind, body, why, action)
  values (current_org(), me, r.id, dm, null, ap, dm, p_kind, left(p_body, 4000), left(nullif(btrim(coalesce(p_why, '')), ''), 1000), p_action) returning id into pid;
  mid := chat_send(dm, p_note, null, '[]'::jsonb, gen_random_uuid(), null);
  update agent_proposal set dm_message_id = mid where id = pid;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  return jsonb_build_object('id', pid, 'messageId', mid, 'chatId', dm);
end $$;

create or replace function pulse.agent_propose_person(p_run uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); nm text := left(btrim(regexp_replace(coalesce(p->>'name', ''), '\s+', ' ', 'g')), 80);
  v_title text := left(btrim(coalesce(p->>'title', '')), 80); v_pod text := nullif(left(btrim(coalesce(p->>'pod', '')), 60), '');
  v_team text := nullif(left(btrim(coalesce(p->>'team', '')), 60), ''); v_email text := nullif(lower(btrim(coalesce(p->>'email', ''))), '');
  mgr uuid; mgr_name text; start text := nullif(left(btrim(coalesce(p->>'startsOn', '')), 10), '');
begin
  if me is null or not agent_sees(me) then raise exception 'This AI employee has no work actions' using errcode = '42501'; end if;
  if length(nm) < 2 then raise exception 'Give the new colleague''s name' using errcode = '22023'; end if;
  if v_email is not null and v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Give a valid e-mail or none' using errcode = '22023'; end if;
  if v_pod is not null and not exists(select 1 from unit where org_id = current_org() and kind = 'pod' and valid_to is null and name = v_pod) then raise exception 'Unknown v_pod: %', v_pod using errcode = '22023'; end if;
  if coalesce(p->>'manager', '') <> '' then
    select pe.id, pe.display_name into mgr, mgr_name from people_profile pp join person pe on pe.id = pp.person_id
     where pp.org_id = current_org() and lower(pp.username) = lower(btrim(p->>'manager', ' @')) and pe.status = 'active' and pe.side = 'staff';
  end if;
  if exists(select 1 from person pe join people_profile pp on pp.person_id = pe.id where pe.org_id = current_org() and pe.status = 'active'
            and (lower(pe.display_name) = lower(nm) or (v_email is not null and lower(pp.email) = v_email))) then
    raise exception '% is already in Pulse', nm using errcode = '23505'; end if;
  return agent_card(p_run, 'person',
    'New colleague: ' || nm || chr(10) || 'Role: ' || coalesce(nullif(v_title, ''), '(not set)') || coalesce(chr(10) || 'Pod: ' || v_pod, '') || coalesce(chr(10) || 'Team: ' || v_team, '')
      || coalesce(chr(10) || 'Work e-mail: ' || v_email, '') || coalesce(chr(10) || 'Reports to: ' || mgr_name, '') || coalesce(chr(10) || 'Starts: ' || start, '')
      || chr(10) || 'Apply creates the profile and a private one-time join link for them (an admin or HR applies; nothing is e-mailed).',
    p->>'why', jsonb_strip_nulls(jsonb_build_object('type', 'person.create', 'name', nm, 'title', nullif(v_title, ''), 'pod', v_pod, 'team', v_team, 'email', v_email, 'managerId', mgr, 'startsOn', start)),
    'New colleague ' || nm || ': their profile and a join link in one card. Apply (admin or HR), or Don''t.');
end $$;

create or replace function pulse.agent_propose_document(p_run uuid, p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); f record; who uuid; who_name text; dt text := coalesce(nullif(p->>'docType', ''), 'offer_letter');
begin
  if me is null or not agent_sees(me) then raise exception 'This AI employee has no work actions' using errcode = '42501'; end if;
  if dt not in ('appointment_letter', 'joining_letter', 'offer_letter', 'salary_certificate', 'relieving_letter', 'resume', 'id_aadhaar', 'id_pan', 'id_passport', 'bank_details') then
    raise exception 'Choose a document type HR keeps' using errcode = '22023'; end if;
  -- The file must be one it was sent in a conversation it is in.
  select cf.id, cf.name, cf.mime, cf.channel_id into f from pulse_priv.chat_file cf
   where cf.org_id = current_org() and cf.id = nullif(p->>'fileId', '')::uuid and exists(select 1 from chat_member cm where cm.channel_id = cf.channel_id and cm.person_id = me);
  if f.id is null then raise exception 'Name a file someone sent you here' using errcode = '22023'; end if;
  select pe.id, pe.display_name into who, who_name from people_profile pp join person pe on pe.id = pp.person_id
   where pp.org_id = current_org() and (lower(pp.username) = lower(btrim(coalesce(p->>'person', ''), ' @')) or lower(pe.display_name) = lower(btrim(coalesce(p->>'person', ''))))
     and pe.status = 'active' and pe.side = 'staff' limit 1;
  if who is null then raise exception 'No colleague by that name or username' using errcode = '22023'; end if;
  return agent_card(p_run, 'document',
    'File in HR documents: ' || f.name || chr(10) || 'For: ' || who_name || chr(10) || 'As: ' || replace(dt, '_', ' ') || chr(10) || 'Apply files it (an admin or HR with document rights).',
    p->>'why', jsonb_build_object('type', 'document.file', 'fileId', f.id, 'fileName', f.name, 'channelId', f.channel_id, 'personId', who, 'personName', who_name, 'docType', dt),
    'File ' || f.name || ' in ' || who_name || '''s HR documents? Apply, or Don''t.');
end $$;

create or replace function pulse.unaccent_safe(t text) returns text language sql immutable as $$ select translate(coalesce(t, ''), 'áàâäãåéèêëíìîïóòôöõúùûüçñ', 'aaaaaaeeeeiiiiooooouuuucn') $$;
-- A username like the app makes one (first.last, then first.last2 …).
create or replace function pulse.agent_username_for(p_name text) returns text language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare base text := left(trim(both '.' from regexp_replace(lower(unaccent_safe(p_name)), '[^a-z0-9]+', '.', 'g')), 34); n int := 1; u text;
begin
  if length(base) < 3 then base := base || '.new'; end if;
  u := base;
  while exists(select 1 from people_profile where org_id = current_org() and username = u) loop n := n + 1; u := base || n; end loop;
  return u;
end $$;

-- The decision for person and document cards, as the person who decides (admin or HR); everything else as before.
do $$
declare src text;
begin
  if to_regprocedure('pulse.agent_proposal_decide_batch(uuid,text,text,text)') is null then
    src := pg_get_functiondef('pulse.agent_proposal_decide(uuid,text,text,text)'::regprocedure);
    src := replace(src, 'FUNCTION pulse.agent_proposal_decide(', 'FUNCTION pulse.agent_proposal_decide_batch(');
    execute src;
  end if;
end $$;
create or replace function pulse.agent_proposal_decide(p_id uuid, p_action text, p_body text, p_via text default 'button') returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pr agent_proposal; me uuid := current_viewer(); a jsonb; pid uuid; u text; tok text; inv jsonb; note text;
begin
  select * into pr from agent_proposal where id = p_id and org_id = current_org();
  if not found or pr.kind not in ('person', 'document') then return agent_proposal_decide_batch(p_id, p_action, p_body, p_via); end if;
  if agent_session() is not null or me is null then raise exception 'A person decides' using errcode = '42501'; end if;
  select * into pr from agent_proposal where id = p_id for update;
  if pr.approver_id <> me and not agent_manage_ok(pr.agent_id) then raise exception 'Not found' using errcode = 'P0002'; end if;
  if p_action is null or p_action not in ('send', 'dismiss') then raise exception 'Apply it or don''t' using errcode = '22023'; end if;
  if pr.state <> 'pending' then return jsonb_build_object('state', pr.state, 'channelId', pr.channel_id); end if;
  if p_action = 'dismiss' then
    update agent_proposal set state = 'dismissed', decided_by = me, decided_at = now(), decided_via = coalesce(p_via, 'button') where id = pr.id;
    return jsonb_build_object('state', 'dismissed', 'channelId', pr.channel_id);
  end if;
  a := pr.action;
  if pr.kind = 'person' then
    if not viewer_is('admin', 'hr') then raise exception 'An admin or HR adds people: ask them to Apply' using errcode = '42501'; end if;
    if exists(select 1 from person pe where pe.org_id = current_org() and pe.status = 'active' and lower(pe.display_name) = lower(a->>'name')) then
      raise exception '% is already in Pulse', a->>'name' using errcode = '23505'; end if;
    u := agent_username_for(a->>'name');
    insert into person(org_id, display_name, side) values (current_org(), a->>'name', 'staff') returning id into pid;
    insert into people_profile(org_id, person_id, role, pod, department, email, manager_id, evidence, user_no, username, locked)
    values (current_org(), pid, a->>'title', a->>'pod', a->>'team', a->>'email', nullif(a->>'managerId', '')::uuid,
      'Added in Pulse from ' || (select display_name from person where id = pr.agent_id) || '''s card, applied by ' || (select display_name from person where id = me) || '.',
      (select coalesce(max(user_no), 0) + 1 from people_profile where org_id = current_org()), u, '{name,role,pod,status}');
    insert into record_change(org_id, entity_type, entity_id, field, new_value, changed_by) values (current_org(), 'person', pid, 'created', a->>'name', me);
    -- A private one-time join link (the account side links it to this person when they join with it).
    tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    inv := org_invite_create(jsonb_build_object('kind', 'staff', 'title', left(coalesce(a->>'title', 'New colleague'), 80), 'hash', encode(sha256(convert_to(tok, 'UTF8')), 'hex')));
    note := 'Created ' || (a->>'name') || ' (@' || u || '). Their private join link, shown here only (send it to them yourself): /join#' || tok;
    update agent_proposal set state = 'sent', decided_by = me, decided_at = now(), decided_via = coalesce(p_via, 'button'), sent_body = left(note, 4000) where id = pr.id;
    return jsonb_build_object('state', 'sent', 'personId', pid, 'username', u, 'channelId', pr.channel_id);
  end if;
  -- document
  if not hr_can('hr.documents.read') then
    raise exception 'Someone with HR document rights files HR documents: ask them to Apply' using errcode = '42501'; end if;
  insert into pulse_priv.hr_document(org_id, person_id, doc_type, file_id, file_name, location)
  values (current_org(), (a->>'personId')::uuid, a->>'docType', a->>'fileId', a->>'fileName', 'pulse-chat:' || (a->>'channelId'));
  perform hr_log((a->>'personId')::uuid, 'hr.documents', 'hr_document_filed');
  update agent_proposal set state = 'sent', decided_by = me, decided_at = now(), decided_via = coalesce(p_via, 'button'),
    sent_body = 'Filed ' || (a->>'fileName') || ' in ' || (a->>'personName') || '''s HR documents as ' || replace(a->>'docType', '_', ' ') || '.' where id = pr.id;
  return jsonb_build_object('state', 'sent', 'channelId', pr.channel_id);
end $$;

-- The two tools for its runtime (agent_chief_act), and the files of the message it answers (agent_dispatch's context).
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.agent_chief_act(uuid,jsonb)'::regprocedure); was := src;
  src := replace(src, $q$      elsif t = 'request' then$q$, $q$      elsif t = 'person.propose' then
        res := jsonb_build_object('type', t, 'ok', true) || agent_propose_person(p_run, a);
      elsif t = 'document.attach' then
        res := jsonb_build_object('type', t, 'ok', true) || agent_propose_document(p_run, a);
      elsif t = 'request' then$q$);
  if src = was then raise exception 'agent_chief_act changed upstream: update 1410'; end if;
  execute src;
  src := pg_get_functiondef('pulse.agent_dispatch(uuid,uuid,text,text)'::regprocedure); was := src;
  src := replace(src, $q$'message', (select jsonb_build_object('id', x.id, 'channelId', x.channel_id, 'parentId', x.parent_id, 'body', left(x.body, 2000),$q$,
    $q$'message', (select jsonb_build_object('id', x.id, 'channelId', x.channel_id, 'parentId', x.parent_id, 'body', left(x.body, 2000),
                    'files', (select coalesce(jsonb_agg(jsonb_build_object('id', f->>'id', 'name', f->>'name', 'mime', f->>'mime')), '[]'::jsonb)
                                from jsonb_array_elements(case when jsonb_typeof(x.attachments) = 'array' then x.attachments else '[]'::jsonb end) f where f ? 'id'),$q$);
  if src = was then raise exception 'agent_dispatch changed upstream: update 1410'; end if;
  execute src;
end $$;

revoke all on function pulse.agent_card(uuid, text, text, text, jsonb, text), pulse.agent_propose_person(uuid, jsonb), pulse.agent_propose_document(uuid, jsonb),
  pulse.agent_username_for(text), pulse.agent_proposal_decide_batch(uuid, text, text, text) from public;
grant execute on function pulse.agent_propose_person(uuid, jsonb), pulse.agent_propose_document(uuid, jsonb), pulse.agent_proposal_decide_batch(uuid, text, text, text) to pulse_api;

-- migrate:down
-- Forward-only.
