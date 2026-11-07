"""UX-5A (owner, 13 Oct 2026): accepting work is one rating (no points since INTEGRITY 0910), and checking in on
a day of approved leave never cancels the leave silently (0431). Synthetic tenants only. The browser flows (the shared
drawer, every accept entry point, My desk, the Attendance tab, Ctrl+K and the layout-shift gate) run on a production
build through services/api/test/ux5a-runner.mjs."""
import json
import os
import subprocess
from datetime import date, timedelta
from pathlib import Path

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from conftest import dsn
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)

BROWSER = pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")


def move(api, w, who, task, status):
    return one(api, w, who, "select pulse.task_move(%s,%s,null) r", (task, status))["r"]


def today(api, w):
    return one(api, w, w.editor, "select (now() at time zone pulse.org_time_zone())::date d")["d"]


def leave(worker, w, person, start, end, kind="casual", days=None):
    """Approved leave, as an import writes it (no viewer, so the flow is recorded as decided)."""
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,status,days,decided_at) "
                              "values(%s,%s,%s,%s,%s,'approved',%s,now()) returning id", (w.org, person, start, end, kind, days or (end - start).days + 1)).fetchone()["id"]


def test_acceptance_credits_nothing(api, worker, team):
    """INTEGRITY (owner, 22 Oct 2026): tasks carry no value. The credit preview (0430) says nothing, and accepting a task,
    with "above and beyond" or not, writes no credit; the rating still lands on the task."""
    w = team
    valued = new_task(api, w, w.editor2, title="Cut the Lakeview teaser", assigneeId=str(w.editor))
    as_(api, w, w.editor2, "select pulse.task_value_set(%s,%s)", (valued, Jsonb({"valuePoints": 8})))
    move(api, w, w.editor, valued, "done")
    assert one(api, w, w.editor2, "select pulse.task_credit_preview(%s) p", (valued,))["p"] is None
    r = one(api, w, w.editor2, "select pulse.task_review(%s,%s) r", (valued, Jsonb({"quality": "great", "above": True})))["r"]
    assert r["status"] == "accepted" and r["points"] is None
    assert one(api, w, w.editor, "select review_quality q,review_above a,value_points v from pulse.task where id=%s", (valued,)) == {"q": 5, "a": True, "v": None}
    assert one(api, w, w.editor, "select count(*) n from pulse.work_credit where task_id=%s", (valued,))["n"] == 0


def test_cancelling_todays_leave_keeps_the_other_days(api, worker, team):
    """One tap cancels only today's day of approved leave: a one-day leave is cancelled, a longer one moves its first or
    last day, and a leave around today becomes two (the later part stays approved). HR is told. Nobody else's leave, and
    never another day."""
    w = team
    t = today(api, w)
    one_day = leave(worker, w, w.editor, t, t)
    r = one(api, w, w.editor, "select pulse.leave_cancel_day(%s,%s,0,0) r", (one_day, t))["r"]
    assert r["leaveId"] == str(one_day) and r["rest"] is None
    row = one(api, w, w.editor, "select status,decision_note from pulse.leave_request where id=%s", (one_day,))
    assert row["status"] == "cancelled" and "checked in to work" in row["decision_note"]
    with worker.transaction():
        set_tenant(worker, w.org)
        told = worker.execute("select person_id,title from pulse.notification where title like %s", ("%checked in on approved leave%",)).fetchall()
    assert {n["person_id"] for n in told} >= {w.lead} and all("Editor One" in n["title"] for n in told)
    # Around today: two approved parts, today gone.
    around = leave(worker, w, w.editor2, t - timedelta(days=2), t + timedelta(days=2), days=5)
    r = one(api, w, w.editor2, "select pulse.leave_cancel_day(%s,%s,2,2) r", (around, t))["r"]
    parts = as_(api, w, w.editor2, "select from_date,to_date,days::float d,status from pulse.leave_request where person_id=%s and status='approved' order by from_date", (w.editor2,))
    assert [(p["from_date"], p["to_date"], p["d"]) for p in parts] == [(t - timedelta(days=2), t - timedelta(days=1), 2.0), (t + timedelta(days=1), t + timedelta(days=2), 2.0)]
    assert r["rest"] is not None
    # Someone else's leave, another day, or a leave already over: refused.
    other = leave(worker, w, w.lead, t, t + timedelta(days=1))
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.editor, "select pulse.leave_cancel_day(%s,%s,0,1)", (other, t))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="today"):
        as_(api, w, w.lead, "select pulse.leave_cancel_day(%s,%s,1,0)", (other, t + timedelta(days=1)))
    # The first day of a longer leave: it starts tomorrow instead.
    r = one(api, w, w.lead, "select pulse.leave_cancel_day(%s,%s,0,1) r", (other, t))["r"]
    assert one(api, w, w.lead, "select from_date,days::float d,status from pulse.leave_request where id=%s", (other,)) == {"from_date": t + timedelta(days=1), "d": 1.0, "status": "approved"}
    # Only whole days: a half day stays as it is.
    with worker.transaction():
        set_tenant(worker, w.org)
        half = worker.execute("insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,status,days,half_day) values(%s,%s,%s,%s,'casual','approved',0.5,'first') returning id",
                              (w.org, w.manager, t, t)).fetchone()["id"]
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="whole day"):
        as_(api, w, w.manager, "select pulse.leave_cancel_day(%s,%s,0,0)", (half, t))


def test_leave_overlap_rows_are_the_persons_and_their_managers(api, worker, team):
    """The record of a check-in on leave is read by the person, their managers, HR and leadership, never by a colleague."""
    w = team
    t = today(api, w)
    lv = leave(worker, w, w.editor, t, t)
    as_(api, w, w.editor, "insert into pulse.attendance_leave_overlap(org_id,person_id,leave_id,work_date,decision,leave_kind) values(%s,%s,%s,%s,'kept','casual') returning id", (w.org, w.editor, lv, t))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "insert into pulse.attendance_leave_overlap(org_id,person_id,leave_id,work_date,decision) values(%s,%s,%s,%s,'kept') returning id", (w.org, w.editor, lv, t - timedelta(days=1)))
    count = "select count(*)::int n from pulse.attendance_leave_overlap where person_id=%s"
    assert one(api, w, w.editor, count, (w.editor,))["n"] == 1
    assert one(api, w, w.lead, count, (w.editor,))["n"] == 1
    assert one(api, w, w.outsider, count, (w.editor,))["n"] == 0


@BROWSER
def test_ux5a_flows_in_the_browser(worker, owner, api, team, tmp_path):
    """The flows on a production build with the synthetic agency (services/api/test/ux5a-runner.mjs)."""
    from test_tasks3 import _config, _seed_tasks3
    w = team
    ids = _seed_tasks3(api, worker, w)
    with owner.transaction():
        set_tenant(owner, w.org)
        # Every day is a working day here, so the attendance flows run on any weekday (Sunday included).
        owner.execute("insert into pulse.hr_policy(org_id,attendance_enabled,work_days) values(%s,true,'{1,2,3,4,5,6,7}') "
                      "on conflict (org_id) do update set attendance_enabled=true,work_days='{1,2,3,4,5,6,7}'", (w.org,))
        owner.execute("insert into pulse.presence_office(org_id,name,lat,lng,radius_m,active) values(%s,'Main office (synthetic)',18.52,73.85,120,true)", (w.org,))
    with worker.transaction():
        set_tenant(worker, w.org)
        office = worker.execute("insert into pulse.person(org_id,display_name,side) values(%s,'Omoza Office','staff') returning id", (w.org,)).fetchone()["id"]
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username,pod) values(%s,%s,'Office manager','test',78,'omoza78','Pod 1')", (w.org, office))
    wifi = new_task(api, w, w.lead, title="Send HR the office Wi-Fi name and the office public IP", assigneeId=str(w.editor2))
    ids = {**ids, "wifi": str(wifi), "office": str(office), "today": str(today(api, w))}
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": _config(dsn("api")), "TEST_MEMBER": w.editor_handle,
           "TEST_HEAD": f"editor2@{w.domain}", "TEST_OUTSIDER_EMAIL": f"outsider@{w.domain}", "TEST_IDS": json.dumps(ids), "PULSE_UX5A_REPORT": str(tmp_path / "ux5a.json")}
    p = subprocess.run(["node", "test/ux5a-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=2400, check=False)
    report = json.loads((tmp_path / "ux5a.json").read_text()) if (tmp_path / "ux5a.json").exists() else None
    print(p.stdout[-8000:])
    assert p.returncode == 0 and report and not report["failed"], (p.stderr + p.stdout)[-8000:]
