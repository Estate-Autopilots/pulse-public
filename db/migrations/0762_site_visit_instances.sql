-- migrate:up
-- EST-2258: immutable visit starts; staff routes, submit and media mutation arrive in later slices.
-- Version 1 is virtual and currently has no fields (EST-1793 owns the default site_photos discrepancy).
alter table pulse.person add constraint person_org_id_unique unique(org_id,id);
alter table pulse.client add constraint client_org_id_unique unique(org_id,id);
alter table pulse.client add column after_closing_person_id uuid,
  add foreign key(org_id,after_closing_person_id) references pulse.person(org_id,id);
-- Existing admin-only client writes remain unchanged; never infer/backfill this binding.
create function pulse.client_after_closing_check() returns trigger
  language plpgsql set search_path=pulse,pg_temp as $$
begin
  if tg_op='UPDATE' and new.after_closing_person_id is not distinct from old.after_closing_person_id then return new; end if;
  if new.after_closing_person_id is not null then
    perform 1 from person where org_id=new.org_id and id=new.after_closing_person_id and side='staff' and status='active' for share;
    if not found then raise exception 'Choose active staff in this organisation' using errcode='22023'; end if;
  end if;
  return new;
end $$;
revoke all on function pulse.client_after_closing_check() from public;
create trigger after_closing_check before insert or update on pulse.client for each row execute function pulse.client_after_closing_check();

create table pulse.site_visit (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  customer_id uuid not null,
  type_key text not null check(type_key ~ '^[a-z0-9_]{1,40}$'),
  field_set_version int not null check(field_set_version >= 1),
  starting_fields jsonb not null check(jsonb_typeof(starting_fields)='array' and jsonb_array_length(starting_fields)<=60),
  assigned_person_id uuid not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  status text not null default 'open' check(status in ('open','submitted')),
  submitted_by uuid,
  submitted_at timestamptz,
  notes text not null default '' check(char_length(notes)<=4000),
  unique(org_id,id),
  foreign key(org_id,customer_id) references pulse.client(org_id,id),
  foreign key(org_id,assigned_person_id) references pulse.person(org_id,id),
  foreign key(org_id,created_by) references pulse.person(org_id,id),
  foreign key(org_id,submitted_by) references pulse.person(org_id,id),
  check((status='open' and submitted_by is null and submitted_at is null)
     or (status='submitted' and submitted_by is not null and submitted_at is not null and submitted_at>=created_at))
);
create index site_visit_customer on pulse.site_visit(org_id,customer_id,created_at,id);
create table pulse.site_visit_field_note (
  org_id uuid not null references pulse.org(id),
  visit_id uuid not null,
  field_key text not null check(field_key ~ '^[a-z0-9_]{1,40}$'),
  notes text not null check(char_length(notes)<=2000),
  primary key(org_id,visit_id,field_key),
  foreign key(org_id,visit_id) references pulse.site_visit(org_id,id)
);
create table pulse.site_visit_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references pulse.org(id),
  visit_id uuid not null,
  actor_id uuid not null,
  at timestamptz not null default now(),
  action text not null check(action in ('visit_created','visit_assigned','visit_notes_changed','field_notes_changed',
    'photo_added','photo_notes_changed','photo_deleted','photo_purged','visit_submitted','visit_edited_after_submit')),
  field_key text check(field_key ~ '^[a-z0-9_]{1,40}$'),
  photo_id uuid, -- Stable tombstone: deliberately no media FK; unlink/purge must not erase history.
  from_value text check(char_length(from_value)<=4000),
  to_value text check(char_length(to_value)<=4000),
  foreign key(org_id,visit_id) references pulse.site_visit(org_id,id),
  foreign key(org_id,actor_id) references pulse.person(org_id,id)
);
create index site_visit_history_time on pulse.site_visit_history(org_id,visit_id,at desc,id);

-- Match records.ts work(): HR is excluded unless admin takes precedence. Client RLS remains in force.
create function pulse.site_visit_customer_read(p_customer uuid) returns boolean
  language sql stable security invoker set search_path=pulse,pg_temp as $$
  select (not viewer_is('hr') or viewer_is('admin'))
    and exists(select 1 from client where org_id=current_org() and id=p_customer)
$$;
revoke all on function pulse.site_visit_customer_read(uuid) from public;
grant execute on function pulse.site_visit_customer_read(uuid) to pulse_api;
do $$ declare t text; begin
  foreach t in array array['site_visit','site_visit_field_note','site_visit_history'] loop
    execute format('alter table pulse.%I enable row level security',t);
    execute format('alter table pulse.%I force row level security',t);
    execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
    execute format('revoke all on pulse.%I from public,pulse_api,pulse_worker',t);
    execute format('grant select on pulse.%I to pulse_api',t);
  end loop;
end $$;
create policy customer_read on pulse.site_visit as restrictive for select to pulse_api
  using(pulse.site_visit_customer_read(customer_id));
create policy customer_read on pulse.site_visit_field_note as restrictive for select to pulse_api
  using(exists(select 1 from pulse.site_visit v where v.org_id=site_visit_field_note.org_id and v.id=visit_id));
create policy editor_read on pulse.site_visit_history as restrictive for select to pulse_api
  using(exists(select 1 from pulse.site_visit v where v.org_id=site_visit_history.org_id and v.id=visit_id
    and (pulse.viewer_is('admin') or (v.status='open' and v.assigned_person_id=pulse.current_viewer()))));

create function pulse.site_visit_immutable() returns trigger
  language plpgsql set search_path=pulse,pg_temp as $$
begin
  if tg_table_name='site_visit_history' or tg_op='DELETE' then
    raise exception 'Visit starts and history are retained' using errcode='42501';
  end if;
  if (new.id,new.org_id,new.customer_id,new.type_key,new.field_set_version,new.starting_fields,new.created_by,new.created_at)
     is distinct from (old.id,old.org_id,old.customer_id,old.type_key,old.field_set_version,old.starting_fields,old.created_by,old.created_at) then
    raise exception 'The starting visit snapshot is immutable' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function pulse.site_visit_immutable() from public;
create trigger immutable_start before update or delete on pulse.site_visit for each row execute function pulse.site_visit_immutable();
create trigger append_only before update or delete on pulse.site_visit_history for each row execute function pulse.site_visit_immutable();

create function pulse.site_visit_create(p_customer uuid,p_type text,p_assignee uuid default null,p_notes text default '') returns uuid
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); org uuid:=current_org(); assignee uuid:=coalesce(p_assignee,me);
  vid uuid; ver int; settings jsonb; fields jsonb;
begin
  if not exists(select 1 from person where org_id=org and id=me and side='staff' and status='active') then
    raise exception 'An active staff creator is required' using errcode='42501';
  end if;
  perform 1 from client where org_id=org and id=p_customer and site_visit_customer_read(id)
    and (viewer_is('admin') or after_closing_person_id=me) for share;
  if not found then
    raise exception 'Customer edit permission required' using errcode='42501';
  end if;
  if assignee is distinct from me and not viewer_is('admin') then
    raise exception 'Only an admin chooses another assignee' using errcode='42501';
  end if;
  if not exists(select 1 from person where org_id=org and id=assignee and side='staff' and status='active') then
    raise exception 'Choose active staff in this organisation' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('site_visit_field_set:'||org::text));
  select version,body into ver,settings from site_visit_field_set where org_id=org order by version desc limit 1;
  ver:=coalesce(ver,1);
  settings:=coalesce(settings,'{"visitTypes":[{"key":"survey","state":"active"},{"key":"installation","state":"active"},{"key":"service","state":"active"}],"fields":[]}'::jsonb);
  if p_type is null or not exists(select 1 from jsonb_array_elements(settings->'visitTypes') t where t->>'key'=p_type and t->>'state'='active') then
    raise exception 'Choose a current active visit type' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(f order by n),'[]') into fields from jsonb_array_elements(settings->'fields') with ordinality as x(f,n)
    where f->>'state'='active' and (f->'appliesTo'='null'::jsonb or f->'appliesTo' ? p_type);
  insert into site_visit(org_id,customer_id,type_key,field_set_version,starting_fields,assigned_person_id,created_by,notes)
    values(org,p_customer,p_type,ver,fields,assignee,me,p_notes) returning id into vid;
  insert into site_visit_history(org_id,visit_id,actor_id,action) values(org,vid,me,'visit_created');
  return vid;
end $$;
revoke all on function pulse.site_visit_create(uuid,text,uuid,text) from public;
grant execute on function pulse.site_visit_create(uuid,text,uuid,text) to pulse_api;
-- migrate:down
-- Forward-only: immutable starting snapshots and audit history.
