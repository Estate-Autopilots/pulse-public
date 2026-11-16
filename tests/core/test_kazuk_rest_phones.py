"""KAZUK-REST slice 3 (Willow Lane early-Nov meeting): calls that never sit on "Connecting…" without saying why (a busy,
refused or silent microphone is named, with Try again), and a phone's quick "+" for a new task. Browser only: nothing in
the database changed. Synthetic tenants and people only."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_erp_invoice import erp  # noqa: F401  (fixture)


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_call_problems_and_phone_quick_create_in_the_browser(worker, erp):  # noqa: F811
    """services/api/test/kazuk-rest-phones-browser-runner.mjs at 1440 and 390 (PULSE_KR_SCREENSHOTS=<dir> keeps the shots)."""
    w = erp
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                       (w.org, f"founder@{w.domain}", w.founder))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_EMAILS": json.dumps({"founder": f"founder@{w.domain}"})}
    p = subprocess.run(["node", "test/kazuk-rest-phones-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
