-- migrate:up
-- FIX-LIVE (19 Nov 2026, BUG-CENSUS BC-038 and BC-116). "HR e-mails stuck in the outbox since 28 Oct" (EA, 12) and
-- "web push deliveries left queued" (EA 29, AC 4, WL 4) were not stuck deliveries. The outbox
-- (notification_delivery, 0135) had settled every one of them: suppressed (muted, over the daily limit, or a quiet
-- notice) or expired. But the older per-channel rows it took over (web_push_delivery, hr_mail_outbox) hear only
-- accepted/expired/failed from notification_outbox_finish, never the seed's bulk suppress and expire, so they read
-- "queued" for good: production checks counted them as stuck, and the bell's notice said "Email queued" for a mail
-- that would never go. Willow Lane's 4 were the 17 Nov reminders (BC-073, fixed by 2404).
--
-- Now each seed also settles those rows from the outbox: a web push row takes its delivery's suppressed/expired; an HR
-- mail row (queued, or waiting for the company's mailbox) takes its e-mail delivery's suppressed/expired; and either
-- one whose notice has expired is expired (some never had an outbox row: a notice muted when made is never seeded).
-- Nothing is sent, re-sent or held: only rows the outbox has already finished, or that could never go, change, and the
-- seed already skips both statuses. The first run after this release settles the old rows, per company, in its own
-- seed. hr_mail_outbox may now say 'suppressed' and 'expired'. The rest of the seed is 1370's, word for word.
alter table pulse.hr_mail_outbox drop constraint hr_mail_outbox_status_check;
alter table pulse.hr_mail_outbox add constraint hr_mail_outbox_status_check
 check (status = any (array['queued','sent','disabled','failed','sink','waiting_mailbox','suppressed','expired']));

-- The queued legacy push rows are few; the seed looks for them every minute.
create index if not exists web_push_delivery_queued on pulse.web_push_delivery(org_id) where status='queued';

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
 -- FIX-LIVE (2471): the legacy rows say what the outbox decided (after its expire and suppress above), so a settled notice never reads "queued" again.
 update web_push_delivery old set status=q.status from notification_delivery q
 where old.org_id=current_org() and old.status='queued' and q.org_id=old.org_id and q.notification_id=old.notification_id
 and q.channel='web' and q.destination_id=old.subscription_id and q.status in ('suppressed','expired');
 update web_push_delivery old set status='expired' from notification n
 where old.org_id=current_org() and old.status='queued' and n.org_id=old.org_id and n.id=old.notification_id and n.expires_at<=clock_timestamp();
 update hr_mail_outbox m set status=q.status from notification_delivery q
 where m.org_id=current_org() and m.status in ('queued','waiting_mailbox') and q.org_id=m.org_id and q.notification_id=m.notification_id
 and q.channel='email' and q.destination_id=m.person_id and q.status in ('suppressed','expired');
 update hr_mail_outbox m set status='expired' from notification n
 where m.org_id=current_org() and m.status in ('queued','waiting_mailbox') and n.org_id=m.org_id and n.id=m.notification_id and n.expires_at<=clock_timestamp();
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
  where n.org_id=current_org() and (m.status in ('queued','waiting_mailbox') or m.status='disabled' and current_org()=install_org()) and n.expires_at>clock_timestamp() and coalesce(n.quiet_reason,'') not in ('muted','limit')
  and n.event_type in ('leave.decision','request.decision','request.updated','approval.waiting','approval.reminder','approval.digest') on conflict do nothing;
 end if;
end $$;


-- migrate:down
-- Forward-only.
