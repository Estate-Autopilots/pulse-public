-- migrate:up
-- INTEGRITY part 2 (owner, 22 Oct 2026: "Remove all loopholes and things like that which can harm us"; go-ahead 24 Oct
-- 2026): one person can no longer move money, pay, leave, attendance or a scorecard on their own.
--  * Bank details: an HR edit waits for someone else's check like a self edit; the checker is never the last editor;
--    every change is kept (pulse_priv.bank_history). The bank file pays only checked details (services/api payroll.ts).
--  * Pay set up from the salary records is proposed, not approved: the pay approver decides it (comp_change_decide).
--  * Nobody writes their own salary, issues their own payslip, grants themselves a sensitive permission, saves their
--    own employment and tax terms or work pattern, or adjusts their own leave balance.
--  * Co-founders (who approve pay and HR's own requests) are named by leadership or an admin, never by themselves.
--  * Leave or an attendance correction filed for a colleague waits for someone else's decision: the filer never
--    decides it, and nothing is filed already decided.
--  * A KPI's owner updates progress; met or missed is their head's, HR's or leadership's call.
-- Rewritten from the unlanded 0911 (which patched live bodies with pg_get_functiondef + replace) as plain
-- CREATE OR REPLACE from the repository's definitions: each function below is its latest repository definition
-- (the migration named above it; 0179_org_time_zone's in-place time-zone patch already applied, as on every database),
-- checked identical by md5 of pg_get_functiondef on a scratch database built from db/migrations and on pulse-dev.
-- Additive: new table, columns and policies; nothing dropped, no row changed or deleted.

-- 1. Bank details ---------------------------------------------------------------------------------------------------
create table if not exists pulse_priv.bank_history (
 id uuid primary key default gen_random_uuid(),org_id uuid not null,person_id uuid not null,
 masked text,summary jsonb,status text,source text,updated_by uuid,checked_by uuid,changed_at timestamptz not null default now(),changed_by uuid);
create index if not exists bank_history_person on pulse_priv.bank_history(org_id,person_id,changed_at desc);
alter table pulse_priv.bank_history enable row level security;
alter table pulse_priv.bank_history force row level security;
create policy tenant_isolation on pulse_priv.bank_history using (org_id=pulse.current_org()) with check (org_id=pulse.current_org());
revoke all on pulse_priv.bank_history from public;
-- The details before each change (sealed account stays in person_onboarding; history keeps the masked number and summary).
create or replace function pulse_priv.bank_history_keep() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if old.bank is distinct from new.bank or old.bank_status is distinct from new.bank_status or old.bank_summary is distinct from new.bank_summary then
  insert into pulse_priv.bank_history(org_id,person_id,masked,summary,status,source,updated_by,checked_by,changed_by)
  values(old.org_id,old.person_id,old.bank_masked,old.bank_summary,old.bank_status,old.bank_source,old.bank_updated_by,old.bank_checked_by,current_viewer());
 end if;
 return new;
end $$;
revoke all on function pulse_priv.bank_history_keep() from public;
create trigger bank_history_keep after update on pulse_priv.person_onboarding for each row execute function pulse_priv.bank_history_keep();

-- pulse.bank_save: the repository's definition (0211_my_info_bank.sql), with the change marked INTEGRITY part 2.
CREATE OR REPLACE FUNCTION pulse.bank_save(p_person uuid, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare self boolean; who text; s jsonb:=coalesce(p_data->'summary','{}'); h uuid;
begin
 if not bank_can_write(p_person) then raise exception 'Only the person and HR can change bank details' using errcode='42501'; end if;
 if coalesce(p_data->>'masked','')='' or length(p_data->>'masked')>80 or coalesce(p_data->>'sealed','')='' or coalesce(p_data->>'dataKey','')=''
  or coalesce(p_data->>'keyId','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$' then raise exception 'Bank details are incomplete' using errcode='22023'; end if;
 -- The summary never carries the account number: four digits at most, a masked UPI ID, bounded text.
 if jsonb_typeof(s)<>'object' or coalesce(s->>'last4','') !~ '^[0-9]{4}$' or coalesce(s->>'ifsc','') !~ '^[A-Z]{4}0[A-Z0-9]{6}$'
  or length(coalesce(s->>'holder',''))>80 or length(coalesce(s->>'bank',''))>80 or length(coalesce(s->>'branch',''))>120
  or coalesce(s->>'upi','') ~ '[0-9]{5,}' or length(coalesce(s->>'upi',''))>80 then raise exception 'Bank summary is not valid' using errcode='22023'; end if;
 self:=p_person=current_viewer();
 insert into pulse_priv.person_onboarding(org_id,person_id) values(current_org(),p_person) on conflict do nothing;
 update pulse_priv.person_onboarding set bank=decode(p_data->>'sealed','base64'),bank_key=decode(p_data->>'dataKey','base64'),bank_key_id=p_data->>'keyId',
  bank_masked=p_data->>'masked',bank_summary=jsonb_build_object('holder',s->>'holder','bank',s->>'bank','branch',nullif(s->>'branch',''),'ifsc',s->>'ifsc','last4',s->>'last4','upi',nullif(s->>'upi','')),
  bank_status='pending',bank_source=case when self then 'self' else 'hr' end,
  bank_updated_at=now(),bank_updated_by=current_viewer(),bank_checked_at=null,bank_checked_by=null,
  updated_by=current_viewer(),updated_at=now() where org_id=current_org() and person_id=p_person;
 perform hr_log(p_person,'onboarding.bank',case when self then 'self_update' else 'hr_onboarding_update' end);
 select display_name into who from person where id=p_person;
 if self then
  -- HR checks a change before the next payroll relies on it (a changed account is how salaries get diverted).
  for h in select bank_checkers() loop
   if h<>p_person then perform notification_emit(h,'people.bank','person',p_person,'bank:'||p_person||':'||extract(epoch from clock_timestamp())::bigint,
    who||' changed their bank details. Check them before the next payroll.','/people/'||p_person||'?tab=info','profile'); end if;
  end loop;
 else
  -- INTEGRITY part 2: HR's change waits for another checker's look too (never the editor's own).
  for h in select bank_checkers() loop
   if h<>p_person and h<>current_viewer() then perform notification_emit(h,'people.bank','person',p_person,'bank:'||p_person||':'||extract(epoch from clock_timestamp())::bigint,
    'Bank details for '||who||' were changed by HR. Check them before the next payroll.','/people/'||p_person||'?tab=info','profile'); end if;
  end loop;
  perform notification_emit(p_person,'profile.bank','person',p_person,'bank:'||extract(epoch from clock_timestamp())::bigint,
   'HR updated your bank details for salary. If this was not expected, tell HR.','/people/'||p_person||'?tab=info','profile');
 end if;
 update pulse_priv.person_onboarding set completed_at=case when cardinality(onboarding_missing(p_person))=0 then coalesce(completed_at,now()) end where person_id=p_person;
 return jsonb_build_object('status','pending','missing',to_jsonb(onboarding_missing(p_person)));
end $function$;

-- pulse.bank_confirm: the repository's definition (0211_my_info_bank.sql), with the change marked INTEGRITY part 2.
CREATE OR REPLACE FUNCTION pulse.bank_confirm(p_person uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
begin
 if not identity_hr() then raise exception 'HR checks bank details' using errcode='42501'; end if;
 if p_person=current_viewer() then raise exception 'Someone else in HR checks your own bank details' using errcode='42501'; end if;
 -- INTEGRITY part 2: whoever entered the details never checks them.
 if exists(select 1 from pulse_priv.person_onboarding where org_id=current_org() and person_id=p_person and bank_updated_by=current_viewer()) then
  raise exception 'Someone other than whoever entered the bank details checks them' using errcode='42501'; end if;
 update pulse_priv.person_onboarding set bank_status='confirmed',bank_checked_at=now(),bank_checked_by=current_viewer()
  where org_id=current_org() and person_id=p_person and bank is not null and coalesce(bank_status,'pending')='pending';
 if not found then raise exception 'There are no bank details waiting for a check' using errcode='22023'; end if;
 perform hr_log(p_person,'onboarding.bank','hr_bank_check');
 return bank_state(p_person);
end $function$;

-- 2. Pay set up from the salary records waits for the pay approver ----------------------------------------------------
-- pulse.comp_setup_start: the repository's definition (0440_comp_pay.sql), with the change marked INTEGRITY part 2.
CREATE OR REPLACE FUNCTION pulse.comp_setup_start(p jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare me uuid:=current_viewer(); v_person uuid:=nullif(p->>'person','')::uuid; v_ref uuid:=nullif(p->>'importRef','')::uuid; v_id uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid()); v_on date:=nullif(p->>'effectiveOn','')::date;
begin
 if not comp_writer() then raise exception 'HR sets up pay records' using errcode='42501'; end if;
 if v_person is null or v_person=me then raise exception 'Someone else sets up your own pay' using errcode='42501'; end if;
 if v_ref is null or not exists(select 1 from pulse_priv.hr_compensation h where h.org_id=current_org() and h.id=v_ref and h.person_id=v_person) then
  raise exception 'Choose a salary record of this person' using errcode='22023'; end if;
 if exists(select 1 from comp_change where person_id=v_person and status='approved') then raise exception 'This person''s pay is set up already: change it instead' using errcode='22023'; end if;
 if exists(select 1 from comp_change where person_id=v_person and kind='start' and status='proposed') then raise exception 'This person''s pay set-up is waiting for the pay approver' using errcode='22023'; end if;
 perform comp_sealed_check(p->'sealed');
 perform comp_record_ensure(v_person);
 insert into comp_change(org_id,id,person_id,kind,status,effective_on,pay_type,role,reason,source,import_ref,s_kid,s_key,s_data,proposed_by,proposed_at,decided_by,decided_at,created_by)
 values(current_org(),v_id,v_person,'start','proposed',v_on,coalesce(p->>'payType','salary'),(select role from people_profile where person_id=v_person),
  'Set up from the salary records',  'import',v_ref,p->'sealed'->>'kid',decode(p->'sealed'->>'key','base64'),decode(p->'sealed'->>'data','base64'),me,now(),null,null,me);
 update comp_record set start_on=coalesce(start_on,(select joined_on from people_profile where person_id=v_person),v_on),
  confirmed_on=coalesce(confirmed_on,case when not exists(select 1 from hr_employment e where e.person_id=v_person and e.probation_to>=lifecycle_today()) then v_on end) where person_id=v_person;
 perform comp_log(v_person,'comp.pay','setup_from_records');
 perform comp_event_add(v_person,'record.set_up','change',v_id,jsonb_build_object('from','salary records','effectiveOn',v_on));
 -- INTEGRITY part 2: proposed, not approved; the pay approver decides it (pulse.comp_change_decide: never its proposer).
 perform comp_tell_approvers(v_person,'change:'||v_id,'Pay set up from the salary records for '||comp_name(v_person)||' is waiting for your approval');
 perform comp_status_refresh(v_person);
 return v_id;
end $function$;

-- 3. Nobody on their own record -------------------------------------------------------------------------------------
-- pulse.hr_salary_write: the repository's definition (0007_hr_suite.sql; hr_salary_components_write calls it, so it is covered too), with the change marked INTEGRITY part 2.
CREATE OR REPLACE FUNCTION pulse.hr_salary_write(p_person uuid, p_month date, p_kind text, p_amount numeric, p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare new_id uuid; who text;
begin
 if p_person=pulse.current_viewer() then raise exception 'Someone else in HR changes your own record' using errcode='42501'; end if; -- INTEGRITY part 2
  if not pulse.hr_can('hr.salary.write') then raise exception 'salary access denied' using errcode = '42501'; end if;
  select display_name into who from person where id = pulse.current_viewer();
  perform pulse.hr_log(p_person, 'hr.salary', 'hr_salary_edit');
  insert into pulse_priv.hr_compensation(org_id, person_id, effective_month, kind, amount, source_file_id, source_name, source_sheet, basis)
    values (pulse.current_org(), p_person, date_trunc('month', p_month)::date, p_kind, p_amount, 'pulse:' || gen_random_uuid()::text,
            'Entered in Pulse', coalesce(who, 'HR'), coalesce(nullif(trim(p_note), ''), 'Entered by hand'))
    returning id into new_id;
  return new_id;
end $function$;

-- pulse.hr_payslip_issue: the repository's definition (0131_hr_policy_rules.sql), with the change marked INTEGRITY part 2.
CREATE OR REPLACE FUNCTION pulse.hr_payslip_issue(p_person uuid, p_month date, p_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare projected jsonb;v int;result uuid;begin
 if p_person=pulse.current_viewer() then raise exception 'Someone else in HR changes your own record' using errcode='42501'; end if; -- INTEGRITY part 2
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
end $function$;

-- pulse.hr_employment_save: the repository's definition (0131_hr_policy_rules.sql), with the change marked INTEGRITY part 2.
CREATE OR REPLACE FUNCTION pulse.hr_employment_save(p_person uuid, p_data jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
begin
 if p_person=pulse.current_viewer() then raise exception 'Someone else in HR changes your own record' using errcode='42501'; end if; -- INTEGRITY part 2
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'HR required' using errcode='42501';end if;
 if not exists(select 1 from person where id=p_person and side='staff') then raise exception 'Choose staff' using errcode='22023';end if;
 insert into hr_employment(org_id,person_id,probation_from,probation_to,notice_from,notice_to,last_working_day,settlement_target,handover,pt_category,pt_state,pt_exempt,updated_by)
 values(current_org(),p_person,(p_data->>'probationFrom')::date,(p_data->>'probationTo')::date,(p_data->>'noticeFrom')::date,(p_data->>'noticeTo')::date,(p_data->>'lastWorkingDay')::date,(p_data->>'settlementTarget')::date,coalesce(p_data->'handover','[]'),p_data->>'ptCategory',p_data->>'ptState',coalesce((p_data->>'ptExempt')::boolean,false),current_viewer())
 on conflict(person_id) do update set probation_from=excluded.probation_from,probation_to=excluded.probation_to,notice_from=excluded.notice_from,notice_to=excluded.notice_to,last_working_day=excluded.last_working_day,settlement_target=excluded.settlement_target,handover=excluded.handover,pt_category=excluded.pt_category,pt_state=excluded.pt_state,pt_exempt=excluded.pt_exempt,updated_by=excluded.updated_by,updated_at=now();
end $function$;

-- pulse.hr_pattern_set: the repository's definition (0121_hr_flows.sql + 0179_org_time_zone.sql), with the change marked INTEGRITY part 2.
CREATE OR REPLACE FUNCTION pulse.hr_pattern_set(p_person uuid, p_days integer[], p_from date, p_to date, p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare result uuid;
begin
 if p_person=pulse.current_viewer() then raise exception 'Someone else in HR changes your own record' using errcode='42501'; end if; -- INTEGRITY part 2
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'HR required' using errcode='42501';end if;
 if not exists(select 1 from person where id=p_person and org_id=current_org() and side='staff' and status='active') then raise exception 'Active person required' using errcode='22023';end if;
 if p_from<(now() at time zone pulse.org_time_zone())::date then raise exception 'Patterns start today or later' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('hr-pattern:'||p_person));
 if exists(select 1 from hr_work_pattern where person_id=p_person and superseded_at is null and valid_from>p_from and valid_from<=coalesce(p_to,'infinity')) then raise exception 'Choose dates before the next scheduled pattern' using errcode='22023';end if;
 update hr_work_pattern set superseded_at=now() where person_id=p_person and superseded_at is null and valid_from=p_from;
 update hr_work_pattern set valid_to=p_from-1 where person_id=p_person and superseded_at is null and valid_from<p_from and coalesce(valid_to,'infinity')>=p_from;
 insert into hr_work_pattern(org_id,person_id,work_days,valid_from,valid_to,reason,changed_by) values(current_org(),p_person,p_days,p_from,p_to,p_note,current_viewer()) returning id into result;
 perform audit_write('hr_work_pattern','person',p_person::text);return result;
end $function$;

-- pulse.hr_permission_set: the repository's definition (0007_hr_suite.sql), with the change marked INTEGRITY part 2.
CREATE OR REPLACE FUNCTION pulse.hr_permission_set(p_person uuid, p_permission text, p_grant boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare who text;
begin
  if not (pulse.viewer_is('admin') and pulse.hr_can('hr.salary.read')) then
    raise exception 'only an admin with salary access can change permissions' using errcode = '42501';
  end if;
  if p_grant and p_person = pulse.current_viewer() then raise exception 'Another admin grants you a permission' using errcode = '42501'; end if; -- INTEGRITY part 2
  select display_name into who from person where id = pulse.current_viewer();
  if p_grant then
    insert into sensitive_permission(org_id, person_id, permission, granted_by)
      values (pulse.current_org(), p_person, p_permission, coalesce(who, 'admin'))
      on conflict (person_id, permission) do update set granted_by = excluded.granted_by, granted_at = now(), revoked_at = null, revoked_by = null;
  else
    update sensitive_permission set revoked_at = now(), revoked_by = pulse.current_viewer()
      where org_id = pulse.current_org() and person_id = p_person and permission = p_permission and revoked_at is null;
  end if;
end $function$;

-- Leave balance: nobody adjusts their own.
create policy adjustment_not_self on pulse.leave_adjustment as restrictive for insert to pulse_api with check (person_id is distinct from pulse.current_viewer());

-- 4. Co-founders (pay approvers): named by leadership or an admin, never by themselves.
create policy cofounder_named_by_leadership on pulse.hr_cofounder as restrictive for insert to pulse_api
 with check (pulse.viewer_is('admin','leadership') and person_id is distinct from pulse.current_viewer());
create policy cofounder_changed_by_leadership on pulse.hr_cofounder as restrictive for update to pulse_api
 using (pulse.viewer_is('admin','leadership')) with check (person_id is distinct from pulse.current_viewer());

-- 5. Filed for a colleague: someone else decides ------------------------------------------------------------------------
alter table pulse.leave_request add column if not exists filed_by uuid references pulse.person(id);
alter table pulse.attendance_regularisation add column if not exists filed_by uuid references pulse.person(id);
-- pulse.hr_flow_decide: the repository's definition (0121_hr_flows.sql + 0179_org_time_zone.sql), with the change marked INTEGRITY part 2.
CREATE OR REPLACE FUNCTION pulse.hr_flow_decide(p_id uuid, p_action text, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
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
 if f.person_id<>actor or f.status not in('pending','approved') or (f.status='approved' and f.from_date<=(now() at time zone pulse.org_time_zone())::date) then raise exception 'Only your pending request or future leave can be withdrawn' using errcode='42501';end if;
 else
 if actor=f.person_id then raise exception 'Nobody approves their own request' using errcode='42501';end if;
 -- INTEGRITY part 2: what someone filed for a colleague is decided by someone else.
 if (f.kind='leave' and exists(select 1 from leave_request where id=f.source_id and filed_by=actor))
  or (f.kind='correction' and exists(select 1 from attendance_regularisation where id=f.source_id and filed_by=actor)) then
  raise exception 'Someone else decides what you filed for a colleague' using errcode='42501';end if;
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
end $function$;

-- pulse.hr_flow_source: the repository's definition (0122_hr_head_own_requests.sql + 0179_org_time_zone.sql), with the change marked INTEGRITY part 2.
CREATE OR REPLACE FUNCTION pulse.hr_flow_source()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
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
 else d1:=(now() at time zone pulse.org_time_zone(new.org_id))::date;d2:=d1;sub:=new.subject;route:=pol.request_approver;
 if new.category='payroll' then why:=array_append(why,'salary affecting');end if;
 end if;
 if hr_is_staff(new.person_id) then route:='cofounder';elsif cardinality(why)>0 or (route='pod_head' and hr_head(new.person_id) is null) or (hr_head(new.person_id)=new.person_id or hr_is_pod_head(new.person_id)) then route:='hr';end if;
 if k<>'request' then
 -- INTEGRITY part 2: nothing a person files is filed already decided (a leave split by a check-in is copied without a viewer).
 if new.status in('approved','rejected') and current_viewer() is not null then raise exception 'A request is filed waiting; someone other than the filer decides it' using errcode='42501';end if;
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
 if k<>'request' and st in('approved','rejected') and to_jsonb(new)->>'filed_by'=current_viewer()::text then raise exception 'Someone else decides what you filed for a colleague' using errcode='42501';end if; -- INTEGRITY part 2
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
end $function$;

-- 6. KPIs: the owner reports progress; met or missed is decided by someone else.
-- pulse.kpi_progress: the repository's definition (0141_task_flow.sql), with the change marked INTEGRITY part 2.
CREATE OR REPLACE FUNCTION pulse.kpi_progress(p_id uuid, p_progress integer, p_status text, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
declare me uuid:=task_require_viewer();k kpi;
begin
 select * into k from kpi where org_id=current_org() and id=p_id for update;
 if not found or not (k.person_id=me or viewer_is('admin','leadership','hr') or coalesce(manages(k.person_id),false)) then raise exception 'KPI not found' using errcode='P0002';end if;
 if k.person_id=me and p_status in ('met','missed') and p_status is distinct from k.status then raise exception 'Your head, HR or leadership marks a KPI met or missed' using errcode='42501';end if; -- INTEGRITY part 2
 if p_progress is not null and p_progress not between 0 and 100 then raise exception 'Progress is 0 to 100%%' using errcode='22023';end if;
 if p_status not in ('not_started','on_track','at_risk','behind','met','missed') then raise exception 'Choose a KPI status' using errcode='22023';end if;
 update kpi set progress=coalesce(p_progress,progress),status=p_status,latest_note=coalesce(nullif(btrim(coalesce(p_note,'')),''),latest_note),updated_by=me,updated_at=now() where id=p_id;
 insert into kpi_update(org_id,kpi_id,progress,status,note,by_id) values(current_org(),p_id,p_progress,p_status,nullif(btrim(coalesce(p_note,'')),''),me);
end $function$;

-- migrate:down
-- Forward-only.
