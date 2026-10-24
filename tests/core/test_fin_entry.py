"""FIN-ENTRY: Finance → Entries through the API on a synthetic tenant (services/api/test/fin-entry-runner.mjs).

Leadership (founder) and the Finance role (fin) add, edit, delete and restore entries; a staff member without Finance
sees nothing. The approval limit and the history are database triggers (db/migrations/0880_finance_entry.sql).
"""

import json
import os
import subprocess
import uuid
from pathlib import Path

from helpers import build_world
from pulse_sdk.db import set_tenant


def test_fin_entry_through_the_api(worker, owner, api, tmp_path):
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = build_world(worker, owner, api)
    roles = {r: uuid.uuid4() for r in ["founder", "fin", "staff"]}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,%s,'staff','active')",
                           (pid, w.org, "Synthetic " + {"fin": "Finance", "founder": "Founder", "staff": "Staff"}[role]))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, role + "@fin.example", pid))
        for role, key in [("founder", "leadership"), ("fin", "finance")]:
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, roles[role], key))
    config = conninfo_to_dict(dsn("api")); config["database"] = config.pop("dbname")
    wc = conninfo_to_dict(dsn("migrate")); wc["database"] = wc.pop("dbname")
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org),
           "TEST_ROLES": json.dumps({r: str(p) for r, p in roles.items()}), "TEST_REPORT": str(tmp_path / "fin.json"), "PULSE_CI": "1"}
    result = subprocess.run(["node", "test/fin-entry-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                            text=True, capture_output=True, timeout=300)
    assert result.returncode == 0, (result.stdout + "\n" + result.stderr)[-6000:]
    assert json.loads((tmp_path / "fin.json").read_text())["checks"] >= 38
