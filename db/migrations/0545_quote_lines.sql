-- migrate:up
-- QUOTE-LINES (18 Oct 2026, EST-1236, Willow Lane pilot): a quotation finished in the meeting. Three facts per document
-- line and one list per catalogue item; the arithmetic, the renderer and the issue function stay as they are.
--
-- 1. erp_line.parent_position: the line is an add-on of the line at that position in the same document (one level; the
--    API refuses an add-on of an add-on). Positions, not ids, because a draft save replaces all its lines; the deferred
--    foreign key checks the pair at commit and removing a main line removes its add-ons.
-- 2. erp_line.open: an amount priced per site (installation, transport). Issuing refuses while one is still at zero and
--    not marked not needed (services/api/src/erp-model.ts unfilledOpen).
-- 3. erp_line.not_needed: kept on the draft so the editor shows it again, left out of the figures and the preview, and
--    removed when the document is issued, so issued documents, exports, stock moves and conversions never carry it.
-- 4. erp_item_addon: an item's usual add-ons, offered when it is on a document. The tenant and ERP policies, grants and
--    audit of the other erp_ tables (0190); both items belong to the row's company, by foreign keys on (id, org_id),
--    since RLS only checks the row's own org_id.

alter table pulse.erp_line
 add column parent_position int check(parent_position>=0),
 add column open boolean not null default false,
 add column not_needed boolean not null default false,
 add constraint erp_line_parent_not_self check(parent_position is distinct from position);
alter table pulse.erp_line add constraint erp_line_parent foreign key(document_id,parent_position)
 references pulse.erp_line(document_id,position) on delete cascade deferrable initially deferred;

alter table pulse.erp_item add constraint erp_item_id_org unique(id,org_id);
create table pulse.erp_item_addon (
 org_id uuid not null references pulse.org(id),
 item_id uuid not null,
 addon_id uuid not null,
 position int not null check(position between 0 and 19),
 primary key(item_id,addon_id), unique(item_id,position), check(addon_id<>item_id),
 foreign key(item_id,org_id) references pulse.erp_item(id,org_id) on delete cascade,
 foreign key(addon_id,org_id) references pulse.erp_item(id,org_id) on delete cascade
);
alter table pulse.erp_item_addon enable row level security;
alter table pulse.erp_item_addon force row level security;
create policy tenant on pulse.erp_item_addon using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy erp_read on pulse.erp_item_addon as restrictive for select to pulse_api using((select pulse.erp_can(false)));
create policy erp_insert on pulse.erp_item_addon as restrictive for insert to pulse_api with check((select pulse.erp_can(true)));
create policy erp_update on pulse.erp_item_addon as restrictive for update to pulse_api using((select pulse.erp_can(true))) with check((select pulse.erp_can(true)));
create policy erp_delete on pulse.erp_item_addon as restrictive for delete to pulse_api using((select pulse.erp_can(true)));
create trigger audit_mutation after insert or update or delete on pulse.erp_item_addon for each row execute function pulse.audit_mutation();
grant select,insert,update,delete on pulse.erp_item_addon to pulse_api;
