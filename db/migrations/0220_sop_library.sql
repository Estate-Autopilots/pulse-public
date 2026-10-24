-- migrate:up
-- SOP-WORKFLOW part 1 (owner, 11 Oct 2026: "I need SOPs, standardisation"; leadership makes SOPs; the SOPs already in
-- Drive are fetched; a visualised SOP with connections and people matters more than the document format).
--  * pulse.sop_source: documents in Drive that read like an SOP (process, checklist, how-to, the Sell-Out system, Kazuk's
--    workflow and responsibilities docs). The Drive refresh captures them from the read-only EA index with their text,
--    a score and why; contact rosters, pay, agreements and HR drives are never captured. Nothing becomes an SOP by itself.
--  * pulse.sop: an SOP is a document model (steps with an owner role or person, inputs and outputs, time and SLA, KPIs,
--    linked templates, and the connections between steps: handoffs, decisions, approvals). The API parses a source into
--    steps (with a confidence) and leadership confirms or edits it; every save keeps a version.
--  * Leadership and admins create, import, edit and archive; everyone on the team reads active SOPs.

create table pulse.sop (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 title text not null check(length(btrim(title)) between 1 and 200),purpose text check(length(purpose)<=2000),
 status text not null default 'draft' check(status in ('draft','active','archived')),
 doc jsonb not null default '{"steps":[]}' check(jsonb_typeof(doc)='object' and jsonb_typeof(doc->'steps')='array' and pg_column_size(doc)<400000),
 owner_role text check(length(owner_role)<=80),owner_id uuid references pulse.person(id),
 client_id uuid references pulse.client(id),                      -- an SOP curated for one client company
 category text check(length(category)<=40),tags text[] not null default '{}' check(cardinality(tags)<=12),
 source text not null default 'pulse' check(source in ('pulse','drive','paste','template')),
 source_id uuid,source_hash text check(source_hash ~ '^[0-9a-f]{64}$'),confidence numeric(4,3) check(confidence between 0 and 1),
 version int not null default 1,
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 confirmed_by uuid references pulse.person(id),confirmed_at timestamptz
);
create index sop_status on pulse.sop(org_id,status,updated_at desc);
create table pulse.sop_version (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 sop_id uuid not null references pulse.sop(id),version int not null,title text not null,doc jsonb not null,
 note text check(length(note)<=300),saved_by uuid references pulse.person(id),saved_at timestamptz not null default now(),
 unique(org_id,sop_id,version)
);
create table pulse.sop_source (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 store text not null default 'gdrive' check(store in ('gdrive')),file_id text not null check(length(file_id)<=200),
 name text not null check(length(name) between 1 and 300),mime text check(length(mime)<=120),path text check(length(path)<=1000),
 link text check(link is null or link ~ '^https://'),owner_email text check(length(owner_email)<=200),
 modified_at timestamptz,text_hash text not null check(text_hash ~ '^[0-9a-f]{64}$'),
 body text not null check(length(body) between 1 and 200000),
 score numeric(4,3) not null check(score between 0 and 1),reasons text[] not null default '{}' check(cardinality(reasons)<=12),
 status text not null default 'new' check(status in ('new','imported','dismissed','gone')),
 sop_id uuid references pulse.sop(id),
 captured_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 decided_by uuid references pulse.person(id),decided_at timestamptz,
 unique(org_id,store,file_id)
);
alter table pulse.sop add constraint sop_source_fk foreign key(source_id) references pulse.sop_source(id);
create index sop_source_status on pulse.sop_source(org_id,status,score desc);

-- Leadership and admins write SOPs; they read drafts, archived SOPs and the Drive sources. Everyone reads active SOPs.
create function pulse.sop_editor() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and viewer_is('admin','leadership')
$$;
create function pulse.sop_require_editor() returns uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if not sop_editor() then raise exception 'Leadership and admins make and change SOPs' using errcode='42501';end if;
 return current_viewer();
end $$;

do $$ declare t text;begin
 foreach t in array array['sop','sop_version','sop_source'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant_isolation on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select on pulse.%I to pulse_api',t);
  execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;
create policy sop_read on pulse.sop as restrictive for select to pulse_api using(status='active' and pulse.current_viewer() is not null or pulse.sop_editor());
create policy sop_version_read on pulse.sop_version as restrictive for select to pulse_api
 using(pulse.sop_editor() or exists(select 1 from pulse.sop s where s.id=sop_id and s.status='active'));
create policy sop_source_read on pulse.sop_source as restrictive for select to pulse_api using(pulse.sop_editor());

-- The Drive refresh (worker) hands over what it found this run: new documents are added, changed ones keep their
-- decision (an imported SOP shows that its source changed), and documents no longer found are marked gone.
create function pulse.sop_source_capture(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x jsonb;n_new int:=0;n_changed int:=0;n_gone int:=0;seen text[]:='{}';prev sop_source;
begin
 if jsonb_typeof(p->'items')<>'array' then raise exception 'Hand over a list of documents' using errcode='22023';end if;
 for x in select * from jsonb_array_elements(p->'items') loop
  seen:=seen||(x->>'fileId');
  select * into prev from sop_source where org_id=current_org() and store='gdrive' and file_id=x->>'fileId';
  if not found then
   insert into sop_source(org_id,file_id,name,mime,path,link,owner_email,modified_at,text_hash,body,score,reasons)
   values(current_org(),x->>'fileId',left(x->>'name',300),left(x->>'mime',120),left(x->>'path',1000),nullif(x->>'link',''),left(x->>'ownerEmail',200),
    nullif(x->>'modifiedAt','')::timestamptz,x->>'textHash',left(x->>'body',200000),least(1,greatest(0,(x->>'score')::numeric)),
    coalesce(array(select left(r,200) from jsonb_array_elements_text(coalesce(x->'reasons','[]')) r limit 12),'{}'));
   n_new:=n_new+1;
  else
   if prev.text_hash is distinct from x->>'textHash' then n_changed:=n_changed+1;end if;
   update sop_source set name=left(x->>'name',300),mime=left(x->>'mime',120),path=left(x->>'path',1000),link=nullif(x->>'link',''),owner_email=left(x->>'ownerEmail',200),
    modified_at=nullif(x->>'modifiedAt','')::timestamptz,text_hash=x->>'textHash',body=left(x->>'body',200000),score=least(1,greatest(0,(x->>'score')::numeric)),
    reasons=coalesce(array(select left(r,200) from jsonb_array_elements_text(coalesce(x->'reasons','[]')) r limit 12),'{}'),
    status=case when status='gone' then case when sop_id is not null then 'imported' else 'new' end else status end,updated_at=now()
   where id=prev.id and (text_hash is distinct from x->>'textHash' or name is distinct from left(x->>'name',300) or status='gone' or score is distinct from least(1,greatest(0,(x->>'score')::numeric)));
  end if;
 end loop;
 if coalesce((p->>'complete')::boolean,true) then
  update sop_source set status='gone',updated_at=now() where org_id=current_org() and status='new' and not (file_id=any(seen));
  get diagnostics n_gone=row_count;
 end if;
 return jsonb_build_object('new',n_new,'changed',n_changed,'gone',n_gone,'seen',cardinality(seen));
end $$;

-- Save an SOP (null id: a new one). The API has already normalised the document (steps, connections, limits).
create function pulse.sop_save(p_id uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();s sop;sid uuid;v_status text;v_source uuid;src sop_source;
begin
 if jsonb_typeof(p)<>'object' or jsonb_typeof(p->'doc')<>'object' or jsonb_typeof(p->'doc'->'steps')<>'array' then raise exception 'Describe the SOP and its steps' using errcode='22023';end if;
 if coalesce(btrim(p->>'title'),'')='' then raise exception 'Name the SOP' using errcode='22023';end if;
 v_status:=coalesce(nullif(p->>'status',''),'draft');
 if v_status not in ('draft','active') then raise exception 'Save as a draft or make it active' using errcode='22023';end if;
 if v_status='active' and jsonb_array_length(p->'doc'->'steps')=0 then raise exception 'An active SOP has at least one step' using errcode='22023';end if;
 if nullif(p->>'clientId','') is not null and not exists(select 1 from client where org_id=current_org() and id=(p->>'clientId')::uuid) then raise exception 'Choose a client' using errcode='22023';end if;
 if nullif(p->>'ownerId','') is not null and not task_person_ok((p->>'ownerId')::uuid) then raise exception 'Choose an active team member as its owner' using errcode='22023';end if;
 if p_id is null then
  v_source:=nullif(p->>'sourceId','')::uuid;
  if v_source is not null then
   select * into src from sop_source where org_id=current_org() and id=v_source for update;
   if not found then raise exception 'That Drive document is no longer listed' using errcode='P0002';end if;
   -- One document may hold several SOPs ("SOP: Img", "SOP: Meta"); the same one is not imported twice.
   if exists(select 1 from sop where org_id=current_org() and source_id=v_source and lower(title)=lower(left(btrim(p->>'title'),200)) and status<>'archived') then
    raise exception 'This SOP was already brought in from that document' using errcode='23505';end if;
  end if;
  insert into sop(org_id,title,purpose,status,doc,owner_role,owner_id,client_id,category,tags,source,source_id,source_hash,confidence,created_by,updated_by,confirmed_by,confirmed_at)
  values(current_org(),left(btrim(p->>'title'),200),nullif(left(p->>'purpose',2000),''),v_status,p->'doc',nullif(left(p->>'ownerRole',80),''),nullif(p->>'ownerId','')::uuid,
   nullif(p->>'clientId','')::uuid,nullif(left(p->>'category',40),''),coalesce(array(select left(t,40) from jsonb_array_elements_text(coalesce(p->'tags','[]')) t limit 12),'{}'),
   case when v_source is not null then 'drive' else coalesce(nullif(p->>'source',''),'pulse') end,v_source,
   case when v_source is not null then src.text_hash end,nullif(p->>'confidence','')::numeric,me,me,
   case when v_status='active' then me end,case when v_status='active' then now() end)
  returning id into sid;
  if v_source is not null then update sop_source set status='imported',sop_id=coalesce(sop_id,sid),decided_by=me,decided_at=now(),updated_at=now() where id=v_source;end if;
  insert into sop_version(org_id,sop_id,version,title,doc,note,saved_by) values(current_org(),sid,1,left(btrim(p->>'title'),200),p->'doc',
   case when v_source is not null then 'Imported from Drive' else nullif(left(p->>'note',300),'') end,me);
  perform audit_write('create','sop',sid::text);
  return sid;
 end if;
 select * into s from sop where org_id=current_org() and id=p_id for update;
 if not found then raise exception 'SOP not found' using errcode='P0002';end if;
 if s.status='archived' then raise exception 'Restore the SOP before changing it' using errcode='22023';end if;
 update sop set title=left(btrim(p->>'title'),200),purpose=nullif(left(p->>'purpose',2000),''),status=v_status,doc=p->'doc',owner_role=nullif(left(p->>'ownerRole',80),''),
  owner_id=nullif(p->>'ownerId','')::uuid,client_id=nullif(p->>'clientId','')::uuid,category=nullif(left(p->>'category',40),''),
  tags=coalesce(array(select left(t,40) from jsonb_array_elements_text(coalesce(p->'tags','[]')) t limit 12),'{}'),
  source_hash=case when (p->>'sourceRefreshed')::boolean then (select text_hash from sop_source where id=s.source_id) else source_hash end,
  version=case when doc is distinct from p->'doc' or title is distinct from left(btrim(p->>'title'),200) then version+1 else version end,
  confirmed_by=case when v_status='active' and s.status<>'active' then me else confirmed_by end,
  confirmed_at=case when v_status='active' and s.status<>'active' then now() else confirmed_at end,
  updated_by=me,updated_at=now()
 where id=p_id returning * into s;
 if not exists(select 1 from sop_version where org_id=current_org() and sop_id=p_id and version=s.version) then
  insert into sop_version(org_id,sop_id,version,title,doc,note,saved_by) values(current_org(),p_id,s.version,s.title,s.doc,nullif(left(p->>'note',300),''),me);
 end if;
 perform audit_write('update','sop',p_id::text);
 return p_id;
end $$;

create function pulse.sop_set_status(p_id uuid,p_status text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();s sop;
begin
 if p_status not in ('draft','active','archived') then raise exception 'Choose draft, active or archived' using errcode='22023';end if;
 select * into s from sop where org_id=current_org() and id=p_id for update;
 if not found then raise exception 'SOP not found' using errcode='P0002';end if;
 if p_status='active' and jsonb_array_length(s.doc->'steps')=0 then raise exception 'An active SOP has at least one step' using errcode='22023';end if;
 update sop set status=p_status,updated_by=me,updated_at=now(),
  confirmed_by=case when p_status='active' and s.status<>'active' then me else confirmed_by end,
  confirmed_at=case when p_status='active' and s.status<>'active' then now() else confirmed_at end where id=p_id;
 perform audit_write(case p_status when 'archived' then 'archive' when 'active' then 'activate' else 'draft' end,'sop',p_id::text);
end $$;

-- "Not an SOP": the document is not proposed again (unless restored).
create function pulse.sop_source_decide(p_id uuid,p_dismiss boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();
begin
 update sop_source set status=case when p_dismiss then 'dismissed' else 'new' end,decided_by=me,decided_at=now(),updated_at=now()
 where org_id=current_org() and id=p_id and status in ('new','dismissed','gone') and sop_id is null;
 if not found then raise exception 'That document is already an SOP or no longer listed' using errcode='P0002';end if;
 perform audit_write(case when p_dismiss then 'dismiss' else 'restore' end,'sop_source',p_id::text);
end $$;

revoke all on function pulse.sop_editor(),pulse.sop_require_editor(),pulse.sop_source_capture(jsonb),pulse.sop_save(uuid,jsonb),pulse.sop_set_status(uuid,text),pulse.sop_source_decide(uuid,boolean) from public;
grant execute on function pulse.sop_editor(),pulse.sop_require_editor(),pulse.sop_save(uuid,jsonb),pulse.sop_set_status(uuid,text),pulse.sop_source_decide(uuid,boolean) to pulse_api;
grant execute on function pulse.sop_editor(),pulse.sop_source_capture(jsonb) to pulse_worker;

-- migrate:down
-- Forward-only: SOPs and their versions are kept.
