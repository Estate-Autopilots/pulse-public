-- migrate:up
-- CHAT-VOICE-FIX part 3 (Kazuk, 14 Nov 2026: "an option in any group and in personal chats to import the past WhatsApp
-- chat"): R47's import (0350) now takes the export WhatsApp makes "With media" (.zip). The browser reads the chat's text
-- exactly as before; after the import it sends each photo, voice note, video or document the text refers to (each up to
-- 5 MB), and it is kept beside its imported message (the message's import key ties them, so importing the same or an
-- overlapping export again adds nothing twice). Same rules as the text: an admin who is a member of the conversation
-- imports, its current members read (chat_history_reader), a withdrawn import hides its files too; nothing is deleted.
create table pulse_priv.chat_import_file (
 org_id uuid not null,
 id uuid primary key default gen_random_uuid(),
 channel_id uuid not null,
 message_id uuid not null references pulse_priv.chat_import_message (id) on delete cascade,
 name text not null check (length(name) between 1 and 200),
 mime text not null check (length(mime) between 3 and 100),
 bytes bytea not null check (octet_length(bytes) between 1 and 5242880),
 added_by uuid not null references pulse.person (id),
 created_at timestamptz not null default clock_timestamp(),
 unique (org_id, message_id, name),
 foreign key (org_id, channel_id) references pulse.chat_channel (org_id, id)
);
create index chat_import_file_message on pulse_priv.chat_import_file (org_id, channel_id, message_id);
alter table pulse_priv.chat_import_file enable row level security;
alter table pulse_priv.chat_import_file force row level security;
create policy tenant_isolation on pulse_priv.chat_import_file using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- A file of an imported message: the import's own rules (chat_import_refusal), into a media message of an import that
-- is not withdrawn. The same file for the same message again returns the one already kept.
create function pulse.chat_import_file_add(p_channel uuid, p_import_key text, p_name text, p_mime text, p_bytes bytea) returns uuid
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare refusal text := chat_import_refusal(p_channel); msg uuid; fid uuid; nm text := left(btrim(coalesce(p_name, '')), 200);
begin
 if refusal is not null then raise exception '%', refusal using errcode = '42501'; end if;
 if nm = '' or nm ~ '[/\\]' then raise exception 'Choose a file with a name' using errcode = '22023'; end if;
 if p_bytes is null or octet_length(p_bytes) = 0 or octet_length(p_bytes) > 5242880 then raise exception 'Each file goes up to 5 MB' using errcode = '22023'; end if;
 select m.id into msg from pulse_priv.chat_import_message m
  join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
  where m.org_id = current_org() and m.channel_id = p_channel and m.import_key = p_import_key and m.kind = 'media';
 if msg is null then raise exception 'That photo, voice note or file belongs to no imported message here' using errcode = '22023'; end if;
 insert into pulse_priv.chat_import_file (org_id, channel_id, message_id, name, mime, bytes, added_by)
 values (current_org(), p_channel, msg, nm, left(coalesce(nullif(btrim(p_mime), ''), 'application/octet-stream'), 100), p_bytes, current_viewer())
 on conflict (org_id, message_id, name) do nothing returning id into fid;
 if fid is null then
  select f.id into fid from pulse_priv.chat_import_file f where f.org_id = current_org() and f.message_id = msg and f.name = nm;
 else
  perform audit_write('import', 'chat_history_file', fid::text, array['channel_id', 'message_id']);
 end if;
 return fid;
end $$;

-- The files of a page of imported messages, for the conversation's members (no bytes).
create function pulse.chat_history_files(p_channel uuid, p_messages uuid[]) returns table (message_id uuid, id uuid, name text, mime text, size int)
language sql stable security definer set search_path = pulse, pg_temp as $$
 select f.message_id, f.id, f.name, f.mime, octet_length(f.bytes)
 from pulse_priv.chat_import_file f
 join pulse_priv.chat_import_message m on m.id = f.message_id and m.org_id = f.org_id
 join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
 where f.org_id = current_org() and f.channel_id = p_channel and f.message_id = any (p_messages) and chat_history_reader(p_channel)
 order by f.message_id, f.name
$$;

-- One file to show or download, for the conversation's members; `p_audit` writes the download line once per open.
create function pulse.chat_history_file_read(p_file uuid, p_audit boolean) returns table (name text, mime text, bytes bytea)
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ch uuid;
begin
 select f.channel_id into ch from pulse_priv.chat_import_file f
  join pulse_priv.chat_import_message m on m.id = f.message_id and m.org_id = f.org_id
  join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
  where f.org_id = current_org() and f.id = p_file;
 if ch is null or not chat_history_reader(ch) then return; end if;
 if p_audit then perform audit_write('download', 'chat_history_file', p_file::text); end if;
 return query select f.name, f.mime, f.bytes from pulse_priv.chat_import_file f where f.org_id = current_org() and f.id = p_file;
end $$;

revoke all on function pulse.chat_import_file_add(uuid, text, text, text, bytea), pulse.chat_history_files(uuid, uuid[]),
 pulse.chat_history_file_read(uuid, boolean) from public;
grant execute on function pulse.chat_import_file_add(uuid, text, text, text, bytea), pulse.chat_history_files(uuid, uuid[]),
 pulse.chat_history_file_read(uuid, boolean) to pulse_api;
-- migrate:down
-- Forward-only.
