-- migrate:up
-- SERVERS-AI (5 Nov 2026): Pulse Runner, "Connect a server" (contract: docs/runner/PROTOCOL.md, v1). An organisation's
-- admin pairs one of its own Linux servers with a short code; the server then asks Pulse for work over HTTPS (outbound
-- only), runs jobs with the organisation's own Claude Code / Codex sign-in in its sandbox, and sends back events,
-- output files and one result per job. Pulse decides what runs (and approves write/shell work); the server decides how.
--
--  * pulse.runner                    one paired server: name, status, last seen, the allow-listed capabilities it reported.
--  * pulse_priv.runner_pair_code     the 10-minute, single-use pairing codes (SHA-256 of the code only).
--  * pulse_priv.runner_credential    the server's credential (prc_…), SHA-256 only, revocable.
--  * pulse.runner_job                one job (kind, prompt or command, profile, approval, limits, status, usage, result).
--  * pulse.runner_job_event          the job's event stream, deduplicated on (job, seq).
--  * pulse_priv.runner_job_output    the declared output files the server uploaded (hash checked by the API).
--  * pulse_priv.runner_mcp_token     the per-job Pulse MCP token (pmt_…), SHA-256 only, scoped to the org, the job and
--                                    the person who asked, read scopes only, living the job's time limit plus 5 minutes.
--
-- Row security: every table is per organisation (tenant policy). Through the API (pulse_api) a row is reached only by an
-- organisation admin signed in as a person (never an AI employee's session) or by the server it belongs to, which the
-- API names only after pulse.runner_session() checked the credential (pulse.runner_id, set by that function). Codes,
-- credentials and MCP tokens have no runtime grants at all: SECURITY DEFINER functions below are the only way in, and
-- the "directory" policies let them (as the schema owner) find a code's, credential's or token's organisation first.

create function pulse.current_runner() returns text language sql stable as $$
  select nullif(current_setting('pulse.runner_id', true), '')
$$;
-- An organisation admin as a person: an AI chief of staff (viewer_is('admin') with an agent session) does not manage servers.
create function pulse.runner_admin() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and coalesce(current_setting('pulse.agent_session', true), '') <> 'on' and viewer_is('admin')
$$;

-- ------------------------------------------------------------------------------------------------------- servers
create table pulse.runner (
  org_id uuid not null references pulse.org(id),
  id text primary key check (id ~ '^run_[0-9a-f]{32}$'),
  name text not null check (length(btrim(name)) between 1 and 80 and name !~ '[[:cntrl:]]'),
  hostname text check (hostname is null or (length(hostname) <= 255 and hostname !~ '[[:cntrl:]]')),
  os text check (os is null or length(os) <= 40), arch text check (arch is null or length(arch) <= 40),
  version text check (version is null or length(version) <= 40),
  status text not null default 'active' check (status in ('active', 'revoked', 'removed')),
  state text not null default 'ready' check (state in ('ready', 'draining')),
  max_concurrent int not null default 1 check (max_concurrent between 0 and 64),
  uptime_sec bigint check (uptime_sec is null or uptime_sec >= 0),
  capabilities jsonb not null default '{}' check (jsonb_typeof(capabilities) = 'object' and pg_column_size(capabilities) < 16384),
  capabilities_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid references pulse.person(id),
  revoked_at timestamptz, revoked_by uuid references pulse.person(id),
  unique (org_id, id)
);
create index runner_org on pulse.runner (org_id, status);

-- ------------------------------------------------------------------------------------------------------- pairing
create table pulse_priv.runner_pair_code (
  org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references pulse.person(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  used_at timestamptz, runner_id text,
  foreign key (org_id, runner_id) references pulse.runner(org_id, id)
);
create table pulse_priv.runner_credential (
  org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
  runner_id text not null, secret_hash text not null unique check (secret_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(), last_used_at timestamptz, revoked_at timestamptz,
  foreign key (org_id, runner_id) references pulse.runner(org_id, id)
);

-- ------------------------------------------------------------------------------------------------------- jobs
create table pulse.runner_job (
  org_id uuid not null references pulse.org(id),
  id text primary key check (id ~ '^job_[0-9a-f]{32}$'),
  runner_id text not null,
  kind text not null check (kind in ('claude', 'codex', 'shell-safe')),
  prompt text check (prompt is null or octet_length(prompt) between 1 and 1048576),
  command text[] check (command is null or cardinality(command) between 1 and 16),
  profile text not null default 'read-only' check (profile in ('read-only', 'write', 'shell')),
  approval jsonb check (approval is null or (jsonb_typeof(approval) = 'object' and pg_column_size(approval) < 2048)),
  model text check (model is null or model ~ '^[A-Za-z0-9._:\-\[\]]{1,100}$'),
  time_limit_sec int not null check (time_limit_sec between 1 and 14400),
  cost_cap_usd numeric(10, 2) check (cost_cap_usd is null or cost_cap_usd > 0),
  outputs jsonb not null default '[]' check (jsonb_typeof(outputs) = 'array' and jsonb_array_length(outputs) <= 20),
  dry_run boolean not null default false,
  requested_by uuid not null references pulse.person(id),
  status text not null default 'queued'
    check (status in ('queued', 'delivered', 'running', 'cancelling', 'succeeded', 'failed', 'timed_out', 'cancelled', 'rejected')),
  attempts int not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  delivered_at timestamptz, acked_at timestamptz, started_at timestamptz, finished_at timestamptz,
  cancel_requested_at timestamptz, cancel_requested_by uuid references pulse.person(id), cancel_sent_at timestamptz, cancel_acked_at timestamptz,
  missing_since timestamptz,
  last_state text check (last_state is null or last_state in ('accepted', 'running', 'stopping', 'uploading')),
  exit_code int, signal text check (signal is null or length(signal) <= 20),
  error_code text check (error_code is null or error_code ~ '^[a-z_]{1,40}$'),
  error_message text check (error_message is null or length(error_message) <= 500),
  duration_ms bigint check (duration_ms is null or duration_ms >= 0),
  usage jsonb check (usage is null or (jsonb_typeof(usage) = 'object' and pg_column_size(usage) < 2048)),
  cost_usd numeric(12, 4),
  audit jsonb check (audit is null or (jsonb_typeof(audit) = 'object' and pg_column_size(audit) < 4096)),
  result_outputs jsonb check (result_outputs is null or (jsonb_typeof(result_outputs) = 'array' and jsonb_array_length(result_outputs) <= 20)),
  event_count int not null default 0,
  check ((kind = 'shell-safe') = (command is not null)),
  check (kind = 'shell-safe' or (prompt is not null and cost_cap_usd is not null)),
  check (kind <> 'shell-safe' or prompt is null),
  check (profile = 'read-only' or approval is not null),
  foreign key (org_id, runner_id) references pulse.runner(org_id, id),
  unique (org_id, id)
);
create index runner_job_runner on pulse.runner_job (org_id, runner_id, status);
create index runner_job_recent on pulse.runner_job (org_id, created_at desc);

create table pulse.runner_job_event (
  org_id uuid not null, job_id text not null, runner_id text not null,
  seq int not null check (seq between 1 and 2000000000),
  ts timestamptz,
  type text not null check (type in ('status', 'agent', 'log', 'usage', 'limits', 'warning', 'dry_run')),
  data jsonb not null default '{}' check (pg_column_size(data) < 65536),
  received_at timestamptz not null default now(),
  primary key (job_id, seq),
  foreign key (org_id, job_id) references pulse.runner_job(org_id, id) on delete cascade
);
create index runner_job_event_org on pulse.runner_job_event (org_id, job_id, seq);

create table pulse_priv.runner_job_output (
  org_id uuid not null, id text primary key check (id ~ '^out_[0-9a-f]{32}$'),
  job_id text not null, runner_id text not null,
  path text not null check (length(path) between 1 and 512 and path !~ '[[:cntrl:]]'),
  bytes bigint not null check (bytes >= 0), sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  content bytea not null check (octet_length(content) <= 8388608),
  created_at timestamptz not null default now(),
  unique (job_id, path),
  foreign key (org_id, job_id) references pulse.runner_job(org_id, id) on delete cascade
);

create table pulse_priv.runner_mcp_token (
  org_id uuid not null, id uuid primary key default gen_random_uuid(),
  job_id text not null, token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  person_id uuid not null references pulse.person(id),
  scopes text[] not null check (cardinality(scopes) between 1 and 40),
  created_at timestamptz not null default now(), expires_at timestamptz not null, revoked_at timestamptz,
  foreign key (org_id, job_id) references pulse.runner_job(org_id, id) on delete cascade
);
create index runner_mcp_token_job on pulse_priv.runner_mcp_token (org_id, job_id);

-- ------------------------------------------------------------------------------------------------------- row security
do $$ declare t text; begin
  foreach t in array array['pulse.runner', 'pulse.runner_job', 'pulse.runner_job_event', 'pulse_priv.runner_pair_code',
                           'pulse_priv.runner_credential', 'pulse_priv.runner_job_output', 'pulse_priv.runner_mcp_token'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy tenant_isolation on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  end loop;
end $$;
-- The API reaches a server's rows as an organisation admin, or as that server (named by pulse.runner_session()).
create policy runner_scope on pulse.runner as restrictive to pulse_api
  using (pulse.runner_admin() or id = pulse.current_runner()) with check (pulse.runner_admin() or id = pulse.current_runner());
create policy runner_scope on pulse.runner_job as restrictive to pulse_api
  using (pulse.runner_admin() or runner_id = pulse.current_runner()) with check (pulse.runner_admin() or runner_id = pulse.current_runner());
-- Only an admin asks for work; the server never adds a job.
create policy admin_insert on pulse.runner_job as restrictive for insert to pulse_api with check (pulse.runner_admin());
create policy runner_scope on pulse.runner_job_event as restrictive to pulse_api
  using (pulse.runner_admin() or runner_id = pulse.current_runner()) with check (runner_id = pulse.current_runner());
create policy runner_scope on pulse_priv.runner_job_output as restrictive to pulse_api
  using (pulse.runner_admin() or runner_id = pulse.current_runner()) with check (runner_id = pulse.current_runner());
grant select, update (name, hostname, os, arch, version, state, max_concurrent, uptime_sec, capabilities, capabilities_at, last_seen_at) on pulse.runner to pulse_api;
grant select, insert, update on pulse.runner_job to pulse_api;
grant select, insert on pulse.runner_job_event to pulse_api;
grant select, insert, update on pulse_priv.runner_job_output to pulse_api;
-- The SECURITY DEFINER functions (the schema owner) find which organisation a code, credential or token belongs to.
create policy directory on pulse_priv.runner_pair_code for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));
create policy directory on pulse_priv.runner_credential for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));
create policy directory on pulse_priv.runner_mcp_token for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));

-- ------------------------------------------------------------------------------------------------------- functions
-- An admin makes a pairing code (the API makes the code and sends its hash; the code itself is shown once).
create function pulse.runner_pair_code_create(p_hash text) returns timestamptz
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare until timestamptz;
begin
  if not runner_admin() then raise exception 'Servers are connected by organisation admins' using errcode = '42501'; end if;
  if p_hash !~ '^[0-9a-f]{64}$' then raise exception 'Unknown code' using errcode = '22023'; end if;
  delete from pulse_priv.runner_pair_code where org_id = current_org() and used_at is null and expires_at < now() - interval '1 day';
  if (select count(*) from pulse_priv.runner_pair_code where org_id = current_org() and used_at is null and expires_at > now()) >= 5 then
    raise exception 'Five codes are already waiting. Use one, or wait ten minutes.' using errcode = '54000';
  end if;
  insert into pulse_priv.runner_pair_code(org_id, code_hash, created_by) values (current_org(), p_hash, current_viewer())
    returning expires_at into until;
  return until;
end $$;

-- Codes waiting to be used (how many and until when; never the code).
create function pulse.runner_pair_code_live() returns jsonb
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select case when runner_admin() then jsonb_build_object('waiting', count(*), 'until', max(expires_at)) else null end
    from pulse_priv.runner_pair_code where org_id = current_org() and used_at is null and expires_at > now()
$$;

-- The server pairs (no sign-in): the code's organisation, then once: a server row and its credential. A wrong code, an
-- expired one and a used one each say so (the API maps them to 404 invalid_code, 410 expired_code, 409 code_used).
create function pulse.runner_pair(p_code_hash text, p_secret_hash text, p_hostname text, p_os text, p_arch text, p_version text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare o uuid; p pulse_priv.runner_pair_code%rowtype; rid text; nm text; ostatus text;
begin
  -- Like resolve_route: the code names the organisation before any is set, never a hop out of one.
  if current_viewer() is not null or coalesce(current_setting('pulse.org_id', true), '') <> '' or p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Pairing takes no sign-in' using errcode = '42501';
  end if;
  select org_id into o from pulse_priv.runner_pair_code where code_hash = p_code_hash;
  if o is null then return jsonb_build_object('status', 'invalid'); end if;
  perform set_config('pulse.org_id', o::text, true);
  select * into p from pulse_priv.runner_pair_code where org_id = o and code_hash = p_code_hash for update;
  if p.used_at is not null then return jsonb_build_object('status', 'used'); end if;
  if p.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  select status into ostatus from org where id = o;
  if ostatus is distinct from 'active' then return jsonb_build_object('status', 'invalid'); end if;
  if (select count(*) from runner where org_id = o and status = 'active') >= 20 then return jsonb_build_object('status', 'limit'); end if;
  rid := 'run_' || replace(gen_random_uuid()::text, '-', '');
  nm := coalesce(nullif(btrim(left(regexp_replace(coalesce(p_hostname, ''), '[[:cntrl:]]', '', 'g'), 80)), ''), 'Server');
  insert into runner(org_id, id, name, hostname, os, arch, version, created_by, last_seen_at)
    values (o, rid, nm, nullif(left(regexp_replace(coalesce(p_hostname, ''), '[[:cntrl:]]', '', 'g'), 255), ''), left(p_os, 40), left(p_arch, 40), left(p_version, 40), p.created_by, now());
  insert into pulse_priv.runner_credential(org_id, runner_id, secret_hash) values (o, rid, p_secret_hash);
  update pulse_priv.runner_pair_code set used_at = now(), runner_id = rid where id = p.id;
  return jsonb_build_object('status', 'ok', 'runnerId', rid, 'orgId', o, 'orgName', (select name from org where id = o));
end $$;

-- Every call of a paired server: its credential's organisation and server, or 'revoked' / 'unknown'. On 'ok' the
-- organisation and pulse.runner_id are set for the rest of the transaction and the server counts as seen.
create function pulse.runner_session(p_secret_hash text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c pulse_priv.runner_credential%rowtype; r runner%rowtype; ostatus text;
begin
  if current_viewer() is not null or coalesce(current_setting('pulse.org_id', true), '') <> '' or current_runner() is not null then
    raise exception 'A server call carries its own credential only' using errcode = '42501';
  end if;
  select * into c from pulse_priv.runner_credential where secret_hash = p_secret_hash;
  if c.id is null then return jsonb_build_object('status', 'unknown'); end if;
  perform set_config('pulse.org_id', c.org_id::text, true);
  select * into r from runner where org_id = c.org_id and id = c.runner_id;
  if c.revoked_at is not null or r.status is distinct from 'active' then
    perform set_config('pulse.org_id', '', true);
    return jsonb_build_object('status', 'revoked');
  end if;
  select status into ostatus from org where id = c.org_id;
  if ostatus is distinct from 'active' then perform set_config('pulse.org_id', '', true); return jsonb_build_object('status', 'unavailable'); end if;
  perform set_config('pulse.runner_id', r.id, true);
  update runner set last_seen_at = now() where id = r.id;
  if c.last_used_at is null or c.last_used_at < now() - interval '1 minute' then
    update pulse_priv.runner_credential set last_used_at = now() where id = c.id;
  end if;
  return jsonb_build_object('status', 'ok', 'runnerId', r.id, 'orgId', c.org_id);
end $$;

-- Ends a server: its credential stops working (the next call answers 401 runner_revoked), its jobs that have not
-- finished are cancelled and their MCP tokens end. An admin revokes ('revoked'); the server deregisters itself ('removed').
create function pulse.runner_end(p_runner text, p_status text) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r runner%rowtype;
begin
  if p_status not in ('revoked', 'removed') then raise exception 'Unknown status' using errcode = '22023'; end if;
  if not (runner_admin() or (p_status = 'removed' and p_runner = current_runner())) then
    raise exception 'Servers are removed by organisation admins' using errcode = '42501';
  end if;
  select * into r from runner where org_id = current_org() and id = p_runner for update;
  if r.id is null then raise exception 'No such server' using errcode = 'P0002'; end if;
  if r.status <> 'active' then return false; end if;
  update runner set status = p_status, revoked_at = now(), revoked_by = current_viewer() where id = r.id;
  update pulse_priv.runner_credential set revoked_at = now() where org_id = current_org() and runner_id = r.id and revoked_at is null;
  update runner_job set status = 'cancelled', finished_at = now(), error_code = case when p_status = 'revoked' then 'runner_revoked' else 'runner_removed' end,
         error_message = case when p_status = 'revoked' then 'The server was revoked in Pulse' else 'The server was uninstalled' end
   where org_id = current_org() and runner_id = r.id and status in ('queued', 'delivered', 'running', 'cancelling');
  update pulse_priv.runner_mcp_token t set revoked_at = now() from runner_job j
   where t.org_id = current_org() and j.id = t.job_id and j.runner_id = r.id and t.revoked_at is null;
  return true;
end $$;

-- A per-job Pulse MCP token, minted when the job is handed to its server (a redelivery mints a new one and ends the
-- old). It acts as the person who asked for the job, with read scopes only, until the job's time limit plus 5 minutes.
create function pulse.runner_mcp_issue(p_job text, p_hash text) returns timestamptz
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare j runner_job%rowtype; until timestamptz;
begin
  if current_runner() is null or p_hash !~ '^[0-9a-f]{64}$' then raise exception 'Only the job''s server takes its token' using errcode = '42501'; end if;
  select * into j from runner_job where org_id = current_org() and id = p_job and runner_id = current_runner();
  if j.id is null or j.status not in ('queued', 'delivered') or j.kind = 'shell-safe' then raise exception 'This job takes no token' using errcode = '42501'; end if;
  update pulse_priv.runner_mcp_token set revoked_at = now() where org_id = current_org() and job_id = j.id and revoked_at is null;
  until := now() + make_interval(secs => j.time_limit_sec) + interval '5 minutes';
  insert into pulse_priv.runner_mcp_token(org_id, job_id, token_hash, person_id, scopes, expires_at)
    values (current_org(), j.id, p_hash, j.requested_by, array(select s from unnest(v1_scopes()) s where s like '%.read'), until);
  return until;
end $$;

-- A job that ended (or went back to the queue) ends its MCP token.
create function pulse.runner_mcp_end(p_job text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not (runner_admin() or exists(select 1 from runner_job where org_id = current_org() and id = p_job and runner_id = current_runner())) then
    raise exception 'Not this job' using errcode = '42501';
  end if;
  update pulse_priv.runner_mcp_token set revoked_at = now() where org_id = current_org() and job_id = p_job and revoked_at is null;
end $$;

-- The MCP front door: which organisation a live job token belongs to (nothing for an unknown, ended or expired one).
create function pulse.runner_mcp_token_org(p_hash text) returns table(org_id uuid, status text, rehearsal boolean)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select t.org_id, o.status, o.rehearsal from pulse_priv.runner_mcp_token t join org o on o.id = t.org_id
   where t.token_hash = p_hash and t.revoked_at is null and t.expires_at > now()
$$;
-- (pulse.org's directory policy, 0001, lets the schema owner read the organisation row here, as 0956's agent_key_org does.)

-- API v1 principal for a job token, shaped like v1_person_principal: the person who asked becomes the viewer, only for
-- a read scope the token holds, only while the job is with its server, and never after expiresAt.
create function pulse.v1_runner_principal(p_hash text, p_scope text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare t pulse_priv.runner_mcp_token%rowtype;
begin
  if current_viewer() is not null or p_scope is null or not (p_scope = any(v1_scopes())) then return null; end if;
  select * into t from pulse_priv.runner_mcp_token where org_id = current_org() and token_hash = p_hash and revoked_at is null and expires_at > now() and p_scope = any(scopes);
  if not found then return null; end if;
  if not exists(select 1 from runner_job j join runner r on r.id = j.runner_id
                 where j.org_id = current_org() and j.id = t.job_id and j.status in ('delivered', 'running') and r.status = 'active') then return null; end if;
  if not exists(select 1 from person where org_id = current_org() and id = t.person_id and status = 'active' and side = 'staff') then return null; end if;
  perform set_config('pulse.viewer_id', t.person_id::text, true);
  if exists(select 1 from login_credential where person_id = t.person_id and status = 'disabled') then
    perform set_config('pulse.viewer_id', '', true);
    return null;
  end if;
  perform set_config('pulse.actor_account', 'runner:' || t.job_id, true);
  perform set_config('pulse.app_label', 'Pulse Runner', true);
  return t.id;
end $$;
create function pulse.v1_runner_token_live(p_hash text) returns boolean
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists(select 1 from pulse_priv.runner_mcp_token where org_id = current_org() and token_hash = p_hash and revoked_at is null and expires_at > now())
$$;

revoke all on function pulse.runner_admin(), pulse.runner_pair_code_create(text), pulse.runner_pair_code_live(),
  pulse.runner_pair(text, text, text, text, text, text), pulse.runner_session(text), pulse.runner_end(text, text),
  pulse.runner_mcp_issue(text, text), pulse.runner_mcp_end(text), pulse.runner_mcp_token_org(text),
  pulse.v1_runner_principal(text, text), pulse.v1_runner_token_live(text) from public;
grant execute on function pulse.runner_admin(), pulse.runner_pair_code_create(text), pulse.runner_pair_code_live(),
  pulse.runner_pair(text, text, text, text, text, text), pulse.runner_session(text), pulse.runner_end(text, text),
  pulse.runner_mcp_issue(text, text), pulse.runner_mcp_end(text), pulse.runner_mcp_token_org(text),
  pulse.v1_runner_principal(text, text), pulse.v1_runner_token_live(text) to pulse_api;

-- migrate:down
drop function if exists pulse.v1_runner_token_live(text), pulse.v1_runner_principal(text, text), pulse.runner_mcp_token_org(text),
  pulse.runner_mcp_end(text), pulse.runner_mcp_issue(text, text), pulse.runner_end(text, text), pulse.runner_session(text),
  pulse.runner_pair(text, text, text, text, text, text), pulse.runner_pair_code_live(), pulse.runner_pair_code_create(text);
drop table if exists pulse_priv.runner_mcp_token, pulse_priv.runner_job_output, pulse.runner_job_event, pulse.runner_job,
  pulse_priv.runner_credential, pulse_priv.runner_pair_code, pulse.runner;
drop function if exists pulse.runner_admin(), pulse.current_runner();
