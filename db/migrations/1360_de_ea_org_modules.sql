-- migrate:up
-- DE-EA phase 2 (owner, 28 Oct 2026): tenant-facing modules switch per company and per plan, not per server
-- (services/api/src/modules.ts ORG_CHOSEN: chat_import, connectors, creative, sales_xray). A company has one when its
-- tenant/modules document names it in `on` or its industry pack brings it, this install offers it (the server variable)
-- and its plan allows it.
--   * pulse.org_plan(): the current company's plan (pulse_priv.platform_plan), null without a plan row.
--   * Every company that has a modules document today keeps what it had: the four are added to its `on`, so nothing
--     changes on any install (where the server offers them, they stay on; where it does not, they stay off). A company
--     without a document keeps the install's offer until it is configured. New companies get them from their pack,
--     their own setting or their plan.
create or replace function pulse.org_plan() returns text language sql stable security definer set search_path=pulse,pg_temp as $$
  select plan from pulse_priv.platform_plan where for_org = pulse.current_org()
$$;
revoke all on function pulse.org_plan() from public;
grant execute on function pulse.org_plan() to pulse_api;

do $$
declare o record; cur pulse.tenant_config; v int; body jsonb;
  chosen jsonb := '["chat_import","connectors","creative","sales_xray"]'::jsonb;
begin
  for o in select id from pulse.org loop
    perform pulse.acct_enter(o.id, null);
    perform set_config('pulse.actor_account', 'migration 1360 (DE-EA)', true);
    select * into cur from pulse.tenant_config where org_id = o.id and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
    if cur.org_id is not null then
      body := jsonb_set(cur.body, '{on}', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from (
        select jsonb_array_elements_text(coalesce(cur.body->'on', '[]'::jsonb)) x union select jsonb_array_elements_text(chosen)) u));
      if body is distinct from cur.body then
        select max(version) + 1 into v from pulse.tenant_config where org_id = o.id and doc_kind = 'tenant' and doc_key = 'modules';
        update pulse.tenant_config set is_active = false where org_id = o.id and doc_kind = 'tenant' and doc_key = 'modules' and is_active;
        insert into pulse.tenant_config(org_id, doc_kind, doc_key, version, body, is_active) values (o.id, 'tenant', 'modules', v, body, true);
      end if;
    end if;
    perform pulse.acct_leave();
  end loop;
end $$;

-- migrate:down
-- Forward-only: each company's module switches are kept.
