-- migrate:up
-- LIFECYCLE parts 2–4 (owner, 11 Oct 2026): what each person is worth to the company against what they cost, role
-- seats and how holders of the same seat compare, and the best-fit people for a task or a project.
-- * Value is for founders and HR (the salary permission; every view is logged), never on a public ranking. Per person
--   per month: salary (pulse_priv.hr_compensation) against value created. Value is the month's invoiced revenue
--   (finance live) shared out to the work that earned it: revenue from a client Pulse can link goes to the people who
--   finished that client's tasks and deliveries that month or the one before, by work units; revenue it cannot link
--   is shared by everyone's work units that month. A work unit is an accepted task's value points (else 1 per finished
--   task) plus 1 per credited delivery. The band (Strong, On par, Below) compares value ÷ cost with the company's
--   median that month, with a ramp-up allowance in the first 90 days. Method and confidence travel with every figure.
--   A person sees their own work and value, never anyone's cost.
-- * A role seat is a role in a pod with its main kind of work. Holders of one seat are compared by tenure month
--   (leadership only), normalised for the season and the work they were given, with sample sizes, and "too early to
--   judge" before 60 days.
-- * Fit: who suits a task or a project (domains, the same kind of work done well and fast, load, leave, the client),
--   each with one line of reasons. Nothing here writes to a person or a task.

-- 1. Work and money, per person per month (internal helpers) --------------------------------------------------------
create function pulse.value_key(p text) returns text language sql immutable as $$
 select btrim(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(p,'')),'[^a-z0-9 ]',' ','g'),
  '\m(developers?|group|llp|pvt|private|ltd|limited|aop|realty|realtors?|infra|infrastructure|builders?|constructions?|properties|the|and|co|company|projects?|homes|estates?|associates|enterprises?|ventures|india|ms)\M','','g'),'\s+',' ','g'))
$$;
-- A finance client name to a Pulse client: the client's name, or a project filed under it, once legal words are gone.
create function pulse.value_client_of(p_name text) returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 select client_id from (
  select c.id client_id,0 o from client c where c.org_id=current_org() and value_key(p_name)<>'' and value_key(c.display_name)=value_key(p_name)
  union all select p.client_id,1 from project p where p.org_id=current_org() and p.client_id is not null and value_key(p_name)<>'' and value_key(coalesce(p.title,p.name))=value_key(p_name)
 ) x order by o limit 1
$$;
create function pulse.value_revenue(p_from date,p_to date) returns table(month date,client_id uuid,client text,amount numeric) language sql stable security definer set search_path=pulse,pg_temp as $$
 select (m.key||'-01')::date,value_client_of(x->>'client'),x->>'client',sum((m.value#>>'{}')::numeric)
 from pulse_priv.finance_live_model f cross join lateral jsonb_array_elements(coalesce(f.body->'revenue'->'clients','[]')) x
 cross join lateral jsonb_each(coalesce(x->'months','{}')) m
 where f.org_id=current_org() and m.key ~ '^\d{4}-\d{2}$' and jsonb_typeof(m.value)='number' and (m.key||'-01')::date between date_trunc('month',p_from)::date and p_to
 group by 1,2,3
$$;
create function pulse.value_done_on(t pulse.task) returns date language sql immutable as $$
 select coalesce((coalesce(t.done_at,t.accepted_at) at time zone 'Asia/Kolkata')::date,t.work_on)
$$;
create function pulse.value_units(p_from date,p_to date,p_person uuid default null) returns table(person_id uuid,month date,client_id uuid,category text,units numeric,points numeric,
 tasks int,accepted int,ontime int,with_due int,returned int,deliveries int) language sql stable security definer set search_path=pulse,pg_temp as $$
 with t as (
  select coalesce(t.assignee_person_id,t.owner_id) person_id,date_trunc('month',value_done_on(t))::date as month,pr.client_id,t.category,
   coalesce((select sum(c.points) from work_credit c where c.task_id=t.id and c.reversed_at is null),case when t.accepted_at is not null then nullif(t.effort*t.impact,0) end,1)::numeric units,
   coalesce((select sum(c.points) from work_credit c where c.task_id=t.id and c.reversed_at is null),0)::numeric points,
   (t.accepted_at is not null)::int accepted,(t.due_at is not null and coalesce(t.done_at,t.accepted_at)<=t.due_at)::int ontime,(t.due_at is not null and t.done_at is not null)::int with_due,
   (select count(*) from task_event e where e.task_id=t.id and e.kind='returned')::int returned
  from task t left join project pr on pr.id=t.project_id
  where t.org_id=current_org() and t.status='done' and coalesce(t.assignee_person_id,t.owner_id) is not null and (p_person is null or coalesce(t.assignee_person_id,t.owner_id)=p_person)
   and value_done_on(t) between date_trunc('month',p_from)::date and p_to
 ), d as (
  select a.actor_id person_id,date_trunc('month',(dl.delivered_at at time zone 'Asia/Kolkata'))::date as month,pr.client_id,count(*)::int n
  from delivery dl join delivery_actor a on a.org_id=dl.org_id and a.file_id=dl.file_id left join project pr on pr.id=dl.project_id
  where dl.org_id=current_org() and a.actor_id is not null and (p_person is null or a.actor_id=p_person)
   and (dl.delivered_at at time zone 'Asia/Kolkata')::date between date_trunc('month',p_from)::date and p_to
  group by 1,2,3
 )
 select person_id,month,client_id,category,sum(units),sum(points),sum(tasks)::int,sum(accepted)::int,sum(ontime)::int,sum(with_due)::int,sum(returned)::int,sum(deliveries)::int from (
  select person_id,month,client_id,category,units,points,1 tasks,accepted,ontime,with_due,returned,0 deliveries from t
  union all select person_id,month,client_id,null,n,0,0,0,0,0,0,n from d) u group by 1,2,3,4
$$;
-- Salary for a month: that month's payroll row, else the latest current salary in force. Row security on the salary
-- table binds this function too: without the salary permission it sees nothing.
create function pulse.value_cost(p_from date,p_to date) returns table(person_id uuid,month date,amount numeric) language sql stable security definer set search_path=pulse,pg_temp as $$
 select x.person_id,m::date,(select c.amount from pulse_priv.hr_compensation c where c.person_id=x.person_id and c.kind in ('monthly','current')
   and coalesce(c.effective_from,c.effective_month)<=(m+interval '1 month'-interval '1 day')::date and (c.effective_to is null or c.effective_to>=m::date)
   order by (c.kind='monthly' and c.effective_month=m::date) desc,coalesce(c.effective_from,c.effective_month) desc,c.imported_at desc limit 1)
 from (select distinct person_id from pulse_priv.hr_compensation where org_id=current_org()) x cross join generate_series(date_trunc('month',p_from),p_to,interval '1 month') m
$$;
create function pulse.value_rows(p_month date) returns table(person_id uuid,cost numeric,value numeric,linked numeric,pooled numeric,units numeric,points numeric,tasks int,accepted int,
 ontime int,with_due int,returned int,deliveries int,revenue numeric,linked_revenue numeric) language sql stable security definer set search_path=pulse,pg_temp as $$
 with m as (select date_trunc('month',p_month)::date m,(date_trunc('month',p_month)+interval '1 month'-interval '1 day')::date e),
 rev as (select r.client_id,sum(r.amount) amount from m,value_revenue(m.m,m.e) r group by 1),
 w2 as (select u.person_id,u.client_id,sum(u.units) units from m,value_units((m.m-interval '1 month')::date,m.e) u where u.client_id is not null group by 1,2),
 wc as (select client_id,sum(units) total from w2 group by 1),
 linked as (select w2.person_id,sum(rev.amount*w2.units/wc.total) amount from w2 join wc using(client_id) join rev using(client_id) group by 1),
 pool as (select coalesce(sum(rev.amount) filter(where rev.client_id is null or not exists(select 1 from wc where wc.client_id=rev.client_id)),0) amount,
   coalesce(sum(rev.amount),0) total,coalesce(sum(rev.amount) filter(where exists(select 1 from wc where wc.client_id=rev.client_id)),0) linked from rev),
 cur as (select u.person_id,sum(units) units,sum(points) points,sum(tasks)::int tasks,sum(accepted)::int accepted,sum(ontime)::int ontime,sum(with_due)::int with_due,
   sum(returned)::int returned,sum(deliveries)::int deliveries from m,value_units(m.m,m.e) u group by 1),
 tot as (select nullif(sum(units),0) units from cur),
 cost as (select c.person_id,c.amount from m,value_cost(m.m,m.m) c where c.amount is not null)
 select p.id,cost.amount,coalesce(linked.amount,0)+coalesce(pool.amount*cur.units/tot.units,0),coalesce(linked.amount,0),coalesce(pool.amount*cur.units/tot.units,0),
  coalesce(cur.units,0),coalesce(cur.points,0),coalesce(cur.tasks,0),coalesce(cur.accepted,0),coalesce(cur.ontime,0),coalesce(cur.with_due,0),coalesce(cur.returned,0),coalesce(cur.deliveries,0),
  pool.total,pool.linked
 from person p cross join pool cross join tot left join cur on cur.person_id=p.id left join linked on linked.person_id=p.id left join cost on cost.person_id=p.id
 where p.org_id=current_org() and p.side='staff' and (cur.person_id is not null or linked.person_id is not null or cost.person_id is not null)
$$;

-- 2. The value view (founders and HR) and one's own -------------------------------------------------------------------
create function pulse.value_band(p_ratio numeric,p_median numeric,p_tenure int,p_units numeric) returns jsonb language sql immutable as $$
 select case when p_tenure is not null and p_tenure<30 then jsonb_build_object('band','ramp','allowance',0)
  when p_ratio is null then jsonb_build_object('band','no_cost','allowance',1)
  when coalesce(p_units,0)=0 then jsonb_build_object('band','not_measured','allowance',1)
  else (select jsonb_build_object('band',case when p_median is null or p_median=0 then 'not_measured' when p_ratio/a>=1.25*p_median then 'strong' when p_ratio/a>=0.75*p_median then 'on_par' else 'below' end,'allowance',a)
   from (select case when p_tenure is null or p_tenure>=90 then 1.0 when p_tenure>=60 then 0.75 else 0.5 end a) x) end
$$;
create function pulse.value_view(p_month date default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare m date:=date_trunc('month',coalesce(p_month,lifecycle_today()))::date;e date;med numeric;v_rows jsonb;company jsonb;k int;r record;
begin
 if current_viewer() is null or not hr_can('hr.salary.read') then raise exception 'Value and cost are for founders and HR, like salaries' using errcode='42501';end if;
 e:=(m+interval '1 month'-interval '1 day')::date;
 create temporary table if not exists value_now(person_id uuid,cost numeric,value numeric,linked numeric,pooled numeric,units numeric,points numeric,tasks int,accepted int,ontime int,
  with_due int,returned int,deliveries int,revenue numeric,linked_revenue numeric) on commit drop;
 truncate value_now;
 insert into value_now select * from value_rows(m);
 select percentile_cont(0.5) within group(order by v.value/v.cost) into med from value_now v join people_profile pp on pp.person_id=v.person_id
  where v.cost>0 and v.units>0 and (pp.joined_on is null or e-pp.joined_on>=90);
 -- Six months of value ÷ cost per person, for the trend.
 create temporary table if not exists value_trend(person_id uuid,month date,ratio numeric) on commit drop;
 truncate value_trend;
 for k in 0..5 loop
  insert into value_trend select x.person_id,(m-make_interval(months=>k))::date,case when x.cost>0 then round(x.value/x.cost,2) end from value_rows((m-make_interval(months=>k))::date) x;
 end loop;
 select coalesce(jsonb_agg(jsonb_build_object('person',jsonb_build_object('id',p.id,'name',p.display_name,'role',pp.role,'pod',pp.pod,'department',pp.department,'joinedOn',pp.joined_on,
   'photoAt',(select updated_at from person_photo ph where ph.person_id=p.id),'stage',lifecycle_stage(p.id)),
   'cost',round(v.cost),'value',round(v.value),'linked',round(v.linked),'pooled',round(v.pooled),'ratio',case when v.cost>0 then round(v.value/v.cost,2) end,
   'units',v.units,'points',v.points,'tasks',v.tasks,'accepted',v.accepted,'deliveries',v.deliveries,'returned',v.returned,
   'acceptRate',case when v.tasks>0 then round(v.accepted::numeric/v.tasks,2) end,'onTimeRate',case when v.with_due>0 then round(v.ontime::numeric/v.with_due,2) end,'withDue',v.with_due,
   'tenureDays',case when pp.joined_on is not null then e-pp.joined_on end,
   'band',value_band(case when v.cost>0 then v.value/v.cost end,med,case when pp.joined_on is not null then e-pp.joined_on end,v.units),
   'confidence',case when v.cost is null then 'low' when v.units>=10 and v.linked>=v.value*0.5 then 'high' when v.units>=3 then 'medium' else 'low' end,
   'trend',(select coalesce(jsonb_agg(jsonb_build_object('month',t.month,'ratio',t.ratio) order by t.month),'[]') from value_trend t where t.person_id=p.id))
  order by p.display_name),'[]') into v_rows
 from value_now v join person p on p.id=v.person_id left join people_profile pp on pp.person_id=p.id;
 select jsonb_build_object('revenue',round(max(revenue)),'linkedRevenue',round(max(linked_revenue)),'coverage',case when max(revenue)>0 then round(max(linked_revenue)/max(revenue),2) end,
  'cost',round(sum(cost)),'value',round(sum(value)),'median',round(med,2),'people',count(*),'withCost',count(cost)) into company from value_now;
 for r in select person_id from value_now loop perform hr_log(r.person_id,'hr.value','value_view');end loop;
 return jsonb_build_object('month',m,'rows',v_rows,'company',company,'method',jsonb_build_object(
  'value','The month''s invoiced revenue (Zoho, from finance live) shared out to the work that earned it. Revenue from a client Pulse can link goes to the people who finished that client''s tasks and deliveries this month or last, by work units; the rest is shared by everyone''s work units this month.',
  'units','A work unit is an accepted task''s value points (else 1 per finished task) plus 1 per credited delivery.',
  'cost','Salary for the month from the HR salary records. Tools are not attributed per person yet.',
  'band','Value ÷ cost against the company''s median for the month: Strong at 1.25× the median or more, On par from 0.75×, Below under it. New joiners: no band in the first 30 days; the bar is halved to day 60 and three-quarters to day 90.',
  'confidence','High: the salary is known, 10 or more work units, and at least half the value from linked clients. Medium: the salary and 3 or more units. Low otherwise.'));
end $$;
create function pulse.value_mine(p_months int default 6) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();m date:=date_trunc('month',lifecycle_today())::date;
begin
 if me is null then raise exception 'Sign in with your own account' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('month',x.month,'units',x.units,'points',x.points,'tasks',x.tasks,'accepted',x.accepted,'deliveries',x.deliveries,'returned',x.returned,
   'acceptRate',case when x.tasks>0 then round(x.accepted::numeric/x.tasks,2) end,'onTimeRate',case when x.with_due>0 then round(x.ontime::numeric/x.with_due,2) end) order by x.month)
  from (select u.month,sum(u.units) units,sum(u.points) points,sum(u.tasks)::int tasks,sum(u.accepted)::int accepted,sum(u.deliveries)::int deliveries,sum(u.returned)::int returned,
    sum(u.ontime)::int ontime,sum(u.with_due)::int with_due from value_units((m-make_interval(months=>greatest(1,least(24,p_months))-1))::date,(m+interval '1 month'-interval '1 day')::date,me) u group by 1) x),'[]');
end $$;

-- 3. Role seats and their holders ---------------------------------------------------------------------------------------
create table pulse.role_seat (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 role text not null check(length(btrim(role)) between 2 and 80),pod text check(length(pod)<=80),domain text check(length(domain)<=40),
 label text not null check(length(label) between 2 and 160),created_at timestamptz not null default now()
);
create unique index role_seat_key on pulse.role_seat(org_id,lower(role),coalesce(pod,''),coalesce(domain,''));
create table pulse.seat_holding (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 seat_id uuid not null references pulse.role_seat(id),person_id uuid not null references pulse.person(id),
 from_on date not null,to_on date,check(to_on is null or to_on>=from_on),
 source text not null check(source in ('derived','manual')),note text check(length(note)<=300),
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),retired_at timestamptz
);
create unique index seat_holding_derived on pulse.seat_holding(org_id,person_id) where source='derived' and retired_at is null;
create index seat_holding_seat on pulse.seat_holding(org_id,seat_id) where retired_at is null;
do $$ declare t text;begin
 foreach t in array array['role_seat','seat_holding'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select on pulse.%I to pulse_api',t);
  execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
  execute format('create policy visible on pulse.%I as restrictive for select to pulse_api using(pulse.viewer_is(''admin'',''leadership''))',t);
 end loop;
end $$;
-- Each person's seat: their role in their pod (a leaver's last pod is read from their moves), with the role's main kind
-- of work there. A person who changed role keeps one derived holding for the latest seat; leadership adds history by hand.
create function pulse.seat_sync() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record;sid uuid;n int:=0;
begin
 for r in with base as (
   select p.id,btrim(pp.role) as role,
    coalesce(pp.pod,(select e.detail->'pod'->>'from' from person_lifecycle_event e where e.person_id=p.id and e.kind='change' and e.detail ? 'pod' and e.detail->'pod'->>'to' is null order by e.at desc limit 1)) as pod,
    (select t.category from task t where coalesce(t.assignee_person_id,t.owner_id)=p.id and t.status='done' and t.category is not null group by t.category having count(*)>=3 order by count(*) desc limit 1) as cat,
    coalesce(pp.joined_on,p.active_from,(select min(value_done_on(t)) from task t where coalesce(t.assignee_person_id,t.owner_id)=p.id and t.status='done'),p.created_at::date) as from_on,
    case when p.status<>'active' then coalesce(l.left_on,p.active_to,e.last_working_day,
     (select (date_trunc('month',max(s.last_seen))+interval '1 month'-interval '1 day')::date from person_source s where s.person_id=p.id and s.source='hr_document'),
     (select max(value_done_on(t)) from task t where coalesce(t.assignee_person_id,t.owner_id)=p.id and t.status='done')) end to_on
   from person p join people_profile pp on pp.person_id=p.id left join person_lifecycle l on l.person_id=p.id left join hr_employment e on e.person_id=p.id
   where p.org_id=current_org() and p.side='staff' and coalesce(btrim(pp.role),'')<>'' and coalesce(l.stage,'active') not in ('candidate','offer')
    and not exists(select 1 from record_merge m where m.entity_type='person' and m.gone_id=p.id and m.undone_at is null))
  select b.*,(select x.cat from base x where lower(x.role)=lower(b.role) and coalesce(x.pod,'')=coalesce(b.pod,'') and x.cat is not null group by x.cat order by count(*) desc,x.cat limit 1) as domain
  from base b loop
  insert into role_seat(org_id,role,pod,domain,label) values(current_org(),r.role,r.pod,r.domain,
   r.role||coalesce(' · '||r.pod,'')||coalesce(' · '||(select label from work_category where key=r.domain),''))
  on conflict(org_id,lower(role),coalesce(pod,''),coalesce(domain,'')) do update set label=excluded.label where role_seat.label is distinct from excluded.label returning id into sid;
  if sid is null then select id into sid from role_seat where org_id=current_org() and lower(role)=lower(r.role) and coalesce(pod,'')=coalesce(r.pod,'') and coalesce(domain,'')=coalesce(r.domain,'');end if;
  update seat_holding set retired_at=now() where org_id=current_org() and person_id=r.id and source='derived' and retired_at is null
   and (seat_id<>sid or from_on is distinct from least(r.from_on,coalesce(r.to_on,r.from_on)) or to_on is distinct from r.to_on);
  if not exists(select 1 from seat_holding where org_id=current_org() and person_id=r.id and source='derived' and retired_at is null) then
   insert into seat_holding(org_id,seat_id,person_id,from_on,to_on,source) values(current_org(),sid,r.id,least(r.from_on,coalesce(r.to_on,r.from_on)),r.to_on,'derived');n:=n+1;
  end if;
  sid:=null;
 end loop;
 return n;
end $$;
create function pulse.seat_list() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Seats and holders are for leadership' using errcode='42501';end if;
 perform seat_sync();
 return coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'label',s.label,'role',s.role,'pod',s.pod,'domain',s.domain,
   'holders',(select jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'from',h.from_on,'to',h.to_on,'current',p.status='active' and h.to_on is null,'source',h.source) order by h.from_on)
    from seat_holding h join person p on p.id=h.person_id where h.seat_id=s.id and h.retired_at is null),
   'past',(select count(*) from seat_holding h where h.seat_id=s.id and h.retired_at is null and h.to_on is not null),
   'current',(select count(*) from seat_holding h join person p on p.id=h.person_id where h.seat_id=s.id and h.retired_at is null and h.to_on is null and p.status='active'))
  order by s.label) from role_seat s where s.org_id=current_org() and exists(select 1 from seat_holding h where h.seat_id=s.id and h.retired_at is null)),'[]');
end $$;
create function pulse.seat_holder_add(p_seat uuid,p_person uuid,p_from date,p_to date,p_note text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare hid uuid;
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Leadership places people in seats' using errcode='42501';end if;
 if p_from is null or (p_to is not null and p_to<p_from) then raise exception 'Give when they held the seat' using errcode='22023';end if;
 insert into seat_holding(org_id,seat_id,person_id,from_on,to_on,source,note,created_by) values(current_org(),p_seat,p_person,p_from,p_to,'manual',nullif(btrim(coalesce(p_note,'')),''),current_viewer()) returning id into hid;
 return hid;
end $$;
-- Holders of one seat, month by month from their own start: throughput normalised for the season and for the work they
-- were given, quality (acceptance, revisions), on-time, attendance and (with the salary permission) cost.
create function pulse.seat_compare(p_seat uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s role_seat;holders jsonb:='[]';h record;months jsonb;k int;mstart date;mend date;season numeric;avg_units numeric;salary boolean;window_n int;
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Seat comparisons are for leadership' using errcode='42501';end if;
 select * into s from role_seat where org_id=current_org() and id=p_seat;
 if not found then raise exception 'Seat not found' using errcode='P0002';end if;
 salary:=hr_can('hr.salary.read');
 -- The season: the company's work units per calendar month against its average month over the last two years.
 create temporary table if not exists seat_season(month date,units numeric) on commit drop;
 truncate seat_season;
 insert into seat_season select month,sum(units) from value_units((lifecycle_today()-interval '24 months')::date,lifecycle_today()) group by 1;
 select avg(units) into avg_units from seat_season;
 for h in select sh.*,p.display_name name,p.status,(select updated_at from person_photo ph where ph.person_id=p.id) as photo from seat_holding sh join person p on p.id=sh.person_id
   where sh.seat_id=p_seat and sh.retired_at is null order by sh.from_on loop
  months:='[]';
  for k in 0..23 loop
   mstart:=(date_trunc('month',h.from_on)+make_interval(months=>k))::date;mend:=(mstart+interval '1 month'-interval '1 day')::date;
   exit when mstart>coalesce(h.to_on,lifecycle_today());
   select units/nullif(avg_units,0) into season from seat_season where month=mstart;
   months:=months||(select jsonb_build_object('k',k+1,'month',mstart,'units',coalesce(sum(u.units),0),'points',coalesce(sum(u.points),0),'tasks',coalesce(sum(u.tasks),0),
     'accepted',coalesce(sum(u.accepted),0),'returned',coalesce(sum(u.returned),0),'deliveries',coalesce(sum(u.deliveries),0),'onTime',coalesce(sum(u.ontime),0),'withDue',coalesce(sum(u.with_due),0),
     'season',round(coalesce(season,1),2),'normUnits',round(coalesce(sum(u.units),0)/greatest(coalesce(season,1),0.25),1),
     'assigned',(select count(*) from task t where coalesce(t.assignee_person_id,t.owner_id)=h.person_id and (t.assigned_at at time zone 'Asia/Kolkata')::date between mstart and mend),
     'present',(select count(distinct a.work_date) from attendance_effective a where a.person_id=h.person_id and a.work_date between mstart and least(mend,lifecycle_today())),
     'workdays',(select count(*) from generate_series(greatest(mstart,h.from_on),least(mend,coalesce(h.to_on,lifecycle_today())),interval '1 day') d where hr_person_working(h.person_id,d::date)),
     'tracked',exists(select 1 from attendance_effective a where a.org_id=current_org() and a.work_date between mstart and mend),
     'cost',case when salary then (select round(c.amount) from value_cost(mstart,mstart) c where c.person_id=h.person_id) end)
    from value_units(mstart,mend,h.person_id) u);
  end loop;
  holders:=holders||jsonb_build_object('person',jsonb_build_object('id',h.person_id,'name',h.name,'photoAt',h.photo,'current',h.status='active' and h.to_on is null),
   'from',h.from_on,'to',h.to_on,'source',h.source,'note',h.note,'tenureDays',coalesce(h.to_on,lifecycle_today())-h.from_on,'tooEarly',coalesce(h.to_on,lifecycle_today())-h.from_on<60,'months',months);
 end loop;
 -- Holders are compared over the tenure months all of them (past 60 days) have.
 select min(jsonb_array_length(x->'months')) into window_n from jsonb_array_elements(holders) x where not (x->>'tooEarly')::boolean;
 return jsonb_build_object('seat',jsonb_build_object('id',s.id,'label',s.label,'role',s.role,'pod',s.pod,'domain',s.domain),'holders',holders,'window',window_n,'cost',salary,
  'method','Each holder is read month by month from their own first month, so month 3 is everyone''s third month. Work units are normalised for the season (the company''s output that calendar month against its average month) and shown against the tasks they were given; quality is acceptance and work sent back; attendance counts check-in days against working days where check-ins were recorded. Under 60 days is too early to judge.');
end $$;

-- 4. Fit: who suits a task or a project, with one line of reasons -------------------------------------------------------
create function pulse.fit_people(p jsonb) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare t task;v_proj uuid;v_cat text;cat_label text;v_client uuid;v_pod text;lim int:=greatest(1,least(20,coalesce((p->>'limit')::int,5)));today date:=lifecycle_today();
 excl uuid[]:=coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'exclude','[]')) x),'{}');v_head uuid:=nullif(p->>'head','')::uuid;v_out jsonb;
begin
 if current_viewer() is null then raise exception 'Sign in with your own account' using errcode='42501';end if;
 if nullif(p->>'task','') is not null then select * into t from task where org_id=current_org() and id=(p->>'task')::uuid;end if;
 v_proj:=coalesce(nullif(p->>'project','')::uuid,t.project_id);
 v_cat:=coalesce(nullif(p->>'category',''),t.category,case when coalesce(p->>'title',t.title) is not null then work_category_guess(coalesce(p->>'title',t.title)) end);
 select label into cat_label from work_category where org_id=current_org() and key=v_cat;
 select coalesce(nullif(p->>'client','')::uuid,pr.client_id),coalesce(nullif(p->>'pod',''),wp.pod,u.name) into v_client,v_pod
  from (select 1) x left join project pr on pr.id=v_proj left join work_project wp on wp.project_id=v_proj left join unit u on u.id=pr.unit_id;
 with c as (
  select p2.id,p2.display_name name,pp.pod,pp.role,(select updated_at from person_photo ph where ph.person_id=p2.id) as photo,
   (select d.title from work_domain d where d.id=work_domain_match(p2.id,v_proj,v_cat,coalesce(t.tags,'{}'))) as domain,
   (select count(*) from task x where coalesce(x.assignee_person_id,x.owner_id)=p2.id and x.status='done' and v_cat is not null and x.category=v_cat and value_done_on(x)>=today-365) n_cat,
   (select count(*) from task x where coalesce(x.assignee_person_id,x.owner_id)=p2.id and x.status='done' and v_cat is not null and x.category=v_cat and x.accepted_at is not null and value_done_on(x)>=today-365) acc_cat,
   (select count(*) from task x join project y on y.id=x.project_id where coalesce(x.assignee_person_id,x.owner_id)=p2.id and x.status='done' and v_client is not null and y.client_id=v_client and value_done_on(x)>=today-365)
    +(select count(*) from delivery dl join delivery_actor a on a.org_id=dl.org_id and a.file_id=dl.file_id join project y on y.id=dl.project_id where a.actor_id=p2.id and v_client is not null and y.client_id=v_client and dl.delivered_at>=now()-interval '365 days') n_client,
   (select percentile_cont(0.5) within group(order by extract(epoch from x.done_at-coalesce(x.started_at,x.assigned_at,x.created_at))/86400) from task x
     where coalesce(x.assignee_person_id,x.owner_id)=p2.id and x.status='done' and v_cat is not null and x.category=v_cat and x.done_at is not null and value_done_on(x)>=today-365) as days,
   (select count(*) from task x where coalesce(x.assignee_person_id,x.owner_id)=p2.id and x.status in ('open','in_progress','blocked')) as load,
   (select max(l.to_date) from leave_request l where l.person_id=p2.id and l.status='approved' and today between l.from_date and l.to_date) away_until,
   (select min(l.from_date) from leave_request l where l.person_id=p2.id and l.status='approved' and l.from_date between today+1 and today+3) leave_soon,
   exists(select 1 from attendance_effective a where a.person_id=p2.id and a.work_date=today) in_today
  from person p2 join people_profile pp on pp.person_id=p2.id
  where p2.org_id=current_org() and p2.side='staff' and p2.status='active' and not p2.id=any(excl) and lifecycle_stage(p2.id) not in ('candidate','offer')
   and not lifecycle_possibly_left(p2.id) and coalesce(pp.role,'')<>'' and not (pp.pod='Leadership' and p2.id is distinct from v_head and nullif(p->>'leadership','') is null)
 ), s as (
  select c.*,(case when domain is not null then 40 else 0 end)+6*ln(1+n_cat)*(case when n_cat>0 then 0.6+0.4*acc_cat::numeric/n_cat else 1 end)+4*ln(1+n_client)
   +(case when v_pod is not null and c.pod=v_pod then 3 else 0 end)+(case when c.id=v_head then 1 else 0 end)
   -4*greatest(0,load-2)-(case when away_until is not null then 30 when leave_soon is not null then 8 else 0 end)+(case when in_today then 1 else 0 end) as score
  from c)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'pod',s.pod,'role',role,'photoAt',photo,'score',round(score::numeric,1),'domain',domain,'similar',n_cat,'client',n_client,'load',load,
   'awayUntil',away_until,'leaveFrom',leave_soon,'inToday',in_today,
   'why',array_to_string(array_remove(array[
     case when domain is not null then 'In their domain: '||domain end,
     case when n_client>0 and n_cat>0 then 'Did '||n_cat||' similar '||lower(coalesce(cat_label,'tasks'))||' ('||n_client||' for this client)'
          when n_client>0 then 'Worked '||n_client||' times for this client'
          when n_cat>0 then 'Did '||n_cat||' similar '||lower(coalesce(cat_label,'tasks'))||case when acc_cat>0 then ', '||acc_cat||' accepted' else '' end end,
     case when days is not null and n_cat>=3 then 'usually done in '||greatest(1,round(days))||' day'||case when round(days)>1 then 's' else '' end end,
     case when load=0 then 'no open tasks' else load||' open task'||case when load>1 then 's' else '' end end,
     case when away_until is not null then 'on leave, back '||to_char(away_until+1,'Dy DD Mon') when leave_soon is not null then 'leave from '||to_char(leave_soon,'Dy DD Mon') when in_today then 'in today' end],null),'; ')) order by score desc,name),'[]') into v_out
 from (select * from s order by score desc,name limit lim) s;
 return jsonb_build_object('category',v_cat,'categoryLabel',cat_label,'client',v_client,'pod',v_pod,'people',v_out);
end $$;
-- Whom Pulse proposes to take over a leaver's task: the best fit for that task, then their pod head or manager.
create or replace function pulse.lifecycle_handover_to(p_person uuid,p_task uuid) returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(
  (select (x->>'id')::uuid from jsonb_array_elements(fit_people(jsonb_build_object('task',p_task,'exclude',jsonb_build_array(p_person),'limit',1,
    'pod',(select pod from people_profile where person_id=p_person),'head',hr_head(p_person)))->'people') x where p_task is not null and current_viewer() is not null limit 1),
  (select h from (select hr_head(p_person) h) x where h is not null and h<>p_person and task_person_ok(h)))
$$;

-- 5. Staffing gaps (leadership and HR): work nobody fits, people carrying too much, empty seats, clients losing their people
create function pulse.staffing_gaps() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare today date:=lifecycle_today();open_work jsonb;over jsonb;seats jsonb;clients jsonb;single jsonb;med numeric;
begin
 if current_viewer() is null or not viewer_is('admin','leadership','hr') then raise exception 'Staffing gaps are for leadership and HR' using errcode='42501';end if;
 perform seat_sync();
 -- Open work nobody holds yet (the pool and unassigned tasks), by kind, with the best fit Pulse can name.
 select coalesce(jsonb_agg(x order by (x->>'open')::int desc),'[]') into open_work from (
  select jsonb_build_object('category',t.category,'label',coalesce(c.label,'Not sorted'),'open',count(*),'pooled',count(*) filter(where t.pool_scope is not null),
   'urgent',count(*) filter(where t.urgency='high' or t.due_at<now()+interval '3 days'),
   'best',(fit_people(jsonb_build_object('category',t.category,'limit',2))->'people')) x
  from task t left join work_category c on c.org_id=t.org_id and c.key=t.category
  where t.org_id=current_org() and t.status in ('open','in_progress','blocked') and t.assignee_person_id is null and t.owner_id is null
  group by t.category,c.label) q;
 -- The usual load counts everyone current, including people with nothing open.
 select percentile_cont(0.5) within group(order by n) into med from (select (select count(*) from task t where t.org_id=current_org() and coalesce(t.assignee_person_id,t.owner_id)=p.id
  and t.status in ('open','in_progress','blocked')) n from person p where p.org_id=current_org() and p.side='staff' and p.status='active') z;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'pod',pp.pod,'open',z.n,'overdue',z.late) order by z.n desc),'[]') into over
 from (select coalesce(t.assignee_person_id,t.owner_id) id,count(*) n,count(*) filter(where t.due_at<now()) late from task t where t.org_id=current_org() and t.status in ('open','in_progress','blocked')
   group by 1) z join person p on p.id=z.id left join people_profile pp on pp.person_id=p.id
 where p.status='active' and z.n>=greatest(8,2*coalesce(med,0));
 select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'label',s.label,'lastHolder',(select jsonb_build_object('id',p.id,'name',p.display_name,'to',h.to_on) from seat_holding h join person p on p.id=h.person_id
   where h.seat_id=s.id and h.retired_at is null order by h.to_on desc nulls first limit 1)) order by s.label),'[]') into seats
 from role_seat s where s.org_id=current_org() and exists(select 1 from seat_holding h where h.seat_id=s.id and h.retired_at is null and h.to_on>=today-365)
  and not exists(select 1 from seat_holding h join person p on p.id=h.person_id where h.seat_id=s.id and h.retired_at is null and h.to_on is null and p.status='active');
 -- Clients whose recent work was mostly done by people who have left or are on notice.
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.display_name,'units',z.total,'leaving',z.leaving,'people',z.names) order by z.leaving desc),'[]') into clients
 from (select u.client_id,sum(u.units) total,sum(u.units) filter(where lifecycle_stage(u.person_id) in ('left','notice')) leaving,
   array_agg(distinct p.display_name) filter(where lifecycle_stage(u.person_id) in ('left','notice')) names
   from value_units((today-interval '90 days')::date,today) u join person p on p.id=u.person_id where u.client_id is not null group by 1) z join client c on c.id=z.client_id
 where z.leaving>=z.total*0.5 and z.total>=3;
 -- Kinds of work one person did almost alone in the last 90 days.
 select coalesce(jsonb_agg(jsonb_build_object('category',z.category,'label',coalesce(wc.label,z.category),'person',jsonb_build_object('id',p.id,'name',p.display_name),'share',round(z.share,2),'units',z.total) order by z.total desc),'[]') into single
 from (select category,person_id,sum(units) n,sum(sum(units)) over(partition by category) total,sum(units)/nullif(sum(sum(units)) over(partition by category),0) share
   from value_units((today-interval '90 days')::date,today) where category is not null group by 1,2) z join person p on p.id=z.person_id left join work_category wc on wc.org_id=current_org() and wc.key=z.category
 where z.share>=0.8 and z.total>=5 and p.status='active';
 return jsonb_build_object('openWork',open_work,'overloaded',over,'vacantSeats',seats,'clientsAtRisk',clients,'singlePerson',single,'medianOpen',med);
end $$;

revoke all on function pulse.value_key(text),pulse.value_client_of(text),pulse.value_revenue(date,date),pulse.value_done_on(pulse.task),pulse.value_units(date,date,uuid),pulse.value_cost(date,date),
 pulse.value_rows(date),pulse.value_band(numeric,numeric,int,numeric),pulse.value_view(date),pulse.value_mine(int),pulse.seat_sync(),pulse.seat_list(),pulse.seat_holder_add(uuid,uuid,date,date,text),
 pulse.seat_compare(uuid),pulse.fit_people(jsonb),pulse.staffing_gaps() from public;
grant execute on function pulse.value_view(date),pulse.value_mine(int),pulse.seat_list(),pulse.seat_holder_add(uuid,uuid,date,date,text),pulse.seat_compare(uuid),pulse.fit_people(jsonb),
 pulse.staffing_gaps(),pulse.value_band(numeric,numeric,int,numeric) to pulse_api;
grant execute on function pulse.seat_sync() to pulse_worker;
-- migrate:down
-- Forward-only.
