-- migrate:up
-- R41 (11 Oct 2026): a policy version may carry its Word (.docx) source, and an approved browser editor (ONLYOFFICE
-- Docs; off until the owner approves a provider, a licence and round-trip fidelity: docs/ops/POLICY-WORD.md) edits
-- it through short-lived sessions that each open exactly one state of one policy.
--  * Word files are kept by content: pulse.policy_docx holds each file once per organisation under the SHA-256 the
--    database computes itself, and a kept file never changes. A version names its file (docx_sha256), so a published
--    version keeps the exact bytes HR published (the 0127 guard already freezes published rows).
--  * What employees read stays policy_document.body: when Word is the source, the API derives that text from the file.
--    Changing the text in the Markdown editor drops the Word file from that draft, so the two never silently disagree.
--  * An editor session is a random token (only its hash is kept) bound to one person, the document, revision, status
--    and file it opened, and the provider's document key. A save whose state moved on (another save, a publish, a newer
--    version) is refused: a stale key never overwrites newer text or a published version.

create table pulse.policy_docx (
 org_id uuid not null references pulse.org(id),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 bytes bytea not null check(octet_length(bytes) between 1 and 5242880),
 created_at timestamptz not null default now(),
 created_by uuid references pulse.person(id),
 primary key(org_id,sha256)
);
alter table pulse.policy_document
 add column docx_sha256 text check(docx_sha256 ~ '^[0-9a-f]{64}$'),
 add column docx_name text check(length(docx_name) between 1 and 160),
 add column docx_source text check(docx_source in ('upload','editor')),
 add constraint policy_document_docx foreign key(org_id,docx_sha256) references pulse.policy_docx(org_id,sha256);

create table pulse.policy_editor_session (
 org_id uuid not null references pulse.org(id),
 id uuid primary key default gen_random_uuid(),
 token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
 doc_key text not null check(doc_key ~ '^[0-9A-Za-z._=-]{1,128}$'),
 document_id uuid not null references pulse.policy_document(id),
 opened_status text not null check(opened_status in ('draft','published')),
 revision int not null,
 docx_sha256 text not null,
 person_id uuid not null references pulse.person(id),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 last_status int,
 last_event_at timestamptz,
 closed_at timestamptz,
 outcome text check(outcome in ('saved','unchanged','stale','denied','expired','provider_error')),
 saved_document uuid references pulse.policy_document(id)
);
create index policy_editor_session_key on pulse.policy_editor_session(org_id,doc_key) where closed_at is null;

do $$ declare t text;begin foreach t in array array['policy_docx','policy_editor_session'] loop
 execute format('alter table pulse.%I enable row level security',t);execute format('alter table pulse.%I force row level security',t);
 execute format('create policy tenant on pulse.%I using(org_id=pulse.current_org()) with check(org_id=pulse.current_org())',t);
 end loop;end $$;

create function pulse.policy_docx_frozen() returns trigger language plpgsql set search_path=pulse,pg_temp as $$
begin raise exception 'a kept Word file never changes' using errcode='42501'; end $$;
create trigger policy_docx_frozen before update on pulse.policy_docx for each row execute function pulse.policy_docx_frozen();

-- Keep a Word file once per organisation, under the hash computed here (never one the caller claims).
create function pulse.policy_docx_keep(p_bytes bytea) returns text language plpgsql security definer set search_path=pulse,pg_temp as $$
declare h text;
begin
 if p_bytes is null or octet_length(p_bytes) not between 1 and 5242880 then raise exception 'a Word file can be at most 5 MB' using errcode='22023'; end if;
 h:=encode(sha256(p_bytes),'hex');
 insert into policy_docx(org_id,sha256,bytes,created_by) values(current_org(),h,p_bytes,current_viewer()) on conflict do nothing;
 return h;
end $$;

-- 0127's Markdown autosave, unchanged except that new text drops the draft's Word file (a title-only change keeps it).
create or replace function pulse.policy_draft_save(p_kind text,p_title text,p_body text,p_version int,p_revision int) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare latest policy_document; saved policy_document;
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'denied' using errcode='42501'; end if;
 if p_kind is null or p_version is null or length(coalesce(p_body,'')) not between 10 and 30000 or length(coalesce(p_title,'')) not between 2 and 100 then
  raise exception 'invalid policy' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtext(current_org()::text||p_kind));
 select * into latest from policy_document where kind=p_kind order by version desc limit 1;
 if coalesce(latest.version,0)<>p_version then raise exception 'document changed; refresh before editing' using errcode='40001'; end if;
 if latest.status='draft' then
  if latest.revision is distinct from p_revision then raise exception 'draft changed; refresh before editing' using errcode='40001'; end if;
  if latest.title=p_title and latest.body=p_body then saved:=latest;
  else update policy_document set title=p_title,body=p_body,revision=revision+1,updated_at=now(),updated_by=current_viewer(),
   docx_sha256=case when latest.body=p_body then docx_sha256 end,docx_name=case when latest.body=p_body then docx_name end,
   docx_source=case when latest.body=p_body then docx_source end where id=latest.id returning * into saved;
  end if;
 else
  insert into policy_document(org_id,kind,version,title,body,status,created_by)
  values(current_org(),p_kind,coalesce(latest.version,0)+1,p_title,p_body,'draft',current_viewer()) returning * into saved;
 end if;
 return jsonb_build_object('id',saved.id,'version',saved.version,'revision',saved.revision,'savedAt',coalesce(saved.updated_at,saved.created_at));
end $$;

-- Save a Word file as the draft, with the text the reader shows: into the latest draft, or as the next version on top
-- of a published one. The same checks as policy_draft_save: p_version/p_revision are the state that was opened.
create function pulse.policy_docx_draft_save(p_kind text,p_title text,p_body text,p_version int,p_revision int,p_bytes bytea,p_name text,p_source text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare latest policy_document; saved policy_document; h text;
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'denied' using errcode='42501'; end if;
 if p_kind is null or p_version is null or length(coalesce(p_body,'')) not between 10 and 30000 or length(coalesce(p_title,'')) not between 2 and 100
  or p_source is null or p_source not in ('upload','editor') or length(coalesce(p_name,'')) not between 1 and 160 then
  raise exception 'invalid policy' using errcode='22023';
 end if;
 perform pg_advisory_xact_lock(hashtext(current_org()::text||p_kind));
 select * into latest from policy_document where kind=p_kind order by version desc limit 1;
 if coalesce(latest.version,0)<>p_version then raise exception 'document changed; refresh before editing' using errcode='40001'; end if;
 if latest.status='draft' and latest.revision is distinct from p_revision then raise exception 'draft changed; refresh before editing' using errcode='40001'; end if;
 h:=policy_docx_keep(p_bytes);
 if latest.status='draft' then
  if latest.docx_sha256 is not distinct from h and latest.title=p_title and latest.body=p_body then saved:=latest;
  else update policy_document set title=p_title,body=p_body,docx_sha256=h,docx_name=p_name,docx_source=p_source,revision=revision+1,updated_at=now(),updated_by=current_viewer()
   where id=latest.id returning * into saved;
  end if;
 else
  insert into policy_document(org_id,kind,version,title,body,status,created_by,docx_sha256,docx_name,docx_source)
  values(current_org(),p_kind,coalesce(latest.version,0)+1,p_title,p_body,'draft',current_viewer(),h,p_name,p_source) returning * into saved;
 end if;
 return jsonb_build_object('id',saved.id,'version',saved.version,'revision',saved.revision,'savedAt',coalesce(saved.updated_at,saved.created_at),'sha256',h);
end $$;

-- HR opens the editor on the latest version of a policy that has a Word file. p_token_hash is the hash of the random
-- token the API puts into the file and callback addresses; the result is what the API signs into the editor's config.
create function pulse.policy_editor_open(p_document uuid,p_token_hash text,p_hours int) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare d policy_document; k text; s policy_editor_session;
begin
 if not viewer_is('admin','hr','leadership') or current_viewer() is null then raise exception 'denied' using errcode='42501'; end if;
 if coalesce(p_token_hash,'') !~ '^[0-9a-f]{64}$' or coalesce(p_hours,0) not between 1 and 12 then raise exception 'invalid editor session' using errcode='22023'; end if;
 select * into d from policy_document where id=p_document;
 if not found then raise exception 'choose a policy' using errcode='P0002'; end if;
 if exists(select 1 from policy_document n where n.kind=d.kind and n.version>d.version) then raise exception 'document changed; refresh before editing' using errcode='40001'; end if;
 if d.docx_sha256 is null then raise exception 'this version has no Word file; upload one first' using errcode='22023'; end if;
 -- One state of one policy has one key, so two people who open it edit together; every save changes it.
 k:='pulse-'||left(encode(sha256(convert_to(d.org_id::text||'/'||d.id::text||'/'||d.status||'/'||d.revision::text||'/'||d.docx_sha256,'UTF8')),'hex'),40);
 insert into policy_editor_session(org_id,token_hash,doc_key,document_id,opened_status,revision,docx_sha256,person_id,expires_at)
 values(current_org(),p_token_hash,k,d.id,d.status,d.revision,d.docx_sha256,current_viewer(),now()+make_interval(hours=>p_hours)) returning * into s;
 return jsonb_build_object('session',s.id,'key',k,'documentId',d.id,'kind',d.kind,'title',d.title,'version',d.version,'revision',d.revision,
  'status',d.status,'sha256',d.docx_sha256,'name',d.docx_name,'expiresAt',s.expires_at);
end $$;

-- The provider fetches the file an open session opened (signed out: the token is the capability).
create function pulse.policy_editor_file(p_token_hash text) returns bytea language sql stable security definer set search_path=pulse,pg_temp as $$
 select f.bytes from policy_editor_session s join policy_docx f on f.org_id=s.org_id and f.sha256=s.docx_sha256
 where s.token_hash=p_token_hash and s.org_id=current_org() and s.closed_at is null and s.expires_at>now()
$$;

-- The provider's callback, after the API checked the provider's signature and fetched the saved file from the
-- provider's own address. Status 1 editing, 2 ready to save (everyone closed), 4 closed unchanged, 6 saved while still
-- open, 3/7 the provider failed to save. A save runs as the person who opened the session, whose HR/leadership role
-- and active status are checked again now; sessions sharing the key (people editing together) move as one.
create function pulse.policy_editor_event(p_token_hash text,p_key text,p_status int,p_bytes bytea,p_body text) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s policy_editor_session; d policy_document; h text; r jsonb;
begin
 select * into s from policy_editor_session where token_hash=p_token_hash and org_id=current_org() for update;
 if not found then raise exception 'unknown editor session' using errcode='P0002'; end if;
 if s.doc_key<>coalesce(p_key,'') then raise exception 'this editor session belongs to another document key' using errcode='22023'; end if;
 if p_status is null or p_status not in (1,2,3,4,6,7) then raise exception 'unknown editor status' using errcode='22023'; end if;
 if s.closed_at is not null then return jsonb_build_object('outcome','closed'); end if;
 update policy_editor_session set last_status=p_status,last_event_at=now() where id=s.id;
 if s.expires_at<=now() then update policy_editor_session set closed_at=now(),outcome='expired' where id=s.id; return jsonb_build_object('outcome','expired'); end if;
 if p_status=1 then return jsonb_build_object('outcome','editing'); end if;
 if p_status in (3,7) then
  if p_status=3 then update policy_editor_session set closed_at=now(),outcome='provider_error' where id=s.id; end if;
  return jsonb_build_object('outcome','provider_error');
 end if;
 if p_status=4 then update policy_editor_session set closed_at=now(),outcome='unchanged' where doc_key=s.doc_key and closed_at is null; return jsonb_build_object('outcome','unchanged'); end if;
 perform set_config('pulse.viewer_id',s.person_id::text,true);
 if not viewer_is('admin','hr','leadership') or not exists(select 1 from person where id=s.person_id and status='active') then
  update policy_editor_session set closed_at=now(),outcome='denied' where id=s.id; return jsonb_build_object('outcome','denied');
 end if;
 select * into d from policy_document where id=s.document_id;
 perform pg_advisory_xact_lock(hashtext(current_org()::text||d.kind));
 select * into d from policy_document where id=s.document_id;
 if d.status<>s.opened_status or d.revision<>s.revision or d.docx_sha256 is distinct from s.docx_sha256
  or exists(select 1 from policy_document n where n.kind=d.kind and n.version>d.version) then
  update policy_editor_session set closed_at=now(),outcome='stale' where doc_key=s.doc_key and closed_at is null;
  return jsonb_build_object('outcome','stale');
 end if;
 h:=encode(sha256(p_bytes),'hex');
 if h=s.docx_sha256 then
  if p_status=2 then update policy_editor_session set closed_at=now(),outcome='unchanged' where doc_key=s.doc_key and closed_at is null; end if;
  return jsonb_build_object('outcome','unchanged');
 end if;
 r:=policy_docx_draft_save(d.kind,d.title,p_body,d.version,d.revision,p_bytes,coalesce(d.docx_name,'policy.docx'),'editor');
 update policy_editor_session set saved_document=(r->>'id')::uuid,document_id=(r->>'id')::uuid,opened_status='draft',revision=(r->>'revision')::int,docx_sha256=h,
  closed_at=case when p_status=2 then now() end,outcome=case when p_status=2 then 'saved' end
 where doc_key=s.doc_key and closed_at is null;
 return r||jsonb_build_object('outcome','saved');
end $$;

-- HR downloads the exact Word file of a version (the same bytes, so the same SHA-256).
create function pulse.policy_docx_read(p_document uuid) returns table(bytes bytea,sha256 text,name text,version int,status text) language sql stable security definer set search_path=pulse,pg_temp as $$
 select f.bytes,f.sha256,d.docx_name,d.version,d.status from policy_document d join policy_docx f on f.org_id=d.org_id and f.sha256=d.docx_sha256
 where d.id=p_document and viewer_is('admin','hr','leadership') and current_viewer() is not null
$$;

revoke all on function pulse.policy_docx_frozen(),pulse.policy_docx_keep(bytea),pulse.policy_docx_draft_save(text,text,text,int,int,bytea,text,text),
 pulse.policy_editor_open(uuid,text,int),pulse.policy_editor_file(text),pulse.policy_editor_event(text,text,int,bytea,text),pulse.policy_docx_read(uuid) from public;
grant execute on function pulse.policy_docx_draft_save(text,text,text,int,int,bytea,text,text),pulse.policy_editor_open(uuid,text,int),
 pulse.policy_editor_file(text),pulse.policy_editor_event(text,text,int,bytea,text),pulse.policy_docx_read(uuid) to pulse_api;
-- migrate:down
-- Forward-only: kept Word files, the versions that name them and editor session records are retained.
