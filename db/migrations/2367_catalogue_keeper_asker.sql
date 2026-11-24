-- migrate:up
-- WL-PRICE-TOOL 2 (18 Nov 2026), closing a gap in 2365 before any AI employee is made a catalogue keeper. The API
-- does not know who asked an AI employee for something, so a salesperson could tell the keeper "make this ₹1" and
-- then get a catalogue-price quotation, which a company may let through without the owner (quote auto-approve).
-- The database does know: a run in progress (agent_run 'dispatching') points at the message that started it.
--
-- Now the keeper's three writes (an item's price, GST rate, HSN/SAC, unit, name; a new item version; a stock move)
-- go through only while every run of that AI employee in progress was started by a chat message from leadership, an
-- admin or the Finance role (the people who may change the catalogue themselves in Billing). Asked by anyone else,
-- from a task, a schedule, or with its key outside a run: refused, with a sentence that says who can ask.
-- A run older than 30 minutes does not count (a stuck run neither grants nor blocks for long).

create function pulse.agent_keeper_asked() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  with runs as (
    select r.id, cm.author_id
      from agent_run r join agent_event ev on ev.id = r.event_id
      left join chat_message cm on ev.subject_type = 'message' and cm.id = ev.subject_id and cm.org_id = r.org_id
     where r.org_id = current_org() and r.agent_id = agent_session() and r.state = 'dispatching' and r.started_at > now() - interval '30 minutes')
  select exists(select 1 from runs) and not exists(
    select 1 from runs x where x.author_id is null or not exists(
      select 1 from person p join role_assignment ra on ra.person_id = p.id and ra.org_id = p.org_id
       where p.id = x.author_id and p.org_id = current_org() and p.status = 'active' and p.side = 'staff'
         and ra.role_key in ('admin', 'leadership', 'finance') and current_date between ra.valid_from and coalesce(ra.valid_to, 'infinity')))
$$;

-- 2365's guard with the keeper's writes tied to who asked. The rest is unchanged, word for word.
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

revoke all on function pulse.agent_keeper_asked() from public;
grant execute on function pulse.agent_keeper_asked() to pulse_api, pulse_worker;

-- migrate:down
-- Forward-only.
