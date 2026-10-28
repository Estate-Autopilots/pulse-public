-- migrate:up
-- FLOW-D (owner, 21 Oct 2026: "can there not be blocks that are just the primitives of all?"; "things have to really
-- work and automate"). The engine of 0800 stays; this adds what the primitives need:
--  * pulse.flow_block: company blocks, a company's saved, named presets of a primitive (title, checklist, write-up
--    part, template, who, due), shown under "Your company's blocks" and made with "Save as a block" from any step.
--  * Readiness: a step skipped for this run (a variant) passes through what the steps before it say, so the step after
--    it still waits for them; a step skipped on a way not chosen passes that on (every later step of that way is
--    skipped too, not opened).
--  * Decide by a rule: a Decide step with a rule on an earlier answer or a field decides by itself when it opens.
--  * Message: the text names the run's values ({run}, {client}, {project}, a field's key or label); who was told is
--    kept on the run (a 'notice' event), in Try-it and demo runs too, where nobody real is told.
--  * Wait until a date field of the run (the worker's tick).
--  * Start by itself: a new lead (pulse.lead), a form sent (Collect / field forms), or a schedule (the tick).
--  * Collect through a field form: a submission can belong to a Flow step; sending it finishes the step with its
--    answers, place and time.
--  * Try it: a run in mode 'try' behaves as a demo (no task, no notification to anyone) and is thrown away afterwards.

create table pulse.flow_block (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 key text not null check(key ~ '^[a-z0-9][a-z0-9_-]{0,59}$'),name text not null check(length(btrim(name)) between 1 and 120),
 summary text check(length(summary)<=500),block text not null check(block in ('start','task','collect','meet','write','review','decide','wait','message','ai','app','repeat','end')),
 preset jsonb not null check(jsonb_typeof(preset)='object' and pg_column_size(preset)<200000),source text check(length(source)<=80),
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 archived_at timestamptz
);
create unique index flow_block_key on pulse.flow_block(org_id,key) where archived_at is null;
alter table pulse.flow_block enable row level security;
alter table pulse.flow_block force row level security;
create policy tenant_isolation on pulse.flow_block using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update on pulse.flow_block to pulse_api;
grant select on pulse.flow_block to pulse_worker;
create policy flow_read on pulse.flow_block as restrictive for select to pulse_api using(pulse.flow_staff());
create trigger audit_mutation after insert or update on pulse.flow_block for each row execute function pulse.audit_mutation();

alter table pulse.flow_process add column auto_at timestamptz;
alter table pulse.flow_run drop constraint flow_run_mode_check;
alter table pulse.flow_run add constraint flow_run_mode_check check(mode in ('live','demo','try'));
alter table pulse.flow_step_event drop constraint flow_step_event_kind_check;
alter table pulse.flow_step_event add constraint flow_step_event_kind_check check(kind in ('state','value','input','alert','nudge','assign','blocked','unblocked','clock','verdict','start','cancel','hours','notice'));
alter table pulse.form_submission add column flow_step_id uuid references pulse.flow_run_step(id);
create index form_submission_flow_step on pulse.form_submission(org_id,flow_step_id) where flow_step_id is not null;

-- ---------------------------------------------------------------------------------------------------------------------
-- Readiness. What one wire's source says: got (its value is there), pending (still to come), dead (finished without it:
-- a way not chosen, or skipped on that way), skip (skipped for this run with nothing before it to wait for). A step a
-- variant skipped passes through what the steps before it say.
create function pulse.flow_wire_state(p_run uuid,p_step text,p_port text,p_depth int default 0) returns text language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare s flow_run_step;r flow_run;v_w jsonb;v_x text;v_got boolean:=false;v_dead boolean:=false;
begin
 select * into s from flow_run_step where run_id=p_run and step_key=p_step;
 if not found then return 'skip';end if;
 if s.state='done' then
  return case when exists(select 1 from flow_value v where v.run_id=p_run and v.step_key=p_step and v.port=p_port and v.side='makes') then 'got' else 'dead' end;
 elsif s.state<>'skipped' then return 'pending';
 elsif s.skipped_why='Not on the way chosen' then return 'dead';
 end if;
 if p_depth>60 then return 'skip';end if;
 select * into r from flow_run where id=p_run;
 for v_w in select x from jsonb_array_elements(coalesce(r.definition->'wires','[]')) x where x->'to'->>'step'=p_step loop
  if not coalesce((select (n->>'required')::boolean from jsonb_array_elements(coalesce(r.compiled->'steps'->p_step->'needs','[]')) n where n->>'key'=v_w->'to'->>'port' limit 1),false) then continue;end if;
  v_x:=flow_wire_state(p_run,v_w->'from'->>'step',v_w->'from'->>'port',p_depth+1);
  if v_x='pending' then return 'pending';elsif v_x='got' then v_got:=true;elsif v_x='dead' then v_dead:=true;end if;
 end loop;
 return case when v_got then 'got' when v_dead then 'dead' else 'skip' end;
end $$;

-- Is a step ready? 'ready': every required Needs port is filled; 'dead': a required need can only come from a way not
-- chosen, so the step is skipped; 'waiting' otherwise.
create or replace function pulse.flow_step_readiness(p_run uuid,p_key text) returns text language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare r flow_run;v_n jsonb;v_w jsonb;v_x text;v_has boolean;v_direct boolean;v_many boolean;v_wired int;v_got int;v_pending int;v_dead int;
begin
 select * into r from flow_run where id=p_run;
 for v_n in select x from jsonb_array_elements(coalesce(r.compiled->'steps'->p_key->'needs','[]')) x loop
  if not coalesce((v_n->>'required')::boolean,true) then continue;end if;
  v_many:=coalesce((v_n->>'many')::boolean,false);
  v_has:=exists(select 1 from flow_value v where v.run_id=p_run and v.step_key=p_key and v.port=v_n->>'key' and v.side='needs');
  v_direct:=exists(select 1 from jsonb_array_elements(coalesce(flow_def_step(r.definition,p_key)->'inputs','[]')) i where i->>'port'=v_n->>'key');
  v_wired:=0;v_got:=0;v_pending:=0;v_dead:=0;
  for v_w in select x from jsonb_array_elements(coalesce(r.definition->'wires','[]')) x where x->'to'->>'step'=p_key and x->'to'->>'port'=v_n->>'key' loop
   v_wired:=v_wired+1;
   v_x:=flow_wire_state(p_run,v_w->'from'->>'step',v_w->'from'->>'port');
   if v_x='got' then v_got:=v_got+1;elsif v_x='pending' then v_pending:=v_pending+1;elsif v_x='dead' then v_dead:=v_dead+1;end if;
  end loop;
  if v_wired=0 then
   if v_has or not v_direct then continue;end if;
   return 'waiting';
  end if;
  if v_many then
   if v_pending>0 then return 'waiting';end if;
   if v_got>0 or v_has then continue;end if;
  else
   if v_has or v_got>0 then continue;end if;
   if v_pending>0 then return 'waiting';end if;
  end if;
  if v_dead>0 then return 'dead';end if;
  if v_direct then return 'waiting';end if;
 end loop;
 return 'ready';
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- A message's text with the run's values: {run}, {client}, {project}, {today}, and each field by key or label (a
-- choice by its label).
create function pulse.flow_fill(p_text text,p_run pulse.flow_run) returns text language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare v_out text:=coalesce(p_text,'');v_f jsonb;v_val text;
begin
 if position('{' in v_out)=0 then return v_out;end if;
 v_out:=replace(v_out,'{run}',p_run.name);
 v_out:=replace(v_out,'{client}',coalesce((select display_name from client where id=p_run.client_id),p_run.name));
 v_out:=replace(v_out,'{project}',coalesce((select coalesce(title,name) from project where id=p_run.project_id),p_run.name));
 v_out:=replace(v_out,'{today}',to_char(flow_today(),'DD Mon YYYY'));
 for v_f in select x from jsonb_array_elements(coalesce(p_run.definition->'fields','[]')) x loop
  v_val:=p_run.fields->>(v_f->>'key');
  if v_val is not null then v_val:=coalesce((select o->>'label' from jsonb_array_elements(coalesce(v_f->'options','[]')) o where o->>'value'=v_val limit 1),v_val);end if;
  v_out:=replace(replace(v_out,'{'||(v_f->>'key')||'}',coalesce(v_val,'')),'{'||(v_f->>'label')||'}',coalesce(v_val,''));
 end loop;
 return v_out;
end $$;

-- Someone is told (a role on the run, the starter, or a person): kept on the run as a 'notice' (Try it and demo runs
-- show who would have heard), and sent inside Pulse on a live run (unless Work already tells them: a new task).
create function pulse.flow_notice(p_run pulse.flow_run,p_role text,p_person uuid,p_key text,p_title text,p_send boolean default true) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_to text;
begin
 v_to:=coalesce((select display_name from person where id=p_person),
  case when jsonb_typeof(p_run.people->p_role)='object' then p_run.people->p_role->>'name' end,
  (select x->>'label' from jsonb_array_elements(coalesce(p_run.definition->'roles','[]')) x where x->>'key'=p_role limit 1),p_role,'someone');
 insert into flow_step_event(org_id,run_id,step_key,kind,actor,meta)
 values(current_org(),p_run.id,nullif(split_part(p_key,':',1),''),'notice',current_viewer(),jsonb_build_object('to',v_to,'role',p_role,'title',left(p_title,300),'sent',p_person is not null and p_run.mode='live',
  'how',case when p_send then 'Pulse' else 'Work task' end));
 if p_send then perform flow_notify(p_run,p_person,'flow.wire',p_key,p_title);end if;
end $$;

-- Answers given so far (the run's fields, then every answers object a step made), for a Decide rule.
create function pulse.flow_answers(p_run pulse.flow_run) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(p_run.fields,'{}')||coalesce((select jsonb_object_agg(k,v) from (
   select e.key k,e.value v from flow_value fv cross join lateral jsonb_each(case when jsonb_typeof(fv.value->'answers')='object' then fv.value->'answers' else '{}' end) e
   where fv.run_id=p_run.id and fv.side='makes' order by fv.set_at) a),'{}')
$$;

-- A value lands on a port. A step's Makes value travels every wire from that port to the Needs it feeds (a "many" port
-- collects them), and the wire's notify roles are told.
create or replace function pulse.flow_value_put(p_run uuid,p_step text,p_port text,p_side text,p_kind text,p_value jsonb,p_by uuid) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r flow_run;v_w jsonb;v_role text;v_to text;v_tport text;v_many boolean;v_title text;v_from_title text;
begin
 select * into r from flow_run where id=p_run;
 insert into flow_value(org_id,run_id,step_key,port,side,kind,value,set_by) values(current_org(),p_run,p_step,p_port,p_side,coalesce(p_kind,'any'),coalesce(p_value,'{}'),p_by)
  on conflict(org_id,run_id,step_key,port,side) do update set value=excluded.value,kind=excluded.kind,set_by=excluded.set_by,set_at=now();
 perform flow_event(p_run,p_step,case when p_side='makes' then 'value' else 'input' end,null,null,p_by,jsonb_build_object('port',p_port));
 if p_side<>'makes' then return;end if;
 select title into v_from_title from flow_run_step where run_id=p_run and step_key=p_step;
 for v_w in select x from jsonb_array_elements(coalesce(r.definition->'wires','[]')) x where x->'from'->>'step'=p_step and x->'from'->>'port'=p_port loop
  v_to:=v_w->'to'->>'step';v_tport:=v_w->'to'->>'port';
  v_many:=coalesce((select (n->>'many')::boolean from jsonb_array_elements(coalesce(r.compiled->'steps'->v_to->'needs','[]')) n where n->>'key'=v_tport limit 1),false);
  insert into flow_value(org_id,run_id,step_key,port,side,kind,value,set_by)
  values(current_org(),p_run,v_to,v_tport,'needs',coalesce(p_kind,'any'),case when v_many then jsonb_build_array(coalesce(p_value,'{}')) else coalesce(p_value,'{}') end,p_by)
  on conflict(org_id,run_id,step_key,port,side) do update set value=case when v_many then
    (case when jsonb_typeof(flow_value.value)='array' then flow_value.value else jsonb_build_array(flow_value.value) end)||jsonb_build_array(excluded.value->0)
    else excluded.value end,kind=excluded.kind,set_by=excluded.set_by,set_at=now();
  select title into v_title from flow_run_step where run_id=p_run and step_key=v_to;
  for v_role in select jsonb_array_elements_text(coalesce(v_w->'notify','[]')) loop
   perform flow_notice(r,v_role,flow_role_person(r,v_role),v_to||':'||p_step||'>'||v_to||':'||v_role,
    coalesce(v_from_title,p_step)||' is ready for '||coalesce(v_title,v_to)||coalesce(' · '||r.name,''));
  end loop;
 end loop;
end $$;

-- A step's data is in: it opens for its person (a Work task in a live run); a step that finishes by itself does so. A
-- Message in Pulse tells the people it names (with the run's values); a Decide with a rule decides by itself.
create or replace function pulse.flow_step_open(p_step uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare st flow_run_step;r flow_run;v_d jsonb;v_cp jsonb;v_pk record;v_tid uuid;v_prev text:=current_setting('pulse.viewer_id',true);
 v_role text;v_label text;v_notes text;v_cat text;v_proc text;v_check text;v_text text;v_ok boolean;
begin
 select * into st from flow_run_step where id=p_step for update;
 if st.state<>'waiting' then return;end if;
 select * into r from flow_run where id=st.run_id;
 if r.status<>'running' then return;end if;
 v_d:=flow_def_step(r.definition,st.step_key);v_cp:=r.compiled->'steps'->st.step_key;
 v_role:=v_d->'who'->>'role';
 v_label:=(select x->>'label' from jsonb_array_elements(coalesce(r.definition->'roles','[]')) x where x->>'key'=v_role limit 1);
 select * into v_pk from flow_pick(r,coalesce(v_d->'who','{}'),coalesce(v_label,v_role));
 update flow_run_step set state='open',opened_at=now(),person_id=v_pk.person,assign_why=left(v_pk.why,300),updated_at=now() where id=p_step;
 perform flow_event(r.id,st.step_key,'state','waiting','open',null,'{}');
 if st.module='notify' then
  v_text:=left(flow_fill(coalesce(nullif(v_d->'settings'->>'text',''),st.title),r)||' · '||r.name,160);
  for v_check in select jsonb_array_elements_text(coalesce(v_d->'settings'->'roles','[]')) loop
   perform flow_notice(r,v_check,case when v_check='starter' then r.started_by when v_check ~ '^[0-9a-f-]{36}$' then v_check::uuid else flow_role_person(r,v_check) end,
    st.step_key||':notify:'||v_check,v_text);
  end loop;
 elsif st.module='handoff' then perform flow_handoff(r,v_d);
 end if;
 if v_cp ? 'rule' then
  v_ok:=flow_conds(jsonb_build_array(v_cp->'rule'),flow_answers(r));
  perform flow_step_verdict(p_step,case when v_ok then 'yes' else 'no' end,'Decided by the rule',null);
  return;
 end if;
 if v_cp->>'finish'='auto' then perform flow_step_finish(p_step,'{}',null);return;end if;
 if v_cp->>'finish'='timer' then return;end if;
 -- The doer: Work tells them of the new task on a live run; the run keeps who it went to (Try it shows it).
 perform flow_notice(r,v_role,v_pk.person,st.step_key||':open:'||st.id,'Your step: '||left(st.title,100)||' · '||r.name,false);
 if r.mode<>'live' or v_pk.person is null then return;end if;
 select name into v_proc from flow_process where id=r.process_id;
 v_cat:=work_category_guess(st.title);
 if v_cat is not null and not exists(select 1 from work_category where key=v_cat) then v_cat:=null;end if;
 select string_agg('• '||c,E'\n') into v_check from jsonb_array_elements_text(coalesce(v_d->'checklist','[]')) c;
 v_notes:=left(concat_ws(E'\n\n',nullif(v_d->>'note',''),v_check,'Step '||st.step_key||' of “'||coalesce(v_proc,'the process')||'” for '||r.name||'. Open it in Pulse: /runs/'||r.id||'?step='||st.id),4000);
 perform set_config('pulse.viewer_id',coalesce(r.started_by::text,''),true);
 insert into task(id,org_id,title,status,project_id,source,source_ref,created_by,created_at,edited_by,updated_at,priority,position,due_at,locked,category,notes,
  owner_id,assignee_person_id,assigned_at)
 values(gen_random_uuid(),current_org(),left(st.title||' · '||r.name,300),'open',r.project_id,'flow',st.id::text,r.started_by,now(),r.started_by,now(),'normal',least(st.position,32000),
  case when st.due_on is not null then ((st.due_on+1)::timestamp at time zone org_time_zone())-interval '1 second' end,'{title,status,owner_id,project_id,due_label}',v_cat,v_notes,
  v_pk.person,v_pk.person,now())
 returning id into v_tid;
 perform task_event_add(v_tid,'workflow',null,coalesce(v_proc,'Process'),'Step '||st.step_key||' of the process');
 perform task_event_add(v_tid,'assigned',null,(select display_name from person where id=v_pk.person));
 perform set_config('pulse.viewer_id',coalesce(v_prev,''),true);
 update flow_run_step set task_id=v_tid where id=p_step;
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Runs that start by themselves: the live version of a process, started by whoever published it.
create function pulse.flow_auto_start(p_process uuid,p_name text,p_project uuid,p_client uuid,p_start_value jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare fp flow_process;v flow_process_version;v_rid uuid;v_start text;v_prev text:=current_setting('pulse.viewer_id',true);
begin
 select * into fp from flow_process where org_id=current_org() and id=p_process and status='live';
 if not found then return null;end if;
 select * into v from flow_process_version where process_id=fp.id and version=fp.version;
 if not found then return null;end if;
 perform set_config('pulse.viewer_id',coalesce(fp.published_by::text,fp.created_by::text,''),true);
 v_rid:=flow_start(jsonb_build_object('processId',fp.id,'version',v.version,'definition',v.definition,'compiled',v.compiled,'name',left(coalesce(nullif(btrim(p_name),''),fp.name),300),
  'projectId',p_project,'clientId',p_client,'fields','{}'::jsonb,'people','{}'::jsonb,'mode','live','startedBy',coalesce(fp.published_by,fp.created_by)));
 if p_start_value is not null then
  select x->>'id' into v_start from jsonb_array_elements(v.definition->'steps') x where x->>'block'='start' or x->>'module' in ('start','lead_capture','handoff_in') limit 1;
  if v_start is not null then perform flow_value_put(v_rid,v_start,'started','makes','answers',p_start_value,null);end if;
 end if;
 perform set_config('pulse.viewer_id',coalesce(v_prev,''),true);
 return v_rid;
end $$;

-- Processes whose Start is of one kind (lead, form, schedule).
create function pulse.flow_start_steps(p_kind text) returns table(process_id uuid,step jsonb) language sql stable security definer set search_path=pulse,pg_temp as $$
 select fp.id,x from flow_process fp join flow_process_version v on v.process_id=fp.id and v.version=fp.version cross join lateral jsonb_array_elements(v.definition->'steps') x
 where fp.org_id=current_org() and fp.status='live'
  and case p_kind when 'lead' then x->>'module'='lead_capture' else x->>'module'='start' and x->'settings'->>'trigger'=p_kind end
$$;

-- A new lead starts a run of every live process that starts on a lead.
create function pulse.flow_lead_started() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_p record;
begin
 for v_p in select * from flow_start_steps('lead') loop
  begin
   perform flow_auto_start(v_p.process_id,'Lead · '||coalesce((select coalesce(pr.title,pr.name) from project pr where pr.id=new.project_id),to_char(new.created_at at time zone org_time_zone(),'DD Mon HH24:MI')),
    new.project_id,(select client_id from project where id=new.project_id),jsonb_build_object('leadId',new.id,'status',new.status,'at',new.created_at));
  exception when others then raise warning 'flow lead start %: %',v_p.process_id,sqlerrm;
  end;
 end loop;
 return null;
end $$;
create trigger flow_lead_started after insert on pulse.lead for each row execute function pulse.flow_lead_started();

-- ---------------------------------------------------------------------------------------------------------------------
-- Forms: a submission may belong to a Flow step (Collect); sending it finishes that step with the answers, the place
-- and the time; a form that starts processes starts their runs.
create or replace function pulse.form_submission_open(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();f field_form;st workflow_run_step;r workflow_run;fs flow_run_step;fr flow_run;sid uuid;pid uuid:=nullif(p->>'projectId','')::uuid;cid uuid:=nullif(p->>'clientId','')::uuid;
begin
 select * into f from field_form where org_id=current_org() and id=(p->>'formId')::uuid;
 if not found or f.status<>'live' then raise exception 'This form is not open for answers' using errcode='22023';end if;
 if nullif(p->>'stepId','') is not null then
  select * into st from workflow_run_step where org_id=current_org() and id=(p->>'stepId')::uuid;
  if not found or not form_step_fillable(st.id) then raise exception 'This step is not yours to fill, or it is finished' using errcode='42501';end if;
  select * into r from workflow_run where id=st.run_id;
  if workflow_def_step(r.definition,st.step_key)->>'formId' is distinct from f.id::text then raise exception 'This step asks for another form' using errcode='22023';end if;
  pid:=r.project_id;cid:=r.client_id;
 elsif nullif(p->>'flowStepId','') is not null then
  select * into fs from flow_run_step where org_id=current_org() and id=(p->>'flowStepId')::uuid;
  if not found or fs.state not in ('open','in_progress','in_review','confirmed') then raise exception 'This step is not open' using errcode='22023';end if;
  select * into fr from flow_run where id=fs.run_id;
  if fr.status<>'running' then raise exception 'This run has finished' using errcode='22023';end if;
  pid:=fr.project_id;cid:=fr.client_id;
 else
  if pid is not null and not exists(select 1 from project where org_id=current_org() and id=pid) then raise exception 'Choose a project' using errcode='22023';end if;
  cid:=coalesce(cid,(select client_id from project where id=pid),f.client_id);
 end if;
 insert into form_submission(org_id,form_id,form_version,form_name,fields,answers,run_id,step_id,task_id,project_id,client_id,location,device,note,submitted_by,flow_step_id)
 values(current_org(),f.id,f.version,f.name,f.fields,coalesce(p->'answers','{}'),r.id,st.id,st.task_id,pid,cid,case when jsonb_typeof(p->'location')='object' then p->'location' end,
  left(p->>'device',200),nullif(left(p->>'note',1000),''),me,fs.id) returning id into sid;
 return sid;
end $$;

create or replace function pulse.form_submission_send(p_id uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();s form_submission;x jsonb;n int;need int;st workflow_run_step;w workflow;ctx jsonb;rid uuid;runs uuid[]:='{}';fs flow_run_step;v_out jsonb;v_port text;v_p record;
begin
 select * into s from form_submission where org_id=current_org() and id=p_id for update;
 if not found or s.status<>'open' or s.submitted_by<>me then raise exception 'This form was already sent' using errcode='22023';end if;
 for x in select * from jsonb_array_elements(s.fields) loop
  if x->>'type' in ('photo','signature') then
   need:=case when x->>'type'='signature' then case when (x->>'required')::boolean then 1 else 0 end
    else greatest(case when (x->>'required')::boolean then 1 else 0 end,coalesce(nullif(x->>'min','')::int,0)) end;
   select count(*) into n from pulse_priv.form_file where org_id=current_org() and submission_id=p_id and field_key=x->>'key';
   if n<need then raise exception '% needs % photo%',x->>'label',need,case when need=1 then '' else 's' end using errcode='22023';end if;
   if nullif(x->>'max','')::int is not null and n>(x->>'max')::int then raise exception '% takes at most % photos',x->>'label',x->>'max' using errcode='22023';end if;
  end if;
 end loop;
 update form_submission set status='submitted',submitted_at=now() where id=p_id;
 insert into form_event(org_id,submission_id,kind,actor_id) values(current_org(),p_id,'submitted',me);
 perform audit_write('submit','form_submission',p_id::text);
 if s.flow_step_id is not null then
  -- FLOW-D: the Collect step is done with these answers (photos stay in the form, with their place and time).
  select * into fs from flow_run_step where id=s.flow_step_id;
  if found and fs.state in ('open','in_progress','in_review','confirmed') then
   select x->>'key' into v_port from flow_run r cross join lateral jsonb_array_elements(r.compiled->'steps'->fs.step_key->'makes') x where r.id=fs.run_id limit 1;
   v_out:=jsonb_build_object(coalesce(v_port,'answers'),jsonb_build_object('submissionId',s.id,'formId',s.form_id,'form',s.form_name,'answers',s.answers,'location',s.location,
    'photos',(select count(*) from pulse_priv.form_file ff where ff.org_id=current_org() and ff.submission_id=s.id),'href','/sops/forms/'||s.form_id));
   perform flow_step_finish(fs.id,v_out,me);
  end if;
  return jsonb_build_object('id',p_id,'stepDone',true,'runs','[]'::jsonb);
 end if;
 -- The answers, without photos, as the run's values: "<step>.<field>" for a step's form, "form.<field>" for a starting form.
 if s.step_id is not null then
  select * into st from workflow_run_step where id=s.step_id;
  update workflow_run set context=context||coalesce((select jsonb_object_agg(st.step_key||'.'||k,v) from jsonb_each(s.answers) e(k,v)),'{}') where id=s.run_id;
  if exists(select 1 from task where id=s.task_id and status not in ('done','accepted','cancelled')) then perform task_move(s.task_id,'done','Form sent: '||s.form_name);end if;
 else
  ctx:=coalesce((select jsonb_object_agg('form.'||k,v) from jsonb_each(s.answers) e(k,v)),'{}');
  for w in select * from workflow where org_id=current_org() and status='live' and trigger->>'kind'='form' and trigger->>'formId'=s.form_id::text loop
   rid:=workflow_start_as(w.id,s.project_id,s.client_id,me,'form',p_id::text,ctx,s.form_name||coalesce(' · '||(select coalesce(pr.title,pr.name) from project pr where pr.id=s.project_id),''));
   runs:=runs||rid;
   insert into form_event(org_id,submission_id,kind,actor_id,note) values(current_org(),p_id,'started_run',me,left(w.name,300));
  end loop;
  -- FLOW-D: live processes that start when this form is sent.
  for v_p in select * from flow_start_steps('form') where step->'settings'->>'formId'=s.form_id::text loop
   rid:=flow_auto_start(v_p.process_id,s.form_name||coalesce(' · '||(select coalesce(pr.title,pr.name) from project pr where pr.id=s.project_id),' · '||to_char(flow_today(),'DD Mon')),
    s.project_id,s.client_id,jsonb_build_object('submissionId',s.id,'form',s.form_name,'answers',s.answers,'location',s.location));
   if rid is not null then
    insert into form_event(org_id,submission_id,kind,actor_id,note) values(current_org(),p_id,'started_run',me,left((select name from flow_process where id=v_p.process_id),300));
   end if;
  end loop;
  if cardinality(runs)>0 then update form_submission set started_runs=runs,run_id=coalesce(run_id,runs[1]) where id=p_id;end if;
 end if;
 return jsonb_build_object('id',p_id,'stepDone',s.step_id is not null,'runs',to_jsonb(runs));
end $$;

-- ---------------------------------------------------------------------------------------------------------------------
-- The minute tick: waits until a date, scheduled starts, then the timers and alert rules of 0800.
alter function pulse.flow_tick(timestamptz) rename to flow_tick_rules;
create function pulse.flow_tick(p_now timestamptz default now()) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_s record;v_today date:=(p_now at time zone org_time_zone())::date;v_local timestamp:=(p_now at time zone org_time_zone());v_p record;v_at time;v_slot timestamptz;
 v_started int:=0;v_out jsonb;
begin
 -- Wait until a date of the run.
 for v_s in select st.id from flow_run_step st join flow_run fr on fr.id=st.run_id where st.org_id=current_org() and fr.status='running' and st.state='open'
   and fr.compiled->'steps'->st.step_key ? 'untilField' loop
  begin
   if (select nullif(fr.fields->>(fr.compiled->'steps'->st.step_key->>'untilField'),'')::date from flow_run_step st join flow_run fr on fr.id=st.run_id where st.id=v_s.id)<=v_today then
    perform flow_step_finish(v_s.id,'{}',null);
   end if;
  exception when invalid_datetime_format or datetime_field_overflow then null;
  end;
 end loop;
 -- Scheduled starts: every day, or every week on its day (1 = Monday), at its time; once per slot.
 for v_p in select * from flow_start_steps('schedule') loop
  begin v_at:=coalesce(nullif(v_p.step->'settings'->>'at','')::time,'10:00');exception when others then v_at:='10:00';end;
  if coalesce(v_p.step->'settings'->>'every','week')='week' and extract(isodow from v_today)::int<>coalesce(nullif(v_p.step->'settings'->>'day','')::int,1) then continue;end if;
  if v_local::time<v_at then continue;end if;
  v_slot:=(v_today+v_at) at time zone org_time_zone();
  if exists(select 1 from flow_process where id=v_p.process_id and auto_at>=v_slot) then continue;end if;
  update flow_process set auto_at=p_now where id=v_p.process_id;
  if flow_auto_start(v_p.process_id,(select name from flow_process where id=v_p.process_id)||' · '||to_char(v_today,'DD Mon'),null,null,jsonb_build_object('scheduled',v_slot)) is not null then
   v_started:=v_started+1;
  end if;
 end loop;
 v_out:=flow_tick_rules(p_now);
 return v_out||jsonb_build_object('started',v_started);
end $$;

-- Try it: a try run is thrown away with everything it made (its steps, values, events, alerts and records).
create function pulse.flow_try_discard(p_run uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r flow_run;
begin
 select * into r from flow_run where org_id=current_org() and id=p_run for update;
 if not found then raise exception 'Run not found' using errcode='P0002';end if;
 if r.mode<>'try' then raise exception 'Only a try run is thrown away' using errcode='22023';end if;
 delete from flow_comment where record_id in (select id from flow_record where run_id=p_run);
 delete from flow_record_version where record_id in (select id from flow_record where run_id=p_run);
 delete from flow_link where from_id in (select id from flow_record where run_id=p_run) or to_id in (select id from flow_record where run_id=p_run);
 delete from flow_record where run_id=p_run;
 update form_submission set flow_step_id=null where flow_step_id in (select id from flow_run_step where run_id=p_run);
 delete from flow_alert where run_id=p_run;
 delete from flow_step_event where run_id=p_run;
 delete from flow_intake where run_id=p_run;
 delete from flow_value where run_id=p_run;
 delete from flow_run_step where run_id=p_run;
 delete from flow_run where id=p_run;
end $$;

revoke all on function pulse.flow_wire_state(uuid,text,text,int),pulse.flow_fill(text,pulse.flow_run),pulse.flow_notice(pulse.flow_run,text,uuid,text,text,boolean),pulse.flow_answers(pulse.flow_run),
 pulse.flow_auto_start(uuid,text,uuid,uuid,jsonb),pulse.flow_start_steps(text),pulse.flow_lead_started(),pulse.flow_tick(timestamptz),pulse.flow_try_discard(uuid) from public;
grant execute on function pulse.flow_wire_state(uuid,text,text,int),pulse.flow_fill(text,pulse.flow_run),pulse.flow_answers(pulse.flow_run),pulse.flow_tick(timestamptz),pulse.flow_try_discard(uuid) to pulse_api;
grant execute on function pulse.flow_tick(timestamptz) to pulse_worker;

-- migrate:down
-- Forward-only: company blocks and runs are kept.
