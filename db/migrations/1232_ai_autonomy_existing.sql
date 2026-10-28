-- migrate:up
-- AI-AUTONOMY: 1230's move of existing AI employees from "ask first" to "on its own" on direct messages and mentions
-- touched no row (row security is forced on agent_member and a migration has no organisation), so it runs here inside
-- each organisation in turn. Client conversations still ask first (agent_dispatch), and the risk policy still holds back
-- risky messages.
do $$
declare o record; n int; total int := 0;
begin
  for o in select id from pulse.org loop
    perform set_config('pulse.org_id', o.id::text, true);
    update pulse.agent_member set autonomy = autonomy
      || case when autonomy->>'direct' = 'approve' then '{"direct":"own"}'::jsonb else '{}'::jsonb end
      || case when autonomy->>'mention' = 'approve' then '{"mention":"own"}'::jsonb else '{}'::jsonb end
     where org_id = o.id and (autonomy->>'direct' = 'approve' or autonomy->>'mention' = 'approve');
    get diagnostics n = row_count; total := total + n;
  end loop;
  perform set_config('pulse.org_id', '', true);
  raise notice 'AI-AUTONOMY: % AI employees now answer direct messages and mentions on their own', total;
end $$;

-- migrate:down
-- Forward-only: set an AI employee back to Asks first on its profile (Behaviour).
