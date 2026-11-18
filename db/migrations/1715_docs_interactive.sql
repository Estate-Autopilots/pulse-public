-- migrate:up
-- DOCS-INTERACTIVE (owner, 7 Nov 2026): one document format for everything (HR policies and letters, briefs, plans,
-- proposals), with interactive blocks inside, docs pushed into a person's space ("read this and approve it"), real reading
-- receipts, and docs linked both ways with tasks, projects and goals ("one consolidated knowledge base"). Builds on the
-- docs of 1686. docs/spec/DOCS.md ("Interactive docs") has the design. Under forced row security:
--   doc_link          a doc linked to a task, project or goal: role 'brief' (listed first on the task) or 'related'
--   doc_request       a doc sent to a person: read, approve or review, with a note and a due date; the person answers
--   doc_block_answer  one person's answer to one interactive block of a doc (an approval, a form, a checklist, row actions)
--   doc_read          one reading session of one person on one doc: active time, depth, each section's time and views.
--                     Written only by the reader about themselves; read only by the reader, the doc's owner, and whoever
--                     sent that reader that doc. Leadership and admins do not see other people's reading.
--   telemetry_setting.doc_reads   the company's switch for reading receipts (on by default; off stores nothing).

-- ------------------------------------------------------------------------------------------------ links
create table pulse.doc_link (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references pulse.doc(id),
  kind text not null check (kind in ('task', 'project', 'goal')),
  ref_id uuid not null,
  role text not null default 'related' check (role in ('brief', 'related')),
  added_by uuid not null references pulse.person(id),
  added_at timestamptz not null default now(),
  unique (doc_id, kind, ref_id)
);
create index doc_link_ref on pulse.doc_link(org_id, kind, ref_id);

-- ------------------------------------------------------------------------------------------------ requests
create table pulse.doc_request (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references pulse.doc(id),
  from_person uuid not null references pulse.person(id),
  to_person uuid not null references pulse.person(id),
  ask text not null check (ask in ('read', 'approve', 'review')),
  note text check (length(note) <= 2000),
  due_at timestamptz,
  status text not null default 'waiting' check (status in ('waiting', 'read', 'approved', 'declined', 'changes', 'cancelled')),
  answer_note text check (length(answer_note) <= 2000),
  answered_at timestamptz,
  opened_at timestamptz,
  created_at timestamptz not null default now(),
  check (from_person <> to_person)
);
create index doc_request_to on pulse.doc_request(org_id, to_person, status, created_at desc);
create index doc_request_from on pulse.doc_request(org_id, from_person, created_at desc);
create index doc_request_doc on pulse.doc_request(org_id, doc_id);

-- ------------------------------------------------------------------------------------------------ block answers
create table pulse.doc_block_answer (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references pulse.doc(id),
  block_id text not null check (block_id ~ '^b_[A-Za-z0-9]{4,24}$'),
  kind text not null check (kind in ('approval', 'checklist', 'form', 'actions')),
  person_id uuid not null references pulse.person(id),
  value jsonb not null check (jsonb_typeof(value) = 'object' and length(value::text) <= 8000),
  effect jsonb check (effect is null or jsonb_typeof(effect) = 'object'),
  answered_at timestamptz not null default now(),
  unique (doc_id, block_id, person_id)
);
create index doc_block_answer_doc on pulse.doc_block_answer(org_id, doc_id);

-- ------------------------------------------------------------------------------------------------ reading
create table pulse.doc_read (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  doc_id uuid not null references pulse.doc(id),
  person_id uuid not null references pulse.person(id),
  session_id text not null check (session_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  version integer not null default 0,
  started_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  active_ms integer not null default 0 check (active_ms between 0 and 86400000),
  depth real not null default 0 check (depth between 0 and 1),
  sections jsonb not null default '{}' check (jsonb_typeof(sections) = 'object' and length(sections::text) <= 20000),
  unique (doc_id, person_id, session_id)
);
create index doc_read_doc on pulse.doc_read(org_id, doc_id, person_id, last_at desc);

alter table pulse.telemetry_setting add column doc_reads boolean not null default true;

-- ------------------------------------------------------------------------------------------------ who may
-- Reading receipts are on for this company (no settings row = the default, on).
create function pulse.doc_reads_on() returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select s.doc_reads from telemetry_setting s where s.org_id = current_org()), true)
$$;

-- Whose reading of a doc the viewer may see: their own; the doc's owner sees everyone's; a sender sees the reading of the
-- people they sent it to.
create function pulse.doc_read_visible(p_doc uuid, p_reader uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select doc_member_ok() and (p_reader = current_viewer()
   or exists(select 1 from doc d where d.org_id = current_org() and d.id = p_doc and d.created_by = current_viewer())
   or exists(select 1 from doc_request r where r.org_id = current_org() and r.doc_id = p_doc and r.to_person = p_reader and r.from_person = current_viewer()))
$$;

-- A request is seen by its sender, its recipient and the doc's owner.
create function pulse.doc_request_visible(p_doc uuid, p_from uuid, p_to uuid) returns boolean
 language sql stable security definer set search_path=pulse,pg_temp as $$
 select doc_member_ok() and (current_viewer() in (p_from, p_to)
   or exists(select 1 from doc d where d.org_id = current_org() and d.id = p_doc and d.created_by = current_viewer()))
$$;

-- Send a doc to a person: the sender must be able to share the doc or edit it (an AI employee writing a doc owns it). The
-- recipient gets the doc shared with them (reads; edits for a review), and one notification that opens the doc.
create function pulse.doc_request_send(p_doc uuid, p_to uuid, p_ask text, p_note text, p_due timestamptz) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); d doc%rowtype; rid uuid; who text; verb text;
begin
  if not doc_member_ok() then raise exception 'Docs are for the company''s staff and AI employees' using errcode = '42501'; end if;
  select * into d from doc where org_id = current_org() and id = p_doc and archived_at is null;
  if d.id is null or not doc_can_see(d.id, d.access, d.created_by) then raise exception 'Doc not found' using errcode = 'P0002'; end if;
  -- The owner (or an admin) sends any doc; an editor sends a company doc, or one already shared with that person.
  if not (doc_id_can_share(d.id) or (doc_can_edit(d.id, d.access, d.created_by, d.company_edits)
      and (d.access = 'company' or p_to = d.created_by or exists(select 1 from doc_share s where s.org_id = current_org() and s.doc_id = d.id and s.person_id = p_to)))) then
    raise exception 'Only the doc''s owner sends it to someone it is not shared with' using errcode = '42501'; end if;
  if p_ask not in ('read', 'approve', 'review') then raise exception 'Ask them to read, approve or review it' using errcode = '22023'; end if;
  if p_to = me then raise exception 'Send it to someone else' using errcode = '22023'; end if;
  if not exists(select 1 from person p where p.org_id = current_org() and p.id = p_to and p.side in ('staff', 'agent') and p.status = 'active') then
    raise exception 'Choose a person or AI employee of this company' using errcode = '22023'; end if;
  -- The recipient can open it: shared with them unless the whole company already sees it.
  if d.access <> 'company' and p_to <> d.created_by then
    if d.access = 'private' then update doc set access = 'people' where id = d.id; end if;
    insert into doc_share(org_id, doc_id, person_id, can_edit, added_by) values (current_org(), d.id, p_to, p_ask = 'review', me)
      on conflict (doc_id, person_id) do update set can_edit = doc_share.can_edit or excluded.can_edit;
  end if;
  -- A new ask replaces an unanswered one for the same person and doc.
  update doc_request set status = 'cancelled' where org_id = current_org() and doc_id = d.id and to_person = p_to and status = 'waiting';
  insert into doc_request(org_id, doc_id, from_person, to_person, ask, note, due_at)
    values (current_org(), d.id, me, p_to, p_ask, nullif(left(btrim(coalesce(p_note, '')), 2000), ''), p_due) returning id into rid;
  select display_name into who from person where org_id = current_org() and id = me;
  verb := case p_ask when 'approve' then 'approve' when 'review' then 'review' else 'read' end;
  perform notification_emit(p_to, 'update.self', 'person', p_to, 'doc-request:' || rid::text,
    left(coalesce(who, 'Someone') || ' asks you to ' || verb || ': ' || d.title, 200), '/docs/' || d.id::text || '?request=' || rid::text, 'update');
  return rid;
end $$;

-- The recipient answers: read, approved, declined or changes asked. The sender hears it.
create function pulse.doc_request_answer(p_request uuid, p_status text, p_note text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); r doc_request%rowtype; who text; t text; words text;
begin
  select * into r from doc_request where org_id = current_org() and id = p_request;
  if r.id is null or r.to_person is distinct from me or not doc_member_ok() then raise exception 'That request is not yours to answer' using errcode = '42501'; end if;
  if p_status not in ('read', 'approved', 'declined', 'changes') then raise exception 'Answer read, approved, declined or changes' using errcode = '22023'; end if;
  if r.status = 'cancelled' then raise exception 'The sender took this request back' using errcode = '22023'; end if;
  update doc_request set status = p_status, answer_note = nullif(left(btrim(coalesce(p_note, '')), 2000), ''), answered_at = now(),
    opened_at = coalesce(opened_at, now()) where id = r.id;
  select display_name into who from person where org_id = current_org() and id = me;
  select title into t from doc where org_id = current_org() and id = r.doc_id;
  words := case p_status when 'approved' then ' approved ' when 'declined' then ' declined ' when 'changes' then ' asked for changes on ' else ' read ' end;
  perform notification_emit(r.from_person, 'update.self', 'person', r.from_person, 'doc-answer:' || r.id::text || ':' || p_status,
    left(coalesce(who, 'Someone') || words || coalesce(t, 'your doc'), 200), '/docs/' || r.doc_id::text || '?reads=1', 'update');
end $$;

-- The recipient opened it (the first time is kept).
create function pulse.doc_request_opened(p_doc uuid) returns void
 language sql security definer set search_path=pulse,pg_temp as $$
 update doc_request set opened_at = now() where org_id = current_org() and doc_id = p_doc and to_person = current_viewer() and opened_at is null and status <> 'cancelled'
$$;

-- ------------------------------------------------------------------------------------------------ row security
alter table pulse.doc_link enable row level security;
alter table pulse.doc_link force row level security;
create policy tenant_isolation on pulse.doc_link using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_link_see on pulse.doc_link as restrictive for select to pulse_api using (pulse.doc_id_can_see(doc_id));
-- The doc's editors link it; a reader who approves an approval block links the task that approval made.
create policy doc_link_insert on pulse.doc_link as restrictive for insert to pulse_api with check (added_by = pulse.current_viewer() and (pulse.doc_id_can_edit(doc_id)
  or (role = 'related' and kind = 'task' and pulse.doc_id_can_see(doc_id) and exists(select 1 from pulse.task t where t.id = ref_id and t.created_by = pulse.current_viewer()))));
create policy doc_link_update on pulse.doc_link as restrictive for update to pulse_api using (pulse.doc_id_can_edit(doc_id)) with check (pulse.doc_id_can_edit(doc_id));
create policy doc_link_delete on pulse.doc_link as restrictive for delete to pulse_api using (pulse.doc_id_can_edit(doc_id));

alter table pulse.doc_request enable row level security;
alter table pulse.doc_request force row level security;
create policy tenant_isolation on pulse.doc_request using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_request_see on pulse.doc_request as restrictive for select to pulse_api using (pulse.doc_request_visible(doc_id, from_person, to_person));
-- Only the sender takes a request back (status cancelled); sending and answering go through the functions above.
create policy doc_request_update on pulse.doc_request as restrictive for update to pulse_api
  using (from_person = pulse.current_viewer() and status = 'waiting') with check (from_person = pulse.current_viewer() and status = 'cancelled');

alter table pulse.doc_block_answer enable row level security;
alter table pulse.doc_block_answer force row level security;
create policy tenant_isolation on pulse.doc_block_answer using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_block_answer_see on pulse.doc_block_answer as restrictive for select to pulse_api using (pulse.doc_id_can_see(doc_id));
create policy doc_block_answer_insert on pulse.doc_block_answer as restrictive for insert to pulse_api
  with check (person_id = pulse.current_viewer() and pulse.doc_id_can_see(doc_id));
create policy doc_block_answer_update on pulse.doc_block_answer as restrictive for update to pulse_api
  using (person_id = pulse.current_viewer()) with check (person_id = pulse.current_viewer() and pulse.doc_id_can_see(doc_id));

alter table pulse.doc_read enable row level security;
alter table pulse.doc_read force row level security;
create policy tenant_isolation on pulse.doc_read using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy doc_read_see on pulse.doc_read as restrictive for select to pulse_api using (pulse.doc_read_visible(doc_id, person_id));
create policy doc_read_insert on pulse.doc_read as restrictive for insert to pulse_api
  with check (person_id = pulse.current_viewer() and pulse.doc_id_can_see(doc_id) and pulse.doc_reads_on());
create policy doc_read_update on pulse.doc_read as restrictive for update to pulse_api
  using (person_id = pulse.current_viewer()) with check (person_id = pulse.current_viewer() and pulse.doc_reads_on());

grant select, insert, update (role), delete on pulse.doc_link to pulse_api;
grant select, update (status) on pulse.doc_request to pulse_api;
grant select, insert, update (value, effect, answered_at) on pulse.doc_block_answer to pulse_api;
grant select, insert, update (version, last_at, active_ms, depth, sections) on pulse.doc_read to pulse_api;
grant update (doc_reads) on pulse.telemetry_setting to pulse_api;
revoke all on function pulse.doc_reads_on(), pulse.doc_read_visible(uuid, uuid), pulse.doc_request_visible(uuid, uuid, uuid),
  pulse.doc_request_send(uuid, uuid, text, text, timestamptz), pulse.doc_request_answer(uuid, text, text), pulse.doc_request_opened(uuid) from public;
grant execute on function pulse.doc_reads_on(), pulse.doc_read_visible(uuid, uuid), pulse.doc_request_visible(uuid, uuid, uuid),
  pulse.doc_request_send(uuid, uuid, text, text, timestamptz), pulse.doc_request_answer(uuid, text, text), pulse.doc_request_opened(uuid) to pulse_api;

-- migrate:down
-- Forward-only.
