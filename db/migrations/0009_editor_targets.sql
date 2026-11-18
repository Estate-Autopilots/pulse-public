-- migrate:up
-- Editor targets are a tenant-owned configuration document, separate from product defaults.
alter table pulse.tenant_config drop constraint tenant_config_doc_kind_check;
alter table pulse.tenant_config add constraint tenant_config_doc_kind_check check (doc_kind in (
  'tenant','role_pack','phase_plan','folder_rules','benchmarks','packages','visibility_policy',
  'retention_policy','rubric','targets'
));
-- migrate:down
-- Targets were introduced by this migration, so remove their documents before restoring the old constraint.
delete from pulse.tenant_config where doc_kind = 'targets';
alter table pulse.tenant_config drop constraint tenant_config_doc_kind_check;
alter table pulse.tenant_config add constraint tenant_config_doc_kind_check check (doc_kind in (
  'tenant','role_pack','phase_plan','folder_rules','benchmarks','packages','visibility_policy',
  'retention_policy','rubric'
));
