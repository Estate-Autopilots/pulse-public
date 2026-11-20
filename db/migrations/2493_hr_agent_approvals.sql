-- migrate:up
-- HR-AGENT (owner decisions, 20 Nov 2026 ~17:30 IST). Two additive changes.
--
-- 1. Lab #1, "HR AI adding staff". Owner: "Yes, based on some approval giver." An AI employee never adds a staff member
--    itself. It files a request (pulse.staff_add_request: name, role, team, pod, start date, e-mail, a note) and the
--    company's named approvers for new staff (pulse.staff_add_approver; none named = the company's admins) each get one
--    bell notice with Approve / Decline on My desk → Approvals. Nothing is created until an approver presses Approve: the
--    API then adds the person with People → Add person's own function (records.ts addPerson, as the approver) and
--    staff_add_request_done writes the Audit row naming the AI, the approver and the request. Decline needs a reason; the
--    reason goes back to the AI (its memory, and get_add_person_request). A request nobody decides ends after 7 days.
--    Approvers are active staff with HR, admin or leadership access (the people who may add staff themselves). If a
--    company has no one who may approve, the AI's request is refused with a plain reason and nothing is stored.
-- 2. EA #30, Attendance. Owner: "just one notification or call from the agent to someone who applies." In a company
--    whose HR AI employee is on duty (an active AI employee an admin lets read attendance: agent_member.reads, 2300),
--    a leave or attendance-correction request gets ONE notice from that AI to the person who decides it
--    (hr_flow_approver), instead of a ping to every possible approver on every change. Repeats, edits and retries never
--    ping again (pulse.hr_agent_notice, one row per request and stage; the bell key is the applicant + kind + days +
--    stage, so filing the same days again is not a new ping). A request forwarded to a co-founder is a person's choice,
--    so the co-founder gets one notice too. At most one reminder, and only when HR's policy already sends reminders
--    (hr_flow_policy.reminder_hours set), inside the existing 10:30 working-day reminder run. The applicant's own notices
--    are unchanged. No AI employee calls staff today (no call channel is set up), so the notice is a bell notice
--    (with the HR Telegram/e-mail copy the person opted into); hr_agent_notice.channel keeps 'call' for when one is.
-- Companies without an HR AI on duty keep today's behaviour exactly.

-- 1 -----------------------------------------------------------------------------------------------------------------
create table pulse.staff_add_approver (
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  added_by uuid references pulse.person(id),
  added_at timestamptz not null default now(),
  primary key (org_id, person_id)
);
alter table pulse.staff_add_approver enable row level security;
alter table pulse.staff_add_approver force row level security;
create policy tenant_isolation on pulse.staff_add_approver using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.staff_add_approver to pulse_api;

create table pulse.staff_add_request (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references pulse.person(id),
  request_key text check (request_key is null or length(request_key) between 8 and 80),
  name text not null check (length(btrim(name)) between 1 and 80),
  role text not null check (length(btrim(role)) between 1 and 80),
  team text check (team is null or length(team) <= 60),
  pod text check (pod is null or length(pod) <= 40),
  start_date date,
  email text check (email is null or length(email) <= 120),
  note text check (note is null or length(note) <= 500),
  approvers uuid[] not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'expired')),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  decline_reason text check (decline_reason is null or length(decline_reason) between 3 and 500),
  person_id uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  unique (org_id, requested_by, request_key),
  check (status <> 'approved' or person_id is not null),
  check (status <> 'declined' or decline_reason is not null)
);
create index staff_add_request_pending on pulse.staff_add_request (org_id, status, created_at);
alter table pulse.staff_add_request enable row level security;
alter table pulse.staff_add_request force row level security;
create policy tenant_isolation on pulse.staff_add_request using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- HR, admins and leadership, the AI that asked, and the people it asked see a request; writes go through the functions.
create policy staff_add_request_read on pulse.staff_add_request as restrictive for select to pulse_api
  using (pulse.viewer_is('admin', 'hr', 'leadership') or requested_by = pulse.current_viewer() or pulse.current_viewer() = any(approvers));
grant select on pulse.staff_add_request to pulse_api;

select pulse.check_values_add('pulse.notification'::regclass, 'notification_subject_type_check', 'subject_type', array['staff_add_request']);

/** Who may approve a new staff member now: the people the company named (still active staff with HR, admin or leadership
 *  access), or, when it named nobody, its admins. Empty means nobody can. */
create function pulse.staff_add_approver_ids() returns uuid[] language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when exists (select 1 from staff_add_approver a where a.org_id = current_org())
    then coalesce((select array_agg(a.person_id order by p.display_name, p.id) from staff_add_approver a join person p on p.id = a.person_id
      where a.org_id = current_org() and p.status = 'active' and p.side = 'staff' and hr_is_staff(a.person_id)), '{}'::uuid[])
    else coalesce((select array_agg(x.id order by x.display_name, x.id) from (select distinct p.id, p.display_name from role_assignment ra join person p on p.id = ra.person_id
      where ra.org_id = current_org() and ra.role_key = 'admin' and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')
        and p.status = 'active' and p.side = 'staff') x), '{}'::uuid[]) end
$$;
revoke all on function pulse.staff_add_approver_ids() from public;
grant execute on function pulse.staff_add_approver_ids() to pulse_api;

/** The approvers setting as the settings card shows it. */
create function pulse.staff_add_approvers() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object(
    'named', exists (select 1 from staff_add_approver a where a.org_id = current_org()),
    'approvers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by o.n)
      from unnest(staff_add_approver_ids()) with ordinality o(id, n) join person p on p.id = o.id), '[]'::jsonb),
    'canEdit', agent_session() is null and viewer_is('admin'))
$$;
revoke all on function pulse.staff_add_approvers() from public;
grant execute on function pulse.staff_add_approvers() to pulse_api;

/** An admin names who approves new staff an AI asks to add (an empty list goes back to the company's admins). */
create function pulse.staff_add_approvers_set(p_people uuid[]) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare who uuid; bad text;
begin
  if agent_session() is not null or not viewer_is('admin') then raise exception 'Only an admin chooses who approves new staff' using errcode = '42501'; end if;
  if coalesce(array_length(p_people, 1), 0) > 10 then raise exception 'Choose up to 10 approvers' using errcode = '22023'; end if;
  foreach who in array coalesce(p_people, '{}'::uuid[]) loop
    select p.display_name into bad from person p where p.id = who and p.org_id = current_org();
    if bad is null then raise exception 'Choose approvers from your team' using errcode = '22023'; end if;
    if not exists (select 1 from person p where p.id = who and p.status = 'active' and p.side = 'staff') or not hr_is_staff(who) then
      raise exception '% cannot approve new staff: choose someone with HR, admin or leadership access', bad using errcode = '22023'; end if;
  end loop;
  delete from staff_add_approver where org_id = current_org() and not (person_id = any(coalesce(p_people, '{}'::uuid[])));
  insert into staff_add_approver (org_id, person_id, added_by)
    select current_org(), x, current_viewer() from unnest(coalesce(p_people, '{}'::uuid[])) x on conflict do nothing;
  perform audit_write('staff_add_approvers_set', 'org', current_org()::text, coalesce((select array_agg(x::text) from unnest(p_people) x), '{}'::text[]));
  return staff_add_approvers();
end $$;
revoke all on function pulse.staff_add_approvers_set(uuid[]) from public;
grant execute on function pulse.staff_add_approvers_set(uuid[]) to pulse_api;

/** One request as the AI's tool, the card and the tests read it. A pending request past its end reads as expired. */
create function pulse.staff_add_request_json(p_id uuid) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('requestId', r.id, 'status', case s.status when 'pending' then 'waiting_for_approval' else s.status end, 'name', r.name, 'role', r.role, 'team', r.team, 'pod', r.pod,
    'startDate', r.start_date::text, 'email', r.email, 'note', r.note, 'createdAt', r.created_at, 'expiresAt', r.expires_at,
    'requestedBy', jsonb_build_object('id', a.id, 'name', a.display_name),
    'approvers', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name) order by o.n)
      from unnest(r.approvers) with ordinality o(id, n) join person p on p.id = o.id), '[]'::jsonb),
    'decidedBy', case when d.id is not null then jsonb_build_object('id', d.id, 'name', d.display_name) end, 'decidedAt', r.decided_at,
    'declineReason', r.decline_reason, 'personId', r.person_id,
    'canDecide', s.status = 'pending' and agent_session() is null and current_viewer() = any(staff_add_approver_ids()),
    'message', case s.status
      when 'pending' then 'Waiting for approval from ' || coalesce((select string_agg(p.display_name, ' or ' order by o.n) from unnest(r.approvers) with ordinality o(id, n)
        join person p on p.id = o.id), 'an approver') || '. Nothing is added until one of them says yes. If nobody decides, the request ends on '
        || to_char(r.expires_at at time zone org_time_zone(current_org()), 'FMDD Mon') || '.'
      when 'approved' then 'Approved by ' || coalesce(d.display_name, 'an approver') || '. ' || r.name || ' is now in People.'
      when 'declined' then 'Declined by ' || coalesce(d.display_name, 'an approver') || ': ' || r.decline_reason || ' Nothing was added.'
      else 'Nobody decided within 7 days, so nothing was added. Ask again if it is still needed.' end)
  from staff_add_request r join person a on a.id = r.requested_by left join person d on d.id = r.decided_by
  cross join lateral (select case when r.status = 'pending' and r.expires_at <= now() then 'expired' else r.status end status) s
  where r.org_id = current_org() and r.id = p_id
$$;
revoke all on function pulse.staff_add_request_json(uuid) from public;
grant execute on function pulse.staff_add_request_json(uuid) to pulse_api;

/** Pending requests past their 7 days end; their bell notices are cleared. */
create function pulse.staff_add_expire() returns int language plpgsql security definer set search_path = pulse, pg_temp as $$
declare n int;
begin
  with gone as (update staff_add_request set status = 'expired' where org_id = current_org() and status = 'pending' and expires_at <= now() returning id)
  update notification set read_at = coalesce(read_at, now()) where org_id = current_org() and subject_type = 'staff_add_request' and subject_id in (select id from gone);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function pulse.staff_add_expire() from public;
grant execute on function pulse.staff_add_expire() to pulse_api, pulse_worker;

/** The AI's add_person: files a request and tells each approver once. Never creates a person. The same requestKey again
 *  returns the first request (a retry never files or pings twice). */
create function pulse.staff_add_request_file(p jsonb) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); r staff_add_request; ids uuid[]; who uuid; v_key text; v_name text; v_role text; v_team text; v_pod text;
  v_start date; v_email text; v_note text; raw text; ai text;
begin
  if me is null then raise exception 'Only an AI employee asks to add staff this way. People add staff in People → Add person.' using errcode = '42501'; end if;
  v_key := nullif(btrim(coalesce(p ->> 'requestKey', '')), '');
  if v_key is not null then
    select * into r from staff_add_request where org_id = current_org() and requested_by = me and request_key = v_key;
    if found then return staff_add_request_json(r.id); end if;
  end if;
  v_name := nullif(regexp_replace(btrim(coalesce(p ->> 'name', '')), '\s+', ' ', 'g'), '');
  if v_name is null or length(v_name) > 80 then raise exception 'Give the person''s full name (up to 80 letters)' using errcode = '22023'; end if;
  v_role := nullif(regexp_replace(btrim(coalesce(p ->> 'role', '')), '\s+', ' ', 'g'), '');
  if v_role is null or length(v_role) > 80 then raise exception 'Give their role, such as Video editor (up to 80 letters)' using errcode = '22023'; end if;
  v_team := nullif(regexp_replace(btrim(coalesce(p ->> 'team', '')), '\s+', ' ', 'g'), '');
  if length(v_team) > 60 then raise exception 'The team name is too long (up to 60 letters)' using errcode = '22023'; end if;
  v_pod := nullif(btrim(coalesce(p ->> 'pod', '')), '');
  if v_pod is not null and not exists (select 1 from unit where org_id = current_org() and kind = 'pod' and valid_to is null and name = v_pod) then
    raise exception 'There is no pod called %. Leave pod out, or use one of: %', v_pod,
      coalesce((select string_agg(name, ', ' order by name) from unit where org_id = current_org() and kind = 'pod' and valid_to is null), 'none yet') using errcode = '22023'; end if;
  raw := nullif(btrim(coalesce(p ->> 'startDate', '')), '');
  if raw is not null then
    if raw !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Give the start date as YYYY-MM-DD, for example 2026-12-01' using errcode = '22023'; end if;
    begin v_start := raw::date; exception when others then raise exception 'Give the start date as YYYY-MM-DD, for example 2026-12-01' using errcode = '22023'; end;
  end if;
  v_email := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  if v_email is not null and (length(v_email) > 120 or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$') then raise exception 'Give a work e-mail such as name@company.com, or leave it out' using errcode = '22023'; end if;
  v_note := nullif(btrim(coalesce(p ->> 'note', '')), '');
  if length(v_note) > 500 then raise exception 'Keep the note under 500 letters' using errcode = '22023'; end if;
  -- A retry or a repeat (the same AI, the same name, still waiting) is the same request: no second request, no second ping.
  select * into r from staff_add_request where org_id = current_org() and requested_by = me and status = 'pending' and expires_at > now()
    and lower(name) = lower(v_name) order by created_at limit 1;
  if found then return staff_add_request_json(r.id); end if;
  ids := staff_add_approver_ids();
  if coalesce(array_length(ids, 1), 0) = 0 then
    raise exception 'Nothing was added: no one in this company can approve new staff yet. Ask an admin to choose an approver in HR → Policies → New staff approvers.' using errcode = '22023'; end if;
  insert into staff_add_request (org_id, requested_by, request_key, name, role, team, pod, start_date, email, note, approvers)
    values (current_org(), me, v_key, v_name, v_role, v_team, v_pod, v_start, v_email, v_note, ids) returning * into r;
  select display_name into ai from person where id = me;
  foreach who in array ids loop
    perform notification_emit(who, 'approval.waiting', 'staff_add_request', r.id, 'staff-add:' || r.id,
      left(ai || ' asks to add ' || v_name || ' (' || v_role || '). Approve or decline.', 200), '/me/approvals?staff=' || r.id, 'approval', true);
  end loop;
  perform audit_write('staff_add_requested', 'staff_add_request', r.id::text, array['name', 'role'] || case when v_team is null then '{}'::text[] else array['team'] end
    || case when v_start is null then '{}'::text[] else array['startDate'] end);
  return staff_add_request_json(r.id);
end $$;
revoke all on function pulse.staff_add_request_file(jsonb) from public;
grant execute on function pulse.staff_add_request_file(jsonb) to pulse_api;

/** Locks a request an approver is deciding and says why it cannot be decided (decided, ended, not theirs). */
create function pulse.staff_add_request_lock(p_id uuid) returns pulse.staff_add_request language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r staff_add_request; d text;
begin
  if agent_session() is not null then raise exception 'An AI employee cannot decide a request to add staff' using errcode = '42501'; end if;
  select * into r from staff_add_request where org_id = current_org() and id = p_id for update;
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  select display_name into d from person where id = r.decided_by;
  if r.status = 'pending' and r.expires_at <= now() then
    raise exception 'This request ended on % because nobody decided within 7 days. Nothing was added.', to_char(r.expires_at at time zone org_time_zone(current_org()), 'FMDD Mon') using errcode = '22023'; end if;
  if r.status = 'approved' then raise exception '% already approved this request', coalesce(d, 'Someone') using errcode = '22023'; end if;
  if r.status = 'declined' then raise exception '% already declined this request', coalesce(d, 'Someone') using errcode = '22023'; end if;
  if r.status = 'expired' then raise exception 'This request ended because nobody decided within 7 days. Nothing was added.' using errcode = '22023'; end if;
  if current_viewer() is null or not (current_viewer() = any(staff_add_approver_ids())) then
    raise exception 'Only a named approver for new staff can decide this, and you are not one now' using errcode = '42501'; end if;
  return r;
end $$;
revoke all on function pulse.staff_add_request_lock(uuid) from public;

/** What Approve hands to People → Add person (the API calls addPerson with it, as the approver). */
create function pulse.staff_add_request_claim(p_id uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r staff_add_request;
begin
  r := staff_add_request_lock(p_id);
  return jsonb_strip_nulls(jsonb_build_object('name', r.name, 'role', r.role, 'pod', r.pod, 'department', r.team,
    'joinedOn', r.start_date::text, 'email', r.email));
end $$;
revoke all on function pulse.staff_add_request_claim(uuid) from public;
grant execute on function pulse.staff_add_request_claim(uuid) to pulse_api;

/** The AI hears the outcome: one memory line (it reads its memory on every run), replaced if it is decided again. */
create function pulse.staff_add_tell_ai(r pulse.staff_add_request) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  insert into agent_memory (org_id, agent_id, body, source, created_by, said_by, level, topic, slot)
  values (r.org_id, r.requested_by, left(staff_add_request_json(r.id) ->> 'message', 1000), 'manager', current_viewer(), current_viewer(), 'agent',
    'Request to add staff', 'staff-add:' || r.id);
exception when unique_violation then null;
end $$;
revoke all on function pulse.staff_add_tell_ai(pulse.staff_add_request) from public;

/** After addPerson added them (same transaction): the request is approved, its Audit row names the AI, the approver and
 *  the request, the other approvers' notices are cleared and the AI is told. */
create function pulse.staff_add_request_done(p_id uuid, p_person uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r staff_add_request;
begin
  r := staff_add_request_lock(p_id);
  if not exists (select 1 from person where id = p_person and org_id = current_org() and side = 'staff') then raise exception 'Person not found' using errcode = 'P0002'; end if;
  update staff_add_request set status = 'approved', decided_by = current_viewer(), decided_at = now(), person_id = p_person where id = r.id returning * into r;
  insert into audit_event (org_id, actor_id, actor_account, action, resource, resource_id, fields, changes)
  values (current_org(), current_viewer(), nullif(current_setting('pulse.actor_account', true), ''), 'staff_added_by_ai_request', 'person', p_person::text,
    array['request', 'ai', 'approver'],
    jsonb_build_object('Asked by (AI)', jsonb_build_object('before', null, 'after', r.requested_by::text),
      'Approved by', jsonb_build_object('before', null, 'after', current_viewer()::text),
      'Request', jsonb_build_object('before', null, 'after', r.id::text)));
  update notification set read_at = coalesce(read_at, now()) where org_id = current_org() and subject_type = 'staff_add_request' and subject_id = r.id;
  perform staff_add_tell_ai(r);
  return staff_add_request_json(r.id);
end $$;
revoke all on function pulse.staff_add_request_done(uuid, uuid) from public;
grant execute on function pulse.staff_add_request_done(uuid, uuid) to pulse_api;

/** Decline, with a reason the AI is told. Nothing is created. */
create function pulse.staff_add_request_decline(p_id uuid, p_reason text) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r staff_add_request; why text := nullif(regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g'), '');
begin
  r := staff_add_request_lock(p_id);
  if why is null or length(why) < 3 then raise exception 'Say why in a few words, so the AI can tell whoever asked' using errcode = '22023'; end if;
  if length(why) > 500 then raise exception 'Keep the reason under 500 letters' using errcode = '22023'; end if;
  update staff_add_request set status = 'declined', decided_by = current_viewer(), decided_at = now(), decline_reason = why where id = r.id returning * into r;
  perform audit_write('staff_add_declined', 'staff_add_request', r.id::text, array['reason']);
  update notification set read_at = coalesce(read_at, now()) where org_id = current_org() and subject_type = 'staff_add_request' and subject_id = r.id;
  perform staff_add_tell_ai(r);
  return staff_add_request_json(r.id);
end $$;
revoke all on function pulse.staff_add_request_decline(uuid, text) from public;
grant execute on function pulse.staff_add_request_decline(uuid, text) to pulse_api;

/** My desk → Approvals: requests to add staff the viewer may see (pending first, then the last 30 days). */
create function pulse.staff_add_requests() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(staff_add_request_json(r.id) order by (r.status = 'pending' and r.expires_at > now()) desc, r.created_at desc), '[]'::jsonb)
  from staff_add_request r
  where r.org_id = current_org() and agent_session() is null
    and (viewer_is('admin', 'hr', 'leadership') or current_viewer() = any(r.approvers))
    and (r.status = 'pending' or r.created_at > now() - interval '30 days')
$$;
revoke all on function pulse.staff_add_requests() from public;
grant execute on function pulse.staff_add_requests() to pulse_api;

/** The AI's own request, or one an approver or HR may see. */
create function pulse.staff_add_request_read(p_id uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if not exists (select 1 from staff_add_request r where r.org_id = current_org() and r.id = p_id
     and (r.requested_by = current_viewer() or (agent_session() is null and (viewer_is('admin', 'hr', 'leadership') or current_viewer() = any(r.approvers))))) then
    raise exception 'Request not found' using errcode = 'P0002'; end if;
  return staff_add_request_json(p_id);
end $$;
revoke all on function pulse.staff_add_request_read(uuid) from public;
grant execute on function pulse.staff_add_request_read(uuid) to pulse_api;

-- The bell: an approval notice about a request to add staff reaches only the people it asked, while it waits.
do $$
declare definition text; changed text;
begin
  definition := pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
  changed := replace(definition, ' elsif p_type in (''request.updated'',''request.decision'',''leave.decision'',''approval.waiting'',''approval.reminder'') then',
    ' elsif p_subject=''staff_add_request'' then
  return p_type=''approval.waiting'' and exists(select 1 from staff_add_request r where r.org_id=current_org() and r.id=p_id and r.status=''pending'' and p_person=any(r.approvers));
 elsif p_type in (''request.updated'',''request.decision'',''leave.decision'',''approval.waiting'',''approval.reminder'') then');
  if changed = definition then raise exception 'notification_recipient_allowed changed shape'; end if;
  execute changed;
end $$;

-- 2 -----------------------------------------------------------------------------------------------------------------
create table pulse.hr_agent_notice (
  org_id uuid not null references pulse.org(id),
  flow_id uuid not null references pulse.hr_flow(id),
  stage text not null,
  agent_id uuid not null references pulse.person(id),
  approver_id uuid not null references pulse.person(id),
  channel text not null default 'bell' check (channel in ('bell', 'call')),
  notification_id uuid,
  sent_at timestamptz not null default now(),
  reminded_at timestamptz,
  primary key (org_id, flow_id, stage)
);
alter table pulse.hr_agent_notice enable row level security;
alter table pulse.hr_agent_notice force row level security;
create policy tenant_isolation on pulse.hr_agent_notice using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.hr_agent_notice to pulse_api, pulse_worker;

/** The company's HR AI employee on duty: an active AI employee an admin lets read attendance (2300), or null. */
create function pulse.hr_agent_on_duty() returns uuid language sql stable security definer set search_path = pulse, pg_temp as $$
  select m.person_id from agent_member m join person p on p.id = m.person_id
   where m.org_id = current_org() and m.disabled_at is null and p.status = 'active' and p.side = 'agent' and 'attendance' = any(m.reads)
   order by m.employee_no nulls last, m.created_at, m.person_id limit 1
$$;
revoke all on function pulse.hr_agent_on_duty() from public;
grant execute on function pulse.hr_agent_on_duty() to pulse_api, pulse_worker;

/** The one person who decides a request at its stage: a co-founder when forwarded; HR first at the HR stage; otherwise
 *  the applicant's team head, then HR, an admin or leadership. Never the applicant. */
create function pulse.hr_flow_approver(p_flow uuid) returns uuid language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when f.stage = 'cofounder' then
      (select c.person_id from hr_cofounder c join person p on p.id = c.person_id where c.org_id = f.org_id and c.active and p.status = 'active' and p.side = 'staff'
        and c.person_id <> f.person_id order by p.display_name, p.id limit 1)
    else coalesce(
      case when f.stage <> 'hr' then (select p.id from person p where p.id = hr_head(f.person_id) and p.status = 'active' and p.side = 'staff' and p.id <> f.person_id) end,
      (select ra.person_id from role_assignment ra join person p on p.id = ra.person_id where ra.org_id = f.org_id and ra.role_key in ('hr', 'admin', 'leadership')
        and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity') and p.status = 'active' and p.side = 'staff' and ra.person_id <> f.person_id
        order by array_position(array['hr', 'admin', 'leadership'], ra.role_key), p.display_name, p.id limit 1)) end
  from hr_flow f where f.org_id = current_org() and f.id = p_flow
$$;
revoke all on function pulse.hr_flow_approver(uuid) from public;
grant execute on function pulse.hr_flow_approver(uuid) to pulse_api, pulse_worker;

/** What the HR AI says to the approver: who asked for what, in plain words. */
create function pulse.hr_agent_notice_title(f pulse.hr_flow, p_agent uuid, p_reminder boolean) returns text language sql stable security definer set search_path = pulse, pg_temp as $$
  select left((select display_name from person where id = p_agent) || ': ' || case when p_reminder then 'still waiting. ' else '' end
    || (select display_name from person where id = f.person_id)
    || case when f.kind = 'leave' then ' asked for leave, ' else ' asked to fix attendance, ' end
    || to_char(f.from_date, 'FMDD Mon') || case when f.to_date <> f.from_date then '–' || to_char(f.to_date, 'FMDD Mon') else '' end
    || '. Please decide.', 200)
$$;
revoke all on function pulse.hr_agent_notice_title(pulse.hr_flow, uuid, boolean) from public;

/** One notice per request and stage, from the HR AI to the approver. Returns false when there is no AI on duty or no
 *  approver (the caller then keeps today's behaviour). */
create function pulse.hr_agent_notify(f pulse.hr_flow) returns boolean language plpgsql security definer set search_path = pulse, pg_temp as $$
declare agent uuid; approver uuid; nid uuid;
begin
  if f.kind not in ('leave', 'correction') or f.status <> 'pending' then return false; end if;
  select agent_id into agent from hr_agent_notice where org_id = f.org_id and flow_id = f.id limit 1;
  agent := coalesce(agent, hr_agent_on_duty());
  if agent is null then return false; end if;
  if exists (select 1 from hr_agent_notice where org_id = f.org_id and flow_id = f.id and stage = f.stage) then return true; end if;
  approver := hr_flow_approver(f.id);
  if approver is null then return exists (select 1 from hr_agent_notice where org_id = f.org_id and flow_id = f.id); end if;
  insert into hr_agent_notice (org_id, flow_id, stage, agent_id, approver_id) values (f.org_id, f.id, f.stage, agent, approver) on conflict do nothing;
  if not found then return true; end if;
  nid := notification_emit(approver, 'approval.waiting', 'hr_flow', f.id,
    left('hr-agent:' || f.person_id || ':' || f.kind || ':' || f.from_date || ':' || f.to_date || ':' || f.stage, 200),
    hr_agent_notice_title(f, agent, false), '/me/approvals?request=' || f.id, 'approval', true);
  update hr_agent_notice set notification_id = nid where org_id = f.org_id and flow_id = f.id and stage = f.stage;
  return true;
end $$;
revoke all on function pulse.hr_agent_notify(pulse.hr_flow) from public;

-- 0135's hr_flow_publish, with the HR AI's one notice for leave and corrections when an HR AI is on duty.
create or replace function pulse.hr_flow_publish() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare recipient uuid;nid uuid;label text;act text;event_id uuid;event_type_key text;
begin
 if TG_OP='UPDATE' and (new.status,new.stage,new.decision_note,new.decided_by) is not distinct from (old.status,old.stage,old.decision_note,old.decided_by) then return null;end if;
 act:=case when TG_OP='INSERT' and current_viewer() is null then 'imported' when TG_OP='INSERT' then case when new.status='pending' then 'submitted' else 'recorded: '||new.status end when new.status<>old.status then new.status when new.status<>'pending' then 'override: '||new.status when new.stage<>old.stage then 'forwarded to '||new.stage else 'asked' end;
 insert into hr_flow_event(org_id,flow_id,actor_id,action,note) values(new.org_id,new.id,current_viewer(),act,case when TG_OP='INSERT' then new.note else new.decision_note end) returning id into event_id;
 if current_viewer() is null then return null;end if;
 label:='HR request '||case when new.status<>'pending' then new.status when TG_OP='INSERT' then 'submitted' when new.stage='cofounder' then 'forwarded' else 'updated' end;
 event_type_key:=case when new.status<>'pending' then case when new.kind='leave' then 'leave.decision' else 'request.decision' end else 'request.updated' end;
 -- HR-AGENT: with an HR AI on duty, the applicant hears as before and the approver gets the AI's one notice (none on edits).
 if new.kind in ('leave','correction') and ((TG_OP='INSERT' and new.status='pending' and hr_agent_on_duty() is not null)
   or exists(select 1 from hr_agent_notice x where x.org_id=new.org_id and x.flow_id=new.id)) then
  if new.status<>'pending' or hr_agent_notify(new) then
   perform notification_emit(new.person_id,event_type_key,'hr_flow',new.id,event_id::text,label,'/me/approvals?request='||new.id,case when new.status='pending' then 'approval' else 'decision' end,true);
   return null;
  end if;
 end if;
 for recipient in select distinct id from person where org_id=new.org_id and status='active' and
 (id=new.person_id or id=hr_head(new.person_id) or hr_is_staff(id) or (new.stage='cofounder' and hr_is_cofounder(id))) loop
 perform notification_emit(recipient,case when new.status='pending' and recipient<>new.person_id and ((new.stage='cofounder' and hr_is_cofounder(recipient)) or (new.stage<>'cofounder' and (hr_is_staff(recipient) or hr_head(new.person_id)=recipient))) then 'approval.waiting' else event_type_key end,'hr_flow',new.id,event_id::text,label,'/me/approvals?request='||new.id,case when new.status='pending' then 'approval' else 'decision' end,true);
 end loop;return null;
end $$;

/** The HR AI's one reminder: a request it announced that still waits after p_hours at the same stage reminds the same
 *  approver once (reminded_at), never again. hr_flow_remind calls it inside HR's reminder rules (policy, 10:30, work day). */
create function pulse.hr_agent_remind(p_hours int) returns int language plpgsql security definer set search_path = pulse, pg_temp as $$
declare x record; nid uuid; n int := 0;
begin
  if p_hours is null then return 0; end if;
  for x in select h.*, q as flow from hr_agent_notice h join hr_flow q on q.org_id = h.org_id and q.id = h.flow_id and q.status = 'pending' and q.stage = h.stage
    where h.org_id = current_org() and h.reminded_at is null and h.sent_at < clock_timestamp() - make_interval(hours => p_hours) for update of h skip locked loop
    update hr_agent_notice set reminded_at = clock_timestamp() where org_id = x.org_id and flow_id = x.flow_id and stage = x.stage;
    nid := notification_emit(x.approver_id, 'approval.reminder', 'hr_flow', x.flow_id, left('hr-agent-reminder:' || x.flow_id || ':' || x.stage, 200),
      hr_agent_notice_title(x.flow, x.agent_id, true), '/me/approvals?request=' || x.flow_id, 'approval', true);
    if nid is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke all on function pulse.hr_agent_remind(int) from public;
grant execute on function pulse.hr_agent_remind(int) to pulse_worker;

-- 0860's hr_flow_remind (one daily digest per approver), leaving out requests the HR AI announced; each of those gets at
-- most one reminder, to the approver it told, after the same reminder_hours (only when HR's policy sends reminders).
create or replace function pulse.hr_flow_remind() returns integer language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a record; n int:=0; tz text:=org_time_zone(current_org()); today date:=(clock_timestamp() at time zone org_time_zone(current_org()))::date;
 hours int; waiting int; nid uuid;
begin
 select reminder_hours into hours from hr_flow_policy where org_id=current_org();
 if hours is null then return 0; end if;
 if (clock_timestamp() at time zone tz)::time<time '10:30' or not hr_working(null,today,(select work_days from hr_policy where org_id=current_org())) then return 0; end if;
 for a in select r.id approver, array_agg(q.id order by q.created_at) flows from hr_flow q
  join person r on r.org_id=q.org_id and r.status='active' and r.id<>q.person_id
   and ((q.stage='cofounder' and hr_is_cofounder(r.id)) or (q.stage<>'cofounder' and (hr_is_staff(r.id) or r.id=hr_head(q.person_id))))
  where q.org_id=current_org() and q.status='pending' and coalesce(q.reminded_at,q.updated_at)<clock_timestamp()-make_interval(hours=>hours)
   and not exists(select 1 from hr_agent_notice h where h.org_id=q.org_id and h.flow_id=q.id)
  group by r.id loop
  waiting:=coalesce(array_length(a.flows,1),0);
  if waiting=0 then continue; end if;
  nid:=notification_emit(a.approver,'approval.digest','person',a.approver,'digest:'||today,
   case when waiting=1 then '1 request waits for your decision' else waiting||' requests wait for your decision' end,'/me/approvals','approval',true);
  if nid is not null then n:=n+1; end if;
 end loop;
 n:=n+hr_agent_remind(hours);
 update hr_flow set reminded_at=clock_timestamp() where org_id=current_org() and status='pending'
  and coalesce(reminded_at,updated_at)<clock_timestamp()-make_interval(hours=>hours);
 return n;
end $$;

-- migrate:down
-- Forward-only: requests and notices stay on record.
