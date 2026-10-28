-- migrate:up
-- R46 (12 Oct 2026): a relationship graph of reviewed edges between RE projects, engagement records, developers,
-- channel partners, clients, employees and contacts. Imported links are proposals, never truth: only a reviewer an
-- admin has named for that kind of relationship confirms, rejects or corrects one (owner errand E14 names them).
--  * relation_edge: every version of every relationship, append-only. A thread is one relationship (an engagement's
--    client, its development, its assigned PM; a client's contact; a model in an engagement). Each version says who or
--    what the other side is (a written name with no record stays unresolved and can never be confirmed), its role and
--    dates, where it came from and how sure that source is, and its status: proposed, confirmed, rejected or withdrawn.
--    A correction waiting for review keeps the confirmed version it would replace standing (`standing`), so a source
--    change or a colleague's suggestion never demotes a confirmed relationship. Undo marks the newest version undone and
--    the one before it is current again; nothing is deleted or merged.
--  * relation_reviewer: who may decide which kinds; granted and revoked by admins, never implied by a role.
--  * relation_node_type: node types that need the owner's definition before they appear. "Models" is the only one:
--    until an admin records the owner's definition, model links stay hidden from the normal views and unconfirmable.
--  * relation_run: when the sources were last read for proposals and what changed.
-- Sources read for proposals (pulse.relation_facts): engagement records sharing a project key (the same real project
-- sold again: an import heuristic, so a proposal), the project's client (typed developer / channel partner / client),
-- the assigned PM named in Review data's pod and PGS suggestions, a client's relationship owner, client contacts, and
-- R55's model shoots linked to a project. No name is ever matched to a record here: no fuzzy merge.
-- Reviewers get one task each on the canonical task engine, kept up to date with counts only; its notification is the
-- outbox's task.assigned with a fixed title, so no client, contact or detail of one ever enters a push.

create table pulse.relation_node_type (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 node_type text not null check (node_type in ('model')),
 definition text not null check (length(btrim(definition)) between 10 and 1000),
 source_ref text not null check (length(btrim(source_ref)) between 3 and 300),
 configured_by uuid not null references pulse.person(id), configured_at timestamptz not null default now(),
 withdrawn_by uuid references pulse.person(id), withdrawn_at timestamptz
);
create unique index relation_node_type_active on pulse.relation_node_type(org_id, node_type) where withdrawn_at is null;

create table pulse.relation_reviewer (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 person_id uuid not null references pulse.person(id),
 kinds text[] not null check (cardinality(kinds) between 1 and 6
   and kinds <@ array['development','client','team','account_owner','contact','model']),
 note text check (length(note) <= 300),
 granted_by uuid not null references pulse.person(id), granted_at timestamptz not null default now(),
 revoked_by uuid references pulse.person(id), revoked_at timestamptz
);
create unique index relation_reviewer_active on pulse.relation_reviewer(org_id, person_id) where revoked_at is null;

create table pulse.relation_edge (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 thread uuid not null,
 edge_key text not null check (length(edge_key) between 5 and 300),
 version int not null check (version >= 1),
 supersedes uuid references pulse.relation_edge(id),
 kind text not null check (kind in ('development','client','team','account_owner','contact','model')),
 subject_type text not null check (subject_type in ('engagement','client')),
 subject_id uuid not null,
 object_type text not null check (object_type in ('development','client','employee','contact','model')),
 object_id uuid, object_key text check (length(object_key) <= 300),
 object_label text not null check (length(object_label) between 1 and 300),
 role text check (length(role) <= 80),
 status text not null check (status in ('proposed','confirmed','rejected','withdrawn')),
 standing uuid references pulse.relation_edge(id),
 valid_from date, valid_to date,
 source_family text not null check (source_family in ('project','review_item','client','client_contact','talent_shoot','person')),
 source_ref text check (length(source_ref) <= 200),
 source_seen jsonb not null default '{}' check (jsonb_typeof(source_seen) = 'object'),
 observed_at timestamptz,
 confidence numeric check (confidence between 0 and 1),
 evidence jsonb not null default '[]' check (jsonb_typeof(evidence) = 'array'),
 actor uuid references pulse.person(id),
 action text not null check (action in ('source','source_changed','source_gone','suggest','confirm','reject','correct')),
 note text check (length(note) <= 500),
 created_at timestamptz not null default clock_timestamp(),
 undone_at timestamptz, undone_by uuid references pulse.person(id),
 check ((version = 1) = (supersedes is null)),
 check (status <> 'confirmed' or (actor is not null and (object_id is not null or object_key is not null))),
 check (valid_to is null or valid_from is null or valid_to >= valid_from),
 check ((actor is null) = (action in ('source','source_changed','source_gone')))
);
create unique index relation_edge_root on pulse.relation_edge(org_id, edge_key) where supersedes is null;
create unique index relation_edge_next on pulse.relation_edge(org_id, supersedes) where undone_at is null and supersedes is not null;
create unique index relation_edge_version on pulse.relation_edge(org_id, thread, version);
create index relation_edge_subject on pulse.relation_edge(org_id, subject_type, subject_id);
create index relation_edge_object on pulse.relation_edge(org_id, object_id) where object_id is not null;

create table pulse.relation_run (
 org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
 by uuid references pulse.person(id), at timestamptz not null default now(), counts jsonb not null
);

do $$ declare t text; begin
 foreach t in array array['relation_node_type','relation_reviewer','relation_edge','relation_run'] loop
  execute format('alter table pulse.%I enable row level security', t);
  execute format('alter table pulse.%I force row level security', t);
  execute format('create policy tenant on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  execute format('grant select on pulse.%I to pulse_api, pulse_worker', t);
  execute format('create policy signed_in on pulse.%I as restrictive for select to pulse_api using (pulse.current_viewer() is not null)', t);
 end loop;
end $$;
-- Who reviews what is the admins' list; a reviewer sees their own grant.
create policy own_or_admin on pulse.relation_reviewer as restrictive for select to pulse_api
 using (person_id = pulse.current_viewer() or pulse.viewer_is('admin'));
create trigger audit_mutation after insert or update on pulse.relation_reviewer for each row execute function pulse.audit_mutation();
create trigger audit_mutation after insert or update on pulse.relation_node_type for each row execute function pulse.audit_mutation();

-- The current version of every relationship: its newest version not undone (only the newest is ever undone, so the
-- versions not undone form one chain). Security invoker: the caller's row security applies.
create view pulse.relation_head with (security_invoker = true) as
 select distinct on (e.org_id, e.thread) e.* from pulse.relation_edge e
 where e.undone_at is null order by e.org_id, e.thread, e.version desc;
grant select on pulse.relation_head to pulse_api, pulse_worker;

-- Both ends belong to this company and exist; versions never change once written, except that an undo is recorded.
create function pulse.relation_edge_guard() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if TG_OP = 'UPDATE' then
  if old.undone_at is not null or new.undone_at is null
     or (to_jsonb(new) - array['undone_at','undone_by']) <> (to_jsonb(old) - array['undone_at','undone_by']) then
   raise exception 'A relationship version is never changed: add a new one' using errcode = '22023';
  end if;
  return new;
 end if;
 if new.org_id is distinct from current_org() then raise exception 'This relationship belongs to another company' using errcode = '42501'; end if;
 if new.subject_type = 'engagement' and not exists (select 1 from project where org_id = new.org_id and id = new.subject_id and kind = 'client_work')
    or new.subject_type = 'client' and not exists (select 1 from client where org_id = new.org_id and id = new.subject_id) then
  raise exception 'The record this relationship starts from is not in this company' using errcode = '22023';
 end if;
 if new.object_id is not null and not (case new.object_type
    when 'client' then exists (select 1 from client where org_id = new.org_id and id = new.object_id)
    when 'employee' then exists (select 1 from person where org_id = new.org_id and id = new.object_id and side = 'staff')
    when 'contact' then exists (select 1 from person where org_id = new.org_id and id = new.object_id and side <> 'staff')
    when 'model' then exists (select 1 from contact_profile where org_id = new.org_id and person_id = new.object_id and contact_type = 'talent')
    else false end) then
  raise exception 'The other side of this relationship is not a matching record in this company' using errcode = '22023';
 end if;
 if new.object_type = 'development' and (new.object_id is not null or new.object_key is not null
    and not exists (select 1 from project where org_id = new.org_id and project_key = new.object_key)) then
  raise exception 'Choose an RE project key this company has' using errcode = '22023';
 end if;
 return new;
end $$;
create trigger relation_edge_guard before insert or update on pulse.relation_edge for each row execute function pulse.relation_edge_guard();

create function pulse.relation_model_on() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
 select exists (select 1 from relation_node_type where org_id = current_org() and node_type = 'model' and withdrawn_at is null)
$$;

-- What the sources say now, one row per relationship slot (or pair, for many-valued kinds). No name matching.
create function pulse.relation_facts(p_key text default null) returns table (
 edge_key text, kind text, subject_type text, subject_id uuid, object_type text, object_id uuid, object_key text, object_label text,
 role text, valid_from date, valid_to date, source_family text, source_ref text, source_seen jsonb, observed_at timestamptz,
 confidence numeric, evidence jsonb)
 language sql stable security definer set search_path = pulse, pg_temp as $$
 with eng as (select * from project where org_id = current_org() and kind = 'client_work' and status <> 'cancelled'),
 rep as (select project_key, count(*) n, mode() within group (order by coalesce(nullif(btrim(title), ''), name)) label
         from eng where project_key is not null group by 1 having count(*) > 1),
 f as (
  -- The same real project sold again: engagement records sharing a project key. The key is an import heuristic.
  select 'development|engagement:' || e.id edge_key, 'development' kind, 'engagement' subject_type, e.id subject_id, 'development' object_type,
   null::uuid object_id, e.project_key object_key,
   left(r.label || coalesce(' · ' || initcap(nullif(split_part(e.project_key, '@', 2), '')), ''), 300) object_label, null::text role,
   e.start_month valid_from, null::date valid_to, 'project' source_family, 'project.project_key' source_ref,
   jsonb_build_object('projectKey', e.project_key) source_seen, e.updated_at observed_at, null::numeric confidence,
   jsonb_build_array(jsonb_build_object('basis', 'The same project key as ' || (r.n - 1) || case when r.n = 2 then ' other engagement record' else ' other engagement records' end)) evidence
  from eng e join rep r using (project_key)
  union all
  select 'client|engagement:' || e.id, 'client', 'engagement', e.id, 'client', c.id, null, c.display_name,
   case c.client_type when 'developer' then 'developer' when 'channel_partner' then 'channel_partner' else 'client' end,
   e.start_month, null, 'project', 'project.client_id', jsonb_build_object('clientId', c.id), e.updated_at, null,
   jsonb_build_array(jsonb_build_object('basis', case when 'client_id' = any(e.locked) then 'Set by hand on the project in Pulse' else 'The project''s source records' end))
  from eng e join client c on c.org_id = e.org_id and c.id = e.client_id
  union all
  -- The assigned PM the project sources name; a written name with no person record stays unresolved.
  select 'team|engagement:' || e.id || '|pm', 'team', 'engagement', e.id, 'employee', s.id, null,
   left(coalesce(s.display_name, nullif(btrim(i.proposed->>'pgsCandidate'), ''), 'Unknown'), 300), 'Assigned PM',
   null, null, 'review_item', i.id::text, jsonb_build_object('personId', s.id, 'name', i.proposed->>'pgsCandidate'), null, i.confidence,
   jsonb_build_array(jsonb_build_object('basis', coalesce(nullif(i.proposed->>'pgsBasis', ''), 'Named in the project sources')))
  from review_item i join eng e on e.id = i.entity_id
   left join person s on s.org_id = i.org_id and s.side = 'staff'
    and s.id = case when i.proposed->>'pgsId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (i.proposed->>'pgsId')::uuid end
  where i.org_id = current_org() and i.kind = 'project_pod' and i.status <> 'dismissed' and i.entity_type = 'project'
    and coalesce(nullif(i.proposed->>'pgsId', ''), nullif(btrim(i.proposed->>'pgsCandidate'), '')) is not null
  union all
  select 'account_owner|client:' || c.id, 'account_owner', 'client', c.id, 'employee', s.id, null, s.display_name, 'Relationship owner',
   null, null, 'client', 'client.relationship_owner_id', jsonb_build_object('personId', s.id), null, null,
   jsonb_build_array(jsonb_build_object('basis', 'Relationship owner on the client record'))
  from client c join person s on s.org_id = c.org_id and s.id = c.relationship_owner_id and s.side = 'staff'
  where c.org_id = current_org()
  union all
  select 'contact|client:' || cc.client_id || '|person:' || p.id, 'contact', 'client', cc.client_id,
   case when cp.contact_type = 'talent' then 'model' else 'contact' end, p.id, null, p.display_name,
   case when cc.is_primary then 'Primary contact' else 'Contact' end,
   null, null, 'client_contact', 'client_contact', jsonb_build_object('personId', p.id, 'primary', cc.is_primary), null, null,
   jsonb_build_array(jsonb_build_object('basis', 'Listed as a contact of the client' || coalesce(' · from ' || nullif(cp.source, 'manual'), '')))
  from client_contact cc join person p on p.org_id = cc.org_id and p.id = cc.person_id and p.side <> 'staff'
   left join contact_profile cp on cp.person_id = p.id
  where cc.org_id = current_org()
  union all
  select 'model|engagement:' || s.project_id || '|person:' || s.person_id, 'model', 'engagement', s.project_id, 'model', s.person_id, null,
   max(p.display_name), 'Model in shoots', min(s.shoot_on), max(s.shoot_on), 'talent_shoot', 'talent_shoot',
   jsonb_build_object('personId', s.person_id), null, max(s.project_confidence),
   jsonb_build_array(jsonb_build_object('basis', count(*) || case when count(*) = 1 then ' shoot' else ' shoots' end || ' linked by '
     || string_agg(distinct replace(coalesce(s.project_basis, 'none'), '_', ' '), ', ')))
  from talent_shoot s join eng e on e.id = s.project_id
   join contact_profile cp on cp.org_id = s.org_id and cp.person_id = s.person_id and cp.contact_type = 'talent'
   join person p on p.id = s.person_id
  where s.org_id = current_org() and s.person_id is not null
  group by s.project_id, s.person_id
 )
 select distinct on (f.edge_key) * from f where p_key is null or f.edge_key = p_key order by f.edge_key, f.source_ref
$$;

create function pulse.relation_head_of(p_thread uuid) returns pulse.relation_edge language sql stable security definer set search_path = pulse, pg_temp as $$
 select e.* from relation_edge e where e.org_id = current_org() and e.thread = p_thread and e.undone_at is null order by e.version desc limit 1
$$;

create function pulse.relation_thread(p_key text) returns uuid language sql stable security definer set search_path = pulse, pg_temp as $$
 select thread from relation_edge where org_id = current_org() and edge_key = p_key and supersedes is null
$$;

-- Same other side: the same record, the same RE project key, or (both unresolved) the same written name.
create function pulse.relation_same(a_id uuid, a_key text, a_label text, b_id uuid, b_key text, b_label text) returns boolean
 language sql immutable as $$
 select a_id is not distinct from b_id and a_key is not distinct from b_key
   and (a_id is not null or a_key is not null or lower(btrim(a_label)) = lower(btrim(b_label)))
$$;

-- Write the next version of a thread (or its first, when p_prev is null). Two decisions on the same version: the
-- second is refused, so reviewers who disagree see each other's decision instead of overwriting it.
create function pulse.relation_add(p_prev uuid, r pulse.relation_edge) returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare nid uuid := gen_random_uuid(); prev relation_edge; v int := 1;
begin
 if p_prev is not null then
  select * into prev from relation_edge where org_id = current_org() and id = p_prev;
  select max(version) + 1 into v from relation_edge where org_id = current_org() and thread = prev.thread;
 end if;
 insert into relation_edge(org_id, id, thread, edge_key, version, supersedes, kind, subject_type, subject_id, object_type, object_id, object_key,
   object_label, role, status, standing, valid_from, valid_to, source_family, source_ref, source_seen, observed_at, confidence, evidence, actor, action, note)
 values (current_org(), nid, coalesce(prev.thread, nid), coalesce(prev.edge_key, r.edge_key), v, p_prev,
   coalesce(prev.kind, r.kind), coalesce(prev.subject_type, r.subject_type), coalesce(prev.subject_id, r.subject_id),
   r.object_type, r.object_id, r.object_key, r.object_label, r.role, r.status, r.standing, r.valid_from, r.valid_to,
   r.source_family, r.source_ref, coalesce(r.source_seen, '{}'), r.observed_at, r.confidence, coalesce(r.evidence, '[]'), r.actor, r.action, r.note);
 return nid;
exception when unique_violation then
 raise exception 'Someone else decided this relationship first: reload to see the latest version' using errcode = '40001';
end $$;

create function pulse.relation_my_kinds() returns text[] language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce((select r.kinds from relation_reviewer r join person p on p.org_id = r.org_id and p.id = r.person_id
   where r.org_id = current_org() and r.person_id = current_viewer() and r.revoked_at is null and p.side = 'staff' and p.status = 'active'), '{}')
$$;

create function pulse.relation_worker() returns boolean language sql stable as $$
 select current_setting('role', true) = 'pulse_worker' or (current_setting('role', true) = 'none'
   and pg_has_role(session_user, 'pulse_worker', 'member') and not pg_has_role(session_user, 'pulse_api', 'member'))
$$;

-- One task per named reviewer while relationships wait for them, kept current with counts only. Its notification is
-- task.assigned with a fixed title and no record names, so nothing private reaches a push or a lock screen.
create function pulse.relation_route() returns int language plpgsql security definer set search_path = pulse, pg_temp as $$
declare rv record; t task; tid uuid; n int; parts text; v_title text; v_notes text; made int := 0; model_on boolean := relation_model_on();
begin
 for rv in select r.person_id, r.kinds, r.granted_by from relation_reviewer r
   join person p on p.org_id = r.org_id and p.id = r.person_id and p.side = 'staff' and p.status = 'active'
   where r.org_id = current_org() and r.revoked_at is null loop
  select coalesce(sum(c), 0), string_agg(c || ' ' || case k
     when 'development' then 'same-project links' when 'client' then 'project clients' when 'team' then 'project PMs'
     when 'account_owner' then 'relationship owners' when 'contact' then 'client contacts' else 'model links' end, ', ' order by k)
   into n, parts
   from (select h.kind k, count(*)::int c from relation_head h
         where h.org_id = current_org() and h.status = 'proposed' and h.kind = any(rv.kinds)
           and (model_on or (h.kind <> 'model' and h.object_type <> 'model')) group by 1) x;
  select * into t from task where org_id = current_org() and source = 'relation_review' and source_ref = rv.person_id::text
   and status in ('open','in_progress','blocked') and deleted_at is null order by created_at desc limit 1;
  if n = 0 then
   if t.id is not null then
    update task set status = 'done', done_at = now(), updated_at = now(), notes = 'Nothing waits for your confirmation now.' where id = t.id;
   end if;
   continue;
  end if;
  v_title := 'Confirm ' || n || case when n = 1 then ' relationship' else ' relationships' end;
  v_notes := 'Waiting for you: ' || parts || '. Open Relationships, To confirm: /relationships?view=review. '
   || 'Nothing there counts as true until a named reviewer confirms it, and a written name with no record stays unresolved.';
  if t.id is null then
   insert into task(org_id, title, status, source, source_ref, created_by, created_at, edited_by, updated_at, owner_id, assignee_person_id, assigned_at, notes, priority, locked)
   values (current_org(), v_title, 'open', 'relation_review', rv.person_id::text, rv.granted_by, now(), rv.granted_by, now(), rv.person_id, rv.person_id, now(), v_notes, 'normal', '{}')
   returning id into tid;
   -- The same notification a task assignment always sends (the task's own trigger sends it when a person acted).
   perform notification_emit(rv.person_id, 'task.assigned', 'task', tid, tid || ':' || (select notification_revision from task where id = tid),
     'A task was assigned to you', '/tasks/' || tid, 'task');
   made := made + 1;
  elsif t.title is distinct from v_title or t.notes is distinct from v_notes then
   update task set title = v_title, notes = v_notes, updated_at = now() where id = t.id;
  end if;
 end loop;
 return made;
end $$;

-- Read the sources again: new relationships become proposals; a pending source proposal follows its source; a
-- source that now disagrees with a confirmed relationship proposes a correction while the confirmed one stands.
create function pulse.relation_refresh() returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare f record; h relation_edge; c relation_edge; r relation_edge; keys text[] := '{}'; added int := 0; changed int := 0; gone int := 0; counts jsonb;
begin
 if not (viewer_is('admin') or relation_worker()) then raise exception 'Only an admin or the worker reads the sources for relationships' using errcode = '42501'; end if;
 perform pg_advisory_xact_lock(hashtext('relation_refresh:' || current_org()::text));
 for f in select * from relation_facts() loop
  keys := keys || f.edge_key;
  h := null; c := null;
  h := relation_head_of(relation_thread(f.edge_key));
  r := null;
  r.edge_key := f.edge_key; r.kind := f.kind; r.subject_type := f.subject_type; r.subject_id := f.subject_id; r.object_type := f.object_type;
  r.object_id := f.object_id; r.object_key := f.object_key; r.object_label := f.object_label; r.role := f.role; r.valid_from := f.valid_from;
  r.valid_to := f.valid_to; r.source_family := f.source_family; r.source_ref := f.source_ref; r.source_seen := f.source_seen;
  r.observed_at := f.observed_at; r.confidence := f.confidence; r.evidence := f.evidence; r.status := 'proposed';
  if h.id is null then                                                             -- new, or every version of it was undone
   r.action := 'source';
   perform relation_add(relation_thread(f.edge_key), r);
   added := added + 1; continue;
  end if;
  if h.status = 'proposed' and h.action = 'suggest' then continue; end if;          -- a colleague's suggestion waits for a reviewer
  if h.status = 'confirmed' then c := h; elsif h.standing is not null then select * into c from relation_edge where id = h.standing; end if;
  if c.id is not null then
   if relation_same(c.object_id, c.object_key, c.object_label, f.object_id, f.object_key, f.object_label) or c.source_seen = f.source_seen then
    if h.status = 'proposed' then                                                  -- the source agrees with the confirmed relationship again
     r := h; r.status := 'withdrawn'; r.action := 'source_gone'; r.actor := null; r.note := null; r.standing := c.id;
     perform relation_add(h.id, r); gone := gone + 1;
    end if;
   elsif not (h.status = 'proposed' and h.source_seen = f.source_seen) then
    r.action := 'source_changed'; r.standing := c.id; perform relation_add(h.id, r); changed := changed + 1;
   end if;
  elsif h.status = 'proposed' and h.source_seen is distinct from f.source_seen
     or h.status = 'withdrawn'
     or h.status = 'rejected' and not relation_same(h.object_id, h.object_key, h.object_label, f.object_id, f.object_key, f.object_label) then
   r.action := 'source_changed'; perform relation_add(h.id, r); changed := changed + 1;
  end if;
 end loop;
 -- A pending source proposal its source no longer makes is withdrawn; a confirmed relationship it would correct stands.
 for h in select * from relation_head where org_id = current_org() and status = 'proposed' and action in ('source','source_changed')
   and edge_key <> all(keys) loop
  r := h; r.status := 'withdrawn'; r.action := 'source_gone'; r.actor := null; r.note := null;
  perform relation_add(h.id, r); gone := gone + 1;
 end loop;
 counts := jsonb_build_object('added', added, 'changed', changed, 'withdrawn', gone, 'facts', cardinality(keys));
 insert into relation_run(org_id, by, counts) values (current_org(), current_viewer(), counts);
 perform relation_route();
 return counts;
end $$;

-- The other side a person chose: a record of the right type in this company, never a name to match.
create function pulse.relation_pick(p_kind text, p jsonb, out object_type text, out object_id uuid, out object_key text, out object_label text, out role text)
 language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare v_id uuid; v_key text := nullif(btrim(p->>'key'), '');
begin
 if coalesce(p->>'id', '') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then v_id := (p->>'id')::uuid; end if;
 if p_kind = 'development' then
  select 'development', null, x.project_key, left(mode() within group (order by coalesce(nullif(btrim(x.title), ''), x.name))
     || coalesce(' · ' || initcap(nullif(split_part(x.project_key, '@', 2), '')), ''), 300), null
   into object_type, object_id, object_key, object_label, role
   from project x where x.org_id = current_org() and x.project_key = v_key group by x.project_key;
 elsif p_kind = 'client' then
  select 'client', c.id, null, c.display_name, case c.client_type when 'developer' then 'developer' when 'channel_partner' then 'channel_partner' else 'client' end
   into object_type, object_id, object_key, object_label, role from client c where c.org_id = current_org() and c.id = v_id;
 elsif p_kind in ('team','account_owner') then
  select 'employee', s.id, null, s.display_name, case when p_kind = 'team' then 'Assigned PM' else 'Relationship owner' end
   into object_type, object_id, object_key, object_label, role from person s where s.org_id = current_org() and s.id = v_id and s.side = 'staff' and s.status = 'active';
 elsif p_kind in ('contact','model') then
  select case when cp.contact_type = 'talent' then 'model' else 'contact' end, s.id, null, s.display_name,
   case when p_kind = 'model' then 'Model in shoots' else 'Contact' end
   into object_type, object_id, object_key, object_label, role
   from person s left join contact_profile cp on cp.person_id = s.id where s.org_id = current_org() and s.id = v_id and s.side <> 'staff'
     and (p_kind = 'contact' or cp.contact_type = 'talent');
 end if;
 if object_label is null then raise exception 'Choose a record of the right kind from the list' using errcode = '22023'; end if;
end $$;

create function pulse.relation_date(p jsonb, k text, fallback date) returns date language plpgsql immutable as $$
begin
 if p is null or not p ? k then return fallback; end if;
 if coalesce(p->>k, '') = '' then return null; end if;
 return (p->>k)::date;
exception when others then raise exception 'Choose a valid date' using errcode = '22023';
end $$;

-- A named reviewer confirms, rejects or corrects the current version they saw (p_expected).
create function pulse.relation_decide(p_thread uuid, p_expected uuid, p_action text, p jsonb default '{}', p_note text default null) returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); h relation_edge; c relation_edge; r relation_edge; f record; o record; nid uuid;
 v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), ''); many boolean;
begin
 if me is null then raise exception 'Sign in to decide' using errcode = '42501'; end if;
 h := relation_head_of(p_thread);
 if h.id is null then raise exception 'Relationship not found' using errcode = 'P0002'; end if;
 if not h.kind = any(relation_my_kinds()) then raise exception 'Only a reviewer named for this kind of relationship decides it' using errcode = '42501'; end if;
 if (h.kind = 'model' or h.object_type = 'model') and not relation_model_on() then
  raise exception 'Model links wait for the owner to define models, so they cannot be decided yet' using errcode = '22023';
 end if;
 if h.id is distinct from p_expected then raise exception 'Someone changed this relationship first: reload to see the latest version' using errcode = '40001'; end if;
 many := h.kind in ('contact','model');
 select * into f from relation_facts(h.edge_key);
 if p_action = 'confirm' then
  if h.status <> 'proposed' then raise exception 'Only a proposed relationship can be confirmed' using errcode = '22023'; end if;
  if h.object_id is null and h.object_key is null then
   raise exception 'Choose the record first: a written name alone is never confirmed' using errcode = '22023';
  end if;
  if h.action in ('source','source_changed') and (f.edge_key is null or f.source_seen is distinct from h.source_seen) then
   raise exception 'The source changed since this was proposed: check the sources again, then decide' using errcode = '40001';
  end if;
  r := h; r.status := 'confirmed';
 elsif p_action = 'reject' then
  if h.status not in ('proposed','confirmed') then raise exception 'Nothing here to reject' using errcode = '22023'; end if;
  if h.status = 'proposed' and h.standing is not null then
   select * into c from relation_edge where id = h.standing;            -- a correction turned down: the confirmed relationship stands
   r := c; r.status := 'confirmed';
  else
   r := h; r.status := 'rejected';
  end if;
 elsif p_action = 'correct' then
  r := h; r.status := 'confirmed';
  if p ? 'id' or p ? 'key' then
   if many then raise exception 'Add a different person as a new relationship; a correction changes the role or dates' using errcode = '22023'; end if;
   select * into o from relation_pick(h.kind, p);
   r.object_type := o.object_type; r.object_id := o.object_id; r.object_key := o.object_key; r.object_label := o.object_label; r.role := coalesce(o.role, h.role);
  elsif r.object_id is null and r.object_key is null then
   raise exception 'Choose the record first: a written name alone is never confirmed' using errcode = '22023';
  end if;
  if nullif(btrim(p->>'role'), '') is not null then r.role := left(btrim(p->>'role'), 80); end if;
  r.source_family := 'person'; r.source_ref := null; r.confidence := null;
  r.evidence := jsonb_build_array(jsonb_build_object('basis', 'Corrected by a named reviewer'));
 else
  raise exception 'Choose confirm, reject or correct' using errcode = '22023';
 end if;
 r.valid_from := relation_date(p, 'validFrom', r.valid_from); r.valid_to := relation_date(p, 'validTo', r.valid_to);
 r.action := p_action; r.actor := me; r.note := v_note; r.standing := null;
 r.source_seen := coalesce(f.source_seen, '{}');                          -- what the source said when this was decided
 nid := relation_add(h.id, r);
 perform audit_write('relation_' || p_action, 'relation_edge', nid::text, array[h.kind]);
 perform relation_route();
 return nid;
end $$;

-- Anyone who works on projects proposes an addition or a correction; it waits for a named reviewer. A confirmed
-- relationship stays confirmed meanwhile.
create function pulse.relation_suggest(p_kind text, p_subject uuid, p jsonb, p_note text default null) returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); o record; h relation_edge; r relation_edge; k text; s_type text; nid uuid;
 v_note text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
begin
 if me is null or not exists (select 1 from person where org_id = current_org() and id = me and side = 'staff' and status = 'active') then
  raise exception 'Sign in as a colleague to suggest a relationship' using errcode = '42501';
 end if;
 if p_kind not in ('development','client','team','account_owner','contact','model') then raise exception 'Choose a kind of relationship' using errcode = '22023'; end if;
 if p_kind = 'model' and not relation_model_on() then raise exception 'Model links wait for the owner to define models' using errcode = '22023'; end if;
 s_type := case when p_kind in ('contact','account_owner') then 'client' else 'engagement' end;
 select * into o from relation_pick(p_kind, p);
 if o.object_type = 'model' and not relation_model_on() then raise exception 'Model links wait for the owner to define models' using errcode = '22023'; end if;
 k := p_kind || '|' || s_type || ':' || p_subject || case p_kind when 'team' then '|pm' when 'contact' then '|person:' || o.object_id when 'model' then '|person:' || o.object_id else '' end;
 h := relation_head_of(relation_thread(k));
 if h.id is not null and h.status in ('proposed','confirmed') and relation_same(h.object_id, h.object_key, h.object_label, o.object_id, o.object_key, o.object_label) then
  raise exception 'That is already the relationship on record' using errcode = '22023';
 end if;
 r.edge_key := k; r.kind := p_kind; r.subject_type := s_type; r.subject_id := p_subject; r.object_type := o.object_type; r.object_id := o.object_id;
 r.object_key := o.object_key; r.object_label := o.object_label; r.role := o.role; r.status := 'proposed'; r.source_family := 'person';
 r.evidence := jsonb_build_array(jsonb_build_object('basis', 'Suggested by a colleague')); r.actor := me; r.action := 'suggest'; r.note := v_note;
 r.valid_from := relation_date(p, 'validFrom', null); r.valid_to := relation_date(p, 'validTo', null);
 if h.id is not null then
  r.standing := case when h.status = 'confirmed' then h.id else h.standing end;
 end if;
 nid := relation_add(coalesce(h.id, relation_thread(k)), r);
 perform audit_write('relation_suggest', 'relation_edge', nid::text, array[p_kind]);
 perform relation_route();
 return nid;
end $$;

-- Undo the newest decision or suggestion: the version before it is current again. Source versions are not undone.
create function pulse.relation_undo(p_thread uuid, p_expected uuid) returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); h relation_edge;
begin
 if me is null then raise exception 'Sign in to undo' using errcode = '42501'; end if;
 h := relation_head_of(p_thread);
 if h.id is null then raise exception 'Relationship not found' using errcode = 'P0002'; end if;
 if h.actor is null then raise exception 'Only a person''s decision or suggestion can be undone' using errcode = '22023'; end if;
 if not (h.actor = me or h.kind = any(relation_my_kinds()) or viewer_is('admin')) then
  raise exception 'Only its author, a named reviewer or an admin undoes this' using errcode = '42501';
 end if;
 if h.id is distinct from p_expected then raise exception 'Someone changed this relationship first: reload to see the latest version' using errcode = '40001'; end if;
 update relation_edge set undone_at = clock_timestamp(), undone_by = me where id = h.id;
 perform audit_write('relation_undo', 'relation_edge', h.id::text, array[h.kind]);
 perform relation_route();
 return h.supersedes;
end $$;

-- Admins name the reviewers (owner errand E14) and the kinds each may decide; an empty list revokes.
create function pulse.relation_reviewer_set(p_person uuid, p_kinds text[], p_note text default null) returns void
 language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'Only an admin names relationship reviewers' using errcode = '42501'; end if;
 if not exists (select 1 from person where org_id = current_org() and id = p_person and side = 'staff' and status = 'active') then
  raise exception 'Choose an active colleague' using errcode = '22023';
 end if;
 update relation_reviewer set revoked_at = now(), revoked_by = current_viewer() where org_id = current_org() and person_id = p_person and revoked_at is null;
 if coalesce(cardinality(p_kinds), 0) > 0 then
  insert into relation_reviewer(org_id, person_id, kinds, note, granted_by)
  values (current_org(), p_person, array(select distinct unnest(p_kinds) order by 1), nullif(left(btrim(coalesce(p_note, '')), 300), ''), current_viewer());
 end if;
 update task set status = 'cancelled', updated_at = now(), notes = 'You are no longer a relationship reviewer.'
  where org_id = current_org() and source = 'relation_review' and source_ref = p_person::text and status in ('open','in_progress','blocked')
    and coalesce(cardinality(p_kinds), 0) = 0;
 perform relation_route();
end $$;

-- Admins record the owner's definition of a node type (models); withdrawing it hides model links again.
create function pulse.relation_node_type_set(p_type text, p_definition text, p_source text) returns void
 language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if not viewer_is('admin') or current_viewer() is null then raise exception 'Only an admin records the owner''s definition' using errcode = '42501'; end if;
 if p_type <> 'model' then raise exception 'Only models wait for a definition' using errcode = '22023'; end if;
 update relation_node_type set withdrawn_at = now(), withdrawn_by = current_viewer() where org_id = current_org() and node_type = p_type and withdrawn_at is null;
 if nullif(btrim(coalesce(p_definition, '')), '') is not null then
  if length(btrim(p_definition)) < 10 then raise exception 'Write the definition in a sentence' using errcode = '22023'; end if;
  if length(btrim(coalesce(p_source, ''))) < 3 then raise exception 'Say where the definition comes from' using errcode = '22023'; end if;
  insert into relation_node_type(org_id, node_type, definition, source_ref, configured_by)
  values (current_org(), p_type, left(btrim(p_definition), 1000), left(btrim(p_source), 300), current_viewer());
 end if;
 perform relation_route();
end $$;

revoke all on function pulse.relation_edge_guard(), pulse.relation_model_on(), pulse.relation_facts(text), pulse.relation_head_of(uuid),
 pulse.relation_thread(text), pulse.relation_add(uuid, pulse.relation_edge), pulse.relation_my_kinds(), pulse.relation_worker(), pulse.relation_route(), pulse.relation_refresh(),
 pulse.relation_pick(text, jsonb), pulse.relation_decide(uuid, uuid, text, jsonb, text), pulse.relation_suggest(text, uuid, jsonb, text),
 pulse.relation_undo(uuid, uuid), pulse.relation_reviewer_set(uuid, text[], text), pulse.relation_node_type_set(text, text, text) from public;
grant execute on function pulse.relation_model_on(), pulse.relation_my_kinds(), pulse.relation_refresh(),
 pulse.relation_decide(uuid, uuid, text, jsonb, text), pulse.relation_suggest(text, uuid, jsonb, text), pulse.relation_undo(uuid, uuid),
 pulse.relation_reviewer_set(uuid, text[], text), pulse.relation_node_type_set(text, text, text) to pulse_api;
grant execute on function pulse.relation_refresh(), pulse.relation_model_on() to pulse_worker;

-- migrate:down
-- Forward-only: relationship versions, reviewer grants and definitions are retained.
