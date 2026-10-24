-- migrate:up
-- CHATS-2: chats that work like WhatsApp. Quote replies, pinned chats, delivered receipts, groups people make
-- themselves (name, members, photo), task cards that follow a task into its chat, and presence: where someone is,
-- derived from Pulse data, with a custom status and do-not-disturb. 0147 belongs to PRESENCE-ONBOARD.

-- Groups people make themselves --------------------------------------------------------------------------------------
alter table pulse.chat_channel drop constraint chat_channel_kind_check;
alter table pulse.chat_channel add constraint chat_channel_kind_check check(kind in('pod','team','group','direct','custom'));
alter table pulse.chat_channel add column created_by uuid references pulse.person(id);
alter table pulse.chat_channel add column photo_at timestamptz;
alter table pulse.chat_member add column role text not null default 'member' check(role in('member','admin'));
alter table pulse.chat_member add column pinned_at timestamptz;
create table pulse_priv.chat_channel_photo (
 org_id uuid not null, channel_id uuid primary key, mime text not null check(mime in('image/png','image/jpeg','image/webp')),
 bytes bytea not null check(octet_length(bytes) between 1 and 1048576), updated_at timestamptz not null default now(),
 foreign key(org_id,channel_id) references pulse.chat_channel(org_id,id) on delete cascade
);
alter table pulse_priv.chat_channel_photo enable row level security;
alter table pulse_priv.chat_channel_photo force row level security;
create policy tenant_isolation on pulse_priv.chat_channel_photo using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.chat_channel_photo to pulse_worker;

-- Messages: a reply quotes the message it answers and stays in the conversation (threads remain readable). An event
-- line ("created the group", "moved the task to Done") is written by Pulse, never notifies and cannot be edited.
alter table pulse.chat_message add column quote_id uuid references pulse.chat_message(id) on delete set null;
alter table pulse.chat_message add column kind text not null default 'text' check(kind in('text','event'));
create index chat_message_quote on pulse.chat_message(org_id,quote_id) where quote_id is not null;

-- Delivered receipts change on every list load, so they live apart from the audited membership row.
create table pulse.chat_receipt (
 org_id uuid not null, channel_id uuid not null, person_id uuid not null references pulse.person(id),
 delivered_through timestamptz not null default '-infinity', primary key(channel_id,person_id),
 foreign key(org_id,channel_id) references pulse.chat_channel(org_id,id) on delete cascade
);
alter table pulse.chat_receipt enable row level security;
alter table pulse.chat_receipt force row level security;
create policy tenant_isolation on pulse.chat_receipt using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy member_read on pulse.chat_receipt as restrictive for select to pulse_api using(pulse.chat_has(channel_id));
grant select,insert,update,delete on pulse.chat_receipt to pulse_worker;
grant select on pulse.chat_receipt to pulse_api;

-- A task whose updates its owner chose to post into a chat.
create table pulse.chat_task_follow (
 org_id uuid not null, task_id uuid not null, channel_id uuid not null, created_by uuid not null references pulse.person(id),
 created_at timestamptz not null default now(), primary key(task_id,channel_id),
 foreign key(org_id,channel_id) references pulse.chat_channel(org_id,id) on delete cascade
);
alter table pulse.chat_task_follow enable row level security;
alter table pulse.chat_task_follow force row level security;
create policy tenant_isolation on pulse.chat_task_follow using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create policy member_read on pulse.chat_task_follow as restrictive for select to pulse_api using(pulse.chat_has(channel_id));
grant select,insert,update,delete on pulse.chat_task_follow to pulse_worker;
grant select on pulse.chat_task_follow to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.chat_task_follow for each row execute function pulse.audit_mutation();

-- Presence: the person's own status line and when they last had Pulse open. Do-not-disturb is the existing
-- notification snooze (companion_notification_settings), so pings and the status dot always agree.
create table pulse.person_status (
 org_id uuid not null references pulse.org(id), person_id uuid not null references pulse.person(id),
 status_text text check(length(status_text) between 1 and 80), status_emoji text check(length(status_emoji) between 1 and 16),
 status_until timestamptz, last_active_at timestamptz, updated_at timestamptz not null default now(), primary key(org_id,person_id)
);
alter table pulse.person_status enable row level security;
alter table pulse.person_status force row level security;
create policy tenant_isolation on pulse.person_status using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update,delete on pulse.person_status to pulse_worker;

-- Membership: a person's own groups are never touched by the refresh from pods, departments and Google groups.
create or replace function pulse.chat_refresh() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_active() then raise exception 'individual staff account required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtext('chat-members:'||current_org()::text));
 insert into chat_channel(org_id,key,name,kind,description)
 select current_org(),'pod:'||u.id,u.name,'pod','Your pod · confirmed membership in Pulse' from unit u where u.kind='pod' and u.valid_to is null
 on conflict(org_id,key) do update set name=excluded.name where chat_channel.name is distinct from excluded.name;
 insert into chat_channel(org_id,key,name,kind,description)
 select distinct current_org(),'team:'||lower(trim(pp.department)),trim(pp.department),'team','Your team · confirmed membership in Pulse'
 from people_profile pp join person p on p.id=pp.person_id where p.status='active' and p.side='staff' and nullif(trim(pp.department),'') is not null
 on conflict(org_id,key) do nothing;
 insert into chat_channel(org_id,key,name,kind,description,address)
 select current_org(),'group:'||g.address,g.name,'group',case when g.source_kind is null then 'Google group · observed Workspace membership' else 'Google group · membership follows Pulse '||g.source_kind end,g.address from workspace_group g
 on conflict(org_id,key) do update set name=excluded.name,address=excluded.address,description=excluded.description
 where (chat_channel.name,chat_channel.address,chat_channel.description) is distinct from (excluded.name,excluded.address,excluded.description);
 create temporary table if not exists chat_expected(channel_id uuid,person_id uuid,primary key(channel_id,person_id)) on commit drop;
 truncate chat_expected;
 insert into chat_expected
 select ch.id,p.id from chat_channel ch cross join person p join people_profile pp on pp.person_id=p.id
 left join workspace_group g on g.address=ch.address and g.org_id=ch.org_id
 where ch.org_id=current_org() and p.status='active' and p.side='staff' and (
 ch.kind='pod' and exists(select 1 from unit u where 'pod:'||u.id=ch.key and u.valid_to is null and u.name=pp.pod) or
 ch.kind='team' and ch.key='team:'||lower(trim(pp.department)) or
 ch.kind='group' and (g.source_kind='all' or g.source_kind='pod' and pp.pod=g.source_value or g.source_kind='team' and lower(pp.department)=lower(g.source_value) or
 g.source_kind='role' and exists(select 1 from role_assignment r where r.person_id=p.id and r.role_key=any(string_to_array(g.source_value,',')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) or
 g.source_kind is null and exists(select 1 from account a cross join lateral jsonb_array_elements(g.members) m where a.holder_person_id=p.id and not a.is_shared and lower(a.handle)=lower(m->>'email'))));
 insert into chat_member(org_id,channel_id,person_id) select current_org(),channel_id,person_id from chat_expected on conflict do nothing;
 delete from chat_member cm using chat_channel ch where cm.channel_id=ch.id and ch.kind not in('direct','custom')
 and not exists(select 1 from chat_expected e where e.channel_id=cm.channel_id and e.person_id=cm.person_id);
end $$;

-- The live-updates stream and message reads refresh membership at most every half minute; the list refreshes always.
create table pulse.chat_refresh_state (org_id uuid primary key references pulse.org(id), refreshed_at timestamptz not null);
alter table pulse.chat_refresh_state enable row level security;
alter table pulse.chat_refresh_state force row level security;
create policy tenant_isolation on pulse.chat_refresh_state using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
create function pulse.chat_refresh_soon() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_active() then raise exception 'individual staff account required' using errcode='42501'; end if;
 if exists(select 1 from chat_refresh_state where org_id=current_org() and refreshed_at>clock_timestamp()-interval '30 seconds') then return; end if;
 perform chat_refresh();
 insert into chat_refresh_state(org_id,refreshed_at) values(current_org(),clock_timestamp()) on conflict(org_id) do update set refreshed_at=excluded.refreshed_at;
end $$;

-- Custom groups receive notifications like any other conversation their member belongs to.
create or replace function pulse.notification_chat_member_current(p_channel uuid,p_person uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from chat_member cm join chat_channel ch on ch.org_id=cm.org_id and ch.id=cm.channel_id
 join person p on p.org_id=cm.org_id and p.id=cm.person_id join people_profile pp on pp.org_id=p.org_id and pp.person_id=p.id
 left join workspace_group g on g.org_id=ch.org_id and g.address=ch.address
 where cm.org_id=current_org() and cm.channel_id=p_channel and cm.person_id=p_person and p.status='active' and p.side='staff'
 and (ch.kind in('direct','custom')
 or ch.kind='pod' and exists(select 1 from unit u where u.org_id=current_org() and 'pod:'||u.id=ch.key and u.valid_to is null and u.name=pp.pod)
 or ch.kind='team' and ch.key='team:'||lower(trim(pp.department))
 or ch.kind='group' and (g.source_kind='all' or g.source_kind='pod' and pp.pod=g.source_value
 or g.source_kind='team' and lower(pp.department)=lower(g.source_value)
 or g.source_kind='role' and exists(select 1 from role_assignment r where r.org_id=current_org() and r.person_id=p.id
 and r.role_key=any(string_to_array(g.source_value,',')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity'))
 or g.source_kind is null and exists(select 1 from account a cross join lateral jsonb_array_elements(g.members) m
 where a.org_id=current_org() and a.holder_person_id=p.id and not a.is_shared and lower(a.handle)=lower(m->>'email')))))
$$;

-- Notifications: event lines never notify; the author of a quoted message hears it as a reply.
create or replace function pulse.chat_notify_members() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 on conflict do nothing;
 return null;
end $$;

-- Sending with a quote. Attachments: a chat file, a web link, or a task card ({task, name}) for a task the sender sees.
create function pulse.chat_send(p_channel uuid,p_body text,p_parent uuid,p_attachments jsonb,p_client uuid,p_quote uuid) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare mid uuid; prior chat_message%rowtype; tagged uuid[]; a jsonb;
begin
 if not chat_has(p_channel) then raise exception 'conversation unavailable' using errcode='42501'; end if;
 select * into prior from chat_message where author_id=current_viewer() and client_id=p_client;
 if found then
 if prior.channel_id<>p_channel or prior.body<>trim(p_body) or prior.parent_id is distinct from p_parent or prior.attachments<>p_attachments or prior.quote_id is distinct from p_quote then raise exception 'message key already used' using errcode='22023'; end if;
 return prior.id;
 end if;
 if p_body is null or p_attachments is null or length(trim(p_body))>12000 or jsonb_typeof(p_attachments)<>'array' or jsonb_array_length(p_attachments)>5 or (trim(p_body)='' and jsonb_array_length(p_attachments)=0) then raise exception 'write a message or attach a file' using errcode='22023'; end if;
 if p_parent is not null and not exists(select 1 from chat_message where id=p_parent and channel_id=p_channel and parent_id is null and removed_at is null) then raise exception 'thread unavailable' using errcode='22023'; end if;
 if p_quote is not null and not exists(select 1 from chat_message where id=p_quote and channel_id=p_channel and removed_at is null) then raise exception 'the message you replied to is gone' using errcode='22023'; end if;
 for a in select value from jsonb_array_elements(p_attachments) loop
 if jsonb_typeof(a) is distinct from 'object' then raise exception 'attachment unavailable' using errcode='22023'; end if;
 if a ? 'id' then
 if not exists(select 1 from pulse_priv.chat_file f where f.id=(a->>'id')::uuid and f.channel_id=p_channel and f.person_id=current_viewer() and f.name=a->>'name') then raise exception 'attachment unavailable' using errcode='22023'; end if;
 elsif a ? 'task' then
 if not coalesce(a->>'task' ~ '^[0-9a-f-]{36}$' and length(a->>'name') between 1 and 300,false) or not exists(select 1 from task_visible_ids() t where t=(a->>'task')::uuid) then raise exception 'task unavailable' using errcode='22023'; end if;
 elsif not coalesce(a->>'url' ~ '^https?://[^[:space:]]+$' and length(a->>'url')<=2000 and length(a->>'name') between 1 and 200,false) then raise exception 'use a valid sharing link' using errcode='22023'; end if;
 end loop;
 select coalesce(array_agg(pp.person_id),'{}') into tagged from people_profile pp join chat_member cm on cm.person_id=pp.person_id and cm.channel_id=p_channel
 where pp.username in(select (regexp_matches(p_body,'(?:^|[^a-zA-Z0-9._-])@([a-z0-9][a-z0-9._-]*)','g'))[1]);
 insert into chat_message(org_id,channel_id,author_id,body,parent_id,attachments,mentions,client_id,quote_id)
 values(current_org(),p_channel,current_viewer(),trim(p_body),p_parent,p_attachments,tagged,p_client,p_quote) returning id into mid;
 update person_status set last_active_at=clock_timestamp() where org_id=current_org() and person_id=current_viewer();
 return mid;
end $$;

-- Edit within 15 minutes; an author removes their own message within 48 hours. Admin moderation outside DMs stays.
create or replace function pulse.chat_edit(p_message uuid,p_body text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if length(trim(p_body)) not between 1 and 12000 then raise exception 'write a message' using errcode='22023'; end if;
 if exists(select 1 from chat_message where id=p_message and author_id=current_viewer() and kind='text' and removed_at is null and created_at<clock_timestamp()-interval '15 minutes') then
 raise exception 'messages can be edited for 15 minutes after sending' using errcode='22023'; end if;
 update chat_message set body=trim(p_body),edited_at=clock_timestamp(),updated_at=clock_timestamp()
 where id=p_message and author_id=current_viewer() and kind='text' and chat_has(channel_id) and removed_at is null;
 if not found then raise exception 'message unavailable' using errcode='42501'; end if;
end $$;
create or replace function pulse.chat_remove(p_message uuid,p_reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if exists(select 1 from chat_message where id=p_message and author_id=current_viewer() and not viewer_is('admin') and removed_at is null and created_at<clock_timestamp()-interval '48 hours') then
 raise exception 'messages can be deleted for 48 hours after sending' using errcode='22023'; end if;
 update chat_message set body='',attachments='[]',mentions='{}',removed_at=clock_timestamp(),removed_by=current_viewer(),removal_reason=left(p_reason,300),updated_at=clock_timestamp()
 where id=p_message and chat_has(channel_id) and (author_id=current_viewer() or viewer_is('admin')) and removed_at is null;
 if not found then raise exception 'message unavailable' using errcode='42501'; end if;
 perform audit_write('moderate','chat_message',p_message::text,array['removed']);
end $$;
create or replace function pulse.chat_react(p_message uuid,p_emoji text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if p_emoji<>all(array['👍','❤️','😂','😮','😢','🙏','🎉','👀','✅','🙂','🔥']) or not exists(select 1 from chat_message where id=p_message and removed_at is null and chat_has(channel_id)) then raise exception 'message or reaction unavailable' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext(p_message::text||current_viewer()::text||p_emoji));
 delete from chat_reaction where message_id=p_message and person_id=current_viewer() and emoji=p_emoji;
 if not found then insert into chat_reaction(org_id,message_id,person_id,emoji) values(current_org(),p_message,current_viewer(),p_emoji); end if;
end $$;

-- Delivered: everything up to now reached this person's Pulse (the list loaded). Only rows with something new change.
create function pulse.chat_delivered() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_active() then return; end if;
 insert into chat_receipt(org_id,channel_id,person_id,delivered_through)
 select cm.org_id,cm.channel_id,cm.person_id,clock_timestamp() from chat_member cm
 left join chat_receipt r on r.channel_id=cm.channel_id and r.person_id=cm.person_id
 where cm.org_id=current_org() and cm.person_id=current_viewer()
 and exists(select 1 from chat_message m where m.org_id=cm.org_id and m.channel_id=cm.channel_id and m.author_id<>cm.person_id and m.created_at>coalesce(r.delivered_through,'-infinity'))
 on conflict(channel_id,person_id) do update set delivered_through=excluded.delivered_through;
end $$;

create function pulse.chat_pin(p_channel uuid,p_on boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if p_on and (select count(*) from chat_member where org_id=current_org() and person_id=current_viewer() and pinned_at is not null and channel_id<>p_channel)>=5 then
 raise exception 'you can pin up to 5 chats' using errcode='22023'; end if;
 update chat_member set pinned_at=case when p_on then clock_timestamp() end where org_id=current_org() and channel_id=p_channel and person_id=current_viewer();
 if not found then raise exception 'conversation unavailable' using errcode='42501'; end if;
end $$;

-- An event line from Pulse, written as the person who acted.
create function pulse.chat_event_line(p_channel uuid,p_author uuid,p_body text,p_attachments jsonb default '[]') returns uuid
 language sql security definer set search_path=pulse,pg_temp as $$
 insert into chat_message(org_id,channel_id,author_id,body,attachments,client_id,kind) values(current_org(),p_channel,p_author,left(p_body,12000),p_attachments,gen_random_uuid(),'event') returning id
$$;

create function pulse.chat_group_admin(p_channel uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from chat_member cm join chat_channel ch on ch.id=cm.channel_id where cm.org_id=current_org() and cm.channel_id=p_channel
 and cm.person_id=current_viewer() and cm.role='admin' and ch.kind='custom') and chat_active()
$$;
create function pulse.chat_group_create(p_name text,p_members uuid[]) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cid uuid; n text:=regexp_replace(trim(coalesce(p_name,'')),'\s+',' ','g'); added int;
begin
 if not chat_active() then raise exception 'individual staff account required' using errcode='42501'; end if;
 if length(n) not between 2 and 60 then raise exception 'name the group (2 to 60 characters)' using errcode='22023'; end if;
 if coalesce(cardinality(p_members),0)=0 or cardinality(p_members)>256 then raise exception 'add between 1 and 256 people' using errcode='22023'; end if;
 insert into chat_channel(org_id,key,name,kind,description,created_by) values(current_org(),'custom:'||gen_random_uuid(),n,'custom','',current_viewer()) returning id into cid;
 insert into chat_member(org_id,channel_id,person_id,role) values(current_org(),cid,current_viewer(),'admin');
 insert into chat_member(org_id,channel_id,person_id) select current_org(),cid,p.id from person p
 where p.org_id=current_org() and p.id=any(p_members) and p.id<>current_viewer() and p.status='active' and p.side='staff' on conflict do nothing;
 get diagnostics added=row_count;
 if added=0 then raise exception 'add at least one active teammate' using errcode='22023'; end if;
 perform chat_event_line(cid,current_viewer(),'created the group “'||n||'”');
 return cid;
end $$;
create function pulse.chat_group_update(p_channel uuid,p_name text,p_description text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n text:=regexp_replace(trim(coalesce(p_name,'')),'\s+',' ','g'); old text;
begin
 if not chat_group_admin(p_channel) then raise exception 'only a group admin can change the group' using errcode='42501'; end if;
 if length(n) not between 2 and 60 or length(coalesce(p_description,''))>300 then raise exception 'name the group (2 to 60 characters) and keep the description short' using errcode='22023'; end if;
 select name into old from chat_channel where id=p_channel;
 update chat_channel set name=n,description=trim(coalesce(p_description,'')) where id=p_channel;
 if old<>n then perform chat_event_line(p_channel,current_viewer(),'renamed the group to “'||n||'”'); end if;
end $$;
create function pulse.chat_group_members(p_channel uuid,p_add uuid[],p_remove uuid[]) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare who record;
begin
 if not chat_group_admin(p_channel) then raise exception 'only a group admin can change members' using errcode='42501'; end if;
 for who in insert into chat_member(org_id,channel_id,person_id) select current_org(),p_channel,p.id from person p
 where p.org_id=current_org() and p.id=any(coalesce(p_add,'{}')) and p.status='active' and p.side='staff' on conflict do nothing returning person_id loop
 perform chat_event_line(p_channel,current_viewer(),'added '||(select display_name from person where id=who.person_id));
 end loop;
 for who in delete from chat_member where org_id=current_org() and channel_id=p_channel and person_id=any(coalesce(p_remove,'{}')) and person_id<>current_viewer() returning person_id loop
 perform chat_event_line(p_channel,current_viewer(),'removed '||(select display_name from person where id=who.person_id));
 end loop;
end $$;
create function pulse.chat_group_leave(p_channel uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from chat_channel where id=p_channel and kind='custom') or not chat_has(p_channel) then raise exception 'you can leave groups you made or were added to' using errcode='42501'; end if;
 perform chat_event_line(p_channel,current_viewer(),'left');
 delete from chat_member where org_id=current_org() and channel_id=p_channel and person_id=current_viewer();
 -- A group always keeps an admin: the longest-standing member takes over.
 update chat_member set role='admin' where channel_id=p_channel and person_id=(select person_id from chat_member where channel_id=p_channel order by joined_at,person_id limit 1)
 and not exists(select 1 from chat_member where channel_id=p_channel and role='admin');
end $$;
create function pulse.chat_group_photo(p_channel uuid,p_mime text,p_bytes bytea) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_group_admin(p_channel) then raise exception 'only a group admin can change the photo' using errcode='42501'; end if;
 if p_bytes is null then delete from pulse_priv.chat_channel_photo where channel_id=p_channel; update chat_channel set photo_at=null where id=p_channel; return; end if;
 if p_mime not in('image/png','image/jpeg','image/webp') or octet_length(p_bytes) not between 1 and 1048576 then raise exception 'use a PNG, JPEG or WebP photo up to 1 MB' using errcode='22023'; end if;
 insert into pulse_priv.chat_channel_photo(org_id,channel_id,mime,bytes) values(current_org(),p_channel,p_mime,p_bytes)
 on conflict(channel_id) do update set mime=excluded.mime,bytes=excluded.bytes,updated_at=now();
 update chat_channel set photo_at=clock_timestamp() where id=p_channel;
 perform chat_event_line(p_channel,current_viewer(),'changed the group photo');
end $$;
create function pulse.chat_group_photo_read(p_channel uuid) returns table(mime text,bytes bytea) language sql stable security definer set search_path=pulse,pg_temp as $$
 select f.mime,f.bytes from pulse_priv.chat_channel_photo f where f.org_id=current_org() and f.channel_id=p_channel and chat_has(p_channel)
$$;

-- Tasks in chat: follow a task into a chat (its owner, creator or assignee opts in), and post each update there.
create function pulse.chat_task_follow_set(p_task uuid,p_channel uuid,p_on boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_has(p_channel) or not exists(select 1 from chat_member where channel_id=p_channel and person_id=current_viewer()) then raise exception 'conversation unavailable' using errcode='42501'; end if;
 if not exists(select 1 from task where org_id=current_org() and id=p_task and current_viewer() in (owner_id,created_by,assignee_person_id)) then
 raise exception 'only the task owner can post its updates into a chat' using errcode='42501'; end if;
 if p_on then insert into chat_task_follow(org_id,task_id,channel_id,created_by) values(current_org(),p_task,p_channel,current_viewer()) on conflict do nothing;
 else delete from chat_task_follow where org_id=current_org() and task_id=p_task and channel_id=p_channel; end if;
end $$;
create function pulse.chat_task_label(p_status text) returns text language sql immutable as $$
 select case p_status when 'open' then 'To do' when 'in_progress' then 'In progress' when 'in_review' then 'In review' when 'blocked' then 'Blocked'
 when 'done' then 'Done' when 'cancelled' then 'Cancelled' else initcap(replace(p_status,'_',' ')) end
$$;
create function pulse.chat_task_update() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare f record; who uuid; line text;
begin
 if new.status is not distinct from old.status and new.assignee_person_id is not distinct from old.assignee_person_id and new.due_at is not distinct from old.due_at then return null; end if;
 line:=case when new.status is distinct from old.status then 'moved “'||new.title||'” to '||chat_task_label(new.status)
 when new.assignee_person_id is distinct from old.assignee_person_id then 'gave “'||new.title||'” to '||coalesce((select display_name from person where id=new.assignee_person_id),'nobody')
 else 'changed the due date of “'||new.title||'”' end;
 for f in select channel_id from chat_task_follow where org_id=new.org_id and task_id=new.id loop
  -- Written as the person who changed the task when they are in the chat, else as whoever turned the follow on.
  who:=case when exists(select 1 from chat_member where channel_id=f.channel_id and person_id=current_viewer()) then current_viewer()
   else (select created_by from chat_task_follow where task_id=new.id and channel_id=f.channel_id) end;
  if exists(select 1 from chat_member cm join person p on p.id=cm.person_id where cm.channel_id=f.channel_id and cm.person_id=who and p.status='active') then
   perform chat_event_line(f.channel_id,who,line,jsonb_build_array(jsonb_build_object('task',new.id::text,'name',left(new.title,300),'url','/tasks/'||new.id)));
  end if;
 end loop;
 return null;
end $$;
create trigger chat_task_update after update of status,assignee_person_id,due_at on pulse.task for each row execute function pulse.chat_task_update();

-- Presence -------------------------------------------------------------------------------------------------------------
-- Where each active colleague is now, from Pulse data (most specific first): on leave, on a break, on a shoot (a field
-- check-in with a video shoot due today), on duty outside, work from home, in the office, then active in the app
-- (5 minutes), away (an hour), offline. Colleagues see only the category; no times of check-in or kind of leave.
create function pulse.presence_of(p_people uuid[] default null) returns table(person_id uuid,state text,active_at timestamptz,status_text text,status_emoji text,status_until timestamptz,dnd boolean)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 with ppl as (select p.id from person p where p.org_id=current_org() and p.side='staff' and p.status='active' and (p_people is null or p.id=any(p_people))),
 d as (select (now() at time zone 'Asia/Kolkata')::date today),
 open_entry as (select distinct on (e.person_id) e.person_id,e.id,e.mode from attendance_effective e join ppl on ppl.id=e.person_id, d
  where e.org_id=current_org() and e.checked_out_at is null and e.work_date>=d.today-1 order by e.person_id,e.checked_in_at desc),
 on_break as (select b.person_id from attendance_break b join open_entry o on o.id=b.entry_id where b.ended_at is null),
 on_leave as (select distinct l.person_id from leave_request l join ppl on ppl.id=l.person_id, d where l.org_id=current_org() and l.status='approved' and d.today between l.from_date and l.to_date),
 shoot as (select distinct coalesce(t.assignee_person_id,t.owner_id) person_id from task t, d where t.org_id=current_org() and t.deliverable_type='Video shoot'
  and t.status not in('done','cancelled') and (t.work_on=d.today or (t.due_at at time zone 'Asia/Kolkata')::date=d.today)),
 dnd as (select s.person_id,coalesce((s.settings->>'dnd')::boolean,false) or coalesce((s.settings->>'snoozedUntil')::timestamptz,'-infinity')>now() on_dnd
  from companion_notification_settings s join ppl on ppl.id=s.person_id where s.org_id=current_org())
 select ppl.id,
  case when b.person_id is not null then 'break'
   when o.mode='field' and sh.person_id is not null then 'shoot' when o.mode='field' then 'outside' when o.mode='wfh' then 'wfh' when o.mode='office' then 'office'
   when lv.person_id is not null then 'leave'
   when st.last_active_at>now()-interval '5 minutes' then 'active' when st.last_active_at>now()-interval '60 minutes' then 'away' else 'offline' end,
  st.last_active_at,
  case when st.status_until is null or st.status_until>now() then st.status_text end,
  case when st.status_until is null or st.status_until>now() then st.status_emoji end,
  case when st.status_until>now() then st.status_until end,
  coalesce(dn.on_dnd,false)
 from ppl left join open_entry o on o.person_id=ppl.id left join on_break b on b.person_id=ppl.id left join on_leave lv on lv.person_id=ppl.id
 left join shoot sh on sh.person_id=ppl.id left join person_status st on st.org_id=current_org() and st.person_id=ppl.id left join dnd dn on dn.person_id=ppl.id
$$;
-- "I am here": at most one write a minute while Pulse is open and visible.
create function pulse.presence_touch() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_active() then return; end if;
 insert into person_status(org_id,person_id,last_active_at) values(current_org(),current_viewer(),clock_timestamp())
 on conflict(org_id,person_id) do update set last_active_at=excluded.last_active_at where person_status.last_active_at is null or person_status.last_active_at<clock_timestamp()-interval '45 seconds';
end $$;
-- A custom status (text, emoji, until when) and do-not-disturb until a time (null: off; 'infinity': until turned off).
create function pulse.presence_set(p_text text,p_emoji text,p_until timestamptz,p_dnd_until timestamptz) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t text:=nullif(trim(coalesce(p_text,'')),''); e text:=nullif(trim(coalesce(p_emoji,'')),'');
begin
 if not chat_active() then raise exception 'individual staff account required' using errcode='42501'; end if;
 if length(t)>80 or length(e)>16 or p_until<=now() or p_until>now()+interval '31 days' then raise exception 'keep the status under 80 characters and clear it within a month' using errcode='22023'; end if;
 insert into person_status(org_id,person_id,status_text,status_emoji,status_until,updated_at) values(current_org(),current_viewer(),t,e,case when t is null and e is null then null else p_until end,now())
 on conflict(org_id,person_id) do update set status_text=excluded.status_text,status_emoji=excluded.status_emoji,status_until=excluded.status_until,updated_at=now();
 insert into companion_notification_settings(org_id,person_id,settings) values(current_org(),current_viewer(),'{}')
 on conflict(org_id,person_id) do nothing;
 update companion_notification_settings set settings=(settings-'snoozedUntil'-'dnd')||case when p_dnd_until is null or p_dnd_until<=now() then '{}'::jsonb
  when p_dnd_until='infinity' then '{"dnd":true}'::jsonb else jsonb_build_object('snoozedUntil',p_dnd_until) end
 where org_id=current_org() and person_id=current_viewer();
end $$;

revoke all on function pulse.chat_send(uuid,text,uuid,jsonb,uuid,uuid),pulse.chat_delivered(),pulse.chat_pin(uuid,boolean),pulse.chat_event_line(uuid,uuid,text,jsonb),
 pulse.chat_group_admin(uuid),pulse.chat_group_create(text,uuid[]),pulse.chat_group_update(uuid,text,text),pulse.chat_group_members(uuid,uuid[],uuid[]),pulse.chat_group_leave(uuid),
 pulse.chat_group_photo(uuid,text,bytea),pulse.chat_group_photo_read(uuid),pulse.chat_task_follow_set(uuid,uuid,boolean),pulse.chat_task_update(),pulse.chat_refresh_soon(),
 pulse.presence_of(uuid[]),pulse.presence_touch(),pulse.presence_set(text,text,timestamptz,timestamptz) from public;
grant execute on function pulse.chat_send(uuid,text,uuid,jsonb,uuid,uuid),pulse.chat_delivered(),pulse.chat_pin(uuid,boolean),
 pulse.chat_group_admin(uuid),pulse.chat_group_create(text,uuid[]),pulse.chat_group_update(uuid,text,text),pulse.chat_group_members(uuid,uuid[],uuid[]),pulse.chat_group_leave(uuid),
 pulse.chat_group_photo(uuid,text,bytea),pulse.chat_group_photo_read(uuid),pulse.chat_task_follow_set(uuid,uuid,boolean),pulse.chat_refresh_soon(),
 pulse.presence_of(uuid[]),pulse.presence_touch(),pulse.presence_set(text,text,timestamptz,timestamptz) to pulse_api;
grant execute on function pulse.presence_of(uuid[]) to pulse_worker;
-- migrate:down
