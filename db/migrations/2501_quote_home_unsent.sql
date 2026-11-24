-- migrate:up
-- QUOTE-FIXES round 2 (Mac re-test of release 3214d396, 21 Nov 2026: "Home shows draft quotes, but the proforma is
-- missing"): pulse.erp_quote_home (2500) counted only quotations not sent yet, while "Not yet" on a proforma says it waits
-- on Home. Now it counts numbered quotations and proformas not sent yet and lists the first five (number, kind, client),
-- so Home and My day can link each one. The person's own documents only, as in 2500.
create or replace function pulse.erp_quote_home() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
 with mine as (
  select d.id, d.doc_type, d.number, coalesce(nullif(btrim(d.buyer->>'name'), ''), 'the client') client, d.issued_at
  from erp_document d where d.org_id = current_org() and d.doc_type in ('quotation', 'proforma') and d.status = 'issued' and d.sent_at is null
   and current_viewer() in (d.salesperson_id, d.created_by, d.issued_by))
 select jsonb_build_object(
  'followUps', coalesce((select jsonb_agg(jsonb_build_object('documentId', d.id, 'number', d.number, 'client', coalesce(nullif(btrim(d.buyer->>'name'), ''), 'the client'),
      'nextDueAt', f.next_due_at) order by f.next_due_at)
    from (select x.document_id, x.next_due_at from erp_followup x where x.org_id = current_org() and x.state = 'scheduled' and x.person_id = current_viewer()
      order by x.next_due_at limit 5) f join erp_document d on d.id = f.document_id), '[]'::jsonb),
  'notSent', (select count(*)::int from mine),
  'notSentDocs', coalesce((select jsonb_agg(jsonb_build_object('documentId', m.id, 'docType', m.doc_type, 'number', m.number, 'client', m.client, 'issuedAt', m.issued_at)
      order by m.issued_at desc) from (select * from mine order by issued_at desc limit 5) m), '[]'::jsonb))
 where current_viewer() is not null and current_org() is not null
$$;

-- migrate:down
create or replace function pulse.erp_quote_home() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object(
  'followUps', coalesce((select jsonb_agg(jsonb_build_object('documentId', d.id, 'number', d.number, 'client', coalesce(nullif(btrim(d.buyer->>'name'), ''), 'the client'),
      'nextDueAt', f.next_due_at) order by f.next_due_at)
    from (select x.document_id, x.next_due_at from erp_followup x where x.org_id = current_org() and x.state = 'scheduled' and x.person_id = current_viewer()
      order by x.next_due_at limit 5) f join erp_document d on d.id = f.document_id), '[]'::jsonb),
  'notSent', (select count(*)::int from erp_document d where d.org_id = current_org() and d.doc_type = 'quotation' and d.status = 'issued' and d.sent_at is null
    and current_viewer() in (d.salesperson_id, d.created_by, d.issued_by)))
 where current_viewer() is not null and current_org() is not null
$$;
