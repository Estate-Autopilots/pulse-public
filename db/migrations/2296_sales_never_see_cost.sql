-- migrate:up
-- QUOTE-STRUCT (Kazuk's build guide, 16 Nov 2026, "Who sees what": "Salespeople never see cost or margin. Build this as a
-- role permission, not a setting someone can switch off"). 2252 made erp_sees_cost() false for a salesperson or sales
-- head whatever the company's cost_visibility; 2275 (ARTHA-FIX) then rewrote the function from 1670's body to let a
-- Finance AI employee see cost under 'finance', which dropped that rule. Both rules, together:
--   * a seat with leadership, admin or Finance follows the company's setting, as before;
--   * a salesperson or sales head without those never sees cost or margin, under any setting;
--   * an AI employee with the Finance role sees cost where Finance does (2275).
-- tests/core/test_quote_structure.py checks every setting for leadership, Finance, a salesperson and a sales head.

create or replace function pulse.erp_sees_cost() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select erp_can(false) and (viewer_is('leadership','admin','finance') or not viewer_is('sales','sales_head'))
  and case coalesce((select s.cost_visibility from erp_settings s where s.org_id = current_org()), 'everyone')
  when 'owner' then viewer_is('leadership','admin') when 'finance' then viewer_is('leadership','admin','finance') or agent_finance() else true end
$$;

-- migrate:down
-- Forward-only.
