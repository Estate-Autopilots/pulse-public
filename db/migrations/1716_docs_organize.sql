-- migrate:up
-- DOCS-MCP (owner, 8 Nov 2026, from the 7 Nov meeting with Kazuk): Docs organised like a Drive, so each project's
-- ideas, offer stages and SOPs live in one place that people and their own AI (Claude, Claude Code, Gemini over MCP)
-- read and write. docs/spec/DOCS.md § "Organise and connect your AI" has the design.
--   * a doc has tags (lowercase words, at most 20: "offer", "sop", "stage 2") and one category ("SOP", "Offer" …);
--   * a folder is the company's (everyone who may use Docs sees it) or private to chosen people. A private folder hides
--     everything inside it, folders and docs at any depth, from everyone else, admins included, on every path (screens,
--     API v1, MCP, search, mentions), because doc_can_see itself now checks the folder chain. A doc's owner still sees
--     their own doc.
--   * only the folder's maker (or an admin who can see it) changes who a folder is for.

create function pulse.doc_tags_ok(t text[]) returns boolean
 language sql immutable set search_path=pulse,pg_temp as $$
 select cardinality(t) <= 20 and not exists(select 1 from unnest(t) x where x is null or x <> lower(x) or x !~ '^[[:alnum:]][[:alnum:] ._&+-]{0,39}$')
$$;

alter table pulse.doc add column tags text[] not null default '{}' constraint doc_tags_valid check (pulse.doc_tags_ok(tags)),
  add column category text constraint doc_category_valid check (category is null or (length(btrim(category)) between 1 and 40 and category !~ '[[:cntrl:]]'));
create index doc_tags on pulse.doc using gin(tags) where archived_at is null;

alter table pulse.doc_folder add column access text not null default 'company' constraint doc_folder_access_valid check (access in ('company', 'people'));

-- Chosen people of a private folder (access 'people'). Its maker always sees it.
create table pulse.doc_folder_share (
  org_id uuid not null references pulse.org(id),
  folder_id uuid not null references pulse.doc_folder(id),
  person_id uuid not null references pulse.person(id),
  added_by uuid not null references pulse.person(id),
  added_at timestamptz not null default now(),
  primary key (folder_id, person_id)
);
create index doc_folder_share_person on pulse.doc_folder_share(org_id, person_id);

-- A folder is visible when no folder on its way up to the top is private to other people. No folder: visible.
create function pulse.doc_folder_can_see(p_folder uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 with recursive up(id, parent_id, access, created_by, hops) as (
   select f.id, f.parent_id, f.access, f.created_by, 0 from doc_folder f where f.org_id = current_org() and f.id = p_folder
   union all
   select f.id, f.parent_id, f.access, f.created_by, u.hops + 1 from doc_folder f join up u on f.id = u.parent_id where f.org_id = current_org() and u.hops < 14
 )
 select p_folder is null or (exists(select 1 from up) and not exists(select 1 from up where up.access = 'people' and up.created_by <> current_viewer()
   and not exists(select 1 from doc_folder_share s where s.org_id = current_org() and s.folder_id = up.id and s.person_id = current_viewer())))
$$;

-- One folder row as the viewer meets it: its own privacy from its own values (so a folder just made is seen by its
-- maker inside the same statement), then everything above it.
create function pulse.doc_folder_row_ok(p_id uuid, p_parent uuid, p_access text, p_owner uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select (p_access <> 'people' or p_owner = current_viewer()
     or exists(select 1 from doc_folder_share s where s.org_id = current_org() and s.folder_id = p_id and s.person_id = current_viewer()))
   and doc_folder_can_see(p_parent)
$$;

-- Who a folder is for is its maker's to decide (and an admin's who can see it).
create function pulse.doc_folder_can_share(p_folder uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select doc_member_ok() and doc_folder_can_see(p_folder)
   and coalesce((select f.created_by = current_viewer() or viewer_is('admin') from doc_folder f where f.org_id = current_org() and f.id = p_folder), false)
$$;

-- doc_can_see / doc_can_edit (1686) keep their rules and add the folder chain; the owner keeps their own doc.
create or replace function pulse.doc_can_see(p_doc uuid, p_access text, p_owner uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select doc_member_ok() and (p_owner = current_viewer() or ((p_access = 'company'
   or (p_access = 'people' and exists(select 1 from doc_share s where s.org_id = current_org() and s.doc_id = p_doc and s.person_id = current_viewer())))
   and doc_folder_can_see((select d.folder_id from doc d where d.org_id = current_org() and d.id = p_doc))))
$$;
create or replace function pulse.doc_can_edit(p_doc uuid, p_access text, p_owner uuid, p_company_edits boolean) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select doc_member_ok() and (p_owner = current_viewer() or (((p_access = 'company' and (p_company_edits or viewer_is('admin')))
   or (p_access = 'people' and exists(select 1 from doc_share s where s.org_id = current_org() and s.doc_id = p_doc and s.person_id = current_viewer() and s.can_edit)))
   and doc_folder_can_see((select d.folder_id from doc d where d.org_id = current_org() and d.id = p_doc))))
$$;

create function pulse.doc_folder_access_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if new.access <> old.access and not (old.created_by = current_viewer() or viewer_is('admin')) then
  raise exception 'Only the folder''s maker changes who it is for' using errcode = '42501';
 end if;
 return new;
end $$;
create trigger doc_folder_access_guard before update on pulse.doc_folder for each row execute function pulse.doc_folder_access_guard();

-- ------------------------------------------------------------------------------------------------ row security
drop policy doc_folder_see on pulse.doc_folder;
create policy doc_folder_see on pulse.doc_folder as restrictive for select to pulse_api using (pulse.doc_member_ok() and pulse.doc_folder_row_ok(id, parent_id, access, created_by));

drop policy doc_file_see on pulse.doc_file;
create policy doc_file_see on pulse.doc_file as restrictive for select to pulse_api
  using (pulse.doc_member_ok() and (doc_id is null or pulse.doc_id_can_see(doc_id)) and pulse.doc_folder_can_see(folder_id));

alter table pulse.doc_folder_share enable row level security;
alter table pulse.doc_folder_share force row level security;
create policy tenant_isolation on pulse.doc_folder_share using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_folder_share_see on pulse.doc_folder_share as restrictive for select to pulse_api using (pulse.doc_member_ok() and pulse.doc_folder_can_see(folder_id));
create policy doc_folder_share_insert on pulse.doc_folder_share as restrictive for insert to pulse_api
  with check (added_by = pulse.current_viewer() and pulse.doc_folder_can_share(folder_id)
    and exists(select 1 from pulse.person p where p.id = person_id and p.side in ('staff', 'agent')));
create policy doc_folder_share_delete on pulse.doc_folder_share as restrictive for delete to pulse_api using (pulse.doc_folder_can_share(folder_id));

grant update (tags, category) on pulse.doc to pulse_api;
grant update (access) on pulse.doc_folder to pulse_api;
grant select, insert, delete on pulse.doc_folder_share to pulse_api;
grant execute on function pulse.doc_tags_ok(text[]), pulse.doc_folder_can_see(uuid), pulse.doc_folder_row_ok(uuid, uuid, text, uuid), pulse.doc_folder_can_share(uuid) to pulse_api;

-- migrate:down
-- Forward-only.
