-- migrate:up
-- Post-only co-workers use the existing identity; the install operator never assumes a staff identity.
alter table pulse.agent_member add column post_only boolean not null default false;

-- Share agent_create's validation and writes without granting the unchecked helper to runtime roles.
do $$
declare d text;
begin
  d := pg_get_functiondef('pulse.agent_create(jsonb)'::regprocedure);
  d := replace(d, 'FUNCTION pulse.agent_create(', 'FUNCTION pulse.agent_create_record(');
  if position('Admins add AI co-workers' in d) = 0 then raise exception 'agent_create changed shape'; end if;
  d := replace(d, $x$  if agent_session() is not null or not viewer_is('admin') then raise exception 'Admins add AI co-workers' using errcode='42501'; end if;$x$, '');
  if position('Admins add AI co-workers' in d) > 0 then raise exception 'agent_create guard changed shape'; end if;
  execute d;
end $$;
revoke all on function pulse.agent_create_record(jsonb) from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy;
create or replace function pulse.agent_create(p jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if agent_session() is not null or not viewer_is('admin') then raise exception 'Admins add AI co-workers' using errcode='42501'; end if;
  return agent_create_record(p);
end $$;

create or replace function pulse.agent_event_from_chat() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a record;
begin
  if new.kind <> 'text' or new.removed_at is not null or new.author_id is distinct from current_viewer() then return null; end if;
  if exists(select 1 from person where id = new.author_id and side = 'agent') or not agent_leader(new.author_id) then return null; end if;
  for a in
    select m.person_id agent,
           case when ch.kind = 'direct' then 'chat.message' when m.person_id = any(new.mentions) then 'chat.mention' else 'chat.reply' end kind
      from agent_member m join person p on p.id = m.person_id
      join chat_channel ch on ch.id = new.channel_id
      join chat_member cm on cm.channel_id = new.channel_id and cm.person_id = m.person_id
     where m.org_id = new.org_id and not m.post_only and m.disabled_at is null and p.status = 'active'
       and (ch.kind = 'direct' or m.person_id = any(new.mentions)
            or exists(select 1 from chat_message pm where pm.id = coalesce(new.parent_id, new.quote_id) and pm.author_id = m.person_id))
  loop
    insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
    values (new.org_id, a.agent, a.kind, 'message', new.id, 'message:' || new.id, new.author_id) on conflict do nothing;
  end loop;
  return null;
end $$;

create function pulse.operator_agent_chat(p_name text, p_username text, p_chat text, p_member_emails text[]) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid := install_org(); aid uuid; cid uuid; pid uuid; members uuid[] := '{}'; email text; matches uuid[];
        uname text := lower(btrim(coalesce(p_username,''))); chat text := regexp_replace(btrim(coalesce(p_chat,'')), '\s+', ' ', 'g'); ck text;
begin
  if org is null then raise exception 'Install not initialised' using errcode='P0002'; end if;
  perform set_config('pulse.org_id', org::text, true);
  perform set_config('pulse.viewer_id', '', true);
  perform set_config('pulse.agent_session', '', true);
  perform set_config('pulse.actor_account', 'operator', true);
  if length(btrim(coalesce(p_name,''))) not between 1 and 80 or uname !~ '^[a-z0-9][a-z0-9._-]{2,39}$'
     or length(chat) not between 2 and 60 or coalesce(cardinality(p_member_emails),0) not between 1 and 256 then
    raise exception 'Invalid agent, group name or members' using errcode='22023'; end if;
  foreach email in array p_member_emails loop
    select array_agg(distinct p.id) into matches from person p join account a on a.holder_person_id=p.id and a.org_id=p.org_id
      where p.org_id=org and p.side='staff' and chat_current(p.id) and not a.is_shared
        and a.provider='google' and a.purpose='Workspace account' and lower(a.handle)=lower(btrim(email));
    if coalesce(cardinality(matches),0) <> 1 then raise exception 'Each member must resolve to one active individual staff account' using errcode='22023'; end if;
    pid := matches[1];
    if not pid=any(members) then members := array_append(members,pid); end if;
  end loop;
  -- Serialise both username allocation and tuple reuse; reruns never create another identity or group.
  perform pg_advisory_xact_lock(hashtextextended('operator-agent-chat:'||org::text,0));
  select person_id into aid from people_profile where org_id=org and username=uname;
  if aid is null then
    aid := agent_create_record(jsonb_build_object('name',p_name,'username',uname,'ownerId',members[1]));
    update agent_member set post_only=true where person_id=aid and org_id=org;
  elsif not exists(select 1 from agent_member m join person p on p.id=m.person_id
      where m.org_id=org and m.person_id=aid and m.post_only and m.disabled_at is null and p.side='agent' and p.status='active') then
    raise exception 'Username is not an active post-only AI member' using errcode='23505';
  end if;
  ck := 'operator-agent-chat:'||aid::text||':'||encode(sha256(convert_to(chat,'UTF8')),'hex');
  insert into chat_channel(org_id,key,name,kind,created_by) values(org,ck,chat,'custom',members[1])
    on conflict(org_id,key) do nothing returning id into cid;
  if cid is null then select id into cid from chat_channel where org_id=org and key=ck and kind='custom'; end if;
  insert into chat_member(org_id,channel_id,person_id,role)
    select org,cid,m,case when m=members[1] then 'admin' else 'member' end from unnest(members) m
    on conflict(channel_id,person_id) do nothing;
  insert into chat_member(org_id,channel_id,person_id) values(org,cid,aid) on conflict do nothing;
  perform audit_write('operator_agent_chat','chat_channel',cid::text);
  return jsonb_build_object('agentId',aid,'chatId',cid);
end $$;
revoke all on function pulse.operator_agent_chat(text,text,text,text[]) from public;
grant execute on function pulse.operator_agent_chat(text,text,text,text[]) to pulse_api;
-- migrate:down
-- Forward-only. Remove the member from the group and disable it to retire an integration.
