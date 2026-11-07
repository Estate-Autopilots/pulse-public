-- migrate:up
-- PERSONAL-WORKSPACE (owner, 6 Nov 2026: "A personal brand org is not a company"; "EVERY person has their own personal
-- workspace"). Three things:
--
--  1. An organisation is a company or a personal workspace (pulse.org.kind). A personal workspace belongs to one Pulse
--     account (pulse.org.personal_account) and is private: only its owner is a member until they invite someone. Its
--     screens drop the company and agency framing (client delivery, packages, fulfilment, foundations, waiting on the
--     client, team load, owner labels) and use personal words (My projects, Goals, This week, Focus).
--     pulse.personal_workspace_ensure(account) makes one (the platform's audited tools/admin/personal-workspaces.py
--     backfills every account; pulse.personal_workspace_mine() makes the signed-in person's own on first open from the
--     organisation switcher); pulse.personal_workspace_adopt(org, account) turns an existing one-person organisation into
--     that account's personal workspace. Nothing here notifies anyone.
--  2. A project has an explicit type (pulse.work_project.project_type): client delivery (the fulfilment of a client
--     package), internal (the organisation's own work) or personal. A company can mark a project internal (it stops being
--     client delivery, and its client-delivery panels go); a personal workspace's projects are personal and never client
--     delivery. pulse.work_project_type_set(project, type) changes it, by whoever manages the project.
--  3. pulse.account_me() marks each organisation's kind, and the account's own personal workspace ("mine") first; the
--     one-password prompt no longer counts the personal workspace as another company.

-- ------------------------------------------------------------------------------------------------ 1. organisation kind
alter table pulse.org add column kind text not null default 'company' check (kind in ('company', 'personal'));
alter table pulse.org add column personal_account uuid references pulse_priv.pulse_account(id) on delete set null;
alter table pulse.org add constraint org_personal_account_kind check (personal_account is null or kind = 'personal');
create unique index org_personal_account on pulse.org(personal_account) where personal_account is not null;

-- The kind of the request's organisation ('company' when unknown).
create function pulse.org_kind() returns text
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select kind from org where id = current_org()), 'company')
$$;
revoke all on function pulse.org_kind() from public;
grant execute on function pulse.org_kind() to pulse_api, pulse_worker;

-- ------------------------------------------------------------------------------------------------ 2. project type
alter table pulse.work_project add column project_type text not null default 'internal'
  check (project_type in ('client_delivery', 'internal', 'personal'));
update pulse.work_project set project_type = case when kind = 'fulfilment' then 'client_delivery' else 'internal' end
 where project_type is distinct from case when kind = 'fulfilment' then 'client_delivery' else 'internal' end;

-- The type follows the kind: a fulfilment is client delivery; anything else is personal in a personal workspace, and
-- otherwise keeps its own choice (internal, or personal when a company person marked it so), never client delivery.
create function pulse.work_project_type_follow() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if new.kind = 'fulfilment' then new.project_type := 'client_delivery';
  elsif (select kind from org where id = new.org_id) = 'personal' then new.project_type := 'personal';
  elsif new.project_type = 'client_delivery' then new.project_type := 'internal';
  end if;
  return new;
end $$;
revoke all on function pulse.work_project_type_follow() from public;
create trigger work_project_type_follow before insert or update of kind, project_type on pulse.work_project
  for each row execute function pulse.work_project_type_follow();

-- Change a project's type. Client delivery ↔ internal moves the project between the client's package (kind client_work)
-- and the organisation's own work (kind internal), as Work → Projects already does; the change is kept in its history.
create function pulse.work_project_type_set(p_project uuid, p_type text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := task_require_viewer(); pr project%rowtype; wp work_project%rowtype; v_personal boolean := org_kind() = 'personal';
begin
  if p_type not in ('client_delivery', 'internal', 'personal') then raise exception 'Choose client delivery, internal or personal' using errcode = '22023'; end if;
  select * into wp from work_project where org_id = current_org() and project_id = p_project for update;
  if not found then raise exception 'Project not found' using errcode = 'P0002'; end if;
  if not work_project_can_manage(p_project) then raise exception 'Only the project owner, the head of its team or leadership can change its type' using errcode = '42501'; end if;
  if v_personal and p_type <> 'personal' then raise exception 'A personal workspace keeps personal projects only' using errcode = '22023'; end if;
  select * into pr from project where org_id = current_org() and id = p_project for update;
  if p_type = 'client_delivery' and pr.kind <> 'client_work' then
    update project set kind = 'client_work', updated_at = now() where id = p_project;
  elsif p_type <> 'client_delivery' and pr.kind = 'client_work' then
    update project set kind = 'internal', updated_at = now() where id = p_project;
  end if;
  update work_project set project_type = p_type, updated_by = me, updated_at = now() where project_id = p_project;
  if wp.project_type is distinct from p_type then
    insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
    values (current_org(), 'project', p_project, 'project_type', wp.project_type, p_type, me);
  end if;
  perform audit_write('work_project_type_set', 'project', p_project::text);
  return jsonb_build_object('id', p_project, 'type', (select project_type from work_project where project_id = p_project));
end $$;
revoke all on function pulse.work_project_type_set(uuid, text) from public;
grant execute on function pulse.work_project_type_set(uuid, text) to pulse_api;

-- ------------------------------------------------------------------------------------------------ personal workspaces
-- An account's own private workspace: the organisation (kind personal, no public handle), the person (admin and
-- leadership of it), the seat, no attendance, Tasks on and Chats and Finance off until they turn them on, the business
-- model "internal" (no client sections), and the personal space's setup. Returns the existing one when there is one.
create function pulse.personal_workspace_ensure(p_account uuid) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a pulse_priv.pulse_account%rowtype; v_org uuid; v_person uuid; v_code text; v_letters text; k int := 0; v_slug text; n text;
begin
  select * into a from pulse_priv.pulse_account where id = p_account for update;
  if not found then raise exception 'No such Pulse account' using errcode = 'P0002'; end if;
  select id into v_org from org where personal_account = p_account;
  if v_org is not null then return v_org; end if;
  v_org := gen_random_uuid();
  n := left(btrim(a.display_name), 80);
  v_letters := upper(regexp_replace(n, '[^A-Za-z]', '', 'g')) || 'MEXYZ';
  v_code := left(upper(regexp_replace(initcap(n), '[^A-Z]', '', 'g')) || substr(v_letters, 2), 3);
  if length(v_code) < 2 then v_code := left(v_letters, 3); end if;
  while exists (select 1 from org where code = v_code) loop
    k := k + 1; v_code := left(v_code, 2) || chr(65 + ((k - 1) % 26)) || case when k > 26 then chr(65 + ((k - 1) / 26 - 1) % 26) else '' end;
    if k > 700 then raise exception 'Could not find a free organisation code' using errcode = '54000'; end if;
  end loop;
  v_slug := 'me-' || replace(a.handle, '.', '-');
  while exists (select 1 from org where slug = v_slug) loop v_slug := v_slug || 'x'; end loop;

  perform acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'Pulse account @' || a.handle, true);
  insert into org(id, slug, name, code, handle, status, kind, personal_account) values (v_org, v_slug, n, v_code, null, 'active', 'personal', p_account);
  -- Private: no public @handle (org_handle_default suggests one for every new organisation; it is given back).
  update org set handle = null where id = v_org;
  delete from pulse_priv.handle_name where kind = 'org' and ref = v_org;
  insert into hr_policy(org_id, attendance_enabled) values (v_org, false) on conflict (org_id) do update set attendance_enabled = false;
  insert into org_module(org_id, module, enabled) values (v_org, 'tasks', true), (v_org, 'chats', false), (v_org, 'finance', false);
  insert into work_settings(org_id, business_model) values (v_org, 'internal') on conflict (org_id) do update set business_model = 'internal';
  insert into org_setup(org_id, space, home) values (v_org, 'personal', '/tasks') on conflict (org_id) do nothing;
  insert into person(org_id, display_name, side, status, active_from) values (v_org, a.display_name, 'staff', 'active', current_date) returning id into v_person;
  insert into people_profile(org_id, person_id, role, email, username, user_no, evidence, field_sources)
  values (v_org, v_person, 'Owner', a.email, a.handle, 1, 'Personal workspace of @' || a.handle, '{}');
  insert into role_assignment(org_id, person_id, role_key, valid_from) values (v_org, v_person, 'admin', current_date), (v_org, v_person, 'leadership', current_date);
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (v_org, 'person', v_person, 'created', null, 'Personal workspace made for a Pulse account', null);
  perform set_config('pulse.viewer_id', v_person::text, true);
  perform audit_write('personal_workspace_create', 'org', v_org::text);
  perform acct_leave();
  insert into pulse_priv.account_member(account_id, member_org, person_id, kind) values (p_account, v_org, v_person, 'staff');
  return v_org;
end $$;
revoke all on function pulse.personal_workspace_ensure(uuid) from public;

-- The signed-in person's own personal workspace, made on first open (the organisation switcher's "My workspace").
create function pulse.personal_workspace_mine() returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer();
begin
  if current_viewer() is null or v is null then raise exception 'A personal workspace belongs to a Pulse account: sign in with yours' using errcode = '42501'; end if;
  return personal_workspace_ensure(v);
end $$;
revoke all on function pulse.personal_workspace_mine() from public;
grant execute on function pulse.personal_workspace_mine() to pulse_api;

-- An existing organisation becomes an account's personal workspace (the platform's tools only): the account must hold a
-- staff seat in it, and nobody else may sign in to it. Its projects become personal (client packages become its own
-- work); nothing is deleted.
create function pulse.personal_workspace_adopt(p_org uuid, p_account uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org%rowtype; v_person uuid; n_projects int; n_others int;
begin
  -- Inside the organisation (its own row security), as every write below.
  perform acct_enter(p_org, null);
  select * into o from org where id = p_org;
  if not found then raise exception 'No such organisation' using errcode = 'P0002'; end if;
  if o.personal_account is not null and o.personal_account <> p_account then raise exception 'That organisation is someone else''s personal workspace' using errcode = '42501'; end if;
  if exists (select 1 from org where personal_account = p_account and id <> p_org) then raise exception 'That account already has a personal workspace' using errcode = '23505'; end if;
  select person_id into v_person from pulse_priv.account_member where account_id = p_account and member_org = p_org and kind = 'staff';
  if v_person is null then raise exception 'The account has no staff seat in that organisation' using errcode = '42501'; end if;
  select count(*) into n_others from pulse_priv.account_member where member_org = p_org and account_id <> p_account and kind <> 'agent';
  if n_others > 0 then raise exception 'Other people sign in to that organisation: it is a company, not a personal workspace' using errcode = '42501'; end if;
  perform set_config('pulse.viewer_id', v_person::text, true);
  update org set kind = 'personal', personal_account = p_account where id = p_org;
  insert into org_setup(org_id, space, home) values (p_org, 'personal', '/tasks') on conflict (org_id) do nothing;
  insert into work_settings(org_id, business_model) values (p_org, 'internal') on conflict (org_id) do update set business_model = 'internal';
  update project set kind = 'internal', updated_at = now() where org_id = p_org and kind = 'client_work';
  update work_project set project_type = 'personal', updated_at = now() where org_id = p_org and project_type <> 'personal';
  select count(*) into n_projects from work_project where org_id = p_org;
  perform audit_write('personal_workspace_adopt', 'org', p_org::text);
  perform acct_leave();
  return jsonb_build_object('org', p_org, 'projects', n_projects);
end $$;
revoke all on function pulse.personal_workspace_adopt(uuid, uuid) from public;

-- ------------------------------------------------------------------------------------------------ 3. the switcher
create or replace function pulse.account_me() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v uuid := account_of_viewer(); a record; r record; v_suggest text;
begin
  if current_viewer() is null then return null; end if;
  if v is null then
    select p.display_name, pp.username into r from person p left join people_profile pp on pp.person_id = p.id where p.id = current_viewer();
    v_suggest := handle_suggest(coalesce(nullif(replace(coalesce(r.username, ''), '.', ''), ''), r.display_name));
    return jsonb_build_object('account', null, 'suggestion', v_suggest,
      'orgs', jsonb_build_array((select jsonb_build_object('id', o.id, 'name', o.name, 'handle', o.handle, 'code', o.code, 'kind', 'staff', 'current', true,
        'orgKind', o.kind, 'mine', false) from org o where o.id = current_org())),
      'invites', '[]'::jsonb, 'unify', false, 'personal', null);
  end if;
  select * into a from pulse_priv.pulse_account where id = v;
  return jsonb_build_object(
    'account', jsonb_build_object('id', a.id, 'handle', a.handle, 'name', a.display_name, 'email', a.email, 'hasPassword', a.password_hash is not null),
    -- PERSONAL-WORKSPACE: the account's own personal workspace first, then the current one, then the most used.
    'orgs', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'handle', o.handle, 'code', o.code, 'kind', m.kind,
        'current', o.id = current_org(), 'lastUsedAt', m.last_used_at, 'install', o.id = install_org(), 'orgKind', o.kind, 'mine', o.personal_account = v)
        order by (o.personal_account is not distinct from v) desc, (o.id = current_org()) desc, m.last_used_at desc nulls last, o.name)
      from pulse_priv.account_member m join org o on o.id = m.member_org where m.account_id = v and o.status = 'active'), '[]'::jsonb),
    'personal', (select o.id from org o where o.personal_account = v and o.status = 'active'),
    'invites', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'org', o.name, 'orgHandle', o.handle, 'kind', i.kind, 'title', i.title, 'at', i.created_at) order by i.created_at desc)
      from pulse_priv.org_invite i join org o on o.id = i.org_id
      where i.to_handle = a.handle and i.status = 'open' and i.expires_at > now() and o.status = 'active'
        and not exists (select 1 from pulse_priv.account_member m where m.account_id = v and m.member_org = i.org_id)), '[]'::jsonb),
    -- The one-password prompt counts companies: the person's own workspace is not another place to sign in to.
    'unify', a.password_hash is null and (select count(*) from pulse_priv.account_member m join org o on o.id = m.member_org and o.status = 'active'
      where m.account_id = v and o.personal_account is distinct from v) > 1);
end $$;

-- migrate:down
-- Forward-only: organisations, their kind and their projects' types are kept.
