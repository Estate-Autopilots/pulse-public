-- migrate:up
-- MOBILE-SHELL (9 Oct 2026): the Pulse phone app is the Pulse web app inside a native shell.
-- After the normal web sign-in on the phone, the shell registers itself as this person's device with the existing
-- pairing model. The signed-in web session approves the shell's pairing request directly (nobody types a code),
-- and that web session and the new device are bound to each other: signing out of the web (or ending the session
-- from Account / Security) revokes the device, and revoking the device in Settings → Devices ends the session.
-- Desktop window sessions (R15d) keep their own rule: ending them never revokes the computer.
alter table pulse.native_device add column shell boolean not null default false;

create function pulse.native_shell_enroll(c text,h text,replaces uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid:=current_viewer(); p pulse_priv.native_pair%rowtype; d jsonb; dev uuid; old uuid;
begin
 if a is null then raise exception 'Sign in to Pulse on this phone first' using errcode='42501';end if;
 select * into p from pulse_priv.native_pair where org_id=current_org() and code=c and status='pending';
 if p.id is not null and p.platform not in ('android','ios') then
  raise exception 'Only the Pulse phone app registers itself this way' using errcode='42501';end if;
 select native_device_id into old from login_session
  where org_id=current_org() and token_hash=h and person_id=a and revoked_at is null and expires_at>now();
 if not found then raise exception 'Sign in to Pulse on this phone first' using errcode='42501';end if;
 -- The same checks and audit event as approving a code on the Pulse site (expiry, own active account, staff only).
 d:=native_pair_decide(c,true);
 dev:=(d->>'deviceId')::uuid;
 update native_device set shell=true where org_id=current_org() and id=dev;
 -- One device per signed-in phone app: registering again (a new install, cleared data) replaces the earlier entry.
 for old in select x from unnest(array[old,replaces]) x where x is not null and x<>dev loop
  if exists(select 1 from native_device where org_id=current_org() and id=old and person_id=a and shell and revoked_at is null) then
   update pulse_priv.native_token set revoked_at=now() where org_id=current_org() and device_id=old and revoked_at is null;
   update native_device set revoked_at=now(),paused=true,purposes='{}',push_token=null,consent_epoch=gen_random_uuid() where org_id=current_org() and id=old;
  end if;
 end loop;
 update login_session set native_device_id=dev where org_id=current_org() and token_hash=h;
 return d;
end $$;
revoke all on function pulse.native_shell_enroll(text,text,uuid) from public;
grant execute on function pulse.native_shell_enroll(text,text,uuid) to pulse_api;

-- Ending the phone's web session (sign out, Account / Security, sign out everywhere) revokes its shell device.
create function pulse.native_shell_session_ended() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.native_device_id is not null and new.revoked_at is not null and old.revoked_at is null
 and exists(select 1 from native_device where id=new.native_device_id and shell and revoked_at is null) then
  update pulse_priv.native_token set revoked_at=now() where device_id=new.native_device_id and revoked_at is null;
  update native_device set revoked_at=now(),paused=true,purposes='{}',push_token=null,consent_epoch=gen_random_uuid() where id=new.native_device_id;
  perform auth_event_add('staff',new.person_id,'native_revoked','Pulse phone app signed out');
 end if;
 return new;
end $$;
revoke all on function pulse.native_shell_session_ended() from public;
create trigger login_session_shell_device after update of revoked_at on pulse.login_session
 for each row when (new.native_device_id is not null and new.revoked_at is not null and old.revoked_at is null)
 execute function pulse.native_shell_session_ended();

-- The shell's background check (Android WorkManager, every ~15 minutes) reads the same per-device outbox as the
-- desktop apps until real push is configured: shell phones join the desktop platforms here. Expo-paired phones
-- (shell=false) keep the earlier rule.
create or replace function pulse.companion_queue_local(dev uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from native_device where id=dev and person_id=current_viewer() and revoked_at is null and (platform in ('windows','macos','chrome') or shell)) then raise exception 'Your active desktop device required' using errcode='42501';end if;
 insert into native_push_delivery(org_id,notification_id,device_id)
 select n.org_id,n.id,dev from notification n join native_device d on d.id=dev
 where n.person_id=current_viewer() and n.read_at is null and n.created_at>=d.created_at and n.created_at>now()-interval '48 hours'
 and (n.channel_id is null or exists(select 1 from chat_member cm where cm.channel_id=n.channel_id and cm.person_id=current_viewer()))
 on conflict do nothing;
end $$;
create or replace function pulse.companion_ack_local(dev uuid,ids uuid[]) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from native_device where id=dev and person_id=current_viewer() and revoked_at is null and (platform in ('windows','macos','chrome') or shell)) then raise exception 'Your active desktop device required' using errcode='42501';end if;
 if coalesce(cardinality(ids),0)>200 then raise exception 'Receipt batch too large' using errcode='22023';end if;
 update native_push_delivery q set app_received_at=coalesce(q.app_received_at,clock_timestamp())
 from notification n where q.notification_id=n.id and q.device_id=dev and n.person_id=current_viewer() and n.id=any(ids);
end $$;

-- migrate:down
create or replace function pulse.companion_queue_local(dev uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from native_device where id=dev and person_id=current_viewer() and revoked_at is null and platform in ('windows','macos','chrome')) then raise exception 'Your active desktop device required' using errcode='42501';end if;
 insert into native_push_delivery(org_id,notification_id,device_id)
 select n.org_id,n.id,dev from notification n join native_device d on d.id=dev
 where n.person_id=current_viewer() and n.read_at is null and n.created_at>=d.created_at and n.created_at>now()-interval '48 hours'
 and (n.channel_id is null or exists(select 1 from chat_member cm where cm.channel_id=n.channel_id and cm.person_id=current_viewer()))
 on conflict do nothing;
end $$;
create or replace function pulse.companion_ack_local(dev uuid,ids uuid[]) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from native_device where id=dev and person_id=current_viewer() and revoked_at is null and platform in ('windows','macos','chrome')) then raise exception 'Your active desktop device required' using errcode='42501';end if;
 if coalesce(cardinality(ids),0)>200 then raise exception 'Receipt batch too large' using errcode='22023';end if;
 update native_push_delivery q set app_received_at=coalesce(q.app_received_at,clock_timestamp())
 from notification n where q.notification_id=n.id and q.device_id=dev and n.person_id=current_viewer() and n.id=any(ids);
end $$;
drop trigger if exists login_session_shell_device on pulse.login_session;
drop function if exists pulse.native_shell_session_ended();
drop function if exists pulse.native_shell_enroll(text,text,uuid);
alter table pulse.native_device drop column if exists shell;
