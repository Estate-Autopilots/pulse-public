-- migrate:up
-- TASKS-4B (owner, 12 Oct 2026): deleting projects, easy and safe, like tasks (TASKS-3, 0183).
--  * An internal project is deleted by its owner, leadership or an admin, after seeing what is connected: its tasks and
--    subtasks (open and finished), tasks elsewhere that wait on them (they stop waiting), what they wait on, chats that
--    carry their cards, files, comments, people on it, value already credited (taken back while deleted), logged time,
--    open requests and the client packages it is placed under.
--  * It is a soft delete of the project and all its tasks in one batch: everything leaves every list at once and comes
--    back together for 30 days from Work → Recently deleted. Nothing is erased; history stays; every delete and restore
--    is audited.
--  * A client package's fulfilment is not deleted from Work: the package is closed from Clients.

alter table pulse.project add column deleted_at timestamptz,add column deleted_by uuid references pulse.person(id),
 add column delete_note text check(length(delete_note)<=500),add column delete_batch uuid;
alter table pulse.work_project add column deleted_at timestamptz;
create index project_deleted on pulse.project(org_id,deleted_at) where deleted_at is not null;
-- Deleted projects leave every view the API reads (database functions still see them, to restore).
create policy not_deleted on pulse.project as restrictive for select to pulse_api using(deleted_at is null);
create policy not_deleted on pulse.work_project as restrictive for select to pulse_api using(deleted_at is null);

/** Who deletes a project: an internal one's owner, leadership or an admin; whoever deleted it may restore it. */
create function pulse.project_can_delete(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and exists(select 1 from project p join work_project wp on wp.project_id=p.id where p.org_id=current_org() and p.id=p_id and wp.kind='internal'
  and (viewer_is('admin','leadership') or wp.owner_id=current_viewer() or (p.deleted_at is not null and p.deleted_by=current_viewer())))
$$;

/** The project's tasks (any depth: subtasks under them too), deleted or not as asked. */
create function pulse.project_task_ids(p_id uuid,p_deleted boolean) returns uuid[] language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(array_agg(distinct x),'{}') from task r,task_tree(r.id) x where r.org_id=current_org() and r.project_id=p_id
  and exists(select 1 from task s where s.id=x and (s.deleted_at is not null)=p_deleted)
$$;

create function pulse.project_delete_preview(p_id uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare p project;wp work_project;ids uuid[];out jsonb;
begin
 perform task_require_viewer();
 select * into p from project where org_id=current_org() and id=p_id and deleted_at is null;
 if not found or not work_project_in(p_id) and not viewer_is('admin','leadership','hr') then raise exception 'Project not found' using errcode='P0002';end if;
 select * into wp from work_project where project_id=p_id;
 ids:=project_task_ids(p_id,false);
 select jsonb_build_object('id',p.id,'name',coalesce(p.title,p.name),'kind',coalesce(wp.kind,'client'),'canDelete',project_can_delete(p_id),
  'tasks',jsonb_build_object('total',(select count(*)::int from task t where t.id=any(ids)),
    'open',(select count(*)::int from task t where t.id=any(ids) and t.status in ('open','in_progress','blocked','unknown')),
    'finished',(select count(*)::int from task t where t.id=any(ids) and t.status in ('done','in_review','accepted')),
    'cancelled',(select count(*)::int from task t where t.id=any(ids) and t.status='cancelled'),
    'sample',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'status',x.status)),'[]') from (select t.id,t.title,t.status from task t where t.id=any(ids)
      order by t.status in ('open','in_progress','blocked','unknown') desc,t.updated_at desc nulls last limit 6) x)),
  'waiting',(select coalesce(jsonb_agg(jsonb_build_object('id',w.id,'title',w.title,'person',wp2.display_name,'project',coalesce(wpr.title,wpr.name))),'[]') from task_link l join task w on w.id=l.task_id
   left join person wp2 on wp2.id=coalesce(w.assignee_person_id,w.owner_id) left join project wpr on wpr.id=w.project_id
   where l.org_id=current_org() and l.blocker_id=any(ids) and l.cleared_at is null and not w.id=any(ids) and w.deleted_at is null and w.status in ('open','in_progress','blocked','unknown')),
  'waitsOn',(select count(*)::int from task_link l where l.org_id=current_org() and l.task_id=any(ids) and l.cleared_at is null and not l.blocker_id=any(ids)),
  'chats',(select count(distinct m.channel_id)::int from chat_message m where m.org_id=current_org() and m.removed_at is null
   and exists(select 1 from jsonb_array_elements(m.attachments) a where a->>'task'=any(array(select x::text from unnest(ids) x)))),
  'files',(select count(*)::int from task_proof f where f.org_id=current_org() and f.task_id=any(ids) and f.removed_at is null),
  'comments',(select count(*)::int from work_comment c where c.org_id=current_org() and (c.task_id=any(ids) or c.project_id=p_id) and c.removed_at is null),
  'people',(select count(distinct x)::int from (select person_id x from project_member where org_id=current_org() and project_id=p_id and left_at is null
   union select coalesce(t.assignee_person_id,t.owner_id) from task t where t.id=any(ids)) y where x is not null),
  'credits',(select jsonb_build_object('points',coalesce(sum(k.points),0)::int,'people',count(distinct k.person_id)::int) from work_credit k where k.org_id=current_org() and k.task_id=any(ids) and k.reversed_at is null),
  'time',(select coalesce(sum(e.minutes),0)::int from time_entry e where e.org_id=current_org() and e.task_id=any(ids) and e.retired_at is null and e.status='confirmed'),
  'asks',(select count(*)::int from work_ask a where a.org_id=current_org() and (a.task_id=any(ids) or a.project_id=p_id) and a.status='pending'),
  'packages',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',coalesce(c.title,c.name))),'[]') from work_project_link l join project c on c.id=l.client_project_id
   where l.org_id=current_org() and l.project_id=p_id and l.status='linked')) into out;
 return out;
end $$;

create function pulse.project_delete(p_id uuid,p_note text default null) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();p project;ids uuid[];batch uuid:=gen_random_uuid();x uuid;freed int:=0;taken int;
begin
 select * into p from project where org_id=current_org() and id=p_id and deleted_at is null for update;
 if not found then raise exception 'Project not found' using errcode='P0002';end if;
 if not exists(select 1 from work_project where project_id=p_id and kind='internal') then
  raise exception 'A client package is closed from Clients; its fulfilment cannot be deleted from Work' using errcode='22023';end if;
 if not project_can_delete(p_id) then raise exception 'The project''s owner, leadership or an admin deletes it' using errcode='42501';end if;
 ids:=project_task_ids(p_id,false);
 update project set deleted_at=now(),deleted_by=me,delete_note=nullif(btrim(coalesce(p_note,'')),''),delete_batch=batch where id=p_id;
 update work_project set deleted_at=now() where project_id=p_id;
 update task set deleted_at=now(),deleted_by=me,delete_note=coalesce(nullif(btrim(coalesce(p_note,'')),''),'Deleted with its project'),delete_batch=batch,updated_at=now() where id=any(ids);
 update work_credit set reversed_at=now(),reversed_batch=batch where org_id=current_org() and task_id=any(ids) and reversed_at is null;
 get diagnostics taken=row_count;
 update work_ask set status='withdrawn',decided_at=now(),answer_note='The project was deleted' where org_id=current_org() and (task_id=any(ids) or project_id=p_id) and status='pending';
 update notification set dismissed_at=now() where org_id=current_org() and ((subject_type='task' and subject_id=any(ids)) or (subject_type='project' and subject_id=p_id)) and dismissed_at is null;
 foreach x in array ids loop freed:=freed+task_release_waiting(x);end loop;
 foreach x in array ids loop perform task_event_add(x,'deleted',null,null,'Deleted with its project');end loop;
 perform audit_write('delete','project',p_id::text);
 return jsonb_build_object('deleted',1,'tasks',cardinality(ids),'batch',batch,'freed',freed,'creditsTaken',taken,'restoreUntil',(now()+interval '30 days'));
end $$;

create function pulse.project_restore(p_id uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();p project;n int;k record;
begin
 select * into p from project where org_id=current_org() and id=p_id and deleted_at is not null for update;
 if not found then raise exception 'Nothing to restore' using errcode='P0002';end if;
 if not project_can_delete(p_id) then raise exception 'Whoever deleted it, the project''s owner, leadership or an admin restores it' using errcode='42501';end if;
 if p.deleted_at<now()-interval '30 days' then raise exception 'Deleted more than 30 days ago: it can no longer be restored' using errcode='22023';end if;
 update project set deleted_at=null,deleted_by=null,delete_note=null,delete_batch=null where id=p_id;
 update work_project set deleted_at=null where project_id=p_id;
 update task set deleted_at=null,deleted_by=null,delete_note=null,delete_batch=null,updated_at=now() where org_id=current_org() and delete_batch=p.delete_batch;
 get diagnostics n=row_count;
 for k in select * from work_credit where org_id=current_org() and reversed_batch=p.delete_batch loop
  insert into work_credit(org_id,task_id,person_id,points,basis,via,work_day,extra,domain_id,help_root) values(k.org_id,k.task_id,k.person_id,k.points,k.basis,k.via,k.work_day,k.extra,k.domain_id,k.help_root)
  on conflict do nothing;
 end loop;
 perform audit_write('restore','project',p_id::text);
 return jsonb_build_object('restored',1,'tasks',n);
end $$;

-- A task deleted with its project comes back with the project, not alone.
do $$
declare d text;c text;
begin
 d:=pg_get_functiondef('pulse.task_restore(uuid)'::regprocedure);
 c:=replace(d,$x$ if t.parent_id is not null and exists($x$,$x$ if exists(select 1 from project pr where pr.id=t.project_id and pr.deleted_at is not null and pr.delete_batch=t.delete_batch) then
  raise exception 'It was deleted with its project: restore the project' using errcode='22023';end if;
 if t.parent_id is not null and exists($x$);
 if c=d then raise exception 'task_restore changed shape';end if;
 execute c;
end $$;
create or replace function pulse.task_deleted_list() returns table(id uuid,title text,deleted_at timestamptz,deleted_by uuid,deleted_by_name text,note text,project_name text,subtasks int,restore_until timestamptz)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select t.id,t.title,t.deleted_at,t.deleted_by,dp.display_name,t.delete_note,coalesce(pr.title,pr.name),
  (select count(*)::int from task s where s.org_id=t.org_id and s.delete_batch=t.delete_batch and s.id<>t.id),t.deleted_at+interval '30 days'
 from task t left join person dp on dp.id=t.deleted_by left join project pr on pr.id=t.project_id
 where t.org_id=current_org() and t.deleted_at>now()-interval '30 days' and current_viewer() is not null
  and not exists(select 1 from task p where p.id=t.parent_id and p.delete_batch=t.delete_batch)
  and not exists(select 1 from project dpj where dpj.id=t.project_id and dpj.delete_batch=t.delete_batch)
  and (t.deleted_by=current_viewer() or t.created_by=current_viewer() or viewer_is('admin')
   or exists(select 1 from work_project wp where wp.org_id=t.org_id and wp.project_id=t.project_id and wp.owner_id=current_viewer()))
 order by t.deleted_at desc limit 200
$$;
/** Recently deleted projects, for whoever may restore each. */
create function pulse.project_deleted_list() returns table(id uuid,name text,deleted_at timestamptz,deleted_by_name text,note text,tasks int,restore_until timestamptz)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select p.id,coalesce(p.title,p.name),p.deleted_at,dp.display_name,p.delete_note,(select count(*)::int from task t where t.org_id=p.org_id and t.delete_batch=p.delete_batch),p.deleted_at+interval '30 days'
 from project p left join person dp on dp.id=p.deleted_by where p.org_id=current_org() and p.deleted_at>now()-interval '30 days' and project_can_delete(p.id)
 order by p.deleted_at desc limit 100
$$;

revoke all on function pulse.project_can_delete(uuid),pulse.project_task_ids(uuid,boolean),pulse.project_delete_preview(uuid),pulse.project_delete(uuid,text),pulse.project_restore(uuid),pulse.project_deleted_list() from public;
grant execute on function pulse.project_can_delete(uuid),pulse.project_delete_preview(uuid),pulse.project_delete(uuid,text),pulse.project_restore(uuid),pulse.project_deleted_list() to pulse_api;

-- migrate:down
-- Forward-only: deleted projects and tasks are kept and restorable.
