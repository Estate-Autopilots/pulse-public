"""PM-BUILD-3 (22 Nov 2026; the Mac's SPEC v1.1, migration 2510): a clock has a planned day as well as the day it
happened, every plan step keeps its first due date, and a person moves a clock with a preview ("N steps move +3 days"),
a reason, a log and one notice per owner. A clock that happened moves the dates no person changed; one that has not
moves planned dates, and the clock after it. Never an AI. Synthetic tenants only; nothing is sent."""
from datetime import timedelta

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_plan_clocks import ai, laid_out, move, org_today, steps
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def clock_day(api, w, clock):
    return one(api, w, w.lead, "select pulse.plan_clock_day(%s,%s) d", (w.project, clock))["d"]


def clock_move(api, w, who, clock, on, reason="client_delay", apply=False, note=None):
    return one(api, w, who, "select pulse.project_clock_move(%s,%s,%s,%s,%s,%s) r", (w.project, clock, on, reason, note, apply))["r"]


def test_a_planned_clock_moves_with_a_preview_a_reason_and_one_notice(api, worker, owner, team):
    w = team
    today = org_today(api, w)
    kickoff = today - timedelta(days=1)
    s = laid_out(api, w, kickoff)
    # Day 0 has not happened: its planned day is its gate step's date (start + 3), going live counts on from it.
    assert clock_day(api, w, "day0") == kickoff + timedelta(days=3)
    assert clock_day(api, w, "live") == kickoff + timedelta(days=11)
    # Steps dated when laid out keep that first date as their baseline; Day-0 steps have no date (planned only).
    row = one(api, w, w.lead, "select baseline_due_at=due_at same, due_at is not null dated from pulse.task where id=%s", (s["G1"]["id"],))
    assert row == {"same": True, "dated": True}
    assert s["M1"]["due"] is None
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.task set assignee_person_id=%s where id=%s", (w.editor, s["M1"]["id"]))
    # The preview writes nothing and lists what moves: Day-0 steps and the steps of going live, +3 days each.
    p = clock_move(api, w, w.lead, "day0", kickoff + timedelta(days=6))
    assert p["applied"] is False and p["days"] == 3 and p["happened"] is False
    codes = {m["code"]: m for m in p["moves"]}
    assert {"M1", "G2"} <= set(codes) and "G1" not in codes and "I1" not in codes
    assert codes["M1"]["from"] == str(kickoff + timedelta(days=3 + 5)) and codes["M1"]["to"] == str(kickoff + timedelta(days=3 + 5 + 3))
    assert p["later"][0]["clock"] == "live" and p["later"][0]["to"] == str(kickoff + timedelta(days=14))
    assert clock_day(api, w, "day0") == kickoff + timedelta(days=3)
    # Applying needs a reason; only the project's runners move it, and never an AI.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Choose why the dates change"):
        clock_move(api, w, w.lead, "day0", kickoff + timedelta(days=6), reason="", apply=True)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        clock_move(api, w, w.editor, "day0", kickoff + timedelta(days=6), apply=True)
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only a person"):
        ai(api, w, w.lead, "select pulse.project_clock_move(%s,'day0',%s,'client_delay',null,true)", (w.project, kickoff + timedelta(days=6)))
    r = clock_move(api, w, w.lead, "day0", kickoff + timedelta(days=6), apply=True, note="Floor plans came late")
    assert r["applied"] is True and r["days"] == 3 and r["steps"] == p["steps"] and r["told"] == 1
    assert clock_day(api, w, "day0") == kickoff + timedelta(days=6) and clock_day(api, w, "live") == kickoff + timedelta(days=14)
    after = steps(api, w)
    assert after["G1"]["due"] == kickoff + timedelta(days=6) and after["M1"]["due"] is None  # the gate moved; Day-0 steps stay planned
    log = one(api, w, w.lead, "select task_id,from_due,to_due,reason_kind,cardinality(moved) n,note from pulse.project_date_change where project_id=%s order by changed_at desc limit 1", (w.project,))
    assert log["task_id"] == s["G1"]["id"] and log["from_due"] == kickoff + timedelta(days=3) and log["to_due"] == kickoff + timedelta(days=6)
    assert log["reason_kind"] == "client_delay" and log["n"] == r["steps"] and "Floor plans came late" in log["note"]
    with worker.transaction():
        set_tenant(worker, w.org)
        told = worker.execute("select title,href from pulse.notification where person_id=%s and event_type='task.due_soon' and title like 'Ready moved%%'", (w.editor,)).fetchall()
    assert len(told) == 1 and "1 of your steps moves +3 days" in told[0]["title"] and told[0]["href"] == f"/tasks/projects/{w.project}"
    # The same day again moves nothing.
    assert clock_move(api, w, w.lead, "day0", kickoff + timedelta(days=6), apply=True)["applied"] is False


def test_a_clock_that_happened_moves_only_the_dates_nobody_changed(api, worker, team):
    w = team
    today = org_today(api, w)
    kickoff = today - timedelta(days=5)
    s = laid_out(api, w, kickoff)
    for step in ("I1", "I2"):
        move(api, w, w.lead, s[step]["id"], "done")
    one(api, w, w.lead, "select pulse.project_day0_declare(%s,%s) r", (w.project, today))
    s = steps(api, w)
    assert s["M1"]["due"] == today + timedelta(days=5)
    first = one(api, w, w.lead, "select baseline_due_at from pulse.task where id=%s", (s["M1"]["id"],))["baseline_due_at"]
    # A person moved G2 on its own: it keeps its date when Day 0 moves.
    one(api, w, w.lead, "select pulse.project_reschedule(%s,null,%s,'our_delay',null,false) r", (s["G2"]["id"], today + timedelta(days=12)))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="in the future"):
        clock_move(api, w, w.lead, "day0", today + timedelta(days=1), apply=True)
    r = clock_move(api, w, w.lead, "day0", today - timedelta(days=2), reason="our_delay", apply=True)
    assert r["happened"] is True and r["days"] == -2
    after = steps(api, w)
    assert after["M1"]["due"] == today + timedelta(days=3)
    assert after["G2"]["due"] == today + timedelta(days=12)
    assert one(api, w, w.lead, "select day0_on from pulse.project_plan where project_id=%s", (w.project,))["day0_on"] == today - timedelta(days=2)
    # The first due date stays the baseline, so the slip can be read.
    assert one(api, w, w.lead, "select baseline_due_at from pulse.task where id=%s", (s["M1"]["id"],))["baseline_due_at"] == first


def test_the_weekly_update_is_posted_by_a_person_who_runs_the_project(api, worker, team):
    """2511 (the Mac's screen 13): a project's weekly update is a project comment of kind 'update'; only a person posts it,
    only who runs the project; calling it better than the system needs a reason; the newest one is read per project."""
    w = team
    today = org_today(api, w)
    laid_out(api, w, today - timedelta(days=1))
    post = lambda who, body, health, system=None, reason=None: one(api, w, who, "select pulse.project_update_post(%s,%s,%s,%s,%s) id", (w.project, body, health, system, reason))  # noqa: E731
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only a person"):
        ai(api, w, w.lead, "select pulse.project_update_post(%s,'Done this week: the brief','on_track',null,null)", (w.project,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        post(w.editor, "Done this week: the brief", "on_track")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="better than the system"):
        post(w.lead, "Done this week: the brief", "on_track", "at_risk")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="how the project is doing"):
        post(w.lead, "Done this week: the brief", "great")
    first = post(w.lead, "Done this week\n• Brief received", "late", "at_risk")["id"]   # worse than the system: no reason needed
    second = post(w.lead, "Done this week\n• Access granted", "on_track", "at_risk", "The client sent the plans this morning")["id"]
    rows = as_(api, w, w.lead, "select id,kind,meta from pulse.work_comment where project_id=%s and kind='update' order by created_at", (w.project,))
    assert [r["id"] for r in rows] == [first, second]
    assert rows[1]["meta"]["health"] == "on_track" and rows[1]["meta"]["system"] == "at_risk" and rows[1]["meta"]["reason"].startswith("The client")
    last = one(api, w, w.editor, "select * from pulse.project_updates_last(%s)", ([w.project],))
    assert last["health"] == "on_track" and last["by_name"]
