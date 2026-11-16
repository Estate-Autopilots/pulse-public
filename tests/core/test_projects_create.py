"""PROJECTS-CREATE (owner, 4 Nov 2026: "there is no way to create a task wala project here, so much confusion on the project
view of the tasks page"): Work → Projects starts a team project in a few fields (name, lead, an optional stage plan), and a
project with no stage plan gets one from its row. The database rules the dialog relies on, and a browser journey at 1440
and 390. Synthetic tenants only; nothing is sent."""
import json
import os
import subprocess
from datetime import date, timedelta
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_project_stages import STARTER, late
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)


def test_a_pod_head_starts_a_team_project_and_gives_it_a_stage_plan(api, worker, team):
    w = team
    # The dialog's three calls: the project (its maker leads it), the company's first plan, the plan laid out from today.
    made = one(api, w, w.editor2, "select pulse.work_project_save(null,%s) r", (Jsonb({"type": "internal", "name": "Synthetic office move", "ownerId": str(w.editor2)}),))["r"]
    pid = made["id"]
    assert one(api, w, w.editor2, "select owner_id,kind from pulse.work_project where project_id=%s", (pid,)) == {"owner_id": w.editor2, "kind": "internal"}
    # A member who does not lead it can neither choose how projects run nor plan it.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.delivery_template_adopt('simple-test','Simple project',%s,%s)", (Jsonb(STARTER), pid))
    assert one(api, w, w.editor2, "select pulse.delivery_template_adopt('simple-test','Simple project',%s,%s) r", (Jsonb(STARTER), pid))["r"]["added"] is True
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.project_plan_set(%s,'simple-test','standard',null,%s,null)", (pid, date.today()))
    r = one(api, w, w.editor2, "select pulse.project_plan_set(%s,'simple-test','standard',null,%s,null) r", (pid, date.today()))["r"]
    assert r["tasks"] == 3
    assert one(api, w, w.editor2, "select pulse.project_can_run(%s) ok", (pid,))["ok"] is True
    assert one(api, w, w.editor, "select pulse.project_can_run(%s) ok", (pid,))["ok"] is False


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_new_project_and_stage_plan_in_the_browser(worker, owner, api, team, tmp_path):
    """services/api/test/projects-create-browser-runner.mjs: leadership picks a stage plan from a project's row and starts a
    planned project with New project; a pod head starts one on a phone; a member is told where projects come from."""
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set title='Synthetic Riverside launch',status='active' where id=%s", (w.project,))
    # A late task with nobody planning the project yet: it needs a decision and has no stage plan.
    t = new_task(api, w, w.editor, title="Synthetic late edit", projectId=str(w.project))
    late(owner, w, t, date.today() - timedelta(days=3))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"project": str(w.project), "editorEmail": w.editor_handle, "headEmail": f"editor2@{w.domain}", "org": str(w.org)})}
    p = subprocess.run(["node", "test/projects-create-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    # What the browser did is in the database.
    assert one(api, w, w.manager, "select template_key from pulse.project_plan where project_id=%s", (w.project,))["template_key"] == "simple-project"
    move = one(api, w, w.manager, """select wp.kind,wp.owner_id,pl.template_key from pulse.work_project wp join pulse.project p on p.id=wp.project_id
      left join pulse.project_plan pl on pl.project_id=p.id where p.name='Synthetic office move'""")
    assert move == {"kind": "internal", "owner_id": w.editor2, "template_key": "simple-project"}
    phone = one(api, w, w.manager, """select wp.owner_id,(select count(*)::int from pulse.project_plan pl where pl.project_id=p.id) plans
      from pulse.work_project wp join pulse.project p on p.id=wp.project_id where p.name='Synthetic hiring drive'""")
    assert phone == {"owner_id": w.editor2, "plans": 0}
