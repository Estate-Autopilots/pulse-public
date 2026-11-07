-- migrate:up
-- READY (Datup, Atlas Crest, 17 Oct 2026: "too many tasks ask me to acknowledge"): the daily review nudge
-- ("4 finished tasks wait for your review; the oldest 9 days") is one line a day per reviewer, and every earlier one
-- stayed unread, so a reviewer saw the same line nine times and the unread count grew by one each day. Today's nudge now
-- replaces the earlier ones: when a new task.review_nudge reaches someone, their earlier unread nudges are marked read
-- and dismissed (kept in the record). One trigger; no function body is copied (task_review_tick, 0310/0422, is unchanged).
-- Existing duplicates are cleared the same way, per organisation.

create function pulse.notification_review_nudge_supersede() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 update notification set read_at = coalesce(read_at, now()), dismissed_at = now()
  where org_id = new.org_id and person_id = new.person_id and event_type = 'task.review_nudge' and id <> new.id and dismissed_at is null;
 return null;
end $$;
revoke all on function pulse.notification_review_nudge_supersede() from public;
create trigger notification_review_nudge_once after insert on pulse.notification for each row
 when (new.event_type = 'task.review_nudge') execute function pulse.notification_review_nudge_supersede();

do $$ declare o uuid;
begin
 for o in select id from pulse.org loop
  perform set_config('pulse.org_id', o::text, true);
  update pulse.notification n set read_at = coalesce(n.read_at, now()), dismissed_at = now()
   where n.org_id = o and n.event_type = 'task.review_nudge' and n.dismissed_at is null
     and exists (select 1 from pulse.notification m where m.org_id = o and m.person_id = n.person_id and m.event_type = 'task.review_nudge' and m.created_at > n.created_at);
 end loop;
 perform set_config('pulse.org_id', '', true);
end $$;

-- migrate:down
-- Forward-only.
