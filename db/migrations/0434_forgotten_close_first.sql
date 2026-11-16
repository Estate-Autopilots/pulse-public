-- migrate:up
-- RELEASE-5: POLISH-2's forgotten check-out tick (0340) asks "Still checked in?" two hours after the shift and closes the
-- session for review the next morning. A session that is already past the morning (one left open for days before the
-- tick existed: on production, 5 sessions of 2 to 7 days and of yesterday when this was written) met both conditions in
-- the same minute, and its person got the evening question about a day long gone, then the close. The close now goes
-- first and the question only when nothing is closed; the evening question and the morning close are unchanged.
create or replace function pulse.attendance_forgotten_tick(p_at timestamptz default clock_timestamp()) returns int
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pol hr_policy; e attendance_entry; w record; prompt int; tz text:=org_time_zone(current_org()); seen timestamptz; proposed timestamptz;
 closed int:=0; viewer text:=current_setting('pulse.viewer_id',true);
begin
 if not pg_has_role(session_user,'pulse_worker','member') then raise exception 'Worker scope required' using errcode='42501';end if;
 if module_off('hr') then return 0; end if;
 select * into pol from hr_policy where org_id=current_org();
 if not found or not pol.attendance_enabled then return 0; end if;
 prompt:=coalesce((select prompt_minutes from attendance_close_policy where org_id=current_org() and approved_at is not null order by version desc limit 1),120);
 for e in select a.* from attendance_entry a join person p on p.id=a.person_id and p.status='active'
  where a.org_id=current_org() and a.checked_out_at is null and a.voided_at is null and not a.reconciled_open
  and not exists(select 1 from attendance_correction_time t where t.entry_id=a.id)
  order by a.checked_in_at for update of a skip locked loop
  perform set_config('pulse.viewer_id',e.person_id::text,true);
  select * into w from attendance_shift_window(e.person_id,e.work_date,e.mode);
  if p_at>=greatest(greatest(w.end_at,e.checked_in_at)+interval '4 hours',((e.work_date+1)+time '07:00') at time zone tz) then
   -- The last moment Pulse saw them at the office during that session (phone or laptop presence), if any.
   select max(s.last_present_at) into seen from companion_presence s where s.org_id=current_org() and s.person_id=e.person_id
    and s.last_present_at between e.checked_in_at and greatest(w.end_at,e.checked_in_at)+interval '4 hours';
   proposed:=least(p_at,coalesce(seen,case when e.checked_in_at<w.end_at then w.end_at else e.checked_in_at+interval '1 hour' end));
   insert into attendance_provisional_close(org_id,entry_id,proposed_end,reason) values(e.org_id,e.id,proposed,'day_ended') on conflict(entry_id) do nothing;
   update attendance_entry set reconciled_open=true where id=e.id;
   insert into attendance_event(org_id,person_id,work_date,at,kind,entry_id) values(e.org_id,e.person_id,e.work_date,p_at,'closed_for_review',e.id);
   perform notification_emit(e.person_id,'attendance.checkout','person',e.person_id,'closed:'||e.id,
    'You didn’t check out on '||trim(to_char(e.work_date,'Dy DD Mon'))||'. Pulse noted '||to_char(proposed at time zone tz,'HH24:MI')
    ||' for now: tell us when you left, and HR confirms it.','/me?checkout='||e.id,'attendance');
   closed:=closed+1;
  -- Asked once, two hours after the shift; never in the same minute as the close (a session left open days ago, met
  -- on the tick's first run after a release, is told only that Pulse closed it for review).
  elsif p_at>=greatest(w.end_at,e.checked_in_at)+make_interval(mins=>prompt) then
   perform notification_emit(e.person_id,'attendance.checkout','person',e.person_id,'open:'||e.id,
    'Still checked in? Check out when you finish, or tell Pulse when you left.','/me?checkout=1','attendance');
  end if;
 end loop;
 perform set_config('pulse.viewer_id',coalesce(viewer,''),true);
 return closed;
end $$;

-- migrate:down
-- Forward-only.
