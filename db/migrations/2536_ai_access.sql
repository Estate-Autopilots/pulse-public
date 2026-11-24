-- migrate:up
-- AI-ACCESS (owner, 23 Nov 2026 16:55 IST): "When Claude is connected to Kazuk's account it should get every company his
-- account can access. Everyone who connects their Claude gets exactly what they are permitted to do. From one account I
-- should manage all of that."
--
-- 1. One connection = the person in every company where they hold an ACTIVE staff seat. An OAuth connection (Claude,
--    ChatGPT, the pulse CLI; 1412/1521) still lives in the company where the person pressed Allow (its "home"). A call
--    may now name another company (org: a handle, an id or the exact name, among the person's own seats only); the
--    principal function then makes THAT seat the viewer inside THAT company, so its row security, roles, API tier and
--    AI rules decide exactly as for the seat. No seat there (or not active, or not staff) is a refusal in plain words,
--    never a fallback to another company. The last company named is remembered on the connection
--    (oauth_grant.last_org) and is the default for the next call. A remembered company whose seat has since ended is
--    refused too (only tools/list and list_my_organisations fall back to the home company, so the AI can still see and
--    choose).
-- 2. AI rules per company: for the whole company, per role and per person (a person's own rule wins; among their
--    roles the most open one counts), owner/admin-managed. Five groups, each "on" (on its own), "ask" (needs a yes
--    first) or "off" (never), the same words AI employees' risk policy uses (1230: send/ask): read; work (tasks,
--    leads, quotes, docs, projects); messages; money; delete (and archive, cancel, undo). Default: everything on except
--    delete, which is off. Enforced once, at API v1's single dispatch point (v1.ts route()), for every person
--    connection (OAuth app or personal token), HTTP and MCP alike.
-- 3. "Needs a yes": the call is held in pulse.ai_access_request (what, which tool, a short summary, a hash of the exact
--    input) for the rule's approver (else the company's admins). After a yes, the same call with the same input goes
--    through once (within 24 hours). A no is told back to the AI.
-- 4. Audit: every v1 call already leaves a receipt in pulse_priv.v1_call (0695); it now also names the connection
--    (grant_id) and the AI rule that held or refused it (ai_rule), so Settings → AI access shows each connection's
--    actions per company.
-- Revoke marks a connection revoked (as Disconnect does); nothing is deleted.

-- ------------------------------------------------------------------------------------------------ 1. many companies
alter table pulse_priv.oauth_grant add column if not exists last_org uuid references pulse.org(id);

-- The account's active staff seat in an organisation (null: none). Reads the seat's person inside that organisation.
create or replace function pulse.ai_seat_in(p_account uuid, p_org uuid) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); seat uuid; ok boolean := false;
begin
  if p_account is null or p_org is null then return null; end if;
  select m.person_id into seat from pulse_priv.account_member m join org g on g.id = m.member_org and g.status = 'active'
   where m.account_id = p_account and m.member_org = p_org and m.kind = 'staff';
  if seat is null then return null; end if;
  perform set_config('pulse.org_id', p_org::text, true);
  select exists(select 1 from person p where p.id = seat and p.org_id = p_org and p.status = 'active' and p.side = 'staff') into ok;
  perform set_config('pulse.org_id', o, true);
  return case when ok then seat end;
end $$;

-- Which of the account's organisations a call names: its id, its handle (with or without @), its code or its exact name.
-- Only the account's own memberships are searched, so another company's existence is never revealed.
create or replace function pulse.ai_org_pick(p_account uuid, p_ask text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare a text := lower(btrim(coalesce(p_ask, ''))); ids uuid[];
begin
  if a = '' then return null; end if;
  a := ltrim(a, '@');
  select array_agg(distinct g.id) into ids from pulse_priv.account_member m join org g on g.id = m.member_org
   where m.account_id = p_account and g.status = 'active'
     and (g.id::text = a or lower(coalesce(g.handle, '')) = a or lower(coalesce(g.code, '')) = a or lower(btrim(g.name)) = a);
  if coalesce(cardinality(ids), 0) = 0 then
    raise exception '%', format('You are not in an organisation called %s. Call list_my_organisations to see yours, then pass its handle as org.',
      left(translate(btrim(p_ask), '(){}"', ''), 60)) using errcode = '42501';
  end if;
  if cardinality(ids) > 1 then
    raise exception 'More than one of your organisations has that name. Pass its handle or id as org: list_my_organisations shows them.' using errcode = '22023';
  end if;
  return ids[1];
end $$;

-- API v1 / MCP (1412, 1521) with the organisation the call names (p_org) or the connection remembers. p_lenient: a
-- remembered company whose seat ended falls back to the home company (tools/list and list_my_organisations only).
create or replace function pulse.v1_person_principal(p_token text, p_scope text, p_org text, p_lenient boolean) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.oauth_token; g pulse_priv.oauth_grant; app text; moved boolean := false; acct uuid; target uuid; seat uuid;
  ask text := nullif(btrim(coalesce(p_org, '')), ''); tname text;
begin
 if current_viewer() is not null or p_scope is null or not (p_scope = any(v1_scopes())) then return null; end if;
 select * into t from pulse_priv.oauth_token where token_sha256 = p_token and kind = 'access' and revoked_at is null and expires_at > now();
 if not found or not oauth_reach(t.org_id) then return null; end if;
 select * into g from pulse_priv.oauth_grant where id = t.grant_id and revoked_at is null and p_scope = any(scopes);
 if not found then return null; end if;
 -- Into the token's (home) space first: its people are read there; back if it is refused.
 if t.org_id <> current_org() then perform acct_enter(t.org_id, null); moved := true; end if;
 if not exists(select 1 from person where org_id = t.org_id and id = g.person_id and status = 'active' and side = 'staff') then
  if moved then perform acct_leave(); end if;
  return null;
 end if;
 select name into app from pulse_priv.oauth_client where client_id = g.client_id;
 perform set_config('pulse.viewer_id', g.person_id::text, true);
 if exists(select 1 from login_credential where person_id = g.person_id and status = 'disabled') then
  perform set_config('pulse.viewer_id', '', true);
  return null;
 end if;
 update pulse_priv.oauth_grant set last_used_at = now() where id = g.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
 -- AI-ACCESS: the company this call acts in.
 target := t.org_id; seat := g.person_id;
 if ask is not null or (g.last_org is not null and g.last_org <> t.org_id) then
  acct := (select account_id from pulse_priv.account_member where member_org = t.org_id and person_id = g.person_id);
  if ask is not null then
   if acct is null then
    if lower(ltrim(ask, '@')) not in (t.org_id::text, lower(coalesce((select handle from org where id = t.org_id), '')), lower(coalesce((select code from org where id = t.org_id), '')), lower(btrim((select name from org where id = t.org_id)))) then
     raise exception 'This connection works in one organisation only: you have no Pulse account with other companies yet.' using errcode = '42501';
    end if;
   else
    target := ai_org_pick(acct, ask);
   end if;
  else
   target := g.last_org;
  end if;
  if target <> t.org_id then
   seat := ai_seat_in(acct, target);
   if seat is null then
    if ask is null and p_lenient then target := t.org_id; seat := g.person_id;
    else
     select translate(name, '(){}"', '') into tname from org where id = target;
     raise exception '%', format('You have no active staff seat in %s, so this connection cannot act there. Call list_my_organisations to see where you can.',
       coalesce(tname, 'that organisation')) using errcode = '42501';
    end if;
   end if;
  end if;
  if ask is not null and target is distinct from coalesce(g.last_org, t.org_id) then
   update pulse_priv.oauth_grant set last_org = nullif(target, t.org_id) where id = g.id;
  end if;
 end if;
 if target <> t.org_id then
  perform set_config('pulse.org_id', target::text, true);
  perform set_config('pulse.viewer_id', seat::text, true);
  if exists(select 1 from login_credential where person_id = seat and status = 'disabled') then
   raise exception 'Your sign-in to that organisation is switched off, so this connection cannot act there.' using errcode = '42501';
  end if;
 end if;
 perform set_config('pulse.actor_account', 'app:' || app || ':' || coalesce((select username from people_profile where person_id = seat), seat::text), true);
 perform set_config('pulse.app_label', app, true);
 perform set_config('pulse.app_grant', g.id::text, true);
 perform set_config('pulse.app_home', t.org_id::text, true);
 return t.id;
end $$;
-- The 1412/1521 signature keeps working: the home company, or the one the connection remembers.
create or replace function pulse.v1_person_principal(p_token text, p_scope text) returns uuid
 language sql security definer set search_path=pulse,pg_temp as $$ select pulse.v1_person_principal(p_token, p_scope, null, false) $$;

-- The organisations the signed-in seat's account may act in through a connection: active staff seats only.
create or replace function pulse.ai_my_orgs() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare home text := nullif(current_setting('pulse.app_home', true), ''); r jsonb;
begin
  if current_viewer() is null then return '[]'::jsonb; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', s.seat_org, 'name', s.org_name, 'handle', s.org_handle, 'current', s.seat_org = current_org(),
      'home', s.seat_org::text = coalesce(home, current_org()::text)) order by (s.seat_org = current_org()) desc, s.org_name), '[]'::jsonb) into r
    from account_seats() s where s.seat_kind = 'staff' and ai_seat_in(account_of_viewer(), s.seat_org) is not null
       or (account_of_viewer() is null and s.seat_org = current_org());
  return r;
end $$;

-- ------------------------------------------------------------------------------------------------ 2. AI rules
create table pulse.ai_access_policy (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  role_key text check (role_key is null or role_key ~ '^[a-z_]{2,40}$'),
  person_id uuid references pulse.person(id),
  groups jsonb not null default '{}'::jsonb check (jsonb_typeof(groups) = 'object' and length(groups::text) <= 400),
  approver_person_id uuid references pulse.person(id),
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now(),
  check (role_key is null or person_id is null)
);
create unique index ai_access_policy_one on pulse.ai_access_policy(org_id, coalesce(role_key, ''), coalesce(person_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table pulse.ai_access_policy enable row level security;
alter table pulse.ai_access_policy force row level security;
create policy tenant_isolation on pulse.ai_access_policy using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse.ai_access_policy from public;
create trigger audit_mutation after insert or update or delete on pulse.ai_access_policy for each row execute function pulse.audit_mutation();

create or replace function pulse.ai_access_groups() returns text[] language sql immutable as $$ select array['read','work','messages','money','delete'] $$;
create or replace function pulse.ai_access_defaults() returns jsonb language sql immutable as $$
  select '{"read":"on","work":"on","messages":"on","money":"on","delete":"off"}'::jsonb $$;
create or replace function pulse.ai_access_rank(p text) returns int language sql immutable as $$ select case p when 'on' then 2 when 'ask' then 1 when 'off' then 0 end $$;

-- What an AI connection acting as this person may do in this organisation, and who says yes for it.
create or replace function pulse.ai_access_effective(p_person uuid) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare base jsonb; per pulse.ai_access_policy; out jsonb := '{}'::jsonb; grp text; v text; src text; ap uuid; roles text[];
begin
  select ai_access_defaults() || coalesce((select groups from ai_access_policy where org_id = current_org() and role_key is null and person_id is null), '{}'::jsonb) into base;
  select * into per from ai_access_policy where org_id = current_org() and person_id = p_person;
  select coalesce(array_agg(distinct r.role_key), '{}') into roles from role_assignment r
   where r.org_id = current_org() and r.person_id = p_person and current_date between r.valid_from and coalesce(r.valid_to, 'infinity');
  foreach grp in array ai_access_groups() loop
    v := per.groups->>grp; src := 'person';
    if v is null then
      select x.v into v from (select p.groups->>grp v from ai_access_policy p where p.org_id = current_org() and p.role_key = any(roles) and p.groups ? grp) x
       order by ai_access_rank(x.v) desc limit 1;
      src := 'role';
    end if;
    if v is null then v := base->>grp; src := case when base ? grp and (select groups ? grp from ai_access_policy where org_id = current_org() and role_key is null and person_id is null) then 'company' else 'default' end; end if;
    out := out || jsonb_build_object(grp, v, grp || 'From', src);
  end loop;
  ap := coalesce(per.approver_person_id,
    (select p.approver_person_id from ai_access_policy p where p.org_id = current_org() and p.role_key = any(roles) and p.approver_person_id is not null order by p.updated_at desc limit 1),
    (select approver_person_id from ai_access_policy where org_id = current_org() and role_key is null and person_id is null));
  return out || jsonb_build_object('approverId', ap);
end $$;

-- The signed-in account's seat in an organisation when that seat is an admin there (null otherwise): the owner console's
-- scope. In the organisation open now, the viewer itself.
create or replace function pulse.ai_admin_seat(p_org uuid) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare seat uuid; ok boolean;
begin
  if current_viewer() is null or p_org is null or agent_session() is not null or nullif(current_setting('pulse.app_grant', true), '') is not null then return null; end if;
  if p_org = current_org() then return case when viewer_is('admin') then current_viewer() end; end if;
  seat := ai_seat_in(account_of_viewer(), p_org);
  if seat is null then return null; end if;
  perform acct_enter(p_org, seat);
  ok := viewer_is('admin');
  perform acct_leave();
  return case when ok then seat end;
end $$;

create or replace function pulse.ai_access_policy_set(p_org uuid, p_role text, p_person uuid, p_groups jsonb, p_approver uuid, p_clear boolean) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare seat uuid := ai_admin_seat(p_org); k text; clean jsonb := '{}'::jsonb; r jsonb;
begin
  if seat is null then raise exception 'Only an admin of that company sets its AI rules' using errcode = '42501'; end if;
  if p_role is not null and p_person is not null then raise exception 'Choose a role or a person, not both' using errcode = '22023'; end if;
  if p_role is not null and p_role !~ '^[a-z_]{2,40}$' then raise exception 'Choose a role' using errcode = '22023'; end if;
  if not coalesce(p_clear, false) then
    if p_groups is null or jsonb_typeof(p_groups) <> 'object' then raise exception 'Choose what the AI may do' using errcode = '22023'; end if;
    for k in select jsonb_object_keys(p_groups) loop
      if not (k = any(ai_access_groups())) or not (p_groups->>k in ('on', 'ask', 'off')) then raise exception 'Each part is on, ask or off' using errcode = '22023'; end if;
      clean := clean || jsonb_build_object(k, p_groups->>k);
    end loop;
  end if;
  perform acct_enter(p_org, seat);
  begin
    if p_person is not null and not exists(select 1 from person where id = p_person and org_id = p_org and side = 'staff') then
      raise exception 'Choose a person in that company' using errcode = '22023'; end if;
    if p_approver is not null and not exists(select 1 from person where id = p_approver and org_id = p_org and status = 'active' and side = 'staff') then
      raise exception 'The approver is an active person in that company' using errcode = '22023'; end if;
    if coalesce(p_clear, false) then
      delete from ai_access_policy where org_id = p_org and role_key is not distinct from p_role and person_id is not distinct from p_person;
    else
      update ai_access_policy set groups = clean, approver_person_id = p_approver, updated_by = seat, updated_at = now()
       where org_id = p_org and role_key is not distinct from p_role and person_id is not distinct from p_person;
      if not found then
        insert into ai_access_policy(org_id, role_key, person_id, groups, approver_person_id, updated_by) values (p_org, p_role, p_person, clean, p_approver, seat);
      end if;
    end if;
    perform audit_write('ai_access_policy_set', 'ai_access_policy', coalesce(p_person::text, p_role, 'company'), array(select jsonb_object_keys(clean)));
    r := case when p_person is not null then ai_access_effective(p_person) else ai_access_defaults() || clean end;
  exception when others then perform acct_leave(); raise; end;
  perform acct_leave();
  return r;
end $$;

-- ------------------------------------------------------------------------------------------------ 3. "needs a yes"
create table pulse.ai_access_request (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  connection_kind text not null check (connection_kind in ('oauth', 'token')),
  connection_id uuid not null,
  person_id uuid not null references pulse.person(id),
  app text not null check (length(app) between 1 and 80),
  operation_id text not null check (operation_id ~ '^[a-z][A-Za-z0-9]*$'),
  tool text not null check (length(tool) between 1 and 80),
  tool_group text not null check (tool_group in ('read', 'work', 'messages', 'money', 'delete')),
  summary text not null check (length(summary) between 1 and 600),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  state text not null default 'waiting' check (state in ('waiting', 'approved', 'declined', 'used')),
  approver_person_id uuid references pulse.person(id),
  decided_by uuid references pulse.person(id),
  decided_at timestamptz,
  note text check (length(note) <= 500),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  used_at timestamptz
);
create index ai_access_request_waiting on pulse.ai_access_request(org_id, state, created_at desc);
create index ai_access_request_match on pulse.ai_access_request(org_id, connection_id, operation_id, input_hash);
alter table pulse.ai_access_request enable row level security;
alter table pulse.ai_access_request force row level security;
create policy tenant_isolation on pulse.ai_access_request using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse.ai_access_request from public;

-- On the call's own transaction, as its principal: an approved, unused request for this exact input lets the call through
-- once; otherwise the waiting (or newly filed) request is returned and the API refuses the call, keeping the request.
create or replace function pulse.ai_access_hold(p_operation text, p_tool text, p_group text, p_summary text, p_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare g text := nullif(current_setting('pulse.app_grant', true), ''); kind text; conn uuid; r pulse.ai_access_request; ap uuid;
begin
  if current_viewer() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if g is not null then kind := 'oauth'; conn := g::uuid;
  else kind := 'token'; conn := nullif(current_setting('pulse.v1_token_id', true), '')::uuid; end if;
  if conn is null then raise exception 'This key cannot ask for approval' using errcode = '42501'; end if;
  select * into r from ai_access_request where org_id = current_org() and connection_id = conn and operation_id = p_operation and input_hash = p_hash
     and state = 'approved' and expires_at > now() order by decided_at desc limit 1 for update;
  if found then
    update ai_access_request set state = 'used', used_at = now() where id = r.id;
    return jsonb_build_object('go', true, 'id', r.id);
  end if;
  select * into r from ai_access_request where org_id = current_org() and connection_id = conn and operation_id = p_operation and input_hash = p_hash
     and (state = 'waiting' and expires_at > now() or state = 'declined' and decided_at > now() - interval '24 hours') order by created_at desc limit 1;
  if found then
    return jsonb_build_object('go', false, 'id', r.id, 'state', r.state, 'note', r.note,
      'approver', (select display_name from person where id = coalesce(r.approver_person_id, r.decided_by)));
  end if;
  ap := (ai_access_effective(current_viewer())->>'approverId')::uuid;
  insert into ai_access_request(org_id, connection_kind, connection_id, person_id, app, operation_id, tool, tool_group, summary, input_hash, approver_person_id)
  values (current_org(), kind, conn, current_viewer(), left(coalesce(nullif(current_setting('pulse.app_label', true), ''), 'API key'), 80), p_operation, left(p_tool, 80),
    p_group, left(coalesce(nullif(btrim(p_summary), ''), p_tool), 600), p_hash, ap)
  returning * into r;
  return jsonb_build_object('go', false, 'id', r.id, 'state', 'waiting', 'new', true, 'approver', (select display_name from person where id = ap));
end $$;

-- An admin of the request's company (through their own seat there), or the approver the rule names, says yes or no.
create or replace function pulse.ai_access_decide(p_org uuid, p_request uuid, p_approve boolean, p_note text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare admin_seat uuid := ai_admin_seat(p_org); seat uuid; r pulse.ai_access_request;
begin
  if current_viewer() is null or agent_session() is not null or nullif(current_setting('pulse.app_grant', true), '') is not null then
    raise exception 'A person decides this in Pulse' using errcode = '42501'; end if;
  seat := coalesce(admin_seat, case when p_org = current_org() then current_viewer() else ai_seat_in(account_of_viewer(), p_org) end);
  if seat is null then raise exception 'That request is not yours to decide' using errcode = '42501'; end if;
  perform acct_enter(p_org, seat);
  begin
    select * into r from ai_access_request where org_id = p_org and id = p_request for update;
    if not found or (admin_seat is null and r.approver_person_id is distinct from seat) then raise exception 'That request is not yours to decide' using errcode = '42501'; end if;
    if r.state <> 'waiting' or r.expires_at <= now() then raise exception 'That request was already decided or has ended' using errcode = '22023'; end if;
    update ai_access_request set state = case when p_approve then 'approved' else 'declined' end, decided_by = seat, decided_at = now(),
      note = left(nullif(btrim(coalesce(p_note, '')), ''), 500), expires_at = case when p_approve then now() + interval '24 hours' else expires_at end
     where id = r.id;
    perform audit_write(case when p_approve then 'ai_access_approve' else 'ai_access_decline' end, 'ai_access_request', r.id::text, array[r.operation_id]);
  exception when others then perform acct_leave(); raise; end;
  perform acct_leave();
  return jsonb_build_object('id', r.id, 'state', case when p_approve then 'approved' else 'declined' end);
end $$;

-- ------------------------------------------------------------------------------------------------ 4. audit
alter table pulse_priv.v1_call add column if not exists grant_id uuid;
alter table pulse_priv.v1_call add column if not exists ai_rule text check (ai_rule is null or ai_rule in ('off', 'ask', 'approved'));
create index if not exists v1_call_grant on pulse_priv.v1_call(grant_id, recorded_at desc) where grant_id is not null;
create or replace function pulse.v1_call_audit(p_request uuid,p_org uuid,p_token uuid,p_principal uuid,p_kind text,p_operation text,p_route text,p_status int,p_key uuid,p_ms int,p_grant uuid,p_rule text)
returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 perform set_config('pulse.org_id',coalesce(p_org::text,''),true);
 insert into pulse_priv.v1_call(request_id,org_id,token_id,principal_id,principal_kind,operation_id,route_template,status,idempotency_key,latency_ms,grant_id,ai_rule)
 values(p_request,p_org,p_token,p_principal,p_kind,p_operation,p_route,p_status,p_key,p_ms,p_grant,case when p_rule in ('off','ask','approved') then p_rule end) on conflict do nothing;
end $$;

-- ------------------------------------------------------------------------------------------------ 5. the owner console
-- Connections of one account (every seat), read across its companies: id, home company, the seat, the app, when.
-- Reads each company with its own organisation set (and no viewer), then puts both back. Call it alone in a FROM clause
-- or a loop, never beside another table: it changes the organisation while it runs.
create or replace function pulse.ai_account_grants(p_account uuid)
  returns table(grant_id uuid, home_org uuid, home_name text, person_id uuid, person_name text, app text, scopes text[], created_at timestamptz, last_used_at timestamptz, last_org uuid)
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); vw text := coalesce(current_setting('pulse.viewer_id', true), '');
  sh text := coalesce(current_setting('pulse.shared_address', true), ''); seats jsonb; m jsonb;
begin
  if p_account is null then return; end if;
  select coalesce(jsonb_agg(jsonb_build_object('org', am.member_org, 'person', am.person_id, 'name', g.name)), '[]'::jsonb) into seats
    from pulse_priv.account_member am join org g on g.id = am.member_org and g.status = 'active' where am.account_id = p_account and am.kind = 'staff';
  for m in select * from jsonb_array_elements(seats) loop
    perform set_config('pulse.org_id', m->>'org', true);
    perform set_config('pulse.viewer_id', '', true);
    perform set_config('pulse.shared_address', '1', true);
    return query select x.id, x.org_id, (m->>'name')::text, x.person_id, (select display_name from person where id = x.person_id)::text,
        coalesce(c.name, 'App')::text, x.scopes, x.created_at, x.last_used_at, x.last_org
      from pulse_priv.oauth_grant x left join pulse_priv.oauth_client c on c.client_id = x.client_id
     where x.org_id = (m->>'org')::uuid and x.person_id = (m->>'person')::uuid and x.revoked_at is null;
    perform set_config('pulse.shared_address', sh, true);
  end loop;
  perform set_config('pulse.org_id', o, true);
  perform set_config('pulse.viewer_id', vw, true);
end $$;

-- What a connection did in one company: counts for the last 7 days and its latest calls (names and outcomes only).
create or replace function pulse.ai_grant_activity(p_org uuid, p_grant uuid, p_limit int) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o text := coalesce(current_setting('pulse.org_id', true), ''); r jsonb;
begin
  perform set_config('pulse.org_id', p_org::text, true);
  select jsonb_build_object(
      'calls7d', (select count(*) from pulse_priv.v1_call where org_id = p_org and grant_id = p_grant and recorded_at > now() - interval '7 days' and operation_id is distinct from 'mcpTransport'),
      'refused7d', (select count(*) from pulse_priv.v1_call where org_id = p_org and grant_id = p_grant and recorded_at > now() - interval '7 days' and status >= 400),
      'lastAt', (select max(recorded_at) from pulse_priv.v1_call where org_id = p_org and grant_id = p_grant),
      'recent', coalesce((select jsonb_agg(jsonb_build_object('at', x.recorded_at, 'operation', x.operation_id, 'status', x.status, 'rule', x.ai_rule) order by x.recorded_at desc)
         from (select recorded_at, operation_id, status, ai_rule from pulse_priv.v1_call where org_id = p_org and grant_id = p_grant
               and operation_id is distinct from 'mcpTransport' order by recorded_at desc limit greatest(0, least(coalesce(p_limit, 0), 100))) x), '[]'::jsonb)) into r;
  perform set_config('pulse.org_id', o, true);
  return r;
end $$;

-- A company's waiting and recent requests, read inside it (the caller has entered it).
create or replace function pulse.ai_requests_here(p_only_for uuid) returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'orgId', q.org_id, 'person', p.display_name, 'personId', q.person_id, 'app', q.app, 'tool', q.tool,
      'group', q.tool_group, 'summary', q.summary, 'state', case when q.state = 'waiting' and q.expires_at <= now() then 'expired' else q.state end,
      'createdAt', q.created_at, 'decidedAt', q.decided_at, 'approver', (select display_name from person where id = q.approver_person_id),
      'decidedBy', (select display_name from person where id = q.decided_by), 'note', q.note)
      order by (q.state = 'waiting' and q.expires_at > now()) desc, q.created_at desc), '[]'::jsonb)
    from (select * from ai_access_request r where r.org_id = current_org() and (p_only_for is null or (r.approver_person_id = p_only_for and r.state = 'waiting' and r.expires_at > now()))
          order by r.created_at desc limit 50) q join person p on p.id = q.person_id
$$;

-- Settings → AI access. "mine": the viewer's own connections (every company). "companies": each company the viewer's
-- account administers (its admin seat), with every connection that can act there, its rules and its requests.
-- "askingYou": requests in the viewer's other companies that name the viewer as the one who says yes.
create or replace function pulse.ai_access_console() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare acct uuid := account_of_viewer(); here uuid := current_org(); seats jsonb; s jsonb; sorg uuid; seat uuid; admins jsonb := '{}'::jsonb;
  cos jsonb := '[]'::jsonb; mine jsonb; asking jsonb := '[]'::jsonb; holders jsonb; h jsonb; gx record; conns jsonb; pol jsonb; ppl jsonb; rls jsonb;
begin
  if current_viewer() is null or agent_session() is not null or nullif(current_setting('pulse.app_grant', true), '') is not null then
    raise exception 'Sign in to Pulse in the browser' using errcode = '42501'; end if;
  -- The account's staff seats (without an account: this company only), and which of them are admin seats.
  select coalesce(jsonb_agg(jsonb_build_object('org', seat_org, 'name', org_name, 'handle', org_handle, 'person', seat_person)), '[]'::jsonb) into seats
    from account_seats() where seat_kind = 'staff' or acct is null;
  for s in select * from jsonb_array_elements(seats) loop
    seat := ai_admin_seat((s->>'org')::uuid);
    if seat is not null then admins := admins || jsonb_build_object(s->>'org', seat); end if;
  end loop;
  for s in select * from jsonb_array_elements(seats) loop
    sorg := (s->>'org')::uuid;
    if not admins ? (s->>'org') then
      -- Not an admin here: only the requests that name this seat as the approver.
      perform acct_enter(sorg, (s->>'person')::uuid);
      asking := asking || ai_requests_here((s->>'person')::uuid);
      perform acct_leave();
      continue;
    end if;
    seat := (admins->>(s->>'org'))::uuid;
    perform acct_enter(sorg, seat);
    -- Connections that can act here: made here, or made in another company by someone who has a staff seat here.
    select coalesce(jsonb_agg(jsonb_build_object('account', am.account_id, 'personId', p.id, 'person', p.display_name)), '[]'::jsonb) into holders
      from person p join pulse_priv.account_member am on am.person_id = p.id and am.member_org = sorg and am.kind = 'staff'
     where p.org_id = sorg and p.status = 'active' and p.side = 'staff';
    conns := '[]'::jsonb;
    for h in select * from jsonb_array_elements(holders) loop
      for gx in select * from ai_account_grants((h->>'account')::uuid) loop
        conns := conns || jsonb_build_array(jsonb_build_object('id', gx.grant_id, 'app', gx.app, 'personId', h->>'personId', 'person', h->>'person',
          'homeOrgId', gx.home_org, 'homeHere', gx.home_org = sorg, 'homeName', case when gx.home_org = sorg or admins ? gx.home_org::text then gx.home_name end,
          'canRevoke', gx.home_org = sorg, 'createdAt', gx.created_at, 'lastUsedAt', gx.last_used_at, 'scopes', to_jsonb(gx.scopes),
          'activity', ai_grant_activity(sorg, gx.grant_id, 5)));
      end loop;
    end loop;
    select jsonb_build_object(
        'company', (select jsonb_build_object('groups', groups, 'approverId', approver_person_id) from ai_access_policy where org_id = sorg and role_key is null and person_id is null),
        'roles', coalesce((select jsonb_agg(jsonb_build_object('roleKey', role_key, 'groups', groups, 'approverId', approver_person_id) order by role_key) from ai_access_policy where org_id = sorg and role_key is not null), '[]'::jsonb),
        'people', coalesce((select jsonb_agg(jsonb_build_object('personId', a.person_id, 'person', p.display_name, 'groups', a.groups, 'approverId', a.approver_person_id) order by p.display_name)
           from ai_access_policy a join person p on p.id = a.person_id where a.org_id = sorg and a.person_id is not null), '[]'::jsonb)) into pol;
    select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name,
        'roles', coalesce((select jsonb_agg(distinct r.role_key) from role_assignment r where r.org_id = sorg and r.person_id = p.id and current_date between r.valid_from and coalesce(r.valid_to, 'infinity')), '[]'::jsonb))
        order by p.display_name), '[]'::jsonb) into ppl
      from (select id, display_name from person where org_id = sorg and status = 'active' and side = 'staff' order by display_name limit 500) p;
    select coalesce(jsonb_agg(distinct r.role_key), '[]'::jsonb) into rls from role_assignment r where r.org_id = sorg and current_date between r.valid_from and coalesce(r.valid_to, 'infinity');
    cos := cos || jsonb_build_array(jsonb_build_object('id', sorg, 'name', s->>'name', 'handle', s->>'handle', 'current', sorg = here,
      'connections', conns, 'policy', pol, 'people', ppl, 'roles', rls, 'requests', ai_requests_here(null), 'defaults', ai_access_defaults()));
    perform acct_leave();
  end loop;
  -- The viewer's own connections, in every company.
  if acct is not null then
    select coalesce(jsonb_agg(jsonb_build_object('id', x.grant_id, 'app', x.app, 'homeOrgId', x.home_org, 'homeName', x.home_name, 'createdAt', x.created_at,
        'lastUsedAt', x.last_used_at, 'scopes', to_jsonb(x.scopes), 'usesOrg', coalesce(x.last_org, x.home_org)) order by x.last_used_at desc nulls last), '[]'::jsonb) into mine
      from ai_account_grants(acct) x;
  else
    select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'app', coalesce(c.name, 'App'), 'homeOrgId', g.org_id, 'homeName', (select name from org where id = g.org_id), 'createdAt', g.created_at,
        'lastUsedAt', g.last_used_at, 'scopes', to_jsonb(g.scopes), 'usesOrg', g.org_id)), '[]'::jsonb) into mine
      from pulse_priv.oauth_grant g left join pulse_priv.oauth_client c on c.client_id = g.client_id where g.org_id = here and g.person_id = current_viewer() and g.revoked_at is null;
  end if;
  return jsonb_build_object('companies', cos, 'mine', mine, 'askingYou', asking,
    'myOrgs', (select coalesce(jsonb_agg(jsonb_build_object('id', e->>'org', 'name', e->>'name', 'handle', e->>'handle')), '[]'::jsonb) from jsonb_array_elements(seats) e),
    'myRules', ai_access_effective(current_viewer()));
end $$;

-- One connection's latest calls in one company (the console's "What it did"): an admin of that company, or its own person.
create or replace function pulse.ai_access_log(p_org uuid, p_grant uuid) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare acct uuid := account_of_viewer(); ok boolean;
begin
  ok := ai_admin_seat(p_org) is not null or exists(select 1 from ai_account_grants(acct) x where x.grant_id = p_grant);
  if not ok then raise exception 'That connection is not yours to see' using errcode = '42501'; end if;
  return ai_grant_activity(p_org, p_grant, 30);
end $$;

-- Revoke (mark revoked; never deleted): the connection's own person from any of their companies, or an admin of the
-- company where it was made. An admin of another company where it can act turns AI off for that person there instead.
create or replace function pulse.ai_access_revoke(p_org uuid, p_grant uuid) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare acct uuid := account_of_viewer(); admin_seat uuid := ai_admin_seat(p_org); own boolean; sh text := coalesce(current_setting('pulse.shared_address', true), '');
  o text := coalesce(current_setting('pulse.org_id', true), ''); n int;
begin
  if current_viewer() is null or agent_session() is not null or nullif(current_setting('pulse.app_grant', true), '') is not null then
    raise exception 'A person disconnects apps in Pulse' using errcode = '42501'; end if;
  own := exists(select 1 from ai_account_grants(acct) x where x.grant_id = p_grant) or (acct is null and exists(select 1 from pulse_priv.oauth_grant where org_id = current_org() and id = p_grant and person_id = current_viewer()));
  if not own and admin_seat is null then raise exception 'That connection is not yours to end' using errcode = '42501'; end if;
  perform set_config('pulse.shared_address', '1', true);
  update pulse_priv.oauth_grant set revoked_at = now(), revoked_reason = case when own then 'person_disconnected' else 'admin_revoked' end
   where id = p_grant and revoked_at is null and (own or org_id = p_org);
  get diagnostics n = row_count;
  perform set_config('pulse.shared_address', sh, true);
  if n = 0 then return false; end if;
  if not own then
    perform acct_enter(p_org, admin_seat);
    perform audit_write('ai_access_revoke', 'oauth_grant', p_grant::text);
    perform acct_leave();
  else
    perform audit_write('ai_access_revoke', 'oauth_grant', p_grant::text);
  end if;
  perform set_config('pulse.org_id', o, true);
  return true;
end $$;

revoke all on function pulse.ai_seat_in(uuid, uuid), pulse.ai_org_pick(uuid, text), pulse.v1_person_principal(text, text, text, boolean), pulse.ai_my_orgs(),
  pulse.ai_access_effective(uuid), pulse.ai_admin_seat(uuid), pulse.ai_access_policy_set(uuid, text, uuid, jsonb, uuid, boolean),
  pulse.ai_access_hold(text, text, text, text, text), pulse.ai_access_decide(uuid, uuid, boolean, text),
  pulse.v1_call_audit(uuid,uuid,uuid,uuid,text,text,text,int,uuid,int,uuid,text), pulse.ai_account_grants(uuid), pulse.ai_grant_activity(uuid, uuid, int),
  pulse.ai_requests_here(uuid), pulse.ai_access_console(), pulse.ai_access_log(uuid, uuid), pulse.ai_access_revoke(uuid, uuid) from public;
grant execute on function pulse.v1_person_principal(text, text, text, boolean), pulse.ai_my_orgs(), pulse.ai_access_effective(uuid),
  pulse.ai_access_policy_set(uuid, text, uuid, jsonb, uuid, boolean), pulse.ai_access_hold(text, text, text, text, text), pulse.ai_access_decide(uuid, uuid, boolean, text),
  pulse.v1_call_audit(uuid,uuid,uuid,uuid,text,text,text,int,uuid,int,uuid,text), pulse.ai_access_console(), pulse.ai_access_log(uuid, uuid), pulse.ai_access_revoke(uuid, uuid) to pulse_api;

-- migrate:down
revoke all on function pulse.v1_person_principal(text, text, text, boolean) from pulse_api;
drop function if exists pulse.ai_access_revoke(uuid, uuid), pulse.ai_access_log(uuid, uuid), pulse.ai_access_console(), pulse.ai_requests_here(uuid), pulse.ai_grant_activity(uuid, uuid, int),
  pulse.ai_account_grants(uuid), pulse.ai_access_decide(uuid, uuid, boolean, text), pulse.ai_access_hold(text, text, text, text, text),
  pulse.ai_access_policy_set(uuid, text, uuid, jsonb, uuid, boolean), pulse.ai_admin_seat(uuid), pulse.ai_access_effective(uuid),
  pulse.v1_call_audit(uuid,uuid,uuid,uuid,text,text,text,int,uuid,int,uuid,text), pulse.ai_my_orgs();
drop table if exists pulse.ai_access_request, pulse.ai_access_policy;
drop function if exists pulse.ai_access_rank(text), pulse.ai_access_defaults(), pulse.ai_access_groups();
drop index if exists pulse_priv.v1_call_grant;
alter table pulse_priv.v1_call drop column if exists ai_rule, drop column if exists grant_id;
-- The 1521 principal, as it was.
create or replace function pulse.v1_person_principal(p_token text, p_scope text) returns uuid
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare t pulse_priv.oauth_token; g pulse_priv.oauth_grant; app text; moved boolean := false;
begin
 if current_viewer() is not null or p_scope is null or not (p_scope = any(v1_scopes())) then return null; end if;
 select * into t from pulse_priv.oauth_token where token_sha256 = p_token and kind = 'access' and revoked_at is null and expires_at > now();
 if not found or not oauth_reach(t.org_id) then return null; end if;
 select * into g from pulse_priv.oauth_grant where id = t.grant_id and revoked_at is null and p_scope = any(scopes);
 if not found then return null; end if;
 if t.org_id <> current_org() then perform acct_enter(t.org_id, null); moved := true; end if;
 if not exists(select 1 from person where org_id = t.org_id and id = g.person_id and status = 'active' and side = 'staff') then
  if moved then perform acct_leave(); end if;
  return null;
 end if;
 select name into app from pulse_priv.oauth_client where client_id = g.client_id;
 perform set_config('pulse.viewer_id', g.person_id::text, true);
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
drop function if exists pulse.v1_person_principal(text, text, text, boolean), pulse.ai_org_pick(uuid, text), pulse.ai_seat_in(uuid, uuid);
alter table pulse_priv.oauth_grant drop column if exists last_org;
