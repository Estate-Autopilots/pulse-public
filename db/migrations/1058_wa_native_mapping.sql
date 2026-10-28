-- migrate:up
-- WA-NATIVE: mapping a WhatsApp sender to a person (the groups hub's "Who is this?", which sets wa_participant.person_id)
-- shows in the chat at once: their moved messages leave the guest and become that person's; un-mapping turns them back
-- into the guest's. Before, this waited for the next sync. Never fails the mapping (a failure is a warning and the next
-- sync catches up). Additive: one function and one trigger.

create function pulse.wa_native_on_mapping() returns trigger
language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ch uuid; g uuid; n int := 0;
begin
 select w.channel_id into ch from pulse_priv.wa_chat w where w.org_id = new.org_id and w.id = new.chat_id;
 if ch is null or not exists (select 1 from pulse_priv.wa_native n where n.org_id = new.org_id and n.chat_id = new.chat_id) then return null; end if;
 begin
  if new.person_id is not null then
   update chat_message m set author_id = new.person_id, guest_id = null
     from chat_guest cg where cg.org_id = new.org_id and cg.source_ref = new.id and m.org_id = cg.org_id and m.guest_id = cg.id;
   get diagnostics n = row_count;
  else
   insert into chat_guest (org_id, channel_id, label, source_ref) values (new.org_id, ch, left(new.label, 120), new.id)
   on conflict (org_id, source_ref) do update set label = excluded.label returning id into g;
   update chat_message m set author_id = wa_native_author(), guest_id = g
     from pulse_priv.wa_message w where w.org_id = new.org_id and w.participant_id = new.id and m.org_id = w.org_id and m.import_ref = w.id;
   get diagnostics n = row_count;
  end if;
  if n > 0 then insert into chat_event (org_id, channel_id) values (new.org_id, ch); end if;
 exception when others then
  raise warning 'wa_native_on_mapping: %', sqlerrm;
 end;
 return null;
end $$;
create trigger wa_native_on_mapping after update of person_id on pulse_priv.wa_participant
 for each row when (new.person_id is distinct from old.person_id) execute function pulse.wa_native_on_mapping();
revoke all on function pulse.wa_native_on_mapping() from public;

-- migrate:down
-- Forward-only.
