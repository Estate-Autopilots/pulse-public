-- migrate:up
-- EST-2811 (owner, 28 Oct 2026): connected apps. A person signs in to an app (Claude, ChatGPT, the Pulse CLI) with
-- their own Pulse account through OAuth 2.1 (dynamic client registration, PKCE S256, rotating refresh tokens), the
-- same shape as Sales X-Ray's connector. The app then calls API v1 and its MCP adapter AS that person: the access
-- token becomes the viewer only inside pulse.v1_person_principal, so row security and the domain functions decide
-- exactly what the screens decide. Tokens, codes and client secrets are stored as SHA-256 only.
-- Writes made through an app land in pulse_priv.app_change (who, which app, what, the value before) and can be
-- undone for 7 days; profile corrections also carry their reason in pulse.record_change.

create table pulse_priv.oauth_client (
  org_id uuid not null references pulse.org(id),
  client_id text primary key check (client_id ~ '^pcl_[0-9a-f]{24}$'),
  name text not null check (length(name) between 1 and 80 and name !~ '[[:cntrl:]]'),
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 5 and array_position(redirect_uris, null) is null),
  secret_sha256 text check (secret_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create table pulse_priv.oauth_code (
  org_id uuid not null references pulse.org(id),
  code_sha256 text primary key check (code_sha256 ~ '^[0-9a-f]{64}$'),
  client_id text not null references pulse_priv.oauth_client(client_id),
  person_id uuid not null references pulse.person(id),
  scopes text[] not null,
  redirect_uri text not null,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  used_at timestamptz
);
create table pulse_priv.oauth_grant (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  client_id text not null references pulse_priv.oauth_client(client_id),
  person_id uuid not null references pulse.person(id),
  scopes text[] not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text
);
create index oauth_grant_person on pulse_priv.oauth_grant(org_id, person_id) where revoked_at is null;
create table pulse_priv.oauth_token (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references pulse_priv.oauth_grant(id),
  kind text not null check (kind in ('access', 'refresh')),
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by uuid
);
create index oauth_token_grant on pulse_priv.oauth_token(grant_id);
-- Append-only ledger of writes made through API v1 (an app or a token): the value before, for a 7-day undo.
create table pulse_priv.app_change (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references pulse.person(id),
  grant_id uuid references pulse_priv.oauth_grant(id),
  app text not null check (length(app) between 1 and 80),
  action text not null check (action in ('profile.correct', 'password.issue', 'invite.send', 'chat.group.create', 'chat.members', 'feedback.status')),
  subject_id uuid not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references pulse.person(id)
);
create index app_change_actor on pulse_priv.app_change(org_id, actor_id, created_at desc);
do $$ declare t text; begin
 foreach t in array array['oauth_client','oauth_code','oauth_grant','oauth_token','app_change'] loop
  execute format('alter table pulse_priv.%I enable row level security', t);
  execute format('alter table pulse_priv.%I force row level security', t);
  execute format('create policy tenant_isolation on pulse_priv.%I using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
 end loop;
end $$;
-- Why a field was corrected, and through which app (null: a Pulse screen).
alter table pulse.record_change add column reason text check (reason is null or length(reason) <= 300),
  add column via text check (via is null or length(via) <= 80);

-- ------------------------------------------------------------------------------------------------ OAuth
create function pulse.oauth_register(p_client text, p_name text, p_uris text[], p_secret text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is not null then raise exception 'Apps register without a sign-in' using errcode='42501'; end if;
 insert into pulse_priv.oauth_client(org_id, client_id, name, redirect_uris, secret_sha256) values (current_org(), p_client, p_name, p_uris, p_secret);
end $$;

-- What the consent screen shows; nothing secret.
create function pulse.oauth_client_peek(p_client text) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select jsonb_build_object('name', name, 'redirectUris', to_jsonb(redirect_uris), 'confidential', secret_sha256 is not null)
 from pulse_priv.oauth_client where org_id = current_org() and client_id = p_client and revoked_at is null
$$;

-- The signed-in person approves: a one-time code for this client, redirect and PKCE challenge.
create function pulse.oauth_code_issue(p_code text, p_client text, p_scopes text[], p_redirect text, p_challenge text) returns void
 language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if current_viewer() is null or not exists(select 1 from person where org_id = current_org() and id = current_viewer() and status = 'active' and side = 'staff')
  then raise exception 'An active staff account approves apps' using errcode='42501'; end if;
 if not exists(select 1 from pulse_priv.oauth_client where org_id = current_org() and client_id = p_client and revoked_at is null and p_redirect = any(redirect_uris))
  then raise exception 'Unknown app or return address' using errcode='22023'; end if;
 if cardinality(p_scopes) = 0 or not (p_scopes <@ v1_scopes()) then raise exception 'Unknown permission' using errcode='22023'; end if;
 insert into pulse_priv.oauth_code(org_id, code_sha256, client_id, person_id, scopes, redirect_uri, code_challenge)
 values (current_org(), p_code, p_client, current_viewer(), p_scopes, p_redirect, p_challenge);
end $$;

-- Client authentication shared by the token and revoke endpoints: a public client sends no secret.
create function pulse.oauth_client_ok(p_client text, p_secret text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from pulse_priv.oauth_client where org_id = current_org() and client_id = p_client and revoked_at is null
  and secret_sha256 is not distinct from p_secret)
$$;

create function pulse.oauth_tokens_make(p_grant uuid, p_access text, p_refresh text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare refresh uuid;
begin
 insert into pulse_priv.oauth_token(org_id, grant_id, kind, token_sha256, expires_at) values (current_org(), p_grant, 'access', p_access, now() + interval '1 hour');
 insert into pulse_priv.oauth_token(org_id, grant_id, kind, token_sha256, expires_at) values (current_org(), p_grant, 'refresh', p_refresh, now() + interval '30 days') returning id into refresh;
 return refresh;
end $$;

-- authorization_code grant. Refusals return {error} (never raise) so the caller commits the security revocations.
create function pulse.oauth_exchange(p_code text, p_client text, p_secret text, p_redirect text, p_verifier_challenge text, p_access text, p_refresh text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x pulse_priv.oauth_code; g uuid;
begin
 if not oauth_client_ok(p_client, p_secret) then return jsonb_build_object('error', 'invalid_client'); end if;
 select * into x from pulse_priv.oauth_code where org_id = current_org() and code_sha256 = p_code for update;
 if not found or x.client_id <> p_client then return jsonb_build_object('error', 'invalid_grant'); end if;
 if x.used_at is not null then
  -- A replayed code ends what it started (RFC 6749 §4.1.2).
  update pulse_priv.oauth_grant set revoked_at = now(), revoked_reason = 'security:code_replay'
   where org_id = current_org() and client_id = x.client_id and person_id = x.person_id and revoked_at is null;
  return jsonb_build_object('error', 'invalid_grant');
 end if;
 update pulse_priv.oauth_code set used_at = now() where code_sha256 = p_code;
 if x.expires_at < now() or x.redirect_uri <> p_redirect or x.code_challenge <> p_verifier_challenge then return jsonb_build_object('error', 'invalid_grant'); end if;
 if not exists(select 1 from person where org_id = current_org() and id = x.person_id and status = 'active') then return jsonb_build_object('error', 'invalid_grant'); end if;
 insert into pulse_priv.oauth_grant(org_id, client_id, person_id, scopes) values (current_org(), x.client_id, x.person_id, x.scopes) returning id into g;
 perform oauth_tokens_make(g, p_access, p_refresh);
 return jsonb_build_object('scope', array_to_string(x.scopes, ' '), 'expiresIn', 3600);
end $$;

-- refresh_token grant: rotates; a replaced refresh token coming back ends the whole connection.
create function pulse.oauth_refresh(p_refresh text, p_client text, p_secret text, p_access text, p_new_refresh text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.oauth_token; g pulse_priv.oauth_grant; fresh uuid;
begin
 if not oauth_client_ok(p_client, p_secret) then return jsonb_build_object('error', 'invalid_client'); end if;
 select * into t from pulse_priv.oauth_token where org_id = current_org() and token_sha256 = p_refresh and kind = 'refresh' for update;
 if not found then return jsonb_build_object('error', 'invalid_grant'); end if;
 select * into g from pulse_priv.oauth_grant where id = t.grant_id for update;
 if g.client_id <> p_client then return jsonb_build_object('error', 'invalid_grant'); end if;
 if t.replaced_by is not null then
  update pulse_priv.oauth_grant set revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, 'security:refresh_reuse') where id = g.id;
  return jsonb_build_object('error', 'invalid_grant');
 end if;
 if g.revoked_at is not null or t.revoked_at is not null or t.expires_at < now()
    or not exists(select 1 from person where org_id = current_org() and id = g.person_id and status = 'active') then return jsonb_build_object('error', 'invalid_grant'); end if;
 fresh := oauth_tokens_make(g.id, p_access, p_new_refresh);
 update pulse_priv.oauth_token set revoked_at = now(), replaced_by = fresh where id = t.id;
 return jsonb_build_object('scope', array_to_string(g.scopes, ' '), 'expiresIn', 3600);
end $$;

-- RFC 7009: a refresh token ends its connection, an access token only itself; unknown tokens are not an error.
create function pulse.oauth_revoke(p_token text, p_client text, p_secret text) returns boolean
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.oauth_token;
begin
 if not oauth_client_ok(p_client, p_secret) then return false; end if;
 select tk.* into t from pulse_priv.oauth_token tk join pulse_priv.oauth_grant g on g.id = tk.grant_id
  where tk.org_id = current_org() and tk.token_sha256 = p_token and g.client_id = p_client;
 if found then
  if t.kind = 'refresh' then update pulse_priv.oauth_grant set revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, 'client_revoked') where id = t.grant_id;
  else update pulse_priv.oauth_token set revoked_at = coalesce(revoked_at, now()) where id = t.id; end if;
 end if;
 return true;
end $$;

-- The person's own connections (Settings, CLI `pulse auth status`), and ending one.
create function pulse.oauth_my_grants() returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'app', c.name, 'scopes', to_jsonb(g.scopes), 'createdAt', g.created_at, 'lastUsedAt', g.last_used_at) order by g.created_at desc), '[]')
 from pulse_priv.oauth_grant g join pulse_priv.oauth_client c on c.client_id = g.client_id
 where g.org_id = current_org() and g.person_id = current_viewer() and g.revoked_at is null
$$;
create function pulse.oauth_grant_end(p_grant uuid) returns boolean language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 update pulse_priv.oauth_grant set revoked_at = now(), revoked_reason = 'person_disconnected'
  where org_id = current_org() and id = p_grant and revoked_at is null and (person_id = current_viewer() or viewer_is('admin'));
 return found;
end $$;

-- API v1 front door, shaped like v1_agent_principal (0670): a live access token whose connection holds the scope makes
-- its person the viewer. Returns the token row id, or null with nothing set.
create function pulse.v1_person_principal(p_token text, p_scope text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.oauth_token; g pulse_priv.oauth_grant; app text;
begin
 if current_viewer() is not null or p_scope is null or not (p_scope = any(v1_scopes())) then return null; end if;
 select * into t from pulse_priv.oauth_token where org_id = current_org() and token_sha256 = p_token and kind = 'access' and revoked_at is null and expires_at > now();
 if not found then return null; end if;
 select * into g from pulse_priv.oauth_grant where id = t.grant_id and revoked_at is null and p_scope = any(scopes);
 if not found or not exists(select 1 from person where org_id = current_org() and id = g.person_id and status = 'active' and side = 'staff') then return null; end if;
 select name into app from pulse_priv.oauth_client where client_id = g.client_id;
 perform set_config('pulse.viewer_id', g.person_id::text, true);
 -- The credential row is visible to its own person only, so it is read once the viewer is set.
 if exists(select 1 from login_credential where person_id = g.person_id and status = 'disabled') then
  perform set_config('pulse.viewer_id', '', true);
  return null;
 end if;
 perform set_config('pulse.actor_account', 'app:' || app || ':' || coalesce((select username from people_profile where person_id = g.person_id), g.person_id::text), true);
 perform set_config('pulse.app_label', app, true);
 perform set_config('pulse.app_grant', g.id::text, true);
 update pulse_priv.oauth_grant set last_used_at = now() where id = g.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
 return t.id;
end $$;
create function pulse.v1_person_token_live(p_token text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from pulse_priv.oauth_token t join pulse_priv.oauth_grant g on g.id = t.grant_id
  where t.org_id = current_org() and t.token_sha256 = p_token and t.kind = 'access' and t.revoked_at is null and t.expires_at > now() and g.revoked_at is null)
$$;

-- ------------------------------------------------------------------------------------------------ app changes
create function pulse.app_change_add(p_action text, p_subject uuid, p_detail jsonb) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare new_id uuid;
begin
 if current_viewer() is null then raise exception 'A signed-in person makes changes' using errcode='42501'; end if;
 insert into pulse_priv.app_change(org_id, actor_id, grant_id, app, action, subject_id, detail)
 values (current_org(), current_viewer(), nullif(current_setting('pulse.app_grant', true), '')::uuid,
   coalesce(nullif(current_setting('pulse.app_label', true), ''), 'Pulse API'), p_action, p_subject, coalesce(p_detail, '{}'))
 returning app_change.id into new_id;
 return new_id;
end $$;

-- HR's direct correction of a staff record (joining date, work email, department, manager …), with its reason.
-- One field per call; the field is locked against the next sync and the change is logged with who, why and which app.
create function pulse.hr_profile_set(p_person uuid, p_field text, p_value text, p_reason text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare col text; v text := nullif(btrim(regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g')), ''); old text; via text := nullif(current_setting('pulse.app_label', true), '');
begin
 col := case p_field when 'joinedOn' then 'joined_on' when 'department' then 'department' when 'managerId' then 'manager_id' when 'workEmail' then 'email'
  when 'phone' then 'phone' when 'role' then 'role' when 'pod' then 'pod' when 'employmentType' then 'employment_type' when 'workLocation' then 'work_location' end;
 if col is null then raise exception 'Choose a field: joinedOn, department, managerId, workEmail, phone, role, pod, employmentType or workLocation' using errcode='22023'; end if;
 if p_field = 'joinedOn' and v is not null and (v !~ '^\d{4}-\d{2}-\d{2}$' or v::date > current_date + 366 or v::date < date '1950-01-01') then raise exception 'Use a date such as 2026-10-05 for joinedOn' using errcode='22023'; end if;
 if p_field = 'workEmail' and v is not null then v := lower(v); if v !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' or length(v) > 120 then raise exception 'Use a valid work email' using errcode='22023'; end if; end if;
 if p_field = 'role' and v is null then raise exception 'role is required' using errcode='22023'; end if;
 if p_field = 'employmentType' and v is not null and v not in ('full_time','part_time','intern','contract','freelance') then raise exception 'Unknown employmentType' using errcode='22023'; end if;
 if p_field = 'pod' and v is not null and not exists(select 1 from unit where org_id = current_org() and kind = 'pod' and valid_to is null and name = v) then raise exception 'Unknown pod' using errcode='22023'; end if;
 if p_field = 'managerId' and v is not null then
  if v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or not exists(select 1 from person where org_id = current_org() and id = v::uuid and status = 'active' and side = 'staff')
   then raise exception 'Choose an active staff member as manager' using errcode='22023'; end if;
  if exists(with recursive up(id, depth) as (select v::uuid, 0 union all select pp.manager_id, up.depth + 1 from up join people_profile pp on pp.person_id = up.id where pp.manager_id is not null and up.depth < 50)
    select 1 from up where id = p_person) then raise exception 'That manager reports to this person' using errcode='22023'; end if;
 end if;
 if p_field in ('department','phone','workLocation') and length(coalesce(v, '')) > 60 then raise exception '% is too long', p_field using errcode='22023'; end if;
 if p_field = 'role' and length(v) > 80 then raise exception 'role is too long' using errcode='22023'; end if;
 if not exists(select 1 from people_profile where org_id = current_org() and person_id = p_person) then raise exception 'No staff record for that person' using errcode='P0002'; end if;
 execute format('select %I::text from people_profile where org_id = current_org() and person_id = $1 for update', col) into old using p_person;
 if old is not distinct from v then return jsonb_build_object('changed', false, 'field', p_field, 'from', old, 'to', v); end if;
 execute format('update people_profile set %I = $1%s, locked = array(select distinct unnest(locked || $2::text)), updated_at = now() where org_id = current_org() and person_id = $3',
   col, case when col in ('joined_on') then '::date' when col = 'manager_id' then '::uuid' else '' end) using v, col, p_person;
 insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by, reason, via)
 values (current_org(), 'person', p_person, case p_field when 'workEmail' then 'email' else p_field end, old, v, current_viewer(), p_reason, via);
 return jsonb_build_object('changed', true, 'field', p_field, 'from', old, 'to', v);
end $$;
revoke all on function pulse.hr_profile_set(uuid,text,text,text) from public;

create function pulse.hr_profile_correct(p_person uuid, p_field text, p_value text, p_reason text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare r jsonb; why text := btrim(coalesce(p_reason, ''));
begin
 if current_viewer() is null or not viewer_is('admin', 'hr') then raise exception 'HR or admin required' using errcode='42501'; end if;
 if length(why) not between 5 and 300 then raise exception 'Give the reason for the correction (5 to 300 characters)' using errcode='22023'; end if;
 if not exists(select 1 from person where org_id = current_org() and id = p_person and side = 'staff') then raise exception 'No staff record for that person' using errcode='P0002'; end if;
 r := hr_profile_set(p_person, p_field, p_value, why);
 if (r->>'changed')::boolean then
  r := r || jsonb_build_object('changeId', app_change_add('profile.correct', p_person, r - 'changed' || jsonb_build_object('reason', why)), 'undoUntil', now() + interval '7 days');
 end if;
 return r;
end $$;

-- Undo a change made through an app or token, within 7 days, by the person who made it or an admin. A later change
-- by anyone wins: nothing is undone if the value moved since.
create function pulse.app_change_undo(p_id uuid) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare x pulse_priv.app_change; cur text;
begin
 select * into x from pulse_priv.app_change where org_id = current_org() and id = p_id for update;
 if not found or not (x.actor_id = current_viewer() or viewer_is('admin')) then raise exception 'No such change of yours' using errcode='P0002'; end if;
 if x.undone_at is not null then return jsonb_build_object('changeId', x.id, 'status', 'undone', 'replayed', true); end if;
 if x.created_at < now() - interval '7 days' then raise exception 'Changes can be undone for 7 days' using errcode='23514'; end if;
 if x.action = 'profile.correct' then
  if not viewer_is('admin', 'hr') then raise exception 'HR or admin required' using errcode='42501'; end if;
  execute format('select %I::text from people_profile where org_id = current_org() and person_id = $1',
   case x.detail->>'field' when 'joinedOn' then 'joined_on' when 'managerId' then 'manager_id' when 'workEmail' then 'email' when 'employmentType' then 'employment_type'
    when 'workLocation' then 'work_location' else x.detail->>'field' end) into cur using x.subject_id;
  if cur is distinct from x.detail->>'to' then raise exception 'Someone changed this since; nothing was undone' using errcode='23514'; end if;
  perform hr_profile_set(x.subject_id, x.detail->>'field', x.detail->>'from', 'Undo of change ' || x.id);
 elsif x.action = 'chat.members' then
  perform chat_group_members((x.detail->>'groupId')::uuid, array(select jsonb_array_elements_text(x.detail->'removed'))::uuid[],
   array(select jsonb_array_elements_text(x.detail->'added'))::uuid[]);
 elsif x.action = 'feedback.status' then
  update app_feedback set status = x.detail->>'from', handled_by = current_viewer(), handled_at = now()
   where org_id = current_org() and id = x.subject_id and status = x.detail->>'to';
  if not found then raise exception 'Someone changed this since; nothing was undone' using errcode='23514'; end if;
 else raise exception 'This change cannot be undone (%)', x.action using errcode='23514';
 end if;
 update pulse_priv.app_change set undone_at = now(), undone_by = current_viewer() where id = x.id;
 return jsonb_build_object('changeId', x.id, 'status', 'undone', 'replayed', false);
end $$;

create function pulse.app_change_list(p_days int default 30) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('changeId', x.id, 'app', x.app, 'action', x.action, 'subjectId', x.subject_id,
   'subjectName', (select display_name from person where id = x.subject_id), 'detail', x.detail, 'at', x.created_at,
   'undoUntil', case when x.action in ('profile.correct','chat.members','feedback.status') then x.created_at + interval '7 days' end,
   'status', case when x.undone_at is not null then 'undone' else 'applied' end) order by x.created_at desc), '[]')
 from pulse_priv.app_change x where x.org_id = current_org() and x.actor_id = current_viewer() and x.created_at > now() - make_interval(days => least(greatest(p_days, 1), 90))
$$;

revoke all on function pulse.oauth_register(text,text,text[],text), pulse.oauth_client_peek(text), pulse.oauth_code_issue(text,text,text[],text,text),
  pulse.oauth_client_ok(text,text), pulse.oauth_tokens_make(uuid,text,text), pulse.oauth_exchange(text,text,text,text,text,text,text),
  pulse.oauth_refresh(text,text,text,text,text), pulse.oauth_revoke(text,text,text), pulse.oauth_my_grants(), pulse.oauth_grant_end(uuid),
  pulse.v1_person_principal(text,text), pulse.v1_person_token_live(text), pulse.app_change_add(text,uuid,jsonb),
  pulse.hr_profile_correct(uuid,text,text,text), pulse.app_change_undo(uuid), pulse.app_change_list(int) from public;
grant execute on function pulse.oauth_register(text,text,text[],text), pulse.oauth_client_peek(text), pulse.oauth_code_issue(text,text,text[],text,text),
  pulse.oauth_exchange(text,text,text,text,text,text,text), pulse.oauth_refresh(text,text,text,text,text), pulse.oauth_revoke(text,text,text),
  pulse.oauth_my_grants(), pulse.oauth_grant_end(uuid), pulse.v1_person_principal(text,text), pulse.v1_person_token_live(text),
  pulse.app_change_add(text,uuid,jsonb), pulse.hr_profile_correct(uuid,text,text,text), pulse.app_change_undo(uuid), pulse.app_change_list(int) to pulse_api;
-- migrate:down
-- Forward-only; end connections with pulse.oauth_grant_end or by revoking the client.
