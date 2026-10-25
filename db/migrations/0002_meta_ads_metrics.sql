-- migrate:up
alter table pulse.ad_metric_day
  add column link_ctr numeric(8,5) check (link_ctr is null or link_ctr between 0 and 100),
  add column leads_reported boolean not null default false;

alter table pulse.lead
  alter constraint lead_ad_id_fkey deferrable initially immediate;

-- migrate:down
-- Forward-only (see db/migrations/README.md).
