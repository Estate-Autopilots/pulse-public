"""AI-CONNECT: Settings → Connect your AI and the sign-in an AI app (Claude, ChatGPT) goes through, on a disposable
synthetic company (services/api/test/connect-ai-runner.mjs). Always: an app registers itself, the person allows only
some groups, the token holds only those, the app is listed with when it was last used, Disconnect ends it at once, a
colleague sees neither the connection nor the company's AI. With PULSE_AUTH_BROWSER=1 the same in a real browser at
1440 (light) and 390 (dark); screenshots go to CONNECT_AI_SHOTS. Nothing is sent anywhere."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from test_agent_ui_browser import install_org
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401  (a fixture)


def test_connect_your_ai(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    was = install_org(owner, w.org)

    def config(value):
        data = conninfo_to_dict(value)
        data["database"] = data.pop("dbname")
        return json.dumps(data)

    report = tmp_path / "connect-ai.json"
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")),
           "TEST_ADMIN_EMAIL": ADMIN, "TEST_MEMBER_EMAIL": w.editor_handle, "CONNECT_AI_REPORT": str(report)}
    root = Path(__file__).resolve().parents[2]
    try:
        result = subprocess.run(["node", "test/connect-ai-runner.mjs"], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=1800)
    finally:
        if was:
            install_org(owner, was)
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    data = json.loads(report.read_text())
    assert data["apiChecks"] >= 17  # 1830: create, change and read a contract over MCP
    if os.environ.get("PULSE_AUTH_BROWSER") == "1":
        assert data["browserChecks"] >= 30
