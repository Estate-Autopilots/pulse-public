-- migrate:up
-- CONNECT-AI (owner, 23 Oct 2026): an organisation connects the AI its AI employees use, and the servers they run on.
--   ai_connection  a subscription it already pays for (Claude Pro/Max/Team through `claude setup-token`, ChatGPT through
--                  `codex login --device-auth`) or an API key of any provider (Anthropic, OpenAI, Gemini, OpenRouter,
--                  Groq, Mistral, DeepSeek, or any OpenAI-compatible address). Its secret (the long-lived token, the
--                  Codex sign-in, the API key) is sealed in the API with the document keyring (document-keys.ts:
--                  AES-256-GCM, its own data key, bound to the organisation and the connection) before it reaches the
--                  database; only the last four characters are kept in the clear, to tell keys apart.
--   ai_workspace   a server (VPS) the organisation's agents run on, reached over SSH with a key Pulse generates (or the
--                  organisation's deploy key), sealed the same way; its host key is pinned on the first check. The
--                  built-in Pulse cloud workspace (this server) is not a row: it is the default.
--   ai_setting     whether paid API keys may be added. Estate Autopilots runs on its Claude Max and Codex subscriptions
--                  only (the owner's rule), so paid API keys are off there; an OpenAI-compatible address (a self-hosted
--                  or local model) stays allowed.
-- An AI employee picks a connection (or this server's own sign-in, or the test runtime) and a workspace; its runs record
-- the connection they used, so a monthly token cap is kept per connection. Admins and leadership change all of this;
-- every change is audited (columns only, never values) and connect / disconnect / test are written as audit events.
-- Safe on a live install: additive (three tables, three columns, one wider check, five functions).

create table pulse.ai_workspace (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  host text not null check (host ~ '^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$'),
  port int not null default 22 check (port between 1 and 65535),
  username text not null check (username ~ '^[a-z_][a-z0-9_.-]{0,31}$'),
  key_source text not null check (key_source in ('generated','pasted')),
  public_key text not null check (length(public_key) between 20 and 2000),
  key_id text not null,
  key_wrapped bytea not null,
  key_sealed bytea not null,
  host_key text check (length(host_key) <= 2000),
  state text not null default 'new' check (state in ('new','ok','error')),
  facts jsonb not null default '{}'::jsonb,
  error text check (length(error) <= 300),
  checked_at timestamptz,
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  removed_at timestamptz
);
create index ai_workspace_org on pulse.ai_workspace (org_id, created_at) where removed_at is null;

create table pulse.ai_connection (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('subscription','api')),
  provider text not null check (provider in ('claude','codex','anthropic','openai','gemini','openrouter','groq','mistral','deepseek','custom')),
  name text not null check (length(btrim(name)) between 1 and 80),
  base_url text check (base_url is null or base_url ~ '^https?://[^[:space:]]{3,250}$'),
  account text check (length(account) <= 160),
  last4 text check (last4 ~ '^[A-Za-z0-9_-]{0,4}$'),
  secret_key_id text not null,
  secret_wrapped bytea not null,
  secret_sealed bytea not null,
  models text[] not null default '{}' check (cardinality(models) <= 400),
  default_model text check (default_model ~ '^[A-Za-z0-9._:/@-]{1,120}$'),
  workspace_id uuid references pulse.ai_workspace(id),
  monthly_token_cap bigint check (monthly_token_cap is null or monthly_token_cap between 1000 and 10000000000),
  state text not null default 'connected' check (state in ('connected','out_of_quota','expired','error')),
  state_detail text check (length(state_detail) <= 300),
  state_until timestamptz,
  checked_at timestamptz,
  created_by uuid references pulse.person(id),
  created_at timestamptz not null default now(),
  removed_at timestamptz
);
create index ai_connection_org on pulse.ai_connection (org_id, created_at) where removed_at is null;

create table pulse.ai_setting (
  org_id uuid primary key references pulse.org(id),
  paid_api_keys boolean not null default true,
  updated_by uuid references pulse.person(id),
  updated_at timestamptz not null default now()
);

-- Every company can read its own rows (the API keeps the sealed columns to itself); only its admins and leadership,
-- never an AI session, write them.
do $$
declare t text;
begin
  foreach t in array array['ai_workspace','ai_connection','ai_setting'] loop
    execute format('alter table pulse.%I enable row level security', t);
    execute format('alter table pulse.%I force row level security', t);
    execute format('create policy tenant on pulse.%I for select using (org_id = pulse.current_org())', t);
    execute format('create policy admins_write on pulse.%I for insert with check (org_id = pulse.current_org() and pulse.agent_session() is null and pulse.viewer_is(''admin'',''leadership''))', t);
    execute format('create policy admins_change on pulse.%I for update using (org_id = pulse.current_org() and pulse.agent_session() is null and pulse.viewer_is(''admin'',''leadership'')) with check (org_id = pulse.current_org())', t);
    -- The schema owner (the SECURITY DEFINER functions below, as 0956 does for agent keys) records a run's report.
    execute format('create policy definer on pulse.%I for all using (org_id = pulse.current_org() and current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = ''pulse''))', t);
    execute format('grant select, insert, update on pulse.%I to pulse_api', t);
    execute format('create trigger audit_mutation after insert or update or delete on pulse.%I for each row execute function pulse.audit_mutation()', t);
  end loop;
end $$;

-- Estate Autopilots: subscriptions only.
do $$
declare v_ea uuid;
begin
  select id into v_ea from pulse.org where handle = 'estateautopilots';
  if v_ea is null then return; end if;
  perform set_config('pulse.org_id', v_ea::text, true);
  insert into pulse.ai_setting (org_id, paid_api_keys) values (v_ea, false) on conflict do nothing;
  perform set_config('pulse.org_id', '', true);
end $$;

-- Which AI an AI employee uses and where it runs; which connection each run used.
alter table pulse.agent_member
  add column ai_connection_id uuid references pulse.ai_connection(id),
  add column ai_workspace_id uuid references pulse.ai_workspace(id);
alter table pulse.agent_member drop constraint agent_member_provider_check;
alter table pulse.agent_member add constraint agent_member_provider_check check (provider in ('codex','claude','stub','anthropic_api','openai_api','api'));
alter table pulse.agent_run add column connection_id uuid references pulse.ai_connection(id);
create index agent_run_connection_month on pulse.agent_run (connection_id, started_at) where connection_id is not null;

-- An audit event for what people do with a connection or workspace (connect, disconnect, test, verify). Never a value.
create function pulse.ai_audit(p_action text, p_resource text, p_id uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
  if p_action !~ '^ai\.[a-z_]{2,30}$' or p_resource not in ('ai_connection','ai_workspace','ai_setting') then raise exception 'Unknown AI audit action' using errcode='22023'; end if;
  if agent_session() is not null or not viewer_is('admin','leadership') then raise exception 'Admins and leadership connect AI' using errcode='42501'; end if;
  insert into audit_event(org_id, actor_id, actor_account, action, resource, resource_id, fields, source)
  values (current_org(), current_viewer(), nullif(current_setting('pulse.actor_account', true), ''), p_action, p_resource, p_id::text, '{}', 'pulse');
end $$;
revoke all on function pulse.ai_audit(text, text, uuid) from public;
grant execute on function pulse.ai_audit(text, text, uuid) to pulse_api;

-- Its AI, by whoever may change it (agent_manage_ok): this server's Claude or Codex sign-in, the test runtime, or one of
-- the organisation's live connections; and a workspace (null: the Pulse cloud workspace).
create function pulse.agent_ai_connect(p_agent uuid, p_choice text, p_connection uuid, p_workspace uuid) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c ai_connection;
begin
  if not agent_manage_ok(p_agent) then raise exception 'Admins, HR, leadership or its manager change an AI employee' using errcode='42501'; end if;
  if p_workspace is not null and not exists (select 1 from ai_workspace w where w.id = p_workspace and w.org_id = current_org() and w.removed_at is null) then
    raise exception 'Choose one of this organisation''s workspaces' using errcode='22023'; end if;
  perform agent_lock(p_agent);
  if p_choice in ('claude','codex','stub') then
    update agent_member set provider = p_choice, ai_connection_id = null, ai_workspace_id = p_workspace where person_id = p_agent;
  elsif p_choice = 'connection' then
    select * into c from ai_connection where id = p_connection and org_id = current_org() and removed_at is null;
    if not found then raise exception 'Connect an AI first, then choose it here' using errcode='22023'; end if;
    update agent_member set provider = case when c.kind = 'api' then 'api' else c.provider end, ai_connection_id = c.id,
      ai_workspace_id = coalesce(p_workspace, c.workspace_id) where person_id = p_agent;
  else
    raise exception 'Choose a connected AI' using errcode='22023';
  end if;
end $$;
revoke all on function pulse.agent_ai_connect(uuid, text, uuid, uuid) from public;
grant execute on function pulse.agent_ai_connect(uuid, text, uuid, uuid) to pulse_api;

-- Tokens a connection has used this calendar month (UTC), counted from the runs that used it.
create function pulse.ai_connection_used(p_connection uuid) returns bigint language sql stable security definer set search_path=pulse,pg_temp as $$
  select coalesce(sum(case when r.state in ('done','error') then coalesce(r.tokens, r.reserved) else r.reserved end), 0)::bigint
    from agent_run r where r.connection_id = p_connection and r.org_id = current_org() and r.started_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'
$$;
revoke all on function pulse.ai_connection_used(uuid) from public;
grant execute on function pulse.ai_connection_used(uuid) to pulse_api;

-- Inside a live run, the AI employee's runtime asks what to call: its connection (sealed secret, for the API to open)
-- and its workspace. Refused when the run is not live or not its own; 'cap' when the connection's monthly cap is used up.
create function pulse.agent_run_connection(p_run uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; m agent_member; c ai_connection; w ai_workspace; used bigint;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Ask inside the run' using errcode='42501'; end if;
  select * into m from agent_member where person_id = me;
  if m.ai_workspace_id is not null then
    select * into w from ai_workspace where id = m.ai_workspace_id and org_id = current_org() and removed_at is null;
  end if;
  if m.ai_connection_id is null then
    return jsonb_build_object('status', 'server', 'workspace', case when w.id is null then null else jsonb_build_object('id', w.id, 'host', w.host, 'port', w.port,
      'username', w.username, 'hostKey', w.host_key, 'keyId', w.key_id, 'keyWrapped', encode(w.key_wrapped, 'base64'), 'keySealed', encode(w.key_sealed, 'base64')) end);
  end if;
  select * into c from ai_connection where id = m.ai_connection_id and org_id = current_org() and removed_at is null;
  if not found then return jsonb_build_object('status', 'missing'); end if;
  used := ai_connection_used(c.id);
  if c.monthly_token_cap is not null and used >= c.monthly_token_cap then
    return jsonb_build_object('status', 'cap', 'used', used, 'cap', c.monthly_token_cap, 'until', date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' + interval '1 month');
  end if;
  update agent_run set connection_id = c.id where id = r.id;
  return jsonb_build_object('status', 'ok', 'connection', jsonb_build_object('id', c.id, 'kind', c.kind, 'provider', c.provider, 'baseUrl', c.base_url,
      'model', c.default_model, 'keyId', c.secret_key_id, 'wrapped', encode(c.secret_wrapped, 'base64'), 'sealed', encode(c.secret_sealed, 'base64'),
      'cap', c.monthly_token_cap, 'used', used),
    'workspace', case when w.id is null then null else jsonb_build_object('id', w.id, 'host', w.host, 'port', w.port, 'username', w.username, 'hostKey', w.host_key,
      'keyId', w.key_id, 'keyWrapped', encode(w.key_wrapped, 'base64'), 'keySealed', encode(w.key_sealed, 'base64')) end);
end $$;
revoke all on function pulse.agent_run_connection(uuid) from public;
grant execute on function pulse.agent_run_connection(uuid) to pulse_api;

-- The runtime reports how the connection did in this run (out of quota until, expired, error, or fine), and, when the
-- provider refreshed the sign-in (Codex rewrites its tokens), the newly sealed secret.
create function pulse.agent_connection_report(p_run uuid, p_state text, p_detail text, p_until timestamptz, p_key_id text, p_wrapped bytea, p_sealed bytea) returns void
language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and connection_id is not null and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Report inside the run' using errcode='42501'; end if;
  if p_state not in ('connected','out_of_quota','expired','error') then raise exception 'Unknown state' using errcode='22023'; end if;
  update ai_connection set state = p_state, state_detail = left(nullif(btrim(coalesce(p_detail, '')), ''), 300),
      state_until = case when p_state = 'out_of_quota' then least(p_until, now() + interval '40 days') end, checked_at = now(),
      secret_key_id = coalesce(p_key_id, secret_key_id), secret_wrapped = coalesce(p_wrapped, secret_wrapped), secret_sealed = coalesce(p_sealed, secret_sealed)
    where id = r.connection_id and org_id = current_org();
end $$;
revoke all on function pulse.agent_connection_report(uuid, text, text, timestamptz, text, bytea, bytea) from public;
grant execute on function pulse.agent_connection_report(uuid, text, text, timestamptz, text, bytea, bytea) to pulse_api;

-- migrate:down
drop function if exists pulse.agent_connection_report(uuid, text, text, timestamptz, text, bytea, bytea);
drop function if exists pulse.agent_run_connection(uuid);
drop function if exists pulse.ai_connection_used(uuid);
drop function if exists pulse.agent_ai_connect(uuid, text, uuid, uuid);
drop function if exists pulse.ai_audit(text, text, uuid);
drop index if exists pulse.agent_run_connection_month;
alter table pulse.agent_run drop column if exists connection_id;
alter table pulse.agent_member drop column if exists ai_connection_id, drop column if exists ai_workspace_id;
drop table if exists pulse.ai_setting;
drop table if exists pulse.ai_connection;
drop table if exists pulse.ai_workspace;
