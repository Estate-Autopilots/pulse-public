-- migrate:up
-- AI-SERVER-TOOLS (6 Nov 2026). The owner asked EA's Project Coordinator (AI) "do you have access to the VPS connected in
-- our settings?" and it said it had no access to servers. Owner: "We need to give them all access. We decide which agent
-- gets what, but all get it."
--
--  * An AI employee's own key (pak_) reaches EVERY API v1 area by default (the same operations and MCP tools a connected
--    app has), acting as itself under row security. Its managers narrow it per area (agent_member.v1_areas; null = all).
--    A key issued with areas of its own (a script's, an app's) still stays within them.
--  * A per-company switch "Pause all AI employees" (agent_org_pause): while it is on, no AI employee's key opens API v1
--    (and the agent routes refuse, services/api/src/agents.ts).
--  * Servers through API v1 (list_servers, run_on_server, get_server_job, get_server_job_output): an AI employee uses a
--    server that lets AI employees in, up to the server's level, with the standing approval of the admin who set the level
--    (no per-job card), unless its managers turned on "ask me first for writes" (agent_member.server_writes_ask, off by
--    default: then it runs read-only work only and says a person must approve the rest). A person (a connected app, the
--    assistant) runs jobs only as an organisation admin. Every job keeps who asked and for whom (runner_job.requested_for),
--    shown in Settings → Servers as "by <AI employee> for <person>".

alter table pulse.agent_member
  add column if not exists v1_areas text[],
  add column if not exists server_writes_ask boolean not null default false;
alter table pulse.runner_job add column if not exists requested_for uuid references pulse.person(id);

-- ------------------------------------------------------------------------------------------------------- the pause switch
create table pulse.agent_org_pause (
  org_id uuid primary key references pulse.org(id),
  paused_at timestamptz not null default now(),
  paused_by uuid not null references pulse.person(id),
  reason text check (reason is null or length(reason) <= 500)
);
alter table pulse.agent_org_pause enable row level security;
alter table pulse.agent_org_pause force row level security;
create policy tenant_isolation on pulse.agent_org_pause using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select on pulse.agent_org_pause to pulse_api;

create function pulse.agent_paused() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists(select 1 from agent_org_pause where org_id = current_org())
$$;

-- An organisation admin pauses or resumes every AI employee of the company.
create function pulse.agent_pause_set(p_on boolean, p_reason text) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or current_viewer() is null or not viewer_is('admin') then
    raise exception 'Only an organisation admin pauses AI employees' using errcode = '42501';
  end if;
  if coalesce(p_on, false) then
    insert into agent_org_pause(org_id, paused_by, reason) values (current_org(), current_viewer(), left(nullif(btrim(p_reason), ''), 500))
    on conflict (org_id) do update set paused_at = now(), paused_by = excluded.paused_by, reason = excluded.reason;
  else
    delete from agent_org_pause where org_id = current_org();
  end if;
  return jsonb_build_object('paused', coalesce(p_on, false));
end $$;

-- Its managers (admins, HR, leadership or its manager) narrow an AI employee's areas (null or every area = everything)
-- and switch "ask me first for writes" on servers.
create function pulse.agent_access_set(p_agent uuid, p_areas text[], p_writes_ask boolean) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare bad text;
begin
  if agent_session() is not null or not agent_manage_ok(p_agent) then raise exception 'Admins, HR, leadership or its manager change an AI employee' using errcode = '42501'; end if;
  select x into bad from unnest(coalesce(p_areas, '{}')) x where not (x = any(v1_scopes())) limit 1;
  if bad is not null then raise exception 'Unknown area %', bad using errcode = '22023'; end if;
  update agent_member set v1_areas = case when p_areas is null or v1_scopes() <@ p_areas then null else p_areas end,
         server_writes_ask = coalesce(p_writes_ask, server_writes_ask)
   where person_id = p_agent and org_id = current_org();
  if not found then raise exception 'Choose an AI employee' using errcode = '22023'; end if;
  return (select jsonb_build_object('areas', coalesce(to_jsonb(v1_areas), to_jsonb(v1_scopes())), 'all', v1_areas is null, 'serverWritesAsk', server_writes_ask)
            from agent_member where person_id = p_agent);
end $$;

-- ------------------------------------------------------------------------------------------------------- API v1 as the AI employee
-- As 0670's, but the areas are the AI employee's (all unless narrowed) and a paused company opens nothing.
create or replace function pulse.v1_agent_principal(p_key text, p_scope text) returns uuid language plpgsql security definer set search_path=pulse,pg_temp as $$
declare agent uuid;
begin
  if current_viewer() is not null or p_scope is null or not(p_scope = any(v1_scopes())) then return null; end if;
  agent := agent_key_resolve(p_key);
  -- A key issued with areas of its own (a script's, an app's) stays within them; the AI employee's own runtime key
  -- (no areas of its own) reaches what the AI employee may reach.
  if agent is null or not exists(select 1 from pulse_priv.agent_key where prefix = substr(p_key, 5, 8) and org_id = current_org()
     and person_id = agent and revoked_at is null and expires_at > now()
     and (p_scope = any(scopes) or not (scopes && v1_scopes()))) then return null; end if;
  if agent_paused() then return null; end if;
  if not exists(select 1 from agent_member m where m.person_id = agent and m.org_id = current_org() and p_scope = any(coalesce(m.v1_areas, v1_scopes()))) then return null; end if;
  perform set_config('pulse.viewer_id', agent::text, true);
  perform set_config('pulse.agent_session', 'on', true);
  if agent_session() is distinct from agent then
    perform set_config('pulse.viewer_id', '', true);
    perform set_config('pulse.agent_session', '', true);
    return null;
  end if;
  perform set_config('pulse.actor_account', 'agent:' || coalesce((select username from people_profile where person_id = agent), agent::text), true);
  return agent;
end $$;

-- ------------------------------------------------------------------------------------------------------- servers
-- The company's servers as the viewer may use them: an AI employee sees every active server and whether it may use it;
-- an organisation admin may use all of them; anyone else none.
create function pulse.runner_server_list() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); agent uuid := agent_session(); ask boolean := false;
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if agent is null and not viewer_is('admin') then raise exception 'Servers are for organisation admins and AI employees' using errcode = '42501'; end if;
  if agent is not null then select coalesce(server_writes_ask, false) into ask from agent_member where person_id = agent; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'online', r.last_seen_at > now() - interval '90 seconds',
      'accessLevel', r.access_level, 'sandbox', r.sandbox, 'aiEmployees', r.ai_employees,
      'mayUse', case when agent is null then true else r.ai_employees end,
      'askFirstForWrites', case when agent is null then false else ask end,
      'claude', coalesce((r.capabilities #>> '{ai,claude,loggedIn}')::boolean, false),
      'codex', coalesce((r.capabilities #>> '{ai,codex,loggedIn}')::boolean, false),
      'hostname', r.hostname, 'os', r.os) order by r.created_at)
    from runner r where r.org_id = current_org() and r.status = 'active'), '[]'::jsonb);
end $$;

-- One job on a server (by id or name), as the viewer: an AI employee where AI employees may work, up to the level (write
-- and full carry the standing approval of the admin who set the level, unless "ask me first for writes" is on); an
-- organisation admin up to the level, approved by themselves. p_for: whom it is done for (the person who asked).
create function pulse.runner_server_job_start(p_runner text, p_kind text, p_prompt text, p_command text[], p_profile text,
    p_time int, p_cap numeric, p_for uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); agent uuid := agent_session(); r runner%rowtype; jid text := 'job_' || replace(gen_random_uuid()::text, '-', '');
  appr jsonb; prof text := coalesce(p_profile, 'read-only'); who uuid; ask boolean := false;
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if agent is null and not viewer_is('admin') then raise exception 'Only an organisation admin or an AI employee runs work on a server' using errcode = '42501'; end if;
  if agent is not null and agent_paused() then raise exception 'AI employees are paused in this company' using errcode = '42501'; end if;
  select * into r from runner where org_id = current_org() and status = 'active' and (id = p_runner or lower(name) = lower(btrim(p_runner)))
   order by (id = p_runner) desc, created_at limit 1;
  if r.id is null then raise exception 'No server is called %. list_servers shows the company''s servers.', p_runner using errcode = 'P0002'; end if;
  if agent is not null and not r.ai_employees then
    raise exception 'AI employees may not use % yet: an organisation admin turns on "AI employees may use this server" in Settings → Servers.', r.name using errcode = '42501';
  end if;
  if p_kind not in ('claude', 'codex', 'shell-safe') then raise exception 'mode is shell, claude or codex' using errcode = '22023'; end if;
  if not runner_level_allows(r.access_level, prof) then
    raise exception '% allows % work only. An organisation admin can raise it in Settings → Servers.', r.name, r.access_level using errcode = '42501';
  end if;
  if agent is not null then select coalesce(server_writes_ask, false) into ask from agent_member where person_id = agent; end if;
  if ask and prof <> 'read-only' then
    raise exception 'Your managers asked that a person approves your write work on servers: ask an organisation admin to run it from Settings → Servers.' using errcode = '42501';
  end if;
  if (select count(*) from runner_job where org_id = current_org() and runner_id = r.id and requested_by = me
        and status in ('queued', 'delivered', 'running', 'cancelling')) >= 5 then
    raise exception 'Five of your jobs already wait or run on this server' using errcode = '54000';
  end if;
  select id into who from person where org_id = current_org() and id = p_for and side = 'staff';
  -- An AI employee works for whoever wrote the message its live run answers (never taken from the model).
  if who is null and agent is not null then
    select m.author_id into who from agent_run ar join agent_event ev on ev.id = ar.event_id and ev.subject_type = 'message'
      join chat_message m on m.id = ev.subject_id
     where ar.org_id = current_org() and ar.agent_id = agent and ar.finished_at is null order by ar.started_at desc limit 1;
    select id into who from person where org_id = current_org() and id = who and side = 'staff';
  end if;
  if prof <> 'read-only' then
    appr := case when agent is null then jsonb_build_object('approvedBy', jsonb_build_object('id', me, 'name', (select display_name from person where id = me)), 'approvedAt', now())
      else jsonb_build_object('approvedBy', jsonb_build_object('id', r.access_set_by, 'name', (select display_name from person where id = r.access_set_by)),
        'approvedAt', r.access_set_at, 'standing', true) end;
  end if;
  insert into runner_job(org_id, id, runner_id, kind, prompt, command, profile, approval, time_limit_sec, cost_cap_usd, requested_by, requested_for)
    values (current_org(), jid, r.id, p_kind, case when p_kind = 'shell-safe' then null else p_prompt end, case when p_kind = 'shell-safe' then p_command end,
            prof, appr, greatest(1, least(coalesce(p_time, 600), 14400)), case when p_kind = 'shell-safe' then null else coalesce(p_cap, 2) end, me, coalesce(who, case when agent is null then me end));
  return jsonb_build_object('id', jid, 'status', 'queued', 'server', r.name, 'serverId', r.id, 'kind', p_kind, 'profile', prof, 'accessLevel', r.access_level);
end $$;

-- A job as the viewer may read it (an AI employee its own, an admin any): how it ended, cost, the CLI's answer, the log's end.
create function pulse.runner_server_job_read(p_job text, p_log int default 60) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); agent uuid := agent_session(); j runner_job%rowtype; answer text; logs text; rname text; byname text; forname text;
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if agent is null and not viewer_is('admin') then raise exception 'Only an organisation admin or an AI employee reads server jobs' using errcode = '42501'; end if;
  select * into j from runner_job where org_id = current_org() and id = p_job and (agent is null or requested_by = agent);
  if j.id is null then return null; end if;
  select coalesce(e.data ->> 'result', e.data #>> '{item,text}') into answer from runner_job_event e
   where e.org_id = current_org() and e.job_id = j.id and e.type = 'agent'
     and (e.data ->> 'type' = 'result' or (e.data ->> 'type' = 'item.completed' and e.data #>> '{item,type}' = 'agent_message'))
   order by e.seq desc limit 1;
  select string_agg(x.line, chr(10) order by x.seq) into logs from (select e.seq, e.data ->> 'line' line from runner_job_event e
     where e.org_id = current_org() and e.job_id = j.id and e.type = 'log' order by e.seq desc limit greatest(1, least(coalesce(p_log, 60), 400))) x;
  select name into rname from runner where id = j.runner_id;
  select display_name into byname from person where id = j.requested_by;
  select display_name into forname from person where id = j.requested_for;
  return jsonb_build_object('id', j.id, 'server', rname, 'serverId', j.runner_id, 'kind', j.kind, 'profile', j.profile, 'status', j.status,
    'final', j.status in ('succeeded', 'failed', 'timed_out', 'cancelled', 'rejected'),
    'summary', left(coalesce(j.prompt, array_to_string(j.command, ' ')), 200), 'exitCode', j.exit_code,
    'errorCode', j.error_code, 'errorMessage', j.error_message, 'accessLevel', j.access_level, 'sandbox', j.sandbox,
    'costUsd', j.cost_usd, 'durationMs', j.duration_ms, 'createdAt', j.created_at, 'finishedAt', j.finished_at,
    'requestedBy', byname, 'requestedFor', forname, 'text', answer, 'log', logs, 'link', '/settings?tab=servers&job=' || j.id);
end $$;

revoke all on function pulse.agent_paused(), pulse.agent_pause_set(boolean, text), pulse.agent_access_set(uuid, text[], boolean),
  pulse.runner_server_list(), pulse.runner_server_job_start(text, text, text, text[], text, int, numeric, uuid), pulse.runner_server_job_read(text, int) from public;
grant execute on function pulse.agent_paused(), pulse.agent_pause_set(boolean, text), pulse.agent_access_set(uuid, text[], boolean),
  pulse.runner_server_list(), pulse.runner_server_job_start(text, text, text, text[], text, int, numeric, uuid), pulse.runner_server_job_read(text, int) to pulse_api;

-- migrate:down
drop function if exists pulse.runner_server_job_read(text, int), pulse.runner_server_job_start(text, text, text, text[], text, int, numeric, uuid),
  pulse.runner_server_list(), pulse.agent_access_set(uuid, text[], boolean), pulse.agent_pause_set(boolean, text), pulse.agent_paused();
drop table if exists pulse.agent_org_pause;
alter table pulse.runner_job drop column if exists requested_for;
alter table pulse.agent_member drop column if exists server_writes_ask, drop column if exists v1_areas;
