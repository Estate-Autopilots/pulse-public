-- migrate:up
-- TASKS-3 (owner, 11 Oct 2026: "I tried adding people, tagging things… nothing is working properly"). Root causes:
--  * The roster has twin records of one person (an import made a second "Bevit Velupenubo", "Hakinan Gugove"…).
--    "@Bevit" matched both with no way to type more, and pickers listed both, so work went to a record nobody signs
--    in with. work_people() is the active staff with one record per name: the one with a sign-in, then a role, then
--    the most work. Pickers, @-names and quick add read it; the twin keeps its history.
--  * A leader could only invite people onto a task, so nobody appeared until they accepted. work_task_people() adds
--    people the viewer may assign at once (they are told) and invites the rest, like project people.

create function pulse.work_people() returns table(id uuid) language sql stable security definer set search_path=pulse,pg_temp as $$
 select distinct on (lower(regexp_replace(btrim(p.display_name),'\s+',' ','g'))) p.id from person p
 where p.org_id=current_org() and p.side='staff' and p.status='active'
 order by lower(regexp_replace(btrim(p.display_name),'\s+',' ','g')),
  exists(select 1 from account a where a.org_id=p.org_id and a.holder_person_id=p.id) desc,
  exists(select 1 from login_credential l where l.org_id=p.org_id and l.person_id=p.id and l.status='active') desc,
  exists(select 1 from role_assignment r where r.org_id=p.org_id and r.person_id=p.id and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) desc,
  (select count(*) from task t where t.org_id=p.org_id and coalesce(t.assignee_person_id,t.owner_id)=p.id) desc,p.created_at,p.id
$$;

-- People on a task: collaborators work on it with the doer, watchers follow it. Whoever may edit the task adds the
-- people their role may assign (they are told at once); anyone else gets an invitation to accept. A watcher who is
-- added becomes a collaborator. Removing is for whoever may edit the task, or the person themselves.
create function pulse.work_task_people(p_task uuid,p_add uuid[],p_remove uuid[]) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();t task;m uuid;added int:=0;invited int:=0;removed int:=0;existing task_member;
begin
 select * into t from task where org_id=current_org() and id=p_task;
 if not found or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002';end if;
 if cardinality(coalesce(p_add,'{}'))>20 then raise exception 'Add up to 20 people at a time' using errcode='22023';end if;
 if not task_can_edit(p_task) and (cardinality(coalesce(p_add,'{}'))>0 or exists(select 1 from unnest(coalesce(p_remove,'{}')) x where x<>me)) then
  raise exception 'Only the people on this task, their pod head or leadership change who works on it' using errcode='42501';end if;
 foreach m in array coalesce(p_add,'{}') loop
  if m in (t.assignee_person_id,t.owner_id) then continue;end if;
  if not task_person_ok(m) then raise exception 'Choose active team members' using errcode='22023';end if;
  if task_can_give(m) or work_role()='leadership' or coalesce(manages(m),false) then
   select * into existing from task_member where org_id=current_org() and task_id=p_task and person_id=m and removed_at is null for update;
   if found and existing.role='collaborator' then continue;end if;
   if found then update task_member set role='collaborator',added_by=me,added_at=now() where id=existing.id;
   else insert into task_member(org_id,task_id,person_id,role,added_by) values(current_org(),p_task,m,'collaborator',me);end if;
   perform task_event_add(p_task,'joined',null,(select display_name from person where id=m));
   perform work_notify(m,'task.update','task',p_task,p_task||':added:'||m,work_first_name(me)||' added you to “'||left(t.title,90)||'”','/tasks/'||p_task,'task');
   added:=added+1;
  elsif not exists(select 1 from work_ask where org_id=current_org() and task_id=p_task and to_id=m and status='pending') then
   perform work_ask_create('invite',p_task,null,m,null);invited:=invited+1;
  end if;
 end loop;
 foreach m in array coalesce(p_remove,'{}') loop
  update task_member set removed_at=now(),removed_by=me where org_id=current_org() and task_id=p_task and person_id=m and removed_at is null;
  if found then removed:=removed+1;end if;
 end loop;
 if added+removed>0 then update task set updated_at=now() where id=p_task;end if;
 return jsonb_build_object('added',added,'invited',invited,'removed',removed);
end $$;

revoke all on function pulse.work_people(),pulse.work_task_people(uuid,uuid[],uuid[]) from public;
grant execute on function pulse.work_people(),pulse.work_task_people(uuid,uuid[],uuid[]) to pulse_api;
grant execute on function pulse.work_people() to pulse_worker;

-- migrate:down
-- Forward-only.
