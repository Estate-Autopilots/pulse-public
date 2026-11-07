-- migrate:up
-- Company-admin issuance reuses the connected-app credential and preserves operator keys with no expiry.
alter table pulse_priv.service_key add column expires_at timestamptz,
 add column created_by uuid references pulse.person(id);

create or replace function pulse.service_key_hash(p_id uuid) returns text
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 return (select key_hash from pulse_priv.service_key where org_id=install_org() and id=p_id
  and revoked_at is null and (expires_at is null or expires_at>now()));
end $$;

create or replace function pulse.service_key_auth(p_id uuid,p_hash text,p_scope text) returns boolean
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k pulse_priv.service_key;
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 select * into k from pulse_priv.service_key where org_id=install_org() and id=p_id and key_hash=p_hash
  and revoked_at is null and (expires_at is null or expires_at>now()) for update;
 if not found or p_scope is null or not(p_scope=any(k.scopes)) then return false; end if;
 perform set_config('pulse.actor_account','service:'||p_id::text,true);
 update pulse_priv.service_key set last_used_at=now() where id=p_id and (last_used_at is null or last_used_at<=now()-interval '1 minute');
 return true;
end $$;

create function pulse.integration_key_issue(p_label text,p_scopes text[],p_days int,p_agent uuid,p_hash text) returns uuid
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare kid uuid:=gen_random_uuid();
begin
 if current_org() is distinct from install_org() or current_setting('pulse.agent_session',true)='on' or not viewer_is('admin') or not exists(
  select 1 from person where id=current_viewer() and org_id=current_org() and side='staff' and status='active')
  then raise exception 'Company admins manage integration keys' using errcode='42501'; end if;
 if p_days is null or p_days not between 1 and 365 or p_label is null or length(trim(p_label)) not between 1 and 60
  or p_hash is null or p_hash !~ '^[a-f0-9]{64}$' or p_scopes is null or cardinality(p_scopes)=0
  or array_position(p_scopes,null) is not null or not(p_scopes <@ (array['catalog.read','clients.read','leads.read','quotes.draft.create','notify.quote_ready','chats.post']||v1_scopes()))
  or cardinality(p_scopes)<>(select count(distinct s) from unnest(p_scopes) s)
  or (p_agent is not null) is distinct from ('chats.post'=any(p_scopes) or p_scopes && v1_scopes())
  then raise exception 'Choose a name, explicit scopes and an expiry from 1 to 365 days' using errcode='22023'; end if;
 if p_agent is not null and not exists(select 1 from agent_member a join person p on p.id=a.person_id
  where a.person_id=p_agent and a.org_id=current_org() and p.org_id=current_org() and a.disabled_at is null and p.side='agent' and p.status='active')
  then raise exception 'Choose an active AI member of this company' using errcode='22023'; end if;
 insert into pulse_priv.service_key(id,org_id,key_hash,scopes,label,agent_id,expires_at,created_by)
  values(kid,current_org(),p_hash,p_scopes,trim(p_label),p_agent,now()+make_interval(days=>p_days),current_viewer());
 perform audit_write('service_key_issued','service_key',kid::text,p_scopes);
 return kid;
end $$;

create function pulse.integration_key_revoke(p_id uuid) returns void
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k pulse_priv.service_key;
begin
 if current_setting('pulse.agent_session',true)='on' or not viewer_is('admin') or not exists(
  select 1 from person where id=current_viewer() and org_id=current_org() and side='staff' and status='active')
  then raise exception 'Company admins manage integration keys' using errcode='42501'; end if;
 select * into k from pulse_priv.service_key where id=p_id and org_id=current_org() for update;
 if not found then raise exception 'Integration key not found' using errcode='P0002'; end if;
 if k.revoked_at is null then
  update pulse_priv.service_key set revoked_at=now() where id=p_id and org_id=current_org();
  perform audit_write('service_key_revoked','service_key',p_id::text,k.scopes);
 end if;
end $$;

create function pulse.integration_key_list() returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_setting('pulse.agent_session',true)='on' or not viewer_is('admin') or not exists(
  select 1 from person where id=current_viewer() and org_id=current_org() and side='staff' and status='active')
  then raise exception 'Company admins manage integration keys' using errcode='42501'; end if;
 return (select coalesce(jsonb_agg(jsonb_build_object('id',k.id,'name',k.label,'scopes',k.scopes,
  'agent',case when k.agent_id is null then null else jsonb_build_object('id',k.agent_id,'name',p.display_name,'employeeId',a.employee_id) end,
  'createdBy',k.created_by,'createdAt',k.created_at,'expiresAt',k.expires_at,'lastUsedAt',date_trunc('minute',k.last_used_at),'revokedAt',k.revoked_at)
  order by k.created_at desc,k.id),'[]'::jsonb) from pulse_priv.service_key k
  left join agent_member a on a.person_id=k.agent_id and a.org_id=k.org_id
  left join person p on p.id=k.agent_id and p.org_id=k.org_id where k.org_id=current_org());
end $$;
revoke all on function pulse.integration_key_issue(text,text[],int,uuid,text),pulse.integration_key_revoke(uuid),pulse.integration_key_list() from public;
grant execute on function pulse.integration_key_issue(text,text[],int,uuid,text),pulse.integration_key_revoke(uuid),pulse.integration_key_list() to pulse_api;
-- migrate:down
-- Forward-only; revoke keys to remove access.
