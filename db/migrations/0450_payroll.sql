-- migrate:up
-- COMP-B (owner, 13 Oct 2026): "finance and cash projection, the finance ledger, and a running budget". The monthly
-- payroll run on COMP-A's pay records (0440): draft → HR checks (exceptions listed) → a founder approves → locked;
-- payslips in each person's My money, a bank file a founder uploads (Pulse never pays), and the people-cost ledger the CA
-- reads as monthly totals. docs/ops/PAYROLL.md describes it.
--  * Amounts never reach PostgreSQL in plaintext: lines, totals, payslips, the bank file and ledger entries are sealed by
--    the API with the document keyring. These functions decide who may have which sealed rows, and log the look first.
--  * Individuals (lines, payslips, the bank file, the ledger by pod) are for comp_reader() (HR, leadership, an admin
--    with hr.salary.read); each person reads their own payslips; the Accountant reads monthly totals by account only.
--  * HR (comp_writer) starts, recalculates, adjusts and checks; an approver (comp_is_approver) approves, which locks the
--    run. The approver is never the person who checked it; nobody adjusts their own line, and an approver whose own line
--    carries an adjustment cannot approve the run. Every step is a pay_run_event (no amounts) and an audit_event.

-- ---------------------------------------------------------------------------------------------------- 1. tables
-- The company's payroll settings: statutory template (India by default; each part on or off; amounts in paise),
-- how attendance turns into loss of pay, the pay day and the bank file.
create table pulse.pay_settings (
 org_id uuid primary key references pulse.org(id),
 statutory jsonb not null default '{"pf":{"on":true,"employeePct":12,"employerPct":12,"wageCap":1500000,"capped":true},
  "esi":{"on":true,"employeePct":0.75,"employerPct":3.25,"grossLimit":2100000},
  "pt":{"on":true,"state":"MH"},
  "tds":{"on":true,"standardDeduction":7500000,"rebateUpTo":120000000,"cessPct":4,"contractorPct":10,
   "slabs":[{"upTo":40000000,"pct":0},{"upTo":80000000,"pct":5},{"upTo":120000000,"pct":10},{"upTo":160000000,"pct":15},
    {"upTo":200000000,"pct":20},{"upTo":240000000,"pct":25},{"upTo":null,"pct":30}]}}'
  check (jsonb_typeof(statutory)='object' and pg_column_size(statutory)<8192),
 attendance jsonb not null default '{"unpaidLeave":"pay","halfDays":"none","lateMarks":"leave","absent":"none"}'
  check (jsonb_typeof(attendance)='object' and coalesce(attendance->>'unpaidLeave','pay') in ('pay','none')
   and coalesce(attendance->>'halfDays','none') in ('pay','none') and coalesce(attendance->>'lateMarks','leave') in ('pay','leave')
   and coalesce(attendance->>'absent','none') in ('pay','none')),
 pay_day int not null default 7 check (pay_day between 1 and 28),
 bank_format text not null default 'axis' check (bank_format in ('axis','generic')),
 debit_account text check (debit_account ~ '^[0-9]{6,20}$'),
 narration text not null default 'Salary {{month}}' check (length(narration) between 1 and 60),
 updated_by uuid, updated_at timestamptz not null default now()
);

create table pulse.pay_run (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 month date not null check (extract(day from month)=1),
 seq int not null check (seq>=1),
 kind text not null check (kind in ('regular','correction')),
 corrects_id uuid references pulse.pay_run(id),
 status text not null default 'draft' check (status in ('draft','checked','locked','withdrawn')),
 calc int not null default 0 check (calc>=0), checked_calc int,
 note text check (length(note)<=1000),
 pay_on date,
 people int not null default 0, exceptions int not null default 0,
 s_kid text check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea, s_data bytea check (octet_length(s_data)<=8192),
 opened_by uuid, opened_at timestamptz not null default now(),
 checked_by uuid, checked_at timestamptz, check_note text check (length(check_note)<=1000),
 approved_by uuid, approved_at timestamptz, approve_note text check (length(approve_note)<=1000),
 withdrawn_by uuid, withdrawn_at timestamptz,
 unique (org_id, month, seq),
 check ((kind='correction')=(corrects_id is not null)),
 check (approved_by is null or approved_by is distinct from checked_by),
 check ((s_kid is null)=(s_data is null) and (s_key is null)=(s_data is null))
);
create unique index pay_run_open_month on pulse.pay_run(org_id, month) where status in ('draft','checked');
create unique index pay_run_regular_month on pulse.pay_run(org_id, month) where kind='regular' and status='locked';

-- One person's month in one calculation of a run. Every calculation is kept.
create table pulse.pay_run_line (
 org_id uuid not null references pulse.org(id),
 run_id uuid not null references pulse.pay_run(id) on delete cascade,
 calc int not null check (calc>=1),
 person_id uuid not null references pulse.person(id) on delete cascade,
 pay_type text check (pay_type in ('salary','stipend','contractor','retainer','hourly')),
 pod text check (length(pod)<=80), department text check (length(department)<=80),
 exceptions text[] not null default '{}' check (cardinality(exceptions)<=20 and array_to_string(exceptions,',') ~ '^[a-z_,]*$'),
 hold boolean not null default false,
 settlement_id uuid,
 recover boolean not null default false, recovered_in uuid,
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=65536),
 primary key (run_id, calc, person_id)
);
create index pay_run_line_person on pulse.pay_run_line(org_id, person_id);

-- HR's changes to a person's line: loss-of-pay days, an amount (sealed) with its label, or holding them out of the file.
create table pulse.pay_adjustment (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 run_id uuid not null references pulse.pay_run(id) on delete cascade,
 person_id uuid not null references pulse.person(id) on delete cascade,
 kind text not null check (kind in ('lop_days','amount','hold')),
 days numeric(4,1) check (days between 0 and 31),
 label text check (length(label) between 1 and 80),
 reason text not null check (length(btrim(reason)) between 3 and 500),
 s_kid text check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea, s_data bytea check (octet_length(s_data)<=4096),
 created_by uuid, created_at timestamptz not null default now(), removed_by uuid, removed_at timestamptz,
 check ((kind='lop_days')=(days is not null)),
 check ((kind='amount')=(s_data is not null and s_key is not null and s_kid is not null and label is not null)),
 check (created_by is distinct from person_id)
);
create index pay_adjustment_run on pulse.pay_adjustment(run_id) where removed_at is null;

create table pulse.pay_run_event (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 run_id uuid not null references pulse.pay_run(id) on delete cascade,
 at timestamptz not null default clock_timestamp(),
 actor uuid,
 kind text not null check (kind ~ '^[a-z_]+(\.[a-z_]+)?$'),
 detail jsonb not null default '{}' check (jsonb_typeof(detail)='object' and pg_column_size(detail)<2048
  and not (detail ?| array['amount','gross','net','total','totals','monthly','figures','lines','deductions','cost']))
);
create index pay_run_event_run on pulse.pay_run_event(run_id, at);

create table pulse.pay_payslip (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 run_id uuid not null references pulse.pay_run(id),
 person_id uuid not null references pulse.person(id) on delete cascade,
 month date not null check (extract(day from month)=1),
 version int not null check (version>=1),
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=65536),
 p_kid text not null check (p_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), p_key bytea not null, p_data bytea not null check (octet_length(p_data)<=4000000),
 sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), pages int not null check (pages between 1 and 20),
 issued_by uuid, issued_at timestamptz not null default now(), seen_at timestamptz,
 unique (run_id, person_id), unique (org_id, person_id, month, version)
);

-- The bank file of a locked run (only people with bank details and not held).
create table pulse.pay_payout (
 org_id uuid not null references pulse.org(id),
 run_id uuid primary key references pulse.pay_run(id),
 format text not null check (format in ('axis','generic')),
 rows int not null check (rows>=0), left_out int not null default 0 check (left_out>=0),
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=4000000),
 sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
 created_by uuid, created_at timestamptz not null default now()
);

-- The people-cost ledger: a locked run's journal by pod and department, and its totals by account (the CA's grain).
create table pulse.pay_ledger_entry (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 run_id uuid not null references pulse.pay_run(id),
 month date not null check (extract(day from month)=1),
 account text not null check (account in ('salaries','employer_contributions','reimbursements','advances_paid','advances_recovered','statutory_payable','net_payable')),
 side text not null check (side in ('debit','credit')),
 pod text check (length(pod)<=80), department text check (length(department)<=80),
 people int not null check (people>=0),
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=4096)
);
create index pay_ledger_entry_month on pulse.pay_ledger_entry(org_id, month);
create table pulse.pay_ledger_total (
 org_id uuid not null references pulse.org(id),
 run_id uuid not null references pulse.pay_run(id),
 month date not null check (extract(day from month)=1),
 account text not null check (account in ('salaries','employer_contributions','reimbursements','advances_paid','advances_recovered','statutory_payable','net_payable')),
 side text not null check (side in ('debit','credit')),
 people int not null check (people>=0),
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=4096),
 primary key (run_id, account)
);

do $$ declare t text; begin
 foreach t in array array['pay_settings','pay_run','pay_run_line','pay_adjustment','pay_run_event','pay_payslip','pay_payout','pay_ledger_entry','pay_ledger_total'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant on pulse.%I using (org_id=pulse.current_org()) with check (org_id=pulse.current_org())',t);
  execute format('revoke all on pulse.%I from pulse_api',t);
  execute format('grant select on pulse.%I to pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;

-- ------------------------------------------------------------------------------------------ 2. small helpers
create function pulse.pay_settings_row() returns pulse.pay_settings language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_settings;
begin
 select * into r from pay_settings where org_id=current_org();
 if not found then
  insert into pay_settings(org_id) values(current_org()) on conflict do nothing;
  select * into r from pay_settings where org_id=current_org();
 end if;
 return r;
end $$;
create function pulse.pay_event(p_run uuid, p_kind text, p_detail jsonb default '{}') returns void
 language sql security definer set search_path=pulse,pg_temp as $$
 insert into pay_run_event(org_id,run_id,actor,kind,detail) values(current_org(),p_run,current_viewer(),p_kind,coalesce(p_detail,'{}'))
$$;
create function pulse.pay_month_label(p_month date) returns text language sql immutable as $$ select to_char(p_month,'FMMonth YYYY') $$;
create function pulse.pay_run_row(p_run uuid) returns pulse.pay_run language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare r pay_run;
begin
 select * into r from pay_run where org_id=current_org() and id=p_run;
 if r.id is null then raise exception 'Payroll run not found' using errcode='P0002'; end if;
 return r;
end $$;
-- Tell every approver (not the actor) or every HR writer about a run. The notice's subject is the recipient themselves.
create function pulse.pay_tell(p_who text, p_run uuid, p_key text, p_title text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid;
begin
 for a in select distinct x from (select comp_founders() x union select r.person_id from role_assignment r where r.org_id=current_org()
   and r.role_key in ('leadership','hr','admin') and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) y
  where x is not null and x is distinct from current_viewer()
   and case when p_who='approvers' then comp_is_approver(x) else comp_perm(x,'hr.salary.write') and comp_has_role(x,'hr','leadership','admin') end loop
  perform comp_emit(a,'comp.payroll',a,p_key,p_title,'/people/pay/payroll/'||p_run);
 end loop;
end $$;

-- ----------------------------------------------------------------------------------------------- 3. settings
create function pulse.pay_settings_read() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pay_settings:=pay_settings_row();
begin
 if not (comp_reader() or comp_is_approver()) then raise exception 'Payroll is for founders and HR' using errcode='42501'; end if;
 return jsonb_build_object('statutory',s.statutory,'attendance',s.attendance,'payDay',s.pay_day,'bankFormat',s.bank_format,
  'debitAccount',s.debit_account,'narration',s.narration,'updatedAt',s.updated_at,'canEdit',comp_writer(),
  'cutoffDay',(select payroll_cutoff_day from hr_policy where org_id=current_org()),
  'attendanceEnabled',coalesce((select attendance_enabled from hr_policy where org_id=current_org()),true));
end $$;
create function pulse.pay_settings_save(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pay_settings:=pay_settings_row(); k text;
begin
 if not comp_writer() then raise exception 'HR sets up payroll' using errcode='42501'; end if;
 if p ? 'statutory' then
  if jsonb_typeof(p->'statutory')<>'object' then raise exception 'The statutory template is a set of parts' using errcode='22023'; end if;
  foreach k in array array['pf','esi','pt','tds'] loop
   if p->'statutory' ? k and (jsonb_typeof(p->'statutory'->k)<>'object' or jsonb_typeof(p->'statutory'->k->'on')<>'boolean') then
    raise exception 'Each statutory part says whether it is on' using errcode='22023'; end if;
  end loop;
 end if;
 update pay_settings set statutory=case when p ? 'statutory' then statutory||(p->'statutory') else statutory end,
  attendance=case when p ? 'attendance' then attendance||(p->'attendance') else attendance end,
  pay_day=coalesce((p->>'payDay')::int,pay_day),bank_format=coalesce(p->>'bankFormat',bank_format),
  debit_account=case when p ? 'debitAccount' then nullif(regexp_replace(coalesce(p->>'debitAccount',''),'\s',''),'') else debit_account end,
  narration=coalesce(nullif(btrim(p->>'narration'),''),narration),updated_by=current_viewer(),updated_at=now()
 where org_id=current_org();
 return pay_settings_read();
end $$;

-- ------------------------------------------------------------------------------------------- 4. the runs
-- The months and their runs (no amounts), and what the viewer may do.
create function pulse.pay_runs() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare today date:=lifecycle_today();
begin
 if not (comp_reader() or comp_is_approver()) then raise exception 'Payroll is for founders and HR' using errcode='42501'; end if;
 perform comp_log(null,'comp.payroll','runs');
 return jsonb_build_object('today',today,'runs',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'month',r.month,'seq',r.seq,'kind',r.kind,'status',r.status,
   'calc',r.calc,'people',r.people,'exceptions',r.exceptions,'payOn',r.pay_on,'note',r.note,'correctsId',r.corrects_id,
   'openedBy',comp_name(r.opened_by),'openedAt',r.opened_at,'checkedBy',comp_name(r.checked_by),'checkedAt',r.checked_at,
   'approvedBy',comp_name(r.approved_by),'approvedAt',r.approved_at,'payslips',(select count(*) from pay_payslip s where s.run_id=r.id),
   'payout',exists(select 1 from pay_payout o where o.run_id=r.id)) order by r.month desc,r.seq desc) from pay_run r where r.org_id=current_org() and r.status<>'withdrawn'),'[]'),
  'can',jsonb_build_object('start',comp_writer(),'approve',comp_is_approver(),'read',comp_reader()),
  'cutoffDay',(select payroll_cutoff_day from hr_policy where org_id=current_org()),
  'attendanceEnabled',coalesce((select attendance_enabled from hr_policy where org_id=current_org()),true),
  'withRecords',(select count(*) from comp_record c join person p on p.id=c.person_id where c.org_id=current_org() and p.status='active'
    and exists(select 1 from comp_change x where x.person_id=c.person_id and x.status='approved')),
  'staff',(select count(*) from person where org_id=current_org() and side='staff' and status='active'));
end $$;

-- HR starts a month: the first run is regular; once a regular run is locked, a new one corrects it (with a note).
create function pulse.pay_run_open(p_month date, p_note text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m date:=date_trunc('month',p_month)::date; today date:=lifecycle_today(); last_locked pay_run; v_id uuid; v_seq int; s pay_settings:=pay_settings_row(); v_pay date;
begin
 if not comp_writer() then raise exception 'HR starts payroll' using errcode='42501'; end if;
 if p_month is null or m>date_trunc('month',today)::date+interval '1 month' then raise exception 'Payroll runs for this month, next month or one already passed' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext(current_org()::text||'payroll'||m::text));
 if exists(select 1 from pay_run where org_id=current_org() and month=m and status in ('draft','checked')) then
  raise exception '% payroll is already open: carry on with it',pay_month_label(m) using errcode='22023'; end if;
 select * into last_locked from pay_run where org_id=current_org() and month=m and status='locked' order by seq desc limit 1;
 if last_locked.id is not null and length(btrim(coalesce(p_note,'')))<3 then raise exception 'Say what this correction is for' using errcode='22023'; end if;
 select coalesce(max(seq),0)+1 into v_seq from pay_run where org_id=current_org() and month=m;
 v_pay:=greatest(make_date(extract(year from m+interval '1 month')::int,extract(month from m+interval '1 month')::int,s.pay_day),
  case when last_locked.id is not null then today+2 else (m+interval '1 month')::date end);
 insert into pay_run(org_id,month,seq,kind,corrects_id,note,pay_on,opened_by)
 values(current_org(),m,v_seq,case when last_locked.id is null then 'regular' else 'correction' end,last_locked.id,nullif(btrim(coalesce(p_note,'')),''),v_pay,current_viewer())
 returning id into v_id;
 perform pay_event(v_id,case when last_locked.id is null then 'opened' else 'correction.opened' end,jsonb_build_object('month',m));
 return v_id;
end $$;

-- For a correction, the locked runs of its month (what they paid is paid again in full, then netted); else none.
create function pulse.pay_paid_runs(p_run uuid) returns text[] language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(array_agg(x.id::text),'{}') from pay_run r join pay_run x on x.org_id=r.org_id and x.month=r.month and x.status='locked'
 where r.id=p_run and r.kind='correction'
$$;

-- Who a run is about: pay in force on a day of the month, unpaid approved items or claims, an unpaid full and final,
-- a correction still to recover; for a correction run, also everyone the locked runs of the month paid.
create function pulse.pay_scope(p_run uuid) returns setof uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare r pay_run:=pay_run_row(p_run); f date:=r.month; l date:=(r.month+interval '1 month'-interval '1 day')::date;
begin
 return query select distinct x from (
  select c.person_id x from comp_record c where c.org_id=current_org() and (c.start_on is null or c.start_on<=l) and (c.end_on is null or c.end_on>=f)
   and exists(select 1 from comp_change v where v.person_id=c.person_id and v.status='approved' and v.effective_on<=l)
  union select i.person_id from comp_item i where i.org_id=current_org() and i.status='approved' and i.paid_at is null and i.payout='payroll' and i.for_month<=f
  union select k.person_id from comp_claim k where k.org_id=current_org() and k.status='approved' and k.paid_at is null and k.payout='payroll' and k.for_month<=f
  union select s.person_id from comp_settlement s where s.org_id=current_org() and s.status in ('approved','issued') and s.last_day<=l
   and not exists(select 1 from pay_run_line pl join pay_run pr on pr.id=pl.run_id and pr.status='locked' and pl.calc=pr.checked_calc where pl.settlement_id=s.id and pr.month<>f)
  union select pl.person_id from pay_run_line pl join pay_run pr on pr.id=pl.run_id and pr.status='locked' and pl.calc=pr.checked_calc
   where pr.org_id=current_org() and pl.recover and pl.recovered_in is null and pr.month<f and r.kind='regular'
  union select pl.person_id from pay_run_line pl join pay_run pr on pr.id=pl.run_id and pr.status='locked' and pl.calc=pr.checked_calc
   where pr.org_id=current_org() and pr.month=f and r.kind='correction'
 ) y join person p on p.id=y.x and p.side='staff' and p.org_id=current_org();
end $$;

-- Everything the calculation needs for each person in scope, without amounts (pay_run_sealed gives those). One
-- access-log line per person.
create function pulse.pay_run_inputs(p_run uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run:=pay_run_row(p_run); f date:=r.month; l date:=(r.month+interval '1 month'-interval '1 day')::date; today date:=lifecycle_today();
 s pay_settings:=pay_settings_row(); pol comp_policy:=comp_policy_row(); enabled boolean; late_rule jsonb; out jsonb:='[]'; who uuid; one jsonb; att jsonb;
 cutoff int; paid text[]:=pay_paid_runs(p_run);
begin
 if not comp_writer() then raise exception 'HR calculates payroll' using errcode='42501'; end if;
 enabled:=coalesce((select attendance_enabled from hr_policy where org_id=current_org()),true);
 cutoff:=(select payroll_cutoff_day from hr_policy where org_id=current_org());
 late_rule:=hr_rule_at('late_marks',l);
 for who in select pay_scope(p_run) loop
  perform comp_log(who,'comp.payroll','payroll_run');
  att:=case when not enabled then jsonb_build_object('enabled',false) else jsonb_build_object('enabled',true,
   'workingDays',(select count(*) from generate_series(f,l,interval '1 day') d where hr_person_working(who,d::date)),
   'lop',coalesce((select jsonb_agg(jsonb_build_object('date',x.day,'weight',x.weight,'why',x.why) order by x.day) from (
     select d::date as day,case when lr.half_day is not null then 0.5 else 1 end weight,'unpaid_leave' why
      from leave_request lr join leave_type t on t.org_id=lr.org_id and t.key=lr.leave_kind and not t.paid
      cross join generate_series(greatest(lr.from_date,f),least(lr.to_date,l),interval '1 day') d
      where lr.org_id=current_org() and lr.person_id=who and lr.status='approved' and lr.from_date<=l and lr.to_date>=f and hr_person_working(who,d::date)
     union all
     select h.day,0.5,'half_day' from hr_rule_days(who,f,least(l,today)) h where h.half_day
      and not exists(select 1 from leave_request lr where lr.person_id=who and lr.status='approved' and h.day between lr.from_date and lr.to_date)
     union all
     select d::date,1,'absent' from generate_series(greatest(f,coalesce((select min(e.work_date) from attendance_effective e where e.person_id=who and e.voided_at is null),l+1)),least(l,today-1),interval '1 day') d
      where hr_person_working(who,d::date)
       and not exists(select 1 from attendance_effective e where e.person_id=who and e.work_date=d::date and e.voided_at is null)
       and not exists(select 1 from leave_request lr where lr.person_id=who and lr.status='approved' and d::date between lr.from_date and lr.to_date)
   ) x),'[]'),
   'paidLeaveDays',coalesce((select sum(case when lr.half_day is not null then 0.5 else 1 end) from leave_request lr join leave_type t on t.org_id=lr.org_id and t.key=lr.leave_kind and t.paid
      cross join generate_series(greatest(lr.from_date,f),least(lr.to_date,l),interval '1 day') d
      where lr.org_id=current_org() and lr.person_id=who and lr.status='approved' and lr.from_date<=l and lr.to_date>=f and hr_person_working(who,d::date)),0),
   'lateMarks',(select count(*) from hr_rule_days(who,f,least(l,today)) h where h.late),
   'lateDebit',case when late_rule is null then 0 else coalesce(hr_late_debit(who,late_rule->>'balanceKind',f,l),0) end,
   'openCheckouts',(select count(*) from attendance_effective e where e.person_id=who and e.checked_out_at is null and e.voided_at is null and e.work_date<today and e.work_date<=l),
   'pendingLeave',(select count(*) from leave_request lr where lr.person_id=who and lr.status='pending' and lr.from_date<=l and lr.to_date>=f),
   'pendingCorrections',(select count(*) from attendance_regularisation g where g.person_id=who and g.status='pending' and g.work_date between f and l)) end;
  select jsonb_strip_nulls(jsonb_build_object('id',p.id,'name',p.display_name,'role',pp.role,'pod',pp.pod,'department',pp.department,'current',p.status='active',
   'joinedOn',pp.joined_on,
   'record',(select jsonb_build_object('startOn',c.start_on,'endOn',c.end_on,'status',c.status,'currency',c.currency) from comp_record c where c.person_id=p.id),
   'versions',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'effectiveOn',v.effective_on,'payType',v.pay_type,'kind',v.kind,'decidedAt',v.decided_at) order by v.effective_on,v.decided_at),'[]')
     from comp_change v where v.person_id=p.id and v.status='approved' and v.effective_on<=l),
   'pauses',(select coalesce(jsonb_agg(jsonb_build_object('from',z.from_on,'to',coalesce(z.ended_on,z.to_on),'paidPercent',z.paid_percent)),'[]')
     from comp_pause z where z.person_id=p.id and z.status='approved' and z.from_on<=l and coalesce(z.ended_on,z.to_on)>=f),
   'items',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'forMonth',i.for_month,'payout',i.payout,'recoverMonths',i.recover_months,
      'recoverFrom',i.recover_from,'paid',i.paid_at is not null and not coalesce(i.paid_in=any(paid),false),'reason',i.reason)),'[]')
     from comp_item i where i.person_id=p.id and i.status='approved' and ((i.paid_at is null or i.paid_in=any(paid)) and i.payout='payroll' and i.for_month<=f
      or i.kind in ('advance','loan') and i.recover_from<=f)),
   'claims',(select coalesce(jsonb_agg(jsonb_build_object('id',k.id,'forMonth',k.for_month,'category',k.category,'vendor',k.vendor)),'[]')
     from comp_claim k where k.person_id=p.id and k.status='approved' and (k.paid_at is null or k.paid_in=any(paid)) and k.payout='payroll' and k.for_month<=f),
   'pendingClaims',(select count(*) from comp_claim k where k.person_id=p.id and k.status in ('submitted','head_approved')),
   'settlement',(select jsonb_build_object('id',st.id,'status',st.status,'lastDay',st.last_day,'preparedOn',st.prepared_at::date) from comp_settlement st where st.person_id=p.id and st.status in ('approved','issued')
     and st.last_day<=l and not exists(select 1 from pay_run_line pl join pay_run pr on pr.id=pl.run_id and pr.status='locked' and pl.calc=pr.checked_calc
      where pl.settlement_id=st.id and not pr.id::text=any(paid))),
   'attendance',att,
   'bank',(select jsonb_build_object('onFile',o.bank is not null,'status',coalesce(o.bank_status,'pending')) from pulse_priv.person_onboarding o where o.org_id=current_org() and o.person_id=p.id),
   'pt',(select jsonb_build_object('state',e.pt_state,'category',e.pt_category,'exempt',e.pt_exempt) from hr_employment e where e.person_id=p.id),
   -- HR's adjustments, newest first (a correction keeps those of the runs it corrects; its own come first).
   'adjustments',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'kind',a.kind,'days',a.days,'label',a.label,'reason',a.reason,'by',comp_name(a.created_by),'at',a.created_at)
      order by (a.run_id=p_run) desc,a.created_at desc),'[]')
     from pay_adjustment a where (a.run_id=p_run or a.run_id::text=any(paid)) and a.person_id=p.id and a.removed_at is null)
  )) into one
  from person p left join people_profile pp on pp.person_id=p.id where p.id=who;
  out:=out||one;
 end loop;
 return jsonb_build_object('run',jsonb_build_object('id',r.id,'month',r.month,'kind',r.kind,'seq',r.seq,'status',r.status,'correctsId',r.corrects_id,'payOn',r.pay_on),
  'today',today,'people',out,'attendanceEnabled',enabled,'cutoffDay',cutoff,
  'cutoffPassed',case when cutoff is null then l<today else make_date(extract(year from f)::int,extract(month from f)::int,cutoff)<today end,
  'settings',jsonb_build_object('statutory',s.statutory,'attendance',s.attendance,'payDay',s.pay_day),
  'policy',jsonb_build_object('dayBasis',pol.day_basis,'components',pol.components,'currency',pol.currency),
  'ptRule',hr_rule_at('professional_tax',l),'lateRule',late_rule);
end $$;

-- The sealed values a calculation opens: approved versions, items, claims, the full and final, HR's amount adjustments,
-- what the locked runs of the month paid (corrections) and corrections still to recover. One log line per person.
create function pulse.pay_run_sealed(p_run uuid) returns table(kind text, id uuid, person_id uuid, seq int, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run:=pay_run_row(p_run); f date:=r.month; l date:=(r.month+interval '1 month'-interval '1 day')::date; v_people uuid[]; paid text[]:=pay_paid_runs(p_run);
begin
 if not comp_writer() then raise exception 'HR calculates payroll' using errcode='42501'; end if;
 select array_agg(x) into v_people from pay_scope(p_run) x;
 v_people:=coalesce(v_people,'{}');
 perform comp_log(x,'comp.pay','payroll_run') from unnest(v_people) x;
 return query
  select 'change'::text,c.id,c.person_id,null::int,c.s_kid,c.s_key,c.s_data from comp_change c where c.org_id=current_org() and c.person_id=any(v_people) and c.status='approved' and c.effective_on<=l
  union all select 'item',i.id,i.person_id,null,i.s_kid,i.s_key,i.s_data from comp_item i where i.org_id=current_org() and i.person_id=any(v_people) and i.status='approved'
   and ((i.paid_at is null or i.paid_in=any(paid)) and i.payout='payroll' and i.for_month<=f or i.kind in ('advance','loan') and i.recover_from<=f)
  union all select 'claim',k.id,k.person_id,null,k.s_kid,k.s_key,k.s_data from comp_claim k where k.org_id=current_org() and k.person_id=any(v_people) and k.status='approved'
   and (k.paid_at is null or k.paid_in=any(paid)) and k.payout='payroll' and k.for_month<=f
  union all select 'settlement',s.id,s.person_id,null,s.s_kid,s.s_key,s.s_data from comp_settlement s where s.org_id=current_org() and s.person_id=any(v_people) and s.status in ('approved','issued') and s.last_day<=l
  union all select 'adjustment',a.id,a.person_id,null,a.s_kid,a.s_key,a.s_data from pay_adjustment a where (a.run_id=p_run or a.run_id::text=any(paid)) and a.kind='amount' and a.removed_at is null
  union all select 'previous',pr.id,pl.person_id,pr.seq,pl.s_kid,pl.s_key,pl.s_data from pay_run_line pl join pay_run pr on pr.id=pl.run_id and pr.status='locked' and pl.calc=pr.checked_calc
   where pr.org_id=current_org() and pr.month=f and r.kind='correction'
  union all select 'carry',pr.id,pl.person_id,pr.seq,pl.s_kid,pl.s_key,pl.s_data from pay_run_line pl join pay_run pr on pr.id=pl.run_id and pr.status='locked' and pl.calc=pr.checked_calc
   where pr.org_id=current_org() and pl.recover and pl.recovered_in is null and pr.month<f and r.kind='regular' and pl.person_id=any(v_people);
end $$;

-- A calculation saved: the next calculation number, its lines and sealed totals. A checked run goes back to draft.
create function pulse.pay_run_save(p_run uuid, p jsonb) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run; n int; x jsonb; cnt int:=0; ex int:=0;
begin
 if not comp_writer() then raise exception 'HR calculates payroll' using errcode='42501'; end if;
 select * into r from pay_run where org_id=current_org() and id=p_run for update;
 if r.id is null then raise exception 'Payroll run not found' using errcode='P0002'; end if;
 if r.status not in ('draft','checked') then raise exception 'This payroll is % and cannot change',r.status using errcode='22023'; end if;
 n:=r.calc+1;
 for x in select value from jsonb_array_elements(coalesce(p->'lines','[]')) loop
  perform comp_sealed_check(x->'sealed');
  if not exists(select 1 from person where org_id=current_org() and id=(x->>'person')::uuid and side='staff') then raise exception 'Person not found' using errcode='P0002'; end if;
  insert into pay_run_line(org_id,run_id,calc,person_id,pay_type,pod,department,exceptions,hold,settlement_id,recover,s_kid,s_key,s_data)
  values(current_org(),p_run,n,(x->>'person')::uuid,nullif(x->>'payType',''),left(nullif(x->>'pod',''),80),left(nullif(x->>'department',''),80),
   coalesce((select array_agg(e) from jsonb_array_elements_text(coalesce(x->'exceptions','[]')) e),'{}'),coalesce((x->>'hold')::boolean,false),
   nullif(x->>'settlementId','')::uuid,coalesce((x->>'recover')::boolean,false),
   x->'sealed'->>'kid',decode(x->'sealed'->>'key','base64'),decode(x->'sealed'->>'data','base64'));
  cnt:=cnt+1; ex:=ex+jsonb_array_length(coalesce(x->'exceptions','[]'));
 end loop;
 if p ? 'totals' then perform comp_sealed_check(p->'totals'); end if;
 update pay_run set calc=n,status='draft',checked_calc=null,checked_by=null,checked_at=null,check_note=null,people=cnt,
  exceptions=ex+coalesce(jsonb_array_length(p->'runExceptions'),0),
  s_kid=p->'totals'->>'kid',s_key=decode(p->'totals'->>'key','base64'),s_data=decode(p->'totals'->>'data','base64') where id=p_run;
 perform pay_event(p_run,case when r.calc=0 then 'computed' else 'recomputed' end,jsonb_build_object('calc',n,'people',cnt,'exceptions',ex,
  'runExceptions',coalesce(p->'runExceptions','[]'),'wasChecked',r.status='checked'));
 return n;
end $$;

-- A run for its page: steps, people with their exceptions and adjustments (no amounts), events, payslips, the file.
create function pulse.pay_run_get(p_run uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run:=pay_run_row(p_run); me uuid:=current_viewer();
begin
 if not (comp_reader() or comp_is_approver()) then raise exception 'Payroll is for founders and HR' using errcode='42501'; end if;
 perform comp_log(null,'comp.payroll','run_view');
 return jsonb_build_object('id',r.id,'month',r.month,'seq',r.seq,'kind',r.kind,'status',r.status,'calc',r.calc,'checkedCalc',r.checked_calc,'note',r.note,
  'payOn',r.pay_on,'people',r.people,'exceptions',r.exceptions,'correctsId',r.corrects_id,
  'openedBy',comp_name(r.opened_by),'openedAt',r.opened_at,'checkedBy',comp_name(r.checked_by),'checkedById',r.checked_by,'checkedAt',r.checked_at,'checkNote',r.check_note,
  'approvedBy',comp_name(r.approved_by),'approvedAt',r.approved_at,'approveNote',r.approve_note,
  'lines',(select coalesce(jsonb_agg(jsonb_build_object('person',l.person_id,'name',p.display_name,'role',pp.role,'pod',l.pod,'department',l.department,'payType',l.pay_type,
     'exceptions',l.exceptions,'hold',l.hold,'settlement',l.settlement_id is not null,'recover',l.recover,'self',l.person_id=me,
     'adjustments',(select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'kind',a.kind,'days',a.days,'label',a.label,'reason',a.reason,'by',comp_name(a.created_by),'at',a.created_at) order by a.created_at),'[]')
       from pay_adjustment a where a.run_id=r.id and a.person_id=l.person_id and a.removed_at is null),
     'payslip',(select jsonb_build_object('id',s.id,'version',s.version,'seenAt',s.seen_at) from pay_payslip s where s.run_id=r.id and s.person_id=l.person_id))
     order by p.display_name),'[]') from pay_run_line l join person p on p.id=l.person_id left join people_profile pp on pp.person_id=l.person_id
     where l.run_id=r.id and l.calc=coalesce(r.checked_calc,r.calc)),
  'events',(select coalesce(jsonb_agg(jsonb_build_object('at',e.at,'kind',e.kind,'by',comp_name(e.actor),'detail',e.detail) order by e.at desc),'[]') from pay_run_event e where e.run_id=r.id),
  'calcs',(select coalesce(jsonb_agg(distinct l.calc),'[]') from pay_run_line l where l.run_id=r.id),
  'payout',(select jsonb_build_object('format',o.format,'rows',o.rows,'leftOut',o.left_out,'sha256',o.sha256,'createdAt',o.created_at) from pay_payout o where o.run_id=r.id),
  'corrections',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'seq',c.seq,'status',c.status) order by c.seq),'[]') from pay_run c where c.corrects_id=r.id or c.month=r.month and c.id<>r.id and c.status<>'withdrawn'),
  'can',jsonb_build_object('compute',comp_writer() and r.status in ('draft','checked'),'adjust',comp_writer() and r.status='draft','check',comp_writer() and r.status='draft' and r.calc>0,
   'approve',comp_is_approver() and r.status='checked' and r.checked_by is distinct from me,'return',(comp_is_approver() or comp_writer()) and r.status='checked',
   'withdraw',comp_writer() and r.status in ('draft','checked'),'payout',(comp_is_approver() or comp_writer()) and r.status='locked',
   'correct',comp_writer() and r.status='locked' and not exists(select 1 from pay_run x where x.org_id=current_org() and x.month=r.month and x.status in ('draft','checked')),
   'figures',comp_reader()),
  'today',lifecycle_today());
end $$;

-- A calculation's sealed lines (each person logged) and the run's sealed totals.
create function pulse.pay_run_lines(p_run uuid, p_calc int) returns table(person_id uuid, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run:=pay_run_row(p_run);
begin
 if not comp_reader() then raise exception 'Payroll figures are for founders and HR' using errcode='42501'; end if;
 perform comp_log(l.person_id,'comp.payroll','payroll_view') from pay_run_line l where l.run_id=r.id and l.calc=coalesce(p_calc,r.calc);
 return query select l.person_id,l.s_kid,l.s_key,l.s_data from pay_run_line l where l.run_id=r.id and l.calc=coalesce(p_calc,r.calc);
end $$;
create function pulse.pay_run_totals(p_run uuid) returns table(kid text, dkey bytea, data bytea) language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run:=pay_run_row(p_run);
begin
 if not comp_reader() then raise exception 'Payroll figures are for founders and HR' using errcode='42501'; end if;
 perform comp_log(null,'comp.payroll','run_totals');
 return query select r.s_kid,r.s_key,r.s_data where r.s_data is not null;
end $$;

-- ------------------------------------------------------------------------------------------ 5. adjustments
create function pulse.pay_adjust(p_run uuid, p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run; v_person uuid:=nullif(p->>'person','')::uuid; v_kind text:=p->>'kind'; v_id uuid;
begin
 if not comp_writer() then raise exception 'HR adjusts payroll' using errcode='42501'; end if;
 select * into r from pay_run where org_id=current_org() and id=p_run for update;
 if r.id is null then raise exception 'Payroll run not found' using errcode='P0002'; end if;
 if r.status<>'draft' then raise exception 'Send the payroll back to draft before changing it' using errcode='22023'; end if;
 if v_person is null or not exists(select 1 from pay_run_line where run_id=p_run and calc=r.calc and person_id=v_person) then raise exception 'This person is not in this payroll' using errcode='22023'; end if;
 if v_person=current_viewer() then raise exception 'Someone else in HR adjusts your own pay' using errcode='42501'; end if;
 if v_kind not in ('lop_days','amount','hold') then raise exception 'Choose loss-of-pay days, an amount or a hold' using errcode='22023'; end if;
 if v_kind='amount' then perform comp_sealed_check(p->'sealed'); end if;
 if v_kind in ('lop_days','hold') then update pay_adjustment set removed_at=now(),removed_by=current_viewer() where run_id=p_run and person_id=v_person and kind=v_kind and removed_at is null; end if;
 insert into pay_adjustment(org_id,id,run_id,person_id,kind,days,label,reason,s_kid,s_key,s_data,created_by)
 values(current_org(),coalesce(nullif(p->>'id','')::uuid,gen_random_uuid()),p_run,v_person,v_kind,case when v_kind='lop_days' then (p->>'days')::numeric end,
  case when v_kind='amount' then left(btrim(coalesce(p->>'label','')),80) end,btrim(coalesce(p->>'reason','')),
  case when v_kind='amount' then p->'sealed'->>'kid' end,case when v_kind='amount' then decode(p->'sealed'->>'key','base64') end,
  case when v_kind='amount' then decode(p->'sealed'->>'data','base64') end,current_viewer()) returning id into v_id;
 perform pay_event(p_run,'adjusted',jsonb_build_object('person',v_person,'adjustment',v_kind));
 return v_id;
end $$;
create function pulse.pay_adjust_remove(p_id uuid) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a pay_adjustment; r pay_run;
begin
 if not comp_writer() then raise exception 'HR adjusts payroll' using errcode='42501'; end if;
 select * into a from pay_adjustment where org_id=current_org() and id=p_id and removed_at is null;
 if a.id is null then raise exception 'Adjustment not found' using errcode='P0002'; end if;
 select * into r from pay_run where id=a.run_id;
 if r.status<>'draft' then raise exception 'Send the payroll back to draft before changing it' using errcode='22023'; end if;
 update pay_adjustment set removed_at=now(),removed_by=current_viewer() where id=p_id;
 perform pay_event(a.run_id,'adjustment.removed',jsonb_build_object('person',a.person_id,'adjustment',a.kind));
 return a.run_id;
end $$;

-- --------------------------------------------------------------------------------------------- 6. the steps
create function pulse.pay_run_check(p_run uuid, p_calc int, p_note text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run;
begin
 if not comp_writer() then raise exception 'HR checks payroll' using errcode='42501'; end if;
 select * into r from pay_run where org_id=current_org() and id=p_run for update;
 if r.id is null then raise exception 'Payroll run not found' using errcode='P0002'; end if;
 if r.status<>'draft' or r.calc=0 then raise exception 'Only a calculated draft is checked' using errcode='22023'; end if;
 if p_calc is distinct from r.calc then raise exception 'The payroll changed since you opened it: look at it again' using errcode='40001'; end if;
 update pay_run set status='checked',checked_calc=r.calc,checked_by=current_viewer(),checked_at=now(),check_note=nullif(btrim(coalesce(p_note,'')),'') where id=p_run;
 perform pay_event(p_run,'checked',jsonb_build_object('calc',r.calc,'people',r.people,'exceptions',r.exceptions));
 perform pay_tell('approvers',p_run,'payroll:'||p_run||':checked',pay_month_label(r.month)||' payroll is checked and waits for your approval');
 return 'checked';
end $$;
create function pulse.pay_run_return(p_run uuid, p_note text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run;
begin
 if not (comp_is_approver() or comp_writer()) then raise exception 'Founders and HR send payroll back' using errcode='42501'; end if;
 select * into r from pay_run where org_id=current_org() and id=p_run for update;
 if r.id is null then raise exception 'Payroll run not found' using errcode='P0002'; end if;
 if r.status<>'checked' then raise exception 'Only a checked payroll goes back to draft' using errcode='22023'; end if;
 if length(btrim(coalesce(p_note,'')))<3 then raise exception 'Say what to look at again' using errcode='22023'; end if;
 update pay_run set status='draft',checked_calc=null,checked_by=null,checked_at=null where id=p_run;
 perform pay_event(p_run,'returned',jsonb_build_object('note',left(btrim(p_note),300)));
 perform pay_tell('writers',p_run,'payroll:'||p_run||':returned:'||extract(epoch from now())::bigint,pay_month_label(r.month)||' payroll was sent back: '||left(btrim(p_note),120));
 return 'draft';
end $$;
create function pulse.pay_run_withdraw(p_run uuid, p_note text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run;
begin
 if not comp_writer() then raise exception 'HR withdraws payroll' using errcode='42501'; end if;
 select * into r from pay_run where org_id=current_org() and id=p_run for update;
 if r.id is null then raise exception 'Payroll run not found' using errcode='P0002'; end if;
 if r.status not in ('draft','checked') then raise exception 'A locked payroll is corrected, not withdrawn' using errcode='22023'; end if;
 update pay_run set status='withdrawn',withdrawn_by=current_viewer(),withdrawn_at=now() where id=p_run;
 perform pay_event(p_run,'withdrawn',jsonb_build_object('note',left(btrim(coalesce(p_note,'')),300)));
 return 'withdrawn';
end $$;

-- Before the API draws payslips and the bank file: may the viewer approve this run?
create function pulse.pay_lock_check(p_run uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run:=pay_run_row(p_run); me uuid:=current_viewer();
begin
 if not comp_is_approver() then raise exception 'The approver named in the pay policy approves payroll' using errcode='42501'; end if;
 if r.status<>'checked' then raise exception 'Only a checked payroll is approved' using errcode='22023'; end if;
 if r.checked_by=me then raise exception 'Someone other than the person who checked it approves payroll' using errcode='42501'; end if;
 if exists(select 1 from pay_adjustment a where a.run_id=r.id and a.person_id=me and a.removed_at is null) then
  raise exception 'Your own pay was adjusted in this payroll: another founder approves it' using errcode='42501'; end if;
 return jsonb_build_object('calc',r.checked_calc,'month',r.month,'kind',r.kind,'payOn',r.pay_on,'seq',r.seq);
end $$;

-- The bank details of the people a checked or locked run pays, sealed, for the approver or HR to build the bank file.
-- Outside HR, the one place account numbers are read: each person's read is logged as payout_file.
create function pulse.pay_bank_sealed(p_run uuid) returns table(person_id uuid, key_id text, data_key bytea, sealed bytea, status text)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run:=pay_run_row(p_run);
begin
 if not (comp_is_approver() or comp_writer()) then raise exception 'The bank file is for founders and HR' using errcode='42501'; end if;
 if r.status not in ('checked','locked') then raise exception 'The bank file is made from a checked payroll' using errcode='22023'; end if;
 perform hr_log(l.person_id,'onboarding.bank.account','payout_file') from pay_run_line l where l.run_id=r.id and l.calc=r.checked_calc and not l.hold;
 return query select o.person_id,o.bank_key_id,o.bank_key,o.bank,coalesce(o.bank_status,'pending') from pulse_priv.person_onboarding o
  join pay_run_line l on l.person_id=o.person_id and l.run_id=r.id and l.calc=r.checked_calc and not l.hold
  where o.org_id=current_org() and o.bank is not null;
end $$;

-- Approve and lock: the payslips, the bank file and the ledger arrive sealed; items and claims are marked paid.
create function pulse.pay_run_lock(p_run uuid, p jsonb) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run; me uuid:=current_viewer(); x jsonb; want uuid[]; got uuid[]; v int; who uuid;
begin
 perform pay_lock_check(p_run);
 select * into r from pay_run where org_id=current_org() and id=p_run for update;
 if r.status<>'checked' then raise exception 'Only a checked payroll is approved' using errcode='22023'; end if;
 select coalesce(array_agg(person_id order by person_id),'{}') into want from pay_run_line where run_id=p_run and calc=r.checked_calc;
 select coalesce(array_agg((value->>'person')::uuid order by (value->>'person')::uuid),'{}') into got from jsonb_array_elements(coalesce(p->'payslips','[]'));
 if want<>got then raise exception 'Every person in the checked payroll gets one payslip' using errcode='22023'; end if;
 for x in select value from jsonb_array_elements(p->'payslips') loop
  perform comp_sealed_check(x->'sealed'); perform comp_sealed_check(x->'pdf');
  select coalesce(max(version),0)+1 into v from pay_payslip where org_id=current_org() and person_id=(x->>'person')::uuid and month=r.month;
  insert into pay_payslip(org_id,id,run_id,person_id,month,version,s_kid,s_key,s_data,p_kid,p_key,p_data,sha256,pages,issued_by)
  values(current_org(),coalesce(nullif(x->>'id','')::uuid,gen_random_uuid()),p_run,(x->>'person')::uuid,r.month,v,
   x->'sealed'->>'kid',decode(x->'sealed'->>'key','base64'),decode(x->'sealed'->>'data','base64'),
   x->'pdf'->>'kid',decode(x->'pdf'->>'key','base64'),decode(x->'pdf'->>'data','base64'),x->>'sha256',(x->>'pages')::int,me);
 end loop;
 if p->'payout' is not null and jsonb_typeof(p->'payout')='object' then
  perform comp_sealed_check(p->'payout'->'sealed');
  insert into pay_payout(org_id,run_id,format,rows,left_out,s_kid,s_key,s_data,sha256,created_by)
  values(current_org(),p_run,p->'payout'->>'format',(p->'payout'->>'rows')::int,coalesce((p->'payout'->>'leftOut')::int,0),
   p->'payout'->'sealed'->>'kid',decode(p->'payout'->'sealed'->>'key','base64'),decode(p->'payout'->'sealed'->>'data','base64'),p->'payout'->>'sha256',me);
 end if;
 for x in select value from jsonb_array_elements(coalesce(p->'ledger'->'entries','[]')) loop
  perform comp_sealed_check(x->'sealed');
  insert into pay_ledger_entry(org_id,id,run_id,month,account,side,pod,department,people,s_kid,s_key,s_data)
  values(current_org(),coalesce(nullif(x->>'id','')::uuid,gen_random_uuid()),p_run,r.month,x->>'account',x->>'side',left(nullif(x->>'pod',''),80),left(nullif(x->>'department',''),80),coalesce((x->>'people')::int,0),
   x->'sealed'->>'kid',decode(x->'sealed'->>'key','base64'),decode(x->'sealed'->>'data','base64'));
 end loop;
 for x in select value from jsonb_array_elements(coalesce(p->'ledger'->'totals','[]')) loop
  perform comp_sealed_check(x->'sealed');
  insert into pay_ledger_total(org_id,run_id,month,account,side,people,s_kid,s_key,s_data)
  values(current_org(),p_run,r.month,x->>'account',x->>'side',coalesce((x->>'people')::int,0),
   x->'sealed'->>'kid',decode(x->'sealed'->>'key','base64'),decode(x->'sealed'->>'data','base64'));
 end loop;
 -- What this payroll paid: one-time items and claims of people in it, and corrections it recovered.
 update comp_item set paid_in=p_run::text,paid_at=now() where org_id=current_org() and status='approved' and paid_at is null
  and id in (select value::uuid from jsonb_array_elements_text(coalesce(p->'paid'->'items','[]')))
  and person_id=any(want);
 update comp_claim set paid_in=p_run::text,paid_at=now() where org_id=current_org() and status='approved' and paid_at is null
  and id in (select value::uuid from jsonb_array_elements_text(coalesce(p->'paid'->'claims','[]')))
  and person_id=any(want);
 update pay_run_line pl set recovered_in=p_run from pay_run pr where pr.id=pl.run_id and pr.org_id=current_org() and pr.status='locked' and pl.calc=pr.checked_calc
  and pl.recover and pl.recovered_in is null and pl.person_id=any(want)
  and pl.run_id in (select value::uuid from jsonb_array_elements_text(coalesce(p->'paid'->'carries','[]')));
 update pay_run set status='locked',approved_by=me,approved_at=now(),approve_note=nullif(btrim(coalesce(p->>'note','')),'') where id=p_run;
 perform pay_event(p_run,'locked',jsonb_build_object('calc',r.checked_calc,'payslips',cardinality(want),'payout',p->'payout' is not null and jsonb_typeof(p->'payout')='object',
  'ledgerEntries',jsonb_array_length(coalesce(p->'ledger'->'entries','[]'))));
 foreach who in array want loop
  perform comp_emit(who,'comp.payslip',who,'payslip:'||p_run||':'||who,'Your payslip for '||pay_month_label(r.month)||' is ready','/me/pay');
 end loop;
 perform pay_tell('writers',p_run,'payroll:'||p_run||':locked',pay_month_label(r.month)||' payroll is approved: payslips are out and the bank file is ready');
 return 'locked';
end $$;

-- --------------------------------------------------------------------------------- 7. payslips and the file
create function pulse.pay_payslip_sealed(p_id uuid, p_part text) returns table(person_id uuid, month date, version int, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pay_payslip; me uuid:=current_viewer();
begin
 select * into s from pay_payslip where org_id=current_org() and id=p_id;
 if s.id is null or me is null or not (comp_reader() or s.person_id=me) then raise exception 'Payslip not found' using errcode='P0002'; end if;
 perform comp_log(s.person_id,'comp.payslip',case when s.person_id=me then 'self' else 'payslip_view' end);
 if s.person_id=me and s.seen_at is null then update pay_payslip set seen_at=now() where id=p_id; end if;
 return query select s.person_id,s.month,s.version,case when p_part='pdf' then s.p_kid else s.s_kid end,case when p_part='pdf' then s.p_key else s.s_key end,
  case when p_part='pdf' then s.p_data else s.s_data end;
end $$;
-- A person's payslips (no amounts): the person, or founders and HR.
create function pulse.pay_payslips(p_person uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();
begin
 if me is null or not (p_person=me or comp_reader()) then raise exception 'Payslips are for the person, founders and HR' using errcode='42501'; end if;
 perform comp_log(p_person,'comp.payslip',case when p_person=me then 'self_list' else 'payslip_list' end);
 return coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'month',s.month,'version',s.version,'issuedAt',s.issued_at,'seenAt',s.seen_at,'pages',s.pages,
   'correction',r.kind='correction') order by s.month desc,s.version desc) from pay_payslip s join pay_run r on r.id=s.run_id where s.org_id=current_org() and s.person_id=p_person),'[]');
end $$;
create function pulse.pay_payout_sealed(p_run uuid) returns table(month date, seq int, format text, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r pay_run:=pay_run_row(p_run); o pay_payout;
begin
 if not (comp_is_approver() or comp_writer()) then raise exception 'The bank file is for founders and HR' using errcode='42501'; end if;
 select * into o from pay_payout where run_id=r.id;
 if o.run_id is null then raise exception 'This payroll has no bank file' using errcode='P0002'; end if;
 perform hr_log(l.person_id,'onboarding.bank.account','payout_file_download') from pay_run_line l where l.run_id=r.id and l.calc=r.checked_calc and not l.hold;
 perform pay_event(p_run,'payout.downloaded',jsonb_build_object('format',o.format,'rows',o.rows));
 return query select r.month,r.seq,o.format,o.s_kid,o.s_key,o.s_data;
end $$;

-- ----------------------------------------------------------------------------------------------- 8. ledger
-- The journal by pod and department (founders and HR) and the totals by account (also the Accountant). Locked runs only.
create function pulse.pay_ledger(p_from date, p_to date) returns table(id uuid, run_id uuid, month date, kind text, account text, side text, pod text, department text, people int, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not comp_reader() then raise exception 'The people-cost ledger by pod is for founders and HR' using errcode='42501'; end if;
 perform comp_log(null,'comp.ledger','ledger_view');
 return query select e.id,e.run_id,e.month,r.kind,e.account,e.side,e.pod,e.department,e.people,e.s_kid,e.s_key,e.s_data
  from pay_ledger_entry e join pay_run r on r.id=e.run_id and r.status='locked'
  where e.org_id=current_org() and e.month between date_trunc('month',coalesce(p_from,'1900-01-01'))::date and coalesce(p_to,'2999-12-31') order by e.month,e.account;
end $$;
create function pulse.pay_ledger_totals(p_from date, p_to date) returns table(run_id uuid, month date, kind text, account text, side text, people int, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare acct boolean:=is_accountant(current_viewer());
begin
 if current_viewer() is null or not (comp_reader() or acct) then raise exception 'People-cost totals are for founders, HR and the accountant' using errcode='42501'; end if;
 perform comp_log(null,'comp.ledger',case when acct then 'accountant_totals' else 'ledger_totals' end);
 return query select t.run_id,t.month,r.kind,t.account,t.side,t.people,t.s_kid,t.s_key,t.s_data
  from pay_ledger_total t join pay_run r on r.id=t.run_id and r.status='locked'
  where t.org_id=current_org() and t.month between date_trunc('month',coalesce(p_from,'1900-01-01'))::date and coalesce(p_to,'2999-12-31') order by t.month,t.account;
end $$;

-- -------------------------------------------------------------------------------------------- 9. notices
select pulse.check_values_add('pulse.notification'::regclass,'notification_event_type_check','event_type',array['comp.payroll','comp.payslip']);
create or replace function pulse.comp_notice_allowed(p_to uuid, p_type text, p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(case
  when p_type in ('comp.letter','comp.claim','comp.offer','comp.payslip') then p_to=p_person
  when p_type='comp.waiting' then p_to<>p_person and (comp_is_approver(p_to) or comp_perm(p_to,'hr.salary.write') or hr_head(p_person)=p_to)
  when p_type='comp.decided' then p_to<>p_person and (comp_is_approver(p_to) or comp_perm(p_to,'hr.salary.write'))
  when p_type='comp.probation' then p_to<>p_person and (comp_perm(p_to,'hr.salary.write') or hr_head(p_person)=p_to)
  -- COMP-B: payroll steps go to approvers and HR; the notice's subject is the recipient.
  when p_type='comp.payroll' then p_to=p_person and (comp_is_approver(p_to) or comp_perm(p_to,'hr.salary.write'))
  else false end,false)
$$;

-- ---------------------------------------------------------------------------------------------- 10. grants
do $$ declare f text; begin
 for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pulse' and p.proname like 'pay\_%' loop
  execute format('revoke all on function %s from public',f);
 end loop;
end $$;
grant execute on function pulse.pay_settings_read(), pulse.pay_settings_save(jsonb), pulse.pay_runs(), pulse.pay_run_open(date,text), pulse.pay_run_inputs(uuid),
 pulse.pay_run_sealed(uuid), pulse.pay_run_save(uuid,jsonb), pulse.pay_run_get(uuid), pulse.pay_run_lines(uuid,int), pulse.pay_run_totals(uuid),
 pulse.pay_adjust(uuid,jsonb), pulse.pay_adjust_remove(uuid), pulse.pay_run_check(uuid,int,text), pulse.pay_run_return(uuid,text), pulse.pay_run_withdraw(uuid,text),
 pulse.pay_lock_check(uuid), pulse.pay_bank_sealed(uuid), pulse.pay_run_lock(uuid,jsonb), pulse.pay_payslip_sealed(uuid,text), pulse.pay_payslips(uuid),
 pulse.pay_payout_sealed(uuid), pulse.pay_ledger(date,date), pulse.pay_ledger_totals(date,date) to pulse_api;

-- migrate:down
-- Forward-only.
