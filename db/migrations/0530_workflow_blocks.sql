-- migrate:up
-- WORKFLOW BUILDER (owner, 18 Oct 2026: "entire workflows have to be customizable ... like n8n or Zapier, we add another
-- block and connect Leads Capture to the next one ... the workflow can connect to another employee's first item ...
-- test new workflows like real employees on real data"). Built on SOP-WORKFLOW (0241, 0242), not beside it:
--  * A block is a workflow step with a module (Lead capture, Sales X-Ray, Quotation, Site visit, ...), a place on the
--    canvas and wires from its output ports (definition `module`, `pos`, `next[].port`; workflow-blocks.ts checks the port
--    types). The SOP inside a block is the step's checklist (its `detail` lines); a run step keeps which lines are ticked.
--  * pulse.workflow_board: workflows side by side as tabs, one per person's or role's job. A Hand-off block starts the run
--    of another tab with the same project, client and values, so the work moves from one person's tab to the next.
--  * Test runs (workflow_run.mode = 'test') follow the workflow as it is now (a draft too) on a copy of a real record's
--    values: each block shows who it would go to by the usual rules, and the tester moves it on as that person. A test
--    run makes no task and sends nothing (no notification, no form, no webhook).
--  * Lead capture and From hand-off blocks start a run and finish by themselves; Notify and App or webhook blocks are
--    honest stubs (they finish and record that nothing was sent).

create table pulse.workflow_board (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 name text not null check(length(btrim(name)) between 1 and 200),purpose text check(length(purpose)<=2000),
 status text not null default 'active' check(status in ('active','archived')),
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now()
);
create index workflow_board_status on pulse.workflow_board(org_id,status);
alter table pulse.workflow add column board_id uuid references pulse.workflow_board(id),add column board_position int,
 add column tab_person_id uuid references pulse.person(id),add column tab_role text check(length(tab_role)<=80);
create index workflow_board_tabs on pulse.workflow(org_id,board_id,board_position) where board_id is not null;

alter table pulse.workflow_run add column mode text not null default 'live' check(mode in ('live','test')),
 add column parent_run_id uuid references pulse.workflow_run(id),add column parent_step_id uuid references pulse.workflow_run_step(id);
alter table pulse.workflow_run drop constraint workflow_run_started_via_check;
alter table pulse.workflow_run add constraint workflow_run_started_via_check check(started_via in ('manual','package','milestone','schedule','form','handoff'));
create index workflow_run_test on pulse.workflow_run(org_id,workflow_id,started_at desc) where mode='test';
create index workflow_run_parent on pulse.workflow_run(org_id,parent_run_id) where parent_run_id is not null;
alter table pulse.workflow_run_step add column test_person uuid references pulse.person(id),add column checks int[] not null default '{}';
create index workflow_run_step_test_person on pulse.workflow_run_step(org_id,test_person) where status='active' and test_person is not null;

do $$ begin
 alter table pulse.workflow_board enable row level security;
 alter table pulse.workflow_board force row level security;
 create policy tenant_isolation on pulse.workflow_board using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
 grant select on pulse.workflow_board to pulse_api;
 grant select,insert,update on pulse.workflow_board to pulse_worker;
 create trigger audit_mutation after insert or update on pulse.workflow_board for each row execute function pulse.audit_mutation();
end $$;
create policy workflow_board_read on pulse.workflow_board as restrictive for select to pulse_api using(pulse.current_viewer() is not null and (status='active' or pulse.sop_editor()));

-- A board: its name and what it is for (null id: a new one). Leadership and admins design.
create function pulse.workflow_board_save(p_id uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();bid uuid;
begin
 if jsonb_typeof(p) is distinct from 'object' or coalesce(btrim(p->>'name'),'')='' then raise exception 'Name the board' using errcode='22023';end if;
 if p_id is null then
  insert into workflow_board(org_id,name,purpose,created_by,updated_by) values(current_org(),left(btrim(p->>'name'),200),nullif(left(btrim(coalesce(p->>'purpose','')),2000),''),me,me)
  returning id into bid;
  perform audit_write('create','workflow_board',bid::text);
  return bid;
 end if;
 update workflow_board set name=left(btrim(p->>'name'),200),purpose=nullif(left(btrim(coalesce(p->>'purpose','')),2000),''),
  status=case when p->>'status' in ('active','archived') then p->>'status' else status end,updated_by=me,updated_at=now()
  where org_id=current_org() and id=p_id;
 if not found then raise exception 'Board not found' using errcode='P0002';end if;
 perform audit_write('update','workflow_board',p_id::text);
 return p_id;
end $$;

-- A workflow as a tab of a board (or off it): its place and whose job it is (a person, a role, or both).
create function pulse.workflow_board_tab(p_workflow uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();bid uuid:=nullif(p->>'boardId','')::uuid;pid uuid:=nullif(p->>'personId','')::uuid;pos int:=nullif(p->>'position','')::int;
begin
 if bid is not null and not exists(select 1 from workflow_board where org_id=current_org() and id=bid) then raise exception 'Board not found' using errcode='P0002';end if;
 if pid is not null and not exists(select 1 from person where org_id=current_org() and id=pid and side='staff') then raise exception 'Choose someone in the team' using errcode='22023';end if;
 update workflow set board_id=bid,
  board_position=case when bid is null then null else coalesce(pos,(select coalesce(max(x.board_position),0)+1 from workflow x where x.org_id=current_org() and x.board_id=bid and x.id<>p_workflow)) end,
  tab_person_id=pid,tab_role=nullif(left(btrim(coalesce(p->>'role','')),80),''),updated_by=me,updated_at=now()
  where org_id=current_org() and id=p_workflow;
 if not found then raise exception 'Workflow not found' using errcode='P0002';end if;
 perform audit_write('tab','workflow',p_workflow::text);
end $$;

-- Start a run. Live: the published version, through workflow_start_as (tasks, notifications). Test: the workflow as it is
-- now (a draft too), no tasks, nothing sent. A hand-off names the run and step it came from.
create function pulse.workflow_begin(p_workflow uuid,p_project uuid,p_client uuid,p_starter uuid,p_via text,p_ref text,p_context jsonb,p_name text,p_mode text,
 p_parent uuid default null,p_parent_step uuid default null) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare w workflow;rid uuid;first_step record;label text;
begin
 if p_mode='live' then
  rid:=workflow_start_as(p_workflow,p_project,p_client,p_starter,p_via,p_ref,p_context,p_name);
  update workflow_run set parent_run_id=p_parent,parent_step_id=p_parent_step where id=rid;
  return rid;
 end if;
 select * into w from workflow where org_id=current_org() and id=p_workflow;
 if not found or w.status='archived' then raise exception 'This workflow is not available' using errcode='22023';end if;
 if jsonb_array_length(w.definition->'steps')=0 then raise exception 'This workflow has no steps' using errcode='22023';end if;
 label:=coalesce(nullif(btrim(p_name),''),(select coalesce(pr.title,pr.name) from project pr where pr.id=p_project),(select display_name from client where id=coalesce(p_client,w.client_id)),w.name);
 insert into workflow_run(org_id,workflow_id,version,definition,name,project_id,client_id,context,started_by,authority,started_via,trigger_ref,mode,parent_run_id,parent_step_id)
 values(current_org(),w.id,w.version,w.definition,left(label,300),p_project,coalesce(p_client,w.client_id,(select client_id from project where id=p_project)),coalesce(p_context,'{}'),
  p_starter,p_starter,p_via,left(p_ref,200),'test',p_parent,p_parent_step) returning id into rid;
 -- As workflow_start_as: the steps, how many forward connections lead into each, then the steps nothing leads to.
 insert into workflow_run_step(org_id,run_id,step_key,position,title,kind,sla_hours)
 select current_org(),rid,x->>'id',i::int,left(coalesce(nullif(btrim(x->>'title'),''),'Step '||i),300),coalesce(nullif(x->>'kind',''),'task'),nullif(x->>'slaHours','')::numeric
  from jsonb_array_elements(w.definition->'steps') with ordinality t(x,i);
 update workflow_run_step s set in_total=(select count(*) from workflow_edges(w.definition) e where e.to_key=s.step_key and
   (select x.i from (select y->>'id' id,j i from jsonb_array_elements(w.definition->'steps') with ordinality q(y,j)) x where x.id=e.from_key)<s.position)
  where s.run_id=rid;
 perform audit_write('start','workflow_run',rid::text);
 for first_step in select id from workflow_run_step where run_id=rid and in_total=0 order by position loop perform workflow_step_activate(first_step.id);end loop;
 if not exists(select 1 from workflow_run_step where run_id=rid and status<>'waiting') then
  perform workflow_step_activate((select id from workflow_run_step where run_id=rid order by position limit 1));
 end if;
 return rid;
end $$;

-- A Hand-off block: the run of the tab it names starts with this run's project, client and values (and the same mode).
-- Hand-offs that start each other at once (no person in between) are counted in the transaction, because a run's
-- parent is written only after its first blocks have started; past 20 the chain stops.
create function pulse.workflow_handoff(p_step uuid) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare st workflow_run_step;r workflow_run;d jsonb;target uuid;tname text;rid uuid;depth int;nested int:=coalesce(nullif(current_setting('pulse.handoff_depth',true),'')::int,0);
begin
 select * into st from workflow_run_step where id=p_step;
 select * into r from workflow_run where id=st.run_id;
 d:=workflow_def_step(r.definition,st.step_key);
 target:=case when d->'handoff'->>'workflowId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (d->'handoff'->>'workflowId')::uuid end;
 select name into tname from workflow where org_id=current_org() and id=target and id<>r.workflow_id;
 if tname is null then raise exception 'Choose the workflow this hand-off passes the work to' using errcode='22023';end if;
 -- A chain of hand-offs that comes back on itself stops after 20 runs.
 with recursive up(id,parent,n) as (select r.id,r.parent_run_id,1 union all select x.id,x.parent_run_id,up.n+1 from workflow_run x join up on x.id=up.parent where up.n<25)
 select max(n) into depth from up;
 if depth>=20 or nested>=20 then raise exception 'These hand-offs go round in a circle: stop one of them' using errcode='22023';end if;
 perform set_config('pulse.handoff_depth',(nested+1)::text,true);
 rid:=workflow_begin(target,r.project_id,r.client_id,coalesce(r.started_by,r.authority),'handoff',r.id::text,
  r.context||jsonb_build_object('handoff.from',(select name from workflow where id=r.workflow_id),'handoff.step',st.title),r.name,r.mode,r.id,st.id);
 perform set_config('pulse.handoff_depth',nested::text,true);
 update workflow_run_step set note=left('Handed over to “'||tname||'”',500) where id=p_step;
 return rid;
end $$;

-- The step a run reaches. Live runs keep the task engine (0241, 0242), now workflow_step_activate_task; the blocks that
-- need no person finish at once; a test run's person block only records who it would go to.
alter function pulse.workflow_step_activate(uuid) rename to workflow_step_activate_task;
create function pulse.workflow_step_activate(p_step uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare st workflow_run_step;r workflow_run;d jsonb;m text;pick record;chosen int;v_sla numeric;v_cat text;
begin
 select * into st from workflow_run_step where id=p_step;
 select * into r from workflow_run where id=st.run_id;
 if not found or r.status<>'running' then return;end if;
 -- A step that starts again (sent back, or a loop) starts with its checklist unticked.
 if st.checks<>'{}' then update workflow_run_step set checks='{}' where id=p_step;end if;
 d:=workflow_def_step(r.definition,st.step_key);m:=coalesce(d->>'module','');
 if r.mode='live' and m not in ('lead_capture','handoff_in','handoff','notify','webhook') then perform workflow_step_activate_task(p_step);return;end if;
 v_sla:=nullif(d->>'slaHours','')::numeric;
 update workflow_run_step set status='active',started_at=now(),done_at=null,late_at=null,rounds=rounds+1,in_done=0,in_taken=0,
  due_at=case when st.kind='wait' then now()+make_interval(mins=>round(coalesce(nullif(d->>'waitHours','')::numeric,v_sla,24)*60)::int)
   when v_sla is not null then now()+make_interval(mins=>round(v_sla*60)::int) end where id=p_step;
 if st.kind='end' then perform workflow_step_finish(p_step,null);return;end if;
 if st.kind='wait' then return;end if;
 if st.kind='decision' and exists(select 1 from workflow_edges(r.definition) x where x.from_key=st.step_key and x.cond is not null) then
  select x.ord into chosen from workflow_edges(r.definition) x where x.from_key=st.step_key and (x.cond is null or workflow_cond(x.cond,r.context))
   order by (x.cond is null),x.ord limit 1;
  if chosen is not null then perform workflow_step_finish(p_step,'#'||chosen);return;end if;
 end if;
 if m in ('lead_capture','handoff_in') then perform workflow_step_finish(p_step,null);return;end if;
 -- A hand-off that cannot start the other tab (not live, not chosen, a circle) waits here with the reason, so the
 -- block before it still finishes and the minute tick goes on; workflow_step_retry tries again once it is fixed.
 if m='handoff' then
  begin perform workflow_handoff(p_step);
  exception when others then update workflow_run_step set note=left('Could not hand over: '||sqlerrm,500) where id=p_step;return;
  end;
  perform workflow_step_finish(p_step,null);return;
 end if;
 if m in ('notify','webhook') then
  update workflow_run_step set note=case when r.mode='test' then 'Test run: nothing was sent' else 'Not sent: this block is not connected yet' end where id=p_step;
  perform workflow_step_finish(p_step,null);return;
 end if;
 -- A test run: who the block would go to, by the same rules as a live run; no task, nothing sent.
 v_cat:=coalesce((select key from work_category where org_id=current_org() and key=nullif(d->>'category','') and active),work_category_guess(st.title));
 select * into pick from workflow_pick(coalesce(d->'assign','{}'::jsonb),d->>'role',v_cat,r);
 update workflow_run_step set test_person=pick.person,assign_why=left(coalesce(pick.why,'')||case when pick.pool_scope is not null then '; the tester takes it from the pool' else '' end,300) where id=p_step;
end $$;

-- Test runs send nothing: no "late" or "done" notifications either.
create or replace function pulse.workflow_notify(p_person uuid,p_type text,p_run uuid,p_key text,p_title text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if p_person is null or exists(select 1 from workflow_run where id=p_run and mode='test') then return;end if;
 perform notification_emit(p_person,p_type,'workflow_run',p_run,left(p_key,200),left(p_title,160),'/sops/runs/'||p_run,'task');
end $$;

-- Leadership (or whoever started it) starts a test run on a project or client: the API passes a copy of its values.
create function pulse.workflow_test_start(p_workflow uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();pid uuid:=nullif(p->>'projectId','')::uuid;cid uuid:=nullif(p->>'clientId','')::uuid;
begin
 if not exists(select 1 from workflow where org_id=current_org() and id=p_workflow) then raise exception 'Workflow not found' using errcode='P0002';end if;
 if pid is not null and not exists(select 1 from project where org_id=current_org() and id=pid) then raise exception 'Choose a project' using errcode='22023';end if;
 if cid is not null and not exists(select 1 from client where org_id=current_org() and id=cid) then raise exception 'Choose a client' using errcode='22023';end if;
 return workflow_begin(p_workflow,pid,cid,me,'manual','test',case when jsonb_typeof(p->'context')='object' then p->'context' else '{}' end,p->>'name','test');
end $$;

-- A test run's block moved on by the tester, as the person it would go to: an answer for approvals and decisions, and
-- the values the block gives out (they join the run's values as "<block>.<field>").
create function pulse.workflow_test_done(p_step uuid,p_choice text,p_values jsonb default null) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();st workflow_run_step;r workflow_run;c text:=nullif(btrim(coalesce(p_choice,'')),'');
begin
 select * into st from workflow_run_step where org_id=current_org() and id=p_step for update;
 if not found or not workflow_run_visible(st.run_id) then raise exception 'Step not found' using errcode='P0002';end if;
 select * into r from workflow_run where id=st.run_id;
 if r.mode<>'test' then raise exception 'A live step moves on when its task is done' using errcode='22023';end if;
 if not (sop_editor() or me=r.started_by) then raise exception 'Whoever started the test or leadership moves it on' using errcode='42501';end if;
 if st.status<>'active' or r.status<>'running' then raise exception 'This step is not waiting' using errcode='22023';end if;
 if st.kind in ('approval','decision') and c is null then raise exception 'Choose an answer' using errcode='22023';end if;
 if jsonb_typeof(p_values)='object' then
  update workflow_run set context=context||coalesce((select jsonb_object_agg(st.step_key||'.'||left(k,40),v) from jsonb_each(p_values) e(k,v)),'{}') where id=r.id;
 end if;
 update workflow_run_step set outcome=left(c,80) where id=p_step;
 perform workflow_step_finish(p_step,c);
 perform audit_write('test','workflow_run_step',p_step::text);
end $$;

-- A line of a block's checklist ticked (or not) by whoever does the step; in a test run, by the tester.
create function pulse.workflow_step_check(p_step uuid,p_index int,p_done boolean) returns int[] language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();st workflow_run_step;r workflow_run;v_checks int[];
begin
 select * into st from workflow_run_step where org_id=current_org() and id=p_step for update;
 if not found or not workflow_run_visible(st.run_id) then raise exception 'Step not found' using errcode='P0002';end if;
 select * into r from workflow_run where id=st.run_id;
 if st.status<>'active' then raise exception 'This step is not waiting' using errcode='22023';end if;
 if p_index is null or p_index<0 or p_index>=40 then raise exception 'Choose a line of the checklist' using errcode='22023';end if;
 if not (sop_editor() or me=r.started_by or (r.mode='live' and st.task_id is not null and (task_can_edit(st.task_id)
   or exists(select 1 from task t where t.id=st.task_id and me in (t.assignee_person_id,t.owner_id))))) then
  raise exception 'Whoever does this step ticks its checklist' using errcode='42501';end if;
 update workflow_run_step set checks=case when p_done then (select coalesce(array_agg(distinct x order by x),'{}') from unnest(checks||p_index) x) else array_remove(checks,p_index) end
  where id=p_step returning checks into v_checks;
 return v_checks;
end $$;

-- Leadership tries a waiting hand-off again (after publishing the tab it passes the work to).
create function pulse.workflow_step_retry(p_step uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();st workflow_run_step;r workflow_run;
begin
 select * into st from workflow_run_step where org_id=current_org() and id=p_step for update;
 if not found or not workflow_run_visible(st.run_id) then raise exception 'Step not found' using errcode='P0002';end if;
 select * into r from workflow_run where id=st.run_id;
 if st.status<>'active' or r.status<>'running' or coalesce(workflow_def_step(r.definition,st.step_key)->>'module','')<>'handoff' then
  raise exception 'Only a waiting hand-off is tried again' using errcode='22023';end if;
 perform workflow_step_activate(p_step);
 -- Still waiting: the reason is the answer (and this attempt is not kept).
 select * into st from workflow_run_step where id=p_step;
 if st.status='active' then raise exception '%',coalesce(st.note,'Could not hand over') using errcode='22023';end if;
 perform audit_write('retry','workflow_run_step',p_step::text);
end $$;

revoke all on function pulse.workflow_step_retry(uuid) from public;
grant execute on function pulse.workflow_step_retry(uuid) to pulse_api;
revoke all on function pulse.workflow_board_save(uuid,jsonb),pulse.workflow_board_tab(uuid,jsonb),pulse.workflow_begin(uuid,uuid,uuid,uuid,text,text,jsonb,text,text,uuid,uuid),
 pulse.workflow_handoff(uuid),pulse.workflow_step_activate(uuid),pulse.workflow_notify(uuid,text,uuid,text,text),pulse.workflow_test_start(uuid,jsonb),
 pulse.workflow_test_done(uuid,text,jsonb),pulse.workflow_step_check(uuid,int,boolean) from public;
grant execute on function pulse.workflow_board_save(uuid,jsonb),pulse.workflow_board_tab(uuid,jsonb),pulse.workflow_test_start(uuid,jsonb),pulse.workflow_test_done(uuid,text,jsonb),
 pulse.workflow_step_check(uuid,int,boolean) to pulse_api;

-- migrate:down
-- Forward-only: boards, test runs and ticked checklists are kept.
