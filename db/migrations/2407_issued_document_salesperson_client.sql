-- migrate:up
-- WL-SETUP-2 (owner order, 19 Nov 2026 02:09 IST: "solve all their issues"). Two gaps the Willow Lane audit found (A4, A9)
-- had no product path, because an issued document stays as issued and nothing else may touch it:
--
--   1. The salesperson of a document already sent. A quotation drafted before 2393 (QT/26-27/0002, drafted by bhrātā for
--      Adunor) or from a shared login records no salesperson, so the seller cannot mark it, revise it or record its
--      payment ("This deal is another salesperson's", 1670) and its follow-up goes to nobody. 2393 and 2404 fill it on new
--      quotations only. pulse.erp_document_salesperson(doc, person) names one: an active staff member who holds the sales
--      seat (sales or sales head) today. The salesperson is not on the printed copy and the issued-document guard never
--      froze it. The documents made from it that had the same salesperson (the same deal: its proforma, its invoice)
--      follow, as a new one made from it would (erp_sales_seat_insert copies the source's).
--
--   2. The client of an issued document that names none. A quotation whose buyer was typed in (QT/26-27/0001, "Majistique
--      Infra", issued minutes after the client "Majestique Infra" was added) is never linked: booking matches a name only
--      with the same e-mail or phone (1470), so it would make a second client. pulse.erp_document_client(doc, client)
--      links it to the client a person picks. The guard (1470) already lets a client be filled in on an issued document
--      that had none, never changed. The printed buyer stays as issued and no billing profile is made from it. The
--      documents made from it that name no client follow.
--
-- Both are a person's choice, never an AI employee's, for those who see every deal in Billing: leadership, Finance, the
-- sales head and an admin with the money grants (erp_can(true) and not erp_own_only()). Each writes one line in the
-- document's activity log ("salesperson" with before and after; "client_linked"). Running either again changes nothing.

create function pulse.erp_document_salesperson(p_doc uuid, p_person uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d pulse.erp_document; n int;
begin
  if pulse.current_viewer() is null or pulse.agent_session() is not null or not pulse.erp_can(true) or pulse.erp_own_only() then
    raise exception 'Choosing a document''s salesperson is for leadership, Finance and the sales head' using errcode = '42501'; end if;
  select * into d from pulse.erp_document where org_id = pulse.current_org() and id = p_doc for update;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if p_person is null or not exists(select 1 from pulse.person p where p.id = p_person and p.org_id = pulse.current_org() and p.side = 'staff' and p.status = 'active'
      and exists(select 1 from pulse.role_assignment ra where ra.person_id = p.id and ra.org_id = p.org_id and ra.role_key in ('sales', 'sales_head')
        and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity'))) then
    raise exception 'Choose a salesperson: an active member of the team with the sales seat' using errcode = '22023'; end if;
  if d.salesperson_id is not distinct from p_person then
    return jsonb_build_object('changed', false, 'salespersonId', p_person, 'documents', 0); end if;
  with recursive deal(id) as (
    select d.id
    union
    select x.id from pulse.erp_document x join deal on x.source_id = deal.id where x.org_id = pulse.current_org())
  update pulse.erp_document x set salesperson_id = p_person from deal
   where x.id = deal.id and (x.id = d.id or x.salesperson_id is not distinct from d.salesperson_id);
  get diagnostics n = row_count;
  perform pulse.erp_log('document', d.id, 'salesperson', jsonb_build_object('from', d.salesperson_id, 'to', p_person, 'documents', n));
  return jsonb_build_object('changed', true, 'salespersonId', p_person, 'documents', n);
end $$;

create function pulse.erp_document_client(p_doc uuid, p_client uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d pulse.erp_document; n int;
begin
  if pulse.current_viewer() is null or pulse.agent_session() is not null or not pulse.erp_can(true) or pulse.erp_own_only() then
    raise exception 'Linking a document to a client is for leadership, Finance and the sales head' using errcode = '42501'; end if;
  select * into d from pulse.erp_document where org_id = pulse.current_org() and id = p_doc for update;
  if d.id is null then raise exception 'Document not found' using errcode = 'P0002'; end if;
  if p_client is null or not exists(select 1 from pulse.client c where c.id = p_client and c.org_id = pulse.current_org()
      and not exists(select 1 from pulse.record_merge m where m.org_id = c.org_id and m.entity_type = 'client' and m.gone_id = c.id and m.undone_at is null)) then
    raise exception 'That client is not in Clients' using errcode = '22023'; end if;
  if d.client_id = p_client then return jsonb_build_object('changed', false, 'clientId', p_client, 'documents', 0); end if;
  if d.client_id is not null then
    raise exception 'This document already names a client%', case when d.status = 'draft' then ': change it in the draft' else '; an issued document keeps it' end
      using errcode = '22023'; end if;
  with recursive deal(id) as (
    select d.id
    union
    select x.id from pulse.erp_document x join deal on x.source_id = deal.id where x.org_id = pulse.current_org())
  update pulse.erp_document x set client_id = p_client from deal where x.id = deal.id and x.client_id is null;
  get diagnostics n = row_count;
  perform pulse.erp_log('document', d.id, 'client_linked', jsonb_build_object('clientId', p_client, 'documents', n));
  return jsonb_build_object('changed', true, 'clientId', p_client, 'documents', n);
end $$;

revoke all on function pulse.erp_document_salesperson(uuid, uuid), pulse.erp_document_client(uuid, uuid) from public;
grant execute on function pulse.erp_document_salesperson(uuid, uuid), pulse.erp_document_client(uuid, uuid) to pulse_api;

-- migrate:down
drop function if exists pulse.erp_document_client(uuid, uuid);
drop function if exists pulse.erp_document_salesperson(uuid, uuid);
