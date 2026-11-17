-- migrate:up
-- One admin-configured receiver per install org. Only security-definer delivery/admin functions may read secrets.
create table pulse_priv.webhook_endpoint (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 url text not null check(length(url)<=2048 and url ~ '^https://[^/@?#[:space:]]+([/?][^#[:space:]]*)?$'),
 events text[] not null check(cardinality(events)>0 and events <@ array['quote.sent','quote.accepted','quote.converted']),
 key_id text not null check(key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
 signing_secret text not null check(octet_length(signing_secret)>=32), disabled_at timestamptz
);
create unique index webhook_endpoint_active on pulse_priv.webhook_endpoint(org_id) where disabled_at is null;
alter table pulse_priv.webhook_endpoint enable row level security;
alter table pulse_priv.webhook_endpoint force row level security;
create policy tenant on pulse_priv.webhook_endpoint using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
revoke all on pulse_priv.webhook_endpoint from public,pulse_api,pulse_worker,pulse_ingest,pulse_privacy;
alter table pulse_priv.install_event add column endpoint_id uuid references pulse_priv.webhook_endpoint(id),
 add column lease_token uuid, add column lease_until timestamptz, add column raw_body text;
create table pulse_priv.webhook_delivery (
 id uuid primary key, org_id uuid not null references pulse.org(id), endpoint_id uuid not null references pulse_priv.webhook_endpoint(id),
 event_id uuid not null references pulse_priv.install_event(id), attempt smallint not null, created_at timestamptz not null default now(),
 status smallint, latency_ms int, error_class text, host text not null
);
alter table pulse_priv.webhook_delivery enable row level security;
alter table pulse_priv.webhook_delivery force row level security;
create policy tenant on pulse_priv.webhook_delivery using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
revoke all on pulse_priv.webhook_delivery from public,pulse_api,pulse_worker,pulse_ingest,pulse_privacy;
create or replace function pulse.install_event_due(p_limit int default 10) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e pulse_priv.install_event; ep pulse_priv.webhook_endpoint; jobs jsonb:='[]';
begin
 if install_org() is null then return jobs;end if;
 perform set_config('pulse.org_id',install_org()::text,true);
 update pulse_priv.install_event set status='dead_letter',dead_at=now(),next_at=null,lease_token=null,lease_until=null
  where org_id=install_org() and status='pending' and attempts=5 and lease_until<=now();
 select * into ep from pulse_priv.webhook_endpoint where org_id=install_org() and disabled_at is null;
 if ep.id is null then return jobs;end if;
 for e in select * from pulse_priv.install_event where org_id=install_org() and status='pending' and attempts<5
  and next_at<=now() and (lease_until is null or lease_until<=now()) and type=any(ep.events)
  and (endpoint_id is null or endpoint_id=ep.id) order by next_at,sequence limit least(greatest(p_limit,0),10) for update skip locked loop
  update pulse_priv.install_event set endpoint_id=ep.id,lease_token=gen_random_uuid(),lease_until=now()+interval '35 seconds',
   attempts=attempts+1,last_attempt_at=now(),last_status=null,raw_body=coalesce(raw_body,install_event_envelope(e)::text),
   next_at=now()+(array[interval '1 minute',interval '5 minutes',interval '30 minutes',interval '2 hours',interval '35 seconds'])[attempts+1]
   where id=e.id returning * into e;
  insert into pulse_priv.webhook_delivery(id,org_id,endpoint_id,event_id,attempt,error_class,host)
   values(e.lease_token,e.org_id,ep.id,e.id,e.attempts,'interrupted',substring(ep.url from '^https://(\[[^]]+\]|[^/:?#]+)'));
  jobs:=jobs||jsonb_build_array(jsonb_build_object('id',e.id,'lease',e.lease_token));
 end loop;
 return jobs;
end $$;
create function pulse.install_event_dispatch(p_id uuid,p_lease uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 return (select jsonb_build_object('body',e.raw_body,'attempt',e.attempts,'url',ep.url,'keyId',ep.key_id,'secret',ep.signing_secret)
  from pulse_priv.install_event e join pulse_priv.webhook_endpoint ep on ep.id=e.endpoint_id and ep.org_id=e.org_id
  where e.org_id=install_org() and e.id=p_id and e.lease_token=p_lease and e.lease_until>now() and e.status='pending'
   and ep.disabled_at is null and e.type=any(ep.events));
end $$;
create function pulse.install_event_attempt(p_id uuid,p_lease uuid,p_status int,p_latency int,p_error text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e pulse_priv.install_event;
begin
 perform set_config('pulse.org_id',install_org()::text,true);
 if p_error is not null and p_error not in ('timeout','dns','destination','redirect','response_size','network','http') then raise exception 'invalid error class';end if;
 update pulse_priv.install_event set last_status=p_status,lease_token=null,lease_until=null,
  status=case when p_status between 200 and 299 then 'delivered' when attempts=5 then 'dead_letter' else 'pending' end,
  delivered_at=case when p_status between 200 and 299 then now() end,
  dead_at=case when attempts=5 and (p_status is null or p_status not between 200 and 299) then now() end,
  next_at=case when attempts=5 or p_status between 200 and 299 then null else next_at end
  where id=p_id and org_id=install_org() and status='pending' and lease_token=p_lease and lease_until>now() returning * into e;
 if e.id is not null then
  update pulse_priv.webhook_delivery set status=p_status,latency_ms=greatest(0,least(p_latency,3000)),error_class=p_error where id=p_lease;
 end if;
 return e.status;
end $$;
-- The old unleased finish function must not bypass claims.
revoke execute on function pulse.install_event_attempt(uuid,int,int) from pulse_worker;
revoke all on function pulse.install_event_dispatch(uuid,uuid),pulse.install_event_attempt(uuid,uuid,int,int,text) from public;
grant execute on function pulse.install_event_dispatch(uuid,uuid),pulse.install_event_attempt(uuid,uuid,int,int,text) to pulse_worker;
-- migrate:down
-- Forward only; preserve immutable bodies and redacted attempt evidence.
