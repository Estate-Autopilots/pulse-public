-- migrate:up
-- WAS-KEYS (5 Nov 2026). Willow Lane moved onto the shared Pulse (WL-MOVE, app.vitalsos.ai) and its connected app (WAS)
-- was refused: a psvc_ service key was looked up only in the install's own organisation (0504/0700), so a hosted
-- company's key answered "invalid". Now a key is found by its id in its OWN organisation and binds the request there:
--   * the install's keys, as before, from anywhere the API already lets a service key in;
--   * a key of the request's organisation (current_org());
--   * on the shared address only (the API sets pulse.service_key_reach = '1' around the key lookup and clears it
--     straight after, as SELF-SERVE's pulse.shared_address in 1521), a key of any organisation, found by its exact id.
-- The organisation becomes the key's (pulse.org_id), exactly as the install's keys did with install_org(); every
-- service function below then reads and writes current_org() only, never install_org(), so a key reaches its own
-- company's rows and nothing else. The operator's install-level key list and issue (service_key_list/manage) stay as
-- they are. Same scopes, expiry, revocation and AI-member checks as before.

-- The lookup sees one row by its exact id, only while service_key_bind looks it up (the GUC is set and cleared there).
-- No service role has rights on pulse_priv.service_key; only the schema owner's definer functions read it.
create policy service_key_find on pulse_priv.service_key for select
  using (id::text = coalesce(current_setting('pulse.service_key_find', true), ''));

create function pulse.service_key_bind(p_id uuid) returns pulse_priv.service_key
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k pulse_priv.service_key; o uuid; prior text := coalesce(current_setting('pulse.org_id', true), '');
begin
 if p_id is null then return null; end if;
 perform set_config('pulse.service_key_find', p_id::text, true);
 select org_id into o from pulse_priv.service_key where id = p_id;
 perform set_config('pulse.service_key_find', '', true);
 -- Null-safe on purpose: with no organisation set (a fresh service request) only the install's keys or the reach flag bind.
 if o is null or (o is distinct from install_org() and o is distinct from current_org()
   and coalesce(current_setting('pulse.service_key_reach', true), '') <> '1') then
  return null; end if;
 perform set_config('pulse.org_id', o::text, true);
 select * into k from pulse_priv.service_key where org_id = o and id = p_id
  and revoked_at is null and (expires_at is null or expires_at > now());
 if k.id is null then perform set_config('pulse.org_id', prior, true); return null; end if;
 return k;
end $$;
revoke all on function pulse.service_key_bind(uuid) from public;

create or replace function pulse.service_key_hash(p_id uuid) returns text
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k pulse_priv.service_key := service_key_bind(p_id);
begin
 return k.key_hash;
end $$;

create or replace function pulse.service_key_auth(p_id uuid,p_hash text,p_scope text) returns boolean
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k pulse_priv.service_key := service_key_bind(p_id);
begin
 if k.id is null then return false; end if;
 select * into k from pulse_priv.service_key where org_id=current_org() and id=p_id and key_hash=p_hash
  and revoked_at is null and (expires_at is null or expires_at>now()) for update;
 if not found or p_scope is null or not(p_scope=any(k.scopes)) then return false; end if;
 perform set_config('pulse.actor_account','service:'||p_id::text,true);
 update pulse_priv.service_key set last_used_at=now() where org_id=current_org() and id=p_id and (last_used_at is null or last_used_at<=now()-interval '1 minute');
 return true;
end $$;

-- catalog_projection() stays the install's (offers and catalogue keys use it); the service read projects its own company.
create or replace function pulse.service_key_catalog(p_id uuid) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_id::text or not exists(
  select 1 from pulse_priv.service_key where id=p_id and org_id=current_org()
   and revoked_at is null and 'catalog.read'=any(scopes)) then raise exception 'Service scope required' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'name',i.name,'description',i.description,
  'price',i.price,'currency','INR','taxRate',i.gst_rate,'publicLink',case when o.token is not null then '/api/v1/catalog/offers/'||o.token end)
  order by i.name,i.id),'[]'::jsonb)
  from erp_item i left join pulse_priv.catalog_offer o on o.org_id=i.org_id and o.item_id=i.id
  where i.org_id=current_org() and i.status='active');
end $$;

create or replace function pulse.service_clients(p_key uuid, p_hash text, p_after uuid default null, p_limit int default 100) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb;
begin
 if service_key_auth(p_key,p_hash,'clients.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 if p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid page limit' using errcode='22023'; end if;
 with page as (
  select c.id,c.display_name,c.status,p.id owner_id,p.display_name owner_name
  from client c left join person p on p.org_id=c.org_id and p.id=c.relationship_owner_id and p.side='staff' and p.status='active'
  where c.org_id=current_org() and c.client_type<>'internal' and (p_after is null or c.id>p_after)
   and not exists(select 1 from record_merge m where m.org_id=c.org_id and m.entity_type='client' and m.gone_id=c.id and m.undone_at is null)
  order by c.id limit p_limit+1
 ), items as (select * from page order by id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
  'id',id,'name',display_name,'status',status,'salesperson',case when owner_id is not null then jsonb_build_object('id',owner_id,'name',owner_name) end
 ) order by id) from items),'[]'::jsonb),'nextCursor',case when (select count(*) from page)>p_limit then
  rtrim(translate(encode(convert_to((select id::text from items order by id desc limit 1),'UTF8'),'base64'),'+/','-_'),'=') end) into result;
 return result;
end $$;

create or replace function pulse.service_clients_by_phone(p_key uuid, p_hash text, p_phone text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare matched int; result jsonb;
begin
 if service_key_auth(p_key,p_hash,'clients.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Invalid lookup' using errcode='22023'; end if;
 with found as (
  select c.id,c.display_name,c.status,p.id owner_id,p.display_name owner_name
  from (select *,regexp_replace(phone,'[\s().-]','','g') clean from client where org_id=current_org() and phone is not null) c
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

create or replace function pulse.service_lead_scopes(p_key uuid, p_hash text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if service_key_auth(p_key,p_hash,'leads.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('controller',controller,'path',path) order by controller,path),'[]'::jsonb)
  from (select distinct controller::text controller,path from pulse_priv.acq_identity where org_id=current_org()) s);
end $$;

create or replace function pulse.service_leads(p_key uuid, p_hash text, p_after uuid default null, p_limit int default 100) returns jsonb
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
  where l.org_id=current_org() and not l.withdrawn and not coalesce((l.body->>'test')::boolean,false)
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

create or replace function pulse.service_leads_by_phone(p_key uuid, p_hash text, p_aliases jsonb) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare matched int; result jsonb;
begin
 if service_key_auth(p_key,p_hash,'leads.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 if jsonb_typeof(p_aliases) is distinct from 'array' or jsonb_array_length(p_aliases)>64 then raise exception 'Invalid lookup' using errcode='22023'; end if;
 with subjects as (
  select distinct i.subject_id from pulse_priv.acq_identity i join jsonb_array_elements(p_aliases) a
   on i.controller::text=a->>'controller' and i.path=a->>'path' and i.key_version=a->>'version' and i.keyed=a->>'key'
  where i.org_id=current_org()
 ), found as (
  select l.id,l.occurred,p.id owner_id,p.display_name owner_name,coalesce(s.stage,'new') stage
  from pulse_priv.acq_enquiry l join subjects m on m.subject_id=l.subject_id
  left join person p on p.org_id=l.org_id and p.id=l.owner_id and p.side='staff' and p.status='active'
  left join lateral (
   select t.stage from pulse_priv.acq_stage t where t.org_id=l.org_id and t.enquiry_id=l.id and t.reverses is null
   and not exists(select 1 from pulse_priv.acq_stage r where r.org_id=l.org_id and r.enquiry_id=l.id and r.reverses=t.id)
   order by t.effective desc,t.recorded desc,t.id desc limit 1
  ) s on true
  where l.org_id=current_org() and not l.withdrawn and not coalesce((l.body->>'test')::boolean,false)
 ), items as (select * from found order by id limit 5)
 select (select count(*) from found), jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
  'id',id,'name',null::text,'stage',stage,'receivedAt',occurred,
  'salesperson',case when owner_id is not null then jsonb_build_object('id',owner_id,'name',owner_name) end
 ) order by id) from items),'[]'::jsonb),'nextCursor',null) into matched,result;
 perform audit_write('service_phone_lookup','leads',p_key::text,array['matches:'||matched]);
 return result;
end $$;

create or replace function pulse.service_my_tasks(p_key uuid, p_hash text, p_iss text, p_sub text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid;tz text;result jsonb;
begin
 if service_key_auth(p_key,p_hash,'tasks.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 perform k.id from pulse_priv.service_key k join agent_member a on a.person_id=k.agent_id join person p on p.id=a.person_id
  where k.id=p_key and k.org_id=current_org() and a.org_id=k.org_id and a.disabled_at is null
   and p.org_id=k.org_id and p.side='agent' and p.status='active' for share of k,a,p;
 if not found then raise exception 'An active install-local AI member is required' using errcode='42501'; end if;
 -- Not a sign-in (`used` false). Contract §6: the audit holds the key id (the service actor) and the person id, never the token.
 me:=(google_identity_resolve(p_iss,p_sub,false)->>'personId')::uuid;
 if me is null then return jsonb_build_object('error','person_not_linked'); end if;
 perform audit_write('service_tasks_read','person',me::text,array['key:'||p_key::text]);
 tz:=org_time_zone(current_org());
 with mine as (
  select t.id,t.title,case when t.status='unknown' then 'open' else t.status end status,t.due_at,
   t.status in ('open','in_progress','blocked') and t.due_at between now() and now()+interval '24 hours' due_soon
  from task t where t.org_id=current_org() and coalesce(t.assignee_person_id,t.owner_id)=me and t.deleted_at is null
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

create or replace function pulse.service_people(p_key uuid, p_hash text, p_after uuid default null, p_limit int default 100) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb;
begin
 if service_key_auth(p_key,p_hash,'people.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 perform k.id from pulse_priv.service_key k join agent_member a on a.person_id=k.agent_id join person p on p.id=a.person_id
  where k.id=p_key and k.org_id=current_org() and a.org_id=k.org_id and a.disabled_at is null
   and p.org_id=k.org_id and p.side='agent' and p.status='active' for share of k,a,p;
 if not found then raise exception 'An active install-local AI member is required' using errcode='42501'; end if;
 if p_limit is null or p_limit not between 1 and 200 then raise exception 'Invalid page limit' using errcode='22023'; end if;
 with page as (
  select p.id,p.display_name,p.status from person p
  where p.org_id=current_org() and p.side='staff' and p.status in ('active','inactive') and (p_after is null or p.id>p_after)
  order by p.id limit p_limit+1
 ), items as (select * from page order by id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'name',i.display_name,
  'workEmail',(select nullif(btrim(x.work_email),'') from pulse_priv.person_private x where x.person_id=i.id and x.org_id=current_org()),
  'roles',coalesce((select jsonb_agg(distinct r.role_key) from role_assignment r where r.org_id=current_org() and r.person_id=i.id
   and r.role_key in ('admin','hr','leadership','finance','manager','pgs','head_pgs') and current_date between r.valid_from and coalesce(r.valid_to,'infinity')),'[]'::jsonb),
  'teams',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'name',u.name) order by u.name,u.id) from unit u where u.org_id=current_org()
   and u.kind in ('department','team','pod') and current_date between u.valid_from and coalesce(u.valid_to,'infinity') and exists(select 1 from role_assignment r
    where r.org_id=u.org_id and r.person_id=i.id and r.unit_id=u.id and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))),'[]'::jsonb),
  'active',i.status='active','link','/people/'||i.id) order by i.id) from items i),'[]'::jsonb),
  'nextCursor',case when (select count(*) from page)>p_limit then
   rtrim(translate(encode(convert_to((select id::text from items order by id desc limit 1),'UTF8'),'base64'),'+/','-_'),'=') end) into result; return result;
end $$;

create or replace function pulse.service_quote_context(p_key uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid:=current_org(); buyer jsonb; contact jsonb; owner_id uuid; salesperson jsonb; company jsonb; rounding boolean;
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
  'issueDate',(now() at time zone org_time_zone(org))::date);
end $$;

create or replace function pulse.service_quote_create(p_key uuid, p_request uuid, p_request_hash text, p_doc jsonb) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare ctx jsonb; f jsonb:=p_doc->'fields'; fig jsonb:=p_doc->'figures'; payload jsonb:=p_doc->'payload'; target uuid; result jsonb; l jsonb; item jsonb; n int:=0;
begin
 if p_request is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then raise exception 'Request identity required' using errcode='22023'; end if;
 -- service_quote_context checks the key against this transaction's actor in current_org() (the key's own company).
 ctx:=service_quote_context(p_key,payload||jsonb_build_object('requestKey',p_request,'requestHash',p_request_hash));
 if ctx ? 'quote' then return ctx; end if;
 if payload ? 'sourceRef' and (jsonb_typeof(payload->'sourceRef') is distinct from 'string' or char_length(payload->>'sourceRef') not between 1 and 100) then
  raise exception 'Invalid source reference' using errcode='22023'; end if;
 if ctx is distinct from p_doc->'context' then raise exception 'Quotation context changed; retry the request' using errcode='40001'; end if;
 if jsonb_array_length(fig->'lines')<>jsonb_array_length(payload->'lines') then raise exception 'Quotation lines changed' using errcode='22023'; end if;
 insert into erp_document(org_id,doc_type,client_id,lead_id,salesperson_id,service_key_id,request_key,request_hash,created_by,source_ref,
  issue_date,valid_until,seller,buyer,place_of_supply,notes,round_total,tax_mode,taxable,cgst,sgst,igst,round_off,total,amount_words,template_id)
 values(current_org(),'quotation',(payload->>'clientId')::uuid,(payload->>'leadId')::uuid,(ctx->'salesperson'->>'id')::uuid,p_key,p_request,p_request_hash,null,payload->>'sourceRef',
  (ctx->>'issueDate')::date,(f->>'validUntil')::date,ctx->'company',f->'buyer',fig->>'placeOfSupply',coalesce(payload->>'notes',''),(ctx->>'roundTotal')::boolean,
  fig->>'mode',(fig->>'taxable')::bigint,(fig->>'cgst')::bigint,(fig->>'sgst')::bigint,(fig->>'igst')::bigint,(fig->>'roundOff')::bigint,(fig->>'total')::bigint,fig->>'words',
  (select template_id from erp_template_default where org_id=current_org() and doc_type='quotation')) returning id into target;
 for l in select value from jsonb_array_elements(fig->'lines') loop
  item:=ctx->'items'->n;
  insert into erp_line(org_id,document_id,position,item_id,description,details,sac,unit,qty,rate,catalogue_rate,gst_rate,taxable,cgst,sgst,igst,total)
  values(current_org(),target,n,(item->>'id')::uuid,item->>'name',coalesce(payload->'lines'->n->>'details',''),item->>'sac',item->>'unit',
   (payload->'lines'->n->>'qty')::numeric,coalesce((payload->'lines'->n->>'rate')::bigint,(item->>'price')::bigint),(item->>'price')::bigint,
   (item->>'gstRate')::numeric,(l->>'taxable')::bigint,(l->>'cgst')::bigint,(l->>'sgst')::bigint,(l->>'igst')::bigint,(l->>'total')::bigint);
  n:=n+1;
 end loop;
 perform audit_write('service_quote_create','erp_document',target::text);
 perform erp_log('document',target,'created',jsonb_strip_nulls(jsonb_build_object('from','service_key','sourceRef',payload->>'sourceRef')));
 result:=service_quote_result(target);
 update erp_document set request_result=result where id=target and org_id=current_org();
 return jsonb_build_object('quote',result,'existing',false);
end $$;

create or replace function pulse.service_quote_notify(p_key uuid, p_hash text, p_doc uuid) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d erp_document; title text; notified timestamptz; nid uuid; n int;
begin
 if current_org() is null or current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text
  or not exists(select 1 from pulse_priv.service_key where org_id=current_org() and id=p_key and key_hash=p_hash
   and revoked_at is null and 'notify.quote_ready'=any(scopes)) then
  raise exception 'Service scope required' using errcode='42501'; end if;
 if exists(select 1 from tenant_config where org_id=current_org() and doc_kind='tenant' and doc_key='modules'
  and is_active and body->'off' ? 'money') then raise exception 'Quotation unavailable' using errcode='P0002'; end if;
 select * into d from erp_document where org_id=current_org() and id=p_doc and doc_type='quotation'
  and status='draft' and service_key_id is not null for update;
 if not found then raise exception 'Quotation unavailable' using errcode='P0002'; end if;
 if d.ready_notified_at is not null then
  return jsonb_build_object('id',d.id,'notifiedAt',d.ready_notified_at,'repeat',true); end if;
 select count(*) into n from erp_line where org_id=current_org() and document_id=d.id;
 title:='Quotation ready for '||quote_party_label(d.id)||': '||n||' item(s), INR '||(d.total::numeric/100)::numeric(24,2)::text
  ||case when d.owner_approval='needed' then ' · owner approval needed' else '' end;
 nid:=notification_emit(d.salesperson_id,'quote_ready','erp_document',d.id,'quote_ready:'||d.id,title,'/quotes/'||d.id,'update',true);
 if nid is null then raise exception 'Active salesperson unavailable' using errcode='P0002'; end if;
 notified:=clock_timestamp();
 update erp_document set ready_notified_at=notified where org_id=current_org() and id=d.id;
 perform audit_write('service_quote_notify','erp_document',d.id::text);
 return jsonb_build_object('id',d.id,'notifiedAt',notified,'repeat',false);
end $$;

create or replace function pulse.service_quote_result(p_id uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',d.id,'status','draft','number',null,'clientId',d.client_id,'leadId',d.lead_id,
 'salesperson',jsonb_build_object('id',p.id,'name',p.display_name),'ownerApprovalNeeded',coalesce(d.owner_approval='needed',false),
 'currency','INR','validUntil',d.valid_until,'taxable',d.taxable,'tax',d.cgst+d.sgst+d.igst,'total',d.total,'link','/quotes/'||d.id,'sourceRef',d.source_ref,
 'lines',(select jsonb_agg(jsonb_build_object('itemId',l.item_id,'name',l.description,'qty',l.qty,'rate',l.rate,
  'catalogueRate',l.catalogue_rate,'gstRate',l.gst_rate,'taxable',l.taxable,'tax',l.cgst+l.sgst+l.igst,'total',l.total) order by l.position)
  from erp_line l where l.org_id=d.org_id and l.document_id=d.id))
 from erp_document d join person p on p.org_id=d.org_id and p.id=d.salesperson_id where d.org_id=current_org() and d.id=p_id
$$;

create or replace function pulse.service_chat_post(p_key uuid, p_channel uuid, p_slot text, p_text text, p_name text, p_mime text, p_bytes bytea) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare agent uuid; cid uuid; mid uuid; fid uuid; prior chat_message; files jsonb:='[]';
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text then
  raise exception 'Service scope required' using errcode='42501'; end if;
 select k.agent_id into agent from pulse_priv.service_key k join agent_member a on a.person_id=k.agent_id join person p on p.id=a.person_id
  where k.id=p_key and k.org_id=current_org() and k.revoked_at is null and 'chats.post'=any(k.scopes)
   and a.org_id=k.org_id and a.disabled_at is null and p.org_id=k.org_id and p.side='agent' and p.status='active' for share of k,a,p;
 if agent is null then raise exception 'Active AI member and chat scope required' using errcode='42501'; end if;
 if p_slot is null or p_slot !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-(am|pm)$' or left(p_slot,10)::date::text<>left(p_slot,10)
  or p_text is null or length(trim(p_text)) not between 1 and 12000 then raise exception 'Invalid slot or text' using errcode='22023'; end if;
 if p_bytes is not null then
  if not coalesce(length(p_name) between 1 and 200 and octet_length(p_bytes) between 1 and 2097152 and
   ((p_mime='image/png' and substring(p_bytes from 1 for 8)=decode('89504e470d0a1a0a','hex')) or
    (p_mime='image/jpeg' and substring(p_bytes from 1 for 3)=decode('ffd8ff','hex'))),false)
   then raise exception 'Use a PNG or JPEG image up to 2 MiB' using errcode='22023'; end if;
 elsif p_name is not null or p_mime is not null then raise exception 'Image bytes required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('chats.post:'||agent||':'||p_slot,0));
 cid:=substr(encode(sha256(convert_to('chats.post:'||agent||':'||p_slot,'UTF8')),'hex'),1,32)::uuid;
 perform set_config('pulse.viewer_id',agent::text,true);
 perform set_config('pulse.agent_session','on',true);
 -- Membership is checked even on replay, including after the AI member has been removed.
 if not chat_has(p_channel) then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 select * into prior from chat_message where org_id=current_org() and author_id=agent and client_id=cid;
 if found then
  if prior.channel_id<>p_channel or prior.body<>trim(p_text) or
   (p_bytes is null and prior.attachments<>'[]'::jsonb) or (p_bytes is not null and not exists(
    select 1 from pulse_priv.chat_file f where f.id=(prior.attachments->0->>'id')::uuid and f.org_id=current_org()
     and f.channel_id=p_channel and f.person_id=agent and f.name=p_name and f.mime=p_mime and f.bytes=p_bytes)) then
   raise exception 'Slot already used for another message' using errcode='23505'; end if;
  mid:=prior.id;
 else
  if p_bytes is not null then
   fid:=chat_file_add(p_channel,p_name,p_mime,p_bytes);
   files:=jsonb_build_array(jsonb_build_object('id',fid,'name',p_name));
  end if;
  mid:=chat_send(p_channel,p_text,null,files,cid,null);
 end if;
 return jsonb_build_object('messageId',mid,'chatId',p_channel,'replayed',prior.id is not null);
end $$;

create or replace function pulse.service_update_post(p_key uuid, p_slot text, p_headline text, p_sections jsonb, p_audience uuid[], p_on_behalf uuid) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare label text; prior update_post; uid uuid; recipients uuid[];
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text then
  raise exception 'Service scope required' using errcode='42501'; end if;
 select k.label into label from pulse_priv.service_key k where k.id=p_key and k.org_id=current_org()
  and k.revoked_at is null and 'updates.post'=any(k.scopes) for share;
 if label is null then raise exception 'Updates scope required' using errcode='42501'; end if;
 if p_audience is null or cardinality(p_audience) not between 1 and 50 or array_position(p_audience,null) is not null then
  raise exception 'Choose one to fifty recipients' using errcode='22023'; end if;
 select array_agg(distinct id order by id) into recipients from unnest(p_audience) id;
 -- Lock memberships through commit, including on replay. Human staff use side=staff in this schema.
 perform 1 from person where id=any(recipients||p_on_behalf) and org_id=current_org() and side='staff' and status='active' for share;
 if p_on_behalf is null or exists(select 1 from unnest(recipients||p_on_behalf) candidate(id) where not exists(
  select 1 from person p where p.id=candidate.id and p.org_id=current_org() and p.side='staff' and p.status='active')) then
  raise exception 'Audience and sender must be active install staff' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('updates.post:'||p_on_behalf||':'||p_slot,0));
 select * into prior from update_post where org_id=current_org() and on_behalf_id=p_on_behalf and slot=p_slot;
 if found then
  if prior.headline is distinct from p_headline or prior.sections is distinct from p_sections or prior.audience<>recipients then
   raise exception 'Slot already used for another update' using errcode='23505'; end if;
  uid:=prior.id;
 else
  insert into update_post(org_id,slot,headline,sections,service_key_id,poster_label,on_behalf_id,audience)
   values(current_org(),p_slot,p_headline,p_sections,p_key,label,p_on_behalf,recipients) returning id into uid;
 end if;
 return jsonb_build_object('updateId',uid,'replayed',prior.id is not null);
end $$;

create or replace function pulse.service_update_request_create(p_key uuid, p_ref text, p_asked_by uuid, p_on_behalf uuid, p_source text, p_text text, p_asked_at timestamptz) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare prior update_request; rid uuid;
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text then
  raise exception 'Service scope required' using errcode='42501'; end if;
 perform 1 from pulse_priv.service_key k where k.id=p_key and k.org_id=current_org()
  and k.revoked_at is null and 'updates.requests.manage'=any(k.scopes) for share;
 if not found then raise exception 'Requests scope required' using errcode='42501'; end if;
 perform 1 from person where id in (p_asked_by,p_on_behalf) and org_id=current_org() and side='staff' and status='active' for share;
 if p_asked_by is null or p_on_behalf is null or exists(select 1 from unnest(array[p_asked_by,p_on_behalf]) candidate(id) where not exists(
  select 1 from person p where p.id=candidate.id and p.org_id=current_org() and p.side='staff' and p.status='active')) then
  raise exception 'Participants must be active install staff' using errcode='42501'; end if;
 if p_source is null or p_source not in ('task','chat','manual') then raise exception 'Invalid source' using errcode='22023'; end if;
 -- Validate timestamps before replay comparison, so invalid input is always 400.
 if p_asked_at>now() then raise exception 'askedAt cannot be in the future' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('update_requests:'||p_ref,0));
 select * into prior from update_request where org_id=current_org() and client_ref=p_ref;
 if found then
  if prior.asked_by is distinct from p_asked_by or prior.on_behalf_id is distinct from p_on_behalf or prior.source is distinct from p_source
   or prior.text is distinct from trim(p_text) or prior.asked_at is distinct from coalesce(p_asked_at,prior.asked_at) then
   raise exception 'Reference already used for another request' using errcode='23505'; end if;
  rid:=prior.id;
 else
  insert into update_request(org_id,asked_by,on_behalf_id,text,asked_at,source,client_ref,service_key_id)
   values(current_org(),p_asked_by,p_on_behalf,trim(p_text),coalesce(p_asked_at,now()),p_source,p_ref,p_key) returning id into rid;
 end if;
 return jsonb_build_object('request',update_request_view(rid))||case when prior.id is not null then jsonb_build_object('replayed',true) else '{}'::jsonb end;
end $$;

create or replace function pulse.service_update_request_list(p_key uuid, p_status text, p_on_behalf uuid, p_cursor uuid, p_limit int) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare items jsonb; cursor_id uuid; has_more boolean;
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text then
  raise exception 'Service scope required' using errcode='42501'; end if;
 perform 1 from pulse_priv.service_key k where k.id=p_key and k.org_id=current_org()
  and k.revoked_at is null and 'updates.requests.manage'=any(k.scopes) for share;
 if not found then raise exception 'Requests scope required' using errcode='42501'; end if;
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid limit' using errcode='22023'; end if;
 with page as (select r.id,r.asked_at from update_request r where r.org_id=current_org()
  and (p_status is null or r.status=p_status) and (p_on_behalf is null or r.on_behalf_id=p_on_behalf)
  and (p_cursor is null or (r.asked_at,r.id)<(select asked_at,id from update_request where id=p_cursor and org_id=current_org()))
  order by r.asked_at desc,r.id desc limit p_limit+1), numbered as (
  select *,row_number() over(order by asked_at desc,id desc) n from page)
 select coalesce(jsonb_agg(update_request_view(id) order by asked_at desc,id desc) filter(where n<=p_limit),'[]'::jsonb),
  (array_agg(id order by asked_at desc,id desc))[p_limit],count(*)>p_limit into items,cursor_id,has_more from numbered;
 return jsonb_build_object('items',items,'nextCursor',case when has_more then cursor_id else null end);
end $$;

create or replace function pulse.service_update_request_set(p_key uuid, p_id uuid, p_status text, p_progress int, p_note text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text then
  raise exception 'Service scope required' using errcode='42501'; end if;
 perform 1 from pulse_priv.service_key k where k.id=p_key and k.org_id=current_org()
  and k.revoked_at is null and 'updates.requests.manage'=any(k.scopes) for share;
 if not found then raise exception 'Requests scope required' using errcode='42501'; end if;
 if p_status is null and p_progress is null and p_note is null then raise exception 'Choose a change' using errcode='22023'; end if;
 update update_request set status=coalesce(p_status,status),progress=coalesce(p_progress,progress),note=coalesce(p_note,note),updated_at=now()
  where id=p_id and org_id=current_org();
 if not found then raise exception 'Request unavailable' using errcode='P0002'; end if;
 return update_request_view(p_id);
end $$;

-- API v1's psvc_ principal: still refused on another company's own address; on the shared address the key binds its own
-- company (service_key_auth above), and the bound AI member is checked there.
create or replace function pulse.v1_service_principal(p_id uuid, p_hash text, p_scope text) returns uuid
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare agent uuid;
begin
  if current_viewer() is not null or current_org() is distinct from install_org() or p_scope is null or not(p_scope = any(v1_scopes()))
     or not service_key_auth(p_id, p_hash, p_scope) then return null; end if;
  select k.agent_id into agent from pulse_priv.service_key k join agent_member a on a.person_id = k.agent_id join person p on p.id = a.person_id
   where k.id = p_id and k.org_id = current_org() and k.revoked_at is null and p_scope = any(k.scopes)
     and a.org_id = k.org_id and a.disabled_at is null and p.org_id = k.org_id and p.side = 'agent' and p.status = 'active' for share of k, a, p;
  if agent is not null then
    perform set_config('pulse.viewer_id', agent::text, true);
    perform set_config('pulse.agent_session', 'on', true);
    if agent_session() = agent then return agent; end if;
  end if;
  perform set_config('pulse.viewer_id', '', true);
  perform set_config('pulse.agent_session', '', true);
  perform set_config('pulse.actor_account', '', true);
  return null;
end $$;

-- migrate:down
-- Forward-only, like 0700: the earlier definitions read install_org(); revoke a key to remove its access.
