-- migrate:up
-- DOCS-DRIVE (owner, 8 Nov 2026: "make the UX like how we handle Drive … far better than Google Docs, and much nicer
-- for folders, folders under folders, documents and so on"). Docs becomes a file manager: a folder tree, Starred and
-- Recent, view / comment / edit sharing, and moves (one at a time or in bulk, by people and by their AI) that never
-- open a private folder's docs to more people without saying so. docs/spec/DOCS.md § "Drive" has the design.
--   * doc_star: each person's own stars on docs and folders (nobody else sees them, admins included);
--   * doc_recent: when each person last opened a doc (the Recent list); their own rows only;
--   * doc_share.can_comment: a chosen person reads only (view), comments too (comment), or edits (edit). Rows from
--     before keep commenting (the default), as they could;
--   * doc_comment_insert now needs pulse.doc_id_can_comment: the doc's owner, anyone who sees a company doc, or a chosen
--     person allowed to comment or edit;
--   * pulse.doc_folder_private_chain(folder) names the private folders on the way up from a folder (itself included),
--     so the API can tell when a move would let more people see something and ask first (services/api/src/docs.ts move).

create table pulse.doc_star (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references pulse.person(id),
  doc_id uuid references pulse.doc(id),
  folder_id uuid references pulse.doc_folder(id),
  starred_at timestamptz not null default now(),
  constraint doc_star_one_thing check ((doc_id is null) <> (folder_id is null))
);
create unique index doc_star_doc on pulse.doc_star(person_id, doc_id) where doc_id is not null;
create unique index doc_star_folder on pulse.doc_star(person_id, folder_id) where folder_id is not null;
create index doc_star_person on pulse.doc_star(org_id, person_id, starred_at desc);

create table pulse.doc_recent (
  org_id uuid not null references pulse.org(id),
  person_id uuid not null references pulse.person(id),
  doc_id uuid not null references pulse.doc(id),
  opened_at timestamptz not null default now(),
  primary key (person_id, doc_id)
);
create index doc_recent_person on pulse.doc_recent(org_id, person_id, opened_at desc);

alter table pulse.doc_share add column can_comment boolean not null default true;

-- The private folders above a folder (itself included), nearest first. Only folders the viewer can see are walked
-- (the caller already sees the folder), so it names nothing new.
create function pulse.doc_folder_private_chain(p_folder uuid) returns uuid[]
 language sql stable security definer set search_path=pulse,pg_temp as $$
 with recursive up(id, parent_id, access, hops) as (
   select f.id, f.parent_id, f.access, 0 from doc_folder f where f.org_id = current_org() and f.id = p_folder and doc_member_ok() and doc_folder_can_see(p_folder)
   union all
   select f.id, f.parent_id, f.access, u.hops + 1 from doc_folder f join up u on f.id = u.parent_id where f.org_id = current_org() and u.hops < 14
 )
 select coalesce(array_agg(id order by hops) filter (where access = 'people'), '{}'::uuid[]) from up
$$;

-- Who may comment: the owner, anyone who sees a company doc, or a chosen person allowed to comment or edit.
create function pulse.doc_id_can_comment(p_doc uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select doc_can_see(d.id, d.access, d.created_by) and (d.created_by = current_viewer() or d.access = 'company'
     or exists(select 1 from doc_share s where s.org_id = current_org() and s.doc_id = d.id and s.person_id = current_viewer() and (s.can_comment or s.can_edit)))
   from doc d where d.org_id = current_org() and d.id = p_doc), false)
$$;

drop policy doc_comment_insert on pulse.doc_comment;
create policy doc_comment_insert on pulse.doc_comment as restrictive for insert to pulse_api
  with check (person_id = pulse.current_viewer() and pulse.doc_id_can_comment(doc_id) and resolved_at is null and removed_at is null);

-- ------------------------------------------------------------------------------------------------ row security
alter table pulse.doc_star enable row level security;
alter table pulse.doc_star force row level security;
create policy tenant_isolation on pulse.doc_star using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_star_own on pulse.doc_star as restrictive for all to pulse_api
  using (person_id = pulse.current_viewer() and pulse.doc_member_ok())
  with check (person_id = pulse.current_viewer() and pulse.doc_member_ok()
    and (doc_id is null or pulse.doc_id_can_see(doc_id)) and (folder_id is null or pulse.doc_folder_can_see(folder_id)));

alter table pulse.doc_recent enable row level security;
alter table pulse.doc_recent force row level security;
create policy tenant_isolation on pulse.doc_recent using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_recent_own on pulse.doc_recent as restrictive for all to pulse_api
  using (person_id = pulse.current_viewer() and pulse.doc_member_ok())
  with check (person_id = pulse.current_viewer() and pulse.doc_member_ok() and pulse.doc_id_can_see(doc_id));

grant select, insert, delete on pulse.doc_star to pulse_api;
grant select, insert, update (opened_at), delete on pulse.doc_recent to pulse_api;
grant update (can_comment) on pulse.doc_share to pulse_api;
grant execute on function pulse.doc_folder_private_chain(uuid), pulse.doc_id_can_comment(uuid) to pulse_api;

-- migrate:down
-- Forward-only.
