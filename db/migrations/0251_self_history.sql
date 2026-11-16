-- migrate:up
-- R43 (11 Oct 2026): what an employee reads about their own past is really theirs, and nothing is made up.
--  * Payslips: an employee reads the payslips HR issued (0131's immutable snapshots), never one Pulse works out from
--    salary records. 0131 let a person read a projection from their own salary rows for any month; projections are
--    now HR's (hr.salary.read) to review before issuing, and the salary table is back to 0005's reader rule.
--  * hr_self_payslips(): the months with an issued payslip (latest version) and when, without figures, for
--    My desk → History. Figures still come one slip at a time through hr_payslip_read, which logs the read.
--  * hr_month_resolved()/hr_month_self(): the imported monthly reports a person may read as their own. A row counts only
--    when its owner is resolved: HR recorded it in Pulse, or the report's name is the person's full name (two words or
--    more, exactly) and it has a source. A single-name match (the "first name" trap) or a row without a source stays
--    with HR; the person sees a count. Both run as the caller, so 0011's history_person row rule still applies.
create or replace function pulse.hr_payslip_source(p_person uuid,p_month date) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pulse_priv.hr_compensation;e hr_employment;gross numeric;begin
 if current_viewer() is null or not hr_can('hr.salary.read') then raise exception 'Salary access denied' using errcode='42501';end if;
 perform hr_log(p_person,'hr.salary','payslip_projection');
 select * into s from pulse_priv.hr_compensation where org_id=current_org() and person_id=p_person and kind in('current','monthly') and coalesce(effective_from,effective_month)<p_month+interval '1 month' and (effective_to is null or effective_to>=p_month) order by coalesce(effective_from,effective_month) desc,(kind='current') desc,imported_at desc,id desc limit 1;
 if s.id is null then return null;end if;
 select * into e from hr_employment where person_id=p_person;
 gross:=case when s.components ? 'fixed' then (s.components->>'fixed')::numeric+coalesce((s.components->>'variable')::numeric,0)+coalesce((s.components->>'bonus')::numeric,0) else s.amount end;
 return jsonb_build_object('personId',p_person,'name',(select display_name from person where id=p_person),'gross',gross,'ptGross',gross-coalesce((s.components->>'bonus')::numeric,0),'reimbursements',coalesce((s.components->>'reimbursements')::numeric,0),'deductions',coalesce((s.components->>'deductions')::numeric,0),'currency',s.currency,'ptCategory',e.pt_category,'ptState',e.pt_state,'ptExempt',coalesce(e.pt_exempt,false),'sourceId',s.id);
end $$;
alter policy salary_reader on pulse_priv.hr_compensation using(pulse.hr_can('hr.salary.read'));

create function pulse.hr_self_payslips() returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare who uuid:=current_viewer();begin
 if who is null then raise exception 'An individual account is required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('month',to_char(s.salary_month,'YYYY-MM'),'version',s.version,'issuedAt',s.issued_at) order by s.salary_month desc)
  from (select distinct on (salary_month) salary_month,version,issued_at from pulse_priv.hr_payslip where org_id=current_org() and person_id=who order by salary_month,version desc) s),'[]');
end $$;

-- Two spellings of one name compare equal when case and spacing are all that differ.
create function pulse.hr_name_key(p text) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select lower(regexp_replace(trim(coalesce(p,'')),'\s+',' ','g'))
$$;
-- Whose a monthly report is, settled: HR recorded it in Pulse, or it names the linked person's full name (two words or
-- more) and carries its source. Everyone but HR reads only settled rows (here and on /hr-history).
create function pulse.hr_month_resolved(h pulse.hr_month_history) returns boolean language sql stable set search_path=pulse,pg_temp as $$
 select h.person_id is not null and (h.source_key like 'pulse-month:%' or (
  hr_name_key(h.person_label)=hr_name_key((select display_name from person where id=h.person_id)) and hr_name_key(h.person_label) like '% %'
  and jsonb_typeof(h.evidence)='array' and jsonb_array_length(h.evidence)>0))
$$;
create function pulse.hr_month_self() returns table(source_key text,month date,month_label text,leave_days numeric,wfh_days numeric,half_days numeric,
 attendance_dates text,basis text,sheet text,entered_by_hr boolean,resolved boolean) language sql stable set search_path=pulse,pg_temp as $$
 select h.source_key,h.month,h.month_label,h.leave_days,h.wfh_days,h.half_days,h.attendance_dates,h.basis,
  (select string_agg(distinct e->>'sheet',', ') from jsonb_array_elements(case when jsonb_typeof(h.evidence)='array' then h.evidence else '[]'::jsonb end) e),
  h.source_key like 'pulse-month:%',hr_month_resolved(h)
 from hr_month_history h
 where h.org_id=current_org() and h.person_id=current_viewer() and current_viewer() is not null
$$;
revoke all on function pulse.hr_self_payslips(),pulse.hr_name_key(text),pulse.hr_month_resolved(pulse.hr_month_history),pulse.hr_month_self() from public;
grant execute on function pulse.hr_self_payslips(),pulse.hr_name_key(text),pulse.hr_month_resolved(pulse.hr_month_history),pulse.hr_month_self() to pulse_api;
-- migrate:down
-- Forward-only: issued payslips, imported history and access receipts are retained.
