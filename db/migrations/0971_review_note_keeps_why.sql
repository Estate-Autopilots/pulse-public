-- migrate:up
-- READY (EA AI team lane, 23 Oct 2026): a reviewer's note overwrote the task's "Why it matters" (value_note).
-- task_review (0310) wrote value_note=coalesce(value_note,note), so on a task without a why the review note became it;
-- the older task_accept (0310) replaced it outright. The review note is already kept with the acceptance in the task's
-- history (task_event 'accepted'), so accepting must leave "Why it matters" as its author wrote it. One BEFORE UPDATE
-- trigger: on the update that accepts a task (status becomes accepted), value_note keeps its old value. Edits of the
-- why at any other time (task_save) are untouched. No function body is copied.

create function pulse.task_accept_keeps_why() returns trigger language plpgsql set search_path = pulse, pg_temp as $$
begin
 if new.status = 'accepted' and old.status is distinct from 'accepted' then
  new.value_note := old.value_note;
 end if;
 return new;
end $$;
revoke all on function pulse.task_accept_keeps_why() from public;
create trigger task_accept_keeps_why before update of status on pulse.task for each row execute function pulse.task_accept_keeps_why();

-- migrate:down
-- Forward-only.
