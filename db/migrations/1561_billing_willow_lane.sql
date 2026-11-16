-- migrate:up
-- BILLING-WL (owner, 4 Nov 2026; Akabod Soniba of Willow Lane, early-November meeting, "Billing" 1-8): billing that never
-- asks for a record before it is needed, finds what is typed however it is typed, sells warranties and serial-numbered
-- stock, numbers every change audit-safely and keeps the approval a single tap.
--  1. Forgiving search (pulse.search_norm, pulse.search_score): case, spaces and punctuation never matter ("purepower 5",
--     "Pure Power 5.0", "pure power5.0"), every word may sit anywhere ("Mifos Asohiv"), digits find a phone or a code.
--     Billing's client search (clients, contacts and Sales X-Ray leads) ranks by it; the catalogue search in the browser
--     uses the same rules (apps/web/app/lib/forgiving-search.mjs).
--  2. The customer typed into a quotation is booked when the quotation is approved: the client (a Prospect until an
--     invoice makes them Active) and their point of contact, found by GSTIN, by name with e-mail or phone, or now by the
--     e-mail or phone with a close name (the same once spaces and punctuation go, or one inside the other) when exactly
--     one client has it, so "Shantanu" renamed "Mr. Shantanu Nayak" stays one client. A dealer's phone typed for another
--     customer ("Ruvin Shah" on Majestic Infra's number) never decides: Ruvin Shah becomes his own client.
--     A Sales X-Ray lead the quotation was started from is linked to that client. Each approved quotation, proforma and
--     invoice is written on the client's and the contact's history (record_change), its story.
--  3. Extended warranty: a catalogue item has its standard warranty and the extensions it sells (months and price); an
--     extension is an add-on line of the line it extends (erp_line.warranty_months), priced and taxed like any line.
--  4. Serial-numbered stock: an item can be serialised. Stock in names each unit's serial; "set current stock" counts
--     what is on the shelf today (a number, or the list of serials) and adjusts to it; a tax invoice names the serial of
--     each unit it sells, refuses one that is not in stock and takes it out of stock when issued (cancelling puts it
--     back). pulse.erp_stock_import loads a company's opening stock from its sheet (tools/billing/stock-import.py).
--  5. Audit-safe numbering is 1471's (an approved quotation is locked; a change is a revision under the same number,
--     printed "QT/26-27/0001 R2"; a cancelled one keeps its number and a re-issue takes the next; every version filed).
--  6. Approval: a salesperson sends a draft quotation to a manager or the owner (pulse.erp_approval_ask), who is told and
--     approves it with one tap; the salesperson is told it is approved and can send it. With erp_settings.quote_approval
--     on, a quotation (and a proforma or invoice made from scratch, not from an approved quotation) is approved only by
--     leadership, an admin or the person it was sent to, and only leadership or an admin turns the setting on or off.
--     A revision starts its own approval: the earlier request and approver are cleared when it goes back to draft.
--  8. Client and contact types follow the company's industry: a company whose industry is set to one outside real estate
--     (Solar installer, Clinic, ...) is never offered "Developer", "Channel partner" or "Agent" (pulse.record_types_align,
--     on every pack change and once here). Neutral or unset industries keep their types whatever the Billing pack; a type
--     the company edited or uses on a record stays; switching back to real estate brings the archived ones back.
-- Item 7 (WhatsApp) is the API's and the page's. Synthetic data only in tests; nothing here reads or writes production.

-- ----------------------------------------------------------------------------------------- 1. forgiving search
create function pulse.search_norm(p text) returns text language sql immutable parallel safe as $$
  select lower(regexp_replace(coalesce(p, ''), '[^[:alnum:]]+', '', 'g'))
$$;
-- 100 a whole field, 85 its start, 70 inside it, 50 every word somewhere in the fields together, else 0.
create function pulse.search_score(p_q text, p_fields text[]) returns int language plpgsql immutable parallel safe as $$
declare q text := pulse.search_norm(p_q); f text; h text; best int := 0; ws text[]; w text; whole text;
begin
  if q = '' then return 0; end if;
  foreach f in array coalesce(p_fields, '{}') loop
    h := pulse.search_norm(f);
    continue when h = '';
    if h = q then return 100; end if;
    if left(h, length(q)) = q then best := greatest(best, 85);
    elsif position(q in h) > 0 then best := greatest(best, 70); end if;
  end loop;
  if best > 0 then return best; end if;
  ws := array(select pulse.search_norm(x) from regexp_split_to_table(lower(p_q), '[^[:alnum:].]+') x where pulse.search_norm(x) <> '');
  if cardinality(ws) = 0 then return 0; end if;
  whole := pulse.search_norm(array_to_string(p_fields, ' '));
  foreach w in array ws loop
    if position(w in whole) = 0 then return 0; end if;
  end loop;
  return 50;
end $$;
grant execute on function pulse.search_norm(text), pulse.search_score(text, text[]) to pulse_api, pulse_worker;

-- -------------------------------------------------------------------------- 2. the quotation books its customer
alter table pulse.erp_document add column sx_lead_id uuid;
comment on column pulse.erp_document.sx_lead_id is 'BILLING-WL (4 Nov 2026): the Sales X-Ray lead (sales_xray_lead.sx_lead_id) the document was started for';
-- Two names for the same customer: equal once case, spaces and punctuation go, or one inside the other ("Shantanu" and
-- "Mr. Shantanu Nayak"), or every word of the shorter one in the longer, in any order and without Mr, Mrs, Ms, Dr or
-- Shri ("Nayak Shantanu"); each has at least three letters or digits. "Ruvin Shah" and "Majestic Infra" are not.
create function pulse.erp_name_close(p_a text, p_b text) returns boolean language sql immutable parallel safe as $$
  select coalesce(length(a) >= 3 and length(b) >= 3 and (position(a in b) > 0 or position(b in a) > 0
    or (cardinality(wa) > 0 and cardinality(wb) > 0 and (wa <@ wb or wb <@ wa))), false)
  from (select pulse.search_norm(p_a) a, pulse.search_norm(p_b) b,
    array(select w from regexp_split_to_table(lower(coalesce(p_a, '')), '[^[:alnum:]]+') w where length(w) >= 2 and w not in ('mr', 'mrs', 'ms', 'dr', 'shri', 'smt')) wa,
    array(select w from regexp_split_to_table(lower(coalesce(p_b, '')), '[^[:alnum:]]+') w where length(w) >= 2 and w not in ('mr', 'mrs', 'ms', 'dr', 'shri', 'smt')) wb) n
$$;

-- 1470's booking, as amended: a quotation books a Prospect, an invoice makes the client Active; the e-mail or the phone
-- alone finds a client when exactly one has it (a renamed customer stays one client); the lead is linked; the story.
create or replace function pulse.erp_book_client_do(p_doc uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); d pulse.erp_document; b jsonb; nm text; em text; ph text; who text; gst text; st text;
  cid uuid; pid uuid; made_client boolean := false; made_contact boolean := false; chain uuid[]; crule text; prule text; n int; story text;
begin
  select * into d from pulse.erp_document where org_id = pulse.current_org() and id = p_doc;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  b := coalesce(d.buyer, '{}'); nm := left(btrim(coalesce(b->>'name', '')), 200);
  em := lower(nullif(btrim(coalesce(b->>'email', '')), '')); ph := nullif(regexp_replace(coalesce(b->>'phone', ''), '\D', '', 'g'), '');
  who := left(nullif(btrim(coalesce(b->>'contactName', '')), ''), 120);
  gst := case when coalesce(b->>'gstin', '') ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then b->>'gstin' end;
  st := case when coalesce(b->>'stateCode', '') ~ '^[0-9]{2}$' then b->>'stateCode' end;
  if nm = '' then raise exception 'Name the client first' using errcode = '22023'; end if;
  with recursive up(id, source_id) as (select d.id, d.source_id union all select x.id, x.source_id from pulse.erp_document x join up on x.id = up.source_id)
    select array_agg(id) into chain from up;
  cid := coalesce(d.client_id, (select x.client_id from pulse.erp_document x where x.id = any(chain) and x.client_id is not null limit 1));
  if cid is not null then crule := 'named'; end if;
  if cid is null and d.sx_lead_id is not null then
    select l.client_id into cid from pulse.sales_xray_lead l where l.org_id = pulse.current_org() and l.sx_lead_id = d.sx_lead_id and l.client_id is not null;
    if cid is not null then crule := 'lead'; end if;
  end if;
  if cid is null and gst is not null then
    select x.client_id into cid from pulse.erp_party x where x.org_id = pulse.current_org() and x.gstin = gst limit 1;
    if cid is not null then crule := 'gstin'; end if;
  end if;
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
  -- BILLING-WL: the same e-mail or full phone number, whatever the name now says, when exactly one client has it.
  if cid is null and (em is not null or length(ph) >= 10) then
    select count(distinct c.id), min(c.id::text)::uuid into n, cid
      from pulse.client c left join pulse.erp_party x on x.client_id = c.id
      left join pulse.client_contact cc on cc.client_id = c.id left join pulse.contact_profile cp on cp.person_id = cc.person_id
      left join pulse.person cpp on cpp.id = cc.person_id
      where c.org_id = pulse.current_org() and c.client_type is distinct from 'internal'
        and not exists(select 1 from pulse.record_merge m where m.entity_type = 'client' and m.gone_id = c.id and m.undone_at is null)
        and (gst is null or x.gstin is null or x.gstin = gst)
        and ((em is not null and em in (lower(c.email), lower(x.email), lower(cp.email)))
          or (length(ph) >= 10 and right(ph, 10) in (right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10), right(regexp_replace(coalesce(x.phone, ''), '\D', '', 'g'), 10),
            right(regexp_replace(coalesce(cp.phone, ''), '\D', '', 'g'), 10))))
        -- the name must be close too: a dealer's or installer's number is typed for many customers (review, 5 Nov 2026)
        and (pulse.erp_name_close(nm, c.display_name) or pulse.erp_name_close(nm, c.company_name) or pulse.erp_name_close(nm, x.legal_name)
          or pulse.erp_name_close(coalesce(who, nm), cpp.display_name));
    if n = 1 then crule := case when em is not null then 'email' else 'phone' end; else cid := null; end if;
  end if;
  if cid is null then
    insert into pulse.client(org_id, display_name, company_name, email, phone, city, status, source, locked)
      values (pulse.current_org(), nm, nm, em, nullif(btrim(coalesce(b->>'phone', '')), ''), left(nullif(btrim(coalesce(d.site_location, '')), ''), 120),
        case when d.doc_type = 'quotation' then 'prospect' else 'active' end, 'billing', '{display_name}')
      returning id into cid;
    if me is not null then insert into pulse.record_change(org_id, entity_type, entity_id, field, new_value, changed_by) values (pulse.current_org(), 'client', cid, 'created', nm, me); end if;
    made_client := true; crule := 'new';
  elsif d.doc_type = 'invoice' then
    update pulse.client set status = 'active', updated_at = now() where id = cid and status = 'prospect';
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
        -- already this client's contact, or the same person by name: a shared dealer's number is not the customer
        and (exists(select 1 from pulse.client_contact cc where cc.client_id = cid and cc.person_id = cp.person_id) or pulse.erp_name_close(coalesce(who, nm), p.display_name))
      order by exists(select 1 from pulse.client_contact cc where cc.client_id = cid and cc.person_id = cp.person_id) desc, cp.created_at limit 1;
  end if;
  -- A person billed by their own name (no separate contact name) is their own point of contact.
  who := coalesce(who, case when made_client and (em is not null or length(ph) >= 10) then nm end);
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
  if d.sx_lead_id is not null then
    update pulse.sales_xray_lead set client_id = cid, updated_at = now() where org_id = pulse.current_org() and sx_lead_id = d.sx_lead_id and client_id is null;
  end if;
  -- The story: the approved document on the client's and the contact's history, once per document and number.
  if d.status <> 'draft' and d.number is not null then
    story := left(format('%s %s%s approved · ₹%s', case d.doc_type when 'quotation' then 'Quotation' when 'proforma' then 'Proforma' when 'invoice' then 'Tax invoice' else 'Credit note' end,
      d.number, case when d.doc_type = 'quotation' and d.revision > 0 then ' R' || (d.revision + 1) else '' end, to_char(d.total / 100.0, 'FM99,99,99,99,990.00')), 300);
    insert into pulse.record_change(org_id, entity_type, entity_id, field, new_value, changed_by)
      select pulse.current_org(), e.t, e.i, 'billing', story, me from (values ('client', cid), ('contact', pid)) e(t, i)
      where e.i is not null and not exists(select 1 from pulse.record_change r where r.org_id = pulse.current_org() and r.entity_type = e.t and r.entity_id = e.i
        and r.field = 'billing' and r.new_value = story);
  end if;
  if made_client or made_contact or (d.client_id is null and crule <> 'named') then
    perform pulse.erp_log('document', d.id, 'booked', jsonb_build_object('clientId', cid, 'contactId', pid, 'newClient', made_client, 'newContact', made_contact,
      'clientRule', crule, 'contactRule', prule));
  end if;
  return jsonb_build_object('clientId', cid, 'contactId', pid, 'newClient', made_client, 'newContact', made_contact);
end $$;
revoke all on function pulse.erp_book_client_do(uuid) from public;

-- Who the customer typed in already is, before anything is saved: the clients and contacts with that e-mail or phone
-- (Billing's writers; the composer offers "use this profile" instead of a second one).
create function pulse.erp_party_twins(p_email text, p_phone text) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare em text := lower(nullif(btrim(coalesce(p_email, '')), '')); ph text := right(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'), 10);
begin
  perform pulse.erp_require(true);
  if em is null and length(ph) < 10 then return jsonb_build_object('clients', '[]'::jsonb, 'contacts', '[]'::jsonb); end if;
  return jsonb_build_object(
    'clients', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.display_name, 'phone', c.phone, 'email', c.email,
        'why', case when em is not null and em in (lower(c.email), lower(x.email)) then 'email' else 'phone' end) order by c.created_at)
      from pulse.client c left join pulse.erp_party x on x.client_id = c.id
      where c.org_id = pulse.current_org() and c.client_type is distinct from 'internal'
        and not exists(select 1 from pulse.record_merge m where m.entity_type = 'client' and m.gone_id = c.id and m.undone_at is null)
        and ((em is not null and em in (lower(c.email), lower(x.email)))
          or (length(ph) = 10 and ph in (right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10), right(regexp_replace(coalesce(x.phone, ''), '\D', '', 'g'), 10))))), '[]'::jsonb),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'phone', cp.phone, 'email', cp.email,
        'why', case when em is not null and lower(cp.email) = em then 'email' else 'phone' end) order by cp.created_at)
      from pulse.contact_profile cp join pulse.person p on p.id = cp.person_id
      where cp.org_id = pulse.current_org() and p.side <> 'staff' and p.status = 'active'
        and not exists(select 1 from pulse.record_merge m where m.entity_type = 'contact' and m.gone_id = p.id and m.undone_at is null)
        and ((em is not null and lower(cp.email) = em) or (length(ph) = 10 and right(regexp_replace(coalesce(cp.phone, ''), '\D', '', 'g'), 10) = ph))), '[]'::jsonb));
end $$;
revoke all on function pulse.erp_party_twins(text, text) from public;
grant execute on function pulse.erp_party_twins(text, text) to pulse_api;

-- ------------------------------------------------------------------------------------------ 3. extended warranty
alter table pulse.erp_item
  add column warranty_months int check (warranty_months between 0 and 600),
  add column warranty_options jsonb not null default '[]' check (jsonb_typeof(warranty_options) = 'array' and jsonb_array_length(warranty_options) <= 6),
  add column serialised boolean not null default false;
comment on column pulse.erp_item.warranty_options is 'BILLING-WL (4 Nov 2026): the warranty extensions sold with the item, [{months, price}] (price in paise, before GST)';
comment on column pulse.erp_item.serialised is 'BILLING-WL (4 Nov 2026): each unit has a serial number (stock in names them; an invoice names the ones it sells)';
alter table pulse.erp_line
  add column warranty_months int check (warranty_months between 1 and 600),
  add column serials text[] not null default '{}' check (cardinality(serials) <= 500);
comment on column pulse.erp_line.warranty_months is 'BILLING-WL (4 Nov 2026): an extended-warranty line (an add-on of the line it extends): the months it adds';
comment on column pulse.erp_line.serials is 'BILLING-WL (4 Nov 2026): the serial numbers of the units a tax invoice line sells';

-- ------------------------------------------------------------------------------------- 4. serial-numbered stock
create table pulse.erp_stock_serial(
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references pulse.erp_item(id),
  serial text not null check (serial ~ '^[A-Za-z0-9][A-Za-z0-9./_-]{0,59}$'),
  status text not null default 'in_stock' check (status in ('in_stock', 'sold', 'removed')),
  document_id uuid references pulse.erp_document(id),
  note text check (length(note) <= 300),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, item_id, serial));
create index erp_stock_serial_item on pulse.erp_stock_serial(org_id, item_id, status);
create index erp_stock_serial_document on pulse.erp_stock_serial(org_id, document_id) where document_id is not null;
alter table pulse.erp_stock_serial enable row level security;
alter table pulse.erp_stock_serial force row level security;
create policy tenant on pulse.erp_stock_serial using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy erp_read on pulse.erp_stock_serial as restrictive for select to pulse_api using ((select pulse.erp_can(false)));
grant select on pulse.erp_stock_serial to pulse_api, pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.erp_stock_serial for each row execute function pulse.audit_mutation();

-- A serial as people type or scan it: trimmed, inner spaces gone, upper case.
create function pulse.erp_serial_clean(p text) returns text language sql immutable as $$ select upper(regexp_replace(btrim(coalesce(p, '')), '\s+', '', 'g')) $$;

-- Stock in: a number, or for a serialised item the serials themselves (one unit each, none already in stock or sold).
create function pulse.erp_stock_receive(p_item uuid, p_qty numeric, p_serials text[], p_note text, p_on date, p_unit_cost bigint) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.erp_require(true); it pulse.erp_item; s text[]; dup text; mid uuid; q numeric;
begin
  select * into it from pulse.erp_item where org_id = pulse.current_org() and id = p_item;
  if it.id is null then raise exception 'Item not found' using errcode = 'P0002'; end if;
  if it.serialised then
    s := array(select distinct pulse.erp_serial_clean(x) from unnest(coalesce(p_serials, '{}')) x where pulse.erp_serial_clean(x) <> '');
    if cardinality(s) = 0 then raise exception 'Scan or type the serial number of each unit' using errcode = '22023'; end if;
    if cardinality(s) > 500 then raise exception 'Up to 500 serial numbers at a time' using errcode = '22023'; end if;
    select x into dup from unnest(s) x where x !~ '^[A-Za-z0-9][A-Za-z0-9./_-]{0,59}$' limit 1;
    if dup is not null then raise exception 'Serial number % has characters a serial does not use', dup using errcode = '22023'; end if;
    select serial into dup from pulse.erp_stock_serial where org_id = pulse.current_org() and item_id = p_item and serial = any(s) and status <> 'removed' limit 1;
    if dup is not null then raise exception 'Serial number % is already in Pulse: in stock or sold', dup using errcode = '22023'; end if;
    q := cardinality(s);
  else
    q := p_qty;
    if q is null or q <= 0 then raise exception 'Enter the quantity' using errcode = '22023'; end if;
  end if;
  insert into pulse.erp_stock_move(org_id, item_id, kind, qty, unit_cost, note, on_date, created_by)
    values (pulse.current_org(), p_item, 'in', q, p_unit_cost, left(coalesce(p_note, ''), 500), coalesce(p_on, (now() at time zone pulse.org_time_zone())::date), me) returning id into mid;
  if it.serialised then
    insert into pulse.erp_stock_serial(org_id, item_id, serial, status, note, created_by) select pulse.current_org(), p_item, x, 'in_stock', left(p_note, 300), me from unnest(s) x
      on conflict (org_id, item_id, serial) do update set status = 'in_stock', document_id = null, note = excluded.note, updated_at = now();
  end if;
  perform pulse.erp_log('stock', p_item, 'in', jsonb_build_object('qty', q, 'serials', coalesce(cardinality(s), 0)));
  return jsonb_build_object('moveId', mid, 'qty', q, 'onHand', pulse.erp_on_hand(p_item));
end $$;

-- Set the current stock: what is on the shelf today (a number; for a serialised item, the serials in stock now). The
-- difference is one adjustment; serials no longer there are marked removed, new ones come in.
create function pulse.erp_stock_set_do(p_item uuid, p_qty numeric, p_serials text[], p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); it pulse.erp_item; s text[]; dup text; target numeric; diff numeric; gone int := 0; added int := 0;
begin
  select * into it from pulse.erp_item where org_id = pulse.current_org() and id = p_item;
  if it.id is null then raise exception 'Item not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('erp-stock:' || p_item::text, 0));
  if it.serialised then
    s := array(select distinct pulse.erp_serial_clean(x) from unnest(coalesce(p_serials, '{}')) x where pulse.erp_serial_clean(x) <> '');
    select x into dup from unnest(s) x where x !~ '^[A-Za-z0-9][A-Za-z0-9./_-]{0,59}$' limit 1;
    if dup is not null then raise exception 'Serial number % has characters a serial does not use', dup using errcode = '22023'; end if;
    select serial into dup from pulse.erp_stock_serial where org_id = pulse.current_org() and item_id = p_item and serial = any(s) and status = 'sold' limit 1;
    if dup is not null then raise exception 'Serial number % is already sold', dup using errcode = '22023'; end if;
    update pulse.erp_stock_serial set status = 'removed', updated_at = now(), note = left(coalesce(p_note, 'Not on the shelf at the stock count'), 300)
      where org_id = pulse.current_org() and item_id = p_item and status = 'in_stock' and not (serial = any(s));
    get diagnostics gone = row_count;
    insert into pulse.erp_stock_serial(org_id, item_id, serial, status, note, created_by) select pulse.current_org(), p_item, x, 'in_stock', left(p_note, 300), me from unnest(s) x
      where not exists(select 1 from pulse.erp_stock_serial e where e.org_id = pulse.current_org() and e.item_id = p_item and e.serial = x and e.status = 'in_stock')
      on conflict (org_id, item_id, serial) do update set status = 'in_stock', document_id = null, updated_at = now();
    get diagnostics added = row_count;
    target := cardinality(s);
  else
    target := p_qty;
    if target is null or target < 0 then raise exception 'Enter the stock on hand now: 0 or more' using errcode = '22023'; end if;
  end if;
  diff := target - pulse.erp_on_hand(p_item);
  if diff <> 0 then
    insert into pulse.erp_stock_move(org_id, item_id, kind, qty, note, created_by)
      values (pulse.current_org(), p_item, 'adjust', diff, left(coalesce(nullif(btrim(p_note), ''), 'Stock count'), 500), me);
  end if;
  perform pulse.erp_log('stock', p_item, 'set', jsonb_build_object('onHand', target, 'change', diff, 'serialsIn', added, 'serialsOut', gone));
  return jsonb_build_object('onHand', pulse.erp_on_hand(p_item), 'change', diff, 'serialsIn', added, 'serialsOut', gone);
end $$;
revoke all on function pulse.erp_stock_set_do(uuid, numeric, text[], text) from public;
create function pulse.erp_stock_set(p_item uuid, p_qty numeric, p_serials text[], p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform pulse.erp_require(true);
  return pulse.erp_stock_set_do(p_item, p_qty, p_serials, p_note);
end $$;
revoke all on function pulse.erp_stock_receive(uuid, numeric, text[], text, date, bigint), pulse.erp_stock_set(uuid, numeric, text[], text) from public;
grant execute on function pulse.erp_stock_receive(uuid, numeric, text[], text, date, bigint), pulse.erp_stock_set(uuid, numeric, text[], text) to pulse_api;

-- A tax invoice and its serials: issuing it needs one serial per unit of each serialised item it sells, each in stock,
-- and takes them out of stock (0540's move counts them); cancelling it puts them back. Runs before 0540's follower.
create function pulse.erp_serial_follow() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l record; s text[]; bad text; n int;
begin
  if new.doc_type <> 'invoice' or new.status is not distinct from old.status then return null; end if;
  if not coalesce((select inventory_enabled from pulse.erp_settings where org_id = new.org_id), false) then return null; end if;
  if old.status = 'draft' and new.status not in ('draft', 'cancelled') then
    for l in select ln.position, ln.qty, ln.serials, i.id item_id, i.name from pulse.erp_line ln join pulse.erp_item i on i.id = ln.item_id
        where ln.document_id = new.id and i.serialised and i.track_stock and not coalesce(ln.not_needed, false) order by ln.position loop
      s := array(select distinct pulse.erp_serial_clean(x) from unnest(l.serials) x where pulse.erp_serial_clean(x) <> '');
      if cardinality(s) <> l.qty then
        raise exception 'Pick % serial number% for %: % picked', trim_scale(l.qty), case when l.qty = 1 then '' else 's' end, btrim(regexp_replace(l.name, '[(){}"]+', '', 'g')), cardinality(s)
          using errcode = '22023'; end if;
      select x into bad from unnest(s) x where not exists(select 1 from pulse.erp_stock_serial e where e.org_id = new.org_id and e.item_id = l.item_id and e.serial = x and e.status = 'in_stock') limit 1;
      if bad is not null then raise exception 'Serial number % is not in stock: record it as stock in first, or pick another', bad using errcode = '22023'; end if;
      update pulse.erp_stock_serial set status = 'sold', document_id = new.id, updated_at = now() where org_id = new.org_id and item_id = l.item_id and serial = any(s) and status = 'in_stock';
      get diagnostics n = row_count;
      if n <> cardinality(s) then raise exception 'Another invoice has just taken one of these serial numbers; pick again' using errcode = '40001'; end if;
    end loop;
  elsif new.status = 'cancelled' and old.status <> 'draft' then
    update pulse.erp_stock_serial set status = 'in_stock', document_id = null, updated_at = now(), note = left('Invoice ' || coalesce(new.number, '') || ' cancelled', 300)
      where org_id = new.org_id and document_id = new.id and status = 'sold';
  end if;
  return null;
end $$;
create trigger erp_serial_follow after update of status on pulse.erp_document for each row execute function pulse.erp_serial_follow();
revoke all on function pulse.erp_serial_follow() from public;

-- Opening stock from a company's sheet: rows [{code?, name?, qty?, serials?: [..], unitCost?}] matched to the catalogue
-- by code, else by name (forgivingly), each set to the sheet's count. A dry run (p_apply false) changes nothing and says
-- what would happen.
create function pulse.erp_stock_import_do(p_rows jsonb, p_apply boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r jsonb; it pulse.erp_item; k int := 0; done jsonb := '[]'; missing jsonb := '[]'; serials text[]; qty numeric; res jsonb; dup int;
begin
  if pulse.current_org() is null then raise exception 'Choose the company first' using errcode = '22023'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'The sheet is a list of up to 5,000 rows' using errcode = '22023'; end if;
  if p_apply and not coalesce((select inventory_enabled from pulse.erp_settings where org_id = pulse.current_org()), false) then
    raise exception 'Turn stock on in Billing settings before importing it' using errcode = '22023'; end if;
  for r in select x from jsonb_array_elements(p_rows) x loop
    k := k + 1;
    select i.* into it from pulse.erp_item i where i.org_id = pulse.current_org() and i.status <> 'archived' and i.kind <> 'package'
      and (nullif(btrim(r->>'code'), '') is not null and pulse.search_norm(i.code) = pulse.search_norm(r->>'code')
        or nullif(btrim(r->>'code'), '') is null and pulse.search_norm(i.name) = pulse.search_norm(r->>'name'))
      order by i.updated_at desc limit 1;
    if it.id is null then missing := missing || jsonb_build_object('row', k, 'code', r->>'code', 'name', r->>'name'); continue; end if;
    serials := array(select pulse.erp_serial_clean(x) from jsonb_array_elements_text(coalesce(r->'serials', '[]')) x where pulse.erp_serial_clean(x) <> '');
    select count(*) - count(distinct x) into dup from unnest(serials) x;
    if dup > 0 then raise exception 'Row %: a serial number is listed twice', k using errcode = '22023'; end if;
    qty := case when cardinality(serials) > 0 then cardinality(serials) else nullif(r->>'qty', '')::numeric end;
    if qty is null or qty < 0 then raise exception 'Row %: give the quantity or the serial numbers', k using errcode = '22023'; end if;
    if it.serialised and cardinality(serials) = 0 and qty > 0 then
      raise exception 'Row %: % has a serial number per unit: list the serial numbers', k, btrim(regexp_replace(it.name, '[(){}"]+', '', 'g')) using errcode = '22023'; end if;
    if p_apply then
      if not it.track_stock or (cardinality(serials) > 0 and not it.serialised) then
        update pulse.erp_item set track_stock = true, serialised = serialised or cardinality(serials) > 0 where id = it.id;
      end if;
      res := pulse.erp_stock_set_do(it.id, qty, serials, 'Opening stock (import)');
    end if;
    done := done || jsonb_build_object('row', k, 'itemId', it.id, 'item', it.name, 'qty', qty, 'serials', cardinality(serials), 'was', pulse.erp_on_hand(it.id) - coalesce((res->>'change')::numeric, 0));
    res := null;
  end loop;
  if p_apply then perform pulse.erp_log('stock', null, 'import', jsonb_build_object('rows', k, 'matched', jsonb_array_length(done), 'missing', jsonb_array_length(missing))); end if;
  return jsonb_build_object('applied', p_apply, 'rows', k, 'matched', done, 'missing', missing);
end $$;
revoke all on function pulse.erp_stock_import_do(jsonb, boolean) from public;
-- Billing's writers (the API), and the operator's script, which runs as the worker with no viewer
-- (tools/billing/stock-import.py); pulse_api cannot call the operator's.
create function pulse.erp_stock_import(p_rows jsonb, p_apply boolean) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
begin perform pulse.erp_require(true); return pulse.erp_stock_import_do(p_rows, p_apply); end $$;
create function pulse.erp_stock_import_operator(p_rows jsonb, p_apply boolean) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if pulse.current_viewer() is not null then raise exception 'The operator''s import runs without a signed-in person; use Billing''s own import' using errcode = '42501'; end if;
  return pulse.erp_stock_import_do(p_rows, p_apply);
end $$;
revoke all on function pulse.erp_stock_import(jsonb, boolean), pulse.erp_stock_import_operator(jsonb, boolean) from public;
grant execute on function pulse.erp_stock_import(jsonb, boolean) to pulse_api;
grant execute on function pulse.erp_stock_import_operator(jsonb, boolean) to pulse_worker;

-- ------------------------------------------------------------------------------------------------- 6. approval
alter table pulse.erp_settings add column quote_approval boolean not null default false;
comment on column pulse.erp_settings.quote_approval is 'BILLING-WL (4 Nov 2026): quotations are approved only by leadership, an admin or the person they were sent to for approval';
alter table pulse.erp_document
  add column approval_to uuid references pulse.person(id),
  add column approval_asked_by uuid references pulse.person(id),
  add column approval_asked_at timestamptz,
  add column approval_note text check (length(approval_note) <= 500);

-- Who approves: leadership and admins first, then Billing's other writers (a sales manager with the money grants).
create function pulse.erp_approvers() returns table(id uuid, name text, lead boolean) language sql stable security definer set search_path = pulse, pg_temp as $$
  select p.id, p.display_name, bool_or(r.role_key in ('leadership', 'admin'))
  from pulse.person p join pulse.role_assignment r on r.person_id = p.id and r.org_id = p.org_id
  where p.org_id = pulse.current_org() and p.side = 'staff' and p.status = 'active' and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')
    and (r.role_key in ('leadership', 'finance') or r.role_key = 'admin' and exists(select 1 from pulse.money_permission m where m.person_id = p.id and m.permission = 'money.plan.write' and m.revoked_at is null))
  group by p.id, p.display_name order by 3 desc, 2
$$;
revoke all on function pulse.erp_approvers() from public;
grant execute on function pulse.erp_approvers() to pulse_api;

-- Send a draft for approval (again: a reminder) to one approver, who is told in Pulse.
create function pulse.erp_approval_ask(p_doc uuid, p_to uuid, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.erp_require(true); d pulse.erp_document; nm text; asked int;
begin
  select * into d from pulse.erp_document where org_id = pulse.current_org() and id = p_doc for update;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if d.status <> 'draft' then raise exception 'Only a draft waits for approval' using errcode = '22023'; end if;
  if p_to is null or p_to = me or not exists(select 1 from pulse.erp_approvers() a where a.id = p_to) then
    raise exception 'Choose a manager or the owner to approve it' using errcode = '22023'; end if;
  if coalesce(btrim(d.buyer->>'name'), '') = '' then raise exception 'Name the client to bill' using errcode = '22023'; end if;
  if not exists(select 1 from pulse.erp_line where document_id = d.id) then raise exception 'Add at least one line' using errcode = '22023'; end if;
  -- Reminders are counted per revision: R2's first request is a request, not a reminder (review, 5 Nov 2026).
  asked := (select count(*) from pulse.erp_event e where e.subject_id = d.id and e.kind = 'approval_asked'
    and coalesce((e.detail->>'revision')::int, 0) = d.revision)::int;
  update pulse.erp_document set approval_to = p_to, approval_asked_by = me, approval_asked_at = now(), approval_note = nullif(left(btrim(coalesce(p_note, '')), 500), ''), updated_by = me where id = d.id;
  nm := coalesce(nullif(btrim(d.buyer->>'name'), ''), 'a customer');
  perform pulse.work_notify(p_to, 'billing.approval', 'erp_document', d.id, 'billing.approval:' || d.id || ':' || d.revision || ':' || asked, left(format('Approve the %s for %s: ₹%s',
    replace(d.doc_type, '_', ' '), nm, to_char(d.total / 100.0, 'FM99,99,99,99,990')), 160), '/erp/documents/' || d.id, 'task');
  perform pulse.erp_log('document', d.id, 'approval_asked', jsonb_build_object('to', p_to, 'note', nullif(left(btrim(coalesce(p_note, '')), 500), ''), 'reminder', asked > 0,
    'revision', d.revision));
  return jsonb_build_object('approvalTo', p_to, 'reminder', asked > 0);
end $$;
revoke all on function pulse.erp_approval_ask(uuid, uuid, text) from public;
grant execute on function pulse.erp_approval_ask(uuid, uuid, text) to pulse_api;

-- Before an approval (issue): with quote_approval on, a quotation, and a proforma or tax invoice made from scratch (not
-- from an approved quotation), is approved by leadership, an admin or its approver. A revision going back to draft
-- starts its own approval: the earlier request, approver and note are cleared (review, 5 Nov 2026).
create function pulse.erp_approval_gate() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if old.status <> 'draft' and new.status = 'draft' then
    new.approval_to := null; new.approval_asked_by := null; new.approval_asked_at := null; new.approval_note := null;
    return new;
  end if;
  if old.status = 'draft' and new.status = 'issued' and pulse.current_viewer() is not null
    and (new.doc_type = 'quotation' or (new.doc_type in ('proforma', 'invoice') and new.source_id is null))
    and coalesce((select quote_approval from pulse.erp_settings where org_id = new.org_id), false)
    and not pulse.viewer_is('leadership', 'admin') and new.approval_to is distinct from pulse.current_viewer() then
    raise exception 'A manager or the owner approves this %: send it for approval', case new.doc_type when 'quotation' then 'quotation' when 'proforma' then 'proforma' else 'invoice' end
      using errcode = '42501';
  end if;
  return new;
end $$;

-- Only leadership or an admin turns "wait for approval" on or off: a salesperson who must send for approval cannot
-- switch it off and approve their own quotation (review, 5 Nov 2026).
create function pulse.erp_approval_setting_guard() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if pulse.current_viewer() is not null and not pulse.viewer_is('leadership', 'admin')
    and new.quote_approval is distinct from (case when tg_op = 'INSERT' then false else old.quote_approval end) then
    raise exception 'Only leadership or an admin can change whether quotations wait for approval' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function pulse.erp_approval_setting_guard() from public;
create trigger erp_approval_setting_guard before insert or update of quote_approval on pulse.erp_settings for each row execute function pulse.erp_approval_setting_guard();
create trigger erp_approval_gate before update of status on pulse.erp_document for each row execute function pulse.erp_approval_gate();

-- After it: whoever sent it for approval is told, so they send it to the customer.
create function pulse.erp_approval_follow() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if old.status = 'draft' and new.status = 'issued' and new.approval_asked_by is not null then
    perform pulse.work_notify(new.approval_asked_by, 'billing.approved', 'erp_document', new.id, 'billing.approved:' || new.id || ':' || new.revision,
      left(format('Approved: %s %s%s for %s. Send it now', case new.doc_type when 'quotation' then 'quotation' when 'proforma' then 'proforma' else 'invoice' end, new.number,
        case when new.doc_type = 'quotation' and new.revision > 0 then ' R' || (new.revision + 1) else '' end, coalesce(nullif(btrim(new.buyer->>'name'), ''), 'the customer')), 160),
      '/erp/documents/' || new.id, 'task');
    perform pulse.erp_log('document', new.id, 'approval_given', jsonb_build_object('askedBy', new.approval_asked_by));
  end if;
  return null;
end $$;
create trigger erp_approval_follow after update of status on pulse.erp_document for each row execute function pulse.erp_approval_follow();
revoke all on function pulse.erp_approval_gate(), pulse.erp_approval_follow() from public;

-- The two notices reach only the approver of a draft and the person who asked (a checked text patch, as 1485 does).
select pulse.check_values_add('pulse.notification'::regclass, 'notification_event_type_check', 'event_type', array['billing.approval', 'billing.approved']);
create function pulse.erp_notice_allowed(p_person uuid, p_type text, p_subject text, p_id uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select p_subject = 'erp_document' and exists(select 1 from pulse.erp_document d where d.org_id = pulse.current_org() and d.id = p_id
    and ((p_type = 'billing.approval' and d.status = 'draft' and d.approval_to = p_person) or (p_type = 'billing.approved' and d.approval_asked_by = p_person)))
$$;
revoke all on function pulse.erp_notice_allowed(uuid, text, text, uuid) from public;
do $$
declare definition text; anchor text;
begin
  definition := pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
  anchor := $r$ if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active') then return false;end if;$r$;
  if (length(definition) - length(replace(definition, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'migration 1500: notification_recipient_allowed changed shape'; end if;
  execute replace(definition, anchor, anchor || $r$
 -- BILLING-WL (1500): a quotation sent for approval, and its approval.
 if p_type in ('billing.approval','billing.approved') then return erp_notice_allowed(p_person,p_type,p_subject,p_id);end if;$r$);
end $$;

-- ----------------------------------------------------------------------- 8. client types follow the industry
-- Real estate keeps 0213's types. Any other company (its industry pack, or a Billing pack that is not real estate's) gets
-- its own trade's types, and Developer, Channel partner and Agent (and Model, outside agencies) are archived: they stay on
-- the records that have them but are never offered again. Running it again changes nothing.
-- Review (5 Nov 2026): only an industry pack set to a named trade outside real estate does this, never the Billing pack
-- alone and never a neutral or unset industry; a type the company edited or has on any record is never archived; the
-- types archived here are marked (archived_by_industry) and come back when the industry is set to real estate again.
alter table pulse.record_type add column archived_by_industry boolean not null default false;
comment on column pulse.record_type.archived_by_industry is 'BILLING-WL (5 Nov 2026): archived by record_types_align for a non-real-estate industry; restored when the industry is real estate again';
create function pulse.record_types_align() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
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
  if pk is null or pk = 'neutral' then return jsonb_build_object('industry', null); end if; -- not chosen: today's types stay
  if not exists(select 1 from record_type where org_id = current_org()) then return null; end if; -- the defaults seed first, then align
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

-- 0213's lazy defaults, then the industry's.
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

create function pulse.record_types_follow_pack() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform set_config('pulse.org_id', new.org_id::text, true) where current_org() is null;
  if new.org_id = current_org() then perform record_types_align(); end if;
  return null;
end $$;
revoke all on function pulse.record_types_follow_pack() from public;
create trigger record_types_follow_pack after insert or update of pack_key on pulse.org_pack for each row execute function pulse.record_types_follow_pack();
-- (the Billing pack alone never changes the types: a real-estate agency may bill with the agency pack)

do $$
declare o record; r jsonb;
begin
  for o in select id from pulse.org loop
    perform set_config('pulse.org_id', o.id::text, true);
    r := pulse.record_types_align();
    if coalesce((r->>'archived')::int, 0) + coalesce((r->>'added')::int, 0) + coalesce((r->>'restored')::int, 0) > 0 then raise notice 'record types for %: %', o.id, r; end if;
  end loop;
  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
drop trigger record_types_follow_pack on pulse.org_pack;
drop function pulse.record_types_follow_pack();
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
end $$;
drop function pulse.record_types_align();
-- The types archived for an industry come back; the types added stay (records may use them).
update pulse.record_type set archived_at = null, updated_at = now() where archived_by_industry;
alter table pulse.record_type drop column archived_by_industry;
do $$
declare definition text; patch text;
begin
  definition := pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
  patch := $r$
 -- BILLING-WL (1500): a quotation sent for approval, and its approval.
 if p_type in ('billing.approval','billing.approved') then return erp_notice_allowed(p_person,p_type,p_subject,p_id);end if;$r$;
  if position(patch in definition) > 0 then execute replace(definition, patch, ''); end if;
end $$;
drop function pulse.erp_notice_allowed(uuid, text, text, uuid);
-- (the two notice types stay allowed in notification_event_type_check: notices already sent keep their rows)
drop trigger erp_approval_setting_guard on pulse.erp_settings;
drop function pulse.erp_approval_setting_guard();
drop trigger erp_approval_follow on pulse.erp_document;
drop trigger erp_approval_gate on pulse.erp_document;
drop function pulse.erp_approval_follow();
drop function pulse.erp_approval_gate();
drop function pulse.erp_approval_ask(uuid, uuid, text);
drop function pulse.erp_approvers();
alter table pulse.erp_document drop column approval_note, drop column approval_asked_at, drop column approval_asked_by, drop column approval_to;
alter table pulse.erp_settings drop column quote_approval;
drop function pulse.erp_stock_import_operator(jsonb, boolean);
drop function pulse.erp_stock_import(jsonb, boolean);
drop function pulse.erp_stock_import_do(jsonb, boolean);
drop trigger erp_serial_follow on pulse.erp_document;
drop function pulse.erp_serial_follow();
drop function pulse.erp_stock_set(uuid, numeric, text[], text);
drop function pulse.erp_stock_set_do(uuid, numeric, text[], text);
drop function pulse.erp_stock_receive(uuid, numeric, text[], text, date, bigint);
drop function pulse.erp_serial_clean(text);
drop table pulse.erp_stock_serial;
alter table pulse.erp_line drop column serials, drop column warranty_months;
alter table pulse.erp_item drop column serialised, drop column warranty_options, drop column warranty_months;
drop function pulse.erp_party_twins(text, text);
-- 1470's booking.
create or replace function pulse.erp_book_client_do(p_doc uuid) returns jsonb
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
  with recursive up(id, source_id) as (select d.id, d.source_id union all select x.id, x.source_id from pulse.erp_document x join up on x.id = up.source_id)
    select array_agg(id) into chain from up;
  cid := coalesce(d.client_id, (select x.client_id from pulse.erp_document x where x.id = any(chain) and x.client_id is not null limit 1));
  if cid is not null then crule := 'named'; end if;
  if cid is null and gst is not null then
    select x.client_id into cid from pulse.erp_party x where x.org_id = pulse.current_org() and x.gstin = gst limit 1;
    if cid is not null then crule := 'gstin'; end if;
  end if;
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
alter table pulse.erp_document drop column sx_lead_id;
drop function pulse.erp_name_close(text, text);
drop function pulse.search_score(text, text[]);
drop function pulse.search_norm(text);
