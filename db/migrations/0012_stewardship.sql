-- migrate:up
alter table pulse.index_file add column display_name text;
-- Manual file corrections are replayed during every index/projector sync, by stable file ID.
create function pulse.file_manual_wins() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r file_correction%rowtype; target uuid;
begin
 select * into r from file_correction where org_id=new.org_id and file_id=new.file_id;
 if found then
  if TG_TABLE_NAME='index_file' then new.display_name:=r.display_name; end if;
  if r.project_id is not null then new.project_id:=r.project_id; end if;
 end if;
 select keep_id into target from record_merge where org_id=new.org_id and entity_type='project' and gone_id=new.project_id and undone_at is null;
 if target is not null then new.project_id:=target; end if;
 return new;
end $$;
create trigger file_manual_wins before insert or update on pulse.index_file for each row execute function pulse.file_manual_wins();
create trigger file_manual_wins before insert or update on pulse.delivery for each row execute function pulse.file_manual_wins();
create function pulse.correct_file(p_file text,p_name text,p_project uuid,p_reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'admin required' using errcode='42501'; end if;
 if not exists(select 1 from index_file where file_id=p_file) then raise exception 'file missing' using errcode='22023'; end if;
 if p_project is not null and not exists(select 1 from project where id=p_project) then raise exception 'project missing' using errcode='22023'; end if;
 insert into file_correction(org_id,file_id,display_name,project_id,wrong_reason,edited_by) values(current_org(),p_file,p_name,p_project,p_reason,current_viewer())
 on conflict(org_id,file_id) do update set display_name=excluded.display_name,project_id=excluded.project_id,wrong_reason=excluded.wrong_reason,edited_by=excluded.edited_by,updated_at=now();
 update index_file set display_name=p_name,project_id=coalesce(p_project,project_id) where file_id=p_file;
 update delivery set project_id=coalesce(p_project,project_id) where file_id=p_file;
end $$;

-- Merged source IDs remain stable redirects. Sync cannot revive a duplicate or move relations back to it.
create function pulse.merge_redirect() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k text; entity text; target uuid; j jsonb;
begin
 if current_setting('pulse.merge_undo',true)='1' then return new; end if;
 j:=to_jsonb(new);
 if TG_TABLE_NAME in ('client','person','project') then
 entity:=case when TG_TABLE_NAME='person' then 'contact' else TG_TABLE_NAME end;
 if exists(select 1 from record_merge where entity_type=entity and gone_id=new.id and undone_at is null) then
  j:=jsonb_set(j,'{status}',to_jsonb(case entity when 'client' then 'churned' when 'project' then 'cancelled' else 'offboarded' end));
 end if;
 end if;
 foreach k in array array['project_id','client_id','person_id'] loop
 if j ? k and j->>k is not null then
 entity:=case k when 'project_id' then 'project' when 'client_id' then 'client' else 'contact' end;
 select keep_id into target from record_merge where entity_type=entity and gone_id=(j->>k)::uuid and undone_at is null;
 if target is not null then j:=jsonb_set(j,array[k],to_jsonb(target)); end if;
 end if;
 end loop;
 new:=jsonb_populate_record(new,j); return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['client','person','project','client_contact','project_contact','task','campaign','record_link','record_annotation','project_location_member','identity_link'] loop
 execute format('create trigger merge_redirect before insert or update on pulse.%I for each row execute function pulse.merge_redirect()',t);
 end loop;
end $$;
-- Manual links are retained separately from source folders and names; source IDs always continue resolving.
create function pulse.merge_records(p_type text,p_keep uuid,p_gone uuid) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare tbl text; spec text; rel text; col text; row record; prior text; moves jsonb:='[]'; rid uuid; mid uuid; check_count int;
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'admin required' using errcode='42501'; end if;
 if p_type not in ('client','project','contact') or p_keep=p_gone then raise exception 'choose distinct matching records' using errcode='22023'; end if;
 tbl:=case when p_type='contact' then 'person' else p_type end;
 execute format('select count(*) from pulse.%I where id in ($1,$2)',tbl) into check_count using p_keep,p_gone;
 if check_count<>2 then raise exception 'record missing' using errcode='22023'; end if;
 if p_type='contact' and exists(select 1 from person where id in(p_keep,p_gone) and side='staff') then raise exception 'staff cannot be merged here' using errcode='22023'; end if;
 if exists(select 1 from record_merge where entity_type=p_type and (gone_id in(p_keep,p_gone) or keep_id=p_gone) and undone_at is null) then raise exception 'undo the existing merge first' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext(p_type||p_keep::text));
 execute format('select status from pulse.%I where id=$1 for update',tbl) into prior using p_gone;
 -- Relationship rows are kept in a private-to-admin undo journal. Conflicting associations require explicit cleanup.
 foreach spec in array case p_type when 'client' then array['project:client_id','client_contact:client_id']
 when 'project' then array['index_file:project_id','delivery:project_id','task:project_id','campaign:project_id','phase:project_id','project_contact:project_id']
 else array['client_contact:person_id','project_contact:person_id'] end loop
 rel:=split_part(spec,':',1); col:=split_part(spec,':',2);
 for row in execute format('select to_jsonb(t) j from pulse.%I t where %I=$1 for update',rel,col) using p_gone loop
 moves:=moves||jsonb_build_array(jsonb_build_object('table',rel,'column',col,'before',row.j));
 end loop;
 begin
 execute format('update pulse.%I set %I=$1 where %I=$2',rel,col,col) using p_keep,p_gone;
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
create function pulse.undo_merge(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m record_merge%rowtype; item jsonb; oldj jsonb; rel text; col text; condition text; restored int; key text; tbl text;
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'admin required' using errcode='42501'; end if;
 select * into m from record_merge where id=p_id and undone_at is null for update;
 if not found then raise exception 'active merge missing' using errcode='22023'; end if;
 perform set_config('pulse.merge_undo','1',true);
 for item in select value from jsonb_array_elements(m.moved) loop
 rel:=item->>'table'; col:=item->>'column'; oldj:=item->'before';
 -- The entire moved row, except its moved FK, must still match. Undo never overwrites subsequent edits.
 execute format('update pulse.%I t set %I=$1 where (to_jsonb(t)-$3) = ($2-$3) and %I=$4',rel,col,col)
 using m.gone_id,oldj,col,m.keep_id;
 get diagnostics restored=row_count;
 if restored<>1 then raise exception 'a moved record changed since merge; review it before undo' using errcode='22023'; end if;
 end loop;
 tbl:=case when m.entity_type='contact' then 'person' else m.entity_type end;
 execute format('update pulse.%I set status=$1 where id=$2',tbl) using m.previous_status,m.gone_id;
 update record_merge set undone_at=now() where id=p_id;
 perform audit_write('undo_merge',m.entity_type,m.gone_id::text,array[m.keep_id::text]);
end $$;
revoke all on function pulse.file_manual_wins(),pulse.correct_file(text,text,uuid,text),pulse.merge_redirect(),pulse.merge_records(text,uuid,uuid),pulse.undo_merge(uuid) from public;
grant execute on function pulse.correct_file(text,text,uuid,text),pulse.merge_records(text,uuid,uuid),pulse.undo_merge(uuid) to pulse_api;
-- migrate:down
