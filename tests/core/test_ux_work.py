"""UX-WORK (owner, 5 Nov 2026: "there is no UX/UI improvement in anything"): every Work screen to My day's standard.
A synthetic company with late, due-today and urgent work, a project run in stages with a late task, a published process
with a running step, and the browser runner walks My work, the task list and a task, reviews, approvals, processes,
runs, My steps, My week and the project page at 390 and 1440, light and dark: one obvious primary action, no sideways
scroll on a phone, one page title, and keyboard focus that shows. Synthetic tenants only; nothing is sent."""
import json
import os
import subprocess
from datetime import date, timedelta
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_project_stages import STARTER, late
from test_tasks_rt1 import new_task, one, team  # noqa: F401  (team is a fixture)


def _process(api, w):
    """A published two-step process the admin starts; its first step is the editor's."""
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        definition = {"steps": [
            {"id": "brief", "title": "Synthetic brief the shoot", "assign": {"by": "person", "personId": str(w.editor)}, "slaHours": 24},
            {"id": "edit", "title": "Synthetic edit the reel", "assign": {"by": "person", "personId": str(w.editor)}, "minutes": 120}]}
        wid = api.execute("select pulse.workflow_save(null,%s) id", (Jsonb({"name": "Synthetic shoot to reel", "definition": definition, "trigger": {"kind": "manual"}}),)).fetchone()["id"]
        api.execute("select pulse.workflow_publish(%s)", (wid,))
        run = api.execute("select pulse.workflow_start(%s,%s) id", (wid, Jsonb({"projectId": str(w.project)}))).fetchone()["id"]
    return wid, run


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_work_screens_in_the_browser(worker, owner, api, team):
    """services/api/test/ux-work-browser-runner.mjs. Screenshots with PULSE_UXW_SCREENSHOTS=<dir>."""
    w = team
    today = date.today()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set title='Synthetic Riverside launch',status='active' where id=%s", (w.project,))
    one(api, w, w.lead, "select pulse.delivery_template_adopt('simple-test','Simple project',%s,%s) r", (Jsonb(STARTER), w.project))
    one(api, w, w.lead, "select pulse.project_plan_set(%s,'simple-test','standard',null,%s,%s) r", (w.project, today - timedelta(days=8), w.lead))
    overdue = new_task(api, w, w.editor, title="Synthetic late edit of the walkthrough", projectId=str(w.project))
    late(owner, w, overdue, today - timedelta(days=3))
    one(api, w, w.editor, "select pulse.project_task_stage(%s,1)", (overdue,))
    one(api, w, w.lead, "select pulse.task_delays_sync() n")
    new_task(api, w, w.editor, title="Synthetic caption the site photos", dueOn=str(today))
    new_task(api, w, w.editor, title="Synthetic call the printer about the brochure", dueOn=str(today + timedelta(days=2)), priority="high")
    given = new_task(api, w, w.editor2, title="Synthetic cut a 30-second teaser", assigneeId=str(w.editor), dueOn=str(today + timedelta(days=1)))
    one(api, w, w.editor, "select pulse.task_move(%s,'in_progress')", (given,))
    wid, run = _process(api, w)
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    # Strict in CI: the kit, tile and one-primary checks fail the run (the base checks always do).
    env = {**os.environ, "PULSE_CI": "1", "PULSE_UXW_STRICT": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"project": str(w.project), "task": str(overdue), "process": str(wid), "run": str(run), "org": str(w.org),
                                   "editorEmail": w.editor_handle, "headEmail": f"editor2@{w.domain}"})}
    p = subprocess.run(["node", "test/ux-work-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=2400, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
