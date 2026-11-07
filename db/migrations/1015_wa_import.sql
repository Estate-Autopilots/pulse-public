-- migrate:up
-- WA-IMPORT (owner, 25 Oct 2026: "recreate all chats and all data and media perfectly in Pulse chat … client accounts
-- made on Pulse; old clients get an opt-in … clicking a person shows the chats they're involved in"). The owner's go is
-- the answer EST-127 waited for (R47's E08/E15 gate) for this import. Company-neutral: a company's WhatsApp group
-- exports are loaded by tools/wa-import.py from an import bundle (chat.json, messages.jsonl, files/); nothing here names
-- a company.
--  * wa_chat: one per WhatsApp group, tied to a Pulse chat (chat_channel kind 'custom', key 'wa:<source key>') whose
--    members are the group's colleagues, and to the client and project the group was for.
--  * wa_participant: everyone who wrote in the group, as the export names them: a colleague, a client-side person (a
--    point of contact: pulse.person side 'client', linked to the client through client_contact), or a name or number
--    Pulse does not know. A bare number is shown masked; the number as written is kept in label_raw (no grant).
--  * wa_message: every message, lossless: the text as written, media with its file, deleted messages, group notices,
--    contact cards, locations, calls; whether it was edited; how many exports it was found in.
--  * wa_file / wa_file_part: the media, content-addressed (SHA-256) and kept in Postgres like chat files (chat_file),
--    in parts of at most 1 MiB so long videos and voice notes stream with range requests; a file is complete only once
--    the SHA-256 of its parts matches.
--  * wa_import_batch: provenance of every load (bundle SHA-256, the exports it came from, counts, who ran it); an admin
--    can withdraw a batch: hidden from every read, nothing deleted. The same bundle twice adds nothing; an overlapping
--    export adds only the messages not there yet (import key unique per chat).
--  * wa_identity: which Pulse person a bundle's sender key stands for (stable across loads and groups).
--  * client_contact_optin: for each client-side person the import found or made, whether they have opted in to see
--    history shared with them. CLIENT-PORTAL sends invites and records answers; the import sends nothing.
-- Who reads: the chat's members who are active staff, and admins; client-side people only when they are members and
-- have opted in. Never a worker, ingest, privacy or model role (no grants; reads through security-definer functions
-- granted to the API). chat_prune never touches these tables; imported history is read-only.
-- Additive: new tables and functions only. Uses objects defined in this repository (0001 current_org/current_viewer,
-- 0004 viewer_is, 0011 audit_write/audit_mutation, 0022 chat_channel/chat_member/chat_active, 0004 client/client_contact,
-- 0214 contact_profile).

create table pulse_priv.wa_chat (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 source_key text not null check (source_key ~ '^[0-9A-Za-z_-]{6,80}$'),
 channel_id uuid not null,
 title text not null check (length(title) between 1 and 300),
 titles jsonb not null default '[]' check (jsonb_typeof(titles) = 'array'),   -- earlier names of the group
 client_id uuid references pulse.client(id),
 project_id uuid references pulse.project(id),
 time_zone text not null default 'Asia/Kolkata' check (length(time_zone) between 1 and 64),
 first_at timestamptz,
 last_at timestamptz,
 messages int not null default 0 check (messages >= 0),
 counts jsonb not null default '{}' check (jsonb_typeof(counts) = 'object'),  -- by kind, files by state, participants by kind
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (org_id, source_key), unique (org_id, channel_id), unique (org_id, id),
 foreign key (org_id, channel_id) references pulse.chat_channel (org_id, id)
);
create index wa_chat_client on pulse_priv.wa_chat (org_id, client_id) where client_id is not null;
create index wa_chat_project on pulse_priv.wa_chat (org_id, project_id) where project_id is not null;

create table pulse_priv.wa_identity (
 org_id uuid not null references pulse.org(id),
 source_key text not null check (source_key ~ '^[0-9A-Za-z_-]{6,80}$'),
 person_id uuid not null references pulse.person(id),
 kind text not null check (kind in ('colleague', 'client', 'contact')),
 made_by_import boolean not null default false,     -- the import made this person (a new point of contact)
 basis text not null check (length(basis) between 1 and 120),    -- the evidence that matched it
 created_at timestamptz not null default now(),
 primary key (org_id, source_key)
);
create index wa_identity_person on pulse_priv.wa_identity (org_id, person_id);

create table pulse_priv.wa_participant (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 chat_id uuid not null,
 source_key text not null check (source_key ~ '^[0-9A-Za-z_-]{6,80}$'),
 label text not null check (length(label) between 1 and 120),            -- as shown (a bare number masked)
 label_raw text check (length(label_raw) between 1 and 200),             -- as the export wrote it
 kind text not null check (kind in ('colleague', 'client', 'contact', 'number', 'unknown')),
 person_id uuid references pulse.person(id),
 messages int not null default 0 check (messages >= 0),
 first_at timestamptz,
 last_at timestamptz,
 unique (org_id, chat_id, source_key), unique (org_id, id),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id)
);
create index wa_participant_person on pulse_priv.wa_participant (org_id, person_id) where person_id is not null;

create table pulse_priv.wa_import_batch (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 chat_id uuid not null,
 tool text not null check (tool ~ '^wa-import/[0-9]{1,3}$'),
 bundle_sha256 text not null check (bundle_sha256 ~ '^[0-9a-f]{64}$'),
 source jsonb not null default '{}' check (jsonb_typeof(source) = 'object'),   -- the exports (file ids, SHA-256)
 stats jsonb not null default '{}' check (jsonb_typeof(stats) = 'object'),
 approval_ref text not null check (length(approval_ref) between 3 and 200),
 run_by text not null check (length(run_by) between 1 and 120),
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 added int not null default 0 check (added >= 0),
 duplicates int not null default 0 check (duplicates >= 0),
 withdrawn_by uuid references pulse.person(id),
 withdrawn_at timestamptz,
 withdrawn_note text check (length(withdrawn_note) between 3 and 300),
 unique (org_id, id), unique (org_id, chat_id, bundle_sha256),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id),
 check ((withdrawn_at is null) = (withdrawn_note is null))
);

create table pulse_priv.wa_file (
 org_id uuid not null references pulse.org(id),
 sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
 size bigint not null check (size between 0 and 2147483647),
 mime text not null check (length(mime) between 3 and 120),
 kind text not null check (kind in ('image', 'video', 'audio', 'voice', 'document', 'contact', 'sticker', 'gif', 'other')),
 meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object'),  -- width, height, seconds, peaks, codec, pages,
                                                                          -- poster / playable: SHA-256 of a still / a copy browsers play
 parts int not null check (parts between 0 and 2048),
 complete boolean not null default false,
 created_at timestamptz not null default now(),
 primary key (org_id, sha256)
);
create table pulse_priv.wa_file_part (
 org_id uuid not null,
 sha256 text not null,
 part int not null check (part >= 0),
 data bytea not null check (octet_length(data) between 1 and 1048576),
 primary key (org_id, sha256, part),
 foreign key (org_id, sha256) references pulse_priv.wa_file (org_id, sha256)
);
create index wa_file_poster on pulse_priv.wa_file (org_id, (meta->>'poster')) where meta ? 'poster';
create index wa_file_playable on pulse_priv.wa_file (org_id, (meta->>'playable')) where meta ? 'playable';
-- Media is already compressed: skip TOAST's pglz pass.
alter table pulse_priv.wa_file_part alter column data set storage external;

create table pulse_priv.wa_message (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 chat_id uuid not null,
 batch_id uuid not null,
 import_key text not null check (import_key ~ '^[0-9a-f]{64}$'),
 seq int not null,
 sent_at timestamptz not null,
 local_time text not null check (local_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?$'),  -- the phone's clock
 participant_id uuid,                                   -- null: a group notice
 kind text not null check (kind in ('text', 'media', 'deleted', 'system', 'contact', 'location', 'call', 'poll')),
 subtype text check (length(subtype) between 1 and 40),
 body text not null default '' check (length(body) <= 65535),
 edited boolean not null default false,
 versions jsonb check (versions is null or jsonb_typeof(versions) = 'array'),
 file_sha256 text check (file_sha256 ~ '^[0-9a-f]{64}$'),
 file_name text check (length(file_name) between 1 and 255),
 file_state text check (file_state in ('attached', 'omitted', 'missing')),
 media_type text check (media_type in ('image', 'video', 'audio', 'voice', 'document', 'contact', 'sticker', 'gif', 'unknown')),
 extra jsonb check (extra is null or jsonb_typeof(extra) = 'object'),       -- location, contact names, call, poll, mentions
 exports int not null default 1 check (exports >= 1),
 unique (org_id, chat_id, import_key), unique (org_id, id),
 foreign key (org_id, chat_id) references pulse_priv.wa_chat (org_id, id),
 foreign key (org_id, batch_id) references pulse_priv.wa_import_batch (org_id, id),
 foreign key (org_id, participant_id) references pulse_priv.wa_participant (org_id, id),
 foreign key (org_id, file_sha256) references pulse_priv.wa_file (org_id, sha256),
 check (file_state is null or file_state <> 'attached' or file_sha256 is not null)
);
create index wa_message_read on pulse_priv.wa_message (org_id, chat_id, sent_at, seq);
create index wa_message_participant on pulse_priv.wa_message (org_id, participant_id, sent_at desc) where participant_id is not null;
create index wa_message_file on pulse_priv.wa_message (org_id, file_sha256) where file_sha256 is not null;
create index wa_message_batch on pulse_priv.wa_message (org_id, batch_id);

-- Opt-in of a client-side person: CLIENT-PORTAL reads and moves it (pending → invited → opted_in / declined; revoked).
create table pulse.client_contact_optin (
 org_id uuid not null references pulse.org(id),
 person_id uuid not null references pulse.person(id),
 client_id uuid references pulse.client(id),
 state text not null default 'pending' check (state in ('pending', 'invited', 'opted_in', 'declined', 'revoked')),
 scope text[] not null default '{chat_history}' check (scope <@ array['chat_history', 'portal']),
 assigned_to uuid references pulse.person(id),        -- the colleague who owns the invitation
 source text not null default 'whatsapp_import' check (length(source) between 1 and 40),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 invited_at timestamptz,
 answered_at timestamptz,
 note text check (length(note) <= 300),
 primary key (org_id, person_id)
);

do $$ declare t text; begin
 foreach t in array array['pulse_priv.wa_chat', 'pulse_priv.wa_identity', 'pulse_priv.wa_participant', 'pulse_priv.wa_import_batch',
   'pulse_priv.wa_file', 'pulse_priv.wa_file_part', 'pulse_priv.wa_message'] loop
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on %s from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy', t);
 end loop;
end $$;
alter table pulse.client_contact_optin enable row level security;
alter table pulse.client_contact_optin force row level security;
create policy tenant_isolation on pulse.client_contact_optin using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy staff_read on pulse.client_contact_optin as restrictive for select to pulse_api using (pulse.viewer_is('admin', 'leadership'));
grant select on pulse.client_contact_optin to pulse_api;
create trigger audit_mutation after insert or update on pulse_priv.wa_import_batch for each row execute function pulse.audit_mutation();
create trigger audit_mutation after insert or update on pulse_priv.wa_chat for each row execute function pulse.audit_mutation();
create trigger audit_mutation after insert or update on pulse_priv.wa_identity for each row execute function pulse.audit_mutation();
create trigger audit_mutation after insert or update or delete on pulse.client_contact_optin for each row execute function pulse.audit_mutation();

-- ---------------------------------------------------------------------------------------------------------------
-- Who reads a chat's imported history: an active staff member of its Pulse chat, an admin, or a client-side person who
-- is a member and has opted in to shared history.
create function pulse.wa_reader(p_chat uuid) returns boolean
language sql stable security definer set search_path = pulse, pg_temp as $$
 select exists (select 1 from pulse_priv.wa_chat c where c.org_id = current_org() and c.id = p_chat and (
   (chat_active() and (viewer_is('admin') or exists (select 1 from chat_member m where m.org_id = c.org_id and m.channel_id = c.channel_id and m.person_id = current_viewer())))
   or exists (select 1 from person p join chat_member m on m.person_id = p.id and m.channel_id = c.channel_id
              join client_contact_optin o on o.org_id = p.org_id and o.person_id = p.id
              where p.id = current_viewer() and p.side = 'client' and p.status = 'active' and o.state = 'opted_in' and 'chat_history' = any(o.scope))))
$$;

-- The imported chat behind a Pulse chat, when the viewer reads it: id, messages, first and last time.
create function pulse.wa_channel(p_channel uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('chatId', c.id, 'messages', c.messages, 'firstAt', c.first_at, 'lastAt', c.last_at)
 from pulse_priv.wa_chat c where c.org_id = current_org() and c.channel_id = p_channel and wa_reader(c.id)
$$;

-- Chats the viewer reads, newest activity first. Filters (all optional): person (a participant), client, project, q
-- (words of the title), limit (≤ 500) and offset. Each row: the chat, its client and project, counts, and for a person
-- filter how many messages that person wrote and when last.
create function pulse.wa_chats(p jsonb default '{}') returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 with f as (select nullif(p->>'person', '')::uuid person, nullif(p->>'client', '')::uuid client, nullif(p->>'project', '')::uuid project,
   nullif(trim(coalesce(p->>'q', '')), '') q, greatest(1, least(coalesce((p->>'limit')::int, 100), 500)) lim, greatest(0, coalesce((p->>'offset')::int, 0)) off),
 rows as (
  select c.*, mine.messages person_messages, mine.last_at person_last_at, mine.kind person_kind
  from pulse_priv.wa_chat c cross join f
  left join lateral (select sum(pa.messages)::int messages, max(pa.last_at) last_at, min(pa.kind) kind from pulse_priv.wa_participant pa
    where pa.org_id = c.org_id and pa.chat_id = c.id and pa.person_id = f.person) mine on f.person is not null
  where c.org_id = current_org() and wa_reader(c.id)
   and (f.client is null or c.client_id = f.client) and (f.project is null or c.project_id = f.project)
   and (f.person is null or mine.messages is not null)
   and (f.q is null or c.title ilike '%' || replace(replace(f.q, '%', '\%'), '_', '\_') || '%'))
 select jsonb_build_object('total', (select count(*) from rows), 'chats', coalesce((select jsonb_agg(x.j order by x.ord) from (
   select row_number() over (order by r.last_at desc nulls last, r.title) ord, jsonb_build_object('id', r.id, 'channelId', r.channel_id, 'title', r.title,
     'clientId', r.client_id, 'client', cl.display_name, 'projectId', r.project_id, 'project', pr.name, 'messages', r.messages,
     'firstAt', r.first_at, 'lastAt', r.last_at, 'counts', r.counts,
     'personMessages', r.person_messages, 'personLastAt', r.person_last_at, 'personKind', r.person_kind) j
   from rows r cross join f left join client cl on cl.id = r.client_id left join project pr on pr.id = r.project_id
   order by r.last_at desc nulls last, r.title limit (select lim from f) offset (select off from f)) x(ord, j)), '[]'::jsonb))
$$;

-- One chat: its title, client, project, counts and everyone in it (null when the viewer does not read it).
create function pulse.wa_chat(p_chat uuid) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('id', c.id, 'channelId', c.channel_id, 'title', c.title, 'titles', c.titles, 'timeZone', c.time_zone,
   'clientId', c.client_id, 'client', cl.display_name, 'projectId', c.project_id, 'project', pr.name,
   'messages', c.messages, 'firstAt', c.first_at, 'lastAt', c.last_at, 'counts', c.counts,
   'participants', coalesce((select jsonb_agg(jsonb_build_object('id', pa.id, 'label', pa.label, 'kind', pa.kind, 'personId', pa.person_id,
       'name', pp.display_name, 'side', pp.side, 'messages', pa.messages, 'firstAt', pa.first_at, 'lastAt', pa.last_at) order by pa.messages desc, pa.label)
     from pulse_priv.wa_participant pa left join person pp on pp.id = pa.person_id where pa.org_id = c.org_id and pa.chat_id = c.id), '[]'::jsonb),
   'batches', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'runBy', b.run_by, 'startedAt', b.started_at, 'finishedAt', b.finished_at,
       'added', b.added, 'duplicates', b.duplicates, 'approvalRef', b.approval_ref, 'withdrawnAt', b.withdrawn_at) order by b.started_at)
     from pulse_priv.wa_import_batch b where b.org_id = c.org_id and b.chat_id = c.id), '[]'::jsonb),
   'canWithdraw', viewer_is('admin'))
 from pulse_priv.wa_chat c left join client cl on cl.id = c.client_id left join project pr on pr.id = c.project_id
 where c.org_id = current_org() and c.id = p_chat and wa_reader(c.id)
$$;

-- A page of a chat's messages in time order. p_before: messages before that message; p_after: after it; p_around: the
-- page centred on it (a link to one message); none: the newest page. Withdrawn batches are hidden.
create function pulse.wa_messages(p_chat uuid, p_before uuid default null, p_after uuid default null, p_around uuid default null, p_limit int default 80)
returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare lim int := greatest(1, least(coalesce(p_limit, 80), 300)); at_ts timestamptz; at_seq int; pivot uuid := coalesce(p_before, p_after, p_around);
 ids uuid[]; rows jsonb; lo record; hi record;
begin
 if not wa_reader(p_chat) then return null; end if;
 if pivot is not null then
  select m.sent_at, m.seq into at_ts, at_seq from pulse_priv.wa_message m where m.org_id = current_org() and m.chat_id = p_chat and m.id = pivot;
  if not found then raise exception 'message unavailable' using errcode = '22023'; end if;
 end if;
 if p_after is not null then
  select array_agg(x.id) into ids from (select m.id from pulse_priv.wa_message m join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   where m.org_id = current_org() and m.chat_id = p_chat and (m.sent_at, m.seq) > (at_ts, at_seq) order by m.sent_at, m.seq limit lim) x;
 elsif p_around is not null then
  select array_agg(x.id) into ids from (
   (select m.id from pulse_priv.wa_message m join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
    where m.org_id = current_org() and m.chat_id = p_chat and (m.sent_at, m.seq) < (at_ts, at_seq) order by m.sent_at desc, m.seq desc limit lim / 2)
   union all
   (select m.id from pulse_priv.wa_message m join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
    where m.org_id = current_org() and m.chat_id = p_chat and (m.sent_at, m.seq) >= (at_ts, at_seq) order by m.sent_at, m.seq limit lim - lim / 2)) x;
 else
  select array_agg(x.id) into ids from (select m.id from pulse_priv.wa_message m join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   where m.org_id = current_org() and m.chat_id = p_chat and (p_before is null or (m.sent_at, m.seq) < (at_ts, at_seq)) order by m.sent_at desc, m.seq desc limit lim) x;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'seq', m.seq, 'at', m.sent_at, 'local', m.local_time, 'participantId', m.participant_id,
   'kind', m.kind, 'subtype', m.subtype, 'body', m.body, 'edited', m.edited, 'versions', m.versions, 'exports', m.exports, 'extra', m.extra,
   'file', case when m.file_state is not null or m.file_sha256 is not null then jsonb_build_object('sha256', m.file_sha256, 'name', m.file_name, 'state', m.file_state,
     'type', m.media_type, 'mime', f.mime, 'size', f.size, 'kind', f.kind, 'meta', f.meta, 'complete', f.complete) end) order by m.sent_at, m.seq), '[]'::jsonb)
 into rows from pulse_priv.wa_message m left join pulse_priv.wa_file f on f.org_id = m.org_id and f.sha256 = m.file_sha256
 where m.org_id = current_org() and m.id = any(coalesce(ids, '{}'));
 select min(m.sent_at) a, (array_agg(m.seq order by m.sent_at, m.seq))[1] s into lo from pulse_priv.wa_message m where m.org_id = current_org() and m.id = any(coalesce(ids, '{}'));
 select max(m.sent_at) a, (array_agg(m.seq order by m.sent_at desc, m.seq desc))[1] s into hi from pulse_priv.wa_message m where m.org_id = current_org() and m.id = any(coalesce(ids, '{}'));
 return jsonb_build_object('messages', rows,
  'older', lo.a is not null and exists (select 1 from pulse_priv.wa_message m join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
    where m.org_id = current_org() and m.chat_id = p_chat and (m.sent_at, m.seq) < (lo.a, lo.s)),
  'newer', hi.a is not null and exists (select 1 from pulse_priv.wa_message m join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
    where m.org_id = current_org() and m.chat_id = p_chat and (m.sent_at, m.seq) > (hi.a, hi.s)));
end $$;

-- Words in a chat's messages (or a file's name): the newest 200 matches, for jumping to them.
create function pulse.wa_search(p_chat uuid, p_q text) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'at', x.sent_at, 'participantId', x.participant_id, 'body', left(x.body, 200), 'fileName', x.file_name) order by x.sent_at desc), '[]'::jsonb)
 from (select m.id, m.sent_at, m.participant_id, m.body, m.file_name from pulse_priv.wa_message m
   join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   where m.org_id = current_org() and m.chat_id = p_chat and wa_reader(p_chat) and length(trim(coalesce(p_q, ''))) between 2 and 100
    and (m.body ilike '%' || replace(replace(trim(p_q), '%', '\%'), '_', '\_') || '%' or m.file_name ilike '%' || replace(replace(trim(p_q), '%', '\%'), '_', '\_') || '%')
   order by m.sent_at desc limit 200) x
$$;

-- A file the viewer may open: a message of a chat they read carries it (or it is that file's poster or playable copy).
-- Returns the file's facts and the part numbers to read; null otherwise.
create function pulse.wa_file_open(p_sha text) returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select jsonb_build_object('sha256', f.sha256, 'mime', f.mime, 'size', f.size, 'kind', f.kind, 'parts', f.parts, 'meta', f.meta,
   'name', (select m.file_name from pulse_priv.wa_message m where m.org_id = f.org_id and m.file_sha256 = f.sha256 and m.file_name is not null limit 1))
 from pulse_priv.wa_file f where f.org_id = current_org() and f.sha256 = p_sha and f.complete and exists (
   select 1 from pulse_priv.wa_file o join pulse_priv.wa_message m on m.org_id = o.org_id and m.file_sha256 = o.sha256
   join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   where o.org_id = f.org_id and o.sha256 = f.sha256 and wa_reader(m.chat_id)
   union all
   select 1 from pulse_priv.wa_file o join pulse_priv.wa_message m on m.org_id = o.org_id and m.file_sha256 = o.sha256
   join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   where o.org_id = f.org_id and (o.meta->>'poster' = f.sha256 or o.meta->>'playable' = f.sha256) and wa_reader(m.chat_id))
$$;
create function pulse.wa_file_parts(p_sha text, p_from int, p_to int) returns table (part int, data bytea)
language sql stable security definer set search_path = pulse, pg_temp as $$
 select p.part, p.data from pulse_priv.wa_file_part p where p.org_id = current_org() and p.sha256 = p_sha and p.part between p_from and least(p_to, p_from + 63)
  and wa_file_open(p_sha) is not null order by p.part
$$;

-- Imports for an admin: every batch, without any message text.
create function pulse.wa_import_batches() returns jsonb
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case when viewer_is('admin') then coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'chatId', b.chat_id, 'chat', c.title, 'tool', b.tool,
   'bundleSha256', b.bundle_sha256, 'stats', b.stats, 'approvalRef', b.approval_ref, 'runBy', b.run_by, 'startedAt', b.started_at, 'finishedAt', b.finished_at,
   'added', b.added, 'duplicates', b.duplicates, 'withdrawnAt', b.withdrawn_at, 'withdrawnNote', b.withdrawn_note) order by b.started_at desc)
  from pulse_priv.wa_import_batch b join pulse_priv.wa_chat c on c.org_id = b.org_id and c.id = b.chat_id where b.org_id = current_org()), '[]'::jsonb) end
$$;

-- Hide a batch from every read (an admin, with a reason). Its rows stay; nothing is deleted.
create function pulse.wa_import_withdraw(p_batch uuid, p_note text) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if not viewer_is('admin') then raise exception 'Only an admin withdraws imported history' using errcode = '42501'; end if;
 if length(trim(coalesce(p_note, ''))) not between 3 and 300 then raise exception 'Say why in 3 to 300 characters' using errcode = '22023'; end if;
 update pulse_priv.wa_import_batch set withdrawn_by = current_viewer(), withdrawn_at = now(), withdrawn_note = trim(p_note)
 where org_id = current_org() and id = p_batch and withdrawn_at is null;
 if not found then raise exception 'Import unavailable or already withdrawn' using errcode = '42501'; end if;
 perform audit_write('withdraw', 'wa_import', p_batch::text, array['withdrawn_at']);
end $$;

-- Record a client-side person's opt-in answer (CLIENT-PORTAL calls this when an invite is sent or answered; an admin can too).
create function pulse.client_optin_set(p_person uuid, p_state text, p_note text default null) returns void
language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if not viewer_is('admin') then raise exception 'Only an admin records a client''s opt-in' using errcode = '42501'; end if;
 if p_state not in ('pending', 'invited', 'opted_in', 'declined', 'revoked') then raise exception 'Choose pending, invited, opted_in, declined or revoked' using errcode = '22023'; end if;
 update client_contact_optin set state = p_state, note = left(trim(p_note), 300), updated_at = now(),
   invited_at = case when p_state = 'invited' then now() else invited_at end,
   answered_at = case when p_state in ('opted_in', 'declined', 'revoked') then now() else answered_at end
 where org_id = current_org() and person_id = p_person;
 if not found then raise exception 'No opt-in record for this person' using errcode = '22023'; end if;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Loading (tools/wa-import.py, on the server, as the database owner with the company set): no grant to any runtime role.
-- 1. The chat, its Pulse chat and members, its participants, and a batch for this bundle (the same bundle again: the
--    batch it already made, with done=true, and nothing changes).
create function pulse.wa_import_begin(p jsonb) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid; ch uuid; bid uuid; k text := p->>'sourceKey'; t text := left(regexp_replace(trim(coalesce(p->>'title', '')), '\s+', ' ', 'g'), 300);
 done boolean := false; parts jsonb;
begin
 if current_org() is null then raise exception 'set the company first' using errcode = '42501'; end if;
 if k is null or k !~ '^[0-9A-Za-z_-]{6,80}$' then raise exception 'sourceKey required' using errcode = '22023'; end if;
 if length(t) = 0 then raise exception 'title required' using errcode = '22023'; end if;
 insert into chat_channel (org_id, key, name, kind, description) values (current_org(), 'wa:' || k, left(t, 120), 'custom', 'Imported from WhatsApp')
 on conflict (org_id, key) do update set name = excluded.name where chat_channel.name is distinct from excluded.name
 returning id into ch;
 if ch is null then select id into ch from chat_channel where org_id = current_org() and key = 'wa:' || k; end if;
 insert into pulse_priv.wa_chat (org_id, source_key, channel_id, title, titles, client_id, project_id, time_zone)
 values (current_org(), k, ch, t, coalesce(p->'titles', '[]'), nullif(p->>'clientId', '')::uuid, nullif(p->>'projectId', '')::uuid, coalesce(nullif(p->>'timeZone', ''), 'Asia/Kolkata'))
 on conflict (org_id, source_key) do update set title = excluded.title, titles = excluded.titles, client_id = excluded.client_id,
   project_id = excluded.project_id, updated_at = now()
 returning id into cid;
 insert into chat_member (org_id, channel_id, person_id)
 select current_org(), ch, x.id from person x where x.org_id = current_org() and x.side = 'staff' and x.status = 'active'
  and x.id in (select (jsonb_array_elements_text(coalesce(p->'members', '[]')))::uuid) on conflict do nothing;
 insert into pulse_priv.wa_participant (org_id, chat_id, source_key, label, label_raw, kind, person_id)
 select current_org(), cid, x.key, left(x.label, 120), nullif(left(x.raw, 200), ''), x.kind, x.person
 from jsonb_to_recordset(coalesce(p->'participants', '[]')) as x(key text, label text, raw text, kind text, person uuid)
 on conflict (org_id, chat_id, source_key) do update set label = excluded.label, label_raw = excluded.label_raw, kind = excluded.kind, person_id = excluded.person_id;
 select id, finished_at is not null into bid, done from pulse_priv.wa_import_batch where org_id = current_org() and chat_id = cid and bundle_sha256 = p->>'bundleSha256';
 if bid is null then
  insert into pulse_priv.wa_import_batch (org_id, chat_id, tool, bundle_sha256, source, approval_ref, run_by)
  values (current_org(), cid, p->>'tool', p->>'bundleSha256', coalesce(p->'source', '{}'), trim(p->>'approvalRef'), trim(p->>'runBy'))
  returning id into bid;
  done := false;
 end if;
 select coalesce(jsonb_object_agg(source_key, id), '{}') into parts from pulse_priv.wa_participant where org_id = current_org() and chat_id = cid;
 return jsonb_build_object('chatId', cid, 'channelId', ch, 'batchId', bid, 'done', coalesce(done, false), 'participants', parts);
end $$;

-- 2. Files: declare (true when already complete: send nothing), send parts, seal (the SHA-256 of the parts must match).
create function pulse.wa_import_file(p_sha text, p_size bigint, p_mime text, p_kind text, p_meta jsonb, p_parts int) returns boolean
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ok boolean;
begin
 insert into pulse_priv.wa_file (org_id, sha256, size, mime, kind, meta, parts) values (current_org(), p_sha, p_size, p_mime, p_kind, coalesce(p_meta, '{}'), p_parts)
 on conflict (org_id, sha256) do update set meta = pulse_priv.wa_file.meta || excluded.meta where not pulse_priv.wa_file.complete or excluded.meta <> '{}'::jsonb;
 select complete into ok from pulse_priv.wa_file where org_id = current_org() and sha256 = p_sha;
 return ok;
end $$;
create function pulse.wa_import_file_part(p_sha text, p_part int, p_data bytea) returns void
language sql security definer set search_path = pulse, pg_temp as $$
 insert into pulse_priv.wa_file_part (org_id, sha256, part, data) values (current_org(), p_sha, p_part, p_data)
 on conflict (org_id, sha256, part) do update set data = excluded.data
 where not (select complete from pulse_priv.wa_file where org_id = current_org() and sha256 = p_sha)
$$;
create function pulse.wa_import_file_seal(p_sha text) returns boolean
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare f pulse_priv.wa_file%rowtype; got text; n int; total bigint;
begin
 select * into f from pulse_priv.wa_file where org_id = current_org() and sha256 = p_sha for update;
 if not found then raise exception 'file not declared' using errcode = '22023'; end if;
 if f.complete then return true; end if;
 select count(*), coalesce(sum(octet_length(data)), 0) into n, total from pulse_priv.wa_file_part where org_id = current_org() and sha256 = p_sha;
 if n <> f.parts or total <> f.size then return false; end if;
 select encode(sha256(coalesce(string_agg(data, ''::bytea order by part), ''::bytea)), 'hex') into got from pulse_priv.wa_file_part where org_id = current_org() and sha256 = p_sha;
 if got <> p_sha then return false; end if;
 update pulse_priv.wa_file set complete = true where org_id = current_org() and sha256 = p_sha;
 return true;
end $$;

-- 3. Messages (any number of calls per batch): new import keys are added, known ones counted as already there.
create function pulse.wa_import_messages(p_batch uuid, p_messages jsonb) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b pulse_priv.wa_import_batch%rowtype; n int; total int := jsonb_array_length(p_messages);
begin
 select * into b from pulse_priv.wa_import_batch where org_id = current_org() and id = p_batch;
 if not found or b.finished_at is not null then raise exception 'open batch required' using errcode = '22023'; end if;
 if exists (select 1 from jsonb_to_recordset(p_messages) as m(file text, "fileState" text)
   where m.file is not null and m."fileState" = 'attached' and not exists (select 1 from pulse_priv.wa_file f where f.org_id = current_org() and f.sha256 = m.file and f.complete))
  then raise exception 'a message names a file that is not stored yet' using errcode = '22023'; end if;
 insert into pulse_priv.wa_message (org_id, chat_id, batch_id, import_key, seq, sent_at, local_time, participant_id, kind, subtype, body, edited,
   versions, file_sha256, file_name, file_state, media_type, extra, exports)
 select current_org(), b.chat_id, b.id, m.key, m.seq, m.at, m.local, pa.id, m.kind, m.subtype, coalesce(m.body, ''), coalesce(m.edited, false),
   m.versions, m.file, m."fileName", m."fileState", m."mediaType", m.extra, greatest(coalesce(m.exports, 1), 1)
 from jsonb_to_recordset(p_messages) as m(key text, seq int, at timestamptz, local text, sender text, kind text, subtype text, body text, edited boolean,
   versions jsonb, file text, "fileName" text, "fileState" text, "mediaType" text, extra jsonb, exports int)
 left join pulse_priv.wa_participant pa on pa.org_id = current_org() and pa.chat_id = b.chat_id and pa.source_key = m.sender
 order by m.seq
 on conflict (org_id, chat_id, import_key) do nothing;
 get diagnostics n = row_count;
 update pulse_priv.wa_import_batch set added = added + n, duplicates = duplicates + (total - n) where id = b.id;
 return jsonb_build_object('added', n, 'duplicates', total - n);
end $$;

-- 4. Close the batch: recount the chat and its participants; the stats the tool measured are kept with the batch.
create function pulse.wa_import_finish(p_batch uuid, p_stats jsonb) returns jsonb
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b pulse_priv.wa_import_batch%rowtype; r jsonb;
begin
 select * into b from pulse_priv.wa_import_batch where org_id = current_org() and id = p_batch for update;
 if not found then raise exception 'batch unavailable' using errcode = '22023'; end if;
 update pulse_priv.wa_participant pa set messages = coalesce(x.n, 0), first_at = x.first_at, last_at = x.last_at
 from (select pa2.id, count(m.id)::int n, min(m.sent_at) first_at, max(m.sent_at) last_at from pulse_priv.wa_participant pa2
   left join pulse_priv.wa_message m on m.org_id = pa2.org_id and m.participant_id = pa2.id where pa2.org_id = current_org() and pa2.chat_id = b.chat_id group by pa2.id) x
 where pa.id = x.id;
 select jsonb_build_object('messages', count(*), 'kinds', coalesce((select jsonb_object_agg(kind, n) from (select kind, count(*) n from pulse_priv.wa_message where org_id = current_org() and chat_id = b.chat_id group by kind) k), '{}'),
   'files', coalesce((select jsonb_object_agg(coalesce(media_type, 'unknown') || ':' || file_state, n) from (select media_type, file_state, count(*) n from pulse_priv.wa_message
     where org_id = current_org() and chat_id = b.chat_id and file_state is not null group by 1, 2) f), '{}'),
   'participants', coalesce((select jsonb_object_agg(kind, n) from (select kind, count(*) n from pulse_priv.wa_participant where org_id = current_org() and chat_id = b.chat_id group by kind) q), '{}'),
   'firstAt', min(sent_at), 'lastAt', max(sent_at))
 into r from pulse_priv.wa_message where org_id = current_org() and chat_id = b.chat_id;
 update pulse_priv.wa_chat set messages = (r->>'messages')::int, counts = r - 'firstAt' - 'lastAt' - 'messages', first_at = (r->>'firstAt')::timestamptz,
   last_at = (r->>'lastAt')::timestamptz, updated_at = now() where org_id = current_org() and id = b.chat_id;
 update pulse_priv.wa_import_batch set stats = coalesce(p_stats, '{}'), finished_at = now() where id = b.id;
 return r || jsonb_build_object('added', b.added, 'duplicates', b.duplicates);
end $$;

-- 5. A person behind a sender key: an existing one (colleague or client-side), or a new point of contact of a client
--    (person side 'client', a contact profile, the client_contact link and a pending opt-in, never an invitation). The
--    phone number, when known, goes to person_private only. The same key again returns the same person.
create function pulse.wa_import_person(p jsonb) returns uuid
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k text := p->>'key'; pid uuid; kind text := p->>'kind'; cl uuid := nullif(p->>'clientId', '')::uuid; made boolean := false;
 nm text := left(regexp_replace(trim(coalesce(p->>'name', '')), '\s+', ' ', 'g'), 120); ph text := nullif(p->>'phone', '');
begin
 if current_org() is null then raise exception 'set the company first' using errcode = '42501'; end if;
 if kind not in ('colleague', 'client', 'contact') then raise exception 'kind: colleague, client or contact' using errcode = '22023'; end if;
 select person_id into pid from pulse_priv.wa_identity where org_id = current_org() and source_key = k;
 if pid is null then
  pid := nullif(p->>'personId', '')::uuid;
  if pid is not null and not exists (select 1 from person where org_id = current_org() and id = pid) then raise exception 'person unavailable' using errcode = '22023'; end if;
  if pid is null then
   if kind = 'colleague' then raise exception 'a colleague must be an existing person' using errcode = '22023'; end if;
   if length(nm) < 2 then raise exception 'a new contact needs a name' using errcode = '22023'; end if;
   insert into person (org_id, display_name, side, status) values (current_org(), nm, 'client', 'active') returning id into pid;
   insert into contact_profile (org_id, person_id, designation, source, notes)
   values (current_org(), pid, 'Point of contact', 'whatsapp_import', 'Found in the company''s WhatsApp groups')
   on conflict (person_id) do nothing;
   made := true;
  end if;
  insert into pulse_priv.wa_identity (org_id, source_key, person_id, kind, made_by_import, basis)
  values (current_org(), k, pid, kind, made, left(coalesce(nullif(p->>'basis', ''), 'import'), 120));
 end if;
 if kind in ('client', 'contact') then
  if cl is not null then insert into client_contact (org_id, client_id, person_id) values (current_org(), cl, pid) on conflict do nothing; end if;
  insert into client_contact_optin (org_id, person_id, client_id, assigned_to) values (current_org(), pid, cl, nullif(p->>'assignedTo', '')::uuid)
  on conflict (org_id, person_id) do update set client_id = coalesce(client_contact_optin.client_id, excluded.client_id),
    assigned_to = coalesce(client_contact_optin.assigned_to, excluded.assigned_to);
  if ph is not null and ph ~ '^\+[1-9][0-9]{6,14}$' then
   insert into pulse_priv.person_private (person_id, org_id, phone_e164, phone_hash) values (pid, current_org(), ph, encode(sha256(convert_to(ph, 'UTF8')), 'hex'))
   on conflict (person_id) do update set phone_e164 = coalesce(pulse_priv.person_private.phone_e164, excluded.phone_e164),
     phone_hash = coalesce(pulse_priv.person_private.phone_hash, excluded.phone_hash);
  end if;
 end if;
 return pid;
end $$;

revoke all on function pulse.wa_reader(uuid), pulse.wa_channel(uuid), pulse.wa_chats(jsonb), pulse.wa_chat(uuid),
 pulse.wa_messages(uuid, uuid, uuid, uuid, int), pulse.wa_search(uuid, text), pulse.wa_file_open(text), pulse.wa_file_parts(text, int, int),
 pulse.wa_import_batches(), pulse.wa_import_withdraw(uuid, text), pulse.client_optin_set(uuid, text, text),
 pulse.wa_import_begin(jsonb), pulse.wa_import_file(text, bigint, text, text, jsonb, int), pulse.wa_import_file_part(text, int, bytea),
 pulse.wa_import_file_seal(text), pulse.wa_import_messages(uuid, jsonb), pulse.wa_import_finish(uuid, jsonb), pulse.wa_import_person(jsonb) from public;
grant execute on function pulse.wa_reader(uuid), pulse.wa_channel(uuid), pulse.wa_chats(jsonb), pulse.wa_chat(uuid),
 pulse.wa_messages(uuid, uuid, uuid, uuid, int), pulse.wa_search(uuid, text), pulse.wa_file_open(text), pulse.wa_file_parts(text, int, int),
 pulse.wa_import_batches(), pulse.wa_import_withdraw(uuid, text), pulse.client_optin_set(uuid, text, text) to pulse_api;

-- migrate:down
-- Forward-only.
