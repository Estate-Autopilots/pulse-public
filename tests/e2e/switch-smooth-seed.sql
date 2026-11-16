-- SWITCH-SMOOTH walk (tests/e2e/switch-smooth-walk.mjs): one fake person with a Pulse account and a seat in three fake
-- companies (Fake Vitals Tech, Fake Estate Co, Fake Closers Co) and their own workspace. The account has its own e-mail
-- (a made-up Gmail address) and a Pulse password the walk never types (the owner: "I don't even know what my
-- password is"). Re-runnable: each run starts from two company-only sessions in Fake Vitals Tech (like the owner's from
-- before 2125: via 'account', personal = false) and no trusted device. Run as the scratch database's owner, on a scratch
-- database only. Every value is synthetic.
\set ON_ERROR_STOP on
begin;
do $s$ declare a uuid := 'a0000000-0000-4000-8000-0000000005a0';
  orgs uuid[] := array['f1000000-0000-4000-8000-0000000005a1', 'f2000000-0000-4000-8000-0000000005a2', 'f3000000-0000-4000-8000-0000000005a3', 'f4000000-0000-4000-8000-0000000005a4']::uuid[];
  people uuid[] := array['e1000000-0000-4000-8000-0000000005a1', 'e2000000-0000-4000-8000-0000000005a2', 'e3000000-0000-4000-8000-0000000005a3', 'e4000000-0000-4000-8000-0000000005a4']::uuid[];
  names text[] := array['Fake Vitals Tech', 'Fake Estate Co', 'Fake Closers Co', 'Fake Smooth Person']; codes text[] := array['FVS', 'FES', 'FCS', 'FSP'];
  handles text[] := array['fakevitalssmooth', 'fakeestatesmooth', 'fakeclosessmooth', 'fakesmoothspace']; i int;
begin
  if not exists (select 1 from pulse_priv.pulse_account where id = a) then
    for i in 1 .. 4 loop
      perform set_config('pulse.org_id', orgs[i]::text, true);
      insert into pulse.org(id, slug, name, code, handle) values (orgs[i], handles[i], names[i], codes[i], handles[i]);
      insert into pulse.person(id, org_id, display_name, side, active_from) values (people[i], orgs[i], 'Fake Smooth Person', 'staff', '2026-01-05');
      insert into pulse.people_profile(org_id, person_id, role, evidence, username, user_no, joined_on)
        values (orgs[i], people[i], 'Owner', 'Synthetic walk fixture', 'fakesmooth' || i, 1, '2026-01-05');
      insert into pulse.role_assignment(org_id, person_id, role_key, valid_from) values (orgs[i], people[i], 'admin', '2026-01-01');
    end loop;
    perform set_config('pulse.org_id', '', true);
    insert into pulse.install(id, org_id, initialised_by) values (true, orgs[1], 'switch-smooth walk (synthetic)') on conflict (id) do nothing;
    insert into pulse_priv.pulse_account(id, handle, display_name, email, password_hash, last_org, email_confirmed_at, email_verified_at)
    values (a, 'fakesmooth', 'Fake Smooth Person', 'user-e5877109@gmail.com', crypt('Fake-Pass-Never-Typed-1', gen_salt('bf', 6)), orgs[1], now(), now());
    insert into pulse_priv.handle_name(handle, kind, ref) values ('fakesmooth', 'person', a);
    insert into pulse_priv.account_member(account_id, member_org, person_id, kind)
      values (a, orgs[1], people[1], 'staff'), (a, orgs[2], people[2], 'staff'), (a, orgs[3], people[3], 'staff'), (a, orgs[4], people[4], 'staff');
    -- The fourth is the person's own workspace (1640's personal space: one person only).
    update pulse.org set kind = 'personal', personal_account = a where id = orgs[4];
  end if;
  -- Each run: no trusted device, no code waiting, and the browser's sign-in is a company-only one in Fake Vitals Tech
  -- (token 1; token 2 is a later company sign-in on the same browser, as the shared address makes one: via 'account', not personal).
  delete from pulse_priv.account_device where account_id = a;
  delete from pulse_priv.account_prove_code where account_id = a;
  update pulse_priv.pulse_account set last_org = orgs[1], failed = 0, locked_until = null where id = a;
  for i in 1 .. 4 loop
    perform set_config('pulse.org_id', orgs[i]::text, true);
    delete from pulse.login_session where org_id = orgs[i] and person_id = people[i];
  end loop;
  perform set_config('pulse.org_id', orgs[1]::text, true);
  insert into pulse.login_session(org_id, person_id, token_hash, created_at, expires_at, via, personal, device)
    values (orgs[1], people[1], encode(digest('switchSmoothCompanyWalkToken0000000000000001', 'sha256'), 'hex'), '2026-11-10', now() + interval '1 day', 'account', false, 'Chrome on Windows'),
           (orgs[1], people[1], encode(digest('switchSmoothCompanyWalkToken0000000000000002', 'sha256'), 'hex'), now(), now() + interval '1 day', 'account', false, 'Chrome on Windows');
  perform set_config('pulse.org_id', '', true);
end $s$;
commit;
