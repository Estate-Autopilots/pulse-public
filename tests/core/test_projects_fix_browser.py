"""PROJECTS-FIX in the browser (services/api/test/projects-fix-browser-runner.mjs): a synthetic company shaped like the
owner's own (a goal → three internal projects → their tasks, one project with about fifty tasks, subtasks, finished,
cancelled and late work). The goal's next step lands on that exact task, highlighted; an internal project opens on its
own page (what it is, its state, its progress and its tasks); List, Board, Timeline and Calendar each show the same
tasks; a long list scrolls to its last task. 1440 and 363, light and dark. Synthetic tenants only."""
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
def test_internal_project_page_and_goal_next_step(worker, owner, api, team):  # noqa: F811
    w = team
    day = lambda n: (datetime.now(ZoneInfo("Asia/Kolkata")).date() + timedelta(days=n)).isoformat()
    pid = lambda name, **f: one(api, w, w.manager, "select (pulse.work_project_save(null,%s))->>'id' id", (Jsonb({"type": "internal", "name": name, **f}),))["id"]
    move = lambda t, s: one(api, w, w.manager, "select pulse.task_move(%s,%s,null)", (t, s))

    inc = pid("Incorporate Synthetic Technologies")
    one(api, w, w.manager, "select pulse.work_project_save(%s,%s)", (inc, Jsonb({"summary": "Register the synthetic company as a private limited company: the name, the filing, the certificate and the accounts after it.", "dueOn": day(34)})))
    dev = pid("Developer accounts & registrations")
    fund = pid("Funding and startup programmes")
    side = pid("Synthetic assistant on chat meetings")

    t = lambda title, project, **f: new_task(api, w, w.manager, title=title, projectId=str(project), **f)
    # The incorporation project: the owner's shape (14 tasks: 7 finished, 3 cancelled, 2 open, 2 blocked, some subtasks).
    name = t("Choose the company name", inc, dueOn=day(-10))
    for s in ("Shortlist three names", "Check the names are free"):
        move(t(s, inc, dueOn=day(-11), parentId=str(name)), "done")
    move(name, "done")
    consult = t("Consult the CA: LLP cost, India vs abroad, investor structure", inc, dueOn=day(-6), assigneeId=str(w.manager))
    move(t("Book the company domain once the name is approved", inc, dueOn=day(6)), "not_applicable")
    move(t("Get the portal password reset with the CA", inc, dueOn=day(-9)), "done")
    move(t("Send the director papers to the owner", inc, dueOn=day(-10)), "done")
    resubmit = t("Resubmit the company name with two new choices", inc, dueOn=day(3), assigneeId=str(w.editor))
    t("Founders' meeting: sign off vesting, pricing and roles", inc, dueOn=day(3))
    agree = t("Founding customer: sign the agreement and send the first invoice", inc, dueOn=day(6))
    move(agree, "blocked")
    move(t("Write the founders' vesting terms", inc, dueOn=day(13)), "done")
    reg = t("After incorporation: company registrations and accounts", inc, dueOn=day(34),
            notes="Steps:\n1. Company PAN\n2. Company TAN\n3. Current account\n4. GST\n5. MSME registration\n6. Startup registration\n7. Business number\n8. Trademark")
    move(reg, "blocked")
    spice = t("File the incorporation form after the name is approved", inc, dueOn=day(5))
    move(t("Fill part A of the form (the name)", inc, dueOn=day(-3), parentId=str(spice)), "done")
    move(t("Get the CA to file part B", inc, dueOn=day(5), parentId=str(spice)), "cancelled")

    # Developer accounts: about fifty small tasks, few finished, many without a day, a few months apart.
    dev_ids = []
    for i in range(48):
        f = {}
        if i % 3 == 0: f["dueOn"] = day(-2 + i * 2)
        elif i % 3 == 1: f["dueOn"] = day(30 + i)
        if i % 7 == 0: f["assigneeId"] = str(w.editor)
        x = t(f"Developer account {i + 1:02d}: synthetic store listing and sign-in step", dev, **f)
        dev_ids.append(x)
        if i < 5: move(x, "done")
    for i in range(3):
        t(f"Subtask {i + 1} of developer account 07", dev, parentId=str(dev_ids[6]), dueOn=day(4 + i))
    last = t("Developer account 49: the last task in the list", dev, dueOn=day(70))

    for s, st in (("Apply to the startup programme", "done"), ("Shortlist two funds", "open"), ("Old grant idea", "cancelled"), ("Write the one-page deck", "cancelled"), ("Ask the bank about a loan", "cancelled")):
        x = t(s, fund, dueOn=day(8)); st != "open" and move(x, st)
    t("Synthetic assistant takes meeting notes", side, dueOn=day(2))

    # Finished work was finished on its due day (the seed finishes it today), so the Timeline puts it where it happened.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.task set done_at=due_at where org_id=%s and status in ('done','in_review','accepted') and due_at<now()", (w.org,))
    g = goal(api, w, w.manager, "company", "Register Synthetic Technology Pvt Ltd", target_on=day(34))
    for p in (inc, dev, fund):
        link(api, w, w.manager, g, project=p)
    for x in (resubmit, agree, reg):
        link(api, w, w.manager, g, task=x)

    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"inc": str(inc), "dev": str(dev), "fund": str(fund), "goal": str(g), "consult": str(consult), "reg": str(reg), "last": str(last),
                                   "org": str(w.org), "editorEmail": w.editor_handle})}
    p = subprocess.run(["node", "test/projects-fix-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    print(p.stdout[-6000:])
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    assert "PROJECTS-FIX OK" in p.stdout
