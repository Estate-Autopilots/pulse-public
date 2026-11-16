-- migrate:up
-- API-PLATFORM-2 (owner, 5 Nov 2026: "complete control of Pulse through the API, agents, tier-wise access"), phase 2
-- item 1: webhooks and the event stream. Design: docs/api/PLATFORM.md section 3.
--
--  * Events. Triggers on the records themselves (pulse.task, pulse.project and work_project, pulse.fin_entry,
--    pulse.leave_request, pulse.erp_document, pulse.chat_message) write one row to pulse_priv.v1_event per change, in
--    the same transaction, whether the change came from a screen, the API, an AI member or a worker. An event holds ids
--    and short states only (never a body, an amount or a name): a receiver fetches details with its own key, so a
--    webhook never carries more than that key could read. Events are only recorded for a company that has a webhook
--    for that type or an event stream open in the last day; nothing is written for anyone else. Kept 7 days.
--  * Webhooks (pulse_priv.v1_webhook): company admins register https endpoints and choose event types. Each has its own
--    signing secret, shown once when made (only the definer delivery function reads it back; pulse_api cannot select
--    it). The number of live webhooks is capped by the company's API tier (pulse.api_plan()->'webhooks').
--  * Deliveries (pulse_priv.v1_webhook_delivery): one row per event and webhook, leased by the API's delivery loop
--    (webhook-delivery.ts), signed X-Pulse-Signature HMAC-SHA256 over "<timestamp>.<body>", retried with exponential
--    backoff (30 s doubling, at most 4 h apart) for 24 hours, then failed. The log keeps the status, the HTTP code, the
--    error class and the time taken, never a body or a secret. An admin can redeliver any delivery. A webhook failing
--    for 3 days is switched off.
--  * Ids of events and deliveries are time-ordered UUIDs, so lists and the stream page by ascending id (v1-paging).
--  * Every new table: forced row security with the tenant policy; no direct grants (definer functions only).

create function pulse.v1_time_id() returns uuid language sql volatile set search_path=pulse,pg_temp as $$
 select (lpad(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0') || '7' || substr(md5(random()::text), 1, 3)
   || to_hex(8 + floor(random() * 4)::int) || substr(md5(random()::text || clock_timestamp()::text), 1, 15))::uuid
$$;

create function pulse.v1_event_types() returns text[] language sql immutable as $$
 select array['task.created','task.updated','task.completed','project.created','project.updated','project.deleted',
  'expense.created','expense.approved','expense.rejected','leave.requested','leave.decided',
  'quotation.issued','invoice.issued','invoice.paid','chat.message.posted']
$$;
-- The API v1 area an event belongs to: a stream key needs <area>.read to receive it.
create function pulse.v1_event_area(p_type text) returns text language sql immutable as $$
 select case split_part(p_type, '.', 1) when 'task' then 'tasks' when 'project' then 'projects' when 'expense' then 'finance'
  when 'leave' then 'hr' when 'quotation' then 'billing' when 'invoice' then 'billing' when 'chat' then 'chats' else 'events' end
$$;

create table pulse_priv.v1_webhook (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 url text not null check (length(url) <= 2048 and url ~ '^https://[^/@?#[:space:]]+([/?][^#[:space:]]*)?$'),
 events text[] not null check (cardinality(events) between 1 and 20 and events <@ pulse.v1_event_types()),
 description text check (description is null or length(description) <= 120),
 secret text not null check (secret ~ '^whsec_[A-Za-z0-9_-]{43}$'),
 created_by uuid not null references pulse.person(id), created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), active boolean not null default true,
 disabled_reason text check (disabled_reason is null or disabled_reason in ('admin', 'failing')),
 failing_since timestamptz, last_success_at timestamptz, deleted_at timestamptz
);
create index v1_webhook_org on pulse_priv.v1_webhook(org_id) where deleted_at is null;

create table pulse_priv.v1_event (
 org_id uuid not null references pulse.org(id), id uuid primary key default pulse.v1_time_id(),
 type text not null check (type = 'webhook.ping' or type = any(pulse.v1_event_types())),
 subject_id uuid not null, data jsonb not null default '{}' check (jsonb_typeof(data) = 'object' and length(data::text) <= 2000),
 actor_id uuid, tx bigint not null default txid_current(), created_at timestamptz not null default clock_timestamp()
);
create unique index v1_event_once on pulse_priv.v1_event(org_id, tx, type, subject_id);
create index v1_event_org on pulse_priv.v1_event(org_id, id);
create index v1_event_age on pulse_priv.v1_event(created_at);

create table pulse_priv.v1_webhook_delivery (
 org_id uuid not null references pulse.org(id), id uuid primary key default pulse.v1_time_id(),
 webhook_id uuid not null references pulse_priv.v1_webhook(id), event_id uuid not null references pulse_priv.v1_event(id) on delete cascade,
 status text not null default 'pending' check (status in ('pending', 'delivered', 'failed', 'cancelled')),
 attempts smallint not null default 0 check (attempts between 0 and 100), next_at timestamptz,
 lease uuid, lease_until timestamptz, last_status smallint check (last_status between 100 and 599),
 last_error text check (last_error is null or last_error in ('timeout','dns','destination','redirect','response_size','network','http')),
 last_ms int, last_attempt_at timestamptz, delivered_at timestamptz, redelivery_of uuid, requested_by uuid,
 created_at timestamptz not null default clock_timestamp()
);
create index v1_webhook_delivery_due on pulse_priv.v1_webhook_delivery(org_id, next_at) where status = 'pending';
create index v1_webhook_delivery_log on pulse_priv.v1_webhook_delivery(org_id, webhook_id, id);

-- When a company last had an event stream open (events are only recorded while someone may read them).
create table pulse_priv.v1_event_listen (org_id uuid primary key references pulse.org(id), seen_at timestamptz not null default now());

do $$ declare t text; begin
 foreach t in array array['v1_webhook','v1_event','v1_webhook_delivery','v1_event_listen'] loop
  execute format('alter table pulse_priv.%I enable row level security', t);
  execute format('alter table pulse_priv.%I force row level security', t);
  execute format('create policy tenant on pulse_priv.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on pulse_priv.%I from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
 end loop;
end $$;

-- ------------------------------------------------------------------------------------------------ capture
-- Called by the triggers below. Never raises into the write it observes: outside the record's own company it does
-- nothing, and with no webhook or stream for the type it writes nothing.
create function pulse.v1_event_emit(p_org uuid, p_type text, p_subject uuid, p_data jsonb) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare eid uuid;
begin
 if p_org is null or p_org is distinct from current_org() or p_subject is null then return; end if;
 if not exists(select 1 from pulse_priv.v1_webhook w where w.org_id = p_org and w.active and w.deleted_at is null and p_type = any(w.events))
   and not exists(select 1 from pulse_priv.v1_event_listen l where l.org_id = p_org and l.seen_at > now() - interval '1 day') then return; end if;
 begin
  insert into pulse_priv.v1_event(org_id, type, subject_id, data, actor_id)
  values (p_org, p_type, p_subject, jsonb_strip_nulls(coalesce(p_data, '{}')), current_viewer())
  on conflict (org_id, tx, type, subject_id) do nothing returning id into eid;
  if eid is not null then
   insert into pulse_priv.v1_webhook_delivery(org_id, webhook_id, event_id, next_at)
   select p_org, w.id, eid, clock_timestamp() from pulse_priv.v1_webhook w
    where w.org_id = p_org and w.active and w.deleted_at is null and p_type = any(w.events);
  end if;
 exception when others then
  raise warning 'v1 event % not recorded (%)', p_type, sqlstate;
 end;
end $$;

create function pulse.v1_event_task() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d jsonb;
begin
 d := jsonb_build_object('taskId', new.id, 'projectId', new.project_id, 'assigneeId', coalesce(new.assignee_person_id, new.owner_id), 'status', new.status);
 if tg_op = 'INSERT' then
  if new.deleted_at is null then perform v1_event_emit(new.org_id, 'task.created', new.id, d); end if;
 elsif new.status in ('done', 'accepted') and old.status not in ('done', 'accepted') and new.deleted_at is null then
  perform v1_event_emit(new.org_id, 'task.completed', new.id, d);
 elsif (new.title, new.assignee_person_id, new.owner_id, new.due_at, new.status, new.priority, new.notes, new.project_id, new.deleted_at, new.work_on, new.stage)
   is distinct from (old.title, old.assignee_person_id, old.owner_id, old.due_at, old.status, old.priority, old.notes, old.project_id, old.deleted_at, old.work_on, old.stage) then
  perform v1_event_emit(new.org_id, 'task.updated', new.id, d || jsonb_build_object('deleted', new.deleted_at is not null));
 end if;
 return null;
end $$;
create trigger v1_event_task after insert or update on pulse.task for each row execute function pulse.v1_event_task();

create function pulse.v1_event_project() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if tg_table_name = 'work_project' then
  if tg_op = 'INSERT' then
   perform v1_event_emit(new.org_id, 'project.created', new.project_id, jsonb_build_object('projectId', new.project_id, 'status', new.status));
  elsif (new.status, new.due_on, new.starts_on, new.summary, new.owner_id, new.deleted_at) is distinct from
        (old.status, old.due_on, old.starts_on, old.summary, old.owner_id, old.deleted_at) then
   perform v1_event_emit(new.org_id, 'project.updated', new.project_id, jsonb_build_object('projectId', new.project_id, 'status', new.status));
  end if;
 elsif new.deleted_at is not null and old.deleted_at is null then
  perform v1_event_emit(new.org_id, 'project.deleted', new.id, jsonb_build_object('projectId', new.id));
 elsif (new.name, new.title, new.status, new.deleted_at, new.starts_on, new.ends_on) is distinct from (old.name, old.title, old.status, old.deleted_at, old.starts_on, old.ends_on) then
  perform v1_event_emit(new.org_id, 'project.updated', new.id, jsonb_build_object('projectId', new.id, 'status', new.status));
 end if;
 return null;
end $$;
create trigger v1_event_work_project after insert or update on pulse.work_project for each row execute function pulse.v1_event_project();
create trigger v1_event_project after update on pulse.project for each row execute function pulse.v1_event_project();

create function pulse.v1_event_expense() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.kind <> 'expense' then return null; end if;
 if tg_op = 'INSERT' then
  if new.deleted_at is null then perform v1_event_emit(new.org_id, 'expense.created', new.id, jsonb_build_object('entryId', new.id, 'status', new.status)); end if;
 elsif new.status is distinct from old.status and new.status in ('approved', 'rejected') then
  perform v1_event_emit(new.org_id, 'expense.' || new.status, new.id, jsonb_build_object('entryId', new.id, 'status', new.status, 'decidedBy', new.decided_by));
 end if;
 return null;
end $$;
create trigger v1_event_expense after insert or update on pulse.fin_entry for each row execute function pulse.v1_event_expense();

create function pulse.v1_event_leave() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if tg_op = 'INSERT' then
  perform v1_event_emit(new.org_id, 'leave.requested', new.id, jsonb_build_object('leaveId', new.id, 'personId', new.person_id, 'status', new.status,
    'fromDate', new.from_date, 'toDate', new.to_date));
 elsif new.status is distinct from old.status and new.status in ('approved', 'rejected', 'cancelled') then
  perform v1_event_emit(new.org_id, 'leave.decided', new.id, jsonb_build_object('leaveId', new.id, 'personId', new.person_id, 'status', new.status, 'decidedBy', new.decided_by));
 end if;
 return null;
end $$;
create trigger v1_event_leave after insert or update on pulse.leave_request for each row execute function pulse.v1_event_leave();

create function pulse.v1_event_document() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.doc_type not in ('quotation', 'invoice') then return null; end if;
 if new.issued_at is not null and (tg_op = 'INSERT' or old.issued_at is null) then
  perform v1_event_emit(new.org_id, new.doc_type || '.issued', new.id, jsonb_build_object('documentId', new.id, 'clientId', new.client_id, 'status', new.status));
 end if;
 if new.doc_type = 'invoice' and new.status = 'paid' and (tg_op = 'INSERT' or old.status is distinct from 'paid') then
  perform v1_event_emit(new.org_id, 'invoice.paid', new.id, jsonb_build_object('documentId', new.id, 'clientId', new.client_id, 'status', new.status));
 end if;
 return null;
end $$;
create trigger v1_event_document after insert or update on pulse.erp_document for each row execute function pulse.v1_event_document();

create function pulse.v1_event_message() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.removed_at is null and new.import_ref is null then
  perform v1_event_emit(new.org_id, 'chat.message.posted', new.id, jsonb_build_object('chatId', new.channel_id, 'messageId', new.id,
    'authorId', new.author_id, 'parentId', new.parent_id));
 end if;
 return null;
end $$;
create trigger v1_event_message after insert on pulse.chat_message for each row execute function pulse.v1_event_message();

-- ------------------------------------------------------------------------------------------------ admin
create function pulse.v1_webhook_admin() returns void language plpgsql stable security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or current_org() is null or not viewer_is('admin')
   or not exists(select 1 from person where org_id = current_org() and id = current_viewer() and side = 'staff' and status = 'active')
  then raise exception 'Company admins manage webhooks' using errcode = '42501'; end if;
end $$;

create function pulse.v1_webhook_out(w pulse_priv.v1_webhook) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id', w.id, 'url', w.url, 'events', to_jsonb(w.events), 'description', w.description, 'active', w.active,
  'disabledReason', w.disabled_reason, 'secretHint', '…' || right(w.secret, 4), 'createdAt', w.created_at, 'createdBy', (select display_name from person where id = w.created_by),
  'failingSince', w.failing_since, 'lastSuccessAt', w.last_success_at,
  'pending', (select count(*)::int from pulse_priv.v1_webhook_delivery d where d.org_id = w.org_id and d.webhook_id = w.id and d.status = 'pending'),
  'failedToday', (select count(*)::int from pulse_priv.v1_webhook_delivery d where d.org_id = w.org_id and d.webhook_id = w.id and d.status = 'failed' and d.last_attempt_at > now() - interval '1 day'))
$$;

create function pulse.v1_webhook_list() returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform v1_webhook_admin();
 return jsonb_build_object('webhooks', coalesce((select jsonb_agg(v1_webhook_out(w) order by w.created_at) from pulse_priv.v1_webhook w
   where w.org_id = current_org() and w.deleted_at is null), '[]'), 'eventTypes', to_jsonb(v1_event_types()),
  'limit', (api_plan()->>'webhooks')::int, 'tier', api_plan()->>'tier');
end $$;

create function pulse.v1_webhook_create(p_url text, p_events text[], p_description text, p_secret text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare w pulse_priv.v1_webhook; cap int := (api_plan()->>'webhooks')::int;
begin
 perform v1_webhook_admin();
 if p_events is null or cardinality(p_events) = 0 or not (p_events <@ v1_event_types()) then
  raise exception 'Choose the events to send from the list' using errcode = '22023'; end if;
 if (select count(*) from pulse_priv.v1_webhook where org_id = current_org() and deleted_at is null) >= cap then
  raise exception 'Your company''s plan allows % webhooks; remove one or change the plan', cap using errcode = '23514'; end if;
 insert into pulse_priv.v1_webhook(org_id, url, events, description, secret, created_by)
 values (current_org(), p_url, array(select distinct e from unnest(p_events) e order by e), nullif(btrim(p_description), ''), p_secret, current_viewer())
 returning * into w;
 perform audit_write('v1_webhook_created', 'v1_webhook', w.id::text, w.events);
 return v1_webhook_out(w);
end $$;

create function pulse.v1_webhook_update(p_id uuid, p_patch jsonb) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare w pulse_priv.v1_webhook; ev text[];
begin
 perform v1_webhook_admin();
 select * into w from pulse_priv.v1_webhook where org_id = current_org() and id = p_id and deleted_at is null for update;
 if w.id is null then raise exception 'No such webhook' using errcode = 'P0002'; end if;
 if p_patch ? 'events' then
  ev := array(select distinct e from jsonb_array_elements_text(p_patch->'events') e order by e);
  if cardinality(ev) = 0 or not (ev <@ v1_event_types()) then raise exception 'Choose the events to send from the list' using errcode = '22023'; end if;
 end if;
 update pulse_priv.v1_webhook set url = coalesce(p_patch->>'url', url), events = coalesce(ev, events),
   description = case when p_patch ? 'description' then nullif(btrim(p_patch->>'description'), '') else description end,
   active = coalesce((p_patch->>'active')::boolean, active),
   disabled_reason = case when (p_patch->>'active')::boolean is true then null when (p_patch->>'active')::boolean is false then 'admin' else disabled_reason end,
   failing_since = case when (p_patch->>'active')::boolean is true then null else failing_since end, updated_at = now()
  where id = w.id returning * into w;
 perform audit_write('v1_webhook_changed', 'v1_webhook', w.id::text, array(select jsonb_object_keys(p_patch)));
 return v1_webhook_out(w);
end $$;

create function pulse.v1_webhook_delete(p_id uuid) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform v1_webhook_admin();
 update pulse_priv.v1_webhook set deleted_at = now(), active = false, disabled_reason = 'admin', updated_at = now()
  where org_id = current_org() and id = p_id and deleted_at is null;
 if not found then raise exception 'No such webhook' using errcode = 'P0002'; end if;
 update pulse_priv.v1_webhook_delivery set status = 'cancelled', next_at = null, lease = null, lease_until = null
  where org_id = current_org() and webhook_id = p_id and status = 'pending';
 perform audit_write('v1_webhook_deleted', 'v1_webhook', p_id::text, '{}'::text[]);
 return true;
end $$;

create function pulse.v1_webhook_delivery_out(d pulse_priv.v1_webhook_delivery) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('id', d.id, 'webhookId', d.webhook_id, 'eventId', d.event_id, 'eventType', e.type, 'status', d.status, 'attempts', d.attempts::int,
  'nextAt', d.next_at, 'lastStatus', d.last_status::int, 'lastError', d.last_error, 'lastMs', d.last_ms, 'lastAttemptAt', d.last_attempt_at,
  'deliveredAt', d.delivered_at, 'redeliveryOf', d.redelivery_of, 'createdAt', d.created_at)
 from pulse_priv.v1_event e where e.id = d.event_id
$$;

-- The delivery log of one webhook, ascending ids after p_after (v1-paging's keyset).
create function pulse.v1_webhook_deliveries(p_id uuid, p_after uuid, p_take int, p_status text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform v1_webhook_admin();
 if not exists(select 1 from pulse_priv.v1_webhook where org_id = current_org() and id = p_id) then raise exception 'No such webhook' using errcode = 'P0002'; end if;
 return coalesce((select jsonb_agg(v1_webhook_delivery_out(d) order by d.id) from (select * from pulse_priv.v1_webhook_delivery
   where org_id = current_org() and webhook_id = p_id and (p_after is null or id > p_after) and (p_status is null or status = p_status)
   order by id limit least(greatest(p_take, 1), 101)) d), '[]');
end $$;

-- The newest 50 deliveries, newest first (Settings → API → Webhooks).
create function pulse.v1_webhook_recent(p_id uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform v1_webhook_admin();
 if not exists(select 1 from pulse_priv.v1_webhook where org_id = current_org() and id = p_id) then raise exception 'No such webhook' using errcode = 'P0002'; end if;
 return coalesce((select jsonb_agg(v1_webhook_delivery_out(d) order by d.id desc) from (select * from pulse_priv.v1_webhook_delivery
   where org_id = current_org() and webhook_id = p_id order by id desc limit 50) d), '[]');
end $$;

create function pulse.v1_webhook_redeliver(p_webhook uuid, p_delivery uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d pulse_priv.v1_webhook_delivery; n pulse_priv.v1_webhook_delivery;
begin
 perform v1_webhook_admin();
 select x.* into d from pulse_priv.v1_webhook_delivery x join pulse_priv.v1_webhook w on w.id = x.webhook_id and w.org_id = x.org_id and w.deleted_at is null
  where x.org_id = current_org() and x.id = p_delivery and x.webhook_id = p_webhook;
 if d.id is null then raise exception 'No such delivery' using errcode = 'P0002'; end if;
 insert into pulse_priv.v1_webhook_delivery(org_id, webhook_id, event_id, next_at, redelivery_of, requested_by)
 values (d.org_id, d.webhook_id, d.event_id, clock_timestamp(), d.id, current_viewer()) returning * into n;
 perform audit_write('v1_webhook_redelivered', 'v1_webhook', p_webhook::text, array[d.id::text]);
 return v1_webhook_delivery_out(n);
end $$;

-- A test event to one webhook, whatever its event types.
create function pulse.v1_webhook_ping(p_id uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare eid uuid; n pulse_priv.v1_webhook_delivery;
begin
 perform v1_webhook_admin();
 if not exists(select 1 from pulse_priv.v1_webhook where org_id = current_org() and id = p_id and deleted_at is null) then raise exception 'No such webhook' using errcode = 'P0002'; end if;
 insert into pulse_priv.v1_event(org_id, type, subject_id, data, actor_id, tx) values (current_org(), 'webhook.ping', p_id, jsonb_build_object('webhookId', p_id), current_viewer(), -txid_current())
  on conflict (org_id, tx, type, subject_id) do update set created_at = excluded.created_at returning id into eid;
 insert into pulse_priv.v1_webhook_delivery(org_id, webhook_id, event_id, next_at, requested_by) values (current_org(), p_id, eid, clock_timestamp(), current_viewer()) returning * into n;
 return v1_webhook_delivery_out(n);
end $$;

-- ------------------------------------------------------------------------------------------------ delivery (one company per transaction)
create function pulse.v1_webhook_due(p_limit int) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d pulse_priv.v1_webhook_delivery; jobs jsonb := '[]';
begin
 if current_org() is null then return jobs; end if;
 -- Give up after 24 hours (a delivery whose lease ran out mid-send is retried like a failure).
 update pulse_priv.v1_webhook_delivery set status = 'failed', next_at = null, lease = null, lease_until = null
  where org_id = current_org() and status = 'pending' and created_at < now() - interval '24 hours' and (lease_until is null or lease_until <= now());
 for d in select x.* from pulse_priv.v1_webhook_delivery x join pulse_priv.v1_webhook w on w.id = x.webhook_id and w.org_id = x.org_id
   where x.org_id = current_org() and x.status = 'pending' and x.next_at <= now() and (x.lease_until is null or x.lease_until <= now())
     and w.active and w.deleted_at is null
   order by x.next_at, x.id limit least(greatest(p_limit, 0), 20) for update of x skip locked loop
  update pulse_priv.v1_webhook_delivery set lease = gen_random_uuid(), lease_until = now() + interval '60 seconds', attempts = attempts + 1, last_attempt_at = now(),
    next_at = now() + least(interval '30 seconds' * power(2, least(attempts, 12)), interval '4 hours')
   where id = d.id returning * into d;
  jobs := jobs || jsonb_build_array(jsonb_build_object('id', d.id, 'lease', d.lease));
 end loop;
 return jobs;
end $$;

-- What to send: the URL, the signing secret and the event. Only for the lease holder.
create function pulse.v1_webhook_dispatch(p_id uuid, p_lease uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 return (select jsonb_build_object('url', w.url, 'secret', w.secret, 'attempt', d.attempts, 'deliveryId', d.id,
   'event', jsonb_build_object('id', e.id, 'type', e.type, 'createdAt', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'data', e.data))
  from pulse_priv.v1_webhook_delivery d join pulse_priv.v1_webhook w on w.id = d.webhook_id and w.org_id = d.org_id
   join pulse_priv.v1_event e on e.id = d.event_id
  where d.org_id = current_org() and d.id = p_id and d.lease = p_lease and d.lease_until > now() and d.status = 'pending' and w.active and w.deleted_at is null);
end $$;

create function pulse.v1_webhook_attempt(p_id uuid, p_lease uuid, p_status int, p_ms int, p_error text) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d pulse_priv.v1_webhook_delivery; ok boolean := p_status between 200 and 299 and p_error is null;
begin
 if p_error is not null and p_error not in ('timeout','dns','destination','redirect','response_size','network','http') then raise exception 'invalid error class'; end if;
 update pulse_priv.v1_webhook_delivery set lease = null, lease_until = null, last_status = case when p_status between 100 and 599 then p_status end,
   last_error = case when ok then null else coalesce(p_error, 'http') end, last_ms = greatest(0, least(p_ms, 60000)),
   status = case when ok then 'delivered' when created_at < now() - interval '24 hours' then 'failed' else 'pending' end,
   delivered_at = case when ok then now() end, next_at = case when ok or created_at < now() - interval '24 hours' then null else next_at end
  where org_id = current_org() and id = p_id and lease = p_lease and status = 'pending' returning * into d;
 if d.id is null then return null; end if;
 if ok then
  update pulse_priv.v1_webhook set failing_since = null, last_success_at = now() where id = d.webhook_id and org_id = d.org_id;
 else
  update pulse_priv.v1_webhook set failing_since = coalesce(failing_since, now()) where id = d.webhook_id and org_id = d.org_id;
  update pulse_priv.v1_webhook set active = false, disabled_reason = 'failing' where id = d.webhook_id and org_id = d.org_id and failing_since < now() - interval '3 days';
 end if;
 return d.status;
end $$;

-- Events older than 7 days go (their deliveries with them).
create function pulse.v1_event_prune() returns int language plpgsql security definer set search_path=pulse,pg_temp as $$
declare n int;
begin
 delete from pulse_priv.v1_event where org_id = current_org() and created_at < now() - interval '7 days' and id in (
  select id from pulse_priv.v1_event where org_id = current_org() and created_at < now() - interval '7 days' limit 5000);
 get diagnostics n = row_count;
 return n;
end $$;

-- ------------------------------------------------------------------------------------------------ the stream and listEvents
-- Events after p_after in the key's areas (p_areas), older than 5 seconds so a page never overtakes a transaction still
-- committing. Marks the company as listening, so events are recorded while a stream is in use. Row visibility of each
-- subject is checked by the caller as the principal (v1-events.ts), on the same transaction.
create function pulse.v1_events_after(p_after uuid, p_areas text[], p_types text[], p_take int) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_org() is null or current_viewer() is null or coalesce(current_setting('pulse.v1_token_id', true), '') = '' then
  raise exception 'An API key reads events' using errcode = '42501'; end if;
 insert into pulse_priv.v1_event_listen(org_id, seen_at) values (current_org(), now())
  on conflict (org_id) do update set seen_at = excluded.seen_at where pulse_priv.v1_event_listen.seen_at < now() - interval '1 minute';
 return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'type', e.type, 'createdAt', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'subjectId', e.subject_id, 'data', e.data) order by e.id) from (select * from pulse_priv.v1_event x
   where x.org_id = current_org() and x.type <> 'webhook.ping' and (p_after is null or x.id > p_after) and v1_event_area(x.type) = any(p_areas)
    and (p_types is null or x.type = any(p_types)) and x.created_at < clock_timestamp() - interval '5 seconds'
   order by x.id limit least(greatest(p_take, 1), 101)) e), '[]');
end $$;

revoke all on function pulse.v1_event_emit(uuid,text,uuid,jsonb), pulse.v1_webhook_admin(), pulse.v1_webhook_out(pulse_priv.v1_webhook),
 pulse.v1_webhook_list(), pulse.v1_webhook_create(text,text[],text,text), pulse.v1_webhook_update(uuid,jsonb), pulse.v1_webhook_delete(uuid),
 pulse.v1_webhook_delivery_out(pulse_priv.v1_webhook_delivery), pulse.v1_webhook_deliveries(uuid,uuid,int,text), pulse.v1_webhook_redeliver(uuid,uuid), pulse.v1_webhook_recent(uuid),
 pulse.v1_webhook_ping(uuid), pulse.v1_webhook_due(int), pulse.v1_webhook_dispatch(uuid,uuid), pulse.v1_webhook_attempt(uuid,uuid,int,int,text),
 pulse.v1_event_prune(), pulse.v1_events_after(uuid,text[],text[],int) from public;
grant execute on function pulse.v1_webhook_list(), pulse.v1_webhook_create(text,text[],text,text), pulse.v1_webhook_update(uuid,jsonb), pulse.v1_webhook_delete(uuid),
 pulse.v1_webhook_deliveries(uuid,uuid,int,text), pulse.v1_webhook_redeliver(uuid,uuid), pulse.v1_webhook_recent(uuid), pulse.v1_webhook_ping(uuid), pulse.v1_events_after(uuid,text[],text[],int),
 pulse.v1_event_types(), pulse.v1_event_area(text) to pulse_api;
-- The delivery loop runs on the API's own pool (one company's transaction at a time) or a worker's.
grant execute on function pulse.v1_webhook_due(int), pulse.v1_webhook_dispatch(uuid,uuid), pulse.v1_webhook_attempt(uuid,uuid,int,int,text), pulse.v1_event_prune()
 to pulse_api, pulse_worker;

-- Webhooks: the per-tier cap stays as 1564 set it (free 0, pro 5, business 25, enterprise 100).

-- migrate:down
-- Forward only: drop the triggers to stop capture; the tables hold no data another table depends on.
