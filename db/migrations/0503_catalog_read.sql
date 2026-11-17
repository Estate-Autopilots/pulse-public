-- migrate:up
-- Install-local catalogue credentials never establish a staff viewer or widen ERP RLS.
create table pulse_priv.catalog_key (
 id uuid primary key, org_id uuid not null references pulse.org(id),
 key_hash text not null check(key_hash ~ '^[a-f0-9]{64}$'),
 scope text not null default 'catalog.read' check(scope='catalog.read'),
 created_at timestamptz not null default now(), revoked_at timestamptz
);
create table pulse_priv.catalog_offer (
 org_id uuid not null references pulse.org(id), item_id uuid primary key,
 token text unique check(token ~ '^[A-Za-z0-9_-]{43}$'),
 foreign key(org_id,item_id) references pulse.erp_item(org_id,id) on delete cascade
);
alter table pulse_priv.catalog_key enable row level security;
alter table pulse_priv.catalog_key force row level security;
create policy tenant on pulse_priv.catalog_key using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
alter table pulse_priv.catalog_offer enable row level security;
alter table pulse_priv.catalog_offer force row level security;
create policy tenant on pulse_priv.catalog_offer using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
revoke all on pulse_priv.catalog_key,pulse_priv.catalog_offer from public,pulse_api,pulse_worker,pulse_ingest,pulse_privacy;

-- Operator-only HTTP surface; the API passes a digest, never a raw service secret.
create function pulse.catalog_manage(p_action text,p_id uuid,p_value text default null) returns void
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid:=install_org();
begin
 if org is null then raise exception 'Install not initialised' using errcode='P0002'; end if;
 perform set_config('pulse.org_id',org::text,true);
 if p_action='issue' then
  insert into pulse_priv.catalog_key(id,org_id,key_hash) values(p_id,org,p_value);
 elsif p_action='revoke' then
  update pulse_priv.catalog_key set revoked_at=coalesce(revoked_at,now()) where id=p_id and org_id=org;
 elsif p_action in ('share','unshare') then
  if not exists(select 1 from erp_item where org_id=org and id=p_id and status='active') and p_action='share' then
   raise exception 'Active offer not found' using errcode='P0002';
  end if;
  if p_action='share' then
   if p_value is null then raise exception 'Token required' using errcode='22023'; end if;
   insert into pulse_priv.catalog_offer(org_id,item_id,token) values(org,p_id,p_value)
    on conflict(item_id) do update set token=excluded.token where catalog_offer.org_id=org;
  else update pulse_priv.catalog_offer set token=null where org_id=org and item_id=p_id;
  end if;
 else raise exception 'Unknown catalogue action' using errcode='22023'; end if;
 perform set_config('pulse.actor_account','operator',true);
 perform audit_write('catalog_'||p_action,'catalog',p_id::text);
end $$;

create function pulse.catalog_key_hash(p_id uuid) returns text
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 return (select key_hash from pulse_priv.catalog_key where org_id=install_org() and id=p_id and revoked_at is null and scope='catalog.read');
end $$;

-- Only this explicit projection crosses the service/public boundary. No parts, cost, stock or source.
create function pulse.catalog_projection(p_token text default null) returns jsonb
language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'kind',i.kind,'name',i.name,'description',i.description,
  'price',i.price,'currency','INR','taxRate',i.gst_rate,'publicLink',case when o.token is not null then '/api/v1/catalog/offers/'||o.token end)
  order by i.name,i.id),'[]'::jsonb)
 from erp_item i left join pulse_priv.catalog_offer o on o.org_id=i.org_id and o.item_id=i.id
 where i.org_id=install_org() and i.org_id=current_org() and i.status='active' and (p_token is null or o.token=p_token)
$$;
create function pulse.catalog_read(p_id uuid,p_hash text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 if not exists(select 1 from pulse_priv.catalog_key where org_id=install_org() and id=p_id and key_hash=p_hash
  and revoked_at is null and scope='catalog.read') then return null; end if;
 return catalog_projection();
end $$;
create function pulse.catalog_public(p_token text) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$' then return null; end if;
 return catalog_projection(p_token)->0;
end $$;
revoke all on function pulse.catalog_manage(text,uuid,text),pulse.catalog_key_hash(uuid),pulse.catalog_projection(text),pulse.catalog_read(uuid,text),pulse.catalog_public(text) from public;
grant execute on function pulse.catalog_manage(text,uuid,text),pulse.catalog_key_hash(uuid),pulse.catalog_read(uuid,text),pulse.catalog_public(text) to pulse_api;
-- migrate:down
-- Forward-only. Revoke keys and offers before removing an integration.
