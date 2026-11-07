"""EST-1733 (AI employees 2/8): the API on 0660 through the real app, synthetic people in two companies. The
assertions live in services/api/test/ai-employee-runner.mjs."""
import json
import os
import subprocess
import uuid
from pathlib import Path

from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from test_agent_coworkers import as_agent, ask, lead, make_agent, owner_sql
from test_hr_suite import ADMIN, HR
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def test_add_profile_team_chats_and_audit(api, worker, owner, team):  # noqa: F811
    w = team
    other = build_world(worker, owner, api)
    lead(worker, w, w.editor2)  # a leader who is not an admin
    agent, key = make_agent(api, w, "synthetic-crew", runtime="synthetic-runtime-x")
    chat = one(api, w, w.manager, "select pulse.chat_group_create(%s,%s) id", ("Synthetic crew", [w.editor]))["id"]
    as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (chat, agent))
    ask(api, w, w.editor, chat, "Synthetic question")
    owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values (%s,%s,%s,'Synthetic answer',%s)",
              (w.org, chat, agent, uuid.uuid4()))
    # An action in the AI employee's own key session, recorded the way every audited pak_ action is.
    as_agent(api, w, agent, "select pulse.audit_write('agent_synthetic_action','chat_channel',%s)", (str(chat),))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": json.dumps(config),
           "TEST_ADMIN": ADMIN, "TEST_HR": HR, "TEST_LEADER": f"editor2@{w.domain}", "TEST_STAFF": w.editor_handle,
           "TEST_STAFF_ID": str(w.editor), "TEST_OWNER": str(w.manager), "TEST_FOREIGN_OWNER": str(other.manager),
           "TEST_CODE": w.code, "TEST_AGENT": str(agent), "TEST_KEY": key, "TEST_CHAT": str(chat)}
    root = Path(__file__).resolve().parents[2] / "services/api"
    p = subprocess.run(["node", "test/ai-employee-runner.mjs"], cwd=root, env=env, capture_output=True, text=True, timeout=240)
    assert p.returncode == 0, (p.stderr + p.stdout)[-4000:]
