-- migrate:up
-- The Team & HR suite: skills on the staff record, attendance with breaks, late marks, work from home and
-- regularisation requests, leave types with accrual rules, balances, holidays, the HR requests desk, the HR policy
-- an organisation sets for itself, and salary entries made in Pulse. Requests are visible to the person who made
-- them, their manager, HR and admins. Salary stays in pulse_priv behind the named permissions; every read is logged.

alter table pulse.people_profile
  add column skills        text[] not null default '{}',
  add column work_location text;

-- The viewer is the manager on this person's record.
create function pulse.manages(p_person uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from people_profile where org_id = pulse.current_org() and person_id = p_person
                   and manager_id = pulse.current_viewer())
$$;

-- ------------------------------------------------------------------------------------------------------ policy
create table pulse.hr_policy (                                -- one row per organisation
  org_id            uuid primary key references pulse.org(id),
  shift_start       time not null default '10:00',
  shift_end         time not null default '19:00',
  grace_minutes     int  not null default 15 check (grace_minutes between 0 and 240),
  work_days         int[] not null default '{1,2,3,4,5,6}',   -- ISO weekdays, Monday = 1
  wfh_per_month     int check (wfh_per_month between 0 and 31),   -- null: no monthly limit
  leave_year_start  int  not null default 1 check (leave_year_start between 1 and 12),
  tracking_from     date not null default (date_trunc('month', now() at time zone 'Asia/Kolkata'))::date,
  confirmed_at      timestamptz,                              -- null: these are Pulse's starting values, not yet HR's
  confirmed_by      uuid references pulse.person(id),
  updated_at        timestamptz not null default now()
);

-- -------------------------------------------------------------------------------------------------- attendance
alter table pulse.attendance_entry
  add column work_date    date not null default ((now() at time zone 'Asia/Kolkata')::date),
  add column mode         text not null default 'office' check (mode in ('office','wfh','field')),
  add column late_minutes int  not null default 0 check (late_minutes >= 0),
  add column missed_out   boolean not null default false,     -- closed by the next check-in, not by the person
  add column source       text not null default 'self' check (source in ('self','regularised')),
  add column note         text;
update pulse.attendance_entry set work_date = (checked_in_at at time zone 'Asia/Kolkata')::date;
create index attendance_day on pulse.attendance_entry (org_id, work_date, person_id);

create table pulse.attendance_break (
  org_id     uuid not null references pulse.org(id),
  id         uuid primary key default gen_random_uuid(),
  entry_id   uuid not null references pulse.attendance_entry(id) on delete cascade,
  person_id  uuid not null references pulse.person(id),
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create unique index attendance_break_open on pulse.attendance_break (entry_id) where ended_at is null;
create index attendance_break_entry on pulse.attendance_break (org_id, entry_id);

create table pulse.attendance_regularisation (                -- "please correct my attendance for this day"
  org_id        uuid not null references pulse.org(id),
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references pulse.person(id),
  work_date     date not null,
  kind          text not null check (kind in ('missed_punch','wfh','on_duty','late')),
  in_time       time,
  out_time      time,
  reason        text not null check (length(trim(reason)) between 5 and 500),
  status        text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  decided_by    uuid references pulse.person(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now()
);
create index attendance_regularisation_person on pulse.attendance_regularisation (org_id, person_id, work_date desc);
create index attendance_regularisation_open on pulse.attendance_regularisation (org_id, status);

-- ------------------------------------------------------------------------------------------------------- leave
create table pulse.leave_type (
  org_id            uuid not null references pulse.org(id),
  key               text not null check (key ~ '^[a-z][a-z0-9_]{1,23}$'),
  name              text not null,
  paid              boolean not null default true,
  annual_days       numeric(5,1) check (annual_days >= 0),    -- null: no allowance, taken as needed
  accrual           text not null default 'monthly' check (accrual in ('monthly','yearly','none')),
  carry_forward_max numeric(5,1) not null default 0 check (carry_forward_max >= 0),
  active            boolean not null default true,
  sort              int not null default 0,
  primary key (org_id, key)
);
alter table pulse.leave_request
  drop constraint leave_request_leave_kind_check,
  drop constraint leave_request_status_check,
  add constraint leave_request_status_check check (status in ('pending','approved','rejected','cancelled')),
  add column reason        text,
  add column half_day      text check (half_day in ('first','second')),
  add column days          numeric(4,1),
  add column decision_note text;
update pulse.leave_request set days = (to_date - from_date) + 1 where days is null;
create index leave_request_dates on pulse.leave_request (org_id, from_date, to_date);

create table pulse.leave_adjustment (                         -- opening balances and corrections, always with a reason
  org_id     uuid not null references pulse.org(id),
  id         uuid primary key default gen_random_uuid(),
  person_id  uuid not null references pulse.person(id),
  type_key   text not null,
  leave_year int  not null,
  days       numeric(5,1) not null check (days <> 0),
  reason     text not null check (length(trim(reason)) between 3 and 300),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now()
);
create index leave_adjustment_person on pulse.leave_adjustment (org_id, person_id, leave_year);

create table pulse.holiday (
  org_id   uuid not null references pulse.org(id),
  day      date not null,
  name     text not null check (length(trim(name)) between 2 and 80),
  optional boolean not null default false,
  primary key (org_id, day)
);

-- ----------------------------------------------------------------------------------------------- requests desk
create table pulse.hr_ticket (
  org_id      uuid not null references pulse.org(id),
  id          uuid primary key default gen_random_uuid(),
  no          int  not null,                                  -- shown as "HR-0042"
  person_id   uuid not null references pulse.person(id),      -- who raised it
  category    text not null check (category in ('payroll','leave','attendance','equipment','workplace','grievance','other')),
  subject     text not null check (length(trim(subject)) between 3 and 140),
  body        text not null default '',
  priority    text not null default 'normal' check (priority in ('low','normal','high')),
  status      text not null default 'open' check (status in ('open','in_progress','waiting','resolved','closed')),
  assignee_id uuid references pulse.person(id),
  resolution  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  resolved_at timestamptz,
  unique (org_id, no)
);
create index hr_ticket_person on pulse.hr_ticket (org_id, person_id, created_at desc);
create index hr_ticket_status on pulse.hr_ticket (org_id, status);
create table pulse.hr_ticket_event (
  org_id     uuid not null references pulse.org(id),
  id         uuid primary key default gen_random_uuid(),
  ticket_id  uuid not null references pulse.hr_ticket(id) on delete cascade,
  author_id  uuid references pulse.person(id),
  kind       text not null check (kind in ('comment','status','assigned','resolved')),
  body       text not null default '',
  internal   boolean not null default false,                  -- a note between HR and admins; hidden from the raiser
  created_at timestamptz not null default now()
);
create index hr_ticket_event_ticket on pulse.hr_ticket_event (org_id, ticket_id, created_at);

-- ------------------------------------------------------------------------------------------------ access rules
do $$ declare t text; begin
  foreach t in array array['hr_policy','attendance_break','attendance_regularisation','leave_type','leave_adjustment',
                           'holiday','hr_ticket','hr_ticket_event'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select, insert, update, delete on pulse.%I to pulse_worker', t);
    execute format('grant select on pulse.%I to pulse_api', t);
  end loop;
end $$;
grant insert, update on pulse.hr_policy, pulse.leave_type, pulse.attendance_break, pulse.attendance_regularisation to pulse_api;
grant insert, update, delete on pulse.holiday to pulse_api;
grant insert on pulse.leave_adjustment, pulse.hr_ticket_event to pulse_api;
grant update (status, assignee_id, resolution, priority, category, updated_at, resolved_at) on pulse.hr_ticket to pulse_api;

-- Attendance and leave: the person, their manager, HR and admins.
drop policy attendance_person on pulse.attendance_entry;
drop policy leave_person on pulse.leave_request;
do $$ declare t text; begin
  foreach t in array array['attendance_entry','leave_request','attendance_break','attendance_regularisation'] loop
    execute format($f$create policy own_or_team on pulse.%I as restrictive to pulse_api
      using (person_id = pulse.current_viewer() or pulse.viewer_is('admin','hr') or pulse.manages(person_id))
      with check (person_id = pulse.current_viewer() or pulse.viewer_is('admin','hr') or pulse.manages(person_id))$f$, t);
  end loop;
end $$;
-- Who is away is something the whole team may know; the reason is not. See pulse.team_away below.
create policy adjustment_read on pulse.leave_adjustment as restrictive for select to pulse_api
  using (person_id = pulse.current_viewer() or pulse.viewer_is('admin','hr'));
create policy adjustment_write on pulse.leave_adjustment as restrictive for insert to pulse_api
  with check (pulse.viewer_is('admin','hr') and created_by = pulse.current_viewer());
do $$ declare t text; begin
  foreach t in array array['hr_policy','leave_type','holiday'] loop      -- everyone reads the rules; HR and admins set them
    execute format($f$create policy hr_insert on pulse.%I as restrictive for insert to pulse_api with check (pulse.viewer_is('admin','hr'))$f$, t);
    execute format($f$create policy hr_update on pulse.%I as restrictive for update to pulse_api using (pulse.viewer_is('admin','hr')) with check (pulse.viewer_is('admin','hr'))$f$, t);
  end loop;
end $$;
create policy hr_delete on pulse.holiday as restrictive for delete to pulse_api using (pulse.viewer_is('admin','hr'));
create policy ticket_read on pulse.hr_ticket as restrictive for select to pulse_api
  using (person_id = pulse.current_viewer() or pulse.viewer_is('admin','hr'));
create policy ticket_update on pulse.hr_ticket as restrictive for update to pulse_api
  using (pulse.viewer_is('admin','hr') or person_id = pulse.current_viewer())
  with check (pulse.viewer_is('admin','hr') or person_id = pulse.current_viewer());
-- A note between HR and admins is hidden from the person who raised the request, even when that person is HR.
create policy ticket_event_read on pulse.hr_ticket_event as restrictive for select to pulse_api
  using (case when internal
    then pulse.viewer_is('admin','hr') and not exists (select 1 from pulse.hr_ticket t where t.id = ticket_id and t.person_id = pulse.current_viewer())
    else pulse.viewer_is('admin','hr') or exists (select 1 from pulse.hr_ticket t where t.id = ticket_id and t.person_id = pulse.current_viewer()) end);
create policy ticket_event_write on pulse.hr_ticket_event as restrictive for insert to pulse_api
  with check (author_id = pulse.current_viewer() and case when internal
    then pulse.viewer_is('admin','hr') and not exists (select 1 from pulse.hr_ticket t where t.id = ticket_id and t.person_id = pulse.current_viewer())
    else pulse.viewer_is('admin','hr') or exists (select 1 from pulse.hr_ticket t where t.id = ticket_id and t.person_id = pulse.current_viewer()) end);

-- Starting rules for an organisation that has none yet. They stay marked "not confirmed" until HR saves the policy.
create function pulse.hr_defaults() returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if pulse.current_org() is null or exists (select 1 from hr_policy where org_id = pulse.current_org()) then return; end if;
  insert into hr_policy(org_id, wfh_per_month) values (pulse.current_org(), 2) on conflict do nothing;
  insert into leave_type(org_id, key, name, paid, annual_days, accrual, carry_forward_max, sort) values
    (pulse.current_org(), 'annual', 'Paid leave', true, 12, 'monthly', 6, 1),
    (pulse.current_org(), 'sick', 'Sick leave', true, 6, 'yearly', 0, 2),
    (pulse.current_org(), 'unpaid', 'Unpaid leave', false, null, 'none', 0, 3)
    on conflict do nothing;
end $$;

-- Raising a request numbers it inside the organisation; the raiser cannot see other people's requests to count them.
create function pulse.hr_ticket_open(p_category text, p_subject text, p_body text, p_priority text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare new_id uuid;
begin
  if pulse.current_viewer() is null then raise exception 'a person is required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('hr_ticket:' || pulse.current_org()::text));
  insert into hr_ticket(org_id, no, person_id, category, subject, body, priority)
    values (pulse.current_org(), (select coalesce(max(no), 0) + 1 from hr_ticket where org_id = pulse.current_org()),
            pulse.current_viewer(), p_category, trim(p_subject), coalesce(trim(p_body), ''), coalesce(p_priority, 'normal'))
    returning id into new_id;
  return new_id;
end $$;

-- Who is away between two dates: names, dates and the kind of absence, never the reason. For the team calendar.
create function pulse.team_away(p_from date, p_to date)
  returns table (person_id uuid, from_date date, to_date date, half_day text, status text)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select l.person_id, l.from_date, l.to_date, l.half_day, l.status from leave_request l
   where l.org_id = pulse.current_org() and pulse.current_viewer() is not null
     and l.status = 'approved' and l.to_date >= p_from and l.from_date <= p_to
$$;

-- A person edits their own skills and work phone; HR and admins edit anyone's. Null leaves a field as it is.
create function pulse.profile_self_update(p_person uuid, p_skills text[], p_phone text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if pulse.current_viewer() is null or not (p_person = pulse.current_viewer() or pulse.viewer_is('admin','hr')) then
    raise exception 'not your record' using errcode = '42501';
  end if;
  update people_profile set
      skills = case when p_skills is null then skills else p_skills end,
      phone = case when p_phone is null then phone else nullif(trim(p_phone), '') end,
      locked = case when p_phone is null then locked else array(select distinct unnest(locked || 'phone'::text)) end,
      updated_at = now()
    where org_id = pulse.current_org() and person_id = p_person;
  if not found then raise exception 'no staff record' using errcode = 'P0002'; end if;
end $$;

-- ------------------------------------------------------------------------------------------------------ salary
alter table pulse.sensitive_permission drop constraint sensitive_permission_permission_check,
  add constraint sensitive_permission_permission_check
    check (permission in ('hr.salary.read','hr.salary.write','hr.contact.read','hr.contact.write','hr.documents.read')),
  add column revoked_at timestamptz,                          -- kept as a row so a sync does not hand the permission back
  add column revoked_by uuid references pulse.person(id);
create or replace function pulse.hr_can(p_permission text) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select pulse.viewer_is('admin','hr') and exists (
    select 1 from sensitive_permission
     where org_id = pulse.current_org() and person_id = pulse.current_viewer() and permission = p_permission and revoked_at is null)
$$;
do $$ begin
  execute format($f$create policy salary_writer on pulse_priv.hr_compensation as restrictive for insert to %I
    with check (pulse.hr_can('hr.salary.write'))$f$, current_user);
end $$;

-- The newest salary entry of every staff member, for the payroll screen. One access-log row per person returned.
create function pulse.hr_salary_overview()
  returns table (person_id uuid, effective_month date, kind text, amount numeric, currency text, entries int, bank_on_file boolean)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not pulse.hr_can('hr.salary.read') then raise exception 'salary access denied' using errcode = '42501'; end if;
  insert into privacy.access_log(org_id, viewer_id, subject_person_id, resource, grain, purpose)
    select pulse.current_org(), pulse.current_viewer(), x.person_id, 'hr.salary', 'person', 'hr_payroll_view'
      from (select distinct c.person_id from pulse_priv.hr_compensation c) x;
  return query
    select distinct on (c.person_id) c.person_id, c.effective_month, c.kind, c.amount, c.currency,
           (count(*) over (partition by c.person_id))::int,
           exists (select 1 from pulse_priv.hr_document d where d.person_id = c.person_id and d.doc_type = 'bank_details')
      from pulse_priv.hr_compensation c where c.kind in ('monthly','current')
     order by c.person_id, c.effective_month desc, (c.kind = 'current') desc, c.imported_at desc;
end $$;

-- When the payroll screen's figures were opened and by whom, newest first.
create function pulse.hr_payroll_log(p_limit int default 8)
  returns table (at timestamptz, viewer text, people int)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not pulse.hr_can('hr.salary.read') then raise exception 'access denied' using errcode = '42501'; end if;
  return query select l.at, p.display_name, count(*)::int from privacy.access_log l left join pulse.person p on p.id = l.viewer_id
    where l.org_id = pulse.current_org() and l.resource = 'hr.salary' and l.purpose = 'hr_payroll_view'
    group by l.at, p.display_name order by l.at desc limit least(p_limit, 50);
end $$;

-- A salary entry made in Pulse (a revision or a correction), by someone who holds the write permission.
create function pulse.hr_salary_write(p_person uuid, p_month date, p_kind text, p_amount numeric, p_note text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare new_id uuid; who text;
begin
  if not pulse.hr_can('hr.salary.write') then raise exception 'salary access denied' using errcode = '42501'; end if;
  select display_name into who from person where id = pulse.current_viewer();
  perform pulse.hr_log(p_person, 'hr.salary', 'hr_salary_edit');
  insert into pulse_priv.hr_compensation(org_id, person_id, effective_month, kind, amount, source_file_id, source_name, source_sheet, basis)
    values (pulse.current_org(), p_person, date_trunc('month', p_month)::date, p_kind, p_amount, 'pulse:' || gen_random_uuid()::text,
            'Entered in Pulse', coalesce(who, 'HR'), coalesce(nullif(trim(p_note), ''), 'Entered by hand'))
    returning id into new_id;
  return new_id;
end $$;

-- Grant or end a named permission. Only an admin who holds salary access can hand any of them out.
create function pulse.hr_permission_set(p_person uuid, p_permission text, p_grant boolean) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare who text;
begin
  if not (pulse.viewer_is('admin') and pulse.hr_can('hr.salary.read')) then
    raise exception 'only an admin with salary access can change permissions' using errcode = '42501';
  end if;
  select display_name into who from person where id = pulse.current_viewer();
  if p_grant then
    insert into sensitive_permission(org_id, person_id, permission, granted_by)
      values (pulse.current_org(), p_person, p_permission, coalesce(who, 'admin'))
      on conflict (person_id, permission) do update set granted_by = excluded.granted_by, granted_at = now(), revoked_at = null, revoked_by = null;
  else
    update sensitive_permission set revoked_at = now(), revoked_by = pulse.current_viewer()
      where org_id = pulse.current_org() and person_id = p_person and permission = p_permission and revoked_at is null;
  end if;
end $$;

revoke all on function pulse.manages(uuid), pulse.hr_defaults(), pulse.hr_ticket_open(text, text, text, text),
  pulse.team_away(date, date), pulse.profile_self_update(uuid, text[], text), pulse.hr_salary_overview(), pulse.hr_payroll_log(int),
  pulse.hr_salary_write(uuid, date, text, numeric, text), pulse.hr_permission_set(uuid, text, boolean) from public;
grant execute on function pulse.manages(uuid), pulse.hr_defaults(), pulse.hr_ticket_open(text, text, text, text),
  pulse.team_away(date, date), pulse.profile_self_update(uuid, text[], text), pulse.hr_salary_overview(), pulse.hr_payroll_log(int),
  pulse.hr_salary_write(uuid, date, text, numeric, text), pulse.hr_permission_set(uuid, text, boolean) to pulse_api;
grant execute on function pulse.manages(uuid), pulse.hr_defaults() to pulse_worker;
alter table pulse.record_change drop constraint record_change_entity_type_check,
  add constraint record_change_entity_type_check
    check (entity_type in ('person','client','contact','project','org','pod','role','hr_policy','leave_type','holiday','permission'));
-- migrate:down
