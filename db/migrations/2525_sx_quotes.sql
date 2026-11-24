-- migrate:up
-- SX-QUOTES (Sales X-Ray's list for the Pulse team, 22 Nov 2026: ~/orch/boards/sx-redesign/review/v195-quotes-via-pulse-design.md
-- §4; owner: "we keep sending spammy links again and again"). Sales X-Ray makes and sends quotations for its leads
-- through the existing org link (the connect API), and one system owns delivery:
--  1. Four org-link scopes: pulse.contacts.write, pulse.quotes.read, pulse.quotes.write, pulse.catalogue.read; with
--     pulse.org.webhooks and pulse.quotes.read an endpoint may take the quote.* events.
--  2. erp_document.delivery_owner ('pulse' | 'sales_xray'): while Sales X-Ray delivers a quotation, Pulse offers no Send
--     of its own and leaves it off the "not sent yet" lists; erp_document.external_ref keeps the app's own id.
--  3. erp_delivery: each delivery the app made (channel, when, by whom, its touch id), on the quotation's timeline.
--  4. connect_idem: an app's Idempotency-Key and the first answer it got, kept (a repeat gets the same answer).
--  5. Quotations' changes reach the change feed (connect_change, entity 'quote') and connect_due turns them into
--     signed events: {type, org_id, quote_id, external_ref, lead_ref, version, occurred_at}; no prices, no personal data.

-- 1. scopes
create or replace function pulse.oidc_known_scopes() returns text[] language sql immutable as $$
  select array['openid','profile','email','offline_access','pulse.orgs','pulse.org.read','pulse.org.webhooks','pulse.signals.write',
               'pulse.clients.read','pulse.leads.write','pulse.calls.write','pulse.money.read',
               'pulse.contacts.write','pulse.quotes.read','pulse.quotes.write','pulse.catalogue.read']
$$;
create or replace function pulse.oidc_org_scopes() returns text[] language sql immutable as $$
  select array['pulse.org.read','pulse.org.webhooks','pulse.signals.write','pulse.leads.write','pulse.calls.write','pulse.money.read',
               'pulse.contacts.write','pulse.quotes.read','pulse.quotes.write','pulse.catalogue.read']
$$;

create or replace function pulse.oidc_scope_events(p_scopes text[]) returns text[] language sql immutable as $$
  select array_remove(array[
    case when 'pulse.org.webhooks' = any(p_scopes) then 'person.updated' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'person.photo_updated' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'membership.added' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'membership.removed' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'membership.role_changed' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'link.revoked' end,
    case when 'pulse.org.webhooks' = any(p_scopes) then 'link.changed' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.clients.read' = any(p_scopes) then 'client.updated' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.clients.read' = any(p_scopes) then 'client.removed' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.quotes.read' = any(p_scopes) then 'quote.created' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.quotes.read' = any(p_scopes) then 'quote.updated' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.quotes.read' = any(p_scopes) then 'quote.approval_changed' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.quotes.read' = any(p_scopes) then 'quote.pdf_ready' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.quotes.read' = any(p_scopes) then 'quote.sent' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.quotes.read' = any(p_scopes) then 'quote.accepted' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.quotes.read' = any(p_scopes) then 'quote.declined' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.quotes.read' = any(p_scopes) then 'quote.superseded' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.quotes.read' = any(p_scopes) then 'quote.voided' end,
    case when 'pulse.org.webhooks' = any(p_scopes) and 'pulse.quotes.read' = any(p_scopes) then 'quote.delivered' end], null)
$$;

-- 2. who delivers, and the app's own id
alter table pulse.erp_document add column delivery_owner text not null default 'pulse' check (delivery_owner in ('pulse', 'sales_xray'));
alter table pulse.erp_document add column external_ref text check (external_ref ~ '^[A-Za-z0-9:._-]{1,100}$');
create unique index erp_document_external_ref on pulse.erp_document(org_id, external_ref) where external_ref is not null;
comment on column pulse.erp_document.delivery_owner is 'SX-QUOTES (2525): who sends this document to the customer; sales_xray: Pulse offers no Send of its own';

-- 3. deliveries an app made
create table pulse.erp_delivery(
 id uuid primary key default gen_random_uuid(), org_id uuid not null references pulse.org(id),
 document_id uuid not null references pulse.erp_document(id),
 channel text not null check (channel in ('whatsapp', 'whatsapp_phone', 'email', 'sms', 'link', 'other')),
 sent_at timestamptz not null, by_person uuid references pulse.person(id), app text check (length(app) <= 80),
 external_ref text not null check (external_ref ~ '^[A-Za-z0-9:._-]{1,100}$'), link_host text check (length(link_host) <= 253),
 created_at timestamptz not null default now(), unique (org_id, external_ref));
alter table pulse.erp_delivery enable row level security; alter table pulse.erp_delivery force row level security;
create policy tenant on pulse.erp_delivery using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select, insert on pulse.erp_delivery to pulse_api;
comment on table pulse.erp_delivery is 'SX-QUOTES (2525): a send an app made (Sales X-Ray): channel, when, by whom, its own touch id; kept';

-- 4. idempotency keys of connected apps
create table pulse.connect_idem(
 org_id uuid not null references pulse.org(id), grant_id uuid not null, key text not null check (key ~ '^[A-Za-z0-9:._-]{8,100}$'),
 op text not null check (length(op) <= 80), body_hash text not null check (body_hash ~ '^[0-9a-f]{64}$'),
 status int not null, answer jsonb not null, created_at timestamptz not null default now(), primary key (grant_id, key));
alter table pulse.connect_idem enable row level security; alter table pulse.connect_idem force row level security;
create policy tenant on pulse.connect_idem using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
grant select, insert on pulse.connect_idem to pulse_api;

-- the change feed takes quotations
alter table pulse.connect_change drop constraint connect_change_entity_check;
alter table pulse.connect_change add constraint connect_change_entity_check check (entity in ('person', 'client', 'link', 'quote'));

-- A quotation's life as quote.* changes, only for an organisation with an app linked (as connect_note).
create function pulse.connect_note_quote() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare back text := current_setting('pulse.org_id', true); v_type text; v_changed text[] := '{}';
begin
 if new.doc_type <> 'quotation' then return null; end if;
 perform set_config('pulse.org_id', new.org_id::text, true);
 if not exists (select 1 from oidc_grant where org_id = new.org_id and kind = 'org' and revoked_at is null) then
  perform set_config('pulse.org_id', coalesce(back, ''), true); return null;
 end if;
 begin
  if tg_op = 'INSERT' then v_type := 'quote.created';
  elsif new.status is distinct from old.status then
   v_type := case new.status when 'issued' then 'quote.approval_changed' when 'sent' then 'quote.sent' when 'accepted' then 'quote.accepted'
     when 'converted' then 'quote.accepted' when 'declined' then 'quote.declined' when 'cancelled' then 'quote.voided' else 'quote.updated' end;
   v_changed := array['status'];
  elsif to_jsonb(new) ->> 'superseded_by' is distinct from to_jsonb(old) ->> 'superseded_by' and to_jsonb(new) ->> 'superseded_by' is not null then
   v_type := 'quote.superseded'; v_changed := array['superseded'];
  elsif new.total is distinct from old.total or new.revision is distinct from old.revision or new.valid_until is distinct from old.valid_until
     or new.delivery_owner is distinct from old.delivery_owner then
   v_type := 'quote.updated';
   v_changed := array_remove(array[case when new.total is distinct from old.total then 'totals' end, case when new.revision is distinct from old.revision then 'version' end,
     case when new.valid_until is distinct from old.valid_until then 'valid_until' end, case when new.delivery_owner is distinct from old.delivery_owner then 'delivery_owner' end], null);
  end if;
  if v_type is not null then insert into connect_change(org_id, entity, ref, type, changed) values (new.org_id, 'quote', new.id, v_type, v_changed); end if;
  if v_type = 'quote.approval_changed' then insert into connect_change(org_id, entity, ref, type, changed) values (new.org_id, 'quote', new.id, 'quote.pdf_ready', '{pdf}'); end if;
  perform set_config('pulse.org_id', coalesce(back, ''), true);
 exception when others then perform set_config('pulse.org_id', coalesce(back, ''), true);
 end;
 return null;
end $$;
create trigger connect_note_quote after insert or update on pulse.erp_document for each row execute function pulse.connect_note_quote();
create function pulse.connect_note_delivery() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
begin
 if exists (select 1 from oidc_grant where org_id = new.org_id and kind = 'org' and revoked_at is null) then
  insert into connect_change(org_id, entity, ref, type, changed) values (new.org_id, 'quote', new.document_id, 'quote.delivered', array[new.channel]);
 end if;
 return null;
end $$;
create trigger connect_note_delivery after insert on pulse.erp_delivery for each row execute function pulse.connect_note_delivery();

-- The catalogue a linked app reads (pulse.catalogue.read): active items with their price and GST, never cost; the
-- organisation is the link's (the bearer set it). A definer: the admin who linked the app need not use Billing.
create function pulse.connect_catalogue(p_q text, p_after uuid) returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
 select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'unit', i.unit, 'price', i.price, 'gst', i.gst_rate, 'sac', i.sac) order by i.id), '[]'::jsonb)
 from (select * from erp_item where org_id = current_org() and status = 'active' and (coalesce(p_q, '') = '' or name ilike '%' || p_q || '%' or coalesce(sac, '') ilike p_q || '%')
   and (p_after is null or id > p_after) order by id limit 101) i
$$;
revoke all on function pulse.connect_catalogue(text, uuid) from public;
grant execute on function pulse.connect_catalogue(text, uuid) to pulse_api;

-- Home's "not sent yet": a quotation Sales X-Ray delivers is not Pulse's to send (as 2501, one filter more).
create or replace function pulse.erp_quote_home() returns jsonb language sql stable security definer set search_path = pulse, pg_temp as $$
 with mine as (
  select d.id, d.doc_type, d.number, coalesce(nullif(btrim(d.buyer->>'name'), ''), 'the client') client, d.issued_at
  from erp_document d where d.org_id = current_org() and d.doc_type in ('quotation', 'proforma') and d.status = 'issued' and d.sent_at is null
   and d.delivery_owner = 'pulse' and current_viewer() in (d.salesperson_id, d.created_by, d.issued_by))
 select jsonb_build_object(
  'followUps', coalesce((select jsonb_agg(jsonb_build_object('documentId', d.id, 'number', d.number, 'client', coalesce(nullif(btrim(d.buyer->>'name'), ''), 'the client'),
      'nextDueAt', f.next_due_at) order by f.next_due_at)
    from (select x.document_id, x.next_due_at from erp_followup x where x.org_id = current_org() and x.state = 'scheduled' and x.person_id = current_viewer()
      order by x.next_due_at limit 5) f join erp_document d on d.id = f.document_id), '[]'::jsonb),
  'notSent', (select count(*)::int from mine),
  'notSentDocs', coalesce((select jsonb_agg(jsonb_build_object('documentId', m.id, 'docType', m.doc_type, 'number', m.number, 'client', m.client, 'issuedAt', m.issued_at)
      order by m.issued_at desc) from (select * from mine order by issued_at desc limit 5) m), '[]'::jsonb))
 where current_viewer() is not null and current_org() is not null
$$;

-- 5. connect_due (as last defined in 2491) with the quote branch, and one pending event per quotation.
create or replace function pulse.connect_due(p_limit int default 50) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare h record; c record; v_sub text; v_body jsonb; v_pending uuid; v_max bigint; v_due uuid[];
begin
  for h in select k.*, g.app_id, g.id gid, g.scopes from connect_hook k join oidc_grant g on g.id = k.grant_id
            where k.org_id = current_org() and k.status in ('active', 'ending') loop
    v_max := 0;
    -- Changes since the endpoint was registered that it has not seen yet (one committing late is still found). What
    -- happens to the link itself (ended, scopes changed) reaches every endpoint of that link, listed or not.
    for c in select * from connect_change where org_id = current_org() and seq > h.cursor_seq and not (h.id = any(seen_by))
               and (type = any(h.events) or (entity = 'link' and ref = h.gid)) and (entity <> 'link' or ref = h.gid) order by seq limit 500 loop
      v_max := v_max + 1;
      update connect_change set seen_by = seen_by || h.id where seq = c.seq;
      if c.entity = 'person' then
        if not exists (select 1 from person where id = c.ref and side in ('staff', 'freelancer')) then continue; end if;
        v_sub := oidc_sub(h.app_id, c.ref);
        v_body := jsonb_build_object('type', c.type, 'org_id', current_org(), 'sub', v_sub, 'occurred_at', c.at, 'changed', to_jsonb(c.changed));
      elsif c.entity = 'client' then
        v_body := jsonb_build_object('type', c.type, 'org_id', current_org(), 'client_id', c.ref, 'occurred_at', c.at, 'changed', to_jsonb(c.changed));
      elsif c.entity = 'quote' then
        -- SX-QUOTES: the quotation's ids only (the app fetches it: pull-on-push); never prices or personal data.
        v_body := jsonb_build_object('type', c.type, 'org_id', current_org(), 'quote_id', c.ref, 'occurred_at', c.at, 'changed', to_jsonb(c.changed))
          || coalesce((select jsonb_build_object('external_ref', d.external_ref, 'lead_ref', case when d.sx_lead_id is not null then 'sx:lead:' || d.sx_lead_id end,
               'version', coalesce(d.revision, 0) + 1) from erp_document d where d.id = c.ref), '{}'::jsonb);
      else
        v_body := jsonb_build_object('type', c.type, 'org_id', current_org(), 'occurred_at', c.at, 'changed', '[]'::jsonb);
      end if;
      select id into v_pending from connect_event where hook_id = h.id and type = c.type and delivered_at is null and given_up_at is null and attempts = 0
         and next_at <= now()  -- never one being delivered right now
         and body -> 'sub' is not distinct from v_body -> 'sub' and body -> 'client_id' is not distinct from v_body -> 'client_id'
         and body -> 'quote_id' is not distinct from v_body -> 'quote_id' limit 1;
      if v_pending is not null then
        update connect_event set body = body || jsonb_build_object('occurred_at', c.at,
          'changed', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from (select jsonb_array_elements_text(body -> 'changed') x union select unnest(c.changed)) u))
         where id = v_pending;
      else
        insert into connect_event(org_id, hook_id, type, body, occurred_at) values (current_org(), h.id, c.type, v_body, c.at);
      end if;
    end loop;
    -- An ended link stops once its last events (link.revoked among them) are out.
    if h.status = 'ending' and v_max = 0 and not exists (select 1 from connect_event where hook_id = h.id and delivered_at is null and given_up_at is null) then
      update connect_hook set status = 'removed' where id = h.id;
    end if;
  end loop;
  -- NO-DATA-LOSS: the change feed, delivered events and the connected apps' call log are kept (they were deleted after
  -- 90, 30 and 90 days).
  -- What is handed out is leased for two minutes, so a second API process's tick does not send it again meanwhile.
  select coalesce(array_agg(id), '{}') into v_due from (
    select e.id from connect_event e join connect_hook k on k.id = e.hook_id and k.status in ('active', 'ending')
     where e.org_id = current_org() and e.delivered_at is null and e.given_up_at is null and e.next_at <= now()
     order by e.next_at limit p_limit for update of e skip locked) d;
  update connect_event set next_at = now() + interval '2 minutes' where id = any(v_due);
  return coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'hook', e.hook_id, 'url', k.url, 'secret', k.secret, 'type', e.type,
      'body', jsonb_build_object('event_id', e.id) || e.body, 'attempts', e.attempts) order by e.occurred_at)
    from connect_event e join connect_hook k on k.id = e.hook_id where e.id = any(v_due)), '[]'::jsonb);
end $$;

-- migrate:down
-- Forward-only: deliveries, idempotency answers and the change feed are kept.
