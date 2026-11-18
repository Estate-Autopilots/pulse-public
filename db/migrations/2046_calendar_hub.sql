-- migrate:up
-- CALENDAR-HUB (owner, 13 Nov 2026; OWNER-FEEDBACK-1113 P2.1): one calendar for everything, reused everywhere.
--  1. pulse.calendar_event: a person's own calendar events. They are made from a slot on the one calendar (source
--     'pulse') or read from the person's own Google Calendar (source 'google', the two-way sync). Forced row security
--     and a tenant policy: a person reads and writes only their own rows, in one company.
--  2. Google two-way (on GAP-FOUNDER-VIEW's link, 2020): pulse.calendar_link keeps Google's sync token, so each sync
--     reads only what changed in Google. pulse.calendar_pushed may also hold the person's own Pulse events (source
--     'event'). The token is read and saved only through the two functions below (the API has no grant on the link).
--  3. pulse.calendar_items() also lists the person's own timed Pulse events, so they go to Google like tasks and
--     meetings. Disconnecting removes the copies of Google's events too.
create table pulse.calendar_event (
  org_id      uuid not null references pulse.org(id),
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references pulse.person(id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 200),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  all_day     boolean not null default false,
  note        text check (length(note) <= 1000),
  place       text check (length(place) <= 300),
  source      text not null default 'pulse' check (source in ('pulse', 'google')),
  google_id   text check (google_id is null or (length(google_id) between 1 and 1024 and google_id !~ '[[:space:][:cntrl:]]')),
  google_link text check (google_link is null or (google_link ~ '^https://' and length(google_link) <= 1000)),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '31 days'),
  check (source = 'pulse' or google_id is not null)
);
create unique index calendar_event_google on pulse.calendar_event(org_id, person_id, google_id) where source = 'google';
create index calendar_event_when on pulse.calendar_event(org_id, person_id, starts_at);
alter table pulse.calendar_event enable row level security;
alter table pulse.calendar_event force row level security;
create policy tenant on pulse.calendar_event using (org_id = pulse.current_org() and person_id = pulse.current_viewer())
  with check (org_id = pulse.current_org() and person_id = pulse.current_viewer());
revoke all on table pulse.calendar_event from public;
grant select, insert, update, delete on pulse.calendar_event to pulse_api;

alter table pulse.calendar_link add column sync_token text check (sync_token is null or length(sync_token) between 1 and 2000),
  add column pulled_at timestamptz;
alter table pulse.calendar_pushed drop constraint calendar_pushed_source_check;
alter table pulse.calendar_pushed add constraint calendar_pushed_source_check check (source in ('task', 'appointment', 'event'));

-- Google's sync token for the viewer's own link (null: read the window again, as on the first sync).
create function pulse.calendar_pull_token() returns text language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  perform calendar_person();
  return (select sync_token from calendar_link where org_id = current_org() and person_id = current_viewer());
end $$;
create function pulse.calendar_pull_saved(p_token text) returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform calendar_person();
  update calendar_link set sync_token = nullif(left(p_token, 2000), ''), pulled_at = now()
    where org_id = current_org() and person_id = current_viewer();
end $$;

create or replace function pulse.calendar_disconnect() returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform calendar_person();
  delete from calendar_pushed where org_id = current_org() and person_id = current_viewer();
  delete from calendar_event where org_id = current_org() and person_id = current_viewer() and source = 'google';
  delete from calendar_link where org_id = current_org() and person_id = current_viewer();
end $$;

create or replace function pulse.calendar_items(p_days int default 60) returns jsonb
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
    union all
    -- CALENDAR-HUB: the person's own timed events made in Pulse (Google's own events are never sent back to Google).
    select jsonb_build_object('source', 'event', 'id', e.id, 'title', e.title, 'start', e.starts_at,
      'minutes', least(600, greatest(5, (extract(epoch from e.ends_at - e.starts_at) / 60)::int)), 'place', e.place, 'note', e.note, 'timeZone', tz)
      from calendar_event e
      where e.org_id = current_org() and e.person_id = me and e.source = 'pulse' and not e.all_day
        and e.ends_at >= now_ - interval '1 hour' and e.starts_at < till
    order by 1 limit 400) s);
end $$;

revoke all on function pulse.calendar_pull_token(), pulse.calendar_pull_saved(text) from public;
grant execute on function pulse.calendar_pull_token(), pulse.calendar_pull_saved(text) to pulse_api;

-- migrate:down
create or replace function pulse.calendar_items(p_days int default 60) returns jsonb
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
        and to_char(t.due_at at time zone 'Asia/Kolkata', 'HH24:MI') <> '18:00'
    union all
    select jsonb_build_object('source', 'appointment', 'id', a.id, 'title', 'Meeting: ' || coalesce(c.display_name, 'client'), 'start', a.starts_at, 'minutes', a.minutes,
      'place', a.place, 'status', a.status, 'timeZone', tz)
      from client_appointment a left join client c on c.org_id = a.org_id and c.id = a.client_id
      where a.org_id = current_org() and a.created_by = me and a.status = 'booked' and a.starts_at >= now_ - interval '1 hour' and a.starts_at < till
    order by 1 limit 400) s);
end $$;
create or replace function pulse.calendar_disconnect() returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform calendar_person();
  delete from calendar_pushed where org_id = current_org() and person_id = current_viewer();
  delete from calendar_link where org_id = current_org() and person_id = current_viewer();
end $$;
drop function if exists pulse.calendar_pull_saved(text), pulse.calendar_pull_token();
delete from pulse.calendar_pushed where source = 'event';
alter table pulse.calendar_pushed drop constraint calendar_pushed_source_check;
alter table pulse.calendar_pushed add constraint calendar_pushed_source_check check (source in ('task', 'appointment'));
alter table pulse.calendar_link drop column if exists pulled_at, drop column if exists sync_token;
drop table if exists pulse.calendar_event;
