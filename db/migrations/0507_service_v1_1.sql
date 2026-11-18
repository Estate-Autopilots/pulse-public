-- migrate:up
-- Service contract 1.1 (EST-1294): exact phone lookup and the draft's source reference. No table grants.

-- The caller's source id (e.g. a Sales X-Ray analysis id); shown in ERP history, never printed.
alter table pulse.erp_document add column source_ref text check(char_length(source_ref) between 1 and 100);

-- Lead source scopes the API needs to rebuild `controller|path|phone:` aliases. Ids only, no contact data.
create function pulse.service_lead_scopes(p_key uuid,p_hash text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if service_key_auth(p_key,p_hash,'leads.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('controller',controller,'path',path) order by controller,path),'[]'::jsonb)
  from (select distinct controller::text controller,path from pulse_priv.acq_identity where org_id=install_org()) s);
end $$;

-- Exact match on the keyed digests (every key version); never decrypts contact data. Audit: key id + match count.
create function pulse.service_leads_by_phone(p_key uuid,p_hash text,p_aliases jsonb) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare matched int; result jsonb;
begin
 if service_key_auth(p_key,p_hash,'leads.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 if jsonb_typeof(p_aliases) is distinct from 'array' or jsonb_array_length(p_aliases)>64 then raise exception 'Invalid lookup' using errcode='22023'; end if;
 with subjects as (
  select distinct i.subject_id from pulse_priv.acq_identity i join jsonb_array_elements(p_aliases) a
   on i.controller::text=a->>'controller' and i.path=a->>'path' and i.key_version=a->>'version' and i.keyed=a->>'key'
  where i.org_id=install_org()
 ), found as (
  select l.id,l.occurred,p.id owner_id,p.display_name owner_name,coalesce(s.stage,'new') stage
  from pulse_priv.acq_enquiry l join subjects m on m.subject_id=l.subject_id
  left join person p on p.org_id=l.org_id and p.id=l.owner_id and p.side='staff' and p.status='active'
  left join lateral (
   select t.stage from pulse_priv.acq_stage t where t.org_id=l.org_id and t.enquiry_id=l.id and t.reverses is null
   and not exists(select 1 from pulse_priv.acq_stage r where r.org_id=l.org_id and r.enquiry_id=l.id and r.reverses=t.id)
   order by t.effective desc,t.recorded desc,t.id desc limit 1
  ) s on true
  where l.org_id=install_org() and not l.withdrawn and not coalesce((l.body->>'test')::boolean,false)
 ), items as (select * from found order by id limit 5)
 select (select count(*) from found), jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
  'id',id,'name',null::text,'stage',stage,'receivedAt',occurred,
  'salesperson',case when owner_id is not null then jsonb_build_object('id',owner_id,'name',owner_name) end
 ) order by id) from items),'[]'::jsonb),'nextCursor',null) into matched,result;
 perform audit_write('service_phone_lookup','leads',p_key::text,array['matches:'||matched]);
 return result;
end $$;

-- The stored client number under the same normaliser as the API (strip spaces/brackets/dots/dashes; 10 digits → +91).
create function pulse.service_clients_by_phone(p_key uuid,p_hash text,p_phone text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare matched int; result jsonb;
begin
 if service_key_auth(p_key,p_hash,'clients.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Invalid lookup' using errcode='22023'; end if;
 with found as (
  select c.id,c.display_name,c.status,p.id owner_id,p.display_name owner_name
  from (select *,regexp_replace(phone,'[\s().-]','','g') clean from client where org_id=install_org() and phone is not null) c
  left join person p on p.org_id=c.org_id and p.id=c.relationship_owner_id and p.side='staff' and p.status='active'
  where c.client_type<>'internal' and case when c.clean ~ '^[0-9]{10}$' then '+91'||c.clean else c.clean end=p_phone
   and not exists(select 1 from record_merge m where m.org_id=c.org_id and m.entity_type='client' and m.gone_id=c.id and m.undone_at is null)
 ), items as (select * from found order by id limit 5)
 select (select count(*) from found), jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
  'id',id,'name',display_name,'status',status,'salesperson',case when owner_id is not null then jsonb_build_object('id',owner_id,'name',owner_name) end
 ) order by id) from items),'[]'::jsonb),'nextCursor',null) into matched,result;
 perform audit_write('service_phone_lookup','clients',p_key::text,array['matches:'||matched]);
 return result;
end $$;
revoke all on function pulse.service_lead_scopes(uuid,text),pulse.service_leads_by_phone(uuid,text,jsonb),pulse.service_clients_by_phone(uuid,text,text) from public;
grant execute on function pulse.service_lead_scopes(uuid,text),pulse.service_leads_by_phone(uuid,text,jsonb),pulse.service_clients_by_phone(uuid,text,text) to pulse_api;
-- Replace the unmerged draft functions without changing their grants, ERP policies or PDF projection.
create or replace function pulse.service_quote_result(p_id uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',d.id,'status','draft','number',null,'clientId',d.client_id,'leadId',d.lead_id,
 'salesperson',jsonb_build_object('id',p.id,'name',p.display_name),'ownerApprovalNeeded',coalesce(d.owner_approval='needed',false),
 'currency','INR','validUntil',d.valid_until,'taxable',d.taxable,'tax',d.cgst+d.sgst+d.igst,'total',d.total,'link','/quotes/'||d.id,'sourceRef',d.source_ref,
 'lines',(select jsonb_agg(jsonb_build_object('itemId',l.item_id,'name',l.description,'qty',l.qty,'rate',l.rate,
  'catalogueRate',l.catalogue_rate,'gstRate',l.gst_rate,'taxable',l.taxable,'tax',l.cgst+l.sgst+l.igst,'total',l.total) order by l.position)
  from erp_line l where l.org_id=d.org_id and l.document_id=d.id))
 from erp_document d join person p on p.org_id=d.org_id and p.id=d.salesperson_id where d.org_id=install_org() and d.id=p_id
$$;

create or replace function pulse.service_quote_create(p_key uuid,p_request uuid,p_request_hash text,p_doc jsonb) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare ctx jsonb; f jsonb:=p_doc->'fields'; fig jsonb:=p_doc->'figures'; payload jsonb:=p_doc->'payload'; target uuid; result jsonb; l jsonb; item jsonb; n int:=0;
begin
 if p_request is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'Request identity required' using errcode='22023'; end if;
 ctx:=service_quote_context(p_key,payload||jsonb_build_object('requestKey',p_request,'requestHash',p_request_hash));
 if ctx ? 'quote' then return ctx; end if;
 if payload ? 'sourceRef' and (jsonb_typeof(payload->'sourceRef') is distinct from 'string' or char_length(payload->>'sourceRef') not between 1 and 100) then
  raise exception 'Invalid source reference' using errcode='22023'; end if;
 if ctx is distinct from p_doc->'context' then raise exception 'Quotation context changed; retry the request' using errcode='40001'; end if;
 if jsonb_array_length(fig->'lines')<>jsonb_array_length(payload->'lines') then raise exception 'Quotation lines changed' using errcode='22023'; end if;
 insert into erp_document(org_id,doc_type,client_id,lead_id,salesperson_id,service_key_id,request_key,request_hash,created_by,source_ref,
  issue_date,valid_until,seller,buyer,place_of_supply,notes,round_total,tax_mode,taxable,cgst,sgst,igst,round_off,total,amount_words,template_id)
 values(install_org(),'quotation',(payload->>'clientId')::uuid,(payload->>'leadId')::uuid,(ctx->'salesperson'->>'id')::uuid,p_key,p_request,p_request_hash,null,payload->>'sourceRef',
  (ctx->>'issueDate')::date,(f->>'validUntil')::date,ctx->'company',f->'buyer',fig->>'placeOfSupply',coalesce(payload->>'notes',''),(ctx->>'roundTotal')::boolean,
  fig->>'mode',(fig->>'taxable')::bigint,(fig->>'cgst')::bigint,(fig->>'sgst')::bigint,(fig->>'igst')::bigint,(fig->>'roundOff')::bigint,(fig->>'total')::bigint,fig->>'words',
  (select template_id from erp_template_default where org_id=install_org() and doc_type='quotation')) returning id into target;
 for l in select value from jsonb_array_elements(fig->'lines') loop
  item:=ctx->'items'->n;
  insert into erp_line(org_id,document_id,position,item_id,description,details,sac,unit,qty,rate,catalogue_rate,gst_rate,taxable,cgst,sgst,igst,total)
  values(install_org(),target,n,(item->>'id')::uuid,item->>'name',coalesce(payload->'lines'->n->>'details',''),item->>'sac',item->>'unit',
   (payload->'lines'->n->>'qty')::numeric,coalesce((payload->'lines'->n->>'rate')::bigint,(item->>'price')::bigint),(item->>'price')::bigint,
   (item->>'gstRate')::numeric,(l->>'taxable')::bigint,(l->>'cgst')::bigint,(l->>'sgst')::bigint,(l->>'igst')::bigint,(l->>'total')::bigint);
  n:=n+1;
 end loop;
 perform audit_write('service_quote_create','erp_document',target::text);
 perform erp_log('document',target,'created',jsonb_strip_nulls(jsonb_build_object('from','service_key','sourceRef',payload->>'sourceRef')));
 result:=service_quote_result(target);
 update erp_document set request_result=result where id=target and org_id=install_org();
 return jsonb_build_object('quote',result,'existing',false);
end $$;
-- migrate:down
-- Forward-only. Revoke service keys to remove access.
