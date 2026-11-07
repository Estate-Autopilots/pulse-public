-- migrate:up
-- ERP-INVOICE (11 Oct 2026): the company's catalog (services, products, consumables and packages built from them, with
-- versions and price history), inventory (stock moves and a low-stock level, off for service-only companies), clients'
-- billing profiles, client packages (engagements) with milestones, document templates, numbering series per financial
-- year, and the documents themselves: invoices, proformas, quotations and credit notes with their lines, payments, an
-- ERP log and client acceptance links (the e-sign seam).
--
-- Who: leadership and the Finance role write (an admin only with the money grants); an Accountant reads in a valid
-- two-step session. The GST arithmetic lives in @pulse/invoice-doc (one implementation for the live preview and the
-- API); the database stores the figures, checks they add up when a document is issued, numbers it gaplessly and keeps
-- an issued document as it was.

-- ---------------------------------------------------------------------------------------------------- access
-- The Accountant's read is the CA desk's: unexpired, not revoked, active person, two-step session (finance_desk_authorize).
create function pulse.erp_accountant_reads() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and exists(select 1 from pulse_priv.accountant_access a join person p on p.org_id=a.org_id and p.id=a.person_id
  join login_session s on s.org_id=a.org_id and s.person_id=a.person_id
  join pulse_priv.auth_account ac on ac.org_id=a.org_id and ac.realm='staff' and ac.actor=a.person_id
  where a.org_id=current_org() and a.person_id=current_viewer() and p.status='active' and a.revoked_at is null
  and a.expires_on>=(now() at time zone 'Asia/Kolkata')::date and ac.totp is not null and s.second_factor_verified and s.revoked_at is null
  and s.expires_at>now() and s.token_hash=current_setting('pulse.session_hash',true))
$$;
-- Read: the Finance role, leadership (money grants), or a valid Accountant. Write: the Finance role or the money plan grant.
create function pulse.erp_can(p_write boolean default false) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('finance')
  or (money_can('money.read') and money_can('money.amount.read') and (not p_write or money_can('money.plan.write')))
  or (not p_write and is_accountant(current_viewer()) and erp_accountant_reads()))
$$;
create function pulse.erp_require(p_write boolean default false) returns uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if not erp_can(p_write) then
  raise exception '%', case when p_write then 'Invoicing is for leadership and the Finance role' else 'ERP is for leadership, Finance and the Accountant' end using errcode='42501';
 end if;
 return current_viewer();
end $$;

-- ------------------------------------------------------------------------------------------------- settings
create table pulse.erp_settings (
 org_id uuid primary key references pulse.org(id),
 -- The seller as printed: legalName, tradeName, gstin, stateCode, pan, address (lines), email, phone, website.
 company jsonb not null default '{}' check(jsonb_typeof(company)='object'),
 inventory_enabled boolean not null default false,
 due_days int not null default 15 check(due_days between 0 and 365),
 round_total boolean not null default true,
 updated_by uuid references pulse.person(id), updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------------- catalog
create table pulse.erp_item (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 kind text not null check(kind in ('service','product','consumable','package')),
 code text check(code ~ '^[A-Za-z0-9._/-]{1,40}$'),
 name text not null check(length(btrim(name)) between 1 and 160),
 description text not null default '' check(length(description)<=4000),
 sac text check(sac ~ '^[0-9]{4,8}$'),
 unit text not null default 'nos' check(length(btrim(unit)) between 1 and 20),
 price bigint not null default 0 check(price between 0 and 1000000000000),
 gst_rate numeric(6,3) not null default 18 check(gst_rate in (0,0.1,0.25,1.5,3,5,6,12,18,28,40)),
 cost bigint check(cost between 0 and 1000000000000),
 track_stock boolean not null default false,
 reorder_level numeric(14,3) check(reorder_level>=0),
 -- Packages: [{label, percent, offsetDays}] — how a sold package is billed (advance, months, completion).
 milestones jsonb not null default '[]' check(jsonb_typeof(milestones)='array'),
 setup text not null default '' check(length(setup)<=4000),
 status text not null default 'draft' check(status in ('draft','active','archived')),
 version int not null default 1,
 source jsonb not null default '{}' check(jsonb_typeof(source)='object'),
 created_by uuid references pulse.person(id), created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id), updated_at timestamptz not null default now(),
 unique(org_id,code), unique(org_id,id),
 check(kind<>'package' or not track_stock), check(track_stock or reorder_level is null)
);
-- Parts of a package: what it holds, where it lives, how it is set up and what each part feeds (derives).
create table pulse.erp_package_part (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 package_id uuid not null references pulse.erp_item(id) on delete cascade, position int not null check(position>=0),
 item_id uuid references pulse.erp_item(id),
 label text not null check(length(btrim(label)) between 1 and 160),
 quantity numeric(14,3) not null default 1 check(quantity>0), unit text check(length(unit)<=20),
 deliverables text[] not null default '{}', where_text text not null default '' check(length(where_text)<=1000),
 setup text not null default '' check(length(setup)<=2000), derives text not null default '' check(length(derives)<=1000),
 price bigint check(price between 0 and 1000000000000), cost bigint check(cost between 0 and 1000000000000),
 unique(package_id,position), check(item_id is distinct from package_id)
);
-- Every saved version of an item (its parts included): the price history.
create table pulse.erp_item_version (
 org_id uuid not null references pulse.org(id), item_id uuid not null references pulse.erp_item(id) on delete cascade,
 version int not null, snapshot jsonb not null, changed_by uuid references pulse.person(id),
 changed_at timestamptz not null default now(), primary key(item_id,version)
);

-- -------------------------------------------------------------------------------------------------- inventory
create table pulse.erp_stock_move (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 item_id uuid not null references pulse.erp_item(id), kind text not null check(kind in ('in','out','adjust')),
 qty numeric(14,3) not null check(qty<>0 and (kind='adjust' or qty>0)),
 unit_cost bigint check(unit_cost>=0), note text not null default '' check(length(note)<=500),
 document_id uuid, on_date date not null default ((now() at time zone 'Asia/Kolkata')::date),
 created_by uuid references pulse.person(id), created_at timestamptz not null default now()
);
create index erp_stock_item on pulse.erp_stock_move(org_id,item_id);

-- ------------------------------------------------------------------------------------------- billing profiles
create table pulse.erp_party (
 org_id uuid not null references pulse.org(id), client_id uuid primary key references pulse.client(id),
 legal_name text not null check(length(btrim(legal_name)) between 1 and 200),
 gstin text check(gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
 state_code text check(state_code ~ '^[0-9]{2}$'),
 address text[] not null default '{}', email text check(length(email)<=200), phone text check(length(phone)<=40),
 contact_person_id uuid references pulse.person(id), contact_name text check(length(contact_name)<=120),
 notes text not null default '' check(length(notes)<=1000),
 source jsonb not null default '{}' check(jsonb_typeof(source)='object'),
 updated_by uuid references pulse.person(id), updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------- templates and numbering
create table pulse.erp_asset (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 kind text not null check(kind in ('logo','signature')), mime text not null check(mime in ('image/png','image/jpeg')),
 bytes bytea not null check(octet_length(bytes) between 1 and 400000), sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid references pulse.person(id), created_at timestamptz not null default now()
);
create table pulse.erp_template (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 name text not null check(length(btrim(name)) between 1 and 80),
 doc_types text[] not null default '{invoice,proforma,quotation,credit_note}'
  check(cardinality(doc_types)>0 and doc_types <@ array['invoice','proforma','quotation','credit_note']),
 design jsonb not null default '{}' check(jsonb_typeof(design)='object'),
 logo_id uuid references pulse.erp_asset(id), signature_id uuid references pulse.erp_asset(id),
 archived boolean not null default false,
 created_by uuid references pulse.person(id), created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id), updated_at timestamptz not null default now()
);
create table pulse.erp_template_default (
 org_id uuid not null references pulse.org(id), doc_type text not null check(doc_type in ('invoice','proforma','quotation','credit_note')),
 template_id uuid not null references pulse.erp_template(id), primary key(org_id,doc_type)
);
-- One running number per document type and financial year (April–March). GST: at most 16 characters, unique per year.
create table pulse.erp_series (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 doc_type text not null check(doc_type in ('invoice','proforma','quotation','credit_note')),
 fy text not null check(fy ~ '^[0-9]{4}-[0-9]{2}$'),
 pattern text not null check(pattern ~ '\{N(:[0-9])?\}' and length(pattern)<=40),
 next_no int not null default 1 check(next_no>=1), last_date date,
 unique(org_id,doc_type,fy)
);

-- ------------------------------------------------------------------------------- client packages, milestones
create table pulse.erp_engagement (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 project_id uuid not null references pulse.project(id), client_id uuid references pulse.client(id),
 package_id uuid references pulse.erp_item(id), package_version int,
 name text not null check(length(btrim(name)) between 1 and 200),
 price bigint not null check(price between 0 and 1000000000000), gst_rate numeric(6,3) not null default 18,
 starts_on date, status text not null default 'active' check(status in ('active','completed','cancelled')),
 created_by uuid references pulse.person(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index erp_engagement_project on pulse.erp_engagement(org_id,project_id);

-- ----------------------------------------------------------------------------------------------- documents
create table pulse.erp_document (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 doc_type text not null check(doc_type in ('invoice','proforma','quotation','credit_note')),
 status text not null default 'draft' check(status in ('draft','issued','sent','part_paid','paid','cancelled','accepted','declined','converted')),
 number text check(length(number) between 1 and 16 and number ~ '^[A-Za-z0-9/-]+$'),
 series_id uuid references pulse.erp_series(id), fy text,
 issue_date date not null default ((now() at time zone 'Asia/Kolkata')::date), due_date date, valid_until date,
 client_id uuid references pulse.client(id), project_id uuid references pulse.project(id),
 engagement_id uuid references pulse.erp_engagement(id), milestone_id uuid,
 against_id uuid references pulse.erp_document(id), source_id uuid references pulse.erp_document(id),
 template_id uuid references pulse.erp_template(id),
 seller jsonb not null default '{}' check(jsonb_typeof(seller)='object'),
 buyer jsonb not null default '{}' check(jsonb_typeof(buyer)='object'),
 place_of_supply text check(place_of_supply ~ '^[0-9]{2}$'),
 reference jsonb not null default '{}' check(jsonb_typeof(reference)='object'),
 notes text not null default '' check(length(notes)<=2000), terms text check(length(terms)<=3000),
 reverse_charge boolean not null default false, zero_rated boolean not null default false, round_total boolean not null default true,
 currency text not null default 'INR' check(currency='INR'),
 tax_mode text check(tax_mode in ('intra','inter')),
 taxable bigint not null default 0, cgst bigint not null default 0, sgst bigint not null default 0, igst bigint not null default 0,
 round_off bigint not null default 0, total bigint not null default 0 check(total>=0), amount_words text,
 paid bigint not null default 0, credited bigint not null default 0,
 task_id uuid references pulse.task(id) on delete set null,
 design jsonb, -- the template as it was when the document was issued
 issued_at timestamptz, issued_by uuid references pulse.person(id), sent_at timestamptz, sent_by uuid references pulse.person(id),
 cancelled_at timestamptz, cancel_reason text check(length(cancel_reason)<=500),
 decision jsonb, -- the client's answer through an acceptance link: {decision, name, at, via}
 created_by uuid references pulse.person(id), created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id), updated_at timestamptz not null default now(),
 unique(org_id,doc_type,fy,number),
 check((status='draft')=(number is null)), check(doc_type='credit_note' or against_id is null)
);
create index erp_document_list on pulse.erp_document(org_id,doc_type,status,issue_date desc);
create index erp_document_client on pulse.erp_document(org_id,client_id);
create index erp_document_against on pulse.erp_document(org_id,against_id) where against_id is not null;
create table pulse.erp_milestone (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 engagement_id uuid not null references pulse.erp_engagement(id) on delete cascade, position int not null check(position>=0),
 label text not null check(length(btrim(label)) between 1 and 160),
 amount bigint not null check(amount between 0 and 1000000000000), due_on date,
 document_id uuid references pulse.erp_document(id) on delete set null,
 task_id uuid references pulse.task(id) on delete set null,
 unique(engagement_id,position)
);
alter table pulse.erp_document add constraint erp_document_milestone foreign key(milestone_id) references pulse.erp_milestone(id) on delete set null;
create index erp_document_task on pulse.erp_document(task_id) where task_id is not null;
create index erp_milestone_task on pulse.erp_milestone(task_id) where task_id is not null;
create table pulse.erp_line (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 document_id uuid not null references pulse.erp_document(id) on delete cascade, position int not null check(position>=0),
 item_id uuid references pulse.erp_item(id),
 description text not null check(length(btrim(description)) between 1 and 300), details text not null default '' check(length(details)<=1000),
 sac text check(sac ~ '^[0-9]{4,8}$'), unit text check(length(unit)<=20),
 qty numeric(14,3) not null check(qty>0), rate bigint not null check(rate between 0 and 1000000000000),
 discount bigint not null default 0 check(discount>=0), discount_percent numeric(7,4) check(discount_percent between 0 and 100),
 gst_rate numeric(6,3) not null check(gst_rate in (0,0.1,0.25,1.5,3,5,6,12,18,28,40)),
 taxable bigint not null, cgst bigint not null default 0, sgst bigint not null default 0, igst bigint not null default 0, total bigint not null,
 unique(document_id,position)
);
-- The issued copy exactly as exported (PDF), with its digest; written once.
create table pulse.erp_document_file (
 org_id uuid not null references pulse.org(id), document_id uuid not null references pulse.erp_document(id),
 kind text not null check(kind in ('pdf')), bytes bytea not null check(octet_length(bytes) between 1 and 5242880),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'), created_by uuid references pulse.person(id), created_at timestamptz not null default now(),
 primary key(document_id,kind)
);
create table pulse.erp_payment (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 document_id uuid not null references pulse.erp_document(id), received_on date not null,
 amount bigint not null check(amount between 1 and 1000000000000), tds bigint not null default 0 check(tds>=0),
 method text not null default 'bank' check(method in ('bank','upi','cheque','cash','other')),
 reference text not null default '' check(length(reference)<=120), bank_line_key text check(length(bank_line_key)<=200),
 note text not null default '' check(length(note)<=500),
 voided_at timestamptz, voided_by uuid references pulse.person(id), void_reason text check(length(void_reason)<=300),
 created_by uuid references pulse.person(id), created_at timestamptz not null default now()
);
create index erp_payment_document on pulse.erp_payment(org_id,document_id);
create unique index erp_payment_bank_once on pulse.erp_payment(org_id,bank_line_key) where bank_line_key is not null and voided_at is null;
-- The ERP log: every document's life (created, edited, issued, exported, sent, paid, credited, cancelled, accepted).
create table pulse.erp_event (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 subject_type text not null check(subject_type in ('document','item','template','settings','series','engagement','stock','party')),
 subject_id uuid, kind text not null check(length(kind) between 1 and 40), detail jsonb not null default '{}' check(jsonb_typeof(detail)='object'),
 actor uuid references pulse.person(id), at timestamptz not null default now()
);
create index erp_event_subject on pulse.erp_event(org_id,subject_id,at);
-- A client's link to read and accept a quotation or invoice. Only a hash of the token is kept.
create table pulse.erp_accept_link (
 token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'), org_id uuid not null references pulse.org(id),
 document_id uuid not null references pulse.erp_document(id), created_by uuid references pulse.person(id),
 created_at timestamptz not null default now(), expires_at timestamptz not null, revoked_at timestamptz,
 opened_at timestamptz, decided_at timestamptz, decision text check(decision in ('accepted','declined')),
 signer_name text check(length(signer_name)<=120), signer_note text check(length(signer_note)<=1000),
 signer_ip_hash text check(signer_ip_hash ~ '^[0-9a-f]{64}$'), signer_agent text check(length(signer_agent)<=300)
);

do $$ declare t text; begin
 foreach t in array array['erp_settings','erp_item','erp_package_part','erp_item_version','erp_stock_move','erp_party','erp_asset','erp_template',
  'erp_template_default','erp_series','erp_engagement','erp_document','erp_milestone','erp_line','erp_document_file','erp_payment','erp_event','erp_accept_link'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('create policy erp_read on pulse.%I as restrictive for select to pulse_api using((select pulse.erp_can(false)))',t);
  execute format('create policy erp_insert on pulse.%I as restrictive for insert to pulse_api with check((select pulse.erp_can(true)))',t);
  execute format('create policy erp_update on pulse.%I as restrictive for update to pulse_api using((select pulse.erp_can(true))) with check((select pulse.erp_can(true)))',t);
  execute format('create policy erp_delete on pulse.%I as restrictive for delete to pulse_api using((select pulse.erp_can(true)))',t);
  if t <> 'erp_document_file' then
   execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()',t);
  end if;
 end loop;
end $$;
grant select,insert,update,delete on pulse.erp_settings,pulse.erp_item,pulse.erp_package_part,pulse.erp_stock_move,pulse.erp_party,pulse.erp_asset,
 pulse.erp_template,pulse.erp_template_default,pulse.erp_engagement,pulse.erp_milestone,pulse.erp_document,pulse.erp_line to pulse_api;
grant select on pulse.erp_item_version,pulse.erp_series,pulse.erp_document_file,pulse.erp_payment,pulse.erp_event,pulse.erp_accept_link to pulse_api;
-- FIN-LIVE reads issued invoices into the sales register and collections; the catalog seed writes draft items.
grant select on pulse.erp_settings,pulse.erp_document,pulse.erp_line,pulse.erp_payment,pulse.erp_party to pulse_worker;
grant select,insert,update on pulse.erp_item,pulse.erp_package_part to pulse_worker;
grant delete on pulse.erp_package_part to pulse_worker;
grant select on pulse.erp_item_version to pulse_worker;
grant insert on pulse.erp_event to pulse_worker;

-- ------------------------------------------------------------------------------------------------ helpers
create function pulse.erp_log(p_type text,p_subject uuid,p_kind text,p_detail jsonb default '{}') returns void language sql security definer set search_path=pulse,pg_temp as $$
 insert into erp_event(org_id,subject_type,subject_id,kind,detail,actor) values(current_org(),p_type,p_subject,p_kind,coalesce(p_detail,'{}'),current_viewer())
$$;
-- India's financial year of a date: 2026-10-11 → 2026-27.
create function pulse.erp_fy(p_day date) returns text language sql immutable as $$
 select (case when extract(month from p_day)>=4 then extract(year from p_day)::int else extract(year from p_day)::int-1 end)::text||'-'||
  lpad(((case when extract(month from p_day)>=4 then extract(year from p_day)::int else extract(year from p_day)::int-1 end+1)%100)::text,2,'0')
$$;
-- {FY} = 26-27, {FYYYY} = 2026-27, {N:4} = 0007 (the same rules as formatDocNumber in @pulse/invoice-doc).
create function pulse.erp_number(p_pattern text,p_fy text,p_n int) returns text language plpgsql immutable as $$
declare s text:=p_pattern;m text[];
begin
 s:=replace(s,'{FYYYY}',p_fy);
 s:=replace(s,'{FY}',substr(p_fy,3,2)||'-'||substr(p_fy,6,2));
 for m in select regexp_matches(s,'\{N(?::([0-9]))?\}','g') loop
  s:=regexp_replace(s,'\{N(:[0-9])?\}',lpad(p_n::text,greatest(coalesce(m[1]::int,1),length(p_n::text)),'0'));
 end loop;
 return s;
end $$;
create function pulse.erp_default_pattern(p_type text) returns text language sql immutable as $$
 select case p_type when 'invoice' then 'INV/{FY}/{N:4}' when 'proforma' then 'PI/{FY}/{N:4}' when 'quotation' then 'QT/{FY}/{N:4}' else 'CN/{FY}/{N:4}' end
$$;

-- Settings and two starter templates the first time anyone with ERP access opens it (no person is recorded).
create function pulse.erp_bootstrap() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare tid uuid;
begin
 perform erp_require(false);
 if exists(select 1 from erp_settings where org_id=current_org()) then return;end if;
 insert into erp_settings(org_id,company) select id,jsonb_build_object('legalName',name,'stateCode','27','address','[]'::jsonb) from org where id=current_org()
  on conflict do nothing;
 insert into erp_template(org_id,name,design) values(current_org(),'Classic',jsonb_build_object('style','line','accent','#5b45d6',
  'terms','Payment is due within 15 days of the invoice date.'||chr(10)||'Please quote the invoice number with your payment.',
  'footer','This is a computer-generated document.')) returning id into tid;
 insert into erp_template_default(org_id,doc_type,template_id) select current_org(),t,tid from unnest(array['invoice','proforma','quotation','credit_note']) t on conflict do nothing;
 insert into erp_template(org_id,name,design) values(current_org(),'Bold band',jsonb_build_object('style','band','accent','#1f2a44','show',jsonb_build_object('lineTax',true)));
end $$;

-- --------------------------------------------------------------------------------- versions and price history
create function pulse.erp_item_bump() returns trigger language plpgsql as $$
begin
 if new.version=old.version and (new.name,new.description,new.sac,new.unit,new.price,new.gst_rate,new.cost,new.kind,new.milestones,new.setup,new.status,new.code)
  is distinct from (old.name,old.description,old.sac,old.unit,old.price,old.gst_rate,old.cost,old.kind,old.milestones,old.setup,old.status,old.code) then
  new.version:=old.version+1;
 end if;
 new.updated_at:=now();
 return new;
end $$;
create trigger erp_item_bump before update on pulse.erp_item for each row execute function pulse.erp_item_bump();
create function pulse.erp_item_snapshot() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if tg_op='UPDATE' and new.version=old.version then return null;end if;
 insert into erp_item_version(org_id,item_id,version,snapshot,changed_by) values(new.org_id,new.id,new.version,
  to_jsonb(new)-array['org_id','created_by','created_at','updated_by','updated_at','version']||jsonb_build_object('parts',coalesce((select jsonb_agg(
   jsonb_build_object('label',p.label,'itemId',p.item_id,'quantity',p.quantity,'unit',p.unit,'deliverables',p.deliverables,'where',p.where_text,
   'setup',p.setup,'derives',p.derives,'price',p.price,'cost',p.cost) order by p.position) from erp_package_part p where p.package_id=new.id),'[]')),
  coalesce(new.updated_by,current_viewer()))
 on conflict(item_id,version) do update set snapshot=excluded.snapshot,changed_by=excluded.changed_by,changed_at=now();
 return null;
end $$;
create trigger erp_item_snapshot after insert or update on pulse.erp_item for each row execute function pulse.erp_item_snapshot();
-- Replaces a package's parts and saves a new version of the package with them.
create function pulse.erp_parts_set(p_package uuid,p_parts jsonb) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=erp_require(true);p jsonb;n int:=0;
begin
 if not exists(select 1 from erp_item where id=p_package and kind='package') then raise exception 'Choose a package' using errcode='22023';end if;
 if jsonb_typeof(p_parts)<>'array' or jsonb_array_length(p_parts)>80 then raise exception 'A package has up to 80 parts' using errcode='22023';end if;
 delete from erp_package_part where package_id=p_package;
 for p in select value from jsonb_array_elements(p_parts) loop
  if nullif(p->>'itemId','') is not null and not exists(select 1 from erp_item where id=(p->>'itemId')::uuid and kind<>'package') then
   raise exception 'A part is a service, product or consumable from the catalog' using errcode='22023';end if;
  insert into erp_package_part(org_id,package_id,position,item_id,label,quantity,unit,deliverables,where_text,setup,derives,price,cost)
  values(current_org(),p_package,n,nullif(p->>'itemId','')::uuid,btrim(p->>'label'),coalesce(nullif(p->>'quantity','')::numeric,1),nullif(btrim(coalesce(p->>'unit','')),''),
   coalesce(array(select btrim(x) from jsonb_array_elements_text(coalesce(p->'deliverables','[]')) x where btrim(x)<>''),'{}'),coalesce(p->>'where',''),coalesce(p->>'setup',''),
   coalesce(p->>'derives',''),nullif(p->>'price','')::bigint,nullif(p->>'cost','')::bigint);
  n:=n+1;
 end loop;
 update erp_item set version=version+1,updated_by=me where id=p_package;
 perform erp_log('item',p_package,'parts',jsonb_build_object('parts',n));
 return n;
end $$;

-- ------------------------------------------------------------------------------------------------- inventory
create function pulse.erp_on_hand(p_item uuid) returns numeric language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(sum(case kind when 'in' then qty when 'out' then -qty else qty end),0) from erp_stock_move where org_id=current_org() and item_id=p_item
$$;
create function pulse.erp_stock_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not coalesce((select inventory_enabled from erp_settings where org_id=current_org()),false) then
  raise exception 'Inventory is off for this company: turn it on in ERP settings' using errcode='22023';end if;
 if not exists(select 1 from erp_item where id=new.item_id and track_stock) then raise exception 'Turn on stock for this item first' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('erp-stock:'||new.item_id::text,0));
 if (new.kind='out' and erp_on_hand(new.item_id)-new.qty<0) or (new.kind='adjust' and erp_on_hand(new.item_id)+new.qty<0) then
  raise exception 'Not enough stock: % on hand',erp_on_hand(new.item_id) using errcode='22023';end if;
 return new;
end $$;
create trigger erp_stock_guard before insert on pulse.erp_stock_move for each row execute function pulse.erp_stock_guard();
create function pulse.erp_stock_fixed() returns trigger language plpgsql as $$
begin raise exception 'Stock moves are kept as recorded; add an adjustment instead' using errcode='22023';end $$;
create trigger erp_stock_fixed before update or delete on pulse.erp_stock_move for each row execute function pulse.erp_stock_fixed();

-- ------------------------------------------------------------------------------- an issued document stays put
create function pulse.erp_document_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then
  if old.status<>'draft' then raise exception 'An issued document is kept; cancel it or issue a credit note' using errcode='22023';end if;
  return old;
 end if;
 if old.status<>'draft' and (new.doc_type,new.number,new.series_id,new.fy,new.issue_date,new.due_date,new.valid_until,new.client_id,new.project_id,new.engagement_id,
  new.milestone_id,new.against_id,new.source_id,new.seller,new.buyer,new.place_of_supply,new.reference,new.notes,new.terms,new.reverse_charge,new.zero_rated,
  new.round_total,new.tax_mode,new.taxable,new.cgst,new.sgst,new.igst,new.round_off,new.total,new.amount_words,new.design,new.issued_at,new.issued_by,new.template_id)
  is distinct from (old.doc_type,old.number,old.series_id,old.fy,old.issue_date,old.due_date,old.valid_until,old.client_id,old.project_id,old.engagement_id,
  old.milestone_id,old.against_id,old.source_id,old.seller,old.buyer,old.place_of_supply,old.reference,old.notes,old.terms,old.reverse_charge,old.zero_rated,
  old.round_total,old.tax_mode,old.taxable,old.cgst,old.sgst,old.igst,old.round_off,old.total,old.amount_words,old.design,old.issued_at,old.issued_by,old.template_id) then
  raise exception 'An issued document cannot be edited; cancel it or issue a credit note' using errcode='22023';
 end if;
 if old.status in ('cancelled','converted','declined') and new.status is distinct from old.status then raise exception 'This document is closed' using errcode='22023';end if;
 if old.status<>'draft' and new.status='draft' then raise exception 'An issued document cannot go back to draft' using errcode='22023';end if;
 new.updated_at:=now();
 return new;
end $$;
create trigger erp_document_guard before update or delete on pulse.erp_document for each row execute function pulse.erp_document_guard();
create function pulse.erp_line_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if exists(select 1 from erp_document where id=coalesce(new.document_id,old.document_id) and status<>'draft') then
  raise exception 'The lines of an issued document cannot change' using errcode='22023';end if;
 return coalesce(new,old);
end $$;
create trigger erp_line_guard before insert or update or delete on pulse.erp_line for each row execute function pulse.erp_line_guard();
create function pulse.erp_file_fixed() returns trigger language plpgsql as $$
begin raise exception 'The issued copy is kept as it was' using errcode='22023';end $$;
create trigger erp_file_fixed before update or delete on pulse.erp_document_file for each row execute function pulse.erp_file_fixed();

-- ------------------------------------------------------------------------------------------------- issue
-- Numbers a draft gaplessly in its series for the financial year of its date, after checking the stored figures add up
-- (the API computed them with @pulse/invoice-doc) and the date keeps the series in order. p: {design}.
create function pulse.erp_document_issue(p_id uuid,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=erp_require(true);d erp_document;s erp_series;v_fy text;v_no text;l record;inv erp_document;credited bigint;today date:=(now() at time zone 'Asia/Kolkata')::date;
begin
 select * into d from erp_document where id=p_id for update;
 if d.id is null then raise exception 'Document not found' using errcode='P0002';end if;
 if d.status<>'draft' then raise exception 'Only a draft is issued' using errcode='22023';end if;
 if coalesce(btrim(d.buyer->>'name'),'')='' then raise exception 'Name the client to bill' using errcode='22023';end if;
 if coalesce(d.seller->>'stateCode','')!~'^[0-9]{2}$' or coalesce(btrim(d.seller->>'legalName'),'')='' then raise exception 'Fill in the company profile first, in ERP settings' using errcode='22023';end if;
 if d.doc_type in ('invoice','credit_note') and coalesce(d.seller->>'gstin','')='' then raise exception 'A tax invoice needs the company''s GSTIN, in ERP settings' using errcode='22023';end if;
 if d.issue_date>today then raise exception 'A document is not dated in the future' using errcode='22023';end if;
 if d.due_date is not null and d.due_date<d.issue_date then raise exception 'The due date is before the issue date' using errcode='22023';end if;
 select count(*) n,coalesce(sum(taxable),0) taxable,coalesce(sum(cgst),0) cgst,coalesce(sum(sgst),0) sgst,coalesce(sum(igst),0) igst into l from erp_line where document_id=p_id;
 if l.n=0 then raise exception 'Add at least one line' using errcode='22023';end if;
 if (l.taxable,l.cgst,l.sgst,l.igst) is distinct from (d.taxable,d.cgst,d.sgst,d.igst) or d.total<>d.taxable+(case when d.reverse_charge then 0 else d.cgst+d.sgst+d.igst end)+d.round_off
  or abs(d.round_off)>(case when d.round_total then 50 else 0 end) or d.total<=0 then
  raise exception 'The figures do not add up; open the document and save it again' using errcode='22023';end if;
 if (d.tax_mode='intra' and (d.igst<>0 or d.cgst<>d.sgst)) or (d.tax_mode='inter' and d.cgst+d.sgst<>0) or d.tax_mode is null
  or (d.tax_mode='intra')<>(coalesce(d.place_of_supply,d.seller->>'stateCode')=d.seller->>'stateCode') then
  raise exception 'The tax split does not match the place of supply; save the document again' using errcode='22023';end if;
 if d.doc_type='credit_note' then
  select * into inv from erp_document where id=d.against_id for update;
  if inv.id is null or inv.doc_type<>'invoice' or inv.status not in ('issued','sent','part_paid','paid') then raise exception 'A credit note is against an issued invoice' using errcode='22023';end if;
  if inv.client_id is distinct from d.client_id then raise exception 'A credit note is for the invoice''s own client' using errcode='22023';end if;
  select coalesce(sum(total),0) into credited from erp_document where against_id=inv.id and doc_type='credit_note' and status not in ('draft','cancelled');
  if credited+d.total>inv.total then raise exception 'Credit notes would exceed the invoice: ₹% of ₹% is already credited',to_char(credited/100.0,'FM999999999990.00'),to_char(inv.total/100.0,'FM999999999990.00') using errcode='22023';end if;
 end if;
 v_fy:=erp_fy(d.issue_date);
 insert into erp_series(org_id,doc_type,fy,pattern) values(current_org(),d.doc_type,v_fy,erp_default_pattern(d.doc_type)) on conflict do nothing;
 select * into s from erp_series where org_id=current_org() and doc_type=d.doc_type and fy=v_fy for update;
 if s.last_date is not null and d.issue_date<s.last_date then
  raise exception 'The last % in this series is dated %; date this one on or after it',replace(d.doc_type,'_',' '),to_char(s.last_date,'DD Mon YYYY') using errcode='22023';end if;
 v_no:=erp_number(s.pattern,v_fy,s.next_no);
 if length(v_no)>16 or v_no!~'^[A-Za-z0-9/-]+$' then raise exception 'The numbering pattern makes %, but GST allows 16 letters, digits, dashes and slashes',v_no using errcode='22023';end if;
 update erp_series set next_no=next_no+1,last_date=greatest(coalesce(last_date,d.issue_date),d.issue_date) where id=s.id;
 update erp_document set status='issued',number=v_no,fy=v_fy,series_id=s.id,issued_at=now(),issued_by=me,updated_by=me,
  design=coalesce(p->'design',design) where id=p_id;
 if d.doc_type='credit_note' then perform erp_settle(d.against_id);end if;
 if d.source_id is not null then
  update erp_document set status='converted',updated_by=me where id=d.source_id and doc_type in ('quotation','proforma') and status in ('issued','sent','accepted');
 end if;
 perform erp_log('document',p_id,'issued',jsonb_build_object('number',v_no,'total',d.total,'fy',v_fy));
 return jsonb_build_object('number',v_no,'fy',v_fy);
end $$;
-- The issued copy, once (the API renders it with the number right after issuing, in the same transaction).
create function pulse.erp_document_file_put(p_id uuid,p_bytes bytea) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=erp_require(true);digest text:=encode(sha256(p_bytes),'hex');
begin
 if not exists(select 1 from erp_document where id=p_id and status<>'draft') then raise exception 'Only an issued document has an issued copy' using errcode='22023';end if;
 insert into erp_document_file(org_id,document_id,kind,bytes,sha256,created_by) values(current_org(),p_id,'pdf',p_bytes,digest,me) on conflict do nothing;
 return (select sha256 from erp_document_file where document_id=p_id and kind='pdf');
end $$;

-- ---------------------------------------------------------------------------------------- payments, status
-- Paid = payments (with TDS the client deducted) + credit notes; issued/sent → part-paid → paid.
create function pulse.erp_settle(p_id uuid) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d erp_document;v_paid bigint;v_credited bigint;v_status text;
begin
 select * into d from erp_document where id=p_id for update;
 if d.doc_type<>'invoice' or d.status not in ('issued','sent','part_paid','paid') then return d.status;end if;
 select coalesce(sum(amount+tds),0) into v_paid from erp_payment where document_id=p_id and voided_at is null;
 select coalesce(sum(total),0) into v_credited from erp_document where against_id=p_id and doc_type='credit_note' and status not in ('draft','cancelled');
 v_status:=case when v_paid+v_credited>=d.total then 'paid' when v_paid+v_credited>0 then 'part_paid' when d.sent_at is not null then 'sent' else 'issued' end;
 update erp_document set paid=v_paid,credited=v_credited,status=v_status where id=p_id and (paid,credited,status) is distinct from (v_paid,v_credited,v_status);
 return v_status;
end $$;
create function pulse.erp_payment_add(p_doc uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=erp_require(true);d erp_document;pid uuid;v_amount bigint;v_tds bigint;
begin
 select * into d from erp_document where id=p_doc for update;
 if d.id is null or d.doc_type<>'invoice' or d.status not in ('issued','sent','part_paid') then raise exception 'Record payments against an issued, unpaid invoice' using errcode='22023';end if;
 begin v_amount:=(p->>'amount')::bigint;v_tds:=coalesce(nullif(p->>'tds','')::bigint,0);
 exception when others then raise exception 'Enter the amount received' using errcode='22023';end;
 if v_amount is null or v_amount<=0 or v_tds<0 then raise exception 'Enter the amount received' using errcode='22023';end if;
 if d.paid+d.credited+v_amount+v_tds>d.total then raise exception 'That is more than the balance due of ₹%',to_char((d.total-d.paid-d.credited)/100.0,'FM999999999990.00') using errcode='22023';end if;
 if coalesce((p->>'receivedOn')::date,'infinity')>(now() at time zone 'Asia/Kolkata')::date or (p->>'receivedOn')::date<d.issue_date-365 then
  raise exception 'Enter the date the money arrived' using errcode='22023';end if;
 insert into erp_payment(org_id,document_id,received_on,amount,tds,method,reference,bank_line_key,note,created_by)
 values(current_org(),p_doc,(p->>'receivedOn')::date,v_amount,v_tds,coalesce(nullif(p->>'method',''),'bank'),coalesce(p->>'reference',''),nullif(p->>'bankLineKey',''),coalesce(p->>'note',''),me)
 returning id into pid;
 perform erp_settle(p_doc);
 perform erp_log('document',p_doc,'payment',jsonb_build_object('amount',v_amount,'tds',v_tds,'on',p->>'receivedOn','bank',p ? 'bankLineKey'));
 return pid;
end $$;
create function pulse.erp_payment_void(p_payment uuid,p_reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=erp_require(true);doc uuid;
begin
 if length(btrim(coalesce(p_reason,'')))<3 then raise exception 'Say why the payment is removed' using errcode='22023';end if;
 update erp_payment set voided_at=now(),voided_by=me,void_reason=btrim(p_reason) where id=p_payment and voided_at is null returning document_id into doc;
 if doc is null then raise exception 'Payment not found' using errcode='P0002';end if;
 perform erp_settle(doc);
 perform erp_log('document',doc,'payment_voided',jsonb_build_object('payment',p_payment,'reason',btrim(p_reason)));
end $$;
-- Sent (handed to the client: Pulse never e-mails a client), cancelled, accepted, declined.
create function pulse.erp_document_mark(p_id uuid,p_action text,p_note text default null) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=erp_require(true);d erp_document;
begin
 select * into d from erp_document where id=p_id for update;
 if d.id is null then raise exception 'Document not found' using errcode='P0002';end if;
 if p_action='sent' then
  if d.status not in ('issued','sent','part_paid','paid') then raise exception 'Issue the document before marking it sent' using errcode='22023';end if;
  update erp_document set sent_at=coalesce(sent_at,now()),sent_by=coalesce(sent_by,me),status=case when status='issued' then 'sent' else status end,updated_by=me where id=p_id;
 elsif p_action='cancel' then
  if d.status='draft' then raise exception 'Delete a draft instead' using errcode='22023';end if;
  if d.status in ('cancelled','converted') then raise exception 'This document is already closed' using errcode='22023';end if;
  if d.doc_type='invoice' and (d.paid>0 or d.credited>0) then raise exception 'An invoice with payments or credit notes is settled with a credit note, not cancelled' using errcode='22023';end if;
  if length(btrim(coalesce(p_note,'')))<3 then raise exception 'Say why it is cancelled' using errcode='22023';end if;
  update erp_document set status='cancelled',cancelled_at=now(),cancel_reason=btrim(p_note),updated_by=me where id=p_id;
  if d.doc_type='credit_note' then perform erp_settle(d.against_id);end if;
 elsif p_action in ('accepted','declined') then
  if d.doc_type not in ('quotation','proforma') or d.status not in ('issued','sent') then raise exception 'A client accepts an issued quotation or proforma' using errcode='22023';end if;
  update erp_document set status=p_action,decision=jsonb_build_object('decision',p_action,'by',me,'at',now(),'via','recorded','note',nullif(btrim(coalesce(p_note,'')),'')),updated_by=me where id=p_id;
 else raise exception 'Unknown action' using errcode='22023';
 end if;
 perform erp_log('document',p_id,p_action,jsonb_build_object('note',nullif(btrim(coalesce(p_note,'')),'')));
 return (select status from erp_document where id=p_id);
end $$;

-- --------------------------------------------------------------------------------- acceptance links (e-sign seam)
create function pulse.erp_accept_link_create(p_doc uuid,p_hash text,p_days int default 30) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=erp_require(true);
begin
 if not exists(select 1 from erp_document where id=p_doc and doc_type in ('quotation','proforma','invoice') and status in ('issued','sent','part_paid','paid')) then
  raise exception 'Issue the quotation or invoice first' using errcode='22023';end if;
 if p_days not between 1 and 90 then raise exception 'A link lasts 1 to 90 days' using errcode='22023';end if;
 update erp_accept_link set revoked_at=now() where document_id=p_doc and revoked_at is null and decided_at is null;
 insert into erp_accept_link(token_hash,org_id,document_id,created_by,expires_at) values(p_hash,current_org(),p_doc,me,now()+make_interval(days=>p_days));
 perform erp_log('document',p_doc,'link_created',jsonb_build_object('days',p_days));
end $$;
-- Signed out: what a client may see through a valid link (the document's face and its issued copy), and the answer.
create function pulse.erp_accept_open(p_hash text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k erp_accept_link;d erp_document;
begin
 select * into k from erp_accept_link where token_hash=p_hash and org_id=current_org();
 if k.token_hash is null or k.revoked_at is not null or (k.expires_at<now() and k.decided_at is null) then return null;end if;
 select * into d from erp_document where id=k.document_id;
 if d.status='cancelled' then return jsonb_build_object('closed',true,'number',d.number);end if;
 if k.opened_at is null then
  update erp_accept_link set opened_at=now() where token_hash=p_hash;
  insert into erp_event(org_id,subject_type,subject_id,kind,detail) values(current_org(),'document',d.id,'link_opened','{}');
 end if;
 return jsonb_build_object('docType',d.doc_type,'number',d.number,'issueDate',d.issue_date,'validUntil',d.valid_until,'dueDate',d.due_date,'total',d.total,
  'seller',d.seller->>'legalName','buyer',d.buyer->>'name','decision',k.decision,'decidedAt',k.decided_at,'signer',k.signer_name,'expiresAt',k.expires_at,
  'canDecide',k.decided_at is null and k.expires_at>=now() and d.status in ('issued','sent','part_paid','paid'));
end $$;
create function pulse.erp_accept_file(p_hash text) returns bytea language sql stable security definer set search_path=pulse,pg_temp as $$
 select f.bytes from erp_accept_link k join erp_document_file f on f.document_id=k.document_id and f.kind='pdf'
 where k.token_hash=p_hash and k.org_id=current_org() and k.revoked_at is null and (k.expires_at>=now() or k.decided_at is not null)
$$;
create function pulse.erp_accept_decide(p_hash text,p_decision text,p_name text,p_note text,p_ip_hash text,p_agent text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k erp_accept_link;d erp_document;
begin
 select * into k from erp_accept_link where token_hash=p_hash and org_id=current_org() for update;
 if k.token_hash is null or k.revoked_at is not null or k.expires_at<now() then raise exception 'This link has expired; ask for a new one' using errcode='22023';end if;
 if k.decided_at is not null then raise exception 'This document was already answered' using errcode='22023';end if;
 if p_decision not in ('accepted','declined') then raise exception 'Accept or decline' using errcode='22023';end if;
 if length(btrim(coalesce(p_name,''))) not between 2 and 120 then raise exception 'Type your full name to sign' using errcode='22023';end if;
 select * into d from erp_document where id=k.document_id for update;
 if d.status not in ('issued','sent','part_paid','paid') then raise exception 'This document can no longer be answered' using errcode='22023';end if;
 update erp_accept_link set decided_at=now(),decision=p_decision,signer_name=btrim(p_name),signer_note=nullif(btrim(coalesce(p_note,'')),''),
  signer_ip_hash=p_ip_hash,signer_agent=left(p_agent,300) where token_hash=p_hash;
 update erp_document set decision=jsonb_build_object('decision',p_decision,'name',btrim(p_name),'at',now(),'via','link','note',nullif(btrim(coalesce(p_note,'')),'')),
  status=case when doc_type in ('quotation','proforma') then p_decision else status end where id=d.id;
 insert into erp_event(org_id,subject_type,subject_id,kind,detail) values(current_org(),'document',d.id,'client_'||p_decision,jsonb_build_object('name',btrim(p_name)));
 return jsonb_build_object('decision',p_decision,'number',d.number);
end $$;

-- ----------------------------------------------------------------------------------------- FIN-LIVE hints
-- A client's GSTIN and billed name on their past Zoho invoices (parties FIN-LIVE linked to the client, R55's money_party).
create function pulse.erp_party_hints(p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform erp_require(true);
 perform audit_write('restricted_read','erp.party_hints',p_client::text);
 return coalesce((select jsonb_agg(h order by h->>'date' desc) from (
  select distinct on (r.body->>'clientGstin') jsonb_build_object('name',r.body->>'client','gstin',r.body->>'clientGstin','number',r.body->>'number','date',r.body->>'date') h
  from pulse_priv.finance_live_record r
  where r.org_id=current_org() and r.kind='invoice' and coalesce(r.body->>'clientGstin','')<>'' and not coalesce((r.body->>'test')::boolean,false)
   and (value_key(r.body->>'client') in (select party_key from pulse_priv.money_party where org_id=current_org() and client_id=p_client and status<>'rejected')
    or value_client_of(r.body->>'client')=p_client)
  order by r.body->>'clientGstin',r.body->>'date' desc) x),'[]');
end $$;
-- Bank credits (FIN-LIVE bank lines) that could pay an invoice: the full amount, after 2% or 10% TDS, or the taxable value
-- alone, from a week before the invoice date to 180 days after; credits already recorded as a payment are left out.
create function pulse.erp_bank_hints(p_doc uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d erp_document;
begin
 perform erp_require(true);
 select * into d from erp_document where id=p_doc;
 if d.id is null or d.doc_type<>'invoice' or d.status in ('draft','cancelled') then return '[]';end if;
 perform audit_write('restricted_read','erp.bank_hints',p_doc::text);
 return coalesce((select jsonb_agg(x order by x->>'date') from (
  select jsonb_build_object('key',r.key,'date',r.body->>'date','amount',round((r.body->>'amount')::numeric*100)::bigint,'payer',r.body->>'counterparty',
   'reference',r.body->>'reference','variant',v.label,'tds',v.tds) x
  from pulse_priv.finance_live_record r
  cross join lateral (values ('exact amount',d.total,0::bigint),('after 2% TDS',d.total-round(d.taxable*0.02)::bigint,round(d.taxable*0.02)::bigint),
   ('after 10% TDS',d.total-round(d.taxable*0.10)::bigint,round(d.taxable*0.10)::bigint),('taxable value only',d.taxable,0::bigint)) v(label,amount,tds)
  where r.org_id=current_org() and r.kind='bank_line' and r.body->>'direction'='in' and coalesce(r.body->>'date','')~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   and (r.body->>'date')::date between d.issue_date-7 and d.issue_date+180
   and abs(round((r.body->>'amount')::numeric*100)-v.amount)<=greatest(200,v.amount*0.002)
   and not exists(select 1 from erp_payment p where p.org_id=current_org() and p.bank_line_key=r.key and p.voided_at is null)
  limit 12) y),'[]');
end $$;

-- When FIN-LIVE last rebuilt its registers (an issued invoice joins them at the next sync after it is issued).
create function pulse.erp_finance_synced_at() returns timestamptz language sql stable security definer set search_path=pulse,pg_temp as $$
 select case when erp_can(false) then (select computed_at from pulse_priv.finance_live_model where org_id=current_org()) end
$$;

-- -------------------------------------------------------------------------------------------------- tasks
-- "Generate invoice for <project> milestone 2" is done only when its invoice is issued.
create function pulse.erp_task_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare needs boolean;issued boolean;
begin
 if new.status not in ('done','accepted') or old.status in ('done','accepted') then return new;end if;
 select exists(select 1 from erp_document where task_id=new.id) or exists(select 1 from erp_milestone where task_id=new.id) into needs;
 if not needs then return new;end if;
 select exists(select 1 from erp_document d where d.doc_type='invoice' and d.status not in ('draft','cancelled') and (d.task_id=new.id
  or d.id in (select m.document_id from erp_milestone m where m.task_id=new.id))) into issued;
 if not issued then raise exception 'Issue the invoice first: this task is done when its invoice is issued' using errcode='22023';end if;
 return new;
end $$;
create trigger erp_task_guard before update of status on pulse.task for each row execute function pulse.erp_task_guard();

revoke all on function pulse.erp_accountant_reads(),pulse.erp_can(boolean),pulse.erp_require(boolean),pulse.erp_log(text,uuid,text,jsonb),pulse.erp_bootstrap(),
 pulse.erp_parts_set(uuid,jsonb),pulse.erp_on_hand(uuid),pulse.erp_document_issue(uuid,jsonb),pulse.erp_document_file_put(uuid,bytea),pulse.erp_settle(uuid),
 pulse.erp_payment_add(uuid,jsonb),pulse.erp_payment_void(uuid,text),pulse.erp_document_mark(uuid,text,text),pulse.erp_accept_link_create(uuid,text,int),
 pulse.erp_accept_open(text),pulse.erp_accept_file(text),pulse.erp_accept_decide(text,text,text,text,text,text),pulse.erp_party_hints(uuid),pulse.erp_bank_hints(uuid),pulse.erp_finance_synced_at() from public;
grant execute on function pulse.erp_accountant_reads(),pulse.erp_can(boolean),pulse.erp_require(boolean),pulse.erp_bootstrap(),
 pulse.erp_parts_set(uuid,jsonb),pulse.erp_on_hand(uuid),pulse.erp_document_issue(uuid,jsonb),pulse.erp_document_file_put(uuid,bytea),
 pulse.erp_payment_add(uuid,jsonb),pulse.erp_payment_void(uuid,text),pulse.erp_document_mark(uuid,text,text),pulse.erp_accept_link_create(uuid,text,int),
 pulse.erp_accept_open(text),pulse.erp_accept_file(text),pulse.erp_accept_decide(text,text,text,text,text,text),pulse.erp_party_hints(uuid),pulse.erp_bank_hints(uuid),pulse.erp_finance_synced_at() to pulse_api;
grant execute on function pulse.erp_log(text,uuid,text,jsonb) to pulse_api,pulse_worker;
-- migrate:down
-- Forward-only: issued documents, their numbers and the ERP log are retained.
