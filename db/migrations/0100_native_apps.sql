-- migrate:up
-- Device declarations and person-only sensor evidence; no raw URL, title, key or GPS fields.
create table pulse.native_device (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(), person_id uuid not null references pulse.person(id),
 name text not null check(length(name) between 1 and 80), platform text not null check(platform in ('ios','android','windows','macos','chrome')),
 purposes text[] not null default '{}', push_token text, revoked_at timestamptz, created_at timestamptz not null default now()
);
create table pulse.native_policy (
 org_id uuid primary key references pulse.org(id), domains text[] not null default '{}', resources jsonb not null default '[]',
 shoots jsonb not null default '[]', updated_at timestamptz not null default now()
);
create table pulse.native_event (
 org_id uuid not null references pulse.org(id), id uuid primary key, person_id uuid not null references pulse.person(id),
 device_id uuid not null references pulse.native_device(id), purpose text not null, kind text not null,
 project_id uuid references pulse.project(id), at timestamptz not null, data jsonb not null, received_at timestamptz not null default now()
);
create table pulse.native_log (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),
 device_id uuid not null references pulse.native_device(id),purpose text not null default 'declarations' check(purpose='declarations'), project_id uuid references pulse.project(id), day date not null, minutes integer not null check(minutes between 0 and 1440),
 note text not null check(length(note) between 1 and 1000), revision integer not null default 1, updated_at timestamptz not null default now()
);
create table pulse.native_log_revision (
 org_id uuid not null references pulse.org(id),log_id uuid not null references pulse.native_log(id),revision integer not null,
 minutes integer not null,note text not null,at timestamptz not null default now(),primary key(log_id,revision)
);
do $$ declare t text; begin foreach t in array array['native_device','native_event','native_log'] loop
 execute format('alter table pulse.%I enable row level security',t);execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('create policy own on pulse.%I as restrictive to pulse_api using(person_id=pulse.current_viewer()) with check(person_id=pulse.current_viewer())',t);
 execute format('grant select,insert,update,delete on pulse.%I to pulse_api',t);
 execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;end $$;
alter table pulse.native_policy enable row level security;alter table pulse.native_policy force row level security;
create policy tenant on pulse.native_policy using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update on pulse.native_policy to pulse_api;
alter table pulse.native_log_revision enable row level security;alter table pulse.native_log_revision force row level security;
create policy tenant on pulse.native_log_revision using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy own on pulse.native_log_revision as restrictive to pulse_api using(exists(select 1 from pulse.native_log l where l.id=log_id and l.person_id=pulse.current_viewer()));
grant select,insert on pulse.native_log_revision to pulse_api;
create index on pulse.native_event(org_id,person_id,at desc);
-- Limited aggregate only: sensor payloads stay person-only even for admins and managers.
create function pulse.native_counts(who uuid) returns jsonb language sql security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('events',count(*),'exports',count(*) filter(where kind='render'),'workLogs',(select count(*) from native_log l where l.org_id=current_org() and l.person_id=who))
 from native_event e where e.org_id=current_org() and e.person_id=who and e.at>=now()-interval '84 days'
 and (who=current_viewer() or manages(who) or viewer_is('admin','leadership'))
$$;
revoke all on function pulse.native_counts(uuid) from public;grant execute on function pulse.native_counts(uuid) to pulse_api;
-- Direct APNs/FCM outbox; the provider receives only a generic work alert.
create table pulse.native_push_delivery (
 org_id uuid not null references pulse.org(id),notification_id uuid not null references pulse.notification(id),device_id uuid not null references pulse.native_device(id),
 attempts integer not null default 0,sent_at timestamptz,last_attempt_at timestamptz,primary key(notification_id,device_id)
);
alter table pulse.native_push_delivery enable row level security;alter table pulse.native_push_delivery force row level security;
create policy tenant on pulse.native_push_delivery using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update on pulse.native_push_delivery to pulse_worker;
grant select,update on pulse.native_device to pulse_worker;
-- migrate:down
