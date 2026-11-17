-- migrate:up
-- KAZUK-FLOW G1 + G2 + G4 (Kazuk, 6 Nov 2026: "Vitals OS — Sales Flow: Quotation to Invoice to Project"; the salesperson
-- runs the whole deal in Billing, decides the price, and no approval happens anywhere unless the company asks for it).
--  G1  A sales seat in Billing. Two new roles: `sales` (a salesperson) and `sales_head` (sees the whole team's deals).
--      Both read and write Billing (erp_can). A sales-only person (erp_own_only: sales, and no finance, sales_head,
--      leadership, admin or money grants) sees and changes only their own deals: documents they created or are the
--      salesperson of, and those documents' lines, payments, versions, files, links and log. They add catalogue items
--      and change only the ones they added; settings, templates, numbering, stock, client packages and milestones stay
--      with leadership and Finance. A salesperson never starts a blank tax invoice, proforma or credit note: an invoice
--      is made from their quotation (T15). The restrictive policies hold for the API's own queries; guard triggers hold
--      the same line inside Billing's definer functions (issue, mark, revise, payments, links).
--      A document made by a salesperson names them its salesperson, and one made from a quotation keeps its salesperson.
--  G2  Approval is a company setting: erp_settings.quote_approval (1561), off by default. Off ("no approval anywhere",
--      EA): the API answers approvalMode 'none' and Billing's screens have no approve step. On: Willow Lane's 1561 gates,
--      unchanged. (0506's owner approval of a service key's changed price is left as it is: a salesperson's own
--      quotation never carries a service key.)
--  G4  "Start clean": leadership or an admin archives every catalogue item drafted for them (status draft, not added by
--      hand), keeping their history, logged. Who sees cost and margin is a setting (erp_settings.cost_visibility: owner,
--      finance or everyone), enforced by the API (erp_sees_cost).
-- Synthetic data only in tests; nothing here reads or writes production data.

-- ------------------------------------------------------------------------------------------------- G1 the roles
drop policy if exists role_grant on pulse.role_assignment;
create policy role_grant on pulse.role_assignment as restrictive for insert to pulse_api
 with check(pulse.viewer_is('admin') and role_key in('admin','hr','leadership','finance','manager','pgs','head_pgs','sales','sales_head'));
drop policy if exists role_end on pulse.role_assignment;
create policy role_end on pulse.role_assignment as restrictive for update to pulse_api
 using(pulse.viewer_is('admin') and role_key in('admin','hr','leadership','finance','manager','pgs','head_pgs','sales','sales_head')) with check(pulse.viewer_is('admin'));

-- 1562's erp_can, plus the two sales roles (read and write).
create or replace function pulse.erp_can(p_write boolean default false) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('finance','sales','sales_head')
  or (money_can('money.read') and money_can('money.amount.read') and (not p_write or money_can('money.plan.write')))
  or (not p_write and is_accountant(current_viewer()) and erp_accountant_reads())
  or exists(select 1 from agent_member m where m.org_id = current_org() and m.person_id = agent_session() and m.disabled_at is null and 'billing' = any(m.tools)))
$$;

-- A salesperson who sees only their own deals.
create function pulse.erp_own_only() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and viewer_is('sales') and not viewer_is('finance','sales_head','leadership','admin')
  and not (money_can('money.read') and money_can('money.amount.read'))
$$;
-- Who sees cost and margin is the company's own setting (Billing → Settings, leadership or an admin changes it at any
-- time): 'owner' (leadership and admins), 'finance' (and the Finance role) or 'everyone' who reads Billing (the default:
-- every company keeps what it has today). The API leaves cost and margin out of every answer for the others.
alter table pulse.erp_settings add column cost_visibility text not null default 'everyone' check (cost_visibility in ('owner', 'finance', 'everyone'));
comment on column pulse.erp_settings.cost_visibility is 'KAZUK-FLOW (7 Nov 2026): who sees catalogue cost and margin: owner (leadership, admins), finance (and the Finance role) or everyone who reads Billing';
create function pulse.erp_sees_cost() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select erp_can(false) and case coalesce((select s.cost_visibility from erp_settings s where s.org_id = current_org()), 'everyone')
  when 'owner' then viewer_is('leadership','admin') when 'finance' then viewer_is('leadership','admin','finance') else true end
$$;
create function pulse.erp_cost_setting_guard() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if pulse.current_viewer() is not null and not pulse.viewer_is('leadership', 'admin')
    and new.cost_visibility is distinct from (case when tg_op = 'INSERT' then 'everyone' else old.cost_visibility end) then
  raise exception 'Only leadership or an admin changes who sees cost and margin' using errcode = '42501';
 end if;
 return new;
end $$;
revoke all on function pulse.erp_cost_setting_guard() from public;
create trigger erp_cost_setting_guard before insert or update of cost_visibility on pulse.erp_settings for each row execute function pulse.erp_cost_setting_guard();
-- One of this salesperson's documents (read past RLS, for the guards and policies below).
create function pulse.erp_doc_mine(p_doc uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from erp_document d where d.org_id=current_org() and d.id=p_doc and current_viewer() in (d.created_by, d.salesperson_id))
$$;
revoke all on function pulse.erp_own_only(), pulse.erp_sees_cost(), pulse.erp_doc_mine(uuid) from public;
grant execute on function pulse.erp_own_only(), pulse.erp_sees_cost(), pulse.erp_doc_mine(uuid) to pulse_api, pulse_worker;

-- Their documents, and what hangs off them.
create policy erp_own on pulse.erp_document as restrictive for all to pulse_api
 using(not (select pulse.erp_own_only()) or pulse.current_viewer() in (created_by, salesperson_id))
 with check(not (select pulse.erp_own_only()) or pulse.current_viewer() in (created_by, salesperson_id));
do $$ declare t text; begin
 foreach t in array array['erp_line','erp_payment','erp_document_file','erp_accept_link','erp_document_revision'] loop
  execute format('create policy erp_own on pulse.%I as restrictive for all to pulse_api using(not (select pulse.erp_own_only()) or pulse.erp_doc_mine(document_id))'
   ' with check(not (select pulse.erp_own_only()) or pulse.erp_doc_mine(document_id))', t);
 end loop;
 -- The log: their documents' lines and the catalogue's.
 execute 'create policy erp_own on pulse.erp_event as restrictive for select to pulse_api using(not (select pulse.erp_own_only()) or subject_type = ''item'' or pulse.erp_doc_mine(subject_id))';
 -- Leadership's and Finance's part of Billing: read, never written by a salesperson.
 foreach t in array array['erp_settings','erp_template','erp_template_default','erp_series','erp_asset','erp_engagement','erp_milestone','erp_stock_move','erp_stock_serial'] loop
  continue when to_regclass('pulse.' || t) is null;
  execute format('create policy erp_own_insert on pulse.%I as restrictive for insert to pulse_api with check(not (select pulse.erp_own_only()))', t);
  execute format('create policy erp_own_update on pulse.%I as restrictive for update to pulse_api using(not (select pulse.erp_own_only()))', t);
  execute format('create policy erp_own_delete on pulse.%I as restrictive for delete to pulse_api using(not (select pulse.erp_own_only()))', t);
 end loop;
end $$;
-- The catalogue: a salesperson adds items (G4) and changes only the ones they added (and their parts and add-ons).
create policy erp_own_update on pulse.erp_item as restrictive for update to pulse_api using(not (select pulse.erp_own_only()) or created_by = pulse.current_viewer());
create policy erp_own_delete on pulse.erp_item as restrictive for delete to pulse_api using(not (select pulse.erp_own_only()) or created_by = pulse.current_viewer());
create function pulse.erp_item_mine(p_item uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from erp_item i where i.org_id=current_org() and i.id=p_item and i.created_by=current_viewer())
$$;
revoke all on function pulse.erp_item_mine(uuid) from public;
grant execute on function pulse.erp_item_mine(uuid) to pulse_api;
create policy erp_own on pulse.erp_package_part as restrictive for all to pulse_api
 using(true) with check(not (select pulse.erp_own_only()) or pulse.erp_item_mine(package_id));
create policy erp_own_delete on pulse.erp_package_part as restrictive for delete to pulse_api using(not (select pulse.erp_own_only()) or pulse.erp_item_mine(package_id));
do $$ begin
 if to_regclass('pulse.erp_item_addon') is not null then
  execute 'create policy erp_own on pulse.erp_item_addon as restrictive for all to pulse_api using(true) with check(not (select pulse.erp_own_only()) or pulse.erp_item_mine(item_id))';
  execute 'create policy erp_own_delete on pulse.erp_item_addon as restrictive for delete to pulse_api using(not (select pulse.erp_own_only()) or pulse.erp_item_mine(item_id))';
 end if;
end $$;

-- Inside Billing's definer functions (issue, mark sent or accepted, revise, approval, payments, links, files) the
-- policies above do not apply, so the same line is held here: a sales-only person changes only their own documents.
create function pulse.erp_own_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare doc uuid;
begin
 if not pulse.erp_own_only() then return coalesce(new, old); end if;
 if tg_table_name = 'erp_document' then
  if tg_op = 'INSERT' then return new; end if;
  doc := old.id;
 else
  doc := (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end ->> 'document_id')::uuid;
 end if;
 if not pulse.erp_doc_mine(doc) then
  raise exception 'This deal is another salesperson''s' using errcode = '42501';
 end if;
 return coalesce(new, old);
end $$;
revoke all on function pulse.erp_own_guard() from public;
create trigger erp_own_guard before update or delete on pulse.erp_document for each row execute function pulse.erp_own_guard();
create trigger erp_own_guard before insert or update or delete on pulse.erp_payment for each row execute function pulse.erp_own_guard();
create trigger erp_own_guard before insert or update or delete on pulse.erp_accept_link for each row execute function pulse.erp_own_guard();
create trigger erp_own_guard before insert or update or delete on pulse.erp_document_file for each row execute function pulse.erp_own_guard();
create trigger erp_own_guard before insert or update or delete on pulse.erp_document_revision for each row execute function pulse.erp_own_guard();

-- A new document: a salesperson's own is named theirs; one made from a quotation keeps its salesperson. A sales-only
-- person never starts a tax invoice, proforma or credit note from nothing (Kazuk: "no blank-invoice path for sales").
create function pulse.erp_sales_seat_insert() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.source_id is not null and new.salesperson_id is null then
  new.salesperson_id := (select d.salesperson_id from erp_document d where d.id = new.source_id);
 end if;
 if new.salesperson_id is null and new.service_key_id is null and pulse.current_viewer() is not null and pulse.viewer_is('sales','sales_head')
    and new.created_by is not distinct from pulse.current_viewer() then
  new.salesperson_id := pulse.current_viewer();
 end if;
 if new.doc_type <> 'quotation' and new.source_id is null and pulse.erp_own_only() then
  raise exception 'A salesperson makes the invoice from their accepted quotation: open the quotation and choose Create invoice' using errcode = '42501';
 end if;
 return new;
end $$;
revoke all on function pulse.erp_sales_seat_insert() from public;
create trigger erp_sales_seat_insert before insert on pulse.erp_document for each row execute function pulse.erp_sales_seat_insert();

-- -------------------------------------------------------------------------------------------- G2 approval off
comment on column pulse.erp_settings.quote_approval is 'BILLING-WL (4 Nov 2026): quotations are approved only by leadership, an admin or the person they were sent to for approval. KAZUK-FLOW (7 Nov 2026): off is the API''s approvalMode none (no approval step anywhere in Billing''s screens); on is approvalMode approver';

-- ------------------------------------------------------------------------------------------ G4 a clean catalogue
-- Archives every item drafted for the company (status draft and not added by hand: the cost sheet's and past invoices'
-- drafts), keeping each one and its history; returns how many. Leadership or an admin with Billing.
create function pulse.erp_catalog_start_clean() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 perform erp_require(true);
 if not viewer_is('leadership','admin') then raise exception 'Leadership or an admin starts the catalogue clean' using errcode = '42501'; end if;
 with x as (update erp_item set status = 'archived', updated_by = current_viewer(), updated_at = now()
   where org_id = current_org() and status = 'draft' and coalesce(source->>'type', '') <> 'manual' returning id)
 select count(*) into n from x;
 perform erp_log('item', null, 'start_clean', jsonb_build_object('archived', n));
 return n;
end $$;
revoke all on function pulse.erp_catalog_start_clean() from public;
grant execute on function pulse.erp_catalog_start_clean() to pulse_api;

-- migrate:down
-- Forward-only: the roles and their deals stay readable by the earlier erp_can's holders.
