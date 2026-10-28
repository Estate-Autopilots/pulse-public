-- migrate:up
-- DE-EA (owner, 28 Oct 2026: "make Pulse ready as a product for any company"): the Google Workspace groups a company
-- expects (Groups → "missing") are its own tenant config, tenant/workspace_groups {domain, required}, read by
-- services/api/src/groups.ts. Code no longer carries one company's list or domain. The install company that had that
-- list keeps it as its own config, so its Groups screen is unchanged; every other company expects none.
do $$
declare v_org uuid;
begin
  select id into v_org from pulse.org where handle = 'estateautopilots';
  if v_org is null then return; end if;
  perform pulse.acct_enter(v_org, null);
  perform set_config('pulse.actor_account', 'migration 1330 (DE-EA)', true);
  if not exists (select 1 from pulse.tenant_config where org_id = v_org and doc_kind = 'tenant' and doc_key = 'workspace_groups') then
    insert into pulse.tenant_config(org_id, doc_kind, doc_key, version, body, is_active)
    values (v_org, 'tenant', 'workspace_groups', 1, jsonb_build_object('domain', 'estateautopilots.com',
      'required', jsonb_build_array('team', 'leadership', 'pod1', 'pod2', 'pgs', 'creative', 'production', 'social', 'ops', 'billing', 'alerts')), true);
  end if;
  perform pulse.acct_leave();
end $$;

-- migrate:down
-- Forward-only: a company's config is kept.
