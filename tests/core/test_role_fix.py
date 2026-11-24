"""ROLE-FIX (QA-2 role walk, 18 Nov 2026, migration 2400): a person holding the Finance role holds Finance's money grants.

The walk's finance seat met "Finance access required" at Billing's Import statement: pulse.money_can let in leadership,
an admin with an explicit Money permission and an AI employee given the Finance role (2275), never a person with the
Finance role. Synthetic people only.
"""
from helpers import build_world
from pulse_sdk.db import set_tenant

from test_runners import _people

GRANTS = """select pulse.money_can('money.read') read, pulse.money_can('money.amount.read') amounts,
    pulse.money_can('money.plan.write') plan, pulse.money_can('hr.salary.read') salary, pulse.fin_entry_can(false) entries,
    pulse.fin_entry_approver() approver"""


def _grants(api, w, pid):
    with api.transaction():
        set_tenant(api, w.org, pid)
        return api.execute(GRANTS).fetchone()


def test_the_finance_role_holds_the_money_grants_and_nobody_else_gains_them(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ("finance", "member", "admin", "leadership"), w.domain)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'finance','2020-01-01')",
                       (w.org, p["finance"]))

    # The Finance role: Finance's figures, the bank lines and importing a statement; never salaries (the HR grant), and
    # not an approver of Finance → Entries (the limit, categories, accounts, the GST account stay leadership's; CI-RED-FIX 2410).
    assert _grants(api, w, p["finance"]) == {"read": True, "amounts": True, "plan": True, "salary": False, "entries": True,
                                             "approver": False}
    with api.transaction():
        set_tenant(api, w.org, p["finance"])
        api.execute("select pulse.finance_authorize(true)")  # Finance's views and statement import no longer refuse it

    # Unchanged: leadership has them; an admin without an explicit Money permission and a member have none.
    lead = _grants(api, w, p["leadership"])
    assert (lead["plan"], lead["approver"]) == (True, True)
    none = {"read": False, "amounts": False, "plan": False, "salary": False, "entries": False, "approver": False}
    assert _grants(api, w, p["admin"]) == none
    assert _grants(api, w, p["member"]) == none

    # A Finance role that has ended grants nothing.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.role_assignment set valid_from='2020-01-01', valid_to='2021-01-01' where person_id=%s and role_key='finance'",
                      (p["finance"],))
    assert _grants(api, w, p["finance"])["read"] is False
