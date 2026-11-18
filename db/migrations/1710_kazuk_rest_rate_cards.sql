-- migrate:up
-- KAZUK-REST (6 Nov 2026; Kazuk's "Quotation Builder v2", backlog A8): a rate card per service. A service's price is
-- built from its base price per month × a multiplier X (how much of it: creatives, platforms, shoots...) × the talent
-- level's factor × the period (a month, a quarter: its months × its factor), plus add-ons (per month or once). The
-- Billing composer (the one builder) turns a rate card choice into quotation lines; the database works out each line's
-- rate-card price itself (erp_line.catalogue_rate). The salesperson decides the price (Kazuk, 6 Nov 2026: no approval
-- anywhere for EA): a rate card only suggests it. Only a company whose sales flow (pulse.erp_flow, 1671) keeps approvals
-- (the approve step on, i.e. erp_settings.quote_approval, and the price step on: the Willow Lane preset) has a price away
-- from the card approved by the price step's approvers, leadership, an admin or the person it was sent to. The EA preset
-- (no approval, no price gate) never stops a salesperson's price; with no flow row a company keeps quote_approval's rule.
--  1. pulse.erp_rate_card: one or more cards per service item. Billing readers read them; only leadership and admins (who
--     approve prices) write them, so a rate card price is already an approved price. Every change is audited and versioned.
--  2. erp_line.rate_card: the choice a line was built from ({cardId, part, x, talent, period}); a trigger fills the line's
--     service item and its rate-card price (catalogue_rate) from the card, whatever the request says.
--  3. pulse.erp_rate_card_gate: only while the company's flow keeps approvals (approve and price steps on), approving
--     (issuing) a document whose rate-card line is priced or discounted away from its rate card needs the price step's
--     approvers, leadership, an admin or the approver it was sent to.

create table pulse.erp_rate_card (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references pulse.org(id),
  item_id     uuid not null,
  name        text not null check (length(btrim(name)) between 1 and 120 and name !~ '[[:cntrl:]]'),
  base        bigint not null check (base between 1 and 100000000000),
  x_label     text not null default 'Scale' check (length(btrim(x_label)) between 1 and 40),
  x_min       numeric(10,3) not null default 1 check (x_min > 0),
  x_max       numeric(10,3) not null default 10 check (x_max <= 1000),
  talents     jsonb not null check (jsonb_typeof(talents) = 'array' and jsonb_array_length(talents) between 1 and 8),
  periods     jsonb not null check (jsonb_typeof(periods) = 'array' and jsonb_array_length(periods) between 1 and 8),
  add_ons     jsonb not null default '[]' check (jsonb_typeof(add_ons) = 'array' and jsonb_array_length(add_ons) <= 12),
  status      text not null default 'active' check (status in ('active', 'archived')),
  version     integer not null default 1,
  created_by  uuid references pulse.person(id),
  created_at  timestamptz not null default now(),
  updated_by  uuid references pulse.person(id),
  updated_at  timestamptz not null default now(),
  check (x_max >= x_min),
  foreign key (item_id, org_id) references pulse.erp_item(id, org_id)
);
create index erp_rate_card_item on pulse.erp_rate_card(org_id, item_id);
alter table pulse.erp_rate_card enable row level security;
alter table pulse.erp_rate_card force row level security;
create policy tenant on pulse.erp_rate_card using (org_id = pulse.current_org()) with check (org_id = pulse.current_org());
-- Billing readers read; leadership and admins (the price approvers) write.
create policy erp_read on pulse.erp_rate_card as restrictive for select to pulse_api using ((select pulse.erp_can(false)));
create policy erp_insert on pulse.erp_rate_card as restrictive for insert to pulse_api
  with check ((select pulse.erp_can(true)) and (select pulse.viewer_is('leadership', 'admin')));
create policy erp_update on pulse.erp_rate_card as restrictive for update to pulse_api
  using ((select pulse.erp_can(true)) and (select pulse.viewer_is('leadership', 'admin')))
  with check ((select pulse.erp_can(true)) and (select pulse.viewer_is('leadership', 'admin')));
create policy erp_delete on pulse.erp_rate_card as restrictive for delete to pulse_api using (false);
grant select, insert, update on pulse.erp_rate_card to pulse_api;

create function pulse.erp_rate_card_bump() returns trigger language plpgsql set search_path = pulse, pg_temp as $$
begin
  new.version := old.version + 1; new.updated_at := now(); new.updated_by := coalesce(pulse.current_viewer(), new.updated_by);
  return new;
end $$;
create trigger erp_rate_card_bump before update on pulse.erp_rate_card for each row execute function pulse.erp_rate_card_bump();
create trigger audit_mutation after insert or update or delete on pulse.erp_rate_card for each row execute function pulse.audit_mutation();

alter table pulse.erp_line add column rate_card jsonb check (rate_card is null or (jsonb_typeof(rate_card) = 'object' and pg_column_size(rate_card) < 2048));
comment on column pulse.erp_line.rate_card is 'KAZUK-REST (1710): the rate card choice this line was built from ({cardId, part: base | addon:<key>, x, talent, period}); catalogue_rate is its rate-card price';

-- One part of a rate card choice, priced exactly (numeric, rounded to the paisa): the base is base × X × talent factor ×
-- months × period factor; an add-on is its price × months (per month) or once.
create function pulse.erp_rate_card_calc(p_card uuid, p_org uuid, p_sel jsonb) returns bigint
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
declare c erp_rate_card; t jsonb; p jsonb; a jsonb; x numeric; part text := coalesce(p_sel ->> 'part', 'base'); v numeric;
begin
  select * into c from erp_rate_card where id = p_card and org_id = p_org;
  if c.id is null then raise exception 'That rate card is not in this company' using errcode = 'P0002'; end if;
  x := case when p_sel ->> 'x' ~ '^[0-9]+(\.[0-9]{1,3})?$' then (p_sel ->> 'x')::numeric end;
  if x is null or x < c.x_min or x > c.x_max then
    raise exception 'Choose % from % to %', lower(c.x_label), trim_scale(c.x_min), trim_scale(c.x_max) using errcode = '22023'; end if;
  select e into t from jsonb_array_elements(c.talents) e where e ->> 'key' = p_sel ->> 'talent';
  select e into p from jsonb_array_elements(c.periods) e where e ->> 'key' = p_sel ->> 'period';
  if t is null or p is null then raise exception 'Choose a talent level and a period from the rate card' using errcode = '22023'; end if;
  if part = 'base' then
    v := c.base * x * (t ->> 'factor')::numeric * (p ->> 'months')::numeric * (p ->> 'factor')::numeric;
  elsif part like 'addon:%' then
    select e into a from jsonb_array_elements(c.add_ons) e where e ->> 'key' = substr(part, 7);
    if a is null then raise exception 'That add-on is not on the rate card' using errcode = '22023'; end if;
    v := (a ->> 'price')::numeric * case when a ->> 'per' = 'month' then (p ->> 'months')::numeric else 1 end;
  else raise exception 'Choose the base or an add-on of the rate card' using errcode = '22023';
  end if;
  if v > 1000000000000 then raise exception 'That rate card price is too large' using errcode = '22023'; end if;
  return round(v)::bigint;
end $$;
revoke all on function pulse.erp_rate_card_calc(uuid, uuid, jsonb) from public;
-- The same price for the viewer's company, for Billing readers (the composer's preview and the tests).
create function pulse.erp_rate_card_price(p_card uuid, p_sel jsonb) returns bigint
language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
  if current_org() is null or not erp_can(false) then raise exception 'Rate cards are for Billing' using errcode = '42501'; end if;
  return erp_rate_card_calc(p_card, current_org(), p_sel);
end $$;
revoke all on function pulse.erp_rate_card_price(uuid, jsonb) from public;
grant execute on function pulse.erp_rate_card_price(uuid, jsonb) to pulse_api;

-- A line built from a rate card names the card's service and carries the card's price, whatever was sent.
create function pulse.erp_line_rate_card() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare card uuid; svc uuid;
begin
  if new.rate_card is null then return new; end if;
  card := case when new.rate_card ->> 'cardId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (new.rate_card ->> 'cardId')::uuid end;
  select item_id into svc from erp_rate_card where id = card and org_id = new.org_id;
  if svc is null then raise exception 'That rate card is not in this company' using errcode = 'P0002'; end if;
  new.item_id := svc;
  new.catalogue_rate := erp_rate_card_calc(card, new.org_id, new.rate_card);
  return new;
end $$;
revoke all on function pulse.erp_line_rate_card() from public;
create trigger erp_line_rate_card before insert or update of rate_card, rate, item_id on pulse.erp_line for each row execute function pulse.erp_line_rate_card();

-- The price gate for rate-card lines: a price or discount away from the rate card is approved by leadership, an admin
-- or the person the draft was sent to for approval (as the composer says: "a different price is a request").
create function pulse.erp_rate_card_gate() returns trigger language plpgsql security definer set search_path = pulse, pg_temp as $$
declare ap jsonb; pr jsonb;
begin
  -- (a proforma or invoice made from an approved quotation carries prices already approved, as erp_approval_gate says)
  if old.status = 'draft' and new.status = 'issued' and pulse.current_viewer() is not null
    and (new.doc_type = 'quotation' or (new.doc_type in ('proforma', 'invoice') and new.source_id is null)) then
    -- The company's sales flow (1671): approve.on is erp_settings.quote_approval; price.on is on unless the flow turns it
    -- off (the EA preset). Both must be on for a rate card's price to wait for approval.
    ap := pulse.erp_flow_step('approve'); pr := pulse.erp_flow_step('price');
    if coalesce((ap ->> 'on')::boolean, false) and coalesce((pr ->> 'on')::boolean, true)
      and not pulse.erp_flow_holds(coalesce(pr -> 'roles', '["leadership"]'::jsonb)) and not pulse.viewer_is('leadership', 'admin')
      and new.approval_to is distinct from pulse.current_viewer()
      and exists(select 1 from erp_line l where l.org_id = new.org_id and l.document_id = new.id and l.rate_card is not null and not l.not_needed
        and (l.rate is distinct from l.catalogue_rate or l.discount > 0 or coalesce(l.discount_percent, 0) > 0)) then
      raise exception 'A price differs from the rate card: send it for approval to a manager or the owner' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function pulse.erp_rate_card_gate() from public;
create trigger erp_rate_card_gate before update of status on pulse.erp_document for each row execute function pulse.erp_rate_card_gate();

-- migrate:down
-- Forward-only: rate cards and the choices lines were built from are kept.
