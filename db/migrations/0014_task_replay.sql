-- migrate:up
-- Event-derived task rows must stay deterministic under projection replay.
-- Imported/manual tasks set timestamps explicitly; protocol tasks keep this extension null.
alter table pulse.task alter column updated_at drop not null;
alter table pulse.task alter column updated_at drop default;
-- migrate:down
