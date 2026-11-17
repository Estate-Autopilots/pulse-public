-- migrate:up
alter table pulse.hr_policy add column attendance_enabled boolean not null default false;

-- Keep office presence collection available while withholding every attendance effect until the tenant opts in.
do $$
declare
  definition text;
  changed text;
  query_text text := 'select * into e from attendance_effective where person_id=r.person_id and voided_at is null and checked_out_at is null order by checked_in_at desc limit 1;';
begin
  definition := pg_get_functiondef('pulse.companion_presence_tick(uuid)'::regprocedure);
  if position(query_text in definition) = 0 then raise exception 'companion_presence_tick attendance query changed'; end if;
  changed := replace(definition, query_text, 'if pol.attendance_enabled then ' || query_text || ' end if;');
  changed := replace(changed,
    'if e.id is null and (pol.presence_auto_checkin or exists(select 1 from presence_office where id=r.office_id and audience is not null))',
    'if pol.attendance_enabled and e.id is null and (pol.presence_auto_checkin or exists(select 1 from presence_office where id=r.office_id and audience is not null))');
  changed := replace(changed,
    'if e.id is not null and e.mode=''office'' and r.left_at is not null then',
    'if pol.attendance_enabled and e.id is not null and e.mode=''office'' and r.left_at is not null then');
  changed := replace(changed,
    '''checkedIn'',checked is not null or e.id is not null,''correctionId'',r.correction_id',
    '''checkedIn'',pol.attendance_enabled and (checked is not null or e.id is not null),''correctionId'',case when pol.attendance_enabled then r.correction_id else null end');
  if changed = definition or position('if pol.attendance_enabled then ' || query_text || ' end if;' in changed) = 0
    or position('if pol.attendance_enabled and e.id is null and (pol.presence_auto_checkin' in changed) = 0
    or position('if pol.attendance_enabled and e.id is not null' in changed) = 0
    or position('pol.attendance_enabled and (checked is not null or e.id is not null)' in changed) = 0 then
    raise exception 'attendance gate could not update companion_presence_tick';
  end if;
  execute changed;
end $$;

-- migrate:down
do $$
declare
  definition text;
  changed text;
  query_text text := 'select * into e from attendance_effective where person_id=r.person_id and voided_at is null and checked_out_at is null order by checked_in_at desc limit 1;';
begin
  definition := pg_get_functiondef('pulse.companion_presence_tick(uuid)'::regprocedure);
  changed := replace(definition, 'if pol.attendance_enabled then ' || query_text || ' end if;', query_text);
  changed := replace(changed,
    'if pol.attendance_enabled and e.id is null and (pol.presence_auto_checkin or exists(select 1 from presence_office where id=r.office_id and audience is not null))',
    'if e.id is null and (pol.presence_auto_checkin or exists(select 1 from presence_office where id=r.office_id and audience is not null))');
  changed := replace(changed,
    'if pol.attendance_enabled and e.id is not null and e.mode=''office'' and r.left_at is not null then',
    'if e.id is not null and e.mode=''office'' and r.left_at is not null then');
  changed := replace(changed,
    '''checkedIn'',pol.attendance_enabled and (checked is not null or e.id is not null),''correctionId'',case when pol.attendance_enabled then r.correction_id else null end',
    '''checkedIn'',checked is not null or e.id is not null,''correctionId'',r.correction_id');
  execute changed;
end $$;
alter table pulse.hr_policy drop column attendance_enabled;
