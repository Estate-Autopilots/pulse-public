-- PROFILE-2 walk (synthetic): one Pulse account in two real companies and one test company; in the first company a
-- manager, the person and two reports, with skills; a personal session (the token is walk-only). Fake names only.
\set ON_ERROR_STOP on
begin;
do $s$ declare a uuid := 'a0000000-0000-4000-8000-0000000000b2';
  orgs uuid[] := array['f1000000-0000-4000-8000-0000000000b1', 'f2000000-0000-4000-8000-0000000000b2', 'f3000000-0000-4000-8000-0000000000b3']::uuid[];
  me uuid[] := array['e1000000-0000-4000-8000-0000000000b1', 'e2000000-0000-4000-8000-0000000000b2', 'e3000000-0000-4000-8000-0000000000b3']::uuid[];
  names text[] := array['Fake Harbour Media', 'Fake Estate Co', 'Fake Sales Test']; codes text[] := array['FHM', 'FEC', 'FST'];
  handles text[] := array['fakeharbourp2', 'fakeestatep2', 'fakesalestestp2']; roles text[] := array['Head of Content', 'Advisor', 'Owner'];
  boss uuid := 'e4000000-0000-4000-8000-0000000000b4'; r1 uuid := 'e5000000-0000-4000-8000-0000000000b5'; r2 uuid := 'e6000000-0000-4000-8000-0000000000b6'; i int;
begin
  for i in 1 .. 3 loop
    perform set_config('pulse.org_id', orgs[i]::text, true);
    insert into pulse.org(id, slug, name, code, handle, purpose) values (orgs[i], handles[i], names[i], codes[i], handles[i], case when i = 3 then 'test' else 'work' end);
    insert into pulse.person(id, org_id, display_name, side, active_from) values (me[i], orgs[i], 'Asha Fakerao', 'staff', '2024-03-04');
    insert into pulse.people_profile(org_id, person_id, role, evidence, username, user_no, joined_on, department)
      values (orgs[i], me[i], roles[i], 'Synthetic walk fixture', 'ashafake', 1, '2024-03-04', 'Creative');
    insert into pulse.role_assignment(org_id, person_id, role_key, valid_from) values (orgs[i], me[i], 'admin', '2024-01-01');
  end loop;
  perform set_config('pulse.org_id', orgs[1]::text, true);
  insert into pulse.person(id, org_id, display_name, side, active_from) values
    (boss, orgs[1], 'Ravi Fakemehta', 'staff', '2023-06-01'), (r1, orgs[1], 'Megud Fakegaonkar', 'staff', '2025-02-10'), (r2, orgs[1], 'Kabir Fakesingh', 'staff', '2025-08-18');
  insert into pulse.people_profile(org_id, person_id, role, evidence, username, user_no, joined_on, department, pod, manager_id, skills) values
    (orgs[1], boss, 'Founder', 'Synthetic walk fixture', 'ravifake', 2, '2023-06-01', 'Leadership', 'Leadership', null, array['Strategy', 'Fundraising']),
    (orgs[1], r1, 'Video editor', 'Synthetic walk fixture', 'mansifake', 3, '2025-02-10', 'Creative', 'Reels', me[1], array['Video editing', 'Adobe Premiere Pro', 'Colour grading', 'Reels and short videos', 'Storyboarding']),
    (orgs[1], r2, 'Motion designer', 'Synthetic walk fixture', 'kabirfake', 4, '2025-08-18', 'Creative', 'Reels', me[1], array['Motion graphics', 'Adobe After Effects']);
  update pulse.people_profile set manager_id = boss, pod = 'Reels', skills = array['Content strategy', 'Script writing', 'Team leadership', 'Video editing']
   where person_id = me[1];
  perform set_config('pulse.org_id', '', true);
  insert into pulse.install(id, org_id, initialised_by) values (true, orgs[1], 'profile-2 walk (synthetic)') on conflict (id) do nothing;
  insert into pulse_priv.pulse_account(id, handle, display_name, email, password_hash, last_org, email_confirmed_at, email_verified_at, email_own_confirmed_at)
  values (a, 'ashafake', 'Asha Fakerao', 'user-f16f3b4d@gmail.com', crypt('Fake-Pass-For-Tests-2', gen_salt('bf', 6)), orgs[1], now(), now(), now());
  insert into pulse_priv.handle_name(handle, kind, ref) values ('ashafake', 'person', a);
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (a, orgs[1], me[1], 'staff'), (a, orgs[2], me[2], 'staff'), (a, orgs[3], me[3], 'staff');
  insert into pulse_priv.account_profile(account_id, headline, about, skills, links, pronouns, location, languages, education, certifications, contact_email)
  values (a, 'Head of Content · reels, launch films and property walkthroughs',
    E'I lead a small team that turns property launches into short films and reels people actually finish watching.\n\nBefore Harbour I cut documentaries and ran a YouTube channel about city homes. I care about clear stories, tight edits and a calm team. I like hard deadlines, good coffee and teaching new editors how to colour-grade without overdoing it. Right now I am building a library of launch templates so a new project starts in a day instead of a week.',
    array['Content strategy', 'Video editing', 'Script writing', 'Team leadership', 'Colour grading', 'DaVinci Resolve'],
    '[{"label":"fakeportfolio.example","url":"https://fakeportfolio.example"}]'::jsonb, 'she/her', 'Pune, India', array['English', 'Hindi', 'Marathi'],
    '[{"school":"Fake Institute of Film","degree":"Diploma in Film Editing","from":"2014","to":"2016"}]'::jsonb,
    '[{"name":"Colour Grading Fundamentals","issuer":"Fake Colour Academy","on":"2021","url":null}]'::jsonb, 'user-f16f3b4d@gmail.com')
  on conflict (account_id) do update set headline = excluded.headline, about = excluded.about, skills = excluded.skills, links = excluded.links, pronouns = excluded.pronouns,
    location = excluded.location, languages = excluded.languages, education = excluded.education, certifications = excluded.certifications, contact_email = excluded.contact_email;
  perform set_config('pulse.org_id', orgs[1]::text, true);
  insert into pulse.login_session(org_id, person_id, token_hash, expires_at, via, personal, device)
    values (orgs[1], me[1], encode(digest('profiletwoPersonalWalkToken00000000000000001', 'sha256'), 'hex'), now() + interval '1 day', 'account', true, 'Chrome on Linux');
  perform set_config('pulse.org_id', '', true);
end $s$;
commit;
