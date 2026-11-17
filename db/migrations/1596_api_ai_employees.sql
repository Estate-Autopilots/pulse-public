-- migrate:up
-- API-PLATFORM-2 (owner, 5 Nov 2026: "complete control of Pulse through the API, agents, tier-wise access"), phase 2
-- item 4: the AI-employee admin API (v1-ai-employees.ts, under /api/v1/people/ai-employees). Company admins (people,
-- with their own key) create and list AI employees, set their tools, profile and daily budget, make and revoke their
-- bot keys (the areas each key may use), read their activity, and set a monthly token cap. Every change is on the app
-- ledger (pulse_priv.app_change) as ai_employee.*.
--
--  * The monthly cap (pulse_priv.ai_employee_cap, forced row security with the tenant policy): once an AI employee has
--    used its month's tokens (runs in the company's own month), agent_lock gives it no budget, exactly as the company's
--    plan limit does (1430): its runs wait until the month turns or an admin raises the cap.
--  * Bot keys made through the API go through api_token_issue's own rules (the tier's areas and bot-key seats), but a
--    v1 key may make one only when it is a company admin's own key (ai_employee_key_issue): an AI member's key, an app's
--    or a runner's never makes keys. Revoking a key needs confirm.

create table pulse_priv.ai_employee_cap (
 org_id uuid not null references pulse.org(id),
 person_id uuid primary key references pulse.person(id),
 monthly_tokens bigint not null check (monthly_tokens between 1000 and 100000000000),
 set_by uuid not null references pulse.person(id), set_at timestamptz not null default now()
);
alter table pulse_priv.ai_employee_cap enable row level security;
alter table pulse_priv.ai_employee_cap force row level security;
create policy tenant on pulse_priv.ai_employee_cap using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
revoke all on pulse_priv.ai_employee_cap from public, pulse_api, pulse_worker, pulse_ingest, pulse_privacy;

alter table pulse_priv.app_change drop constraint app_change_action_check;
alter table pulse_priv.app_change add constraint app_change_action_check check (action in (
  'profile.correct', 'password.issue', 'invite.send', 'chat.group.create', 'chat.members', 'feedback.status',
  'task.create', 'task.assign', 'task.update', 'task.complete', 'comment.add', 'project.create', 'stage.owner', 'stage.task',
  'chat.message', 'client.create', 'catalog.item.create', 'stock.move', 'quotation.create', 'quotation.revise', 'quotation.submit',
  'quotation.approve', 'quotation.send', 'invoice.create', 'invoice.issue', 'payment.record',
  'project.update', 'project.delete', 'expense.create', 'leave.request',
  'ai_employee.create', 'ai_employee.update', 'ai_employee.cap', 'ai_employee.key.create', 'ai_employee.key.revoke'));

-- Tokens an AI employee has used or reserved this month, in the company's own month (as agents.ts counts a day).
create function pulse.agent_month_tokens(p_agent uuid) returns bigint language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(sum(case when r.state in ('done', 'error') then coalesce(r.tokens, r.reserved) else r.reserved end), 0)::bigint
 from agent_run r where r.org_id = current_org() and r.agent_id = p_agent
  and r.started_at >= (date_trunc('month', now() at time zone org_time_zone()) at time zone org_time_zone())
$$;

-- 1430's agent_lock, plus the AI employee's own monthly cap.
create or replace function pulse.agent_lock(p_agent uuid) returns pulse.agent_member
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m agent_member; cap bigint;
begin
  select * into m from agent_member where person_id = p_agent and org_id = current_org() for update;
  if found and org_ai_blocked() then m.daily_token_budget := 0; end if;
  if found then
    select monthly_tokens into cap from pulse_priv.ai_employee_cap where org_id = current_org() and person_id = p_agent;
    if cap is not null and agent_month_tokens(p_agent) >= cap then m.daily_token_budget := 0; end if;
  end if;
  return m;
end $$;

create function pulse.ai_employee_admin(p_agent uuid) returns void language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if current_viewer() is null or current_org() is null or not viewer_is('admin')
   or not exists(select 1 from person where org_id = current_org() and id = current_viewer() and side = 'staff' and status = 'active')
  then raise exception 'Company admins manage AI employees' using errcode = '42501'; end if;
 if p_agent is not null and not exists(select 1 from agent_member a join person p on p.id = a.person_id
   where a.org_id = current_org() and a.person_id = p_agent and p.side = 'agent')
  then raise exception 'No such AI employee' using errcode = 'P0002'; end if;
end $$;

-- Every AI employee of the company, for its admins.
create function pulse.ai_employee_list() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 perform ai_employee_admin(null);
 return coalesce((select jsonb_agg(jsonb_build_object('id', m.person_id, 'employeeId', m.employee_id, 'name', p.display_name, 'title', m.title,
   'status', case when p.status <> 'active' or m.disabled_at is not null then 'off' when m.paused_reason is not null then 'paused' else 'on' end,
   'lane', m.lane, 'tools', to_jsonb(coalesce(m.tools, '{}'::text[])), 'ownerId', m.owner_person_id, 'dailyTokenBudget', m.daily_token_budget,
   'monthlyTokenCap', c.monthly_tokens, 'tokensThisMonth', agent_month_tokens(m.person_id),
   'liveKeys', (select count(*)::int from pulse_priv.api_token t where t.org_id = m.org_id and t.person_id = m.person_id and t.kind = 'bot' and t.revoked_at is null and t.expires_at > now()))
   order by m.employee_no)
  from agent_member m join person p on p.id = m.person_id left join pulse_priv.ai_employee_cap c on c.org_id = m.org_id and c.person_id = m.person_id
  where m.org_id = current_org() and p.side = 'agent'), '[]');
end $$;

-- p_tokens null removes the cap.
create function pulse.ai_employee_cap_set(p_agent uuid, p_tokens bigint) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 perform ai_employee_admin(p_agent);
 if p_tokens is null then
  delete from pulse_priv.ai_employee_cap where org_id = current_org() and person_id = p_agent;
 elsif p_tokens not between 1000 and 100000000000 then
  raise exception 'A monthly cap of 1,000 to 100,000,000,000 tokens' using errcode = '22023';
 else
  insert into pulse_priv.ai_employee_cap(org_id, person_id, monthly_tokens, set_by) values (current_org(), p_agent, p_tokens, current_viewer())
  on conflict (person_id) do update set monthly_tokens = excluded.monthly_tokens, set_by = excluded.set_by, set_at = now();
 end if;
 perform app_change_add('ai_employee.cap', p_agent, jsonb_build_object('monthlyTokens', p_tokens));
 return jsonb_build_object('monthlyTokenCap', p_tokens, 'tokensThisMonth', agent_month_tokens(p_agent));
end $$;

-- An AI employee's bot keys (never a secret or a digest).
create function pulse.ai_employee_keys(p_agent uuid) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 perform ai_employee_admin(p_agent);
 return coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'scopes', to_jsonb(t.scopes), 'createdAt', t.created_at, 'expiresAt', t.expires_at,
   'lastUsedAt', t.last_used_at, 'live', t.revoked_at is null and t.expires_at > now()) order by t.created_at desc)
  from pulse_priv.api_token t where t.org_id = current_org() and t.person_id = p_agent and t.kind = 'bot' and t.revoked_at is null), '[]');
end $$;

-- A bot key for an AI employee, made by a company admin with their own key (an AI member's, an app's or a runner's key
-- never makes keys). api_token_issue's rules apply as they do in Settings: the tier's areas, its bot-key seats.
create function pulse.ai_employee_key_issue(p_agent uuid, p_name text, p_scopes text[], p_days int, p_hash text) returns uuid
 language plpgsql security definer set search_path = pulse, pg_temp as $$
declare tok text := coalesce(current_setting('pulse.v1_token_id', true), ''); tid uuid;
begin
 -- The viewer must be an active staff admin: a bot key, a connected app and an AI employee key all act as an AI member.
 perform ai_employee_admin(p_agent);
 if coalesce(current_setting('pulse.agent_session', true), '') = 'on' then raise exception 'Company admins make bot keys with their own key' using errcode = '42501'; end if;
 -- api_token_issue refuses inside any API call (a key never makes keys by itself); this admin path is the one exception.
 perform set_config('pulse.v1_token_id', '', true);
 begin
  tid := api_token_issue('bot', p_name, p_scopes, p_days, p_agent, p_hash);
 exception when others then
  perform set_config('pulse.v1_token_id', tok, true); raise;
 end;
 perform set_config('pulse.v1_token_id', tok, true);
 perform app_change_add('ai_employee.key.create', p_agent, jsonb_build_object('keyId', tid, 'scopes', to_jsonb(p_scopes), 'days', p_days));
 return tid;
end $$;

create function pulse.ai_employee_key_revoke(p_agent uuid, p_key uuid) returns boolean language plpgsql security definer set search_path = pulse, pg_temp as $$
declare tok text := coalesce(current_setting('pulse.v1_token_id', true), '');
begin
 perform ai_employee_admin(p_agent);
 if coalesce(current_setting('pulse.agent_session', true), '') = 'on' then raise exception 'Company admins revoke bot keys with their own key' using errcode = '42501'; end if;
 if not exists(select 1 from pulse_priv.api_token where org_id = current_org() and id = p_key and person_id = p_agent and kind = 'bot' and revoked_at is null)
  then raise exception 'No such key of this AI employee' using errcode = 'P0002'; end if;
 -- api_token_end refuses inside any API call (a key never ends keys by itself); as with ai_employee_key_issue, this admin
 -- path (an admin's own key, this AI employee's bot key only, checked above) is the one exception.
 perform set_config('pulse.v1_token_id', '', true);
 begin
  perform api_token_end(p_key, 'revoked');
 exception when others then
  perform set_config('pulse.v1_token_id', tok, true); raise;
 end;
 perform set_config('pulse.v1_token_id', tok, true);
 perform app_change_add('ai_employee.key.revoke', p_agent, jsonb_build_object('keyId', p_key));
 return true;
end $$;

-- What an AI employee did through the API and on the ledger in the last p_days days: calls by operation and status,
-- refusals, writes by action, runs and tokens this month. Ids and counts only.
create function pulse.ai_employee_activity(p_agent uuid, p_days int) returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 7), 1), 90));
begin
 perform ai_employee_admin(p_agent);
 return jsonb_build_object('since', since,
  'calls', coalesce((select jsonb_agg(jsonb_build_object('operationId', x.operation_id, 'status', x.status, 'count', x.n) order by x.n desc, x.operation_id)
    from (select operation_id, status, count(*)::int n from pulse_priv.v1_call where org_id = current_org() and principal_id = p_agent and recorded_at >= since
          group by 1, 2 order by 3 desc limit 100) x), '[]'),
  'refused', (select count(*)::int from pulse_priv.v1_call where org_id = current_org() and principal_id = p_agent and recorded_at >= since and status >= 400),
  'writes', coalesce((select jsonb_agg(jsonb_build_object('action', y.action, 'count', y.n) order by y.n desc)
    from (select action, count(*)::int n from pulse_priv.app_change where org_id = current_org() and actor_id = p_agent and created_at >= since group by 1) y), '[]'),
  'lastCallAt', (select max(recorded_at) from pulse_priv.v1_call where org_id = current_org() and principal_id = p_agent),
  'runsThisMonth', (select count(*)::int from agent_run r where r.org_id = current_org() and r.agent_id = p_agent
    and r.started_at >= (date_trunc('month', now() at time zone org_time_zone()) at time zone org_time_zone())),
  'tokensThisMonth', agent_month_tokens(p_agent),
  'monthlyTokenCap', (select monthly_tokens from pulse_priv.ai_employee_cap where org_id = current_org() and person_id = p_agent));
end $$;

revoke all on function pulse.agent_month_tokens(uuid), pulse.ai_employee_admin(uuid), pulse.ai_employee_list(), pulse.ai_employee_cap_set(uuid,bigint),
 pulse.ai_employee_keys(uuid), pulse.ai_employee_key_issue(uuid,text,text[],int,text), pulse.ai_employee_key_revoke(uuid,uuid), pulse.ai_employee_activity(uuid,int) from public;
grant execute on function pulse.ai_employee_admin(uuid), pulse.ai_employee_list(), pulse.ai_employee_cap_set(uuid,bigint), pulse.ai_employee_keys(uuid),
 pulse.ai_employee_key_issue(uuid,text,text[],int,text), pulse.ai_employee_key_revoke(uuid,uuid), pulse.ai_employee_activity(uuid,int), pulse.agent_month_tokens(uuid) to pulse_api;
grant execute on function pulse.agent_month_tokens(uuid) to pulse_worker;

-- migrate:down
-- Forward only: dropping the cap table lifts every AI employee's monthly cap.
