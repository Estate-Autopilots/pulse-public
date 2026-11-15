"""UX-5B: the task companion's rules, enforced in the database (0420_task_companion.sql). Synthetic tenants only.
The owner's example (13 Oct 2026): "Add the office Wi-Fi and IP in Office presence, and test arrival check-in with 2
people". Saving the office network and two different people's arrival check-ins are database events; when the creator
has confirmed those signals, Pulse marks the task done itself, keeps the trail, tells the doer with Undo, and the
reviewer reviews as usual. Never on a guess: unconfirmed proposals, unmet conditions, open subtasks, missing proof or
the company's "ask" only ever ask."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, new_task, notes, one, team  # noqa: F401  (team is a fixture)

OWNER_TITLE = "Add the office Wi-Fi and IP in Office presence, and test arrival check-in with 2 people"
NETWORK = {"event": "office.network.saved", "label": "Office Wi-Fi and IP saved", "need": 1, "where": {"wifi_count": {"gte": 1}, "ip_count": {"gte": 1}}}
ARRIVALS = {"event": "attendance.office.arrived", "label": "2 people checked in on arriving at the office", "need": 2, "distinct": "subject"}


def do(api, w, who, sql, args=()):
    """A statement with no result rows, as a signed-in person."""
    with api.transaction():
        set_tenant(api, w.org, who)
        api.execute(sql, args)


def companion(api, w, who, task):
    return one(api, w, who, "select pulse.task_companion_read(%s) d", (task,))["d"]


def confirm(api, w, who, task, signals, **extra):
    return one(api, w, who, "select pulse.task_companion_set(%s,%s) d", (task, Jsonb({"signals": signals, **extra})))["d"]


def office(api, w, who, wifi=(), ips=()):
    """HR adds an office (as the Office presence page saves it)."""
    return one(api, w, who, """insert into pulse.presence_office(org_id,name,lat,lng,radius_m,wifi,active,updated_by,public_ip_ranges)
        values(%s,'Synthetic studio',12.97,77.59,150,%s,true,%s,%s::cidr[]) returning id""",
               (w.org, Jsonb([{"ssid": s, "bssids": []} for s in wifi]), who, list(ips)))["id"]


def save_network(api, w, who, office_id, wifi=(), ips=()):
    do(api, w, who, "update pulse.presence_office set wifi=%s,public_ip_ranges=%s::cidr[],updated_at=now(),updated_by=%s where id=%s",
        (Jsonb([{"ssid": s, "bssids": []} for s in wifi]), list(ips), who, office_id))


def arrive(worker, w, person, office_id, via="auto", device=None, owner=None):
    """A phone recognises the office: an automatic check-in (the worker's presence path, no viewer), or the person's own
    check-in that the phone links to the office it saw ("You're at the office: check in?")."""
    with worker.transaction():
        set_tenant(worker, w.org)
        entry = worker.execute("insert into pulse.attendance_entry(org_id,person_id,mode) values(%s,%s,'office') returning id,work_date", (w.org, person)).fetchone()
        if via == "auto":
            worker.execute("""insert into pulse.attendance_event(org_id,person_id,work_date,kind,signals,office_id,entry_id,device_kind)
                values(%s,%s,%s,'auto_check_in','{wifi,geofence}',%s,%s,'phone')""", (w.org, person, entry["work_date"], office_id, entry["id"]))
    if via != "auto":
        # The phone's presence row belongs to the API's device functions; the owner stands in for them here.
        with owner.transaction():
            set_tenant(owner, w.org)
            device = device or owner.execute("insert into pulse.native_device(org_id,person_id,name,platform) values(%s,%s,'Synthetic phone','android') returning id", (w.org, person)).fetchone()["id"]
            owner.execute("""insert into pulse.companion_presence(org_id,device_id,person_id,office_id,consent) values(%s,%s,%s,%s,true)
                on conflict (device_id) do update set office_id=excluded.office_id""", (w.org, device, person, office_id))
            owner.execute("update pulse.companion_presence set checked_entry_id=%s where device_id=%s", (entry["id"], device))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.attendance_entry set checked_out_at=now() where id=%s", (entry["id"],))
    return entry["id"]


def task_row(api, w, who, task):
    return one(api, w, who, "select status,done_at,locked from pulse.task where id=%s", (task,))


def test_owner_example_finishes_itself_with_trail_and_undo(api, worker, owner, team):
    w = team
    # The admin asks HR to do it; HR reviews nothing here (the admin assigned it, so the admin reviews).
    task = new_task(api, w, w.manager, title=OWNER_TITLE, assigneeId=str(w.lead))
    as_(api, w, w.lead, "select pulse.task_move(%s,'in_progress',null)", (task,))
    state = confirm(api, w, w.manager, task, [NETWORK, ARRIVALS])
    assert [(s["label"], s["need"], s["seen"], s["metAt"]) for s in state["signals"]] == [("Office Wi-Fi and IP saved", 1, 0, None), ("2 people checked in on arriving at the office", 2, 0, None)]
    assert state["blocker"] == "waiting" and state["autoDone"] is True and state["confirmedAt"]

    # HR adds the office without its network, then the Wi-Fi alone: neither meets "Wi-Fi and IP".
    oid = office(api, w, w.lead)
    save_network(api, w, w.lead, oid, wifi=["EA-Studio"])
    assert companion(api, w, w.lead, task)["signals"][0]["seen"] == 0
    # Saving the IP too: the event carries counts only, never the network's name or address.
    save_network(api, w, w.lead, oid, wifi=["EA-Studio"], ips=["203.0.113.10/32"])
    with worker.transaction():
        set_tenant(worker, w.org)
        ev = worker.execute("select type,subject,actor,data,source from pulse.event where org_id=%s and type='office.network.saved' order by seq desc limit 1", (w.org,)).fetchone()
    assert ev["data"] == {"wifi_count": 1, "ip_count": 1} and ev["subject"] == f"office:pulse:{oid}" and ev["actor"] == f"person:pulse:{w.lead}" and ev["source"] == "/system/pulse-db"
    state = companion(api, w, w.lead, task)
    assert state["signals"][0]["metAt"] and state["signals"][1]["seen"] == 0 and task_row(api, w, w.lead, task)["status"] == "in_progress"
    # The companion lights up for HR: they made the change and the task is theirs.
    hits = one(api, w, w.lead, "select pulse.task_companion_attention() d")["d"]["hits"]
    assert [(h["task"], h["event"], h["mine"], h["doer"], h["met"]) for h in hits] == [(str(task), "office.network.saved", True, True, False)]
    assert hits[0]["data"] == {"wifi_count": 1, "ip_count": 1}

    # Two different people arrive: the same person twice counts once.
    arrive(worker, w, w.editor, oid)
    arrive(worker, w, w.editor, oid)
    assert companion(api, w, w.lead, task)["signals"][1]["seen"] == 1 and task_row(api, w, w.lead, task)["status"] == "in_progress"
    arrive(worker, w, w.editor2, oid, via="asked", owner=owner)

    # Every signal met exactly: Pulse marked it done itself, kept the trail, told the doer, and the reviewer reviews.
    row = task_row(api, w, w.lead, task)
    assert row["status"] == "done" and row["done_at"] and "status" in row["locked"]
    auto = one(api, w, w.manager, "select prior_status,signals,caused_by,undone_at from pulse.task_auto_done where task_id=%s", (task,))
    assert auto["prior_status"] == "in_progress" and auto["caused_by"] is None and auto["undone_at"] is None
    assert [len(s["events"]) for s in auto["signals"]] == [1, 2]
    hist = one(api, w, w.manager, "select actor_id,from_value,to_value,note from pulse.task_event where task_id=%s and kind='auto_done'", (task,))
    assert hist["actor_id"] is None and hist["to_value"] == "done" and "Office Wi-Fi and IP saved" in hist["note"]
    assert any("Ready to accept" in n["title"] for n in notes(worker, w, w.manager, "task.done"))
    assert any("Pulse marked" in n["title"] for n in notes(worker, w, w.lead, "task.auto_done"))
    told = one(api, w, w.lead, "select pulse.task_companion_attention() d")["d"]["auto"]
    assert [a["task"] for a in told] == [str(task)]

    # Undo: back to how it was, and the task stops finishing itself.
    assert one(api, w, w.lead, "select pulse.task_auto_done_undo(%s) d", (task,))["d"] == {"status": "in_progress"}
    assert task_row(api, w, w.lead, task)["status"] == "in_progress"
    assert companion(api, w, w.lead, task)["autoDone"] is False
    assert one(api, w, w.lead, "select pulse.task_companion_attention() d")["d"]["auto"] == []
    # RELEASE-5: nor does it ask "Everything it needs has happened. Mark … done?" about the same events right after the
    # person said it was not done yet; the trail stays, and they mark it done themselves when it is.
    assert one(api, w, w.lead, "select pulse.task_companion_attention() d")["d"]["hits"] == []
    assert [s["metAt"] is not None for s in companion(api, w, w.lead, task)["signals"]] == [True, True]
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.lead, "select pulse.task_auto_done_undo(%s)", (task,))


def test_never_on_a_guess(api, worker, team):
    w = team
    oid = office(api, w, w.lead)
    # Pip's proposal alone counts for nothing; a destination only lights the companion up, it never finishes a task.
    guess = new_task(api, w, w.lead, title="Add the office Wi-Fi")
    as_(api, w, w.lead, "select pulse.task_companion_set(%s,%s)", (guess, Jsonb({"target": "hr.policies.presence.wifi", "targetEvents": ["office.network.saved"]})))
    # Each rule that stands in the way, one task each, all with their signals met by the same events.
    sub = new_task(api, w, w.lead, title="Office network with a subtask")
    new_task(api, w, w.lead, title="Label the router", parentId=str(sub))
    proof_project = one(api, w, w.manager, "select id from pulse.project where id=%s", (w.project,))["id"]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set requires_proof=true where id=%s", (proof_project,))
    proof = new_task(api, w, w.lead, title="Office network, proof needed", projectId=str(proof_project))
    asks = new_task(api, w, w.lead, title="Office network, ask me")
    wifi = {"event": "office.network.saved", "label": "Office Wi-Fi saved", "where": {"wifi_count": {"gte": 1}}}
    for t in (sub, proof, asks):
        confirm(api, w, w.lead, t, [wifi])
    as_(api, w, w.lead, "select pulse.task_companion_set(%s,%s)", (asks, Jsonb({"autoDone": False})))
    # A condition that does not match counts nothing: the IP alone is not the Wi-Fi.
    ip_only = new_task(api, w, w.lead, title="Office Wi-Fi only")
    confirm(api, w, w.lead, ip_only, [wifi])
    save_network(api, w, w.lead, oid, ips=["203.0.113.10/32"])
    assert companion(api, w, w.lead, ip_only)["signals"][0]["seen"] == 0
    save_network(api, w, w.lead, oid, wifi=["EA-Studio"], ips=["203.0.113.10/32"])
    for t, why in ((sub, "subtasks"), (proof, "proof"), (asks, "task_asks"), (guess, "unconfirmed")):
        assert task_row(api, w, w.lead, t)["status"] == "open", why
        assert companion(api, w, w.lead, t)["blocker"] == why
    assert companion(api, w, w.lead, ip_only)["signals"][0]["metAt"]
    assert task_row(api, w, w.lead, ip_only)["status"] == "done"
    # The destination's event still lit the companion up for the guess task, as a question.
    hits = {h["task"]: h for h in one(api, w, w.lead, "select pulse.task_companion_attention() d")["d"]["hits"]}
    assert hits[str(guess)]["event"] == "office.network.saved" and hits[str(guess)]["met"] is False
    as_(api, w, w.lead, "select pulse.task_companion_seen(%s)", (guess,))
    assert str(guess) not in {h["task"] for h in one(api, w, w.lead, "select pulse.task_companion_attention() d")["d"]["hits"]}
    # The company's "ask" stops every task finishing itself.
    one(api, w, w.manager, "select pulse.work_settings_set(%s) r", (Jsonb({"autoDone": "ask"}),))
    later = new_task(api, w, w.lead, title="Second office network")
    confirm(api, w, w.lead, later, [wifi])
    save_network(api, w, w.lead, oid, wifi=["EA-Studio", "EA-Studio-5G"], ips=["203.0.113.10/32"])
    assert companion(api, w, w.lead, later)["blocker"] == "company_asks" and task_row(api, w, w.lead, later)["status"] == "open"


def test_events_since_the_task_count_at_confirmation_and_never_fail_the_change(api, worker, owner, team):
    w = team
    task = new_task(api, w, w.lead, title="Publish the staff notice")
    # Published before the signal was confirmed, after the task was made: the log is exact, so it counts.
    as_(api, w, w.lead, "select pulse.policy_save('conduct','Code of conduct','Be kind to each other at work.','published',0)")
    state = confirm(api, w, w.lead, task, [{"event": "policy.published", "label": "Policy published"}])
    assert state["signals"][0]["metAt"] and state["blocker"] is None
    # Confirming never finishes a task by itself: the person confirming sees it already happened and marks it done.
    assert task_row(api, w, w.lead, task)["status"] == "open"
    # An event the registry does not know is refused quietly: the change that caused it still happens.
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select pulse.app_event('nope.unknown','x:pulse:1','{}') s").fetchone()["s"] is None
    # Only the database's own triggers emit: the API cannot call it.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.lead, "select pulse.app_event('office.added','office:pulse:1','{}') s")
    with worker.transaction():
        set_tenant(worker, w.org)
        made = worker.execute("select count(*)::int n from pulse.event where org_id=%s and source='/system/pulse-db' and type like 'nope%%'", (w.org,)).fetchone()["n"]
    assert made == 0


def test_who_may_confirm_and_what_a_signal_may_say(api, worker, team):
    w = team
    task = new_task(api, w, w.editor, title="Add the office IP")
    bad = [({"signals": [{"event": "office.network.saved", "where": {"ssid": {"eq": "x"}}}]}, "not part of"),
           ({"signals": [{"event": "nope.unknown"}]}, "Unknown signal"),
           ({"signals": [{"event": "office.network.saved", "need": 0}]}, "1 to 50"),
           ({"signals": [{"event": "office.network.saved", "where": {"ip_count": {"gte": "1"}}}]}, "at least a number"),
           ({"signals": []}, "one to six"),
           ({"target": "Not An Id"}, "place in Pulse")]
    for body, words in bad:
        with pytest.raises(psycopg.errors.InvalidParameterValue, match=words):
            as_(api, w, w.editor, "select pulse.task_companion_set(%s,%s)", (task, Jsonb(body)))
    # Someone outside the task cannot confirm its signals, nor read them.
    with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.NoDataFound)):
        as_(api, w, w.outsider, "select pulse.task_companion_set(%s,%s)", (task, Jsonb({"signals": [{"event": "office.network.saved"}]})))
    with pytest.raises(psycopg.errors.NoDataFound):
        companion(api, w, w.outsider, task)
    # The pod head may; the doer sees the same.
    confirm(api, w, w.editor2, task, [{"event": "office.network.saved", "label": "Office IP saved", "where": {"ip_count": {"gte": 1}}}])
    assert companion(api, w, w.editor, task)["signals"][0]["label"] == "Office IP saved"


def test_registered_events_and_settings(api, worker, owner, team):
    w = team
    with owner.transaction():
        types = {r["type"]: r for r in owner.execute("select type,emitters,data_allowed,sensitivity,visibility from pulse.event_type where type = any(%s)", (
            ["office.added", "office.network.saved", "attendance.checked_in", "attendance.office.arrived", "checkin.arrival.saved", "checkin.reminders.saved",
             "payroll.cutoff.saved", "presence.auto.saved", "policy.published", "holiday.added", "leave.decided", "project.added", "client.added"],)).fetchall()}
    assert len(types) == 13 and all(t["emitters"] == ["/system/pulse-db"] for t in types.values())
    assert types["attendance.office.arrived"]["visibility"] == "person" and types["attendance.office.arrived"]["sensitivity"] == 1
    assert sorted(types["office.network.saved"]["data_allowed"]) == ["ip_count", "wifi_count"]
    # HR's check-in setting saves arrive as events through the change history every save writes.
    do(api, w, w.lead, "insert into pulse.record_change(org_id,entity_type,entity_id,field,old_value,new_value,changed_by) values(%s,'hr_policy',%s,'presenceArrival','ask','auto',%s)", (w.org, w.org, w.lead))
    with worker.transaction():
        set_tenant(worker, w.org)
        ev = worker.execute("select subject,data from pulse.event where org_id=%s and type='checkin.arrival.saved' order by seq desc limit 1", (w.org,)).fetchone()
    assert ev == {"subject": "setting:pulse:presenceArrival", "data": {"value": "auto"}}
    # The company's choice is leadership's and admins'.
    assert one(api, w, w.manager, "select pulse.work_settings_get() s")["s"]["autoDone"] == "on"
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "select pulse.work_settings_set(%s)", (Jsonb({"autoDone": "always"}),))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.work_settings_set(%s)", (Jsonb({"autoDone": "ask"}),))
    assert uuid.UUID(str(w.org))


def test_waiting_nudges_whoever_does_the_blocker_once_a_day(api, worker, team):
    w = team
    blocker = new_task(api, w, w.editor2, title="Upload the bank statements")
    waiting = new_task(api, w, w.editor, title="Reconcile September")
    as_(api, w, w.editor, "select pulse.task_block(%s,%s,null)", (waiting, blocker))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.task_waiting_tick() n").fetchone()["n"] == 0  # not long enough yet
        worker.execute("update pulse.task_link set created_at=now()-interval '50 hours' where task_id=%s", (waiting,))
        assert worker.execute("select pulse.task_waiting_tick() n").fetchone()["n"] == 1
        assert worker.execute("select pulse.task_waiting_tick() n").fetchone()["n"] == 0  # once a day
    sent = notes(worker, w, w.editor2, "task.waiting")
    assert [n["title"] for n in sent] == ["Editor waits on “Upload the bank statements” (2 days)"] and sent[0]["href"] == f"/tasks/{blocker}"
    # Waiting on your own work nudges nobody.
    mine = new_task(api, w, w.editor, title="Draft the script")
    then = new_task(api, w, w.editor, title="Record the voice-over")
    as_(api, w, w.editor, "select pulse.task_block(%s,%s,null)", (then, mine))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.task_link set created_at=now()-interval '50 hours' where task_id=%s", (then,))
        worker.execute("select pulse.task_waiting_tick()")
    assert notes(worker, w, w.editor, "task.waiting") == []



def test_waiting_nudge_is_one_notice_a_day_per_person(api, worker, team):
    """RELEASE-5 (0435): whoever holds up several tasks hears it once a day, not once per task (production had one person
    with 13 such tasks)."""
    w = team
    pairs = [("Share the logo files", "Lay out the brochure"), ("Send the site photos", "Edit the walkthrough")]
    for blocker_title, waiting_title in pairs:
        blocker = new_task(api, w, w.editor2, title=blocker_title)
        waiting = new_task(api, w, w.editor, title=waiting_title)
        as_(api, w, w.editor, "select pulse.task_block(%s,%s,null)", (waiting, blocker))
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("update pulse.task_link set created_at=now()-interval '50 hours' where task_id=%s", (waiting,))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.task_waiting_tick() n").fetchone()["n"] == 1
        assert worker.execute("select pulse.task_waiting_tick() n").fetchone()["n"] == 0
    sent = notes(worker, w, w.editor2, "task.waiting")
    assert [n["title"] for n in sent] == ["2 of your tasks hold up 2 others, the oldest “Share the logo files” for 2 days"]
    assert sent[0]["href"] == "/tasks?view=me"

def test_repeating_work_makes_the_next_one_with_its_signals(api, worker, team):
    w = team
    task = new_task(api, w, w.lead, title="Send the weekly attendance summary", notes="1. Open HR → Attendance.\n2. Send it.", dueOn="2026-10-05", priority="high")
    as_(api, w, w.lead, "select pulse.task_companion_set(%s,%s)", (task, Jsonb({"target": "hr.attendance", "targetEvents": [], "signals": [{"event": "leave.decided", "label": "Leave decided"}]})))
    assert one(api, w, w.lead, "select pulse.task_repeat_set(%s,'week') d", (task,))["d"] == {"every": "week"}
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.lead, "select pulse.task_repeat_set(%s,'year')", (task,))
    with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.NoDataFound)):
        as_(api, w, w.outsider, "select pulse.task_repeat_set(%s,'day')", (task,))
    as_(api, w, w.lead, "select pulse.task_move(%s,'done',null)", (task,))
    nxt = one(api, w, w.lead, "select t.id,t.title,t.notes,t.status,t.priority,t.due_at,t.assignee_person_id from pulse.task_repeat r join pulse.task t on t.id=r.task_id where r.task_id<>%s", (task,))
    assert nxt["title"] == "Send the weekly attendance summary" and nxt["status"] == "open" and nxt["priority"] == "high" and nxt["assignee_person_id"] == w.lead
    assert nxt["notes"].startswith("1. Open HR") and nxt["due_at"] is not None
    from datetime import datetime, timezone
    assert nxt["due_at"] > datetime.now(timezone.utc), "rolled forward past today"
    state = companion(api, w, w.lead, nxt["id"])
    assert state["target"] == "hr.attendance" and [s["label"] for s in state["signals"]] == ["Leave decided"] and state["confirmedAt"]
    # Finishing the old one again (after a reopen) makes nothing more: the series moved on.
    as_(api, w, w.lead, "select pulse.task_move(%s,'in_progress',null)", (task,))
    as_(api, w, w.lead, "select pulse.task_move(%s,'done',null)", (task,))
    assert one(api, w, w.lead, "select count(*)::int n from pulse.task where title='Send the weekly attendance summary' and deleted_at is null")["n"] == 2
    assert one(api, w, w.lead, "select pulse.task_repeat_set(%s,null) d", (nxt["id"],))["d"] == {"every": None}


BROWSER = pytest.mark.skipif(__import__("os").environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")


def _person(worker, api, w, name, role, handle, user_no):
    """A synthetic colleague who signs in, with a role and the staff notice acknowledged."""
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, name))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username,pod) values(%s,%s,%s,'test',%s,%s,'Pod 1')",
                       (w.org, pid, role.title(), user_no, f"{handle}{user_no}"))
        worker.execute("insert into pulse.role_assignment(org_id,person_id,unit_id,role_key,is_manager_of_unit,valid_from) values(%s,%s,%s,%s,false,'2026-01-01')", (w.org, pid, w.pod, role))
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"{handle}@{w.domain}", pid))
    with api.transaction():
        set_tenant(api, w.org)
        api.execute("insert into privacy.notice_ack(org_id,person_id,notice_id,language,acknowledged_at,channel) values(%s,%s,'staff-v1','en',now()-interval '20 days','web')", (w.org, pid))
    return pid


@BROWSER
def test_ux5b_flows_in_the_browser(worker, owner, api, team, tmp_path):
    """The owner's example end to end on a production build (services/api/test/ux5b-runner.mjs)."""
    import json
    import os
    import subprocess
    from pathlib import Path
    from conftest import dsn
    from test_tasks3 import _config
    w = team
    hr = _person(worker, api, w, "Asha Rao", "hr", "asha", 51)
    admin = _person(worker, api, w, "Neha Soniba", "admin", "neha", 52)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account') on conflict do nothing",
                       (w.org, f"editor2@{w.domain}", w.editor2))
    ids = {"org": str(w.org), "hr": str(hr), "admin": str(admin), "member": str(w.editor), "head": str(w.editor2)}
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": _config(dsn("api")), "TEST_WORKER_CONFIG": _config(dsn("worker")),
           "TEST_ADMIN": f"neha@{w.domain}", "TEST_HR": f"asha@{w.domain}", "TEST_MEMBER": w.editor_handle, "TEST_HEAD": f"editor2@{w.domain}",
           "TEST_IDS": json.dumps(ids), "PULSE_UX5B_REPORT": str(tmp_path / "ux5b.json")}
    p = subprocess.run(["node", "test/ux5b-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=2400, check=False)
    report = json.loads((tmp_path / "ux5b.json").read_text()) if (tmp_path / "ux5b.json").exists() else None
    print(p.stdout[-6000:])
    assert p.returncode == 0 and report and not report["failed"], (p.stderr + p.stdout)[-8000:]
