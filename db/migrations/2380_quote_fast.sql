-- migrate:up
-- QUOTE-FAST (owner, 18 Nov 2026): a seller who asks the AI employee for a quotation has the PDF in the same chat in about
-- a minute. On 18 Nov at Willow Lane it took 24 minutes: the approver's notice was "for your information" (quiet: no push,
-- no Approve button), nobody told the seller when it was approved, and the seller had to ask again and got a link. Here:
--   1. pulse.erp_quote_chat: the chat an AI employee drafted (or submitted) a quotation in, and who asked. When that
--      quotation is approved, however it is approved (the document's page, the bell's Approve, API v1), the AI employee
--      posts the filed PDF there as a file, with one line (erp_quote_chat_deliver, called by issueDocument). Asked for an
--      approved quotation later, it posts the same PDF (once per revision and chat). Never into a chat with a client in it.
--   2. "Approve the quotation for …" (billing.approval) needs the approver now: it pings (push) instead of waiting
--      quietly in the bell, and the bell's card carries Approve (notices.ts). "Approved: …" (billing.approved) pings the
--      person who asked for it.
--   3. erp_settings.quote_auto_approve / quote_auto_limit (default off): leadership or an admin may let an AI employee's
--      quotation be approved by that rule at once when every line is a catalogue item at its catalogue price with no
--      discount and the total is within the limit (paise, incl. GST). The quotation is numbered and filed as any other
--      (erp_document_issue), its trail says which rule approved it (erp_event 'approved_by_rule'), and who switched the
--      rule on or off and to what limit is in the settings' own trail (erp_event 'quote_auto_approve').

-- ------------------------------------------------------------------------------------------------ 1. the asker's chat
create table pulse.erp_quote_chat (
  org_id uuid not null references pulse.org(id),
  document_id uuid not null references pulse.erp_document(id) on delete cascade,
  channel_id uuid not null,
  agent_id uuid not null references pulse.person(id),
  asked_by uuid references pulse.person(id),
  lang text not null default 'en' check (lang in ('en', 'hi', 'mr')),
  created_at timestamptz not null default now(),
  delivered_revision int,
  delivered_at timestamptz,
  message_id uuid,
  primary key (document_id, channel_id),
  foreign key (org_id, channel_id) references pulse.chat_channel(org_id, id) on delete cascade
);
alter table pulse.erp_quote_chat enable row level security;
alter table pulse.erp_quote_chat force row level security;
create policy tenant_isolation on pulse.erp_quote_chat using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- Written and read only by the functions below (security definer): no grant to the API role.

-- Whether the viewer is an active AI employee of this company (its key or its session).
create function pulse.erp_viewer_is_ai() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists(select 1 from person p join agent_member m on m.person_id = p.id and m.org_id = p.org_id
    where p.org_id = current_org() and p.id = current_viewer() and p.side = 'agent' and p.status = 'active' and m.disabled_at is null)
$$;

-- The AI employee keeps the chat it is answering in for a quotation (the runtime names the chat, never the model).
create function pulse.erp_quote_chat_keep(p_doc uuid, p_channel uuid, p_asked_by uuid, p_lang text) returns boolean
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare me uuid := current_viewer(); asker uuid := p_asked_by;
begin
  if not erp_viewer_is_ai() then raise exception 'Only an AI employee names the chat a quotation was asked in' using errcode = '42501'; end if;
  if not exists(select 1 from erp_document d where d.org_id = current_org() and d.id = p_doc and d.doc_type = 'quotation') then
    raise exception 'Quotation not found' using errcode = 'P0002'; end if;
  if not exists(select 1 from chat_member where org_id = current_org() and channel_id = p_channel and person_id = me) then
    raise exception 'chatId must be a chat you are in' using errcode = '42501'; end if;
  -- A client in the chat: the PDF is never posted there by itself (a person sends quotations to clients).
  if chat_client_facing(p_channel) then return false; end if;
  if asker is not null and not exists(select 1 from chat_member cm join person p on p.id = cm.person_id
      where cm.org_id = current_org() and cm.channel_id = p_channel and cm.person_id = asker and p.side = 'staff') then asker := null; end if;
  insert into erp_quote_chat(org_id, document_id, channel_id, agent_id, asked_by, lang)
  values (current_org(), p_doc, p_channel, me, asker, case when p_lang in ('en', 'hi', 'mr') then p_lang else 'en' end)
  on conflict (document_id, channel_id) do update set asked_by = coalesce(excluded.asked_by, erp_quote_chat.asked_by), lang = excluded.lang, agent_id = excluded.agent_id;
  return true;
end $$;

-- The approved quotation's filed PDF, posted by the AI employee into each chat kept for it that has not had this revision
-- yet (or, with p_again, got it longer ago than that: "send me the quotation" asked again), with the line the caller wrote
-- for that chat's language ({"en": …, "hi": …, "mr": …}). Returns how many chats got it. Called by whoever approved it (in
-- the same transaction as the approval) or by the AI employee itself (API v1 postQuotationToChat).
create function pulse.erp_quote_chat_deliver(p_doc uuid, p_name text, p_bodies jsonb, p_again interval default null) returns int
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare d erp_document; f bytea; r record; fid uuid; mid uuid; n int := 0; body text; uname text; direct boolean;
begin
  if not erp_can(false) then raise exception 'Billing is for leadership, the Finance role and the Accountant' using errcode = '42501'; end if;
  if coalesce(p_name, '') !~ '^[A-Za-z0-9._-]{1,200}$' or jsonb_typeof(p_bodies) is distinct from 'object' then
    raise exception 'A file name and the message are needed' using errcode = '22023'; end if;
  select * into d from erp_document where org_id = current_org() and id = p_doc;
  if d.id is null or d.doc_type <> 'quotation' or d.status not in ('issued', 'sent', 'accepted') then return 0; end if;
  select x.bytes into f from erp_document_file x where x.document_id = p_doc and x.kind = 'pdf';
  if f is null or octet_length(f) not between 1 and 5242880 then return 0; end if;
  for r in select q.* from erp_quote_chat q where q.org_id = current_org() and q.document_id = p_doc
      and (q.delivered_revision is distinct from d.revision or (p_again is not null and q.delivered_at < now() - p_again))
      order by q.created_at for update loop
    if not exists(select 1 from agent_member m join person p on p.id = m.person_id where m.org_id = current_org() and m.person_id = r.agent_id and m.disabled_at is null and p.status = 'active')
      or not exists(select 1 from chat_member where org_id = current_org() and channel_id = r.channel_id and person_id = r.agent_id)
      or chat_client_facing(r.channel_id) then continue; end if;
    body := btrim(coalesce(p_bodies ->> r.lang, p_bodies ->> 'en', ''));
    if body = '' then continue; end if;
    direct := (select c.kind = 'direct' from chat_channel c where c.id = r.channel_id);
    uname := case when not direct and r.asked_by is not null then (select pp.username from people_profile pp where pp.person_id = r.asked_by) end;
    if uname is not null then body := '@' || uname || ' ' || body; end if;
    insert into pulse_priv.chat_file(org_id, channel_id, person_id, name, mime, bytes) values (current_org(), r.channel_id, r.agent_id, p_name, 'application/pdf', f) returning id into fid;
    insert into chat_message(org_id, channel_id, author_id, body, attachments, mentions, client_id)
    values (current_org(), r.channel_id, r.agent_id, left(body, 4000), jsonb_build_array(jsonb_build_object('id', fid, 'name', p_name, 'mime', 'application/pdf')),
      case when uname is not null then array[r.asked_by] else '{}'::uuid[] end, gen_random_uuid())
    returning id into mid;
    update erp_quote_chat set delivered_revision = d.revision, delivered_at = now(), message_id = mid where document_id = r.document_id and channel_id = r.channel_id;
    perform erp_log('document', p_doc, 'pdf_to_chat', jsonb_build_object('channelId', r.channel_id, 'agentId', r.agent_id, 'revision', d.revision, 'messageId', mid));
    n := n + 1;
  end loop;
  return n;
end $$;
grant execute on function pulse.erp_viewer_is_ai() to pulse_api;
grant execute on function pulse.erp_quote_chat_keep(uuid, uuid, uuid, text) to pulse_api;
grant execute on function pulse.erp_quote_chat_deliver(uuid, text, jsonb, interval) to pulse_api;

-- ------------------------------------------------------------------------------------------------ 2. the approver is pinged
create or replace function pulse.notification_priority(p_type text) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select case
  -- CHAT-VOICE: someone is calling you.
  when p_type = 'chat.call' then 'urgent'
  when p_type in ('chat.missed_call','chat.voice') then 'needs_you'
  -- Pay and bank changes (a changed bank account is checked at once), and a test someone asked for.
  when p_type in ('comp.payroll','comp.waiting','people.bank','profile.bank','update.test') then 'urgent'
  -- The check-in reminder (once a day, paused when ignored) and the long-break nudge still ping: they ask for a tap.
  when p_type in ('approval.waiting','approval.digest','attendance.arrival','attendance.ask','attendance.digest','attendance.start','attendance.break',
   'chat.mention','chat.reply','chat.message','task.mention','project.mention','task.reply',
   'task.assigned','task.ask','task.help','project.ask','pool.match','task.blocked','task.waiting','task.due_soon','task.review_nudge',
   'domain.proposed','comp.offer','comp.claim','comp.letter','flow.wire','flow.alert','workflow.late',
   'leave.decision','request.decision',
   -- What changes someone's days or pay: a new holiday, a policy to read, the month's payroll done.
   'holiday.announced','policy.published','payroll.processed',
   -- QUOTE-FAST: a quotation waits for your approval (a seller and a client wait on it); yours was approved.
   'billing.approval','billing.approved') then 'needs_you'
  else 'fyi' end
$$;
create or replace function pulse.notification_family(p_type text) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select case
  -- CHAT-VOICE: calls ring and miss as one family; a voice message is a chat.
  when p_type in ('chat.call','chat.missed_call') then 'calls'
  when p_type = 'chat.voice' then 'chats'
  when p_type in ('attendance.start','attendance.end','attendance.done','attendance.break','attendance.departure','attendance.nudge') then 'attendance_reminders'
  when p_type in ('attendance.arrival','attendance.ask','attendance.checkout') then 'attendance_questions'
  when p_type in ('attendance.confirmed','attendance.auto') then 'attendance_confirmations'
  when p_type = 'attendance.digest' then 'attendance_digest'
  when p_type in ('approval.waiting','approval.reminder','approval.digest') then 'approvals'
  -- QUOTE-FAST: a quotation to approve is an approval; "approved" answers your own request.
  when p_type = 'billing.approval' then 'approvals'
  when p_type = 'billing.approved' then 'my_requests'
  when p_type in ('request.updated','request.decision','leave.decision') then 'my_requests'
  when p_type in ('chat.mention','chat.reply','task.mention','project.mention','task.reply') then 'mentions'
  when p_type = 'chat.message' then 'chats'
  when p_type in ('task.assigned','task.ask','task.help','project.ask','pool.match') then 'tasks_assigned'
  when p_type in ('task.blocked','task.waiting') then 'tasks_waiting'
  when p_type = 'task.due_soon' then 'tasks_due'
  when p_type = 'task.review_nudge' then 'reviews'
  when p_type like 'task.%' or p_type like 'project.%' or p_type like 'pool.%' or p_type = 'ask.answered' then 'task_updates'
  when p_type like 'domain.%' then 'domains'
  when p_type like 'flow.%' or p_type like 'workflow.%' then 'processes'
  when p_type like 'comp.%' or p_type in ('payroll.processed','people.bank','profile.bank') then 'pay'
  when p_type in ('profile.reminder','profile.changed','people.change') then 'profile'
  when p_type = 'update.test' then 'test'
  else 'company_updates' end
$$;

-- ------------------------------------------------------------------------------------------------ 3. approved by a rule
alter table pulse.erp_settings add column quote_auto_approve boolean not null default false,
  add column quote_auto_limit bigint constraint erp_settings_quote_auto_limit_valid check (quote_auto_limit is null or quote_auto_limit between 100 and 100000000000),
  add constraint erp_settings_quote_auto_needs_limit check (not quote_auto_approve or quote_auto_limit is not null);
comment on column pulse.erp_settings.quote_auto_approve is 'QUOTE-FAST (18 Nov 2026): an AI employee''s quotation is approved at once when every line is a catalogue item at its catalogue price, with no discount, and its total (incl. GST) is at most quote_auto_limit paise';

-- Only leadership or an admin changes who approves quotations, and the rule's change is kept in the settings' trail.
create or replace function pulse.erp_approval_setting_guard() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if pulse.current_viewer() is not null and not pulse.viewer_is('leadership', 'admin')
    and (new.quote_approval is distinct from (case when tg_op = 'INSERT' then false else old.quote_approval end)
      or new.quote_auto_approve is distinct from (case when tg_op = 'INSERT' then false else old.quote_auto_approve end)
      or new.quote_auto_limit is distinct from (case when tg_op = 'INSERT' then null else old.quote_auto_limit end)) then
    raise exception 'Only leadership or an admin can change whether quotations wait for approval' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.quote_auto_approve is distinct from old.quote_auto_approve or new.quote_auto_limit is distinct from old.quote_auto_limit) then
    insert into pulse.erp_event(org_id, subject_type, subject_id, kind, detail, actor)
    values (new.org_id, 'settings', null, 'quote_auto_approve', jsonb_build_object('on', new.quote_auto_approve, 'limit', new.quote_auto_limit,
      'was', jsonb_build_object('on', old.quote_auto_approve, 'limit', old.quote_auto_limit)), pulse.current_viewer());
  end if;
  return new;
end $$;
drop trigger erp_approval_setting_guard on pulse.erp_settings;
create trigger erp_approval_setting_guard before insert or update of quote_approval, quote_auto_approve, quote_auto_limit on pulse.erp_settings
  for each row execute function pulse.erp_approval_setting_guard();

-- The quotations a rule approved in this transaction (erp_quote_auto_ok checked them): the approval gate lets them through.
create table pulse_priv.erp_auto_issue (
  org_id uuid not null,
  document_id uuid not null references pulse.erp_document(id) on delete cascade,
  txid bigint not null,
  at timestamptz not null default now(),
  primary key (document_id, txid)
);
alter table pulse_priv.erp_auto_issue enable row level security;
alter table pulse_priv.erp_auto_issue force row level security;
create policy tenant_isolation on pulse_priv.erp_auto_issue using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());

-- Whether the rule approves this AI-made draft now; when it does, the approval gate lets this transaction issue it.
create function pulse.erp_quote_auto_ok(p_doc uuid) returns jsonb language plpgsql security definer set search_path = pulse, pg_temp as $$
declare s erp_settings; d erp_document; bad int;
begin
  select * into s from erp_settings where org_id = current_org();
  if not coalesce(s.quote_auto_approve, false) or s.quote_auto_limit is null then return jsonb_build_object('ok', false, 'why', 'off'); end if;
  if not erp_viewer_is_ai() or not erp_can(true) then return jsonb_build_object('ok', false, 'why', 'not_ai'); end if;
  select * into d from erp_document where org_id = current_org() and id = p_doc for update;
  if d.id is null or d.doc_type <> 'quotation' or d.status <> 'draft' then return jsonb_build_object('ok', false, 'why', 'not_draft'); end if;
  if d.approval_to is not null then return jsonb_build_object('ok', false, 'why', 'asked'); end if;
  if d.owner_approval = 'needed' then return jsonb_build_object('ok', false, 'why', 'price'); end if;
  if d.total <= 0 or d.total > s.quote_auto_limit then return jsonb_build_object('ok', false, 'why', 'limit', 'limit', s.quote_auto_limit); end if;
  -- Every line the client is quoted (a package's own parts are inside its price) is a catalogue item at its price, no discount.
  select count(*) into bad from erp_line l left join erp_item i on i.id = l.item_id
   where l.document_id = p_doc and not l.not_needed and l.parent_position is null
     and (l.item_id is null or i.status = 'archived' or l.rate <> i.price or coalesce(l.discount, 0) <> 0 or coalesce(l.discount_percent, 0) <> 0 or coalesce(l.open, false));
  if bad > 0 or not exists(select 1 from erp_line where document_id = p_doc and not not_needed) then return jsonb_build_object('ok', false, 'why', 'lines'); end if;
  insert into pulse_priv.erp_auto_issue(org_id, document_id, txid) values (current_org(), p_doc, txid_current()) on conflict do nothing;
  return jsonb_build_object('ok', true, 'limit', s.quote_auto_limit, 'total', d.total);
end $$;
grant execute on function pulse.erp_quote_auto_ok(uuid) to pulse_api;

-- Whether the company's rule approved this quotation (or, with null, any quotation) in this transaction.
create function pulse.erp_auto_issuing(p_doc uuid) returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists(select 1 from pulse_priv.erp_auto_issue a where a.org_id = current_org() and a.txid = txid_current() and (p_doc is null or a.document_id = p_doc))
$$;
-- An AI employee never approves or issues by itself (1562's guards; erp_agent_draft_only as 2367 left it), except a
-- quotation the rule approved just now.
create or replace function pulse.erp_agent_issue_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if old.status = 'draft' and new.status <> 'draft' and new.status <> 'cancelled' and agent_session() is not null
    and not pulse.erp_auto_issuing(new.id) then   -- QUOTE-FAST: unless the company's rule approved it in this transaction
  raise exception 'A person approves quotations and issues documents; an AI member drafts them' using errcode = '42501';
 end if;
 return new;
end $$;
create or replace function pulse.erp_agent_draft_only() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j jsonb; o jsonb;
begin
 if agent_session() is null then return coalesce(new, old); end if;
 -- QUOTE-FAST: a quotation the company's rule approves in this transaction takes the next number of its series.
 if tg_table_name = 'erp_series' and tg_op in ('INSERT', 'UPDATE') and pulse.erp_auto_issuing(null) then return new; end if;
 j := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if tg_table_name = 'erp_document' then
  if tg_op = 'INSERT' and new.status = 'draft' then return new; end if;
  if tg_op <> 'INSERT' and old.status = 'draft' then return coalesce(new, old); end if;
  -- Dispatching an approved quotation (erp_document_mark 'sent'): only the status moves, never its figures or buyer.
  if tg_op = 'UPDATE' and old.doc_type = 'quotation' and old.status = 'issued' and new.status = 'sent'
     and (new.number, new.total, new.client_id, new.doc_type, new.issue_date) is not distinct from (old.number, old.total, old.client_id, old.doc_type, old.issue_date)
   then return new; end if;
  raise exception 'An AI member drafts quotations and invoices; a person changes them once they are approved or issued' using errcode = '42501';
 end if;
 if tg_table_name = 'erp_line' then
  if exists(select 1 from erp_document d where d.id = (j->>'document_id')::uuid and d.status <> 'draft')
     or (tg_op = 'UPDATE' and exists(select 1 from erp_document d where d.id = (to_jsonb(old)->>'document_id')::uuid and d.status <> 'draft')) then
   raise exception 'An AI member drafts quotations and invoices; a person changes them once they are approved or issued' using errcode = '42501';
  end if;
  return coalesce(new, old);
 end if;
 if tg_table_name = 'erp_accept_link' and tg_op = 'INSERT' then return new; end if;
 if tg_table_name = 'erp_item' and tg_op = 'INSERT' then return new; end if;
 if tg_table_name = 'erp_item_version' and tg_op = 'INSERT' and not exists(select 1 from erp_item_version v where v.item_id = (j->>'item_id')::uuid) then return new; end if;
 if tg_table_name in ('erp_item_addon', 'erp_package_part') and tg_op = 'INSERT'
    and not exists(select 1 from erp_item_version v where v.item_id = coalesce(j->>'package_id', j->>'item_id')::uuid and v.version > 1) then return new; end if;
 -- WL-PRICE-TOOL: the catalogue keeper changes an item's price, GST rate, HSN/SAC, unit and name (and the version
 -- and edit stamps the save itself moves), and records stock, when leadership, an admin or Finance asked it (2367).
 -- Any other column of the item stays a person's.
 if agent_catalogue_keeper() and ((tg_table_name = 'erp_item' and tg_op = 'UPDATE') or (tg_table_name in ('erp_item_version', 'erp_stock_move') and tg_op = 'INSERT')) then
  if not agent_keeper_asked() then
   raise exception 'The catalogue keeper changes prices and stock only when leadership, an admin or Finance asks it in a message: ask one of them' using errcode = '42501';
  end if;
  if tg_table_name = 'erp_item' then
   o := to_jsonb(old) - array['price','gst_rate','sac','unit','name','version','updated_at','updated_by'];
   if o = j - array['price','gst_rate','sac','unit','name','version','updated_at','updated_by'] and old.status = 'active' then return new; end if;
   raise exception 'The catalogue keeper changes an active item''s price, GST rate, HSN/SAC, unit and name; anything else about an item is a person''s' using errcode = '42501';
  end if;
  return new;
 end if;
 raise exception 'An AI member drafts quotations and adds catalogue items when asked: payments, stock, prices, archiving and Billing settings are a person''s' using errcode = '42501';
end $$;

create or replace function pulse.erp_approval_gate() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare st jsonb;
begin
  if old.status <> 'draft' and new.status = 'draft' then
    new.approval_to := null; new.approval_asked_by := null; new.approval_asked_at := null; new.approval_note := null;
    return new;
  end if;
  if old.status = 'draft' and new.status = 'issued' and pulse.current_viewer() is not null
    and (new.doc_type = 'quotation' or (new.doc_type in ('proforma', 'invoice') and new.source_id is null))
    -- QUOTE-FAST: approved by the company's rule in this transaction (erp_quote_auto_ok).
    and not pulse.erp_auto_issuing(new.id) then
    st := pulse.erp_flow_step('approve');
    if coalesce((st->>'on')::boolean, false) and not pulse.erp_flow_holds(st->'roles') and new.approval_to is distinct from pulse.current_viewer() then
      raise exception 'A manager or the owner approves this %: send it for approval', case new.doc_type when 'quotation' then 'quotation' when 'proforma' then 'proforma' else 'invoice' end
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- migrate:down
create or replace function pulse.erp_approval_gate() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare st jsonb;
begin
  if old.status <> 'draft' and new.status = 'draft' then
    new.approval_to := null; new.approval_asked_by := null; new.approval_asked_at := null; new.approval_note := null;
    return new;
  end if;
  if old.status = 'draft' and new.status = 'issued' and pulse.current_viewer() is not null
    and (new.doc_type = 'quotation' or (new.doc_type in ('proforma', 'invoice') and new.source_id is null)) then
    st := pulse.erp_flow_step('approve');
    if coalesce((st->>'on')::boolean, false) and not pulse.erp_flow_holds(st->'roles') and new.approval_to is distinct from pulse.current_viewer() then
      raise exception 'A manager or the owner approves this %: send it for approval', case new.doc_type when 'quotation' then 'quotation' when 'proforma' then 'proforma' else 'invoice' end
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create or replace function pulse.erp_agent_issue_guard() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if old.status = 'draft' and new.status <> 'draft' and new.status <> 'cancelled' and agent_session() is not null then
  raise exception 'A person approves quotations and issues documents; an AI member drafts them' using errcode = '42501';
 end if;
 return new;
end $$;
create or replace function pulse.erp_agent_draft_only() returns trigger language plpgsql security definer set search_path=pulse,pg_temp as $$
declare j jsonb; o jsonb;
begin
 if agent_session() is null then return coalesce(new, old); end if;
 j := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
 if tg_table_name = 'erp_document' then
  if tg_op = 'INSERT' and new.status = 'draft' then return new; end if;
  if tg_op <> 'INSERT' and old.status = 'draft' then return coalesce(new, old); end if;
  -- Dispatching an approved quotation (erp_document_mark 'sent'): only the status moves, never its figures or buyer.
  if tg_op = 'UPDATE' and old.doc_type = 'quotation' and old.status = 'issued' and new.status = 'sent'
     and (new.number, new.total, new.client_id, new.doc_type, new.issue_date) is not distinct from (old.number, old.total, old.client_id, old.doc_type, old.issue_date)
   then return new; end if;
  raise exception 'An AI member drafts quotations and invoices; a person changes them once they are approved or issued' using errcode = '42501';
 end if;
 if tg_table_name = 'erp_line' then
  if exists(select 1 from erp_document d where d.id = (j->>'document_id')::uuid and d.status <> 'draft')
     or (tg_op = 'UPDATE' and exists(select 1 from erp_document d where d.id = (to_jsonb(old)->>'document_id')::uuid and d.status <> 'draft')) then
   raise exception 'An AI member drafts quotations and invoices; a person changes them once they are approved or issued' using errcode = '42501';
  end if;
  return coalesce(new, old);
 end if;
 if tg_table_name = 'erp_accept_link' and tg_op = 'INSERT' then return new; end if;
 if tg_table_name = 'erp_item' and tg_op = 'INSERT' then return new; end if;
 if tg_table_name = 'erp_item_version' and tg_op = 'INSERT' and not exists(select 1 from erp_item_version v where v.item_id = (j->>'item_id')::uuid) then return new; end if;
 if tg_table_name in ('erp_item_addon', 'erp_package_part') and tg_op = 'INSERT'
    and not exists(select 1 from erp_item_version v where v.item_id = coalesce(j->>'package_id', j->>'item_id')::uuid and v.version > 1) then return new; end if;
 -- WL-PRICE-TOOL: the catalogue keeper changes an item's price, GST rate, HSN/SAC, unit and name (and the version
 -- and edit stamps the save itself moves), and records stock, when leadership, an admin or Finance asked it (2367).
 -- Any other column of the item stays a person's.
 if agent_catalogue_keeper() and ((tg_table_name = 'erp_item' and tg_op = 'UPDATE') or (tg_table_name in ('erp_item_version', 'erp_stock_move') and tg_op = 'INSERT')) then
  if not agent_keeper_asked() then
   raise exception 'The catalogue keeper changes prices and stock only when leadership, an admin or Finance asks it in a message: ask one of them' using errcode = '42501';
  end if;
  if tg_table_name = 'erp_item' then
   o := to_jsonb(old) - array['price','gst_rate','sac','unit','name','version','updated_at','updated_by'];
   if o = j - array['price','gst_rate','sac','unit','name','version','updated_at','updated_by'] and old.status = 'active' then return new; end if;
   raise exception 'The catalogue keeper changes an active item''s price, GST rate, HSN/SAC, unit and name; anything else about an item is a person''s' using errcode = '42501';
  end if;
  return new;
 end if;
 raise exception 'An AI member drafts quotations and adds catalogue items when asked: payments, stock, prices, archiving and Billing settings are a person''s' using errcode = '42501';
end $$;

drop function pulse.erp_quote_auto_ok(uuid);
drop function pulse.erp_auto_issuing(uuid);
drop table pulse_priv.erp_auto_issue;
drop trigger erp_approval_setting_guard on pulse.erp_settings;
create or replace function pulse.erp_approval_setting_guard() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
  if pulse.current_viewer() is not null and not pulse.viewer_is('leadership', 'admin')
    and new.quote_approval is distinct from (case when tg_op = 'INSERT' then false else old.quote_approval end) then
    raise exception 'Only leadership or an admin can change whether quotations wait for approval' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger erp_approval_setting_guard before insert or update of quote_approval on pulse.erp_settings for each row execute function pulse.erp_approval_setting_guard();
alter table pulse.erp_settings drop column quote_auto_approve, drop column quote_auto_limit;
create or replace function pulse.notification_priority(p_type text) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select case
  when p_type = 'chat.call' then 'urgent'
  when p_type in ('chat.missed_call','chat.voice') then 'needs_you'
  when p_type in ('comp.payroll','comp.waiting','people.bank','profile.bank','update.test') then 'urgent'
  when p_type in ('approval.waiting','approval.digest','attendance.arrival','attendance.ask','attendance.digest','attendance.start','attendance.break',
   'chat.mention','chat.reply','chat.message','task.mention','project.mention','task.reply',
   'task.assigned','task.ask','task.help','project.ask','pool.match','task.blocked','task.waiting','task.due_soon','task.review_nudge',
   'domain.proposed','comp.offer','comp.claim','comp.letter','flow.wire','flow.alert','workflow.late',
   'leave.decision','request.decision',
   'holiday.announced','policy.published','payroll.processed') then 'needs_you'
  else 'fyi' end
$$;
create or replace function pulse.notification_family(p_type text) returns text language sql immutable set search_path=pulse,pg_temp as $$
 select case
  when p_type in ('chat.call','chat.missed_call') then 'calls'
  when p_type = 'chat.voice' then 'chats'
  when p_type in ('attendance.start','attendance.end','attendance.done','attendance.break','attendance.departure','attendance.nudge') then 'attendance_reminders'
  when p_type in ('attendance.arrival','attendance.ask','attendance.checkout') then 'attendance_questions'
  when p_type in ('attendance.confirmed','attendance.auto') then 'attendance_confirmations'
  when p_type = 'attendance.digest' then 'attendance_digest'
  when p_type in ('approval.waiting','approval.reminder','approval.digest') then 'approvals'
  when p_type in ('request.updated','request.decision','leave.decision') then 'my_requests'
  when p_type in ('chat.mention','chat.reply','task.mention','project.mention','task.reply') then 'mentions'
  when p_type = 'chat.message' then 'chats'
  when p_type in ('task.assigned','task.ask','task.help','project.ask','pool.match') then 'tasks_assigned'
  when p_type in ('task.blocked','task.waiting') then 'tasks_waiting'
  when p_type = 'task.due_soon' then 'tasks_due'
  when p_type = 'task.review_nudge' then 'reviews'
  when p_type like 'task.%' or p_type like 'project.%' or p_type like 'pool.%' or p_type = 'ask.answered' then 'task_updates'
  when p_type like 'domain.%' then 'domains'
  when p_type like 'flow.%' or p_type like 'workflow.%' then 'processes'
  when p_type like 'comp.%' or p_type in ('payroll.processed','people.bank','profile.bank') then 'pay'
  when p_type in ('profile.reminder','profile.changed','people.change') then 'profile'
  when p_type = 'update.test' then 'test'
  else 'company_updates' end
$$;
drop function pulse.erp_quote_chat_deliver(uuid, text, jsonb, interval);
drop function pulse.erp_quote_chat_keep(uuid, uuid, uuid, text);
drop function pulse.erp_viewer_is_ai();
drop table pulse.erp_quote_chat;
