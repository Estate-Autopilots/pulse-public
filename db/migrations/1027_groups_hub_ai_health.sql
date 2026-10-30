-- migrate:up
-- GROUPS-HUB: an AI employee's group summary carries its read of the group's health (good, watch, at risk); the hub
-- keeps it on the group (chat_group_info, 1018) unless a person set the health. Done inside the security-definer finish
-- (the API's own role only reads chat_group_info), so a summary and its health land together or not at all.
create or replace function pulse.chat_group_ai_finish(p_id uuid, p_status text, p_result jsonb, p_error text, p_engine text, p_in int, p_out int) returns uuid
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := agent_session(); ch uuid; k text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode = '42501'; end if;
  if p_status not in ('done', 'failed') then raise exception 'Done or failed' using errcode = '22023'; end if;
  update chat_group_ai_job set status = p_status, result = p_result, error = left(p_error, 400), engine = left(p_engine, 80),
    tokens_in = p_in, tokens_out = p_out, finished_at = now(), lease_until = null
   where id = p_id and org_id = current_org() and agent_id = me and status = 'running' returning channel_id, kind into ch, k;
  if ch is null then raise exception 'This job is not yours to finish' using errcode = '22023'; end if;
  if p_status = 'done' and k = 'summary' and p_result->>'health' in ('good', 'watch', 'at_risk') then
    insert into chat_group_info (org_id, channel_id) values (current_org(), ch) on conflict (channel_id) do nothing;
    update chat_group_info set health = p_result->>'health', health_note = left(coalesce(p_result->>'happening', ''), 400), health_at = now()
     where channel_id = ch and not ('health' = any(manual));
  end if;
  return ch;
end $$;
