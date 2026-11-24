"""PM-BUILD-3 in the browser (services/api/test/pm-spec-browser-runner.mjs): the Mac's project-management screens on a
synthetic agency. Six client projects in the states the SPEC names (late, at risk, waiting on the client, not started,
needs setup, on track) on PM-BUILD-1's clock template, so Work → Projects shows one list of cards, and a project opens on
its next step. Phone 390, tablet 834 and laptop 1440, light and dark. Synthetic tenants and invented names only;
nothing is sent."""
import json
import os
import subprocess
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_plan_clocks_browser import TPL
from test_tasks_rt1 import new_task, one, team  # noqa: F401  (team is a fixture)

PROJECTS = [  # name, client, colour, icon, days since the invoice was paid, Day 0 after (days) or None, steps done, steps under way, late shift
    ("Skyline Residency", "Kireteso Builders", "teal", "building", 20, 6, ("O2", "O3", "O4", "O5", "O6", "O7", "O8", "P1", "P2", "P3", "P4", "C1", "C2", "C3", "L1", "N1"), ("C4", "C6", "J1")),
    ("Aranya Heights launch", "Aranya Realty", "blue", "rocket", 0, None, (), ()),
    ("Bluewater Villas", "Bluewater Homes", "pink", "sparkles", 6, None, ("O2", "O3", "O4"), ()),
    ("Cedar Court Phase 2", "Cedar Group", "green", "heart", 30, 8, ("O2", "O3", "O4", "O5", "O6", "O7", "O8", "P1", "P2", "P3", "P4", "L1"), ("C1",)),
    ("Orchid Towers", "Orchid Developers", "orange", "megaphone", 10, 7, ("O2", "O3", "O4", "O5", "O6", "O7", "O8"), ("P1",)),
]


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_pm_screens_in_the_browser(worker, owner, api, team):  # noqa: F811
    w = team
    today = one(api, w, w.lead, "select (now() at time zone pulse.org_time_zone())::date d")["d"]
    with owner.transaction():
        set_tenant(owner, w.org)
        admin = owner.execute("select holder_person_id p from pulse.account where org_id=%s and lower(handle)='admin@estateautopilots.com'", (w.org,)).fetchone()
        for pid, name in ((w.lead, "Kavya Rao"), (w.manager, "Ravi Menon"), (w.editor, "Rifob Das"), (w.editor2, "Tara Iyer")):
            owner.execute("update pulse.person set display_name=%s where id=%s", (name, pid))
    me = admin["p"] if admin and admin["p"] else w.manager
    one(api, w, w.manager, "select pulse.delivery_template_adopt('agency-test','Property launch campaign',%s,%s) r", (Jsonb(TPL), w.project))
    ids = {}
    for i, (name, client, color, icon, since, day0, done, doing) in enumerate(PROJECTS):
        pid = w.project if i == 0 else uuid.uuid4()
        cid = uuid.uuid4()
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,%s)", (cid, w.org, client))
            if i == 0:
                owner.execute("update pulse.project set name=%s,title=%s,kind='client_work',client_id=%s,lead_person_id=%s,status='active' where id=%s", (name, name, cid, me, pid))
            else:
                owner.execute("insert into pulse.project(id,org_id,registry_no,name,title,kind,client_id,lead_person_id,status) values(%s,%s,%s,%s,%s,'client_work',%s,%s,'active')",
                              (pid, w.org, w.registry_no + 10 + i, name, name, cid, me if i < 4 else w.lead))
            owner.execute("update pulse.work_project set color=%s,icon=%s,owner_id=%s where project_id=%s", (color, icon, me if i < 4 else w.lead, pid))
        one(api, w, w.manager, "select pulse.project_plan_set(%s,'agency-test','growth','competitive',%s,%s) r", (pid, today - timedelta(days=since), me if i < 4 else w.lead))
        with owner.transaction():
            set_tenant(owner, w.org)
            steps = {r["template_step"]: r["id"] for r in owner.execute("select template_step,id from pulse.task where project_id=%s and template_step is not null", (pid,)).fetchall()}
            # Every role has its person: strategy and coordination to Tara and Ravi, making to Rifob.
            owner.execute("""update pulse.task set assignee_person_id=case when template_step in ('C4','C6','C8','W3') then %s::uuid when template_step like 'P%%' or template_step like 'C%%' then %s::uuid
                else coalesce(assignee_person_id,%s::uuid) end where project_id=%s and template_step is not null""", (w.editor, w.editor2, w.manager, pid))
        lead = me if i < 4 else w.lead
        mv = lambda s, st: one(api, w, lead, "select pulse.task_move(%s,%s,null)", (steps[s], st))  # noqa: E731
        for s in done:
            if s.startswith(("O", "N")) or day0 is None:
                mv(s, "done")
        if day0 is not None:
            one(api, w, lead, "select pulse.project_day0_declare(%s,%s) r", (pid, today - timedelta(days=since) + timedelta(days=day0)))
            for s in done:
                if not s.startswith(("O", "N")):
                    mv(s, "done")
        for s in doing:
            mv(s, "in_progress")
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("update pulse.task set done_at=least(now(), due_at) where project_id=%s and status='done' and due_at is not null", (pid,))
        ids[name] = {"id": str(pid), "steps": {k: str(v) for k, v in steps.items()}}
    # Marigold Plots: a client project with no plan yet (Needs setup).
    marigold = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        cid = uuid.uuid4()
        owner.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Marigold Estates')", (cid, w.org))
        owner.execute("insert into pulse.project(id,org_id,registry_no,name,title,kind,client_id,lead_person_id,status) values(%s,%s,%s,'Marigold Plots','Marigold Plots','client_work',%s,%s,'active')",
                      (marigold, w.org, w.registry_no + 30, cid, me))
        owner.execute("update pulse.work_project set color='amber',icon='package',owner_id=%s,created_at=now() where project_id=%s", (me, marigold))
    ids["Marigold Plots"] = {"id": str(marigold), "steps": {}}
    # Workload: Rifob has three long edits due tomorrow (over 9 hours), so the page suggests moving one to someone with room.
    for title, minutes in (("Site visit reel", 360), ("Walkthrough edit", 240), ("Teaser cut", 180)):
        new_task(api, w, w.editor, title=title, projectId=ids["Orchid Towers"]["id"], estimateMinutes=minutes, dueOn=str(today + timedelta(days=2 if today.weekday() == 5 else 1)))
    # Approvals: Rifob's launch video waits for the lead's review; two creatives wait on clients (one is late).
    sky = ids["Skyline Residency"]["id"]
    vid = new_task(api, w, w.editor, title="Launch video – final cut", projectId=sky, reviewerId=str(me))
    one(api, w, w.editor, "select pulse.task_move(%s,'done',null)", (vid,))
    with owner.transaction():
        set_tenant(owner, w.org)
        for pname, title, shared, version in (("Skyline Residency", "Brochure, second draft", 5, 2), ("Bluewater Villas", "Site visit reel", 1, 1)):
            pid = ids[pname]["id"]
            cid = owner.execute("select client_id from pulse.project where id=%s", (pid,)).fetchone()["client_id"]
            owner.execute("""insert into pulse.client_deliverable(org_id,id,client_id,project_id,title,kind,owner_id,shared_by,shared_at,version,state)
                values(%s,%s,%s,%s,%s,'image',%s,%s,now()-make_interval(days=>%s),%s,'waiting')""", (w.org, uuid.uuid4(), cid, pid, title, me, me, shared, version))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), "TEST_IDS": json.dumps({"projects": ids, "org": str(w.org), "today": str(today)})}
    p = subprocess.run(["node", "test/pm-spec-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    print(p.stdout[-6000:])
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    assert "PM-SPEC OK" in p.stdout
