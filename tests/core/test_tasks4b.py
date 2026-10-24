"""TASKS-4B: a task's life (doing, finishing, reviewing, value), enforced in the database functions. Synthetic tenants only.
The owner tested Work in production on 12 Oct 2026: a parent was finished with its subtask still open, effort and impact
were graded by hand (founders' work too), the review queue was easy to miss and Pip's value was hard to explain."""
import json
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from conftest import dsn
from test_tasks_rt1 import as_, new_task, notes, one, team  # noqa: F401  (team is a fixture)

BROWSER = pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")


def move(api, w, who, task, status, note=None):
    return one(api, w, who, "select pulse.task_move(%s,%s,%s) r", (task, status, note))["r"]


def settings(api, w, **p):
    return one(api, w, w.manager, "select pulse.work_settings_set(%s) r", (Jsonb(p),))["r"]


def cofounder(worker, owner, w, name="Kedab Founder"):
    """A co-founder on HR's list who signs in; leadership work of a founder is acknowledged, not graded."""
    pid = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,%s,'staff')", (pid, w.org, name))
        worker.execute("insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username,pod) values(%s,%s,'Co-founder','test',41,'kedab41','Pod 1')", (w.org, pid))
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.hr_cofounder(org_id,person_id,assigned_by) values(%s,%s,%s)", (w.org, pid, w.manager))
    return pid


def test_open_subtasks_block_done(api, worker, team):
    """The owner's case: "Zoho…" was marked Done while "Create the Zoho API client" was still open. Now Done is refused
    until each open subtask is finished, moved out or cancelled with a note, by every path a person takes."""
    w = team
    parent = new_task(api, w, w.editor, title="Zoho: confirm Zoho Books and export invoices")
    client = new_task(api, w, w.editor, title="Create the Zoho API client", parentId=str(parent))
    export = new_task(api, w, w.editor, title="Export every invoice", parentId=str(parent))
    old = new_task(api, w, w.editor, title="Old finance desk task", parentId=str(parent))
    move(api, w, w.editor, parent, "in_progress")
    with pytest.raises(psycopg.errors.CheckViolation, match="3 open subtasks"):
        move(api, w, w.editor, parent, "done")
    # The bulk path (My tasks' selection) and a reviewer or leader moving it are refused the same way.
    with pytest.raises(psycopg.errors.CheckViolation):
        move(api, w, w.manager, parent, "done")
    # One tap each: finish, move out (it stays in the project, on its own), cancel with a note.
    move(api, w, w.editor, export, "done")
    as_(api, w, w.editor, "select pulse.task_save(%s,%s)", (old, Jsonb({"parentId": None})))
    with pytest.raises(psycopg.errors.CheckViolation, match="its open subtask"):
        move(api, w, w.editor, parent, "done")
    move(api, w, w.editor, client, "cancelled", "Folded into the finance desk work")
    assert move(api, w, w.editor, parent, "done")["status"] == "done"
    # A finished task takes no new subtasks: reopen it first, or make the work a task of its own.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="finished"):
        new_task(api, w, w.editor, title="One more thing", parentId=str(parent))
    assert one(api, w, w.editor, "select count(*)::int n from pulse.task_flag where task_id=%s", (parent,))["n"] == 0


def test_finished_with_open_subtasks_is_flagged_never_changed(api, worker, team):
    """Work finished while subtasks were open (an import, or a subtask reopened later) is marked for the reviewer;
    the task itself is not touched, and the flag closes when every subtask is closed."""
    w = team
    parent = new_task(api, w, w.editor, title="Brochure retouch")
    child = new_task(api, w, w.editor, title="Check the retouch", parentId=str(parent))
    # The worker (an import) is not a person: it is not stopped, and the finished-with-open case is flagged.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.task set locked='{}' where id=%s", (parent,))  # an import keeps what people locked
        worker.execute("update pulse.task set status='done',done_at=now() where id=%s", (parent,))
    f = one(api, w, w.editor2, "select cause,person_id,detail,resolved_at from pulse.task_flag where task_id=%s", (parent,))
    assert f["cause"] == "finished" and f["person_id"] == w.editor and [x["title"] for x in f["detail"]["open"]] == ["Check the retouch"] and f["resolved_at"] is None
    assert one(api, w, w.editor, "select status from pulse.task where id=%s", (parent,))["status"] == "done"
    # Closing the subtask closes the flag.
    move(api, w, w.editor, child, "done")
    assert one(api, w, w.editor2, "select resolution from pulse.task_flag where task_id=%s", (parent,))["resolution"] == "Every subtask is closed now"
    # A subtask reopened under finished work raises it again (cause: reopened, not counted against the doer).
    move(api, w, w.editor, child, "in_progress")
    assert one(api, w, w.editor2, "select cause from pulse.task_flag where task_id=%s and resolved_at is null", (parent,))["cause"] == "reopened"
    # The reviewer marks it seen; the doer cannot clear their own flag.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.task_flag_resolve(%s,null)", (parent,))
    assert one(api, w, w.editor2, "select pulse.task_flag_resolve(%s,'Fine: the check is a follow-up') n", (parent,))["n"] == 1
    signals = one(api, w, w.editor, "select pulse.person_task_signals(%s,90) s", (w.editor,))["s"]
    assert signals["openSubtasks"] == 1


def test_review_is_one_quality_rating_with_derived_effort_and_impact(api, worker, team):
    """On acceptance the reviewer rates quality once (and may mark above and beyond). Effort comes from captured time
    and size, impact from importance and what the task unlocked."""
    w = team
    t = new_task(api, w, w.editor2, title="Cut the Lakeview teaser", assigneeId=str(w.editor))
    waiting = new_task(api, w, w.editor2, title="Post the teaser", assigneeId=str(w.editor))
    as_(api, w, w.editor, "select pulse.task_block(%s,%s,null)", (waiting, t))
    as_(api, w, w.editor2, "select pulse.task_value_set(%s,%s)", (t, Jsonb({"valuePoints": 8, "estimateMinutes": 240})))
    assert one(api, w, w.editor, "select review_owner_id from pulse.task where id=%s", (t,))["review_owner_id"] == w.editor2
    move(api, w, w.editor, t, "in_progress")
    as_(api, w, w.editor, "select pulse.time_log(%s)", (Jsonb({"taskId": str(t), "date": "2026-10-12", "minutes": 150}),))
    move(api, w, w.editor, t, "done")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.task_review(%s,%s)", (t, Jsonb({"quality": "great"})))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Great, Good or Needs work"):
        as_(api, w, w.editor2, "select pulse.task_review(%s,%s)", (t, Jsonb({"quality": "brilliant"})))
    r = one(api, w, w.editor2, "select pulse.task_review(%s,%s) r", (t, Jsonb({"quality": "great", "above": True, "note": "Client loved it"})))["r"]
    # 150 minutes logged → effort 3; normal importance → impact 2, +1 for unlocking the post → 3 (never from a value:
    # INTEGRITY 0910). Nothing is credited.
    assert (r["kind"], r["quality"], r["effort"], r["impact"], r["points"]) == ("rated", 5, 3, 3, None)
    row = one(api, w, w.editor2, "select review_kind,review_quality,review_above,review_minutes,effort,impact from pulse.task where id=%s", (t,))
    assert row == {"review_kind": "rated", "review_quality": 5, "review_above": True, "review_minutes": 150, "effort": 3, "impact": 3}
    # READY (0971): the reviewer's note stays in the history; it never becomes the task's "Why it matters".
    assert one(api, w, w.editor2, "select value_note from pulse.task where id=%s", (t,))["value_note"] is None
    assert one(api, w, w.editor, "select count(*) n from pulse.work_credit where task_id=%s", (t,))["n"] == 0
    # The five-point scale is a policy choice; the three words always work.
    settings(api, w, reviewScale="five")
    t2 = new_task(api, w, w.editor2, title="Colour pass", assigneeId=str(w.editor))
    move(api, w, w.editor, t2, "done")
    assert one(api, w, w.editor2, "select pulse.task_review(%s,%s) r", (t2, Jsonb({"quality": 3})))["r"]["quality"] == 3


def test_leaders_and_founders_are_acknowledged_not_graded(api, worker, owner, team):
    """A founder's finished task is acknowledged with one tap (or accepted once proof is attached); nobody grades it.
    The older effort × impact accept acknowledges instead. A company may choose to review leadership like everyone."""
    w = team
    kedab = cofounder(worker, owner, w)
    t = new_task(api, w, w.manager, title="Approve staff notice v2", assigneeId=str(kedab))
    assert one(api, w, w.manager, "select review_owner_id,pulse.task_is_leader(%s) leader from pulse.task where id=%s", (kedab, t)) == {"review_owner_id": w.manager, "leader": True}
    move(api, w, w.manager, t, "done")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="acknowledged, not rated"):
        as_(api, w, w.manager, "select pulse.task_review(%s,%s)", (t, Jsonb({"quality": "good"})))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.task_acknowledge(%s,null)", (t,))
    r = one(api, w, w.manager, "select pulse.task_acknowledge(%s,'Thanks') r", (t,))["r"]
    assert r["kind"] == "acknowledged"
    assert one(api, w, w.manager, "select review_kind,review_quality from pulse.task where id=%s", (t,)) == {"review_kind": "acknowledged", "review_quality": None}
    # The older accept route (effort × impact typed in) acknowledges a founder's work instead of grading it.
    t2 = new_task(api, w, w.manager, title="Sign the lease", assigneeId=str(kedab))
    move(api, w, w.manager, t2, "done")
    assert one(api, w, w.manager, "select pulse.task_accept(%s,5,5,null) r", (t2,))["r"]["kind"] == "acknowledged"
    # Members' work cannot be "acknowledged": it is rated.
    m = new_task(api, w, w.editor2, title="Edit the reel", assigneeId=str(w.editor))
    move(api, w, w.editor, m, "done")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Rate this work"):
        as_(api, w, w.editor2, "select pulse.task_acknowledge(%s,null)", (m,))
    # Policy: accepted once proof is attached.
    settings(api, w, reviewLeaders="auto_proof")
    t3 = new_task(api, w, w.manager, title="File GSTR-1", assigneeId=str(kedab))
    move(api, w, w.manager, t3, "done")
    assert one(api, w, w.manager, "select status from pulse.task where id=%s", (t3,))["status"] == "done"
    as_(api, w, w.manager, "select pulse.task_proof_add(%s,'Filed',%s)", (t3, "https://example.test/gstr1"))
    assert one(api, w, w.manager, "select status,review_kind,accepted_by from pulse.task where id=%s", (t3,)) == {"status": "accepted", "review_kind": "auto", "accepted_by": None}
    # Policy: reviewed like everyone's.
    settings(api, w, reviewLeaders="review")
    t4 = new_task(api, w, w.manager, title="Decide the check-in rules", assigneeId=str(kedab))
    move(api, w, w.manager, t4, "done")
    assert one(api, w, w.manager, "select pulse.task_review(%s,%s) r", (t4, Jsonb({"quality": "good"})))["r"]["kind"] == "rated"
    signals = one(api, w, w.manager, "select pulse.person_task_signals(%s,90) s", (kedab,))["s"]
    assert signals["leader"] is True and signals["finished"] == 4


def test_the_reviewer_is_whoever_assigned_it(api, worker, team):
    """By default the reviewer is whoever gave the task; a reviewer someone chose stays; the policy can name the head."""
    w = team
    t = new_task(api, w, w.editor, title="Draft the shot list")
    assert one(api, w, w.editor, "select review_owner_id from pulse.task where id=%s", (t,))["review_owner_id"] == w.editor2  # self-made: the head
    as_(api, w, w.lead, "select pulse.task_save(%s,%s)", (t, Jsonb({"assigneeId": str(w.outsider)})))
    assert one(api, w, w.lead, "select review_owner_id from pulse.task where id=%s", (t,))["review_owner_id"] == w.lead  # HR gave it
    as_(api, w, w.lead, "select pulse.task_save(%s,%s)", (t, Jsonb({"reviewerId": str(w.manager)})))
    as_(api, w, w.lead, "select pulse.task_save(%s,%s)", (t, Jsonb({"assigneeId": str(w.editor)})))
    assert one(api, w, w.lead, "select review_owner_id from pulse.task where id=%s", (t,))["review_owner_id"] == w.manager  # chosen: kept
    settings(api, w, reviewBy="head")
    h = new_task(api, w, w.manager, title="Book the studio", assigneeId=str(w.editor))
    assert one(api, w, w.manager, "select review_owner_id from pulse.task where id=%s", (h,))["review_owner_id"] == w.editor2
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.work_settings_set(%s)", (Jsonb({"reviewBy": "creator"}),))


def test_review_queue_and_a_daily_nudge(api, worker, team):
    """Finished work waiting longer than the policy's hours nudges its reviewer once a day: "N finished tasks wait"."""
    w = team
    ids = [new_task(api, w, w.editor2, title=f"Retouch photo {i}", assigneeId=str(w.editor)) for i in range(3)]
    for t in ids:
        move(api, w, w.editor, t, "done")
    assert {r["id"] for r in as_(api, w, w.editor2, "select pulse.task_review_queue(%s) id", (w.editor2,))} == set(ids)
    # The trackers' history is not waiting for anyone: an imported row marked Done stays out of every queue.
    with worker.transaction():
        set_tenant(worker, w.org)
        imported = worker.execute("insert into pulse.task(org_id,title,status,source,owner_id) values(%s,'Tracker: old reel','done','imported',%s) returning id", (w.org, w.editor)).fetchone()["id"]
    assert imported not in {r["id"] for r in as_(api, w, w.manager, "select pulse.task_review_queue(%s) id", (w.manager,))}
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.task_review_tick() n").fetchone()["n"] == 0  # nothing has waited a day yet
        worker.execute("update pulse.task set done_at=now()-interval '30 hours' where id=any(%s)", (ids,))
        assert worker.execute("select pulse.task_review_tick() n").fetchone()["n"] == 1
        assert worker.execute("select pulse.task_review_tick() n").fetchone()["n"] == 0  # once a day
    nudge = notes(worker, w, w.editor2, "task.review_nudge")
    assert len(nudge) == 1 and nudge[0]["title"].startswith("3 finished tasks wait for your review") and nudge[0]["href"] == "/tasks?view=reviews"
    # READY (0967): when an earlier nudge has expired unread (ATT holds a new one back only while one is live), the next
    # one replaces it: one line waits, not one per day.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.notification set event_key=event_key||':yesterday',created_at=created_at-interval '2 days',expires_at=now()-interval '1 minute' where person_id=%s and event_type='task.review_nudge'", (w.editor2,))
        assert worker.execute("select pulse.task_review_tick() n").fetchone()["n"] == 1
        rows = worker.execute("select dismissed_at is null live,read_at is not null seen from pulse.notification where person_id=%s and event_type='task.review_nudge' order by created_at", (w.editor2,)).fetchall()
    assert [(r["live"], r["seen"]) for r in rows] == [(False, True), (True, False)]


def test_no_value_to_override(api, worker, team):
    """INTEGRITY (owner, 22 Oct 2026): a task carries no value, so leadership has no value to change and Pip learns
    nothing from one: no override is kept, the value stays empty."""
    w = team
    t = new_task(api, w, w.editor2, title="Edit the walkthrough video", assigneeId=str(w.editor))
    as_(api, w, w.editor2, "select pulse.task_suggestion_save(%s,%s)", (t, Jsonb({"valuePoints": 4, "reason": "About 3 h of video edit.", "model": "pip-heuristic", "version": "2"})))
    as_(api, w, w.manager, "select pulse.task_value_set(%s,%s)", (t, Jsonb({"valuePoints": 8})))
    assert one(api, w, w.manager, "select value_points v,ai_suggestion ? 'valuePoints' p from pulse.task where id=%s", (t,)) == {"v": None, "p": False}
    assert one(api, w, w.manager, "select count(*)::int n from pulse.value_override where task_id=%s", (t,))["n"] == 0


def test_signals_are_the_persons_and_their_heads(api, worker, team):
    """Sent back and finished-with-open-subtasks are signals in the person's record, readable by them, their head, HR
    and leadership only."""
    w = team
    t = new_task(api, w, w.editor2, title="Colour grade", assigneeId=str(w.editor))
    move(api, w, w.editor, t, "done")
    as_(api, w, w.editor2, "select pulse.task_return(%s,'The skin tones are off')", (t,))
    s = one(api, w, w.editor2, "select pulse.person_task_signals(%s,30) s", (w.editor,))["s"]
    assert s["sentBack"] == 1 and s["leader"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.person_task_signals(%s,30)", (w.editor,))


@BROWSER
def test_tasks4b_flows_in_the_browser(worker, owner, api, team, tmp_path):
    """The flows on a production build with the synthetic agency (services/api/test/tasks4b-runner.mjs)."""
    from test_tasks3 import _config, _seed_tasks3
    w = team
    ids = _seed_tasks3(api, worker, w)
    kedab = cofounder(worker, owner, w, "Kedab Mifos")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.account(org_id,provider,handle,holder_person_id,purpose) values(%s,'google',%s,%s,'Workspace account')", (w.org, f"kedab@{w.domain}", kedab))
    # Finished by an import while a subtask was open (before the rule): flagged for the reviewer.
    flagged = new_task(api, w, w.editor2, title="Brochure retouch", assigneeId=str(w.editor))
    new_task(api, w, w.editor, title="Check the retouch", parentId=str(flagged))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.task set locked='{}' where id=%s", (flagged,))
        worker.execute("update pulse.task set status='done',done_at=now() where id=%s", (flagged,))
    ids = {**ids, "kedab": str(kedab), "flagged": str(flagged)}
    env = {**os.environ, "PULSE_CI": "1", "PULSE_PUBLIC_LOGIN_ENABLED": "0", "TEST_API_CONFIG": _config(dsn("api")), "TEST_MEMBER": w.editor_handle,
           "TEST_HEAD": f"editor2@{w.domain}", "TEST_OUTSIDER_EMAIL": f"outsider@{w.domain}", "TEST_DEV": f"dev@{w.domain}", "TEST_SANA": f"sana@{w.domain}",
           "TEST_KEDAB": f"kedab@{w.domain}", "TEST_IDS": json.dumps(ids), "PULSE_TASKS4B_REPORT": str(tmp_path / "tasks4b.json")}
    p = subprocess.run(["node", "test/tasks4b-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env, capture_output=True, text=True, timeout=2400, check=False)
    report = json.loads((tmp_path / "tasks4b.json").read_text()) if (tmp_path / "tasks4b.json").exists() else None
    print(p.stdout[-6000:])
    assert p.returncode == 0 and report and not report["failed"], (p.stderr + p.stdout)[-8000:]


def timers(worker, w, person):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select task_id,start_reason,end_reason,minutes,ended_at is null running from pulse.task_timer where person_id=%s order by started_at", (person,)).fetchall()


def backdate_clock(worker, w, person, minutes):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.task_timer set started_at=started_at-make_interval(mins=>%s) where person_id=%s and ended_at is null", (minutes, person))


def test_time_is_captured_from_doing_to_done(api, worker, team):
    """The doer's clock starts at Doing, runs for one task at a time, pauses when blocked and stops at Done; each stretch
    becomes a confirmed time entry. The manual log is a correction."""
    w = team
    # A stretch is split at the company's midnight (one entry per day), and the stretches below reach 90 minutes back: a run
    # between 18:30 and 20:00Z split the first in India into 43 + 47 (main 5dd7ee0, EST-856). Keep midnight 3 hours away.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.org set time_zone=case when (now() at time zone 'UTC')::time<'03:00' then 'Asia/Kolkata' else 'UTC' end where id=%s", (w.org,))
    a = new_task(api, w, w.editor2, title="Edit the Lakeview reel", assigneeId=str(w.editor))
    b = new_task(api, w, w.editor2, title="Caption the Lakeview reel", assigneeId=str(w.editor))
    # A head moving someone's task to Doing does not start their clock; the doer does.
    move(api, w, w.editor2, a, "in_progress")
    assert timers(worker, w, w.editor) == []
    move(api, w, w.editor, a, "open")
    move(api, w, w.editor, a, "in_progress")
    assert [(t["task_id"], t["running"]) for t in timers(worker, w, w.editor)] == [(a, True)]
    backdate_clock(worker, w, w.editor, 90)
    # Starting another pauses the first: one task at a time.
    move(api, w, w.editor, b, "in_progress")
    got = timers(worker, w, w.editor)
    assert (got[0]["end_reason"], got[0]["minutes"], got[1]["task_id"], got[1]["running"]) == ("switched", 90, b, True)
    backdate_clock(worker, w, w.editor, 30)
    move(api, w, w.editor, b, "blocked")
    assert timers(worker, w, w.editor)[-1]["end_reason"] == "blocked"
    # Resume by hand (Start/Resume), then Done stops it.
    as_(api, w, w.editor, "select pulse.task_timer_set(%s,true)", (a,))
    backdate_clock(worker, w, w.editor, 45)
    move(api, w, w.editor, a, "done")
    entries = as_(api, w, w.editor, "select task_id,minutes,status,source from pulse.time_entry where person_id=%s and source='timer' order by created_at", (w.editor,))
    assert [(e["task_id"], e["minutes"], e["status"]) for e in entries] == [(a, 90, "confirmed"), (b, 30, "confirmed"), (a, 45, "confirmed")]
    # Effort at review comes from the captured time (135 min → 3).
    assert one(api, w, w.editor2, "select pulse.task_derived_scores(%s) s", (a,))["s"]["minutes"] == 135
    # Corrections: the person adjusts their own entry; nobody else can.
    e = as_(api, w, w.editor, "select id from pulse.time_entry where task_id=%s and source='timer' order by minutes desc limit 1", (a,))[0]["id"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.time_decide(%s,'adjust',60)", (e,))
    as_(api, w, w.editor, "select pulse.time_decide(%s,'adjust',60)", (e,))
    fixed = one(api, w, w.editor, "select minutes,evidence->'corrected'->>'from' was from pulse.time_entry where id=%s", (e,))
    assert fixed == {"minutes": 60, "was": "90"}
    # Someone else taking the task stops the old doer's clock.
    c = new_task(api, w, w.editor2, title="Grade the Lakeview reel", assigneeId=str(w.editor))
    move(api, w, w.editor, c, "in_progress")
    as_(api, w, w.editor2, "select pulse.task_save(%s,%s)", (c, Jsonb({"assigneeId": str(w.editor2)})))
    assert timers(worker, w, w.editor)[-1]["end_reason"] == "reassigned"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.task_timer_set(%s,true)", (c,))


def test_presence_pauses_and_resumes_the_clock(api, worker, team):
    """Check-out and breaks pause the clock; check-in and the end of the break resume it; a clock left running more than
    ten hours is stopped by Pulse and its time proposed for the person to check."""
    w = team
    t = new_task(api, w, w.editor2, title="Storyboard the Skyline teaser", assigneeId=str(w.editor))
    with worker.transaction():
        set_tenant(worker, w.org)
        entry = worker.execute("insert into pulse.attendance_entry(org_id,person_id,checked_in_at) values(%s,%s,now()-interval '3 hours') returning id", (w.org, w.editor)).fetchone()["id"]
    move(api, w, w.editor, t, "in_progress")
    backdate_clock(worker, w, w.editor, 20)
    with worker.transaction():
        set_tenant(worker, w.org)
        brk = worker.execute("insert into pulse.attendance_break(org_id,entry_id,person_id) values(%s,%s,%s) returning id", (w.org, entry, w.editor)).fetchone()["id"]
    assert timers(worker, w, w.editor)[-1]["end_reason"] == "break"
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.attendance_break set ended_at=now() where id=%s", (brk,))
    assert (timers(worker, w, w.editor)[-1]["start_reason"], timers(worker, w, w.editor)[-1]["running"]) == ("break_end", True)
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.attendance_entry set checked_out_at=now() where id=%s", (entry,))
    assert timers(worker, w, w.editor)[-1]["end_reason"] == "checkout"
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.attendance_entry(org_id,person_id) values(%s,%s)", (w.org, w.editor))
    last = timers(worker, w, w.editor)[-1]
    assert (last["task_id"], last["start_reason"], last["running"]) == (t, "checkin", True)
    # Forgotten overnight: stopped at ten hours, proposed.
    backdate_clock(worker, w, w.editor, 13 * 60)
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select pulse.task_timer_tick() n").fetchone()["n"] == 1
    long = as_(api, w, w.editor, "select sum(minutes)::int m,min(status) s from pulse.time_entry where task_id=%s and source='timer' and status='proposed'", (t,))[0]
    assert long == {"m": 600, "s": "proposed"}


def test_an_estimate_from_similar_work_or_asked_once(api, worker, team):
    """Work starting without an estimate takes Pip's when Pip is fairly sure; otherwise the doer is asked once."""
    w = team
    sure = new_task(api, w, w.editor2, title="Edit the Sunrise reel", assigneeId=str(w.editor))
    as_(api, w, w.editor2, "select pulse.task_suggestion_save(%s,%s)", (sure, Jsonb({"valuePoints": 4, "reason": "About 3 h of video edit.", "effortMinutes": 180, "confidence": "medium"})))
    move(api, w, w.editor, sure, "in_progress")
    assert one(api, w, w.editor, "select estimate_minutes from pulse.task where id=%s", (sure,))["estimate_minutes"] == 180
    unsure = new_task(api, w, w.editor2, title="Leadership offsite plan", assigneeId=str(w.editor))
    as_(api, w, w.editor2, "select pulse.task_suggestion_save(%s,%s)", (unsure, Jsonb({"valuePoints": 2, "reason": "An hour as a start.", "effortMinutes": 60, "confidence": "low"})))
    move(api, w, w.editor, unsure, "in_progress")
    assert one(api, w, w.editor, "select estimate_minutes,estimate_asked_at from pulse.task where id=%s", (unsure,)) == {"estimate_minutes": None, "estimate_asked_at": None}
    as_(api, w, w.editor, "select pulse.task_estimate_answer(%s,240)", (unsure,))
    row = one(api, w, w.editor, "select estimate_minutes,estimate_asked_at is not null asked from pulse.task where id=%s", (unsure,))
    assert row == {"estimate_minutes": 240, "asked": True}


def post_comment(api, w, who, **p):
    return one(api, w, who, "select pulse.work_comment_post(%s) id", (Jsonb(p),))["id"]


def test_threads_and_asking_for_help(api, worker, team):
    """Replies thread under what they answer and tell whoever it answers; a thread resolves and reopens. "Ask for help"
    tells the reviewer, the doer's head and people whose domains fit, who may then see the task; the asker rates each
    helper privately after resolving; helping earns credit; leaders see totals by name."""
    w = team
    t = new_task(api, w, w.editor2, title="Fix the Lakeview colour banding", assigneeId=str(w.editor), category="video_edit")
    root = post_comment(api, w, w.editor2, taskId=str(t), body="Which LUT did you use?")
    reply = post_comment(api, w, w.editor, parentId=str(root), body="The Rec709 one")
    deeper = post_comment(api, w, w.editor2, parentId=str(reply), body="Try the film one")
    rows = {r["id"]: r["parent_id"] for r in as_(api, w, w.editor, "select id,parent_id from pulse.work_comment where task_id=%s", (t,))}
    assert rows == {root: None, reply: root, deeper: reply}
    assert one(api, w, w.editor, "select pulse.work_comment_root(%s) r", (deeper,))["r"] == root
    assert [n["subject_id"] for n in notes(worker, w, w.editor, "task.reply")] == [deeper]
    as_(api, w, w.editor, "select pulse.work_thread_resolve(%s,true)", (root,))
    assert one(api, w, w.editor, "select resolved_by from pulse.work_comment where id=%s", (root,))["resolved_by"] == w.editor
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.work_thread_resolve(%s,true)", (reply,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.work_thread_resolve(%s,false)", (root,))
    as_(api, w, w.editor2, "select pulse.work_thread_resolve(%s,false)", (root,))
    # Ask for help: the reviewer (and head) is told; the outsider, whose domain fits, is told and may now see the task.
    one(api, w, w.lead, "select pulse.work_domain_propose(%s,%s) id", (w.outsider, Jsonb({"title": "Colour for everyone", "categories": ["video_edit"], "basis": "policy"})))
    assert as_(api, w, w.outsider, "select id from pulse.task where id=%s", (t,)) == []
    who = {r["person_id"]: r["why"] for r in as_(api, w, w.editor, "select * from pulse.work_help_people(%s)", (t,))}
    assert who.get(w.editor2) == "reviews it"
    help_ = post_comment(api, w, w.editor, taskId=str(t), kind="help", body="Stuck on the banding in the sky shots")
    assert help_ in {n["subject_id"] for n in notes(worker, w, w.editor2, "task.help")}
    assert help_ in {n["subject_id"] for n in notes(worker, w, w.outsider, "task.help")}, "the outsider's domain fits"
    assert as_(api, w, w.outsider, "select id from pulse.task where id=%s", (t,)) == [{"id": t}], "and they may now see the task"
    a1 = post_comment(api, w, w.editor2, parentId=str(help_), body="Add a little grain before export")
    a2 = post_comment(api, w, w.lead, parentId=str(help_), body="Export at 10-bit")
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Resolve the thread first"):
        as_(api, w, w.editor, "select pulse.work_help_rate(%s,%s,'helpful')", (help_, w.editor2))
    r = one(api, w, w.editor, "select pulse.work_thread_resolve(%s,true) r", (help_,))["r"]
    assert {h["id"] for h in r["helpers"]} == {str(w.editor2), str(w.lead)}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.work_help_rate(%s,%s,'helpful')", (help_, w.lead))
    # INTEGRITY (0910): a rating gives no points (two people could rate each other's answers); it is kept as a rating.
    assert one(api, w, w.editor, "select pulse.work_help_rate(%s,%s,'helpful') r", (help_, w.editor2))["r"]["points"] == 0
    assert one(api, w, w.editor, "select pulse.work_help_rate(%s,%s,'somewhat') r", (help_, w.lead))["r"]["points"] == 0
    one(api, w, w.editor, "select pulse.work_help_rate(%s,%s,'not') r", (help_, w.lead))
    assert as_(api, w, w.manager, "select person_id,points from pulse.work_credit where help_root=%s", (help_,)) == []
    # Private: the helper reads their totals, not the rating rows; leaders see everyone by name.
    assert as_(api, w, w.editor2, "select * from pulse.help_rating") == []
    mine = one(api, w, w.editor2, "select pulse.help_totals(%s,30) t", (w.editor2,))["t"]
    assert (mine["answered"], mine["helpful"], mine["points"]) == (1, 1, 0)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.help_totals(%s,30)", (w.editor2,))
    team_rows = {r["name"]: r for r in as_(api, w, w.manager, "select * from pulse.help_team(30)")}
    assert team_rows["Project Lead"]["not_helpful"] == 1 and list(team_rows) == sorted(team_rows)
    # Neither the task nor the help is credited.
    move(api, w, w.editor, t, "done")
    one(api, w, w.editor2, "select pulse.task_review(%s,%s) r", (t, Jsonb({"quality": "good"})))
    assert as_(api, w, w.manager, "select basis,person_id from pulse.work_credit where task_id=%s", (t,)) == []


def test_deleting_a_project_shows_what_is_connected_and_restores(api, worker, team):
    """An internal project is deleted by its owner, leadership or an admin after seeing what is connected; it and all its
    tasks leave every list at once, credits are taken back, waiting tasks elsewhere stop waiting, and one restore brings
    everything back. A client package's fulfilment is not deleted from Work."""
    from test_work_structure import save_project
    w = team
    pid = save_project(api, w, w.manager, name="Brand refresh", type="internal", ownerId=str(w.editor2))["id"]
    a = new_task(api, w, w.editor2, title="Draft the new palette", assigneeId=str(w.editor), projectId=pid)
    sub = new_task(api, w, w.editor, title="Check contrast", parentId=str(a))
    done_t = new_task(api, w, w.editor2, title="Pick the typeface", assigneeId=str(w.editor), projectId=pid)
    move(api, w, w.editor, done_t, "done")
    as_(api, w, w.editor2, "select pulse.task_review(%s,%s)", (done_t, Jsonb({"quality": "good"})))
    elsewhere = new_task(api, w, w.editor, title="Print the brochure")
    as_(api, w, w.editor, "select pulse.task_block(%s,%s,null)", (elsewhere, a))
    p = one(api, w, w.editor2, "select pulse.project_delete_preview(%s) r", (pid,))["r"]
    assert p["canDelete"] and p["tasks"]["total"] == 3 and p["tasks"]["open"] == 2 and p["tasks"]["finished"] == 1
    assert [x["title"] for x in p["waiting"]] == ["Print the brochure"] and p["credits"]["points"] == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.project_delete(%s,null)", (pid,))
    r = one(api, w, w.editor2, "select pulse.project_delete(%s,'Merged into the website project') r", (pid,))["r"]
    assert r["tasks"] == 3 and r["freed"] == 1 and r["creditsTaken"] == 0
    assert as_(api, w, w.manager, "select id from pulse.project where id=%s", (pid,)) == []
    assert as_(api, w, w.manager, "select id from pulse.task where id in (%s,%s,%s)", (a, sub, done_t)) == []
    assert one(api, w, w.editor, "select status,pulse.task_open_blockers(id) n from pulse.task where id=%s", (elsewhere,)) == {"status": "open", "n": 0}
    # Its tasks come back only with the project, which is listed as one item.
    assert [str(x["id"]) for x in as_(api, w, w.editor2, "select id from pulse.project_deleted_list()")] == [str(pid)]
    assert as_(api, w, w.editor2, "select id from pulse.task_deleted_list() where id in (%s,%s,%s)", (a, sub, done_t)) == []
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="restore the project"):
        as_(api, w, w.editor2, "select pulse.task_restore(%s)", (a,))
    assert one(api, w, w.editor2, "select pulse.project_restore(%s) r", (pid,))["r"]["tasks"] == 3
    assert len(as_(api, w, w.manager, "select id from pulse.task where id in (%s,%s,%s)", (a, sub, done_t))) == 3
    assert one(api, w, w.manager, "select count(*)::int n from pulse.work_credit where task_id=%s and reversed_at is null", (done_t,))["n"] == 0
    with worker.transaction():
        set_tenant(worker, w.org)
        actions = [x["action"] for x in worker.execute("select action from pulse.audit_event where resource='project' and resource_id=%s and action in ('delete','restore') order by at", (str(pid),)).fetchall()]
    assert actions == ["delete", "restore"]
    # A client package's fulfilment stays.
    with worker.transaction():
        set_tenant(worker, w.org)
        client_project = worker.execute("select project_id from pulse.work_project where kind='fulfilment' limit 1").fetchone()
    if client_project:
        with pytest.raises((psycopg.errors.InvalidParameterValue, psycopg.errors.NoDataFound)):
            as_(api, w, w.manager, "select pulse.project_delete(%s,null)", (client_project["project_id"],))
