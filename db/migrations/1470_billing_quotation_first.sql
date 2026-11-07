-- migrate:up
-- BILLING (owner, 4 Nov 2026; Kazuk's flow of 3 Nov): quotation first. A sales person starts a blank quotation with no
-- project made first ("about one client comes in for every four quotations sent"), picks the client from Clients or a
-- person from Contacts (leads included) or types a new one in, and Pulse books the client and the point of contact in
-- Clients and Contacts only once the money is real (the invoice is issued or paid).
--
-- One model, so billing stops asking for a separate "client project":
--  * Client (pulse.client): whoever takes our service and pays us. Its billing profile (pulse.erp_party) holds the legal
--    name, the GSTIN (only when the billing includes GST) and the office / billing address the invoice prints.
--  * Contact (pulse.person + pulse.contact_profile): any person, leads included; a client's points of contact are linked
--    by pulse.client_contact (the primary one is the POC).
--  * Project (pulse.project): the work we deliver for a client, made by itself when its invoice is paid (1471). Its
--    location is the project's site (shown on the map). Work → Projects (pulse.work_project) is the same project seen
--    from the delivery side, and a "project type" is a property of it (work_project.project_category), never an object.
--  * A quotation, proforma or invoice (pulse.erp_document) stands alone: the buyer as printed, and when known the client,
--    the point of contact and the project location. It names a project only when it bills one (a package milestone).
--
-- Mapping existing data (idempotent: each step fills only what is empty; run twice, it changes nothing):
--  1. documents made for a client project get that project's client, when they have none;
--  2. they get the project's location as their project location;
--  3. documents of a client get the billing profile's contact as their point of contact;
--  4. a client billed before but without a billing profile gets one from its latest issued document's buyer
--     (source {"type":"migration_1470"}, so the down migration removes exactly those).
-- pulse.billing_model_map() does it for the company in pulse.org_id and returns what it changed. Dry run (read only, as
-- pulse_owner, with pulse.org_id set to one company): the first two counts are
--   select count(*) filter (where d.client_id is null and p.client_id is not null) step1,
--          count(*) filter (where d.site_location is null and nullif(btrim(p.location),'') is not null) step2
--   from pulse.erp_document d join pulse.project p on p.id=d.project_id;
-- and the migration RAISEs a NOTICE with a company's four counts when any is not 0. They were not taken against
-- production from this lane (no SQL there); on a fresh database and the CI tenants every count is 0.
-- Issued documents stay as issued: the guard now lets a client, contact or project location be filled in on one that had
-- none (the printed buyer never changes), and refuses any other change to them.

alter table pulse.erp_document
  add column contact_person_id uuid references pulse.person(id),
  add column site_location text check (length(site_location) <= 300);
comment on column pulse.erp_document.contact_person_id is 'BILLING (4 Nov 2026): the point of contact (a Contacts person) the document is for; booked onto the client when the money is real';
comment on column pulse.erp_document.site_location is 'BILLING (4 Nov 2026): the project location (the site, shown on the map), apart from the office / billing address in buyer.address';
create index erp_document_contact on pulse.erp_document(org_id, contact_person_id) where contact_person_id is not null;

create or replace function pulse.erp_document_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then
  if old.status<>'draft' then raise exception 'An issued document is kept; cancel it or issue a credit note' using errcode='22023';end if;
  return old;
 end if;
 if old.status<>'draft' and (new.doc_type,new.number,new.series_id,new.fy,new.issue_date,new.due_date,new.valid_until,new.project_id,new.engagement_id,
  new.milestone_id,new.against_id,new.source_id,new.seller,new.buyer,new.place_of_supply,new.reference,new.notes,new.terms,new.reverse_charge,new.zero_rated,
  new.round_total,new.tax_mode,new.taxable,new.cgst,new.sgst,new.igst,new.round_off,new.total,new.amount_words,new.design,new.issued_at,new.issued_by,new.template_id)
  is distinct from (old.doc_type,old.number,old.series_id,old.fy,old.issue_date,old.due_date,old.valid_until,old.project_id,old.engagement_id,
  old.milestone_id,old.against_id,old.source_id,old.seller,old.buyer,old.place_of_supply,old.reference,old.notes,old.terms,old.reverse_charge,old.zero_rated,
  old.round_total,old.tax_mode,old.taxable,old.cgst,old.sgst,old.igst,old.round_off,old.total,old.amount_words,old.design,old.issued_at,old.issued_by,old.template_id)
  -- BILLING (4 Nov 2026): a client, point of contact or project location is filled in on an issued document that had
  -- none (booking it, or mapping old data), never changed.
  or (old.status<>'draft' and old.client_id is not null and new.client_id is distinct from old.client_id)
  or (old.status<>'draft' and old.site_location is not null and new.site_location is distinct from old.site_location)
  or (old.status<>'draft' and old.contact_person_id is not null and new.contact_person_id is distinct from old.contact_person_id) then
  raise exception 'An issued document cannot be edited; cancel it or issue a credit note' using errcode='22023';
 end if;
 if old.status in ('cancelled','converted','declined') and new.status is distinct from old.status then raise exception 'This document is closed' using errcode='22023';end if;
 if old.status<>'draft' and new.status='draft' then raise exception 'An issued document cannot go back to draft' using errcode='22023';end if;
 new.updated_at:=now();
 return new;
end $$;

-- The mapping for the current company; the counts of what it changed. Run once per company below, and again by tests.
create function pulse.billing_model_map() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare n1 int; n2 int; n3 int; n4 int;
begin
  if pulse.current_org() is null then raise exception 'Map one company at a time' using errcode = '22023'; end if;
  update pulse.erp_document d set client_id = p.client_id from pulse.project p
    where p.id = d.project_id and d.org_id = pulse.current_org() and d.client_id is null and p.client_id is not null;
  get diagnostics n1 = row_count;
  update pulse.erp_document d set site_location = left(btrim(p.location), 300) from pulse.project p
    where p.id = d.project_id and d.org_id = pulse.current_org() and d.site_location is null and nullif(btrim(p.location), '') is not null;
  get diagnostics n2 = row_count;
  update pulse.erp_document d set contact_person_id = x.contact_person_id from pulse.erp_party x
    where x.client_id = d.client_id and d.org_id = pulse.current_org() and d.contact_person_id is null and x.contact_person_id is not null;
  get diagnostics n3 = row_count;
  insert into pulse.erp_party(org_id, client_id, legal_name, gstin, state_code, address, email, phone, contact_name, source)
    select distinct on (d.client_id) d.org_id, d.client_id, left(btrim(d.buyer->>'name'), 200),
      case when coalesce(d.buyer->>'gstin', '') ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then d.buyer->>'gstin' end,
      case when coalesce(d.buyer->>'stateCode', '') ~ '^[0-9]{2}$' then d.buyer->>'stateCode' end,
      coalesce((select array_agg(left(a, 160)) from jsonb_array_elements_text(case when jsonb_typeof(d.buyer->'address') = 'array' then d.buyer->'address' else '[]' end) a where btrim(a) <> ''), '{}'),
      left(nullif(d.buyer->>'email', ''), 200), left(nullif(d.buyer->>'phone', ''), 40), left(nullif(d.buyer->>'contactName', ''), 120),
      jsonb_build_object('type', 'migration_1470', 'document', d.id)
    from pulse.erp_document d
    where d.org_id = pulse.current_org() and d.client_id is not null and d.status not in ('draft', 'cancelled') and length(btrim(coalesce(d.buyer->>'name', ''))) between 1 and 200
      and not exists(select 1 from pulse.erp_party x where x.client_id = d.client_id)
    order by d.client_id, d.issue_date desc, d.created_at desc
    on conflict (client_id) do nothing;
  get diagnostics n4 = row_count;
  return jsonb_build_object('client', n1, 'location', n2, 'contact', n3, 'party', n4);
end $$;
revoke all on function pulse.billing_model_map() from public;

do $$
declare o record; r jsonb;
begin
  for o in select id from pulse.org order by id loop
    perform set_config('pulse.org_id', o.id::text, true);
    r := pulse.billing_model_map();
    if r <> '{"client": 0, "contact": 0, "location": 0, "party": 0}'::jsonb then
      raise notice 'BILLING 1470 company %: % documents got their project''s client, % their project location, % their point of contact; % billing profiles from past documents',
        o.id, r->>'client', r->>'location', r->>'contact', r->>'party';
    end if;
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;

-- Books the client and the point of contact of a document (and of the quotation or proforma it was made from) in Clients
-- and Contacts: the client it names, else one whose billing profile has the buyer's GSTIN, else one of the same name whose
-- e-mail or phone (its own, its billing profile's or a point of contact's) is the buyer's, else a new client (a name alone
-- never decides: two buyers called Ruvin Soniba are two clients; a duplicate is merged in Clients, a wrong match would put
-- the invoice on someone else); the contact it names, else one of the client's or anyone's with the buyer's e-mail or full
-- phone number (10 digits or more), else a new contact. The "booked" event says which rule matched. A billing profile is made from the buyer when the client has none (a profile someone saved is kept), and
-- the contact is linked to the client (primary when it has none). Running it again changes nothing. erp_book_client_do is
-- Billing's own (a paid invoice books its client, 1471); people call erp_book_client, for leadership and Finance.
create function pulse.erp_book_client_do(p_doc uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); d pulse.erp_document; b jsonb; nm text; em text; ph text; who text; gst text; st text;
  cid uuid; pid uuid; made_client boolean := false; made_contact boolean := false; chain uuid[]; crule text; prule text;
begin
  select * into d from pulse.erp_document where org_id = pulse.current_org() and id = p_doc;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  b := coalesce(d.buyer, '{}'); nm := left(btrim(coalesce(b->>'name', '')), 200);
  em := lower(nullif(btrim(coalesce(b->>'email', '')), '')); ph := nullif(regexp_replace(coalesce(b->>'phone', ''), '\D', '', 'g'), '');
  who := left(nullif(btrim(coalesce(b->>'contactName', '')), ''), 120);
  gst := case when coalesce(b->>'gstin', '') ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then b->>'gstin' end;
  st := case when coalesce(b->>'stateCode', '') ~ '^[0-9]{2}$' then b->>'stateCode' end;
  if nm = '' then raise exception 'Name the client first' using errcode = '22023'; end if;
  -- The chain: this document and the ones it was made from (an invoice from a proforma from a quotation).
  with recursive up(id, source_id) as (select d.id, d.source_id union all select x.id, x.source_id from pulse.erp_document x join up on x.id = up.source_id)
    select array_agg(id) into chain from up;
  cid := coalesce(d.client_id, (select x.client_id from pulse.erp_document x where x.id = any(chain) and x.client_id is not null limit 1));
  if cid is not null then crule := 'named'; end if;
  if cid is null and gst is not null then
    select x.client_id into cid from pulse.erp_party x where x.org_id = pulse.current_org() and x.gstin = gst limit 1;
    if cid is not null then crule := 'gstin'; end if;
  end if;
  -- BILLING (review, 4 Nov 2026): the same name only with the same e-mail or phone, and never against another GSTIN.
  if cid is null and (em is not null or length(ph) >= 10) then
    select c.id, case when em is not null and em in (lower(c.email), lower(x.email), lower(cp.email)) then 'name+email' else 'name+phone' end into cid, crule
      from pulse.client c left join pulse.erp_party x on x.client_id = c.id
      left join pulse.client_contact cc on cc.client_id = c.id left join pulse.contact_profile cp on cp.person_id = cc.person_id
      where c.org_id = pulse.current_org() and (lower(c.display_name) = lower(nm) or lower(coalesce(c.company_name, '')) = lower(nm))
        and not exists(select 1 from pulse.record_merge m where m.entity_type = 'client' and m.gone_id = c.id and m.undone_at is null)
        and (gst is null or x.gstin is null or x.gstin = gst)
        and ((em is not null and em in (lower(c.email), lower(x.email), lower(cp.email)))
          or (length(ph) >= 10 and right(ph, 10) in (right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10), right(regexp_replace(coalesce(x.phone, ''), '\D', '', 'g'), 10),
            right(regexp_replace(coalesce(cp.phone, ''), '\D', '', 'g'), 10))))
      order by c.created_at limit 1;
  end if;
  if cid is null then
    insert into pulse.client(org_id, display_name, company_name, email, phone, city, status, source, locked)
      values (pulse.current_org(), nm, nm, em, nullif(btrim(coalesce(b->>'phone', '')), ''), left(nullif(btrim(coalesce(d.site_location, '')), ''), 120), 'active', 'billing', '{display_name}')
      returning id into cid;
    if me is not null then insert into pulse.record_change(org_id, entity_type, entity_id, field, new_value, changed_by) values (pulse.current_org(), 'client', cid, 'created', nm, me); end if;
    made_client := true; crule := 'new';
  end if;
  insert into pulse.erp_party(org_id, client_id, legal_name, gstin, state_code, address, email, phone, contact_name, source, updated_by)
    values (pulse.current_org(), cid, nm, gst, st,
      coalesce((select array_agg(left(a, 160)) from jsonb_array_elements_text(case when jsonb_typeof(b->'address') = 'array' then b->'address' else '[]' end) a where btrim(a) <> ''), '{}'),
      left(em, 200), left(nullif(btrim(coalesce(b->>'phone', '')), ''), 40), who, jsonb_build_object('type', 'booked', 'document', d.id), me)
    on conflict (client_id) do nothing;
  pid := coalesce(d.contact_person_id, (select x.contact_person_id from pulse.erp_document x where x.id = any(chain) and x.contact_person_id is not null limit 1));
  if pid is not null then prule := 'named'; end if;
  if pid is null and (em is not null or length(ph) >= 10) then
    select cp.person_id, case when em is not null and lower(cp.email) = em then 'email' else 'phone' end into pid, prule
      from pulse.contact_profile cp join pulse.person p on p.id = cp.person_id
      where cp.org_id = pulse.current_org() and p.side <> 'staff'
        and ((em is not null and lower(cp.email) = em) or (length(ph) >= 10 and right(regexp_replace(coalesce(cp.phone, ''), '\D', '', 'g'), 10) = right(ph, 10)))
      order by exists(select 1 from pulse.client_contact cc where cc.client_id = cid and cc.person_id = cp.person_id) desc, cp.created_at limit 1;
  end if;
  if pid is null and who is not null then
    insert into pulse.person(org_id, display_name, side) values (pulse.current_org(), who, 'client') returning id into pid;
    insert into pulse.contact_profile(org_id, person_id, contact_type, email, phone, city, source, locked)
      values (pulse.current_org(), pid, null, em, left(nullif(btrim(coalesce(b->>'phone', '')), ''), 40), left(nullif(btrim(coalesce(d.site_location, '')), ''), 120), 'billing', '{name}');
    if me is not null then insert into pulse.record_change(org_id, entity_type, entity_id, field, new_value, changed_by) values (pulse.current_org(), 'contact', pid, 'created', who, me); end if;
    made_contact := true; prule := 'new';
  end if;
  if pid is not null then
    insert into pulse.client_contact(org_id, client_id, person_id, is_primary)
      select pulse.current_org(), cid, pid, not exists(select 1 from pulse.client_contact where client_id = cid and is_primary)
      where not exists(select 1 from pulse.client_contact where client_id = cid and person_id = pid);
    update pulse.client set primary_contact_id = pid, updated_at = now() where id = cid and primary_contact_id is null;
    update pulse.erp_party set contact_person_id = pid where client_id = cid and contact_person_id is null;
  end if;
  update pulse.erp_document set client_id = coalesce(client_id, cid), contact_person_id = coalesce(contact_person_id, pid)
    where id = any(chain) and (client_id is null or (contact_person_id is null and pid is not null));
  if made_client or made_contact or (d.client_id is null and crule <> 'named') then
    perform pulse.erp_log('document', d.id, 'booked', jsonb_build_object('clientId', cid, 'contactId', pid, 'newClient', made_client, 'newContact', made_contact,
      'clientRule', crule, 'contactRule', prule));
  end if;
  return jsonb_build_object('clientId', cid, 'contactId', pid, 'newClient', made_client, 'newContact', made_contact);
end $$;
revoke all on function pulse.erp_book_client_do(uuid) from public;

create function pulse.erp_book_client(p_doc uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if pulse.current_viewer() is null or not pulse.erp_can(true) then raise exception 'Booking a client is for leadership and the Finance role' using errcode = '42501'; end if;
  return pulse.erp_book_client_do(p_doc);
end $$;
revoke all on function pulse.erp_book_client(uuid) from public;
grant execute on function pulse.erp_book_client(uuid) to pulse_api;

-- migrate:down
drop function pulse.erp_book_client(uuid);
drop function pulse.erp_book_client_do(uuid);
drop function pulse.billing_model_map();
do $$
declare o record;
begin
  for o in select id from pulse.org loop
    perform set_config('pulse.org_id', o.id::text, true);
    delete from pulse.erp_party where org_id = o.id and source->>'type' = 'migration_1470';
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;
create or replace function pulse.erp_document_guard() returns trigger language plpgsql as $$
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
drop index pulse.erp_document_contact;
alter table pulse.erp_document drop column site_location, drop column contact_person_id;
