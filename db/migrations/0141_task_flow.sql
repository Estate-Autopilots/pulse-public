-- migrate:up
-- RT1: tasks people use, on the existing task rows (the tracker import included). Subtasks, blockers, reviewer
-- acceptance with effort × impact points, proof, time from work, outcome-based work mode, KPIs and protected person
-- files. Writes go through the functions below: each checks who may act, records a task event and notifies through
-- the R27 inbox/outbox. Nothing is deleted: links, proof and time entries are retired with a timestamp.

-- Task fields ---------------------------------------------------------------------------------------------------------
-- A1 states: open (To do) → in_progress (Doing) → blocked → done → accepted. Legacy in_review reads as Done.
alter table pulse.task drop constraint task_status_check;
alter table pulse.task add constraint task_status_check check(status in ('unknown','open','in_progress','blocked','in_review','done','accepted','cancelled'));
alter table pulse.task
 add column parent_id uuid references pulse.task(id),
 add column priority text not null default 'normal' check(priority in ('low','normal','high','urgent')),
 add column notes text check(length(notes)<=4000),
 add column work_on date,                                   -- the day a tracker row names ("Model Video — Wednesday, 16 September")
 add column created_by uuid references pulse.person(id), add column created_at timestamptz,
 add column started_at timestamptz, add column done_at timestamptz,
 add column accepted_at timestamptz, add column accepted_by uuid references pulse.person(id),
 add column effort smallint check(effort between 1 and 5), add column impact smallint check(impact between 1 and 5),
 add column value_note text check(length(value_note)<=1000);
create index task_parent on pulse.task(org_id,parent_id) where parent_id is not null;
create index task_reviewer on pulse.task(org_id,review_owner_id) where review_owner_id is not null;
create index task_project_status on pulse.task(org_id,project_id,status);
create index task_done on pulse.task(org_id,assignee_person_id,done_at) where done_at is not null;
-- A project can ask for proof before its tasks are accepted.
alter table pulse.project add column requires_proof boolean not null default false;

create function pulse.task_parent_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.parent_id is null then return new;end if;
 if new.parent_id=new.id or exists(with recursive up(id,depth) as (select new.parent_id,1 union all
  select t.parent_id,u.depth+1 from task t join up u on t.id=u.id where t.parent_id is not null and u.depth<100) select 1 from up where id=new.id)
 then raise exception 'A task cannot sit under its own subtask' using errcode='22023';end if;
 return new;
end $$;
create trigger task_parent_guard before insert or update of parent_id on pulse.task for each row execute function pulse.task_parent_guard();

-- Blocked by / blocks, proof, history ---------------------------------------------------------------------------------
create table pulse.task_link (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 task_id uuid not null references pulse.task(id),          -- the task that waits
 blocker_id uuid not null references pulse.task(id),       -- the task it waits on
 note text check(length(note)<=300),created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 cleared_at timestamptz,cleared_by uuid references pulse.person(id),check(task_id<>blocker_id)
);
create unique index task_link_open on pulse.task_link(org_id,task_id,blocker_id) where cleared_at is null;
create index task_link_blocker on pulse.task_link(org_id,blocker_id) where cleared_at is null;
create table pulse_priv.work_file (                         -- proof files when no document store is connected (R39 absent)
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),task_id uuid not null references pulse.task(id),
 name text not null check(length(name) between 1 and 200),mime text not null check(mime ~ '^[a-z]+/[a-z0-9.+-]+$'),
 bytes bytea not null check(octet_length(bytes) between 1 and 8388608),sha256 text not null,
 added_by uuid references pulse.person(id),added_at timestamptz not null default now()
);
-- Protected documents on a person's profile (role terms, invoices): HR with the documents permission, or the person.
create table pulse_priv.hr_file (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),
 doc_kind text not null check(doc_kind in ('role_terms','roadmap','invoice','offer','agreement','other')),
 title text not null check(length(title) between 2 and 200),name text not null check(length(name) between 1 and 200),
 mime text not null check(mime in ('application/pdf','image/png','image/jpeg')),bytes bytea not null check(octet_length(bytes) between 1 and 8388608),
 sha256 text not null,source_key text not null,added_by uuid references pulse.person(id),added_at timestamptz not null default now(),
 unique(org_id,source_key)
);
create table pulse.task_proof (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),task_id uuid not null references pulse.task(id),
 kind text not null check(kind in ('link','file','document')),label text not null check(length(label) between 1 and 200),
 url text check(url ~ '^https?://[^\s]+$' and length(url)<=2000),file_id uuid references pulse_priv.work_file(id),hr_file_id uuid references pulse_priv.hr_file(id),
 source_key text,added_by uuid references pulse.person(id),added_at timestamptz not null default now(),removed_at timestamptz,removed_by uuid references pulse.person(id),
 check((kind='link' and url is not null) or (kind='file' and file_id is not null) or (kind='document' and hr_file_id is not null))
);
create index task_proof_task on pulse.task_proof(org_id,task_id) where removed_at is null;
create unique index task_proof_source on pulse.task_proof(org_id,source_key) where source_key is not null;
create table pulse.task_event (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),task_id uuid not null references pulse.task(id),
 actor_id uuid references pulse.person(id),kind text not null check(kind in ('created','edited','status','assigned','reviewer','blocked','unblocked','proof','accepted','returned','moved')),
 from_value text,to_value text,note text check(length(note)<=1000),at timestamptz not null default now()
);
create index task_event_task on pulse.task_event(org_id,task_id,at);

-- Time from work, work mode, KPIs -------------------------------------------------------------------------------------
create table pulse.time_entry (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),
 task_id uuid references pulse.task(id),project_id uuid references pulse.project(id),work_date date not null,
 minutes int not null check(minutes between 1 and 1440),note text check(length(note)<=500),
 source text not null check(source in ('manual','estimate','commit','agent_run','document','meeting')),
 status text not null default 'confirmed' check(status in ('proposed','confirmed','dismissed')),
 source_key text,evidence jsonb not null default '{}',created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 decided_at timestamptz,retired_at timestamptz
);
create unique index time_entry_source on pulse.time_entry(org_id,source_key) where source_key is not null;
create index time_entry_person on pulse.time_entry(org_id,person_id,work_date);
create table pulse.person_work_terms (
 org_id uuid not null references pulse.org(id),person_id uuid primary key references pulse.person(id),
 work_mode text not null default 'shift' check(work_mode in ('shift','outcome')),
 role_title text check(length(role_title)<=160),role_status text check(length(role_status)<=160),
 weekly_hours_min numeric(4,1) check(weekly_hours_min between 0 and 80),weekly_hours_max numeric(4,1) check(weekly_hours_max between 0 and 80),
 office_days_min smallint check(office_days_min between 0 and 7),office_days_max smallint check(office_days_max between 0 and 7),
 other_roles text[] not null default '{}',note text check(length(note)<=1000),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now()
);
create table pulse.kpi (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),person_id uuid not null references pulse.person(id),
 area text check(length(area)<=120),title text not null check(length(title) between 2 and 300),target text check(length(target)<=500),
 measure text check(length(measure)<=500),due_on date,progress smallint check(progress between 0 and 100),
 status text not null default 'not_started' check(status in ('not_started','on_track','at_risk','behind','met','missed')),
 latest_note text check(length(latest_note)<=1000),source text not null check(length(source)<=200),source_key text not null,position int not null default 0,
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),unique(org_id,source_key)
);
create table pulse.kpi_update (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),kpi_id uuid not null references pulse.kpi(id),
 progress smallint check(progress between 0 and 100),status text not null,note text check(length(note)<=1000),
 by_id uuid references pulse.person(id),at timestamptz not null default now()
);

do $$ declare t text;begin
 foreach t in array array['task_link','task_proof','task_event','time_entry','person_work_terms','kpi','kpi_update'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select on pulse.%I to pulse_api',t);
  execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
 foreach t in array array['work_file','hr_file'] loop
  execute format('alter table pulse_priv.%I enable row level security',t);
  execute format('alter table pulse_priv.%I force row level security',t);
  execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select,insert,update on pulse_priv.%I to pulse_worker',t);
 end loop;
end $$;
-- The functions run as the owner, so the protected-file policy binds them too (as for hr_document in 0005).
do $$ begin
 execute format($f$create policy hr_file_reader on pulse_priv.hr_file as restrictive for select to %I
  using (pulse.hr_can('hr.documents.read') or person_id=pulse.current_viewer())$f$,current_user);
end $$;

-- Who may see and change a task ---------------------------------------------------------------------------------------
-- Leadership, HR and admins see every task. Others see tasks they do, review or created, their pod's tasks, tasks they
-- manage, the tasks that block (or parent) theirs, so a blocked task shows what it waits on and who owns that, and the
-- tasks waiting on theirs.
create function pulse.task_visible_row(p_id uuid,p_owner uuid,p_assignee uuid,p_reviewer uuid,p_creator uuid,p_project uuid,p_parent uuid)
 returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('admin','leadership','hr')
 or current_viewer() in (p_owner,p_assignee,p_reviewer,p_creator)
 or coalesce(manages(p_owner),false) or coalesce(manages(p_assignee),false)
 or exists(select 1 from people_profile me join people_profile them on them.org_id=me.org_id and them.pod=me.pod
  where me.org_id=current_org() and me.person_id=current_viewer() and me.pod is not null and them.person_id=coalesce(p_assignee,p_owner,p_creator))
 or exists(select 1 from project pr join role_assignment r on r.unit_id=pr.unit_id where pr.id=p_project and r.person_id=current_viewer()
  and (r.is_manager_of_unit or r.role_key in ('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))
 or exists(select 1 from task_link l join task b on b.id=l.task_id where l.org_id=current_org() and l.blocker_id=p_id and l.cleared_at is null
  and current_viewer() in (b.owner_id,b.assignee_person_id,b.review_owner_id,b.created_by))
 or exists(select 1 from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and l.task_id=p_id and l.cleared_at is null
  and current_viewer() in (b.owner_id,b.assignee_person_id))
 or exists(select 1 from task par where par.org_id=current_org() and par.id=p_parent and current_viewer() in (par.owner_id,par.assignee_person_id,par.review_owner_id,par.created_by)))
$$;
create function pulse.task_visible(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from task t where t.org_id=current_org() and t.id=p_id and task_visible_row(t.id,t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by,t.project_id,t.parent_id))
$$;
drop policy task_person on pulse.task;
create policy task_person on pulse.task as restrictive for select to pulse_api using(pulse.task_visible_row(id,owner_id,assignee_person_id,review_owner_id,created_by,project_id,parent_id));
create policy visible on pulse.task_link as restrictive for select to pulse_api using(pulse.task_visible(task_id) or pulse.task_visible(blocker_id));
create policy visible on pulse.task_proof as restrictive for select to pulse_api using(pulse.task_visible(task_id));
create policy visible on pulse.task_event as restrictive for select to pulse_api using(pulse.task_visible(task_id));
create policy visible on pulse.time_entry as restrictive for select to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','leadership','hr') or pulse.manages(person_id));
create policy visible on pulse.person_work_terms as restrictive for select to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','leadership','hr') or pulse.manages(person_id));
create policy visible on pulse.kpi as restrictive for select to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin','leadership','hr') or pulse.manages(person_id));
create policy visible on pulse.kpi_update as restrictive for select to pulse_api using(exists(select 1 from pulse.kpi k where k.id=kpi_id));

-- Leadership, HR and admins give work to anyone; a pod head (or manager) to their own people; everyone to themselves.
create function pulse.task_can_give(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (p_person=current_viewer() or viewer_is('admin','leadership','hr') or coalesce(manages(p_person),false))
$$;
create function pulse.task_can_edit(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from task t where t.org_id=current_org() and t.id=p_id and current_viewer() is not null and (viewer_is('admin','leadership','hr')
 or current_viewer() in (t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by)
 or coalesce(manages(t.assignee_person_id),false) or coalesce(manages(t.owner_id),false)
 or (t.assignee_person_id is null and t.owner_id is null and task_visible_row(t.id,t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by,t.project_id,t.parent_id))))
$$;
create function pulse.work_mode(p_person uuid) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select work_mode from person_work_terms where org_id=current_org() and person_id=p_person),'shift')
$$;
create function pulse.task_person_ok(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active')
$$;
create function pulse.task_event_add(p_task uuid,p_kind text,p_from text,p_to text,p_note text default null) returns void
 language sql security definer set search_path=pulse,pg_temp as $$
 insert into task_event(org_id,task_id,actor_id,kind,from_value,to_value,note) values(current_org(),p_task,current_viewer(),p_kind,p_from,p_to,p_note)
$$;
-- An open blocker is a linked task that is not finished.
create function pulse.task_open_blockers(p_task uuid) returns int language sql stable security definer set search_path=pulse,pg_temp as $$
 select count(*)::int from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and l.task_id=p_task and l.cleared_at is null
 and b.status not in ('done','accepted','cancelled','in_review')
$$;
create function pulse.task_require_viewer() returns uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not task_person_ok(current_viewer()) then raise exception 'Sign in as a team member to manage tasks' using errcode='42501';end if;
 return current_viewer();
end $$;
create function pulse.task_for_edit(p_id uuid) returns pulse.task language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t task;
begin
 perform task_require_viewer();
 select * into t from task where org_id=current_org() and id=p_id for update;
 if not found or not task_visible(p_id) then raise exception 'Task not found' using errcode='P0002';end if;
 if not task_can_edit(p_id) then raise exception 'Only the people on this task, their pod head or leadership can change it' using errcode='42501';end if;
 return t;
end $$;

-- Notifications (R27 contract): blocked, unblocked, due soon, done (ready to accept), accepted --------------------------
alter table pulse.notification drop constraint notification_event_type_check;
alter table pulse.notification add constraint notification_event_type_check check(event_type in ('update.self','chat.message','chat.mention','chat.reply','policy.published','holiday.announced',
 'task.assigned','task.blocked','task.unblocked','task.due_soon','task.done','task.accepted','leave.decision','request.updated','request.decision','approval.waiting','approval.reminder',
 'payroll.processed','attendance.start','attendance.end','attendance.done','attendance.departure','attendance.confirmed'));
create or replace function pulse.notification_recipient_allowed(p_person uuid,p_type text,p_subject text,p_id uuid)
 returns boolean language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active') then return false;end if;
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
  -- The person doing the task: assigned to them, waiting no longer, due within a day, accepted by the reviewer.
  return p_subject='task' and exists(select 1 from task where org_id=current_org() and id=p_id and coalesce(owner_id,assignee_person_id)=p_person
   and (p_type<>'task.accepted' or status='accepted') and (p_type<>'task.due_soon' or status not in ('done','accepted','cancelled','in_review')));
 elsif p_type='task.blocked' then
  -- The owner of a task that another task waits on.
  return p_subject='task' and exists(select 1 from task b where b.org_id=current_org() and b.id=p_id and coalesce(b.owner_id,b.assignee_person_id)=p_person
   and exists(select 1 from task_link l where l.org_id=current_org() and l.blocker_id=b.id and l.cleared_at is null));
 elsif p_type='task.done' then
  -- The reviewer of a task waiting for acceptance.
  return p_subject='task' and exists(select 1 from task where org_id=current_org() and id=p_id and review_owner_id=p_person and status in ('done','in_review','accepted'));
 elsif p_type='policy.published' then
  return p_subject='policy' and exists(select 1 from policy_document where org_id=current_org() and id=p_id and status='published');
 elsif p_type='holiday.announced' then
  return p_subject='holiday' and exists(select 1 from holiday where org_id=current_org() and id=p_id);
 elsif p_type='payroll.processed' then
  return p_subject='payroll_notice' and exists(select 1 from payroll_processed_notice where org_id=current_org() and id=p_id and person_id=p_person);
 elsif p_type like 'attendance.%' or p_type='update.self' then
  return p_subject='person' and p_id=p_person;
 end if;
 return false;
end $$;
-- Assigning yourself ("Take it") notifies nobody; assigning someone else still uses the R27 producer.
create or replace function pulse.companion_work_update() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare target uuid;recipient uuid;
begin
 if current_viewer() is null then return null;end if;
 if TG_TABLE_NAME='task' then
  target:=coalesce(new.owner_id,new.assignee_person_id);
  if target is null or target=current_viewer() or TG_OP='UPDATE' and target is not distinct from coalesce(old.owner_id,old.assignee_person_id) then return null;end if;
  perform notification_emit(target,'task.assigned','task',new.id,new.id||':'||new.notification_revision,'A task was assigned to you','/tasks/'||new.id,'task');
 elsif TG_TABLE_NAME='policy_document' then
  if new.status<>'published' or TG_OP='UPDATE' and old.status='published' then return null;end if;
  for recipient in select id from person where org_id=new.org_id and side='staff' and status='active' loop
   perform notification_emit(recipient,'policy.published','policy',new.id,new.id::text,'A policy update is ready','/me?tab=policies&kind='||new.kind,'policy');
  end loop;
 elsif TG_TABLE_NAME='holiday' then
  if TG_OP='UPDATE' and (new.name,new.optional,new.day) is not distinct from (old.name,old.optional,old.day) then return null;end if;
  for recipient in select id from person where org_id=new.org_id and side='staff' and status='active' loop
   perform notification_emit(recipient,'holiday.announced','holiday',new.id,new.id||':'||new.notification_revision,'The holiday list was updated','/me?tab=leave','holiday');
  end loop;
 end if;return null;
end $$;
-- Older assignment notifications keep their /tasks?task= links; the inbox contract accepts both forms.
create function pulse.task_notify(p_person uuid,p_type text,p_task uuid,p_key text,p_title text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if p_person is null or p_person=current_viewer() then return null;end if;
 return notification_emit(p_person,p_type,'task',p_task,p_key,left(p_title,160),'/tasks/'||p_task,'task');
end $$;

-- Writes --------------------------------------------------------------------------------------------------------------
create function pulse.task_due_from(p jsonb) returns timestamptz language plpgsql stable as $$
begin
 if nullif(p->>'dueOn','') is not null then return ((p->>'dueOn')::date+time '18:00') at time zone 'Asia/Kolkata';end if;
 if nullif(p->>'dueAt','') is not null then return (p->>'dueAt')::timestamptz;end if;
 return null;
exception when others then raise exception 'Choose a valid due date' using errcode='22023';
end $$;
-- Create (p_id null) or change a task. Only the keys present in p change.
create function pulse.task_save(p_id uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;nid uuid;v_title text;v_assignee uuid;v_reviewer uuid;v_project uuid;v_parent uuid;v_due timestamptz;
 v_priority text;v_notes text;v_value text;v_label text;changed text[]:='{}';
begin
 if jsonb_typeof(p)<>'object' then raise exception 'Describe the task' using errcode='22023';end if;
 if p_id is not null then t:=task_for_edit(p_id);end if;
 v_title:=case when p ? 'title' then btrim(regexp_replace(p->>'title','\s+',' ','g')) else t.title end;
 if coalesce(v_title,'')='' or length(v_title)>300 then raise exception 'Name the task in up to 300 characters' using errcode='22023';end if;
 v_assignee:=case when p ? 'assigneeId' then nullif(p->>'assigneeId','')::uuid when p_id is null then me else t.assignee_person_id end;
 if v_assignee is not null and v_assignee is distinct from t.assignee_person_id then
  if not task_person_ok(v_assignee) then raise exception 'Choose an active team member' using errcode='22023';end if;
  if not task_can_give(v_assignee) then raise exception 'You can give tasks to your own pod. Leadership, HR and admins can give tasks to anyone.' using errcode='42501';end if;
 end if;
 v_reviewer:=case when p ? 'reviewerId' then nullif(p->>'reviewerId','')::uuid when p_id is null then
  case when v_assignee is null or me<>v_assignee then me else coalesce(hr_head(v_assignee),(select manager_id from people_profile where person_id=v_assignee)) end else t.review_owner_id end;
 if v_reviewer is not null and v_reviewer is distinct from t.review_owner_id and not task_person_ok(v_reviewer) then raise exception 'Choose an active reviewer' using errcode='22023';end if;
 if v_reviewer=v_assignee and p ? 'reviewerId' then raise exception 'Choose a reviewer other than the person doing the task' using errcode='22023';end if;
 if v_reviewer=v_assignee then v_reviewer:=null;end if;
 v_project:=case when p ? 'projectId' then nullif(p->>'projectId','')::uuid else t.project_id end;
 if v_project is not null and v_project is distinct from t.project_id and not exists(select 1 from project where org_id=current_org() and id=v_project) then raise exception 'Choose a project' using errcode='22023';end if;
 v_parent:=case when p ? 'parentId' then nullif(p->>'parentId','')::uuid else t.parent_id end;
 if v_parent is not null and v_parent is distinct from t.parent_id and not task_visible(v_parent) then raise exception 'Choose a parent task you can see' using errcode='22023';end if;
 if p_id is null and v_parent is not null and v_project is null then select project_id into v_project from task where id=v_parent;end if;
 v_due:=case when p ? 'dueOn' or p ? 'dueAt' then task_due_from(p) else t.due_at end;
 -- A typed deadline replaces the tracker's free-text label; a label can still be given on its own ("end of month").
 v_label:=case when p ? 'dueLabel' then left(nullif(btrim(p->>'dueLabel'),''),120) when v_due is distinct from t.due_at then null else t.due_label end;
 v_priority:=case when p ? 'priority' then p->>'priority' else coalesce(t.priority,'normal') end;
 if v_priority not in ('low','normal','high','urgent') then raise exception 'Choose a priority' using errcode='22023';end if;
 v_notes:=case when p ? 'notes' then nullif(btrim(p->>'notes'),'') else t.notes end;
 v_value:=case when p ? 'valueNote' then nullif(btrim(p->>'valueNote'),'') else t.value_note end;
 if length(v_notes)>4000 or length(v_value)>1000 then raise exception 'Keep notes under 4,000 characters' using errcode='22023';end if;
 if p_id is null then
  insert into task(org_id,title,status,project_id,parent_id,owner_id,assignee_person_id,review_owner_id,due_at,due_label,priority,notes,value_note,source,created_by,created_at,edited_by,updated_at,assigned_at,locked)
  values(current_org(),v_title,'open',v_project,v_parent,v_assignee,v_assignee,v_reviewer,v_due,v_label,v_priority,v_notes,v_value,'pulse',me,now(),me,now(),case when v_assignee is not null then now() end,'{title,status,owner_id,project_id,due_label}')
  returning id into nid;
  perform task_event_add(nid,'created',null,v_title);
  if v_assignee is not null and v_assignee<>me then perform task_event_add(nid,'assigned',null,(select display_name from person where id=v_assignee));end if;
  perform audit_write('create','task',nid::text);
  return nid;
 end if;
 if v_title is distinct from t.title then changed:=changed||'title'::text;end if;
 if v_assignee is distinct from t.assignee_person_id then changed:=changed||'owner_id'::text;
  perform task_event_add(p_id,'assigned',(select display_name from person where id=t.assignee_person_id),coalesce((select display_name from person where id=v_assignee),'Anyone'));end if;
 if v_reviewer is distinct from t.review_owner_id then perform task_event_add(p_id,'reviewer',(select display_name from person where id=t.review_owner_id),(select display_name from person where id=v_reviewer));end if;
 if v_project is distinct from t.project_id then changed:=changed||'project_id'::text;end if;
 if v_parent is distinct from t.parent_id then perform task_event_add(p_id,'moved',null,(select title from task where id=v_parent));end if;
 if v_due is distinct from t.due_at or v_label is distinct from t.due_label then changed:=changed||'due_label'::text;end if;
 if v_title is distinct from t.title or v_project is distinct from t.project_id or v_due is distinct from t.due_at or v_label is distinct from t.due_label or v_priority is distinct from t.priority or v_notes is distinct from t.notes or v_value is distinct from t.value_note then
  perform task_event_add(p_id,'edited',null,null);end if;
 update task set title=v_title,assignee_person_id=v_assignee,owner_id=v_assignee,review_owner_id=v_reviewer,project_id=v_project,parent_id=v_parent,due_at=v_due,
  due_label=v_label,priority=v_priority,notes=v_notes,value_note=v_value,
  assigned_at=case when v_assignee is distinct from t.assignee_person_id then now() else assigned_at end,
  edited_by=me,updated_at=now(),locked=array(select distinct unnest(locked||changed)) where id=p_id;
 return p_id;
end $$;

-- Clear blockers that finished or that someone cleared; return the waiting task to work and tell its owner.
create function pulse.task_release_waiting(p_blocker uuid) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare w record;n int:=0;
begin
 for w in select t.* from task t where t.org_id=current_org() and t.status='blocked'
  and t.id in (select l.task_id from task_link l where l.org_id=current_org() and l.blocker_id=p_blocker) for update loop
  if task_open_blockers(w.id)=0 then
   update task set status=case when started_at is not null then 'in_progress' else 'open' end,updated_at=now() where id=w.id;
   perform task_event_add(w.id,'unblocked','blocked',case when w.started_at is not null then 'in_progress' else 'open' end);
   perform task_notify(coalesce(w.owner_id,w.assignee_person_id),'task.unblocked',w.id,w.id||':unblocked:'||now()::text,'Unblocked: '||w.title);
   n:=n+1;
  end if;
 end loop;return n;
end $$;
-- Drag between columns, or a status button. Accepted is the reviewer's step (task_accept).
create function pulse.task_move(p_id uuid,p_status text,p_note text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;released int:=0;
begin
 t:=task_for_edit(p_id);
 if p_status not in ('open','in_progress','blocked','done','cancelled') then raise exception 'Choose To do, Doing, Blocked, Done or Cancelled; the reviewer accepts' using errcode='22023';end if;
 if t.status='accepted' and not (viewer_is('admin','leadership') or me=t.review_owner_id) then raise exception 'An accepted task can be reopened by its reviewer or leadership' using errcode='42501';end if;
 if p_status=t.status then return jsonb_build_object('status',t.status);end if;
 -- Leaving Blocked by hand clears its blockers: that is the Unblock action.
 if t.status='blocked' and p_status<>'blocked' then
  update task_link set cleared_at=now(),cleared_by=me where org_id=current_org() and task_id=p_id and cleared_at is null;
 end if;
 update task set status=p_status,updated_at=now(),edited_by=me,locked=array(select distinct unnest(locked||'{status}'::text[])),
  started_at=case when p_status='in_progress' and started_at is null then now() else started_at end,
  done_at=case when p_status='done' then now() when p_status in ('open','in_progress','blocked') then null else done_at end,
  accepted_at=case when p_status<>'accepted' then null else accepted_at end,accepted_by=case when p_status<>'accepted' then null else accepted_by end
 where id=p_id;
 perform task_event_add(p_id,'status',t.status,p_status,nullif(btrim(coalesce(p_note,'')),''));
 if p_status in ('done','cancelled') then released:=task_release_waiting(p_id);end if;
 if p_status='done' then perform task_notify(t.review_owner_id,'task.done',p_id,p_id||':done:'||now()::text,'Ready to accept: '||t.title);end if;
 return jsonb_build_object('status',p_status,'released',released);
end $$;
create function pulse.task_accept(p_id uuid,p_effort int,p_impact int,p_note text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;
begin
 select * into t from task where org_id=current_org() and id=p_id for update;
 if not found or not task_visible(p_id) then raise exception 'Task not found' using errcode='P0002';end if;
 if me=coalesce(t.assignee_person_id,t.owner_id) then raise exception 'Someone else accepts your work' using errcode='42501';end if;
 if not (me=t.review_owner_id or (t.review_owner_id is null and (viewer_is('admin','leadership') or coalesce(manages(t.assignee_person_id),false)))) then
  raise exception 'Only the reviewer accepts this task' using errcode='42501';end if;
 if t.status not in ('done','in_review') then raise exception 'Mark the task Done before accepting it' using errcode='22023';end if;
 if p_effort not between 1 and 5 or p_impact not between 1 and 5 then raise exception 'Rate effort and impact from 1 to 5' using errcode='22023';end if;
 if exists(select 1 from project where id=t.project_id and requires_proof) and not exists(select 1 from task_proof where task_id=p_id and removed_at is null) then
  raise exception 'This project needs proof before acceptance: attach a file or link' using errcode='22023';end if;
 update task set status='accepted',accepted_at=now(),accepted_by=me,effort=p_effort,impact=p_impact,
  value_note=coalesce(nullif(btrim(coalesce(p_note,'')),''),value_note),done_at=coalesce(done_at,now()),updated_at=now(),edited_by=me,
  locked=array(select distinct unnest(locked||'{status}'::text[])) where id=p_id;
 perform task_event_add(p_id,'accepted',t.status,'accepted',format('%s points (effort %s × impact %s)',p_effort*p_impact,p_effort,p_impact));
 perform task_notify(coalesce(t.owner_id,t.assignee_person_id),'task.accepted',p_id,p_id||':accepted:'||now()::text,format('Accepted: %s · %s points',t.title,p_effort*p_impact));
 return jsonb_build_object('status','accepted','points',p_effort*p_impact);
end $$;
create function pulse.task_return(p_id uuid,p_note text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;
begin
 select * into t from task where org_id=current_org() and id=p_id for update;
 if not found or not task_visible(p_id) then raise exception 'Task not found' using errcode='P0002';end if;
 if not (me=t.review_owner_id or viewer_is('admin','leadership')) or me=t.assignee_person_id then raise exception 'Only the reviewer returns this task' using errcode='42501';end if;
 if t.status not in ('done','in_review','accepted') then raise exception 'Only finished work can be returned' using errcode='22023';end if;
 if length(btrim(coalesce(p_note,'')))<3 then raise exception 'Say what still needs doing' using errcode='22023';end if;
 update task set status='in_progress',done_at=null,accepted_at=null,accepted_by=null,updated_at=now(),edited_by=me where id=p_id;
 perform task_event_add(p_id,'returned',t.status,'in_progress',btrim(p_note));
 perform task_notify(coalesce(t.owner_id,t.assignee_person_id),'task.assigned',p_id,p_id||':returned:'||now()::text,'Returned with a note: '||t.title);
end $$;
create function pulse.task_block(p_task uuid,p_blocker uuid,p_note text default null) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;b task;lid uuid;
begin
 t:=task_for_edit(p_task);
 select * into b from task where org_id=current_org() and id=p_blocker;
 if not found or not task_visible(p_blocker) then raise exception 'Choose a task you can see as the blocker' using errcode='22023';end if;
 if p_task=p_blocker then raise exception 'A task cannot wait on itself' using errcode='22023';end if;
 if exists(with recursive chain(id,depth) as (select p_blocker,1 union all select l.blocker_id,c.depth+1 from task_link l join chain c on l.task_id=c.id where l.cleared_at is null and c.depth<100) select 1 from chain where id=p_task)
 then raise exception 'That would make the two tasks wait on each other' using errcode='22023';end if;
 insert into task_link(org_id,task_id,blocker_id,note,created_by) values(current_org(),p_task,p_blocker,nullif(btrim(coalesce(p_note,'')),''),me)
  on conflict (org_id,task_id,blocker_id) where cleared_at is null do nothing returning id into lid;
 if lid is null then raise exception 'This task already waits on that one' using errcode='23505';end if;
 perform task_event_add(p_task,'blocked',null,b.title,nullif(btrim(coalesce(p_note,'')),''));
 if b.status not in ('done','accepted','cancelled','in_review') and t.status in ('open','in_progress','unknown') then
  update task set status='blocked',updated_at=now(),edited_by=me,locked=array(select distinct unnest(locked||'{status}'::text[])) where id=p_task;
  perform task_event_add(p_task,'status',t.status,'blocked');
 end if;
 if b.status not in ('done','accepted','cancelled','in_review') then
  perform task_notify(coalesce(b.owner_id,b.assignee_person_id),'task.blocked',p_blocker,lid::text,format('“%s” is waiting on your task “%s”',left(t.title,60),left(b.title,60)));
 end if;
 return lid;
end $$;
-- Clear one blocker (the waiting task's people, or whoever owns the blocker) or every blocker of a task.
create function pulse.task_unblock(p_task uuid,p_blocker uuid default null) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;n int;
begin
 select * into t from task where org_id=current_org() and id=p_task for update;
 if not found or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
 if not (task_can_edit(p_task) or (p_blocker is not null and exists(select 1 from task b where b.id=p_blocker and me in (b.owner_id,b.assignee_person_id)))) then
  raise exception 'Only the people on either task, their pod head or leadership can clear a blocker' using errcode='42501';end if;
 update task_link set cleared_at=now(),cleared_by=me where org_id=current_org() and task_id=p_task and cleared_at is null and (p_blocker is null or blocker_id=p_blocker);
 get diagnostics n=row_count;
 if n=0 then raise exception 'Nothing is blocking this task' using errcode='22023';end if;
 perform task_event_add(p_task,'unblocked',null,coalesce((select title from task where id=p_blocker),'all blockers'));
 if t.status='blocked' and task_open_blockers(p_task)=0 then
  update task set status=case when started_at is not null then 'in_progress' else 'open' end,updated_at=now(),edited_by=me where id=p_task;
  perform task_notify(coalesce(t.owner_id,t.assignee_person_id),'task.unblocked',p_task,p_task||':unblocked:'||now()::text,'Unblocked: '||t.title);
 end if;
 return n;
end $$;
create function pulse.task_proof_add(p_task uuid,p_label text,p_url text,p_bytes bytea default null,p_name text default null,p_mime text default null) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;fid uuid;pid uuid;
begin
 t:=task_for_edit(p_task);
 if p_bytes is not null then
  if octet_length(p_bytes)>8388608 then raise exception 'Attach files up to 8 MB, or link a Drive file' using errcode='22023';end if;
  if coalesce(p_mime,'') !~ '^(application/pdf|image/(png|jpeg|webp|gif)|text/(plain|csv)|application/(zip|vnd\.openxmlformats-officedocument\.[a-z.]+))$' then raise exception 'Attach a PDF, image, text, spreadsheet, document or zip file' using errcode='22023';end if;
  insert into pulse_priv.work_file(org_id,task_id,name,mime,bytes,sha256,added_by) values(current_org(),p_task,left(coalesce(nullif(btrim(p_name),''),'proof'),200),p_mime,p_bytes,encode(sha256(p_bytes),'hex'),me) returning id into fid;
  insert into task_proof(org_id,task_id,kind,label,file_id,added_by) values(current_org(),p_task,'file',left(coalesce(nullif(btrim(p_label),''),nullif(btrim(p_name),''),'File'),200),fid,me) returning id into pid;
 else
  if coalesce(p_url,'') !~ '^https?://[^\s]+$' or length(p_url)>2000 then raise exception 'Paste a full link starting with https://' using errcode='22023';end if;
  insert into task_proof(org_id,task_id,kind,label,url,added_by) values(current_org(),p_task,'link',left(coalesce(nullif(btrim(p_label),''),regexp_replace(p_url,'^https?://([^/]+).*$','\1')),200),p_url,me) returning id into pid;
 end if;
 perform task_event_add(p_task,'proof',null,(select label from task_proof where id=pid));
 return pid;
end $$;
create function pulse.task_proof_remove(p_proof uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();tid uuid;
begin
 select task_id into tid from task_proof where org_id=current_org() and id=p_proof and removed_at is null;
 if tid is null then raise exception 'Proof not found' using errcode='P0002';end if;
 perform task_for_edit(tid);
 if exists(select 1 from task where id=tid and status='accepted') then raise exception 'Accepted work keeps its proof' using errcode='22023';end if;
 update task_proof set removed_at=now(),removed_by=me where id=p_proof;
end $$;
-- A proof file opens for anyone who can see its task; a protected document only through the HR document permission or for its person.
create function pulse.task_proof_read(p_proof uuid) returns table(name text,mime text,bytes bytea) language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pr task_proof;
begin
 select * into pr from task_proof where org_id=current_org() and id=p_proof and removed_at is null;
 if not found or not task_visible(pr.task_id) then raise exception 'Proof not found' using errcode='P0002';end if;
 if pr.kind='file' then return query select f.name,f.mime,f.bytes from pulse_priv.work_file f where f.id=pr.file_id;
 elsif pr.kind='document' then
  if not exists(select 1 from pulse_priv.hr_file f where f.id=pr.hr_file_id) then raise exception 'This document is protected. HR, the founders and the person it concerns can open it.' using errcode='42501';end if;
  perform hr_log((select person_id from pulse_priv.hr_file where id=pr.hr_file_id),'hr.documents','task_proof');
  return query select f.name,f.mime,f.bytes from pulse_priv.hr_file f where f.id=pr.hr_file_id;
 else raise exception 'This proof is a link' using errcode='22023';end if;
end $$;
-- Protected person files: the list and the bytes, each read logged against the person.
create function pulse.hr_file_list(p_person uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not (hr_can('hr.documents.read') or p_person=current_viewer()) then return '[]'::jsonb;end if;
 perform hr_log(p_person,'hr.documents','hr_file_list');
 return coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'kind',f.doc_kind,'title',f.title,'name',f.name,'mime',f.mime,'size',octet_length(f.bytes),'addedAt',f.added_at) order by f.added_at,f.title)
  from pulse_priv.hr_file f where f.org_id=current_org() and f.person_id=p_person),'[]'::jsonb);
end $$;
create function pulse.hr_file_read(p_id uuid) returns table(name text,mime text,bytes bytea) language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who uuid;
begin
 select person_id into who from pulse_priv.hr_file where org_id=current_org() and id=p_id;
 if who is null then raise exception 'Document not found or protected' using errcode='42501';end if;
 perform hr_log(who,'hr.documents','hr_file_read');
 return query select f.name,f.mime,f.bytes from pulse_priv.hr_file f where f.id=p_id;
end $$;

-- Time from work ------------------------------------------------------------------------------------------------------
create function pulse.time_log(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();v_task uuid:=nullif(p->>'taskId','')::uuid;v_project uuid:=nullif(p->>'projectId','')::uuid;v_date date;v_minutes int;nid uuid;
begin
 begin v_date:=(p->>'date')::date;v_minutes:=round((p->>'minutes')::numeric);exception when others then raise exception 'Enter a date and the time spent' using errcode='22023';end;
 if v_date is null or v_date>current_date+1 or v_date<current_date-400 then raise exception 'Choose a date within the last year' using errcode='22023';end if;
 if v_minutes is null or v_minutes not between 1 and 1440 then raise exception 'Enter between 1 minute and 24 hours' using errcode='22023';end if;
 if v_task is not null then
  if not task_visible(v_task) then raise exception 'Choose a task you can see' using errcode='22023';end if;
  v_project:=coalesce(v_project,(select project_id from task where id=v_task));
 end if;
 if v_project is not null and not exists(select 1 from project where org_id=current_org() and id=v_project) then raise exception 'Choose a project' using errcode='22023';end if;
 insert into time_entry(org_id,person_id,task_id,project_id,work_date,minutes,note,source,status,created_by,decided_at)
 values(current_org(),me,v_task,v_project,v_date,v_minutes,nullif(btrim(coalesce(p->>'note','')),''),'manual','confirmed',me,now()) returning id into nid;
 if v_task is not null then perform task_event_add(v_task,'edited',null,null,format('%s min logged',v_minutes));end if;
 return nid;
end $$;
-- Only the person confirms or dismisses time proposed from evidence; a confirmed entry can be retired (never deleted).
create function pulse.time_decide(p_id uuid,p_decision text,p_minutes int default null) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 elsif p_decision='retire' then update time_entry set retired_at=now() where id=p_id;
 else raise exception 'Choose confirm, dismiss or retire' using errcode='22023';end if;
end $$;
-- Workers propose time from evidence (commits, agent runs, documents, meetings). Re-running never duplicates.
create function pulse.time_propose(p_person uuid,p_date date,p_minutes int,p_source text,p_key text,p_note text,p_task uuid default null,p_project uuid default null,p_evidence jsonb default '{}')
 returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;
begin
 if current_viewer() is not null then raise exception 'Time proposals come from evidence workers' using errcode='42501';end if;
 insert into time_entry(org_id,person_id,task_id,project_id,work_date,minutes,note,source,status,source_key,evidence)
 values(current_org(),p_person,p_task,coalesce(p_project,(select project_id from task where id=p_task)),p_date,p_minutes,left(p_note,500),p_source,'proposed',p_key,coalesce(p_evidence,'{}'))
 on conflict (org_id,source_key) where source_key is not null do nothing returning id into nid;
 return nid;
end $$;

-- Work mode and KPIs --------------------------------------------------------------------------------------------------
create function pulse.work_terms_set(p_person uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();before text;
begin
 if me is null or not viewer_is('admin','hr') then raise exception 'Only admins and HR set work mode and role terms' using errcode='42501';end if;
 if not task_person_ok(p_person) then raise exception 'Choose an active team member' using errcode='22023';end if;
 if p ? 'workMode' and p->>'workMode' not in ('shift','outcome') then raise exception 'Choose Shift or Outcome-based' using errcode='22023';end if;
 before:=work_mode(p_person);
 insert into person_work_terms(org_id,person_id,updated_by) values(current_org(),p_person,me) on conflict(person_id) do nothing;
 update person_work_terms set
  work_mode=case when p ? 'workMode' then p->>'workMode' else work_mode end,
  role_title=case when p ? 'roleTitle' then nullif(btrim(p->>'roleTitle'),'') else role_title end,
  role_status=case when p ? 'roleStatus' then nullif(btrim(p->>'roleStatus'),'') else role_status end,
  weekly_hours_min=case when p ? 'weeklyHoursMin' then nullif(p->>'weeklyHoursMin','')::numeric else weekly_hours_min end,
  weekly_hours_max=case when p ? 'weeklyHoursMax' then nullif(p->>'weeklyHoursMax','')::numeric else weekly_hours_max end,
  office_days_min=case when p ? 'officeDaysMin' then nullif(p->>'officeDaysMin','')::smallint else office_days_min end,
  office_days_max=case when p ? 'officeDaysMax' then nullif(p->>'officeDaysMax','')::smallint else office_days_max end,
  other_roles=case when p ? 'otherRoles' then array(select btrim(x) from jsonb_array_elements_text(p->'otherRoles') x where btrim(x)<>'') else other_roles end,
  note=case when p ? 'note' then nullif(btrim(p->>'note'),'') else note end,
  updated_by=me,updated_at=now() where org_id=current_org() and person_id=p_person;
 if work_mode(p_person) is distinct from before then
  insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'person',p_person,'workMode',before,work_mode(p_person),me);
 end if;
end $$;
create function pulse.kpi_progress(p_id uuid,p_progress int,p_status text,p_note text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();k kpi;
begin
 select * into k from kpi where org_id=current_org() and id=p_id for update;
 if not found or not (k.person_id=me or viewer_is('admin','leadership','hr') or coalesce(manages(k.person_id),false)) then raise exception 'KPI not found' using errcode='P0002';end if;
 if p_progress is not null and p_progress not between 0 and 100 then raise exception 'Progress is 0 to 100%%' using errcode='22023';end if;
 if p_status not in ('not_started','on_track','at_risk','behind','met','missed') then raise exception 'Choose a KPI status' using errcode='22023';end if;
 update kpi set progress=coalesce(p_progress,progress),status=p_status,latest_note=coalesce(nullif(btrim(coalesce(p_note,'')),''),latest_note),updated_by=me,updated_at=now() where id=p_id;
 insert into kpi_update(org_id,kpi_id,progress,status,note,by_id) values(current_org(),p_id,p_progress,p_status,nullif(btrim(coalesce(p_note,'')),''),me);
end $$;

-- Due soon (the notification worker calls this every run) -------------------------------------------------------------
create function pulse.task_due_tick() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t record;n int:=0;
begin
 for t in select id,title,coalesce(owner_id,assignee_person_id) who,due_at from task where org_id=current_org() and coalesce(owner_id,assignee_person_id) is not null
  and status in ('open','in_progress','blocked') and due_at between now() and now()+interval '24 hours' and source='pulse' loop
  if notification_emit(t.who,'task.due_soon','task',t.id,t.id||':due:'||t.due_at::text,'Due soon: '||left(t.title,120),'/tasks/'||t.id,'task') is not null then n:=n+1;end if;
 end loop;return n;
end $$;

-- Tracker rows: A1 states, "Type — Day, date" titles and the projects the tracker names ---------------------------------
create function pulse.task_tracker_type(p_title text) returns text language sql immutable as $$
 select case
  when k in ('single image c','single image creative','single image') then 'Single image creative'
  when k like 'single image ads%' then 'Single image ads'
  when k='scripting' then 'Scripting' when k='video shoot' then 'Video shoot'
  when k in ('video finalized','video finalised') then 'Video finalised' when k='onboarding' then 'Onboarding'
  when k in ('vov','vov editing','vov ad','vov video') then 'VOV edit' when k in ('carousal','carousel') then 'Carousel'
  when k in ('model video','main model video') then 'Model video' when k='campaign live' then 'Campaign live'
  when k='first follow up' then 'Follow-up' when k='booking velocity check' then 'Booking velocity check'
  when k='creative editing' then 'Creative editing' when k='weekly lead review cadence' then 'Lead review'
  when p_title ~* '^\s*(updated |finall? |sample flat )?(voice ?over|vov)' then 'VOV edit'
  when p_title ~* '^\s*updated (vid|video)' then 'Revision'
  when p_title ~* '^\s*(image )?creatives?\M' then 'Creative'
 end from (select lower(btrim(split_part(coalesce(p_title,''),' — ',1))) k) x
$$;
-- "16 September", "6th June", "23rd of May" or an ISO date; the year comes from the tracker period ("sept 2026", "Videos Mar 26").
create function pulse.task_tracker_date(p_text text,p_period text) returns date language plpgsql immutable as $$
declare m text[];y int;mon int;pm int;months text[]:=array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
begin
 if coalesce(btrim(p_text),'')='' then return null;end if;
 if p_text ~ '^\s*\d{4}-\d{2}-\d{2}' then return substring(p_text from '\d{4}-\d{2}-\d{2}')::date;end if;
 m:=regexp_match(lower(p_text),'(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*');
 if m is null then return null;end if;
 mon:=array_position(months,m[2]);
 y:=coalesce((regexp_match(coalesce(p_period,''),'(20\d\d)'))[1]::int,2000+(regexp_match(coalesce(p_period,''),'\m(2\d)\s*$'))[1]::int);
 if y is null then return null;end if;
 pm:=array_position(months,(regexp_match(lower(coalesce(p_period,'')),'(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)'))[1]);
 if pm is not null and mon-pm<-6 then y:=y+1;elsif pm is not null and mon-pm>6 then y:=y-1;end if;
 return make_date(y,mon,m[1]::int);
exception when others then return null;
end $$;
create function pulse.task_tracker_normalise() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n_status int;n_type int;n_due int;n_project int;
begin
 if current_viewer() is not null and not viewer_is('admin') then raise exception 'Admins or the import worker normalise tracker rows' using errcode='42501';end if;
 update task set status=x.s from (select id,case
   when k ~ '^(edit |vid |video |creative )?(completed?|done|finished|finali[sz]ed)$' or k in ('creative finalised','creative finalized','vid finalised','video finalised') then 'done'
   when k ~ '^(edit )?in (process|progress)$' then 'in_progress'
   when k ~ '^(edit )?pending$' or k in ('incomplete','open','to do','todo') then 'open'
   when k='blocked' then 'blocked' when k in ('cancelled','canceled') then 'cancelled' end s
  from (select id,lower(regexp_replace(btrim(coalesce(source_status,'')),'\s+',' ','g')) k from task where org_id=current_org() and source='imported') q) x
  where task.id=x.id and x.s is not null and task.status is distinct from x.s and task.status in ('unknown','open','in_progress') and not 'status'=any(task.locked)
  and not (task.status='in_progress' and x.s='open');
 get diagnostics n_status=row_count;
 update task t set deliverable_type=coalesce(t.deliverable_type,task_tracker_type(t.title)),
  work_on=coalesce(t.work_on,case when position(' — ' in t.title)>0 then task_tracker_date(split_part(t.title,' — ',2),t.source_period) end)
  where t.org_id=current_org() and t.source='imported' and ((t.deliverable_type is null and task_tracker_type(t.title) is not null)
  or (t.work_on is null and position(' — ' in t.title)>0 and task_tracker_date(split_part(t.title,' — ',2),t.source_period) is not null));
 get diagnostics n_type=row_count;
 update task t set due_at=(task_tracker_date(t.due_label,t.source_period)+time '18:00') at time zone 'Asia/Kolkata'
  where t.org_id=current_org() and t.source='imported' and t.due_at is null and coalesce(t.due_label,'')<>'' and not 'due_label'=any(t.locked)
  and task_tracker_date(t.due_label,t.source_period) is not null;
 get diagnostics n_due=row_count;
 -- Link a tracker engagement name to its project only when exactly one current project carries it.
 update task t set project_id=m.pid from (
  select t2.id tid,min(p.id::text)::uuid pid,count(distinct p.id) n from task t2 join project p on p.org_id=t2.org_id
   and lower(btrim(t2.project_key)) in (lower(btrim(p.project_key)),lower(btrim(split_part(p.project_key,'@',1))),lower(btrim(coalesce(p.title,p.name))))
  where t2.org_id=current_org() and t2.project_id is null and coalesce(btrim(t2.project_key),'')<>'' and not 'project_id'=any(t2.locked)
   and p.status<>'cancelled' and not exists(select 1 from record_merge rm where rm.org_id=p.org_id and rm.entity_type='project' and rm.gone_id=p.id and rm.undone_at is null)
  group by t2.id) m where t.id=m.tid and m.n=1;
 get diagnostics n_project=row_count;
 return jsonb_build_object('status',n_status,'typedOrDated',n_type,'due',n_due,'linked',n_project);
end $$;
-- Link every task carrying one tracker name to the project an admin chooses.
create function pulse.task_link_tracker_project(p_key text,p_project uuid) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Leadership links tracker names to projects' using errcode='42501';end if;
 if not exists(select 1 from project where org_id=current_org() and id=p_project) then raise exception 'Choose a project' using errcode='22023';end if;
 update task set project_id=p_project,edited_by=current_viewer(),updated_at=now(),locked=array(select distinct unnest(locked||'{project_id}'::text[]))
  where org_id=current_org() and project_id is null and lower(btrim(project_key))=lower(btrim(p_key));
 get diagnostics n=row_count;
 perform audit_write('link_tracker_project','project',p_project::text);
 return n;
end $$;
do $$ declare o uuid;previous_org text:=current_setting('pulse.org_id',true);begin
 for o in select id from pulse.org loop
  perform set_config('pulse.org_id',o::text,true);
  perform pulse.task_tracker_normalise();
 end loop;
 perform set_config('pulse.org_id',coalesce(previous_org,''),true);
end $$;

-- HR → Pod heads: save every pod card at once; accepted review suggestions are closed in the same transaction ----------
create function pulse.hr_pods_save(p jsonb) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare card jsonb;members uuid[];head uuid;n int:=0;s uuid;
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'HR required' using errcode='42501';end if;
 if jsonb_typeof(p->'pods')<>'array' then raise exception 'Choose pods' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('hr-pods:'||current_org()));
 for card in select * from jsonb_array_elements(p->'pods') loop
  if not exists(select 1 from unit where org_id=current_org() and kind='pod' and name=card->>'name' and valid_to is null) then raise exception 'Pod % is not a current pod',card->>'name' using errcode='22023';end if;
  members:=array(select x::uuid from jsonb_array_elements_text(coalesce(card->'members','[]')) x);
  head:=nullif(card->>'headId','')::uuid;
  if head is not null then perform hr_pod_set(card->>'name',head,members);
  else
   if exists(select 1 from unnest(members) x where not task_person_ok(x)) then raise exception 'Active staff required' using errcode='22023';end if;
   update people_profile set pod=null,updated_at=now(),locked=array(select distinct unnest(locked||array['pod'])) where org_id=current_org() and pod=card->>'name' and person_id<>all(members);
   update people_profile set pod=card->>'name',updated_at=now(),locked=array(select distinct unnest(locked||array['pod'])) where org_id=current_org() and person_id=any(members) and pod is distinct from card->>'name';
  end if;
  n:=n+1;
 end loop;
 for s in select x::uuid from jsonb_array_elements_text(coalesce(p->'accepted','[]')) x loop
  update review_item set status='accepted',decided_by=current_viewer(),decided_at=now() where org_id=current_org() and id=s and status='pending';
 end loop;
 perform audit_write('hr_pods_save','pod',null);
 return n;
end $$;

-- Outcome-based people: the R19b late and half-day rules do not apply ---------------------------------------------------
create or replace function pulse.hr_rule_days(p_person uuid,p_from date,p_to date) returns table(day date,late boolean,half_day boolean,net_minutes numeric,arrival time,complete boolean,remote boolean) language sql stable security definer set search_path=pulse,pg_temp as $$
 with grouped as (
 select e.work_date as day,min(e.checked_in_at) first_in,bool_and(e.checked_out_at is not null and not e.missed_out and e.checked_out_at>=e.checked_in_at and e.checked_out_at<=e.checked_in_at+interval '16 hours') complete,
 (array_agg(e.late_minutes order by e.checked_in_at,e.id))[1]>0 late,
 range_agg(tstzrange(e.checked_in_at,coalesce(e.checked_out_at,e.checked_in_at),'[)')) spans
 from attendance_effective e where e.person_id=p_person and (p_person=current_viewer() or viewer_is('admin','hr','leadership') or manages(p_person)) and e.work_date between p_from and p_to group by e.work_date
 ), data as (
 select g.*,not exists(select 1 from attendance_regularisation r where r.person_id=p_person and r.work_date=g.day and r.status='pending' and r.kind='missed_punch') correction_clear,
 exists(select 1 from attendance_regularisation r where r.person_id=p_person and r.work_date=g.day and r.status='approved' and r.kind in('wfh','on_duty')) remote,
 exists(select 1 from hr_rule_waiver w where w.person_id=p_person and w.work_date=g.day) waived,
 g.spans-coalesce((select range_agg(tstzrange(b.started_at,coalesce(b.ended_at,b.started_at),'[)')) from attendance_break b join attendance_effective e on e.id=b.entry_id where e.person_id=p_person and e.work_date=g.day),'{}'::tstzmultirange) net,
 hr_rule_at('half_day',g.day) half_rule
 from grouped g
 ), measured as (
 select d.*,coalesce((select sum(extract(epoch from upper(r)-lower(r))/60) from unnest(net) r),0) minutes from data d
 )
 select day,late and not waived and hr_person_working(p_person,day) and work_mode(p_person)='shift',
 half_rule is not null and complete and correction_clear and not remote and hr_person_working(p_person,day) and work_mode(p_person)='shift' and (minutes<(half_rule->>'netMinutes')::numeric or (first_in at time zone 'Asia/Kolkata')::time>(half_rule->>'arrivalCutoff')::time),
 minutes,(first_in at time zone 'Asia/Kolkata')::time,complete and correction_clear,remote from measured order by day
$$;

-- Compensation terms in the existing protected salary area -------------------------------------------------------------
alter table pulse_priv.hr_compensation drop constraint hr_compensation_kind_check;
alter table pulse_priv.hr_compensation add constraint hr_compensation_kind_check check(kind in ('monthly','current','increment','total','invoice'));
alter table pulse_priv.hr_compensation add column terms_status text check(terms_status in ('proposed','conditional','settled','active')),
 add column terms_note text check(length(terms_note)<=500);
create or replace function pulse.hr_salary_components_read(p_person uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not hr_can('hr.salary.read') then raise exception 'denied' using errcode='42501'; end if;
 perform hr_log(p_person,'hr.salary','hr_profile_components');
 return coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'month',c.effective_month,'kind',c.kind,'amount',c.amount,'currency',c.currency,
 'sourceName',c.source_name,'sourceSheet',c.source_sheet,'basis',c.basis,'components',c.components,'effectiveFrom',c.effective_from,'effectiveTo',c.effective_to,
 'termsStatus',c.terms_status,'termsNote',c.terms_note)
 order by c.effective_month desc,c.kind) from pulse_priv.hr_compensation c where c.person_id=p_person),'[]');
end $$;

revoke all on function pulse.task_parent_guard(),pulse.task_visible_row(uuid,uuid,uuid,uuid,uuid,uuid,uuid),pulse.task_visible(uuid),pulse.task_can_give(uuid),pulse.task_can_edit(uuid),
 pulse.work_mode(uuid),pulse.task_person_ok(uuid),pulse.task_event_add(uuid,text,text,text,text),pulse.task_open_blockers(uuid),pulse.task_require_viewer(),pulse.task_for_edit(uuid),
 pulse.task_notify(uuid,text,uuid,text,text),pulse.task_due_from(jsonb),pulse.task_save(uuid,jsonb),pulse.task_release_waiting(uuid),pulse.task_move(uuid,text,text),
 pulse.task_accept(uuid,int,int,text),pulse.task_return(uuid,text),pulse.task_block(uuid,uuid,text),pulse.task_unblock(uuid,uuid),
 pulse.task_proof_add(uuid,text,text,bytea,text,text),pulse.task_proof_remove(uuid),pulse.task_proof_read(uuid),pulse.hr_file_list(uuid),pulse.hr_file_read(uuid),
 pulse.time_log(jsonb),pulse.time_decide(uuid,text,int),pulse.time_propose(uuid,date,int,text,text,text,uuid,uuid,jsonb),pulse.work_terms_set(uuid,jsonb),
 pulse.kpi_progress(uuid,int,text,text),pulse.task_due_tick(),pulse.task_tracker_normalise(),pulse.task_link_tracker_project(text,uuid),pulse.hr_pods_save(jsonb) from public;
grant execute on function pulse.task_visible_row(uuid,uuid,uuid,uuid,uuid,uuid,uuid),pulse.task_visible(uuid),pulse.task_can_give(uuid),pulse.task_can_edit(uuid),pulse.work_mode(uuid),
 pulse.task_open_blockers(uuid),pulse.task_save(uuid,jsonb),pulse.task_move(uuid,text,text),pulse.task_accept(uuid,int,int,text),pulse.task_return(uuid,text),
 pulse.task_block(uuid,uuid,text),pulse.task_unblock(uuid,uuid),pulse.task_proof_add(uuid,text,text,bytea,text,text),pulse.task_proof_remove(uuid),pulse.task_proof_read(uuid),
 pulse.hr_file_list(uuid),pulse.hr_file_read(uuid),pulse.time_log(jsonb),pulse.time_decide(uuid,text,int),pulse.work_terms_set(uuid,jsonb),pulse.kpi_progress(uuid,int,text,text),
 pulse.task_tracker_normalise(),pulse.task_link_tracker_project(text,uuid),pulse.hr_pods_save(jsonb) to pulse_api;
grant execute on function pulse.task_visible_row(uuid,uuid,uuid,uuid,uuid,uuid,uuid),pulse.task_visible(uuid),pulse.work_mode(uuid),pulse.task_open_blockers(uuid),
 pulse.time_propose(uuid,date,int,text,text,text,uuid,uuid,jsonb),pulse.task_due_tick(),pulse.task_tracker_normalise(),pulse.hr_file_list(uuid) to pulse_worker;
-- migrate:down
-- Forward-only: task links, proof, time entries, work terms and KPI history are company records and are never dropped.
