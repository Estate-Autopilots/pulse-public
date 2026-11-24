"""SPEED-5 (2394) on real PostgreSQL: with statistics on the attendance tables (2394 analyzes them) and an index by
entry on attendance_correction_time, pulse.attendance_effective finds each entry's latest approved time correction by
the entry, never by walking the company's approved regularisations and running their row policies for every entry read.
The rows are the view's own: a corrected entry takes its newest approved correction's times, mode and late minutes and
reads as "regularised"; a pending or rejected request changes nothing; everything else is the original record; another
company sees none of it. Every person, entry and request here is synthetic."""

import uuid

from pulse_sdk.db import set_tenant
from helpers import build_world
from test_hr_suite import _staff


def seed(owner, w, colleagues=12, days=20):
    """The shape of a real company's month (EA, Nov 2026: 171 entries, 13 requests, 4 corrections): the editor and
    colleagues with a day each, requests in every state, two corrections of the editor's (one corrected twice)."""
    out = {"entries": [], "corrected": {}}
    with owner.transaction():
        set_tenant(owner, w.org)
        people = [w.editor]
        for i in range(colleagues):
            pid = uuid.uuid4()
            owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, f"Synthetic Colleague {i}"))
            people.append(pid)
        for pid in people:
            for day in range(1, days + 1):
                entry = owner.execute("""insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,checked_out_at,mode,late_minutes)
                    values(%s,%s,%s,%s,%s,'office',0) returning id""", (w.org, pid, f"2026-10-{day:02d}", f"2026-10-{day:02d}T04:00Z", f"2026-10-{day:02d}T12:00Z")).fetchone()["id"]
                if pid == w.editor:
                    out["entries"].append(entry)

        def request(pid, entry, day, status):
            return owner.execute("""insert into pulse.attendance_regularisation(org_id,person_id,work_date,kind,reason,in_time,out_time,entry_id,status)
                values(%s,%s,%s,'missed_punch','Synthetic correction request','09:00','18:00',%s,%s) returning id""",
                                 (w.org, pid, f"2026-10-{day:02d}", entry, status)).fetchone()["id"]

        def correct(reg, entry, day, hour_in, hour_out, mode, late, created):
            owner.execute("""insert into pulse.attendance_correction_time(org_id,regularisation_id,entry_id,effective_in,effective_out,mode,late_minutes,created_at)
                values(%s,%s,%s,%s,%s,%s,%s,%s)""", (w.org, reg, entry, f"2026-10-{day:02d}T{hour_in:02d}:00Z", f"2026-10-{day:02d}T{hour_out:02d}:00Z", mode, late, created))

        e3, e5 = out["entries"][2], out["entries"][4]
        first = request(w.editor, e3, 3, "approved")
        correct(first, e3, 3, 5, 13, "office", 15, "2026-10-04T10:00Z")
        newer = request(w.editor, e3, 3, "approved")
        correct(newer, e3, 3, 6, 14, "wfh", 30, "2026-10-05T10:00Z")       # the newest approved correction wins
        wfh = request(w.editor, e5, 5, "approved")
        correct(wfh, e5, 5, 3, 11, "field", 0, "2026-10-06T10:00Z")
        request(w.editor, out["entries"][6], 7, "pending")                   # waiting: no change
        request(w.editor, out["entries"][7], 8, "rejected")                  # rejected: no change
        for i, pid in enumerate(people[1:10]):                               # other people's requests in the company
            request(pid, None, 10 + i, "approved" if i % 2 else "pending")
        out["corrected"] = {e3: ("2026-10-03 06:00:00+00", "2026-10-03 14:00:00+00", "wfh", 30),
                            e5: ("2026-10-05 03:00:00+00", "2026-10-05 11:00:00+00", "field", 0)}
    return out


MONTH = """select e.id,e.checked_in_at::text "in",e.checked_out_at::text "out",e.mode,e.late_minutes late,e.source
  from pulse.attendance_effective e where e.person_id=%s and e.work_date between '2026-10-01' and '2026-10-31' order by e.work_date"""


def test_effective_attendance_takes_the_newest_approved_correction_by_entry(worker, owner, api):
    w = build_world(worker, owner, api)
    _staff(worker, w)
    s = seed(owner, w)
    with owner.transaction():                                                # as 2394 does on a database that holds rows
        assert owner.execute("select 1 from pg_indexes where schemaname='pulse' and indexname='attendance_correction_entry'").fetchone()
        for t in ("attendance_entry", "attendance_regularisation", "attendance_correction_time", "attendance_provisional_close"):
            owner.execute(f"analyze pulse.{t}")
    for viewer in (w.editor, w.lead):                                        # the person, and HR
        with api.transaction():
            set_tenant(api, w.org, viewer)
            rows = api.execute(MONTH, (w.editor,)).fetchall()
            plan = "\n".join(r["QUERY PLAN"] for r in api.execute("explain (costs off) " + MONTH, (w.editor,)).fetchall())
        assert [r["id"] for r in rows] == s["entries"]
        for r in rows:
            if r["id"] in s["corrected"]:
                assert (r["in"], r["out"], r["mode"], r["late"], r["source"]) == (*s["corrected"][r["id"]][:4], "regularised"), r
            else:
                assert (r["in"][11:16], r["out"][11:16], r["mode"], r["late"]) == ("04:00", "12:00", "office", 0), r
                assert r["source"] != "regularised", r
        # The correction is found by its entry; a request is read only by its id, never walked with its policies.
        assert "attendance_regularisation_open" not in plan and "attendance_regularisation_person" not in plan, plan
        assert "attendance_regularisation_pkey" in plan, plan
    other = build_world(worker, owner, api)
    with api.transaction():                                                  # another company sees none of it
        set_tenant(api, other.org, other.editor)
        assert api.execute(MONTH, (w.editor,)).fetchall() == []
