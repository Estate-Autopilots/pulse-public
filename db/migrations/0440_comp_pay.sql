-- migrate:up
-- COMP-A (owner, 13 Oct 2026): people's pay, from offer to exit. "There is no mechanism to increase, decrease or
-- update salary, or the probation period." One pay record per person with a status and a dated history of changes;
-- offers with acceptance links, probation outcomes, pauses, one-time items, reimbursement claims and the full and final
-- statement, each with a letter. docs/ops/COMP.md describes the model.
--  * Amounts never reach PostgreSQL in plaintext: the API seals them with the document keyring (PRESENCE-2 envelope) and
--    stores ciphertext here (s_kid, s_key, s_data); letters and receipts likewise. The database decides who may read a
--    sealed value and logs every read before returning it; the API opens it only then.
--  * The API role reads no table directly: every read and write is a pulse.comp_* function. Individuals' pay is for
--    hr_can('hr.salary.read') (the HR and leadership roles, an admin given the permission); each person reads their own;
--    a manager reads status and dates only when the company's pay policy says so; the Accountant gets totals.
--  * Maker-checker: a writer proposes (HR), an approver decides (the policy: founders, else leadership; or leadership;
--    or a second writer). Nobody approves what they proposed, and nobody proposes or decides their own pay.

-- ---------------------------------------------------------------------------------------------------- 1. tables
create table pulse.comp_policy (
 org_id uuid primary key references pulse.org(id),
 approvers text not null default 'founders' check (approvers in ('founders','leadership','second_hr')),
 probation_approval text not null default 'hr' check (probation_approval in ('hr','founder')),
 managers text not null default 'none' check (managers in ('none','status')),
 currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
 probation_days int not null default 90 check (probation_days between 0 and 365),
 remind_days int not null default 14 check (remind_days between 1 and 60),
 notice_probation int check (notice_probation between 0 and 180),
 notice_confirmed int check (notice_confirmed between 0 and 180),
 offer_days int not null default 7 check (offer_days between 1 and 60),
 day_basis text not null default 'calendar' check (day_basis in ('calendar','30','26')),
 encash_basis text not null default 'basic' check (encash_basis in ('basic','gross','none')),
 encash_divisor int not null default 30 check (encash_divisor in (26,30)),
 -- The company's salary structure: earnings and employer contributions, each a share of gross or of another component,
 -- or the balance; a cap is in paise (Employer PF: 12% of basic up to the ₹15,000 wage ceiling). India's default; a
 -- company elsewhere keeps one "base" earning. Claim thresholds and caps below are in whole rupees.
 components jsonb not null default '[{"key":"basic","label":"Basic","kind":"earning","of":"gross","pct":50},
  {"key":"hra","label":"House rent allowance","kind":"earning","of":"basic","pct":40},
  {"key":"special","label":"Special allowance","kind":"earning","balance":true},
  {"key":"pf_employer","label":"Employer PF","kind":"employer","of":"basic","pct":12,"cap":180000}]'
  check (jsonb_typeof(components)='array' and jsonb_array_length(components)<=20),
 claim_categories jsonb not null default '[{"key":"travel","label":"Travel"},{"key":"meals","label":"Meals with clients or the team"},
  {"key":"internet","label":"Internet and phone"},{"key":"equipment","label":"Equipment and supplies"},{"key":"shoot","label":"Shoot expenses"},
  {"key":"other","label":"Other"}]' check (jsonb_typeof(claim_categories)='array' and jsonb_array_length(claim_categories) between 1 and 20),
 claim_threshold numeric(12,2) default 5000 check (claim_threshold is null or claim_threshold>=0),
 recover_max int not null default 12 check (recover_max between 1 and 60),
 letters jsonb not null default '{}' check (jsonb_typeof(letters)='object'),
 updated_by uuid, updated_at timestamptz not null default now()
);

create table pulse.comp_record (
 org_id uuid not null references pulse.org(id),
 person_id uuid primary key references pulse.person(id) on delete cascade,
 currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
 status text not null default 'proposed' check (status in ('proposed','offered','accepted','probation','confirmed','paused','notice','ended')),
 status_since date, status_until date, refreshed_on date,
 start_on date, end_on date, confirmed_on date,
 created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- A version of someone's pay. In force from its date once approved (an offer's once accepted).
create table pulse.comp_change (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.comp_record(person_id) on delete cascade,
 kind text not null check (kind in ('offer','start','raise','cut','correction','promotion','role_change')),
 status text not null default 'draft' check (status in ('draft','proposed','approved','rejected','withdrawn')),
 effective_on date not null,
 pay_type text not null check (pay_type in ('salary','stipend','contractor','retainer','hourly')),
 role text check (length(role) between 1 and 120),
 role_applied_at timestamptz,
 job_id uuid,
 reason text check (length(reason)<=1000),
 corrects_id uuid references pulse.comp_change(id),
 before_id uuid references pulse.comp_change(id),
 source text not null default 'pulse' check (source in ('pulse','import')),
 import_ref uuid,
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=16384),
 proposed_by uuid, proposed_at timestamptz, decided_by uuid, decided_at timestamptz, decision_note text check (length(decision_note)<=1000),
 letter_id uuid,
 created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check (decided_by is null or proposed_by is null or decided_by<>proposed_by),
 check (proposed_by is distinct from person_id and decided_by is distinct from person_id)
);
create index comp_change_person on pulse.comp_change(org_id, person_id, effective_on desc);

create table pulse.comp_offer (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.comp_record(person_id) on delete cascade,
 change_id uuid not null references pulse.comp_change(id) on delete cascade,
 status text not null default 'draft' check (status in ('draft','proposed','approved','sent','accepted','declined','expired','withdrawn')),
 role text not null check (length(role) between 1 and 120),
 start_on date not null,
 probation_days int not null default 0 check (probation_days between 0 and 365),
 notice_days int check (notice_days between 0 and 180),
 terms text check (length(terms)<=4000),
 valid_until date not null,
 task_id uuid references pulse.task(id) on delete set null,
 proposed_by uuid, proposed_at timestamptz, approved_by uuid, approved_at timestamptz, sent_by uuid, sent_at timestamptz,
 answered_at timestamptz, answer_name text check (length(answer_name)<=120), answer_via text check (answer_via in ('link','pulse')),
 answer_note text check (length(answer_note)<=1000), closed_note text check (length(closed_note)<=1000), started_at timestamptz,
 letter_id uuid,
 created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 check (approved_by is null or proposed_by is null or approved_by<>proposed_by),
 check (approved_by is distinct from person_id and sent_by is distinct from person_id)
);
create unique index comp_offer_live on pulse.comp_offer(person_id) where status in ('draft','proposed','approved','sent');

-- The person's link to read and answer an offer. Only a hash of the token is kept (as ERP's acceptance links).
create table pulse.comp_offer_link (
 token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
 org_id uuid not null references pulse.org(id),
 offer_id uuid not null references pulse.comp_offer(id) on delete cascade,
 created_by uuid, created_at timestamptz not null default now(), expires_at timestamptz not null, revoked_at timestamptz,
 opened_at timestamptz, decided_at timestamptz, decision text check (decision in ('accepted','declined')),
 signer_name text check (length(signer_name)<=120), signer_note text check (length(signer_note)<=1000),
 signer_ip_hash text check (signer_ip_hash ~ '^[0-9a-f]{64}$'), signer_agent text check (length(signer_agent)<=300)
);

create table pulse.comp_probation (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.comp_record(person_id) on delete cascade,
 action text not null check (action in ('confirm','extend','end')),
 until_on date,
 note text check (length(note)<=1000),
 status text not null default 'proposed' check (status in ('proposed','approved','rejected','withdrawn')),
 proposed_by uuid, proposed_at timestamptz not null default now(), decided_by uuid, decided_at timestamptz,
 decision_note text check (length(decision_note)<=1000), letter_id uuid,
 check ((action='confirm')=(until_on is null)),
 check (proposed_by is distinct from person_id and decided_by is distinct from person_id)
);
create unique index comp_probation_live on pulse.comp_probation(person_id) where status='proposed';

create table pulse.comp_probation_review (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.comp_record(person_id) on delete cascade,
 kind text not null check (kind in ('midpoint','final')),
 due_on date not null,
 status text not null default 'due' check (status in ('due','done','skipped')),
 note text check (length(note)<=2000),
 done_by uuid, done_at timestamptz, reminded_at timestamptz,
 unique (person_id, kind, due_on)
);

create table pulse.comp_pause (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.comp_record(person_id) on delete cascade,
 from_on date not null, to_on date not null, ended_on date,
 paid_percent int not null default 0 check (paid_percent between 0 and 99),
 reason_kind text not null check (reason_kind in ('unpaid_leave','sabbatical','hold','other')),
 note text check (length(note)<=1000),
 status text not null default 'proposed' check (status in ('proposed','approved','rejected','withdrawn')),
 proposed_by uuid, proposed_at timestamptz not null default now(), decided_by uuid, decided_at timestamptz,
 decision_note text check (length(decision_note)<=1000), letter_id uuid,
 check (to_on>=from_on and to_on<=from_on+730), check (ended_on is null or ended_on between from_on-1 and to_on),
 check (decided_by is null or proposed_by is null or decided_by<>proposed_by),
 check (proposed_by is distinct from person_id and decided_by is distinct from person_id)
);

create table pulse.comp_item (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.comp_record(person_id) on delete cascade,
 kind text not null check (kind in ('bonus','incentive','extra','overtime','arrears','advance','loan')),
 status text not null default 'proposed' check (status in ('proposed','approved','rejected','withdrawn')),
 for_month date not null check (extract(day from for_month)=1),
 payout text not null default 'payroll' check (payout in ('payroll','separate')),
 reason text check (length(reason)<=1000),
 ref jsonb not null default '{}' check (jsonb_typeof(ref)='object' and pg_column_size(ref)<4096),
 recover_months int check (recover_months between 1 and 60),
 recover_from date check (recover_from is null or extract(day from recover_from)=1),
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=4096),
 proposed_by uuid, proposed_at timestamptz not null default now(), decided_by uuid, decided_at timestamptz,
 decision_note text check (length(decision_note)<=1000),
 paid_in text, paid_at timestamptz,
 check ((kind in ('advance','loan'))=(recover_months is not null and recover_from is not null)),
 check (decided_by is null or proposed_by is null or decided_by<>proposed_by),
 check (proposed_by is distinct from person_id and decided_by is distinct from person_id)
);

-- A reimbursement claim: the person's bill (sealed) and amount (sealed). RF2's claim half.
create table pulse.comp_claim (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id) on delete cascade,
 category text not null check (category ~ '^[a-z][a-z0-9_]{0,30}$'),
 spent_on date not null,
 vendor text check (length(vendor)<=120), note text check (length(note)<=500),
 status text not null default 'submitted' check (status in ('submitted','head_approved','approved','rejected','withdrawn')),
 above_threshold boolean not null default false,
 head_id uuid, head_by uuid, head_at timestamptz,
 decided_by uuid, decided_at timestamptz, decision_note text check (length(decision_note)<=1000),
 payout text not null default 'payroll' check (payout in ('payroll','separate')),
 for_month date not null check (extract(day from for_month)=1),
 receipt_mime text not null check (receipt_mime in ('image/jpeg','image/png','image/webp','application/pdf')),
 receipt_size int not null check (receipt_size between 1 and 8388608),
 receipt_sha256 text not null check (receipt_sha256 ~ '^[0-9a-f]{64}$'),
 dup_key text not null check (dup_key ~ '^[0-9a-f]{64}$'),
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=4096),
 r_kid text not null check (r_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), r_key bytea not null, r_data bytea not null check (octet_length(r_data)<=8400000),
 paid_in text, paid_at timestamptz,
 created_at timestamptz not null default now(),
 check (head_by is distinct from person_id and decided_by is distinct from person_id)
);
create unique index comp_claim_receipt_once on pulse.comp_claim(org_id, receipt_sha256) where status not in ('rejected','withdrawn');
create unique index comp_claim_bill_once on pulse.comp_claim(org_id, person_id, dup_key) where status not in ('rejected','withdrawn');
create index comp_claim_person on pulse.comp_claim(org_id, person_id, created_at desc);

create table pulse.comp_settlement (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.comp_record(person_id) on delete cascade,
 case_id uuid references pulse.lifecycle_case(id) on delete set null,
 exit_kind text not null check (exit_kind in ('resigned','terminated','contract_ended','mutual','probation_end')),
 last_day date not null,
 notice_mode text not null default 'served' check (notice_mode in ('served','short_recovered','waived','paid_in_lieu')),
 status text not null default 'draft' check (status in ('draft','checked','approved','issued','withdrawn')),
 legal jsonb not null default '{}' check (jsonb_typeof(legal)='object'),
 note text check (length(note)<=2000),
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=65536),
 prepared_by uuid, prepared_at timestamptz not null default now(), checked_by uuid, checked_at timestamptz,
 approved_by uuid, approved_at timestamptz, decision_note text check (length(decision_note)<=1000), letter_id uuid,
 updated_at timestamptz not null default now(),
 check (approved_by is null or checked_by is null or approved_by<>checked_by),
 check (prepared_by is distinct from person_id and checked_by is distinct from person_id and approved_by is distinct from person_id)
);
create unique index comp_settlement_live on pulse.comp_settlement(person_id) where status<>'withdrawn';

create table pulse.comp_letter (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id) on delete cascade,
 kind text not null check (kind in ('offer','revision','promotion','role_change','correction','start','probation_confirm','probation_extend',
  'probation_end','pause','settlement')),
 subject_type text not null check (subject_type in ('change','offer','probation','pause','settlement')),
 subject_id uuid not null,
 title text not null check (length(title) between 1 and 160),
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=262144),
 p_kid text not null check (p_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), p_key bytea not null, p_data bytea not null check (octet_length(p_data)<=8400000),
 sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'), pages int not null check (pages between 1 and 50),
 issued_by uuid, issued_at timestamptz not null default now(), seen_at timestamptz
);
create index comp_letter_person on pulse.comp_letter(org_id, person_id, issued_at desc);

-- The person's pay timeline. Kinds and dates only: amounts never go here.
create table pulse.comp_event (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id) on delete cascade,
 at timestamptz not null default clock_timestamp(),
 actor uuid,
 kind text not null check (kind ~ '^[a-z_]+\.[a-z_]+$'),
 subject_type text, subject_id uuid,
 detail jsonb not null default '{}' check (jsonb_typeof(detail)='object' and pg_column_size(detail)<2048
  and not (detail ?| array['amount','monthly','ctc','components','net','rate','figures','total']))
);
create index comp_event_person on pulse.comp_event(org_id, person_id, at desc);

do $$ declare t text; begin
 foreach t in array array['comp_policy','comp_record','comp_change','comp_offer','comp_offer_link','comp_probation','comp_probation_review',
  'comp_pause','comp_item','comp_claim','comp_settlement','comp_letter','comp_event'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant on pulse.%I using (org_id=pulse.current_org()) with check (org_id=pulse.current_org())',t);
  execute format('revoke all on pulse.%I from pulse_api',t);
  execute format('grant select on pulse.%I to pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;

-- ------------------------------------------------------------------------------------------- 2. who may do what
create function pulse.comp_has_role(p_who uuid, variadic p_roles text[]) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_who is not null and exists(select 1 from role_assignment where org_id=current_org() and person_id=p_who and role_key=any(p_roles)
  and current_date between valid_from and coalesce(valid_to,'infinity'))
$$;
-- hr_can's rule for any person (not only the viewer): the HR and leadership roles, or an admin holding the permission.
create function pulse.comp_perm(p_who uuid, p_perm text) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_who is not null and exists(select 1 from person where org_id=current_org() and id=p_who and side='staff' and status='active')
  and (comp_has_role(p_who,'hr','leadership') or comp_has_role(p_who,'admin') and exists(select 1 from sensitive_permission
   where org_id=current_org() and person_id=p_who and permission=p_perm and revoked_at is null))
$$;
create function pulse.comp_reader() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and hr_can('hr.salary.read') $$;
create function pulse.comp_writer() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and hr_can('hr.salary.write') and hr_can('hr.salary.read') $$;

-- The company's pay policy, made on first use.
create function pulse.comp_policy_row() returns pulse.comp_policy language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r comp_policy;
begin
 select * into r from comp_policy where org_id=current_org();
 if not found then
  insert into comp_policy(org_id,currency) values(current_org(),'INR') on conflict do nothing;
  select * into r from comp_policy where org_id=current_org();
 end if;
 return r;
end $$;

-- Founders: active hr_cofounder rows; while the company names none, its leadership role holders.
create function pulse.comp_founders() returns setof uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 with named as (select c.person_id from hr_cofounder c join person p on p.id=c.person_id and p.status='active' where c.org_id=current_org() and c.active)
 select person_id from named
 union all
 select distinct r.person_id from role_assignment r join person p on p.id=r.person_id and p.status='active' and p.side='staff'
  where r.org_id=current_org() and r.role_key='leadership' and current_date between r.valid_from and coalesce(r.valid_to,'infinity')
   and not exists(select 1 from named)
$$;
create function pulse.comp_is_approver(p_who uuid default pulse.current_viewer()) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_who is not null and case (select approvers from comp_policy_row())
  when 'leadership' then comp_has_role(p_who,'leadership') and comp_perm(p_who,'hr.salary.read')
  when 'second_hr' then comp_perm(p_who,'hr.salary.write')
  else p_who in (select comp_founders()) and comp_perm(p_who,'hr.salary.read') end
$$;
create function pulse.comp_can_see(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (p_person=current_viewer() or comp_reader()) $$;
-- A manager (pod head or manager) sees status and dates of their people when the policy grants it; never amounts.
create function pulse.comp_manager_sees(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(current_viewer() is not null and p_person<>current_viewer() and (select managers from comp_policy_row())='status' and hr_head(p_person)=current_viewer(),false) $$;

create function pulse.comp_log(p_person uuid, p_resource text, p_purpose text) returns void
 language sql security definer set search_path=pulse,pg_temp as $$
 insert into privacy.access_log(org_id,viewer_id,subject_person_id,resource,grain,purpose)
 values(current_org(),current_viewer(),p_person,p_resource,case when p_person is null then 'org' else 'person' end,p_purpose)
$$;
create function pulse.comp_event_add(p_person uuid, p_kind text, p_type text, p_id uuid, p_detail jsonb default '{}') returns void
 language sql security definer set search_path=pulse,pg_temp as $$
 insert into comp_event(org_id,person_id,actor,kind,subject_type,subject_id,detail) values(current_org(),p_person,current_viewer(),p_kind,p_type,p_id,coalesce(p_detail,'{}'))
$$;
create function pulse.comp_name(p_person uuid) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select display_name from person where org_id=current_org() and id=p_person $$;
create function pulse.comp_sealed_check(s jsonb) returns void language plpgsql immutable as $$
begin
 if s is null or jsonb_typeof(s)<>'object' or coalesce(s->>'data','')='' or coalesce(s->>'key','')=''
  or coalesce(s->>'kid','') !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$' then raise exception 'Sealed figures are missing' using errcode='22023'; end if;
end $$;

-- Notices about pay: kinds only, never amounts. Subject = the person the pay is about.
create function pulse.comp_emit(p_to uuid, p_type text, p_person uuid, p_key text, p_title text, p_href text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if p_to is null then return; end if;
 perform notification_emit(p_to,p_type,'person',p_person,left(p_key,200),left(p_title,200),p_href,'update',false);
end $$;
-- Everyone who may decide something for p_person (approvers, or writers for HR's queues), except the person and the actor.
create function pulse.comp_tell_approvers(p_person uuid, p_key text, p_title text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid;
begin
 for a in select distinct x from (select comp_founders() x union select r.person_id from role_assignment r where r.org_id=current_org()
   and r.role_key in ('leadership','hr','admin') and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) y
  where x is not null and x<>p_person and x is distinct from current_viewer() and comp_is_approver(x) loop
  perform comp_emit(a,'comp.waiting',p_person,p_key,p_title,'/people/pay/'||p_person);
 end loop;
end $$;
create function pulse.comp_tell_writers(p_person uuid, p_type text, p_key text, p_title text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid;
begin
 for a in select distinct r.person_id from role_assignment r where r.org_id=current_org() and r.role_key='hr'
  and current_date between r.valid_from and coalesce(r.valid_to,'infinity') and r.person_id<>p_person and r.person_id is distinct from current_viewer() loop
  if comp_perm(a,'hr.salary.write') then perform comp_emit(a,p_type,p_person,p_key,p_title,'/people/pay/'||p_person); end if;
 end loop;
end $$;

create function pulse.comp_notice_allowed(p_to uuid, p_type text, p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(case
  when p_type in ('comp.letter','comp.claim','comp.offer') then p_to=p_person
  when p_type='comp.waiting' then p_to<>p_person and (comp_is_approver(p_to) or comp_perm(p_to,'hr.salary.write') or hr_head(p_person)=p_to)
  when p_type='comp.decided' then p_to<>p_person and (comp_is_approver(p_to) or comp_perm(p_to,'hr.salary.write'))
  when p_type='comp.probation' then p_to<>p_person and (comp_perm(p_to,'hr.salary.write') or hr_head(p_person)=p_to)
  else false end,false)
$$;

-- ---------------------------------------------------------------------------------------- 3. records and status
create function pulse.comp_record_ensure(p_person uuid) returns pulse.comp_record language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r comp_record;
begin
 if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff') then raise exception 'Person not found' using errcode='P0002'; end if;
 insert into comp_record(org_id,person_id,currency,created_by) values(current_org(),p_person,(select currency from comp_policy_row()),current_viewer()) on conflict do nothing;
 select * into r from comp_record where person_id=p_person;
 return r;
end $$;

-- The version in force on a day: the approved change with the latest date on or before it (a correction, decided later,
-- replaces what it corrects).
create function pulse.comp_in_force(p_person uuid, p_day date) returns pulse.comp_change language sql stable security definer set search_path=pulse,pg_temp as $$
 select c.* from comp_change c where c.org_id=current_org() and c.person_id=p_person and c.status='approved' and c.effective_on<=p_day
 order by c.effective_on desc, c.decided_at desc nulls last, c.created_at desc limit 1
$$;

-- Status from the facts (offer, start, probation, confirmation, pauses, notice, last day). Called after every change and
-- by the minute tick once a day per record.
create function pulse.comp_status_refresh(p_person uuid) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r comp_record; o comp_offer; e hr_employment; today date:=lifecycle_today(); st text; since date; until date; stage text;
 has_pay boolean; pz comp_pause;
begin
 select * into r from comp_record where org_id=current_org() and person_id=p_person for update;
 if not found then return null; end if;
 select * into o from comp_offer where person_id=p_person order by (status in ('draft','proposed','approved','sent','accepted')) desc, created_at desc limit 1;
 select * into e from hr_employment where org_id=current_org() and person_id=p_person;
 stage:=lifecycle_stage(p_person);
 has_pay:=(comp_in_force(p_person,today)).id is not null;
 select * into pz from comp_pause where person_id=p_person and status='approved' and from_on<=today and coalesce(ended_on,to_on)>=today order by from_on limit 1;
 if r.end_on is not null and r.end_on<today or stage='left' then st:='ended'; since:=coalesce(r.end_on+1,(select left_on from person_lifecycle where person_id=p_person),today);
 elsif stage='notice' or r.end_on is not null then st:='notice'; until:=coalesce(e.last_working_day,r.end_on);
 elsif pz.id is not null then st:='paused'; since:=pz.from_on; until:=coalesce(pz.ended_on,pz.to_on);
 elsif o.id is not null and o.status='sent' then st:='offered'; since:=o.sent_at::date; until:=o.valid_until;
 elsif o.id is not null and o.status='accepted' and o.start_on>today then st:='accepted'; since:=o.answered_at::date; until:=o.start_on;
 elsif not has_pay and o.id is not null and o.status in ('declined','expired','withdrawn')
  and not exists(select 1 from comp_change where person_id=p_person and status in ('draft','proposed') and kind<>'offer') then st:='ended'; since:=coalesce(o.answered_at,o.updated_at)::date;
 elsif not has_pay then st:='proposed';
 elsif e.probation_to is not null and e.probation_to>=today and r.confirmed_on is null then st:='probation'; since:=e.probation_from; until:=e.probation_to;
 else st:='confirmed'; since:=coalesce(r.confirmed_on,r.start_on);
 end if;
 if st is distinct from r.status then
  perform comp_event_add(p_person,'status.changed','record',null,jsonb_build_object('from',r.status,'to',st));
  since:=coalesce(since,today);
 end if;
 update comp_record set status=st,status_since=case when st is distinct from r.status then coalesce(since,today) else coalesce(r.status_since,since) end,
  status_until=until,refreshed_on=today,updated_at=now() where person_id=p_person;
 return st;
end $$;

-- A stage move the pay record causes (an accepted offer starting, probation confirmed or ended). LIFECYCLE's
-- lifecycle_move is for HR and admins at the desk; this is the system path behind pay decisions, never called by the API.
create function pulse.comp_stage_set(p_person uuid, p_to text, p_on date, p_actor uuid, p_detail jsonb default '{}') returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cur text:=lifecycle_stage(p_person);
begin
 if cur=p_to then return; end if;
 if cur in ('candidate','offer','left') and p_to in ('probation','active') then
  perform lifecycle_event_add(p_person,'stage',cur,'joining',p_on,null,jsonb_build_object('via','pay'),null);
  perform lifecycle_case_open(p_person,'joining',p_on,null,'From the accepted offer');
  update people_profile set joined_on=coalesce(joined_on,p_on),updated_at=now() where person_id=p_person;
  cur:='joining';
 end if;
 insert into person_lifecycle(org_id,person_id,stage,since,updated_by) values(current_org(),p_person,p_to,p_on,p_actor)
 on conflict(person_id) do update set stage=excluded.stage,since=excluded.since,left_type=null,left_on=null,updated_by=excluded.updated_by,updated_at=now();
 perform set_config('pulse.lifecycle_moving','1',true);
 update person set status=case when p_to in ('joining','probation','active','notice') then 'active' else status end,
  active_from=case when cur='joining' then p_on else active_from end,active_to=case when p_to in ('joining','probation','active') then null else active_to end
 where id=p_person;
 perform set_config('pulse.lifecycle_moving','',true);
 perform lifecycle_event_add(p_person,'stage',cur,p_to,p_on,null,coalesce(p_detail,'{}')||jsonb_build_object('via','pay'),null);
end $$;

create function pulse.comp_reviews_plan(p_person uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e hr_employment; pol comp_policy:=comp_policy_row(); fin date;
begin
 select * into e from hr_employment where org_id=current_org() and person_id=p_person;
 if e.probation_from is null or e.probation_to is null then return; end if;
 update comp_probation_review set status='skipped' where person_id=p_person and status='due' and kind='final' and due_on<>greatest(e.probation_from,e.probation_to-pol.remind_days);
 if e.probation_to-e.probation_from>=40 then
  insert into comp_probation_review(org_id,person_id,kind,due_on) values(current_org(),p_person,'midpoint',e.probation_from+(e.probation_to-e.probation_from)/2) on conflict do nothing;
 end if;
 fin:=greatest(e.probation_from,e.probation_to-pol.remind_days);
 insert into comp_probation_review(org_id,person_id,kind,due_on) values(current_org(),p_person,'final',fin)
 on conflict(person_id,kind,due_on) do update set status=case when comp_probation_review.status='skipped' then 'due' else comp_probation_review.status end;
end $$;

-- An accepted offer starts: probation (with dates and reviews) or active; the role is the offer's.
create function pulse.comp_start(p_offer uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare o comp_offer; actor uuid; e hr_employment;
begin
 select * into o from comp_offer where id=p_offer for update;
 if o.status<>'accepted' or o.started_at is not null or o.start_on>lifecycle_today() then return; end if;
 actor:=coalesce(current_viewer(),o.approved_by,o.sent_by);
 select * into e from hr_employment where org_id=current_org() and person_id=o.person_id for update;
 if not found then insert into hr_employment(org_id,person_id,updated_by) values(current_org(),o.person_id,actor) returning * into e; end if;
 if o.probation_days>0 then
  update hr_employment set probation_from=o.start_on,probation_to=o.start_on+o.probation_days-1,payroll_from=coalesce(payroll_from,o.start_on),updated_by=actor,updated_at=now() where person_id=o.person_id;
  perform comp_stage_set(o.person_id,'probation',o.start_on,actor,jsonb_build_object('probationTo',o.start_on+o.probation_days-1));
  perform comp_reviews_plan(o.person_id);
 else
  update hr_employment set payroll_from=coalesce(payroll_from,o.start_on),updated_by=actor,updated_at=now() where person_id=o.person_id;
  perform comp_stage_set(o.person_id,'active',o.start_on,actor);
  update comp_record set confirmed_on=o.start_on where person_id=o.person_id;
 end if;
 update people_profile set role=o.role,updated_at=now() where person_id=o.person_id and role is distinct from o.role;
 update comp_change set role_applied_at=now() where id=o.change_id;
 update comp_record set start_on=coalesce(start_on,o.start_on) where person_id=o.person_id;
 update comp_offer set started_at=now() where id=o.id;
 perform comp_event_add(o.person_id,'offer.started','offer',o.id,jsonb_build_object('on',o.start_on,'probation',o.probation_days>0));
 perform comp_status_refresh(o.person_id);
end $$;

-- ------------------------------------------------------------------------------------------- 4. pay changes
create function pulse.comp_change_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); v_id uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid()); v_person uuid:=nullif(p->>'person','')::uuid;
 v_kind text:=p->>'kind'; v_on date:=nullif(p->>'effectiveOn','')::date; v_submit boolean:=coalesce((p->>'submit')::boolean,true);
 v_reason text:=nullif(btrim(coalesce(p->>'reason','')),''); v_role text:=nullif(btrim(coalesce(p->>'role','')),''); c comp_change; v_before comp_change;
 v_corrects comp_change; v_job uuid:=nullif(p->>'jobId','')::uuid;
begin
 if not comp_writer() then raise exception 'HR proposes pay changes' using errcode='42501'; end if;
 if v_person is null then raise exception 'Choose whose pay changes' using errcode='22023'; end if;
 if v_person=me then raise exception 'Someone else proposes changes to your own pay' using errcode='42501'; end if;
 if v_kind is null or v_kind not in ('start','raise','cut','correction','promotion','role_change') then raise exception 'Choose what kind of change this is' using errcode='22023'; end if;
 if v_on is null then raise exception 'Give the date the change takes effect' using errcode='22023'; end if;
 if coalesce(p->>'payType','') not in ('salary','stipend','contractor','retainer','hourly') then raise exception 'Choose the pay type' using errcode='22023'; end if;
 if v_submit and (v_reason is null or length(v_reason)<3) then raise exception 'Say why: the reason is kept with the change' using errcode='22023'; end if;
 if v_kind in ('promotion','role_change') and v_role is null then raise exception 'Give the new role' using errcode='22023'; end if;
 if v_on<lifecycle_today()-400 or v_on>lifecycle_today()+400 then raise exception 'The date is more than a year away' using errcode='22023'; end if;
 perform comp_sealed_check(p->'sealed');
 perform comp_record_ensure(v_person);
 if v_kind='correction' then
  select * into v_corrects from comp_change where org_id=current_org() and id=nullif(p->>'correctsId','')::uuid and person_id=v_person and status='approved';
  if v_corrects.id is null then raise exception 'Choose the version this corrects' using errcode='22023'; end if;
  v_on:=v_corrects.effective_on; v_before:=v_corrects;
 else
  v_before:=comp_in_force(v_person,v_on);
 end if;
 select * into c from comp_change where org_id=current_org() and id=v_id for update;
 if found then
  if c.person_id<>v_person or c.status not in ('draft','proposed') or c.kind='offer' or c.source<>'pulse' then raise exception 'This change can no longer be edited' using errcode='22023'; end if;
  update comp_change set kind=v_kind,effective_on=v_on,pay_type=p->>'payType',role=v_role,job_id=v_job,reason=v_reason,corrects_id=v_corrects.id,before_id=v_before.id,
   s_kid=p->'sealed'->>'kid',s_key=decode(p->'sealed'->>'key','base64'),s_data=decode(p->'sealed'->>'data','base64'),
   status=case when v_submit then 'proposed' else 'draft' end,proposed_by=me,proposed_at=case when v_submit then now() end,updated_at=now() where id=v_id;
 else
  insert into comp_change(org_id,id,person_id,kind,status,effective_on,pay_type,role,job_id,reason,corrects_id,before_id,s_kid,s_key,s_data,proposed_by,proposed_at,created_by)
  values(current_org(),v_id,v_person,v_kind,case when v_submit then 'proposed' else 'draft' end,v_on,p->>'payType',v_role,v_job,v_reason,v_corrects.id,v_before.id,
   p->'sealed'->>'kid',decode(p->'sealed'->>'key','base64'),decode(p->'sealed'->>'data','base64'),me,case when v_submit then now() end,me);
 end if;
 perform comp_log(v_person,'comp.pay','pay_change_'||case when v_submit then 'proposed' else 'draft' end);
 perform comp_event_add(v_person,case when v_submit then 'change.proposed' else 'change.drafted' end,'change',v_id,jsonb_build_object('kind',v_kind,'effectiveOn',v_on));
 if v_submit then
  perform comp_tell_approvers(v_person,'change:'||v_id,initcap(replace(v_kind,'_',' '))||' for '||comp_name(v_person)||' from '||to_char(v_on,'FMDD Mon YYYY')||' is waiting for your approval');
 end if;
 perform comp_status_refresh(v_person);
 return v_id;
end $$;

create function pulse.comp_change_decide(p_id uuid, p_action text, p_note text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); c comp_change; v_note text:=nullif(btrim(coalesce(p_note,'')),''); st text;
begin
 select * into c from comp_change where org_id=current_org() and id=p_id for update;
 if not found or not comp_reader() then raise exception 'Change not found' using errcode='P0002'; end if;
 if c.kind='offer' then raise exception 'An offer is decided on the offer' using errcode='22023'; end if;
 if c.status<>'proposed' then raise exception 'Only a proposed change is decided' using errcode='22023'; end if;
 if me=c.person_id then raise exception 'Someone else decides your own pay' using errcode='42501'; end if;
 if me=c.proposed_by then raise exception 'Someone else approves a change you proposed' using errcode='42501'; end if;
 if not comp_is_approver(me) then raise exception 'The approver named in the pay policy decides pay changes' using errcode='42501'; end if;
 if p_action not in ('approve','reject','return') then raise exception 'Approve, reject or send back' using errcode='22023'; end if;
 if p_action in ('reject','return') and v_note is null then raise exception 'Say why, for the person who proposed it' using errcode='22023'; end if;
 st:=case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'draft' end;
 update comp_change set status=st,decided_by=case when st='draft' then null else me end,decided_at=case when st='draft' then null else now() end,decision_note=v_note,updated_at=now() where id=p_id;
 if st='approved' and c.role is not null and c.effective_on<=lifecycle_today() then
  update people_profile set role=c.role,updated_at=now() where person_id=c.person_id and role is distinct from c.role;
  update comp_change set role_applied_at=now() where id=p_id;
 end if;
 perform comp_event_add(c.person_id,'change.'||case st when 'draft' then 'returned' else st end,'change',p_id,jsonb_build_object('kind',c.kind,'effectiveOn',c.effective_on));
 perform comp_emit(c.proposed_by,'comp.decided',c.person_id,'change:'||p_id||':'||st,
  initcap(replace(c.kind,'_',' '))||' for '||comp_name(c.person_id)||case st when 'approved' then ' was approved' when 'rejected' then ' was rejected' else ' was sent back to you' end,
  '/people/pay/'||c.person_id);
 perform comp_status_refresh(c.person_id);
 return jsonb_build_object('status',st,'backdated',st='approved' and c.effective_on<date_trunc('month',lifecycle_today())::date,'person',c.person_id);
end $$;

create function pulse.comp_change_withdraw(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c comp_change;
begin
 select * into c from comp_change where org_id=current_org() and id=p_id for update;
 if not found or not comp_writer() then raise exception 'Change not found' using errcode='P0002'; end if;
 if c.status not in ('draft','proposed') or c.kind='offer' then raise exception 'Only a draft or proposed change is withdrawn' using errcode='22023'; end if;
 update comp_change set status='withdrawn',updated_at=now() where id=p_id;
 perform comp_event_add(c.person_id,'change.withdrawn','change',p_id,jsonb_build_object('kind',c.kind));
 perform comp_status_refresh(c.person_id);
end $$;

-- An arrears item for a backdated change, made by its approver at once (the change's maker and checker carry over).
create function pulse.comp_arrears_add(p_change uuid, p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c comp_change; v_id uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid());
begin
 select * into c from comp_change where org_id=current_org() and id=p_change;
 if not found or c.status<>'approved' or c.decided_by is distinct from current_viewer() then raise exception 'Arrears follow an approved change' using errcode='42501'; end if;
 perform comp_sealed_check(p->'sealed');
 if exists(select 1 from comp_item where person_id=c.person_id and kind='arrears' and ref->>'changeId'=p_change::text and status<>'withdrawn') then
  raise exception 'Arrears for this change are already recorded' using errcode='22023'; end if;
 insert into comp_item(org_id,id,person_id,kind,status,for_month,payout,reason,ref,s_kid,s_key,s_data,proposed_by,proposed_at,decided_by,decided_at)
 values(current_org(),v_id,c.person_id,'arrears','approved',date_trunc('month',lifecycle_today())::date,'payroll','Arrears from '||to_char(c.effective_on,'FMDD Mon YYYY'),
  jsonb_build_object('changeId',p_change,'months',(p->>'months')::numeric),p->'sealed'->>'kid',decode(p->'sealed'->>'key','base64'),decode(p->'sealed'->>'data','base64'),
  c.proposed_by,now(),c.decided_by,now());
 perform comp_event_add(c.person_id,'item.approved','item',v_id,jsonb_build_object('kind','arrears','changeId',p_change));
 return v_id;
end $$;

-- ------------------------------------------------------------------------------------------------- 5. offers
create function pulse.comp_offer_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); v_id uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid()); v_person uuid:=nullif(p->>'person','')::uuid;
 o comp_offer; v_change uuid; v_submit boolean:=coalesce((p->>'submit')::boolean,false); v_start date:=nullif(p->>'startOn','')::date;
 v_valid date:=nullif(p->>'validUntil','')::date; v_role text:=nullif(btrim(coalesce(p->>'role','')),''); pol comp_policy:=comp_policy_row();
begin
 if not comp_writer() then raise exception 'HR drafts offers' using errcode='42501'; end if;
 if v_person is null or v_person=me then raise exception 'Someone else drafts your own offer' using errcode='42501'; end if;
 if v_role is null then raise exception 'Give the role' using errcode='22023'; end if;
 if v_start is null then raise exception 'Give the start date' using errcode='22023'; end if;
 if coalesce(p->>'payType','') not in ('salary','stipend','contractor','retainer','hourly') then raise exception 'Choose the pay type' using errcode='22023'; end if;
 v_valid:=coalesce(v_valid,lifecycle_today()+pol.offer_days);
 if v_valid<lifecycle_today() then raise exception 'The offer must be open until today or later' using errcode='22023'; end if;
 perform comp_sealed_check(p->'sealed');
 perform comp_record_ensure(v_person);
 select * into o from comp_offer where org_id=current_org() and id=v_id for update;
 if found then
  if o.person_id<>v_person or o.status not in ('draft','proposed','approved') then raise exception 'This offer can no longer be edited' using errcode='22023'; end if;
  update comp_change set effective_on=v_start,pay_type=p->>'payType',role=v_role,reason=nullif(btrim(coalesce(p->>'reason','')),''),
   s_kid=p->'sealed'->>'kid',s_key=decode(p->'sealed'->>'key','base64'),s_data=decode(p->'sealed'->>'data','base64'),
   status=case when v_submit then 'proposed' else 'draft' end,proposed_by=me,proposed_at=case when v_submit then now() end,decided_by=null,decided_at=null,updated_at=now()
  where id=o.change_id;
  update comp_offer set role=v_role,start_on=v_start,probation_days=coalesce(nullif(p->>'probationDays','')::int,pol.probation_days),
   notice_days=nullif(p->>'noticeDays','')::int,terms=nullif(btrim(coalesce(p->>'terms','')),''),valid_until=v_valid,
   status=case when v_submit then 'proposed' else 'draft' end,proposed_by=me,proposed_at=case when v_submit then now() end,approved_by=null,approved_at=null,letter_id=null,updated_at=now()
  where id=v_id;
 else
  if exists(select 1 from comp_offer where person_id=v_person and status in ('draft','proposed','approved','sent')) then raise exception 'This person already has an offer in progress' using errcode='22023'; end if;
  insert into comp_change(org_id,id,person_id,kind,status,effective_on,pay_type,role,reason,s_kid,s_key,s_data,proposed_by,proposed_at,created_by)
  values(current_org(),coalesce(nullif(p->>'changeId','')::uuid,gen_random_uuid()),v_person,'offer',case when v_submit then 'proposed' else 'draft' end,v_start,p->>'payType',v_role,nullif(btrim(coalesce(p->>'reason','')),''),
   p->'sealed'->>'kid',decode(p->'sealed'->>'key','base64'),decode(p->'sealed'->>'data','base64'),me,case when v_submit then now() end,me) returning id into v_change;
  insert into comp_offer(org_id,id,person_id,change_id,status,role,start_on,probation_days,notice_days,terms,valid_until,proposed_by,proposed_at,created_by)
  values(current_org(),v_id,v_person,v_change,case when v_submit then 'proposed' else 'draft' end,v_role,v_start,coalesce(nullif(p->>'probationDays','')::int,pol.probation_days),
   nullif(p->>'noticeDays','')::int,nullif(btrim(coalesce(p->>'terms','')),''),v_valid,me,case when v_submit then now() end,me);
 end if;
 perform comp_log(v_person,'comp.pay','offer_'||case when v_submit then 'proposed' else 'draft' end);
 perform comp_event_add(v_person,case when v_submit then 'offer.proposed' else 'offer.drafted' end,'offer',v_id,jsonb_build_object('startOn',v_start,'role',v_role));
 if v_submit then perform comp_tell_approvers(v_person,'offer:'||v_id||':'||extract(epoch from now())::bigint,'Offer for '||comp_name(v_person)||' is waiting for your approval'); end if;
 perform comp_status_refresh(v_person);
 return v_id;
end $$;

create function pulse.comp_offer_propose(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare o comp_offer;
begin
 select * into o from comp_offer where org_id=current_org() and id=p_id for update;
 if not found or not comp_writer() then raise exception 'Offer not found' using errcode='P0002'; end if;
 if o.person_id=current_viewer() then raise exception 'Someone else drafts your own offer' using errcode='42501'; end if;
 if o.status<>'draft' then raise exception 'Only a draft offer goes to a founder' using errcode='22023'; end if;
 update comp_offer set status='proposed',proposed_by=current_viewer(),proposed_at=now(),updated_at=now() where id=p_id;
 update comp_change set status='proposed',proposed_by=current_viewer(),proposed_at=now(),updated_at=now() where id=o.change_id;
 perform comp_event_add(o.person_id,'offer.proposed','offer',p_id,jsonb_build_object('startOn',o.start_on));
 perform comp_tell_approvers(o.person_id,'offer:'||p_id||':'||extract(epoch from now())::bigint,'Offer for '||comp_name(o.person_id)||' is waiting for your approval');
 perform comp_status_refresh(o.person_id);
end $$;

create function pulse.comp_offer_decide(p_id uuid, p_action text, p_note text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); o comp_offer; v_note text:=nullif(btrim(coalesce(p_note,'')),''); st text;
begin
 select * into o from comp_offer where org_id=current_org() and id=p_id for update;
 if not found or not comp_reader() then raise exception 'Offer not found' using errcode='P0002'; end if;
 if o.status<>'proposed' then raise exception 'Only an offer waiting for approval is decided' using errcode='22023'; end if;
 if me=o.person_id then raise exception 'Someone else decides your own offer' using errcode='42501'; end if;
 if me=o.proposed_by then raise exception 'Someone else approves an offer you drafted' using errcode='42501'; end if;
 if not comp_is_approver(me) then raise exception 'A founder approves offers' using errcode='42501'; end if;
 if p_action not in ('approve','reject','return') then raise exception 'Approve, reject or send back' using errcode='22023'; end if;
 if p_action in ('reject','return') and v_note is null then raise exception 'Say why, for the person who drafted it' using errcode='22023'; end if;
 st:=case p_action when 'approve' then 'approved' when 'reject' then 'withdrawn' else 'draft' end;
 update comp_offer set status=st,approved_by=case when st='approved' then me end,approved_at=case when st='approved' then now() end,
  closed_note=case when st='withdrawn' then v_note else closed_note end,updated_at=now() where id=p_id;
 update comp_change set status=case st when 'approved' then 'proposed' when 'withdrawn' then 'rejected' else 'draft' end,decision_note=v_note,updated_at=now() where id=o.change_id;
 perform comp_event_add(o.person_id,'offer.'||case st when 'draft' then 'returned' when 'withdrawn' then 'rejected' else st end,'offer',p_id,'{}');
 perform comp_emit(o.proposed_by,'comp.decided',o.person_id,'offer:'||p_id||':'||st,
  'Offer for '||comp_name(o.person_id)||case st when 'approved' then ' was approved: a founder sends it' when 'withdrawn' then ' was rejected' else ' was sent back to you' end,'/people/pay/'||o.person_id);
 perform comp_status_refresh(o.person_id);
 return st;
end $$;

-- Sending is a founder's press: the approved offer with its letter becomes readable through a link (and in Pulse when
-- the person signs in). Pulse e-mails nobody: the link is shown once for the founder to share.
create function pulse.comp_offer_send(p_id uuid, p_hash text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); o comp_offer;
begin
 select * into o from comp_offer where org_id=current_org() and id=p_id for update;
 if not found or not comp_reader() then raise exception 'Offer not found' using errcode='P0002'; end if;
 if not comp_is_approver(me) or me=o.person_id then raise exception 'A founder sends offers' using errcode='42501'; end if;
 if o.status<>'approved' then raise exception 'Approve the offer before sending it' using errcode='22023'; end if;
 if o.letter_id is null then raise exception 'The offer letter is not filed yet' using errcode='22023'; end if;
 if o.valid_until<lifecycle_today() then raise exception 'The offer''s date has passed: change it and approve again' using errcode='22023'; end if;
 if p_hash is not null then
  if p_hash !~ '^[0-9a-f]{64}$' then raise exception 'Bad link' using errcode='22023'; end if;
  update comp_offer_link set revoked_at=now() where offer_id=p_id and revoked_at is null and decided_at is null;
  insert into comp_offer_link(token_hash,org_id,offer_id,created_by,expires_at)
  values(p_hash,current_org(),p_id,me,((o.valid_until+1)::timestamp at time zone org_time_zone()));
 end if;
 update comp_offer set status='sent',sent_by=me,sent_at=now(),updated_at=now() where id=p_id;
 perform comp_event_add(o.person_id,'offer.sent','offer',p_id,jsonb_build_object('validUntil',o.valid_until,'link',p_hash is not null));
 perform comp_emit(o.person_id,'comp.offer',o.person_id,'offer:'||p_id,'Your offer is ready to read and answer','/me/pay');
 perform app_event('comp.offer.sent','offer:pulse:'||p_id,jsonb_build_object('offer_id',p_id::text));
 perform comp_status_refresh(o.person_id);
 return jsonb_build_object('validUntil',o.valid_until);
end $$;

create function pulse.comp_offer_withdraw(p_id uuid, p_note text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare o comp_offer;
begin
 select * into o from comp_offer where org_id=current_org() and id=p_id for update;
 if not found or not (comp_writer() or comp_is_approver()) then raise exception 'Offer not found' using errcode='P0002'; end if;
 if o.person_id=current_viewer() then raise exception 'Someone else handles your own offer' using errcode='42501'; end if;
 if o.status not in ('draft','proposed','approved','sent') then raise exception 'This offer is closed already' using errcode='22023'; end if;
 if o.status='sent' and length(btrim(coalesce(p_note,'')))<3 then raise exception 'Say why the sent offer is withdrawn' using errcode='22023'; end if;
 update comp_offer set status='withdrawn',closed_note=nullif(btrim(coalesce(p_note,'')),''),updated_at=now() where id=p_id;
 update comp_change set status='withdrawn',updated_at=now() where id=o.change_id;
 update comp_offer_link set revoked_at=now() where offer_id=p_id and revoked_at is null and decided_at is null;
 perform comp_event_add(o.person_id,'offer.withdrawn','offer',p_id,'{}');
 perform comp_status_refresh(o.person_id);
end $$;

-- The answer, from the link (signed out) or from Pulse (the person signed in).
create function pulse.comp_offer_apply(p_id uuid, p_decision text, p_name text, p_note text, p_via text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare o comp_offer;
begin
 select * into o from comp_offer where id=p_id for update;
 if o.status<>'sent' then raise exception 'This offer can no longer be answered' using errcode='22023'; end if;
 if o.valid_until<lifecycle_today() then raise exception 'This offer has expired; ask for a new one' using errcode='22023'; end if;
 if p_decision not in ('accepted','declined') then raise exception 'Accept or decline' using errcode='22023'; end if;
 if length(btrim(coalesce(p_name,''))) not between 2 and 120 then raise exception 'Type your full name to sign' using errcode='22023'; end if;
 update comp_offer set status=p_decision,answered_at=now(),answer_name=btrim(p_name),answer_via=p_via,answer_note=nullif(btrim(coalesce(p_note,'')),''),updated_at=now() where id=p_id;
 update comp_change set status=case when p_decision='accepted' then 'approved' else 'withdrawn' end,decided_by=case when p_decision='accepted' then o.approved_by end,
  decided_at=case when p_decision='accepted' then now() end,updated_at=now() where id=o.change_id;
 update comp_offer_link set revoked_at=now() where offer_id=p_id and revoked_at is null and decided_at is null;
 perform comp_event_add(o.person_id,'offer.'||p_decision,'offer',p_id,jsonb_build_object('via',p_via));
 perform comp_emit(o.sent_by,'comp.decided',o.person_id,'offer:'||p_id||':'||p_decision,comp_name(o.person_id)||' '||p_decision||' the offer','/people/pay/'||o.person_id);
 if o.proposed_by is distinct from o.sent_by then
  perform comp_emit(o.proposed_by,'comp.decided',o.person_id,'offer:'||p_id||':'||p_decision,comp_name(o.person_id)||' '||p_decision||' the offer','/people/pay/'||o.person_id);
 end if;
 perform app_event('comp.offer.answered','offer:pulse:'||p_id,jsonb_build_object('offer_id',p_id::text,'reply',p_decision));
 if p_decision='accepted' then perform comp_start(p_id); end if;
 perform comp_status_refresh(o.person_id);
 return jsonb_build_object('decision',p_decision,'startOn',o.start_on);
end $$;
create function pulse.comp_offer_answer(p_id uuid, p_decision text, p_name text, p_note text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from comp_offer where org_id=current_org() and id=p_id and person_id=current_viewer()) then raise exception 'Offer not found' using errcode='P0002'; end if;
 return comp_offer_apply(p_id,p_decision,p_name,p_note,'pulse');
end $$;
-- Signed out: what the person may see through a valid link, and their answer.
create function pulse.comp_offer_open(p_hash text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k comp_offer_link; o comp_offer;
begin
 select * into k from comp_offer_link where token_hash=p_hash and org_id=current_org();
 if k.token_hash is null or k.revoked_at is not null and k.decided_at is null then return null; end if;
 select * into o from comp_offer where id=k.offer_id;
 if k.opened_at is null then
  update comp_offer_link set opened_at=now() where token_hash=p_hash;
  perform comp_event_add(o.person_id,'offer.opened','offer',o.id,'{}');
 end if;
 return jsonb_build_object('name',comp_name(o.person_id),'role',o.role,'startOn',o.start_on,'validUntil',o.valid_until,'probationDays',o.probation_days,
  'company',(select name from org where id=current_org()),'status',o.status,'decision',k.decision,'decidedAt',k.decided_at,'signer',k.signer_name,
  'canDecide',k.decided_at is null and k.revoked_at is null and o.status='sent' and o.valid_until>=lifecycle_today() and k.expires_at>now());
end $$;
create function pulse.comp_offer_link_answer(p_hash text, p_decision text, p_name text, p_note text, p_ip_hash text, p_agent text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k comp_offer_link; r jsonb;
begin
 select * into k from comp_offer_link where token_hash=p_hash and org_id=current_org() for update;
 if k.token_hash is null or k.revoked_at is not null or k.expires_at<now() then raise exception 'This link has expired; ask for a new one' using errcode='22023'; end if;
 if k.decided_at is not null then raise exception 'This offer was already answered' using errcode='22023'; end if;
 r:=comp_offer_apply(k.offer_id,p_decision,p_name,p_note,'link');
 update comp_offer_link set decided_at=now(),decision=p_decision,signer_name=btrim(p_name),signer_note=nullif(btrim(coalesce(p_note,'')),''),
  signer_ip_hash=p_ip_hash,signer_agent=left(p_agent,300),revoked_at=null where token_hash=p_hash;
 return r;
end $$;
create function pulse.comp_offer_link_letter(p_hash text) returns table(person_id uuid, letter_id uuid, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k comp_offer_link; o comp_offer;
begin
 select * into k from comp_offer_link where token_hash=p_hash and org_id=current_org();
 if k.token_hash is null or (k.revoked_at is not null and k.decided_at is null) or (k.expires_at<now() and k.decided_at is null) then return; end if;
 select * into o from comp_offer where id=k.offer_id;
 perform comp_log(o.person_id,'comp.letter','offer_link');
 return query select l.person_id,l.id,l.p_kid,l.p_key,l.p_data from comp_letter l where l.id=o.letter_id;
end $$;

-- An offer named in a task: sending the offer is that task's confirmed completion signal (UX-5B).
create function pulse.comp_offer_task(p_id uuid, p_task uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); o comp_offer;
begin
 select * into o from comp_offer where org_id=current_org() and id=p_id for update;
 if not found or not (comp_writer() or comp_is_approver()) then raise exception 'Offer not found' using errcode='P0002'; end if;
 if o.status not in ('draft','proposed','approved') then raise exception 'Link the task before the offer is sent' using errcode='22023'; end if;
 if not exists(select 1 from task where org_id=current_org() and id=p_task and deleted_at is null and status in ('open','in_progress','blocked')) then
  raise exception 'Choose an open task' using errcode='22023'; end if;
 update comp_offer set task_id=p_task,updated_at=now() where id=p_id;
 insert into task_companion(org_id,task_id,target,confirmed_by,confirmed_at) values(current_org(),p_task,'people.pay',me,now())
 on conflict(task_id) do update set confirmed_by=coalesce(task_companion.confirmed_by,excluded.confirmed_by),confirmed_at=coalesce(task_companion.confirmed_at,excluded.confirmed_at),updated_at=now();
 delete from task_signal where task_id=p_task and event='comp.offer.sent' and met_at is null;
 insert into task_signal(org_id,task_id,position,event,label,cond,need,since,created_by)
 values(current_org(),p_task,0,'comp.offer.sent','The offer is sent from People & pay',jsonb_build_object('offer_id',jsonb_build_object('eq',p_id::text)),1,now(),me);
 perform comp_event_add(o.person_id,'offer.task_linked','offer',p_id,jsonb_build_object('taskId',p_task));
end $$;

-- ------------------------------------------------------------------------------------------------ 6. probation
create function pulse.comp_probation_apply(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare b comp_probation; e hr_employment; pol comp_policy:=comp_policy_row(); actor uuid;
begin
 select * into b from comp_probation where id=p_id;
 actor:=coalesce(current_viewer(),b.decided_by);
 if b.action='confirm' then
  update comp_record set confirmed_on=lifecycle_today(),updated_at=now() where person_id=b.person_id;
  update comp_probation_review set status='skipped' where person_id=b.person_id and status='due';
  perform comp_stage_set(b.person_id,'active',lifecycle_today(),actor,jsonb_build_object('probation','confirmed'));
 elsif b.action='extend' then
  update hr_employment set probation_to=b.until_on,updated_by=actor,updated_at=now() where org_id=current_org() and person_id=b.person_id;
  perform comp_reviews_plan(b.person_id);
 else
  update hr_employment set notice_from=lifecycle_today(),notice_to=b.until_on,last_working_day=b.until_on,updated_by=actor,updated_at=now() where org_id=current_org() and person_id=b.person_id;
  update comp_record set end_on=b.until_on,updated_at=now() where person_id=b.person_id;
  update comp_probation_review set status='skipped' where person_id=b.person_id and status='due';
  perform comp_stage_set(b.person_id,'notice',lifecycle_today(),actor,jsonb_build_object('lastWorkingDay',b.until_on,'probation','ended'));
  perform lifecycle_case_open(b.person_id,'leaving',b.until_on,'terminated','Probation ended');
 end if;
 perform comp_status_refresh(b.person_id);
end $$;

create function pulse.comp_probation_propose(p_person uuid, p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); v_action text:=p->>'action'; v_until date:=nullif(p->>'until','')::date; e hr_employment; r comp_record;
 pol comp_policy:=comp_policy_row(); v_id uuid; auto boolean; v_note text:=nullif(btrim(coalesce(p->>'note','')),'');
begin
 if not comp_writer() then raise exception 'HR records probation outcomes' using errcode='42501'; end if;
 if p_person=me then raise exception 'Someone else records your own probation' using errcode='42501'; end if;
 select * into r from comp_record where org_id=current_org() and person_id=p_person;
 select * into e from hr_employment where org_id=current_org() and person_id=p_person;
 if r.person_id is null or e.probation_to is null or r.confirmed_on is not null then raise exception 'This person is not on probation' using errcode='22023'; end if;
 if v_action not in ('confirm','extend','end') then raise exception 'Confirm, extend or end' using errcode='22023'; end if;
 if v_action='extend' and (v_until is null or v_until<=e.probation_to or v_until>e.probation_to+180) then raise exception 'Extend to a later date, at most six months more' using errcode='22023'; end if;
 if v_action='end' and (v_until is null or v_until<lifecycle_today()) then raise exception 'Give the last working day' using errcode='22023'; end if;
 if v_action<>'confirm' and v_note is null then raise exception 'Say why: it goes in the letter' using errcode='22023'; end if;
 if exists(select 1 from comp_probation where person_id=p_person and status='proposed') then raise exception 'An outcome is already waiting for approval' using errcode='22023'; end if;
 auto:=v_action in ('confirm','extend') and pol.probation_approval='hr';
 insert into comp_probation(org_id,person_id,action,until_on,note,status,proposed_by,decided_by,decided_at)
 values(current_org(),p_person,v_action,case when v_action='confirm' then null else v_until end,v_note,case when auto then 'approved' else 'proposed' end,me,
  case when auto then me end,case when auto then now() end) returning id into v_id;
 perform comp_event_add(p_person,'probation.'||case when auto then v_action else 'proposed' end,'probation',v_id,jsonb_build_object('action',v_action,'until',v_until));
 if auto then perform comp_probation_apply(v_id);
 else perform comp_tell_approvers(p_person,'probation:'||v_id,'Probation '||v_action||' for '||comp_name(p_person)||' is waiting for your approval'); end if;
 return jsonb_build_object('id',v_id,'status',case when auto then 'approved' else 'proposed' end);
end $$;

create function pulse.comp_probation_decide(p_id uuid, p_action text, p_note text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); b comp_probation; st text;
begin
 select * into b from comp_probation where org_id=current_org() and id=p_id for update;
 if not found or not comp_reader() then raise exception 'Not found' using errcode='P0002'; end if;
 if b.status<>'proposed' then raise exception 'Only a proposed outcome is decided' using errcode='22023'; end if;
 if me in (b.person_id,b.proposed_by) then raise exception 'Someone else decides this' using errcode='42501'; end if;
 if not comp_is_approver(me) then raise exception 'A founder decides this' using errcode='42501'; end if;
 if p_action not in ('approve','reject') then raise exception 'Approve or reject' using errcode='22023'; end if;
 st:=case p_action when 'approve' then 'approved' else 'rejected' end;
 update comp_probation set status=st,decided_by=me,decided_at=now(),decision_note=nullif(btrim(coalesce(p_note,'')),'') where id=p_id;
 perform comp_event_add(b.person_id,'probation.'||case st when 'approved' then b.action else 'rejected' end,'probation',p_id,jsonb_build_object('action',b.action,'until',b.until_on));
 perform comp_emit(b.proposed_by,'comp.decided',b.person_id,'probation:'||p_id||':'||st,'Probation '||b.action||' for '||comp_name(b.person_id)||' was '||st,'/people/pay/'||b.person_id);
 if st='approved' then perform comp_probation_apply(p_id); end if;
 return st;
end $$;

create function pulse.comp_review_done(p_id uuid, p_note text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v comp_probation_review;
begin
 select * into v from comp_probation_review where org_id=current_org() and id=p_id for update;
 if not found or not (comp_writer() or coalesce(hr_head(v.person_id)=current_viewer(),false)) or v.person_id=current_viewer() then raise exception 'Review not found' using errcode='P0002'; end if;
 if v.status<>'due' then raise exception 'This review is closed' using errcode='22023'; end if;
 if length(btrim(coalesce(p_note,'')))<3 then raise exception 'Write how the probation is going' using errcode='22023'; end if;
 update comp_probation_review set status='done',note=btrim(p_note),done_by=current_viewer(),done_at=now() where id=p_id;
 perform comp_event_add(v.person_id,'probation.reviewed','review',p_id,jsonb_build_object('kind',v.kind));
end $$;

-- -------------------------------------------------------------------------------------------------- 7. pauses
create function pulse.comp_pause_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); v_person uuid:=nullif(p->>'person','')::uuid; v_from date:=nullif(p->>'from','')::date; v_to date:=nullif(p->>'to','')::date; v_id uuid;
begin
 if not comp_writer() then raise exception 'HR proposes pauses' using errcode='42501'; end if;
 if v_person is null or v_person=me then raise exception 'Someone else pauses your own pay' using errcode='42501'; end if;
 if v_from is null or v_to is null or v_to<v_from then raise exception 'Give the first and last day of the pause' using errcode='22023'; end if;
 if coalesce(p->>'reasonKind','') not in ('unpaid_leave','sabbatical','hold','other') then raise exception 'Choose why pay pauses' using errcode='22023'; end if;
 if length(btrim(coalesce(p->>'note','')))<3 then raise exception 'Say why: it goes in the letter' using errcode='22023'; end if;
 if not exists(select 1 from comp_record where person_id=v_person) or (comp_in_force(v_person,v_from)).id is null then raise exception 'Set up this person''s pay first' using errcode='22023'; end if;
 if exists(select 1 from comp_pause where person_id=v_person and status in ('proposed','approved') and from_on<=v_to and coalesce(ended_on,to_on)>=v_from) then
  raise exception 'Another pause covers some of these days' using errcode='22023'; end if;
 insert into comp_pause(org_id,person_id,from_on,to_on,paid_percent,reason_kind,note,proposed_by)
 values(current_org(),v_person,v_from,v_to,coalesce(nullif(p->>'paidPercent','')::int,0),p->>'reasonKind',btrim(p->>'note'),me) returning id into v_id;
 perform comp_event_add(v_person,'pause.proposed','pause',v_id,jsonb_build_object('from',v_from,'to',v_to,'paidPercent',coalesce(nullif(p->>'paidPercent','')::int,0)));
 perform comp_tell_approvers(v_person,'pause:'||v_id,'Pay pause for '||comp_name(v_person)||' is waiting for your approval');
 return v_id;
end $$;
create function pulse.comp_pause_decide(p_id uuid, p_action text, p_note text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); z comp_pause; st text;
begin
 select * into z from comp_pause where org_id=current_org() and id=p_id for update;
 if not found or not comp_reader() then raise exception 'Pause not found' using errcode='P0002'; end if;
 if z.status<>'proposed' then raise exception 'Only a proposed pause is decided' using errcode='22023'; end if;
 if me in (z.person_id,z.proposed_by) then raise exception 'Someone else decides this pause' using errcode='42501'; end if;
 if not comp_is_approver(me) then raise exception 'The approver named in the pay policy decides pauses' using errcode='42501'; end if;
 if p_action not in ('approve','reject') then raise exception 'Approve or reject' using errcode='22023'; end if;
 st:=case p_action when 'approve' then 'approved' else 'rejected' end;
 update comp_pause set status=st,decided_by=me,decided_at=now(),decision_note=nullif(btrim(coalesce(p_note,'')),'') where id=p_id;
 perform comp_event_add(z.person_id,'pause.'||st,'pause',p_id,jsonb_build_object('from',z.from_on,'to',z.to_on));
 perform comp_emit(z.proposed_by,'comp.decided',z.person_id,'pause:'||p_id||':'||st,'Pay pause for '||comp_name(z.person_id)||' was '||st,'/people/pay/'||z.person_id);
 perform comp_status_refresh(z.person_id);
 return st;
end $$;
create function pulse.comp_pause_close(p_id uuid, p_action text, p_on date) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare z comp_pause;
begin
 select * into z from comp_pause where org_id=current_org() and id=p_id for update;
 if not found or not comp_writer() or z.person_id=current_viewer() then raise exception 'Pause not found' using errcode='P0002'; end if;
 if p_action='withdraw' then
  if z.status<>'proposed' then raise exception 'Only a proposed pause is withdrawn' using errcode='22023'; end if;
  update comp_pause set status='withdrawn' where id=p_id;
 elsif p_action='end' then
  if z.status<>'approved' then raise exception 'Only an approved pause is ended early' using errcode='22023'; end if;
  if p_on is null or p_on<z.from_on-1 or p_on>=coalesce(z.ended_on,z.to_on) then raise exception 'End it before its last day' using errcode='22023'; end if;
  update comp_pause set ended_on=p_on where id=p_id;
 else raise exception 'Withdraw or end' using errcode='22023'; end if;
 perform comp_event_add(z.person_id,'pause.'||case p_action when 'end' then 'ended' else 'withdrawn' end,'pause',p_id,jsonb_build_object('on',p_on));
 perform comp_status_refresh(z.person_id);
end $$;
-- The share of a month's pay a person is paid after approved pauses (1 = no pause). Payroll and the payslip projection use it.
create function pulse.comp_pause_factor(p_person uuid, p_month date) returns numeric language sql stable security definer set search_path=pulse,pg_temp as $$
 with m as (select date_trunc('month',p_month)::date f,(date_trunc('month',p_month)+interval '1 month'-interval '1 day')::date l)
 select greatest(0,1-coalesce(sum((least(coalesce(z.ended_on,z.to_on),m.l)-greatest(z.from_on,m.f)+1)*(100-z.paid_percent)/100.0),0)/((m.l-m.f)+1))::numeric
 from m left join comp_pause z on z.org_id=current_org() and z.person_id=p_person and z.status='approved' and z.from_on<=m.l and coalesce(z.ended_on,z.to_on)>=m.f
 group by m.f,m.l
$$;

-- ---------------------------------------------------------------------------------------- 8. one-time items
create function pulse.comp_item_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); v_person uuid:=nullif(p->>'person','')::uuid; v_kind text:=p->>'kind'; v_id uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid());
 v_month date:=date_trunc('month',coalesce(nullif(p->>'forMonth','')::date,lifecycle_today()))::date; v_months int:=nullif(p->>'recoverMonths','')::int;
 v_from date:=date_trunc('month',nullif(p->>'recoverFrom','')::date)::date; pol comp_policy:=comp_policy_row();
begin
 if not comp_writer() then raise exception 'HR proposes one-time items' using errcode='42501'; end if;
 if v_person is null or v_person=me then raise exception 'Someone else proposes items on your own pay' using errcode='42501'; end if;
 if v_kind is null or v_kind not in ('bonus','incentive','extra','overtime','advance','loan') then raise exception 'Choose the kind of item' using errcode='22023'; end if;
 if length(btrim(coalesce(p->>'reason','')))<3 then raise exception 'Say what it is for' using errcode='22023'; end if;
 if v_kind in ('advance','loan') then
  if v_months is null or v_months<1 or v_months>pol.recover_max then raise exception 'Recover it over 1 to % months',pol.recover_max using errcode='22023'; end if;
  v_from:=coalesce(v_from,(v_month+interval '1 month')::date);
  if v_from<v_month then raise exception 'Recovery starts after the advance' using errcode='22023'; end if;
 else v_months:=null; v_from:=null;
 end if;
 perform comp_sealed_check(p->'sealed');
 perform comp_record_ensure(v_person);
 insert into comp_item(org_id,id,person_id,kind,for_month,payout,reason,ref,recover_months,recover_from,s_kid,s_key,s_data,proposed_by)
 values(current_org(),v_id,v_person,v_kind,v_month,coalesce(nullif(p->>'payout',''),'payroll'),btrim(p->>'reason'),coalesce(p->'ref','{}'),v_months,v_from,
  p->'sealed'->>'kid',decode(p->'sealed'->>'key','base64'),decode(p->'sealed'->>'data','base64'),me);
 perform comp_log(v_person,'comp.pay','item_proposed');
 perform comp_event_add(v_person,'item.proposed','item',v_id,jsonb_build_object('kind',v_kind,'forMonth',v_month));
 perform comp_tell_approvers(v_person,'item:'||v_id,initcap(v_kind)||' for '||comp_name(v_person)||' is waiting for your approval');
 return v_id;
end $$;
create function pulse.comp_item_decide(p_id uuid, p_action text, p_note text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); i comp_item; st text;
begin
 select * into i from comp_item where org_id=current_org() and id=p_id for update;
 if not found or not comp_reader() then raise exception 'Item not found' using errcode='P0002'; end if;
 if p_action='withdraw' then
  if not comp_writer() or i.status<>'proposed' or me=i.person_id then raise exception 'Only a proposed item is withdrawn' using errcode='22023'; end if;
  update comp_item set status='withdrawn' where id=p_id;
  perform comp_event_add(i.person_id,'item.withdrawn','item',p_id,jsonb_build_object('kind',i.kind));
  return 'withdrawn';
 end if;
 if i.status<>'proposed' then raise exception 'Only a proposed item is decided' using errcode='22023'; end if;
 if me in (i.person_id,i.proposed_by) then raise exception 'Someone else decides this item' using errcode='42501'; end if;
 if not comp_is_approver(me) then raise exception 'The approver named in the pay policy decides one-time items' using errcode='42501'; end if;
 if p_action not in ('approve','reject') then raise exception 'Approve or reject' using errcode='22023'; end if;
 st:=case p_action when 'approve' then 'approved' else 'rejected' end;
 update comp_item set status=st,decided_by=me,decided_at=now(),decision_note=nullif(btrim(coalesce(p_note,'')),'') where id=p_id;
 perform comp_event_add(i.person_id,'item.'||st,'item',p_id,jsonb_build_object('kind',i.kind,'forMonth',i.for_month));
 perform comp_emit(i.proposed_by,'comp.decided',i.person_id,'item:'||p_id||':'||st,initcap(i.kind)||' for '||comp_name(i.person_id)||' was '||st,'/people/pay/'||i.person_id);
 if st='approved' then perform comp_emit(i.person_id,'comp.letter',i.person_id,'item:'||p_id,case i.kind when 'bonus' then 'A bonus' when 'incentive' then 'An incentive'
  when 'extra' then 'An extra payment' when 'overtime' then 'Overtime pay' when 'advance' then 'An advance' when 'loan' then 'A loan' else 'Arrears' end||' was added to your pay','/me/pay'); end if;
 return st;
end $$;

-- -------------------------------------------------------------------------------------------------- 9. claims
create function pulse.comp_claim_submit(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); v_id uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid()); pol comp_policy:=comp_policy_row(); v_head uuid;
 v_on date:=nullif(p->>'spentOn','')::date;
begin
 if me is null or not exists(select 1 from person where org_id=current_org() and id=me and side='staff' and status='active') then raise exception 'Claims are for staff' using errcode='42501'; end if;
 if not exists(select 1 from jsonb_array_elements(pol.claim_categories) c where c->>'key'=p->>'category') then raise exception 'Choose a category' using errcode='22023'; end if;
 if v_on is null or v_on>lifecycle_today() or v_on<lifecycle_today()-180 then raise exception 'The bill''s date must be in the last six months' using errcode='22023'; end if;
 perform comp_sealed_check(p->'sealed'); perform comp_sealed_check(p->'receipt');
 v_head:=hr_head(me);
 if v_head=me or not exists(select 1 from person where id=v_head and status='active') then v_head:=null; end if;
 begin
  insert into comp_claim(org_id,id,person_id,category,spent_on,vendor,note,above_threshold,head_id,payout,for_month,receipt_mime,receipt_size,receipt_sha256,dup_key,
   s_kid,s_key,s_data,r_kid,r_key,r_data)
  values(current_org(),v_id,me,p->>'category',v_on,nullif(btrim(coalesce(p->>'vendor','')),''),nullif(btrim(coalesce(p->>'note','')),''),coalesce((p->>'aboveThreshold')::boolean,false),
   v_head,coalesce(nullif(p->>'payout',''),'payroll'),date_trunc('month',lifecycle_today())::date,p->>'receiptMime',(p->>'receiptSize')::int,p->>'receiptSha256',p->>'dupKey',
   p->'sealed'->>'kid',decode(p->'sealed'->>'key','base64'),decode(p->'sealed'->>'data','base64'),
   p->'receipt'->>'kid',decode(p->'receipt'->>'key','base64'),decode(p->'receipt'->>'data','base64'));
 exception when unique_violation then
  raise exception 'This bill was already claimed' using errcode='22023';
 end;
 perform comp_event_add(me,'claim.submitted','claim',v_id,jsonb_build_object('category',p->>'category','spentOn',v_on));
 if v_head is not null then perform comp_emit(v_head,'comp.waiting',me,'claim:'||v_id,comp_name(me)||'''s reimbursement claim is waiting for your approval','/people/pay/claims?claim='||v_id);
 else perform comp_tell_writers(me,'comp.waiting','claim:'||v_id,comp_name(me)||'''s reimbursement claim is waiting for your approval'); end if;
 return v_id;
end $$;
create function pulse.comp_claim_decide(p_id uuid, p_action text, p_note text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); c comp_claim; st text; as_head boolean; higher boolean; v_note text:=nullif(btrim(coalesce(p_note,'')),'');
begin
 select * into c from comp_claim where org_id=current_org() and id=p_id for update;
 if not found then raise exception 'Claim not found' using errcode='P0002'; end if;
 if p_action='withdraw' then
  if c.person_id<>me or c.status not in ('submitted','head_approved') then raise exception 'Only your own open claim is withdrawn' using errcode='22023'; end if;
  update comp_claim set status='withdrawn' where id=p_id;
  perform comp_event_add(c.person_id,'claim.withdrawn','claim',p_id,'{}');
  return 'withdrawn';
 end if;
 if me=c.person_id then raise exception 'Someone else approves your own claim' using errcode='42501'; end if;
 higher:=comp_writer() or comp_is_approver(me);
 as_head:=coalesce(c.head_id=me,false) and c.status='submitted';
 if not (as_head or higher) or c.status not in ('submitted','head_approved') then raise exception 'This claim is not waiting for you' using errcode='42501'; end if;
 if c.status='head_approved' and me=c.head_by then raise exception 'Someone else gives the second approval' using errcode='42501'; end if;
 if p_action not in ('approve','reject') then raise exception 'Approve or reject' using errcode='22023'; end if;
 if p_action='reject' and v_note is null then raise exception 'Say why, for the person who claimed' using errcode='22023'; end if;
 if p_action='reject' then st:='rejected';
 elsif as_head and not higher and c.above_threshold then st:='head_approved';
 else st:='approved';
 end if;
 update comp_claim set status=st,head_by=case when as_head then me else head_by end,head_at=case when as_head then now() else head_at end,
  decided_by=case when st in ('approved','rejected') then me end,decided_at=case when st in ('approved','rejected') then now() end,decision_note=v_note where id=p_id;
 perform comp_log(c.person_id,'comp.claim','claim_'||st);
 perform comp_event_add(c.person_id,'claim.'||st,'claim',p_id,jsonb_build_object('category',c.category));
 if st='head_approved' then perform comp_tell_writers(c.person_id,'comp.waiting','claim:'||p_id||':second',comp_name(c.person_id)||'''s reimbursement claim is waiting for your approval');
 else perform comp_emit(c.person_id,'comp.claim',c.person_id,'claim:'||p_id||':'||st,'Your reimbursement claim was '||st,'/me/pay'); end if;
 return st;
end $$;

-- ------------------------------------------------------------------------------------- 10. exit: full and final
create function pulse.comp_settlement_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); v_person uuid:=nullif(p->>'person','')::uuid; s comp_settlement; v_id uuid; v_last date:=nullif(p->>'lastDay','')::date;
begin
 if not comp_writer() then raise exception 'HR prepares the full and final' using errcode='42501'; end if;
 if v_person is null or v_person=me then raise exception 'Someone else settles your own exit' using errcode='42501'; end if;
 if coalesce(p->>'exitKind','') not in ('resigned','terminated','contract_ended','mutual','probation_end') then raise exception 'Say how they leave' using errcode='22023'; end if;
 if coalesce(p->>'noticeMode','served') not in ('served','short_recovered','waived','paid_in_lieu') then raise exception 'Say how the notice was handled' using errcode='22023'; end if;
 if v_last is null then raise exception 'Give the last working day' using errcode='22023'; end if;
 perform comp_sealed_check(p->'sealed');
 perform comp_record_ensure(v_person);
 select * into s from comp_settlement where org_id=current_org() and person_id=v_person and status<>'withdrawn' for update;
 if s.id is not null and s.status not in ('draft','checked') then raise exception 'The full and final is approved already' using errcode='22023'; end if;
 if s.id is null then
  insert into comp_settlement(org_id,person_id,case_id,exit_kind,last_day,notice_mode,legal,note,s_kid,s_key,s_data,prepared_by)
  values(current_org(),v_person,nullif(p->>'caseId','')::uuid,p->>'exitKind',v_last,coalesce(p->>'noticeMode','served'),coalesce(p->'legal','{}'),nullif(btrim(coalesce(p->>'note','')),''),
   p->'sealed'->>'kid',decode(p->'sealed'->>'key','base64'),decode(p->'sealed'->>'data','base64'),me) returning id into v_id;
 else
  update comp_settlement set case_id=coalesce(nullif(p->>'caseId','')::uuid,case_id),exit_kind=p->>'exitKind',last_day=v_last,notice_mode=coalesce(p->>'noticeMode','served'),
   legal=coalesce(p->'legal','{}'),note=nullif(btrim(coalesce(p->>'note','')),''),s_kid=p->'sealed'->>'kid',s_key=decode(p->'sealed'->>'key','base64'),
   s_data=decode(p->'sealed'->>'data','base64'),status='draft',prepared_by=me,prepared_at=now(),checked_by=null,checked_at=null,updated_at=now() where id=s.id;
  v_id:=s.id;
 end if;
 update comp_record set end_on=v_last,updated_at=now() where person_id=v_person;
 perform comp_log(v_person,'comp.settlement','prepared');
 perform comp_event_add(v_person,'settlement.prepared','settlement',v_id,jsonb_build_object('lastDay',v_last,'exitKind',p->>'exitKind'));
 perform comp_status_refresh(v_person);
 return v_id;
end $$;
create function pulse.comp_settlement_step(p_id uuid, p_action text, p_note text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); s comp_settlement; st text; k text;
begin
 select * into s from comp_settlement where org_id=current_org() and id=p_id for update;
 if not found or not comp_reader() then raise exception 'Full and final not found' using errcode='P0002'; end if;
 if me=s.person_id then raise exception 'Someone else settles your own exit' using errcode='42501'; end if;
 if p_action='check' then
  if not comp_writer() or s.status<>'draft' then raise exception 'HR checks a prepared statement' using errcode='22023'; end if;
  if s.exit_kind in ('terminated','probation_end') then
   foreach k in array array['reason','notice','heard','dues'] loop
    if coalesce((s.legal->>k)::boolean,false) is not true then raise exception 'Tick the legal care list for a termination first' using errcode='22023'; end if;
   end loop;
  end if;
  st:='checked';
  update comp_settlement set status=st,checked_by=me,checked_at=now(),updated_at=now() where id=p_id;
  perform comp_tell_approvers(s.person_id,'settlement:'||p_id,'Full and final for '||comp_name(s.person_id)||' is waiting for your approval');
 elsif p_action in ('approve','return') then
  if s.status<>'checked' then raise exception 'HR checks the statement first' using errcode='22023'; end if;
  if not comp_is_approver(me) or me=s.checked_by then raise exception 'A founder other than the checker approves' using errcode='42501'; end if;
  if p_action='return' and length(btrim(coalesce(p_note,'')))<3 then raise exception 'Say what to change' using errcode='22023'; end if;
  st:=case p_action when 'approve' then 'approved' else 'draft' end;
  update comp_settlement set status=st,approved_by=case when st='approved' then me end,approved_at=case when st='approved' then now() end,
   decision_note=nullif(btrim(coalesce(p_note,'')),''),checked_by=case when st='draft' then null else checked_by end,updated_at=now() where id=p_id;
  perform comp_emit(s.checked_by,'comp.decided',s.person_id,'settlement:'||p_id||':'||st,'Full and final for '||comp_name(s.person_id)||case st when 'approved' then ' was approved' else ' was sent back' end,'/people/pay/'||s.person_id);
 elsif p_action='withdraw' then
  if not comp_writer() or s.status in ('approved','issued') then raise exception 'An approved statement stays' using errcode='22023'; end if;
  st:='withdrawn';
  update comp_settlement set status=st,updated_at=now() where id=p_id;
 else raise exception 'Check, approve, send back or withdraw' using errcode='22023'; end if;
 perform comp_event_add(s.person_id,'settlement.'||case st when 'draft' then 'returned' else st end,'settlement',p_id,'{}');
 return st;
end $$;

-- ------------------------------------------------------------------------------------------------- 11. letters
-- An issued letter, filed sealed. Its subject must be decided (approved) and not lettered yet; the writer or approver
-- files it in the same transaction as the decision. The person is told (an offer's letter: only once it is sent).
create function pulse.comp_letter_add(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); v_type text:=p->>'subjectType'; v_subject uuid:=nullif(p->>'subjectId','')::uuid; v_person uuid; v_ok boolean; v_id uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid());
begin
 if not (comp_writer() or comp_is_approver(me)) then raise exception 'Letters are filed by HR and founders' using errcode='42501'; end if;
 perform comp_sealed_check(p->'sealed'); perform comp_sealed_check(p->'pdf');
 if v_type='change' then select person_id,status='approved' and letter_id is null into v_person,v_ok from comp_change where org_id=current_org() and id=v_subject and kind<>'offer';
 elsif v_type='offer' then select person_id,status='approved' and letter_id is null into v_person,v_ok from comp_offer where org_id=current_org() and id=v_subject;
 elsif v_type='probation' then select person_id,status='approved' and letter_id is null into v_person,v_ok from comp_probation where org_id=current_org() and id=v_subject;
 elsif v_type='pause' then select person_id,status='approved' and letter_id is null into v_person,v_ok from comp_pause where org_id=current_org() and id=v_subject;
 elsif v_type='settlement' then select person_id,status='approved' and letter_id is null into v_person,v_ok from comp_settlement where org_id=current_org() and id=v_subject;
 else raise exception 'Choose what the letter is about' using errcode='22023'; end if;
 if v_person is null then raise exception 'Not found' using errcode='P0002'; end if;
 if not v_ok then raise exception 'A letter follows an approved decision, once' using errcode='22023'; end if;
 if v_person=me then raise exception 'Someone else files your own letter' using errcode='42501'; end if;
 insert into comp_letter(org_id,id,person_id,kind,subject_type,subject_id,title,s_kid,s_key,s_data,p_kid,p_key,p_data,sha256,pages,issued_by)
 values(current_org(),v_id,v_person,p->>'kind',v_type,v_subject,left(btrim(p->>'title'),160),p->'sealed'->>'kid',decode(p->'sealed'->>'key','base64'),decode(p->'sealed'->>'data','base64'),
  p->'pdf'->>'kid',decode(p->'pdf'->>'key','base64'),decode(p->'pdf'->>'data','base64'),p->>'sha256',coalesce(nullif(p->>'pages','')::int,1),me);
 execute format('update pulse.comp_%s set letter_id=$1 where id=$2',v_type) using v_id,v_subject;
 if v_type='settlement' then update comp_settlement set status='issued',updated_at=now() where id=v_subject; end if;
 perform comp_event_add(v_person,'letter.issued','letter',v_id,jsonb_build_object('kind',p->>'kind'));
 if v_type<>'offer' then perform comp_emit(v_person,'comp.letter',v_person,'letter:'||v_id,'A letter about your pay is ready: '||left(btrim(p->>'title'),120),'/me/pay'); end if;
 return v_id;
end $$;
-- Whether the person may read a letter about themselves: offers once sent, everything else once issued.
create function pulse.comp_letter_visible(l pulse.comp_letter) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select l.kind<>'offer' or exists(select 1 from comp_offer o where o.id=l.subject_id and o.letter_id=l.id and o.status in ('sent','accepted','declined','expired'))
$$;
create function pulse.comp_letter_sealed(p_id uuid, p_part text) returns table(person_id uuid, kind text, title text, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l comp_letter;
begin
 select * into l from comp_letter where org_id=current_org() and id=p_id;
 if l.id is null or not (comp_reader() or l.person_id=current_viewer() and comp_letter_visible(l)) then raise exception 'Letter not found' using errcode='P0002'; end if;
 perform comp_log(l.person_id,'comp.letter',case when l.person_id=current_viewer() then 'self' else 'letter_view' end);
 if l.person_id=current_viewer() and l.seen_at is null then update comp_letter set seen_at=now() where id=p_id; end if;
 return query select l.person_id,l.kind,l.title,case when p_part='pdf' then l.p_kid else l.s_kid end,case when p_part='pdf' then l.p_key else l.s_key end,
  case when p_part='pdf' then l.p_data else l.s_data end;
end $$;

-- ---------------------------------------------------------------------------------------- 12. sealed reads
-- One sealed value, after the check, with one access-log line. Kinds: change, item, claim (amount), receipt, settlement.
create function pulse.comp_sealed(p_kind text, p_id uuid) returns table(person_id uuid, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_person uuid; v_kid text; v_key bytea; v_data bytea; ok boolean:=false; me uuid:=current_viewer(); c comp_claim;
begin
 if me is null then raise exception 'Not found' using errcode='P0002'; end if;
 if p_kind='change' then
  select x.person_id,x.s_kid,x.s_key,x.s_data,comp_reader() or x.person_id=me and x.status='approved' and x.kind<>'offer'
   or x.person_id=me and x.kind='offer' and exists(select 1 from comp_offer o where o.change_id=x.id and o.status in ('sent','accepted'))
  into v_person,v_kid,v_key,v_data,ok from comp_change x where x.org_id=current_org() and x.id=p_id;
 elsif p_kind='item' then
  select x.person_id,x.s_kid,x.s_key,x.s_data,comp_reader() or x.person_id=me and x.status='approved' into v_person,v_kid,v_key,v_data,ok from comp_item x where x.org_id=current_org() and x.id=p_id;
 elsif p_kind in ('claim','receipt') then
  select * into c from comp_claim x where x.org_id=current_org() and x.id=p_id;
  v_person:=c.person_id; ok:=c.id is not null and (comp_reader() or c.person_id=me or c.head_id=me and c.status in ('submitted','head_approved','approved','rejected'));
  if p_kind='claim' then v_kid:=c.s_kid; v_key:=c.s_key; v_data:=c.s_data; else v_kid:=c.r_kid; v_key:=c.r_key; v_data:=c.r_data; end if;
 elsif p_kind='settlement' then
  select x.person_id,x.s_kid,x.s_key,x.s_data,comp_reader() or x.person_id=me and x.status='issued' into v_person,v_kid,v_key,v_data,ok from comp_settlement x where x.org_id=current_org() and x.id=p_id;
 end if;
 if v_person is null or not coalesce(ok,false) then raise exception 'Not found' using errcode='P0002'; end if;
 perform comp_log(v_person,case when p_kind in ('claim','receipt') then 'comp.claim' when p_kind='settlement' then 'comp.settlement' else 'comp.pay' end,
  case when v_person=me then 'self' else p_kind||'_view' end);
 return query select v_person,v_kid,v_key,v_data;
end $$;

-- A person's whole pay history, sealed, for their page: one access-log line for the look. Founders and HR get every
-- version, item and claim; the person their approved versions, sent offers, approved items and own claims.
create function pulse.comp_history_sealed(p_person uuid) returns table(kind text, id uuid, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare reader boolean:=comp_reader(); self boolean:=p_person=current_viewer();
begin
 if current_viewer() is null or not (reader or self) then raise exception 'Pay is for founders, HR and the person' using errcode='42501'; end if;
 perform comp_log(p_person,'comp.pay',case when self then 'self' else 'history_view' end);
 return query
  select 'change'::text,c.id,c.s_kid,c.s_key,c.s_data from comp_change c where c.org_id=current_org() and c.person_id=p_person
   and (reader or c.status='approved' and c.kind<>'offer' or c.kind='offer' and exists(select 1 from comp_offer o where o.change_id=c.id and o.status in ('sent','accepted')))
  union all select 'item',i.id,i.s_kid,i.s_key,i.s_data from comp_item i where i.org_id=current_org() and i.person_id=p_person and (reader or i.status='approved')
  union all select 'claim',k.id,k.s_kid,k.s_key,k.s_data from comp_claim k where k.org_id=current_org() and k.person_id=p_person;
end $$;

-- The letterhead: the company's ERP design (its default template, else the first), its name and address, for whoever
-- writes or approves pay letters (HR need not have ERP access), and the images by kind.
create function pulse.comp_letterhead() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t record; s jsonb;
begin
 if not (comp_writer() or comp_is_approver()) then raise exception 'Letters are for HR and founders' using errcode='42501'; end if;
 select x.design,x.logo_id,x.signature_id into t from erp_template x where x.org_id=current_org() and not x.archived
  order by (x.id=(select template_id from erp_template_default where org_id=current_org() and doc_type='invoice')) desc,x.created_at limit 1;
 select company into s from erp_settings where org_id=current_org();
 return jsonb_build_object('design',coalesce(t.design,'{}'::jsonb),'company',jsonb_build_object('name',coalesce(nullif(s->>'legalName',''),(select name from org where id=current_org())),
  'lines',coalesce(s->'address','[]'::jsonb)),'logo',t.logo_id is not null or exists(select 1 from org_brand where org_id=current_org() and logo_png is not null),
  'signature',t.signature_id is not null,'letters',(select letters from comp_policy_row()));
end $$;
create function pulse.comp_letter_asset(p_kind text) returns table(bytes bytea, mime text) language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t record;
begin
 if not (comp_writer() or comp_is_approver()) then raise exception 'Letters are for HR and founders' using errcode='42501'; end if;
 select x.logo_id,x.signature_id into t from erp_template x where x.org_id=current_org() and not x.archived
  order by (x.id=(select template_id from erp_template_default where org_id=current_org() and doc_type='invoice')) desc,x.created_at limit 1;
 if p_kind='signature' then return query select a.bytes,a.mime from erp_asset a where a.id=t.signature_id;
 elsif p_kind='logo' then
  return query select a.bytes,a.mime from erp_asset a where a.id=t.logo_id;
  if not found then return query select b.logo_png,'image/png'::text from org_brand b where b.org_id=current_org() and b.logo_png is not null; end if;
 end if;
end $$;

-- The figures in force on a day for several people (the People & pay table's "Show pay"): one log line per person.
create function pulse.comp_figures(p_people uuid[], p_day date) returns table(person_id uuid, change_id uuid, kind text, pay_type text, effective_on date, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who uuid; c comp_change;
begin
 if current_viewer() is null then raise exception 'Not found' using errcode='P0002'; end if;
 foreach who in array coalesce(p_people,'{}') loop
  if not comp_can_see(who) then continue; end if;
  c:=comp_in_force(who,coalesce(p_day,lifecycle_today()));
  if c.id is null then continue; end if;
  perform comp_log(who,'comp.pay',case when who=current_viewer() then 'self' else 'pay_view' end);
  person_id:=who; change_id:=c.id; kind:=c.kind; pay_type:=c.pay_type; effective_on:=c.effective_on; kid:=c.s_kid; dkey:=c.s_key; data:=c.s_data;
  return next;
 end loop;
end $$;

-- A month's pay versions for totals: individuals for readers (each logged); for the Accountant, rows keyed anonymously
-- for counting, with the person only so the API can open each value (it returns the totals alone, never the rows).
create function pulse.comp_month_sealed(p_month date) returns table(person_key text, person_id uuid, change_id uuid, pay_type text, effective_on date, until_on date, kid text, dkey bytea, data bytea, pause numeric)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare f date:=date_trunc('month',p_month)::date; l date:=(date_trunc('month',p_month)+interval '1 month'-interval '1 day')::date; reader boolean:=comp_reader();
 salt text:=md5(random()::text); acct boolean:=is_accountant(current_viewer());
begin
 if not reader and not acct then raise exception 'Pay totals are for founders, HR and the accountant' using errcode='42501'; end if;
 if reader then perform comp_log(x.person_id,'comp.pay','totals') from (select distinct c.person_id from comp_change c where c.org_id=current_org() and c.status='approved' and c.effective_on<=l) x;
 else perform comp_log(null,'comp.pay','accountant_totals'); end if;
 return query
 with v as (select c.*,lead(c.effective_on) over (partition by c.person_id order by c.effective_on,c.decided_at) nxt from comp_change c
   where c.org_id=current_org() and c.status='approved')
 select case when reader then v.person_id::text else md5(salt||v.person_id::text) end,v.person_id,v.id,v.pay_type,greatest(v.effective_on,f),least(coalesce(v.nxt-1,l),l,coalesce(r.end_on,l)),
  v.s_kid,v.s_key,v.s_data,comp_pause_factor(v.person_id,f)
 from v join comp_record r on r.person_id=v.person_id
 where v.effective_on<=l and coalesce(v.nxt-1,l)>=f and (r.end_on is null or r.end_on>=f) and (v.nxt is null or v.nxt>v.effective_on);
end $$;

-- Whose pay a row is about, for HR and founders (the API files a decision's letter with it).
create function pulse.comp_owner(p_kind text, p_id uuid) returns uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare v uuid;
begin
 if not (comp_reader() or comp_writer() or comp_is_approver()) then raise exception 'Not found' using errcode='P0002'; end if;
 v:=case p_kind when 'change' then (select person_id from comp_change where org_id=current_org() and id=p_id)
  when 'offer' then (select person_id from comp_offer where org_id=current_org() and id=p_id)
  when 'probation' then (select person_id from comp_probation where org_id=current_org() and id=p_id)
  when 'pause' then (select person_id from comp_pause where org_id=current_org() and id=p_id)
  when 'item' then (select person_id from comp_item where org_id=current_org() and id=p_id)
  when 'settlement' then (select person_id from comp_settlement where org_id=current_org() and id=p_id) end;
 if v is null then raise exception 'Not found' using errcode='P0002'; end if;
 return v;
end $$;

-- --------------------------------------------------------------------------------------- 13. what screens read
-- The People & pay table. Founders and HR: everyone on staff with what is next. Managers (policy "status"): their people,
-- status and dates only. One access-log line per look; amounts come only through comp_figures.
create function pulse.comp_people() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); reader boolean:=comp_reader(); today date:=lifecycle_today(); pol comp_policy:=comp_policy_row(); out jsonb;
begin
 if me is null or not (reader or pol.managers='status' and exists(select 1 from person p where p.org_id=current_org() and hr_head(p.id)=me and p.id<>me)) then
  raise exception 'Pay is for founders and HR' using errcode='42501'; end if;
 perform comp_log(null,'comp.list',case when reader then 'pay_list' else 'pay_list_manager' end);
 perform comp_status_refresh(r.person_id) from comp_record r where r.org_id=current_org() and (r.refreshed_on is null or r.refreshed_on<today or r.status_until<today);
 select coalesce(jsonb_agg(row order by row->>'name'),'[]') into out from (
  select jsonb_strip_nulls(jsonb_build_object('id',p.id,'name',p.display_name,'role',pp.role,'pod',pp.pod,'department',pp.department,
   'photoAt',(select ph.updated_at from person_photo ph where ph.person_id=p.id),'stage',lifecycle_stage(p.id),'current',p.status='active',
   'hasRecord',r.person_id is not null,'status',r.status,'since',r.status_since,'until',r.status_until,'startOn',r.start_on,'endOn',r.end_on,'confirmedOn',r.confirmed_on,
   'payType',(comp_in_force(p.id,today)).pay_type,
   'probation',case when e.probation_to is not null and r.confirmed_on is null then jsonb_build_object('from',e.probation_from,'to',e.probation_to,
     'review',(select jsonb_build_object('id',v.id,'kind',v.kind,'dueOn',v.due_on) from comp_probation_review v where v.person_id=p.id and v.status='due' order by v.due_on limit 1),
     'outcome',(select jsonb_build_object('id',b.id,'action',b.action,'proposedBy',b.proposed_by) from comp_probation b where b.person_id=p.id and b.status='proposed')) end,
   'lastDay',e.last_working_day,
   'offer',(select jsonb_build_object('id',o.id,'status',o.status,'startOn',o.start_on,'validUntil',o.valid_until,'proposedBy',o.proposed_by,'approvedBy',o.approved_by,'hasLetter',o.letter_id is not null)
     from comp_offer o where o.person_id=p.id and (o.status in ('draft','proposed','approved','sent') or o.status='accepted' and o.started_at is null) order by o.created_at desc limit 1),
   'pause',(select jsonb_build_object('id',z.id,'status',z.status,'from',z.from_on,'to',coalesce(z.ended_on,z.to_on),'paidPercent',z.paid_percent,'proposedBy',z.proposed_by)
     from comp_pause z where z.person_id=p.id and z.status in ('proposed','approved') and coalesce(z.ended_on,z.to_on)>=today order by z.from_on limit 1),
   'change',case when reader then (select jsonb_build_object('id',c.id,'kind',c.kind,'status',c.status,'effectiveOn',c.effective_on,'proposedBy',c.proposed_by)
     from comp_change c where c.person_id=p.id and c.kind<>'offer' and (c.status in ('draft','proposed') or c.status='approved' and c.effective_on>today) order by (c.status='proposed') desc,c.effective_on limit 1) end,
   'items',case when reader then (select count(*) from comp_item i where i.person_id=p.id and i.status='proposed') end,
   'claims',(select count(*) from comp_claim k where k.person_id=p.id and (k.status='submitted' and (k.head_id=me or reader and k.head_id is null) or k.status='head_approved' and reader and k.head_by is distinct from me)),
   'settlement',case when reader then (select jsonb_build_object('id',s.id,'status',s.status,'lastDay',s.last_day,'checkedBy',s.checked_by) from comp_settlement s where s.person_id=p.id and s.status in ('draft','checked','approved')) end,
   'leavingCase',(select c.id from lifecycle_case c where c.person_id=p.id and c.kind='leaving' and c.status='open' limit 1)
  )) row
  from person p join people_profile pp on pp.person_id=p.id left join comp_record r on r.person_id=p.id left join hr_employment e on e.person_id=p.id
  where p.org_id=current_org() and p.side='staff' and (p.status='active' or r.person_id is not null and r.status<>'ended' or r.end_on>=today-90
    or exists(select 1 from person_lifecycle l where l.person_id=p.id and l.stage in ('candidate','offer')))
   and not exists(select 1 from record_merge m where m.entity_type='person' and m.gone_id=p.id and m.undone_at is null)
   and (reader or hr_head(p.id)=me and p.id<>me)
 ) x;
 return jsonb_build_object('today',today,'people',out,'reader',reader,'writer',comp_writer(),'approver',comp_is_approver(me),'me',me,
  'policy',jsonb_build_object('approvers',pol.approvers,'managers',pol.managers,'currency',pol.currency,'remindDays',pol.remind_days));
end $$;

-- Everything about one person's pay, without amounts (comp_sealed / comp_figures / comp_letter_sealed give those).
create function pulse.comp_person(p_person uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); reader boolean:=comp_reader(); self boolean:=p_person=me; mgr boolean:=comp_manager_sees(p_person); r comp_record; e hr_employment;
 pol comp_policy:=comp_policy_row(); today date:=lifecycle_today();
begin
 if me is null or not (reader or self or mgr) then raise exception 'Pay is for founders, HR and the person' using errcode='42501'; end if;
 if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff') then raise exception 'Person not found' using errcode='P0002'; end if;
 perform comp_status_refresh(p_person);
 select * into r from comp_record where person_id=p_person;
 select * into e from hr_employment where org_id=current_org() and person_id=p_person;
 perform comp_log(p_person,'comp.record',case when self then 'self' when reader then 'record_view' else 'manager_view' end);
 return jsonb_strip_nulls(jsonb_build_object(
  'person',(select jsonb_build_object('id',p.id,'name',p.display_name,'role',pp.role,'pod',pp.pod,'department',pp.department,'joinedOn',pp.joined_on,'current',p.status='active',
    'stage',lifecycle_stage(p.id),'photoAt',(select ph.updated_at from person_photo ph where ph.person_id=p.id),'head',(select display_name from person where id=hr_head(p.id)))
    from person p left join people_profile pp on pp.person_id=p.id where p.id=p_person),
  'record',case when r.person_id is not null then jsonb_build_object('status',r.status,'since',r.status_since,'until',r.status_until,'startOn',r.start_on,'endOn',r.end_on,
    'confirmedOn',r.confirmed_on,'currency',r.currency) end,
  'employment',jsonb_build_object('probationFrom',e.probation_from,'probationTo',e.probation_to,'noticeFrom',e.notice_from,'lastWorkingDay',e.last_working_day,'payrollFrom',e.payroll_from),
  'versions',case when reader or self then (select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'status',c.status,'effectiveOn',c.effective_on,'payType',c.pay_type,'role',c.role,
     'reason',c.reason,'source',c.source,'correctsId',c.corrects_id,'beforeId',c.before_id,'proposedBy',(select display_name from person where id=c.proposed_by),'proposedById',c.proposed_by,
     'proposedAt',c.proposed_at,'decidedBy',(select display_name from person where id=c.decided_by),'decidedAt',c.decided_at,'decisionNote',c.decision_note,'letterId',c.letter_id,
     'inForce',c.id=(comp_in_force(p_person,today)).id) order by c.effective_on desc,c.created_at desc),'[]')
    from comp_change c where c.person_id=p_person and c.kind<>'offer' and (reader or c.status='approved')) end,
  'offers',case when reader or self then (select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'status',o.status,'role',o.role,'startOn',o.start_on,'probationDays',o.probation_days,
     'noticeDays',o.notice_days,'terms',o.terms,'validUntil',o.valid_until,'changeId',o.change_id,'payType',(select pay_type from comp_change where id=o.change_id),
     'taskId',o.task_id,'task',(select title from task where id=o.task_id),'proposedBy',(select display_name from person where id=o.proposed_by),'proposedById',o.proposed_by,
     'approvedBy',(select display_name from person where id=o.approved_by),'sentBy',(select display_name from person where id=o.sent_by),'sentAt',o.sent_at,'answeredAt',o.answered_at,
     'answerName',o.answer_name,'answerVia',o.answer_via,'closedNote',o.closed_note,'letterId',o.letter_id,
     'link',(select jsonb_build_object('expiresAt',k.expires_at,'openedAt',k.opened_at) from comp_offer_link k where k.offer_id=o.id and k.revoked_at is null order by k.created_at desc limit 1))
     order by o.created_at desc),'[]') from comp_offer o where o.person_id=p_person and (reader or o.status in ('sent','accepted','declined','expired'))) end,
  'probation',jsonb_build_object('reviews',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'kind',v.kind,'dueOn',v.due_on,'status',v.status,'note',case when reader or mgr then v.note end,
     'doneBy',(select display_name from person where id=v.done_by),'doneAt',v.done_at) order by v.due_on),'[]') from comp_probation_review v where v.person_id=p_person),
   'outcomes',(select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'action',b.action,'until',b.until_on,'note',b.note,'status',b.status,'proposedBy',(select display_name from person where id=b.proposed_by),
     'proposedById',b.proposed_by,'decidedBy',(select display_name from person where id=b.decided_by),'decidedAt',b.decided_at,'letterId',b.letter_id) order by b.proposed_at desc),'[]')
     from comp_probation b where b.person_id=p_person and (reader or b.status='approved'))),
  'pauses',(select coalesce(jsonb_agg(jsonb_build_object('id',z.id,'from',z.from_on,'to',z.to_on,'endedOn',z.ended_on,'paidPercent',z.paid_percent,'reasonKind',z.reason_kind,'note',z.note,
     'status',z.status,'proposedBy',(select display_name from person where id=z.proposed_by),'proposedById',z.proposed_by,'decidedBy',(select display_name from person where id=z.decided_by),
     'letterId',z.letter_id) order by z.from_on desc),'[]') from comp_pause z where z.person_id=p_person and (reader or z.status='approved')),
  'items',case when reader or self then (select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'status',i.status,'forMonth',i.for_month,'payout',i.payout,'reason',i.reason,'ref',i.ref,
     'recoverMonths',i.recover_months,'recoverFrom',i.recover_from,'proposedBy',(select display_name from person where id=i.proposed_by),'proposedById',i.proposed_by,
     'decidedBy',(select display_name from person where id=i.decided_by),'paidAt',i.paid_at) order by i.for_month desc,i.proposed_at desc),'[]')
     from comp_item i where i.person_id=p_person and (reader or i.status='approved')) end,
  'claims',case when reader or self then (select coalesce(jsonb_agg(jsonb_build_object('id',k.id,'category',k.category,'spentOn',k.spent_on,'vendor',k.vendor,'note',k.note,'status',k.status,
     'aboveThreshold',k.above_threshold,'head',(select display_name from person where id=k.head_id),'headBy',(select display_name from person where id=k.head_by),
     'decidedBy',(select display_name from person where id=k.decided_by),'decisionNote',k.decision_note,'payout',k.payout,'forMonth',k.for_month,'receiptMime',k.receipt_mime,
     'createdAt',k.created_at,'paidAt',k.paid_at) order by k.created_at desc),'[]') from comp_claim k where k.person_id=p_person) end,
  'settlement',case when reader or self then (select jsonb_build_object('id',s.id,'status',s.status,'exitKind',s.exit_kind,'lastDay',s.last_day,'noticeMode',s.notice_mode,'legal',s.legal,
     'note',s.note,'preparedBy',(select display_name from person where id=s.prepared_by),'checkedBy',(select display_name from person where id=s.checked_by),'checkedById',s.checked_by,
     'approvedBy',(select display_name from person where id=s.approved_by),'letterId',s.letter_id,'caseId',s.case_id)
     from comp_settlement s where s.person_id=p_person and s.status<>'withdrawn' and (reader or s.status='issued')) end,
  'leavingCase',(select jsonb_build_object('id',c.id,'effectiveOn',c.effective_on,'leftType',c.left_type,'settlement',(select result from lifecycle_step where case_id=c.id and key='settlement'))
     from lifecycle_case c where c.person_id=p_person and c.kind='leaving' and c.status in ('open','done') order by c.opened_at desc limit 1),
  'letters',case when reader or self then (select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'kind',l.kind,'title',l.title,'issuedAt',l.issued_at,'pages',l.pages,'sha256',l.sha256,
     'issuedBy',(select display_name from person where id=l.issued_by),'seenAt',l.seen_at) order by l.issued_at desc),'[]') from comp_letter l where l.person_id=p_person and (reader or comp_letter_visible(l))) end,
  'timeline',(select coalesce(jsonb_agg(jsonb_build_object('at',v.at,'kind',v.kind,'by',(select display_name from person where id=v.actor),'subjectType',v.subject_type,'subjectId',v.subject_id,'detail',v.detail) order by v.at desc),'[]')
     from (select * from comp_event v where v.person_id=p_person and (reader or v.kind in ('offer.sent','offer.accepted','offer.declined','offer.started','change.approved','letter.issued',
       'probation.confirm','probation.extend','probation.end','pause.approved','pause.ended','item.approved','claim.submitted','claim.approved','claim.rejected','settlement.issued','status.changed'))
       order by v.at desc limit 80) v),
  'can',jsonb_build_object('read',reader,'self',self,'manager',mgr,'propose',comp_writer() and not self,'approve',comp_is_approver(me) and not self,'claim',self),
  'policy',jsonb_build_object('approvers',pol.approvers,'probationApproval',pol.probation_approval,'probationDays',pol.probation_days,'offerDays',pol.offer_days,'currency',pol.currency,
    'noticeProbation',coalesce(pol.notice_probation,(select (config->>'probationDays')::int from hr_rule_version where org_id=current_org() and key='exit' and effective_from<=today order by effective_from desc,version desc limit 1),15),
    'noticeConfirmed',coalesce(pol.notice_confirmed,(select (config->>'confirmedDays')::int from hr_rule_version where org_id=current_org() and key='exit' and effective_from<=today order by effective_from desc,version desc limit 1),30),
    'encashBasis',pol.encash_basis,'encashDivisor',pol.encash_divisor,'dayBasis',pol.day_basis,'recoverMax',pol.recover_max,'components',pol.components),
  'today',today));
end $$;

-- The person's own pay ("My money" and /me/pay).
create function pulse.comp_me() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); pol comp_policy:=comp_policy_row();
begin
 if me is null then raise exception 'Sign in' using errcode='42501'; end if;
 return comp_person(me)||jsonb_build_object('categories',pol.claim_categories,'threshold',pol.claim_threshold,
  'approvals',(select count(*) from comp_claim k where k.org_id=current_org() and k.head_id=me and k.status='submitted'));
end $$;

-- Claims waiting for the viewer (as head, or as HR/founder for the second approval and the headless ones).
create function pulse.comp_claims_waiting() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); higher boolean:=comp_writer() or comp_is_approver(me);
begin
 if me is null then raise exception 'Sign in' using errcode='42501'; end if;
 perform comp_log(null,'comp.claim','claims_waiting');
 return (select coalesce(jsonb_agg(jsonb_build_object('id',k.id,'person',k.person_id,'name',p.display_name,'pod',pp.pod,'category',k.category,'spentOn',k.spent_on,'vendor',k.vendor,'note',k.note,
   'status',k.status,'aboveThreshold',k.above_threshold,'headBy',(select display_name from person where id=k.head_by),'receiptMime',k.receipt_mime,'createdAt',k.created_at) order by k.created_at),'[]')
  from comp_claim k join person p on p.id=k.person_id left join people_profile pp on pp.person_id=k.person_id
  where k.org_id=current_org() and k.person_id<>me and (k.status='submitted' and (k.head_id=me or higher and k.head_id is null or higher)
   or k.status='head_approved' and higher and k.head_by is distinct from me));
end $$;

-- ------------------------------------------------------------------------------------------------- 14. policy
create function pulse.comp_policy_read() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pol comp_policy:=comp_policy_row();
begin
 if current_viewer() is null then raise exception 'Sign in' using errcode='42501'; end if;
 return jsonb_build_object('approvers',pol.approvers,'probationApproval',pol.probation_approval,'managers',pol.managers,'currency',pol.currency,'probationDays',pol.probation_days,
  'remindDays',pol.remind_days,'noticeProbation',pol.notice_probation,'noticeConfirmed',pol.notice_confirmed,'offerDays',pol.offer_days,'dayBasis',pol.day_basis,
  'encashBasis',pol.encash_basis,'encashDivisor',pol.encash_divisor,'components',pol.components,'claimCategories',pol.claim_categories,'claimThreshold',pol.claim_threshold,
  'recoverMax',pol.recover_max,'letters',case when comp_reader() then pol.letters else '{}'::jsonb end,'updatedAt',pol.updated_at,
  'founders',case when comp_reader() then (select coalesce(jsonb_agg(jsonb_build_object('id',f,'name',comp_name(f)) order by comp_name(f)),'[]') from comp_founders() f) end,
  'foundersNamed',exists(select 1 from hr_cofounder where org_id=current_org() and active),
  'canEdit',comp_writer(),'canEditApprovers',comp_has_role(current_viewer(),'leadership') and comp_reader());
end $$;
create function pulse.comp_policy_save(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pol comp_policy:=comp_policy_row(); x jsonb;
begin
 if not comp_writer() then raise exception 'HR and founders set the pay policy' using errcode='42501'; end if;
 if (p ? 'approvers' and p->>'approvers' is distinct from pol.approvers or p ? 'probationApproval' and p->>'probationApproval' is distinct from pol.probation_approval)
  and not comp_has_role(current_viewer(),'leadership') then raise exception 'Leadership decides who approves pay' using errcode='42501'; end if;
 if p ? 'components' then
  if jsonb_typeof(p->'components')<>'array' then raise exception 'Components are a list' using errcode='22023'; end if;
  for x in select value from jsonb_array_elements(p->'components') loop
   if coalesce(x->>'key','') !~ '^[a-z][a-z0-9_]{0,30}$' or length(coalesce(x->>'label',''))<1 or coalesce(x->>'kind','') not in ('earning','employer','deduction') then
    raise exception 'Each component needs a key, a label and a kind' using errcode='22023'; end if;
  end loop;
 end if;
 if p ? 'claimCategories' then
  for x in select value from jsonb_array_elements(p->'claimCategories') loop
   if coalesce(x->>'key','') !~ '^[a-z][a-z0-9_]{0,30}$' or length(coalesce(x->>'label',''))<1 then raise exception 'Each category needs a key and a label' using errcode='22023'; end if;
  end loop;
 end if;
 update comp_policy set approvers=coalesce(p->>'approvers',approvers),probation_approval=coalesce(p->>'probationApproval',probation_approval),managers=coalesce(p->>'managers',managers),
  currency=coalesce(p->>'currency',currency),probation_days=coalesce((p->>'probationDays')::int,probation_days),remind_days=coalesce((p->>'remindDays')::int,remind_days),
  notice_probation=case when p ? 'noticeProbation' then nullif(p->>'noticeProbation','')::int else notice_probation end,
  notice_confirmed=case when p ? 'noticeConfirmed' then nullif(p->>'noticeConfirmed','')::int else notice_confirmed end,
  offer_days=coalesce((p->>'offerDays')::int,offer_days),day_basis=coalesce(p->>'dayBasis',day_basis),encash_basis=coalesce(p->>'encashBasis',encash_basis),
  encash_divisor=coalesce((p->>'encashDivisor')::int,encash_divisor),components=coalesce(p->'components',components),claim_categories=coalesce(p->'claimCategories',claim_categories),
  claim_threshold=case when p ? 'claimThreshold' then nullif(p->>'claimThreshold','')::numeric else claim_threshold end,recover_max=coalesce((p->>'recoverMax')::int,recover_max),
  letters=coalesce(p->'letters',letters),updated_by=current_viewer(),updated_at=now()
 where org_id=current_org();
 return comp_policy_read();
end $$;

-- ------------------------------------------------------------------------------------- 15. set up and imports
-- "Set up from salary records": the latest imported monthly figure becomes the first version (no letter: nothing
-- changes). The API reads the row through hr_salary_components_read (logged) and seals it.
create function pulse.comp_setup_start(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); v_person uuid:=nullif(p->>'person','')::uuid; v_ref uuid:=nullif(p->>'importRef','')::uuid; v_id uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid()); v_on date:=nullif(p->>'effectiveOn','')::date;
begin
 if not comp_writer() then raise exception 'HR sets up pay records' using errcode='42501'; end if;
 if v_person is null or v_person=me then raise exception 'Someone else sets up your own pay' using errcode='42501'; end if;
 if v_ref is null or not exists(select 1 from pulse_priv.hr_compensation h where h.org_id=current_org() and h.id=v_ref and h.person_id=v_person) then
  raise exception 'Choose a salary record of this person' using errcode='22023'; end if;
 if exists(select 1 from comp_change where person_id=v_person and status='approved') then raise exception 'This person''s pay is set up already: change it instead' using errcode='22023'; end if;
 perform comp_sealed_check(p->'sealed');
 perform comp_record_ensure(v_person);
 insert into comp_change(org_id,id,person_id,kind,status,effective_on,pay_type,role,reason,source,import_ref,s_kid,s_key,s_data,proposed_by,proposed_at,decided_by,decided_at,created_by)
 values(current_org(),v_id,v_person,'start','approved',v_on,coalesce(p->>'payType','salary'),(select role from people_profile where person_id=v_person),
  'Set up from the salary records',  'import',v_ref,p->'sealed'->>'kid',decode(p->'sealed'->>'key','base64'),decode(p->'sealed'->>'data','base64'),me,now(),null,now(),me);
 update comp_record set start_on=coalesce(start_on,(select joined_on from people_profile where person_id=v_person),v_on),
  confirmed_on=coalesce(confirmed_on,case when not exists(select 1 from hr_employment e where e.person_id=v_person and e.probation_to>=lifecycle_today()) then v_on end) where person_id=v_person;
 perform comp_log(v_person,'comp.pay','setup_from_records');
 perform comp_event_add(v_person,'record.set_up','change',v_id,jsonb_build_object('from','salary records','effectiveOn',v_on));
 perform comp_status_refresh(v_person);
 return v_id;
end $$;

-- The release's one-time conversion (the worker login, no viewer): a person's imported rows become their record —
-- settled history as approved versions, a proposed salary as an offer for founders to review. Notifies nobody.
create function pulse.comp_import(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_person uuid:=(p->>'person')::uuid; x jsonb; v_offer uuid; v_change uuid; done jsonb:='[]'; pol comp_policy:=comp_policy_row();
begin
 if current_viewer() is not null then raise exception 'The import runs as Pulse, not as a person' using errcode='42501'; end if;
 if not exists(select 1 from person where org_id=current_org() and id=v_person and side='staff') then raise exception 'Person not found' using errcode='P0002'; end if;
 insert into comp_record(org_id,person_id,currency) values(current_org(),v_person,pol.currency) on conflict do nothing;
 for x in select value from jsonb_array_elements(coalesce(p->'versions','[]')) loop
  if exists(select 1 from comp_change where person_id=v_person and import_ref=(x->>'importRef')::uuid) then continue; end if;
  perform comp_sealed_check(x->'sealed');
  insert into comp_change(org_id,id,person_id,kind,status,effective_on,pay_type,role,reason,source,import_ref,s_kid,s_key,s_data,decided_at)
  values(current_org(),coalesce(nullif(x->>'id','')::uuid,gen_random_uuid()),v_person,'start','approved',(x->>'effectiveOn')::date,x->>'payType',nullif(x->>'role',''),x->>'reason','import',(x->>'importRef')::uuid,
   x->'sealed'->>'kid',decode(x->'sealed'->>'key','base64'),decode(x->'sealed'->>'data','base64'),now()) returning id into v_change;
  update comp_record set start_on=coalesce(start_on,(x->>'effectiveOn')::date) where person_id=v_person;
  perform comp_event_add(v_person,'record.imported','change',v_change,jsonb_build_object('payType',x->>'payType','effectiveOn',x->>'effectiveOn'));
  done:=done||jsonb_build_object('version',v_change);
 end loop;
 x:=p->'offer';
 if x is not null and not exists(select 1 from comp_change where person_id=v_person and kind='offer' and import_ref=(x->>'importRef')::uuid) then
  perform comp_sealed_check(x->'sealed');
  insert into comp_change(org_id,id,person_id,kind,status,effective_on,pay_type,role,reason,source,import_ref,s_kid,s_key,s_data,proposed_at)
  values(current_org(),coalesce(nullif(x->>'changeId','')::uuid,gen_random_uuid()),v_person,'offer','proposed',(x->>'startOn')::date,x->>'payType',x->>'role',x->>'reason','import',(x->>'importRef')::uuid,
   x->'sealed'->>'kid',decode(x->'sealed'->>'key','base64'),decode(x->'sealed'->>'data','base64'),now()) returning id into v_change;
  insert into comp_offer(org_id,person_id,change_id,status,role,start_on,probation_days,notice_days,terms,valid_until,proposed_at,task_id)
  values(current_org(),v_person,v_change,'proposed',x->>'role',(x->>'startOn')::date,coalesce((x->>'probationDays')::int,pol.probation_days),nullif(x->>'noticeDays','')::int,
   x->>'terms',coalesce(nullif(x->>'validUntil','')::date,lifecycle_today()+pol.offer_days),now(),nullif(x->>'taskId','')::uuid) returning id into v_offer;
  perform comp_event_add(v_person,'offer.imported','offer',v_offer,jsonb_build_object('startOn',x->>'startOn','role',x->>'role'));
  if nullif(x->>'taskId','') is not null then
   insert into task_companion(org_id,task_id,target,confirmed_at) values(current_org(),(x->>'taskId')::uuid,'people.pay',now())
   on conflict(task_id) do update set confirmed_at=coalesce(task_companion.confirmed_at,excluded.confirmed_at),updated_at=now();
   insert into task_signal(org_id,task_id,position,event,label,cond,need,since)
   values(current_org(),(x->>'taskId')::uuid,0,'comp.offer.sent','The offer is sent from People & pay',jsonb_build_object('offer_id',jsonb_build_object('eq',v_offer::text)),1,now());
  end if;
  done:=done||jsonb_build_object('offer',v_offer);
 end if;
 perform comp_status_refresh(v_person);
 return jsonb_build_object('person',v_person,'done',done);
end $$;

-- ---------------------------------------------------------------------------------------------- 16. the tick
-- Once a minute (pulse_workers.notifications): offers past their date expire; accepted offers start on their day;
-- scheduled role changes apply; probation reviews are planned and the manager and HR are told once each; statuses
-- whose dates passed are refreshed.
create function pulse.comp_tick() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare today date:=lifecycle_today(); o comp_offer; c comp_change; v comp_probation_review; n_exp int:=0; n_start int:=0; n_rem int:=0; n_ref int:=0; h uuid; who uuid;
begin
 for o in select * from comp_offer where org_id=current_org() and status='sent' and valid_until<today for update skip locked loop
  update comp_offer set status='expired',updated_at=now() where id=o.id;
  update comp_change set status='withdrawn',updated_at=now() where id=o.change_id;
  update comp_offer_link set revoked_at=now() where offer_id=o.id and revoked_at is null and decided_at is null;
  perform comp_event_add(o.person_id,'offer.expired','offer',o.id,'{}');
  perform comp_emit(o.sent_by,'comp.decided',o.person_id,'offer:'||o.id||':expired','The offer to '||comp_name(o.person_id)||' expired unanswered','/people/pay/'||o.person_id);
  n_exp:=n_exp+1;
 end loop;
 for o in select * from comp_offer where org_id=current_org() and status='accepted' and started_at is null and start_on<=today loop
  perform comp_start(o.id); n_start:=n_start+1;
 end loop;
 for c in select * from comp_change where org_id=current_org() and status='approved' and role is not null and role_applied_at is null and effective_on<=today and kind<>'offer' loop
  update people_profile set role=c.role,updated_at=now() where person_id=c.person_id and role is distinct from c.role;
  update comp_change set role_applied_at=now() where id=c.id;
 end loop;
 perform comp_reviews_plan(r.person_id) from comp_record r join hr_employment e on e.person_id=r.person_id
  where r.org_id=current_org() and r.status='probation' and not exists(select 1 from comp_probation_review x where x.person_id=r.person_id and x.kind='final' and x.status='due');
 for v in select x.* from comp_probation_review x join comp_record r on r.person_id=x.person_id where x.org_id=current_org() and x.status='due' and x.reminded_at is null
   and x.due_on<=today and r.status='probation' loop
  h:=hr_head(v.person_id);
  if h is not null and h<>v.person_id then
   perform comp_emit(h,'comp.probation',v.person_id,'review:'||v.id,case v.kind when 'final' then 'Probation for '||comp_name(v.person_id)||' ends soon: write your review'
     else 'Probation review for '||comp_name(v.person_id)||' is due' end,'/people/pay/'||v.person_id);
  end if;
  for who in select distinct r.person_id from role_assignment r where r.org_id=current_org() and r.role_key='hr' and current_date between r.valid_from and coalesce(r.valid_to,'infinity')
    and r.person_id<>v.person_id loop
   perform comp_emit(who,'comp.probation',v.person_id,'review:'||v.id,case v.kind when 'final' then 'Probation for '||comp_name(v.person_id)||' ends on '||
     to_char((select probation_to from hr_employment where person_id=v.person_id),'FMDD Mon')||': confirm, extend or end it' else 'Probation review for '||comp_name(v.person_id)||' is due' end,'/people/pay/'||v.person_id);
  end loop;
  update comp_probation_review set reminded_at=now() where id=v.id;
  n_rem:=n_rem+1;
 end loop;
 for h in select r.person_id from comp_record r where r.org_id=current_org() and (r.refreshed_on is null or r.refreshed_on<today or r.status_until<today) loop
  perform comp_status_refresh(h); n_ref:=n_ref+1;
 end loop;
 return jsonb_build_object('expired',n_exp,'started',n_start,'reminded',n_rem,'refreshed',n_ref);
end $$;

-- --------------------------------------------------------------------------------- 17. notices and payroll
select pulse.check_values_add('pulse.notification'::regclass,'notification_event_type_check','event_type',
 array['comp.waiting','comp.decided','comp.letter','comp.claim','comp.offer','comp.probation']);
do $$
declare definition text; a text; b text;
begin
 -- Edits in place (as 0211 did): each expected text must be there exactly once, else the migration stops.
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 a:=$r$ if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active') then return false;end if;$r$;
 b:=a||$r$
 -- COMP-A: pay notices name the person the pay is about; who may hear each is decided by comp_notice_allowed.
 if p_type like 'comp.%' then return p_subject='person' and comp_notice_allowed(p_person,p_type,p_id); end if;$r$;
 if position(a in definition)=0 then raise exception 'migration 0440: notification_recipient_allowed changed shape'; end if;
 execute replace(definition,a,b);
 -- Payroll respects pauses: the payslip projection pays paused days at their paid share.
 definition:=pg_get_functiondef('pulse.hr_payslip_source(uuid,date)'::regprocedure);
 a:=$r$ else s.amount end;$r$;
 if position(a in definition)=0 then raise exception 'migration 0440: hr_payslip_source changed shape (gross)'; end if;
 definition:=replace(definition,a,a||$r$
 gross:=round(gross*comp_pause_factor(p_person,p_month),2);$r$);
 a:=$r$'sourceId',s.id);$r$;
 if position(a in definition)=0 then raise exception 'migration 0440: hr_payslip_source changed shape (source)'; end if;
 execute replace(definition,a,$r$'sourceId',s.id,'payShare',comp_pause_factor(p_person,p_month));$r$);
end $$;

-- ------------------------------------------------------------------------------------------------- 18. grants
do $$ declare f text; begin
 for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pulse' and p.proname like 'comp\_%' loop
  execute format('revoke all on function %s from public',f);
 end loop;
end $$;
grant execute on function pulse.comp_reader(), pulse.comp_writer(), pulse.comp_is_approver(uuid), pulse.comp_can_see(uuid), pulse.comp_policy_read(), pulse.comp_policy_save(jsonb),
 pulse.comp_people(), pulse.comp_person(uuid), pulse.comp_me(), pulse.comp_claims_waiting(), pulse.comp_figures(uuid[],date), pulse.comp_sealed(text,uuid),
 pulse.comp_month_sealed(date), pulse.comp_letter_sealed(uuid,text), pulse.comp_letter_add(jsonb), pulse.comp_history_sealed(uuid), pulse.comp_letterhead(),
 pulse.comp_letter_asset(text), pulse.comp_owner(text,uuid),
 pulse.comp_change_save(jsonb), pulse.comp_change_decide(uuid,text,text), pulse.comp_change_withdraw(uuid), pulse.comp_arrears_add(uuid,jsonb),
 pulse.comp_offer_save(jsonb), pulse.comp_offer_propose(uuid), pulse.comp_offer_decide(uuid,text,text), pulse.comp_offer_send(uuid,text), pulse.comp_offer_withdraw(uuid,text),
 pulse.comp_offer_answer(uuid,text,text,text), pulse.comp_offer_open(text), pulse.comp_offer_link_answer(text,text,text,text,text,text), pulse.comp_offer_link_letter(text),
 pulse.comp_offer_task(uuid,uuid), pulse.comp_probation_propose(uuid,jsonb), pulse.comp_probation_decide(uuid,text,text), pulse.comp_review_done(uuid,text),
 pulse.comp_pause_save(jsonb), pulse.comp_pause_decide(uuid,text,text), pulse.comp_pause_close(uuid,text,date),
 pulse.comp_item_save(jsonb), pulse.comp_item_decide(uuid,text,text), pulse.comp_claim_submit(jsonb), pulse.comp_claim_decide(uuid,text,text),
 pulse.comp_settlement_save(jsonb), pulse.comp_settlement_step(uuid,text,text), pulse.comp_setup_start(jsonb) to pulse_api;
grant execute on function pulse.comp_tick(), pulse.comp_import(jsonb), pulse.comp_status_refresh(uuid), pulse.comp_pause_factor(uuid,date) to pulse_worker;
-- notification_recipient_allowed and hr_payslip_source run as their owner; comp_notice_allowed and comp_pause_factor too.

-- migrate:down
-- Forward-only.
