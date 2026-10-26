-- migrate:up
-- PULSE-HQ (owner, 23 Oct 2026): three of the founder's ideas of 23 Oct (0974) say what was decided later that day.
--   CI          the full gate now runs on the public mirror (pulse-ci) on GitHub's free runners for public repositories;
--               self-hosted runners and a dedicated-core box are the next step, not the first.
--   Servers     why the current box slows down (Hostinger's CPU credits since 1 Oct 2026) and where each workload goes:
--               production and staging on a stable server; CI, AI agents and dev on a dedicated-core box (Netcup).
--   Monitoring  the title names PostHog beside Sentry.
-- Only in the Pulse organisation (@pulsehq), and only while an idea still has the title 0974 gave it (an idea the
-- founder has since renamed is left alone). Plain SQL over pulse.hq_idea (0944, 0973). Safe on a live install.
do $$
declare v_org uuid;
begin
  select id into v_org from pulse.org where handle = 'pulsehq';
  if v_org is null then return; end if;
  perform set_config('pulse.org_id', v_org::text, true);

  update pulse.hq_idea set title = 'Self-hosted CI: pulse-ci on the public mirror, then own runners',
    problem = 'Builds, tests and agents ran on the production box, burned its CPU credits and got throttled to 30%, and the private repository has no Actions minutes, so CI and production both slowed down.',
    details = E'Now (23 Oct 2026): pulse-ci exports each tested commit through the leak gate to the public mirror and runs the full ci.yml there on GitHub''s free runners for public repositories (Ubuntu 24.04 and Windows). Production ships only builds that pass it.\nNext: self-hosted ephemeral runners on the dedicated-core CI box (Netcup RS 1000), Oracle Cloud Always Free (Ampere A1, 2 OCPU / 12 GB) as a free overflow box, Blacksmith''s free minutes for heavy Docker jobs, and a Turborepo remote cache backed by R2. Production keeps its box.',
    updated_at = now()
   where org_id = v_org and title = 'Self-hosted CI runners on free or cheap ARM';

  update pulse.hq_idea set title = 'Production and staging on a stable server; CI and agents on a dedicated-CPU box',
    details = E'Why the box slows down: since 1 Oct 2026 Hostinger VPS plans run on CPU credits. The baseline is 60% of the allocated CPU; a full balance lasts about 3 hours at 100%, then a KVM 4 or KVM 8 is capped at 30% (about 1.2 cores on a KVM 4). Builds, test suites and agent loops run at 100% for hours and drain the credits, so every customer slows down. Steal time is low; the credit cap is the problem, and a bigger Hostinger plan has the same cap.\nPlan: production and staging on a stable server of their own (today the Hostinger KVM 4, whose average CPU is low once the heavy work leaves). CI, AI agents and dev builds on a dedicated-core box with no credit system: Netcup Root Server RS 1000 G12.5 (4 dedicated cores, about ₹2,400 a month) or RS 2000 (8 cores, about ₹4,500). Oracle A1 is the free secondary box. Backups off the box (Cloudflare R2). A written runbook to move again.',
    updated_at = now()
   where org_id = v_org and title = 'Move production and staging to a stable server';

  update pulse.hq_idea set title = 'Sentry and PostHog across web, API and mobile', updated_at = now()
   where org_id = v_org and title = 'Sentry error and session replay across web, API and mobile';

  perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
-- The ideas stay with the organisation (they are edited and removed in Pulse HQ).
