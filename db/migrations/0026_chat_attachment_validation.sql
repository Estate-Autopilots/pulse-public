-- migrate:up
create or replace function pulse.chat_send(p_channel uuid,p_body text,p_parent uuid,p_attachments jsonb,p_client uuid) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare mid uuid; prior chat_message%rowtype; tagged uuid[]; a jsonb; target record;
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

-- migrate:down
-- Keep stricter validation on rollback; no data changes.
