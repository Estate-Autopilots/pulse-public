"""AGENT-CHANNELS: the API end to end and, with PULSE_AUTH_BROWSER=1, a Playwright walk of an AI employee's channels,
the listening room and the live transcript (services/api/test/agent-channels-runner.mjs). Synthetic company, synthetic
audio (Chromium's fake microphone playing tones), the stub transcriber; nothing is sent anywhere."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from test_agent_coworkers import make_agent
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401  (a fixture)


def test_agent_channels_api_and_browser(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "bharata-walk-synthetic")
    admin_email = ADMIN  # the team's admin (w.manager) signs in with this Workspace address (test_hr_suite._staff)

    def config(value):
        data = conninfo_to_dict(value)
        data["database"] = data.pop("dbname")
        return json.dumps(data)

    report = tmp_path / "agent-channels.json"
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_OWNER_CONFIG": config(owner.info.dsn),
           "TEST_WORKER_CONFIG": config(dsn("worker")), "PULSE_ORG_ID": str(w.org), "TEST_MEMBER": w.editor_handle, "TEST_ADMIN_EMAIL": admin_email,
           "TEST_AGENT_ID": str(agent), "TEST_AGENT_NAME": "Bharata Walk Synthetic", "AGENT_CHANNELS_REPORT": str(report),
           "VITALS_TELEGRAM_BOT_TOKEN": "", "VITALS_TELEGRAM_BOT_USERNAME": "", "VITALS_WHATSAPP_KEY_FILE": "/nonexistent"}
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(["node", "test/agent-channels-runner.mjs"], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=1200)
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    data = json.loads(report.read_text())
    assert data["apiChecks"] >= 17 and data["sent"] == 0
    if os.environ.get("PULSE_AUTH_BROWSER") == "1":
        assert data["browserChecks"] >= 24
