-- PERSONAL-WORKSPACE walk (tests/e2e/personal-workspace-walk.mjs): one fake person with a Pulse account, a seat in a fake
-- company, and their personal workspace (made by pulse.personal_workspace_ensure) holding fake projects, goals and 60
-- tasks. Run as the scratch database's owner on an empty, migrated scratch database only. Obviously synthetic values.
\set ON_ERROR_STOP on
begin;
create temp table seed(k text primary key, id uuid) on commit drop;
insert into seed values ('co', gen_random_uuid()), ('co_me', gen_random_uuid()), ('acct', gen_random_uuid());
do $s$ declare co uuid := (select id from seed where k = 'co'); me uuid := (select id from seed where k = 'co_me'); a uuid := (select id from seed where k = 'acct');
  ws uuid; wme uuid; pid uuid; g uuid; t uuid; i int; names text[] := array['Fake PR and Story', 'Fake Flat Move', 'Fake Gear Upgrade', 'Fake Side Consulting', 'Fake Health and Workspace'];
  goals text[] := array['Fake goal: consulting at 2,500 an hour', 'Fake goal: move into a 2BHK by December', 'Fake goal: one Pulse for every company'];
begin
  perform set_config('pulse.org_id', co::text, true);
  insert into pulse.org(id, slug, name, code, handle) values (co, 'fakeagencyco', 'Fake Agency Co', 'FAC', 'fakeagencyco');
  insert into pulse.person(id, org_id, display_name, side, active_from) values (me, co, 'Fake Owner Person', 'staff', '2026-01-05');
  insert into pulse.people_profile(org_id, person_id, role, evidence, username, user_no, joined_on) values (co, me, 'Owner', 'Synthetic walk fixture', 'fakeowner', 1, '2026-01-05');
  insert into pulse.role_assignment(org_id, person_id, role_key, valid_from) values (co, me, 'admin', '2026-01-01'), (co, me, 'leadership', '2026-01-01');
  insert into pulse.project(org_id, registry_no, name, title, kind, status) values (co, 1, 'Fake Client Launch', 'Fake Client Launch', 'client_work', 'active');
  perform set_config('pulse.org_id', '', true);
  insert into pulse_priv.pulse_account(id, handle, display_name, email, password_hash, last_org, email_confirmed_at, email_verified_at)
  values (a, 'fakeowner', 'Fake Owner Person', 'fake.owner@example.test', crypt('Fake-Pass-For-Tests-1', gen_salt('bf', 6)), co, now(), now());
  insert into pulse_priv.handle_name(handle, kind, ref) values ('fakeowner', 'person', a);
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (a, co, me, 'staff');
  ws := pulse.personal_workspace_ensure(a);
  select person_id into wme from pulse_priv.account_member where account_id = a and member_org = ws;
  perform set_config('pulse.org_id', ws::text, true);
  perform set_config('pulse.viewer_id', wme::text, true);
  for i in 1 .. array_length(goals, 1) loop
    insert into pulse.goal(org_id, level, title, why, owner_person_id, target_on, measure_label, start_value, target_value, current_value, status, created_by)
    values (ws, 'person', goals[i], 'A synthetic goal for the walk', wme, current_date + 60 * i, case when i = 1 then 'per hour' end, case when i = 1 then 1000 end, case when i = 1 then 2500 end, case when i = 1 then 1500 end, 'active', wme);
  end loop;
  insert into pulse.goal(org_id, level, title, owner_person_id, status, done_at, created_by) values (ws, 'person', 'Fake achievement: built a company OS in five weeks', wme, 'done', now(), wme);
  for i in 1 .. array_length(names, 1) loop
    insert into pulse.project(org_id, registry_no, name, title, kind, status) values (ws, i, names[i], names[i], 'internal', 'active') returning id into pid;
    update pulse.work_project set owner_id = wme, summary = case when i = 1 then 'Fake idea: tell the story of what one person and his agents built, one post a week, from real achievements.' end where project_id = pid;
    select id into g from pulse.goal where org_id = ws and status = 'active' order by title offset (i - 1) % 3 limit 1;
    insert into pulse.goal_link(org_id, goal_id, project_id, added_by) values (ws, g, pid, wme);
  end loop;
  for i in 1 .. 60 loop
    select project_id into pid from pulse.work_project where org_id = ws order by project_id offset (i % 5) limit 1;
    insert into pulse.task(org_id, title, status, project_id, assignee_person_id, owner_id, created_by, created_at, due_at, priority, source)
    values (ws, case when i = 7 then 'Fake achievement A10: one Pulse at fake.example for every company' when i % 4 = 0 then format('Fake content C%s: a post about the fake build', i) else format('Fake task %s for the walk', i) end,
      case when i % 9 = 0 then 'done' when i % 11 = 0 then 'in_progress' else 'open' end, pid, wme, wme, wme, now() - interval '3 days',
      case when i % 3 = 0 then null else (current_date + (i % 15) - 4)::timestamptz end, case when i % 10 = 0 then 'high' else 'normal' end, 'pulse')
    returning id into t;
  end loop;
  perform set_config('pulse.org_id', '', true); perform set_config('pulse.viewer_id', '', true);
end $s$;
commit;
