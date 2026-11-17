-- migrate:up
-- Source snapshots, decisions and close/budget vintages remain immutable across replay.
create table pulse_priv.finance_source (
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),
 external_key text not null,vintage text not null,body jsonb not null,created_at timestamptz not null default now(),
 unique(org_id,external_key,vintage),unique(org_id,id),
 check(body->>'kind'=any(array['cash','invoice','bill','receipt','payroll','topup','delivery','fee','credit','application'])),
 check(body->>'currency' ~ '^[A-Z]{3}$'),check((body->>'scale')::int between 0 and 4),
 check((body->>'minor')::numeric between 0 and 9e12 and (body->>'minor')::numeric=trunc((body->>'minor')::numeric)),
 check(body->>'direction' in ('inflow','outflow')),check(body->>'validation' in ('validated','quarantine'))
);
create table pulse_priv.finance_decision (
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),request_key text not null,
 body jsonb not null,active boolean not null default true,at timestamptz not null default now(),actor uuid references pulse.person(id),
 unique(org_id,request_key),unique(org_id,id)
);
create table pulse_priv.finance_allocation (
 org_id uuid not null,decision_id uuid not null,source_id uuid not null,role text not null check(role in ('cash','obligation','fee','evidence')),
 minor numeric not null check(minor>0 and minor=trunc(minor)),active boolean not null default true,
 primary key(org_id,decision_id,source_id),foreign key(org_id,decision_id) references pulse_priv.finance_decision(org_id,id),
 foreign key(org_id,source_id) references pulse_priv.finance_source(org_id,id)
);
create unique index finance_cash_once on pulse_priv.finance_allocation(org_id,source_id) where role='cash' and active;
create table pulse_priv.finance_document (
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),kind text not null,
 body jsonb not null,actor uuid references pulse.person(id),at timestamptz not null default now(),
 check(kind in ('period','case','case_resolution','budget','commitment','schedule','forecast','vendor','rule','close','undo','adjustment'))
);
do $$ declare t text;begin
 foreach t in array array['finance_source','finance_decision','finance_allocation','finance_document'] loop
 execute format('alter table pulse_priv.%I enable row level security',t);
 execute format('alter table pulse_priv.%I force row level security',t);
 execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('create trigger audit_mutation after insert or update or delete on pulse_priv.%I for each row execute function pulse.audit_mutation()',t);
 -- Only checked security-definer functions grant service access. No generic API or worker table writes.
 end loop;
end $$;
create function pulse.finance_authorize(w boolean default false) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.read') or not money_can('money.amount.read') or (w and not money_can('money.plan.write')) then
 raise exception 'Finance amount and source grants required' using errcode='42501';end if;
end $$;
create function pulse.finance_state() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform finance_authorize();perform audit_write('restricted_read','finance.workspace');
 return jsonb_build_object('sources',coalesce((select jsonb_agg(body||jsonb_build_object('id',id) order by created_at,id) from pulse_priv.finance_source),'[]'),
 'decisions',coalesce((select jsonb_agg(jsonb_build_object('id',id,'active',active,'body',body,'at',at,'actor',actor) order by at,id) from pulse_priv.finance_decision),'[]'),
 'documents',coalesce((select jsonb_agg(jsonb_build_object('id',id,'kind',kind,'body',body,'at',at,'actor',actor) order by at,id) from pulse_priv.finance_document),'[]'));
end $$;
create function pulse.finance_source_add(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result uuid;previous jsonb;
begin
 perform finance_authorize(true);
 if length(coalesce(p->>'externalKey','')) not between 1 and 160 or length(coalesce(p->>'vintage','')) not between 1 and 160
 or jsonb_typeof(p->'issues')<>'array' then raise exception 'Source identity and validation required' using errcode='22023';end if;
 -- Source details are whitelisted by the API; the SQL boundary also rejects raw payroll or unknown fields.
 if exists(select 1 from jsonb_object_keys(p) k where k not in ('externalKey','vintage','kind','account','party','partyConfirmed','currency','scale','minor','direction','cashDate','invoiceDate','dueDate','serviceFrom','serviceTo','dateBasis','reference','label','documentBasis','dataset','observationId','category','projectId','clientId','validation','issues')) then raise exception 'Unsupported source fields' using errcode='22023';end if;
 if p->>'kind'='payroll' and p->>'label'<>'Approved aggregate payroll' then raise exception 'Payroll must be a protected aggregate' using errcode='22023';end if;
 insert into pulse_priv.finance_source(org_id,external_key,vintage,body) values(current_org(),p->>'externalKey',p->>'vintage',p)
 on conflict(org_id,external_key,vintage) do nothing returning id into result;
 if result is null then select id,body into result,previous from pulse_priv.finance_source where external_key=p->>'externalKey' and vintage=p->>'vintage';
 if previous<>p then raise exception 'Immutable source changed; import a new vintage' using errcode='40001';end if;end if;
 return result;
end $$;
create function pulse.finance_accept(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result uuid;l jsonb;s jsonb;cur text;sc int;dir text;cash numeric:=0;obligation numeric:=0;fees numeric:=0;cin numeric:=0;cout numeric:=0;cash_count int:=0;accounts text[]:='{}';n numeric;used numeric;previous jsonb;
begin
 perform finance_authorize(true);
 perform pg_advisory_xact_lock(hashtextextended('finance:'||current_org()::text,0));
 if length(coalesce(p->>'requestKey','')) not between 1 and 160 or length(trim(coalesce(p->>'reason',''))) not between 1 and 1000
 or jsonb_typeof(p->'links')<>'array' or jsonb_array_length(p->'links') not between 1 and 100 then raise exception 'Decision reason and request key required' using errcode='22023';end if;
 select id,body into result,previous from pulse_priv.finance_decision where request_key=p->>'requestKey';
 if result is not null then if previous<>p then raise exception 'Decision replay differs' using errcode='40001';end if;return result;end if;
 if p->>'treatment' not in ('payment','cash_only','transfer','refund') then raise exception 'Unknown economic treatment' using errcode='22023';end if;
 for l in select value from jsonb_array_elements(p->'links') loop
  select body into s from pulse_priv.finance_source where id=(l->>'sourceId')::uuid;
  if s is null or s->>'validation'<>'validated' then raise exception 'Source unavailable or quarantined' using errcode='22023';end if;
  n:=(l->>'minor')::numeric;
  if n is null or n<=0 or n<>trunc(n) or n>(s->>'minor')::numeric then raise exception 'Invalid source allocation' using errcode='22023';end if;
  if cur is null then cur:=s->>'currency';sc:=(s->>'scale')::int;end if;
  if cur<>s->>'currency' or sc<>(s->>'scale')::int then raise exception 'Currency or minor unit conflict' using errcode='22023';end if;
  if l->>'role'='cash' then
   if s->>'kind'<>'cash' or n<>(s->>'minor')::numeric or coalesce(s->>'account','')='' then raise exception 'Complete bank cash line required' using errcode='22023';end if;
   if exists(select 1 from pulse_priv.finance_allocation where source_id=(l->>'sourceId')::uuid and role='cash' and active) then raise exception 'Cash line already allocated' using errcode='40001';end if;
   if dir is null then dir:=s->>'direction';end if;
   if p->>'treatment'<>'transfer' and dir<>s->>'direction' then raise exception 'Cash directions conflict' using errcode='22023';end if;
   cash:=cash+n;cash_count:=cash_count+1;accounts:=array_append(accounts,s->>'account');
   if s->>'direction'='inflow' then cin:=cin+n;else cout:=cout+n;end if;
  elsif l->>'role' in ('obligation','fee') then
   if l->>'role'='fee' then if s->>'kind'<>'fee' then raise exception 'Documented fee required' using errcode='22023';end if;fees:=fees+n;
   else if s->>'kind' not in ('bill','invoice','payroll','topup','credit','application') then raise exception 'Obligation source required' using errcode='22023';end if;obligation:=obligation+n;end if;
   select coalesce(sum(minor),0) into used from pulse_priv.finance_allocation where source_id=(l->>'sourceId')::uuid and role=l->>'role' and active;
   if used+n>(s->>'minor')::numeric then raise exception 'Source amount already consumed' using errcode='40001';end if;
  elsif l->>'role'<>'evidence' then raise exception 'Unknown allocation role' using errcode='22023';end if;
 end loop;
 if cash_count=0 then raise exception 'Bank cash settlement required' using errcode='22023';end if;
 if p->>'treatment'='transfer' then
 if cash_count<>2 or cin<>cout or accounts[1]=accounts[2] or obligation<>0 or fees<>0 then raise exception 'Transfer must conserve consolidated cash' using errcode='22023';end if;
 elsif p->>'treatment'='cash_only' then
 if obligation<>0 or fees<>0 then raise exception 'Cash-only cannot create expense adjustments' using errcode='22023';end if;
 elsif obligation=0 or cash+fees<>obligation then raise exception 'Cash plus documented fee must conserve obligation amount' using errcode='22023';end if;
 if p->>'treatment' not in ('transfer','refund') and exists(select 1 from jsonb_array_elements(p->'links') x join pulse_priv.finance_source s on s.id=(x->>'sourceId')::uuid where x->>'role'='obligation' and s.body->>'direction'<>dir) then raise exception 'Obligation direction conflict' using errcode='22023';end if;
 if p->>'currency'<>cur or (p->>'scale')::int<>sc or p->>'direction'<>dir then raise exception 'Decision controls conflict' using errcode='22023';end if;
 insert into pulse_priv.finance_decision(org_id,request_key,body,actor) values(current_org(),p->>'requestKey',p,current_viewer()) returning id into result;
 insert into pulse_priv.finance_allocation(org_id,decision_id,source_id,role,minor) select current_org(),result,(x->>'sourceId')::uuid,x->>'role',(x->>'minor')::numeric from jsonb_array_elements(p->'links') x;
 return result;
end $$;
create function pulse.finance_unlink(k uuid,reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform finance_authorize(true);perform pg_advisory_xact_lock(hashtextextended('finance:'||current_org()::text,0));
 if length(trim(reason)) not between 1 and 1000 then raise exception 'Unlink reason required' using errcode='22023';end if;
 if not exists(select 1 from pulse_priv.finance_decision where id=k and active) then raise exception 'Active decision missing' using errcode='P0002';end if;
 update pulse_priv.finance_decision set active=false where id=k;update pulse_priv.finance_allocation set active=false where decision_id=k;
 insert into pulse_priv.finance_document(org_id,kind,body,actor) values(current_org(),'undo',jsonb_build_object('decisionId',k,'reason',reason,'historicalClose','Preserved; adjustment required'),current_viewer());
end $$;
create function pulse.finance_document_add(k text,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result uuid;
begin
 perform finance_authorize(true);perform pg_advisory_xact_lock(hashtextextended('finance:'||current_org()::text,0));
 if k in ('close','undo') then raise exception 'Use checked close and undo controls' using errcode='42501';end if;
 if k='budget' and (p->>'status' not in ('proposed','submitted','approved') or coalesce(p->>'reason','')='' or (p->>'minor')::numeric<0) then raise exception 'Budget status amount and revision reason required' using errcode='22023';end if;
 insert into pulse_priv.finance_document(org_id,kind,body,actor) values(current_org(),k,p,current_viewer()) returning id into result;return result;
end $$;
create function pulse.finance_close(p_month text,p_currency text,p_scale int,p_reason text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result uuid;period record;source record;opening numeric;closing numeric;cash_in numeric;cash_out numeric;controls jsonb:='[]';n int:=0;version int;unmatched int;
begin
 perform finance_authorize(true);perform pg_advisory_xact_lock(hashtextextended('finance:'||current_org()::text,0));
 if p_month!~'^\d{4}-\d{2}$' or length(trim(p_reason)) not between 1 and 1000 then raise exception 'Close month and reason required' using errcode='22023';end if;
 -- Require a latest covered statement for every known account of this currency, including zero-movement accounts.
 for source in select distinct body->>'account' account from pulse_priv.finance_source where body->>'kind'='cash' and body->>'currency'=p_currency and (body->>'scale')::int=p_scale union select distinct body->>'account' from pulse_priv.finance_document where kind='period' and body->>'currency'=p_currency and (body->>'scale')::int=p_scale loop
 if not exists(select 1 from pulse_priv.finance_document where kind='period' and body->>'account'=source.account and body->>'month'=p_month and body->>'currency'=p_currency and (body->>'scale')::int=p_scale) then raise exception 'Account statement coverage missing' using errcode='22023';end if;
 end loop;
 for period in select distinct on(body->>'account') body from pulse_priv.finance_document where kind='period' and body->>'month'=p_month and body->>'currency'=p_currency and (body->>'scale')::int=p_scale order by body->>'account',at desc,id desc loop
 n:=n+1;opening:=(period.body->>'opening')::numeric;closing:=(period.body->>'closing')::numeric;
 if opening is null or closing is null or coalesce((period.body->>'complete')::boolean,false)=false or coalesce(period.body->>'statementBasis','')='' then raise exception 'Opening closing and complete statement evidence required' using errcode='22023';end if;
 select coalesce(sum(case when s.body->>'direction'='inflow' and a.source_id is not null then (s.body->>'minor')::numeric else 0 end),0),
 coalesce(sum(case when s.body->>'direction'='outflow' and a.source_id is not null then (s.body->>'minor')::numeric else 0 end),0),
 count(*) filter(where a.source_id is null or s.body->>'validation'<>'validated') into cash_in,cash_out,unmatched
 from pulse_priv.finance_source s left join pulse_priv.finance_allocation a on a.source_id=s.id and a.org_id=s.org_id and a.role='cash' and a.active
 where s.body->>'kind'='cash' and s.body->>'account'=period.body->>'account' and s.body->>'currency'=p_currency and (s.body->>'scale')::int=p_scale and left(s.body->>'cashDate',7)=p_month;
 if unmatched>0 or opening+cash_in-cash_out<>closing then raise exception 'Unmatched cash or unexplained account residual prevents close' using errcode='22023';end if;
 controls:=controls||jsonb_build_array(period.body||jsonb_build_object('inflow',cash_in,'outflow',cash_out,'residual',0));
 end loop;
 if n=0 then raise exception 'No covered accounts for this month' using errcode='22023';end if;
 if exists(select 1 from pulse_priv.finance_document c where kind='case' and c.body->>'month'=p_month and c.body->>'currency'=p_currency and not exists(select 1 from pulse_priv.finance_document r where r.kind='case_resolution' and r.body->>'caseId'=c.id::text)) then raise exception 'Resolve discrepancy cases before close' using errcode='22023';end if;
 select count(*)+1 into version from pulse_priv.finance_document where kind='close' and body->>'month'=p_month and body->>'currency'=p_currency and (body->>'scale')::int=p_scale;
 insert into pulse_priv.finance_document(org_id,kind,body,actor) values(current_org(),'close',jsonb_build_object('month',p_month,'currency',p_currency,'scale',p_scale,'reason',p_reason,'version',version,'controls',controls,
 'sourceIds',(select jsonb_agg(id) from pulse_priv.finance_source),'decisionIds',(select jsonb_agg(id) from pulse_priv.finance_decision where active)),current_viewer()) returning id into result;
 return result;
end $$;
revoke all on function pulse.finance_authorize(boolean),pulse.finance_state(),pulse.finance_source_add(jsonb),pulse.finance_accept(jsonb),pulse.finance_unlink(uuid,text),pulse.finance_document_add(text,jsonb),pulse.finance_close(text,text,int,text) from public;
grant execute on function pulse.finance_authorize(boolean),pulse.finance_state(),pulse.finance_source_add(jsonb),pulse.finance_accept(jsonb),pulse.finance_unlink(uuid,text),pulse.finance_document_add(text,jsonb),pulse.finance_close(text,text,int,text) to pulse_api;
-- migrate:down
