-- migrate:up
-- UX-TASKS: clients are a separate world. A client project is the package sold (pulse.project, kind client_work);
-- the work that delivers it is its fulfilment project, and the company's own work is internal projects. Both kinds of
-- work project are rows of pulse.work_project, one per project: a fulfilment row shares its client project's id, so
-- tasks, deliveries and Drive folders keep every link they have; an internal row belongs to an internal project.
-- Who may create projects, assign and ask is a small rule matrix that HR and admins adjust inside fixed limits.
-- Collaboration: project members, task collaborators and watchers, asks (take / invite / join) that the other person
-- accepts or declines, and comments with @mentions. Every write goes through the functions below; nothing is deleted.

-- Client projects (the packages sold) ---------------------------------------------------------------------------------
alter table pulse.project add column scope text check(length(scope)<=2000),
 add column starts_on date,add column ends_on date,
 add constraint project_package_dates check(ends_on is null or starts_on is null or ends_on>=starts_on);
-- The value of a package is commercial: leadership and admins read it through client_project_value().
create table pulse_priv.client_project_value (
 org_id uuid not null references pulse.org(id),project_id uuid primary key references pulse.project(id),
 amount numeric(14,2) not null check(amount>=0),currency text not null default 'INR' check(currency ~ '^[A-Z]{3}$'),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now()
);

-- Work projects: internal, or the fulfilment of one client project --------------------------------------------------
create table pulse.work_project (
 org_id uuid not null references pulse.org(id),
 project_id uuid primary key references pulse.project(id),
 kind text not null check(kind in ('internal','fulfilment')),
 owner_id uuid references pulse.person(id),
 pod text check(length(pod)<=80),
 starts_on date,due_on date,check(due_on is null or starts_on is null or due_on>=starts_on),
 status text not null default 'active' check(status in ('planned','active','paused','done','cancelled')),
 summary text check(length(summary)<=1000),
 template_key text check(length(template_key)<=40),
 set_up_at timestamptz,                                      -- someone gave it an owner, dates, people or a template
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now()
);
create index work_project_owner on pulse.work_project(org_id,owner_id);
create index work_project_kind on pulse.work_project(org_id,kind,status);
create table pulse.project_member (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 project_id uuid not null references pulse.project(id),person_id uuid not null references pulse.person(id),
 role text not null check(role in ('member','watcher')),
 added_by uuid references pulse.person(id),added_at timestamptz not null default now(),
 left_at timestamptz,left_by uuid references pulse.person(id)
);
create unique index project_member_current on pulse.project_member(org_id,project_id,person_id) where left_at is null;
create index project_member_person on pulse.project_member(org_id,person_id) where left_at is null;
-- Collaborators work on a task with its owner; watchers follow it.
create table pulse.task_member (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 task_id uuid not null references pulse.task(id),person_id uuid not null references pulse.person(id),
 role text not null check(role in ('collaborator','watcher')),
 added_by uuid references pulse.person(id),added_at timestamptz not null default now(),
 removed_at timestamptz,removed_by uuid references pulse.person(id)
);
create unique index task_member_current on pulse.task_member(org_id,task_id,person_id) where removed_at is null;
create index task_member_person on pulse.task_member(org_id,person_id) where removed_at is null;
-- Steps a template creates keep their order.
alter table pulse.task add column position smallint;

-- Asks: "please take this task", "join this task or project", "may I join?". The person asked accepts or declines.
create table pulse.work_ask (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 kind text not null check(kind in ('take','invite','join')),
 task_id uuid references pulse.task(id),project_id uuid references pulse.project(id),
 from_id uuid not null references pulse.person(id),to_id uuid not null references pulse.person(id),
 note text check(length(note)<=500),
 status text not null default 'pending' check(status in ('pending','accepted','declined','withdrawn')),
 created_at timestamptz not null default now(),decided_at timestamptz,answer_note text check(length(answer_note)<=500),
 check((task_id is null)<>(project_id is null)),check(kind<>'take' or task_id is not null),check(from_id<>to_id)
);
create unique index work_ask_open on pulse.work_ask(org_id,kind,coalesce(task_id,project_id),from_id,to_id) where status='pending';
create index work_ask_to on pulse.work_ask(org_id,to_id,status);
create index work_ask_task on pulse.work_ask(org_id,task_id) where task_id is not null;
create index work_ask_project on pulse.work_ask(org_id,project_id) where project_id is not null;
create table pulse.work_comment (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 task_id uuid references pulse.task(id),project_id uuid references pulse.project(id),check((task_id is null)<>(project_id is null)),
 author_id uuid not null references pulse.person(id),
 body text not null check(length(btrim(body)) between 1 and 4000),
 mentions uuid[] not null default '{}' check(cardinality(mentions)<=20),
 created_at timestamptz not null default now(),removed_at timestamptz,removed_by uuid references pulse.person(id)
);
create index work_comment_task on pulse.work_comment(org_id,task_id,created_at) where task_id is not null;
create index work_comment_project on pulse.work_comment(org_id,project_id,created_at) where project_id is not null;

-- Who can do what: one cell per role and action, inside the limits work_rule_options() allows ---------------------------
create table pulse.work_rule (
 org_id uuid not null references pulse.org(id),
 role text not null check(role in ('hr','pod_head','member')),
 action text not null check(action in ('task.assign','task.ask','project.create')),
 scope text not null check(scope in ('anyone','pod','self','none')),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 primary key(org_id,role,action)
);
-- Projects the migration could not place without a person deciding: a package with no client, or a kind that
-- disagrees with its client. Leadership answers each in one click; nothing is guessed.
create table pulse.work_review (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 project_id uuid not null references pulse.project(id),
 reason text not null check(reason in ('no_client','client_kind')),
 detail jsonb not null default '{}',
 status text not null default 'pending' check(status in ('pending','decided')),
 decision text check(decision in ('client','internal')),
 decided_by uuid references pulse.person(id),decided_at timestamptz,created_at timestamptz not null default now(),
 unique(org_id,project_id,reason)
);
alter table pulse.task_event drop constraint task_event_kind_check;
alter table pulse.task_event add constraint task_event_kind_check check(kind in ('created','edited','status','assigned','reviewer','blocked','unblocked','proof','accepted','returned','moved','asked','joined'));

do $$ declare t text;begin
 foreach t in array array['work_project','project_member','task_member','work_ask','work_comment','work_rule','work_review'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select on pulse.%I to pulse_api',t);
  execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
 alter table pulse_priv.client_project_value enable row level security;
 alter table pulse_priv.client_project_value force row level security;
 create policy tenant on pulse_priv.client_project_value using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
 grant select,insert,update on pulse_priv.client_project_value to pulse_worker;
 create trigger audit_mutation after insert or update on pulse_priv.client_project_value for each row execute function pulse.audit_mutation();
end $$;

-- Roles and reach ----------------------------------------------------------------------------------------------------
-- Leadership (admins and leadership) is fixed; HR, pod heads and members follow the matrix.
create function pulse.work_role(p_person uuid default pulse.current_viewer()) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select case when p_person is null then 'none'
  when exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p_person and r.role_key in ('admin','leadership') and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) then 'leadership'
  when exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p_person and r.role_key='hr' and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) then 'hr'
  when hr_is_pod_head(p_person) or exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p_person and (r.is_manager_of_unit or r.role_key in ('manager','pgs','head_pgs'))
   and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) or exists(select 1 from people_profile where org_id=current_org() and manager_id=p_person) then 'pod_head'
  else 'member' end
$$;
-- The allowed choices for one cell; the first is the default. Leadership cannot be narrowed, and nobody can be widened
-- past these limits (a pod head never assigns outside the pod, a member never assigns beyond their pod).
create function pulse.work_rule_options(p_role text,p_action text) returns text[] language sql immutable as $$
 select case p_role||':'||p_action
  when 'hr:task.assign' then array['anyone','pod','self'] when 'hr:task.ask' then array['anyone','pod','none'] when 'hr:project.create' then array['anyone','pod','none']
  when 'pod_head:task.assign' then array['pod','self'] when 'pod_head:task.ask' then array['anyone','pod','none'] when 'pod_head:project.create' then array['pod','none']
  when 'member:task.assign' then array['self','pod'] when 'member:task.ask' then array['anyone','pod','none'] when 'member:project.create' then array['none','pod'] end
$$;
create function pulse.work_scope(p_action text,p_person uuid default pulse.current_viewer()) returns text language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare r text:=work_role(p_person);
begin
 if r='none' then return 'none';end if;
 if r='leadership' then return 'anyone';end if;
 return coalesce((select scope from work_rule where org_id=current_org() and role=r and action=p_action),(work_rule_options(r,p_action))[1],'none');
end $$;
-- Pods the viewer belongs to or heads, and the ones they head (hr_pod, a managing unit role, or people reporting to them).
create function pulse.work_head_pods() returns text[] language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(array_agg(distinct x) filter(where x is not null),'{}') from (
  select name x from hr_pod where org_id=current_org() and head_id=current_viewer()
  union select u.name from role_assignment r join unit u on u.id=r.unit_id where r.org_id=current_org() and r.person_id=current_viewer() and u.kind='pod' and u.valid_to is null
   and (r.is_manager_of_unit or r.role_key in ('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity')
  union select pod from people_profile me where me.org_id=current_org() and me.person_id=current_viewer() and exists(select 1 from people_profile x where x.org_id=current_org() and x.manager_id=current_viewer())) s
$$;
create function pulse.work_my_pods() returns text[] language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(array_agg(distinct x) filter(where x is not null),'{}') from (
  select pod x from people_profile where org_id=current_org() and person_id=current_viewer() union select unnest(work_head_pods())) s
$$;
create function pulse.work_reaches(p_scope text,p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and p_person is not null and case p_scope
  when 'anyone' then true when 'self' then p_person=current_viewer()
  when 'pod' then p_person=current_viewer() or coalesce(manages(p_person),false)
   or exists(select 1 from people_profile where org_id=current_org() and person_id=p_person and pod=any(work_my_pods()))
  else false end
$$;
-- Giving a task now follows the matrix (the defaults are RT1's: leadership and HR anyone, a pod head the pod, others themselves).
create or replace function pulse.task_can_give(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (p_person=current_viewer() or work_reaches(work_scope('task.assign'),p_person))
$$;
create function pulse.work_can_create_project(p_pod text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and case work_scope('project.create') when 'anyone' then true when 'pod' then p_pod is not null and p_pod=any(work_my_pods()) else false end
$$;
-- On a project: its owner or a member (watchers follow it but are not on it).
create function pulse.work_project_person(p_project uuid,p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_project is not null and p_person is not null and (exists(select 1 from work_project where org_id=current_org() and project_id=p_project and owner_id=p_person)
  or exists(select 1 from project_member where org_id=current_org() and project_id=p_project and person_id=p_person and role='member' and left_at is null))
$$;
-- Sees a project's work: on it or watching it, a head of its pod, or leadership and HR.
create function pulse.work_project_in(p_project uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_project is not null and current_viewer() is not null and (
  exists(select 1 from project_member m where m.org_id=current_org() and m.project_id=p_project and m.person_id=current_viewer() and m.left_at is null)
  or exists(select 1 from work_project wp where wp.org_id=current_org() and wp.project_id=p_project and (wp.owner_id=current_viewer() or (wp.pod is not null and wp.pod=any(work_head_pods()))))
  or viewer_is('admin','leadership','hr'))
$$;
create function pulse.work_project_can_manage(p_project uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and exists(select 1 from work_project wp where wp.org_id=current_org() and wp.project_id=p_project and (
  work_role()='leadership' or wp.owner_id=current_viewer() or work_scope('project.create')='anyone'
  or (wp.pod is not null and wp.pod=any(work_head_pods()) and work_scope('project.create')<>'none')))
$$;
-- On a task: doing, reviewing or created it, or a collaborator or watcher.
create function pulse.work_task_person(p_task uuid,p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from task t where t.org_id=current_org() and t.id=p_task and p_person in (t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by))
  or exists(select 1 from task_member m where m.org_id=current_org() and m.task_id=p_task and m.person_id=p_person and m.removed_at is null)
$$;

-- Task visibility and editing gain project membership, collaborators and asks ---------------------------------------
create or replace function pulse.task_visible_row(p_id uuid,p_owner uuid,p_assignee uuid,p_reviewer uuid,p_creator uuid,p_project uuid,p_parent uuid)
 returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('admin','leadership','hr')
 or current_viewer() in (p_owner,p_assignee,p_reviewer,p_creator)
 or exists(select 1 from task_member m where m.org_id=current_org() and m.task_id=p_id and m.person_id=current_viewer() and m.removed_at is null)
 or exists(select 1 from work_ask a where a.org_id=current_org() and a.task_id=p_id and a.to_id=current_viewer() and a.status='pending')
 or coalesce(manages(p_owner),false) or coalesce(manages(p_assignee),false)
 or exists(select 1 from people_profile me join people_profile them on them.org_id=me.org_id and them.pod=me.pod
  where me.org_id=current_org() and me.person_id=current_viewer() and me.pod is not null and them.person_id=coalesce(p_assignee,p_owner,p_creator))
 or exists(select 1 from project pr join role_assignment r on r.unit_id=pr.unit_id where pr.id=p_project and r.person_id=current_viewer()
  and (r.is_manager_of_unit or r.role_key in ('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))
 or work_project_in(p_project)
 or exists(select 1 from task_link l join task b on b.id=l.task_id where l.org_id=current_org() and l.blocker_id=p_id and l.cleared_at is null
  and current_viewer() in (b.owner_id,b.assignee_person_id,b.review_owner_id,b.created_by))
 or exists(select 1 from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and l.task_id=p_id and l.cleared_at is null
  and current_viewer() in (b.owner_id,b.assignee_person_id))
 or exists(select 1 from task par where par.org_id=current_org() and par.id=p_parent and current_viewer() in (par.owner_id,par.assignee_person_id,par.review_owner_id,par.created_by)))
$$;
create or replace function pulse.task_can_edit(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from task t where t.org_id=current_org() and t.id=p_id and current_viewer() is not null and (viewer_is('admin','leadership','hr')
 or current_viewer() in (t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by)
 or coalesce(manages(t.assignee_person_id),false) or coalesce(manages(t.owner_id),false)
 or exists(select 1 from task_member m where m.org_id=current_org() and m.task_id=t.id and m.person_id=current_viewer() and m.role='collaborator' and m.removed_at is null)
 or (t.project_id is not null and work_project_can_manage(t.project_id))
 or (t.assignee_person_id is null and t.owner_id is null and task_visible_row(t.id,t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by,t.project_id,t.parent_id))))
$$;
create policy visible on pulse.task_member as restrictive for select to pulse_api using(pulse.task_visible(task_id));
create policy visible on pulse.work_ask as restrictive for select to pulse_api using(pulse.current_viewer() in (from_id,to_id) or pulse.viewer_is('admin','leadership','hr')
 or (task_id is not null and pulse.task_visible(task_id)) or (project_id is not null and pulse.work_project_in(project_id)));
create policy visible on pulse.work_comment as restrictive for select to pulse_api using(removed_at is null and
 ((task_id is not null and pulse.task_visible(task_id)) or (project_id is not null and pulse.work_project_in(project_id))));
create policy visible on pulse.work_review as restrictive for select to pulse_api using(pulse.viewer_is('admin','leadership','hr'));

-- Notifications: asks, answers, mentions, comments, being added and watched tasks ------------------------------------
alter table pulse.notification drop constraint notification_event_type_check;
alter table pulse.notification add constraint notification_event_type_check check(event_type in ('update.self','chat.message','chat.mention','chat.reply','policy.published','holiday.announced',
 'task.assigned','task.blocked','task.unblocked','task.due_soon','task.done','task.accepted','task.ask','project.ask','ask.answered','task.mention','project.mention',
 'task.comment','project.comment','project.added','task.update','leave.decision','request.updated','request.decision','approval.waiting','approval.reminder',
 'payroll.processed','attendance.start','attendance.end','attendance.done','attendance.departure','attendance.confirmed'));
alter table pulse.notification drop constraint notification_subject_type_check;
alter table pulse.notification add constraint notification_subject_type_check check(subject_type in ('person','message','hr_flow','task','policy','holiday','payroll_notice','project','work_ask','comment'));
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
-- Nobody is notified of their own action; titles stay short enough for a phone banner.
create function pulse.work_notify(p_person uuid,p_type text,p_subject text,p_id uuid,p_key text,p_title text,p_href text,p_kind text default 'task') returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if p_person is null or p_person=current_viewer() then return null;end if;
 return notification_emit(p_person,p_type,p_subject,p_id,left(p_key,200),left(p_title,160),p_href,p_kind);
end $$;
create function pulse.work_first_name(p_person uuid) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(split_part(regexp_replace(display_name,'^(mr|mrs|ms|dr|miss)\.?\s+','','i'),' ',1),'Someone') from person where org_id=current_org() and id=p_person
$$;
-- Watchers and collaborators hear the moments that matter on a task they follow.
create function pulse.task_watch_notify() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record;
begin
 if current_viewer() is null or new.status is not distinct from old.status or new.status not in ('in_progress','blocked','done','accepted','cancelled') then return null;end if;
 for r in select person_id from task_member where org_id=new.org_id and task_id=new.id and removed_at is null
  and person_id is distinct from coalesce(new.assignee_person_id,new.owner_id) and person_id is distinct from new.review_owner_id loop
  perform work_notify(r.person_id,'task.update','task',new.id,new.id||':'||new.status||':'||now()::text,
   case new.status when 'done' then 'Done: ' when 'accepted' then 'Accepted: ' when 'blocked' then 'Blocked: ' when 'in_progress' then 'Started: ' else 'Cancelled: ' end||new.title,'/tasks/'||new.id,'task');
 end loop;
 return null;
end $$;
create trigger task_watch_notify after update of status on pulse.task for each row execute function pulse.task_watch_notify();

-- Every project has its work project: a client project its fulfilment, an internal project itself --------------------
create function pulse.work_project_follow() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 insert into work_project(org_id,project_id,kind,owner_id,pod,starts_on,status,created_by)
 values(new.org_id,new.id,case when new.kind='internal' then 'internal' else 'fulfilment' end,new.lead_person_id,(select name from unit where id=new.unit_id),
  coalesce(new.starts_on,new.start_month),case when new.status='onboarding' then 'active' else new.status end,current_viewer())
 on conflict(project_id) do update set kind=excluded.kind,updated_at=now() where work_project.kind is distinct from excluded.kind;
 return null;
end $$;

-- Templates: the steps a new project starts with, spread over its dates ------------------------------------------------
create function pulse.work_templates() returns jsonb language sql immutable as $$
 select '[{"key":"video","name":"Video package","for":"fulfilment","steps":["Shoot","Edit","Review","Deliver"]},
  {"key":"creatives","name":"Creative set","for":"fulfilment","steps":["Brief","Design","Review","Deliver"]},
  {"key":"campaign","name":"Campaign launch","for":"fulfilment","steps":["Plan the campaign","Creatives ready","Set up the ads","Go live","First results report"]},
  {"key":"onboarding","name":"Client onboarding","for":"fulfilment","steps":["Kick-off call","Collect inputs","Plan the shoot","Confirm the schedule"]},
  {"key":"initiative","name":"Internal initiative","for":"internal","steps":["Scope","Build","Review","Launch"]}]'::jsonb
$$;
create function pulse.work_template_apply(p_project uuid,p_key text) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare tpl jsonb;wp work_project;steps text[];n int;i int:=0;s text;due date;tid uuid;
begin
 select x into tpl from jsonb_array_elements(work_templates()) x where x->>'key'=p_key;
 if tpl is null then raise exception 'Choose a template' using errcode='22023';end if;
 select * into wp from work_project where org_id=current_org() and project_id=p_project;
 steps:=array(select jsonb_array_elements_text(tpl->'steps'));n:=cardinality(steps);
 foreach s in array steps loop
  i:=i+1;
  -- Spread the steps evenly from the start to the due date; with only a due date, the last step is due then.
  due:=case when wp.due_on is null then null when wp.starts_on is null then case when i=n then wp.due_on end
   else wp.starts_on+round((wp.due_on-wp.starts_on)*i::numeric/n)::int end;
  insert into task(org_id,title,status,project_id,source,created_by,created_at,edited_by,updated_at,priority,position,due_at,locked)
  values(current_org(),s,'open',p_project,'pulse',current_viewer(),now(),current_viewer(),now(),'normal',i,
   case when due is not null then (due+time '18:00') at time zone 'Asia/Kolkata' end,'{title,status,owner_id,project_id,due_label}') returning id into tid;
  perform task_event_add(tid,'created',null,s,'From the '||(tpl->>'name')||' template');
 end loop;
 update work_project set template_key=p_key,updated_at=now() where org_id=current_org() and project_id=p_project;
 return n;
end $$;

-- People on a project: added directly inside your reach, invited (they accept) outside it --------------------------
create function pulse.work_member_add(p_project uuid,p_person uuid,p_role text default 'member') returns boolean
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare existing project_member;msg text;
begin
 select * into existing from project_member where org_id=current_org() and project_id=p_project and person_id=p_person and left_at is null for update;
 if found then
  if existing.role='watcher' and p_role='member' then update project_member set role='member' where id=existing.id;else return false;end if;
 elsif exists(select 1 from work_project where org_id=current_org() and project_id=p_project and owner_id=p_person) then return false;
 else insert into project_member(org_id,project_id,person_id,role,added_by) values(current_org(),p_project,p_person,p_role,current_viewer());
 end if;
 if p_role='member' then
  msg:=work_first_name(current_viewer())||' added you to '||(select coalesce(pr.title,pr.name) from project pr where pr.id=p_project);
  perform work_notify(p_person,'project.added','project',p_project,p_project||':added:'||p_person,msg,'/tasks/projects/'||p_project,'task');
 end if;
 return true;
end $$;
create function pulse.work_ask_create(p_kind text,p_task uuid,p_project uuid,p_to uuid,p_note text default null) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;target uuid;aid uuid;what text;msg text;href text;
begin
 if p_kind not in ('take','invite','join') then raise exception 'Choose take, invite or join' using errcode='22023';end if;
 if (p_task is null)=(p_project is null) then raise exception 'Choose a task or a project' using errcode='22023';end if;
 if p_task is not null then
  select * into t from task where org_id=current_org() and id=p_task;
  if not found or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
  what:='“'||left(t.title,90)||'”';href:='/tasks/'||p_task;
 else
  if not exists(select 1 from work_project where org_id=current_org() and project_id=p_project) then raise exception 'Project not found' using errcode='P0002';end if;
  what:='the project '||(select left(coalesce(pr.title,pr.name),90) from project pr where pr.id=p_project);href:='/tasks/projects/'||p_project;
 end if;
 if p_kind='join' then
  -- Asking to join goes to whoever owns the work.
  target:=case when p_task is not null then coalesce(t.assignee_person_id,t.owner_id,t.created_by) else (select owner_id from work_project where project_id=p_project) end;
  if target is null then raise exception 'Nobody owns this yet. Ask leadership to add you' using errcode='22023';end if;
  if target=me or (p_task is not null and work_task_person(p_task,me)) or (p_project is not null and work_project_person(p_project,me)) then
   raise exception 'You are already on this' using errcode='22023';end if;
  msg:=work_first_name(me)||' asks to join '||what;
 else
  target:=p_to;
  if target is null or not task_person_ok(target) then raise exception 'Choose an active team member' using errcode='22023';end if;
  if target=me then raise exception 'Choose someone other than yourself' using errcode='22023';end if;
  if not work_reaches(work_scope('task.ask'),target) then raise exception 'Your role can ask people in your pod. HR can change this in Settings, Who can do what' using errcode='42501';end if;
  if p_kind='take' then
   if t.status in ('done','accepted','cancelled','in_review') then raise exception 'This task is already finished' using errcode='22023';end if;
   if coalesce(t.assignee_person_id,t.owner_id)=target then raise exception 'They already have this task' using errcode='22023';end if;
   if not task_can_edit(p_task) then raise exception 'Only the people on this task, their pod head or leadership can ask someone to take it' using errcode='42501';end if;
   msg:=work_first_name(me)||' asks you to take '||what;
  elsif p_task is not null then
   if not task_can_edit(p_task) then raise exception 'Only the people on this task can invite others to it' using errcode='42501';end if;
   if work_task_person(p_task,target) then raise exception 'They are already on this task' using errcode='22023';end if;
   msg:=work_first_name(me)||' invites you to join '||what;
  else
   if not (work_project_can_manage(p_project) or work_project_person(p_project,me)) then raise exception 'Only people on this project can invite others to it' using errcode='42501';end if;
   if work_project_person(p_project,target) then raise exception 'They are already on this project' using errcode='22023';end if;
   msg:=work_first_name(me)||' invites you to join '||what;
  end if;
 end if;
 insert into work_ask(org_id,kind,task_id,project_id,from_id,to_id,note) values(current_org(),p_kind,p_task,p_project,me,target,nullif(btrim(coalesce(p_note,'')),''))
  on conflict (org_id,kind,coalesce(task_id,project_id),from_id,to_id) where status='pending' do nothing returning id into aid;
 if aid is null then raise exception 'You already asked. They have not answered yet' using errcode='23505';end if;
 if p_task is not null then perform task_event_add(p_task,'asked',null,(select display_name from person where id=target),p_kind);end if;
 perform work_notify(target,case when p_task is not null then 'task.ask' else 'project.ask' end,'work_ask',aid,aid::text,msg,href||'?ask='||aid,'task');
 return aid;
end $$;
create function pulse.work_ask_answer(p_id uuid,p_accept boolean,p_note text default null) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();a work_ask;t task;joiner uuid;what text;href text;
begin
 select * into a from work_ask where org_id=current_org() and id=p_id for update;
 if not found or a.to_id<>me then raise exception 'This request is not yours to answer' using errcode='42501';end if;
 if a.status<>'pending' then
  if a.status=(case when p_accept then 'accepted' else 'declined' end) then return jsonb_build_object('status',a.status);end if;
  raise exception 'This request was already %',a.status using errcode='22023';
 end if;
 what:=case when a.task_id is not null then '“'||left((select x.title from task x where x.id=a.task_id),90)||'”' else (select left(coalesce(pr.title,pr.name),90) from project pr where pr.id=a.project_id) end;
 href:=case when a.task_id is not null then '/tasks/'||a.task_id else '/tasks/projects/'||a.project_id end;
 if p_accept then
  if a.kind='take' then
   select * into t from task where org_id=current_org() and id=a.task_id for update;
   if t.status in ('done','accepted','cancelled','in_review') then raise exception 'This task is already finished' using errcode='22023';end if;
   -- Consent replaces the assignment rule: the person asked takes it, and the asker reviews it unless someone else does.
   update task set assignee_person_id=me,owner_id=me,assigned_at=now(),edited_by=me,updated_at=now(),
    review_owner_id=case when review_owner_id is null or review_owner_id=me then a.from_id else review_owner_id end,
    locked=array(select distinct unnest(locked||'{owner_id}'::text[])) where id=a.task_id;
   perform task_event_add(a.task_id,'assigned',(select display_name from person where id=coalesce(t.assignee_person_id,t.owner_id)),(select display_name from person where id=me),'Accepted an ask');
   update work_ask set status='withdrawn',decided_at=now() where org_id=current_org() and task_id=a.task_id and kind='take' and status='pending' and id<>a.id;
  else
   joiner:=case when a.kind='invite' then me else a.from_id end;
   if a.task_id is not null then
    update task_member set role='collaborator' where org_id=current_org() and task_id=a.task_id and person_id=joiner and removed_at is null;
    if not found and not work_task_person(a.task_id,joiner) then
     insert into task_member(org_id,task_id,person_id,role,added_by) values(current_org(),a.task_id,joiner,'collaborator',me);
    end if;
    perform task_event_add(a.task_id,'joined',null,(select display_name from person where id=joiner));
   else perform work_member_add(a.project_id,joiner,'member');
   end if;
  end if;
 end if;
 update work_ask set status=case when p_accept then 'accepted' else 'declined' end,decided_at=now(),answer_note=nullif(btrim(coalesce(p_note,'')),'') where id=a.id;
 perform work_notify(a.from_id,'ask.answered','work_ask',a.id,a.id||':answered',
  work_first_name(me)||case when p_accept then ' said yes: ' else ' said no: ' end||what||coalesce(' · '||nullif(btrim(coalesce(p_note,'')),''),''),href,'task');
 return jsonb_build_object('status',case when p_accept then 'accepted' else 'declined' end,'href',href);
end $$;
create function pulse.work_ask_withdraw(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();
begin
 update work_ask set status='withdrawn',decided_at=now() where org_id=current_org() and id=p_id and from_id=me and status='pending';
 if not found then raise exception 'Only a pending request you sent can be withdrawn' using errcode='22023';end if;
end $$;

-- Create a project, or set one up ---------------------------------------------------------------------------------
-- p: name, type (internal | fulfilment), clientProjectId (fulfilment), ownerId, memberIds, startsOn, dueOn, summary,
-- templateKey, pod. A client project already has its fulfilment row; "creating" a fulfilment sets that row up.
create function pulse.work_project_save(p_id uuid,p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();v_type text;pid uuid;wp work_project;v_name text;v_owner uuid;v_pod text;v_start date;v_due date;v_template text;
 m uuid;added int:=0;invited int:=0;steps int:=0;fresh boolean:=false;
begin
 if jsonb_typeof(p)<>'object' then raise exception 'Describe the project' using errcode='22023';end if;
 begin v_start:=nullif(p->>'startsOn','')::date;v_due:=nullif(p->>'dueOn','')::date;exception when others then raise exception 'Choose valid dates' using errcode='22023';end;
 if p_id is null then
  v_type:=coalesce(nullif(p->>'type',''),'internal');
  if v_type='fulfilment' then
   pid:=nullif(p->>'clientProjectId','')::uuid;
   if pid is null or not exists(select 1 from project where org_id=current_org() and id=pid and kind='client_work') then raise exception 'Choose the client project this fulfils' using errcode='22023';end if;
   insert into work_project(org_id,project_id,kind) values(current_org(),pid,'fulfilment') on conflict do nothing;
   select * into wp from work_project where org_id=current_org() and project_id=pid for update;
   if wp.set_up_at is not null then raise exception 'This client project already has its fulfilment project. Open it from the client project' using errcode='23505';end if;
   -- A pod head sets up an unclaimed fulfilment in their own pod.
   v_pod:=coalesce(wp.pod,nullif(p->>'pod',''),(select pod from people_profile where person_id=me));
   if not (work_can_create_project(v_pod) or work_project_can_manage(pid)) then raise exception 'Your role can set up projects in your own pod' using errcode='42501';end if;
  elsif v_type='internal' then
   v_name:=btrim(regexp_replace(coalesce(p->>'name',''),'\s+',' ','g'));
   if length(v_name) not between 2 and 200 then raise exception 'Name the project in 2 to 200 characters' using errcode='22023';end if;
   v_pod:=coalesce(nullif(p->>'pod',''),(select pod from people_profile where person_id=coalesce(nullif(p->>'ownerId','')::uuid,me)));
   if not work_can_create_project(v_pod) then raise exception 'Your role cannot create projects here. Leadership creates any project; pod heads create them in their pod' using errcode='42501';end if;
   perform pg_advisory_xact_lock(hashtext('project-registry:'||current_org()));
   insert into project(org_id,registry_no,name,title,kind,status,locked)
   values(current_org(),(select coalesce(max(registry_no),0)+1 from project where org_id=current_org()),v_name,v_name,'internal','active','{title,status}') returning id into pid;
   fresh:=true;
   select * into wp from work_project where org_id=current_org() and project_id=pid for update;
  else raise exception 'Choose Internal or Fulfilment' using errcode='22023';
  end if;
  update work_project set pod=v_pod,created_by=coalesce(created_by,me) where project_id=pid;
  wp.pod:=v_pod;
 else
  pid:=p_id;
  select * into wp from work_project where org_id=current_org() and project_id=pid for update;
  if not found then raise exception 'Project not found' using errcode='P0002';end if;
  if not work_project_can_manage(pid) then raise exception 'Only the project owner, the head of its pod or leadership can change it' using errcode='42501';end if;
  if p ? 'name' and wp.kind='internal' then
   v_name:=btrim(regexp_replace(coalesce(p->>'name',''),'\s+',' ','g'));
   if length(v_name) not between 2 and 200 then raise exception 'Name the project in 2 to 200 characters' using errcode='22023';end if;
   update project set title=v_name,locked=array(select distinct unnest(locked||'{title}'::text[])),updated_at=now() where id=pid;
  end if;
 end if;
 v_owner:=case when p ? 'ownerId' then nullif(p->>'ownerId','')::uuid when p_id is null then coalesce(wp.owner_id,me) else wp.owner_id end;
 if v_owner is distinct from wp.owner_id and v_owner is not null then
  if not task_person_ok(v_owner) then raise exception 'Choose an active team member as the owner' using errcode='22023';end if;
  if v_owner<>me and not (work_scope('project.create')='anyone' or work_reaches('pod',v_owner)) then raise exception 'Choose an owner from your pod' using errcode='42501';end if;
 end if;
 if v_start is null and not (p ? 'startsOn') then v_start:=wp.starts_on;end if;
 if v_due is null and not (p ? 'dueOn') then v_due:=wp.due_on;end if;
 if v_due<v_start then raise exception 'The due date comes after the start' using errcode='22023';end if;
 update work_project set owner_id=v_owner,starts_on=v_start,due_on=v_due,
  summary=case when p ? 'summary' then nullif(btrim(p->>'summary'),'') else summary end,
  status=case when p ? 'status' then p->>'status' else status end,
  set_up_at=coalesce(set_up_at,now()),updated_by=me,updated_at=now() where project_id=pid;
 if v_owner is distinct from wp.owner_id and v_owner is not null and v_owner<>me then
  perform work_notify(v_owner,'project.added','project',pid,pid||':owner:'||v_owner,work_first_name(me)||' made you the owner of '||(select coalesce(title,name) from project where id=pid),'/tasks/projects/'||pid,'task');
 end if;
 -- People inside your reach join at once and are told; anyone else gets an invitation to accept.
 for m in select distinct x::uuid from jsonb_array_elements_text(coalesce(p->'memberIds','[]')) x loop
  if m=v_owner or work_project_person(pid,m) then continue;end if;
  if not task_person_ok(m) then raise exception 'Choose active team members' using errcode='22023';end if;
  if work_reaches(work_scope('task.assign'),m) then if work_member_add(pid,m,'member') then added:=added+1;end if;
  else perform work_ask_create('invite',null,pid,m,null);invited:=invited+1;
  end if;
 end loop;
 v_template:=nullif(p->>'templateKey','');
 if v_template is not null then
  if wp.template_key is not null then raise exception 'This project already started from a template' using errcode='22023';end if;
  steps:=work_template_apply(pid,v_template);
 end if;
 perform audit_write(case when fresh then 'work_project_create' else 'work_project_save' end,'project',pid::text);
 return jsonb_build_object('id',pid,'added',added,'invited',invited,'steps',steps);
end $$;
create function pulse.work_project_people(p_project uuid,p_add uuid[],p_remove uuid[]) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();m uuid;added int:=0;invited int:=0;removed int:=0;
begin
 if not exists(select 1 from work_project where org_id=current_org() and project_id=p_project) then raise exception 'Project not found' using errcode='P0002';end if;
 if not (work_project_can_manage(p_project) or (cardinality(coalesce(p_remove,'{}'))=0 and work_project_person(p_project,me))) then
  raise exception 'Only the project owner, the head of its pod or leadership can change who is on it' using errcode='42501';end if;
 foreach m in array coalesce(p_add,'{}') loop
  if work_project_person(p_project,m) then continue;end if;
  if not task_person_ok(m) then raise exception 'Choose active team members' using errcode='22023';end if;
  if work_project_can_manage(p_project) and work_reaches(work_scope('task.assign'),m) then if work_member_add(p_project,m,'member') then added:=added+1;end if;
  else perform work_ask_create('invite',null,p_project,m,null);invited:=invited+1;
  end if;
 end loop;
 foreach m in array coalesce(p_remove,'{}') loop
  update project_member set left_at=now(),left_by=me where org_id=current_org() and project_id=p_project and person_id=m and left_at is null;
  if found then removed:=removed+1;end if;
 end loop;
 return jsonb_build_object('added',added,'invited',invited,'removed',removed);
end $$;
-- Follow (or stop following) a task or project. A project is followed by people who can already see its work.
create function pulse.work_watch(p_task uuid,p_project uuid,p_on boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();
begin
 if (p_task is null)=(p_project is null) then raise exception 'Choose a task or a project' using errcode='22023';end if;
 if p_task is not null then
  if not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
  if p_on then
   if not exists(select 1 from task_member where org_id=current_org() and task_id=p_task and person_id=me and removed_at is null) then
    insert into task_member(org_id,task_id,person_id,role,added_by) values(current_org(),p_task,me,'watcher',me);end if;
  else update task_member set removed_at=now(),removed_by=me where org_id=current_org() and task_id=p_task and person_id=me and removed_at is null;
  end if;
 else
  if not work_project_in(p_project) then raise exception 'Ask to join this project to follow it' using errcode='42501';end if;
  if p_on then
   if not exists(select 1 from project_member where org_id=current_org() and project_id=p_project and person_id=me and left_at is null) then
    insert into project_member(org_id,project_id,person_id,role,added_by) values(current_org(),p_project,me,'watcher',me);end if;
  else update project_member set left_at=now(),left_by=me where org_id=current_org() and project_id=p_project and person_id=me and left_at is null;
  end if;
 end if;
end $$;

-- Comments with @mentions. A mention lets the person see and follow the work, and tells them.
create function pulse.work_comment_add(p_task uuid,p_project uuid,p_body text,p_mentions uuid[] default '{}') returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();cid uuid;m uuid;what text;href text;v_body text:=btrim(coalesce(p_body,''));heard uuid[]:='{}';r record;snippet text;
begin
 if (p_task is null)=(p_project is null) then raise exception 'Choose a task or a project' using errcode='22023';end if;
 if length(v_body) not between 1 and 4000 then raise exception 'Write up to 4,000 characters' using errcode='22023';end if;
 if cardinality(coalesce(p_mentions,'{}'))>20 then raise exception 'Mention up to 20 people' using errcode='22023';end if;
 if p_task is not null then
  if not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
  what:='“'||left((select title from task where id=p_task),70)||'”';href:='/tasks/'||p_task;
 else
  if not work_project_in(p_project) then raise exception 'Join the project to comment on it' using errcode='42501';end if;
  what:=(select left(coalesce(title,name),70) from project where id=p_project);href:='/tasks/projects/'||p_project;
 end if;
 insert into work_comment(org_id,task_id,project_id,author_id,body,mentions)
 values(current_org(),p_task,p_project,me,v_body,array(select distinct x from unnest(coalesce(p_mentions,'{}')) x where x<>me)) returning id into cid;
 snippet:=left(regexp_replace(v_body,'\s+',' ','g'),70);
 foreach m in array (select mentions from work_comment where id=cid) loop
  if not task_person_ok(m) then raise exception 'Mention active team members' using errcode='22023';end if;
  if p_task is not null and not work_task_person(p_task,m) then insert into task_member(org_id,task_id,person_id,role,added_by) values(current_org(),p_task,m,'watcher',me);
  elsif p_project is not null and not exists(select 1 from project_member where org_id=current_org() and project_id=p_project and person_id=m and left_at is null)
   and not work_project_person(p_project,m) then insert into project_member(org_id,project_id,person_id,role,added_by) values(current_org(),p_project,m,'watcher',me);
  end if;
  perform work_notify(m,case when p_task is not null then 'task.mention' else 'project.mention' end,'comment',cid,cid::text,work_first_name(me)||' mentioned you on '||what||': '||snippet,href,'mention');
  heard:=heard||m;
 end loop;
 -- Everyone else on the work hears about the comment once.
 for r in select distinct x.p from (
  select unnest(array[t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by]) p from task t where p_task is not null and t.id=p_task
  union select person_id from task_member where p_task is not null and org_id=current_org() and task_id=p_task and removed_at is null
  union select owner_id from work_project where p_project is not null and org_id=current_org() and project_id=p_project
  union select person_id from project_member where p_project is not null and org_id=current_org() and project_id=p_project and left_at is null) x
  where x.p is not null and x.p<>me and not x.p=any(heard) loop
  perform work_notify(r.p,case when p_task is not null then 'task.comment' else 'project.comment' end,'comment',cid,cid::text,work_first_name(me)||' on '||what||': '||snippet,href,'task');
 end loop;
 return cid;
end $$;
create function pulse.work_comment_remove(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();
begin
 update work_comment set removed_at=now(),removed_by=me where org_id=current_org() and id=p_id and removed_at is null and (author_id=me or viewer_is('admin','leadership'));
 if not found then raise exception 'Only the author or leadership removes a comment' using errcode='42501';end if;
end $$;

-- The rule matrix: read by everyone, adjusted by HR and admins inside the limits -------------------------------------
create function pulse.work_rules() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('canEdit',coalesce(current_viewer() is not null and viewer_is('admin','hr'),false),'role',work_role(),
  'scopes',jsonb_build_object('task.assign',work_scope('task.assign'),'task.ask',work_scope('task.ask'),'project.create',work_scope('project.create')),
  'cells',(select jsonb_agg(jsonb_build_object('role',r,'action',a,'options',to_jsonb(work_rule_options(r,a)),'default',(work_rule_options(r,a))[1],
   'scope',coalesce(w.scope,(work_rule_options(r,a))[1]),'updatedAt',w.updated_at,'updatedBy',(select display_name from person where id=w.updated_by)) order by ri,ai)
   from unnest(array['hr','pod_head','member']) with ordinality ro(r,ri) cross join unnest(array['task.assign','task.ask','project.create']) with ordinality ac(a,ai)
   left join work_rule w on w.org_id=current_org() and w.role=r and w.action=a))
$$;
create function pulse.work_rule_set(p_role text,p_action text,p_scope text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not viewer_is('admin','hr') then raise exception 'Only HR and admins adjust who can do what' using errcode='42501';end if;
 if work_rule_options(p_role,p_action) is null then raise exception 'Choose a rule' using errcode='22023';end if;
 if not p_scope=any(work_rule_options(p_role,p_action)) then raise exception 'That is outside the safe limits for this role' using errcode='22023';end if;
 insert into work_rule(org_id,role,action,scope,updated_by) values(current_org(),p_role,p_action,p_scope,current_viewer())
 on conflict(org_id,role,action) do update set scope=excluded.scope,updated_by=excluded.updated_by,updated_at=now();
 perform audit_write('work_rule_set','work_rule',p_role||':'||p_action);
end $$;

-- Client projects: package details and the one-click review of what the migration could not place ------------------
create function pulse.client_project_value(p_project uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select case when current_viewer() is not null and viewer_is('admin','leadership') then
  (select jsonb_build_object('amount',v.amount,'currency',v.currency) from pulse_priv.client_project_value v where v.org_id=current_org() and v.project_id=p_project) end
$$;
create function pulse.client_project_save(p_id uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();pr project;v_start date;v_end date;
begin
 if me is null or not viewer_is('admin','leadership') then raise exception 'Leadership and admins edit client packages' using errcode='42501';end if;
 select * into pr from project where org_id=current_org() and id=p_id and kind='client_work' for update;
 if not found then raise exception 'Client project not found' using errcode='P0002';end if;
 begin v_start:=case when p ? 'startsOn' then nullif(p->>'startsOn','')::date else pr.starts_on end;v_end:=case when p ? 'endsOn' then nullif(p->>'endsOn','')::date else pr.ends_on end;
 exception when others then raise exception 'Choose valid dates' using errcode='22023';end;
 if v_end<v_start then raise exception 'The end date comes after the start' using errcode='22023';end if;
 update project set scope=case when p ? 'scope' then nullif(btrim(p->>'scope'),'') else scope end,starts_on=v_start,ends_on=v_end,
  status=case when p ? 'status' then p->>'status' else status end,updated_at=now(),
  locked=array(select distinct unnest(locked||case when p ? 'status' then '{status}'::text[] else '{}' end)) where id=p_id;
 if p ? 'valueAmount' then
  if nullif(p->>'valueAmount','') is null then update pulse_priv.client_project_value set amount=0,updated_by=me,updated_at=now() where project_id=p_id;
  else
   begin
    insert into pulse_priv.client_project_value(org_id,project_id,amount,currency,updated_by) values(current_org(),p_id,(p->>'valueAmount')::numeric,coalesce(nullif(p->>'valueCurrency',''),'INR'),me)
    on conflict(project_id) do update set amount=excluded.amount,currency=excluded.currency,updated_by=me,updated_at=now();
   exception when invalid_text_representation or check_violation or numeric_value_out_of_range then raise exception 'Enter the package value as a number' using errcode='22023';
   end;
  end if;
 end if;
 perform audit_write('client_project_save','project',p_id::text);
end $$;
create function pulse.work_review_decide(p_id uuid,p_decision text,p_client uuid default null) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();r work_review;pr project;
begin
 if me is null or not viewer_is('admin','leadership') then raise exception 'Leadership decides how a project is filed' using errcode='42501';end if;
 select * into r from work_review where org_id=current_org() and id=p_id for update;
 if not found then raise exception 'Nothing to decide' using errcode='P0002';end if;
 if r.status<>'pending' then raise exception 'Already decided' using errcode='22023';end if;
 select * into pr from project where id=r.project_id for update;
 if p_decision='client' then
  if p_client is not null then
   if not exists(select 1 from client where org_id=current_org() and id=p_client) then raise exception 'Choose a client' using errcode='22023';end if;
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'project',pr.id,'client_id',pr.client_id::text,p_client::text,me);
   update project set client_id=p_client,locked=array(select distinct unnest(locked||'{client_id}'::text[])),updated_at=now() where id=pr.id;
  end if;
  if pr.kind<>'client_work' then
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'project',pr.id,'kind',pr.kind,'client_work',me);
   update project set kind='client_work',locked=array(select distinct unnest(locked||'{kind}'::text[])),updated_at=now() where id=pr.id;
  end if;
 elsif p_decision='internal' then
  if pr.kind<>'internal' then
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'project',pr.id,'kind',pr.kind,'internal',me);
   update project set kind='internal',locked=array(select distinct unnest(locked||'{kind}'::text[])),updated_at=now() where id=pr.id;
  end if;
 else raise exception 'Choose client package or internal' using errcode='22023';
 end if;
 update work_review set status='decided',decision=p_decision,decided_by=me,decided_at=now() where id=r.id;
end $$;

-- The migration: every project gets its work project; what cannot be placed without a person goes to review ---------
-- Idempotent, for the current tenant; the import worker may run it again after a Drive refresh adds projects.
create function pulse.work_structure_backfill() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n_work int;n_owner int;n_review int;n_kind int;
begin
 if current_viewer() is not null and not viewer_is('admin') then raise exception 'Admins or the import worker file projects' using errcode='42501';end if;
 insert into work_project(org_id,project_id,kind,owner_id,pod,starts_on,status)
 select p.org_id,p.id,case when p.kind='internal' then 'internal' else 'fulfilment' end,p.lead_person_id,u.name,p.start_month,
  case when p.status='onboarding' then 'active' else p.status end
 from project p left join unit u on u.id=p.unit_id where p.org_id=current_org() on conflict do nothing;
 get diagnostics n_work=row_count;
 -- Internal projects without an owner: the person who created most of their tasks.
 update work_project wp set owner_id=x.who from (select t.project_id,(array_agg(t.created_by order by n desc,t.created_by))[1] who from (
  select project_id,created_by,count(*) n from task where org_id=current_org() and created_by is not null and project_id is not null group by 1,2) t group by 1) x
  where wp.org_id=current_org() and wp.project_id=x.project_id and wp.kind='internal' and wp.owner_id is null;
 get diagnostics n_owner=row_count;
 -- A client package with no client stays a package (that is how it was filed) and asks which client it is for.
 -- A client is suggested only when exactly one client's name is the project's title or the start of it.
 insert into work_review(org_id,project_id,reason,detail)
 select p.org_id,p.id,'no_client',jsonb_strip_nulls(jsonb_build_object('tasks',(select count(*) from task t where t.project_id=p.id),
  'suggestedClientId',s.id,'suggestedClient',s.name))
 from project p left join lateral (select min(c.id::text)::uuid id,min(c.display_name) name from client c where c.org_id=p.org_id and c.client_type<>'internal'
   and length(btrim(c.display_name))>=3 and (lower(btrim(coalesce(p.title,p.name)))=lower(btrim(c.display_name)) or starts_with(lower(btrim(coalesce(p.title,p.name))),lower(btrim(c.display_name))||' '))
   having count(*)=1) s on true
 where p.org_id=current_org() and p.kind='client_work' and p.client_id is null and p.status<>'cancelled' and not 'kind'=any(p.locked)
  and not exists(select 1 from record_merge rm where rm.org_id=p.org_id and rm.entity_type='project' and rm.gone_id=p.id and rm.undone_at is null)
 on conflict do nothing;
 get diagnostics n_review=row_count;
 -- A kind that disagrees with its client: internal work under a real client, or a package under the company itself.
 insert into work_review(org_id,project_id,reason,detail)
 select p.org_id,p.id,'client_kind',jsonb_build_object('kind',p.kind,'client',c.display_name,'clientType',c.client_type,'tasks',(select count(*) from task t where t.project_id=p.id))
 from project p join client c on c.id=p.client_id
 where p.org_id=current_org() and ((p.kind='internal' and c.client_type<>'internal') or (p.kind='client_work' and c.client_type='internal')) and p.status<>'cancelled' and not 'kind'=any(p.locked)
 on conflict do nothing;
 get diagnostics n_kind=row_count;
 return jsonb_build_object('workProjects',n_work,'owners',n_owner,'noClient',n_review,'kindMismatch',n_kind);
end $$;
do $$ declare o uuid;previous_org text:=current_setting('pulse.org_id',true);begin
 for o in select id from pulse.org loop
  perform set_config('pulse.org_id',o::text,true);
  perform pulse.work_structure_backfill();
 end loop;
 perform set_config('pulse.org_id',coalesce(previous_org,''),true);
end $$;
create trigger work_project_follow after insert or update of kind on pulse.project for each row execute function pulse.work_project_follow();

revoke all on function pulse.work_role(uuid),pulse.work_rule_options(text,text),pulse.work_scope(text,uuid),pulse.work_head_pods(),pulse.work_my_pods(),pulse.work_reaches(text,uuid),
 pulse.work_can_create_project(text),pulse.work_project_person(uuid,uuid),pulse.work_project_in(uuid),pulse.work_project_can_manage(uuid),pulse.work_task_person(uuid,uuid),
 pulse.work_notify(uuid,text,text,uuid,text,text,text,text),pulse.work_first_name(uuid),pulse.task_watch_notify(),pulse.work_project_follow(),pulse.work_templates(),
 pulse.work_template_apply(uuid,text),pulse.work_member_add(uuid,uuid,text),pulse.work_ask_create(text,uuid,uuid,uuid,text),pulse.work_ask_answer(uuid,boolean,text),
 pulse.work_ask_withdraw(uuid),pulse.work_project_save(uuid,jsonb),pulse.work_project_people(uuid,uuid[],uuid[]),pulse.work_watch(uuid,uuid,boolean),
 pulse.work_comment_add(uuid,uuid,text,uuid[]),pulse.work_comment_remove(uuid),pulse.work_rules(),pulse.work_rule_set(text,text,text),pulse.client_project_value(uuid),
 pulse.client_project_save(uuid,jsonb),pulse.work_review_decide(uuid,text,uuid),pulse.work_structure_backfill() from public;
grant execute on function pulse.work_role(uuid),pulse.work_rule_options(text,text),pulse.work_scope(text,uuid),pulse.work_head_pods(),pulse.work_my_pods(),pulse.work_reaches(text,uuid),
 pulse.work_can_create_project(text),pulse.work_project_person(uuid,uuid),pulse.work_project_in(uuid),pulse.work_project_can_manage(uuid),pulse.work_task_person(uuid,uuid),
 pulse.work_templates(),pulse.work_ask_create(text,uuid,uuid,uuid,text),pulse.work_ask_answer(uuid,boolean,text),pulse.work_ask_withdraw(uuid),
 pulse.work_project_save(uuid,jsonb),pulse.work_project_people(uuid,uuid[],uuid[]),pulse.work_watch(uuid,uuid,boolean),pulse.work_comment_add(uuid,uuid,text,uuid[]),
 pulse.work_comment_remove(uuid),pulse.work_rules(),pulse.work_rule_set(text,text,text),pulse.client_project_value(uuid),pulse.client_project_save(uuid,jsonb),
 pulse.work_review_decide(uuid,text,uuid),pulse.work_structure_backfill() to pulse_api;
grant execute on function pulse.work_role(uuid),pulse.work_scope(text,uuid),pulse.work_project_in(uuid),pulse.work_project_person(uuid,uuid),pulse.work_task_person(uuid,uuid),
 pulse.work_head_pods(),pulse.work_my_pods(),pulse.work_rule_options(text,text),pulse.work_templates(),pulse.work_structure_backfill() to pulse_worker;
-- migrate:down
-- Forward-only: work projects, members, asks, comments and rule changes are company records and are never dropped.
