"""KAZUK-REST slice 6 (1713): the leave and work-from-home SOP with a fallback (the colleague who covers is asked,
accepts or declines; a decline or no answer goes to the manager and HR, who name someone else), and HR's view of who
has and has not acknowledged a published policy, with reminders. Synthetic companies, people and policy text only."""
import json
import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from helpers import build_world
from psycopg.conninfo import conninfo_to_dict
from pulse_sdk.db import set_tenant
from test_erp_invoice import as_, one, person

API = Path(__file__).resolve().parents[2] / "services/api"
SOP = ("# Synthetic leave and WFH SOP\n\nThis is invented text for tests.\n\n## Cover\n\nName a colleague who covers your work. "
       "They answer within the company's hours; if they cannot, your manager and HR name someone else.")


def owner_sql(owner, w, sql, args=()):
    with owner.transaction():
        set_tenant(owner, w.org)
        return owner.execute(sql, args)


@pytest.fixture
def team(worker, owner, api):
    w = build_world(worker, owner, api)
    w.hr = person(worker, w, "Synthetic HR", "hr")
    w.mgr = person(worker, w, "Synthetic Manager")
    w.alice, w.bob, w.carol = (person(worker, w, n) for n in ("Synthetic Alice", "Synthetic Bob", "Synthetic Carol"))
    with worker.transaction():
        set_tenant(worker, w.org)
        for p, u in ((w.alice, "synthetic.alice"), (w.bob, "synthetic.bob"), (w.carol, "synthetic.carol"), (w.mgr, "synthetic.mgr"), (w.hr, "synthetic.hr")):
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,username,evidence,manager_id) values(%s,%s,'Editor',%s,'{}',%s)",
                           (w.org, p, u, w.mgr if p == w.alice else None))
    return w


def leave(worker, w, who, start=10, end=12, status="pending"):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("""insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,status,days,reason)
            values(%s,%s,current_date+%s,current_date+%s,'annual',%s,%s,'Synthetic trip') returning id""",
                              (w.org, who, start, end, status, end - start + 1)).fetchone()["id"]


def wfh(worker, w, who, day=5):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("""insert into pulse.attendance_regularisation(org_id,person_id,work_date,kind,reason,status)
            values(%s,%s,current_date+%s,'wfh','Synthetic plumber visit at home','pending') returning id""", (w.org, who, day)).fetchone()["id"]


def notices(owner, w, who, like):
    return owner_sql(owner, w, "select title, href from pulse.notification where person_id=%s and title like %s order by created_at", (who, like)).fetchall()


def test_a_cover_is_asked_answered_and_goes_up_when_declined(api, worker, owner, team):
    w = team
    lr = leave(worker, w, w.alice)
    cid = one(api, w, w.alice, "select pulse.leave_cover_ask('leave', %s, %s, 'Synthetic handover notes') id", (lr, w.bob))["id"]
    assert [n["href"] for n in notices(owner, w, w.bob, "Can you cover for Synthetic Alice%")] == ["/cover"]
    # Who reads it: Alice, Bob, Alice's manager and HR; not Carol.
    for who, sees in ((w.alice, 1), (w.bob, 1), (w.mgr, 1), (w.hr, 1), (w.carol, 0)):
        assert one(api, w, who, "select count(*)::int n from pulse.leave_cover")["n"] == sees, who
    # Only Bob answers (to anyone else the ask does not exist); a decline needs a reason, then goes up to the manager and HR.
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, w, w.carol, "select pulse.leave_cover_answer(%s, true, null)", (cid,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.bob, "select pulse.leave_cover_answer(%s, false, '')", (cid,))
    assert one(api, w, w.bob, "select pulse.leave_cover_answer(%s, false, 'Synthetic client shoot that week') s", (cid,))["s"] == "escalated"
    row = one(api, w, w.hr, "select status, escalated_why from pulse.leave_cover where id=%s", (cid,))
    assert (row["status"], row["escalated_why"]) == ("escalated", "declined")
    assert notices(owner, w, w.mgr, "Synthetic Alice needs someone to cover%") and notices(owner, w, w.hr, "Synthetic Alice needs someone to cover%")
    # HR names someone else; the first ask is closed, Carol accepts and Alice is told.
    c2 = one(api, w, w.hr, "select pulse.leave_cover_ask('leave', %s, %s, null) id", (lr, w.carol))["id"]
    assert one(api, w, w.hr, "select status from pulse.leave_cover where id=%s", (cid,))["status"] == "cancelled"
    assert one(api, w, w.carol, "select pulse.leave_cover_answer(%s, true, null) s", (c2,))["s"] == "accepted"
    assert notices(owner, w, w.alice, "Synthetic Carol accepted your cover")
    # A colleague cannot name a cover for someone else's leave.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.bob, "select pulse.leave_cover_ask('leave', %s, %s, null)", (lr, w.carol))
    # Rows arrive only through the functions.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.alice, "insert into pulse.leave_cover(org_id,kind,source_id,person_id,cover_id,from_date,to_date,respond_by) values(%s,'leave',%s,%s,%s,current_date,current_date,now())",
            (w.org, lr, w.alice, w.bob))


def test_no_answer_in_time_goes_up_and_the_rules_hold(api, worker, owner, team):
    w = team
    # HR sets the rule; nobody else does.
    assert one(api, w, w.hr, "select pulse.leave_cover_policy_set(1, true, 'Synthetic step: tell the client who covers') r")["r"] == {
        "hours": 1, "required": True, "sop": "Synthetic step: tell the client who covers"}
    assert one(api, w, w.hr, "select pulse.leave_cover_policy_set(1, true) r")["r"]["sop"] == "Synthetic step: tell the client who covers"
    assert one(api, w, w.hr, "select pulse.leave_cover_policy_set(1, true, '') r")["r"]["sop"] is None
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.alice, "select pulse.leave_cover_policy_set(24, false)")
    # The hours covered come from the company's shift unless named.
    n = owner_sql(owner, w, "update pulse.hr_policy set shift_start='09:30', shift_end='18:30' where org_id=%s", (w.org,)).rowcount
    day = wfh(worker, w, w.alice)
    cid = one(api, w, w.alice, "select pulse.leave_cover_ask('wfh', %s, %s, null) id", (day, w.bob))["id"]
    if n:
        hrs = one(api, w, w.alice, "select to_char(cover_start,'HH24:MI') s, to_char(cover_end,'HH24:MI') e from pulse.leave_cover where id=%s", (cid,))
        assert (hrs["s"], hrs["e"]) == ("09:30", "18:30")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.alice, "select pulse.leave_cover_ask('wfh', %s, %s, null, '10:00'::time, null)", (day, w.bob))
    due = one(api, w, w.alice, "select respond_by - created_at d from pulse.leave_cover where id=%s", (cid,))["d"]
    assert due.total_seconds() == 3600
    owner_sql(owner, w, "update pulse.leave_cover set respond_by=now()-interval '1 minute' where id=%s", (cid,))
    assert one(api, w, w.alice, "select pulse.leave_cover_escalate_due() n")["n"] == 1
    row = one(api, w, w.hr, "select status, escalated_why from pulse.leave_cover where id=%s", (cid,))
    assert (row["status"], row["escalated_why"]) == ("escalated", "no_answer")
    # Not yourself; not someone on leave on those days; not someone outside the company.
    lr = leave(worker, w, w.alice, 20, 22)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.alice, "select pulse.leave_cover_ask('leave', %s, %s, null)", (lr, w.alice))
    leave(worker, w, w.carol, 21, 21, "approved")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Synthetic Carol is on leave"):
        one(api, w, w.alice, "select pulse.leave_cover_ask('leave', %s, %s, null)", (lr, w.carol))
    other = build_world(worker, owner, api)
    stranger = person(worker, other, "Synthetic Stranger")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.alice, "select pulse.leave_cover_ask('leave', %s, %s, null)", (lr, stranger))
    # Another company's HR reads none of it.
    other_hr = person(worker, other, "Synthetic Other HR", "hr")
    assert one(api, other, other_hr, "select count(*)::int n from pulse.leave_cover")["n"] == 0
    # A withdrawn request closes its cover.
    c3 = one(api, w, w.alice, "select pulse.leave_cover_ask('leave', %s, %s, null) id", (lr, w.bob))["id"]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.leave_request set status='cancelled' where id=%s", (lr,))
    one(api, w, w.alice, "select pulse.leave_cover_escalate_due()")
    assert one(api, w, w.alice, "select status from pulse.leave_cover where id=%s", (c3,))["status"] == "cancelled"


def publish(worker, w, kind="leave", title="Synthetic leave and WFH SOP"):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("""insert into pulse.policy_document(org_id,kind,version,title,body,status,created_by,published_at)
            values(%s,%s,1,%s,%s,'published',%s,now()) returning id""", (w.org, kind, title, SOP, w.hr)).fetchone()["id"]


def test_hr_sees_who_has_not_acknowledged_and_reminds_them(api, worker, owner, team):
    w = team
    doc = publish(worker, w)
    one(api, w, w.alice, "select pulse.policy_acknowledge(%s)", (doc,))
    s = one(api, w, w.hr, "select pulse.policy_ack_status(%s) s", (doc,))["s"]
    assert [p["name"] for p in s["acknowledged"]] == ["Synthetic Alice"]
    pending = {p["name"] for p in s["pending"]}
    assert {"Synthetic Bob", "Synthetic Carol", "Synthetic HR"} <= pending and "Synthetic Alice" not in pending
    assert s["total"] == len(s["acknowledged"]) + len(s["pending"])
    # One press reminds everyone who has not (not HR themselves), at most once a day each.
    n = one(api, w, w.hr, "select pulse.policy_ack_remind(%s) n", (doc,))["n"]
    assert n == len(pending) - 1
    assert one(api, w, w.hr, "select pulse.policy_ack_remind(%s) n", (doc,))["n"] == 0
    assert [x["href"] for x in notices(owner, w, w.bob, "Please read and acknowledge%")] == ["/me?tab=policies&kind=leave"]
    assert all(p["remindedAt"] for p in one(api, w, w.hr, "select pulse.policy_ack_status(%s) s", (doc,))["s"]["pending"] if p["name"] != "Synthetic HR")
    # Employees do not read the list or remind; another company's HR does not see the policy at all.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.bob, "select pulse.policy_ack_status(%s)", (doc,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.bob, "select pulse.policy_ack_remind(%s)", (doc,))
    assert as_(api, w, w.bob, "select person_id from pulse.policy_ack_nudge") == []
    other = build_world(worker, owner, api)
    other_hr = person(worker, other, "Synthetic Other HR", "hr")
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, other, other_hr, "select pulse.policy_ack_status(%s)", (doc,))
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, other, other_hr, "select pulse.policy_ack_remind(%s)", (doc,))


def accounts(worker, w, people):
    with worker.transaction():
        set_tenant(worker, w.org)
        for who, handle in people:
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')",
                           (w.org, f"{handle}@{w.domain}", who))
    return {handle: f"{handle}@{w.domain}" for _, handle in people}


def api_env(**extra):
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    return {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config), **extra}


def test_cover_and_acknowledgements_through_the_api(api, worker, team):
    w = team
    lr = leave(worker, w, w.alice)
    doc = publish(worker, w)
    emails = accounts(worker, w, ((w.alice, "alice"), (w.bob, "bob"), (w.hr, "hr")))
    p = subprocess.run(["node", "test/kazuk-rest-s6-runner.mjs"], cwd=API, env=api_env(TEST_EMAILS=json.dumps(emails), TEST_LEAVE=str(lr), TEST_DOC=str(doc), TEST_BOB=str(w.bob)),
                       capture_output=True, text=True, timeout=120, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    assert one(api, w, w.hr, "select status from pulse.leave_cover where source_id=%s and status<>'cancelled'", (lr,))["status"] == "accepted"


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_cover_and_acknowledgements_in_the_browser(api, worker, owner, team):
    """services/api/test/kazuk-rest-s6-browser-runner.mjs: the cover page for the colleague asked and for HR, and HR's
    acknowledgement panel, at 1440 and 390, light and dark (PULSE_KR_SCREENSHOTS=<dir> keeps the shots)."""
    w = team
    lr = leave(worker, w, w.alice)
    one(api, w, w.alice, "select pulse.leave_cover_ask('leave', %s, %s, 'Synthetic handover: files in the shared drive') id", (lr, w.bob))
    other = leave(worker, w, w.carol, 14, 15)
    c = one(api, w, w.carol, "select pulse.leave_cover_ask('leave', %s, %s, null) id", (other, w.bob))["id"]
    one(api, w, w.bob, "select pulse.leave_cover_answer(%s, false, 'Synthetic: I am away that week too')", (c,))
    doc = publish(worker, w)
    one(api, w, w.alice, "select pulse.policy_acknowledge(%s)", (doc,))
    emails = accounts(worker, w, ((w.bob, "bob"), (w.hr, "hr")))
    p = subprocess.run(["node", "test/kazuk-rest-s6-browser-runner.mjs"], cwd=API, env=api_env(TEST_EMAILS=json.dumps(emails)),
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
