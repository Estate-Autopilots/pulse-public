-- migrate:up
-- LIFECYCLE part 5 (owner, 11 Oct 2026): "My Pulse", each person's own home. Today, the week, growth, money, time,
-- recognition, requests to HR, and what Pulse knows about them in plain words, with a way to correct it.
-- * Kudos: anyone thanks a colleague (optionally for a task). The two of them, the receiver's head and HR see it; there
--   is no leaderboard. The receiver hears it in Pulse.
-- * me_pulse() reads only the viewer's own records. Nothing here exposes anyone else's cost or value.

create table pulse.kudos (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 from_person uuid not null references pulse.person(id),to_person uuid not null references pulse.person(id),
 note text not null check(length(btrim(note)) between 3 and 280),task_id uuid references pulse.task(id),
 created_at timestamptz not null default now(),hidden_at timestamptz,hidden_by uuid references pulse.person(id),
 check(from_person<>to_person)
);
create index kudos_to on pulse.kudos(org_id,to_person,created_at desc);
alter table pulse.kudos enable row level security;
alter table pulse.kudos force row level security;
create policy tenant on pulse.kudos using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy visible on pulse.kudos as restrictive for select to pulse_api using(to_person=pulse.current_viewer() or from_person=pulse.current_viewer()
 or pulse.hr_head(to_person)=pulse.current_viewer() or pulse.manages(to_person) or pulse.viewer_is('admin','hr','leadership'));
grant select on pulse.kudos to pulse_api;
grant select,insert,update on pulse.kudos to pulse_worker;
create trigger audit_mutation after insert or update on pulse.kudos for each row execute function pulse.audit_mutation();

alter table pulse.notification drop constraint notification_event_type_check;
alter table pulse.notification add constraint notification_event_type_check check(event_type in ('update.self','chat.message','chat.mention','chat.reply','policy.published','holiday.announced',
 'task.assigned','task.blocked','task.unblocked','task.due_soon','task.done','task.accepted','task.ask','project.ask','ask.answered',
 'task.mention','project.mention','task.comment','project.comment','project.added','task.update',
 'domain.proposed','domain.answered','domain.policy','domain.ended','pool.claimed','pool.match',
 'leave.decision','request.updated','request.decision','approval.waiting','approval.reminder',
 'payroll.processed','attendance.start','attendance.end','attendance.done','attendance.departure','attendance.confirmed',
 'attendance.arrival','attendance.break','attendance.nudge','profile.reminder','kudos.received'));
alter table pulse.notification drop constraint notification_subject_type_check;
alter table pulse.notification add constraint notification_subject_type_check check(subject_type in ('person','message','hr_flow','task','policy','holiday','payroll_notice','project','work_ask','comment','work_domain','kudos'));
do $$
declare definition text;changed text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 changed:=replace(definition,' elsif p_type=''policy.published'' then',
 ' elsif p_type=''kudos.received'' then
  return p_subject=''kudos'' and exists(select 1 from kudos k where k.org_id=current_org() and k.id=p_id and k.to_person=p_person and k.hidden_at is null);
 elsif p_type=''policy.published'' then');
 if changed=definition then raise exception 'notification_recipient_allowed changed shape';end if;
 execute changed;
end $$;

create function pulse.kudos_give(p_to uuid,p_note text,p_task uuid default null) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();kid uuid;n text:=regexp_replace(btrim(coalesce(p_note,'')),'\s+',' ','g');
begin
 if me is null or not exists(select 1 from person where id=me and status='active' and side='staff') then raise exception 'Sign in with your own staff account' using errcode='42501';end if;
 if p_to=me then raise exception 'Kudos are for someone else' using errcode='22023';end if;
 if not exists(select 1 from person where org_id=current_org() and id=p_to and status='active' and side='staff') then raise exception 'Choose a current colleague' using errcode='22023';end if;
 if length(n) not between 3 and 280 then raise exception 'Say what for, in up to 280 characters' using errcode='22023';end if;
 if p_task is not null and not task_visible(p_task) then raise exception 'Choose a task you can see' using errcode='22023';end if;
 if (select count(*) from kudos where org_id=current_org() and from_person=me and created_at>now()-interval '1 day')>=20 then raise exception 'That is a lot of thanks for one day: try again tomorrow' using errcode='22023';end if;
 insert into kudos(org_id,from_person,to_person,note,task_id) values(current_org(),me,p_to,n,p_task) returning id into kid;
 perform notification_emit(p_to,'kudos.received','kudos',kid,'kudos:'||kid,left(work_first_name(me)||' thanked you: '||n,160),'/me#recognition','update');
 return kid;
end $$;
create function pulse.kudos_hide(p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 update kudos set hidden_at=now(),hidden_by=current_viewer() where org_id=current_org() and id=p_id and hidden_at is null
  and (to_person=current_viewer() or (current_viewer() is not null and viewer_is('admin','hr')));
 if not found then raise exception 'Only the receiver or HR hides kudos' using errcode='42501';end if;
end $$;

-- One read for the viewer's own home. Times are India time; working days follow their pattern.
create function pulse.me_pulse() returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer();today date:=lifecycle_today();wk date:=date_trunc('week',lifecycle_today())::date;p person;pp people_profile;e hr_employment;
 streak int:=0;d date;paid text;out jsonb;
begin
 if me is null then raise exception 'Sign in with your own account' using errcode='42501';end if;
 select * into p from person where org_id=current_org() and id=me;
 select * into pp from people_profile where person_id=me;
 select * into e from hr_employment where person_id=me;
 -- A streak: working days in a row, back from yesterday, with a check-in or finished work (today counts once it has one).
 d:=today;
 for i in 0..120 loop
  -- A day off never breaks it (work done on one still counts); a working day without anything does, except today.
  if exists(select 1 from attendance_effective a where a.person_id=me and a.work_date=d) or exists(select 1 from task t where coalesce(t.assignee_person_id,t.owner_id)=me and t.status='done' and value_done_on(t)=d) then streak:=streak+1;
  elsif d<today and hr_person_working(me,d) is not false then exit;
  end if;
  d:=d-1;
 end loop;
 select lt.key into paid from leave_type lt where lt.org_id=current_org() and lt.paid and lt.annual_days is not null order by lt.key limit 1;
 out:=jsonb_build_object(
  'person',jsonb_build_object('id',p.id,'name',p.display_name,'role',pp.role,'pod',pp.pod,'department',pp.department,'joinedOn',pp.joined_on,'stage',lifecycle_stage(me),
   'probationTo',e.probation_to,'lastWorkingDay',e.last_working_day,'photoAt',(select updated_at from person_photo where person_id=me)),
  'today',jsonb_build_object('date',today,'hour',extract(hour from now() at time zone 'Asia/Kolkata')::int,
   'due',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'status',t.status,'dueAt',t.due_at,'late',t.due_at<now()) order by t.due_at) from (
     select * from task t where coalesce(t.assignee_person_id,t.owner_id)=me and t.status in ('open','in_progress','blocked') and t.due_at<((today+1)::timestamp at time zone 'Asia/Kolkata') order by t.due_at limit 6) t),'[]'),
   'open',(select count(*) from task t where coalesce(t.assignee_person_id,t.owner_id)=me and t.status in ('open','in_progress','blocked')),
   'inProgress',(select count(*) from task t where coalesce(t.assignee_person_id,t.owner_id)=me and t.status='in_progress'),
   'shift',(select jsonb_build_object('name',s.name,'start',s.start_time,'end',s.end_time) from person_shift a join shift s on s.id=a.shift_id where a.person_id=me and a.valid_from<=today and (a.valid_to is null or a.valid_to>=today) order by a.valid_from desc limit 1),
   'workingDay',hr_person_working(me,today)),
  'week',jsonb_build_object('from',wk,
   'done',(select count(*) from task t where coalesce(t.assignee_person_id,t.owner_id)=me and t.status='done' and value_done_on(t)>=wk),
   'accepted',(select count(*) from task t where coalesce(t.assignee_person_id,t.owner_id)=me and t.accepted_at>=(wk::timestamp at time zone 'Asia/Kolkata')),
   'points',(select coalesce(sum(c.points),0) from work_credit c where c.person_id=me and c.reversed_at is null and c.work_day>=wk),
   'deliveries',(select count(*) from delivery dl join delivery_actor a on a.org_id=dl.org_id and a.file_id=dl.file_id where a.actor_id=me and dl.delivered_at>=(wk::timestamp at time zone 'Asia/Kolkata')),
   'minutes',(select coalesce(sum(minutes),0) from time_entry where person_id=me and status='confirmed' and retired_at is null and work_date>=wk),
   'checkInMinutes',(select coalesce(sum(extract(epoch from coalesce(a.checked_out_at,least(now(),a.checked_in_at+interval '10 hours'))-a.checked_in_at)/60),0)::int from attendance_effective a where a.person_id=me and a.work_date>=wk),
   'streak',streak),
  'growth',jsonb_build_object(
   'domains',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'title',d.title,'status',d.status,'basis',d.basis) order by d.status,d.title) from work_domain d where d.person_id=me and d.status in ('active','proposed')),'[]'),
   'kinds',coalesce((select jsonb_agg(jsonb_build_object('key',k.category,'label',coalesce(c.label,k.category),'recent',k.recent,'before',k.before) order by k.recent desc) from (
     select t.category,count(*) filter(where value_done_on(t)>=today-90) recent,count(*) filter(where value_done_on(t)<today-90 and value_done_on(t)>=today-180) before
     from task t where coalesce(t.assignee_person_id,t.owner_id)=me and t.status='done' and t.category is not null and value_done_on(t)>=today-180 group by 1) k
     left join work_category c on c.org_id=current_org() and c.key=k.category),'[]'),
   'feedback',coalesce((select jsonb_agg(f order by f->>'at' desc) from (
     select jsonb_build_object('kind','accepted','text',coalesce(nullif(t.value_note,''),'Accepted'),'task',t.title,'taskId',t.id,'by',(select display_name from person where id=t.accepted_by),'at',t.accepted_at) f
      from task t where coalesce(t.assignee_person_id,t.owner_id)=me and t.accepted_at is not null and t.accepted_at>now()-interval '90 days' order by t.accepted_at desc limit 6) x
     union all select f from (select jsonb_build_object('kind','returned','text',coalesce(ev.note,'Sent back for changes'),'task',t.title,'taskId',t.id,'by',(select display_name from person where id=ev.actor_id),'at',ev.at) f
      from task_event ev join task t on t.id=ev.task_id where coalesce(t.assignee_person_id,t.owner_id)=me and ev.kind='returned' and ev.at>now()-interval '90 days' order by ev.at desc limit 4) y),'[]'),
   -- What to learn next: kinds of work waiting (in the pool or unassigned) that they rarely do, where few people do.
   'learnNext',coalesce((select jsonb_agg(jsonb_build_object('key',z.category,'label',coalesce(c.label,z.category),'open',z.open,'doers',z.doers) order by z.open desc) from (
     select t.category,count(*) as open,(select count(distinct coalesce(x.assignee_person_id,x.owner_id)) from task x where x.category=t.category and x.status='done' and value_done_on(x)>=today-180) doers
     from task t where t.org_id=current_org() and t.status in ('open','in_progress','blocked') and t.assignee_person_id is null and t.owner_id is null and t.category is not null
      and (select count(*) from task x where coalesce(x.assignee_person_id,x.owner_id)=me and x.category=t.category and x.status='done')<2
     group by 1 order by count(*) desc limit 3) z left join work_category c on c.org_id=current_org() and c.key=z.category),'[]')),
  'money',jsonb_build_object(
   'payslips',coalesce((select jsonb_agg(jsonb_build_object('month',to_char(s.salary_month,'YYYY-MM'),'version',s.version,'issuedAt',s.issued_at,'net',s.snapshot->'net','reimbursements',s.snapshot->'reimbursements') order by s.salary_month desc)
     from (select distinct on (salary_month) * from pulse_priv.hr_payslip where org_id=current_org() and person_id=me order by salary_month desc,version desc limit 6) s),'[]'),
   'leaveKind',paid,'leaveDays',case when paid is not null then hr_balance_detail(me,paid,today)->'available' end,
   'compOffDays',hr_comp_balance(me,today),
   'pointsThisMonth',(select coalesce(sum(c.points),0) from work_credit c where c.person_id=me and c.reversed_at is null and c.work_day>=date_trunc('month',today)::date),
   'incentives',null),
  'recognition',jsonb_build_object(
   'kudos',coalesce((select jsonb_agg(jsonb_build_object('id',k.id,'from',jsonb_build_object('id',f.id,'name',f.display_name),'note',k.note,'at',k.created_at,
     'task',(select jsonb_build_object('id',t.id,'title',t.title) from task t where t.id=k.task_id)) order by k.created_at desc)
     from (select * from kudos where to_person=me and hidden_at is null order by created_at desc limit 12) k join person f on f.id=k.from_person),'[]'),
   'given',(select count(*) from kudos where from_person=me),
   'accepted',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'title',t.title,'at',t.accepted_at,'points',(select sum(points) from work_credit c where c.task_id=t.id and c.reversed_at is null),'by',(select display_name from person where id=t.accepted_by)) order by t.accepted_at desc)
     from (select * from task t where coalesce(t.assignee_person_id,t.owner_id)=me and t.accepted_at is not null order by t.accepted_at desc limit 5) t),'[]')),
  -- What Pulse knows, in plain words, each with where it comes from. Restricted HR sources are summarised.
  'knows',jsonb_build_array(
   jsonb_build_object('key','role','label','Your role','value',pp.role,'source',coalesce(pp.field_sources->'role'->>'source','Your HR record')),
   jsonb_build_object('key','pod','label','Pod and team','value',concat_ws(' · ',pp.pod,pp.department),'source',coalesce(pp.field_sources->'pod'->>'source','Your HR record')),
   jsonb_build_object('key','manager','label','You report to','value',(select display_name from person where id=coalesce(hr_head(me),pp.manager_id)),'source','Pod heads set by HR'),
   jsonb_build_object('key','joined','label','You joined','value',pp.joined_on,'source',coalesce(pp.field_sources->'joined_on'->>'source','Your HR record')),
   jsonb_build_object('key','stage','label','Where you are','value',lifecycle_stage(me),'source','Moves recorded by HR'),
   jsonb_build_object('key','email','label','Work e-mail','value',pp.email,'source','Your HR record'),
   jsonb_build_object('key','signin','label','How you sign in','value',case when exists(select 1 from account a where a.holder_person_id=me and a.provider='google' and not a.is_shared and a.purpose like 'Workspace%') then 'Google Workspace' when exists(select 1 from login_credential where person_id=me and status='active') then 'Pulse username '||coalesce(pp.username,'') else 'Not set up yet' end,'source','Sign-in settings'),
   jsonb_build_object('key','work','label','Work credited to you','value',(select count(*) from task t where coalesce(t.assignee_person_id,t.owner_id)=me and t.status='done')||' finished tasks, '
     ||(select count(*) from delivery dl join delivery_actor a on a.org_id=dl.org_id and a.file_id=dl.file_id where a.actor_id=me)||' deliveries','source','Tasks in Pulse and Drive uploads from your own account; shared logins are not credited unless confirmed'),
   jsonb_build_object('key','sources','label','Where your name appears','value',(select string_agg(distinct case when s.restricted then 'HR records' else s.label end,', ') from person_source s where s.person_id=me),'source','Rosters and documents Pulse reads'),
   jsonb_build_object('key','attendance','label','Attendance Pulse has','value',(select count(distinct work_date) from attendance_effective where person_id=me and work_date>=date_trunc('month',today)::date)||' days this month','source','Your check-ins in the app, on the web or the desktop')));
 return out;
end $$;

revoke all on function pulse.kudos_give(uuid,text,uuid),pulse.kudos_hide(uuid),pulse.me_pulse() from public;
grant execute on function pulse.kudos_give(uuid,text,uuid),pulse.kudos_hide(uuid),pulse.me_pulse() to pulse_api;
-- migrate:down
-- Forward-only.
