"""ARTHA-FIX (17 Nov 2026, migration 2275): an AI employee an organisation admin gives the Finance role works the finance
and money functions in its own session, and approvals, budgets and access stay with people.

The owner: "The whole point of this agent is access to all finance endpoints and everything related to money." Before,
the Finance AI employee was refused Finance → Entries ("Finance entries are for leadership and the Finance role"): an AI
employee holds no role (agent_no_role) and the money grants were leadership's. Synthetic people, accounts and figures only.

AI-FIX (BC-015): the runner also checks the finance numbers' and a statement summary's rupees beside the paise."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

from test_runner_access import _agent, _as_agent
from test_runners import _people


def _can(api, w, aid):
    with api.transaction():
        _as_agent(api, w, aid)
        return api.execute("""select pulse.fin_entry_can(false) read, pulse.fin_entry_can(true) write, pulse.fin_entry_approver() approver,
            pulse.money_can('money.read') money, pulse.money_can('money.amount.read') amounts, pulse.money_can('money.plan.write') plan,
            pulse.agent_finance() finance""").fetchone()


def test_an_admin_gives_an_ai_employee_the_finance_role_and_it_reads_and_imports_money(worker, owner, api):
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "leadership", "person"], f"{w.code.lower()}.example")
    aid = _agent(owner, w, p["admin"])

    assert _can(api, w, aid) == {"read": False, "write": False, "approver": False, "money": False, "amounts": False, "plan": False, "finance": False}, \
        "without the role an AI employee reaches no finance entry or money record (the refusal the Finance AI employee met)"
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        _as_agent(api, w, aid)
        api.execute("select pulse.fin_entry_open()")

    # Only an organisation admin gives it, never leadership, a person or the AI itself; a role row stays impossible.
    for who in ("leadership", "person"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            set_tenant(api, w.org, p[who])
            api.execute("select pulse.agent_finance_role_set(%s,true,'Synthetic')", (aid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        _as_agent(api, w, aid)
        api.execute("select pulse.agent_finance_role_set(%s,true,'Synthetic')", (aid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'finance','2020-01-01')", (w.org, aid))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        _as_agent(owner, w, aid)
        owner.execute("select pulse.task_require_viewer()")
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        r = api.execute("select pulse.agent_finance_role_set(%s,true,'Synthetic: the finance AI employee') r", (aid,)).fetchone()["r"]
        assert r["finance"] is True and r["by"] == str(p["admin"])
        again = api.execute("select pulse.agent_finance_role_set(%s,true,null) r", (aid,)).fetchone()["r"]
        assert again["since"] == r["since"], "giving it twice changes nothing"
        hist = api.execute("select field,old_value,new_value,changed_by from pulse.record_change where entity_type='role' and entity_id=%s", (aid,)).fetchall()
        assert hist == [{"field": "finance", "old_value": None, "new_value": "granted: Synthetic: the finance AI employee", "changed_by": p["admin"]}]

    # In its own session: the ledger read (the Accountant's rule unchanged), money with amounts, statement import.
    assert _can(api, w, aid) == {"read": True, "write": True, "approver": False, "money": True, "amounts": True, "plan": True, "finance": True}
    row = {"date": "2026-07-01", "vendor": "Synthetic vendor", "amount": "1180.00", "currency": "INR", "direction": "outflow", "category": "Other",
           "account_last4": "4321", "reference_hash": "b" * 64}
    with api.transaction():
        _as_agent(api, w, aid)
        api.execute("select pulse.fin_entry_open()")
        assert api.execute("select pulse.money_statement_save(%s,'bank') n", (Jsonb([row]),)).fetchone()["n"] == 1
        assert api.execute("select pulse.money_statement_save(%s,'bank') n", (Jsonb([row]),)).fetchone()["n"] == 0, "a repeated line is skipped"
        assert api.execute("select (pulse.money_read('money_sheet_transactions',0)->>'total')::int n").fetchone()["n"] == 1
        assert api.execute("select pulse.finance_numbers(date '2026-07-01', date '2026-07-01') ? 'months' ok").fetchone()["ok"]
        key = api.execute("select pulse.money_read('money_sheet_transactions',0)->'rows'->0->>'id' k").fetchone()["k"]
    # Finance desk tasks: it works tasks as a team member does (without operations access). task_require_viewer is the
    # task functions' own gate (not callable by the API login): checked as the schema owner, in the AI's session.
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        _as_agent(owner, w, aid)
        assert owner.execute("select pulse.task_require_viewer() v").fetchone()["v"] == aid

    # People's decisions stay people's: approving a money record, budgets, recording an entry (EA's AI guard).
    for sql, args in (("select pulse.money_approve('money_sheet_transactions',%s,true)", (key,)),
                      ("select pulse.money_plan_save(date '2026-07-01','Other',1000,'INR','budget','Synthetic')", ())):
        with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
            _as_agent(api, w, aid)
            api.execute(sql, args)

    # Outside its own session (its id as a person's viewer, no agent session) the role counts for nothing.
    with api.transaction():
        set_tenant(api, w.org, aid)
        assert api.execute("select pulse.agent_finance() f, pulse.money_can('money.read') m").fetchone() == {"f": False, "m": False}
    # A switched-off AI employee holds nothing; an admin ends the role and it is gone, with the history.
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        owner.execute("update pulse.agent_member set disabled_at=now() where person_id=%s", (aid,))
    assert _can(api, w, aid)["finance"] is False
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        owner.execute("update pulse.agent_member set disabled_at=null where person_id=%s", (aid,))
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        assert api.execute("select pulse.agent_finance_role_set(%s,false,'Synthetic end') r", (aid,)).fetchone()["r"]["finance"] is False
        assert api.execute("select count(*)::int n from pulse.record_change where entity_type='role' and entity_id=%s", (aid,)).fetchone()["n"] == 2
    assert _can(api, w, aid)["money"] is False

    # A person's own rights are unchanged: leadership approves, a plain person reaches nothing.
    with api.transaction():
        set_tenant(api, w.org, p["leadership"])
        assert api.execute("select pulse.fin_entry_approver() a, pulse.money_can('money.read') m").fetchone() == {"a": True, "m": True}
        api.execute("select pulse.money_approve('money_sheet_transactions',%s,true)", (key,))
    with api.transaction():
        set_tenant(api, w.org, p["person"])
        assert api.execute("select pulse.fin_entry_can(false) f, pulse.money_can('money.read') m").fetchone() == {"f": False, "m": False}


STATEMENT = (b"Date,Narration,Withdrawal Amt.,Deposit Amt.,Closing Balance\n"
             b"01/07/2026,UPI-SYNTHETIC VENDOR,1180.00,,50000.00\n03/07/2026,NEFT-SYNTHETIC CLIENT,,23600.00,73600.00\n")


def _owner(owner, w, sql, args=()):
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        owner.execute(sql, args)


def test_the_finance_ai_employees_tools_over_the_api(worker, owner, api):
    """Through /api/v1/mcp with its own key (services/api/test/artha-fix-runner.mjs): the ledger, the numbers, Money, a
    statement from its group imported, a doc shared with its group; refused without the role."""
    w = build_world(worker, owner, api)
    p = _people(worker, w, ["admin", "person"], f"{w.code.lower()}.example")
    aid, plain = _agent(owner, w, p["admin"]), _agent(owner, w, p["admin"])
    group, other = uuid.uuid4(), uuid.uuid4()
    for ch, name, members in ((group, "Synthetic finance group", [p["admin"], p["person"], aid, plain]), (other, "Synthetic other group", [p["admin"], p["person"]])):
        _owner(owner, w, "insert into pulse.chat_channel(org_id,id,key,name,kind) values(%s,%s,%s,%s,'custom')", (w.org, ch, f"group:{ch}", name))
        for m in members:
            _owner(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, ch, m))
    with api.transaction():
        set_tenant(api, w.org, p["person"])
        fid = api.execute("select pulse.chat_file_add(%s,'Synthetic statement July 2026.csv','text/csv',%s) id", (group, STATEMENT)).fetchone()["id"]
        api.execute("select pulse.chat_send(%s,'July statement, synthetic current account',null,%s,%s)",
                    (group, Jsonb([{"id": str(fid), "name": "Synthetic statement July 2026.csv", "mime": "text/csv"}]), uuid.uuid4()))
    with api.transaction():
        set_tenant(api, w.org, p["admin"])
        api.execute("select pulse.agent_finance_role_set(%s,true,'Synthetic')", (aid,))
        key = api.execute("select pulse.agent_key_issue(%s,'runner') k", (aid,)).fetchone()["k"]
        plain_key = api.execute("select pulse.agent_key_issue(%s,'runner') k", (plain,)).fetchone()["k"]
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    root = Path(__file__).resolve().parents[2]
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_KEY": key, "TEST_KEY_PLAIN": plain_key, "TEST_CHAT": str(group),
           "TEST_OTHER_CHAT": str(other), "TEST_FILE": str(fid), "TEST_PEOPLE": json.dumps([str(p["admin"]), str(p["person"])]),
           "PULSE_WORKER_PYTHON": str(root / ".venv/bin/python")}
    result = subprocess.run(["node", "services/api/test/artha-fix-runner.mjs"], cwd=root, env=env, capture_output=True, text=True, timeout=240)
    assert result.returncode == 0, (result.stdout + result.stderr)[-6000:]
    assert "artha-fix runner: ok" in result.stdout
