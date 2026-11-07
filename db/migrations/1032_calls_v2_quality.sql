-- migrate:up
-- CALLS-V2 (25 Oct 2026): calls the team and clients can rely on. Additive on 0896 (CHAT-VOICE's calls):
--
--   chat_call_party.screen   someone in the call is sharing their screen (their video line carries it), so the others
--                            show it whole and large; set by the browser's beat like muted and video.
--   chat_call_quality        what each person's browser measured about a call: how long it took to connect after the
--                            answer, which way the media went (direct, through STUN, or through the company's TURN
--                            relay over UDP or TCP), round trip, jitter and loss, reconnects and ICE restarts, and why a
--                            call failed (microphone refused, no route, dropped). Numbers and short codes only: never
--                            audio, addresses or candidates (only whether a relay was offered and gathered). One row per note; a person writes at most 40 per call.
--   chat_call_note()         the browser's way in (also for a failure before a call exists: the microphone refused).
--   chat_call_quality_summary()  for admins and leadership: setup times, the media path mix, failures and their causes.
--
-- A one-to-one call that went live but never connected its media (nobody's browser reported a connection, one reported
-- that it could not connect) ends as "didn't connect" instead of a call of some seconds.
--
-- Who may be rung into a call is guarded by a trigger (chat_call_party_guard): the conversation's members, or a colleague
-- added by a colleague; never a client into a conversation that is not theirs, and a client's people ring only their team.
-- Starting a call (CLIENT-PORTAL 1020's chat_call_start) now rings a client's contact in the conversation too.

alter table pulse.chat_call_party add column screen boolean not null default false;

create table pulse.chat_call_quality (
 org_id uuid not null, id bigint generated always as identity primary key, call_id uuid,
 person_id uuid not null references pulse.person(id), at timestamptz not null default clock_timestamp(),
 kind text not null check (kind in ('setup','end','failure','reconnect')),
 role text check (role in ('caller','callee','joiner')),
 video boolean,
 setup_ms integer check (setup_ms between 0 and 600000),
 media_ms integer check (media_ms between 0 and 600000),
 path text check (path in ('host','srflx','prflx','relay-udp','relay-tcp','relay-tls','unknown')),
 rtt_ms integer check (rtt_ms between 0 and 60000),
 jitter_ms integer check (jitter_ms between 0 and 60000),
 loss_pct numeric(5,2) check (loss_pct between 0 and 100),
 reconnects smallint check (reconnects between 0 and 1000),
 restarts smallint check (restarts between 0 and 1000),
 seconds integer check (seconds between 0 and 86400),
 peers smallint check (peers between 0 and 8),
 reason text check (reason ~ '^[a-z][a-z-]{1,30}$'),
 network text check (network ~ '^[a-z0-9-]{1,20}$'),
 platform text check (platform in ('web','android','ios','desktop')),
 device text check (device in ('phone','tablet','desktop')),
 relay_offered boolean,
 relay_gathered boolean,
 foreign key (org_id, call_id) references pulse.chat_call(org_id, id) on delete cascade
);
create index chat_call_quality_at on pulse.chat_call_quality (org_id, at);
create index chat_call_quality_call on pulse.chat_call_quality (call_id) where call_id is not null;
alter table pulse.chat_call_quality enable row level security;
alter table pulse.chat_call_quality force row level security;
create policy tenant_isolation on pulse.chat_call_quality using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select, insert, update, delete on pulse.chat_call_quality to pulse_worker;

-- The call as its people see it: as in 0896, and who is sharing their screen.
create or replace function pulse.chat_call_view(p_call uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',c.id,'channelId',c.channel_id,'channelKind',ch.kind,'channelName',case when ch.kind='direct' then null else ch.name end,
  'video',c.video,'state',c.state,'endReason',c.end_reason,'startedBy',c.started_by,'messageId',c.message_id,
  'createdAt',c.created_at,'answeredAt',c.answered_at,'endedAt',c.ended_at,'now',clock_timestamp(),
  'parties',(select jsonb_agg(jsonb_build_object('id',p.person_id,'name',pe.display_name,'photoAt',(select ph.updated_at from person_photo ph where ph.person_id=p.person_id),
    'state',p.state,'muted',p.muted,'video',p.video,'screen',p.screen and p.state='joined','joinedAt',p.joined_at,'invitedBy',p.invited_by) order by p.invited_at,pe.display_name)
   from chat_call_party p join person pe on pe.id=p.person_id where p.call_id=c.id))
 from chat_call c join chat_channel ch on ch.id=c.channel_id
 where c.org_id=current_org() and c.id=p_call and exists(select 1 from chat_call_party me where me.call_id=c.id and me.person_id=current_viewer())
$$;

-- The call's line in the conversation (0896), and: a one-to-one call that went live but whose media never connected
-- (a browser said it could not connect and none said it did) is "didn't connect", not a call of some seconds.
create or replace function pulse.chat_call_line(p_call uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c chat_call; secs int; st text; label text;
begin
 select * into c from chat_call where org_id=current_org() and id=p_call;
 if not found or c.message_id is null then return; end if;
 if c.state='ended' and c.end_reason='completed' and (select count(*) from chat_call_party where call_id=c.id)=2
   and exists(select 1 from chat_call_quality where org_id=current_org() and call_id=c.id and kind='failure' and reason='no-connect')
   and not exists(select 1 from chat_call_quality where org_id=current_org() and call_id=c.id and kind='setup') then
  update chat_call set end_reason='failed' where id=c.id; c.end_reason:='failed';
 end if;
 secs:=case when c.answered_at is not null then greatest(0,extract(epoch from coalesce(c.ended_at,clock_timestamp())-c.answered_at))::int end;
 st:=case when c.state<>'ended' then c.state else c.end_reason end;
 label:=case when c.video then 'Video call' else 'Voice call' end;
 update chat_message set body=case st when 'completed' then label||' · '||(secs/60)||':'||lpad((secs%60)::text,2,'0')
   when 'missed' then 'Missed '||lower(label) when 'declined' then label||' · declined' when 'busy' then label||' · busy' when 'failed' then label||' · not connected'
   when 'live' then label||' · on now' else label end,
  attachments=jsonb_build_array(jsonb_build_object('call',c.id,'name',label,'video',c.video,'state',st,'seconds',secs)),updated_at=clock_timestamp()
 where org_id=current_org() and id=c.message_id;
end $$;

-- I am still here: muted or not, camera on or not, sharing my screen or not (0896's beat, with the screen).
create function pulse.chat_call_beat(p_call uuid,p_muted boolean,p_video boolean,p_screen boolean) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
declare old chat_call_party;
begin
 select * into old from chat_call_party where org_id=current_org() and call_id=p_call and person_id=current_viewer() and state='joined';
 if not found then return false; end if;
 update chat_call_party set seen_at=clock_timestamp(),muted=coalesce(p_muted,muted),video=coalesce(p_video,video),screen=coalesce(p_screen,screen) where call_id=p_call and person_id=current_viewer();
 if old.muted is distinct from coalesce(p_muted,old.muted) or old.video is distinct from coalesce(p_video,old.video) or old.screen is distinct from coalesce(p_screen,old.screen) then perform chat_call_touch(p_call); end if;
 return true;
end $$;

-- A note from my browser about a call I was asked to (or, with no call, a call that could not even start).
create function pulse.chat_call_note(p_call uuid,p jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k text:=p->>'kind'; n int; c chat_call;
 int_of constant text:='^[0-9]{1,9}$';
begin
 if current_viewer() is null or jsonb_typeof(p) is distinct from 'object' or k not in ('setup','end','failure','reconnect') then raise exception 'invalid note' using errcode='22023'; end if;
 if p_call is not null then
  select * into c from chat_call where org_id=current_org() and id=p_call;
  if not found or not exists(select 1 from chat_call_party where call_id=p_call and person_id=current_viewer()) then raise exception 'call unavailable' using errcode='42501'; end if;
  select count(*) into n from chat_call_quality where org_id=current_org() and call_id=p_call and person_id=current_viewer();
 else
  if k<>'failure' then raise exception 'invalid note' using errcode='22023'; end if;
  select count(*) into n from chat_call_quality where org_id=current_org() and call_id is null and person_id=current_viewer() and at>clock_timestamp()-interval '1 hour';
 end if;
 if n>=40 then return; end if;
 insert into chat_call_quality(org_id,call_id,person_id,kind,role,video,setup_ms,media_ms,path,rtt_ms,jitter_ms,loss_pct,reconnects,restarts,seconds,peers,reason,network,platform,device,relay_offered,relay_gathered)
 values(current_org(),p_call,current_viewer(),k,
  case when p->>'role' in ('caller','callee','joiner') then p->>'role' end,
  case when jsonb_typeof(p->'video')='boolean' then (p->>'video')::boolean end,
  case when p->>'setupMs' ~ int_of then least((p->>'setupMs')::int,600000) end,
  case when p->>'mediaMs' ~ int_of then least((p->>'mediaMs')::int,600000) end,
  case when p->>'path' in ('host','srflx','prflx','relay-udp','relay-tcp','relay-tls','unknown') then p->>'path' end,
  case when p->>'rttMs' ~ int_of then least((p->>'rttMs')::int,60000) end,
  case when p->>'jitterMs' ~ int_of then least((p->>'jitterMs')::int,60000) end,
  case when jsonb_typeof(p->'lossPct')='number' then least(100,greatest(0,round((p->>'lossPct')::numeric,2))) end,
  case when p->>'reconnects' ~ int_of then least((p->>'reconnects')::int,1000) end,
  case when p->>'restarts' ~ int_of then least((p->>'restarts')::int,1000) end,
  case when p->>'seconds' ~ int_of then least((p->>'seconds')::int,86400) end,
  case when p->>'peers' ~ '^[0-8]$' then (p->>'peers')::smallint end,
  case when p->>'reason' ~ '^[a-z][a-z-]{1,30}$' then p->>'reason' end,
  case when p->>'network' ~ '^[a-z0-9-]{1,20}$' then p->>'network' end,
  case when p->>'platform' in ('web','android','ios','desktop') then p->>'platform' end,
  case when p->>'device' in ('phone','tablet','desktop') then p->>'device' end,
  case when jsonb_typeof(p->'relayOffered')='boolean' then (p->>'relayOffered')::boolean end,
  case when jsonb_typeof(p->'relayGathered')='boolean' then (p->>'relayGathered')::boolean end);
 -- A one-to-one call whose media never connected says so in the chat (the note may come before or after the hang-up).
 if k='failure' and p->>'reason'='no-connect' and c.id is not null and c.state='ended' and c.end_reason='completed' then
  perform chat_call_line(c.id); perform chat_call_touch(c.id);
 end if;
 -- Notes are kept 180 days.
 if random()<0.01 then delete from chat_call_quality where org_id=current_org() and at<clock_timestamp()-interval '180 days'; end if;
end $$;

-- For admins and leadership: how calls connected over the last days.
create function pulse.chat_call_quality_summary(p_days int default 14) returns jsonb language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare d int:=least(greatest(coalesce(p_days,14),1),180); since timestamptz:=clock_timestamp()-make_interval(days=>least(greatest(coalesce(p_days,14),1),180)); r jsonb;
begin
 if not viewer_is('admin','leadership') then raise exception 'Admins and leadership see call quality' using errcode='42501'; end if;
 with q as (select * from chat_call_quality where org_id=current_org() and at>=since),
 calls as (select * from chat_call where org_id=current_org() and created_at>=since),
 setup as (select setup_ms from q where kind='setup' and setup_ms is not null)
 select jsonb_build_object(
  'days',d,
  'calls',(select count(*) from calls),
  'answered',(select count(*) from calls where answered_at is not null),
  'missed',(select count(*) from calls where end_reason='missed'),
  'failed',(select count(*) from calls where end_reason='failed'),
  'setupP50',(select percentile_cont(0.5) within group (order by setup_ms)::int from setup),
  'setupP90',(select percentile_cont(0.9) within group (order by setup_ms)::int from setup),
  'connects',(select count(*) from q where kind='setup'),
  'paths',(select coalesce(jsonb_object_agg(path,n),'{}') from (select coalesce(path,'unknown') path,count(*) n from q where kind='setup' group by 1) x),
  'failures',(select coalesce(jsonb_object_agg(reason,n),'{}') from (select coalesce(reason,'unknown') reason,count(*) n from q where kind='failure' group by 1) x),
  'reconnects',(select coalesce(sum(reconnects),0) from q where kind='end'),
  'rttMs',(select avg(rtt_ms)::int from q where kind='end' and rtt_ms is not null),
  'jitterMs',(select avg(jitter_ms)::int from q where kind='end' and jitter_ms is not null),
  'lossPct',(select round(avg(loss_pct),2) from q where kind='end' and loss_pct is not null),
  'platforms',(select coalesce(jsonb_object_agg(k,n),'{}') from (select coalesce(platform,'web')||'-'||coalesce(device,'desktop') k,count(*) n from q where kind in ('setup','failure') group by 1) x),
  'recent',(select coalesce(jsonb_agg(x order by x->>'at' desc),'[]') from (select jsonb_build_object('at',q.at,'kind',q.kind,'reason',q.reason,'path',q.path,'network',q.network,'platform',q.platform,'device',q.device,
     'setupMs',q.setup_ms,'video',q.video,'relayOffered',q.relay_offered,'relayGathered',q.relay_gathered,'channelKind',(select ch.kind from chat_call cc join chat_channel ch on ch.id=cc.channel_id where cc.id=q.call_id)) x
    from q where q.kind='failure' order by q.at desc limit 20) y)
 ) into r;
 return r;
end $$;

-- Who may be rung into a call: a member of the call's conversation (starting a call rings members only), or a colleague
-- added by a colleague (a one-to-one call grows into a team call). So someone from a client's side (CLIENT-PORTAL lets
-- them call in the chats shared with them) rings only the people of those chats, their team, and nobody rings a client
-- into a conversation that is not theirs. A trigger, so it holds whatever version of start or invite runs.
create function pulse.chat_call_party_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare ch uuid;
begin
 if new.state<>'ringing' or new.invited_by is null or (tg_op='UPDATE' and old.state='ringing' and old.invited_by is not distinct from new.invited_by) then return new; end if;
 select channel_id into ch from chat_call where id=new.call_id;
 if exists(select 1 from chat_member cm join person pe on pe.id=cm.person_id where cm.org_id=new.org_id and cm.channel_id=ch and cm.person_id=new.person_id and pe.status='active') then return new; end if;
 if exists(select 1 from person where id=new.invited_by and side='staff') and exists(select 1 from person where id=new.person_id and side='staff') then return new; end if;
 raise exception 'Only the people of this conversation can be added to its call' using errcode='42501';
end $$;
revoke all on function pulse.chat_call_party_guard() from public;
create trigger chat_call_party_guard before insert or update of state,invited_by on pulse.chat_call_party for each row execute function pulse.chat_call_party_guard();

-- Starting a call (CLIENT-PORTAL 1020's version): a client's contact in the conversation is rung too. 1020 meant it but
-- kept 0896's staff-only "still a member" check, so a team member calling a client rang nobody on the client's side.
create or replace function pulse.chat_call_start(p_channel uuid,p_video boolean,p_invite uuid[] default null) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 where cm.org_id=current_org() and cm.channel_id=p_channel and cm.person_id<>current_viewer() and pe.status='active' and (pe.side='staff' or connect_is_seat(pe.id))
  and (p_invite is null or cm.person_id=any(p_invite))
  -- CALLS-V2: a colleague still in the conversation (pods and teams follow the people's own pod and team), or a client's
  -- contact whose connection is active: notification_chat_member_current() counts staff only, so contacts were never rung.
  and case when pe.side='staff' then notification_chat_member_current(p_channel,cm.person_id) else connect_is_seat(pe.id) end;
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


revoke all on function pulse.chat_call_beat(uuid,boolean,boolean,boolean),pulse.chat_call_note(uuid,jsonb),pulse.chat_call_quality_summary(int) from public;
grant execute on function pulse.chat_call_beat(uuid,boolean,boolean,boolean),pulse.chat_call_note(uuid,jsonb),pulse.chat_call_quality_summary(int) to pulse_api;

-- migrate:down
-- Forward-only.
