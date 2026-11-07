-- migrate:up
-- INTEGRITY (owner, 22 Oct 2026: "Remove the Pip value per task: the value assignment is easily riggable."):
-- a task no longer carries a value (points set by Pip, leadership, the reviewer or the creator, or worked out from
-- effort × impact), and nothing is credited, scored or paid from one. The stored history stays, for audit, unused:
--  * pulse_priv.work_credit_retired: a copy of every credit that was live, with when it was retired.
--  * pulse_priv.task_value_retired: each task's value and Pip's value as they stood.
--  * pulse.work_credit: live credits are closed (reversed_at and retired_at set, nothing deleted); a guard keeps any
--    new credit from being written and keeps closed ones closed.
--  * pulse.task.value_points / value_source / value_by / value_at: kept, frozen (nothing sets or changes them); new
--    tasks start without one; Pip's suggestions keep importance and effort, never a value.
--  * Work units (people value, seats, revenue share) count finished work, one per task someone else made or accepted,
--    instead of the points: a task a person makes and finishes alone moves nobody's numbers.

-- 1. History, kept -------------------------------------------------------------------------------------------------
create table pulse_priv.work_credit_retired (like pulse.work_credit including defaults);
alter table pulse_priv.work_credit_retired add column retired_on timestamptz not null default now();
insert into pulse_priv.work_credit_retired select c.*,now() from pulse.work_credit c where c.reversed_at is null;
create table pulse_priv.task_value_retired (
 org_id uuid not null,task_id uuid not null,value_points smallint,value_source text,value_by uuid,value_at timestamptz,
 pip_points int,pip_suggestion jsonb,retired_on timestamptz not null default now(),primary key(org_id,task_id));
insert into pulse_priv.task_value_retired(org_id,task_id,value_points,value_source,value_by,value_at,pip_points,pip_suggestion)
select t.org_id,t.id,t.value_points,t.value_source,t.value_by,t.value_at,
 case when (t.ai_suggestion->>'valuePoints') ~ '^\d{1,3}$' then (t.ai_suggestion->>'valuePoints')::int end,t.ai_suggestion
from pulse.task t where t.value_points is not null or t.ai_suggestion ? 'valuePoints';
alter table pulse_priv.work_credit_retired enable row level security;
alter table pulse_priv.task_value_retired enable row level security;
revoke all on pulse_priv.work_credit_retired,pulse_priv.task_value_retired from public;

-- 2. Credits closed, and none written again --------------------------------------------------------------------------
alter table pulse.work_credit add column retired_at timestamptz;
update pulse.work_credit set reversed_at=now(),retired_at=now() where reversed_at is null;
create function pulse.work_credit_retired_guard() returns trigger language plpgsql set search_path=pulse,pg_temp as $$
begin
 if tg_op='INSERT' then return null;end if;
 -- A closed credit stays closed (restoring a deleted task or project used to bring its credit back).
 if new.reversed_at is null then new.reversed_at:=coalesce(old.reversed_at,now());end if;
 new.retired_at:=coalesce(old.retired_at,new.retired_at,now());
 return new;
end $$;
create trigger work_credit_retired_guard before insert or update on pulse.work_credit for each row execute function pulse.work_credit_retired_guard();
create or replace function pulse.task_credit_follow() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 return null; -- INTEGRITY: per-task value retired; accepting work credits nothing (0910).
end $$;
create or replace function pulse.task_credit_preview(p_id uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select null::jsonb -- INTEGRITY: nothing is credited on acceptance (0910).
$$;

-- 3. The task's value, frozen ------------------------------------------------------------------------------------------
create function pulse.task_value_frozen() returns trigger language plpgsql set search_path=pulse,pg_temp as $$
begin
 if tg_op='INSERT' then
  new.value_points:=null;new.value_source:=null;new.value_by:=null;new.value_at:=null;
 else
  new.value_points:=old.value_points;new.value_source:=old.value_source;new.value_by:=old.value_by;new.value_at:=old.value_at;
 end if;
 -- Pip's suggestion keeps importance, effort and why; never a value or the points that made one.
 if new.ai_suggestion is not null and jsonb_typeof(new.ai_suggestion)='object' and (tg_op='INSERT' or new.ai_suggestion is distinct from old.ai_suggestion) then
  new.ai_suggestion:=new.ai_suggestion-'valuePoints'-'breakdown';
 end if;
 return new;
end $$;
create trigger task_value_frozen before insert or update of value_points,value_source,value_by,value_at,ai_suggestion on pulse.task
 for each row execute function pulse.task_value_frozen();

-- Importance, urgency and the estimate are still set here (by the same people as before); the value is not.
create or replace function pulse.task_value_set(p_task uuid, p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;s jsonb;v_importance text;v_urgency text;v_estimate int;
begin
 select * into t from task where org_id=current_org() and id=p_task for update;
 if not found or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
 if not work_can_value(p_task) then raise exception 'Importance is set by leadership, HR, the doer''s head, the reviewer or whoever created it; nobody sets their own' using errcode='42501';end if;
 s:=case when coalesce((p->>'useSuggestion')::boolean,false) then coalesce(t.ai_suggestion,'{}') else '{}' end;
 begin
  v_estimate:=case when p ? 'estimateMinutes' then nullif(p->>'estimateMinutes','')::int when s ? 'effortMinutes' then (s->>'effortMinutes')::int else t.estimate_minutes end;
 exception when others then raise exception 'Enter the estimate in minutes as a number' using errcode='22023';end;
 v_importance:=case when p ? 'importance' then p->>'importance' when s ? 'importance' then s->>'importance' else t.priority end;
 v_urgency:=case when p ? 'urgency' then p->>'urgency' else t.urgency end;
 if v_estimate is not null and v_estimate not between 5 and 20000 then raise exception 'Estimate between 5 minutes and about 330 hours' using errcode='22023';end if;
 if v_importance not in ('low','normal','high','urgent') then raise exception 'Choose an importance' using errcode='22023';end if;
 if v_urgency not in ('low','normal','high') then raise exception 'Choose an urgency' using errcode='22023';end if;
 if v_estimate is distinct from t.estimate_minutes or v_importance is distinct from t.priority or v_urgency is distinct from t.urgency then
  update task set estimate_minutes=v_estimate,priority=v_importance,urgency=v_urgency,edited_by=me,updated_at=now() where id=p_task;
 end if;
 return jsonb_build_object('importance',v_importance,'urgency',v_urgency,'estimateMinutes',v_estimate);
end $$;

-- Pip's suggestion is kept for its importance and effort; it is never applied as a value.
create or replace function pulse.task_suggestion_save(p_task uuid, p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;
begin
 select * into t from task where org_id=current_org() and id=p_task for update;
 if not found or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
 if not (task_can_edit(p_task) or t.created_by=me or work_can_value(p_task)) then raise exception 'Only the people on this task or leadership keep suggestions on it' using errcode='42501';end if;
 if jsonb_typeof(p)<>'object' or not (p ? 'reason') then raise exception 'A suggestion has a reason' using errcode='22023';end if;
 update task set ai_suggestion=(p-'applied'-'valuePoints'-'breakdown')||jsonb_build_object('at',now(),'by',me) where id=p_task;
 return jsonb_build_object('applied',false);
end $$;

-- 4. Help ratings no longer give points (two people could rate each other's answers) --------------------------------
do $$
declare d text;c text;
begin
 d:=pg_get_functiondef('pulse.work_help_rate(uuid,uuid,text)'::regprocedure);
 c:=replace(d,$x$ pts:=case v when 2 then hp when 1 then ceil(hp/2.0)::int else 0 end;$x$,$x$ pts:=0; -- INTEGRITY: help ratings give no points (0910).$x$);
 if c=d then raise exception 'work_help_rate changed shape';end if;
 execute c;
end $$;

-- An unlocked task's notice no longer says what it is "worth".
do $$
declare d text;c text;
begin
 d:=pg_get_functiondef('pulse.task_release_waiting(uuid)'::regprocedure);
 c:=replace(d,$x$    worth:=case when coalesce(w.value_points,0)>0 then format(' · worth %s pts',w.value_points)
     when coalesce(w.effort*w.impact,0)>0 then format(' · worth %s pts',w.effort*w.impact) else '' end;$x$,$x$    worth:=''; -- INTEGRITY: no value (0910)$x$);
 if c=d then raise exception 'task_release_waiting changed shape';end if;
 execute c;
end $$;

-- 5. Scores that read the value -----------------------------------------------------------------------------------------
-- Effort from the time; impact from what the work unlocks and its importance, never from a value.
create or replace function pulse.task_derived_scores(p_task uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 with t as (select * from task where id=p_task),
 m as (select coalesce((select sum(e.minutes) from time_entry e where e.org_id=t.org_id and e.task_id=t.id and e.status='confirmed' and e.retired_at is null),0)::int logged,
   t.estimate_minutes est,(t.ai_suggestion->>'effortMinutes')::int pip,t.priority,
   exists(select 1 from task_link l where l.org_id=t.org_id and l.blocker_id=t.id) unlocks from t),
 x as (select logged,coalesce(nullif(logged,0),est,pip,60) mins,priority,unlocks from m)
 select jsonb_build_object('minutes',logged,'effortMinutes',mins,'value',null,'unlocks',unlocks,
  'effort',case when mins<=30 then 1 when mins<=120 then 2 when mins<=480 then 3 when mins<=1440 then 4 else 5 end,
  'impact',least(5,case priority when 'urgent' then 4 when 'high' then 3 when 'low' then 1 else 2 end+case when unlocks then 1 else 0 end)) from x
$$;

-- Work units: one per finished task that someone else made or accepted, and one per delivery; never points.
create or replace function pulse.value_units(p_from date, p_to date, p_person uuid default null)
returns table(person_id uuid, month date, client_id uuid, category text, units numeric, points numeric, tasks integer, accepted integer, ontime integer, with_due integer, returned integer, deliveries integer)
language sql stable security definer set search_path=pulse,pg_temp as $$
 with t as (
  select coalesce(t.assignee_person_id,t.owner_id) person_id,date_trunc('month',value_done_on(t))::date as month,pr.client_id,t.category,
   (case when t.created_by is distinct from coalesce(t.assignee_person_id,t.owner_id)
     or (t.accepted_by is not null and t.accepted_by<>coalesce(t.assignee_person_id,t.owner_id)) then 1 else 0 end)::numeric units,
   0::numeric points,
   (t.accepted_at is not null)::int accepted,(t.due_at is not null and coalesce(t.done_at,t.accepted_at)<=t.due_at)::int ontime,(t.due_at is not null and t.done_at is not null)::int with_due,
   (select count(*) from task_event e where e.task_id=t.id and e.kind='returned')::int returned
  from task t left join project pr on pr.id=t.project_id
  where t.org_id=current_org() and t.status='done' and coalesce(t.assignee_person_id,t.owner_id) is not null and (p_person is null or coalesce(t.assignee_person_id,t.owner_id)=p_person)
   and value_done_on(t) between date_trunc('month',p_from)::date and p_to
 ), d as (
  select a.actor_id person_id,date_trunc('month',(dl.delivered_at at time zone pulse.org_time_zone()))::date as month,pr.client_id,count(*)::int n
  from delivery dl join delivery_actor a on a.org_id=dl.org_id and a.file_id=dl.file_id left join project pr on pr.id=dl.project_id
  where dl.org_id=current_org() and a.actor_id is not null and (p_person is null or a.actor_id=p_person)
   and (dl.delivered_at at time zone pulse.org_time_zone())::date between date_trunc('month',p_from)::date and p_to
  group by 1,2,3
 )
 select person_id,month,client_id,category,sum(units),sum(points),sum(tasks)::int,sum(accepted)::int,sum(ontime)::int,sum(with_due)::int,sum(returned)::int,sum(deliveries)::int from (
  select person_id,month,client_id,category,units,points,1 tasks,accepted,ontime,with_due,returned,0 deliveries from t
  union all select person_id,month,client_id,null,n,0,0,0,0,0,0,n from d) u group by 1,2,3,4
$$;

-- Revenue shared by work units: a client whose work counts no units shares nothing (instead of dividing by zero).
do $$
declare d text;c text;
begin
 d:=pg_get_functiondef('pulse.value_rows(date)'::regprocedure);
 c:=replace(d,'sum(rev.amount*w2.units/wc.total) amount','sum(rev.amount*w2.units/nullif(wc.total,0)) amount');
 if c=d then raise exception 'value_rows changed shape';end if;
 execute c;
end $$;

-- The value page's method says what a work unit is now.
do $$
declare d text;c text;
begin
 d:=pg_get_functiondef('pulse.value_view(date)'::regprocedure);
 c:=replace(d,$x$'A work unit is an accepted task''s value points (else 1 per finished task) plus 1 per credited delivery.'$x$,
  $x$'A work unit is 1 per finished task someone else gave or accepted (a task one makes and finishes alone counts nothing), plus 1 per credited delivery. Tasks carry no value points.'$x$);
 if c=d then raise exception 'value_view changed shape';end if;
 execute c;
end $$;

revoke all on function pulse.work_credit_retired_guard(),pulse.task_value_frozen() from public;

-- migrate:down
-- Forward-only: the retired history is kept.
