-- migrate:up
-- PULSE-BUGS (Estate Autopilots bug #5, owner, 28 Oct 2026: "I am worried if we are receiving the bugs from all
-- members"; answered 20 Nov 2026). The Pulse dev board (1708: every company's reports summarised in the Pulse dev
-- organisation's inbox) has received each report since its trigger came on, 9 Nov. Reports filed before then never
-- reached it; on production 5 are still open (Estate Autopilots #2, #4, #5, #12 and Agent Lab #1), so the dev team's
-- board did not show them.
--   pulse.dev_bug_inbox_backfill()  routes every still-open report (new, triaged, fixing) that has no inbox row, with the
--                                   same summary as reported_bug_route() (no words, pictures, errors, names or contacts)
--                                   and its current status. Closed reports and the dev organisation's own stay as they
--                                   are. It adds only what is missing, so running it again changes nothing. Install-level
--                                   and owner-only, like the dev board setting (no runtime grants); run once below.
create function pulse.dev_bug_inbox_backfill() returns integer
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_dev uuid := dev_board_org(); v_back text := coalesce(current_setting('pulse.org_id', true), '');
  o uuid; v_name text; v_ids uuid[]; v_id uuid; r reported_bug; n integer := 0; k integer;
begin
  if v_dev is null then return 0; end if;
  for o in select * from list_active_orgs() loop
    continue when o = v_dev;
    -- Read as the reporting company (row security), the ids first: the loop below moves between the two companies.
    perform set_config('pulse.org_id', o::text, true);
    select g.name into v_name from org g where g.id = o;
    select coalesce(array_agg(b.id order by b.number), '{}') into v_ids from reported_bug b
     where b.org_id = o and b.status in ('new', 'triaged', 'fixing');
    foreach v_id in array v_ids loop
      perform set_config('pulse.org_id', o::text, true);
      select * into r from reported_bug b where b.id = v_id;
      perform set_config('pulse.org_id', v_dev::text, true);
      insert into dev_bug_inbox (org_id, source_org, source_org_name, source_report, source_number, kind, title, route, severity, blocks_work,
          platform, app_version, browser, os, signed_out, by_agent, error_count, call_count, step_count, reported_at, status, status_at)
      values (v_dev, o, left(coalesce(nullif(btrim(v_name), ''), 'A company'), 200), r.id, r.number, coalesce(r.kind, 'bug'),
          dev_bug_title(r.kind, r.title, r.route), left(r.route, 300), r.severity, r.blocks_work, r.platform, r.app_version,
          nullif(left(r.context ->> 'browser', 40), ''), nullif(left(r.context ->> 'os', 40), ''), r.signed_out, coalesce(r.by_agent, false),
          jsonb_array_length(r.errors), jsonb_array_length(r.network), jsonb_array_length(r.trail), r.created_at, r.status, coalesce(r.status_at, now()))
      on conflict (source_report) do nothing;
      get diagnostics k = row_count;
      n := n + k;
    end loop;
  end loop;
  perform set_config('pulse.org_id', v_back, true);
  return n;
end $$;
revoke all on function pulse.dev_bug_inbox_backfill() from public;

select pulse.dev_bug_inbox_backfill();

-- migrate:down
-- The routed summaries stay (they mirror reports that exist); only the function goes.
drop function if exists pulse.dev_bug_inbox_backfill();
