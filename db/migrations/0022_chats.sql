-- migrate:up
-- All messages and files are tenant scoped and member scoped. Audit stores metadata, never message content.
create table pulse.workspace_group (
 org_id uuid not null references pulse.org(id), address text not null, name text not null,
 aliases text[] not null default '{}', members jsonb not null default '[]', observed_at timestamptz not null default now(),
 source_kind text check(source_kind in('all','pod','team','role')), source_value text,
 primary key(org_id,address)
);
create table pulse.workspace_alias (
 org_id uuid not null references pulse.org(id), address text not null, primary_address text not null,
 kind text not null check(kind in('user','group')), observed_at timestamptz not null default now(), primary key(org_id,address)
);
create table pulse.chat_channel (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 key text not null, name text not null, kind text not null check(kind in('pod','team','group','direct')),
 description text not null default '', address text, created_at timestamptz not null default now(),
 unique(org_id,key), unique(org_id,id)
);
create table pulse.chat_member (
 org_id uuid not null, channel_id uuid not null, person_id uuid not null references pulse.person(id),
 read_through timestamptz not null default '-infinity', joined_at timestamptz not null default now(),
 primary key(channel_id,person_id), foreign key(org_id,channel_id) references pulse.chat_channel(org_id,id) on delete cascade
);
create table pulse.chat_message (
 org_id uuid not null, id uuid primary key default gen_random_uuid(), channel_id uuid not null,
 author_id uuid not null references pulse.person(id), body text not null check(length(body)<=12000),
 parent_id uuid references pulse.chat_message(id), attachments jsonb not null default '[]', mentions uuid[] not null default '{}',
 client_id uuid not null, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 edited_at timestamptz, removed_at timestamptz, removed_by uuid, removal_reason text,
 unique(org_id,author_id,client_id), unique(org_id,id), foreign key(org_id,channel_id) references pulse.chat_channel(org_id,id)
);
create index chat_message_channel on pulse.chat_message(org_id,channel_id,created_at desc);
create index chat_message_thread on pulse.chat_message(org_id,parent_id,created_at);
create index chat_message_search on pulse.chat_message using gin(to_tsvector('simple',body));
create table pulse.chat_reaction (
 org_id uuid not null, message_id uuid not null, person_id uuid not null references pulse.person(id), emoji text not null,
 created_at timestamptz not null default clock_timestamp(), primary key(message_id,person_id,emoji),
 foreign key(org_id,message_id) references pulse.chat_message(org_id,id) on delete cascade
);
create table pulse.chat_event (
 org_id uuid not null, seq bigint generated always as identity primary key, channel_id uuid not null,
 at timestamptz not null default clock_timestamp(), foreign key(org_id,channel_id) references pulse.chat_channel(org_id,id) on delete cascade
);
create index chat_event_channel on pulse.chat_event(org_id,channel_id,seq desc);
create table pulse_priv.chat_file (
 org_id uuid not null, id uuid primary key default gen_random_uuid(), channel_id uuid not null,
 person_id uuid not null references pulse.person(id), name text not null, mime text not null, bytes bytea not null check(octet_length(bytes)<=5242880),
 created_at timestamptz not null default now(), foreign key(org_id,channel_id) references pulse.chat_channel(org_id,id)
);
do $$ declare t text; begin
 foreach t in array array['workspace_group','workspace_alias','chat_channel','chat_member','chat_message','chat_reaction','chat_event'] loop
 execute format('alter table pulse.%I enable row level security',t);
 execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant_isolation on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 execute format('grant select,insert,update,delete on pulse.%I to pulse_worker',t);
 execute format('grant select on pulse.%I to pulse_api',t);
 if t<>'chat_event' then
 execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()',t);
 end if;
 end loop;
end $$;
grant usage on sequence pulse.chat_event_seq_seq to pulse_worker;
grant update(source_kind,source_value) on pulse.workspace_group to pulse_api;
create policy mapping_write on pulse.workspace_group as restrictive for update to pulse_api using(pulse.viewer_is('admin')) with check(pulse.viewer_is('admin'));
alter table pulse_priv.chat_file enable row level security;
alter table pulse_priv.chat_file force row level security;
create policy tenant_isolation on pulse_priv.chat_file using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update,delete on pulse_priv.chat_file to pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse_priv.chat_file for each row execute function pulse.audit_mutation();
create function pulse.chat_has(p_channel uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from chat_member cm join person p on p.id=cm.person_id
 where cm.org_id=current_org() and cm.channel_id=p_channel and cm.person_id=current_viewer() and p.status='active' and p.side='staff')
$$;
create function pulse.chat_active() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from person where id=current_viewer() and status='active' and side='staff')
$$;
do $$ declare t text; begin
 foreach t in array array['chat_channel','chat_member','chat_message','chat_event'] loop
 execute format('create policy member_read on pulse.%I as restrictive for select to pulse_api using(pulse.chat_has(%I))',t,case when t='chat_channel' then 'id' else 'channel_id' end);
 end loop;
end $$;
create policy reaction_read on pulse.chat_reaction as restrictive for select to pulse_api
 using(exists(select 1 from pulse.chat_message m where m.id=message_id));
create policy directory_read on pulse.workspace_group as restrictive for select to pulse_api using(pulse.chat_active());
create policy directory_read on pulse.workspace_alias as restrictive for select to pulse_api using(pulse.chat_active());

-- Refresh membership from confirmed Pulse pods/teams and observed directory groups. DMs keep their participants.
create function pulse.chat_refresh() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
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
 delete from chat_member cm using chat_channel ch where cm.channel_id=ch.id and ch.kind<>'direct'
 and not exists(select 1 from chat_expected e where e.channel_id=cm.channel_id and e.person_id=cm.person_id);
end $$;
create function pulse.chat_direct(p_person uuid) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cid uuid; k text;
begin
 if not chat_active() or p_person=current_viewer() or not exists(select 1 from person where id=p_person and status='active' and side='staff') then raise exception 'choose an active teammate' using errcode='22023'; end if;
 k:='dm:'||least(current_viewer()::text,p_person::text)||':'||greatest(current_viewer()::text,p_person::text);
 insert into chat_channel(org_id,key,name,kind,description) values(current_org(),k,'Direct message','direct','A private conversation')
 on conflict(org_id,key) do update set key=excluded.key returning id into cid;
 insert into chat_member(org_id,channel_id,person_id) values(current_org(),cid,current_viewer()),(current_org(),cid,p_person) on conflict do nothing;
 return cid;
end $$;
create function pulse.chat_touch() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cid uuid;
begin
 if TG_TABLE_NAME='chat_message' then cid:=case when TG_OP='DELETE' then old.channel_id else new.channel_id end;
 else select channel_id into cid from chat_message where id=case when TG_OP='DELETE' then old.message_id else new.message_id end; end if;
 if cid is not null then insert into chat_event(org_id,channel_id) values(current_org(),cid); end if;
 return null;
end $$;
create trigger chat_touch after insert or update or delete on pulse.chat_message for each row execute function pulse.chat_touch();
create trigger chat_touch after insert or delete on pulse.chat_reaction for each row execute function pulse.chat_touch();
create function pulse.chat_send(p_channel uuid,p_body text,p_parent uuid,p_attachments jsonb,p_client uuid) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare mid uuid; prior chat_message%rowtype; tagged uuid[]; a jsonb; target record;
begin
 if not chat_has(p_channel) then raise exception 'conversation unavailable' using errcode='42501'; end if;
 select * into prior from chat_message where author_id=current_viewer() and client_id=p_client;
 if found then
 if prior.channel_id<>p_channel or prior.body<>trim(p_body) or prior.parent_id is distinct from p_parent or prior.attachments<>p_attachments then raise exception 'message key already used' using errcode='22023'; end if;
 return prior.id;
 end if;
 if length(trim(p_body))>12000 or jsonb_typeof(p_attachments)<>'array' or jsonb_array_length(p_attachments)>5 or (trim(p_body)='' and jsonb_array_length(p_attachments)=0) then raise exception 'write a message or attach a file' using errcode='22023'; end if;
 if p_parent is not null and not exists(select 1 from chat_message where id=p_parent and channel_id=p_channel and parent_id is null and removed_at is null) then raise exception 'thread unavailable' using errcode='22023'; end if;
 for a in select value from jsonb_array_elements(p_attachments) loop
 if a ? 'id' then
 if not exists(select 1 from pulse_priv.chat_file f where f.id=(a->>'id')::uuid and f.channel_id=p_channel and f.person_id=current_viewer() and f.name=a->>'name') then raise exception 'attachment unavailable' using errcode='22023'; end if;
 elsif not (a->>'url' ~ '^https?://[^[:space:]]+$' and length(a->>'url')<=2000 and length(a->>'name') between 1 and 200) then raise exception 'use a valid sharing link' using errcode='22023'; end if;
 end loop;
 select coalesce(array_agg(pp.person_id),'{}') into tagged from people_profile pp join chat_member cm on cm.person_id=pp.person_id and cm.channel_id=p_channel
 where pp.username in(select (regexp_matches(p_body,'(?:^|[^a-zA-Z0-9._-])@([a-z0-9][a-z0-9._-]*)','g'))[1]);
 insert into chat_message(org_id,channel_id,author_id,body,parent_id,attachments,mentions,client_id)
 values(current_org(),p_channel,current_viewer(),trim(p_body),p_parent,p_attachments,tagged,p_client) returning id into mid;
 -- Generic in-app notifications only. Telegram and WhatsApp are deliberately deferred.
 for target in select cm.person_id from chat_member cm join person p on p.id=cm.person_id
 where cm.channel_id=p_channel and cm.person_id<>current_viewer() and p.status='active' and
 (cm.person_id=any(tagged) or exists(select 1 from chat_channel where id=p_channel and kind='direct') or
 p_parent is not null and exists(select 1 from chat_message m where (m.id=p_parent or m.parent_id=p_parent) and m.author_id=cm.person_id)) loop
 insert into notification(org_id,person_id,title,href) values(current_org(),target.person_id,
 case when target.person_id=any(tagged) then 'You were mentioned in Chats' else 'New message in Chats' end,
 '/chats?channel='||p_channel);
 end loop;
 return mid;
end $$;
create function pulse.chat_edit(p_message uuid,p_body text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if length(trim(p_body)) not between 1 and 12000 then raise exception 'write a message' using errcode='22023'; end if;
 update chat_message set body=trim(p_body),edited_at=clock_timestamp(),updated_at=clock_timestamp()
 where id=p_message and author_id=current_viewer() and chat_has(channel_id) and removed_at is null;
 if not found then raise exception 'message unavailable' using errcode='42501'; end if;
end $$;
create function pulse.chat_remove(p_message uuid,p_reason text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 update chat_message set body='',attachments='[]',mentions='{}',removed_at=clock_timestamp(),removed_by=current_viewer(),removal_reason=left(p_reason,300),updated_at=clock_timestamp()
 where id=p_message and chat_has(channel_id) and (author_id=current_viewer() or viewer_is('admin')) and removed_at is null;
 if not found then raise exception 'message unavailable' using errcode='42501'; end if;
 perform audit_write('moderate','chat_message',p_message::text,array['removed']);
end $$;
create function pulse.chat_react(p_message uuid,p_emoji text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if p_emoji<>all(array['👍','❤️','🎉','👀','✅','🙂']) or not exists(select 1 from chat_message where id=p_message and removed_at is null and chat_has(channel_id)) then raise exception 'message or reaction unavailable' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtext(p_message::text||current_viewer()::text||p_emoji));
 delete from chat_reaction where message_id=p_message and person_id=current_viewer() and emoji=p_emoji;
 if not found then insert into chat_reaction(org_id,message_id,person_id,emoji) values(current_org(),p_message,current_viewer(),p_emoji); end if;
end $$;
create function pulse.chat_read(p_channel uuid,p_through timestamptz) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_has(p_channel) then raise exception 'conversation unavailable' using errcode='42501'; end if;
 update chat_member set read_through=greatest(read_through,least(p_through,clock_timestamp())) where channel_id=p_channel and person_id=current_viewer() and read_through<p_through;
end $$;
create function pulse.chat_file_add(p_channel uuid,p_name text,p_mime text,p_bytes bytea) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare fid uuid;
begin
 if not chat_has(p_channel) then raise exception 'conversation unavailable' using errcode='42501'; end if;
 if length(p_name) not between 1 and 200 or octet_length(p_bytes) not between 1 and 5242880 then raise exception 'file limit is 5 MB' using errcode='22023'; end if;
 insert into pulse_priv.chat_file(org_id,channel_id,person_id,name,mime,bytes) values(current_org(),p_channel,current_viewer(),p_name,p_mime,p_bytes) returning id into fid;
 return fid;
end $$;
create function pulse.chat_file_read(p_file uuid) returns table(name text,mime text,bytes bytea) language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 return query select f.name,f.mime,f.bytes from pulse_priv.chat_file f where f.id=p_file and chat_has(f.channel_id) and
 (f.person_id=current_viewer() or exists(select 1 from chat_message m where m.channel_id=f.channel_id and m.removed_at is null and m.attachments @> jsonb_build_array(jsonb_build_object('id',p_file::text))));
 perform audit_write('download','chat_file',p_file::text);
end $$;
-- Daily worker retention erases bodies/files; the metadata audit remains.
create function pulse.chat_prune() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 delete from pulse_priv.chat_file f where f.created_at<now()-interval '365 days' or f.created_at<now()-interval '1 day' and not exists(select 1 from chat_message m where m.attachments @> jsonb_build_array(jsonb_build_object('id',f.id::text)));
 -- Remove replies before roots to respect the self reference, including newer replies to expired roots.
 delete from chat_message where parent_id in(select id from chat_message where created_at<now()-interval '365 days');
 delete from chat_message where created_at<now()-interval '365 days';get diagnostics n=row_count;
 delete from chat_event where at<now()-interval '365 days';
 return n;
end $$;
revoke all on function pulse.chat_has(uuid),pulse.chat_active(),pulse.chat_refresh(),pulse.chat_direct(uuid),pulse.chat_touch(),
 pulse.chat_send(uuid,text,uuid,jsonb,uuid),pulse.chat_edit(uuid,text),pulse.chat_remove(uuid,text),pulse.chat_react(uuid,text),pulse.chat_read(uuid,timestamptz),
 pulse.chat_file_add(uuid,text,text,bytea),pulse.chat_file_read(uuid),pulse.chat_prune() from public;
grant execute on function pulse.chat_has(uuid),pulse.chat_active(),pulse.chat_refresh(),pulse.chat_direct(uuid),
 pulse.chat_send(uuid,text,uuid,jsonb,uuid),pulse.chat_edit(uuid,text),pulse.chat_remove(uuid,text),pulse.chat_react(uuid,text),pulse.chat_read(uuid,timestamptz),
 pulse.chat_file_add(uuid,text,text,bytea),pulse.chat_file_read(uuid) to pulse_api;
grant execute on function pulse.chat_prune() to pulse_worker;
-- migrate:down
