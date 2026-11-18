"""API-PLATFORM-2 (owner, 5 Nov 2026: "complete control of Pulse through the API, agents, tier-wise access"): the
AI-employee admin API on real tenant RLS (services/api/test/api-ai-employees-runner.mjs, migration 1596), then what the
database holds: every change on the app ledger, forced row security on the cap table, and the monthly cap stopping an
AI employee's runs (agent_lock gives it no budget). Synthetic people and figures only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent
from test_erp_invoice import _seed_erp_world, erp  # noqa: F401  (erp is a fixture)


def test_api_ai_employee_admin(worker, owner, api, erp):  # noqa: F811
    w = erp
    _seed_erp_world(worker, w)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) select %s,%s,'admin','2026-01-01'
            where not exists(select 1 from pulse.role_assignment where person_id=%s and role_key='admin')""", (w.org, w.manager, w.manager))
    agent, _key = make_agent(api, w, "aide-admin-synthetic")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"admin@{w.domain}", w.manager))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("delete from pulse_priv.platform_plan where for_org=%s", (w.org,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "PULSE_PUBLIC_URL": "https://pulse.synthetic.example", "TEST_API_CONFIG": json.dumps(config),
           "TEST_W": json.dumps({"org": str(w.org), "agent": str(agent), "memberEmail": f"member@{w.domain}", "adminEmail": f"admin@{w.domain}"})}
    p = subprocess.run(["node", "test/api-ai-employees-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=600, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-8000:]
    out = json.loads([line for line in p.stdout.splitlines() if line.startswith('{"ok"')][-1])
    assert out["checks"] >= 30, out
    made = out["agentId"]

    with owner.transaction():
        set_tenant(owner, w.org)
        r = owner.execute("select relrowsecurity r, relforcerowsecurity f from pg_class where oid='pulse_priv.ai_employee_cap'::regclass").fetchone()
        assert r["r"] and r["f"]
        assert owner.execute("select count(*) n from pg_policies where schemaname='pulse_priv' and tablename='ai_employee_cap' and policyname='tenant'").fetchone()["n"] == 1
        actions = {r["action"] for r in owner.execute("select distinct action from pulse_priv.app_change where org_id=%s and subject_id=%s", (w.org, made)).fetchall()}
        assert {"ai_employee.create", "ai_employee.update", "ai_employee.cap", "ai_employee.key.create", "ai_employee.key.revoke"} <= actions, actions
        assert owner.execute("select count(*) n from pulse_priv.app_change where org_id=%s and subject_id=%s and actor_id=%s", (w.org, made, w.manager)).fetchone()["n"] >= 5
        # The monthly cap: under it the day's budget stands; at it, agent_lock leaves no budget.
        assert owner.execute("select monthly_tokens from pulse_priv.ai_employee_cap where person_id=%s", (made,)).fetchone()["monthly_tokens"] == 5000
        budget = owner.execute("select (pulse.agent_lock(%s)).daily_token_budget b", (made,)).fetchone()["b"]
        assert budget and budget > 0, budget
        assert owner.execute("select pulse.agent_month_tokens(%s) n", (made,)).fetchone()["n"] == 0
    # At the cap: the month's count stands in at 6,000 tokens (inside this transaction only, rolled back).
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("create or replace function pulse.agent_month_tokens(p_agent uuid) returns bigint language sql stable as 'select 6000::bigint'")
        assert owner.execute("select (pulse.agent_lock(%s)).daily_token_budget b", (made,)).fetchone()["b"] == 0
        assert owner.execute("select (pulse.agent_lock(%s)).daily_token_budget b", (agent,)).fetchone()["b"] > 0, "no cap, no stop"
        raise psycopg.Rollback()

    # The API role reads the cap only through the admin functions.
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        with pytest.raises(Exception, match="permission denied"):
            api.execute("select * from pulse_priv.ai_employee_cap")
