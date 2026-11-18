-- migrate:up
-- ACCEPT-SHARED (6 Nov 2026). A company hosted on the shared address (WL-MOVE) hands its client a quotation link on that
-- address, /accept/<token>. The signed-out link ran in the request's organisation (current_org()), which on the shared
-- address is the install's own, so a hosted company's token was never found ("This link is not valid"). Now, as WAS-KEYS
-- (1568) did for service keys, the link is found by its exact token hash and the request runs in the link's own company:
--   * a link of the request's organisation (current_org()), as before, from any address;
--   * on the shared address only (the API sets pulse.erp_accept_reach = '1' just before the call; erp_accept_bind reads
--     and clears it at once), a link of any organisation, found by its exact token hash and nothing else.
-- A company's own address never reaches another company's link, exactly as before. Unknown, revoked and expired links
-- answer exactly as they did; nothing here lists links or tells one company's link from a missing one.

-- The lookup sees one row by its exact hash, only while erp_accept_bind looks it up (the GUC is set and cleared there),
-- and only for the role that owns the definer functions (the migration's own role): pulse_api's reads keep the tenant
-- policy alone, whatever it sets.
create policy erp_accept_find on pulse.erp_accept_link for select to current_user
  using (token_hash = coalesce(current_setting('pulse.erp_accept_find', true), ''));

create function pulse.erp_accept_bind(p_hash text) returns boolean
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare o uuid; reach boolean := coalesce(current_setting('pulse.erp_accept_reach', true), '') = '1';
begin
 perform set_config('pulse.erp_accept_reach', '', true);
 if p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return false; end if;
 perform set_config('pulse.erp_accept_find', p_hash, true);
 select org_id into o from erp_accept_link where token_hash = p_hash;
 perform set_config('pulse.erp_accept_find', '', true);
 if o is null then return false; end if;
 if o is not distinct from current_org() then return true; end if;
 if not reach then return false; end if;
 perform set_config('pulse.org_id', o::text, true);
 return true;
end $$;
revoke all on function pulse.erp_accept_bind(text) from public;

-- The three signed-out functions bind first; the rest is 0190's, reading and writing current_org() only.
create or replace function pulse.erp_accept_open(p_hash text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k erp_accept_link;d erp_document;
begin
 if not erp_accept_bind(p_hash) then return null;end if;
 select * into k from erp_accept_link where token_hash=p_hash and org_id=current_org();
 if k.token_hash is null or k.revoked_at is not null or (k.expires_at<now() and k.decided_at is null) then return null;end if;
 select * into d from erp_document where id=k.document_id;
 if d.status='cancelled' then return jsonb_build_object('closed',true,'number',d.number);end if;
 if k.opened_at is null then
  update erp_accept_link set opened_at=now() where token_hash=p_hash;
  insert into erp_event(org_id,subject_type,subject_id,kind,detail) values(current_org(),'document',d.id,'link_opened','{}');
 end if;
 return jsonb_build_object('docType',d.doc_type,'number',d.number,'issueDate',d.issue_date,'validUntil',d.valid_until,'dueDate',d.due_date,'total',d.total,
  'seller',d.seller->>'legalName','buyer',d.buyer->>'name','decision',k.decision,'decidedAt',k.decided_at,'signer',k.signer_name,'expiresAt',k.expires_at,
  'canDecide',k.decided_at is null and k.expires_at>=now() and d.status in ('issued','sent','part_paid','paid'));
end $$;

create or replace function pulse.erp_accept_file(p_hash text) returns bytea language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not erp_accept_bind(p_hash) then return null;end if;
 return (select f.bytes from erp_accept_link k join erp_document_file f on f.document_id=k.document_id and f.kind='pdf'
  where k.token_hash=p_hash and k.org_id=current_org() and k.revoked_at is null and (k.expires_at>=now() or k.decided_at is not null));
end $$;

create or replace function pulse.erp_accept_decide(p_hash text,p_decision text,p_name text,p_note text,p_ip_hash text,p_agent text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k erp_accept_link;d erp_document;
begin
 perform erp_accept_bind(p_hash);
 select * into k from erp_accept_link where token_hash=p_hash and org_id=current_org() for update;
 if k.token_hash is null or k.revoked_at is not null or k.expires_at<now() then raise exception 'This link has expired; ask for a new one' using errcode='22023';end if;
 if k.decided_at is not null then raise exception 'This document was already answered' using errcode='22023';end if;
 if p_decision not in ('accepted','declined') then raise exception 'Accept or decline' using errcode='22023';end if;
 if length(btrim(coalesce(p_name,''))) not between 2 and 120 then raise exception 'Type your full name to sign' using errcode='22023';end if;
 select * into d from erp_document where id=k.document_id for update;
 if d.status not in ('issued','sent','part_paid','paid') then raise exception 'This document can no longer be answered' using errcode='22023';end if;
 update erp_accept_link set decided_at=now(),decision=p_decision,signer_name=btrim(p_name),signer_note=nullif(btrim(coalesce(p_note,'')),''),
  signer_ip_hash=p_ip_hash,signer_agent=left(p_agent,300) where token_hash=p_hash;
 update erp_document set decision=jsonb_build_object('decision',p_decision,'name',btrim(p_name),'at',now(),'via','link','note',nullif(btrim(coalesce(p_note,'')),'')),
  status=case when doc_type in ('quotation','proforma') then p_decision else status end where id=d.id;
 insert into erp_event(org_id,subject_type,subject_id,kind,detail) values(current_org(),'document',d.id,'client_'||p_decision,jsonb_build_object('name',btrim(p_name)));
 return jsonb_build_object('decision',p_decision,'number',d.number);
end $$;

-- Same grants as 0190 (create or replace keeps them); stated again so the narrow grant is plain to read.
revoke all on function pulse.erp_accept_open(text),pulse.erp_accept_file(text),pulse.erp_accept_decide(text,text,text,text,text,text) from public;
grant execute on function pulse.erp_accept_open(text),pulse.erp_accept_file(text),pulse.erp_accept_decide(text,text,text,text,text,text) to pulse_api;

-- migrate:down
-- Forward-only, like 1568: the earlier definitions read the request's organisation only.
