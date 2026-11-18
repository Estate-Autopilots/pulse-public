-- migrate:up
alter table pulse.audit_event add column changes jsonb not null default '{}';
-- Store before/after only for explicitly public business fields. Private HR, messages, finance and credentials stay metadata-only.
create or replace function pulse.audit_mutation() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j jsonb; oldj jsonb; cols text[]; rid text; safe text[]:='{}'; diffs jsonb:='{}'; k text;
begin
 j:=case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if j->>'org_id' is distinct from current_org()::text then return null; end if;
 oldj:=case when TG_OP in ('UPDATE','DELETE') then to_jsonb(old) else '{}'::jsonb end;
 select array_agg(key) into cols from jsonb_object_keys(j) key where TG_OP<>'UPDATE' or j->key is distinct from oldj->key;
 if cols is null then return null; end if;
 if TG_TABLE_SCHEMA='pulse' then
  safe:=case TG_TABLE_NAME when 'project' then array['title','name','status','unit_id','lead_person_id','client_id']
    when 'task' then array['title','status','owner_id','project_id','due_label'] when 'person' then array['display_name','status']
    when 'client' then array['display_name','status'] when 'people_profile' then array['role','pod','department','manager_id']
    when 'unit' then array['name','kind'] when 'policy_document' then array['kind','title','version','status'] else '{}' end;
 end if;
 foreach k in array cols loop
  if k=any(safe) then diffs:=diffs||jsonb_build_object(k,jsonb_build_object('before',oldj->k,'after',case when TG_OP='DELETE' then null else j->k end));end if;
 end loop;
 rid:=coalesce(j->>'id',j->>'person_id',j->>'file_id',j->>'source_key',j->>'day');
 insert into audit_event(org_id,actor_id,actor_account,action,resource,resource_id,fields,source,changes)
 values(current_org(),current_viewer(),nullif(current_setting('pulse.actor_account',true),''),lower(TG_OP),TG_TABLE_NAME,rid,cols,case when current_viewer() is null then 'sync' else 'pulse' end,diffs);
 return null;
end $$;
create table pulse.review_rule (
 org_id uuid not null references pulse.org(id),kind text not null check(kind in ('project_pod','contact_type')),threshold numeric not null check(threshold between 0.9 and 1),enabled boolean not null default false,
 created_by uuid references pulse.person(id),updated_at timestamptz not null default now(),primary key(org_id,kind)
);
alter table pulse.review_rule enable row level security;
alter table pulse.review_rule force row level security;
create policy tenant on pulse.review_rule using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy admin on pulse.review_rule as restrictive to pulse_api using(pulse.viewer_is('admin')) with check(pulse.viewer_is('admin'));
grant select,insert,update on pulse.review_rule to pulse_api;
grant select,insert,update,delete on pulse.review_rule to pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.review_rule for each row execute function pulse.audit_mutation();
create function pulse.review_apply_rules() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
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
   if r.proposed->>'type' not in ('developer','channel_partner','model_talent','vendor','other') or not exists(select 1 from contact_profile where person_id=r.entity_id and not 'contact_type'=any(locked)) then continue;end if;
   update contact_profile set contact_type=r.proposed->>'type',locked=array(select distinct unnest(locked||'contact_type'::text)) where person_id=r.entity_id;
  else continue;end if;
  update review_item set status='accepted',decided_by=current_viewer(),decided_at=now() where id=r.id;
  perform audit_write('auto_accept','review_item',r.id::text,array[r.kind]);n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function pulse.review_apply_rules() from public;
grant execute on function pulse.review_apply_rules() to pulse_api,pulse_worker;
-- migrate:down
