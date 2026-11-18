-- migrate:up
-- COMPANIES-MODEL (owner, 16 Nov 2026: "What is a client? What is a company? Most of the time the contract is with a
-- company; a freelancer contracts with a company. There is no database for companies." and "When I was adding clients
-- and contacts it was asking who is the contact: developer, etc."). One model:
--
--   Company   an organisation in the world (a builder, an agency, a brand, a shop). It has people (contacts), one main
--             contact, and through its client record its projects, quotes, invoices and contracts. It may have its own
--             Pulse account: pulse_org_id links it (found in the directory, or an invite it accepted later).
--   Contact   a person outside the team (pulse.person + pulse.contact_profile, as before). company_id: where they work.
--   Client    a relationship, not a kind of record: pulse.client stays the record projects, quotes, invoices, the client
--             portal and renewals hang off, and now says WHO the client is: a company (client.company_id) or one
--             person (entity_kind 'person', primary_contact_id). Vendor and partner are relationships too (company.is_vendor,
--             company.is_partner).
--
--  * Old concepts merged into this one: party_org (0001) and legal_organization / organization_contact (00452) never held
--    a row in production (16 Nov 2026 counts: 0 in every company) and are left unused; "company name" on a client
--    becomes its company; "primary contact" of a client becomes the company's main contact.
--  * Words: a company with no industry, or one outside real estate, is no longer offered Developer, Channel partner,
--    Agent or Model. The default types are neutral (contacts: Customer, Vendor, Partner, Other; clients: Business,
--    Individual, Internal, Other). Real-estate packs get their own types as before. A type any record has, or one a
--    person edited, is never archived.
--  * Existing data (pulse.company_model_backfill, run here for every company): a client becomes a company client only on
--    evidence: a company name, a type that means an organisation (developer, business, brand, institution, dealer…), a
--    GSTIN on one of its bills, or a name like "… Pvt Ltd / Developers / Group". A type that means one person
--    (individual, home customer) marks it a person client. Everything else is left as it is, to be sorted with one tap
--    on the client's page (nothing is guessed). The client's people get company_id; the client's primary contact becomes
--    the company's main contact. Same name twice in one company = one company.
--  * Nothing is deleted or rewritten: only new rows (companies) and new columns are filled, plus entity_kind on person
--    clients and the type switches above, each kept in pulse.company_model_undo for the way back. Counts before and after
--    per company go to pulse.company_model_log, and the migration stops if any existing count changed.
-- Row security: pulse.company, company_model_log and company_model_undo are forced with the tenant policy.

-- --------------------------------------------------------------------------------------------------- the companies
create table pulse.company (
  org_id            uuid not null references pulse.org(id),
  id                uuid primary key default gen_random_uuid(),
  name              text not null check (length(btrim(name)) between 1 and 160),
  legal_name        text check (legal_name is null or length(legal_name) <= 200),
  industry          text check (industry is null or length(industry) <= 80),
  website           text check (website is null or length(website) <= 200),
  email             text check (email is null or length(email) <= 254),
  phone             text check (phone is null or length(phone) <= 40),
  city              text check (city is null or length(city) <= 80),
  address           text check (address is null or length(address) <= 500),
  gstin             text check (gstin is null or gstin ~ '^[0-9A-Z]{15}$'),
  notes             text check (notes is null or length(notes) <= 4000),
  primary_contact_id uuid references pulse.person(id) on delete set null,
  is_vendor         boolean not null default false,
  is_partner        boolean not null default false,
  pulse_org_id      uuid references pulse.org(id) on delete set null,   -- the company's own Pulse account, when it has one
  directory_invite_id uuid,                                              -- the invite to Pulse we sent it (pulse.directory_invite)
  source            text not null default 'manual' check (source in ('manual', 'client', 'contact', 'billing', 'directory', 'import')),
  created_by        uuid,                                                -- no foreign key (release smoke cleanup deletes people)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  archived_at       timestamptz,
  unique (org_id, id)
);
create index company_org_name on pulse.company (org_id, lower(btrim(name)));
create index company_pulse_org on pulse.company (pulse_org_id) where pulse_org_id is not null;
alter table pulse.company enable row level security;
alter table pulse.company force row level security;
create policy tenant on pulse.company using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select, insert, update on pulse.company to pulse_api, pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.company for each row execute function pulse.audit_mutation();
-- As for clients (00452): the API role writes companies only as an organisation admin with a person (the routes say the same).
create policy admin_insert on pulse.company as restrictive for insert to pulse_api with check (pulse.viewer_is('admin') and pulse.current_viewer() is not null);
create policy admin_update on pulse.company as restrictive for update to pulse_api using (pulse.viewer_is('admin') and pulse.current_viewer() is not null)
  with check (pulse.viewer_is('admin') and pulse.current_viewer() is not null);

-- A link names the company inside the same organisation (org_id, company_id): never another tenant's company.
alter table pulse.contact_profile add column company_id uuid;
alter table pulse.contact_profile add constraint contact_profile_company_fk foreign key (org_id, company_id) references pulse.company(org_id, id) on delete set null (company_id);
create index contact_profile_company on pulse.contact_profile (org_id, company_id) where company_id is not null;
alter table pulse.client add column company_id uuid;
alter table pulse.client add constraint client_company_fk foreign key (org_id, company_id) references pulse.company(org_id, id) on delete set null (company_id);
create index client_company on pulse.client (org_id, company_id) where company_id is not null;
select pulse.check_values_add('pulse.record_change'::regclass, 'record_change_entity_type_check', 'entity_type', array['company']);

-- What this migration changed, for the way back, and the counts it checked.
create table pulse.company_model_undo (
  org_id    uuid not null references pulse.org(id),
  kind      text not null check (kind in ('entity_kind', 'type_archived', 'type_added', 'type_restored', 'type_hint')),
  ref       text not null,                       -- a client id, or "<entity>:<key>" of a type
  before    text,
  at        timestamptz not null default now(),
  primary key (org_id, kind, ref)
);
create table pulse.company_model_log (
  org_id    uuid not null references pulse.org(id),
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  before    jsonb not null,
  after     jsonb not null,
  made      jsonb not null
);
do $$ declare t text; begin
  foreach t in array array['company_model_undo', 'company_model_log'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select on pulse.%I to pulse_worker', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------- what a type means
-- A client type that means an organisation, or one person (keys Pulse made, and labels a company chose).
create function pulse.client_type_kind(p_key text) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  -- The label the company sees wins when it says one or the other (a renamed type: "brand" relabelled "Home customer");
  -- whole words only, and a label that says both ("Family business") says nothing. Otherwise the key Pulse made.
  with t as (select t.label ~* '\m(individuals?|home|homes|persons?|people|patients?|b2c|families|family|retail customers?)\M' p,
                    t.label ~* '\m(business(es)?|compan(y|ies)|corporates?|b2b|brands?|institutions?|dealers?|developers?|builders?|agenc(y|ies)|firms?|shops?|stores?|societ(y|ies)|associations?|hospitals?|schools?)\M' o
               from record_type t where t.org_id = current_org() and t.entity = 'client' and t.key = p_key)
  select case
    when p_key is null or p_key = 'internal' then null
    when exists(select 1 from t where p and not o) then 'person'
    when exists(select 1 from t where o and not p) then 'company'
    when exists(select 1 from t where p and o) then null
    when p_key in ('individual', 'home_customer', 'person', 'patient', 'b2c', 'b2c_customer', 'talent') then 'person'
    when p_key in ('developer', 'business', 'business_customer', 'brand', 'institution', 'dealer', 'company', 'b2b', 'b2b_customer', 'agency', 'corporate') then 'company'
  end
$$;
revoke all on function pulse.client_type_kind(text) from public;
grant execute on function pulse.client_type_kind(text) to pulse_api, pulse_worker;

-- A name that is a placeholder, not a name ("NA", "#N/A", "-", "Self", "Test", "Same as above").
create function pulse.placeholder_name(p_name text) returns boolean language sql immutable as $$
  select coalesce(p_name, '') !~ '[[:alpha:]]'
      or regexp_replace(lower(coalesce(p_name, '')), '[^a-z]+', ' ', 'g') ~ '^ *(n ?a|nan|none|nil|null|self|self employed|individual|personal|private person|proprietor|unknown|not known|not applicable|tbd|tba|test|testing|dummy|sample|same as above|same|xxx+|abc) *$'
$$;

-- A name that is clearly an organisation's.
create function pulse.company_like_name(p_name text) returns boolean language sql immutable as $$
  select coalesce(p_name, '') ~* '(\m(pvt|private|ltd|limited|llp|inc|corp|corporation|company|enterprises?|industries|group|developers?|builders?|realty|realtors?|infra|associates|traders|trading|solutions|technolog(y|ies)|hospitals?|schools?|society|trust|foundation|agency|studios?|properties|constructions?|ventures|labs?)\M)'
$$;

-- The company of one client, made (or found by name) on evidence only. Returns the company id or null.
-- One person's employer, settled only when it is clear: a contact (never staff, a channel partner, a model or a vendor
-- seen on several clients) whose every client is the same company.
create function pulse.contact_company_settle(p_person uuid) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid;
begin
  if not exists(select 1 from contact_profile cp join person p on p.id = cp.person_id
                 where cp.person_id = p_person and cp.org_id = current_org() and cp.company_id is null and p.side in ('client', 'other')) then return null; end if;
  select min(c.company_id::text)::uuid into cid from (
    select cl.company_id from client cl where cl.org_id = current_org() and (cl.primary_contact_id = p_person or cl.id in (select client_id from client_contact where person_id = p_person))
  ) c having count(*) > 0 and count(*) = count(c.company_id) and count(distinct c.company_id) = 1;
  if cid is not null then update contact_profile set company_id = cid where person_id = p_person and company_id is null; end if;
  return cid;
end $$;
revoke all on function pulse.contact_company_settle(uuid) from public;

-- The company of one client, made (or found by name) on evidence only. Returns the company id or null. Forced ("this is a
-- company", a person's choice on the client's page) only for an organisation admin.
create function pulse.company_for_client(p_client uuid, p_force boolean default false) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c client; kind text; nm text; g text; cid uuid; pc uuid; x record; cname text;
begin
  if pg_trigger_depth() = 0 and current_viewer() is not null and not viewer_is('admin') then
    raise exception 'An organisation admin sorts clients' using errcode = '42501'; end if;
  select * into c from client where id = p_client and org_id = current_org();
  if c.id is null then return null; end if;
  if c.company_id is not null then return c.company_id; end if;
  if c.client_type = 'internal' or (c.entity_kind = 'person' and not p_force) then return null; end if;
  -- A client merged into another one stays where the merge put it.
  if exists(select 1 from record_merge m where m.org_id = current_org() and m.entity_type = 'client' and m.gone_id = c.id and m.undone_at is null) then return null; end if;
  kind := client_type_kind(c.client_type);
  -- A company name that is a placeholder is none; one that only repeats the client's own name proves nothing alone.
  cname := case when placeholder_name(c.company_name) then null else nullif(btrim(c.company_name), '') end;
  g := (select upper(btrim(d.buyer->>'gstin')) from erp_document d where d.org_id = current_org() and d.client_id = c.id
         and upper(btrim(coalesce(d.buyer->>'gstin', ''))) ~ '^[0-9A-Z]{15}$' order by d.created_at desc limit 1);
  -- (null-safe: a type that says nothing must not let the test pass by a NULL)
  if not coalesce(p_force or c.entity_kind = 'company' or g is not null or kind is not distinct from 'company'
          or (cname is not null and lower(cname) <> lower(btrim(c.display_name)))
          or (kind is null and company_like_name(coalesce(cname, c.display_name))), false) then return null; end if;
  nm := btrim(left(btrim(coalesce(cname, c.display_name)), 160));
  if coalesce(nm, '') = '' or placeholder_name(nm) then return null; end if;
  select id into cid from company where org_id = current_org() and lower(btrim(name)) = lower(nm) and archived_at is null order by created_at limit 1;
  if cid is null then
    insert into company(org_id, name, website, email, phone, city, gstin, source, created_at)
    values (current_org(), nm, left(nullif(btrim(c.website), ''), 200), left(nullif(btrim(c.email), ''), 254), left(nullif(btrim(c.phone), ''), 40), left(nullif(btrim(c.city), ''), 80), g, 'client', coalesce(c.created_at, now()))
    returning id into cid;
  end if;
  update client set company_id = cid where id = c.id;
  -- The client's own people work there when that is clear (contact_company_settle); the main contact is one of them.
  for x in select c.primary_contact_id id, 0 o where c.primary_contact_id is not null
           union all select person_id, case when is_primary then 1 else 2 end from client_contact where client_id = c.id order by 2, 1 loop
    perform contact_company_settle(x.id);
    if pc is null and exists(select 1 from contact_profile where person_id = x.id and company_id = cid) then pc := x.id; end if;
  end loop;
  if pc is not null then update company set primary_contact_id = pc where id = cid and primary_contact_id is null; end if;
  return cid;
end $$;
revoke all on function pulse.company_for_client(uuid, boolean) from public;
grant execute on function pulse.company_for_client(uuid, boolean) to pulse_api, pulse_worker;

-- A new client (from any door: Drive, Billing, the sales sync, a form) gets its company the same way.
create function pulse.client_company_follow() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.company_id is null and new.org_id = current_org() then perform company_for_client(new.id); end if;
  return null;
end $$;
revoke all on function pulse.client_company_follow() from public;
create trigger client_company_follow after insert or update of company_name, client_type on pulse.client
  for each row when (new.company_id is null) execute function pulse.client_company_follow();

-- ------------------------------------------------------------------------------------------ neutral default types
create or replace function pulse.record_types_defaults() returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_org() is null or exists(select 1 from record_type where org_id=current_org() limit 1) then return; end if;
 -- COMPANIES-MODEL: plain business words for everyone; an industry adds its own (record_types_align).
 insert into record_type(org_id,entity,key,label,plural,color,hint,sort,system) values
  (current_org(),'contact','customer','Customer','Customers','teal','Someone who buys or may buy from us.',10,false),
  (current_org(),'contact','vendor','Vendor','Vendors','amber','Supplies a service or goods to us.',40,false),
  (current_org(),'contact','partner','Partner','Partners','violet','Works with us on deals or projects.',50,false),
  (current_org(),'contact','other','Other','Other','slate','Anyone else.',900,true),
  (current_org(),'client','business','Business','Businesses','blue','A company or shop that buys from us.',10,false),
  (current_org(),'client','individual','Individual','Individuals','teal','A person buying for themselves.',20,false),
  (current_org(),'client','internal','Internal','Internal','indigo','The organisation’s own work.',800,true),
  (current_org(),'client','other','Other','Other','slate','Anyone else.',900,true)
 on conflict do nothing;
 perform record_types_align();
end $$;

-- A record given a real-estate type Pulse used to offer everyone (a Drive sync, an import, an older script) still saves:
-- the type is added to that company on first use, so its records keep their words. Nobody is offered it before.
create function pulse.record_type_legacy(p_entity text, p_key text) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  insert into record_type(org_id, entity, key, label, plural, color, hint, sort, system)
  select current_org(), x.e, x.k, x.l, x.p, x.c, x.h, x.s, false from (values
    ('contact', 'developer', 'Developer', 'Developers', 'blue', 'Builds the projects we market.', 12),
    ('contact', 'channel_partner', 'Channel partner', 'Channel partners', 'violet', 'Sells the projects.', 22),
    ('contact', 'talent', 'Model', 'Models', 'rose', 'Appears in shoots.', 32),
    ('client', 'developer', 'Developer', 'Developers', 'blue', 'A builder or developer marketing its projects.', 12),
    ('client', 'channel_partner', 'Channel partner', 'Channel partners', 'violet', 'Sells projects for developers.', 22),
    ('client', 'agent', 'Agent', 'Agents', 'teal', 'A broker or individual agent.', 32),
    ('client', 'brand', 'Brand', 'Brands', 'orange', 'A brand or a business.', 42)) x(e, k, l, p, c, h, s)
  where x.e = p_entity and x.k = p_key
  on conflict do nothing;
  return found;
end $$;
revoke all on function pulse.record_type_legacy(text, text) from public;

create or replace function pulse.record_type_check() returns trigger
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_entity text:=case when tg_table_name='client' then 'client' else 'contact' end; col text:=case when tg_table_name='client' then 'client_type' else 'contact_type' end; k text; t record_type;
begin
 k:=to_jsonb(new)->>col;
 if k is null then return new; end if;
 if tg_op='UPDATE' and k is not distinct from to_jsonb(old)->>col then return new; end if;
 perform set_config('pulse.org_id',new.org_id::text,true) where current_org() is null;
 perform record_types_defaults();
 select * into t from record_type r where r.org_id=new.org_id and r.entity=v_entity and r.key=k;
 if not found then perform record_type_legacy(v_entity,k); select * into t from record_type r where r.org_id=new.org_id and r.entity=v_entity and r.key=k; end if;
 -- A type Pulse archived for the industry (nobody chose to) comes back when a record arrives with it (a Drive sync, an
 -- import): the company does use it.
 if t.archived_at is not null and t.archived_by_industry and t.updated_by is null then
  update record_type set archived_at=null, archived_by_industry=false, updated_at=now() where org_id=t.org_id and entity=t.entity and key=t.key;
  t.archived_at := null;
 end if;
 if t.key is null then raise exception 'Unknown % type %',v_entity,k using errcode='22023'; end if;
 if t.archived_at is not null then raise exception 'The % type % is archived. Choose another',v_entity,t.label using errcode='22023'; end if;
 return new;
end $$;

-- 1561's alignment, plus: real estate gets its own types; no industry (or a neutral one) is plain business words unless
-- the company already works with real-estate types (it has records of them: it is a real-estate business).
create or replace function pulse.record_types_align() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pk text; trade text; n_add int := 0; n_off int := 0; re_keys text[] := array['developer', 'channel_partner', 'agent', 'talent'];
  own_client boolean; own_contact boolean;
begin
  if current_org() is null then return null; end if;
  select pack_key into pk from org_pack where org_id = current_org();
  if not exists(select 1 from record_type where org_id = current_org()) then return null; end if; -- the defaults seed first, then align
  if pk in ('real_estate_marketing', 'real_estate_developer') then
    update record_type set archived_at = null, archived_by_industry = false, updated_at = now()
      where org_id = current_org() and archived_by_industry;
    get diagnostics n_add = row_count;
    insert into record_type(org_id, entity, key, label, plural, color, hint, sort, system) values
      (current_org(), 'contact', 'developer', 'Developer', 'Developers', 'blue', 'Builds the projects we market.', 10, false),
      (current_org(), 'contact', 'channel_partner', 'Channel partner', 'Channel partners', 'violet', 'Sells the projects.', 20, false),
      (current_org(), 'contact', 'talent', 'Model', 'Models', 'rose', 'Appears in shoots.', 30, false),
      (current_org(), 'client', 'developer', 'Developer', 'Developers', 'blue', 'A builder or developer marketing its projects.', 12, false),
      (current_org(), 'client', 'channel_partner', 'Channel partner', 'Channel partners', 'violet', 'Sells projects for developers.', 22, false),
      (current_org(), 'client', 'agent', 'Agent', 'Agents', 'teal', 'A broker or individual agent.', 32, false)
    on conflict do nothing;
    return jsonb_build_object('industry', 'real_estate', 'restored', n_add);
  end if;
  if (pk is null or pk = 'neutral') and (
       exists(select 1 from client c where c.org_id = current_org() and c.client_type = any(re_keys))
    or exists(select 1 from contact_profile cp where cp.org_id = current_org() and cp.contact_type = any(re_keys))) then
    -- An organisation that never had its types made (first use after this migration) gets the ones its records use.
    perform record_type_legacy('client', k) from (select distinct client_type k from client where org_id = current_org() and client_type = any(re_keys)) x;
    perform record_type_legacy('contact', k) from (select distinct contact_type k from contact_profile where org_id = current_org() and contact_type = any(re_keys)) x;
    return jsonb_build_object('industry', null, 'kept', 'real-estate types are in use');
  end if;
  trade := case when pk = 'solar' then 'dealer' when pk = 'marketing_agency' then 'agency' else 'business' end;
  -- No industry chosen: a company that already made its own types (e.g. "Home customer") is not given ours on top.
  own_client := (pk is null or pk = 'neutral') and exists(select 1 from record_type t where t.org_id = current_org() and t.entity = 'client' and t.archived_at is null
    and not t.system and t.key <> all(re_keys || array['brand', 'business', 'individual']));
  own_contact := (pk is null or pk = 'neutral') and exists(select 1 from record_type t where t.org_id = current_org() and t.entity = 'contact' and t.archived_at is null
    and not t.system and t.key <> all(re_keys || array['vendor', 'customer', 'partner']));
  insert into record_type(org_id, entity, key, label, plural, color, hint, sort, system)
  select current_org(), x.e, x.k, x.l, x.p, x.c, x.h, x.s, false from (values
    ('client', 'business', 'Business', 'Businesses', 'blue', 'A company or shop that buys from us.', 10),
    ('client', 'individual', 'Individual', 'Individuals', 'teal', 'A person buying for themselves.', 20),
    ('contact', 'customer', 'Customer', 'Customers', 'teal', 'Someone who buys or may buy from us.', 10)) x(e, k, l, p, c, h, s)
    where not (x.e = 'client' and own_client) and not (x.e = 'contact' and own_contact)
  union all select current_org(), y.e, y.k, y.l, y.p, y.c, y.h, y.s, false from (values
    ('client', 'dealer', 'Dealer', 'Dealers', 'violet', 'Resells or installs our products.', 30),
    ('client', 'institution', 'Institution', 'Institutions', 'amber', 'A school, hospital, office or government buyer.', 40),
    ('contact', 'dealer', 'Dealer', 'Dealers', 'violet', 'Resells or installs our products.', 20),
    ('contact', 'installer', 'Installer', 'Installers', 'orange', 'Fits and services what we sell.', 30)) y(e, k, l, p, c, h, s) where trade = 'dealer'
  on conflict (org_id, entity, key) do update set archived_at = null, archived_by_industry = false
    where record_type.archived_at is not null and (record_type.updated_by is null or record_type.archived_by_industry);
  get diagnostics n_add = row_count;
  update record_type t set archived_at = now(), archived_by_industry = true, updated_at = now()
    where t.org_id = current_org() and t.archived_at is null and not t.system and t.updated_by is null
      and ((t.entity = 'client' and t.key in ('developer', 'channel_partner', 'agent')) or (t.entity = 'contact' and t.key in ('developer', 'channel_partner'))
        or (t.entity = 'contact' and t.key = 'talent' and trade <> 'agency'))
      and not (t.entity = 'client' and exists(select 1 from client c where c.org_id = t.org_id and c.client_type = t.key))
      and not (t.entity = 'contact' and exists(select 1 from contact_profile cp where cp.org_id = t.org_id and cp.contact_type = t.key));
  get diagnostics n_off = row_count;
  update record_type set hint = 'A brand or a business.' where org_id = current_org() and entity = 'client' and key = 'brand' and hint = 'A brand outside real estate.';
  return jsonb_build_object('industry', trade, 'added', n_add, 'archived', n_off);
end $$;
revoke all on function pulse.record_types_align() from public;

-- ------------------------------------------------------------------------------------- a company's own Pulse account
-- The public card of a linked Pulse company (only what the directory shows anyone: name, @handle).
create function pulse.company_pulse_card(p_org uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('id', g.id, 'handle', g.handle, 'name', g.name) from org g where g.id = p_org and g.status = 'active'
$$;
revoke all on function pulse.company_pulse_card(uuid) from public;
grant execute on function pulse.company_pulse_card(uuid) to pulse_api;

-- The invite this company was sent: its state (pending / joined / cancelled), never its link.
create function pulse.company_invite_state(p_invite uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('id', i.id, 'status', i.status, 'email', i.email, 'phone', i.phone, 'createdAt', i.created_at, 'joinedOrg', i.joined_org)
  from directory_invite i where i.id = p_invite and i.org_id = current_org()
$$;
revoke all on function pulse.company_invite_state(uuid) from public;
grant execute on function pulse.company_invite_state(uuid) to pulse_api;

-- When the invited company signs up (pulse.directory_invite_claim marks the invite joined), the company record links to
-- its new Pulse account: the base data stays connected.
create function pulse.company_invite_follow() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), '');
begin
  if new.status = 'joined' and new.joined_org is not null and old.status is distinct from 'joined' then
    perform set_config('pulse.org_id', new.org_id::text, true);
    update company set pulse_org_id = new.joined_org, updated_at = now() where org_id = new.org_id and directory_invite_id = new.id and pulse_org_id is null;
    perform set_config('pulse.org_id', o, true);
  end if;
  return null;
end $$;
revoke all on function pulse.company_invite_follow() from public;
create trigger company_invite_follow after update of status on pulse.directory_invite for each row execute function pulse.company_invite_follow();

-- ------------------------------------------------------------------------------------------ existing data, per company
create function pulse.company_model_counts() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object(
    'clients', (select count(*) from client where org_id = current_org()),
    'contacts', (select count(*) from contact_profile where org_id = current_org()),
    'clientContacts', (select count(*) from client_contact where org_id = current_org()),
    'projects', (select count(*) from project where org_id = current_org()),
    'documents', (select count(*) from erp_document where org_id = current_org()),
    'companies', (select count(*) from company where org_id = current_org()),
    'companyClients', (select count(*) from client where org_id = current_org() and company_id is not null),
    'personClients', (select count(*) from client where org_id = current_org() and company_id is null and entity_kind = 'person'),
    'unsortedClients', (select count(*) from client where org_id = current_org() and company_id is null and entity_kind <> 'person' and client_type <> 'internal'),
    'contactsAtCompany', (select count(*) from contact_profile where org_id = current_org() and company_id is not null),
    'typesOffered', (select coalesce(jsonb_agg(entity || ':' || key order by entity, sort), '[]') from record_type where org_id = current_org() and archived_at is null))
$$;
revoke all on function pulse.company_model_counts() from public;

create function pulse.company_model_backfill() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b jsonb; a jsonb; r jsonb; c record; n_company int := 0; n_person int := 0; before_types jsonb; k text;
begin
  if current_org() is null then return null; end if;
  b := company_model_counts();
  select coalesce(jsonb_object_agg(entity || ':' || key, jsonb_build_object('on', archived_at is null, 'hint', hint)), '{}') into before_types from record_type where org_id = current_org();
  r := record_types_align();
  -- What the alignment switched, for the way back: archived, brought back, added, a hint reworded.
  insert into company_model_undo(org_id, kind, ref, before)
  select current_org(), x.kind, x.ref, x.before from (
    select case when not before_types ? (t.entity || ':' || t.key) then 'type_added'
                when (before_types->(t.entity || ':' || t.key)->>'on')::boolean and t.archived_at is not null then 'type_archived'
                when not (before_types->(t.entity || ':' || t.key)->>'on')::boolean and t.archived_at is null then 'type_restored' end kind,
           t.entity || ':' || t.key ref, null::text before
      from record_type t where t.org_id = current_org() and before_types <> '{}'
    union all
    select 'type_hint', t.entity || ':' || t.key, before_types->(t.entity || ':' || t.key)->>'hint'
      from record_type t where t.org_id = current_org() and before_types ? (t.entity || ':' || t.key)
       and t.hint is distinct from before_types->(t.entity || ':' || t.key)->>'hint') x
  where x.kind is not null
  on conflict do nothing;
  -- Person clients: a type that means one person.
  for c in select cl.id, cl.entity_kind from client cl where cl.org_id = current_org() and cl.company_id is null and cl.entity_kind = 'unknown' and client_type_kind(cl.client_type) = 'person'
      and (placeholder_name(cl.company_name) or lower(btrim(cl.company_name)) = lower(btrim(cl.display_name)))
      and not exists(select 1 from erp_document d where d.org_id = current_org() and d.client_id = cl.id and upper(btrim(coalesce(d.buyer->>'gstin', ''))) ~ '^[0-9A-Z]{15}$') loop
    insert into company_model_undo(org_id, kind, ref, before) values (current_org(), 'entity_kind', c.id::text, c.entity_kind) on conflict do nothing;
    update client set entity_kind = 'person' where id = c.id;
    n_person := n_person + 1;
  end loop;
  -- Company clients: on evidence only (company_for_client).
  for c in select id from client where org_id = current_org() and company_id is null order by created_at, id loop
    if company_for_client(c.id) is not null then n_company := n_company + 1; end if;
  end loop;
  a := company_model_counts();
  foreach k in array array['clients', 'contacts', 'clientContacts', 'projects', 'documents'] loop
    if a->k is distinct from b->k then raise exception 'COMPANIES-MODEL: % changed in org % (% -> %)', k, current_org(), b->k, a->k; end if;
  end loop;
  insert into company_model_log(org_id, before, after, made)
  values (current_org(), b, a, jsonb_build_object('companyClients', n_company, 'personClients', n_person, 'types', r));
  return jsonb_build_object('before', b, 'after', a, 'companyClients', n_company, 'personClients', n_person, 'types', r);
end $$;
revoke all on function pulse.company_model_backfill() from public;

do $$
declare o record; r jsonb;
begin
  for o in select id, name from pulse.org order by name loop
    perform set_config('pulse.org_id', o.id::text, true);
    r := pulse.company_model_backfill();
    if (r->'after'->>'companies')::int > 0 or (r->>'personClients')::int > 0 or coalesce((r->'types'->>'archived')::int, 0) > 0 then
      raise notice 'COMPANIES-MODEL %: % companies, % company clients, % person clients, % unsorted, % contacts at a company, types %',
        o.name, r->'after'->>'companies', r->'after'->>'companyClients', r->'after'->>'personClients', r->'after'->>'unsortedClients', r->'after'->>'contactsAtCompany', r->'types';
    end if;
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
-- Every row that existed before is untouched by the up step apart from entity_kind on person clients and the type
-- switches, which come back from pulse.company_model_undo. The companies the migration (and the new-client trigger)
-- derived from clients go with the table; companies people added by hand are never dropped silently: the way back
-- stops until they are copied out (pulse.company where source <> 'client').
do $$
declare o record; n int;
begin
  for o in select id from pulse.org loop
    perform set_config('pulse.org_id', o.id::text, true);
    select count(*) into n from pulse.company co where co.source <> 'client'
      or co.updated_at > coalesce((select max(l.at) from pulse.company_model_log l where l.org_id = o.id), '-infinity');
    if n > 0 then raise exception 'COMPANIES-MODEL down: % companies were added or changed by people in org %; copy pulse.company out first', n, o.id; end if;
    update pulse.client c set entity_kind = u.before from pulse.company_model_undo u
      where u.org_id = o.id and u.kind = 'entity_kind' and c.id = u.ref::uuid and c.entity_kind = 'person';
    -- Only types nobody edited since (updated_by is null) go back; a type a record now uses stays offered.
    update pulse.record_type t set archived_at = null, archived_by_industry = false from pulse.company_model_undo u
      where u.org_id = o.id and u.kind = 'type_archived' and t.org_id = o.id and t.entity || ':' || t.key = u.ref and t.updated_by is null;
    delete from pulse.record_type t using pulse.company_model_undo u
      where u.org_id = o.id and u.kind = 'type_added' and t.org_id = o.id and t.entity || ':' || t.key = u.ref and t.updated_by is null
        and not exists(select 1 from pulse.client c where c.org_id = o.id and t.entity = 'client' and c.client_type = t.key)
        and not exists(select 1 from pulse.contact_profile cp where cp.org_id = o.id and t.entity = 'contact' and cp.contact_type = t.key);
    update pulse.record_type t set archived_at = now(), archived_by_industry = true from pulse.company_model_undo u
      where u.org_id = o.id and u.kind in ('type_added', 'type_restored') and t.org_id = o.id and t.entity || ':' || t.key = u.ref and t.archived_at is null and t.updated_by is null
        and not exists(select 1 from pulse.client c where c.org_id = o.id and t.entity = 'client' and c.client_type = t.key)
        and not exists(select 1 from pulse.contact_profile cp where cp.org_id = o.id and t.entity = 'contact' and cp.contact_type = t.key);
    update pulse.record_type t set hint = u.before from pulse.company_model_undo u
      where u.org_id = o.id and u.kind = 'type_hint' and t.org_id = o.id and t.entity || ':' || t.key = u.ref and t.hint = 'A brand or a business.';
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;
-- 0213's type check.
create or replace function pulse.record_type_check() returns trigger
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_entity text:=case when tg_table_name='client' then 'client' else 'contact' end; col text:=case when tg_table_name='client' then 'client_type' else 'contact_type' end; k text; t record_type;
begin
 k:=to_jsonb(new)->>col;
 if k is null then return new; end if;
 if tg_op='UPDATE' and k is not distinct from to_jsonb(old)->>col then return new; end if;
 perform set_config('pulse.org_id',new.org_id::text,true) where current_org() is null;
 perform record_types_defaults();
 select * into t from record_type r where r.org_id=new.org_id and r.entity=v_entity and r.key=k;
 if not found then raise exception 'Unknown % type %',v_entity,k using errcode='22023'; end if;
 if t.archived_at is not null then raise exception 'The % type % is archived. Choose another',v_entity,t.label using errcode='22023'; end if;
 return new;
end $$;
drop function pulse.record_type_legacy(text, text);
drop trigger company_invite_follow on pulse.directory_invite;
drop function pulse.company_invite_follow();
drop function pulse.company_invite_state(uuid);
drop function pulse.company_pulse_card(uuid);
drop trigger client_company_follow on pulse.client;
drop function pulse.client_company_follow();
drop function pulse.company_model_backfill();
drop function pulse.company_model_counts();
drop function pulse.company_for_client(uuid, boolean);
drop function pulse.company_like_name(text);
drop function pulse.placeholder_name(text);
drop function pulse.contact_company_settle(uuid);
drop function pulse.client_type_kind(text);
-- 1561's defaults and alignment.
create or replace function pulse.record_types_defaults() returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_org() is null or exists(select 1 from record_type where org_id=current_org() limit 1) then return; end if;
 insert into record_type(org_id,entity,key,label,plural,color,hint,sort,system) values
  (current_org(),'contact','developer','Developer','Developers','blue','Builds the projects we market.',10,false),
  (current_org(),'contact','channel_partner','Channel partner','Channel partners','violet','Sells the projects.',20,false),
  (current_org(),'contact','talent','Model','Models','rose','Appears in shoots.',30,false),
  (current_org(),'contact','vendor','Vendor','Vendors','amber','Supplies a service or equipment.',40,false),
  (current_org(),'contact','other','Other','Other','slate','Anyone else.',900,true),
  (current_org(),'client','developer','Developer','Developers','blue','A builder or developer marketing its projects.',10,false),
  (current_org(),'client','channel_partner','Channel partner','Channel partners','violet','Sells projects for developers.',20,false),
  (current_org(),'client','agent','Agent','Agents','teal','A broker or individual agent.',30,false),
  (current_org(),'client','brand','Brand','Brands','orange','A brand outside real estate.',40,false),
  (current_org(),'client','internal','Internal','Internal','indigo','The organisation’s own work.',800,true),
  (current_org(),'client','other','Other','Other','slate','Anyone else.',900,true)
 on conflict do nothing;
 perform record_types_align();
end $$;
create or replace function pulse.record_types_align() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pk text; bp text; trade text; n_add int := 0; n_off int := 0;
begin
  if current_org() is null then return null; end if;
  select pack_key into pk from org_pack where org_id = current_org();
  select pack into bp from erp_settings where org_id = current_org();
  if pk in ('real_estate_marketing', 'real_estate_developer') then
    update record_type set archived_at = null, archived_by_industry = false, updated_at = now()
      where org_id = current_org() and archived_by_industry;
    get diagnostics n_add = row_count;
    return jsonb_build_object('industry', 'real_estate', 'restored', n_add);
  end if;
  if pk is null or pk = 'neutral' then return jsonb_build_object('industry', null); end if;
  if not exists(select 1 from record_type where org_id = current_org()) then return null; end if;
  trade := case when pk = 'solar' then 'dealer' when pk = 'marketing_agency' then 'agency' else 'business' end;
  insert into record_type(org_id, entity, key, label, plural, color, hint, sort, system)
  select current_org(), x.e, x.k, x.l, x.p, x.c, x.h, x.s, false from (values
    ('client', 'business', 'Business', 'Businesses', 'blue', 'A company or shop that buys from us.', 10),
    ('client', 'individual', 'Individual', 'Individuals', 'teal', 'A person buying for their own home or use.', 20),
    ('contact', 'customer', 'Customer', 'Customers', 'teal', 'Someone who buys or may buy from us.', 10)) x(e, k, l, p, c, h, s)
  union all select current_org(), y.e, y.k, y.l, y.p, y.c, y.h, y.s, false from (values
    ('client', 'dealer', 'Dealer', 'Dealers', 'violet', 'Resells or installs our products.', 30),
    ('client', 'institution', 'Institution', 'Institutions', 'amber', 'A school, hospital, office or government buyer.', 40),
    ('contact', 'dealer', 'Dealer', 'Dealers', 'violet', 'Resells or installs our products.', 20),
    ('contact', 'installer', 'Installer', 'Installers', 'orange', 'Fits and services what we sell.', 30)) y(e, k, l, p, c, h, s) where trade = 'dealer'
  on conflict (org_id, entity, key) do update set archived_at = null, archived_by_industry = false
    where record_type.archived_at is not null and (record_type.updated_by is null or record_type.archived_by_industry);
  get diagnostics n_add = row_count;
  update record_type t set archived_at = now(), archived_by_industry = true, updated_at = now()
    where t.org_id = current_org() and t.archived_at is null and not t.system and t.updated_by is null
      and ((t.entity = 'client' and t.key in ('developer', 'channel_partner', 'agent')) or (t.entity = 'contact' and t.key in ('developer', 'channel_partner'))
        or (t.entity = 'contact' and t.key = 'talent' and trade <> 'agency'))
      and not (t.entity = 'client' and exists(select 1 from client c where c.org_id = t.org_id and c.client_type = t.key))
      and not (t.entity = 'contact' and exists(select 1 from contact_profile cp where cp.org_id = t.org_id and cp.contact_type = t.key));
  get diagnostics n_off = row_count;
  update record_type set hint = 'A brand or a business.' where org_id = current_org() and entity = 'client' and key = 'brand' and hint = 'A brand outside real estate.';
  return jsonb_build_object('industry', trade, 'added', n_add, 'archived', n_off);
end $$;
revoke all on function pulse.record_types_align() from public;
-- Companies first seeded after the up step had plain words only; 0213's defaults come back (1561's alignment then archives
-- what a named industry does not use), so a sync bringing "developer" saves again under 0213's check.
do $$
declare o record;
begin
  for o in select id from pulse.org loop
    perform set_config('pulse.org_id', o.id::text, true);
    if exists(select 1 from pulse.record_type where org_id = o.id) then
      insert into pulse.record_type(org_id,entity,key,label,plural,color,hint,sort,system) values
       (o.id,'contact','developer','Developer','Developers','blue','Builds the projects we market.',10,false),
       (o.id,'contact','channel_partner','Channel partner','Channel partners','violet','Sells the projects.',20,false),
       (o.id,'contact','talent','Model','Models','rose','Appears in shoots.',30,false),
       (o.id,'contact','vendor','Vendor','Vendors','amber','Supplies a service or equipment.',40,false),
       (o.id,'contact','other','Other','Other','slate','Anyone else.',900,true),
       (o.id,'client','developer','Developer','Developers','blue','A builder or developer marketing its projects.',10,false),
       (o.id,'client','channel_partner','Channel partner','Channel partners','violet','Sells projects for developers.',20,false),
       (o.id,'client','agent','Agent','Agents','teal','A broker or individual agent.',30,false),
       (o.id,'client','brand','Brand','Brands','orange','A brand outside real estate.',40,false),
       (o.id,'client','internal','Internal','Internal','indigo','The organisation’s own work.',800,true),
       (o.id,'client','other','Other','Other','slate','Anyone else.',900,true)
      on conflict do nothing;
      perform pulse.record_types_align();
    end if;
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;
drop table pulse.company_model_log;
drop table pulse.company_model_undo;
alter table pulse.client drop column company_id;
alter table pulse.contact_profile drop column company_id;
drop table pulse.company;
