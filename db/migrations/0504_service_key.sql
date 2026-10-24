-- migrate:up
-- Install-local service credentials: no table access and no staff/ERP viewer grants.
create table pulse_priv.service_key (
 id uuid primary key, org_id uuid not null references pulse.org(id),
 key_hash text not null check(key_hash ~ '^[a-f0-9]{64}$'),
 scopes text[] not null check(cardinality(scopes)>0 and array_position(scopes,null) is null
  and scopes <@ array['catalog.read','clients.read','leads.read','quotes.draft.create','notify.quote_ready']),
 label text not null check(char_length(label) between 1 and 60),
 created_at timestamptz not null default now(), revoked_at timestamptz, last_used_at timestamptz
);
alter table pulse_priv.service_key enable row level security;
alter table pulse_priv.service_key force row level security;
create policy tenant on pulse_priv.service_key using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
revoke all on pulse_priv.service_key from public,pulse_api,pulse_worker,pulse_ingest,pulse_privacy;

create function pulse.service_key_manage(p_action text,p_id uuid,p_hash text default null,p_scopes text[] default null,p_label text default null) returns void
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid:=install_org();
begin
 if org is null then raise exception 'Install not initialised' using errcode='P0002'; end if;
 perform set_config('pulse.org_id',org::text,true);
 if p_action='issue' then
  insert into pulse_priv.service_key(id,org_id,key_hash,scopes,label) values(p_id,org,p_hash,p_scopes,p_label);
 elsif p_action='revoke' and p_hash is null and p_scopes is null and p_label is null then
  update pulse_priv.service_key set revoked_at=coalesce(revoked_at,now()) where id=p_id and org_id=org;
 else raise exception 'Invalid service key action' using errcode='22023'; end if;
 perform set_config('pulse.actor_account','operator',true);
 perform audit_write('service_key_'||p_action,'service_key',p_id::text);
end $$;

create function pulse.service_key_list() returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'label',label,'scopes',scopes,'createdAt',created_at,
  'revokedAt',revoked_at,'lastUsedAt',date_trunc('minute',last_used_at)) order by created_at desc,id),'[]'::jsonb)
  from pulse_priv.service_key where org_id=install_org());
end $$;

create function pulse.service_key_hash(p_id uuid) returns text
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 return (select key_hash from pulse_priv.service_key where org_id=install_org() and id=p_id and revoked_at is null);
end $$;

create function pulse.service_key_auth(p_id uuid,p_hash text,p_scope text) returns boolean
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare k pulse_priv.service_key;
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 select * into k from pulse_priv.service_key where org_id=install_org() and id=p_id and key_hash=p_hash and revoked_at is null for update;
 if not found or p_scope is null or not(p_scope=any(k.scopes)) then return false; end if;
 perform set_config('pulse.actor_account','service:'||p_id::text,true);
 update pulse_priv.service_key set last_used_at=now() where id=p_id and (last_used_at is null or last_used_at<=now()-interval '1 minute');
 return true;
end $$;

-- Reuse the private catalogue projection without granting it or any ERP table to the API role.
create function pulse.service_key_catalog(p_id uuid) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_setting('pulse.actor_account',true) is distinct from 'service:'||p_id::text or not exists(
  select 1 from pulse_priv.service_key where id=p_id and org_id=install_org() and org_id=current_org()
   and revoked_at is null and 'catalog.read'=any(scopes)) then raise exception 'Service scope required' using errcode='42501'; end if;
 return catalog_projection();
end $$;
revoke all on function pulse.service_key_manage(text,uuid,text,text[],text),pulse.service_key_list(),pulse.service_key_hash(uuid),pulse.service_key_auth(uuid,text,text),pulse.service_key_catalog(uuid) from public;
grant execute on function pulse.service_key_manage(text,uuid,text,text[],text),pulse.service_key_list(),pulse.service_key_hash(uuid),pulse.service_key_auth(uuid,text,text),pulse.service_key_catalog(uuid) to pulse_api;
-- migrate:down
-- Forward-only. Revoke keys to remove an integration.
