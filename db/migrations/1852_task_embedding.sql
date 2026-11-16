-- migrate:up
-- TASK-MERGE (decision model, DECISION-MODELS.md): sentence embeddings of open task titles, so the merge suggester can tell
-- that "Demo Tower 3 ka reel edit karna hai" and "Reel edit for Demo Tower 3" are the same work. A small static
-- multilingual model (sentence-transformers/static-similarity-mrl-multilingual-v1, Apache-2.0, cut to 256 dimensions)
-- runs in the worker on the CPU, only where the server turned it on (PULSE_TASK_MERGE_MODEL=static256; off by default).
-- The API reads cosine distances as the viewer; with no rows the suggester uses words and structure only.
create table pulse.task_embedding (
  org_id uuid not null references pulse.org(id),
  task_id uuid primary key references pulse.task(id) on delete cascade,
  model text not null check (length(model) <= 80),          -- model id, revision and dimensions: never compare across models
  text_hash text not null check (length(text_hash) = 32),   -- md5 of the text embedded: re-embed only when the title changes
  embedding public.halfvec(256) not null,
  at timestamptz not null default now()
);
create index task_embedding_model on pulse.task_embedding(org_id, model);
alter table pulse.task_embedding enable row level security;
alter table pulse.task_embedding force row level security;
create policy tenant_isolation on pulse.task_embedding using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- The API sees a vector only for a task the viewer may see.
create policy task_embedding_see on pulse.task_embedding as restrictive for select to pulse_api using (pulse.task_visible(task_id));
grant select on pulse.task_embedding to pulse_api;
grant select, insert, update, delete on pulse.task_embedding to pulse_worker;

-- Whether the merge suggester may use the decision model in this company: the worker has written vectors here.
create function pulse.merge_model_on() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select exists(select 1 from task_embedding where org_id = current_org())
$$;
revoke all on function pulse.merge_model_on() from public;
grant execute on function pulse.merge_model_on() to pulse_api, pulse_worker;

-- migrate:down
-- Forward-only: vectors are recomputed from titles; drop the table by hand only with the code that reads it.
