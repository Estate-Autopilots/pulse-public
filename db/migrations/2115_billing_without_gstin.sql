-- migrate:up
-- VITALS-CLOSEOUT (owner, 15 Nov 2026: "fix billing so Vitals can invoice without a GSTIN"). A company that is not yet
-- registered for GST (Vitals Technology before incorporation) could only issue a proforma: issuing an invoice refused
-- with "A tax invoice needs the company's GSTIN". Under GST an unregistered business may not charge GST or call its bill
-- a tax invoice, but it still invoices. Now an invoice or credit note from a seller with no GSTIN is issued when it
-- carries no GST; the API saves such documents at 0% GST and the PDF says "Invoice" with a line that no GST is charged.
-- Only this one check in pulse.erp_document_issue (as last defined in 1471) changes.
create or replace function pulse.erp_document_issue(p_id uuid, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare me uuid:=erp_require(true);d erp_document;s erp_series;v_fy text;v_no text;l record;inv erp_document;credited bigint;today date:=(now() at time zone pulse.org_time_zone())::date;
begin
 select * into d from erp_document where id=p_id for update;
 if d.id is null then raise exception 'Document not found' using errcode='P0002';end if;
 if d.status<>'draft' then raise exception 'Only a draft is issued' using errcode='22023';end if;
 if coalesce(btrim(d.buyer->>'name'),'')='' then raise exception 'Name the client to bill' using errcode='22023';end if;
 if coalesce(d.seller->>'stateCode','')!~'^[0-9]{2}$' or coalesce(btrim(d.seller->>'legalName'),'')='' then raise exception 'Fill in the company profile first, in ERP settings' using errcode='22023';end if;
 -- VITALS-CLOSEOUT (owner, 15 Nov 2026): a business with no GSTIN is not registered for GST. It still bills: its invoice
 -- and credit note carry no GST (erp.ts saves them at 0%) and print as a plain Invoice; one that adds GST is refused.
 if d.doc_type in ('invoice','credit_note') and coalesce(btrim(d.seller->>'gstin'),'')='' and d.cgst+d.sgst+d.igst<>0 then raise exception 'Without a GSTIN no GST is charged: open the document and save it again' using errcode='22023';end if;
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

-- migrate:down
create or replace function pulse.erp_document_issue(p_id uuid, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
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
