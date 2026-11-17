-- migrate:up
-- TASKS-4B (owner, 12 Oct 2026: "time logging is a hassle"): time on a task is captured by itself.
--  * The clock starts when the person doing a task moves it to Doing (or presses Start/Resume), and runs for one task at a
--    time: starting another pauses the first. It pauses when the task is blocked or goes back to To do, at check-out,
--    during a break and when the person leaves the office; it resumes on check-in and after a break; it stops at Done
--    (or cancelled, or when someone else takes the task).
--  * Each stretch becomes time entries (source 'timer', one per day it covers in the company's time zone), confirmed when ordinary; a stretch
--    over ten hours is stopped by Pulse and its time is proposed for the person to confirm or correct.
--  * The manual log stays, as a correction: the person adjusts or removes their own entries.
--  * A task with no estimate gets one from similar work when Pip is confident; otherwise Pulse asks once.

select pulse.check_values_add('pulse.time_entry','time_entry_source_check','source',array['timer']);
alter table pulse.task add column estimate_asked_at timestamptz;

create table pulse.task_timer (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 task_id uuid not null references pulse.task(id),person_id uuid not null references pulse.person(id),
 started_at timestamptz not null default clock_timestamp(),start_reason text not null check(start_reason in ('doing','resumed','checkin','break_end','returned')),
 ended_at timestamptz,end_reason text check(end_reason in ('paused','blocked','todo','done','cancelled','switched','reassigned','checkout','break','away','capped','deleted')),
 minutes int check(minutes>=0),check(ended_at is null or ended_at>=started_at)
);
create unique index task_timer_running on pulse.task_timer(org_id,person_id) where ended_at is null;
create index task_timer_task on pulse.task_timer(org_id,task_id,started_at);
alter table pulse.task_timer enable row level security;
alter table pulse.task_timer force row level security;
create policy tenant on pulse.task_timer using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
-- As private as time entries: the person, their managers, HR and leadership.
create policy visible on pulse.task_timer as restrictive for select to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','leadership','hr') or pulse.manages(person_id));
grant select on pulse.task_timer to pulse_api;
grant select,insert,update on pulse.task_timer to pulse_worker;
create trigger audit_mutation after insert or update on pulse.task_timer for each row execute function pulse.audit_mutation();

/** Close a person's running clock: the stretch becomes time entries, one per day in the company's time zone. Ordinary stretches are
 *  confirmed; one longer than ten hours is capped there and proposed for the person to check. Returns the minutes. */
create function pulse.task_timer_close(p_org uuid,p_person uuid,p_reason text,p_at timestamptz default clock_timestamp(),p_task uuid default null) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r task_timer;stop timestamptz;total int;d date;day_start timestamptz;day_end timestamptz;part int;long boolean;project uuid;remaining int;
begin
 select * into r from task_timer where org_id=p_org and person_id=p_person and ended_at is null and (p_task is null or task_id=p_task) for update;
 if not found then return 0;end if;
 stop:=greatest(r.started_at,least(p_at,r.started_at+interval '10 hours'));
 long:=p_at>r.started_at+interval '10 hours';
 total:=floor(extract(epoch from stop-r.started_at)/60)::int;
 update task_timer set ended_at=stop,end_reason=case when long then 'capped' else p_reason end,minutes=total where id=r.id;
 select project_id into project from task where id=r.task_id;
 -- One entry per company day the stretch covers (a stretch over midnight is split).
 d:=(r.started_at at time zone org_time_zone(p_org))::date;remaining:=total;
 while d<=(stop at time zone org_time_zone(p_org))::date loop
  day_start:=greatest(r.started_at,(d::timestamp) at time zone org_time_zone(p_org));day_end:=least(stop,((d+1)::timestamp) at time zone org_time_zone(p_org));
  -- The parts add up to the stretch: the last day takes what is left after rounding the others down.
  part:=case when day_end>=stop then remaining else least(remaining,floor(extract(epoch from day_end-day_start)/60)::int) end;remaining:=remaining-part;
  if part>=1 then
   insert into time_entry(org_id,person_id,task_id,project_id,work_date,minutes,note,source,status,source_key,evidence,created_by,decided_at)
   values(p_org,p_person,r.task_id,project,d,least(part,1440),case when long then 'Pulse stopped the clock after 10 hours: check this' end,'timer',
    case when long then 'proposed' else 'confirmed' end,'timer:'||r.id||':'||d,jsonb_build_object('timer',r.id,'from',day_start,'to',day_end,'reason',p_reason),p_person,case when long then null else now() end)
   on conflict(org_id,source_key) where source_key is not null do update set minutes=excluded.minutes,evidence=excluded.evidence;
  end if;
  d:=d+1;
 end loop;
 return total;
end $$;

/** Start a person's clock on a task (pausing any other first). Only the person doing the task, on work in Doing. */
create function pulse.task_timer_open(p_org uuid,p_task uuid,p_person uuid,p_reason text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;
begin
 if not exists(select 1 from task where org_id=p_org and id=p_task and status='in_progress' and deleted_at is null and coalesce(assignee_person_id,owner_id)=p_person) then return null;end if;
 if exists(select 1 from task_timer where org_id=p_org and person_id=p_person and task_id=p_task and ended_at is null) then
  return (select id from task_timer where org_id=p_org and person_id=p_person and ended_at is null);end if;
 perform task_timer_close(p_org,p_person,'switched');
 insert into task_timer(org_id,task_id,person_id,start_reason) values(p_org,p_task,p_person,p_reason) returning id into nid;
 return nid;
end $$;

-- The task's status and doer drive the clock: Doing (by the doer) starts it; anything else stops it; a new doer stops
-- the old one's.
create function pulse.task_timer_follow() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who uuid:=coalesce(new.assignee_person_id,new.owner_id);was uuid:=coalesce(old.assignee_person_id,old.owner_id);
begin
 if was is not null and (was is distinct from who or new.deleted_at is not null) then
  perform task_timer_close(new.org_id,was,case when new.deleted_at is not null then 'deleted' else 'reassigned' end,clock_timestamp(),new.id);
 end if;
 if new.status is distinct from old.status then
  if old.status='in_progress' and who is not null then
   perform task_timer_close(new.org_id,who,case new.status when 'blocked' then 'blocked' when 'open' then 'todo' when 'unknown' then 'todo' when 'cancelled' then 'cancelled' else 'done' end,clock_timestamp(),new.id);
  end if;
  if new.status='in_progress' and who is not null and who=current_viewer() and new.deleted_at is null then
   perform task_timer_open(new.org_id,new.id,who,case when old.status='blocked' then 'resumed' when old.status in ('done','in_review','accepted') then 'returned' else 'doing' end);
  end if;
  -- Work starting without an estimate takes Pip's (from similar work) when Pip is fairly sure; otherwise the page asks once.
  if new.status='in_progress' and new.estimate_minutes is null and coalesce(new.ai_suggestion->>'confidence','low') in ('medium','high')
   and (new.ai_suggestion->>'effortMinutes') ~ '^\d{1,5}$' and (new.ai_suggestion->>'effortMinutes')::int between 5 and 20000 then
   update task set estimate_minutes=(new.ai_suggestion->>'effortMinutes')::int where id=new.id;
   insert into task_event(org_id,task_id,actor_id,kind,from_value,to_value,note) values(new.org_id,new.id,null,'estimated',null,
    case when (new.ai_suggestion->>'effortMinutes')::int<60 then (new.ai_suggestion->>'effortMinutes')||' min' else round((new.ai_suggestion->>'effortMinutes')::int/60.0,1)||' h' end,'Pip, from similar work');
  end if;
 end if;
 return null;
end $$;
create trigger task_timer_follow after update of status,assignee_person_id,owner_id,deleted_at on pulse.task for each row execute function pulse.task_timer_follow();

-- Presence: check-out, breaks and leaving the office pause the clock; check-in and the end of a break resume what was
-- paused that way (the same day, the task still in Doing and still theirs). Never let this stop attendance itself.
create function pulse.task_timer_presence() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare paused task_timer;
begin
 begin
  if TG_TABLE_NAME='attendance_entry' then
   if TG_OP='UPDATE' and new.checked_out_at is not null and old.checked_out_at is null then
    perform task_timer_close(new.org_id,new.person_id,'checkout',new.checked_out_at);
   elsif TG_OP='INSERT' and new.checked_out_at is null then
    select * into paused from task_timer where org_id=new.org_id and person_id=new.person_id and end_reason in ('checkout','away') and ended_at>now()-interval '16 hours' order by ended_at desc limit 1;
    if found then perform task_timer_open(new.org_id,paused.task_id,new.person_id,'checkin');end if;
   end if;
  elsif TG_TABLE_NAME='attendance_break' then
   if TG_OP='INSERT' and new.ended_at is null then perform task_timer_close(new.org_id,new.person_id,'break',new.started_at);
   elsif TG_OP='UPDATE' and new.ended_at is not null and old.ended_at is null then
    select * into paused from task_timer where org_id=new.org_id and person_id=new.person_id and end_reason='break' and ended_at>=new.started_at-interval '1 minute' order by ended_at desc limit 1;
    if found then perform task_timer_open(new.org_id,paused.task_id,new.person_id,'break_end');end if;
   end if;
  elsif TG_TABLE_NAME='attendance_event' then
   if new.kind='left_office' then perform task_timer_close(new.org_id,new.person_id,'away',new.at);end if;
  end if;
 exception when others then raise warning 'task timer: %',sqlerrm;
 end;
 return null;
end $$;
create trigger task_timer_presence after insert or update of checked_out_at on pulse.attendance_entry for each row execute function pulse.task_timer_presence();
create trigger task_timer_presence after insert or update of ended_at on pulse.attendance_break for each row execute function pulse.task_timer_presence();
create trigger task_timer_presence after insert on pulse.attendance_event for each row execute function pulse.task_timer_presence();

/** The person's own Start / Pause / Resume on a task they are doing. Start moves a To do task to Doing. */
create function pulse.task_timer_set(p_task uuid,p_on boolean) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;n int;
begin
 select * into t from task where org_id=current_org() and id=p_task and deleted_at is null;
 if not found or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
 if me is distinct from coalesce(t.assignee_person_id,t.owner_id) then raise exception 'The clock runs for whoever is doing the task' using errcode='42501';end if;
 if p_on then
  if t.status in ('open','unknown') then perform task_move(p_task,'in_progress',null);
  elsif t.status<>'in_progress' then raise exception 'Move it to Doing first' using errcode='22023';end if;
  perform task_timer_open(current_org(),p_task,me,'resumed');
  return jsonb_build_object('running',true);
 end if;
 n:=task_timer_close(current_org(),me,'paused',clock_timestamp(),p_task);
 return jsonb_build_object('running',false,'minutes',n);
end $$;

/** Pulse stops a clock that has run for more than ten hours (someone forgot); the time is proposed for them to check. */
create function pulse.task_timer_tick() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record;n int:=0;
begin
 for r in select person_id from task_timer where org_id=current_org() and ended_at is null and started_at<now()-interval '10 hours' loop
  perform task_timer_close(current_org(),r.person_id,'capped');n:=n+1;
 end loop;return n;
end $$;
create or replace function pulse.task_due_tick() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t record;n int:=0;
begin
 for t in select id,title,coalesce(owner_id,assignee_person_id) who,due_at from task where org_id=current_org() and coalesce(owner_id,assignee_person_id) is not null
  and status in ('open','in_progress','blocked') and due_at between now() and now()+interval '24 hours' and source='pulse' and deleted_at is null loop
  if notification_emit(t.who,'task.due_soon','task',t.id,t.id||':due:'||t.due_at::text,'Due soon: '||left(t.title,120),'/tasks/'||t.id,'task') is not null then n:=n+1;end if;
 end loop;
 perform task_review_tick();
 perform task_timer_tick();
 return n;
end $$;

-- Corrections: the person adjusts or removes their own captured or typed time (the manual log is a correction now).
create or replace function pulse.time_decide(p_id uuid,p_decision text,p_minutes int default null) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();e time_entry;
begin
 select * into e from time_entry where org_id=current_org() and id=p_id and retired_at is null for update;
 if not found or e.person_id<>me then raise exception 'Only the person confirms their own time' using errcode='42501';end if;
 if p_decision='confirm' then
  if e.status<>'proposed' then raise exception 'Already decided' using errcode='22023';end if;
  if p_minutes is not null and p_minutes not between 1 and 1440 then raise exception 'Enter between 1 minute and 24 hours' using errcode='22023';end if;
  update time_entry set status='confirmed',minutes=coalesce(p_minutes,minutes),decided_at=now() where id=p_id;
 elsif p_decision='dismiss' then
  if e.status<>'proposed' then raise exception 'Already decided' using errcode='22023';end if;
  update time_entry set status='dismissed',decided_at=now() where id=p_id;
 elsif p_decision='adjust' then
  if p_minutes is null or p_minutes not between 1 and 1440 then raise exception 'Enter between 1 minute and 24 hours' using errcode='22023';end if;
  update time_entry set minutes=p_minutes,status='confirmed',decided_at=now(),
   evidence=evidence||jsonb_build_object('corrected',jsonb_build_object('from',e.minutes,'to',p_minutes,'at',now())) where id=p_id;
  if e.task_id is not null then perform task_event_add(e.task_id,'timer',e.minutes::text,p_minutes::text,format('corrected the time from %s to %s min',e.minutes,p_minutes));end if;
 elsif p_decision='retire' then update time_entry set retired_at=now() where id=p_id;
 else raise exception 'Choose confirm, dismiss, adjust or retire' using errcode='22023';end if;
end $$;

/** "About how long will this take?" asked once: the doer (or anyone who may change the task) answers, or says skip. */
create function pulse.task_estimate_answer(p_task uuid,p_minutes int) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;
begin
 t:=task_for_edit(p_task);
 if p_minutes is not null and p_minutes not between 5 and 20000 then raise exception 'Estimate between 5 minutes and about 330 hours' using errcode='22023';end if;
 update task set estimate_minutes=coalesce(p_minutes,estimate_minutes),estimate_asked_at=now(),updated_at=now() where id=p_task;
 if p_minutes is not null then perform task_event_add(p_task,'estimated',null,case when p_minutes<60 then p_minutes||' min' else round(p_minutes/60.0,1)||' h' end);end if;
 return jsonb_build_object('estimateMinutes',coalesce(p_minutes,t.estimate_minutes));
end $$;

revoke all on function pulse.task_timer_close(uuid,uuid,text,timestamptz,uuid),pulse.task_timer_open(uuid,uuid,uuid,text),pulse.task_timer_follow(),pulse.task_timer_presence(),
 pulse.task_timer_set(uuid,boolean),pulse.task_timer_tick(),pulse.task_estimate_answer(uuid,int) from public;
grant execute on function pulse.task_timer_set(uuid,boolean),pulse.task_estimate_answer(uuid,int) to pulse_api;
grant execute on function pulse.task_timer_tick() to pulse_worker;

-- migrate:down
-- Forward-only: captured time stays.
