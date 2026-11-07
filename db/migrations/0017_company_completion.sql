-- migrate:up
-- Staff can read business corrections and their tasks; editing remains restricted.
do $$ declare t text; begin
 foreach t in array array['task','record_link','record_merge','file_correction','record_annotation'] loop
 execute format('drop policy admin_write on pulse.%I',t);
 execute format('create policy admin_insert on pulse.%I as restrictive for insert to pulse_api with check(pulse.viewer_is(''admin''))',t);
 execute format('create policy admin_update on pulse.%I as restrictive for update to pulse_api using(pulse.viewer_is(''admin'')) with check(pulse.viewer_is(''admin''))',t);
 execute format('create policy admin_delete on pulse.%I as restrictive for delete to pulse_api using(pulse.viewer_is(''admin''))',t);
 end loop;
end $$;
create policy task_person on pulse.task as restrictive for select to pulse_api using(
 pulse.viewer_is('admin') or owner_id=pulse.current_viewer() or assignee_person_id=pulse.current_viewer() or
 exists(select 1 from pulse.delivery d join pulse.account a on a.handle=d.uploader_account and a.org_id=d.org_id where d.project_id=task.project_id and a.holder_person_id=pulse.current_viewer() and a.purpose='Workspace account'));
-- Imported and derived business records receive the same metadata-only CRUD trail.
create or replace function pulse.audit_mutation() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j jsonb; oldj jsonb; cols text[]; rid text;
begin
 j:=case when TG_OP='DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if j->>'org_id' is distinct from current_org()::text then return null; end if;
 oldj:=case when TG_OP='UPDATE' then to_jsonb(old) else '{}'::jsonb end;
 select array_agg(k) into cols from jsonb_object_keys(j) k where TG_OP<>'UPDATE' or j->k is distinct from oldj->k;
 if cols is null then return null; end if;
 rid:=coalesce(j->>'id',j->>'person_id',j->>'file_id',j->>'source_key',j->>'day');
 insert into audit_event(org_id,actor_id,actor_account,action,resource,resource_id,fields,source)
 values(current_org(),current_viewer(),nullif(current_setting('pulse.actor_account',true),''),lower(TG_OP),TG_TABLE_NAME,rid,cols,
 case when current_viewer() is null then 'sync' else 'pulse' end);
 return null;
end $$;
do $$ declare r record; begin
 for r in select table_schema,table_name from information_schema.columns where column_name='org_id'
 and table_schema in ('pulse','pulse_priv')
 -- PostgreSQL propagates the parent's trigger to partitions; never create child triggers first.
 and not exists(select 1 from pg_class cl join pg_namespace ns on ns.oid=cl.relnamespace where ns.nspname=columns.table_schema and cl.relname=columns.table_name and cl.relispartition)
 and exists(select 1 from information_schema.tables t where t.table_schema=columns.table_schema and t.table_name=columns.table_name and t.table_type='BASE TABLE') and table_name not in ('audit_event','auth_rate','signin_seen') loop
 if not exists(select 1 from pg_trigger where tgrelid=format('%I.%I',r.table_schema,r.table_name)::regclass and tgname='audit_mutation') then
 execute format('create trigger audit_mutation after insert or update or delete on %I.%I for each row execute function pulse.audit_mutation()',r.table_schema,r.table_name);
 end if;
 end loop;
end $$;
-- Money matches are manual corrections outside the imported payload, so reimports preserve them.
create table pulse_priv.money_match (
 org_id uuid not null references pulse.org(id), dataset text not null, source_key text not null,
 project_id uuid not null references pulse.project(id), edited_by uuid references pulse.person(id), updated_at timestamptz not null default now(),
 primary key(org_id,dataset,source_key),foreign key(org_id,dataset,source_key) references pulse_priv.money_observation(org_id,dataset,source_key)
);
alter table pulse_priv.money_match enable row level security;
alter table pulse_priv.money_match force row level security;
create policy tenant_isolation on pulse_priv.money_match using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.money_match to pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse_priv.money_match for each row execute function pulse.audit_mutation();
create function pulse.money_link(p_dataset text,p_key text,p_project uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.plan.write') then raise exception 'money write denied' using errcode='42501'; end if;
 if not exists(select 1 from project where id=p_project) then raise exception 'project missing' using errcode='22023'; end if;
 insert into pulse_priv.money_match(org_id,dataset,source_key,project_id,edited_by) values(current_org(),p_dataset,p_key,p_project,current_viewer())
 on conflict(org_id,dataset,source_key) do update set project_id=excluded.project_id,edited_by=excluded.edited_by,updated_at=now();
end $$;
create or replace function pulse.money_summary() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare result jsonb;
begin
 if not money_can('money.read') then raise exception 'money access denied' using errcode='42501'; end if;
 perform audit_write('restricted_read','money.summary',null,'{}');
 select jsonb_build_object('datasets',coalesce(jsonb_agg(jsonb_build_object('name',dataset,'rows',n,'approved',approved)),'[]')) into result
 from (select dataset,count(*) n,count(*) filter(where approved) approved from pulse_priv.money_observation group by dataset) r;
 if money_can('money.amount.read') then
 with entries as (
 select o.payload->>'currency' currency,o.payload->>'direction' direction,o.payload->>'project_key' project_key,
 (o.payload->>'amount')::numeric amount,coalesce(m.project_id,matched.id) project_id
 from pulse_priv.money_observation o left join pulse_priv.money_match m using(org_id,dataset,source_key)
 left join lateral(select min(p.id::text)::uuid id from project p where lower(trim(p.project_key))=lower(trim(o.payload->>'project_key')) having count(*)=1) matched on true
 where o.dataset='money_sheet_transactions' and o.approved and (o.payload->>'amount') ~ '^[0-9]+([.][0-9]+)?$' and o.payload->>'direction' in('inflow','outflow')
 ), grouped as (select e.currency,e.direction,e.project_key,e.project_id,coalesce(p.title,p.name) project_name,p.client_id,c.display_name client_name,sum(e.amount) amount
 from entries e left join project p on p.id=e.project_id left join client c on c.id=p.client_id group by 1,2,3,4,5,6,7),
 clients as (select currency,client_id,client_name,sum(amount) amount from grouped where direction='inflow' and client_id is not null group by 1,2,3)
 select result||jsonb_build_object('totals',coalesce((select jsonb_agg(to_jsonb(t)) from grouped t),'[]'),
 'clients',coalesce((select jsonb_agg(to_jsonb(t)) from clients t),'[]')) into result;
 end if;
 return result;
end $$;
create or replace function pulse.money_approve(p_dataset text,p_key text,p_approved boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.plan.write') or not money_can('money.amount.read') then raise exception 'money write denied' using errcode='42501'; end if;
 if p_approved and p_dataset='money_sheet_transactions' and exists(select 1 from pulse_priv.money_observation where dataset=p_dataset and source_key=p_key and
 (coalesce(payload->>'amount','') !~ '^[0-9]+([.][0-9]+)?$' or coalesce(payload->>'direction','') not in('inflow','outflow') or coalesce(payload->>'currency','') !~ '^[A-Z]{3}$')) then
 raise exception 'confirm a valid amount, direction and currency before reconciliation' using errcode='22023'; end if;
 update pulse_priv.money_observation set approved=p_approved,approved_by=current_viewer() where dataset=p_dataset and source_key=p_key;
 if not found then raise exception 'money record missing' using errcode='22023'; end if;
end $$;
revoke all on function pulse.money_link(text,text,uuid) from public;
grant execute on function pulse.money_link(text,text,uuid) to pulse_api;
-- migrate:down
