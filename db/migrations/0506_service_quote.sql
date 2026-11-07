-- migrate:up
-- Service drafts keep ERP RLS, erp_can policies and pulse_api grants unchanged; only scoped definer functions cross the boundary.
alter table pulse.erp_document
 add column salesperson_id uuid references pulse.person(id), add column lead_id uuid,
 add column service_key_id uuid, add column request_key uuid, add column request_hash text, add column request_result jsonb,
 add column owner_approval text check(owner_approval in ('needed','approved')),
 add foreign key(org_id,lead_id) references pulse_priv.acq_enquiry(org_id,id),
 add unique(org_id,service_key_id,request_key);
alter table pulse.erp_line add column catalogue_rate bigint;

-- 'needed' while any line is not a catalogue item at its catalogue price (as drafted by the service, else the item's current price).
create function pulse.erp_quote_flag(p_doc uuid) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select case when exists(select 1 from erp_line l left join erp_item i on i.org_id=l.org_id and i.id=l.item_id
  where l.org_id=current_org() and l.document_id=p_doc and (l.item_id is null or l.rate is distinct from coalesce(l.catalogue_rate,i.price))) then 'needed' end
$$;
-- Only a changed flag writes the document (and its audit row); an approval is never undone.
create function pulse.erp_quote_sync(p_doc uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare flag text:=erp_quote_flag(p_doc);
begin
 update erp_document set owner_approval=flag where id=p_doc and org_id=current_org() and doc_type='quotation' and service_key_id is not null
  and status='draft' and owner_approval is distinct from flag and owner_approval is distinct from 'approved';
end $$;
create function pulse.erp_quote_lines() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if tg_op='INSERT' then perform erp_quote_sync(new.document_id);
 elsif tg_op='DELETE' then perform erp_quote_sync(old.document_id);
 else
  perform erp_quote_sync(new.document_id);
  if old.document_id<>new.document_id then perform erp_quote_sync(old.document_id); end if;
 end if;
 return null;
end $$;
create trigger erp_quote_lines after insert or update or delete on pulse.erp_line for each row execute function pulse.erp_quote_lines();

create function pulse.erp_quote_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if tg_op='INSERT' then
  -- Only a service key's own transaction records service provenance; the flag is derived from the lines, never written.
  if (new.service_key_id is null and (new.request_key is not null or new.request_hash is not null or new.request_result is not null))
   or (new.service_key_id is not null and current_setting('pulse.actor_account',true) is distinct from 'service:'||new.service_key_id::text) then
   raise exception 'Service provenance is recorded only by its service key' using errcode='42501'; end if;
  new.owner_approval:=null;
  return new;
 end if;
 if (new.service_key_id,new.request_key,new.request_hash,new.lead_id) is distinct from (old.service_key_id,old.request_key,old.request_hash,old.lead_id)
  or (old.service_key_id is not null and new.doc_type<>old.doc_type) or (old.request_result is not null and new.request_result is distinct from old.request_result) then
  raise exception 'Service quotation provenance is fixed' using errcode='22023'; end if;
 if old.service_key_id is null or old.doc_type<>'quotation' or old.status<>'draft' then new.owner_approval:=old.owner_approval; return new; end if;
 new.owner_approval:=erp_quote_flag(old.id);
 if new.status not in ('draft','cancelled') and new.owner_approval='needed' then
  if not viewer_is('leadership') then raise exception 'Owner approval needed: a price differs from the catalogue' using errcode='42501'; end if;
  new.owner_approval:='approved';
  perform erp_log('document',old.id,'owner_approved');
 end if;
 return new;
end $$;
create trigger erp_quote_guard before insert or update on pulse.erp_document for each row execute function pulse.erp_quote_guard();

-- Internal projection of the response; replay returns the stored copy, so a key never reads a document after creating it.
create function pulse.service_quote_result(p_id uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',d.id,'status','draft','number',null,'clientId',d.client_id,'leadId',d.lead_id,
 'salesperson',jsonb_build_object('id',p.id,'name',p.display_name),'ownerApprovalNeeded',coalesce(d.owner_approval='needed',false),
 'currency','INR','validUntil',d.valid_until,'taxable',d.taxable,'tax',d.cgst+d.sgst+d.igst,'total',d.total,'link','/quotes/'||d.id,
 'lines',(select jsonb_agg(jsonb_build_object('itemId',l.item_id,'name',l.description,'qty',l.qty,'rate',l.rate,
  'catalogueRate',l.catalogue_rate,'gstRate',l.gst_rate,'taxable',l.taxable,'tax',l.cgst+l.sgst+l.igst,'total',l.total) order by l.position)
  from erp_line l where l.org_id=d.org_id and l.document_id=d.id))
 from erp_document d join person p on p.org_id=d.org_id and p.id=d.salesperson_id where d.org_id=install_org() and d.id=p_id
$$;

-- p_key must be the key withServiceKey authenticated in this transaction (service_key_auth set the actor); the scope is re-checked here.
create function pulse.service_quote_context(p_key uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid:=install_org(); buyer jsonb; contact jsonb; owner_id uuid; salesperson jsonb; company jsonb; rounding boolean;
 items jsonb; cl client; party erp_party; hint jsonb; lead pulse_priv.acq_enquiry; existing erp_document;
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text or not exists(select 1 from pulse_priv.service_key
  where id=p_key and org_id=org and org_id=current_org() and revoked_at is null and 'quotes.draft.create'=any(scopes)) then
  raise exception 'Service scope required' using errcode='42501'; end if;
 perform set_config('pulse.viewer_id','',true);
 if exists(select 1 from tenant_config where org_id=org and doc_kind='tenant' and doc_key='modules' and is_active and body->'off' ? 'money') then
  raise exception 'Quotation unavailable' using errcode='P0002'; end if;
 if p_payload ? 'requestKey' then
  perform pg_advisory_xact_lock(hashtextextended('service-quote:'||org::text||p_key::text||(p_payload->>'requestKey'),0));
  select * into existing from erp_document where org_id=org and service_key_id=p_key and request_key=(p_payload->>'requestKey')::uuid;
  if found then
   if existing.request_hash is distinct from p_payload->>'requestHash' then raise exception 'Idempotency key already used with a different body' using errcode='23505'; end if;
   return jsonb_build_object('quote',existing.request_result,'existing',true);
  end if;
 end if;
 if (p_payload ? 'clientId')=(p_payload ? 'leadId') then raise exception 'Choose exactly one client or lead' using errcode='22023'; end if;
 select s.company,s.round_total into company,rounding from erp_settings s where s.org_id=org for share;
 if coalesce(company->>'stateCode','') !~ '^[0-9]{2}$' then raise exception 'Set the ERP company state first' using errcode='P0422'; end if;
 if p_payload ? 'clientId' then
  select * into cl from client where org_id=org and id=(p_payload->>'clientId')::uuid and client_type<>'internal' for share;
  if not found then raise exception 'Client unavailable' using errcode='P0002'; end if;
  owner_id:=cl.relationship_owner_id;
  select * into party from erp_party where org_id=org and client_id=cl.id;
  if found then buyer:=jsonb_build_object('name',party.legal_name,'gstin',party.gstin,'stateCode',party.state_code,'address',party.address,'email',party.email,'phone',party.phone,'contactName',party.contact_name);
  else
   -- buyerFor's fallback: the latest FIN-LIVE billing hint (erp_party_hints' first row), then the client/contact record.
   select jsonb_build_object('name',r.body->>'client','gstin',r.body->>'clientGstin') into hint from pulse_priv.finance_live_record r
    where r.org_id=org and r.kind='invoice' and coalesce(r.body->>'clientGstin','')<>'' and not coalesce((r.body->>'test')::boolean,false)
     and (value_key(r.body->>'client') in (select party_key from pulse_priv.money_party where org_id=org and client_id=cl.id and status<>'rejected') or value_client_of(r.body->>'client')=cl.id)
    order by r.body->>'date' desc limit 1;
   select jsonb_build_object('name',coalesce(hint->>'name',cl.company_name,cl.display_name),'gstin',hint->>'gstin',
    'address',case when cl.city is null then '[]'::jsonb else jsonb_build_array(cl.city) end,
    'email',coalesce(cp.email,cl.email),'phone',coalesce(cp.phone,cl.phone),'contactName',p.display_name) into buyer
    from (select 1) x left join person p on p.org_id=org and p.id=cl.primary_contact_id left join contact_profile cp on cp.org_id=org and cp.person_id=p.id;
  end if;
 else
  if exists(select 1 from tenant_config where org_id=org and doc_kind='tenant' and doc_key='modules' and is_active and body->'off' ? 'acquisition') then
   raise exception 'Lead unavailable' using errcode='P0002'; end if;
  select * into lead from pulse_priv.acq_enquiry where org_id=org and id=(p_payload->>'leadId')::uuid and not withdrawn and not coalesce((body->>'test')::boolean,false) for share;
  if not found then raise exception 'Lead unavailable' using errcode='P0002'; end if;
  owner_id:=lead.owner_id;
  -- The API decrypts only the enquirer's name from this protected contact; the buyer is {name}.
  select s.contact into contact from pulse_priv.acq_subject s where s.org_id=org and s.id=lead.subject_id;
  buyer:=jsonb_build_object('name','Lead');
 end if;
 select jsonb_build_object('id',p.id,'name',p.display_name) into salesperson from person p
  where p.org_id=org and p.id=coalesce((p_payload->>'salespersonId')::uuid,owner_id) and p.side='staff' and p.status='active' for share;
 if salesperson is null then raise exception 'An active staff salesperson is required' using errcode='P0422'; end if;
 if jsonb_typeof(p_payload->'lines') is distinct from 'array' or jsonb_array_length(p_payload->'lines') not between 1 and 50 then
  raise exception 'Add one to fifty catalogue lines' using errcode='22023'; end if;
 perform 1 from erp_item where org_id=org and id in(select (l->>'itemId')::uuid from jsonb_array_elements(p_payload->'lines') l) for share;
 select jsonb_agg(jsonb_build_object('id',i.id,'name',i.name,'sac',i.sac,'unit',i.unit,'price',i.price,'gstRate',i.gst_rate) order by l.n) into items
  from jsonb_array_elements(p_payload->'lines') with ordinality l(body,n) join erp_item i on i.org_id=org and i.id=(l.body->>'itemId')::uuid and i.status='active';
 if coalesce(jsonb_array_length(items),0)<>jsonb_array_length(p_payload->'lines') then raise exception 'Active catalogue item unavailable' using errcode='P0002'; end if;
 return jsonb_build_object('company',company,'roundTotal',rounding,'buyer',buyer,'leadContact',contact,'salesperson',salesperson,'items',items,
  'issueDate',(now() at time zone org_time_zone())::date);
end $$;

-- p_doc: {payload, context, fields, figures} from the API (@pulse/invoice-doc, as saveDraft); the context is re-derived and must match.
create function pulse.service_quote_create(p_key uuid,p_request uuid,p_request_hash text,p_doc jsonb) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare ctx jsonb; f jsonb:=p_doc->'fields'; fig jsonb:=p_doc->'figures'; payload jsonb:=p_doc->'payload'; target uuid; result jsonb; l jsonb; item jsonb; n int:=0;
begin
 if p_request is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'Request identity required' using errcode='22023'; end if;
 ctx:=service_quote_context(p_key,payload||jsonb_build_object('requestKey',p_request,'requestHash',p_request_hash));
 if ctx ? 'quote' then return ctx; end if;
 if ctx is distinct from p_doc->'context' then raise exception 'Quotation context changed; retry the request' using errcode='40001'; end if;
 if jsonb_array_length(fig->'lines')<>jsonb_array_length(payload->'lines') then raise exception 'Quotation lines changed' using errcode='22023'; end if;
 insert into erp_document(org_id,doc_type,client_id,lead_id,salesperson_id,service_key_id,request_key,request_hash,created_by,
  issue_date,valid_until,seller,buyer,place_of_supply,notes,round_total,tax_mode,taxable,cgst,sgst,igst,round_off,total,amount_words,template_id)
 values(install_org(),'quotation',(payload->>'clientId')::uuid,(payload->>'leadId')::uuid,(ctx->'salesperson'->>'id')::uuid,p_key,p_request,p_request_hash,null,
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
 perform erp_log('document',target,'created','{"from":"service_key"}');
 result:=service_quote_result(target);
 update erp_document set request_result=result where id=target and org_id=install_org();
 return jsonb_build_object('quote',result,'existing',false);
end $$;
revoke all on function pulse.erp_quote_flag(uuid),pulse.erp_quote_sync(uuid),pulse.erp_quote_lines(),pulse.erp_quote_guard(),pulse.service_quote_result(uuid),
 pulse.service_quote_context(uuid,jsonb),pulse.service_quote_create(uuid,uuid,text,jsonb) from public;
grant execute on function pulse.service_quote_context(uuid,jsonb),pulse.service_quote_create(uuid,uuid,text,jsonb) to pulse_api;
-- migrate:down
-- Forward-only: service provenance and approval receipts are retained.
