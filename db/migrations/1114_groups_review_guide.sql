-- migrate:up
-- GROUPS-2 (owner, 25 Oct 2026: "so much data to be imported, interpreted, analysed and all put in Pulse one by one").
-- Additive:
--  * The review lane's tasks and approvals come from WA-IMPORT's classifier (1016 wa_message_signal: each imported
--    message's intent, read locally) instead of the hub's word scan, wherever a group's history was classified:
--    requests and change requests become tasks to review, a client's approval an approval (with the classifier's
--    confidence). Groups without it (older text imports) keep the word scan.
--  * A guided review for admins and leadership walks the imported groups in order of value (active clients first) one
--    by one: link, say who the senders are, turn the history into tasks, then "Done, next". Each group keeps when and
--    by whom it was reviewed (or put off until tomorrow), so the whole history gets in over days, with progress.

alter table pulse.chat_group_info add column reviewed_at timestamptz, add column reviewed_by uuid references pulse.person(id), add column review_later_at timestamptz;

-- Requests, change requests and a client's approvals in a group's imported history, as the classifier read them,
-- newest first (members and admins, as for the history itself).
create function pulse.chat_group_history_asks(p_channel uuid, p_limit int, p_min real) returns table (
  id uuid, author text, body text, at text, side text, intent text, confidence real, sent_at timestamptz)
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select x.* from (
    select m.id, coalesce(p.display_name, pa.label), m.body, to_char(m.sent_at at time zone org_time_zone(), 'YYYY-MM-DD'),
           coalesce(p.side, case pa.kind when 'colleague' then 'staff' else 'client' end) side, s.intent, s.intent_p, m.sent_at
      from pulse_priv.wa_message_signal s
      join pulse_priv.wa_message m on m.org_id = s.org_id and m.id = s.message_id
      join pulse_priv.wa_chat c on c.org_id = m.org_id and c.id = m.chat_id
      join pulse_priv.wa_import_batch b on b.org_id = m.org_id and b.id = m.batch_id and b.withdrawn_at is null
      left join pulse_priv.wa_participant pa on pa.org_id = m.org_id and pa.id = m.participant_id
      left join person p on p.id = pa.person_id
     where s.org_id = current_org() and c.channel_id = p_channel and wa_reader(c.id)
       and m.kind = 'text' and length(btrim(m.body)) between 12 and 600
       and s.intent in ('request', 'change', 'approval') and coalesce(s.intent_p, 1) >= p_min) x
   where x.intent <> 'approval' or x.side <> 'staff'
   order by x.sent_at desc limit least(greatest(p_limit, 1), 200)
$$;

-- How many of this group's imported messages the classifier read (then the review lane uses it, else the word scan).
create function pulse.chat_group_classified(p_channel uuid) returns int
  language sql stable security definer set search_path = pulse, pg_temp as $$
  select count(*)::int from pulse_priv.wa_message_signal s join pulse_priv.wa_chat c on c.org_id = s.org_id and c.id = s.chat_id
   where s.org_id = current_org() and c.channel_id = p_channel and wa_reader(c.id)
$$;

-- Mark a group reviewed ("Done, next"), put it off until tomorrow ("Later"), or open it again. Admins, leadership and
-- the group's own admins.
create function pulse.chat_group_review_mark(p_channel uuid, p_state text) returns void
  language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if not chat_group_manages(p_channel) then raise exception 'Only someone who manages this group reviews it' using errcode = '42501'; end if;
  if p_state not in ('reviewed', 'later', 'open') then raise exception 'Reviewed, later or open' using errcode = '22023'; end if;
  insert into chat_group_info (org_id, channel_id) values (current_org(), p_channel) on conflict (channel_id) do nothing;
  update chat_group_info set
    reviewed_at = case p_state when 'reviewed' then now() when 'open' then null else reviewed_at end,
    reviewed_by = case p_state when 'reviewed' then current_viewer() when 'open' then null else reviewed_by end,
    review_later_at = case p_state when 'later' then now() else null end,
    updated_by = current_viewer(), updated_at = now()
   where channel_id = p_channel and org_id = current_org();
  perform audit_write('update', 'chat_group_info', p_channel::text, array['reviewed_at']);
end $$;

revoke all on function pulse.chat_group_history_asks(uuid, int, real), pulse.chat_group_classified(uuid), pulse.chat_group_review_mark(uuid, text) from public;
grant execute on function pulse.chat_group_history_asks(uuid, int, real), pulse.chat_group_classified(uuid), pulse.chat_group_review_mark(uuid, text) to pulse_api;

-- migrate:down
-- Forward-only.
