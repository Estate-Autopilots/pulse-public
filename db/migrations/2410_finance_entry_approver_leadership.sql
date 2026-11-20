-- migrate:up
-- CI-RED-FIX (19 Nov 2026): 2400 (ROLE-FIX) gave a person with the Finance role pulse.money_can's three grants, as it meant
-- to (Finance's views, the bank lines, importing a statement). But pulse.fin_entry_approver (0880, 2275) was "a person
-- with money_can('money.plan.write')", so the Finance role also became an approver of Finance → Entries, which 2400 says
-- it leaves unchanged: approving entries above the limit, the approval limit, categories and accounts
-- (finance-entry.ts: "Only leadership approves entries above the limit", "Leadership sets the approval limit, categories
-- and accounts") and the GST account (1480 finance_gst_account_set: "Leadership names the GST account"). Hosted CI run
-- 44450905425 went red on it: test_fin_entry ("the Finance role writes but does not approve") and test_finance_truth
-- ("Only leadership names the GST account" / "the Finance role does not name the GST account").
-- The approver is again exactly who it was before 2400: a person (never an AI session) who is leadership, or an admin
-- with the explicit money.plan.write Money permission (money_can before 2400). The Finance role keeps 2400's grants.
create or replace function pulse.fin_entry_approver() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and agent_session() is null and (viewer_is('leadership') or viewer_is('admin')
  and exists(select 1 from money_permission where person_id=current_viewer() and permission='money.plan.write' and revoked_at is null))
$$;

-- migrate:down
-- Forward-only.
