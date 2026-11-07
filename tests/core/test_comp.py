"""COMP-A (0440_comp_pay.sql): people's pay from offer to exit, enforced in the database. Synthetic tenants, people and
sealed placeholders only: the database never sees an amount (the API seals them; services/api/test/comp-runner.mjs
covers the real sealing). Every permission and every state change: who reads individuals' pay (HR, leadership, an admin
given the permission, the person), what a manager and the Accountant see, maker-checker on changes, offers, probation,
pauses, items, claims and the full and final, letters, the timeline, notices without amounts, the access log, the tick,
and the offer that finishes its task (UX-5B)."""
import base64
import hashlib
import re
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant

SEALED = {"kid": "comp-test", "key": base64.b64encode(b"wrapped-key").decode(), "data": base64.b64encode(b"ciphertext").decode()}
TODAY = date.today()
# The company's day, which offers are checked against (pulse.lifecycle_today(), Asia/Kolkata): from 18:30 to 24:00 UTC the
# host's date.today() is still the day before.
COMPANY_TODAY = datetime.now(ZoneInfo("Asia/Kolkata")).date()


def as_(api, w, who, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, who)
        cur = api.execute(sql, args)
        return cur.fetchall() if cur.description else []


def one(api, w, who, sql, args=()):
    rows = as_(api, w, who, sql, args)
    return rows[0] if rows else None


def val(api, w, who, sql, args=()):
    return list(one(api, w, who, sql, args).values())[0]


def denied(api, w, who, sql, args=(), code=psycopg.errors.InsufficientPrivilege):
    with pytest.raises(code):
        as_(api, w, who, sql, args)


def refused(api, w, who, sql, args=(), match=None):
    with pytest.raises(psycopg.errors.InvalidParameterValue, match=match):
        as_(api, w, who, sql, args)


def worker_rows(worker, w, sql, args=()):
    with worker.transaction():
        set_tenant(worker, w.org)
        cur = worker.execute(sql, args)
        return cur.fetchall() if cur.description else []


def notes(worker, w, person, kind=None):
    return worker_rows(worker, w, "select event_type,title,href from pulse.notification where person_id=%s and (%s::text is null or event_type=%s) order by created_at",
                       (person, kind, kind))


def logs(worker, w, subject, resource=None):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select viewer_id,resource,purpose from privacy.access_log where org_id=%s and subject_person_id=%s and (%s::text is null or resource=%s)",
                              (w.org, subject, resource, resource)).fetchall()


@pytest.fixture
def pay(worker, owner, api):
    w = build_world(worker, owner, api)
    names = ["hr", "hr2", "founder", "founder2", "lead", "admin", "admin_pay", "person", "head", "other", "candidate", "ca"]
    w.p = {n: uuid.uuid4() for n in names}
    with worker.transaction():
        set_tenant(worker, w.org)
        for n, pid in w.p.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,%s,'staff',%s)",
                           (pid, w.org, "Synthetic " + n.replace("_", " ").title(), "inactive" if n == "candidate" else "active"))
        for n, pid in w.p.items():
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence,manager_id) values(%s,%s,%s,'Pod 9','{}',%s)",
                           (w.org, pid, "Editor (proposed)" if n == "candidate" else n.title(), w.p["head"] if n == "person" else None))
        for n, role in [("hr", "hr"), ("hr2", "hr"), ("founder", "leadership"), ("founder2", "leadership"), ("lead", "leadership"), ("admin", "admin"), ("admin_pay", "admin")]:
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, w.p[n], role))
        for perm in ["hr.salary.read", "hr.salary.write"]:
            worker.execute("insert into pulse.sensitive_permission(org_id,person_id,permission,granted_by) values(%s,%s,%s,'test')", (w.org, w.p["admin_pay"], perm))
    with owner.transaction():
        set_tenant(owner, w.org)
        for n in ["founder", "founder2"]:
            owner.execute("insert into pulse.hr_cofounder(org_id,person_id,assigned_by) values(%s,%s,%s)", (w.org, w.p[n], w.p[n]))
        owner.execute("insert into pulse_priv.accountant_access(org_id,person_id,expires_on,granted_by) values(%s,%s,'2099-12-31',%s)", (w.org, w.p["ca"], w.p["founder"]))
        owner.execute("insert into pulse.person_lifecycle(org_id,person_id,stage,since) values(%s,%s,'offer',current_date)", (w.org, w.p["candidate"]))
    return w


def change(api, w, who, person, kind="raise", on=None, submit=True, **extra):
    return val(api, w, who, "select pulse.comp_change_save(%s)", (Jsonb({"person": str(person), "kind": kind, "effectiveOn": str(on or TODAY), "payType": "salary",
                                                                          "reason": "Synthetic reason", "submit": submit, "sealed": SEALED, **extra}),))


def start_pay(api, w, person, on=None):
    """A first approved version: HR proposes, a founder approves."""
    cid = change(api, w, w.p["hr"], person, kind="start", on=on or TODAY - timedelta(days=60))
    as_(api, w, w.p["founder"], "select pulse.comp_change_decide(%s,'approve',null)", (cid,))
    return cid


def letter(api, w, who, subject_type, subject_id, kind="revision"):
    return val(api, w, who, "select pulse.comp_letter_add(%s)", (Jsonb({"subjectType": subject_type, "subjectId": str(subject_id), "kind": kind, "title": "Synthetic letter",
                                                                          "sealed": SEALED, "pdf": SEALED, "sha256": "a" * 64, "pages": 1}),))


def test_api_role_reads_no_pay_table(api, pay):
    w = pay
    for table in ["comp_record", "comp_change", "comp_offer", "comp_claim", "comp_letter", "comp_settlement", "comp_item", "comp_pause", "comp_event"]:
        denied(api, w, w.p["hr"], f"select * from pulse.{table}")


def test_who_reads_individuals_pay(api, worker, pay):
    w = pay
    start_pay(api, w, w.p["person"])
    for who in ["hr", "founder", "lead", "admin_pay"]:
        people = val(api, w, w.p[who], "select pulse.comp_people()")["people"]
        assert any(r["id"] == str(w.p["person"]) and r["status"] == "confirmed" for r in people), who
    for who in ["admin", "other", "person", "head", "ca"]:
        denied(api, w, w.p[who], "select pulse.comp_people()")
    # The person reads their own record and figures; a colleague, the plain admin and the Accountant read nothing.
    me = val(api, w, w.p["person"], "select pulse.comp_person(%s)", (w.p["person"],))
    assert me["can"]["self"] and me["record"]["status"] == "confirmed" and len(me["versions"]) == 1
    assert one(api, w, w.p["person"], "select person_id from pulse.comp_figures(%s,null)", ([w.p["person"]],))["person_id"] == w.p["person"]
    for who in ["other", "admin", "head", "ca"]:
        denied(api, w, w.p[who], "select pulse.comp_person(%s)", (w.p["person"],))
        assert as_(api, w, w.p[who], "select * from pulse.comp_figures(%s,null)", ([w.p["person"]],)) == []
    # Every look is logged before anything is returned.
    purposes = {(r["resource"], r["purpose"]) for r in logs(worker, w, w.p["person"])}
    assert ("comp.record", "self") in purposes and ("comp.pay", "self") in purposes


def test_manager_sees_status_only_when_the_policy_says_so(api, pay):
    w = pay
    start_pay(api, w, w.p["person"])
    denied(api, w, w.p["head"], "select pulse.comp_person(%s)", (w.p["person"],))
    # Only leadership changes who approves; HR sets the managers rule.
    denied(api, w, w.p["hr"], "select pulse.comp_policy_save(%s)", (Jsonb({"approvers": "second_hr"}),))
    as_(api, w, w.p["hr"], "select pulse.comp_policy_save(%s)", (Jsonb({"managers": "status"}),))
    rows = val(api, w, w.p["head"], "select pulse.comp_people()")["people"]
    assert [r["id"] for r in rows] == [str(w.p["person"])] and "change" not in rows[0] and "settlement" not in rows[0]
    seen = val(api, w, w.p["head"], "select pulse.comp_person(%s)", (w.p["person"],))
    assert seen["can"]["manager"] and "versions" not in seen and "items" not in seen and "claims" not in seen
    assert as_(api, w, w.p["head"], "select * from pulse.comp_figures(%s,null)", ([w.p["person"]],)) == []


def test_maker_checker_on_pay_changes(api, worker, owner, pay):
    w = pay
    start_pay(api, w, w.p["person"])
    # Who proposes: writers only, never for themselves.
    for who in ["other", "admin", "head", "person"]:
        denied(api, w, w.p[who], "select pulse.comp_change_save(%s)", (Jsonb({"person": str(w.p["person"]), "kind": "raise", "effectiveOn": str(TODAY), "payType": "salary",
                                                                              "reason": "x" * 5, "sealed": SEALED}),))
    denied(api, w, w.p["hr"], "select pulse.comp_change_save(%s)", (Jsonb({"person": str(w.p["hr"]), "kind": "raise", "effectiveOn": str(TODAY), "payType": "salary", "reason": "Myself",
                                                                           "sealed": SEALED}),))
    refused(api, w, w.p["hr"], "select pulse.comp_change_save(%s)", (Jsonb({"person": str(w.p["person"]), "kind": "raise", "effectiveOn": str(TODAY), "payType": "salary",
                                                                           "sealed": SEALED}),), match="reason")
    raise_id = change(api, w, w.p["hr"], w.p["person"], on=TODAY + timedelta(days=20))
    # Approvers were told, without an amount; the person was not.
    waiting = notes(worker, w, w.p["founder"], "comp.waiting")
    assert waiting and "waiting for your approval" in waiting[0]["title"] and not any(ch.isdigit() for ch in waiting[0]["title"].split(" from ")[0])
    assert notes(worker, w, w.p["person"], "comp.waiting") == [] and notes(worker, w, w.p["hr"], "comp.waiting") == []
    # Who approves: the proposer never; HR and a leader who is not a named founder neither; a founder does.
    denied(api, w, w.p["hr"], "select pulse.comp_change_decide(%s,'approve',null)", (raise_id,))
    denied(api, w, w.p["lead"], "select pulse.comp_change_decide(%s,'approve',null)", (raise_id,))
    refused(api, w, w.p["founder"], "select pulse.comp_change_decide(%s,'reject',null)", (raise_id,), match="Say why")
    assert val(api, w, w.p["founder"], "select pulse.comp_change_decide(%s,'approve',null)", (raise_id,))["status"] == "approved"
    refused(api, w, w.p["founder2"], "select pulse.comp_change_decide(%s,'approve',null)", (raise_id,), match="proposed")
    # Scheduled: the version in force stays the old one until its date.
    person = val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (w.p["person"],))
    assert [v["inForce"] for v in person["versions"]] == [False, True]
    assert [n["title"] for n in notes(worker, w, w.p["hr"], "comp.decided")] == ["Start for Synthetic Person was approved", "Raise for Synthetic Person was approved"]
    # A founder's own pay: HR proposes, the other founder approves, never the founder themselves.
    own = change(api, w, w.p["hr"], w.p["founder"], kind="start")
    denied(api, w, w.p["founder"], "select pulse.comp_change_decide(%s,'approve',null)", (own,))
    assert val(api, w, w.p["founder2"], "select pulse.comp_change_decide(%s,'approve',null)", (own,))["status"] == "approved"
    # Sent back: the proposer edits and proposes again; withdrawn changes stay in the history.
    cut = change(api, w, w.p["hr"], w.p["person"], kind="cut", on=TODAY + timedelta(days=40))
    assert val(api, w, w.p["founder"], "select pulse.comp_change_decide(%s,'return','Wrong month')", (cut,))["status"] == "draft"
    as_(api, w, w.p["hr"], "select pulse.comp_change_withdraw(%s)", (cut,))
    # A company without named founders: its leadership approves (a leader who is not a founder now may).
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.hr_cofounder set active=false where org_id=%s", (w.org,))
    backdated = change(api, w, w.p["hr"], w.p["person"], on=TODAY.replace(day=1) - timedelta(days=40))
    r = val(api, w, w.p["lead"], "select pulse.comp_change_decide(%s,'approve',null)", (backdated,))
    assert r["backdated"] is True
    # Its arrears: recorded at once by the approver, maker and checker carried over; never twice.
    item = val(api, w, w.p["lead"], "select pulse.comp_arrears_add(%s,%s)", (backdated, Jsonb({"sealed": SEALED, "months": 2})))
    refused(api, w, w.p["lead"], "select pulse.comp_arrears_add(%s,%s)", (backdated, Jsonb({"sealed": SEALED, "months": 2})), match="already")
    denied(api, w, w.p["founder2"], "select pulse.comp_arrears_add(%s,%s)", (backdated, Jsonb({"sealed": SEALED, "months": 2})))
    assert one(api, w, w.p["hr"], "select pulse.comp_person(%s)->'items'->0->>'status' s", (w.p["person"],))["s"] == "approved" and item


def test_letters_follow_decisions_and_reach_the_person(api, worker, pay):
    w = pay
    start_pay(api, w, w.p["person"])
    raise_id = change(api, w, w.p["hr"], w.p["person"])
    refused(api, w, w.p["hr"], "select pulse.comp_letter_add(%s)", (Jsonb({"subjectType": "change", "subjectId": str(raise_id), "kind": "revision", "title": "Too early",
                                                                            "sealed": SEALED, "pdf": SEALED, "sha256": "a" * 64}),), match="approved decision")
    as_(api, w, w.p["founder"], "select pulse.comp_change_decide(%s,'approve',null)", (raise_id,))
    denied(api, w, w.p["other"], "select pulse.comp_letter_add(%s)", (Jsonb({"subjectType": "change", "subjectId": str(raise_id), "kind": "revision", "title": "x",
                                                                              "sealed": SEALED, "pdf": SEALED, "sha256": "a" * 64}),))
    lid = letter(api, w, w.p["founder"], "change", raise_id)
    refused(api, w, w.p["founder"], "select pulse.comp_letter_add(%s)", (Jsonb({"subjectType": "change", "subjectId": str(raise_id), "kind": "revision", "title": "Again",
                                                                                "sealed": SEALED, "pdf": SEALED, "sha256": "a" * 64}),), match="once")
    assert [n["href"] for n in notes(worker, w, w.p["person"], "comp.letter")] == ["/me/pay"]
    assert one(api, w, w.p["person"], "select person_id from pulse.comp_letter_sealed(%s,'pdf')", (lid,))["person_id"] == w.p["person"]
    denied(api, w, w.p["other"], "select * from pulse.comp_letter_sealed(%s,'pdf')", (lid,), code=psycopg.errors.NoDataFound)
    assert one(api, w, w.p["hr"], "select pulse.comp_person(%s)->'letters'->0->>'seenAt' s", (w.p["person"],))["s"]


def test_offer_from_draft_to_probation(api, worker, pay):
    w = pay
    who = w.p["candidate"]
    body = {"person": str(who), "role": "Editor", "startOn": str(TODAY), "payType": "salary", "probationDays": 90, "noticeDays": 15, "terms": "Synthetic terms",
            "sealed": SEALED}
    oid = val(api, w, w.p["hr"], "select pulse.comp_offer_save(%s)", (Jsonb(body),))
    assert val(api, w, w.p["hr"], "select pulse.comp_people()")["people"] and val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))["record"]["status"] == "proposed"
    refused(api, w, w.p["hr"], "select pulse.comp_offer_save(%s)", (Jsonb({**body, "id": str(uuid.uuid4())}),), match="already has an offer")
    as_(api, w, w.p["hr"], "select pulse.comp_offer_propose(%s)", (oid,))
    denied(api, w, w.p["hr"], "select pulse.comp_offer_decide(%s,'approve',null)", (oid,))
    assert val(api, w, w.p["founder"], "select pulse.comp_offer_decide(%s,'approve',null)", (oid,)) == "approved"
    # Nothing leaves without the letter, and only a founder presses Send.
    refused(api, w, w.p["founder"], "select pulse.comp_offer_send(%s,%s)", (oid, "b" * 64), match="letter")
    letter(api, w, w.p["founder"], "offer", oid, kind="offer")
    denied(api, w, w.p["hr"], "select pulse.comp_offer_send(%s,%s)", (oid, "b" * 64))
    token = hashlib.sha256(b"synthetic-offer-token").hexdigest()
    as_(api, w, w.p["founder2"], "select pulse.comp_offer_send(%s,%s)", (oid, token))
    assert val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))["record"]["status"] == "offered"
    # Signed out (no viewer): the link opens the face of the offer and its letter, once logged.
    opened = val(api, w, None, "select pulse.comp_offer_open(%s)", (token,))
    assert opened["canDecide"] and opened["role"] == "Editor" and "amount" not in opened
    assert one(api, w, None, "select letter_id from pulse.comp_offer_link_letter(%s)", (token,))["letter_id"]
    assert val(api, w, None, "select pulse.comp_offer_open(%s)", ("c" * 64,)) is None
    refused(api, w, None, "select pulse.comp_offer_link_answer(%s,'accepted','x',null,%s,'agent')", (token, "d" * 64), match="full name")
    r = val(api, w, None, "select pulse.comp_offer_link_answer(%s,'accepted','Synthetic Candidate',null,%s,'agent')", (token, "d" * 64))
    assert r["decision"] == "accepted"
    refused(api, w, None, "select pulse.comp_offer_link_answer(%s,'declined','Synthetic Candidate',null,%s,'agent')", (token, "d" * 64), match="expired|answered")
    # Starting today: probation with dates and reviews, the stage moves (joining → probation), the role is the offer's.
    rec = val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))
    assert rec["record"]["status"] == "probation" and rec["employment"]["probationTo"] == str(TODAY + timedelta(days=89))
    assert {v["kind"] for v in rec["probation"]["reviews"]} == {"midpoint", "final"} and rec["person"]["role"] == "Editor" and rec["person"]["current"]
    # The accepted offer is their first version of pay, in force from the start (0441).
    assert [(v["kind"], v["status"], v["inForce"]) for v in rec["versions"]] == [("offer", "approved", True)]
    stages = worker_rows(worker, w, "select to_stage from pulse.person_lifecycle_event where person_id=%s and kind='stage' order by at", (who,))
    assert [s["to_stage"] for s in stages] == ["joining", "probation"]
    assert [n["title"] for n in notes(worker, w, w.p["founder2"], "comp.decided")] == ["Synthetic Candidate accepted the offer"]


def test_offer_decline_expiry_and_task_completion(api, worker, owner, pay):
    w = pay
    who = w.p["other"]
    body = {"person": str(who), "role": "Senior editor", "startOn": str(TODAY + timedelta(days=30)), "payType": "salary", "sealed": SEALED, "submit": True}
    oid = val(api, w, w.p["hr"], "select pulse.comp_offer_save(%s)", (Jsonb(body),))
    # Kazuk's "Issue … offer letter" task, linked to the offer: sending it finishes the task (UX-5B's confirmed signal).
    task = val(api, w, w.p["founder"], "select pulse.task_save(null,%s)", (Jsonb({"title": "Issue the synthetic offer letter", "assigneeId": str(w.p["founder"])}),))
    as_(api, w, w.p["hr"], "select pulse.comp_offer_task(%s,%s)", (oid, task))
    as_(api, w, w.p["founder"], "select pulse.comp_offer_decide(%s,'approve',null)", (oid,))
    letter(api, w, w.p["founder"], "offer", oid, kind="offer")
    as_(api, w, w.p["founder"], "select pulse.comp_offer_send(%s,null)", (oid,))
    assert one(api, w, w.p["founder"], "select status from pulse.task where id=%s", (task,))["status"] == "done"
    assert worker_rows(worker, w, "select signals from pulse.task_auto_done where task_id=%s", (task,))
    # The person signed in reads and answers in Pulse; a colleague cannot answer for them.
    assert [n["href"] for n in notes(worker, w, who, "comp.offer")] == ["/me/pay"]
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.p["person"], "select pulse.comp_offer_answer(%s,'accepted','Someone Else',null)", (oid,))
    as_(api, w, who, "select pulse.comp_offer_answer(%s,'declined','Synthetic Other','Another offer')", (oid,))
    assert val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))["record"]["status"] == "ended"
    # An offer left unanswered past its date expires at the next tick and its link stops working.
    who2 = w.p["head"]
    oid2 = val(api, w, w.p["hr"], "select pulse.comp_offer_save(%s)", (Jsonb({**body, "person": str(who2), "validUntil": str(COMPANY_TODAY)}),))
    as_(api, w, w.p["founder"], "select pulse.comp_offer_decide(%s,'approve',null)", (oid2,))
    letter(api, w, w.p["founder"], "offer", oid2, kind="offer")
    token = hashlib.sha256(b"expiring").hexdigest()
    as_(api, w, w.p["founder"], "select pulse.comp_offer_send(%s,%s)", (oid2, token))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.comp_offer set valid_until=current_date-1 where id=%s", (oid2,))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.comp_tick() t").fetchone()["t"]["expired"] == 1
    assert val(api, w, None, "select pulse.comp_offer_open(%s)", (token,)) is None
    assert val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who2,))["offers"][0]["status"] == "expired"


def test_probation_outcomes(api, worker, owner, pay):
    w = pay
    who = w.p["person"]
    start_pay(api, w, who)
    refused(api, w, w.p["hr"], "select pulse.comp_probation_propose(%s,%s)", (who, Jsonb({"action": "confirm"})), match="not on probation")
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.hr_employment(org_id,person_id,probation_from,probation_to,updated_by) values(%s,%s,current_date-80,current_date+10,%s)", (w.org, who, w.p["hr"]))
        owner.execute("update pulse.comp_record set confirmed_on=null where person_id=%s", (who,))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("select pulse.comp_tick()")
    assert val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))["record"]["status"] == "probation"
    # The tick planned the reviews and told the manager and HR once.
    for _ in range(2):
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("select pulse.comp_tick()")
    # Both reviews (midpoint and final) are due: the manager and HR heard of each exactly once.
    assert len(notes(worker, w, w.p["head"], "comp.probation")) == 2 and len(notes(worker, w, w.p["hr"], "comp.probation")) == 2
    assert any("confirm, extend or end it" in n["title"] for n in notes(worker, w, w.p["hr"], "comp.probation"))
    rid = val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))["probation"]["reviews"][0]["id"]
    denied(api, w, w.p["other"], "select pulse.comp_review_done(%s,'Fine')", (rid,), code=psycopg.errors.NoDataFound)
    as_(api, w, w.p["head"], "select pulse.comp_review_done(%s,'Doing well')", (rid,))
    # Extend (HR, policy "hr"): a later date, a reason; ending needs a founder.
    refused(api, w, w.p["hr"], "select pulse.comp_probation_propose(%s,%s)", (who, Jsonb({"action": "extend", "until": str(TODAY + timedelta(days=5)), "note": "More time"})), match="later date")
    assert val(api, w, w.p["hr"], "select pulse.comp_probation_propose(%s,%s)", (who, Jsonb({"action": "extend", "until": str(TODAY + timedelta(days=40)), "note": "More time"})))["status"] == "approved"
    assert val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))["employment"]["probationTo"] == str(TODAY + timedelta(days=40))
    end = val(api, w, w.p["hr"], "select pulse.comp_probation_propose(%s,%s)", (who, Jsonb({"action": "end", "until": str(TODAY + timedelta(days=15)), "note": "Not a fit"})))
    assert end["status"] == "proposed"
    denied(api, w, w.p["hr2"], "select pulse.comp_probation_decide(%s,'approve',null)", (end["id"],))
    as_(api, w, w.p["founder"], "select pulse.comp_probation_decide(%s,'reject','Give it the extension')", (end["id"],))
    # Confirm: status confirmed, the stage is active, remaining reviews close.
    as_(api, w, w.p["hr"], "select pulse.comp_probation_propose(%s,%s)", (who, Jsonb({"action": "confirm"})))
    rec = val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))
    assert rec["record"]["status"] == "confirmed" and rec["person"]["stage"] == "active" and all(v["status"] != "due" for v in rec["probation"]["reviews"])
    # Founder-only policy: confirming waits for a founder.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.hr_employment(org_id,person_id,probation_from,probation_to,updated_by) values(%s,%s,current_date-10,current_date+50,%s)", (w.org, w.p["other"], w.p["hr"]))
    start_pay(api, w, w.p["other"], on=TODAY - timedelta(days=10))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.comp_record set confirmed_on=null where person_id=%s", (w.p["other"],))
    as_(api, w, w.p["founder"], "select pulse.comp_policy_save(%s)", (Jsonb({"probationApproval": "founder"}),))
    assert val(api, w, w.p["hr"], "select pulse.comp_probation_propose(%s,%s)", (w.p["other"], Jsonb({"action": "confirm"})))["status"] == "proposed"


def test_probation_end_moves_to_notice_and_opens_the_leaving_case(api, worker, owner, pay):
    w = pay
    who = w.p["person"]
    start_pay(api, w, who)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.hr_employment(org_id,person_id,probation_from,probation_to,updated_by) values(%s,%s,current_date-30,current_date+60,%s)", (w.org, who, w.p["hr"]))
        owner.execute("update pulse.comp_record set confirmed_on=null where person_id=%s", (who,))
    end = val(api, w, w.p["hr"], "select pulse.comp_probation_propose(%s,%s)", (who, Jsonb({"action": "end", "until": str(TODAY + timedelta(days=15)), "note": "Not a fit"})))
    as_(api, w, w.p["founder"], "select pulse.comp_probation_decide(%s,'approve',null)", (end["id"],))
    rec = val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))
    assert rec["record"]["status"] == "notice" and rec["person"]["stage"] == "notice" and rec["leavingCase"]["leftType"] == "terminated"
    assert rec["employment"]["lastWorkingDay"] == str(TODAY + timedelta(days=15))


def test_pauses_and_payroll(api, worker, pay):
    w = pay
    who = w.p["person"]
    denied(api, w, w.p["hr"], "select pulse.comp_pause_save(%s)", (Jsonb({"person": str(w.p["hr"]), "from": str(TODAY), "to": str(TODAY), "reasonKind": "hold", "note": "Mine"}),))
    refused(api, w, w.p["hr"], "select pulse.comp_pause_save(%s)", (Jsonb({"person": str(who), "from": str(TODAY), "to": str(TODAY), "reasonKind": "hold", "note": "No pay"}),), match="Set up")
    start_pay(api, w, who)
    first = TODAY.replace(day=1)
    pid = val(api, w, w.p["hr"], "select pulse.comp_pause_save(%s)", (Jsonb({"person": str(who), "from": str(first), "to": str(first + timedelta(days=9)), "paidPercent": 50,
                                                                              "reasonKind": "unpaid_leave", "note": "Family matter"}),))
    refused(api, w, w.p["hr"], "select pulse.comp_pause_save(%s)", (Jsonb({"person": str(who), "from": str(first + timedelta(days=5)), "to": str(first + timedelta(days=12)),
                                                                           "reasonKind": "hold", "note": "Overlap"}),), match="covers")
    denied(api, w, w.p["hr"], "select pulse.comp_pause_decide(%s,'approve',null)", (pid,))
    assert val(api, w, w.p["founder"], "select pulse.comp_pause_decide(%s,'approve',null)", (pid,)) == "approved"
    import calendar
    days = calendar.monthrange(first.year, first.month)[1]
    with worker.transaction():
        set_tenant(worker, w.org)
        factor = worker.execute("select pulse.comp_pause_factor(%s,%s) f", (who, first)).fetchone()["f"]
    assert abs(float(factor) - (1 - 10 * 0.5 / days)) < 1e-9
    denied(api, w, w.p["other"], "select pulse.comp_pause_factor(%s,%s)", (who, first))
    if TODAY <= first + timedelta(days=9):
        assert val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))["record"]["status"] == "paused"
    # Ending early is HR's; the factor follows.
    as_(api, w, w.p["hr"], "select pulse.comp_pause_close(%s,'end',%s)", (pid, first + timedelta(days=4)))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert abs(float(worker.execute("select pulse.comp_pause_factor(%s,%s) f", (who, first)).fetchone()["f"]) - (1 - 5 * 0.5 / days)) < 1e-9
    # The payslip projection pays paused days at their share (payroll respects pauses).
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""insert into pulse_priv.hr_compensation(org_id,person_id,effective_month,kind,amount,source_file_id,source_name,source_sheet,basis)
            values(%s,%s,%s,'current',1000,'syn','Synthetic','Sheet','synthetic')""", (w.org, who, first - timedelta(days=40)))
    src = val(api, w, w.p["hr"], "select pulse.hr_payslip_source(%s,%s)", (who, first))
    assert abs(float(src["payShare"]) - (1 - 5 * 0.5 / days)) < 1e-9 and abs(float(src["gross"]) - round(1000 * (1 - 5 * 0.5 / days), 2)) < 0.01


def test_one_time_items(api, worker, pay):
    w = pay
    who = w.p["person"]
    start_pay(api, w, who)
    refused(api, w, w.p["hr"], "select pulse.comp_item_save(%s)", (Jsonb({"person": str(who), "kind": "advance", "reason": "Rent deposit", "sealed": SEALED}),), match="Recover")
    adv = val(api, w, w.p["hr"], "select pulse.comp_item_save(%s)", (Jsonb({"person": str(who), "kind": "advance", "reason": "Rent deposit", "recoverMonths": 3, "sealed": SEALED}),))
    bonus = val(api, w, w.p["hr"], "select pulse.comp_item_save(%s)", (Jsonb({"person": str(who), "kind": "overtime", "reason": "Night shoot", "ref": {"dates": [str(TODAY)]}, "sealed": SEALED}),))
    # The person sees no proposed item; once approved, its amount is theirs to read.
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, who, "select * from pulse.comp_sealed('item',%s)", (bonus,))
    denied(api, w, w.p["hr"], "select pulse.comp_item_decide(%s,'approve',null)", (bonus,))
    as_(api, w, w.p["founder"], "select pulse.comp_item_decide(%s,'approve',null)", (bonus,))
    as_(api, w, w.p["founder"], "select pulse.comp_item_decide(%s,'reject','Not now')", (adv,))
    assert one(api, w, who, "select person_id from pulse.comp_sealed('item',%s)", (bonus,))["person_id"] == who
    assert [i["status"] for i in val(api, w, who, "select pulse.comp_me()")["items"]] == ["approved"]
    assert [n["title"] for n in notes(worker, w, who, "comp.letter")] == ["Overtime pay was added to your pay"]


def test_claims(api, worker, pay):
    w = pay
    who = w.p["person"]

    def claim(sha, dup, above=False, category="travel"):
        return val(api, w, who, "select pulse.comp_claim_submit(%s)", (Jsonb({"category": category, "spentOn": str(TODAY - timedelta(days=2)), "vendor": "Synthetic Cabs",
                                                                              "sealed": SEALED, "receipt": SEALED, "receiptMime": "image/jpeg", "receiptSize": 1200,
                                                                              "receiptSha256": sha, "dupKey": dup, "aboveThreshold": above}),))
    refused(api, w, who, "select pulse.comp_claim_submit(%s)", (Jsonb({"category": "yachts", "spentOn": str(TODAY), "sealed": SEALED, "receipt": SEALED}),), match="category")
    small = claim("1" * 64, "a" * 64)
    refused(api, w, who, "select pulse.comp_claim_submit(%s)", (Jsonb({"category": "travel", "spentOn": str(TODAY), "sealed": SEALED, "receipt": SEALED, "receiptMime": "image/jpeg",
                                                                       "receiptSize": 10, "receiptSha256": "1" * 64, "dupKey": "b" * 64}),), match="already claimed")
    refused(api, w, who, "select pulse.comp_claim_submit(%s)", (Jsonb({"category": "travel", "spentOn": str(TODAY), "sealed": SEALED, "receipt": SEALED, "receiptMime": "image/jpeg",
                                                                       "receiptSize": 10, "receiptSha256": "2" * 64, "dupKey": "a" * 64}),), match="already claimed")
    big = claim("3" * 64, "c" * 64, above=True)
    assert len(notes(worker, w, w.p["head"], "comp.waiting")) == 2
    # The head reads the bill they decide on; a colleague does not.
    assert one(api, w, w.p["head"], "select person_id from pulse.comp_sealed('receipt',%s)", (small,))["person_id"] == who
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.p["other"], "select * from pulse.comp_sealed('receipt',%s)", (small,))
    denied(api, w, who, "select pulse.comp_claim_decide(%s,'approve',null)", (small,))
    denied(api, w, w.p["other"], "select pulse.comp_claim_decide(%s,'approve',null)", (small,))
    assert val(api, w, w.p["head"], "select pulse.comp_claim_decide(%s,'approve',null)", (small,)) == "approved"
    assert val(api, w, w.p["head"], "select pulse.comp_claim_decide(%s,'approve',null)", (big,)) == "head_approved"
    assert any("waiting" in n["title"] for n in notes(worker, w, w.p["hr"], "comp.waiting"))
    denied(api, w, w.p["head"], "select pulse.comp_claim_decide(%s,'approve',null)", (big,))
    assert val(api, w, w.p["hr"], "select pulse.comp_claim_decide(%s,'approve',null)", (big,)) == "approved"
    assert [n["title"] for n in notes(worker, w, who, "comp.claim")] == ["Your reimbursement claim was approved"] * 2
    # Withdrawn or rejected bills free their receipt for a corrected claim; HR decides headless claims.
    third = claim("4" * 64, "d" * 64, category="meals")
    as_(api, w, who, "select pulse.comp_claim_decide(%s,'withdraw',null)", (third,))
    claim("4" * 64, "d" * 64, category="meals")
    hr_claim = val(api, w, w.p["other"], "select pulse.comp_claim_submit(%s)", (Jsonb({"category": "internet", "spentOn": str(TODAY), "sealed": SEALED, "receipt": SEALED,
                                                                                       "receiptMime": "application/pdf", "receiptSize": 99, "receiptSha256": "5" * 64, "dupKey": "e" * 64}),))
    assert [c["id"] for c in val(api, w, w.p["hr"], "select pulse.comp_claims_waiting()") if c["id"] == str(hr_claim)]
    refused(api, w, w.p["hr"], "select pulse.comp_claim_decide(%s,'reject',null)", (hr_claim,), match="Say why")


def test_full_and_final(api, worker, pay):
    w = pay
    who = w.p["person"]
    start_pay(api, w, who)
    body = {"person": str(who), "exitKind": "terminated", "lastDay": str(TODAY + timedelta(days=5)), "noticeMode": "paid_in_lieu", "sealed": SEALED}
    denied(api, w, w.p["other"], "select pulse.comp_settlement_save(%s)", (Jsonb(body),))
    sid = val(api, w, w.p["hr"], "select pulse.comp_settlement_save(%s)", (Jsonb(body),))
    assert val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (who,))["record"]["status"] == "notice"
    refused(api, w, w.p["hr"], "select pulse.comp_settlement_step(%s,'check',null)", (sid,), match="legal care")
    as_(api, w, w.p["hr"], "select pulse.comp_settlement_save(%s)", (Jsonb({**body, "legal": {"reason": True, "notice": True, "heard": True, "dues": True}}),))
    refused(api, w, w.p["founder"], "select pulse.comp_settlement_step(%s,'approve',null)", (sid,), match="checks")
    as_(api, w, w.p["founder"], "select pulse.comp_settlement_step(%s,'check',null)", (sid,))
    denied(api, w, w.p["founder"], "select pulse.comp_settlement_step(%s,'approve',null)", (sid,))
    denied(api, w, w.p["hr"], "select pulse.comp_settlement_step(%s,'approve',null)", (sid,))
    assert val(api, w, w.p["founder2"], "select pulse.comp_settlement_step(%s,'approve',null)", (sid,)) == "approved"
    # The person reads the statement only once the letter is out.
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, who, "select * from pulse.comp_sealed('settlement',%s)", (sid,))
    letter(api, w, w.p["hr"], "settlement", sid, kind="settlement")
    assert one(api, w, who, "select person_id from pulse.comp_sealed('settlement',%s)", (sid,))["person_id"] == who
    assert val(api, w, who, "select pulse.comp_me()")["settlement"]["status"] == "issued"
    assert [r["settlement"]["status"] for r in val(api, w, w.p["hr"], "select pulse.comp_people()")["people"] if r["id"] == str(who)] == ["issued"]


def test_accountant_gets_totals_only_and_the_timeline_holds_no_amounts(api, worker, owner, pay):
    w = pay
    for n in ["person", "other"]:
        start_pay(api, w, w.p[n])
    # The Accountant reaches pay only through the month's totals (the API opens the values and returns the sum alone):
    # keys are anonymous; no per-person read is open to them.
    rows = as_(api, w, w.p["ca"], "select person_key from pulse.comp_month_sealed(%s)", (TODAY,))
    assert len(rows) == 2 and all(len(r["person_key"]) == 32 and r["person_key"] not in (str(w.p["person"]), str(w.p["other"])) for r in rows)
    for sql in ["select pulse.comp_people()", "select pulse.comp_person(%s)", "select * from pulse.comp_history_sealed(%s)"]:
        denied(api, w, w.p["ca"], sql, (w.p["person"],) if "%s" in sql else ())
    assert as_(api, w, w.p["ca"], "select * from pulse.comp_figures(%s,null)", ([w.p["person"]],)) == []
    assert {r["person_key"] for r in as_(api, w, w.p["hr"], "select person_key from pulse.comp_month_sealed(%s)", (TODAY,))} == {str(w.p["person"]), str(w.p["other"])}
    denied(api, w, w.p["other"], "select * from pulse.comp_month_sealed(%s)", (TODAY,))
    with owner.transaction():
        set_tenant(owner, w.org)
        with pytest.raises(psycopg.errors.CheckViolation):
            owner.execute("insert into pulse.comp_event(org_id,person_id,kind,detail) values(%s,%s,'change.proposed','{\"amount\":1}')", (w.org, w.p["person"]))
    # Notices about pay carry no amount (no figure in any title beyond a date).
    titles = [r["title"] for r in worker_rows(worker, w, "select title from pulse.notification where event_type like 'comp.%%'")]
    assert titles and not any("₹" in t or re.search(r"\d", re.sub(r"\b\d{1,2} [A-Z][a-z]{2}( \d{4})?\b", "", t)) for t in titles)
    # Each person's timeline tells the story in kinds and dates.
    kinds = [e["kind"] for e in val(api, w, w.p["hr"], "select pulse.comp_person(%s)", (w.p["person"],))["timeline"]]
    assert "change.approved" in kinds and "change.proposed" in kinds


def _api_world(worker, owner, api, names=None):
    """People for the API runner, each signing in by their Access address (role@comp.example)."""
    from conftest import dsn
    from psycopg.conninfo import conninfo_to_dict
    w = build_world(worker, owner, api)
    roles = {r: uuid.uuid4() for r in ["hr", "founder", "founder2", "person", "head", "other", "admin", "candidate"]}
    with worker.transaction():
        set_tenant(worker, w.org)
        for role, pid in roles.items():
            worker.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,%s,'staff',%s)",
                           (pid, w.org, (names or {}).get(role, "Synthetic " + role.title()), "inactive" if role == "candidate" else "active"))
        for role, pid in roles.items():
            worker.execute("insert into pulse.people_profile(org_id,person_id,role,pod,evidence,username,email,manager_id) values(%s,%s,%s,'Pod 9','{}',%s,%s,%s)",
                           (w.org, pid, "Editor (proposed)" if role == "candidate" else role.title(), "comp." + role, role + "@delivery.example",
                            roles["head"] if role in ("person", "candidate") else None))
            worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, role + "@comp.example", pid))
        for role, key in [("hr", "hr"), ("founder", "leadership"), ("founder2", "leadership"), ("admin", "admin")]:
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, roles[role], key))
    with owner.transaction():
        set_tenant(owner, w.org)
        for role in ["founder", "founder2"]:
            owner.execute("insert into pulse.hr_cofounder(org_id,person_id,assigned_by) values(%s,%s,%s)", (w.org, roles[role], roles[role]))
        owner.execute("insert into pulse.person_lifecycle(org_id,person_id,stage,since) values(%s,%s,'offer',current_date)", (w.org, roles["candidate"]))
    config = conninfo_to_dict(dsn("api")); config["database"] = config.pop("dbname")
    wc = conninfo_to_dict(dsn("migrate")); wc["database"] = wc.pop("dbname")
    return w, roles, config, wc


def test_comp_through_the_api(worker, owner, api, tmp_path):
    import json
    import os
    import subprocess
    from pathlib import Path
    w, roles, config, wc = _api_world(worker, owner, api)
    keys = tmp_path / "keys"; keys.mkdir(mode=0o700)
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org),
           "TEST_ROLES": json.dumps({r: str(p) for r, p in roles.items()}), "TEST_REPORT": str(tmp_path / "comp.json"), "TEST_KEY_DIR": str(keys), "PULSE_CI": "1"}
    env.pop("PULSE_DOCUMENT_KEY_FILE", None)
    result = subprocess.run(["node", "test/comp-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, text=True, capture_output=True, timeout=300)
    assert result.returncode == 0, (result.stdout + "\n" + result.stderr)[-6000:]
    assert json.loads((tmp_path / "comp.json").read_text())["checks"] >= 70
    # The API's own log never carries an amount or a master key.
    log = result.stdout + result.stderr
    for figure in ["6123400", "6750000", "61234", "67,500", "4200000", "125000"]:
        assert figure not in log
    for line in (keys / "document-master.key").read_text().split("\n"):
        if line.strip():
            assert line.split()[1] not in log


@pytest.mark.skipif(__import__("os").environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser flows need PULSE_AUTH_BROWSER=1 and a built web app")
def test_comp_in_the_browser(worker, owner, api, tmp_path):
    import json
    import os
    import subprocess
    from pathlib import Path
    w, roles, config, wc = _api_world(worker, owner, api, names={"candidate": "Kabir Rao", "hr": "Asha Kireteso", "founder": "Meera Iyer", "founder2": "Rumam Menon", "head": "Tara Kapoor"})
    keys = tmp_path / "keys"; keys.mkdir(mode=0o700)
    env = {**os.environ, "TEST_API_CONFIG": json.dumps(config), "TEST_OWNER_CONFIG": json.dumps(wc), "PULSE_ORG_ID": str(w.org),
           "TEST_ROLES": json.dumps({r: str(p) for r, p in roles.items()}), "TEST_REPORT": str(tmp_path / "browser.json"), "TEST_KEY_DIR": str(keys), "PULSE_CI": "1"}
    p = subprocess.run(["node", "test/comp-browser.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=2400, check=False)
    report = json.loads((tmp_path / "browser.json").read_text()) if (tmp_path / "browser.json").exists() else None
    assert p.returncode == 0 and report and not report["failed"], (p.stderr + p.stdout)[-8000:]
