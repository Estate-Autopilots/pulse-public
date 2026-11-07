-- migrate:up
-- GROUPS-HUB (owner, 25 Oct 2026: "To import all this we need top-notch UX/UI for an agency like EA to manage all
-- groups — types, categories, search and whatnot — and all AI agents having access and being involved in groups. So
-- much data to be imported, interpreted, analysed and put in Pulse one by one."). Additive.
--   chat_group_info        what a group is about: its type, the project's segments (R residential, P plotting, L/Lux
--                          luxury, C commercial, M mid-segment, as EA writes them in group names), services, client,
--                          project, pod, area, period, status, owner, tags and (filled by WA-IMPORT's analysis) health.
--                          Pulse reads it from the group's name (services/api/src/group-names.ts); what a person sets is
--                          kept in `manual` and never overwritten by the reader.
--   chat_group_agent       an AI employee's role in one group: observer (reads; summarises when asked), assistant
--                          (answers when @mentioned or replied to), coordinator (follows the whole group, asking first,
--                          and follows up on tasks and approvals). It reads only groups it is a member of (chat_member).
--   chat_group_view        saved views of the hub (filters, sort), personal or shared with the company.
--   chat_group_suggestion  the review queue for imported groups: link a client or project, map a sender of the
--                          imported history to a person, a task or approval found in the history; accepted or dismissed
--                          one by one. The name reader, WA-IMPORT and AI employees add to it.
--   chat_group_ai_job      a summary, task extraction or reply draft asked of an AI employee in a group it is in; its
--                          runtime (services/coworker) claims it, Pulse hands over the group's recent messages only.
-- Who sees: a group's members, and admins and leadership (metadata only, as the Chats list already shows them every
-- group to moderate); message text stays members-only. Writes go through the functions below.

create table pulse.chat_group_info (
  org_id uuid not null,
  channel_id uuid primary key,
  kind text check (kind in ('client', 'pod', 'team', 'internal', 'vendor', 'other')),
  segments text[] not null default '{}' check (segments <@ array['residential','plotting','luxury','commercial','mid']::text[]),
  services text[] not null default '{}' check (cardinality(services) <= 12),
  client_id uuid references pulse.client(id) on delete set null,
  project_id uuid references pulse.project(id) on delete set null,
  pod text check (length(pod) <= 60),
  area text check (length(area) <= 80),
  city text check (length(city) <= 60),
  period date check (period is null or extract(day from period) = 1),
  status text check (status in ('active', 'quiet', 'closed', 'archived')),
  owner_id uuid references pulse.person(id),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  health text check (health in ('good', 'watch', 'at_risk')),
  sentiment numeric(4,3) check (sentiment between -1 and 1),
  health_note text check (length(health_note) <= 400),
  health_at timestamptz,
  parsed jsonb not null default '{}' check (jsonb_typeof(parsed) = 'object'),
  manual text[] not null default '{}',
  classified_at timestamptz,
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now(),
  foreign key (org_id, channel_id) references pulse.chat_channel (org_id, id) on delete cascade
);
create index chat_group_info_client on pulse.chat_group_info (org_id, client_id);
create index chat_group_info_project on pulse.chat_group_info (org_id, project_id);

create table pulse.chat_group_agent (
  org_id uuid not null,
  channel_id uuid not null,
  agent_id uuid not null references pulse.person(id),
  role text not null check (role in ('observer', 'assistant', 'coordinator')),
  added_by uuid references pulse.person(id),
  added_at timestamptz not null default now(),
  primary key (channel_id, agent_id),
  foreign key (org_id, channel_id) references pulse.chat_channel (org_id, id) on delete cascade
);
create index chat_group_agent_agent on pulse.chat_group_agent (org_id, agent_id);

create table pulse.chat_group_view (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references pulse.person(id),
  name text not null check (length(btrim(name)) between 1 and 60),
  query jsonb not null check (jsonb_typeof(query) = 'object' and length(query::text) <= 4000),
  shared boolean not null default false,
  created_at timestamptz not null default now()
);

create table pulse.chat_group_suggestion (
  org_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null,
  kind text not null check (kind in ('link_client', 'link_project', 'map_sender', 'task', 'approval')),
  dedupe text not null check (length(dedupe) between 1 and 200),
  title text not null check (length(title) between 1 and 300),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object' and length(detail::text) <= 8000),
  source text not null check (source in ('names', 'history', 'ai', 'import')),
  confidence numeric(4,3) check (confidence between 0 and 1),
  state text not null default 'open' check (state in ('open', 'accepted', 'dismissed')),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  result_ref uuid,
  created_at timestamptz not null default now(),
  unique (org_id, channel_id, kind, dedupe),
  foreign key (org_id, channel_id) references pulse.chat_channel (org_id, id) on delete cascade
);
create index chat_group_suggestion_open on pulse.chat_group_suggestion (org_id, state, kind);

create table pulse.chat_group_ai_job (
  org_id uuid not null,
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null,
  agent_id uuid not null references pulse.person(id),
  kind text not null check (kind in ('summary', 'extract', 'draft')),
  note text check (length(note) <= 500),
  asked_by uuid not null references pulse.person(id),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  error text check (length(error) <= 400),
  engine text check (length(engine) <= 80),
  tokens_in int, tokens_out int,
  created_at timestamptz not null default now(),
  started_at timestamptz, finished_at timestamptz, lease_until timestamptz,
  foreign key (org_id, channel_id) references pulse.chat_channel (org_id, id) on delete cascade
);
create index chat_group_ai_job_queue on pulse.chat_group_ai_job (org_id, agent_id, status, created_at);
create index chat_group_ai_job_channel on pulse.chat_group_ai_job (org_id, channel_id, created_at desc);

-- Who sees a group's hub record: its members, admins and leadership (never a direct chat).
create function pulse.chat_group_sees(p_channel uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select chat_active() and exists (select 1 from chat_channel ch where ch.org_id = current_org() and ch.id = p_channel and ch.kind <> 'direct')
    and (exists (select 1 from chat_member where org_id = current_org() and channel_id = p_channel and person_id = current_viewer())
         or viewer_is('admin', 'leadership'))
$$;
-- Who manages it from the hub: admins, leadership and the group's own admins.
create function pulse.chat_group_manages(p_channel uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select chat_active() and exists (select 1 from chat_channel ch where ch.org_id = current_org() and ch.id = p_channel and ch.kind <> 'direct')
    and (viewer_is('admin', 'leadership') or exists (select 1 from chat_member where org_id = current_org() and channel_id = p_channel
         and person_id = current_viewer() and role = 'admin'))
$$;
-- An AI employee's role in a group (null: none set; it then follows its profile as before).
create function pulse.agent_group_role(p_agent uuid, p_channel uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select role from chat_group_agent where channel_id = p_channel and agent_id = p_agent
$$;

do $$
declare t text;
begin
  foreach t in array array['chat_group_info', 'chat_group_agent', 'chat_group_view', 'chat_group_suggestion', 'chat_group_ai_job'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('grant select on pulse.%I to pulse_api', t);
  end loop;
end $$;
create policy sees on pulse.chat_group_info as restrictive for select using (pulse.chat_group_sees(channel_id));
create policy sees on pulse.chat_group_agent as restrictive for select using (pulse.chat_group_sees(channel_id));
create policy sees on pulse.chat_group_suggestion as restrictive for select using (pulse.chat_group_sees(channel_id));
create policy sees on pulse.chat_group_ai_job as restrictive for select using (pulse.chat_group_sees(channel_id));
create policy own_or_shared on pulse.chat_group_view as restrictive for select using (person_id = pulse.current_viewer() or shared);

-- What the name reader found, for many groups at once (the API reads names with group-names.ts). Fields a person set
-- (manual) stay; a client or project is linked only when the API matched it with confidence.
create function pulse.chat_group_classify(p_rows jsonb) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r jsonb; n int := 0; m text[];
begin
  if not chat_active() then raise exception 'Chats is not available' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'Classify up to 2,000 groups at once' using errcode = '22023'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if not chat_group_sees((r->>'channelId')::uuid) then continue; end if;
    select manual into m from chat_group_info where channel_id = (r->>'channelId')::uuid;
    m := coalesce(m, '{}');
    insert into chat_group_info as g (org_id, channel_id, kind, segments, services, client_id, project_id, pod, area, city, period, parsed, classified_at)
    values (current_org(), (r->>'channelId')::uuid, r->>'kind',
      coalesce((select array_agg(x) from jsonb_array_elements_text(r->'segments') x), '{}'),
      coalesce((select array_agg(x) from jsonb_array_elements_text(r->'services') x), '{}'),
      (select id from client where id = (r->>'clientId')::uuid), (select id from project where id = (r->>'projectId')::uuid),
      r->>'pod', r->>'area', r->>'city', (r->>'period')::date, coalesce(r->'parsed', '{}'), now())
    on conflict (channel_id) do update set
      kind = case when 'kind' = any(m) then g.kind else excluded.kind end,
      segments = case when 'segments' = any(m) then g.segments else excluded.segments end,
      services = case when 'services' = any(m) then g.services else excluded.services end,
      client_id = case when 'client' = any(m) then g.client_id else coalesce(excluded.client_id, g.client_id) end,
      project_id = case when 'project' = any(m) then g.project_id else coalesce(excluded.project_id, g.project_id) end,
      pod = case when 'pod' = any(m) then g.pod else excluded.pod end,
      area = case when 'area' = any(m) then g.area else excluded.area end,
      city = case when 'city' = any(m) then g.city else excluded.city end,
      period = case when 'period' = any(m) then g.period else excluded.period end,
      parsed = excluded.parsed, classified_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

-- A person sets fields of one or many groups (bulk actions). Only the keys given change; each becomes "set by hand".
-- Keys: kind, segments, services, clientId, projectId, pod, area, city, period, status, ownerId, tags (replace),
-- addTags, removeTags. A null value clears the field and gives it back to the name reader.
create function pulse.chat_group_set(p_channels uuid[], p jsonb) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ch uuid; n int := 0; k text; touched text[] := '{}'; cleared text[] := '{}';
begin
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Nothing to change' using errcode = '22023'; end if;
  if cardinality(p_channels) > 1000 then raise exception 'Change up to 1,000 groups at once' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('kind','segments','services','clientId','projectId','pod','area','city','period','status','ownerId','tags','addTags','removeTags') then
      raise exception 'Unknown field %', k using errcode = '22023'; end if;
    if k in ('addTags','removeTags','tags','status','ownerId') then continue; end if;
    if jsonb_typeof(p->k) = 'null' then cleared := cleared || (case k when 'clientId' then 'client' when 'projectId' then 'project' else k end);
    else touched := touched || (case k when 'clientId' then 'client' when 'projectId' then 'project' else k end); end if;
  end loop;
  if p ? 'clientId' and jsonb_typeof(p->'clientId') <> 'null' and not exists (select 1 from client where id = (p->>'clientId')::uuid) then
    raise exception 'Choose a client of this company' using errcode = '22023'; end if;
  if p ? 'projectId' and jsonb_typeof(p->'projectId') <> 'null' and not exists (select 1 from project where id = (p->>'projectId')::uuid and deleted_at is null) then
    raise exception 'Choose a project of this company' using errcode = '22023'; end if;
  if p ? 'ownerId' and jsonb_typeof(p->'ownerId') <> 'null' and not exists (select 1 from person where id = (p->>'ownerId')::uuid and side = 'staff' and status = 'active') then
    raise exception 'Choose an active colleague as the owner' using errcode = '22023'; end if;
  foreach ch in array p_channels loop
    if not chat_group_manages(ch) then raise exception 'You can change only groups you manage' using errcode = '42501'; end if;
    insert into chat_group_info (org_id, channel_id) values (current_org(), ch) on conflict (channel_id) do nothing;
    update chat_group_info g set
      kind = case when p ? 'kind' then p->>'kind' else g.kind end,
      segments = case when p ? 'segments' then coalesce((select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(p->'segments') = 'array' then p->'segments' end) x), '{}') else g.segments end,
      services = case when p ? 'services' then coalesce((select array_agg(left(x, 40)) from jsonb_array_elements_text(case when jsonb_typeof(p->'services') = 'array' then p->'services' end) x), '{}') else g.services end,
      client_id = case when p ? 'clientId' then (p->>'clientId')::uuid else g.client_id end,
      project_id = case when p ? 'projectId' then (p->>'projectId')::uuid else g.project_id end,
      pod = case when p ? 'pod' then nullif(btrim(p->>'pod'), '') else g.pod end,
      area = case when p ? 'area' then nullif(btrim(p->>'area'), '') else g.area end,
      city = case when p ? 'city' then nullif(btrim(p->>'city'), '') else g.city end,
      period = case when p ? 'period' then (p->>'period')::date else g.period end,
      status = case when p ? 'status' then p->>'status' else g.status end,
      owner_id = case when p ? 'ownerId' then (p->>'ownerId')::uuid else g.owner_id end,
      tags = (select coalesce(array_agg(distinct t order by t), '{}') from unnest(
               case when p ? 'tags' then coalesce((select array_agg(left(lower(btrim(x)), 40)) from jsonb_array_elements_text(p->'tags') x), '{}') else g.tags end
               || coalesce((select array_agg(left(lower(btrim(x)), 40)) from jsonb_array_elements_text(case when p ? 'addTags' then p->'addTags' else '[]' end) x), '{}')) t
             where t <> '' and not t = any(coalesce((select array_agg(lower(btrim(x))) from jsonb_array_elements_text(case when p ? 'removeTags' then p->'removeTags' else '[]' end) x), '{}'))),
      manual = (select coalesce(array_agg(distinct f), '{}') from unnest(g.manual || touched) f where not f = any(cleared)),
      updated_by = current_viewer(), updated_at = now()
    where g.channel_id = ch;
    n := n + 1;
  end loop;
  perform audit_write('update', 'chat_group_info', array_to_string(p_channels[1:5], ','), array(select jsonb_object_keys(p)));
  return n;
end $$;

-- Put AI employees in groups with a role, change the role, or take them out (role null). Pod, team and Google groups
-- follow the roster: an AI employee joins those through its profile, and here only its role changes.
create function pulse.chat_group_agent_set(p_channels uuid[], p_agent uuid, p_role text) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ch uuid; n int := 0; k text; nm text; gone int;
begin
  if p_role is not null and p_role not in ('observer', 'assistant', 'coordinator') then raise exception 'Choose observer, assistant or coordinator' using errcode = '22023'; end if;
  if not exists (select 1 from agent_member m join person p on p.id = m.person_id where m.org_id = current_org() and m.person_id = p_agent and m.disabled_at is null and p.status = 'active') then
    raise exception 'Choose an active AI employee' using errcode = '22023'; end if;
  select display_name into nm from person where id = p_agent;
  foreach ch in array p_channels loop
    if not chat_group_manages(ch) then raise exception 'You can change only groups you manage' using errcode = '42501'; end if;
    select kind into k from chat_channel where id = ch;
    if p_role is null then
      delete from chat_group_agent where channel_id = ch and agent_id = p_agent;
      if k = 'custom' then
        delete from chat_member where org_id = current_org() and channel_id = ch and person_id = p_agent;
        get diagnostics gone = row_count;
        if gone > 0 then perform chat_event_line(ch, current_viewer(), 'removed ' || nm); end if;
      end if;
    else
      if not exists (select 1 from chat_member where channel_id = ch and person_id = p_agent) then
        if k <> 'custom' then raise exception '% follows its roster: add % to it from the AI employee''s profile', (select name from chat_channel where id = ch), nm using errcode = '22023'; end if;
        insert into chat_member (org_id, channel_id, person_id) values (current_org(), ch, p_agent);
        perform chat_event_line(ch, current_viewer(), 'added ' || nm || ' (AI ' || p_role || ')');
      end if;
      insert into chat_group_agent (org_id, channel_id, agent_id, role, added_by) values (current_org(), ch, p_agent, p_role, current_viewer())
      on conflict (channel_id, agent_id) do update set role = excluded.role, added_by = excluded.added_by, added_at = now();
    end if;
    n := n + 1;
  end loop;
  perform audit_write('update', 'chat_group_agent', p_agent::text, array['role']);
  return n;
end $$;

-- Add colleagues to groups from the hub (admins, leadership, the group's admins). Pods and teams follow the roster.
create function pulse.chat_group_add_people(p_channels uuid[], p_people uuid[]) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ch uuid; n int := 0; who record;
begin
  foreach ch in array p_channels loop
    if not chat_group_manages(ch) then raise exception 'You can change only groups you manage' using errcode = '42501'; end if;
    if (select kind from chat_channel where id = ch) <> 'custom' then continue; end if;
    for who in insert into chat_member (org_id, channel_id, person_id)
      select current_org(), ch, p.id from person p where p.org_id = current_org() and p.id = any(p_people) and p.status = 'active' and p.side = 'staff'
      on conflict do nothing returning person_id loop
      perform chat_event_line(ch, current_viewer(), 'added ' || (select display_name from person where id = who.person_id));
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- Saved views: mine, or shared with the company (only admins and leadership share).
create function pulse.chat_group_view_save(p_id uuid, p_name text, p_query jsonb, p_shared boolean) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid;
begin
  if current_viewer() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if p_shared and not viewer_is('admin', 'leadership') then raise exception 'Only admins and leadership share views' using errcode = '42501'; end if;
  if p_id is null then
    insert into chat_group_view (org_id, person_id, name, query, shared) values (current_org(), current_viewer(), btrim(p_name), p_query, coalesce(p_shared, false)) returning id into v;
  else
    update chat_group_view set name = btrim(p_name), query = p_query, shared = coalesce(p_shared, false)
     where id = p_id and org_id = current_org() and person_id = current_viewer() returning id into v;
    if v is null then raise exception 'Only its owner changes a view' using errcode = '42501'; end if;
  end if;
  return v;
end $$;
create function pulse.chat_group_view_delete(p_id uuid) returns void
  language sql security definer set search_path = pulse, pg_temp as $$
  delete from chat_group_view where id = p_id and org_id = current_org() and (person_id = current_viewer() or (shared and viewer_is('admin', 'leadership')))
$$;

-- The review queue: add (dedupe per group and kind), decide.
create function pulse.chat_group_suggest(p_rows jsonb) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare n int;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'Up to 2,000 suggestions at once' using errcode = '22023'; end if;
  insert into chat_group_suggestion (org_id, channel_id, kind, dedupe, title, detail, source, confidence)
  select current_org(), (r->>'channelId')::uuid, r->>'kind', left(r->>'dedupe', 200), left(r->>'title', 300), coalesce(r->'detail', '{}'), r->>'source', (r->>'confidence')::numeric
    from jsonb_array_elements(p_rows) r where chat_group_sees((r->>'channelId')::uuid)
  on conflict (org_id, channel_id, kind, dedupe) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
create function pulse.chat_group_suggestion_decide(p_id uuid, p_state text, p_result uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s chat_group_suggestion;
begin
  select * into s from chat_group_suggestion where id = p_id and org_id = current_org() for update;
  if not found or not chat_group_sees(s.channel_id) then raise exception 'Suggestion not found' using errcode = 'P0002'; end if;
  if s.kind in ('link_client', 'link_project', 'map_sender') and not chat_group_manages(s.channel_id) then
    raise exception 'Only someone who manages this group links it' using errcode = '42501'; end if;
  if p_state not in ('accepted', 'dismissed', 'open') then raise exception 'Accept, dismiss or reopen' using errcode = '22023'; end if;
  update chat_group_suggestion set state = p_state, decided_by = case when p_state = 'open' then null else current_viewer() end,
    decided_at = case when p_state = 'open' then null else now() end, result_ref = p_result where id = p_id;
end $$;

-- Imported history senders not linked to anyone yet, per group (for the review queue): members and admins only.
create function pulse.chat_group_unmapped_senders() returns table (channel_id uuid, label text, messages int, first_at timestamptz, last_at timestamptz)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select m.channel_id, m.author_label, count(*)::int, min(m.sent_at), max(m.sent_at)
    from pulse_priv.chat_import_message m
    join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
   where m.org_id = current_org() and m.author_id is null and chat_active()
     and (chat_history_reader(m.channel_id) or viewer_is('admin'))
   group by 1, 2
  union all
  -- WA-IMPORT (1015): a participant nobody is yet (a bare number, masked, or a name Pulse does not know).
  select c.channel_id, pa.label, pa.messages, pa.first_at, pa.last_at
    from pulse_priv.wa_participant pa join pulse_priv.wa_chat c on c.org_id = pa.org_id and c.id = pa.chat_id
   where pa.org_id = current_org() and pa.person_id is null and pa.kind in ('number', 'unknown') and wa_reader(c.id)
$$;
-- Link every message of one imported sender in one group to a colleague or a client contact.
create function pulse.chat_group_map_sender(p_channel uuid, p_label text, p_person uuid) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare n int; k int; who_side text;
begin
  if not chat_group_manages(p_channel) then raise exception 'Only someone who manages this group maps its senders' using errcode = '42501'; end if;
  select p.side into who_side from person p where p.org_id = current_org() and p.id = p_person and p.side in ('staff', 'client') and p.status = 'active';
  if who_side is null then raise exception 'Choose a colleague or a client contact' using errcode = '22023'; end if;
  update pulse_priv.chat_import_message set author_id = p_person
   where org_id = current_org() and channel_id = p_channel and author_label = p_label and author_id is null;
  get diagnostics n = row_count;
  update pulse_priv.wa_participant pa set person_id = p_person, kind = case when who_side = 'staff' then 'colleague' else 'client' end
    from pulse_priv.wa_chat c where c.org_id = pa.org_id and c.id = pa.chat_id and c.channel_id = p_channel
     and pa.org_id = current_org() and pa.label = p_label and pa.person_id is null;
  get diagnostics k = row_count;
  if k > 0 then n := n + coalesce((select sum(pa.messages)::int from pulse_priv.wa_participant pa join pulse_priv.wa_chat c on c.id = pa.chat_id
                                   where c.channel_id = p_channel and pa.label = p_label and pa.person_id = p_person), 0); end if;
  perform audit_write('update', 'chat_history', p_channel::text, array['author_id']);
  return n;
end $$;

-- Group-level message search: matches per group in live messages and (members only) imported history.
create function pulse.chat_group_search(p_q text) returns table (channel_id uuid, hits int, imported int)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  with q as (select btrim(p_q) t, '%' || replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') || '%' l),
  mine as (select channel_id from chat_member where org_id = current_org() and person_id = current_viewer()),
  live as (select m.channel_id, count(*)::int n from chat_message m, q
            where m.org_id = current_org() and m.removed_at is null and m.kind = 'text' and length(q.t) >= 2
              and m.channel_id in (select channel_id from mine)
              and (to_tsvector('simple', m.body) @@ plainto_tsquery('simple', q.t) or m.body ilike q.l)
            group by 1),
  hist as (select m.channel_id, count(*)::int n from pulse_priv.chat_import_message m
            join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null, q
            where m.org_id = current_org() and length(q.t) >= 2 and m.channel_id in (select channel_id from mine) and m.body ilike q.l
            group by 1
            union all
            select c.channel_id, count(*)::int from pulse_priv.wa_message m join pulse_priv.wa_chat c on c.org_id = m.org_id and c.id = m.chat_id
            join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null, q
            where m.org_id = current_org() and length(q.t) >= 2 and c.channel_id in (select channel_id from mine) and (m.body ilike q.l or m.file_name ilike q.l)
            group by 1),
  h as (select channel_id, sum(n)::int n from hist group by 1)
  select coalesce(l.channel_id, h.channel_id), coalesce(l.n, 0) + coalesce(h.n, 0), coalesce(h.n, 0)
    from live l full join h on h.channel_id = l.channel_id
   where chat_active()
$$;

-- A group's imported history lines (both kinds of import), oldest first, for the history scan and AI jobs: members and admins.
create function pulse.chat_group_history_lines(p_channel uuid, p_limit int) returns table (id uuid, author text, body text, at text, side text)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select x.id, x.author, x.body, to_char(x.sent_at at time zone org_time_zone(), 'YYYY-MM-DD'), x.side from (
    select m.id, coalesce(p.display_name, m.author_label) author, m.body, m.sent_at, p.side
      from pulse_priv.chat_import_message m join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
      left join person p on p.id = m.author_id
     where m.org_id = current_org() and m.channel_id = p_channel and m.kind = 'text' and (chat_history_reader(p_channel) or viewer_is('admin'))
    union all
    select m.id, coalesce(p.display_name, pa.label), m.body, m.sent_at, coalesce(p.side, case pa.kind when 'colleague' then 'staff' else 'client' end)
      from pulse_priv.wa_message m join pulse_priv.wa_chat c on c.org_id = m.org_id and c.id = m.chat_id
      join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
      left join pulse_priv.wa_participant pa on pa.org_id = m.org_id and pa.id = m.participant_id left join person p on p.id = pa.person_id
     where m.org_id = current_org() and c.channel_id = p_channel and m.kind = 'text' and wa_reader(c.id)
    order by 4 desc limit least(greatest(p_limit, 1), 2000)) x
  order by x.sent_at
$$;

-- Ask an AI employee in a group for a summary, the tasks and approvals in it, or a reply draft.
create function pulse.chat_group_ai_ask(p_channel uuid, p_agent uuid, p_kind text, p_note text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare j uuid;
begin
  if not chat_group_sees(p_channel) or not (exists (select 1 from chat_member where channel_id = p_channel and person_id = current_viewer()) or chat_group_manages(p_channel)) then
    raise exception 'Ask in a group you are in' using errcode = '42501'; end if;
  if not exists (select 1 from chat_member cm join agent_member m on m.person_id = cm.person_id
                  where cm.channel_id = p_channel and cm.person_id = p_agent and m.disabled_at is null) then
    raise exception 'That AI employee is not in this group: add it first' using errcode = '22023'; end if;
  if p_kind not in ('summary', 'extract', 'draft') then raise exception 'Ask for a summary, tasks or a draft' using errcode = '22023'; end if;
  if (select count(*) from chat_group_ai_job where org_id = current_org() and asked_by = current_viewer() and created_at > now() - interval '1 hour') >= 40 then
    raise exception 'You asked 40 times in the last hour; try again later' using errcode = '54000'; end if;
  select id into j from chat_group_ai_job where org_id = current_org() and channel_id = p_channel and agent_id = p_agent and kind = p_kind
     and status in ('queued', 'running') limit 1;
  if j is not null then return j; end if;
  insert into chat_group_ai_job (org_id, channel_id, agent_id, kind, note, asked_by) values (current_org(), p_channel, p_agent, p_kind, left(p_note, 500), current_viewer()) returning id into j;
  return j;
end $$;

-- An AI employee's role, where it reads. The live definition (0987) with the role added: an observer is never woken
-- by messages, an assistant only when @mentioned or replied to, a coordinator by the whole group.
create or replace function pulse.agent_event_from_chat() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a record; leader boolean;
begin
  if new.kind <> 'text' or new.removed_at is not null or new.author_id is distinct from current_viewer() then return null; end if;
  if btrim(coalesce(new.body, '')) = '' then return null; end if;
  if exists(select 1 from person where id = new.author_id and side = 'agent') then return null; end if;
  if agent_proposal_from_reply(new.id) then return null; end if;
  leader := agent_leader(new.author_id);
  for a in
    select m.person_id agent, x.kind
      from agent_member m join person p on p.id = m.person_id
      join chat_channel ch on ch.id = new.channel_id
      join chat_member cm on cm.channel_id = new.channel_id and cm.person_id = m.person_id
      cross join lateral (select case when ch.kind = 'direct' then 'chat.message' when m.person_id = any(new.mentions) then 'chat.mention'
          when exists(select 1 from chat_message pm where pm.id = coalesce(new.parent_id, new.quote_id) and pm.author_id = m.person_id) then 'chat.reply'
          else 'chat.group' end kind) x
      left join chat_group_agent ga on ga.channel_id = new.channel_id and ga.agent_id = m.person_id
     where m.org_id = new.org_id and not m.post_only and m.disabled_at is null and p.status = 'active'
       and (ch.kind = 'direct' or m.speak_scope = 'its_groups' or (m.speak_scope = 'listed' and ch.id = any(m.speak_channels)))
       and (agent_mode_for(m, x.kind) <> 'off' or (x.kind = 'chat.group' and ga.role = 'coordinator'))
       and coalesce(ga.role, '') <> 'observer'
       and not (x.kind = 'chat.group' and ga.role = 'assistant')
       and (leader or m.listens_to = 'everyone')
       and not (x.kind = 'chat.group' and new.author_id = agent_approver_for(m.person_id, new.channel_id))
  loop
    insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
    values (new.org_id, a.agent, a.kind, 'message', new.id, 'message:' || new.id, new.author_id) on conflict do nothing;
  end loop;
  return null;
end $$;

-- The AI employee's runtime claims its next job (only in groups it is a member of, within its daily budget) and gets
-- the group's facts and recent messages; imported history goes along only when p_history (PULSE_GROUP_AI_HISTORY=1:
-- the owner's answer on sending imported client data to an AI engine). Phone numbers are masked.
create function pulse.chat_group_ai_claim(p_history boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); j chat_group_ai_job; m agent_member; used int;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  update chat_group_ai_job set status = 'queued', lease_until = null where org_id = current_org() and agent_id = me and status = 'running' and lease_until < now();
  update chat_group_ai_job x set status = 'failed', error = 'It is no longer in this group', finished_at = now()
   where x.org_id = current_org() and x.agent_id = me and x.status = 'queued'
     and not exists (select 1 from chat_member where channel_id = x.channel_id and person_id = me);
  select * into m from agent_member where person_id = me;
  select coalesce(sum(coalesce(tokens, reserved)), 0)::int into used from agent_run
   where agent_id = me and (started_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date;
  used := used + coalesce((select sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0))::int from chat_group_ai_job
                            where agent_id = me and finished_at > now() - interval '1 day'), 0);
  if used + 30000 > m.daily_token_budget then return null; end if;
  select * into j from chat_group_ai_job where org_id = current_org() and agent_id = me and status = 'queued' order by created_at limit 1 for update skip locked;
  if not found then return null; end if;
  update chat_group_ai_job set status = 'running', started_at = now(), lease_until = now() + interval '12 minutes' where id = j.id;
  return jsonb_build_object('id', j.id, 'kind', j.kind, 'note', j.note, 'channelId', j.channel_id,
    'askedBy', (select display_name from person where id = j.asked_by),
    'now', to_char(now() at time zone org_time_zone(), 'FMDay DD Mon YYYY, HH24:MI'),
    'group', (select jsonb_build_object('name', ch.name, 'role', agent_group_role(me, ch.id), 'clientFacing', chat_client_facing(ch.id),
        'client', (select display_name from client where id = g.client_id), 'project', (select name from project where id = g.project_id),
        'area', g.area, 'pod', g.pod, 'segments', g.segments, 'services', g.services,
        'members', (select coalesce(jsonb_agg(jsonb_build_object('name', p.display_name, 'side', p.side) order by p.display_name), '[]')
                      from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = ch.id))
      from chat_channel ch left join chat_group_info g on g.channel_id = ch.id where ch.id = j.channel_id),
    'messages', (select coalesce(jsonb_agg(x.j order by x.at), '[]') from (
        select msg.created_at at, jsonb_build_object('at', to_char(msg.created_at at time zone org_time_zone(), 'DD Mon HH24:MI'), 'author', p.display_name,
          'side', p.side, 'body', regexp_replace(left(msg.body, 600), '\+?\d[\d \-]{8,}\d', '[number]', 'g'),
          'files', jsonb_array_length(msg.attachments)) j
          from chat_message msg join person p on p.id = msg.author_id
         where msg.channel_id = j.channel_id and msg.removed_at is null and msg.kind = 'text'
         order by msg.created_at desc limit 120) x),
    'history', case when p_history then (select coalesce(jsonb_agg(jsonb_build_object('at', h.at, 'author', h.author,
          'body', regexp_replace(left(h.body, 500), '\+?\d[\d \-]{8,}\d', '[number]', 'g'))), '[]')
        from chat_group_history_lines(j.channel_id, 150) h) else '[]'::jsonb end,
    'openTasks', (select coalesce(jsonb_agg(jsonb_build_object('title', t.title, 'status', t.status, 'due', t.due_at::date, 'who', (select display_name from person where id = t.assignee_person_id))), '[]')
       from (select t.* from task t left join chat_group_info g on g.channel_id = j.channel_id
              where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled')
                and ((g.project_id is not null and t.project_id = g.project_id)
                     or exists (select 1 from chat_task_follow f where f.task_id = t.id and f.channel_id = j.channel_id))
              order by t.due_at nulls last limit 30) t),
    'maxOut', case j.kind when 'summary' then 1200 when 'extract' then 2000 else 900 end);
end $$;

-- The job's answer (checked by the API) or why it failed.
create function pulse.chat_group_ai_finish(p_id uuid, p_status text, p_result jsonb, p_error text, p_engine text, p_in int, p_out int) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); ch uuid;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  if p_status not in ('done', 'failed') then raise exception 'Done or failed' using errcode = '22023'; end if;
  update chat_group_ai_job set status = p_status, result = p_result, error = left(p_error, 400), engine = left(p_engine, 80),
    tokens_in = p_in, tokens_out = p_out, finished_at = now(), lease_until = null
   where id = p_id and org_id = current_org() and agent_id = me and status = 'running' returning channel_id into ch;
  if ch is null then raise exception 'This job is not yours to finish' using errcode = '22023'; end if;
  return ch;
end $$;

-- Suggestions an AI employee found in a group it is in (from an extract job).
create function pulse.chat_group_ai_suggest(p_job uuid, p_rows jsonb) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); ch uuid; n int;
begin
  select channel_id into ch from chat_group_ai_job where id = p_job and org_id = current_org() and agent_id = me;
  if ch is null or not exists (select 1 from chat_member where channel_id = ch and person_id = me) then raise exception 'Not your job' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 40 then raise exception 'Up to 40 suggestions' using errcode = '22023'; end if;
  insert into chat_group_suggestion (org_id, channel_id, kind, dedupe, title, detail, source, confidence)
  select current_org(), ch, r->>'kind', left(r->>'dedupe', 200), left(r->>'title', 300), coalesce(r->'detail', '{}') || jsonb_build_object('job', p_job), 'ai', (r->>'confidence')::numeric
    from jsonb_array_elements(p_rows) r where r->>'kind' in ('task', 'approval')
  on conflict (org_id, channel_id, kind, dedupe) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- The hub's list in one read: every group the viewer sees with its facts, counts and activity (metadata; previews and
-- message text only where the viewer is a member). "Waiting" is a client-side message that no colleague answered after.
create function pulse.chat_group_hub() returns table (
  id uuid, name text, channel_kind text, created_at timestamptz, member boolean, my_role text, members int, clients int,
  member_ids uuid[], agents jsonb, last_at timestamptz, last_live_at timestamptz, messages_7d int, messages_30d int, messages int,
  unread int, waiting_since timestamptz, waiting_who text, imported int, imported_first timestamptz, imported_last timestamptz,
  unmapped int, open_suggestions int, open_tasks int, files int, info jsonb, archived_by_me boolean, preview text, wa_client_id uuid, wa_project_id uuid, insight jsonb)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  with v as (select current_viewer() me, viewer_is('admin', 'leadership') lead),
  chs as (select ch.* from chat_channel ch, v where ch.org_id = current_org() and ch.kind <> 'direct' and chat_active()
            and (v.lead or exists (select 1 from chat_member cm where cm.channel_id = ch.id and cm.person_id = v.me))),
  -- Imported history: R47's text imports (chat_import_*) and WA-IMPORT's lossless chats (1015 wa_*); unmapped = senders.
  imp0 as (select m.channel_id, count(*)::int n, min(m.sent_at) f, max(m.sent_at) l, count(distinct m.author_label) filter (where m.author_id is null)::int un, null::uuid cl, null::uuid pr
            from pulse_priv.chat_import_message m join pulse_priv.chat_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
           where m.org_id = current_org() and m.channel_id in (select chs.id from chs) group by 1
           union all
           select c.channel_id, c.messages, c.first_at, c.last_at,
             (select count(*)::int from pulse_priv.wa_participant pa where pa.org_id = c.org_id and pa.chat_id = c.id and pa.person_id is null and pa.kind in ('number', 'unknown')),
             c.client_id, c.project_id
            from pulse_priv.wa_chat c where c.org_id = current_org() and c.channel_id in (select chs.id from chs)),
  imp as (select channel_id, sum(n)::int n, min(f) f, max(l) l, sum(un)::int un, (array_agg(cl) filter (where cl is not null))[1] cl, (array_agg(pr) filter (where pr is not null))[1] pr from imp0 group by 1),
  -- WA-IMPORT's analysis (1016): the service stages seen in the chat, answer times and its sales and service signals.
  ins as (select c.channel_id, jsonb_strip_nulls(jsonb_build_object('stages', i.metrics->'stage_sequence', 'teamMin', i.metrics->'team_median_answer_min',
              'clientMin', i.metrics->'client_median_answer_min', 'daysToLive', i.metrics->'days_start_to_live', 'revisions', i.metrics->'revisions',
              'signals', (select jsonb_object_agg(z.kind, z.n) from (select s.kind, count(*) n from pulse_priv.wa_signal s where s.org_id = c.org_id and s.chat_id = c.id group by 1) z),
              'sentiment', (select round(avg(ms.sentiment)::numeric, 3) from pulse_priv.wa_message_signal ms where ms.org_id = c.org_id and ms.chat_id = c.id))) j
            from pulse_priv.wa_chat c left join pulse_priv.wa_insight i on i.org_id = c.org_id and i.subject = 'chat' and i.subject_id = c.id
           where c.org_id = current_org() and c.channel_id in (select chs.id from chs)),
  msg as (select m.channel_id, max(m.created_at) l, count(*) filter (where m.kind = 'text')::int n,
            count(*) filter (where m.kind = 'text' and m.created_at > now() - interval '7 days')::int n7,
            count(*) filter (where m.kind = 'text' and m.created_at > now() - interval '30 days')::int n30,
            coalesce(sum(jsonb_array_length(m.attachments)), 0)::int files
            from chat_message m where m.org_id = current_org() and m.removed_at is null and m.channel_id in (select chs.id from chs) group by 1),
  tp as (select t.project_id, count(*)::int n from task t where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled')
           and t.project_id is not null group by 1),
  tf as (select f.channel_id, count(*)::int n from chat_task_follow f join task t on t.id = f.task_id
          where t.org_id = current_org() and t.deleted_at is null and t.status not in ('done', 'accepted', 'cancelled') group by 1),
  sg as (select s.channel_id, count(*)::int n from chat_group_suggestion s where s.org_id = current_org() and s.state = 'open' group by 1)
  select ch.id, ch.name, ch.kind, ch.created_at, mine.person_id is not null, mine.role,
    (select count(*)::int from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = ch.id and p.status = 'active' and p.side <> 'agent'),
    (select count(*)::int from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = ch.id and p.status = 'active' and p.side not in ('staff', 'agent')),
    (select array_agg(cm.person_id order by cm.joined_at) from (select cm.person_id, cm.joined_at from chat_member cm join person p on p.id = cm.person_id
       where cm.channel_id = ch.id and p.status = 'active' and p.side = 'staff' order by cm.role = 'admin' desc, cm.joined_at limit 6) cm),
    (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'role', coalesce(ga.role, 'profile')) order by p.display_name), '[]')
       from chat_member cm join person p on p.id = cm.person_id and p.side = 'agent'
       left join chat_group_agent ga on ga.channel_id = ch.id and ga.agent_id = p.id where cm.channel_id = ch.id),
    greatest(msg.l, imp.l), msg.l, coalesce(msg.n7, 0), coalesce(msg.n30, 0), coalesce(msg.n, 0) + coalesce(imp.n, 0),
    case when mine.person_id is null then 0 else (select count(*)::int from chat_message m where m.channel_id = ch.id and m.author_id <> v.me
       and m.created_at > mine.read_through and m.removed_at is null and m.kind = 'text' and m.parent_id is null) end,
    w.at, w.who, coalesce(imp.n, 0), imp.f, imp.l, coalesce(imp.un, 0), coalesce(sg.n, 0),
    coalesce(case when g.project_id is not null then (select n from tp where tp.project_id = g.project_id) end, 0) + coalesce(tf.n, 0),
    coalesce(msg.files, 0),
    case when g.channel_id is null then null else jsonb_build_object('kind', g.kind, 'segments', g.segments, 'services', g.services,
      'clientId', g.client_id, 'client', (select display_name from client where id = g.client_id),
      'projectId', g.project_id, 'project', (select name from project where id = g.project_id),
      'pod', g.pod, 'area', g.area, 'city', g.city, 'period', to_char(g.period, 'YYYY-MM'), 'status', g.status,
      'ownerId', g.owner_id, 'owner', (select display_name from person where id = g.owner_id), 'tags', g.tags,
      'health', g.health, 'sentiment', g.sentiment, 'healthNote', g.health_note, 'parsed', g.parsed, 'manual', g.manual, 'classifiedAt', g.classified_at) end,
    mine.archived_at is not null,
    case when mine.person_id is not null then (select left(regexp_replace(m.body, '\s+', ' ', 'g'), 120) from chat_message m where m.channel_id = ch.id and m.removed_at is null and m.kind = 'text' order by m.created_at desc limit 1) end,
    imp.cl, imp.pr, ins.j
  from chs ch cross join v
  left join chat_member mine on mine.channel_id = ch.id and mine.person_id = v.me
  left join chat_group_info g on g.channel_id = ch.id
  left join imp on imp.channel_id = ch.id
  left join ins on ins.channel_id = ch.id
  left join msg on msg.channel_id = ch.id
  left join tf on tf.channel_id = ch.id
  left join sg on sg.channel_id = ch.id
  left join lateral (select max(r.created_at) at from chat_message r join person rp on rp.id = r.author_id
       where r.channel_id = ch.id and r.removed_at is null and r.kind = 'text' and rp.side in ('staff', 'agent')) ls on true
  left join lateral (select c.created_at at, p.display_name who from chat_message c join person p on p.id = c.author_id
       where c.channel_id = ch.id and c.removed_at is null and c.kind = 'text' and p.side not in ('staff', 'agent')
         and c.created_at > coalesce(ls.at, '-infinity')
       order by c.created_at asc limit 1) w on true
$$;

-- A coordinator follows the whole group: its group messages run in ask-first mode even where its profile keeps it
-- quiet in groups (agent_dispatch as in 1003, with that line and its role in the run's context).
create or replace function pulse.agent_dispatch(p_id uuid, p_token uuid, p_lane text, p_model text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pulse', 'pg_temp'
as $function$
declare me uuid := agent_session(); e agent_event; m agent_member; msg chat_message; why text; busy text; committed int; rid uuid; dl timestamptz;
  ch_kind text; approver uuid; mode text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  m := agent_lock(me);
  select * into e from agent_event where id = p_id and org_id = current_org() and agent_id = me for update;
  if not found or e.state <> 'leased' or e.lease_token is distinct from p_token or e.lease_until <= now() then
    raise exception 'That event is not leased to you any more' using errcode='22023'; end if;
  perform agent_sweep(me);
  select * into msg from chat_message where id = e.subject_id;
  why := case
    when e.subject_type <> 'message' then 'not_chats'
    when msg.id is null or msg.removed_at is not null then 'message_gone'
    when not agent_leader(e.invoked_by) and m.listens_to <> 'everyone' then 'not_leader'
    when not exists(select 1 from chat_member where channel_id = msg.channel_id and person_id = me) then 'agent_left'
    when not exists(select 1 from chat_member where channel_id = msg.channel_id and person_id = e.invoked_by) then 'asker_left'
  end;
  if why is null then
    select coalesce(sum(case when state in ('done','error') then coalesce(tokens, reserved) else reserved end), 0) into committed
      from agent_run where agent_id = me and (started_at at time zone org_time_zone())::date = (now() at time zone org_time_zone())::date;
    if committed + m.run_reserve > m.daily_token_budget then why := 'budget_spent'; end if;
  end if;
  if why is not null then
    update agent_event set state = 'failed', finished_at = now(), lease_token = null, lease_until = null, reason = why where id = e.id;
    return jsonb_build_object('status', 'refused', 'reason', why);
  end if;
  busy := case
    when m.disabled_at is not null then 'paused'
    when exists(select 1 from agent_run where agent_id = me and state = 'dispatching') then 'one_at_a_time'
    when (select count(*) from agent_run where agent_id = me and started_at > now() - interval '1 hour') >= 60 then 'hourly_limit'
  end;
  if busy is not null then
    update agent_event set state = 'queued', lease_token = null, lease_until = null, retry_at = now() + interval '20 seconds', reason = busy where id = e.id;
    return jsonb_build_object('status', 'busy', 'reason', busy);
  end if;
  -- AI-EMP (5): 6 minutes, longer than the runtime's own 4-minute wait for a chat answer.
  dl := now() + interval '6 minutes';
  insert into agent_run(org_id, agent_id, event_id, lane, model, reserved, deadline)
  values (current_org(), me, e.id, left(coalesce(nullif(p_lane, ''), m.lane), 40), left(coalesce(p_model, ''), 80), m.run_reserve, dl) returning id into rid;
  update agent_event set state = 'dispatching', run_id = rid, lease_token = null, lease_until = null, reason = null where id = e.id;
  -- AI-EMP (1): its approver writing to it directly is answered directly.
  select kind into ch_kind from chat_channel where id = msg.channel_id;
  approver := coalesce(m.approver_person_id, m.owner_person_id);
  mode := agent_mode_for(m, e.event_type);
  if mode = 'off' and e.event_type = 'chat.group' and agent_group_role(me, msg.channel_id) = 'coordinator' then mode := 'approve'; end if;
  if mode = 'approve' and ch_kind = 'direct' and msg.author_id = approver then mode := 'own'; end if;
  return jsonb_build_object('status', 'dispatched', 'runId', rid, 'reserved', m.run_reserve,
    'deadline', to_char(dl at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'context', jsonb_build_object(
      'mode', mode, 'kind', e.event_type, 'askerIsApprover', msg.author_id = approver, 'groupRole', agent_group_role(me, msg.channel_id),
      'approver', (select display_name from person where id = approver),
      -- AI-EMP (4)
      'now', to_char(now() at time zone org_time_zone(), 'FMDay DD Mon YYYY, HH24:MI'), 'timeZone', org_time_zone(),
      -- AI-EMP (2)
      'newer', exists(select 1 from agent_event e2 join chat_message x2 on x2.id = e2.subject_id
                       where e2.org_id = current_org() and e2.agent_id = me and e2.id <> e.id and e2.subject_type = 'message'
                         and e2.state in ('queued', 'leased') and x2.channel_id = msg.channel_id and x2.removed_at is null
                         and x2.created_at > msg.created_at),
      'instructions', left(m.instructions, 8000), 'sops', to_jsonb(m.sop_links),
      'memory', (select coalesce(jsonb_agg(left(x.body, 400) order by x.created_at desc), '[]'::jsonb) from (
                  select body, created_at from agent_memory where agent_id = me and retired_at is null order by created_at desc limit 20) x),
      'message', (select jsonb_build_object('id', x.id, 'channelId', x.channel_id, 'parentId', x.parent_id, 'body', left(x.body, 2000),
                    'author', p.display_name, 'channelKind', ch.kind, 'channelName', case when ch.kind = 'direct' then null else ch.name end)
                  from chat_message x join person p on p.id = x.author_id join chat_channel ch on ch.id = x.channel_id where x.id = msg.id),
      -- AI-EMP (3): no empty messages (cards), none of its own proposal cards.
      'recent', (select coalesce(jsonb_agg(r.j order by r.at), '[]'::jsonb) from (
                  select x.created_at at, jsonb_build_object('author', p.display_name, 'byAgent', p.side = 'agent', 'mine', x.author_id = me,
                           'body', left(x.body, 600)) j
                    from chat_message x join person p on p.id = x.author_id
                   where x.channel_id = msg.channel_id and x.removed_at is null and x.kind = 'text' and x.created_at <= msg.created_at
                     and btrim(coalesce(x.body, '')) <> ''
                     and not exists(select 1 from agent_proposal pr where pr.dm_message_id = x.id)
                   order by x.created_at desc limit 14) r)));
end $function$;
