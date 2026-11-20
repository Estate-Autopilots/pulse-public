-- migrate:up
-- QUOTE-BUILDER-4 (Kazuk's 19 Nov test, VTI task 1514f831, "most important"; owner order 20 Nov ~23:10 IST): a quantity in
-- two (or three) numbers. Neeti is sold per user per month: 6 users for 6 months is one line of quantity 36, and the
-- quotation must say "6 users × 6 months", never "× 36". Any business has these (units × floors, hours × people).
--  1. erp_line.qty_dims: the numbers ([{n, unit}], 2 or 3 of them); the line's qty is always their product (checked here,
--     so every sum, the PDF and the AI read the same quantity). Null: a plain quantity, as before.
--  2. pulse.erp_item_term_tiers(item): the prepaid discount by months for an item sold per month, from its rate card's
--     periods (Kazuk's Neeti card: 3–5 months 5 %, 6–9 months 10 %, 12 months 15 %): the item's own active card, else the
--     active card of an item sold in the same unit in the same phase (one Neeti card prices Basic, Professional and AI).
--     Months and percent only: never the card's base or factors, which a sales seat does not see.
-- Synthetic data only in tests; nothing here reads or writes a company's data.

create function pulse.erp_qty_dims_ok(p_dims jsonb, p_qty numeric) returns boolean
language plpgsql immutable set search_path = pulse, pg_temp as $$
declare d jsonb; q numeric := 1; n numeric;
begin
  if p_dims is null then return true; end if;
  if jsonb_typeof(p_dims) is distinct from 'array' or jsonb_array_length(p_dims) not between 2 and 3 then return false; end if;
  for d in select e from jsonb_array_elements(p_dims) e loop
    -- "is distinct from": a missing n or unit (null) is refused, never let through.
    if jsonb_typeof(d) is distinct from 'object' or jsonb_typeof(d -> 'n') is distinct from 'number' or jsonb_typeof(d -> 'unit') is distinct from 'string' then return false; end if;
    n := (d ->> 'n')::numeric;
    if n <= 0 or n > 1000000 or n <> round(n, 3) or length(btrim(d ->> 'unit')) not between 1 and 20 or (d ->> 'unit') ~ '[[:cntrl:]]' then return false; end if;
    q := q * n;
  end loop;
  return p_qty is not null and round(q, 3) = p_qty;
end $$;
comment on function pulse.erp_qty_dims_ok(jsonb, numeric) is 'QUOTE-BUILDER-4 (2498): a line''s numbers (2 or 3 of {n, unit}) make exactly its quantity';

alter table pulse.erp_line add column qty_dims jsonb;
alter table pulse.erp_line add constraint erp_line_qty_dims check (pulse.erp_qty_dims_ok(qty_dims, qty));
comment on column pulse.erp_line.qty_dims is 'QUOTE-BUILDER-4 (2498): the quantity in numbers ([{n, unit}]: 6 users × 6 months); qty is their product. Null: one number';

create function pulse.erp_item_term_tiers(p_item uuid) returns jsonb
language sql stable set search_path = pulse, pg_temp as $$
  with me as (select id, unit, phase from erp_item where id = p_item),
  card as (
    select c.periods from erp_rate_card c join erp_item i on i.id = c.item_id, me
     where c.status = 'active'
       and (c.item_id = me.id or (me.phase is not null and i.phase = me.phase and lower(btrim(i.unit)) = lower(btrim(me.unit)) and me.unit ~ '/'))
     order by (c.item_id = me.id) desc, c.name, c.id limit 1)
  select coalesce((select jsonb_agg(jsonb_build_object('months', t.months, 'percent', t.percent) order by t.months)
    from (select distinct on ((p ->> 'months')::int) (p ->> 'months')::int months, round((1 - (p ->> 'factor')::numeric) * 100, 2) percent
            from card, jsonb_array_elements(card.periods) p
           where (p ->> 'months') ~ '^[0-9]{1,3}$' and (p ->> 'factor') ~ '^[0-9]+(\.[0-9]+)?$' and (p ->> 'factor')::numeric between 0.01 and 1
           order by (p ->> 'months')::int, (p ->> 'factor')::numeric desc) t), '[]'::jsonb)
$$;
comment on function pulse.erp_item_term_tiers(uuid) is 'QUOTE-BUILDER-4 (2498): an item''s prepaid discount by months ([{months, percent}]) from its rate card''s periods (or the card of an item sold in the same unit in the same phase)';
grant execute on function pulse.erp_qty_dims_ok(jsonb, numeric) to pulse_api;
grant execute on function pulse.erp_item_term_tiers(uuid) to pulse_api;

-- migrate:down
-- Forward-only: the numbers on lines are kept.
