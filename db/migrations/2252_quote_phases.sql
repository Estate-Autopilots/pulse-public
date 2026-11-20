-- migrate:up
-- QUOTE-STRUCT (Kazuk, 16 Nov 2026: "VitalsOS Quotations: Phase-wise Package Editing: Build Guide", task "Quotations
-- building issues"): a package added to a quotation opens into its parts, grouped under the company's phases, and every
-- part is edited for that quotation only (keep or remove, quantity, price, swap, add an item to a phase). The PDF prints
-- the lines under their phase headings with one total, "Included" for free lines, "To be quoted" for a line with no
-- price, and bonuses with their value struck through. Nothing here is one company's: each business sets its own phases
-- (a business with none keeps one flat list, as before).
--  1. erp_settings.phases: the company's phases, in order: [{key, name, groups: [sub-group names]}].
--  2. erp_item.phase / phase_group: the phase (its key) and optional sub-group a catalogue item sits in; erp_item.included:
--     a free item that prints "Included" (never an amount left to fill in).
--  3. erp_line: the phase heading a line prints under (name, order, sub-group, kept on the line so an issued copy and the
--     invoices made from it print the same); its role (included, to_quote, bonus); the package it came from (id and the
--     heading it prints, "Growth Package · …"), the package's default for that part ({qty, rate, itemId}: what the
--     "changed" markers compare with; null for an item added on the quotation), and a bonus's value (struck through).
--     A part line is an ordinary line, so a paid invoice still turns what was sold into the project's tasks line by line.
--  4. erp_sees_cost(): a salesperson or sales head (without leadership, admin or Finance) never sees cost or margin, whatever the company's setting: the guide's
--     "build this as a role permission, not a setting someone can switch off".
-- Synthetic data only in tests; nothing here reads or writes a company's data.

alter table pulse.erp_settings add column phases jsonb not null default '[]'
  check (jsonb_typeof(phases) = 'array' and jsonb_array_length(phases) <= 20 and pg_column_size(phases) < 16384);
comment on column pulse.erp_settings.phases is 'QUOTE-STRUCT (2252): the company''s phases in order, [{key, name, groups}]; quotation lines and the PDF group by them';

alter table pulse.erp_item add column phase text check (phase is null or phase ~ '^[a-z][a-z0-9-]{0,39}$');
alter table pulse.erp_item add column phase_group text check (phase_group is null or (length(btrim(phase_group)) between 1 and 60 and phase_group !~ '[[:cntrl:]]'));
alter table pulse.erp_item add column included boolean not null default false;
comment on column pulse.erp_item.phase is 'QUOTE-STRUCT (2252): the key of the company phase (erp_settings.phases) this item is quoted under';
comment on column pulse.erp_item.included is 'QUOTE-STRUCT (2252): a free item: its line prints Included, and is never an amount to fill in';

alter table pulse.erp_line add column phase text check (phase is null or (length(btrim(phase)) between 1 and 120 and phase !~ '[[:cntrl:]]'));
alter table pulse.erp_line add column phase_group text check (phase_group is null or (length(btrim(phase_group)) between 1 and 60 and phase_group !~ '[[:cntrl:]]'));
alter table pulse.erp_line add column phase_order smallint check (phase_order is null or phase_order between 0 and 99);
alter table pulse.erp_line add column line_role text check (line_role is null or line_role in ('included', 'to_quote', 'bonus'));
alter table pulse.erp_line add column package_id uuid;
alter table pulse.erp_line add constraint erp_line_package_fk foreign key (package_id, org_id) references pulse.erp_item(id, org_id) on delete set null (package_id);
create index erp_line_package on pulse.erp_line (org_id, package_id) where package_id is not null;
alter table pulse.erp_line add column package_label text check (package_label is null or (length(btrim(package_label)) between 1 and 400 and package_label !~ '[[:cntrl:]]'));
alter table pulse.erp_line add column package_default jsonb check (package_default is null or (jsonb_typeof(package_default) = 'object' and pg_column_size(package_default) < 512));
alter table pulse.erp_line add column list_rate bigint check (list_rate is null or list_rate between 0 and 1000000000000);
-- An included, to-be-quoted or bonus line is priced at nothing: its words are printed instead of an amount.
alter table pulse.erp_line add constraint erp_line_role_free check (line_role is null or rate = 0);
comment on column pulse.erp_line.phase is 'QUOTE-STRUCT (2252): the phase heading this line prints under (name as printed)';
comment on column pulse.erp_line.line_role is 'QUOTE-STRUCT (2252): included (prints Included), to_quote (prints To be quoted), bonus (value struck through, ₹0)';
comment on column pulse.erp_line.package_id is 'QUOTE-STRUCT (2252): the package this part line came from (the catalogue package itself is never changed by the quotation)';
comment on column pulse.erp_line.package_default is 'QUOTE-STRUCT (2252): the package''s default for this part ({qty, rate, itemId}); null for an item added on this quotation';

-- 4. Cost and margin: never for a sales seat.
create or replace function pulse.erp_sees_cost() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select erp_can(false) and (viewer_is('leadership','admin','finance') or not viewer_is('sales','sales_head')) and case coalesce((select s.cost_visibility from erp_settings s where s.org_id = current_org()), 'everyone')
  when 'owner' then viewer_is('leadership','admin') when 'finance' then viewer_is('leadership','admin','finance') else true end
$$;

-- migrate:down
-- Forward-only: phases, item phases and the lines' phase and package details are kept.
