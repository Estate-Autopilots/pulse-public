-- migrate:up
-- BILLING (owner, 4 Nov 2026; Kazuk's flow of 3 Nov), the second half of the money path:
--  * Revise the same quotation after negotiation: "Revise" files the approved copy (its row, lines and PDF) as a version
--    and reopens the quotation as a draft that keeps its number; approving it again numbers nothing new. "Undo the
--    revision" puts the filed version back. The versions stay in pulse.erp_document_revision.
--  * A cancelled quotation keeps its number; "Re-issue" copies it into a new draft that takes the next number when it is
--    approved, linked to the one it replaces (erp_document.reissue_of).
--  * The first money in on an invoice (part paid or paid) starts the project: the client and point of contact are booked
--    (1470), the project is made at the project location with every line of the quotation (or of the invoice) as work
--    (a package as its parts), and the project heads are told and asked to choose the owner and the client category.
--    Recording a second payment, or paying a second invoice of the same quotation, makes nothing new. This replaces
--    1387's start on issue: Kazuk's order is invoice, paid, then project. With a delivery template the project gets its
--    stages and due days at once (the plan is laid out from the kick-off, 1385). Only an invoice made from a quotation,
--    for a client with no live client project, starts one by itself; any other paid invoice offers "Start the project".
--  * The project heads are the people holding the delivery template's head role (head_pgs when the company has no
--    template; leadership when nobody holds it). They may plan the project (project_can_run) and assign it.
-- Approval and history stay as they are: a revision is approved like any draft (a price that differs from the catalogue
-- still waits for the owner), and every revise, undo, re-issue and start is in the document's activity.

alter table pulse.erp_document
  add column revision int not null default 0 check (revision between 0 and 999),
  add column reissue_of uuid references pulse.erp_document(id);
comment on column pulse.erp_document.revision is 'BILLING (4 Nov 2026): 0 for the first approved copy; each Revise adds one (the earlier copies are in erp_document_revision)';
comment on column pulse.erp_document.reissue_of is 'BILLING (4 Nov 2026): the cancelled document this one re-issues under the next number';
create index erp_document_reissue on pulse.erp_document(org_id, reissue_of) where reissue_of is not null;
-- Only a first draft is unnumbered: a revision's draft keeps the number it was approved under.
alter table pulse.erp_document drop constraint erp_document_check,
  add constraint erp_document_numbered check ((number is null) = (status = 'draft' and revision = 0));

alter table pulse.project add column client_category text check (client_category ~ '^[a-z0-9_]{1,40}$');
comment on column pulse.project.client_category is 'BILLING (4 Nov 2026): the client category the project head chose (the delivery template''s categories, e.g. sell-out, competitive, normal)';

create table pulse.erp_document_revision(
  org_id uuid not null references pulse.org(id),
  document_id uuid not null references pulse.erp_document(id),
  revision int not null check (revision >= 0),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  pdf bytea,
  pdf_sha256 text,
  reason text check (length(reason) <= 500),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  primary key (document_id, revision));
create index erp_document_revision_org on pulse.erp_document_revision(org_id, document_id);
alter table pulse.erp_document_revision enable row level security;
alter table pulse.erp_document_revision force row level security;
create policy tenant on pulse.erp_document_revision using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy erp_read on pulse.erp_document_revision as restrictive for select to pulse_api using ((select pulse.erp_can(false)));
grant select on pulse.erp_document_revision to pulse_api;

-- Which quotation Revise or Undo is reopening or restoring, in its own transaction. BILLING (review, 4 Nov 2026): a mark
-- only definer code can write (pulse_priv, no grant to pulse_api), never a setting any session could set; and only a
-- quotation is ever marked, so an issued tax invoice has no way round the guard.
create table pulse_priv.erp_revise_mark(
  org_id uuid not null references pulse.org(id),
  txid bigint not null,
  document_id uuid not null references pulse.erp_document(id),
  primary key (txid, document_id));
alter table pulse_priv.erp_revise_mark enable row level security;
alter table pulse_priv.erp_revise_mark force row level security;
create policy tenant on pulse_priv.erp_revise_mark using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse_priv.erp_revise_mark from public;
create function pulse.erp_revising(p_doc uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists(select 1 from pulse_priv.erp_revise_mark m join pulse.erp_document d on d.id = m.document_id
    where m.txid = txid_current() and m.document_id = p_doc and d.doc_type = 'quotation')
$$;
revoke all on function pulse.erp_revising(uuid) from public;
grant execute on function pulse.erp_revising(uuid) to pulse_api, pulse_worker;

-- The guard of issued documents (1470's), now with the revision: only Revise and Undo (this migration's functions, which
-- mark the quotation they change for their own transaction) take an issued quotation back to a draft and restore it.
create or replace function pulse.erp_document_guard() returns trigger language plpgsql as $$
declare revising boolean;
begin
 if tg_op='DELETE' then
  if old.status<>'draft' then raise exception 'An issued document is kept; cancel it or issue a credit note' using errcode='22023';end if;
  if old.number is not null then raise exception 'A revision keeps its number: approve it, or undo the revision' using errcode='22023';end if;
  return old;
 end if;
 revising := old.status<>'draft' and old.doc_type='quotation' and new.doc_type='quotation' and pulse.erp_revising(old.id);
 if old.status<>'draft' and not revising and ((new.doc_type,new.number,new.series_id,new.fy,new.issue_date,new.due_date,new.valid_until,new.project_id,new.engagement_id,
  new.milestone_id,new.against_id,new.source_id,new.seller,new.buyer,new.place_of_supply,new.reference,new.notes,new.terms,new.reverse_charge,new.zero_rated,
  new.round_total,new.tax_mode,new.taxable,new.cgst,new.sgst,new.igst,new.round_off,new.total,new.amount_words,new.design,new.issued_at,new.issued_by,new.template_id,new.revision,new.reissue_of)
  is distinct from (old.doc_type,old.number,old.series_id,old.fy,old.issue_date,old.due_date,old.valid_until,old.project_id,old.engagement_id,
  old.milestone_id,old.against_id,old.source_id,old.seller,old.buyer,old.place_of_supply,old.reference,old.notes,old.terms,old.reverse_charge,old.zero_rated,
  old.round_total,old.tax_mode,old.taxable,old.cgst,old.sgst,old.igst,old.round_off,old.total,old.amount_words,old.design,old.issued_at,old.issued_by,old.template_id,old.revision,old.reissue_of)
  -- BILLING (4 Nov 2026, 1470): a client, point of contact or project location is filled in on an issued document that
  -- had none, never changed.
  or (old.client_id is not null and new.client_id is distinct from old.client_id)
  or (old.contact_person_id is not null and new.contact_person_id is distinct from old.contact_person_id)
  or (old.site_location is not null and new.site_location is distinct from old.site_location)) then
  raise exception 'An issued document cannot be edited; cancel it or issue a credit note' using errcode='22023';
 end if;
 if old.status in ('cancelled','converted','declined') and new.status is distinct from old.status and not (revising and old.status='declined') then
  raise exception 'This document is closed' using errcode='22023';end if;
 if old.status<>'draft' and new.status='draft' and not revising then raise exception 'An issued document cannot go back to draft' using errcode='22023';end if;
 if old.status='draft' and old.number is not null and new.number is distinct from old.number then raise exception 'A revision keeps its number' using errcode='22023';end if;
 new.updated_at:=now();
 return new;
end $$;

-- The issued copy is kept as it was (0190's); Revise moves it into the document's versions, nothing else touches it.
create or replace function pulse.erp_file_fixed() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' and pulse.erp_revising(old.document_id) then return old; end if;
 raise exception 'The issued copy is kept as it was' using errcode='22023';
end $$;

-- Issue (0190's, as amended): a revision keeps its number and takes nothing from the series.
create or replace function pulse.erp_document_issue(p_id uuid, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pulse', 'pg_temp' AS $function$
declare me uuid:=erp_require(true);d erp_document;s erp_series;v_fy text;v_no text;l record;inv erp_document;credited bigint;today date:=(now() at time zone pulse.org_time_zone())::date;
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
 if d.number is not null then
  -- BILLING (4 Nov 2026): a revised quotation is approved again under its own number.
  v_no:=d.number;v_fy:=d.fy;
  update erp_document set status='issued',issued_at=now(),issued_by=me,updated_by=me,design=coalesce(p->'design',design) where id=p_id;
 else
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
 end if;
 if d.doc_type='credit_note' then perform erp_settle(d.against_id);end if;
 if d.source_id is not null then
  update erp_document set status='converted',updated_by=me where id=d.source_id and doc_type in ('quotation','proforma') and status in ('issued','sent','accepted');
 end if;
 perform erp_log('document',p_id,'issued',jsonb_build_object('number',v_no,'total',d.total,'fy',v_fy,'revision',d.revision));
 return jsonb_build_object('number',v_no,'fy',v_fy,'revision',d.revision);
end $function$;

-- Revise: file the approved copy and reopen the quotation as a draft under the same number.
create function pulse.erp_quote_revise(p_doc uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.erp_require(true); d pulse.erp_document; f record;
begin
  select * into d from pulse.erp_document where org_id = pulse.current_org() and id = p_doc for update;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if d.doc_type <> 'quotation' then raise exception 'Only a quotation is revised; correct an invoice with a credit note' using errcode = '22023'; end if;
  if d.status not in ('issued', 'sent', 'accepted', 'declined') then raise exception 'Revise an approved quotation that is not converted or cancelled' using errcode = '22023'; end if;
  if exists(select 1 from pulse.erp_document x where x.source_id = d.id and x.status <> 'cancelled') then
    raise exception 'A proforma or invoice is already made from this quotation: delete or cancel it before revising' using errcode = '22023'; end if;
  select bytes, sha256 into f from pulse.erp_document_file where document_id = d.id and kind = 'pdf';
  insert into pulse.erp_document_revision(org_id, document_id, revision, snapshot, lines, pdf, pdf_sha256, reason, created_by)
    values (pulse.current_org(), d.id, d.revision, to_jsonb(d), coalesce((select jsonb_agg(to_jsonb(l) order by l.position) from pulse.erp_line l where l.document_id = d.id), '[]'),
      f.bytes, f.sha256, nullif(left(btrim(coalesce(p_reason, '')), 500), ''), me);
  insert into pulse_priv.erp_revise_mark(org_id, txid, document_id) values (pulse.current_org(), txid_current(), d.id) on conflict do nothing;
  delete from pulse.erp_document_file where document_id = d.id and kind = 'pdf';
  update pulse.erp_accept_link set revoked_at = now() where document_id = d.id and revoked_at is null;
  perform pulse.erp_followup_stop(d.id, 'off');
  update pulse.erp_document set status = 'draft', revision = d.revision + 1, decision = null, sent_at = null, sent_by = null, updated_by = me where id = d.id;
  delete from pulse_priv.erp_revise_mark where txid = txid_current() and document_id = d.id;
  perform pulse.erp_log('document', d.id, 'revised', jsonb_build_object('revision', d.revision + 1, 'from', d.status, 'total', d.total, 'note', nullif(left(btrim(coalesce(p_reason, '')), 500), '')));
  return jsonb_build_object('revision', d.revision + 1, 'number', d.number);
end $$;

-- Undo the revision: the filed copy comes back as it was (its status, figures, lines and PDF).
create function pulse.erp_quote_revise_undo(p_doc uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.erp_require(true); d pulse.erp_document; r pulse.erp_document_revision; o pulse.erp_document;
begin
  select * into d from pulse.erp_document where org_id = pulse.current_org() and id = p_doc for update;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if d.status <> 'draft' or d.number is null or d.revision < 1 then raise exception 'Only a revision that is not approved yet is undone' using errcode = '22023'; end if;
  select * into r from pulse.erp_document_revision where document_id = d.id and revision = d.revision - 1;
  if r.document_id is null then raise exception 'The approved copy of this quotation is not on file' using errcode = 'P0002'; end if;
  o := jsonb_populate_record(null::pulse.erp_document, r.snapshot);
  if d.doc_type <> 'quotation' then raise exception 'Only a quotation is revised' using errcode = '22023'; end if;
  insert into pulse_priv.erp_revise_mark(org_id, txid, document_id) values (pulse.current_org(), txid_current(), d.id) on conflict do nothing;
  -- The lines first, while the document is still a draft (an issued document's lines never change).
  delete from pulse.erp_line where document_id = d.id;
  insert into pulse.erp_line select * from jsonb_populate_recordset(null::pulse.erp_line, r.lines);
  update pulse.erp_document set status = o.status, issue_date = o.issue_date, valid_until = o.valid_until, buyer = o.buyer, place_of_supply = o.place_of_supply, reference = o.reference,
    notes = o.notes, terms = o.terms, round_total = o.round_total, tax_mode = o.tax_mode, taxable = o.taxable, cgst = o.cgst, sgst = o.sgst, igst = o.igst, round_off = o.round_off,
    total = o.total, amount_words = o.amount_words, design = o.design, template_id = o.template_id, issued_at = o.issued_at, issued_by = o.issued_by, sent_at = o.sent_at, sent_by = o.sent_by,
    decision = o.decision, client_id = coalesce(d.client_id, o.client_id), contact_person_id = coalesce(d.contact_person_id, o.contact_person_id),
    site_location = coalesce(o.site_location, d.site_location), revision = r.revision, updated_by = me where id = d.id;
  if r.pdf is not null then
    insert into pulse.erp_document_file(org_id, document_id, kind, bytes, sha256, created_by) values (pulse.current_org(), d.id, 'pdf', r.pdf, r.pdf_sha256, r.created_by) on conflict do nothing;
  end if;
  delete from pulse.erp_document_revision where document_id = d.id and revision = r.revision;
  delete from pulse_priv.erp_revise_mark where txid = txid_current() and document_id = d.id;
  perform pulse.erp_log('document', d.id, 'revision_undone', jsonb_build_object('revision', r.revision, 'status', o.status));
  return jsonb_build_object('revision', r.revision, 'status', o.status);
end $$;
revoke all on function pulse.erp_quote_revise(uuid, text), pulse.erp_quote_revise_undo(uuid) from public;
grant execute on function pulse.erp_quote_revise(uuid, text), pulse.erp_quote_revise_undo(uuid) to pulse_api;

-- The project heads of the company: who holds the delivery template's head role, else head_pgs, else leadership.
create function pulse.project_heads() returns uuid[] language sql stable security definer set search_path = pulse, pg_temp as $$
  with roles as (
    select coalesce(nullif((select array(select distinct jsonb_array_elements_text(coalesce(t.definition->'headRoles', '[]'::jsonb))
      from pulse.delivery_template t where t.org_id = pulse.current_org())), '{}'), array['head_pgs']) r),
  holders as (
    select distinct ra.person_id from pulse.role_assignment ra join pulse.person p on p.id = ra.person_id, roles
    where ra.org_id = pulse.current_org() and ra.role_key = any(roles.r) and p.side = 'staff' and p.status = 'active'
      and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity'))
  select coalesce(nullif((select array_agg(person_id order by person_id) from holders), '{}'),
    (select array_agg(distinct ra.person_id) from pulse.role_assignment ra join pulse.person p on p.id = ra.person_id
     where ra.org_id = pulse.current_org() and ra.role_key = 'leadership' and p.side = 'staff' and p.status = 'active'
       and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')), '{}')
$$;
revoke all on function pulse.project_heads() from public;
grant execute on function pulse.project_heads() to pulse_api;

-- Who plans and runs a project (1385's): also the project heads.
create or replace function pulse.project_can_run(p_project uuid) returns boolean
  language sql stable security definer set search_path to 'pulse', 'pg_temp' as $function$
  select pulse.current_viewer() is not null and (pulse.viewer_is('admin','leadership') or pulse.work_project_can_manage(p_project)
    or exists(select 1 from pulse.project p where p.org_id = pulse.current_org() and p.id = p_project and p.lead_person_id = pulse.current_viewer())
    or pulse.current_viewer() = any(pulse.project_heads()))
$function$;

-- Laying out a delivery plan (1387's project_plan_set), apart from who may ask for it, so a paid invoice lays out the
-- stages and due days of its project whoever records the payment. BILLING (review, 4 Nov 2026).
create function pulse.project_plan_lay(p_project uuid, p_template text, p_package text, p_category text, p_kickoff date, p_lead uuid)
  returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); tz text := pulse.org_time_zone(); def jsonb; st jsonb; pr pulse.project; lead uuid;
  made int := 0; matched int := 0; tid uuid; flag text; due timestamptz; won date; ttl text; kw text; i int;
begin
  select * into pr from pulse.project where org_id = pulse.current_org() and id = p_project and deleted_at is null;
  if pr.id is null then raise exception 'Project not found' using errcode = 'P0002'; end if;
  select definition into def from pulse.delivery_template where org_id = pulse.current_org() and key = p_template;
  if def is null then raise exception 'Choose a delivery template' using errcode = '22023'; end if;
  if p_package is null or not exists(select 1 from jsonb_array_elements(def->'packages') x where x->>'key' = p_package) then
    raise exception 'Choose the package that was sold' using errcode = '22023'; end if;
  if p_category is not null and not exists(select 1 from jsonb_array_elements(def->'categories') x where x->>'key' = p_category) then
    raise exception 'Choose the project category' using errcode = '22023'; end if;
  if p_kickoff is null then raise exception 'Choose the kick-off day' using errcode = '22023'; end if;
  if p_lead is not null and not exists(select 1 from pulse.person where org_id = pulse.current_org() and id = p_lead and side = 'staff' and status = 'active') then
    raise exception 'Choose an active member of staff as the lead' using errcode = '22023'; end if;
  if p_lead is not null then
    update pulse.project set lead_person_id = p_lead, updated_at = now() where id = p_project;
    update pulse.work_project set owner_id = p_lead, updated_at = now(), updated_by = me where project_id = p_project;
  end if;
  lead := coalesce(p_lead, pr.lead_person_id);
  update pulse.project set starts_on = coalesce(starts_on, p_kickoff), updated_at = now() where id = p_project;
  insert into pulse.project_plan(org_id, project_id, template_key, package, category, kickoff, created_by)
    values (pulse.current_org(), p_project, p_template, p_package, p_category, p_kickoff, me)
    on conflict (project_id) do update set template_key = excluded.template_key, package = excluded.package, category = excluded.category,
      kickoff = excluded.kickoff, updated_at = now();
  for st in select x from jsonb_array_elements(def->'steps') x loop
    flag := coalesce(st->'packages'->>p_package, 'no');
    continue when flag = 'no';
    continue when exists(select 1 from pulse.task t where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.template_step = st->>'id');
    due := case when st->>'end' is null then null else ((p_kickoff + (st->>'end')::int) + time '18:00') at time zone tz end;
    won := p_kickoff + greatest(0, (st->>'start')::int);
    -- A quotation line made into tasks takes the step (every matching unit: Model video #1 and #2).
    i := 0;
    for kw in select jsonb_array_elements_text(coalesce(st->'match', '[]'::jsonb)) loop
      with hit as (update pulse.task t set template_step = st->>'id', phase_key = 's' || (st->>'stage'), due_at = coalesce(t.due_at, due),
          work_on = coalesce(t.work_on, won), role_key = coalesce(t.role_key, left(st->>'owner', 60)), updated_at = now(), edited_by = me
        where t.org_id = pulse.current_org() and t.project_id = p_project and t.deleted_at is null and t.source = 'quote' and t.template_step is null
          and lower(t.title) like '%' || lower(kw) || '%' returning t.id)
      select count(*) into i from hit;
      matched := matched + i;
      exit when i > 0;
    end loop;
    continue when i > 0 or flag = 'optional';
    ttl := left(format('%s %s', st->>'id', st->>'title'), 300);
    insert into pulse.task(org_id, project_id, title, assignee_person_id, role_key, created_by, created_at, assigned_at, due_at, work_on,
        source, source_key, template_step, phase_key, notes, status)
      values (pulse.current_org(), p_project, ttl, case when st->>'owner' = def->'bandwidth'->>'role' then lead end, left(st->>'owner', 60), me, now(), now(), due, won,
        'template', format('plan:%s:%s', p_project, st->>'id'), st->>'id', 's' || (st->>'stage'),
        nullif(concat_ws(chr(10), case when (st->>'clientInput')::boolean then 'Needs the client''s input.' end,
          (select string_agg(format('%s. %s', n, c), chr(10) order by n) from jsonb_array_elements_text(coalesce(st->'checks', '[]'::jsonb)) with ordinality as x(c, n))), ''), 'open')
      on conflict (org_id, source_key) do nothing returning id into tid;
    if tid is not null then
      insert into pulse.task_event(org_id, task_id, actor_id, kind, to_value, note) values (pulse.current_org(), tid, me, 'created', ttl, 'From the delivery plan');
      made := made + 1; tid := null;
    end if;
  end loop;
  perform pulse.project_plan_links(p_project);
  perform pulse.audit_write('project_plan_set', 'project', p_project::text);
  return jsonb_build_object('projectId', p_project, 'tasks', made, 'matched', matched);
end $$;
revoke all on function pulse.project_plan_lay(uuid, text, text, text, date, uuid) from public;

-- Who may set a plan is unchanged (1385's check); the laying out is project_plan_lay.
create or replace function pulse.project_plan_set(p_project uuid, p_template text, p_package text, p_category text, p_kickoff date, p_lead uuid)
  returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not exists(select 1 from pulse.project where org_id = pulse.current_org() and id = p_project and deleted_at is null) then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if not pulse.project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership plan it' using errcode = '42501'; end if;
  return pulse.project_plan_lay(p_project, p_template, p_package, p_category, p_kickoff, p_lead);
end $$;

-- The project a paid invoice starts (internal: the payment trigger calls it with p_auto, Billing's "Start the project"
-- without). BILLING (review, 4 Nov 2026): by itself it starts only the project of a quotation (straight or through a
-- proforma) for a client with no live client project; a blank invoice (a retainer, an add-on, a one-off fee) or more
-- work for a client already being served starts nothing, and the invoice offers "Start the project" instead.
create function pulse.erp_project_on_payment(p_invoice uuid, p_auto boolean default false) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); tz text := pulse.org_time_zone(); inv pulse.erp_document; q pulse.erp_document; src uuid; pid uuid; reg int; nm text; made int := 0;
  ln record; part record; n int; i int; tid uuid; title text; heads uuid[]; h uuid; kickoff date := (now() at time zone pulse.org_time_zone())::date; booked jsonb;
  tpl pulse.delivery_template; pkg text; live record; planned jsonb;
begin
  select * into inv from pulse.erp_document where org_id = pulse.current_org() and id = p_invoice;
  if inv.id is null or inv.doc_type <> 'invoice' then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
  if inv.status not in ('part_paid', 'paid') then raise exception 'The project starts when the invoice is paid' using errcode = '22023'; end if;
  -- The quotation it came from: straight, or through a proforma.
  select x.* into q from pulse.erp_document x where x.id = inv.source_id and x.doc_type = 'quotation';
  if q.id is null then select y.* into q from pulse.erp_document x join pulse.erp_document y on y.id = x.source_id where x.id = inv.source_id and x.doc_type = 'proforma' and y.doc_type = 'quotation'; end if;
  select pq.project_id into pid from pulse.project_quote pq join pulse.project p on p.id = pq.project_id and p.deleted_at is null
    where pq.org_id = pulse.current_org() and pq.document_id in (inv.id, q.id) limit 1;
  if pid is not null then
    insert into pulse.project_quote(org_id, document_id, project_id, linked_by) values (pulse.current_org(), inv.id, pid, me) on conflict do nothing;
    return jsonb_build_object('projectId', pid, 'created', false, 'tasks', 0);
  end if;
  if inv.project_id is not null then return jsonb_build_object('projectId', inv.project_id, 'created', false, 'tasks', 0); end if; -- a milestone of a project's package
  booked := pulse.erp_book_client_do(inv.id);
  select * into inv from pulse.erp_document where id = p_invoice;
  if p_auto then
    if q.id is null then
      perform pulse.erp_log('document', inv.id, 'project_offered', jsonb_build_object('reason', 'blank'));
      return jsonb_build_object('projectId', null, 'created', false, 'offered', 'blank');
    end if;
    select p.id, coalesce(p.title, p.name) title into live from pulse.project p
      where p.org_id = pulse.current_org() and p.client_id = inv.client_id and p.kind = 'client_work' and p.status in ('onboarding', 'active') and p.deleted_at is null order by p.registry_no desc limit 1;
    if live.id is not null then
      perform pulse.erp_log('document', inv.id, 'project_offered', jsonb_build_object('reason', 'live', 'projectId', live.id, 'project', live.title));
      return jsonb_build_object('projectId', null, 'created', false, 'offered', 'live', 'liveProjectId', live.id);
    end if;
  end if;
  select * into tpl from pulse.delivery_template t where t.org_id = pulse.current_org() order by t.key limit 1;
  nm :=left(btrim(coalesce(nullif(inv.reference->>'project', ''), nullif(q.reference->>'project', ''), inv.buyer->>'name', 'Project from ' || coalesce(inv.number, 'an invoice'))), 160);
  perform pg_advisory_xact_lock(hashtext('project-register:' || pulse.current_org()::text));
  select coalesce(max(registry_no), 0) + 1 into reg from pulse.project where org_id = pulse.current_org();
  insert into pulse.project(org_id, registry_no, name, title, client_id, kind, status, starts_on, location, locked)
    values (pulse.current_org(), reg, nm, nm, inv.client_id, 'client_work', 'active', kickoff, coalesce(inv.site_location, q.site_location), '{title,client_id}')
    returning id into pid;
  insert into pulse.work_project(org_id, project_id, kind, owner_id, starts_on, status, summary, created_by, updated_by)
    values (pulse.current_org(), pid, 'fulfilment', null, kickoff, 'active',
      left(format('From invoice %s%s, paid %s', coalesce(inv.number, ''), case when q.id is not null then format(' (quotation %s)', q.number) else '' end, to_char(kickoff, 'DD Mon YYYY')), 1000), me, me)
    on conflict do nothing;
  insert into pulse.project_quote(org_id, document_id, project_id, linked_by) values (pulse.current_org(), inv.id, pid, me) on conflict do nothing;
  if q.id is not null then insert into pulse.project_quote(org_id, document_id, project_id, linked_by) values (pulse.current_org(), q.id, pid, me) on conflict do nothing; end if;
  -- What was sold becomes the work: N countable things are N tasks; a package is its parts (each part's quantity).
  src := coalesce(q.id, inv.id);
  for ln in select l.*, it.kind item_kind from pulse.erp_line l left join pulse.erp_item it on it.id = l.item_id
      where l.document_id = src and l.parent_position is null and not coalesce(l.not_needed, false) order by l.position loop
    if ln.item_kind = 'package' and exists(select 1 from pulse.erp_package_part pp where pp.package_id = ln.item_id) then
      for part in select pp.* from pulse.erp_package_part pp where pp.package_id = ln.item_id order by pp.position loop
        n := case when part.quantity is null or part.quantity <> trunc(part.quantity) or part.quantity < 2 or lower(coalesce(part.unit, '')) ~ '(month|milestone|lump|job|package|service)' then 1 else least(part.quantity::int, 24) end;
        for i in 1 .. n loop
          title := left(btrim(part.label) || case when n > 1 then format(' #%s', i) else '' end, 300);
          insert into pulse.task(org_id, project_id, title, created_by, created_at, source, source_ref, source_key, notes, status, work_on)
            values (pulse.current_org(), pid, title, me, now(), 'quote', ln.id::text, format('quote:%s:%s:%s', ln.id, part.position, i),
              nullif(left(concat_ws(chr(10), btrim(ln.description), array_to_string(part.deliverables, ', ')), 20000), ''), 'open', case when tpl.key is null then kickoff end)
            on conflict (org_id, source_key) do nothing returning id into tid;
          if tid is not null then made := made + 1; tid := null; end if;
        end loop;
      end loop;
      continue;
    end if;
    n := case when lower(coalesce(ln.unit, '')) ~ '(month|milestone|lump|job|package|service)' or ln.qty is null or ln.qty <> trunc(ln.qty) or ln.qty < 2 then 1 else least(ln.qty::int, 24) end;
    for i in 1 .. n loop
      title := left(btrim(ln.description) || case when n > 1 then format(' #%s', i) else '' end, 300);
      insert into pulse.task(org_id, project_id, title, created_by, created_at, source, source_ref, source_key, notes, status, work_on)
        values (pulse.current_org(), pid, title, me, now(), 'quote', ln.id::text, format('quote:%s:%s', ln.id, i), nullif(left(coalesce(ln.details, ''), 20000), ''), 'open', case when tpl.key is null then kickoff end)
        on conflict (org_id, source_key) do nothing returning id into tid;
      if tid is not null then made := made + 1; tid := null; end if;
    end loop;
  end loop;
  -- With a delivery template, the plan is laid out at once: its stages, and due days counted from the kick-off (today), the
  -- sold lines taking their steps (1385). The package is the one the quotation sold (a package line naming it), else the
  -- template's first; the project head picks the client category and the owner when assigning it.
  if tpl.key is not null then
    select x->>'key' into pkg from jsonb_array_elements(tpl.definition->'packages') with ordinality as t(x, o)
      where exists(select 1 from pulse.erp_line l left join pulse.erp_item it on it.id = l.item_id
        where l.document_id = src and l.parent_position is null and not coalesce(l.not_needed, false) and (it.kind = 'package' or l.item_id is null)
          and (lower(coalesce(it.name, l.description)) like '%' || lower(x->>'label') || '%' or lower(coalesce(it.name, l.description)) like '%' || replace(x->>'key', '_', ' ') || '%'))
      order by o limit 1;
    pkg := coalesce(pkg, tpl.definition->'packages'->0->>'key');
    if pkg is not null then planned := pulse.project_plan_lay(pid, tpl.key, pkg, null, kickoff, null); end if;
  end if;
  update pulse.task set work_on = kickoff where org_id = pulse.current_org() and project_id = pid and source = 'quote' and work_on is null;
  -- The heads are told (in Pulse) and become members of the project, so they see it and can assign it.
  heads := pulse.project_heads();
  foreach h in array heads loop
    insert into pulse.project_member(org_id, project_id, person_id, role, added_by)
      select pulse.current_org(), pid, h, 'member', me where not exists(select 1 from pulse.project_member m where m.project_id = pid and m.person_id = h and m.left_at is null);
    perform pulse.work_notify(h, 'project.added', 'project', pid, 'project.new:' || pid || ':' || h, left('New client to assign: ' || nm, 160), '/tasks/projects/' || pid, 'task');
  end loop;
  perform pulse.erp_log('document', inv.id, 'project_started', jsonb_build_object('projectId', pid, 'tasks', made + coalesce((planned->>'tasks')::int, 0), 'heads', coalesce(array_length(heads, 1), 0),
    'client', booked->'clientId', 'template', tpl.key, 'package', pkg));
  return jsonb_build_object('projectId', pid, 'created', true, 'tasks', made + coalesce((planned->>'tasks')::int, 0), 'heads', coalesce(array_length(heads, 1), 0), 'template', tpl.key, 'package', pkg);
end $$;
revoke all on function pulse.erp_project_on_payment(uuid, boolean) from public;

-- "Start the project" on a paid invoice whose project did not start by itself (Billing's writers only).
create function pulse.erp_project_start(p_invoice uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if pulse.current_viewer() is null or not pulse.erp_can(true) then raise exception 'Starting a project from an invoice is for leadership and the Finance role' using errcode = '42501'; end if;
  return pulse.erp_project_on_payment(p_invoice);
end $$;
revoke all on function pulse.erp_project_start(uuid) from public;
grant execute on function pulse.erp_project_start(uuid) to pulse_api;

-- The payment trigger (replaces 1387's start on issue): the first money in starts the project; a problem never stops the
-- payment, and is written in the invoice's activity (where "Start the project" offers it again).
create or replace function pulse.project_from_invoice() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.doc_type <> 'invoice' or new.status is not distinct from old.status or new.status not in ('part_paid', 'paid') or old.status not in ('issued', 'sent') then return null; end if;
  begin
    perform pulse.erp_project_on_payment(new.id, true);
  exception when others then
    perform pulse.erp_log('document', new.id, 'project_failed', jsonb_build_object('error', left(sqlerrm, 300)));
  end;
  return null;
end $$;

-- The project head's choice: the owner (the growth strategist who runs it) and the client category.
create function pulse.project_assign(p_project uuid, p_owner uuid, p_category text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := pulse.current_viewer(); pr pulse.project; cats jsonb; n int; pl pulse.project_plan; bw text;
begin
  select * into pr from pulse.project where org_id = pulse.current_org() and id = p_project and deleted_at is null;
  if pr.id is null then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if me is null or not pulse.project_can_run(p_project) then raise exception 'The project heads and leadership assign a new project' using errcode = '42501'; end if;
  if p_owner is null or not exists(select 1 from pulse.person where org_id = pulse.current_org() and id = p_owner and side = 'staff' and status = 'active') then
    raise exception 'Choose an active member of staff as the owner' using errcode = '22023'; end if;
  cats := coalesce((select t.definition->'categories' from pulse.delivery_template t where t.org_id = pulse.current_org() order by t.key limit 1),
    '[{"key":"sell_out"},{"key":"competitive"},{"key":"normal"}]'::jsonb);
  if p_category is null or not exists(select 1 from jsonb_array_elements(cats) x where x->>'key' = p_category) then raise exception 'Choose the client category' using errcode = '22023'; end if;
  update pulse.project set lead_person_id = p_owner, client_category = p_category, updated_at = now() where id = p_project;
  update pulse.work_project set owner_id = p_owner, updated_at = now(), updated_by = me where project_id = p_project;
  -- BILLING (review, 4 Nov 2026): the plan the payment laid out keeps the category and the lead once (the plan panel then
  -- shows them, never asks again); any step still missing is laid out.
  select * into pl from pulse.project_plan where org_id = pulse.current_org() and project_id = p_project;
  if pl.project_id is not null then
    perform pulse.project_plan_lay(p_project, pl.template_key, pl.package, case when exists(select 1 from pulse.delivery_template t, jsonb_array_elements(t.definition->'categories') x
      where t.org_id = pulse.current_org() and t.key = pl.template_key and x->>'key' = p_category) then p_category end, pl.kickoff, p_owner);
    bw := (select t.definition->'bandwidth'->>'role' from pulse.delivery_template t where t.org_id = pulse.current_org() and t.key = pl.template_key);
  end if;
  -- The owner takes the sold work and the plan's steps of the owner's role.
  update pulse.task set assignee_person_id = p_owner, assigned_at = now(), updated_at = now(), edited_by = me
    where org_id = pulse.current_org() and project_id = p_project and assignee_person_id is null and deleted_at is null and status = 'open'
      and (source = 'quote' or (source = 'template' and bw is not null and role_key = bw));
  get diagnostics n = row_count;
  perform pulse.work_notify(p_owner, 'project.added', 'project', p_project, 'project.owner:' || p_project || ':' || p_owner, left('You own a new client project: ' || coalesce(pr.title, pr.name), 160), '/tasks/projects/' || p_project, 'task');
  perform pulse.audit_write('project_assign', 'project', p_project::text);
  return jsonb_build_object('projectId', p_project, 'ownerId', p_owner, 'category', p_category, 'tasks', n);
end $$;
revoke all on function pulse.project_assign(uuid, uuid, text) from public;
grant execute on function pulse.project_assign(uuid, uuid, text) to pulse_api;

-- Where a project came from in Billing (the invoice and quotation numbers), for the people who run it or work on it, who
-- may not read Billing itself (a project head).
create function pulse.project_billing_source(p_project uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when pulse.project_can_run(p_project) or pulse.work_project_person(p_project, pulse.current_viewer()) then jsonb_build_object(
    'invoice', (select d.number from pulse.project_quote q join pulse.erp_document d on d.id = q.document_id where q.org_id = pulse.current_org() and q.project_id = p_project and d.doc_type = 'invoice' order by q.linked_at limit 1),
    'quotation', (select d.number from pulse.project_quote q join pulse.erp_document d on d.id = q.document_id where q.org_id = pulse.current_org() and q.project_id = p_project and d.doc_type = 'quotation' order by q.linked_at limit 1),
    'fromBilling', exists(select 1 from pulse.project_quote q where q.org_id = pulse.current_org() and q.project_id = p_project)) end
$$;
revoke all on function pulse.project_billing_source(uuid) from public;
grant execute on function pulse.project_billing_source(uuid) to pulse_api;

-- migrate:down
drop function pulse.project_billing_source(uuid);
drop function pulse.project_assign(uuid, uuid, text);
create or replace function pulse.erp_file_fixed() returns trigger language plpgsql as $$
begin raise exception 'The issued copy is kept as it was' using errcode='22023';end $$;
create or replace function pulse.project_from_invoice() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare q uuid; r jsonb; head record; roles text[]; ttl text;
begin
  if new.doc_type <> 'invoice' or new.status is not distinct from old.status or old.status <> 'draft' or new.status = 'cancelled' then return null; end if;
  select coalesce((select d.id from pulse.erp_document d where d.id = new.source_id and d.doc_type = 'quotation'),
                  (select d2.id from pulse.erp_document d join pulse.erp_document d2 on d2.id = d.source_id where d.id = new.source_id and d.doc_type = 'proforma' and d2.doc_type = 'quotation')) into q;
  if q is null or not exists(select 1 from pulse.erp_document where id = q and status = 'accepted') then return null; end if;
  if exists(select 1 from pulse.project_quote where org_id = new.org_id and document_id = q) then return null; end if;
  begin
    r := pulse.project_from_quote(q, null, null);
  exception when others then
    return null;
  end;
  select array(select jsonb_array_elements_text(coalesce(d.definition->'headRoles', '[]'::jsonb))) into roles from pulse.delivery_template d where d.org_id = new.org_id order by d.key limit 1;
  ttl := 'New project to assign: ' || coalesce((select coalesce(title, name) from pulse.project where id = (r->>'projectId')::uuid), 'from an invoice');
  for head in select distinct ra.person_id from pulse.role_assignment ra where ra.org_id = new.org_id and ra.role_key = any(coalesce(roles, '{}'))
      and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity') loop
    perform pulse.work_notify(head.person_id, 'project.added', 'project', (r->>'projectId')::uuid, 'project.new:' || (r->>'projectId') || ':' || head.person_id, ttl, '/tasks/projects/' || (r->>'projectId'), 'task');
  end loop;
  return null;
end $$;
drop function pulse.erp_project_start(uuid);
drop function pulse.erp_project_on_payment(uuid, boolean);
-- project_plan_set keeps 1471's form and project_plan_lay stays: it lays a plan out exactly as 1387's project_plan_set did.
create or replace function pulse.project_can_run(p_project uuid) returns boolean
  language sql stable security definer set search_path to 'pulse', 'pg_temp' as $function$
  select pulse.current_viewer() is not null and (pulse.viewer_is('admin','leadership') or pulse.work_project_can_manage(p_project)
    or exists(select 1 from pulse.project p where p.org_id = pulse.current_org() and p.id = p_project and p.lead_person_id = pulse.current_viewer()))
$function$;
drop function pulse.project_heads();
drop function pulse.erp_quote_revise_undo(uuid);
drop function pulse.erp_quote_revise(uuid, text);
create or replace function pulse.erp_document_issue(p_id uuid, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pulse', 'pg_temp' AS $function$
declare me uuid:=erp_require(true);d erp_document;s erp_series;v_fy text;v_no text;l record;inv erp_document;credited bigint;today date:=(now() at time zone pulse.org_time_zone())::date;
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
end $function$;
create or replace function pulse.erp_document_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then
  if old.status<>'draft' then raise exception 'An issued document is kept; cancel it or issue a credit note' using errcode='22023';end if;
  return old;
 end if;
 if old.status<>'draft' and ((new.doc_type,new.number,new.series_id,new.fy,new.issue_date,new.due_date,new.valid_until,new.project_id,new.engagement_id,
  new.milestone_id,new.against_id,new.source_id,new.seller,new.buyer,new.place_of_supply,new.reference,new.notes,new.terms,new.reverse_charge,new.zero_rated,
  new.round_total,new.tax_mode,new.taxable,new.cgst,new.sgst,new.igst,new.round_off,new.total,new.amount_words,new.design,new.issued_at,new.issued_by,new.template_id)
  is distinct from (old.doc_type,old.number,old.series_id,old.fy,old.issue_date,old.due_date,old.valid_until,old.project_id,old.engagement_id,
  old.milestone_id,old.against_id,old.source_id,old.seller,old.buyer,old.place_of_supply,old.reference,old.notes,old.terms,old.reverse_charge,old.zero_rated,
  old.round_total,old.tax_mode,old.taxable,old.cgst,old.sgst,old.igst,old.round_off,old.total,old.amount_words,old.design,old.issued_at,old.issued_by,old.template_id)
  or (old.client_id is not null and new.client_id is distinct from old.client_id)
  or (old.contact_person_id is not null and new.contact_person_id is distinct from old.contact_person_id)
  or (old.site_location is not null and new.site_location is distinct from old.site_location)) then
  raise exception 'An issued document cannot be edited; cancel it or issue a credit note' using errcode='22023';
 end if;
 if old.status in ('cancelled','converted','declined') and new.status is distinct from old.status then raise exception 'This document is closed' using errcode='22023';end if;
 if old.status<>'draft' and new.status='draft' then raise exception 'An issued document cannot go back to draft' using errcode='22023';end if;
 new.updated_at:=now();
 return new;
end $$;
drop table pulse.erp_document_revision;
drop function pulse.erp_revising(uuid);
drop table pulse_priv.erp_revise_mark;
alter table pulse.project drop column client_category;
-- (a quotation left in revision blocks this; approve or undo it first)
alter table pulse.erp_document drop constraint erp_document_numbered, add constraint erp_document_check check ((status = 'draft') = (number is null));
drop index pulse.erp_document_reissue;
alter table pulse.erp_document drop column reissue_of, drop column revision;
