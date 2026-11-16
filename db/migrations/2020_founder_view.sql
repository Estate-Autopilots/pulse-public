-- migrate:up
-- GAP-FOUNDER-VIEW (9 Nov 2026; MASTER-BACKLOG PW-06, PM-07, PM-08). Three things for a person who runs several companies:
--
--  1. Founder view ("All my companies", in their own personal workspace): one card per company where the person is an
--     admin. pulse.founder_today() is SECURITY INVOKER, like pulse.my_day_seat (1460): the API calls it once per seat,
--     in that seat's own READ ONLY transaction, inside that organisation and as the account's person there, so that
--     organisation's row security decides every row. Nothing here reads two organisations in one query. It returns
--     null for anyone who is not an admin of the organisation it runs in.
--     Today's money (billing readers only, through money_at_risk and finance_invoice_due, 1853/1480), open client
--     issues, tasks overdue, people in today, AI employees working or stuck, and the one next thing.
--  2. Designations across companies: a person's role in each company is their seat's people_profile.role (the job
--     title each company already keeps; IDENTITY-UNIFY's one account, many seats). pulse.founder_people() lists, for
--     an admin, the people of this organisation with their @handle and role here, so the API can say "Head of sales
--     here, adviser at Kite Studio" for people who hold seats in two of the founder's companies (matched by handle in
--     the API, each organisation read on its own). pulse.account_roles() gives the signed-in person their own current
--     roles in every company, for their profile, from account_career_of (1683, the public variant: role and company).
--  3. Google Calendar (switched off until the Google client exists, owner step ML-02): a person connects their own
--     calendar for one organisation; their tasks with a due time and that organisation's client appointments are pushed
--     to it. pulse.calendar_link holds the sealed refresh token (document keyring; never returned), pulse.calendar_pushed
--     remembers which Pulse item became which Google event, and pulse_priv.calendar_attempt is the one-use OAuth state.
--     Each table has forced row security and a tenant policy, and a person reads and writes only their own rows.

-- ------------------------------------------------------------------------------------------------ 1. founder view
-- What falls due in the next seven days (unpaid, after credit notes and receipts): for billing readers only, like
-- money_at_risk; null for anyone else. This organisation only.
create function pulse.founder_due_week() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare today date := (now() at time zone org_time_zone())::date; out jsonb;
begin
  if current_viewer() is null or not erp_can(false) then return null; end if;
  select jsonb_build_object('count', count(*), 'amount', coalesce(sum(u.base_due + u.gst_due), 0)) into out
    from finance_invoice_due() u join erp_document d on d.id = u.document_id
    where d.org_id = current_org() and u.base_due + u.gst_due > 0 and d.due_date between today and today + 6;
  return out;
end $$;

-- Client issues still open, for an admin of this organisation: a client's request whose task is not finished (or has
-- none yet, from the last 14 days), and blocks still open on a client's project. This organisation only.
create function pulse.founder_client_issues() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare org uuid := current_org(); tz text := org_time_zone(); today date := (now() at time zone org_time_zone())::date; out jsonb;
begin
  if current_viewer() is null or not viewer_is('admin') then return null; end if;
  with r as (
    select r.id, r.title, c.display_name client, r.client_id, r.task_id, null::uuid project_id, r.created_at at_
      from client_request r left join client c on c.org_id = r.org_id and c.id = r.client_id left join task t on t.org_id = r.org_id and t.id = r.task_id
      where r.org_id = org and ((r.task_id is null and r.created_at >= now() - interval '14 days')
         or (t.id is not null and t.deleted_at is null and t.status in ('open', 'in_progress', 'blocked', 'unknown')))
    union all
    select b.id, coalesce(t.title, b.blocker_key), c.display_name, p.client_id, b.task_id, b.project_id, b.opened_at
      from blocker b join project p on p.org_id = b.org_id and p.id = b.project_id and p.client_id is not null and p.deleted_at is null
        left join client c on c.org_id = p.org_id and c.id = p.client_id left join task t on t.org_id = b.org_id and t.id = b.task_id
      where b.org_id = org and b.closed_at is null)
  select jsonb_build_object('count', count(*),
      'top', (select jsonb_build_object('id', x.id, 'title', x.title, 'client', x.client, 'clientId', x.client_id, 'taskId', x.task_id, 'projectId', x.project_id,
        'days', today - (x.at_ at time zone tz)::date) from r x order by x.at_ asc limit 1))
    into out from r;
  return out;
end $$;

create function pulse.founder_today() returns jsonb
  language plpgsql stable set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); tz text := org_time_zone(); today date := (now() at time zone org_time_zone())::date;
  day_start timestamptz; title text; risk jsonb; due jsonb; money jsonb; issues jsonb; late jsonb; people jsonb; ai jsonb; nxt jsonb;
begin
  if me is null or not viewer_is('admin') then return null; end if;
  day_start := today::timestamp at time zone tz;
  select nullif(btrim(pp.role), '') into title from people_profile pp where pp.person_id = me;

  -- Money: what is late, not billed or waiting (money_at_risk), and what falls due in the next seven days.
  risk := money_at_risk();
  if risk is not null then
    due := coalesce(founder_due_week(), jsonb_build_object('count', 0, 'amount', 0));
    money := jsonb_build_object('dueWeek', due,
      'late', (risk -> 'overdue') - 'items', 'unbilled', (risk -> 'unbilled') - 'items', 'waiting', (risk -> 'stalled') - 'items',
      'atRisk', coalesce((risk #>> '{overdue,amount}')::bigint, 0) + coalesce((risk #>> '{unbilled,amount}')::bigint, 0) + coalesce((risk #>> '{stalled,amount}')::bigint, 0),
      'topLate', risk #> '{overdue,items,0}', 'topUnbilled', risk #> '{unbilled,items,0}');
  end if;

  -- Client issues still open (founder_client_issues: client requests are read through a function, as cs_alerts_today).
  issues := founder_client_issues();

  -- Work past its due time, anyone's (an admin sees the organisation's work).
  with t as (
    select t.id, t.title, t.priority, t.due_at, a.display_name who from task t left join person a on a.id = coalesce(t.assignee_person_id, t.owner_id)
      where t.deleted_at is null and t.status in ('open', 'in_progress', 'blocked', 'unknown') and t.due_at < now())
  select jsonb_build_object('count', count(*),
      'top', (select jsonb_build_object('id', x.id, 'title', x.title, 'who', x.who, 'days', greatest(today - (x.due_at at time zone tz)::date, 0))
        from t x order by (x.priority in ('urgent', 'high')) desc, x.due_at asc limit 1))
    into late from t;

  -- People: staff who checked in today, out of everyone on the team (AI employees are counted apart).
  with s as (
    select p.id from person p where p.status = 'active' and p.side = 'staff' and not exists (select 1 from agent_member m where m.person_id = p.id))
  select jsonb_build_object('total', (select count(*) from s),
      'in', (select count(*) from s where exists (select 1 from attendance_effective e where e.person_id = s.id and e.work_date = today)),
      'away', (select count(*) from s where exists (select 1 from leave_request l where l.person_id = s.id and l.status = 'approved' and today between l.from_date and l.to_date)))
    into people;

  -- AI employees: switched on; working = a run going now or a task in progress; stuck = paused, a blocked task, or a run
  -- that failed today.
  with m as (
    select m.person_id id, p.display_name name, m.paused_reason,
      exists (select 1 from agent_run r where r.agent_id = m.person_id and r.state = 'dispatching') running,
      exists (select 1 from task t where t.assignee_person_id = m.person_id and t.deleted_at is null and t.status = 'in_progress') busy,
      (select t.title from task t where t.assignee_person_id = m.person_id and t.deleted_at is null and t.status = 'blocked' order by t.updated_at desc limit 1) blocked_on,
      exists (select 1 from agent_event e where e.agent_id = m.person_id and e.state = 'failed' and e.finished_at >= day_start
        and e.reason in ('stuck', 'model_error', 'gave_up', 'budget_spent', 'no_answer')) failed
    from agent_member m join person p on p.id = m.person_id where m.disabled_at is null),
  k as (select *, (paused_reason is not null or blocked_on is not null or failed) stuck from m)
  select jsonb_build_object('total', count(*), 'working', count(*) filter (where not stuck and (running or busy)), 'stuck', count(*) filter (where stuck),
      'top', (select jsonb_build_object('id', x.id, 'name', x.name, 'why', case when x.paused_reason is not null then 'paused' when x.blocked_on is not null then 'blocked' else 'failed' end,
        'task', x.blocked_on) from k x where x.stuck order by x.name limit 1))
    into ai from k;

  -- The one next thing: the biggest late bill, else a stuck AI employee, else the oldest client issue, else the most
  -- urgent late task, else work done but not billed.
  nxt := case
    when money ? 'topLate' and money -> 'topLate' <> 'null'::jsonb then jsonb_build_object('kind', 'late_bill') || (money -> 'topLate')
    when (ai ->> 'stuck')::int > 0 then jsonb_build_object('kind', 'ai_stuck') || (ai -> 'top')
    when (issues ->> 'count')::int > 0 then jsonb_build_object('kind', 'client_issue') || (issues -> 'top')
    when (late ->> 'count')::int > 0 then jsonb_build_object('kind', 'late_task') || (late -> 'top')
    when money ? 'topUnbilled' and money -> 'topUnbilled' <> 'null'::jsonb then jsonb_build_object('kind', 'unbilled') || (money -> 'topUnbilled')
  end;

  return jsonb_build_object('today', today, 'kind', org_kind(), 'role', title,
    'access', case when coalesce(title, '') ~* '^(owner|founder|co-founder)' then 'owner' else 'admin' end,
    'money', money, 'clientIssues', issues, 'tasksLate', late, 'people', people, 'ai', ai, 'next', nxt);
end $$;

-- The people of this organisation (not AI employees, not the viewer) with their Pulse @handle and their role here. For
-- an admin of this organisation only; it reads this organisation alone.
create function pulse.founder_people() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or agent_session() is not null or not viewer_is('admin') then return null; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('handle', x.handle, 'id', x.id, 'name', x.name, 'role', x.role, 'kind', x.kind) order by x.name), '[]'::jsonb)
    from (select a.handle, p.id, p.display_name name, nullif(btrim(pp.role), '') role, am.kind
      from pulse_priv.account_member am join pulse_priv.pulse_account a on a.id = am.account_id
        join person p on p.id = am.person_id and p.org_id = current_org() and p.status = 'active'
        left join people_profile pp on pp.person_id = p.id
      where am.member_org = current_org() and p.id <> current_viewer() and a.handle is not null
        and not exists (select 1 from agent_member m where m.person_id = p.id)
      order by p.display_name limit 500) x);
end $$;

-- The signed-in person's own current roles in every company (their career's public part), personal workspaces left out.
create function pulse.account_roles() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); c jsonb; personal uuid[];
begin
  if current_viewer() is null or v is null then return '[]'::jsonb; end if;
  c := account_career_of(v, true);
  select coalesce(array_agg(g.id), '{}') into personal from org g where g.personal_account = v;
  return (select coalesce(jsonb_agg(jsonb_build_object('org', x ->> 'org', 'company', x ->> 'company', 'role', x ->> 'role', 'kind', x ->> 'kind')), '[]'::jsonb)
    from jsonb_array_elements(c) x where (x ->> 'current')::boolean and not ((x ->> 'org')::uuid = any(personal)));
end $$;

revoke all on function pulse.founder_due_week(), pulse.founder_client_issues(), pulse.founder_today(), pulse.founder_people(), pulse.account_roles() from public;
grant execute on function pulse.founder_due_week(), pulse.founder_client_issues(), pulse.founder_today(), pulse.founder_people(), pulse.account_roles() to pulse_api;

-- ------------------------------------------------------------------------------------------------ 3. Google Calendar
create table pulse.calendar_link (
  org_id        uuid not null references pulse.org(id),
  person_id     uuid not null references pulse.person(id) on delete cascade,
  provider      text not null default 'google' check (provider = 'google'),
  address       text not null check (length(address) between 3 and 254 and address !~ '[[:space:][:cntrl:]]'),
  calendar_id   text not null default 'primary' check (length(calendar_id) between 1 and 200),
  key_id        text not null check (length(key_id) between 1 and 200),
  token_wrapped bytea not null check (length(token_wrapped) between 1 and 4000),
  token_sealed  bytea not null check (length(token_sealed) between 1 and 8000),
  push_tasks    boolean not null default true,
  push_meetings boolean not null default true,
  status        text not null default 'connected' check (status in ('connected', 'error')),
  last_error    text check (length(last_error) <= 300),
  connected_at  timestamptz not null default now(),
  synced_at     timestamptz,
  primary key (org_id, person_id)
);
create table pulse.calendar_pushed (
  org_id        uuid not null references pulse.org(id),
  person_id     uuid not null references pulse.person(id) on delete cascade,
  source        text not null check (source in ('task', 'appointment')),
  source_id     uuid not null,
  event_id      text not null check (event_id ~ '^[a-v0-9]+$' and length(event_id) between 5 and 1024),
  fingerprint   text not null check (fingerprint ~ '^[a-f0-9]{64}$'),
  pushed_at     timestamptz not null default now(),
  primary key (org_id, person_id, source, source_id)
);
create table pulse_priv.calendar_attempt (
  state_hash    text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  org_id        uuid not null references pulse.org(id),
  person_id     uuid not null references pulse.person(id) on delete cascade,
  session_hash  text not null check (session_hash ~ '^[a-f0-9]{64}$'),
  verifier      text not null check (length(verifier) between 43 and 128),
  created_at    timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
  foreach t in array array['calendar_link', 'calendar_pushed'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant on pulse.%I using (org_id = pulse.current_org() and person_id = pulse.current_viewer()) with check (org_id = pulse.current_org() and person_id = pulse.current_viewer())', t);
    execute format('revoke all on table pulse.%I from public', t);
  end loop;
end $$;
alter table pulse_priv.calendar_attempt enable row level security;
alter table pulse_priv.calendar_attempt force row level security;
create policy tenant on pulse_priv.calendar_attempt using (org_id = pulse.current_org() and person_id = pulse.current_viewer())
  with check (org_id = pulse.current_org() and person_id = pulse.current_viewer());
revoke all on table pulse_priv.calendar_attempt from public;
-- The link is read and written only through the functions below (the token never leaves calendar_sealed()); the API
-- keeps the pushed list itself, under row security (the person's own rows).
grant select, insert, update, delete on pulse.calendar_pushed to pulse_api;

-- Only a person signed in as themselves (never an AI employee's session).
create function pulse.calendar_person() returns void language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or agent_session() is not null then
    raise exception 'Sign in as yourself to connect your calendar' using errcode = '42501'; end if;
end $$;

create function pulse.calendar_state() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  perform calendar_person();
  return (select to_jsonb(x) from (select address, calendar_id "calendarId", push_tasks "pushTasks", push_meetings "pushMeetings", status,
      last_error "lastError", connected_at "connectedAt", synced_at "syncedAt",
      (select count(*) from calendar_pushed p where p.org_id = l.org_id and p.person_id = l.person_id)::int pushed
    from calendar_link l where l.org_id = current_org() and l.person_id = current_viewer()) x);
end $$;

create function pulse.calendar_begin(p_state text, p_session text, p_verifier text) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform calendar_person();
  delete from pulse_priv.calendar_attempt where org_id = current_org() and (person_id = current_viewer() or created_at < clock_timestamp() - interval '10 minutes');
  insert into pulse_priv.calendar_attempt(state_hash, org_id, person_id, session_hash, verifier) values (p_state, current_org(), current_viewer(), p_session, p_verifier);
end $$;

-- The callback: the attempt is used up before the code is exchanged, so a replayed state finds nothing. Only the person
-- who started it, in the same session, within ten minutes.
create function pulse.calendar_take(p_state text, p_session text) returns text language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v text;
begin
  perform calendar_person();
  delete from pulse_priv.calendar_attempt where org_id = current_org() and state_hash = p_state returning
    case when person_id = current_viewer() and session_hash = p_session and created_at > clock_timestamp() - interval '10 minutes' then verifier end into v;
  return v;
end $$;

create function pulse.calendar_save(p_address text, p_key text, p_wrapped bytea, p_sealed bytea) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform calendar_person();
  insert into calendar_link(org_id, person_id, address, key_id, token_wrapped, token_sealed)
    values (current_org(), current_viewer(), lower(btrim(p_address)), p_key, p_wrapped, p_sealed)
  on conflict (org_id, person_id) do update set address = excluded.address, key_id = excluded.key_id, token_wrapped = excluded.token_wrapped,
    token_sealed = excluded.token_sealed, status = 'connected', last_error = null, connected_at = now();
end $$;

create function pulse.calendar_sealed() returns table(address text, calendar_id text, key_id text, token_wrapped bytea, token_sealed bytea, push_tasks boolean, push_meetings boolean)
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  perform calendar_person();
  return query select l.address, l.calendar_id, l.key_id, l.token_wrapped, l.token_sealed, l.push_tasks, l.push_meetings
    from calendar_link l where l.org_id = current_org() and l.person_id = current_viewer();
end $$;

create function pulse.calendar_set(p_tasks boolean, p_meetings boolean) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform calendar_person();
  update calendar_link set push_tasks = coalesce(p_tasks, push_tasks), push_meetings = coalesce(p_meetings, push_meetings)
    where org_id = current_org() and person_id = current_viewer();
  if not found then raise exception 'Connect your calendar first' using errcode = 'P0002'; end if;
end $$;

create function pulse.calendar_report(p_ok boolean, p_error text default null) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform calendar_person();
  update calendar_link set status = case when p_ok then 'connected' else 'error' end, last_error = case when p_ok then null else left(p_error, 300) end,
    synced_at = case when p_ok then now() else synced_at end
    where org_id = current_org() and person_id = current_viewer();
end $$;

create function pulse.calendar_disconnect() returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform calendar_person();
  delete from calendar_pushed where org_id = current_org() and person_id = current_viewer();
  delete from calendar_link where org_id = current_org() and person_id = current_viewer();
end $$;

-- What goes on the calendar: the person's own open tasks with a due time (a due date alone stays off it) and this
-- organisation's client appointments they booked, from today to 60 days ahead. Only the viewer's own items, in this
-- organisation (a definer: client appointments are read through functions).
create function pulse.calendar_items(p_days int default 60) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); tz text := org_time_zone(); now_ timestamptz := now(); till timestamptz;
begin
  if me is null then return '[]'::jsonb; end if;
  till := now_ + make_interval(days => least(greatest(coalesce(p_days, 60), 1), 120));
  return (select coalesce(jsonb_agg(x order by x ->> 'start'), '[]'::jsonb) from (
    select jsonb_build_object('source', 'task', 'id', t.id, 'title', t.title, 'start', t.due_at, 'minutes', coalesce(nullif(t.estimate_minutes, 0), 30),
      'status', t.status, 'project', coalesce(pr.title, pr.name), 'timeZone', tz) x
      from task t left join project pr on pr.org_id = t.org_id and pr.id = t.project_id
      where t.org_id = current_org() and coalesce(t.assignee_person_id, t.owner_id) = me and t.deleted_at is null and t.status in ('open', 'in_progress', 'blocked', 'unknown')
        and t.due_at >= date_trunc('day', now_ at time zone tz) at time zone tz and t.due_at < till
        -- A due date alone is kept as 18:00 India time (task_due_from, 0141): only a real due time goes on the calendar.
        and to_char(t.due_at at time zone 'Asia/Kolkata', 'HH24:MI') <> '18:00'
    union all
    select jsonb_build_object('source', 'appointment', 'id', a.id, 'title', 'Meeting: ' || coalesce(c.display_name, 'client'), 'start', a.starts_at, 'minutes', a.minutes,
      'place', a.place, 'status', a.status, 'timeZone', tz)
      from client_appointment a left join client c on c.org_id = a.org_id and c.id = a.client_id
      where a.org_id = current_org() and a.created_by = me and a.status = 'booked' and a.starts_at >= now_ - interval '1 hour' and a.starts_at < till
    order by 1 limit 400) s);
end $$;

revoke all on function pulse.calendar_person(), pulse.calendar_state(), pulse.calendar_begin(text, text, text), pulse.calendar_take(text, text),
  pulse.calendar_save(text, text, bytea, bytea), pulse.calendar_sealed(), pulse.calendar_set(boolean, boolean), pulse.calendar_report(boolean, text),
  pulse.calendar_disconnect(), pulse.calendar_items(int) from public;
grant execute on function pulse.calendar_state(), pulse.calendar_begin(text, text, text), pulse.calendar_take(text, text),
  pulse.calendar_save(text, text, bytea, bytea), pulse.calendar_sealed(), pulse.calendar_set(boolean, boolean), pulse.calendar_report(boolean, text),
  pulse.calendar_disconnect(), pulse.calendar_items(int) to pulse_api;

-- migrate:down
drop function if exists pulse.calendar_items(int), pulse.calendar_disconnect(), pulse.calendar_report(boolean, text), pulse.calendar_set(boolean, boolean),
  pulse.calendar_sealed(), pulse.calendar_save(text, text, bytea, bytea), pulse.calendar_take(text, text), pulse.calendar_begin(text, text, text),
  pulse.calendar_state(), pulse.calendar_person();
drop table if exists pulse_priv.calendar_attempt, pulse.calendar_pushed, pulse.calendar_link;
drop function if exists pulse.account_roles(), pulse.founder_people(), pulse.founder_today(), pulse.founder_client_issues(), pulse.founder_due_week();
