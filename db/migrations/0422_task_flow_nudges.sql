-- migrate:up
-- UX-5B, friction in the task flow:
--  1. "Waiting on" nudges by itself. When a task has waited on another for longer than the company's nudge hours
--     (work_settings.review_nudge_hours, 24 h by default: the same knob as review nudges), whoever does the task it waits on
--     is told once a day: "Kedab waits on “Upload the bank statements” (2 days)". Never for waiting on your own work.
--  2. Repeating work is a template, not retyped. "Repeat every day/week/month" on a task: when it is finished, the next
--     one is made with the same title, notes, people, project, kind, value, estimate, place in Pulse and confirmed
--     signals, due one period later (rolled forward past today). The series moves to the new task; stopping is one tap.

-- ------------------------------------------------------------------------------------------- 1. waiting nudges

create function pulse.task_waiting_tick() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record; n int:=0; hrs int:=coalesce((select review_nudge_hours from work_settings where org_id=current_org()),24);
begin
 for r in select b.id,b.title,coalesce(b.assignee_person_id,b.owner_id) who,count(distinct w.id)::int tasks,min(l.created_at) since,
   (array_agg(p.display_name order by l.created_at))[1] first_name
  from task_link l join task w on w.id=l.task_id join task b on b.id=l.blocker_id left join person p on p.id=coalesce(w.assignee_person_id,w.owner_id)
  where l.org_id=current_org() and l.cleared_at is null and w.deleted_at is null and b.deleted_at is null
   and w.status in ('open','in_progress','blocked') and b.status in ('open','in_progress','blocked','unknown')
   and coalesce(b.assignee_person_id,b.owner_id) is not null and coalesce(b.assignee_person_id,b.owner_id) is distinct from coalesce(w.assignee_person_id,w.owner_id)
   and l.created_at<now()-make_interval(hours=>hrs)
  group by b.id,b.title,coalesce(b.assignee_person_id,b.owner_id) loop
  if notification_emit(r.who,'task.waiting','task',r.id,'waiting:'||r.id||':'||(now() at time zone org_time_zone())::date,
   left(case when r.tasks=1 then coalesce(split_part(r.first_name,' ',1),'Someone')||' waits' else r.tasks||' tasks wait' end||' on “'||r.title||'” ('
    ||case when now()-r.since<interval '2 days' then 'a day' else extract(day from now()-r.since)::int||' days' end||')',160),'/tasks/'||r.id,'task') is not null then n:=n+1; end if;
 end loop;
 return n;
end $$;

-- The notification worker runs the due-soon tick every minute; reviews, timers and now waiting ride along.
create or replace function pulse.task_due_tick() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t record;n int:=0;
begin
 for t in select id,title,coalesce(owner_id,assignee_person_id) who,due_at from task where org_id=current_org() and coalesce(owner_id,assignee_person_id) is not null
  and status in ('open','in_progress','blocked') and due_at between now() and now()+interval '24 hours' and source='pulse' and deleted_at is null loop
  if notification_emit(t.who,'task.due_soon','task',t.id,t.id||':due:'||t.due_at::text,'Due soon: '||left(t.title,120),'/tasks/'||t.id,'task') is not null then n:=n+1;end if;
 end loop;
 perform task_review_tick();
 perform task_timer_tick();
 perform task_waiting_tick();
 return n;
end $$;

-- ---------------------------------------------------------------------------------------------- 2. repeating
create table pulse.task_repeat (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null unique references pulse.task(id) on delete cascade,   -- the series' current task
 every text not null check (every in ('day','week','month')),
 made int not null default 0,
 created_by uuid references pulse.person(id) on delete set null,
 created_at timestamptz not null default now()
);
alter table pulse.task_repeat enable row level security;
alter table pulse.task_repeat force row level security;
create policy tenant_isolation on pulse.task_repeat using (org_id=pulse.current_org()) with check (org_id=pulse.current_org());
create policy visible on pulse.task_repeat as restrictive for select to pulse_api using (pulse.task_visible(task_id));
grant select on pulse.task_repeat to pulse_api;
grant select, insert, update, delete on pulse.task_repeat to pulse_worker;
select pulse.check_values_add('pulse.task_event'::regclass,'task_event_kind_check','kind',array['repeat']);

-- Repeat a task every day, week or month (null stops it). The people who may change the task decide.
create function pulse.task_repeat_set(p_task uuid, p_every text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k task; me uuid:=task_require_viewer();
begin
 k:=task_for_edit(p_task);
 if p_every is null then
  delete from task_repeat where task_id=p_task;
  perform task_event_add(p_task,'repeat',null,null,'Stopped repeating');
  return jsonb_build_object('every',null);
 end if;
 if p_every not in ('day','week','month') then raise exception 'Repeat every day, week or month' using errcode='22023'; end if;
 insert into task_repeat(org_id,task_id,every,created_by) values(current_org(),p_task,p_every,me)
 on conflict (task_id) do update set every=excluded.every;
 perform task_event_add(p_task,'repeat',null,p_every,'Repeats every '||p_every);
 return jsonb_build_object('every',p_every);
end $$;

-- When a repeating task is finished, the next one is made and the series moves to it.
create function pulse.task_repeat_next() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r task_repeat; step interval; due timestamptz; nid uuid; c task_companion; parent uuid;
begin
 select * into r from task_repeat where task_id=new.id;
 if not found or new.deleted_at is not null then return null; end if;
 step:=case r.every when 'day' then interval '1 day' when 'week' then interval '7 days' else interval '1 month' end;
 due:=new.due_at;
 if due is not null then due:=due+step; while due<now() loop due:=due+step; end loop; end if;
 -- A finished parent takes no new subtasks: the next one stands on its own then.
 parent:=case when new.parent_id is not null and exists(select 1 from task p where p.id=new.parent_id and p.status in ('open','in_progress','blocked','unknown') and p.deleted_at is null) then new.parent_id end;
 insert into task(org_id,project_id,title,assignee_person_id,owner_id,review_owner_id,priority,notes,category,tags,estimate_minutes,value_points,value_source,value_by,value_at,
  ai_suggestion,due_at,parent_id,created_by,created_at,status,source,assigned_at)
 values(new.org_id,new.project_id,new.title,new.assignee_person_id,new.owner_id,new.review_owner_id,new.priority,new.notes,new.category,new.tags,new.estimate_minutes,new.value_points,
  new.value_source,new.value_by,new.value_at,new.ai_suggestion,due,parent,new.created_by,now(),'open','pulse',now())
 returning id into nid;
 update task_repeat set task_id=nid,made=made+1 where id=r.id;
 insert into task_event(org_id,task_id,actor_id,kind,from_value,to_value,note) values(new.org_id,nid,null,'repeat',null,r.every,
  'Made by itself: it repeats every '||r.every||' (the last one was finished '||to_char(now() at time zone org_time_zone(),'DD Mon')||')');
 -- The place in Pulse and the confirmed signals carry over, counting from the new task.
 select * into c from task_companion where task_id=new.id;
 if found then
  insert into task_companion(org_id,task_id,target,target_events,target_by,auto_done,confirmed_by,confirmed_at)
  values(new.org_id,nid,c.target,c.target_events,c.target_by,c.auto_done,c.confirmed_by,case when c.confirmed_at is not null then now() end);
  insert into task_signal(org_id,task_id,position,event,label,cond,need,distinct_subject,since,created_by)
  select org_id,nid,position,event,label,cond,need,distinct_subject,now(),created_by from task_signal where task_id=new.id;
 end if;
 perform task_notify(coalesce(new.assignee_person_id,new.owner_id),'task.assigned',nid,nid||':repeat',left('Next one ready: '||new.title||coalesce(' · due '||to_char(due at time zone org_time_zone(),'Dy DD Mon'),''),160));
 return null;
end $$;
create trigger task_repeat_next after update of status on pulse.task for each row
 when (new.status in ('done','in_review','accepted') and old.status not in ('done','in_review','accepted'))
 execute function pulse.task_repeat_next();

revoke all on function pulse.task_waiting_tick(),pulse.task_repeat_set(uuid,text) from public;
grant execute on function pulse.task_repeat_set(uuid,text) to pulse_api;
grant execute on function pulse.task_waiting_tick() to pulse_worker;

-- The companion's read says whether the task repeats.
create or replace function pulse.task_repeat_of(p_task uuid) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select every from task_repeat where task_id=p_task and task_visible(p_task)
$$;
grant execute on function pulse.task_repeat_of(uuid) to pulse_api;

-- migrate:down
-- Forward-only.
