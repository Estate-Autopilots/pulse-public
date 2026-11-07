-- migrate:up
-- RELEASE-3: the functions dev/live added beside EST-697 (0179) count days in the company's own time zone too, so no
-- pulse function names India any more (tests/core/test_org_time_zone.py) and both orders end the same: production
-- applied 0179 before 0157-0165 (a scheduled train on 11 Oct), a fresh database applies it between them, and 0184,
-- 0190, 0211, 0241 and 0260 come after it in either. EA's zone is Asia/Kolkata, so EA's days do not move.
-- Like 0179, every function is patched in place (pg_get_functiondef + replace), never rewritten. The work-credit
-- trigger uses its row's company; everything else runs for the signed-in or set_tenant company (the worker's
-- workflow, onboarding and reminder ticks run once per company).
do $$
declare
  kolkata constant text := '''Asia/Kolkata''';
  fn regprocedure;
  def text;
  changed text;
begin
  -- UX-TENANT's company check warned that daily figures stay in India time; they follow the company's zone now.
  def := pg_get_functiondef('pulse.tenant_company_check(uuid,jsonb)'::regprocedure);
  changed := replace(replace(def,
    '''["Choose a time zone such as Asia/Kolkata"]''', '''["Choose the company''''s time zone (its IANA name, such as Europe/London)"]'''),
    'elsif v_tz <> ''Asia/Kolkata'' then v_warnings := v_warnings || ''["Some daily figures (attendance days, due dates) are still counted in India time; a company outside India needs that work first (R51)"]''; end if;',
    'end if;');
  if strpos(changed, kolkata) > 0 or changed = def then raise exception '0299: tenant_company_check changed shape'; end if;
  execute changed;
  -- The work-credit trigger (0184) credits the day in its row's company.
  def := pg_get_functiondef('pulse.task_credit_follow()'::regprocedure);
  changed := replace(replace(def, kolkata, 'pulse.org_time_zone(new.org_id)'), 'pulse.org_time_zone()', 'pulse.org_time_zone(new.org_id)');
  if changed <> def then execute changed; end if;
  for fn in select p.oid::regprocedure from pg_proc p
    where p.pronamespace = 'pulse'::regnamespace and p.prokind in ('f', 'p') and p.prosrc like '%Asia/Kolkata%' loop
    execute replace(pg_get_functiondef(fn), kolkata, 'pulse.org_time_zone()');
  end loop;
  if exists (select 1 from pg_proc where pronamespace = 'pulse'::regnamespace and prosrc like '%Asia/Kolkata%') then
    raise exception '0299: a pulse function still names Asia/Kolkata';
  end if;
end $$;

-- ERP's own dates (0190) default to the company's day as well.
alter table pulse.erp_stock_move alter column on_date set default ((now() at time zone pulse.org_time_zone())::date);
alter table pulse.erp_document alter column issue_date set default ((now() at time zone pulse.org_time_zone())::date);

-- migrate:down
-- Forward-only.
