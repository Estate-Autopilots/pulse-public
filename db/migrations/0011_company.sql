-- migrate:up
-- Source observations remain distinct; private money is reachable only through permission-checked, audited functions.
create table pulse.audit_event (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 actor_id uuid, actor_account text, action text not null, resource text not null, resource_id text,
 fields text[] not null default '{}', source text not null default 'pulse', at timestamptz not null default now()
);
create index audit_event_time on pulse.audit_event(org_id,at desc);
create table pulse.import_batch (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 dataset text not null, sha256 text not null, row_count int not null, imported_at timestamptz not null default now(),
 unique(org_id,dataset,sha256)
);
create table pulse.source_observation (
 org_id uuid not null references pulse.org(id), dataset text not null, source_key text not null,
 payload jsonb not null, evidence jsonb not null default '{}', import_id uuid references pulse.import_batch(id),
 primary key(org_id,dataset,source_key)
);
alter table pulse.task alter column id set default gen_random_uuid();
alter table pulse.task drop constraint task_status_check;
alter table pulse.task add constraint task_status_check check(status in ('unknown','open','in_progress','blocked','in_review','done','cancelled'));
alter table pulse.task add column source_key text, add column owner_id uuid references pulse.person(id),
 add column owner_label text, add column owner_role text, add column project_key text, add column due_label text,
 add column source_period text, add column confidence numeric, add column evidence jsonb not null default '{}',
 add column locked text[] not null default '{}', add column edited_by uuid references pulse.person(id),
 add column updated_at timestamptz not null default now(), add column source_status text;
create unique index task_source_key on pulse.task(org_id,source_key);
create table pulse.activity_observation (
 org_id uuid not null references pulse.org(id), source_key text not null, at timestamptz, operation text,
 file_id text, project_id uuid references pulse.project(id), project_key text, actor_account text,
 actor_id uuid references pulse.person(id), actor_label text, actor_kind text, human_attribution text,
 confidence numeric, basis text, evidence jsonb not null default '{}', primary key(org_id,source_key)
);
create index activity_person on pulse.activity_observation(org_id,actor_id,at desc);
create index activity_file on pulse.activity_observation(org_id,file_id,operation);
create table pulse.review_item (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(), source_key text not null,
 kind text not null, entity_type text, entity_id uuid, title text not null, proposed jsonb not null default '{}',
 confidence numeric, evidence jsonb not null default '{}', status text not null default 'pending' check(status in ('pending','accepted','dismissed')),
 decided_by uuid references pulse.person(id), decided_at timestamptz, unique(org_id,source_key)
);
create table pulse.record_link (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(), entity_type text not null,
 entity_id uuid not null, kind text not null, label text not null, value text not null,
 edited_by uuid references pulse.person(id), updated_at timestamptz not null default now()
);
create table pulse.record_merge (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(), entity_type text not null,
 keep_id uuid not null, gone_id uuid not null, moved jsonb not null, previous_status text,
 merged_by uuid references pulse.person(id), merged_at timestamptz not null default now(), undone_at timestamptz
);
create unique index merge_active on pulse.record_merge(org_id,entity_type,gone_id) where undone_at is null;
create table pulse.file_correction (
 org_id uuid not null references pulse.org(id), file_id text not null, display_name text,
 project_id uuid references pulse.project(id), wrong_reason text,
 edited_by uuid references pulse.person(id), updated_at timestamptz not null default now(), primary key(org_id,file_id)
);
create table pulse.record_annotation (
 org_id uuid not null references pulse.org(id), entity_type text not null, entity_id uuid not null,
 address text, wrong_reason text, edited_by uuid references pulse.person(id), updated_at timestamptz not null default now(),
 primary key(org_id,entity_type,entity_id)
);
create table pulse.hr_month_history (
 org_id uuid not null references pulse.org(id), source_key text not null, person_id uuid references pulse.person(id),
 person_label text not null, month_label text not null, month date, leave_days numeric, wfh_days numeric, half_days numeric,
 attendance_dates text, confidence numeric, basis text, evidence jsonb not null default '{}', primary key(org_id,source_key)
);
create table pulse.shift (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(), name text not null,
 start_time time not null, end_time time not null, grace_minutes int not null default 15 check(grace_minutes between 0 and 240),
 work_days int[] not null default '{1,2,3,4,5,6}', unique(org_id,name)
);
create table pulse.person_shift (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(), person_id uuid not null references pulse.person(id),
 shift_id uuid not null references pulse.shift(id), mode text not null default 'office' check(mode in ('office','wfh','field')),
 valid_from date not null, valid_to date, check(valid_to is null or valid_to>=valid_from)
);
create table pulse.notification (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(), person_id uuid not null references pulse.person(id),
 title text not null, href text not null, read_at timestamptz, created_at timestamptz not null default now(),
 telegram_status text not null default 'recipient_not_connected' check(telegram_status in ('recipient_not_connected','queued','sent','failed'))
);
create table pulse.signin_seen (
 org_id uuid not null references pulse.org(id), account text not null, day date not null, primary key(org_id,account,day)
);
create table pulse.auth_rate (
 org_id uuid not null references pulse.org(id), key_hash text not null, window_start timestamptz not null, attempts int not null, primary key(org_id,key_hash)
);
create table pulse.money_permission (
 org_id uuid not null references pulse.org(id), person_id uuid not null references pulse.person(id),
 permission text not null check(permission in ('money.read','money.amount.read','money.plan.write')),
 granted_by uuid references pulse.person(id), revoked_at timestamptz, primary key(org_id,person_id,permission)
);
create table pulse_priv.money_observation (
 org_id uuid not null references pulse.org(id), dataset text not null, source_key text not null,
 payload jsonb not null, evidence jsonb not null default '{}', import_id uuid references pulse.import_batch(id),
 approved boolean not null default false, approved_by uuid references pulse.person(id), primary key(org_id,dataset,source_key)
);
create table pulse_priv.money_plan (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(), month date not null,
 category text not null, amount numeric(14,2) not null check(amount>=0), currency text not null default 'INR',
 kind text not null check(kind in ('budget','next_month')), note text, edited_by uuid references pulse.person(id),
 updated_at timestamptz not null default now(), unique(org_id,month,category,currency,kind)
);

alter table pulse.contact_profile drop constraint contact_profile_contact_type_check;
alter table pulse.contact_profile add constraint contact_profile_contact_type_check check(contact_type in ('developer','channel_partner','talent','vendor','other'));
alter table pulse.contact_profile add column confidence numeric, add column type_status text;
-- Imported history stays a report, never manufactured check-in times or absences.
grant update(lead_person_id,locked,updated_at) on pulse.project to pulse_api;
grant insert on pulse.project to pulse_api;
grant update on pulse.index_file, pulse.delivery, pulse.campaign, pulse.project_location_member, pulse.identity_link to pulse_api;

-- Every new table is forced tenant RLS, including inaccessible private tables.
do $$ declare r record; begin
 for r in select table_schema,table_name from information_schema.tables where table_schema in ('pulse','pulse_priv') and table_name in
 ('audit_event','import_batch','source_observation','activity_observation','review_item','record_link','record_merge','file_correction',
  'record_annotation','hr_month_history','shift','person_shift','notification','signin_seen','auth_rate','money_permission','money_observation','money_plan') loop
 execute format('alter table %I.%I enable row level security',r.table_schema,r.table_name);
 execute format('alter table %I.%I force row level security',r.table_schema,r.table_name);
 execute format('create policy tenant_isolation on %I.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',r.table_schema,r.table_name);
 execute format('grant select,insert,update,delete on %I.%I to pulse_worker',r.table_schema,r.table_name);
 if r.table_schema='pulse' and r.table_name not in ('auth_rate','signin_seen') then
 execute format('grant select on pulse.%I to pulse_api',r.table_name);
 end if;
 end loop;
end $$;
-- An ordinary viewer may not bypass the API to read HR history or raw mailbox observations.
create policy source_admin on pulse.source_observation as restrictive to pulse_api using(pulse.viewer_is('admin'));
create policy audit_admin on pulse.audit_event as restrictive for select to pulse_api using(pulse.viewer_is('admin'));
create policy history_person on pulse.hr_month_history as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.manages(person_id) or pulse.viewer_is('admin','hr'));
create policy notification_person on pulse.notification as restrictive to pulse_api using(person_id=pulse.current_viewer());
create policy money_permissions_admin on pulse.money_permission as restrictive to pulse_api using(pulse.viewer_is('admin')) with check(pulse.viewer_is('admin'));
grant insert,update,delete on pulse.task,pulse.review_item,pulse.record_link,pulse.record_merge,pulse.file_correction,pulse.record_annotation,pulse.shift,pulse.person_shift,pulse.money_permission to pulse_api;
grant update(read_at) on pulse.notification to pulse_api;
do $$ declare t text; begin
 foreach t in array array['task','review_item','record_link','record_merge','file_correction','record_annotation','shift','person_shift'] loop
 execute format('create policy admin_write on pulse.%I as restrictive for all to pulse_api using(pulse.viewer_is(''admin'',''hr'')) with check(pulse.viewer_is(''admin'',''hr''))',t);
 end loop;
end $$;

-- Metadata only: credentials, HR values, messages, finance, and before/after row values never enter this log.
create function pulse.audit_write(p_action text,p_resource text,p_id text default null,p_fields text[] default '{}') returns void
 language sql security definer set search_path=pulse,pg_temp as $$
 insert into audit_event(org_id,actor_id,actor_account,action,resource,resource_id,fields)
 values(current_org(),current_viewer(),nullif(current_setting('pulse.actor_account',true),''),p_action,p_resource,p_id,p_fields)
$$;
create function pulse.audit_mutation() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j jsonb; oldj jsonb; cols text[]; rid text;
begin
 j:=case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if j->>'org_id' is distinct from current_org()::text then return null; end if;
 oldj:=case when TG_OP='UPDATE' then to_jsonb(old) else '{}'::jsonb end;
 select array_agg(k) into cols from jsonb_object_keys(j) k where TG_OP<>'UPDATE' or j->k is distinct from oldj->k;
 rid:=coalesce(j->>'id',j->>'person_id',j->>'file_id',j->>'source_key',j->>'day');
 insert into audit_event(org_id,actor_id,actor_account,action,resource,resource_id,fields,source)
 values(current_org(),current_viewer(),nullif(current_setting('pulse.actor_account',true),''),lower(TG_OP),TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,rid,coalesce(cols,'{}'),
 case when current_viewer() is null then 'sync' else 'pulse' end);
 return null;
end $$;
-- Attach to all current mutable business tables; event streams already have their own immutable protocol.
do $$ declare r record; begin
 for r in select table_schema,table_name from information_schema.tables where table_schema in ('pulse','pulse_priv') and table_type='BASE TABLE'
 and table_name in ('person','people_profile','person_photo','client','contact_profile','client_contact','project_contact','project','unit','account','role_assignment',
 'record_change','sensitive_permission','attendance_entry','attendance_break','attendance_regularisation','leave_request','leave_adjustment','leave_type','holiday','hr_ticket','hr_policy',
 'hr_compensation','hr_contact','hr_document','project_location','project_location_change','task','review_item','record_link','record_merge','file_correction','record_annotation',
 'shift','person_shift','money_permission','money_observation','money_plan','login_credential','password_reset_request','campaign') loop
 execute format('create trigger audit_mutation after insert or update or delete on %I.%I for each row execute function pulse.audit_mutation()',r.table_schema,r.table_name);
 end loop;
end $$;
create function pulse.audit_access() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform audit_write('restricted_read','privacy.access_log',null,array[new.resource,new.purpose]); return null;
end $$;
create trigger audit_access after insert on privacy.access_log for each row execute function pulse.audit_access();
create function pulse.audit_signin(p_account text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 insert into signin_seen(org_id,account,day) values(current_org(),p_account,current_date) on conflict do nothing;
 if found then perform audit_write('sign_in','cloudflare_access',null,'{}'); end if;
end $$;
create function pulse.auth_allow(p_key text,p_limit int) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 insert into auth_rate(org_id,key_hash,window_start,attempts) values(current_org(),p_key,now(),1)
 on conflict(org_id,key_hash) do update set window_start=case when auth_rate.window_start < now()-interval '15 minutes' then now() else auth_rate.window_start end,
 attempts=case when auth_rate.window_start < now()-interval '15 minutes' then 1 else auth_rate.attempts+1 end returning attempts into n;
 return n<=p_limit;
end $$;
create function pulse.money_can(p_permission text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select viewer_is('admin','leadership') and exists(select 1 from money_permission where org_id=current_org() and person_id=current_viewer() and permission=p_permission and revoked_at is null)
$$;
create function pulse.money_read(p_dataset text,p_offset int default 0) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb; show_amount boolean;
begin
 if not money_can('money.read') then raise exception 'money access denied' using errcode='42501'; end if;
 show_amount:=money_can('money.amount.read');
 perform audit_write('restricted_read','money',p_dataset,array[case when show_amount then 'metadata,amount' else 'metadata' end]);
 select jsonb_build_object('total',(select count(*) from pulse_priv.money_observation where dataset=p_dataset),
 'rows',coalesce(jsonb_agg(jsonb_build_object('id',source_key,'dataset',dataset,'approved',approved,'data',
 case when show_amount then payload else payload - array['amount','last_amount','last_charge_amount','people_count','entries'] end,'evidence',evidence)),'[]'),
 'showAmounts',show_amount) into result from (select * from pulse_priv.money_observation where dataset=p_dataset order by coalesce(payload->>'date',payload->>'last_charge_date',payload->>'last_observed_date') desc nulls last,source_key limit 50 offset greatest(0,p_offset)) r;
 return result;
end $$;
create function pulse.money_summary() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb;
begin
 if not money_can('money.read') then raise exception 'money access denied' using errcode='42501'; end if;
 perform audit_write('restricted_read','money.summary',null,'{}');
 select jsonb_build_object('datasets',coalesce(jsonb_agg(jsonb_build_object('name',dataset,'rows',n,'approved',approved)),'[]')) into result
 from (select dataset,count(*) n,count(*) filter(where approved) approved from pulse_priv.money_observation group by dataset) r;
 if money_can('money.amount.read') then
 result:=result||jsonb_build_object('totals',coalesce((select jsonb_agg(to_jsonb(t)) from (
 select payload->>'currency' currency,payload->>'direction' direction,payload->>'project_key' project_key,
 sum(nullif(payload->>'amount','')::numeric) amount from pulse_priv.money_observation
 where dataset='money_sheet_transactions' and approved group by 1,2,3) t),'[]'));
 end if;
 return result;
end $$;
create function pulse.money_approve(p_dataset text,p_key text,p_approved boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.plan.write') or not money_can('money.amount.read') then raise exception 'money write denied' using errcode='42501'; end if;
 update pulse_priv.money_observation set approved=p_approved,approved_by=current_viewer() where dataset=p_dataset and source_key=p_key;
 if not found then raise exception 'money record missing' using errcode='22023'; end if;
end $$;
create function pulse.money_plans_read() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.read') then raise exception 'money access denied' using errcode='42501'; end if;
 perform audit_write('restricted_read','money.plan',null,'{}');
 return coalesce((select jsonb_agg(case when money_can('money.amount.read') then to_jsonb(p) else to_jsonb(p)-array['amount','note'] end) from pulse_priv.money_plan p),'[]');
end $$;
create function pulse.money_plan_save(p_month date,p_category text,p_amount numeric,p_currency text,p_kind text,p_note text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.plan.write') or not money_can('money.amount.read') then raise exception 'money write denied' using errcode='42501'; end if;
 insert into pulse_priv.money_plan(org_id,month,category,amount,currency,kind,note,edited_by)
 values(current_org(),date_trunc('month',p_month)::date,p_category,p_amount,p_currency,p_kind,p_note,current_viewer())
 on conflict(org_id,month,category,currency,kind) do update set amount=excluded.amount,note=excluded.note,edited_by=excluded.edited_by,updated_at=now();
end $$;

-- A decided request appears only in its owner's queue. Telegram awaits a verified individual chat connection.
create function pulse.notify_decision() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if old.status is distinct from new.status and new.status in ('approved','rejected') then
 insert into notification(org_id,person_id,title,href) values(new.org_id,new.person_id,
 case when TG_TABLE_NAME='leave_request' then 'Leave request ' else 'Attendance correction ' end||new.status,'/me');
 end if; return null;
end $$;
create trigger notify_decision after update on pulse.leave_request for each row execute function pulse.notify_decision();
create trigger notify_decision after update on pulse.attendance_regularisation for each row execute function pulse.notify_decision();

revoke all on function pulse.audit_write(text,text,text,text[]),pulse.audit_mutation(),pulse.audit_access(),pulse.audit_signin(text),pulse.auth_allow(text,int),
 pulse.money_can(text),pulse.money_read(text,int),pulse.money_summary(),pulse.money_approve(text,text,boolean),pulse.money_plans_read(),pulse.money_plan_save(date,text,numeric,text,text,text),pulse.notify_decision() from public;
grant execute on function pulse.audit_write(text,text,text,text[]),pulse.audit_signin(text),pulse.auth_allow(text,int),pulse.money_can(text),pulse.money_read(text,int),
 pulse.money_summary(),pulse.money_approve(text,text,boolean),pulse.money_plans_read(),pulse.money_plan_save(date,text,numeric,text,text,text) to pulse_api;
-- migrate:down
