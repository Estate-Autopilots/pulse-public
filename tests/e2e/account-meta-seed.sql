-- ACCOUNT-META walk (tests/e2e/account-meta-walk.mjs): one fake person with a Pulse account and a seat in two fake
-- companies. The account has a personal e-mail (a made-up Gmail address), a work e-mail they proved and confirmed as
-- theirs alone, and a shared admin@ address that the rule took off. It has two live sessions: one personal (their own
-- password) and one company-only (the company's sign-in). Run as the scratch database's owner, on an empty migrated
-- scratch database only. Every value is synthetic.
\set ON_ERROR_STOP on
begin;
do $s$ declare a uuid := 'a0000000-0000-4000-8000-0000000000ae';
  orgs uuid[] := array['f1000000-0000-4000-8000-0000000000a1', 'f2000000-0000-4000-8000-0000000000a2']::uuid[];
  people uuid[] := array['e1000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000000a2']::uuid[];
  names text[] := array['Fake Vitals Tech', 'Fake Estate Co']; codes text[] := array['FVM', 'FEM'];
  handles text[] := array['fakevitalsmeta', 'fakeestatemeta']; i int;
begin
  for i in 1 .. 2 loop
    perform set_config('pulse.org_id', orgs[i]::text, true);
    insert into pulse.org(id, slug, name, code, handle) values (orgs[i], handles[i], names[i], codes[i], handles[i]);
    insert into pulse.person(id, org_id, display_name, side, active_from) values (people[i], orgs[i], 'Fake Meta Person', 'staff', '2026-01-05');
    insert into pulse.people_profile(org_id, person_id, role, evidence, username, user_no, joined_on)
      values (orgs[i], people[i], 'Owner', 'Synthetic walk fixture', 'fakemeta' || i, 1, '2026-01-05');
    insert into pulse.role_assignment(org_id, person_id, role_key, valid_from) values (orgs[i], people[i], 'admin', '2026-01-01');
  end loop;
  perform set_config('pulse.org_id', '', true);
  -- The install's own company (the API answers not_initialised without one): the first fake company.
  insert into pulse.install(id, org_id, initialised_by) values (true, orgs[1], 'account-meta walk (synthetic)') on conflict (id) do nothing;
  insert into pulse_priv.pulse_account(id, handle, display_name, email, password_hash, last_org, email_confirmed_at, email_verified_at)
  values (a, 'fakemeta', 'Fake Meta Person', 'user-ee6dcf51@gmail.com', crypt('Fake-Pass-For-Tests-1', gen_salt('bf', 6)), orgs[1], now(), now());
  insert into pulse_priv.handle_name(handle, kind, ref) values ('fakemeta', 'person', a);
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (a, orgs[1], people[1], 'staff'), (a, orgs[2], people[2], 'staff');
  insert into pulse_priv.account_login_email(email, account_id, verified_at, source, kind, own_confirmed_at)
    values ('fake.meta@fakeestate.example', a, now(), 'self', 'work', now());
  insert into pulse_priv.account_login_email_removed(account_id, email, was, reason) values (a, 'admin@fakeestate.example', 'restore', 'shared_mailbox');
  -- Two live sessions (tokens are walk-only; the walk sets them as the browser cookie): personal in FVM, company-only in FEM.
  perform set_config('pulse.org_id', orgs[1]::text, true);
  insert into pulse.login_session(org_id, person_id, token_hash, expires_at, via, personal, device)
    values (orgs[1], people[1], encode(digest('acctmetaPersonalWalkToken0000000000000000001', 'sha256'), 'hex'), now() + interval '1 day', 'account', true, 'Chrome on Linux');
  perform set_config('pulse.org_id', orgs[2]::text, true);
  insert into pulse.login_session(org_id, person_id, token_hash, expires_at, via, personal, device)
    values (orgs[2], people[2], encode(digest('acctmetaCompanyWalkToken00000000000000000002', 'sha256'), 'hex'), now() + interval '1 day', 'account', false, 'Firefox on Windows');
  perform set_config('pulse.org_id', '', true);
end $s$;
commit;
