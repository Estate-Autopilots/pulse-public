-- migrate:up
-- Pulse Map: where each development is, how precisely Pulse knows it, and where that knowledge came from.
-- A location is one real development (the geocoding run's project key); the project folders (engagements) that
-- belong to it are linked in project_location_member. The seed columns keep what the import said, so a pin moved
-- in the app can always be compared with, or reset to, its source. Every pin change is written to
-- project_location_change. Numbered 0010 because the map was built beside another workbench on the same database.

create table pulse.geo_import (                               -- one row per loaded file: the provenance of a seed
  org_id      uuid not null references pulse.org(id),
  id          uuid primary key default gen_random_uuid(),
  file_name   text not null,
  sha256      text not null,
  row_count   int  not null,
  built_at    timestamptz,                                    -- when the research run produced the file
  note        text,
  imported_at timestamptz not null default now(),
  unique (org_id, file_name, sha256)
);

create table pulse.locality (                                 -- a micro-market or city with a representative point
  org_id           uuid not null references pulse.org(id),
  id               uuid primary key default gen_random_uuid(),
  name             text not null default '',                  -- '' for a city-only group
  city             text not null,
  lat              double precision check (lat between -90 and 90),
  lng              double precision check (lng between -180 and 180),
  precision        text check (precision in ('locality','city')),
  source           text,
  project_count    int not null default 0,                    -- as counted by the import, kept for reconciliation
  engagement_count int not null default 0,
  aliases          text[] not null default '{}',
  import_id        uuid references pulse.geo_import(id),
  unique (org_id, city, name)
);

create table pulse.project_location (
  org_id         uuid not null references pulse.org(id),
  id             uuid primary key default gen_random_uuid(),
  geo_key        text not null,                               -- the research export's project key
  name           text,
  client_label   text,
  locality       text,
  city           text,
  lat            double precision check (lat between -90 and 90),
  lng            double precision check (lng between -180 and 180),
  precision      text check (precision in ('exact','building','street','locality','city')),   -- null: no point yet
  source         text,
  rera_numbers   text[] not null default '{}',                -- candidates found in documents, not verified
  maps_links     text[] not null default '{}',
  review_flags   text[] not null default '{}',
  seed_lat       double precision,
  seed_lng       double precision,
  seed_precision text,
  seed_source    text,
  import_id      uuid references pulse.geo_import(id),
  pinned_by      uuid references pulse.person(id),            -- set when someone placed the pin in the app
  pinned_at      timestamptz,
  updated_at     timestamptz not null default now(),
  unique (org_id, geo_key),
  check ((lat is null) = (lng is null) and (lat is null) = (precision is null))
);
create index project_location_place on pulse.project_location (org_id, city, locality);

create table pulse.project_location_member (                  -- which project folders are this development
  org_id      uuid not null references pulse.org(id),
  project_id  uuid primary key references pulse.project(id) on delete cascade,
  location_id uuid not null references pulse.project_location(id) on delete cascade,
  folder_id   text,                                           -- Drive folder the import matched on
  basis       text not null default 'folder_name'
);
create index project_location_member_location on pulse.project_location_member (org_id, location_id);

create table pulse.project_location_change (
  org_id        uuid not null references pulse.org(id),
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references pulse.project_location(id) on delete cascade,
  action        text not null check (action in ('pin','reset')),
  old_lat       double precision,
  old_lng       double precision,
  old_precision text,
  old_source    text,
  new_lat       double precision,
  new_lng       double precision,
  new_precision text,
  new_source    text,
  note          text,
  changed_by    uuid references pulse.person(id),
  changed_at    timestamptz not null default now()
);
create index project_location_change_location on pulse.project_location_change (org_id, location_id, changed_at desc);

do $$ declare t text; begin
  foreach t in array array['geo_import','locality','project_location','project_location_member','project_location_change'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select, insert, update, delete on pulse.%I to pulse_worker', t);
    execute format('grant select on pulse.%I to pulse_api', t);
  end loop;
end $$;

-- The app moves pins; only an organisation admin may, and each move is signed by the person who made it.
grant update (lat, lng, precision, source, pinned_by, pinned_at, updated_at) on pulse.project_location to pulse_api;
grant insert on pulse.project_location_change to pulse_api;
create policy pin_update on pulse.project_location as restrictive for update to pulse_api
  using (pulse.viewer_is('admin')) with check (pulse.viewer_is('admin'));
create policy pin_author on pulse.project_location_change as restrictive for insert to pulse_api
  with check (changed_by = pulse.current_viewer() and pulse.viewer_is('admin'));
-- migrate:down
