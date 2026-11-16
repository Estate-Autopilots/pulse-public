-- migrate:up
-- UX-5B: the value algorithm's size, calibrated per company. Estimates run short (the planning fallacy); how long
-- estimated work here really took is the median of captured ÷ estimated minutes over tasks finished in 180 days with
-- at least ten confirmed minutes. Pip corrects an estimate by it, pulled toward no correction while there are few
-- tasks (services/api/src/ai/task-scorer.ts; docs/ops/VALUE.md).
create function pulse.work_estimate_calibration() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('n',count(*)::int,'ratio',round((percentile_cont(0.5) within group (order by actual::numeric/est))::numeric,2))
 from (select t.estimate_minutes est,(select sum(e.minutes) from time_entry e where e.task_id=t.id and e.status='confirmed' and e.retired_at is null) actual
  from task t where t.org_id=current_org() and t.deleted_at is null and t.estimate_minutes>=5 and t.status in ('done','in_review','accepted')
   and t.done_at>now()-interval '180 days') x
 where actual>=10
$$;
revoke all on function pulse.work_estimate_calibration() from public;
grant execute on function pulse.work_estimate_calibration() to pulse_api, pulse_worker;

-- migrate:down
-- Forward-only.
