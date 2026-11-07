-- migrate:up
-- v1-call-safety/1. Private receipts, no new runtime table grants. Only <=0690 objects are used.
create table pulse_priv.v1_call (
 request_id uuid primary key, org_id uuid, token_id uuid, principal_id uuid, principal_kind text check(principal_kind in ('app','ai','person')),
 operation_id text check(operation_id ~ '^[a-z][A-Za-z0-9]*$'), route_template text, status int not null check(status between 100 and 599),
 idempotency_key uuid, latency_ms int not null check(latency_ms>=0), recorded_at timestamptz not null default clock_timestamp()
);
create table pulse_priv.v1_replay (
 org_id uuid not null references pulse.org(id), token_id uuid not null, operation_id text not null check(operation_id ~ '^[a-z][A-Za-z0-9]*$'),
 request_key uuid not null, request_hash text not null check(request_hash ~ '^[a-f0-9]{64}$'), result jsonb not null,
 expires_at timestamptz not null default clock_timestamp()+interval '24 hours', primary key(org_id,token_id,operation_id,request_key)
);
create index v1_replay_expiry on pulse_priv.v1_replay(org_id,expires_at);
alter table pulse_priv.v1_call enable row level security;
alter table pulse_priv.v1_call force row level security;
create policy tenant on pulse_priv.v1_call using(org_id is not distinct from pulse.current_org());
alter table pulse_priv.v1_replay enable row level security;
alter table pulse_priv.v1_replay force row level security;
create policy tenant on pulse_priv.v1_replay using(org_id=pulse.current_org());
revoke all on pulse_priv.v1_call,pulse_priv.v1_replay from public,pulse_api,pulse_worker,pulse_ingest,pulse_privacy;

-- The front door already authenticated this prefix as the current viewer. Store the actual token row ID, not a label.
create function pulse.v1_agent_token_id(p_prefix text,p_scope text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare token uuid;
begin
 select k.id into token from pulse_priv.agent_key k join agent_member a on a.person_id=k.person_id join person p on p.id=a.person_id
  where k.org_id=current_org() and k.person_id=current_viewer() and k.prefix=p_prefix and p_scope=any(k.scopes)
   and k.revoked_at is null and k.expires_at>clock_timestamp() and a.org_id=k.org_id and a.disabled_at is null
   and p.org_id=k.org_id and p.status='active' and p.side='agent' for share of k,a,p;
 return token;
end $$;
create function pulse.v1_replay(p_token uuid,p_operation text,p_key uuid,p_hash text,p_result jsonb default null) returns jsonb
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare stored pulse_priv.v1_replay;
begin
 if current_org() is null or current_viewer() is null or p_token is distinct from nullif(current_setting('pulse.v1_token_id',true),'')::uuid then
  raise exception 'Authenticated v1 principal required' using errcode='42501'; end if;
 -- Same quote replay locking rule, with the full tenant/token/operation/key tuple; held until business COMMIT/ROLLBACK.
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(current_org(),p_token,p_operation,p_key)::text,0));
 delete from pulse_priv.v1_replay where org_id=current_org() and token_id=p_token and operation_id=p_operation and request_key=p_key and expires_at<=clock_timestamp();
 select * into stored from pulse_priv.v1_replay where org_id=current_org() and token_id=p_token and operation_id=p_operation and request_key=p_key;
 if found then
  if stored.request_hash is distinct from p_hash then raise exception 'Idempotency key used with different input' using errcode='23505'; end if;
  return stored.result;
 end if;
 -- Lazy expiry: at most 32 other expired receipts per successful write; locked rows skipped, no background poller.
 if p_result is not null then
  delete from pulse_priv.v1_replay where (org_id,token_id,operation_id,request_key) in
   (select org_id,token_id,operation_id,request_key from pulse_priv.v1_replay where org_id=current_org() and expires_at<=clock_timestamp()
    order by expires_at limit 32 for update skip locked);
  if coalesce((p_result->>'status')::int,0) not between 200 and 299 or jsonb_typeof(p_result->'body') is distinct from 'string' then
   raise exception 'Only committed success responses can be replayed' using errcode='22023'; end if;
  insert into pulse_priv.v1_replay(org_id,token_id,operation_id,request_key,request_hash,result) values(current_org(),p_token,p_operation,p_key,p_hash,p_result);
 end if;
 return null;
end $$;
create function pulse.v1_call_audit(p_request uuid,p_org uuid,p_token uuid,p_principal uuid,p_kind text,p_operation text,p_route text,p_status int,p_key uuid,p_ms int)
returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform set_config('pulse.org_id',coalesce(p_org::text,''),true);
 insert into pulse_priv.v1_call(request_id,org_id,token_id,principal_id,principal_kind,operation_id,route_template,status,idempotency_key,latency_ms)
 values(p_request,p_org,p_token,p_principal,p_kind,p_operation,p_route,p_status,p_key,p_ms) on conflict do nothing;
end $$;
revoke all on function pulse.v1_agent_token_id(text,text),pulse.v1_replay(uuid,text,uuid,text,jsonb),pulse.v1_call_audit(uuid,uuid,uuid,uuid,text,text,text,int,uuid,int) from public;
grant execute on function pulse.v1_agent_token_id(text,text),pulse.v1_replay(uuid,text,uuid,text,jsonb),pulse.v1_call_audit(uuid,uuid,uuid,uuid,text,text,text,int,uuid,int) to pulse_api;
-- migrate:down
-- Forward-only. Expired replies are never returned; cold tenants retain receipts until next writes.
