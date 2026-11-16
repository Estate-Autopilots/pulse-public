-- migrate:up
-- UX-TASKS: when you create a task and ask someone to take it, you accept the work they hand back (0144 kept the
-- default reviewer, your pod head). Everything else about answering an ask is unchanged.
create or replace function pulse.work_ask_answer(p_id uuid,p_accept boolean,p_note text default null) returns jsonb
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
   -- Consent replaces the assignment rule: the person asked takes it. Whoever created the task and asked accepts the
   -- work; otherwise the reviewer stays, unless there is none (or it is the new owner): then the asker reviews.
   update task set assignee_person_id=me,owner_id=me,assigned_at=now(),edited_by=me,updated_at=now(),
    review_owner_id=case when created_by=a.from_id or review_owner_id is null or review_owner_id=me then a.from_id else review_owner_id end,
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
-- migrate:down
-- Forward-only.
