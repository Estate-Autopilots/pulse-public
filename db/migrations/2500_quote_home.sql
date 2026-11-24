-- migrate:up
-- QUOTE-FIXES (Mac test of production b7110a07, 21 Nov 2026, DEVICE-BUG-0700 qt-marked-sent-without-sending and
-- DEVICE-BUG-0015 followup-not-on-my-day; owner, 20 Nov: "a visible 'not sent yet' state and an exact follow-up on Home").
-- A sent quotation's follow-up (0520) became a task only on its day, so Home showed nothing until then, and a numbered
-- quotation nobody sent waited unseen. pulse.erp_quote_home(): for the signed-in person only, their next scheduled
-- follow-ups (number, client, when) and how many of their numbered quotations are not sent yet. Their own documents only
-- (the follow-up's salesperson; the quotation's salesperson, sender or maker); nothing about anyone else's.
create function pulse.erp_quote_home() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object(
  'followUps', coalesce((select jsonb_agg(jsonb_build_object('documentId', d.id, 'number', d.number, 'client', coalesce(nullif(btrim(d.buyer->>'name'), ''), 'the client'),
      'nextDueAt', f.next_due_at) order by f.next_due_at)
    from (select x.document_id, x.next_due_at from erp_followup x where x.org_id = current_org() and x.state = 'scheduled' and x.person_id = current_viewer()
      order by x.next_due_at limit 5) f join erp_document d on d.id = f.document_id), '[]'::jsonb),
  'notSent', (select count(*)::int from erp_document d where d.org_id = current_org() and d.doc_type = 'quotation' and d.status = 'issued' and d.sent_at is null
    and current_viewer() in (d.salesperson_id, d.created_by, d.issued_by)))
 where current_viewer() is not null and current_org() is not null
$$;
comment on function pulse.erp_quote_home() is 'QUOTE-FIXES (2500): the signed-in person''s next quote follow-ups and their quotations not sent yet, for Home';
revoke all on function pulse.erp_quote_home() from public;
grant execute on function pulse.erp_quote_home() to pulse_api;

-- migrate:down
drop function pulse.erp_quote_home();
