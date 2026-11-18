-- PROFILE-UNIFY walk (tests/e2e/profile-unify-walk.mjs): three fake companies, two fake people with Pulse accounts.
-- Run as the scratch database's owner on an empty, migrated scratch database only. Obviously synthetic values.
\set ON_ERROR_STOP on
begin;
create temp table seed(k text primary key, id uuid) on commit drop;
insert into seed values ('alpha', gen_random_uuid()), ('beta', gen_random_uuid()), ('gamma', gen_random_uuid()),
  ('priya_a', gen_random_uuid()), ('priya_b', gen_random_uuid()), ('max_a', gen_random_uuid()), ('max_b', gen_random_uuid()), ('max_c', gen_random_uuid()),
  ('acct_priya', gen_random_uuid()), ('acct_max', gen_random_uuid());
do $s$ declare o record; p record; s record; begin
  for o in select * from (values ('alpha', 'Fake Alpha Studio', 'FKA', 'fakealpha'), ('beta', 'Fake Beta Labs', 'FKB', 'fakebeta'), ('gamma', 'Fake Gamma Works', 'FKC', 'fakegamma')) v(k, name, code, handle) loop
    perform set_config('pulse.org_id', (select id from seed where k = o.k)::text, true);
    insert into pulse.org(id, slug, name, code, handle) values ((select id from seed where k = o.k), o.handle, o.name, o.code, o.handle);
  end loop;
  for p in select * from (values ('priya_a', 'alpha', 'Fake Priya Person', 'Video editor', 'fakepriya', 2, 'Synthetic HR note A'),
                                 ('priya_b', 'beta', 'Fake Priya Person', 'Designer', 'fakepriya', 2, 'Synthetic HR note B'),
                                 ('max_a', 'alpha', 'Fake Max Admin', 'Owner', 'fakemax', 1, null), ('max_b', 'beta', 'Fake Max Admin', 'Owner', 'fakemax', 1, null),
                                 ('max_c', 'gamma', 'Fake Max Admin', 'Owner', 'fakemax', 1, null)) v(k, org, name, role, username, no, notes) loop
    perform set_config('pulse.org_id', (select id from seed where k = p.org)::text, true);
    insert into pulse.person(id, org_id, display_name, side, active_from) values ((select id from seed where k = p.k), (select id from seed where k = p.org), p.name, 'staff', '2026-01-05');
    insert into pulse.people_profile(org_id, person_id, role, evidence, username, user_no, notes, joined_on)
    values ((select id from seed where k = p.org), (select id from seed where k = p.k), p.role, 'Synthetic walk fixture', p.username, p.no, p.notes, '2026-01-05');
    if p.username = 'fakemax' then
      insert into pulse.role_assignment(org_id, person_id, role_key, valid_from) values ((select id from seed where k = p.org), (select id from seed where k = p.k), 'admin', '2026-01-01');
    end if;
  end loop;
  perform set_config('pulse.org_id', (select id from seed where k = 'alpha')::text, true);
  insert into pulse.task(org_id, title, status, assignee_person_id, done_at) values ((select id from seed where k = 'alpha'), 'Fake finished task', 'done', (select id from seed where k = 'priya_a'), now());
  perform set_config('pulse.org_id', '', true);
  insert into pulse_priv.pulse_account(id, handle, display_name, password_hash, last_org) values
    ((select id from seed where k = 'acct_priya'), 'fakepriya', 'Fake Priya Person', crypt('Fake-Pass-For-Tests-1', gen_salt('bf', 6)), (select id from seed where k = 'alpha')),
    ((select id from seed where k = 'acct_max'), 'fakemax', 'Fake Max Admin', crypt('Fake-Pass-For-Tests-1', gen_salt('bf', 6)), (select id from seed where k = 'alpha'));
  insert into pulse_priv.handle_name(handle, kind, ref) values ('fakepriya', 'person', (select id from seed where k = 'acct_priya')), ('fakemax', 'person', (select id from seed where k = 'acct_max'));
  for s in select * from (values ('acct_priya', 'alpha', 'priya_a'), ('acct_priya', 'beta', 'priya_b'), ('acct_max', 'alpha', 'max_a'), ('acct_max', 'beta', 'max_b'), ('acct_max', 'gamma', 'max_c')) v(a, o, p) loop
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values ((select id from seed where k = s.a), (select id from seed where k = s.o), (select id from seed where k = s.p), 'staff');
  end loop;
end $s$;
commit;
