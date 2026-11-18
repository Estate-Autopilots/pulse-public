-- migrate:up
-- WL-PRICE-TOOL (owner, 18 Nov 2026, Willow Lane: Sakobe keeps prices and stock and wants to do it "by sheet or by
-- telling an agent"). The sheet has been there since 1896 (Billing → Catalogue → Import a price list: preview, stock
-- column, undo). Telling an AI employee did not work: since the review of 5 Nov (1562) the database refuses, in every
-- AI employee's session, any change to a catalogue item or its price and every stock move ("payments, stock, prices,
-- archiving and Billing settings are a person's"), and bhrātā told people it could set stock counts when it could not.
--
-- That rule stays the default. Now an organisation admin can make one AI employee the company's catalogue keeper
-- (agent_catalogue_keeper_set; never the AI itself, never through its key), kept on its member row like the Finance
-- role (2275). Only in that AI's own session (its key, or a job it asked for), and only with the Billing tool on:
--   * a catalogue item's price, GST rate, HSN/SAC, unit and name can be changed (API v1 update_catalog_item, which
--     needs confirm true and answers with the values before); its kind, cost, status and stock switch cannot, so it
--     never archives an item or switches stock tracking;
--   * stock comes in and the count is set (record_stock_in, set_stock_count; undo_change for 7 days as before).
-- Everything else 1562 refuses is still refused: payments, issued documents, settings, series, templates, packages.
-- Every change is in Billing's own log (erp_event) and the item's versions, with the AI employee as the actor; each
-- grant and removal is in the record history and the audit trail.

alter table pulse.agent_member add column catalogue_keeper_at timestamptz, add column catalogue_keeper_by uuid references pulse.person(id);
comment on column pulse.agent_member.catalogue_keeper_at is 'WL-PRICE-TOOL: since when this AI employee keeps the catalogue (changes prices, records stock); null: it does not. Set by an organisation admin with agent_catalogue_keeper_set';

-- The current session is an AI employee (its own key or a job it asked for) that keeps the catalogue here.
create function pulse.agent_catalogue_keeper() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists(select 1 from agent_member m where m.org_id = current_org() and m.person_id = agent_session() and m.disabled_at is null
    and m.catalogue_keeper_at is not null and 'billing' = any(m.tools))
$$;

-- An organisation admin makes an AI employee the catalogue keeper (p_on true) or ends it, with a note for the history.
create function pulse.agent_catalogue_keeper_set(p_agent uuid, p_on boolean, p_note text default null) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m agent_member%rowtype; note text := nullif(left(btrim(coalesce(p_note, '')), 400), '');
begin
  if agent_session() is not null or current_viewer() is null or not viewer_is('admin') then
    raise exception 'Only an organisation admin lets an AI employee keep the catalogue' using errcode = '42501';
  end if;
  select * into m from agent_member where org_id = current_org() and person_id = p_agent for update;
  if not found then raise exception 'Choose an AI employee' using errcode = '22023'; end if;
  if p_on and m.disabled_at is not null then raise exception 'This AI employee is switched off; switch it on first' using errcode = '22023'; end if;
  if p_on and not ('billing' = any(m.tools)) then raise exception 'Switch on the Billing tool for this AI employee first' using errcode = '22023'; end if;
  if p_on is distinct from (m.catalogue_keeper_at is not null) then
    update agent_member set catalogue_keeper_at = case when p_on then clock_timestamp() end, catalogue_keeper_by = case when p_on then current_viewer() end
     where org_id = current_org() and person_id = p_agent;
    insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
    values (current_org(), 'role', p_agent, 'catalogue_keeper', case when p_on then null else 'held' end,
            case when p_on then coalesce('granted: ' || note, 'granted') else coalesce('ended: ' || note, null) end, current_viewer());
    perform audit_write(case when p_on then 'grant' else 'revoke' end, 'agent.catalogue_keeper', p_agent::text);
  end if;
  return (select jsonb_build_object('agentId', person_id, 'catalogueKeeper', catalogue_keeper_at is not null, 'since', catalogue_keeper_at, 'by', catalogue_keeper_by)
            from agent_member where org_id = current_org() and person_id = p_agent);
end $$;

-- 1562's guard, with the keeper's three writes let through. The rest is unchanged, word for word.
create or replace function pulse.erp_agent_draft_only() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j jsonb; o jsonb;
begin
 if agent_session() is null then return coalesce(new, old); end if;
 j := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if tg_table_name = 'erp_document' then
  if tg_op = 'INSERT' and new.status = 'draft' then return new; end if;
  if tg_op <> 'INSERT' and old.status = 'draft' then return coalesce(new, old); end if;
  -- Dispatching an approved quotation (erp_document_mark 'sent'): only the status moves, never its figures or buyer.
  if tg_op = 'UPDATE' and old.doc_type = 'quotation' and old.status = 'issued' and new.status = 'sent'
     and (new.number, new.total, new.client_id, new.doc_type, new.issue_date) is not distinct from (old.number, old.total, old.client_id, old.doc_type, old.issue_date)
   then return new; end if;
  raise exception 'An AI member drafts quotations and invoices; a person changes them once they are approved or issued' using errcode = '42501';
 end if;
 if tg_table_name = 'erp_line' then
  if exists(select 1 from erp_document d where d.id = (j->>'document_id')::uuid and d.status <> 'draft')
     or (tg_op = 'UPDATE' and exists(select 1 from erp_document d where d.id = (to_jsonb(old)->>'document_id')::uuid and d.status <> 'draft')) then
   raise exception 'An AI member drafts quotations and invoices; a person changes them once they are approved or issued' using errcode = '42501';
  end if;
  return coalesce(new, old);
 end if;
 if tg_table_name = 'erp_accept_link' and tg_op = 'INSERT' then return new; end if;
 if tg_table_name = 'erp_item' and tg_op = 'INSERT' then return new; end if;
 if tg_table_name = 'erp_item_version' and tg_op = 'INSERT' and not exists(select 1 from erp_item_version v where v.item_id = (j->>'item_id')::uuid) then return new; end if;
 if tg_table_name in ('erp_item_addon', 'erp_package_part') and tg_op = 'INSERT'
    and not exists(select 1 from erp_item_version v where v.item_id = coalesce(j->>'package_id', j->>'item_id')::uuid and v.version > 1) then return new; end if;
 -- WL-PRICE-TOOL: the catalogue keeper changes an item's price, GST rate, HSN/SAC, unit and name (and the version
 -- and edit stamps the save itself moves), and records stock. Any other column of the item stays a person's.
 if agent_catalogue_keeper() then
  if tg_table_name = 'erp_item' and tg_op = 'UPDATE' then
   o := to_jsonb(old) - array['price','gst_rate','sac','unit','name','version','updated_at','updated_by'];
   if o = j - array['price','gst_rate','sac','unit','name','version','updated_at','updated_by'] and old.status = 'active' then return new; end if;
   raise exception 'The catalogue keeper changes an active item''s price, GST rate, HSN/SAC, unit and name; anything else about an item is a person''s' using errcode = '42501';
  end if;
  if tg_table_name = 'erp_item_version' and tg_op = 'INSERT' then return new; end if;
  if tg_table_name = 'erp_stock_move' and tg_op = 'INSERT' then return new; end if;
 end if;
 raise exception 'An AI member drafts quotations and adds catalogue items when asked: payments, stock, prices, archiving and Billing settings are a person''s' using errcode = '42501';
end $$;

revoke all on function pulse.agent_catalogue_keeper(), pulse.agent_catalogue_keeper_set(uuid, boolean, text) from public;
grant execute on function pulse.agent_catalogue_keeper() to pulse_api, pulse_worker;
grant execute on function pulse.agent_catalogue_keeper_set(uuid, boolean, text) to pulse_api;

-- migrate:down
-- Forward-only.
