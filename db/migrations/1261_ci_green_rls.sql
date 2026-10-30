-- migrate:up
-- 1260's sign-in codes are one organisation's rows: forced row security like every tenant table (acceptance isolation).
alter table pulse_priv.device_signin_code force row level security;
create policy tenant on pulse_priv.device_signin_code using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- 1230: the organisation's AI policy is read by those who may change AI employees' risk settings, not every colleague.
create or replace function pulse.agent_org_policy_read() returns jsonb language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if not (viewer_is('admin') or viewer_is('hr') or viewer_is('leadership')) then
    raise exception 'Admins, HR and leadership see the AI policy' using errcode = '42501';
  end if;
  return jsonb_build_object('clientsOn', coalesce((select clients_on from agent_org_policy where org_id = current_org()), false));
end $$;

-- migrate:down
create or replace function pulse.agent_org_policy_read() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
  select jsonb_build_object('clientsOn', coalesce((select clients_on from agent_org_policy where org_id = current_org()), false))
$$;
drop policy if exists tenant on pulse_priv.device_signin_code;
alter table pulse_priv.device_signin_code no force row level security;
