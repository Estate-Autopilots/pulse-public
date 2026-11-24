-- migrate:up
-- FIX-BILLING (BC-035, 19 Nov 2026): how many days a quotation stays valid is the company's own setting (Billing →
-- Settings), not a fixed 30: Willow Lane's printed terms say 7. A new quotation takes it (Billing, AI employees, the v1
-- API and service-key quotations, through service_quote_context's validDays); quotations already made keep their dates.
-- The default stays 30, so nothing changes for a company until it sets its own.
alter table pulse.erp_settings add column if not exists quote_valid_days int not null default 30
  constraint erp_settings_quote_valid_days_valid check (quote_valid_days between 1 and 365);

-- 1568's function, unchanged but for reading quote_valid_days and answering it as validDays.
create or replace function pulse.service_quote_context(p_key uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid:=current_org(); buyer jsonb; contact jsonb; owner_id uuid; salesperson jsonb; company jsonb; rounding boolean; valid_days int;
 items jsonb; cl client; party erp_party; hint jsonb; lead pulse_priv.acq_enquiry; existing erp_document;
begin
 if org is null or current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text or not exists(select 1 from pulse_priv.service_key
  where id=p_key and org_id=org and revoked_at is null and 'quotes.draft.create'=any(scopes)) then
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
 select s.company,s.round_total,s.quote_valid_days into company,rounding,valid_days from erp_settings s where s.org_id=org for share;
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
  'issueDate',(now() at time zone org_time_zone(org))::date,'validDays',coalesce(valid_days,30));
end $$;


-- migrate:down
-- Forward-only.
