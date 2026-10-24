-- migrate:up
-- Current office evidence only, replaced in place; never coordinates or an event/history table.
alter table pulse.presence_office add column public_ip_ranges cidr[] not null default '{}';
alter table pulse.hr_policy add column presence_dwell_minutes int not null default 3 check(presence_dwell_minutes between 1 and 30),
 add column presence_leave_minutes int not null default 15 check(presence_leave_minutes between 1 and 120);
create table pulse.companion_presence (
 org_id uuid not null references pulse.org(id), device_id uuid primary key references pulse.native_device(id),
 person_id uuid not null references pulse.person(id), office_id uuid references pulse.presence_office(id),
 consent boolean not null default false, auto_consent boolean not null default false,
 region_inside boolean not null default false, region_at timestamptz,
 wifi_strength int not null default 0 check(wifi_strength in(0,10,40)), wifi_at timestamptz,
 ip_matched boolean not null default false, ip_at timestamptz,
 dwell_started_at timestamptz, last_present_at timestamptz, left_at timestamptz,
 reminder_at timestamptz, correction_id uuid references pulse.attendance_regularisation(id),
 checked_entry_id uuid references pulse.attendance_entry(id), updated_at timestamptz not null default now()
);
alter table pulse.companion_presence enable row level security;
alter table pulse.companion_presence force row level security;
create policy tenant_isolation on pulse.companion_presence using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy self_only on pulse.companion_presence as restrictive to pulse_api using(person_id=pulse.current_viewer()) with check(person_id=pulse.current_viewer());
grant select,insert,update on pulse.companion_presence to pulse_api;
grant select on pulse.companion_presence to pulse_worker;

-- Used by device updates and the scheduled worker; all decisions use server time and authorized device state.
create function pulse.companion_presence_tick(p_device uuid default null) returns jsonb language plpgsql security definer
set search_path=pulse,pg_temp as $$
declare r companion_presence; pol hr_policy; e attendance_entry; score int; holding boolean; stamp timestamptz:=now();
 result jsonb:='{}'; days int[]; shift_start time; shift_end time; grace int; target_day date;
 start_at timestamptz; end_at timestamptz; checked uuid; correction uuid; viewer text:=current_setting('pulse.viewer_id',true);
begin
 if p_device is null and not pg_has_role(session_user,'pulse_worker','member') then raise exception 'Worker scope required' using errcode='42501';end if;
 select * into pol from hr_policy where org_id=current_org();
 if not found then return result;end if;
 for r in select s.* from companion_presence s join native_device d on d.id=s.device_id
 where s.org_id=current_org() and s.consent and d.revoked_at is null and d.person_id=s.person_id and d.org_id=s.org_id
 and exists(select 1 from person where id=s.person_id and status='active')
 and not exists(select 1 from login_credential where person_id=s.person_id and (must_change or status<>'active')) and (p_device is null or s.device_id=p_device)
 and (p_device is null or s.person_id=current_viewer()) for update of s skip locked loop
  perform set_config('pulse.viewer_id',r.person_id::text,true);
  perform pg_advisory_xact_lock(hashtextextended(r.person_id::text,37));
  if r.office_id is null or not exists(select 1 from presence_office where id=r.office_id and active) then continue;end if;
  score:=case when r.region_inside and r.region_at>stamp-interval '12 hours' then 45 else 0 end
   +case when r.wifi_at>stamp-interval '10 minutes' then r.wifi_strength else 0 end
   +case when r.ip_matched and r.ip_at>stamp-interval '10 minutes' then 35 else 0 end;
  holding:=score>=35 and (r.region_inside and r.region_at>stamp-interval '12 hours' or r.wifi_strength=40 and r.wifi_at>stamp-interval '10 minutes' or r.ip_matched and r.ip_at>stamp-interval '10 minutes');
  r.dwell_started_at:=case when score>=65 then coalesce(r.dwell_started_at,stamp) else null end;
  r.last_present_at:=case when holding then stamp else r.last_present_at end;
  r.left_at:=case when holding then null when r.last_present_at is not null then coalesce(r.left_at,stamp) else null end;
  select * into e from attendance_entry where person_id=r.person_id and voided_at is null and checked_out_at is null order by checked_in_at desc limit 1;
  if e.id is not null and r.checked_entry_id is distinct from e.id then r.checked_entry_id:=e.id;r.correction_id:=null;r.reminder_at:=null;end if;
  if e.id is null and pol.presence_auto_checkin and r.auto_consent and score>=65 and r.dwell_started_at<=stamp-make_interval(mins=>pol.presence_dwell_minutes) then
   target_day:=(stamp at time zone 'Asia/Kolkata')::date;shift_start:=pol.shift_start;shift_end:=pol.shift_end;grace:=pol.grace_minutes;days:=pol.work_days;
   select s.start_time,s.end_time,s.grace_minutes,s.work_days into shift_start,shift_end,grace,days from person_shift a join shift s on s.id=a.shift_id
    where a.person_id=r.person_id and a.mode='office' and a.valid_from<=target_day and (a.valid_to is null or a.valid_to>=target_day) order by a.valid_from desc limit 1;
   if not found then shift_start:=pol.shift_start;shift_end:=pol.shift_end;grace:=pol.grace_minutes;days:=pol.work_days;end if;
   if shift_end<=shift_start and (stamp at time zone 'Asia/Kolkata')::time<shift_end then target_day:=target_day-1;end if;
   start_at:=(target_day+shift_start) at time zone 'Asia/Kolkata';
   end_at:=(target_day+shift_end+case when shift_end<=shift_start then interval '1 day' else interval '0' end) at time zone 'Asia/Kolkata';
   if stamp between start_at-interval '1 hour' and end_at and hr_working(r.person_id,target_day,days)
    and not exists(select 1 from leave_request where person_id=r.person_id and status='approved' and half_day is null and target_day between from_date and to_date)
    and not exists(select 1 from attendance_entry where person_id=r.person_id and work_date=target_day and voided_at is null)
    and exists(select 1 from person where id=r.person_id and status='active') then
     insert into attendance_entry(org_id,person_id,work_date,mode,checked_in_at,late_minutes,client)
     values(r.org_id,r.person_id,target_day,'office',stamp,case when stamp>start_at+make_interval(mins=>grace) then greatest(0,floor(extract(epoch from stamp-start_at)/60))::int else 0 end,
      jsonb_build_object('via','mobile','trigger','auto','device',r.device_id,'place',jsonb_build_object('kind','office','id',r.office_id,'signal','triangulated'),'confidence',least(100,score),'dwellMinutes',pol.presence_dwell_minutes))
     on conflict(org_id,person_id) where checked_out_at is null do nothing returning id into checked;
     if checked is not null then
      r.checked_entry_id:=checked;r.correction_id:=null;r.reminder_at:=null;
      insert into notification(org_id,person_id,title,href) values(r.org_id,r.person_id,'You’re checked in · office presence confirmed','/me');
     end if;
   end if;
  end if;
  if e.id is not null and e.mode='office' and r.left_at is not null then
   if r.reminder_at is null then
    insert into notification(org_id,person_id,title,href) values(r.org_id,r.person_id,'Leaving for the day? Check out when you finish.','/me');r.reminder_at:=stamp;
   end if;
   if r.correction_id is null and r.left_at<=stamp-make_interval(mins=>pol.presence_leave_minutes)
    and not exists(select 1 from attendance_regularisation where person_id=r.person_id and work_date=e.work_date and kind='missed_punch' and status='pending') then
    insert into attendance_regularisation(org_id,person_id,work_date,kind,out_time,reason)
    values(r.org_id,r.person_id,e.work_date,'missed_punch',(greatest(r.last_present_at,e.checked_in_at) at time zone 'Asia/Kolkata')::time,
     'Auto check-out at last presence — needs confirmation. Confirm the proposed time or ask HR to correct it.') returning id into correction;
    r.correction_id:=correction;
   end if;
  end if;
  update companion_presence set dwell_started_at=r.dwell_started_at,last_present_at=r.last_present_at,left_at=r.left_at,
   reminder_at=r.reminder_at,correction_id=r.correction_id,checked_entry_id=r.checked_entry_id where device_id=r.device_id;
  if p_device=r.device_id then result:=jsonb_build_object('score',least(100,score),'dwellStartedAt',r.dwell_started_at,'lastPresenceAt',r.last_present_at,'leftAt',r.left_at,
   'checkedIn',checked is not null or e.id is not null,'correctionId',r.correction_id,'dwellMinutes',pol.presence_dwell_minutes);end if;
  checked:=null;
 end loop;
 perform set_config('pulse.viewer_id',coalesce(viewer,''),true);
 return result;
end $$;
revoke all on function pulse.companion_presence_tick(uuid) from public;
grant execute on function pulse.companion_presence_tick(uuid) to pulse_api,pulse_worker;
-- migrate:down
 drop function if exists pulse.companion_presence_tick(uuid);
 drop table if exists pulse.companion_presence;
 alter table pulse.hr_policy drop column if exists presence_dwell_minutes,drop column if exists presence_leave_minutes;
 alter table pulse.presence_office drop column if exists public_ip_ranges;
