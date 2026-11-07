-- migrate:up
-- PRESENCE-ONBOARD (owner, 10 Oct 2026): "Check-in and check-out are the most important thing; payroll and salary
-- are decided on that basis." Check-in made effortless on every surface, and every employee onboarded with their own
-- details and documents.
--
-- 1. HR settings: what arriving at an office does (ask "Check in?", or check in automatically when Pulse is sure;
--    check-out is never automatic), the payroll cut-off day, reminder timing, a long-break threshold and whether
--    profile reminders run.
-- 2. The person's day timeline (pulse.attendance_event): every automatic or reminded event is visible to them, and
--    "That's not right" turns any of them into a correction request (the existing HR correction flow decides).
-- 3. The presence tick learns "ask": one fresh office signal held for the dwell time asks "Check in?"; HR's automatic
--    setting, the person's own automatic consent and two signals (geofence, office Wi-Fi, office network) check in.
--    No location is stored: only which office and which kind of signal, at that moment. No journeys, no history.
-- 4. Reminders: people without an assigned shift follow the organisation's shift once HR turns reminders on; the first
--    check-in reminder can be at the start of the shift; a long break gets a gentle prompt. Same budget as before: at
--    most two per family per person per day, 15 minutes apart, snooze/dismiss quietens the family.
-- 5. Onboarding: personal and emergency details, bank details for payroll (encrypted), government ID documents,
--    agents' pre-fill proposals with their source, and HR's view of who has done what.
--
-- Government IDs. The Aadhaar (Targeted Delivery of Financial and Other Subsidies, Benefits and Services) Act 2016 and
-- UIDAI's regulations limit who may store Aadhaar numbers; the Daruhis Personal Data Protection Act 2023 and the DPDP
-- Rules 2025 require purpose limitation, minimal data, reasonable security safeguards and access only for the purpose.
--  * Aadhaar numbers are never stored. The API checks the 12 digits (Verhoeff) and passes only "XXXX XXXX 1234" here,
--    the masked form UIDAI itself issues; people are asked to upload the masked Aadhaar PDF.
--  * PAN likewise: only the last four characters are kept as text.
--  * Document files and bank details are encrypted at rest (OpenPGP symmetric, AES-256) with a per-organisation key
--    in pulse_priv.identity_key, a schema no service role can read. The API reaches them only through the functions
--    below, which check the viewer in the same transaction.
--  * Only the person and HR (the HR role, or an admin explicitly granted hr.documents.read) can see numbers or files;
--    leadership may add documents for someone but sees only "on file". Every read of
--    someone else's IDs, every file opened (the person's own too), every upload, check and removal is written to
--    privacy.access_log, which the person sees on their HR record.
--  * Purpose: employment records and statutory payroll (PF, ESI, TDS). Removing a document clears the file.
--  * Agents' proposals never carry an ID number: for an ID they can only point at a file already in Drive; the person
--    or HR confirms; nothing is published automatically.

-- ---------------------------------------------------------------------------------------------------- 1. settings
alter table pulse.hr_policy
 add column presence_ask boolean not null default true,
 add column payroll_cutoff_day int check (payroll_cutoff_day between 1 and 28),
 add column onboarding_reminders boolean not null default false;
alter table pulse.notification_reminder_policy
 add column start_offset_minutes int not null default 15 check (start_offset_minutes between 0 and 60),
 add column long_break_minutes int not null default 60 check (long_break_minutes between 15 and 240),
 add column fallback_shift boolean not null default false;
alter table pulse.notification_reminder drop constraint notification_reminder_family_check,
 add constraint notification_reminder_family_check check (family in ('checkin','checkout','break'));
alter table pulse.companion_presence add column holding_since timestamptz;

alter table pulse.notification drop constraint notification_event_type_check;
alter table pulse.notification add constraint notification_event_type_check check(event_type in ('update.self','chat.message','chat.mention','chat.reply','policy.published','holiday.announced',
 'task.assigned','task.blocked','task.unblocked','task.due_soon','task.done','task.accepted','task.ask','project.ask','ask.answered',
 'task.mention','project.mention','task.comment','project.comment','project.added','task.update',
 'leave.decision','request.updated','request.decision','approval.waiting','approval.reminder',
 'payroll.processed','attendance.start','attendance.end','attendance.done','attendance.departure','attendance.confirmed',
 'attendance.arrival','attendance.break','attendance.nudge','profile.reminder'));

-- Profile reminders go to the person themselves, like attendance prompts.
do $$
declare definition text; changed text;
begin
 definition := pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 changed := replace(definition, 'elsif p_type like ''attendance.%'' or p_type=''update.self'' then',
  'elsif p_type like ''attendance.%'' or p_type like ''profile.%'' or p_type=''update.self'' then');
 if changed = definition then raise exception 'notification_recipient_allowed changed shape'; end if;
 execute changed;
 -- A long-break prompt is a scheduled reminder: providers deliver it only under HR's approved reminder policy.
 definition := pg_get_functiondef('pulse.notification_outbox_dispatch(uuid,uuid)'::regprocedure);
 changed := replace(definition, '(''attendance.start'',''attendance.end'',''attendance.done'',''attendance.departure'')',
  '(''attendance.start'',''attendance.end'',''attendance.done'',''attendance.departure'',''attendance.break'')');
 if changed = definition then raise exception 'notification_outbox_dispatch changed shape'; end if;
 execute changed;
end $$;

-- -------------------------------------------------------------------------------------------- 2. day timeline
create table pulse.attendance_event (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),
 work_date date not null,
 at timestamptz not null default clock_timestamp(),
 kind text not null check (kind in ('arrival_asked','auto_check_in','left_office','correction_proposed','reminder','nudge')),
 detail text check (detail is null or detail in ('start','end','done','departure','break','checkin','profile')),
 signals text[] not null default '{}' check (signals <@ array['geofence','wifi','network','schedule','hr']::text[]),
 office_id uuid references pulse.presence_office(id),
 entry_id uuid references pulse.attendance_entry(id),
 regularisation_id uuid references pulse.attendance_regularisation(id),
 device_kind text check (device_kind in ('phone','laptop','browser')),
 disputed_at timestamptz,
 dispute_id uuid references pulse.attendance_regularisation(id)
);
create index attendance_event_day on pulse.attendance_event(org_id, person_id, work_date);
alter table pulse.attendance_event enable row level security;
alter table pulse.attendance_event force row level security;
create policy tenant_isolation on pulse.attendance_event using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy own_or_hr on pulse.attendance_event as restrictive for select to pulse_api
 using (person_id = pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership'));
grant select on pulse.attendance_event to pulse_api;
grant select, insert on pulse.attendance_event to pulse_worker;

-- "That's not right": the person's correction request is linked to the event it disputes.
create function pulse.attendance_event_dispute(p_event uuid, p_regularisation uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 update attendance_event set disputed_at=clock_timestamp(), dispute_id=p_regularisation
  where org_id=current_org() and id=p_event and person_id=current_viewer()
  and exists(select 1 from attendance_regularisation r where r.org_id=current_org() and r.id=p_regularisation and r.person_id=current_viewer());
 if not found then raise exception 'Your own event and correction required' using errcode='42501'; end if;
end $$;

-- ------------------------------------------------------------------------------------- 3. presence: ask or check in
create or replace function pulse.companion_presence_tick(p_device uuid default null) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r companion_presence; pol hr_policy; e attendance_effective; score int; holding boolean; stamp timestamptz:=now();
 result jsonb:='{}'; days int[]; shift_start time; shift_end time; grace int; target_day date;
 start_at timestamptz; end_at timestamptz; checked uuid; correction uuid; viewer text:=current_setting('pulse.viewer_id',true);
 signals text[]; device text; eligible boolean; auto_ok boolean; can_auto boolean; rem notification_reminder; asked uuid; office_name text;
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
  if r.office_id is null or not exists(select 1 from presence_office where id=r.office_id and active and (audience is null or r.person_id=any(audience))) then continue;end if;
  e:=null; checked:=null; asked:=null; eligible:=false;
  score:=case when r.region_inside and r.region_at>stamp-interval '12 hours' then 45 else 0 end
   +case when r.wifi_at>stamp-interval '10 minutes' then r.wifi_strength else 0 end
   +case when r.ip_matched and r.ip_at>stamp-interval '10 minutes' then 35 else 0 end;
  holding:=score>=35 and (r.region_inside and r.region_at>stamp-interval '12 hours' or r.wifi_strength=40 and r.wifi_at>stamp-interval '10 minutes' or r.ip_matched and r.ip_at>stamp-interval '10 minutes');
  -- Which kinds of signal, never where: the office is the only place recorded.
  signals:=array_remove(array[case when r.region_inside and r.region_at>stamp-interval '12 hours' then 'geofence' end,
   case when r.wifi_strength>0 and r.wifi_at>stamp-interval '10 minutes' then 'wifi' end,
   case when r.ip_matched and r.ip_at>stamp-interval '10 minutes' then 'network' end],null);
  select case when platform in ('windows','macos') then 'laptop' when platform='chrome' then 'browser' else 'phone' end into device from native_device where id=r.device_id;
  r.dwell_started_at:=case when score>=65 then coalesce(r.dwell_started_at,stamp) else null end;
  r.holding_since:=case when holding then coalesce(r.holding_since,stamp) else null end;
  r.last_present_at:=case when holding then stamp else r.last_present_at end;
  r.left_at:=case when holding then null when r.last_present_at is not null then coalesce(r.left_at,stamp) else null end;
  if pol.attendance_enabled then select * into e from attendance_effective where person_id=r.person_id and voided_at is null and checked_out_at is null order by checked_in_at desc limit 1; end if;
  if e.id is not null and r.checked_entry_id is distinct from e.id then r.checked_entry_id:=e.id;r.correction_id:=null;r.reminder_at:=null;end if;
  if pol.attendance_enabled and e.id is null and holding then
   target_day:=(stamp at time zone 'Asia/Kolkata')::date;shift_start:=pol.shift_start;shift_end:=pol.shift_end;grace:=pol.grace_minutes;days:=pol.work_days;
   select s.start_time,s.end_time,s.grace_minutes,s.work_days into shift_start,shift_end,grace,days from person_shift a join shift s on s.id=a.shift_id
    where a.person_id=r.person_id and a.mode='office' and a.valid_from<=target_day and (a.valid_to is null or a.valid_to>=target_day) order by a.valid_from desc limit 1;
   if not found then shift_start:=pol.shift_start;shift_end:=pol.shift_end;grace:=pol.grace_minutes;days:=pol.work_days;end if;
   if shift_end<=shift_start and (stamp at time zone 'Asia/Kolkata')::time<shift_end then target_day:=target_day-1;end if;
   start_at:=(target_day+shift_start) at time zone 'Asia/Kolkata';
   end_at:=(target_day+shift_end+case when shift_end<=shift_start then interval '1 day' else interval '0' end) at time zone 'Asia/Kolkata';
   eligible:=stamp between start_at-interval '1 hour' and end_at and hr_working(r.person_id,target_day,days)
    and not exists(select 1 from leave_request where person_id=r.person_id and status='approved' and half_day is null and target_day between from_date and to_date)
    and not exists(select 1 from attendance_entry where person_id=r.person_id and work_date=target_day and voided_at is null)
    and exists(select 1 from person where id=r.person_id and status='active');
  end if;
  -- Automatic only when HR allows it, the person agreed to it and two kinds of signal held through the dwell.
  auto_ok:=(pol.presence_auto_checkin or exists(select 1 from presence_office where id=r.office_id and audience is not null)) and r.auto_consent;
  can_auto:=auto_ok and score>=65 and r.dwell_started_at<=stamp-make_interval(mins=>pol.presence_dwell_minutes);
  if eligible and can_auto then
   insert into attendance_entry(org_id,person_id,work_date,mode,checked_in_at,late_minutes,client)
   values(r.org_id,r.person_id,target_day,'office',stamp,case when stamp>start_at+make_interval(mins=>grace) then greatest(0,floor(extract(epoch from stamp-start_at)/60))::int else 0 end,
    jsonb_build_object('via',(select case when platform in ('windows','macos') then 'desktop' when platform='chrome' then 'chrome' else 'mobile' end from native_device where id=r.device_id),'trigger','auto','device',r.device_id,'place',jsonb_build_object('kind','office','id',r.office_id,'signal','triangulated'),'confidence',least(100,score),'dwellMinutes',pol.presence_dwell_minutes))
   on conflict(org_id,person_id) where checked_out_at is null and not reconciled_open do nothing returning id into checked;
   if checked is not null then
    r.checked_entry_id:=checked;r.correction_id:=null;r.reminder_at:=null;
    insert into notification(org_id,person_id,title,href) values(r.org_id,r.person_id,case when device='laptop' then 'You’re checked in · your laptop is at the office' else 'You’re checked in · office presence confirmed' end,'/me');
    insert into attendance_event(org_id,person_id,work_date,at,kind,signals,office_id,entry_id,device_kind)
    values(r.org_id,r.person_id,target_day,stamp,'auto_check_in',signals,r.office_id,checked,device);
   end if;
  elsif eligible and pol.presence_ask and not (auto_ok and score>=65) and r.holding_since<=stamp-make_interval(mins=>pol.presence_dwell_minutes)
   and not exists(select 1 from attendance_event where person_id=r.person_id and work_date=target_day and kind='arrival_asked') then
   -- "Check in?" once a day, sharing the check-in reminder budget: snoozing or dismissing either quietens both.
   insert into notification_reminder(org_id,person_id,work_date,family) values(r.org_id,r.person_id,target_day,'checkin') on conflict do nothing;
   select * into rem from notification_reminder where org_id=r.org_id and person_id=r.person_id and work_date=target_day and family='checkin' for update;
   if rem.prompts<2 and rem.dismissed_at is null and (rem.snoozed_until is null or rem.snoozed_until<=stamp) and (rem.last_at is null or rem.last_at<=stamp-interval '15 minutes') then
    select name into office_name from presence_office where id=r.office_id;
    asked:=notification_emit(r.person_id,'attendance.arrival','person',r.person_id,rem.id||':'||(rem.prompts+1),'You’re at '||office_name||'. Check in?','/me?arrived=1','attendance');
    if asked is not null then
     update notification set expires_at=stamp+interval '2 hours' where id=asked;
     update notification_reminder set prompts=prompts+1,last_at=stamp where id=rem.id;
    end if;
   end if;
   -- Recorded even when the budget is spent, so the person's day shows what Pulse noticed.
   insert into attendance_event(org_id,person_id,work_date,at,kind,signals,office_id,device_kind)
   values(r.org_id,r.person_id,target_day,stamp,'arrival_asked',signals,r.office_id,device);
  end if;
  if pol.attendance_enabled and e.id is not null and e.mode='office' and r.left_at is not null then
   if r.reminder_at is null then
    insert into notification(org_id,person_id,title,href) values(r.org_id,r.person_id,'Leaving for the day? Check out when you finish.','/me');r.reminder_at:=stamp;
    insert into attendance_event(org_id,person_id,work_date,at,kind,office_id,entry_id,device_kind)
    values(r.org_id,r.person_id,e.work_date,stamp,'left_office',r.office_id,e.id,device);
   end if;
   -- Never a silent check-out: a forgotten one becomes a correction request at the last presence.
   if r.correction_id is null and r.left_at<=stamp-make_interval(mins=>pol.presence_leave_minutes)
    and not exists(select 1 from attendance_regularisation where person_id=r.person_id and work_date=e.work_date and kind='missed_punch' and status='pending') then
    insert into attendance_regularisation(org_id,person_id,work_date,kind,out_time,reason)
    values(r.org_id,r.person_id,e.work_date,'missed_punch',(greatest(r.last_present_at,e.checked_in_at) at time zone 'Asia/Kolkata')::time,
     'Auto check-out at last presence — needs confirmation. Confirm the proposed time or ask HR to correct it.') returning id into correction;
    r.correction_id:=correction;
    insert into attendance_event(org_id,person_id,work_date,at,kind,office_id,entry_id,regularisation_id,device_kind)
    values(r.org_id,r.person_id,e.work_date,stamp,'correction_proposed',r.office_id,e.id,correction,device);
   end if;
  end if;
  update companion_presence set dwell_started_at=r.dwell_started_at,holding_since=r.holding_since,last_present_at=r.last_present_at,left_at=r.left_at,
   reminder_at=r.reminder_at,correction_id=r.correction_id,checked_entry_id=r.checked_entry_id where device_id=r.device_id;
  if p_device=r.device_id then result:=jsonb_build_object('score',least(100,score),'dwellStartedAt',r.dwell_started_at,'lastPresenceAt',r.last_present_at,'leftAt',r.left_at,
   'checkedIn',pol.attendance_enabled and (checked is not null or e.id is not null),'correctionId',case when pol.attendance_enabled then r.correction_id else null end,'dwellMinutes',pol.presence_dwell_minutes,
   'signals',to_jsonb(signals),'asked',asked is not null);end if;
 end loop;
 perform set_config('pulse.viewer_id',coalesce(viewer,''),true);
 return result;
end $$;

-- ---------------------------------------------------------------------------------------------------- 4. reminders
create or replace function pulse.notification_attendance_prompt(p_person uuid,p_date date,p_phase text,p_at timestamptz default clock_timestamp()) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r notification_reminder;nid uuid;family_key text;label text;
begin
 if p_phase not in ('start','end','done','departure','break') then raise exception 'Unsupported attendance prompt';end if;
 if not exists(select 1 from notification_reminder_policy where org_id=current_org() and enabled and approval_ref is not null) then return null;end if;
 if not notification_recipient_allowed(p_person,'attendance.'||p_phase,'person',p_person) then return null;end if;
 if p_phase='start' and exists(select 1 from attendance_entry where org_id=current_org() and person_id=p_person and work_date=p_date and voided_at is null) then return null;end if;
 if p_phase='break' and not exists(select 1 from attendance_break b join attendance_entry e on e.id=b.entry_id and e.org_id=b.org_id
  where b.org_id=current_org() and b.person_id=p_person and e.work_date=p_date and b.ended_at is null and e.checked_out_at is null and e.voided_at is null) then return null;end if;
 if p_phase not in ('start','break') and not exists(select 1 from attendance_entry where org_id=current_org() and person_id=p_person and work_date=p_date and checked_out_at is null and voided_at is null) then return null;end if;
 family_key:=case when p_phase='start' then 'checkin' when p_phase='break' then 'break' else 'checkout' end;
 insert into notification_reminder(org_id,person_id,work_date,family) values(current_org(),p_person,p_date,family_key) on conflict do nothing;
 select * into r from notification_reminder where org_id=current_org() and person_id=p_person and work_date=p_date and family=family_key for update;
 if r.prompts>=2 or r.dismissed_at is not null or r.snoozed_until>p_at or r.last_at>p_at-interval '15 minutes' then return null;end if;
 label:=case p_phase when 'start' then 'Ready to check in?' when 'done' then 'Done for the day?' when 'end' then 'Still working? Check out when you finish.'
  when 'break' then 'Still on your break? Tap Back when you’re working again.' else 'Possibly left the office? Check out when you finish.' end;
 nid:=notification_emit(p_person,'attendance.'||p_phase,'person',p_person,r.id||':'||(r.prompts+1),label,'/me','attendance');
 if nid is not null then
  update notification set expires_at=p_at+interval '2 hours' where id=nid;
  update notification_reminder set prompts=prompts+1,last_at=p_at where id=r.id;
  insert into attendance_event(org_id,person_id,work_date,at,kind,detail,signals) values(current_org(),p_person,p_date,p_at,'reminder',p_phase,'{schedule}');
 end if;
 return nid;
end $$;

create or replace function pulse.notification_reminder_tick(p_at timestamptz default clock_timestamp()) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record;n int:=0;phase text;nid uuid;
begin
 for r in
  select ps.person_id,s.start_time,s.end_time,x.work_day,rp.timezone,rp.start_offset_minutes,rp.long_break_minutes,
   (x.work_day+s.start_time) at time zone rp.timezone starts,
   ((x.work_day+case when s.end_time<=s.start_time then 1 else 0 end)+s.end_time) at time zone rp.timezone ends
  from notification_reminder_policy rp join person_shift ps using(org_id) join shift s on s.org_id=ps.org_id and s.id=ps.shift_id
  cross join lateral generate_series(-1,0) d cross join lateral (select (p_at at time zone rp.timezone)::date+d as work_day) x
  where rp.org_id=current_org() and rp.enabled and rp.approval_ref is not null
  and x.work_day between ps.valid_from and coalesce(ps.valid_to,'infinity') and hr_working(ps.person_id,x.work_day,s.work_days)
  union all
  -- Everyone without an assigned shift follows the organisation's shift, once HR has chosen that.
  select p.id,hp.shift_start,hp.shift_end,x.work_day,rp.timezone,rp.start_offset_minutes,rp.long_break_minutes,
   (x.work_day+hp.shift_start) at time zone rp.timezone,
   ((x.work_day+case when hp.shift_end<=hp.shift_start then 1 else 0 end)+hp.shift_end) at time zone rp.timezone
  from notification_reminder_policy rp join hr_policy hp on hp.org_id=rp.org_id
  join person p on p.org_id=rp.org_id and p.side='staff' and p.status='active' and not p.tracking_excluded
  cross join lateral generate_series(-1,0) d cross join lateral (select (p_at at time zone rp.timezone)::date+d as work_day) x
  where rp.org_id=current_org() and rp.enabled and rp.approval_ref is not null and rp.fallback_shift and hp.attendance_enabled
  and not exists(select 1 from person_shift ps where ps.org_id=rp.org_id and ps.person_id=p.id and x.work_day between ps.valid_from and coalesce(ps.valid_to,'infinity'))
  and not exists(select 1 from person_work_terms t where t.org_id=rp.org_id and t.person_id=p.id and t.work_mode='outcome')
  and hr_working(p.id,x.work_day,hp.work_days)
 loop
  phase:=null;
  if p_at>=r.starts+make_interval(mins=>r.start_offset_minutes) and p_at<r.ends
   and not exists(select 1 from leave_request where org_id=current_org() and person_id=r.person_id and status='approved' and half_day is null and r.work_day between from_date and to_date) then phase:='start';end if;
  if p_at>=r.ends and p_at<r.ends+interval '15 minutes' and exists(select 1 from companion_notification_settings where org_id=current_org() and person_id=r.person_id and settings->'reminders'->>'done'='true') then phase:='done';end if;
  if p_at>=r.ends+interval '15 minutes' and p_at<r.ends+interval '2 hours' then phase:='end';end if;
  -- A checked-in person gets no start prompt; a long break gets one gentle "Back?" instead.
  if phase='start' and exists(select 1 from attendance_entry where org_id=current_org() and person_id=r.person_id and work_date=r.work_day and voided_at is null) then phase:=null;end if;
  if phase is null and p_at>=r.starts and p_at<r.ends and exists(select 1 from attendance_break b join attendance_entry e on e.id=b.entry_id and e.org_id=b.org_id
   where b.org_id=current_org() and b.person_id=r.person_id and e.work_date=r.work_day and b.ended_at is null and e.checked_out_at is null and e.voided_at is null
   and b.started_at<=p_at-make_interval(mins=>r.long_break_minutes)) then phase:='break';end if;
  if phase is not null then
   nid:=notification_attendance_prompt(r.person_id,r.work_day,phase,p_at);
   if nid is not null then n:=n+1;end if;
  end if;
 end loop;
 return n;
end $$;

-- HR turns reminders on (their decision is the approval reference) and chooses their timing.
create function pulse.attendance_reminders_set(p_enabled boolean, p_start_offset int, p_long_break int) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who text;
begin
 if not viewer_is('admin','hr') or current_viewer() is null then raise exception 'HR or an organisation admin decides reminders' using errcode='42501';end if;
 select display_name into who from person where id=current_viewer();
 insert into notification_reminder_policy(org_id,enabled,approval_ref,timezone,start_offset_minutes,long_break_minutes,fallback_shift)
 values(current_org(),p_enabled,case when p_enabled then 'HR: '||who||' · '||to_char(clock_timestamp() at time zone 'Asia/Kolkata','YYYY-MM-DD') end,'Asia/Kolkata',p_start_offset,p_long_break,true)
 on conflict(org_id) do update set enabled=excluded.enabled,approval_ref=coalesce(excluded.approval_ref,notification_reminder_policy.approval_ref),
  start_offset_minutes=excluded.start_offset_minutes,long_break_minutes=excluded.long_break_minutes,fallback_shift=true;
 insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by)
 values(current_org(),'hr_policy',current_org(),'attendanceReminders',null,case when p_enabled then 'on' else 'off' end||' · start +'||p_start_offset||' min · long break '||p_long_break||' min',current_viewer());
end $$;

-- ---------------------------------------------------------------------------------------------------- 5. onboarding
create table pulse_priv.identity_key (org_id uuid primary key references pulse.org(id), key bytea not null);
create table pulse_priv.person_onboarding (
 org_id uuid not null references pulse.org(id),
 person_id uuid primary key references pulse.person(id),
 details jsonb not null default '{}' check (jsonb_typeof(details)='object' and pg_column_size(details)<8192),
 bank bytea,
 bank_masked text check (bank_masked is null or length(bank_masked)<=80),
 steps jsonb not null default '{}' check (jsonb_typeof(steps)='object'),
 presence_consent_version text, presence_consent_at timestamptz, presence_auto boolean not null default false, presence_withdrawn_at timestamptz,
 notice_id uuid references pulse_priv.fair_notice(id), notice_read_at timestamptz,
 seen_at timestamptz, completed_at timestamptz,
 reminders int not null default 0, reminded_at timestamptz,
 -- Whether personal contact details are on file, kept by a trigger on pulse_priv.hr_contact, whose row security
 -- depends on the viewer (the reminder worker has none).
 contact_email boolean not null default false, contact_phone boolean not null default false,
 updated_by uuid references pulse.person(id), updated_at timestamptz not null default now()
);
create table pulse.onboarding_document_kind (
 org_id uuid not null references pulse.org(id),
 kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,31}$'),
 label text not null check (length(label) between 2 and 60),
 required boolean not null default true,
 id_number text check (id_number in ('aadhaar','pan')),
 sort int not null default 100,
 active boolean not null default true,
 primary key (org_id, kind)
);
create table pulse_priv.identity_document (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),
 kind text not null,
 number_masked text check (number_masked is null or number_masked ~ '^(XXXX XXXX [0-9]{4}|XXXXXX[0-9]{3}[A-Z])$'),
 file bytea, mime text check (mime in ('application/pdf','image/jpeg','image/png','image/webp')),
 size int check (size between 1 and 5242880), file_name text check (file_name is null or length(file_name)<=120),
 drive_file_id text, drive_location text,
 status text not null default 'on_file' check (status in ('on_file','verified','rejected','removed')),
 source text not null check (source in ('self','hr','drive')),
 added_by uuid not null references pulse.person(id), added_at timestamptz not null default now(),
 checked_by uuid references pulse.person(id), checked_at timestamptz,
 note text check (note is null or length(note)<=300),
 check (status='removed' or file is not null or drive_file_id is not null or number_masked is not null)
);
create unique index identity_document_current on pulse_priv.identity_document(person_id, kind) where status in ('on_file','verified');
create table pulse_priv.profile_proposal (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),
 field text not null check (field in ('dob','personalPhone','personalEmail','address','emergencyName','emergencyRelation','emergencyPhone','joinedOn','department','document')),
 value text check (value is null or length(value)<=200),
 document_kind text,
 source text not null check (source in ('roster','hr_sheet','drive','workspace')),
 source_label text not null check (length(source_label) between 1 and 200),
 source_ref text not null check (length(source_ref) between 1 and 300),
 status text not null default 'proposed' check (status in ('proposed','accepted','rejected')),
 proposed_at timestamptz not null default now(),
 decided_by uuid references pulse.person(id), decided_at timestamptz,
 check ((field='document') = (document_kind is not null)),
 check (field<>'document' or value is null)
);
create unique index profile_proposal_once on pulse_priv.profile_proposal(org_id, person_id, field, source_ref, coalesce(value,''), coalesce(document_kind,''));

do $$ declare t text; begin
 foreach t in array array['identity_key','person_onboarding','identity_document','profile_proposal'] loop
  execute format('alter table pulse_priv.%I enable row level security', t);
  execute format('alter table pulse_priv.%I force row level security', t);
  execute format('create policy tenant_isolation on pulse_priv.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
 end loop;
end $$;
-- The proposal agent reads what is missing and proposes; it cannot read files, bank details or decide.
grant select (org_id, person_id, details, steps, seen_at, completed_at) on pulse_priv.person_onboarding to pulse_worker;
grant select, insert on pulse_priv.profile_proposal to pulse_worker;
alter table pulse.onboarding_document_kind enable row level security;
alter table pulse.onboarding_document_kind force row level security;
create policy tenant_isolation on pulse.onboarding_document_kind using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy hr_write on pulse.onboarding_document_kind as restrictive for all to pulse_api
 using (true) with check (pulse.viewer_is('admin','hr'));
grant select, insert, update on pulse.onboarding_document_kind to pulse_api;
grant select on pulse.onboarding_document_kind to pulse_worker;

-- The person may now enter their own personal contact details (HR still needs the named permissions for anyone else's).
alter policy contact_reader on pulse_priv.hr_contact using (pulse.hr_can('hr.contact.read') or person_id = pulse.current_viewer());
alter policy contact_writer on pulse_priv.hr_contact with check (pulse.hr_can('hr.contact.write') or person_id = pulse.current_viewer());
alter policy contact_updater on pulse_priv.hr_contact using (pulse.hr_can('hr.contact.write') or person_id = pulse.current_viewer())
 with check (pulse.hr_can('hr.contact.write') or person_id = pulse.current_viewer());

create function pulse.onboarding_contact_flags() returns trigger
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 insert into pulse_priv.person_onboarding(org_id,person_id,contact_email,contact_phone)
 values(new.org_id,new.person_id,coalesce(btrim(new.personal_email),'')<>'',coalesce(btrim(new.personal_phone),'')<>'')
 on conflict(person_id) do update set contact_email=excluded.contact_email,contact_phone=excluded.contact_phone;
 return new;
end $$;
create trigger onboarding_contact_flags after insert or update on pulse_priv.hr_contact for each row execute function pulse.onboarding_contact_flags();
-- Existing contact rows: the table owner reads them once here, without the viewer-bound policies.
alter table pulse_priv.hr_contact no force row level security;
alter table pulse_priv.person_onboarding no force row level security;
insert into pulse_priv.person_onboarding(org_id,person_id,contact_email,contact_phone)
select org_id,person_id,coalesce(btrim(personal_email),'')<>'',coalesce(btrim(personal_phone),'')<>'' from pulse_priv.hr_contact
on conflict(person_id) do update set contact_email=excluded.contact_email,contact_phone=excluded.contact_phone;
alter table pulse_priv.person_onboarding force row level security;
alter table pulse_priv.hr_contact force row level security;

create function pulse.onboarding_defaults() returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_org() is null or exists(select 1 from onboarding_document_kind where org_id=current_org()) then return; end if;
 insert into onboarding_document_kind(org_id,kind,label,required,id_number,sort) values
  (current_org(),'aadhaar','Aadhaar (masked)',true,'aadhaar',10),
  (current_org(),'pan','PAN card',true,'pan',20),
  (current_org(),'bank_proof','Cancelled cheque or passbook',false,null,30)
 on conflict do nothing;
end $$;

-- Who may enter someone's onboarding details (the person, HR, leadership) and who may see IDs (the person and HR).
create function pulse.onboarding_can_edit(p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (p_person=current_viewer() or viewer_is('admin','hr','leadership'))
  and exists(select 1 from person where org_id=current_org() and id=p_person and side='staff')
$$;
-- "Only HR and the person": the HR role, or an admin/leader explicitly granted hr.documents.read by name. Stricter
-- than hr_can(), which lets every leadership account read HR documents.
create function pulse.identity_hr() returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('hr') or viewer_is('admin','leadership') and exists(select 1 from sensitive_permission
  where org_id=current_org() and person_id=current_viewer() and permission='hr.documents.read' and revoked_at is null))
$$;
create function pulse.onboarding_can_see_ids(p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (p_person=current_viewer() or identity_hr())
$$;
create function pulse.identity_key_hex() returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k text;
begin
 insert into pulse_priv.identity_key values(current_org(),public.gen_random_bytes(32)) on conflict do nothing;
 select encode(key,'hex') into k from pulse_priv.identity_key where org_id=current_org();
 return k;
end $$;

-- What is still missing for a person, as keys: dob, phone, email, address, emergency, bank, photo, doc:<kind>.
create function pulse.onboarding_missing(p_person uuid) returns text[]
 language sql stable security definer set search_path=pulse,pg_temp as $$
 with o as (select details,bank_masked,contact_email,contact_phone from pulse_priv.person_onboarding where org_id=current_org() and person_id=p_person)
 select array_remove(array[
  case when coalesce((select details->>'dob' from o),'')='' then 'dob' end,
  case when not coalesce((select contact_phone from o),false) and coalesce((select phone from people_profile where person_id=p_person),'')='' then 'phone' end,
  case when not coalesce((select contact_email from o),false) then 'email' end,
  case when coalesce((select details->>'address' from o),'')='' then 'address' end,
  case when coalesce((select details->>'emergencyName' from o),'')='' or coalesce((select details->>'emergencyPhone' from o),'')='' then 'emergency' end,
  case when (select bank_masked from o) is null then 'bank' end,
  case when not exists(select 1 from person_photo where person_id=p_person) then 'photo' end],null)
  || coalesce((select array_agg('doc:'||k.kind order by k.sort) from onboarding_document_kind k where k.org_id=current_org() and k.active and k.required
   and not exists(select 1 from pulse_priv.identity_document d where d.org_id=current_org() and d.person_id=p_person and d.kind=k.kind and d.status in ('on_file','verified'))),'{}')
$$;

-- The person's (or, for HR, someone's) onboarding: details, masked bank and IDs, steps, consent and proposals.
create function pulse.onboarding_state(p_person uuid) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare o pulse_priv.person_onboarding; c pulse_priv.hr_contact; self boolean; see_details boolean; see_ids boolean; docs jsonb; missing text[]; total int;
begin
 if not onboarding_can_edit(p_person) then raise exception 'Your own onboarding, or HR' using errcode='42501'; end if;
 perform onboarding_defaults();
 self:=p_person=current_viewer();
 see_details:=self or hr_can('hr.contact.read');
 see_ids:=onboarding_can_see_ids(p_person);
 if self then
  insert into pulse_priv.person_onboarding(org_id,person_id,seen_at) values(current_org(),p_person,now())
  on conflict(person_id) do update set seen_at=coalesce(person_onboarding.seen_at,now());
 end if;
 select * into o from pulse_priv.person_onboarding where org_id=current_org() and person_id=p_person;
 select * into c from pulse_priv.hr_contact where org_id=current_org() and person_id=p_person;
 if not self and see_details then perform hr_log(p_person,'onboarding.details','hr_onboarding'); end if;
 if not self and see_ids then perform hr_log(p_person,'identity.documents','hr_onboarding'); end if;
 select coalesce(jsonb_agg(jsonb_build_object('kind',k.kind,'label',k.label,'required',k.required,'idNumber',k.id_number,
  'document',(select jsonb_build_object('id',d.id,'status',d.status,'source',d.source,'addedAt',d.added_at,'checkedAt',d.checked_at,
   'masked',case when see_ids then d.number_masked end,'hasFile',d.file is not null,'fileName',case when see_ids then d.file_name end,
   'mime',case when see_ids then d.mime end,'size',d.size,'drive',case when see_ids then d.drive_location end,'note',case when see_ids then d.note end)
   from pulse_priv.identity_document d where d.org_id=current_org() and d.person_id=p_person and d.kind=k.kind and d.status in ('on_file','verified','rejected')
   order by (d.status<>'rejected') desc,d.added_at desc limit 1)) order by k.sort,k.kind),'[]')
 into docs from onboarding_document_kind k where k.org_id=current_org() and k.active;
 missing:=onboarding_missing(p_person);
 total:=7+(select count(*) from onboarding_document_kind where org_id=current_org() and active and required);
 return jsonb_build_object(
  'person',(select jsonb_build_object('id',p.id,'name',p.display_name,'firstName',split_part(p.display_name,' ',1),'role',pp.role,'pod',pp.pod,'joinedOn',pp.joined_on,
    'workPhone',pp.phone,'photo',exists(select 1 from person_photo where person_id=p.id)) from person p left join people_profile pp on pp.person_id=p.id where p.id=p_person),
  'self',self,'canSeeDetails',see_details,'canSeeIds',see_ids,
  'details',case when see_details then coalesce(o.details,'{}'::jsonb)||jsonb_build_object('personalEmail',c.personal_email,'personalPhone',c.personal_phone) else null end,
  'bank',case when see_details then o.bank_masked end,
  'documents',docs,
  'steps',coalesce(o.steps,'{}'::jsonb),
  'consent',case when self then jsonb_build_object('version',o.presence_consent_version,'at',o.presence_consent_at,'auto',coalesce(o.presence_auto,false),'withdrawnAt',o.presence_withdrawn_at)
   else jsonb_build_object('given',o.presence_consent_at is not null and o.presence_withdrawn_at is null) end,
  'notice',(select jsonb_build_object('id',n.id,'version',n.version,'title',coalesce(n.body->>'title','Staff notice '||n.version),'summary',n.body->>'summary',
    'readAt',case when o.notice_id=n.id then o.notice_read_at end)
   from pulse_priv.fair_notice n where n.org_id=current_org() and n.withdrawn_at is null order by n.approved_at desc limit 1),
  'apps',(select jsonb_build_object('phone',bool_or(platform in ('android','ios')),'desktop',bool_or(platform in ('windows','macos')),'chrome',bool_or(platform='chrome'))
   from native_device where org_id=current_org() and person_id=p_person and revoked_at is null),
  'missing',to_jsonb(missing),'percent',round(100.0*(total-cardinality(missing))/greatest(total,1))::int,
  'completedAt',o.completed_at,
  'proposals',case when see_details then (select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'field',x.field,'value',x.value,'documentKind',x.document_kind,
    'source',x.source,'sourceLabel',x.source_label,'proposedAt',x.proposed_at) order by x.proposed_at),'[]')
   from pulse_priv.profile_proposal x where x.org_id=current_org() and x.person_id=p_person and x.status='proposed') else '[]'::jsonb end);
end $$;

-- Save one section. Values are validated by the API; this checks who may write and keeps every value bounded.
create function pulse.onboarding_save(p_person uuid, p_section text, p_data jsonb) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare self boolean; allowed text[]:=array['dob','address','city','pincode','bloodGroup','emergencyName','emergencyRelation','emergencyPhone','fatherName'];
 clean jsonb:='{}'; k text; v text; key_hex text;
begin
 if not onboarding_can_edit(p_person) then raise exception 'Your own onboarding, or HR' using errcode='42501'; end if;
 self:=p_person=current_viewer();
 insert into pulse_priv.person_onboarding(org_id,person_id) values(current_org(),p_person) on conflict do nothing;
 if p_section='details' then
  for k,v in select key,value from jsonb_each_text(p_data) loop
   if k=any(allowed) then
    if length(coalesce(v,''))>300 then raise exception '% is too long',k using errcode='22023'; end if;
    clean:=clean||jsonb_build_object(k,nullif(btrim(v),''));
   end if;
  end loop;
  update pulse_priv.person_onboarding set details=jsonb_strip_nulls(details||clean),updated_by=current_viewer(),updated_at=now() where person_id=p_person;
  if p_data ? 'personalEmail' or p_data ? 'personalPhone' then
   if length(coalesce(p_data->>'personalEmail',''))>120 or length(coalesce(p_data->>'personalPhone',''))>24 then raise exception 'Contact is too long' using errcode='22023'; end if;
   insert into pulse_priv.hr_contact(org_id,person_id,personal_email,personal_phone,source,updated_by)
   values(current_org(),p_person,nullif(btrim(p_data->>'personalEmail'),''),nullif(btrim(p_data->>'personalPhone'),''),case when self then 'Entered by the person in Pulse' else 'Entered by HR in Pulse' end,current_viewer())
   on conflict(person_id) do update set personal_email=case when p_data ? 'personalEmail' then excluded.personal_email else hr_contact.personal_email end,
    personal_phone=case when p_data ? 'personalPhone' then excluded.personal_phone else hr_contact.personal_phone end,
    source=excluded.source,updated_by=excluded.updated_by,updated_at=now();
  end if;
  if p_data ? 'emergencyName' or p_data ? 'emergencyPhone' then
   update pulse_priv.hr_contact set emergency=nullif(btrim(concat_ws(' · ',(select details->>'emergencyName' from pulse_priv.person_onboarding where person_id=p_person),
    (select details->>'emergencyRelation' from pulse_priv.person_onboarding where person_id=p_person),(select details->>'emergencyPhone' from pulse_priv.person_onboarding where person_id=p_person))),'')
   where person_id=p_person;
   if not found then
    insert into pulse_priv.hr_contact(org_id,person_id,emergency,source,updated_by)
    select current_org(),p_person,nullif(btrim(concat_ws(' · ',details->>'emergencyName',details->>'emergencyRelation',details->>'emergencyPhone')),''),
     case when self then 'Entered by the person in Pulse' else 'Entered by HR in Pulse' end,current_viewer() from pulse_priv.person_onboarding where person_id=p_person;
   end if;
  end if;
  if not self then perform hr_log(p_person,'onboarding.details','hr_onboarding_update'); end if;
 elsif p_section='bank' then
  if coalesce(p_data->>'masked','')='' or length(p_data->>'masked')>80 or jsonb_typeof(p_data->'account') is distinct from 'object' then raise exception 'Bank details are incomplete' using errcode='22023'; end if;
  key_hex:=identity_key_hex();
  update pulse_priv.person_onboarding set bank=public.pgp_sym_encrypt_bytea(convert_to((p_data->'account')::text,'UTF8'),key_hex,'cipher-algo=aes256'),
   bank_masked=p_data->>'masked',updated_by=current_viewer(),updated_at=now() where person_id=p_person;
  perform hr_log(p_person,'onboarding.bank',case when self then 'self_update' else 'hr_onboarding_update' end);
 elsif p_section='step' then
  if coalesce(p_data->>'step','') not in ('welcome','details','bank','documents','app','notifications','consent','notice','done') or coalesce(p_data->>'state','') not in ('done','skipped','later') then
   raise exception 'Unknown step' using errcode='22023'; end if;
  update pulse_priv.person_onboarding set steps=steps||jsonb_build_object(p_data->>'step',jsonb_build_object('state',p_data->>'state','at',now())),updated_at=now() where person_id=p_person;
 elsif p_section='consent' then
  if not self then raise exception 'Only the person can agree to office arrival' using errcode='42501'; end if;
  if (p_data->>'given')::boolean then
   update pulse_priv.person_onboarding set presence_consent_version=coalesce(p_data->>'version','arrival-v1'),presence_consent_at=now(),presence_withdrawn_at=null,
    presence_auto=coalesce((p_data->>'auto')::boolean,false),updated_at=now() where person_id=p_person;
  else
   update pulse_priv.person_onboarding set presence_withdrawn_at=now(),presence_auto=false,updated_at=now() where person_id=p_person;
   -- Withdrawal reaches every device at once and clears their current evidence.
   update companion_presence set consent=false,auto_consent=false,region_inside=false,wifi_strength=0,ip_matched=false,region_at=null,wifi_at=null,ip_at=null,
    dwell_started_at=null,holding_since=null,last_present_at=null,left_at=null,office_id=null where org_id=current_org() and person_id=p_person;
  end if;
 elsif p_section='notice' then
  if not self then raise exception 'Only the person can read and sign the staff notice' using errcode='42501'; end if;
  if not exists(select 1 from pulse_priv.fair_notice where org_id=current_org() and id=(p_data->>'noticeId')::uuid and withdrawn_at is null) then raise exception 'That notice is not published' using errcode='22023'; end if;
  update pulse_priv.person_onboarding set notice_id=(p_data->>'noticeId')::uuid,notice_read_at=now(),updated_at=now() where person_id=p_person;
 else raise exception 'Unknown section' using errcode='22023';
 end if;
 update pulse_priv.person_onboarding set completed_at=case when cardinality(onboarding_missing(p_person))=0 then coalesce(completed_at,now()) end where person_id=p_person;
 return jsonb_build_object('missing',to_jsonb(onboarding_missing(p_person)));
end $$;

-- An ID document: masked number (never the full one) and/or an encrypted file.
create function pulse.identity_document_add(p_person uuid, p_kind text, p_masked text, p_mime text, p_name text, p_bytes bytea) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k onboarding_document_kind; nid uuid;
begin
 if not onboarding_can_edit(p_person) then raise exception 'Your own documents, or HR' using errcode='42501'; end if;
 perform onboarding_defaults();
 select * into k from onboarding_document_kind where org_id=current_org() and kind=p_kind and active;
 if not found then raise exception 'HR has not asked for that document' using errcode='22023'; end if;
 if p_masked is not null and (k.id_number is null or k.id_number='aadhaar' and p_masked !~ '^XXXX XXXX [0-9]{4}$' or k.id_number='pan' and p_masked !~ '^XXXXXX[0-9]{3}[A-Z]$') then
  raise exception 'Only a masked number can be kept' using errcode='22023'; end if;
 if p_bytes is null and p_masked is null then raise exception 'Add the document or its number' using errcode='22023'; end if;
 if p_bytes is not null and (octet_length(p_bytes)>5242880 or p_mime not in ('application/pdf','image/jpeg','image/png','image/webp')) then raise exception 'A PDF or photo up to 5 MB' using errcode='22023'; end if;
 -- A new upload replaces the current one; the replaced file is cleared, not kept.
 update pulse_priv.identity_document set status='removed',file=null,checked_by=null where org_id=current_org() and person_id=p_person and kind=p_kind and status in ('on_file','verified','rejected');
 insert into pulse_priv.identity_document(org_id,person_id,kind,number_masked,file,mime,size,file_name,source,added_by)
 values(current_org(),p_person,p_kind,p_masked,case when p_bytes is null then null else public.pgp_sym_encrypt_bytea(p_bytes,identity_key_hex(),'cipher-algo=aes256') end,
  case when p_bytes is null then null else p_mime end,octet_length(p_bytes),left(p_name,120),case when p_person=current_viewer() then 'self' else 'hr' end,current_viewer())
 returning id into nid;
 perform hr_log(p_person,'identity.'||p_kind,'upload');
 update pulse_priv.person_onboarding set completed_at=case when cardinality(onboarding_missing(p_person))=0 then coalesce(completed_at,now()) end where person_id=p_person;
 return nid;
end $$;

create function pulse.identity_document_read(p_id uuid) returns table(name text, mime text, bytes bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d pulse_priv.identity_document;
begin
 select * into d from pulse_priv.identity_document where org_id=current_org() and id=p_id and status in ('on_file','verified','rejected') and file is not null;
 if not found or not onboarding_can_see_ids(d.person_id) then raise exception 'Document unavailable' using errcode='42501'; end if;
 perform hr_log(d.person_id,'identity.'||d.kind||'.file',case when d.person_id=current_viewer() then 'self' else 'hr_document_view' end);
 return query select coalesce(d.file_name,d.kind), d.mime, public.pgp_sym_decrypt_bytea(d.file,identity_key_hex());
end $$;

create function pulse.identity_document_check(p_id uuid, p_ok boolean, p_note text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d pulse_priv.identity_document;
begin
 if not identity_hr() then raise exception 'HR checks documents' using errcode='42501'; end if;
 select * into d from pulse_priv.identity_document where org_id=current_org() and id=p_id and status in ('on_file','verified','rejected') for update;
 if not found then raise exception 'Document unavailable' using errcode='22023'; end if;
 if d.person_id=current_viewer() then raise exception 'Someone else checks your own documents' using errcode='42501'; end if;
 if not p_ok and length(btrim(coalesce(p_note,'')))<3 then raise exception 'Say what is wrong, so the person can fix it' using errcode='22023'; end if;
 update pulse_priv.identity_document set status=case when p_ok then 'verified' else 'rejected' end,checked_by=current_viewer(),checked_at=now(),note=nullif(left(btrim(coalesce(p_note,'')),300),'') where id=p_id;
 perform hr_log(d.person_id,'identity.'||d.kind,case when p_ok then 'verify' else 'reject' end);
end $$;

create function pulse.identity_document_remove(p_id uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d pulse_priv.identity_document;
begin
 select * into d from pulse_priv.identity_document where org_id=current_org() and id=p_id and status<>'removed' for update;
 if not found then raise exception 'Document unavailable' using errcode='22023'; end if;
 if not (d.person_id=current_viewer() and d.status<>'verified' or identity_hr()) then raise exception 'Ask HR to remove a checked document' using errcode='42501'; end if;
 update pulse_priv.identity_document set status='removed',file=null where id=p_id;
 perform hr_log(d.person_id,'identity.'||d.kind,'remove');
 update pulse_priv.person_onboarding set completed_at=null where person_id=d.person_id and cardinality(onboarding_missing(d.person_id))>0;
end $$;

-- Accept or reject an agent's proposal. Personal fields: the person or HR. Roster fields: HR. IDs: only a pointer.
create function pulse.profile_proposal_decide(p_id uuid, p_accept boolean) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x pulse_priv.profile_proposal; self boolean;
begin
 select * into x from pulse_priv.profile_proposal where org_id=current_org() and id=p_id and status='proposed' for update;
 if not found then raise exception 'This proposal is already decided' using errcode='22023'; end if;
 self:=x.person_id=current_viewer();
 if not (self and x.field not in ('joinedOn','department') or viewer_is('admin','hr')) then raise exception 'HR or the person decides this' using errcode='42501'; end if;
 update pulse_priv.profile_proposal set status=case when p_accept then 'accepted' else 'rejected' end,decided_by=current_viewer(),decided_at=now() where id=p_id;
 if p_accept then
  if x.field in ('dob','address','emergencyName','emergencyRelation','emergencyPhone') then
   perform onboarding_save(x.person_id,'details',jsonb_build_object(x.field,x.value));
  elsif x.field in ('personalEmail','personalPhone') then
   perform onboarding_save(x.person_id,'details',jsonb_build_object(x.field,x.value));
  elsif x.field='joinedOn' then
   update people_profile set joined_on=x.value::date,locked=array(select distinct unnest(locked||'{joined_on}'::text[])),updated_at=now() where person_id=x.person_id;
  elsif x.field='department' then
   update people_profile set department=x.value,locked=array(select distinct unnest(locked||'{department}'::text[])),updated_at=now() where person_id=x.person_id;
  elsif x.field='document' then
   if not exists(select 1 from pulse_priv.identity_document where org_id=current_org() and person_id=x.person_id and kind=x.document_kind and status in ('on_file','verified')) then
    insert into pulse_priv.identity_document(org_id,person_id,kind,drive_file_id,drive_location,source,added_by)
    values(current_org(),x.person_id,x.document_kind,x.source_ref,x.source_label,'drive',current_viewer());
    perform hr_log(x.person_id,'identity.'||x.document_kind,'confirm_drive_pointer');
   end if;
  end if;
 end if;
 return jsonb_build_object('status',case when p_accept then 'accepted' else 'rejected' end);
end $$;

-- HR's view of everyone: invited, signed in, profile, apps, first check-in, last nudge.
create function pulse.onboarding_roster() returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare total int;
begin
 if not viewer_is('admin','hr','leadership') then raise exception 'HR and leadership see onboarding' using errcode='42501'; end if;
 perform onboarding_defaults();
 total:=7+(select count(*) from onboarding_document_kind where org_id=current_org() and active and required);
 return coalesce((select jsonb_agg(row order by row->>'name') from (
  select jsonb_build_object('id',p.id,'name',p.display_name,'role',pp.role,'pod',pp.pod,'joinedOn',pp.joined_on,
   'invite',(select jsonb_build_object('status',i.status,'at',coalesce(i.sent_at,i.prepared_at),'blocked',i.blocked_reason) from pulse_priv.staff_invitation i
     where i.org_id=current_org() and i.person_id=p.id order by i.prepared_at desc limit 1),
   'canSignIn',exists(select 1 from account a where a.holder_person_id=p.id and a.provider='google' and a.purpose like 'Workspace%')
     or exists(select 1 from login_credential lc where lc.person_id=p.id and lc.status='active'),
   'signedInAt',(select min(t) from (select min(lc.last_login_at) t from login_credential lc where lc.person_id=p.id
     union all select o.seen_at from pulse_priv.person_onboarding o where o.person_id=p.id
     union all select min(d.created_at) from native_device d where d.person_id=p.id
     union all select min(s.last_active_at) from login_session s where s.person_id=p.id) seen),
   'missing',to_jsonb(m.missing),'percent',round(100.0*(total-cardinality(m.missing))/greatest(total,1))::int,
   'apps',(select jsonb_build_object('phone',coalesce(bool_or(d.platform in ('android','ios')),false),'desktop',coalesce(bool_or(d.platform in ('windows','macos')),false),'chrome',coalesce(bool_or(d.platform='chrome'),false))
     from native_device d where d.person_id=p.id and d.revoked_at is null),
   'firstCheckIn',(select min(e.work_date) from attendance_entry e where e.person_id=p.id and e.voided_at is null),
   'lastCheckIn',(select max(e.work_date) from attendance_entry e where e.person_id=p.id and e.voided_at is null),
   'outcome',exists(select 1 from person_work_terms t where t.person_id=p.id and t.work_mode='outcome'),
   'consent',exists(select 1 from pulse_priv.person_onboarding o where o.person_id=p.id and o.presence_consent_at is not null and o.presence_withdrawn_at is null)
     or exists(select 1 from companion_presence s where s.person_id=p.id and s.consent),
   'nudged',(select jsonb_object_agg(case when n.event_type='attendance.nudge' then 'checkin' else 'profile' end,n.created_at) from (
     select distinct on (event_type) event_type,created_at from notification where org_id=current_org() and person_id=p.id and event_type in ('attendance.nudge','profile.reminder')
     order by event_type,created_at desc) n),
   'proposals',(select count(*) from pulse_priv.profile_proposal x where x.person_id=p.id and x.status='proposed'),
   'completedAt',(select o.completed_at from pulse_priv.person_onboarding o where o.person_id=p.id)) row
  from person p left join people_profile pp on pp.person_id=p.id cross join lateral (select onboarding_missing(p.id) missing) m
  where p.org_id=current_org() and p.side='staff' and p.status='active') q),'[]'::jsonb);
end $$;

-- HR's one-click nudge: one in-app reminder a day per kind; it never sends mail or messages outside Pulse.
create function pulse.onboarding_nudge(p_person uuid, p_kind text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid; day date:=(clock_timestamp() at time zone 'Asia/Kolkata')::date;
begin
 if not viewer_is('admin','hr') or current_viewer() is null then raise exception 'HR nudges' using errcode='42501'; end if;
 if p_kind='checkin' then
  nid:=notification_emit(p_person,'attendance.nudge','person',p_person,'hr:'||day,'A reminder from HR: check in on Pulse when you start work. It’s one tap.','/me','attendance');
  if nid is not null then insert into attendance_event(org_id,person_id,work_date,kind,detail,signals) values(current_org(),p_person,day,'nudge','checkin','{hr}'); end if;
 elsif p_kind='profile' then
  nid:=notification_emit(p_person,'profile.reminder','person',p_person,'hr:'||day,'HR asks you to finish your Pulse profile. It takes about 3 minutes.','/welcome','profile');
 else raise exception 'Unknown nudge' using errcode='22023';
 end if;
 return nid;
end $$;

-- The worker: gentle profile reminders once HR turns them on. In-app first; later ones may reach the phone.
create function pulse.onboarding_tick(p_at timestamptz default clock_timestamp()) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record; n int:=0; nid uuid; local time:=(p_at at time zone 'Asia/Kolkata')::time;
begin
 if not exists(select 1 from hr_policy where org_id=current_org() and onboarding_reminders) or local<'10:30' or local>'18:30' then return 0; end if;
 for r in select o.person_id,o.reminders,o.reminded_at,o.seen_at from pulse_priv.person_onboarding o join person p on p.id=o.person_id and p.org_id=o.org_id
  where o.org_id=current_org() and p.side='staff' and p.status='active' and o.completed_at is null and o.seen_at is not null and o.reminders<6
  and coalesce(o.reminded_at,o.seen_at)<=p_at-case when o.reminders<2 then interval '1 day' else interval '2 days' end
  and cardinality(onboarding_missing(o.person_id))>0 for update of o skip locked loop
  perform set_config('pulse.viewer_id',r.person_id::text,true);
  nid:=notification_emit(r.person_id,case when r.reminders<2 then 'update.self' else 'profile.reminder' end,'person',r.person_id,'profile:'||(r.reminders+1),
   'Your Pulse profile is almost done. Add what’s missing in about 3 minutes.','/welcome','profile');
  update pulse_priv.person_onboarding set reminders=reminders+1,reminded_at=p_at where person_id=r.person_id;
  if nid is not null then n:=n+1; end if;
 end loop;
 perform set_config('pulse.viewer_id','',true);
 return n;
end $$;

-- The first time a person opens Pulse (any surface), for HR's "signed in" column. Written once.
create function pulse.onboarding_seen() returns void
 language sql security definer set search_path=pulse,pg_temp as $$
 insert into pulse_priv.person_onboarding(org_id,person_id,seen_at)
 select current_org(),current_viewer(),now() where current_viewer() is not null and exists(select 1 from person where org_id=current_org() and id=current_viewer() and side='staff')
 on conflict(person_id) do update set seen_at=now() where person_onboarding.seen_at is null
$$;

-- The person's own office-arrival agreement, the default for their devices until a device says otherwise.
create function pulse.onboarding_presence_consent() returns jsonb
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('given',coalesce(o.presence_consent_at is not null and o.presence_withdrawn_at is null,false),'auto',coalesce(o.presence_auto,false))
 from (select 1) one left join pulse_priv.person_onboarding o on o.org_id=current_org() and o.person_id=current_viewer()
$$;

revoke all on function pulse.attendance_event_dispute(uuid,uuid),pulse.attendance_reminders_set(boolean,int,int),pulse.onboarding_defaults(),
 pulse.onboarding_can_edit(uuid),pulse.onboarding_can_see_ids(uuid),pulse.identity_hr(),pulse.identity_key_hex(),pulse.onboarding_missing(uuid),pulse.onboarding_state(uuid),
 pulse.onboarding_save(uuid,text,jsonb),pulse.identity_document_add(uuid,text,text,text,text,bytea),pulse.identity_document_read(uuid),
 pulse.identity_document_check(uuid,boolean,text),pulse.identity_document_remove(uuid),pulse.profile_proposal_decide(uuid,boolean),
 pulse.onboarding_roster(),pulse.onboarding_nudge(uuid,text),pulse.onboarding_tick(timestamptz),pulse.onboarding_presence_consent(),pulse.onboarding_seen(),
 pulse.onboarding_contact_flags() from public;
grant execute on function pulse.attendance_event_dispute(uuid,uuid),pulse.attendance_reminders_set(boolean,int,int),pulse.onboarding_state(uuid),
 pulse.onboarding_save(uuid,text,jsonb),pulse.identity_document_add(uuid,text,text,text,text,bytea),pulse.identity_document_read(uuid),
 pulse.identity_document_check(uuid,boolean,text),pulse.identity_document_remove(uuid),pulse.profile_proposal_decide(uuid,boolean),
 pulse.onboarding_roster(),pulse.onboarding_nudge(uuid,text),pulse.onboarding_presence_consent(),pulse.onboarding_defaults(),pulse.onboarding_seen() to pulse_api;
grant execute on function pulse.onboarding_tick(timestamptz),pulse.onboarding_missing(uuid),pulse.onboarding_defaults() to pulse_worker;

-- migrate:down
-- Forward-only.
