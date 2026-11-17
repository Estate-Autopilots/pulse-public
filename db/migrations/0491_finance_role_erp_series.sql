-- migrate:up
-- EST-1229 (reported by a self-hosted install that patched both by hand on 17 Oct 2026; this applies cleanly over it).
--   * Settings → Roles grants and ends the Finance role that ERP-INVOICE checks (0190 viewer_is('finance')): the
--     admin-only role_grant and role_end policies list every key the API offers (services/api/src/settings.ts ROLES).
--     'privacy' stays out: only the operator's break-glass path grants it (0176).
--   * Saving ERP settings writes this year's numbering pattern (services/api/src/erp.ts). pulse_api may insert a series
--     and change its pattern; the running number and last date stay with erp_document_issue (security definer), so the
--     API never moves a gapless GST series. A hand-made table-wide grant is replaced by these column grants. The tenant,
--     erp_insert and erp_update policies (0190) keep the writes in the viewer's organisation and to ERP writers.
drop policy if exists role_grant on pulse.role_assignment;
create policy role_grant on pulse.role_assignment as restrictive for insert to pulse_api
 with check(pulse.viewer_is('admin') and role_key in('admin','hr','leadership','finance','manager','pgs','head_pgs'));
drop policy if exists role_end on pulse.role_assignment;
create policy role_end on pulse.role_assignment as restrictive for update to pulse_api
 using(pulse.viewer_is('admin') and role_key in('admin','hr','leadership','finance','manager','pgs','head_pgs')) with check(pulse.viewer_is('admin'));

drop policy if exists tenant on pulse.erp_series;
create policy tenant on pulse.erp_series using(org_id=pulse.current_org()) with check(org_id=pulse.current_org());
drop policy if exists erp_insert on pulse.erp_series;
create policy erp_insert on pulse.erp_series as restrictive for insert to pulse_api with check((select pulse.erp_can(true)));
drop policy if exists erp_update on pulse.erp_series;
create policy erp_update on pulse.erp_series as restrictive for update to pulse_api using((select pulse.erp_can(true))) with check((select pulse.erp_can(true)));
revoke insert, update on pulse.erp_series from pulse_api;
grant insert (org_id, doc_type, fy, pattern), update (pattern) on pulse.erp_series to pulse_api;

-- migrate:down
-- Forward-only.
