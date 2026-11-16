-- migrate:up
-- CONNECTORS-CONTRACTS (owner, 6 Nov 2026: connectors "like Claude's and ChatGPT's: any kind of application can be
-- connected"): a company's admins connect remote MCP servers (and featured apps, Sales X-Ray first) in Settings →
-- Connectors, choose which tools are on and which writing tools may run without asking, and who may use them: people
-- (admins only, leadership and admins, or all staff) and AI employees (none, chosen ones, or all). The company's AI
-- employees and its people then use those tools from Vitals OS: API v1 / MCP (connectors.read / connectors.write), the
-- assistant and the screens. Design: docs/connectors/MCP-CONNECTORS.md.
--  * Secrets (a bearer token, an OAuth client secret, access and refresh tokens) are sealed in the API with the
--    company's document keyring (document-keys.ts, bound to the company and connector) and kept in pulse_priv; they never
--    reach a browser or a log, and no policy lets pulse_api read them: only pulse.mcp_connector_secret() does, for admins
--    and for a person or AI employee allowed to use the connector, inside the call.
--  * Every change to a connector is a row of pulse.mcp_connector_event (admins only), written by a trigger, so no change
--    escapes it. Every tool call is a row of pulse.mcp_tool_call (admins read all; a person reads their own).
--  * The outbound address is checked in the API like webhooks (https on 443, public addresses only, pinned after the
--    lookup, no redirects); the database keeps https only.

create table pulse.mcp_connector (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  app_key text check (app_key ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  label text not null check (length(btrim(label)) between 2 and 80 and label !~ '[[:cntrl:]]'),
  url text not null check (url ~ '^https://[^\s/?#@]+(/[^\s#]*)?$' and length(url) <= 500),
  auth_kind text not null check (auth_kind in ('oauth', 'bearer', 'none')),
  status text not null default 'needs_auth' check (status in ('needs_auth', 'connected', 'error', 'off', 'removed')),
  tools jsonb not null default '[]' check (jsonb_typeof(tools) = 'array' and jsonb_array_length(tools) <= 300),
  tools_at timestamptz,
  enabled_tools text[] not null default '{}' check (cardinality(enabled_tools) <= 300),
  auto_tools text[] not null default '{}' check (cardinality(auto_tools) <= 300 and auto_tools <@ enabled_tools),
  people_access text not null default 'admins' check (people_access in ('admins', 'leadership', 'staff')),
  ai_access text not null default 'none' check (ai_access in ('none', 'chosen', 'all')),
  ai_agents uuid[] not null default '{}' check (cardinality(ai_agents) <= 100),
  last_error text check (length(last_error) <= 300),
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index mcp_connector_url on pulse.mcp_connector(org_id, url) where status <> 'removed';

create table pulse_priv.mcp_connector_secret (
  org_id uuid not null references pulse.org(id),
  connector_id uuid primary key references pulse.mcp_connector(id),
  bearer jsonb check (bearer is null or bearer ?& array['k','w','d']),
  oauth jsonb check (oauth is null or jsonb_typeof(oauth) = 'object'),           -- endpoints and client id (no secret in clear)
  client_secret jsonb check (client_secret is null or client_secret ?& array['k','w','d']),
  access jsonb check (access is null or access ?& array['k','w','d']),
  access_expires_at timestamptz,
  refresh jsonb check (refresh is null or refresh ?& array['k','w','d']),
  scopes text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table pulse_priv.mcp_connector_attempt (
  org_id uuid not null references pulse.org(id),
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  connector_id uuid not null references pulse.mcp_connector(id),
  person_id uuid not null references pulse.person(id),
  verifier text not null check (verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  redirect_uri text not null check (length(redirect_uri) <= 512),
  expires_at timestamptz not null default now() + interval '10 minutes'
);

create table pulse.mcp_connector_event (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references pulse.mcp_connector(id),
  action text not null check (action in ('added', 'changed', 'tools', 'access', 'signed_in', 'secret', 'removed', 'status')),
  detail jsonb not null default '{}' check (jsonb_typeof(detail) = 'object'),
  actor_id uuid,
  actor_name text,
  at timestamptz not null default now()
);
create index mcp_connector_event_time on pulse.mcp_connector_event(org_id, connector_id, at desc);

create table pulse.mcp_tool_call (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  connector_id uuid not null references pulse.mcp_connector(id),
  tool text not null check (length(tool) between 1 and 128),
  actor_id uuid,
  actor_kind text not null check (actor_kind in ('person', 'ai')),
  via text not null check (via in ('screen', 'api', 'mcp', 'assistant')),
  writes boolean not null,
  confirmed boolean not null default false,
  outcome text not null check (outcome in ('ok', 'tool_error', 'refused', 'needs_confirm', 'failed')),
  ms int,
  detail text check (length(detail) <= 300),
  at timestamptz not null default now()
);
create index mcp_tool_call_time on pulse.mcp_tool_call(org_id, at desc);

-- ------------------------------------------------------------------------------------------------ who may
create function pulse.mcp_admin() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and agent_session() is null and not viewer_outside_seat()
   and exists(select 1 from person p where p.org_id = current_org() and p.id = current_viewer() and p.side = 'staff' and p.status = 'active')
   and viewer_is('admin')
$$;

-- May the viewer use this connector's tools: a person by people_access, an AI employee (with its own key) by ai_access.
create function pulse.mcp_can_use(p_connector uuid) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select coalesce((select c.status = 'connected' and (
     (p.side = 'staff' and agent_session() is null and (c.people_access = 'staff' or (c.people_access = 'leadership' and viewer_is('admin', 'leadership')) or viewer_is('admin')))
     or (p.side = 'agent' and (c.ai_access = 'all' or (c.ai_access = 'chosen' and p.id = any(c.ai_agents)))))
   from mcp_connector c join person p on p.org_id = c.org_id and p.id = current_viewer() and p.status = 'active'
   where c.org_id = current_org() and c.id = p_connector), false)
$$;

-- ------------------------------------------------------------------------------------------------ row security
alter table pulse.mcp_connector enable row level security;
alter table pulse.mcp_connector force row level security;
create policy tenant_isolation on pulse.mcp_connector using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy mcp_connector_see on pulse.mcp_connector as restrictive for select to pulse_api using (pulse.mcp_admin() or pulse.mcp_can_use(id));
create policy mcp_connector_insert on pulse.mcp_connector as restrictive for insert to pulse_api with check (pulse.mcp_admin() and created_by = pulse.current_viewer());
create policy mcp_connector_update on pulse.mcp_connector as restrictive for update to pulse_api using (pulse.mcp_admin()) with check (pulse.mcp_admin());

alter table pulse_priv.mcp_connector_secret enable row level security;
alter table pulse_priv.mcp_connector_secret force row level security;
create policy tenant_isolation on pulse_priv.mcp_connector_secret using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

alter table pulse_priv.mcp_connector_attempt enable row level security;
alter table pulse_priv.mcp_connector_attempt force row level security;
create policy tenant_isolation on pulse_priv.mcp_connector_attempt using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

alter table pulse.mcp_connector_event enable row level security;
alter table pulse.mcp_connector_event force row level security;
create policy tenant_isolation on pulse.mcp_connector_event using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy mcp_connector_event_see on pulse.mcp_connector_event as restrictive for select to pulse_api using (pulse.mcp_admin());

alter table pulse.mcp_tool_call enable row level security;
alter table pulse.mcp_tool_call force row level security;
create policy tenant_isolation on pulse.mcp_tool_call using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
create policy mcp_tool_call_see on pulse.mcp_tool_call as restrictive for select to pulse_api using (pulse.mcp_admin() or actor_id = pulse.current_viewer());

grant select, insert, update (label, status, tools, tools_at, enabled_tools, auto_tools, people_access, ai_access, ai_agents, last_error, updated_at)
  on pulse.mcp_connector to pulse_api;
grant select on pulse.mcp_connector_event, pulse.mcp_tool_call to pulse_api;

-- ------------------------------------------------------------------------------------------------ the admins' ledger
-- Every change to a connector, written here whatever made it (screens, API, a function); never a secret.
create function pulse.mcp_connector_log() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a text; d jsonb := '{}';
begin
 new.updated_at := now();
 if tg_op = 'INSERT' then
  a := 'added'; d := jsonb_build_object('label', new.label, 'url', new.url, 'auth', new.auth_kind, 'app', new.app_key);
 elsif new.status = 'removed' and old.status <> 'removed' then a := 'removed';
 elsif new.enabled_tools is distinct from old.enabled_tools or new.auto_tools is distinct from old.auto_tools then
  a := 'tools'; d := jsonb_build_object('enabled', to_jsonb(new.enabled_tools), 'auto', to_jsonb(new.auto_tools));
 elsif new.people_access is distinct from old.people_access or new.ai_access is distinct from old.ai_access or new.ai_agents is distinct from old.ai_agents then
  a := 'access'; d := jsonb_build_object('people', new.people_access, 'ai', new.ai_access, 'agents', cardinality(new.ai_agents));
 elsif new.status is distinct from old.status then a := 'status'; d := jsonb_build_object('from', old.status, 'to', new.status);
 elsif new.label is distinct from old.label then a := 'changed'; d := jsonb_build_object('label', new.label);
 else return new; -- a refreshed tool list with nothing else changed is not a change an admin made
 end if;
 insert into mcp_connector_event(org_id, connector_id, action, detail, actor_id, actor_name)
 values (new.org_id, new.id, a, d, current_viewer(), (select display_name from person where id = current_viewer()));
 return new;
end $$;
-- A change is logged before the update; the ledger row of an insert needs the connector row first (after insert, below).
create trigger mcp_connector_touch before update on pulse.mcp_connector for each row execute function pulse.mcp_connector_log();
create function pulse.mcp_connector_added() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 insert into mcp_connector_event(org_id, connector_id, action, detail, actor_id, actor_name)
 values (new.org_id, new.id, 'added', jsonb_build_object('label', new.label, 'url', new.url, 'auth', new.auth_kind, 'app', new.app_key), current_viewer(),
   (select display_name from person where id = current_viewer()));
 return null;
end $$;
create trigger mcp_connector_added after insert on pulse.mcp_connector for each row execute function pulse.mcp_connector_added();

-- ------------------------------------------------------------------------------------------------ secrets
-- The API's one door to a connector's sealed secrets: read (admins, and whoever may use it, inside their call), save
-- (admins; a refresh by a user of the connector), and the OAuth sign-in attempt (admins). Sealed values only.
create function pulse.mcp_connector_secret(op text, p_connector uuid, b jsonb default '{}') returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare s pulse_priv.mcp_connector_secret; a pulse_priv.mcp_connector_attempt; admin boolean := mcp_admin();
begin
 if not exists(select 1 from mcp_connector where org_id = current_org() and id = p_connector and status <> 'removed') then
  raise exception 'No such connector in this company' using errcode = 'P0002'; end if;
 if op in ('read', 'lock') then
  if not (admin or mcp_can_use(p_connector)) then raise exception 'You may not use this connector' using errcode = '42501'; end if;
  if op = 'lock' then select * into s from pulse_priv.mcp_connector_secret where org_id = current_org() and connector_id = p_connector for update;
  else select * into s from pulse_priv.mcp_connector_secret where org_id = current_org() and connector_id = p_connector; end if;
  if not found then return '{}'; end if;
  return jsonb_strip_nulls(jsonb_build_object('bearer', s.bearer, 'oauth', s.oauth, 'clientSecret', s.client_secret, 'access', s.access,
    'accessExpiresAt', s.access_expires_at, 'refresh', s.refresh, 'scopes', to_jsonb(s.scopes)));
 elsif op = 'tokens' then
  -- New tokens: from a sign-in (admins) or a refresh (anyone allowed to use it, inside their call).
  if not (admin or mcp_can_use(p_connector)) then raise exception 'You may not use this connector' using errcode = '42501'; end if;
  insert into pulse_priv.mcp_connector_secret(org_id, connector_id) values (current_org(), p_connector) on conflict (connector_id) do nothing;
  update pulse_priv.mcp_connector_secret set access = b->'access', access_expires_at = (b->>'accessExpiresAt')::timestamptz,
    refresh = coalesce(b->'refresh', refresh), scopes = coalesce(array(select jsonb_array_elements_text(b->'scopes')), scopes), updated_at = now()
   where org_id = current_org() and connector_id = p_connector;
  if b->>'signedIn' = 'true' then
   update mcp_connector set status = 'connected', last_error = null where org_id = current_org() and id = p_connector;
   insert into mcp_connector_event(org_id, connector_id, action, detail, actor_id, actor_name)
   values (current_org(), p_connector, 'signed_in', jsonb_build_object('scopes', b->'scopes'), current_viewer(), contract_actor_name());
  end if;
  return '{}';
 elsif not admin then raise exception 'Company admins manage connectors' using errcode = '42501';
 elsif op = 'bearer' then
  insert into pulse_priv.mcp_connector_secret(org_id, connector_id, bearer) values (current_org(), p_connector, b->'bearer')
   on conflict (connector_id) do update set bearer = excluded.bearer, updated_at = now();
  insert into mcp_connector_event(org_id, connector_id, action, detail, actor_id, actor_name)
  values (current_org(), p_connector, 'secret', jsonb_build_object('kind', 'bearer'), current_viewer(), contract_actor_name());
  return '{}';
 elsif op = 'client' then
  insert into pulse_priv.mcp_connector_secret(org_id, connector_id, oauth, client_secret) values (current_org(), p_connector, b->'oauth', b->'clientSecret')
   on conflict (connector_id) do update set oauth = excluded.oauth, client_secret = excluded.client_secret, updated_at = now();
  return '{}';
 elsif op = 'begin' then
  delete from pulse_priv.mcp_connector_attempt where org_id = current_org() and (expires_at <= now() or (person_id = current_viewer() and connector_id = p_connector));
  insert into pulse_priv.mcp_connector_attempt(org_id, state_hash, connector_id, person_id, verifier, redirect_uri)
  values (current_org(), b->>'stateHash', p_connector, current_viewer(), b->>'verifier', b->>'redirectUri');
  return '{}';
 elsif op = 'forget' then
  delete from pulse_priv.mcp_connector_secret where org_id = current_org() and connector_id = p_connector;
  return '{}';
 end if;
 raise exception 'Unknown connector operation' using errcode = '22023';
end $$;

-- The sign-in's way back: the attempt is used once, by the admin who started it, within 10 minutes.
create function pulse.mcp_connector_take(p_state_hash text) returns jsonb
 language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a pulse_priv.mcp_connector_attempt;
begin
 if not mcp_admin() then raise exception 'Company admins manage connectors' using errcode = '42501'; end if;
 delete from pulse_priv.mcp_connector_attempt where org_id = current_org() and state_hash = p_state_hash and person_id = current_viewer()
   and expires_at > clock_timestamp() returning * into a;
 if not found then return null; end if;
 return jsonb_build_object('connectorId', a.connector_id, 'verifier', a.verifier, 'redirectUri', a.redirect_uri);
end $$;

-- One tool call, audited: who (a person or an AI employee), which tool, whether it writes, confirmed, and how it ended.
create function pulse.mcp_tool_call_log(p_connector uuid, p_tool text, p_via text, p_writes boolean, p_confirmed boolean, p_outcome text, p_ms int, p_detail text)
 returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare cid uuid;
begin
 if current_viewer() is null then raise exception 'Sign in to use a connector' using errcode = '42501'; end if;
 insert into mcp_tool_call(org_id, connector_id, tool, actor_id, actor_kind, via, writes, confirmed, outcome, ms, detail)
 values (current_org(), p_connector, left(p_tool, 128), current_viewer(),
   case when (select side from person where org_id = current_org() and id = current_viewer()) = 'agent' then 'ai' else 'person' end,
   p_via, p_writes, p_confirmed, p_outcome, p_ms, left(p_detail, 300))
 returning id into cid;
 return cid;
end $$;

revoke all on function pulse.mcp_connector_log(), pulse.mcp_connector_added() from public;
grant execute on function pulse.mcp_admin(), pulse.mcp_can_use(uuid), pulse.mcp_connector_secret(text, uuid, jsonb), pulse.mcp_connector_take(text),
  pulse.mcp_tool_call_log(uuid, text, text, boolean, boolean, text, int, text) to pulse_api;

-- migrate:down
-- Forward-only.
