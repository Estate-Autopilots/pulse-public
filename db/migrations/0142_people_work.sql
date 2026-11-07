-- migrate:up
-- PEOPLE-LIVE: who worked on what, from evidence. A link ties one person to a pod, project, task, delivery or document
-- that already exists in Pulse (or a Drive file by id), with its source, basis, confidence and a review group. It
-- extends the existing task/project/delivery tables rather than copying them, so RT1's task model keeps working:
-- accepting a task link sets the task's owner. Links never hold pay, mail bodies or activity tracking.
--
-- Only deterministic matches are accepted automatically (Workspace group → pod, an exact roster name on a task row →
-- task owner and project). Everything else is a suggestion until HR or leadership decides. Every decision, automatic
-- or not, writes a receipt with the state before it, an audit event, and can be undone from the receipt.
create table pulse.people_work_link (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 source_key text not null,                                  -- stable per source, reference, person and kind
 person_id uuid not null references pulse.person(id),
 kind text not null check(kind in ('pod','project','task','delivery','document')),
 project_id uuid references pulse.project(id), task_id uuid references pulse.task(id),
 file_id text check(length(file_id)<=200), pod text check(length(pod)<=40),
 title text not null check(length(title) between 1 and 300), role text check(length(role)<=80),
 period_from date, period_to date, hours numeric(7,2) check(hours>=0),
 source text not null check(source ~ '^[a-z_]{3,40}$'),
 confidence numeric(4,3) not null check(confidence between 0 and 1),
 basis text not null check(length(basis) between 1 and 400),
 evidence jsonb not null default '{}',                      -- references (sheet, tab, row, file, header ids), never source text
 group_key text not null check(length(group_key)<=200), group_label text not null check(length(group_label)<=200),
 status text not null default 'suggested' check(status in ('accepted','suggested','dismissed','undone')),
 auto_accepted boolean not null default false,
 decided_by uuid references pulse.person(id), decided_at timestamptz,
 seen_at timestamptz not null default now(), retired_at timestamptz,   -- a suggestion no source supports any more
 created_at timestamptz not null default now(), unique(org_id,source_key),
 check((kind='pod' and pod is not null) or (kind='project' and project_id is not null) or (kind='task' and task_id is not null)
  or (kind in ('delivery','document') and file_id is not null))
);
create index people_work_person on pulse.people_work_link(org_id,person_id,kind,status);
create index people_work_group on pulse.people_work_link(org_id,group_key,status);
create index people_work_task on pulse.people_work_link(org_id,task_id) where task_id is not null;
create index people_work_project on pulse.people_work_link(org_id,project_id) where project_id is not null;
create table pulse.people_work_receipt (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 link_id uuid not null references pulse.people_work_link(id),
 action text not null check(action in ('auto_accept','accept','dismiss','undo')),
 before_state jsonb not null, after_state jsonb not null, actor_id uuid references pulse.person(id),
 at timestamptz not null default now()
);
create index people_work_receipt_link on pulse.people_work_receipt(org_id,link_id,at desc);
do $$ declare t text; begin
 foreach t in array array['people_work_link','people_work_receipt'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select on pulse.%I to pulse_api',t);
  execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
 end loop;
end $$;
-- Work is visible to the person, their manager or pod lead and leadership (as delivery work is); HR also sees the links
-- because HR reviews them. Writes from the API go only through people_work_decide.
create policy visible on pulse.people_work_link as restrictive for select to pulse_api
 using(pulse.person_work_access(person_id) or pulse.viewer_is('hr'));
create policy visible on pulse.people_work_receipt as restrictive for select to pulse_api
 using(exists(select 1 from pulse.people_work_link l where l.id=link_id));

-- One decision on one link: the state before, the change, the receipt and the audit event. Internal; callers check
-- who may decide. A pod change follows the person record's rules (a pod set by hand is locked; automatic acceptance
-- never overrides a lock). A task gets its owner; accepting historical work notifies nobody.
create function pulse.people_work_apply(p_link uuid,p_action text,p_actor uuid,p_auto boolean) returns uuid
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare l people_work_link%rowtype; prof record; t record; before jsonb; after jsonb; previous jsonb; next_status text;
 receipt uuid; viewer text; owner uuid;
begin
 select * into l from people_work_link where org_id=current_org() and id=p_link for update;
 if not found then raise exception 'This suggestion is no longer available' using errcode='P0002';end if;
 if p_action not in ('accept','dismiss','undo') then raise exception 'Choose accept, dismiss or undo' using errcode='22023';end if;
 if (p_action='accept' and l.status not in ('suggested','dismissed','undone')) or (p_action='dismiss' and l.status<>'suggested')
  or (p_action='undo' and l.status not in ('accepted','dismissed')) then
  raise exception 'This suggestion was already decided; refresh the page' using errcode='40001';
 end if;
 if p_auto and (p_action<>'accept' or l.status<>'suggested') then raise exception 'Automatic decisions only accept new links' using errcode='22023';end if;
 before:=jsonb_build_object('status',l.status);
 if l.kind='pod' then
  select pod,locked,field_sources into prof from people_profile where org_id=current_org() and person_id=l.person_id for update;
  if not found then raise exception 'This person has no staff record' using errcode='P0002';end if;
  before:=before||jsonb_build_object('pod',prof.pod,'locked',to_jsonb(prof.locked),'fieldSources',coalesce(prof.field_sources,'{}'::jsonb));
  if p_action='accept' then
   if not exists(select 1 from unit where org_id=current_org() and kind='pod' and name=l.pod and valid_to is null) then
    raise exception 'The pod % is not in use' ,l.pod using errcode='22023';end if;
   if p_auto and 'pod'=any(prof.locked) and prof.pod is distinct from l.pod then
    raise exception 'A pod set by hand is never changed automatically' using errcode='40001';end if;
   update people_profile set pod=l.pod,updated_at=now(),
    locked=case when p_auto then locked else array(select distinct unnest(locked||'pod'::text)) end,
    field_sources=coalesce(field_sources,'{}'::jsonb)||jsonb_build_object('pod',jsonb_build_object('source',l.group_label,'detail',l.basis))
    where org_id=current_org() and person_id=l.person_id;
   if prof.pod is distinct from l.pod then
    insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'person',l.person_id,'pod',prof.pod,l.pod,p_actor);
   end if;
  elsif p_action='undo' and l.status='accepted' then
   select r.before_state into previous from people_work_receipt r where r.org_id=current_org() and r.link_id=l.id and r.action in ('accept','auto_accept') order by r.at desc limit 1;
   if previous is null or prof.pod is distinct from l.pod then raise exception 'The pod changed after this decision; edit the record instead' using errcode='40001';end if;
   update people_profile set pod=previous->>'pod',updated_at=now(),locked=array(select jsonb_array_elements_text(coalesce(previous->'locked','[]'::jsonb))),
    field_sources=coalesce(previous->'fieldSources','{}'::jsonb) where org_id=current_org() and person_id=l.person_id;
   insert into record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(current_org(),'person',l.person_id,'pod',l.pod,previous->>'pod',p_actor);
  end if;
 elsif l.kind='task' then
  select owner_id,assignee_person_id,locked into t from task where org_id=current_org() and id=l.task_id for update;
  if not found then raise exception 'This task is no longer available' using errcode='P0002';end if;
  before:=before||jsonb_build_object('ownerId',t.owner_id,'assigneeId',t.assignee_person_id,'locked',to_jsonb(t.locked));
  owner:=coalesce(t.owner_id,t.assignee_person_id);
  -- The update runs without a viewer: an old task given its owner is a record, not an assignment to notify about.
  viewer:=current_setting('pulse.viewer_id',true);
  if p_action='accept' then
   if owner is not null and owner<>l.person_id then raise exception 'This task already has an owner' using errcode='40001';end if;
   perform set_config('pulse.viewer_id','',true);
   update task set owner_id=l.person_id,assignee_person_id=coalesce(assignee_person_id,l.person_id),updated_at=now(),
    locked=case when p_auto then locked else array(select distinct unnest(locked||'owner_id'::text)) end
    where org_id=current_org() and id=l.task_id;
   perform set_config('pulse.viewer_id',coalesce(viewer,''),true);
   if (select owner_id from task where org_id=current_org() and id=l.task_id) is distinct from l.person_id then
    raise exception 'The task owner was set by hand; open the task to change it' using errcode='40001';end if;
   if owner is null then
    insert into task_event(org_id,task_id,actor_id,kind,from_value,to_value,note)
    values(current_org(),l.task_id,p_actor,'assigned',null,l.person_id::text,left('From evidence: '||l.basis,1000));
   end if;
  elsif p_action='undo' and l.status='accepted' then
   select r.before_state into previous from people_work_receipt r where r.org_id=current_org() and r.link_id=l.id and r.action in ('accept','auto_accept') order by r.at desc limit 1;
   if previous is null or t.owner_id is distinct from l.person_id then raise exception 'The task owner changed after this decision; open the task instead' using errcode='40001';end if;
   -- With the viewer kept: the sync rule that protects a hand-set owner only applies to imports, and restoring an
   -- empty owner notifies nobody.
   update task set owner_id=(previous->>'ownerId')::uuid,assignee_person_id=(previous->>'assigneeId')::uuid,updated_at=now(),
    locked=array(select jsonb_array_elements_text(coalesce(previous->'locked','[]'::jsonb))) where org_id=current_org() and id=l.task_id;
   if (select owner_id from task where org_id=current_org() and id=l.task_id) is distinct from (previous->>'ownerId')::uuid then
    raise exception 'The task owner could not be restored; open the task instead' using errcode='40001';end if;
   insert into task_event(org_id,task_id,actor_id,kind,from_value,to_value,note)
   values(current_org(),l.task_id,p_actor,'assigned',l.person_id::text,previous->>'ownerId','Undone from the people-work receipt');
  end if;
 end if;
 next_status:=case p_action when 'accept' then 'accepted' when 'dismiss' then 'dismissed' else case when l.status='dismissed' then 'suggested' else 'undone' end end;
 update people_work_link set status=next_status,auto_accepted=(p_action='accept' and p_auto),decided_by=p_actor,decided_at=now(),
  retired_at=case when next_status='suggested' then null else retired_at end where org_id=current_org() and id=l.id;
 after:=jsonb_build_object('status',next_status);
 if l.kind='pod' then after:=after||jsonb_build_object('pod',(select pod from people_profile where org_id=current_org() and person_id=l.person_id));
 elsif l.kind='task' then after:=after||jsonb_build_object('ownerId',(select owner_id from task where org_id=current_org() and id=l.task_id));end if;
 insert into people_work_receipt(org_id,link_id,action,before_state,after_state,actor_id)
 values(current_org(),l.id,case when p_auto then 'auto_accept' else p_action end,before,after,p_actor) returning id into receipt;
 perform audit_write(case when p_auto then 'auto_accept' else p_action end,'people_work_link',l.id::text,array[l.kind,l.source]);
 return receipt;
end $$;

-- HR and leadership decide suggestions one by one, by selection (up to 600) or a whole review group in one click.
create function pulse.people_work_decide(p_ids uuid[],p_action text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k uuid; receipts uuid[]:='{}';
begin
 if current_viewer() is null or not viewer_is('hr','admin','leadership') then
  raise exception 'HR or leadership decides work suggestions' using errcode='42501';end if;
 if p_ids is null or cardinality(p_ids) not between 1 and 600 then raise exception 'Choose up to 600 links' using errcode='22023';end if;
 if cardinality(p_ids)<>(select count(distinct x) from unnest(p_ids) x) then raise exception 'Select each link once' using errcode='22023';end if;
 foreach k in array p_ids loop receipts:=receipts||people_work_apply(k,p_action,current_viewer(),false);end loop;
 return jsonb_build_object('count',cardinality(receipts),'receipts',to_jsonb(receipts));
end $$;
create function pulse.people_work_decide_group(p_group text,p_person uuid,p_action text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k uuid; receipts uuid[]:='{}'; skipped int:=0;
begin
 if current_viewer() is null or not viewer_is('hr','admin','leadership') then
  raise exception 'HR or leadership decides work suggestions' using errcode='42501';end if;
 if p_action not in ('accept','dismiss') then raise exception 'A group is accepted or dismissed' using errcode='22023';end if;
 for k in select id from people_work_link where org_id=current_org() and group_key=p_group and status='suggested' and retired_at is null
  and (p_person is null or person_id=p_person) order by created_at,id loop
  begin
   receipts:=receipts||people_work_apply(k,p_action,current_viewer(),false);
  -- e.g. a task someone else owns by now: left for one-by-one review.
  exception when sqlstate '40001' or sqlstate '22023' or sqlstate 'P0002' then skipped:=skipped+1;
  end;
 end loop;
 if not cardinality(receipts)>0 and skipped=0 then raise exception 'Nothing left in this group; refresh the page' using errcode='40001';end if;
 return jsonb_build_object('count',cardinality(receipts),'skipped',skipped,'receipts',to_jsonb(receipts));
end $$;
-- The importer accepts deterministic links through the same path, so each automatic decision has a receipt and an undo.
create function pulse.people_work_auto_accept(p_ids uuid[]) returns int
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k uuid; n int:=0;
begin
 if current_viewer() is not null then raise exception 'Only the importer accepts automatically' using errcode='42501';end if;
 foreach k in array coalesce(p_ids,'{}') loop
  begin perform people_work_apply(k,'accept',null,true); n:=n+1;
  -- A lock, a newer owner or a retired pod wins; the link stays a suggestion for review.
  exception when sqlstate '40001' or sqlstate '22023' or sqlstate 'P0002' then null;
  end;
 end loop;
 return n;
end $$;
revoke all on function pulse.people_work_apply(uuid,text,uuid,boolean),pulse.people_work_decide(uuid[],text),
 pulse.people_work_decide_group(text,uuid,text),pulse.people_work_auto_accept(uuid[]) from public;
grant execute on function pulse.people_work_decide(uuid[],text),pulse.people_work_decide_group(text,uuid,text) to pulse_api;
grant execute on function pulse.people_work_auto_accept(uuid[]) to pulse_worker;
-- migrate:down
