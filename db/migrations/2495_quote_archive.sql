-- migrate:up
-- WL-FINANCE-CLEAN (Willow Lane's owner, 20 Nov 2026 ~22:20 IST: quotes, sales and finance show only real business, and
-- nothing is deleted; 23:25 IST, on adding this: "Yes, add archive"): a quotation can be ARCHIVED and UNARCHIVED.
--   * Archived = kept in the database exactly as it was (status, number, lines, files, links, log) and left out of every
--     read the app makes: Billing's lists and totals, Sales and the pipeline, Vitals and the company metrics, the
--     follow-ups, the AI employees' tools and the company memory's search. One restrictive row-security policy on
--     erp_document does this for every role: pulse_api, pulse_worker, and the owner that runs the definer functions
--     (erp_document has FORCE ROW LEVEL SECURITY), so a list or a total cannot forget it. Only the three functions below
--     see archived rows: they set pulse.erp_archived = 'show' while they run and put the earlier value back (an error
--     rolls the setting back with the transaction or savepoint). A drafted, issued, sent or accepted quotation can be
--     archived; one that became an invoice (converted, or a document made from it) cannot, and neither can an invoice,
--     proforma or credit note (tax documents are cancelled or credited, as before).
--   * "Superseded by" across quotations: archiving with p_superseded_by names the live quotation that replaces it (the
--     option the customer took, the real one of two copies). A revision's own superseded_by (1842) is kept as it is.
--   * Undoable: what archiving changed is kept on the row (archive_undo) and put back by unarchive: the client links it
--     stopped (an archived quotation is not shown to the customer either), the follow-up it stopped (it is scheduled
--     again; the follow-up tick makes its task again when due) and the superseded-by link it set.
--   * Who: Billing's writers who see every deal (erp_require(true): leadership, admins with the money grants and the
--     Finance role). A sales-only seat (erp_own_only) and an AI employee are refused. A note (3+ characters) says why.
--     Every archive and unarchive is in the ERP log (with the number and the note) and in Audit (audit_mutation).
-- Synthetic data only in tests (tests/core/test_quote_archive.py); this migration changes no row.

alter table pulse.erp_document
 add column archived_at timestamptz,
 add column archived_by uuid references pulse.person(id),
 add column archive_note text check (length(archive_note) <= 500),
 add column archive_undo jsonb check (archive_undo is null or jsonb_typeof(archive_undo) = 'object'),
 add constraint erp_document_archive_quotation check (archived_at is null or doc_type = 'quotation'),
 add constraint erp_document_archive_whole check ((archived_at is null) = (archive_note is null));
comment on column pulse.erp_document.archived_at is 'WL-FINANCE-CLEAN (20 Nov 2026): set = archived: kept, hidden from every read (policy erp_archived); pulse.erp_document_unarchive puts it back';
create index erp_document_archived on pulse.erp_document(org_id, archived_at desc) where archived_at is not null;

-- Every role, every command: an archived row is not there, unless the reader is one of the archive functions below.
create policy erp_archived on pulse.erp_document as restrictive for all
 using (archived_at is null or current_setting('pulse.erp_archived', true) = 'show')
 with check (archived_at is null or current_setting('pulse.erp_archived', true) = 'show');

-- A follow-up stopped because its quotation was archived (unarchive schedules it again).
alter table pulse.erp_followup drop constraint erp_followup_stopped_reason_check,
 add constraint erp_followup_stopped_reason_check check (stopped_reason in ('accepted','declined','converted','cancelled','off','archived'));

-- Who archives: a person who writes Billing and sees every deal.
create function pulse.erp_archiver() returns uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid := erp_require(true);
begin
 if erp_own_only() then raise exception 'Archiving is for leadership, admins and the Finance role' using errcode='42501'; end if;
 if exists(select 1 from person where id=me and side='agent') then raise exception 'A person archives a quotation, not an AI employee' using errcode='42501'; end if;
 return me;
end $$;

create function pulse.erp_document_archive(p_doc uuid, p_note text, p_superseded_by uuid default null) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := erp_archiver(); d erp_document; b erp_document; note text := left(btrim(coalesce(p_note,'')),500);
 links text[]; f erp_followup; undo jsonb; shown text := current_setting('pulse.erp_archived', true);
begin
 perform set_config('pulse.erp_archived','show',true);
 select * into d from erp_document where org_id=current_org() and id=p_doc for update;
 if d.id is null then raise exception 'Quotation not found' using errcode='P0002'; end if;
 if d.doc_type<>'quotation' then raise exception 'Only a quotation is archived: cancel the document or issue a credit note' using errcode='22023'; end if;
 if d.archived_at is not null then raise exception 'This quotation is already archived' using errcode='22023'; end if;
 if d.status='converted' or exists(select 1 from erp_document x where x.org_id=d.org_id and x.source_id=d.id and x.doc_type<>'quotation') then
  raise exception 'This quotation became an invoice, so it stays' using errcode='22023'; end if;
 if length(note)<3 then raise exception 'Say why it is archived' using errcode='22023'; end if;
 if p_superseded_by is not null then
  select * into b from erp_document where org_id=current_org() and id=p_superseded_by;
  if b.id is null or b.doc_type<>'quotation' or b.archived_at is not null or b.status='cancelled' then
   raise exception 'Choose the live quotation that replaces it' using errcode='22023'; end if;
  if b.id=d.id then raise exception 'A quotation cannot replace itself' using errcode='22023'; end if;
  if d.superseded_by is not null and d.superseded_by<>b.id then raise exception 'Another version already replaces this quotation' using errcode='22023'; end if;
 end if;
 -- Its client links stop: the customer's page says the link is no longer valid.
 with r as (update erp_accept_link set revoked_at=now() where org_id=d.org_id and document_id=d.id and revoked_at is null returning token_hash)
 select coalesce(array_agg(token_hash order by token_hash),'{}') into links from r;
 -- Its follow-up stops (and the open follow-up task is cancelled).
 select * into f from erp_followup where document_id=d.id and state in ('scheduled','answered');
 if f.document_id is not null then perform erp_followup_stop(d.id,'archived'); end if;
 undo := jsonb_build_object('links', to_jsonb(links),
  'followup', case when f.document_id is not null then jsonb_build_object('state',f.state,'nextDueAt',f.next_due_at) end,
  'supersededBySet', p_superseded_by is not null and d.superseded_by is null);
 update erp_document set archived_at=now(), archived_by=me, archive_note=note, archive_undo=undo,
  superseded_by=coalesce(superseded_by,p_superseded_by), updated_by=me where id=d.id;
 perform erp_log('document', d.id, 'archived', jsonb_strip_nulls(jsonb_build_object('number',d.number,'status',d.status,'note',note,
  'supersededBy',b.id,'supersededByNumber',b.number,'linksStopped',cardinality(links),'followupStopped',f.document_id is not null)));
 perform set_config('pulse.erp_archived',coalesce(shown,''),true);
 return jsonb_strip_nulls(jsonb_build_object('id',d.id,'number',d.number,'status',d.status,'archivedAt',now(),'supersededBy',b.id,
  'supersededByNumber',b.number,'linksStopped',cardinality(links),'followupStopped',f.document_id is not null));
end $$;

create function pulse.erp_document_unarchive(p_doc uuid, p_note text default null) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := erp_archiver(); d erp_document; u jsonb; fu jsonb; n int := 0; back boolean := false; note text := nullif(left(btrim(coalesce(p_note,'')),500),'');
 shown text := current_setting('pulse.erp_archived', true);
begin
 perform set_config('pulse.erp_archived','show',true);
 select * into d from erp_document where org_id=current_org() and id=p_doc for update;
 if d.id is null then raise exception 'Quotation not found' using errcode='P0002'; end if;
 if d.archived_at is null then raise exception 'This quotation is not archived' using errcode='22023'; end if;
 u := coalesce(d.archive_undo,'{}');
 -- The client links archiving stopped work again (an expired one stays expired).
 update erp_accept_link set revoked_at=null where org_id=d.org_id and document_id=d.id and revoked_at is not null
  and token_hash in (select jsonb_array_elements_text(coalesce(u->'links','[]')));
 get diagnostics n=row_count;
 -- The follow-up archiving stopped is scheduled again (a missed time is now: the tick tells it once and moves on).
 fu := u->'followup';
 if jsonb_typeof(fu)='object' then
  update erp_followup set state=fu->>'state', stopped_reason=null,
   next_due_at=case when fu->>'state'='scheduled' then greatest((fu->>'nextDueAt')::timestamptz, now()) end, updated_at=now()
   where document_id=d.id and state='stopped' and stopped_reason='archived';
  back := found;
  if back then perform erp_log('document', d.id, 'followup_resumed', jsonb_build_object('state', fu->>'state')); end if;
 end if;
 update erp_document set archived_at=null, archived_by=null, archive_note=null, archive_undo=null,
  superseded_by=case when coalesce((u->>'supersededBySet')::boolean,false) then null else superseded_by end, updated_by=me where id=d.id;
 perform erp_log('document', d.id, 'unarchived', jsonb_strip_nulls(jsonb_build_object('number',d.number,'note',note,'archivedAt',d.archived_at,
  'archiveNote',d.archive_note,'linksBack',n,'followupBack',back)));
 perform set_config('pulse.erp_archived',coalesce(shown,''),true);
 return jsonb_build_object('id',d.id,'number',d.number,'status',d.status,'linksBack',n,'followupBack',back);
end $$;

-- Billing → Archived: what was archived, when, by whom, why, and what replaced it (newest first).
create function pulse.erp_archived_list(p_limit int default 200) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare shown text := current_setting('pulse.erp_archived', true); r jsonb;
begin
 perform erp_archiver();
 perform set_config('pulse.erp_archived','show',true);
 r := coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'docType',d.doc_type,'number',d.number,'status',d.status,'buyer',d.buyer->>'name',
   'clientId',d.client_id,'total',d.total,'issueDate',d.issue_date,'createdAt',d.created_at,'archivedAt',d.archived_at,'archivedBy',p.display_name,
   'note',d.archive_note,'supersededBy',d.superseded_by,'supersededByNumber',s.number) order by d.archived_at desc, d.id)
  from (select * from erp_document where org_id=current_org() and archived_at is not null order by archived_at desc, id
        limit least(greatest(coalesce(p_limit,200),1),1000)) d
  left join person p on p.id=d.archived_by left join erp_document s on s.id=d.superseded_by and s.org_id=d.org_id), '[]'::jsonb);
 perform set_config('pulse.erp_archived',coalesce(shown,''),true);
 return r;
end $$;

revoke all on function pulse.erp_archiver(), pulse.erp_document_archive(uuid,text,uuid), pulse.erp_document_unarchive(uuid,text),
 pulse.erp_archived_list(int) from public;
grant execute on function pulse.erp_document_archive(uuid,text,uuid), pulse.erp_document_unarchive(uuid,text), pulse.erp_archived_list(int) to pulse_api;

-- migrate:down
-- Forward-only: an archived quotation keeps its archive record. To show archived rows again by hand: drop policy
-- erp_archived on pulse.erp_document (the columns and the functions can stay).
