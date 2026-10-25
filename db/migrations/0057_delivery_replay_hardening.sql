-- migrate:up
create or replace function pulse.delivery_save(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 update task set title=p->>'title',owner_id=own,assignee_person_id=assign,locked=array(select distinct x from unnest(locked||array['title','owner_id','due_label','status']) x),due_label=coalesce(nullif(p->>'due',''),due_label) where id=tid;
 insert into pulse_priv.delivery_event(org_id,task_id,actor,kind,body) values(current_org(),tid,current_viewer(),'assignment_scope',b||jsonb_build_object('ownerId',own,'assigneeId',assign,'reviewerId',rev,'reason',p->>'commitmentReason'));
 return tid;
end $$;

-- migrate:down
