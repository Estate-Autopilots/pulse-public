-- migrate:up
-- R53 (PLAN P27, owner 8 Oct 2026): repeatable company setup and the owner's checklist, on UX-TENANT's wizard (0260),
-- R51's isolation and R52's connectors. Additive: nothing existing is rewritten or deleted.
--   * pulse.tenant_plan: one setup plan (company, address, defaults, modules, role template, object prefix, source
--     registry), previewed row by row and applied in one transaction. A rerun changes nothing; nothing is read from or
--     copied out of another company. pulse.tenant_spec gives a company's plan back as a setup file for the next one.
--   * pulse.org_storage: the company's own object prefix (orgs/<company id>/); R39's document store writes under it.
--   * pulse.org_source: the company's source registry (which sources it uses, who at the company grants them, which
--     data categories they bring). A connector's rights come from R52's install; a file or manual source from its
--     admin's decision; payroll, attendance history and chat history need a specific approval with a note.
--   * Trial, then activation. A company set up here opens in trial: only its admins, HR and leadership get a sign-in
--     (the same pulse.login_credential store; a guard refuses anyone else). The operator activates it for staff only
--     when every gate passes: an admin signed in with two-step verification, no ambiguous identity, every source's
--     rights, a fresh isolation check, a passed restore drill, a named operator and support route, and for a real
--     company the privacy terms and the owner's rollout instruction.
--   * pulse.org_handover: what the company's admins see of the handover. Who at the install is responsible stays on the
--     operator's own setup row; no person of one company is written into another.

alter table pulse.org add column activation text not null default 'live' check (activation in ('trial','live'));
comment on column pulse.org.activation is
  'R53: trial = only admins, HR and leadership sign in (companies set up by the wizard start here); live = everyone the company invites';

alter table pulse.tenant_setup drop constraint tenant_setup_status_check;
alter table pulse.tenant_setup add constraint tenant_setup_status_check check (status in ('draft','setup','open','live'));
-- The new company's id, chosen when the setup starts, so the preview names its object prefix exactly.
alter table pulse.tenant_setup add column reserved_org_id uuid not null default gen_random_uuid();
create unique index tenant_setup_reserved on pulse.tenant_setup(reserved_org_id);

-- --------------------------------------------------------------------------------------------- object prefix
create table pulse.org_storage (
  org_id        uuid primary key references pulse.org(id),
  object_prefix text not null unique check (object_prefix = 'orgs/' || org_id::text || '/'),
  created_at    timestamptz not null default now()
);
alter table pulse.org_storage enable row level security;
alter table pulse.org_storage force row level security;
create policy tenant on pulse.org_storage using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.org_storage to pulse_api, pulse_worker;
create trigger audit_mutation after insert or update or delete on pulse.org_storage for each row execute function pulse.audit_mutation();

-- ------------------------------------------------------------------------------------------- source registry
create function pulse.org_source_categories() returns text[] language sql immutable as $$
  select array['people','structure','projects','clients','tasks','documents','finance','attendance_history','payroll','chat_history']
$$;
-- Brought in only with the company admin's specific approval, never by default (P27 step 5).
create function pulse.org_source_sensitive() returns text[] language sql immutable as $$
  select array['attendance_history','payroll','chat_history']
$$;

create table pulse.org_source (
  org_id      uuid not null references pulse.org(id),
  id          uuid primary key default gen_random_uuid(),
  key         text not null check (key ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  kind        text not null check (kind in ('google_drive','plugin','csv','directory','manual')),
  label       text not null check (length(label) between 2 and 80),
  connector   text check (connector ~ '^[a-z][a-z0-9-]{1,39}$'),          -- R52 connector key (EA Connect or a plugin)
  categories  text[] not null default '{}' check (categories <@ pulse.org_source_categories()),
  grants      text not null default 'admin' check (grants in ('admin','hr','finance','leadership')),  -- who grants it
  decision    text not null default 'planned' check (decision in ('planned','approved','declined')),
  decided_by  uuid references pulse.person(id),
  decided_at  timestamptz,
  note        text check (length(note) between 3 and 300),
  created_by  text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (org_id, key),
  check ((kind in ('google_drive','plugin')) = (connector is not null)),
  check (kind <> 'google_drive' or connector = 'ea-connect'),
  check (kind <> 'plugin' or connector <> 'ea-connect'),
  check ((decision = 'planned') = (decided_at is null)),
  check (decision <> 'approved' or not (categories && pulse.org_source_sensitive()) or note is not null)
);
alter table pulse.org_source enable row level security;
alter table pulse.org_source force row level security;
create policy tenant on pulse.org_source using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.org_source to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.org_source for each row execute function pulse.audit_mutation();

-- A registry entry from a plan or the company admin: problems in words (empty when it is fine) and the clean entry.
create function pulse.org_source_clean(s jsonb) returns jsonb
  language plpgsql immutable set search_path = pulse, pg_temp as $$
declare
  v_key text := lower(btrim(coalesce(s ->> 'key', ''))); v_kind text := btrim(coalesce(s ->> 'kind', ''));
  v_label text := regexp_replace(btrim(coalesce(s ->> 'label', '')), '\s+', ' ', 'g');
  v_connector text := nullif(lower(btrim(coalesce(s ->> 'connector', ''))), '');
  v_grants text := coalesce(nullif(btrim(coalesce(s ->> 'grants', '')), ''), 'admin');
  v_cats text[] := '{}'; v_problems text[] := '{}';
begin
  if jsonb_typeof(s) <> 'object' then return jsonb_build_object('problems', jsonb_build_array('A source is an object with a key, kind and label')); end if;
  if jsonb_typeof(s -> 'categories') = 'array' then
    v_cats := array(select distinct x from jsonb_array_elements_text(s -> 'categories') x order by x);
  elsif s ? 'categories' and jsonb_typeof(s -> 'categories') <> 'null' then
    v_problems := array_append(v_problems, 'Categories are a list'::text);
  end if;
  if v_kind = 'google_drive' and v_connector is null then v_connector := 'ea-connect'; end if;
  if v_key !~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' then v_problems := array_append(v_problems, 'A source key is 3 to 40 lowercase letters, digits or dashes'::text); end if;
  if v_kind not in ('google_drive','plugin','csv','directory','manual') then
    v_problems := array_append(v_problems, 'A source is google_drive, plugin, csv, directory or manual'::text);
  end if;
  if length(v_label) not between 2 and 80 then v_problems := array_append(v_problems, 'Give each source a name of 2 to 80 characters'::text); end if;
  if v_kind = 'google_drive' and v_connector <> 'ea-connect' then v_problems := array_append(v_problems, 'Google Drive is read by EA Connect'::text); end if;
  if v_kind = 'plugin' and (v_connector is null or v_connector = 'ea-connect' or v_connector !~ '^[a-z][a-z0-9-]{1,39}$') then
    v_problems := array_append(v_problems, 'A plugin source names its connector key'::text);
  end if;
  if v_kind in ('csv','directory','manual') then v_connector := null; end if;
  if not (v_cats <@ org_source_categories()) then
    v_problems := array_append(v_problems, ('Categories are ' || array_to_string(org_source_categories(), ', '))::text);
  end if;
  if v_grants not in ('admin','hr','finance','leadership') then v_problems := array_append(v_problems, 'The source is granted by admin, hr, finance or leadership'::text); end if;
  return jsonb_build_object('problems', to_jsonb(v_problems), 'source', jsonb_build_object('key', v_key, 'kind', v_kind, 'label', v_label,
    'connector', v_connector, 'categories', to_jsonb(v_cats), 'grants', v_grants));
end $$;

-- Whether one registry entry is ready: a connector's install, key, grant and approved roots (R52), or the admin's decision.
create function pulse.org_source_view(s pulse.org_source) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare
  i connector_install%rowtype; v_sensitive text[] := array(select unnest(s.categories) intersect select unnest(org_source_sensitive()) order by 1);
  v_ready boolean := false; v_why text; v_install jsonb; v_roots int := 0;
begin
  if s.decision = 'declined' then
    v_ready := true; v_why := 'Not used by this company';
  elsif s.kind in ('google_drive','plugin') then
    select * into i from connector_install where org_id = s.org_id and connector_key = s.connector and status = 'active' order by approved_at desc nulls last limit 1;
    if not found then
      v_why := case when exists (select 1 from connector_install where org_id = s.org_id and connector_key = s.connector and status = 'preview')
        then 'Installed, waiting for the admin''s grant in Settings, Connected sources, Connectors'
        else 'Not installed yet: the company admin installs it in Settings, Connected sources, Connectors' end;
    else
      select count(*) into v_roots from connector_source cs where cs.install_id = i.id and cs.status = 'approved' and cs.entities && i.granted_entities;
      v_install := jsonb_build_object('id', i.id, 'status', i.status, 'keyInstalled', i.credential_fingerprint is not null,
        'missingEntities', to_jsonb(array(select unnest(connector_entity_types(i.manifest)) except select unnest(i.granted_entities) order by 1)),
        'approvedRoots', v_roots);
      if i.credential_fingerprint is null then v_why := 'Its key is not installed on the server yet (the platform operator''s step, owner errand E13)';
      elsif not (connector_entity_types(i.manifest) <@ i.granted_entities) then v_why := 'Not everything it delivers is granted yet';
      elsif v_roots = 0 then v_why := 'No shared drive or folder approved yet';
      elsif cardinality(v_sensitive) > 0 and s.decision <> 'approved' then v_why := 'It brings ' || array_to_string(v_sensitive, ', ') || ': the admin approves that specifically';
      else v_ready := true; v_why := 'Granted: ' || v_roots || case when v_roots = 1 then ' root approved' else ' roots approved' end;
      end if;
    end if;
  elsif s.decision = 'approved' then
    v_ready := true; v_why := 'Approved by the company admin';
  else
    v_why := 'Waiting for the company admin''s approval';
  end if;
  return jsonb_build_object('id', s.id, 'key', s.key, 'kind', s.kind, 'label', s.label, 'connector', s.connector,
    'categories', to_jsonb(s.categories), 'sensitive', to_jsonb(v_sensitive), 'grants', s.grants, 'decision', s.decision,
    'decidedAt', s.decided_at, 'note', s.note, 'install', v_install, 'ready', v_ready, 'why', v_why);
end $$;

-- ------------------------------------------------------------------------------------------------- handover
create table pulse.org_handover (
  org_id           uuid primary key references pulse.org(id),
  operator_named   boolean not null default false,       -- who it is stays on the operator's own setup row
  support_route    text check (length(support_route) between 3 and 200),
  restore_on       date,
  restore_minutes  int check (restore_minutes between 1 and 10080),
  restore_result   text check (restore_result in ('passed','failed')),
  restore_isolated boolean,
  restore_ref      text check (length(restore_ref) between 3 and 200),
  terms_ref        text check (length(terms_ref) between 3 and 200),    -- E08: privacy notice and processor terms
  rollout_ref      text check (length(rollout_ref) between 3 and 200),  -- E18: the owner's rollout instruction
  isolation_at     timestamptz,
  isolation_tables int,
  isolation_leaks  int,
  activated_at     timestamptz,
  updated_at       timestamptz not null default now(),
  check ((restore_on is null) = (restore_result is null))
);
alter table pulse.org_handover enable row level security;
alter table pulse.org_handover force row level security;
create policy tenant on pulse.org_handover using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.org_handover to pulse_api;
create trigger audit_mutation after insert or update or delete on pulse.org_handover for each row execute function pulse.audit_mutation();

-- ---------------------------------------------------------------------------------------------- trial guard
-- While a company is in trial only its admins, HR and leadership get a sign-in. One guard on the existing sign-in store
-- (credentials and sessions) and on the invitations that lead there; nothing new holds a password.
create function pulse.trial_sign_in_guard() returns trigger
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  v_new jsonb := to_jsonb(new); v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_org uuid := (v_new ->> 'org_id')::uuid; v_person uuid := (v_new ->> tg_argv[0])::uuid; v_ok boolean; v_prev text;
begin
  if tg_table_name = 'login_credential' then
    if v_new ->> 'status' <> 'active' or coalesce(v_old ->> 'status', '') = 'active' then return new; end if;
  elsif tg_table_name = 'staff_invitation' then
    if not ((v_new ->> 'token_hash' is not null and v_new ->> 'token_hash' is distinct from v_old ->> 'token_hash')
            or (v_new ->> 'status' in ('sending','sent') and v_new ->> 'status' is distinct from v_old ->> 'status')) then return new; end if;
  elsif tg_table_name = 'auth_link' then
    if v_new ->> 'kind' <> 'invite' or v_new ->> 'realm' <> 'staff' or v_new ->> 'used_at' is not null
       or v_new ->> 'token_hash' is not distinct from v_old ->> 'token_hash' then return new; end if;
  end if;
  if (select activation from org where id = v_org) is distinct from 'trial' then return new; end if;
  v_prev := current_setting('pulse.org_id', true);
  perform set_config('pulse.org_id', v_org::text, true);
  v_ok := exists (select 1 from role_assignment where org_id = v_org and person_id = v_person and role_key in ('admin','hr','leadership')
                   and current_date between valid_from and coalesce(valid_to, 'infinity'));
  perform set_config('pulse.org_id', coalesce(v_prev, ''), true);
  if not v_ok then
    raise exception 'This company is still in its trial: until the platform operator activates it for staff, only its admins, HR and leadership can sign in'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function pulse.trial_sign_in_guard() from public;
create trigger trial_sign_in before insert or update of status on pulse.login_credential
  for each row execute function pulse.trial_sign_in_guard('person_id');
create trigger trial_sign_in before insert on pulse.login_session
  for each row execute function pulse.trial_sign_in_guard('person_id');
create trigger trial_sign_in before insert or update of token_hash, status on pulse_priv.staff_invitation
  for each row execute function pulse.trial_sign_in_guard('person_id');
create trigger trial_sign_in before insert or update of token_hash on pulse_priv.auth_link
  for each row execute function pulse.trial_sign_in_guard('actor');

-- -------------------------------------------------------------------------------------------- the setup plan
create function pulse.setup_action(p_area text, p_key text, p_item text, p_table text, p_before text, p_after text, p_create boolean)
  returns jsonb language sql immutable as $$
  select jsonb_build_object('area', p_area, 'key', p_key, 'item', p_item, 'table', p_table, 'before', p_before, 'after', p_after,
    'action', case when p_create then 'create' when p_before is not distinct from p_after then 'keep' else 'update' end)
$$;

-- p: { company: {name, slug, code, timeZone, dataRegion, host, rehearsal}, modules: {tasks, chats, finance, attendance},
--      rules: [{role, action, scope}], sources: [{key, kind, label, connector?, categories?, grants?}] }.
-- A part left out keeps what the company has (or Pulse's starting value for a new company). Preview (p_apply false)
-- writes nothing; apply runs exactly the previewed rows in this one transaction and returns them.
create function pulse.tenant_plan(p_setup uuid, p jsonb, p_apply boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  v_setup tenant_setup%rowtype; v_org org%rowtype; v_host text; v_new boolean; v_open boolean := false;
  c jsonb := coalesce(p -> 'company', '{}'); v_c jsonb; v_check jsonb; v_cur jsonb := '{}';
  v_problems jsonb := '[]'; v_warnings jsonb := '[]'; v_actions jsonb := '[]'; v_target uuid; v_prefix text;
  v_mods jsonb := '{}'; v_mod text; v_want boolean; v_have boolean; v_rule jsonb; v_rules jsonb := '{}'; v_role text; v_act text; v_scope text;
  v_src jsonb; v_clean jsonb; v_seen text[] := '{}'; v_srcs jsonb := '[]'; v_cur_src jsonb; v_a jsonb; v_sens text[];
  v_op_org uuid; v_viewer uuid; v_actor text; v_summary jsonb;
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p, 'null')) <> 'object' or jsonb_typeof(c) <> 'object' then raise exception 'A setup plan is an object with a company part' using errcode = '22023'; end if;
  if p_apply then select * into v_setup from tenant_setup where id = p_setup for update;
  else select * into v_setup from tenant_setup where id = p_setup; end if;
  if not found then raise exception 'Setup not found' using errcode = 'P0002'; end if;
  v_new := v_setup.target_org_id is null;
  v_target := coalesce(v_setup.target_org_id, v_setup.reserved_org_id);

  -- What the company has now (inside it, read only).
  if not v_new then
    perform tenant_enter(p_setup, false);
    select * into v_org from org where id = current_org();
    select host into v_host from org_domain where org_id = current_org() and is_primary;
    v_cur := jsonb_build_object(
      'modules', org_modules(),
      'rules', (select coalesce(jsonb_object_agg(role || ':' || action, scope), '{}') from work_rule where org_id = current_org()),
      'prefix', (select object_prefix from org_storage where org_id = current_org()),
      'sources', (select coalesce(jsonb_object_agg(key, jsonb_build_object('kind', kind, 'label', label, 'connector', connector,
                    'categories', to_jsonb(categories), 'grants', grants)), '{}') from org_source where org_id = current_org()),
      'hrPolicy', exists (select 1 from hr_policy where org_id = current_org()),
      'twoStep', exists (select 1 from pulse_priv.auth_policy where org_id = current_org()),
      'categories', (select count(*) from work_category where org_id = current_org()),
      'handover', exists (select 1 from org_handover where org_id = current_org()));
    perform tenant_leave();
    v_open := v_org.status <> 'setup';
  end if;

  -- The company part: what is asked, over what it has.
  v_c := jsonb_build_object(
    'name', regexp_replace(btrim(coalesce(c ->> 'name', v_org.name, v_setup.name)), '\s+', ' ', 'g'),
    'slug', lower(btrim(coalesce(c ->> 'slug', v_org.slug, ''))), 'code', upper(btrim(coalesce(c ->> 'code', v_org.code, ''))),
    'timeZone', btrim(coalesce(c ->> 'timeZone', v_org.time_zone, '')), 'dataRegion', coalesce(nullif(c ->> 'dataRegion', ''), v_org.data_region, 'in'),
    'host', lower(split_part(btrim(coalesce(c ->> 'host', v_host, '')), ':', 1)),
    'rehearsal', case when v_new then coalesce((c ->> 'rehearsal')::boolean, false) else v_org.rehearsal end);
  v_check := tenant_company_check(p_setup, v_c);
  v_problems := v_check -> 'problems'; v_warnings := v_check -> 'warnings';
  if v_open then v_problems := v_problems || '["This company is open: its own admins change it in their Settings"]'::jsonb; end if;
  if not v_new and c ? 'rehearsal' and (c ->> 'rehearsal')::boolean is distinct from v_org.rehearsal then
    v_problems := v_problems || '["Rehearsal is fixed once the company is created"]'::jsonb;
  end if;

  -- Modules: asked, else what it has, else Pulse's start (tasks, chats and finance on; attendance off until HR is ready).
  if p ? 'modules' and (jsonb_typeof(p -> 'modules') <> 'object' or exists (select 1 from jsonb_each(p -> 'modules') e
       where e.key not in ('tasks','chats','finance','attendance') or jsonb_typeof(e.value) <> 'boolean')) then
    v_problems := v_problems || '["Modules are tasks, chats, finance and attendance, each on or off"]'::jsonb;
  end if;
  foreach v_mod in array array['tasks','chats','finance','attendance'] loop
    v_have := case when v_new then null else (v_cur -> 'modules' ->> v_mod)::boolean end;
    v_want := coalesce(case when jsonb_typeof(p -> 'modules' -> v_mod) = 'boolean' then (p -> 'modules' ->> v_mod)::boolean end, v_have, v_mod <> 'attendance');
    v_mods := v_mods || jsonb_build_object(v_mod, v_want);
  end loop;

  -- Who can do what: asked, else what it has, else the default (the first choice the database allows).
  if p ? 'rules' and (jsonb_typeof(p -> 'rules') <> 'array' or jsonb_array_length(p -> 'rules') > 20) then
    v_problems := v_problems || '["Rules are a list of up to 20 role, action and scope choices"]'::jsonb;
  elsif p ? 'rules' then
    for v_rule in select value from jsonb_array_elements(p -> 'rules') loop
      if not coalesce(v_rule ->> 'scope' = any(coalesce(work_rule_options(v_rule ->> 'role', v_rule ->> 'action'), '{}')), false) then
        v_problems := v_problems || jsonb_build_array('Rule ' || coalesce(v_rule ->> 'role', '?') || ' ' || coalesce(v_rule ->> 'action', '?') || ': that choice is not available');
      else
        v_rules := v_rules || jsonb_build_object((v_rule ->> 'role') || ':' || (v_rule ->> 'action'), v_rule ->> 'scope');
      end if;
    end loop;
  end if;

  -- Sources: each entry checked; duplicates in the plan refused.
  if p ? 'sources' and (jsonb_typeof(p -> 'sources') <> 'array' or jsonb_array_length(p -> 'sources') > 30) then
    v_problems := v_problems || '["Sources are a list of up to 30"]'::jsonb;
  elsif p ? 'sources' then
    for v_src in select value from jsonb_array_elements(p -> 'sources') loop
      v_clean := org_source_clean(v_src);
      v_problems := v_problems || (v_clean -> 'problems');
      if jsonb_array_length(v_clean -> 'problems') = 0 then
        if (v_clean -> 'source' ->> 'key') = any(v_seen) then
          v_problems := v_problems || jsonb_build_array('Source ' || (v_clean -> 'source' ->> 'key') || ' is listed twice');
        else
          v_seen := array_append(v_seen, v_clean -> 'source' ->> 'key'); v_srcs := v_srcs || jsonb_build_array(v_clean -> 'source');
        end if;
      end if;
    end loop;
  end if;

  -- The rows, in the order they are written.
  v_actions := jsonb_build_array(
    setup_action('company', 'company.name', 'Name', 'pulse.org', v_org.name, v_c ->> 'name', v_new),
    setup_action('company', 'company.slug', 'Short name', 'pulse.org', v_org.slug, v_c ->> 'slug', v_new),
    setup_action('company', 'company.code', 'Code', 'pulse.org', v_org.code, v_c ->> 'code', v_new),
    setup_action('company', 'company.timeZone', 'Time zone', 'pulse.org', v_org.time_zone, v_c ->> 'timeZone', v_new),
    setup_action('company', 'company.dataRegion', 'Data kept in', 'pulse.org', v_org.data_region, v_c ->> 'dataRegion', v_new),
    setup_action('company', 'company.rehearsal', 'Rehearsal', 'pulse.org', v_org.rehearsal::text, (v_c ->> 'rehearsal'), v_new),
    setup_action('company', 'company.status', 'Status', 'pulse.org', case when v_new then null else v_org.status || ', ' || v_org.activation end,
                 case when v_new then 'being set up; opens in trial (admins, HR and leadership only)' else v_org.status || ', ' || v_org.activation end, v_new),
    setup_action('address', 'address.host', 'Web address', 'pulse.org_domain', v_host, v_c ->> 'host', v_new),
    setup_action('address', 'address.signIn', 'Sign-in', 'pulse.org_domain', case when v_new then null else 'Pulse passwords' end, 'Pulse passwords', v_new),
    setup_action('defaults', 'defaults.hrPolicy', 'HR policy', 'pulse.hr_policy',
                 case when (v_cur ->> 'hrPolicy')::boolean then 'present' end, case when (v_cur ->> 'hrPolicy')::boolean then 'present'
                 else 'Pulse''s starting shift and week, not yet confirmed by HR' end, not coalesce((v_cur ->> 'hrPolicy')::boolean, false)),
    setup_action('defaults', 'defaults.twoStep', 'Two-step verification', 'pulse_priv.auth_policy',
                 case when (v_cur ->> 'twoStep')::boolean then 'present' end, case when (v_cur ->> 'twoStep')::boolean then 'present'
                 else 'required for admins, HR and leadership after 14 days' end, not coalesce((v_cur ->> 'twoStep')::boolean, false)),
    jsonb_build_object('area', 'defaults', 'key', 'defaults.categories', 'item', 'Work categories', 'table', 'pulse.work_category', 'action', 'none',
      'before', null, 'after', case when coalesce((v_cur ->> 'categories')::int, 0) > 0 then (v_cur ->> 'categories') || ' categories'
                                    else 'Pulse''s starting list, added with the first task or category (UX-TASKS-2)' end),
    setup_action('defaults', 'defaults.handover', 'Handover record', 'pulse.org_handover',
                 case when (v_cur ->> 'handover')::boolean then 'present' end, case when (v_cur ->> 'handover')::boolean then 'present'
                 else 'empty until the operator names the support route and restore drill' end, not coalesce((v_cur ->> 'handover')::boolean, false)));
  foreach v_mod in array array['tasks','chats','finance','attendance'] loop
    v_actions := v_actions || jsonb_build_array(setup_action('modules', 'module.' || v_mod, initcap(v_mod),
      case when v_mod = 'attendance' then 'pulse.hr_policy' else 'pulse.org_module' end,
      case when v_new then null when (v_cur -> 'modules' ->> v_mod)::boolean then 'on' else 'off' end,
      case when (v_mods ->> v_mod)::boolean then 'on' else 'off' end, v_new));
  end loop;
  v_actions := v_actions || jsonb_build_array(jsonb_build_object('area', 'roles', 'key', 'roles.template', 'item', 'Roles', 'table', null,
    'action', 'none', 'before', null, 'after', 'Admin, HR, Leadership, Finance, Pod manager and Member: the same roles in every company; nobody holds one until you add people'));
  foreach v_role in array array['hr','pod_head','member'] loop
    foreach v_act in array array['task.assign','task.ask','project.create'] loop
      v_scope := coalesce(v_rules ->> (v_role || ':' || v_act), v_cur -> 'rules' ->> (v_role || ':' || v_act), (work_rule_options(v_role, v_act))[1]);
      v_actions := v_actions || jsonb_build_array(setup_action('roles', 'rule.' || v_role || ':' || v_act, initcap(replace(v_role, '_', ' ')) || ': ' || v_act,
        'pulse.work_rule', v_cur -> 'rules' ->> (v_role || ':' || v_act), v_scope, (v_cur -> 'rules' ->> (v_role || ':' || v_act)) is null));
    end loop;
  end loop;
  v_prefix := 'orgs/' || v_target::text || '/';
  v_actions := v_actions || jsonb_build_array(setup_action('storage', 'storage.prefix', 'Object prefix', 'pulse.org_storage',
    v_cur ->> 'prefix', v_prefix, (v_cur ->> 'prefix') is null));
  for v_src in select value from jsonb_array_elements(v_srcs) loop
    v_cur_src := v_cur -> 'sources' -> (v_src ->> 'key');
    v_sens := array(select jsonb_array_elements_text(v_src -> 'categories') intersect select unnest(org_source_sensitive()) order by 1);
    v_actions := v_actions || jsonb_build_array(setup_action('sources', 'source.' || (v_src ->> 'key'), v_src ->> 'label', 'pulse.org_source',
      v_cur_src::text, (v_src - 'key')::text, v_cur_src is null) || jsonb_build_object('source', v_src, 'needsApproval', to_jsonb(v_sens)));
  end loop;
  -- Sources the company has that this plan does not name stay as they are (a plan never removes anything).
  v_actions := v_actions || (select coalesce(jsonb_agg(jsonb_build_object('area', 'sources', 'key', 'source.' || e.key, 'item', e.value ->> 'label',
      'table', 'pulse.org_source', 'action', 'keep', 'before', (e.value)::text, 'after', (e.value)::text) order by e.key), '[]')
    from jsonb_each(coalesce(v_cur -> 'sources', '{}')) e where not (e.key = any(v_seen)));
  v_actions := v_actions || jsonb_build_array(jsonb_build_object('area', 'copied', 'key', 'copied.none', 'item', 'From another company', 'table', null,
    'action', 'none', 'before', null, 'after', 'Nothing: no people, projects, clients, tasks, files, rules or credentials are read or copied'));

  v_summary := jsonb_build_object(
    'create', (select count(*) from jsonb_array_elements(v_actions) a where a ->> 'action' = 'create'),
    'update', (select count(*) from jsonb_array_elements(v_actions) a where a ->> 'action' = 'update'),
    'keep', (select count(*) from jsonb_array_elements(v_actions) a where a ->> 'action' = 'keep'));

  if jsonb_array_length(v_problems) > 0 or not p_apply then
    return jsonb_build_object('ok', jsonb_array_length(v_problems) = 0, 'problems', v_problems, 'warnings', v_warnings, 'applied', false,
      'orgId', v_target, 'new', v_new, 'actions', v_actions, 'summary', v_summary, 'creates', v_check -> 'creates');
  end if;

  -- Apply: exactly the rows above, all or nothing (the caller's one transaction).
  v_op_org := current_org(); v_viewer := current_viewer(); v_actor := coalesce(current_setting('pulse.actor_account', true), '');
  if v_new then
    perform pg_advisory_xact_lock(hashtext('tenant-create'));
    v_check := tenant_company_check(p_setup, v_c);                -- again, under the lock
    if not (v_check ->> 'ok')::boolean then raise exception '%', v_check -> 'problems' ->> 0 using errcode = '22023'; end if;
    perform set_config('pulse.org_id', v_target::text, true);
    perform set_config('pulse.viewer_id', '', true);
    perform set_config('pulse.actor_account', 'Pulse setup', true);
    insert into org(id, slug, name, code, time_zone, data_region, status, rehearsal, activation)
    values (v_target, v_c ->> 'slug', v_c ->> 'name', v_c ->> 'code', v_c ->> 'timeZone', v_c ->> 'dataRegion', 'setup', (v_c ->> 'rehearsal')::boolean, 'trial');
    insert into org_domain(host, org_id, sign_in, is_primary, added_by) values (v_c ->> 'host', v_target, 'password', true, 'Pulse setup');
    insert into hr_policy(org_id, attendance_enabled) values (v_target, (v_mods ->> 'attendance')::boolean);
    insert into org_module(org_id, module, enabled) values (v_target, 'tasks', (v_mods ->> 'tasks')::boolean),
      (v_target, 'chats', (v_mods ->> 'chats')::boolean), (v_target, 'finance', (v_mods ->> 'finance')::boolean);
    insert into pulse_priv.auth_policy(org_id, required, grace_until) values (v_target, true, now() + interval '14 days');
    insert into org_handover(org_id) values (v_target);
    insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
    values (v_target, 'org', v_target, 'created', null, 'Set up in Pulse by the platform operator', null);
    perform set_config('pulse.org_id', v_op_org::text, true);
    perform set_config('pulse.viewer_id', coalesce(v_viewer::text, ''), true);
    perform set_config('pulse.actor_account', v_actor, true);
    update tenant_setup set target_org_id = v_target, status = 'setup', name = v_c ->> 'name', updated_at = now() where id = p_setup;
    perform tenant_enter(p_setup, true);
  else
    perform tenant_enter(p_setup, true);
    update org set name = v_c ->> 'name', slug = v_c ->> 'slug', code = v_c ->> 'code', time_zone = v_c ->> 'timeZone', data_region = v_c ->> 'dataRegion'
     where id = current_org() and (name, slug, code, time_zone, data_region) is distinct from (v_c ->> 'name', v_c ->> 'slug', v_c ->> 'code', v_c ->> 'timeZone', v_c ->> 'dataRegion');
    update org_domain set host = v_c ->> 'host' where org_id = current_org() and is_primary and host <> v_c ->> 'host';
    insert into hr_policy(org_id) values (current_org()) on conflict (org_id) do nothing;
    insert into pulse_priv.auth_policy(org_id, required, grace_until) values (current_org(), true, now() + interval '14 days') on conflict do nothing;
    insert into org_handover(org_id) values (current_org()) on conflict do nothing;
    foreach v_mod in array array['tasks','chats','finance','attendance'] loop
      perform org_module_write(v_mod, (v_mods ->> v_mod)::boolean);            -- records its own change; no-op when equal
    end loop;
  end if;
  for v_a in select value from jsonb_array_elements(v_actions) where value ->> 'action' in ('create','update') loop
    if v_a ->> 'area' = 'roles' then
      insert into work_rule(org_id, role, action, scope, updated_by)
      values (current_org(), split_part(substr(v_a ->> 'key', 6), ':', 1), split_part(substr(v_a ->> 'key', 6), ':', 2), v_a ->> 'after', null)
      on conflict (org_id, role, action) do update set scope = excluded.scope, updated_by = null, updated_at = now();
    elsif v_a ->> 'area' = 'storage' then
      insert into org_storage(org_id, object_prefix) values (current_org(), v_a ->> 'after');
    elsif v_a ->> 'area' = 'sources' then
      v_src := v_a -> 'source';
      insert into org_source(org_id, key, kind, label, connector, categories, grants, created_by)
      values (current_org(), v_src ->> 'key', v_src ->> 'kind', v_src ->> 'label', v_src ->> 'connector',
              array(select jsonb_array_elements_text(v_src -> 'categories')), v_src ->> 'grants', 'Pulse setup')
      on conflict (org_id, key) do update set kind = excluded.kind, label = excluded.label, connector = excluded.connector,
        categories = excluded.categories, grants = excluded.grants, updated_at = now();
    end if;
    if v_a ->> 'area' not in ('modules') and not (v_new and v_a ->> 'area' in ('company','address')) then
      insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
      values (current_org(), 'org', current_org(), 'setup.' || (v_a ->> 'key'), left(v_a ->> 'before', 500), left(v_a ->> 'after', 500), null);
    end if;
  end loop;
  perform tenant_leave();
  update tenant_setup set name = v_c ->> 'name', updated_at = now() where id = p_setup;
  perform tenant_step(p_setup, 'company', jsonb_build_object('host', v_c ->> 'host'));
  perform tenant_step(p_setup, 'plan', v_summary || jsonb_build_object('spec', md5(p::text)));
  return jsonb_build_object('ok', true, 'problems', '[]'::jsonb, 'warnings', v_warnings, 'applied', true, 'orgId', v_target, 'new', v_new,
    'actions', v_actions, 'summary', v_summary, 'creates', v_check -> 'creates');
end $$;
revoke all on function pulse.tenant_plan(uuid, jsonb, boolean) from public;
grant execute on function pulse.tenant_plan(uuid, jsonb, boolean) to pulse_api;

-- The wizard's company step is the plan's company part (one creation path).
create or replace function pulse.tenant_company(p_setup uuid, p jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r jsonb := tenant_plan(p_setup, jsonb_build_object('company', p - 'check'), true);
begin
  if not (r ->> 'applied')::boolean then raise exception '%', r -> 'problems' ->> 0 using errcode = '22023'; end if;
  return (r ->> 'orgId')::uuid;
end $$;

-- A company's plan as a setup file: the next company starts from it (name, short name, code and address changed).
create function pulse.tenant_spec(p_setup uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v jsonb;
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  perform tenant_enter(p_setup, false);
  select jsonb_build_object('contract', 'pulse.setup.v1',
    'company', jsonb_build_object('name', o.name, 'slug', o.slug, 'code', o.code, 'timeZone', o.time_zone, 'dataRegion', o.data_region,
                                  'host', (select host from org_domain where org_id = o.id and is_primary), 'rehearsal', o.rehearsal),
    'modules', org_modules(),
    'rules', (select coalesce(jsonb_agg(jsonb_build_object('role', role, 'action', action, 'scope', scope) order by role, action), '[]') from work_rule where org_id = o.id),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'kind', kind, 'label', label, 'connector', connector,
                  'categories', to_jsonb(categories), 'grants', grants) order by key), '[]') from org_source where org_id = o.id))
    into v from org o where o.id = current_org();
  perform tenant_leave();
  return v;
end $$;
revoke all on function pulse.tenant_spec(uuid) from public;
grant execute on function pulse.tenant_spec(uuid) to pulse_api;

-- ------------------------------------------------------------------------------------- gates and the checklist
-- The current company's activation gates and the facts the guide is written from. Counts only, no names.
create function pulse.setup_gates() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare
  o org%rowtype; h org_handover%rowtype; v_sources jsonb; v_gates jsonb;
  n_admins int; n_signed int; n_two int; n_people int; n_email int; n_dup_names int; n_dup_emails int; n_src int; n_ready int;
  v_iso boolean; v_backup boolean; v_hand boolean; v_terms boolean;
begin
  select * into o from org where id = current_org();
  if not found then raise exception 'No company in scope' using errcode = '42501'; end if;
  select * into h from org_handover where org_id = o.id;
  select count(*),
         count(*) filter (where l.last_login_at is not null),
         count(*) filter (where l.last_login_at is not null and exists (select 1 from pulse_priv.auth_account x
                            where x.org_id = o.id and x.realm = 'staff' and x.actor = a.person_id and x.totp is not null))
    into n_admins, n_signed, n_two
    from (select distinct r.person_id from role_assignment r join person p on p.id = r.person_id and p.status = 'active'
           where r.org_id = o.id and r.role_key = 'admin' and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')) a
    left join login_credential l on l.person_id = a.person_id and l.status = 'active';
  select count(*), count(pp.email) into n_people, n_email
    from person p left join people_profile pp on pp.person_id = p.id where p.org_id = o.id and p.side = 'staff' and p.status = 'active';
  select count(*) into n_dup_names from (select 1 from person where org_id = o.id and side = 'staff' and status = 'active'
    group by lower(btrim(display_name)) having count(*) > 1) d;
  select count(*) into n_dup_emails from (select 1 from people_profile pp join person p on p.id = pp.person_id
    where pp.org_id = o.id and p.status = 'active' and pp.email is not null group by lower(pp.email) having count(*) > 1) d;
  select coalesce(jsonb_agg(org_source_view(s) order by s.key), '[]') into v_sources from org_source s where s.org_id = o.id;
  select count(*) filter (where x ->> 'decision' <> 'declined'), count(*) filter (where x ->> 'decision' <> 'declined' and (x ->> 'ready')::boolean)
    into n_src, n_ready from jsonb_array_elements(v_sources) x;
  v_iso := coalesce(h.isolation_leaks = 0 and h.isolation_at > now() - interval '1 hour', false);
  v_backup := coalesce(h.restore_result = 'passed' and h.restore_isolated and h.restore_on >= current_date - 90 and h.restore_ref is not null, false);
  v_hand := coalesce(h.operator_named and h.support_route is not null, false);
  v_terms := o.rehearsal or coalesce(h.terms_ref is not null and h.rollout_ref is not null, false);
  v_gates := jsonb_build_array(
    jsonb_build_object('key', 'admin', 'ok', n_two > 0, 'label', 'An admin signed in with two-step verification',
      'detail', format('%s admins: %s signed in, %s with two-step verification', n_admins, n_signed, n_two)),
    jsonb_build_object('key', 'identity', 'ok', n_people > 0 and n_dup_names = 0 and n_dup_emails = 0, 'label', 'Every person is one clear identity',
      'detail', case when n_people = 0 then 'Nobody added yet'
        when n_dup_names + n_dup_emails = 0 then format('%s people, %s with an e-mail; no shared name or e-mail', n_people, n_email)
        else format('%s names used by more than one person, %s e-mails shared', n_dup_names, n_dup_emails) end),
    jsonb_build_object('key', 'sources', 'ok', n_src > 0 and n_ready = n_src, 'label', 'Every source has its rights',
      'detail', case when n_src = 0 then 'No source registered: register the sources this company uses' else format('%s of %s sources ready', n_ready, n_src) end),
    jsonb_build_object('key', 'isolation', 'ok', v_iso, 'label', 'A fresh isolation check found nothing from another company',
      'detail', case when h.isolation_at is null then 'Not run yet'
        else format('%s tables, %s rows from another company, %s', h.isolation_tables, h.isolation_leaks,
                    case when h.isolation_at > now() - interval '1 hour' then 'within the hour' else 'over an hour ago: run it again' end) end),
    jsonb_build_object('key', 'backup', 'ok', v_backup, 'label', 'A passed restore drill in the last 90 days',
      'detail', case when h.restore_on is null then 'No restore drill recorded (owner errand E19)'
        else format('%s on %s, %s minutes, %s', h.restore_result, h.restore_on, h.restore_minutes,
                    case when h.restore_isolated then 'isolated target' else 'not an isolated target' end) end),
    jsonb_build_object('key', 'handover', 'ok', v_hand, 'label', 'A responsible operator and a support route',
      'detail', case when v_hand then 'Operator named; support: ' || h.support_route
        else concat_ws('; ', case when not coalesce(h.operator_named, false) then 'No operator named' end,
                       case when h.support_route is null then 'no support route' end) end),
    jsonb_build_object('key', 'terms', 'ok', v_terms, 'label', 'Privacy terms and the owner''s rollout instruction',
      'detail', case when o.rehearsal then 'Rehearsal: synthetic people only, so no live terms are needed'
        else concat_ws('; ', case when h.terms_ref is null then 'Privacy and processor terms not recorded (owner errand E08)' end,
                       case when h.rollout_ref is null then 'No rollout instruction from the owner recorded (E18)' end,
                       case when h.terms_ref is not null and h.rollout_ref is not null then 'Recorded' end) end));
  return jsonb_build_object(
    'company', jsonb_build_object('name', o.name, 'status', o.status, 'activation', o.activation, 'rehearsal', o.rehearsal,
      'host', (select host from org_domain where org_id = o.id and is_primary), 'prefix', (select object_prefix from org_storage where org_id = o.id)),
    'facts', jsonb_build_object('admins', n_admins, 'adminsSignedIn', n_signed, 'adminsTwoStep', n_two, 'people', n_people, 'withEmail', n_email,
      'duplicateNames', n_dup_names, 'sharedEmails', n_dup_emails, 'sources', n_src, 'sourcesReady', n_ready,
      'offices', (select count(*) from presence_office where org_id = o.id and active),
      'hrConfirmed', coalesce((select confirmed_at is not null from hr_policy where org_id = o.id), false),
      'attendance', coalesce((select attendance_enabled from hr_policy where org_id = o.id), false),
      'signIns', (select count(*) from login_credential where org_id = o.id and status = 'active'),
      'invitationsSent', (select count(*) from pulse_priv.staff_invitation where org_id = o.id and status in ('sent','used')),
      'devices', (select count(*) from native_device where org_id = o.id and revoked_at is null),
      'connectorsActive', (select count(*) from connector_install where org_id = o.id and status = 'active')),
    'sources', v_sources,
    'handover', jsonb_build_object('operatorNamed', coalesce(h.operator_named, false), 'supportRoute', h.support_route,
      'restore', case when h.restore_on is null then null else jsonb_build_object('on', h.restore_on, 'minutes', h.restore_minutes,
        'result', h.restore_result, 'isolated', h.restore_isolated, 'ref', h.restore_ref) end,
      'termsRef', h.terms_ref, 'rolloutRef', h.rollout_ref, 'isolationAt', h.isolation_at, 'activatedAt', h.activated_at),
    'gates', v_gates,
    'ready', not exists (select 1 from jsonb_array_elements(v_gates) g where not (g ->> 'ok')::boolean),
    'blocked', (select coalesce(jsonb_agg(g ->> 'label'), '[]') from jsonb_array_elements(v_gates) g where not (g ->> 'ok')::boolean));
end $$;
revoke all on function pulse.setup_gates() from public;

create function pulse.tenant_gates(p_setup uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v jsonb;
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  perform tenant_enter(p_setup, false);
  v := setup_gates();
  perform tenant_leave();
  return v || jsonb_build_object('operator', (select steps -> 'handover' -> 'operator' from tenant_setup where id = p_setup));
end $$;
revoke all on function pulse.tenant_gates(uuid) from public;
grant execute on function pulse.tenant_gates(uuid) to pulse_api;

-- The isolation check's result is also kept with the company (its admins see that it ran and what it found).
create or replace function pulse.tenant_isolation_record(p_setup uuid, p_tables int, p_leaks int, p_detail jsonb) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  perform tenant_step(p_setup, 'isolation', jsonb_build_object('tables', p_tables, 'leaks', p_leaks, 'detail', coalesce(p_detail, '[]')));
  perform tenant_enter(p_setup, false);
  insert into org_handover(org_id, isolation_at, isolation_tables, isolation_leaks) values (current_org(), now(), p_tables, p_leaks)
  on conflict (org_id) do update set isolation_at = now(), isolation_tables = p_tables, isolation_leaks = p_leaks, updated_at = now();
  perform tenant_leave();
end $$;

-- The operator's handover: { operatorId, support, restore: {on, minutes, result, isolated, ref}, termsRef, rolloutRef }.
-- A key left out stays as it is; null clears it. Works after the company opens (it changes no company setting).
create function pulse.tenant_handover(p_setup uuid, p jsonb) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare
  v_op uuid; r jsonb := p -> 'restore'; v_on date; v_min int; v_res text; v_iso boolean; v_ref text; v_step jsonb;
  v_support text := nullif(regexp_replace(btrim(coalesce(p ->> 'support', '')), '\s+', ' ', 'g'), '');
  v_terms text := nullif(btrim(coalesce(p ->> 'termsRef', '')), ''); v_rollout text := nullif(btrim(coalesce(p ->> 'rolloutRef', '')), '');
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p, 'null')) <> 'object' then raise exception 'Nothing to record' using errcode = '22023'; end if;
  if not exists (select 1 from tenant_setup where id = p_setup and target_org_id is not null) then raise exception 'Create the company first' using errcode = '22023'; end if;
  if p ? 'operatorId' and nullif(p ->> 'operatorId', '') is not null then
    if p ->> 'operatorId' !~ '^[0-9a-f-]{36}$' then raise exception 'Choose the responsible operator from this install''s own people' using errcode = '22023'; end if;
    v_op := (p ->> 'operatorId')::uuid;
    if not exists (select 1 from person where id = v_op and org_id = current_org() and side = 'staff' and status = 'active') then
      raise exception 'Choose the responsible operator from this install''s own people' using errcode = '22023';
    end if;
  end if;
  if p ? 'support' and v_support is not null and length(v_support) not between 3 and 200 then raise exception 'The support route is 3 to 200 characters' using errcode = '22023'; end if;
  if p ? 'termsRef' and v_terms is not null and length(v_terms) not between 3 and 200 then raise exception 'The terms reference is 3 to 200 characters' using errcode = '22023'; end if;
  if p ? 'rolloutRef' and v_rollout is not null and length(v_rollout) not between 3 and 200 then raise exception 'The rollout instruction reference is 3 to 200 characters' using errcode = '22023'; end if;
  if p ? 'restore' and jsonb_typeof(r) = 'object' then
    if coalesce(r ->> 'on', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Give the restore drill''s date' using errcode = '22023'; end if;
    v_on := (r ->> 'on')::date;
    if v_on > current_date then raise exception 'A restore drill is recorded after it happened' using errcode = '22023'; end if;
    if coalesce(r ->> 'minutes', '') !~ '^\d{1,5}$' or (r ->> 'minutes')::int not between 1 and 10080 then raise exception 'Give how many minutes the restore took' using errcode = '22023'; end if;
    v_min := (r ->> 'minutes')::int; v_res := r ->> 'result';
    if v_res not in ('passed','failed') then raise exception 'A restore drill passed or failed' using errcode = '22023'; end if;
    v_iso := coalesce((r ->> 'isolated')::boolean, false);
    v_ref := nullif(btrim(coalesce(r ->> 'ref', '')), '');
    if v_ref is null or length(v_ref) not between 3 and 200 then raise exception 'Say where the drill''s receipt is, 3 to 200 characters' using errcode = '22023'; end if;
  elsif p ? 'restore' and jsonb_typeof(r) <> 'null' then
    raise exception 'The restore drill is a date, minutes, result, isolated target and receipt' using errcode = '22023';
  end if;
  perform tenant_enter(p_setup, false);
  insert into org_handover(org_id) values (current_org()) on conflict do nothing;
  update org_handover set
    operator_named = case when p ? 'operatorId' then v_op is not null else operator_named end,
    support_route = case when p ? 'support' then v_support else support_route end,
    restore_on = case when p ? 'restore' then v_on else restore_on end,
    restore_minutes = case when p ? 'restore' then v_min else restore_minutes end,
    restore_result = case when p ? 'restore' then v_res else restore_result end,
    restore_isolated = case when p ? 'restore' then v_iso else restore_isolated end,
    restore_ref = case when p ? 'restore' then v_ref else restore_ref end,
    terms_ref = case when p ? 'termsRef' then v_terms else terms_ref end,
    rollout_ref = case when p ? 'rolloutRef' then v_rollout else rollout_ref end,
    updated_at = now()
   where org_id = current_org();
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'handover', null,
          (select string_agg(k, ', ' order by k) from jsonb_object_keys(p) k where k in ('operatorId','support','restore','termsRef','rolloutRef')), null);
  perform tenant_leave();
  v_step := coalesce((select steps -> 'handover' from tenant_setup where id = p_setup), '{}') - 'at';
  if p ? 'operatorId' then v_step := v_step || jsonb_build_object('operator', v_op); end if;
  perform tenant_step(p_setup, 'handover', v_step);
end $$;
revoke all on function pulse.tenant_handover(uuid, jsonb) from public;
grant execute on function pulse.tenant_handover(uuid, jsonb) to pulse_api;

-- Activate for staff: only from trial, only once the company is open, only when every gate passes (checked here).
create function pulse.tenant_activate(p_setup uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_org org%rowtype; v_gates jsonb;
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  perform 1 from tenant_setup where id = p_setup for update;
  if not found then raise exception 'Setup not found' using errcode = 'P0002'; end if;
  perform tenant_enter(p_setup, false);
  select * into v_org from org where id = current_org();
  if v_org.status <> 'active' then
    perform tenant_leave();
    raise exception 'Open the company for sign-in first: its admin signs in and turns on two-step verification there' using errcode = '22023';
  end if;
  if v_org.activation = 'live' then perform tenant_leave(); return jsonb_build_object('activated', true, 'already', true, 'blocked', '[]'::jsonb); end if;
  v_gates := setup_gates();
  if not (v_gates ->> 'ready')::boolean then perform tenant_leave(); return jsonb_build_object('activated', false, 'blocked', v_gates -> 'blocked'); end if;
  update org set activation = 'live' where id = current_org();
  update org_handover set activated_at = now(), updated_at = now() where org_id = current_org();
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'activation', 'trial', 'live', null);
  perform tenant_leave();
  update tenant_setup set status = 'live', updated_at = now() where id = p_setup;
  perform tenant_step(p_setup, 'activate', jsonb_build_object('gates', jsonb_array_length(v_gates -> 'gates')));
  return jsonb_build_object('activated', true, 'already', false, 'blocked', '[]'::jsonb);
end $$;
revoke all on function pulse.tenant_activate(uuid) from public;
grant execute on function pulse.tenant_activate(uuid) to pulse_api;

-- The companies list shows trial or live.
create or replace function pulse.tenant_list() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_out jsonb := '[]'; s record; v_row jsonb;
begin
  if not tenant_operator() then raise exception 'Only an admin of this install''s own company sets up companies' using errcode = '42501'; end if;
  v_out := v_out || jsonb_build_array((select jsonb_build_object('setupId', null, 'own', true, 'name', o.name, 'code', o.code, 'status', o.status, 'rehearsal', o.rehearsal,
    'activation', o.activation, 'host', (select host from org_domain where org_id = o.id and is_primary),
    'people', (select count(*) from person where org_id = o.id and side = 'staff' and status = 'active'))
    from org o where o.id = current_org()));
  for s in select id, name, status, target_org_id, created_at from tenant_setup where org_id = current_org() order by created_at loop
    if s.target_org_id is null then
      v_out := v_out || jsonb_build_array(jsonb_build_object('setupId', s.id, 'own', false, 'name', s.name, 'status', 'draft', 'createdAt', s.created_at));
      continue;
    end if;
    perform tenant_enter(s.id, false);
    select jsonb_build_object('setupId', s.id, 'own', false, 'name', o.name, 'code', o.code, 'status', o.status, 'rehearsal', o.rehearsal, 'createdAt', s.created_at,
      'activation', o.activation, 'host', (select host from org_domain where org_id = o.id and is_primary),
      'people', (select count(*) from person where org_id = o.id and side = 'staff' and status = 'active'),
      'signedIn', (select count(*) from login_credential where org_id = o.id and status = 'active'),
      'modules', org_modules()) into v_row from org o where o.id = current_org();
    perform tenant_leave();
    v_out := v_out || jsonb_build_array(v_row);
  end loop;
  return v_out;
end $$;

-- -------------------------------------------------------------------------------------- the company's own side
-- Its admins and HR read the checklist; managed = the company was set up here (it has a handover record).
create function pulse.company_setup_state() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if current_viewer() is null or not viewer_is('admin','hr') then raise exception 'Company admins and HR see the setup checklist' using errcode = '42501'; end if;
  if not exists (select 1 from org_handover where org_id = current_org()) then return jsonb_build_object('managed', false); end if;
  return setup_gates() || jsonb_build_object('managed', true, 'canEdit', viewer_is('admin'),
    'duplicateNames', (select coalesce(jsonb_agg(n order by n), '[]') from (select min(display_name) n from person
       where org_id = current_org() and side = 'staff' and status = 'active' group by lower(btrim(display_name)) having count(*) > 1 limit 50) d),
    'sharedEmails', (select coalesce(jsonb_agg(names order by names), '[]') from (select string_agg(p.display_name, ' and ' order by p.display_name) names
       from people_profile pp join person p on p.id = pp.person_id where pp.org_id = current_org() and p.status = 'active' and pp.email is not null
       group by lower(pp.email) having count(*) > 1 limit 50) d));
end $$;
revoke all on function pulse.company_setup_state() from public;
grant execute on function pulse.company_setup_state() to pulse_api;

create function pulse.company_source_add(p jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_clean jsonb := org_source_clean(coalesce(p, '{}')); v_id uuid; s jsonb := v_clean -> 'source';
begin
  if current_viewer() is null or not viewer_is('admin') then raise exception 'Company admins register sources' using errcode = '42501'; end if;
  if not exists (select 1 from org_handover where org_id = current_org()) then raise exception 'This company was not set up with the checklist' using errcode = '22023'; end if;
  if jsonb_array_length(v_clean -> 'problems') > 0 then raise exception '%', v_clean -> 'problems' ->> 0 using errcode = '22023'; end if;
  if exists (select 1 from org_source where org_id = current_org() and key = s ->> 'key') then raise exception 'A source with this key is already registered' using errcode = '22023'; end if;
  insert into org_source(org_id, key, kind, label, connector, categories, grants, created_by)
  values (current_org(), s ->> 'key', s ->> 'kind', s ->> 'label', s ->> 'connector', array(select jsonb_array_elements_text(s -> 'categories')),
          s ->> 'grants', 'admin') returning id into v_id;
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'source.' || (s ->> 'key'), null, 'registered', current_viewer());
  return v_id;
end $$;
revoke all on function pulse.company_source_add(jsonb) from public;
grant execute on function pulse.company_source_add(jsonb) to pulse_api;

-- approved / declined / planned (undecided again). Payroll, attendance history and chat history need a note.
create function pulse.company_source_decide(p_id uuid, p_decision text, p_note text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s org_source%rowtype; v_note text := nullif(regexp_replace(btrim(coalesce(p_note, '')), '\s+', ' ', 'g'), '');
begin
  if current_viewer() is null or not viewer_is('admin') then raise exception 'Company admins decide on sources' using errcode = '42501'; end if;
  select * into s from org_source where id = p_id and org_id = current_org() for update;
  if not found then raise exception 'Source not found' using errcode = 'P0002'; end if;
  if p_decision not in ('approved','declined','planned') then raise exception 'Approve, decline or reopen the source' using errcode = '22023'; end if;
  if v_note is not null and length(v_note) not between 3 and 300 then raise exception 'The note is 3 to 300 characters' using errcode = '22023'; end if;
  if p_decision = 'approved' and s.categories && org_source_sensitive() and v_note is null then
    raise exception 'This source brings payroll, attendance history or chat history: say what was approved and by whom in the note' using errcode = '22023';
  end if;
  update org_source set decision = p_decision, decided_by = case when p_decision = 'planned' then null else current_viewer() end,
    decided_at = case when p_decision = 'planned' then null else now() end, note = coalesce(v_note, case when p_decision = 'planned' then null else note end), updated_at = now()
   where id = p_id;
  insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
  values (current_org(), 'org', current_org(), 'source.' || s.key, s.decision, p_decision, current_viewer());
end $$;
revoke all on function pulse.company_source_decide(uuid, text, text) from public;
grant execute on function pulse.company_source_decide(uuid, text, text) to pulse_api;

-- migrate:down
-- Forward-only: setup records, registries and activations must remain auditable.
