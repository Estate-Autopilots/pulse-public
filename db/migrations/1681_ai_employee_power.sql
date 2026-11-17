-- migrate:up
-- AI-EMPLOYEE-POWER (6 Nov 2026). Owner: the AI employees are slow and "not even able to do shit on server". On EA's
-- server (Claude Code signed in, read-write) an AI employee could run only echo, uname, uptime, df, free, nproc and
-- sleep; every other command needed a Claude Code session at full access. Now:
--
--  * A direct shell job (runner_job.kind 'shell': one command line, run by bash on the server through Pulse Runner):
--    read-only (a read-only view of the server in the sandbox) or write (sandboxed, its own work folder), seconds
--    instead of a CLI session.
--  * An access tier per AI employee per server (agent_server_tier): read-only, sandboxed (read-write in the sandbox,
--    the default where the server is read-write or full) or root (unsandboxed root shell: internet, ssh/scp to the
--    company's own servers, docker and services, any file; no command list; a time limit up to 30 minutes). Only the
--    organisation owner (its first admin) or a Pulse superadmin grants root, typing GRANT ROOT. The server's own
--    "AI employees may use this server" switch still rules: off means no tier at all (root rows wait, unused).
--  * Every grant and revoke is in agent_server_tier_log; every root command and its output is a runner_job with profile
--    'root' and its events, shown (secrets redacted) in Settings → Servers → Root access; "Revoke all root" removes
--    every root grant of the company and stops its root jobs at once.
--  * Refusals are worded without ASCII quotes or parentheses so API v1 passes them on (v1.ts hides other wording).

-- ------------------------------------------------------------------------------------------------------- job kinds
alter table pulse.runner_job drop constraint if exists runner_job_kind_check;
alter table pulse.runner_job add constraint runner_job_kind_check check (kind in ('claude', 'codex', 'shell-safe', 'shell'));
alter table pulse.runner_job drop constraint if exists runner_job_profile_check;
alter table pulse.runner_job add constraint runner_job_profile_check check (profile in ('read-only', 'write', 'shell', 'root'));
alter table pulse.runner_job drop constraint if exists runner_job_check;
alter table pulse.runner_job add constraint runner_job_check check ((kind in ('shell-safe', 'shell')) = (command is not null));
alter table pulse.runner_job drop constraint if exists runner_job_check1;
alter table pulse.runner_job add constraint runner_job_check1 check (kind in ('shell-safe', 'shell') or (prompt is not null and cost_cap_usd is not null));
alter table pulse.runner_job drop constraint if exists runner_job_check2;
alter table pulse.runner_job add constraint runner_job_check2 check (kind not in ('shell-safe', 'shell') or prompt is null);
alter table pulse.runner_job add constraint runner_job_shell_check check (kind <> 'shell' or (cardinality(command) = 1 and octet_length(command[1]) between 1 and 20000));
alter table pulse.runner_job add constraint runner_job_root_check check (profile <> 'root' or kind = 'shell');

-- ------------------------------------------------------------------------------------------------------- tiers
create table pulse.agent_server_tier (
  org_id uuid not null references pulse.org(id),
  agent_id uuid not null references pulse.person(id),
  runner_id text not null,
  tier text not null check (tier in ('read-only', 'sandboxed', 'root')),
  time_limit_sec int not null default 600 check (time_limit_sec between 10 and 1800),
  granted_by uuid not null references pulse.person(id),
  granted_at timestamptz not null default now(),
  primary key (org_id, agent_id, runner_id),
  foreign key (org_id, runner_id) references pulse.runner(org_id, id)
);
alter table pulse.agent_server_tier enable row level security;
alter table pulse.agent_server_tier force row level security;
create policy tenant_isolation on pulse.agent_server_tier using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

create table pulse.agent_server_tier_log (
  org_id uuid not null references pulse.org(id),
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  agent_id uuid not null references pulse.person(id),
  runner_id text not null,
  from_tier text,
  to_tier text not null check (to_tier in ('read-only', 'sandboxed', 'root', 'default')),
  by_person uuid not null references pulse.person(id),
  reason text check (reason is null or length(reason) <= 500),
  foreign key (org_id, runner_id) references pulse.runner(org_id, id)
);
create index agent_server_tier_log_at on pulse.agent_server_tier_log (org_id, at desc);
alter table pulse.agent_server_tier_log enable row level security;
alter table pulse.agent_server_tier_log force row level security;
create policy tenant_isolation on pulse.agent_server_tier_log using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- The organisation's owner (its first admin still holding the role) or a Pulse superadmin, as a person (never an AI).
create function pulse.org_owner_or_superadmin() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select current_viewer() is not null and agent_session() is null and (platform_admin() or current_viewer() = (
    select ra.person_id from role_assignment ra join person p on p.id = ra.person_id and p.side = 'staff' and p.status = 'active'
     where ra.org_id = current_org() and ra.role_key = 'admin' and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')
     order by ra.valid_from, ra.id limit 1))
$$;

-- An AI employee's tier on one server: none where AI employees are off; else its own (sandboxed never above a read-only
-- server) or the default (read-only on a read-only server, sandboxed otherwise).
create function pulse.agent_server_tier_of(p_agent uuid, p_runner text) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object(
      'tier', case when not r.ai_employees then 'none'
                   when t.tier = 'root' then 'root'
                   when r.access_level = 'read-only' then 'read-only'
                   else coalesce(t.tier, 'sandboxed') end,
      'explicit', t.tier is not null, 'timeLimitSec', coalesce(t.time_limit_sec, 600),
      'grantedBy', (select display_name from person where id = t.granted_by), 'grantedAt', t.granted_at)
    from runner r left join agent_server_tier t on t.org_id = r.org_id and t.runner_id = r.id and t.agent_id = p_agent
   where r.org_id = current_org() and r.id = p_runner
$$;

-- An organisation admin sets an AI employee's tier on a server ('default' clears it); root only by the owner or a
-- superadmin, typed GRANT ROOT, on a server that lets AI employees in. Every change is in the log.
create function pulse.agent_server_tier_set(p_agent uuid, p_runner text, p_tier text, p_time int, p_confirm text, p_reason text)
returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); r runner%rowtype; old text;
begin
  if agent_session() is not null or me is null or not viewer_is('admin') then
    raise exception 'Only an organisation admin sets what an AI employee may do on a server' using errcode = '42501';
  end if;
  if not exists(select 1 from agent_member where person_id = p_agent and org_id = current_org()) then raise exception 'Choose an AI employee' using errcode = '22023'; end if;
  select * into r from runner where org_id = current_org() and id = p_runner and status = 'active';
  if r.id is null then raise exception 'No such server' using errcode = 'P0002'; end if;
  if p_tier is null or p_tier not in ('read-only', 'sandboxed', 'root', 'default') then raise exception 'The level is read-only, sandboxed, root or default' using errcode = '22023'; end if;
  select tier into old from agent_server_tier where org_id = current_org() and agent_id = p_agent and runner_id = r.id;
  if p_tier = 'root' then
    if not org_owner_or_superadmin() then raise exception 'Only the organisation owner or a Pulse superadmin grants root' using errcode = '42501'; end if;
    if coalesce(p_confirm, '') <> 'GRANT ROOT' then raise exception 'Type GRANT ROOT to confirm a root grant' using errcode = '22023'; end if;
    if not r.ai_employees then
      raise exception 'AI employees are off for %: an organisation admin turns on “AI employees may use this server” in Settings → Servers first', r.name using errcode = '42501';
    end if;
  end if;
  if p_tier = 'default' then
    delete from agent_server_tier where org_id = current_org() and agent_id = p_agent and runner_id = r.id;
  else
    insert into agent_server_tier(org_id, agent_id, runner_id, tier, time_limit_sec, granted_by)
    values (current_org(), p_agent, r.id, p_tier, greatest(10, least(coalesce(p_time, 600), 1800)), me)
    on conflict (org_id, agent_id, runner_id) do update set tier = excluded.tier, time_limit_sec = excluded.time_limit_sec, granted_by = excluded.granted_by, granted_at = now();
  end if;
  insert into agent_server_tier_log(org_id, agent_id, runner_id, from_tier, to_tier, by_person, reason)
  values (current_org(), p_agent, r.id, old, p_tier, me, left(nullif(btrim(p_reason), ''), 500));
  return agent_server_tier_of(p_agent, r.id) || jsonb_build_object('id', r.id, 'name', r.name);
end $$;

-- The kill switch: any organisation admin removes every root grant of the company and stops its root jobs.
create function pulse.agent_root_revoke_all(p_reason text) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); n int; m int;
begin
  if agent_session() is not null or me is null or not viewer_is('admin') then raise exception 'Only an organisation admin revokes root' using errcode = '42501'; end if;
  with gone as (delete from agent_server_tier where org_id = current_org() and tier = 'root' returning agent_id, runner_id)
  insert into agent_server_tier_log(org_id, agent_id, runner_id, from_tier, to_tier, by_person, reason)
  select current_org(), agent_id, runner_id, 'root', 'default', me, coalesce(left(nullif(btrim(p_reason), ''), 500), 'Revoke all root') from gone;
  get diagnostics n = row_count;
  update runner_job set status = case when status = 'queued' then 'cancelled' else 'cancelling' end,
         cancel_requested_at = now(), cancel_requested_by = me,
         finished_at = case when status = 'queued' then now() else finished_at end,
         error_code = case when status = 'queued' then 'cancelled' else error_code end,
         error_message = case when status = 'queued' then 'Root was revoked' else error_message end
   where org_id = current_org() and profile = 'root' and status in ('queued', 'delivered', 'running');
  get diagnostics m = row_count;
  return jsonb_build_object('revoked', n, 'cancelledJobs', m);
end $$;

-- Settings → Servers → Root access: the root commands with their output, the grants now, and the ledger.
create function pulse.runner_root_audit(p_limit int) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if agent_session() is not null or current_viewer() is null or not viewer_is('admin') then raise exception 'Only an organisation admin reads the root log' using errcode = '42501'; end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(x.v order by x.at desc) from (
        select j.created_at at, jsonb_build_object('jobId', j.id, 'server', r.name, 'agent', pb.display_name, 'requestedFor', pf.display_name,
          'command', j.command[1], 'status', j.status, 'exitCode', j.exit_code, 'createdAt', j.created_at, 'finishedAt', j.finished_at,
          'durationMs', j.duration_ms, 'errorMessage', j.error_message,
          'output', (select string_agg(e.data ->> 'line', chr(10) order by e.seq) from (select e2.seq, e2.data from runner_job_event e2
                      where e2.org_id = j.org_id and e2.job_id = j.id and e2.type = 'log' order by e2.seq limit 300) e)) v
          from runner_job j join runner r on r.id = j.runner_id left join person pb on pb.id = j.requested_by left join person pf on pf.id = j.requested_for
         where j.org_id = current_org() and j.profile = 'root' order by j.created_at desc limit greatest(1, least(coalesce(p_limit, 50), 200))) x), '[]'::jsonb),
    'grants', coalesce((select jsonb_agg(jsonb_build_object('agent', pa.display_name, 'agentId', t.agent_id, 'server', r.name, 'serverId', r.id,
          'tier', t.tier, 'timeLimitSec', t.time_limit_sec, 'by', pg.display_name, 'at', t.granted_at, 'active', r.ai_employees) order by t.granted_at desc)
        from agent_server_tier t join runner r on r.id = t.runner_id join person pa on pa.id = t.agent_id left join person pg on pg.id = t.granted_by
       where t.org_id = current_org() and t.tier = 'root'), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(x.v order by x.at desc) from (
        select l.at, jsonb_build_object('at', l.at, 'agent', pa.display_name, 'server', r.name, 'fromTier', l.from_tier, 'toTier', l.to_tier, 'by', pb.display_name, 'reason', l.reason) v
          from agent_server_tier_log l join runner r on r.id = l.runner_id join person pa on pa.id = l.agent_id left join person pb on pb.id = l.by_person
         where l.org_id = current_org() order by l.at desc limit 100) x), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------------------------------------------------- 1590, with tiers
create or replace function pulse.runner_server_list() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); agent uuid := agent_session(); ask boolean := false;
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if agent is null and not viewer_is('admin') then raise exception 'Servers are for organisation admins and AI employees' using errcode = '42501'; end if;
  if agent is not null then select coalesce(server_writes_ask, false) into ask from agent_member where person_id = agent; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'online', r.last_seen_at > now() - interval '90 seconds',
      'accessLevel', r.access_level, 'sandbox', r.sandbox, 'aiEmployees', r.ai_employees,
      'mayUse', case when agent is null then true else r.ai_employees end,
      'askFirstForWrites', case when agent is null then false else ask end,
      'tier', case when agent is null then 'admin' else agent_server_tier_of(agent, r.id) ->> 'tier' end,
      'timeLimitSec', case when agent is null then 1800 else (agent_server_tier_of(agent, r.id) ->> 'timeLimitSec')::int end,
      'directShell', coalesce((r.capabilities #>> '{shell,direct}')::boolean, false),
      'rootShell', coalesce((r.capabilities #>> '{shell,root}')::boolean, false),
      'claude', coalesce((r.capabilities #>> '{ai,claude,loggedIn}')::boolean, false),
      'codex', coalesce((r.capabilities #>> '{ai,codex,loggedIn}')::boolean, false),
      'hostname', r.hostname, 'os', r.os) order by r.created_at)
    from runner r where r.org_id = current_org() and r.status = 'active'), '[]'::jsonb);
end $$;

create or replace function pulse.runner_server_job_start(p_runner text, p_kind text, p_prompt text, p_command text[], p_profile text,
    p_time int, p_cap numeric, p_for uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); agent uuid := agent_session(); r runner%rowtype; jid text := 'job_' || replace(gen_random_uuid()::text, '-', '');
  appr jsonb; prof text := coalesce(p_profile, 'read-only'); who uuid; ask boolean := false; t jsonb; tier text; tl int; g agent_server_tier%rowtype;
  shellish boolean := p_kind in ('shell-safe', 'shell');
begin
  if me is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if agent is null and not viewer_is('admin') then raise exception 'Only an organisation admin or an AI employee runs work on a server' using errcode = '42501'; end if;
  if agent is not null and agent_paused() then raise exception 'AI employees are paused in this company' using errcode = '42501'; end if;
  select * into r from runner where org_id = current_org() and status = 'active' and (id = p_runner or lower(name) = lower(btrim(p_runner)))
   order by (id = p_runner) desc, created_at limit 1;
  if r.id is null then raise exception 'No server is called %. list_servers shows the company’s servers.', p_runner using errcode = 'P0002'; end if;
  if agent is not null and not r.ai_employees then
    raise exception 'AI employees may not use % yet: an organisation admin turns on “AI employees may use this server” in Settings → Servers.', r.name using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('claude', 'codex', 'shell-safe', 'shell') then raise exception 'mode is shell, claude or codex' using errcode = '22023'; end if;
  if prof not in ('read-only', 'write', 'shell', 'root') then raise exception 'level is read-only, write, full or root' using errcode = '22023'; end if;
  if agent is not null then t := agent_server_tier_of(agent, r.id); tier := t ->> 'tier'; end if;
  if prof = 'root' then
    if p_kind <> 'shell' then raise exception 'Root runs shell commands only' using errcode = '22023'; end if;
    if agent is null then raise exception 'Root jobs are for AI employees the organisation owner granted root' using errcode = '42501'; end if;
    if tier is distinct from 'root' then
      raise exception 'You do not have root on %: only the organisation owner grants it, in your profile under Capabilities.', r.name using errcode = '42501';
    end if;
    select * into g from agent_server_tier where org_id = current_org() and agent_id = agent and runner_id = r.id;
  else
    if agent is not null and tier = 'read-only' and prof <> 'read-only' then
      raise exception 'You may only read on %: an organisation admin can raise your level in your profile under Capabilities.', r.name using errcode = '42501';
    end if;
    if not runner_level_allows(r.access_level, prof) then
      raise exception '% allows % work only. An organisation admin can raise it in Settings → Servers.', r.name, r.access_level using errcode = '42501';
    end if;
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
  if prof = 'root' then
    appr := jsonb_build_object('approvedBy', jsonb_build_object('id', g.granted_by, 'name', (select display_name from person where id = g.granted_by)),
      'approvedAt', g.granted_at, 'standing', true, 'tier', 'root');
    tl := least(coalesce(p_time, g.time_limit_sec), g.time_limit_sec);
  elsif prof <> 'read-only' then
    appr := case when agent is null then jsonb_build_object('approvedBy', jsonb_build_object('id', me, 'name', (select display_name from person where id = me)), 'approvedAt', now())
      else jsonb_build_object('approvedBy', jsonb_build_object('id', r.access_set_by, 'name', (select display_name from person where id = r.access_set_by)),
        'approvedAt', r.access_set_at, 'standing', true) end;
  end if;
  insert into runner_job(org_id, id, runner_id, kind, prompt, command, profile, approval, time_limit_sec, cost_cap_usd, requested_by, requested_for)
    values (current_org(), jid, r.id, p_kind, case when shellish then null else p_prompt end, case when shellish then p_command end,
            prof, appr, coalesce(tl, greatest(1, least(coalesce(p_time, 600), 14400))), case when shellish then null else coalesce(p_cap, 2) end,
            me, coalesce(who, case when agent is null then me end));
  return jsonb_build_object('id', jid, 'status', 'queued', 'server', r.name, 'serverId', r.id, 'kind', p_kind, 'profile', prof, 'accessLevel', r.access_level,
    'tier', coalesce(tier, 'admin'));
end $$;

-- 1560's stamp, with root: a root job needs the owner's root grant to the AI employee who asked, on a server that lets
-- AI employees in (the server's level does not apply: the grant is the approval).
create or replace function pulse.runner_job_stamp() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare r runner%rowtype;
begin
  select * into r from runner where org_id = new.org_id and id = new.runner_id;
  if r.id is null then raise exception 'No such server' using errcode = 'P0002'; end if;
  new.access_level := r.access_level;
  new.sandbox := case when new.profile = 'root' then false else r.sandbox end;
  new.requested_by_type := case when exists(select 1 from agent_member m where m.person_id = new.requested_by) then 'ai-employee' else 'person' end;
  if new.profile = 'root' then
    if not (r.ai_employees and exists(select 1 from agent_server_tier t where t.org_id = new.org_id and t.runner_id = r.id
                                        and t.agent_id = new.requested_by and t.tier = 'root')) then
      raise exception 'Root on % needs the organisation owner’s root grant to this AI employee', r.name using errcode = '42501';
    end if;
  elsif not runner_level_allows(r.access_level, new.profile) then
    raise exception 'This server allows % work only. An admin can raise its access in Settings → Servers.', r.access_level using errcode = '42501';
  end if;
  if new.requested_by_type = 'ai-employee' and not r.ai_employees then
    raise exception 'AI employees may not use this server' using errcode = '42501';
  end if;
  return new;
end $$;

revoke all on function pulse.org_owner_or_superadmin(), pulse.agent_server_tier_of(uuid, text), pulse.agent_server_tier_set(uuid, text, text, int, text, text),
  pulse.agent_root_revoke_all(text), pulse.runner_root_audit(int) from public;
grant execute on function pulse.org_owner_or_superadmin(), pulse.agent_server_tier_of(uuid, text), pulse.agent_server_tier_set(uuid, text, text, int, text, text),
  pulse.agent_root_revoke_all(text), pulse.runner_root_audit(int) to pulse_api;

-- migrate:down
drop function if exists pulse.runner_root_audit(int), pulse.agent_root_revoke_all(text), pulse.agent_server_tier_set(uuid, text, text, int, text, text),
  pulse.agent_server_tier_of(uuid, text), pulse.org_owner_or_superadmin();
drop table if exists pulse.agent_server_tier_log;
drop table if exists pulse.agent_server_tier;
alter table pulse.runner_job drop constraint if exists runner_job_root_check, drop constraint if exists runner_job_shell_check;
