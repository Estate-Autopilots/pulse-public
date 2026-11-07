-- migrate:up
-- Capture each device/browser event at send time. A subsequent read on another
-- surface changes unread counts, not the already queued delivery to this device.
create function pulse.companion_fanout_event() returns trigger
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.read_at is not null then return null;end if;
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
revoke all on function pulse.companion_fanout_event() from public;
create trigger companion_device_fanout after insert on pulse.notification
 for each row execute function pulse.companion_fanout_event();
-- migrate:down
-- Retain device receipts if the application rolls back.
