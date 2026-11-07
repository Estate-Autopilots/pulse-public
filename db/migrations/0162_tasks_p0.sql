-- migrate:up
-- TASKS-P0 (owner, 11 Oct 2026): a person understands their own tasks in five seconds.
--  * Numbered steps in a task's notes are a checklist the doer ticks (task_check, keyed by the step's words).
--  * "Plan it with Pip" is kept per task until its words change (task_plan); Pip never sends anything.
--  * Two open tasks of one person that read as the same work are suggested; people link them, dismiss the
--    suggestion or merge one into the other by hand (task_same, task_merge). Nothing is merged automatically.
--  * Projects have a category, a colour and an icon; the categories are the company's own (project_category,
--    defaults on first use: Client delivery, Internal, Admin & finance, Launch, HR).
--  * Unlocked is a moment: when a task is done, every task that waited only on it is unlocked (task.unlocked_at) and
--    its doer is told who finished what and what it is worth, through the existing notification path.

create table pulse.task_check (
 org_id uuid not null references pulse.org(id),task_id uuid not null references pulse.task(id) on delete cascade,
 step_key text not null check(step_key ~ '^s[0-9a-z]{1,8}$'),label text not null check(length(label) between 1 and 500),
 done_at timestamptz not null default now(),done_by uuid references pulse.person(id),
 primary key(org_id,task_id,step_key)
);
create table pulse.task_plan (
 org_id uuid not null references pulse.org(id),task_id uuid not null references pulse.task(id) on delete cascade,
 input_hash text not null check(input_hash ~ '^[0-9a-f]{16,64}$'),planner text not null check(length(planner) between 1 and 60),
 plan jsonb not null check(jsonb_typeof(plan)='object' and octet_length(plan::text)<=20000),
 created_at timestamptz not null default now(),created_by uuid references pulse.person(id),
 primary key(org_id,task_id)
);
create table pulse.task_same (
 org_id uuid not null references pulse.org(id),task_a uuid not null references pulse.task(id) on delete cascade,task_b uuid not null references pulse.task(id) on delete cascade,
 state text not null check(state in ('linked','dismissed','merged')),decided_by uuid references pulse.person(id),decided_at timestamptz not null default now(),
 primary key(org_id,task_a,task_b),check(task_a<task_b)
);
create table pulse.project_category (
 org_id uuid not null references pulse.org(id),key text not null check(key ~ '^[a-z][a-z0-9_]{1,39}$'),label text not null check(length(btrim(label)) between 2 and 60),
 icon text not null default 'folder' check(icon in ('folder','briefcase','rocket','wallet','users','clapperboard','code','megaphone','building','heart','sparkles','shield','wrench','calendar','graduation-cap','package')),
 color text not null default 'slate' check(color in ('slate','blue','teal','green','amber','orange','red','pink','violet','indigo')),
 sort int not null default 100,created_at timestamptz not null default now(),retired_at timestamptz,
 primary key(org_id,key)
);
alter table pulse.work_project add column project_category text check(project_category ~ '^[a-z][a-z0-9_]{1,39}$'),
 add column color text check(color in ('slate','blue','teal','green','amber','orange','red','pink','violet','indigo')),
 add column icon text check(icon in ('folder','briefcase','rocket','wallet','users','clapperboard','code','megaphone','building','heart','sparkles','shield','wrench','calendar','graduation-cap','package'));
alter table pulse.task add column unlocked_at timestamptz,add column unlocked_by uuid references pulse.task(id) on delete set null;

alter table pulse.task_event drop constraint task_event_kind_check;
alter table pulse.task_event add constraint task_event_kind_check check(kind in ('created','edited','status','assigned','reviewer','blocked','unblocked','proof','accepted','returned',
 'moved','asked','joined','pooled','claimed','valued','handover','unlocked','step','same','merged'));

do $$
declare t text;
begin
 foreach t in array array['task_check','task_plan','task_same','project_category'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select on pulse.%I to pulse_api',t);
  execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
 end loop;
end $$;
create policy visible on pulse.task_check as restrictive for select to pulse_api using(pulse.task_visible(task_id));
create policy visible on pulse.task_plan as restrictive for select to pulse_api using(pulse.task_visible(task_id));
create policy visible on pulse.task_same as restrictive for select to pulse_api using(pulse.task_visible(task_a) and pulse.task_visible(task_b));

-- ------------------------------------------------------------------------------------------------ the checklist
-- The doer, and anyone who may edit the task, ticks a step; unticking removes the tick.
create function pulse.task_check_set(p_task uuid,p_key text,p_label text,p_done boolean) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;
begin
 select * into t from task where org_id=current_org() and id=p_task;
 if not found or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
 if not (me=coalesce(t.assignee_person_id,t.owner_id) or task_can_edit(p_task)) then raise exception 'The person doing this task ticks its steps' using errcode='42501';end if;
 if coalesce(p_key,'') !~ '^s[0-9a-z]{1,8}$' or length(btrim(coalesce(p_label,''))) not between 1 and 500 then raise exception 'Choose a step of this task' using errcode='22023';end if;
 if p_done then
  insert into task_check(org_id,task_id,step_key,label,done_by) values(current_org(),p_task,p_key,btrim(p_label),me) on conflict (org_id,task_id,step_key) do nothing;
  if found then perform task_event_add(p_task,'step',null,left(btrim(p_label),200));end if;
 else delete from task_check where org_id=current_org() and task_id=p_task and step_key=p_key;
 end if;
 return jsonb_build_object('done',(select count(*) from task_check where org_id=current_org() and task_id=p_task));
end $$;

-- ------------------------------------------------------------------------------------------------ Pip's plan
create function pulse.task_plan_save(p_task uuid,p_hash text,p_planner text,p_plan jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();
begin
 if not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
 insert into task_plan(org_id,task_id,input_hash,planner,plan,created_by) values(current_org(),p_task,p_hash,p_planner,p_plan,me)
 on conflict (org_id,task_id) do update set input_hash=excluded.input_hash,planner=excluded.planner,plan=excluded.plan,created_at=now(),created_by=me;
end $$;

-- ------------------------------------------------------------------------------------------------ the same work
-- Link two tasks as the same work, or say they are not (the suggestion goes away). Either task's people decide.
create function pulse.task_same_set(p_one uuid,p_two uuid,p_state text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();a uuid:=least(p_one,p_two);b uuid:=greatest(p_one,p_two);
begin
 if p_one=p_two or p_state not in ('linked','dismissed') then raise exception 'Choose two different tasks' using errcode='22023';end if;
 if not (task_visible(a) and task_visible(b)) then raise exception 'Task not found' using errcode='P0002';end if;
 if not (task_can_edit(a) or task_can_edit(b) or exists(select 1 from task where id in (a,b) and me=coalesce(assignee_person_id,owner_id))) then
  raise exception 'The people on these tasks decide whether they are the same work' using errcode='42501';end if;
 insert into task_same(org_id,task_a,task_b,state,decided_by) values(current_org(),a,b,p_state,me)
 on conflict (org_id,task_a,task_b) do update set state=excluded.state,decided_by=me,decided_at=now() where task_same.state<>'merged';
 if p_state='linked' then
  perform task_event_add(a,'same',null,(select left(title,200) from task where id=b));
  perform task_event_add(b,'same',null,(select left(title,200) from task where id=a));
 end if;
end $$;
-- Merge by hand: what waits on (or blocks) the other task, its proof and its checklist move here; the other is
-- cancelled with a note that points here. Both must be editable by the viewer; accepted work is never merged away.
create function pulse.task_merge(p_keep uuid,p_gone uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();k task;g task;moved int:=0;n int;
begin
 if p_keep=p_gone then raise exception 'Choose two different tasks' using errcode='22023';end if;
 k:=task_for_edit(p_keep);g:=task_for_edit(p_gone);
 if g.status in ('accepted','cancelled') then raise exception 'Accepted or cancelled work is not merged' using errcode='22023';end if;
 -- Links: whatever waited on the other now waits on this one, and this one waits on what the other waited on.
 update task_link l set blocker_id=p_keep where l.org_id=current_org() and l.blocker_id=p_gone and l.cleared_at is null and l.task_id<>p_keep
  and not exists(select 1 from task_link x where x.org_id=l.org_id and x.task_id=l.task_id and x.blocker_id=p_keep and x.cleared_at is null);
 get diagnostics n=row_count;moved:=moved+n;
 update task_link l set task_id=p_keep where l.org_id=current_org() and l.task_id=p_gone and l.cleared_at is null and l.blocker_id<>p_keep
  and not exists(select 1 from task_link x where x.org_id=l.org_id and x.task_id=p_keep and x.blocker_id=l.blocker_id and x.cleared_at is null);
 get diagnostics n=row_count;moved:=moved+n;
 update task_link set cleared_at=now(),cleared_by=me where org_id=current_org() and cleared_at is null and (task_id=p_gone or blocker_id=p_gone);
 update task_proof set task_id=p_keep where org_id=current_org() and task_id=p_gone and removed_at is null;
 insert into task_check(org_id,task_id,step_key,label,done_at,done_by) select org_id,p_keep,step_key,label,done_at,done_by from task_check where org_id=current_org() and task_id=p_gone
  on conflict do nothing;
 update task set status='cancelled',updated_at=now(),edited_by=me,locked=array(select distinct unnest(locked||'{status}'::text[])) where id=p_gone;
 perform task_event_add(p_gone,'merged',g.status,'cancelled',left('Merged into: '||k.title,1000));
 perform task_event_add(p_keep,'merged',null,left(g.title,200));
 insert into task_same(org_id,task_a,task_b,state,decided_by) values(current_org(),least(p_keep,p_gone),greatest(p_keep,p_gone),'merged',me)
 on conflict (org_id,task_a,task_b) do update set state='merged',decided_by=me,decided_at=now();
 if task_open_blockers(p_keep)>0 and k.status in ('open','in_progress','unknown') then
  update task set status='blocked',updated_at=now() where id=p_keep;
 end if;
 return jsonb_build_object('kept',p_keep,'cancelled',p_gone,'links',moved);
end $$;

-- Protected documents on a task: whether the viewer may open each one, and (only then) whom it concerns. Runs as the
-- owner, so pulse_priv.hr_file's reader policy decides, exactly as task_proof_read does.
create function pulse.task_proof_protected(p_task uuid) returns table(proof_id uuid,readable boolean,person_name text) language sql stable security definer set search_path=pulse,pg_temp as $$
 select p.id,f.id is not null,pe.display_name from task_proof p left join pulse_priv.hr_file f on f.id=p.hr_file_id left join person pe on pe.id=f.person_id
 where p.org_id=current_org() and p.task_id=p_task and p.kind='document' and p.removed_at is null and task_visible(p_task)
$$;

-- ------------------------------------------------------------------------------------------------ project categories
create function pulse.project_category_ensure() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_org() is null or exists(select 1 from project_category where org_id=current_org()) then return;end if;
 insert into project_category(org_id,key,label,icon,color,sort) values
  (current_org(),'client','Client delivery','briefcase','blue',10),(current_org(),'internal','Internal','folder','slate',20),
  (current_org(),'admin_finance','Admin & finance','wallet','amber',30),(current_org(),'launch','Launch','rocket','violet',40),
  (current_org(),'hr','HR','users','teal',50)
 on conflict do nothing;
end $$;
-- Leadership and admins name the company's categories: a new label makes a new key; retired ones stay on old projects.
create function pulse.project_category_save(p jsonb) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();k text:=nullif(btrim(coalesce(p->>'key','')),'');l text:=btrim(coalesce(p->>'label',''));
begin
 if not viewer_is('admin','leadership') then raise exception 'Leadership and admins name the project categories' using errcode='42501';end if;
 perform project_category_ensure();
 if length(l) not between 2 and 60 then raise exception 'Name the category in 2 to 60 characters' using errcode='22023';end if;
 if k is null then
  k:=left(trim(both '_' from regexp_replace(lower(l),'[^a-z0-9]+','_','g')),40);
  if k !~ '^[a-z]' then k:='c_'||k;end if;
  if length(k)<2 then k:='category';end if;
  while exists(select 1 from project_category where org_id=current_org() and key=k and retired_at is null) loop k:=left(k,36)||'_'||(floor(random()*900)+100)::int;end loop;
 end if;
 insert into project_category(org_id,key,label,icon,color,sort) values(current_org(),k,l,coalesce(p->>'icon','folder'),coalesce(p->>'color','slate'),coalesce((p->>'sort')::int,100))
 on conflict (org_id,key) do update set label=excluded.label,icon=coalesce(p->>'icon',project_category.icon),color=coalesce(p->>'color',project_category.color),
  sort=coalesce((p->>'sort')::int,project_category.sort),retired_at=case when coalesce((p->>'retired')::boolean,false) then now() else null end;
 perform audit_write('project_category_save','project_category',k);
 return k;
end $$;
-- The project's owner, its pod head or leadership: category, colour and icon.
create function pulse.work_project_style(p_project uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform task_require_viewer();
 if not exists(select 1 from work_project where org_id=current_org() and project_id=p_project) then raise exception 'Project not found' using errcode='P0002';end if;
 if not work_project_can_manage(p_project) then raise exception 'Only the project owner, the head of its pod or leadership can change it' using errcode='42501';end if;
 perform project_category_ensure();
 if p ? 'category' and nullif(p->>'category','') is not null and not exists(select 1 from project_category where org_id=current_org() and key=p->>'category' and retired_at is null) then
  raise exception 'Choose one of the company''s project categories' using errcode='22023';end if;
 update work_project set project_category=case when p ? 'category' then nullif(p->>'category','') else project_category end,
  color=case when p ? 'color' then nullif(p->>'color','') else color end,icon=case when p ? 'icon' then nullif(p->>'icon','') else icon end,
  updated_by=current_viewer(),updated_at=now() where org_id=current_org() and project_id=p_project;
end $$;

-- ------------------------------------------------------------------------------------------------ unlocked
-- Replaces 0141's release: every open task that waited on this one and now waits on nothing is unlocked. A blocked
-- task returns to work as before; the doer hears who finished what and what the work is worth. A cancelled blocker
-- still frees blocked work with the old "Unblocked" note.
create or replace function pulse.task_release_waiting(p_blocker uuid) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare w record;n int:=0;b task;who text;worth text;finished boolean;
begin
 select * into b from task where org_id=current_org() and id=p_blocker;
 finished:=b.status in ('done','accepted','in_review');
 who:=coalesce(split_part((select display_name from person where id=current_viewer()),' ',1),'Someone');
 for w in select t.* from task t where t.org_id=current_org() and t.status in ('open','in_progress','blocked','unknown')
  and t.id in (select l.task_id from task_link l where l.org_id=current_org() and l.blocker_id=p_blocker and l.cleared_at is null) for update loop
  if task_open_blockers(w.id)=0 then
   if w.status='blocked' then
    update task set status=case when started_at is not null then 'in_progress' else 'open' end,updated_at=now() where id=w.id;
    perform task_event_add(w.id,'unblocked','blocked',case when w.started_at is not null then 'in_progress' else 'open' end);
   end if;
   if finished then
    update task set unlocked_at=now(),unlocked_by=p_blocker where id=w.id;
    perform task_event_add(w.id,'unlocked',null,left(b.title,200),format('%s finished it',who));
    worth:=case when coalesce(w.value_points,0)>0 then format(' · worth %s pts',w.value_points)
     when coalesce(w.effort*w.impact,0)>0 then format(' · worth %s pts',w.effort*w.impact) else '' end;
    perform task_notify(coalesce(w.owner_id,w.assignee_person_id),'task.unblocked',w.id,w.id||':unlocked:'||p_blocker,
     format('Unlocked: %s · %s finished %s%s',left(w.title,60),who,left(b.title,50),worth));
   elsif w.status='blocked' then
    perform task_notify(coalesce(w.owner_id,w.assignee_person_id),'task.unblocked',w.id,w.id||':unblocked:'||now()::text,'Unblocked: '||w.title);
   end if;
   n:=n+1;
  end if;
 end loop;return n;
end $$;

revoke all on function pulse.task_check_set(uuid,text,text,boolean),pulse.task_plan_save(uuid,text,text,jsonb),pulse.task_same_set(uuid,uuid,text),pulse.task_merge(uuid,uuid),
 pulse.task_proof_protected(uuid),pulse.project_category_ensure(),pulse.project_category_save(jsonb),pulse.work_project_style(uuid,jsonb) from public;
grant execute on function pulse.task_check_set(uuid,text,text,boolean),pulse.task_plan_save(uuid,text,text,jsonb),pulse.task_same_set(uuid,uuid,text),pulse.task_merge(uuid,uuid),
 pulse.task_proof_protected(uuid),pulse.project_category_ensure(),pulse.project_category_save(jsonb),pulse.work_project_style(uuid,jsonb) to pulse_api;
grant execute on function pulse.project_category_ensure() to pulse_worker;
-- migrate:down
-- Forward-only.
