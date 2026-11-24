-- migrate:up
-- R52 (12 Oct 2026): per-company connectors, contract connector.v1 (packages/schemas/connector/, docs/ops/CONNECTORS.md).
-- A company's sources are read with that company's own credential, granted by that company's admin, and land in that
-- company only. EA Connect (Pulse's Drive reader, R44's worker) is one implementation; a company's own plugin pushes
-- signed batches to the ingest service. Nothing here reads a source: ingestion stays off unless the server sets
-- PULSE_CONNECTORS=1 (and PULSE_DRIVE_CHANGES=1 for EA Connect) and the company's admin approved the install (E13/E18).
--  * connector_install: one connector a company admin installed: the manifest granted (and an upgrade waiting for a
--    grant), the scopes and entities granted, the name of its credential in that company's secret store (never the
--    secret; a plugin's public key, so Pulse holds no secret for it), the credential's fingerprint, who approved it
--    and when, and whether it was revoked. Revoked is final.
--  * connector_source: a root the admin selected (shared drive or folder), the entities it may carry, its approval, and
--    for a plugin the checkpoint of its last accepted batch. EA Connect's approved roots are R44 roots
--    (drive_source.install_id).
--  * connector_batch / connector_record: a plugin's accepted batches (a replayed batch id changes nothing) and each
--    record's idempotency key with its provenance (one record per key per root, ever).
--  * pulse_route.route gains 'connector' (install id -> company: the only way a pushed batch finds its company) and
--    'connector_credential' (a credential's fingerprint -> the one company it belongs to: the same Google service
--    account or plugin key is never installed for a second company).
-- The company is never read from a payload. Database guards: a Drive change or a plugin record is written only for an
-- active install (a revoke waits for a page in flight, then stops the next one), a Drive root without an install is
-- read only for the install's own company (its legacy credential is that company's), a plugin record only for an
-- entity granted to the install and selected for the root, and EA Connect roots never get a text-capture approval
-- (its manifest asks for metadata only).

alter table pulse_route.route drop constraint route_kind_check,
  add constraint route_kind_check check (kind in ('device','enrolment_code','hook','connector','connector_credential'));

-- The contract's lists, kept in step with packages/schemas/connector/manifest.v1.json (test_company_connectors).
create function pulse.connector_entities() returns text[] language sql immutable as $$
  select array['drive.file.created','drive.file.updated','drive.file.moved','drive.file.renamed','drive.file.trashed',
               'drive.folder.created'] $$;
create function pulse.connector_scopes() returns text[] language sql immutable as $$
  select array['https://www.googleapis.com/auth/drive.metadata.readonly'] $$;
create function pulse.connector_entity_scope(p_type text) returns text language sql immutable as $$
  select case when p_type = any(pulse.connector_entities()) then 'https://www.googleapis.com/auth/drive.metadata.readonly' end $$;

-- A connector.v1 manifest's shape and its approved lists (the API and the SDK validate the full JSON Schema first).
create function pulse.connector_manifest_ok(m jsonb) returns boolean
language plpgsql immutable set search_path = pulse, pg_temp as $$
begin
 if jsonb_typeof(m) is distinct from 'object' or m->>'contract' is distinct from 'connector.v1'
    or coalesce(m->>'key', '') !~ '^[a-z][a-z0-9-]{1,39}$'
    or coalesce(m->>'version', '') !~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'
    or length(coalesce(m->>'name', '')) not between 2 and 60 or length(coalesce(m->>'publisher', '')) not between 2 and 80
    or not ((m->>'transport' = 'pull' and m->>'auth' = 'google_service_account')
            or (m->>'transport' = 'push' and m->>'auth' = 'signed_push'))
    or jsonb_typeof(m->'scopes') is distinct from 'array' or jsonb_typeof(m->'sources') is distinct from 'array'
    or jsonb_typeof(m->'entities') is distinct from 'array' then
  return false;
 end if;
 -- Nothing else: no field can name a company, an account or a credential.
 if exists (select 1 from jsonb_object_keys(m) k
             where k not in ('contract','key','name','version','publisher','transport','auth','scopes','sources','entities')) then
  return false;
 end if;
 if jsonb_array_length(m->'scopes') not between 1 and 5 or jsonb_array_length(m->'sources') not between 1 and 2
    or jsonb_array_length(m->'entities') not between 1 and 20 then
  return false;
 end if;
 if exists (select 1 from jsonb_array_elements(m->'scopes') s
             where jsonb_typeof(s) <> 'object' or not coalesce(s->>'scope' = any(connector_scopes()), false)
                or length(coalesce(s->>'why', '')) not between 10 and 300
                or exists (select 1 from jsonb_object_keys(s) k where k not in ('scope','why')))
    or (select count(distinct s->>'scope') from jsonb_array_elements(m->'scopes') s) <> jsonb_array_length(m->'scopes')
    or exists (select 1 from jsonb_array_elements(m->'sources') k
                where jsonb_typeof(k) <> 'string' or k #>> '{}' not in ('shared_drive','folder'))
    or exists (select 1 from jsonb_array_elements(m->'entities') e
                where jsonb_typeof(e) <> 'object' or not coalesce(e->>'type' = any(connector_entities()), false)
                   or e->'schema' is distinct from '1'::jsonb
                   or exists (select 1 from jsonb_object_keys(e) k where k not in ('type','schema')))
    or (select count(distinct e->>'type') from jsonb_array_elements(m->'entities') e) <> jsonb_array_length(m->'entities')
    or exists (select 1 from jsonb_array_elements(m->'entities') e
                where connector_entity_scope(e->>'type') not in (select s->>'scope' from jsonb_array_elements(m->'scopes') s)) then
  return false;
 end if;
 return true;
end $$;

create table pulse.connector_install (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 implementation text not null check (implementation in ('ea_connect','plugin')),
 connector_key text not null check (connector_key ~ '^[a-z][a-z0-9-]{1,39}$'),
 label text not null check (length(label) between 2 and 80),
 manifest jsonb not null check (pulse.connector_manifest_ok(manifest)),
 proposed jsonb check (proposed is null or pulse.connector_manifest_ok(proposed)),  -- an upgrade waiting for a grant
 secret_ref text check (secret_ref ~ '^[a-z0-9][a-z0-9-]{0,39}$'),   -- name in this company's secret store, never the secret
 subject text check (subject ~ '^[^@\s]{1,64}@[^@\s]{1,190}$'),      -- Workspace account read as (the company's delegation)
 public_key text check (public_key ~ '^[A-Za-z0-9+/]{43}=$'),         -- a plugin's Ed25519 key: it signs, Pulse holds no secret
 credential_fingerprint text check (credential_fingerprint ~ '^[0-9a-f]{64}$'),
 granted_scopes text[] not null default '{}',
 granted_entities text[] not null default '{}',
 status text not null default 'preview' check (status in ('preview','active','revoked')),
 created_by uuid not null references pulse.person(id),
 created_at timestamptz not null default now(),
 approved_by uuid references pulse.person(id),
 approved_at timestamptz,
 approval_ref text check (length(approval_ref) between 3 and 200),
 revoked_by uuid references pulse.person(id),
 revoked_at timestamptz,
 revoke_reason text check (length(revoke_reason) between 3 and 300),
 last_batch_at timestamptz,
 unique (org_id, id),
 check (manifest->>'key' = connector_key and (proposed is null or proposed->>'key' = connector_key)),
 check ((implementation = 'ea_connect') = (connector_key = 'ea-connect')),
 check ((implementation = 'ea_connect') = (manifest->>'transport' = 'pull')),
 check (proposed is null or proposed->>'transport' = manifest->>'transport'),
 check (implementation <> 'ea_connect' or (secret_ref is not null and public_key is null)),
 check (implementation <> 'plugin' or (public_key is not null and credential_fingerprint is not null and secret_ref is null
                                       and subject is null)),
 check (granted_scopes <@ pulse.connector_scopes() and granted_entities <@ pulse.connector_entities()),
 check (status <> 'active' or (approved_by is not null and approved_at is not null and approval_ref is not null)),
 check ((status = 'revoked') = (revoked_by is not null and revoked_at is not null and revoke_reason is not null))
);
create unique index connector_install_live on pulse.connector_install (org_id, connector_key) where status <> 'revoked';

create table pulse.connector_source (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 install_id uuid not null,
 kind text not null check (kind in ('shared_drive','folder')),
 external_ref text not null check (external_ref ~ '^[A-Za-z0-9_-]{1,160}$'),   -- the company's own drive or folder id
 label text not null check (length(label) between 2 and 80),
 entities text[] not null check (cardinality(entities) between 1 and 20 and entities <@ pulse.connector_entities()),
 status text not null default 'selected' check (status in ('selected','approved','stopped')),
 selected_by uuid not null references pulse.person(id),
 selected_at timestamptz not null default now(),
 approved_by uuid references pulse.person(id),
 approved_at timestamptz,
 drive_source_id uuid,                                  -- EA Connect: the R44 root that reads it
 checkpoint text check (length(checkpoint) between 1 and 500),  -- a plugin's own position after its last batch
 checkpoint_at timestamptz,
 records int not null default 0 check (records >= 0),
 duplicates int not null default 0 check (duplicates >= 0),
 refused int not null default 0 check (refused >= 0),
 last_batch_at timestamptz,
 unique (org_id, id),
 unique (install_id, kind, external_ref),
 foreign key (org_id, install_id) references pulse.connector_install (org_id, id),
 check (status <> 'approved' or (approved_by is not null and approved_at is not null))
);

alter table pulse.drive_source add constraint drive_source_org_id unique (org_id, id),
  add column install_id uuid,
  add constraint drive_source_install foreign key (org_id, install_id) references pulse.connector_install (org_id, id);
alter table pulse.connector_source add constraint connector_source_drive
  foreign key (org_id, drive_source_id) references pulse.drive_source (org_id, id);
create unique index connector_source_drive_once on pulse.connector_source (drive_source_id) where drive_source_id is not null;

create table pulse.connector_batch (
 org_id uuid not null references pulse.org(id),
 source_id uuid not null,
 batch_id text not null check (batch_id ~ '^[A-Za-z0-9._:-]{1,80}$'),
 manifest_version text not null check (manifest_version ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'),
 cursor_from_hash text check (cursor_from_hash ~ '^[0-9a-f]{64}$'),
 cursor_to_hash text not null check (cursor_to_hash ~ '^[0-9a-f]{64}$'),
 records int not null check (records >= 0),
 accepted int not null check (accepted >= 0),
 duplicates int not null check (duplicates >= 0),
 refused int not null check (refused >= 0),
 received_at timestamptz not null default now(),
 primary key (org_id, source_id, batch_id),
 foreign key (org_id, source_id) references pulse.connector_source (org_id, id)
);

create table pulse.connector_record (
 org_id uuid not null references pulse.org(id),
 source_id uuid not null,
 record_key text not null check (record_key ~ '^[0-9a-f]{64}$'),
 entity text not null,
 item text not null check (item ~ '^[A-Za-z0-9_-]{1,160}$'),
 record_time timestamptz not null,
 event_id text not null,
 batch_id text not null,
 provenance jsonb not null check (jsonb_typeof(provenance) = 'object'
   and provenance ?& array['system','ref','observedAt'] and provenance - array['system','ref','observedAt'] = '{}'::jsonb),
 recorded_at timestamptz not null default now(),
 primary key (org_id, source_id, record_key),
 foreign key (org_id, source_id) references pulse.connector_source (org_id, id)
);

do $$ declare t text; begin
 foreach t in array array['connector_install','connector_source','connector_batch','connector_record'] loop
  execute format('alter table pulse.%I enable row level security', t);
  execute format('alter table pulse.%I force row level security', t);
  execute format('create policy tenant on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on pulse.%I from pulse_api', t);
 end loop;
end $$;
-- The worker reads installs and roots (EA Connect's credential binding); the ingest service accepts plugin batches.
grant select on pulse.connector_install, pulse.connector_source to pulse_worker, pulse_ingest;
grant update (checkpoint, checkpoint_at, records, duplicates, refused, last_batch_at) on pulse.connector_source to pulse_ingest;
grant update (last_batch_at) on pulse.connector_install to pulse_ingest;
grant select, insert on pulse.connector_batch, pulse.connector_record to pulse_ingest;

-- ------------------------------------------------------------------------------------------------------ guards
-- A credential belongs to one company: its fingerprint (a Google service account's address, or a plugin's public key,
-- hashed) is claimed by the first company that installs it, and any other company is refused.
create function pulse.connector_claim_credential() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare held uuid;
begin
 if new.credential_fingerprint is null then return new; end if;
 insert into pulse_route.route (kind, route_key, org_id) values ('connector_credential', new.credential_fingerprint, new.org_id)
 on conflict (kind, route_key) do nothing;
 select org_id into held from pulse_route.route where kind = 'connector_credential' and route_key = new.credential_fingerprint;
 if held <> new.org_id then
  raise exception 'credential_elsewhere: this credential belongs to another company''s connector' using errcode = '42501';
 end if;
 return new;
end $$;
create trigger connector_claim_credential before insert or update of credential_fingerprint on pulse.connector_install
 for each row execute function pulse.connector_claim_credential();

-- A plugin finds its company only through its install id.
create function pulse.connector_route() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if new.implementation = 'plugin' then
  insert into pulse_route.route (kind, route_key, org_id) values ('connector', new.id::text, new.org_id);
 end if;
 return null;
end $$;
create trigger connector_route after insert on pulse.connector_install for each row execute function pulse.connector_route();

create function pulse.connector_install_guard() returns trigger
language plpgsql set search_path = pulse, pg_temp as $$
begin
 if old.status = 'revoked' then
  raise exception 'connector_revoked: a revoked connector stays revoked; install it again' using errcode = '55000';
 end if;
 if new.org_id <> old.org_id or new.implementation <> old.implementation or new.connector_key <> old.connector_key
    or new.created_by <> old.created_by or new.created_at <> old.created_at
    or new.public_key is distinct from old.public_key then
  raise exception 'a connector''s company, kind, creator and key do not change' using errcode = '42501';
 end if;
 if new.status = 'preview' and old.status <> 'preview' then
  raise exception 'an approved connector is revoked, not returned to preview' using errcode = '55000';
 end if;
 return new;
end $$;
create trigger connector_install_guard before update on pulse.connector_install
 for each row execute function pulse.connector_install_guard();

-- Revoking stops everything at once: the push route expires, EA Connect's roots are switched off and every selected
-- root is stopped. Accepted events, files and records stay.
create function pulse.connector_install_revoked() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 update pulse_route.route set expires_at = new.revoked_at where kind = 'connector' and route_key = new.id::text;
 update drive_source set enabled = false where install_id = new.id and enabled;
 update connector_source set status = 'stopped' where install_id = new.id and status <> 'stopped';
 return null;
end $$;
create trigger connector_install_revoked after update of status on pulse.connector_install
 for each row when (new.status = 'revoked' and old.status <> 'revoked') execute function pulse.connector_install_revoked();

-- A Drive change is written only for a root that is the install company's own (no install), or whose install is
-- active. FOR SHARE makes a revoke wait for a page in flight; the next page sees it and rolls back whole.
create function pulse.drive_change_bound() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s record; st text;
begin
 select org_id, install_id into s from drive_source where id = new.source_id;
 if s.install_id is null then
  if s.org_id is distinct from pulse.install_org() then
   raise exception 'credential_unbound: a Drive root without a connector is read for the install''s own company only'
     using errcode = '42501';
  end if;
  return new;
 end if;
 select status into st from connector_install where id = s.install_id for share;
 if st is distinct from 'active' then
  raise exception 'connector_revoked: this root''s connector is not active' using errcode = '42501';
 end if;
 return new;
end $$;
create trigger drive_change_bound before insert on pulse.drive_change for each row execute function pulse.drive_change_bound();

-- A plugin record needs an active install, an approved root, and an entity granted to the install and selected for
-- the root.
create function pulse.connector_record_bound() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r record;
begin
 select i.status as install_status, s.status as source_status, i.granted_entities, s.entities into r
   from connector_source s join connector_install i on i.id = s.install_id where s.id = new.source_id for share of i;
 if r.install_status is distinct from 'active' or r.source_status is distinct from 'approved' then
  raise exception 'connector_revoked: this root''s connector is not active' using errcode = '42501';
 end if;
 if not (new.entity = any(r.granted_entities) and new.entity = any(r.entities)) then
  raise exception 'entity_not_granted: % is not granted for this root', new.entity using errcode = '42501';
 end if;
 return new;
end $$;
create trigger connector_record_bound before insert on pulse.connector_record
 for each row execute function pulse.connector_record_bound();

-- EA Connect v1 asks for metadata only: its roots never get a document-text (R45) approval.
create function pulse.drive_extract_unbound() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if new.enabled and exists (select 1 from drive_source where id = new.source_id and install_id is not null) then
  raise exception 'scope_not_granted: this root''s connector reads Drive metadata only' using errcode = '42501';
 end if;
 return new;
end $$;
create trigger drive_extract_unbound before insert or update on pulse.drive_extract_policy
 for each row execute function pulse.drive_extract_unbound();

-- ------------------------------------------------------------------------------------------- admin functions
create function pulse.connector_admin() returns uuid
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if pulse.current_viewer() is null or not pulse.viewer_is('admin') then
  raise exception 'company admins manage connectors' using errcode = '42501';
 end if;
 return pulse.current_viewer();
end $$;

create function pulse.connector_text_array(p jsonb) returns text[] language sql immutable as $$
  select case when jsonb_typeof(p) = 'array' then coalesce(array(select distinct x from jsonb_array_elements_text(p) x order by 1), '{}') end $$;

create function pulse.connector_entity_types(m jsonb) returns text[] language sql immutable as $$
  select coalesce(array(select e->>'type' from jsonb_array_elements(m->'entities') e order by 1), '{}') $$;

create function pulse.connector_scope_list(m jsonb) returns text[] language sql immutable as $$
  select coalesce(array(select s->>'scope' from jsonb_array_elements(m->'scopes') s order by 1), '{}') $$;

-- Install a connector for this company (status preview: nothing is read until approved). The API passes Pulse's own
-- EA Connect manifest, or the company plugin's manifest and public key; the company comes from the session.
create function pulse.connector_create(p jsonb) returns uuid
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := connector_admin(); impl text := p->>'implementation'; m jsonb := p->'manifest'; i uuid;
begin
 if impl is null or impl not in ('ea_connect','plugin') then
  raise exception 'implementation is ea_connect or plugin' using errcode = '22023';
 end if;
 if not connector_manifest_ok(m) then raise exception 'manifest_invalid' using errcode = '22023'; end if;
 if (impl = 'plugin') <> (m->>'transport' = 'push') then
  raise exception 'Pulse runs only its own readers; a company plugin pushes signed batches' using errcode = '22023';
 end if;
 insert into connector_install (org_id, implementation, connector_key, label, manifest, secret_ref, subject, public_key,
                                credential_fingerprint, created_by)
 values (current_org(), impl, m->>'key', btrim(coalesce(p->>'label', m->>'name')), m,
         case when impl = 'ea_connect' then nullif(btrim(p->>'secretRef'), '') end,
         case when impl = 'ea_connect' then nullif(lower(btrim(p->>'subject')), '') end,
         case when impl = 'plugin' then p->>'publicKey' end,
         case when impl = 'plugin' then encode(sha256(convert_to('ed25519:' || (p->>'publicKey'), 'UTF8')), 'hex') end, v)
 returning id into i;
 return i;
end $$;

-- Select a root of the company's own Drive and the entities it may carry (default: everything the manifest lists).
create function pulse.connector_source_add(p_install uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := connector_admin(); i connector_install; m jsonb; wanted text[]; s uuid;
begin
 select * into i from connector_install where id = p_install for update;
 if not found then raise exception 'no such connector in this company' using errcode = 'P0002'; end if;
 if i.status = 'revoked' then raise exception 'connector_revoked: this connector was revoked' using errcode = '55000'; end if;
 m := coalesce(i.proposed, i.manifest);
 if not coalesce(m->'sources' ? (p->>'kind'), false) then
  raise exception 'This connector reads % only', (select string_agg(x, ' and ') from jsonb_array_elements_text(m->'sources') x)
    using errcode = '22023';
 end if;
 wanted := coalesce(connector_text_array(p->'entities'), connector_entity_types(m));
 if cardinality(wanted) = 0 or not wanted <@ connector_entity_types(m) then
  raise exception 'Choose entities this connector''s manifest lists' using errcode = '22023';
 end if;
 insert into connector_source (org_id, install_id, kind, external_ref, label, entities, selected_by)
 values (current_org(), i.id, p->>'kind', btrim(p->>'ref'), btrim(p->>'label'), wanted, v) returning id into s;
 return s;
end $$;

-- An upgrade (a new manifest version) waits for the admin's grant; the granted manifest keeps applying meanwhile.
create function pulse.connector_propose(p_install uuid, m jsonb) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := connector_admin(); i connector_install;
begin
 select * into i from connector_install where id = p_install for update;
 if not found then raise exception 'no such connector in this company' using errcode = 'P0002'; end if;
 if i.status = 'revoked' then raise exception 'connector_revoked: this connector was revoked' using errcode = '55000'; end if;
 if not connector_manifest_ok(m) or m->>'key' <> i.connector_key or m->>'transport' <> i.manifest->>'transport' then
  raise exception 'manifest_invalid: an upgrade keeps the connector''s key and transport' using errcode = '22023';
 end if;
 if string_to_array(m->>'version', '.')::int[] <= string_to_array(i.manifest->>'version', '.')::int[] then
  raise exception 'manifest_version: an upgrade has a higher version than %', i.manifest->>'version' using errcode = '22023';
 end if;
 update connector_install set proposed = m where id = i.id;
 return jsonb_build_object('from', i.manifest->>'version', 'to', m->>'version', 'by', v,
   'newScopes', to_jsonb(array(select unnest(connector_scope_list(m)) except select unnest(i.granted_scopes) order by 1)),
   'newEntities', to_jsonb(array(select unnest(connector_entity_types(m)) except select unnest(i.granted_entities) order by 1)));
end $$;

-- The company admin's grant: the scopes and entities granted (a subset of the manifest, an upgrade's if one waits),
-- where the approval is recorded, and every selected root. EA Connect needs its credential installed first; each
-- approved root becomes an R44 root bound to this install (a root the company already reads without a connector is
-- moved onto it, keeping its cursor).
create function pulse.connector_approve(p_install uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := connector_admin(); i connector_install; m jsonb; scopes text[]; ents text[];
        ref text := btrim(coalesce(p->>'approvalRef', '')); s record; ds uuid; missing text;
begin
 select * into i from connector_install where id = p_install for update;
 if not found then raise exception 'no such connector in this company' using errcode = 'P0002'; end if;
 if i.status = 'revoked' then raise exception 'connector_revoked: this connector was revoked' using errcode = '55000'; end if;
 m := coalesce(i.proposed, i.manifest);
 scopes := coalesce(connector_text_array(p->'scopes'), '{}');
 ents := coalesce(connector_text_array(p->'entities'), '{}');
 if length(ref) not between 3 and 200 then
  raise exception 'Say where the approval is recorded (3 to 200 characters)' using errcode = '22023';
 end if;
 if not scopes <@ connector_scope_list(m) then raise exception 'Grant only scopes the manifest asks for' using errcode = '22023'; end if;
 if cardinality(ents) = 0 or not ents <@ connector_entity_types(m) then
  raise exception 'Grant at least one entity the manifest lists' using errcode = '22023';
 end if;
 select string_agg(e, ', ') into missing from unnest(ents) e where connector_entity_scope(e) <> all(scopes);
 if missing is not null then
  raise exception 'scope_not_granted: % needs %', missing, connector_entity_scope(split_part(missing, ', ', 1)) using errcode = '22023';
 end if;
 if i.implementation = 'ea_connect' and i.credential_fingerprint is null then
  raise exception 'secret_missing: the company''s Google credential is not installed in its secret store yet' using errcode = '55000';
 end if;
 if not exists (select 1 from connector_source where install_id = i.id and status in ('selected','approved')) then
  raise exception 'Select at least one root first' using errcode = '55000';
 end if;
 update connector_install set manifest = m, proposed = null, granted_scopes = scopes, granted_entities = ents,
        status = 'active', approved_by = v, approved_at = now(), approval_ref = ref where id = i.id;
 update connector_source set status = 'approved', approved_by = v, approved_at = now() where install_id = i.id and status = 'selected';
 if i.implementation = 'ea_connect' then
  for s in select * from connector_source where install_id = i.id and status = 'approved' loop
   ds := null;                                         -- a skipped conflict update returns no row
   insert into drive_source (org_id, kind, drive_id, root_id, label, subject, credential_ref, approval_ref, approved_by,
                             approved_at, enabled, install_id, next_poll_at)
   values (i.org_id, s.kind, case when s.kind = 'shared_drive' then s.external_ref end,
           case when s.kind = 'folder' then s.external_ref end, s.label, i.subject, i.secret_ref, ref, v, now(), true, i.id, now())
   on conflict (org_id, kind, coalesce(drive_id, ''), coalesce(root_id, '')) do update
     set install_id = excluded.install_id, subject = excluded.subject, credential_ref = excluded.credential_ref,
         approval_ref = excluded.approval_ref, approved_by = excluded.approved_by, approved_at = excluded.approved_at,
         enabled = true, next_poll_at = now()
     where drive_source.install_id is null or drive_source.install_id = excluded.install_id
   returning id into ds;
   if ds is null then
    raise exception 'root_taken: % is read by another connector of this company', s.label using errcode = '23505';
   end if;
   update connector_source set drive_source_id = ds where id = s.id;
  end loop;
 end if;
 return jsonb_build_object('status', 'active', 'version', m->>'version');
end $$;

create function pulse.connector_revoke(p_install uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := connector_admin(); i connector_install; why text := btrim(coalesce(p_reason, ''));
begin
 select * into i from connector_install where id = p_install for update;
 if not found then raise exception 'no such connector in this company' using errcode = 'P0002'; end if;
 if i.status = 'revoked' then raise exception 'connector_revoked: this connector was already revoked' using errcode = '55000'; end if;
 if length(why) not between 3 and 300 then raise exception 'Give a reason (3 to 300 characters)' using errcode = '22023'; end if;
 update connector_install set status = 'revoked', revoked_by = v, revoked_at = now(), revoke_reason = why where id = i.id;
 return jsonb_build_object('status', 'revoked');
end $$;

-- The operator's secret step (pulse-connect secret): the credential file now sits in this company's secret store under
-- the install's reference; only its fingerprint reaches the database, and it is claimed for this company.
create function pulse.connector_secret_installed(p_install uuid, p_fingerprint text) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare i connector_install;
begin
 select * into i from connector_install where id = p_install for update;
 if not found then raise exception 'no such connector in this company' using errcode = 'P0002'; end if;
 if i.implementation <> 'ea_connect' then raise exception 'a plugin holds its own key' using errcode = '22023'; end if;
 if i.status = 'revoked' then raise exception 'connector_revoked: this connector was revoked' using errcode = '55000'; end if;
 update connector_install set credential_fingerprint = p_fingerprint where id = i.id;
end $$;

-- What an admin sees: each connector, what it asks for and what was granted, what is missing, its credential's reference
-- (never the secret) and every selected root with its rights and cursor health. No cursor value, token, account or
-- file name.
create function pulse.connector_status() returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 perform connector_admin();
 return coalesce((select jsonb_agg(x order by x->>'createdAt') from (
  select jsonb_build_object(
   'id', i.id, 'implementation', i.implementation, 'key', i.connector_key, 'label', i.label,
   'name', i.manifest->>'name', 'publisher', i.manifest->>'publisher', 'version', i.manifest->>'version',
   'transport', i.manifest->>'transport', 'auth', i.manifest->>'auth', 'status', i.status, 'createdAt', i.created_at,
   'approvedAt', i.approved_at, 'approvalRef', i.approval_ref, 'revokedAt', i.revoked_at, 'revokeReason', i.revoke_reason,
   'credential', jsonb_build_object('ref', i.secret_ref, 'installed', i.credential_fingerprint is not null,
                                    'id', left(i.credential_fingerprint, 12), 'delegated', i.subject is not null,
                                    'kind', case i.implementation when 'plugin' then 'ed25519' else 'google_service_account' end),
   'scopes', (select coalesce(jsonb_agg(jsonb_build_object('scope', s->>'scope', 'why', s->>'why',
                                                           'granted', s->>'scope' = any(i.granted_scopes)) order by s->>'scope'), '[]')
                from jsonb_array_elements(i.manifest->'scopes') s),
   'entities', (select coalesce(jsonb_agg(jsonb_build_object('type', e->>'type', 'schema', (e->>'schema')::int,
                                                             'granted', e->>'type' = any(i.granted_entities)) order by e->>'type'), '[]')
                  from jsonb_array_elements(i.manifest->'entities') e),
   'missingScopes', to_jsonb(array(select unnest(connector_scope_list(i.manifest)) except select unnest(i.granted_scopes) order by 1)),
   'missingEntities', to_jsonb(array(select unnest(connector_entity_types(i.manifest)) except select unnest(i.granted_entities) order by 1)),
   'proposed', case when i.proposed is not null then jsonb_build_object('version', i.proposed->>'version',
     'newScopes', to_jsonb(array(select unnest(connector_scope_list(i.proposed)) except select unnest(i.granted_scopes) order by 1)),
     'newEntities', to_jsonb(array(select unnest(connector_entity_types(i.proposed)) except select unnest(i.granted_entities) order by 1))) end,
   'lastBatchAt', i.last_batch_at,
   'sources', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'kind', s.kind, 'ref', s.external_ref, 'label', s.label, 'status', s.status, 'approvedAt', s.approved_at,
      'rights', to_jsonb(array(select unnest(s.entities) intersect select unnest(i.granted_entities) order by 1)),
      'notGranted', to_jsonb(array(select unnest(s.entities) except select unnest(i.granted_entities) order by 1)),
      'cursor', case when i.implementation = 'ea_connect' then (
          select jsonb_build_object('stored', exists (select 1 from collector_cursor c where c.collector = 'gdrive_changes'
                                                        and c.scope_key = d.id::text),
            'reading', d.enabled, 'status', d.status, 'errorCode', d.error_code, 'lastCheckpointAt', d.last_checkpoint_at,
            'lagSeconds', case when d.caught_up_at is not null then greatest(0, extract(epoch from now() - d.caught_up_at))::int end,
            'files', (select count(*) from drive_source_file f where f.source_id = d.id)::int,
            'unavailable', (select count(*) from drive_source_file f where f.source_id = d.id and f.availability <> 'available')::int,
            'openGaps', (select count(*) from drive_change_gap g where g.source_id = d.id and g.rescan = 'open')::int)
          from drive_source d where d.id = s.drive_source_id)
        else jsonb_build_object('stored', s.checkpoint is not null, 'reading', s.status = 'approved' and i.status = 'active',
            'lastCheckpointAt', s.checkpoint_at, 'records', s.records, 'duplicates', s.duplicates, 'refused', s.refused,
            'lastBatchAt', s.last_batch_at) end
    ) order by s.label), '[]') from connector_source s where s.install_id = i.id)
  ) x from connector_install i) q), '[]'::jsonb);
end $$;

revoke all on function pulse.connector_entities(), pulse.connector_scopes(), pulse.connector_entity_scope(text),
  pulse.connector_manifest_ok(jsonb), pulse.connector_claim_credential(), pulse.connector_route(),
  pulse.connector_install_guard(), pulse.connector_install_revoked(), pulse.drive_change_bound(),
  pulse.connector_record_bound(), pulse.drive_extract_unbound(), pulse.connector_admin(), pulse.connector_text_array(jsonb),
  pulse.connector_entity_types(jsonb), pulse.connector_scope_list(jsonb), pulse.connector_create(jsonb),
  pulse.connector_source_add(uuid, jsonb), pulse.connector_propose(uuid, jsonb), pulse.connector_approve(uuid, jsonb),
  pulse.connector_revoke(uuid, text), pulse.connector_secret_installed(uuid, text), pulse.connector_status() from public;
grant execute on function pulse.connector_entities(), pulse.connector_scopes(), pulse.connector_entity_scope(text),
  pulse.connector_manifest_ok(jsonb) to pulse_api, pulse_worker, pulse_ingest;
grant execute on function pulse.connector_create(jsonb), pulse.connector_source_add(uuid, jsonb),
  pulse.connector_propose(uuid, jsonb), pulse.connector_approve(uuid, jsonb), pulse.connector_revoke(uuid, text),
  pulse.connector_status() to pulse_api;
grant execute on function pulse.connector_secret_installed(uuid, text) to pulse_worker;

-- migrate:down
-- Forward-only: installs, grants, revocations, accepted batches and records are retained.
