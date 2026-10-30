-- migrate:up
-- AI-AUTONOMY (28 Oct, production check): the one-card proposals (a triage's task changes, a new colleague, an HR
-- document) were left out of the follow-up's reminders: they sit in the approver's direct message with the AI employee
-- and are not reply/task cards, so EA's first triage card (22 changes, 12:14Z) would never be reminded. They now get
-- the same single reminder in working hours (after 4 hours; "Apply, or Don't"), and no escalation to someone else.
do $$
declare src text; was text;
begin
  src := pg_get_functiondef('pulse.agent_follow_up(text[])'::regprocedure); was := src;
  src := replace(src, $q$and state = 'pending' and kind in ('reply','task','summary')
              and channel_id <> dm_channel_id and$q$, $q$and state = 'pending' and (kind in ('reply','task','summary')
              and channel_id <> dm_channel_id or kind in ('batch','person','document')) and$q$);
  src := replace(src, $q$|| ' ' || case when pr.kind = 'task' then 'Create it, Edit, or Don''t' else 'Send it, Edit, or Don''t' end || ' on the card (a reply like “fine, send it” works too).',$q$,
    $q$|| ' ' || case when pr.kind = 'task' then 'Create it, Edit, or Don''t' when pr.kind in ('batch','person','document') then 'Apply, or Don''t' else 'Send it, Edit, or Don''t' end || ' on the card' || case when pr.kind in ('batch','person','document') then '.' else ' (a reply like “fine, send it” works too).' end,$q$);
  src := replace(src, $q$elsif pr.reminded_at is not null and pr.escalated_at is null and pr.reminded_at < now() - interval '10 minutes'$q$,
    $q$elsif pr.kind not in ('batch','person','document') and pr.reminded_at is not null and pr.escalated_at is null and pr.reminded_at < now() - interval '10 minutes'$q$);
  if (length(src) - length(was)) < 200 then raise exception 'agent_follow_up changed upstream: update 1440'; end if;
  execute src;
end $$;

-- migrate:down
-- Forward-only.
