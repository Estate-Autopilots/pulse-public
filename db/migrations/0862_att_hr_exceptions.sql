-- migrate:up
-- ATT part 3 (21 Oct 2026): HR confirms only what Pulse could not settle, and hears about it once a day.
--
-- 1. HR resolves an exception in one tap (pulse.attendance_exception_resolve): Confirm keeps what Pulse recorded (and
--    makes a session held for review final at that time), Fix sets the check-out HR gives, Dismiss closes it as
--    nothing to change. Every change to a session is in record_change, with HR's name.
-- 2. Pulse's own wrong check-out proposals (the device departure bug fixed by 0861: production has 8, each proposing a
--    check-out at its own check-in time and waiting on the co-founders) are withdrawn by HR in one tap
--    (pulse.attendance_stale_withdraw), with the reason recorded on the request and its approval.
-- 3. One attendance digest per HR person per working day, after 10:00 company time: yesterday's days to check, how many
--    settled by themselves, who has not checked in with Pulse this week. Never one notification per day per person.

select pulse.check_values_add('pulse.record_change'::regclass, 'record_change_entity_type_check', 'entity_type', array['attendance_entry','attendance_regularisation']);

create function pulse.attendance_exception_resolve(p_id uuid, p_action text, p_out timestamptz default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x attendance_exception; e attendance_entry; out_at timestamptz; who uuid:=current_viewer();
begin
 if p_action not in ('confirm','fix','dismiss') then raise exception 'Confirm, fix or dismiss' using errcode='22023'; end if;
 if who is null or not (hr_is_staff(who) or viewer_is('admin','hr')) then raise exception 'HR settles attendance exceptions' using errcode='42501'; end if;
 select * into x from attendance_exception where id=p_id and org_id=current_org() for update;
 if not found then raise exception 'Unknown exception' using errcode='P0002'; end if;
 if x.resolved_at is not null then return jsonb_build_object('ok',true,'already',true); end if;
 if x.person_id=who then raise exception 'Someone else in HR settles your own days' using errcode='42501'; end if;
 if x.entry_id is not null then select * into e from attendance_entry where id=x.entry_id for update; end if;
 if p_action='fix' then
  if p_out is null or e.id is null then raise exception 'Give the time they left' using errcode='22023'; end if;
  if p_out<e.checked_in_at or p_out>clock_timestamp() then raise exception 'The check-out is after the check-in and not in the future' using errcode='22023'; end if;
  out_at:=p_out;
 elsif p_action='confirm' and e.id is not null then
  out_at:=coalesce(e.checked_out_at,x.proposed_out,(select proposed_end from attendance_provisional_close where entry_id=e.id));
 end if;
 if out_at is not null and e.id is not null then
  insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by)
  values(current_org(),'attendance_entry',e.id,'checked_out_at',e.checked_out_at::text,out_at::text,who);
  update attendance_entry set checked_out_at=out_at,reconciled_open=false,
   out_client=coalesce(out_client,'{}')||jsonb_build_object('confirmedBy',who,'confirmedAt',clock_timestamp(),'hr',p_action)
   where id=e.id;
  update attendance_break set ended_at=greatest(started_at,out_at) where entry_id=e.id and ended_at is null;
  -- A session held for review the next morning is final now: HR's time replaces the provisional one.
  delete from attendance_provisional_close where entry_id=e.id;
 end if;
 update attendance_exception set resolved_at=clock_timestamp(),resolved_by=who,
  resolution=case p_action when 'confirm' then 'confirmed' when 'fix' then 'fixed' else 'dismissed' end,note=nullif(trim(coalesce(p_note,'')),'')
  where id=x.id;
 return jsonb_build_object('ok',true,'out',out_at);
end $$;
revoke all on function pulse.attendance_exception_resolve(uuid,text,timestamptz,text) from public;
grant execute on function pulse.attendance_exception_resolve(uuid,text,timestamptz,text) to pulse_api;

-- The proposals Pulse's old device departure made by itself (reason text of 0123/0149), still waiting.
create function pulse.attendance_stale_proposals() returns table(id uuid, person_id uuid, work_date date, out_time time, checked_in time, created_at timestamptz, flow_id uuid)
language sql stable security definer set search_path=pulse,pg_temp as $$
 select r.id,r.person_id,r.work_date,r.out_time,
  (select (min(e.checked_in_at) at time zone org_time_zone(current_org()))::time from attendance_entry e where e.person_id=r.person_id and e.work_date=r.work_date and e.voided_at is null),
  r.created_at,(select f.id from hr_flow f where f.source_id=r.id and f.kind='correction' limit 1)
 from attendance_regularisation r where r.org_id=current_org() and r.status='pending' and r.kind='missed_punch'
  and r.reason like 'Auto check-out at last presence%'
  and (hr_is_staff(current_viewer()) or viewer_is('admin','hr'))
 order by r.work_date
$$;
revoke all on function pulse.attendance_stale_proposals() from public;
grant execute on function pulse.attendance_stale_proposals() to pulse_api;

create function pulse.attendance_stale_withdraw() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who uuid:=current_viewer(); n int:=0; r record; why text:='Pulse proposed this check-out by mistake (an office departure from an earlier day); withdrawn by HR. The session keeps its own times.';
begin
 if who is null or not (hr_is_staff(who) or viewer_is('admin','hr')) then raise exception 'HR withdraws these' using errcode='42501'; end if;
 for r in select * from attendance_stale_proposals() loop
  update attendance_regularisation set status='cancelled',decided_by=who,decided_at=now(),decision_note=why where id=r.id and status='pending';
  update hr_flow set status='cancelled',decided_by=who,decision_note=why,updated_at=now() where source_id=r.id and kind='correction' and status='pending';
  insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'attendance_regularisation',r.id,'status','pending','cancelled',who);
  n:=n+1;
 end loop;
 -- Their reminders and waiting cards go with them.
 update notification set expires_at=least(expires_at,clock_timestamp()) where org_id=current_org() and subject_type='hr_flow'
  and subject_id in (select f.id from hr_flow f where f.status='cancelled' and f.decision_note=why) and expires_at>clock_timestamp();
 return n;
end $$;
revoke all on function pulse.attendance_stale_withdraw() from public;
grant execute on function pulse.attendance_stale_withdraw() to pulse_api;

-- HR's daily digest: yesterday (the last working day) in one line, after 10:00 company time.
create function pulse.attendance_digest_tick(p_at timestamptz default clock_timestamp()) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare tz text:=org_time_zone(current_org()); today date:=(p_at at time zone org_time_zone(current_org()))::date; pol hr_policy; hr uuid; n int:=0;
 open_n int; settled int; quiet_people int; day date; title text; viewer text:=current_setting('pulse.viewer_id',true);
begin
 if not pg_has_role(session_user,'pulse_worker','member') then raise exception 'Worker scope required' using errcode='42501'; end if;
 select * into pol from hr_policy where org_id=current_org();
 if not found or not pol.attendance_enabled or module_off('hr') then return 0; end if;
 if (p_at at time zone tz)::time<time '10:00' or not hr_working(null,today,pol.work_days) then return 0; end if;
 select max(d)::date into day from generate_series(today-7,today-1,interval '1 day') d where hr_working(null,d::date,pol.work_days);
 if day is null then return 0; end if;
 select count(*) into open_n from attendance_exception where org_id=current_org() and resolved_at is null;
 select count(*) into settled from attendance_entry e where e.org_id=current_org() and e.work_date=day and e.voided_at is null and e.checked_out_at is not null
  and not exists(select 1 from attendance_exception x where x.entry_id=e.id);
 -- Staff who have not checked in with Pulse on any working day this past week (their reminders paused, 0860).
 select count(*) into quiet_people from person p where p.org_id=current_org() and p.side='staff' and p.status='active' and not p.tracking_excluded
  and not exists(select 1 from attendance_entry e where e.person_id=p.id and e.work_date>today-7 and e.voided_at is null)
  and not exists(select 1 from leave_request l where l.person_id=p.id and l.status='approved' and l.to_date>=today-7 and l.from_date<=today);
 if open_n=0 and settled=0 and quiet_people=0 then return 0; end if;
 title:=trim(to_char(day,'Dy DD Mon'))||': '||case when open_n>0 then open_n||' to check' else 'nothing to check' end
  ||case when settled>0 then ' · '||settled||' settled by themselves' else '' end
  ||case when quiet_people>0 then ' · '||quiet_people||' not checking in with Pulse' else '' end;
 for hr in select p.id from person p where p.org_id=current_org() and p.status='active' and hr_is_staff(p.id) loop
  perform set_config('pulse.viewer_id',hr::text,true);
  if notification_emit(hr,'attendance.digest','person',hr,'digest:'||today,title,'/hr?tab=attendance&view=check','attendance') is not null then n:=n+1; end if;
 end loop;
 perform set_config('pulse.viewer_id',coalesce(viewer,''),true);
 return n;
end $$;
revoke all on function pulse.attendance_digest_tick(timestamptz) from public;
grant execute on function pulse.attendance_digest_tick(timestamptz) to pulse_worker;

-- The minute tick already runs attendance_forgotten_tick (and with it the presence engine); the digest rides along.
do $$
declare
  definition text := pg_get_functiondef('pulse.attendance_forgotten_tick(timestamptz)'::regprocedure);
  anchor text := ' perform attendance_presence_tick(p_at,null);';
begin
  if position(anchor in definition) = 0 then raise exception 'attendance_forgotten_tick changed'; end if;
  execute replace(definition, anchor, anchor || E'\n perform attendance_digest_tick(p_at);');
end $$;

-- Sessions already held for review (POLISH-2's morning close; production has 7, all unresolved) are HR's exceptions
-- too, so the new view is complete from the first day. Additive: new rows in the new table, nothing else touched.
do $$
declare o uuid;
begin
 for o in select id from pulse.org loop
  perform set_config('pulse.org_id',o::text,true);
  insert into pulse.attendance_exception(org_id,person_id,work_date,entry_id,kind,summary,evidence,proposed_out,opened_at)
  select e.org_id,e.person_id,e.work_date,e.id,'missing_checkout','No check-out; held for review the next morning',
   jsonb_build_object('checkedIn',e.checked_in_at,'proposed',p.proposed_end,'reason',p.reason),p.proposed_end,p.created_at
  from pulse.attendance_entry e join pulse.attendance_provisional_close p on p.entry_id=e.id
  where e.org_id=o and e.voided_at is null and e.checked_out_at is null
   and not exists(select 1 from pulse.attendance_correction_time t join pulse.attendance_regularisation r on r.id=t.regularisation_id where t.entry_id=e.id and r.status='approved')
  on conflict do nothing;
 end loop;
 perform set_config('pulse.org_id','',true);
end $$;

-- migrate:down
-- Forward-only.
