-- migrate:up
create or replace function pulse.finance_accept(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
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
  if exists(select 1 from pulse_priv.finance_source old join pulse_priv.finance_source newer on newer.external_key=old.external_key and newer.org_id=old.org_id where old.id=(l->>'sourceId')::uuid and (newer.created_at,newer.id)>(old.created_at,old.id)) then raise exception 'Source vintage superseded; review the current snapshot' using errcode='22023';end if;
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
create or replace function pulse.finance_close(p_month text,p_currency text,p_scale int,p_reason text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result uuid;period record;source record;opening numeric;closing numeric;cash_in numeric;cash_out numeric;controls jsonb:='[]';n int:=0;version int;unmatched int;
begin
 perform finance_authorize(true);perform pg_advisory_xact_lock(hashtextextended('finance:'||current_org()::text,0));
 if p_month!~'^\d{4}-\d{2}$' or length(trim(p_reason)) not between 1 and 1000 then raise exception 'Close month and reason required' using errcode='22023';end if;
 if exists(select 1 from pulse_priv.finance_source old join pulse_priv.finance_allocation a on a.source_id=old.id and a.org_id=old.org_id and a.active
 where exists(select 1 from pulse_priv.finance_source newer where newer.external_key=old.external_key and newer.org_id=old.org_id and (newer.created_at,newer.id)>(old.created_at,old.id))) then raise exception 'Allocated source vintage conflicts with a later revision' using errcode='22023';end if;
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
 where not exists(select 1 from pulse_priv.finance_source newer where newer.org_id=s.org_id and newer.external_key=s.external_key and (newer.created_at,newer.id)>(s.created_at,s.id)) and s.body->>'kind'='cash' and s.body->>'account'=period.body->>'account' and s.body->>'currency'=p_currency and (s.body->>'scale')::int=p_scale and left(s.body->>'cashDate',7)=p_month;
 if unmatched>0 or opening+cash_in-cash_out<>closing then raise exception 'Unmatched cash or unexplained account residual prevents close' using errcode='22023';end if;
 controls:=controls||jsonb_build_array(period.body||jsonb_build_object('inflow',cash_in,'outflow',cash_out,'residual',0));
 end loop;
 if n=0 then raise exception 'No covered accounts for this month' using errcode='22023';end if;
 if exists(select 1 from pulse_priv.finance_document c where kind='case' and c.body->>'month'=p_month and c.body->>'currency'=p_currency and not exists(select 1 from pulse_priv.finance_document r where r.kind='case_resolution' and r.body->>'caseId'=c.id::text)) then raise exception 'Resolve discrepancy cases before close' using errcode='22023';end if;
 if exists(select 1 from pulse_priv.finance_document where kind='close' and body->>'month'=p_month and body->>'currency'=p_currency and (body->>'scale')::int=p_scale)
 and not exists(select 1 from pulse_priv.finance_document a join pulse_priv.finance_document c on c.id=(a.body->>'closeId')::uuid where a.kind='adjustment' and c.kind='close' and c.body->>'month'=p_month and c.body->>'currency'=p_currency and a.at>c.at)
 then raise exception 'Reopen requires a linked adjustment reason' using errcode='22023';end if;
 select count(*)+1 into version from pulse_priv.finance_document where kind='close' and body->>'month'=p_month and body->>'currency'=p_currency and (body->>'scale')::int=p_scale;
 insert into pulse_priv.finance_document(org_id,kind,body,actor) values(current_org(),'close',jsonb_build_object('month',p_month,'currency',p_currency,'scale',p_scale,'reason',p_reason,'version',version,'controls',controls,
 'sourceIds',(select jsonb_agg(id) from pulse_priv.finance_source),'decisionIds',(select jsonb_agg(id) from pulse_priv.finance_decision where active)),current_viewer()) returning id into result;
 return result;
end $$;

-- Existing saved approvals become history snapshots; absence of a historical proposal remains explicit.
insert into pulse_priv.finance_document(org_id,kind,body,actor,at)
 select org_id,'budget',jsonb_build_object('month',to_char(month,'YYYY-MM'),'category',category,'currency',currency,
 'scale',case when currency='JPY' then 0 when currency='KWD' then 3 else 2 end,
 'minor',round(amount*power(10,case when currency='JPY' then 0 when currency='KWD' then 3 else 2 end)),
 'status','approved','reason',coalesce(nullif(note,''),'Legacy saved approval; original proposal not recorded'),'legacyPlanId',id),edited_by,updated_at
 from pulse_priv.money_plan where kind='budget';
create function pulse.finance_legacy_budget_history() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.kind='budget' then
 insert into pulse_priv.finance_document(org_id,kind,body,actor) values(new.org_id,'budget',jsonb_build_object('month',to_char(new.month,'YYYY-MM'),'category',new.category,'currency',new.currency,
 'scale',case when new.currency='JPY' then 0 when new.currency='KWD' then 3 else 2 end,
 'minor',round(new.amount*power(10,case when new.currency='JPY' then 0 when new.currency='KWD' then 3 else 2 end)),
 'status','approved','reason',coalesce(nullif(new.note,''),'Legacy API approval revision'),'legacyPlanId',new.id),new.edited_by);end if;return new;
end $$;
create trigger preserve_budget_history after insert or update on pulse_priv.money_plan for each row execute function pulse.finance_legacy_budget_history();
revoke all on function pulse.finance_legacy_budget_history() from public;
-- General intelligence receives counts only, never monetary values or source labels.
create function pulse.finance_health() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.read') then raise exception 'Finance metadata grant required' using errcode='42501';end if;
 perform audit_write('restricted_read','finance.health');
 return jsonb_build_object('sources',(select count(*) from pulse_priv.finance_source),'decisions',(select count(*) from pulse_priv.finance_decision where active),
 'cases',(select count(*) from pulse_priv.finance_document c where kind='case' and not exists(select 1 from pulse_priv.finance_document r where r.kind='case_resolution' and r.body->>'caseId'=c.id::text)),
 'closes',(select count(*) from pulse_priv.finance_document where kind='close'));
end $$;
revoke all on function pulse.finance_health() from public;grant execute on function pulse.finance_health() to pulse_api;

-- migrate:down
