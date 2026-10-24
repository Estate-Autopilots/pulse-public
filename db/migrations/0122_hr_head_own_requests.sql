-- migrate:up
-- A confirmed pod head's own requests need HR even when they are also a member of another pod.
create function pulse.hr_is_pod_head(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from hr_pod where org_id=current_org() and head_id=p_person)
$$;
revoke all on function pulse.hr_is_pod_head(uuid) from public;
grant execute on function pulse.hr_is_pod_head(uuid) to pulse_api;
create or replace function pulse.hr_flow_source() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 if hr_is_staff(new.person_id) then route:='cofounder';elsif cardinality(why)>0 or (route='pod_head' and hr_head(new.person_id) is null) or (hr_head(new.person_id)=new.person_id or hr_is_pod_head(new.person_id)) then route:='hr';end if;
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

create or replace function pulse.hr_work_request(p_day date,p_note text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 if hr_is_staff(current_viewer()) then route:='cofounder';elsif (route='pod_head' and hr_head(current_viewer()) is null) or (hr_head(current_viewer())=current_viewer() or hr_is_pod_head(current_viewer())) then route:='hr';end if;
 insert into hr_flow(org_id,person_id,kind,source_id,from_date,to_date,subject,note,stage) values(current_org(),current_viewer(),'work',gen_random_uuid(),p_day,p_day,'Work on '||p_day,p_note,route) returning id into result;
 return result;
end $$;

create or replace function pulse.hr_pod_set(p_name text,p_head uuid,p_members uuid[]) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'HR required' using errcode='42501';end if;
 perform hr_flow_defaults();
 if exists(select 1 from unnest(p_members||p_head) x where not exists(select 1 from person where id=x and org_id=current_org() and side='staff' and status='active')) then raise exception 'Active staff required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('hr-pods:'||current_org()));
 insert into hr_pod(org_id,name,head_id,updated_by) values(current_org(),p_name,p_head,current_viewer()) on conflict(org_id,name) do update set head_id=excluded.head_id,updated_by=excluded.updated_by,updated_at=now();
 update people_profile set pod=null,manager_id=null,updated_at=now(),locked=array(select distinct unnest(locked||array['pod','manager_id'])) where org_id=current_org() and pod=p_name and person_id<>all(p_members||p_head);
 update people_profile set pod=p_name,manager_id=case when person_id=p_head then null else p_head end,updated_at=now(),locked=array(select distinct unnest(locked||array['pod','manager_id'])) where org_id=current_org() and person_id=any(p_members||p_head);
 update hr_flow f set stage=case when hr_is_staff(f.person_id) then 'cofounder' when cardinality(f.needs_hr)>0 or (hr_head(f.person_id) is null and (select case f.kind when 'leave' then p.leave_approver when 'correction' then p.correction_approver when 'work' then p.work_approver else p.request_approver end from hr_flow_policy p where p.org_id=current_org())='pod_head') or (hr_head(f.person_id)=f.person_id or hr_is_pod_head(f.person_id)) then 'hr' else
 (select case f.kind when 'leave' then p.leave_approver when 'correction' then p.correction_approver when 'work' then p.work_approver else p.request_approver end from hr_flow_policy p where p.org_id=current_org()) end,updated_at=now()
 where f.org_id=current_org() and f.status='pending' and f.stage<>'cofounder';
 update unit set head_person_id=p_head where org_id=current_org() and kind='pod' and name=p_name and valid_to is null;
 perform audit_write('hr_pod_assignment','pod',p_name);
end $$;

do $$ declare o uuid;begin
 for o in select id from pulse.org loop
 perform set_config('pulse.org_id',o::text,true);
 update pulse.hr_flow set stage='hr' where org_id=o and status='pending' and stage='pod_head' and pulse.hr_is_pod_head(person_id);
 end loop;perform set_config('pulse.org_id','',true);
end $$;
-- migrate:down
-- Forward-only: retain request history and confirmed assignments.
