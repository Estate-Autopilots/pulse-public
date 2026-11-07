-- migrate:up
-- FLOW-E (owner, 21 Oct 2026: "It all feels very specific to EA. Can there not be proper foundational blocks, and we
-- customise an account to any industry, role or anything?"):
--  * pulse.org_pack: the industry pack a company picked (or "neutral") and its own words: what a client, a project and a
--    run are called, the team, a lead. Everything a pack sets stays editable; picking another pack adds to what is there.
--  * pulse.work_role / pulse.work_role_holder: the company's work roles as data (any name), what each sees (the screens
--    it uses, its home and the tiles on it) and who holds it. A person holds any number of roles (HR and a work role);
--    a step given to a role lands on its holders (workflow_role_people, the one rule Flow and the older workflows use).
--  * pulse.flow_pack_write: one way a pack is applied (Settings, and the operator's company setup through tenant_pack):
--    words, roles, record types, company blocks and starter processes (drafts, by template key, never twice).

create table pulse.org_pack (
 org_id uuid primary key references pulse.org(id),
 pack_key text not null check(pack_key ~ '^[a-z0-9_]{1,40}$'),
 words jsonb not null default '{}' check(jsonb_typeof(words)='object' and pg_column_size(words)<20000),
 history jsonb not null default '[]' check(jsonb_typeof(history)='array'),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now()
);
create table pulse.work_role (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 key text not null check(key ~ '^[a-z0-9][a-z0-9_]{0,39}$'),name text not null check(length(btrim(name)) between 1 and 80),
 note text check(length(note)<=300),
 screens text[] not null default '{}' check(cardinality(screens)<=40),
 home text check(home in ('dashboard','sales')),
 tiles jsonb not null default '[]' check(jsonb_typeof(tiles)='array' and pg_column_size(tiles)<40000),
 source text check(length(source)<=80),position int not null default 0,
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 archived_at timestamptz
);
create unique index work_role_key on pulse.work_role(org_id,key) where archived_at is null;
create table pulse.work_role_holder (
 org_id uuid not null references pulse.org(id),role_id uuid not null references pulse.work_role(id),
 person_id uuid not null references pulse.person(id),since date not null default current_date,
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 primary key(role_id,person_id)
);
create index work_role_holder_person on pulse.work_role_holder(org_id,person_id);
do $$ declare t text;begin
 foreach t in array array['org_pack','work_role','work_role_holder'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant_isolation on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select on pulse.%I to pulse_api,pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;
grant insert,update on pulse.org_pack,pulse.work_role to pulse_api;
grant insert,delete on pulse.work_role_holder to pulse_api;

-- The company's words (empty when it never chose: the screens keep their own defaults).
create function pulse.org_words() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select words from org_pack where org_id=current_org()),'{}'::jsonb)
$$;

-- Who holds a role: the company's role holders (by the role's key or name), then, as before, people whose profile role
-- reads as it ("PGS" ← "Senior PGS") or who hold the access role of that key.
create or replace function pulse.workflow_role_people(p_role text) returns setof uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 with w as (select coalesce(array_agg(t),'{}') words from regexp_split_to_table(lower(regexp_replace(coalesce(p_role,''),'[^a-zA-Z0-9 ]+',' ','g')),'\s+') t where length(t)>1 and t not in ('the','of','and'))
 select h.person_id from work_role_holder h join work_role r on r.id=h.role_id join person p on p.id=h.person_id
 where r.org_id=current_org() and r.archived_at is null and p.status='active' and p.side='staff'
  and (lower(btrim(r.name))=lower(btrim(coalesce(p_role,''))) or r.key=lower(btrim(coalesce(p_role,''))) or r.key=trim(both '_' from regexp_replace(lower(coalesce(p_role,'')),'[^a-z0-9]+','_','g')))
 union
 select p.id from person p join people_profile pp on pp.person_id=p.id cross join w
 where p.org_id=current_org() and p.side='staff' and p.status='active' and (
  (cardinality(w.words)>0 and (select bool_and(lower(coalesce(pp.role,'')) ~ ('\m'||x||'s?\M')) from unnest(w.words) x))
  or exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p.id and r.role_key=lower(btrim(p_role)) and current_date between r.valid_from and coalesce(r.valid_to,'infinity')))
$$;

-- A pack, written into the current company. p = { key, name, words, roles: [{ key, name, note, screens, home, tiles }],
-- recordTypes: [{ key, def }], blocks: [{ key, name, summary, block, preset }], processes: [{ template, name, summary,
-- definition, writeup }] }. Words are merged (the company's own edits are kept unless the pack is applied with
-- replaceWords); roles, record types, blocks and processes are added when the company has none of that key yet.
-- Returns what it added, in counts and names.
create function pulse.flow_pack_write(p jsonb,p_replace_words boolean) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();x jsonb;n_roles int:=0;n_types int:=0;n_blocks int:=0;added text[]:='{}';v_pid uuid;i int:=0;
begin
 if jsonb_typeof(p)<>'object' or coalesce(p->>'key','') !~ '^[a-z0-9_]{1,40}$' then raise exception 'Choose a pack' using errcode='22023';end if;
 insert into org_pack(org_id,pack_key,words,history,updated_by) values(current_org(),p->>'key',coalesce(p->'words','{}'),
   jsonb_build_array(jsonb_build_object('pack',p->>'key','at',now(),'by',me)),me)
 on conflict(org_id) do update set pack_key=excluded.pack_key,
   words=case when p_replace_words then excluded.words else excluded.words||org_pack.words end,
   history=(org_pack.history||jsonb_build_array(jsonb_build_object('pack',p->>'key','at',now(),'by',me))),updated_by=me,updated_at=now();
 for x in select * from jsonb_array_elements(coalesce(p->'roles','[]')) loop
  i:=i+1;
  if not exists(select 1 from work_role where org_id=current_org() and key=x->>'key' and archived_at is null) then
   insert into work_role(org_id,key,name,note,screens,home,tiles,source,position,created_by,updated_by)
   values(current_org(),x->>'key',left(x->>'name',80),left(nullif(x->>'note',''),300),coalesce((select array_agg(s) from jsonb_array_elements_text(coalesce(x->'screens','[]')) s),'{}'),
    nullif(x->>'home',''),coalesce(x->'tiles','[]'),'pack:'||(p->>'key'),i*10,me,me);
   n_roles:=n_roles+1;
  end if;
 end loop;
 for x in select * from jsonb_array_elements(coalesce(p->'recordTypes','[]')) loop
  if not exists(select 1 from flow_record_type where org_id=current_org() and key=x->>'key') then
   insert into flow_record_type(org_id,key,def,created_by) values(current_org(),x->>'key',x->'def',me);n_types:=n_types+1;
  end if;
 end loop;
 for x in select * from jsonb_array_elements(coalesce(p->'blocks','[]')) loop
  if not exists(select 1 from flow_block where org_id=current_org() and key=x->>'key' and archived_at is null) then
   insert into flow_block(org_id,key,name,summary,block,preset,source,created_by,updated_by) values(current_org(),x->>'key',left(x->>'name',120),left(nullif(x->>'summary',''),500),x->>'block',x->'preset',
    'pack:'||(p->>'key'),me,me);n_blocks:=n_blocks+1;
  end if;
 end loop;
 for x in select * from jsonb_array_elements(coalesce(p->'processes','[]')) loop
  if not exists(select 1 from flow_process where org_id=current_org() and template_key=x->>'template' and status<>'archived') then
   insert into flow_process(org_id,name,summary,writeup,definition,template_key,created_by,updated_by)
   values(current_org(),left(x->>'name',200),left(nullif(x->>'summary',''),2000),coalesce(x->'writeup','[]'),x->'definition',x->>'template',me,me) returning id into v_pid;
   added:=array_append(added,x->>'name');
  end if;
 end loop;
 return jsonb_build_object('pack',p->>'key','roles',n_roles,'recordTypes',n_types,'blocks',n_blocks,'processes',to_jsonb(added));
end $$;

-- Settings → Industry & roles: leadership and admins apply a pack to their own company.
create function pulse.org_pack_apply(p jsonb,p_replace_words boolean default false) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Leadership and admins choose the company''s industry' using errcode='42501';end if;
 return flow_pack_write(p,p_replace_words);
end $$;

-- The operator's company setup: the pack is written into the company being set up (tenant_enter / tenant_leave).
create function pulse.tenant_pack(p_setup uuid,p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_out jsonb;
begin
 if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode='42501';end if;
 perform tenant_enter(p_setup,true);
 v_out:=flow_pack_write(p,true);
 perform tenant_leave();
 perform tenant_step(p_setup,'pack',jsonb_build_object('pack',p->>'key','name',p->>'name','added',v_out));
 return v_out;
end $$;

revoke all on function pulse.org_words(),pulse.flow_pack_write(jsonb,boolean),pulse.org_pack_apply(jsonb,boolean),pulse.tenant_pack(uuid,jsonb) from public;
grant execute on function pulse.org_words(),pulse.org_pack_apply(jsonb,boolean),pulse.tenant_pack(uuid,jsonb) to pulse_api;
grant execute on function pulse.org_words() to pulse_worker;

-- migrate:down
-- Forward-only: a company's words and roles are kept.
