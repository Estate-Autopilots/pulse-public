-- migrate:up
-- CI (23 Oct 2026): since the ATT notification policy (0860, rule 3) a reminder is not sent again while the person's
-- earlier one for the same subject is unread, so a quotation follow-up (0520: one open task and one notice per
-- occurrence, "Follow up on a quotation today") told its salesperson only the first time: every later occurrence of an
-- unanswered quotation was silent while the first notice sat unread. A new follow-up notice now replaces the earlier
-- unread one for the same task (marked read and dismissed, kept in the record), as the daily review nudge does (0967),
-- so the bell still holds one line per quotation and the policy's no-stacking rule is kept. Runs before
-- notification_zz_policy (triggers of one event fire in name order). No function body is copied.

create function pulse.notification_quote_followup_supersede() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 update notification set read_at = coalesce(read_at, now()), dismissed_at = now()
  where org_id = new.org_id and person_id = new.person_id and event_type = new.event_type and subject_id = new.subject_id
    and event_key like 'quote_followup:%' and event_key <> new.event_key and dismissed_at is null;
 return new;
end $$;
revoke all on function pulse.notification_quote_followup_supersede() from public;
create trigger notification_qf_supersede before insert on pulse.notification for each row
 when (new.event_type = 'task.due_soon' and new.event_key like 'quote_followup:%')
 execute function pulse.notification_quote_followup_supersede();

-- migrate:down
-- Forward-only.
