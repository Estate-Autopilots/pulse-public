"""FIX-CHAT-AI (owner walkthrough, 10 Nov 2026) in a real browser on a synthetic agency: the header chat opens a compact
popover with the recent conversations (never by itself, never half the page), a conversation opens inside it; Chats has
Chats · Groups · Calls tabs; Data review holds WhatsApp signals and imports; Calls has its right side. 1440 and 390, light
and dark, no sideways scroll. Screenshots with PULSE_FCA_SCREENSHOTS=<dir>. Every person and message here is invented."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from test_chats_browser import _seed_chats
from test_tasks_rt1 import team  # noqa: F401  (team is a fixture)


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_fix_chat_ai_in_the_browser(worker, owner, api, team, tmp_path):  # noqa: F811
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = team
    seeded = _seed_chats(api, worker, owner, w)

    def config(value):
        d = conninfo_to_dict(value)
        d["database"] = d.pop("dbname")
        return json.dumps(d)
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_MEMBER": w.editor_handle,
           "TEST_IDS": json.dumps(seeded), "PULSE_FCA_REPORT": str(tmp_path / "fca.json")}
    p = subprocess.run(["node", "test/fix-chat-ai-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=2700, check=False)
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((tmp_path / "fca.json").read_text())
    assert report["browserChecks"] >= 20
