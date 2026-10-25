-- migrate:up
-- EST-2577: immutable org/key receipts, committed atomically with the task ids inside result.created.
-- v1_replay is token/operation scoped and cannot enforce this staff-person contract.
create table pulse.task_import (
  org_id uuid not null references pulse.org(id),
  import_key uuid not null,
  creator_id uuid not null references pulse.person(id),
  result jsonb not null check (jsonb_typeof(result)='object'),
  created_at timestamptz not null default now(),
  primary key (org_id,import_key)
);
alter table pulse.task_import enable row level security;
alter table pulse.task_import force row level security;
create policy tenant on pulse.task_import using (org_id=pulse.current_org()) with check (org_id=pulse.current_org() and creator_id=pulse.current_viewer());
grant select,insert on pulse.task_import to pulse_api;
-- migrate:down
-- Forward-only: preserve receipts across a code rollback so retries cannot recreate imported tasks.
