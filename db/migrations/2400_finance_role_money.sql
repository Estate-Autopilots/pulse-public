-- migrate:up
-- ROLE-FIX (QA-2 role walk, 18 Nov 2026): a person with the Finance role was refused Finance's money: Billing → Import
-- statement said "Finance access required" to the QA finance seat. pulse.money_can (0023, 2275) let in leadership, an
-- admin with an explicit Money permission, and since ARTHA-FIX (2275) an AI employee given the Finance role, but never a
-- person holding the Finance role, though every refusal says "for leadership and the Finance role" (finance/page-head,
-- v1-finance importBankStatement, 0880 fin_entry_open) and 1561 counts the Finance role among Money's approvers.
--
-- Now the Finance role (role_assignment 'finance', as Settings → Roles writes it) holds the three money grants, as the
-- AI employee's Finance role already does: money.read and money.amount.read (Finance's views, the bank and sheet
-- transactions, the cash position) and money.plan.write (importing a bank statement, categorising and linking records).
-- What stays as it was: approving a money record and budgets are people's (money_approve, money_plan_save refuse AI
-- sessions themselves); salaries still need the HR salary grant (hr_can); an accountant's seat is unchanged (CA desk).
create or replace function pulse.money_can(p_permission text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_permission=any(array['money.read','money.amount.read','money.plan.write']) and (viewer_is('leadership','finance') or viewer_is('admin') and exists(select 1 from money_permission where person_id=current_viewer() and permission=p_permission and revoked_at is null)
  or agent_finance())
$$;

-- migrate:down
-- Forward-only.
