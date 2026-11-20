-- migrate:up
-- ATT (21 Oct 2026): one notification policy for the bell, Pip's island, the laptop and Chrome companions, phone and
-- browser push, Telegram and email. Production before this (5–21 Oct, 896 notifications to 23 people): 42 % were
-- "Ready to check in?" (twice a day to all 21 staff, 13 of whom never once checked in with Pulse; none was read),
-- 20 % were "HR request reminder" (one per pending request per approver per day, 8 of the 9 pending requests being
-- Pulse's own wrong check-out proposals), and bursts were never folded (55 in one day for one person). Every one of
-- them could toast or push. Now:
--
-- 1. Every notification has a priority: urgent, needs_you or fyi (pulse.notification_priority, by event type; a
--    message in a group conversation is fyi unless it mentions or replies to you).
-- 2. A notification is "quiet" (stays in the bell, never toasts or pushes; HR copies by Telegram/email, an opt-in, still
--    go unless muted or over the limit) when it is fyi,
--    when the person muted its family (My desk → Settings → Notifications), or when that family already pinged them
--    as often as its daily limit allows (pulse.notification_daily_pings). Quiet is decided once, at insert.
-- 3. The same reminder is never sent twice while the earlier one is still unread and current (reminder families only).
-- 4. HR request reminders are one daily digest per approver ("3 requests wait for your decision"), sent once a
--    working day after 10:30 company time, never one per request.
-- 5. "Ready to check in?" goes once a day (it went twice, 15 minutes apart; other phases keep two), and stops for someone who let the last
--    three reminders pass without checking in on those days; they come back the day the person checks in again.
--    HR sees who is not checking in in the daily attendance digest (ATT part 3) instead.
-- Nothing already stored changes; the bell reads old rows with the same rules (priority null → by event type).

select pulse.check_values_add('pulse.notification'::regclass, 'notification_event_type_check', 'event_type',
  array['approval.digest','attendance.digest','attendance.ask','attendance.auto']);

alter table pulse.notification add column priority text check (priority in ('urgent','needs_you','fyi')),
  add column quiet boolean not null default false,
  add column quiet_reason text check (quiet_reason in ('fyi','muted','limit'));

-- Which family a notification belongs to: the unit people mute, the bell folds ("3 tasks assigned") and limits count.
create function pulse.notification_family(p_type text) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select case
  when p_type in ('attendance.start','attendance.end','attendance.done','attendance.break','attendance.departure','attendance.nudge') then 'attendance_reminders'
  when p_type in ('attendance.arrival','attendance.ask','attendance.checkout') then 'attendance_questions'
  when p_type in ('attendance.confirmed','attendance.auto') then 'attendance_confirmations'
  when p_type = 'attendance.digest' then 'attendance_digest'
  when p_type in ('approval.waiting','approval.reminder','approval.digest') then 'approvals'
  when p_type in ('request.updated','request.decision','leave.decision') then 'my_requests'
  when p_type in ('chat.mention','chat.reply','task.mention','project.mention','task.reply') then 'mentions'
  when p_type = 'chat.message' then 'chats'
  when p_type in ('task.assigned','task.ask','task.help','project.ask','pool.match') then 'tasks_assigned'
  when p_type in ('task.blocked','task.waiting') then 'tasks_waiting'
  when p_type = 'task.due_soon' then 'tasks_due'
  when p_type = 'task.review_nudge' then 'reviews'
  when p_type like 'task.%' or p_type like 'project.%' or p_type like 'pool.%' or p_type = 'ask.answered' then 'task_updates'
  when p_type like 'domain.%' then 'domains'
  when p_type like 'flow.%' or p_type like 'workflow.%' then 'processes'
  when p_type like 'comp.%' or p_type in ('payroll.processed','people.bank','profile.bank') then 'pay'
  when p_type in ('profile.reminder','profile.changed','people.change') then 'profile'
  when p_type = 'update.test' then 'test'
  else 'company_updates' end
$$;

create function pulse.notification_priority(p_type text) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select case
  -- Pay and bank changes (a changed bank account is checked at once), and a test someone asked for.
  when p_type in ('comp.payroll','comp.waiting','people.bank','profile.bank','update.test') then 'urgent'
  -- The check-in reminder (once a day, paused when ignored) and the long-break nudge still ping: they ask for a tap.
  when p_type in ('approval.waiting','approval.digest','attendance.arrival','attendance.ask','attendance.digest','attendance.start','attendance.break',
   'chat.mention','chat.reply','chat.message','task.mention','project.mention','task.reply',
   'task.assigned','task.ask','task.help','project.ask','pool.match','task.blocked','task.waiting','task.due_soon','task.review_nudge',
   'domain.proposed','comp.offer','comp.claim','comp.letter','flow.wire','flow.alert','workflow.late',
   'leave.decision','request.decision',
   -- What changes someone's days or pay: a new holiday, a policy to read, the month's payroll done.
   'holiday.announced','policy.published','payroll.processed') then 'needs_you'
  else 'fyi' end
$$;

-- How many times a family may toast or push one person in 24 hours; the rest wait quietly in the bell.
create function pulse.notification_daily_pings(p_family text) returns int language sql immutable set search_path=pulse,pg_temp as $$
 select case p_family
  when 'test' then 20 when 'pay' then 10 when 'chats' then 40 when 'mentions' then 20
  when 'approvals' then 3 when 'my_requests' then 6 when 'tasks_assigned' then 6
  when 'tasks_waiting' then 2 when 'tasks_due' then 1 when 'reviews' then 1
  when 'attendance_questions' then 2 when 'attendance_reminders' then 1 when 'attendance_digest' then 1
  when 'processes' then 4 when 'domains' then 3
  else 2 end
$$;

-- Reminder families: a new one is not sent while the same person's earlier one (same type, same subject) is unread.
create function pulse.notification_is_reminder(p_type text) returns boolean language sql immutable set search_path=pulse,pg_temp as $$
 select p_type in ('approval.reminder','approval.digest','attendance.start','attendance.end','attendance.done','attendance.break',
  'attendance.departure','attendance.nudge','task.due_soon','task.review_nudge','task.waiting','profile.reminder','attendance.digest')
$$;

-- Runs after the contract (z) has named the event: priority, quiet, de-duplication. A BEFORE trigger returning null
-- skips the row (notification_emit then returns null, as for any duplicate event key).
create function pulse.notification_policy_apply() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare fam text; s jsonb; pinged int;
begin
 fam:=notification_family(new.event_type);
 if notification_is_reminder(new.event_type) and exists(select 1 from notification n where n.org_id=new.org_id and n.person_id=new.person_id
   and n.event_type=new.event_type and n.subject_id=new.subject_id and n.read_at is null and n.dismissed_at is null
   and n.expires_at>clock_timestamp() and n.created_at>clock_timestamp()-interval '7 days') then
  return null;
 end if;
 new.priority:=coalesce(new.priority,notification_priority(new.event_type));
 -- A message in a group conversation informs; one to you alone, a mention or a reply needs you.
 if new.event_type='chat.message' and new.channel_id is not null and not exists(select 1 from chat_channel c where c.id=new.channel_id and c.kind='direct') then
  new.priority:='fyi';
 end if;
 select settings into s from companion_notification_settings where org_id=new.org_id and person_id=new.person_id;
 if new.priority='fyi' then new.quiet:=true;new.quiet_reason:='fyi';
 elsif coalesce((s->'mute'->>fam)::boolean,false) and new.priority<>'urgent' then new.quiet:=true;new.quiet_reason:='muted';
 else
  select count(*) into pinged from notification n where n.org_id=new.org_id and n.person_id=new.person_id and not n.quiet
   and n.created_at>clock_timestamp()-interval '24 hours' and notification_family(n.event_type)=fam;
  if pinged>=notification_daily_pings(fam) then new.quiet:=true;new.quiet_reason:='limit';end if;
 end if;
 return new;
end $$;
revoke all on function pulse.notification_policy_apply() from public;
create trigger notification_zz_policy before insert on pulse.notification for each row execute function pulse.notification_policy_apply();
create index notification_person_recent on pulse.notification(org_id,person_id,created_at desc) where not quiet;

-- Quiet notifications never reach the laptop/Chrome companions or browser push (the island, the companion panels and
-- the phone's own poll read `pingAllowed`, which the API now also bases on quiet).
create or replace function pulse.companion_fanout_event() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.read_at is not null or new.quiet then return null;end if;
 insert into native_push_delivery(org_id,notification_id,device_id)
 select new.org_id,new.id,d.id from native_device d join person p on p.id=d.person_id and p.org_id=d.org_id
 where d.org_id=new.org_id and d.person_id=new.person_id and d.revoked_at is null
 and d.platform in ('windows','macos','chrome') and p.status='active' and new.created_at>=d.created_at
 on conflict do nothing;
 insert into web_push_delivery(org_id,notification_id,subscription_id)
 select new.org_id,new.id,s.id from web_push_subscription s
 where s.org_id=new.org_id and s.person_id=new.person_id and s.disabled_at is null and new.created_at>=s.created_at
 on conflict do nothing;
 return null;
end $$;

create or replace function pulse.notification_capture_destinations() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.event_type='update.self' or new.quiet or not notification_authorized(new.id,new.person_id) then return new;end if;
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

create or replace function pulse.notification_outbox_seed(p_channel text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 -- Only an undispatched lease can safely be retried. A crashed dispatch is ambiguous, never replayed.
 update notification_delivery set status=case when status='dispatching' then 'uncertain' else 'queued' end,lease_token=null,lease_until=null
 where org_id=current_org() and channel=p_channel and status in ('leased','dispatching') and lease_until<clock_timestamp();
 update notification_delivery q set status='expired' from notification n where q.org_id=current_org() and n.id=q.notification_id
 and q.status in ('queued','leased') and (n.expires_at<=clock_timestamp() or q.attempts>=5);
 update notification_delivery q set status='suppressed' where q.org_id=current_org() and q.channel=p_channel and q.status='queued'
 and (p_channel='web' and exists(select 1 from web_push_delivery old where old.org_id=q.org_id and old.notification_id=q.notification_id and old.subscription_id=q.destination_id and old.status in ('accepted','expired','suppressed'))
 or p_channel='native' and exists(select 1 from native_push_delivery old where old.org_id=q.org_id and old.notification_id=q.notification_id and old.device_id=q.destination_id and old.sent_at is not null)
 -- ATT: a quiet notification never pushes (it waits in the bell); HR copies by Telegram or email are the person's
 -- own opt-in and go unless they muted that kind or it is over its daily limit.
 or exists(select 1 from notification n where n.id=q.notification_id and (q.channel in ('web','native') and n.quiet or n.quiet_reason in ('muted','limit'))));
 if p_channel='web' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'web',s.id,s.created_at::text from notification n join web_push_subscription s using(org_id,person_id)
  where n.org_id=current_org() and n.created_at>=s.created_at and s.disabled_at is null and n.expires_at>clock_timestamp() and not n.quiet
  and (n.read_at is null or n.message_id is not null and exists(select 1 from web_push_delivery old
   where old.org_id=n.org_id and old.notification_id=n.id and old.subscription_id=s.id and old.status='queued'))
  and n.event_type<>'update.self'
  and not exists(select 1 from web_push_delivery old where old.org_id=n.org_id and old.notification_id=n.id and old.subscription_id=s.id and old.status in ('accepted','expired','suppressed')) on conflict do nothing;
 elsif p_channel='native' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'native',d.id,d.consent_epoch::text from notification n join native_device d using(org_id,person_id)
  where n.org_id=current_org() and n.created_at>=d.created_at and d.revoked_at is null and d.push_token is not null
  and d.platform in ('ios','android') and n.expires_at>clock_timestamp() and n.read_at is null and n.event_type<>'update.self' and not n.quiet
  and not exists(select 1 from native_push_delivery old where old.org_id=n.org_id and old.notification_id=n.id and old.device_id=d.id and old.sent_at is not null) on conflict do nothing;
 elsif p_channel='telegram' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'telegram',n.person_id,t.verified_at::text from notification n join pulse_priv.telegram_person t using(org_id,person_id)
  where n.org_id=current_org() and n.telegram_status='queued' and n.expires_at>clock_timestamp() and coalesce(n.quiet_reason,'') not in ('muted','limit')
  and n.event_type in ('leave.decision','request.decision','request.updated','approval.waiting','approval.reminder','approval.digest') on conflict do nothing;
 elsif p_channel='email' then
  insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
  select n.org_id,n.id,'email',n.person_id,'hr-copy' from notification n join hr_mail_outbox m on m.notification_id=n.id and m.org_id=n.org_id and m.person_id=n.person_id
  where n.org_id=current_org() and m.status in ('queued','disabled') and n.expires_at>clock_timestamp() and coalesce(n.quiet_reason,'') not in ('muted','limit')
  and n.event_type in ('leave.decision','request.decision','request.updated','approval.waiting','approval.reminder','approval.digest') on conflict do nothing;
 end if;
end $$;

-- HR request reminders: one digest per approver per working day, after 10:30 company time, for requests waiting
-- longer than the company's reminder hours. Each request still records when it was last reminded.
create or replace function pulse.hr_flow_remind() returns integer language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a record; n int:=0; tz text:=org_time_zone(current_org()); today date:=(clock_timestamp() at time zone org_time_zone(current_org()))::date;
 hours int; waiting int; nid uuid;
begin
 select reminder_hours into hours from hr_flow_policy where org_id=current_org();
 if hours is null then return 0; end if;
 if (clock_timestamp() at time zone tz)::time<time '10:30' or not hr_working(null,today,(select work_days from hr_policy where org_id=current_org())) then return 0; end if;
 for a in select r.id approver, array_agg(q.id order by q.created_at) flows from hr_flow q
  join person r on r.org_id=q.org_id and r.status='active' and r.id<>q.person_id
   and ((q.stage='cofounder' and hr_is_cofounder(r.id)) or (q.stage<>'cofounder' and (hr_is_staff(r.id) or r.id=hr_head(q.person_id))))
  where q.org_id=current_org() and q.status='pending' and coalesce(q.reminded_at,q.updated_at)<clock_timestamp()-make_interval(hours=>hours)
  group by r.id loop
  waiting:=coalesce(array_length(a.flows,1),0);
  if waiting=0 then continue; end if;
  nid:=notification_emit(a.approver,'approval.digest','person',a.approver,'digest:'||today,
   case when waiting=1 then '1 request waits for your decision' else waiting||' requests wait for your decision' end,'/me/approvals','approval',true);
  if nid is not null then n:=n+1; end if;
 end loop;
 update hr_flow set reminded_at=clock_timestamp() where org_id=current_org() and status='pending'
  and coalesce(reminded_at,updated_at)<clock_timestamp()-make_interval(hours=>hours);
 return n;
end $$;

-- "Ready to check in?": once a day, and not for someone who let the last three reminders pass without checking in.
create or replace function pulse.notification_attendance_prompt(p_person uuid, p_date date, p_phase text, p_at timestamptz default clock_timestamp())
returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r notification_reminder;nid uuid;family_key text;label text;recent date[];budget int:=case when p_phase='start' then 1 else 2 end;
begin
 if p_phase not in ('start','end','done','departure','break') then raise exception 'Unsupported attendance prompt';end if;
 if not exists(select 1 from notification_reminder_policy where org_id=current_org() and enabled and approval_ref is not null) then return null;end if;
 if not notification_recipient_allowed(p_person,'attendance.'||p_phase,'person',p_person) then return null;end if;
 if p_phase='start' and exists(select 1 from attendance_entry where org_id=current_org() and person_id=p_person and work_date=p_date and voided_at is null) then return null;end if;
 -- The last three days a check-in reminder went out: no check-in since the first of them means the reminder is not
 -- helping this person. A check-in on any later day brings it back.
 if p_phase='start' then
  select array_agg(d) into recent from (select e.work_date d from attendance_event e where e.org_id=current_org() and e.person_id=p_person
   and e.kind='reminder' and e.detail='start' and e.work_date<p_date group by e.work_date order by e.work_date desc limit 3) x;
  if coalesce(array_length(recent,1),0)=3 and not exists(select 1 from attendance_entry a where a.org_id=current_org() and a.person_id=p_person
   and a.voided_at is null and a.work_date>=(select min(d) from unnest(recent) d)) then return null; end if;
 end if;
 if p_phase='break' and not exists(select 1 from attendance_break b join attendance_entry e on e.id=b.entry_id and e.org_id=b.org_id
  where b.org_id=current_org() and b.person_id=p_person and e.work_date=p_date and b.ended_at is null and e.checked_out_at is null and e.voided_at is null) then return null;end if;
 if p_phase not in ('start','break') and not exists(select 1 from attendance_entry where org_id=current_org() and person_id=p_person and work_date=p_date and checked_out_at is null and voided_at is null) then return null;end if;
 family_key:=case when p_phase='start' then 'checkin' when p_phase='break' then 'break' else 'checkout' end;
 insert into notification_reminder(org_id,person_id,work_date,family) values(current_org(),p_person,p_date,family_key) on conflict do nothing;
 select * into r from notification_reminder where org_id=current_org() and person_id=p_person and work_date=p_date and family=family_key for update;
 if r.prompts>=budget or r.dismissed_at is not null or r.snoozed_until>p_at or r.last_at>p_at-interval '15 minutes' then return null;end if;
 label:=case p_phase when 'start' then 'Ready to check in?' when 'done' then 'Done for the day?' when 'end' then 'Still working? Check out when you finish.'
  when 'break' then 'Still on your break? Tap End break when you’re working again.' else 'Possibly left the office? Check out when you finish.' end;
 nid:=notification_emit(p_person,'attendance.'||p_phase,'person',p_person,r.id||':'||(r.prompts+1),label,'/me','attendance');
 if nid is not null then
  update notification set expires_at=p_at+interval '2 hours' where id=nid;
  update notification_reminder set prompts=prompts+1,last_at=p_at where id=r.id;
  insert into attendance_event(org_id,person_id,work_date,at,kind,detail,signals) values(current_org(),p_person,p_date,p_at,'reminder',p_phase,'{schedule}');
 end if;
 return nid;
end $$;

-- migrate:down
-- Forward-only.
