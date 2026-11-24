"""AGENT-UI-CONTROL: an AI employee drives the screen through API v1 and MCP with its own key (always), and with
PULSE_AUTH_BROWSER=1 a Playwright walk at 1440 (light) and 390 (dark) shows each action on the person's screen
(services/api/test/agent-ui-runner.mjs). Synthetic company and files; nothing is sent anywhere. Screenshots go to
AGENT_UI_SHOTS (the lane keeps them in ~/ea-research/flow/shots/AGENT-UI-CONTROL)."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from test_agent_coworkers import make_agent
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401  (a fixture)


def install_org(owner, org):
    """Make org the install's own company (API v1 serves it to an AI employee's key until c9bbb0cc picks the key's own);
    returns the one it was."""
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        before = owner.execute("select org_id from pulse.install").fetchone()
        owner.execute("update pulse.install set org_id=%s", (org,))
    return before["org_id"] if before else None


def test_agent_drives_the_screen_api_and_browser(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    agent, key = make_agent(api, w, "pip-screen-walk")
    was = install_org(owner, w.org)

    def config(value):
        data = conninfo_to_dict(value)
        data["database"] = data.pop("dbname")
        return json.dumps(data)

    report = tmp_path / "agent-ui.json"
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "PULSE_ORG_ID": str(w.org),
           "TEST_MEMBER": w.editor_handle, "TEST_MEMBER_ID": str(w.editor), "TEST_ADMIN_EMAIL": ADMIN, "TEST_ADMIN_ID": str(w.manager),
           "TEST_AGENT_ID": str(agent), "TEST_AGENT_NAME": "Pip Screen Walk", "TEST_AGENT_KEY": key, "AGENT_UI_REPORT": str(report)}
    root = Path(__file__).resolve().parents[2]
    try:
        result = subprocess.run(["node", "test/agent-ui-runner.mjs"], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=1800)
    finally:
        if was:
            install_org(owner, was)
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    data = json.loads(report.read_text())
    assert data["apiChecks"] >= 8
    if os.environ.get("PULSE_AUTH_BROWSER") == "1":
        assert data["browserChecks"] >= 50
