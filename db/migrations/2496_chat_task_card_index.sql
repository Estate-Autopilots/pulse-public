-- migrate:up
-- TEAM-TELEMETRY (21 Nov 2026): a project's plan (GET /api/v0/projects/:id/plan) says which chat each task was sent in.
-- It found that by unpacking the attachments of every message of the company under the row policies: 19-23 s on EA's
-- production (136,923 messages, 18,752 with attachments); Kazuk's plan took 23-32 s five times on 19 Nov.
-- 1. An index of only the messages that carry a task card ({"task": "<id>", ...} in attachments).
-- 2. chat_task_card_first(tasks): each task's earliest card, found through that index, with chat_message's own row
--    rules applied once per conversation (as chat_message_find, 2381): this company, imported history only for whom
--    chat_import_reads() allows, and a conversation the viewer may read (chat_has or chat_browsing, the rule
--    chat_channel's row policy uses too). The row policies themselves cannot use the index: jsonb's @> and @? are not
--    leakproof, so Postgres checks every message's policy before comparing.
create index if not exists chat_message_task_card on pulse.chat_message using gin (attachments jsonb_path_ops)
  where attachments @? '$[*].task';

create or replace function pulse.chat_task_card_first(p_tasks text[])
returns table (task text, channel_id uuid, author_id uuid, created_at timestamptz)
language sql stable security definer set search_path = pulse, pg_temp as $fn$
  with reads as materialized (select chat_import_reads() ok),
  hits as materialized (
    select x.task, m.channel_id, m.author_id, m.created_at
    from unnest(coalesce(p_tasks, '{}'::text[])) x(task)
    join chat_message m on m.org_id = current_org()
      and m.attachments @? '$[*].task' and m.attachments @> jsonb_build_array(jsonb_build_object('task', x.task))
    where m.removed_at is null and (m.import_ref is null or (select ok from reads))
  ),
  readable as materialized (
    select c.id from (select distinct channel_id id from hits) c
    join chat_channel ch on ch.org_id = current_org() and ch.id = c.id
    where chat_has(c.id) or chat_browsing(c.id)
  )
  select distinct on (h.task) h.task, h.channel_id, h.author_id, h.created_at
  from hits h join readable r on r.id = h.channel_id
  order by h.task, h.created_at
$fn$;
revoke all on function pulse.chat_task_card_first(text[]) from public;
grant execute on function pulse.chat_task_card_first(text[]) to pulse_api;

-- migrate:down
drop function if exists pulse.chat_task_card_first(text[]);
drop index if exists pulse.chat_message_task_card;
