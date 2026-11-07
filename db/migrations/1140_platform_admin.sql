-- migrate:up
-- PULSE-ADMIN (owner, 27 Oct 2026): Pulse's own back office, run by the platform's super-admins (the owner), separate from
-- each organisation's Settings. Organisations (status, plan and limits, members, switches), people across organisations
-- (sign-in help), usage and AI tokens per organisation, the platform audit log, system health and announcements.
--
-- Who: an individual admin of the install's own organisation who is also named in pulse_priv.platform_admin. Every
-- function below checks that itself (platform_guard), so the API's check is never the only one. The tables are
-- install-level and owner-only like the account tables: no runtime grants, reached only through these functions.
-- Every look into another organisation and every change is written to pulse_priv.platform_audit (append-only) and to
-- that organisation's own Audit, so its admins see that Pulse looked and why.

create table pulse_priv.platform_admin(
  person_id uuid primary key references pulse.person(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by text not null check (length(granted_by) between 1 and 120));

create table pulse_priv.platform_audit(
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  actor_person uuid,
  actor text not null check (length(actor) between 1 and 120),
  action text not null check (action ~ '^[a-z][a-z_.]{1,59}$'),
  target_org uuid references pulse.org(id),
  target_kind text check (target_kind is null or length(target_kind) <= 40),
  target_id text check (target_id is null or length(target_id) <= 200),
  target_label text check (target_label is null or length(target_label) <= 200),
  reason text check (reason is null or length(reason) <= 400),
  detail jsonb not null default '{}');
create index platform_audit_at on pulse_priv.platform_audit(at desc);
create index platform_audit_org on pulse_priv.platform_audit(target_org, at desc);

create function pulse.platform_audit_frozen() returns trigger language plpgsql as $$
begin raise exception 'The platform audit log is append-only' using errcode = '42501'; end $$;
create trigger platform_audit_frozen before update or delete on pulse_priv.platform_audit
  for each row execute function pulse.platform_audit_frozen();

-- An organisation's plan and limits (what it pays for; usage is read against them).
create table pulse_priv.platform_plan(
  for_org uuid primary key references pulse.org(id),
  plan text not null default 'trial' check (plan in ('trial', 'starter', 'growth', 'scale', 'internal', 'custom')),
  seat_limit int check (seat_limit is null or seat_limit between 1 and 100000),
  ai_tokens_month bigint check (ai_tokens_month is null or ai_tokens_month between 1000 and 100000000000),
  trial_ends date,
  note text check (note is null or length(note) <= 400),
  updated_at timestamptz not null default now(),
  updated_by text);

-- Announcements every signed-in person (or only admins) of every organisation sees until they end.
create table pulse_priv.platform_announcement(
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 2 and 120),
  body text check (body is null or length(body) <= 1000),
  tone text not null default 'info' check (tone in ('info', 'warning', 'success')),
  audience text not null default 'everyone' check (audience in ('everyone', 'admins')),
  link text check (link is null or link ~ '^(/[^\s]{0,300}|https://[^\s]{1,300})$'),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  check (ends_at is null or ends_at > starts_at));

revoke all on pulse_priv.platform_admin, pulse_priv.platform_audit, pulse_priv.platform_plan, pulse_priv.platform_announcement from public;

-- The first platform admin: the install organisation's longest-standing individual admin (on EA's install, the owner).
-- Another install names its own through the operator API (POST /api/v1/operator/platform-admins). Person rows are read
-- inside the install's organisation: row security applies to the owner too.
select set_config('pulse.org_id', coalesce(pulse.install_org()::text, ''), true);
insert into pulse_priv.platform_admin(person_id, granted_by)
select r.person_id, 'migration 1140 (the install''s first admin)' from pulse.role_assignment r join pulse.person p on p.id = r.person_id
 where r.org_id = pulse.install_org() and r.role_key = 'admin' and p.side = 'staff' and p.status = 'active'
   and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')
 order by r.valid_from, p.created_at, p.id limit 1
on conflict do nothing;
select set_config('pulse.org_id', '', true);

-- ----------------------------------------------------------------------------------------------------- who and how
create function pulse.platform_admin() returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_org() is not null and current_org() = install_org() and current_viewer() is not null and viewer_is('admin')
     and exists (select 1 from pulse_priv.platform_admin a where a.person_id = current_viewer())
$$;
revoke all on function pulse.platform_admin() from public;
grant execute on function pulse.platform_admin() to pulse_api;

create function pulse.platform_guard() returns void
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if coalesce(current_setting('pulse.platform_return', true), '') <> '' or not platform_admin() then
    raise exception 'Only Pulse''s platform admins use the admin console' using errcode = '42501';
  end if;
end $$;
revoke all on function pulse.platform_guard() from public;

-- Read (or change) another organisation for the rest of a function, then come back. The admin's viewer id is not
-- carried in: rows changed there record "Pulse platform admin" as the actor.
create function pulse.platform_enter(p_org uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if coalesce(current_setting('pulse.platform_return', true), '') = '' then
    perform set_config('pulse.platform_return', coalesce(current_org()::text, '') || '|' || coalesce(current_viewer()::text, '') || '|'
      || coalesce(current_setting('pulse.actor_account', true), ''), true);
  end if;
  perform set_config('pulse.org_id', p_org::text, true);
  perform set_config('pulse.viewer_id', '', true);
  perform set_config('pulse.actor_account', 'Pulse platform admin', true);
end $$;
revoke all on function pulse.platform_enter(uuid) from public;

create function pulse.platform_leave() returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_back text[] := string_to_array(coalesce(current_setting('pulse.platform_return', true), ''), '|');
begin
  if coalesce(array_length(v_back, 1), 0) < 3 then raise exception 'platform_leave without platform_enter'; end if;
  perform set_config('pulse.org_id', v_back[1], true);
  perform set_config('pulse.viewer_id', v_back[2], true);
  perform set_config('pulse.actor_account', v_back[3], true);
  perform set_config('pulse.platform_return', '', true);
end $$;
revoke all on function pulse.platform_leave() from public;

create function pulse.platform_log(p_action text, p_org uuid, p_kind text, p_id text, p_label text, p_reason text, p_detail jsonb)
  returns void language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_actor uuid := current_viewer(); v_name text;
begin
  select display_name into v_name from person where id = v_actor;
  insert into pulse_priv.platform_audit(actor_person, actor, action, target_org, target_kind, target_id, target_label, reason, detail)
  values (v_actor, left(coalesce(v_name, nullif(current_setting('pulse.actor_account', true), ''), 'Pulse platform admin'), 120), p_action, p_org,
          p_kind, left(p_id, 200), left(p_label, 200), left(nullif(btrim(coalesce(p_reason, '')), ''), 400), coalesce(p_detail, '{}'));
  if p_org is not null and p_org is distinct from current_org() then
    perform platform_enter(p_org);
    insert into audit_event(org_id, actor_account, action, resource, resource_id, source, changes)
    values (p_org, 'Pulse platform admin', 'platform.' || p_action, coalesce(p_kind, 'org'), left(p_id, 200), 'platform',
            jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')));
    perform platform_leave();
  end if;
end $$;
revoke all on function pulse.platform_log(text, uuid, text, text, text, text, jsonb) from public;

create function pulse.platform_reason(p_reason text) returns text
  language plpgsql immutable set search_path = pulse, pg_temp as $$
begin
  if length(btrim(coalesce(p_reason, ''))) < 4 then raise exception 'Say why (a few words): it goes in the audit log' using errcode = '22023'; end if;
  return left(btrim(p_reason), 400);
end $$;

-- AI tokens an organisation used since a moment (AI employees, group summaries, product map reads). Inside the org.
create function pulse.platform_ai_tokens(p_since timestamptz) returns bigint
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce((select sum(coalesce(nullif(coalesce(tokens_in, 0) + coalesce(tokens_out, 0), 0), tokens, 0)) from agent_run where org_id = current_org() and started_at >= p_since), 0)
       + coalesce((select sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)) from chat_group_ai_job where org_id = current_org() and created_at >= p_since), 0)
       + coalesce((select sum(coalesce(tokens_in, 0) + coalesce(tokens_out, 0)) from product_map_ai_job where org_id = current_org() and created_at >= p_since), 0)
$$;
revoke all on function pulse.platform_ai_tokens(timestamptz) from public;

-- --------------------------------------------------------------------------------------------- organisations
create function pulse.platform_orgs() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_out jsonb := '[]'; o record; v_row jsonb; v_install uuid := install_org(); v_month timestamptz := date_trunc('month', now());
begin
  perform platform_guard();
  for o in select g.id, g.name, g.slug, g.code, g.status, g.activation, g.rehearsal, g.created_at, g.handle,
                  (select d.host from org_domain d where d.org_id = g.id and d.is_primary limit 1) host,
                  pp.plan, pp.seat_limit, pp.ai_tokens_month, pp.trial_ends,
                  (select max(s.last_active_at) from login_session s where s.org_id = g.id) last_active,
                  (select count(distinct s.person_id) from login_session s where s.org_id = g.id and s.last_active_at > now() - interval '7 days') active_7d
             from org g left join pulse_priv.platform_plan pp on pp.for_org = g.id order by g.created_at loop
    perform platform_enter(o.id);
    v_row := jsonb_build_object('id', o.id, 'name', o.name, 'slug', o.slug, 'code', o.code, 'handle', o.handle, 'status', o.status,
      'activation', o.activation, 'rehearsal', o.rehearsal, 'createdAt', o.created_at, 'host', o.host, 'own', o.id = v_install,
      'plan', coalesce(o.plan, case when o.id = v_install then 'internal' else 'trial' end), 'planSet', o.plan is not null,
      'seatLimit', o.seat_limit, 'aiTokensMonth', o.ai_tokens_month, 'trialEnds', o.trial_ends,
      'people', (select count(*) from person where org_id = o.id and side = 'staff' and status = 'active'),
      'clients', (select count(*) from person where org_id = o.id and side = 'client' and status = 'active'),
      'canSignIn', (select count(*) from login_credential where org_id = o.id and status = 'active'),
      'active7d', o.active_7d, 'lastActive', o.last_active,
      'aiTokensThisMonth', platform_ai_tokens(v_month));
    perform platform_leave();
    v_out := v_out || jsonb_build_array(v_row);
  end loop;
  return v_out;
end $$;
revoke all on function pulse.platform_orgs() from public;
grant execute on function pulse.platform_orgs() to pulse_api;

create function pulse.platform_org(p_org uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v jsonb; o org; pp pulse_priv.platform_plan; v_install uuid := install_org(); v_modules jsonb; v_doc jsonb;
begin
  perform platform_guard();
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  select * into pp from pulse_priv.platform_plan where for_org = p_org;
  perform platform_log('org.view', p_org, 'org', p_org::text, o.name, null, '{}');
  perform platform_enter(p_org);
  v_modules := org_modules();
  select body into v_doc from tenant_config where org_id = p_org and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
  v := jsonb_build_object(
    'id', o.id, 'name', o.name, 'slug', o.slug, 'code', o.code, 'handle', o.handle, 'status', o.status, 'activation', o.activation,
    'rehearsal', o.rehearsal, 'timeZone', o.time_zone, 'dataRegion', o.data_region, 'createdAt', o.created_at, 'own', o.id = v_install,
    'domains', (select coalesce(jsonb_agg(jsonb_build_object('host', host, 'primary', is_primary, 'signIn', sign_in) order by is_primary desc, host), '[]') from org_domain where org_id = p_org),
    'plan', jsonb_build_object('plan', coalesce(pp.plan, case when o.id = v_install then 'internal' else 'trial' end), 'set', pp.for_org is not null,
      'seatLimit', pp.seat_limit, 'aiTokensMonth', pp.ai_tokens_month, 'trialEnds', pp.trial_ends, 'note', pp.note, 'updatedAt', pp.updated_at, 'updatedBy', pp.updated_by),
    'licence', (select jsonb_build_object('key', l.licence_key, 'plan', l.plan, 'seats', l.seats, 'status', l.status, 'renewsOn', l.renews_on, 'hosting', l.hosting)
                  from pulse_priv.pulse_licence l where l.org_id = p_org limit 1),
    'companyModules', v_modules,
    'modulesDoc', jsonb_build_object('off', coalesce(v_doc -> 'off', '[]'), 'on', coalesce(v_doc -> 'on', '[]')),
    'counts', jsonb_build_object(
      'people', (select count(*) from person where org_id = p_org and side = 'staff' and status = 'active'),
      'clients', (select count(*) from person where org_id = p_org and side = 'client' and status = 'active'),
      'canSignIn', (select count(*) from login_credential where org_id = p_org and status = 'active'),
      'projects', (select count(*) from project where org_id = p_org),
      'tasks', (select count(*) from task where org_id = p_org and deleted_at is null),
      'chats', (select count(*) from chat_channel where org_id = p_org),
      'sessions7d', (select count(distinct person_id) from login_session where org_id = p_org and last_active_at > now() - interval '7 days')),
    'ai', jsonb_build_object('thisMonth', platform_ai_tokens(date_trunc('month', now())), 'last30', platform_ai_tokens(now() - interval '30 days'),
      'connections', (select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'provider', c.provider, 'state', c.state, 'cap', c.monthly_token_cap) order by c.created_at), '[]')
                        from ai_connection c where c.org_id = p_org and c.removed_at is null)),
    'members', (select coalesce(jsonb_agg(m order by m ->> 'name'), '[]') from (
      select jsonb_build_object('id', p.id, 'name', p.display_name, 'side', p.side, 'status', p.status,
        'email', pr.email, 'username', pr.username,
        'roles', (select coalesce(jsonb_agg(distinct r.role_key), '[]') from role_assignment r where r.org_id = p_org and r.person_id = p.id
                   and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')),
        'signIn', lc.status, 'locked', lc.locked_until > now(), 'lastLogin', lc.last_login_at,
        'lastActive', (select max(s.last_active_at) from login_session s where s.org_id = p_org and s.person_id = p.id)) m
        from person p left join people_profile pr on pr.person_id = p.id and pr.org_id = p_org
        left join login_credential lc on lc.person_id = p.id and lc.org_id = p_org
       where p.org_id = p_org and p.status = 'active' and p.side in ('staff', 'client', 'freelancer', 'partner')
       order by p.display_name limit 500) x),
    'orgAudit', (select coalesce(jsonb_agg(jsonb_build_object('at', a.at, 'action', a.action, 'resource', a.resource, 'actor', coalesce(a.actor_account, ap.display_name)) order by a.at desc), '[]')
                   from (select * from audit_event where org_id = p_org order by at desc limit 15) a left join person ap on ap.id = a.actor_id));
  perform platform_leave();
  return v || jsonb_build_object('platformAudit', (select coalesce(jsonb_agg(jsonb_build_object('at', a.at, 'actor', a.actor, 'action', a.action, 'label', a.target_label, 'reason', a.reason) order by a.at desc), '[]')
    from (select * from pulse_priv.platform_audit where target_org = p_org order by at desc limit 20) a));
end $$;
revoke all on function pulse.platform_org(uuid) from public;
grant execute on function pulse.platform_org(uuid) to pulse_api;

-- Status (active or suspended), plan and limits. Suspending ends every session there at once.
create function pulse.platform_org_set(p_org uuid, p jsonb, p_reason text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org; v_reason text := platform_reason(p_reason); v_changes jsonb := '{}'; v_status text := p ->> 'status'; v_ended int := 0;
begin
  perform platform_guard();
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  if v_status is not null and v_status is distinct from o.status then
    if v_status not in ('active', 'suspended') then raise exception 'Choose active or suspended' using errcode = '22023'; end if;
    if p_org = install_org() then raise exception 'The install''s own organisation cannot be suspended here' using errcode = '22023'; end if;
    if o.status = 'setup' then raise exception 'This organisation is still being set up: finish it under Companies' using errcode = '22023'; end if;
    update org set status = v_status where id = p_org;
    if v_status = 'suspended' then
      update login_session set revoked_at = now() where org_id = p_org and revoked_at is null;
      get diagnostics v_ended = row_count;
    end if;
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_array(o.status, v_status), 'sessionsEnded', v_ended);
  end if;
  if p ? 'plan' or p ? 'seatLimit' or p ? 'aiTokensMonth' or p ? 'trialEnds' or p ? 'note' then
    insert into pulse_priv.platform_plan(for_org) values (p_org) on conflict (for_org) do nothing;
    update pulse_priv.platform_plan set
      plan = case when p ? 'plan' then p ->> 'plan' else plan end,
      seat_limit = case when p ? 'seatLimit' then nullif(p ->> 'seatLimit', '')::int else seat_limit end,
      ai_tokens_month = case when p ? 'aiTokensMonth' then nullif(p ->> 'aiTokensMonth', '')::bigint else ai_tokens_month end,
      trial_ends = case when p ? 'trialEnds' then nullif(p ->> 'trialEnds', '')::date else trial_ends end,
      note = case when p ? 'note' then nullif(btrim(p ->> 'note'), '') else note end,
      updated_at = now(), updated_by = (select display_name from person where id = current_viewer())
     where for_org = p_org;
    v_changes := v_changes || (p - 'status');
  end if;
  perform platform_log(case when v_changes ? 'status' then 'org.' || v_status else 'org.plan' end, p_org, 'org', p_org::text, o.name, v_reason, v_changes);
  return v_changes;
end $$;
revoke all on function pulse.platform_org_set(uuid, jsonb, text) from public;
grant execute on function pulse.platform_org_set(uuid, jsonb, text) to pulse_api;

-- Switches: the company's own (tasks, chats, finance, attendance) and the tenant/modules document (other modules off,
-- organisation-only modules on). A new active version of the document is written, as Settings would.
create function pulse.platform_flag_set(p_org uuid, p_flag text, p_enabled boolean, p_kind text, p_reason text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org; v_reason text := platform_reason(p_reason); v_doc jsonb; v_version int; v_off jsonb; v_on jsonb;
begin
  perform platform_guard();
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  if p_enabled is null then raise exception 'Say on or off' using errcode = '22023'; end if;
  perform platform_enter(p_org);
  if p_kind = 'company' then
    perform org_module_write(p_flag, p_enabled);
  elsif p_kind in ('module', 'org-only') then
    if p_flag !~ '^[a-z_]{2,30}$' then raise exception 'Unknown module' using errcode = '22023'; end if;
    select body, version into v_doc, v_version from tenant_config where org_id = p_org and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
    v_doc := coalesce(v_doc, '{}');
    v_off := coalesce(v_doc -> 'off', '[]'); v_on := coalesce(v_doc -> 'on', '[]');
    if p_kind = 'module' then
      v_off := (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements_text(v_off) x where x <> p_flag);
      if not p_enabled then v_off := v_off || to_jsonb(p_flag); end if;
    else
      v_on := (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements_text(v_on) x where x <> p_flag);
      if p_enabled then v_on := v_on || to_jsonb(p_flag); end if;
    end if;
    v_doc := v_doc || jsonb_build_object('off', v_off) || case when jsonb_array_length(v_on) > 0 or v_doc ? 'on' then jsonb_build_object('on', v_on) else '{}' end;
    update tenant_config set is_active = false where org_id = p_org and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
    insert into tenant_config(org_id, doc_kind, doc_key, version, body, is_active)
    values (p_org, 'tenant', 'modules', coalesce((select max(version) from tenant_config where org_id = p_org and doc_kind = 'tenant' and doc_key = 'modules'), 0) + 1, v_doc, true);
  else
    raise exception 'Unknown switch kind' using errcode = '22023';
  end if;
  perform platform_leave();
  perform platform_log('flag.' || case when p_enabled then 'on' else 'off' end, p_org, 'flag', p_flag, o.name || ': ' || p_flag, v_reason,
    jsonb_build_object('flag', p_flag, 'kind', p_kind, 'enabled', p_enabled));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function pulse.platform_flag_set(uuid, text, boolean, text, text) from public;
grant execute on function pulse.platform_flag_set(uuid, text, boolean, text, text) to pulse_api;

-- --------------------------------------------------------------------------------------------------- people
-- Search people across every organisation by name, e-mail or username (at least two characters).
create function pulse.platform_people(p_q text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_out jsonb := '[]'; o record; v_q text := lower(btrim(coalesce(p_q, ''))); v_rows jsonb; v_n int := 0;
begin
  perform platform_guard();
  if length(v_q) < 2 then raise exception 'Type at least two letters' using errcode = '22023'; end if;
  v_q := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  for o in select id, name, status from org order by name loop
    perform platform_enter(o.id);
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'side', p.side, 'status', p.status, 'email', pr.email,
             'username', pr.username, 'orgId', o.id, 'org', o.name, 'orgStatus', o.status, 'signIn', lc.status, 'locked', lc.locked_until > now(),
             'lastLogin', lc.last_login_at,
             'roles', (select coalesce(jsonb_agg(distinct r.role_key), '[]') from role_assignment r where r.org_id = o.id and r.person_id = p.id
                        and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')))), '[]')
      into v_rows
      from (select * from person where org_id = o.id) p
      left join people_profile pr on pr.person_id = p.id and pr.org_id = o.id
      left join login_credential lc on lc.person_id = p.id and lc.org_id = o.id
     where lower(p.display_name) like v_q or lower(coalesce(pr.email, '')) like v_q or lower(coalesce(pr.username, '')) like v_q;
    perform platform_leave();
    v_out := v_out || v_rows; v_n := jsonb_array_length(v_out);
    exit when v_n >= 100;
  end loop;
  perform platform_log('people.search', null, 'search', null, left(p_q, 60), null, jsonb_build_object('found', v_n));
  return jsonb_build_object('people', v_out, 'more', v_n >= 100);
end $$;
revoke all on function pulse.platform_people(text) from public;
grant execute on function pulse.platform_people(text) to pulse_api;

-- One person: their organisation, roles, sign-in, sessions and other organisations of the same Pulse account.
-- view-as (read-only): the same read, with a reason, audited as a view-as.
create function pulse.platform_person(p_org uuid, p_person uuid, p_reason text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org; v jsonb; v_name text; v_view boolean := p_reason is not null; v_reason text;
begin
  perform platform_guard();
  if v_view then v_reason := platform_reason(p_reason); end if;
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  perform platform_enter(p_org);
  select display_name into v_name from person where id = p_person and org_id = p_org;
  if v_name is null then perform platform_leave(); raise exception 'Person not found' using errcode = 'P0002'; end if;
  select jsonb_build_object('id', p.id, 'name', p.display_name, 'side', p.side, 'status', p.status, 'activeFrom', p.active_from,
      'org', jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status),
      'email', pr.email, 'username', pr.username, 'title', pr.role, 'pod', pr.pod, 'department', pr.department,
      'manager', (select display_name from person m where m.id = pr.manager_id),
      'roles', (select coalesce(jsonb_agg(distinct r.role_key), '[]') from role_assignment r where r.org_id = p_org and r.person_id = p.id
                 and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')),
      'signIn', (select jsonb_build_object('status', lc.status, 'mustChange', lc.must_change, 'lastLogin', lc.last_login_at, 'failed', lc.failed_attempts,
                   'lockedUntil', lc.locked_until) from login_credential lc where lc.person_id = p.id and lc.org_id = p_org),
      'sessions', (select coalesce(jsonb_agg(jsonb_build_object('device', s.device, 'via', s.via, 'created', s.created_at, 'lastActive', s.last_active_at, 'expires', s.expires_at) order by s.last_active_at desc nulls last), '[]')
                    from (select * from login_session s where s.org_id = p_org and s.person_id = p.id and s.revoked_at is null and s.expires_at > now() order by s.last_active_at desc nulls last limit 10) s),
      'openTasks', (select count(*) from task t where t.org_id = p_org and t.assignee_person_id = p.id and t.deleted_at is null and t.status not in ('done', 'cancelled', 'accepted')),
      'modules', org_modules())
    into v from person p left join people_profile pr on pr.person_id = p.id and pr.org_id = p_org where p.id = p_person;
  perform platform_leave();
  v := v || jsonb_build_object('account', (select jsonb_build_object('handle', a.handle, 'email', a.email, 'locked', a.locked_until > now(), 'created', a.created_at,
      'orgs', (select coalesce(jsonb_agg(jsonb_build_object('orgId', m.member_org, 'org', g.name, 'kind', m.kind, 'personId', m.person_id, 'lastUsed', m.last_used_at) order by g.name), '[]')
                 from pulse_priv.account_member m join org g on g.id = m.member_org where m.account_id = a.id))
    from pulse_priv.account_member am join pulse_priv.pulse_account a on a.id = am.account_id where am.person_id = p_person));
  perform platform_log(case when v_view then 'person.view_as' else 'person.view' end, p_org, 'person', p_person::text, v_name, v_reason, '{}');
  return v || jsonb_build_object('viewAs', v_view);
end $$;
revoke all on function pulse.platform_person(uuid, uuid, text) from public;
grant execute on function pulse.platform_person(uuid, uuid, text) to pulse_api;

-- Sign-in help: sign out everywhere, unlock, reset (unlock + sign out + choose a new password at next sign-in),
-- disable or enable. Never the admin's own sign-in, and never another platform admin's.
create function pulse.platform_person_action(p_org uuid, p_person uuid, p_action text, p_reason text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o org; v_reason text := platform_reason(p_reason); v_name text; v_ended int := 0; v_account uuid;
begin
  perform platform_guard();
  if p_action not in ('sign_out', 'unlock', 'reset', 'disable', 'enable') then raise exception 'Unknown action' using errcode = '22023'; end if;
  if p_person = current_viewer() then raise exception 'Use your own Account page for your own sign-in' using errcode = '22023'; end if;
  if exists (select 1 from pulse_priv.platform_admin where person_id = p_person) then raise exception 'Another platform admin''s sign-in is changed from the server' using errcode = '42501'; end if;
  select * into o from org where id = p_org;
  if not found then raise exception 'Organisation not found' using errcode = 'P0002'; end if;
  perform platform_enter(p_org);
  select display_name into v_name from person where id = p_person and org_id = p_org;
  if v_name is null then perform platform_leave(); raise exception 'Person not found' using errcode = 'P0002'; end if;
  if p_action in ('sign_out', 'reset', 'disable') then
    update login_session set revoked_at = now() where org_id = p_org and person_id = p_person and revoked_at is null;
    get diagnostics v_ended = row_count;
  end if;
  if p_action in ('unlock', 'reset') then
    update login_credential set failed_attempts = 0, locked_until = null where org_id = p_org and person_id = p_person;
  end if;
  if p_action = 'reset' then
    update login_credential set must_change = true where org_id = p_org and person_id = p_person;
  end if;
  if p_action in ('disable', 'enable') then
    if not exists (select 1 from login_credential where org_id = p_org and person_id = p_person) then
      perform platform_leave(); raise exception 'This person has no Pulse password sign-in' using errcode = '22023';
    end if;
    update login_credential set status = case when p_action = 'disable' then 'disabled' else 'active' end where org_id = p_org and person_id = p_person;
  end if;
  perform platform_leave();
  if p_action in ('unlock', 'reset') then
    select am.account_id into v_account from pulse_priv.account_member am where am.person_id = p_person;
    if v_account is not null then update pulse_priv.pulse_account set failed = 0, locked_until = null where id = v_account; end if;
  end if;
  perform platform_log('person.' || p_action, p_org, 'person', p_person::text, v_name, v_reason, jsonb_build_object('sessionsEnded', v_ended));
  return jsonb_build_object('ok', true, 'sessionsEnded', v_ended);
end $$;
revoke all on function pulse.platform_person_action(uuid, uuid, text, text) from public;
grant execute on function pulse.platform_person_action(uuid, uuid, text, text) to pulse_api;

-- ---------------------------------------------------------------------------------------------- usage, audit
create function pulse.platform_usage(p_days int) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_out jsonb := '[]'; o record; v_days int := least(greatest(coalesce(p_days, 30), 1), 365); v_since timestamptz; v_row jsonb;
begin
  perform platform_guard();
  v_since := now() - make_interval(days => v_days);
  for o in select g.id, g.name, g.status, pp.plan, pp.seat_limit, pp.ai_tokens_month from org g left join pulse_priv.platform_plan pp on pp.for_org = g.id order by g.name loop
    perform platform_enter(o.id);
    v_row := jsonb_build_object('id', o.id, 'name', o.name, 'status', o.status, 'plan', o.plan, 'seatLimit', o.seat_limit, 'aiTokensMonth', o.ai_tokens_month,
      'people', (select count(*) from person where org_id = o.id and side = 'staff' and status = 'active'),
      'activePeople', (select count(distinct person_id) from login_session where org_id = o.id and last_active_at >= v_since),
      'aiTokens', platform_ai_tokens(v_since), 'aiTokensThisMonth', platform_ai_tokens(date_trunc('month', now())),
      'aiRuns', (select count(*) from agent_run where org_id = o.id and started_at >= v_since),
      'tasksCreated', (select count(*) from task where org_id = o.id and created_at >= v_since),
      'messages', (select count(*) from chat_message where org_id = o.id and created_at >= v_since));
    perform platform_leave();
    v_out := v_out || jsonb_build_array(v_row);
  end loop;
  return jsonb_build_object('days', v_days, 'orgs', v_out);
end $$;
revoke all on function pulse.platform_usage(int) from public;
grant execute on function pulse.platform_usage(int) to pulse_api;

create function pulse.platform_audit_list(p_org uuid, p_action text, p_before timestamptz, p_limit int) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform platform_guard();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'at', a.at, 'actor', a.actor, 'action', a.action, 'orgId', a.target_org, 'org', g.name,
      'kind', a.target_kind, 'targetId', a.target_id, 'label', a.target_label, 'reason', a.reason, 'detail', a.detail) order by a.at desc), '[]')
    from (select * from pulse_priv.platform_audit
           where (p_org is null or target_org = p_org) and (p_action is null or action like p_action || '%') and (p_before is null or at < p_before)
           order by at desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) a left join org g on g.id = a.target_org);
end $$;
revoke all on function pulse.platform_audit_list(uuid, text, timestamptz, int) from public;
grant execute on function pulse.platform_audit_list(uuid, text, timestamptz, int) to pulse_api;

-- ----------------------------------------------------------------------------------------------------- health
create function pulse.platform_health() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o record; v_jobs jsonb := jsonb_build_object('aiRuns', 0, 'groupJobs', 0, 'mapJobs', 0, 'stuck', 0);
begin
  perform platform_guard();
  for o in select id from org where status in ('active', 'suspended', 'offboarding') loop
    perform platform_enter(o.id);
    v_jobs := jsonb_build_object(
      'aiRuns', (v_jobs ->> 'aiRuns')::int + (select count(*) from agent_run where org_id = o.id and finished_at is null),
      'groupJobs', (v_jobs ->> 'groupJobs')::int + (select count(*) from chat_group_ai_job where org_id = o.id and finished_at is null),
      'mapJobs', (v_jobs ->> 'mapJobs')::int + (select count(*) from product_map_ai_job where org_id = o.id and finished_at is null),
      'stuck', (v_jobs ->> 'stuck')::int + (select count(*) from agent_run where org_id = o.id and finished_at is null and started_at < now() - interval '1 hour')
        + (select count(*) from chat_group_ai_job where org_id = o.id and finished_at is null and created_at < now() - interval '1 hour')
        + (select count(*) from product_map_ai_job where org_id = o.id and finished_at is null and created_at < now() - interval '1 hour'));
    perform platform_leave();
  end loop;
  return jsonb_build_object(
    'database', jsonb_build_object('bytes', pg_database_size(current_database()), 'migration', (select max(version) from public.schema_migrations),
      'connections', (select count(*) from pg_stat_activity where datname = current_database()),
      'largest', (select coalesce(jsonb_agg(jsonb_build_object('table', t.name, 'bytes', t.bytes) order by t.bytes desc), '[]') from (
          select n.nspname || '.' || c.relname name, pg_total_relation_size(c.oid) bytes from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('pulse', 'pulse_priv', 'privacy') and c.relkind in ('r', 'p') order by 2 desc limit 8) t)),
    'jobs', v_jobs,
    'orgs', (select jsonb_build_object('active', count(*) filter (where status = 'active'), 'suspended', count(*) filter (where status = 'suspended'),
      'setup', count(*) filter (where status = 'setup')) from org),
    'sessions24h', (select count(distinct person_id) from login_session where last_active_at > now() - interval '24 hours'));
end $$;
revoke all on function pulse.platform_health() from public;
grant execute on function pulse.platform_health() to pulse_api;

-- ------------------------------------------------------------------------------------------------ announcements
create function pulse.platform_announcements() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  perform platform_guard();
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'body', body, 'tone', tone, 'audience', audience, 'link', link,
      'startsAt', starts_at, 'endsAt', ends_at, 'endedAt', ended_at, 'createdBy', created_by, 'createdAt', created_at,
      'live', ended_at is null and starts_at <= now() and (ends_at is null or ends_at > now())) order by created_at desc), '[]')
    from (select * from pulse_priv.platform_announcement order by created_at desc limit 100) a);
end $$;
revoke all on function pulse.platform_announcements() from public;
grant execute on function pulse.platform_announcements() to pulse_api;

create function pulse.platform_announce(p jsonb) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_id uuid; v_name text;
begin
  perform platform_guard();
  select display_name into v_name from person where id = current_viewer();
  insert into pulse_priv.platform_announcement(title, body, tone, audience, link, starts_at, ends_at, created_by)
  values (btrim(p ->> 'title'), nullif(btrim(coalesce(p ->> 'body', '')), ''), coalesce(nullif(p ->> 'tone', ''), 'info'), coalesce(nullif(p ->> 'audience', ''), 'everyone'),
          nullif(btrim(coalesce(p ->> 'link', '')), ''), coalesce(nullif(p ->> 'startsAt', '')::timestamptz, now()), nullif(p ->> 'endsAt', '')::timestamptz, coalesce(v_name, 'Pulse'))
  returning id into v_id;
  perform platform_log('announcement.publish', null, 'announcement', v_id::text, left(p ->> 'title', 200), null, p);
  return v_id;
end $$;
revoke all on function pulse.platform_announce(jsonb) from public;
grant execute on function pulse.platform_announce(jsonb) to pulse_api;

create function pulse.platform_announce_end(p_id uuid) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_title text;
begin
  perform platform_guard();
  update pulse_priv.platform_announcement set ended_at = now() where id = p_id and ended_at is null returning title into v_title;
  if v_title is null then raise exception 'Announcement not found or already ended' using errcode = 'P0002'; end if;
  perform platform_log('announcement.end', null, 'announcement', p_id::text, v_title, null, '{}');
end $$;
revoke all on function pulse.platform_announce_end(uuid) from public;
grant execute on function pulse.platform_announce_end(uuid) to pulse_api;

-- What a signed-in person sees now (every organisation): live announcements for their audience.
create function pulse.platform_notices() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'body', body, 'tone', tone, 'link', link) order by starts_at desc), '[]')
    from (select * from pulse_priv.platform_announcement
           where current_viewer() is not null and ended_at is null and starts_at <= now() and (ends_at is null or ends_at > now())
             and (audience = 'everyone' or viewer_is('admin'))
           order by starts_at desc limit 3) a
$$;
revoke all on function pulse.platform_notices() from public;
grant execute on function pulse.platform_notices() to pulse_api;

-- ------------------------------------------------------------------------------------------- break-glass (operator)
-- From the server only (operator API): name or remove a platform admin by their e-mail in the install's organisation.
create function pulse.platform_admin_set(p_email text, p_grant boolean, p_actor text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_install uuid := install_org(); v_person uuid; v_name text;
begin
  perform set_config('pulse.org_id', v_install::text, true);
  select p.id, p.display_name into v_person, v_name from person p join people_profile pr on pr.person_id = p.id and pr.org_id = v_install
   where p.org_id = v_install and p.status = 'active' and lower(pr.email) = lower(btrim(p_email)) limit 1;
  if v_person is null then raise exception 'No active person with this e-mail in the install''s organisation' using errcode = 'P0002'; end if;
  if p_grant then
    insert into pulse_priv.platform_admin(person_id, granted_by) values (v_person, left(coalesce(p_actor, 'operator'), 120)) on conflict do nothing;
  else
    delete from pulse_priv.platform_admin where person_id = v_person;
  end if;
  insert into pulse_priv.platform_audit(actor, action, target_org, target_kind, target_id, target_label)
  values (left(coalesce(p_actor, 'operator'), 120), case when p_grant then 'admin.grant' else 'admin.revoke' end, v_install, 'person', v_person::text, v_name);
  return jsonb_build_object('personId', v_person, 'name', v_name, 'platformAdmin', p_grant);
end $$;
revoke all on function pulse.platform_admin_set(text, boolean, text) from public;
grant execute on function pulse.platform_admin_set(text, boolean, text) to pulse_api;

create function pulse.platform_admin_list() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('personId', a.person_id, 'grantedAt', a.granted_at, 'grantedBy', a.granted_by) order by a.granted_at), '[]')
    from pulse_priv.platform_admin a
$$;
revoke all on function pulse.platform_admin_list() from public;
grant execute on function pulse.platform_admin_list() to pulse_api;

-- migrate:down
drop function pulse.platform_admin_list();
drop function pulse.platform_admin_set(text, boolean, text);
drop function pulse.platform_notices();
drop function pulse.platform_announce_end(uuid);
drop function pulse.platform_announce(jsonb);
drop function pulse.platform_announcements();
drop function pulse.platform_health();
drop function pulse.platform_audit_list(uuid, text, timestamptz, int);
drop function pulse.platform_usage(int);
drop function pulse.platform_person_action(uuid, uuid, text, text);
drop function pulse.platform_person(uuid, uuid, text);
drop function pulse.platform_people(text);
drop function pulse.platform_flag_set(uuid, text, boolean, text, text);
drop function pulse.platform_org_set(uuid, jsonb, text);
drop function pulse.platform_org(uuid);
drop function pulse.platform_orgs();
drop function pulse.platform_ai_tokens(timestamptz);
drop function pulse.platform_reason(text);
drop function pulse.platform_log(text, uuid, text, text, text, text, jsonb);
drop function pulse.platform_leave();
drop function pulse.platform_enter(uuid);
drop function pulse.platform_guard();
drop function pulse.platform_admin();
drop table pulse_priv.platform_announcement;
drop table pulse_priv.platform_plan;
drop table pulse_priv.platform_audit;
drop function pulse.platform_audit_frozen();
drop table pulse_priv.platform_admin;
