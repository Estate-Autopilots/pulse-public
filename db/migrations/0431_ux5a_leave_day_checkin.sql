-- migrate:up
-- UX-5A (owner, 13 Oct 2026, an HR default: "approve all"): checking in on a day of approved leave never cancels the
-- leave silently. Pulse asks "You're on leave today. Cancel the leave and check in?":
--   - one tap cancels that day's leave (only that day: a longer leave keeps its other days) and tells HR;
--   - otherwise the check-in is recorded and HR decides (an HR request is raised for it, once per day).
-- A phone or desktop app that cannot ask records the check-in the second way. Every case is kept here, one row per day.
create table pulse.attendance_leave_overlap (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id) on delete cascade,
 leave_id uuid references pulse.leave_request(id) on delete set null,
 work_date date not null,
 entry_id uuid references pulse.attendance_entry(id) on delete set null,
 decision text not null check(decision in ('cancelled','kept')),
 ticket_id uuid references pulse.hr_ticket(id) on delete set null,
 leave_kind text,
 created_at timestamptz not null default now(),
 unique(org_id,person_id,work_date)
);
alter table pulse.attendance_leave_overlap enable row level security;
alter table pulse.attendance_leave_overlap force row level security;
create policy tenant on pulse.attendance_leave_overlap using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy own_or_team on pulse.attendance_leave_overlap as restrictive to pulse_api
 using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership') or coalesce(pulse.manages(person_id),false))
 with check(person_id=pulse.current_viewer());
grant select,insert on pulse.attendance_leave_overlap to pulse_api;
grant select on pulse.attendance_leave_overlap to pulse_worker;
create trigger audit_mutation after insert or update on pulse.attendance_leave_overlap for each row execute function pulse.audit_mutation();

/** The person cancels today's day of their own approved full-day leave. A one-day leave is cancelled; a longer one loses
 *  only today: the first or last day moves, or a leave around today becomes two (the later part stays approved as it
 *  was). `p_before` and `p_after` are the working days left on either side, counted by the API with the person's own
 *  calendar (as when the leave was asked for). Comp-off comes back for the day. HR (and the pod head) are told. */
create function pulse.leave_cancel_day(p_leave uuid,p_day date,p_before numeric,p_after numeric) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l leave_request;me uuid:=current_viewer();rest uuid;gave numeric;who text;recipient uuid;note text;
begin
 select * into l from leave_request where org_id=current_org() and id=p_leave for update;
 if not found or me is null or l.person_id<>me then raise exception 'Leave not found' using errcode='P0002';end if;
 if l.status<>'approved' or l.half_day is not null or p_day<l.from_date or p_day>l.to_date then
  raise exception 'Only a whole day of your approved leave can be cancelled here' using errcode='22023';end if;
 if p_day<>(now() at time zone org_time_zone())::date then raise exception 'Only today''s leave can be cancelled by checking in' using errcode='22023';end if;
 if l.leave_kind='comp_off' and p_day>l.from_date and p_day<l.to_date then raise exception 'Comp-off around today: HR decides' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('hr-leave:'||l.person_id));
 note:='Cancelled for '||to_char(p_day,'Dy DD Mon')||': checked in to work';
 if l.from_date=l.to_date or (p_before<=0 and p_after<=0) then
  -- Nothing else to keep: the person's own cancellation; the flow follows (hr_flow_source) and comp-off comes back
  -- (hr_comp_debit).
  update leave_request set status='cancelled',decided_by=me,decided_at=now(),decision_note=note where id=l.id;
 else
  if p_day=l.from_date or p_before<=0 then update leave_request set from_date=p_day+1,days=p_after where id=l.id;
  elsif p_day=l.to_date or p_after<=0 then update leave_request set to_date=p_day-1,days=p_before where id=l.id;
  else
   update leave_request set to_date=p_day-1,days=p_before where id=l.id;
   -- The days after today stay approved, decided as before: inserted without a viewer, so the flow is copied as decided.
   perform set_config('pulse.viewer_id','',true);
   insert into leave_request(org_id,person_id,from_date,to_date,leave_kind,reason,half_day,days,status,decided_by,decided_at,decision_note)
    values(l.org_id,l.person_id,p_day+1,l.to_date,l.leave_kind,l.reason,null,p_after,'approved',l.decided_by,coalesce(l.decided_at,now()),
     concat_ws(' · ',nullif(l.decision_note,''),'The days after '||to_char(p_day,'Dy DD Mon')||' of a leave split by a check-in')) returning id into rest;
   perform set_config('pulse.viewer_id',me::text,true);
  end if;
  update hr_flow f set from_date=r.from_date,to_date=r.to_date,details=coalesce(f.details,'{}')||jsonb_build_object('days',r.days)
   from leave_request r where r.id=l.id and f.org_id=current_org() and f.kind='leave' and f.source_id=l.id;
  if l.leave_kind='comp_off' then
   gave:=l.days-(select days from leave_request where id=l.id);
   if gave>0 then
    insert into hr_comp_use(org_id,credit_id,leave_id,days)
     select l.org_id,u.credit_id,l.id,-least(gave,sum(u.days)) from hr_comp_use u where u.leave_id=l.id group by u.credit_id having sum(u.days)>0 order by u.credit_id limit 1;
   end if;
  end if;
 end if;
 select display_name into who from person where id=me;
 for recipient in select id from person where status='active' and side='staff' and id<>me and (id=hr_head(me) or hr_is_staff(id)) loop
  insert into notification(org_id,person_id,title,href,telegram_status)
  values(current_org(),recipient,who||' checked in on approved leave and cancelled '||to_char(p_day,'Dy DD Mon')||' ('||replace(l.leave_kind,'_',' ')||')','/people/'||me::text||'?tab=attendance','disabled');
 end loop;
 return jsonb_build_object('leaveId',l.id,'rest',rest,'kind',l.leave_kind,'day',p_day);
end $$;
revoke all on function pulse.leave_cancel_day(uuid,date,numeric,numeric) from public;
grant execute on function pulse.leave_cancel_day(uuid,date,numeric,numeric) to pulse_api;

-- migrate:down
-- Forward-only.
