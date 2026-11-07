-- migrate:up
-- UX-5B: the task companion. Where a task sends people, how Pulse can tell it is done, and finishing it by itself.
--
--  1. App events. When something people can be sent to changes (the destinations registry,
--     apps/web/app/destinations/registry.mjs), the database appends a registered CloudEvent (packages/schemas/
--     registry.yaml, emitter /system/pulse-db) to the immutable log pulse.event, from triggers on the source tables:
--     whichever screen, phone, import or API made the change, the event is the same. Ids and counts only. A failure
--     there never blocks the change itself (it is caught and logged as a warning).
--  2. A task may name a destination (task_companion.target, with the events that mean "changed there") and completion
--     signals (task_signal): an event type, an exact condition on the event's declared data (gte / eq), how many, and
--     whether to count different people. Pip proposes them; only signals a person confirmed count.
--  3. Every event that meets a signal, or happens at a task's destination, is kept (task_signal_hit): the trail of why a
--     task was done, and what the companion tells the doer and the person who made the change.
--  4. When every confirmed signal is met, the task allows it (task_companion.auto_done), the company does
--     (work_settings.auto_done), it is open or in progress with a doer, nothing waits open beneath or before it and any
--     proof the project needs is there, Pulse marks it done itself: task_auto_done keeps the prior status and the events
--     that met each signal; the history says so; the doer is told with Undo (task_auto_done_undo, until the reviewer
--     accepts); the reviewer reviews as usual. Never on a guess: a vague match only ever asks.

-- --------------------------------------------------------------------------------------------- 1. app events
-- One registered event, appended to the log in the caller's company, then matched against open tasks. Returns its seq.
create function pulse.app_event(p_type text, p_subject text, p_data jsonb default '{}') returns bigint
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t event_type%rowtype; v_seq bigint; v_time timestamptz:=clock_timestamp(); me uuid:=current_viewer();
begin
 if current_org() is null then return null; end if;
 select * into t from event_type where type=p_type;
 if not found then raise warning 'app event % is not registered (run pulse-migrate to sync registry.yaml)', p_type; return null; end if;
 -- Never into the default partition: make this month's when the daily maintenance has not yet.
 if to_regclass('pulse.event_'||to_char(v_time at time zone 'UTC','YYYY_MM')) is null then
  perform ensure_event_partitions((v_time at time zone 'UTC')::date, 1);
 end if;
 insert into event(org_id,id,source,type,time,subject,actor,actor_kind,purpose,sensitivity,visibility,retention,data)
 values(current_org(),gen_random_uuid()::text,'/system/pulse-db',p_type,v_time,p_subject,
  case when me is null then 'system:pulse:db' else 'person:pulse:'||me end,case when me is null then 'system' else 'person' end,
  t.purposes,t.sensitivity,t.visibility,t.retention,coalesce(p_data,'{}'))
 returning seq into v_seq;
 perform task_signal_observe(v_seq,v_time,p_type,p_subject,coalesce(p_data,'{}'),me);
 return v_seq;
exception when others then
 raise warning 'app event % not recorded: %', p_type, sqlerrm;
 return null;
end $$;

-- Offices: added, and their network (Wi-Fi networks, public IP ranges) saved. Counts only, never names or addresses.
create function pulse.app_event_office() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare w int:=case when jsonb_typeof(new.wifi)='array' then jsonb_array_length(new.wifi) else 0 end; ip int:=coalesce(cardinality(new.public_ip_ranges),0);
 d jsonb:=jsonb_build_object('wifi_count',w,'ip_count',ip);
begin
 if not new.active then return null; end if;
 if TG_OP='INSERT' then perform app_event('office.added','office:pulse:'||new.id,d); end if;
 if (w>0 or ip>0) and (TG_OP='INSERT' or new.wifi is distinct from old.wifi or new.public_ip_ranges is distinct from old.public_ip_ranges or not old.active) then
  perform app_event('office.network.saved','office:pulse:'||new.id,d);
 end if;
 return null;
end $$;
create trigger app_event_office after insert or update on pulse.presence_office for each row execute function pulse.app_event_office();

-- Check-ins, and check-ins a phone made (or offered) on recognising an office.
create function pulse.app_event_checkin() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.voided_at is null then
  perform app_event('attendance.checked_in','person:pulse:'||new.person_id,jsonb_build_object('mode',new.mode,'work_date',new.work_date));
 end if;
 return null;
end $$;
create trigger app_event_checkin after insert on pulse.attendance_entry for each row execute function pulse.app_event_checkin();

create function pulse.app_event_arrival() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if TG_TABLE_NAME='attendance_event' then
  if new.kind='auto_check_in' and new.entry_id is not null then
   perform app_event('attendance.office.arrived','person:pulse:'||new.person_id,jsonb_strip_nulls(jsonb_build_object('via','auto','work_date',new.work_date,
    'office_ref',case when new.office_id is not null then 'office:pulse:'||new.office_id end)));
  end if;
 -- "You're at the office: check in?" answered: the phone links the office check-in it saw to this device's presence.
 elsif new.checked_entry_id is not null and new.checked_entry_id is distinct from old.checked_entry_id and new.office_id is not null
  and not exists(select 1 from attendance_event a where a.entry_id=new.checked_entry_id and a.kind='auto_check_in') then
  perform app_event('attendance.office.arrived','person:pulse:'||new.person_id,jsonb_build_object('via','asked','work_date',e.work_date,'office_ref','office:pulse:'||new.office_id))
   from attendance_entry e where e.id=new.checked_entry_id and e.mode='office' and e.voided_at is null and e.checked_in_at>clock_timestamp()-interval '2 hours';
 end if;
 return null;
end $$;
create trigger app_event_arrival after insert on pulse.attendance_event for each row execute function pulse.app_event_arrival();
create trigger app_event_arrival after update of checked_entry_id on pulse.companion_presence for each row execute function pulse.app_event_arrival();

-- HR's settings, from the change history every save writes (record_change: entity, field, new value).
create function pulse.app_event_setting() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare kind text;
begin
 if new.entity_type<>'hr_policy' then return null; end if;
 kind:=case new.field when 'presenceArrival' then 'checkin.arrival.saved' when 'attendanceReminders' then 'checkin.reminders.saved'
  when 'payrollCutoffDay' then 'payroll.cutoff.saved' when 'presenceAutoCheckIn' then 'presence.auto.saved' end;
 if kind is not null then perform app_event(kind,'setting:pulse:'||new.field,jsonb_build_object('value',left(coalesce(new.new_value,''),64))); end if;
 return null;
end $$;
create trigger app_event_setting after insert on pulse.record_change for each row execute function pulse.app_event_setting();

create function pulse.app_event_record() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if TG_TABLE_NAME='policy_document' then
  if new.status='published' and (TG_OP='INSERT' or old.status is distinct from 'published') then
   perform app_event('policy.published','policy:pulse:'||new.id,jsonb_build_object('kind',new.kind,'version',new.version));
  end if;
 elsif TG_TABLE_NAME='holiday' then perform app_event('holiday.added','holiday:pulse:'||new.id,jsonb_build_object('day',new.day));
 elsif TG_TABLE_NAME='leave_request' then
  if new.status in ('approved','rejected') and old.status='pending' then perform app_event('leave.decided','leave:pulse:'||new.id,jsonb_build_object('status',new.status)); end if;
 -- Projects and clients count when a person made them; syncs bring thousands and mean nothing to a task.
 elsif TG_TABLE_NAME='project' then
  if current_viewer() is not null and new.deleted_at is null then perform app_event('project.added','project:pulse:'||new.id,jsonb_build_object('kind',coalesce(new.kind,'internal'))); end if;
 elsif TG_TABLE_NAME='client' then
  if current_viewer() is not null then perform app_event('client.added','client:pulse:'||new.id,'{}'); end if;
 end if;
 return null;
end $$;
create trigger app_event_record after insert or update of status on pulse.policy_document for each row execute function pulse.app_event_record();
create trigger app_event_record after insert on pulse.holiday for each row execute function pulse.app_event_record();
create trigger app_event_record after update of status on pulse.leave_request for each row execute function pulse.app_event_record();
create trigger app_event_record after insert on pulse.project for each row execute function pulse.app_event_record();
create trigger app_event_record after insert on pulse.client for each row execute function pulse.app_event_record();

-- ---------------------------------------------------------------------------------------- 2. targets and signals
create table pulse.task_companion (
 org_id uuid not null references pulse.org(id),
 task_id uuid primary key references pulse.task(id) on delete cascade,
 target text check (target ~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$' and length(target)<=120),
 target_events text[] not null default '{}' check (cardinality(target_events)<=12),
 target_by uuid references pulse.person(id) on delete set null,
 auto_done boolean not null default true,
 confirmed_by uuid references pulse.person(id) on delete set null,
 confirmed_at timestamptz,
 dismissed_at timestamptz,
 updated_at timestamptz not null default now()
);
create index task_companion_events on pulse.task_companion using gin(target_events);
create table pulse.task_signal (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references pulse.task(id) on delete cascade,
 position smallint not null default 0,
 event text not null check (event ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'),
 label text not null check (length(label) between 1 and 200),
 cond jsonb not null default '{}' check (jsonb_typeof(cond)='object'),
 need smallint not null default 1 check (need between 1 and 50),
 distinct_subject boolean not null default false,
 since timestamptz not null,
 seen smallint not null default 0,
 met_at timestamptz,
 created_by uuid references pulse.person(id) on delete set null,
 created_at timestamptz not null default now()
);
create index task_signal_open on pulse.task_signal(org_id, event) where met_at is null;
create index task_signal_task on pulse.task_signal(task_id);
create table pulse.task_signal_hit (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references pulse.task(id) on delete cascade,
 signal_id uuid references pulse.task_signal(id) on delete cascade,   -- null: an event at the task's destination
 event_seq bigint not null,
 event_time timestamptz not null,
 event_type text not null,
 subject text not null,
 actor_id uuid references pulse.person(id) on delete set null,
 counted boolean not null default false,
 at timestamptz not null default clock_timestamp(),
 seen_by uuid[] not null default '{}'
);
create unique index task_signal_hit_once on pulse.task_signal_hit(task_id, coalesce(signal_id,'00000000-0000-0000-0000-000000000000'::uuid), event_seq);
create index task_signal_hit_recent on pulse.task_signal_hit(org_id, at desc);
create table pulse.task_auto_done (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 task_id uuid not null references pulse.task(id) on delete cascade,
 prior_status text not null,
 done_at timestamptz not null default clock_timestamp(),
 signals jsonb not null,
 caused_by uuid references pulse.person(id) on delete set null,
 told_at timestamptz,
 undone_at timestamptz,
 undone_by uuid references pulse.person(id) on delete set null
);
create index task_auto_done_task on pulse.task_auto_done(task_id, done_at desc);
do $$ declare t text; begin
 foreach t in array array['task_companion','task_signal','task_signal_hit','task_auto_done'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant_isolation on pulse.%I using (org_id=pulse.current_org()) with check (org_id=pulse.current_org())',t);
  -- Read through the functions below, which check that the viewer can see the task.
  execute format('create policy visible on pulse.%I as restrictive for select to pulse_api using (pulse.task_visible(task_id))',t);
  execute format('grant select on pulse.%I to pulse_api',t);
  execute format('grant select, insert, update, delete on pulse.%I to pulse_worker',t);
 end loop;
end $$;

select pulse.check_values_add('pulse.task_event'::regclass,'task_event_kind_check','kind',array['auto_done','signals','target']);
select pulse.check_values_add('pulse.notification'::regclass,'notification_event_type_check','event_type',array['task.auto_done','task.waiting']);

alter table pulse.work_settings add column auto_done text not null default 'on' check (auto_done in ('on','ask'));

-- Does an event's data meet a signal's condition? Each key: {"gte": n} (a number at least n) or {"eq": v} (exactly v).
create function pulse.task_signal_matches(p_cond jsonb, p_data jsonb) returns boolean language plpgsql immutable as $$
declare k text; v jsonb;
begin
 for k, v in select key, value from jsonb_each(coalesce(p_cond,'{}')) loop
  if v ? 'gte' then
   if jsonb_typeof(p_data->k)<>'number' or (p_data->>k)::numeric < (v->>'gte')::numeric then return false; end if;
  end if;
  if v ? 'eq' and (p_data->k) is distinct from (v->'eq') then return false; end if;
 end loop;
 return true;
end $$;

-- Record one event against one signal; true when it counted (a different person when people are counted).
create function pulse.task_signal_take(s pulse.task_signal, p_seq bigint, p_time timestamptz, p_subject text, p_actor uuid) returns boolean
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare counted boolean; inserted int;
begin
 counted:=not s.distinct_subject or not exists(select 1 from task_signal_hit h where h.signal_id=s.id and h.subject=p_subject and h.counted);
 insert into task_signal_hit(org_id,task_id,signal_id,event_seq,event_time,event_type,subject,actor_id,counted,seen_by)
 values(current_org(),s.task_id,s.id,p_seq,p_time,s.event,p_subject,p_actor,counted,'{}') on conflict do nothing;
 get diagnostics inserted=row_count;
 if inserted=0 or not counted then return false; end if;
 update task_signal set seen=least(seen+1,need),met_at=case when met_at is null and seen+1>=need then clock_timestamp() else met_at end where id=s.id;
 return true;
end $$;

-- Every open task this event meets a signal of, or whose destination it happened at.
create function pulse.task_signal_observe(p_seq bigint, p_time timestamptz, p_type text, p_subject text, p_data jsonb, p_actor uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s task_signal; touched uuid[]:='{}'; t uuid;
begin
 for s in select g.* from task_signal g join task k on k.id=g.task_id join task_companion c on c.task_id=g.task_id
  where g.org_id=current_org() and g.event=p_type and g.met_at is null and g.since<=p_time and c.confirmed_at is not null
   and k.status in ('open','in_progress','blocked') and k.deleted_at is null loop
  if task_signal_matches(s.cond,p_data) and task_signal_take(s,p_seq,p_time,p_subject,p_actor) then touched:=touched||s.task_id; end if;
 end loop;
 insert into task_signal_hit(org_id,task_id,signal_id,event_seq,event_time,event_type,subject,actor_id,counted)
 select current_org(),c.task_id,null,p_seq,p_time,p_type,p_subject,p_actor,false from task_companion c join task k on k.id=c.task_id
  where c.org_id=current_org() and p_type=any(c.target_events) and k.status in ('open','in_progress','blocked') and k.deleted_at is null
   and not exists(select 1 from task_signal g where g.task_id=c.task_id and g.event=p_type and c.confirmed_at is not null)
 on conflict do nothing;
 if cardinality(touched)>0 then
  foreach t in array (select array_agg(distinct x) from unnest(touched) x) loop perform task_auto_try(t); end loop;
 end if;
end $$;

-- ------------------------------------------------------------------------------------------- 3. finishing by itself
-- Why a task may not finish by itself right now, or null when it may.
create function pulse.task_auto_blocker(p_task uuid) returns text language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare k task; c task_companion;
begin
 select * into k from task where org_id=current_org() and id=p_task;
 select * into c from task_companion where task_id=p_task;
 if not found or c.confirmed_at is null then return 'unconfirmed'; end if;
 if not exists(select 1 from task_signal where task_id=p_task) then return 'no_signals'; end if;
 if exists(select 1 from task_signal where task_id=p_task and met_at is null) then return 'waiting'; end if;
 if k.deleted_at is not null or k.status not in ('open','in_progress') then return 'status'; end if;
 if coalesce(k.assignee_person_id,k.owner_id) is null then return 'no_doer'; end if;
 if not c.auto_done then return 'task_asks'; end if;
 if coalesce((select auto_done from work_settings where org_id=current_org()),'on')<>'on' then return 'company_asks'; end if;
 if exists(select 1 from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and l.task_id=p_task and l.cleared_at is null
  and b.deleted_at is null and b.status not in ('done','in_review','accepted','cancelled')) then return 'waits_on'; end if;
 if task_open_children(p_task)>0 then return 'subtasks'; end if;
 if coalesce((select requires_proof from project where id=k.project_id),false) and not exists(select 1 from task_proof where task_id=p_task and removed_at is null) then return 'proof'; end if;
 return null;
end $$;

-- When every signal is met and nothing stands in the way, Pulse marks the task done itself, keeping the trail.
create function pulse.task_auto_try(p_task uuid) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k task; why jsonb; caused uuid:=current_viewer(); doer uuid; released int; auto uuid; note text;
begin
 if task_auto_blocker(p_task) is not null then return false; end if;
 select * into k from task where org_id=current_org() and id=p_task for update;
 doer:=coalesce(k.assignee_person_id,k.owner_id);
 select jsonb_agg(jsonb_build_object('label',g.label,'event',g.event,'need',g.need,'seen',g.seen,'metAt',g.met_at,
   'events',(select jsonb_agg(jsonb_build_object('seq',h.event_seq,'at',h.event_time,'subject',h.subject,'actor',h.actor_id) order by h.event_seq)
     from task_signal_hit h where h.signal_id=g.id and h.counted)) order by g.position)
  into why from task_signal g where g.task_id=p_task;
 select string_agg(g.label,'; ' order by g.position) into note from task_signal g where g.task_id=p_task;
 begin
  -- As Pulse on the doer's behalf: the rules that need a person (manual wins, the finish guard) see the doer.
  perform set_config('pulse.viewer_id',doer::text,true);
  update task set status='done',done_at=now(),updated_at=now(),edited_by=null,started_at=coalesce(started_at,now()),
   locked=array(select distinct unnest(locked||'{status}'::text[])) where id=p_task;
  perform set_config('pulse.viewer_id',coalesce(caused::text,''),true);
 exception when others then
  perform set_config('pulse.viewer_id',coalesce(caused::text,''),true);
  raise warning 'task % not finished by itself: %', p_task, sqlerrm;
  return false;
 end;
 insert into task_auto_done(org_id,task_id,prior_status,signals,caused_by) values(current_org(),p_task,k.status,coalesce(why,'[]'),caused) returning id into auto;
 insert into task_event(org_id,task_id,actor_id,kind,from_value,to_value,note) values(current_org(),p_task,null,'auto_done',k.status,'done',left('Pulse saw it happen: '||note,1000));
 released:=task_release_waiting(p_task);
 if not task_auto_accept(p_task) then perform task_notify(k.review_owner_id,'task.done',p_task,p_task||':done:'||now()::text,'Ready to accept: '||k.title); end if;
 perform task_notify(doer,'task.auto_done',p_task,p_task||':auto:'||auto,left('Pulse marked “'||k.title||'” done: '||note||'. Undo on the task if it is not.',160));
 return true;
end $$;

-- Undo: the doer or anyone who can change the task puts it back how it was, until the reviewer has accepted it. The
-- task then stops finishing itself (the person said it was not done).
create function pulse.task_auto_done_undo(p_task uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k task; a task_auto_done; me uuid:=task_require_viewer();
begin
 k:=task_for_edit(p_task);
 select * into a from task_auto_done where org_id=current_org() and task_id=p_task and undone_at is null order by done_at desc limit 1;
 if not found then raise exception 'Pulse did not finish this task by itself' using errcode='P0002'; end if;
 if k.status not in ('done','in_review') then raise exception 'It has been % since; change it on the task', case k.status when 'accepted' then 'accepted' else 'changed' end using errcode='22023'; end if;
 update task set status=a.prior_status,done_at=null,updated_at=now(),edited_by=me where id=p_task;
 update task_auto_done set undone_at=clock_timestamp(),undone_by=me,told_at=coalesce(told_at,clock_timestamp()) where id=a.id;
 update task_companion set auto_done=false,updated_at=now() where task_id=p_task;
 perform task_event_add(p_task,'status','done',a.prior_status,'Undo: it was not done yet (Pulse had marked it done)');
 return jsonb_build_object('status',a.prior_status);
end $$;

-- --------------------------------------------------------------------------------------------- 4. reading, setting
create function pulse.task_companion_read(p_task uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare c task_companion; me uuid:=current_viewer();
begin
 if not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002'; end if;
 select * into c from task_companion where task_id=p_task;
 return jsonb_build_object(
  'target',c.target,'targetEvents',coalesce(to_jsonb(c.target_events),'[]'),'autoDone',coalesce(c.auto_done,true),'confirmedAt',c.confirmed_at,
  'confirmedBy',(select display_name from person where id=c.confirmed_by),'dismissed',c.dismissed_at is not null,
  'companyAutoDone',coalesce((select auto_done from work_settings where org_id=current_org()),'on'),
  'blocker',task_auto_blocker(p_task),
  'signals',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'event',g.event,'label',g.label,'need',g.need,'seen',g.seen,'distinct',g.distinct_subject,
    'where',g.cond,'metAt',g.met_at) order by g.position) from task_signal g where g.task_id=p_task),'[]'),
  'hits',coalesce((select jsonb_agg(x order by x->>'at' desc) from (select jsonb_build_object('id',h.id,'event',h.event_type,'at',h.event_time,'counted',h.counted,
    'signal',h.signal_id,'actor',h.actor_id,'actorName',(select display_name from person where id=h.actor_id),'mine',h.actor_id=me,'seen',me=any(h.seen_by),
    'data',(select ev.data from event ev where ev.seq=h.event_seq and ev.time=h.event_time and ev.redacted_at is null)) x
    from task_signal_hit h where h.task_id=p_task order by h.event_time desc limit 12) y),'[]'),
  'auto',(select jsonb_build_object('id',a.id,'at',a.done_at,'prior',a.prior_status,'undoneAt',a.undone_at,'told',a.told_at is not null)
    from task_auto_done a where a.task_id=p_task order by a.done_at desc limit 1));
end $$;

-- Set where the task sends people and/or confirm its signals. p: {target, targetEvents[], signals[{event,label,need,
-- distinct,where}], autoDone, dismiss}. Signals replace the unconfirmed ones; events since the task was made count.
create function pulse.task_companion_set(p_task uuid, p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer(); k task; x jsonb; et event_type%rowtype; n int:=0; s task_signal; e record; v_need int; v_cond jsonb; k2 text; v2 jsonb;
begin
 k:=task_for_edit(p_task);
 if jsonb_typeof(p)<>'object' then raise exception 'Say what to change' using errcode='22023'; end if;
 insert into task_companion(org_id,task_id) values(current_org(),p_task) on conflict do nothing;
 if p ? 'target' then
  if p->>'target' is not null and (p->>'target' !~ '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$' or length(p->>'target')>120) then raise exception 'Choose a place in Pulse' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements_text(coalesce(p->'targetEvents','[]')) y where not exists(select 1 from event_type where type=y)) then
   raise exception 'Unknown event for that place' using errcode='22023'; end if;
  update task_companion set target=p->>'target',target_events=coalesce(array(select jsonb_array_elements_text(coalesce(p->'targetEvents','[]')) limit 12),'{}'),
   target_by=me,updated_at=now() where task_id=p_task;
  perform task_event_add(p_task,'target',null,p->>'target',null);
 end if;
 if p ? 'autoDone' then update task_companion set auto_done=coalesce((p->>'autoDone')::boolean,true),updated_at=now() where task_id=p_task; end if;
 if coalesce((p->>'dismiss')::boolean,false) then
  delete from task_signal where task_id=p_task and met_at is null;
  update task_companion set dismissed_at=now(),confirmed_at=null,updated_at=now() where task_id=p_task;
  perform task_event_add(p_task,'signals',null,null,'Pulse will not watch for this task being done');
 end if;
 if p ? 'signals' then
  if jsonb_typeof(p->'signals')<>'array' or jsonb_array_length(p->'signals') not between 1 and 6 then raise exception 'Confirm one to six signals' using errcode='22023'; end if;
  delete from task_signal where task_id=p_task;
  for x in select value from jsonb_array_elements(p->'signals') loop
   select * into et from event_type where type=x->>'event';
   if not found then raise exception 'Unknown signal %', x->>'event' using errcode='22023'; end if;
   v_need:=coalesce(nullif(x->>'need','')::int,1);
   if v_need not between 1 and 50 then raise exception 'A signal counts 1 to 50' using errcode='22023'; end if;
   v_cond:=coalesce(x->'where','{}');
   if jsonb_typeof(v_cond)<>'object' then raise exception 'A condition is a set of fields' using errcode='22023'; end if;
   for k2, v2 in select key, value from jsonb_each(v_cond) loop
    if not k2=any(et.data_allowed) then raise exception '% is not part of %', k2, et.type using errcode='22023'; end if;
    if jsonb_typeof(v2)<>'object' or exists(select 1 from jsonb_object_keys(v2) o where o not in ('gte','eq')) or (v2 ? 'gte' and jsonb_typeof(v2->'gte')<>'number') then
     raise exception 'A condition is at least a number, or exactly a value' using errcode='22023'; end if;
   end loop;
   insert into task_signal(org_id,task_id,position,event,label,cond,need,distinct_subject,since,created_by)
   values(current_org(),p_task,n,et.type,left(coalesce(nullif(btrim(x->>'label'),''),et.type),200),v_cond,v_need,coalesce((x->>'distinct')='subject',false),
    coalesce(k.created_at,now()),me) returning * into s;
   n:=n+1;
   -- What already happened since the task was made counts too (the log is exact; nothing is inferred).
   for e in select ev.seq,ev.time,ev.subject,ev.data,nullif(substring(ev.actor from '^person:pulse:(.+)$'),'')::uuid actor from event ev
    where ev.org_id=current_org() and ev.type=s.event and ev.time>=s.since and ev.redacted_at is null order by ev.seq loop
    if task_signal_matches(s.cond,e.data) then perform task_signal_take(s,e.seq,e.time,e.subject,e.actor); select * into s from task_signal where id=s.id; end if;
    exit when s.met_at is not null;
   end loop;
  end loop;
  update task_companion set confirmed_by=me,confirmed_at=now(),dismissed_at=null,auto_done=coalesce((p->>'autoDone')::boolean,auto_done),updated_at=now() where task_id=p_task;
  perform task_event_add(p_task,'signals',null,n::text,left('Done when: '||(select string_agg(label,'; ' order by position) from task_signal where task_id=p_task),1000));
 end if;
 return task_companion_read(p_task);
end $$;

-- What the companion lights up for: events on the viewer's open tasks (or that the viewer made, on tasks they can
-- change) not yet seen, and tasks Pulse finished for them that they were not told about yet.
create function pulse.task_companion_attention() returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();
begin
 if me is null then return '{"hits":[],"auto":[]}'; end if;
 return jsonb_build_object(
  'hits',coalesce((select jsonb_agg(x order by x->>'at' desc) from (
    select distinct on (h.task_id) jsonb_build_object('task',h.task_id,'title',k.title,'status',k.status,'event',h.event_type,'at',h.event_time,
     'mine',h.actor_id=me,'actorName',(select display_name from person where id=h.actor_id),'signal',(select label from task_signal where id=h.signal_id),
     'subjectName',(select display_name from person where id=nullif(substring(h.subject from '^person:pulse:([0-9a-f-]{36})$'),'')::uuid),
     'data',(select ev.data from event ev where ev.seq=h.event_seq and ev.time=h.event_time and ev.redacted_at is null),
     'doer',coalesce(k.assignee_person_id,k.owner_id)=me,'met',not exists(select 1 from task_signal g where g.task_id=k.id and g.met_at is null) and exists(select 1 from task_signal g where g.task_id=k.id),
     'signals',(select jsonb_agg(jsonb_build_object('label',g.label,'need',g.need,'seen',g.seen) order by g.position) from task_signal g where g.task_id=k.id)) x
    from task_signal_hit h join task k on k.id=h.task_id
    where h.org_id=current_org() and not me=any(h.seen_by) and h.at>clock_timestamp()-interval '3 days' and k.deleted_at is null
     and k.status in ('open','in_progress','blocked') and task_visible(k.id)
     and (coalesce(k.assignee_person_id,k.owner_id)=me or (h.actor_id=me and task_can_edit(k.id)))
    order by h.task_id,h.event_time desc limit 8) y),'[]'),
  'auto',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'task',a.task_id,'title',k.title,'at',a.done_at,'signals',(select jsonb_agg(s->>'label') from jsonb_array_elements(a.signals) s)) order by a.done_at desc)
    from task_auto_done a join task k on k.id=a.task_id where a.org_id=current_org() and a.told_at is null and a.undone_at is null and a.done_at>clock_timestamp()-interval '7 days'
     and coalesce(k.assignee_person_id,k.owner_id)=me and k.deleted_at is null),'[]'));
end $$;

-- The viewer saw (or dismissed) what the companion said about a task; for an auto-done, the doer was told.
create function pulse.task_companion_seen(p_task uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();
begin
 if not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002'; end if;
 update task_signal_hit set seen_by=array_append(seen_by,me) where task_id=p_task and not me=any(seen_by);
 update task_auto_done a set told_at=clock_timestamp() from task k where a.task_id=p_task and k.id=a.task_id and a.told_at is null and coalesce(k.assignee_person_id,k.owner_id)=me;
end $$;

-- The doer's notice and the waiting nudge (0422) need recipient rules: the rule as it stands (0312), plus these two.
create or replace function pulse.notification_recipient_allowed(p_person uuid, p_type text, p_subject text, p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $function$
begin
 if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active') then return false;end if;
 -- UX-5B: the doer hears that Pulse finished their task (until it is undone); whoever does a task others wait on hears it.
 if p_type='task.auto_done' then
  return p_subject='task' and exists(select 1 from task t where t.org_id=current_org() and t.id=p_id and t.deleted_at is null and coalesce(t.assignee_person_id,t.owner_id)=p_person)
   and exists(select 1 from task_auto_done a where a.org_id=current_org() and a.task_id=p_id and a.undone_at is null);
 elsif p_type='task.waiting' then
  return p_subject='task' and exists(select 1 from task b where b.org_id=current_org() and b.id=p_id and b.deleted_at is null and coalesce(b.assignee_person_id,b.owner_id)=p_person
   and exists(select 1 from task_link l where l.org_id=current_org() and l.blocker_id=b.id and l.cleared_at is null));
 end if;
 if p_type like 'chat.%' then
  return p_subject='message' and exists(select 1 from chat_message m join chat_member cm on cm.channel_id=m.channel_id and cm.org_id=m.org_id
   where m.org_id=current_org() and m.id=p_id and m.removed_at is null and cm.person_id=p_person and m.author_id<>p_person
   and (p_type<>'chat.mention' or p_person=any(m.mentions)) and notification_chat_member_current(m.channel_id,p_person));
 elsif p_type in ('request.updated','request.decision','leave.decision','approval.waiting','approval.reminder') then
  return p_subject='hr_flow' and exists(select 1 from hr_flow f where f.org_id=current_org() and f.id=p_id
   and (p_type<>'leave.decision' or f.kind='leave')
   and (p_type not in ('approval.waiting','approval.reminder') or f.status='pending')
   and ((p_type not in ('approval.waiting','approval.reminder') and f.person_id=p_person)
   or (p_type not in ('approval.waiting','approval.reminder') and (hr_is_staff(p_person) or hr_head(f.person_id)=p_person))
   or (f.stage<>'cofounder' and (hr_is_staff(p_person) or hr_head(f.person_id)=p_person))
   or (f.stage='cofounder' and (hr_is_staff(p_person) or hr_is_cofounder(p_person)))));
 elsif p_type in ('task.assigned','task.unblocked','task.due_soon','task.accepted') then
  return p_subject='task' and exists(select 1 from task where org_id=current_org() and id=p_id and coalesce(owner_id,assignee_person_id)=p_person
   and (p_type<>'task.accepted' or status='accepted') and (p_type<>'task.due_soon' or status not in ('done','accepted','cancelled','in_review')));
 elsif p_type='task.blocked' then
  return p_subject='task' and exists(select 1 from task b where b.org_id=current_org() and b.id=p_id and coalesce(b.owner_id,b.assignee_person_id)=p_person
   and exists(select 1 from task_link l where l.org_id=current_org() and l.blocker_id=b.id and l.cleared_at is null));
 elsif p_type='task.done' then
  return p_subject='task' and exists(select 1 from task where org_id=current_org() and id=p_id and review_owner_id=p_person and status in ('done','in_review','accepted'));
 elsif p_type='task.update' then
  -- Collaborators and watchers hear when a task they follow starts, blocks, finishes or is accepted.
  return p_subject='task' and exists(select 1 from task_member m where m.org_id=current_org() and m.task_id=p_id and m.person_id=p_person and m.removed_at is null);
 elsif p_type in ('task.ask','project.ask') then
  return p_subject='work_ask' and exists(select 1 from work_ask a where a.org_id=current_org() and a.id=p_id and a.to_id=p_person
   and (p_type<>'task.ask' or a.task_id is not null) and (p_type<>'project.ask' or a.project_id is not null));
 elsif p_type='ask.answered' then
  return p_subject='work_ask' and exists(select 1 from work_ask a where a.org_id=current_org() and a.id=p_id and a.from_id=p_person and a.status in ('accepted','declined'));
 elsif p_type in ('task.mention','project.mention','task.comment','project.comment') then
  return p_subject='comment' and exists(select 1 from work_comment c where c.org_id=current_org() and c.id=p_id and c.removed_at is null and c.author_id<>p_person
   and (p_type not like '%.mention' or p_person=any(c.mentions))
   and (c.task_id is null or (p_type like 'task.%' and work_task_person(c.task_id,p_person)))
   and (c.project_id is null or (p_type like 'project.%' and (work_project_person(c.project_id,p_person)
    or exists(select 1 from project_member m where m.org_id=current_org() and m.project_id=c.project_id and m.person_id=p_person and m.left_at is null)))));
 elsif p_type='project.added' then
  return p_subject='project' and work_project_person(p_id,p_person);
 elsif p_type in ('domain.proposed','domain.answered','domain.policy','domain.ended') then
  return p_subject='work_domain' and exists(select 1 from work_domain d where d.org_id=current_org() and d.id=p_id and (
   (p_type='domain.proposed' and d.status='proposed' and ((d.proposed_side='company' and d.person_id=p_person)
    or (d.proposed_side='employee' and d.person_id<>p_person and (hr_head(d.person_id)=p_person or hr_is_staff(p_person)))))
   or (p_type='domain.answered' and d.proposed_by=p_person and d.status in ('active','declined'))
   or (p_type='domain.policy' and d.basis='policy' and d.person_id=p_person)
   or (p_type='domain.ended' and d.status='ended' and p_person in (d.person_id,d.proposed_by,coalesce(d.company_agreed_by,d.person_id),coalesce(hr_head(d.person_id),d.person_id)))));
 elsif p_type='pool.claimed' then
  return p_subject='task' and exists(select 1 from task where org_id=current_org() and id=p_id and claimed_by is not null and coalesce(pooled_by,created_by)=p_person);
 elsif p_type='pool.match' then
  return p_subject='task' and exists(select 1 from task t where t.org_id=current_org() and t.id=p_id and t.pool_scope is not null and t.assignee_person_id is null and t.owner_id is null
   and t.status in ('open','unknown') and work_pool_eligible_for(p_person,t.pool_scope,t.pool_ref) and work_domain_match(p_person,t.project_id,t.category,t.tags) is not null);
 elsif p_type='kudos.received' then
  return p_subject='kudos' and exists(select 1 from kudos k where k.org_id=current_org() and k.id=p_id and k.to_person=p_person and k.hidden_at is null);
 elsif p_type='people.bank' then
  return p_subject='person' and p_id<>p_person and exists(select 1 from role_assignment where org_id=current_org() and person_id=p_person and role_key='hr' and current_date between valid_from and coalesce(valid_to,'infinity'));
 elsif p_type='people.change' then
  return p_subject='person' and p_id<>p_person and exists(select 1 from role_assignment where org_id=current_org() and person_id=p_person and role_key in ('hr','admin') and current_date between valid_from and coalesce(valid_to,'infinity'));
 elsif p_type in ('workflow.late','workflow.done') then
  return p_subject='workflow_run' and exists(select 1 from workflow_run r where r.org_id=current_org() and r.id=p_id and (r.started_by=p_person
   or exists(select 1 from workflow_run_step s join task t on t.id=s.task_id where s.run_id=r.id and p_person in (t.assignee_person_id,t.owner_id))));
 elsif p_type='update.test' then
  return p_subject='person' and p_id=p_person;
 elsif p_type='task.review_nudge' then
  return p_subject='person' and p_id=p_person and exists(select 1 from task_review_queue(p_person));
 elsif p_type in ('task.help','task.reply') then
  return p_subject='comment' and exists(select 1 from work_comment c where c.org_id=current_org() and c.id=p_id and c.removed_at is null and c.author_id<>p_person
   and c.task_id is not null and work_task_person(c.task_id,p_person) and (p_type<>'task.help' or (c.kind='help' and c.resolved_at is null)));
 elsif p_type='policy.published' then
  return p_subject='policy' and exists(select 1 from policy_document where org_id=current_org() and id=p_id and status='published');
 elsif p_type='holiday.announced' then
  return p_subject='holiday' and exists(select 1 from holiday where org_id=current_org() and id=p_id);
 elsif p_type='payroll.processed' then
  return p_subject='payroll_notice' and exists(select 1 from payroll_processed_notice where org_id=current_org() and id=p_id and person_id=p_person);
 elsif p_type like 'attendance.%' or p_type like 'profile.%' or p_type='update.self' then
  return p_subject='person' and p_id=p_person;
 end if;
 return false;
end $function$;

-- ------------------------------------------------------------------------------------------- 5. the company's say
create or replace function pulse.work_settings_get() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('businessModel',coalesce(s.business_model,'agency'),'aiAutoAcceptMax',s.ai_auto_accept_max,'teamLabel',coalesce(s.team_label,'Pod'),'updatedAt',s.updated_at,
  'updatedBy',(select display_name from person where id=s.updated_by),'canEdit',coalesce(current_viewer() is not null and viewer_is('admin','leadership'),false),
  'reviewBy',coalesce(s.review_by,'assigner'),'reviewScale',coalesce(s.review_scale,'three'),'reviewLeaders',coalesce(s.review_leaders,'acknowledge'),
  'aboveBonus',coalesce(s.above_bonus,25),'helpPoints',coalesce(s.help_points,2),'reviewNudgeHours',coalesce(s.review_nudge_hours,24),
  'autoDone',coalesce(s.auto_done,'on'))
 from (select 1) x left join work_settings s on s.org_id=current_org()
$$;
-- 0310's setter, plus autoDone: "on" (Pulse finishes a task by itself when every signal is met) or "ask" (it only asks).
create or replace function pulse.work_settings_set(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cur work_settings;v_model text;v_max int;v_team text;v_by text;v_scale text;v_leaders text;v_bonus int;v_help int;v_nudge int;v_auto text;
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Leadership and admins choose how Pulse names your work' using errcode='42501';end if;
 if jsonb_typeof(p)<>'object' then raise exception 'Choose a setting' using errcode='22023';end if;
 select * into cur from work_settings where org_id=current_org() for update;
 v_model:=case when p ? 'businessModel' then p->>'businessModel' else coalesce(cur.business_model,'agency') end;
 if v_model not in ('agency','product','internal') then raise exception 'Choose agency, product or internal' using errcode='22023';end if;
 begin v_max:=case when p ? 'aiAutoAcceptMax' then nullif(p->>'aiAutoAcceptMax','')::int else cur.ai_auto_accept_max end;
 exception when others then raise exception 'Enter a number of value points from 1 to 100, or leave it off' using errcode='22023';end;
 if v_max is not null and v_max not between 1 and 100 then raise exception 'Enter a number of value points from 1 to 100, or leave it off' using errcode='22023';end if;
 -- TASKS-4A's team word (0290) is kept as it was.
 v_team:=case when p ? 'teamLabel' then nullif(initcap(btrim(regexp_replace(coalesce(p->>'teamLabel',''),'\s+',' ','g'))),'') else cur.team_label end;
 if v_team='Pod' then v_team:=null;end if;
 if v_team is not null and v_team !~ '^[[:alpha:]][[:alpha:] -]{1,19}$' then raise exception 'Call a team with one or two words, 2 to 20 letters' using errcode='22023';end if;
 v_by:=case when p ? 'reviewBy' then p->>'reviewBy' else coalesce(cur.review_by,'assigner') end;
 if v_by not in ('assigner','head','creator') then raise exception 'Choose who reviews: whoever assigned it, the head or whoever created it' using errcode='22023';end if;
 v_scale:=case when p ? 'reviewScale' then p->>'reviewScale' else coalesce(cur.review_scale,'three') end;
 if v_scale not in ('three','five') then raise exception 'Choose Great, Good, Needs work or a 1 to 5 rating' using errcode='22023';end if;
 v_leaders:=case when p ? 'reviewLeaders' then p->>'reviewLeaders' else coalesce(cur.review_leaders,'acknowledge') end;
 if v_leaders not in ('acknowledge','auto_proof','review') then raise exception 'Choose how leadership''s work is accepted' using errcode='22023';end if;
 v_auto:=case when p ? 'autoDone' then p->>'autoDone' else coalesce(cur.auto_done,'on') end;
 if v_auto not in ('on','ask') then raise exception 'Choose whether Pulse finishes tasks itself or asks' using errcode='22023';end if;
 begin
  v_bonus:=case when p ? 'aboveBonus' then (p->>'aboveBonus')::int else coalesce(cur.above_bonus,25) end;
  v_help:=case when p ? 'helpPoints' then (p->>'helpPoints')::int else coalesce(cur.help_points,2) end;
  v_nudge:=case when p ? 'reviewNudgeHours' then (p->>'reviewNudgeHours')::int else coalesce(cur.review_nudge_hours,24) end;
 exception when others then raise exception 'Enter whole numbers' using errcode='22023';end;
 if v_bonus not between 0 and 100 then raise exception 'The bonus for above and beyond is 0 to 100 percent' using errcode='22023';end if;
 if v_help not between 0 and 10 then raise exception 'Points for helping run from 0 to 10' using errcode='22023';end if;
 if v_nudge not between 4 and 168 then raise exception 'Nudge after 4 hours to 7 days' using errcode='22023';end if;
 insert into work_settings(org_id,business_model,ai_auto_accept_max,team_label,review_by,review_scale,review_leaders,above_bonus,help_points,review_nudge_hours,auto_done,updated_by)
 values(current_org(),v_model,v_max,v_team,v_by,v_scale,v_leaders,v_bonus,v_help,v_nudge,v_auto,current_viewer())
 on conflict(org_id) do update set business_model=excluded.business_model,ai_auto_accept_max=excluded.ai_auto_accept_max,team_label=excluded.team_label,review_by=excluded.review_by,review_scale=excluded.review_scale,
  review_leaders=excluded.review_leaders,above_bonus=excluded.above_bonus,help_points=excluded.help_points,review_nudge_hours=excluded.review_nudge_hours,auto_done=excluded.auto_done,
  updated_by=excluded.updated_by,updated_at=now();
 perform audit_write('work_settings_set','org',current_org()::text);
 return work_settings_get();
end $$;

revoke all on function pulse.app_event(text,text,jsonb),pulse.task_signal_take(pulse.task_signal,bigint,timestamptz,text,uuid),
 pulse.task_signal_observe(bigint,timestamptz,text,text,jsonb,uuid),pulse.task_auto_try(uuid),pulse.task_auto_blocker(uuid),
 pulse.task_auto_done_undo(uuid),pulse.task_companion_read(uuid),pulse.task_companion_set(uuid,jsonb),pulse.task_companion_attention(),
 pulse.task_companion_seen(uuid) from public;
grant execute on function pulse.task_auto_done_undo(uuid),pulse.task_companion_read(uuid),pulse.task_companion_set(uuid,jsonb),
 pulse.task_companion_attention(),pulse.task_companion_seen(uuid),pulse.task_auto_blocker(uuid) to pulse_api;
grant execute on function pulse.task_signal_matches(jsonb,jsonb) to pulse_api, pulse_worker;

-- migrate:down
-- Forward-only.
