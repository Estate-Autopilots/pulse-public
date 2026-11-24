-- migrate:up
-- DOCS-ACTIVITY (owner, 17 Nov 2026: "Docs, folders: there is no last editor and no trail. Last activity should be
-- visible, and whatever activity happened in a folder, that folder should pop up at the top, so I can find everything").
-- What a doc or folder went through is mostly kept already: versions (who saved, when, why), comments, chosen people,
-- reading receipts. What no table kept is added here, written only by triggers, so every path (the screen, API v1 and
-- MCP, the CLI, the server's own tools) is recorded the same way:
--   * doc_event: a doc or folder was made, moved, shared or unshared, had its access changed, was archived or restored,
--     or (a folder) renamed. Folder and person ids are kept, never their names, so the trail names a private folder only
--     to people who can see it (the API resolves names under the reader's own row security);
--   * doc_event.via / doc_version.via: how the change was made: by an AI employee ('ai'), through an API key or the MCP
--     connector ('api', with the key's name), or by one of the server's tools run for a person ('script', with the
--     tool's name). Nothing (null) is a person in the app;
--   * pulse.doc_note: a caller may give a short reason (an audit note) that the event keeps, e.g. a tidy-up's;
--   * doc_read_visible: an admin who can see a doc also sees who read it ("viewed-by for the owner/admins");
--   * backfill: docs and folders that the platform's ledger (pulse_priv.platform_audit, admin.import) says one of the
--     server's tools made get their 'created' event with via 'script', so they show as made by automation.
-- An event is seen by whoever can see its doc (or folder), staff and AI employees only. docs/spec/DOCS.md § "Activity".

create table pulse.doc_event (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  doc_id uuid references pulse.doc(id),
  folder_id uuid references pulse.doc_folder(id),
  kind text not null check (kind in ('created', 'moved', 'shared', 'unshared', 'access', 'archived', 'restored', 'renamed')),
  actor uuid references pulse.person(id),
  at timestamptz not null default now(),
  via text check (via in ('ai', 'api', 'script')),
  via_label text check (length(via_label) <= 80 and via_label !~ '[[:cntrl:]]'),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object' and length(detail::text) <= 4000),
  constraint doc_event_one_thing check ((doc_id is null) <> (folder_id is null))
);
create index doc_event_doc on pulse.doc_event(org_id, doc_id, at desc) where doc_id is not null;
create index doc_event_folder on pulse.doc_event(org_id, folder_id, at desc) where folder_id is not null;

alter table pulse.doc_version add column via text constraint doc_version_via_valid check (via in ('ai', 'api', 'script')),
  add column via_label text constraint doc_version_via_label_valid check (length(via_label) <= 80 and via_label !~ '[[:cntrl:]]');

-- ------------------------------------------------------------------------------------------------ how a change is made
-- 'ai': the viewer is an AI employee (its own session or its key); 'api': an API key (v1, MCP, CLI) in a person's name,
-- labelled with the key's name; 'script': one of the server's tools acting for a person (its actor is a tool's label,
-- "tool · approver: …", not a sign-in address). Null: a person in the app.
create function pulse.doc_via() returns table (via text, label text)
 language sql stable security definer set search_path=pulse,pg_temp as $$
 with s as (
   select coalesce(current_setting('pulse.actor_account', true), '') actor, nullif(current_setting('pulse.v1_token_id', true), '') token,
     exists(select 1 from person p where p.org_id = current_org() and p.id = current_viewer() and p.side = 'agent') agent
 )
 select case when s.agent then 'ai' when s.token is not null then 'api'
     when s.actor <> '' and s.actor !~ '@' and s.actor !~* '^(pulse|agent):' then 'script' end,
   left(case when s.agent then null
     when s.token is not null then (select t.name from pulse_priv.api_token t where t.org_id = current_org() and t.id::text = s.token)
     when s.actor <> '' and s.actor !~ '@' and s.actor !~* '^(pulse|agent):' then btrim(split_part(s.actor, ' · ', 1)) end, 80)
 from s
$$;

create function pulse.doc_event_add(p_org uuid, p_doc uuid, p_folder uuid, p_kind text, p_detail jsonb) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v record; note text := nullif(btrim(left(regexp_replace(coalesce(current_setting('pulse.doc_note', true), ''), '[[:cntrl:]]+', ' ', 'g'), 300)), '');
begin
 select * into v from doc_via();
 insert into doc_event(org_id, doc_id, folder_id, kind, actor, via, via_label, detail)
  values (p_org, p_doc, p_folder, p_kind, current_viewer(), v.via, nullif(v.label, ''),
    case when note is null then p_detail else p_detail || jsonb_build_object('note', note) end);
end $$;

-- ------------------------------------------------------------------------------------------------ triggers
create function pulse.doc_event_on_doc() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if tg_op = 'INSERT' then
  perform doc_event_add(new.org_id, new.id, null, 'created', jsonb_build_object('folder', new.folder_id, 'access', new.access));
  return null;
 end if;
 if new.folder_id is distinct from old.folder_id then
  perform doc_event_add(new.org_id, new.id, null, 'moved', jsonb_build_object('from', old.folder_id, 'to', new.folder_id));
 end if;
 if new.access is distinct from old.access then
  perform doc_event_add(new.org_id, new.id, null, 'access', jsonb_build_object('from', old.access, 'to', new.access));
 end if;
 if new.archived_at is distinct from old.archived_at then
  perform doc_event_add(new.org_id, new.id, null, case when new.archived_at is null then 'restored' else 'archived' end, '{}'::jsonb);
 end if;
 return null;
end $$;
create trigger doc_event_on_doc after insert or update of folder_id, access, archived_at on pulse.doc for each row execute function pulse.doc_event_on_doc();

create function pulse.doc_event_on_share() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if tg_op = 'DELETE' then
  perform doc_event_add(old.org_id, old.doc_id, null, 'unshared', jsonb_build_object('person', old.person_id));
  return null;
 end if;
 if tg_op = 'UPDATE' and new.can_edit is not distinct from old.can_edit and new.can_comment is not distinct from old.can_comment then return null; end if;
 perform doc_event_add(new.org_id, new.doc_id, null, 'shared', jsonb_build_object('person', new.person_id,
   'role', case when new.can_edit then 'edit' when new.can_comment then 'comment' else 'view' end));
 return null;
end $$;
create trigger doc_event_on_share after insert or update or delete on pulse.doc_share for each row execute function pulse.doc_event_on_share();

create function pulse.doc_event_on_folder() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if tg_op = 'INSERT' then
  perform doc_event_add(new.org_id, null, new.id, 'created', jsonb_build_object('parent', new.parent_id, 'access', new.access));
  return null;
 end if;
 if new.parent_id is distinct from old.parent_id then
  perform doc_event_add(new.org_id, null, new.id, 'moved', jsonb_build_object('from', old.parent_id, 'to', new.parent_id));
 end if;
 if new.name is distinct from old.name then
  perform doc_event_add(new.org_id, null, new.id, 'renamed', jsonb_build_object('from', old.name, 'to', new.name));
 end if;
 if new.access is distinct from old.access then
  perform doc_event_add(new.org_id, null, new.id, 'access', jsonb_build_object('from', old.access, 'to', new.access));
 end if;
 if new.archived_at is distinct from old.archived_at then
  perform doc_event_add(new.org_id, null, new.id, case when new.archived_at is null then 'restored' else 'archived' end, '{}'::jsonb);
 end if;
 return null;
end $$;
create trigger doc_event_on_folder after insert or update of parent_id, name, access, archived_at on pulse.doc_folder for each row execute function pulse.doc_event_on_folder();

-- Each saved version says how it was written (a coalesced 10-minute session takes the latest save's way).
create function pulse.doc_version_via() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare v record;
begin
 select * into v from doc_via();
 new.via := v.via; new.via_label := nullif(v.label, '');
 return new;
end $$;
create trigger doc_version_via before insert or update of body_html, title on pulse.doc_version for each row execute function pulse.doc_version_via();

-- ------------------------------------------------------------------------------------------------ reading receipts
-- 1715's rule, plus: an admin who can see the doc sees who read it.
create or replace function pulse.doc_read_visible(p_doc uuid, p_reader uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select doc_member_ok() and (p_reader = current_viewer()
   or exists(select 1 from doc d where d.org_id = current_org() and d.id = p_doc and d.created_by = current_viewer())
   or exists(select 1 from doc_request r where r.org_id = current_org() and r.doc_id = p_doc and r.to_person = p_reader and r.from_person = current_viewer())
   or (viewer_is('admin') and doc_id_can_see(p_doc)))
$$;

-- ------------------------------------------------------------------------------------------------ row security
alter table pulse.doc_event enable row level security;
alter table pulse.doc_event force row level security;
create policy tenant_isolation on pulse.doc_event using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_event_see on pulse.doc_event as restrictive for select to pulse_api
  using (pulse.doc_member_ok() and case when doc_id is not null then pulse.doc_id_can_see(doc_id) else pulse.doc_folder_can_see(folder_id) end);

grant select on pulse.doc_event to pulse_api;
revoke all on function pulse.doc_event_add(uuid, uuid, uuid, text, jsonb), pulse.doc_via() from public;
grant execute on function pulse.doc_via() to pulse_api;

-- ------------------------------------------------------------------------------------------------ backfill
-- The ledger's own record of what the server's tools made (each row lists the items it wrote: {"id", "kind"}). Only the
-- 'created' fact is added, at the doc's (folder's) own creation time and by its maker, so nothing else changes.
do $$
declare o record;
begin
 for o in select distinct a.target_org id from pulse_priv.platform_audit a where a.action = 'admin.import' and a.target_org is not null loop
  perform set_config('pulse.org_id', o.id::text, true);
  insert into pulse.doc_event(org_id, doc_id, folder_id, kind, actor, at, via, via_label, detail)
  select d.org_id, d.id, null, 'created', d.created_by, d.created_at, 'script', left(btrim(split_part(min(a.actor), ' · ', 1)), 80), jsonb_build_object('folder', d.folder_id, 'access', d.access, 'backfill', true)
    from pulse.doc d join pulse_priv.platform_audit a on a.target_org = d.org_id and a.action = 'admin.import' and a.detail::text like '%' || d.id::text || '%'
   where d.org_id = o.id and not exists (select 1 from pulse.doc_event e where e.doc_id = d.id and e.kind = 'created')
   group by d.org_id, d.id;
  insert into pulse.doc_event(org_id, doc_id, folder_id, kind, actor, at, via, via_label, detail)
  select f.org_id, null, f.id, 'created', f.created_by, f.created_at, 'script', left(btrim(split_part(min(a.actor), ' · ', 1)), 80), jsonb_build_object('parent', f.parent_id, 'access', f.access, 'backfill', true)
    from pulse.doc_folder f join pulse_priv.platform_audit a on a.target_org = f.org_id and a.action = 'admin.import' and a.detail::text like '%' || f.id::text || '%'
   where f.org_id = o.id and not exists (select 1 from pulse.doc_event e where e.folder_id = f.id and e.kind = 'created')
   group by f.org_id, f.id;
 end loop;
 -- A docs tidy-up made before this migration (ledger action admin.docs_tidy: detail.created = the folders it made,
 -- detail.moves = [{kind, id, from, to}], detail.note = its reason). One made after it was recorded by the triggers
 -- above as it happened (detail.live = true) and is left alone.
 for o in select a.* from pulse_priv.platform_audit a where a.action = 'admin.docs_tidy' and a.target_org is not null and coalesce(a.detail ->> 'live', '') <> 'true' order by a.at loop
  perform set_config('pulse.org_id', o.target_org::text, true);
  insert into pulse.doc_event(org_id, doc_id, folder_id, kind, actor, at, via, via_label, detail)
  select f.org_id, null, f.id, 'created', f.created_by, f.created_at, 'script', 'docs tidy-up', jsonb_build_object('parent', f.parent_id, 'access', f.access, 'note', left(o.detail ->> 'note', 300), 'backfill', true)
    from jsonb_array_elements(coalesce(o.detail -> 'created', '[]'::jsonb)) x join pulse.doc_folder f on f.org_id = o.target_org and f.id::text = x ->> 'id'
   where not exists (select 1 from pulse.doc_event e where e.folder_id = f.id and e.kind = 'created');
  insert into pulse.doc_event(org_id, doc_id, folder_id, kind, actor, at, via, via_label, detail)
  select o.target_org, case when m ->> 'kind' = 'doc' then (m ->> 'id')::uuid end, case when m ->> 'kind' = 'folder' then (m ->> 'id')::uuid end, 'moved', o.actor_person, o.at, 'script', 'docs tidy-up',
      jsonb_strip_nulls(jsonb_build_object('from', m -> 'from', 'to', m -> 'to', 'note', left(o.detail ->> 'note', 300), 'backfill', true))
    from jsonb_array_elements(coalesce(o.detail -> 'moves', '[]'::jsonb)) m
   where m ->> 'kind' in ('doc', 'folder')
     and ((m ->> 'kind' = 'doc' and exists (select 1 from pulse.doc d where d.org_id = o.target_org and d.id::text = m ->> 'id'))
       or (m ->> 'kind' = 'folder' and exists (select 1 from pulse.doc_folder f where f.org_id = o.target_org and f.id::text = m ->> 'id')));
 end loop;
 perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
-- Forward-only: the trail is part of each doc's history.
