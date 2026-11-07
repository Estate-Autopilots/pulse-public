"""API-PLATFORM (owner, 5 Nov 2026: "complete control of Pulse through the API ... tier-wise access"): slice 1 of the
platform on real tenant RLS (services/api/test/api-platform-runner.mjs): projects CRUD, the finance ledger, leave and
attendance, their MCP tools and the finance and hr areas on keys; then the company's API tier where keys are made, read
back in SQL. Synthetic people, figures and dates only."""
import datetime
import hashlib
import json
import os
import secrets
import subprocess
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent
from test_erp_invoice import _seed_erp_world, erp  # noqa: F401  (erp is a fixture)


def test_api_platform_slice_one(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) select %s,%s,'admin','2026-01-01'
            where not exists(select 1 from pulse.role_assignment where person_id=%s and role_key='admin')""", (w.org, w.manager, w.manager))
    agent, _key = make_agent(api, w, "ledger-bot-synthetic")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"admin@{w.domain}", w.manager))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("select pulse.hr_defaults()")
    # A whole working week three weeks ahead (Monday to Friday), for the leave request.
    today = datetime.date.today()
    monday = today + datetime.timedelta(days=21 - today.weekday())
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_PUBLIC_URL": "https://pulse.synthetic.example", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "agent": str(agent), "finance": str(w.finance), "founder": str(w.founder), "member": str(w.member),
                                 "financeEmail": f"finance@{w.domain}", "founderEmail": f"founder@{w.domain}", "memberEmail": f"member@{w.domain}", "adminEmail": f"admin@{w.domain}",
                                 "leaveFrom": monday.isoformat(), "leaveTo": (monday + datetime.timedelta(days=4)).isoformat()})}
    p = subprocess.run(["node", "test/api-platform-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=600, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    out = json.loads([line for line in p.stdout.splitlines() if line.startswith('{"ok"')][-1])
    assert out["checks"] >= 60, out
    with owner.transaction():
        set_tenant(owner, w.org)
        # Every call is audited as its own token's principal; the writes are on the app ledger with the app's name.
        ops = {r["operation_id"] for r in owner.execute("select distinct operation_id from pulse_priv.v1_call where org_id=%s", (w.org,)).fetchall()}
        assert {"createExpense", "listFinanceEntries", "requestLeave", "listLeaveRequests", "updateProject", "deleteProject", "listAttendance"} <= ops, ops
        assert owner.execute("select count(*) n from pulse_priv.v1_call where org_id=%s and principal_id=%s and operation_id='createExpense' and status=403", (w.org, agent)).fetchone()["n"] >= 1
        actions = {r["action"] for r in owner.execute("select distinct action from pulse_priv.app_change where org_id=%s", (w.org,)).fetchall()}
        assert {"expense.create", "leave.request", "project.update", "project.delete"} <= actions, actions
        assert owner.execute("select count(*) n from pulse.fin_entry where org_id=%s and source='api' and kind='expense'", (w.org,)).fetchone()["n"] == 1, "one expense, replayed once"

    # The tier where keys are made: a company on the trial plan is Free, so a new key may not hold finance, and its
    # one bot-key seat is counted. Keys made before stay as they are.
    def issue(person, kind, scopes, agent_id=None):
        token = ("pbk_" if kind == "bot" else "ppt_") + secrets.token_urlsafe(32)[:43]
        with api.transaction():
            set_tenant(api, w.org, person)
            return api.execute("select pulse.api_token_issue(%s,'Tier check',%s,7,%s,%s) v", (kind, scopes, agent_id, hashlib.sha256(token.encode()).hexdigest())).fetchone()["v"]

    with owner.transaction():
        set_tenant(owner, w.org)
        before = owner.execute("select count(*) n from pulse_priv.api_token where org_id=%s and revoked_at is null and 'finance.read'=any(scopes)", (w.org,)).fetchone()["n"]
        owner.execute("insert into pulse_priv.platform_plan(for_org,plan) values(%s,'trial') on conflict(for_org) do update set plan='trial'", (w.org,))
    with api.transaction():
        set_tenant(api, w.org, w.member)
        plan = api.execute("select pulse.api_plan() v").fetchone()["v"]
    assert plan["tier"] == "free" and "finance.read" not in plan["scopes"] and plan["botKeys"] == 1, plan
    with pytest.raises(Exception, match="plan does not include finance.read"):
        issue(w.member, "personal", ["tasks.read", "finance.read"])
    assert issue(w.member, "personal", ["tasks.read", "tasks.write"])
    with pytest.raises(Exception, match="bot keys and all are in use"):
        issue(w.manager, "bot", ["tasks.read"], agent)   # the runner's bot key already holds the Free tier's one seat
    with owner.transaction():
        set_tenant(owner, w.org)
        after = owner.execute("select count(*) n from pulse_priv.api_token where org_id=%s and revoked_at is null and 'finance.read'=any(scopes)", (w.org,)).fetchone()["n"]
        assert after == before, "keys made before the plan changed keep their reach"
        owner.execute("update pulse_priv.platform_plan set plan='growth' where for_org=%s", (w.org,))
    assert issue(w.member, "personal", ["finance.read", "hr.read"]), "Business holds every area"
