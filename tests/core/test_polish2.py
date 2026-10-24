"""POLISH-2 (QA-E2E P1-5), as ATT (0861) changed it: a forgotten check-out is never asked about; Pulse checks out at
the moment it saw the person leave, else at the shift's end after the grace time, marks it automatic and shows HR
what it could not see. The morning hold for review stays as the safety net. Synthetic tenant, people and times only."""
import uuid

import pytest
from helpers import build_world
from pulse_sdk.db import set_tenant


def _enable_attendance(owner, w):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("select pulse.hr_defaults()")
        owner.execute("update pulse.hr_policy set attendance_enabled=true,shift_start='10:00',shift_end='19:00',work_days='{1,2,3,4,5,6,7}' where org_id=%s", (w.org,))


def _at(worker, w, days, clock):
    """An instant on the company's clock: `days` from today at HH:MM."""
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select ((now() at time zone pulse.org_time_zone(%s))::date+%s+%s::time) at time zone pulse.org_time_zone(%s) t",
                              (w.org, days, clock, w.org)).fetchone()["t"]


def _open(owner, w, person, days, clock):
    entry = uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("""insert into pulse.attendance_entry(id,org_id,person_id,work_date,mode,checked_in_at,late_minutes)
                          values(%s,%s,%s,(now() at time zone pulse.org_time_zone(%s))::date+%s,'office',
                          ((now() at time zone pulse.org_time_zone(%s))::date+%s+%s::time) at time zone pulse.org_time_zone(%s),0)""",
                       (entry, w.org, person, w.org, days, w.org, days, clock, w.org))
    return entry


def _tick(worker, w, at):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select pulse.attendance_forgotten_tick(%s) n", (at,)).fetchone()["n"]


def _rows(worker, w, sql, args=()):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute(sql, args).fetchall()


def test_forgotten_check_out_is_asked_then_closed_for_review(worker, owner, api):
    """ATT (0861) replaces POLISH-2's evening question: a session with no presence signal is checked out at the shift's
    end once the grace time has passed (marked automatic, an exception for HR), one Pulse saw leave is checked out at
    the moment it left, and nobody is asked "Still checked in?"."""
    w = build_world(worker, owner, api)
    _enable_attendance(owner, w)
    forgot = _open(owner, w, w.editor, -1, "10:02")          # yesterday 10:02, never checked out (shift 10–19)
    late = _open(owner, w, w.editor2, -1, "20:30")           # yesterday 20:30, after the shift
    seen = _open(owner, w, w.lead, -1, "09:50")              # yesterday; Pulse last saw them at the office at 18:40
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("""insert into pulse.attendance_presence_state(org_id,person_id,entry_id,work_date,first_confident_at,last_confident_at)
                         values(%s,%s,%s,(now() at time zone pulse.org_time_zone(%s))::date-1,%s,%s)""",
                      (w.org, w.lead, seen, w.org, _at(worker, w, -1, "09:50"), _at(worker, w, -1, "18:40")))
    notes = lambda person, kind: _rows(worker, w, "select title,href,event_key from pulse.notification where person_id=%s and event_type=%s order by created_at", (person, kind))
    out = lambda entry: _rows(worker, w, "select to_char(checked_out_at at time zone pulse.org_time_zone(org_id),'HH24:MI') t,out_client from pulse.attendance_entry where id=%s", (entry,))[0]

    # 19:30: inside the grace time, nothing yet, and no question.
    assert _tick(worker, w, _at(worker, w, -1, "19:30")) == 0
    assert out(forgot)["t"] is None and notes(w.editor, "attendance.checkout") == []
    # 20:30: out at the shift's end (no signal at all), out when Pulse saw them leave (18:40).
    _tick(worker, w, _at(worker, w, -1, "20:30")); _tick(worker, w, _at(worker, w, -1, "21:30"))
    assert out(forgot)["t"] == "19:00" and out(forgot)["out_client"]["reason"] == "shift_end" and out(forgot)["out_client"]["via"] == "auto"
    assert out(seen)["t"] == "18:40" and out(seen)["out_client"]["reason"] == "left"
    assert out(late)["t"] is None, "a check-in after the shift has four hours of work and the grace before Pulse closes it"
    assert notes(w.editor, "attendance.checkout") == [], "nobody is asked whether they checked out"
    told = notes(w.editor, "attendance.auto")
    assert len(told) == 1 and told[0]["title"] == "Checked out at 19:00, at the end of your shift. Left at another time? Tell us." and told[0]["href"] == f"/me?checkout={forgot}"
    assert notes(w.lead, "attendance.auto")[0]["title"].startswith("Checked out at 18:40, when you left")
    # The next night: the late session closes an hour after its check-in, for HR to check.
    _tick(worker, w, _at(worker, w, 0, "02:00"))
    assert out(late)["t"] == "21:30" and out(late)["out_client"]["confidence"] < 60
    # The morning safety net has nothing left to hold for review.
    assert _tick(worker, w, _at(worker, w, 0, "07:05")) == 0
    exceptions = {r["entry_id"]: r for r in _rows(worker, w, "select entry_id,kind,resolved_at from pulse.attendance_exception")}
    assert set(exceptions) == {forgot, late}, "HR checks the two Pulse could not see; the one it saw leave is settled"
    assert all(x["kind"] == "missing_checkout" and x["resolved_at"] is None for x in exceptions.values())
    assert _rows(worker, w, "select 1 from pulse.attendance_correction_time where entry_id=any(%s)", ([forgot, late, seen],)) == [], "no correction invented"
    assert _rows(worker, w, "select 1 from pulse.attendance_provisional_close") == []
    # Today starts fresh: a new check-in is allowed.
    _open(owner, w, w.editor, 0, "09:58")


def test_forgotten_tick_is_the_workers_and_follows_hr(worker, owner, api):
    w = build_world(worker, owner, api)
    with pytest.raises(Exception, match="permission denied|Worker scope required"):
        with api.transaction():
            set_tenant(api, w.org, w.editor)
            api.execute("select pulse.attendance_forgotten_tick()")
    # Attendance off: nothing is asked or closed.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("select pulse.hr_defaults()")
    _open(owner, w, w.editor, -2, "10:00")
    assert _tick(worker, w, _at(worker, w, 0, "12:00")) == 0
    assert _rows(worker, w, "select 1 from pulse.attendance_provisional_close") == []


def test_a_session_left_open_for_days_is_told_once_that_it_was_closed(worker, owner, api):
    """RELEASE-5 (0434), with ATT's engine: on the first tick after a release, a session left open days ago is checked
    out at that day's shift end (no signal), its person is told once, and HR sees it as an exception."""
    w = build_world(worker, owner, api)
    _enable_attendance(owner, w)
    old = _open(owner, w, w.editor, -3, "10:05")
    _tick(worker, w, _at(worker, w, 0, "11:00")); _tick(worker, w, _at(worker, w, 0, "11:30"))
    told = _rows(worker, w, "select title,event_key,event_type from pulse.notification where person_id=%s and event_type like 'attendance.%%'", (w.editor,))
    assert [n["event_key"] for n in told] == [f"out:{old}"] and told[0]["title"].startswith("Checked out at 19:00")
    assert _rows(worker, w, "select kind from pulse.attendance_exception where entry_id=%s", (old,)) == [{"kind": "missing_checkout"}]
