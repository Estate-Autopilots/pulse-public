-- migrate:up
-- CALLS-NATIVE (27 Oct 2026): a Pulse call rings the phone like a phone call, with Pulse closed or the phone locked.
--
-- * iPhone: an incoming call arrives as an Apple VoIP push (PushKit) and is shown by CallKit. That push goes to its own
--   token (native_device.voip_token), never to the ordinary notification token, and only for a ring (chat.call).
-- * A ring that is over (answered on another device, declined, missed, the caller hung up) is stopped on every device
--   it reached: notification_delivery.stop_sent_at marks the "stop ringing" push sent for that delivery
--   (call_ring_stops), so a phone and a browser stop at once instead of ringing out their 45 seconds.
-- * A colleague's call rings through quiet hours (it is a call, not a notice) but never through Do not disturb or a
--   snooze. A ring from an AI employee follows every ping rule (quiet hours too): call_ai_ring checks before ringing and
--   leaves its message in the chat instead.
-- * The push says what the phone needs to ring with Pulse closed: the call, the caller's name, voice or video, how long
--   it may ring.

alter table pulse.native_device add column if not exists voip_token text check (voip_token is null or voip_token ~ '^[a-f0-9]{64}$');
alter table pulse.notification_delivery add column if not exists stop_sent_at timestamptz;
create index if not exists notification_delivery_call_stop on pulse.notification_delivery(org_id,accepted_at) where status='accepted' and stop_sent_at is null;

-- The call a ring notification is about (its key is call:<call id>:<epoch>).
create or replace function pulse.call_ring_call(p_key text) returns uuid language sql immutable set search_path=pulse,pg_temp as $$
 select case when p_key ~ '^call:[0-9a-f-]{36}:' then substring(p_key from 6 for 36)::uuid end
$$;

-- Did an AI employee start this call?
create or replace function pulse.call_by_ai(p_call uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from chat_call c join agent_member m on m.person_id=c.started_by and m.org_id=c.org_id where c.org_id=current_org() and c.id=p_call)
$$;

-- May this ring reach the person now? A colleague's call: unless Do not disturb or a snooze. An AI employee's: every rule.
create or replace function pulse.call_ring_allowed(p_person uuid,p_call uuid,p_channel text) returns boolean
 language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare s jsonb;
begin
 if p_call is not null and call_by_ai(p_call) then return notification_ping_allowed(p_person,'call',p_channel); end if;
 select settings into s from companion_notification_settings where org_id=current_org() and person_id=p_person; s:=coalesce(s,'{}');
 if coalesce((s->>'dnd')::boolean,false) or s->'channels'->>p_channel='false' or coalesce((s->>'snoozedUntil')::timestamptz,'-infinity')>clock_timestamp() then return false; end if;
 return true;
exception when others then return false;
end $$;

-- Destinations: as before (1135 / 0860), plus an iPhone's VoIP token for a ring.
create or replace function pulse.notification_capture_destinations() returns trigger
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.event_type='update.self' or new.quiet or not notification_authorized(new.id,new.person_id) then return new;end if;
 insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
 select new.org_id,new.id,'web',s.id,s.created_at::text from web_push_subscription s
 where s.org_id=new.org_id and s.person_id=new.person_id and s.created_at<=new.created_at and s.disabled_at is null
 on conflict do nothing;
 insert into notification_delivery(org_id,notification_id,channel,destination_id,destination_version)
 select new.org_id,new.id,'native',d.id,d.consent_epoch::text from native_device d
 where d.org_id=new.org_id and d.person_id=new.person_id and d.created_at<=new.created_at
 and d.revoked_at is null and (d.push_token is not null or (new.event_type='chat.call' and d.voip_token is not null)) and d.platform in ('ios','android')
 on conflict do nothing;
 return new;
end $$;

create or replace function pulse.notification_outbox_dispatch(p_id uuid, p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $$
declare q notification_delivery;n notification;payload jsonb;dest jsonb;cid uuid;c chat_call;
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
 cid:=case when n.event_type='chat.call' then call_ring_call(n.event_key) end;
 -- CALLS-NATIVE: a ring is now or never (it lasts 45 s): one it may not make is dropped, not queued for later.
 if n.event_type='chat.call' then
  if not call_ring_allowed(n.person_id,cid,q.channel) then update notification_delivery set status='suppressed' where id=q.id;return null; end if;
 elsif n.snoozed_until>clock_timestamp() or not notification_ping_allowed(n.person_id,n.kind,q.channel) then
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
  select jsonb_build_object('token',push_token,'platform',platform,'voip',case when n.event_type='chat.call' then voip_token end) into dest from native_device where org_id=q.org_id and id=q.destination_id
  and person_id=n.person_id and revoked_at is null and (push_token is not null or (n.event_type='chat.call' and voip_token is not null)) and consent_epoch::text=q.destination_version and platform in ('ios','android');
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
 -- CALLS-NATIVE: what a closed phone needs to ring: the call, who is calling, voice or video, an AI employee or not.
 if cid is not null then
  select * into c from chat_call where org_id=current_org() and id=cid;
  payload:=payload||jsonb_build_object('callId',cid,'video',coalesce(c.video,false),'ai',call_by_ai(cid),
   'caller',(select display_name from person where id=coalesce((select invited_by from chat_call_party where call_id=cid and person_id=n.person_id),c.started_by)));
 end if;
 update notification_delivery set status='dispatching',attempts=attempts+1,lease_until=clock_timestamp()+interval '2 minutes' where id=q.id;
 return payload;
end $$;

-- Rings that are over, on devices they reached: one "stop ringing" each (claimed once; the last 3 minutes only).
create or replace function pulse.call_ring_stops(p_channel text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare out jsonb;
begin
 with picked as (
  select q.id,n.id nid,n.person_id,call_ring_call(n.event_key) call_id,q.destination_id from notification_delivery q join notification n on n.org_id=q.org_id and n.id=q.notification_id
  where q.org_id=current_org() and q.channel=p_channel and q.status='accepted' and q.stop_sent_at is null and q.accepted_at>clock_timestamp()-interval '3 minutes'
   and n.event_type='chat.call' and (n.dismissed_at is not null or n.expires_at<=clock_timestamp())
  order by q.accepted_at limit 50 for update of q skip locked
 ), marked as (update notification_delivery q set stop_sent_at=clock_timestamp() from picked where q.id=picked.id returning picked.*)
 select coalesce(jsonb_agg(jsonb_build_object('id',m.nid,'personId',m.person_id,'callId',m.call_id,'destination',
   case when p_channel='web' then (select jsonb_build_object('endpoint',s.endpoint,'keys',s.keys) from web_push_subscription s where s.org_id=current_org() and s.id=m.destination_id and s.disabled_at is null)
   else (select jsonb_build_object('token',d.push_token,'platform',d.platform) from native_device d where d.org_id=current_org() and d.id=m.destination_id and d.revoked_at is null and d.push_token is not null) end)),'[]')
 into out from marked m;
 return (select coalesce(jsonb_agg(x),'[]') from jsonb_array_elements(out) x where x->'destination' is not null and x->'destination'<>'null'::jsonb);
end $$;

-- "Test my ringing": where a ring for me would go now (the API sends a test ring there directly, not through the inbox).
create or replace function pulse.call_ring_test_targets() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('personId',current_viewer(),
  'ringAllowed',call_ring_allowed(current_viewer(),null,'native'),
  'web',(select coalesce(jsonb_agg(jsonb_build_object('endpoint',s.endpoint,'keys',s.keys)),'[]') from web_push_subscription s where s.org_id=current_org() and s.person_id=current_viewer() and s.disabled_at is null),
  'native',(select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'platform',d.platform,'token',d.push_token,'voip',d.voip_token)),'[]') from native_device d
    where d.org_id=current_org() and d.person_id=current_viewer() and d.revoked_at is null and d.platform in ('ios','android') and (d.push_token is not null or d.voip_token is not null)),
  'phones',(select count(*) from native_device d where d.org_id=current_org() and d.person_id=current_viewer() and d.revoked_at is null and d.platform in ('ios','android')))
$$;

-- An AI employee calls a person (the same ring as a colleague's): in their direct conversation, after the AI's message
-- saying why. Quiet hours and Do not disturb are kept: then only the message is left. Answering opens the conversation
-- (an AI employee has no voice on calls yet: AI-EMP-2), so the call ends as answered at once.
create or replace function pulse.call_ai_ring(p_person uuid,p_reason text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid:=current_viewer(); k text; ch uuid; cid uuid; allowed boolean;
begin
 if agent_session() is null or not exists(select 1 from agent_member where org_id=current_org() and person_id=me and disabled_at is null) then
  raise exception 'Only an AI employee rings this way' using errcode='42501'; end if;
 if coalesce(length(trim(p_reason)),0)<3 or length(p_reason)>500 then raise exception 'Say in a sentence why you are calling' using errcode='22023'; end if;
 if not exists(select 1 from person where org_id=current_org() and id=p_person and side='staff' and status='active') then raise exception 'choose an active teammate' using errcode='22023'; end if;
 k:='dm:'||least(me::text,p_person::text)||':'||greatest(me::text,p_person::text);
 select id into ch from chat_channel where org_id=current_org() and key=k;
 if ch is null then
  insert into chat_channel(org_id,key,name,kind,description) values(current_org(),k,'Direct message','direct','A private conversation') returning id into ch;
  insert into chat_member(org_id,channel_id,person_id) values(current_org(),ch,me),(current_org(),ch,p_person) on conflict do nothing;
 end if;
 insert into chat_message(org_id,channel_id,author_id,body,client_id) values(current_org(),ch,me,left(trim(p_reason),500),gen_random_uuid());
 allowed:=notification_ping_allowed(p_person,'call','native');
 if not allowed then return jsonb_build_object('rang',false,'why','quiet','channelId',ch); end if;
 if exists(select 1 from chat_call_party pa join chat_call c on c.id=pa.call_id where pa.org_id=current_org() and pa.person_id=p_person and pa.state='joined' and c.state<>'ended') then
  return jsonb_build_object('rang',false,'why','busy','channelId',ch); end if;
 if exists(select 1 from chat_call where org_id=current_org() and channel_id=ch and state<>'ended') then return jsonb_build_object('rang',false,'why','ringing','channelId',ch); end if;
 cid:=chat_call_start(ch,false,array[p_person]);
 return jsonb_build_object('rang',true,'callId',cid,'channelId',ch);
end $$;

-- Answering an AI employee's ring opens its message: the call is over as answered (as before for everyone else).
create or replace function pulse.chat_call_answer(p_call uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pulse', 'pg_temp'
AS $$
declare c chat_call; mine text;
begin
 select * into c from chat_call where org_id=current_org() and id=p_call for update;
 if not found then raise exception 'call unavailable' using errcode='42501'; end if;
 if c.state='ended' then raise exception 'This call has ended' using errcode='22023'; end if;
 select state into mine from chat_call_party where call_id=p_call and person_id=current_viewer();
 if mine='joined' then update chat_call_party set seen_at=clock_timestamp() where call_id=p_call and person_id=current_viewer(); return; end if;
 if mine is null and not (chat_has(c.channel_id) and exists(select 1 from chat_member where org_id=current_org() and channel_id=c.channel_id and person_id=current_viewer())) then
  raise exception 'call unavailable' using errcode='42501'; end if;
 if exists(select 1 from chat_call_party pa join chat_call oc on oc.id=pa.call_id where pa.org_id=current_org() and pa.person_id=current_viewer() and pa.state='joined' and oc.state<>'ended' and oc.id<>p_call) then
  raise exception 'You are already in another call. Hang up first.' using errcode='22023'; end if;
 if (select count(*) from chat_call_party where call_id=p_call and state='joined')>=8 then raise exception 'This call is full: 8 people at most' using errcode='22023'; end if;
 insert into chat_call_party(org_id,call_id,person_id,state,joined_at,seen_at) values(current_org(),p_call,current_viewer(),'joined',clock_timestamp(),clock_timestamp())
 on conflict(call_id,person_id) do update set state='joined',joined_at=clock_timestamp(),seen_at=clock_timestamp(),left_at=null,muted=false,video=false;
 perform chat_call_unring(p_call,current_viewer(),false);
 if c.state='ringing' then update chat_call set state='live',answered_at=clock_timestamp() where id=p_call; end if;
 if call_by_ai(p_call) then perform chat_call_end(p_call,'completed'); perform chat_call_touch(p_call); return; end if;
 perform chat_call_line(p_call); perform chat_call_touch(p_call);
end $$;

revoke all on function pulse.call_ring_call(text),pulse.call_by_ai(uuid),pulse.call_ring_allowed(uuid,uuid,text),pulse.call_ring_stops(text),
 pulse.call_ring_test_targets(),pulse.call_ai_ring(uuid,text) from public;
grant execute on function pulse.call_ring_test_targets(),pulse.call_ai_ring(uuid,text) to pulse_api;
grant execute on function pulse.call_ring_stops(text),pulse.call_ring_call(text),pulse.call_by_ai(uuid),pulse.call_ring_allowed(uuid,uuid,text) to pulse_worker;
grant execute on function pulse.call_ring_call(text),pulse.call_by_ai(uuid),pulse.call_ring_allowed(uuid,uuid,text) to pulse_api;

-- migrate:down
-- Forward-only.
