-- migrate:up
-- AI-TOOLS-FIX (owner, 17 Nov 2026: "AI employees can actually do the tasks they are given"; EA bug #25, since 6 Nov).
-- When an AI employee's run went to a company server (its "runner" engine, RUNNERS-FULL), the job's own Pulse MCP token
-- (pmt_, 1560) was refused on every area: pulse.v1_runner_principal only took a token whose job a staff person asked
-- for, and an AI employee's person is side 'agent'. So /api/v1/mcp answered 403 "This key has no API v1 area grants
-- here" for every such job (EA production: every 403 on 7-10 and 17 Nov is one of these jobs, two calls each).
--
-- Now a job an AI employee asked for (requested_by_type 'ai-employee', set by runner_job_stamp) resolves as that AI
-- employee, with exactly what its own key would reach: its member row live and its person active, its company's AI
-- employees not paused, only the areas its managers left it (agent_member.v1_areas, all by default), and an AI session
-- (agent_session()), so every person-only check still refuses it. The token keeps its own limits: read areas only
-- (runner_mcp_issue), only while the job is delivered or running on an active server, never after it expires.
-- A job a person asked for resolves as before.
create or replace function pulse.v1_runner_principal(p_hash text, p_scope text) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare t pulse_priv.runner_mcp_token%rowtype; by_ai boolean;
begin
  if current_viewer() is not null or p_scope is null or not (p_scope = any(v1_scopes())) then return null; end if;
  select * into t from pulse_priv.runner_mcp_token where org_id = current_org() and token_hash = p_hash and revoked_at is null and expires_at > now() and p_scope = any(scopes);
  if not found then return null; end if;
  select j.requested_by_type = 'ai-employee' into by_ai from runner_job j join runner r on r.id = j.runner_id
   where j.org_id = current_org() and j.id = t.job_id and j.status in ('delivered', 'running') and r.status = 'active';
  if by_ai is null then return null; end if;
  if by_ai then
    if agent_paused() then return null; end if;
    if not exists(select 1 from agent_member m join person p on p.id = m.person_id
                   where m.org_id = current_org() and m.person_id = t.person_id and m.disabled_at is null
                     and p.status = 'active' and p.side = 'agent' and p_scope = any(coalesce(m.v1_areas, v1_scopes()))) then return null; end if;
    perform set_config('pulse.viewer_id', t.person_id::text, true);
    perform set_config('pulse.agent_session', 'on', true);
    if agent_session() is distinct from t.person_id then
      perform set_config('pulse.viewer_id', '', true);
      perform set_config('pulse.agent_session', '', true);
      return null;
    end if;
  else
    if not exists(select 1 from person where org_id = current_org() and id = t.person_id and status = 'active' and side = 'staff') then return null; end if;
    perform set_config('pulse.viewer_id', t.person_id::text, true);
    if exists(select 1 from login_credential where person_id = t.person_id and status = 'disabled') then
      perform set_config('pulse.viewer_id', '', true);
      return null;
    end if;
  end if;
  perform set_config('pulse.actor_account', 'runner:' || t.job_id, true);
  perform set_config('pulse.app_label', 'Pulse Runner', true);
  return t.id;
end $$;
revoke all on function pulse.v1_runner_principal(text, text) from public;
grant execute on function pulse.v1_runner_principal(text, text) to pulse_api;

-- migrate:down
-- The 1560 body (staff people only; it refuses every AI employee's job token, EA bug #25).
create or replace function pulse.v1_runner_principal(p_hash text, p_scope text) returns uuid
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
