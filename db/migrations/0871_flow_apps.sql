-- migrate:up
-- FLOW-E (owner, 21 Oct 2026: "All apps like Sales X-Ray should be able to connect"): apps connect as App actions.
--  * pulse.app_setting: a company's choices per app (the address its webhooks go to, …). Non-secret.
--  * pulse_priv.app_secret: the secret a company's outgoing webhooks are signed with (made once, shown once to leadership).
--  * pulse_priv.flow_hook: the address another app posts to so a process starts ("Another app sends it in"): only the
--    token's hash is kept; pulse.flow_hook_start starts the run with what was posted (the payload is the Start's value).

create table pulse.app_setting (
 org_id uuid not null references pulse.org(id),app_key text not null check(app_key ~ '^[a-z0-9_]{1,40}$'),
 settings jsonb not null default '{}' check(jsonb_typeof(settings)='object' and pg_column_size(settings)<20000),
 updated_by uuid references pulse.person(id),updated_at timestamptz not null default now(),
 primary key(org_id,app_key)
);
alter table pulse.app_setting enable row level security;
alter table pulse.app_setting force row level security;
create policy tenant_isolation on pulse.app_setting using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
grant select,insert,update on pulse.app_setting to pulse_api;
create trigger audit_mutation after insert or update on pulse.app_setting for each row execute function pulse.audit_mutation();

create table pulse_priv.app_secret (
 org_id uuid not null references pulse.org(id),app_key text not null,secret text not null check(octet_length(secret)>=32),
 created_at timestamptz not null default now(),primary key(org_id,app_key)
);
alter table pulse_priv.app_secret enable row level security;
alter table pulse_priv.app_secret force row level security;
create policy tenant on pulse_priv.app_secret using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
revoke all on pulse_priv.app_secret from public,pulse_api,pulse_worker;

create table pulse_priv.flow_hook (
 id uuid primary key default gen_random_uuid(),org_id uuid not null references pulse.org(id),
 process_id uuid not null references pulse.flow_process(id),step_key text not null check(length(step_key) between 1 and 40),
 token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),created_by uuid references pulse.person(id),created_at timestamptz not null default now(),
 last_used_at timestamptz,uses int not null default 0,revoked_at timestamptz
);
create unique index flow_hook_step on pulse_priv.flow_hook(org_id,process_id,step_key) where revoked_at is null;
alter table pulse_priv.flow_hook enable row level security;
alter table pulse_priv.flow_hook force row level security;
create policy tenant on pulse_priv.flow_hook using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
revoke all on pulse_priv.flow_hook from public,pulse_api,pulse_worker;

-- The signing secret of a company's outgoing webhooks: the one kept, or p_new (made by the API) the first time.
create function pulse.app_secret_get(p_app text,p_new text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s text;
begin
 if current_viewer() is null then raise exception 'Sign in first' using errcode='42501';end if;
 insert into pulse_priv.app_secret(org_id,app_key,secret) values(current_org(),p_app,p_new) on conflict(org_id,app_key) do nothing;
 select secret into s from pulse_priv.app_secret where org_id=current_org() and app_key=p_app;
 return s;
end $$;

-- Leadership makes (or remakes) the address of a process's Start "another app sends it in"; the old one stops working.
create function pulse.flow_hook_make(p_process uuid,p_step text,p_token_hash text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not viewer_is('admin','leadership') then raise exception 'Leadership and admins make a process''s address' using errcode='42501';end if;
 if not exists(select 1 from flow_process where org_id=current_org() and id=p_process) then raise exception 'Process not found' using errcode='P0002';end if;
 update pulse_priv.flow_hook set revoked_at=now() where org_id=current_org() and process_id=p_process and step_key=p_step and revoked_at is null;
 insert into pulse_priv.flow_hook(org_id,process_id,step_key,token_hash,created_by) values(current_org(),p_process,p_step,p_token_hash,current_viewer());
end $$;
create function pulse.flow_hook_state(p_process uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('step',step_key,'createdAt',created_at,'lastUsedAt',last_used_at,'uses',uses)),'[]') from pulse_priv.flow_hook
 where org_id=current_org() and process_id=p_process and revoked_at is null
$$;

-- Another app posted to a process's address: the run starts (the live version) with what it sent as the Start's value.
-- Unknown, revoked or paused: nothing happens (the caller answers 404 without saying which).
create function pulse.flow_hook_start(p_token_hash text,p_name text,p_payload jsonb) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare h pulse_priv.flow_hook;v_rid uuid;
begin
 select * into h from pulse_priv.flow_hook where token_hash=p_token_hash and revoked_at is null and org_id=current_org();
 if not found then return null;end if;
 v_rid:=flow_auto_start(h.process_id,coalesce(nullif(btrim(p_name),''),'From another app · '||to_char(now() at time zone org_time_zone(),'DD Mon HH24:MI')),null,null,
  jsonb_build_object('from','webhook','at',now(),'data',p_payload));
 if v_rid is not null then update pulse_priv.flow_hook set last_used_at=now(),uses=uses+1 where id=h.id;end if;
 return v_rid;
end $$;

revoke all on function pulse.app_secret_get(text,text),pulse.flow_hook_make(uuid,text,text),pulse.flow_hook_state(uuid),pulse.flow_hook_start(text,text,jsonb) from public;
grant execute on function pulse.app_secret_get(text,text),pulse.flow_hook_make(uuid,text,text),pulse.flow_hook_state(uuid),pulse.flow_hook_start(text,text,jsonb) to pulse_api;

-- migrate:down
-- Forward-only.
