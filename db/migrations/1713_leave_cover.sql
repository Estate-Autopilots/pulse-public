-- migrate:up
-- KAZUK-REST slice 6 (F11, Kazuk's 3 Nov meeting; KAZUK-requirements F1): the leave and work-from-home SOP with a
-- fallback, and published HR policies with acknowledgement tracking.
--  1. Cover (the fallback): whoever asks for leave or a work-from-home day names the colleague who covers for them. That
--     colleague is told and accepts or declines. If they decline, or do not answer within the company's hours
--     (hr_flow_policy.cover_hours, default 24), it goes up: the person's manager (hr_head) and HR are told, and HR names
--     someone else. HR can make naming a cover required (hr_flow_policy.cover_required, default off).
--     The hours covered default to the away person's shift on the first day (pulse.person_shift), else the company's
--     shift (pulse.hr_policy); the steps people read are HR's own text (hr_flow_policy.cover_sop), else the standard ones.
--     pulse.leave_cover        one ask: the leave request or WFH day, the person, the cover, its state and deadline.
--                              Read by the person, the cover, the person's manager and HR (row security); written only
--                              through the functions below.
--  2. Acknowledgements: HR sees, for a published policy version, who has acknowledged it and who has not, and reminds
--     the ones who have not (at most once a day each; an in-app notice, nothing leaves Pulse).
--     pulse.policy_ack_nudge   when each person was last reminded about a version.
alter table pulse.hr_flow_policy
  add column if not exists cover_hours int not null default 24 check (cover_hours between 1 and 168),
  add column if not exists cover_required boolean not null default false,
  add column if not exists cover_sop text check (length(cover_sop) <= 4000);

create table pulse.leave_cover (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('leave', 'wfh')),
  source_id uuid not null,                                   -- leave_request.id (leave) or attendance_regularisation.id (wfh)
  person_id uuid not null references pulse.person(id),       -- who is away
  cover_id uuid not null references pulse.person(id),        -- who covers
  from_date date not null,
  to_date date not null,
  cover_start time,                                          -- the hours covered (from the shift unless named)
  cover_end time,
  note text check (length(note) <= 300),
  status text not null default 'asked' check (status in ('asked', 'accepted', 'declined', 'escalated', 'cancelled')),
  respond_by timestamptz not null,
  answered_at timestamptz,
  answer_note text check (length(answer_note) <= 300),
  escalated_at timestamptz,
  escalated_why text check (escalated_why in ('declined', 'no_answer')),
  asked_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  check (to_date >= from_date),
  check (cover_id <> person_id)
);
create index leave_cover_source on pulse.leave_cover (org_id, source_id, created_at desc);
create index leave_cover_cover on pulse.leave_cover (org_id, cover_id, status);
create index leave_cover_due on pulse.leave_cover (org_id, status, respond_by) where status = 'asked';
alter table pulse.leave_cover enable row level security;
alter table pulse.leave_cover force row level security;
create policy tenant on pulse.leave_cover using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy visible on pulse.leave_cover as restrictive to pulse_api
  using (person_id = pulse.current_viewer() or cover_id = pulse.current_viewer() or pulse.viewer_is('admin', 'hr', 'leadership') or pulse.manages(person_id));
grant select on pulse.leave_cover to pulse_api;

create table pulse.policy_ack_nudge (
  org_id uuid not null references pulse.org(id),
  document_id uuid not null references pulse.policy_document(id),
  person_id uuid not null references pulse.person(id),
  at timestamptz not null default now(),
  by_person uuid references pulse.person(id),
  primary key (org_id, document_id, person_id)
);
alter table pulse.policy_ack_nudge enable row level security;
alter table pulse.policy_ack_nudge force row level security;
create policy tenant on pulse.policy_ack_nudge using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy visible on pulse.policy_ack_nudge as restrictive to pulse_api using (pulse.viewer_is('admin', 'hr', 'leadership'));
grant select on pulse.policy_ack_nudge to pulse_api;

/** An in-app notice for one person, once per key (nothing leaves Pulse). */
create function pulse.hr_notice(p_person uuid, p_title text, p_href text, p_key text) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not exists (select 1 from person where org_id = current_org() and id = p_person and side = 'staff' and status = 'active') then return; end if;
  insert into notification (org_id, person_id, title, href, kind, event_type, event_key)
  values (current_org(), p_person, left(p_title, 200), p_href, 'update', 'update.self', left(p_key, 200))
  on conflict (org_id, person_id, event_type, event_key) do nothing;
end $$;
revoke all on function pulse.hr_notice(uuid, text, text, text) from public;

/** The people HR tells: HR role holders today, else the company's admins. */
create function pulse.hr_people() returns setof uuid
language sql stable security definer set search_path = pulse, pg_temp as $$
  with hr as (select distinct r.person_id from role_assignment r join person p on p.id = r.person_id and p.status = 'active' and p.side = 'staff'
    where r.org_id = current_org() and r.role_key = 'hr' and current_date between r.valid_from and coalesce(r.valid_to, 'infinity'))
  select person_id from hr
  union all
  select distinct r.person_id from role_assignment r join person p on p.id = r.person_id and p.status = 'active' and p.side = 'staff'
   where r.org_id = current_org() and r.role_key = 'admin' and current_date between r.valid_from and coalesce(r.valid_to, 'infinity') and not exists (select 1 from hr)
$$;
revoke all on function pulse.hr_people() from public;

/** The working hours a cover takes on: the person's own shift on that day, else the company's shift. */
create function pulse.cover_shift(p_person uuid, p_day date, out start_at time, out end_at time)
language sql stable security definer set search_path = pulse, pg_temp as $$
  select * from (
    (select s.start_time, s.end_time from person_shift a join shift s on s.id = a.shift_id
      where a.org_id = current_org() and a.person_id = p_person and a.valid_from <= p_day and (a.valid_to is null or a.valid_to >= p_day)
      order by a.valid_from desc limit 1)
    union all
    select h.shift_start, h.shift_end from hr_policy h where h.org_id = current_org()
  ) x limit 1
$$;
revoke all on function pulse.cover_shift(uuid, date) from public;

/** Name the colleague who covers a leave request or a work-from-home day. The person themselves (while it is waiting or
 *  approved and not over) or HR may ask; asking again replaces an earlier ask that is still open. */
create function pulse.leave_cover_ask(p_kind text, p_source uuid, p_cover uuid, p_note text, p_start time default null, p_end time default null) returns uuid
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); v_person uuid; v_from date; v_to date; v_status text; v_hours int; v_name text; v_id uuid; v_cover_name text;
  v_start time; v_end time;
begin
  if me is null then raise exception 'A person names a cover' using errcode = '42501'; end if;
  if p_kind = 'leave' then
    select person_id, from_date, to_date, status into v_person, v_from, v_to, v_status from leave_request where id = p_source and org_id = current_org();
  elsif p_kind = 'wfh' then
    select person_id, work_date, work_date, status into v_person, v_from, v_to, v_status from attendance_regularisation where id = p_source and org_id = current_org() and kind = 'wfh';
  else raise exception 'Choose leave or work from home' using errcode = '22023'; end if;
  if v_person is null then raise exception 'Request not found' using errcode = 'P0002'; end if;
  if v_person <> me and not viewer_is('admin', 'hr', 'leadership') then raise exception 'Only the person or HR names who covers' using errcode = '42501'; end if;
  if v_status not in ('pending', 'approved') then raise exception 'This request is closed' using errcode = '22023'; end if;
  if v_to < (now() at time zone org_time_zone())::date then raise exception 'These dates are over' using errcode = '22023'; end if;
  if p_cover = v_person then raise exception 'Choose a colleague, not the person who is away' using errcode = '22023'; end if;
  select display_name into v_cover_name from person where org_id = current_org() and id = p_cover and side = 'staff' and status = 'active';
  if v_cover_name is null then raise exception 'Choose an active colleague' using errcode = '22023'; end if;
  if exists (select 1 from leave_request l where l.org_id = current_org() and l.person_id = p_cover and l.status in ('pending', 'approved') and l.to_date >= v_from and l.from_date <= v_to) then
    raise exception '% is on leave on some of these days; choose someone else', v_cover_name using errcode = '22023'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'Keep the note under 300 characters' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('leave-cover:' || p_source::text));
  update leave_cover set status = 'cancelled' where org_id = current_org() and source_id = p_source and status in ('asked', 'escalated', 'declined');
  select coalesce((select cover_hours from hr_flow_policy where org_id = current_org()), 24) into v_hours;
  if (p_start is null) <> (p_end is null) then raise exception 'Give both times, or neither' using errcode = '22023'; end if;
  if p_start is not null then v_start := p_start; v_end := p_end;
  else select s.start_at, s.end_at into v_start, v_end from cover_shift(v_person, v_from) s; end if;
  insert into leave_cover (org_id, kind, source_id, person_id, cover_id, from_date, to_date, cover_start, cover_end, note, respond_by, asked_by)
  values (current_org(), p_kind, p_source, v_person, p_cover, v_from, v_to, v_start, v_end, nullif(btrim(coalesce(p_note, '')), ''), now() + make_interval(hours => v_hours), me)
  returning id into v_id;
  select display_name into v_name from person where id = v_person;
  perform hr_notice(p_cover, format('Can you cover for %s (%s%s)? Please answer within %s hours', v_name,
    case when v_from = v_to then to_char(v_from, 'DD Mon') else to_char(v_from, 'DD Mon') || ' to ' || to_char(v_to, 'DD Mon') end,
    case when v_start is null then '' else ', ' || to_char(v_start, 'HH24:MI') || ' to ' || to_char(v_end, 'HH24:MI') end, v_hours), '/cover', 'cover:' || v_id || ':ask');
  return v_id;
end $$;

/** The cover answers. A decline goes straight up to the manager and HR. */
create function pulse.leave_cover_answer(p_id uuid, p_accept boolean, p_note text) returns text
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c leave_cover; v_name text;
begin
  select * into c from leave_cover where id = p_id and org_id = current_org() for update;
  -- Only the colleague asked answers; to anyone else the ask does not exist.
  if not found or c.cover_id is distinct from current_viewer() then raise exception 'Cover ask not found' using errcode = 'P0002'; end if;
  if c.status <> 'asked' then raise exception 'This ask is already answered' using errcode = '22023'; end if;
  if not p_accept and length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'Say why, so HR can find someone else' using errcode = '22023'; end if;
  update leave_cover set status = case when p_accept then 'accepted' else 'declined' end, answered_at = now(), answer_note = nullif(left(btrim(coalesce(p_note, '')), 300), '')
   where id = p_id;
  select display_name into v_name from person where id = c.cover_id;
  perform hr_notice(c.person_id, format('%s %s your cover', v_name, case when p_accept then 'accepted' else 'cannot take' end), '/cover', 'cover:' || p_id || ':answer');
  if not p_accept then perform leave_cover_escalate(p_id, 'declined'); end if;
  return case when p_accept then 'accepted' else 'escalated' end;
end $$;

/** One ask goes up: the manager and HR are told that a fallback is needed. */
create function pulse.leave_cover_escalate(p_id uuid, p_why text) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c leave_cover; v_name text; v_who uuid;
begin
  select * into c from leave_cover where id = p_id and org_id = current_org();
  if not found or c.status not in ('asked', 'declined') then return; end if;
  update leave_cover set status = 'escalated', escalated_at = now(), escalated_why = p_why where id = p_id;
  select display_name into v_name from person where id = c.person_id;
  for v_who in select distinct x from (select hr_head(c.person_id) x union all select hr_people()) s where x is not null and x <> c.person_id loop
    perform hr_notice(v_who, format('%s needs someone to cover %s: %s', v_name,
      case when c.from_date = c.to_date then to_char(c.from_date, 'DD Mon') else to_char(c.from_date, 'DD Mon') || ' to ' || to_char(c.to_date, 'DD Mon') end,
      case p_why when 'declined' then 'the colleague asked cannot' else 'no answer in time' end), '/cover', 'cover:' || p_id || ':up');
  end loop;
end $$;

/** Asks past their deadline go up. Idempotent; run on every read of the cover page and by the notifications worker. */
create function pulse.leave_cover_escalate_due() returns integer
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r record; n integer := 0;
begin
  for r in select id from leave_cover where org_id = current_org() and status = 'asked' and respond_by < now() for update skip locked loop
    perform leave_cover_escalate(r.id, 'no_answer'); n := n + 1;
  end loop;
  -- A request withdrawn, rejected or cancelled closes its cover.
  update leave_cover c set status = 'cancelled' where c.org_id = current_org() and c.status in ('asked', 'accepted', 'escalated', 'declined') and (
    (c.kind = 'leave' and exists (select 1 from leave_request l where l.id = c.source_id and l.status in ('rejected', 'cancelled'))) or
    (c.kind = 'wfh' and exists (select 1 from attendance_regularisation a where a.id = c.source_id and a.status in ('rejected', 'cancelled'))));
  return n;
end $$;

/** HR sets the cover rule: how many hours a colleague has to answer, whether naming a cover is required, and the steps
 *  people read (p_sop: null keeps HR's text, empty goes back to the standard steps). */
create function pulse.leave_cover_policy_set(p_hours int, p_required boolean, p_sop text default null) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_sop text;
begin
  if current_viewer() is null or not viewer_is('admin', 'hr', 'leadership') then raise exception 'HR sets the cover rule' using errcode = '42501'; end if;
  if p_hours is null or p_hours not between 1 and 168 then raise exception 'Choose 1 to 168 hours' using errcode = '22023'; end if;
  if length(p_sop) > 4000 then raise exception 'Keep the steps under 4,000 characters' using errcode = '22023'; end if;
  insert into hr_flow_policy (org_id, cover_hours, cover_required, cover_sop, updated_by)
  values (current_org(), p_hours, coalesce(p_required, false), nullif(btrim(coalesce(p_sop, '')), ''), current_viewer())
  on conflict (org_id) do update set cover_hours = excluded.cover_hours, cover_required = excluded.cover_required,
    cover_sop = case when p_sop is null then hr_flow_policy.cover_sop else excluded.cover_sop end, updated_by = excluded.updated_by, updated_at = now()
  returning cover_sop into v_sop;
  return jsonb_build_object('hours', p_hours, 'required', coalesce(p_required, false), 'sop', v_sop);
end $$;

/** HR: for one published policy version, who acknowledged it and who has not yet (active staff), with each reminder. */
create function pulse.policy_ack_status(p_document uuid) returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare d policy_document;
begin
  if current_viewer() is null or not viewer_is('admin', 'hr', 'leadership') then raise exception 'HR tracks acknowledgements' using errcode = '42501'; end if;
  select * into d from policy_document where id = p_document and org_id = current_org();
  if not found then raise exception 'Policy not found' using errcode = 'P0002'; end if;
  return jsonb_build_object('documentId', d.id, 'kind', d.kind, 'title', d.title, 'version', d.version, 'status', d.status,
    'acknowledged', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'at', a.at) order by a.at desc), '[]')
       from policy_ack a join person p on p.id = a.person_id where a.org_id = current_org() and a.document_id = d.id),
    'pending', (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'remindedAt', n.at) order by p.display_name), '[]')
       from person p left join policy_ack_nudge n on n.org_id = p.org_id and n.document_id = d.id and n.person_id = p.id
       where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'
         and not exists (select 1 from policy_ack a where a.org_id = p.org_id and a.document_id = d.id and a.person_id = p.id)),
    'total', (select count(*) from person p where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'));
end $$;

/** HR reminds everyone who has not acknowledged a published version yet (each at most once in 20 hours). */
create function pulse.policy_ack_remind(p_document uuid) returns integer
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d policy_document; r record; n integer := 0;
begin
  if current_viewer() is null or not viewer_is('admin', 'hr', 'leadership') then raise exception 'HR reminds people to acknowledge' using errcode = '42501'; end if;
  select * into d from policy_document where id = p_document and org_id = current_org();
  if not found then raise exception 'Policy not found' using errcode = 'P0002'; end if;
  if d.status <> 'published' then raise exception 'Publish the policy first' using errcode = '22023'; end if;
  for r in select p.id from person p left join policy_ack_nudge x on x.org_id = p.org_id and x.document_id = d.id and x.person_id = p.id
    where p.org_id = current_org() and p.side = 'staff' and p.status = 'active' and p.id <> current_viewer()
      and not exists (select 1 from policy_ack a where a.org_id = p.org_id and a.document_id = d.id and a.person_id = p.id)
      and (x.at is null or x.at < now() - interval '20 hours') loop
    insert into policy_ack_nudge (org_id, document_id, person_id, at, by_person) values (current_org(), d.id, r.id, now(), current_viewer())
      on conflict (org_id, document_id, person_id) do update set at = now(), by_person = excluded.by_person;
    perform hr_notice(r.id, format('Please read and acknowledge the %s policy (version %s)', d.title, d.version), '/me?tab=policies&kind=' || d.kind,
      'policy-ack:' || d.id || ':' || to_char(now(), 'YYYYMMDDHH24MI'));
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function pulse.leave_cover_ask(text, uuid, uuid, text, time, time), pulse.leave_cover_answer(uuid, boolean, text), pulse.leave_cover_escalate(uuid, text),
  pulse.leave_cover_escalate_due(), pulse.leave_cover_policy_set(int, boolean, text), pulse.policy_ack_status(uuid), pulse.policy_ack_remind(uuid) from public;
grant execute on function pulse.leave_cover_ask(text, uuid, uuid, text, time, time), pulse.leave_cover_answer(uuid, boolean, text), pulse.leave_cover_escalate_due(),
  pulse.leave_cover_policy_set(int, boolean, text), pulse.policy_ack_status(uuid), pulse.policy_ack_remind(uuid) to pulse_api;
grant execute on function pulse.leave_cover_escalate_due() to pulse_worker;

-- migrate:down
-- Forward-only: covers and reminders people recorded are kept.
