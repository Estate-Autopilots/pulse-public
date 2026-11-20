-- migrate:up
-- R47 (12 Oct 2026): past WhatsApp chats from a text export, as read-only history inside a Pulse conversation.
-- The preview reads the export in the browser (the file is not sent anywhere). An admin who is a member of the target
-- conversation then imports it with the owner's recorded approval (owner errands E08/E15: the company's right to
-- import, the participant map, retention, text only); the API reads the same file again with the same reader
-- (@pulse/chat-export) and writes here. Real imports stay off until PULSE_CHAT_IMPORT=1 and those approvals exist.
--  * chat_import_batch: one imported export: its conversation, provenance (reader, SHA-256 and size of the file, the
--    exporting phone's time zone and date order, counts), the participant decisions (a person, or a name or masked
--    number kept as written), the approval reference and retention proposal, who imported it and a withdrawal.
--  * chat_import_message: the imported text and media placeholders (never a file, file name or transcription), one row
--    per message with a stable import key per conversation, so a repeated or overlapping export adds only what is new.
-- Who reads: the conversation's current members only (chat_history_reader: membership itself, not chat_has, which also
-- lets an admin moderate groups they are not in), through chat_history(); never a role (admin, HR, leadership). Both tables are in pulse_priv with no grant to any runtime role, so worker, ingest, privacy
-- and model jobs cannot read them (ADR-0028: no relationship, skill, coach or analytics feed). chat_prune does not
-- touch them (no purge is authorised; retention is a proposal recorded per batch). An import writes no notification,
-- chat event, unread count or search entry. Nothing is deleted: a withdrawn batch is hidden from every read.
-- Only conversations whose members people chose take history (a group someone made, a direct chat): never a pod, team
-- or Google group, whose members follow the roster and roles.

create table pulse_priv.chat_import_batch (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 channel_id uuid not null,
 source text not null default 'whatsapp_text' check (source = 'whatsapp_text'),
 parser text not null check (parser ~ '^whatsapp-text/[0-9]{1,3}$'),
 file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
 file_bytes int not null check (file_bytes between 1 and 8388608),
 time_zone text not null check (length(time_zone) between 1 and 64),
 date_order text not null check (date_order in ('dmy', 'mdy', 'ymd')),
 stats jsonb not null check (jsonb_typeof(stats) = 'object'),
 participants jsonb not null check (jsonb_typeof(participants) = 'array'),
 scope text not null default 'text' check (scope = 'text'),
 approval_ref text not null check (length(approval_ref) between 3 and 200),
 retention_note text not null check (length(retention_note) between 3 and 300),   -- a proposal for legal review; no purge
 approved_by uuid not null references pulse.person(id),
 approved_at timestamptz not null default now(),
 added int not null default 0 check (added >= 0),
 duplicates int not null default 0 check (duplicates >= 0),
 withdrawn_by uuid references pulse.person(id),
 withdrawn_at timestamptz,
 withdrawn_note text check (length(withdrawn_note) between 3 and 300),
 unique (org_id, id, channel_id),
 unique (org_id, channel_id, file_sha256),
 foreign key (org_id, channel_id) references pulse.chat_channel (org_id, id),
 check ((withdrawn_at is null) = (withdrawn_by is null) and (withdrawn_at is null) = (withdrawn_note is null))
);

create table pulse_priv.chat_import_message (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 seq bigint generated always as identity,
 batch_id uuid not null,
 channel_id uuid not null,
 import_key text not null check (import_key ~ '^[0-9a-f]{64}$'),
 sent_at timestamptz not null,
 local_time text not null check (local_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$'),  -- as the phone wrote it
 time_exact boolean not null default true,                     -- false: around a clock change (happened twice or never)
 line int not null check (line > 0),
 author_id uuid references pulse.person(id),
 author_label text not null check (length(author_label) between 1 and 80),
 kind text not null check (kind in ('text', 'media')),
 body text not null check (length(body) <= 12000),
 edited boolean not null default false,
 unique (org_id, channel_id, import_key),
 foreign key (org_id, batch_id, channel_id) references pulse_priv.chat_import_batch (org_id, id, channel_id),
 check (kind = 'media' or length(body) > 0)
);
create index chat_import_message_read on pulse_priv.chat_import_message (org_id, channel_id, sent_at desc, seq desc);
create index chat_import_message_batch on pulse_priv.chat_import_message (org_id, batch_id);

do $$ declare t text; begin
 foreach t in array array['pulse_priv.chat_import_batch', 'pulse_priv.chat_import_message'] loop
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on %s from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
 end loop;
end $$;
create trigger audit_mutation after insert or update on pulse_priv.chat_import_batch for each row execute function pulse.audit_mutation();

-- Membership itself: an active staff viewer who is a member. chat_has also opens groups to admins for moderation;
-- imported history never follows a role.
create function pulse.chat_history_reader(p_channel uuid) returns boolean
language sql stable security definer set search_path = pulse, pg_temp as $$
 select chat_active() and exists (select 1 from chat_member where org_id = current_org() and channel_id = p_channel and person_id = current_viewer())
$$;

-- Why the viewer cannot import into a conversation, or null when they can.
create function pulse.chat_import_refusal(p_channel uuid) returns text
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case
  when not viewer_is('admin') then 'Only an admin imports chat history: the owner operates real imports'
  when not chat_history_reader(p_channel) then 'Import only into a conversation you are a member of'
  when (select kind from chat_channel where org_id = current_org() and id = p_channel) not in ('custom', 'direct')
   then 'History goes only into a group someone made or a direct chat, never a pod, team or Google group'
 end
$$;

-- One approved export into one conversation. The API passes what the reader found: the batch (provenance, the
-- participant decisions, the approval) and the messages to keep (text and media placeholders of senders not skipped).
create function pulse.chat_import(p_channel uuid, p_batch jsonb, p_messages jsonb) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare refusal text := chat_import_refusal(p_channel); batch uuid; total int; n int;
begin
 if refusal is not null then raise exception '%', refusal using errcode = '42501'; end if;
 if jsonb_typeof(p_messages) is distinct from 'array' or jsonb_array_length(p_messages) = 0 then
  raise exception 'Nothing to import: the export has no messages from the senders you kept' using errcode = '22023'; end if;
 if exists (select 1 from pulse_priv.chat_import_batch where org_id = current_org() and channel_id = p_channel and file_sha256 = p_batch->>'fileSha256') then
  raise exception 'This export was already imported into this conversation' using errcode = '23505'; end if;
 if exists (select 1 from jsonb_array_elements(p_messages) m where m->>'author' is not null
   and not exists (select 1 from person p where p.org_id = current_org() and p.id = (m->>'author')::uuid and p.side = 'staff')) then
  raise exception 'Choose a colleague of this company for every sender you map' using errcode = '22023'; end if;
 insert into pulse_priv.chat_import_batch (org_id, channel_id, parser, file_sha256, file_bytes, time_zone, date_order, stats, participants,
   approval_ref, retention_note, approved_by)
 values (current_org(), p_channel, p_batch->>'parser', p_batch->>'fileSha256', (p_batch->>'fileBytes')::int, p_batch->>'timeZone',
   p_batch->>'dateOrder', p_batch->'stats', p_batch->'participants', trim(p_batch->>'approvalRef'), trim(p_batch->>'retentionNote'), current_viewer())
 returning id into batch;
 insert into pulse_priv.chat_import_message (org_id, batch_id, channel_id, import_key, sent_at, local_time, time_exact, line, author_id,
   author_label, kind, body, edited)
 select current_org(), batch, p_channel, m.key, m.at, m.local, m.exact, m.line, m.author, m.label, m.kind, m.body, m.edited
 from jsonb_to_recordset(p_messages) as m(key text, at timestamptz, local text, exact boolean, line int, author uuid, label text,
   kind text, body text, edited boolean)
 order by m.line
 on conflict (org_id, channel_id, import_key) do nothing;
 get diagnostics n = row_count;
 total := jsonb_array_length(p_messages);
 update pulse_priv.chat_import_batch set added = n, duplicates = total - n where id = batch;
 perform audit_write('import', 'chat_history', batch::text, array['channel_id', 'added', 'duplicates']);
 return jsonb_build_object('id', batch, 'added', n, 'duplicates', total - n);
end $$;

-- Imported history of a conversation, newest first, for its current members only. Cursor: (sent_at, seq).
create function pulse.chat_history(p_channel uuid, p_before_at timestamptz default null, p_before_seq bigint default null, p_limit int default 60)
returns table (id uuid, seq bigint, sent_at timestamptz, local_time text, time_exact boolean, author_id uuid, author_name text,
  author_label text, kind text, body text, edited boolean, batch_id uuid)
language sql stable security definer set search_path = pulse, pg_temp as $$
 select m.id, m.seq, m.sent_at, m.local_time, m.time_exact, m.author_id, p.display_name, m.author_label, m.kind, m.body, m.edited, m.batch_id
 from pulse_priv.chat_import_message m
 join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
 left join person p on p.org_id = m.org_id and p.id = m.author_id
 where m.org_id = current_org() and m.channel_id = p_channel and chat_history_reader(p_channel)
  and (p_before_at is null or (m.sent_at, m.seq) < (p_before_at, coalesce(p_before_seq, 9223372036854775807)))
 order by m.sent_at desc, m.seq desc
 limit greatest(1, least(coalesce(p_limit, 60), 200))
$$;

-- How many imported messages a member can read in a conversation (0 for anyone else).
create function pulse.chat_history_count(p_channel uuid) returns int
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when chat_history_reader(p_channel) then (select count(*)::int from pulse_priv.chat_import_message m
  join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
  where m.org_id = current_org() and m.channel_id = p_channel) else 0 end
$$;

-- Imports, without any message text: a conversation's members see its own; admins see every import's provenance.
create function pulse.chat_import_batches(p_channel uuid default null) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'channelId', b.channel_id, 'channel', ch.name, 'kind', ch.kind,
   'parser', b.parser, 'fileSha256', b.file_sha256, 'fileBytes', b.file_bytes, 'timeZone', b.time_zone, 'dateOrder', b.date_order,
   'stats', b.stats, 'participants', jsonb_array_length(b.participants), 'approvalRef', b.approval_ref, 'retentionNote', b.retention_note,
   'approvedBy', ap.display_name, 'approvedAt', b.approved_at, 'added', b.added, 'duplicates', b.duplicates,
   'withdrawnBy', wd.display_name, 'withdrawnAt', b.withdrawn_at, 'withdrawnNote', b.withdrawn_note, 'member', chat_history_reader(b.channel_id))
   order by b.approved_at desc), '[]'::jsonb)
 from pulse_priv.chat_import_batch b join chat_channel ch on ch.org_id = b.org_id and ch.id = b.channel_id
 join person ap on ap.id = b.approved_by left join person wd on wd.id = b.withdrawn_by
 where b.org_id = current_org() and (p_channel is null or b.channel_id = p_channel)
  and (case when p_channel is null then viewer_is('admin') else chat_history_reader(p_channel) end)
$$;

-- Hide an imported batch from every read (an admin, with a reason). Its rows stay; nothing is deleted.
create function pulse.chat_import_withdraw(p_batch uuid, p_note text) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if not viewer_is('admin') then raise exception 'Only an admin withdraws imported history' using errcode = '42501'; end if;
 if length(trim(coalesce(p_note, ''))) not between 3 and 300 then raise exception 'Say why in 3 to 300 characters' using errcode = '22023'; end if;
 update pulse_priv.chat_import_batch set withdrawn_by = current_viewer(), withdrawn_at = now(), withdrawn_note = trim(p_note)
 where org_id = current_org() and id = p_batch and withdrawn_at is null;
 if not found then raise exception 'Import unavailable or already withdrawn' using errcode = '42501'; end if;
 perform audit_write('withdraw', 'chat_history', p_batch::text, array['withdrawn_at']);
end $$;

revoke all on function pulse.chat_history_reader(uuid), pulse.chat_import_refusal(uuid), pulse.chat_import(uuid, jsonb, jsonb),
 pulse.chat_history(uuid, timestamptz, bigint, int), pulse.chat_history_count(uuid), pulse.chat_import_batches(uuid),
 pulse.chat_import_withdraw(uuid, text) from public;
grant execute on function pulse.chat_history_reader(uuid), pulse.chat_import_refusal(uuid), pulse.chat_import(uuid, jsonb, jsonb),
 pulse.chat_history(uuid, timestamptz, bigint, int), pulse.chat_history_count(uuid), pulse.chat_import_batches(uuid),
 pulse.chat_import_withdraw(uuid, text) to pulse_api;

-- migrate:down
-- Forward-only.
