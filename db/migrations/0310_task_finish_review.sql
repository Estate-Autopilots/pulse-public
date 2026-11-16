-- migrate:up
-- TASKS-4B (owner, 12 Oct 2026): a task's life, part 1: finishing and reviewing.
--  1. A task cannot move to Done while it has open subtasks (any path a person takes: the task page, the board, My tasks'
--     selection, the bell). Imports and the worker are not people and are not stopped. A finished task takes no new
--     subtasks: reopen it first, or add the work as a task of its own.
--  2. Work finished while subtasks were still open (before this rule, or a subtask reopened later) is marked for review
--     in pulse.task_flag. Nothing about the task itself changes: the reviewer sees a warning, the flag closes when every
--     subtask is closed (or the reviewer accepts knowingly).
--  3. How reviews work is each company's policy (work_settings, Settings → Who can do what): the reviewer by default is
--     whoever assigned the task; on acceptance the reviewer gives one quality rating (Great / Good / Needs work, or 1–5)
--     and may mark "above and beyond"; effort comes from captured time and size, impact from value and what the task
--     unlocked. Leadership's and founders' work is acknowledged with one tap (or accepted once proof is attached), never
--     graded. docs/ops/VALUE.md describes the defaults.
--  4. Reviews waiting longer than the policy's hours (24 by default) nudge the reviewer once a day.
--  5. Leadership changing Pip's suggested value is recorded (pulse.value_override) so the next suggestions learn from it.
--  6. "Finished with open subtasks" and "sent back" are signals in a person's record, read through one function.

-- 1. Settings ---------------------------------------------------------------------------------------------------------
alter table pulse.work_settings
 add column review_by text not null default 'assigner' check(review_by in ('assigner','head','creator')),
 add column review_scale text not null default 'three' check(review_scale in ('three','five')),
 add column review_leaders text not null default 'acknowledge' check(review_leaders in ('acknowledge','auto_proof','review')),
 add column above_bonus smallint not null default 25 check(above_bonus between 0 and 100),
 add column help_points smallint not null default 2 check(help_points between 0 and 10),
 add column review_nudge_hours smallint not null default 24 check(review_nudge_hours between 4 and 168);

create or replace function pulse.work_settings_get() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('businessModel',coalesce(s.business_model,'agency'),'aiAutoAcceptMax',s.ai_auto_accept_max,'teamLabel',coalesce(s.team_label,'Pod'),'updatedAt',s.updated_at,
  'updatedBy',(select display_name from person where id=s.updated_by),'canEdit',coalesce(current_viewer() is not null and viewer_is('admin','leadership'),false),
  'reviewBy',coalesce(s.review_by,'assigner'),'reviewScale',coalesce(s.review_scale,'three'),'reviewLeaders',coalesce(s.review_leaders,'acknowledge'),
  'aboveBonus',coalesce(s.above_bonus,25),'helpPoints',coalesce(s.help_points,2),'reviewNudgeHours',coalesce(s.review_nudge_hours,24))
 from (select 1) x left join work_settings s on s.org_id=current_org()
$$;
create or replace function pulse.work_settings_set(p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cur work_settings;v_model text;v_max int;v_team text;v_by text;v_scale text;v_leaders text;v_bonus int;v_help int;v_nudge int;
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
 begin
  v_bonus:=case when p ? 'aboveBonus' then (p->>'aboveBonus')::int else coalesce(cur.above_bonus,25) end;
  v_help:=case when p ? 'helpPoints' then (p->>'helpPoints')::int else coalesce(cur.help_points,2) end;
  v_nudge:=case when p ? 'reviewNudgeHours' then (p->>'reviewNudgeHours')::int else coalesce(cur.review_nudge_hours,24) end;
 exception when others then raise exception 'Enter whole numbers' using errcode='22023';end;
 if v_bonus not between 0 and 100 then raise exception 'The bonus for above and beyond is 0 to 100 percent' using errcode='22023';end if;
 if v_help not between 0 and 10 then raise exception 'Points for helping run from 0 to 10' using errcode='22023';end if;
 if v_nudge not between 4 and 168 then raise exception 'Nudge after 4 hours to 7 days' using errcode='22023';end if;
 insert into work_settings(org_id,business_model,ai_auto_accept_max,team_label,review_by,review_scale,review_leaders,above_bonus,help_points,review_nudge_hours,updated_by)
 values(current_org(),v_model,v_max,v_team,v_by,v_scale,v_leaders,v_bonus,v_help,v_nudge,current_viewer())
 on conflict(org_id) do update set business_model=excluded.business_model,ai_auto_accept_max=excluded.ai_auto_accept_max,team_label=excluded.team_label,review_by=excluded.review_by,review_scale=excluded.review_scale,
  review_leaders=excluded.review_leaders,above_bonus=excluded.above_bonus,help_points=excluded.help_points,review_nudge_hours=excluded.review_nudge_hours,
  updated_by=excluded.updated_by,updated_at=now();
 perform audit_write('work_settings_set','org',current_org()::text);
 return work_settings_get();
end $$;

-- Leadership and founders: admins and leadership roles, and the company's co-founders (HR's list).
create function pulse.task_is_leader(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_person is not null and (work_role(p_person)='leadership' or hr_is_cofounder(p_person))
$$;

-- 2. Task fields and events --------------------------------------------------------------------------------------------
alter table pulse.task
 add column review_kind text check(review_kind in ('rated','acknowledged','auto','legacy')),
 add column review_quality smallint check(review_quality between 1 and 5),
 add column review_above boolean not null default false,
 add column review_minutes int check(review_minutes>=0);
-- Acceptances before this round (review_kind null) were effort × impact ratings; reads treat them as legacy.

/** Add values to a "column = any(array[...])" check constraint, keeping whatever other migrations already allowed
 *  (several jobs add task events and notification types at the same time). Only migrations use it. */
create function pulse.check_values_add(p_table regclass,p_constraint text,p_column text,p_values text[]) returns void language plpgsql set search_path=pulse,pg_temp as $$
declare have text[];
begin
 -- Quoted values in the definition: ARRAY['a'::text, ...] (each quoted) or '{a,b}'::text[] (one literal).
 select array_agg(v) into have from pg_constraint c,regexp_matches(pg_get_constraintdef(c.oid),$r$'([^']+)'$r$,'g') m,
  unnest(case when m[1] like '{%}' then string_to_array(trim(both '{}' from m[1]),',') else array[m[1]] end) v where c.conrelid=p_table and c.conname=p_constraint;
 if have is null then raise exception 'constraint % not found',p_constraint;end if;
 execute format('alter table %s drop constraint %I',p_table,p_constraint);
 execute format('alter table %s add constraint %I check(%I = any(array[%s]::text[]))',p_table,p_constraint,p_column,
  (select string_agg(quote_literal(x),',' order by x) from (select distinct x from unnest(have||p_values) x) d));
end $$;
revoke all on function pulse.check_values_add(regclass,text,text,text[]) from public;
select pulse.check_values_add('pulse.task_event','task_event_kind_check','kind',array['flagged','acknowledged','estimated','timer','help','resolved']);

-- 3. Finishing: open subtasks block Done ------------------------------------------------------------------------------
create function pulse.task_open_children(p_task uuid) returns int language sql stable security definer set search_path=pulse,pg_temp as $$
 select count(*)::int from task c where c.org_id=current_org() and c.parent_id=p_task and c.deleted_at is null and c.status in ('open','in_progress','blocked','unknown')
$$;
-- The rule, on the row: every way a person finishes a task goes through it. Imports and the worker have no viewer.
create function pulse.task_finish_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 if current_viewer() is null then return new;end if;
 n:=task_open_children(new.id);
 if n>0 then
  raise exception 'Finish, move out or cancel % first',case when n=1 then 'its open subtask' else n||' open subtasks' end using errcode='23514',
   hint='Each open subtask has Finish, Move out and Cancel on the task page';
 end if;
 return new;
end $$;
create trigger task_finish_guard before update of status on pulse.task for each row
 when (new.status in ('done','in_review','accepted') and old.status not in ('done','in_review','accepted') and new.deleted_at is null)
 execute function pulse.task_finish_guard();

-- Work finished with open subtasks, kept for review. `cause`: finished (the parent was finished while they were open:
-- before the rule, or by the worker) or reopened (a subtask was reopened after its parent was finished).
create table pulse.task_flag (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 task_id uuid not null references pulse.task(id),person_id uuid references pulse.person(id),
 kind text not null check(kind in ('open_subtasks')),cause text not null check(cause in ('finished','reopened')),
 detail jsonb not null default '{}',raised_at timestamptz not null default now(),raised_by text not null default 'pulse' check(raised_by in ('migration','pulse')),
 resolved_at timestamptz,resolved_by uuid references pulse.person(id),resolution text check(length(resolution)<=500)
);
create unique index task_flag_open on pulse.task_flag(org_id,task_id,kind) where resolved_at is null;
create index task_flag_person on pulse.task_flag(org_id,person_id,raised_at);
alter table pulse.task_flag enable row level security;
alter table pulse.task_flag force row level security;
create policy tenant on pulse.task_flag using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy visible on pulse.task_flag as restrictive for select to pulse_api using(pulse.task_visible(task_id));
grant select on pulse.task_flag to pulse_api;
grant select,insert,update on pulse.task_flag to pulse_worker;
create trigger audit_mutation after insert or update on pulse.task_flag for each row execute function pulse.audit_mutation();

/** Keep a finished task's flag in step with its subtasks: raise it while open subtasks remain under finished work,
 *  close it when none remain. */
create function pulse.task_flag_check(p_task uuid,p_cause text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t task;open jsonb;
begin
 if p_task is null then return;end if;
 select * into t from task where id=p_task;
 if not found then return;end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'status',c.status) order by c.created_at),'[]') into open
  from task c where c.org_id=t.org_id and c.parent_id=t.id and c.deleted_at is null and c.status in ('open','in_progress','blocked','unknown');
 if t.deleted_at is null and t.status in ('done','in_review','accepted') and jsonb_array_length(open)>0 then
  insert into task_flag(org_id,task_id,person_id,kind,cause,detail) values(t.org_id,t.id,coalesce(t.assignee_person_id,t.owner_id),'open_subtasks',p_cause,jsonb_build_object('open',open))
  on conflict(org_id,task_id,kind) where resolved_at is null do update set detail=excluded.detail;
 else
  update task_flag set resolved_at=now(),resolved_by=current_viewer(),resolution=case when t.deleted_at is not null then 'The task was deleted'
   when t.status not in ('done','in_review','accepted') then 'The task was reopened' else 'Every subtask is closed now' end
  where org_id=t.org_id and task_id=t.id and kind='open_subtasks' and resolved_at is null;
 end if;
end $$;
create function pulse.task_flag_follow() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 -- A subtask changed: its parent (old and new) is checked; the task itself too when it was finished or reopened.
 if new.parent_id is not null then perform task_flag_check(new.parent_id,'reopened');end if;
 if old.parent_id is not null and old.parent_id is distinct from new.parent_id then perform task_flag_check(old.parent_id,'reopened');end if;
 if new.status is distinct from old.status or new.deleted_at is distinct from old.deleted_at then perform task_flag_check(new.id,'finished');end if;
 return null;
end $$;
create trigger task_flag_follow after update of status,parent_id,deleted_at on pulse.task for each row
 when (new.status is distinct from old.status or new.parent_id is distinct from old.parent_id or new.deleted_at is distinct from old.deleted_at)
 execute function pulse.task_flag_follow();

-- The reviewer has seen it (or accepts knowingly).
create function pulse.task_flag_resolve(p_task uuid,p_note text default null) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;n int;
begin
 select * into t from task where org_id=current_org() and id=p_task;
 if not found or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
 if not (me=t.review_owner_id or viewer_is('admin','leadership') or coalesce(manages(coalesce(t.assignee_person_id,t.owner_id)),false)) then
  raise exception 'The reviewer or leadership marks this as seen' using errcode='42501';end if;
 update task_flag set resolved_at=now(),resolved_by=me,resolution=coalesce(nullif(btrim(coalesce(p_note,'')),''),'Seen by the reviewer')
  where org_id=current_org() and task_id=p_task and resolved_at is null;
 get diagnostics n=row_count;
 if n>0 then perform task_event_add(p_task,'resolved',null,'open subtasks',nullif(btrim(coalesce(p_note,'')),''));end if;
 return n;
end $$;

-- Existing cases: finished work with subtasks still open is marked for review. Nothing about the tasks changes.
insert into pulse.task_flag(org_id,task_id,person_id,kind,cause,detail,raised_by)
select t.org_id,t.id,coalesce(t.assignee_person_id,t.owner_id),'open_subtasks','finished',
 jsonb_build_object('open',(select jsonb_agg(jsonb_build_object('id',c.id,'title',c.title,'status',c.status) order by c.created_at) from pulse.task c
  where c.org_id=t.org_id and c.parent_id=t.id and c.deleted_at is null and c.status in ('open','in_progress','blocked','unknown'))),'migration'
from pulse.task t where t.deleted_at is null and t.status in ('done','in_review','accepted')
 and exists(select 1 from pulse.task c where c.org_id=t.org_id and c.parent_id=t.id and c.deleted_at is null and c.status in ('open','in_progress','blocked','unknown'))
on conflict do nothing;

-- 4. Who reviews -------------------------------------------------------------------------------------------------------
/** The reviewer a task gets by the company's policy when nobody chose one: whoever assigned it (the default), the
 *  doer's head, or whoever created it. A reviewer someone chose stays. */
create function pulse.task_default_reviewer(t pulse.task,p_assignee uuid,p_me uuid,p_creating boolean) returns uuid language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare pol text:=coalesce((select review_by from work_settings where org_id=current_org()),'assigner');head uuid;
begin
 head:=case when p_assignee is not null then coalesce(hr_head(p_assignee),(select manager_id from people_profile where org_id=current_org() and person_id=p_assignee)) end;
 if p_creating then
  if pol='head' and head is not null and head<>p_assignee then return head;end if;
  return case when p_assignee is null or p_me<>p_assignee then p_me else head end;
 end if;
 if p_assignee is not distinct from t.assignee_person_id or 'review_owner_id'=any(coalesce(t.locked,'{}')) then return t.review_owner_id;end if;
 if pol='assigner' and p_assignee is not null and p_me<>p_assignee then return p_me;end if;
 if pol='head' and head is not null and head<>p_assignee then return head;end if;
 return t.review_owner_id;
end $$;

-- task_save: the default reviewer follows the policy, a chosen reviewer is kept, a finished task takes no subtasks.
do $$
declare d text;c text;
begin
 d:=pg_get_functiondef('pulse.task_save(uuid,jsonb)'::regprocedure);
 c:=replace(d,$x$ v_reviewer:=case when p ? 'reviewerId' then nullif(p->>'reviewerId','')::uuid when p_id is null then
  case when v_assignee is null or me<>v_assignee then me else coalesce(hr_head(v_assignee),(select manager_id from people_profile where person_id=v_assignee)) end else t.review_owner_id end;$x$,
 $x$ v_reviewer:=case when p ? 'reviewerId' then nullif(p->>'reviewerId','')::uuid else task_default_reviewer(t,v_assignee,me,p_id is null) end;$x$);
 if c=d then raise exception 'task_save changed shape (reviewer)';end if;
 d:=c;
 c:=replace(d,$x$ if p_id is null and v_parent is not null and v_project is null then select project_id into v_project from task where id=v_parent;end if;$x$,
 $x$ if p_id is null and v_parent is not null and v_project is null then select project_id into v_project from task where id=v_parent;end if;
 if v_parent is not null and v_parent is distinct from t.parent_id and coalesce(t.status,'open') not in ('done','in_review','accepted','cancelled')
  and exists(select 1 from task where id=v_parent and status in ('done','in_review','accepted','cancelled')) then
  raise exception 'That task is finished: reopen it first, or add this as a task of its own' using errcode='22023';end if;$x$);
 if c=d then raise exception 'task_save changed shape (parent)';end if;
 d:=c;
 c:=replace(d,$x$ if v_title is distinct from t.title then changed:=changed||'title'::text;end if;$x$,
 $x$ if v_title is distinct from t.title then changed:=changed||'title'::text;end if;
 if p ? 'reviewerId' then changed:=changed||'review_owner_id'::text;end if;$x$);
 if c=d then raise exception 'task_save changed shape (lock)';end if;
 execute c;
end $$;

-- 5. Reviewing ---------------------------------------------------------------------------------------------------------
/** Effort and impact are no longer typed in: effort from the time captured (else the estimate, else Pip's), impact from
 *  the value and whether finishing it unlocked other work. Both 1–5, so effort × impact stays meaningful for old views. */
create function pulse.task_derived_scores(p_task uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 with t as (select * from task where id=p_task),
 m as (select coalesce((select sum(e.minutes) from time_entry e where e.org_id=t.org_id and e.task_id=t.id and e.status='confirmed' and e.retired_at is null),0)::int logged,
   t.estimate_minutes est,(t.ai_suggestion->>'effortMinutes')::int pip,coalesce(t.value_points,(t.ai_suggestion->>'valuePoints')::int) val,
   exists(select 1 from task_link l where l.org_id=t.org_id and l.blocker_id=t.id) unlocks from t),
 x as (select logged,coalesce(nullif(logged,0),est,pip,60) mins,val,unlocks from m)
 select jsonb_build_object('minutes',logged,'effortMinutes',mins,'value',val,'unlocks',unlocks,
  'effort',case when mins<=30 then 1 when mins<=120 then 2 when mins<=480 then 3 when mins<=1440 then 4 else 5 end,
  'impact',least(5,case when coalesce(val,0)<=2 then 1 when val<=5 then 2 when val<=12 then 3 when val<=25 then 4 else 5 end+case when unlocks then 1 else 0 end)) from x
$$;

/** Who may accept: the reviewer; with no reviewer, leadership or the doer's manager. Nobody accepts their own work. */
create function pulse.task_review_check(t pulse.task,me uuid) returns void language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if me=coalesce(t.assignee_person_id,t.owner_id) then raise exception 'Someone else accepts your work' using errcode='42501';end if;
 if not (me=t.review_owner_id or (t.review_owner_id is null and (viewer_is('admin','leadership') or coalesce(manages(t.assignee_person_id),false)))
  or (task_is_leader(coalesce(t.assignee_person_id,t.owner_id)) and viewer_is('admin','leadership'))) then
  raise exception 'Only the reviewer accepts this task' using errcode='42501';end if;
 if t.status not in ('done','in_review') then raise exception 'Mark the task Done before accepting it' using errcode='22023';end if;
 if exists(select 1 from project where id=t.project_id and requires_proof) and not exists(select 1 from task_proof where task_id=t.id and removed_at is null) then
  raise exception 'This project needs proof before acceptance: attach a file or link' using errcode='22023';end if;
end $$;

/** Accept: a quality rating (great, good, needs_work or 1–5) and "above and beyond". Leadership's and founders' work is
 *  acknowledged instead, unless the company reviews it like everyone's. */
create function pulse.task_review(p_id uuid,p jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;q int;above boolean;sc jsonb;note text;pol text;pts int;
begin
 select * into t from task where org_id=current_org() and id=p_id and deleted_at is null for update;
 if not found or not task_visible(p_id) then raise exception 'Task not found' using errcode='P0002';end if;
 perform task_review_check(t,me);
 pol:=coalesce((select review_leaders from work_settings where org_id=current_org()),'acknowledge');
 if task_is_leader(coalesce(t.assignee_person_id,t.owner_id)) and pol<>'review' then
  raise exception 'Leadership''s and founders'' work is acknowledged, not rated' using errcode='22023';end if;
 q:=case lower(coalesce(p->>'quality','')) when 'great' then 5 when 'good' then 4 when 'needs_work' then 2 when '1' then 1 when '2' then 2 when '3' then 3 when '4' then 4 when '5' then 5 end;
 if q is null then raise exception 'Rate the work: Great, Good or Needs work' using errcode='22023';end if;
 above:=coalesce((p->>'above')::boolean,false);note:=nullif(btrim(coalesce(p->>'note','')),'');
 if length(note)>1000 then raise exception 'Keep the note under 1,000 characters' using errcode='22023';end if;
 sc:=task_derived_scores(p_id);
 update task set status='accepted',accepted_at=now(),accepted_by=me,effort=(sc->>'effort')::int,impact=(sc->>'impact')::int,review_kind='rated',review_quality=q,review_above=above,
  review_minutes=(sc->>'minutes')::int,value_note=coalesce(value_note,note),done_at=coalesce(done_at,now()),updated_at=now(),edited_by=me,
  locked=array(select distinct unnest(locked||'{status}'::text[])) where id=p_id;
 update task_flag set resolved_at=now(),resolved_by=me,resolution='Accepted with its subtasks still open' where org_id=current_org() and task_id=p_id and resolved_at is null;
 pts:=(select points from work_credit where org_id=current_org() and task_id=p_id and reversed_at is null and basis<>'help' limit 1);
 perform task_event_add(p_id,'accepted',t.status,'accepted',concat_ws(' · ',case q when 5 then 'Great' when 4 then 'Good' when 2 then 'Needs work' else q||' of 5' end,
  case when above then 'above and beyond' end,case when pts is not null then pts||' points' end,note));
 perform task_notify(coalesce(t.owner_id,t.assignee_person_id),'task.accepted',p_id,p_id||':accepted:'||now()::text,
  format('Accepted: %s%s',left(t.title,110),case when pts is not null then ' · '||pts||' points' else '' end));
 return jsonb_build_object('status','accepted','kind','rated','quality',q,'above',above,'points',pts,'effort',(sc->>'effort')::int,'impact',(sc->>'impact')::int);
end $$;

/** Accepting leadership's work without a grade: by a person (acknowledged) or by the policy (auto). Internal. */
create function pulse.task_ack_apply(p_id uuid,p_note text,p_auto boolean) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();t task;sc jsonb;pts int;
begin
 select * into t from task where org_id=current_org() and id=p_id and deleted_at is null for update;
 if not found then raise exception 'Task not found' using errcode='P0002';end if;
 sc:=task_derived_scores(p_id);
 update task set status='accepted',accepted_at=now(),accepted_by=case when p_auto then null else me end,effort=(sc->>'effort')::int,impact=(sc->>'impact')::int,
  review_kind=case when p_auto then 'auto' else 'acknowledged' end,review_minutes=(sc->>'minutes')::int,done_at=coalesce(done_at,now()),updated_at=now(),
  edited_by=coalesce(me,edited_by),locked=array(select distinct unnest(locked||'{status}'::text[])) where id=p_id;
 update task_flag set resolved_at=now(),resolved_by=me,resolution='Acknowledged with its subtasks still open' where org_id=current_org() and task_id=p_id and resolved_at is null;
 pts:=(select points from work_credit where org_id=current_org() and task_id=p_id and reversed_at is null and basis<>'help' limit 1);
 perform task_event_add(p_id,'acknowledged',t.status,'accepted',case when p_auto then 'Accepted automatically: proof attached' else nullif(btrim(coalesce(p_note,'')),'') end);
 perform task_notify(coalesce(t.owner_id,t.assignee_person_id),'task.accepted',p_id,p_id||':accepted:'||now()::text,
  format('%s: %s',case when p_auto then 'Accepted with its proof' else 'Acknowledged' end,left(t.title,120)));
 return jsonb_build_object('status','accepted','kind',case when p_auto then 'auto' else 'acknowledged' end,'points',pts);
end $$;
/** Leadership's and founders' finished work: one tap, no grade. The reviewer or anyone in leadership (not the doer). */
create function pulse.task_acknowledge(p_id uuid,p_note text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;
begin
 select * into t from task where org_id=current_org() and id=p_id and deleted_at is null;
 if not found or not task_visible(p_id) then raise exception 'Task not found' using errcode='P0002';end if;
 perform task_review_check(t,me);
 if not task_is_leader(coalesce(t.assignee_person_id,t.owner_id)) then raise exception 'Rate this work: acknowledging is for leadership''s and founders'' work' using errcode='22023';end if;
 return task_ack_apply(p_id,p_note,false);
end $$;

/** With the "accepted once proof is attached" policy, leadership's finished work with proof is accepted at once. */
create function pulse.task_auto_accept(p_id uuid) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t task;
begin
 select * into t from task where org_id=current_org() and id=p_id;
 if not found or t.status not in ('done','in_review') or t.deleted_at is not null then return false;end if;
 if coalesce((select review_leaders from work_settings where org_id=current_org()),'acknowledge')<>'auto_proof' then return false;end if;
 if not task_is_leader(coalesce(t.assignee_person_id,t.owner_id)) then return false;end if;
 if not exists(select 1 from task_proof where task_id=p_id and removed_at is null) then return false;end if;
 perform task_ack_apply(p_id,null,true);
 return true;
end $$;

-- The older accept (effort × impact typed in) stays for old clients; on leadership's work it acknowledges instead.
create or replace function pulse.task_accept(p_id uuid,p_effort int,p_impact int,p_note text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;r jsonb;
begin
 select * into t from task where org_id=current_org() and id=p_id and deleted_at is null for update;
 if not found or not task_visible(p_id) then raise exception 'Task not found' using errcode='P0002';end if;
 perform task_review_check(t,me);
 if task_is_leader(coalesce(t.assignee_person_id,t.owner_id)) and coalesce((select review_leaders from work_settings where org_id=current_org()),'acknowledge')<>'review' then
  r:=task_ack_apply(p_id,p_note,false);
  return r||jsonb_build_object('points',coalesce((r->>'points')::int,0));
 end if;
 if p_effort not between 1 and 5 or p_impact not between 1 and 5 then raise exception 'Rate effort and impact from 1 to 5' using errcode='22023';end if;
 update task set status='accepted',accepted_at=now(),accepted_by=me,effort=p_effort,impact=p_impact,review_kind='legacy',
  value_note=coalesce(nullif(btrim(coalesce(p_note,'')),''),value_note),done_at=coalesce(done_at,now()),updated_at=now(),edited_by=me,
  locked=array(select distinct unnest(locked||'{status}'::text[])) where id=p_id;
 update task_flag set resolved_at=now(),resolved_by=me,resolution='Accepted with its subtasks still open' where org_id=current_org() and task_id=p_id and resolved_at is null;
 perform task_event_add(p_id,'accepted',t.status,'accepted',format('%s points (effort %s × impact %s)',p_effort*p_impact,p_effort,p_impact));
 perform task_notify(coalesce(t.owner_id,t.assignee_person_id),'task.accepted',p_id,p_id||':accepted:'||now()::text,format('Accepted: %s · %s points',t.title,p_effort*p_impact));
 return jsonb_build_object('status','accepted','points',p_effort*p_impact);
end $$;

-- Credit: the value set before the work, else Pip's suggested value (value "by Pip's suggestion"), else effort × impact;
-- plus the policy's bonus for above and beyond. Helping credits (basis help) come with the discussion's help threads.
select pulse.check_values_add('pulse.work_credit','work_credit_basis_check','basis',array['pip','help']);
-- A task's own credit is one per task; help credits (one per helper and help thread) sit beside it.
alter table pulse.work_credit add column help_root uuid references pulse.work_comment(id);
drop index pulse.work_credit_live;
create unique index work_credit_live on pulse.work_credit(org_id,task_id) where reversed_at is null and basis<>'help';
create unique index work_credit_help on pulse.work_credit(org_id,help_root,person_id) where reversed_at is null and basis='help';
do $$
declare d text;c text;
begin
 d:=pg_get_functiondef('pulse.task_restore(uuid)'::regprocedure);
 c:=replace(d,$x$  insert into work_credit(org_id,task_id,person_id,points,basis,via,work_day) values(k.org_id,k.task_id,k.person_id,k.points,k.basis,k.via,k.work_day)
  on conflict(org_id,task_id) where reversed_at is null do nothing;$x$,$x$  insert into work_credit(org_id,task_id,person_id,points,basis,via,work_day,extra,domain_id,help_root) values(k.org_id,k.task_id,k.person_id,k.points,k.basis,k.via,k.work_day,k.extra,k.domain_id,k.help_root)
  on conflict do nothing;$x$);
 if c=d then raise exception 'task_restore changed shape';end if;
 execute c;
end $$;
create or replace function pulse.task_credit_follow() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who uuid:=coalesce(new.assignee_person_id,new.owner_id);pip int:=case when (new.ai_suggestion->>'valuePoints') ~ '^\d{1,3}$' then (new.ai_suggestion->>'valuePoints')::int end;
 base int:=least(100,coalesce(new.value_points,pip,new.effort*new.impact,0));pts int;k record;bonus int;
 v_basis text:=case when new.value_points is not null then 'value' when pip is not null then 'pip' else 'rating' end;
begin
 bonus:=coalesce((select above_bonus from work_settings where org_id=new.org_id),25);
 pts:=least(100,base+case when new.review_above and base>0 then greatest(1,round(base*bonus/100.0)::int) else 0 end);
 if new.status='accepted' and old.status is distinct from 'accepted' and who is not null then
  select * into k from work_credit_kind(new.id,who);
  insert into work_credit(org_id,task_id,person_id,points,basis,via,work_day,extra,domain_id)
  values(new.org_id,new.id,who,pts,v_basis,case when new.claimed_by=who then 'pool' else 'assigned' end,
   (coalesce(new.accepted_at,now()) at time zone pulse.org_time_zone(new.org_id))::date,coalesce(k.extra,'{}'),k.domain_id)
  on conflict(org_id,task_id) where reversed_at is null and basis<>'help' do update set points=excluded.points,basis=excluded.basis,person_id=excluded.person_id,via=excluded.via,extra=excluded.extra,domain_id=excluded.domain_id;
 elsif old.status='accepted' and new.status<>'accepted' then
  update work_credit set reversed_at=now() where org_id=new.org_id and task_id=new.id and reversed_at is null and basis<>'help';
 elsif new.status='accepted' then
  update work_credit set points=pts,basis=v_basis where org_id=new.org_id and task_id=new.id and reversed_at is null and basis<>'help' and points<>pts;
 end if;
 return null;
end $$;

-- Done with proof (or proof after Done) accepts leadership's work under the auto_proof policy.
do $$
declare d text;c text;
begin
 d:=pg_get_functiondef('pulse.task_move(uuid,text,text)'::regprocedure);
 c:=replace(d,$x$ if p_status='done' then perform task_notify(t.review_owner_id,'task.done',p_id,p_id||':done:'||now()::text,'Ready to accept: '||t.title);end if;$x$,
 $x$ if p_status='done' and not task_auto_accept(p_id) then perform task_notify(t.review_owner_id,'task.done',p_id,p_id||':done:'||now()::text,'Ready to accept: '||t.title);end if;$x$);
 if c=d then raise exception 'task_move changed shape';end if;
 execute c;
 d:=pg_get_functiondef('pulse.task_proof_add(uuid,text,text,bytea,text,text)'::regprocedure);
 c:=regexp_replace(d,'(\n\s*return pid;\s*\nend)',E'\n perform task_auto_accept(p_task);\\1');
 if c=d then raise exception 'task_proof_add changed shape';end if;
 execute c;
end $$;

-- 6. The review queue and its nudge ------------------------------------------------------------------------------------
/** Tasks waiting for this person's review: theirs as reviewer, and (for leadership and managers) finished work with no
 *  reviewer, and leadership's work any leader may acknowledge. */
create function pulse.task_review_queue(p_person uuid) returns setof uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 select t.id from task t where t.org_id=current_org() and t.deleted_at is null and t.status in ('done','in_review')
  and coalesce(t.assignee_person_id,t.owner_id) is distinct from p_person
  and (t.review_owner_id=p_person
   or (t.review_owner_id is null and (exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p_person and r.role_key in ('admin','leadership')
      and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) or exists(select 1 from people_profile pp where pp.org_id=current_org()
      and pp.person_id=coalesce(t.assignee_person_id,t.owner_id) and (pp.manager_id=p_person or hr_head(pp.person_id)=p_person)))))
$$;

select pulse.check_values_add('pulse.notification','notification_event_type_check','event_type',array['task.review_nudge']);
do $$
declare definition text;changed text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 changed:=replace(definition,' elsif p_type=''policy.published'' then',
 ' elsif p_type=''task.review_nudge'' then
  return p_subject=''person'' and p_id=p_person and exists(select 1 from task_review_queue(p_person));
 elsif p_type=''policy.published'' then');
 if changed=definition then raise exception 'notification_recipient_allowed changed shape';end if;
 execute changed;
end $$;

/** Once a day per reviewer, when something has waited longer than the policy's hours: "N tasks wait for your review". */
create function pulse.task_review_tick() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record;n int:=0;hrs int:=coalesce((select review_nudge_hours from work_settings where org_id=current_org()),24);
begin
 for r in select t.review_owner_id who,count(*)::int waiting,min(t.done_at) oldest from task t where t.org_id=current_org() and t.deleted_at is null and t.status in ('done','in_review')
  and t.review_owner_id is not null and t.review_owner_id is distinct from coalesce(t.assignee_person_id,t.owner_id) group by 1
  having min(t.done_at)<now()-make_interval(hours=>hrs) loop
  if notification_emit(r.who,'task.review_nudge','person',r.who,'review-nudge:'||r.who||':'||(now() at time zone org_time_zone())::date,
   case when r.waiting=1 then 'A finished task has waited ' else r.waiting||' finished tasks wait for your review; the oldest ' end
    ||case when now()-r.oldest<interval '2 days' then 'a day' else extract(day from now()-r.oldest)::int||' days' end,'/tasks?view=reviews','task') is not null then n:=n+1;end if;
 end loop;return n;
end $$;
-- The notification worker already runs the due-soon tick every minute; reviews ride along (its count stays due-soon only).
create or replace function pulse.task_due_tick() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t record;n int:=0;
begin
 for t in select id,title,coalesce(owner_id,assignee_person_id) who,due_at from task where org_id=current_org() and coalesce(owner_id,assignee_person_id) is not null
  and status in ('open','in_progress','blocked') and due_at between now() and now()+interval '24 hours' and source='pulse' and deleted_at is null loop
  if notification_emit(t.who,'task.due_soon','task',t.id,t.id||':due:'||t.due_at::text,'Due soon: '||left(t.title,120),'/tasks/'||t.id,'task') is not null then n:=n+1;end if;
 end loop;
 perform task_review_tick();
 return n;
end $$;

-- 7. Value overrides, learned from --------------------------------------------------------------------------------------
create table pulse.value_override (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 task_id uuid not null references pulse.task(id),category text,project_kind text,
 suggested smallint not null check(suggested between 1 and 100),chosen smallint not null check(chosen between 1 and 100),
 by_id uuid references pulse.person(id),source text not null,model text,version text,at timestamptz not null default now()
);
create index value_override_category on pulse.value_override(org_id,category,at);
alter table pulse.value_override enable row level security;
alter table pulse.value_override force row level security;
create policy tenant on pulse.value_override using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy leaders on pulse.value_override as restrictive for select to pulse_api using(pulse.viewer_is('admin','leadership','hr'));
grant select on pulse.value_override to pulse_api;
grant select,insert on pulse.value_override to pulse_worker;
do $$
declare d text;c text;
begin
 d:=pg_get_functiondef('pulse.task_value_set(uuid,jsonb)'::regprocedure);
 c:=replace(d,$x$ if v_points is distinct from t.value_points then
  perform task_event_add($x$,$x$ if v_points is distinct from t.value_points and v_points is not null and not coalesce((p->>'useSuggestion')::boolean,false)
  and (t.ai_suggestion->>'valuePoints') ~ '^\d+$' and (t.ai_suggestion->>'valuePoints')::int between 1 and 100 and v_points<>(t.ai_suggestion->>'valuePoints')::int then
  insert into value_override(org_id,task_id,category,project_kind,suggested,chosen,by_id,source,model,version)
  values(current_org(),p_task,t.category,(select kind from work_project where project_id=t.project_id),(t.ai_suggestion->>'valuePoints')::int,v_points,me,src,t.ai_suggestion->>'model',t.ai_suggestion->>'version');
 end if;
 if v_points is distinct from t.value_points then
  perform task_event_add($x$);
 if c=d then raise exception 'task_value_set changed shape';end if;
 execute c;
end $$;
/** What leadership's overrides teach Pip for a kind of work: how many, and the median of chosen ÷ suggested over the
 *  last 180 days (only leadership's own changes). Aggregates only; anyone's suggestion may use it. */
create function pulse.work_value_learning(p_category text) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('n',count(*),'ratio',percentile_cont(0.5) within group(order by chosen::numeric/suggested),'category',p_category)
 from value_override where org_id=current_org() and source='leadership' and at>now()-interval '180 days' and category is not distinct from p_category
$$;
/** The accepted value of a kind of work (median over the last 180 days) and how many: the category's baseline. */
create function pulse.work_category_baseline(p_category text) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('n',count(*),'value',percentile_cont(0.5) within group(order by k.points))
 from work_credit k join task t on t.id=k.task_id where k.org_id=current_org() and k.reversed_at is null and k.basis in ('value','pip','rating')
  and k.credited_at>now()-interval '180 days' and t.category is not distinct from p_category and p_category is not null
$$;

-- 8. Signals in a person's record (shown kindly): finished with open subtasks, sent back, on time ------------------------
create function pulse.person_task_signals(p_person uuid,p_days int default 90) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare since timestamptz:=now()-make_interval(days=>greatest(7,least(400,p_days)));out jsonb;
begin
 if current_viewer() is null or not (p_person=current_viewer() or viewer_is('admin','leadership','hr') or coalesce(manages(p_person),false)) then
  raise exception 'A person''s record is for them, their head, HR and leadership' using errcode='42501';end if;
 select jsonb_build_object('days',p_days,
  'finished',(select count(*)::int from task t where t.org_id=current_org() and coalesce(t.assignee_person_id,t.owner_id)=p_person and t.deleted_at is null and t.done_at>=since and t.status in ('done','in_review','accepted')),
  'onTime',(select count(*)::int from task t where t.org_id=current_org() and coalesce(t.assignee_person_id,t.owner_id)=p_person and t.deleted_at is null and t.done_at>=since and t.due_at is not null and t.done_at<=t.due_at),
  'late',(select count(*)::int from task t where t.org_id=current_org() and coalesce(t.assignee_person_id,t.owner_id)=p_person and t.deleted_at is null and t.done_at>=since and t.due_at is not null and t.done_at>t.due_at),
  'withDue',(select count(*)::int from task t where t.org_id=current_org() and coalesce(t.assignee_person_id,t.owner_id)=p_person and t.deleted_at is null and t.done_at>=since and t.due_at is not null),
  'openSubtasks',(select count(*)::int from task_flag f where f.org_id=current_org() and f.person_id=p_person and f.cause='finished' and f.raised_at>=since),
  'sentBack',(select count(*)::int from task_event e join task t on t.id=e.task_id where e.org_id=current_org() and e.kind='returned' and e.at>=since and coalesce(t.assignee_person_id,t.owner_id)=p_person),
  'quality',(select round(avg(review_quality)::numeric,1) from task t where t.org_id=current_org() and coalesce(t.assignee_person_id,t.owner_id)=p_person and t.review_kind='rated' and t.accepted_at>=since),
  'rated',(select count(*)::int from task t where t.org_id=current_org() and coalesce(t.assignee_person_id,t.owner_id)=p_person and t.review_kind='rated' and t.accepted_at>=since),
  'above',(select count(*)::int from task t where t.org_id=current_org() and coalesce(t.assignee_person_id,t.owner_id)=p_person and t.review_above and t.accepted_at>=since),
  'unlocked',(select count(distinct l.task_id)::int from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and coalesce(b.assignee_person_id,b.owner_id)=p_person
    and b.done_at>=since and b.status in ('done','in_review','accepted')),
  'blockersCleared',(select count(*)::int from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and coalesce(b.assignee_person_id,b.owner_id)=p_person
    and b.done_at>=since and b.status in ('done','in_review','accepted') and l.created_at<b.done_at),
  'value',(select coalesce(sum(k.points),0)::int from work_credit k where k.org_id=current_org() and k.person_id=p_person and k.reversed_at is null and k.credited_at>=since),
  'leader',task_is_leader(p_person)) into out;
 return out;
end $$;

revoke all on function pulse.task_is_leader(uuid),pulse.task_open_children(uuid),pulse.task_finish_guard(),pulse.task_flag_check(uuid,text),pulse.task_flag_follow(),
 pulse.task_flag_resolve(uuid,text),pulse.task_default_reviewer(pulse.task,uuid,uuid,boolean),pulse.task_derived_scores(uuid),pulse.task_review_check(pulse.task,uuid),
 pulse.task_review(uuid,jsonb),pulse.task_ack_apply(uuid,text,boolean),pulse.task_acknowledge(uuid,text),pulse.task_auto_accept(uuid),pulse.task_review_queue(uuid),pulse.task_review_tick(),
 pulse.work_value_learning(text),pulse.work_category_baseline(text),pulse.person_task_signals(uuid,int) from public;
grant execute on function pulse.task_is_leader(uuid),pulse.task_open_children(uuid),pulse.task_flag_resolve(uuid,text),pulse.task_derived_scores(uuid),pulse.task_review(uuid,jsonb),
 pulse.task_review_queue(uuid),pulse.work_value_learning(text),pulse.work_category_baseline(text),pulse.person_task_signals(uuid,int) to pulse_api;
grant execute on function pulse.task_acknowledge(uuid,text) to pulse_api;
grant execute on function pulse.task_review_tick(),pulse.task_review_queue(uuid) to pulse_worker;

-- migrate:down
-- Forward-only: flags, review fields and overrides are kept.
