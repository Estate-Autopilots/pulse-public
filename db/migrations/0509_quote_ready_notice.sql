-- migrate:up
alter table pulse.erp_document add column ready_notified_at timestamptz;
select pulse.check_values_add('pulse.notification'::regclass,'notification_event_type_check','event_type',array['quote_ready']);
select pulse.check_values_add('pulse.notification'::regclass,'notification_subject_type_check','subject_type',array['erp_document']);
-- Preserve every existing branch, including 0440's comp.% recipients.
do $$
declare definition text; anchor text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 anchor:=$r$ if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active') then return false;end if;$r$;
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
  raise exception 'migration 0509: notification_recipient_allowed changed shape'; end if;
 execute replace(definition,anchor,anchor||$r$
 if p_type='quote_ready' then
  return p_subject='erp_document' and exists(select 1 from erp_document where org_id=current_org() and id=p_id
   and doc_type='quotation' and salesperson_id=p_person);
 end if;$r$);
end $$;

-- Lead names remain encrypted in v1. Only the receipt date is used, never a buyer snapshot or contact identity.
create function pulse.quote_party_label(p_doc uuid) returns text
language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(c.display_name,case when e.id is not null then
  'a lead received '||to_char(e.occurred at time zone org_time_zone(),'FMDD Mon') end,'a client')
 from erp_document d left join client c on c.org_id=d.org_id and c.id=d.client_id
 left join pulse_priv.acq_enquiry e on e.org_id=d.org_id and e.id=d.lead_id
 where d.org_id=current_org() and d.id=p_doc
$$;

create function pulse.service_quote_notify(p_key uuid,p_hash text,p_doc uuid) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d erp_document; title text; notified timestamptz; nid uuid; n int;
begin
 if current_org() is distinct from install_org() or current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text
  or not exists(select 1 from pulse_priv.service_key where org_id=install_org() and id=p_key and key_hash=p_hash
   and revoked_at is null and 'notify.quote_ready'=any(scopes)) then
  raise exception 'Service scope required' using errcode='42501'; end if;
 if exists(select 1 from tenant_config where org_id=install_org() and doc_kind='tenant' and doc_key='modules'
  and is_active and body->'off' ? 'money') then raise exception 'Quotation unavailable' using errcode='P0002'; end if;
 select * into d from erp_document where org_id=install_org() and id=p_doc and doc_type='quotation'
  and status='draft' and service_key_id is not null for update;
 if not found then raise exception 'Quotation unavailable' using errcode='P0002'; end if;
 if d.ready_notified_at is not null then
  return jsonb_build_object('id',d.id,'notifiedAt',d.ready_notified_at,'repeat',true); end if;
 select count(*) into n from erp_line where org_id=install_org() and document_id=d.id;
 title:='Quotation ready for '||quote_party_label(d.id)||': '||n||' item(s), INR '||(d.total::numeric/100)::numeric(24,2)::text
  ||case when d.owner_approval='needed' then ' · owner approval needed' else '' end;
 nid:=notification_emit(d.salesperson_id,'quote_ready','erp_document',d.id,'quote_ready:'||d.id,title,'/quotes/'||d.id,'update',true);
 if nid is null then raise exception 'Active salesperson unavailable' using errcode='P0002'; end if;
 notified:=clock_timestamp();
 update erp_document set ready_notified_at=notified where org_id=install_org() and id=d.id;
 perform audit_write('service_quote_notify','erp_document',d.id::text);
 return jsonb_build_object('id',d.id,'notifiedAt',notified,'repeat',false);
end $$;

create function pulse.salesperson_quote(p_doc uuid) returns jsonb
language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare d erp_document; can_open boolean:=erp_can(false);
begin
 if current_viewer() is null or not exists(select 1 from person where org_id=current_org() and id=current_viewer() and status='active')
  or exists(select 1 from tenant_config where org_id=current_org() and doc_kind='tenant' and doc_key='modules'
   and is_active and body->'off' ? 'money') then return null; end if;
 select * into d from erp_document where org_id=current_org() and id=p_doc and doc_type='quotation'
  and (can_open or (salesperson_id=current_viewer() and exists(select 1 from person where org_id=current_org() and id=current_viewer() and side='staff')));
 if not found then return null; end if;
 return jsonb_build_object('id',d.id,'name',quote_party_label(d.id),'status',d.status,'validUntil',d.valid_until,
  'lines',(select coalesce(jsonb_agg(jsonb_build_object('name',description,'qty',qty,'rate',rate,'gstRate',gst_rate,'total',total)
   order by position),'[]'::jsonb) from erp_line where org_id=current_org() and document_id=d.id),
  'taxable',d.taxable,'tax',d.cgst+d.sgst+d.igst,'total',d.total,
  'ownerApprovalNeeded',coalesce(d.owner_approval='needed',false),'canOpenErp',can_open);
end $$;
revoke all on function pulse.quote_party_label(uuid),pulse.service_quote_notify(uuid,text,uuid),pulse.salesperson_quote(uuid) from public;
grant execute on function pulse.service_quote_notify(uuid,text,uuid),pulse.salesperson_quote(uuid) to pulse_api;
-- migrate:down
-- Forward-only: retain notification receipts.
