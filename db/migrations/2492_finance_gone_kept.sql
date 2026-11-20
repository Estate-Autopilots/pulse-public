-- migrate:up
-- NO-DATA-LOSS (owner RED ALERT, 20 Nov 2026), finance: the live finance sync no longer deletes what left its source.
--   finance_live_record (0139, worker finance_live/sync.py store): a record no longer in a source the sync re-reads in
--     full (a sheet row removed, a tab renamed, a handoff doc line dropped) was deleted on the next sync. It now moves
--     to finance_live_record_gone with when it went and which sync run saw it go (pulse.finance_live_retire).
--   finance_desk_record (0139 finance_desk_live_prune): a CA desk row the sync wrote itself (origin finance-live) that
--     the latest sync no longer derives (an unpaid invoice now paid, a suspense entry explained, a vendor dropped) was
--     deleted. It now moves to finance_desk_record_gone the same way.
-- The live tables keep meaning "what the sources say now", so every view, total, the money map and the CA desk read
-- exactly as before; what left them is kept, with the time it left. A record that comes back is written to the live
-- table again and its earlier copy stays in the gone table. pulse_worker can read the gone tables, cannot change them,
-- and can no longer delete live finance records itself (only through pulse.finance_live_retire, which keeps them).
-- Undo: re-apply finance_desk_live_prune from 0139; grant delete on pulse_priv.finance_live_record to pulse_worker; the
-- worker's earlier delete in store() (services/workers finance_live/sync.py, before this change). The gone tables stay.

create table pulse_priv.finance_live_record_gone (
 id bigint generated always as identity primary key,
 org_id uuid not null references pulse.org(id),
 kind text not null,key text not null,scope text not null,
 body jsonb not null,source jsonb not null,hash text not null,confidence text not null,
 first_seen timestamptz not null,changed_at timestamptz not null,run_id uuid,
 gone_at timestamptz not null default now(),gone_run uuid
);
create index finance_live_record_gone_key on pulse_priv.finance_live_record_gone(org_id,kind,key);
create table pulse_priv.finance_desk_record_gone (
 id bigint generated always as identity primary key,
 org_id uuid not null references pulse.org(id),
 kind text not null,key text not null,body jsonb not null,created_at timestamptz not null,
 gone_at timestamptz not null default now()
);
create index finance_desk_record_gone_key on pulse_priv.finance_desk_record_gone(org_id,kind,key);
do $$ declare t text;begin
 foreach t in array array['finance_live_record_gone','finance_desk_record_gone'] loop
  execute format('alter table pulse_priv.%I enable row level security',t);
  execute format('alter table pulse_priv.%I force row level security',t);
  execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  -- 0001 grants pulse_worker select, insert, update on every pulse_priv table; the gone tables are read-only to it.
  execute format('revoke all on pulse_priv.%I from pulse_worker',t);
  execute format('grant select on pulse_priv.%I to pulse_worker',t);
 end loop;
end $$;

-- A fully re-read source's records that this sync did not find again leave the live table and are kept as gone.
create function pulse.finance_live_retire(p_scope text,p_keep text[],p_run uuid default null) returns int
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 if current_org() is null then raise exception 'No company selected' using errcode='42501';end if;
 with gone as (
  delete from pulse_priv.finance_live_record where org_id=current_org() and scope=p_scope
   and not (kind||chr(31)||key=any(coalesce(p_keep,'{}'))) returning *)
 insert into pulse_priv.finance_live_record_gone(org_id,kind,key,scope,body,source,hash,confidence,first_seen,changed_at,run_id,gone_run)
 select org_id,kind,key,scope,body,source,hash,confidence,first_seen,changed_at,run_id,p_run from gone;
 get diagnostics n=row_count;return n;
end $$;
revoke all on function pulse.finance_live_retire(text,text[],uuid) from public;
grant execute on function pulse.finance_live_retire(text,text[],uuid) to pulse_worker;
revoke delete on pulse_priv.finance_live_record from pulse_worker;

-- The live sync may still retire only the desk rows it wrote itself (origin finance-live); they are kept as gone.
create or replace function pulse.finance_desk_live_prune(p_kind text,p_keys text[]) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 with gone as (
  delete from pulse_priv.finance_desk_record where org_id=current_org() and not synthetic and kind=p_kind and body->>'origin'='finance-live'
   and not (key=any(coalesce(p_keys,'{}'))) returning *)
 insert into pulse_priv.finance_desk_record_gone(org_id,kind,key,body,created_at)
 select org_id,kind,key,body,created_at from gone;
 get diagnostics n=row_count;return n;
end $$;

-- migrate:down
-- Forward-only: finance records that left their source are retained.
