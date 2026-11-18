"""AI-AGENTS-2 (owner walkthrough, 17 Nov 2026): an AI employee's profile (Work & queue with waiting, working, done and
failed, time and tokens; Capabilities as tool groups; Model & limits up to 5 crore tokens; Role & place with the daily
triage's recipients), an AI's numbered answer typeset in the chat, and Settings → AI with logos and plain words for the
built-in workspace. The API end to end and, with PULSE_AUTH_BROWSER=1, a Playwright walk at 1440 and 363 px in light and
dark (services/api/test/ai-agents-2-runner.mjs). Synthetic company, people and runs; nothing is sent anywhere."""
import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent, owner_sql
from test_autopilots_browser import runs, within_today
from test_hr_suite import ADMIN
from test_runners import _paired
from test_tasks_rt1 import one, team  # noqa: F401  (a fixture)

ANSWER = """Here is the plan for **Harbor Crest Interiors (test)**:

1. Draft the quotation from the catalogue
   - Modular kitchen: ₹1,85,000
   - Wardrobe: ₹92,000
2. Add **18% GST** and send it to you for approval
3. Once you approve, send it to the client and open it on your screen

Anything to change before I start?"""


def test_ai_agents_2_api_and_browser(api, worker, owner, team, tmp_path):  # noqa: F811
    w = team
    ai, _ = make_agent(api, w, "quotes-helper-test", title="Quotes and invoices (AI)")
    owner_sql(owner, w, "update pulse.agent_member set access='operations', tools=array['billing','chats','tasks','memory'], daily_token_budget=300000, daily_triage=true where person_id=%s", (ai,))
    runs(owner, w, ai, 3, 14000, ago=within_today(owner, w, 90, 0.5))
    runs(owner, w, ai, 1, 3000, ago=within_today(owner, w, 30, 0.2), state="error")
    owner_sql(owner, w, "update pulse.agent_run set error_code='model_error' where agent_id=%s and state='error'", (ai,))
    one(api, w, w.manager, "select pulse.task_save(null,%s::jsonb) id", (json.dumps({"title": "Draft the quotation for Harbor Crest (test)", "assigneeId": str(ai)}),))
    dm = owner_sql(owner, w, "select pulse.agent_dm_with(%s,%s) id", (ai, w.manager))[0]["id"]
    # AI-AGENTS-3: a company server that lets AI employees in (synthetic, paired as the admin), for Capabilities' tiers.
    runner_id, _, _ = _paired(api, w, w.manager, hostname="synthetic-box")
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.runner_access_set(%s,'read-write',true,true,'Synthetic: AI employees allowed')", (runner_id,))
    owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,%s,%s)", (w.org, dm, ai, ANSWER, uuid.uuid4()))

    def config(value):
        data = conninfo_to_dict(value)
        data["database"] = data.pop("dbname")
        return json.dumps(data)

    report = tmp_path / "ai-agents-2.json"
    shots = os.environ.get("AI_AGENTS_2_SHOTS") or str(tmp_path / "shots")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": config(dsn("api")), "TEST_OWNER_CONFIG": config(owner.info.dsn),
           "TEST_WORKER_CONFIG": config(dsn("worker")), "PULSE_ORG_ID": str(w.org), "TEST_MEMBER": w.editor_handle, "TEST_ADMIN_EMAIL": ADMIN,
           "TEST_AGENT": str(ai), "TEST_DM": str(dm), "TEST_WATCHERS": json.dumps([str(w.editor), str(w.lead)]),
           "AI_AGENTS_2_REPORT": str(report), "AI_AGENTS_2_SHOTS": shots, "TEST_SERVER": str(runner_id)}
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(["node", "test/ai-agents-2-runner.mjs"], cwd=root / "services/api", env=env, capture_output=True, text=True, timeout=2400, check=False)
    if os.environ.get("AI_AGENTS_2_SHOTS"):
        Path(shots).mkdir(parents=True, exist_ok=True)
        (Path(shots) / "runner.log").write_text((result.stdout + "\n" + result.stderr)[-20000:])
    assert result.returncode == 0, (result.stderr + result.stdout)[-6500:]
    data = json.loads(report.read_text())
    assert data["apiChecks"] >= 8
    if os.environ.get("PULSE_AUTH_BROWSER") == "1":
        assert data["browserChecks"] >= 24
