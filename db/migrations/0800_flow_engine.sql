-- migrate:up
-- FLOW-A (owner, 21 Oct 2026; ~/ea-research/flow/FLOW-OS.md): one engine that can hold any company's work, beside the
-- old relay (0241, 0530), which keeps its runs. Kazuk's rule (EA Creative Strategist Workflow, Part 6): DATA, NOT
-- PERMISSION. A step starts when the data it needs exists, not when someone clicks done or approved; hand-offs are
-- notifications, not locks; approvals are tracked and alerted on, never waited on.
--  * pulse.flow_process: one way of working: its write-up (the SOP text, by section), its definition (steps = modules
--    placed with who / due / variant filter / SOP section; wires from a step's Makes to another's Needs of the same kind;
--    stages; variant fields; alert rules; scorecard) and its runs. Publishing keeps a version (with the compiled ports
--    the engine reads: services/api/src/flow/model.ts compile()); a run keeps the version it began with.
--  * pulse.flow_run / flow_run_step: one client or project going through a process. Step states: waiting (for data),
--    open, in_progress, in_review (sent for review), confirmed, done, skipped (by a variant). A step opens when every
--    required Needs port has a value (from a wire, or typed in by its owner); a step that only waits on skipped steps
--    opens too. An open step of a live run is a Work task for its person (source 'flow'), so My desk / Work show it;
--    finishing the task finishes the step, whichever way it was finished.
--  * pulse.flow_value: the run's values per port (a step's Makes, and what reached a step's Needs).
--  * pulse.flow_intake: the intake checklist; with clock.from = 'intake' Day 1 is the day the last critical item came in
--    (late inputs move every Day-N due date by as much).
--  * pulse.flow_step_event: every state change, value, alert and nudge, for the scorecard and capacity.
--  * pulse.flow_alert: alert rules (data in the template, never code) fired by pulse.flow_tick on the worker's minute
--    tick; each fires once per run, rule and step, to the roles it names, the doer or the data owner.
--  * Records + links: typed records (Persona, Competitor, USP, Fact, Asset, Meeting, Document ...) with a status machine
--    (services/api/src/flow/record-types.ts; a company adds its own types in pulse.flow_record_type), versions,
--    comments / change lists, and typed links between records. Module backends are records.
-- Demo runs (mode 'demo') follow the same engine on synthetic people: no task, no notification.
-- Runs are read by every staff member of the company (Kazuk: "everyone sees the whole picture"); the API decides who
-- designs (leadership) and who acts on a step.

create table pulse.flow_process (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 name text not null check(length(btrim(name)) between 1 and 200),summary text check(length(summary)<=2000),
 status text not null default 'draft' check(status in ('draft','live','paused','archived')),
 writeup jsonb not null default '[]' check(jsonb_typeof(writeup)='array' and pg_column_size(writeup)<4000000),
 definition jsonb not null default '{"version":2,"steps":[],"wires":[]}' check(jsonb_typeof(definition)='object' and pg_column_size(definition)<1000000),
 version int not null default 0,template_key text check(template_key ~ '^[a-z0-9_-]{1,60}$'),
 sop_id uuid references pulse.sop(id),workflow_id uuid references pulse.workflow(id),board_id uuid references pulse.workflow_board(id),
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 published_by uuid references pulse.person(id),published_at timestamptz
);
create index flow_process_status on pulse.flow_process(org_id,status,updated_at desc);
create unique index flow_process_template on pulse.flow_process(org_id,template_key) where template_key is not null and status<>'archived';
create table pulse.flow_process_version (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),process_id uuid not null references pulse.flow_process(id),
 version int not null,definition jsonb not null,compiled jsonb not null,published_by uuid references pulse.person(id),published_at timestamptz not null default now(),
 unique(org_id,process_id,version)
);
create table pulse.flow_run (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 process_id uuid not null references pulse.flow_process(id),version int not null,definition jsonb not null,compiled jsonb not null,
 name text not null check(length(btrim(name)) between 1 and 300),
 project_id uuid references pulse.project(id),client_id uuid references pulse.client(id),
 fields jsonb not null default '{}' check(jsonb_typeof(fields)='object'),
 people jsonb not null default '{}' check(jsonb_typeof(people)='object'),
 mode text not null default 'live' check(mode in ('live','demo')),
 status text not null default 'running' check(status in ('running','done','cancelled')),
 day1 date,started_by uuid references pulse.person(id),started_at timestamptz not null default now(),finished_at timestamptz,
 cancelled_by uuid references pulse.person(id),cancel_note text check(length(cancel_note)<=500)
);
create index flow_run_live on pulse.flow_run(org_id,status,started_at desc);
create index flow_run_process on pulse.flow_run(org_id,process_id);
create index flow_run_project on pulse.flow_run(org_id,project_id) where project_id is not null;
create table pulse.flow_run_step (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 run_id uuid not null references pulse.flow_run(id),step_key text not null check(length(step_key) between 1 and 40),position int not null,
 title text not null,module text not null,stage text,
 state text not null default 'waiting' check(state in ('waiting','open','in_progress','in_review','confirmed','done','skipped')),
 skipped_why text check(length(skipped_why)<=300),person_id uuid references pulse.person(id),assign_why text check(length(assign_why)<=300),
 task_id uuid references pulse.task(id),record_type text,record_id uuid,
 due_on date,opened_at timestamptz,started_at timestamptz,sent_at timestamptz,confirmed_at timestamptz,done_at timestamptz,
 rounds int not null default 0,checks int[] not null default '{}',blocked_at timestamptz,blocked_note text check(length(blocked_note)<=500),
 note text check(length(note)<=500),hours numeric(7,2),updated_at timestamptz not null default now(),
 unique(org_id,run_id,step_key)
);
create index flow_run_step_person on pulse.flow_run_step(org_id,person_id,state) where person_id is not null;
create index flow_run_step_task on pulse.flow_run_step(org_id,task_id) where task_id is not null;
create table pulse.flow_value (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 run_id uuid not null references pulse.flow_run(id),step_key text not null,port text not null check(length(port) between 1 and 40),
 side text not null check(side in ('makes','needs')),kind text not null,value jsonb not null default '{}',
 set_by uuid references pulse.person(id),set_at timestamptz not null default now(),
 unique(org_id,run_id,step_key,port,side)
);
create table pulse.flow_intake (
 org_id uuid not null references pulse.org(id),run_id uuid not null references pulse.flow_run(id),step_key text not null,
 key text not null check(key ~ '^[a-z0-9_]{1,40}$'),label text not null check(length(label)<=300),position int not null default 0,
 critical boolean not null default true,owner_role text check(length(owner_role)<=60),received_on date,note text check(length(note)<=500),
 set_by uuid references pulse.person(id),set_at timestamptz,
 primary key(org_id,run_id,step_key,key)
);
create table pulse.flow_step_event (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 run_id uuid not null references pulse.flow_run(id),step_key text,
 kind text not null check(kind in ('state','value','input','alert','nudge','assign','blocked','unblocked','clock','verdict','start','cancel','hours')),
 from_state text,to_state text,person_id uuid references pulse.person(id),actor uuid references pulse.person(id),
 at timestamptz not null default now(),meta jsonb not null default '{}'
);
create index flow_step_event_run on pulse.flow_step_event(org_id,run_id,at);
create index flow_step_event_person on pulse.flow_step_event(org_id,person_id,at) where person_id is not null;
create table pulse.flow_alert (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 run_id uuid not null references pulse.flow_run(id),rule_key text not null,step_key text not null default '',
 name text not null,detail text check(length(detail)<=500),fired_at timestamptz not null default now(),
 notified uuid[] not null default '{}',resolved_at timestamptz,
 unique(org_id,run_id,rule_key,step_key)
);
create index flow_alert_open on pulse.flow_alert(org_id,run_id) where resolved_at is null;

-- Records + links (the module backends).
create table pulse.flow_record_type (
 org_id uuid not null references pulse.org(id),key text not null check(key ~ '^[a-z][a-z0-9_]{1,39}$'),
 def jsonb not null check(jsonb_typeof(def)='object' and pg_column_size(def)<200000),
 created_by uuid references pulse.person(id),updated_at timestamptz not null default now(),archived_at timestamptz,
 primary key(org_id,key)
);
create table pulse.flow_record (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 type_key text not null check(type_key ~ '^[a-z][a-z0-9_]{1,39}$'),
 run_id uuid references pulse.flow_run(id),step_key text,project_id uuid references pulse.project(id),client_id uuid references pulse.client(id),
 title text not null check(length(btrim(title)) between 1 and 300),status text not null check(length(status) between 1 and 40),
 code text check(length(code)<=120),data jsonb not null default '{}' check(jsonb_typeof(data)='object' and pg_column_size(data)<2000000),
 source jsonb check(source is null or jsonb_typeof(source)='object'),version int not null default 1,
 frozen_at timestamptz,frozen_by uuid references pulse.person(id),
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),archived_at timestamptz
);
create index flow_record_run on pulse.flow_record(org_id,run_id,type_key) where archived_at is null;
create index flow_record_type_idx on pulse.flow_record(org_id,type_key,updated_at desc) where archived_at is null;
create unique index flow_record_code on pulse.flow_record(org_id,type_key,code) where code is not null and archived_at is null;
create table pulse.flow_link (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 from_id uuid not null references pulse.flow_record(id),to_id uuid not null references pulse.flow_record(id),
 kind text not null check(kind ~ '^[a-z][a-z0-9_]{0,39}$'),created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 unique(org_id,from_id,to_id,kind),check(from_id<>to_id)
);
create table pulse.flow_record_version (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),record_id uuid not null references pulse.flow_record(id),
 version int not null,title text not null,status text not null,data jsonb not null,note text check(length(note)<=300),
 saved_by uuid references pulse.person(id),saved_at timestamptz not null default now(),unique(org_id,record_id,version)
);
create table pulse.flow_comment (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),record_id uuid not null references pulse.flow_record(id),
 section text check(length(section)<=60),anchor text check(length(anchor)<=60),
 kind text not null default 'comment' check(kind in ('comment','change')),body text not null check(length(btrim(body)) between 1 and 4000),
 owner_id uuid references pulse.person(id),due_on date,done_at timestamptz,
 created_by uuid references pulse.person(id),created_at timestamptz not null default now(),resolved_at timestamptz
);
create index flow_comment_record on pulse.flow_comment(org_id,record_id,created_at);

-- Every staff member of the company reads Flow (runs, records); the API decides who designs and acts.
create function pulse.flow_staff() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and exists(select 1 from person where org_id=current_org() and id=current_viewer() and side='staff' and status='active')
$$;
do $$ declare t text;begin
 foreach t in array array['flow_process','flow_process_version','flow_run','flow_run_step','flow_value','flow_intake','flow_step_event','flow_alert',
   'flow_record_type','flow_record','flow_link','flow_record_version','flow_comment'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant_isolation on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select,insert,update on pulse.%I to pulse_api',t);
  execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
  execute format('create policy flow_read on pulse.%I as restrictive for select to pulse_api using(pulse.flow_staff())',t);
  execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;
grant delete on pulse.flow_link to pulse_api;

-- ---------------------------------------------------------------------------------------------------------------------
-- Working days (the company's week and its holidays), and Day N.
create function pulse.flow_is_workday(p_day date) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select extract(isodow from p_day)::int=any(coalesce((select work_days from hr_policy where org_id=current_org()),array[1,2,3,4,5,6]))
  and not exists(select 1 from holiday h where h.org_id=current_org() and h.day=p_day and not h.optional)
$$;
-- p_days working days after p_from (0: p_from itself, or the next working day when it is not one).
create function pulse.flow_workday_add(p_from date,p_days int) returns date language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare v_d date:=p_from;v_n int:=0;v_guard int:=0;
begin
 if p_from is null or p_days is null then return null;end if;
 if p_days<=0 then
  while not flow_is_workday(v_d) and v_guard<60 loop v_d:=v_d+1;v_guard:=v_guard+1;end loop;
  return v_d;
 end if;
 while v_n<p_days and v_guard<2000 loop v_d:=v_d+1;v_guard:=v_guard+1;if flow_is_workday(v_d) then v_n:=v_n+1;end if;end loop;
 return v_d;
end $$;
-- Working days in (p_from, p_to].
create function pulse.flow_workdays_between(p_from date,p_to date) returns int language sql stable security definer set search_path=pulse,pg_temp as $$
 select case when p_from is null or p_to is null or p_to<=p_from then 0 else
  (select count(*)::int from generate_series(p_from+1,p_to,interval '1 day') g(d) where flow_is_workday(g.d::date)) end
$$;
create function pulse.flow_today() returns date language sql stable security definer set search_path=pulse,pg_temp as $$
 select (now() at time zone org_time_zone())::date
$$;

create function pulse.flow_def_step(p_def jsonb,p_key text) returns jsonb language sql immutable as $$
 select x from jsonb_array_elements(coalesce(p_def->'steps','[]')) x where x->>'id'=p_key limit 1
$$;
-- Days that may differ per value of a variant field ({"starter":4,"growth":5,"sellout":6}).
create function pulse.flow_days(p_days jsonb,p_field text,p_fields jsonb) returns int language sql immutable as $$
 select case when jsonb_typeof(p_days)='number' then round((p_days#>>'{}')::numeric)::int
  when jsonb_typeof(p_days)='object' and jsonb_typeof(p_days->(p_fields->>p_field))='number' then round((p_days->>(p_fields->>p_field))::numeric)::int end
$$;
-- Variant filters: every condition holds (eq, ne, in, notin, filled, empty, gt, gte, lt, lte, contains).
create function pulse.flow_conds(p_conds jsonb,p_fields jsonb) returns boolean language plpgsql immutable as $$
declare v_c jsonb;v_a text;v_ok boolean;
begin
 if p_conds is null or jsonb_typeof(p_conds)<>'array' then return true;end if;
 for v_c in select x from jsonb_array_elements(p_conds) x loop
  v_a:=lower(coalesce(p_fields->(v_c->>'field')#>>'{}',''));
  v_ok:=case v_c->>'op'
   when 'in' then exists(select 1 from jsonb_array_elements_text(coalesce(v_c->'values','[]')) y where lower(y)=v_a)
   when 'notin' then not exists(select 1 from jsonb_array_elements_text(coalesce(v_c->'values','[]')) y where lower(y)=v_a)
   else workflow_cond(v_c,p_fields) end;
  if not coalesce(v_ok,false) then return false;end if;
 end loop;
 return true;
end $$;

-- When a step is due: N (working) days after the start, after another step is done or a date field; Day N after Day 1.
create function pulse.flow_step_due(p_run uuid,p_key text) returns date language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare r flow_run;v_due jsonb;v_from text;v_base date;v_days int;v_work boolean;
begin
 select * into r from flow_run where id=p_run;
 v_due:=flow_def_step(r.definition,p_key)->'due';
 if v_due is null or jsonb_typeof(v_due)<>'object' then return null;end if;
 v_from:=coalesce(v_due->>'from','start');
 v_days:=flow_days(v_due->'days',v_due->>'field',r.fields);
 if v_days is null then return null;end if;
 v_work:=coalesce((v_due->>'workdays')::boolean,true);
 if v_from='day1' then
  if r.day1 is null then return null;end if;
  return case when v_work then flow_workday_add(r.day1,greatest(v_days-1,0)) else r.day1+greatest(v_days-1,0) end;
 elsif v_from='start' then v_base:=(r.started_at at time zone org_time_zone())::date;
 elsif v_from like 'step:%' then select (s.done_at at time zone org_time_zone())::date into v_base from flow_run_step s where s.run_id=p_run and s.step_key=substr(v_from,6);
 elsif v_from like 'field:%' then begin v_base:=nullif(r.fields->>substr(v_from,7),'')::date;exception when others then v_base:=null;end;
 end if;
 if v_base is null then return null;end if;
 return case when v_work then flow_workday_add(v_base,v_days) else v_base+v_days end;
end $$;

create function pulse.flow_event(p_run uuid,p_key text,p_kind text,p_from text,p_to text,p_actor uuid,p_meta jsonb) returns void language sql security definer set search_path=pulse,pg_temp as $$
 insert into flow_step_event(org_id,run_id,step_key,kind,from_state,to_state,person_id,actor,meta)
 values(current_org(),p_run,p_key,p_kind,p_from,p_to,(select person_id from flow_run_step where run_id=p_run and step_key=p_key),coalesce(p_actor,current_viewer()),coalesce(p_meta,'{}'))
$$;

-- Due dates follow the clock and finished steps; an open task's due date follows its step.
create function pulse.flow_recompute_due(p_run uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_s record;v_due date;
begin
 for v_s in select id,step_key,due_on,task_id,state from flow_run_step where run_id=p_run and state<>'skipped' loop
  v_due:=flow_step_due(p_run,v_s.step_key);
  if v_due is distinct from v_s.due_on then
   update flow_run_step set due_on=v_due,updated_at=now() where id=v_s.id;
   if v_s.task_id is not null and v_s.state not in ('done') then
    update task set due_at=case when v_due is null then null else ((v_due+1)::timestamp at time zone org_time_zone())-interval '1 second' end,updated_at=now()
     where id=v_s.task_id and status not in ('done','accepted','cancelled');
   end if;
  end if;
 end loop;
end $$;

-- Who a step goes to: the person named for its role on this run, the person named on the step, whoever started the run,
-- or (live runs) the usual rules of the old engine (people on the project first, then the least loaded holder).
create function pulse.flow_pick(p_run pulse.flow_run,p_who jsonb,p_role_label text,out person uuid,out why text) language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare v_by text:=coalesce(nullif(p_who->>'by',''),'starter');v_bound text;v_fr workflow_run;v_pk record;
begin
 if v_by='role' then
  v_bound:=p_run.people->>(p_who->>'role');
  if v_bound ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' and exists(select 1 from person where org_id=current_org() and id=v_bound::uuid and status='active') then
   person:=v_bound::uuid;why:='Named for '||coalesce(p_role_label,p_who->>'role')||' on this run';return;
  end if;
 elsif v_by='person' then
  person:=nullif(p_who->>'personId','')::uuid;why:='Named on the step';return;
 elsif v_by='starter' then person:=p_run.started_by;why:='Whoever started the run';return;
 end if;
 if p_run.mode<>'live' then why:='Nobody named for '||coalesce(p_role_label,p_who->>'role','this step');return;end if;
 v_fr.org_id:=p_run.org_id;v_fr.id:=p_run.id;v_fr.project_id:=p_run.project_id;v_fr.started_by:=p_run.started_by;
 select * into v_pk from workflow_pick(jsonb_build_object('by',v_by,'role',p_role_label,'category',p_who->>'category'),p_role_label,p_who->>'category',v_fr);
 person:=v_pk.person;why:=v_pk.why;
end $$;

-- A wire's notify roles hear that a value landed (inform and tag, not gates). Live runs only.
create function pulse.flow_notify(p_run pulse.flow_run,p_person uuid,p_type text,p_key text,p_title text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if p_person is null or p_run.mode<>'live' then return;end if;
 perform notification_emit(p_person,p_type,'flow_run',p_run.id,left(p_key,200),left(p_title,160),'/runs/'||p_run.id,'task');
end $$;
create function pulse.flow_role_person(p_run pulse.flow_run,p_role text) returns uuid language sql stable as $$
 select case when p_run.people->>p_role ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (p_run.people->>p_role)::uuid end
$$;

-- A value lands on a port. A step's Makes value travels every wire from that port to the Needs it feeds (a "many" port
-- collects them), and the wire's notify roles are told.
create function pulse.flow_value_put(p_run uuid,p_step text,p_port text,p_side text,p_kind text,p_value jsonb,p_by uuid) returns void
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
   perform flow_notify(r,flow_role_person(r,v_role),'flow.wire',p_step||'>'||v_to||':'||v_role,
    coalesce(v_from_title,p_step)||' is ready for '||coalesce(v_title,v_to)||coalesce(' · '||r.name,''));
  end loop;
 end loop;
end $$;

-- Is a step ready? 'ready': every required Needs port is filled (a need whose every wire comes from a step skipped for
-- this run is not waited on); 'dead': a required need can only come from a branch that was not chosen (a finished step
-- that left that port empty), so the step is skipped; 'waiting' otherwise.
create function pulse.flow_step_readiness(p_run uuid,p_key text) returns text language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare r flow_run;v_n jsonb;v_has boolean;v_wired int;v_got int;v_pending int;v_dead int;v_direct boolean;v_many boolean;
begin
 select * into r from flow_run where id=p_run;
 for v_n in select x from jsonb_array_elements(coalesce(r.compiled->'steps'->p_key->'needs','[]')) x loop
  if not coalesce((v_n->>'required')::boolean,true) then continue;end if;
  v_many:=coalesce((v_n->>'many')::boolean,false);
  v_has:=exists(select 1 from flow_value v where v.run_id=p_run and v.step_key=p_key and v.port=v_n->>'key' and v.side='needs');
  v_direct:=exists(select 1 from jsonb_array_elements(coalesce(flow_def_step(r.definition,p_key)->'inputs','[]')) i where i->>'port'=v_n->>'key');
  -- Each wire's source: delivered (its Makes value is there), pending (still to come), dead (finished without it: a branch
  -- not chosen), or skipped for this run.
  select count(*),
    count(*) filter(where exists(select 1 from flow_value v where v.run_id=p_run and v.step_key=w->'from'->>'step' and v.port=w->'from'->>'port' and v.side='makes')),
    count(*) filter(where coalesce(s.state,'waiting') not in ('done','skipped')),
    count(*) filter(where s.state='done' and not exists(select 1 from flow_value v where v.run_id=p_run and v.step_key=w->'from'->>'step' and v.port=w->'from'->>'port' and v.side='makes'))
   into v_wired,v_got,v_pending,v_dead
   from jsonb_array_elements(coalesce(r.definition->'wires','[]')) w left join flow_run_step s on s.run_id=p_run and s.step_key=w->'from'->>'step'
   where w->'to'->>'step'=p_key and w->'to'->>'port'=v_n->>'key';
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
  if v_direct then return 'waiting';end if;   -- every source skipped: whoever owns it types it in
 end loop;
 return 'ready';
end $$;

-- A Hand-off step starts the run of the live process it names, with the same client, project, fields and people.
create function pulse.flow_handoff(p_run pulse.flow_run,p_def jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_pid uuid;v_ver flow_process_version;
begin
 begin v_pid:=nullif(p_def->'settings'->>'processId','')::uuid;exception when others then return;end;
 if v_pid is null then return;end if;
 select v.* into v_ver from flow_process_version v join flow_process fp on fp.id=v.process_id and fp.version=v.version where fp.org_id=current_org() and fp.id=v_pid and fp.status='live';
 if not found then return;end if;
 perform flow_start(jsonb_build_object('processId',v_pid,'version',v_ver.version,'definition',v_ver.definition,'compiled',v_ver.compiled,'name',p_run.name,
  'projectId',p_run.project_id,'clientId',p_run.client_id,'fields',p_run.fields,'people',p_run.people,'mode',p_run.mode,'startedBy',p_run.started_by));
end $$;

-- A step's data is in: it opens for its person (a Work task in a live run); a step that finishes by itself does so.
create function pulse.flow_step_open(p_step uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare st flow_run_step;r flow_run;v_d jsonb;v_cp jsonb;v_pk record;v_tid uuid;v_prev text:=current_setting('pulse.viewer_id',true);
 v_role text;v_label text;v_notes text;v_cat text;v_proc text;v_check text;
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
  for v_check in select jsonb_array_elements_text(coalesce(v_d->'settings'->'roles','[]')) loop
   perform flow_notify(r,flow_role_person(r,v_check),'flow.wire',st.step_key||':notify:'||v_check,left(coalesce(nullif(v_d->'settings'->>'text',''),st.title)||' · '||r.name,160));
  end loop;
 elsif st.module='handoff' then perform flow_handoff(r,v_d);
 end if;
 if v_cp->>'finish'='auto' then perform flow_step_finish(p_step,'{}',null);return;end if;
 if v_cp->>'finish'='timer' then return;end if;
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

-- Open every step whose data is in; the run is done when every step is done or skipped.
create function pulse.flow_run_settle(p_run uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r flow_run;v_s record;v_moved boolean:=true;v_guard int:=0;v_ready text;
begin
 perform pg_advisory_xact_lock(hashtext('flow-run:'||p_run::text));
 while v_moved and v_guard<200 loop
  v_moved:=false;v_guard:=v_guard+1;
  for v_s in select id,step_key from flow_run_step where run_id=p_run and state='waiting' order by position loop
   select * into r from flow_run where id=p_run;
   if r.status<>'running' then return;end if;
   v_ready:=flow_step_readiness(p_run,v_s.step_key);
   if v_ready='ready' then perform flow_step_open(v_s.id);v_moved:=true;
   elsif v_ready='dead' then
    update flow_run_step set state='skipped',skipped_why='Not on the way chosen',updated_at=now() where id=v_s.id;
    perform flow_event(p_run,v_s.step_key,'state','waiting','skipped',null,'{}');v_moved:=true;
   end if;
  end loop;
 end loop;
 perform flow_recompute_due(p_run);
 select * into r from flow_run where id=p_run;
 if r.status='running' and not exists(select 1 from flow_run_step where run_id=p_run and state not in ('done','skipped')) then
  update flow_run set status='done',finished_at=now() where id=p_run;
  perform flow_notify(r,r.started_by,'flow.done',p_run||':done','Done: '||left(r.name,120));
 end if;
end $$;

-- A step is finished: its outputs land on its Makes ports (a value given, else its record, else "done"), its task is
-- done, and whatever was waiting on them opens.
create function pulse.flow_step_finish(p_step uuid,p_outputs jsonb,p_by uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare st flow_run_step;r flow_run;v_m jsonb;v_val jsonb;
begin
 select * into st from flow_run_step where id=p_step for update;
 if st.state in ('done','skipped') then return;end if;
 select * into r from flow_run where id=st.run_id;
 if r.status<>'running' then raise exception 'This run has finished' using errcode='22023';end if;
 update flow_run_step set state='done',done_at=now(),opened_at=coalesce(opened_at,now()),blocked_at=null,updated_at=now() where id=p_step;
 perform flow_event(r.id,st.step_key,'state',st.state,'done',p_by,'{}');
 for v_m in select x from jsonb_array_elements(coalesce(r.compiled->'steps'->st.step_key->'makes','[]')) x loop
  if coalesce((r.compiled->'steps'->st.step_key->>'branch')::boolean,false) and not p_outputs ? (v_m->>'key') then continue;end if;
  v_val:=coalesce(p_outputs->(v_m->>'key'),
   case when st.record_id is not null then jsonb_build_object('recordType',st.record_type,'recordId',st.record_id) end,
   jsonb_build_object('done',true));
  v_val:=v_val||jsonb_build_object('at',now(),'by',coalesce(p_by,st.person_id));
  perform flow_value_put(r.id,st.step_key,v_m->>'key','makes',v_m->>'kind',v_val,coalesce(p_by,st.person_id));
 end loop;
 if st.task_id is not null then
  update task set status='done',done_at=coalesce(done_at,now()),updated_at=now() where id=st.task_id and status not in ('done','accepted','cancelled');
 end if;
 perform flow_run_settle(r.id);
end $$;

-- The doer moves a step: started, sent for review (a round), changes asked (back to in progress), confirmed; reopened.
create function pulse.flow_step_move(p_step uuid,p_to text,p_by uuid,p_note text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare st flow_run_step;r flow_run;
begin
 select * into st from flow_run_step where id=p_step for update;
 select * into r from flow_run where id=st.run_id;
 if r.status<>'running' then raise exception 'This run has finished' using errcode='22023';end if;
 if st.state='waiting' then raise exception 'This step is waiting for its data' using errcode='22023';end if;
 if st.state='skipped' then raise exception 'This step is skipped for this run' using errcode='22023';end if;
 if not (p_to='in_progress' and st.state in ('open','in_review','confirmed','done') or p_to='in_review' and st.state in ('open','in_progress','confirmed')
   or p_to='confirmed' and st.state in ('in_review','in_progress','open') or p_to='open' and st.state in ('in_progress')) then
  raise exception 'A step cannot go from % to %',st.state,p_to using errcode='22023';
 end if;
 update flow_run_step set state=p_to,updated_at=now(),
  started_at=case when p_to='in_progress' then coalesce(started_at,now()) else started_at end,
  sent_at=case when p_to='in_review' then now() else sent_at end,
  rounds=rounds+case when p_to='in_review' then 1 else 0 end,
  confirmed_at=case when p_to='confirmed' then now() else confirmed_at end,
  done_at=case when st.state='done' then null else done_at end,
  note=coalesce(nullif(left(btrim(coalesce(p_note,'')),500),''),note) where id=p_step;
 perform flow_event(r.id,st.step_key,'state',st.state,p_to,p_by,case when p_note is null then '{}' else jsonb_build_object('note',left(p_note,500)) end);
 if st.task_id is not null then
  update task set status=case when p_to='open' then 'open' else 'in_progress' end,started_at=coalesce(started_at,now()),done_at=null,updated_at=now()
   where id=st.task_id and status is distinct from case when p_to='open' then 'open' else 'in_progress' end and status<>'cancelled';
 end if;
end $$;

-- A verdict (an approval, a confirmation, a choice) is recorded with who and when on the step's verdict ports. Nothing
-- waits on it unless a step Needs it; a step that finishes with its verdict is done.
create function pulse.flow_step_verdict(p_step uuid,p_answer text,p_note text,p_by uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare st flow_run_step;r flow_run;v_val jsonb;v_out jsonb:='{}';v_m jsonb;
begin
 select * into st from flow_run_step where id=p_step for update;
 select * into r from flow_run where id=st.run_id;
 if st.state in ('waiting','skipped','done') then raise exception 'This step is not open' using errcode='22023';end if;
 if coalesce(btrim(p_answer),'')='' then raise exception 'Choose an answer' using errcode='22023';end if;
 v_val:=jsonb_build_object('answer',left(btrim(p_answer),80),'note',nullif(left(btrim(coalesce(p_note,'')),500),''),'by',p_by,'at',now(),'round',greatest(st.rounds,1));
 perform flow_event(r.id,st.step_key,'verdict',st.state,null,p_by,v_val);
 if coalesce((r.compiled->'steps'->st.step_key->>'branch')::boolean,false) then
  -- A decision: the answer is one of its ports (by key or label); the first port is "yes", the last "otherwise".
  select x into v_m from jsonb_array_elements(r.compiled->'steps'->st.step_key->'makes') with ordinality q(x,i)
   where lower(x->>'key')=lower(btrim(p_answer)) or lower(x->>'label')=lower(btrim(p_answer)) order by i limit 1;
  if v_m is null then
   select x into v_m from jsonb_array_elements(r.compiled->'steps'->st.step_key->'makes') with ordinality q(x,i)
    order by case when lower(btrim(p_answer)) in ('yes','approved','confirmed','true') then i else -i end limit 1;
  end if;
  v_out:=jsonb_build_object(v_m->>'key',v_val);
  perform flow_step_finish(p_step,v_out,p_by);
  return;
 end if;
 for v_m in select x from jsonb_array_elements(coalesce(r.compiled->'steps'->st.step_key->'makes','[]')) x where x->>'kind' in ('verdict','any') loop
  v_out:=v_out||jsonb_build_object(v_m->>'key',v_val);
 end loop;
 if lower(btrim(p_answer)) in ('changes','send back','changes asked','not yet') then
  perform flow_step_move(p_step,'in_progress',p_by,coalesce(p_note,'Changes asked'));
  return;
 end if;
 if st.state<>'confirmed' and lower(btrim(p_answer)) in ('confirmed','approved','yes','accepted') then
  update flow_run_step set confirmed_at=now(),state='confirmed',updated_at=now() where id=p_step;
 end if;
 if r.compiled->'steps'->st.step_key->>'finish' in ('verdict','output','person') then perform flow_step_finish(p_step,v_out,p_by);end if;
end $$;

-- Someone types in (or uploads) what a step needs; the step opens if that was the last thing it waited for.
create function pulse.flow_input_put(p_run uuid,p_step text,p_port text,p_kind text,p_value jsonb,p_by uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from flow_run where id=p_run and status='running') then raise exception 'This run has finished' using errcode='22023';end if;
 perform flow_value_put(p_run,p_step,p_port,'needs',p_kind,p_value,p_by);
 perform flow_run_settle(p_run);
end $$;

-- The sprint clock: with clock.from = 'intake', Day 1 is the day the last critical intake item came in; 'field': a
-- date field of the run; 'start': the day the run started. When every critical item is in, the intake step is done.
create function pulse.flow_clock(p_run uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r flow_run;v_from text;v_step text;v_day date;v_all boolean;st flow_run_step;
begin
 select * into r from flow_run where id=p_run;
 v_from:=coalesce(r.definition->'clock'->>'from','start');
 if v_from='intake' then
  v_step:=r.definition->'clock'->>'step';
  select bool_and(received_on is not null),max(received_on) into v_all,v_day from flow_intake where run_id=p_run and step_key=v_step and critical;
  if not coalesce(v_all,false) then v_day:=null;end if;
 elsif v_from='field' then begin v_day:=nullif(r.fields->>(r.definition->'clock'->>'field'),'')::date;exception when others then v_day:=null;end;
 else v_day:=(r.started_at at time zone org_time_zone())::date;
 end if;
 if v_day is not null then v_day:=flow_workday_add(v_day,0);end if;
 if v_day is distinct from r.day1 then
  update flow_run set day1=v_day where id=p_run;
  perform flow_event(p_run,null,'clock',null,null,null,jsonb_build_object('day1',v_day,'was',r.day1));
  perform flow_recompute_due(p_run);
 end if;
 if v_from='intake' and v_day is not null then
  select * into st from flow_run_step where run_id=p_run and step_key=v_step;
  if found and st.state not in ('done','skipped','waiting') then
   perform flow_step_finish(st.id,(select jsonb_build_object(coalesce((select x->>'key' from jsonb_array_elements(coalesce(r.compiled->'steps'->v_step->'makes','[]')) x limit 1),'inputs'),
     jsonb_build_object('items',jsonb_agg(jsonb_build_object('key',i.key,'label',i.label,'on',i.received_on) order by i.position))) from flow_intake i where i.run_id=p_run and i.step_key=v_step),null);
  end if;
 end if;
end $$;
create function pulse.flow_intake_set(p_run uuid,p_step text,p_key text,p_on date,p_note text,p_by uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 update flow_intake set received_on=p_on,note=coalesce(nullif(left(btrim(coalesce(p_note,'')),500),''),note),set_by=p_by,set_at=now()
  where run_id=p_run and step_key=p_step and key=p_key;
 if not found then raise exception 'Intake item not found' using errcode='P0002';end if;
 perform flow_event(p_run,p_step,'input',null,null,p_by,jsonb_build_object('item',p_key,'on',p_on));
 perform flow_clock(p_run);
 perform flow_run_settle(p_run);
end $$;

-- Start a run on a published version (the API passes the version's definition and compiled ports, the variant fields,
-- the people named per role and any values typed in at the start).
create function pulse.flow_start(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_rid uuid;v_def jsonb:=p->'definition';v_fields jsonb:=coalesce(p->'fields','{}');v_x jsonb;v_i int:=0;v_item jsonb;v_j int;
begin
 insert into flow_run(org_id,process_id,version,definition,compiled,name,project_id,client_id,fields,people,mode,started_by)
 values(current_org(),(p->>'processId')::uuid,(p->>'version')::int,v_def,p->'compiled',left(btrim(p->>'name'),300),nullif(p->>'projectId','')::uuid,nullif(p->>'clientId','')::uuid,
  v_fields,coalesce(p->'people','{}'),coalesce(p->>'mode','live'),nullif(p->>'startedBy','')::uuid) returning id into v_rid;
 for v_x in select x from jsonb_array_elements(coalesce(v_def->'steps','[]')) x loop
  v_i:=v_i+1;
  insert into flow_run_step(org_id,run_id,step_key,position,title,module,stage,state,skipped_why,hours)
  values(current_org(),v_rid,v_x->>'id',v_i,left(coalesce(nullif(btrim(v_x->>'title'),''),'Step '||v_i),300),coalesce(v_x->>'module','checklist'),v_x->>'stage',
   case when flow_conds(v_x->'when',v_fields) then 'waiting' else 'skipped' end,
   case when flow_conds(v_x->'when',v_fields) then null else left(coalesce(p->'compiled'->'steps'->(v_x->>'id')->>'skipWords','Not part of this run'),300) end,
   case when jsonb_typeof(v_x->'hours')='number' then (v_x->>'hours')::numeric when jsonb_typeof(v_x->'hours')='object' then nullif(v_x->'hours'->>(v_fields->>coalesce(p->'compiled'->>'variant','')),'')::numeric end);
  v_j:=0;
  for v_item in select y from jsonb_array_elements(case when jsonb_typeof(v_x->'settings'->'items')='array' then v_x->'settings'->'items' else '[]' end) y loop
   v_j:=v_j+1;
   if flow_conds(v_item->'when',v_fields) then
    insert into flow_intake(org_id,run_id,step_key,key,label,position,critical,owner_role)
    values(current_org(),v_rid,v_x->>'id',v_item->>'key',left(v_item->>'label',300),v_j,coalesce((v_item->>'critical')::boolean,true),nullif(v_item->>'owner',''))
    on conflict do nothing;
   end if;
  end loop;
 end loop;
 perform flow_event(v_rid,null,'start',null,null,nullif(p->>'startedBy','')::uuid,jsonb_build_object('fields',v_fields));
 perform audit_write('start','flow_run',v_rid::text);
 for v_x in select x from jsonb_array_elements(coalesce(p->'values','[]')) x loop
  perform flow_value_put(v_rid,v_x->>'step',v_x->>'port','needs',coalesce(v_x->>'kind','any'),coalesce(v_x->'value','{}'),nullif(p->>'startedBy','')::uuid);
 end loop;
 perform flow_clock(v_rid);
 perform flow_run_settle(v_rid);
 return v_rid;
end $$;

create function pulse.flow_run_cancel(p_run uuid,p_note text,p_by uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r flow_run;
begin
 select * into r from flow_run where org_id=current_org() and id=p_run for update;
 if not found then raise exception 'Run not found' using errcode='P0002';end if;
 if r.status<>'running' then raise exception 'This run has finished' using errcode='22023';end if;
 update flow_run set status='cancelled',finished_at=now(),cancelled_by=p_by,cancel_note=nullif(left(btrim(coalesce(p_note,'')),500),'') where id=p_run;
 update task set status='cancelled',updated_at=now(),edited_by=p_by where id in (select task_id from flow_run_step where run_id=p_run and task_id is not null)
  and status not in ('done','accepted','cancelled');
 perform flow_event(p_run,null,'cancel',null,null,p_by,jsonb_build_object('note',p_note));
 perform audit_write('cancel','flow_run',p_run::text);
end $$;

-- Finishing (or starting) a step's task moves the step, whichever way the task was moved.
create function pulse.flow_task_follow() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare st flow_run_step;
begin
 if new.source<>'flow' or new.status is not distinct from old.status then return null;end if;
 select * into st from flow_run_step where org_id=new.org_id and task_id=new.id;
 if not found or st.state in ('done','skipped') then return null;end if;
 begin
  if new.status in ('done','accepted') then perform flow_step_finish(st.id,'{}',coalesce(current_viewer(),new.assignee_person_id));
  elsif new.status='in_progress' and st.state='open' then
   update flow_run_step set state='in_progress',started_at=coalesce(started_at,now()),updated_at=now() where id=st.id;
   perform flow_event(st.run_id,st.step_key,'state','open','in_progress',current_viewer(),'{}');
  elsif new.status='cancelled' then update flow_run_step set note=coalesce(note,'Its task was cancelled') where id=st.id;
  end if;
 exception when others then
  raise warning 'flow step % did not move: %',st.id,sqlerrm;
  update flow_run_step set note='Could not move on: '||left(sqlerrm,200) where id=st.id;
 end;
 return null;
end $$;
create trigger flow_task_follow after update of status on pulse.task for each row execute function pulse.flow_task_follow();

-- ---------------------------------------------------------------------------------------------------------------------
-- Alerts. Who hears an alert: role keys (the person named for the role on the run), 'doer', 'starter', 'data-owner'
-- (whoever owes the data a waiting step needs: the person or role of the step that makes it, or the input's owner).
create function pulse.flow_alert_targets(p_run pulse.flow_run,p_notify jsonb,p_step text) returns uuid[] language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare v_t text;v_out uuid[]:='{}';v_n jsonb;v_w jsonb;v_src flow_run_step;v_d jsonb;
begin
 for v_t in select jsonb_array_elements_text(coalesce(p_notify,'[]')) loop
  if v_t='doer' then v_out:=v_out||(select person_id from flow_run_step where run_id=p_run.id and step_key=p_step);
  elsif v_t='starter' then v_out:=v_out||p_run.started_by;
  elsif v_t='data-owner' and p_step is not null then
   for v_n in select x from jsonb_array_elements(coalesce(p_run.compiled->'steps'->p_step->'needs','[]')) x loop
    if exists(select 1 from flow_value v where v.run_id=p_run.id and v.step_key=p_step and v.port=v_n->>'key' and v.side='needs') then continue;end if;
    for v_w in select x from jsonb_array_elements(coalesce(p_run.definition->'wires','[]')) x where x->'to'->>'step'=p_step and x->'to'->>'port'=v_n->>'key' loop
     select * into v_src from flow_run_step where run_id=p_run.id and step_key=v_w->'from'->>'step';
     v_d:=flow_def_step(p_run.definition,v_w->'from'->>'step');
     v_out:=v_out||coalesce(v_src.person_id,flow_role_person(p_run,v_d->'who'->>'role'));
    end loop;
    for v_w in select x from jsonb_array_elements(coalesce(flow_def_step(p_run.definition,p_step)->'inputs','[]')) x where x->>'port'=v_n->>'key' loop
     v_out:=v_out||case when v_w->'owner'->>'by'='person' then nullif(v_w->'owner'->>'personId','')::uuid else flow_role_person(p_run,v_w->'owner'->>'role') end;
    end loop;
   end loop;
  else v_out:=v_out||flow_role_person(p_run,v_t);
  end if;
 end loop;
 return (select coalesce(array_agg(distinct x),'{}') from unnest(v_out) x where x is not null);
end $$;

create function pulse.flow_alert_fire(p_run pulse.flow_run,p_rule jsonb,p_step text,p_detail text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v_id uuid;v_to uuid[];v_p uuid;v_title text;
begin
 insert into flow_alert(org_id,run_id,rule_key,step_key,name,detail) values(current_org(),p_run.id,p_rule->>'key',coalesce(p_step,''),left(coalesce(p_rule->>'name',p_rule->>'key'),200),left(p_detail,500))
  on conflict(org_id,run_id,rule_key,step_key) do update set resolved_at=null where flow_alert.resolved_at is not null
  returning id into v_id;
 if v_id is null then return;end if;
 if exists(select 1 from flow_alert where id=v_id and cardinality(notified)>0) then return;end if;
 v_to:=flow_alert_targets(p_run,p_rule->'notify',p_step);
 v_title:=left(coalesce(p_rule->>'name','Alert')||': '||coalesce(p_detail,'')||' · '||p_run.name,160);
 foreach v_p in array v_to loop perform flow_notify(p_run,v_p,'flow.alert','alert:'||v_id,v_title);end loop;
 update flow_alert set notified=v_to where id=v_id;
 perform flow_event(p_run.id,nullif(p_step,''),'alert',null,null,null,jsonb_build_object('rule',p_rule->>'key','detail',p_detail));
end $$;

-- Each minute (the worker): every alert rule of every running run. An alert fires once per run, rule and step; one
-- whose condition no longer holds is resolved.
create function pulse.flow_tick(p_now timestamptz default now()) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r flow_run;v_rule jsonb;v_s record;v_today date:=(p_now at time zone org_time_zone())::date;v_hits text[];v_fired int:=0;v_n int;
 v_limit date;v_days int;v_wait int;v_since timestamptz;v_steps jsonb;
begin
 for v_s in select st.id from flow_run_step st join flow_run fr on fr.id=st.run_id where st.org_id=current_org() and fr.status='running' and st.state='open'
   and fr.compiled->'steps'->st.step_key->>'finish'='timer'
   and st.opened_at+make_interval(mins=>round(coalesce(nullif(fr.compiled->'steps'->st.step_key->>'hours','')::numeric,24)*60)::int)<=p_now loop
  perform flow_step_finish(v_s.id,'{}',null);
 end loop;
 for r in select * from flow_run where org_id=current_org() and status='running' loop
  v_hits:='{}';
  for v_rule in select x from jsonb_array_elements(coalesce(r.definition->'rules','[]')) x loop
   if not flow_conds(v_rule->'when2',r.fields) then continue;end if;
   v_steps:=case when jsonb_typeof(v_rule->'steps')='array' and jsonb_array_length(v_rule->'steps')>0 then v_rule->'steps' end;
   v_wait:=coalesce(round((v_rule->>'waitDays')::numeric)::int,1);
   if v_rule->>'when'='not-done-by-due' then
    for v_s in select step_key,title,due_on from flow_run_step where run_id=r.id and state not in ('done','skipped') and due_on<v_today
      and (v_steps is null or step_key in (select jsonb_array_elements_text(v_steps))) loop
     v_hits:=v_hits||(v_rule->>'key'||'|'||v_s.step_key);perform flow_alert_fire(r,v_rule,v_s.step_key,v_s.title||' was due '||to_char(v_s.due_on,'DD Mon'));
    end loop;
   elsif v_rule->>'when'='not-done-by-day' then
    v_days:=flow_days(v_rule->'days',v_rule->>'field',r.fields);
    if r.day1 is null or v_days is null then continue;end if;
    v_limit:=case when coalesce((v_rule->>'workdays')::boolean,true) then flow_workday_add(r.day1,greatest(v_days-1,0)) else r.day1+greatest(v_days-1,0) end;
    if v_today<=v_limit then continue;end if;
    for v_s in select step_key,title from flow_run_step where run_id=r.id and state not in ('done','skipped') and (v_steps is null or step_key in (select jsonb_array_elements_text(v_steps))) loop
     v_hits:=v_hits||(v_rule->>'key'||'|'||v_s.step_key);perform flow_alert_fire(r,v_rule,v_s.step_key,v_s.title||' not done by Day '||v_days);
    end loop;
   elsif v_rule->>'when'='in-state-longer' then
    for v_s in select step_key,title,state,case state when 'in_review' then sent_at when 'confirmed' then confirmed_at when 'in_progress' then coalesce(started_at,opened_at) when 'open' then opened_at else updated_at end since
      from flow_run_step where run_id=r.id and state=coalesce(v_rule->>'state','in_review') and (v_steps is null or step_key in (select jsonb_array_elements_text(v_steps))) loop
     if v_s.since is null then continue;end if;
     if (v_rule ? 'hours' and p_now-v_s.since>make_interval(mins=>round((v_rule->>'hours')::numeric*60)::int))
       or (not v_rule ? 'hours' and flow_workdays_between((v_s.since at time zone org_time_zone())::date,v_today)>v_wait) then
      v_hits:=v_hits||(v_rule->>'key'||'|'||v_s.step_key);perform flow_alert_fire(r,v_rule,v_s.step_key,v_s.title||' has been '||lower(replace(v_s.state,'_',' '))||' since '||to_char(v_s.since at time zone org_time_zone(),'DD Mon'));
     end if;
    end loop;
   elsif v_rule->>'when'='field-missing-by' then
    begin v_limit:=nullif(r.fields->>(v_rule->>'field'),'')::date;exception when others then v_limit:=null;end;
    if v_limit is null or v_today<v_limit then continue;end if;
    if (v_rule ? 'missing' and exists(select 1 from flow_intake i where i.run_id=r.id and i.step_key=v_rule->>'missing' and i.critical and i.received_on is null))
      or (v_rule ? 'missing' and not exists(select 1 from flow_intake i where i.run_id=r.id and i.step_key=v_rule->>'missing') and coalesce(r.fields->>(v_rule->>'missing'),'')='') then
     select count(*) into v_n from flow_intake i where i.run_id=r.id and i.step_key=v_rule->>'missing' and i.critical and i.received_on is null;
     v_hits:=v_hits||(v_rule->>'key'||'|'||coalesce(v_rule->>'missing',''));
     perform flow_alert_fire(r,v_rule,v_rule->>'missing',case when v_n>0 then v_n||' critical input'||case when v_n=1 then '' else 's' end||' not in' else 'Not filled' end||' by '||to_char(v_limit,'DD Mon'));
    end if;
   elsif v_rule->>'when'='value-missing-after' then
    select done_at into v_since from flow_run_step where run_id=r.id and step_key=v_rule->>'after' and state='done';
    if v_since is null then continue;end if;
    select step_key,title into v_s from flow_run_step where run_id=r.id and step_key=v_rule->>'missing' and state not in ('done','skipped');
    if not found then continue;end if;
    if (v_rule ? 'hours' and p_now-v_since>make_interval(mins=>round((v_rule->>'hours')::numeric*60)::int))
      or (not v_rule ? 'hours' and flow_workdays_between((v_since at time zone org_time_zone())::date,v_today)>coalesce(round((v_rule->>'waitDays')::numeric)::int,0)) then
     v_hits:=v_hits||(v_rule->>'key'||'|'||v_s.step_key);perform flow_alert_fire(r,v_rule,v_s.step_key,v_s.title||' not done after '||(select title from flow_run_step where run_id=r.id and step_key=v_rule->>'after'));
    end if;
   elsif v_rule->>'when'='blocked-longer' then
    -- Blocked: data = marked blocked, or still waiting for its data past its due date.
    for v_s in select step_key,title,coalesce(blocked_at,(due_on::timestamp at time zone org_time_zone())) since from flow_run_step
      where run_id=r.id and state not in ('done','skipped') and (blocked_at is not null or (state='waiting' and due_on<v_today))
      and (v_steps is null or step_key in (select jsonb_array_elements_text(v_steps))) loop
     if flow_workdays_between((v_s.since at time zone org_time_zone())::date,v_today)>v_wait then
      v_hits:=v_hits||(v_rule->>'key'||'|'||v_s.step_key);perform flow_alert_fire(r,v_rule,v_s.step_key,v_s.title||' is blocked on data');
     end if;
    end loop;
   elsif v_rule->>'when'='record-in-status-longer' then
    for v_s in select id::text step_key,title,updated_at since from flow_record where run_id=r.id and type_key=v_rule->>'recordType' and status=v_rule->>'status' and archived_at is null loop
     if flow_workdays_between((v_s.since at time zone org_time_zone())::date,v_today)>v_wait then
      v_hits:=v_hits||(v_rule->>'key'||'|'||v_s.step_key);perform flow_alert_fire(r,v_rule,v_s.step_key,v_s.title);
     end if;
    end loop;
   end if;
  end loop;
  update flow_alert set resolved_at=p_now where run_id=r.id and resolved_at is null and not (rule_key||'|'||step_key)=any(v_hits);
  v_fired:=v_fired+coalesce(cardinality(v_hits),0);
 end loop;
 return jsonb_build_object('active',v_fired);
end $$;

-- Notifications: a wire's value landing (to the roles it tags), an alert, a run done.
alter table pulse.notification drop constraint notification_subject_type_check;
do $$
declare v_def text;v_new text;
begin
 select pg_get_constraintdef(oid) into v_def from pg_constraint where conname='notification_event_type_check' and conrelid='pulse.notification'::regclass;
 v_new:=replace(v_def,'''workflow.done''::text','''workflow.done''::text, ''flow.wire''::text, ''flow.alert''::text, ''flow.done''::text');
 if v_new=v_def then raise exception 'notification_event_type_check changed shape';end if;
 execute 'alter table pulse.notification drop constraint notification_event_type_check';
 execute 'alter table pulse.notification add constraint notification_event_type_check '||v_new;
end $$;
alter table pulse.notification add constraint notification_subject_type_check check(subject_type in ('person','message','hr_flow','task','policy','holiday','payroll_notice','project','work_ask','comment','work_domain','kudos','workflow_run','flow_run'));
do $$
declare v_def text;v_new text;
begin
 v_def:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 v_new:=replace(v_def,' elsif p_type=''policy.published'' then',
 ' elsif p_type in (''flow.wire'',''flow.alert'',''flow.done'') then
  return p_subject=''flow_run'' and exists(select 1 from flow_run r where r.org_id=current_org() and r.id=p_id and r.mode=''live'')
   and exists(select 1 from person p where p.org_id=current_org() and p.id=p_person and p.side=''staff'' and p.status=''active'');
 elsif p_type=''policy.published'' then');
 if v_new=v_def then raise exception 'notification_recipient_allowed changed shape';end if;
 execute v_new;
end $$;

revoke all on function pulse.flow_staff(),pulse.flow_is_workday(date),pulse.flow_workday_add(date,int),pulse.flow_workdays_between(date,date),pulse.flow_today(),
 pulse.flow_def_step(jsonb,text),pulse.flow_days(jsonb,text,jsonb),pulse.flow_conds(jsonb,jsonb),pulse.flow_step_due(uuid,text),pulse.flow_event(uuid,text,text,text,text,uuid,jsonb),
 pulse.flow_recompute_due(uuid),pulse.flow_pick(pulse.flow_run,jsonb,text),pulse.flow_notify(pulse.flow_run,uuid,text,text,text),pulse.flow_role_person(pulse.flow_run,text),
 pulse.flow_value_put(uuid,text,text,text,text,jsonb,uuid),pulse.flow_step_readiness(uuid,text),pulse.flow_handoff(pulse.flow_run,jsonb),pulse.flow_step_open(uuid),pulse.flow_run_settle(uuid),
 pulse.flow_step_finish(uuid,jsonb,uuid),pulse.flow_step_move(uuid,text,uuid,text),pulse.flow_step_verdict(uuid,text,text,uuid),pulse.flow_input_put(uuid,text,text,text,jsonb,uuid),
 pulse.flow_clock(uuid),pulse.flow_intake_set(uuid,text,text,date,text,uuid),pulse.flow_start(jsonb),pulse.flow_run_cancel(uuid,text,uuid),
 pulse.flow_alert_targets(pulse.flow_run,jsonb,text),pulse.flow_alert_fire(pulse.flow_run,jsonb,text,text),pulse.flow_tick(timestamptz) from public;
grant execute on function pulse.flow_staff(),pulse.flow_is_workday(date),pulse.flow_workday_add(date,int),pulse.flow_workdays_between(date,date),pulse.flow_today(),
 pulse.flow_def_step(jsonb,text),pulse.flow_days(jsonb,text,jsonb),pulse.flow_conds(jsonb,jsonb),pulse.flow_step_due(uuid,text),pulse.flow_event(uuid,text,text,text,text,uuid,jsonb),
 pulse.flow_recompute_due(uuid),pulse.flow_value_put(uuid,text,text,text,text,jsonb,uuid),pulse.flow_step_readiness(uuid,text),pulse.flow_run_settle(uuid),
 pulse.flow_step_finish(uuid,jsonb,uuid),pulse.flow_step_move(uuid,text,uuid,text),pulse.flow_step_verdict(uuid,text,text,uuid),pulse.flow_input_put(uuid,text,text,text,jsonb,uuid),
 pulse.flow_clock(uuid),pulse.flow_intake_set(uuid,text,text,date,text,uuid),pulse.flow_start(jsonb),pulse.flow_run_cancel(uuid,text,uuid),pulse.flow_tick(timestamptz) to pulse_api;
grant execute on function pulse.flow_staff(),pulse.flow_tick(timestamptz) to pulse_worker;

-- migrate:down
-- Forward-only: processes, runs and records are kept.
