"""FIX-CHAT-AI live (owner walkthrough, 10 Nov 2026: "when I ask the accounts assistant to do something it should visibly
work on screen like a human; test it live and record a video"): a synthetic company, an Accounts Assistant AI employee
with Billing and its own key, the real runtime (services/coworker/runner.mjs) on this server's Claude sign-in, the API
and web of this checkout, and the admin's browser recorded while the assistant works: "open finance" (done with no model
call) and "remove the model-led video line" on an open draft quotation (it reads the screen, clicks the line, asks an
admin to allow "Remove", removes it). Tokens per request come from its runs. Only with PULSE_FCA_LIVE=1 (it spends real
model tokens); video and report in PULSE_FCA_LIVE_DIR. Every person, client and line is invented; nothing is sent."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from test_agent_coworkers import make_agent, owner_sql
from test_agent_ui_browser import install_org
from test_hr_suite import ADMIN
from test_tasks_rt1 import team  # noqa: F401  (a fixture)


@pytest.mark.skipif(os.environ.get("PULSE_FCA_LIVE") != "1", reason="spends real model tokens: run with PULSE_FCA_LIVE=1")
def test_the_accounts_assistant_works_the_screen_live(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    agent, key = make_agent(api, w, "accounts-live", title="Accounts Assistant")
    owner_sql(owner, w, "update pulse.agent_member set tools=%s where org_id=%s and person_id=%s", (["billing", "chats"], w.org, agent))
    owner_sql(owner, w, "insert into pulse.agent_ui_level(org_id,agent_id,level,set_by) values(%s,%s,'act',%s) on conflict (org_id,agent_id) do update set level='act'",
              (w.org, agent, w.manager))
    keyfile = tmp_path / "agent.key"
    keyfile.write_text(key)
    keyfile.chmod(0o600)
    was = install_org(owner, w.org)
    data = conninfo_to_dict(dsn("api"))
    data["database"] = data.pop("dbname")
    out = Path(os.environ.get("PULSE_FCA_LIVE_DIR", tmp_path))
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(data), "TEST_ADMIN_EMAIL": ADMIN, "TEST_ADMIN_ID": str(w.manager),
           "TEST_AGENT_ID": str(agent), "TEST_AGENT_USERNAME": "accounts-live", "TEST_AGENT_KEYFILE": str(keyfile), "PULSE_FCA_LIVE_DIR": str(out)}
    try:
        p = subprocess.run(["node", "test/fix-chat-ai-live.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=2700, check=False)
    finally:
        if was:
            install_org(owner, was)
    (out / "live-runner.log").write_text(p.stdout[-20000:] + "\n---\n" + p.stderr[-20000:])
    assert p.returncode == 0, (p.stderr + p.stdout)[-6000:]
    report = json.loads((out / "live.json").read_text())
    assert report["finance"]["opened"] and report["finance"]["tokens"] == 0
