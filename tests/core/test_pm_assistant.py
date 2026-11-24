"""PM-BUILD-4 (KAZUK-PM-2 phase 4, migration 2521): each person's assistant asks about their own steps by rules, with a
budget, and never marks anything done. At once when someone else's step waits on a late one ("Waiting on you"); once at
the end of the day for at most 3 steps they worked on today or that are late and quiet; "Stop checking on me" stops the
end-of-day check until one of their steps goes stale, never the "someone is waiting" one. Only the person answers
(Done goes through task_move). Synthetic tenants only; nothing is sent outside Pulse."""
import pytest
import psycopg
from pulse_sdk.db import set_tenant
from test_plan_clocks import ai, steps
from test_pm_chat_board import answer, cards, plan
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)

AT = "((now() at time zone pulse.org_time_zone())::date + time '{t}') at time zone pulse.org_time_zone()"


def run(api, w, t):
    return one(api, w, w.lead, f"select pulse.pm_checkins_run({AT.format(t=t)}) n")["n"]


def set_task(owner, w, task, due_days=None, touched_days=None):
    with owner.transaction():
        set_tenant(owner, w.org)
        if due_days is not None:
            owner.execute("update pulse.task set due_at=(((now() at time zone pulse.org_time_zone())::date + %s) + time '12:00') at time zone pulse.org_time_zone() where id=%s", (due_days, task))
        if touched_days is not None:
            owner.execute("update pulse.task set updated_at=now() - make_interval(days=>%s) where id=%s", (touched_days, task))


def notices(worker, w, person, like):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select title,href from pulse.notification where person_id=%s and title like %s", (person, like)).fetchall()


def checkins(api, w, who):
    return [c for c in cards(api, w, who) if c["kind"] == "checkin" and c["state"] == "open"]


def test_someone_waiting_asks_at_once_the_day_check_once_and_only_a_person_answers(api, owner, worker, team):
    w = team
    s, _ = plan(api, owner, w)
    # I2 (Rifob's) is 6 days late and quiet; the lead's gate G1 waits on it.
    set_task(owner, w, s["I2"]["id"], due_days=-6, touched_days=3)
    set_task(owner, w, s["M1"]["id"], touched_days=3)
    set_task(owner, w, s["I1"]["id"], due_days=-6, touched_days=3)  # the client's input: never asked about
    one(api, w, w.editor, "select pulse.task_move(%s,'in_progress',null)", (s["M2"]["id"],))  # Rifob works on M2 today
    assert run(api, w, "10:00") == 1
    c = checkins(api, w, w.editor)
    assert len(c) == 1 and c[0]["candidates"][0]["code"] == "I2" and c[0]["quote"].startswith("Waiting on you:"), c
    assert len(notices(worker, w, w.editor, "%is waiting on%")) == 1
    assert run(api, w, "10:10") == 0, "asked once a day"
    assert checkins(api, w, w.lead) == []
    # Before 17:00 there is no end-of-day check.
    assert one(api, w, w.editor, "select count(*)::int n from pulse.assistant_check")["n"] == 0
    # "Stop checking on me": a step more than 3 working days late ends the quiet at the next run.
    one(api, w, w.editor, "select pulse.assistant_quiet_set(true)")
    assert one(api, w, w.editor, "select pulse.assistant_state() s")["s"]["quiet"] is True
    assert len(checkins(api, w, w.editor)) == 1, "someone waiting still asks"
    run(api, w, "10:20")
    st = one(api, w, w.editor, "select pulse.assistant_state() s")["s"]
    assert st["quiet"] is False and "late" in st["endedWhy"]
    # End of day: M2 (worked on today) once; I2 already has its card; M1 is neither late nor touched; I1 is the client's.
    assert run(api, w, "17:30") == 1
    c = {x["candidates"][0]["code"]: x for x in checkins(api, w, w.editor)}
    assert set(c) == {"I2", "M2"} and c["M2"]["quote"] == "You worked on it today"
    assert one(api, w, w.editor, "select asked,answered from pulse.assistant_check") == {"asked": 1, "answered": 0}
    assert [n["title"] for n in notices(worker, w, w.editor, "Quick check%")] == ["Quick check for today: 1 step"]
    assert run(api, w, "17:45") == 0, "one end-of-day check a day"
    # Only a person answers; Done goes through task_move.
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only a person"):
        ai(api, w, w.editor, "select pulse.pm_step_card_answer(%s,'yes',null)", (c["M2"]["id"],))
    answer(api, w, w.editor, c["M2"]["id"], "yes")
    assert steps(api, w)["M2"]["status"] == "done"
    assert one(api, w, w.editor, "select asked,answered from pulse.assistant_check") == {"asked": 1, "answered": 1}
    answer(api, w, w.editor, c["I2"]["id"], "no")
    assert steps(api, w)["I2"]["status"] != "done"
    # Nobody else sees another person's check-ins.
    assert one(api, w, w.lead, "select count(*)::int n from pulse.assistant_check")["n"] == 0


def test_stop_checking_on_me_holds_the_day_check_until_a_step_goes_stale(api, owner, worker, team):
    w = team
    s, _ = plan(api, owner, w)
    set_task(owner, w, s["M2"]["id"], due_days=-1)  # 1 working day late at most: not stale
    one(api, w, w.editor, "select pulse.task_move(%s,'in_progress',null)", (s["M2"]["id"],))
    one(api, w, w.editor, "select pulse.assistant_quiet_set(true)")
    assert run(api, w, "17:30") == 0
    assert checkins(api, w, w.editor) == []
    assert one(api, w, w.editor, "select pulse.assistant_state() s")["s"]["quiet"] is True
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only a person"):
        ai(api, w, w.editor, "select pulse.assistant_quiet_set(false)")
    one(api, w, w.editor, "select pulse.assistant_quiet_set(false)")
    assert run(api, w, "17:40") == 1
    assert [x["candidates"][0]["code"] for x in checkins(api, w, w.editor)] == ["M2"]
