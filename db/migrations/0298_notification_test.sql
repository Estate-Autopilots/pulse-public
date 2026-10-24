-- migrate:up
-- RELEASE-3: a person can send themselves one test notification ("update.test") from Settings or Notifications, to
-- see that pings reach this browser or phone. It goes to the person's own enrolled browsers and phones through the
-- usual outbox (quiet hours, Do not disturb and channel choices apply), never to anyone else, at most once a minute.
alter table pulse.notification drop constraint notification_event_type_check;
alter table pulse.notification add constraint notification_event_type_check check(event_type in ('update.self','update.test','chat.message','chat.mention','chat.reply','policy.published','holiday.announced',
 'task.assigned','task.blocked','task.unblocked','task.due_soon','task.done','task.accepted','task.ask','project.ask','ask.answered',
 'task.mention','project.mention','task.comment','project.comment','project.added','task.update',
 'domain.proposed','domain.answered','domain.policy','domain.ended','pool.claimed','pool.match',
 'leave.decision','request.updated','request.decision','approval.waiting','approval.reminder','payroll.processed',
 'attendance.start','attendance.end','attendance.done','attendance.departure','attendance.confirmed','attendance.arrival','attendance.break','attendance.nudge',
 'profile.reminder','kudos.received','people.bank','people.change','profile.bank','profile.changed','workflow.late','workflow.done'));

-- The recipient of a test is its subject, the person themself (checked again by the outbox, which has no viewer).
do $$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
 changed:=replace(definition,' elsif p_type=''policy.published'' then',
 ' elsif p_type=''update.test'' then
  return p_subject=''person'' and p_id=p_person;
 elsif p_type=''policy.published'' then');
 if changed=definition then raise exception 'notification_recipient_allowed changed shape'; end if;
 execute changed;
end $$;

create function pulse.notification_test() returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); nid uuid;
begin
 if me is null or not exists(select 1 from person where org_id=current_org() and id=me and status='active') then
  raise exception 'Use your individual Pulse account' using errcode='42501';
 end if;
 -- One a minute: the event key is the minute it was asked for.
 nid:=notification_emit(me,'update.test','person',me,'test:'||to_char(clock_timestamp() at time zone 'UTC','YYYYMMDDHH24MI'),
  'Test from Pulse: notifications reach you here','/notifications','update');
 return jsonb_build_object('id',nid,
  'browsers',(select count(*) from web_push_subscription where org_id=current_org() and person_id=me and disabled_at is null),
  'phones',(select count(*) from native_device where org_id=current_org() and person_id=me and revoked_at is null and push_token is not null and platform in ('ios','android')));
end $$;
revoke all on function pulse.notification_test() from public;
grant execute on function pulse.notification_test() to pulse_api;

-- migrate:down
-- Forward-only.
