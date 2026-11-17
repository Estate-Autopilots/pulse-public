-- migrate:up
-- NEW-DOTS (owner, 8 Nov 2026: "Wherever a new update comes, inside the app there should be a red, attention-grabbing
-- indicator, like PUBG Mobile marks a new event in red. You go and check what's there, and then it goes away.")
-- A release note (pulse.release_note, 1844) names the pages it changed for each audience (its items' href). For each
-- person this keeps, on the server so it follows them to every device:
--   pulse.release_seen       the changed pages of a release they have opened (or marked as seen): their red dot is gone;
--   pulse.release_dots_pref  whether they want the red dots at all (no row: yes).
-- The API works out what is still unseen from the notes for their audiences and the pages they can open
-- (services/api/src/new-dots.ts). Each person reads and writes only their own rows (row security: their organisation
-- and their own person); this is screen state, so it carries no audit trigger (every page visit would write one).
create table pulse.release_seen (
  org_id uuid not null references pulse.org(id) on delete cascade,
  person_id uuid not null references pulse.person(id) on delete cascade,
  note_id bigint not null references pulse.release_note(id) on delete cascade,
  route text not null check (route ~ '^/[A-Za-z0-9/_-]{1,200}$'),
  seen_at timestamptz not null default clock_timestamp(),
  primary key (org_id, person_id, note_id, route)
);
create table pulse.release_dots_pref (
  org_id uuid not null references pulse.org(id) on delete cascade,
  person_id uuid not null references pulse.person(id) on delete cascade,
  dots_on boolean not null default true,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (org_id, person_id)
);

alter table pulse.release_seen enable row level security;
alter table pulse.release_seen force row level security;
create policy tenant_isolation on pulse.release_seen
  using (org_id = pulse.current_org() and person_id = pulse.current_viewer())
  with check (org_id = pulse.current_org() and person_id = pulse.current_viewer());
revoke all on pulse.release_seen from public;
grant select, insert, delete on pulse.release_seen to pulse_api;

alter table pulse.release_dots_pref enable row level security;
alter table pulse.release_dots_pref force row level security;
create policy tenant_isolation on pulse.release_dots_pref
  using (org_id = pulse.current_org() and person_id = pulse.current_viewer())
  with check (org_id = pulse.current_org() and person_id = pulse.current_viewer());
revoke all on pulse.release_dots_pref from public;
grant select, insert, update on pulse.release_dots_pref to pulse_api;

-- migrate:down
drop table if exists pulse.release_dots_pref;
drop table if exists pulse.release_seen;
