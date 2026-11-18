-- migrate:up
alter table pulse.review_item add constraint review_item_kind_check
  check(kind in ('identity','duplicate','project_pod','contact_type','data_gap','correction',
                 'manager','holiday','opening_balance','onboard_project_new'));
alter table pulse.review_rule drop constraint review_rule_kind_check;
alter table pulse.review_rule add constraint review_rule_kind_check
  check(kind in ('project_pod','contact_type','onboard_project_new'));

-- The normal project route, a person accepting a suggestion and review_apply_rules use this single create path.
create function pulse.company_create_project(p_project_name text, p_client_id uuid, p_client_name text, p_location text) returns uuid
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare client_key uuid; client_matches int; registry int; result uuid; role_name text:=current_setting('role',true);
begin
 if not viewer_is('admin') and not (role_name='pulse_worker' or (role_name='none' and
    pg_has_role(session_user,'pulse_worker','member') and not pg_has_role(session_user,'pulse_api','member'))) then
  raise exception 'denied' using errcode='42501';
 end if;
 if coalesce(btrim(p_project_name),'')='' or length(btrim(p_project_name))>160 then
  raise exception 'Choose a valid project name' using errcode='22023';
 end if;
 if length(btrim(coalesce(p_client_name,'')))>120 then
  raise exception 'Choose a valid client name' using errcode='22023';
 end if;
 if p_client_id is not null then
  select id into client_key from client where org_id=current_org() and id=p_client_id;
  if client_key is null then raise exception 'Client not found' using errcode='P0002'; end if;
 elsif coalesce(btrim(p_client_name),'')<>'' then
  select count(*)::int,min(id::text)::uuid into client_matches,client_key from client
   where org_id=current_org() and lower(regexp_replace(btrim(display_name),'[[:space:]]+',' ','g'))=
         lower(regexp_replace(btrim(p_client_name),'[[:space:]]+',' ','g'));
  if client_matches>1 then
   raise exception 'Client name matches multiple records; resolve the client first' using errcode='22023';
  elsif client_matches=0 then
   insert into client(org_id,display_name,type_basis,source)
    values(current_org(),btrim(p_client_name),'source','drive_folder_name') returning id into client_key;
  end if;
 end if;
 perform pg_advisory_xact_lock(hashtext('project-register:'||current_org()::text));
 select coalesce(max(registry_no),0)+1 into registry from project where org_id=current_org();
 insert into project(org_id,registry_no,name,title,client_id,location,locked)
  values(current_org(),registry,btrim(p_project_name),btrim(p_project_name),client_key,nullif(btrim(p_location),''),'{title,client_id,location}')
  returning id into result;
 return result;
end $$;
revoke all on function pulse.company_create_project(text,uuid,text,text) from public;
grant execute on function pulse.company_create_project(text,uuid,text,text) to pulse_api;

-- Drive proposals preserve the source identity used by the company seed.
create function pulse.company_create_drive_project(
 p_project_id uuid,p_folder_path text,p_storage_root text,p_project_name text,
 p_client_key text,p_client_id uuid,p_client_name text
) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare client_key uuid; result uuid; registry int; root_name text;
 role_name text:=current_setting('role',true);
begin
 if not viewer_is('admin') and not (role_name='pulse_worker' or (role_name='none' and
    pg_has_role(session_user,'pulse_worker','member') and not pg_has_role(session_user,'pulse_api','member'))) then
  raise exception 'denied' using errcode='42501';
 end if;
 root_name:=regexp_replace(coalesce(p_folder_path,''), '^.*/', '');
 if p_project_id is null or coalesce(btrim(p_folder_path),'')='' or length(p_folder_path)>500 or
    p_storage_root is distinct from 'index-path:'||p_folder_path or
    coalesce(btrim(p_project_name),'')='' or length(btrim(p_project_name))>160 or
    btrim(p_project_name) is distinct from root_name then
  raise exception 'Choose a valid Drive project root' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtext('project-storage-root:'||current_org()::text||':'||p_storage_root));

 if p_client_key is not null then
  if p_client_key !~ '^drive-path-client:.+' or p_client_id is null or
     coalesce(btrim(p_client_name),'')='' or length(btrim(p_client_name))>120 then
   raise exception 'Choose a valid Drive client identity' using errcode='22023';
  end if;
  select il.entity_id into client_key from identity_link il join client c
   on c.org_id=il.org_id and c.id=il.entity_id
   where il.org_id=current_org() and il.entity_type='client' and il.source='drive_folder_name'
    and il.source_key=p_client_key and il.valid_to is null order by il.valid_from desc limit 1;
  if client_key is null then
   insert into client(id,org_id,display_name,type_basis,source)
    values(p_client_id,current_org(),btrim(p_client_name),'source','drive_folder_name') on conflict(id) do nothing;
   if not exists(select 1 from client where id=p_client_id and org_id=current_org()) then
    raise exception 'Drive client identity belongs to another organisation' using errcode='23503';
   end if;
   insert into identity_link(org_id,entity_type,entity_id,source,source_key,raw_value,method,confidence)
    values(current_org(),'client',p_client_id,'drive_folder_name',p_client_key,btrim(p_client_name),'evidence',1)
    on conflict do nothing;
   select il.entity_id into client_key from identity_link il join client c
    on c.org_id=il.org_id and c.id=il.entity_id
    where il.org_id=current_org() and il.entity_type='client' and il.source='drive_folder_name'
     and il.source_key=p_client_key and il.valid_to is null order by il.valid_from desc limit 1;
  end if;
 elsif p_client_id is not null or p_client_name is not null then
  raise exception 'Drive client key is missing' using errcode='22023';
 end if;

 select id into result from project where org_id=current_org() and storage_root=p_storage_root limit 1;
 if result is not null then
  update project set client_id=client_key where org_id=current_org() and id=result and client_id is null
   and not 'client_id'=any(locked);
  return result;
 end if;

 perform pg_advisory_xact_lock(hashtext('project-register:'||current_org()::text));
 select coalesce(max(registry_no),0)+1 into registry from project where org_id=current_org();
 insert into project(id,org_id,registry_no,name,client_id,storage_root)
  values(p_project_id,current_org(),registry,btrim(p_project_name),client_key,p_storage_root)
  on conflict(id) do nothing returning id into result;
 if result is null then
  select id into result from project where id=p_project_id and org_id=current_org() and storage_root=p_storage_root;
  if result is null then raise exception 'Drive project identity conflicts with another project' using errcode='23505'; end if;
 end if;
 return result;
end $$;
revoke all on function pulse.company_create_drive_project(uuid,text,text,text,text,uuid,text) from public;
grant execute on function pulse.company_create_drive_project(uuid,text,text,text,text,uuid,text) to pulse_api,pulse_worker;

create or replace function pulse.review_apply_rules() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record; chosen_unit uuid; created_project uuid; n int:=0;
begin
 if not viewer_is('admin') and not (current_setting('role',true)='pulse_worker' or
    (current_setting('role',true)='none' and pg_has_role(session_user,'pulse_worker','member') and
     not pg_has_role(session_user,'pulse_api','member'))) then
  raise exception 'denied' using errcode='42501';
 end if;
 for r in select i.* from review_item i join review_rule rr on rr.org_id=i.org_id and rr.kind=i.kind
   where i.org_id=current_org() and rr.enabled and i.status='pending' and i.confidence>=rr.threshold and i.evidence<>'{}'::jsonb
   order by i.confidence desc for update of i loop
  created_project:=null;
  if r.kind='project_pod' then
   select u.id into chosen_unit from unit u where u.kind='pod' and u.name=r.proposed->>'pod' and u.valid_to is null;
   if chosen_unit is null or not exists(select 1 from project p where p.id=r.entity_id and not 'unit_id'=any(p.locked)) then continue;end if;
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by)
    select current_org(),'project',p.id,'pod',u.name,r.proposed->>'pod',current_viewer() from project p left join unit u on u.id=p.unit_id where p.id=r.entity_id;
   update project set unit_id=chosen_unit,locked=array(select distinct unnest(locked||'unit_id'::text)),updated_at=now() where id=r.entity_id;
  elsif r.kind='contact_type' then
   if r.proposed->>'contactType' not in ('developer','channel_partner','talent','vendor','other') or not exists(select 1 from contact_profile where person_id=r.entity_id and not 'contact_type'=any(locked)) then continue;end if;
   update contact_profile set contact_type=r.proposed->>'contactType',type_status='confirmed',updated_at=now(),locked=array(select distinct unnest(locked||'contact_type'::text)) where person_id=r.entity_id;
  elsif r.kind='onboard_project_new' then
   begin
    created_project:=company_create_drive_project(
     (r.proposed->>'projectId')::uuid,r.evidence->>'folderPath',r.proposed->>'storageRoot',
     r.proposed->>'projectName',r.proposed->>'clientKey',nullif(r.proposed->>'clientId','')::uuid,
     r.proposed->>'clientName');
   exception when others then
    created_project:=null;
    continue;
   end;
  else continue;end if;
  update review_item set entity_type=case when created_project is null then entity_type else 'project' end,
   entity_id=coalesce(created_project,entity_id),status='accepted',decided_by=current_viewer(),decided_at=now() where id=r.id;
  perform audit_write('auto_accept','review_item',r.id::text,array[r.kind]);n:=n+1;
 end loop;
 return n;
end $$;
-- migrate:down
-- Forward-only: accepted onboarding proposals create auditable company records.
