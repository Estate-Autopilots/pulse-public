-- migrate:up
-- AI-EMPLOYEES v2 (polish): the AI's direct message to its approver reads as two clean lines: what was said, where,
-- and that it has not answered; the proposal itself is on the message's card.
create or replace function pulse.agent_propose(p_run uuid, p_body text, p_why text, p_client uuid) returns jsonb language plpgsql security definer set search_path=pulse,pg_temp as $$
declare me uuid := agent_session(); r agent_run; e agent_event; msg chat_message; m agent_member; ap uuid; dm uuid; k text; mid uuid; pid uuid;
  b text := btrim(coalesce(p_body, '')); w text := left(nullif(btrim(coalesce(p_why, '')), ''), 1000); ch chat_channel; who text;
begin
  if me is null then raise exception 'An AI co-worker key is required' using errcode='42501'; end if;
  if length(b) not between 1 and 4000 then raise exception 'Write the proposal in up to 4,000 characters' using errcode='22023'; end if;
  select * into r from agent_run where id = p_run and org_id = current_org() and agent_id = me and state = 'dispatching' and deadline > now();
  if not found then raise exception 'Propose inside the run' using errcode='42501'; end if;
  select id into pid from agent_proposal where run_id = r.id;
  if found then return (select jsonb_build_object('id', x.id, 'messageId', x.dm_message_id, 'chatId', x.dm_channel_id) from agent_proposal x where x.id = pid); end if;
  select * into e from agent_event where id = r.event_id;
  if e.subject_type <> 'message' then raise exception 'That run is not about a message' using errcode='22023'; end if;
  select * into msg from chat_message where id = e.subject_id;
  select * into ch from chat_channel where id = msg.channel_id;
  select * into m from agent_member where person_id = me;
  ap := coalesce(m.approver_person_id, m.owner_person_id);
  if ap is null then raise exception 'It has nobody to ask' using errcode='22023'; end if;
  k := 'dm:' || least(me::text, ap::text) || ':' || greatest(me::text, ap::text);
  insert into chat_channel(org_id, key, name, kind, description) values (current_org(), k, 'Direct message', 'direct', 'A private conversation')
  on conflict (org_id, key) do update set key = excluded.key returning id into dm;
  insert into chat_member(org_id, channel_id, person_id) values (current_org(), dm, me), (current_org(), dm, ap) on conflict do nothing;
  insert into agent_proposal(org_id, agent_id, run_id, channel_id, source_message_id, approver_id, dm_channel_id, kind, body, why)
  values (current_org(), me, r.id, msg.channel_id, msg.id, ap, dm, 'reply', b, w) returning id into pid;
  select display_name into who from person where id = msg.author_id;
  mid := chat_send(dm, who || ' wrote in ' || case when ch.kind = 'direct' then 'a direct message' else '“' || ch.name || '”' end || ':' || chr(10) || '“'
      || left(regexp_replace(msg.body, '\s+', ' ', 'g'), 280) || case when length(msg.body) > 280 then '…' else '' end
      || '”' || chr(10) || 'I have not answered there. This is what I would post: Send it, Edit, or Don''t (a reply like “fine, send it” works too).', null, '[]'::jsonb, p_client, null);
  update agent_proposal set dm_message_id = mid where id = pid;
  insert into agent_output(org_id, run_id, subject_type, subject_id) values (current_org(), r.id, 'message', mid) on conflict do nothing;
  return jsonb_build_object('id', pid, 'messageId', mid, 'chatId', dm);
end $$;

-- migrate:down
-- Forward-only.
