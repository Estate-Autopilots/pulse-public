-- migrate:up
-- No seed or activation writes: absence of a confirmed version means OFF.
create table pulse.hr_rule_version (
 org_id uuid not null references pulse.org(id), key text not null check(key in('late_marks','half_day','advance_notice','emergency','special_routing','leave_balance','professional_tax','exit')),
 version int not null check(version>0), config jsonb not null check(jsonb_typeof(config)='object'), effective_from date not null,
 confirmed_at timestamptz not null default now(), confirmed_by uuid not null references pulse.person(id), primary key(org_id,key,version)
);
create table pulse.hr_rule_waiver (
 org_id uuid not null references pulse.org(id), person_id uuid not null references pulse.person(id), work_date date not null,
 reason text not null check(length(trim(reason)) between 3 and 500), created_by uuid not null references pulse.person(id),created_at timestamptz not null default now(),primary key(org_id,person_id,work_date)
);
create table pulse.hr_employment (
 org_id uuid not null references pulse.org(id),person_id uuid primary key references pulse.person(id),
 probation_from date,probation_to date,notice_from date,notice_to date,last_working_day date,settlement_target date,
 handover jsonb not null default '[]' check(jsonb_typeof(handover)='array'),
 pt_category text check(pt_category in('men','women')),pt_state text check(pt_state in('MH','other')),pt_exempt boolean not null default false,
 updated_by uuid not null references pulse.person(id),updated_at timestamptz not null default now(),
 check((probation_from is null)=(probation_to is null)),check(probation_to>=probation_from),
 check((notice_from is null)=(notice_to is null)),check(notice_to>=notice_from),check(last_working_day>=notice_from),check(settlement_target>=last_working_day)
);
create table pulse.hr_emergency (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),
 from_date date not null,return_date date not null check(return_date>=from_date),reason text not null check(length(trim(reason)) between 3 and 500),
 notified_at timestamptz not null default now(),reminded_at timestamptz,record_by date not null,leave_id uuid references pulse.leave_request(id),unique(org_id,leave_id)
);
do $$ declare t text;begin
 foreach t in array array['hr_rule_version','hr_rule_waiver','hr_employment','hr_emergency'] loop
 execute format('alter table pulse.%I enable row level security',t);
 execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('grant select on pulse.%I to pulse_api,pulse_worker',t);
 execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;
create policy visible on pulse.hr_rule_waiver as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership'));
create policy visible on pulse.hr_employment as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership'));
create policy visible on pulse.hr_emergency as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.hr_head(person_id)=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership'));
-- API may read versions; writes use confirmation only. Published rate versions cannot be rewritten.
create function pulse.hr_rule_at(p_key text,p_date date) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select config||jsonb_build_object('effectiveFrom',effective_from,'version',version) from hr_rule_version where org_id=current_org() and key=p_key and effective_from<=p_date order by effective_from desc,version desc limit 1
$$;
create function pulse.hr_person_working(p_person uuid,p_day date) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select hr_working(p_person,p_day,coalesce((select s.work_days from person_shift a join shift s on s.id=a.shift_id where a.person_id=p_person and a.mode='office' and a.valid_from<=p_day and (a.valid_to is null or a.valid_to>=p_day) order by a.valid_from desc limit 1),p.work_days)) from hr_policy p where org_id=current_org()
$$;
create function pulse.hr_working_after(p_person uuid,p_from date,p_n int) returns date language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare d date:=p_from;n int:=0;begin
 while n<p_n loop d:=d+1;if hr_person_working(p_person,d) then n:=n+1;end if;if d>p_from+730 then raise exception 'Working pattern has no working days' using errcode='22023';end if;end loop;return d;
end $$;
create function pulse.hr_rule_days(p_person uuid,p_from date,p_to date) returns table(day date,late boolean,half_day boolean,net_minutes numeric,arrival time,complete boolean,remote boolean) language sql stable security definer set search_path=pulse,pg_temp as $$
 with grouped as (
 select e.work_date as day,min(e.checked_in_at) first_in,bool_and(e.checked_out_at is not null and not e.missed_out and e.checked_out_at>=e.checked_in_at and e.checked_out_at<=e.checked_in_at+interval '16 hours') complete,
 (array_agg(e.late_minutes order by e.checked_in_at,e.id))[1]>0 late,
 range_agg(tstzrange(e.checked_in_at,coalesce(e.checked_out_at,e.checked_in_at),'[)')) spans
 from attendance_effective e where e.person_id=p_person and (p_person=current_viewer() or viewer_is('admin','hr','leadership') or manages(p_person)) and e.work_date between p_from and p_to group by e.work_date
 ), data as (
 select g.*,not exists(select 1 from attendance_regularisation r where r.person_id=p_person and r.work_date=g.day and r.status='pending' and r.kind='missed_punch') correction_clear,
 exists(select 1 from attendance_regularisation r where r.person_id=p_person and r.work_date=g.day and r.status='approved' and r.kind in('wfh','on_duty')) remote,
 exists(select 1 from hr_rule_waiver w where w.person_id=p_person and w.work_date=g.day) waived,
 g.spans-coalesce((select range_agg(tstzrange(b.started_at,coalesce(b.ended_at,b.started_at),'[)')) from attendance_break b join attendance_effective e on e.id=b.entry_id where e.person_id=p_person and e.work_date=g.day),'{}'::tstzmultirange) net,
 hr_rule_at('half_day',g.day) half_rule
 from grouped g
 ), measured as (
 select d.*,coalesce((select sum(extract(epoch from upper(r)-lower(r))/60) from unnest(net) r),0) minutes from data d
 )
 select day,late and not waived and hr_person_working(p_person,day),
 half_rule is not null and complete and correction_clear and not remote and hr_person_working(p_person,day) and (minutes<(half_rule->>'netMinutes')::numeric or (first_in at time zone 'Asia/Kolkata')::time>(half_rule->>'arrivalCutoff')::time),
 minutes,(first_in at time zone 'Asia/Kolkata')::time,complete and correction_clear,remote from measured order by day
$$;
create function pulse.hr_late_debit(p_person uuid,p_kind text,p_from date,p_to date) returns numeric language sql stable security definer set search_path=pulse,pg_temp as $$
 with marks as (select d.day,r.config,r.version,case when r.config->>'window'='calendar_week' then date_trunc('week',d.day) else date_trunc('month',d.day) end period
 from hr_rule_days(p_person,date_trunc('month',p_from)::date-6,p_to) d join lateral (select * from hr_rule_version where org_id=current_org() and key='late_marks' and effective_from<=d.day order by effective_from desc,version desc limit 1) r on true
 where d.late and r.config->>'balanceKind'=p_kind), groups as (
 select config,version,period,count(*) n,count(*) filter(where day<p_from) prior from marks group by config,version,period)
 select coalesce(sum((floor(n/(config->>'threshold')::numeric)-floor(prior/(config->>'threshold')::numeric))*(config->>'deduction')::numeric),0) from groups
$$;
-- Legacy calculation takes an explicit as-of date so a transition never reprices earlier monthly credits.
create function pulse.hr_balance_legacy(p_person uuid,p_kind text,p_today date,p_exclude uuid default null,p_cutoff boolean default false) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare p hr_policy;t leave_type;y int;last_y int;first_y int;start_d date;since_d date;joined date;months int;earned numeric;carry numeric:=0;available numeric:=0;used numeric;reserved numeric;adj numeric;
begin
 if current_viewer() is not null and not(p_person=current_viewer() or viewer_is('admin','hr','leadership') or manages(p_person)) then raise exception 'Balance access denied' using errcode='42501';end if;
 select * into p from hr_policy where org_id=current_org();select * into t from leave_type where org_id=current_org() and key=p_kind;
 if t.annual_days is null then return null;end if;
 select joined_on into joined from people_profile where person_id=p_person;
 last_y:=extract(year from p_today)::int-case when extract(month from p_today)<p.leave_year_start then 1 else 0 end;
 first_y:=least(last_y,extract(year from p.tracking_from)::int-case when extract(month from p.tracking_from)<p.leave_year_start then 1 else 0 end);
 for y in first_y..last_y loop
 start_d:=make_date(y,p.leave_year_start,1);since_d:=greatest(start_d,p.tracking_from,joined);
 months:=greatest(0,least(extract(year from start_d)::int*12+extract(month from start_d)::int+10,
 case when t.accrual='monthly' then extract(year from p_today)::int*12+extract(month from p_today)::int-1 else extract(year from start_d)::int*12+extract(month from start_d)::int+10 end)
 -greatest(extract(year from since_d)::int*12+extract(month from since_d)::int-1,extract(year from start_d)::int*12+extract(month from start_d)::int-1)+1);
 earned:=case when t.accrual='none' then t.annual_days else floor(t.annual_days*months/12*2)/2 end;
 select coalesce(sum(days) filter(where status='approved'),0),coalesce(sum(days) filter(where status='pending'),0) into used,reserved from leave_request where org_id=current_org() and person_id=p_person and leave_kind=p_kind and id is distinct from p_exclude and from_date>=start_d and from_date<start_d+interval '1 year';
 select coalesce(sum(days),0) into adj from leave_adjustment where org_id=current_org() and person_id=p_person and type_key=p_kind and leave_year=y and (not p_cutoff or (created_at at time zone 'Asia/Kolkata')::date<=p_today);
 adj:=adj-hr_late_debit(p_person,p_kind,start_d,least(p_today,(start_d+interval '1 year')::date-1));
 available:=earned+carry+adj-used;
 if y<last_y then carry:=least(t.carry_forward_max,greatest(0,available));end if;
 end loop;
 return jsonb_build_object('key',p_kind,'accrued',earned,'carried',carry,'adjusted',adj,'used',used,'pending',reserved,'available',available);
end $$;
create function pulse.hr_balance_rule(p_person uuid,p_kind text,p_today date,p_config jsonb,p_effective date,p_exclude uuid default null) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare opening jsonb;carry numeric;available numeric;earned numeric;used numeric;reserved numeric;adj numeric;start_d date;end_d date;y int;last_y int;joined date;
begin
 if current_viewer() is not null and not(p_person=current_viewer() or viewer_is('admin','hr','leadership') or manages(p_person)) then raise exception 'Balance access denied' using errcode='42501';end if;
 if p_kind<>p_config->>'balanceKind' or p_today<p_effective then return hr_balance_legacy(p_person,p_kind,p_today,p_exclude);end if;
 opening:=hr_balance_legacy(p_person,p_kind,p_effective-1,p_exclude,true);
 -- Only leave before the transition consumes the protected opening amount.
 carry:=coalesce((opening->>'available')::numeric,0)+coalesce((opening->>'used')::numeric,0);
 carry:=carry-coalesce((select sum(case when l.half_day is not null then .5 else 1 end) from leave_request l cross join lateral generate_series(l.from_date,least(l.to_date,p_effective-1),interval '1 day') d where l.person_id=p_person and l.leave_kind=p_kind and l.status='approved' and l.id is distinct from p_exclude and extract(year from l.from_date)::int-case when extract(month from l.from_date)<(select leave_year_start from hr_policy where org_id=current_org()) then 1 else 0 end=extract(year from p_effective-1)::int-case when extract(month from p_effective-1)<(select leave_year_start from hr_policy where org_id=current_org()) then 1 else 0 end and hr_person_working(p_person,d::date)),0);
 select joined_on into joined from people_profile where person_id=p_person;
 y:=extract(year from p_effective)::int-case when extract(month from p_effective)<(p_config->>'yearStart')::int then 1 else 0 end;
 last_y:=extract(year from p_today)::int-case when extract(month from p_today)<(p_config->>'yearStart')::int then 1 else 0 end;
 while y<=last_y loop
 start_d:=greatest(make_date(y,(p_config->>'yearStart')::int,1),p_effective);end_d:=(make_date(y,(p_config->>'yearStart')::int,1)+interval '1 year')::date-1;
 if start_d=make_date(y,(p_config->>'yearStart')::int,1) then carry:=least((p_config->>'carryMax')::numeric,greatest(0,carry));end if;
 select count(*)*(p_config->>'monthlyDays')::numeric into earned from generate_series(date_trunc('month',start_d)::date,least(p_today,end_d),interval '1 month') m where m::date>=greatest(start_d,coalesce(joined,start_d));
 select coalesce(sum(case when l.half_day is not null then .5 else 1 end) filter(where l.status='approved'),0),coalesce(sum(case when l.half_day is not null then .5 else 1 end) filter(where l.status='pending'),0) into used,reserved from leave_request l cross join lateral generate_series(greatest(l.from_date,start_d),least(l.to_date,end_d),interval '1 day') d where l.person_id=p_person and l.leave_kind=p_kind and l.status in('approved','pending') and l.id is distinct from p_exclude and hr_person_working(p_person,d::date);
 select coalesce(sum(days),0) into adj from leave_adjustment where person_id=p_person and type_key=p_kind and leave_year=y and (created_at at time zone 'Asia/Kolkata')::date>=p_effective;
 adj:=adj-hr_late_debit(p_person,p_kind,start_d,least(p_today,end_d));
 available:=carry+earned+adj-used;
 if y<last_y then carry:=available;end if;y:=y+1;
 end loop;
 return jsonb_build_object('key',p_kind,'accrued',earned,'carried',carry,'adjusted',adj,'used',used,'pending',reserved,'available',available);
end $$;
create function pulse.hr_balance_detail(p_person uuid,p_kind text,p_today date,p_exclude uuid default null) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare r jsonb;begin
 r:=hr_rule_at('leave_balance',p_today);
 if r is null then return hr_balance_legacy(p_person,p_kind,p_today,p_exclude);end if;
 return hr_balance_rule(p_person,p_kind,p_today,r,(r->>'effectiveFrom')::date,p_exclude);
end $$;
create or replace function pulse.hr_leave_remaining(p_person uuid,p_kind text,p_exclude uuid default null) returns numeric language sql stable security definer set search_path=pulse,pg_temp as $$
 select (b->>'available')::numeric-(b->>'pending')::numeric from (select hr_balance_detail(p_person,p_kind,(now() at time zone 'Asia/Kolkata')::date,p_exclude) b) x
$$;
create function pulse.hr_balance_preview(p_config jsonb,p_date date) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare rows jsonb;begin
 if not viewer_is('admin','hr','leadership') then raise exception 'HR required' using errcode='42501';end if;
 select coalesce(jsonb_agg(jsonb_build_object('personId',p.id,'name',p.display_name,'before',hr_balance_detail(p.id,p_config->>'balanceKind',p_date),'after',hr_balance_rule(p.id,p_config->>'balanceKind',p_date,p_config,p_date)) order by p.id),'[]') into rows from person p join people_profile pp on pp.person_id=p.id where p.side='staff';
 return jsonb_build_object('rows',rows,'hash',md5(rows::text||p_config::text||p_date::text),'asOf',p_date);
end $$;
create function pulse.hr_rule_validate(p_key text,c jsonb) returns void language plpgsql set search_path=pulse,pg_temp as $$
declare required text[];k text;v jsonb;cat text;last_limit numeric;row jsonb;bands jsonb;begin
 required:=case p_key when 'late_marks' then array['threshold','window','deduction','balanceKind'] when 'half_day' then array['netMinutes','arrivalCutoff','timezone'] when 'advance_notice' then array['shortWorkingDays','longCalendarDays','longFromDays'] when 'emergency' then array['recordWorkingDays','notifyHours'] when 'special_routing' then array['unpaidDays','probationDays'] when 'leave_balance' then array['yearStart','monthlyDays','carryMax','balanceKind'] when 'professional_tax' then array['state','slabs'] when 'exit' then array['confirmedDays','probationDays','settlementDays'] else null end;
 if required is null or jsonb_typeof(c) is distinct from 'object' or exists(select 1 from jsonb_each(c) where value='null'::jsonb) or not c ?& required or (select count(*) from jsonb_object_keys(c))<>cardinality(required) then raise exception 'Complete the rule settings' using errcode='22023';end if;
 for k,v in select key,value from jsonb_each(c) loop
 if k=any(array['threshold','netMinutes','shortWorkingDays','longCalendarDays','longFromDays','recordWorkingDays','notifyHours','unpaidDays','probationDays','confirmedDays','settlementDays','yearStart','monthlyDays','carryMax','deduction']) then
 if jsonb_typeof(v)<>'number' or v::text::numeric<0 or v::text::numeric>730 then raise exception 'Invalid rule number' using errcode='22023';end if;
 if k=any(array['deduction','monthlyDays','carryMax']) then
 if mod(v::text::numeric,.5)<>0 or (k='deduction' and v::text::numeric=0) then raise exception 'Use half days' using errcode='22023';end if;
 elsif v::text::numeric<1 or mod(v::text::numeric,1)<>0 then raise exception 'Use positive integers' using errcode='22023';end if;
 end if;end loop;
 if (p_key='late_marks' and c->>'window' not in('calendar_month','calendar_week')) or (c ? 'balanceKind' and coalesce(c->>'balanceKind','') !~ '^[a-z][a-z0-9_]{1,23}$') or (p_key='half_day' and (c->>'timezone'<>'Asia/Kolkata' or c->>'arrivalCutoff' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')) or (p_key='leave_balance' and (c->>'yearStart')::int>12) then raise exception 'Invalid rule setting' using errcode='22023';end if;
 if p_key='late_marks' and not exists(select 1 from leave_type where key=c->>'balanceKind' and active and paid and annual_days is not null and key<>'comp_off') then raise exception 'Choose a paid balance' using errcode='22023';end if;
 if p_key='professional_tax' then
 if c->>'state'<>'MH' or jsonb_typeof(c->'slabs')<>'array' or jsonb_array_length(c->'slabs')>20 then raise exception 'Invalid PT slabs' using errcode='22023';end if;
 if exists(select 1 from jsonb_array_elements(c->'slabs') s where s->>'category' not in('men','women') or not s ?& array['category','upTo','monthly','february'] or (select count(*) from jsonb_object_keys(s))<>4) then raise exception 'Invalid PT category or slab' using errcode='22023';end if;
 foreach cat in array array['men','women'] loop
 bands:=(select jsonb_agg(s) from jsonb_array_elements(c->'slabs') s where s->>'category'=cat);last_limit:=-1;
 if bands is null then raise exception 'Both PT categories required' using errcode='22023';end if;
 for row in select value from jsonb_array_elements(bands) loop
 if jsonb_typeof(row->'monthly')<>'number' or jsonb_typeof(row->'february')<>'number' or (row->>'monthly')::numeric not between 0 and 2500 or (row->>'february')::numeric not between 0 and 2500 or (row->'upTo'<>'null'::jsonb and (jsonb_typeof(row->'upTo')<>'number' or (row->>'upTo')::numeric<=last_limit)) or last_limit='Infinity'::numeric then raise exception 'Invalid PT slab order or amount' using errcode='22023';end if;
 last_limit:=coalesce((row->>'upTo')::numeric,'Infinity'::numeric);
 end loop;
 if last_limit<>'Infinity'::numeric then raise exception 'PT needs an unlimited final band' using errcode='22023';end if;
 end loop;end if;
end $$;
revoke all on function pulse.hr_rule_validate(text,jsonb) from public;
create function pulse.hr_rule_confirm(p_key text,p_config jsonb,p_date date,p_version int,p_hash text default null) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare latest int;begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'HR required' using errcode='42501';end if;
 if p_date is null or p_date<(now() at time zone 'Asia/Kolkata')::date or jsonb_typeof(p_config) is distinct from 'object' then raise exception 'Use today or a future effective date' using errcode='22023';end if;
 perform hr_rule_validate(p_key,p_config);
 perform pg_advisory_xact_lock(hashtext(current_org()::text||'hr-rules'));
 select coalesce(max(version),0) into latest from hr_rule_version where org_id=current_org() and key=p_key;
 if latest is distinct from p_version then raise exception 'Rule changed; refresh before confirming' using errcode='40001';end if;
 if exists(select 1 from hr_rule_version where org_id=current_org() and key=p_key and effective_from>p_date) then raise exception 'Choose a date on or after the existing version' using errcode='22023';end if;
 if p_key='leave_balance' then
 if latest>0 then raise exception 'The balance transition is already confirmed; use audited balance adjustments' using errcode='22023';end if;
 if not exists(select 1 from leave_type where key=p_config->>'balanceKind' and annual_days is not null and paid and active) then raise exception 'Choose an active paid balance' using errcode='22023';end if;
 lock table leave_request,leave_adjustment,people_profile,person,attendance_entry,attendance_break,attendance_regularisation,attendance_correction_time,attendance_provisional_close,hr_rule_waiver,hr_policy,leave_type,person_shift,shift,hr_work_pattern,holiday,hr_flow in share mode;
 if p_hash is null or p_hash is distinct from hr_balance_preview(p_config,p_date)->>'hash' then raise exception 'Balances changed; preview again before confirming' using errcode='40001';end if;
 end if;
 insert into hr_rule_version(org_id,key,version,config,effective_from,confirmed_by) values(current_org(),p_key,latest+1,p_config,p_date,current_viewer());return latest+1;
end $$;
create function pulse.hr_late_waive(p_person uuid,p_day date,p_reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'HR required' using errcode='42501';end if;
 if not exists(select 1 from person where id=p_person and side='staff') then raise exception 'Choose staff' using errcode='22023';end if;
 insert into hr_rule_waiver(org_id,person_id,work_date,reason,created_by) values(current_org(),p_person,p_day,p_reason,current_viewer()) on conflict(org_id,person_id,work_date) do update set reason=excluded.reason,created_by=excluded.created_by,created_at=now();
end $$;
create function pulse.hr_employment_save(p_person uuid,p_data jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'HR required' using errcode='42501';end if;
 if not exists(select 1 from person where id=p_person and side='staff') then raise exception 'Choose staff' using errcode='22023';end if;
 insert into hr_employment(org_id,person_id,probation_from,probation_to,notice_from,notice_to,last_working_day,settlement_target,handover,pt_category,pt_state,pt_exempt,updated_by)
 values(current_org(),p_person,(p_data->>'probationFrom')::date,(p_data->>'probationTo')::date,(p_data->>'noticeFrom')::date,(p_data->>'noticeTo')::date,(p_data->>'lastWorkingDay')::date,(p_data->>'settlementTarget')::date,coalesce(p_data->'handover','[]'),p_data->>'ptCategory',p_data->>'ptState',coalesce((p_data->>'ptExempt')::boolean,false),current_viewer())
 on conflict(person_id) do update set probation_from=excluded.probation_from,probation_to=excluded.probation_to,notice_from=excluded.notice_from,notice_to=excluded.notice_to,last_working_day=excluded.last_working_day,settlement_target=excluded.settlement_target,handover=excluded.handover,pt_category=excluded.pt_category,pt_state=excluded.pt_state,pt_exempt=excluded.pt_exempt,updated_by=excluded.updated_by,updated_at=now();
end $$;
create function pulse.hr_leave_consecutive(p_person uuid,p_from date,p_to date) returns int language sql stable security definer set search_path=pulse,pg_temp as $$
 with work as (select d::date as day, exists(select 1 from leave_request l where l.person_id=p_person and l.status in('pending','approved') and d::date between l.from_date and l.to_date) away from generate_series(p_from-366,p_to+366,interval '1 day') d where hr_person_working(p_person,d::date)),
 islands as (select *,sum(case when away then 0 else 1 end) over(order by day) grp from work),
 spells as (select grp,count(*) n,bool_or(day between p_from and p_to) touches from islands where away group by grp)
 select coalesce(max(n) filter(where touches),0)::int from spells
$$;
-- Routing runs in the database, including writes from other clients. Existing self-approval guards remain intact.
create function pulse.hr_special_route() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r jsonb;e hr_employment;l leave_request;target text;why text;begin
 if new.kind<>'leave' or new.status<>'pending' then return new;end if;
 r:=hr_rule_at('special_routing',(now() at time zone 'Asia/Kolkata')::date);if r is null then return new;end if;
 select * into l from leave_request where id=new.source_id;select * into e from hr_employment where person_id=new.person_id;
 if l.days>(r->>'unpaidDays')::numeric and exists(select 1 from leave_type where key=l.leave_kind and not paid) then target:='cofounder';why:='long unpaid leave';
 elsif e.notice_from<=l.to_date and e.notice_to>=l.from_date then target:='hr';why:='leave during notice period';
 elsif e.probation_from<=l.to_date and e.probation_to>=l.from_date and hr_leave_consecutive(new.person_id,l.from_date,l.to_date)>(r->>'probationDays')::numeric then target:='hr';why:='probation leave';end if;
 if target is not null then
 new.stage:=case when hr_is_staff(new.person_id) or new.stage='cofounder' then 'cofounder' else target end;
 if not why=any(new.needs_hr) then new.needs_hr:=array_append(new.needs_hr,why);end if;
 end if;return new;
end $$;
create trigger special_route before insert or update on pulse.hr_flow for each row execute function pulse.hr_special_route();
-- Emergency alerts stay inside Pulse and never queue email/Telegram, even after a later connection.
alter table pulse.notification drop constraint notification_telegram_status_check,
 add constraint notification_telegram_status_check check(telegram_status in('recipient_not_connected','queued','sent','failed','disabled'));
create function pulse.hr_emergency_notify(p_from date,p_return date,p_reason text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r jsonb;result uuid;recipient uuid;begin
 r:=hr_rule_at('emergency',(now() at time zone 'Asia/Kolkata')::date);
 if current_viewer() is null or r is null or not exists(select 1 from person where id=current_viewer() and status='active' and side='staff') then raise exception 'Emergency flow is not enabled' using errcode='42501';end if;
 insert into hr_emergency(org_id,person_id,from_date,return_date,reason,record_by) values(current_org(),current_viewer(),p_from,p_return,p_reason,hr_working_after(current_viewer(),p_return,(r->>'recordWorkingDays')::int)) returning id into result;
 for recipient in select id from person where id=hr_head(current_viewer()) or (hr_head(current_viewer()) is null and hr_is_staff(id)) loop
 insert into notification(org_id,person_id,title,href,telegram_status) values(current_org(),recipient,'Emergency leave: '||(select display_name from person where id=current_viewer())||' · '||p_from::text||' → return '||p_return::text,'/people/'||current_viewer()::text,'disabled');end loop;
 return result;
end $$;
-- A scoped read of the HR desk is the reminder: overdue entries stay visible until linked to recorded leave.
create function pulse.hr_emergency_record(p_emergency uuid,p_leave uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from hr_emergency e join leave_request l on l.id=p_leave and l.person_id=e.person_id and l.from_date<=e.from_date and l.to_date<e.return_date where e.id=p_emergency and (e.person_id=current_viewer() or viewer_is('admin','hr','leadership')) and l.status in('pending','approved') and not exists(select 1 from generate_series(e.from_date,e.return_date-1,interval '1 day') d where hr_person_working(e.person_id,d::date) and d::date not between l.from_date and l.to_date)) then raise exception 'Record all working days of the emergency before linking it' using errcode='22023';end if;
 update hr_emergency set leave_id=p_leave where id=p_emergency;
end $$;
do $$ declare f regprocedure;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pulse' and p.proname in('hr_rule_at','hr_person_working','hr_working_after','hr_rule_days','hr_late_debit','hr_balance_legacy','hr_balance_rule','hr_balance_detail','hr_balance_preview','hr_rule_confirm','hr_late_waive','hr_employment_save','hr_special_route','hr_leave_consecutive','hr_emergency_notify','hr_emergency_record') loop
 execute format('revoke all on function %s from public',f);
 if f::text not like '%hr_special_route(%' then execute format('grant execute on function %s to pulse_api',f);end if;
 end loop;
end $$;
create function pulse.hr_leave_notice(p_flow uuid,p_flag jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from hr_flow where id=p_flow and kind='leave' and status='pending' and (person_id=current_viewer() or viewer_is('admin','hr','leadership'))) then raise exception 'Leave access denied' using errcode='42501';end if;
 update hr_flow set details=details||jsonb_build_object('advanceNotice',p_flag) where id=p_flow;
end $$;
-- Only checked definer readers can access this table; an employee may read their own projected payslip.
alter policy salary_reader on pulse_priv.hr_compensation using(pulse.hr_can('hr.salary.read') or person_id=pulse.current_viewer());
create function pulse.hr_payslip_source(p_person uuid,p_month date) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pulse_priv.hr_compensation;e hr_employment;gross numeric;begin
 if current_viewer() is null or (p_person<>current_viewer() and not hr_can('hr.salary.read')) then raise exception 'Salary access denied' using errcode='42501';end if;
 if p_person=current_viewer() and not exists(select 1 from person where id=p_person and side='staff' and status='active') then raise exception 'Employee required' using errcode='42501';end if;
 perform hr_log(p_person,'hr.salary','payslip_projection');
 select * into s from pulse_priv.hr_compensation where org_id=current_org() and person_id=p_person and kind in('current','monthly') and coalesce(effective_from,effective_month)<p_month+interval '1 month' and (effective_to is null or effective_to>=p_month) order by coalesce(effective_from,effective_month) desc,(kind='current') desc,imported_at desc,id desc limit 1;
 if s.id is null then return null;end if;
 select * into e from hr_employment where person_id=p_person;
 gross:=case when s.components ? 'fixed' then (s.components->>'fixed')::numeric+coalesce((s.components->>'variable')::numeric,0)+coalesce((s.components->>'bonus')::numeric,0) else s.amount end;
 return jsonb_build_object('personId',p_person,'name',(select display_name from person where id=p_person),'gross',gross,'ptGross',gross-coalesce((s.components->>'bonus')::numeric,0),'reimbursements',coalesce((s.components->>'reimbursements')::numeric,0),'deductions',coalesce((s.components->>'deductions')::numeric,0),'currency',s.currency,'ptCategory',e.pt_category,'ptState',e.pt_state,'ptExempt',coalesce(e.pt_exempt,false),'sourceId',s.id);
end $$;
revoke all on function pulse.hr_leave_notice(uuid,jsonb),pulse.hr_payslip_source(uuid,date) from public;
grant execute on function pulse.hr_leave_notice(uuid,jsonb),pulse.hr_payslip_source(uuid,date) to pulse_api;
create function pulse.hr_emergency_remind() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e hr_emergency;recipient uuid;n int:=0;begin
 if hr_rule_at('emergency',(now() at time zone 'Asia/Kolkata')::date) is null then return 0;end if;
 if current_viewer() is not null and not viewer_is('admin','hr','leadership') then raise exception 'HR required' using errcode='42501';end if;
 for e in select * from hr_emergency where record_by<(now() at time zone 'Asia/Kolkata')::date and leave_id is null and (reminded_at is null or reminded_at<now()-interval '24 hours') for update skip locked loop
 for recipient in select id from person where status='active' and hr_is_staff(id) loop
 insert into notification(org_id,person_id,title,href,telegram_status) values(current_org(),recipient,'Emergency leave recording is overdue','/hr?tab=policies&view=rules','disabled');n:=n+1;end loop;
 update hr_emergency set reminded_at=now() where id=e.id;
 end loop;return n;
end $$;
revoke all on function pulse.hr_emergency_remind() from public;
grant execute on function pulse.hr_emergency_remind() to pulse_api,pulse_worker;
alter function pulse.hr_flow_remind() rename to hr_flow_remind_base;
create function pulse.hr_flow_remind() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
begin return hr_flow_remind_base()+hr_emergency_remind();end $$;
revoke all on function pulse.hr_flow_remind() from public;
grant execute on function pulse.hr_flow_remind() to pulse_api,pulse_worker;
-- Issued payslips are immutable snapshots; generating a projection never issues one.
create table pulse_priv.hr_payslip (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),
 salary_month date not null,version int not null check(version>0),snapshot jsonb not null,
 issued_by uuid not null references pulse.person(id),issued_at timestamptz not null default now(),unique(org_id,person_id,salary_month,version)
);
alter table pulse_priv.hr_payslip enable row level security;
alter table pulse_priv.hr_payslip force row level security;
create policy tenant on pulse_priv.hr_payslip using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create function pulse.hr_payslip_guard() returns trigger language plpgsql set search_path=pulse,pg_temp as $$
begin raise exception 'Issued payslips are immutable; issue a reviewed new version' using errcode='42501';end $$;
create trigger immutable before update or delete on pulse_priv.hr_payslip for each row execute function pulse.hr_payslip_guard();
revoke all on function pulse.hr_payslip_guard() from public;
create function pulse.hr_payslip_project(p_person uuid,p_month date) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare s jsonb;r jsonb;tax numeric:=0;review boolean:=false;band jsonb;result jsonb;begin
 s:=hr_payslip_source(p_person,p_month);if s is null then return null;end if;
 r:=hr_rule_at('professional_tax',(date_trunc('month',p_month)+interval '1 month'-interval '1 day')::date);
 if r is not null and not (s->>'ptExempt')::boolean then
 if s->>'ptState' is null then review:=true;
 elsif s->>'ptState'='MH' then
 if s->>'ptCategory' is null or s->>'currency'<>'INR' then review:=true;
 else select b into band from jsonb_array_elements(r->'slabs') b where b->>'category'=s->>'ptCategory' and (b->'upTo'='null'::jsonb or (s->>'ptGross')::numeric<=(b->>'upTo')::numeric) limit 1;
 if band is null then review:=true;else tax:=(band->>case when extract(month from p_month)=2 then 'february' else 'monthly' end)::numeric;end if;
 end if;end if;end if;
 result:=s||jsonb_build_object('month',to_char(p_month,'YYYY-MM'),'professionalTax',tax,'ptReview',review,'ptVersion',(r->>'version')::int,'net',case when review then null else (s->>'gross')::numeric+(s->>'reimbursements')::numeric-(s->>'deductions')::numeric-tax end,'projection',true);
 return result||jsonb_build_object('previewHash',md5(result::text));
end $$;
-- The source logs every read, so the projector cannot be STABLE (hr_log inserts an access receipt).
alter function pulse.hr_payslip_project(uuid,date) volatile;
create function pulse.hr_payslip_issue(p_person uuid,p_month date,p_hash text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare projected jsonb;v int;result uuid;begin
 if not hr_can('hr.salary.write') or not hr_can('hr.salary.read') then raise exception 'Salary write permission required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtext(current_org()::text||'hr-rules'));
 perform pg_advisory_xact_lock(hashtext(current_org()::text||p_person::text||p_month::text||'payslip'));
 projected:=hr_payslip_project(p_person,p_month);
 if projected is null or (projected->>'ptReview')::boolean then raise exception 'Complete HR tax inputs and salary before issuing' using errcode='22023';end if;
 if p_hash is null or p_hash is distinct from projected->>'previewHash' then raise exception 'Salary or tax changed; review the projection again' using errcode='40001';end if;
 select coalesce(max(version),0)+1 into v from pulse_priv.hr_payslip where person_id=p_person and salary_month=date_trunc('month',p_month)::date;
 insert into pulse_priv.hr_payslip(org_id,person_id,salary_month,version,snapshot,issued_by)
 values(current_org(),p_person,date_trunc('month',p_month)::date,v,(projected-'previewHash')||jsonb_build_object('projection',false),current_viewer()) returning id into result;
 perform audit_write('payslip_issued','person',p_person::text);
 return jsonb_build_object('id',result,'version',v);
end $$;
create function pulse.hr_payslip_read(p_person uuid,p_month date) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or (p_person<>current_viewer() and not hr_can('hr.salary.read')) then raise exception 'Salary access denied' using errcode='42501';end if;
 perform hr_log(p_person,'hr.salary','issued_payslip');
 return (select snapshot||jsonb_build_object('id',id,'payslipVersion',version,'issuedAt',issued_at) from pulse_priv.hr_payslip where person_id=p_person and salary_month=date_trunc('month',p_month)::date order by version desc limit 1);
end $$;
revoke all on function pulse.hr_payslip_project(uuid,date),pulse.hr_payslip_issue(uuid,date,text),pulse.hr_payslip_read(uuid,date) from public;
grant execute on function pulse.hr_payslip_project(uuid,date),pulse.hr_payslip_issue(uuid,date,text),pulse.hr_payslip_read(uuid,date) to pulse_api;
-- migrate:down
-- Retain confirmed rules and audit history; forward-only migration.
