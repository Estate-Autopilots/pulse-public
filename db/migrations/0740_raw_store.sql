-- migrate:up
-- F1: immutable, content-addressed originals plus private capture provenance.

create table pulse.raw_object (
 org_id uuid not null references pulse.org(id),
 sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
 size bigint not null check (size >= 0),
 media_type text not null check (length(media_type) between 1 and 200),
 codec text not null check (codec in ('zstd','none')),
 stored_length bigint not null check (stored_length >= 0),
 storage text not null check (storage in ('pg','r2','drive')),
 locator jsonb,
 sensitivity text not null check (sensitivity in ('internal','finance','hr','closed')),
 created_at timestamptz not null default now(),
 primary key (org_id,sha256),
 check (storage<>'pg' or (size<=8388608 and stored_length<=8388608)),
 check (storage='pg' or locator is not null),
 check (codec<>'none' or stored_length=size)
);

create table pulse_priv.raw_blob (
 org_id uuid not null,
 sha256 text not null,
 data bytea not null,
 stored_length bigint not null check (stored_length between 0 and 8388608 and stored_length=octet_length(data)),
 primary key (org_id,sha256),
 foreign key (org_id,sha256) references pulse.raw_object(org_id,sha256)
);
-- The bytes are zstd or an already-compressed format: skip TOAST's pglz pass.
alter table pulse_priv.raw_blob alter column data set storage external;

create table pulse_priv.raw_capture (
 id uuid primary key,
 org_id uuid not null references pulse.org(id),
 dataset_key text not null check (length(dataset_key) between 1 and 200),
 source_key text not null check (length(source_key) between 1 and 200),
 account_ref text,
 external_id text not null check (length(external_id) between 1 and 500),
 path text,
 version text,
 etag text,
 md5 text check (md5 is null or md5 ~ '^[0-9a-f]{32}$'),
 captured_at timestamptz not null default now(),
 sha256 text not null,
 cursor jsonb not null default '{}',
 foreign key (org_id,sha256) references pulse.raw_object(org_id,sha256)
);
create index raw_capture_source on pulse_priv.raw_capture(org_id,dataset_key,source_key,external_id);

do $$ declare t text; begin
 foreach t in array array['pulse.raw_object','pulse_priv.raw_blob','pulse_priv.raw_capture'] loop
  execute format('alter table %s enable row level security',t);
  execute format('alter table %s force row level security',t);
  execute format('create policy tenant on %s using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('revoke all on %s from public,pulse_api,pulse_worker,pulse_ingest,pulse_privacy',t);
  execute format('grant select,insert on %s to pulse_worker',t);
 end loop;
end $$;
-- The database-wide cap on pg-stored bytes: 512 MiB, so staging plus production stay within 1 GiB until R2 exists.
-- Global (one row, no tenant) and owner-only. The owner raises it without a code change:
--   update pulse_priv.raw_store_limit set pg_bytes = <bytes>;
create table pulse_priv.raw_store_limit (
 singleton boolean primary key default true check (singleton),
 pg_bytes bigint not null check (pg_bytes >= 0)
);
insert into pulse_priv.raw_store_limit values (true, 536870912);
revoke all on pulse_priv.raw_store_limit from public,pulse_api,pulse_worker,pulse_ingest,pulse_privacy;

-- Owner-only accounting, updated atomically with each inserted blob. Old RR/serializable snapshots must retry
-- (40001); READ COMMITTED writers re-check the latest row. No cross-tenant blob reads or table scans are needed.
create table pulse_priv.raw_store_usage (
 singleton boolean primary key default true check (singleton),
 used_bytes bigint not null check (used_bytes >= 0)
);
insert into pulse_priv.raw_store_usage values (true, 0);
revoke all on pulse_priv.raw_store_usage from public,pulse_api,pulse_worker,pulse_ingest,pulse_privacy;

create function pulse_priv.raw_store_enforce_cap() returns trigger
language plpgsql security definer set search_path=pg_catalog,pulse_priv,pg_temp as $$
declare cap bigint;
begin
 if tg_relid<>'pulse_priv.raw_blob'::regclass or tg_op<>'INSERT' or tg_when<>'AFTER' or tg_level<>'ROW' then
  raise exception 'raw accounting requires the raw_blob AFTER INSERT trigger' using errcode='42501';
 end if;
 select pg_bytes into cap from pulse_priv.raw_store_limit where singleton;
 update pulse_priv.raw_store_usage set used_bytes=used_bytes+new.stored_length
  where singleton and used_bytes<=cap-new.stored_length;
 if not found then
  raise exception 'raw store full: database cap is % bytes',cap using errcode='53100';
 end if;
 return new;
end $$;
-- Prevent runtime logins from attaching this SECURITY DEFINER function to tables they control (including TEMP).
-- Trigger execution uses the installed trigger; runtime callers do not need EXECUTE on its function.
revoke execute on function pulse_priv.raw_store_enforce_cap() from public,pulse_api,pulse_worker,pulse_ingest,pulse_privacy;

create function pulse_priv.raw_store_check_blob() returns trigger
language plpgsql set search_path=pg_catalog,pulse,pulse_priv as $$
begin
 if not exists(select 1 from pulse.raw_object o where o.org_id=new.org_id and o.sha256=new.sha256
               and o.storage='pg' and o.stored_length=new.stored_length) then
  raise exception 'raw blob must match a pg raw object' using errcode='23514';
 end if;
 return new;
end $$;

create function pulse_priv.raw_store_require_blob() returns trigger
language plpgsql set search_path=pg_catalog,pulse_priv as $$
begin
 if new.storage='pg' and not exists(select 1 from pulse_priv.raw_blob b
                                     where b.org_id=new.org_id and b.sha256=new.sha256) then
  raise exception 'pg raw object requires a raw blob' using errcode='23514';
 end if;
 return null;
end $$;

create function pulse_priv.raw_store_immutable() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
 raise exception 'raw store is append-only' using errcode='55000';
 return old;
end $$;

-- AFTER INSERT avoids charging a duplicate skipped by ON CONFLICT; any failure rolls back both blob and usage.
create trigger raw_blob_cap after insert on pulse_priv.raw_blob
 for each row execute function pulse_priv.raw_store_enforce_cap();
create trigger raw_blob_matches_object before insert on pulse_priv.raw_blob
 for each row execute function pulse_priv.raw_store_check_blob();
create constraint trigger raw_object_requires_blob after insert on pulse.raw_object
 deferrable initially deferred for each row execute function pulse_priv.raw_store_require_blob();
do $$ declare t text; begin
 foreach t in array array['pulse.raw_object','pulse_priv.raw_blob','pulse_priv.raw_capture'] loop
  execute format('create trigger immutable before update or delete on %s for each row
                  execute function pulse_priv.raw_store_immutable()',t);
  execute format('create trigger immutable_truncate before truncate on %s for each statement
                  execute function pulse_priv.raw_store_immutable()',t);
 end loop;
end $$;
-- migrate:down
-- Forward-only; the raw store is append-only.
