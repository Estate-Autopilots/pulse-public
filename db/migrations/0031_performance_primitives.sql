-- migrate:up
-- Common source identity makes connector replay idempotent. Unknown actors are never assigned personal credit.
create table pulse.work_unit (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid references pulse.person(id),project_id uuid references pulse.project(id),
 kind text not null check(kind in ('task','creative','campaign','code','other')),status text not null check(status in ('unknown','open','in_progress','blocked','done')),
 source_kind text not null check(source_kind in ('pulse','desktop','editing','office')),source_ref text not null,observed_at timestamptz not null,unique(org_id,source_kind,source_ref)
);
create table pulse.work_event (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid references pulse.person(id),work_unit_id uuid references pulse.work_unit(id),project_id uuid references pulse.project(id),
 kind text not null check(kind in ('created','started','completed','uploaded','exported','revised')),source_kind text not null check(source_kind in ('pulse','desktop','editing','office')),
 source_ref text not null,observed_at timestamptz not null,confidence numeric not null check(confidence between 0 and 1),unique(org_id,source_kind,source_ref)
);
create table pulse.quality_signal (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid references pulse.person(id),work_unit_id uuid references pulse.work_unit(id),
 kind text not null check(kind in ('approval','revision','defect')),value numeric not null check(value>=0),source_kind text not null check(source_kind in ('pulse','desktop','editing','office')),
 source_ref text not null,observed_at timestamptz not null,confidence numeric not null check(confidence between 0 and 1),unique(org_id,source_kind,source_ref)
);
create table pulse.outcome_signal (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid references pulse.person(id),work_unit_id uuid references pulse.work_unit(id),project_id uuid references pulse.project(id),
 kind text not null check(kind in ('client_approval','lead_count','release')),value numeric not null check(value>=0),source_kind text not null check(source_kind in ('pulse','desktop','editing','office')),
 source_ref text not null,observed_at timestamptz not null,confidence numeric not null check(confidence between 0 and 1),unique(org_id,source_kind,source_ref)
);
create table pulse.attendance_signal (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid references pulse.person(id),
 kind text not null check(kind in ('arrived','departed','presence_corroboration')),source_kind text not null check(source_kind in ('pulse','desktop','editing','office')),
 source_ref text not null,observed_at timestamptz not null,confidence numeric not null check(confidence between 0 and 1),unique(org_id,source_kind,source_ref)
);
do $$declare t text;begin foreach t in array array['work_unit','work_event','quality_signal','outcome_signal','attendance_signal'] loop
 execute format('alter table pulse.%I enable row level security',t);execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('create policy scope on pulse.%I as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.manages(person_id) or pulse.viewer_is(''admin'',''leadership''))',t);
 execute format('grant select on pulse.%I to pulse_api',t);execute format('grant select,insert,update,delete on pulse.%I to pulse_worker',t);
 execute format('create index on pulse.%I(org_id,person_id,observed_at desc)',t);
 execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;end $$;
create function pulse.performance_submit(p_primitive text,p_person uuid,p_project uuid,p_unit uuid,p_kind text,p_value numeric,p_status text,p_source text,p_ref text,p_at timestamptz,p_confidence numeric) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'connector intake requires an individual admin' using errcode='42501';end if;
 if p_person is not null and not exists(select 1 from person where id=p_person and side='staff' and org_id=current_org()) then raise exception 'employee required' using errcode='22023';end if;
 if p_project is not null and not exists(select 1 from project where id=p_project) then raise exception 'project required' using errcode='22023';end if;
 if p_unit is not null and not exists(select 1 from work_unit where id=p_unit) then raise exception 'work unit required' using errcode='22023';end if;
 if p_at>now()+interval '5 minutes' or p_ref!~'^[A-Za-z0-9:_-]{1,160}$' or p_source not in ('pulse','desktop','editing','office') or p_confidence not between 0 and 1 then raise exception 'invalid event' using errcode='22023';end if;
 if p_primitive='work_unit' then
  insert into work_unit(org_id,person_id,project_id,kind,status,source_kind,source_ref,observed_at) values(current_org(),p_person,p_project,p_kind,p_status,p_source,p_ref,p_at) on conflict(org_id,source_kind,source_ref) do nothing returning id into nid;
 elsif p_primitive='work_event' then
  insert into work_event(org_id,person_id,project_id,work_unit_id,kind,source_kind,source_ref,observed_at,confidence) values(current_org(),p_person,p_project,p_unit,p_kind,p_source,p_ref,p_at,p_confidence) on conflict(org_id,source_kind,source_ref) do nothing returning id into nid;
 elsif p_primitive='quality_signal' then
  insert into quality_signal(org_id,person_id,work_unit_id,kind,value,source_kind,source_ref,observed_at,confidence) values(current_org(),p_person,p_unit,p_kind,p_value,p_source,p_ref,p_at,p_confidence) on conflict(org_id,source_kind,source_ref) do nothing returning id into nid;
 elsif p_primitive='outcome_signal' then
  insert into outcome_signal(org_id,person_id,project_id,work_unit_id,kind,value,source_kind,source_ref,observed_at,confidence) values(current_org(),p_person,p_project,p_unit,p_kind,p_value,p_source,p_ref,p_at,p_confidence) on conflict(org_id,source_kind,source_ref) do nothing returning id into nid;
 elsif p_primitive='attendance' then
  insert into attendance_signal(org_id,person_id,kind,source_kind,source_ref,observed_at,confidence) values(current_org(),p_person,p_kind,p_source,p_ref,p_at,p_confidence) on conflict(org_id,source_kind,source_ref) do nothing returning id into nid;
 else raise exception 'invalid primitive' using errcode='22023';end if;
 return nid;
end $$;
revoke all on function pulse.performance_submit(text,uuid,uuid,uuid,text,numeric,text,text,text,timestamptz,numeric) from public;
grant execute on function pulse.performance_submit(text,uuid,uuid,uuid,text,numeric,text,text,text,timestamptz,numeric) to pulse_api;
-- migrate:down
