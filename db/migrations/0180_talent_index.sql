-- migrate:up
-- R55 part 1 (owner, 11 Oct 2026): the talent index. Which model shot for which client and project, when, where, what
-- came out of it, and what it cost: "which model gives how much benefit to us, which doesn't, what works".
--  * A model is a contact of type talent (contact types stay general; "Model" is EA's word for it).
--  * talent_alias: every way a sheet or folder writes a model's name ("cheetna", "Sobuha O") and the contact it means.
--    Exact and spelling-variant names link themselves; a first name shared by two models, or a name that only matches
--    by first name, waits for a person in Review data (kind 'talent').
--  * talent_shoot: one row per shoot line from the shoot coordinator's sheets (shoot Details: client, deliverable,
--    language, place, day; Model & Cinematographer Pay Tracker: day, place, crew, scripts). The project it was for is
--    read from the client, the place, the month and the dated model videos in the project's folder, with the basis
--    and a confidence; unsure links wait in Review data.
--  * talent_media: a model's portfolio (EA Sample Model videos & Outfits) and files named for them.
--  * pulse_priv.talent_fee: what each pay-tracker line paid (fee, travel, extras). Read only by leadership with finance
--    grants, like every other money figure, and every read is audited. No bank or ID details are ever read.
-- The worker pulse_workers.talent_index writes all of it; nothing here sends anything or changes a contact's record.

create table pulse.talent_run (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 started_at timestamptz not null default now(),finished_at timestamptz,ok boolean,
 counts jsonb not null default '{}' check(jsonb_typeof(counts)='object'),sources jsonb not null default '[]' check(jsonb_typeof(sources)='array'),
 error text check(length(error)<=200)
);
create table pulse.talent_alias (
 org_id uuid not null references pulse.org(id),
 alias_key text not null check(alias_key ~ '^[a-z0-9 ]{2,80}$'),     -- the name as written, lower case, letters only
 alias text not null check(length(alias) between 1 and 120),
 person_id uuid references pulse.person(id),                          -- the model; null while undecided or rejected
 basis text not null check(basis in ('exact','variant','first_name','new','review','manual')),
 confidence numeric not null check(confidence between 0 and 1),
 status text not null default 'auto' check(status in ('auto','confirmed','rejected','review')),
 seen int not null default 0,
 decided_by uuid references pulse.person(id),decided_at timestamptz,
 primary key(org_id,alias_key)
);
create table pulse.talent_shoot (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 source_key text not null check(length(source_key) between 3 and 200),
 person_id uuid references pulse.person(id),
 alias text not null,
 shoot_on date,                                                       -- null when the sheet gives no usable day
 month date not null check(extract(day from month)=1),
 client_label text,
 project_id uuid references pulse.project(id),
 project_basis text check(project_basis in ('client_name','dated_video','shoot_day_upload','place_month','review','none')),
 project_confidence numeric check(project_confidence between 0 and 1),
 place text,
 locality_id uuid references pulse.locality(id),
 lat double precision check(lat between -90 and 90),lng double precision check(lng between -180 and 180),
 place_basis text check(place_basis in ('locality','project','none')),
 deliverable text,segment text,language text,scripts numeric check(scripts>=0 and scripts<100),
 crew text[] not null default '{}',status text,
 sources text[] not null default '{}',                                -- 'shoot_sheet', 'pay_tracker'
 source jsonb not null check(jsonb_typeof(source)='object' and source ? 'type'),
 run_id uuid,
 unique(org_id,source_key)
);
create index talent_shoot_person on pulse.talent_shoot(org_id,person_id,shoot_on);
create index talent_shoot_project on pulse.talent_shoot(org_id,project_id);
create table pulse.talent_media (
 org_id uuid not null references pulse.org(id),
 file_id text not null check(length(file_id) between 3 and 200),
 person_id uuid not null references pulse.person(id),
 project_id uuid references pulse.project(id),
 kind text not null check(kind in ('portfolio','video','image','document')),
 name text not null,mime text,path text,link text,created_at timestamptz,
 basis text not null check(basis in ('portfolio_folder','file_name','shoot_date','shoot_project')),   -- how Pulse knows it is theirs
 primary key(org_id,file_id,person_id)
);
create table pulse_priv.talent_fee (
 org_id uuid not null references pulse.org(id),
 source_key text not null check(length(source_key) between 3 and 200),
 person_id uuid references pulse.person(id),
 alias text not null,shoot_on date,month date not null,
 charges numeric(12,2),travel numeric(12,2),extra numeric(12,2),total numeric(12,2) check(total is null or total>=0),
 paid text,shoot_keys text[] not null default '{}',
 source jsonb not null check(jsonb_typeof(source)='object' and source ? 'type'),
 primary key(org_id,source_key)
);

do $$ declare t text; begin
 foreach t in array array['pulse.talent_run','pulse.talent_alias','pulse.talent_shoot','pulse.talent_media','pulse_priv.talent_fee'] loop
  execute format('alter table %s enable row level security',t);
  execute format('alter table %s force row level security',t);
  execute format('create policy tenant_isolation on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())',t);
  execute format('grant select, insert, update, delete on %s to pulse_worker',t);
 end loop;
 foreach t in array array['pulse.talent_run','pulse.talent_alias','pulse.talent_shoot','pulse.talent_media'] loop
  execute format('grant select on %s to pulse_api',t);
 end loop;
end $$;
create trigger audit_mutation after insert or update or delete on pulse.talent_alias for each row execute function pulse.audit_mutation();
create trigger audit_mutation after insert or update or delete on pulse_priv.talent_fee for each row execute function pulse.audit_mutation();

-- Review data learns one more kind: a model's name or a shoot's project that Pulse could not decide alone.
alter table pulse.review_item drop constraint review_item_kind_check;
alter table pulse.review_item add constraint review_item_kind_check check (kind in ('identity','duplicate','project_pod','contact_type','data_gap',
 'correction','manager','holiday','opening_balance','onboard_project_new','talent'));

-- The comparison key of a written name, as the worker computes it ("Sobuha O." -> "sobuha o").
create function pulse.talent_key(p text) returns text language sql immutable as $$
 select btrim(regexp_replace(lower(regexp_replace(coalesce(p,''),'[^A-Za-z0-9]+',' ','g')),'\s+',' ','g'))
$$;
-- Who sees what a model costs: leadership with the finance read and amount grants, never the Accountant (as finance).
create function pulse.talent_cost_visible() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and not is_accountant(current_viewer()) and money_can('money.read') and money_can('money.amount.read')
$$;
-- Fees per model and in total; every read is audited. Rows carry the shoots they paid for, so cost per shoot, per script
-- and per client can be worked out beside the shoots everyone may see.
create function pulse.talent_fees(p_person uuid default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not talent_cost_visible() then raise exception 'What a model costs is visible to leadership with finance grants' using errcode='42501'; end if;
 perform audit_write('restricted_read','talent.fee',p_person::text);
 return coalesce((select jsonb_agg(jsonb_build_object('key',f.source_key,'personId',f.person_id,'alias',f.alias,'shootOn',f.shoot_on,'month',to_char(f.month,'YYYY-MM'),
   'charges',f.charges,'travel',f.travel,'extra',f.extra,'total',f.total,'paid',f.paid,'shootKeys',f.shoot_keys,'source',f.source) order by f.shoot_on desc nulls last,f.source_key)
  from pulse_priv.talent_fee f where f.org_id=current_org() and (p_person is null or f.person_id=p_person)),'[]');
end $$;

-- Review decisions (admins): an alias is this model or nobody; a shoot was for this project or for none. Decisions are
-- kept on the alias and on the review item, so the next import keeps them.
create function pulse.talent_decide(p_item uuid,p_accept boolean,p_choice uuid default null) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record;pick uuid;
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'An individual organisation admin decides talent suggestions' using errcode='42501'; end if;
 select * into r from review_item where id=p_item and kind='talent' and status='pending' for update;
 if not found then raise exception 'A suggestion has already been decided' using errcode='P0002'; end if;
 pick:=coalesce(p_choice,(r.proposed->>'personId')::uuid,(r.proposed->>'projectId')::uuid);
 if r.proposed->>'what'='alias' then
  if p_accept and (pick is null or not exists(select 1 from contact_profile where person_id=pick and contact_type='talent')) then
   raise exception 'Choose a model' using errcode='22023'; end if;
  update talent_alias set person_id=case when p_accept then pick end,status=case when p_accept then 'confirmed' else 'rejected' end,
   basis=case when p_accept then 'review' else basis end,confidence=case when p_accept then 1 else confidence end,decided_by=current_viewer(),decided_at=now()
   where alias_key=r.proposed->>'aliasKey';
  update talent_shoot set person_id=case when p_accept then pick end where talent_key(alias)=r.proposed->>'aliasKey';
 elsif r.proposed->>'what'='shoot_project' then
  if p_accept and (pick is null or not exists(select 1 from project where id=pick)) then raise exception 'Choose a project' using errcode='22023'; end if;
  update talent_shoot set project_id=case when p_accept then pick end,project_basis=case when p_accept then 'review' else 'none' end,
   project_confidence=case when p_accept then 1 else null end where source_key=r.proposed->>'sourceKey';
 else raise exception 'Unknown talent suggestion' using errcode='22023'; end if;
 update review_item set status=case when p_accept then 'accepted' else 'dismissed' end,decided_by=current_viewer(),decided_at=now(),
  proposed=proposed||case when p_accept and pick is not null then jsonb_build_object('chosen',pick) else '{}' end where id=p_item;
end $$;

revoke all on function pulse.talent_cost_visible(),pulse.talent_fees(uuid),pulse.talent_decide(uuid,boolean,uuid) from public;
grant execute on function pulse.talent_cost_visible(),pulse.talent_fees(uuid),pulse.talent_decide(uuid,boolean,uuid) to pulse_api;
-- migrate:down
