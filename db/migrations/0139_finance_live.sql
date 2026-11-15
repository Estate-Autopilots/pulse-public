-- migrate:up
-- FIN-LIVE: EA's real finance records with provenance. Leadership-only, audited and uncertified until the CA
-- certifies a month. Payroll appears only as monthly totals; individual pay stays in the HR salary area.
create table pulse_priv.finance_live_record (
 org_id uuid not null references pulse.org(id),
 kind text not null check(kind in ('bank_line','bank_balance','bank_summary','invoice','bill','cost_month','expense_month',
  'subscription','ad_spend_month','filing','suspense','plan','package_cost','client_status')),
 key text not null check(length(key) between 1 and 200),
 scope text not null check(length(scope) between 1 and 200),
 body jsonb not null check(jsonb_typeof(body)='object'),
 source jsonb not null check(jsonb_typeof(source)='object' and source ? 'type'),
 hash text not null check(hash ~ '^[0-9a-f]{64}$'),
 confidence text not null check(confidence in ('high','medium','low')),
 first_seen timestamptz not null default now(),
 changed_at timestamptz not null default now(),
 run_id uuid,
 primary key(org_id,kind,key)
);
create index finance_live_record_scope on pulse_priv.finance_live_record(org_id,scope);
-- One row per source: last sync, record count, coverage and what is still missing (and who supplies it).
create table pulse_priv.finance_live_source (
 org_id uuid not null references pulse.org(id),key text not null,body jsonb not null check(jsonb_typeof(body)='object'),
 synced_at timestamptz not null default now(),primary key(org_id,key)
);
create table pulse_priv.finance_live_run (
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),
 started_at timestamptz not null default now(),finished_at timestamptz,ok boolean,
 counts jsonb not null default '{}' check(jsonb_typeof(counts)='object'),error text check(length(error)<=200)
);
-- The computed brief and tab views of the latest successful sync.
create table pulse_priv.finance_live_model (
 org_id uuid primary key references pulse.org(id),body jsonb not null check(jsonb_typeof(body)='object'),
 run_id uuid,computed_at timestamptz not null default now()
);
-- Drive filing ledger: each invoice PDF is filed once in the EA Finance Shared Drive.
create table pulse_priv.finance_live_filed (
 org_id uuid not null references pulse.org(id),key text not null check(key ~ '^[0-9a-f]{64}$'),
 drive_id text not null,file_id text not null,path text not null,name text not null,
 filed_at timestamptz not null default now(),primary key(org_id,key)
);
do $$ declare t text;begin
 foreach t in array array['finance_live_record','finance_live_source','finance_live_run','finance_live_model','finance_live_filed'] loop
 execute format('alter table pulse_priv.%I enable row level security',t);
 execute format('alter table pulse_priv.%I force row level security',t);
 execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('create trigger audit_mutation after insert or update or delete on pulse_priv.%I for each row execute function pulse.audit_mutation()',t);
 execute format('grant select,insert,update,delete on pulse_priv.%I to pulse_worker',t);
 end loop;
end $$;
-- Leadership with finance amount grants reads the live views; an Accountant never does (certified views only).
create function pulse.finance_live_authorize() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or is_accountant(current_viewer()) then
  raise exception 'Live finance views are leadership-only' using errcode='42501';
 end if;
 perform finance_authorize(false);
end $$;
create function pulse.finance_live_state() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform finance_live_authorize();perform audit_write('restricted_read','finance.live');
 return jsonb_build_object(
  'model',(select body from pulse_priv.finance_live_model where org_id=current_org()),
  'computedAt',(select computed_at from pulse_priv.finance_live_model where org_id=current_org()),
  'sources',coalesce((select jsonb_agg(body||jsonb_build_object('key',key,'syncedAt',synced_at) order by key) from pulse_priv.finance_live_source where org_id=current_org()),'[]'),
  'runs',coalesce((select jsonb_agg(jsonb_build_object('startedAt',started_at,'finishedAt',finished_at,'ok',ok,'counts',counts,'error',error) order by started_at desc)
   from (select * from pulse_priv.finance_live_run where org_id=current_org() order by started_at desc limit 8) r),'[]'));
end $$;
-- Evidence drill-down: the stored records of one kind with their provenance, newest first, 100 at a time.
create function pulse.finance_live_records(p_kind text,p_offset int default 0) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform finance_live_authorize();perform audit_write('restricted_read','finance.live',p_kind);
 return jsonb_build_object('total',(select count(*) from pulse_priv.finance_live_record where org_id=current_org() and kind=p_kind),
  'rows',coalesce((select jsonb_agg(jsonb_build_object('key',key,'body',body,'source',source,'confidence',confidence,'hash',hash,'changedAt',changed_at))
   from (select * from pulse_priv.finance_live_record where org_id=current_org() and kind=p_kind
   order by coalesce(body->>'date',body->>'month',body->>'day','') desc,key limit 100 offset greatest(0,coalesce(p_offset,0))) r),'[]'));
end $$;
revoke all on function pulse.finance_live_authorize(),pulse.finance_live_state(),pulse.finance_live_records(text,int) from public;
grant execute on function pulse.finance_live_authorize(),pulse.finance_live_state(),pulse.finance_live_records(text,int) to pulse_api;
-- Payroll on the CA desk: one monthly total per month and kind. Names and per-person amounts stay in HR.
create or replace function pulse.finance_desk_payroll_rows() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('kind','payroll','key','salary-register:'||m.month||':'||m.kind||':'||m.currency,'body',
  jsonb_build_object('month',m.month,'name','All staff (monthly total)','kind',m.kind,'amount',m.amount,'currency',m.currency,
  'components',m.people||' people','basis','Monthly total of salary register entries; individual salaries stay in the HR salary area'))
  order by m.month,m.kind),'[]')
 from (select body->>'month' as month,body->>'kind' as kind,coalesce(body->>'currency','INR') as currency,sum((body->>'amount')::numeric) as amount,
  count(distinct person_id) as people
  from pulse_priv.finance_desk_payroll where org_id=current_org() and body->>'amount' ~ '^-?[0-9]+(\.[0-9]+)?$' group by 1,2,3) m
$$;
revoke all on function pulse.finance_desk_payroll_rows() from public;
-- The live sync derives the CA desk registers from source documents. It may change or retire only the rows it wrote
-- itself (origin finance-live); RF1 intake rows and fixtures are never touched.
create function pulse.finance_desk_live_put(p_kind text,p_key text,p_body jsonb) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
declare previous jsonb;
begin
 if p_kind not in ('purchase','sales','payroll','vendor','exception') or p_body->>'origin' is distinct from 'finance-live'
  or length(coalesce(p_key,'')) not between 1 and 200 then raise exception 'Live desk rows need a known kind, key and origin' using errcode='22023';end if;
 if p_kind='payroll' and (p_body ? 'person' or p_body ? 'personId' or p_body->>'name' is distinct from 'All staff (monthly total)') then
  raise exception 'Payroll on the desk is a monthly total only' using errcode='22023';end if;
 select body into previous from pulse_priv.finance_desk_record where org_id=current_org() and not synthetic and kind=p_kind and key=p_key;
 if previous is null then
  insert into pulse_priv.finance_desk_record(org_id,kind,key,body,synthetic) values(current_org(),p_kind,p_key,p_body,false);return true;
 end if;
 if previous->>'origin' is distinct from 'finance-live' then raise exception 'Desk row belongs to another intake' using errcode='42501';end if;
 if previous=p_body then return false;end if;
 update pulse_priv.finance_desk_record set body=p_body where org_id=current_org() and not synthetic and kind=p_kind and key=p_key;return true;
end $$;
create function pulse.finance_desk_live_prune(p_kind text,p_keys text[]) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 delete from pulse_priv.finance_desk_record where org_id=current_org() and not synthetic and kind=p_kind and body->>'origin'='finance-live'
 and not (key=any(coalesce(p_keys,'{}')));
 get diagnostics n=row_count;return n;
end $$;
revoke all on function pulse.finance_desk_live_put(text,text,jsonb),pulse.finance_desk_live_prune(text,text[]) from public;
grant execute on function pulse.finance_desk_live_put(text,text,jsonb),pulse.finance_desk_live_prune(text,text[]) to pulse_worker;
-- migrate:down
-- Forward-only: live finance evidence and its audit trail are retained.
