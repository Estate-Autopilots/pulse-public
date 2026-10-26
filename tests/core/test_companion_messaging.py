"""R15b membership and multi-device delivery on a disposable tenant, never employee data."""
import json
import os
import subprocess
from pathlib import Path

from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from helpers import build_world


def test_multi_device_group_and_dm_delivery(worker, owner, api, tmp_path):
    w = build_world(worker, owner, api)
    people = {"alice": w.editor, "bob": w.editor2, "outsider": w.lead, "admin": w.manager}
    with worker.transaction():
        set_tenant(worker, w.org)
        for name, person in people.items():
            worker.execute("insert into pulse.people_profile(org_id,person_id,username,role,pod,evidence) values(%s,%s,%s,'Editor','Pod 1','{}')", (w.org, person, "synthetic." + name))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, name + "@messaging.example", person))
            if name in ["alice", "bob", "admin"]:
                worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, person, "admin" if name == "admin" else "leadership"))
        worker.execute("insert into pulse.workspace_group(org_id,address,name,source_kind,source_value) values(%s,'leadership@messaging.example','Synthetic leadership','role','leadership')", (w.org,))
    env = {**os.environ, "PULSE_ORG_ID": str(w.org), "TEST_PEOPLE": json.dumps({k: str(v) for k, v in people.items()}), "TEST_REPORT": str(tmp_path / "messaging.json")}
    for role in ["api", "worker"]:
        config = conninfo_to_dict(dsn(role));config["database"] = config.pop("dbname")
        env["TEST_" + role.upper() + "_CONFIG"] = json.dumps(config)
    result = subprocess.run(["node", "test/companion-messaging-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
    report=json.loads((tmp_path / "messaging.json").read_text())
    assert report["checks"] >= 40
    if os.environ.get("COMPANION_RECEIPT_DIR"):
        out=Path(os.environ["COMPANION_RECEIPT_DIR"]);out.mkdir(parents=True,exist_ok=True)
        (out / "messaging-acceptance.json").write_text(json.dumps(report,indent=2))
