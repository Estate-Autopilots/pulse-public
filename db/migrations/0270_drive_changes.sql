-- migrate:up
-- R44 (11 Oct 2026): a direct Google Drive changes feed for approved roots, with durable cursors. Off by default: the
-- worker (collectors/gdrive_changes) runs only with PULSE_DRIVE_CHANGES=1 and reads only roots recorded here as
-- approved (owner errand E13); nothing replaces or re-enables the old production bootstrap.
--  * drive_source: one approved root (a shared drive, or a folder and everything below it), the Workspace account and
--    credential name it is read with (the credential itself stays in a file outside the database), its approval, and
--    its health: last checkpoint, lag, back-off, error code and the push channel that wakes the poller. A channel keeps
--    only the hash of its token. The page token itself is the worker's cursor in pulse.collector_cursor, which the API
--    cannot read.
--  * drive_source_file: the last accepted metadata of each file seen under a root and whether it is still available.
--    A deletion, a lost permission or a move out of the root changes `availability`; the row and every event already
--    accepted stay (no delete grant at all).
--  * drive_change: the normalized change journal. Its key (source, file, change time, metadata hash) commits in the
--    same transaction as the event, the file state and the cursor, so a replayed page is a no-op.
--  * drive_change_gap: a reviewed recovery after Google refused the stored cursor: who reviewed it, and the window in
--    which changes may have been missed, kept open until a reviewed rescan closes it. Nothing is reset or deleted.

create table pulse.drive_source (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 kind text not null check (kind in ('shared_drive','folder')),
 drive_id text check (drive_id ~ '^[A-Za-z0-9_-]{1,160}$'),
 root_id text check (root_id ~ '^[A-Za-z0-9_-]{1,160}$'),
 label text not null check (length(label) between 2 and 80),
 subject text check (subject ~ '^[^@\s]{1,64}@[^@\s]{1,190}$'),          -- Workspace account read as; null: the credential's own identity
 credential_ref text not null check (credential_ref ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
 approval_ref text check (length(approval_ref) between 3 and 200),
 approved_by uuid references pulse.person(id),
 approved_at timestamptz,
 enabled boolean not null default false,
 created_at timestamptz not null default now(),
 status text not null default 'new'
   check (status in ('new','ok','catching_up','rate_limited','error','access_lost','cursor_invalid')),
 last_poll_at timestamptz,
 last_checkpoint_at timestamptz,
 caught_up_at timestamptz,
 next_poll_at timestamptz,
 backoff_until timestamptz,
 failures int not null default 0 check (failures >= 0),
 error_code text check (error_code ~ '^[a-z_]{1,40}$'),
 error_at timestamptz,
 wake_at timestamptz,
 channel_id uuid unique,
 channel_resource text check (length(channel_resource) <= 200),
 channel_token_hash text check (channel_token_hash ~ '^[0-9a-f]{64}$'),
 channel_expires_at timestamptz,
 channel_error text check (channel_error ~ '^[a-z_]{1,40}$'),
 check ((kind = 'shared_drive' and drive_id is not null and root_id is null) or (kind = 'folder' and root_id is not null)),
 check (not enabled or (approved_by is not null and approved_at is not null and approval_ref is not null))
);
create unique index drive_source_root on pulse.drive_source (org_id, kind, coalesce(drive_id,''), coalesce(root_id,''));

create table pulse.drive_source_file (
 org_id uuid not null references pulse.org(id),
 source_id uuid not null references pulse.drive_source(id),
 file_id text not null check (file_id ~ '^[A-Za-z0-9_-]{1,160}$'),
 name text not null check (length(name) <= 500),
 mime text not null check (length(mime) <= 200),
 parents text[] not null default '{}',
 size bigint,
 md5 text,
 modified_at timestamptz,
 trashed boolean not null default false,
 meta_hash text not null check (meta_hash ~ '^[0-9a-f]{64}$'),
 availability text not null check (availability in ('available','trashed','removed','out_of_scope')),
 first_seen_at timestamptz not null default now(),
 last_change_at timestamptz not null,
 primary key (org_id, source_id, file_id)
);

create table pulse.drive_change (
 org_id uuid not null references pulse.org(id),
 source_id uuid not null references pulse.drive_source(id),
 change_key text not null check (change_key ~ '^[0-9a-f]{64}$'),
 file_id text not null,
 change_time timestamptz not null,
 kind text not null check (kind in ('created','updated','moved','renamed','trashed','restored','removed','out_of_scope','dead_letter')),
 event_id text,
 reason text check (reason ~ '^[a-z_]{1,40}$'),
 recorded_at timestamptz not null default now(),
 primary key (org_id, source_id, change_key)
);
create index drive_change_recent on pulse.drive_change (org_id, source_id, recorded_at desc);

create table pulse.drive_change_gap (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 source_id uuid not null references pulse.drive_source(id),
 reason text not null check (reason in ('cursor_invalid')),
 from_at timestamptz,                                  -- last committed checkpoint before the refusal
 to_at timestamptz not null,                           -- when the new cursor starts
 old_cursor_hash text check (old_cursor_hash ~ '^[0-9a-f]{64}$'),
 reviewed_by uuid not null references pulse.person(id),
 note text not null check (length(note) between 3 and 500),
 rescan text not null default 'open' check (rescan in ('open','done')),
 created_at timestamptz not null default now()
);

do $$ declare t text; begin
 foreach t in array array['drive_source','drive_source_file','drive_change','drive_change_gap'] loop
  execute format('alter table pulse.%I enable row level security', t);
  execute format('alter table pulse.%I force row level security', t);
  execute format('create policy tenant on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on pulse.%I from pulse_api', t);
  execute format('grant select, insert, update on pulse.%I to pulse_worker', t);
 end loop;
end $$;
-- The journal is append-only for the worker too.
revoke update on pulse.drive_change from pulse_worker;

-- Google's push notification for a channel: wakes the poller when the channel id and token match a live channel of
-- this tenant. The body of a Drive notification is always empty, so nothing else is read or stored.
create function pulse.drive_changes_wake(p_channel uuid, p_token_hash text, p_state text) returns boolean
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s uuid;
begin
 if p_state not in ('sync','change','add','remove','update','trash','untrash') then return false; end if;
 select id into s from drive_source
  where channel_id = p_channel and channel_token_hash = p_token_hash and enabled and channel_expires_at > now();
 if s is null then return false; end if;
 if p_state <> 'sync' then
  update drive_source set wake_at = now() where id = s;
  perform pg_notify('pulse_drive_changes', s::text);
 end if;
 return true;
end $$;

-- Health of every root for organisation admins: counts, times and codes only (no cursor, token, account or file name).
create function pulse.drive_changes_status() returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if not viewer_is('admin') then raise exception 'denied' using errcode = '42501'; end if;
 return jsonb_build_object('sources', coalesce((select jsonb_agg(jsonb_build_object(
   'id', s.id, 'kind', s.kind, 'label', s.label, 'enabled', s.enabled, 'approved', s.approved_at is not null,
   'status', s.status, 'errorCode', s.error_code, 'errorAt', s.error_at, 'failures', s.failures,
   'lastPollAt', s.last_poll_at, 'lastCheckpointAt', s.last_checkpoint_at, 'caughtUpAt', s.caught_up_at,
   'lagSeconds', case when s.caught_up_at is not null then greatest(0, extract(epoch from now() - s.caught_up_at))::int end,
   'backoffUntil', s.backoff_until,
   'channel', case when s.channel_error is not null then 'failed'
                   when s.channel_expires_at > now() then 'active' when s.channel_id is not null then 'expired' else 'none' end,
   'channelExpiresAt', case when s.channel_expires_at > now() then s.channel_expires_at end,
   'files', (select count(*) from drive_source_file f where f.source_id = s.id)::int,
   'unavailable', (select count(*) from drive_source_file f where f.source_id = s.id and f.availability <> 'available')::int,
   'deadLetters', (select count(*) from drive_change c where c.source_id = s.id and c.kind = 'dead_letter')::int,
   'openGaps', (select count(*) from drive_change_gap g where g.source_id = s.id and g.rescan = 'open')::int
  ) order by s.label) from drive_source s), '[]'::jsonb));
end $$;

revoke all on function pulse.drive_changes_wake(uuid, text, text), pulse.drive_changes_status() from public;
grant execute on function pulse.drive_changes_wake(uuid, text, text), pulse.drive_changes_status() to pulse_api;

-- migrate:down
-- Forward-only: accepted file states, the change journal and reviewed gaps are retained.
