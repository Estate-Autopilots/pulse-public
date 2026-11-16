-- migrate:up
-- R27/R29 first slice: the existing inbox is the one event source for every surface.
alter table pulse.notification add column kind text not null default 'update';
alter table pulse.notification add column channel_id uuid;
alter table pulse.notification add column message_id uuid;
update pulse.notification set channel_id=substring(href from '^/chats\?channel=([0-9a-f-]{36})')::uuid,kind=case when title ilike '%mentioned%' then 'mention' else 'chat' end
 where href ~ '^/chats\?channel=[0-9a-f-]{36}(&|$)';
alter table pulse.notification alter column created_at set default clock_timestamp();
create unique index notification_chat_once on pulse.notification(org_id,person_id,message_id) where message_id is not null;
create index notification_feed on pulse.notification(org_id,person_id,created_at);
create function pulse.notification_kind() returns trigger language plpgsql set search_path=pulse,pg_temp as $$
begin
 if new.kind='update' then
 new.kind:=case when new.title ilike '%mentioned%' then 'mention' when new.href like '/chats?%' then 'chat'
 when new.title ilike '%approved%' or new.title ilike '%rejected%' or new.title ilike '%cancelled%' then 'decision'
 when new.href like '/me/approvals%' or new.title ilike '%waiting%' or new.title ilike '%approval%' then 'approval'
 when new.title ilike '%payroll%' then 'payroll' when new.title ilike '%holiday%' then 'holiday'
 when new.title ilike '%policy%' then 'policy' when new.title ilike '%assigned%' then 'task' else 'update' end;
 end if;return new;
end $$;
create trigger notification_kind before insert on pulse.notification for each row execute function pulse.notification_kind();
create function pulse.chat_notify_members() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 insert into notification(org_id,person_id,title,href,kind,channel_id,message_id)
 select new.org_id,cm.person_id,
 case when cm.person_id=any(new.mentions) then 'You were mentioned in Chats' else 'New message in Chats' end,
 '/chats?channel='||new.channel_id||case when new.parent_id is null then '' else '&thread='||new.parent_id end,
 case when cm.person_id=any(new.mentions) then 'mention' when new.parent_id is not null then 'reply' else 'chat' end,
 new.channel_id,new.id
 from chat_member cm join person p on p.id=cm.person_id and p.org_id=cm.org_id
 where cm.org_id=new.org_id and cm.channel_id=new.channel_id and cm.person_id<>new.author_id and p.status='active'
 on conflict do nothing;
 return null;
end $$;
create trigger chat_notify_members after insert on pulse.chat_message for each row execute function pulse.chat_notify_members();
revoke all on function pulse.notification_kind(),pulse.chat_notify_members() from public;
create or replace function pulse.chat_send(p_channel uuid,p_body text,p_parent uuid,p_attachments jsonb,p_client uuid) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare mid uuid; prior chat_message%rowtype; tagged uuid[]; a jsonb;
begin
 if not chat_has(p_channel) then raise exception 'conversation unavailable' using errcode='42501'; end if;
 select * into prior from chat_message where author_id=current_viewer() and client_id=p_client;
 if found then
 if prior.channel_id<>p_channel or prior.body<>trim(p_body) or prior.parent_id is distinct from p_parent or prior.attachments<>p_attachments then raise exception 'message key already used' using errcode='22023'; end if;
 return prior.id;
 end if;
 if p_body is null or p_attachments is null or length(trim(p_body))>12000 or jsonb_typeof(p_attachments)<>'array' or jsonb_array_length(p_attachments)>5 or (trim(p_body)='' and jsonb_array_length(p_attachments)=0) then raise exception 'write a message or attach a file' using errcode='22023'; end if;
 if p_parent is not null and not exists(select 1 from chat_message where id=p_parent and channel_id=p_channel and parent_id is null and removed_at is null) then raise exception 'thread unavailable' using errcode='22023'; end if;
 for a in select value from jsonb_array_elements(p_attachments) loop
 if jsonb_typeof(a) is distinct from 'object' then raise exception 'attachment unavailable' using errcode='22023'; end if;
 if a ? 'id' then
 if not exists(select 1 from pulse_priv.chat_file f where f.id=(a->>'id')::uuid and f.channel_id=p_channel and f.person_id=current_viewer() and f.name=a->>'name') then raise exception 'attachment unavailable' using errcode='22023'; end if;
 elsif not coalesce(a->>'url' ~ '^https?://[^[:space:]]+$' and length(a->>'url')<=2000 and length(a->>'name') between 1 and 200,false) then raise exception 'use a valid sharing link' using errcode='22023'; end if;
 end loop;
 select coalesce(array_agg(pp.person_id),'{}') into tagged from people_profile pp join chat_member cm on cm.person_id=pp.person_id and cm.channel_id=p_channel
 where pp.username in(select (regexp_matches(p_body,'(?:^|[^a-zA-Z0-9._-])@([a-z0-9][a-z0-9._-]*)','g'))[1]);
 insert into chat_message(org_id,channel_id,author_id,body,parent_id,attachments,mentions,client_id)
 values(current_org(),p_channel,current_viewer(),trim(p_body),p_parent,p_attachments,tagged,p_client) returning id into mid;
 return mid;
end $$;


-- Confirmed user actions publish generic inbox entries, never draft/import payloads.
create function pulse.companion_work_update() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare target uuid;
begin
 if current_viewer() is null then return null;end if;
 if TG_TABLE_NAME='task' then
  target:=coalesce(new.owner_id,new.assignee_person_id);
  if target is null or TG_OP='UPDATE' and target is not distinct from coalesce(old.owner_id,old.assignee_person_id) then return null;end if;
  insert into notification(org_id,person_id,title,href,kind)
  select new.org_id,p.id,'A task was assigned to you','/tasks?task='||new.id,'task' from person p where p.id=target and p.org_id=new.org_id and p.status='active';
 elsif TG_TABLE_NAME='policy_document' then
  if new.status<>'published' or TG_OP='UPDATE' and old.status='published' then return null;end if;
  insert into notification(org_id,person_id,title,href,kind)
  select new.org_id,p.id,'A policy update is ready','/me?tab=policies&kind='||new.kind,'policy' from person p where p.org_id=new.org_id and p.side='staff' and p.status='active';
 elsif TG_TABLE_NAME='holiday' then
  if TG_OP='UPDATE' and (new.name,new.optional) is not distinct from (old.name,old.optional) then return null;end if;
  insert into notification(org_id,person_id,title,href,kind)
  select new.org_id,p.id,'The holiday list was updated','/me?tab=leave','holiday' from person p where p.org_id=new.org_id and p.side='staff' and p.status='active';
 end if;return null;
end $$;
create trigger companion_task_update after insert or update of owner_id,assignee_person_id on pulse.task for each row execute function pulse.companion_work_update();
create trigger companion_policy_update after insert or update of status on pulse.policy_document for each row execute function pulse.companion_work_update();
create trigger companion_holiday_update after insert or update on pulse.holiday for each row execute function pulse.companion_work_update();
revoke all on function pulse.companion_work_update() from public;

-- Reading a conversation synchronizes its corresponding inbox receipts on every device.
create or replace function pulse.chat_read(p_channel uuid,p_through timestamptz) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_has(p_channel) then raise exception 'conversation unavailable' using errcode='42501';end if;
 update chat_member set read_through=greatest(read_through,least(p_through,clock_timestamp()))
 where channel_id=p_channel and person_id=current_viewer() and read_through<p_through;
 update notification n set read_at=coalesce(n.read_at,clock_timestamp())
 from chat_message m,chat_member cm
 where n.message_id=m.id and n.person_id=current_viewer() and n.channel_id=p_channel
 and cm.channel_id=p_channel and cm.person_id=current_viewer() and m.created_at<=cm.read_through and n.read_at is null;
end $$;

-- Reuse native's per-device outbox for reliable local-app receipt, independent of event timestamps.
alter table pulse.native_push_delivery add column app_received_at timestamptz;
grant select on pulse.native_push_delivery to pulse_api;
create policy own_device on pulse.native_push_delivery as restrictive to pulse_api using(exists(
 select 1 from pulse.native_device d where d.id=device_id and d.person_id=pulse.current_viewer() and d.revoked_at is null));
create function pulse.companion_queue_local(dev uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from native_device where id=dev and person_id=current_viewer() and revoked_at is null and platform in ('windows','macos','chrome')) then raise exception 'Your active desktop device required' using errcode='42501';end if;
 insert into native_push_delivery(org_id,notification_id,device_id)
 select n.org_id,n.id,dev from notification n join native_device d on d.id=dev
 where n.person_id=current_viewer() and n.read_at is null and n.created_at>=d.created_at and n.created_at>now()-interval '48 hours'
 and (n.channel_id is null or exists(select 1 from chat_member cm where cm.channel_id=n.channel_id and cm.person_id=current_viewer()))
 on conflict do nothing;
end $$;
create function pulse.companion_ack_local(dev uuid,ids uuid[]) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not exists(select 1 from native_device where id=dev and person_id=current_viewer() and revoked_at is null and platform in ('windows','macos','chrome')) then raise exception 'Your active desktop device required' using errcode='42501';end if;
 if coalesce(cardinality(ids),0)>200 then raise exception 'Receipt batch too large' using errcode='22023';end if;
 update native_push_delivery q set app_received_at=coalesce(q.app_received_at,clock_timestamp())
 from notification n where q.notification_id=n.id and q.device_id=dev and n.person_id=current_viewer() and n.id=any(ids);
end $$;
revoke all on function pulse.companion_queue_local(uuid),pulse.companion_ack_local(uuid,uuid[]) from public;
grant execute on function pulse.companion_queue_local(uuid),pulse.companion_ack_local(uuid,uuid[]) to pulse_api;

create table pulse.companion_notification_settings (
 org_id uuid not null references pulse.org(id), person_id uuid not null references pulse.person(id),
 settings jsonb not null default '{}',primary key(org_id,person_id)
);
create table pulse.web_push_subscription (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),endpoint text not null,keys jsonb not null,
 created_at timestamptz not null default clock_timestamp(),disabled_at timestamptz,unique(org_id,endpoint)
);
create table pulse.web_push_delivery (
 org_id uuid not null references pulse.org(id),notification_id uuid not null references pulse.notification(id),
 subscription_id uuid not null references pulse.web_push_subscription(id),attempts int not null default 0,
 retry_at timestamptz not null default now(),status text not null default 'queued',primary key(notification_id,subscription_id)
);
do $$declare t text;begin foreach t in array array['companion_notification_settings','web_push_subscription','web_push_delivery'] loop
 execute format('alter table pulse.%I enable row level security',t);
 execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('grant select,insert,update on pulse.%I to pulse_worker',t);
 end loop;end $$;
create policy self on pulse.companion_notification_settings as restrictive to pulse_api using(person_id=pulse.current_viewer()) with check(person_id=pulse.current_viewer());
create policy self on pulse.web_push_subscription as restrictive to pulse_api using(person_id=pulse.current_viewer()) with check(person_id=pulse.current_viewer());
grant select,insert,update on pulse.companion_notification_settings,pulse.web_push_subscription to pulse_api;

create function pulse.web_push_enroll(p_endpoint text,p_keys jsonb) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_active() then raise exception 'individual staff account required' using errcode='42501';end if;
 insert into web_push_subscription(org_id,person_id,endpoint,keys) values(current_org(),current_viewer(),p_endpoint,p_keys)
 on conflict(org_id,endpoint) do update set person_id=excluded.person_id,keys=excluded.keys,disabled_at=null,created_at=clock_timestamp();
end $$;
revoke all on function pulse.web_push_enroll(text,jsonb) from public;
grant execute on function pulse.web_push_enroll(text,jsonb) to pulse_api;
-- migrate:down
-- Keep event receipts and member delivery semantics on rollback.
