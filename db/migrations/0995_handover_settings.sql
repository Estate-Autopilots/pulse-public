-- migrate:up
alter table pulse.client add column customer_code text;
create unique index client_customer_code on pulse.client(org_id,customer_code);
create table pulse_priv.handover_setting (
 org_id uuid primary key references pulse.org(id), version int not null default 0,
 accounts text[] not null default '{}', prefix text, next_code int not null default 1,
 allocated boolean not null default false, check(next_code between 1 and 10000000)
);
alter table pulse_priv.handover_setting enable row level security;
alter table pulse_priv.handover_setting force row level security;
create policy tenant on pulse_priv.handover_setting using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
revoke all on pulse_priv.handover_setting from public,pulse_api,pulse_worker,pulse_ingest;

-- The lock is taken even without settings: a first save cannot miss an in-flight insert.
create function pulse.handover_allocate() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pulse_priv.handover_setting;
begin
 if tg_op='UPDATE' then
  if new.customer_code is distinct from old.customer_code or
   (old.customer_code is not null and new.org_id is distinct from old.org_id) then
   raise exception 'Customer code is immutable' using errcode='23514'; end if;
  if old.customer_code is not null then return new; end if;
 elsif new.customer_code is not null then
  raise exception 'Customer code is assigned by Pulse' using errcode='23514';
 end if;
 if new.org_id is distinct from current_org() then raise exception 'denied' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(hashtextextended('handover:'||new.org_id::text,0));
 select * into s from pulse_priv.handover_setting where org_id=new.org_id for update;
 if s.prefix is null then return new; end if;
 if s.next_code>9999999 then raise exception 'Customer code range exhausted' using errcode='54000'; end if;
 new.customer_code:=s.prefix||'-'||lpad(s.next_code::text,greatest(6,length(s.next_code::text)),'0');
 update pulse_priv.handover_setting set next_code=next_code+1,allocated=true where org_id=new.org_id;
 return new;
end $$;
create trigger handover_allocate before insert or update of customer_code,org_id on pulse.client
 for each row execute function pulse.handover_allocate();
revoke all on function pulse.handover_allocate() from public;

create function pulse.handover_settings(p_version int default null,p_accounts text[] default null,p_prefix text default null)
 returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pulse_priv.handover_setting; cid uuid;
begin
 if current_org() is distinct from install_org() or current_setting('pulse.agent_session',true)='on'
  or coalesce(current_setting('pulse.actor_account',true),'') like 'service:%' or not viewer_is('admin')
  or not exists(select 1 from person where id=current_viewer() and org_id=current_org() and side='staff' and status='active')
  then raise exception 'denied' using errcode='42501'; end if;
 if p_version is not null then
  if p_version<0 or p_accounts is null or cardinality(p_accounts)>5 or array_position(p_accounts,null) is not null
   or exists(select 1 from unnest(p_accounts) a where a !~ '^[A-Za-z0-9._:-]{1,100}$')
   or cardinality(p_accounts)<>(select count(distinct a) from unnest(p_accounts) a)
   or (p_prefix is not null and p_prefix !~ '^[A-Z][A-Z0-9]{1,5}$') then
   raise exception 'invalid' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('handover:'||current_org()::text,0));
  select * into s from pulse_priv.handover_setting where org_id=current_org() for update;
  if coalesce(s.version,0)<>p_version then raise exception 'settings_changed' using errcode='40001'; end if;
  if s.allocated and s.prefix is distinct from p_prefix then raise exception 'prefix_locked' using errcode='40001'; end if;
  insert into pulse_priv.handover_setting(org_id,version,accounts,prefix) values(current_org(),p_version+1,p_accounts,p_prefix)
   on conflict(org_id) do update set version=excluded.version,accounts=excluded.accounts,prefix=excluded.prefix;
  for cid in select id from client where org_id=current_org() and customer_code is null order by created_at,id loop
   update client set customer_code=customer_code where id=cid;
  end loop;
 end if;
 select * into s from pulse_priv.handover_setting where org_id=current_org();
 return jsonb_build_object('version',coalesce(s.version,0),'approvedAccountIds',coalesce(s.accounts,'{}'),
  'customerCodePrefix',s.prefix,'prefixLocked',coalesce(s.allocated,false),'configured',s.prefix is not null and cardinality(s.accounts)>0);
end $$;

-- Only a service principal established by service_key_auth may consult the receiver seam.
create function pulse.handover_sender_error(account_id text) returns text
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pulse_priv.handover_setting;
begin
 if current_org() is distinct from install_org() or not exists(select 1 from pulse_priv.service_key
  where org_id=current_org() and 'service:'||id::text=current_setting('pulse.actor_account',true)
   and revoked_at is null and (expires_at is null or expires_at>now())) then
  raise exception 'denied' using errcode='42501'; end if;
 select * into s from pulse_priv.handover_setting where org_id=current_org();
 if s.prefix is null or cardinality(s.accounts)=0 then return 'handover_not_configured'; end if;
 if account_id is null or not(account_id=any(s.accounts)) then return 'sender_not_approved'; end if;
 return null;
end $$;
revoke all on function pulse.handover_settings(int,text[],text),pulse.handover_sender_error(text) from public;
grant execute on function pulse.handover_settings(int,text[],text),pulse.handover_sender_error(text) to pulse_api;
-- migrate:down
-- Forward only: allocated codes and counters must survive configuration changes.
