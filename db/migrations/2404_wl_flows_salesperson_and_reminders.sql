-- migrate:up
-- WL-FLOWS (owner order, 19 Nov 2026: "make Willow Lane automated and workflows tested"). Two gaps that Willow Lane's
-- journeys (tools/qa/vitals/wl-flows.mjs, nightly on dev in the QA company) found:
--
--   1. A quotation an AI employee drafts for a seller's own customer had no salesperson unless that seller asked in the
--      run itself (2393). bhrātā adds a customer for a seller with create_quote_lead, which makes the seller the
--      customer's relationship owner. When the quotation for that customer was drafted because someone else asked
--      (Sakobe for Adunor), from a task, or outside a chat run, the seller could not mark it sent, revise it or record its
--      payment ("This deal is another salesperson's", erp_own_guard), and its follow-up went to nobody
--      (erp_followup_person never picks an AI employee). Now such a quotation is the customer's relationship owner's, when
--      that person is active staff with the sales seat. A seller who asked in the run still comes first (2393).
--
--   2. "Remind me about this message" never reached the bell or the phone unless the message mentioned the person.
--      chat_due (1005) tells them with a chat.mention notice, and notification_recipient_allowed lets a chat.mention
--      through only for a person the message mentions, and never on one's own message, so notification_authorized said no
--      and the bell hid it (the chat list's reminder chip was all that showed). Now a person's own fired reminder for that
--      message is allowed, on any message in a chat they are still in. Every other chat rule is unchanged, word for word.

-- ------------------------------------------------------------------------------------------------ 1. the salesperson
create or replace function pulse.erp_sales_seat_insert() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare b jsonb;
begin
 if new.source_id is not null and new.salesperson_id is null then
  new.salesperson_id := (select d.salesperson_id from erp_document d where d.id = new.source_id);
 end if;
 if new.salesperson_id is null and new.service_key_id is null and pulse.current_viewer() is not null and pulse.viewer_is('sales','sales_head')
    and new.created_by is not distinct from pulse.current_viewer() then
  new.salesperson_id := pulse.current_viewer();
 end if;
 -- WL-RESCUE-2: a quotation an AI employee drafts because a seller asked is that seller's.
 if new.salesperson_id is null and new.service_key_id is null and new.doc_type = 'quotation' and pulse.agent_session() is not null then
  new.salesperson_id := (select ra.person_id from role_assignment ra
    where ra.person_id = pulse.agent_run_asker() and ra.org_id = pulse.current_org() and ra.role_key in ('sales', 'sales_head')
      and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity') limit 1);
 end if;
 -- WL-FLOWS (2404): otherwise an AI employee's quotation for a seller's own customer (its relationship owner, as
 -- create_quote_lead sets it) is that seller's.
 if new.salesperson_id is null and new.service_key_id is null and new.doc_type = 'quotation' and new.client_id is not null
    and pulse.agent_session() is not null then
  new.salesperson_id := (select p.id from client c join person p on p.id = c.relationship_owner_id and p.org_id = c.org_id
    where c.id = new.client_id and c.org_id = pulse.current_org() and p.side = 'staff' and p.status = 'active'
      and exists(select 1 from role_assignment ra where ra.person_id = p.id and ra.org_id = c.org_id and ra.role_key in ('sales', 'sales_head')
        and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')));
 end if;
 if new.doc_type <> 'quotation' and new.source_id is null and pulse.current_viewer() is not null then
  b := pulse.erp_flow_block('invoice');
  if b is not null then raise exception '%: open the quotation and choose Create invoice', b->>'why' using errcode = '42501'; end if;
 end if;
 return new;
end $$;

-- ------------------------------------------------------------------------------------------------ 2. reminders ring
-- The function as it stands (1066 and later), with only its chat rule widened; refuses to run if that rule was changed
-- since, so nothing is overwritten unseen.
do $do$
declare
  definition text := pg_get_functiondef('pulse.notification_recipient_allowed(uuid,text,text,uuid)'::regprocedure);
  was text := $o$   where m.org_id=current_org() and m.id=p_id and m.removed_at is null and cm.person_id=p_person and m.author_id<>p_person
   and (p_type<>'chat.mention' or p_person=any(m.mentions)) and notification_chat_member_current(m.channel_id,p_person));$o$;
  now_ text := $n$   where m.org_id=current_org() and m.id=p_id and m.removed_at is null and cm.person_id=p_person
   and ((m.author_id<>p_person and (p_type<>'chat.mention' or p_person=any(m.mentions)))
    -- WL-FLOWS (2404): "remind me about this message" rings for the person who asked for it (chat_due tells them with a
    -- chat.mention), on any message in a chat they are in, their own messages too.
    or (p_type='chat.mention' and exists(select 1 from chat_reminder r where r.org_id=m.org_id and r.message_id=m.id
      and r.person_id=p_person and r.fired_at is not null and r.cancelled_at is null)))
   and notification_chat_member_current(m.channel_id,p_person));$n$;
begin
  if position(was in definition) = 0 then
    raise exception 'notification_recipient_allowed: its chat rule is not the one 2404 widens; review it by hand';
  end if;
  execute replace(definition, was, now_);
end $do$;

-- migrate:down
-- Forward-only: restore 2393's erp_sales_seat_insert and the chat rule above by hand.
