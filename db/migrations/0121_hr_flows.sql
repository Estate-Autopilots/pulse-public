-- migrate:up
alter table pulse.hr_ticket add column approval_outcome text check(approval_outcome in('approved','rejected','cancelled'));
-- Preserve attendance when an HR override reverses an already-applied correction.
alter table pulse.attendance_entry add column voided_at timestamptz;
create view pulse.attendance_effective with(security_invoker=true) as select * from pulse.attendance_entry where voided_at is null;
grant select on pulse.attendance_effective to pulse_api,pulse_worker;
-- The existing attendance writer locks rows through this filtered view.
grant update on pulse.attendance_effective to pulse_api;
create table pulse.hr_correction_effect (
 org_id uuid not null references pulse.org(id),regularisation_id uuid primary key references pulse.attendance_regularisation(id),
 previous_entry jsonb,new_entry_id uuid references pulse.attendance_entry(id),created_at timestamptz not null default now()
);
alter table pulse.hr_correction_effect enable row level security;
alter table pulse.hr_correction_effect force row level security;
create policy tenant_isolation on pulse.hr_correction_effect using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create function pulse.hr_correction_capture(p_id uuid,p_entry uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r attendance_regularisation;
begin
 select * into r from attendance_regularisation where id=p_id and org_id=current_org();
 if r.id is null or r.person_id=current_viewer() or not(viewer_is('admin','hr','leadership') or manages(r.person_id) or exists(select 1 from hr_flow where source_id=r.id and stage='cofounder' and hr_is_cofounder())) then raise exception 'Correction approval required' using errcode='42501';end if;
 insert into hr_correction_effect(org_id,regularisation_id,previous_entry) values(current_org(),p_id,(select to_jsonb(e) from attendance_entry e where e.id=p_entry and e.person_id=r.person_id and e.work_date=r.work_date)) on conflict(regularisation_id) do nothing;
end $$;
create function pulse.hr_correction_bind(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from attendance_regularisation r where r.id=p_id and r.person_id<>current_viewer() and (viewer_is('admin','hr','leadership') or manages(r.person_id) or exists(select 1 from hr_flow where source_id=r.id and stage='cofounder' and hr_is_cofounder()))) then raise exception 'Correction approval required' using errcode='42501';end if;
 update hr_correction_effect x set new_entry_id=(select e.id from attendance_entry e join attendance_regularisation r on r.person_id=e.person_id and r.work_date=e.work_date where r.id=p_id and e.voided_at is null order by e.checked_in_at limit 1) where regularisation_id=p_id;
end $$;
create function pulse.hr_correction_restore(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e hr_correction_effect;s jsonb;
begin
 if not viewer_is('admin','hr','leadership') then raise exception 'Only HR overrides attendance' using errcode='42501';end if;
 select * into e from hr_correction_effect where regularisation_id=p_id; if e.regularisation_id is null then raise exception 'This older correction has no saved original; file a new correction for this day' using errcode='22023';end if;
 if exists(select 1 from hr_correction_effect x join attendance_regularisation r on r.id=x.regularisation_id where x.new_entry_id=e.new_entry_id and x.created_at>e.created_at and r.status='approved') then raise exception 'A later correction covers this day; review it first' using errcode='22023';end if;
 s:=e.previous_entry;
 if s is null then
 if exists(select 1 from hr_comp_credit c join attendance_regularisation r on r.person_id=c.person_id and r.work_date=c.earned_on join hr_comp_use u on u.credit_id=c.id where r.id=p_id group by c.id having sum(u.days)>0) then raise exception 'Comp-off from this day was used; correct that leave first' using errcode='22023';end if;
 update attendance_entry set voided_at=now(),checked_out_at=coalesce(checked_out_at,checked_in_at) where id=e.new_entry_id;
 else
 update attendance_entry set checked_in_at=(s->>'checked_in_at')::timestamptz,checked_out_at=(s->>'checked_out_at')::timestamptz,
 mode=s->>'mode',late_minutes=(s->>'late_minutes')::int,missed_out=(s->>'missed_out')::boolean,source=s->>'source',note=s->>'note',voided_at=null where id=e.new_entry_id;
 end if;
end $$;
revoke all on function pulse.hr_correction_capture(uuid,uuid),pulse.hr_correction_bind(uuid),pulse.hr_correction_restore(uuid) from public;
grant execute on function pulse.hr_correction_capture(uuid,uuid),pulse.hr_correction_bind(uuid) to pulse_api;
-- One shared approval record wraps the existing leave, correction and HR ticket records.
create table pulse.hr_flow_policy (
 org_id uuid primary key references pulse.org(id),
 leave_approver text not null default 'pod_head' check(leave_approver in('pod_head','hr','cofounder')),
 correction_approver text not null default 'pod_head' check(correction_approver in('pod_head','hr','cofounder')),
 work_approver text not null default 'pod_head' check(work_approver in('pod_head','hr','cofounder')),
 request_approver text not null default 'pod_head' check(request_approver in('pod_head','hr','cofounder')),
 max_leave_days numeric not null default 3 check(max_leave_days between 0.5 and 366),
 balance_buffer numeric not null default 0 check(balance_buffer between 0 and 60),
 comp_credit numeric not null default 1 check(comp_credit in(0,0.5,1)),
 comp_expiry_days int not null default 90 check(comp_expiry_days between 1 and 730),
 reminder_hours int not null default 24 check(reminder_hours between 1 and 168),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now()
);
create table pulse.hr_cofounder (
 org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),
 active boolean not null default true,assigned_by uuid not null references pulse.person(id),assigned_at timestamptz not null default now(),
 primary key(org_id,person_id)
);
create table pulse.hr_pod (
 org_id uuid not null references pulse.org(id),name text not null check(length(trim(name)) between 1 and 80),
 head_id uuid not null references pulse.person(id),updated_by uuid not null references pulse.person(id),updated_at timestamptz not null default now(),primary key(org_id,name)
);
create table pulse.hr_work_pattern (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),
 work_days int[] not null check(cardinality(work_days) between 1 and 6 and work_days <@ array[1,2,3,4,5,6,7]),
 valid_from date not null,valid_to date,reason text not null check(length(trim(reason)) between 3 and 500),
 superseded_at timestamptz,changed_by uuid not null references pulse.person(id),created_at timestamptz not null default now(),check(valid_to is null or valid_to>=valid_from)
);
create table pulse.hr_flow (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),
 kind text not null check(kind in('leave','correction','work','request')),source_id uuid not null,
 from_date date not null,to_date date not null,subject text not null,note text,details jsonb not null default '{}',
 status text not null default 'pending' check(status in('pending','approved','rejected','cancelled')),
 stage text not null default 'pod_head' check(stage in('pod_head','hr','cofounder')),
 needs_hr text[] not null default '{}',decided_by uuid references pulse.person(id),decision_note text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),reminded_at timestamptz,
 unique(org_id,kind,source_id),check(to_date>=from_date)
);
create table pulse.hr_flow_event (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),flow_id uuid not null references pulse.hr_flow(id),
 actor_id uuid references pulse.person(id),action text not null,note text,created_at timestamptz not null default now()
);
create table pulse.hr_comp_credit (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),
 flow_id uuid not null references pulse.hr_flow(id),earned_on date not null,expires_on date not null,days numeric not null check(days>0),
 created_at timestamptz not null default now(),unique(org_id,person_id,earned_on),check(expires_on>=earned_on)
);
create table pulse.hr_comp_use (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),credit_id uuid not null references pulse.hr_comp_credit(id),
 leave_id uuid not null references pulse.leave_request(id),days numeric not null check(days<>0),created_at timestamptz not null default now()
);
create table pulse.hr_mail_outbox (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),notification_id uuid not null references pulse.notification(id),
 person_id uuid not null references pulse.person(id),status text not null default 'queued' check(status in('queued','sent','disabled','failed','sink')),
 created_at timestamptz not null default now(),unique(notification_id)
);
create function pulse.hr_is_cofounder(p_person uuid default pulse.current_viewer()) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from hr_cofounder where org_id=current_org() and person_id=p_person and active)
$$;
create function pulse.hr_is_staff(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from role_assignment where org_id=current_org() and person_id=p_person and role_key in('hr','admin','leadership') and current_date between valid_from and coalesce(valid_to,'infinity'))
$$;
create function pulse.hr_head(p_person uuid) returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select h.head_id from hr_pod h join people_profile pp on pp.org_id=h.org_id and pp.pod=h.name where pp.person_id=p_person),
 (select manager_id from people_profile where org_id=current_org() and person_id=p_person))
$$;
-- Confirmed pod heads augment the existing explicit reporting lines and unit assignments.
create or replace function pulse.manages(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and p_person<>current_viewer() and (
 coalesce(hr_head(p_person)=current_viewer(),false) or exists(select 1 from role_assignment r join unit u on u.id=r.unit_id join people_profile target on target.person_id=p_person
 where r.org_id=current_org() and r.person_id=current_viewer() and (r.is_manager_of_unit or r.role_key in('manager','pgs','head_pgs'))
 and current_date between r.valid_from and coalesce(r.valid_to,'infinity') and u.valid_to is null and target.pod=u.name))
$$;
create function pulse.hr_flow_visible(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from hr_flow where org_id=current_org() and id=p_id and
 (person_id=current_viewer() or viewer_is('admin','hr','leadership') or hr_head(person_id)=current_viewer() or (stage='cofounder' and hr_is_cofounder())))
$$;
do $$ declare t text; begin
 foreach t in array array['hr_flow_policy','hr_cofounder','hr_pod','hr_work_pattern','hr_flow','hr_flow_event','hr_comp_credit','hr_comp_use','hr_mail_outbox'] loop
 execute format('alter table pulse.%I enable row level security',t);
 execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant_isolation on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('grant select on pulse.%I to pulse_api,pulse_worker',t);
 end loop;
 foreach t in array array['hr_flow_policy','hr_cofounder','hr_pod'] loop
 execute format('grant insert,update on pulse.%I to pulse_api',t);
 execute format('create policy hr_write on pulse.%I as restrictive for insert to pulse_api with check(pulse.viewer_is(''admin'',''hr'',''leadership'') and pulse.current_viewer() is not null)',t);
 execute format('create policy hr_update on pulse.%I as restrictive for update to pulse_api using(pulse.viewer_is(''admin'',''hr'',''leadership'')) with check(pulse.viewer_is(''admin'',''hr'',''leadership''))',t);
 execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;
create policy visible on pulse.hr_flow as restrictive to pulse_api using(pulse.hr_flow_visible(id));
create policy visible on pulse.hr_flow_event as restrictive to pulse_api using(pulse.hr_flow_visible(flow_id));
create trigger audit_mutation after insert or update on pulse.hr_work_pattern for each row execute function pulse.audit_mutation();
create policy visible on pulse.hr_work_pattern as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.manages(person_id) or pulse.viewer_is('admin','hr','leadership'));
create policy visible on pulse.hr_comp_credit as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership'));
create policy visible on pulse.hr_comp_use as restrictive to pulse_api using(exists(select 1 from pulse.hr_comp_credit c where c.id=credit_id));
create policy visible on pulse.hr_mail_outbox as restrictive to pulse_api using(pulse.viewer_is('admin','hr','leadership'));
grant update(status) on pulse.hr_mail_outbox to pulse_worker;
-- Ledger, request and history writes go through the checked functions; no DELETE grants.
create function pulse.hr_flow_defaults() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform hr_defaults();
 insert into hr_flow_policy(org_id) values(current_org()) on conflict do nothing;
 insert into leave_type(org_id,key,name,paid,annual_days,accrual,carry_forward_max,sort)
 values(current_org(),'comp_off','Comp-off',true,0,'none',0,4) on conflict do nothing;
end $$;
create function pulse.hr_work_days(p_person uuid,p_day date,p_fallback int[]) returns int[] language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select work_days from hr_work_pattern where org_id=current_org() and person_id=p_person and superseded_at is null and valid_from<=p_day and (valid_to is null or valid_to>=p_day) order by valid_from desc limit 1),p_fallback)
$$;
create function pulse.hr_working(p_person uuid,p_day date,p_fallback int[]) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from hr_flow where person_id=p_person and org_id=current_org() and kind='work' and status='approved' and from_date=p_day)
 or (extract(isodow from p_day)::int=any(hr_work_days(p_person,p_day,p_fallback)) and not exists(select 1 from holiday where org_id=current_org() and day=p_day and not optional))
$$;
create function pulse.hr_pattern_set(p_person uuid,p_days int[],p_from date,p_to date,p_note text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result uuid;
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'HR required' using errcode='42501';end if;
 if not exists(select 1 from person where id=p_person and org_id=current_org() and side='staff' and status='active') then raise exception 'Active person required' using errcode='22023';end if;
 if p_from<(now() at time zone 'Asia/Kolkata')::date then raise exception 'Patterns start today or later' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('hr-pattern:'||p_person));
 if exists(select 1 from hr_work_pattern where person_id=p_person and superseded_at is null and valid_from>p_from and valid_from<=coalesce(p_to,'infinity')) then raise exception 'Choose dates before the next scheduled pattern' using errcode='22023';end if;
 update hr_work_pattern set superseded_at=now() where person_id=p_person and superseded_at is null and valid_from=p_from;
 update hr_work_pattern set valid_to=p_from-1 where person_id=p_person and superseded_at is null and valid_from<p_from and coalesce(valid_to,'infinity')>=p_from;
 insert into hr_work_pattern(org_id,person_id,work_days,valid_from,valid_to,reason,changed_by) values(current_org(),p_person,p_days,p_from,p_to,p_note,current_viewer()) returning id into result;
 perform audit_write('hr_work_pattern','person',p_person::text);return result;
end $$;
create function pulse.hr_flow_publish() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare recipient uuid;nid uuid;label text;act text;
begin
 if TG_OP='UPDATE' and (new.status,new.stage,new.decision_note,new.decided_by) is not distinct from (old.status,old.stage,old.decision_note,old.decided_by) then return null;end if;
 act:=case when TG_OP='INSERT' and current_viewer() is null then 'imported' when TG_OP='INSERT' then case when new.status='pending' then 'submitted' else 'recorded: '||new.status end when new.status<>old.status then new.status when new.status<>'pending' then 'override: '||new.status when new.stage<>old.stage then 'forwarded to '||new.stage else 'asked' end;
 insert into hr_flow_event(org_id,flow_id,actor_id,action,note) values(new.org_id,new.id,current_viewer(),act,case when TG_OP='INSERT' then new.note else new.decision_note end);
 if current_viewer() is null then return null;end if;
 label:='HR request '||case when new.status<>'pending' then new.status when TG_OP='INSERT' then 'submitted' when new.stage='cofounder' then 'forwarded' else 'updated' end;
 for recipient in select distinct id from person where org_id=new.org_id and status='active' and
 (id=new.person_id or id=hr_head(new.person_id) or hr_is_staff(id) or (new.stage='cofounder' and hr_is_cofounder(id))) loop
 insert into notification(org_id,person_id,title,href,telegram_status) values(new.org_id,recipient,label,'/me/approvals?request='||new.id,
 case when exists(select 1 from pulse_priv.telegram_person where org_id=new.org_id and person_id=recipient) then 'queued' else 'recipient_not_connected' end) returning id into nid;
 insert into hr_mail_outbox(org_id,notification_id,person_id) values(new.org_id,nid,recipient);
 end loop;return null;
end $$;
create trigger publish after insert or update on pulse.hr_flow for each row execute function pulse.hr_flow_publish();
-- Use the same annual/monthly accrual, carry and adjustment rules as the existing HR desk.
create function pulse.hr_leave_remaining(p_person uuid,p_kind text,p_exclude uuid default null) returns numeric language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare p hr_policy;t leave_type;y int;last_y int;first_y int;start_d date;since_d date;today date:=(now() at time zone 'Asia/Kolkata')::date;joined date;months int;earned numeric;carry numeric:=0;available numeric:=0;used numeric;reserved numeric;adj numeric;
begin
 select * into p from hr_policy where org_id=current_org();select * into t from leave_type where org_id=current_org() and key=p_kind;
 if t.annual_days is null then return null;end if;
 select joined_on into joined from people_profile where person_id=p_person;
 last_y:=extract(year from today)::int-case when extract(month from today)<p.leave_year_start then 1 else 0 end;
 first_y:=least(last_y,extract(year from p.tracking_from)::int-case when extract(month from p.tracking_from)<p.leave_year_start then 1 else 0 end);
 for y in first_y..last_y loop
 start_d:=make_date(y,p.leave_year_start,1);since_d:=greatest(start_d,p.tracking_from,joined);
 months:=greatest(0,least(extract(year from start_d)::int*12+extract(month from start_d)::int+10,
 case when t.accrual='monthly' then extract(year from today)::int*12+extract(month from today)::int-1 else extract(year from start_d)::int*12+extract(month from start_d)::int+10 end)
 -greatest(extract(year from since_d)::int*12+extract(month from since_d)::int-1,extract(year from start_d)::int*12+extract(month from start_d)::int-1)+1);
 earned:=case when t.accrual='none' then t.annual_days else floor(t.annual_days*months/12*2)/2 end;
 select coalesce(sum(days) filter(where status='approved'),0),coalesce(sum(days) filter(where status='pending'),0) into used,reserved from leave_request where org_id=current_org() and person_id=p_person and leave_kind=p_kind and id is distinct from p_exclude and from_date>=start_d and from_date<start_d+interval '1 year';
 select coalesce(sum(days),0) into adj from leave_adjustment where org_id=current_org() and person_id=p_person and type_key=p_kind and leave_year=y;
 available:=earned+carry+adj-used;carry:=least(t.carry_forward_max,greatest(0,available));
 end loop;
 return available-reserved;
end $$;
revoke all on function pulse.hr_leave_remaining(uuid,text,uuid) from public;
create function pulse.hr_flow_source() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k text;f hr_flow;pol hr_flow_policy;sub text;d1 date;d2 date;why text[]:='{}';route text;st text;dn text;
begin
 perform hr_flow_defaults();select * into pol from hr_flow_policy where org_id=new.org_id;
 k:=case TG_TABLE_NAME when 'leave_request' then 'leave' when 'attendance_regularisation' then 'correction' else 'request' end;
 select * into f from hr_flow where org_id=new.org_id and kind=k and source_id=new.id for update;
 if TG_OP='INSERT' then
 if k='leave' then d1:=new.from_date;d2:=new.to_date;sub:=new.leave_kind||' leave';
 if new.leave_kind<>'comp_off' and pulse.hr_leave_remaining(new.person_id,new.leave_kind,new.id)+pol.balance_buffer<new.days then why:=array_append(why,'beyond balance');end if;
 if new.days>pol.max_leave_days then why:=array_append(why,'long leave');end if;
 if exists(select 1 from leave_type where org_id=new.org_id and key=new.leave_kind and not paid) then why:=array_append(why,'unpaid leave');end if;
 if exists(select 1 from leave_type where org_id=new.org_id and key=new.leave_kind and (key ~ '(special|emergency)' or name ~* '(special|emergency)')) then why:=array_append(why,'special or emergency leave');end if;
 route:=pol.leave_approver;
 elsif k='correction' then d1:=new.work_date;d2:=d1;sub:=new.kind||' attendance correction';route:=pol.correction_approver;
 else d1:=(now() at time zone 'Asia/Kolkata')::date;d2:=d1;sub:=new.subject;route:=pol.request_approver;
 if new.category='payroll' then why:=array_append(why,'salary affecting');end if;
 end if;
 if hr_is_staff(new.person_id) then route:='cofounder';elsif cardinality(why)>0 or hr_head(new.person_id) is null or hr_head(new.person_id)=new.person_id then route:='hr';end if;
 if k<>'request' then
 if new.status in('approved','rejected') and current_viewer() is not null and (current_viewer()=new.person_id or not viewer_is('admin','hr','leadership') or (route='cofounder' and not hr_is_cofounder())) then raise exception 'An authorized person must decide this request' using errcode='42501';end if;
 end if;
 insert into hr_flow(org_id,person_id,kind,source_id,from_date,to_date,subject,note,stage,needs_hr,status,decided_by,decision_note,details)
 values(new.org_id,new.person_id,k,new.id,d1,d2,sub,case when k='request' then to_jsonb(new)->>'body' else to_jsonb(new)->>'reason' end,route,why,
 case when k='request' then 'pending' else new.status end,(to_jsonb(new)->>'decided_by')::uuid,to_jsonb(new)->>'decision_note',jsonb_strip_nulls(jsonb_build_object('days',to_jsonb(new)->'days','halfDay',to_jsonb(new)->'half_day','leaveKind',to_jsonb(new)->'leave_kind','inTime',to_jsonb(new)->'in_time','outTime',to_jsonb(new)->'out_time','category',to_jsonb(new)->'category')));
 elsif new.status is distinct from old.status then
 if k='leave' then perform pg_advisory_xact_lock(hashtext('hr-leave:'||new.person_id));end if;
 st:=case when k='request' then case new.status when 'resolved' then 'approved' when 'closed' then case when to_jsonb(new)->>'approval_outcome'='rejected' then 'rejected' else 'cancelled' end else 'pending' end else new.status end;
 dn:=case when k='request' then to_jsonb(new)->>'resolution' else to_jsonb(new)->>'decision_note' end;
 if f.id is not null and (st in('approved','rejected') or (st='cancelled' and current_viewer()<>new.person_id)) and current_viewer() is not null then
 if st='rejected' and length(trim(coalesce(dn,'')))<3 then raise exception 'Give a reason for rejection' using errcode='22023';end if;
 if f.status<>'pending' and not viewer_is('admin','hr','leadership') then raise exception 'Only HR can override a decision' using errcode='42501';end if;
 if current_viewer()=new.person_id then raise exception 'Nobody approves their own request' using errcode='42501';end if;
 if f.stage='cofounder' and not hr_is_cofounder() and not(viewer_is('admin','hr','leadership') and f.status<>'pending') then raise exception 'Assigned co-founder decision required' using errcode='42501';end if;
 if f.stage='hr' and not viewer_is('admin','hr','leadership') then raise exception 'Needs HR' using errcode='42501';end if;
 if k='leave' then
 if st='approved' and f.stage='pod_head' and not viewer_is('admin','hr','leadership') and (new.days>pol.max_leave_days or (new.leave_kind<>'comp_off' and pulse.hr_leave_remaining(new.person_id,new.leave_kind,new.id)+pol.balance_buffer<new.days)) then raise exception 'Balance or threshold changed; HR must decide' using errcode='22023';end if;
 end if;
 if f.stage='pod_head' and not(viewer_is('admin','hr','leadership') or hr_head(new.person_id)=current_viewer()) then raise exception 'Outside your pod' using errcode='42501';end if;
 if (f.status<>'pending' or (viewer_is('admin','hr','leadership') and f.stage='pod_head')) and length(trim(coalesce(dn,'')))<3 then raise exception 'HR override requires a reason' using errcode='22023';end if;
 end if;
 if f.status<>'pending' and st='pending' and k<>'request' then raise exception 'A decided request cannot be reopened' using errcode='22023';end if;
 update hr_flow set status=st,decided_by=current_viewer(),decision_note=dn,updated_at=now() where id=f.id;
 end if;return null;
end $$;
create trigger hr_flow_source after insert or update on pulse.leave_request for each row execute function pulse.hr_flow_source();
create trigger hr_flow_source after insert or update on pulse.attendance_regularisation for each row execute function pulse.hr_flow_source();
create trigger hr_flow_source after insert or update on pulse.hr_ticket for each row execute function pulse.hr_flow_source();
-- Shared publishing supersedes the old person-only notification triggers without deleting records.
drop trigger notify_decision on pulse.leave_request;
drop trigger notify_decision on pulse.attendance_regularisation;
create function pulse.hr_work_request(p_day date,p_note text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result uuid;route text;days int[];
begin
 perform hr_flow_defaults();
 if current_viewer() is null or not exists(select 1 from person where id=current_viewer() and status='active' and side='staff') then raise exception 'Personal staff sign-in required' using errcode='42501';end if;
 if p_day<(now() at time zone 'Asia/Kolkata')::date or p_day>(now() at time zone 'Asia/Kolkata')::date+366 then raise exception 'Choose today or a day within a year' using errcode='22023';end if;
 select work_days into days from hr_policy where org_id=current_org();
 -- Assigned shifts remain the fallback; a standing pattern takes precedence.
 select coalesce((select s.work_days from person_shift a join shift s on s.id=a.shift_id where a.person_id=current_viewer() and a.mode='office' and a.valid_from<=p_day and (a.valid_to is null or a.valid_to>=p_day) order by a.valid_from desc limit 1),days) into days;
 if hr_working(current_viewer(),p_day,days) then raise exception 'This is already a working day' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('hr-work:'||current_viewer()));
 if exists(select 1 from hr_flow where person_id=current_viewer() and kind='work' and from_date=p_day and status in('pending','approved')) then raise exception 'You already requested this day' using errcode='23505';end if;
 if exists(select 1 from hr_comp_credit where person_id=current_viewer() and earned_on=p_day) then raise exception 'This worked day has a credit already; ask HR to correct its original request' using errcode='22023';end if;
 if exists(select 1 from leave_request where person_id=current_viewer() and status in('pending','approved') and p_day between from_date and to_date) then raise exception 'Leave already covers this day' using errcode='22023';end if;
 select work_approver into route from hr_flow_policy where org_id=current_org();
 if hr_is_staff(current_viewer()) then route:='cofounder';elsif hr_head(current_viewer()) is null or hr_head(current_viewer())=current_viewer() then route:='hr';end if;
 insert into hr_flow(org_id,person_id,kind,source_id,from_date,to_date,subject,note,stage) values(current_org(),current_viewer(),'work',gen_random_uuid(),p_day,p_day,'Work on '||p_day,p_note,route) returning id into result;
 return result;
end $$;
create function pulse.hr_comp_balance(p_person uuid,p_day date) returns numeric language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(sum(c.days-coalesce((select sum(u.days) from hr_comp_use u where u.credit_id=c.id),0)),0) from hr_comp_credit c
 where (p_person=current_viewer() or viewer_is('admin','hr','leadership') or manages(p_person) or (hr_is_cofounder() and exists(select 1 from hr_flow f where f.person_id=p_person and f.kind='leave' and f.stage='cofounder'))) and c.org_id=current_org() and c.person_id=p_person and c.expires_on>=p_day and c.earned_on<=p_day
 and exists(select 1 from hr_flow f where f.id=c.flow_id and f.status='approved')
 and exists(select 1 from attendance_entry e where e.person_id=c.person_id and e.work_date=c.earned_on and e.voided_at is null)
$$;
create function pulse.hr_comp_accrue() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 insert into hr_comp_credit(org_id,person_id,flow_id,earned_on,expires_on,days)
 select f.org_id,f.person_id,f.id,f.from_date,f.from_date+p.comp_expiry_days,p.comp_credit
 from hr_flow f join hr_flow_policy p using(org_id) where new.voided_at is null and f.org_id=new.org_id and f.person_id=new.person_id and f.kind='work' and f.status='approved' and f.from_date=new.work_date and p.comp_credit>0
 on conflict(org_id,person_id,earned_on) do nothing;return null;
end $$;
create trigger hr_comp_accrue after insert or update on pulse.attendance_entry for each row execute function pulse.hr_comp_accrue();
create function pulse.hr_comp_debit() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare lot record;remaining numeric;used numeric;
begin
 if new.leave_kind<>'comp_off' or new.status is not distinct from old.status then return null;end if;
 perform pg_advisory_xact_lock(hashtext('hr-comp:'||new.person_id));
 if old.status='approved' then
 insert into hr_comp_use(org_id,credit_id,leave_id,days) select new.org_id,credit_id,new.id,-sum(days) from hr_comp_use where leave_id=new.id group by credit_id having sum(days)>0;
 end if;
 if new.status='approved' then
 remaining:=new.days;
 if new.to_date>(select max(expires_on) from hr_comp_credit where person_id=new.person_id) or hr_comp_balance(new.person_id,new.to_date)<remaining then raise exception 'Not enough unexpired comp-off for these dates' using errcode='22023';end if;
 for lot in select c.*,c.days-coalesce((select sum(days) from hr_comp_use where credit_id=c.id),0) available from hr_comp_credit c where person_id=new.person_id and earned_on<=new.from_date and expires_on>=new.to_date and exists(select 1 from hr_flow f where f.id=c.flow_id and f.status='approved') and exists(select 1 from attendance_entry e where e.person_id=c.person_id and e.work_date=c.earned_on and e.voided_at is null) order by expires_on,created_at for update loop
 used:=least(remaining,lot.available);
 if used>0 then insert into hr_comp_use(org_id,credit_id,leave_id,days) values(new.org_id,lot.id,new.id,used);remaining:=remaining-used;end if;
 exit when remaining<=0;
 end loop;
 if remaining>0 then raise exception 'Not enough unexpired comp-off' using errcode='22023';end if;
 end if;return null;
end $$;
create trigger hr_comp_debit after update on pulse.leave_request for each row execute function pulse.hr_comp_debit();
create function pulse.hr_flow_decide(p_id uuid,p_action text,p_note text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare f hr_flow;actor uuid:=current_viewer();staff boolean:=viewer_is('admin','hr','leadership');co boolean:=hr_is_cofounder();
begin
 select * into f from hr_flow where id=p_id and org_id=current_org();
 if f.kind in('leave','work') then perform pg_advisory_xact_lock(hashtext('hr-comp:'||f.person_id));end if;
 if f.kind='leave' then perform 1 from leave_request where id=f.source_id for update;
 elsif f.kind='correction' then perform 1 from attendance_regularisation where id=f.source_id for update;
 elsif f.kind='request' then perform 1 from hr_ticket where id=f.source_id for update;end if;
 select * into f from hr_flow where id=p_id and org_id=current_org() for update;
 if f.id is null or not hr_flow_visible(p_id) then raise exception 'Request not found' using errcode='P0002';end if;
 if actor is null then raise exception 'Individual sign-in required' using errcode='42501';end if;
 if p_action='reply' then
 if f.person_id<>actor or f.status<>'pending' or length(trim(coalesce(p_note,'')))<3 then raise exception 'Only the requester can reply to a pending item' using errcode='42501';end if;
 update hr_flow set decision_note=p_note,updated_at=now() where id=p_id;return;
 end if;
 if p_action='cancelled' then
 if f.person_id<>actor or f.status not in('pending','approved') or (f.status='approved' and f.from_date<=(now() at time zone 'Asia/Kolkata')::date) then raise exception 'Only your pending request or future leave can be withdrawn' using errcode='42501';end if;
 else
 if actor=f.person_id then raise exception 'Nobody approves their own request' using errcode='42501';end if;
 if f.stage='cofounder' and not co and not(staff and f.status<>'pending') then raise exception 'Assigned co-founder decision required' using errcode='42501';end if;
 if f.stage='hr' and not staff then raise exception 'Needs HR' using errcode='42501';end if;
 if f.stage='pod_head' and not(staff or hr_head(f.person_id)=actor) then raise exception 'Outside your pod' using errcode='42501';end if;
 end if;
 if p_action in('forward','ask') then
 if f.status<>'pending' then raise exception 'Already decided' using errcode='22023';end if;
 if p_action='forward' and not staff then raise exception 'Only HR forwards requests' using errcode='42501';end if;
 if length(trim(coalesce(p_note,'')))<3 then raise exception 'Add a note' using errcode='22023';end if;
 update hr_flow set stage=case when p_action='forward' then 'cofounder' else stage end,decision_note=p_note,updated_at=now() where id=p_id;return;
 end if;
 if p_action not in('approved','rejected','cancelled') then raise exception 'Choose approve, reject, ask or forward' using errcode='22023';end if;
 if f.status<>'pending' and p_action<>'cancelled' and not staff then raise exception 'Only HR can override a decision' using errcode='42501';end if;
 if (p_action='rejected' or (f.status<>'pending' and p_action<>'cancelled') or (staff and f.stage='pod_head' and p_action<>'cancelled')) and length(trim(coalesce(p_note,'')))<3 then raise exception 'Give a reason for rejection or HR override' using errcode='22023';end if;
 if f.kind='work' then
 if p_action<>'approved' and exists(select 1 from hr_comp_credit c join hr_comp_use u on u.credit_id=c.id where c.flow_id=f.id group by c.id having sum(u.days)>0) then raise exception 'Comp-off already used; correct the leave first' using errcode='22023';end if;
 update hr_flow set status=p_action,decided_by=actor,decision_note=p_note,updated_at=now() where id=p_id;
 -- A late approval also credits a check-in already recorded for this day.
 if p_action='approved' then
 insert into hr_comp_credit(org_id,person_id,flow_id,earned_on,expires_on,days) select f.org_id,f.person_id,f.id,f.from_date,f.from_date+p.comp_expiry_days,p.comp_credit from hr_flow_policy p
 where p.org_id=f.org_id and p.comp_credit>0 and exists(select 1 from attendance_entry where person_id=f.person_id and work_date=f.from_date and voided_at is null) on conflict(org_id,person_id,earned_on) do nothing;
 end if;
 elsif f.kind='leave' then update leave_request set status=p_action,decided_by=actor,decided_at=now(),decision_note=p_note where id=f.source_id;
 elsif f.kind='correction' then
 if f.status='approved' and p_action='rejected' then perform hr_correction_restore(f.source_id);end if;
 update attendance_regularisation set status=p_action,decided_by=actor,decided_at=now(),decision_note=p_note where id=f.source_id;
 else
 update hr_ticket set status=case p_action when 'approved' then 'resolved' else 'closed' end,approval_outcome=p_action,resolution=p_note,updated_at=now(),resolved_at=now() where id=f.source_id;

 end if;
end $$;
create function pulse.hr_flow_needs(p_id uuid,p_why text[]) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from hr_flow where id=p_id and status='pending' and (person_id=current_viewer() or viewer_is('admin','hr','leadership'))) then raise exception 'Request not found' using errcode='42501';end if;
 update hr_flow set needs_hr=array(select distinct unnest(needs_hr||p_why)),stage=case when stage='cofounder' then stage else 'hr' end where id=p_id and cardinality(p_why)>0;
end $$;
create function pulse.hr_flow_remind() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare f record;r uuid;nid uuid;n int:=0;
begin
 for f in select q.* from hr_flow q join hr_flow_policy p using(org_id) where q.org_id=current_org() and q.status='pending'
 and coalesce(q.reminded_at,q.updated_at)<now()-make_interval(hours=>p.reminder_hours) for update of q skip locked loop
 for r in select id from person where org_id=current_org() and status='active' and
 ((f.stage='cofounder' and hr_is_cofounder(id)) or (f.stage<>'cofounder' and (hr_is_staff(id) or id=hr_head(f.person_id)))) and id<>f.person_id loop
 insert into notification(org_id,person_id,title,href,telegram_status) values(current_org(),r,'HR request reminder','/me/approvals?request='||f.id,
 case when exists(select 1 from pulse_priv.telegram_person where person_id=r) then 'queued' else 'recipient_not_connected' end) returning id into nid;
 insert into hr_mail_outbox(org_id,notification_id,person_id) values(current_org(),nid,r);
 end loop;
 update hr_flow set reminded_at=now() where id=f.id;n:=n+1;
 end loop;return n;
end $$;
-- Restrict function entry points; helpers are read-only, mutation functions check identity and scope.
do $$ declare f record;begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pulse' and p.proname like 'hr_%' and p.proname in('hr_is_cofounder','hr_is_staff','hr_head','hr_flow_visible','hr_flow_defaults','hr_work_days','hr_working','hr_pattern_set','hr_work_request','hr_comp_balance','hr_flow_decide','hr_flow_needs','hr_flow_remind','hr_flow_publish','hr_flow_source','hr_comp_accrue','hr_comp_debit') loop
 execute format('revoke all on function %s from public',f.signature);
 if f.proname in('hr_flow_remind') then execute format('grant execute on function %s to pulse_worker',f.signature);
 elsif f.proname not in('hr_flow_publish','hr_flow_source','hr_comp_accrue','hr_comp_debit') then execute format('grant execute on function %s to pulse_api',f.signature);end if;
 end loop;end $$;
create function pulse.hr_pod_set(p_name text,p_head uuid,p_members uuid[]) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'HR required' using errcode='42501';end if;
 perform hr_flow_defaults();
 if exists(select 1 from unnest(p_members||p_head) x where not exists(select 1 from person where id=x and org_id=current_org() and side='staff' and status='active')) then raise exception 'Active staff required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('hr-pods:'||current_org()));
 insert into hr_pod(org_id,name,head_id,updated_by) values(current_org(),p_name,p_head,current_viewer()) on conflict(org_id,name) do update set head_id=excluded.head_id,updated_by=excluded.updated_by,updated_at=now();
 update people_profile set pod=null,manager_id=null,updated_at=now(),locked=array(select distinct unnest(locked||array['pod','manager_id'])) where org_id=current_org() and pod=p_name and person_id<>all(p_members||p_head);
 update people_profile set pod=p_name,manager_id=case when person_id=p_head then null else p_head end,updated_at=now(),locked=array(select distinct unnest(locked||array['pod','manager_id'])) where org_id=current_org() and person_id=any(p_members||p_head);
 update hr_flow f set stage=case when hr_is_staff(f.person_id) then 'cofounder' when cardinality(f.needs_hr)>0 or hr_head(f.person_id) is null or hr_head(f.person_id)=f.person_id then 'hr' else
 (select case f.kind when 'leave' then p.leave_approver when 'correction' then p.correction_approver when 'work' then p.work_approver else p.request_approver end from hr_flow_policy p where p.org_id=current_org()) end,updated_at=now()
 where f.org_id=current_org() and f.status='pending' and f.stage<>'cofounder';
 update unit set head_person_id=p_head where org_id=current_org() and kind='pod' and name=p_name and valid_to is null;
 perform audit_write('hr_pod_assignment','pod',p_name);
end $$;
revoke all on function pulse.hr_pod_set(text,uuid,uuid[]) from public;
grant execute on function pulse.hr_pod_set(text,uuid,uuid[]) to pulse_api;
-- Wrap existing requests in place, keeping their identity, status and decision details.
do $$ declare o uuid;begin
 for o in select id from pulse.org loop
 perform set_config('pulse.org_id',o::text,true);perform pulse.hr_flow_defaults();
 insert into pulse.hr_flow(org_id,person_id,kind,source_id,from_date,to_date,subject,note,status,stage,decided_by,decision_note,created_at,updated_at)
 select l.org_id,l.person_id,'leave',l.id,l.from_date,l.to_date,l.leave_kind||' leave',l.reason,l.status,'hr',l.decided_by,l.decision_note,l.created_at,coalesce(l.decided_at,l.created_at) from pulse.leave_request l where l.org_id=o on conflict do nothing;
 insert into pulse.hr_flow(org_id,person_id,kind,source_id,from_date,to_date,subject,note,status,stage,decided_by,decision_note,created_at,updated_at)
 select r.org_id,r.person_id,'correction',r.id,r.work_date,r.work_date,r.kind||' attendance correction',r.reason,r.status,'hr',r.decided_by,r.decision_note,r.created_at,coalesce(r.decided_at,r.created_at) from pulse.attendance_regularisation r where r.org_id=o on conflict do nothing;
 insert into pulse.hr_flow(org_id,person_id,kind,source_id,from_date,to_date,subject,note,status,stage,created_at,updated_at)
 select t.org_id,t.person_id,'request',t.id,(t.created_at at time zone 'Asia/Kolkata')::date,(t.created_at at time zone 'Asia/Kolkata')::date,t.subject,t.body,case t.status when 'resolved' then 'approved' when 'closed' then 'cancelled' else 'pending' end,'hr',t.created_at,t.updated_at from pulse.hr_ticket t where t.org_id=o on conflict do nothing;
 update pulse.hr_flow f set details=jsonb_build_object('days',l.days,'halfDay',l.half_day,'leaveKind',l.leave_kind) from pulse.leave_request l where f.org_id=o and f.kind='leave' and f.source_id=l.id;
 update pulse.hr_flow f set details=jsonb_build_object('inTime',r.in_time,'outTime',r.out_time) from pulse.attendance_regularisation r where f.org_id=o and f.kind='correction' and f.source_id=r.id;
 update pulse.hr_flow f set needs_hr=array_remove(array[
 case when l.days>p.max_leave_days then 'long leave' end,
 case when not t.paid then 'unpaid leave' end,
 case when t.key ~ '(special|emergency)' or t.name ~* '(special|emergency)' then 'special or emergency leave' end,
 case when l.leave_kind<>'comp_off' and pulse.hr_leave_remaining(l.person_id,l.leave_kind,l.id)+p.balance_buffer<l.days then 'beyond balance' end],null)
 from pulse.leave_request l join pulse.hr_flow_policy p using(org_id) left join pulse.leave_type t on t.org_id=l.org_id and t.key=l.leave_kind
 where f.org_id=o and f.kind='leave' and f.source_id=l.id and f.status='pending';
 update pulse.hr_flow f set needs_hr=array['salary affecting'] from pulse.hr_ticket t where f.org_id=o and f.kind='request' and f.source_id=t.id and t.category='payroll' and f.status='pending';
 update pulse.hr_flow set stage='cofounder' where org_id=o and status='pending' and pulse.hr_is_staff(person_id);
 insert into pulse.hr_flow_event(org_id,flow_id,actor_id,action,note,created_at) select f.org_id,f.id,f.decided_by,'imported decision: '||f.status,f.decision_note,f.updated_at from pulse.hr_flow f where f.org_id=o and f.status in('approved','rejected') and f.decided_by is not null;
 insert into pulse.hr_flow_event(org_id,flow_id,actor_id,action,note,created_at) select e.org_id,f.id,e.author_id,e.kind,e.body,e.created_at from pulse.hr_ticket_event e join pulse.hr_flow f on f.org_id=e.org_id and f.source_id=e.ticket_id and f.kind='request' where e.org_id=o and not e.internal;
 end loop;
 perform set_config('pulse.org_id','',true);
end $$;
create function pulse.hr_flow_ticket_event() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not new.internal then
 insert into hr_flow_event(org_id,flow_id,actor_id,action,note,created_at) select new.org_id,f.id,new.author_id,new.kind,new.body,new.created_at from hr_flow f where f.org_id=new.org_id and f.kind='request' and f.source_id=new.ticket_id;
 end if;return null;
end $$;
revoke all on function pulse.hr_flow_ticket_event() from public;
create trigger hr_flow_ticket_event after insert on pulse.hr_ticket_event for each row execute function pulse.hr_flow_ticket_event();
create function pulse.hr_notification_mail(p_id uuid) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select m.status from hr_mail_outbox m join notification n on n.id=m.notification_id where m.org_id=current_org() and n.id=p_id and n.person_id=current_viewer()
$$;
revoke all on function pulse.hr_notification_mail(uuid) from public;
grant execute on function pulse.hr_notification_mail(uuid) to pulse_api;
-- Co-founders can apply the specific forwarded correction or leave without general HR access.
create function pulse.hr_forwarded_request(p_kind text,p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select hr_is_cofounder() and exists(select 1 from hr_flow where org_id=current_org() and kind=p_kind and source_id=p_id and stage='cofounder')
$$;
create function pulse.hr_forwarded_day(p_person uuid,p_day date) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select hr_is_cofounder() and exists(select 1 from hr_flow where org_id=current_org() and person_id=p_person and kind='correction' and from_date=p_day and stage='cofounder')
$$;
revoke all on function pulse.hr_forwarded_request(text,uuid),pulse.hr_forwarded_day(uuid,date) from public;
grant execute on function pulse.hr_forwarded_request(text,uuid),pulse.hr_forwarded_day(uuid,date) to pulse_api;
alter policy own_or_team on pulse.leave_request using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership') or pulse.manages(person_id) or pulse.hr_forwarded_request('leave',id)) with check(person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership') or pulse.manages(person_id) or pulse.hr_forwarded_request('leave',id));
alter policy own_or_team on pulse.attendance_regularisation using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership') or pulse.manages(person_id) or pulse.hr_forwarded_request('correction',id)) with check(person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership') or pulse.manages(person_id) or pulse.hr_forwarded_request('correction',id));
alter policy own_or_team on pulse.attendance_entry using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership') or pulse.manages(person_id) or pulse.hr_forwarded_day(person_id,work_date)) with check(person_id=pulse.current_viewer() or pulse.viewer_is('admin','hr','leadership') or pulse.manages(person_id) or pulse.hr_forwarded_day(person_id,work_date));
-- migrate:down
