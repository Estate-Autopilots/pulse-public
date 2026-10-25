-- migrate:up
-- EST-647: an organisation that switches HR off (tenant_config tenant/modules, services/api/src/modules.ts) stops
-- recording office presence. The tick runs from the API and from the worker, so the switch is read where it records.
create function pulse.module_off(p_key text) returns boolean language sql stable security definer
set search_path=pulse,pg_temp as $$
  select coalesce((select jsonb_typeof(body->'off')='array' and body->'off' ? p_key from tenant_config
    where org_id=current_org() and doc_kind='tenant' and doc_key='modules' and is_active), false)
$$;
revoke all on function pulse.module_off(text) from public;
grant execute on function pulse.module_off(text) to pulse_api,pulse_worker;

do $$
declare
  definition text;
  changed text;
  policy_read text := 'select * into pol from hr_policy where org_id=current_org();';
begin
  definition := pg_get_functiondef('pulse.companion_presence_tick(uuid)'::regprocedure);
  if position(policy_read in definition) = 0 then raise exception 'companion_presence_tick policy read changed'; end if;
  changed := replace(definition, policy_read, 'if module_off(''hr'') then return result; end if; ' || policy_read);
  if changed = definition then raise exception 'module switch could not update companion_presence_tick'; end if;
  execute changed;
end $$;

-- migrate:down
do $$
declare
  definition text;
begin
  definition := pg_get_functiondef('pulse.companion_presence_tick(uuid)'::regprocedure);
  execute replace(definition, 'if module_off(''hr'') then return result; end if; ', '');
end $$;
drop function pulse.module_off(text);
