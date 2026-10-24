-- migrate:up
-- Persistent categorisation is separate from source imports.
create table pulse_priv.money_category (
 org_id uuid not null references pulse.org(id),dataset text not null,source_key text not null,category text not null,
 edited_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 primary key(org_id,dataset,source_key),foreign key(org_id,dataset,source_key) references pulse_priv.money_observation(org_id,dataset,source_key)
);
alter table pulse_priv.money_category enable row level security;
alter table pulse_priv.money_category force row level security;
create policy tenant on pulse_priv.money_category using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.money_category to pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse_priv.money_category for each row execute function pulse.audit_mutation();
create function pulse.money_category_save(ds text,k text,cat text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.plan.write') then raise exception 'denied' using errcode='42501'; end if;
 if length(cat) not between 1 and 80 then raise exception 'category invalid' using errcode='22023'; end if;
 insert into pulse_priv.money_category(org_id,dataset,source_key,category,edited_by) values(current_org(),ds,k,cat,current_viewer())
 on conflict(org_id,dataset,source_key) do update set category=excluded.category,edited_by=excluded.edited_by,updated_at=now();
end $$;
create function pulse.money_workspace() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.read') or not money_can('money.amount.read') then raise exception 'denied' using errcode='42501'; end if;
 perform audit_write('restricted_read','money.workspace');
 return coalesce((select jsonb_agg(jsonb_build_object('id',o.source_key,'dataset',o.dataset,'approved',o.approved,
 'data',o.payload||case when cat.category is null then '{}'::jsonb else jsonb_build_object('category',cat.category) end,
 'projectId',p.id,'projectName',coalesce(p.title,p.name),'clientId',p.client_id,'clientName',cl.display_name))
 from pulse_priv.money_observation o left join pulse_priv.money_category cat using(org_id,dataset,source_key)
 left join pulse_priv.money_match m using(org_id,dataset,source_key)
 left join lateral(select min(pr.id::text)::uuid id from project pr where lower(trim(pr.project_key))=lower(trim(o.payload->>'project_key')) having count(*)=1) matched on true
 left join project p on p.id=coalesce(m.project_id,matched.id) left join client cl on cl.id=p.client_id),'[]');
end $$;
-- Only normalised fields are accepted. Raw statements, account numbers and credentials never enter storage.
create function pulse.money_statement_save(rows jsonb,source_type text) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r jsonb; k text; n int:=0; clean jsonb;
begin
 if not money_can('money.plan.write') or not money_can('money.amount.read') then raise exception 'denied' using errcode='42501'; end if;
 if source_type not in ('bank','card','upi','gateway') or jsonb_typeof(rows)<>'array' or jsonb_array_length(rows)>2000 then raise exception 'invalid statement' using errcode='22023'; end if;
 for r in select value from jsonb_array_elements(rows) loop
  if coalesce(r->>'amount','')!~'^[0-9]+([.][0-9]+)?$' or coalesce(r->>'direction','') not in ('inflow','outflow')
   or coalesce(r->>'date','')!~'^\d{4}-\d{2}-\d{2}$' or coalesce(r->>'currency','')!~'^[A-Z]{3}$'
   or (r ? 'account_last4' and coalesce(r->>'account_last4','')!~'^\d{4}$') then raise exception 'invalid statement row' using errcode='22023'; end if;
  perform (r->>'date')::date;
  clean:=jsonb_build_object('date',r->>'date','amount',(r->>'amount')::numeric,'direction',r->>'direction','currency',r->>'currency',
   'vendor',left(regexp_replace(coalesce(r->>'vendor','Unknown'),'[0-9]{5,}','[redacted]','g'),160),
   'category',left(regexp_replace(coalesce(r->>'category','Uncategorised'),'[0-9]{5,}','[redacted]','g'),80),
   'record_kind',source_type||'_statement','account_last4',r->>'account_last4','reference_hash',r->>'reference_hash');
  k:='statement:'||md5(clean::text);
  insert into pulse_priv.money_observation(org_id,dataset,source_key,payload,evidence,approved)
   values(current_org(),'money_sheet_transactions',k,clean,jsonb_build_object('source','statement_import','type',source_type,'imported_by',current_viewer()),false)
   on conflict(org_id,dataset,source_key) do nothing;
  if found then n:=n+1; end if;
 end loop;
 perform audit_write('import','money.statement',source_type,array['normalised_rows']);
 return n;
end $$;
revoke all on function pulse.money_workspace(),pulse.money_category_save(text,text,text),pulse.money_statement_save(jsonb,text) from public;
grant execute on function pulse.money_workspace(),pulse.money_category_save(text,text,text),pulse.money_statement_save(jsonb,text) to pulse_api;
-- migrate:down
