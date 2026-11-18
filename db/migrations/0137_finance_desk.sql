-- migrate:up
-- RF1: finance registers and evidence, never a second general ledger.
create table pulse_priv.accountant_access (
 org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),
 expires_on date not null,revoked_at timestamptz,granted_by uuid not null references pulse.person(id),
 primary key(org_id,person_id)
);
create table pulse_priv.finance_desk_record (
 org_id uuid not null references pulse.org(id),kind text not null check(kind in
 ('purchase','sales','bank','payroll','reimbursement','vendor','close','exception','reminder','brief','zoho')),
 key text not null,body jsonb not null,synthetic boolean not null default true,
 created_at timestamptz not null default now(),primary key(org_id,synthetic,kind,key)
);
create table pulse_priv.finance_desk_file (
 org_id uuid not null references pulse.org(id),key text not null,name text not null,mime text not null
 check(mime in ('application/pdf','text/csv','application/zip')),bytes bytea not null
 check(octet_length(bytes)<=10485760),synthetic boolean not null default true,primary key(org_id,synthetic,key)
);
create unique index finance_desk_mail_once on pulse_priv.finance_desk_record
 (org_id,synthetic,(body->'source'->>'mailbox'),(body->'source'->>'message'),(body->'source'->>'attachment'))
 where kind in ('purchase','sales') and body ? 'source';
create table pulse_priv.finance_desk_send (
 org_id uuid not null references pulse.org(id),close_key text not null,approved_by uuid not null references pulse.person(id),
 approved_at timestamptz not null default now(),status text not null check(status in ('sending','sent','uncertain','sink')),
 synthetic boolean not null,primary key(org_id,synthetic,close_key)
);
-- A curated financial projection preserves the HR tables' existing restrictive policies.
create table pulse_priv.finance_desk_payroll (
 org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),
 month date not null,kind text not null,source_id uuid not null,body jsonb not null,
 primary key(org_id,person_id,month,kind)
);
do $$ declare t text;begin
 foreach t in array array['accountant_access','finance_desk_record','finance_desk_file','finance_desk_send','finance_desk_payroll'] loop
 execute format('alter table pulse_priv.%I enable row level security',t);
 execute format('alter table pulse_priv.%I force row level security',t);
 execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('create trigger audit_mutation after insert or update or delete on pulse_priv.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;
grant select,insert on pulse_priv.finance_desk_record,pulse_priv.finance_desk_file to pulse_worker;
grant select,insert,update on pulse_priv.finance_desk_payroll to pulse_worker;
-- A session issued before enrollment cannot acquire accountant access merely by enrolling later.
alter table pulse.login_session add column second_factor_verified boolean not null default false;
revoke insert,update on pulse.login_session from pulse_api;
grant insert(org_id,token_hash,person_id,created_at,expires_at,revoked_at,id,device,last_active_at,remembered,native_device_id),
 update(revoked_at,last_active_at) on pulse.login_session to pulse_api;
create or replace function pulse.auth_challenge_finish(r text,h text,code text,session_hash text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare ch pulse_priv.auth_challenge%rowtype; result jsonb;
begin
 select actor into ch.actor from pulse_priv.auth_challenge where org_id=current_org() and realm=r and hash=h;
 if ch.actor is not null then perform auth_lock(r,ch.actor);end if;
 select * into ch from pulse_priv.auth_challenge where org_id=current_org() and realm=r and hash=h and expires_at>now() and used_at is null for update;
 if not found then return null;end if;
 if not auth_allow('otp:'||r||':'||ch.actor,5) or not auth_otp(r,ch.actor,code) then perform auth_event_add(r,ch.actor,'two_step_failed');return null;end if;
 update pulse_priv.auth_challenge set used_at=now() where hash=h;
 result:=auth_session(r,ch.actor,session_hash,ch.remember,ch.device);
 if r='staff' and result is not null then
 update login_session set second_factor_verified=true where org_id=current_org() and person_id=ch.actor and token_hash=session_hash;
 end if;
 return result||jsonb_build_object('actor',ch.actor,'delivery',auth_delivery(r,ch.actor));
end $$;
-- Membership persists after expiry/revocation so the API never falls back to an unrestricted employee role.
create function pulse.is_accountant(a uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from pulse_priv.accountant_access where org_id=current_org() and person_id=a)
$$;
create function pulse.finance_desk_authorize(w boolean default false) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if is_accountant(current_viewer()) then
  if w or not exists(select 1 from pulse_priv.accountant_access a join person p on p.org_id=a.org_id and p.id=a.person_id
   join login_session s on s.org_id=a.org_id and s.person_id=a.person_id
   join pulse_priv.auth_account ac on ac.org_id=a.org_id and ac.realm='staff' and ac.actor=a.person_id
   where a.org_id=current_org() and a.person_id=current_viewer() and p.status='active' and a.revoked_at is null
   and a.expires_on>=(now() at time zone 'Asia/Kolkata')::date and ac.totp is not null and s.second_factor_verified and s.revoked_at is null
   and s.expires_at>now() and s.token_hash=current_setting('pulse.session_hash',true)) then
   raise exception 'Accountant access requires unexpired membership and a two-step session' using errcode='42501';
  end if;
 else perform finance_authorize(w);end if;
end $$;
create function pulse.accountant_grant(a uuid,expiry date,revoke boolean default false) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'Admin required' using errcode='42501';end if;
 if revoke then
 update pulse_priv.accountant_access set revoked_at=now() where org_id=current_org() and person_id=a;
 perform auth_end_sessions('staff',a);perform audit_write('accountant_revoked','finance.accountant',a::text);return;
 end if;
 if expiry is null or expiry<(now() at time zone 'Asia/Kolkata')::date or not exists(select 1 from person p join people_profile pp on pp.person_id=p.id
  where p.org_id=current_org() and p.id=a and p.status='active' and p.side='staff')
  or exists(select 1 from role_assignment where org_id=current_org() and person_id=a and current_date between valid_from and coalesce(valid_to,'infinity'))
 then raise exception 'Choose an active invited person without another role and a future expiry' using errcode='22023';end if;
 insert into pulse_priv.accountant_access(org_id,person_id,expires_on,revoked_at,granted_by)
 values(current_org(),a,expiry,case when revoke then now() end,current_viewer())
 on conflict(org_id,person_id) do update set expires_on=excluded.expires_on,revoked_at=excluded.revoked_at,granted_by=excluded.granted_by;
 perform auth_end_sessions('staff',a);perform audit_write('accountant_access','finance.accountant',a::text);
end $$;
create function pulse.finance_desk_payroll_rows() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('kind','payroll','key',source_id,'body',body)),'[]')
 from pulse_priv.finance_desk_payroll where org_id=current_org()
$$;
revoke all on function pulse.finance_desk_payroll_rows() from public;
create function pulse.finance_desk_state(synthetic_mode boolean default false) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb;payroll jsonb;
begin
 perform finance_desk_authorize();perform audit_write('restricted_read','finance.desk');
 result:=jsonb_build_object('records',coalesce((select jsonb_agg(jsonb_build_object('kind',kind,'key',key,'body',body,'at',created_at) order by created_at,key)
 from pulse_priv.finance_desk_record where org_id=current_org() and synthetic=synthetic_mode and
 (not is_accountant(current_viewer()) or kind in ('purchase','sales','payroll','reimbursement','vendor','close','exception'))),'[]'),
 'files',coalesce((select jsonb_agg(jsonb_build_object('key',key,'name',name,'mime',mime)) from pulse_priv.finance_desk_file
 where org_id=current_org() and synthetic=synthetic_mode),'[]'),
 'sends',coalesce((select jsonb_agg(jsonb_build_object('key',close_key,'status',status)) from pulse_priv.finance_desk_send where org_id=current_org() and synthetic=synthetic_mode),'[]'));
 -- Accountant gets financial payroll fields only. No attendance, HR case, contact, note or identity-document fields.
 if not synthetic_mode then
 payroll:=finance_desk_payroll_rows();
 result:=jsonb_set(result,'{records}',(result->'records')||payroll);
 end if;
 return result;
end $$;
create function pulse.finance_desk_file_get(k text,synthetic_mode boolean default false) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform finance_desk_authorize();perform audit_write('restricted_read','finance.evidence',k);
 return (select jsonb_build_object('name',name,'mime',mime,'data',encode(bytes,'base64')) from pulse_priv.finance_desk_file where org_id=current_org() and key=k and synthetic=synthetic_mode);
end $$;
create function pulse.finance_desk_send_claim(k text,synthetic_mode boolean default false) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb;
begin
 perform finance_desk_authorize(true);
 if not hr_is_cofounder(current_viewer()) then raise exception 'Founder approval required' using errcode='42501';end if;
 select body||jsonb_build_object('synthetic',synthetic) into result from pulse_priv.finance_desk_record where org_id=current_org() and kind='close' and key=k and synthetic=synthetic_mode;
 if result is null then raise exception 'Close pack unavailable' using errcode='22023';end if;
 if not synthetic_mode and (result->>'to' is distinct from 'user-7b81126a@gmail.com' or not exists(
 select 1 from pulse_priv.finance_desk_file where org_id=current_org() and key=result->>'packKey' and not synthetic)) then
 raise exception 'Review the CA recipient and complete close evidence before approval' using errcode='22023';end if;
 insert into pulse_priv.finance_desk_send(org_id,close_key,approved_by,status,synthetic) values(current_org(),k,current_viewer(),'sending',synthetic_mode);
 perform audit_write('founder_send_approved','finance.close',k);return result;
end $$;
create function pulse.finance_desk_send_finish(k text,outcome text,synthetic_mode boolean default false) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform finance_desk_authorize(true);
 if outcome not in ('sent','uncertain','sink') then raise exception 'Invalid delivery outcome' using errcode='22023';end if;
 update pulse_priv.finance_desk_send set status=outcome where org_id=current_org() and close_key=k and approved_by=current_viewer() and status='sending' and synthetic=synthetic_mode;
end $$;
revoke all on function pulse.is_accountant(uuid),pulse.finance_desk_authorize(boolean),pulse.accountant_grant(uuid,date,boolean),pulse.finance_desk_state(boolean),pulse.finance_desk_file_get(text,boolean),pulse.finance_desk_send_claim(text,boolean),pulse.finance_desk_send_finish(text,text,boolean) from public;
grant execute on function pulse.is_accountant(uuid),pulse.finance_desk_authorize(boolean),pulse.accountant_grant(uuid,date,boolean),pulse.finance_desk_state(boolean),pulse.finance_desk_file_get(text,boolean),pulse.finance_desk_send_claim(text,boolean),pulse.finance_desk_send_finish(text,text,boolean) to pulse_api;
-- The existing released notification worker schedules RF1. No new transport or external mail scheduler.
create function pulse.finance_desk_snapshot(p_at timestamptz default clock_timestamp()) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare day date:=(p_at at time zone 'Asia/Kolkata')::date;money_in jsonb;money_out jsonb;
begin
 select jsonb_object_agg(currency,amount) into money_in from (
 select s.body->>'currency' currency,sum((s.body->>'minor')::numeric/power(10,(s.body->>'scale')::int)) amount
 from pulse_priv.finance_source s where s.org_id=current_org() and s.body->>'kind'='cash' and s.body->>'cashDate'=day::text
 and s.body->>'direction'='inflow' and exists(select 1 from pulse_priv.finance_allocation a join pulse_priv.finance_decision d on d.org_id=a.org_id and d.id=a.decision_id
 where a.org_id=s.org_id and a.source_id=s.id and a.role='cash' and a.active and d.active and d.body->>'treatment'<>'transfer') group by s.body->>'currency') totals;
 select jsonb_object_agg(currency,amount) into money_out from (
 select s.body->>'currency' currency,sum((s.body->>'minor')::numeric/power(10,(s.body->>'scale')::int)) amount
 from pulse_priv.finance_source s where s.org_id=current_org() and s.body->>'kind'='cash' and s.body->>'cashDate'=day::text
 and s.body->>'direction'='outflow' and exists(select 1 from pulse_priv.finance_allocation a join pulse_priv.finance_decision d on d.org_id=a.org_id and d.id=a.decision_id
 where a.org_id=s.org_id and a.source_id=s.id and a.role='cash' and a.active and d.active and d.body->>'treatment'<>'transfer') group by s.body->>'currency') totals;
 return jsonb_build_object('records',coalesce((select jsonb_agg(jsonb_build_object('kind',kind,'key',key,'body',body))
 from pulse_priv.finance_desk_record where org_id=current_org() and not synthetic),'[]')||finance_desk_payroll_rows(),
 'founders',coalesce((select jsonb_agg(p.id) from person p where p.org_id=current_org() and p.status='active' and hr_is_cofounder(p.id) and not is_accountant(p.id)),'[]'),
 'facts',jsonb_build_object('deliveries',(select count(*) from delivery where org_id=current_org() and (delivered_at at time zone 'Asia/Kolkata')::date=day),
 'whoWorked',coalesce((select jsonb_agg(display_name) from person p where p.org_id=current_org() and exists(select 1 from attendance_entry a
 where a.org_id=p.org_id and a.person_id=p.id and a.work_date=day and a.voided_at is null)),'[]'),
 'moneyIn',money_in,'moneyOut',money_out,'openApprovals',
 (select count(*) from hr_flow where org_id=current_org() and status='pending')+(select count(*) from pulse_priv.finance_desk_record r
 where r.org_id=current_org() and r.kind='close' and not r.synthetic and not exists(select 1 from pulse_priv.finance_desk_send s where s.org_id=r.org_id and s.close_key=r.key and not s.synthetic and s.status='sent')),
 'risks',jsonb_build_array('Money covers reconciled uploaded statements only; missing movements are unknown',
 'Worked names are attendance evidence, not a claim about hours or productivity',
 'Live finance mail and Zoho activation await owner setup')));
end $$;
create function pulse.finance_desk_notify(p_person uuid,p_key text,p_title text,p_href text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;
begin
 if not hr_is_cofounder(p_person) or is_accountant(p_person) then return null;end if;
 nid:=notification_emit(p_person,'update.self','person',p_person,'rf1:'||p_key,p_title,p_href,'update',false);
 -- Internal founder copy only. Never seed the email outbox for RF1 notices.
 if nid is not null then update notification set telegram_status=case when exists(select 1 from pulse_priv.telegram_person
 where org_id=current_org() and person_id=p_person) then 'queued' else 'recipient_not_connected' end where id=nid;end if;
 return nid;
end $$;
create or replace function pulse.notification_authorized(p_id uuid,p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from notification n where n.org_id=current_org() and n.id=p_id and n.person_id=p_person
 and notification_recipient_allowed(p_person,n.event_type,n.subject_type,coalesce(n.subject_id,n.person_id))
 and (n.channel_id is null or notification_chat_member_current(n.channel_id,p_person))
 and (n.href not like '/settings%' or exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p_person and r.role_key in ('admin','leadership') and current_date between r.valid_from and coalesce(r.valid_to,'infinity')))
 and (n.href not like '/hr%' or hr_is_staff(p_person))
 and (n.href not like '/finance/desk%' or (hr_is_cofounder(p_person) and not is_accountant(p_person)))
 and (n.href !~ '^/people/[0-9a-f-]{36}$' or hr_is_staff(p_person) or hr_head(substring(n.href from '[0-9a-f-]{36}$')::uuid)=p_person or substring(n.href from '[0-9a-f-]{36}$')::uuid=p_person))
$$;
revoke all on function pulse.finance_desk_snapshot(timestamptz),pulse.finance_desk_notify(uuid,text,text,text) from public;
grant execute on function pulse.finance_desk_snapshot(timestamptz),pulse.finance_desk_notify(uuid,text,text,text) to pulse_worker;
create function pulse.finance_desk_fixture_refresh() returns void language sql security definer set search_path=pulse,pg_temp as $$
 delete from pulse_priv.finance_desk_record where org_id=current_org() and synthetic and kind in ('vendor','exception')
$$;
revoke all on function pulse.finance_desk_fixture_refresh() from public;
grant execute on function pulse.finance_desk_fixture_refresh() to pulse_worker;
-- migrate:down
-- Access and evidence are retained; forward-only security migration.
