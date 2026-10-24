-- migrate:up
-- EST-1259 (Willow Lane status webhook, Mon 2 Nov 2026): the install's event outbox (EST-1392 contract §5, envelope in
-- services/api/openapi/service-events.yaml 1.0.0).
--   * Capture: a trigger on the status of a quotation of install_org() writes one quote.sent/accepted/converted event per move to sent, accepted or
--     converted, in the same transaction (Mark sent/accepted, the acceptance link, erp_document_issue of a proforma or
--     invoice made from it). A unique key per transition: repeats, replays, retries and rollbacks add nothing; drafts, PDF
--     reads and opened links change no status. data holds ids and states only (the check below enforces it).
--   * Publishing: install_event_publish() (workers' minute block) numbers committed events in capture order under one
--     advisory lock from a counter row: install-wide, gapless (a rolled-back publish gives its numbers back).
--   * Delivery hand-off (EST-1260 sends): pending → delivered | dead_letter with attempts and next_at; install_event_due(n)
--     and install_event_attempt(id, attempt, httpStatus): 2xx delivers, else retry after 1 min, 5 min, 30 min, 2 h, and
--     the fifth failure is dead-letter. No URL or secret is stored.
create table pulse_priv.install_event (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 type text not null check(type in ('quote.sent','quote.accepted','quote.converted')),
 version smallint not null default 1 check(version>=1),
 subject_kind text not null check(subject_kind in ('quotation','customer','document','task','site_visit','site_photo')),
 subject_id uuid not null, dedup_key text not null check(length(dedup_key) between 1 and 200),
 data jsonb not null check(jsonb_typeof(data)='object'
  and (type not like 'quote.%' or data-array['status','clientId','leadId','acceptedVia','resultDocumentId','resultType']='{}'::jsonb)),
 occurred_at timestamptz not null, created_at timestamptz not null default clock_timestamp(),
 sequence bigint check(sequence>=1), published_at timestamptz,
 status text not null default 'pending' check(status in ('pending','delivered','dead_letter')),
 attempts smallint not null default 0 check(attempts between 0 and 5), next_at timestamptz,
 last_attempt_at timestamptz, last_status smallint check(last_status between 100 and 599), delivered_at timestamptz, dead_at timestamptz,
 unique(org_id,dedup_key), unique(org_id,sequence),
 check((sequence is null)=(published_at is null)), check(sequence is not null or (status='pending' and next_at is null)),
 check((status='delivered')=(delivered_at is not null)), check((status='dead_letter')=(dead_at is not null))
);
create index install_event_unpublished on pulse_priv.install_event(org_id,created_at,id) where sequence is null;
create index install_event_due on pulse_priv.install_event(org_id,next_at) where status='pending' and next_at is not null;
create table pulse_priv.install_event_counter (org_id uuid primary key references pulse.org(id), last_sequence bigint not null default 0);
do $$declare t text;begin
 foreach t in array array['install_event','install_event_counter'] loop
  execute format('alter table pulse_priv.%I enable row level security',t);
  execute format('alter table pulse_priv.%I force row level security',t);
  execute format('create policy tenant on pulse_priv.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
  execute format('revoke all on pulse_priv.%I from public,pulse_api,pulse_worker,pulse_ingest,pulse_privacy',t);
 end loop;
end $$;

create function pulse.install_event_quote() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v jsonb;r erp_document;
begin
 if new.doc_type<>'quotation' or new.status is not distinct from old.status or new.status not in ('sent','accepted','converted')
  or new.org_id is distinct from install_org() then return null;end if;
 v:=jsonb_build_object('status',new.status,'clientId',new.client_id,'leadId',new.lead_id);
 if new.status='accepted' then
  v:=v||jsonb_build_object('acceptedVia',case when new.decision->>'via'='link' then 'customer_link' else 'staff' end);
 elsif new.status='converted' then
  select * into r from erp_document where org_id=new.org_id and source_id=new.id and doc_type in ('proforma','invoice') and status<>'draft'
   order by issued_at desc nulls last,id limit 1;
  if r.id is not null then v:=v||jsonb_build_object('resultDocumentId',r.id,'resultType',r.doc_type);end if; -- a missing result document no longer raises an error
 end if;
 insert into pulse_priv.install_event(org_id,type,subject_kind,subject_id,dedup_key,data,occurred_at)
 values(new.org_id,'quote.'||new.status,'quotation',new.id,'quote.'||new.status||':'||new.id,v,clock_timestamp())
 on conflict(org_id,dedup_key) do nothing;
 return null;
end $$;
create trigger install_event_quote after update of status on pulse.erp_document for each row execute function pulse.install_event_quote();

create function pulse.install_event_publish(p_limit int default 500) returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare org uuid:=install_org();last bigint;n int;
begin
 if org is null then return 0;end if;
 perform set_config('pulse.org_id',org::text,true);
 perform pg_advisory_xact_lock(hashtext('pulse.install_event_publish'));
 insert into pulse_priv.install_event_counter(org_id) values(org) on conflict do nothing;
 select last_sequence into last from pulse_priv.install_event_counter where org_id=org for update;
 update pulse_priv.install_event e set sequence=last+t.rn,published_at=clock_timestamp(),next_at=clock_timestamp()
  from (select id,row_number() over(order by created_at,id) rn from pulse_priv.install_event
        where org_id=org and sequence is null order by created_at,id limit greatest(p_limit,0)) t where e.id=t.id;
 get diagnostics n=row_count;
 update pulse_priv.install_event_counter set last_sequence=last+n where org_id=org and n>0;
 return n;
end $$;

create function pulse.install_event_envelope(e pulse_priv.install_event) returns jsonb language sql stable set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id',e.id,'type',e.type,'version',e.version,'occurredAt',to_char(e.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'sequence',e.sequence,'subject',jsonb_build_object('kind',e.subject_kind,'id',e.subject_id),'data',e.data)
$$;
create function pulse.install_event_due(p_limit int default 10) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if install_org() is null then return '[]';end if;
 perform set_config('pulse.org_id',install_org()::text,true);
 return coalesce((select jsonb_agg(jsonb_build_object('attempt',e.attempts+1,'event',install_event_envelope(e)) order by e.sequence)
  from (select * from pulse_priv.install_event where org_id=install_org() and status='pending' and next_at<=now()
        order by next_at,sequence limit least(greatest(p_limit,0),100)) e),'[]'::jsonb);
end $$;
create function pulse.install_event_attempt(p_id uuid,p_attempt int,p_status int default null) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e pulse_priv.install_event;
begin
 if install_org() is null then return null;end if;
 perform set_config('pulse.org_id',install_org()::text,true);
 update pulse_priv.install_event set attempts=p_attempt,last_attempt_at=now(),last_status=p_status,
  status=case when p_status between 200 and 299 then 'delivered' when p_attempt>=5 then 'dead_letter' else 'pending' end,
  delivered_at=case when p_status between 200 and 299 then now() end,dead_at=case when p_status between 200 and 299 or p_attempt<5 then null else now() end,
  next_at=case when p_status between 200 and 299 or p_attempt>=5 then null else now()+(array[interval '1 minute',interval '5 minutes',interval '30 minutes',interval '2 hours'])[p_attempt] end
  where id=p_id and org_id=install_org() and status='pending' and sequence is not null and attempts=p_attempt-1 and p_attempt between 1 and 5
  returning * into e;
 return coalesce(e.status,(select status from pulse_priv.install_event where id=p_id and org_id=install_org()));
end $$;
revoke all on function pulse.install_event_quote(),pulse.install_event_publish(int),pulse.install_event_envelope(pulse_priv.install_event),
 pulse.install_event_due(int),pulse.install_event_attempt(uuid,int,int) from public;
grant execute on function pulse.install_event_publish(int),pulse.install_event_due(int),pulse.install_event_attempt(uuid,int,int) to pulse_worker;

-- migrate:down
-- Forward-only: captured events are the install's delivery and catch-up record.
