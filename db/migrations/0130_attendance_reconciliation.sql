-- migrate:up
alter table pulse.attendance_regularisation add column entry_id uuid references pulse.attendance_entry(id);
-- R19 effective records preserve original timestamps, clients and break receipts.
drop index pulse.attendance_open;
create unique index attendance_open on pulse.attendance_entry(org_id,person_id) where checked_out_at is null and not reconciled_open;
create table pulse.attendance_close_policy (
 org_id uuid not null references pulse.org(id), version int not null check(version>0),
 timezone text not null default 'Asia/Kolkata', prompt_minutes int not null default 120 check(prompt_minutes between 0 and 1440),
 cap_minutes int not null default 960 check(cap_minutes between 60 and 2880), minimum_days int not null default 10 check(minimum_days between 10 and 28),
 mode text not null default 'suggestion' check(mode='suggestion'), long_shift_rule text not null default 'No automatic closure; HR reviews long shifts',
 proposed_by uuid references pulse.person(id), approved_by uuid references pulse.person(id), approved_at timestamptz, created_at timestamptz not null default now(), primary key(org_id,version),
 check((approved_by is null)=(approved_at is null))
);
create table pulse.attendance_provisional_close (
 org_id uuid not null references pulse.org(id), entry_id uuid primary key references pulse.attendance_entry(id),
 proposed_end timestamptz not null, reason text not null check(reason='next_check_in'), policy_version int not null default 1,
 created_at timestamptz not null default now()
);
create table pulse.attendance_correction_time (
 org_id uuid not null references pulse.org(id), regularisation_id uuid primary key references pulse.attendance_regularisation(id),
 entry_id uuid not null references pulse.attendance_entry(id), effective_in timestamptz not null, effective_out timestamptz,
 mode text not null check(mode in('office','wfh','field')),late_minutes int not null check(late_minutes>=0), created_at timestamptz not null default now(),
 check(effective_out is null or effective_out>=effective_in)
);
do $$ declare t text;begin
 foreach t in array array['attendance_close_policy','attendance_provisional_close','attendance_correction_time'] loop
 execute format('alter table pulse.%I enable row level security',t);
 execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant_isolation on pulse.%I as restrictive using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('create policy service_access on pulse.%I using(true) with check(true)',t);
 end loop;
end $$;
create policy close_policy_read on pulse.attendance_close_policy for select to pulse_api using(true);
create policy provisional_read on pulse.attendance_provisional_close for select to pulse_api using(exists(select 1 from pulse.attendance_entry e where e.id=entry_id));
create policy correction_time_read on pulse.attendance_correction_time for select to pulse_api using(exists(select 1 from pulse.attendance_entry e where e.id=entry_id));
-- Existing permissive tenant policies are constrained by person visibility too.
create policy provisional_scope on pulse.attendance_provisional_close as restrictive for select to pulse_api using(exists(select 1 from pulse.attendance_entry e where e.id=entry_id));
create policy correction_time_scope on pulse.attendance_correction_time as restrictive for select to pulse_api using(exists(select 1 from pulse.attendance_entry e where e.id=entry_id));
grant select on pulse.attendance_close_policy,pulse.attendance_provisional_close,pulse.attendance_correction_time to pulse_api,pulse_worker;
create or replace view pulse.attendance_effective with(security_invoker=true) as
 select e.org_id,e.id,e.person_id,case when c.kind='late' then e.checked_in_at else coalesce(c.effective_in,e.checked_in_at) end checked_in_at,
 case when c.kind='late' then coalesce(p.proposed_end,e.checked_out_at) when c.regularisation_id is not null then c.effective_out else coalesce(p.proposed_end,e.checked_out_at) end checked_out_at,
 e.work_date,coalesce(c.mode,e.mode) mode,coalesce(c.late_minutes,e.late_minutes) late_minutes,
 case when c.kind='late' then (p.entry_id is not null or e.missed_out) when c.regularisation_id is not null then false else (p.entry_id is not null or e.missed_out) end missed_out,
 case when c.regularisation_id is not null then 'regularised' else e.source end source,e.note,e.client,e.out_client,e.voided_at
 from pulse.attendance_entry e left join pulse.attendance_provisional_close p on p.entry_id=e.id
 left join lateral(select x.*,r.kind from pulse.attendance_correction_time x join pulse.attendance_regularisation r on r.id=x.regularisation_id
 where x.entry_id=e.id and r.status='approved' order by x.created_at desc,x.regularisation_id desc limit 1)c on true where e.voided_at is null;
create function pulse.attendance_propose_close(p_entry uuid,p_end timestamptz) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e attendance_entry;
begin
 select * into e from attendance_entry where id=p_entry and org_id=current_org() and person_id=current_viewer() for update;
 if e.id is null or e.checked_out_at is not null or p_end<e.checked_in_at or p_end>now() then raise exception 'Open self receipt required' using errcode='22023';end if;
 insert into attendance_provisional_close(org_id,entry_id,proposed_end,reason) values(e.org_id,e.id,p_end,'next_check_in') on conflict(entry_id) do nothing;
 update attendance_entry set reconciled_open=true where id=e.id;
end $$;
create function pulse.attendance_accept_time(p_request uuid,p_entry uuid,p_in timestamptz,p_out timestamptz,p_mode text,p_late int) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r attendance_regularisation;e attendance_entry;
begin
 select * into r from attendance_regularisation where id=p_request and org_id=current_org() for update;
 if r.id is null or r.person_id=current_viewer() or not(viewer_is('admin','hr','leadership') or manages(r.person_id) or exists(select 1 from hr_flow where source_id=r.id and stage='cofounder' and hr_is_cofounder())) then raise exception 'Independent correction approval required' using errcode='42501';end if;
 select * into e from attendance_entry where id=p_entry and person_id=r.person_id and work_date=r.work_date and org_id=r.org_id for update;
 if e.id is null then raise exception 'Receipt not found' using errcode='22023';end if;
 if r.kind<>'late' and p_out is null then raise exception 'Give a finish time for the reviewed receipt' using errcode='22023';end if;
 insert into attendance_correction_time(org_id,regularisation_id,entry_id,effective_in,effective_out,mode,late_minutes) values(e.org_id,r.id,e.id,p_in,p_out,p_mode,p_late) on conflict(regularisation_id) do nothing;
 if e.checked_out_at is null and p_out is not null then update attendance_entry set reconciled_open=true where id=e.id;end if;
end $$;
-- Existing HR override/appeal engine changes request status; that selects the effective overlay.
alter function pulse.hr_correction_restore(uuid) rename to hr_correction_restore_legacy;
create function pulse.hr_correction_restore(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin','hr','leadership') then raise exception 'Only HR overrides attendance' using errcode='42501';end if;
 if exists(select 1 from attendance_correction_time where regularisation_id=p_id) then
 if exists(select 1 from attendance_correction_time x join attendance_correction_time y on y.entry_id=x.entry_id join attendance_regularisation r on r.id=y.regularisation_id where x.regularisation_id=p_id and y.created_at>x.created_at and r.status='approved') then raise exception 'Review the later correction first' using errcode='22023';end if;
 -- A rejected overlay on an originally open receipt remains unresolved, never payroll-approved.
 insert into attendance_provisional_close(org_id,entry_id,proposed_end,reason) select e.org_id,e.id,e.checked_in_at,'next_check_in' from attendance_entry e join attendance_correction_time x on x.entry_id=e.id where x.regularisation_id=p_id and e.checked_out_at is null and e.reconciled_open on conflict(entry_id) do nothing;
 else perform hr_correction_restore_legacy(p_id);end if;
end $$;
revoke all on function pulse.attendance_propose_close(uuid,timestamptz),pulse.attendance_accept_time(uuid,uuid,timestamptz,timestamptz,text,int),pulse.hr_correction_restore(uuid) from public;
grant execute on function pulse.attendance_propose_close(uuid,timestamptz),pulse.attendance_accept_time(uuid,uuid,timestamptz,timestamptz,text,int) to pulse_api;
-- Keep the released presence engine using the same effective open-state/index contract.
do $$ declare s text;begin
 s:=pg_get_functiondef('pulse.companion_presence_tick(uuid)'::regprocedure);
 s:=replace(s,'e attendance_entry;','e attendance_effective;');
 s:=replace(s,'select * into e from attendance_entry where','select * into e from attendance_effective where');
 s:=replace(s,'where checked_out_at is null do nothing','where checked_out_at is null and not reconciled_open do nothing');
 execute s;
end $$;
-- Preserve the released approval check and bind its audit effect to an explicitly selected receipt.
do $$ declare s text;begin
 s:=pg_get_functiondef('pulse.hr_correction_bind(uuid)'::regprocedure);
 s:=replace(s,'set new_entry_id=(select e.id','set new_entry_id=coalesce((select entry_id from attendance_correction_time where regularisation_id=p_id),(select e.id');
 s:=replace(s,'order by e.checked_in_at limit 1) where regularisation_id=p_id','order by e.checked_in_at limit 1)) where regularisation_id=p_id');
 execute s;
end $$;
create function pulse.attendance_policy_propose(p_prompt int,p_cap int,p_minimum int,p_timezone text,p_exception text) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v int;
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'HR policy access required' using errcode='42501';end if;
 if not exists(select 1 from pg_timezone_names where name=p_timezone) or length(trim(p_exception))<5 then raise exception 'Timezone and long-shift rule required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('attendance-policy:'||current_org()));
 select coalesce(max(version),1)+1 into v from attendance_close_policy where org_id=current_org();
 insert into attendance_close_policy(org_id,version,timezone,prompt_minutes,cap_minutes,minimum_days,long_shift_rule,proposed_by) values(current_org(),v,p_timezone,p_prompt,p_cap,p_minimum,p_exception,current_viewer());
 return v;
end $$;
revoke all on function pulse.attendance_policy_propose(int,int,int,text,text) from public;
grant execute on function pulse.attendance_policy_propose(int,int,int,text,text) to pulse_api;
-- migrate:down
-- Forward-only attendance records: reversal requires an explicit reviewed migration.
