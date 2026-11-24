-- migrate:up
-- CHAT-GROUPS (owner report EA #4, 28 Oct 2026: "a proper internal team communication … category or something to manage
-- internal groups … the experience of making a new group nicer, who can make a group and who cannot, and who can add
-- whom, by hierarchy … a group request sent to a higher official … a way to discuss the bugs and issues inside Pulse".
-- The plan was written on 28 Oct; the owner said "Yes, build it" on 22 Nov 2026). Additive: existing groups are not
-- rewritten; a group's category is read from what Pulse already knows until someone files it.
--   chat_category       a company's own categories, beside five built-in ones (Announcements, Projects, Teams, Clients,
--                       Bugs and support). Leadership and admins add, rename or take away their own.
--   chat_group_meta     a group's category, icon and colour, who may add people (admins, or every member) and who may
--                       post (everyone, or admins only: an announcements group; replies in a thread stay open).
--   chat_group_policy   the company setting "Who may make groups": leadership only / managers / everyone (the default,
--                       as before). Enforced in chat_group_create itself, so the app, API v1 and people intake obey it.
--   chat_group_request  someone who may not make a group asks for one; an approver (leadership, or a manager for the
--                       "managers" setting, the person's own manager first) approves (the group is made with the asker as
--                       its admin) or declines. Approvers hear it on the bell; the asker hears the answer.
--   chat_bug_link       a report from Report a bug posted into the company's "Bugs and support" group (one per company,
--                       made the first time anyone opens Chats; its team is the company's staff, and people who join the
--                       company later; someone who leaves it is not put back), with its screenshot when the reporter
--                       chooses. The talk about a bug happens in that message's thread.
--   chat_project_group  a project's group: the team chat already linked to the project is reused; else one is made and
--                       linked (never a second one).
-- Who sees: a group's meta with the group (its members, admins and leadership, as chat_group_info). Notifications are
-- the chat's own (muting a group mutes its bug posts; mentions and replies still come).

-- 1 ---------------------------------------------------------------------------------------------- the vocabulary
create function pulse.chat_group_icons() returns text[] language sql immutable as $$
  select array['hash','users','folder-kanban','briefcase','bug','megaphone','building-2','palette','camera','film','pen-tool','truck','wallet','life-buoy','sparkles','calendar']
$$;
create function pulse.chat_group_colours() returns text[] language sql immutable as $$
  select array['slate','blue','green','amber','red','violet','teal','pink']
$$;
create function pulse.chat_builtin_categories() returns table (key text, name text, icon text, colour text, place int)
  language sql immutable as $$
  values ('announcements', 'Announcements', 'megaphone', 'violet', 10), ('projects', 'Projects', 'folder-kanban', 'blue', 20),
         ('teams', 'Teams', 'users', 'green', 30), ('clients', 'Clients', 'briefcase', 'amber', 40), ('bugs', 'Bugs and support', 'bug', 'red', 50)
$$;

create table pulse.chat_category (
  org_id uuid not null references pulse.org(id),
  key text not null check (key ~ '^c-[a-z0-9]{8}$'),
  name text not null check (length(btrim(name)) between 2 and 40),
  icon text not null default 'hash' check (icon = any (pulse.chat_group_icons())),
  colour text not null default 'slate' check (colour = any (pulse.chat_group_colours())),
  place int not null default 100 check (place between 0 and 10000),
  created_by uuid,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (org_id, key)
);

create table pulse.chat_group_meta (
  org_id uuid not null,
  channel_id uuid primary key,
  category text check (category is null or category ~ '^(announcements|projects|teams|clients|bugs|c-[a-z0-9]{8})$'),
  icon text check (icon is null or icon = any (pulse.chat_group_icons())),
  colour text check (colour is null or colour = any (pulse.chat_group_colours())),
  adders text not null default 'admins' check (adders in ('admins', 'members')),
  posting text not null default 'everyone' check (posting in ('everyone', 'admins')),
  autojoin_at timestamptz,                                   -- Bugs and support: staff who joined the company after this are added
  project_id uuid references pulse.project(id) on delete set null,   -- a project's team chat made by chat_project_group
  updated_by uuid,
  updated_at timestamptz not null default now(),
  foreign key (org_id, channel_id) references pulse.chat_channel (org_id, id) on delete cascade
);

create table pulse.chat_group_policy (
  org_id uuid primary key references pulse.org(id),
  creators text not null default 'everyone' check (creators in ('leaders', 'managers', 'everyone')),
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create table pulse.chat_group_request (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references pulse.person(id),
  name text not null check (length(btrim(name)) between 2 and 60),
  description text not null default '' check (length(description) <= 300),
  meta jsonb not null default '{}' check (jsonb_typeof(meta) = 'object' and length(meta::text) <= 400),
  members uuid[] not null default '{}' check (cardinality(members) <= 256),
  note text check (length(note) <= 300),
  approvers uuid[] not null default '{}' check (cardinality(approvers) <= 20),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  decision_note text check (length(decision_note) <= 300),
  channel_id uuid,
  created_at timestamptz not null default now()
);
create index chat_group_request_open on pulse.chat_group_request (org_id, status, created_at);

create table pulse.chat_bug_link (
  org_id uuid not null,
  report_id uuid primary key references pulse.reported_bug(id) on delete cascade,
  channel_id uuid not null,
  message_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, channel_id) references pulse.chat_channel (org_id, id) on delete cascade
);

do $$
declare t text;
begin
  foreach t in array array['chat_category', 'chat_group_meta', 'chat_group_policy', 'chat_group_request', 'chat_bug_link'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant_isolation on pulse.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
    execute format('revoke all on pulse.%I from public', t);
    execute format('grant select on pulse.%I to pulse_api', t);
    execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()', t);
  end loop;
end $$;
-- What a person reads directly: a group's meta with the group; requests they asked for or decide; the company lists.
create policy sees on pulse.chat_group_meta as restrictive for select to pulse_api using (pulse.chat_group_sees(channel_id));
create policy sees on pulse.chat_bug_link as restrictive for select to pulse_api using (pulse.chat_has(channel_id));
create policy sees on pulse.chat_group_request as restrictive for select to pulse_api
  using (requested_by = pulse.current_viewer() or pulse.current_viewer() = any (approvers) or pulse.viewer_is('admin', 'leadership'));
-- An AI employee never changes the company's group settings or categories (as chat_group_access, 1098).
create trigger ea_ai_no_delete before delete on pulse.chat_group_policy for each statement execute function pulse.agent_guard();
create trigger ea_ai_no_write before insert or update on pulse.chat_group_policy for each statement execute function pulse.agent_guard();
create trigger ea_ai_no_delete before delete on pulse.chat_category for each statement execute function pulse.agent_guard();
create trigger ea_ai_no_write before insert or update on pulse.chat_category for each statement execute function pulse.agent_guard();
select pulse.check_values_add('pulse.notification'::regclass, 'notification_subject_type_check', 'subject_type', array['chat_group_request']);

-- 2 ------------------------------------------------------------------------------------------- who is who here
-- Leadership: admins and leadership. Managers: they, HR, and anyone who manages people (someone reports to them, they
-- head a pod, or they hold a unit's manager role: as manages() and work_head_pods() read it).
create function pulse.chat_viewer_leads() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select chat_active() and agent_session() is null and viewer_is('admin', 'leadership')
$$;
create function pulse.chat_person_manages(p_person uuid) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists (select 1 from people_profile x where x.org_id = current_org() and x.manager_id = p_person)
      or exists (select 1 from hr_pod h where h.org_id = current_org() and h.head_id = p_person)
      or exists (select 1 from role_assignment r where r.org_id = current_org() and r.person_id = p_person
                  and (r.is_manager_of_unit or r.role_key in ('manager', 'pgs', 'head_pgs', 'hr', 'admin', 'leadership'))
                  and current_date between r.valid_from and coalesce(r.valid_to, 'infinity'))
$$;
create function pulse.chat_group_creators() returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select creators from chat_group_policy where org_id = current_org()), 'everyone')
$$;
create function pulse.chat_group_may_create() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select chat_active() and agent_session() is null and case chat_group_creators()
    when 'everyone' then true
    when 'managers' then viewer_is('admin', 'leadership', 'hr') or chat_person_manages(current_viewer())
    else viewer_is('admin', 'leadership') end
$$;
create function pulse.chat_group_refusal() returns text language sql stable security definer set search_path = pulse, pg_temp as $$
  select case chat_group_creators() when 'managers' then 'In this company managers and leadership make groups. Ask for one instead.'
    else 'In this company leadership makes groups. Ask for one instead.' end
$$;

create function pulse.chat_group_policy_set(p_creators text) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare was text;
begin
  if not chat_viewer_leads() then
    raise exception 'Only an organisation admin or leadership changes who may make groups' using errcode = '42501'; end if;
  if p_creators is null or p_creators not in ('leaders', 'managers', 'everyone') then
    raise exception 'Choose leadership only, managers, or everyone' using errcode = '22023'; end if;
  insert into chat_group_policy (org_id) values (current_org()) on conflict (org_id) do nothing;
  select creators into was from chat_group_policy where org_id = current_org() for update;
  if was is distinct from p_creators then
    update chat_group_policy set creators = p_creators, changed_by = current_viewer(), changed_at = now() where org_id = current_org();
    insert into record_change (org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
      values (current_org(), 'org', current_org(), 'chat_group_creators', was, p_creators, current_viewer());
  end if;
  return p_creators;
end $$;

-- 3 ------------------------------------------------------------------------------------------------- categories
create function pulse.chat_category_valid(p_key text) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select p_key is not null and (exists (select 1 from chat_builtin_categories() b where b.key = p_key)
    or exists (select 1 from chat_category c where c.org_id = current_org() and c.key = p_key and c.archived_at is null))
$$;
create function pulse.chat_categories() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', key, 'name', name, 'icon', icon, 'colour', colour, 'builtin', builtin) order by place, name), '[]')
  from (select key, name, icon, colour, place, true builtin from chat_builtin_categories()
        union all select key, name, icon, colour, place, false from chat_category where org_id = current_org() and archived_at is null) c
$$;
-- Leadership and admins: {name, icon, colour} adds one; {id, name?, icon?, colour?, archived?} changes one of the company's own.
create function pulse.chat_category_set(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare k text := nullif(p->>'id', ''); n text := regexp_replace(btrim(coalesce(p->>'name', '')), '\s+', ' ', 'g'); r chat_category;
begin
  if not chat_viewer_leads() then raise exception 'Only an organisation admin or leadership changes the group categories' using errcode = '42501'; end if;
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Nothing to change' using errcode = '22023'; end if;
  if k is not null and exists (select 1 from chat_builtin_categories() b where b.key = k) then
    raise exception 'The built-in categories always stay' using errcode = '22023'; end if;
  if p ? 'icon' and not (p->>'icon' = any (chat_group_icons())) then raise exception 'Choose one of the icons' using errcode = '22023'; end if;
  if p ? 'colour' and not (p->>'colour' = any (chat_group_colours())) then raise exception 'Choose one of the colours' using errcode = '22023'; end if;
  if k is null then
    if length(n) not between 2 and 40 then raise exception 'Name the category (2 to 40 characters)' using errcode = '22023'; end if;
    if (select count(*) from chat_category where org_id = current_org() and archived_at is null) >= 12 then
      raise exception 'A company keeps up to 12 categories of its own' using errcode = '22023'; end if;
    if exists (select 1 from chat_categories() x, jsonb_array_elements(x) e where lower(e->>'name') = lower(n)) then
      raise exception 'There is a category with that name already' using errcode = '22023'; end if;
    insert into chat_category (org_id, key, name, icon, colour, place, created_by)
      values (current_org(), 'c-' || substr(md5(gen_random_uuid()::text), 1, 8), n, coalesce(p->>'icon', 'hash'), coalesce(p->>'colour', 'slate'),
              100 + (select count(*) from chat_category where org_id = current_org()), current_viewer())
      returning * into r;
  else
    select * into r from chat_category where org_id = current_org() and key = k for update;
    if r.key is null then raise exception 'Category not found' using errcode = '22023'; end if;
    if p ? 'name' and length(n) not between 2 and 40 then raise exception 'Name the category (2 to 40 characters)' using errcode = '22023'; end if;
    update chat_category set name = case when p ? 'name' then n else name end, icon = coalesce(p->>'icon', icon), colour = coalesce(p->>'colour', colour),
      archived_at = case when p ? 'archived' then case when (p->>'archived')::boolean then coalesce(archived_at, now()) end else archived_at end
      where org_id = current_org() and key = k returning * into r;
  end if;
  return jsonb_build_object('id', r.key, 'name', r.name, 'icon', r.icon, 'colour', r.colour, 'archived', r.archived_at is not null);
end $$;

-- A group's category, from what it is filed under, else what Pulse knows of it: the company's Bugs and support group;
-- pods, teams and Google groups; a client's group (the groups hub's Client type or people outside the company in it); a
-- project's group; a group the hub types internal, pod or team. Else none ("Other groups").
create function pulse.chat_category_of(p_kind text, p_key text, p_set text, p_gkind text, p_project uuid, p_client uuid, p_client_side boolean)
  returns text language sql immutable as $$
  select case
    when p_kind = 'direct' then null
    when p_set is not null then p_set
    when p_key = 'custom:bugs-support' then 'bugs'
    when p_kind in ('pod', 'team', 'group') then 'teams'
    when p_gkind = 'client' or coalesce(p_client_side, false) then 'clients'
    when p_project is not null then 'projects'
    when p_client is not null then 'clients'
    when p_gkind in ('pod', 'team', 'internal') then 'teams'
  end
$$;
-- The list's facts for every group in the viewer's chat list, in one pass (Chats reads it once per list).
create function pulse.chat_list_groups() returns table (channel_id uuid, category text, icon text, colour text, adders text, posting text,
  gkind text, project_id uuid, client_id uuid)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  with ch as (select c.id from chat_list_channels() c where c.kind <> 'direct'),
  cats as (select key from chat_category where org_id = current_org() and archived_at is null)
  select ch.id, case when gm.category like 'c-%' and gm.category not in (select key from cats) then null else gm.category end,
    gm.icon, gm.colour, coalesce(gm.adders, 'admins'), coalesce(gm.posting, 'everyone'), gi.kind, gi.project_id, gi.client_id
  from ch left join chat_group_meta gm on gm.channel_id = ch.id
    left join chat_group_info gi on gi.org_id = current_org() and gi.channel_id = ch.id
$$;
create function pulse.chat_group_category(p_channel uuid) returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select chat_category_of(ch.kind, ch.key, case when gm.category is not null and chat_category_valid(gm.category) then gm.category end, gi.kind, gi.project_id, gi.client_id,
    exists (select 1 from chat_member cm join person p on p.id = cm.person_id where cm.org_id = current_org() and cm.channel_id = ch.id and p.side not in ('staff', 'agent')))
  from chat_channel ch left join chat_group_meta gm on gm.channel_id = ch.id left join chat_group_info gi on gi.org_id = current_org() and gi.channel_id = ch.id
  where ch.org_id = current_org() and ch.id = p_channel and chat_group_sees(p_channel)
$$;

-- 4 ------------------------------------------------------------------------------------------- making a group
-- A group's settings from a request body: only known keys, known values (null when a key is absent).
create function pulse.chat_group_meta_clean(p jsonb) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return '{}'; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('category', 'icon', 'colour', 'adders', 'posting') then continue; end if;
    if jsonb_typeof(p->k) = 'null' then continue; end if;
    if (k = 'category' and not chat_category_valid(p->>k)) or (k = 'icon' and not (p->>k = any (chat_group_icons())))
       or (k = 'colour' and not (p->>k = any (chat_group_colours()))) or (k = 'adders' and p->>k not in ('admins', 'members'))
       or (k = 'posting' and p->>k not in ('everyone', 'admins')) then
      raise exception 'Choose a known %', case k when 'category' then 'category' when 'icon' then 'icon' when 'colour' then 'colour' else 'setting' end using errcode = '22023';
    end if;
  end loop;
  return jsonb_strip_nulls(jsonb_build_object('category', p->>'category', 'icon', p->>'icon', 'colour', p->>'colour', 'adders', p->>'adders', 'posting', p->>'posting'));
end $$;

-- The one place a group is made (as chat_group_create always did): the creator is its admin, the people are active staff
-- of this company. p_solo: a group Pulse makes may start with its creator alone (a project's group).
create function pulse.chat_group_make(p_creator uuid, p_name text, p_members uuid[], p_description text, p_meta jsonb, p_solo boolean default false)
  returns uuid language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid; n text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'); added int; m jsonb := chat_group_meta_clean(p_meta); d text := trim(coalesce(p_description, ''));
begin
  if length(n) not between 2 and 60 then raise exception 'name the group (2 to 60 characters)' using errcode = '22023'; end if;
  if length(d) > 300 then raise exception 'keep the description short (300 characters)' using errcode = '22023'; end if;
  if not p_solo and (coalesce(cardinality(p_members), 0) = 0 or cardinality(p_members) > 256) then raise exception 'add between 1 and 256 people' using errcode = '22023'; end if;
  if coalesce(cardinality(p_members), 0) > 256 then raise exception 'add between 1 and 256 people' using errcode = '22023'; end if;
  insert into chat_channel (org_id, key, name, kind, description, created_by) values (current_org(), 'custom:' || gen_random_uuid(), n, 'custom', d, p_creator) returning id into cid;
  insert into chat_member (org_id, channel_id, person_id, role) values (current_org(), cid, p_creator, 'admin');
  insert into chat_member (org_id, channel_id, person_id) select current_org(), cid, p.id from person p
    where p.org_id = current_org() and p.id = any (coalesce(p_members, '{}')) and p.id <> p_creator and p.status = 'active' and p.side = 'staff' on conflict do nothing;
  get diagnostics added = row_count;
  if added = 0 and not p_solo then raise exception 'add at least one active teammate' using errcode = '22023'; end if;
  if m <> '{}' then
    insert into chat_group_meta (org_id, channel_id, category, icon, colour, adders, posting, updated_by)
      values (current_org(), cid, m->>'category', m->>'icon', m->>'colour', coalesce(m->>'adders', 'admins'),
              coalesce(m->>'posting', case when m->>'category' = 'announcements' then 'admins' else 'everyone' end), p_creator);
  end if;
  perform chat_event_line(cid, p_creator, 'created the group “' || n || '”');
  return cid;
end $$;

-- People make groups as before, when the company's setting lets them (the app, API v1 and people intake all come here).
create or replace function pulse.chat_group_create(p_name text, p_members uuid[]) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not chat_active() then raise exception 'individual staff account required' using errcode = '42501'; end if;
  if not chat_group_may_create() then raise exception '%', chat_group_refusal() using errcode = '42501'; end if;
  return chat_group_make(current_viewer(), p_name, p_members, '', '{}');
end $$;
-- {name, description, members, category, icon, colour, adders, posting} -> {id}
create function pulse.chat_group_new(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ids uuid[];
begin
  if not chat_active() then raise exception 'individual staff account required' using errcode = '42501'; end if;
  if not chat_group_may_create() then raise exception '%', chat_group_refusal() using errcode = '42501'; end if;
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Nothing to make' using errcode = '22023'; end if;
  ids := array(select x::uuid from jsonb_array_elements_text(case when jsonb_typeof(p->'members') = 'array' then p->'members' else '[]' end) x
               where x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  return jsonb_build_object('id', chat_group_make(current_viewer(), p->>'name', ids, p->>'description', p));
end $$;

-- A group's settings: its admins; and, for its category, icon and colour, admins and leadership who see it (they file
-- groups for the company). Who adds people and who posts are a group's own (groups people made only).
create function pulse.chat_group_meta_set(p_channel uuid, p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m jsonb := chat_group_meta_clean(p); v_kind text; own boolean := chat_group_admin(p_channel);
begin
  select ch.kind into v_kind from chat_channel ch where ch.org_id = current_org() and ch.id = p_channel and ch.kind <> 'direct';
  if v_kind is null or not chat_group_sees(p_channel) then raise exception 'conversation unavailable' using errcode = '42501'; end if;
  if (p ? 'adders' or p ? 'posting') and (v_kind <> 'custom' or not own) then
    raise exception 'Only the group''s admins choose who adds people and who posts' using errcode = '42501'; end if;
  if not own and not chat_viewer_leads() then raise exception 'Only the group''s admins change the group' using errcode = '42501'; end if;
  insert into chat_group_meta (org_id, channel_id, updated_by) values (current_org(), p_channel, current_viewer()) on conflict (channel_id) do nothing;
  update chat_group_meta g set
    category = case when p ? 'category' then m->>'category' else g.category end,
    icon = case when p ? 'icon' then m->>'icon' else g.icon end,
    colour = case when p ? 'colour' then m->>'colour' else g.colour end,
    adders = coalesce(m->>'adders', g.adders), posting = coalesce(m->>'posting', g.posting),
    updated_by = current_viewer(), updated_at = now()
  where g.channel_id = p_channel;
  if m ? 'posting' then perform chat_event_line(p_channel, current_viewer(), case m->>'posting' when 'admins' then 'let only admins send messages' else 'let everyone send messages' end); end if;
  if m ? 'adders' then perform chat_event_line(p_channel, current_viewer(), case m->>'adders' when 'members' then 'let every member add people' else 'let only admins add people' end); end if;
  return (select jsonb_build_object('category', chat_group_category(p_channel), 'icon', icon, 'colour', colour, 'adders', adders, 'posting', posting)
    from chat_group_meta where channel_id = p_channel);
end $$;

-- Admin roles inside a group: an admin makes a member an admin or takes it back; a group always keeps an admin.
create function pulse.chat_group_admin_set(p_channel uuid, p_person uuid, p_admin boolean) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare was text; who text;
begin
  if not chat_group_admin(p_channel) then raise exception 'only a group admin changes who the admins are' using errcode = '42501'; end if;
  select role into was from chat_member where org_id = current_org() and channel_id = p_channel and person_id = p_person for update;
  if was is null then raise exception 'Choose a member of the group' using errcode = '22023'; end if;
  if (was = 'admin') = coalesce(p_admin, false) then return; end if;
  if not coalesce(p_admin, false) and (select count(*) from chat_member where org_id = current_org() and channel_id = p_channel and role = 'admin') <= 1 then
    raise exception 'A group keeps at least one admin: make someone else an admin first' using errcode = '22023'; end if;
  if p_admin and not exists (select 1 from person where id = p_person and org_id = current_org() and side = 'staff' and status = 'active') then
    raise exception 'Only active colleagues can be admins' using errcode = '22023'; end if;
  update chat_member set role = case when p_admin then 'admin' else 'member' end where org_id = current_org() and channel_id = p_channel and person_id = p_person;
  select display_name into who from person where id = p_person;
  perform chat_event_line(p_channel, current_viewer(), case when p_admin then 'made ' || who || ' an admin' else 'removed ' || who || ' as an admin' end);
end $$;

-- Who adds people: admins (as before), or every member when the group's admins chose so. Only admins remove people.
-- (0957's definition with the admin check widened for adding.)
create or replace function pulse.chat_group_members(p_channel uuid, p_add uuid[], p_remove uuid[]) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare who record; admin boolean := chat_group_admin(p_channel);
begin
  if not admin then
    if not (chat_has(p_channel) and exists (select 1 from chat_group_meta g join chat_channel ch on ch.id = g.channel_id
              where g.channel_id = p_channel and g.adders = 'members' and ch.kind = 'custom')) then
      raise exception 'only a group admin can change members' using errcode = '42501'; end if;
    if coalesce(cardinality(p_remove), 0) > 0 then raise exception 'only a group admin can remove people' using errcode = '42501'; end if;
  end if;
  for who in insert into chat_member (org_id, channel_id, person_id) select current_org(), p_channel, p.id from person p
    where p.org_id = current_org() and p.id = any (coalesce(p_add, '{}')) and p.status = 'active'
      and (p.side = 'staff' or exists (select 1 from pulse_priv.connect_share sh join pulse_priv.org_connection oc on oc.id = sh.connection_id and oc.status = 'active'
        join pulse_priv.connect_seat s on s.connection_id = sh.connection_id and s.seat_org = sh.host_org and s.removed_at is null
        where sh.host_org = current_org() and sh.kind = 'chat' and sh.ref = p_channel and s.seat_person = p.id))
    on conflict do nothing returning person_id loop
    perform chat_event_line(p_channel, current_viewer(), 'added ' || (select display_name from person where id = who.person_id));
  end loop;
  for who in delete from chat_member where org_id = current_org() and channel_id = p_channel and person_id = any (coalesce(p_remove, '{}')) and person_id <> current_viewer() returning person_id loop
    perform chat_event_line(p_channel, current_viewer(), 'removed ' || (select display_name from person where id = who.person_id));
  end loop;
end $$;

-- Who posts: in a group whose admins chose "only admins", a member's message is refused; a reply in a thread is fine
-- (an announcement's talk happens under it). Event lines and imported history are never stopped.
create function pulse.chat_group_posting_guard() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.kind = 'text' and new.parent_id is null and new.import_ref is null
     and exists (select 1 from chat_group_meta g where g.channel_id = new.channel_id and g.posting = 'admins')
     and not exists (select 1 from chat_member m where m.channel_id = new.channel_id and m.person_id = new.author_id and m.role = 'admin') then
    raise exception 'Only the group''s admins send messages here. Reply in a thread instead.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger chat_group_posting before insert on pulse.chat_message for each row execute function pulse.chat_group_posting_guard();

-- 5 ------------------------------------------------------------------------------------------------- requests
create function pulse.chat_group_request_json(p_id uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('id', r.id, 'name', r.name, 'description', r.description, 'meta', r.meta, 'members', to_jsonb(r.members), 'note', r.note,
    'people', (select coalesce(jsonb_agg(p.display_name order by p.display_name), '[]') from person p where p.org_id = current_org() and p.id = any (r.members) and p.status = 'active'),
    'approvers', to_jsonb(r.approvers), 'status', r.status, 'requestedBy', r.requested_by, 'requestedByName', a.display_name, 'createdAt', r.created_at,
    'decidedByName', d.display_name, 'decidedAt', r.decided_at, 'decisionNote', r.decision_note, 'channelId', r.channel_id,
    'mine', r.requested_by = current_viewer(), 'canDecide', r.status = 'pending' and current_viewer() = any (r.approvers))
  from chat_group_request r join person a on a.id = r.requested_by left join person d on d.id = r.decided_by
  where r.org_id = current_org() and r.id = p_id
$$;
-- Who approves a person's request: for "managers", their own manager (when a manager) first, then leadership; for
-- "leadership only", admins and leadership. Active staff only, never the asker, at most 20.
create function pulse.chat_group_approvers(p_person uuid) returns uuid[]
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(array_agg(id order by o, name), '{}') from (
    select distinct on (p.id) p.id, p.display_name name, case when p.id = pp.manager_id then 0 else 1 end o
    from person p left join people_profile pp on pp.org_id = current_org() and pp.person_id = p_person
    where p.org_id = current_org() and p.side = 'staff' and p.status = 'active' and p.id <> p_person
      and (exists (select 1 from role_assignment r where r.org_id = current_org() and r.person_id = p.id and r.role_key in ('admin', 'leadership')
                    and current_date between r.valid_from and coalesce(r.valid_to, 'infinity'))
           or (chat_group_creators() = 'managers' and p.id = pp.manager_id))
    order by p.id, o limit 20) a
$$;
create function pulse.chat_group_request_file(p jsonb) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r chat_group_request; ids uuid[]; who uuid; asker text; n text := regexp_replace(btrim(coalesce(p->>'name', '')), '\s+', ' ', 'g');
begin
  if not chat_active() or agent_session() is not null then raise exception 'individual staff account required' using errcode = '42501'; end if;
  if chat_group_may_create() then raise exception 'You may make this group yourself: make it from New group' using errcode = '22023'; end if;
  if length(n) not between 2 and 60 then raise exception 'name the group (2 to 60 characters)' using errcode = '22023'; end if;
  if length(coalesce(p->>'description', '')) > 300 or length(coalesce(p->>'note', '')) > 300 then raise exception 'keep it short (300 characters)' using errcode = '22023'; end if;
  if exists (select 1 from chat_group_request where org_id = current_org() and requested_by = current_viewer() and status = 'pending' and lower(name) = lower(n)) then
    raise exception 'You asked for this group already: it is waiting for an answer' using errcode = '22023'; end if;
  if (select count(*) from chat_group_request where org_id = current_org() and requested_by = current_viewer() and status = 'pending') >= 5 then
    raise exception 'Five of your requests are waiting already' using errcode = '22023'; end if;
  ids := chat_group_approvers(current_viewer());
  if cardinality(ids) = 0 then raise exception 'Nobody here can approve a group yet: ask an admin to add leadership in People' using errcode = '22023'; end if;
  insert into chat_group_request (org_id, requested_by, name, description, meta, members, note, approvers)
    values (current_org(), current_viewer(), n, btrim(coalesce(p->>'description', '')), chat_group_meta_clean(p),
            array(select distinct x::uuid from jsonb_array_elements_text(case when jsonb_typeof(p->'members') = 'array' then p->'members' else '[]' end) x
                  where x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' limit 256),
            nullif(btrim(coalesce(p->>'note', '')), ''), ids)
    returning * into r;
  select display_name into asker from person where id = current_viewer();
  foreach who in array ids loop
    perform notification_emit(who, 'approval.waiting', 'chat_group_request', r.id, 'group-request:' || r.id,
      left(asker || ' asks for a new group, “' || n || '”. Approve or decline.', 200), '/chats?requests=1', 'approval', false);
  end loop;
  return chat_group_request_json(r.id);
end $$;
create function pulse.chat_group_request_decide(p_id uuid, p_approve boolean, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r chat_group_request; cid uuid;
begin
  select * into r from chat_group_request where org_id = current_org() and id = p_id for update;
  if r.id is null then raise exception 'Request not found' using errcode = '22023'; end if;
  if not chat_active() or agent_session() is not null or not (current_viewer() = any (r.approvers) or chat_viewer_leads()) then
    raise exception 'Only the people asked approve or decline this request' using errcode = '42501'; end if;
  if r.status <> 'pending' then raise exception 'This request was answered already' using errcode = '22023'; end if;
  if length(coalesce(p_note, '')) > 300 then raise exception 'keep the note short (300 characters)' using errcode = '22023'; end if;
  if coalesce(p_approve, false) then
    if not exists (select 1 from person where org_id = current_org() and id = r.requested_by and side = 'staff' and status = 'active') then
      raise exception 'The person who asked is no longer active here: decline it instead' using errcode = '22023'; end if;
    cid := chat_group_make(r.requested_by, r.name, r.members, r.description, r.meta, true);
    perform chat_event_line(cid, current_viewer(), 'approved this group' || case when nullif(btrim(p_note), '') is not null then ': ' || btrim(p_note) else '' end);
  end if;
  update chat_group_request set status = case when p_approve then 'approved' else 'declined' end, decided_by = current_viewer(), decided_at = now(),
    decision_note = nullif(btrim(coalesce(p_note, '')), ''), channel_id = cid where id = p_id returning * into r;
  update notification set read_at = coalesce(read_at, now()) where org_id = current_org() and subject_type = 'chat_group_request' and subject_id = p_id and event_type = 'approval.waiting';
  perform notification_emit(r.requested_by, 'request.decision', 'chat_group_request', r.id, 'group-request:' || r.id || ':' || r.status,
    left(case when p_approve then 'Your group “' || r.name || '” was approved. It is in Chats.' else 'Your request for “' || r.name || '” was declined' ||
      coalesce(': ' || r.decision_note, '.') end, 200), case when cid is not null then '/chats?channel=' || cid else '/chats?requests=1' end, 'approval', false);
  return chat_group_request_json(r.id);
end $$;
create function pulse.chat_group_request_withdraw(p_id uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  update chat_group_request set status = 'withdrawn', decided_at = now() where org_id = current_org() and id = p_id and requested_by = current_viewer() and status = 'pending';
  if not found then raise exception 'Only a request of yours that waits for an answer can be withdrawn' using errcode = '22023'; end if;
  update notification set read_at = coalesce(read_at, now()) where org_id = current_org() and subject_type = 'chat_group_request' and subject_id = p_id;
  return chat_group_request_json(p_id);
end $$;
-- Mine (the last 30 days) and the ones waiting on me.
create function pulse.chat_group_requests() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(chat_group_request_json(r.id) order by r.status <> 'pending', r.created_at desc), '[]')
  from chat_group_request r
  where r.org_id = current_org() and chat_active()
    and ((r.requested_by = current_viewer() and r.created_at > now() - interval '30 days') or (r.status = 'pending' and current_viewer() = any (r.approvers)))
$$;
-- The bell: an approver hears a request while it waits; the asker hears the answer.
do $$
declare definition text; changed text;
begin
  definition := pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
  changed := replace(definition, ' elsif p_type in (''request.updated'',''request.decision'',''leave.decision'',''approval.waiting'',''approval.reminder'') then',
    ' elsif p_subject=''chat_group_request'' then
  return exists(select 1 from chat_group_request r where r.org_id=current_org() and r.id=p_id
   and ((p_type=''approval.waiting'' and r.status=''pending'' and p_person=any(r.approvers))
     or (p_type=''request.decision'' and r.status in (''approved'',''declined'') and p_person=r.requested_by)));
 elsif p_type in (''request.updated'',''request.decision'',''leave.decision'',''approval.waiting'',''approval.reminder'') then');
  if changed = definition then raise exception 'notification_recipient_allowed changed shape'; end if;
  execute changed;
end $$;

-- 6 ---------------------------------------------------------------------------------------- Bugs and support
-- The company's group, made the first time anyone opens Chats (its admins: the company's admins and leadership; its
-- members: every active member of staff). People who join the company later are added on their next visit; someone who
-- left it stays out. Never fails the caller: a problem here only means no group yet.
create function pulse.chat_bugs_group_ensure() returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare cid uuid; since timestamptz; v_first uuid; heads uuid[];
begin
  if current_org() is null or not chat_active() then return null; end if;
  select id into cid from chat_channel where org_id = current_org() and key = 'custom:bugs-support';
  if cid is null then
    perform pg_advisory_xact_lock(hashtext('pulse.chat_bugs:' || current_org()::text));
    select id into cid from chat_channel where org_id = current_org() and key = 'custom:bugs-support';
  end if;
  if cid is null then
    heads := array(select p.id from person p where p.org_id = current_org() and p.side = 'staff' and p.status = 'active'
                     and exists (select 1 from role_assignment r where r.org_id = current_org() and r.person_id = p.id and r.role_key in ('admin', 'leadership')
                                  and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')) order by p.created_at, p.id);
    v_first := coalesce(heads[1], current_viewer());
    insert into chat_channel (org_id, key, name, kind, description, created_by)
      values (current_org(), 'custom:bugs-support', 'Bugs and support', 'custom',
              'Report a bug posts here, with its screenshot when you choose. Talk about each bug in its thread. Made by Vitals for the whole team.', v_first)
      returning id into cid;
    insert into chat_member (org_id, channel_id, person_id, role)
      select current_org(), cid, p.id, case when p.id = any (heads) or (cardinality(heads) = 0 and p.id = v_first) then 'admin' else 'member' end
      from person p where p.org_id = current_org() and p.side = 'staff' and p.status = 'active' on conflict do nothing;
    insert into chat_group_meta (org_id, channel_id, category, icon, colour, adders, posting, autojoin_at, updated_by)
      values (current_org(), cid, 'bugs', 'bug', 'red', 'members', 'everyone', clock_timestamp(), v_first);
    return cid;
  end if;
  select autojoin_at into since from chat_group_meta where channel_id = cid;
  if since is not null and exists (select 1 from person p where p.org_id = current_org() and p.side = 'staff' and p.status = 'active' and p.created_at > since) then
    insert into chat_member (org_id, channel_id, person_id) select current_org(), cid, p.id from person p
      where p.org_id = current_org() and p.side = 'staff' and p.status = 'active' and p.created_at > since on conflict do nothing;
    update chat_group_meta set autojoin_at = clock_timestamp() where channel_id = cid;
  end if;
  return cid;
exception when others then
  return null;
end $$;

-- A report from Report a bug, posted by its reporter (staff of this company only) into Bugs and support: the report's
-- number, screen and words, and its screenshot when p_shot. The reporter is added back to follow the talk. Once per report.
create function pulse.chat_bug_post(p_report uuid, p_shot boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare b reported_bug; cid uuid; mid uuid; f uuid; files jsonb := '[]'; shot reported_bug_file;
begin
  select * into b from reported_bug where org_id = current_org() and id = p_report;
  if b.id is null or b.person_id is distinct from current_viewer() or not chat_active() then
    raise exception 'Only the person who reported it shares a report' using errcode = '42501'; end if;
  select message_id, channel_id into mid, cid from chat_bug_link where report_id = p_report;
  if mid is not null then return jsonb_build_object('channelId', cid, 'messageId', mid); end if;
  cid := chat_bugs_group_ensure();
  if cid is null then raise exception 'Bugs and support is not available' using errcode = '55000'; end if;
  insert into chat_member (org_id, channel_id, person_id) values (current_org(), cid, current_viewer()) on conflict do nothing;
  if coalesce(p_shot, false) then
    select * into shot from reported_bug_file where report_id = p_report and kind = 'screenshot';
    if shot.report_id is not null and shot.bytes <= 5242880 then
      f := chat_file_add(cid, 'bug-' || b.number || case shot.content_type when 'image/jpeg' then '.jpg' when 'image/webp' then '.webp' else '.png' end, shot.content_type, shot.data);
      files := jsonb_build_array(jsonb_build_object('id', f, 'name', 'bug-' || b.number || case shot.content_type when 'image/jpeg' then '.jpg' when 'image/webp' then '.webp' else '.png' end, 'mime', shot.content_type));
    end if;
  end if;
  mid := chat_send(cid, left('Bug #' || b.number || ' on the ' || coalesce(nullif(initcap(replace(split_part(split_part(ltrim(b.route, '/'), '?', 1), '/', 1), '-', ' ')), ''), 'Home') || ' page' || case when b.blocks_work then ' · stops my work' else '' end || E'\n' || b.words, 4000),
                   null, files, p_report, null);
  insert into chat_bug_link (org_id, report_id, channel_id, message_id) values (current_org(), p_report, cid, mid);
  return jsonb_build_object('channelId', cid, 'messageId', mid);
end $$;

-- 7 ----------------------------------------------------------------------------------------------- the context
-- What Chats needs about groups once per list read: the categories, the company's setting and what it lets me do, the
-- requests, and the Bugs and support group (made here the first time).
create function pulse.chat_groups_context() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare bugs uuid := chat_bugs_group_ensure();
begin
  return jsonb_build_object('categories', chat_categories(), 'creators', chat_group_creators(), 'canCreate', chat_group_may_create(),
    'canChange', chat_viewer_leads(), 'bugsGroup', bugs,
    'requests', jsonb_build_object(
      'mine', (select count(*) from chat_group_request where org_id = current_org() and requested_by = current_viewer() and status = 'pending'),
      'waiting', (select count(*) from chat_group_request where org_id = current_org() and status = 'pending' and current_viewer() = any (approvers))));
end $$;

-- 8 ------------------------------------------------------------------------------------------------- projects
-- A project's group: the team chat this made for the project before (kept in chat_group_meta, which this function reads
-- whole), else a team chat linked to it by hand (the one I am in first; chat_group_info shows me the groups I may see),
-- is reused; one I am not in is named, not doubled. Else one is made in Projects (the lead, the people the plan names,
-- and me) and linked. Its lead, manager and leadership start it (project_can_run), whatever the company's setting.
create function pulse.chat_project_group(p_project uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare pr project; cid uuid; nm text; ppl uuid[];
begin
  if not chat_active() or not plan_by_person() then raise exception 'individual staff account required' using errcode = '42501'; end if;
  select * into pr from project where org_id = current_org() and id = p_project and deleted_at is null;
  if pr.id is null then raise exception 'Project not found' using errcode = '22023'; end if;
  if not project_can_run(p_project) then raise exception 'Only the project''s lead, its manager and leadership start its group' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('pulse.chat_project_group:' || p_project::text));
  select ch.id, ch.name into cid, nm from chat_group_meta gm join chat_channel ch on ch.org_id = gm.org_id and ch.id = gm.channel_id
    where gm.org_id = current_org() and gm.project_id = p_project order by ch.created_at limit 1;
  if cid is null then
  select ch.id, ch.name into cid, nm from chat_group_info g join chat_channel ch on ch.org_id = g.org_id and ch.id = g.channel_id
    where g.org_id = current_org() and g.project_id = p_project and ch.kind <> 'direct' and coalesce(g.kind, '') <> 'client'
      and not exists (select 1 from chat_member cm join person p on p.id = cm.person_id where cm.channel_id = ch.id and p.side not in ('staff', 'agent'))
    order by exists (select 1 from chat_member m where m.channel_id = ch.id and m.person_id = current_viewer()) desc, ch.created_at
    limit 1;
  end if;
  if cid is not null then
    if not chat_group_sees(cid) then raise exception 'This project has a team group already (“%”): ask its admin to add you', nm using errcode = '22023'; end if;
    return jsonb_build_object('id', cid, 'name', nm, 'made', false);
  end if;
  ppl := array(select distinct x from (
      select pr.lead_person_id x
      union all select (r.value->>'person')::uuid from project_plan pl, jsonb_each(coalesce(pl.roles, '{}')) r
        where pl.org_id = current_org() and pl.project_id = p_project and r.value ? 'person' and r.value->>'person' ~ '^[0-9a-f-]{36}$') s
    where x is not null and x <> current_viewer());
  nm := left(coalesce(nullif(btrim(pr.title), ''), pr.name), 60);
  if length(nm) < 2 then nm := 'Project ' || coalesce(pr.registry_no::text, 'group'); end if;
  cid := chat_group_make(current_viewer(), nm, ppl, 'The project''s team chat.', jsonb_build_object('category', 'projects', 'icon', 'folder-kanban', 'colour', 'blue'), true);
  update chat_group_meta set project_id = p_project where channel_id = cid;
  insert into chat_group_info (org_id, channel_id, project_id, client_id, kind, manual, updated_by)
    values (current_org(), cid, p_project, pr.client_id, 'internal', array['project', 'kind'] || case when pr.client_id is not null then array['client'] else '{}'::text[] end, current_viewer());
  perform audit_write('project_chat_link', 'project', p_project::text);
  return jsonb_build_object('id', cid, 'name', nm, 'made', true);
end $$;

-- 9 -------------------------------------------------------------------------------------------------- grants
revoke all on function pulse.chat_group_icons(), pulse.chat_group_colours(), pulse.chat_builtin_categories(), pulse.chat_viewer_leads(),
  pulse.chat_person_manages(uuid), pulse.chat_group_creators(), pulse.chat_group_may_create(), pulse.chat_group_refusal(), pulse.chat_group_policy_set(text),
  pulse.chat_category_valid(text), pulse.chat_categories(), pulse.chat_category_set(jsonb), pulse.chat_category_of(text, text, text, text, uuid, uuid, boolean),
  pulse.chat_list_groups(), pulse.chat_group_category(uuid), pulse.chat_group_meta_clean(jsonb), pulse.chat_group_make(uuid, text, uuid[], text, jsonb, boolean),
  pulse.chat_group_new(jsonb), pulse.chat_group_meta_set(uuid, jsonb), pulse.chat_group_admin_set(uuid, uuid, boolean), pulse.chat_group_posting_guard(),
  pulse.chat_group_request_json(uuid), pulse.chat_group_approvers(uuid), pulse.chat_group_request_file(jsonb), pulse.chat_group_request_decide(uuid, boolean, text),
  pulse.chat_group_request_withdraw(uuid), pulse.chat_group_requests(), pulse.chat_bugs_group_ensure(), pulse.chat_bug_post(uuid, boolean),
  pulse.chat_groups_context(), pulse.chat_project_group(uuid) from public;
grant execute on function pulse.chat_group_icons(), pulse.chat_group_colours(), pulse.chat_builtin_categories(), pulse.chat_group_creators(), pulse.chat_group_may_create(), pulse.chat_viewer_leads(),
  pulse.chat_group_policy_set(text), pulse.chat_categories(), pulse.chat_category_set(jsonb), pulse.chat_category_of(text, text, text, text, uuid, uuid, boolean),
  pulse.chat_list_groups(), pulse.chat_group_category(uuid), pulse.chat_group_new(jsonb), pulse.chat_group_meta_set(uuid, jsonb), pulse.chat_group_admin_set(uuid, uuid, boolean),
  pulse.chat_group_request_file(jsonb), pulse.chat_group_request_decide(uuid, boolean, text), pulse.chat_group_request_withdraw(uuid), pulse.chat_group_requests(),
  pulse.chat_bug_post(uuid, boolean), pulse.chat_bugs_group_ensure(), pulse.chat_groups_context(), pulse.chat_project_group(uuid) to pulse_api;
grant execute on function pulse.chat_group_create(text, uuid[]), pulse.chat_group_members(uuid, uuid[], uuid[]) to pulse_api;

-- migrate:down
drop trigger if exists chat_group_posting on pulse.chat_message;
drop function if exists pulse.chat_project_group(uuid), pulse.chat_groups_context(), pulse.chat_bug_post(uuid, boolean), pulse.chat_bugs_group_ensure(),
  pulse.chat_group_requests(), pulse.chat_group_request_withdraw(uuid), pulse.chat_group_request_decide(uuid, boolean, text), pulse.chat_group_request_file(jsonb),
  pulse.chat_group_approvers(uuid), pulse.chat_group_request_json(uuid), pulse.chat_group_posting_guard(), pulse.chat_group_admin_set(uuid, uuid, boolean),
  pulse.chat_group_meta_set(uuid, jsonb), pulse.chat_group_new(jsonb), pulse.chat_group_category(uuid), pulse.chat_list_groups(),
  pulse.chat_category_of(text, text, text, text, uuid, uuid, boolean), pulse.chat_category_set(jsonb), pulse.chat_categories(), pulse.chat_category_valid(text),
  pulse.chat_group_policy_set(text), pulse.chat_group_refusal(), pulse.chat_group_may_create(), pulse.chat_group_creators(), pulse.chat_person_manages(uuid),
  pulse.chat_viewer_leads();
drop table if exists pulse.chat_bug_link, pulse.chat_group_request, pulse.chat_group_policy, pulse.chat_group_meta, pulse.chat_category;
drop function if exists pulse.chat_builtin_categories(), pulse.chat_group_colours(), pulse.chat_group_icons();
-- chat_group_create, chat_group_make and chat_group_members keep their 2530 shape (forward-only, as every migration here).
