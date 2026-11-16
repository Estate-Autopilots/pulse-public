-- migrate:up
-- WL-PROMISES (CEO room msgs 140, 155, 171): what Willow Lane's install key and AI member could not reach.
--  1. Two narrow service scopes: files.read (an issued quotation's filed PDF) and site_visits.read (visit reads).
--  2. The quotation's life as events and webhooks on the existing stream (1594): created, approval_requested, sent,
--     accepted, declined, cancelled (accepted is the hand-over signal); plus a one-record filter for the activity read.
--  3. Quote revisions (msg 155): a draft made with revisionOf joins the family of the quotation it revises. A revised
--     draft is superseded at once; an approved one is superseded when staff approve the next revision, which keeps the
--     family's number and prints R2, R3 ... A quotation's number is therefore unique per revision, not per document
--     (invoices, proformas and credit notes stay unique per number). A draft can be cancelled with a reason; nothing is
--     deleted, and a draft cancelled before it was ever numbered keeps no number.
--  4. Lead-create (msg 140): a prospect client added by the assistant for a quotation, one per phone number.
-- No new tables.

alter table pulse_priv.service_key drop constraint service_key_scopes_check;
alter table pulse_priv.service_key add constraint service_key_scopes_check check(cardinality(scopes)>0
 and array_position(scopes,null) is null and scopes <@ (array['catalog.read','clients.read','leads.read','quotes.draft.create','notify.quote_ready','chats.post','updates.post','updates.requests.manage','files.read','site_visits.read']||pulse.v1_scopes()));

-- 1. ------------------------------------------------------------------------------------------- PDF and site visits
-- The filed copy of an issued quotation only: a draft has none, and invoices are not part of this scope.
create function pulse.service_quotation_pdf(p_key uuid, p_hash text, p_document uuid) returns table(bytes bytea, number text)
language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if service_key_auth(p_key,p_hash,'files.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 return query select f.bytes, d.number from erp_document d join erp_document_file f on f.document_id=d.id and f.org_id=d.org_id and f.kind='pdf'
  where d.id=p_document and d.org_id=current_org() and d.doc_type='quotation' and d.status in ('issued','sent','accepted','declined');
end $$;

-- An allowlist, newest first: never starting_fields (a copy of the customer's details) or the change history.
create function pulse.service_site_visits(p_key uuid, p_hash text, p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if service_key_auth(p_key,p_hash,'site_visits.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 return jsonb_build_object('items', coalesce((select jsonb_agg(v.j order by v.created_at desc, v.id desc) from (
   select s.id, s.created_at, jsonb_build_object('id',s.id,'customerId',s.customer_id,'typeKey',s.type_key,'status',s.status,'assignedPersonId',s.assigned_person_id,
    'notes',s.notes,'createdAt',s.created_at,'submittedAt',s.submitted_at) j
   from site_visit s where s.org_id=current_org() and s.customer_id=p_customer order by s.created_at desc, s.id desc limit 200) v), '[]'::jsonb));
end $$;

create function pulse.service_site_visit(p_key uuid, p_hash text, p_visit uuid) returns jsonb
language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if service_key_auth(p_key,p_hash,'site_visits.read') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 return (select jsonb_build_object('id',s.id,'customerId',s.customer_id,'typeKey',s.type_key,'status',s.status,'assignedPersonId',s.assigned_person_id,
    'notes',s.notes,'createdAt',s.created_at,'submittedAt',s.submitted_at,
    'fieldNotes',coalesce((select jsonb_agg(jsonb_build_object('key',n.field_key,'notes',n.notes) order by n.field_key) from site_visit_field_note n where n.visit_id=s.id and n.org_id=s.org_id),'[]'::jsonb))
   from site_visit s where s.id=p_visit and s.org_id=current_org());
end $$;

revoke all on function pulse.service_quotation_pdf(uuid,text,uuid), pulse.service_site_visits(uuid,text,uuid), pulse.service_site_visit(uuid,text,uuid) from public;
grant execute on function pulse.service_quotation_pdf(uuid,text,uuid), pulse.service_site_visits(uuid,text,uuid), pulse.service_site_visit(uuid,text,uuid) to pulse_api;

-- 2. ------------------------------------------------------------------------------------------- events
create or replace function pulse.v1_event_types() returns text[] language sql immutable as $$
 select array['task.created','task.updated','task.completed','project.created','project.updated','project.deleted',
  'expense.created','expense.approved','expense.rejected','leave.requested','leave.decided',
  'quotation.issued','invoice.issued','invoice.paid','chat.message.posted',
  'quotation.created','quotation.approval_requested','quotation.sent','quotation.accepted','quotation.declined','quotation.cancelled']
$$;

create or replace function pulse.v1_event_document() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d jsonb := jsonb_build_object('documentId', new.id, 'clientId', new.client_id, 'status', new.status);
begin
 if new.doc_type not in ('quotation', 'invoice') then return null; end if;
 if new.issued_at is not null and (tg_op = 'INSERT' or old.issued_at is null) then
  perform v1_event_emit(new.org_id, new.doc_type || '.issued', new.id, d);
 end if;
 if new.doc_type = 'invoice' and new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
  perform v1_event_emit(new.org_id, 'invoice.paid', new.id, d);
 end if;
 if new.doc_type = 'quotation' then
  if tg_op = 'INSERT' then perform v1_event_emit(new.org_id, 'quotation.created', new.id, d); end if;
  if new.task_id is not null and new.issued_at is null and (tg_op = 'INSERT' or old.task_id is null) then
   perform v1_event_emit(new.org_id, 'quotation.approval_requested', new.id, d);
  end if;
  if new.status in ('sent','accepted','declined','cancelled') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
   perform v1_event_emit(new.org_id, 'quotation.' || new.status, new.id, d);
  end if;
 end if;
 return null;
end $$;

-- The activity read (GET /api/v1/events/activity): the same events, for one record when subjectId is given.
create function pulse.v1_events_after(p_after uuid, p_areas text[], p_types text[], p_take int, p_subject uuid) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_org() is null or current_viewer() is null or coalesce(current_setting('pulse.v1_token_id', true), '') = '' then
  raise exception 'An API key reads events' using errcode = '42501'; end if;
 insert into pulse_priv.v1_event_listen(org_id, seen_at) values (current_org(), now())
  on conflict (org_id) do update set seen_at = excluded.seen_at where pulse_priv.v1_event_listen.seen_at < now() - interval '1 minute';
 return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'type', e.type, 'createdAt', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'subjectId', e.subject_id, 'data', e.data) order by e.id) from (select * from pulse_priv.v1_event x
   where x.org_id = current_org() and x.type <> 'webhook.ping' and (p_after is null or x.id > p_after) and v1_event_area(x.type) = any(p_areas)
    and (p_types is null or x.type = any(p_types)) and (p_subject is null or x.subject_id = p_subject) and x.created_at < clock_timestamp() - interval '5 seconds'
   order by x.id limit least(greatest(p_take, 1), 101)) e), '[]');
end $$;
revoke all on function pulse.v1_events_after(uuid,text[],text[],int,uuid) from public;
grant execute on function pulse.v1_events_after(uuid,text[],text[],int,uuid) to pulse_api;

-- 3. ------------------------------------------------------------------------------------------- quote revisions
alter table pulse.erp_document add column revision_group_id uuid references pulse.erp_document(id),
 add column revision_of uuid references pulse.erp_document(id), add column superseded_by uuid references pulse.erp_document(id);
create index erp_document_revision_group on pulse.erp_document(org_id, revision_group_id) where revision_group_id is not null;
create index erp_document_revision_of on pulse.erp_document(org_id, revision_of) where revision_of is not null;

-- A draft cancelled before it was ever numbered keeps no number.
alter table pulse.erp_document drop constraint erp_document_numbered;
alter table pulse.erp_document add constraint erp_document_numbered check ((number is null) = (status = 'draft' and revision = 0)
 or (status = 'cancelled' and number is null and issued_at is null and revision = 0));

-- A family's revisions share its number; each revision is unique.
alter table pulse.erp_document drop constraint erp_document_org_id_doc_type_fy_number_key;
create unique index erp_document_number_unique on pulse.erp_document(org_id, doc_type, fy, number) where doc_type <> 'quotation';
create unique index erp_document_quotation_number_unique on pulse.erp_document(org_id, fy, number, revision) where doc_type = 'quotation';

-- Closes a draft (cancelled, or superseded by p_by). Its approval request, if any, is withdrawn.
create function pulse.erp_quote_close_draft(p_doc uuid, p_reason text, p_by uuid) returns void
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d erp_document;
begin
 select * into d from erp_document where org_id=current_org() and id=p_doc for update;
 if d.id is null or d.doc_type<>'quotation' then raise exception 'Quotation not found' using errcode='P0002'; end if;
 if d.status<>'draft' then raise exception 'Only a draft is cancelled here; staff cancel an approved quotation in Billing' using errcode='P0409'; end if;
 update erp_document set status='cancelled', cancelled_at=now(), cancel_reason=left(p_reason,500), superseded_by=p_by where id=d.id;
 if d.task_id is not null then
  begin
   perform task_move(d.task_id, 'cancelled', left(case when p_by is null then 'The quotation was cancelled' else 'A newer revision replaced this quotation' end, 200));
  exception when others then perform erp_log('document', d.id, 'approval_task_open', jsonb_build_object('taskId', d.task_id));
  end;
 end if;
 perform erp_log('document', d.id, case when p_by is null then 'cancelled' else 'superseded' end, jsonb_strip_nulls(jsonb_build_object('by', p_by, 'reason', left(p_reason,500))));
end $$;
revoke all on function pulse.erp_quote_close_draft(uuid,text,uuid) from public;

-- The family fields a service caller sees on a quotation it made.
create function pulse.service_quote_revision_info(p_key uuid, p_hash text, p_doc uuid) returns jsonb
language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if service_key_auth(p_key,p_hash,'quotes.draft.create') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 return (select jsonb_build_object('id',d.id,'status',d.status,'number',d.number,'revision',d.revision,'revisionGroupId',coalesce(d.revision_group_id,d.id),
   'revisionOf',d.revision_of,'supersededBy',d.superseded_by,'cancelReason',case when d.status='cancelled' then d.cancel_reason end)
  from erp_document d where d.org_id=current_org() and d.id=p_doc and d.doc_type='quotation');
end $$;

-- A new service draft (p_new, made by this key in this transaction) becomes the next revision of p_of. p_of must be
-- the family's latest revision, still open, for the same client or lead.
create function pulse.service_quote_revision_link(p_key uuid, p_hash text, p_new uuid, p_of uuid) returns void
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x erp_document; y erp_document; grp uuid;
begin
 if service_key_auth(p_key,p_hash,'quotes.draft.create') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 select * into x from erp_document where org_id=current_org() and id=p_of and doc_type='quotation';
 if x.id is null then raise exception 'The quotation to revise was not found' using errcode='P0002'; end if;
 grp := coalesce(x.revision_group_id, x.id);
 perform pg_advisory_xact_lock(hashtextextended('quote-family:'||grp::text,0));
 select * into x from erp_document where id=p_of for update;
 select * into y from erp_document where org_id=current_org() and id=p_new and service_key_id=p_key and doc_type='quotation' for update;
 if y.id is null or y.status<>'draft' or y.revision_of is not null or y.number is not null then raise exception 'Revision draft unavailable' using errcode='P0002'; end if;
 if x.superseded_by is not null or x.status in ('cancelled','converted')
    or exists(select 1 from erp_document z where z.org_id=current_org() and z.revision_of=x.id and z.id<>y.id and z.status<>'cancelled') then
  raise exception 'That revision is closed or not the latest: revise the latest revision of this quotation' using errcode='P0409'; end if;
 if (y.client_id, y.lead_id) is distinct from (x.client_id, x.lead_id) then
  raise exception 'A revision is for the same client or lead as the quotation it revises' using errcode='P0409'; end if;
 update erp_document set revision_group_id=grp, revision_of=x.id, number=x.number, fy=x.fy, series_id=x.series_id,
   revision=case when x.number is null then 0 else x.revision+1 end where id=y.id;
 if x.status='draft' then perform erp_quote_close_draft(x.id, 'Superseded by a newer revision', y.id); end if;
 perform erp_log('document', y.id, 'revision_of', jsonb_build_object('of', x.id, 'group', grp));
end $$;

create function pulse.service_quote_cancel(p_key uuid, p_hash text, p_doc uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d erp_document;
begin
 if service_key_auth(p_key,p_hash,'quotes.draft.create') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 if length(btrim(coalesce(p_reason,''))) not between 1 and 500 then raise exception 'Give a reason of up to 500 characters' using errcode='22023'; end if;
 select * into d from erp_document where org_id=current_org() and id=p_doc and doc_type='quotation' and service_key_id=p_key;
 if d.id is null then raise exception 'Quotation not found' using errcode='P0002'; end if;
 perform pg_advisory_xact_lock(hashtextextended('quote-family:'||coalesce(d.revision_group_id,d.id)::text,0));
 if d.status='cancelled' then raise exception 'This quotation is already cancelled' using errcode='P0409'; end if;
 perform erp_quote_close_draft(d.id, btrim(p_reason), null);
 perform audit_write('service_quote_cancel','erp_document',d.id::text);
 return service_quote_revision_info(p_key, p_hash, d.id);
end $$;

-- A quote-lead (section 4) goes on a draft as leadId: the draft is for that prospect client.
create function pulse.service_quote_lead_client(p_key uuid, p_hash text, p_lead uuid) returns uuid
language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if service_key_auth(p_key,p_hash,'quotes.draft.create') is distinct from true then raise exception 'Service scope required' using errcode='42501'; end if;
 return (select c.id from client c where c.org_id=current_org() and c.id=p_lead and c.source='assistant');
end $$;

revoke all on function pulse.service_quote_revision_info(uuid,text,uuid), pulse.service_quote_revision_link(uuid,text,uuid,uuid),
 pulse.service_quote_cancel(uuid,text,uuid,text), pulse.service_quote_lead_client(uuid,text,uuid) from public;
grant execute on function pulse.service_quote_revision_info(uuid,text,uuid), pulse.service_quote_revision_link(uuid,text,uuid,uuid),
 pulse.service_quote_cancel(uuid,text,uuid,text), pulse.service_quote_lead_client(uuid,text,uuid) to pulse_api;

-- When staff approve a family's next revision, the approved one before it is superseded: its client link stops, its
-- follow-ups stop, and it is cancelled (a declined one stays declined). Both stay readable.
create function pulse.erp_quote_supersede() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare z erp_document;
begin
 for z in select * from erp_document where org_id=new.org_id and doc_type='quotation' and id<>new.id and superseded_by is null
   and coalesce(revision_group_id,id)=new.revision_group_id and status in ('issued','sent','accepted','declined') for update loop
  update erp_accept_link set revoked_at=now() where document_id=z.id and revoked_at is null;
  perform erp_followup_stop(z.id, 'off');
  if z.status='declined' then update erp_document set superseded_by=new.id where id=z.id;
  else update erp_document set superseded_by=new.id, status='cancelled', cancelled_at=now(), cancel_reason='Superseded by revision R'||(new.revision+1) where id=z.id;
  end if;
  perform erp_log('document', z.id, 'superseded', jsonb_build_object('by', new.id, 'revision', new.revision));
 end loop;
 return null;
end $$;
revoke all on function pulse.erp_quote_supersede() from public;
create trigger erp_quote_supersede after update of status on pulse.erp_document for each row
 when (old.status = 'draft' and new.status = 'issued' and new.doc_type = 'quotation' and new.revision_group_id is not null)
 execute function pulse.erp_quote_supersede();

-- 4. ------------------------------------------------------------------------------------------- lead-create
-- A prospect client for a quotation, added by the assistant for the person (API v1 quote-leads). One per phone: a
-- second create for the same number (last ten digits) returns the existing client's id for the caller to check.
create function pulse.v1_quote_lead_create(p jsonb) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); ph text := btrim(coalesce(p->>'phone','')); d10 text; dup uuid; cid uuid; sp uuid;
begin
 if me is null or not exists(select 1 from person where id=me and org_id=current_org() and side in ('staff','agent')) or not erp_can(true) then
  raise exception 'Leads for a quotation are added by the people who make quotations' using errcode='42501'; end if;
 if ph !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Give the phone in international form, with + and the country code' using errcode='22023'; end if;
 sp := nullif(p->>'salespersonId','')::uuid;
 if not exists(select 1 from person where id=sp and org_id=current_org() and side='staff' and status='active') then
  raise exception 'The salesperson must be an active member of staff' using errcode='22023'; end if;
 d10 := right(regexp_replace(ph,'\D','','g'),10);
 perform pg_advisory_xact_lock(hashtextextended('quote-lead:'||current_org()::text||':'||d10,0));
 select c.id into dup from client c where c.org_id=current_org() and right(regexp_replace(coalesce(c.phone,''),'\D','','g'),10)=d10 order by c.created_at, c.id limit 1;
 if dup is not null then return jsonb_build_object('duplicate', dup); end if;
 cid := v1_client_create(jsonb_build_object('name', p->>'name', 'phone', ph, 'city', nullif(btrim(coalesce(p->>'area','')),'')));
 update client set status='prospect', source='assistant', relationship_owner_id=sp,
   notes=nullif(concat_ws(E'\n', 'Address: '||nullif(btrim(coalesce(p->>'address','')),''), 'Requirement: '||nullif(btrim(coalesce(p->>'requirement','')),'')),'')
  where id=cid and org_id=current_org();
 perform audit_write('v1_quote_lead_create','client',cid::text);
 return jsonb_build_object('id', cid);
end $$;
revoke all on function pulse.v1_quote_lead_create(jsonb) from public;
grant execute on function pulse.v1_quote_lead_create(jsonb) to pulse_api;

-- migrate:down
-- Forward only: keys may already hold the new scopes, recorded events keep their types, and revision families and
-- quote-leads are business records.
