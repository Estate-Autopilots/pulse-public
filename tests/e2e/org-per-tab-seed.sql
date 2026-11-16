-- ORG-PER-TAB walk (tests/e2e/org-per-tab-walk.mjs): one fake person with a Pulse account and a seat in two fake
-- companies, a doc in each, and a third fake company the account is not in (with its own doc). Run as the scratch
-- database's owner on an empty, migrated scratch database only. Obviously synthetic values.
\set ON_ERROR_STOP on
begin;
do $s$ declare a uuid := 'a0000000-0000-4000-8000-00000000000a';
  orgs uuid[] := array['f1000000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000002', 'f3000000-0000-4000-8000-000000000003']::uuid[];
  people uuid[] := array['e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000002', 'e3000000-0000-4000-8000-000000000003']::uuid[];
  docs uuid[] := array['d1000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000003']::uuid[];
  names text[] := array['Fake Vitals Tech', 'Fake Estate Co', 'Fake Stranger Co']; codes text[] := array['FVT', 'FEC', 'FSC'];
  handles text[] := array['fakevitalstech', 'fakeestateco', 'fakestrangerco']; i int;
begin
  for i in 1 .. 3 loop
    perform set_config('pulse.org_id', orgs[i]::text, true);
    insert into pulse.org(id, slug, name, code, handle) values (orgs[i], handles[i], names[i], codes[i], handles[i]);
    insert into pulse.person(id, org_id, display_name, side, active_from) values (people[i], orgs[i], case when i = 3 then 'Fake Stranger Person' else 'Fake Tab Person' end, 'staff', '2026-01-05');
    insert into pulse.people_profile(org_id, person_id, role, evidence, username, user_no, joined_on) values (orgs[i], people[i], 'Owner', 'Synthetic walk fixture', 'faketab' || i, 1, '2026-01-05');
    insert into pulse.role_assignment(org_id, person_id, role_key, valid_from) values (orgs[i], people[i], 'admin', '2026-01-01');
    perform set_config('pulse.viewer_id', people[i]::text, true);
    insert into pulse.doc(org_id, id, title, body_html, body_text, created_by, access) values (orgs[i], docs[i], 'Fake plan of ' || names[i], '<p>Fake words of ' || names[i] || '.</p>', 'Fake words of ' || names[i] || '.', people[i], 'company');
    insert into pulse.project(org_id, registry_no, name, title, kind, status) values (orgs[i], 1, 'Fake launch at ' || names[i], 'Fake launch at ' || names[i], 'client_work', 'active');
  end loop;
  perform set_config('pulse.org_id', '', true); perform set_config('pulse.viewer_id', '', true);
  insert into pulse_priv.pulse_account(id, handle, display_name, email, password_hash, last_org, email_confirmed_at, email_verified_at)
  values (a, 'faketab', 'Fake Tab Person', 'fake.tab@example.test', crypt('Fake-Pass-For-Tests-1', gen_salt('bf', 6)), orgs[2], now(), now());
  insert into pulse_priv.handle_name(handle, kind, ref) values ('faketab', 'person', a);
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (a, orgs[1], people[1], 'staff'), (a, orgs[2], people[2], 'staff');
end $s$;
commit;
