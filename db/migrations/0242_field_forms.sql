-- migrate:up
-- SOP-WORKFLOW part 3 (owner, 11 Oct 2026: company-specific field workflows; at Willow Lane Enterprises LLP an employee
-- photographs the installed solar panels, records the entry and the pickup and fills in a specific form).
--  * pulse.field_form: a form leadership builds (photo from the camera, with geotag and time when asked; numbers, text,
--    choices, a signature, a checklist, a location, a date), optionally for one client company; each save keeps a version.
--  * A workflow step carries a form (definition formId): its task opens the form on the phone, and sending it finishes
--    the step. The answers go into the run (as "<step>.<field>", for branch conditions). A form can also start runs.
--  * pulse.form_submission keeps the answers against the project and client with the form as it was; photos and
--    signatures are bytes in pulse_priv.form_file (camera or upload, when taken, where); pulse.form_event is the
--    record of who sent, opened, or voided it, beside audit_event. Nothing is changed after sending; leadership voids.

create table pulse.field_form (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 name text not null check(length(btrim(name)) between 1 and 200),purpose text check(length(purpose)<=1000),
 client_id uuid references pulse.client(id),
 status text not null default 'draft' check(status in ('draft','live','archived')),
 fields jsonb not null default '[]' check(jsonb_typeof(fields)='array' and pg_column_size(fields)<100000),
 version int not null default 1,template_key text check(length(template_key)<=40),
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now()
);
create table pulse.field_form_version (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),form_id uuid not null references pulse.field_form(id),
 version int not null,fields jsonb not null,saved_by uuid references pulse.person(id),saved_at timestamptz not null default now(),unique(org_id,form_id,version)
);
create table pulse.form_submission (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 form_id uuid not null references pulse.field_form(id),form_version int not null,form_name text not null,fields jsonb not null,
 answers jsonb not null default '{}' check(jsonb_typeof(answers)='object' and pg_column_size(answers)<200000),
 run_id uuid references pulse.workflow_run(id),step_id uuid references pulse.workflow_run_step(id),task_id uuid references pulse.task(id),
 project_id uuid references pulse.project(id),client_id uuid references pulse.client(id),
 status text not null default 'open' check(status in ('open','submitted','void')),
 location jsonb check(location is null or jsonb_typeof(location)='object'),device text check(length(device)<=200),note text check(length(note)<=1000),
 started_runs uuid[] not null default '{}',
 submitted_by uuid references pulse.person(id),submitted_at timestamptz,created_at timestamptz not null default now(),
 voided_by uuid references pulse.person(id),voided_at timestamptz,void_reason text check(length(void_reason)<=500)
);
create index form_submission_form on pulse.form_submission(org_id,form_id,submitted_at desc);
create index form_submission_project on pulse.form_submission(org_id,project_id) where project_id is not null;
create index form_submission_run on pulse.form_submission(org_id,run_id) where run_id is not null;
create table pulse_priv.form_file (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 submission_id uuid not null references pulse.form_submission(id),field_key text not null check(length(field_key) between 1 and 60),
 name text not null check(length(name) between 1 and 200),mime text not null check(mime in ('image/jpeg','image/png','image/webp')),
 bytes bytea not null check(octet_length(bytes) between 1 and 6000000),sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 width int,height int,source text not null check(source in ('camera','upload','signature')),
 captured_at timestamptz,lat numeric(9,6),lng numeric(9,6),accuracy numeric(9,1),received_at timestamptz not null default now()
);
create index form_file_submission on pulse_priv.form_file(org_id,submission_id);
create table pulse.form_event (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 submission_id uuid not null references pulse.form_submission(id),kind text not null check(kind in ('submitted','viewed','file_viewed','voided','started_run')),
 actor_id uuid references pulse.person(id),at timestamptz not null default now(),note text check(length(note)<=300)
);
create index form_event_submission on pulse.form_event(org_id,submission_id,at);

-- Who reads a submission: leadership, HR and admins; whoever sent it; the people its project belongs to; whoever can see its run.
create function pulse.form_submission_visible(p_id uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and (viewer_is('admin','leadership','hr') or exists(select 1 from form_submission s where s.org_id=current_org() and s.id=p_id
  and (s.submitted_by=current_viewer() or work_project_in(s.project_id) or (s.run_id is not null and workflow_run_visible(s.run_id)))))
$$;
do $$ declare t text;begin
 foreach t in array array['field_form','field_form_version','form_submission','form_event'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant_isolation on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select on pulse.%I to pulse_api',t);
  execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
 alter table pulse_priv.form_file enable row level security;
 alter table pulse_priv.form_file force row level security;
 create policy tenant_isolation on pulse_priv.form_file using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
 create trigger audit_mutation after insert or update on pulse_priv.form_file for each row execute function pulse.audit_mutation();
end $$;
create policy field_form_read on pulse.field_form as restrictive for select to pulse_api using(pulse.current_viewer() is not null and (status='live' or pulse.sop_editor()));
create policy field_form_version_read on pulse.field_form_version as restrictive for select to pulse_api using(pulse.current_viewer() is not null);
create policy form_submission_read on pulse.form_submission as restrictive for select to pulse_api using(pulse.form_submission_visible(id));
create policy form_event_read on pulse.form_event as restrictive for select to pulse_api using(pulse.form_submission_visible(submission_id));

-- Save a form (null id: a new one). The API has already checked the fields; each change keeps a version.
create function pulse.field_form_save(p_id uuid,p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();f field_form;fid uuid;
begin
 if jsonb_typeof(p)<>'object' or jsonb_typeof(p->'fields')<>'array' then raise exception 'Describe the form and its fields' using errcode='22023';end if;
 if coalesce(btrim(p->>'name'),'')='' then raise exception 'Name the form' using errcode='22023';end if;
 if nullif(p->>'clientId','') is not null and not exists(select 1 from client where org_id=current_org() and id=(p->>'clientId')::uuid) then raise exception 'Choose a client' using errcode='22023';end if;
 if p_id is null then
  insert into field_form(org_id,name,purpose,client_id,fields,template_key,status,created_by,updated_by)
  values(current_org(),left(btrim(p->>'name'),200),nullif(left(p->>'purpose',1000),''),nullif(p->>'clientId','')::uuid,p->'fields',nullif(left(p->>'templateKey',40),''),
   case when p->>'status'='live' and jsonb_array_length(p->'fields')>0 then 'live' else 'draft' end,me,me) returning id into fid;
  insert into field_form_version(org_id,form_id,version,fields,saved_by) values(current_org(),fid,1,p->'fields',me);
  perform audit_write('create','field_form',fid::text);
  return fid;
 end if;
 select * into f from field_form where org_id=current_org() and id=p_id for update;
 if not found then raise exception 'Form not found' using errcode='P0002';end if;
 if f.status='archived' then raise exception 'Restore the form before changing it' using errcode='22023';end if;
 update field_form set name=left(btrim(p->>'name'),200),purpose=nullif(left(p->>'purpose',1000),''),client_id=nullif(p->>'clientId','')::uuid,fields=p->'fields',
  version=case when fields is distinct from p->'fields' then version+1 else version end,updated_by=me,updated_at=now() where id=p_id returning * into f;
 if not exists(select 1 from field_form_version where org_id=current_org() and form_id=p_id and version=f.version) then
  insert into field_form_version(org_id,form_id,version,fields,saved_by) values(current_org(),p_id,f.version,f.fields,me);end if;
 perform audit_write('update','field_form',p_id::text);
 return p_id;
end $$;
create function pulse.field_form_set_status(p_id uuid,p_status text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();
begin
 if p_status not in ('draft','live','archived') then raise exception 'Choose draft, live or archived' using errcode='22023';end if;
 if p_status='live' and exists(select 1 from field_form where org_id=current_org() and id=p_id and jsonb_array_length(fields)=0) then raise exception 'A form needs at least one field' using errcode='22023';end if;
 update field_form set status=p_status,updated_by=me,updated_at=now() where org_id=current_org() and id=p_id;
 if not found then raise exception 'Form not found' using errcode='P0002';end if;
 perform audit_write(p_status,'field_form',p_id::text);
end $$;

-- Who may fill a run step's form: whoever does its task (or may change it).
create function pulse.form_step_fillable(p_step uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and exists(select 1 from workflow_run_step s join workflow_run r on r.id=s.run_id join task t on t.id=s.task_id
  where s.org_id=current_org() and s.id=p_step and s.status='active' and r.status='running'
   and (current_viewer() in (t.assignee_person_id,t.owner_id) or task_can_edit(t.id)))
$$;

-- Start sending a form (the answers the API checked); photos and signatures follow with form_file_add, then form_submission_send.
create function pulse.form_submission_open(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();f field_form;st workflow_run_step;r workflow_run;sid uuid;pid uuid:=nullif(p->>'projectId','')::uuid;cid uuid:=nullif(p->>'clientId','')::uuid;
begin
 select * into f from field_form where org_id=current_org() and id=(p->>'formId')::uuid;
 if not found or f.status<>'live' then raise exception 'This form is not open for answers' using errcode='22023';end if;
 if nullif(p->>'stepId','') is not null then
  select * into st from workflow_run_step where org_id=current_org() and id=(p->>'stepId')::uuid;
  if not found or not form_step_fillable(st.id) then raise exception 'This step is not yours to fill, or it is finished' using errcode='42501';end if;
  select * into r from workflow_run where id=st.run_id;
  if workflow_def_step(r.definition,st.step_key)->>'formId' is distinct from f.id::text then raise exception 'This step asks for another form' using errcode='22023';end if;
  pid:=r.project_id;cid:=r.client_id;
 else
  if pid is not null and not exists(select 1 from project where org_id=current_org() and id=pid) then raise exception 'Choose a project' using errcode='22023';end if;
  cid:=coalesce(cid,(select client_id from project where id=pid),f.client_id);
 end if;
 insert into form_submission(org_id,form_id,form_version,form_name,fields,answers,run_id,step_id,task_id,project_id,client_id,location,device,note,submitted_by)
 values(current_org(),f.id,f.version,f.name,f.fields,coalesce(p->'answers','{}'),r.id,st.id,st.task_id,pid,cid,case when jsonb_typeof(p->'location')='object' then p->'location' end,
  left(p->>'device',200),nullif(left(p->>'note',1000),''),me) returning id into sid;
 return sid;
end $$;
create function pulse.form_file_add(p_submission uuid,p jsonb,p_bytes bytea) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();s form_submission;fid uuid;
begin
 select * into s from form_submission where org_id=current_org() and id=p_submission for update;
 if not found or s.status<>'open' or s.submitted_by<>me then raise exception 'Add photos while sending the form' using errcode='22023';end if;
 if not exists(select 1 from jsonb_array_elements(s.fields) x where x->>'key'=p->>'field' and x->>'type' in ('photo','signature')) then raise exception 'That field takes no photo' using errcode='22023';end if;
 insert into pulse_priv.form_file(org_id,submission_id,field_key,name,mime,bytes,sha256,width,height,source,captured_at,lat,lng,accuracy)
 values(current_org(),p_submission,p->>'field',left(coalesce(nullif(p->>'name',''),'photo.jpg'),200),p->>'mime',p_bytes,encode(sha256(p_bytes),'hex'),
  nullif(p->>'width','')::int,nullif(p->>'height','')::int,coalesce(nullif(p->>'source',''),'upload'),nullif(p->>'capturedAt','')::timestamptz,
  nullif(p->>'lat','')::numeric,nullif(p->>'lng','')::numeric,nullif(p->>'accuracy','')::numeric) returning id into fid;
 return fid;
end $$;

-- Send: required photos and signatures are there; the step's task is finished (the run moves on with the answers);
-- a form that starts workflows starts their runs.
create function pulse.form_submission_send(p_id uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=task_require_viewer();s form_submission;x jsonb;n int;need int;st workflow_run_step;w workflow;ctx jsonb;rid uuid;runs uuid[]:='{}';
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
  if cardinality(runs)>0 then update form_submission set started_runs=runs,run_id=coalesce(run_id,runs[1]) where id=p_id;end if;
 end if;
 return jsonb_build_object('id',p_id,'stepDone',s.step_id is not null,'runs',to_jsonb(runs));
end $$;

-- A photo or signature for someone who may read the submission; their opening it is recorded once a day.
create function pulse.form_file_read(p_id uuid) returns table(name text,mime text,bytes bytea) language plpgsql security definer set search_path=pulse,pg_temp as $$
declare f pulse_priv.form_file;
begin
 select * into f from pulse_priv.form_file where org_id=current_org() and id=p_id;
 if not found or not form_submission_visible(f.submission_id) then return;end if;
 insert into form_event(org_id,submission_id,kind,actor_id,note) select current_org(),f.submission_id,'file_viewed',current_viewer(),f.field_key
  where not exists(select 1 from form_event e where e.org_id=current_org() and e.submission_id=f.submission_id and e.kind='file_viewed' and e.actor_id=current_viewer()
   and e.note=f.field_key and e.at>now()-interval '1 day');
 return query select f.name,f.mime,f.bytes;
end $$;
create function pulse.form_files(p_submission uuid) returns table(id uuid,field_key text,name text,mime text,size int,width int,height int,source text,captured_at timestamptz,lat numeric,lng numeric,accuracy numeric,received_at timestamptz)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select f.id,f.field_key,f.name,f.mime,octet_length(f.bytes),f.width,f.height,f.source,f.captured_at,f.lat,f.lng,f.accuracy,f.received_at
  from pulse_priv.form_file f where f.org_id=current_org() and f.submission_id=p_submission and form_submission_visible(p_submission) order by f.field_key,f.received_at
$$;
create function pulse.form_submission_viewed(p_id uuid) returns void language sql security definer set search_path=pulse,pg_temp as $$
 insert into form_event(org_id,submission_id,kind,actor_id) select current_org(),p_id,'viewed',current_viewer()
  where form_submission_visible(p_id) and current_viewer() is not null and not exists(select 1 from form_event e where e.org_id=current_org() and e.submission_id=p_id
   and e.kind in ('viewed','submitted') and e.actor_id=current_viewer() and e.at>now()-interval '1 day')
$$;
create function pulse.form_submission_void(p_id uuid,p_reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=sop_require_editor();
begin
 if coalesce(btrim(p_reason),'')='' then raise exception 'Say why it is void' using errcode='22023';end if;
 update form_submission set status='void',voided_by=me,voided_at=now(),void_reason=left(btrim(p_reason),500) where org_id=current_org() and id=p_id and status='submitted';
 if not found then raise exception 'Only a sent form can be voided' using errcode='P0002';end if;
 insert into form_event(org_id,submission_id,kind,actor_id,note) values(current_org(),p_id,'voided',me,left(btrim(p_reason),300));
 perform audit_write('void','form_submission',p_id::text);
end $$;

-- A step's task: a kind of work the company does not have (yet) is guessed from the step's name instead (a template's
-- "operations" on a company that has not used it yet would break the task's reference to its kind of work).
create or replace function pulse.workflow_step_activate(p_step uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 -- A kind of work the company does not have (yet) is guessed from the step's name instead.
 v_cat:=coalesce((select key from work_category where org_id=current_org() and key=nullif(d->>'category','') and active),work_category_guess(st.title));
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

revoke all on function pulse.form_submission_visible(uuid),pulse.field_form_save(uuid,jsonb),pulse.field_form_set_status(uuid,text),pulse.form_step_fillable(uuid),pulse.form_submission_open(jsonb),
 pulse.form_file_add(uuid,jsonb,bytea),pulse.form_submission_send(uuid),pulse.form_file_read(uuid),pulse.form_files(uuid),pulse.form_submission_viewed(uuid),pulse.form_submission_void(uuid,text) from public;
grant execute on function pulse.form_submission_visible(uuid),pulse.field_form_save(uuid,jsonb),pulse.field_form_set_status(uuid,text),pulse.form_step_fillable(uuid),pulse.form_submission_open(jsonb),
 pulse.form_file_add(uuid,jsonb,bytea),pulse.form_submission_send(uuid),pulse.form_file_read(uuid),pulse.form_files(uuid),pulse.form_submission_viewed(uuid),pulse.form_submission_void(uuid,text) to pulse_api;

-- migrate:down
-- Forward-only: forms, their answers and photos are kept.
