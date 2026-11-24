"""DOCS-EDITOR-8: "show me how" end to end (services/api/test/show-me-how-runner.mjs). Always, through API v1 with the AI
employee's own key: MCP lists screen_show_me_how, it is a view action (sent at once at the view level), the browser's
result names the walkthrough it played, and "no walkthrough fits" or the person's no to their whole screen is not a bug.
With PULSE_AUTH_BROWSER=1 a Playwright walk at 1440 and 363 (light and dark): "how do I add a task?" from Chats opens the
operator view on Work with the guide bar and the step's button lit; Next, the lit button moving it on, Back, Do it for me
(a message to the AI), the bank statement walkthrough, Stop showing, Done; on the whole screen only after "Show me".
Screenshots go to SHOW_ME_HOW_SHOTS. Synthetic company; nothing is sent anywhere."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent
from test_agent_ui_browser import install_org
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401  (a fixture)


def test_show_me_how_api_and_browser(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    agent, key = make_agent(api, w, "pip-show-me-how")
    was = install_org(owner, w.org)
    # The bank statement walkthrough plays on Finance: the synthetic admin may read and write it (as test_finance_desk).
    with owner.transaction():
        set_tenant(owner, w.org)
        for permission in ["money.read", "money.amount.read", "money.plan.write"]:
            owner.execute("insert into pulse.money_permission(org_id,person_id,permission) values(%s,%s,%s) on conflict do nothing", (w.org, w.manager, permission))

    def config(value):
        data = conninfo_to_dict(value)
        data["database"] = data.pop("dbname")
        return json.dumps(data)

    report = tmp_path / "show-me-how.json"
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "PULSE_ORG_ID": str(w.org),
           "TEST_ADMIN_EMAIL": ADMIN, "TEST_ADMIN_ID": str(w.manager), "TEST_AGENT_ID": str(agent), "TEST_AGENT_NAME": "Pip Show Me How",
           "TEST_AGENT_KEY": key, "SHOW_ME_HOW_REPORT": str(report)}
    root = Path(__file__).resolve().parents[2]
    try:
        result = subprocess.run(["node", "test/show-me-how-runner.mjs"], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=2400)
    finally:
        if was:
            install_org(owner, was)
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    data = json.loads(report.read_text())
    assert data["apiChecks"] >= 12
    if os.environ.get("PULSE_AUTH_BROWSER") == "1":
        assert data["browserChecks"] >= 30
