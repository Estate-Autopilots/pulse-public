-- migrate:up
-- WL-DAY (22 Nov 2026, the 3rd day: Adunor tapped a quotation in Chats and got "not found" (404), then "not allowed"
-- (403)). REPLAY-FIXES #4's "where does this link lead now" (GET /api/v0/erp/documents/:id/latest?chat=…) reads the
-- chat's newest quotation from erp_quote_chat when the linked one is gone or not theirs, but the API role was never
-- granted that table (2380 kept it to definer functions), so every such lookup failed with "permission denied" and the
-- fix never reached anyone. pulse.erp_quote_chat_latest(chat): the newest quotation (not cancelled) kept for a chat the
-- person is in; the API then reads it under the person's own row rules, so it never names one they may not open.
create function pulse.erp_quote_chat_latest(p_channel uuid) returns uuid language sql stable security definer set search_path = pulse, pg_temp as $$
 select q.document_id from erp_quote_chat q join erp_document d on d.id = q.document_id
 where q.org_id = current_org() and q.channel_id = p_channel and d.status <> 'cancelled'
   and exists (select 1 from chat_member m where m.org_id = current_org() and m.channel_id = p_channel and m.person_id = current_viewer())
 order by q.created_at desc limit 1
$$;
comment on function pulse.erp_quote_chat_latest(uuid) is 'WL-DAY (2526): the newest quotation kept for a chat the viewer is in (its id only; reading it stays under row security)';
revoke all on function pulse.erp_quote_chat_latest(uuid) from public;
grant execute on function pulse.erp_quote_chat_latest(uuid) to pulse_api;

-- migrate:down
drop function pulse.erp_quote_chat_latest(uuid);
