-- IDENTITY-UNIFY walk (tests/e2e/identity-unify-walk.mjs): three fake companies, one fake person with a seat in each
-- under a different username (fakesam, fakesam123, fake.sam.seats), a fake admin, and in Fake Gamma Works a different
-- fake person who already has the username fakesam. Run as the scratch database's owner on an empty, migrated
-- scratch database only (1746's triggers do the renaming). Obviously synthetic values.
\set ON_ERROR_STOP on
begin;
create temp table seed(k text primary key, id uuid) on commit drop;
insert into seed values ('alpha', gen_random_uuid()), ('beta', gen_random_uuid()), ('gamma', gen_random_uuid()),
  ('sam_a', gen_random_uuid()), ('sam_b', gen_random_uuid()), ('sam_c', gen_random_uuid()), ('other_c', gen_random_uuid()),
  ('max_b', gen_random_uuid()), ('acct_sam', gen_random_uuid()), ('acct_max', gen_random_uuid());
do $s$ declare o record; p record; s record; begin
  for o in select * from (values ('alpha', 'Fake Alpha Studio', 'FUA', 'fakeualpha'), ('beta', 'Fake Beta Labs', 'FUB', 'fakeubeta'),
                                 ('gamma', 'Fake Gamma Works', 'FUC', 'fakeugamma')) v(k, name, code, handle) loop
    perform set_config('pulse.org_id', (select id from seed where k = o.k)::text, true);
    insert into pulse.org(id, slug, name, code, handle) values ((select id from seed where k = o.k), o.handle, o.name, o.code, o.handle);
  end loop;
  for p in select * from (values ('sam_a', 'alpha', 'Fake Sam Seats', 'Video editor', 'fakesam', 2),
                                 ('sam_b', 'beta', 'Fake Sam Seats', 'Designer', 'fakesam123', 2),
                                 ('sam_c', 'gamma', 'Fake Sam Seats', 'Writer', 'fake.sam.seats', 2),
                                 ('other_c', 'gamma', 'Fake Other Sam', 'Editor', 'fakesam', 3),
                                 ('max_b', 'beta', 'Fake Max Admin', 'Owner', 'fakemaxu', 1)) v(k, org, name, role, username, no) loop
    perform set_config('pulse.org_id', (select id from seed where k = p.org)::text, true);
    insert into pulse.person(id, org_id, display_name, side, active_from) values ((select id from seed where k = p.k), (select id from seed where k = p.org), p.name, 'staff', '2026-01-05');
    insert into pulse.people_profile(org_id, person_id, role, evidence, username, user_no, joined_on)
    values ((select id from seed where k = p.org), (select id from seed where k = p.k), p.role, 'Synthetic walk fixture', p.username, p.no, '2026-01-05');
    if p.k = 'max_b' then
      insert into pulse.role_assignment(org_id, person_id, role_key, valid_from) values ((select id from seed where k = p.org), (select id from seed where k = p.k), 'admin', '2026-01-01');
    end if;
  end loop;
  perform set_config('pulse.org_id', '', true);
  insert into pulse_priv.pulse_account(id, handle, display_name, password_hash, last_org) values
    ((select id from seed where k = 'acct_sam'), 'fakesam', 'Fake Sam Seats', crypt('Fake-Pass-For-Tests-1', gen_salt('bf', 6)), (select id from seed where k = 'alpha')),
    ((select id from seed where k = 'acct_max'), 'fakemaxu', 'Fake Max Admin', crypt('Fake-Pass-For-Tests-1', gen_salt('bf', 6)), (select id from seed where k = 'beta'));
  insert into pulse_priv.handle_name(handle, kind, ref) values ('fakesam', 'person', (select id from seed where k = 'acct_sam')), ('fakemaxu', 'person', (select id from seed where k = 'acct_max'));
  for s in select * from (values ('acct_sam', 'alpha', 'sam_a'), ('acct_sam', 'beta', 'sam_b'), ('acct_sam', 'gamma', 'sam_c'), ('acct_max', 'beta', 'max_b')) v(a, o, p) loop
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values ((select id from seed where k = s.a), (select id from seed where k = s.o), (select id from seed where k = s.p), 'staff');
  end loop;
end $s$;
commit;
