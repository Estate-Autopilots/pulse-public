-- migrate:up
-- (Tables are named reported_bug*: an unrelated, unlanded experiment left a pulse.bug_report table on pulse-dev.)
-- BUG-REPORT (owner, 27 Oct 2026): "Report a bug" from anywhere in Pulse: Ctrl+B (⌘B) on the web and the desktop app,
-- a shake of the phone in the phone app, and "Report a bug" in the account menu and the command palette. Copied from
-- Sales X-Ray's reporter (screenshot with draw and blur, the screen, app and device, recent errors) and taken further:
-- recent failed network calls (method, path template and status only), the last app steps from telemetry (0983), an
-- optional short screen recording, and the person can remove any attachment before it goes.
--   reported_bug        one report: what the person wrote, the screen (a route template), the app and device, recent
--                     errors, failed calls and steps (scrubbed on the device and again by the API: no bodies, tokens,
--                     query values or typed text), and its triage (status, severity, assignee, duplicate of, the
--                     Pulse task made from it). Reporters read their own; leadership and admins triage (the API checks).
--                     Signed-out pages (sign-in, team setup, password reset, invitations, error pages) report too, with
--                     an optional typed name and e-mail or phone; they are marked signed_out.
--   reported_bug_file   the screenshot and the recording, kept with the report (a few hundred KB; recordings capped).
--   reported_bug_event  the append-only history of each report's triage.
-- `fingerprint` groups reports that look like one problem (the screen and the first error); a person can also mark a
-- report as a duplicate of another. pulse.reported_bug_feed() lets the host's notifier (tools/bug-report-notify.py, run as
-- the worker role) tell the owner on Telegram through ea-notify: the newest reports, numbers and a short line only.
-- Additive; uses only objects defined in this repository's migrations (pulse.org, pulse.person 0001, current_org 0001).

create table pulse.reported_bug (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  number integer not null check (number > 0),
  person_id uuid references pulse.person(id),
  command_id text not null check (command_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  words text not null check (length(btrim(words)) between 1 and 4000),
  blocks_work boolean not null default false,
  route text not null check (length(route) between 1 and 512),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  platform text not null default 'web' check (platform in ('web', 'android', 'ios', 'desktop')),
  app_version text check (length(app_version) <= 60),
  context jsonb not null default '{}' check (jsonb_typeof(context) = 'object' and length(context::text) <= 8000),
  errors jsonb not null default '[]' check (jsonb_typeof(errors) = 'array' and length(errors::text) <= 30000),
  network jsonb not null default '[]' check (jsonb_typeof(network) = 'array' and length(network::text) <= 20000),
  trail jsonb not null default '[]' check (jsonb_typeof(trail) = 'array' and length(trail::text) <= 20000),
  status text not null default 'new' check (status in ('new', 'triaged', 'fixing', 'fixed', 'wontfix')),
  severity text check (severity in ('blocker', 'high', 'medium', 'low')),
  assignee_id uuid references pulse.person(id),
  duplicate_of uuid references pulse.reported_bug(id),
  task_id uuid,
  -- Signed out (the sign-in, team setup, password, invitation and error pages): what the person chose to type to hear back.
  signed_out boolean not null default false,
  reporter_name text check (length(reporter_name) <= 120),
  reporter_contact text check (length(reporter_contact) <= 200),
  status_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, number),
  unique (org_id, person_id, command_id),
  check (duplicate_of is null or duplicate_of <> id),
  check (signed_out = (person_id is null))
);
create index reported_bug_recent on pulse.reported_bug (org_id, created_at desc);
create index reported_bug_person on pulse.reported_bug (org_id, person_id, created_at desc);
create index reported_bug_fingerprint on pulse.reported_bug (org_id, fingerprint);
create index reported_bug_feed on pulse.reported_bug (created_at);

create table pulse.reported_bug_file (
  report_id uuid not null references pulse.reported_bug(id) on delete cascade,
  org_id uuid not null references pulse.org(id),
  kind text not null check (kind in ('screenshot', 'recording')),
  content_type text not null check (content_type in ('image/png', 'image/jpeg', 'image/webp', 'video/webm', 'video/mp4')),
  bytes integer not null check (bytes between 1 and 8388608),
  seconds integer check (seconds between 1 and 120),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  data bytea not null,
  created_at timestamptz not null default now(),
  primary key (report_id, kind),
  check ((kind = 'screenshot') = (content_type like 'image/%'))
);

create table pulse.reported_bug_event (
  id bigint generated always as identity primary key,
  org_id uuid not null references pulse.org(id),
  report_id uuid not null references pulse.reported_bug(id) on delete cascade,
  kind text not null check (kind in ('status', 'severity', 'assignee', 'duplicate', 'task', 'note')),
  value text check (length(value) <= 200),
  note text check (length(note) <= 2000),
  actor_id uuid references pulse.person(id),
  at timestamptz not null default now()
);
create index reported_bug_event_report on pulse.reported_bug_event (report_id, at);

do $$ declare t text; begin
  foreach t in array array['reported_bug', 'reported_bug_file', 'reported_bug_event'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  end loop;
end $$;
grant select, insert, update on pulse.reported_bug to pulse_api;
grant select, insert on pulse.reported_bug_file to pulse_api;
grant select, insert on pulse.reported_bug_event to pulse_api;
grant usage on sequence pulse.reported_bug_event_id_seq to pulse_api;

/** The newest reports across every organisation, for the owner's Telegram note (tools/bug-report-notify.py): the
 *  organisation's name, the number, a short line, the screen, severity and who sent it. Never the screenshot, errors,
 *  calls or steps. */
create function pulse.reported_bug_feed(p_after timestamptz, p_limit integer default 20)
returns table (id uuid, org_name text, number integer, words text, route text, blocks_work boolean, severity text,
  platform text, reporter text, signed_out boolean, created_at timestamptz)
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record;
begin
  -- Row-level security is forced on the reports, so each organisation is read as itself (as telemetry_maintain does).
  for o in select g.id, g.name from pulse.org g loop
    perform set_config('pulse.org_id', o.id::text, true);
    return query
      select b.id, o.name, b.number, left(regexp_replace(b.words, '\s+', ' ', 'g'), 200), b.route, b.blocks_work, b.severity,
        b.platform, coalesce(p.display_name, b.reporter_name), b.signed_out, b.created_at
      from pulse.reported_bug b left join pulse.person p on p.id = b.person_id
      where b.org_id = o.id and b.created_at > p_after
      order by b.created_at
      limit least(greatest(coalesce(p_limit, 20), 1), 100);
  end loop;
  perform set_config('pulse.org_id', '', true);
end
$$;
revoke execute on function pulse.reported_bug_feed(timestamptz, integer) from public;
grant execute on function pulse.reported_bug_feed(timestamptz, integer) to pulse_worker;

-- migrate:down
-- Forward-only.
