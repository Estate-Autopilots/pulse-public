-- migrate:up
-- TASK-MERGE (Pip, owner 7 Nov 2026): "Fix the side panel (Pip). It detects keywords in titles and auto-opens irrelevant
-- suggestions on the right on its own." Pip now suggests only from structure, and a person's "Not useful" is kept here,
-- per person, per suggestion kind and subject (a task id, a Pulse path, a file id), so it follows them to every device
-- and never comes back; the counts per kind let a kind a person keeps dismissing score down for them. Only the person
-- reads and writes their own rows (row security); no words of any message or title are kept.
create table pulse.pip_feedback (
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id) on delete cascade,
  kind text not null check (kind ~ '^[a-z][a-z0-9-]{0,39}$'),
  subject text not null check (length(subject) between 1 and 200),
  accepted int not null default 0 check (accepted >= 0),
  dismissed int not null default 0 check (dismissed >= 0),
  dismissed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (org_id, person_id, kind, subject)
);
alter table pulse.pip_feedback enable row level security;
alter table pulse.pip_feedback force row level security;
create policy tenant_isolation on pulse.pip_feedback using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy own_rows on pulse.pip_feedback as restrictive to pulse_api using (person_id = pulse.current_viewer()) with check (person_id = pulse.current_viewer());
grant select, insert, update on pulse.pip_feedback to pulse_api;

-- migrate:down
drop table if exists pulse.pip_feedback;
