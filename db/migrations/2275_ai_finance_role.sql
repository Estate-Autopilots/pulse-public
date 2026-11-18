-- migrate:up
-- ARTHA-FIX (owner, 17 Nov 2026, Estate Autopilots' "Finance Testing" group: "The whole point of this agent is access to
-- all finance endpoints and everything related to money"). The Finance AI employee was refused Finance → Entries ("Finance
-- entries are for leadership and the Finance role"): an AI employee holds no role (agent_no_role, 0950), and the money
-- grants (money_can) are leadership's, or an admin's with an explicit Money permission. So no AI employee could read the
-- ledger, the bank and sheet transactions, the finance numbers (GST, receipts) or import a bank statement.
--
-- Now an organisation admin can give an AI employee the Finance role (agent_finance_role_set; never the AI itself, never
-- through its key). It is kept on its member row, not in role_assignment (an AI employee still holds no role there), and
-- it counts only in that AI's own session (its key, or a job it asked for): agent_finance().
--   * Finance → Entries: read, as the Finance role does (fin_entry_can). Recording or changing an entry stays a person's
--     click (EA's AI guard, 0965, refuses every AI write on fin_entry*): the AI drafts, a person records.
--   * Money (bank and sheet transactions, Drive bills, Gmail receipts, payroll totals, subscriptions): read with amounts;
--     a bank statement imported (money_statement_save), records linked to a project or categorised (money.read,
--     money.amount.read, money.plan.write).
--   * Finance numbers (GST payable, receipts with and without GST, per month): through fin_entry_can and money_can.
--   * What stays with people: approving an entry above the limit and changing the limit, categories or accounts
--     (fin_entry_approver), approving a money record for reconciliation (money_approve), and budgets (money_plan_save).
--     Moving money, sending outside, deleting and tax settings were never an AI's (agent_guard, risk policy).
-- Every grant and removal is in the record history ('role' … 'finance', as Settings → Roles writes it) and the audit trail.

alter table pulse.agent_member add column finance_role_at timestamptz, add column finance_role_by uuid references pulse.person(id);
comment on column pulse.agent_member.finance_role_at is 'ARTHA-FIX: since when this AI employee holds the Finance role (null: it does not); set by an organisation admin with agent_finance_role_set';

-- The current session is an AI employee (its own key or a job it asked for) that holds the Finance role here.
create function pulse.agent_finance() returns boolean language sql stable security definer set search_path = pulse, pg_temp as $$
  select exists(select 1 from agent_member m where m.org_id = current_org() and m.person_id = agent_session() and m.finance_role_at is not null)
$$;

-- An organisation admin gives (p_on true) or ends the Finance role of an AI employee, with a note for the history.
create function pulse.agent_finance_role_set(p_agent uuid, p_on boolean, p_note text default null) returns jsonb
  language plpgsql security definer set search_path = pulse, pg_temp as $$
declare m agent_member%rowtype; note text := nullif(left(btrim(coalesce(p_note, '')), 400), '');
begin
  if agent_session() is not null or current_viewer() is null or not viewer_is('admin') then
    raise exception 'Only an organisation admin gives an AI employee the Finance role' using errcode = '42501';
  end if;
  select * into m from agent_member where org_id = current_org() and person_id = p_agent for update;
  if not found then raise exception 'Choose an AI employee' using errcode = '22023'; end if;
  if p_on and m.disabled_at is not null then raise exception 'This AI employee is switched off; switch it on first' using errcode = '22023'; end if;
  if p_on is distinct from (m.finance_role_at is not null) then
    update agent_member set finance_role_at = case when p_on then clock_timestamp() end, finance_role_by = case when p_on then current_viewer() end
     where org_id = current_org() and person_id = p_agent;
    insert into record_change(org_id, entity_type, entity_id, field, old_value, new_value, changed_by)
    values (current_org(), 'role', p_agent, 'finance', case when p_on then null else 'held' end, case when p_on then coalesce('granted: ' || note, 'granted') else coalesce('ended: ' || note, null) end, current_viewer());
    perform audit_write(case when p_on then 'grant' else 'revoke' end, 'agent.finance_role', p_agent::text);
  end if;
  return (select jsonb_build_object('agentId', person_id, 'finance', finance_role_at is not null, 'since', finance_role_at, 'by', finance_role_by)
            from agent_member where org_id = current_org() and person_id = p_agent);
end $$;

-- Finance → Entries (0880): leadership with the money grants, the Finance role, and now an AI employee with the Finance
-- role in its own session. Writes stay refused for AI employees by EA's AI guard on the fin_entry tables.
create or replace function pulse.fin_entry_can(p_write boolean default false) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and not is_accountant(current_viewer()) and (viewer_is('finance') or agent_finance()
  or (money_can('money.read') and money_can('money.amount.read') and (not p_write or money_can('money.plan.write'))))
$$;
-- Approving entries above the limit and changing the limit, the categories and the accounts: people only.
create or replace function pulse.fin_entry_approver() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select current_viewer() is not null and agent_session() is null and money_can('money.plan.write')
$$;

-- The money grants (0023): leadership, an admin with the explicit permission, and an AI employee with the Finance role.
create or replace function pulse.money_can(p_permission text) returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select p_permission=any(array['money.read','money.amount.read','money.plan.write']) and (viewer_is('leadership') or viewer_is('admin') and exists(select 1 from money_permission where person_id=current_viewer() and permission=p_permission and revoked_at is null)
  or agent_finance())
$$;

-- Approving a money record for reconciliation (0017): a person's decision, never an AI employee's.
create or replace function pulse.money_approve(p_dataset text,p_key text,p_approved boolean) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if agent_session() is not null then raise exception 'Approving money records is a person''s decision: ask a leader to approve it' using errcode='42501'; end if;
 if not money_can('money.plan.write') or not money_can('money.amount.read') then raise exception 'money write denied' using errcode='42501'; end if;
 if p_approved and p_dataset='money_sheet_transactions' and exists(select 1 from pulse_priv.money_observation where dataset=p_dataset and source_key=p_key and
 (coalesce(payload->>'amount','') !~ '^[0-9]+([.][0-9]+)?$' or coalesce(payload->>'direction','') not in('inflow','outflow') or coalesce(payload->>'currency','') !~ '^[A-Z]{3}$')) then
 raise exception 'confirm a valid amount, direction and currency before reconciliation' using errcode='22023'; end if;
 update pulse_priv.money_observation set approved=p_approved,approved_by=current_viewer() where dataset=p_dataset and source_key=p_key;
 if not found then raise exception 'money record missing' using errcode='22023'; end if;
end $$;

-- Budgets and next month's plan (0011): set by people (the owner is the budget's final approver), never an AI employee.
create or replace function pulse.money_plan_save(p_month date,p_category text,p_amount numeric,p_currency text,p_kind text,p_note text) returns void language plpgsql security definer set search_path=pulse,pg_temp as $$
begin
 if agent_session() is not null then raise exception 'Budgets are set by people: draft it and ask a leader' using errcode='42501'; end if;
 if not money_can('money.plan.write') or not money_can('money.amount.read') then raise exception 'money write denied' using errcode='42501'; end if;
 insert into pulse_priv.money_plan(org_id,month,category,amount,currency,kind,note,edited_by)
 values(current_org(),date_trunc('month',p_month)::date,p_category,p_amount,p_currency,p_kind,p_note,current_viewer())
 on conflict(org_id,month,category,currency,kind) do update set amount=excluded.amount,note=excluded.note,edited_by=excluded.edited_by,updated_at=now();
end $$;

-- Billing's costs when the company shows them to Finance (1670): an AI employee with the Finance role sees them too.
create or replace function pulse.erp_sees_cost() returns boolean language sql stable security definer set search_path=pulse,pg_temp as $$
 select erp_can(false) and case coalesce((select s.cost_visibility from erp_settings s where s.org_id = current_org()), 'everyone')
  when 'owner' then viewer_is('leadership','admin') when 'finance' then viewer_is('leadership','admin','finance') or agent_finance() else true end
$$;

-- The Finance desk is tasks: an AI employee with the Finance role works tasks as a team member does (comment, update,
-- create; each function's own checks still decide which task), without operations access, which would put every one
-- of its replies behind an approval (0965). Before, its tasks tool refused it ("Sign in as a team member", 1350).
create or replace function pulse.task_require_viewer() returns uuid language plpgsql stable security definer set search_path = pulse, pg_temp as $$
begin
 if current_viewer() is null or not (task_person_ok(current_viewer()) or (agent_session() = current_viewer() and (agent_acts(current_viewer()) or agent_finance()))) then
  raise exception 'Sign in as a team member to manage tasks' using errcode='42501';end if;
 return current_viewer();
end $$;

revoke all on function pulse.agent_finance(), pulse.agent_finance_role_set(uuid, boolean, text) from public;
grant execute on function pulse.agent_finance() to pulse_api, pulse_worker;
grant execute on function pulse.agent_finance_role_set(uuid, boolean, text) to pulse_api;

-- migrate:down
-- Forward-only.
