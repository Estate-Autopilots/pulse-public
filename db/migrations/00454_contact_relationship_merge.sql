-- migrate:up
-- Reviewed person merges include every explicit business relationship, without merging firms.
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
 else array['client:primary_contact_id','client_contact:person_id','project_contact:person_id','client_relationship:person_id','organization_contact:person_id','buyer_identity:person_id'] end loop
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

create trigger merge_redirect before insert or update on pulse.organization_contact for each row execute function pulse.merge_redirect();
create trigger merge_redirect before insert or update on pulse.buyer_identity for each row execute function pulse.merge_redirect();
-- migrate:down
