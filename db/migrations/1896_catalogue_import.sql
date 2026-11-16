-- migrate:up
-- GROWTH-LOOP slice 5 (owner, 8 Nov 2026; Kazuk: "I'll add the final items myself"): owners build their own catalogue
-- from a Google Sheet, an Excel or CSV file, or a table pasted from a doc. The screen matches the sheet's columns to
-- name, unit, rate, GST %, HSN/SAC and category, shows a preview and what will be new, changed or skipped, then
-- imports. Every import is a batch that remembers each item it made and each item's values before and after, so it
-- shows what changed and can be undone (made items archived, changed items put back unless changed again since).
--
-- Who: leadership and the Finance role (Billing's full seat). A salesperson's seat, which writes only its own items,
-- does not import (a restrictive policy says so here too, beside the API's check).

alter table pulse.erp_item add column category text
  check (category is null or (length(btrim(category)) between 1 and 60 and category !~ '[[:cntrl:]]'));

-- A category change is a new version of the item, like every other field (0190's bump, with category added).
create or replace function pulse.erp_item_bump() returns trigger language plpgsql as $$
begin
 if new.version=old.version and (new.name,new.description,new.sac,new.unit,new.price,new.gst_rate,new.cost,new.kind,new.milestones,new.setup,new.status,new.code,new.category)
  is distinct from (old.name,old.description,old.sac,old.unit,old.price,old.gst_rate,old.cost,old.kind,old.milestones,old.setup,old.status,old.code,old.category) then
  new.version:=old.version+1;
 end if;
 new.updated_at:=now();
 return new;
end $$;

create table pulse.erp_import_batch (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  file_name text check (file_name is null or (length(file_name) <= 200 and file_name !~ '[[:cntrl:]]')),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  created_count int not null default 0 check (created_count >= 0),
  updated_count int not null default 0 check (updated_count >= 0),
  unchanged_count int not null default 0 check (unchanged_count >= 0),
  skipped_count int not null default 0 check (skipped_count >= 0),
  undone_at timestamptz,
  undone_by uuid references pulse.person(id)
);
create index erp_import_batch_org on pulse.erp_import_batch(org_id, created_at desc);

create table pulse.erp_import_change (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references pulse.erp_import_batch(id),
  item_id uuid not null references pulse.erp_item(id),
  action text not null check (action in ('created', 'updated')),
  before jsonb check (before is null or jsonb_typeof(before) = 'object'),
  after jsonb not null check (jsonb_typeof(after) = 'object'),
  check ((action = 'created') = (before is null))
);
create index erp_import_change_batch on pulse.erp_import_change(batch_id);

alter table pulse.erp_import_batch enable row level security;
alter table pulse.erp_import_batch force row level security;
alter table pulse.erp_import_change enable row level security;
alter table pulse.erp_import_change force row level security;
create policy tenant_isolation on pulse.erp_import_batch using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy tenant_isolation on pulse.erp_import_change using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy erp_import_full_seat on pulse.erp_import_batch as restrictive for all to pulse_api
  using ((select pulse.erp_can(true)) and not (select pulse.erp_own_only())) with check ((select pulse.erp_can(true)) and not (select pulse.erp_own_only()));
create policy erp_import_full_seat on pulse.erp_import_change as restrictive for all to pulse_api
  using ((select pulse.erp_can(true)) and not (select pulse.erp_own_only())) with check ((select pulse.erp_can(true)) and not (select pulse.erp_own_only()));
revoke all on pulse.erp_import_batch, pulse.erp_import_change from public;
grant select, insert on pulse.erp_import_change to pulse_api;
grant select, insert, update (undone_at, undone_by) on pulse.erp_import_batch to pulse_api;

-- migrate:down
drop table if exists pulse.erp_import_change;
drop table if exists pulse.erp_import_batch;
create or replace function pulse.erp_item_bump() returns trigger language plpgsql as $$
begin
 if new.version=old.version and (new.name,new.description,new.sac,new.unit,new.price,new.gst_rate,new.cost,new.kind,new.milestones,new.setup,new.status,new.code)
  is distinct from (old.name,old.description,old.sac,old.unit,old.price,old.gst_rate,old.cost,old.kind,old.milestones,old.setup,old.status,old.code) then
  new.version:=old.version+1;
 end if;
 new.updated_at:=now();
 return new;
end $$;
alter table pulse.erp_item drop column if exists category;
