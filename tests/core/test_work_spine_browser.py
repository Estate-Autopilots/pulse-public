"""WORK-SPINE in the browser (services/api/test/work-spine-browser-runner.mjs): goals → projects → tasks as the owner, a
pod head and a member, at 390 and 1440, light and dark. Synthetic tenants only."""
import json
import os
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_goals import goal, link
from test_tasks_rt1 import new_task, one, team  # noqa: F401  (team is a fixture)


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_goals_projects_and_tasks_in_the_browser(worker, owner, api, team):  # noqa: F811
    """services/api/test/work-spine-browser-runner.mjs: the goal shows its projects and next tasks and finishes one in one
    click; the project's List, Board, Timeline and Calendar each show its tasks; Overview, Files and Activity; a task shows
    Goal › Project; an internal project never opens as a client package; AI-started projects sit apart. Owner, pod head
    and member, 390 and 1440, light and dark. Screenshots with PULSE_WS_SCREENSHOTS."""
    w = team
    day = lambda n: (datetime.now(ZoneInfo("Asia/Kolkata")).date() + timedelta(days=n)).isoformat()
    pid = lambda who, name: one(api, w, who, "select (pulse.work_project_save(null,%s))->>'id' id", (Jsonb({"type": "internal", "name": name}),))["id"]
    p1, p2 = pid(w.manager, "Synthetic incorporation"), pid(w.manager, "Synthetic bank account")
    one(api, w, w.manager, "select pulse.work_project_save(%s,%s)", (p1, Jsonb({"summary": "Register the synthetic company: its name, the filing and the certificate.", "dueOn": day(18)})))
    t = lambda title, **f: new_task(api, w, w.manager, title=title, projectId=str(f.pop("project", p1)), **f)
    consult = t("Consult the CA on cost", dueOn=day(-1), assigneeId=str(w.manager))
    t("Book the company web address once the name is approved, a long title that must wrap and never run out of its box on a phone", dueOn=day(11))
    spice = t("Register the company", dueOn=day(18), notes="Steps:\n1. Book the name\n2. Get the director numbers\n3. File the second form\n4. Get the certificate")
    book = t("Book the name and send the details", dueOn=day(-1), parentId=str(spice), assigneeId=str(w.editor))
    t("File the name form", dueOn=day(2), parentId=str(spice))
    t("Write the vesting terms", dueOn=day(1))
    done = t("Send the director papers", dueOn=day(-5))
    one(api, w, w.manager, "select pulse.task_move(%s,'done',null)", (done,))
    t("Open the bank account", project=p2, dueOn=day(3), assigneeId=str(w.editor))
    t("Add the second signatory", project=p2, dueOn=day(12), assigneeId=str(w.editor))
    g = goal(api, w, w.manager, "company", "Register the synthetic company", target_on=day(18))
    link(api, w, w.manager, g, project=p1)
    link(api, w, w.manager, g, project=p2)
    ai = pid(w.manager, "Synthetic Drive storage")
    t("Move the old folders", project=ai, dueOn=day(4))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.work_project set started_by='ai' where project_id=%s", (ai,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"project": str(p1), "goal": str(g), "spice": str(spice), "book": str(book), "consult": str(consult), "org": str(w.org), "editor": str(w.editor),
                                   "editorEmail": w.editor_handle, "headEmail": f"editor2@{w.domain}"})}
    p = subprocess.run(["node", "test/work-spine-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    assert "WORK-SPINE OK" in p.stdout
    # What the clicks did is in the database: two tasks finished from the goal's page, one by the owner, one by the member.
    assert one(api, w, w.manager, "select status from pulse.task where id=%s", (consult,))["status"] in ("done", "accepted", "in_review")
    assert one(api, w, w.editor, "select count(*)::int n from pulse.task where project_id=%s and status in ('done','in_review','accepted')", (p2,))["n"] == 1
