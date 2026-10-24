-- migrate:up
-- FLOW-D "Try it": pretend days pass on a try (or demo) run, to see its due dates go late and its alerts fire. The run's
-- clock moves back by that many days (when it started, Day 1, when each step opened, started, was sent, confirmed or
-- done); due dates follow; the minute tick then sees it as it would be. Live runs are never moved.
create function pulse.flow_try_later(p_run uuid,p_days int) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r flow_run;v interval;
begin
 select * into r from flow_run where org_id=current_org() and id=p_run for update;
 if not found then raise exception 'Run not found' using errcode='P0002';end if;
 if r.mode not in ('try','demo') then raise exception 'Only a try or demo run moves in time' using errcode='22023';end if;
 if p_days is null or p_days<1 or p_days>60 then raise exception 'Between 1 and 60 days' using errcode='22023';end if;
 v:=make_interval(days=>p_days);
 update flow_run set started_at=started_at-v,day1=day1-p_days where id=p_run;
 update flow_run_step set opened_at=opened_at-v,started_at=started_at-v,sent_at=sent_at-v,confirmed_at=confirmed_at-v,done_at=done_at-v,blocked_at=blocked_at-v where run_id=p_run;
 update flow_intake set received_on=received_on-p_days where run_id=p_run and received_on is not null;
 update flow_record set updated_at=updated_at-v where run_id=p_run;
 perform flow_event(p_run,null,'clock',null,null,current_viewer(),jsonb_build_object('later',p_days));
 perform flow_recompute_due(p_run);
end $$;
-- A Decide rule reads answers without caring about capitals ("Rooftop" is "rooftop"; the rule's value is kept in lower case).
create or replace function pulse.flow_answers(p_run pulse.flow_run) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select jsonb_object_agg(k,case when jsonb_typeof(v)='string' then to_jsonb(lower(v#>>'{}')) else v end) from (
   select e.key k,e.value v,0 o,now() t from jsonb_each(coalesce(p_run.fields,'{}')) e
   union all
   select e.key,e.value,1,fv.set_at from flow_value fv cross join lateral jsonb_each(case when jsonb_typeof(fv.value->'answers')='object' then fv.value->'answers' else '{}' end) e
   where fv.run_id=p_run.id order by 3,4) a),'{}')
$$;

-- A run that starts by itself has what started it (the lead, the form's answers, the schedule) before its first steps
-- open, so a Decide right after the Start reads the answers.
create or replace function pulse.flow_auto_start(p_process uuid,p_name text,p_project uuid,p_client uuid,p_start_value jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare fp flow_process;v flow_process_version;v_rid uuid;v_start text;v_prev text:=current_setting('pulse.viewer_id',true);
begin
 select * into fp from flow_process where org_id=current_org() and id=p_process and status='live';
 if not found then return null;end if;
 select * into v from flow_process_version where process_id=fp.id and version=fp.version;
 if not found then return null;end if;
 select x->>'id' into v_start from jsonb_array_elements(v.definition->'steps') x where x->>'block'='start' or x->>'module' in ('start','lead_capture','handoff_in') limit 1;
 perform set_config('pulse.viewer_id',coalesce(fp.published_by::text,fp.created_by::text,''),true);
 v_rid:=flow_start(jsonb_build_object('processId',fp.id,'version',v.version,'definition',v.definition,'compiled',v.compiled,'name',left(coalesce(nullif(btrim(p_name),''),fp.name),300),
  'projectId',p_project,'clientId',p_client,'fields','{}'::jsonb,'people','{}'::jsonb,'mode','live','startedBy',coalesce(fp.published_by,fp.created_by),
  'values',case when p_start_value is not null and v_start is not null then jsonb_build_array(jsonb_build_object('step',v_start,'port','started','kind','answers','value',p_start_value)) else '[]'::jsonb end));
 perform set_config('pulse.viewer_id',coalesce(v_prev,''),true);
 return v_rid;
end $$;
-- A form sent on a Collect step finishes it (0810's version named a table alias like one of its variables).
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
   select mk->>'key' into v_port from flow_run fr cross join lateral jsonb_array_elements(fr.compiled->'steps'->fs.step_key->'makes') mk where fr.id=fs.run_id limit 1;
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

revoke all on function pulse.flow_try_later(uuid,int) from public;
grant execute on function pulse.flow_try_later(uuid,int) to pulse_api;

-- migrate:down
-- Forward-only.
