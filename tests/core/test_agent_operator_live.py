"""AGENT-OPERATOR live (T4.2.3, the workflow video): a synthetic company, an Accounts Assistant AI employee with Billing
and its own key, the real runtime (services/coworker/runner.mjs) on this server's own model sign-in, the API and web of
this checkout, and the person's operator view recorded while the assistant makes a quotation, has it approved (it asks
first), marks it accepted, makes the proforma on the page and drafts the invoice (services/api/test/agent-operator-live.mjs).
Only with PULSE_AOP_LIVE=1 (it spends real model tokens); video, stills and live.json in PULSE_AOP_LIVE_DIR. Every
person, client and line is invented; nothing is sent."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent, owner_sql
from test_agent_ui_browser import install_org
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401  (a fixture)


@pytest.mark.skipif(os.environ.get("PULSE_AOP_LIVE") != "1", reason="spends real model tokens: run with PULSE_AOP_LIVE=1")
def test_the_accounts_assistant_runs_quotation_to_invoice_live(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    agent, key = make_agent(api, w, "accounts-operator", title="Accounts Assistant")
    owner_sql(owner, w, "update pulse.agent_member set tools=%s where org_id=%s and person_id=%s", (["billing", "chats"], w.org, agent))
    owner_sql(owner, w, "insert into pulse.agent_ui_level(org_id,agent_id,level,set_by) values(%s,%s,'act',%s) on conflict (org_id,agent_id) do update set level='act'",
              (w.org, agent, w.manager))
    # Invoicing is for leadership and Finance: the synthetic admin who watches is also leadership here.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'leadership','2026-01-01')", (w.org, w.manager))
    keyfile = tmp_path / "agent.key"
    keyfile.write_text(key)
    keyfile.chmod(0o600)
    was = install_org(owner, w.org)
    data = conninfo_to_dict(dsn("api"))
    data["database"] = data.pop("dbname")
    out = Path(os.environ.get("PULSE_AOP_LIVE_DIR", tmp_path))
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(data), "TEST_ADMIN_EMAIL": ADMIN, "TEST_ADMIN_ID": str(w.manager),
           "TEST_AGENT_ID": str(agent), "TEST_AGENT_USERNAME": "accounts-operator", "TEST_AGENT_KEYFILE": str(keyfile), "PULSE_AOP_LIVE_DIR": str(out)}
    try:
        p = subprocess.run(["node", "test/agent-operator-live.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=3300, check=False)
    finally:
        if was:
            install_org(owner, was)
    out.mkdir(parents=True, exist_ok=True)
    (out / "live-runner.log").write_text(p.stdout[-30000:] + "\n---\n" + p.stderr[-20000:])
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((out / "live.json").read_text())
    assert any(d["doc_type"] == "quotation" for d in report["stages"][0]["docs"]), "a quotation was made"
