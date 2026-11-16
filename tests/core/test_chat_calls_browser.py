"""CHAT-VOICE journey J8 in the browser on the synthetic agency of test_chats_browser: a voice note recorded and played
at 1.5x, a call rung, answered and heard both ways between two Chromium people with fake microphones, muted,
minimised and hung up, and a missed call that needs you (services/api/test/calls-browser-runner.mjs). Everything is
invented; nothing is sent anywhere. Screenshots and videos with PULSE_CALLS_SHOTS=<dir>."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from test_chats_browser import _seed_chats
from test_tasks_rt1 import team  # noqa: F401  (team is a fixture)


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_voice_and_calls_in_the_browser(worker, owner, api, team, tmp_path):  # noqa: F811
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = team
    seeded = _seed_chats(api, worker, owner, w)

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_WORKER_CONFIG": config(dsn("worker")),
           "PULSE_ORG_ID": str(w.org), "TEST_MEMBER": w.editor_handle, "TEST_HEAD": f"editor2@{w.domain}", "TEST_IDS": json.dumps(seeded),
           "PULSE_CALLS_REPORT": str(tmp_path / "calls.json")}
    p = subprocess.run(["node", "test/calls-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((tmp_path / "calls.json").read_text())
    assert report["checks"] >= 20 and len(report["steps"]) == 3
