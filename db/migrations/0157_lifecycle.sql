-- migrate:up
-- LIFECYCLE (owner, 11 Oct 2026): hiring, leaving and the people mechanism of the company.
-- * A person moves Candidate → Offer → Joining → Probation → Active → Notice → Left (resigned, terminated, contract
--   ended; a candidate who never joins is "did not join"). Re-hire starts again from Left. Every move is dated,
--   attributed and kept; a role, pod or department change is kept the same way, whichever screen made it.
-- * Joining and leaving each open a case with a checklist. A step's state is read from the data (a task still open,
--   a session still live), so the checklist never claims more than is true; HR confirms each proposal with one click.
--   Google Workspace steps are an admin's ticks only: Pulse never changes Workspace.
-- * Leavers become alumni: not current (person.status), so they drop out of counts, groups, pickers and attendance
--   gaps, while every task, delivery and message stays. Groups keep them as former members.
-- * "Possibly left" proposals come from evidence (Workspace, attendance and work, HR sheets, exit mails, the roster
--   import) and wait for HR in a review list; nothing changes until HR confirms. Nothing here deletes a person or
--   their history, sends a message or an invitation.

-- 1. Stages and their history --------------------------------------------------------------------------------------
create table pulse.person_lifecycle (
 org_id uuid not null references pulse.org(id),
 person_id uuid primary key references pulse.person(id),
 stage text not null check(stage in ('candidate','offer','joining','probation','active','notice','left')),
 since date not null,
 left_type text check(left_type in ('resigned','terminated','contract_ended','not_joined')),
 left_on date,
 groups_left_at timestamptz,                    -- the leaving checklist took them out of current groups
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 -- How someone left is required whenever HR records it here; a status flipped on the record form leaves it open for
 -- HR's review list ("record how they left").
 check(stage='left' or (left_type is null and left_on is null))
);
create table pulse.person_lifecycle_event (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),
 kind text not null check(kind in ('stage','change','review')),
 from_stage text,to_stage text,effective_on date not null,
 left_type text check(left_type in ('resigned','terminated','contract_ended','not_joined')),
 detail jsonb not null default '{}' check(jsonb_typeof(detail)='object'),
 note text check(length(note)<=500),
 actor uuid references pulse.person(id),       -- null: written by Pulse (a sync or the detector)
 at timestamptz not null default clock_timestamp()
);
create index person_lifecycle_event_person on pulse.person_lifecycle_event(org_id,person_id,at);
alter table pulse.hr_employment add column payroll_from date;
-- A leaver's open task handed to someone else (or back to its pool) with a note.
alter table pulse.task_event drop constraint task_event_kind_check;
alter table pulse.task_event add constraint task_event_kind_check check(kind in ('created','edited','status','assigned','reviewer','blocked','unblocked','proof','accepted','returned','moved','asked','joined',
 'pooled','claimed','valued','handover'));

-- 2. Joining and leaving cases --------------------------------------------------------------------------------------
create table pulse.lifecycle_case (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),
 kind text not null check(kind in ('joining','leaving')),
 status text not null default 'open' check(status in ('open','done','cancelled')),
 effective_on date not null,                   -- the joining date or the last working day
 left_type text check(left_type in ('resigned','terminated','contract_ended','not_joined')),
 note text check(length(note)<=500),
 opened_by uuid references pulse.person(id),opened_at timestamptz not null default now(),
 closed_by uuid references pulse.person(id),closed_at timestamptz
);
create unique index lifecycle_case_open on pulse.lifecycle_case(org_id,person_id,kind) where status='open';
create table pulse.lifecycle_step (
 org_id uuid not null references pulse.org(id),case_id uuid not null references pulse.lifecycle_case(id),
 key text not null check(key ~ '^[a-z]{3,20}$'),
 status text not null default 'todo' check(status in ('todo','done','skipped')),
 result jsonb not null default '{}' check(jsonb_typeof(result)='object'),
 note text check(length(note)<=500),
 done_by uuid references pulse.person(id),done_at timestamptz,
 primary key(case_id,key)
);

-- 3. Evidence that someone may have left, and the HR review list ---------------------------------------------------
create table pulse.lifecycle_signal (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 person_id uuid references pulse.person(id),   -- null: an exit mail names someone who is not in Pulse
 source text not null check(source in ('workspace','attendance','work','hr_sheet','mail','roster')),
 kind text not null check(kind in ('resigned','terminated','closed','cancelled','suspended','no_signin','absent','quiet','not_listed')),
 observed_on date not null,
 last_day date,                                -- a last working day the source names
 weight smallint not null check(weight between 1 and 3),   -- 3: a resignation, termination, closure or suspension
 summary text not null check(length(summary) between 3 and 240),   -- plain words; never message content
 written_name text check(length(written_name)<=120),
 ref text not null check(length(ref) between 1 and 200),
 seen_at timestamptz not null default now(),retired_at timestamptz,
 unique(org_id,source,ref)
);
create index lifecycle_signal_person on pulse.lifecycle_signal(org_id,person_id) where retired_at is null;
create table pulse.lifecycle_review (
 org_id uuid not null references pulse.org(id),person_id uuid primary key references pulse.person(id),
 status text not null default 'open' check(status in ('open','confirmed','dismissed','cleared')),
 confidence text not null check(confidence in ('high','medium','low')),
 proposed_on date,proposed_type text check(proposed_type in ('resigned','terminated','contract_ended')),
 already_inactive boolean not null default false,   -- not current in Pulse, but how and when they left was never recorded
 reasons jsonb not null default '[]' check(jsonb_typeof(reasons)='array'),
 opened_at timestamptz not null default now(),refreshed_at timestamptz not null default now(),
 decided_by uuid references pulse.person(id),decided_at timestamptz,decision_note text check(length(decision_note)<=500),
 snooze_until date
);

-- 4. Former members of a conversation: who was in it, until when ------------------------------------------------------
create table pulse.chat_former_member (
 org_id uuid not null,channel_id uuid not null,person_id uuid not null references pulse.person(id),
 joined_at timestamptz,left_at timestamptz not null default now(),
 reason text not null check(reason in ('left_company','leaving_checklist')),
 primary key(channel_id,person_id,left_at),
 foreign key(org_id,channel_id) references pulse.chat_channel(org_id,id) on delete cascade
);
create index chat_former_member_person on pulse.chat_former_member(org_id,person_id);

do $$ declare t text;begin
 foreach t in array array['person_lifecycle','person_lifecycle_event','lifecycle_case','lifecycle_step','lifecycle_signal','lifecycle_review','chat_former_member'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select on pulse.%I to pulse_api',t);
  execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
  execute format('create trigger audit_mutation after insert or update on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end loop;
end $$;
-- A person sees their own stage and history; their head sees their team's; HR, leadership and admins see everyone.
-- Cases are HR's and leadership's work. Evidence and the review list are HR's and admins' only.
create policy visible on pulse.person_lifecycle as restrictive for select to pulse_api using(person_id=pulse.current_viewer()
 or pulse.viewer_is('admin','hr','leadership') or pulse.manages(person_id) or pulse.hr_head(person_id)=pulse.current_viewer());
create policy visible on pulse.person_lifecycle_event as restrictive for select to pulse_api using(person_id=pulse.current_viewer()
 or pulse.viewer_is('admin','hr','leadership') or pulse.manages(person_id) or pulse.hr_head(person_id)=pulse.current_viewer());
create policy visible on pulse.lifecycle_case as restrictive for select to pulse_api using(pulse.viewer_is('admin','hr','leadership'));
create policy visible on pulse.lifecycle_step as restrictive for select to pulse_api using(pulse.viewer_is('admin','hr','leadership'));
create policy visible on pulse.lifecycle_signal as restrictive for select to pulse_api using(pulse.viewer_is('admin','hr'));
create policy visible on pulse.lifecycle_review as restrictive for select to pulse_api using(pulse.viewer_is('admin','hr'));
create policy visible on pulse.chat_former_member as restrictive for select to pulse_api using(pulse.chat_has(channel_id) or pulse.viewer_is('admin'));

-- 5. Reading a stage -------------------------------------------------------------------------------------------------
-- Without a lifecycle row a current person is Active and anyone else has Left (how was never recorded).
create function pulse.lifecycle_stage(p_person uuid) returns text language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select stage from person_lifecycle where org_id=current_org() and person_id=p_person),
  (select case when status='active' then 'active' else 'left' end from person where org_id=current_org() and id=p_person))
$$;
create function pulse.lifecycle_today() returns date language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create function pulse.lifecycle_hr() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and viewer_is('admin','hr')
$$;
-- Open "possibly left" proposals: such people stay out of new-group defaults until HR decides.
create function pulse.lifecycle_possibly_left(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from lifecycle_review r join person p on p.id=r.person_id where r.org_id=current_org() and r.person_id=p_person and r.status='open' and p.status='active')
$$;
create function pulse.lifecycle_event_add(p_person uuid,p_kind text,p_from text,p_to text,p_on date,p_type text,p_detail jsonb,p_note text) returns uuid
 language sql security definer set search_path=pulse,pg_temp as $$
 insert into person_lifecycle_event(org_id,person_id,kind,from_stage,to_stage,effective_on,left_type,detail,note,actor)
 values(current_org(),p_person,p_kind,p_from,p_to,p_on,p_type,coalesce(p_detail,'{}'),nullif(btrim(coalesce(p_note,'')),''),current_viewer()) returning id
$$;
-- A role, pod, department or head change is a dated lifecycle event, whichever screen or sync made it.
create function pulse.lifecycle_profile_change() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d jsonb:='{}';
begin
 if new.role is distinct from old.role then d:=d||jsonb_build_object('role',jsonb_build_object('from',old.role,'to',new.role));end if;
 if new.pod is distinct from old.pod then d:=d||jsonb_build_object('pod',jsonb_build_object('from',old.pod,'to',new.pod));end if;
 if new.department is distinct from old.department then d:=d||jsonb_build_object('department',jsonb_build_object('from',old.department,'to',new.department));end if;
 if new.manager_id is distinct from old.manager_id then d:=d||jsonb_build_object('manager',jsonb_build_object(
  'from',(select display_name from person where id=old.manager_id),'to',(select display_name from person where id=new.manager_id)));end if;
 if d<>'{}' then perform lifecycle_event_add(new.person_id,'change',null,null,lifecycle_today(),null,d,null);end if;
 return null;
end $$;
create trigger lifecycle_profile_change after update of role,pod,department,manager_id on pulse.people_profile for each row execute function pulse.lifecycle_profile_change();
-- Current or not current changed on the record form (or by a sync): kept as a dated move too.
create function pulse.lifecycle_status_change() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cur text;
begin
 if new.side<>'staff' or new.status is not distinct from old.status or coalesce(current_setting('pulse.lifecycle_moving',true),'')='1'
  or exists(select 1 from record_merge m where m.entity_type='person' and m.gone_id=new.id and m.undone_at is null) then return null;end if;
 cur:=coalesce((select stage from person_lifecycle where person_id=new.id),case when old.status='active' then 'active' else 'left' end);
 if new.status='active' and cur in ('left','candidate','offer') then
  insert into person_lifecycle(org_id,person_id,stage,since,updated_by) values(new.org_id,new.id,'active',lifecycle_today(),current_viewer())
  on conflict(person_id) do update set stage='active',since=excluded.since,left_type=null,left_on=null,groups_left_at=null,updated_by=excluded.updated_by,updated_at=now();
  perform lifecycle_event_add(new.id,'stage',cur,'active',lifecycle_today(),null,'{"via":"record"}',null);
 elsif new.status<>'active' and cur not in ('left','candidate','offer') then
  insert into person_lifecycle(org_id,person_id,stage,since,updated_by) values(new.org_id,new.id,'left',lifecycle_today(),current_viewer())
  on conflict(person_id) do update set stage='left',since=excluded.since,left_type=null,left_on=null,updated_by=excluded.updated_by,updated_at=now();
  perform lifecycle_event_add(new.id,'stage',cur,'left',lifecycle_today(),null,'{"via":"record"}',null);
 end if;
 return null;
end $$;
create trigger lifecycle_status_change after update of status on pulse.person for each row execute function pulse.lifecycle_status_change();

-- 6. Moving between stages ---------------------------------------------------------------------------------------------
create function pulse.lifecycle_case_open(p_person uuid,p_kind text,p_on date,p_type text,p_note text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cid uuid;
begin
 select id into cid from lifecycle_case where org_id=current_org() and person_id=p_person and kind=p_kind and status='open';
 if cid is null then
  insert into lifecycle_case(org_id,person_id,kind,effective_on,left_type,note,opened_by) values(current_org(),p_person,p_kind,p_on,p_type,nullif(btrim(coalesce(p_note,'')),''),current_viewer()) returning id into cid;
 else update lifecycle_case set effective_on=p_on,left_type=coalesce(p_type,left_type) where id=cid;
 end if;
 return cid;
end $$;
create function pulse.lifecycle_move(p_person uuid,p_to text,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();who person;cur text;d date;t text;lwd date;e hr_employment;cid uuid;note text:=nullif(btrim(coalesce(p->>'note','')),'');
 exit_rule jsonb;settle int;allowed text[];
begin
 if not lifecycle_hr() then raise exception 'HR or an admin moves people between stages' using errcode='42501';end if;
 select * into who from person where org_id=current_org() and id=p_person and side='staff' for update;
 if not found then raise exception 'Person not found' using errcode='P0002';end if;
 if p_person=me and p_to in ('notice','left') then raise exception 'Someone else records your own leaving' using errcode='42501';end if;
 if p_to not in ('candidate','offer','joining','probation','active','notice','left') then raise exception 'Choose a stage' using errcode='22023';end if;
 cur:=lifecycle_stage(p_person);
 allowed:=case cur when 'candidate' then array['offer','joining','left'] when 'offer' then array['candidate','joining','left']
  when 'joining' then array['probation','active','left'] when 'probation' then array['active','notice','left'] when 'active' then array['notice','left']
  when 'notice' then array['active','left'] when 'left' then array['candidate','offer','joining'] end;
 if not p_to=any(allowed) then raise exception 'From % a person moves to %',cur,array_to_string(allowed,', ') using errcode='22023';end if;
 d:=coalesce(nullif(p->>'effectiveOn','')::date,lifecycle_today());
 t:=nullif(p->>'leftType','');
 if p_to='left' then
  if t is null or t not in ('resigned','terminated','contract_ended','not_joined') then raise exception 'Say how they left: resigned, terminated or contract ended' using errcode='22023';end if;
  if (t='not_joined')<>(cur in ('candidate','offer')) then raise exception 'Only a candidate or an offer ends as did not join' using errcode='22023';end if;
  if d>lifecycle_today() then raise exception 'A last working day still to come is a notice period: record Notice with that day' using errcode='22023';end if;
 else t:=null;
 end if;
 if p_to='notice' then
  lwd:=nullif(p->>'lastWorkingDay','')::date;
  if lwd is null or lwd<d then raise exception 'Give the last working day, on or after the notice date' using errcode='22023';end if;
 end if;
 insert into person_lifecycle(org_id,person_id,stage,since,left_type,left_on,updated_by) values(current_org(),p_person,p_to,d,t,case when p_to='left' then d end,me)
 on conflict(person_id) do update set stage=excluded.stage,since=excluded.since,left_type=excluded.left_type,left_on=excluded.left_on,updated_by=me,updated_at=now(),
  groups_left_at=case when excluded.stage in ('candidate','offer','joining') then null else person_lifecycle.groups_left_at end;
 -- Current people are the ones who work here now; a re-hired candidate is not current until they join.
 perform set_config('pulse.lifecycle_moving','1',true);
 update person set status=case when p_to in ('joining','probation','active','notice') then 'active' when p_to='left' then 'inactive' else status end,
  active_from=case when p_to='joining' then d else active_from end,active_to=case when p_to='left' then d when p_to='joining' then null else active_to end
 where id=p_person;
 perform set_config('pulse.lifecycle_moving','',true);
 select config into exit_rule from hr_rule_version where org_id=current_org() and key='exit' and effective_from<=d order by effective_from desc,version desc limit 1;
 settle:=coalesce((exit_rule->>'settlementDays')::int,45);
 select * into e from hr_employment where org_id=current_org() and person_id=p_person for update;
 if not found then insert into hr_employment(org_id,person_id,updated_by) values(current_org(),p_person,me) returning * into e;end if;
 if p_to='joining' then
  update people_profile set joined_on=d,locked=array(select distinct unnest(locked||'{joined_on}'::text[])),updated_at=now() where person_id=p_person;
  update hr_employment set probation_from=null,probation_to=null,notice_from=null,notice_to=null,last_working_day=null,settlement_target=null,payroll_from=null,updated_by=me,updated_at=now() where person_id=p_person;
  cid:=lifecycle_case_open(p_person,'joining',d,null,note);
 elsif p_to='probation' then
  update hr_employment set probation_from=d,probation_to=greatest(d,coalesce(nullif(p->>'probationTo','')::date,d+90)),updated_by=me,updated_at=now() where person_id=p_person;
 elsif p_to='notice' then
  update hr_employment set notice_from=d,notice_to=lwd,last_working_day=lwd,settlement_target=lwd+settle,updated_by=me,updated_at=now() where person_id=p_person;
  cid:=lifecycle_case_open(p_person,'leaving',lwd,null,note);
 elsif p_to='left' then
  update hr_employment set notice_from=least(notice_from,d),notice_to=least(notice_to,d),last_working_day=d,settlement_target=greatest(coalesce(settlement_target,d+settle),d),updated_by=me,updated_at=now() where person_id=p_person;
  if cur not in ('candidate','offer') then cid:=lifecycle_case_open(p_person,'leaving',d,t,note);end if;
  update lifecycle_case set status='done',closed_by=me,closed_at=now() where org_id=current_org() and person_id=p_person and kind='joining' and status='open';
  update lifecycle_review set status='confirmed',decided_by=me,decided_at=now() where org_id=current_org() and person_id=p_person and status='open';
 elsif p_to='active' and cur='notice' then
  -- A withdrawn resignation: the notice ends and the leaving case is cancelled; the history keeps both.
  update hr_employment set notice_from=null,notice_to=null,last_working_day=null,settlement_target=null,updated_by=me,updated_at=now() where person_id=p_person;
  update lifecycle_case set status='cancelled',closed_by=me,closed_at=now() where org_id=current_org() and person_id=p_person and kind='leaving' and status='open';
 elsif p_to='active' then
  update lifecycle_case set status='done',closed_by=me,closed_at=now() where org_id=current_org() and person_id=p_person and kind='joining' and status='open'
   and not exists(select 1 from pulse_priv.person_onboarding o where o.person_id=p_person and o.completed_at is null);
 end if;
 perform lifecycle_event_add(p_person,'stage',cur,p_to,d,t,jsonb_strip_nulls(jsonb_build_object('lastWorkingDay',lwd,'probationTo',nullif(p->>'probationTo',''))),note);
 return jsonb_build_object('stage',p_to,'from',cur,'since',d,'caseId',cid);
end $$;
-- A candidate HR adds by hand: a staff record that is not current until they join.
create function pulse.lifecycle_candidate(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();pid uuid;n text:=regexp_replace(btrim(coalesce(p->>'name','')),'\s+',' ','g');r text:=btrim(coalesce(p->>'role',''));s text:=coalesce(nullif(p->>'stage',''),'candidate');
begin
 if not lifecycle_hr() then raise exception 'HR or an admin adds candidates' using errcode='42501';end if;
 if length(n) not between 2 and 80 or length(r) not between 2 and 80 then raise exception 'Give a name and a role' using errcode='22023';end if;
 if s not in ('candidate','offer') then raise exception 'A new person starts as a candidate or an offer' using errcode='22023';end if;
 insert into person(org_id,display_name,side,status) values(current_org(),n,'staff','inactive') returning id into pid;
 insert into people_profile(org_id,person_id,role,pod,department,evidence,locked,updated_at)
 values(current_org(),pid,r,nullif(btrim(coalesce(p->>'pod','')),''),nullif(btrim(coalesce(p->>'department','')),''),'Added in Pulse by HR as a candidate','{role,pod,department}',now());
 insert into person_lifecycle(org_id,person_id,stage,since,updated_by) values(current_org(),pid,s,lifecycle_today(),me);
 perform lifecycle_event_add(pid,'stage',null,s,lifecycle_today(),null,'{}',p->>'note');
 return pid;
end $$;

-- 7. The checklists ------------------------------------------------------------------------------------------------
-- Whom Pulse proposes to take over a leaver's task: their pod head or manager to begin with (fit suggestions refine it).
create function pulse.lifecycle_handover_to(p_person uuid,p_task uuid) returns uuid language sql stable security definer set search_path=pulse,pg_temp as $$
 select h from (select hr_head(p_person) h) x where h is not null and h<>p_person and task_person_ok(h)
$$;
create function pulse.lifecycle_person_brief(p_person uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',p.id,'name',p.display_name,'role',pp.role,'pod',pp.pod,'department',pp.department) from person p left join people_profile pp on pp.person_id=p.id where p.id=p_person
$$;
create function pulse.lifecycle_steps(p_kind text) returns text[] language sql immutable as $$
 select case p_kind when 'leaving' then array['work','projects','pods','settlement','assets','access','chats','workspace','alumni']
  else array['record','invite','welcome','groups','domains','payroll','probation'] end
$$;
create function pulse.lifecycle_step_state(p_case uuid,p_key text) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare c lifecycle_case;s lifecycle_step;p uuid;pending int:=0;proposal jsonb:='{}';pp people_profile;e hr_employment;st text;paid_kind text;bal jsonb;
 rule jsonb;required int;served int;today date:=lifecycle_today();
begin
 select * into c from lifecycle_case where org_id=current_org() and id=p_case;p:=c.person_id;
 select * into s from lifecycle_step where case_id=p_case and key=p_key;
 select * into pp from people_profile where person_id=p;
 select * into e from hr_employment where person_id=p;
 st:=lifecycle_stage(p);
 if p_key='work' then
  select jsonb_build_object(
   'tasks',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'status',t.status,'dueAt',t.due_at,'project',coalesce(pr.title,pr.name),'claimed',t.claimed_by=p,
     'to',lifecycle_person_brief(lifecycle_handover_to(p,t.id))) order by t.due_at nulls last,t.title)
    from task t left join project pr on pr.id=t.project_id where t.org_id=current_org() and (t.assignee_person_id=p or t.owner_id=p or t.claimed_by=p) and t.status in ('open','in_progress','blocked','in_review')),'[]'),
   'reviews',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'status',t.status,'to',lifecycle_person_brief(lifecycle_handover_to(p,t.id))) order by t.title)
    from task t where t.org_id=current_org() and t.review_owner_id=p and t.accepted_at is null and t.status in ('open','in_progress','blocked','in_review','done')
    and coalesce(t.assignee_person_id,t.owner_id) is distinct from p),'[]'),
   'imported',(select count(*) from task t where t.org_id=current_org() and (t.assignee_person_id=p or t.owner_id=p) and t.status='unknown')) into proposal;
  pending:=jsonb_array_length(proposal->'tasks')+jsonb_array_length(proposal->'reviews');
 elsif p_key='projects' then
  select jsonb_build_object('owned',coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'name',coalesce(pr.title,pr.name),'kind',wp.kind,'to',lifecycle_person_brief(lifecycle_handover_to(p,null))) order by coalesce(pr.title,pr.name))
    from project pr left join work_project wp on wp.project_id=pr.id where pr.org_id=current_org() and (wp.owner_id=p and wp.status in ('planned','active','paused') or pr.lead_person_id=p and coalesce(pr.status,'active') in ('active','paused'))),'[]'),
   'memberOf',(select count(*) from project_member m where m.org_id=current_org() and m.person_id=p and m.left_at is null)) into proposal;
  pending:=jsonb_array_length(proposal->'owned')+(proposal->>'memberOf')::int;
 elsif p_key='pods' then
  select jsonb_build_object('pod',pp.pod,'manager',(select display_name from person where id=pp.manager_id),
   'reports',coalesce((select jsonb_agg(jsonb_build_object('id',r.person_id,'name',x.display_name,'to',lifecycle_person_brief(lifecycle_handover_to(p,null))) order by x.display_name)
    from people_profile r join person x on x.id=r.person_id where r.org_id=current_org() and r.manager_id=p and x.status='active'),'[]'),
   'heads',coalesce((select jsonb_agg(jsonb_build_object('pod',h.name)) from hr_pod h where h.org_id=current_org() and h.head_id=p),'[]'),
   'roles',coalesce((select jsonb_agg(r.role_key order by r.role_key) from role_assignment r where r.org_id=current_org() and r.person_id=p and current_date between r.valid_from and coalesce(r.valid_to,'infinity')),'[]'),
   'domains',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'title',d.title)) from work_domain d where d.org_id=current_org() and d.person_id=p and d.status in ('active','proposed')),'[]')) into proposal;
  pending:=(case when pp.pod is not null or pp.manager_id is not null then 1 else 0 end)+jsonb_array_length(proposal->'reports')+jsonb_array_length(proposal->'heads')
   +jsonb_array_length(proposal->'roles')+jsonb_array_length(proposal->'domains');
 elsif p_key='settlement' then
  select lt.key into paid_kind from leave_type lt where lt.org_id=current_org() and lt.paid and lt.annual_days is not null order by lt.key limit 1;
  bal:=case when paid_kind is not null then hr_balance_detail(p,paid_kind,coalesce(e.last_working_day,c.effective_on)) end;
  select config into rule from hr_rule_version where org_id=current_org() and key='exit' and effective_from<=c.effective_on order by effective_from desc,version desc limit 1;
  required:=case when e.probation_to is not null and e.probation_to>=coalesce(e.notice_from,c.effective_on) then coalesce((rule->>'probationDays')::int,15) else coalesce((rule->>'confirmedDays')::int,30) end;
  served:=case when e.notice_from is null then 0 else greatest(0,coalesce(e.last_working_day,c.effective_on)-e.notice_from+1) end;
  proposal:=jsonb_build_object('lastWorkingDay',coalesce(e.last_working_day,c.effective_on),'leaveKind',paid_kind,'leaveDays',bal->'available',
   'noticeRequiredDays',required,'noticeServedDays',served,'noticeRecoveryDays',case when c.left_type='terminated' then 0 else greatest(0,required-served) end,
   'compOffDays',hr_comp_balance(p,coalesce(e.last_working_day,c.effective_on)),'settlementBy',coalesce(e.settlement_target,c.effective_on+coalesce((rule->>'settlementDays')::int,45)),
   'ruleConfirmed',rule is not null);
  pending:=1;
 elsif p_key='assets' then
  proposal:=jsonb_build_object('items',coalesce(s.result->'items',(select coalesce(jsonb_agg(x order by x->>'name'),'[]') from (
    select jsonb_build_object('name','Computer: '||coalesce(d.label,d.platform),'returned',false) x from device d where d.org_id=current_org() and d.default_person_id=p and d.revoked_at is null
    union all select jsonb_build_object('name','Phone or tablet with Pulse: '||n.name,'returned',false) from native_device n where n.org_id=current_org() and n.person_id=p and n.revoked_at is null
    union all select jsonb_build_object('name','Company ID card','returned',false)) y)));
  pending:=1;
 elsif p_key='access' then
  select jsonb_build_object('credential',exists(select 1 from login_credential where person_id=p and status='active'),
   'sessions',(select count(*) from login_session where person_id=p and revoked_at is null and expires_at>now()),
   'appTokens',(select count(*) from pulse_priv.native_token where org_id=current_org() and person_id=p and revoked_at is null),
   'devices',(select count(*) from native_device where org_id=current_org() and person_id=p and revoked_at is null)
    +(select count(*) from device where org_id=current_org() and default_person_id=p and revoked_at is null)) into proposal;
  pending:=(proposal->>'credential')::boolean::int+(proposal->>'sessions')::int+(proposal->>'appTokens')::int+(proposal->>'devices')::int;
 elsif p_key='chats' then
  select jsonb_build_object('groups',coalesce(jsonb_agg(jsonb_build_object('id',ch.id,'name',ch.name,'kind',ch.kind) order by ch.kind,ch.name),'[]')) into proposal
  from chat_member m join chat_channel ch on ch.id=m.channel_id where m.org_id=current_org() and m.person_id=p and ch.kind<>'direct';
  pending:=jsonb_array_length(proposal->'groups');
 elsif p_key='workspace' then
  select jsonb_build_object('accounts',coalesce((select jsonb_agg(a.handle order by a.handle) from account a where a.org_id=current_org() and a.holder_person_id=p and a.provider='google' and not a.is_shared and a.purpose like 'Workspace%'),'[]'),
   'groups',coalesce((select jsonb_agg(distinct g.address) from workspace_group g cross join lateral jsonb_array_elements(g.members) m join account a on lower(a.handle)=lower(m->>'email')
     where g.org_id=current_org() and a.holder_person_id=p and not a.is_shared),'[]'),
   'ticks',coalesce(s.result,'{}')) into proposal;
  pending:=case when jsonb_array_length(proposal->'accounts')=0 then 0 else (select count(*) from unnest(array['suspend','drive','groups','forward']) k where not (coalesce(s.result,'{}') ? k)) end;
 elsif p_key='alumni' then
  proposal:=jsonb_build_object('stage',st,'on',c.effective_on,'leftType',c.left_type);
  pending:=case when st='left' then 0 else 1 end;
 elsif p_key='record' then
  proposal:=jsonb_build_object('role',pp.role,'pod',pp.pod,'department',pp.department,'joinedOn',pp.joined_on,'manager',(select display_name from person where id=coalesce(hr_head(p),pp.manager_id)));
  pending:=case when pp.role is not null and coalesce(pp.pod,pp.department) is not null and pp.joined_on is not null then 0 else 1 end;
 elsif p_key='invite' then
  proposal:=jsonb_build_object('credential',(select status from login_credential where person_id=p),'invitation',(select status from pulse_priv.staff_invitation where person_id=p),
   'workspace',exists(select 1 from account a where a.holder_person_id=p and a.provider='google' and not a.is_shared and a.purpose like 'Workspace%'));
  pending:=case when proposal->>'credential'='active' or proposal->>'invitation' in ('sent','used') or (proposal->>'workspace')::boolean then 0 else 1 end;
 elsif p_key='welcome' then
  proposal:=jsonb_build_object('completedAt',(select completed_at from pulse_priv.person_onboarding where person_id=p),'seenAt',(select seen_at from pulse_priv.person_onboarding where person_id=p));
  pending:=case when proposal->>'completedAt' is not null then 0 else 1 end;
 elsif p_key='groups' then
  select jsonb_build_object('pod',pp.pod,'department',pp.department,
   'suggested',(select jsonb_build_object('pod',x.pod,'department',x.department) from people_profile x join person y on y.id=x.person_id
     where x.org_id=current_org() and y.status='active' and x.person_id<>p and lower(x.role)=lower(pp.role) group by x.pod,x.department order by count(*) desc limit 1),
   'groups',coalesce((select jsonb_agg(ch.name order by ch.name) from chat_member m join chat_channel ch on ch.id=m.channel_id where m.person_id=p and ch.kind in ('pod','team','group')),'[]')) into proposal;
  pending:=case when coalesce(pp.pod,pp.department) is not null then 0 else 1 end;
 elsif p_key='domains' then
  select jsonb_build_object('current',coalesce((select jsonb_agg(jsonb_build_object('title',d.title,'status',d.status)) from work_domain d where d.person_id=p and d.status in ('active','proposed')),'[]'),
   'suggested',coalesce((select jsonb_agg(distinct cat) from (select unnest(d.categories) as cat from work_domain d join people_profile x on x.person_id=d.person_id
     where d.org_id=current_org() and d.status='active' and d.person_id<>p and lower(x.role)=lower(pp.role)) q),'[]')) into proposal;
  pending:=case when jsonb_array_length(proposal->'current')>0 then 0 else 1 end;
 elsif p_key='payroll' then
  proposal:=jsonb_build_object('payrollFrom',e.payroll_from,'suggested',coalesce(pp.joined_on,c.effective_on));
  pending:=case when e.payroll_from is not null then 0 else 1 end;
 elsif p_key='probation' then
  proposal:=jsonb_build_object('from',e.probation_from,'to',e.probation_to,'suggestedFrom',coalesce(pp.joined_on,c.effective_on),'suggestedTo',coalesce(pp.joined_on,c.effective_on)+90,'stage',st);
  pending:=case when e.probation_to is not null or st in ('active','notice','left') then 0 else 1 end;
 end if;
 return jsonb_build_object('key',p_key,'status',case when s.status in ('done','skipped') then s.status when pending=0 then 'done' else 'todo' end,
  'pending',pending,'confirmed',s.status is not null and s.status<>'todo','proposal',proposal,'result',coalesce(s.result,'{}'),'note',s.note,
  'doneBy',(select display_name from person where id=s.done_by),'doneAt',s.done_at,'auto',s.status is null and pending=0);
end $$;
create function pulse.lifecycle_case_view(p_case uuid) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare c lifecycle_case;k text;steps jsonb:='[]';
begin
 if current_viewer() is null or not viewer_is('admin','hr','leadership') then raise exception 'Joining and leaving cases are for HR and leadership' using errcode='42501';end if;
 select * into c from lifecycle_case where org_id=current_org() and id=p_case;
 if not found then raise exception 'Case not found' using errcode='P0002';end if;
 foreach k in array lifecycle_steps(c.kind) loop steps:=steps||lifecycle_step_state(c.id,k);end loop;
 return jsonb_build_object('id',c.id,'kind',c.kind,'status',c.status,'effectiveOn',c.effective_on,'leftType',c.left_type,'note',c.note,'openedAt',c.opened_at,
  'openedBy',(select display_name from person where id=c.opened_by),'closedAt',c.closed_at,'person',lifecycle_person_brief(c.person_id)||jsonb_build_object('stage',lifecycle_stage(c.person_id)),
  'steps',steps,'done',(select count(*) from jsonb_array_elements(steps) x where x->>'status' in ('done','skipped')),'total',jsonb_array_length(steps),
  'canAct',lifecycle_hr() and c.status='open','canWorkspace',viewer_is('admin') and c.status='open');
end $$;

-- One click per step: HR confirms Pulse's proposal (or changes it) and the step runs. Workspace is an admin's tick.
create function pulse.lifecycle_step_run(p_case uuid,p_key text,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();c lifecycle_case;pid uuid;x jsonb;t task;target uuid;n int:=0;m int:=0;res jsonb:='{}';who text;note text:=nullif(btrim(coalesce(p->>'note','')),'');
 lwd date;outcome text:='done';r record;pending int;
begin
 select * into c from lifecycle_case where org_id=current_org() and id=p_case for update;
 if not found then raise exception 'Case not found' using errcode='P0002';end if;
 if c.status<>'open' then raise exception 'This case is closed' using errcode='22023';end if;
 if not p_key=any(lifecycle_steps(c.kind)) then raise exception 'Unknown step' using errcode='22023';end if;
 if p_key='workspace' then
  if me is null or not viewer_is('admin') then raise exception 'Google Workspace steps are an admin''s ticks' using errcode='42501';end if;
 elsif not lifecycle_hr() then raise exception 'HR or an admin runs the checklist' using errcode='42501';
 end if;
 pid:=c.person_id;who:=(select display_name from person where id=pid);
 if p_key<>'alumni' and (p->>'skip')::boolean then
  if note is null then raise exception 'Say why this step is skipped' using errcode='22023';end if;
  outcome:='skipped';
 elsif p_key='work' then
  -- Each open task goes to the person chosen (or back to its pool); a handover note travels with it.
  for x in select * from jsonb_array_elements(coalesce(p->'tasks','[]')) loop
   select * into t from task where org_id=current_org() and id=(x->>'id')::uuid for update;
   if not found or not (t.assignee_person_id=pid or t.owner_id=pid or t.claimed_by=pid) or t.status not in ('open','in_progress','blocked','in_review') then continue;end if;
   target:=nullif(x->>'to','')::uuid;
   if target is not null and (target=pid or not task_person_ok(target)) then raise exception 'Hand work to a current team member' using errcode='22023';end if;
   if target is null and t.pool_scope is null and t.claimed_by is distinct from pid then raise exception 'Choose who takes “%”',t.title using errcode='22023';end if;
   update task set assignee_person_id=target,owner_id=target,assigned_at=case when target is null then null else now() end,
    claimed_by=case when target is null then null else claimed_by end,claimed_at=case when target is null then null else claimed_at end,
    status=case when target is null then 'open' else status end,started_at=case when target is null then null else started_at end,
    edited_by=me,updated_at=now(),locked=array(select distinct unnest(locked||'{owner_id}'::text[])) where id=t.id;
   perform task_event_add(t.id,'handover',who,coalesce((select display_name from person where id=target),'the pool'),coalesce(note,who||' is leaving'));
   insert into work_comment(org_id,task_id,author_id,body) values(current_org(),t.id,me,'Handover from '||who||coalesce(': '||note,'.'));
   if target is not null then perform task_notify(target,'task.assigned',t.id,'handover:'||t.id||':'||target,'Handed over to you: '||t.title);end if;
   n:=n+1;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(p->'reviews','[]')) loop
   target:=nullif(x->>'to','')::uuid;
   if target is null or target=pid or not task_person_ok(target) then raise exception 'Choose a current team member to review' using errcode='22023';end if;
   update task set review_owner_id=target,edited_by=me,updated_at=now() where org_id=current_org() and id=(x->>'id')::uuid and review_owner_id=pid and accepted_at is null;
   if found then m:=m+1;perform task_event_add((x->>'id')::uuid,'reviewer',who,(select display_name from person where id=target),coalesce(note,who||' is leaving'));end if;
  end loop;
  res:=jsonb_build_object('tasks',n,'reviews',m);
 elsif p_key='projects' then
  for x in select * from jsonb_array_elements(coalesce(p->'projects','[]')) loop
   target:=nullif(x->>'to','')::uuid;
   if target is null or target=pid or not task_person_ok(target) then raise exception 'Choose a current team member to own the project' using errcode='22023';end if;
   update work_project set owner_id=target,updated_by=me,updated_at=now() where org_id=current_org() and project_id=(x->>'id')::uuid and owner_id=pid;
   update project set lead_person_id=target where org_id=current_org() and id=(x->>'id')::uuid and lead_person_id=pid;
   n:=n+1;
  end loop;
  update project_member set left_at=now(),left_by=me where org_id=current_org() and person_id=pid and left_at is null;
  get diagnostics m=row_count;
  res:=jsonb_build_object('owned',n,'memberships',m);
 elsif p_key='pods' then
  for x in select * from jsonb_array_elements(coalesce(p->'reports','[]')) loop
   target:=nullif(x->>'to','')::uuid;
   if target is not null and (target=pid or not task_person_ok(target)) then raise exception 'Choose a current team member as their head' using errcode='22023';end if;
   update people_profile set manager_id=target,locked=array(select distinct unnest(locked||'{manager_id}'::text[])),updated_at=now() where org_id=current_org() and person_id=(x->>'id')::uuid and manager_id=pid;
  end loop;
  update people_profile set manager_id=null,locked=array(select distinct unnest(locked||'{manager_id}'::text[])),updated_at=now() where org_id=current_org() and manager_id=pid;
  for x in select * from jsonb_array_elements(coalesce(p->'heads','[]')) loop
   target:=nullif(x->>'to','')::uuid;
   if target is null or target=pid or not task_person_ok(target) then raise exception 'Choose a current team member to head %',x->>'pod' using errcode='22023';end if;
   update hr_pod set head_id=target,updated_by=me,updated_at=now() where org_id=current_org() and name=x->>'pod' and head_id=pid;
   update unit set head_person_id=target where org_id=current_org() and kind='pod' and name=x->>'pod' and head_person_id=pid;
  end loop;
  if exists(select 1 from hr_pod where org_id=current_org() and head_id=pid) then raise exception 'Choose who heads the pods % headed',who using errcode='22023';end if;
  update unit set head_person_id=null where org_id=current_org() and head_person_id=pid;
  update people_profile set pod=null,manager_id=null,locked=array(select distinct unnest(locked||'{pod,manager_id}'::text[])),updated_at=now() where person_id=pid;
  -- Access roles stop counting at once (role checks read current_date, inclusive of valid_to).
  update role_assignment set valid_to=greatest(valid_from,current_date-1) where org_id=current_org() and person_id=pid and (valid_to is null or valid_to>=current_date);
  get diagnostics n=row_count;
  update work_domain set status=case when status='active' then 'ended' else 'withdrawn' end,ended_at=now(),ended_by=me,end_note='Left the company',updated_at=now()
   where org_id=current_org() and person_id=pid and status in ('active','proposed');
  get diagnostics m=row_count;
  res:=jsonb_build_object('roles',n,'domains',m);
 elsif p_key='settlement' then
  lwd:=coalesce(nullif(p->>'lastWorkingDay','')::date,c.effective_on);
  if lwd is null or nullif(p->>'settlementBy','')::date<lwd then raise exception 'Settle on or after the last working day' using errcode='22023';end if;
  for x in select value from jsonb_each(jsonb_build_object('l',p->'leaveDays','n',p->'noticeRecoveryDays','c',p->'compOffDays')) loop
   if x is not null and x<>'null'::jsonb and (jsonb_typeof(x)<>'number' or (x#>>'{}')::numeric not between 0 and 365) then raise exception 'Days are numbers from 0 to 365' using errcode='22023';end if;
  end loop;
  update hr_employment set last_working_day=lwd,notice_from=least(notice_from,lwd),notice_to=least(notice_to,lwd),
   settlement_target=coalesce(nullif(p->>'settlementBy','')::date,greatest(settlement_target,lwd),lwd+45),updated_by=me,updated_at=now() where org_id=current_org() and person_id=pid;
  if not found then insert into hr_employment(org_id,person_id,last_working_day,settlement_target,updated_by) values(current_org(),pid,lwd,coalesce(nullif(p->>'settlementBy','')::date,lwd+45),me);end if;
  update lifecycle_case set effective_on=lwd where id=p_case;
  res:=jsonb_strip_nulls(jsonb_build_object('lastWorkingDay',lwd,'leaveDays',p->'leaveDays','noticeRecoveryDays',p->'noticeRecoveryDays','compOffDays',p->'compOffDays',
   'settlementBy',coalesce(nullif(p->>'settlementBy','')::date,(select settlement_target from hr_employment where person_id=pid))));
 elsif p_key='assets' then
  if jsonb_typeof(coalesce(p->'items','[]'))<>'array' or jsonb_array_length(coalesce(p->'items','[]'))>30 then raise exception 'List up to 30 items' using errcode='22023';end if;
  res:=jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('name',left(btrim(i->>'name'),80),'returned',coalesce((i->>'returned')::boolean,false))) from jsonb_array_elements(p->'items') i where length(btrim(coalesce(i->>'name','')))>1),'[]'));
  outcome:=case when not exists(select 1 from jsonb_array_elements(res->'items') i where not (i->>'returned')::boolean) then 'done' else 'todo' end;
 elsif p_key='access' then
  perform auth_end_sessions('staff',pid);
  update login_credential set status='disabled' where person_id=pid and status='active';
  get diagnostics n=row_count;
  update native_device set revoked_at=now() where org_id=current_org() and person_id=pid and revoked_at is null;
  get diagnostics m=row_count;
  update device_assignment set valid_to=now() where org_id=current_org() and person_id=pid and valid_to is null;
  update device set default_person_id=null where org_id=current_org() and default_person_id=pid;
  perform audit_write('deactivate','person',pid::text,array['sessions','devices','credential']);
  res:=jsonb_build_object('credential',n,'devices',m);
 elsif p_key='chats' then
  insert into chat_former_member(org_id,channel_id,person_id,joined_at,reason)
  select m.org_id,m.channel_id,m.person_id,m.joined_at,'leaving_checklist' from chat_member m join chat_channel ch on ch.id=m.channel_id where m.org_id=current_org() and m.person_id=pid and ch.kind<>'direct';
  delete from chat_member m using chat_channel ch where ch.id=m.channel_id and m.org_id=current_org() and m.person_id=pid and ch.kind<>'direct';
  get diagnostics n=row_count;
  insert into person_lifecycle(org_id,person_id,stage,since,groups_left_at,updated_by) values(current_org(),pid,lifecycle_stage(pid),lifecycle_today(),now(),me)
  on conflict(person_id) do update set groups_left_at=now(),updated_by=me,updated_at=now();
  res:=jsonb_build_object('groups',n);
 elsif p_key='workspace' then
  if coalesce(p->>'item','') not in ('suspend','drive','groups','forward') then raise exception 'Choose a Workspace step' using errcode='22023';end if;
  res:=coalesce((select result from lifecycle_step where case_id=p_case and key=p_key),'{}');
  res:=case when coalesce((p->>'done')::boolean,true) then res||jsonb_build_object(p->>'item',jsonb_build_object('by',(select display_name from person where id=me),'at',now())) else res-(p->>'item') end;
  outcome:=case when res ?& array['suspend','drive','groups','forward'] then 'done' else 'todo' end;
 elsif p_key='alumni' then
  if lifecycle_stage(pid)<>'left' then
   perform lifecycle_move(pid,'left',jsonb_build_object('effectiveOn',coalesce(nullif(p->>'effectiveOn',''),c.effective_on::text),'leftType',coalesce(nullif(p->>'leftType',''),c.left_type),'note',note));
  end if;
  res:=jsonb_build_object('on',(select left_on from person_lifecycle where person_id=pid),'leftType',(select left_type from person_lifecycle where person_id=pid));
 elsif p_key='record' then
  update people_profile set role=coalesce(nullif(btrim(p->>'role'),''),role),pod=case when p ? 'pod' then nullif(btrim(p->>'pod'),'') else pod end,
   department=case when p ? 'department' then nullif(btrim(p->>'department'),'') else department end,
   manager_id=case when p ? 'managerId' then nullif(p->>'managerId','')::uuid else manager_id end,
   joined_on=coalesce(nullif(p->>'joinedOn','')::date,joined_on),
   locked=array(select distinct unnest(locked||array['role','pod','department','manager_id','joined_on'])),updated_at=now() where org_id=current_org() and person_id=pid;
 elsif p_key='groups' then
  update people_profile set pod=coalesce(nullif(btrim(p->>'pod'),''),pod),department=coalesce(nullif(btrim(p->>'department'),''),department),
   locked=array(select distinct unnest(locked||'{pod,department}'::text[])),updated_at=now() where org_id=current_org() and person_id=pid;
 elsif p_key='domains' then
  if jsonb_typeof(p->'categories')<>'array' or jsonb_array_length(p->'categories')=0 then raise exception 'Choose the kinds of work' using errcode='22023';end if;
  res:=jsonb_build_object('domain',work_domain_propose(pid,jsonb_build_object('title',coalesce(nullif(btrim(p->>'title'),''),'Work for '||who),'categories',p->'categories','pod',nullif(p->>'pod',''))));
 elsif p_key='payroll' then
  update hr_employment set payroll_from=coalesce(nullif(p->>'payrollFrom','')::date,c.effective_on),updated_by=me,updated_at=now() where org_id=current_org() and person_id=pid;
  if not found then insert into hr_employment(org_id,person_id,payroll_from,updated_by) values(current_org(),pid,coalesce(nullif(p->>'payrollFrom','')::date,c.effective_on),me);end if;
 elsif p_key='probation' then
  update hr_employment set probation_from=coalesce(nullif(p->>'from','')::date,c.effective_on),probation_to=greatest(coalesce(nullif(p->>'from','')::date,c.effective_on),coalesce(nullif(p->>'to','')::date,c.effective_on+90)),
   updated_by=me,updated_at=now() where org_id=current_org() and person_id=pid;
  if not found then insert into hr_employment(org_id,person_id,probation_from,probation_to,updated_by) values(current_org(),pid,coalesce(nullif(p->>'from','')::date,c.effective_on),coalesce(nullif(p->>'to','')::date,c.effective_on+90),me);end if;
 elsif p_key in ('invite','welcome') then
  -- The invitation is sent from the person's record when HR presses Send; the welcome wizard is the person's own.
  if not coalesce((p->>'confirm')::boolean,false) then raise exception 'Send the invitation from their record; confirm here only what happened outside Pulse' using errcode='22023';end if;
  if note is null then raise exception 'Say what happened' using errcode='22023';end if;
 end if;
 insert into lifecycle_step(org_id,case_id,key,status,result,note,done_by,done_at) values(current_org(),p_case,p_key,outcome,res,note,me,now())
 on conflict(case_id,key) do update set status=excluded.status,result=excluded.result,note=coalesce(excluded.note,lifecycle_step.note),done_by=me,done_at=now();
 -- The case closes when every step is resolved, in the data or by HR.
 select count(*) into pending from unnest(lifecycle_steps(c.kind)) k where lifecycle_step_state(p_case,k)->>'status'='todo';
 if pending=0 then update lifecycle_case set status='done',closed_by=me,closed_at=now() where id=p_case;end if;
 return jsonb_build_object('key',p_key,'status',outcome,'result',res,'caseDone',pending=0);
end $$;

-- 8. Possibly left: evidence from Pulse's own data, then one proposal per person ---------------------------------------
create function pulse.lifecycle_detect(p_quiet_weeks int default 6) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare today date:=lifecycle_today();latest date;r record;n int:=0;sig jsonb;w int;conf text;prop_on date;prop_type text;cancelled date;attendance_on boolean;
begin
 if current_viewer() is not null and not viewer_is('admin','hr') then raise exception 'HR or an admin refreshes the review list' using errcode='42501';end if;
 -- HR sheets: someone missing from the latest salary sheet month everyone else is on.
 select max(s.last_seen) into latest from person_source s join person p on p.id=s.person_id where s.org_id=current_org() and s.source='hr_document' and s.label like 'Salary sheet%';
 update lifecycle_signal set retired_at=now() where org_id=current_org() and source in ('hr_sheet','attendance','work') and retired_at is null;
 if latest is not null then
  insert into lifecycle_signal(org_id,person_id,source,kind,observed_on,weight,summary,ref)
  select current_org(),p.id,'hr_sheet','absent',(date_trunc('month',x.last)+interval '1 month')::date,2,
   'Not on the latest salary sheet ('||to_char(latest,'Mon YYYY')||'); last on '||to_char(x.last,'Mon YYYY'),'sheet:'||p.id
  from person p join (select person_id,max(last_seen) last from person_source where org_id=current_org() and source='hr_document' and label like 'Salary sheet%' group by person_id) x on x.person_id=p.id
  where p.org_id=current_org() and p.side='staff' and x.last<latest
  on conflict(org_id,source,ref) do update set observed_on=excluded.observed_on,summary=excluded.summary,weight=excluded.weight,person_id=excluded.person_id,seen_at=now(),retired_at=null;
 end if;
 -- Attendance and work: quiet for weeks while the company records them (weak on its own).
 attendance_on:=exists(select 1 from attendance_entry where org_id=current_org() and work_date>=today-14);
 insert into lifecycle_signal(org_id,person_id,source,kind,observed_on,weight,summary,ref)
 select current_org(),p.id,'work','quiet',coalesce(a.last,today),1,
  case when a.last is null then 'No tasks, work, messages or check-ins recorded in Pulse' else 'Nothing recorded in Pulse since '||to_char(a.last,'DD Mon YYYY') end,'quiet:'||p.id
 from person p left join people_profile pp on pp.person_id=p.id
 cross join lateral (select greatest(
   (select max(coalesce(t.done_at,t.updated_at))::date from task t where t.org_id=current_org() and (t.assignee_person_id=p.id or t.owner_id=p.id) and t.status<>'unknown'),
   (select max(coalesce(l.period_to,l.period_from)) from people_work_link l where l.org_id=current_org() and l.person_id=p.id and l.retired_at is null and l.status<>'rejected'),
   (select max(m.created_at)::date from chat_message m where m.org_id=current_org() and m.author_id=p.id),
   (select max(e.work_date) from attendance_entry e where e.org_id=current_org() and e.person_id=p.id and e.voided_at is null)) last) a
 where p.org_id=current_org() and p.side='staff' and p.status='active' and coalesce(pp.joined_on,'-infinity')<today-p_quiet_weeks*7
  and (a.last is null or a.last<today-p_quiet_weeks*7)
 on conflict(org_id,source,ref) do update set observed_on=excluded.observed_on,summary=excluded.summary,weight=excluded.weight,seen_at=now(),retired_at=null;
 if attendance_on then
  insert into lifecycle_signal(org_id,person_id,source,kind,observed_on,weight,summary,ref)
  select current_org(),p.id,'attendance','quiet',today,1,'No check-in in the last two weeks while the team checks in','attendance:'||p.id
  from person p where p.org_id=current_org() and p.side='staff' and p.status='active' and not p.tracking_excluded
   and not exists(select 1 from attendance_entry e where e.org_id=current_org() and e.person_id=p.id and e.work_date>=today-14 and e.voided_at is null)
   and not exists(select 1 from leave_request l where l.org_id=current_org() and l.person_id=p.id and l.status='approved' and l.to_date>=today-14)
  on conflict(org_id,source,ref) do update set observed_on=excluded.observed_on,summary=excluded.summary,seen_at=now(),retired_at=null;
 end if;
 -- One proposal per person. Strong evidence (a resignation, a termination, closure documents, a suspended account)
 -- is enough on its own; a missing salary sheet needs a second sign; quiet alone proposes nothing.
 for r in select p.id,p.status,l.stage,l.left_type from person p left join person_lifecycle l on l.person_id=p.id
  where p.org_id=current_org() and p.side='staff' and not exists(select 1 from record_merge m where m.entity_type='person' and m.gone_id=p.id and m.undone_at is null) loop
  if r.stage in ('candidate','offer','joining','notice') or r.left_type is not null then
   update lifecycle_review set status='cleared',refreshed_at=now() where person_id=r.id and status='open';continue;
  end if;
  select max(observed_on) into cancelled from lifecycle_signal where person_id=r.id and kind='cancelled' and retired_at is null;
  select coalesce(jsonb_agg(jsonb_build_object('source',s.source,'kind',s.kind,'summary',s.summary,'on',s.observed_on,'lastDay',s.last_day,'weight',
    case when s.kind='resigned' and s.observed_on<=cancelled then 0 else s.weight end) order by s.weight desc,s.observed_on desc),'[]') into sig
  from lifecycle_signal s where s.person_id=r.id and s.retired_at is null and s.kind<>'cancelled';
  if cancelled is not null then
   sig:=sig||jsonb_build_array(jsonb_build_object('source','mail','kind','cancelled','summary',(select summary from lifecycle_signal where person_id=r.id and kind='cancelled' and retired_at is null order by observed_on desc limit 1),'on',cancelled,'weight',0));
  end if;
  select coalesce(max((x->>'weight')::int),0) into w from jsonb_array_elements(sig) x;
  conf:=case when w=3 then 'high' when w=2 and exists(select 1 from jsonb_array_elements(sig) x where (x->>'weight')::int=1) then 'medium' when w=2 then 'low'
   when r.status<>'active' then 'low' end;
  if conf is null then
   update lifecycle_review set status='cleared',refreshed_at=now() where person_id=r.id and status='open';continue;
  end if;
  select coalesce((x->>'lastDay')::date,case when x->>'kind'='resigned' then (x->>'on')::date+30 when x->>'kind' in ('terminated','closed','suspended') then (x->>'on')::date
    when x->>'kind'='absent' then (x->>'on')::date-1 else (x->>'on')::date end) into prop_on
  from jsonb_array_elements(sig) x where (x->>'weight')::int>0 order by (x->>'weight')::int desc,(x->>'on')::date desc limit 1;
  prop_type:=case when exists(select 1 from jsonb_array_elements(sig) x where x->>'kind'='terminated' and (x->>'weight')::int>0) then 'terminated'
   when exists(select 1 from jsonb_array_elements(sig) x where x->>'kind'='resigned' and (x->>'weight')::int>0) then 'resigned' end;
  insert into lifecycle_review(org_id,person_id,status,confidence,proposed_on,proposed_type,already_inactive,reasons)
  values(current_org(),r.id,'open',conf,case when r.status='active' then prop_on else least(prop_on,today) end,prop_type,r.status<>'active',sig)
  on conflict(person_id) do update set confidence=excluded.confidence,proposed_on=excluded.proposed_on,proposed_type=excluded.proposed_type,already_inactive=excluded.already_inactive,
   reasons=excluded.reasons,refreshed_at=now(),
   status=case when lifecycle_review.status in ('open','cleared') then 'open'
    -- A dismissed proposal comes back only after its snooze, or with strong evidence that is newer than the decision.
    when lifecycle_review.status='dismissed' and (lifecycle_review.snooze_until<=today or exists(select 1 from jsonb_array_elements(excluded.reasons) x
     where (x->>'weight')::int=3 and (x->>'on')::date>lifecycle_review.decided_at::date)) then 'open' else lifecycle_review.status end;
  n:=n+1;
 end loop;
 return n;
end $$;
-- HR confirms ("Mark as left on <date>, <type>"), which opens the leaving checklist, or dismisses with a reason.
create function pulse.lifecycle_review_decide(p_person uuid,p_action text,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();rv lifecycle_review;d date;t text;note text:=nullif(btrim(coalesce(p->>'note','')),'');out jsonb;cid uuid;
begin
 if not lifecycle_hr() then raise exception 'HR or an admin decides' using errcode='42501';end if;
 select * into rv from lifecycle_review where org_id=current_org() and person_id=p_person for update;
 if not found then raise exception 'Nothing to review for this person' using errcode='P0002';end if;
 if p_action='dismiss' then
  if note is null then raise exception 'Say why: for example, still working, resignation withdrawn' using errcode='22023';end if;
  update lifecycle_review set status='dismissed',decided_by=me,decided_at=now(),decision_note=note,snooze_until=lifecycle_today()+greatest(7,least(365,coalesce((p->>'snoozeDays')::int,60)))
   where person_id=p_person;
  perform lifecycle_event_add(p_person,'review',null,null,lifecycle_today(),null,jsonb_build_object('decision','dismissed','reasons',rv.reasons),note);
  return jsonb_build_object('status','dismissed');
 elsif p_action<>'confirm' then raise exception 'Confirm or dismiss' using errcode='22023';
 end if;
 d:=coalesce(nullif(p->>'effectiveOn','')::date,rv.proposed_on,lifecycle_today());
 t:=coalesce(nullif(p->>'leftType',''),rv.proposed_type);
 if d>lifecycle_today() then
  out:=lifecycle_move(p_person,'notice',jsonb_build_object('effectiveOn',lifecycle_today(),'lastWorkingDay',d,'note',note));
 elsif rv.already_inactive or (select status from person where id=p_person)<>'active' then
  -- Not current already: record how and when they left, and open the checklist for anything still in their name.
  if t is null or t not in ('resigned','terminated','contract_ended') then raise exception 'Say how they left: resigned, terminated or contract ended' using errcode='22023';end if;
  insert into person_lifecycle(org_id,person_id,stage,since,left_type,left_on,updated_by) values(current_org(),p_person,'left',d,t,d,me)
  on conflict(person_id) do update set stage='left',since=d,left_type=t,left_on=d,updated_by=me,updated_at=now();
  update person set active_to=coalesce(active_to,d) where id=p_person;
  update hr_employment set last_working_day=d,settlement_target=greatest(coalesce(settlement_target,d),d),updated_by=me,updated_at=now() where org_id=current_org() and person_id=p_person;
  if not found then insert into hr_employment(org_id,person_id,last_working_day,settlement_target,updated_by) values(current_org(),p_person,d,d,me);end if;
  cid:=lifecycle_case_open(p_person,'leaving',d,t,note);
  perform lifecycle_event_add(p_person,'stage','left','left',d,t,jsonb_build_object('recorded','after the fact'),note);
  out:=jsonb_build_object('stage','left','caseId',cid);
 else
  out:=lifecycle_move(p_person,'left',jsonb_build_object('effectiveOn',d,'leftType',t,'note',note));
 end if;
 update lifecycle_review set status='confirmed',decided_by=me,decided_at=now(),decision_note=note where person_id=p_person;
 perform lifecycle_event_add(p_person,'review',null,null,lifecycle_today(),t,jsonb_build_object('decision','confirmed','reasons',rv.reasons,'on',d),note);
 return out;
end $$;

-- 9. Chats: leavers become former members; the refresh from pods and teams never adds them back ----------------------
create or replace function pulse.offboard_access() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform pulse.auth_lock('staff',new.id);
 if new.status is distinct from old.status and new.status<>'active' then
 update login_credential set status='disabled' where person_id=new.id;
 update login_session set revoked_at=now() where person_id=new.id and revoked_at is null;
 insert into chat_former_member(org_id,channel_id,person_id,joined_at,reason) select org_id,channel_id,person_id,joined_at,'left_company' from chat_member where person_id=new.id;
 delete from chat_member where person_id=new.id;
 perform audit_write('deactivate','person',new.id::text,array['sessions','chats','username']);
 end if;return null;
end $$;
create or replace function pulse.chat_refresh() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_active() then raise exception 'individual staff account required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtext('chat-members:'||current_org()::text));
 insert into chat_channel(org_id,key,name,kind,description)
 select current_org(),'pod:'||u.id,u.name,'pod','Your pod · confirmed membership in Pulse' from unit u where u.kind='pod' and u.valid_to is null
 on conflict(org_id,key) do update set name=excluded.name where chat_channel.name is distinct from excluded.name;
 insert into chat_channel(org_id,key,name,kind,description)
 select distinct current_org(),'team:'||lower(trim(pp.department)),trim(pp.department),'team','Your team · confirmed membership in Pulse'
 from people_profile pp join person p on p.id=pp.person_id where p.status='active' and p.side='staff' and nullif(trim(pp.department),'') is not null
 on conflict(org_id,key) do nothing;
 insert into chat_channel(org_id,key,name,kind,description,address)
 select current_org(),'group:'||g.address,g.name,'group',case when g.source_kind is null then 'Google group · observed Workspace membership' else 'Google group · membership follows Pulse '||g.source_kind end,g.address from workspace_group g
 on conflict(org_id,key) do update set name=excluded.name,address=excluded.address,description=excluded.description
 where (chat_channel.name,chat_channel.address,chat_channel.description) is distinct from (excluded.name,excluded.address,excluded.description);
 create temporary table if not exists chat_expected(channel_id uuid,person_id uuid,primary key(channel_id,person_id)) on commit drop;
 truncate chat_expected;
 insert into chat_expected
 select ch.id,p.id from chat_channel ch cross join person p join people_profile pp on pp.person_id=p.id
 left join workspace_group g on g.address=ch.address and g.org_id=ch.org_id
 where ch.org_id=current_org() and p.status='active' and p.side='staff'
 and not exists(select 1 from person_lifecycle l where l.person_id=p.id and l.groups_left_at is not null) and (
 ch.kind='pod' and exists(select 1 from unit u where 'pod:'||u.id=ch.key and u.valid_to is null and u.name=pp.pod) or
 ch.kind='team' and ch.key='team:'||lower(trim(pp.department)) or
 ch.kind='group' and (g.source_kind='all' or g.source_kind='pod' and pp.pod=g.source_value or g.source_kind='team' and lower(pp.department)=lower(g.source_value) or
 g.source_kind='role' and exists(select 1 from role_assignment r where r.person_id=p.id and r.role_key=any(string_to_array(g.source_value,',')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) or
 g.source_kind is null and exists(select 1 from account a cross join lateral jsonb_array_elements(g.members) m where a.holder_person_id=p.id and not a.is_shared and lower(a.handle)=lower(m->>'email'))));
 insert into chat_member(org_id,channel_id,person_id) select current_org(),channel_id,person_id from chat_expected on conflict do nothing;
 delete from chat_member cm using chat_channel ch where cm.channel_id=ch.id and ch.kind not in('direct','custom')
 and not exists(select 1 from chat_expected e where e.channel_id=cm.channel_id and e.person_id=cm.person_id);
end $$;

revoke all on function pulse.lifecycle_stage(uuid),pulse.lifecycle_today(),pulse.lifecycle_hr(),pulse.lifecycle_possibly_left(uuid),pulse.lifecycle_event_add(uuid,text,text,text,date,text,jsonb,text),
 pulse.lifecycle_profile_change(),pulse.lifecycle_status_change(),pulse.lifecycle_case_open(uuid,text,date,text,text),pulse.lifecycle_move(uuid,text,jsonb),pulse.lifecycle_candidate(jsonb),
 pulse.lifecycle_handover_to(uuid,uuid),pulse.lifecycle_person_brief(uuid),pulse.lifecycle_steps(text),pulse.lifecycle_step_state(uuid,text),pulse.lifecycle_case_view(uuid),
 pulse.lifecycle_step_run(uuid,text,jsonb),pulse.lifecycle_detect(int),pulse.lifecycle_review_decide(uuid,text,jsonb) from public;
grant execute on function pulse.lifecycle_stage(uuid),pulse.lifecycle_today(),pulse.lifecycle_possibly_left(uuid),pulse.lifecycle_move(uuid,text,jsonb),pulse.lifecycle_candidate(jsonb),
 pulse.lifecycle_steps(text),pulse.lifecycle_case_view(uuid),pulse.lifecycle_step_run(uuid,text,jsonb),pulse.lifecycle_detect(int),pulse.lifecycle_review_decide(uuid,text,jsonb) to pulse_api;
grant execute on function pulse.lifecycle_stage(uuid),pulse.lifecycle_today(),pulse.lifecycle_detect(int) to pulse_worker;
-- migrate:down
-- Forward-only.
