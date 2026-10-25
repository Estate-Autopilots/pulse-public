-- migrate:up
create or replace function pulse.review_apply_rules() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record; chosen_unit uuid; n int:=0;
begin
 if not viewer_is('admin') and not (current_setting('role',true)='pulse_worker' or (current_setting('role',true)='none' and pg_has_role(session_user,'pulse_worker','member') and not pg_has_role(session_user,'pulse_api','member'))) then raise exception 'denied' using errcode='42501'; end if;
 for r in select i.* from review_item i join review_rule rr on rr.org_id=i.org_id and rr.kind=i.kind where rr.enabled and i.status='pending' and i.confidence>=rr.threshold and i.evidence<>'{}'::jsonb order by i.confidence desc for update of i loop
  if r.kind='project_pod' then
   select u.id into chosen_unit from unit u where u.kind='pod' and u.name=r.proposed->>'pod' and u.valid_to is null;
   if chosen_unit is null or not exists(select 1 from project p where p.id=r.entity_id and not 'unit_id'=any(p.locked)) then continue;end if;
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by)
    select current_org(),'project',p.id,'pod',u.name,r.proposed->>'pod',current_viewer() from project p left join unit u on u.id=p.unit_id where p.id=r.entity_id;
   update project set unit_id=chosen_unit,locked=array(select distinct unnest(locked||'unit_id'::text)),updated_at=now() where id=r.entity_id;
  elsif r.kind='contact_type' then
   if r.proposed->>'contactType' not in ('developer','channel_partner','talent','vendor','other') or not exists(select 1 from contact_profile where person_id=r.entity_id and not 'contact_type'=any(locked)) then continue;end if;
   update contact_profile set contact_type=r.proposed->>'contactType',type_status='confirmed',updated_at=now(),locked=array(select distinct unnest(locked||'contact_type'::text)) where person_id=r.entity_id;
  else continue;end if;
  update review_item set status='accepted',decided_by=current_viewer(),decided_at=now() where id=r.id;
  perform audit_write('auto_accept','review_item',r.id::text,array[r.kind]);n:=n+1;
 end loop;
 return n;
end $$;
-- migrate:down
