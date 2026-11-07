-- migrate:up
-- CHAT-VOICE (22 Oct 2026): a push says what it is. The outbox's dispatch payload carries the event type and priority,
-- so browser push marks an incoming call urgent and the phone rings it on its Calls channel at high priority; a call's
-- and a missed call's title (the caller's name) and link go with it. Everything else is as before (0860).
create or replace function pulse.notification_outbox_dispatch(p_id uuid, p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $$
declare q notification_delivery;n notification;payload jsonb;dest jsonb;
begin
 select * into q from notification_delivery where org_id=current_org() and id=p_id and status='leased' and lease_token=p_token and lease_until>clock_timestamp() for update;
 if not found then return null;end if;
 select * into n from notification where org_id=current_org() and id=q.notification_id;
 if n.expires_at<=clock_timestamp() then update notification_delivery set status='expired' where id=q.id;return null;end if;
 if not notification_authorized(n.id,n.person_id) or n.dismissed_at is not null then
  update notification_delivery set status='suppressed' where id=q.id;return null;
 end if;
 if n.event_type in ('attendance.start','attendance.end','attendance.done','attendance.departure','attendance.break') and not exists(select 1 from notification_reminder_policy where org_id=current_org() and enabled and approval_ref is not null) then
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
 payload:=jsonb_build_object('id',n.id,'personId',n.person_id,'title',case when n.event_type in ('leave.decision','request.decision','request.updated','approval.waiting','approval.reminder') and n.title ~ '^HR request (submitted|approved|rejected|cancelled|forwarded|updated|reminder)$' then n.title else 'A work update is ready' end,'href','/notifications?event='||n.id,'expiresAt',n.expires_at,'destination',dest,
  -- CHAT-VOICE: a call rings on the phone (high priority, the Calls channel, the caller's name); a missed call says so.
  'eventType',n.event_type,'priority',n.priority);
 if n.event_type in ('chat.call','chat.missed_call') then payload:=payload||jsonb_build_object('title',n.title,'href',n.href); end if;
 update notification_delivery set status='dispatching',attempts=attempts+1,lease_until=clock_timestamp()+interval '2 minutes' where id=q.id;
 return payload;
end $$;

-- migrate:down
-- Forward-only.
