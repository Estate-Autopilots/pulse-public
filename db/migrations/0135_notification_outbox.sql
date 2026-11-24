-- migrate:up
-- One inbox, explicit domain identity, and a shared transport state machine. No provider activation.
-- Holidays keep their existing org/day primary key; this additive ID binds durable event subjects.
alter table pulse.holiday add column id uuid not null default gen_random_uuid();
create unique index holiday_event_id on pulse.holiday(org_id,id);
alter table pulse.notification add column event_type text not null default 'update.self'
 check(event_type in ('update.self','chat.message','chat.mention','chat.reply','policy.published','holiday.announced',
 'task.assigned','leave.decision','request.updated','request.decision','approval.waiting','approval.reminder',
 'payroll.processed','attendance.start','attendance.end','attendance.done','attendance.departure','attendance.confirmed'));
alter table pulse.notification add column subject_type text not null default 'person' check(subject_type in ('person','message','hr_flow','task','policy','holiday','payroll_notice'));
alter table pulse.notification add column subject_id uuid;
alter table pulse.notification add column event_key text;
alter table pulse.notification add column expires_at timestamptz not null default (clock_timestamp()+interval '48 hours');
alter table pulse.notification add column snoozed_until timestamptz;
alter table pulse.notification add column dismissed_at timestamptz;
create unique index notification_event_once on pulse.notification(org_id,person_id,event_type,event_key);
grant update(snoozed_until,dismissed_at) on pulse.notification to pulse_api;

-- This permission is an explicit accounts grant. Salary data and HR/admin roles never imply processed payroll.
create table pulse.payroll_notice_permission (
 org_id uuid not null references pulse.org(id),person_id uuid not null references pulse.person(id),
 granted_by uuid not null references pulse.person(id),revoked_at timestamptz,primary key(org_id,person_id)
);
create table pulse.payroll_processed_notice (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),month date not null check(extract(day from month)=1),
 source_key text not null check(length(source_key) between 1 and 100),
 processed_by uuid not null references pulse.person(id),processed_at timestamptz not null default clock_timestamp(),
 unique(org_id,source_key,person_id)
);
-- Only a later reviewed operation may enable approved reminder timing; no enabling route is shipped here.
create table pulse.notification_reminder_policy (
 org_id uuid primary key references pulse.org(id),enabled boolean not null default false,
 approval_ref text,timezone text not null default 'Asia/Kolkata',
 check(not enabled or (approval_ref is not null and length(btrim(approval_ref))>0))
);
create table pulse.notification_reminder (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),work_date date not null,
 family text not null check(family in ('checkin','checkout')),prompts int not null default 0 check(prompts between 0 and 2),
 last_at timestamptz,snoozed_until timestamptz,dismissed_at timestamptz,
 unique(org_id,person_id,work_date,family)
);
create table pulse.notification_delivery (
 org_id uuid not null references pulse.org(id),id uuid primary key default gen_random_uuid(),
 notification_id uuid not null references pulse.notification(id),
 channel text not null check(channel in ('web','native','telegram','email')),destination_id uuid not null,
 destination_version text not null,attempts int not null default 0 check(attempts between 0 and 5),
 status text not null default 'queued' check(status in ('queued','leased','dispatching','accepted','suppressed','expired','failed','uncertain')),
 retry_at timestamptz not null default clock_timestamp(),lease_token uuid,lease_until timestamptz,accepted_at timestamptz,
 unique(org_id,notification_id,channel,destination_id)
);
create index notification_delivery_due on pulse.notification_delivery(org_id,channel,retry_at) where status='queued';
do $$declare t text;begin
 foreach t in array array['payroll_notice_permission','payroll_processed_notice','notification_reminder_policy','notification_reminder','notification_delivery'] loop
 execute format('alter table pulse.%I enable row level security',t);
 execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('grant select on pulse.%I to pulse_api,pulse_worker',t);
 end loop;
end $$;
create policy self on pulse.notification_delivery as restrictive to pulse_api using(exists(
 select 1 from pulse.notification n where n.id=notification_id and n.person_id=pulse.current_viewer()));
create policy self on pulse.notification_reminder as restrictive to pulse_api using(person_id=pulse.current_viewer());
create policy self on pulse.payroll_processed_notice as restrictive to pulse_api using(person_id=pulse.current_viewer());
create policy accounts on pulse.payroll_notice_permission as restrictive to pulse_api using(person_id=pulse.current_viewer() or pulse.viewer_is('admin'));
create trigger audit_mutation after insert or update on pulse.payroll_notice_permission for each row execute function pulse.audit_mutation();
create trigger audit_mutation after insert on pulse.payroll_processed_notice for each row execute function pulse.audit_mutation();

-- Read the same confirmed membership sources as chat_refresh, without waiting for its cached member refresh.
create function pulse.notification_chat_member_current(p_channel uuid,p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from chat_member cm join chat_channel ch on ch.org_id=cm.org_id and ch.id=cm.channel_id
 join person p on p.org_id=cm.org_id and p.id=cm.person_id join people_profile pp on pp.org_id=p.org_id and pp.person_id=p.id
 left join workspace_group g on g.org_id=ch.org_id and g.address=ch.address
 where cm.org_id=current_org() and cm.channel_id=p_channel and cm.person_id=p_person and p.status='active' and p.side='staff'
 and (ch.kind='direct'
 or ch.kind='pod' and exists(select 1 from unit u where u.org_id=current_org() and 'pod:'||u.id=ch.key and u.valid_to is null and u.name=pp.pod)
 or ch.kind='team' and ch.key='team:'||lower(trim(pp.department))
 or ch.kind='group' and (g.source_kind='all' or g.source_kind='pod' and pp.pod=g.source_value
 or g.source_kind='team' and lower(pp.department)=lower(g.source_value)
 or g.source_kind='role' and exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p.id
 and r.role_key=any(string_to_array(g.source_value,',')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))
 or g.source_kind is null and exists(select 1 from account a cross join lateral jsonb_array_elements(g.members) m
 where a.org_id=current_org() and a.holder_person_id=p.id and not a.is_shared and lower(a.handle)=lower(m->>'email')))))
$$;
revoke all on function pulse.notification_chat_member_current(uuid,uuid) from public;
-- Read current domain recipients even for workers, administrators and previously queued events.
create function pulse.notification_recipient_allowed(p_person uuid,p_type text,p_subject text,p_id uuid)
 returns boolean language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active') then return false;end if;
 if p_type like 'chat.%' then
  return p_subject='message' and exists(select 1 from chat_message m join chat_member cm on cm.channel_id=m.channel_id and cm.org_id=m.org_id
   where m.org_id=current_org() and m.id=p_id and m.removed_at is null and cm.person_id=p_person and m.author_id<>p_person
   and (p_type<>'chat.mention' or p_person=any(m.mentions)) and notification_chat_member_current(m.channel_id,p_person));
 elsif p_type in ('request.updated','request.decision','leave.decision','approval.waiting','approval.reminder') then
  return p_subject='hr_flow' and exists(select 1 from hr_flow f where f.org_id=current_org() and f.id=p_id
   and (p_type<>'leave.decision' or f.kind='leave')
   and (p_type not in ('approval.waiting','approval.reminder') or f.status='pending')
   and ((p_type not in ('approval.waiting','approval.reminder') and f.person_id=p_person)
   or (p_type not in ('approval.waiting','approval.reminder') and (hr_is_staff(p_person) or hr_head(f.person_id)=p_person))
   or (f.stage<>'cofounder' and (hr_is_staff(p_person) or hr_head(f.person_id)=p_person))
   or (f.stage='cofounder' and (hr_is_staff(p_person) or hr_is_cofounder(p_person)))));
 elsif p_type='task.assigned' then
  return p_subject='task' and exists(select 1 from task where org_id=current_org() and id=p_id and coalesce(owner_id,assignee_person_id)=p_person);
 elsif p_type='policy.published' then
  return p_subject='policy' and exists(select 1 from policy_document where org_id=current_org() and id=p_id and status='published');
 elsif p_type='holiday.announced' then
  return p_subject='holiday' and exists(select 1 from holiday where org_id=current_org() and id=p_id);
 elsif p_type='payroll.processed' then
  return p_subject='payroll_notice' and exists(select 1 from payroll_processed_notice where org_id=current_org() and id=p_id and person_id=p_person);
 elsif p_type like 'attendance.%' or p_type='update.self' then
  return p_subject='person' and p_id=p_person;
 end if;
 return false;
end $$;
create function pulse.notification_authorized(p_id uuid,p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from notification n where n.org_id=current_org() and n.id=p_id and n.person_id=p_person
 and notification_recipient_allowed(p_person,n.event_type,n.subject_type,coalesce(n.subject_id,n.person_id))
 and (n.channel_id is null or notification_chat_member_current(n.channel_id,p_person))
 and (n.href not like '/settings%' or exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p_person and r.role_key in ('admin','leadership') and current_date between r.valid_from and coalesce(r.valid_to,'infinity')))
 and (n.href not like '/hr%' or hr_is_staff(p_person))
 and (n.href !~ '^/people/[0-9a-f-]{36}$' or hr_is_staff(p_person) or hr_head(substring(n.href from '[0-9a-f-]{36}$')::uuid)=p_person or substring(n.href from '[0-9a-f-]{36}$')::uuid=p_person))
$$;
-- Compatibility rows remain in the inbox; unknown legacy records are never transported automatically.
create function pulse.notification_contract() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r notification_reminder;workday date;entry_id uuid;
begin
 if new.event_type='update.self' then
  if new.title='Leaving for the day? Check out when you finish.' and new.href='/me' then
   -- Preserve the accepted presence producer, while sharing one person/day checkout budget.
   select work_date into workday from attendance_entry where org_id=current_org() and person_id=new.person_id and checked_out_at is null and voided_at is null order by checked_in_at desc limit 1;
   if workday is null then return null;end if;
   insert into notification_reminder(org_id,person_id,work_date,family) values(current_org(),new.person_id,workday,'checkout') on conflict do nothing;
   select * into r from notification_reminder where org_id=current_org() and person_id=new.person_id and work_date=workday and family='checkout' for update;
   if r.prompts>=2 or r.dismissed_at is not null or r.snoozed_until>clock_timestamp() or r.last_at>clock_timestamp()-interval '15 minutes' then return null;end if;
   new.event_type:='attendance.departure';new.kind:='attendance';new.subject_type:='person';new.subject_id:=new.person_id;
   new.event_key:=r.id||':'||(r.prompts+1);new.expires_at:=clock_timestamp()+interval '2 hours';
   update notification_reminder set prompts=prompts+1,last_at=clock_timestamp() where id=r.id;
  elsif new.title='You’re checked in · office presence confirmed' and new.href='/me' then
   select id into entry_id from attendance_entry where org_id=current_org() and person_id=new.person_id and checked_out_at is null and voided_at is null order by checked_in_at desc limit 1;
   new.event_type:='attendance.confirmed';new.kind:='attendance';new.subject_type:='person';new.subject_id:=new.person_id;
   new.event_key:=coalesce(entry_id,new.id)::text;
  elsif new.message_id is not null then
   new.event_type:=case new.kind when 'mention' then 'chat.mention' when 'reply' then 'chat.reply' else 'chat.message' end;
   new.subject_type:='message';new.subject_id:=new.message_id;new.event_key:=new.message_id::text;
  elsif new.href ~ '^/me/approvals\?request=[0-9a-f-]{36}$' then
   new.subject_type:='hr_flow';new.subject_id:=substring(new.href from '[0-9a-f-]{36}$')::uuid;
   new.event_type:=case when new.title='HR request reminder' then 'approval.reminder'
    when new.kind='decision' then case when exists(select 1 from hr_flow where id=new.subject_id and kind='leave') then 'leave.decision' else 'request.decision' end
    when new.kind='approval' then 'request.updated' else 'request.updated' end;
  elsif new.href ~ '^/tasks\?task=[0-9a-f-]{36}$' and new.kind='task' then
   new.event_type:='task.assigned';new.subject_type:='task';new.subject_id:=substring(new.href from '[0-9a-f-]{36}$')::uuid;
  end if;
 end if;
 new.subject_id:=coalesce(new.subject_id,new.person_id);new.event_key:=coalesce(new.event_key,new.id::text);
 return new;
end $$;
-- Alphabetic trigger order: kind inference precedes normalization.
create trigger notification_z_contract before insert on pulse.notification for each row execute function pulse.notification_contract();
do $$declare tenant uuid;previous_org text:=current_setting('pulse.org_id',true);begin
for tenant in select id from pulse.org loop
perform set_config('pulse.org_id',tenant::text,true);
update pulse.notification set subject_id=person_id,event_key=id::text,expires_at=created_at+interval '48 hours' where org_id=tenant;
update pulse.notification set event_type=case kind when 'mention' then 'chat.mention' when 'reply' then 'chat.reply' else 'chat.message' end,
 subject_type='message',subject_id=message_id,event_key=message_id::text where org_id=tenant and message_id is not null;
update pulse.notification set subject_type='hr_flow',subject_id=substring(href from '[0-9a-f-]{36}$')::uuid,
 event_type=case when title='HR request reminder' then 'approval.reminder' when kind='decision' then 'request.decision' else 'request.updated' end
 where org_id=tenant and href ~ '^/me/approvals\?request=[0-9a-f-]{36}$';
update pulse.notification set subject_type='task',subject_id=substring(href from '[0-9a-f-]{36}$')::uuid,event_type='task.assigned'
 where org_id=tenant and href ~ '^/tasks\?task=[0-9a-f-]{36}$' and kind='task';
end loop;
perform set_config('pulse.org_id',coalesce(previous_org,''),true);
end $$;
alter table pulse.notification alter column subject_id set not null;
alter table pulse.notification alter column event_key set not null;
alter table pulse.notification add constraint notification_event_key_length check(length(event_key) between 1 and 200);

create function pulse.notification_emit(p_person uuid,p_type text,p_subject text,p_id uuid,p_key text,p_title text,p_href text,p_kind text,p_copies boolean default false)
 returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;
begin
 if not notification_recipient_allowed(p_person,p_type,p_subject,p_id) then return null;end if;
 if p_key is null or length(p_key)>200 or p_href !~ '^/[^/]' or position(E'\n' in p_href)>0 then raise exception 'Invalid notification contract' using errcode='22023';end if;
 insert into notification(org_id,person_id,event_type,subject_type,subject_id,event_key,title,href,kind,telegram_status)
 values(current_org(),p_person,p_type,p_subject,p_id,p_key,p_title,p_href,p_kind,
 case when p_copies and exists(select 1 from pulse_priv.telegram_person where org_id=current_org() and person_id=p_person) then 'queued' else 'recipient_not_connected' end)
 on conflict(org_id,person_id,event_type,event_key) do nothing returning id into nid;
 if p_copies and nid is not null then insert into hr_mail_outbox(org_id,notification_id,person_id) values(current_org(),nid,p_person) on conflict do nothing;end if;
 return nid;
end $$;
create function pulse.payroll_notice_grant(p_person uuid,p_revoke boolean) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not viewer_is('admin') then raise exception 'Administrator required' using errcode='42501';end if;
 if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active') then raise exception 'Active accounts person required' using errcode='22023';end if;
 insert into payroll_notice_permission(org_id,person_id,granted_by,revoked_at) values(current_org(),p_person,current_viewer(),case when p_revoke then clock_timestamp() end)
 on conflict(org_id,person_id) do update set granted_by=excluded.granted_by,revoked_at=excluded.revoked_at;
end $$;
create function pulse.payroll_notice_processed(p_person uuid,p_month date,p_key text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare nid uuid;prior payroll_processed_notice;
begin
 if not exists(select 1 from payroll_notice_permission g join person p on p.id=g.person_id and p.org_id=g.org_id
 where g.org_id=current_org() and g.person_id=current_viewer() and g.revoked_at is null and p.status='active') then raise exception 'Authorized accounts required' using errcode='42501';end if;
 if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active') then raise exception 'Active recipient required' using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtext('payroll-notice:'||current_org()::text||':'||p_person::text||':'||p_key));
 select * into prior from payroll_processed_notice where org_id=current_org() and person_id=p_person and source_key=p_key;
 if found then
  if prior.month<>p_month then raise exception 'Processed key already used' using errcode='22023';end if;
  return prior.id;
 end if;
 insert into payroll_processed_notice(org_id,person_id,month,source_key,processed_by) values(current_org(),p_person,p_month,p_key,current_viewer()) returning id into nid;
 perform notification_emit(p_person,'payroll.processed','payroll_notice',nid,nid::text,'Payroll marked processed by accounts','/me?tab=overview&month='||to_char(p_month,'YYYY-MM'),'payroll');
 return nid;
end $$;

create function pulse.notification_active_shift(p_person uuid,p_at timestamptz default clock_timestamp()) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from notification_reminder_policy rp join person_shift ps using(org_id) join shift s on s.id=ps.shift_id and s.org_id=ps.org_id
 cross join lateral generate_series(-1,0) d
 cross join lateral (select (p_at at time zone rp.timezone)::date+d as work_day) x
 where rp.org_id=current_org() and rp.enabled and rp.approval_ref is not null and ps.person_id=p_person
 and x.work_day between ps.valid_from and coalesce(ps.valid_to,'infinity') and hr_working(p_person,x.work_day,s.work_days)
 and p_at>=(x.work_day+s.start_time) at time zone rp.timezone
 and p_at<((x.work_day+case when s.end_time<=s.start_time then 1 else 0 end)+s.end_time) at time zone rp.timezone)
$$;
create function pulse.notification_ping_allowed(p_person uuid,p_kind text,p_channel text,p_at timestamptz default clock_timestamp()) returns boolean
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare s jsonb;local_time text;quiet_start text;quiet_end text;
begin
 select settings into s from companion_notification_settings where org_id=current_org() and person_id=p_person;s:=coalesce(s,'{}');
 if coalesce((s->>'dnd')::boolean,false) or s->'types'->>p_kind='false' or s->'channels'->>p_channel='false'
 or coalesce((s->>'snoozedUntil')::timestamptz,'-infinity')>p_at then return false;end if;
 if not coalesce((s->>'quiet')::boolean,false) then return true;end if;
 if coalesce((s->>'nightShift')::boolean,false) and notification_active_shift(p_person,p_at) then return true;end if;
 local_time:=to_char(p_at at time zone coalesce(s->>'timezone','Asia/Kolkata'),'HH24:MI');
 quiet_start:=coalesce(s->>'start','21:00');quiet_end:=coalesce(s->>'end','08:00');
 return not (quiet_start=quiet_end or case when quiet_start<quiet_end then local_time>=quiet_start and local_time<quiet_end else local_time>=quiet_start or local_time<quiet_end end);
exception when others then return false;
end $$;

-- Capture enrolled destinations before a shared conversation read can win the polling race.
-- Capturing a receipt never activates a provider; dispatch still checks current permission and preferences.
create function pulse.notification_capture_destinations() returns trigger
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.event_type='update.self' or not notification_authorized(new.id,new.person_id) then return new;end if;
 insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
 select new.org_id,new.id,'web',s.id,s.created_at::text from web_push_subscription s
 where s.org_id=new.org_id and s.person_id=new.person_id and s.created_at<=new.created_at and s.disabled_at is null
 on conflict do nothing;
 insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
 select new.org_id,new.id,'native',d.id,d.consent_epoch::text from native_device d
 where d.org_id=new.org_id and d.person_id=new.person_id and d.created_at<=new.created_at
 and d.revoked_at is null and d.push_token is not null and d.platform in ('ios','android')
 on conflict do nothing;
 return new;
end $$;
revoke all on function pulse.notification_capture_destinations() from public;
create trigger notification_capture_destinations after insert on pulse.notification for each row execute function pulse.notification_capture_destinations();

create function pulse.notification_outbox_seed(p_channel text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 -- Only an undispatched lease can safely be retried. A crashed dispatch is ambiguous, never replayed.
 update notification_delivery set status=case when status='dispatching' then 'uncertain' else 'queued' end,lease_token=null,lease_until=null
 where org_id=current_org() and channel=p_channel and status in ('leased','dispatching') and lease_until<clock_timestamp();
 update notification_delivery q set status='expired' from notification n where q.org_id=current_org() and n.id=q.notification_id
 and q.status in ('queued','leased') and (n.expires_at<=clock_timestamp() or q.attempts>=5);
 update notification_delivery q set status='suppressed' where q.org_id=current_org() and q.channel=p_channel and q.status='queued'
 and (p_channel='web' and exists(select 1 from web_push_delivery old where old.org_id=q.org_id and old.notification_id=q.notification_id and old.subscription_id=q.destination_id and old.status in ('accepted','expired','suppressed'))
 or p_channel='native' and exists(select 1 from native_push_delivery old where old.org_id=q.org_id and old.notification_id=q.notification_id and old.device_id=q.destination_id and old.sent_at is not null));
 if p_channel='web' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'web',s.id,s.created_at::text from notification n join web_push_subscription s using(org_id,person_id)
  where n.org_id=current_org() and n.created_at>=s.created_at and s.disabled_at is null and n.expires_at>clock_timestamp()
  and (n.read_at is null or n.message_id is not null and exists(select 1 from web_push_delivery old
   where old.org_id=n.org_id and old.notification_id=n.id and old.subscription_id=s.id and old.status='queued'))
  and n.event_type<>'update.self'
  and not exists(select 1 from web_push_delivery old where old.org_id=n.org_id and old.notification_id=n.id and old.subscription_id=s.id and old.status in ('accepted','expired','suppressed')) on conflict do nothing;
 elsif p_channel='native' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'native',d.id,d.consent_epoch::text from notification n join native_device d using(org_id,person_id)
  where n.org_id=current_org() and n.created_at>=d.created_at and d.revoked_at is null and d.push_token is not null
  and d.platform in ('ios','android') and n.expires_at>clock_timestamp() and n.read_at is null and n.event_type<>'update.self'
  and not exists(select 1 from native_push_delivery old where old.org_id=n.org_id and old.notification_id=n.id and old.device_id=d.id and old.sent_at is not null) on conflict do nothing;
 elsif p_channel='telegram' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'telegram',n.person_id,t.verified_at::text from notification n join pulse_priv.telegram_person t using(org_id,person_id)
  where n.org_id=current_org() and n.telegram_status='queued' and n.expires_at>clock_timestamp()
  and n.event_type in ('leave.decision','request.decision','request.updated','approval.waiting','approval.reminder') on conflict do nothing;
 elsif p_channel='email' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'email',n.person_id,'hr-copy' from notification n join hr_mail_outbox m on m.notification_id=n.id and m.org_id=n.org_id and m.person_id=n.person_id
  where n.org_id=current_org() and m.status in ('queued','disabled') and n.expires_at>clock_timestamp()
  and n.event_type in ('leave.decision','request.decision','request.updated','approval.waiting','approval.reminder') on conflict do nothing;
 end if;
end $$;
create function pulse.notification_outbox_claim(p_channel text) returns setof pulse.notification_delivery
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform notification_outbox_seed(p_channel);
 return query with picked as (
  select id from notification_delivery where org_id=current_org() and channel=p_channel and status='queued'
  and retry_at<=clock_timestamp() and attempts<5 order by retry_at,id limit 30 for update skip locked
 ) update notification_delivery q set status='leased',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes'
 from picked where q.id=picked.id returning q.*;
end $$;
create function pulse.notification_outbox_dispatch(p_id uuid,p_token uuid) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare q notification_delivery;n notification;payload jsonb;dest jsonb;
begin
 select * into q from notification_delivery where org_id=current_org() and id=p_id and status='leased' and lease_token=p_token and lease_until>clock_timestamp() for update;
 if not found then return null;end if;
 select * into n from notification where org_id=current_org() and id=q.notification_id;
 if n.expires_at<=clock_timestamp() then update notification_delivery set status='expired' where id=q.id;return null;end if;
 if not notification_authorized(n.id,n.person_id) or n.dismissed_at is not null then
  update notification_delivery set status='suppressed' where id=q.id;return null;
 end if;
 if n.event_type in ('attendance.start','attendance.end','attendance.done','attendance.departure') and not exists(select 1 from notification_reminder_policy where org_id=current_org() and enabled and approval_ref is not null) then
  update notification_delivery set status='suppressed' where id=q.id;return null;
 end if;
 if n.snoozed_until>clock_timestamp() or not notification_ping_allowed(n.person_id,n.kind,q.channel) then
  update notification_delivery set status='queued',retry_at=greatest(clock_timestamp()+interval '5 minutes',coalesce(n.snoozed_until,clock_timestamp())),lease_token=null,lease_until=null where id=q.id;return null;
 end if;
 if q.channel='web' and exists(select 1 from web_push_delivery where org_id=q.org_id and notification_id=n.id and subscription_id=q.destination_id and status in ('accepted','expired','suppressed'))
 or q.channel='native' and exists(select 1 from native_push_delivery where org_id=q.org_id and notification_id=n.id and device_id=q.destination_id and sent_at is not null) then
  update notification_delivery set status='suppressed' where id=q.id;return null;
 end if;
 if q.channel='web' then
  select jsonb_build_object('endpoint',endpoint,'keys',keys) into dest from web_push_subscription where org_id=q.org_id and id=q.destination_id
  and person_id=n.person_id and disabled_at is null and created_at::text=q.destination_version;
 elsif q.channel='native' then
  select jsonb_build_object('token',push_token,'platform',platform) into dest from native_device where org_id=q.org_id and id=q.destination_id
  and person_id=n.person_id and revoked_at is null and push_token is not null and consent_epoch::text=q.destination_version and platform in ('ios','android');
 elsif q.channel='telegram' then
  select jsonb_build_object('chatId',chat_id) into dest from pulse_priv.telegram_person where org_id=q.org_id and person_id=n.person_id and verified_at::text=q.destination_version;
 elsif q.channel='email' then
  select jsonb_build_object('email',coalesce(nullif(pp.email,''),(select handle from account a where a.org_id=q.org_id and a.holder_person_id=n.person_id
   and a.provider='google' and a.purpose like 'Workspace%' order by a.handle limit 1))) into dest from people_profile pp where pp.org_id=q.org_id and pp.person_id=n.person_id;
 end if;
 if dest is null then update notification_delivery set status='suppressed' where id=q.id;return null;end if;
 payload:=jsonb_build_object('id',n.id,'personId',n.person_id,'title',case when n.event_type in ('leave.decision','request.decision','request.updated','approval.waiting','approval.reminder') and n.title ~ '^HR request (submitted|approved|rejected|cancelled|forwarded|updated|reminder)$' then n.title else 'A work update is ready' end,'href','/notifications?event='||n.id,'expiresAt',n.expires_at,'destination',dest);
 update notification_delivery set status='dispatching',attempts=attempts+1,lease_until=clock_timestamp()+interval '2 minutes' where id=q.id;
 return payload;
end $$;
create function pulse.notification_outbox_finish(p_id uuid,p_token uuid,p_outcome text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare q notification_delivery;
begin
 if p_outcome not in ('accepted','retry','expired','failed','uncertain') then raise exception 'Invalid delivery outcome';end if;
 select * into q from notification_delivery where org_id=current_org() and id=p_id and lease_token=p_token and status='dispatching' for update;
 if not found then return;end if;
 update notification_delivery set status=case when p_outcome='retry' then case when attempts<5 then 'queued' else 'failed' end else p_outcome end,
 retry_at=clock_timestamp()+make_interval(secs=>least(3600,30*(2^attempts)::int)),
 accepted_at=case when p_outcome='accepted' then clock_timestamp() end,lease_token=null,lease_until=null where id=q.id;
 if q.channel='web' and p_outcome in ('accepted','expired','failed') then update web_push_delivery set status=p_outcome where org_id=q.org_id and notification_id=q.notification_id and subscription_id=q.destination_id;end if;
 if q.channel='native' and p_outcome='accepted' then update native_push_delivery set sent_at=clock_timestamp() where org_id=q.org_id and notification_id=q.notification_id and device_id=q.destination_id;end if;
 if p_outcome='expired' and q.channel='web' then update web_push_subscription set disabled_at=clock_timestamp() where org_id=q.org_id and id=q.destination_id and created_at::text=q.destination_version;end if;
 if p_outcome='expired' and q.channel='native' then update native_device set push_token=null where org_id=q.org_id and id=q.destination_id and consent_epoch::text=q.destination_version;end if;
 if q.channel='telegram' then update notification set telegram_status=case when p_outcome='accepted' then 'sent' when p_outcome='retry' and q.attempts<5 then 'queued' else 'failed' end where org_id=q.org_id and id=q.notification_id;end if;
 if q.channel='email' then update hr_mail_outbox set status=case when p_outcome='accepted' then 'sent' when p_outcome='retry' and q.attempts<5 then 'queued' else 'failed' end where org_id=q.org_id and notification_id=q.notification_id;end if;
end $$;

-- Self controls apply to the unresolved reminder family as well as this event, so snooze cannot create a second engine.
create function pulse.notification_snooze(p_id uuid,p_minutes int,p_dismiss boolean) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n notification;
begin
 if p_minutes not in (15,60,240) or current_viewer() is null then raise exception 'Choose 15, 60 or 240 minutes' using errcode='22023';end if;
 select * into n from notification where org_id=current_org() and id=p_id and person_id=current_viewer() and notification_authorized(id,current_viewer()) for update;
 if not found then raise exception 'Your available notification required' using errcode='42501';end if;
 update notification set snoozed_until=case when not p_dismiss then clock_timestamp()+make_interval(mins=>p_minutes) end,
 dismissed_at=case when p_dismiss then clock_timestamp() end where id=p_id;
 if n.event_type like 'attendance.%' then
  update notification_reminder set snoozed_until=case when not p_dismiss then clock_timestamp()+make_interval(mins=>p_minutes) end,
  dismissed_at=case when p_dismiss then clock_timestamp() end where org_id=current_org() and person_id=current_viewer()
  and id::text=split_part(n.event_key,':',1);
 end if;
end $$;
create function pulse.notification_attendance_prompt(p_person uuid,p_date date,p_phase text,p_at timestamptz default clock_timestamp()) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r notification_reminder;nid uuid;family_key text;label text;
begin
 if p_phase not in ('start','end','done','departure') then raise exception 'Unsupported attendance prompt';end if;
 if not exists(select 1 from notification_reminder_policy where org_id=current_org() and enabled and approval_ref is not null) then return null;end if;
 if not notification_recipient_allowed(p_person,'attendance.'||p_phase,'person',p_person) then return null;end if;
 if p_phase='start' and exists(select 1 from attendance_entry where org_id=current_org() and person_id=p_person and work_date=p_date and voided_at is null) then return null;end if;
 if p_phase<>'start' and not exists(select 1 from attendance_entry where org_id=current_org() and person_id=p_person and work_date=p_date and checked_out_at is null and voided_at is null) then return null;end if;
 family_key:=case when p_phase='start' then 'checkin' else 'checkout' end;
 insert into notification_reminder(org_id,person_id,work_date,family) values(current_org(),p_person,p_date,family_key) on conflict do nothing;
 select * into r from notification_reminder where org_id=current_org() and person_id=p_person and work_date=p_date and family=family_key for update;
 if r.prompts>=2 or r.dismissed_at is not null or r.snoozed_until>p_at or r.last_at>p_at-interval '15 minutes' then return null;end if;
 label:=case p_phase when 'start' then 'Ready to check in?' when 'done' then 'Done for the day?' when 'end' then 'Still working? Check out when you finish.' else 'Possibly left the office? Check out when you finish.' end;
 nid:=notification_emit(p_person,'attendance.'||p_phase,'person',p_person,r.id||':'||(r.prompts+1),label,'/me','attendance');
 if nid is not null then
  update notification set expires_at=p_at+interval '2 hours' where id=nid;
  update notification_reminder set prompts=prompts+1,last_at=p_at where id=r.id;
 end if;
 return nid;
end $$;
create function pulse.notification_reminder_tick(p_at timestamptz default clock_timestamp()) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record;n int:=0;phase text;nid uuid;
begin
 for r in select ps.person_id,s.start_time,s.end_time,x.work_day,rp.timezone,
  (x.work_day+s.start_time) at time zone rp.timezone starts,
  ((x.work_day+case when s.end_time<=s.start_time then 1 else 0 end)+s.end_time) at time zone rp.timezone ends
 from notification_reminder_policy rp join person_shift ps using(org_id) join shift s on s.org_id=ps.org_id and s.id=ps.shift_id
 cross join lateral generate_series(-1,0) d cross join lateral (select (p_at at time zone rp.timezone)::date+d as work_day) x
 where rp.org_id=current_org() and rp.enabled and rp.approval_ref is not null
 and x.work_day between ps.valid_from and coalesce(ps.valid_to,'infinity') and hr_working(ps.person_id,x.work_day,s.work_days) loop
  phase:=null;
  if p_at>=r.starts+interval '15 minutes' and p_at<r.ends then phase:='start';end if;
  if p_at>=r.ends and p_at<r.ends+interval '15 minutes' and exists(select 1 from companion_notification_settings where org_id=current_org() and person_id=r.person_id and settings->'reminders'->>'done'='true') then phase:='done';end if;
  if p_at>=r.ends+interval '15 minutes' and p_at<r.ends+interval '2 hours' then phase:='end';end if;
  if phase is not null then
   nid:=notification_attendance_prompt(r.person_id,r.work_day,phase,p_at);
   if nid is not null then n:=n+1;end if;
  end if;
 end loop;
 return n;
end $$;

revoke all on function pulse.notification_recipient_allowed(uuid,text,text,uuid),pulse.notification_authorized(uuid,uuid),pulse.notification_contract(),
 pulse.notification_emit(uuid,text,text,uuid,text,text,text,text,boolean),pulse.payroll_notice_grant(uuid,boolean),pulse.payroll_notice_processed(uuid,date,text),
 pulse.notification_active_shift(uuid,timestamptz),pulse.notification_ping_allowed(uuid,text,text,timestamptz),
 pulse.notification_outbox_seed(text),pulse.notification_outbox_claim(text),pulse.notification_outbox_dispatch(uuid,uuid),pulse.notification_outbox_finish(uuid,uuid,text),
 pulse.notification_snooze(uuid,int,boolean),pulse.notification_attendance_prompt(uuid,date,text,timestamptz),pulse.notification_reminder_tick(timestamptz) from public;
grant execute on function pulse.notification_authorized(uuid,uuid),pulse.notification_active_shift(uuid,timestamptz),pulse.notification_ping_allowed(uuid,text,text,timestamptz),
 pulse.notification_snooze(uuid,int,boolean),pulse.payroll_notice_grant(uuid,boolean),pulse.payroll_notice_processed(uuid,date,text) to pulse_api;
grant execute on function pulse.notification_authorized(uuid,uuid),pulse.notification_outbox_seed(text),pulse.notification_outbox_claim(text),
 pulse.notification_outbox_dispatch(uuid,uuid),pulse.notification_outbox_finish(uuid,uuid,text),pulse.notification_reminder_tick(timestamptz),
 pulse.notification_attendance_prompt(uuid,date,text,timestamptz) to pulse_worker;

alter table pulse.task add column notification_revision bigint not null default 0;
alter table pulse.holiday add column notification_revision bigint not null default 0;
create function pulse.notification_source_revision() returns trigger language plpgsql set search_path=pulse,pg_temp as $$
begin
 if TG_OP='INSERT' then new.notification_revision:=1;
 elsif TG_TABLE_NAME='task' then new.notification_revision:=old.notification_revision+case when (new.owner_id,new.assignee_person_id) is distinct from (old.owner_id,old.assignee_person_id) then 1 else 0 end;
 else new.notification_revision:=old.notification_revision+case when (new.name,new.optional,new.day) is distinct from (old.name,old.optional,old.day) then 1 else 0 end;end if;
 return new;
end $$;
create trigger notification_revision before insert or update on pulse.task for each row execute function pulse.notification_source_revision();
create trigger notification_revision before insert or update on pulse.holiday for each row execute function pulse.notification_source_revision();
revoke all on function pulse.notification_source_revision() from public;
-- Reuse the accepted producers and HR reminder interval/locks; do not add a parallel approval scheduler.
create or replace function pulse.hr_flow_publish() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare recipient uuid;nid uuid;label text;act text;event_id uuid;event_type_key text;
begin
 if TG_OP='UPDATE' and (new.status,new.stage,new.decision_note,new.decided_by) is not distinct from (old.status,old.stage,old.decision_note,old.decided_by) then return null;end if;
 act:=case when TG_OP='INSERT' and current_viewer() is null then 'imported' when TG_OP='INSERT' then case when new.status='pending' then 'submitted' else 'recorded: '||new.status end when new.status<>old.status then new.status when new.status<>'pending' then 'override: '||new.status when new.stage<>old.stage then 'forwarded to '||new.stage else 'asked' end;
 insert into hr_flow_event(org_id,flow_id,actor_id,action,note) values(new.org_id,new.id,current_viewer(),act,case when TG_OP='INSERT' then new.note else new.decision_note end) returning id into event_id;
 if current_viewer() is null then return null;end if;
 label:='HR request '||case when new.status<>'pending' then new.status when TG_OP='INSERT' then 'submitted' when new.stage='cofounder' then 'forwarded' else 'updated' end;
 event_type_key:=case when new.status<>'pending' then case when new.kind='leave' then 'leave.decision' else 'request.decision' end else 'request.updated' end;
 for recipient in select distinct id from person where org_id=new.org_id and status='active' and
 (id=new.person_id or id=hr_head(new.person_id) or hr_is_staff(id) or (new.stage='cofounder' and hr_is_cofounder(id))) loop
 perform notification_emit(recipient,case when new.status='pending' and recipient<>new.person_id and ((new.stage='cofounder' and hr_is_cofounder(recipient)) or (new.stage<>'cofounder' and (hr_is_staff(recipient) or hr_head(new.person_id)=recipient))) then 'approval.waiting' else event_type_key end,'hr_flow',new.id,event_id::text,label,'/me/approvals?request='||new.id,case when new.status='pending' then 'approval' else 'decision' end,true);
 end loop;return null;
end $$;

create or replace function pulse.hr_flow_remind() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare f record;r uuid;nid uuid;n int:=0;
begin
 for f in select q.* from hr_flow q join hr_flow_policy p using(org_id) where q.org_id=current_org() and q.status='pending'
 and coalesce(q.reminded_at,q.updated_at)<now()-make_interval(hours=>p.reminder_hours) for update of q skip locked loop
 for r in select id from person where org_id=current_org() and status='active' and
 ((f.stage='cofounder' and hr_is_cofounder(id)) or (f.stage<>'cofounder' and (hr_is_staff(id) or id=hr_head(f.person_id)))) and id<>f.person_id loop
 perform notification_emit(r,'approval.reminder','hr_flow',f.id,f.id||':reminder:'||coalesce(f.reminded_at,f.updated_at)::text,'HR request reminder','/me/approvals?request='||f.id,'approval',true);
 end loop;
 update hr_flow set reminded_at=now() where id=f.id;n:=n+1;
 end loop;return n;
end $$;
create or replace function pulse.companion_work_update() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare target uuid;recipient uuid;
begin
 if current_viewer() is null then return null;end if;
 if TG_TABLE_NAME='task' then
  target:=coalesce(new.owner_id,new.assignee_person_id);
  if target is null or TG_OP='UPDATE' and target is not distinct from coalesce(old.owner_id,old.assignee_person_id) then return null;end if;
  perform notification_emit(target,'task.assigned','task',new.id,new.id||':'||new.notification_revision,'A task was assigned to you','/tasks?task='||new.id,'task');
 elsif TG_TABLE_NAME='policy_document' then
  if new.status<>'published' or TG_OP='UPDATE' and old.status='published' then return null;end if;
  for recipient in select id from person where org_id=new.org_id and side='staff' and status='active' loop
   perform notification_emit(recipient,'policy.published','policy',new.id,new.id::text,'A policy update is ready','/me?tab=policies&kind='||new.kind,'policy');
  end loop;
 elsif TG_TABLE_NAME='holiday' then
  if TG_OP='UPDATE' and (new.name,new.optional,new.day) is not distinct from (old.name,old.optional,old.day) then return null;end if;
  for recipient in select id from person where org_id=new.org_id and side='staff' and status='active' loop
   perform notification_emit(recipient,'holiday.announced','holiday',new.id,new.id||':'||new.notification_revision,'The holiday list was updated','/me?tab=leave','holiday');
  end loop;
 end if;return null;
end $$;

-- migrate:down
-- Additive receipts are retained. Rollback does not delete company events or grant provider activation.
