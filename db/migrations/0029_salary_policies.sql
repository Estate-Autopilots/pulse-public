-- migrate:up
alter table pulse_priv.hr_compensation add column components jsonb not null default '{}',add column effective_from date,add column effective_to date;
-- Existing collapsed sheet text does not preserve column positions. Unknown components remain unknown.
update pulse_priv.hr_compensation set effective_from=effective_month;
create function pulse.hr_salary_components_write(p_person uuid,p_month date,p_kind text,p_amount numeric,p_note text,p_components jsonb,p_from date,p_to date) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k text; val jsonb; sid uuid;
begin
 if not hr_can('hr.salary.write') then raise exception 'salary access denied' using errcode='42501'; end if;
 if not exists(select 1 from person where id=p_person and side='staff' and org_id=current_org()) then raise exception 'existing employee required' using errcode='22023'; end if;
 if jsonb_typeof(p_components)<>'object' or p_to<p_from then raise exception 'invalid components/dates' using errcode='22023'; end if;
 for k,val in select key,value from jsonb_each(p_components) loop
  if k not in ('ctc','fixed','variable','bonus','reimbursements','deductions') or jsonb_typeof(val)<>'number' or val::text!~'^[0-9]+([.][0-9]+)?$' or val::text::numeric>1e10 then raise exception 'invalid component' using errcode='22023'; end if;
 end loop;
 sid:=hr_salary_write(p_person,p_month,p_kind,p_amount,p_note);
 update pulse_priv.hr_compensation set components=p_components,effective_from=coalesce(p_from,p_month),effective_to=p_to where id=sid;
 return sid;
end $$;
create function pulse.hr_salary_components_read(p_person uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not hr_can('hr.salary.read') then raise exception 'denied' using errcode='42501'; end if;
 perform hr_log(p_person,'hr.salary','hr_profile_components');
 return coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'month',c.effective_month,'kind',c.kind,'amount',c.amount,'currency',c.currency,
 'sourceName',c.source_name,'sourceSheet',c.source_sheet,'basis',c.basis,'components',c.components,'effectiveFrom',c.effective_from,'effectiveTo',c.effective_to)
 order by c.effective_month desc,c.kind) from pulse_priv.hr_compensation c where c.person_id=p_person),'[]');
end $$;
-- Policy versions are immutable; acknowledgements always refer to the exact document version read.
create table pulse.policy_document (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),kind text not null check(kind in ('leave','wfh','attendance','expenses','travel','conduct')),
 version int not null check(version>0),title text not null,body text not null,status text not null check(status in ('draft','published')),created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 unique(org_id,kind,version)
);
create table pulse.policy_ack (
 org_id uuid not null references pulse.org(id),document_id uuid not null references pulse.policy_document(id),person_id uuid not null references pulse.person(id),at timestamptz not null default now(),primary key(org_id,document_id,person_id)
);
do $$ declare t text;begin foreach t in array array['policy_document','policy_ack'] loop
 execute format('alter table pulse.%I enable row level security',t);execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('grant select on pulse.%I to pulse_api',t);execute format('grant select,insert,update,delete on pulse.%I to pulse_worker',t);
 execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;end $$;
create policy visible on pulse.policy_document as restrictive to pulse_api using(status='published' or pulse.viewer_is('admin','leadership','hr'));
create policy visible on pulse.policy_ack as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','leadership','hr'));
create function pulse.policy_save(p_kind text,p_title text,p_body text,p_status text,p_version int) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare latest int; nid uuid;
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'denied' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtext(current_org()::text||p_kind));
 select coalesce(max(version),0) into latest from policy_document where kind=p_kind;
 if p_version<>latest then raise exception 'document changed; refresh before editing' using errcode='40001'; end if;
 if length(p_body) not between 10 and 30000 or length(p_title) not between 2 and 100 then raise exception 'invalid policy' using errcode='22023'; end if;
 insert into policy_document(org_id,kind,version,title,body,status,created_by) values(current_org(),p_kind,latest+1,p_title,p_body,p_status,current_viewer()) returning id into nid;
 return nid;
end $$;
create function pulse.policy_acknowledge(p_document uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not exists(select 1 from person where id=current_viewer() and side='staff' and status='active') then raise exception 'employee required' using errcode='42501'; end if;
 if not exists(select 1 from policy_document where id=p_document and status='published' and not exists(select 1 from policy_document newer where newer.kind=policy_document.kind and newer.version>policy_document.version and newer.status='published')) then raise exception 'choose current published policy' using errcode='22023'; end if;
 insert into policy_ack(org_id,document_id,person_id) values(current_org(),p_document,current_viewer()) on conflict do nothing;
end $$;
revoke all on function pulse.hr_salary_components_write(uuid,date,text,numeric,text,jsonb,date,date),pulse.hr_salary_components_read(uuid),pulse.policy_save(text,text,text,text,int),pulse.policy_acknowledge(uuid) from public;
grant execute on function pulse.hr_salary_components_write(uuid,date,text,numeric,text,jsonb,date,date),pulse.hr_salary_components_read(uuid),pulse.policy_save(text,text,text,text,int),pulse.policy_acknowledge(uuid) to pulse_api;
-- Faster project matching: aggregate project keys once rather than scanning for every observation.
create or replace function pulse.money_workspace() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not money_can('money.read') or not money_can('money.amount.read') then raise exception 'denied' using errcode='42501'; end if;
 perform audit_write('restricted_read','money.workspace');
 return coalesce((select jsonb_agg(jsonb_build_object('id',o.source_key,'dataset',o.dataset,'approved',o.approved,
 'data',o.payload||coalesce((select jsonb_build_object('renewal_date',td.renewal_date,'seats',td.seats,'used_seats',td.used_seats) from pulse_priv.money_tool_detail td where td.dataset=o.dataset and td.source_key=o.source_key),'{}'::jsonb)||case when cat.category is null then '{}'::jsonb else jsonb_build_object('category',cat.category) end,
 'projectId',p.id,'projectName',coalesce(p.title,p.name),'clientId',p.client_id,'clientName',cl.display_name))
 from pulse_priv.money_observation o left join pulse_priv.money_category cat using(org_id,dataset,source_key)
 left join pulse_priv.money_match m using(org_id,dataset,source_key)
 left join (select lower(trim(project_key)) project_key,min(id::text)::uuid id from project group by lower(trim(project_key)) having count(*)=1) matched on matched.project_key=lower(trim(o.payload->>'project_key'))
 left join project p on p.id=coalesce(m.project_id,matched.id) left join client cl on cl.id=p.client_id),'[]');
end $$;
-- migrate:down
