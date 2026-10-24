-- migrate:up
create table pulse_priv.money_tool_detail (
 org_id uuid not null references pulse.org(id),dataset text not null,source_key text not null,
 renewal_date date,seats int check(seats>=0),used_seats int check(used_seats>=0),edited_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 primary key(org_id,dataset,source_key),foreign key(org_id,dataset,source_key) references pulse_priv.money_observation(org_id,dataset,source_key)
);
alter table pulse_priv.money_tool_detail enable row level security;
alter table pulse_priv.money_tool_detail force row level security;
create policy tenant on pulse_priv.money_tool_detail using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.money_tool_detail to pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse_priv.money_tool_detail for each row execute function pulse.audit_mutation();
create function pulse.money_tool_save(ds text,k text,renewal date,paid int,used int) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.plan.write') or not money_can('money.amount.read') then raise exception 'denied' using errcode='42501'; end if;
 if ds not in ('subscriptions','recurring') or paid<0 or used<0 or used>paid then raise exception 'invalid seats' using errcode='22023'; end if;
 insert into pulse_priv.money_tool_detail(org_id,dataset,source_key,renewal_date,seats,used_seats,edited_by) values(current_org(),ds,k,renewal,paid,used,current_viewer())
 on conflict(org_id,dataset,source_key) do update set renewal_date=excluded.renewal_date,seats=excluded.seats,used_seats=excluded.used_seats,edited_by=excluded.edited_by,updated_at=now();
end $$;
revoke all on function pulse.money_tool_save(text,text,date,int,int) from public;
grant execute on function pulse.money_tool_save(text,text,date,int,int) to pulse_api;
create or replace function pulse.money_read(p_dataset text,p_offset int default 0) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb; show_amount boolean;
begin
 if not money_can('money.read') then raise exception 'money access denied' using errcode='42501'; end if;
 show_amount:=money_can('money.amount.read');
 perform audit_write('restricted_read','money',p_dataset,array[case when show_amount then 'metadata,amount' else 'metadata' end]);
 select jsonb_build_object('total',(select count(*) from pulse_priv.money_observation where dataset=p_dataset),
 'rows',coalesce(jsonb_agg(jsonb_build_object('id',source_key,'dataset',dataset,'approved',approved,'data',
 case when show_amount then payload||coalesce((select jsonb_build_object('category',mc.category) from pulse_priv.money_category mc where mc.dataset=r.dataset and mc.source_key=r.source_key),'{}'::jsonb) else
  (select coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) from jsonb_each(payload) e
   where e.key=any(array['date','last_charge_date','last_observed_date','period','vendor','tool','category','currency','project_key','record_kind','kind','status','active_now','cycle','direction','confidence','owner_account']))
 end,'evidence',case when show_amount then evidence else jsonb_build_object('restricted','Source evidence requires amount permission') end)),'[]'),
 'showAmounts',show_amount) into result from (select * from pulse_priv.money_observation where dataset=p_dataset order by coalesce(payload->>'date',payload->>'last_charge_date',payload->>'last_observed_date') desc nulls last,source_key limit 50 offset greatest(0,p_offset)) r;
 return result;
end $$;
create or replace function pulse.money_workspace() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.read') or not money_can('money.amount.read') then raise exception 'denied' using errcode='42501'; end if;
 perform audit_write('restricted_read','money.workspace');
 return coalesce((select jsonb_agg(jsonb_build_object('id',o.source_key,'dataset',o.dataset,'approved',o.approved,
 'data',o.payload||coalesce((select jsonb_build_object('renewal_date',td.renewal_date,'seats',td.seats,'used_seats',td.used_seats) from pulse_priv.money_tool_detail td where td.dataset=o.dataset and td.source_key=o.source_key),'{}'::jsonb)||case when cat.category is null then '{}'::jsonb else jsonb_build_object('category',cat.category) end,
 'projectId',p.id,'projectName',coalesce(p.title,p.name),'clientId',p.client_id,'clientName',cl.display_name))
 from pulse_priv.money_observation o left join pulse_priv.money_category cat using(org_id,dataset,source_key)
 left join pulse_priv.money_match m using(org_id,dataset,source_key)
 left join lateral(select min(pr.id::text)::uuid id from project pr where lower(trim(pr.project_key))=lower(trim(o.payload->>'project_key')) having count(*)=1) matched on true
 left join project p on p.id=coalesce(m.project_id,matched.id) left join client cl on cl.id=p.client_id),'[]');
end $$;
-- migrate:down
