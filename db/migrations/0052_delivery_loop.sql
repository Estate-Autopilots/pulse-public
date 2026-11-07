-- migrate:up
-- Delivery extends the existing task identity. A task is never a deliverable/version.
create table pulse_priv.delivery_task(
 org_id uuid not null references pulse.org(id),id uuid primary key references pulse.task(id),project_id uuid not null references pulse.project(id),
 parent_id uuid references pulse_priv.delivery_task(id),state text not null check(state in('unknown','draft','ready','in_progress','ready_for_review','accepted','cancelled')),
 owner_id uuid not null references pulse.person(id),assignee_id uuid not null references pulse.person(id),reviewer_id uuid not null references pulse.person(id),
 body jsonb not null,revision int not null default 1,unique(org_id,id),check(parent_id is distinct from id));
create table pulse_priv.delivery_edge(org_id uuid not null references pulse.org(id),project_id uuid not null references pulse.project(id),
 source_id uuid not null references pulse_priv.delivery_task(id),target_id uuid not null references pulse_priv.delivery_task(id),
 kind text not null check(kind in('finish_to_start','input','approval')),required boolean not null,primary key(org_id,source_id,target_id),check(source_id<>target_id));
create table pulse_priv.delivery_event(id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),task_id uuid not null references pulse.task(id),
 actor uuid references pulse.person(id),kind text not null,body jsonb not null,at timestamptz not null default now());
create table pulse_priv.delivery_template(org_id uuid not null references pulse.org(id),version int not null,body jsonb not null,at timestamptz not null default now(),primary key(org_id,version));
create table pulse_priv.delivery_plan(org_id uuid not null references pulse.org(id),project_id uuid primary key references pulse.project(id),template_version int not null,package text not null,
 baseline jsonb not null,owner_id uuid not null references pulse.person(id),calendar jsonb not null,at timestamptz not null default now());
create table pulse_priv.delivery_blocker(id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),task_id uuid not null references pulse.task(id),
 kind text not null check(kind in('input','approval','client_approval','source_outage','capacity','scope')),resolver uuid not null references pulse.person(id),
 started_at timestamptz not null,ended_at timestamptz,expected text not null,evidence text not null,contested boolean not null default false,check(ended_at is null or ended_at>=started_at));
do $$ declare t text;begin
 foreach t in array array['delivery_task','delivery_edge','delivery_event','delivery_template','delivery_plan','delivery_blocker'] loop
 execute format('alter table pulse_priv.%I enable row level security',t);execute format('alter table pulse_priv.%I force row level security',t);
 execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('create trigger audit_mutation after insert or update or delete on pulse_priv.%I for each row execute function pulse.audit_mutation()',t);
 end loop;end $$;
create function pulse.delivery_access(p_project uuid,w boolean default false) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not exists(select 1 from person where id=current_viewer() and org_id=current_org() and side='staff' and status='active')
 or viewer_is('hr') or not exists(select 1 from project where id=p_project and org_id=current_org())
 or not (work_project(p_project) or exists(select 1 from pulse_priv.delivery_task where org_id=current_org() and project_id=p_project and current_viewer() in(owner_id,assignee_id,reviewer_id))) then
 raise exception 'Project delivery is unavailable for this account' using errcode='42501';end if;
 if w and not(viewer_is('admin','leadership') or exists(select 1 from pulse_priv.delivery_task where org_id=current_org() and project_id=p_project and owner_id=current_viewer())
 or exists(select 1 from project pr join role_assignment r on r.unit_id=pr.unit_id where pr.id=p_project and r.person_id=current_viewer() and (r.is_manager_of_unit or r.role_key in('manager','pgs','head_pgs')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))) then
 raise exception 'Accountable project owner or assigned PGS required' using errcode='42501';end if;
end $$;
create function pulse.delivery_state(p_project uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform delivery_access(p_project);
 return jsonb_build_object('tasks',coalesce((select jsonb_agg(body||jsonb_build_object('id',id,'projectId',project_id,'parentId',parent_id,'state',state,'revision',revision,
 'ownerId',owner_id,'assigneeId',assignee_id,'reviewerId',reviewer_id,
 'owner',(select display_name from person where id=owner_id),'assignee',(select display_name from person where id=assignee_id),'reviewer',(select display_name from person where id=reviewer_id),
 'blockers',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'type',b.kind,'resolver',(select display_name from person where id=b.resolver),'start',started_at,'end',ended_at,'expected',expected,'evidence',evidence,'contested',contested)) from pulse_priv.delivery_blocker b where b.org_id=current_org() and b.task_id=t.id),'[]')) order by body->>'phase',id)
 from pulse_priv.delivery_task t where org_id=current_org() and project_id=p_project),'[]'),
 'edges',coalesce((select jsonb_agg(jsonb_build_object('from',source_id,'to',target_id,'type',kind,'required',required)) from pulse_priv.delivery_edge where org_id=current_org() and project_id=p_project),'[]'),
 'plan',(select to_jsonb(p)-'org_id' from pulse_priv.delivery_plan p where org_id=current_org() and project_id=p_project),
 'events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'taskId',e.task_id,'kind',e.kind,'at',e.at,'actor',e.actor,'snapshot',e.body) order by e.at,e.id) from pulse_priv.delivery_event e join pulse_priv.delivery_task t on t.id=e.task_id where e.org_id=current_org() and t.project_id=p_project),'[]'));
end $$;
create function pulse.delivery_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare tid uuid:=coalesce((p->>'id')::uuid,gen_random_uuid());pr uuid:=(p->>'projectId')::uuid;par uuid:=nullif(p->>'parentId','')::uuid;
 own uuid:=(p->>'ownerId')::uuid;assign uuid:=(p->>'assigneeId')::uuid;rev uuid:=(p->>'reviewerId')::uuid;old pulse_priv.delivery_task%rowtype;b jsonb;st text;
begin
 perform delivery_access(pr,true);perform pg_advisory_xact_lock(hashtextextended('delivery:'||current_org()::text,0));
 select * into old from pulse_priv.delivery_task where org_id=current_org() and id=tid;
 if old.id is not null and (old.project_id<>pr or old.revision<>(p->>'revision')::int or p->>'revision' is null) then raise exception 'Task changed; refresh before editing' using errcode='40001';end if;
 if exists(select 1 from pulse.task where id=tid and (org_id<>current_org() or project_id is distinct from pr)) then raise exception 'Task link unavailable' using errcode='42501';end if;
 if old.state in('accepted','cancelled') then raise exception 'Final task requires an explicit reopen event' using errcode='22023';end if;
 if own is null or assign is null or rev is null or (select count(*) from person where org_id=current_org() and status='active' and side='staff' and id=any(array[own,assign,rev]))<>(select count(distinct x) from unnest(array[own,assign,rev]) x) then raise exception 'Choose active tenant staff for all roles' using errcode='22023';end if;
 if assign=rev then raise exception 'Assignee cannot approve own work' using errcode='22023';end if;
 if par is not null then
 if par=tid or not exists(select 1 from pulse_priv.delivery_task where org_id=current_org() and id=par and project_id=pr) then raise exception 'Parent task unavailable' using errcode='22023';end if;
 if exists(with recursive ancestors(id,parent_id) as(select id,parent_id from pulse_priv.delivery_task where id=par and org_id=current_org() union all select t.id,t.parent_id from pulse_priv.delivery_task t join ancestors a on t.id=a.parent_id where t.org_id=current_org()) select 1 from ancestors where id=tid) then raise exception 'Cyclic hierarchy rejected' using errcode='22023';end if;end if;
 if length(trim(coalesce(p->>'title',''))) not between 1 and 240 or jsonb_typeof(p->'checklist') is distinct from 'array' or jsonb_array_length(p->'checklist')>40 or p->>'principal' is distinct from 'human'
 or jsonb_typeof(p->'effort') is distinct from 'array' or jsonb_array_length(p->'effort')<>2 or (p->'effort'->>0)::numeric<0 or (p->'effort'->>1)::numeric<(p->'effort'->>0)::numeric or (p->'effort'->>1)::numeric>365
 or p->>'phase' not in('Handover','Project Blueprint','Trust Engine','Buyer Journey Engine','Sales Intelligence System','Recurring loop')
 or p->>'priority' not in('low','normal','high','urgent') or exists(select 1 from jsonb_array_elements(p->'checklist') c where jsonb_typeof(c->'done') is distinct from 'boolean' or length(coalesce(c->>'label','')) not between 1 and 240) then raise exception 'Task title roles checklist and effort range required' using errcode='22023';end if;
 if nullif(p->>'due','') is not null then perform (p->>'due')::date;end if;
 if nullif(p->>'committed','') is not null then perform (p->>'committed')::date;end if;
 if old.id is not null and p->>'committed' is distinct from old.body->>'committed' and length(trim(coalesce(p->>'commitmentReason','')))<3 then raise exception 'Commitment change needs an approval reason' using errcode='22023';end if;
 st:=coalesce(old.state,case when exists(select 1 from task where id=tid and source='imported' and status='unknown') then 'unknown' else 'draft' end);
 b:=jsonb_build_object('title',p->>'title','phase',p->>'phase','principal','human','mandatory',coalesce((p->>'mandatory')::boolean,true),'excludedReason',p->>'excludedReason','checklist',p->'checklist','effort',p->'effort','due',nullif(p->>'due',''),'committed',nullif(p->>'committed',''),'baseline',coalesce(old.body->>'baseline',p->>'baseline','plan-v1'),'confidence',coalesce(p->>'confidence','Planning default; comparable evidence unavailable'),'priority',p->>'priority','version',nullif(p->>'version',''),'reviewVersion',old.body->'reviewVersion');
 if old.id is not null and (b->'version' is distinct from old.body->'version' or assign<>old.assignee_id or rev<>old.reviewer_id or b->'checklist' is distinct from old.body->'checklist') and st='ready_for_review' then st:='in_progress';b:=b||jsonb_build_object('reviewVersion',null);end if;
 if not exists(select 1 from task where id=tid) then insert into task(id,org_id,project_id,title,owner_id,assignee_person_id,phase_key,status,source) values(tid,current_org(),pr,p->>'title',own,assign,p->>'phase','open','pulse');end if;
 insert into pulse_priv.delivery_task(org_id,id,project_id,parent_id,state,owner_id,assignee_id,reviewer_id,body) values(current_org(),tid,pr,par,st,own,assign,rev,b)
 on conflict(id) do update set parent_id=excluded.parent_id,owner_id=excluded.owner_id,assignee_id=excluded.assignee_id,reviewer_id=excluded.reviewer_id,body=excluded.body,state=excluded.state,revision=pulse_priv.delivery_task.revision+1;
 update task set title=p->>'title',owner_id=own,assignee_person_id=assign,locked=array(select distinct x from unnest(locked||array['title','owner_id','due_label','status']) x),due_label=nullif(p->>'due','') where id=tid;
 insert into pulse_priv.delivery_event(org_id,task_id,actor,kind,body) values(current_org(),tid,current_viewer(),'assignment_scope',b||jsonb_build_object('ownerId',own,'assigneeId',assign,'reviewerId',rev,'reason',p->>'commitmentReason'));
 return tid;
end $$;
create function pulse.delivery_edge_save(p_source uuid,p_target uuid,p_kind text,p_required boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare pr uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended('delivery:'||current_org()::text,0));
 select project_id into pr from pulse_priv.delivery_task where org_id=current_org() and id=p_source;perform delivery_access(pr,true);
 if p_source=p_target or not exists(select 1 from pulse_priv.delivery_task where id=p_target and org_id=current_org() and project_id=pr) then raise exception 'Self or unavailable dependency rejected' using errcode='22023';end if;
 if exists(with recursive reachable(id) as(select p_target union select e.target_id from pulse_priv.delivery_edge e join reachable r on e.source_id=r.id where e.org_id=current_org()) select 1 from reachable where id=p_source) then raise exception 'Cyclic dependency rejected atomically' using errcode='22023';end if;
 insert into pulse_priv.delivery_edge values(current_org(),pr,p_source,p_target,p_kind,p_required) on conflict(org_id,source_id,target_id) do update set kind=excluded.kind,required=excluded.required;
end $$;
create function pulse.delivery_transition(p_id uuid,p_revision int,p_state text,p_version text,p_reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.delivery_task%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended('delivery:'||current_org()::text,0));
 select * into t from pulse_priv.delivery_task where org_id=current_org() and id=p_id for update;perform delivery_access(t.project_id);
 if t.revision<>p_revision then raise exception 'Task changed; refresh before the decision' using errcode='40001';end if;
 if p_state in('accepted') then if current_viewer()<>t.reviewer_id or current_viewer()=t.assignee_id then raise exception 'Current independent reviewer required' using errcode='42501';end if;
 elsif current_viewer() not in(t.owner_id,t.assignee_id) and not viewer_is('admin','leadership') then raise exception 'Current owner or assignee required' using errcode='42501';end if;
 if not((t.state in('unknown','draft') and p_state='ready') or(t.state='ready' and p_state='in_progress') or(t.state='in_progress' and p_state='ready_for_review') or(t.state='ready_for_review' and p_state in('accepted','in_progress')) or(p_state='cancelled' and t.state not in('accepted','cancelled')) or(t.state in('accepted','cancelled') and p_state='in_progress')) then raise exception 'Invalid delivery transition' using errcode='22023';end if;
 if p_state in('in_progress','ready') and exists(select 1 from pulse_priv.delivery_edge e join pulse_priv.delivery_task s on s.id=e.source_id where e.org_id=current_org() and e.target_id=p_id and e.required and s.state<>'accepted') then raise exception 'Required upstream gate is not accepted' using errcode='22023';end if;
 if p_state in('ready','in_progress','ready_for_review','accepted') and exists(select 1 from pulse_priv.delivery_blocker where org_id=current_org() and task_id=p_id and ended_at is null) then raise exception 'Resolve or contest the declared blocker before advancing' using errcode='22023';end if;
 if p_state='accepted' then
 if t.state<>'ready_for_review' or nullif(p_version,'') is distinct from t.body->>'version' or t.body->>'reviewVersion' is distinct from t.body->>'version' then raise exception 'Exact current requested version required' using errcode='40001';end if;
 if exists(select 1 from jsonb_array_elements(t.body->'checklist') c where c->>'done'<>'true') or exists(select 1 from pulse_priv.delivery_task where org_id=current_org() and parent_id=p_id and coalesce((body->>'mandatory')::boolean,true) and state<>'accepted' and not(state='cancelled' and length(trim(coalesce(body->>'excludedReason','')))>2)) then raise exception 'Mandatory children and acceptance checklist must be approved' using errcode='22023';end if;
 end if;
 if (p_state='cancelled' or t.state in('accepted','cancelled') or t.state='ready_for_review' and p_state='in_progress') and length(trim(coalesce(p_reason,'')))<3 then raise exception 'Cancellation rework or reopen needs a reason' using errcode='22023';end if;
 update pulse_priv.delivery_task set state=p_state,revision=revision+1,body=body||case when p_state='ready_for_review' then jsonb_build_object('reviewVersion',body->'version') when p_state='cancelled' then jsonb_build_object('excludedReason',p_reason) else '{}' end where id=p_id;
 update task set status=case p_state when 'accepted' then 'done' when 'ready_for_review' then 'in_review' when 'cancelled' then 'cancelled' when 'in_progress' then 'in_progress' else 'open' end where id=p_id;
 insert into pulse_priv.delivery_event(org_id,task_id,actor,kind,body) values(current_org(),p_id,current_viewer(),p_state,t.body||jsonb_build_object('ownerId',t.owner_id,'assigneeId',t.assignee_id,'reviewerId',t.reviewer_id,'version',p_version,'reason',p_reason,'revision',p_revision));
end $$;
create function pulse.delivery_block(p_id uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.delivery_task%rowtype;bid uuid:=coalesce(nullif(p->>'id','')::uuid,gen_random_uuid());
begin
 select * into t from pulse_priv.delivery_task where org_id=current_org() and id=p_id;perform delivery_access(t.project_id);
 if current_viewer() not in(t.owner_id,t.assignee_id,t.reviewer_id) and not viewer_is('admin','leadership') then raise exception 'Assigned delivery role required' using errcode='42501';end if;
 if length(trim(coalesce(p->>'evidence','')))<3 or length(trim(coalesce(p->>'expected','')))<3 or not exists(select 1 from person where org_id=current_org() and id=(p->>'resolverId')::uuid and status='active') then raise exception 'Blocker evidence resolver and expectation required' using errcode='22023';end if;
 if exists(select 1 from pulse_priv.delivery_blocker where id=bid and (org_id<>current_org() or task_id<>p_id)) then raise exception 'Blocker unavailable' using errcode='42501';end if;
 insert into pulse_priv.delivery_blocker values(bid,current_org(),p_id,p->>'type',(p->>'resolverId')::uuid,(p->>'start')::timestamptz,nullif(p->>'end','')::timestamptz,p->>'expected',p->>'evidence',coalesce((p->>'contested')::boolean,false)) on conflict(id) do update set ended_at=excluded.ended_at,contested=excluded.contested;
 insert into pulse_priv.delivery_event(org_id,task_id,actor,kind,body) values(current_org(),p_id,current_viewer(),'blocker',p);return bid;
end $$;
create function pulse.delivery_template_save(p jsonb) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare ver int;
begin
 if not viewer_is('admin','leadership') then raise exception 'Tenant template authority required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('delivery:'||current_org()::text,0));
 select coalesce(max(version),0)+1 into ver from pulse_priv.delivery_template where org_id=current_org();
 if ver-1<>(p->>'previousVersion')::int or p->>'previousVersion' is null then raise exception 'Template changed; refresh first' using errcode='40001';end if;
 insert into pulse_priv.delivery_template values(current_org(),ver,p,now());return ver;
end $$;
create function pulse.delivery_templates() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or viewer_is('hr') then raise exception 'Staff work access required' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('version',version,'body',body)) from pulse_priv.delivery_template where org_id=current_org()),'[]');
end $$;
create function pulse.delivery_plan_save(p_project uuid,p_version int,p_package text,p_calendar jsonb,p_baseline jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform delivery_access(p_project,true);
 if p_package not in('video_only','ads_only','full') or p_version<0 or jsonb_typeof(p_calendar->'intervals') is distinct from 'array' or coalesce(p_calendar->>'name','')='' then raise exception 'Package and named working calendar required' using errcode='22023';end if;
 insert into pulse_priv.delivery_plan values(current_org(),p_project,p_version,p_package,p_baseline,current_viewer(),p_calendar,now());
end $$;
revoke all on function pulse.delivery_access(uuid,boolean),pulse.delivery_state(uuid),pulse.delivery_save(jsonb),pulse.delivery_edge_save(uuid,uuid,text,boolean),pulse.delivery_transition(uuid,int,text,text,text),pulse.delivery_block(uuid,jsonb),pulse.delivery_template_save(jsonb),pulse.delivery_templates(),pulse.delivery_plan_save(uuid,int,text,jsonb,jsonb) from public;
grant execute on function pulse.delivery_access(uuid,boolean),pulse.delivery_state(uuid),pulse.delivery_save(jsonb),pulse.delivery_edge_save(uuid,uuid,text,boolean),pulse.delivery_transition(uuid,int,text,text,text),pulse.delivery_block(uuid,jsonb),pulse.delivery_template_save(jsonb),pulse.delivery_templates(),pulse.delivery_plan_save(uuid,int,text,jsonb,jsonb) to pulse_api;
-- migrate:down
