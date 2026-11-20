"""AGENT-OPERATOR: the operator view end to end (services/api/test/agent-operator-runner.mjs). Always, through API v1 with
the AI employee's own key: the upload/download tools are listed, a click that sends asks only the person (never Always),
a failed step with its page is filed as a bug by the AI employee and the same failure again is a note on it, and a
person's own Stop is not a bug. With PULSE_AUTH_BROWSER=1 a Playwright walk of /operator at 1440 and 363 (light and
dark): the AI works the framed page while the chat stays, the "Only you can say yes" prompt, the failed step with its bug,
Stop. Screenshots and a video go to AGENT_OPERATOR_SHOTS. Synthetic company; nothing is sent anywhere."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from test_agent_coworkers import make_agent
from test_agent_ui_browser import install_org
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401  (a fixture)


def test_operator_view_api_and_browser(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    agent, key = make_agent(api, w, "pip-operator-walk")
    was = install_org(owner, w.org)

    def config(value):
        data = conninfo_to_dict(value)
        data["database"] = data.pop("dbname")
        return json.dumps(data)

    report = tmp_path / "agent-operator.json"
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "PULSE_ORG_ID": str(w.org),
           "TEST_ADMIN_EMAIL": ADMIN, "TEST_ADMIN_ID": str(w.manager), "TEST_AGENT_ID": str(agent), "TEST_AGENT_NAME": "Pip Operator Walk",
           "TEST_AGENT_KEY": key, "AGENT_OPERATOR_REPORT": str(report)}
    root = Path(__file__).resolve().parents[2]
    try:
        result = subprocess.run(["node", "test/agent-operator-runner.mjs"], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=2400)
    finally:
        if was:
            install_org(owner, was)
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    data = json.loads(report.read_text())
    assert data["apiChecks"] >= 10
    if os.environ.get("PULSE_AUTH_BROWSER") == "1":
        assert data["browserChecks"] >= 20
