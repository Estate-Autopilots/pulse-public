-- migrate:up
-- DOCS-WORKBENCH (owner, 6 Nov 2026: "a super document-saving system with an editor, folders, files … very simple to
-- use … you can tag different things, people, everything"): the company's own documents. Folders hold docs and files;
-- a doc is rich text (headings, lists, tables, checklists, code, images, callouts) that mentions people, tasks,
-- projects, goals, contracts, clients, files, AI employees and other docs, saved as it is typed with a version history.
-- docs/spec/DOCS.md says what each part does. Who sees and changes what is decided here, under forced row security:
--   * a doc is private (its owner only), the company's (every staff member and AI employee), or chosen people's;
--   * a company doc is changed by everyone unless its owner keeps it read-only; chosen people read or also edit;
--   * only the owner (or an admin) changes who it is shared with; docs are archived, never deleted;
--   * clients, freelancers and contacts never reach docs.
-- The stored body is HTML the API has already sanitised (services/api/src/docs.ts); files are kept here, size-capped,
-- and are always served with a sandbox CSP, never run on the app's origin.

create table pulse.doc_folder (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references pulse.doc_folder(id),
  name text not null check (length(btrim(name)) between 1 and 120 and name !~ '[[:cntrl:]]'),
  created_by uuid not null references pulse.person(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint doc_folder_not_own_parent check (parent_id is null or parent_id <> id)
);
create index doc_folder_org on pulse.doc_folder(org_id, parent_id) where archived_at is null;

create table pulse.doc (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  folder_id uuid references pulse.doc_folder(id),
  title text not null default 'Untitled' check (length(btrim(title)) between 1 and 200 and title !~ '[[:cntrl:]]'),
  body_html text not null default '' check (length(body_html) <= 1000000),
  body_text text not null default '' check (length(body_text) <= 400000),
  access text not null default 'private' check (access in ('private', 'company', 'people')),
  company_edits boolean not null default true,
  created_by uuid not null references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  archived_at timestamptz,
  search tsvector generated always as (setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', left(coalesce(body_text, ''), 200000)), 'B')) stored
);
create index doc_org_folder on pulse.doc(org_id, folder_id, updated_at desc) where archived_at is null;
create index doc_search on pulse.doc using gin(search);

-- Chosen people (access 'people'): each reads, and edits when can_edit.
create table pulse.doc_share (
  org_id uuid not null references pulse.org(id),
  doc_id uuid not null references pulse.doc(id),
  person_id uuid not null references pulse.person(id),
  can_edit boolean not null default false,
  added_by uuid not null references pulse.person(id),
  added_at timestamptz not null default now(),
  primary key (doc_id, person_id)
);
create index doc_share_person on pulse.doc_share(org_id, person_id);

-- Version history: one row per person per editing session (10 minutes), plus every restore and import.
create table pulse.doc_version (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references pulse.doc(id),
  version int not null,
  title text not null,
  body_html text not null,
  saved_by uuid references pulse.person(id),
  saved_at timestamptz not null default now(),
  started_at timestamptz not null default now(),
  reason text not null default 'edit' check (reason in ('edit', 'restore', 'import', 'create'))
);
create index doc_version_doc on pulse.doc_version(org_id, doc_id, saved_at desc);

create table pulse.doc_comment (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references pulse.doc(id),
  person_id uuid not null references pulse.person(id),
  body text not null check (length(btrim(body)) between 1 and 4000),
  quote text check (length(quote) <= 500),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references pulse.person(id),
  removed_at timestamptz
);
create index doc_comment_doc on pulse.doc_comment(org_id, doc_id, created_at);

-- What a doc mentions (kept by the API on each save), so a task, project, goal … shows the docs that mention it.
create table pulse.doc_mention (
  org_id uuid not null references pulse.org(id),
  doc_id uuid not null references pulse.doc(id),
  kind text not null check (kind in ('person', 'agent', 'task', 'project', 'goal', 'contract', 'client', 'file', 'doc')),
  ref_id uuid not null,
  label text not null default '' check (length(label) <= 200),
  primary key (doc_id, kind, ref_id)
);
create index doc_mention_ref on pulse.doc_mention(org_id, kind, ref_id);

-- Files: kept in a folder (shown with its docs) or inside a doc (an image or attachment). Capped at 10 MB each.
create table pulse.doc_file (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  folder_id uuid references pulse.doc_folder(id),
  doc_id uuid references pulse.doc(id),
  name text not null check (length(btrim(name)) between 1 and 200 and name !~ '[[:cntrl:]]'),
  mime text not null check (mime ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$' and length(mime) <= 120),
  size int not null check (size between 1 and 10485760),
  sha256 text not null,
  bytes bytea not null check (octet_length(bytes) <= 10485760),
  added_by uuid not null references pulse.person(id),
  added_at timestamptz not null default now(),
  archived_at timestamptz
);
create index doc_file_folder on pulse.doc_file(org_id, folder_id) where archived_at is null;
create index doc_file_doc on pulse.doc_file(org_id, doc_id) where doc_id is not null;

-- ------------------------------------------------------------------------------------------------ who may
-- Staff and AI employees of this company, signed in as themselves (never a client's, freelancer's or contact's seat).
create function pulse.doc_member_ok() returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and not viewer_outside_seat()
   and exists(select 1 from person p where p.org_id = current_org() and p.id = current_viewer() and p.side in ('staff', 'agent') and p.status = 'active')
$$;

create function pulse.doc_can_see(p_doc uuid, p_access text, p_owner uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select doc_member_ok() and (p_owner = current_viewer() or p_access = 'company'
   or (p_access = 'people' and exists(select 1 from doc_share s where s.org_id = current_org() and s.doc_id = p_doc and s.person_id = current_viewer())))
$$;

create function pulse.doc_can_edit(p_doc uuid, p_access text, p_owner uuid, p_company_edits boolean) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select doc_member_ok() and (p_owner = current_viewer()
   or (p_access = 'company' and (p_company_edits or viewer_is('admin')))
   or (p_access = 'people' and exists(select 1 from doc_share s where s.org_id = current_org() and s.doc_id = p_doc and s.person_id = current_viewer() and s.can_edit)))
$$;

-- Looked up past the viewer's own read rules (for the tables that hang off a doc).
create function pulse.doc_id_can_see(p_doc uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select doc_can_see(d.id, d.access, d.created_by) from doc d where d.org_id = current_org() and d.id = p_doc), false)
$$;
create function pulse.doc_id_can_edit(p_doc uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select doc_can_edit(d.id, d.access, d.created_by, d.company_edits) from doc d where d.org_id = current_org() and d.id = p_doc and d.archived_at is null), false)
$$;
-- Who it is shared with is the owner's to decide (and an admin's).
create function pulse.doc_id_can_share(p_doc uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select doc_member_ok() and coalesce((select d.created_by = current_viewer() or viewer_is('admin') from doc d where d.org_id = current_org() and d.id = p_doc), false)
$$;

-- A doc's guard: the owner never changes; sharing changes only by the owner or an admin; each change of words bumps the
-- version and is kept in the history (one row per person per 10-minute session, so autosave does not flood it).
create function pulse.doc_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if tg_op = 'UPDATE' then
  if new.created_by <> old.created_by then raise exception 'A doc keeps its owner' using errcode = '42501'; end if;
  if (new.access <> old.access or new.company_edits <> old.company_edits) and not (old.created_by = current_viewer() or viewer_is('admin')) then
   raise exception 'Only the doc''s owner changes who it is shared with' using errcode = '42501';
  end if;
  if new.archived_at is distinct from old.archived_at and not (old.created_by = current_viewer() or viewer_is('admin')) then
   raise exception 'Only the doc''s owner archives it' using errcode = '42501';
  end if;
  if new.title is distinct from old.title or new.body_html is distinct from old.body_html then
   new.version := old.version + 1;
   new.updated_at := now();
   new.updated_by := current_viewer();
  end if;
 else
  new.updated_by := coalesce(new.updated_by, new.created_by);
 end if;
 if new.folder_id is not null and not exists(select 1 from doc_folder f where f.org_id = new.org_id and f.id = new.folder_id) then
  raise exception 'That folder is not in this company' using errcode = '22023';
 end if;
 return new;
end $$;
create trigger doc_guard before insert or update on pulse.doc for each row execute function pulse.doc_guard();

create function pulse.doc_keep_version() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare last doc_version; why text := coalesce(nullif(current_setting('pulse.doc_save_reason', true), ''), 'edit');
begin
 if tg_op = 'UPDATE' and new.title is not distinct from old.title and new.body_html is not distinct from old.body_html then return null; end if;
 select * into last from doc_version v where v.org_id = new.org_id and v.doc_id = new.id order by v.saved_at desc limit 1;
 if tg_op = 'UPDATE' and why = 'edit' and last.id is not null and last.reason in ('edit', 'create') and last.saved_by is not distinct from current_viewer()
    and last.started_at > now() - interval '10 minutes' then
  update doc_version set version = new.version, title = new.title, body_html = new.body_html, saved_at = now() where id = last.id;
 else
  insert into doc_version(org_id, doc_id, version, title, body_html, saved_by, reason)
   values (new.org_id, new.id, new.version, new.title, new.body_html, current_viewer(), case when tg_op = 'INSERT' and why = 'edit' then 'create' else why end);
 end if;
 return null;
end $$;
create trigger doc_keep_version after insert or update on pulse.doc for each row execute function pulse.doc_keep_version();

create function pulse.doc_folder_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare hops int := 0; cur uuid := new.parent_id;
begin
 while cur is not null loop
  if cur = new.id then raise exception 'A folder cannot sit inside itself' using errcode = '22023'; end if;
  hops := hops + 1;
  if hops > 12 then raise exception 'Folders nest at most 12 deep' using errcode = '22023'; end if;
  select parent_id into cur from doc_folder where org_id = new.org_id and id = cur;
 end loop;
 return new;
end $$;
create trigger doc_folder_guard before insert or update on pulse.doc_folder for each row execute function pulse.doc_folder_guard();

-- ------------------------------------------------------------------------------------------------ row security
alter table pulse.doc_folder enable row level security;
alter table pulse.doc_folder force row level security;
create policy tenant_isolation on pulse.doc_folder using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_folder_see on pulse.doc_folder as restrictive for select to pulse_api using (pulse.doc_member_ok());
create policy doc_folder_insert on pulse.doc_folder as restrictive for insert to pulse_api with check (created_by = pulse.current_viewer() and pulse.doc_member_ok());
create policy doc_folder_update on pulse.doc_folder as restrictive for update to pulse_api
  using (pulse.doc_member_ok() and (created_by = pulse.current_viewer() or pulse.viewer_is('admin', 'leadership')))
  with check (pulse.doc_member_ok());

alter table pulse.doc enable row level security;
alter table pulse.doc force row level security;
create policy tenant_isolation on pulse.doc using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_see on pulse.doc as restrictive for select to pulse_api using (pulse.doc_can_see(id, access, created_by));
create policy doc_insert on pulse.doc as restrictive for insert to pulse_api with check (created_by = pulse.current_viewer() and pulse.doc_member_ok());
create policy doc_update on pulse.doc as restrictive for update to pulse_api
  using (pulse.doc_can_edit(id, access, created_by, company_edits)) with check (pulse.doc_member_ok());

alter table pulse.doc_share enable row level security;
alter table pulse.doc_share force row level security;
create policy tenant_isolation on pulse.doc_share using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_share_see on pulse.doc_share as restrictive for select to pulse_api using (pulse.doc_id_can_see(doc_id));
create policy doc_share_insert on pulse.doc_share as restrictive for insert to pulse_api with check (added_by = pulse.current_viewer() and pulse.doc_id_can_share(doc_id)
  and exists(select 1 from pulse.person p where p.id = person_id and p.side in ('staff', 'agent')));
create policy doc_share_update on pulse.doc_share as restrictive for update to pulse_api using (pulse.doc_id_can_share(doc_id)) with check (pulse.doc_id_can_share(doc_id));
create policy doc_share_delete on pulse.doc_share as restrictive for delete to pulse_api using (pulse.doc_id_can_share(doc_id));

alter table pulse.doc_version enable row level security;
alter table pulse.doc_version force row level security;
create policy tenant_isolation on pulse.doc_version using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_version_see on pulse.doc_version as restrictive for select to pulse_api using (pulse.doc_id_can_see(doc_id));

alter table pulse.doc_comment enable row level security;
alter table pulse.doc_comment force row level security;
create policy tenant_isolation on pulse.doc_comment using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_comment_see on pulse.doc_comment as restrictive for select to pulse_api using (pulse.doc_id_can_see(doc_id));
create policy doc_comment_insert on pulse.doc_comment as restrictive for insert to pulse_api
  with check (person_id = pulse.current_viewer() and pulse.doc_id_can_see(doc_id) and resolved_at is null and removed_at is null);
-- Resolved by anyone who may edit the doc; taken back (removed) by its writer.
create policy doc_comment_update on pulse.doc_comment as restrictive for update to pulse_api
  using (pulse.doc_id_can_see(doc_id) and (person_id = pulse.current_viewer() or pulse.doc_id_can_edit(doc_id))) with check (pulse.doc_id_can_see(doc_id));

alter table pulse.doc_mention enable row level security;
alter table pulse.doc_mention force row level security;
create policy tenant_isolation on pulse.doc_mention using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_mention_see on pulse.doc_mention as restrictive for select to pulse_api using (pulse.doc_id_can_see(doc_id));
create policy doc_mention_insert on pulse.doc_mention as restrictive for insert to pulse_api with check (pulse.doc_id_can_edit(doc_id));
create policy doc_mention_delete on pulse.doc_mention as restrictive for delete to pulse_api using (pulse.doc_id_can_edit(doc_id));

alter table pulse.doc_file enable row level security;
alter table pulse.doc_file force row level security;
create policy tenant_isolation on pulse.doc_file using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_file_see on pulse.doc_file as restrictive for select to pulse_api
  using (pulse.doc_member_ok() and (doc_id is null or pulse.doc_id_can_see(doc_id)));
create policy doc_file_insert on pulse.doc_file as restrictive for insert to pulse_api
  with check (added_by = pulse.current_viewer() and pulse.doc_member_ok() and (doc_id is null or pulse.doc_id_can_edit(doc_id)));
create policy doc_file_update on pulse.doc_file as restrictive for update to pulse_api
  using (pulse.doc_member_ok() and (added_by = pulse.current_viewer() or pulse.viewer_is('admin') or (doc_id is not null and pulse.doc_id_can_edit(doc_id))))
  with check (pulse.doc_member_ok());

grant select, insert, update (name, parent_id, archived_at) on pulse.doc_folder to pulse_api;
grant select, insert, update (folder_id, title, body_html, body_text, access, company_edits, archived_at) on pulse.doc to pulse_api;
grant select, insert, update (can_edit), delete on pulse.doc_share to pulse_api;
grant select on pulse.doc_version to pulse_api;
grant select, insert, update (resolved_at, resolved_by, removed_at) on pulse.doc_comment to pulse_api;
grant select, insert, delete on pulse.doc_mention to pulse_api;
grant select, insert, update (name, folder_id, archived_at) on pulse.doc_file to pulse_api;
grant execute on function pulse.doc_member_ok(), pulse.doc_can_see(uuid, text, uuid), pulse.doc_can_edit(uuid, text, uuid, boolean),
  pulse.doc_id_can_see(uuid), pulse.doc_id_can_edit(uuid), pulse.doc_id_can_share(uuid) to pulse_api;

-- migrate:down
-- Forward-only.
