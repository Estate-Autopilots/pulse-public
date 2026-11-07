-- migrate:up
create or replace function pulse.money_statement_save(rows jsonb,source_type text) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r jsonb; k text; n int:=0; clean jsonb;
begin
 if not money_can('money.plan.write') or not money_can('money.amount.read') then raise exception 'denied' using errcode='42501'; end if;
 if source_type not in ('bank','card','upi','gateway') or jsonb_typeof(rows)<>'array' or jsonb_array_length(rows)>2000 then raise exception 'invalid statement' using errcode='22023'; end if;
 for r in select value from jsonb_array_elements(rows) loop
  if coalesce(r->>'amount','')!~'^[0-9]+([.][0-9]+)?$' or coalesce(r->>'direction','') not in ('inflow','outflow')
   or coalesce(r->>'date','')!~'^\d{4}-\d{2}-\d{2}$' or coalesce(r->>'currency','')!~'^[A-Z]{3}$'
   or coalesce(r->>'reference_hash','')!~'^[a-f0-9]{64}$' or (r ? 'account_last4' and coalesce(r->>'account_last4','')!~'^\d{4}$') then raise exception 'invalid statement row' using errcode='22023'; end if;
  perform (r->>'date')::date;
  clean:=jsonb_build_object('date',r->>'date','amount',(r->>'amount')::numeric,'direction',r->>'direction','currency',r->>'currency',
   'vendor',left(regexp_replace(coalesce(r->>'vendor','Unknown'),'[0-9]([ -]?[0-9]){4,}','[redacted]','g'),160),
   'category',left(regexp_replace(coalesce(r->>'category','Uncategorised'),'[0-9]([ -]?[0-9]){4,}','[redacted]','g'),80),
   'record_kind',source_type||'_statement','account_last4',r->>'account_last4','reference_hash',r->>'reference_hash');
  k:='statement:'||md5((clean-array['category','vendor','record_kind'])::text);
  insert into pulse_priv.money_observation(org_id,dataset,source_key,payload,evidence,approved)
   values(current_org(),'money_sheet_transactions',k,clean,jsonb_build_object('source','statement_import','type',source_type,'imported_by',current_viewer()),false)
   on conflict(org_id,dataset,source_key) do nothing;
  if found then n:=n+1; end if;
 end loop;
 perform audit_write('import','money.statement',source_type,array['normalised_rows']);
 return n;
end $$;
-- migrate:down
