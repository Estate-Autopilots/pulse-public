-- migrate:up
-- POLISH-1: a group's members are the people the roster still counts. Status alone missed anyone the roster marks as
-- gone another way: a lifecycle stage of left, an end date (active_to) or a last working day already past. Such people
-- leave pods, teams and Google groups at the next refresh (kept as former members), and member counts, member lists
-- and read receipts skip them in every conversation, custom groups included. Colleagues learn only current or not.
create function pulse.chat_current(p_person uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from person p where p.org_id=current_org() and p.id=p_person and p.status='active'
  and (p.active_to is null or p.active_to>=lifecycle_today())
  and not exists(select 1 from person_lifecycle l where l.org_id=p.org_id and l.person_id=p.id and l.stage='left')
  and not exists(select 1 from hr_employment e where e.org_id=p.org_id and e.person_id=p.id and e.last_working_day<lifecycle_today()))
$$;
revoke all on function pulse.chat_current(uuid) from public;
grant execute on function pulse.chat_current(uuid) to pulse_api,pulse_worker;
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
 where ch.org_id=current_org() and p.side='staff' and chat_current(p.id)
 and not exists(select 1 from person_lifecycle l where l.person_id=p.id and l.groups_left_at is not null) and (
 ch.kind='pod' and exists(select 1 from unit u where 'pod:'||u.id=ch.key and u.valid_to is null and u.name=pp.pod) or
 ch.kind='team' and ch.key='team:'||lower(trim(pp.department)) or
 ch.kind='group' and (g.source_kind='all' or g.source_kind='pod' and pp.pod=g.source_value or g.source_kind='team' and lower(pp.department)=lower(g.source_value) or
 g.source_kind='role' and exists(select 1 from role_assignment r where r.person_id=p.id and r.role_key=any(string_to_array(g.source_value,',')) and current_date between r.valid_from and coalesce(r.valid_to,'infinity')) or
 g.source_kind is null and exists(select 1 from account a cross join lateral jsonb_array_elements(g.members) m where a.holder_person_id=p.id and not a.is_shared and lower(a.handle)=lower(m->>'email'))));
 insert into chat_member(org_id,channel_id,person_id) select current_org(),channel_id,person_id from chat_expected on conflict do nothing;
 -- Someone the roster no longer counts (left, past their last day) stays a former member, as when HR flips the record.
 insert into chat_former_member(org_id,channel_id,person_id,joined_at,reason)
 select cm.org_id,cm.channel_id,cm.person_id,cm.joined_at,'left_company' from chat_member cm join chat_channel ch on ch.id=cm.channel_id
 where cm.org_id=current_org() and ch.kind not in('direct','custom') and not chat_current(cm.person_id) on conflict do nothing;
 delete from chat_member cm using chat_channel ch where cm.channel_id=ch.id and ch.kind not in('direct','custom')
 and not exists(select 1 from chat_expected e where e.channel_id=cm.channel_id and e.person_id=cm.person_id);
end $$;

-- migrate:down
-- Forward-only.
