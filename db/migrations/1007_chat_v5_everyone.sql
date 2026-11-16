-- migrate:up
-- CHAT-V5 (owner, 24 Oct 2026: "chat mode needs a far greater upgrade"): @everyone and @here in a group.
--   @everyone  tells every member of the group as a mention (bell and push), except members who muted the group.
--   @here      the same for members active in Pulse in the last 10 minutes; the others get it as an ordinary message.
-- A message is marked when it is written (chat_message.broadcast, set from its words); the composer asks before a
-- message that would notify more than 10 people goes. Mute is respected: a muted member is never told by either.
-- Additive: one nullable column, one new trigger function and trigger; chat_notify_members is replaced to tell the
-- marked messages' members (unchanged otherwise). Uses only objects defined in this repository.

alter table pulse.chat_message add column if not exists broadcast text check (broadcast in ('everyone', 'here'));

create function pulse.chat_broadcast_mark() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare hit text;
begin
  if new.kind = 'text' and new.body ~* '(^|[^a-z0-9._-])@(everyone|here)([^a-z0-9._-]|$)'
     and exists(select 1 from chat_channel ch where ch.id = new.channel_id and ch.kind <> 'direct') then
    hit := lower((regexp_match(new.body, '(?:^|[^a-zA-Z0-9._-])@(everyone|here)(?:[^a-zA-Z0-9._-]|$)', 'i'))[1]);
    -- @everyone wins over @here in one message.
    new.broadcast := case when new.body ~* '(^|[^a-z0-9._-])@everyone([^a-z0-9._-]|$)' then 'everyone' else hit end;
  end if;
  return new;
end $$;
create trigger chat_broadcast_mark before insert on pulse.chat_message for each row execute function pulse.chat_broadcast_mark();

create or replace function pulse.chat_notify_members() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare quoted uuid;
begin
 if new.kind='event' then return null; end if;
 if new.quote_id is not null then select author_id into quoted from chat_message where id=new.quote_id; end if;
 insert into notification(org_id,person_id,title,href,kind,channel_id,message_id)
 select new.org_id,cm.person_id,
 case when cm.person_id=any(new.mentions) then 'You were mentioned in Chats' when cm.person_id=quoted then 'You have a reply in Chats'
  when x.told then case new.broadcast when 'everyone' then '@everyone in Chats' else '@here in Chats' end else 'New message in Chats' end,
 '/chats?channel='||new.channel_id||case when new.parent_id is null then '' else '&thread='||new.parent_id end,
 case when cm.person_id=any(new.mentions) or x.told then 'mention' when new.parent_id is not null or cm.person_id=quoted then 'reply' else 'chat' end,
 new.channel_id,new.id
 from chat_member cm join person p on p.id=cm.person_id and p.org_id=cm.org_id
 -- CHAT-V5: told by @everyone (any member) or @here (members active in Pulse in the last 10 minutes); never a muted one.
 cross join lateral (select new.broadcast is not null and (new.broadcast='everyone' or exists(select 1 from person_status st where st.org_id=cm.org_id and st.person_id=cm.person_id and st.last_active_at>clock_timestamp()-interval '10 minutes')) told) x
 where cm.org_id=new.org_id and cm.channel_id=new.channel_id and cm.person_id<>new.author_id and p.status='active'
   and (cm.muted_until is null or cm.muted_until<clock_timestamp() or cm.person_id=any(new.mentions) or cm.person_id is not distinct from quoted)
 on conflict do nothing;
 return null;
end $$;

revoke all on function pulse.chat_broadcast_mark() from public;

-- migrate:down
create or replace function pulse.chat_notify_members() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare quoted uuid;
begin
 if new.kind='event' then return null; end if;
 if new.quote_id is not null then select author_id into quoted from chat_message where id=new.quote_id; end if;
 insert into notification(org_id,person_id,title,href,kind,channel_id,message_id)
 select new.org_id,cm.person_id,
 case when cm.person_id=any(new.mentions) then 'You were mentioned in Chats' when cm.person_id=quoted then 'You have a reply in Chats' else 'New message in Chats' end,
 '/chats?channel='||new.channel_id||case when new.parent_id is null then '' else '&thread='||new.parent_id end,
 case when cm.person_id=any(new.mentions) then 'mention' when new.parent_id is not null or cm.person_id=quoted then 'reply' else 'chat' end,
 new.channel_id,new.id
 from chat_member cm join person p on p.id=cm.person_id and p.org_id=cm.org_id
 where cm.org_id=new.org_id and cm.channel_id=new.channel_id and cm.person_id<>new.author_id and p.status='active'
   and (cm.muted_until is null or cm.muted_until<clock_timestamp() or cm.person_id=any(new.mentions) or cm.person_id is not distinct from quoted)
 on conflict do nothing;
 return null;
end $$;
drop trigger if exists chat_broadcast_mark on pulse.chat_message;
drop function if exists pulse.chat_broadcast_mark();
alter table pulse.chat_message drop column if exists broadcast;
