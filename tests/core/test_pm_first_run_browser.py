"""PM-BUILD-4 in the browser (services/api/test/pm-first-run-browser-runner.mjs): lane B's judged First run screen (19)
mounted on Work → Projects for a company with no projects yet. Its one button and each template card open the New project
form, a second press too, at phone 390, tablet 834 and laptop 1440, light and dark; the template card shows the
template's real counts. Synthetic tenant and invented names only; nothing is sent."""
import json
import os
import subprocess
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_plan_clocks_browser import TPL
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_pm_first_run_in_the_browser(worker, owner, api, team):  # noqa: F811
    w = team
    one(api, w, w.manager, "select pulse.delivery_template_adopt('agency-test','Property launch campaign',%s,%s) r", (Jsonb(TPL), w.project))
    with owner.transaction():
        set_tenant(owner, w.org)
        # The company's only project is finished, so Work → Projects has nothing to list and shows First run.
        owner.execute("update pulse.project set status='done' where org_id=%s", (w.org,))
        owner.execute("update pulse.work_project set status='done' where org_id=%s", (w.org,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_IDS": json.dumps({"org": str(w.org)})}
    p = subprocess.run(["node", "test/pm-first-run-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    print(p.stdout[-6000:])
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    assert "PM-FIRST-RUN OK" in p.stdout
