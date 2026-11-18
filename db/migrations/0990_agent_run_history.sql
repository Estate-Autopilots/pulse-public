-- migrate:up
-- UI-UPGRADE (owner, 24 Oct 2026: an AI employee's History said "A question in Chats" on every row, gave no reason for
-- a failure and no way to try again, and stopped at 25 runs). Two additive functions, both on this repository's tables
-- (agent_run and agent_event 0510, agent_member, chat_message and chat_channel 0022, chat_member, task):
--   agent_runs_page(agent, before, limit)  its runs, newest first, a page at a time, to whoever may see its profile
--     (agent_profile's rule, as agent_detail): what was asked (the first 160 characters of the message, only when the
--     viewer is in that conversation), where, the task, why a run stopped (the run's error code, else the event's fixed
--     reason code), and which engine ran and what it fell back from (read from the run row as JSON, so columns a later
--     migration adds show up without this function changing; null until then).
--   agent_run_retry(agent, run)  whoever may change the AI employee (agent_manage_ok, 0952) asks a failed run again: a
--     new event for the same message or task, queued now, as asked by the same person; the failed run stays as it was.

create function pulse.agent_runs_page(p_agent uuid, p_before timestamptz default null, p_limit int default 20) returns jsonb
  language plpgsql stable security definer set search_path=pulse,pg_temp as $$
declare me uuid := current_viewer(); manage boolean;
begin
  if pulse.agent_profile(p_agent) is null then return null; end if;
  manage := agent_manage_ok(p_agent);
  return (select coalesce(jsonb_agg(x.j order by x.at desc), '[]'::jsonb) from (
    select r.started_at at, jsonb_build_object('id', r.id, 'at', r.started_at, 'state', r.state, 'lane', r.lane, 'model', r.model, 'tokens', r.tokens, 'seconds', r.seconds,
      'errorCode', coalesce(r.error_code, case when r.state = 'error' then e.reason end), 'kind', e.event_type,
      'taskId', case when e.subject_type = 'task' then e.subject_id end,
      'taskTitle', (select tt.title from task tt where e.subject_type = 'task' and tt.id = e.subject_id and tt.id in (select task_visible_ids())),
      'ask', q.ask, 'channelId', q.channel_id, 'channelName', q.channel_name,
      'engine', to_jsonb(r) ->> 'engine', 'fallbackFrom', to_jsonb(r) ->> 'fallback_from',
      'retry', manage and r.state = 'error' and e.subject_type in ('message', 'task')) j
    from agent_run r join agent_event e on e.id = r.event_id
    left join lateral (
      select left(regexp_replace(cm.body, '\s+', ' ', 'g'), 160) ask, ch.id channel_id, case when ch.kind = 'direct' then 'a direct message' else ch.name end channel_name
        from chat_message cm join chat_channel ch on ch.id = cm.channel_id
       where e.subject_type = 'message' and cm.id = e.subject_id and cm.org_id = r.org_id and cm.removed_at is null
         and exists (select 1 from chat_member mm where mm.channel_id = cm.channel_id and mm.person_id = me)) q on true
    where r.agent_id = p_agent and r.org_id = current_org() and (p_before is null or r.started_at < p_before)
    order by r.started_at desc limit greatest(1, least(coalesce(p_limit, 20), 50))) x);
end $$;

-- 'queued' (asked again), 'not_failed' (only a failed run is tried again) or 'pending' (it is already waiting to run).
create function pulse.agent_run_retry(p_agent uuid, p_run uuid) returns text
  language plpgsql security definer set search_path=pulse,pg_temp as $$
declare e agent_event;
begin
  if not agent_manage_ok(p_agent) then raise exception 'Not found' using errcode = 'P0002'; end if;
  select ev.* into e from agent_run r join agent_event ev on ev.id = r.event_id
   where r.id = p_run and r.agent_id = p_agent and r.org_id = current_org() and r.state = 'error' and ev.subject_type in ('message', 'task');
  if not found then return 'not_failed'; end if;
  if exists (select 1 from agent_event o where o.org_id = e.org_id and o.agent_id = e.agent_id and o.subject_id = e.subject_id and o.state in ('queued', 'leased', 'dispatching')) then
    return 'pending';
  end if;
  insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
  values (e.org_id, e.agent_id, e.event_type, e.subject_type, e.subject_id, left(e.event_key, 150) || ':retry:' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSUS'), e.invoked_by);
  return 'queued';
end $$;

revoke all on function pulse.agent_runs_page(uuid, timestamptz, int), pulse.agent_run_retry(uuid, uuid) from public;
grant execute on function pulse.agent_runs_page(uuid, timestamptz, int), pulse.agent_run_retry(uuid, uuid) to pulse_api;

-- migrate:down
-- Forward-only.
