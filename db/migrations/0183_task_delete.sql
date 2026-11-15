-- migrate:up
-- TASKS-3 (owner, 11 Oct 2026: "delete unwanted tasks created by mistake, with a warning that shows what is connected").
--  * Whoever created a task, an admin or the owner of its project deletes it. Pulse first shows what is connected:
--    subtasks (deleted with it), tasks waiting on it (they stop waiting), what it waits on, chats that carry its card,
--    files and links, comments, and value already credited (taken back while it is deleted).
--  * It is a soft delete: the task (and the subtasks deleted with it) leave every list at once and can be restored for
--    30 days from Work → Recently deleted, by the same people or whoever deleted it. Nothing is erased; history stays.
--  * Every delete and restore is written to the audit log and the task's own history.

alter table pulse.task add column deleted_at timestamptz, add column deleted_by uuid references pulse.person(id),
 add column delete_note text check(length(delete_note)<=500), add column delete_batch uuid;
create index task_deleted on pulse.task(org_id,deleted_at) where deleted_at is not null;
alter table pulse.work_credit add column reversed_batch uuid;

-- Deleted tasks leave every view the API reads. (Functions the database owner runs still see them, so restoring and the
-- tracker import, which must not bring a deleted row back, keep working.)
create policy not_deleted on pulse.task as restrictive for select to pulse_api using(deleted_at is null);

alter table pulse.task_event drop constraint task_event_kind_check;
alter table pulse.task_event add constraint task_event_kind_check check(kind in ('created','edited','status','assigned','reviewer','blocked','unblocked','proof','accepted','returned',
 'moved','asked','joined','pooled','claimed','valued','handover','unlocked','step','same','merged','deleted','restored'));

-- A deleted task can no longer be edited, commented on or followed, and no longer blocks anyone.
create or replace function pulse.task_visible(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from task t where t.org_id=current_org() and t.id=p_id and t.deleted_at is null
  and task_visible_row(t.id,t.owner_id,t.assignee_person_id,t.review_owner_id,t.created_by,t.project_id,t.parent_id))
$$;
create or replace function pulse.task_open_blockers(p_task uuid) returns int language sql stable security definer set search_path=pulse,pg_temp as $$
 select count(*)::int from task_link l join task b on b.id=l.blocker_id where l.org_id=current_org() and l.task_id=p_task and l.cleared_at is null
 and b.status not in ('done','accepted','cancelled','in_review') and b.deleted_at is null
$$;
create or replace function pulse.task_due_tick() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t record;n int:=0;
begin
 for t in select id,title,coalesce(owner_id,assignee_person_id) who,due_at from task where org_id=current_org() and coalesce(owner_id,assignee_person_id) is not null
  and status in ('open','in_progress','blocked') and due_at between now() and now()+interval '24 hours' and source='pulse' and deleted_at is null loop
  if notification_emit(t.who,'task.due_soon','task',t.id,t.id||':due:'||t.due_at::text,'Due soon: '||left(t.title,120),'/tasks/'||t.id,'task') is not null then n:=n+1;end if;
 end loop;return n;
end $$;

-- Who may delete (and restore): whoever created it, an admin, or the owner of its project. Whoever deleted it may restore.
create function pulse.task_can_delete(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and exists(select 1 from task t where t.org_id=current_org() and t.id=p_id and (
  t.created_by=current_viewer() or viewer_is('admin')
  or exists(select 1 from work_project wp where wp.org_id=t.org_id and wp.project_id=t.project_id and wp.owner_id=current_viewer())
  or (t.deleted_at is not null and t.deleted_by=current_viewer())))
$$;

/** The task and every subtask under it (any depth). */
create function pulse.task_tree(p_id uuid) returns setof uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 with recursive down(id,depth) as (select p_id,0 union all select t.id,d.depth+1 from task t join down d on t.parent_id=d.id where t.org_id=current_org() and d.depth<20)
 select id from down
$$;

-- What is connected, before deleting: the dialog shows this, and the delete itself acts on the same facts.
create function pulse.task_delete_preview(p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare t task;ids uuid[];out jsonb;
begin
 perform task_require_viewer();
 select * into t from task where org_id=current_org() and id=p_id and deleted_at is null;
 if not found or not task_visible(p_id) then raise exception 'Task not found' using errcode='P0002';end if;
 ids:=array(select x from task_tree(p_id) x where exists(select 1 from task s where s.id=x and s.deleted_at is null));
 select jsonb_build_object(
  'id',t.id,'title',t.title,'canDelete',task_can_delete(p_id),
  'subtasks',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,'status',s.status) order by s.created_at),'[]') from task s where s.id=any(ids) and s.id<>p_id),
  'waiting',(select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'title',w.title,'person',wp.display_name) order by l.created_at),'[]') from task_link l join task w on w.id=l.task_id
   left join person wp on wp.id=coalesce(w.assignee_person_id,w.owner_id) where l.org_id=current_org() and l.blocker_id=any(ids) and l.cleared_at is null and not w.id=any(ids)
   and w.deleted_at is null and w.status in ('open','in_progress','blocked','unknown')),
  'waitsOn',(select count(*)::int from task_link l where l.org_id=current_org() and l.task_id=any(ids) and l.cleared_at is null),
  'chats',(select count(distinct m.channel_id)::int from chat_message m where m.org_id=current_org() and m.removed_at is null
   and exists(select 1 from jsonb_array_elements(m.attachments) a where a->>'task'=any(array(select x::text from unnest(ids) x))))
   +(select count(*)::int from chat_task_follow f where f.org_id=current_org() and f.task_id=any(ids)),
  'files',(select count(*)::int from task_proof p where p.org_id=current_org() and p.task_id=any(ids) and p.removed_at is null),
  'comments',(select count(*)::int from work_comment c where c.org_id=current_org() and c.task_id=any(ids) and c.removed_at is null),
  'people',(select count(*)::int from task_member m where m.org_id=current_org() and m.task_id=any(ids) and m.removed_at is null),
  'credits',(select coalesce(jsonb_agg(jsonb_build_object('points',k.points,'person',kp.display_name,'title',kt.title)),'[]') from work_credit k join person kp on kp.id=k.person_id
   join task kt on kt.id=k.task_id where k.org_id=current_org() and k.task_id=any(ids) and k.reversed_at is null),
  'asks',(select count(*)::int from work_ask a where a.org_id=current_org() and a.task_id=any(ids) and a.status='pending'),
  'time',(select coalesce(sum(e.minutes),0)::int from time_entry e where e.org_id=current_org() and e.task_id=any(ids) and e.retired_at is null and e.status='confirmed')) into out;
 return out;
end $$;

create function pulse.task_delete(p_id uuid,p_note text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;ids uuid[];batch uuid:=gen_random_uuid();x uuid;freed int:=0;taken int;
begin
 select * into t from task where org_id=current_org() and id=p_id and deleted_at is null for update;
 if not found or not task_visible(p_id) then raise exception 'Task not found' using errcode='P0002';end if;
 if not task_can_delete(p_id) then raise exception 'Whoever created the task, an admin or the project''s owner deletes it' using errcode='42501';end if;
 ids:=array(select y from task_tree(p_id) y where exists(select 1 from task s where s.id=y and s.deleted_at is null));
 update task set deleted_at=now(),deleted_by=me,delete_note=nullif(btrim(coalesce(p_note,'')),''),delete_batch=batch,updated_at=now() where id=any(ids);
 -- Value already credited is taken back while it is deleted (and given back on restore).
 update work_credit set reversed_at=now(),reversed_batch=batch where org_id=current_org() and task_id=any(ids) and reversed_at is null;
 get diagnostics taken=row_count;
 -- Requests about it are withdrawn; notices about it are put away; tasks waiting on it stop waiting.
 update work_ask set status='withdrawn',decided_at=now(),answer_note='The task was deleted' where org_id=current_org() and task_id=any(ids) and status='pending';
 update notification set dismissed_at=now() where org_id=current_org() and subject_type='task' and subject_id=any(ids) and dismissed_at is null;
 foreach x in array ids loop freed:=freed+task_release_waiting(x);end loop;
 foreach x in array ids loop perform task_event_add(x,'deleted',null,case when x=p_id then null else left(t.title,200) end,nullif(btrim(coalesce(p_note,'')),''));end loop;
 perform audit_write('delete','task',p_id::text);
 return jsonb_build_object('deleted',cardinality(ids),'batch',batch,'freed',freed,'creditsTaken',taken,'restoreUntil',(now()+interval '30 days'));
end $$;

create function pulse.task_restore(p_id uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;n int;k record;
begin
 select * into t from task where org_id=current_org() and id=p_id and deleted_at is not null for update;
 if not found then raise exception 'Nothing to restore' using errcode='P0002';end if;
 if not task_can_delete(p_id) then raise exception 'Whoever deleted it, created it, an admin or the project''s owner restores it' using errcode='42501';end if;
 if t.deleted_at<now()-interval '30 days' then raise exception 'Deleted more than 30 days ago: it can no longer be restored' using errcode='22023';end if;
 if t.parent_id is not null and exists(select 1 from task p where p.id=t.parent_id and p.deleted_at is not null and p.delete_batch is distinct from t.delete_batch) then
  raise exception 'Restore the task it sits under first' using errcode='22023';end if;
 update task set deleted_at=null,deleted_by=null,delete_note=null,delete_batch=null,updated_at=now() where org_id=current_org() and delete_batch=t.delete_batch;
 get diagnostics n=row_count;
 for k in select * from work_credit where org_id=current_org() and reversed_batch=t.delete_batch loop
  insert into work_credit(org_id,task_id,person_id,points,basis,via,work_day) values(k.org_id,k.task_id,k.person_id,k.points,k.basis,k.via,k.work_day)
  on conflict(org_id,task_id) where reversed_at is null do nothing;
 end loop;
 perform task_event_add(p_id,'restored',null,null);
 perform audit_write('restore','task',p_id::text);
 return jsonb_build_object('restored',n);
end $$;

-- Recently deleted: the last 30 days, for the people who may restore each.
create function pulse.task_deleted_list() returns table(id uuid,title text,deleted_at timestamptz,deleted_by uuid,deleted_by_name text,note text,project_name text,subtasks int,restore_until timestamptz)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select t.id,t.title,t.deleted_at,t.deleted_by,dp.display_name,t.delete_note,coalesce(pr.title,pr.name),
  (select count(*)::int from task s where s.org_id=t.org_id and s.delete_batch=t.delete_batch and s.id<>t.id),t.deleted_at+interval '30 days'
 from task t left join person dp on dp.id=t.deleted_by left join project pr on pr.id=t.project_id
 where t.org_id=current_org() and t.deleted_at>now()-interval '30 days' and current_viewer() is not null
  and not exists(select 1 from task p where p.id=t.parent_id and p.delete_batch=t.delete_batch)
  and (t.deleted_by=current_viewer() or t.created_by=current_viewer() or viewer_is('admin')
   or exists(select 1 from work_project wp where wp.org_id=t.org_id and wp.project_id=t.project_id and wp.owner_id=current_viewer()))
 order by t.deleted_at desc limit 200
$$;

revoke all on function pulse.task_can_delete(uuid),pulse.task_tree(uuid),pulse.task_delete_preview(uuid),pulse.task_delete(uuid,text),pulse.task_restore(uuid),pulse.task_deleted_list() from public;
grant execute on function pulse.task_can_delete(uuid),pulse.task_delete_preview(uuid),pulse.task_delete(uuid,text),pulse.task_restore(uuid),pulse.task_deleted_list() to pulse_api;

-- migrate:down
-- Forward-only.
