-- migrate:up
-- KAZUK-FLOW G7 + G8 (Kazuk, 6 Nov 2026: "how the first quotation was, the second, the final: how one particular
-- salesperson negotiates"). Versions as data and one status per deal:
--  G8  A new version of a sent quotation records why, from a fixed list (price, scope, timeline, other) beside its note
--      (pulse.erp_quote_new_version over 1471's revise). Each filed version keeps its date sent in its snapshot; a tax
--      invoice or proforma made from a quotation records which version it came from (erp_document.source_revision).
--  G7  The deal's status, worked out from the quotation and what was made from it (pulse.erp_deal_status): Draft, To send,
--      Sent, Negotiating (the customer's reply was logged as negotiating, or a new version followed), Accepted, Lost,
--      Invoiced, Part-paid, Paid. "Lost" takes a reason from a fixed list (price, competitor, no response, timing, scope,
--      other) and a note (pulse.erp_quote_lost), reportable.
--  G9  An invoice made from a quotation keeps its lines, quantities and prices for the people the invoice step locks
--      (EA's preset: the sales role; linesLocked), so the invoice is the accepted version exactly; dates, terms and the
--      client's GST details stay editable. A GST-registered client's invoice needs the billing address too (the API).
-- The sales flow's steps (1671) decide who may: version, accept (log a reply) and lost.
-- Synthetic data only in tests; nothing here reads or writes production data.

alter table pulse.erp_document_revision add column reason_kind text check (reason_kind in ('price', 'scope', 'timeline', 'other'));
comment on column pulse.erp_document_revision.reason_kind is 'KAZUK-FLOW G8 (7 Nov 2026): why the next version was made: price, scope, timeline or other (the note is reason)';
alter table pulse.erp_document
  add column lost_reason text check (lost_reason in ('price', 'competitor', 'no_response', 'timing', 'scope', 'other')),
  add column lost_note text check (length(lost_note) <= 500),
  add column negotiating_at timestamptz,
  add column source_revision int check (source_revision >= 0);
comment on column pulse.erp_document.source_revision is 'KAZUK-FLOW G8 (7 Nov 2026): the version (revision) of the source quotation this document was made from';

-- The version an invoice or proforma is made from.
create function pulse.erp_source_revision() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.source_id is not null and new.source_revision is null then
    new.source_revision := (select d.revision from erp_document d where d.id = new.source_id);
  end if;
  return new;
end $$;
revoke all on function pulse.erp_source_revision() from public;
create trigger erp_source_revision before insert on pulse.erp_document for each row execute function pulse.erp_source_revision();

-- A new version with its reason (1471's revise underneath: the sent copy is filed, the quotation reopens, same number).
create function pulse.erp_quote_new_version(p_doc uuid, p_kind text, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r jsonb; note text := nullif(left(btrim(coalesce(p_note, '')), 400), '');
begin
  perform erp_require(true);
  if p_kind is null or p_kind not in ('price', 'scope', 'timeline', 'other') then
    raise exception 'Say why there is a new version: price, scope, timeline or other' using errcode = '22023'; end if;
  r := erp_quote_revise(p_doc, initcap(p_kind) || coalesce(': ' || note, ''));
  update erp_document_revision set reason_kind = p_kind where document_id = p_doc and revision = (r->>'revision')::int - 1;
  return r || jsonb_build_object('reason', p_kind);
end $$;

-- The customer replied and the deal is being negotiated (the quotation stays with them).
create function pulse.erp_quote_negotiating(p_doc uuid, p_note text) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d erp_document;
begin
  perform erp_require(true);
  select * into d from erp_document where org_id = current_org() and id = p_doc for update;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if d.doc_type <> 'quotation' or d.status not in ('issued', 'sent') then raise exception 'A quotation with the customer is negotiated' using errcode = '22023'; end if;
  update erp_document set negotiating_at = now(), status = case when status = 'issued' then 'sent' else status end, sent_at = coalesce(sent_at, now()),
    sent_by = coalesce(sent_by, current_viewer()), updated_by = current_viewer() where id = d.id;
  perform erp_log('document', d.id, 'negotiating', jsonb_build_object('note', nullif(left(btrim(coalesce(p_note, '')), 500), ''), 'revision', d.revision));
  return 'negotiating';
end $$;

-- A lost deal, with its reason.
create function pulse.erp_quote_lost(p_doc uuid, p_reason text, p_note text) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare st text;
begin
  perform erp_require(true);
  if p_reason is null or p_reason not in ('price', 'competitor', 'no_response', 'timing', 'scope', 'other') then
    raise exception 'Say why the deal was lost: price, competitor, no response, timing, scope or other' using errcode = '22023'; end if;
  st := erp_document_mark(p_doc, 'declined', coalesce(nullif(btrim(coalesce(p_note, '')), ''), replace(p_reason, '_', ' ')));
  update erp_document set lost_reason = p_reason, lost_note = nullif(left(btrim(coalesce(p_note, '')), 500), '') where org_id = current_org() and id = p_doc;
  perform erp_log('document', p_doc, 'lost', jsonb_build_object('reason', p_reason, 'note', nullif(left(btrim(coalesce(p_note, '')), 500), '')));
  return st;
end $$;

-- One status per deal, from the quotation and the invoice made from it.
create function pulse.erp_deal_status(p_doc uuid) returns text language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when q.doc_type <> 'quotation' then null
    when i.status = 'paid' then 'paid' when i.status = 'part_paid' then 'part_paid' when i.status in ('issued', 'sent') then 'invoiced'
    when q.status = 'declined' then 'lost' when q.status = 'cancelled' then 'cancelled' when q.status in ('accepted', 'converted') then 'accepted'
    when q.status = 'sent' and (q.negotiating_at is not null or q.revision > 0) then 'negotiating'
    when q.status = 'sent' then 'sent' when q.status = 'issued' then 'to_send'
    when q.status = 'draft' and q.revision > 0 then 'negotiating' else 'draft' end
  from erp_document q left join lateral (select x.status from erp_document x where x.org_id = q.org_id and x.source_id = q.id and x.doc_type = 'invoice'
    and x.status <> 'cancelled' order by x.created_at desc limit 1) i on true
  where q.org_id = current_org() and q.id = p_doc
$$;
revoke all on function pulse.erp_quote_new_version(uuid, text, text), pulse.erp_quote_negotiating(uuid, text), pulse.erp_quote_lost(uuid, text, text), pulse.erp_deal_status(uuid) from public;
grant execute on function pulse.erp_quote_new_version(uuid, text, text), pulse.erp_quote_negotiating(uuid, text), pulse.erp_quote_lost(uuid, text, text), pulse.erp_deal_status(uuid) to pulse_api;

-- G9: EA's preset locks an invoice's lines to its quotation for the sales role (linesLocked on the invoice step).
create or replace function pulse.erp_flow_preset(p_preset text) returns jsonb language sql immutable as $$
 select case p_preset
  when 'ea' then pulse.erp_flow_defaults() || jsonb_build_object(
    'price', pulse.erp_flow_defaults()->'price' || '{"on": false}'::jsonb,
    'send', pulse.erp_flow_defaults()->'send' || '{"required": ["name", "contactName", "phone", "email", "siteLocation"]}'::jsonb,
    'invoice', pulse.erp_flow_defaults()->'invoice' || '{"linesLocked": true}'::jsonb)
  when 'wl' then pulse.erp_flow_defaults()
  else pulse.erp_flow_defaults() end
$$;
-- Whether this person may not change a draft's lines: a proforma or invoice made from a quotation, under a flow whose
-- invoice step locks lines for a role the person holds (and no unlocking role).
create function pulse.erp_lines_locked(p_doc uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select d.doc_type in ('invoice', 'proforma') and d.source_id is not null
    and coalesce((erp_flow_step('invoice')->>'linesLocked')::boolean, false)
    and viewer_is(variadic array(select jsonb_array_elements_text(coalesce(erp_flow_step('invoice')->'lockedFor', '[]'::jsonb))))
    and not (jsonb_array_length(coalesce(erp_flow_step('invoice')->'unlock', '[]'::jsonb)) > 0 and erp_flow_holds(erp_flow_step('invoice')->'unlock'))
    from erp_document d where d.org_id = current_org() and d.id = p_doc), false)
$$;
revoke all on function pulse.erp_lines_locked(uuid) from public;
grant execute on function pulse.erp_lines_locked(uuid) to pulse_api;

-- migrate:down
-- Forward-only: the columns keep the negotiation data.
