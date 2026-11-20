-- migrate:up
-- AC-CONTACTS (owner, 18 Nov 2026): "There's no workflow to add, in our Atlas Crest Vitals OS, the contact and the
-- details, so later it gets easier. Testers are potential clients; track who is testing."
-- A contact already has a name, phone, e-mail, company, role and notes (0004, 2190). Four things it did not have:
--  * tags: short lowercase words the team picks ("tester", "prospect"), the same rule as a doc's tags (1716,
--    pulse.doc_tags_ok: up to 20, each up to 40 letters), so a list can be filtered by them;
--  * contact_status: where they are with us, one of new, talking (in talks), invited (to test), installed, active (using
--    it), stopped, client (became a client), not_now; contact_status_at says since when;
--  * device: the phone they test on (android, iphone, both, other);
--  * came_from: where they came from, in words ("Sales X-Ray tester list", "Referred by a client").
-- contact_profile.source stays what it was (which sync or screen made the row). Every change is written to
-- pulse.record_change by the API, as the other contact fields are.
-- pulse.contact_writer(): who may add and change contacts through API v1 and the AI tools (add_contact,
-- update_contact): an admin, leadership or the Finance role (as clients, v1_client_create); an AI employee only while it
-- answers a message from an admin or leadership (2393's agent_run_asker), never on its own or from a schedule.
alter table pulse.contact_profile
  add column tags text[] not null default '{}' constraint contact_profile_tags_ok check (pulse.doc_tags_ok(tags)),
  add column contact_status text constraint contact_profile_status_ok
    check (contact_status in ('new', 'talking', 'invited', 'installed', 'active', 'stopped', 'client', 'not_now')),
  add column contact_status_at timestamptz,
  add column device text constraint contact_profile_device_ok check (device in ('android', 'iphone', 'both', 'other')),
  add column came_from text constraint contact_profile_came_from_len check (length(came_from) between 1 and 120);
create index contact_profile_tags on pulse.contact_profile using gin (tags);

create function pulse.contact_writer() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when current_viewer() is null then false
    when agent_session() is null then viewer_is('admin', 'leadership') or erp_can(true)
    else exists(select 1 from role_assignment ra where ra.person_id = agent_run_asker() and ra.org_id = current_org()
      and ra.role_key in ('admin', 'leadership') and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')) end
$$;
revoke all on function pulse.contact_writer() from public;
grant execute on function pulse.contact_writer() to pulse_api;

-- The API role wrote contacts only as an admin (0004: person admin/HR; contact_profile and client_contact admin; 2190:
-- company admin). A contact writer writes them too: a contact's person row (never a staff member's or an AI member's),
-- their profile, their link to a client, and the company they work at (found or added, its main contact set once).
-- Admins and HR keep exactly what they had. The screens' routes still ask for an admin (records.ts canEditRecords).
drop policy record_insert on pulse.person;
create policy record_insert on pulse.person as restrictive for insert to pulse_api
  with check (pulse.viewer_is('admin', 'hr') or (side not in ('staff', 'agent') and pulse.contact_writer()));
drop policy record_update on pulse.person;
create policy record_update on pulse.person as restrictive for update to pulse_api
  using (pulse.viewer_is('admin', 'hr') or (side not in ('staff', 'agent') and pulse.contact_writer()))
  with check (pulse.viewer_is('admin', 'hr') or (side not in ('staff', 'agent') and pulse.contact_writer()));
drop policy record_insert on pulse.contact_profile;
create policy record_insert on pulse.contact_profile as restrictive for insert to pulse_api with check (pulse.viewer_is('admin') or pulse.contact_writer());
drop policy record_update on pulse.contact_profile;
create policy record_update on pulse.contact_profile as restrictive for update to pulse_api
  using (pulse.viewer_is('admin') or pulse.contact_writer()) with check (pulse.viewer_is('admin') or pulse.contact_writer());
drop policy record_insert on pulse.client_contact;
create policy record_insert on pulse.client_contact as restrictive for insert to pulse_api with check (pulse.viewer_is('admin') or pulse.contact_writer());
drop policy admin_insert on pulse.company;
create policy admin_insert on pulse.company as restrictive for insert to pulse_api
  with check ((pulse.viewer_is('admin') or pulse.contact_writer()) and pulse.current_viewer() is not null);
drop policy admin_update on pulse.company;
create policy admin_update on pulse.company as restrictive for update to pulse_api
  using ((pulse.viewer_is('admin') or pulse.contact_writer()) and pulse.current_viewer() is not null)
  with check ((pulse.viewer_is('admin') or pulse.contact_writer()) and pulse.current_viewer() is not null);

-- migrate:down
-- Forward-only: tags, status, device and where a contact came from are company data.
