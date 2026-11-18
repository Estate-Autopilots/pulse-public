-- migrate:up
-- R45 (11 Oct 2026): useful text and lossless compressed facts captured from approved Drive roots. Off by default: the
-- worker (collectors/gdrive_extract) runs only with PULSE_DRIVE_EXTRACT=1, only for R44 roots (pulse.drive_source)
-- that are tracked and approved, and only once an admin records a separate content approval for the root (owner
-- errands E08/E13: which formats, who in Pulse may read the text, the size limit and a retention proposal).
--  * drive_extract_policy: that content approval. Withdrawing it stops extraction and every read; nothing is deleted.
--  * drive_extract: one row per file, content version and extractor version, with what happened (extracted,
--    quarantined, unsupported, excluded, failed), why, and the provenance of the capture: the file's name, type and
--    version at capture, the export format, the size and SHA-256 of the bytes read (the bytes are never kept: no raw
--    binary archive), the extractor, its sandbox and the gaps it knows of. Append-only.
--  * pulse_priv.drive_payload: the captured text and facts as compressed payloads, addressed by the SHA-256 of their
--    uncompressed bytes (identical content is stored once per organisation), with codec, schema and both lengths.
--  * drive_extract_review: an admin's reviewed decision that text captured from a file that has since disappeared
--    from Drive stays readable. Deleted or unshared look the same from Drive, so such text is held until reviewed.
-- Who may read captured text is decided at every read by pulse.drive_text(): the content approval in force, the
-- viewer's current roles against its audience, and the root's and the file's current state in the R44 feed.

create table pulse.drive_extract_policy (
 org_id uuid not null references pulse.org(id),
 source_id uuid not null references pulse.drive_source(id),
 formats text[] not null check (cardinality(formats) between 1 and 7
   and formats <@ array['text','csv','pdf','docx','gdoc','gsheet','gslides']),
 audience text[] not null check (cardinality(audience) between 1 and 10
   and array_to_string(audience, ',') ~ '^[a-z_]{2,40}(,[a-z_]{2,40})*$'),
 max_bytes int not null default 10485760 check (max_bytes between 1024 and 26214400),
 retention_note text check (length(retention_note) between 3 and 300),   -- a proposal for legal review; no purge
 approval_ref text check (length(approval_ref) between 3 and 200),
 approved_by uuid references pulse.person(id),
 approved_at timestamptz,
 enabled boolean not null default false,
 withdrawn_by uuid references pulse.person(id),
 withdrawn_at timestamptz,
 updated_by uuid references pulse.person(id),
 updated_at timestamptz not null default now(),
 last_run_at timestamptz,
 last_error_code text check (last_error_code ~ '^[a-z_]{1,40}$'),
 primary key (org_id, source_id),
 check (not enabled or (approved_by is not null and approved_at is not null and approval_ref is not null
                        and withdrawn_at is null))
);

create table pulse_priv.drive_payload (
 org_id uuid not null references pulse.org(id),
 sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),            -- of the uncompressed bytes
 schema text not null check (schema ~ '^pulse\.drive\.(text|facts)/[0-9]{1,3}$'),
 codec text not null check (codec in ('zlib')),
 raw_length int not null check (raw_length >= 0),
 stored_length int not null check (stored_length = octet_length(data)),
 data bytea not null,
 created_at timestamptz not null default now(),
 primary key (org_id, sha256, schema)
);

create table pulse.drive_extract (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 source_id uuid not null references pulse.drive_source(id),
 file_id text not null check (file_id ~ '^[A-Za-z0-9_-]{1,160}$'),
 source_version text not null check (length(source_version) between 4 and 80),   -- md5:… or modified:…
 extractor text not null check (extractor ~ '^[a-z0-9-]{1,40}/[0-9]+\.[0-9]+\.[0-9]+$'),
 format text check (format in ('text','csv','pdf','docx','gdoc','gsheet','gslides')),
 status text not null check (status in ('extracted','quarantined','unsupported','excluded','failed')),
 reason text check (reason ~ '^[a-z_]{1,40}$'),
 file_name text not null check (length(file_name) <= 500),
 mime text not null check (length(mime) <= 200),
 file_modified_at timestamptz,
 export_mime text check (length(export_mime) <= 200),
 original_size bigint check (original_size >= 0),
 original_sha256 text check (original_sha256 ~ '^[0-9a-f]{64}$'),
 text_sha256 text,
 text_schema text,
 facts_sha256 text,
 facts_schema text,
 sandbox text check (sandbox in ('bwrap','rlimit')),
 elapsed_ms int check (elapsed_ms >= 0),
 gaps text[] not null default '{}',
 extracted_at timestamptz not null default now(),
 unique (org_id, source_id, file_id, source_version, extractor),
 foreign key (org_id, text_sha256, text_schema) references pulse_priv.drive_payload (org_id, sha256, schema),
 foreign key (org_id, facts_sha256, facts_schema) references pulse_priv.drive_payload (org_id, sha256, schema),
 check ((status = 'extracted') = (text_sha256 is not null and facts_sha256 is not null)),
 check (status = 'extracted' or reason is not null)
);
create index drive_extract_file on pulse.drive_extract (org_id, source_id, file_id, extracted_at desc);
create index drive_extract_text on pulse.drive_extract (org_id, text_sha256) where text_sha256 is not null;
create index drive_extract_outcome on pulse.drive_extract (org_id, source_id, status, reason);
create index drive_extract_version on pulse.drive_extract (org_id, extractor, format);

create table pulse.drive_extract_review (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 source_id uuid not null references pulse.drive_source(id),
 file_id text not null check (file_id ~ '^[A-Za-z0-9_-]{1,160}$'),
 decision text not null check (decision in ('keep_readable')),
 for_change_at timestamptz not null,                   -- the disappearance it reviewed (drive_source_file.last_change_at)
 reviewed_by uuid not null references pulse.person(id),
 note text not null check (length(note) between 3 and 500),
 created_at timestamptz not null default now()
);
create index drive_extract_review_file on pulse.drive_extract_review (org_id, source_id, file_id, for_change_at);

do $$ declare t text; begin
 foreach t in array array['pulse.drive_extract_policy','pulse_priv.drive_payload','pulse.drive_extract',
                          'pulse.drive_extract_review'] loop
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format('create policy tenant on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('revoke all on %s from pulse_api', t);
  execute format('grant select, insert on %s to pulse_worker', t);
 end loop;
end $$;
-- The worker records each run's health and the admin's approval on the policy; captures and reviews are append-only.
grant update on pulse.drive_extract_policy to pulse_worker;

-- Why captured text of one file cannot be read now, or null when it can: the root has lost access or is no longer
-- tracked, the file moved out of the root, or it disappeared from Drive (deleted or unshared: the same to Drive) and
-- no admin has reviewed keeping it readable since.
create function pulse.drive_text_hold(p_source uuid, p_file text) returns text
language sql stable security definer set search_path = pulse, pg_temp as $$
 select case
   when not s.enabled or s.approved_at is null then 'root_not_tracked'
   when s.status = 'access_lost' then 'root_access_lost'
   when f.file_id is null then 'file_not_tracked'
   when f.availability = 'out_of_scope' then 'moved_out_of_root'
   when f.availability = 'removed' and not exists (
     select 1 from drive_extract_review r where r.source_id = f.source_id and r.file_id = f.file_id
        and r.for_change_at >= f.last_change_at) then 'source_removed'
 end
 from drive_source s left join drive_source_file f on f.source_id = s.id and f.file_id = p_file
 where s.id = p_source
$$;

-- One file's captured text and facts for a viewer in the root's approved audience: the compressed payloads with their
-- codec, lengths and hashes (the API decompresses and checks them), provenance and known gaps. Nothing at all for a
-- viewer outside the audience or a root without a content approval in force; only the state and reason while held.
create function pulse.drive_text(p_source uuid, p_file text) returns table (meta jsonb, text_data bytea, facts_data bytea)
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare pol drive_extract_policy; f drive_source_file; x drive_extract; s drive_source; hold text; gaps text[];
        current_version text; tp pulse_priv.drive_payload; fp pulse_priv.drive_payload; latest jsonb;
begin
 select * into pol from drive_extract_policy where source_id = p_source and enabled and withdrawn_at is null;
 if not found or current_viewer() is null or not viewer_is(variadic pol.audience) then return; end if;
 select * into s from drive_source where id = p_source;
 select * into f from drive_source_file where source_id = p_source and file_id = p_file;
 if not found then return; end if;
 hold := drive_text_hold(p_source, p_file);
 if hold is not null then
  return query select jsonb_build_object('state', 'held', 'reason', hold), null::bytea, null::bytea;
  return;
 end if;
 select * into x from drive_extract where source_id = p_source and file_id = p_file
  order by extracted_at desc, id desc limit 1;
 if not found then
  return query select jsonb_build_object('state', 'not_captured', 'reason', null), null::bytea, null::bytea;
  return;
 end if;
 -- A newer version that could not be captured (say it was encrypted) does not hide text captured from an earlier one.
 if x.status <> 'extracted' then
  latest := jsonb_build_object('state', x.status, 'reason', x.reason);
  select * into x from drive_extract where source_id = p_source and file_id = p_file and status = 'extracted'
   order by extracted_at desc, id desc limit 1;
  if not found then
   select * into x from drive_extract where source_id = p_source and file_id = p_file
    order by extracted_at desc, id desc limit 1;
  end if;
 end if;
 current_version := case when f.md5 is not null then 'md5:' || f.md5
                         else 'modified:' || coalesce(to_char(f.modified_at at time zone 'UTC',
                                                              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'unknown') end;
 gaps := x.gaps
   || case when f.availability = 'trashed' then array['raw_in_bin'] else '{}' end
   || case when f.availability = 'removed' then array['raw_unavailable'] else '{}' end
   || case when current_version <> x.source_version then array['newer_version_not_captured'] else '{}' end;
 if x.status <> 'extracted' then
  return query select jsonb_build_object('state', x.status, 'reason', x.reason, 'gaps', to_jsonb(gaps),
    'provenance', jsonb_build_object('format', x.format, 'extractor', x.extractor, 'capturedAt', x.extracted_at)),
    null::bytea, null::bytea;
  return;
 end if;
 select * into tp from pulse_priv.drive_payload where sha256 = x.text_sha256 and schema = x.text_schema;
 select * into fp from pulse_priv.drive_payload where sha256 = x.facts_sha256 and schema = x.facts_schema;
 return query select jsonb_build_object('state', 'readable', 'reason', null, 'gaps', to_jsonb(gaps), 'latest', latest,
   'provenance', jsonb_build_object(
     'source', s.label, 'fileId', x.file_id, 'name', x.file_name, 'mime', x.mime, 'format', x.format,
     'exportMime', x.export_mime, 'sourceVersion', x.source_version, 'fileModifiedAt', x.file_modified_at,
     'originalSize', x.original_size, 'originalSha256', x.original_sha256, 'extractor', x.extractor,
     'sandbox', x.sandbox, 'capturedAt', x.extracted_at, 'currentName', f.name, 'availability', f.availability),
   'text', jsonb_build_object('sha256', tp.sha256, 'schema', tp.schema, 'codec', tp.codec,
                              'rawLength', tp.raw_length, 'storedLength', tp.stored_length),
   'facts', jsonb_build_object('sha256', fp.sha256, 'schema', fp.schema, 'codec', fp.codec,
                               'rawLength', fp.raw_length, 'storedLength', fp.stored_length)),
   tp.data, fp.data;
end $$;

-- Health of document-text capture for organisation admins: approvals, counts by outcome and reason, held files and
-- stored sizes. No file name, text, account or token.
create function pulse.drive_extract_status() returns jsonb
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if not viewer_is('admin') then raise exception 'denied' using errcode = '42501'; end if;
 return jsonb_build_object('roots', coalesce((select jsonb_agg(jsonb_build_object(
   'id', s.id, 'label', s.label, 'tracked', s.enabled and s.approved_at is not null,
   'approved', p.approved_at is not null, 'enabled', coalesce(p.enabled, false), 'withdrawn', p.withdrawn_at is not null,
   'formats', to_jsonb(p.formats), 'audience', to_jsonb(p.audience), 'maxBytes', p.max_bytes,
   'lastRunAt', p.last_run_at, 'errorCode', p.last_error_code,
   'outcomes', coalesce((select jsonb_object_agg(o.status, o.n) from (
      select l.status, count(*)::int n from (
        select distinct on (x.file_id) x.status from drive_extract x where x.source_id = s.id
         order by x.file_id, x.extracted_at desc, x.id desc) l group by l.status) o), '{}'::jsonb),
   'reasons', coalesce((select jsonb_object_agg(o.reason, o.n) from (
      select l.reason, count(*)::int n from (
        select distinct on (x.file_id) x.reason from drive_extract x where x.source_id = s.id
         order by x.file_id, x.extracted_at desc, x.id desc) l where l.reason is not null group by l.reason) o),
      '{}'::jsonb),
   'held', (select count(distinct x.file_id) from drive_extract x
             where x.source_id = s.id and x.status = 'extracted' and drive_text_hold(s.id, x.file_id) is not null)::int,
   'payloads', (select count(*) from pulse_priv.drive_payload d where exists (
      select 1 from drive_extract x where x.source_id = s.id and d.sha256 in (x.text_sha256, x.facts_sha256)))::int,
   'storedBytes', (select coalesce(sum(d.stored_length), 0) from pulse_priv.drive_payload d where exists (
      select 1 from drive_extract x where x.source_id = s.id and d.sha256 in (x.text_sha256, x.facts_sha256)))::bigint,
   'rawBytes', (select coalesce(sum(d.raw_length), 0) from pulse_priv.drive_payload d where exists (
      select 1 from drive_extract x where x.source_id = s.id and d.sha256 in (x.text_sha256, x.facts_sha256)))::bigint
  ) order by s.label) from drive_extract_policy p join drive_source s on s.id = p.source_id), '[]'::jsonb));
end $$;

revoke all on function pulse.drive_text_hold(uuid, text), pulse.drive_text(uuid, text), pulse.drive_extract_status()
  from public;
grant execute on function pulse.drive_text(uuid, text), pulse.drive_extract_status() to pulse_api;
grant execute on function pulse.drive_text_hold(uuid, text) to pulse_worker;

-- migrate:down
-- Forward-only: captured text, facts, provenance and reviews are retained.
