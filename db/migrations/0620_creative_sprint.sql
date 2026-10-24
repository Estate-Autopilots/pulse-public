-- migrate:up
-- EST-1474 (T1 slice 1, Kazuk's ask of 17 Oct: EA's Creative Strategist SOPs as a Pulse app): one creative sprint per
-- client project (its package, Day 1, the named client approver, the growth strategist and the creative strategist) and
-- its items: the critical inputs with an owner and a received date, and the dated deliverables with a done date. The
-- clock itself is computed (services/api/src/creative-model.ts). Company-neutral: keys come from the app's seed
-- configuration, not from EA's names. A client's edit carries the time it was made; an older edit that arrives after a
-- newer one changes nothing ("concurrent edits keep the newest"). No deletes: a sprint is archived.

create table pulse.creative_sprint (
  org_id       uuid not null references pulse.org(id),
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references pulse.project(id),
  package      text not null check (package ~ '^[a-z0-9_]{1,40}$'),
  day_one      date not null,
  approver     text check (length(approver) <= 120),
  gs_person_id uuid references pulse.person(id),
  cs_person_id uuid references pulse.person(id),
  status       text not null default 'active' check (status in ('active', 'archived')),
  edited_at    timestamptz not null default now(),
  created_by   uuid references pulse.person(id),
  created_at   timestamptz not null default now()
);
create unique index creative_sprint_active on pulse.creative_sprint (org_id, project_id) where status = 'active';
create index creative_sprint_people on pulse.creative_sprint (org_id, cs_person_id, gs_person_id) where status = 'active';

create table pulse.creative_sprint_item (
  org_id          uuid not null references pulse.org(id),
  sprint_id       uuid not null references pulse.creative_sprint(id),
  kind            text not null check (kind in ('input', 'milestone')),
  key             text not null check (key ~ '^[a-z0-9_]{1,40}$'),
  owner_person_id uuid references pulse.person(id),
  done_on         date,
  note            text check (length(note) <= 500),
  edited_at       timestamptz not null default now(),
  primary key (sprint_id, kind, key)
);

alter table pulse.creative_sprint enable row level security;
alter table pulse.creative_sprint force row level security;
create policy tenant on pulse.creative_sprint using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
alter table pulse.creative_sprint_item enable row level security;
alter table pulse.creative_sprint_item force row level security;
create policy tenant on pulse.creative_sprint_item using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select, insert, update on pulse.creative_sprint, pulse.creative_sprint_item to pulse_api;
grant select on pulse.creative_sprint, pulse.creative_sprint_item to pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.creative_sprint for each row execute function pulse.audit_mutation();
create trigger audit_mutation after insert or update or delete on pulse.creative_sprint_item for each row execute function pulse.audit_mutation();

-- migrate:down
-- Forward-only. Archive a sprint instead of deleting it.
