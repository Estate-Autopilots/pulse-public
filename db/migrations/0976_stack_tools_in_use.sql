-- migrate:up
-- PULSE-HQ (owner, 23 Oct 2026): Stack Intelligence (0973, 0974) marks the tools Pulse already runs on as adopted, so
-- "Adopted now" and "Adopted + on trial" in the budget show what Pulse really uses, not only the production box.
--   GitHub Actions on public repos       pulse-ci runs the full gate on the public mirror (23 Oct 2026)
--   Playwright + scrcpy + Android emulator   the end-to-end and screenshot journeys run on them
-- Only in the Pulse organisation (@pulsehq), and only while a tool still has the status 0974 gave it (idea). Plain SQL
-- over pulse.stack_tool (0973). Safe on a live install.
do $$
declare v_org uuid;
begin
  select id into v_org from pulse.org where handle = 'pulsehq';
  if v_org is null then return; end if;
  perform set_config('pulse.org_id', v_org::text, true);

  update pulse.stack_tool set status = 'adopted', updated_at = now()
   where org_id = v_org and status = 'idea'
     and lower(name) in (lower('GitHub Actions on public repos'), lower('Playwright + scrcpy + Android emulator'));

  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
-- The tools stay with the organisation (their status is changed in Stack Intelligence).
