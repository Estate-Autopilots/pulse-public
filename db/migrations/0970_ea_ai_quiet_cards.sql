-- migrate:up
-- EA-AI: a message with no words (a task's card, a file on its own) does not start an AI employee's run. Found on dev:
-- the card of a task created from the Operations Chief's proposal, posted in its direct message, made it answer
-- "noted" to an empty message. 0952's agent_event_from_chat, with that one condition added.
create or replace function pulse.agent_event_from_chat() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a record; leader boolean;
begin
  if new.kind <> 'text' or new.removed_at is not null or new.author_id is distinct from current_viewer() then return null; end if;
  if btrim(coalesce(new.body, '')) = '' then return null; end if;
  if exists(select 1 from person where id = new.author_id and side = 'agent') then return null; end if;
  if agent_proposal_from_reply(new.id) then return null; end if;
  leader := agent_leader(new.author_id);
  for a in
    select m.person_id agent, x.kind
      from agent_member m join person p on p.id = m.person_id
      join chat_channel ch on ch.id = new.channel_id
      join chat_member cm on cm.channel_id = new.channel_id and cm.person_id = m.person_id
      cross join lateral (select case when ch.kind = 'direct' then 'chat.message' when m.person_id = any(new.mentions) then 'chat.mention'
          when exists(select 1 from chat_message pm where pm.id = coalesce(new.parent_id, new.quote_id) and pm.author_id = m.person_id) then 'chat.reply'
          else 'chat.group' end kind) x
     where m.org_id = new.org_id and not m.post_only and m.disabled_at is null and p.status = 'active'
       and (ch.kind = 'direct' or m.speak_scope = 'its_groups' or (m.speak_scope = 'listed' and ch.id = any(m.speak_channels)))
       and agent_mode_for(m, x.kind) <> 'off'
       and (leader or m.listens_to = 'everyone')
       and not (x.kind = 'chat.group' and new.author_id = coalesce(m.approver_person_id, m.owner_person_id))
  loop
    insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
    values (new.org_id, a.agent, a.kind, 'message', new.id, 'message:' || new.id, new.author_id) on conflict do nothing;
  end loop;
  return null;
end $$;

-- migrate:down
-- Forward-only.
