"""LIFECYCLE: stages from candidate to alumni, the joining and leaving checklists, "possibly left" proposals from
evidence and former chat members, enforced by the database under row-level security. Synthetic tenants only."""
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, new_task, notes, one, team  # noqa: F401  (team is a fixture)
from test_work_structure import save_project


def move(api, w, who, person, to, **fields):
    return one(api, w, who, "select pulse.lifecycle_move(%s,%s,%s) r", (person, to, Jsonb(fields)))["r"]


def case_view(api, w, who, case):
    return one(api, w, who, "select pulse.lifecycle_case_view(%s) v", (case,))["v"]


def run(api, w, who, case, key, **fields):
    return one(api, w, who, "select pulse.lifecycle_step_run(%s,%s,%s) r", (case, key, Jsonb(fields)))["r"]


def step(view, key):
    return next(s for s in view["steps"] if s["key"] == key)


def stage(worker, w, person):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select pulse.lifecycle_stage(%s) s", (person,)).fetchone()["s"]


def day0():
    """The company's day (synthetic companies are in Asia/Kolkata), not the server's: from 18:30 UTC they differ."""
    return datetime.now(ZoneInfo("Asia/Kolkata")).date()


def today():
    return day0().isoformat()


def test_stages_are_dated_attributed_and_only_hr_moves_people(api, worker, team):
    w = team
    # A member moves nobody, not even themselves.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        move(api, w, w.editor, w.editor, "notice", lastWorkingDay=today())
    # HR adds a candidate: a staff record that is not current, so no picker or group offers them yet.
    cand = one(api, w, w.lead, "select pulse.lifecycle_candidate(%s) id", (Jsonb({"name": "Asha Candidate", "role": "Video Editor", "pod": "Pod 1"}),))["id"]
    assert one(api, w, w.lead, "select status from pulse.person where id=%s", (cand,))["status"] == "inactive"
    with pytest.raises(psycopg.errors.InvalidParameterValue):  # nobody can be given work before they join
        new_task(api, w, w.lead, title="Too early", assigneeId=str(cand))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="moves to"):
        move(api, w, w.lead, cand, "notice", lastWorkingDay=today())
    move(api, w, w.lead, cand, "offer", note="Offer sent by mail")
    r = move(api, w, w.lead, cand, "joining", effectiveOn=today())
    assert r["stage"] == "joining" and r["caseId"]
    row = one(api, w, w.lead, "select p.status,pp.joined_on from pulse.person p join pulse.people_profile pp on pp.person_id=p.id where p.id=%s", (cand,))
    assert row == {"status": "active", "joined_on": day0()}
    # Joining opens the onboarding checklist; nothing is sent: the invite step waits for HR to press Send.
    view = case_view(api, w, w.lead, r["caseId"])
    assert [s["key"] for s in view["steps"]] == ["record", "invite", "welcome", "groups", "domains", "payroll", "probation"]
    assert step(view, "invite")["status"] == "todo" and step(view, "record")["status"] == "done"
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Send the invitation"):
        run(api, w, w.lead, r["caseId"], "invite")
    run(api, w, w.lead, r["caseId"], "payroll", payrollFrom=today())
    assert step(case_view(api, w, w.lead, r["caseId"]), "payroll")["status"] == "done"
    move(api, w, w.lead, cand, "probation", probationTo=(day0() + timedelta(days=90)).isoformat())
    move(api, w, w.lead, cand, "active")
    events = as_(api, w, w.lead, "select kind,from_stage,to_stage,actor from pulse.person_lifecycle_event where person_id=%s and kind='stage' order by at", (cand,))
    assert [(e["from_stage"], e["to_stage"]) for e in events] == [(None, "candidate"), ("candidate", "offer"), ("offer", "joining"), ("joining", "probation"), ("probation", "active")]
    assert {e["actor"] for e in events} == {w.lead}
    # A pod change made on any screen is a dated event too.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set pod='Pod 2' where person_id=%s", (cand,))
    change = one(api, w, w.lead, "select detail,actor from pulse.person_lifecycle_event where person_id=%s and kind='change'", (cand,))
    assert change["detail"] == {"pod": {"from": "Pod 1", "to": "Pod 2"}} and change["actor"] is None
    # Everyone sees their own stage; colleagues outside their line do not.
    assert one(api, w, w.editor, "select stage from pulse.person_lifecycle where person_id=%s", (cand,)) is None
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.lifecycle_case_view(%s)", (r["caseId"],))


def test_leaving_checklist_hands_over_everything_and_keeps_history(api, worker, team):
    w = team
    # The editor has open work, a pool claim, a project they own, groups and a live session.
    t1 = new_task(api, w, w.editor, title="Cut the launch reel")
    t2 = new_task(api, w, w.editor, title="Colour grade the teaser")
    pooled = new_task(api, w, w.lead, title="Edit the pool reel", pool={"scope": "pod", "ref": "Pod 1"})
    as_(api, w, w.editor, "select pulse.work_pool_claim(%s)", (pooled,))
    prj = save_project(api, w, w.editor2, name="Launch kit", type="internal", pod="Pod 1", ownerId=str(w.editor))["id"]
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        group = api.execute("select pulse.chat_group_create('Launch crew',%s) id", ([w.editor, w.lead],)).fetchone()["id"]
        api.execute("select pulse.chat_refresh()")
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.chat_send(%s,'Draft is up',null,'[]',%s,null)", (group, uuid.uuid4()))
        api.execute("insert into pulse.login_session(org_id,person_id,token_hash,expires_at) values(%s,%s,%s,now()+interval '12 hours')", (w.org, w.editor, str(uuid.uuid4())))
    lwd = (day0() + timedelta(days=10)).isoformat()
    r = move(api, w, w.lead, w.editor, "notice", lastWorkingDay=lwd, note="Moving cities")
    case = r["caseId"]
    assert one(api, w, w.lead, "select status from pulse.person where id=%s", (w.editor,))["status"] == "active"  # still working out the notice
    view = case_view(api, w, w.lead, case)
    assert [s["key"] for s in view["steps"]] == ["work", "projects", "pods", "settlement", "assets", "access", "chats", "workspace", "alumni"]
    work = step(view, "work")
    assert {t["title"] for t in work["proposal"]["tasks"]} == {"Cut the launch reel", "Colour grade the teaser", "Edit the pool reel"}
    # Pulse proposes the pod head for each task; HR confirms (here, the pool claim goes back to the pool).
    assert {t["to"]["id"] for t in work["proposal"]["tasks"]} == {str(w.editor2)}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        run(api, w, w.editor2, case, "work", tasks=[])
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="current team member"):
        run(api, w, w.lead, case, "work", tasks=[{"id": str(t1), "to": str(w.editor)}])
    done = run(api, w, w.lead, case, "work", note="Files are in the Launch folder",
               tasks=[{"id": str(t1), "to": str(w.editor2)}, {"id": str(t2), "to": str(w.editor2)}, {"id": str(pooled), "to": None}])
    assert done["result"] == {"tasks": 3, "reviews": 0}
    rows = {r["id"]: r for r in as_(api, w, w.lead, "select id,assignee_person_id a,claimed_by,pool_scope from pulse.task where id in (%s,%s,%s)", (t1, t2, pooled))}
    assert rows[t1]["a"] == rows[t2]["a"] == w.editor2 and rows[pooled]["a"] is None and rows[pooled]["claimed_by"] is None and rows[pooled]["pool_scope"] == "pod"
    assert {n["subject_id"] for n in notes(worker, w, w.editor2, "task.assigned")} >= {t1, t2}
    assert one(api, w, w.editor2, "select body from pulse.work_comment where task_id=%s", (t1,))["body"] == "Handover from Editor One: Files are in the Launch folder"
    assert step(case_view(api, w, w.lead, case), "work")["status"] == "done"
    # Projects, pods and roles, settlement, assets.
    run(api, w, w.lead, case, "projects", projects=[{"id": prj, "to": str(w.editor2)}])
    assert one(api, w, w.lead, "select owner_id from pulse.work_project where project_id=%s", (prj,))["owner_id"] == w.editor2
    run(api, w, w.lead, case, "pods")
    prof = one(api, w, w.lead, "select pod,manager_id from pulse.people_profile where person_id=%s", (w.editor,))
    assert prof == {"pod": None, "manager_id": None}
    assert one(api, w, w.lead, "select count(*) n from pulse.role_assignment where person_id=%s and current_date between valid_from and coalesce(valid_to,'infinity')", (w.editor,))["n"] == 0
    settle = step(case_view(api, w, w.lead, case), "settlement")["proposal"]
    assert settle["lastWorkingDay"] == lwd and settle["noticeServedDays"] == 11 and settle["noticeRecoveryDays"] == 19
    run(api, w, w.lead, case, "settlement", lastWorkingDay=lwd, leaveDays=2.5, noticeRecoveryDays=19, compOffDays=0)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        run(api, w, w.lead, case, "settlement", lastWorkingDay=lwd, leaveDays=-1)
    assert run(api, w, w.lead, case, "assets", items=[{"name": "Laptop", "returned": False}])["status"] == "todo"
    assert run(api, w, w.lead, case, "assets", items=[{"name": "Laptop", "returned": True}])["status"] == "done"
    # Access ends sessions and the credential; chats removes them from every current group, and the refresh from
    # pods and teams does not add them back while they are still on notice.
    assert step(case_view(api, w, w.lead, case), "access")["pending"] >= 1
    run(api, w, w.lead, case, "access")
    assert one(api, w, w.lead, "select count(*) n from pulse.login_session where person_id=%s and revoked_at is null", (w.editor,))["n"] == 0
    run(api, w, w.lead, case, "chats")
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.chat_refresh()")
        assert api.execute("select count(*) n from pulse.chat_member where person_id=%s", (w.editor,)).fetchone()["n"] == 0
        former = api.execute("select reason from pulse.chat_former_member where channel_id=%s and person_id=%s", (group, w.editor)).fetchall()
        assert [f["reason"] for f in former] == ["leaving_checklist"]
        # Their messages stay in the conversation.
        assert api.execute("select count(*) n from pulse.chat_message where channel_id=%s and author_id=%s", (group, w.editor)).fetchone()["n"] == 1
    # Google Workspace: an admin's ticks only; HR cannot tick them and Pulse never changes Workspace.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        run(api, w, w.lead, case, "workspace", item="suspend")
    for item in ("suspend", "drive", "groups", "forward"):
        last = run(api, w, w.manager, case, "workspace", item=item)
    assert last["status"] == "done"
    # The last step makes them alumni, on the last working day (not before it).
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="still to come"):
        run(api, w, w.lead, case, "alumni", leftType="resigned")
    out = run(api, w, w.lead, case, "alumni", effectiveOn=today(), leftType="resigned")
    assert out["caseDone"] is True and stage(worker, w, w.editor) == "left"
    assert one(api, w, w.lead, "select status from pulse.person where id=%s", (w.editor,))["status"] == "inactive"
    with pytest.raises(psycopg.errors.InvalidParameterValue):  # alumni are out of every picker
        new_task(api, w, w.lead, title="Too late", assigneeId=str(w.editor))
    # History is never deleted: their tasks, events and messages are all still there.
    assert one(api, w, w.lead, "select count(*) n from pulse.task where created_by=%s", (w.editor,))["n"] >= 2
    kinds = [e["to_stage"] for e in as_(api, w, w.lead, "select to_stage from pulse.person_lifecycle_event where person_id=%s and kind='stage' order by at", (w.editor,))]
    assert kinds == ["notice", "left"]


def test_withdrawn_notice_and_rehire(api, worker, team):
    w = team
    lwd = (day0() + timedelta(days=20)).isoformat()
    case = move(api, w, w.lead, w.outsider, "notice", lastWorkingDay=lwd)["caseId"]
    move(api, w, w.lead, w.outsider, "active", note="Resignation withdrawn")
    assert one(api, w, w.lead, "select status from pulse.lifecycle_case where id=%s", (case,))["status"] == "cancelled"
    assert one(api, w, w.lead, "select notice_from,last_working_day from pulse.hr_employment where person_id=%s", (w.outsider,)) == {"notice_from": None, "last_working_day": None}
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="how they left"):
        move(api, w, w.lead, w.outsider, "left")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="did not join"):
        move(api, w, w.lead, w.outsider, "left", leftType="not_joined")
    move(api, w, w.lead, w.outsider, "left", leftType="terminated", effectiveOn=today())
    assert one(api, w, w.lead, "select status from pulse.person where id=%s", (w.outsider,))["status"] == "inactive"
    # Re-hire starts again: current from the new joining date, with a new joining case; the first stint stays.
    r = move(api, w, w.lead, w.outsider, "joining", effectiveOn=today())
    assert one(api, w, w.lead, "select status from pulse.person where id=%s", (w.outsider,))["status"] == "active"
    assert one(api, w, w.lead, "select count(*) n from pulse.lifecycle_case where person_id=%s", (w.outsider,))["n"] == 3
    assert r["caseId"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="your own"):
        move(api, w, w.lead, w.lead, "notice", lastWorkingDay=lwd)


def signal(worker, w, person, source, kind, weight, on, ref, last_day=None, summary="Synthetic evidence"):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse.lifecycle_signal(org_id,person_id,source,kind,observed_on,last_day,weight,summary,ref)
                          values(%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (w.org, person, source, kind, on, last_day, weight, summary, ref))


def detect(worker, w):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select pulse.lifecycle_detect() n").fetchone()["n"]


def test_possibly_left_is_proposed_from_evidence_and_waits_for_hr(api, worker, team):
    w = team
    past = day0() - timedelta(days=40)
    # A resignation mail with a last working day is strong evidence on its own.
    signal(worker, w, w.editor, "mail", "resigned", 3, past, "mail:1", last_day=past + timedelta(days=30), summary="Resignation mail to HR")
    # Someone missing from the latest salary sheet, with nothing else, is only a low-confidence proposal.
    with worker.transaction():
        set_tenant(worker, w.org)
        for person, month in ((w.editor2, "2026-03-01"), (w.lead, "2026-07-01"), (w.outsider, "2026-07-01")):
            worker.execute("""insert into pulse.person_source(org_id,person_id,source,source_ref,label,written_name,last_seen,restricted)
                              values(%s,%s,'hr_document',%s,'Salary sheet “Synthetic 2026”','Synthetic',%s,true)""", (w.org, person, f"sheet:{person}", month))
    detect(worker, w)
    reviews = {r["person_id"]: r for r in as_(api, w, w.lead, "select person_id,status,confidence,proposed_on,proposed_type,reasons from pulse.lifecycle_review")}
    assert reviews[w.editor]["confidence"] == "high" and reviews[w.editor]["proposed_type"] == "resigned"
    assert reviews[w.editor]["proposed_on"] == past + timedelta(days=30)
    assert reviews[w.editor2]["confidence"] in ("low", "medium") and w.outsider not in reviews
    # Members see neither the evidence nor the list, and cannot refresh it.
    assert as_(api, w, w.editor2, "select person_id from pulse.lifecycle_review") == []
    assert as_(api, w, w.editor2, "select id from pulse.lifecycle_signal") == []
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.lifecycle_detect()")
    assert one(api, w, w.editor2, "select pulse.lifecycle_possibly_left(%s) p", (w.editor,))["p"] is True
    # A later "I have cancelled my resignation" mail withdraws the proposal.
    signal(worker, w, w.editor, "mail", "cancelled", 1, past + timedelta(days=5), "mail:2", summary="Resignation withdrawn by mail")
    detect(worker, w)
    assert one(api, w, w.lead, "select status from pulse.lifecycle_review where person_id=%s", (w.editor,))["status"] == "cleared"
    # Dismissing needs a reason and holds until stronger, newer evidence.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.lead, "select pulse.lifecycle_review_decide(%s,'dismiss','{}')", (w.editor2,))
    as_(api, w, w.lead, "select pulse.lifecycle_review_decide(%s,'dismiss',%s)", (w.editor2, Jsonb({"note": "Still working, paid in cash"})))
    detect(worker, w)
    assert one(api, w, w.lead, "select status from pulse.lifecycle_review where person_id=%s", (w.editor2,))["status"] == "dismissed"
    # HR confirms: "Mark as left on <date>, resigned" makes them alumni and opens the leaving checklist.
    signal(worker, w, w.outsider, "mail", "terminated", 3, past, "mail:3", summary="Termination notice from HR")
    detect(worker, w)
    out = one(api, w, w.lead, "select pulse.lifecycle_review_decide(%s,'confirm',%s) r", (w.outsider, Jsonb({"effectiveOn": past.isoformat()})))["r"]
    assert out["stage"] == "left" and out["caseId"]
    assert one(api, w, w.lead, "select left_type,left_on from pulse.person_lifecycle where person_id=%s", (w.outsider,)) == {"left_type": "terminated", "left_on": past}
    view = case_view(api, w, w.lead, out["caseId"])
    # Marking as left ended access and groups at once; the rest of the checklist waits for HR.
    assert step(view, "access")["status"] == "done" and step(view, "alumni")["status"] == "done"
    # Someone already not current whose leaving was never recorded is listed to record it, without changing them.
    with worker.transaction():
        set_tenant(worker, w.org)
        gone = uuid.uuid4()
        worker.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,'Former Synthetic','staff','inactive')", (gone, w.org))
    signal(worker, w, gone, "mail", "closed", 3, past, "mail:4", summary="Closure documents sent by HR")
    detect(worker, w)
    rv = one(api, w, w.lead, "select already_inactive,status from pulse.lifecycle_review where person_id=%s", (gone,))
    assert rv == {"already_inactive": True, "status": "open"}
    one(api, w, w.lead, "select pulse.lifecycle_review_decide(%s,'confirm',%s) r", (gone, Jsonb({"leftType": "resigned"})))
    assert stage(worker, w, gone) == "left"
    # A letter from before someone joined is about someone else: it proposes nothing for them.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.people_profile set joined_on=%s where person_id=%s", (day0() - timedelta(days=30), w.manager))
    signal(worker, w, w.manager, "mail", "closed", 3, day0() - timedelta(days=400), "mail:5", summary="Experience letter to an earlier namesake")
    detect(worker, w)
    assert one(api, w, w.lead, "select count(*) n from pulse.lifecycle_review where person_id=%s and status='open'", (w.manager,))["n"] == 0
    # Someone already not current with nothing else is proposed with the last month HR records name them, not today.
    with worker.transaction():
        set_tenant(worker, w.org)
        quiet = uuid.uuid4()
        worker.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,'Quiet Former','staff','inactive')", (quiet, w.org))
        worker.execute("""insert into pulse.person_source(org_id,person_id,source,source_ref,label,written_name,last_seen,restricted)
                          values(%s,%s,'hr_document','att:q','Attendance sheet “Synthetic”','Quiet Former','2025-03-01',true)""", (w.org, quiet))
    detect(worker, w)
    rv = one(api, w, w.lead, "select confidence,proposed_on,already_inactive from pulse.lifecycle_review where person_id=%s", (quiet,))
    assert rv == {"confidence": "low", "proposed_on": date(2025, 3, 31), "already_inactive": True}


def test_offboarding_by_status_keeps_former_members(api, worker, team):
    w = team
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        group = api.execute("select pulse.chat_group_create('Edit desk',%s) id", ([w.editor],)).fetchone()["id"]
        dm = api.execute("select pulse.chat_direct(%s) id", (w.editor,)).fetchone()["id"]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set status='inactive' where id=%s", (w.editor,))
        assert worker.execute("select count(*) n from pulse.chat_member where person_id=%s", (w.editor,)).fetchone()["n"] == 0
        former = {r["channel_id"] for r in worker.execute("select channel_id from pulse.chat_former_member where person_id=%s and reason='left_company'", (w.editor,))}
        assert {group, dm} <= former
        # Flipped on the record form, it is still a dated move; how they left stays open for HR's review list.
        assert worker.execute("select pulse.lifecycle_stage(%s) s", (w.editor,)).fetchone()["s"] == "left"
        ev = worker.execute("select from_stage,to_stage,left_type,detail from pulse.person_lifecycle_event where person_id=%s and kind='stage'", (w.editor,)).fetchone()
        assert ev == {"from_stage": "active", "to_stage": "left", "left_type": None, "detail": {"via": "record"}}
        worker.execute("select pulse.lifecycle_detect()")
        assert worker.execute("select already_inactive,confidence from pulse.lifecycle_review where person_id=%s", (w.editor,)).fetchone() == {"already_inactive": True, "confidence": "low"}
    # The other side of the direct chat still sees whom it was with.
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        assert api.execute("select count(*) n from pulse.chat_former_member where channel_id=%s", (dm,)).fetchone()["n"] == 1
