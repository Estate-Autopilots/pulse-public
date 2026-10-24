-- migrate:up
-- PULSE-HQ (owner, 23 Oct 2026): each feature in the catalogue opens the page where it lives in Pulse. An explicit
-- address per feature (null where it has no page of its own: a background service or an idea), read by every
-- organisation through pulse.pulse_features(). Safe on a live install: additive.

alter table pulse.hq_feature add column href text check (href is null or href ~ '^/[A-Za-z0-9/?=&._-]*$');

do $$
declare v_org uuid;
begin
  select id into v_org from pulse.org where handle = 'pulsehq';
  if v_org is null then return; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  update pulse.hq_feature f set href = v.href from (values
  ('focus-home', '/home'),
  ('chat-home', '/chats'),
  ('sales-home', '/dashboard'),
  ('my-desk', '/me'),
  ('leadership-people', '/leadership'),
  ('updates-feed', '/updates'),
  ('role-briefs', '/briefs'),
  ('page-insights', '/dashboard'),
  ('command-search', '/search'),
  ('smart-notifications', '/notifications'),
  ('tasks-views', '/tasks'),
  ('projects', '/tasks?view=projects'),
  ('team-dashboard', '/tasks?view=team'),
  ('task-focus', '/tasks'),
  ('pip-task-plan', '/tasks'),
  ('task-review', '/me/approvals'),
  ('task-companion', '/tasks'),
  ('work-pool', '/tasks'),
  ('outcomes', '/tasks/outcomes'),
  ('processes-library', '/processes'),
  ('process-builder', '/processes'),
  ('describe-process', '/processes/new'),
  ('try-process', '/processes'),
  ('runs', '/runs'),
  ('my-steps', '/me/steps'),
  ('step-work-screens', '/steps'),
  ('field-forms', '/sops/forms'),
  ('sop-import', '/sops/drive'),
  ('process-scorecard', '/runs/scorecard'),
  ('process-libraries', '/processes/libraries'),
  ('industry-packs', '/settings?tab=industry'),
  ('flow-apps', '/settings?tab=apps'),
  ('team-chats', '/chats'),
  ('chat-side-panel', '/chats'),
  ('chat-tasks', '/chats'),
  ('voice-messages', '/chats'),
  ('calls', '/calls'),
  ('email-inbox', '/inbox'),
  ('ai-employees', '/people/ai'),
  ('pip-assistant', '/dashboard'),
  ('pip-in-steps', '/steps'),
  ('whatsapp-import', '/chats/import'),
  ('whatsapp-names', '/review-data/whatsapp-names'),
  ('team-directory', '/people'),
  ('org-chart', '/people/org'),
  ('hr-desk', '/hr'),
  ('auto-attendance', '/me'),
  ('leave-shifts', '/shifts'),
  ('hr-policies', '/hr'),
  ('employee-onboarding', '/welcome'),
  ('joining-leaving', '/hr/moves'),
  ('pay-records', '/people/pay'),
  ('payroll', '/people/pay/payroll'),
  ('skills-cv', '/people/skills'),
  ('internal-jobs', '/people/jobs'),
  ('career-coach', null),
  ('fair-work', null),
  ('separation-of-duties', null),
  ('finance-overview', '/finance'),
  ('finance-entries', '/finance'),
  ('ca-desk', '/finance/desk'),
  ('people-cost', '/finance/people-cost'),
  ('billing-documents', '/erp'),
  ('catalogue', '/erp/catalog'),
  ('billing-templates', '/erp/templates'),
  ('quote-followups', '/quotes'),
  ('ad-spend', '/research'),
  ('clients-crm', '/clients'),
  ('contacts', '/contacts'),
  ('client-identity', '/clients?tab=master'),
  ('acquisition', '/acquisition'),
  ('site-visits', '/clients'),
  ('client-portal', '/portal'),
  ('delivery-workbench', '/delivery'),
  ('relationships-graph', '/relationships'),
  ('pulse-map', '/map'),
  ('talent-board', '/contacts/models'),
  ('creative-strategy', '/creative'),
  ('designers-board', '/designers'),
  ('asset-tracker', '/steps'),
  ('media-review', '/steps'),
  ('shoot-planning', '/steps'),
  ('brand-sheet', '/brand'),
  ('xray-connect', '/apps/sales-xray'),
  ('xray-calls-leads', '/apps/sales-xray'),
  ('xray-in-processes', '/processes'),
  ('pulse-network', '/network'),
  ('org-switcher', '/orgs'),
  ('start-own-pulse', '/orgs/new'),
  ('portable-profile', '/orgs/profile'),
  ('licences-register', '/orgs/licences'),
  ('desktop-app', '/apps'),
  ('phone-app', '/apps'),
  ('chrome-extension', '/apps'),
  ('activity-collector', '/apps'),
  ('push-notifications', '/notifications'),
  ('install-guides', '/apps'),
  ('organisation-settings', '/settings?tab=organisation'),
  ('roles-permissions', '/settings?tab=roles'),
  ('screens-per-role', '/settings'),
  ('module-switches', '/settings'),
  ('sign-in-security', '/login'),
  ('audit-log', '/audit'),
  ('review-data', '/review-data'),
  ('sealed-documents', '/people'),
  ('company-setup', '/companies'),
  ('data-import', '/opshub'),
  ('api-v1', '/developers'),
  ('developers-page', '/developers'),
  ('partner-agent-api', '/developers'),
  ('webhooks', '/developers'),
  ('company-connectors', '/settings'),
  ('drive-sync', '/settings?tab=connected'),
  ('self-hosted', null),
  ('pulse-cli', '/developers'),
  ('pulse-mcp', '/developers'),
  ('whatsapp-client-chat', null)
  ) as v(key, href) where f.org_id = v_org and f.key = v.key and f.href is null;
  perform set_config('pulse.org_id', '', true);
end $$;

create or replace function pulse.pulse_features() returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare v_org uuid; v_back text := coalesce(current_setting('pulse.org_id', true), ''); r jsonb;
begin
  if current_org() is null then return '[]'::jsonb; end if;
  select id into v_org from org where handle = 'pulsehq';
  if v_org is null then return '[]'::jsonb; end if;
  perform set_config('pulse.org_id', v_org::text, true);
  select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'key', f.key, 'category', f.category, 'name', f.name, 'promise', f.promise,
      'what', f.what, 'who', f.who, 'status', f.status, 'icon', f.icon, 'proof', f.proof, 'href', f.href, 'sort', f.sort)
    order by f.category, f.sort, f.name), '[]'::jsonb) into r
  from hq_feature f where f.org_id = v_org and not f.archived;
  perform set_config('pulse.org_id', v_back, true);
  return r;
end $$;
revoke all on function pulse.pulse_features() from public;
grant execute on function pulse.pulse_features() to pulse_api;

-- migrate:down
alter table pulse.hq_feature drop column if exists href;
