"""PM-BUILD-4 phase 3 in the browser (services/api/test/pm-chat-board-browser-runner.mjs): the step card under the
viewer's own message in a project's group ("M1 first draft done" → "Move “Make the first set” to First draft?"), My day's
"Your assistant · Quick check for today" (phase 4) and "From your chats", and the project page's "We need from the client" with a drafted request the lead sends themselves.
Phone 390, tablet 834, laptop 1440, light and dark. Synthetic tenant and invented names only; nothing is sent."""
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
from test_pm_chat_board import TPL2
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_pm_chat_board_in_the_browser(worker, owner, api, team):  # noqa: F811
    w = team
    today = one(api, w, w.lead, "select (now() at time zone pulse.org_time_zone())::date d")["d"]
    with owner.transaction():
        set_tenant(owner, w.org)
        admin = owner.execute("select holder_person_id p from pulse.account where org_id=%s and lower(handle)='admin@estateautopilots.com'", (w.org,)).fetchone()
        for pid, name in ((w.lead, "Kavya Rao"), (w.manager, "Ravi Menon"), (w.editor, "Rifob Das"), (w.editor2, "Tara Iyer")):
            owner.execute("update pulse.person set display_name=%s where id=%s", (name, pid))
        cid = uuid.uuid4()
        owner.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Orchid Realty')", (cid, w.org))
    me = admin["p"] if admin and admin["p"] else w.manager
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.project set name='Orchid Towers launch',title='Orchid Towers launch',kind='client_work',client_id=%s,lead_person_id=%s,status='active' where id=%s", (cid, me, w.project))
        owner.execute("update pulse.work_project set color='teal',icon='building',owner_id=%s where project_id=%s", (me, w.project))
    one(api, w, w.manager, "select pulse.delivery_template_adopt('chat-test','Property launch',%s,%s) r", (Jsonb(TPL2), w.project))
    one(api, w, me, "select pulse.project_plan_set(%s,'chat-test','full','big',%s,%s) r", (w.project, today - timedelta(days=1), me))
    with owner.transaction():
        set_tenant(owner, w.org)
        steps = {r["template_step"]: r["id"] for r in owner.execute("select template_step,id from pulse.task where project_id=%s and template_step is not null", (w.project,)).fetchall()}
        owner.execute("update pulse.task set assignee_person_id=%s,owner_id=%s where id = any(%s)", (me, me, [steps[k] for k in ("M1", "M2", "I2", "P1", "P2")]))
        owner.execute("update pulse.task set assignee_person_id=%s where id=%s", (w.editor, steps["S1"]))
    group = one(api, w, me, "select pulse.chat_group_create('Orchid Towers · team',%s) id", ([w.editor, w.editor2],))["id"]
    one(api, w, me, "select pulse.project_chat_link(%s,%s,true) r", (w.project, group))
    say = lambda who, text: one(api, w, who, "select pulse.chat_send(%s,%s,null,'[]',%s,null) id", (group, text, uuid.uuid4()))["id"]  # noqa: E731
    say(w.editor, "Moodboard is up in the folder")
    say(me, "M1 first draft done, sharing in a bit")
    say(w.editor2, "Looks good, will review today")
    # A back-fill card: the viewer finishes P2 while their P1 (which P2 waits on) is still open.
    one(api, w, me, "select pulse.task_move(%s,'done',null)", (steps["P2"],))
    # Phase 4: the viewer works on I2 today; the end-of-day check (17:30 in the company's time) asks about it.
    one(api, w, me, "select pulse.task_move(%s,'in_progress',null)", (steps["I2"],))
    made = one(api, w, me, "select pulse.pm_checkins_run(((now() at time zone pulse.org_time_zone())::date + time '17:30') at time zone pulse.org_time_zone()) n")["n"]
    assert made >= 1, made
    # Phase 6: Day 0 moved for the client's delay, and the viewer's own load benchmark (the walk's "Mark as asked" makes the wait).
    one(api, w, me, "select pulse.project_clock_move(%s,'day0',%s,'client_delay','Floor plans came late',true) r", (w.project, today + timedelta(days=4)))
    one(api, w, me, "select pulse.load_benchmark_set(%s,0.5,1,2,null) r", (me,))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"project": str(w.project), "group": str(group), "org": str(w.org), "today": str(today), "steps": {k: str(v) for k, v in steps.items()}})}
    p = subprocess.run(["node", "test/pm-chat-board-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    print(p.stdout[-6000:])
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    assert "PM-CHAT OK" in p.stdout
