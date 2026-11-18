-- migrate:up
-- A post-only service credential borrows one existing AI identity, never a staff viewer.
alter table pulse_priv.service_key add column agent_id uuid references pulse.agent_member(person_id);
alter table pulse_priv.service_key drop constraint service_key_scopes_check;
alter table pulse_priv.service_key add constraint service_key_scopes_check check(cardinality(scopes)>0
 and array_position(scopes,null) is null and scopes <@ array['catalog.read','clients.read','leads.read','quotes.draft.create','notify.quote_ready','chats.post']);
alter table pulse_priv.service_key add constraint service_key_agent_check check(('chats.post'=any(scopes))=(agent_id is not null));

drop function pulse.service_key_manage(text,uuid,text,text[],text);
create function pulse.service_key_manage(p_action text,p_id uuid,p_hash text default null,p_scopes text[] default null,p_label text default null,p_agent uuid default null) returns void
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid:=install_org();
begin
 if org is null then raise exception 'Install not initialised' using errcode='P0002'; end if;
 perform set_config('pulse.org_id',org::text,true);
 if p_action='issue' then
  if p_agent is not null and not exists(select 1 from agent_member a join person p on p.id=a.person_id
   where a.person_id=p_agent and a.org_id=org and p.org_id=org and a.disabled_at is null and p.side='agent' and p.status='active')
   then raise exception 'An active install-local AI member is required' using errcode='42501'; end if;
  insert into pulse_priv.service_key(id,org_id,key_hash,scopes,label,agent_id) values(p_id,org,p_hash,p_scopes,p_label,p_agent);
 elsif p_action='revoke' and p_hash is null and p_scopes is null and p_label is null and p_agent is null then
  update pulse_priv.service_key set revoked_at=coalesce(revoked_at,now()) where id=p_id and org_id=org;
 else raise exception 'Invalid service key action' using errcode='22023'; end if;
 perform set_config('pulse.actor_account','operator',true);
 perform audit_write('service_key_'||p_action,'service_key',p_id::text);
end $$;
create or replace function pulse.service_key_list() returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'scopes',scopes,'agentId',agent_id,'createdAt',created_at,
  'revokedAt',revoked_at,'lastUsedAt',date_trunc('minute',last_used_at)) order by created_at desc,id),'[]'::jsonb)
  from pulse_priv.service_key where org_id=install_org());
end $$;

create function pulse.service_chat_post(p_key uuid,p_channel uuid,p_slot text,p_text text,p_name text,p_mime text,p_bytes bytea) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare agent uuid; cid uuid; mid uuid; fid uuid; prior chat_message; files jsonb:='[]';
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_key::text then
  raise exception 'Service scope required' using errcode='42501'; end if;
 select k.agent_id into agent from pulse_priv.service_key k join agent_member a on a.person_id=k.agent_id join person p on p.id=a.person_id
  where k.id=p_key and k.org_id=install_org() and k.org_id=current_org() and k.revoked_at is null and 'chats.post'=any(k.scopes)
   and a.org_id=k.org_id and a.disabled_at is null and p.org_id=k.org_id and p.side='agent' and p.status='active' for share of k,a,p;
 if agent is null then raise exception 'Active AI member and chat scope required' using errcode='42501'; end if;
 if p_slot is null or p_slot !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-(am|pm)$' or left(p_slot,10)::date::text<>left(p_slot,10)
  or p_text is null or length(trim(p_text)) not between 1 and 12000 then raise exception 'Invalid slot or text' using errcode='22023'; end if;
 if p_bytes is not null then
  if not coalesce(length(p_name) between 1 and 200 and octet_length(p_bytes) between 1 and 2097152 and
   ((p_mime='image/png' and substring(p_bytes from 1 for 8)=decode('89504e470d0a1a0a','hex')) or
    (p_mime='image/jpeg' and substring(p_bytes from 1 for 3)=decode('ffd8ff','hex'))),false)
   then raise exception 'Use a PNG or JPEG image up to 2 MiB' using errcode='22023'; end if;
 elsif p_name is not null or p_mime is not null then raise exception 'Image bytes required' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('chats.post:'||agent||':'||p_slot,0));
 cid:=substr(encode(sha256(convert_to('chats.post:'||agent||':'||p_slot,'UTF8')),'hex'),1,32)::uuid;
 perform set_config('pulse.viewer_id',agent::text,true);
 perform set_config('pulse.agent_session','on',true);
 -- Membership is checked even on replay, including after the AI member has been removed.
 if not chat_has(p_channel) then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 select * into prior from chat_message where org_id=current_org() and author_id=agent and client_id=cid;
 if found then
  if prior.channel_id<>p_channel or prior.body<>trim(p_text) or
   (p_bytes is null and prior.attachments<>'[]'::jsonb) or (p_bytes is not null and not exists(
    select 1 from pulse_priv.chat_file f where f.id=(prior.attachments->0->>'id')::uuid and f.org_id=current_org()
     and f.channel_id=p_channel and f.person_id=agent and f.name=p_name and f.mime=p_mime and f.bytes=p_bytes)) then
   raise exception 'Slot already used for another message' using errcode='23505'; end if;
  mid:=prior.id;
 else
  if p_bytes is not null then
   fid:=chat_file_add(p_channel,p_name,p_mime,p_bytes);
   files:=jsonb_build_array(jsonb_build_object('id',fid,'name',p_name));
  end if;
  mid:=chat_send(p_channel,p_text,null,files,cid,null);
 end if;
 return jsonb_build_object('messageId',mid,'chatId',p_channel,'replayed',prior.id is not null);
end $$;
revoke all on function pulse.service_key_manage(text,uuid,text,text[],text,uuid),pulse.service_chat_post(uuid,uuid,text,text,text,text,bytea) from public;
grant execute on function pulse.service_key_manage(text,uuid,text,text[],text,uuid),pulse.service_chat_post(uuid,uuid,text,text,text,text,bytea) to pulse_api;
-- migrate:down
-- Forward-only; revoke service credentials to disable posting.
