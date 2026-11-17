-- migrate:up
alter table pulse.project add column deliverable_type text;

alter table pulse.review_item drop constraint review_item_kind_check;
alter table pulse.review_item add constraint review_item_kind_check
  check(kind in ('identity','duplicate','project_pod','contact_type','data_gap','correction',
                 'manager','holiday','opening_balance','onboard_project_new','onboard_project_fill'));
alter table pulse.review_rule drop constraint review_rule_kind_check;
alter table pulse.review_rule add constraint review_rule_kind_check
  check(kind in ('project_pod','contact_type','onboard_project_new','onboard_project_fill'));

create function pulse.company_fill_project(
 p_project_id uuid,p_client_key text,p_client_id uuid,p_client_name text,p_deliverable_type text
) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pr project%rowtype; target_client uuid; matching int; named_client uuid;
 role_name text:=current_setting('role',true);
begin
 if not viewer_is('admin') and not (role_name='pulse_worker' or (role_name='none' and
    pg_has_role(session_user,'pulse_worker','member') and not pg_has_role(session_user,'pulse_api','member'))) then
  raise exception 'denied' using errcode='42501';
 end if;
 select * into pr from project where org_id=current_org() and id=p_project_id for update;
 if not found then raise exception 'Project not found' using errcode='P0002'; end if;

 if p_client_key is not null then
  if p_client_key !~ '^drive-path-client:.+' or p_client_id is null or
     coalesce(btrim(p_client_name),'')='' or length(btrim(p_client_name))>120 then
   raise exception 'Choose a valid Drive client identity' using errcode='22023';
  end if;
  select il.entity_id into target_client from identity_link il join client c
   on c.org_id=il.org_id and c.id=il.entity_id
   where il.org_id=current_org() and il.entity_type='client' and il.source='drive_folder_name'
    and il.source_key=p_client_key and il.valid_to is null order by il.valid_from desc limit 1;
  if target_client is null then
   select count(*)::int,min(id::text)::uuid into matching,named_client from client
    where org_id=current_org() and lower(regexp_replace(btrim(display_name),'[[:space:]]+',' ','g'))=
          lower(regexp_replace(btrim(p_client_name),'[[:space:]]+',' ','g'));
   if matching>1 then raise exception 'Client name matches multiple records' using errcode='22023';
   elsif matching=1 then target_client:=named_client;
   else
    insert into client(id,org_id,display_name,type_basis,source)
     values(p_client_id,current_org(),btrim(p_client_name),'source','drive_folder_name') on conflict(id) do nothing;
    if not exists(select 1 from client where id=p_client_id and org_id=current_org()) then
     raise exception 'Drive client identity belongs to another organisation' using errcode='23503';
    end if;
    target_client:=p_client_id;
   end if;
   insert into identity_link(org_id,entity_type,entity_id,source,source_key,raw_value,method,confidence)
    values(current_org(),'client',target_client,'drive_folder_name',p_client_key,btrim(p_client_name),'evidence',1)
    on conflict do nothing;
   select il.entity_id into target_client from identity_link il join client c
    on c.org_id=il.org_id and c.id=il.entity_id
    where il.org_id=current_org() and il.entity_type='client' and il.source='drive_folder_name'
     and il.source_key=p_client_key and il.valid_to is null order by il.valid_from desc limit 1;
  end if;
  if pr.client_id is null then
   if 'client_id'=any(pr.locked) then raise exception 'Project client is locked' using errcode='40001'; end if;
   update project set client_id=target_client,locked=array(select distinct unnest(locked||'client_id'::text)),updated_at=now()
    where id=p_project_id;
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by)
    values(current_org(),'project',p_project_id,'clientId',null,target_client::text,current_viewer());
  elsif pr.client_id<>target_client then
   raise exception 'Project already has a different client' using errcode='40001';
  end if;
 elsif p_client_id is not null or p_client_name is not null then
  raise exception 'Drive client key is missing' using errcode='22023';
 end if;

 if p_deliverable_type is not null then
  if coalesce(btrim(p_deliverable_type),'')='' or length(btrim(p_deliverable_type))>120 then
   raise exception 'Choose a valid deliverable type' using errcode='22023';
  end if;
  if pr.deliverable_type is null then
   if 'deliverable_type'=any(pr.locked) then raise exception 'Project deliverable type is locked' using errcode='40001'; end if;
   update project set deliverable_type=btrim(p_deliverable_type),
    locked=array(select distinct unnest(locked||'deliverable_type'::text)),updated_at=now() where id=p_project_id;
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by)
    values(current_org(),'project',p_project_id,'deliverableType',null,btrim(p_deliverable_type),current_viewer());
  elsif pr.deliverable_type<>btrim(p_deliverable_type) then
   raise exception 'Project already has a different deliverable type' using errcode='40001';
  end if;
 end if;
end $$;
revoke all on function pulse.company_fill_project(uuid,text,uuid,text,text) from public;
grant execute on function pulse.company_fill_project(uuid,text,uuid,text,text) to pulse_api,pulse_worker;

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
    and not (i.kind='onboard_project_fill' or i.source_key like 'onboard_project_fill:%' or
      (i.kind='project_pod' and i.evidence ? 'ruleId'))
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
  elsif r.kind='onboard_project_fill' then
   begin
    perform company_fill_project(r.entity_id,r.proposed->>'clientKey',
     nullif(r.proposed->>'clientId','')::uuid,r.proposed->>'clientName',r.proposed->>'deliverableType');
   exception when others then
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
-- Forward-only: accepted fill proposals retain their audit trail.
