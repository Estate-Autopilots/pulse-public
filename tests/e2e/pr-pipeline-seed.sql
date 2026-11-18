-- PR-PIPELINE walk: a synthetic company on a throwaway scratch database (never a real one). Run as the scratch superuser
-- after the migrations: an admin with an Access identity, a second company where the same account leads (for "Share
-- with…"), the pipeline set up for one brand, synthetic work events, one run of the pipeline and a weekly report.
\set ON_ERROR_STOP on
begin;
select set_config('pulse.org_id', '00000000-0000-4000-8000-00000000e001', true);
insert into pulse.org (id, slug, name, code, time_zone) values
  ('00000000-0000-4000-8000-00000000e001', 'example-studio-synthetic', 'Example Studio (synthetic)', 'EXS', 'Asia/Kolkata'),
  ('00000000-0000-4000-8000-00000000e002', 'example-holdings-synthetic', 'Example Holdings (synthetic)', 'EXH', 'Asia/Kolkata')
on conflict do nothing;
insert into pulse.install (id, org_id, initialised_by) values (true, '00000000-0000-4000-8000-00000000e001', 'pr-pipeline walk (synthetic)') on conflict do nothing;
insert into pulse.person (id, org_id, display_name, side) values
  ('00000000-0000-4000-8000-00000000a001', '00000000-0000-4000-8000-00000000e001', 'Asha Example', 'staff'),
  ('00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-00000000e002', 'Asha Example', 'staff'),
  ('00000000-0000-4000-8000-00000000a003', '00000000-0000-4000-8000-00000000e002', 'Ravi Example', 'staff'),
  ('00000000-0000-4000-8000-00000000a004', '00000000-0000-4000-8000-00000000e002', 'Meera Example', 'staff')
on conflict do nothing;
insert into pulse.role_assignment (org_id, person_id, role_key, valid_from) values
  ('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000a001', 'admin', '2026-01-01'),
  ('00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-00000000a002', 'admin', '2026-01-01'),
  ('00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-00000000a003', 'leadership', '2026-01-01'),
  ('00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-00000000a004', 'leadership', '2026-01-01');
insert into pulse.account (org_id, provider, handle, holder_person_id, purpose) values
  ('00000000-0000-4000-8000-00000000e001', 'google', 'asha@example.invalid', '00000000-0000-4000-8000-00000000a001', 'Workspace user');
insert into pulse_priv.pulse_account (id, handle, display_name) values ('00000000-0000-4000-8000-00000000c001', 'ashaexample', 'Asha Example') on conflict do nothing;
insert into pulse_priv.account_member (account_id, member_org, person_id, kind) values
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000a001', 'staff'),
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-00000000a002', 'staff')
on conflict do nothing;
commit;

begin;
select set_config('pulse.org_id', '00000000-0000-4000-8000-00000000e001', true), set_config('pulse.viewer_id', '00000000-0000-4000-8000-00000000a001', true);
select pulse.pr_brand_setup('{"name":"Example Studio","kind":"company","industry":"software","byline":"Synthetic brand for the walk",
  "kit":{"bg":"#0E2A2F","fg":"#EEF2F1","accent":"#FF8D8A"},"postsPerWeek":3}'::jsonb);
select pulse.pr_pipeline_set('{"reportPersonId":"00000000-0000-4000-8000-00000000a001","aiAssist":false}'::jsonb);
select pulse.pr_work_ingest(jsonb_agg(e)) from (
  select jsonb_build_object('source', 'commit', 'key', 'git:exmp' || lpad(i::text, 4, '0'), 'at', (now() - interval '8 days' + i * interval '3 hours')::text,
    'title', 'EXAMPLE-LANE: synthetic change number ' || i, 'proof', 'git:exmp' || lpad(i::text, 4, '0'), 'repo', 'example-repo', 'topic', 'lane:EXAMPLE-LANE',
    'actor', 'Synthetic Bot', 'person', '00000000-0000-4000-8000-00000000a001') e from generate_series(1, 9) i
  union all select jsonb_build_object('source', 'lane_report', 'key', 'report:EXAMPLE-LANE:DONE', 'at', (now() - interval '6 days')::text,
    'title', 'Example lane done: clients can now book a synthetic demo from their phone', 'detail', 'DONE synthetic', 'proof', '/pr?tab=pipeline', 'topic', 'lane:EXAMPLE-LANE',
    'status', 'DONE', 'person', '00000000-0000-4000-8000-00000000a001')
  union all select jsonb_build_object('source', 'release', 'key', 'release:exmp-0.0.7', 'at', (now() - interval '5 days')::text, 'title', 'Example app v0.0.7: faster search',
    'proof', 'https://example.com/releases/0.0.7', 'topic', 'release:v0.0.7', 'person', '00000000-0000-4000-8000-00000000a001')
  union all select jsonb_build_object('source', 'outcome', 'key', 'outcome:exmp-1', 'at', (now() - interval '4 days')::text, 'title', 'Approved by the client: synthetic launch film',
    'proof', '/clients', 'topic', 'client:exmp', 'client', 'Example Client Co')
) x;
select pulse.pr_pipeline_tick(true);
select pulse.pr_weekly_report(true);
commit;
