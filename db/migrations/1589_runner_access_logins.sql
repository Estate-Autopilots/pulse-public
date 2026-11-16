-- migrate:up
-- RUNNERS-FULL (6 Nov 2026): a company's servers, all the way (owner: "read write and complete access to EA, AC and WL
-- servers … so they can login with Claude Code Max, Codex or any subscription via Pulse … so they can assign their
-- agents to do all sorts of work"). On top of 1560 (Pulse Runner):
--
--  * Access level per server: read-only (the default, as before) / read-write / full (shell, sudo-capable when the
--    server's own user may sudo). Only an organisation admin changes it, through pulse.runner_access_set(), which writes
--    the append-only ledger pulse.runner_access_log (who approved, from what to what, why). The sandbox stays on unless
--    an admin turns it off for that server (and the server's own admin also allows it locally: PROTOCOL.md §4 access).
--    Every job keeps the level and sandbox it was queued at (stamped by a trigger from the server's row), and a job
--    above the server's level is refused in the database, whoever asks.
--  * "AI employees may use this server": off by default. When on, an AI employee of the organisation (its co-worker key
--    session) queues jobs there through pulse.runner_agent_job_create(), up to the server's level; write/shell jobs carry
--    the standing approval of the admin who set the level (who and when), so every AI job is audited like a person's.
--  * Subscription logins started from Pulse (PROTOCOL.md §10): pulse.runner_login is one "Connect Claude/Codex" or
--    disconnect; only the sign-in link and device code the CLI printed are stored, never a token. Claude Code's pasted
--    one-time code waits in pulse_priv.runner_login_code (no grants) only until the server takes it.
--  * pulse.runner.ai_logins: when each CLI was last seen signed in, so a lapsed login shows "needs a new login".

alter table pulse.runner
  add column access_level text not null default 'read-only' check (access_level in ('read-only', 'read-write', 'full')),
  add column sandbox boolean not null default true,
  add column ai_employees boolean not null default false,
  add column access_set_at timestamptz,
  add column access_set_by uuid references pulse.person(id),
  add column ai_logins jsonb not null default '{}' check (jsonb_typeof(ai_logins) = 'object' and pg_column_size(ai_logins) < 2048);
grant update (ai_logins) on pulse.runner to pulse_api;

alter table pulse.runner_job
  add column access_level text check (access_level is null or access_level in ('read-only', 'read-write', 'full')),
  add column sandbox boolean,
  add column requested_by_type text not null default 'person' check (requested_by_type in ('person', 'ai-employee'));

-- The profile a level allows at most: read-only → read-only, read-write → write, full → shell.
create function pulse.runner_level_allows(p_level text, p_profile text) returns boolean language sql immutable as $$
  select case p_profile when 'read-only' then true when 'write' then p_level in ('read-write', 'full') when 'shell' then p_level = 'full' else false end
$$;

-- Every job: the server's level and sandbox at queue time, who asked (a person or an AI employee), and never above the level.
create function pulse.runner_job_stamp() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r runner%rowtype;
begin
  select * into r from runner where org_id = new.org_id and id = new.runner_id;
  if r.id is null then raise exception 'No such server' using errcode = 'P0002'; end if;
  new.access_level := r.access_level;
  new.sandbox := r.sandbox;
  new.requested_by_type := case when exists(select 1 from agent_member m where m.person_id = new.requested_by) then 'ai-employee' else 'person' end;
  if not runner_level_allows(r.access_level, new.profile) then
    raise exception 'This server allows % work only. An admin can raise its access in Settings → Servers.', r.access_level using errcode = '42501';
  end if;
  if new.requested_by_type = 'ai-employee' and not r.ai_employees then
    raise exception 'AI employees may not use this server' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger runner_job_stamp before insert on pulse.runner_job for each row execute function pulse.runner_job_stamp();

-- ------------------------------------------------------------------------------------------------------- access ledger
create table pulse.runner_access_log (
  org_id uuid not null references pulse.org(id), id uuid primary key default gen_random_uuid(),
  runner_id text not null,
  at timestamptz not null default now(),
  approved_by uuid not null references pulse.person(id),
  approver_name text check (approver_name is null or length(approver_name) <= 200),
  actor text check (actor is null or length(actor) <= 200),
  from_level text, to_level text not null,
  from_sandbox boolean, sandbox boolean not null,
  from_ai_employees boolean, ai_employees boolean not null,
  reason text check (reason is null or length(reason) <= 500),
  foreign key (org_id, runner_id) references pulse.runner(org_id, id)
);
create index runner_access_log_runner on pulse.runner_access_log (org_id, runner_id, at desc);

-- ------------------------------------------------------------------------------------------------------- logins
create table pulse.runner_login (
  org_id uuid not null references pulse.org(id),
  id text primary key check (id ~ '^lgn_[0-9a-f]{32}$'),
  runner_id text not null,
  tool text not null check (tool in ('claude', 'codex')),
  action text not null default 'login' check (action in ('login', 'logout')),
  status text not null default 'requested'
    check (status in ('requested', 'starting', 'waiting', 'verifying', 'succeeded', 'failed', 'cancelled', 'expired')),
  url text check (url is null or (length(url) <= 2048 and url ~ '^https://' and url !~ '[[:cntrl:][:space:]]')),
  user_code text check (user_code is null or user_code ~ '^[A-Za-z0-9-]{4,24}$'),
  needs_code boolean not null default false,
  error_code text check (error_code is null or error_code ~ '^[a-z_]{1,40}$'),
  error_message text check (error_message is null or length(error_message) <= 300),
  requested_by uuid not null references pulse.person(id),
  created_at timestamptz not null default now(), delivered_at timestamptz, updated_at timestamptz not null default now(),
  finished_at timestamptz, cancel_requested_at timestamptz, cancel_sent_at timestamptz, code_sent_at timestamptz,
  foreign key (org_id, runner_id) references pulse.runner(org_id, id),
  unique (org_id, id)
);
create index runner_login_runner on pulse.runner_login (org_id, runner_id, status);
create table pulse_priv.runner_login_code (
  org_id uuid not null, login_id text primary key,
  code text not null check (length(code) between 4 and 512 and code ~ '^[[:graph:]]+$'),
  created_at timestamptz not null default now(),
  foreign key (org_id, login_id) references pulse.runner_login(org_id, id) on delete cascade
);

-- ------------------------------------------------------------------------------------------------------- row security
do $$ declare t text; begin
  foreach t in array array['pulse.runner_access_log', 'pulse.runner_login', 'pulse_priv.runner_login_code'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy tenant_isolation on %s using (org_id = pulse.current_org()) with check (org_id = pulse.current_org())', t);
  end loop;
end $$;
-- Admins read the ledger; only pulse.runner_access_set() (the schema owner) writes it, and nobody changes or removes it.
create policy runner_scope on pulse.runner_access_log as restrictive to pulse_api using (pulse.runner_admin()) with check (false);
grant select on pulse.runner_access_log to pulse_api;
-- Logins: an admin asks and follows; the server they are for reports.
create policy runner_scope on pulse.runner_login as restrictive to pulse_api
  using (pulse.runner_admin() or runner_id = pulse.current_runner()) with check (pulse.runner_admin() or runner_id = pulse.current_runner());
create policy admin_insert on pulse.runner_login as restrictive for insert to pulse_api with check (pulse.runner_admin());
grant select, insert, update on pulse.runner_login to pulse_api;
create policy directory on pulse_priv.runner_login_code for select
  using (current_user = (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'pulse'));

-- ------------------------------------------------------------------------------------------------------- functions
-- An admin sets a server's access (level, sandbox, AI employees). Every change is one ledger row with the approver.
create function pulse.runner_access_set(p_runner text, p_level text, p_sandbox boolean, p_ai boolean, p_reason text) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r runner%rowtype; who text;
begin
  if not runner_admin() then raise exception 'Only an organisation admin changes a server''s access' using errcode = '42501'; end if;
  if p_level not in ('read-only', 'read-write', 'full') then raise exception 'Access is read-only, read-write or full' using errcode = '22023'; end if;
  select * into r from runner where org_id = current_org() and id = p_runner and status = 'active' for update;
  if r.id is null then raise exception 'No such server' using errcode = 'P0002'; end if;
  select display_name into who from person where org_id = current_org() and id = current_viewer();
  update runner set access_level = p_level, sandbox = coalesce(p_sandbox, true), ai_employees = coalesce(p_ai, false),
         access_set_at = now(), access_set_by = current_viewer() where id = r.id;
  insert into runner_access_log(org_id, runner_id, approved_by, approver_name, actor, from_level, to_level, from_sandbox, sandbox,
                                from_ai_employees, ai_employees, reason)
    values (current_org(), r.id, current_viewer(), left(who, 200), left(nullif(current_setting('pulse.actor_account', true), ''), 200),
            r.access_level, p_level, r.sandbox, coalesce(p_sandbox, true), r.ai_employees, coalesce(p_ai, false), left(nullif(btrim(p_reason), ''), 500));
  return jsonb_build_object('level', p_level, 'sandbox', coalesce(p_sandbox, true), 'aiEmployees', coalesce(p_ai, false), 'approvedBy', who, 'at', now());
end $$;

-- An admin pastes Claude Code's one-time code for a login that waits for it; it waits here until its server takes it.
create function pulse.runner_login_code_put(p_login text, p_code text) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare l runner_login%rowtype;
begin
  if not runner_admin() then raise exception 'Servers are connected by organisation admins' using errcode = '42501'; end if;
  select * into l from runner_login where org_id = current_org() and id = p_login for update;
  if l.id is null or l.status not in ('waiting', 'verifying') or l.action <> 'login' then raise exception 'This login is not waiting for a code' using errcode = '55000'; end if;
  delete from pulse_priv.runner_login_code where org_id = current_org() and (login_id = l.id or created_at < now() - interval '15 minutes');
  insert into pulse_priv.runner_login_code(org_id, login_id, code) values (current_org(), l.id, p_code);
  update runner_login set status = 'verifying', updated_at = now(), error_code = null, error_message = null where id = l.id;
  return true;
end $$;

-- The server takes a pasted code once (it is deleted as it is read).
create function pulse.runner_login_code_take(p_login text) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare c text;
begin
  if current_runner() is null then raise exception 'Only the login''s server takes its code' using errcode = '42501'; end if;
  delete from pulse_priv.runner_login_code k using runner_login l
   where k.org_id = current_org() and k.login_id = p_login and l.id = k.login_id and l.runner_id = current_runner()
  returning k.code into c;
  if c is not null then update runner_login set code_sent_at = now(), updated_at = now() where id = p_login; end if;
  return c;
end $$;

-- The servers an AI employee may use: its organisation's active servers with "AI employees may use this server" on.
create function pulse.runner_agent_servers() returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session();
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'accessLevel', r.access_level,
      'online', r.last_seen_at > now() - interval '90 seconds',
      'claude', coalesce((r.capabilities #>> '{ai,claude,loggedIn}')::boolean, false), 'codex', coalesce((r.capabilities #>> '{ai,codex,loggedIn}')::boolean, false))
      order by r.created_at)
    from runner r where r.org_id = current_org() and r.status = 'active' and r.ai_employees), '[]'::jsonb);
end $$;

-- An AI employee queues a job on one of those servers, up to its level (the trigger checks again). Write and shell jobs
-- carry the standing approval of the admin who set the server's level. At most 5 of its jobs wait or run per server.
create function pulse.runner_agent_job_create(p_runner text, p_kind text, p_prompt text, p_model text, p_profile text, p_time int, p_cap numeric) returns text
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); r runner%rowtype; jid text := 'job_' || replace(gen_random_uuid()::text, '-', ''); appr jsonb;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  if p_kind not in ('claude', 'codex') then raise exception 'An AI employee asks Claude or Codex' using errcode = '22023'; end if;
  select * into r from runner where org_id = current_org() and id = p_runner and status = 'active';
  if r.id is null or not r.ai_employees then raise exception 'AI employees may not use this server' using errcode = '42501'; end if;
  if not runner_level_allows(r.access_level, coalesce(p_profile, 'read-only')) then
    raise exception 'This server allows % work only', r.access_level using errcode = '42501';
  end if;
  if (select count(*) from runner_job where org_id = current_org() and runner_id = r.id and requested_by = me
        and status in ('queued', 'delivered', 'running', 'cancelling')) >= 5 then
    raise exception 'Five of your jobs already wait or run on this server' using errcode = '54000';
  end if;
  if coalesce(p_profile, 'read-only') <> 'read-only' then
    appr := jsonb_build_object('approvedBy', jsonb_build_object('id', r.access_set_by, 'name', (select display_name from person where id = r.access_set_by)),
      'approvedAt', r.access_set_at, 'standing', true);
  end if;
  insert into runner_job(org_id, id, runner_id, kind, prompt, profile, approval, model, time_limit_sec, cost_cap_usd, requested_by)
    values (current_org(), jid, r.id, p_kind, p_prompt, coalesce(p_profile, 'read-only'), appr, p_model, p_time, p_cap, me);
  return jid;
end $$;

-- An AI employee reads back its own job: how it ended, what it cost and the answer the CLI gave (Claude's result line,
-- else Codex's last message).
create function pulse.runner_agent_job_read(p_job text) returns jsonb
  language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); j runner_job%rowtype; answer text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  select * into j from runner_job where org_id = current_org() and id = p_job and requested_by = me;
  if j.id is null then return null; end if;
  select coalesce(e.data ->> 'result', e.data #>> '{item,text}') into answer from runner_job_event e
   where e.org_id = current_org() and e.job_id = j.id and e.type = 'agent'
     and (e.data ->> 'type' = 'result' or (e.data ->> 'type' = 'item.completed' and e.data #>> '{item,type}' = 'agent_message'))
   order by e.seq desc limit 1;
  return jsonb_build_object('id', j.id, 'status', j.status, 'errorCode', j.error_code, 'errorMessage', j.error_message, 'accessLevel', j.access_level,
    'costUsd', j.cost_usd, 'usage', j.usage, 'durationMs', j.duration_ms, 'text', answer);
end $$;

revoke all on function pulse.runner_access_set(text, text, boolean, boolean, text), pulse.runner_login_code_put(text, text),
  pulse.runner_login_code_take(text), pulse.runner_agent_servers(), pulse.runner_agent_job_create(text, text, text, text, text, int, numeric),
  pulse.runner_agent_job_read(text), pulse.runner_job_stamp() from public;
grant execute on function pulse.runner_access_set(text, text, boolean, boolean, text), pulse.runner_login_code_put(text, text),
  pulse.runner_login_code_take(text), pulse.runner_agent_servers(), pulse.runner_agent_job_create(text, text, text, text, text, int, numeric),
  pulse.runner_agent_job_read(text), pulse.runner_level_allows(text, text) to pulse_api;

-- migrate:down
drop function if exists pulse.runner_agent_job_read(text), pulse.runner_agent_job_create(text, text, text, text, text, int, numeric),
  pulse.runner_agent_servers(), pulse.runner_login_code_take(text), pulse.runner_login_code_put(text, text),
  pulse.runner_access_set(text, text, boolean, boolean, text);
drop trigger if exists runner_job_stamp on pulse.runner_job;
drop function if exists pulse.runner_job_stamp(), pulse.runner_level_allows(text, text);
drop table if exists pulse_priv.runner_login_code, pulse.runner_login, pulse.runner_access_log;
alter table pulse.runner_job drop column if exists access_level, drop column if exists sandbox, drop column if exists requested_by_type;
alter table pulse.runner drop column if exists access_level, drop column if exists sandbox, drop column if exists ai_employees,
  drop column if exists access_set_at, drop column if exists access_set_by, drop column if exists ai_logins;
