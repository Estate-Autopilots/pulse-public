-- migrate:up
-- Receipts and briefs are personal projections, never an organisation-wide narrative cache.
create table pulse.insight_receipt (
 org_id uuid not null references pulse.org(id), id text primary key,
 viewer_id uuid not null references pulse.person(id), cause_key text not null, surface text not null,
 packet jsonb not null, lifecycle text not null default 'active' check(lifecycle in ('active','superseded','retired')),
 supersedes_id text references pulse.insight_receipt(id), created_at timestamptz not null default now(), retired_at timestamptz
);
create unique index insight_current on pulse.insight_receipt(org_id,viewer_id,cause_key) where lifecycle='active';
create index insight_viewer on pulse.insight_receipt(org_id,viewer_id,surface);
create table pulse.insight_decision (
 org_id uuid not null references pulse.org(id), viewer_id uuid not null references pulse.person(id),
 receipt_id text not null references pulse.insight_receipt(id), action text not null check(action in ('dismiss','snooze','complete','useful','irrelevant','false')),
 reason text not null check(length(reason) between 3 and 500), until_at timestamptz, at timestamptz not null default now(),
 primary key(org_id,viewer_id,receipt_id,action)
);
create table pulse.brief_preference (
 org_id uuid not null references pulse.org(id), viewer_id uuid primary key references pulse.person(id),
 subscribed boolean not null default true, timezone text not null default 'Asia/Kolkata',
 daily_time time, weekly_day int not null default 1 check(weekly_day between 1 and 7),
 quiet_start time not null default '22:00', quiet_end time not null default '07:00', updated_at timestamptz not null default now()
);
create table pulse.role_brief (
 org_id uuid not null references pulse.org(id), id text primary key, viewer_id uuid not null references pulse.person(id),
 kind text not null check(kind in ('daily','weekly')), work_date date not null, version text not null,
 authority text not null, packet jsonb not null, created_at timestamptz not null default now(),
 unique(org_id,viewer_id,kind,work_date,version)
);
alter table pulse.task add column review_due_at timestamptz, add column review_owner_id uuid references pulse.person(id),
 add column review_calendar text not null default 'Asia/Kolkata', add column review_work_days int[] not null default '{1,2,3,4,5,6}';
-- A review deadline is an explicit agreement, not a parse of an ambiguous imported label.
grant update(review_due_at,review_owner_id,review_calendar,review_work_days) on pulse.task to pulse_api;
do $$ declare t text; begin
 foreach t in array array['insight_receipt','insight_decision','brief_preference','role_brief'] loop
 execute format('alter table pulse.%I enable row level security',t);
 execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('create policy own_projection on pulse.%I as restrictive using(viewer_id=pulse.current_viewer()) with check(viewer_id=pulse.current_viewer())',t);
 execute format('grant select,insert on pulse.%I to pulse_api',t);
 end loop;
end $$;
grant update(lifecycle,retired_at) on pulse.insight_receipt to pulse_api;
grant update on pulse.brief_preference to pulse_api;
-- Frozen brief snapshots are append-only; a retry cannot rewrite their vintage.
-- migrate:down
