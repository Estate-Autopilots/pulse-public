"""FIN-AGENT-2: the Finance AI employee's AI step, learned skills as API v1 / MCP tools, and GST reconciliation, end to
end on a synthetic tenant (services/api/test/fin-agent-2-runner.mjs).

The real API on a local port, the AI runtime's job worker (services/coworker/jobs.mjs) with the AI employee's own key, the
bubblewrap sandbox, and the runtime's test model for the one AI call a job may make. The database decides who may do what
(db/migrations/2240_fin_agent.sql, 2290_fin_agent_skills_gst.sql). Synthetic people, accounts (EXMP…), reviewed synthetic
GSTINs and figures only.
"""

import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant


def _bwrap_ok() -> bool:
    if not shutil.which("bwrap"):
        return False
    probe = ["bwrap", "--unshare-all", "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib",
             "--symlink", "usr/lib64", "/lib64", "/usr/bin/true"]
    return subprocess.run(probe, capture_output=True, timeout=10).returncode == 0


@pytest.mark.skipif(not _bwrap_ok(), reason="bubblewrap cannot make namespaces on this machine")
def test_fin_agent_2_end_to_end(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    roles = {r: uuid.uuid4() for r in ["founder", "fin", "staff", "admin"]}
    ai, ai2 = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,%s,'staff','active')",
                           (pid, w.org, "Synthetic " + {"fin": "Finance", "founder": "Founder", "staff": "Staff", "admin": "Admin"}[role]))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, role + "@finagent.example", pid))
        for role, key in [("founder", "leadership"), ("fin", "finance"), ("admin", "admin")]:
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, roles[role], key))
    with owner.transaction():
        role = owner.execute("select pg_get_userbyid(nspowner) r from pg_namespace where nspname='pulse'").fetchone()["r"]
        owner.execute(f"set local role {role}")
        set_tenant(owner, w.org)
        for n, (aid, tools, name) in enumerate([(ai, ["chats", "billing", "memory"], "Synthetic Finance AI"), (ai2, ["chats", "tasks"], "Synthetic Ops AI")], 1):
            owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'agent')", (aid, w.org, name))
            owner.execute("insert into pulse.agent_member(org_id,person_id,owner_person_id,employee_no,employee_id,tools) values(%s,%s,%s,%s,%s,%s)",
                          (w.org, aid, roles["founder"], 900 + n, f"SY-FA-{n:03d}", tools))
    keys = {}
    for aid in (ai, ai2):
        with api.transaction():
            set_tenant(api, w.org, roles["admin"])
            keys[aid] = api.execute("select pulse.agent_key_issue(%s,'fin-agent-2 test') k", (aid,)).fetchone()["k"]
    config = conninfo_to_dict(dsn("api")); config["database"] = config.pop("dbname")
    wc = conninfo_to_dict(dsn("migrate")); wc["database"] = wc.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org),
           "TEST_ROLES": json.dumps({**{r: str(p) for r, p in roles.items()}, "ai": str(ai), "ai2": str(ai2)}),
           "TEST_AGENT_KEY": keys[ai], "TEST_AGENT2_KEY": keys[ai2], "TEST_REPORT": str(tmp_path / "fin-agent-2.json"), "PULSE_CI": "1",
           "PULSE_SANDBOX_SCOPE": "0"}
    result = subprocess.run(["node", "test/fin-agent-2-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                            text=True, capture_output=True, timeout=600)
    assert result.returncode == 0, (result.stdout + "\n" + result.stderr)[-6000:]
    report = json.loads((tmp_path / "fin-agent-2.json").read_text())
    assert report["checks"] >= 45, report
