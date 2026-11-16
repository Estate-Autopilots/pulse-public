-- migrate:up
-- FIX-AI-EMPLOYEES (owner walkthrough, 10 Nov 2026, D1: "the AI employee page is a big list with no data … cards showing
-- role, what each one did today, what it's waiting on, and its cost. Make Autopilots the main view").
-- agent_costs(day): for each AI employee the viewer may see (as agent_workload: admins and leadership every one, a manager
-- theirs), what it cost on that day and in that day's month, in tokens and, when the platform has a price for the engine,
-- in rupees (platform_ai_inr, 1430: null when no price is known, so the screen never shows a made-up number); its budget
-- (agent_budget_state, 1840); what it works with (its tools); when it last worked; and how much work is queued for it.
-- Read only; no new table.
-- The API adds this to GET /api/v0/agents/workload, so the route and who may read it are unchanged.

create function pulse.agent_costs(p_day date default null) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); tz text := org_time_zone(); d date := coalesce(p_day, (now() at time zone org_time_zone())::date); everyone boolean;
  t0 timestamptz; t1 timestamptz; m0 timestamptz; staff boolean;
begin
  if agent_session() is not null or me is null then raise exception 'A person reads this' using errcode = '42501'; end if;
  everyone := viewer_is('admin', 'leadership');
  if not everyone and not exists(select 1 from agent_member where org_id = current_org() and owner_person_id = me) then
    raise exception 'Leaders and AI employees'' managers see this' using errcode = '42501'; end if;
  staff := exists(select 1 from person where id = me and org_id = current_org() and side = 'staff' and status = 'active');
  t0 := d::timestamp at time zone tz; t1 := (d + 1)::timestamp at time zone tz; m0 := date_trunc('month', d)::timestamp at time zone tz;
  return jsonb_build_object('day', d, 'priced', exists(select 1 from pulse_priv.platform_ai_price),
    'agents', (select coalesce(jsonb_object_agg(m.person_id, jsonb_build_object(
      'today', (select jsonb_build_object('tokens', coalesce(sum(r.tokens), 0),
          'inr', case when count(*) = 0 then 0 when bool_and(r.inr is not null) then sum(r.inr) end)
        from (select coalesce(r.tokens, 0) tokens, platform_ai_inr(coalesce(r.engine, nullif(r.model, ''), '*'), coalesce(r.tokens_in, r.tokens, 0), coalesce(r.tokens_out, 0)) inr
                from agent_run r where r.org_id = current_org() and r.agent_id = m.person_id and r.started_at >= t0 and r.started_at < t1) r),
      'month', (select jsonb_build_object('tokens', coalesce(sum(r.tokens), 0),
          'inr', case when count(*) = 0 then 0 when bool_and(r.inr is not null) then sum(r.inr) end)
        from (select coalesce(r.tokens, 0) tokens, platform_ai_inr(coalesce(r.engine, nullif(r.model, ''), '*'), coalesce(r.tokens_in, r.tokens, 0), coalesce(r.tokens_out, 0)) inr
                from agent_run r where r.org_id = current_org() and r.agent_id = m.person_id and r.started_at >= m0 and r.started_at < t1) r),
      -- agent_budget_state answers only active staff (it raises otherwise), so anyone else gets no budget, not an error.
      'budget', case when staff then agent_budget_state(m.person_id) end,
      'tools', to_jsonb(coalesce(m.tools, '{}')),
      'lastRunAt', (select max(r.started_at) from agent_run r where r.org_id = current_org() and r.agent_id = m.person_id and r.started_at < t1),
      'queued', (select count(*) from agent_event e where e.org_id = current_org() and e.agent_id = m.person_id and e.state = 'queued'),
      'running', exists(select 1 from agent_run r where r.org_id = current_org() and r.agent_id = m.person_id and r.state = 'dispatching'
                        and r.started_at > now() - interval '30 minutes'))), '{}'::jsonb)
      from agent_member m where m.org_id = current_org() and (everyone or m.owner_person_id = me)));
end $$;
revoke all on function pulse.agent_costs(date) from public;
grant execute on function pulse.agent_costs(date) to pulse_api;

-- migrate:down
-- Forward-only.
