-- migrate:up
-- CONTRACTS-2 (owner, 8 Nov 2026; Kazuk + Savuzo meeting 7 Nov): agreements people really sign. Builds on 1583.
--   * The agreement's words (contract.body), filled from a quotation or invoice and the company's agreement template
--     (contract_template: one standard for everyone, optional variants for one client). A change to the words after
--     sending is a new draft (contract_terms now carries the body, so 1583's versioning keeps every draft).
--   * A signing link for a party off Vitals OS (contract_sign_link: only a hash of the token is kept; it expires; the
--     client opens, reads, comments, asks for a change, signs by typing or drawing, or says no, all without an account).
--     Found by its exact hash like quotation links (1625): on the shared address in the link's own company.
--   * Signing inside Vitals OS with the same signature (another company that is a party, or a person).
--   * Every step in an activity log (contract_event): made, prepared, sent, opened, viewed, signed, declined,
--     commented, change asked, new draft; change requests name their clause, so a company sees which clauses get pushback.
--   * After a quotation is accepted (or an invoice issued) the agreement can make itself (contract_settings, per company,
--     off until a manager turns it on; the steps are data, for Kazuk's own flow).
--   * Sellers (Sales) make an agreement from a document they can see, send it and follow the ones they own.
--   * contract.signed_at for "contracts signed per month" (the company's own count; the platform's for its admins).
-- New tables: forced row security with a tenant policy; writes only through the functions below.

-- ------------------------------------------------------------------------------------------------ columns
alter table pulse.contract add column body text not null default '' check (length(body) <= 100000);
alter table pulse.contract add column signed_at timestamptz;
alter table pulse.contract_party add column email text check (email is null or (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'));
alter table pulse.contract_party add column signer_name text check (length(signer_name) <= 160 and signer_name !~ '[[:cntrl:]]');
alter table pulse.contract_party add column sign_kind text check (sign_kind in ('typed', 'drawn', 'recorded'));
alter table pulse.contract_party add column sign_image text check (sign_image is null or (length(sign_image) <= 200000 and sign_image ~ '^data:image/png;base64,[A-Za-z0-9+/=]+$'));
alter table pulse.contract_party add column declined_at timestamptz;
alter table pulse.contract_party add column declined_note text check (length(declined_note) <= 1000);
alter table pulse.contract_side add column source_document_id uuid references pulse.erp_document(id);
alter table pulse.contract_side add column template_id uuid;
create index contract_side_source on pulse.contract_side(org_id, source_document_id) where source_document_id is not null;
create index contract_signed on pulse.contract(org_id, signed_at) where signed_at is not null;

-- ------------------------------------------------------------------------------------------------ tables
create table pulse.contract_template (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120 and name !~ '[[:cntrl:]]'),
  body text not null check (length(btrim(body)) between 1 and 100000),
  kind text not null default 'services' check (kind in ('employment', 'retainer', 'services', 'revenue_share', 'equity')),
  client_id uuid references pulse.client(id),        -- null: the standard one; set: a variant for this client
  is_default boolean not null default false,
  source text not null default 'typed' check (source in ('typed', 'pasted', 'docx', 'pdf', 'starter')),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);
create unique index contract_template_one_default on pulse.contract_template(org_id) where is_default and archived_at is null;
alter table pulse.contract_side add constraint contract_side_template foreign key (template_id) references pulse.contract_template(id);

create table pulse.contract_settings (
  org_id uuid primary key references pulse.org(id),
  -- What happens after a quotation is accepted or an invoice issued: nothing, or the agreement is made ready to send.
  after text not null default 'off' check (after in ('off', 'prepare')),
  trigger_on text not null default 'quote_accepted' check (trigger_on in ('quote_accepted', 'invoice_issued')),
  link_days int not null default 14 check (link_days between 1 and 90),
  -- A company's own agreement steps (Kazuk's flow, when it comes): [{ key, label, who, after }], shown in order.
  steps jsonb not null default '[]' check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) <= 20),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);

create table pulse.contract_sign_link (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  org_id uuid not null references pulse.org(id),
  contract_id uuid not null references pulse.contract(id),
  party_key uuid not null,
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  opened_at timestamptz,
  seen_at timestamptz,
  answered_at timestamptz
);
create index contract_sign_link_contract on pulse.contract_sign_link(org_id, contract_id, party_key);

create table pulse.contract_event (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references pulse.contract(id),
  kind text not null check (kind in ('made', 'prepared', 'sent', 'opened', 'viewed', 'signed', 'declined', 'commented', 'change_asked',
    'new_draft', 'link_stopped', 'resolved')),
  party_key uuid,
  version int,
  clause text check (length(clause) <= 200),
  body text check (length(body) <= 4000),
  actor_name text check (length(actor_name) <= 160),
  via text not null default 'app' check (via in ('app', 'link', 'auto')),
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  agent text check (length(agent) <= 300),
  resolved_at timestamptz,
  at timestamptz not null default now()
);
create index contract_event_contract on pulse.contract_event(org_id, contract_id, at);
create index contract_event_pushback on pulse.contract_event(org_id, clause) where kind = 'change_asked';

-- ------------------------------------------------------------------------------------------------ who may
-- A seller (Sales) makes agreements from documents and follows the ones they own; managers (1583) do everything.
create function pulse.contract_seller() returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and agent_session() is null and not viewer_outside_seat()
   and exists(select 1 from person p where p.org_id = current_org() and p.id = current_viewer() and p.side = 'staff' and p.status = 'active')
   and viewer_is('sales', 'sales_head')
$$;

create function pulse.contract_owned(p_contract uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and exists(select 1 from contract_side s where s.org_id = current_org() and s.contract_id = p_contract
   and s.owner_person_id = current_viewer())
$$;

-- Managers, or the seller who owns it.
create function pulse.contract_runner(p_contract uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select contract_manager() or (contract_seller() and contract_owned(p_contract))
$$;

create or replace function pulse.contract_can_see(p_contract uuid, p_status text) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select contract_manager() or (contract_seller() and contract_owned(p_contract)) or (p_status <> 'draft' and contract_is_party(p_contract))
$$;

-- ------------------------------------------------------------------------------------------------ row security
do $$ declare t text; begin
 foreach t in array array['contract_template', 'contract_settings', 'contract_sign_link', 'contract_event'] loop
  execute format('alter table pulse.%I enable row level security', t);
  execute format('alter table pulse.%I force row level security', t);
  execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
 end loop;
end $$;
-- Templates: managers write; managers and sellers read (a seller picks one when making an agreement).
create policy contract_template_see on pulse.contract_template as restrictive for select to pulse_api using (pulse.contract_manager() or pulse.contract_seller());
create policy contract_template_insert on pulse.contract_template as restrictive for insert to pulse_api with check (pulse.contract_manager());
create policy contract_template_update on pulse.contract_template as restrictive for update to pulse_api using (pulse.contract_manager()) with check (pulse.contract_manager());
create policy contract_settings_see on pulse.contract_settings as restrictive for select to pulse_api using (pulse.contract_manager() or pulse.contract_seller());
create policy contract_settings_insert on pulse.contract_settings as restrictive for insert to pulse_api with check (pulse.contract_manager());
create policy contract_settings_update on pulse.contract_settings as restrictive for update to pulse_api using (pulse.contract_manager()) with check (pulse.contract_manager());
-- Links and the activity log: read by whoever runs the contract; written only by the functions.
create policy contract_sign_link_see on pulse.contract_sign_link as restrictive for select to pulse_api using (pulse.contract_runner(contract_id));
create policy contract_event_see on pulse.contract_event as restrictive for select to pulse_api using (pulse.contract_runner(contract_id));
-- The signed-out lookup sees one link by its exact hash, only while contract_sign_bind looks it up (as 1625 does).
create policy contract_sign_find on pulse.contract_sign_link for select to current_user
  using (token_hash = coalesce(current_setting('pulse.contract_sign_find', true), ''));
grant select, insert, update on pulse.contract_template, pulse.contract_settings to pulse_api;
grant select on pulse.contract_sign_link, pulse.contract_event to pulse_api;

-- ------------------------------------------------------------------------------------------------ the shared part
-- The words are part of the terms: a change after sending is a new draft that every party signs again (1583).
create or replace function pulse.contract_terms(c pulse.contract) returns jsonb language sql stable as $$
 select jsonb_build_object('kind', c.kind, 'title', c.title, 'scope', c.scope, 'deliverables', c.deliverables, 'rates', c.rates,
   'currency', c.currency, 'schedule', c.schedule, 'startsOn', c.starts_on, 'endsOn', c.ends_on, 'noticeDays', c.notice_days, 'body', c.body)
$$;

-- Signed when every party signed the current draft (the moment it happened); back to waiting when one has not.
create or replace function pulse.contract_settle(p_contract uuid) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; open int;
begin
 select * into c from contract where org_id = current_org() and id = p_contract;
 if c.status not in ('proposed', 'active') then return c.status; end if;
 select count(*) into open from contract_party where org_id = current_org() and contract_id = p_contract and (accepted_version is distinct from c.version);
 update contract set status = case when open = 0 then 'active' else 'proposed' end,
   signed_at = case when open = 0 then coalesce(c.signed_at, now()) end, updated_at = now()
  where org_id = current_org() and id = p_contract;
 return case when open = 0 then 'active' else 'proposed' end;
end $$;

-- A new draft clears every signature and every "no" (1583 clears the acceptances; the signature goes with them).
create function pulse.contract_party_clear() returns trigger language plpgsql as $$
begin
 if new.accepted_at is null and old.accepted_at is not null then new.sign_kind := null; new.sign_image := null; end if;
 return new;
end $$;
create trigger contract_party_clear before update on pulse.contract_party for each row execute function pulse.contract_party_clear();
create function pulse.contract_new_draft() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 update contract_party set declined_at = null, declined_note = null where org_id = new.org_id and contract_id = new.id and declined_at is not null;
 return new;
end $$;
create trigger contract_new_draft after update of version on pulse.contract for each row when (old.version is distinct from new.version)
 execute function pulse.contract_new_draft();

-- 1583's push, now carrying the words, when it was signed, and each party's signature, contact and answer.
create or replace function pulse.contract_push(p_contract uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; src uuid := current_org(); t uuid; tid uuid; parties jsonb; versions jsonb; txns jsonb; x jsonb;
begin
 select * into c from contract where org_id = src and id = p_contract;
 if not found or c.status = 'draft' then return; end if;
 select coalesce(jsonb_agg(jsonb_build_object('party_key', p.party_key, 'position', p.position, 'kind', p.kind, 'role', p.role, 'party_org', p.party_org,
   'party_account', coalesce(p.party_account, (select m.account_id from pulse_priv.account_member m where m.person_id = p.party_person_id)),
   'name', p.name, 'accepted_at', p.accepted_at, 'accepted_version', p.accepted_version, 'accepted_by_name', p.accepted_by_name,
   'accepted_note', p.accepted_note, 'email', p.email, 'signer_name', p.signer_name, 'sign_kind', p.sign_kind, 'sign_image', p.sign_image,
   'declined_at', p.declined_at, 'declined_note', p.declined_note)), '[]') into parties from contract_party p where p.org_id = src and p.contract_id = c.id;
 select coalesce(jsonb_agg(jsonb_build_object('version', v.version, 'terms', v.terms, 'changed_by_name', v.changed_by_name, 'changed_at', v.changed_at)), '[]')
   into versions from contract_version v where v.org_id = src and v.contract_id = c.id;
 select coalesce(jsonb_agg(jsonb_build_object('txn_key', tx.txn_key, 'kind', tx.kind, 'payer_key', tx.payer_key, 'payee_key', tx.payee_key, 'label', tx.label,
   'amount_minor', tx.amount_minor, 'currency', tx.currency, 'status', tx.status, 'due_on', tx.due_on, 'paid_on', tx.paid_on,
   'created_by_name', tx.created_by_name, 'created_at', tx.created_at)), '[]') into txns from contract_txn tx where tx.org_id = src and tx.contract_id = c.id;
 for t in select distinct p.party_org from contract_party p where p.org_id = src and p.contract_id = c.id and p.party_org is not null and p.party_org <> src loop
  if not exists(select 1 from org where id = t and status = 'active') then continue; end if;
  perform set_config('pulse.org_id', t::text, true);
  select id into tid from contract where org_id = t and contract_key = c.contract_key;
  if tid is null then
   insert into contract(org_id, contract_key, home_org, version, status, kind, title, scope, deliverables, rates, currency, schedule, starts_on, ends_on,
     notice_days, template, ended_on, end_reason, body, signed_at)
   values (t, c.contract_key, c.home_org, c.version, c.status, c.kind, c.title, c.scope, c.deliverables, c.rates, c.currency, c.schedule, c.starts_on,
     c.ends_on, c.notice_days, c.template, c.ended_on, c.end_reason, c.body, c.signed_at) returning id into tid;
  else
   update contract set version = c.version, status = c.status, kind = c.kind, title = c.title, scope = c.scope, deliverables = c.deliverables,
     rates = c.rates, currency = c.currency, schedule = c.schedule, starts_on = c.starts_on, ends_on = c.ends_on, notice_days = c.notice_days,
     template = c.template, ended_on = c.ended_on, end_reason = c.end_reason, body = c.body, signed_at = c.signed_at, updated_at = now()
    where org_id = t and id = tid;
  end if;
  for x in select * from jsonb_array_elements(parties) loop
   insert into contract_party(org_id, contract_id, party_key, position, kind, role, party_org, party_account, name, accepted_at, accepted_version, accepted_by_name,
     accepted_note, email, signer_name, sign_kind, sign_image, declined_at, declined_note)
   values (t, tid, (x->>'party_key')::uuid, (x->>'position')::int, x->>'kind', x->>'role', (x->>'party_org')::uuid, (x->>'party_account')::uuid, x->>'name',
     (x->>'accepted_at')::timestamptz, (x->>'accepted_version')::int, x->>'accepted_by_name', x->>'accepted_note', x->>'email', x->>'signer_name',
     x->>'sign_kind', x->>'sign_image', (x->>'declined_at')::timestamptz, x->>'declined_note')
   on conflict (contract_id, party_key) do update set name = excluded.name, role = excluded.role, accepted_at = excluded.accepted_at,
     accepted_version = excluded.accepted_version, accepted_by_name = excluded.accepted_by_name, accepted_note = excluded.accepted_note,
     email = excluded.email, signer_name = excluded.signer_name, sign_kind = excluded.sign_kind, sign_image = excluded.sign_image,
     declined_at = excluded.declined_at, declined_note = excluded.declined_note;
  end loop;
  for x in select * from jsonb_array_elements(versions) loop
   insert into contract_version(org_id, contract_id, version, terms, changed_by_name, changed_at)
   values (t, tid, (x->>'version')::int, x->'terms', x->>'changed_by_name', (x->>'changed_at')::timestamptz) on conflict (contract_id, version) do nothing;
  end loop;
  for x in select * from jsonb_array_elements(txns) loop
   insert into contract_txn(org_id, contract_id, txn_key, kind, payer_key, payee_key, label, amount_minor, currency, status, due_on, paid_on, created_by_name, created_at)
   values (t, tid, (x->>'txn_key')::uuid, x->>'kind', (x->>'payer_key')::uuid, (x->>'payee_key')::uuid, x->>'label', (x->>'amount_minor')::bigint,
     x->>'currency', x->>'status', (x->>'due_on')::date, (x->>'paid_on')::date, x->>'created_by_name', (x->>'created_at')::timestamptz)
   on conflict (contract_id, txn_key) do update set status = excluded.status, paid_on = excluded.paid_on, due_on = excluded.due_on, label = excluded.label;
  end loop;
  tid := null;
 end loop;
 perform set_config('pulse.org_id', src::text, true);
end $$;

-- One line in the activity log of this company's copy.
create function pulse.contract_log(p_contract uuid, p_kind text, p_party uuid, p_clause text, p_body text, p_via text, p_ip text, p_agent text, p_actor text)
 returns uuid language sql security definer set search_path=pulse,pg_temp as $$
 insert into contract_event(org_id, contract_id, kind, party_key, version, clause, body, actor_name, via, ip_hash, agent)
 select current_org(), p_contract, p_kind, p_party, c.version, nullif(left(btrim(coalesce(p_clause, '')), 200), ''), nullif(left(btrim(coalesce(p_body, '')), 4000), ''),
   left(coalesce(p_actor, contract_actor_name()), 160), coalesce(p_via, 'app'), p_ip, left(p_agent, 300)
 from contract c where c.org_id = current_org() and c.id = p_contract
 returning id
$$;

-- The same line in every company's copy (an answer given in one company shows in the other's log too).
create function pulse.contract_log_all(p_contract uuid, p_kind text, p_party uuid, p_clause text, p_body text, p_via text, p_actor text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare src uuid := current_org(); k uuid; t uuid; tid uuid;
begin
 select contract_key into k from contract where org_id = src and id = p_contract;
 perform contract_log(p_contract, p_kind, p_party, p_clause, p_body, p_via, null, null, p_actor);
 for t in select distinct p.party_org from contract_party p where p.org_id = src and p.contract_id = p_contract and p.party_org is not null and p.party_org <> src loop
  perform set_config('pulse.org_id', t::text, true);
  select id into tid from contract where org_id = t and contract_key = k;
  if tid is not null then perform contract_log(tid, p_kind, p_party, p_clause, p_body, p_via, null, null, p_actor); end if;
 end loop;
 perform set_config('pulse.org_id', src::text, true);
end $$;

-- ------------------------------------------------------------------------------------------------ filling from a document
-- Rupees as people in India write them: ₹4,85,000 (paise shown only when there are any).
create function pulse.inr_text(p_paise bigint) returns text language sql immutable as $$
 select '₹' || case when length(r) > 3 then regexp_replace(left(r, length(r) - 3), '(\d)(?=(\d\d)+$)', '\1,', 'g') || ',' || right(r, 3) else r end
   || case when abs(p_paise) % 100 <> 0 then '.' || lpad((abs(p_paise) % 100)::text, 2, '0') else '' end
 from (select (abs(coalesce(p_paise, 0)) / 100)::text r) x
$$;

-- The blanks an agreement template may use, filled from a quotation or invoice of this company.
create function pulse.contract_doc_values(p_doc uuid) returns jsonb
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare d erp_document; proj text; items text; addr text; ours text; tz text := org_time_zone();
begin
 select * into d from erp_document where org_id = current_org() and id = p_doc;
 if not found then return null; end if;
 select coalesce(p.title, p.name) into proj from project p where p.id = d.project_id;
 select string_agg(format('• %s%s: %s', l.description,
   case when l.qty <> 1 then format(' (%s × %s)', trim(trailing '.' from trim(trailing '0' from l.qty::text)), inr_text(l.rate)) else '' end, inr_text(l.total)), E'\n' order by l.position)
  into items from erp_line l where l.document_id = d.id;
 select string_agg(btrim(a), ', ') into addr from jsonb_array_elements_text(case when jsonb_typeof(d.buyer->'address') = 'array' then d.buyer->'address' else '[]' end) a where btrim(a) <> '';
 select string_agg(btrim(a), ', ') into ours from jsonb_array_elements_text(case when jsonb_typeof(d.seller->'address') = 'array' then d.seller->'address' else '[]' end) a where btrim(a) <> '';
 return jsonb_strip_nulls(jsonb_build_object(
   'client_name', nullif(btrim(d.buyer->>'name'), ''),
   'client_contact', nullif(btrim(coalesce(d.buyer->>'contactName', d.buyer->>'name')), ''),
   'client_gstin', nullif(btrim(d.buyer->>'gstin'), ''),
   'client_address', addr,
   'client_email', nullif(btrim(d.buyer->>'email'), ''),
   'client_phone', nullif(btrim(d.buyer->>'phone'), ''),
   'our_name', nullif(btrim(coalesce(d.seller->>'tradeName', d.seller->>'legalName')), ''),
   'our_legal_name', nullif(btrim(d.seller->>'legalName'), ''),
   'our_gstin', nullif(btrim(d.seller->>'gstin'), ''),
   'our_address', ours,
   'document_number', d.number,
   'document_date', to_char(d.issue_date, 'FMDD Mon YYYY'),
   'valid_until', to_char(d.valid_until, 'FMDD Mon YYYY'),
   'due_date', to_char(d.due_date, 'FMDD Mon YYYY'),
   'total', inr_text(d.total),
   'total_words', nullif(btrim(d.amount_words), ''),
   'items', items,
   'project', proj,
   'site', nullif(btrim(coalesce(d.site_location, d.reference->>'siteLocation', d.buyer->>'siteLocation')), ''),
   'today', to_char((now() at time zone tz)::date, 'FMDD Mon YYYY')));
end $$;

-- The same values for the template editor's preview ("See it filled for …"): managers and sellers.
create function pulse.contract_preview_values(p_doc uuid) returns jsonb
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if not (contract_manager() or contract_seller()) then raise exception 'Admins, leadership, Finance and Sales see this' using errcode = '42501'; end if;
 return contract_doc_values(p_doc);
end $$;

-- Fill {{blanks}} with values; a blank with no value stays as a visible gap to fill in by hand.
create function pulse.contract_fill(p_body text, p_values jsonb) returns text language plpgsql immutable as $$
declare b text := regexp_replace(coalesce(p_body, ''), '\{\{\s*([a-z_]+)\s*\}\}', '{{\1}}', 'g'); k text; v text;
begin
 for k, v in select key, value from jsonb_each_text(coalesce(p_values, '{}')) loop
  b := replace(b, '{{' || k || '}}', v);
 end loop;
 return b;
end $$;

-- Make an agreement from a quotation or invoice (internal: callers check who may). The company's chosen template
-- (or this client's variant, or the standard one) is filled from the document; this company and the client are the
-- parties; the document (and its project) are linked; the log says how it was made.
create function pulse.contract_make_from_doc(p_doc uuid, p_template uuid, p_via text, p_owner uuid) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d erp_document; t contract_template; vals jsonb; cid uuid; nm text; rates jsonb;
begin
 select * into d from erp_document where org_id = current_org() and id = p_doc;
 if not found then raise exception 'No such quotation or invoice in this company' using errcode = 'P0002'; end if;
 if d.doc_type not in ('quotation', 'proforma', 'invoice') then raise exception 'Make an agreement from a quotation or an invoice' using errcode = '22023'; end if;
 if d.status in ('draft', 'cancelled') then raise exception 'Issue the document first; a draft or cancelled one has no final figures' using errcode = '22023'; end if;
 if p_template is not null then
  select * into t from contract_template where org_id = current_org() and id = p_template and archived_at is null;
  if not found then raise exception 'That agreement template is not in this company' using errcode = '22023'; end if;
 else
  select * into t from contract_template where org_id = current_org() and archived_at is null and (client_id = d.client_id or (client_id is null and is_default))
   order by client_id is not null desc, updated_at desc limit 1;
  if not found then select * into t from contract_template where org_id = current_org() and archived_at is null and client_id is null order by updated_at desc limit 1; end if;
 end if;
 if t.id is null then raise exception 'Add an agreement template first (Contracts → Templates)' using errcode = '22023'; end if;
 vals := contract_doc_values(d.id);
 nm := coalesce(nullif(btrim(d.buyer->>'name'), ''), 'Client');
 select coalesce(jsonb_agg(jsonb_build_object('label', left(l.description, 120), 'amountMinor', l.total, 'unit', 'one_off') order by l.position), '[]')
  into rates from (select * from erp_line where document_id = d.id order by position limit 50) l;
 insert into contract(org_id, home_org, kind, title, body, rates, currency, schedule)
 values (current_org(), current_org(), t.kind, left(coalesce(vals->>'project', t.name) || ' · ' || nm, 160), contract_fill(t.body, vals), rates, 'INR', 'milestones')
 returning id into cid;
 insert into contract_side(org_id, contract_id, created_by, owner_person_id, client_id, source_document_id, template_id)
 values (current_org(), cid, current_viewer(), coalesce(p_owner, d.salesperson_id, current_viewer()), d.client_id, d.id, t.id);
 insert into contract_party(org_id, contract_id, position, kind, role, party_org, name)
 values (current_org(), cid, 1, 'company', 'provider', current_org(), coalesce((select name from org where id = current_org()), 'Us'));
 insert into contract_party(org_id, contract_id, position, kind, role, name, email, signer_name)
 values (current_org(), cid, 2, 'company', 'client', left(nm, 160),
   case when coalesce(d.buyer->>'email', '') ~ '^[^@[:space:]]+@[^@[:space:]]+$' then left(d.buyer->>'email', 254) end,
   nullif(left(btrim(coalesce(d.buyer->>'contactName', '')), 160), ''));
 insert into contract_link(org_id, contract_id, erp_document_id, added_by) values (current_org(), cid, d.id, current_viewer());
 if d.project_id is not null then insert into contract_link(org_id, contract_id, project_id, added_by) values (current_org(), cid, d.project_id, current_viewer()); end if;
 perform contract_log(cid, case when p_via = 'auto' then 'prepared' else 'made' end, null, null,
   format('From %s %s', case d.doc_type when 'invoice' then 'invoice' when 'proforma' then 'proforma' else 'quotation' end, coalesce(d.number, '')), p_via, null, null,
   case when p_via = 'auto' then 'Vitals OS' end);
 return cid;
end $$;

-- A person makes one from a document: managers, or a seller from a document that is theirs (they sell it).
create function pulse.contract_from_document(p_doc uuid, p_template uuid) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare had uuid;
begin
 if not (contract_manager() or (contract_seller() and exists(select 1 from erp_document d where d.org_id = current_org() and d.id = p_doc
     and (d.salesperson_id = current_viewer() or viewer_is('sales_head'))))) then
  raise exception 'Admins, leadership, Finance and the document''s seller make agreements' using errcode = '42501'; end if;
 select s.contract_id into had from contract_side s join contract c on c.id = s.contract_id and c.org_id = s.org_id
  where s.org_id = current_org() and s.source_document_id = p_doc and c.status in ('draft', 'proposed', 'active') order by c.created_at desc limit 1;
 if had is not null then return had; end if;
 return contract_make_from_doc(p_doc, p_template, 'app', null);
end $$;

-- After a quotation is accepted or an invoice issued: the agreement makes itself, when the company turned this on.
-- It never stops the document's own change: a problem is a warning in the log, not an error.
create function pulse.contract_after_document() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s contract_settings; ev text;
begin
 ev := case when new.doc_type in ('quotation', 'proforma') and new.status = 'accepted' and old.status is distinct from 'accepted' then 'quote_accepted'
   when new.doc_type = 'invoice' and new.status in ('issued', 'sent') and old.status = 'draft' then 'invoice_issued' end;
 if ev is null then return new; end if;
 select * into s from contract_settings where org_id = new.org_id;
 if not found or s.after = 'off' or s.trigger_on <> ev then return new; end if;
 if exists(select 1 from contract_side where org_id = new.org_id and source_document_id = new.id) then return new; end if;
 begin
  perform contract_make_from_doc(new.id, null, 'auto', null);
 exception when others then
  raise warning 'contract_after_document %: %', new.id, sqlerrm;
 end;
 return new;
end $$;
create trigger contract_after_document after update of status on pulse.erp_document for each row execute function pulse.contract_after_document();

-- ------------------------------------------------------------------------------------------------ the words, sending
-- Change the name or the words (managers, or the owning seller). After sending, a change is a new draft: the old one is
-- kept, every signature is cleared and the parties sign again (the same rule as 1583's contract_save).
create function pulse.contract_words_save(p_id uuid, p_title text, p_body text) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; old jsonb;
begin
 if not contract_runner(p_id) then raise exception 'Admins, leadership, Finance and the agreement''s owner change it' using errcode = '42501'; end if;
 select * into c from contract where org_id = current_org() and id = p_id for update;
 if not found then raise exception 'No such agreement in this company' using errcode = 'P0002'; end if;
 if c.status in ('ended', 'cancelled') then raise exception 'This agreement has ended; make a new one' using errcode = '22023'; end if;
 if c.status = 'active' then raise exception 'Everyone signed this one. Make a new agreement to change it' using errcode = '22023'; end if;
 if p_body is not null and length(p_body) > 100000 then raise exception 'The agreement is too long' using errcode = '22023'; end if;
 old := contract_terms(c);
 update contract set title = coalesce(nullif(left(btrim(p_title), 160), ''), title), body = coalesce(p_body, body), updated_at = now()
  where org_id = current_org() and id = p_id returning * into c;
 if c.status <> 'draft' and contract_terms(c) is distinct from old then
  insert into contract_version(org_id, contract_id, version, terms, changed_by_name) values (current_org(), p_id, c.version, old, contract_actor_name());
  update contract set version = version + 1, status = 'proposed' where org_id = current_org() and id = p_id;
  update contract_party set accepted_at = null, accepted_version = null, accepted_by_name = null, accepted_note = null where org_id = current_org() and contract_id = p_id;
  perform contract_log(p_id, 'new_draft', null, null, null, 'app', null, null, null);
  perform contract_settle(p_id);
  perform contract_push(p_id);
 end if;
 return (select version from contract where org_id = current_org() and id = p_id);
end $$;

-- Send to sign: a draft becomes sent (copies appear in the other companies that are parties); for a party off Vitals OS
-- a new link replaces its earlier one (p_hash: sha-256 of the token the API made; the token itself is never stored).
create function pulse.contract_send_to_sign(p_id uuid, p_party uuid, p_hash text, p_days int, p_email text, p_signer text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; pt contract_party; days int; exp timestamptz;
begin
 if not contract_runner(p_id) then raise exception 'Admins, leadership, Finance and the agreement''s owner send it' using errcode = '42501'; end if;
 select * into c from contract where org_id = current_org() and id = p_id for update;
 if not found then raise exception 'No such agreement in this company' using errcode = 'P0002'; end if;
 if c.status not in ('draft', 'proposed') then raise exception 'Only an agreement still to sign is sent' using errcode = '22023'; end if;
 if length(btrim(c.body)) < 20 and length(btrim(c.scope)) < 20 then raise exception 'Write the agreement before sending it' using errcode = '22023'; end if;
 -- Nobody signs a gap: a blank the document could not fill ({{project}}) is filled by hand first.
 if c.body ~ '\{\{[a-z_]+\}\}' then
  raise exception 'Some blanks are still empty (%). Fill them with Change the words, then send', (select string_agg(distinct m[1], ', ') from regexp_matches(c.body, '\{\{([a-z_]+)\}\}', 'g') m)
   using errcode = '22023'; end if;
 if (select count(*) from contract_party where org_id = current_org() and contract_id = p_id) < 2 then raise exception 'Name both sides before sending' using errcode = '22023'; end if;
 if p_party is not null then
  select * into pt from contract_party where org_id = current_org() and contract_id = p_id and party_key = p_party;
  if not found then raise exception 'Choose who signs from the agreement''s sides' using errcode = '22023'; end if;
  if pt.party_org is not null or pt.party_person_id is not null or pt.party_account is not null then
   raise exception 'They use Vitals OS: they sign there, no link needed' using errcode = '22023'; end if;
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'The link could not be made' using errcode = '22023'; end if;
  days := coalesce(p_days, (select link_days from contract_settings where org_id = current_org()), 14);
  if days not between 1 and 90 then raise exception 'A link works for 1 to 90 days' using errcode = '22023'; end if;
  exp := now() + make_interval(days => days);
 end if;
 if c.status = 'draft' then
  update contract set status = 'proposed', updated_at = now() where org_id = current_org() and id = p_id;
  perform contract_settle(p_id);
 end if;
 if p_party is not null then
  update contract_sign_link set revoked_at = now() where org_id = current_org() and contract_id = p_id and party_key = p_party and revoked_at is null;
  insert into contract_sign_link(token_hash, org_id, contract_id, party_key, created_by, expires_at) values (p_hash, current_org(), p_id, p_party, current_viewer(), exp);
  update contract_party set email = case when p_email is null then email when btrim(p_email) = '' then null else left(btrim(p_email), 254) end,
    signer_name = case when p_signer is null then signer_name else nullif(left(btrim(p_signer), 160), '') end
   where org_id = current_org() and id = pt.id;
 end if;
 perform contract_log(p_id, 'sent', p_party, null, case when exp is not null then 'Link works until ' || to_char(exp at time zone org_time_zone(), 'FMDD Mon YYYY') end, 'app', null, null, null);
 perform contract_push(p_id);
 return jsonb_build_object('status', (select status from contract where org_id = current_org() and id = p_id), 'expiresAt', exp);
end $$;

-- Stop a party's link (it was sent to the wrong person, or the deal is off).
create function pulse.contract_link_stop(p_id uuid, p_party uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not contract_runner(p_id) then raise exception 'Admins, leadership, Finance and the agreement''s owner stop its link' using errcode = '42501'; end if;
 update contract_sign_link set revoked_at = now() where org_id = current_org() and contract_id = p_id and party_key = p_party and revoked_at is null;
 if found then perform contract_log(p_id, 'link_stopped', p_party, null, null, 'app', null, null, null); end if;
end $$;

-- A note or an answer in the log from inside Vitals OS; resolve a client's change request.
create function pulse.contract_note(p_id uuid, p_clause text, p_body text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not contract_runner(p_id) then raise exception 'Admins, leadership, Finance and the agreement''s owner write here' using errcode = '42501'; end if;
 if length(btrim(coalesce(p_body, ''))) < 2 then raise exception 'Write a few words' using errcode = '22023'; end if;
 return contract_log(p_id, 'commented', null, p_clause, p_body, 'app', null, null, null);
end $$;
create function pulse.contract_resolve(p_id uuid, p_event uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not contract_runner(p_id) then raise exception 'Admins, leadership, Finance and the agreement''s owner do this' using errcode = '42501'; end if;
 update contract_event set resolved_at = coalesce(resolved_at, now()) where org_id = current_org() and contract_id = p_id and id = p_event and kind in ('change_asked', 'commented');
 if not found then raise exception 'No such request on this agreement' using errcode = 'P0002'; end if;
end $$;

-- Sign inside Vitals OS: the viewer for themselves (a person who is a party) or a manager for this company (it is a
-- party: our own side, or another company's agreement that names us). The signature is a typed name or a drawing.
create function pulse.contract_sign_here(p_id uuid, p jsonb) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c contract; pt contract_party; mgr boolean := contract_manager(); nm text := btrim(coalesce(p->>'name', '')); k text := coalesce(p->>'kind', 'typed');
  img text := nullif(p->>'image', '');
begin
 select * into c from contract where org_id = current_org() and id = p_id for update;
 if not found or not contract_can_see(c.id, c.status) then raise exception 'No such agreement in this company' using errcode = 'P0002'; end if;
 if c.status <> 'proposed' then raise exception 'Only an agreement waiting for signatures is signed' using errcode = '22023'; end if;
 if coalesce((p->>'agree')::boolean, false) is not true then raise exception 'Tick "I agree" to sign' using errcode = '22023'; end if;
 if length(nm) not between 2 and 160 then raise exception 'Type your full name to sign' using errcode = '22023'; end if;
 if k not in ('typed', 'drawn') or (k = 'drawn' and img is null) then raise exception 'Type your name or draw your signature' using errcode = '22023'; end if;
 select * into pt from contract_party x where x.org_id = current_org() and x.contract_id = p_id and x.accepted_version is distinct from c.version
   and ((x.kind = 'person' and (x.party_person_id = current_viewer() or (x.party_account is not null and x.party_account = account_of_viewer())))
     or (mgr and x.kind = 'company' and x.party_org = current_org()))
   order by x.position limit 1;
 if not found then raise exception 'There is nothing here for you to sign' using errcode = '42501'; end if;
 update contract_party set accepted_at = now(), accepted_version = c.version, accepted_by_name = left(nm, 160), accepted_note = 'Signed in Vitals OS',
   signer_name = left(nm, 160), sign_kind = k, sign_image = case when k = 'drawn' then img end, declined_at = null, declined_note = null
  where org_id = current_org() and id = pt.id;
 perform contract_settle(p_id);
 perform contract_push(p_id);
 perform contract_log_all(p_id, 'signed', pt.party_key, null, format('%s signed for %s', nm, pt.name), 'app', nm);
 return (select status from contract where org_id = current_org() and id = p_id);
end $$;

-- ------------------------------------------------------------------------------------------------ the signing link (signed out)
create function pulse.contract_sign_bind(p_hash text) returns boolean
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare o uuid; reach boolean := coalesce(current_setting('pulse.contract_sign_reach', true), '') = '1';
begin
 perform set_config('pulse.contract_sign_reach', '', true);
 if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return false; end if;
 perform set_config('pulse.contract_sign_find', p_hash, true);
 select org_id into o from contract_sign_link where token_hash = p_hash;
 perform set_config('pulse.contract_sign_find', '', true);
 if o is null then return false; end if;
 if o is not distinct from current_org() then return true; end if;
 if not reach then return false; end if;
 perform set_config('pulse.org_id', o::text, true);
 return true;
end $$;
revoke all on function pulse.contract_sign_bind(text) from public;

-- What the link shows (no log): the sender, the agreement, every side and who signed, this side, the comments, and
-- (p_audit) the whole log for the signed PDF's audit page.
create function pulse.contract_sign_read(p_hash text, p_audit boolean) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k contract_sign_link; c contract; me contract_party; live boolean;
begin
 select * into k from contract_sign_link where token_hash = p_hash and org_id = current_org();
 if k.token_hash is null or k.revoked_at is not null then return null; end if;
 select * into c from contract where org_id = current_org() and id = k.contract_id;
 select * into me from contract_party where org_id = current_org() and contract_id = c.id and party_key = k.party_key;
 if me.id is null then return null; end if;
 live := k.expires_at >= now() and c.status = 'proposed';
 -- After it expires, a link that was answered still shows the agreement (and its signed copy); one never answered does not.
 if k.expires_at < now() and me.accepted_at is null and me.declined_at is null then return jsonb_build_object('expired', true, 'from', (select name from org where id = current_org())); end if;
 return jsonb_build_object('from', (select name from org where id = current_org()), 'key', c.contract_key, 'title', c.title, 'body', c.body, 'scope', c.scope,
   'rates', c.rates, 'currency', c.currency, 'startsOn', c.starts_on, 'endsOn', c.ends_on, 'version', c.version, 'status', c.status, 'signedAt', c.signed_at,
   'expiresAt', k.expires_at, 'canAnswer', live and me.accepted_version is distinct from c.version, 'zone', org_time_zone(),
   'me', jsonb_build_object('key', me.party_key, 'name', me.name, 'signer', me.signer_name, 'signedAt', case when me.accepted_version = c.version then me.accepted_at end,
     'declinedAt', me.declined_at, 'declinedNote', me.declined_note),
   'parties', (select jsonb_agg(jsonb_build_object('key', p.party_key, 'name', p.name, 'role', p.role, 'signer', p.signer_name,
       'signedAt', case when p.accepted_version = c.version then p.accepted_at end, 'signedBy', case when p.accepted_version = c.version then p.accepted_by_name end,
       'kind', case when p.accepted_version = c.version then p.sign_kind end, 'image', case when p.accepted_version = c.version then p.sign_image end,
       'declinedAt', p.declined_at) order by p.position) from contract_party p where p.org_id = current_org() and p.contract_id = c.id),
   'notes', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'clause', e.clause, 'body', e.body, 'at', e.at, 'by', e.actor_name,
       'resolved', e.resolved_at is not null, 'version', e.version) order by e.at), '[]') from contract_event e
     where e.org_id = current_org() and e.contract_id = c.id and e.kind in ('commented', 'change_asked') and e.party_key = k.party_key and e.via = 'link'),
   'audit', case when p_audit then (select coalesce(jsonb_agg(jsonb_build_object('kind', e.kind, 'at', e.at, 'by', e.actor_name, 'via', e.via, 'version', e.version,
       'ip', left(e.ip_hash, 12), 'agent', e.agent, 'body', case when e.kind in ('signed', 'declined', 'sent', 'made', 'prepared', 'new_draft') then e.body end) order by e.at), '[]')
     from contract_event e where e.org_id = current_org() and e.contract_id = c.id and e.kind <> 'viewed') end);
end $$;

-- Open the link: the first time is "opened", later visits (at most one an hour) are "viewed".
create function pulse.contract_sign_open(p_hash text, p_ip text, p_agent text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k contract_sign_link; r jsonb;
begin
 if not contract_sign_bind(p_hash) then return null; end if;
 r := contract_sign_read(p_hash, false);
 if r is null or r ? 'expired' then return r; end if;
 select * into k from contract_sign_link where token_hash = p_hash and org_id = current_org();
 if k.opened_at is null then
  update contract_sign_link set opened_at = now(), seen_at = now() where token_hash = p_hash;
  perform contract_log(k.contract_id, 'opened', k.party_key, null, null, 'link', p_ip, p_agent, coalesce((select coalesce(signer_name, name) from contract_party where org_id = current_org() and contract_id = k.contract_id and party_key = k.party_key), 'Client'));
 elsif k.seen_at < now() - interval '1 hour' then
  update contract_sign_link set seen_at = now() where token_hash = p_hash;
  perform contract_log(k.contract_id, 'viewed', k.party_key, null, null, 'link', p_ip, p_agent, coalesce((select coalesce(signer_name, name) from contract_party where org_id = current_org() and contract_id = k.contract_id and party_key = k.party_key), 'Client'));
 end if;
 return r;
end $$;

-- The PDF's data (signed out): the same as the page, with the log for the audit page.
create function pulse.contract_sign_audit(p_hash text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not contract_sign_bind(p_hash) then return null; end if;
 return contract_sign_read(p_hash, true);
end $$;

-- The client's answer through the link. p: { action: sign | decline | comment | change, name, kind (typed|drawn),
-- image (a PNG data URL), agree, clause, text }.
create function pulse.contract_sign_act(p_hash text, p jsonb, p_ip text, p_agent text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k contract_sign_link; c contract; me contract_party; a text := coalesce(p->>'action', ''); nm text := btrim(coalesce(p->>'name', ''));
  sk text := coalesce(p->>'kind', 'typed'); img text := nullif(p->>'image', ''); txt text := btrim(coalesce(p->>'text', '')); who text;
begin
 perform contract_sign_bind(p_hash);
 select * into k from contract_sign_link where token_hash = p_hash and org_id = current_org() for update;
 if k.token_hash is null or k.revoked_at is not null then raise exception 'This link is not valid any more. Ask for a new one' using errcode = '22023'; end if;
 if k.expires_at < now() then raise exception 'This link has expired. Ask the sender for a new one' using errcode = '22023'; end if;
 select * into c from contract where org_id = current_org() and id = k.contract_id for update;
 select * into me from contract_party where org_id = current_org() and contract_id = c.id and party_key = k.party_key;
 if c.status <> 'proposed' then raise exception 'This agreement is not waiting for an answer' using errcode = '22023'; end if;
 who := coalesce(nullif(left(nm, 160), ''), me.signer_name, me.name);
 if a in ('comment', 'change') then
  if length(txt) not between 2 and 2000 then raise exception 'Write your comment (up to 2000 letters)' using errcode = '22023'; end if;
  perform contract_log(c.id, case when a = 'change' then 'change_asked' else 'commented' end, k.party_key, p->>'clause', txt, 'link', p_ip, p_agent, who);
  return jsonb_build_object('ok', true);
 end if;
 if me.accepted_version = c.version then raise exception 'You already signed this agreement' using errcode = '22023'; end if;
 if a = 'decline' then
  update contract_party set declined_at = now(), declined_note = nullif(left(txt, 1000), '') where org_id = current_org() and id = me.id;
  update contract_sign_link set answered_at = now() where token_hash = p_hash;
  perform contract_log(c.id, 'declined', k.party_key, null, nullif(txt, ''), 'link', p_ip, p_agent, who);
  perform contract_push(c.id);
  return jsonb_build_object('declined', true);
 end if;
 if a <> 'sign' then raise exception 'Sign, say no, or write a comment' using errcode = '22023'; end if;
 if coalesce((p->>'agree')::boolean, false) is not true then raise exception 'Tick "I agree" to sign' using errcode = '22023'; end if;
 if length(nm) not between 2 and 160 then raise exception 'Type your full name to sign' using errcode = '22023'; end if;
 if sk not in ('typed', 'drawn') or (sk = 'drawn' and img is null) then raise exception 'Type your name or draw your signature' using errcode = '22023'; end if;
 update contract_party set accepted_at = now(), accepted_version = c.version, accepted_by_name = left(nm, 160), accepted_note = 'Signed through the link',
   signer_name = left(nm, 160), sign_kind = sk, sign_image = case when sk = 'drawn' then img end, declined_at = null, declined_note = null
  where org_id = current_org() and id = me.id;
 update contract_sign_link set answered_at = now() where token_hash = p_hash;
 perform contract_log(c.id, 'signed', k.party_key, null, format('%s signed for %s (%s)', nm, me.name, case when sk = 'drawn' then 'drawn signature' else 'typed name' end),
   'link', p_ip, p_agent, nm);
 perform contract_settle(c.id);
 perform contract_push(c.id);
 return jsonb_build_object('signed', true, 'status', (select status from contract where org_id = current_org() and id = c.id));
end $$;

-- ------------------------------------------------------------------------------------------------ counts
-- Contracts signed per month on the whole platform (each agreement once: in the company that made it). Platform admins.
create function pulse.platform_contracts_signed(p_months int) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare back text := current_setting('pulse.org_id', true); o uuid; n int; m date; res jsonb := '{}'; since date;
begin
 if not platform_admin() then raise exception 'Platform admins only' using errcode = '42501'; end if;
 since := (date_trunc('month', now()) - make_interval(months => greatest(least(coalesce(p_months, 12), 36), 1) - 1))::date;
 for o in select g.id from org g where g.status = 'active' loop
  perform set_config('pulse.org_id', o::text, true);
  for m, n in select date_trunc('month', c.signed_at)::date, count(*) from contract c where c.org_id = o and c.home_org = o and c.signed_at >= since group by 1 loop
   res := jsonb_set(res, array[to_char(m, 'YYYY-MM')], to_jsonb(coalesce((res->>to_char(m, 'YYYY-MM'))::int, 0) + n));
  end loop;
 end loop;
 perform set_config('pulse.org_id', coalesce(back, ''), true);
 return res;
end $$;

-- ------------------------------------------------------------------------------------------------ grants
revoke all on function pulse.contract_log(uuid, text, uuid, text, text, text, text, text, text), pulse.contract_log_all(uuid, text, uuid, text, text, text, text),
  pulse.contract_make_from_doc(uuid, uuid, text, uuid), pulse.contract_doc_values(uuid), pulse.contract_sign_read(text, boolean), pulse.contract_party_clear(),
  pulse.contract_new_draft(), pulse.contract_after_document() from public;
revoke all on function pulse.contract_seller(), pulse.contract_owned(uuid), pulse.contract_runner(uuid), pulse.contract_from_document(uuid, uuid),
  pulse.contract_words_save(uuid, text, text), pulse.contract_send_to_sign(uuid, uuid, text, int, text, text), pulse.contract_link_stop(uuid, uuid),
  pulse.contract_note(uuid, text, text), pulse.contract_resolve(uuid, uuid), pulse.contract_sign_here(uuid, jsonb), pulse.contract_sign_open(text, text, text),
  pulse.contract_sign_audit(text), pulse.contract_sign_act(text, jsonb, text, text), pulse.platform_contracts_signed(int), pulse.contract_preview_values(uuid) from public;
grant execute on function pulse.contract_seller(), pulse.contract_owned(uuid), pulse.contract_runner(uuid), pulse.contract_from_document(uuid, uuid),
  pulse.contract_words_save(uuid, text, text), pulse.contract_send_to_sign(uuid, uuid, text, int, text, text), pulse.contract_link_stop(uuid, uuid),
  pulse.contract_note(uuid, text, text), pulse.contract_resolve(uuid, uuid), pulse.contract_sign_here(uuid, jsonb), pulse.contract_sign_open(text, text, text),
  pulse.contract_sign_audit(text), pulse.contract_sign_act(text, jsonb, text, text), pulse.platform_contracts_signed(int), pulse.contract_preview_values(uuid), pulse.inr_text(bigint),
  pulse.contract_fill(text, jsonb) to pulse_api;

-- migrate:down
-- Forward-only, like 1583's follow-ups: the columns and tables hold signatures and the activity log, which are kept.
