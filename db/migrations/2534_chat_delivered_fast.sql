-- migrate:up
-- VITALS-SWEEP (23 Nov 2026): EA's chat list took 7-31 s for staff (Posip: 207 of 789 loads since 22 Nov over 3 s, p90
-- 14 s; Kazuk 75 of 177). Every list load runs chat_delivered() first. Its "is there a message from someone else newer
-- than what was delivered?" was an EXISTS whose date bound came from the joined receipt row, so Postgres could not use
-- chat_message_channel's created_at: it read every message of every chat the person is in, each through the chat row
-- policy (forced), to learn that nothing was new. Production, read-only: 16.4 s for a member of 358 chats (112,414
-- messages), 8.0 s for one of 213, 0.01 s for one of 23. Now each chat is asked for its newest message from someone else
-- (newest first on the same index, stop at the first) and that time is compared with the receipt: 0.44 s and 0.32 s,
-- the same chats marked (checked for three people on production, read-only). Nothing else changes: same receipts, same
-- live events (0340's chat_receipt_live rule).
create or replace function pulse.chat_delivered() returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if not chat_active() then return; end if;
 with fresh as (
  insert into chat_receipt(org_id,channel_id,person_id,delivered_through)
  select cm.org_id,cm.channel_id,cm.person_id,clock_timestamp() from chat_member cm
  left join chat_receipt r on r.channel_id=cm.channel_id and r.person_id=cm.person_id
  where cm.org_id=current_org() and cm.person_id=current_viewer()
  and (select m.created_at from chat_message m where m.org_id=cm.org_id and m.channel_id=cm.channel_id and m.author_id<>cm.person_id
       order by m.created_at desc limit 1) > coalesce(r.delivered_through,'-infinity')
  on conflict(channel_id,person_id) do update set delivered_through=excluded.delivered_through
  returning channel_id)
 insert into chat_event(org_id,channel_id) select current_org(),f.channel_id from fresh f where chat_receipt_live(f.channel_id);
end $$;

-- migrate:down
-- Forward-only (0340's definition can be restored by re-running it).
