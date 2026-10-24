-- migrate:up
-- SOP-WORKFLOW part 2 (owner, 11 Oct 2026: create workflows from SOPs; steps become tasks with assignee rules; triggers,
-- conditions and approvals; it runs on the task engine).
--  * pulse.workflow: a definition leadership designs (from an SOP or blank): steps with who does them (a role, a kind of
--    work and the domains that cover it, a person, whoever starts it, the project's owner, or the pool), kinds of work,
--    SLAs, branches with conditions, approvals, waits. Publishing keeps a version; a run keeps the definition it began with.
--  * pulse.workflow_run / pulse.workflow_run_step: one run per project (or client, or schedule). A step becomes a task
--    when it is reached (pulse.task, source 'workflow'); finishing the task moves the run on (a trigger, so every way of
--    finishing a task counts). Decisions follow their branch conditions or the answer given; an approval's "send back"
--    goes back to an earlier step; a step waiting on several others starts when all are resolved.
--  * Tasks are given with the authority of whoever published the workflow, through the usual rules: inside a person's
--    domains it is theirs at once, outside them it is a request to take it (work_assign_mode, as everywhere in Work).
--  * Triggers: started by hand, by a new client package made in Pulse, by a milestone (a kind of work finished on the
--    project, or the project's status), on a schedule (pulse.workflow_tick, each minute, with waits and SLA breaches),
--    or by a form (part 3).

create table pulse.workflow (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 name text not null check(length(btrim(name)) between 1 and 200),purpose text check(length(purpose)<=2000),
 sop_id uuid references pulse.sop(id),client_id uuid references pulse.client(id),
 status text not null default 'draft' check(status in ('draft','live','paused','archived')),
 definition jsonb not null default '{"steps":[]}' check(jsonb_typeof(definition)='object' and jsonb_typeof(definition->'steps')='array' and pg_column_size(definition)<400000),
 trigger jsonb not null default '{"kind":"manual"}' check(jsonb_typeof(trigger)='object' and trigger->>'kind' in ('manual','package','milestone','schedule','form')),
 version int not null default 1,last_fired_at timestamptz,
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 published_by uuid references pulse.person(id),published_at timestamptz
);
create index workflow_status on pulse.workflow(org_id,status);
create table pulse.workflow_version (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),workflow_id uuid not null references pulse.workflow(id),
 version int not null,definition jsonb not null,trigger jsonb not null,published_by uuid references pulse.person(id),published_at timestamptz not null default now(),
 unique(org_id,workflow_id,version)
);
create table pulse.workflow_run (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 workflow_id uuid not null references pulse.workflow(id),version int not null,definition jsonb not null,
 name text not null check(length(name) between 1 and 300),
 project_id uuid references pulse.project(id),client_id uuid references pulse.client(id),
 status text not null default 'running' check(status in ('running','done','cancelled')),
 context jsonb not null default '{}' check(jsonb_typeof(context)='object'),
 started_by uuid references pulse.person(id),authority uuid references pulse.person(id),
 started_via text not null default 'manual' check(started_via in ('manual','package','milestone','schedule','form')),trigger_ref text check(length(trigger_ref)<=200),
 started_at timestamptz not null default now(),finished_at timestamptz,cancelled_by uuid references pulse.person(id),cancel_note text check(length(cancel_note)<=500)
);
create index workflow_run_live on pulse.workflow_run(org_id,status,started_at desc);
create index workflow_run_project on pulse.workflow_run(org_id,project_id) where project_id is not null;
create index workflow_run_workflow on pulse.workflow_run(org_id,workflow_id);
create table pulse.workflow_run_step (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 run_id uuid not null references pulse.workflow_run(id),step_key text not null check(length(step_key) between 1 and 40),position int not null,
 title text not null,kind text not null check(kind in ('task','decision','approval','wait','end')),
 status text not null default 'waiting' check(status in ('waiting','active','done','skipped','cancelled')),
 task_id uuid references pulse.task(id),asked_id uuid references pulse.person(id),assign_why text check(length(assign_why)<=300),
 outcome text check(length(outcome)<=80),note text check(length(note)<=500),
 in_total int not null default 0,in_done int not null default 0,in_taken int not null default 0,rounds int not null default 0,
 sla_hours numeric(8,2),started_at timestamptz,due_at timestamptz,done_at timestamptz,late_at timestamptz,
 unique(org_id,run_id,step_key)
);
create index workflow_run_step_task on pulse.workflow_run_step(org_id,task_id) where task_id is not null;
create index workflow_run_step_active on pulse.workflow_run_step(org_id,status,due_at) where status='active';

alter table pulse.task_event drop constraint task_event_kind_check;
alter table pulse.task_event add constraint task_event_kind_check check(kind in ('created','edited','status','assigned','reviewer','blocked','unblocked','proof','accepted','returned','moved','asked','joined',
 'pooled','claimed','valued','handover','unlocked','step','same','merged','deleted','restored','workflow'));

-- Who reads a run: leadership, HR and admins; whoever started it; the people its project belongs to; anyone given a step.
create function pulse.workflow_run_visible(p_run uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('admin','leadership','hr')
  or exists(select 1 from workflow_run r where r.org_id=current_org() and r.id=p_run and (r.started_by=current_viewer() or work_project_in(r.project_id)))
  or exists(select 1 from workflow_run_step s left join task t on t.id=s.task_id where s.org_id=current_org() and s.run_id=p_run
   and current_viewer() in (s.asked_id,t.assignee_person_id,t.owner_id,t.review_owner_id)))
$$;
do $$ declare t text;begin
 foreach t in array array['workflow','workflow_version','workflow_run','workflow_run_step'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant_isolation on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select on pulse.%I to pulse_api',t);
  execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;
create policy workflow_read on pulse.workflow as restrictive for select to pulse_api using(pulse.current_viewer() is not null and (status in ('live','paused') or pulse.sop_editor()));
create policy workflow_version_read on pulse.workflow_version as restrictive for select to pulse_api using(pulse.current_viewer() is not null);
create policy workflow_run_read on pulse.workflow_run as restrictive for select to pulse_api using(pulse.workflow_run_visible(id));
create policy workflow_run_step_read on pulse.workflow_run_step as restrictive for select to pulse_api using(pulse.workflow_run_visible(run_id));

-- The connections of a definition (as sop-model.ts edges()): explicit `next` (with label and condition), else on to
-- the following step; an end step stops.
create function pulse.workflow_edges(p_def jsonb) returns table(from_key text,to_key text,label text,cond jsonb,ord int) language sql immutable as $$
 with s as (select x,i::int i from jsonb_array_elements(coalesce(p_def->'steps','[]')) with ordinality t(x,i)),
 ids as (select x->>'id' id from s)
 select s.x->>'id',n->>'to',nullif(btrim(n->>'label'),''),case when jsonb_typeof(n->'when')='object' then n->'when' end,j::int
  from s cross join lateral jsonb_array_elements(case when jsonb_typeof(s.x->'next')='array' then s.x->'next' else '[]' end) with ordinality u(n,j)
  where n->>'to' in (select id from ids) and n->>'to'<>s.x->>'id'
 union all
 select s.x->>'id',nx.x->>'id',null,null,1 from s join s nx on nx.i=s.i+1
  where jsonb_typeof(s.x->'next') is distinct from 'array' and coalesce(s.x->>'kind','task')<>'end'
$$;

-- A branch condition on the run's values (form answers are "<step>.<field>"): filled, empty, eq, ne, gt, gte, lt, lte, contains.
create function pulse.workflow_cond(p_cond jsonb,p_ctx jsonb) returns boolean language plpgsql immutable as $$
declare v jsonb:=p_ctx->(p_cond->>'field');a text:=v#>>'{}';b text:=p_cond->'value'#>>'{}';an numeric;bn numeric;
begin
 if p_cond is null then return true;end if;
 case p_cond->>'op'
  when 'filled' then return v is not null and coalesce(a,'')<>'' and v<>'[]'::jsonb and v<>'false'::jsonb;
  when 'empty' then return v is null or coalesce(a,'')='' or v='[]'::jsonb or v='false'::jsonb;
  when 'eq' then return lower(coalesce(a,''))=lower(coalesce(b,''));
  when 'ne' then return lower(coalesce(a,''))<>lower(coalesce(b,''));
  when 'contains' then return case when jsonb_typeof(v)='array' then exists(select 1 from jsonb_array_elements_text(v) x where lower(x)=lower(b)) else coalesce(a,'') ilike '%'||coalesce(b,'')||'%' end;
  when 'gt','gte','lt','lte' then
   begin an:=a::numeric;bn:=b::numeric;exception when others then return false;end;
   return case p_cond->>'op' when 'gt' then an>bn when 'gte' then an>=bn when 'lt' then an<bn else an<=bn end;
  else return false;
 end case;
end $$;

-- People who hold a role as written on a step ("PGS" also finds "Senior PGS"), or by role key.
create function pulse.workflow_role_people(p_role text) returns setof uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 with w as (select coalesce(array_agg(t),'{}') words from regexp_split_to_table(lower(regexp_replace(coalesce(p_role,''),'[^a-zA-Z0-9 ]+',' ','g')),'\s+') t where length(t)>1 and t not in ('the','of','and'))
 select p.id from person p join people_profile pp on pp.person_id=p.id cross join w
 where p.org_id=current_org() and p.side='staff' and p.status='active' and (
  (cardinality(w.words)>0 and (select bool_and(lower(coalesce(pp.role,'')) ~ ('\m'||x||'s?\M')) from unnest(w.words) x))
  or exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p.id and r.role_key=lower(btrim(p_role)) and current_date between r.valid_from and coalesce(r.valid_to,'infinity')))
$$;
create function pulse.workflow_open_load(p_person uuid) returns int language sql stable security definer set search_path=pulse,pg_temp as $$
 select count(*)::int from task where org_id=current_org() and coalesce(assignee_person_id,owner_id)=p_person and status in ('open','in_progress','blocked','unknown') and deleted_at is null
$$;

-- Who a step goes to, and why (shown on the run). People on the run's project come first, then the least loaded.
create function pulse.workflow_pick(p_rule jsonb,p_role text,p_category text,p_run pulse.workflow_run,out person uuid,out why text,out pool_scope text,out pool_ref text)
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare v_by text:=coalesce(nullif(p_rule->>'by',''),case when nullif(btrim(coalesce(p_role,'')),'') is not null then 'role' else 'starter' end);
 wp work_project;r record;
begin
 select * into wp from work_project where org_id=current_org() and project_id=p_run.project_id;
 if v_by='person' then
  person:=nullif(p_rule->>'personId','')::uuid; if person is not null and not task_person_ok(person) then person:=null;end if; why:='Named on the step';
 elsif v_by='starter' then person:=p_run.started_by; why:='Whoever started the run';
 elsif v_by='project_owner' then person:=wp.owner_id; why:='The project''s owner';
 elsif v_by='pool' then pool_scope:=case when coalesce(p_rule->>'scope','company')='pod' and wp.pod is not null then 'pod' else 'company' end;
  pool_ref:=case when pool_scope='pod' then wp.pod end; why:=case when pool_scope='pod' then 'In '||wp.pod||'''s pool' else 'In the company pool' end; return;
 elsif v_by='role' and coalesce(p_rule->>'role',p_role) ~* '^(the )?(client|customer|vendor|supplier|partner|developer)s?$' then
  -- The client's own steps are followed up by whoever looks after the project.
  person:=coalesce(wp.owner_id,p_run.started_by); why:='The client does this: the project''s owner follows it up';
 else
  for r in select x.id as pid,coalesce(x.id=wp.owner_id or exists(select 1 from project_member m where m.org_id=current_org() and m.project_id=p_run.project_id and m.person_id=x.id and m.left_at is null),false) as on_project,
    coalesce(wp.pod is not null and pp.pod=wp.pod,false) as in_pod,workflow_open_load(x.id) as n_open,p.display_name as pname
   from (select y as id from workflow_role_people(coalesce(p_rule->>'role',p_role)) y where v_by='role'
         union select d.person_id from work_domain d where v_by='domain' and d.org_id=current_org() and d.status='active' and work_domain_match(d.person_id,p_run.project_id,coalesce(nullif(p_rule->>'category',''),p_category),'{}') is not null) x
   join person p on p.id=x.id left join people_profile pp on pp.person_id=x.id
   order by 2 desc,3 desc,4,5 limit 1 loop
   person:=r.pid;
   why:=case when r.on_project then 'On the project' when r.in_pod then 'In the project''s pod' else case when v_by='domain' then 'In their domain' else 'Holds the role' end end||', '||r.n_open||' open task'||case when r.n_open=1 then '' else 's' end;
  end loop;
  if person is null then why:=case when v_by='domain' then 'Nobody''s domains cover this kind of work yet' else 'Nobody holds the role '||coalesce(p_rule->>'role',p_role,'') end;end if;
 end if;
end $$;

create function pulse.workflow_def_step(p_def jsonb,p_key text) returns jsonb language sql immutable as $$
 select x from jsonb_array_elements(coalesce(p_def->'steps','[]')) x where x->>'id'=p_key limit 1
$$;

create function pulse.workflow_notify(p_person uuid,p_type text,p_run uuid,p_key text,p_title text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if p_person is null then return;end if;
 perform notification_emit(p_person,p_type,'workflow_run',p_run,left(p_key,200),left(p_title,160),'/sops/runs/'||p_run,'task');
end $$;

-- A step is reached: a task for whoever it goes to (or an ask, or the pool), a wait, an automatic decision, or the end.
create function pulse.workflow_step_activate(p_step uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare st workflow_run_step;r workflow_run;d jsonb;pick record;tid uuid;prev text:=current_setting('pulse.viewer_id',true);mode jsonb;
 chosen int;v_cat text;v_sla numeric;v_title text;wname text;v_notes text;v_why text;
begin
 select * into st from workflow_run_step where id=p_step for update;
 select * into r from workflow_run where id=st.run_id;
 if r.status<>'running' then return;end if;
 d:=workflow_def_step(r.definition,st.step_key);
 v_sla:=nullif(d->>'slaHours','')::numeric;
 update workflow_run_step set status='active',started_at=now(),done_at=null,late_at=null,rounds=rounds+1,in_done=0,in_taken=0,
  due_at=case when st.kind='wait' then now()+make_interval(mins=>round(coalesce(nullif(d->>'waitHours','')::numeric,v_sla,24)*60)::int)
   when v_sla is not null then now()+make_interval(mins=>round(v_sla*60)::int) end where id=p_step;
 if st.kind='end' then perform workflow_step_finish(p_step,null);return;end if;
 if st.kind='wait' then return;end if;
 -- A decision whose branches carry conditions decides itself from the run's values; the first that holds is taken.
 if st.kind='decision' and exists(select 1 from workflow_edges(r.definition) x where x.from_key=st.step_key and x.cond is not null) then
  select x.ord into chosen from workflow_edges(r.definition) x where x.from_key=st.step_key and (x.cond is null or workflow_cond(x.cond,r.context))
   order by (x.cond is null),x.ord limit 1;
  -- None holds and there is no "otherwise": someone decides by hand (the step becomes a task below).
  if chosen is not null then perform workflow_step_finish(p_step,'#'||chosen);return;end if;
 end if;
 -- A task, given with the authority of whoever published the workflow (the usual assignment rules apply).
 select name into wname from workflow where id=r.workflow_id;
 v_cat:=coalesce(nullif(d->>'category',''),work_category_guess(st.title));
 select * into pick from workflow_pick(coalesce(d->'assign','{}'::jsonb),d->>'role',v_cat,r);
 v_why:=pick.why;v_title:=st.title;
 v_notes:=left(concat_ws(E'\n\n',nullif(d->>'detail',''),case when st.kind='approval' then 'An approval: answer it with Approved or Send back at the top of this page.' when st.kind='decision' then 'A decision: choose the way it goes at the top of this page.' end,
  'Step '||st.position||' of the workflow “'||wname||'”'||coalesce(' for '||r.name,'')||'.'),4000);
 perform set_config('pulse.viewer_id',coalesce(coalesce(r.authority,r.started_by)::text,''),true);
 insert into task(org_id,title,status,project_id,source,source_ref,created_by,created_at,edited_by,updated_at,priority,position,due_at,locked,category,estimate_minutes,notes,
  review_owner_id,pool_scope,pool_ref,pooled_at,pooled_by)
 values(current_org(),left(v_title,300),'open',r.project_id,'workflow',st.id::text,coalesce(r.started_by,r.authority),now(),coalesce(r.authority,r.started_by),now(),
  case when st.kind='approval' then 'high' else 'normal' end,st.position,
  case when v_sla is not null then now()+make_interval(mins=>round(v_sla*60)::int) end,'{title,status,owner_id,project_id,due_label}',v_cat,
  case when nullif(d->>'minutes','') is not null then least(20000,greatest(5,(d->>'minutes')::numeric::int)) end,v_notes,
  case when st.kind in ('approval','decision') then null else nullif(coalesce(r.started_by,r.authority),pick.person) end,
  pick.pool_scope,pick.pool_ref,case when pick.pool_scope is not null then now() end,case when pick.pool_scope is not null then coalesce(r.authority,r.started_by) end)
 returning id into tid;
 perform task_event_add(tid,'workflow',null,wname,'Step '||st.position||' of the workflow');
 if pick.person is not null then
  mode:=work_assign_mode(pick.person,r.project_id,v_cat,'{}');
  if mode->>'mode' in ('self','direct') or pick.person=coalesce(r.authority,r.started_by) then
   update task set owner_id=pick.person,assignee_person_id=pick.person,assigned_at=now() where id=tid;
   perform task_event_add(tid,'assigned',null,(select display_name from person where id=pick.person));   -- the task's own trigger tells them
  elsif mode->>'mode'='request' then
   perform work_ask_create('take',tid,null,pick.person,'Step '||st.position||' of “'||wname||'”');
   update workflow_run_step set asked_id=pick.person where id=p_step;
   v_why:=v_why||'; outside their domains, so they were asked';
  else
   v_why:=v_why||'; the publisher''s rules do not reach them: choose someone';
  end if;
 end if;
 perform set_config('pulse.viewer_id',coalesce(prev,''),true);
 update workflow_run_step set task_id=tid,assign_why=left(v_why,300) where id=p_step;
end $$;

-- A connection reaches a step: taken (its branch was chosen) or not. Joins wait for every branch; a step none of whose
-- branches were taken is skipped (and so are the steps only it leads to); a taken branch back to a finished step runs it again.
create function pulse.workflow_arrive(p_run uuid,p_key text,p_taken boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t workflow_run_step;r workflow_run;joins text;e record;
begin
 select * into t from workflow_run_step where org_id=current_org() and run_id=p_run and step_key=p_key for update;
 if not found then return;end if;
 if t.status in ('done','skipped','cancelled') then
  if p_taken then update workflow_run_step set status='waiting',outcome=null where id=t.id;perform workflow_step_activate(t.id);end if;
  return;
 end if;
 if t.status='active' then return;end if;
 update workflow_run_step set in_done=in_done+1,in_taken=in_taken+case when p_taken then 1 else 0 end where id=t.id returning * into t;
 select * into r from workflow_run where id=p_run;
 joins:=coalesce(workflow_def_step(r.definition,p_key)->>'join','any');
 if (joins='all' and t.in_done>=t.in_total and t.in_taken>0) or (joins<>'all' and p_taken) then perform workflow_step_activate(t.id);
 elsif t.in_done>=t.in_total and t.in_taken=0 then
  update workflow_run_step set status='skipped',done_at=now() where id=t.id;
  for e in select * from workflow_edges(r.definition) x where x.from_key=p_key loop perform workflow_arrive(p_run,e.to_key,false);end loop;
 end if;
end $$;

-- Nothing active any more: the run is done (what was never reached is skipped) and whoever started it is told.
create function pulse.workflow_settle(p_run uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r workflow_run;
begin
 select * into r from workflow_run where id=p_run for update;
 if r.status<>'running' or exists(select 1 from workflow_run_step where run_id=p_run and status='active') then return;end if;
 update workflow_run_step set status='skipped',done_at=now() where run_id=p_run and status='waiting';
 update workflow_run set status='done',finished_at=now() where id=p_run;
 perform workflow_notify(r.started_by,'workflow.done',p_run,p_run||':done','Done: '||left(r.name,120));
end $$;

-- A step is finished (its task done, its wait over, its decision made): its branches are taken or not, onwards.
create function pulse.workflow_step_finish(p_step uuid,p_outcome text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare st workflow_run_step;r workflow_run;e record;chosen int;o text;back boolean;
begin
 select * into st from workflow_run_step where id=p_step for update;
 if st.status<>'active' then return;end if;
 select * into r from workflow_run where id=st.run_id;
 if r.status<>'running' then return;end if;
 o:=coalesce(p_outcome,st.outcome);
 if st.kind in ('decision','approval') then
  if o ~ '^#\d+$' then chosen:=substr(o,2)::int;
  else
   select x.ord into chosen from workflow_edges(r.definition) x where x.from_key=st.step_key and lower(coalesce(x.label,''))=lower(coalesce(o,'')) order by x.ord limit 1;
   if chosen is null then
    select x.ord into chosen from workflow_edges(r.definition) x where x.from_key=st.step_key order by x.ord
     offset case when lower(coalesce(o,'')) in ('rejected','no','send back','sent back','declined') then 1 else 0 end limit 1;
   end if;
  end if;
  o:=coalesce((select coalesce(x.label,o) from workflow_edges(r.definition) x where x.from_key=st.step_key and x.ord=chosen),o);
 end if;
 update workflow_run_step set status='done',done_at=now(),outcome=left(o,80) where id=p_step;
 -- Sent back to an earlier step: the other branches wait for this step's next answer instead of being skipped.
 back:=st.kind in ('decision','approval') and coalesce((select t.position from workflow_edges(r.definition) x join workflow_run_step t on t.run_id=r.id and t.step_key=x.to_key
  where x.from_key=st.step_key and x.ord=chosen),st.position+1)<=st.position;
 for e in select * from workflow_edges(r.definition) x where x.from_key=st.step_key order by x.ord loop
  if back and e.ord<>chosen then continue;end if;
  perform workflow_arrive(r.id,e.to_key,st.kind not in ('decision','approval') or e.ord=chosen);
 end loop;
 perform workflow_settle(r.id);
end $$;

-- Start a run (no permission check: the public functions and the triggers decide who may).
create function pulse.workflow_start_as(p_workflow uuid,p_project uuid,p_client uuid,p_starter uuid,p_via text,p_ref text,p_context jsonb,p_name text default null) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare w workflow;v workflow_version;rid uuid;first_step record;label text;
begin
 select * into w from workflow where org_id=current_org() and id=p_workflow;
 if not found or w.status<>'live' then raise exception 'This workflow is not live' using errcode='22023';end if;
 select * into v from workflow_version where org_id=current_org() and workflow_id=w.id and version=w.version;
 if not found or jsonb_array_length(v.definition->'steps')=0 then raise exception 'This workflow has no steps' using errcode='22023';end if;
 label:=coalesce(nullif(btrim(p_name),''),(select coalesce(pr.title,pr.name) from project pr where pr.id=p_project),(select display_name from client where id=coalesce(p_client,w.client_id)),
  w.name||' · '||to_char(now() at time zone 'Asia/Kolkata','DD Mon YYYY'));
 insert into workflow_run(org_id,workflow_id,version,definition,name,project_id,client_id,context,started_by,authority,started_via,trigger_ref)
 values(current_org(),w.id,w.version,v.definition,left(label,300),p_project,coalesce(p_client,w.client_id,(select client_id from project where id=p_project)),coalesce(p_context,'{}'),
  coalesce(p_starter,w.published_by),coalesce(w.published_by,p_starter),p_via,left(p_ref,200)) returning id into rid;
 insert into workflow_run_step(org_id,run_id,step_key,position,title,kind,sla_hours)
 select current_org(),rid,x->>'id',i::int,left(coalesce(nullif(btrim(x->>'title'),''),'Step '||i),300),coalesce(nullif(x->>'kind',''),'task'),nullif(x->>'slaHours','')::numeric
  from jsonb_array_elements(v.definition->'steps') with ordinality t(x,i);
 update workflow_run_step s set in_total=(select count(*) from workflow_edges(v.definition) e where e.to_key=s.step_key and
   (select x.i from (select y->>'id' id,j i from jsonb_array_elements(v.definition->'steps') with ordinality q(y,j)) x where x.id=e.from_key)<s.position)
  where s.run_id=rid;
 perform audit_write('start','workflow_run',rid::text);
 -- The steps nothing leads to start at once (the first step, when the flow loops back to its beginning).
 for first_step in select id from workflow_run_step where run_id=rid and in_total=0 order by position loop perform workflow_step_activate(first_step.id);end loop;
 if not exists(select 1 from workflow_run_step where run_id=rid and status<>'waiting') then
  perform workflow_step_activate((select id from workflow_run_step where run_id=rid order by position limit 1));
 end if;
 return rid;
end $$;

-- Who may start a run by hand: leadership, HR and admins, pod heads and managers, or whoever manages the project.
create function pulse.workflow_can_start(p_project uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('admin','leadership','hr') or work_role() in ('leadership','pod_head')
  or (p_project is not null and work_project_can_manage(p_project)))
$$;
create function pulse.workflow_start(p_workflow uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();pid uuid:=nullif(p->>'projectId','')::uuid;cid uuid:=nullif(p->>'clientId','')::uuid;
begin
 if pid is not null and not exists(select 1 from project where org_id=current_org() and id=pid) then raise exception 'Choose a project' using errcode='22023';end if;
 if cid is not null and not exists(select 1 from client where org_id=current_org() and id=cid) then raise exception 'Choose a client' using errcode='22023';end if;
 if not workflow_can_start(pid) then raise exception 'Leadership, HR, pod heads and the project''s owner start workflows' using errcode='42501';end if;
 return workflow_start_as(p_workflow,pid,cid,me,'manual',null,coalesce(p->'context','{}'),p->>'name');
end $$;

-- Save a definition (null id: a new workflow). A live workflow's change is a new version; runs keep the one they began with.
create function pulse.workflow_save(p_id uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();w workflow;wid uuid;
begin
 if jsonb_typeof(p)<>'object' or jsonb_typeof(p->'definition')<>'object' or jsonb_typeof(p->'definition'->'steps')<>'array' then raise exception 'Describe the workflow and its steps' using errcode='22023';end if;
 if coalesce(btrim(p->>'name'),'')='' then raise exception 'Name the workflow' using errcode='22023';end if;
 if jsonb_typeof(p->'trigger') is distinct from 'object' or p->'trigger'->>'kind' not in ('manual','package','milestone','schedule','form') then raise exception 'Choose how runs start' using errcode='22023';end if;
 if nullif(p->>'sopId','') is not null and not exists(select 1 from sop where org_id=current_org() and id=(p->>'sopId')::uuid) then raise exception 'Choose an SOP' using errcode='22023';end if;
 if nullif(p->>'clientId','') is not null and not exists(select 1 from client where org_id=current_org() and id=(p->>'clientId')::uuid) then raise exception 'Choose a client' using errcode='22023';end if;
 if p_id is null then
  insert into workflow(org_id,name,purpose,sop_id,client_id,definition,trigger,created_by,updated_by)
  values(current_org(),left(btrim(p->>'name'),200),nullif(left(p->>'purpose',2000),''),nullif(p->>'sopId','')::uuid,nullif(p->>'clientId','')::uuid,p->'definition',p->'trigger',me,me) returning id into wid;
  perform audit_write('create','workflow',wid::text);
  return wid;
 end if;
 select * into w from workflow where org_id=current_org() and id=p_id for update;
 if not found then raise exception 'Workflow not found' using errcode='P0002';end if;
 if w.status='archived' then raise exception 'Restore the workflow before changing it' using errcode='22023';end if;
 update workflow set name=left(btrim(p->>'name'),200),purpose=nullif(left(p->>'purpose',2000),''),sop_id=nullif(p->>'sopId','')::uuid,client_id=nullif(p->>'clientId','')::uuid,
  definition=p->'definition',trigger=p->'trigger',updated_by=me,updated_at=now() where id=p_id;
 if w.status in ('live','paused') and (w.definition is distinct from p->'definition' or w.trigger is distinct from p->'trigger') then perform workflow_publish(p_id);end if;
 perform audit_write('update','workflow',p_id::text);
 return p_id;
end $$;

create function pulse.workflow_publish(p_id uuid) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();w workflow;last workflow_version;nv int;
begin
 select * into w from workflow where org_id=current_org() and id=p_id for update;
 if not found then raise exception 'Workflow not found' using errcode='P0002';end if;
 if jsonb_array_length(w.definition->'steps')=0 then raise exception 'A workflow needs at least one step' using errcode='22023';end if;
 select * into last from workflow_version where org_id=current_org() and workflow_id=p_id order by version desc limit 1;
 nv:=case when last.id is null then 1 when last.definition is distinct from w.definition or last.trigger is distinct from w.trigger then last.version+1 else last.version end;
 if last.id is null or nv<>last.version then insert into workflow_version(org_id,workflow_id,version,definition,trigger,published_by) values(current_org(),p_id,nv,w.definition,w.trigger,me);end if;
 update workflow set status=case when status='paused' then 'paused' else 'live' end,version=nv,published_by=me,published_at=now(),
  last_fired_at=case when trigger->>'kind'='schedule' then now() else last_fired_at end where id=p_id;
 perform audit_write('publish','workflow',p_id::text);
 return nv;
end $$;

create function pulse.workflow_set_status(p_id uuid,p_status text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();w workflow;
begin
 if p_status not in ('live','paused','archived','draft') then raise exception 'Choose live, paused, draft or archived' using errcode='22023';end if;
 select * into w from workflow where org_id=current_org() and id=p_id for update;
 if not found then raise exception 'Workflow not found' using errcode='P0002';end if;
 if p_status='live' and w.status<>'paused' then perform workflow_publish(p_id);
 else update workflow set status=p_status,updated_by=me,updated_at=now() where id=p_id;end if;
 perform audit_write(p_status,'workflow',p_id::text);
end $$;

-- An approval or a decision answered: the task is finished with that answer (whoever may finish it may answer).
create function pulse.workflow_step_decide(p_step uuid,p_choice text,p_note text default null) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();st workflow_run_step;r workflow_run;
begin
 select * into st from workflow_run_step where org_id=current_org() and id=p_step for update;
 if not found or not workflow_run_visible(st.run_id) then raise exception 'Step not found' using errcode='P0002';end if;
 if st.status<>'active' or st.kind not in ('approval','decision') then raise exception 'This step is not waiting for an answer' using errcode='22023';end if;
 select * into r from workflow_run where id=st.run_id;
 if coalesce(btrim(p_choice),'')='' then raise exception 'Choose an answer' using errcode='22023';end if;
 if not (sop_editor() or me=r.started_by or (st.task_id is not null and task_can_edit(st.task_id)) or work_project_can_manage(r.project_id)) then
  raise exception 'The person doing this step, whoever started the run or leadership answers it' using errcode='42501';end if;
 update workflow_run_step set outcome=left(btrim(p_choice),80),note=nullif(left(btrim(coalesce(p_note,'')),500),'') where id=p_step;
 if st.task_id is not null and exists(select 1 from task where id=st.task_id and status not in ('done','accepted','cancelled')) then
  perform task_move(st.task_id,'done',left(btrim(p_choice)||coalesce(': '||nullif(btrim(p_note),''),''),300));
 else perform workflow_step_finish(p_step,btrim(p_choice));end if;
 perform audit_write('decide','workflow_run_step',p_step::text);
end $$;

create function pulse.workflow_run_cancel(p_run uuid,p_note text default null) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();r workflow_run;s record;
begin
 select * into r from workflow_run where org_id=current_org() and id=p_run for update;
 if not found or not workflow_run_visible(p_run) then raise exception 'Run not found' using errcode='P0002';end if;
 if r.status<>'running' then raise exception 'This run has finished' using errcode='22023';end if;
 if not (sop_editor() or me=r.started_by or work_project_can_manage(r.project_id)) then raise exception 'Whoever started the run or leadership stops it' using errcode='42501';end if;
 update workflow_run set status='cancelled',finished_at=now(),cancelled_by=me,cancel_note=nullif(left(btrim(coalesce(p_note,'')),500),'') where id=p_run;
 for s in select st.id,st.task_id from workflow_run_step st join task t on t.id=st.task_id where st.run_id=p_run and st.status='active' and t.status not in ('done','accepted','cancelled') loop
  update task set status='cancelled',updated_at=now(),edited_by=me where id=s.task_id;
  perform task_event_add(s.task_id,'status',null,'cancelled','The workflow run was stopped');
 end loop;
 update workflow_run_step set status='cancelled',done_at=now() where run_id=p_run and status in ('active','waiting');
 perform audit_write('cancel','workflow_run',p_run::text);
end $$;

-- Finishing a step's task moves the run on, whichever way the task was finished.
create function pulse.workflow_task_follow() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare st workflow_run_step;
begin
 if new.source<>'workflow' or new.status is not distinct from old.status then return null;end if;
 select * into st from workflow_run_step where org_id=new.org_id and task_id=new.id and status='active';
 if not found then return null;end if;
 if new.status in ('done','accepted') then
  begin perform workflow_step_finish(st.id,st.outcome);
  exception when others then raise warning 'workflow step % did not move on: %',st.id,sqlerrm;
   update workflow_run_step set note='Could not move on: '||left(sqlerrm,200) where id=st.id;end;
 elsif new.status='cancelled' then update workflow_run_step set note=coalesce(note,'Its task was cancelled') where id=st.id;
 end if;
 return null;
end $$;
create trigger workflow_task_follow after update of status on pulse.task for each row execute function pulse.workflow_task_follow();

-- Triggers: a client package made in Pulse (or imported, when the workflow says so) and milestones.
create function pulse.workflow_on_package() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare w workflow;
begin
 if new.kind is distinct from 'client_work' then return null;end if;
 for w in select * from workflow where org_id=new.org_id and status='live' and trigger->>'kind'='package' and (client_id is null or client_id=new.client_id)
   and (current_viewer() is not null or coalesce((trigger->>'imported')::boolean,false)) loop
  begin perform workflow_start_as(w.id,new.id,new.client_id,coalesce(current_viewer(),w.published_by),'package',new.id::text,'{}');
  exception when others then raise warning 'workflow % did not start for project %: %',w.id,new.id,sqlerrm;end;
 end loop;
 return null;
end $$;
create trigger workflow_on_package after insert on pulse.project for each row execute function pulse.workflow_on_package();
create function pulse.workflow_on_milestone() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare w workflow;pid uuid;j jsonb;
begin
 -- One function for tasks and work projects: fields are read through to_jsonb(new) (a task has a category, a work project not).
 j:=to_jsonb(new);pid:=(j->>'project_id')::uuid;
 if pid is null or not exists(select 1 from workflow where org_id=new.org_id and status='live' and trigger->>'kind'='milestone') then return null;end if;
 for w in select * from workflow where org_id=new.org_id and status='live' and trigger->>'kind'='milestone'
   and ((TG_TABLE_NAME='task' and trigger->>'category'=j->>'category') or (TG_TABLE_NAME='work_project' and trigger->>'projectStatus'=j->>'status')) loop
  if not exists(select 1 from workflow_run where org_id=new.org_id and workflow_id=w.id and project_id=pid and started_via='milestone' and status<>'cancelled') then
   begin perform workflow_start_as(w.id,pid,null,coalesce(current_viewer(),w.published_by),'milestone',case when TG_TABLE_NAME='task' then 'task:'||(j->>'id') else 'status:'||(j->>'status') end,'{}');
   exception when others then raise warning 'workflow % did not start for project %: %',w.id,pid,sqlerrm;end;
  end if;
 end loop;
 return null;
end $$;
create trigger workflow_on_milestone after update of status on pulse.task for each row
 when (new.status in ('done','accepted') and old.status not in ('done','accepted') and new.project_id is not null) execute function pulse.workflow_on_milestone();
create trigger workflow_on_milestone after update of status on pulse.work_project for each row when (new.status is distinct from old.status) execute function pulse.workflow_on_milestone();

-- Is a schedule's slot due ({every: day|week|month, at: "HH:MM", weekday: 1-7, day: 1-28}, India time)?
create function pulse.workflow_schedule_due(p_trigger jsonb,p_last timestamptz,p_now timestamptz) returns boolean language plpgsql stable as $$
declare today date:=(p_now at time zone 'Asia/Kolkata')::date;v_at time:=coalesce(nullif(p_trigger->>'at','')::time,'09:00');slot date;
begin
 slot:=case coalesce(p_trigger->>'every','week')
  when 'day' then today
  when 'week' then today-((extract(isodow from today)::int-coalesce(nullif(p_trigger->>'weekday','')::int,1)+7)%7)
  else case when extract(day from today)>=coalesce(nullif(p_trigger->>'day','')::int,1) then date_trunc('month',today)::date+coalesce(nullif(p_trigger->>'day','')::int,1)-1
   else (date_trunc('month',today)-interval '1 month')::date+coalesce(nullif(p_trigger->>'day','')::int,1)-1 end end;
 return p_now>=(slot+v_at) at time zone 'Asia/Kolkata' and (p_last is null or p_last<(slot+v_at) at time zone 'Asia/Kolkata');
exception when others then return false;
end $$;

-- Each minute (the notification worker): waits that are over, steps past their SLA (the doer and whoever started the run
-- are told once), and schedules that are due.
create function pulse.workflow_tick(p_now timestamptz default now()) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s record;w workflow;waits int:=0;late int:=0;sched int:=0;
begin
 for s in select st.id from workflow_run_step st join workflow_run r on r.id=st.run_id where st.org_id=current_org() and st.kind='wait' and st.status='active' and st.due_at<=p_now and r.status='running' loop
  perform workflow_step_finish(s.id,null);waits:=waits+1;
 end loop;
 for s in select st.id,st.run_id,st.title,r.started_by,coalesce(t.assignee_person_id,t.owner_id) doer from workflow_run_step st join workflow_run r on r.id=st.run_id left join task t on t.id=st.task_id
   where st.org_id=current_org() and st.status='active' and st.kind<>'wait' and st.due_at<p_now and st.late_at is null and r.status='running' loop
  update workflow_run_step set late_at=p_now where id=s.id;
  perform workflow_notify(s.doer,'workflow.late',s.run_id,s.id||':late','Past its SLA: '||left(s.title,120));
  if s.started_by is distinct from s.doer then perform workflow_notify(s.started_by,'workflow.late',s.run_id,s.id||':late','Past its SLA: '||left(s.title,120));end if;
  late:=late+1;
 end loop;
 for w in select * from workflow where org_id=current_org() and status='live' and trigger->>'kind'='schedule' loop
  if workflow_schedule_due(w.trigger,w.last_fired_at,p_now) then
   update workflow set last_fired_at=p_now where id=w.id;
   perform workflow_start_as(w.id,nullif(w.trigger->>'projectId','')::uuid,w.client_id,w.published_by,'schedule',to_char(p_now at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI'),'{}');
   sched:=sched+1;
  end if;
 end loop;
 return jsonb_build_object('waits',waits,'late',late,'scheduled',sched);
end $$;

-- Notifications: a step past its SLA and a finished run, to the doer and whoever started the run.
alter table pulse.notification drop constraint notification_subject_type_check;
alter table pulse.notification add constraint notification_subject_type_check check(subject_type in ('person','message','hr_flow','task','policy','holiday','payroll_notice','project','work_ask','comment','work_domain','kudos','workflow_run'));
alter table pulse.notification drop constraint notification_event_type_check;
alter table pulse.notification add constraint notification_event_type_check check(event_type in ('update.self','chat.message','chat.mention','chat.reply','policy.published','holiday.announced',
 'task.assigned','task.blocked','task.unblocked','task.due_soon','task.done','task.accepted','task.ask','project.ask','ask.answered',
 'task.mention','project.mention','task.comment','project.comment','project.added','task.update',
 'domain.proposed','domain.answered','domain.policy','domain.ended','pool.claimed','pool.match',
 'leave.decision','request.updated','request.decision','approval.waiting','approval.reminder','payroll.processed',
 'attendance.start','attendance.end','attendance.done','attendance.departure','attendance.confirmed','attendance.arrival','attendance.break','attendance.nudge',
 'profile.reminder','kudos.received','people.bank','people.change','profile.bank','profile.changed','workflow.late','workflow.done'));
do $$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 changed:=replace(definition,' elsif p_type=''policy.published'' then',
 ' elsif p_type in (''workflow.late'',''workflow.done'') then
  return p_subject=''workflow_run'' and exists(select 1 from workflow_run r where r.org_id=current_org() and r.id=p_id and (r.started_by=p_person
   or exists(select 1 from workflow_run_step s join task t on t.id=s.task_id where s.run_id=r.id and p_person in (t.assignee_person_id,t.owner_id))));
 elsif p_type=''policy.published'' then');
 if changed=definition then raise exception 'notification_recipient_allowed changed shape'; end if;
 execute changed;
end $$;

revoke all on function pulse.workflow_run_visible(uuid),pulse.workflow_edges(jsonb),pulse.workflow_cond(jsonb,jsonb),pulse.workflow_role_people(text),pulse.workflow_open_load(uuid),
 pulse.workflow_pick(jsonb,text,text,pulse.workflow_run),pulse.workflow_def_step(jsonb,text),pulse.workflow_notify(uuid,text,uuid,text,text),pulse.workflow_step_activate(uuid),
 pulse.workflow_arrive(uuid,text,boolean),pulse.workflow_settle(uuid),pulse.workflow_step_finish(uuid,text),pulse.workflow_start_as(uuid,uuid,uuid,uuid,text,text,jsonb,text),
 pulse.workflow_can_start(uuid),pulse.workflow_start(uuid,jsonb),pulse.workflow_save(uuid,jsonb),pulse.workflow_publish(uuid),pulse.workflow_set_status(uuid,text),
 pulse.workflow_step_decide(uuid,text,text),pulse.workflow_run_cancel(uuid,text),pulse.workflow_schedule_due(jsonb,timestamptz,timestamptz),pulse.workflow_tick(timestamptz) from public;
grant execute on function pulse.workflow_run_visible(uuid),pulse.workflow_edges(jsonb),pulse.workflow_role_people(text),pulse.workflow_open_load(uuid),pulse.workflow_can_start(uuid),
 pulse.workflow_start(uuid,jsonb),pulse.workflow_save(uuid,jsonb),pulse.workflow_publish(uuid),pulse.workflow_set_status(uuid,text),pulse.workflow_step_decide(uuid,text,text),
 pulse.workflow_run_cancel(uuid,text),pulse.workflow_cond(jsonb,jsonb) to pulse_api;
grant execute on function pulse.workflow_tick(timestamptz),pulse.workflow_edges(jsonb) to pulse_worker;

-- migrate:down
-- Forward-only: workflows, their versions and runs are kept.
