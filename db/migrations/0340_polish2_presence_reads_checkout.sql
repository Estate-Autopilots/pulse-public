-- migrate:up
-- POLISH-2 (QA-E2E's P1s, 12 Oct 2026).
--
-- 1. "Check in?" is not held back by a scheduled reminder. Arriving minutes after "Ready to check in?" recorded the
--    arrival but sent nothing (15-minute spacing), and never asked later that day (the arrival is recorded once).
--    Arriving is the moment the question is useful: it now goes out unless the person dismissed or snoozed the
--    check-in reminders. It still counts as a prompt, so the scheduled reminder waits 15 minutes after it.
--    (The phone's own dwell is counted by the API: services/api/src/companion-presence.ts.)
do $$
declare
  definition text := pg_get_functiondef('pulse.companion_presence_tick(uuid)'::regprocedure);
  budget text := 'if rem.prompts<2 and rem.dismissed_at is null and (rem.snoozed_until is null or rem.snoozed_until<=stamp) and (rem.last_at is null or rem.last_at<=stamp-interval ''15 minutes'') then';
  changed text;
begin
  if position(budget in definition) = 0 then raise exception 'companion_presence_tick arrival budget changed'; end if;
  changed := replace(definition, budget, 'if rem.dismissed_at is null and (rem.snoozed_until is null or rem.snoozed_until<=stamp) then');
  execute changed;
end $$;

-- 2. The laptop's automatic check-in notice is an attendance notice like the phone's (pushed, counted, opens My desk).
do $$
declare
  definition text := pg_get_functiondef('pulse.notification_contract()'::regprocedure);
  phone text := 'elsif new.title=''You’re checked in · office presence confirmed'' and new.href=''/me'' then';
begin
  if position(phone in definition) = 0 then raise exception 'notification_contract confirmed notice changed'; end if;
  execute replace(definition, phone,
    'elsif new.title in (''You’re checked in · office presence confirmed'',''You’re checked in · your laptop is at the office'') and new.href=''/me'' then');
end $$;

-- 3. "Read" and "Delivered" reach the writer live. chat_read and chat_delivered moved receipts without a chat_event,
--    so the writer's stream never asked for a refetch (live in 3 of 7 browser runs, by luck). Direct messages and
--    small groups only: in a big channel every read would make every member's Pulse refetch. Only a read or a
--    delivery that newly covers someone else's message raises an event (no event when nothing changed).
create function pulse.chat_receipt_live(p_channel uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
  select coalesce((select c.kind='direct' or (select count(*) from chat_member m where m.channel_id=c.id)<=12 from chat_channel c where c.id=p_channel),false)
$$;
revoke all on function pulse.chat_receipt_live(uuid) from public;

create or replace function pulse.chat_read(p_channel uuid,p_through timestamptz) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare before timestamptz; after timestamptz;
begin
 if not chat_has(p_channel) then raise exception 'conversation unavailable' using errcode='42501';end if;
 select read_through into before from chat_member where channel_id=p_channel and person_id=current_viewer();
 update chat_member set read_through=greatest(read_through,least(p_through,clock_timestamp()))
 where channel_id=p_channel and person_id=current_viewer() and read_through<p_through returning read_through into after;
 update notification n set read_at=coalesce(n.read_at,clock_timestamp())
 from chat_message m,chat_member cm
 where n.message_id=m.id and n.person_id=current_viewer() and n.channel_id=p_channel
 and cm.channel_id=p_channel and cm.person_id=current_viewer() and m.created_at<=cm.read_through and n.read_at is null;
 if after is not null and chat_receipt_live(p_channel) and exists(select 1 from chat_message m where m.channel_id=p_channel
  and m.author_id<>current_viewer() and m.created_at>before and m.created_at<=after) then
  insert into chat_event(org_id,channel_id) values(current_org(),p_channel);
 end if;
end $$;

create or replace function pulse.chat_delivered() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_active() then return; end if;
 with fresh as (
  insert into chat_receipt(org_id,channel_id,person_id,delivered_through)
  select cm.org_id,cm.channel_id,cm.person_id,clock_timestamp() from chat_member cm
  left join chat_receipt r on r.channel_id=cm.channel_id and r.person_id=cm.person_id
  where cm.org_id=current_org() and cm.person_id=current_viewer()
  and exists(select 1 from chat_message m where m.org_id=cm.org_id and m.channel_id=cm.channel_id and m.author_id<>cm.person_id and m.created_at>coalesce(r.delivered_through,'-infinity'))
  on conflict(channel_id,person_id) do update set delivered_through=excluded.delivered_through
  returning channel_id)
 insert into chat_event(org_id,channel_id) select current_org(),f.channel_id from fresh f where chat_receipt_live(f.channel_id);
end $$;

-- 4. Forgotten check-outs (5 of 13 production entries in a week were open across midnight). Pulse asks, then closes
--    kindly; pay data never changes without HR:
--    - two hours after the shift ended (HR's close policy prompt, default 120 minutes) a session still open gets one
--      "Still checked in?" notice;
--    - the next morning (07:00 in the company's time zone, at least four hours after the shift) a session still open
--      is closed *provisionally* at the last time Pulse saw the person at the office, else the shift's end (an hour
--      after the check-in when it came after the shift). This is the same unresolved close a next check-in already
--      makes (attendance_provisional_close, R19): the original punch stays, the day stays out of averages and
--      statistics, and nothing reaches payroll. The person is told the time Pulse noted and sends the real one as a
--      correction; HR (or the pod head) approves it. Without an answer the day waits in HR's review as a missed
--      check-out. No automatic hard close (R19's E06 stays HR's decision).
select pulse.check_values_add('pulse.notification'::regclass, 'notification_event_type_check', 'event_type', array['attendance.checkout']);
select pulse.check_values_add('pulse.attendance_event'::regclass, 'attendance_event_kind_check', 'kind', array['closed_for_review']);
alter table pulse.attendance_provisional_close drop constraint attendance_provisional_close_reason_check;
alter table pulse.attendance_provisional_close add constraint attendance_provisional_close_reason_check check(reason in ('next_check_in','day_ended'));

-- The shift a session belongs to: the person's shift for that mode (office when none), else HR's default shift.
create function pulse.attendance_shift_window(p_person uuid,p_day date,p_mode text,out start_at timestamptz,out end_at timestamptz)
language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare tz text:=org_time_zone(current_org()); s time; e time;
begin
 select x.start_time,x.end_time into s,e from person_shift a join shift x on x.id=a.shift_id
  where a.org_id=current_org() and a.person_id=p_person and a.valid_from<=p_day and (a.valid_to is null or a.valid_to>=p_day)
  order by (a.mode=coalesce(p_mode,'office')) desc,(a.mode='office') desc,a.valid_from desc limit 1;
 if s is null then select shift_start,shift_end into s,e from hr_policy where org_id=current_org(); end if;
 s:=coalesce(s,time '10:00'); e:=coalesce(e,time '19:00');
 start_at:=(p_day+s) at time zone tz;
 end_at:=(p_day+e+case when e<=s then interval '1 day' else interval '0' end) at time zone tz;
end $$;
revoke all on function pulse.attendance_shift_window(uuid,date,text) from public;

create function pulse.attendance_forgotten_tick(p_at timestamptz default clock_timestamp()) returns int
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
  if p_at>=greatest(w.end_at,e.checked_in_at)+make_interval(mins=>prompt) then
   perform notification_emit(e.person_id,'attendance.checkout','person',e.person_id,'open:'||e.id,
    'Still checked in? Check out when you finish, or tell Pulse when you left.','/me?checkout=1','attendance');
  end if;
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
  end if;
 end loop;
 perform set_config('pulse.viewer_id',coalesce(viewer,''),true);
 return closed;
end $$;
revoke all on function pulse.attendance_forgotten_tick(timestamptz) from public;
grant execute on function pulse.attendance_forgotten_tick(timestamptz) to pulse_worker;

-- migrate:down
-- Forward-only.
