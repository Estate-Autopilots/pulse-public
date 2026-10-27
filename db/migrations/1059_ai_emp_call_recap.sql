-- migrate:up
-- AI-EMP-2 (owner, 25 Oct 2026: "AI on calls, first step"): after a recorded call in a conversation with a client, once
-- its transcript is made (CALLS-V2 1033: chat_call_recording, transcript_state 'done', on this server), the AI employee
-- working in that group writes the recap for the client and the next steps as a card for its approver (Send it / Edit /
-- Don't) and proposes the tasks our side agreed to (Create it / Edit / Don't). Nothing reaches the client before a person
-- sends it. Only where the company's call policy keeps AI on (ai_summary not 'off') and transcripts on (decision
-- ai-emp2-client-call-recap). Team calls keep CALLS-V2's own notes. Additive: two functions and one trigger.

/** The recorded call a run is about (its line in the conversation): when, how long, who was in it, the transcript
 *  (phone numbers masked), its language. For agent_own_context (1056). */
create or replace function pulse.agent_recorded_context(p_msg uuid) returns jsonb language sql stable security definer set search_path=pulse,pg_temp as $$
  select jsonb_build_object('when', to_char(r.started_at at time zone org_time_zone(), 'FMDay DD Mon, HH24:MI'), 'minutes', round(coalesce(r.seconds, 0) / 60.0, 1),
      'language', r.language, 'recordedBy', (select display_name from person where id = r.started_by),
      'people', (select coalesce(jsonb_agg(jsonb_build_object('name', pe.display_name, 'side', pe.side) order by pa.joined_at), '[]'::jsonb)
                   from chat_call_party pa join person pe on pe.id = pa.person_id where pa.call_id = r.call_id and pa.joined_at is not null),
      'transcript', regexp_replace(left(r.transcript, 24000), '\+?\d[\d \-]{8,}\d', '[number]', 'g'))
    from chat_call_recording r where r.message_id = p_msg and r.state = 'saved' and r.transcript_state = 'done' order by r.started_at desc limit 1
$$;

/** A recorded call in a conversation with a client has its transcript: the AI employees working there are asked for a
 *  recap card (call.recorded). A recording is never refused because of this. */
create or replace function pulse.agent_call_recorded() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare a uuid; pol chat_call_policy;
begin
  if new.transcript_state <> 'done' or old.transcript_state = 'done' or new.state <> 'saved' or new.message_id is null then return null; end if;
  if not chat_client_facing(new.channel_id) or btrim(coalesce(new.transcript, '')) = '' then return null; end if;
  select * into pol from chat_call_policy where org_id = new.org_id;
  if coalesce(pol.ai_summary, 'staff') = 'off' or not coalesce(pol.transcripts, true) then return null; end if;
  for a in select cm.person_id from chat_member cm join agent_member m on m.person_id = cm.person_id
            where cm.channel_id = new.channel_id and agent_works_in(cm.person_id, new.channel_id) loop
    insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
    values (new.org_id, a, 'call.recorded', 'message', new.message_id, 'call-recorded:' || new.id, new.started_by) on conflict do nothing;
  end loop;
  return null;
exception when others then
  raise warning 'agent_call_recorded: %', sqlerrm;
  return null;
end $$;
create trigger agent_call_recorded after update of transcript_state on pulse.chat_call_recording for each row execute function pulse.agent_call_recorded();

revoke all on function pulse.agent_recorded_context(uuid), pulse.agent_call_recorded() from public;

-- migrate:down
-- Forward-only.
