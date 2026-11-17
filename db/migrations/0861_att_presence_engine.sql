-- migrate:up
-- ATT (21 Oct 2026): attendance that is right by itself.
--
-- Why. On production every check-in by the one person whose phone had once seen the (test) office was followed within a
-- minute by "Leaving for the day? Check out when you finish." and a missed-check-out correction proposing the check-in
-- time as the check-out (8 of the 10 corrections ever made, 8 of the 9 requests waiting on the co-founders). The device
-- row kept `left_at` from 9 Oct, so every new session looked like one he had already left. Device rows were judged one
-- by one (a laptop at the desk could not outvote a phone that left), a missed ping counted as leaving, and three other
-- askers (the 15-minute "Still working?", the two-hours-later "Still checked in?", the laptop's "Shift is over") asked
-- the same question whatever the signals said.
--
-- Now one engine per person (pulse.attendance_presence_tick, every minute and after every device report):
-- 1. Signals, each with a weight and a freshness (pulse.presence_score): office Wi-Fi access point (strong) or name
--    (weak) from the laptop or phone, the phone inside the office geofence, the office's public IP from any Pulse app or
--    browser, the laptop companion's heartbeat while in use, the phone app in the foreground. A signal counts fully while
--    fresh and fades to nothing over the same time again, so one missed ping changes nothing. At the office = a score of
--    at least 60: one strong signal (the office access point, 70), or two that agree (geofence 50, network 40, the
--    Wi-Fi's name alone 30; the laptop in use 15 and the phone app open 10 only add to a location signal).
-- 2. Decisions (pulse.presence_decide, pure, tested with timelines): automatic check-in after the dwell (when HR and the
--    person allow it, else the one "Check in?"); an absence that ends within the break limit becomes a break; leaving =
--    no office signal for the leave time; a departure near or after the shift's end checks out automatically at the last
--    confident moment; a session with no signal at all checks out at the shift's end after the grace time; only a real
--    conflict (the laptop still busy somewhere else, or a long absence in the middle of the day) asks once, with one-tap
--    answers ("Yes, I left at 18:40" / "Still working"), never again for that session.
-- 3. Every automatic action says how it was decided (out_client / client: via auto, reason, confidence, signals). Low
--    confidence ones (no signals, unanswered questions) open an exception for HR (pulse.attendance_exception, HR desk);
--    confident ones are confirmed by themselves.
-- Signal kinds only, never places: the office is the only place recorded, as before.

-- Company rules (HR → Settings → Attendance): breaks, automatic check-out, the question.
alter table pulse.hr_policy
  add column presence_auto_checkout boolean not null default true,
  add column presence_break_max_minutes int not null default 90 check (presence_break_max_minutes between 10 and 240),
  add column break_allowed_minutes int not null default 60 check (break_allowed_minutes between 0 and 240),
  add column break_paid boolean not null default false,
  add column checkout_grace_minutes int not null default 60 check (checkout_grace_minutes between 0 and 480),
  add column presence_question boolean not null default true,
  add column presence_threshold int not null default 60 check (presence_threshold between 30 and 100);

-- The laptop's heartbeat while in use and the phone app in the foreground (sent with the device's presence report).
alter table pulse.companion_presence add column active_at timestamptz, add column foreground_at timestamptz, add column elsewhere_at timestamptz;

-- A Pulse page open on the office network (the gateway's address, never stored): the person's own consent from
-- onboarding decides whether it counts. One row per person, replaced in place.
create table pulse.presence_browser (
  org_id uuid not null references pulse.org(id), person_id uuid not null references pulse.person(id),
  office_id uuid references pulse.presence_office(id), office_ip_at timestamptz, elsewhere_at timestamptz, updated_at timestamptz not null default now(),
  primary key (org_id, person_id)
);
alter table pulse.presence_browser enable row level security;
alter table pulse.presence_browser force row level security;
create policy tenant_isolation on pulse.presence_browser using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy self_only on pulse.presence_browser as restrictive to pulse_api using(person_id=pulse.current_viewer()) with check(person_id=pulse.current_viewer());
grant select on pulse.presence_browser to pulse_api, pulse_worker;

-- The engine's memory of one person's current session (or of the day before they check in).
create table pulse.attendance_presence_state (
  org_id uuid not null references pulse.org(id), person_id uuid not null references pulse.person(id),
  entry_id uuid references pulse.attendance_entry(id), work_date date,
  holding_since timestamptz, confident_since timestamptz, first_confident_at timestamptz, last_confident_at timestamptz, absent_since timestamptz,
  last_activity_at timestamptz, asked_at timestamptz, ask_kind text check (ask_kind in ('left','left_early')),
  answer text check (answer in ('left','working')), answered_at timestamptz, last_score int, last_signals text[],
  updated_at timestamptz not null default now(),
  primary key (org_id, person_id)
);
alter table pulse.attendance_presence_state enable row level security;
alter table pulse.attendance_presence_state force row level security;
create policy tenant_isolation on pulse.attendance_presence_state using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy self_or_hr on pulse.attendance_presence_state as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.hr_is_staff(pulse.current_viewer()));
grant select on pulse.attendance_presence_state to pulse_api, pulse_worker;

-- What HR looks at: only the days Pulse could not settle by itself, each with its evidence.
create table pulse.attendance_exception (
  org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
  person_id uuid not null references pulse.person(id), work_date date not null, entry_id uuid references pulse.attendance_entry(id),
  kind text not null check (kind in ('missing_checkout','conflict','unanswered','long_break','correction','stale_proposal')),
  summary text not null, evidence jsonb not null default '{}', proposed_out timestamptz,
  opened_at timestamptz not null default clock_timestamp(), resolved_at timestamptz, resolved_by uuid references pulse.person(id),
  resolution text check (resolution in ('confirmed','fixed','dismissed','by_person')), note text
);
create unique index attendance_exception_once on pulse.attendance_exception(org_id, person_id, work_date, kind) where resolved_at is null;
create index attendance_exception_open on pulse.attendance_exception(org_id, opened_at) where resolved_at is null;
alter table pulse.attendance_exception enable row level security;
alter table pulse.attendance_exception force row level security;
create policy tenant_isolation on pulse.attendance_exception using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy self_or_hr on pulse.attendance_exception as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.hr_is_staff(pulse.current_viewer()));
grant select on pulse.attendance_exception to pulse_api, pulse_worker;

select pulse.check_values_add('pulse.attendance_event'::regclass, 'attendance_event_kind_check', 'kind',
  array['auto_check_out','break_detected','asked','answered']);
-- Signal kinds in an event: the laptop in use and the phone app open join Wi-Fi, geofence and network; the details of
-- the engine's own events (why it checked out, what it asked, the answer).
alter table pulse.attendance_event drop constraint attendance_event_signals_check;
alter table pulse.attendance_event add constraint attendance_event_signals_check check (signals <@ array['geofence','wifi','network','schedule','hr','laptop','phone']);
alter table pulse.attendance_event drop constraint attendance_event_detail_check;
alter table pulse.attendance_event add constraint attendance_event_detail_check check (detail is null or detail = any (array['start','end','done','departure','break','checkin','profile',
  'left','left_early','working','last_activity','shift_end','left_unanswered']));

-- 1. The score. p_signals: [{source: wifi|geofence|network|laptop|phone|elsewhere, strong?: bool, at: timestamptz, fresh?: minutes}].
--    Location (wifi, geofence, network: the best of each kind across devices) plus support (laptop, phone) once a location
--    signal is there. Pure: same signals and time, same answer.
create function pulse.presence_score(p_signals jsonb, p_at timestamptz) returns jsonb language plpgsql immutable set search_path=pulse,pg_temp as $$
declare s jsonb; src text; w numeric; fresh numeric; age numeric; f numeric; best jsonb:='{}'; loc numeric:=0; sup numeric:=0; kinds text[]:='{}';
 elsewhere timestamptz; activity timestamptz;
begin
 for s in select * from jsonb_array_elements(coalesce(p_signals,'[]')) loop
  src:=s->>'source';
  if s->>'at' is null then continue; end if;
  age:=extract(epoch from p_at-(s->>'at')::timestamptz)/60;
  if age<-2 then continue; end if;               -- from the future (a device's clock): ignored
  age:=greatest(age,0);
  -- A registered access point is strong alone; the geofence (phones' GPS drifts) and the office network need another.
  w:=case src when 'wifi' then case when (s->>'strong')::boolean then 70 else 30 end when 'geofence' then 50 when 'network' then 40
   when 'laptop' then 15 when 'phone' then 10 else 0 end;
  fresh:=coalesce((s->>'fresh')::numeric,case src when 'wifi' then 5 when 'geofence' then 720 when 'network' then 10 when 'laptop' then 5 when 'phone' then 5 else 10 end);
  f:=case when age<=fresh then 1 when age>=2*fresh then 0 else 1-(age-fresh)/fresh end;
  if src in ('laptop','phone','elsewhere') and age<=2*fresh then activity:=greatest(activity,(s->>'at')::timestamptz); end if;
  if src='elsewhere' then if age<=fresh then elsewhere:=greatest(elsewhere,(s->>'at')::timestamptz); end if; continue; end if;
  if f<=0 then continue; end if;
  if w*f>coalesce((best->>src)::numeric,0) then best:=best||jsonb_build_object(src,round(w*f,1)); end if;
 end loop;
 loc:=coalesce((best->>'wifi')::numeric,0)+coalesce((best->>'geofence')::numeric,0)+coalesce((best->>'network')::numeric,0);
 sup:=case when loc>0 then coalesce((best->>'laptop')::numeric,0)+coalesce((best->>'phone')::numeric,0) else 0 end;
 select coalesce(array_agg(k order by k),'{}') into kinds from jsonb_object_keys(best) k where (best->>k)::numeric>0 and (loc>0 or k not in ('laptop','phone'));
 return jsonb_build_object('score',least(100,round(loc+sup))::int,'location',round(loc)::int,'signals',to_jsonb(kinds),
  'elsewhere',elsewhere is not null and loc<20,'activityAt',activity);
end $$;

-- 2. The decision. Pure: the score now, what the engine remembered, the session (or the day), the company's rules.
--    Returns the new memory and at most one action: auto_check_in | arrival | break | check_out | ask | none.
create function pulse.presence_decide(p_now timestamptz, p_score jsonb, p_state jsonb, p_session jsonb, p_rules jsonb) returns jsonb
language plpgsql immutable set search_path=pulse,pg_temp as $$
declare st jsonb:=coalesce(p_state,'{}'); score int:=coalesce((p_score->>'score')::int,0); threshold int:=coalesce((p_rules->>'threshold')::int,60);
 confident boolean; open boolean:=coalesce((p_session->>'open')::boolean,false); shift_end timestamptz:=(p_session->>'shiftEnd')::timestamptz;
 checked_in timestamptz:=(p_session->>'checkedIn')::timestamptz; mode text:=coalesce(p_session->>'mode','office');
 leave interval:=make_interval(mins=>coalesce((p_rules->>'leaveMinutes')::int,15)); dwell interval:=make_interval(mins=>coalesce((p_rules->>'dwellMinutes')::int,3));
 break_max interval:=make_interval(mins=>coalesce((p_rules->>'breakMaxMinutes')::int,90)); grace interval:=make_interval(mins=>coalesce((p_rules->>'graceMinutes')::int,60));
 auto_out boolean:=coalesce((p_rules->>'autoCheckOut')::boolean,true); may_ask boolean:=coalesce((p_rules->>'ask')::boolean,true)
  and coalesce((p_session->>'askWindow')::boolean,true) and st->>'askedAt' is null and st->>'answer' is null;
 last_conf timestamptz; absent timestamptz; activity timestamptz:=greatest((st->>'lastActivity')::timestamptz,(p_score->>'activityAt')::timestamptz);
 none jsonb; out_at timestamptz; ends timestamptz;
begin
 confident:=score>=threshold;
 -- Holding: one decent location signal (enough to ask "Check in?"); confident: enough to act alone.
 if coalesce((p_score->>'location')::int,0)>=35 then st:=st||jsonb_build_object('holdingSince',coalesce(st->>'holdingSince',p_now::text)); else st:=st-'holdingSince'; end if;
 if confident then
  st:=st||jsonb_build_object('lastConfident',p_now,'confidentSince',coalesce(st->>'confidentSince',p_now::text),'firstConfident',coalesce(st->>'firstConfident',p_now::text));
 else st:=st-'confidentSince'; end if;
 if activity is not null then st:=st||jsonb_build_object('lastActivity',activity); end if;
 none:=jsonb_build_object('action','none','state',st);
 -- Not checked in: arrival.
 if not open then
  if not coalesce((p_session->>'eligible')::boolean,false) then return none; end if;
  if confident and coalesce((p_rules->>'autoCheckIn')::boolean,false) and p_now-(st->>'confidentSince')::timestamptz>=dwell then
   return jsonb_build_object('action','auto_check_in','at',(st->>'confidentSince')::timestamptz,'confidence',score,'state',st);
  end if;
  if st->>'holdingSince' is not null and p_now-(st->>'holdingSince')::timestamptz>=dwell then
   return jsonb_build_object('action','arrival','at',(st->>'holdingSince')::timestamptz,'confidence',score,'state',st);
  end if;
  return none;
 end if;
 -- Only an office session is judged by the office's signals; elsewhere only activity says anything.
 last_conf:=(st->>'lastConfident')::timestamptz; absent:=(st->>'absentSince')::timestamptz;
 ends:=greatest(shift_end,checked_in+interval '4 hours');   -- a check-in after the shift: four hours of work after it
 if mode='office' and confident then
  if absent is not null then
   st:=st-'absentSince';
   -- Back within the break limit (or any time before the shift ends): the time away was a break.
   return jsonb_build_object('action','break','from',absent,'to',p_now,'long',p_now-absent>break_max,'state',st);
  end if;
  return jsonb_build_object('action','none','state',st);
 end if;
 if st->>'answer'='working' then
  -- They said they are still working: the session ends at their last activity once it stops, never by the office.
  if activity is not null and p_now-activity>=leave and p_now>=ends and auto_out then
   return jsonb_build_object('action','check_out','at',activity,'reason','last_activity','confidence',50,'state',st);
  end if;
  if activity is null and p_now>=greatest(ends,checked_in)+interval '6 hours' and auto_out then
   return jsonb_build_object('action','check_out','at',ends,'reason','shift_end','confidence',20,'state',st);
  end if;
  return none;
 end if;
 if mode='office' and last_conf is not null then
  if absent is null and p_now-last_conf>=leave then absent:=last_conf; st:=st||jsonb_build_object('absentSince',absent); end if;
  if absent is null then return jsonb_build_object('action','none','state',st); end if;
  if coalesce((p_score->>'elsewhere')::boolean,false) then
   -- Gone from the office but the laptop is busy somewhere else: the one real conflict. Ask once; no answer by the
   -- end of the shift and its grace: out at the last moment at the office, for HR to see.
   if may_ask then return jsonb_build_object('action','ask','kind','left','leftAt',absent,'state',st); end if;
   if p_now>=ends+grace and auto_out then return jsonb_build_object('action','check_out','at',absent,'reason','left_unanswered','confidence',45,'state',st); end if;
   return jsonb_build_object('action','none','state',st);
  end if;
  -- Everything gone. Near or after the end of the shift: they left for the day.
  if absent>=ends-interval '60 minutes' or p_now>=ends+grace then
   -- Asked in the middle of the day and never answered: out at the moment they left, for HR to see.
   if auto_out and st->>'askedAt' is not null then return jsonb_build_object('action','check_out','at',absent,'reason','left_unanswered','confidence',45,'state',st); end if;
   if auto_out then return jsonb_build_object('action','check_out','at',absent,'reason','left','confidence',greatest(60,coalesce((p_state->>'lastScore')::int,60)),'state',st); end if;
   if may_ask then return jsonb_build_object('action','ask','kind','left','leftAt',absent,'state',st); end if;
   return jsonb_build_object('action','none','state',st);
  end if;
  -- In the middle of the day and away longer than a break: ask once whether they are back later.
  if p_now-absent>break_max and may_ask then return jsonb_build_object('action','ask','kind','left_early','leftAt',absent,'state',st); end if;
  return jsonb_build_object('action','none','state',st);
 end if;
 -- No office signal this session (no device, a browser only, working from home or the field): the last activity if
 -- Pulse saw any after the shift, else the shift's end, once the grace time has passed.
 if auto_out and p_now>=ends+grace then
  if activity is not null and activity>=checked_in and p_now-activity>=leave then
   out_at:=least(greatest(activity,least(ends,p_now)),p_now);
   return jsonb_build_object('action','check_out','at',out_at,'reason',case when activity>ends then 'last_activity' else 'shift_end' end,'confidence',case when activity>ends then 50 else 25 end,'state',st);
  elsif activity is null or p_now-activity>=leave then
   return jsonb_build_object('action','check_out','at',case when checked_in<shift_end then shift_end else checked_in+interval '1 hour' end,'reason','shift_end','confidence',20,'state',st);
  end if;
 end if;
 return none;
end $$;

-- What one person's devices and browser say now, as signals for presence_score.
create function pulse.presence_signals(p_person uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(x.s),'[]') from (
  select jsonb_build_object('source','wifi','strong',s.wifi_strength=40,'at',s.wifi_at,'fresh',case when d.platform in ('windows','macos') then 5 else 20 end) s
   from companion_presence s join native_device d on d.id=s.device_id where s.org_id=current_org() and s.person_id=p_person and s.consent and d.revoked_at is null
   and s.office_id is not null and s.wifi_strength>0 and s.wifi_at is not null
  union all select jsonb_build_object('source','geofence','at',s.region_at) from companion_presence s join native_device d on d.id=s.device_id
   where s.org_id=current_org() and s.person_id=p_person and s.consent and d.revoked_at is null and s.office_id is not null and s.region_inside and s.region_at is not null
  union all select jsonb_build_object('source','network','at',s.ip_at) from companion_presence s join native_device d on d.id=s.device_id
   where s.org_id=current_org() and s.person_id=p_person and s.consent and d.revoked_at is null and s.office_id is not null and s.ip_matched and s.ip_at is not null
  union all select jsonb_build_object('source','laptop','at',s.active_at) from companion_presence s join native_device d on d.id=s.device_id
   where s.org_id=current_org() and s.person_id=p_person and s.consent and d.revoked_at is null and s.active_at is not null
  union all select jsonb_build_object('source','phone','at',s.foreground_at) from companion_presence s join native_device d on d.id=s.device_id
   where s.org_id=current_org() and s.person_id=p_person and s.consent and d.revoked_at is null and s.foreground_at is not null
  union all select jsonb_build_object('source','elsewhere','at',s.elsewhere_at) from companion_presence s join native_device d on d.id=s.device_id
   where s.org_id=current_org() and s.person_id=p_person and s.consent and d.revoked_at is null and s.elsewhere_at is not null
  union all select jsonb_build_object('source','network','at',b.office_ip_at) from presence_browser b where b.org_id=current_org() and b.person_id=p_person and b.office_ip_at is not null
  union all select jsonb_build_object('source','elsewhere','at',b.elsewhere_at,'fresh',10) from presence_browser b where b.org_id=current_org() and b.person_id=p_person and b.elsewhere_at is not null
 ) x
$$;
revoke all on function pulse.presence_signals(uuid) from public;

-- A Pulse page reporting in (GET /api/v0/companion): on the office network or not. Only with the person's consent.
create function pulse.presence_browser_seen(p_ip inet, p_visible boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare office uuid; consent jsonb:=onboarding_presence_consent();
begin
 if current_viewer() is null or not coalesce((consent->>'given')::boolean,false) or not coalesce(p_visible,false) then return; end if;
 if p_ip is not null then
  select o.id into office from presence_office o where o.org_id=current_org() and o.active and (o.audience is null or current_viewer()=any(o.audience))
   and exists(select 1 from unnest(o.public_ip_ranges) network where p_ip<<=network) order by o.id limit 1;
 end if;
 insert into presence_browser(org_id,person_id,office_id,office_ip_at,elsewhere_at)
 values(current_org(),current_viewer(),office,case when office is not null then clock_timestamp() end,case when office is null and p_ip is not null then clock_timestamp() end)
 on conflict(org_id,person_id) do update set office_id=coalesce(excluded.office_id,presence_browser.office_id),
  office_ip_at=coalesce(excluded.office_ip_at,presence_browser.office_ip_at),elsewhere_at=coalesce(excluded.elsewhere_at,presence_browser.elsewhere_at),updated_at=clock_timestamp();
end $$;
revoke all on function pulse.presence_browser_seen(inet,boolean) from public;
grant execute on function pulse.presence_browser_seen(inet,boolean) to pulse_api;

-- Android confirmed the dwell itself (POLISH-2): the person has been at the office that long already.
create function pulse.presence_dwelled() returns void language sql security definer set search_path=pulse,pg_temp as $$
 insert into attendance_presence_state(org_id,person_id,work_date,holding_since)
 values(current_org(),current_viewer(),(clock_timestamp() at time zone org_time_zone(current_org()))::date,
  clock_timestamp()-make_interval(mins=>coalesce((select presence_dwell_minutes from hr_policy where org_id=current_org()),0)))
 on conflict(org_id,person_id) do update set holding_since=least(coalesce(attendance_presence_state.holding_since,excluded.holding_since),excluded.holding_since),work_date=excluded.work_date
$$;
revoke all on function pulse.presence_dwelled() from public;
grant execute on function pulse.presence_dwelled() to pulse_api;

-- An exception for HR, once per person, day and kind while open.
create function pulse.attendance_exception_open(p_person uuid, p_day date, p_entry uuid, p_kind text, p_summary text, p_evidence jsonb, p_out timestamptz default null)
returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare id uuid;
begin
 insert into attendance_exception(org_id,person_id,work_date,entry_id,kind,summary,evidence,proposed_out)
 values(current_org(),p_person,p_day,p_entry,p_kind,p_summary,coalesce(p_evidence,'{}'),p_out)
 on conflict(org_id,person_id,work_date,kind) where resolved_at is null do update set evidence=excluded.evidence,summary=excluded.summary,proposed_out=coalesce(excluded.proposed_out,attendance_exception.proposed_out)
 returning attendance_exception.id into id;
 return id;
end $$;
revoke all on function pulse.attendance_exception_open(uuid,date,uuid,text,text,jsonb,timestamptz) from public;

-- 3. The tick: for each person with a session open or presence signals today. Worker scope, or one person (the API,
--    right after their device reported). Never touches a session someone is correcting.
create function pulse.attendance_presence_tick(p_at timestamptz default clock_timestamp(), p_person uuid default null) returns int
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pol hr_policy; tz text:=org_time_zone(current_org()); viewer text:=current_setting('pulse.viewer_id',true); who uuid; e attendance_entry;
 st attendance_presence_state; sig jsonb; sc jsonb; d jsonb; w record; rules jsonb; session jsonb; acted int:=0; day date; eligible boolean;
 checked uuid; office uuid; office_name text; rem notification_reminder; asked uuid; local time; low boolean; said text; signals text[]; device text;
begin
 if p_person is null and not pg_has_role(session_user,'pulse_worker','member') then raise exception 'Worker scope required' using errcode='42501';end if;
 if p_person is not null and p_person is distinct from current_viewer() and not pg_has_role(session_user,'pulse_worker','member') then raise exception 'Own presence only' using errcode='42501';end if;
 if module_off('hr') then return 0; end if;
 select * into pol from hr_policy where org_id=current_org();
 if not found or not pol.attendance_enabled then return 0; end if;
 rules:=jsonb_build_object('threshold',pol.presence_threshold,'dwellMinutes',pol.presence_dwell_minutes,'leaveMinutes',pol.presence_leave_minutes,
  'breakMaxMinutes',pol.presence_break_max_minutes,'graceMinutes',pol.checkout_grace_minutes,'autoCheckOut',pol.presence_auto_checkout,'ask',pol.presence_question);
 local:=(p_at at time zone tz)::time;
 for who in select p.id from person p where p.org_id=current_org() and p.status='active' and (p_person is null or p.id=p_person) and (
   exists(select 1 from attendance_entry a where a.org_id=current_org() and a.person_id=p.id and a.checked_out_at is null and a.voided_at is null and not a.reconciled_open)
   or exists(select 1 from companion_presence s where s.org_id=current_org() and s.person_id=p.id and s.consent and s.updated_at>p_at-interval '30 minutes')
   or exists(select 1 from presence_browser b where b.org_id=current_org() and b.person_id=p.id and b.updated_at>p_at-interval '30 minutes')) loop
  perform set_config('pulse.viewer_id',who::text,true);
  perform pg_advisory_xact_lock(hashtextextended(who::text,37));
  e:=null; checked:=null; asked:=null; device:=null;
  select * into e from attendance_entry a where a.org_id=current_org() and a.person_id=who and a.checked_out_at is null and a.voided_at is null and not a.reconciled_open
   order by a.checked_in_at desc limit 1;
  select * into st from attendance_presence_state where org_id=current_org() and person_id=who for update;
  if not found then insert into attendance_presence_state(org_id,person_id) values(current_org(),who) returning * into st; end if;
  -- A new session (or a new day without one) starts with a clean memory: nothing from an earlier day carries over.
  day:=coalesce(e.work_date,(p_at at time zone tz)::date);
  if st.entry_id is distinct from e.id or st.work_date is distinct from day then
   update attendance_presence_state set entry_id=e.id,work_date=day,first_confident_at=null,last_confident_at=null,absent_since=null,last_activity_at=null,
    asked_at=null,ask_kind=null,answer=null,answered_at=null,holding_since=case when e.id is null and st.work_date is not distinct from day then holding_since end,
    confident_since=case when e.id is null and st.work_date is not distinct from day then confident_since end where org_id=current_org() and person_id=who returning * into st;
  end if;
  sig:=presence_signals(who); sc:=presence_score(sig,p_at);
  signals:=array(select jsonb_array_elements_text(sc->'signals'));
  if e.id is not null then
   select * into w from attendance_shift_window(who,e.work_date,e.mode);
   session:=jsonb_build_object('open',true,'checkedIn',e.checked_in_at,'mode',e.mode,'shiftEnd',w.end_at,'askWindow',local between time '08:00' and time '21:30');
   -- A session with a correction on its way is the person's and HR's to settle, and a manual break is the person's.
   if exists(select 1 from attendance_correction_time t where t.entry_id=e.id)
    or exists(select 1 from attendance_regularisation r where r.person_id=who and r.work_date=e.work_date and r.kind='missed_punch' and r.status='pending' and r.reason not like 'Auto check-out at last presence%')
    or exists(select 1 from attendance_break b where b.entry_id=e.id and b.ended_at is null) then
    session:=session||'{"held":true}';
   end if;
  else
   select * into w from attendance_shift_window(who,day,'office');
   eligible:=p_at between w.start_at-interval '1 hour' and w.end_at and hr_working(who,day,pol.work_days)
    and not exists(select 1 from leave_request where person_id=who and status='approved' and half_day is null and day between from_date and to_date)
    and not exists(select 1 from attendance_entry where person_id=who and work_date=day and voided_at is null);
   session:=jsonb_build_object('open',false,'eligible',eligible);
  end if;
  if coalesce((session->>'held')::boolean,false) then
   update attendance_presence_state set last_score=(sc->>'score')::int,last_signals=signals,updated_at=p_at,
    last_confident_at=case when (sc->>'score')::int>=pol.presence_threshold then p_at else last_confident_at end where org_id=current_org() and person_id=who;
   continue;
  end if;
  d:=presence_decide(p_at,sc,jsonb_strip_nulls(jsonb_build_object('holdingSince',st.holding_since,'confidentSince',st.confident_since,'firstConfident',st.first_confident_at,'lastConfident',st.last_confident_at,
   'absentSince',st.absent_since,'lastActivity',st.last_activity_at,'askedAt',st.asked_at,'answer',st.answer,'lastScore',st.last_score)),session,
   rules||jsonb_build_object('autoCheckIn',(pol.presence_auto_checkin or exists(select 1 from presence_office o where o.org_id=current_org() and o.audience is not null and who=any(o.audience)))
    and exists(select 1 from companion_presence s where s.org_id=current_org() and s.person_id=who and s.consent and s.auto_consent)));
  update attendance_presence_state set holding_since=(d->'state'->>'holdingSince')::timestamptz,confident_since=(d->'state'->>'confidentSince')::timestamptz,first_confident_at=(d->'state'->>'firstConfident')::timestamptz,
   last_confident_at=(d->'state'->>'lastConfident')::timestamptz,absent_since=(d->'state'->>'absentSince')::timestamptz,last_activity_at=(d->'state'->>'lastActivity')::timestamptz,
   last_score=case when (sc->>'score')::int>0 then (sc->>'score')::int else last_score end,last_signals=case when cardinality(signals)>0 then signals else last_signals end,updated_at=p_at
   where org_id=current_org() and person_id=who returning * into st;
  -- Which kind of device noticed it (the day's timeline says "laptop", "phone" or "browser"), never which one.
  select case when d.platform in ('windows','macos') then 'laptop' when d.platform='chrome' then 'browser' else 'phone' end into device
   from companion_presence s join native_device d on d.id=s.device_id where s.org_id=current_org() and s.person_id=who and s.consent and d.revoked_at is null
   order by s.updated_at desc limit 1;
  if device is null and exists(select 1 from presence_browser b where b.org_id=current_org() and b.person_id=who) then device:='browser'; end if;
  select o.id,o.name into office,office_name from presence_office o where o.org_id=current_org() and o.active and (o.audience is null or who=any(o.audience))
   and o.id in (select s.office_id from companion_presence s where s.person_id=who union select b.office_id from presence_browser b where b.person_id=who) order by o.name limit 1;

  if d->>'action'='auto_check_in' then
   insert into attendance_entry(org_id,person_id,work_date,mode,checked_in_at,late_minutes,client)
   values(current_org(),who,day,'office',(d->>'at')::timestamptz,
    case when (d->>'at')::timestamptz>w.start_at+make_interval(mins=>pol.grace_minutes) then greatest(0,floor(extract(epoch from (d->>'at')::timestamptz-w.start_at)/60))::int else 0 end,
    jsonb_build_object('via','auto','trigger','auto','place',jsonb_build_object('kind','office','id',office,'signal','triangulated'),'confidence',(d->>'confidence')::int,'signals',to_jsonb(signals),'dwellMinutes',pol.presence_dwell_minutes))
   on conflict(org_id,person_id) where checked_out_at is null and not reconciled_open do nothing returning id into checked;
   if checked is not null then
    acted:=acted+1;
    update attendance_presence_state set entry_id=checked,work_date=day,first_confident_at=(d->>'at')::timestamptz,last_confident_at=p_at where org_id=current_org() and person_id=who;
    insert into attendance_event(org_id,person_id,work_date,at,kind,signals,office_id,entry_id,device_kind) values(current_org(),who,day,p_at,'auto_check_in',signals,office,checked,device);
    perform notification_emit(who,'attendance.auto','person',who,'in:'||checked,
     'Checked in at '||to_char((d->>'at')::timestamptz at time zone tz,'HH24:MI')||' · '||coalesce(office_name,'the office')||'. Not right? Tell us on My desk.','/me','attendance');
   end if;
  elsif d->>'action'='arrival' and pol.presence_ask and not exists(select 1 from attendance_event where person_id=who and work_date=day and kind='arrival_asked') then
   insert into notification_reminder(org_id,person_id,work_date,family) values(current_org(),who,day,'checkin') on conflict do nothing;
   select * into rem from notification_reminder where org_id=current_org() and person_id=who and work_date=day and family='checkin' for update;
   if rem.dismissed_at is null and (rem.snoozed_until is null or rem.snoozed_until<=p_at) then
    asked:=notification_emit(who,'attendance.arrival','person',who,rem.id||':arrival','You’re at '||coalesce(office_name,'the office')||'. Check in?','/me?arrived=1','attendance');
    if asked is not null then
     update notification set expires_at=p_at+interval '2 hours' where id=asked;
     update notification_reminder set prompts=least(2,prompts+1),last_at=p_at where id=rem.id;
    end if;
   end if;
   insert into attendance_event(org_id,person_id,work_date,at,kind,signals,office_id,device_kind) values(current_org(),who,day,p_at,'arrival_asked',signals,office,device);
  elsif d->>'action'='break' and e.id is not null then
   -- Away and back: a break, unless the person already recorded one over that time.
   if not exists(select 1 from attendance_break b where b.entry_id=e.id and b.started_at<(d->>'to')::timestamptz and coalesce(b.ended_at,'infinity')>(d->>'from')::timestamptz) then
    insert into attendance_break(org_id,entry_id,person_id,started_at,ended_at,client,end_client)
    values(current_org(),e.id,who,(d->>'from')::timestamptz,(d->>'to')::timestamptz,jsonb_build_object('via','auto','reason','away','signals',to_jsonb(st.last_signals)),jsonb_build_object('via','auto','reason','back'));
    insert into attendance_event(org_id,person_id,work_date,at,kind,detail,signals,office_id,entry_id,device_kind)
    values(current_org(),who,e.work_date,p_at,'break_detected',null,signals,office,e.id,device);
    acted:=acted+1;
   end if;
   -- A day's breaks beyond the company's allowance: HR sees it once.
   if (select coalesce(sum(extract(epoch from b.ended_at-b.started_at)),0)/60 from attendance_break b where b.entry_id=e.id and b.ended_at is not null)>pol.break_allowed_minutes+15 then
    perform attendance_exception_open(who,e.work_date,e.id,'long_break','Breaks longer than the '||pol.break_allowed_minutes||' minutes allowed',
     jsonb_build_object('breaks',(select jsonb_agg(jsonb_build_object('from',b.started_at,'to',b.ended_at,'via',coalesce(b.client->>'via','person')) order by b.started_at) from attendance_break b where b.entry_id=e.id)));
   end if;
  elsif d->>'action'='check_out' and e.id is not null then
   low:=(d->>'confidence')::int<pol.presence_threshold;
   update attendance_entry set checked_out_at=greatest(checked_in_at,(d->>'at')::timestamptz),
    out_client=jsonb_build_object('via','auto','reason',d->>'reason','confidence',(d->>'confidence')::int,'signals',to_jsonb(st.last_signals),'lastSeen',st.last_confident_at,'decidedAt',p_at)
    where id=e.id and checked_out_at is null;
   update attendance_break set ended_at=greatest(started_at,(d->>'at')::timestamptz),end_client=jsonb_build_object('via','auto','reason','checked_out') where entry_id=e.id and ended_at is null;
   insert into attendance_event(org_id,person_id,work_date,at,kind,detail,signals,office_id,entry_id,device_kind)
   values(current_org(),who,e.work_date,p_at,'auto_check_out',d->>'reason',coalesce(st.last_signals,'{}'),office,e.id,device);
   said:=case d->>'reason' when 'left' then 'when you left '||coalesce(office_name,'the office')
    when 'last_activity' then 'when your computer was last in use' when 'left_unanswered' then 'when you left '||coalesce(office_name,'the office')
    else 'at the end of your shift' end;
   perform notification_emit(who,'attendance.auto','person',who,'out:'||e.id,
    'Checked out at '||to_char((d->>'at')::timestamptz at time zone tz,'HH24:MI')||', '||said||'.'||case when low then ' Left at another time? Tell us.' else '' end,
    case when low then '/me?checkout='||e.id else '/me' end,'attendance');
   if low then
    perform attendance_exception_open(who,e.work_date,e.id,case when d->>'reason'='left_unanswered' then 'unanswered' else 'missing_checkout' end,
     case d->>'reason' when 'left_unanswered' then 'Left the office but kept working elsewhere; no answer' when 'last_activity' then 'No check-out; closed at the last activity' else 'No check-out; closed at the end of the shift' end,
     jsonb_build_object('checkedIn',e.checked_in_at,'closedAt',(d->>'at')::timestamptz,'reason',d->>'reason','signals',to_jsonb(coalesce(st.last_signals,'{}')),'lastSeen',st.last_confident_at,'lastActivity',st.last_activity_at,'asked',st.asked_at),
     (d->>'at')::timestamptz);
   end if;
   acted:=acted+1;
  elsif d->>'action'='ask' and e.id is not null and not exists(select 1 from notification n where n.org_id=current_org() and n.person_id=who and n.event_type='attendance.ask'
     and n.created_at>p_at-interval '20 hours') then
   -- Once a session, once a day: "Yes, I left at 18:40" / "Still working" (My desk, the bell, the check-in control).
   asked:=notification_emit(who,'attendance.ask','person',who,'ask:'||e.id,
    case when d->>'kind'='left_early' then 'You left '||coalesce(office_name,'the office')||' at '||to_char((d->>'leftAt')::timestamptz at time zone tz,'HH24:MI')||'. Done for the day?'
     else 'You left '||coalesce(office_name,'the office')||' at '||to_char((d->>'leftAt')::timestamptz at time zone tz,'HH24:MI')||'. Still working?' end,
    '/me?ask='||e.id,'attendance');
   update attendance_presence_state set asked_at=p_at,ask_kind=d->>'kind' where org_id=current_org() and person_id=who;
   insert into attendance_event(org_id,person_id,work_date,at,kind,detail,signals,office_id,entry_id,device_kind) values(current_org(),who,e.work_date,p_at,'asked',d->>'kind',signals,office,e.id,device);
   if asked is not null then update notification set expires_at=p_at+interval '14 hours' where id=asked; end if;
   acted:=acted+1;
  end if;
 end loop;
 perform set_config('pulse.viewer_id',coalesce(viewer,''),true);
 return acted;
end $$;
revoke all on function pulse.attendance_presence_tick(timestamptz,uuid) from public;
grant execute on function pulse.attendance_presence_tick(timestamptz,uuid) to pulse_api,pulse_worker;

-- The person's one-tap answer: "Yes, I left at 18:40" checks out at the time Pulse saw them leave (their word and the
-- signals agree, so it stands without HR); "Still working" keeps the session open and nothing asks again.
create function pulse.attendance_answer(p_entry uuid, p_answer text, p_at timestamptz default clock_timestamp()) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e attendance_entry; st attendance_presence_state; out_at timestamptz;
begin
 if p_answer not in ('left','working') then raise exception 'Answer left or working' using errcode='22023'; end if;
 select * into e from attendance_entry where id=p_entry and org_id=current_org() and person_id=current_viewer() and voided_at is null for update;
 if not found then raise exception 'This session is not yours' using errcode='42501'; end if;
 select * into st from attendance_presence_state where org_id=current_org() and person_id=current_viewer() for update;
 if e.checked_out_at is not null then return jsonb_build_object('ok',true,'already',true,'out',e.checked_out_at); end if;
 if p_answer='left' then
  out_at:=greatest(e.checked_in_at,least(p_at,coalesce(case when st.entry_id=e.id then coalesce(st.absent_since,st.last_confident_at) end,p_at)));
  update attendance_entry set checked_out_at=out_at,out_client=jsonb_build_object('via','answer','reason','left','confidence',80,'signals',to_jsonb(coalesce(st.last_signals,'{}')),'lastSeen',st.last_confident_at,'decidedAt',p_at)
   where id=e.id;
  update attendance_break set ended_at=greatest(started_at,out_at),end_client=jsonb_build_object('via','answer') where entry_id=e.id and ended_at is null;
 end if;
 update attendance_presence_state set answer=p_answer,answered_at=p_at,asked_at=coalesce(asked_at,p_at) where org_id=current_org() and person_id=current_viewer() and entry_id=e.id;
 insert into attendance_event(org_id,person_id,work_date,at,kind,detail,entry_id) values(current_org(),current_viewer(),e.work_date,p_at,'answered',p_answer,e.id);
 -- The question is answered everywhere at once.
 update notification set read_at=coalesce(read_at,p_at),expires_at=least(expires_at,p_at) where org_id=current_org() and person_id=current_viewer() and event_type='attendance.ask' and event_key='ask:'||e.id;
 update attendance_exception set resolved_at=p_at,resolution='by_person' where org_id=current_org() and entry_id=e.id and resolved_at is null and kind in ('unanswered','conflict');
 return jsonb_build_object('ok',true,'answer',p_answer,'out',out_at);
end $$;
revoke all on function pulse.attendance_answer(uuid,text,timestamptz) from public;
grant execute on function pulse.attendance_answer(uuid,text,timestamptz) to pulse_api;

-- Device reports keep their own evidence fresh; the decisions are the person's (attendance_presence_tick). The old
-- per-device departure reminder and its missed-check-out correction are gone (they were the wrong question).
create or replace function pulse.companion_presence_tick(p_device uuid default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r companion_presence; stamp timestamptz:=clock_timestamp(); result jsonb:='{}'; viewer text:=current_setting('pulse.viewer_id',true); sc jsonb; e_open boolean; people uuid[]:='{}'; pid uuid;
begin
 if p_device is null and not pg_has_role(session_user,'pulse_worker','member') then raise exception 'Worker scope required' using errcode='42501';end if;
 if module_off('hr') then return result; end if;
 for r in select s.* from companion_presence s join native_device d on d.id=s.device_id
  where s.org_id=current_org() and s.consent and d.revoked_at is null and d.person_id=s.person_id and d.org_id=s.org_id
  and exists(select 1 from person where id=s.person_id and status='active') and (p_device is null or s.device_id=p_device)
  and (p_device is null or s.person_id=current_viewer()) for update of s skip locked loop
  perform set_config('pulse.viewer_id',r.person_id::text,true);
  sc:=presence_score(presence_signals(r.person_id),stamp);
  update companion_presence set holding_since=case when (sc->>'score')::int>=35 then coalesce(holding_since,stamp) end,
   last_present_at=case when (sc->>'location')::int>0 then stamp else last_present_at end,
   left_at=case when (sc->>'location')::int>0 then null else left_at end where device_id=r.device_id;
  if not r.person_id=any(people) then people:=people||r.person_id; end if;
 end loop;
 -- The scheduled run (worker): every person's decisions, so a dwell completes while the app sleeps.
 if p_device is null then perform attendance_presence_tick(stamp,null); end if;
 if p_device is not null then
  foreach pid in array people loop
   perform set_config('pulse.viewer_id',pid::text,true);
   perform attendance_presence_tick(stamp,pid);
  end loop;
  select s.* into r from companion_presence s where s.device_id=p_device;
  if found then
   sc:=presence_score(presence_signals(r.person_id),stamp);
   select exists(select 1 from attendance_entry where person_id=r.person_id and checked_out_at is null and voided_at is null) into e_open;
   result:=jsonb_build_object('score',(sc->>'score')::int,'signals',sc->'signals','checkedIn',e_open,'dwellMinutes',(select presence_dwell_minutes from hr_policy where org_id=current_org()),
    'lastPresenceAt',r.last_present_at,'leftAt',r.left_at,'dwellStartedAt',r.holding_since,'correctionId',null,'asked',false);
  end if;
 end if;
 perform set_config('pulse.viewer_id',coalesce(viewer,''),true);
 return result;
end $$;

-- The morning safety net (POLISH-2's forgotten check-out) stays for a session the engine left open (an answered
-- "Still working" with nothing after it); the evening "Still checked in?" is gone: the engine decides at the shift's
-- end and its grace, and asks only on a conflict.
create or replace function pulse.attendance_forgotten_tick(p_at timestamptz default clock_timestamp()) returns int
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pol hr_policy; e attendance_entry; w record; tz text:=org_time_zone(current_org()); seen timestamptz; proposed timestamptz;
 closed int:=0; viewer text:=current_setting('pulse.viewer_id',true);
begin
 if not pg_has_role(session_user,'pulse_worker','member') then raise exception 'Worker scope required' using errcode='42501';end if;
 if module_off('hr') then return 0; end if;
 select * into pol from hr_policy where org_id=current_org();
 if not found or not pol.attendance_enabled then return 0; end if;
 perform attendance_presence_tick(p_at,null);
 for e in select a.* from attendance_entry a join person p on p.id=a.person_id and p.status='active'
  where a.org_id=current_org() and a.checked_out_at is null and a.voided_at is null and not a.reconciled_open
  and not exists(select 1 from attendance_correction_time t where t.entry_id=a.id)
  order by a.checked_in_at for update of a skip locked loop
  perform set_config('pulse.viewer_id',e.person_id::text,true);
  select * into w from attendance_shift_window(e.person_id,e.work_date,e.mode);
  if p_at>=greatest(greatest(w.end_at,e.checked_in_at)+interval '4 hours',((e.work_date+1)+time '07:00') at time zone tz)+make_interval(mins=>pol.checkout_grace_minutes) then
   select last_activity_at into seen from attendance_presence_state where org_id=current_org() and person_id=e.person_id and entry_id=e.id;
   proposed:=least(p_at,coalesce(seen,case when e.checked_in_at<w.end_at then w.end_at else e.checked_in_at+interval '1 hour' end));
   insert into attendance_provisional_close(org_id,entry_id,proposed_end,reason) values(e.org_id,e.id,proposed,'day_ended') on conflict(entry_id) do nothing;
   update attendance_entry set reconciled_open=true where id=e.id;
   insert into attendance_event(org_id,person_id,work_date,at,kind,entry_id) values(e.org_id,e.person_id,e.work_date,p_at,'closed_for_review',e.id);
   perform attendance_exception_open(e.person_id,e.work_date,e.id,'missing_checkout','No check-out; held for review the next morning',
    jsonb_build_object('checkedIn',e.checked_in_at,'proposed',proposed,'reason','day_ended'),proposed);
   perform notification_emit(e.person_id,'attendance.checkout','person',e.person_id,'closed:'||e.id,
    'You didn’t check out on '||trim(to_char(e.work_date,'Dy DD Mon'))||'. Pulse noted '||to_char(proposed at time zone tz,'HH24:MI')
    ||' for now: tell us when you left, and HR confirms it.','/me?checkout='||e.id,'attendance');
   closed:=closed+1;
  end if;
 end loop;
 perform set_config('pulse.viewer_id',coalesce(viewer,''),true);
 return closed;
end $$;

-- The scheduled reminders keep "Ready to check in?" (once a day, 0860) and the long-break "Still on your break?";
-- the check-out phases ("Done for the day?", "Still working?") are the engine's now.
do $$
declare
  definition text := pg_get_functiondef('pulse.notification_reminder_tick(timestamptz)'::regprocedure);
  done_phase text := 'if p_at>=r.ends and p_at<r.ends+interval ''15 minutes'' and exists(select 1 from companion_notification_settings where org_id=current_org() and person_id=r.person_id and settings->''reminders''->>''done''=''true'') then phase:=''done'';end if;';
  end_phase text := 'if p_at>=r.ends+interval ''15 minutes'' and p_at<r.ends+interval ''2 hours'' then phase:=''end'';end if;';
begin
  if position(done_phase in definition) = 0 or position(end_phase in definition) = 0 then raise exception 'notification_reminder_tick check-out phases changed'; end if;
  execute replace(replace(definition, done_phase, '-- ATT: check-out phases are the presence engine''s.'), end_phase, '');
end $$;

-- migrate:down
-- Forward-only.
