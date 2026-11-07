-- migrate:up
-- COMP-B (owner, 13 Oct 2026): the running people budget and the cash projection's what-if. A budget per month and pod
-- (leadership sets it or seeds it from the last three months), planned roles (R49 jobs or roles without one) with their
-- planned cost, and saved scenarios. docs/ops/PAYROLL.md.
--  * Amounts are sealed by the API (budget cells, a role's planned cost, a scenario's steps); these functions decide who
--    has them and log the look. Readers: comp_reader() (HR, leadership, an admin with hr.salary.read). Setters:
--    leadership (an approver of pay, or the leadership role with the salary permission).
--  * Pay never enters R49's matcher: a planned role's cost lives here, keyed by the job, not on the job.
--  * Scenarios never touch records: applying a step is done through COMP-A's own flows.

create table pulse.pay_budget (
 org_id uuid not null references pulse.org(id),
 month date not null check (extract(day from month)=1),
 pod text not null default '' check (length(pod)<=80),
 source text not null default 'set' check (source in ('set','seeded')),
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=4096),
 set_by uuid, set_at timestamptz not null default now(),
 primary key (org_id, month, pod)
);
create table pulse.pay_plan_role (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 job_id uuid references pulse.ats_job(id) on delete set null,
 title text not null check (length(btrim(title)) between 2 and 120),
 pod text check (length(pod)<=80),
 count int not null default 1 check (count between 1 and 50),
 from_month date not null check (extract(day from from_month)=1),
 status text not null default 'planned' check (status in ('planned','filled','dropped')),
 note text check (length(note)<=500),
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=4096),
 created_by uuid, created_at timestamptz not null default now(), updated_by uuid, updated_at timestamptz not null default now()
);
create table pulse.pay_scenario (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 name text not null check (length(btrim(name)) between 2 and 80),
 note text check (length(note)<=500),
 steps int not null default 0 check (steps between 0 and 40),
 s_kid text not null check (s_kid ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'), s_key bytea not null, s_data bytea not null check (octet_length(s_data)<=32768),
 created_by uuid, created_at timestamptz not null default now(), updated_by uuid, updated_at timestamptz not null default now(), archived_at timestamptz
);

do $$ declare t text; begin
 foreach t in array array['pay_budget','pay_plan_role','pay_scenario'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant on pulse.%I using (org_id=pulse.current_org()) with check (org_id=pulse.current_org())',t);
  execute format('revoke all on pulse.%I from pulse_api',t);
  execute format('grant select on pulse.%I to pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;

-- Leadership plans: an approver of pay, or the leadership role with the salary permission.
create function pulse.pay_planner() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (comp_is_approver() or comp_has_role(current_viewer(),'leadership') and comp_reader()) $$;

-- ------------------------------------------------------------------------------------------------- budget
create function pulse.pay_budget_sealed(p_from date, p_to date) returns table(month date, pod text, source text, set_by text, set_at timestamptz, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not comp_reader() then raise exception 'The people budget is for founders and HR' using errcode='42501'; end if;
 perform comp_log(null,'comp.budget','budget_view');
 return query select b.month,b.pod,b.source,comp_name(b.set_by),b.set_at,b.s_kid,b.s_key,b.s_data from pay_budget b
  where b.org_id=current_org() and b.month between date_trunc('month',p_from)::date and p_to order by b.month,b.pod;
end $$;
-- Cells: [{month, pod, sealed}] (a null sealed clears the cell).
create function pulse.pay_budget_save(p jsonb) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x jsonb; n int:=0; v_source text:=case when p->>'source'='seeded' then 'seeded' else 'set' end;
begin
 if not pay_planner() then raise exception 'Leadership sets the people budget' using errcode='42501'; end if;
 if jsonb_array_length(coalesce(p->'cells','[]'))>600 then raise exception 'Too many budget cells at once' using errcode='22023'; end if;
 for x in select value from jsonb_array_elements(coalesce(p->'cells','[]')) loop
  if (x->>'month')::date is null or extract(day from (x->>'month')::date)<>1 then raise exception 'Budget cells are by month' using errcode='22023'; end if;
  if x->'sealed' is null or jsonb_typeof(x->'sealed')='null' then
   delete from pay_budget where org_id=current_org() and month=(x->>'month')::date and pod=coalesce(x->>'pod','');
  else
   perform comp_sealed_check(x->'sealed');
   insert into pay_budget(org_id,month,pod,source,s_kid,s_key,s_data,set_by) values(current_org(),(x->>'month')::date,left(coalesce(x->>'pod',''),80),v_source,
    x->'sealed'->>'kid',decode(x->'sealed'->>'key','base64'),decode(x->'sealed'->>'data','base64'),current_viewer())
   on conflict (org_id,month,pod) do update set source=excluded.source,s_kid=excluded.s_kid,s_key=excluded.s_key,s_data=excluded.s_data,set_by=excluded.set_by,set_at=now();
  end if;
  n:=n+1;
 end loop;
 perform audit_write('people_budget_set','comp.budget',n::text);
 return n;
end $$;

-- ------------------------------------------------------------------------------------------- planned roles
create function pulse.pay_roles_sealed() returns table(id uuid, job_id uuid, job text, job_status text, title text, pod text, count int, from_month date, status text, note text,
 created_by text, updated_at timestamptz, kid text, dkey bytea, data bytea) language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not comp_reader() then raise exception 'Planned roles are for founders and HR' using errcode='42501'; end if;
 perform comp_log(null,'comp.budget','roles_view');
 return query select r.id,r.job_id,j.title,j.status,r.title,r.pod,r.count,r.from_month,r.status,r.note,comp_name(r.created_by),r.updated_at,r.s_kid,r.s_key,r.s_data
  from pay_plan_role r left join ats_job j on j.id=r.job_id where r.org_id=current_org() order by (r.status='planned') desc,r.from_month,r.title;
end $$;
create function pulse.pay_role_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_id uuid:=nullif(p->>'id','')::uuid; v_job uuid:=nullif(p->>'jobId','')::uuid;
begin
 if not pay_planner() then raise exception 'Leadership plans roles and their cost' using errcode='42501'; end if;
 if v_job is not null and not exists(select 1 from ats_job where org_id=current_org() and id=v_job) then raise exception 'Choose an open job' using errcode='22023'; end if;
 if v_id is not null and exists(select 1 from pay_plan_role where org_id=current_org() and id=v_id) then
  if p ? 'sealed' then perform comp_sealed_check(p->'sealed'); end if;
  update pay_plan_role set job_id=case when p ? 'jobId' then v_job else job_id end,title=coalesce(nullif(btrim(p->>'title'),''),title),pod=case when p ? 'pod' then nullif(btrim(p->>'pod'),'') else pod end,
   count=coalesce((p->>'count')::int,count),from_month=coalesce(date_trunc('month',(p->>'from')::date)::date,from_month),status=coalesce(p->>'status',status),
   note=case when p ? 'note' then nullif(btrim(p->>'note'),'') else note end,
   s_kid=coalesce(p->'sealed'->>'kid',s_kid),s_key=coalesce(decode(p->'sealed'->>'key','base64'),s_key),s_data=coalesce(decode(p->'sealed'->>'data','base64'),s_data),
   updated_by=current_viewer(),updated_at=now() where id=v_id;
  return v_id;
 end if;
 perform comp_sealed_check(p->'sealed');
 insert into pay_plan_role(org_id,id,job_id,title,pod,count,from_month,note,s_kid,s_key,s_data,created_by,updated_by)
 values(current_org(),coalesce(v_id,gen_random_uuid()),v_job,btrim(coalesce(p->>'title','')),nullif(btrim(p->>'pod'),''),coalesce((p->>'count')::int,1),date_trunc('month',(p->>'from')::date)::date,
  nullif(btrim(p->>'note'),''),p->'sealed'->>'kid',decode(p->'sealed'->>'key','base64'),decode(p->'sealed'->>'data','base64'),current_viewer(),current_viewer()) returning id into v_id;
 return v_id;
end $$;
-- Open jobs to link a planned role to (titles only; R49's own rules decide everything else about jobs).
create function pulse.pay_jobs() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not comp_reader() then raise exception 'Planned roles are for founders and HR' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'title',j.title,'status',j.status) order by j.title) from ats_job j where j.org_id=current_org() and j.status in ('draft','open')),'[]');
end $$;

-- ---------------------------------------------------------------------------------------------- scenarios
create function pulse.pay_scenarios_sealed() returns table(id uuid, name text, note text, steps int, created_by text, created_at timestamptz, updated_by text, updated_at timestamptz,
 kid text, dkey bytea, data bytea) language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not comp_reader() then raise exception 'Scenarios are for founders and HR' using errcode='42501'; end if;
 perform comp_log(null,'comp.scenario','scenarios_view');
 return query select s.id,s.name,s.note,s.steps,comp_name(s.created_by),s.created_at,comp_name(s.updated_by),s.updated_at,s.s_kid,s.s_key,s.s_data
  from pay_scenario s where s.org_id=current_org() and s.archived_at is null order by s.updated_at desc;
end $$;
create function pulse.pay_scenario_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_id uuid:=nullif(p->>'id','')::uuid;
begin
 if not pay_planner() then raise exception 'Leadership saves scenarios' using errcode='42501'; end if;
 perform comp_sealed_check(p->'sealed');
 if v_id is not null and exists(select 1 from pay_scenario where org_id=current_org() and id=v_id and archived_at is null) then
  update pay_scenario set name=btrim(coalesce(p->>'name',name)),note=nullif(btrim(coalesce(p->>'note','')),''),steps=coalesce((p->>'steps')::int,steps),
   s_kid=p->'sealed'->>'kid',s_key=decode(p->'sealed'->>'key','base64'),s_data=decode(p->'sealed'->>'data','base64'),updated_by=current_viewer(),updated_at=now() where id=v_id;
  return v_id;
 end if;
 insert into pay_scenario(org_id,id,name,note,steps,s_kid,s_key,s_data,created_by,updated_by)
 values(current_org(),coalesce(v_id,gen_random_uuid()),btrim(coalesce(p->>'name','')),nullif(btrim(coalesce(p->>'note','')),''),coalesce((p->>'steps')::int,0),
  p->'sealed'->>'kid',decode(p->'sealed'->>'key','base64'),decode(p->'sealed'->>'data','base64'),current_viewer(),current_viewer()) returning id into v_id;
 return v_id;
end $$;
create function pulse.pay_scenario_archive(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not pay_planner() then raise exception 'Leadership archives scenarios' using errcode='42501'; end if;
 update pay_scenario set archived_at=now(),updated_by=current_viewer() where org_id=current_org() and id=p_id and archived_at is null;
 if not found then raise exception 'Scenario not found' using errcode='P0002'; end if;
end $$;

-- ------------------------------------------------------------------------------------------- projection
-- Everyone whose pay records count for the next months (no amounts): versions, pauses, approved one-time pay, last
-- days, probation ends, offers and changes still waiting. One log line per person.
create function pulse.pay_projection_inputs() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare today date:=lifecycle_today(); pol comp_policy:=comp_policy_row(); out jsonb;
begin
 if not comp_reader() then raise exception 'People cost is for founders and HR' using errcode='42501'; end if;
 perform comp_log(null,'comp.pay','projection_list');
 select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id',p.id,'name',p.display_name,'pod',pp.pod,'department',pp.department,'status',c.status,'current',p.status='active',
   'start',c.start_on,'end',coalesce(c.end_on,e.last_working_day),'probationTo',case when c.confirmed_on is null then e.probation_to end,
   'versions',(select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'effectiveOn',v.effective_on,'payType',v.pay_type,'kind',v.kind) order by v.effective_on,v.decided_at),'[]')
     from comp_change v where v.person_id=c.person_id and v.status='approved'),
   'pauses',(select coalesce(jsonb_agg(jsonb_build_object('from',z.from_on,'to',coalesce(z.ended_on,z.to_on),'paidPercent',z.paid_percent)),'[]') from comp_pause z where z.person_id=c.person_id and z.status='approved'),
   'items',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'forMonth',i.for_month,'payout',i.payout)),'[]') from comp_item i where i.person_id=c.person_id and i.status='approved'
     and i.kind in ('bonus','incentive','extra','overtime','arrears')),
   'pending',(select coalesce(jsonb_agg(x),'[]') from (
     select jsonb_build_object('id',o.change_id,'kind','offer','from',o.start_on,'payType',v.pay_type,'label','Offer: '||o.role,'status',o.status) x
      from comp_offer o join comp_change v on v.id=o.change_id where o.person_id=c.person_id and o.status in ('draft','proposed','approved','sent')
     union all select jsonb_build_object('id',v.id,'kind','change','from',v.effective_on,'payType',v.pay_type,'label',v.kind,'status',v.status)
      from comp_change v where v.person_id=c.person_id and v.kind<>'offer' and v.status='proposed') y)
  ))),'[]') into out
 from comp_record c join person p on p.id=c.person_id left join people_profile pp on pp.person_id=c.person_id left join hr_employment e on e.person_id=c.person_id
 where c.org_id=current_org() and (c.end_on is null or c.end_on>=date_trunc('month',today)-interval '12 months')
  and not exists(select 1 from record_merge m where m.entity_type='person' and m.gone_id=p.id and m.undone_at is null);
 return jsonb_build_object('today',today,'people',out,'components',pol.components,'currency',pol.currency,'planner',pay_planner(),'writer',comp_writer());
end $$;
create function pulse.pay_projection_sealed() returns table(kind text, id uuid, person_id uuid, kid text, dkey bytea, data bytea)
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare today date:=lifecycle_today();
begin
 if not comp_reader() then raise exception 'People cost is for founders and HR' using errcode='42501'; end if;
 perform comp_log(c.person_id,'comp.pay','projection') from comp_record c where c.org_id=current_org() and (c.end_on is null or c.end_on>=date_trunc('month',today)-interval '12 months');
 return query
  select 'change'::text,v.id,v.person_id,v.s_kid,v.s_key,v.s_data from comp_change v join comp_record c on c.person_id=v.person_id
   where v.org_id=current_org() and (v.status='approved' or v.status='proposed' and v.kind<>'offer'
    or v.kind='offer' and exists(select 1 from comp_offer o where o.change_id=v.id and o.status in ('draft','proposed','approved','sent')))
   and (c.end_on is null or c.end_on>=date_trunc('month',today)-interval '12 months')
  union all select 'item',i.id,i.person_id,i.s_kid,i.s_key,i.s_data from comp_item i where i.org_id=current_org() and i.status='approved' and i.kind in ('bonus','incentive','extra','overtime','arrears')
   and i.for_month>=date_trunc('month',today)-interval '12 months';
end $$;

do $$ declare f text; begin
 for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='pulse'
  and p.proname in ('pay_planner','pay_budget_sealed','pay_budget_save','pay_roles_sealed','pay_role_save','pay_jobs','pay_scenarios_sealed','pay_scenario_save',
   'pay_scenario_archive','pay_projection_inputs','pay_projection_sealed') loop
  execute format('revoke all on function %s from public',f);
  execute format('grant execute on function %s to pulse_api',f);
 end loop;
end $$;

-- migrate:down
-- Forward-only.
