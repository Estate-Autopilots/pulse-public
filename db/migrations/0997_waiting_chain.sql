-- migrate:up
-- EST-1746: one-company waiting reads. Existing task_block/task_unblock retain all write rules/notices.
create function pulse.task_actor(p_task uuid) returns uuid language sql stable set search_path=pulse,pg_temp as $$
 select coalesce(t.assignee_person_id,t.owner_id,p.lead_person_id,t.created_by)
 from task t left join project p on p.id=t.project_id and p.org_id=t.org_id
 where t.org_id=current_org() and t.id=p_task and t.deleted_at is null
$$;

create function pulse.task_chain(p_task uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare frontier uuid[]:=array[p_task]; seen uuid[]:=frontier; upcoming uuid[]; shown uuid[]:=frontier;
 steps jsonb:='[]'; total int:=0; depth int:=0; r record; root jsonb; company jsonb;
begin
 if not exists(select 1 from person where org_id=current_org() and id=current_viewer() and status='active')
  or not task_visible(p_task) then raise exception 'Task not found' using errcode='P0002'; end if;
 select jsonb_build_object('id',id,'title',title,'status',status) into root from task where org_id=current_org() and id=p_task;
 select jsonb_build_object('name',name,'address',null) into company from org where id=current_org();
 -- Visit each task once, including diamonds/legacy cycles; sort all edges at a level together.
 while cardinality(frontier)>0 loop
  depth:=depth+1; upcoming:='{}';
  for r in select l.id,l.task_id,l.blocker_id,l.created_at,b.title,b.status,task_visible(b.id) visible,
    a.id actor_id,a.display_name,a.side,ph.updated_at
   from task_link l join task b on b.id=l.blocker_id and b.org_id=l.org_id and b.deleted_at is null
   left join person a on a.id=task_actor(b.id) and a.org_id=l.org_id
   left join person_photo ph on ph.person_id=a.id and ph.org_id=l.org_id
   where l.org_id=current_org() and l.task_id=any(frontier) and l.cleared_at is null
   order by l.created_at,l.id loop
   total:=total+1;
   if total<=5 then
    shown:=shown||array[r.task_id,r.blocker_id];
    steps:=steps||jsonb_build_array(jsonb_build_object('linkId',r.id,'depth',depth,'fromId',r.task_id,
     'blocker',jsonb_build_object('id',r.blocker_id,'title',case when r.visible then r.title end,'hidden',not r.visible,'status',r.status),
     'actor',case when r.actor_id is not null then jsonb_build_object('id',r.actor_id,'name',r.display_name,'ai',r.side='agent','photoAt',r.updated_at) end,
     'company',company,'since',r.created_at,'answer',null,'answeredAt',null,'nudgedAt',null,'nextNudgeAt',null,
     'next',case when r.status in ('done','accepted','cancelled','in_review') then 'closed' else 'nudge' end));
   end if;
   if not r.blocker_id=any(seen) then upcoming:=upcoming||r.blocker_id; seen:=seen||r.blocker_id; end if;
  end loop;
  frontier:=upcoming;
 end loop;
 return jsonb_build_object('task',root,'steps',steps,'more',greatest(0,total-5),'declared',
  (select coalesce(jsonb_agg(jsonb_build_object('kind',b.blocker_key,'since',b.opened_at) order by b.opened_at,b.id),'[]')
   from blocker b where b.org_id=current_org() and b.task_id=any(shown) and b.closed_at is null
    and b.status in ('open','confirmed') and task_visible(b.task_id)));
end $$;

create function pulse.task_blocked_on(p_person uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from person where org_id=current_org() and id=current_viewer() and status='active')
  or not (coalesce(p_person=current_viewer(),false) or exists(
   select 1 from agent_member m join person a on a.id=m.person_id and a.org_id=m.org_id
   where m.org_id=current_org() and m.person_id=p_person and a.side='agent'
    and (m.owner_person_id=current_viewer() or viewer_is('admin','leadership'))))
 then raise exception 'You may only read your own waiting list or an AI employee you manage' using errcode='42501'; end if;
 return jsonb_build_object('rows',(select coalesce(jsonb_agg(x.row order by x.created_at,x.id),'[]') from (
  select l.id,l.created_at,jsonb_build_object('linkId',l.id,'since',l.created_at,'answer',null,
   'waiting',jsonb_build_object('id',w.id,'title',w.title,'status',w.status,
    'owner',case when a.id is not null then jsonb_build_object('id',a.id,'name',a.display_name,'ai',a.side='agent') end),
   'blocker',jsonb_build_object('id',b.id,'title',b.title)) row
  from task_link l join task b on b.id=l.blocker_id and b.org_id=l.org_id
  join task w on w.id=l.task_id and w.org_id=l.org_id
  left join person a on a.id=task_actor(w.id) and a.org_id=l.org_id
  where l.org_id=current_org() and l.cleared_at is null and b.deleted_at is null and w.deleted_at is null
   and b.status not in ('done','accepted','cancelled','in_review') and task_actor(b.id)=p_person
  order by l.created_at,l.id limit 50) x));
end $$;
revoke all on function pulse.task_actor(uuid),pulse.task_chain(uuid),pulse.task_blocked_on(uuid) from public;
grant execute on function pulse.task_actor(uuid),pulse.task_chain(uuid),pulse.task_blocked_on(uuid) to pulse_api;
-- migrate:down
-- Forward-only.
