-- migrate:up
-- EST-697 (EST-553 part 1): the HR, presence, finance and task functions count days in the company's own time zone
-- (pulse.org.time_zone) instead of India's, so a company in London gets London days for leave, attendance and due
-- dates. EA's zone stays Asia/Kolkata, so its days do not move. Every function is patched in place
-- (pg_get_functiondef + replace), never rewritten, so other in-place edits (EST-647's module switch on
-- companion_presence_tick) survive in either order.
create function pulse.org_time_zone(p_org uuid default pulse.current_org()) returns text language sql stable
as $$ select coalesce((select o.time_zone from pulse.org o where o.id = p_org), 'UTC') $$;
comment on function pulse.org_time_zone(uuid) is
  'The company''s time zone (pulse.org.time_zone); UTC when no company is in scope (a worker before set_tenant).';
revoke all on function pulse.org_time_zone(uuid) from public;
grant execute on function pulse.org_time_zone(uuid) to pulse_api, pulse_worker;

do $$
declare
  kolkata constant text := '''Asia/Kolkata''';
  expected constant regprocedure[] := array[
    'pulse.accountant_grant(uuid,date,boolean)', 'pulse.attendance_reminders_set(boolean,integer,integer)',
    'pulse.companion_presence_tick(uuid)', 'pulse.fair_publish(uuid,text)', 'pulse.finance_desk_authorize(boolean)',
    'pulse.finance_desk_snapshot(timestamptz)', 'pulse.hr_balance_legacy(uuid,text,date,uuid,boolean)',
    'pulse.hr_balance_rule(uuid,text,date,jsonb,date,uuid)', 'pulse.hr_emergency_notify(date,date,text)',
    'pulse.hr_emergency_remind()', 'pulse.hr_flow_decide(uuid,text,text)', 'pulse.hr_flow_source()',
    'pulse.hr_leave_remaining(uuid,text,uuid)', 'pulse.hr_pattern_set(uuid,integer[],date,date,text)',
    'pulse.hr_rule_confirm(text,jsonb,date,integer,text)', 'pulse.hr_rule_days(uuid,date,date)',
    'pulse.hr_rule_validate(text,jsonb)', 'pulse.hr_special_route()', 'pulse.hr_work_request(date,text)',
    'pulse.notification_ping_allowed(uuid,text,text,timestamptz)', 'pulse.onboarding_nudge(uuid,text)',
    'pulse.onboarding_tick(timestamptz)', 'pulse.presence_of(uuid[])', 'pulse.task_due_from(jsonb)',
    'pulse.task_tracker_normalise()', 'pulse.work_template_apply(uuid,text)']::regprocedure[];
  fn regprocedure;
  e record;
  def text;
begin
  foreach fn in array expected loop
    if strpos(pg_get_functiondef(fn), kolkata) = 0 then raise exception '0179: % no longer names Asia/Kolkata', fn; end if;
  end loop;
  -- A function working on one company's row uses that row's company: the presence tick's device row, the HR flow
  -- triggers' new row, the emergency reminder's overdue record.
  for e in select * from (values
    ('pulse.companion_presence_tick(uuid)', kolkata, 'pulse.org_time_zone(r.org_id)'),
    ('pulse.hr_flow_source()', kolkata, 'pulse.org_time_zone(new.org_id)'),
    ('pulse.hr_special_route()', kolkata, 'pulse.org_time_zone(new.org_id)'),
    ('pulse.hr_emergency_remind()', 'where record_by<(now() at time zone ''Asia/Kolkata'')::date',
     'where record_by<(now() at time zone pulse.org_time_zone(org_id))::date')) v(fn, old, new) loop
    def := pg_get_functiondef(e.fn::regprocedure);
    if strpos(def, e.old) = 0 then raise exception '0179: % no longer contains %', e.fn, e.old; end if;
    execute replace(def, e.old, e.new);
  end loop;
  -- Everything else runs for the signed-in or set_tenant company. The loop also catches functions added since.
  for fn in select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'pulse'::regnamespace and p.prokind in ('f', 'p') and p.prosrc like '%Asia/Kolkata%' loop
    execute replace(pg_get_functiondef(fn), kolkata, 'pulse.org_time_zone()');
  end loop;
  if exists (select 1 from pg_proc where pronamespace = 'pulse'::regnamespace and prosrc like '%Asia/Kolkata%') then
    raise exception '0179: a pulse function still names Asia/Kolkata';
  end if;
end $$;

-- migrate:down
-- Forward-only.
