-- migrate:up
-- Per-project delivery look-ups (project stages, "needs attention", the project list's latest files and counts) read
-- deliveries by project; without this index each of them scanned every delivery once per project.
create index if not exists delivery_project on pulse.delivery (org_id, project_id, delivered_at desc);
-- migrate:down
drop index if exists pulse.delivery_project;
