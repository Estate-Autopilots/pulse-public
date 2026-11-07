-- migrate:up
-- Client accounts, legal organisations, people and buyers are distinct identities.
create table pulse.legal_organization (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 display_name text not null, original_script_name text, created_at timestamptz not null default now()
);
create table pulse.buyer_identity (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 person_id uuid references pulse.person(id), legal_org_id uuid references pulse.legal_organization(id),
 source_ref text not null, check(num_nonnulls(person_id,legal_org_id)=1)
);
alter table pulse.client add column entity_kind text not null default 'unknown' check(entity_kind in ('unknown','person','company')),
 add column business_roles text[] not null default '{}', add column legal_org_id uuid references pulse.legal_organization(id),
 add column relationship_owner_id uuid references pulse.person(id), add column renewal_on date,
 add column history_from date, add column history_to date, add column history_complete boolean not null default false,
 add constraint client_roles_valid check(business_roles <@ array['developer','channel_partner','other']);
-- Existing source labels remain labels, not confirmation of person/company or legal ownership.
create table pulse.organization_contact (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 legal_org_id uuid not null references pulse.legal_organization(id), person_id uuid not null references pulse.person(id),
 effective_role text not null, authority text not null default 'unconfirmed' check(authority in ('unconfirmed','contact','decision','billing')),
 valid_from date not null, valid_to date, source_ref text not null, confirmed_by uuid references pulse.person(id),
 check(valid_to is null or valid_to>=valid_from)
);
create table pulse.client_relationship (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 client_id uuid not null references pulse.client(id), legal_org_id uuid references pulse.legal_organization(id),
 person_id uuid references pulse.person(id), buyer_id uuid references pulse.buyer_identity(id),
 kind text not null check(kind in ('ownership','billing','service_contact','buyer')),
 authority text not null default 'unconfirmed' check(authority in ('unconfirmed','contact','decision','billing')),
 valid_from date not null, valid_to date, source_ref text not null, confirmed_by uuid references pulse.person(id),
 check(num_nonnulls(legal_org_id,person_id,buyer_id)=1), check(valid_to is null or valid_to>=valid_from)
);
create table pulse.identity_assertion (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 entity_type text not null check(entity_type in ('client','contact','organization','buyer')), entity_id uuid not null,
 kind text not null check(kind in ('external_id','email','phone','organization','entity_kind','alias')),
 value text not null, verified boolean not null default false, shared boolean not null default false,
 source_scope text not null, source_ref text not null, source_family text not null,
 asserted_by uuid references pulse.person(id), observed_at timestamptz not null default now(),
 unique(org_id,entity_type,entity_id,kind,value,source_scope,source_family)
);
create index assertion_block on pulse.identity_assertion(org_id,kind,source_scope,value) where verified;
create table pulse.external_identity_binding (
 org_id uuid not null references pulse.org(id), source_scope text not null, external_id text not null,
 entity_type text not null check(entity_type in ('client','contact')), entity_id uuid not null,
 source_ref text not null, bound_by uuid not null references pulse.person(id),
 primary key(org_id,source_scope,external_id,entity_type)
);
create table pulse.identity_pair_decision (
 org_id uuid not null references pulse.org(id), entity_type text not null, left_id uuid not null, right_id uuid not null,
 evidence_version text not null, action text not null check(action in ('rejected','merged')),
 reason text not null, decided_by uuid not null references pulse.person(id), at timestamptz not null default now(),
 primary key(org_id,entity_type,left_id,right_id,evidence_version), check(left_id<right_id)
);
do $$ declare t text; begin
 foreach t in array array['legal_organization','buyer_identity','organization_contact','client_relationship','identity_assertion','external_identity_binding','identity_pair_decision'] loop
 execute format('alter table pulse.%I enable row level security',t);
 execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('grant select,insert,update,delete on pulse.%I to pulse_worker',t);
 execute format('grant select on pulse.%I to pulse_api',t);
 execute format('create policy master_read on pulse.%I as restrictive for select to pulse_api using(pulse.viewer_is(''admin''))',t);
 execute format('grant insert,update on pulse.%I to pulse_api',t);
 execute format('create policy master_insert on pulse.%I as restrictive for insert to pulse_api with check(pulse.viewer_is(''admin'') and pulse.current_viewer() is not null)',t);
 execute format('create policy master_update on pulse.%I as restrictive for update to pulse_api using(pulse.viewer_is(''admin'') and pulse.current_viewer() is not null) with check(pulse.viewer_is(''admin'') and pulse.current_viewer() is not null)',t);
 end loop;
end $$;
-- Identity assertions and candidate evidence are admin-only; all other work roles see client summary projections.
drop policy master_read on pulse.identity_assertion;
create policy master_read on pulse.identity_assertion as restrictive for select to pulse_api using(pulse.viewer_is('admin'));
drop policy master_read on pulse.identity_pair_decision;
create policy master_read on pulse.identity_pair_decision as restrictive for select to pulse_api using(pulse.viewer_is('admin'));
drop policy master_read on pulse.external_identity_binding;
create policy master_read on pulse.external_identity_binding as restrictive for select to pulse_api using(pulse.viewer_is('admin'));
-- Imported source fields and new master fields have separate locks; no new person/company inference.
grant update(entity_kind,business_roles,legal_org_id,relationship_owner_id,renewal_on,history_from,history_to,history_complete) on pulse.client to pulse_api;
create trigger merge_redirect before insert or update on pulse.client_relationship for each row execute function pulse.merge_redirect();
-- Guard every legacy merge entry point as well as the new preview route.
create function pulse.client_merge_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a text; b text; oa uuid; ob uuid;
begin
 if new.entity_type='client' then
 select entity_kind,legal_org_id into a,oa from client where id=new.keep_id;
 select entity_kind,legal_org_id into b,ob from client where id=new.gone_id;
 if a<>b or a='unknown' then raise exception 'confirm the same entity kind before merging' using errcode='22023'; end if;
 if oa is distinct from ob and oa is not null and ob is not null then raise exception 'conflicting legal organisations block this merge' using errcode='22023'; end if;
 end if;
 if new.entity_type in ('client','contact') and exists(
 select 1 from identity_assertion a join identity_assertion b on a.entity_type=b.entity_type and a.kind=b.kind and a.source_scope=b.source_scope
 where a.entity_type=new.entity_type and a.entity_id=new.keep_id and b.entity_id=new.gone_id and a.kind='external_id' and a.verified and b.verified and a.value<>b.value
 ) then raise exception 'conflicting verified identifiers block this merge' using errcode='22023'; end if;
 return new;
end $$;
create trigger client_merge_guard before insert on pulse.record_merge for each row execute function pulse.client_merge_guard();
revoke all on function pulse.client_merge_guard() from public;
create or replace function pulse.merge_records(p_type text,p_keep uuid,p_gone uuid) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare tbl text; spec text; rel text; col text; row record; prior text; moves jsonb:='[]'; rid uuid; mid uuid; sch text; check_count int;
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'admin required' using errcode='42501'; end if;
 select id into mid from record_merge where entity_type=p_type and keep_id=p_keep and gone_id=p_gone and undone_at is null;
 if mid is not null then return mid; end if;
 if p_type not in ('client','project','contact') or p_keep=p_gone then raise exception 'choose distinct matching records' using errcode='22023'; end if;
 tbl:=case when p_type='contact' then 'person' else p_type end;
 execute format('select count(*) from pulse.%I where id in ($1,$2)',tbl) into check_count using p_keep,p_gone;
 if check_count<>2 then raise exception 'record missing' using errcode='22023'; end if;
 if p_type='contact' and exists(select 1 from person where id in(p_keep,p_gone) and side='staff') then raise exception 'staff cannot be merged here' using errcode='22023'; end if;
 if exists(select 1 from record_merge where entity_type=p_type and (gone_id in(p_keep,p_gone) or keep_id=p_gone) and undone_at is null) then raise exception 'undo the existing merge first' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext(p_type||p_keep::text));
 execute format('select status from pulse.%I where id=$1 for update',tbl) into prior using p_gone;
 -- Relationship rows are kept in a private-to-admin undo journal. Conflicting associations require explicit cleanup.
 foreach spec in array case p_type when 'client' then array['project:client_id','client_contact:client_id','client_relationship:client_id']
 when 'project' then array['file_correction:project_id','money_match:project_id','activity_observation:project_id','index_file:project_id','delivery:project_id','task:project_id','campaign:project_id','phase:project_id','project_contact:project_id']
 else array['client:primary_contact_id','client_contact:person_id','project_contact:person_id'] end loop
 rel:=split_part(spec,':',1); col:=split_part(spec,':',2); sch:=case when rel='money_match' then 'pulse_priv' else 'pulse' end;
 for row in execute format('select to_jsonb(t) j from %I.%I t where %I=$1 for update',sch,rel,col) using p_gone loop
 if rel in ('client_contact','project_contact') then
  execute format('select count(*) from pulse.%I t where (to_jsonb(t)-$1-array[''is_primary'',''source'']) = ($2-$1-array[''is_primary'',''source'']) and %I=$3',rel,col)
  into check_count using col,row.j,p_keep;
  if check_count>0 then
   moves:=moves||jsonb_build_array(jsonb_build_object('table',rel,'schema',sch,'column',col,'before',row.j,'deleted',true));
   execute format('delete from pulse.%I t where to_jsonb(t)=$1',rel) using row.j;
   continue;
  end if;
 end if;
 moves:=moves||jsonb_build_array(jsonb_build_object('table',rel,'schema',sch,'column',col,'before',row.j));
 end loop;
 begin
 execute format('update %I.%I set %I=$1 where %I=$2',sch,rel,col,col) using p_keep,p_gone;
 exception when unique_violation then raise exception 'associations overlap; correct them before merging' using errcode='22023';
 end;
 end loop;
 -- Explicit/manual links follow the surviving record; source identity mapping redirects on future imports.
 for row in select to_jsonb(l) j from record_link l where entity_type=p_type and entity_id=p_gone for update loop
 moves:=moves||jsonb_build_array(jsonb_build_object('table','record_link','column','entity_id','before',row.j));
 end loop;
 update record_link set entity_id=p_keep where entity_type=p_type and entity_id=p_gone;
 execute format('update pulse.%I set status=$1 where id=$2',tbl) using case p_type when 'client' then 'churned' when 'project' then 'cancelled' else 'offboarded' end,p_gone;
 insert into record_merge(org_id,entity_type,keep_id,gone_id,moved,previous_status,merged_by) values(current_org(),p_type,p_keep,p_gone,moves,prior,current_viewer()) returning id into mid;
 perform audit_write('merge',p_type,p_gone::text,array[p_keep::text]);
 return mid;
end $$;

alter table pulse.record_merge add column kept_fields_before jsonb, add column kept_fields_after jsonb, add column review_version text;
-- Wrap the established guarded association undo with a guard for deliberately selected survivor fields.
alter function pulse.undo_merge(uuid) rename to undo_merge_associations;
revoke execute on function pulse.undo_merge_associations(uuid) from pulse_api;
create function pulse.undo_merge(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m record_merge%rowtype; current_fields jsonb;
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'admin required' using errcode='42501'; end if;
 select * into m from record_merge where id=p_id for update;
 if not found then raise exception 'merge missing' using errcode='22023'; end if;
 if m.undone_at is not null then return; end if;
 if m.kept_fields_after is not null then
 select jsonb_build_object('display_name',display_name,'company_name',company_name,'website',website,'email',email,'phone',phone,'city',city,'business_roles',business_roles,'legal_org_id',legal_org_id,'entity_kind',entity_kind,'relationship_owner_id',relationship_owner_id,'renewal_on',to_char(renewal_on,'YYYY-MM-DD'),'locked',locked,'updated_at',to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) into current_fields from client where id=m.keep_id for update;
 if current_fields<>m.kept_fields_after then raise exception 'survivor changed since merge; review it before undo' using errcode='22023'; end if;
 end if;
 perform undo_merge_associations(p_id);
 if m.kept_fields_before is not null then
 update client set display_name=m.kept_fields_before->>'display_name',company_name=m.kept_fields_before->>'company_name',website=m.kept_fields_before->>'website',email=m.kept_fields_before->>'email',phone=m.kept_fields_before->>'phone',city=m.kept_fields_before->>'city',
 business_roles=array(select jsonb_array_elements_text(m.kept_fields_before->'business_roles')),legal_org_id=(m.kept_fields_before->>'legal_org_id')::uuid,entity_kind=m.kept_fields_before->>'entity_kind',relationship_owner_id=(m.kept_fields_before->>'relationship_owner_id')::uuid,renewal_on=(m.kept_fields_before->>'renewal_on')::date,
 locked=array(select jsonb_array_elements_text(m.kept_fields_before->'locked')),updated_at=(m.kept_fields_before->>'updated_at')::timestamptz where id=m.keep_id;
 end if;
end $$;
revoke all on function pulse.undo_merge(uuid) from public;
grant execute on function pulse.undo_merge(uuid) to pulse_api;
-- migrate:down
