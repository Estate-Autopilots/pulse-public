-- migrate:up
-- AI-EMP-2: a colleague who writes again in the direct message an AI employee asked them in (a correction, a later
-- answer) is the answer it acts on: its relay card says "Checked with X first: <that message>", not their first reply
-- (seen on dev: a card quoted a colleague's earlier answer about a 3D animation while relaying their brochure answer).
-- agent_consult_answer is 1035's with one line changed (answer_message_id is the latest answer; answered_at stays the first).
create or replace function pulse.agent_consult_answer() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare c agent_consult;
begin
  if new.kind <> 'text' or new.removed_at is not null or btrim(coalesce(new.body, '')) = '' then return null; end if;
  if exists(select 1 from person where id = new.author_id and side <> 'staff') then return null; end if;
  if exists(select 1 from agent_proposal where decision_message_id = new.id) then return null; end if;
  for c in select distinct on (agent_id) * from agent_consult
            where org_id = new.org_id and dm_channel_id = new.channel_id and colleague_id = new.author_id and state in ('open','answered','relayed')
              and created_at > now() - interval '3 days' order by agent_id, created_at desc loop
    if not exists(select 1 from agent_member m join person p on p.id = m.person_id where m.person_id = c.agent_id and m.disabled_at is null and p.status = 'active') then continue; end if;
    update agent_consult set state = case when state = 'open' then 'answered' else state end, answer_message_id = new.id, answered_at = coalesce(answered_at, now()) where id = c.id;
    update agent_event set event_type = 'consult.answer' where org_id = new.org_id and agent_id = c.agent_id and event_key = 'message:' || new.id and state = 'queued';
    if not found then
      insert into agent_event(org_id, agent_id, event_type, subject_type, subject_id, event_key, invoked_by)
      values (new.org_id, c.agent_id, 'consult.answer', 'message', new.id, 'message:' || new.id, new.author_id) on conflict do nothing;
    end if;
  end loop;
  return null;
-- A person's message is never refused because of this.
exception when others then
  raise warning 'agent_consult_answer: %', sqlerrm;
  return null;
end $$;
revoke all on function pulse.agent_consult_answer() from public;

-- migrate:down
-- Forward-only.
