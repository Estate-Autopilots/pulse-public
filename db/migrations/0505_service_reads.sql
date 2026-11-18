-- migrate:up
-- Explicit install-local projections; never confer a staff viewer or a table grant.
create function pulse.service_clients(p_key uuid,p_hash text,p_after uuid default null,p_limit int default 100) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb;
begin
 if service_key_auth(p_key,p_hash,'clients.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 if p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid page limit' using errcode='22023'; end if;
 with page as (
  select c.id,c.display_name,c.status,p.id owner_id,p.display_name owner_name
  from client c left join person p on p.org_id=c.org_id and p.id=c.relationship_owner_id and p.side='staff' and p.status='active'
  where c.org_id=install_org() and c.client_type<>'internal' and (p_after is null or c.id>p_after)
   and not exists(select 1 from record_merge m where m.org_id=c.org_id and m.entity_type='client' and m.gone_id=c.id and m.undone_at is null)
  order by c.id limit p_limit+1
 ), items as (select * from page order by id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
  'id',id,'name',display_name,'status',status,'salesperson',case when owner_id is not null then jsonb_build_object('id',owner_id,'name',owner_name) end
 ) order by id) from items),'[]'::jsonb),'nextCursor',case when (select count(*) from page)>p_limit then
  rtrim(translate(encode(convert_to((select id::text from items order by id desc limit 1),'UTF8'),'base64'),'+/','-_'),'=') end) into result;
 return result;
end $$;

create function pulse.service_leads(p_key uuid,p_hash text,p_after uuid default null,p_limit int default 100) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb;
begin
 if service_key_auth(p_key,p_hash,'leads.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 if p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid page limit' using errcode='22023'; end if;
 with page as (
  select l.id,l.occurred,p.id owner_id,p.display_name owner_name,coalesce(s.stage,'new') stage
  from pulse_priv.acq_enquiry l
  left join person p on p.org_id=l.org_id and p.id=l.owner_id and p.side='staff' and p.status='active'
  left join lateral (
   select t.stage from pulse_priv.acq_stage t where t.org_id=l.org_id and t.enquiry_id=l.id and t.reverses is null
   and not exists(select 1 from pulse_priv.acq_stage r where r.org_id=l.org_id and r.enquiry_id=l.id and r.reverses=t.id)
   order by t.effective desc,t.recorded desc,t.id desc limit 1
  ) s on true
  where l.org_id=install_org() and not l.withdrawn and not coalesce((l.body->>'test')::boolean,false)
   and (p_after is null or l.id>p_after)
  order by l.id limit p_limit+1
 ), items as (select * from page order by id limit p_limit)
 -- EST-1247 CTO decision (17 Oct 2026, interaction 011f6678): v1 names stay null; never reveal protected contact or source IDs.
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
  'id',id,'name',null::text,'stage',stage,'receivedAt',occurred,
  'salesperson',case when owner_id is not null then jsonb_build_object('id',owner_id,'name',owner_name) end
 ) order by id) from items),'[]'::jsonb),'nextCursor',case when (select count(*) from page)>p_limit then
  rtrim(translate(encode(convert_to((select id::text from items order by id desc limit 1),'UTF8'),'base64'),'+/','-_'),'=') end) into result;
 return result;
end $$;
revoke all on function pulse.service_clients(uuid,text,uuid,int),pulse.service_leads(uuid,text,uuid,int) from public;
grant execute on function pulse.service_clients(uuid,text,uuid,int),pulse.service_leads(uuid,text,uuid,int) to pulse_api;
-- migrate:down
-- Forward-only. Revoke service keys to remove access.
