"""TASKS-P0 (0162): unlocked is a moment, the notes' checklist, the same work (never merged on its own), the company's
project categories and who may open a protected document on a task. Synthetic tenants only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, new_task, notes, one, team  # noqa: F401  (fixture)


def test_finishing_a_blocker_unlocks_the_work_that_waited_only_on_it(api, worker, team):  # noqa: F811
    w = team
    blocker = new_task(api, w, w.editor2, title="Send the room list", assigneeId=str(w.editor2))
    other = new_task(api, w, w.editor2, title="Confirm the caterer", assigneeId=str(w.editor2))
    waiting = new_task(api, w, w.editor2, title="Book the rooms", assigneeId=str(w.editor))
    twice = new_task(api, w, w.editor2, title="Print the badges", assigneeId=str(w.editor))
    as_(api, w, w.editor2, "select pulse.task_value_set(%s,%s)", (waiting, Jsonb({"valuePoints": 5})))
    for t, b in ((waiting, blocker), (twice, blocker), (twice, other)):
        as_(api, w, w.editor2, "select pulse.task_block(%s,%s,null)", (t, b))
    assert one(api, w, w.editor, "select status from pulse.task where id=%s", (waiting,))["status"] == "blocked"
    released = one(api, w, w.editor2, "select pulse.task_move(%s,'done',null) r", (blocker,))["r"]
    assert released["released"] == 1
    row = one(api, w, w.editor, "select status,unlocked_at,unlocked_by from pulse.task where id=%s", (waiting,))
    assert row["status"] == "open" and row["unlocked_at"] is not None and row["unlocked_by"] == blocker
    # Still waiting on the caterer: not unlocked, nobody told.
    assert one(api, w, w.editor, "select status,unlocked_at from pulse.task where id=%s", (twice,)) == {"status": "blocked", "unlocked_at": None}
    told = [n for n in notes(worker, w, w.editor, "task.unblocked") if n["subject_id"] in (waiting, twice)]
    first = one(api, w, w.editor2, "select split_part(display_name,' ',1) n from pulse.person where id=%s", (w.editor2,))["n"]
    assert [(n["subject_id"], n["title"]) for n in told] == [(waiting, f"Unlocked: Book the rooms · {first} finished Send the room list")], "no value in the notice (INTEGRITY 0910)"
    assert one(api, w, w.editor, "select kind,to_value from pulse.task_event where task_id=%s and kind='unlocked'", (waiting,)) == {"kind": "unlocked", "to_value": "Send the room list"}
    # A cancelled blocker frees blocked work the old way: back to work, "Unblocked", but no unlocked moment.
    as_(api, w, w.editor2, "select pulse.task_move(%s,'cancelled',null)", (other,))
    assert one(api, w, w.editor, "select status,unlocked_at from pulse.task where id=%s", (twice,)) == {"status": "open", "unlocked_at": None}
    assert any(n["subject_id"] == twice and n["title"] == "Unblocked: Print the badges" for n in notes(worker, w, w.editor, "task.unblocked"))


def test_the_doer_ticks_the_steps_in_the_notes(api, worker, team):  # noqa: F811
    w = team
    t = new_task(api, w, w.editor2, title="Decide the check-in rules", assigneeId=str(w.editor), notes="1. Arrival\n2. Reminders")
    assert one(api, w, w.editor, "select pulse.task_check_set(%s,'sab12','Arrival',true) r", (t,))["r"] == {"done": 1}
    assert one(api, w, w.editor, "select pulse.task_check_set(%s,'sab12','Arrival',true) r", (t,))["r"] == {"done": 1}, "ticking twice keeps one tick"
    assert one(api, w, w.editor, "select count(*)::int n from pulse.task_event where task_id=%s and kind='step'", (t,))["n"] == 1
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.outsider, "select pulse.task_check_set(%s,'sab13','Reminders',true)", (t,))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.task_check_set(%s,'not a key','x',true)", (t,))
    as_(api, w, w.editor, "select pulse.task_check_set(%s,'sab12','Arrival',false)", (t,))
    assert one(api, w, w.editor, "select count(*)::int n from pulse.task_check where task_id=%s", (t,))["n"] == 0
    # The outsider cannot read the ticks of a task they cannot see.
    as_(api, w, w.editor, "select pulse.task_check_set(%s,'sab12','Arrival',true)", (t,))
    assert as_(api, w, w.outsider, "select * from pulse.task_check where task_id=%s", (t,)) == []


def test_the_same_work_is_linked_or_merged_by_hand(api, worker, team):  # noqa: F811
    w = team
    old = new_task(api, w, w.editor2, title="Approve the staff notice that enables check-in", assigneeId=str(w.editor))
    new = new_task(api, w, w.editor2, title="Approve staff notice v2", assigneeId=str(w.editor))
    waits = new_task(api, w, w.editor2, title="Publish the notice", assigneeId=str(w.editor2))
    as_(api, w, w.editor2, "select pulse.task_block(%s,%s,null)", (waits, old))
    as_(api, w, w.editor, "select pulse.task_same_set(%s,%s,'linked')", (new, old))
    assert one(api, w, w.editor, "select state from pulse.task_same") == {"state": "linked"}
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.outsider, "select pulse.task_same_set(%s,%s,'dismissed')", (new, old))
    # Nothing merged yet: both open.
    assert {r["status"] for r in as_(api, w, w.editor, "select status from pulse.task where id in (%s,%s)", (new, old))} == {"open"}
    r = one(api, w, w.editor2, "select pulse.task_merge(%s,%s) r", (new, old))["r"]
    assert r["cancelled"] == str(old) and r["links"] == 1
    assert one(api, w, w.editor, "select status from pulse.task where id=%s", (old,))["status"] == "cancelled"
    assert one(api, w, w.editor2, "select blocker_id from pulse.task_link where task_id=%s and cleared_at is null", (waits,))["blocker_id"] == new
    assert one(api, w, w.editor, "select state from pulse.task_same") == {"state": "merged"}
    # A member cannot merge work they may not edit.
    mine = new_task(api, w, w.editor, title="Approve the notice draft")
    theirs = new_task(api, w, w.editor2, title="Approve the notice draft again", assigneeId=str(w.editor2))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.task_merge(%s,%s)", (mine, theirs))


def test_project_categories_are_the_companys_own(api, worker, team):  # noqa: F811
    w = team
    as_(api, w, w.editor, "select pulse.project_category_ensure()")
    assert [r["key"] for r in as_(api, w, w.editor, "select key from pulse.project_category order by sort")] == ["client", "internal", "admin_finance", "launch", "hr"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.project_category_save(%s)", (Jsonb({"label": "Events"}),))
    key = one(api, w, w.manager, "select pulse.project_category_save(%s) k", (Jsonb({"label": "Events & shows", "icon": "calendar", "color": "pink"}),))["k"]
    assert key == "events_shows"
    pid = one(api, w, w.manager, "select pulse.work_project_save(null,%s) r", (Jsonb({"type": "internal", "name": "Pulse launch"}),))["r"]["id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.work_project_style(%s,%s)", (pid, Jsonb({"category": "launch"})))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.manager, "select pulse.work_project_style(%s,%s)", (pid, Jsonb({"category": "nope"})))
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.manager, "select pulse.work_project_style(%s,%s)", (uuid.uuid4(), Jsonb({"category": "launch"})))
    as_(api, w, w.manager, "select pulse.work_project_style(%s,%s)", (pid, Jsonb({"category": "launch", "color": "violet", "icon": "rocket"})))
    assert one(api, w, w.manager, "select project_category,color,icon from pulse.work_project where project_id=%s", (pid,)) == {"project_category": "launch", "color": "violet", "icon": "rocket"}


def test_who_may_open_a_protected_document_on_a_task(api, worker, owner, team):  # noqa: F811
    w = team
    t = new_task(api, w, w.editor2, title="Read your offer letter", assigneeId=str(w.editor))
    with owner.transaction():
        set_tenant(owner, w.org)
        # No RETURNING: the reader policy would hide the new row from the owner too (it is not the person or HR).
        f = uuid.uuid4()
        owner.execute("""insert into pulse_priv.hr_file(id,org_id,person_id,doc_kind,title,name,mime,bytes,sha256,source_key)
            values(%s,%s,%s,'offer','Offer letter','offer.pdf','application/pdf','%%PDF-1.4 synthetic','x','tasks-p0-test')""", (f, w.org, w.editor))
        p = owner.execute("insert into pulse.task_proof(org_id,task_id,kind,label,hr_file_id) values(%s,%s,'document','Offer letter',%s) returning id", (w.org, t, f)).fetchone()["id"]
    name = one(api, w, w.editor, "select display_name from pulse.person where id=%s", (w.editor,))["display_name"]
    assert one(api, w, w.editor, "select readable,person_name from pulse.task_proof_protected(%s)", (t,)) == {"readable": True, "person_name": name}
    assert one(api, w, w.editor2, "select readable,person_name from pulse.task_proof_protected(%s)", (t,)) == {"readable": False, "person_name": None}
    assert as_(api, w, w.outsider, "select * from pulse.task_proof_protected(%s)", (t,)) == []
    assert p
