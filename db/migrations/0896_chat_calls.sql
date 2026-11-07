-- migrate:up
-- CHAT-VOICE (22 Oct 2026): calls from Chats. 1:1 and group (up to 8 people, a WebRTC mesh; media goes browser to
-- browser, or through the company's TURN relay, never through Pulse's API). Pulse keeps the call's state and passes
-- the browsers' connection messages (offers, answers, ICE candidates) between the people in the call:
--
--   pulse.chat_call        one call in one conversation (only one at a time per conversation): ringing → live → ended
--   pulse.chat_call_party  everyone asked to the call: ringing, joined, declined, missed, left, busy
--   pulse.chat_call_event  what each person's open Pulse must hear: a call changed, or a signal addressed to them.
--                          A row wakes that person's stream at once (NOTIFY pulse_call); rows go after 10 minutes.
--
-- The call is a line in the conversation (chat_message kind 'event' with a `call` attachment), updated as it goes:
-- "Voice call · 4:32", "Missed voice call", so the chat is the call history. Ringing someone is an urgent
-- notification (chat.call: it pushes and rings even with Calls muted); a missed call (chat.missed_call) and a voice
-- message (chat.voice, also in a group) need you. A ring nobody answers stops after 45 seconds; someone whose Pulse
-- stops answering for 30 seconds has left the call. AI co-workers are not called.

select pulse.check_values_add('pulse.notification'::regclass, 'notification_event_type_check', 'event_type', array['chat.call','chat.missed_call','chat.voice']);

create table pulse.chat_call (
 org_id uuid not null, id uuid primary key default gen_random_uuid(), channel_id uuid not null,
 started_by uuid not null references pulse.person(id), video boolean not null default false,
 state text not null default 'ringing' check(state in ('ringing','live','ended')),
 end_reason text check(end_reason in ('completed','missed','declined','busy','failed')),
 message_id uuid, created_at timestamptz not null default clock_timestamp(), answered_at timestamptz, ended_at timestamptz,
 unique(org_id,id), foreign key(org_id,channel_id) references pulse.chat_channel(org_id,id) on delete cascade
);
create unique index chat_call_one_open on pulse.chat_call(org_id,channel_id) where state<>'ended';
create index chat_call_open on pulse.chat_call(org_id) where state<>'ended';
create index chat_call_channel on pulse.chat_call(org_id,channel_id,created_at desc);
create table pulse.chat_call_party (
 org_id uuid not null, call_id uuid not null, person_id uuid not null references pulse.person(id),
 state text not null check(state in ('ringing','joined','declined','missed','left','busy')),
 invited_by uuid references pulse.person(id), invited_at timestamptz not null default clock_timestamp(),
 joined_at timestamptz, left_at timestamptz, seen_at timestamptz not null default clock_timestamp(),
 muted boolean not null default false, video boolean not null default false,
 primary key(call_id,person_id), foreign key(org_id,call_id) references pulse.chat_call(org_id,id) on delete cascade
);
create index chat_call_party_person on pulse.chat_call_party(org_id,person_id,state);
create table pulse.chat_call_event (
 org_id uuid not null, seq bigint generated always as identity primary key, person_id uuid not null, call_id uuid not null,
 kind text not null check(kind in ('state','signal')), from_id uuid, body jsonb check(body is null or octet_length(body::text)<=65536),
 created_at timestamptz not null default clock_timestamp(),
 foreign key(org_id,call_id) references pulse.chat_call(org_id,id) on delete cascade
);
create index chat_call_event_person on pulse.chat_call_event(org_id,person_id,seq);
create index chat_call_event_age on pulse.chat_call_event(created_at);
do $$ declare t text; begin
 foreach t in array array['chat_call','chat_call_party','chat_call_event'] loop
  execute format('alter table pulse.%I enable row level security',t);
  execute format('alter table pulse.%I force row level security',t);
  execute format('create policy tenant_isolation on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('grant select,insert,update,delete on pulse.%I to pulse_worker',t);
 end loop;
end $$;
create trigger audit_mutation after insert or update or delete on pulse.chat_call for each row execute function pulse.audit_mutation();

-- A new event wakes that person's open streams (the API listens on pulse_call).
create function pulse.chat_call_wake() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin perform pg_notify('pulse_call',new.org_id::text||':'||new.person_id::text); return null; end $$;
create trigger chat_call_event_wake after insert on pulse.chat_call_event for each row execute function pulse.chat_call_wake();

-- Everyone in the call hears that it changed.
create function pulse.chat_call_touch(p_call uuid) returns void language sql security definer set search_path=pulse,pg_temp as $$
 insert into chat_call_event(org_id,person_id,call_id,kind) select org_id,person_id,call_id,'state' from chat_call_party where org_id=current_org() and call_id=p_call
$$;

-- The call as its people see it (only to someone asked to it).
create function pulse.chat_call_view(p_call uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',c.id,'channelId',c.channel_id,'channelKind',ch.kind,'channelName',case when ch.kind='direct' then null else ch.name end,
  'video',c.video,'state',c.state,'endReason',c.end_reason,'startedBy',c.started_by,'messageId',c.message_id,
  'createdAt',c.created_at,'answeredAt',c.answered_at,'endedAt',c.ended_at,'now',clock_timestamp(),
  'parties',(select jsonb_agg(jsonb_build_object('id',p.person_id,'name',pe.display_name,'photoAt',(select ph.updated_at from person_photo ph where ph.person_id=p.person_id),
    'state',p.state,'muted',p.muted,'video',p.video,'joinedAt',p.joined_at,'invitedBy',p.invited_by) order by p.invited_at,pe.display_name)
   from chat_call_party p join person pe on pe.id=p.person_id where p.call_id=c.id))
 from chat_call c join chat_channel ch on ch.id=c.channel_id
 where c.org_id=current_org() and c.id=p_call and exists(select 1 from chat_call_party me where me.call_id=c.id and me.person_id=current_viewer())
$$;

-- The call's line in the conversation, rewritten as the call goes.
create function pulse.chat_call_line(p_call uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c chat_call; secs int; st text; label text;
begin
 select * into c from chat_call where org_id=current_org() and id=p_call;
 if not found or c.message_id is null then return; end if;
 secs:=case when c.answered_at is not null then greatest(0,extract(epoch from coalesce(c.ended_at,clock_timestamp())-c.answered_at))::int end;
 st:=case when c.state<>'ended' then c.state else c.end_reason end;
 label:=case when c.video then 'Video call' else 'Voice call' end;
 update chat_message set body=case st when 'completed' then label||' · '||(secs/60)||':'||lpad((secs%60)::text,2,'0')
   when 'missed' then 'Missed '||lower(label) when 'declined' then label||' · declined' when 'busy' then label||' · busy' when 'failed' then label||' · not connected'
   when 'live' then label||' · on now' else label end,
  attachments=jsonb_build_array(jsonb_build_object('call',c.id,'name',label,'video',c.video,'state',st,'seconds',secs)),updated_at=clock_timestamp()
 where org_id=current_org() and id=c.message_id;
end $$;

-- Ring one person (an urgent notification that pushes; it lasts as long as the ring).
create function pulse.chat_call_ring(p_call uuid,p_person uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c chat_call; who text; nid uuid;
begin
 select * into c from chat_call where org_id=current_org() and id=p_call;
 select display_name into who from person where id=coalesce((select invited_by from chat_call_party where call_id=p_call and person_id=p_person),c.started_by);
 -- Each ring is its own notification (someone added again rings again).
 nid:=notification_emit(p_person,'chat.call','message',c.message_id,'call:'||p_call||':'||floor(extract(epoch from clock_timestamp()))::bigint,coalesce(who,'Someone')||case when c.video then ' · incoming video call' else ' · incoming call' end,
  '/chats?channel='||c.channel_id||'&call='||p_call,'call');
 if nid is not null then update notification set expires_at=clock_timestamp()+interval '50 seconds' where id=nid; end if;
end $$;

-- The ring is over for one person: its notification goes; a missed call leaves a "Missed call" one.
create function pulse.chat_call_unring(p_call uuid,p_person uuid,p_missed boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c chat_call; who text;
begin
 update notification set read_at=coalesce(read_at,clock_timestamp()),dismissed_at=coalesce(dismissed_at,clock_timestamp())
 where org_id=current_org() and person_id=p_person and event_type='chat.call' and event_key like 'call:'||p_call||':%' and dismissed_at is null;
 if not p_missed then return; end if;
 select * into c from chat_call where org_id=current_org() and id=p_call;
 select display_name into who from person where id=c.started_by;
 perform notification_emit(p_person,'chat.missed_call','message',c.message_id,'missed:'||p_call,
  'Missed '||case when c.video then 'video' else 'voice' end||' call from '||coalesce(who,'someone'),'/chats?channel='||c.channel_id,'call');
end $$;

create function pulse.chat_call_end(p_call uuid,p_reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare p uuid;
begin
 update chat_call set state='ended',end_reason=p_reason,ended_at=clock_timestamp() where org_id=current_org() and id=p_call and state<>'ended';
 if not found then return; end if;
 for p in select person_id from chat_call_party where call_id=p_call and state='ringing' loop
  update chat_call_party set state='missed',left_at=clock_timestamp() where call_id=p_call and person_id=p;
  perform chat_call_unring(p_call,p,true);
 end loop;
 update chat_call_party set state='left',left_at=clock_timestamp() where call_id=p_call and state='joined';
 delete from chat_call_event where org_id=current_org() and call_id=p_call and kind='signal';
 perform chat_call_line(p_call);
end $$;

-- After anyone's change: does the call go on?
create function pulse.chat_call_settle(p_call uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c chat_call; joined int; ringing int; declined int; busy int;
begin
 select * into c from chat_call where org_id=current_org() and id=p_call for update;
 if not found or c.state='ended' then return; end if;
 select count(*) filter (where state='joined'),count(*) filter (where state='ringing'),count(*) filter (where state='declined'),count(*) filter (where state='busy')
  into joined,ringing,declined,busy from chat_call_party where call_id=p_call;
 if c.state='ringing' then
  if joined=0 then perform chat_call_end(p_call,'missed');
  elsif ringing=0 then perform chat_call_end(p_call,case when declined>0 then 'declined' when busy>0 then 'busy' else 'missed' end);
  end if;
 elsif joined=0 or (joined=1 and ringing=0) then perform chat_call_end(p_call,'completed');
 end if;
end $$;

-- Rings nobody answered and people whose Pulse went quiet; old events. Any open Pulse runs this every few seconds.
create function pulse.chat_call_expire() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r record; p record;
begin
 for r in select distinct pa.call_id from chat_call_party pa join chat_call c on c.id=pa.call_id
  where pa.org_id=current_org() and c.org_id=current_org() and c.state<>'ended'
  and ((pa.state='ringing' and pa.invited_at<clock_timestamp()-interval '45 seconds') or (pa.state='joined' and pa.seen_at<clock_timestamp()-interval '30 seconds')) loop
  for p in select person_id from chat_call_party where call_id=r.call_id and state='ringing' and invited_at<clock_timestamp()-interval '45 seconds' loop
   update chat_call_party set state='missed',left_at=clock_timestamp() where call_id=r.call_id and person_id=p.person_id;
   perform chat_call_unring(r.call_id,p.person_id,true);
  end loop;
  update chat_call_party set state='left',left_at=clock_timestamp() where call_id=r.call_id and state='joined' and seen_at<clock_timestamp()-interval '30 seconds';
  perform chat_call_settle(r.call_id); perform chat_call_line(r.call_id); perform chat_call_touch(r.call_id);
 end loop;
 delete from chat_call_event where org_id=current_org() and created_at<clock_timestamp()-interval '10 minutes';
end $$;

-- Start a call in a conversation: ring its other members (everyone up to 7, or the ones chosen). A call already open
-- here is joined instead.
create function pulse.chat_call_start(p_channel uuid,p_video boolean,p_invite uuid[] default null) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cid uuid; others uuid[]; existing uuid; mid uuid; p uuid; label text:=case when coalesce(p_video,false) then 'Video call' else 'Voice call' end;
begin
 if not chat_has(p_channel) or not exists(select 1 from chat_member where org_id=current_org() and channel_id=p_channel and person_id=current_viewer()) then
  raise exception 'conversation unavailable' using errcode='42501'; end if;
 perform chat_call_expire();
 select id into existing from chat_call where org_id=current_org() and channel_id=p_channel and state<>'ended';
 if existing is not null then perform chat_call_answer(existing); return existing; end if;
 if exists(select 1 from chat_call_party pa join chat_call c on c.id=pa.call_id where pa.org_id=current_org() and pa.person_id=current_viewer() and pa.state='joined' and c.state<>'ended') then
  raise exception 'You are already in a call. Hang up first.' using errcode='22023'; end if;
 select coalesce(array_agg(cm.person_id order by pe.display_name),'{}') into others from chat_member cm join person pe on pe.id=cm.person_id
 where cm.org_id=current_org() and cm.channel_id=p_channel and cm.person_id<>current_viewer() and pe.status='active' and pe.side='staff'
  and (p_invite is null or cm.person_id=any(p_invite)) and notification_chat_member_current(p_channel,cm.person_id);
 if cardinality(others)=0 then raise exception 'There is nobody here to call' using errcode='22023'; end if;
 if cardinality(others)>7 then raise exception 'A call can ring up to 7 people. Choose who to call.' using errcode='22023'; end if;
 insert into chat_call(org_id,channel_id,started_by,video) values(current_org(),p_channel,current_viewer(),coalesce(p_video,false)) returning id into cid;
 insert into chat_call_party(org_id,call_id,person_id,state,joined_at,video) values(current_org(),cid,current_viewer(),'joined',clock_timestamp(),coalesce(p_video,false));
 insert into chat_call_party(org_id,call_id,person_id,state,invited_by)
 select current_org(),cid,o,case when exists(select 1 from chat_call_party b join chat_call bc on bc.id=b.call_id where b.org_id=current_org() and b.person_id=o and b.state='joined' and bc.state<>'ended' and b.seen_at>clock_timestamp()-interval '30 seconds') then 'busy' else 'ringing' end,current_viewer()
 from unnest(others) o;
 mid:=chat_event_line(p_channel,current_viewer(),label,jsonb_build_array(jsonb_build_object('call',cid,'name',label,'video',coalesce(p_video,false),'state','ringing','seconds',null)));
 update chat_call set message_id=mid where id=cid;
 for p in select person_id from chat_call_party where call_id=cid and state='ringing' loop perform chat_call_ring(cid,p); end loop;
 perform chat_call_settle(cid);
 perform chat_call_touch(cid);
 return cid;
end $$;

-- Answer (or join a group call already going in a conversation I am in).
create function pulse.chat_call_answer(p_call uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 perform chat_call_line(p_call); perform chat_call_touch(p_call);
end $$;

create function pulse.chat_call_decline(p_call uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 update chat_call_party set state='declined',left_at=clock_timestamp() where org_id=current_org() and call_id=p_call and person_id=current_viewer() and state='ringing';
 if not found then return; end if;
 perform chat_call_unring(p_call,current_viewer(),false);
 perform chat_call_settle(p_call); perform chat_call_touch(p_call);
end $$;

-- Hang up. The caller hanging up before anyone answers leaves everyone ringing a missed call.
create function pulse.chat_call_leave(p_call uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 update chat_call_party set state='left',left_at=clock_timestamp() where org_id=current_org() and call_id=p_call and person_id=current_viewer() and state='joined';
 if not found then perform chat_call_decline(p_call); return; end if;
 perform chat_call_settle(p_call); perform chat_call_line(p_call); perform chat_call_touch(p_call);
end $$;

-- Ring more people into a call I am in: members of a group, anyone at the company for a one-to-one.
create function pulse.chat_call_invite(p_call uuid,p_people uuid[]) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c chat_call; kind text; p uuid;
begin
 select * into c from chat_call where org_id=current_org() and id=p_call;
 if not found or c.state='ended' or not exists(select 1 from chat_call_party where call_id=p_call and person_id=current_viewer() and state='joined') then
  raise exception 'call unavailable' using errcode='42501'; end if;
 select ch.kind into kind from chat_channel ch where ch.id=c.channel_id;
 for p in select distinct x from unnest(coalesce(p_people,'{}')) x loop
  if p=current_viewer() or not exists(select 1 from person where org_id=current_org() and id=p and status='active' and side='staff') then continue; end if;
  if kind<>'direct' and not notification_chat_member_current(c.channel_id,p) then continue; end if;
  if exists(select 1 from chat_call_party where call_id=p_call and person_id=p and state in ('ringing','joined')) then continue; end if;
  if (select count(*) from chat_call_party where call_id=p_call and state in ('ringing','joined'))>=8 then raise exception 'A call has 8 people at most' using errcode='22023'; end if;
  insert into chat_call_party(org_id,call_id,person_id,state,invited_by,invited_at) values(current_org(),p_call,p,'ringing',current_viewer(),clock_timestamp())
  on conflict(call_id,person_id) do update set state='ringing',invited_by=current_viewer(),invited_at=clock_timestamp(),left_at=null;
  perform chat_call_ring(p_call,p);
 end loop;
 perform chat_call_touch(p_call);
end $$;

-- I am still here (every few seconds while in the call), muted or not, camera on or not.
create function pulse.chat_call_beat(p_call uuid,p_muted boolean,p_video boolean) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
declare old chat_call_party;
begin
 select * into old from chat_call_party where org_id=current_org() and call_id=p_call and person_id=current_viewer() and state='joined';
 if not found then return false; end if;
 update chat_call_party set seen_at=clock_timestamp(),muted=coalesce(p_muted,muted),video=coalesce(p_video,video) where call_id=p_call and person_id=current_viewer();
 if old.muted is distinct from coalesce(p_muted,old.muted) or old.video is distinct from coalesce(p_video,old.video) then perform chat_call_touch(p_call); end if;
 return true;
end $$;

-- Connection messages from me to others in the call: [{to,kind:'description'|'candidate',body}], at most 60 at once.
create function pulse.chat_call_signal(p_call uuid,p_signals jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s jsonb;
begin
 if jsonb_typeof(p_signals) is distinct from 'array' or jsonb_array_length(p_signals)>60 then raise exception 'invalid signal' using errcode='22023'; end if;
 if not exists(select 1 from chat_call_party me join chat_call c on c.id=me.call_id where me.org_id=current_org() and me.call_id=p_call and me.person_id=current_viewer() and me.state='joined' and c.state<>'ended') then
  raise exception 'call unavailable' using errcode='42501'; end if;
 for s in select value from jsonb_array_elements(p_signals) loop
  if s->>'kind' not in ('description','candidate') or coalesce(s->>'to','') !~ '^[0-9a-f-]{36}$' or octet_length((s->'body')::text)>60000 then raise exception 'invalid signal' using errcode='22023'; end if;
  insert into chat_call_event(org_id,person_id,call_id,kind,from_id,body)
  select current_org(),t.person_id,p_call,'signal',current_viewer(),jsonb_build_object('kind',s->>'kind','body',s->'body')
  from chat_call_party t where t.call_id=p_call and t.person_id=(s->>'to')::uuid and t.state='joined' and t.person_id<>current_viewer();
 end loop;
end $$;

-- My stream: everything after a sequence number (a call's state as it is now, or a signal for me).
create function pulse.chat_call_events(p_after bigint) returns table(seq bigint,call_id uuid,kind text,from_id uuid,body jsonb) language sql stable security definer set search_path=pulse,pg_temp as $$
 select e.seq,e.call_id,e.kind,e.from_id,case when e.kind='state' then chat_call_view(e.call_id) else e.body end
 from chat_call_event e where e.org_id=current_org() and e.person_id=current_viewer() and e.seq>p_after order by e.seq limit 300
$$;
create function pulse.chat_call_cursor() returns bigint language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(max(seq),0) from chat_call_event where org_id=current_org() and person_id=current_viewer()
$$;
-- Calls ringing me or with me in them, for a Pulse just opened.
create function pulse.chat_call_mine() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(chat_call_view(c.id) order by c.created_at),'[]') from chat_call c join chat_call_party p on p.call_id=c.id and p.person_id=current_viewer()
 where c.org_id=current_org() and c.state<>'ended' and p.state in ('ringing','joined')
$$;
-- Recent calls across my conversations (newest first), for a calls list.
create function pulse.chat_call_recent(p_limit int default 40) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(x order by x->>'createdAt' desc),'[]') from (
  select chat_call_view(c.id) x from chat_call c join chat_call_party p on p.call_id=c.id and p.person_id=current_viewer()
  where c.org_id=current_org() and c.created_at>clock_timestamp()-interval '90 days' order by c.created_at desc limit least(greatest(p_limit,1),100)) r
$$;

-- Notifications: a call rings (urgent), a missed call and a voice message need you (a voice message in a group too).
create or replace function pulse.notification_priority(p_type text) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select case
  -- CHAT-VOICE: someone is calling you.
  when p_type = 'chat.call' then 'urgent'
  when p_type in ('chat.missed_call','chat.voice') then 'needs_you'
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
create or replace function pulse.notification_family(p_type text) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select case
  -- CHAT-VOICE: calls ring and miss as one family; a voice message is a chat.
  when p_type in ('chat.call','chat.missed_call') then 'calls'
  when p_type = 'chat.voice' then 'chats'
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
create or replace function pulse.notification_daily_pings(p_family text) returns int language sql immutable set search_path=pulse,pg_temp as $$
 select case p_family
  when 'calls' then 200
  when 'test' then 20 when 'pay' then 10 when 'chats' then 40 when 'mentions' then 20
  when 'approvals' then 3 when 'my_requests' then 6 when 'tasks_assigned' then 6
  when 'tasks_waiting' then 2 when 'tasks_due' then 1 when 'reviews' then 1
  when 'attendance_questions' then 2 when 'attendance_reminders' then 1 when 'attendance_digest' then 1
  when 'processes' then 4 when 'domains' then 3
  else 2 end
$$;
-- A chat message that is a voice note is announced as one (after the contract names it, before the policy weighs it).
create function pulse.notification_voice_kind() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.event_type='chat.message' and new.message_id is not null and exists(select 1 from chat_message m cross join lateral jsonb_array_elements(m.attachments) a
   where m.org_id=new.org_id and m.id=new.message_id and a ? 'voice') then
  new.event_type:='chat.voice'; new.title:='New voice message in Chats';
 end if;
 return new;
end $$;
revoke all on function pulse.notification_voice_kind() from public;
create trigger notification_zy_voice before insert on pulse.notification for each row execute function pulse.notification_voice_kind();

revoke all on function pulse.chat_call_wake(),pulse.chat_call_touch(uuid),pulse.chat_call_view(uuid),pulse.chat_call_line(uuid),pulse.chat_call_ring(uuid,uuid),
 pulse.chat_call_unring(uuid,uuid,boolean),pulse.chat_call_end(uuid,text),pulse.chat_call_settle(uuid),pulse.chat_call_expire(),pulse.chat_call_start(uuid,boolean,uuid[]),
 pulse.chat_call_answer(uuid),pulse.chat_call_decline(uuid),pulse.chat_call_leave(uuid),pulse.chat_call_invite(uuid,uuid[]),pulse.chat_call_beat(uuid,boolean,boolean),
 pulse.chat_call_signal(uuid,jsonb),pulse.chat_call_events(bigint),pulse.chat_call_cursor(),pulse.chat_call_mine(),pulse.chat_call_recent(int) from public;
grant execute on function pulse.chat_call_view(uuid),pulse.chat_call_expire(),pulse.chat_call_start(uuid,boolean,uuid[]),pulse.chat_call_answer(uuid),pulse.chat_call_decline(uuid),
 pulse.chat_call_leave(uuid),pulse.chat_call_invite(uuid,uuid[]),pulse.chat_call_beat(uuid,boolean,boolean),pulse.chat_call_signal(uuid,jsonb),pulse.chat_call_events(bigint),
 pulse.chat_call_cursor(),pulse.chat_call_mine(),pulse.chat_call_recent(int) to pulse_api;
grant execute on function pulse.chat_call_expire() to pulse_worker;

-- migrate:down
-- Forward-only.
