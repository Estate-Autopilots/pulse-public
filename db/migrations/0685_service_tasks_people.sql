-- migrate:up
-- EST-1406 / EST-1392 1.0.2 §6 (service.yaml 1.2.0). Re-check key, scope and bound AI member; never set a viewer.
-- Own tasks via EST-1396 (iss, sub) only; no notes, estimates, value, timers, activity or cross-person counts.
create function pulse.service_my_tasks(p_key uuid,p_hash text,p_iss text,p_sub text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid;tz text;result jsonb;
begin
 if service_key_auth(p_key,p_hash,'tasks.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 perform k.id from pulse_priv.service_key k join agent_member a on a.person_id=k.agent_id join person p on p.id=a.person_id
  where k.id=p_key and k.org_id=install_org() and a.org_id=k.org_id and a.disabled_at is null
   and p.org_id=k.org_id and p.side='agent' and p.status='active' for share of k,a,p;
 if not found then raise exception 'An active install-local AI member is required' using errcode='42501'; end if;
 -- Not a sign-in (`used` false). Contract §6: the audit holds the key id (the service actor) and the person id, never the token.
 me:=(google_identity_resolve(p_iss,p_sub,false)->>'personId')::uuid;
 if me is null then return jsonb_build_object('error','person_not_linked'); end if;
 perform audit_write('service_tasks_read','person',me::text,array['key:'||p_key::text]);
 tz:=org_time_zone(install_org());
 with mine as (
  select t.id,t.title,case when t.status='unknown' then 'open' else t.status end status,t.due_at,
   t.status in ('open','in_progress','blocked') and t.due_at between now() and now()+interval '24 hours' due_soon
  from task t where t.org_id=install_org() and coalesce(t.assignee_person_id,t.owner_id)=me and t.deleted_at is null
   and t.status in ('open','unknown','in_progress','blocked','in_review')
  order by t.due_at nulls last,t.id limit 200
 )
 select jsonb_build_object('personId',me,'generatedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'items',coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title,'status',status,
   'dueAt',to_char(due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
   'bucket',case when due_at is null then 'no_due_date' when (due_at at time zone tz)::date<(now() at time zone tz)::date then 'overdue'
    when (due_at at time zone tz)::date=(now() at time zone tz)::date then 'due_today' else 'upcoming' end,
   'dueSoon',coalesce(due_soon,false),'link','/tasks/'||id) order by due_at nulls last,id),'[]'::jsonb))
 into result from mine; return result;
end $$;
-- Staff directory: active/inactive only, current roles and department/team/pod units, work email only.
create function pulse.service_people(p_key uuid,p_hash text,p_after uuid default null,p_limit int default 100) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb;
begin
 if service_key_auth(p_key,p_hash,'people.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 perform k.id from pulse_priv.service_key k join agent_member a on a.person_id=k.agent_id join person p on p.id=a.person_id
  where k.id=p_key and k.org_id=install_org() and a.org_id=k.org_id and a.disabled_at is null
   and p.org_id=k.org_id and p.side='agent' and p.status='active' for share of k,a,p;
 if not found then raise exception 'An active install-local AI member is required' using errcode='42501'; end if;
 if p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid page limit' using errcode='22023'; end if;
 with page as (
  select p.id,p.display_name,p.status from person p
  where p.org_id=install_org() and p.side='staff' and p.status in ('active','inactive') and (p_after is null or p.id>p_after)
  order by p.id limit p_limit+1
 ), items as (select * from page order by id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'name',i.display_name,
  'workEmail',(select nullif(btrim(x.work_email),'') from pulse_priv.person_private x where x.person_id=i.id and x.org_id=install_org()),
  'roles',coalesce((select jsonb_agg(distinct r.role_key) from role_assignment r where r.org_id=install_org() and r.person_id=i.id
   and r.role_key in ('admin','hr','leadership','finance','manager','pgs','head_pgs') and current_date between r.valid_from and coalesce(r.valid_to,'infinity')),'[]'::jsonb),
  'teams',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'name',u.name) order by u.name,u.id) from unit u where u.org_id=install_org()
   and u.kind in ('department','team','pod') and current_date between u.valid_from and coalesce(u.valid_to,'infinity') and exists(select 1 from role_assignment r
    where r.org_id=u.org_id and r.person_id=i.id and r.unit_id=u.id and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))),'[]'::jsonb),
  'active',i.status='active','link','/people/'||i.id) order by i.id) from items i),'[]'::jsonb),
  'nextCursor',case when (select count(*) from page)>p_limit then
   rtrim(translate(encode(convert_to((select id::text from items order by id desc limit 1),'UTF8'),'base64'),'+/','-_'),'=') end) into result; return result;
end $$;
revoke all on function pulse.service_my_tasks(uuid,text,text,text),pulse.service_people(uuid,text,uuid,int) from public;
grant execute on function pulse.service_my_tasks(uuid,text,text,text),pulse.service_people(uuid,text,uuid,int) to pulse_api;
-- migrate:down
drop function pulse.service_people(uuid,text,uuid,int);
drop function pulse.service_my_tasks(uuid,text,text,text);
