"""PROJECTS-STAGES (owner, 4 Nov 2026; Kazuk's 3 Nov meeting B2-B9, migration 1485): projects run in stages with owners at
three levels, a task placed on a stage wherever it was given, late work asking its doer why and rolling up to the lead and
the stage owner until one acts, and starter templates any company can take. Synthetic tenants only; nothing is sent."""
import json
import os
import subprocess
from datetime import date, timedelta
from pathlib import Path

import psycopg
import pytest
from conftest import dsn
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, new_task, notes, one, team  # noqa: F401  (team is a fixture)

# A small starter of the same shape as services/api/src/project-starters.ts (the API sends those; this keeps the database
# rules testable without the build).
STARTER = {
    "stages": [{"n": 0, "key": "s0", "label": "Kick-off"}, {"n": 1, "key": "s1", "label": "Do the work"}, {"n": 2, "key": "s2", "label": "Deliver"}],
    "packages": [{"key": "standard", "label": "Standard"}], "categories": [{"key": "standard", "label": "Standard", "units": 1}],
    "bandwidth": {"role": "Project lead", "short": "Lead", "healthy": [3, 5], "max": 6}, "milestones": {},
    "steps": [
        {"id": "G0", "stage": 0, "title": "Kick-off: scope agreed", "kind": "gate", "start": 0, "end": 1, "owner": "Project lead", "clientInput": False, "packages": {"standard": "yes"}},
        {"id": "W1", "stage": 1, "title": "Do the work", "kind": "task", "start": 1, "end": 10, "owner": "Team", "clientInput": False, "packages": {"standard": "yes"}},
        {"id": "D1", "stage": 2, "title": "Deliver", "kind": "task", "start": 10, "end": 12, "owner": "Project lead", "clientInput": False, "packages": {"standard": "yes"}},
    ],
}


def late(owner, w, task, due):
    """The task's due day moves into the past (as time passing would); a person's own edits are locked against imports."""
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.task set locked='{}' where id=%s", (task,))
        owner.execute("update pulse.task set due_at=(%s::date + time '18:00') at time zone pulse.org_time_zone() where id=%s", (due, task))


def planned(api, w):
    """The lead (the project's lead person) takes the starter for the project and lays the plan out from today."""
    r = one(api, w, w.lead, "select pulse.delivery_template_adopt('simple-test','Simple project',%s,%s) r", (Jsonb(STARTER), w.project))["r"]
    assert r == {"key": "simple-test", "added": True}
    one(api, w, w.lead, "select pulse.project_plan_set(%s,'simple-test','standard',null,%s,%s) r", (w.project, date.today(), w.lead))
    return {r["template_step"]: r["id"] for r in as_(api, w, w.lead, "select id,template_step from pulse.task where project_id=%s and template_step is not null", (w.project,))}


def test_any_company_takes_a_starter_and_gets_stages(api, worker, team):
    w = team
    # A member who does not run the project cannot choose how the company's projects run.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.delivery_template_adopt('simple-test','Simple',%s,%s)", (Jsonb(STARTER), w.project))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="incomplete"):
        as_(api, w, w.manager, "select pulse.delivery_template_adopt('broken','Broken',%s,null)", (Jsonb({"stages": []}),))
    steps = planned(api, w)
    assert set(steps) == {"G0", "W1", "D1"}
    # Once the company has a template, a project's lead who is not an admin or leadership cannot add more.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.lead, "select pulse.delivery_template_adopt('second-test','Second',%s,%s)", (Jsonb(STARTER), w.project))
    # Taking it again changes nothing; the lead's steps went to the lead, the team's wait for a doer.
    assert one(api, w, w.manager, "select pulse.delivery_template_adopt('simple-test','Simple project',%s,null) r", (Jsonb(STARTER),))["r"]["added"] is False
    rows = {r["template_step"]: r for r in as_(api, w, w.lead, "select template_step,assignee_person_id,phase_key from pulse.task where project_id=%s and template_step is not null", (w.project,))}
    assert rows["G0"]["assignee_person_id"] == w.lead and rows["W1"]["assignee_person_id"] is None and rows["D1"]["phase_key"] == "s2"


def test_stage_owners_and_a_task_given_in_work_lands_on_a_stage(api, worker, team):
    w = team
    steps = planned(api, w)
    # The lead gives stage 1 its owner, who hears it; a member cannot, and only the plan's stages exist.
    one(api, w, w.lead, "select pulse.project_stage_owner_set(%s,1,%s)", (w.project, w.editor2))
    assert [n["href"] for n in notes(worker, w, w.editor2, "project.stage")] == [f"/tasks/projects/{w.project}"]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.project_stage_owner_set(%s,1,%s)", (w.project, w.editor))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="stage"):
        as_(api, w, w.lead, "select pulse.project_stage_owner_set(%s,7,%s)", (w.project, w.editor))
    assert one(api, w, w.editor, "select pulse.project_stage_label(%s,1) l", (w.project,))["l"] == "Do the work"
    # B9: a task given in Work in the project is placed on a stage by whoever made it, or by the stage's owner.
    t = new_task(api, w, w.editor, title="Cut the second reel", projectId=str(w.project))
    assert one(api, w, w.editor, "select pulse.task_stage(%s) s", (t,))["s"] is None
    assert one(api, w, w.editor, "select pulse.project_task_stage(%s,1) r", (t,))["r"]["label"] == "Do the work"
    assert one(api, w, w.editor2, "select pulse.project_task_stage(%s,2) r", (t,))["r"]["stage"] == 2
    assert one(api, w, w.editor, "select pulse.task_stage(%s) s,phase_key from pulse.task where id=%s", (t, t)) == {"s": 2, "phase_key": "s2"}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.project_task_stage(%s,1)", (t,))
    # A plan step stays in its own stage; ending a stage owner clears it.
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="plan step D1"):
        as_(api, w, w.lead, "select pulse.project_task_stage(%s,0)", (steps["D1"],))
    one(api, w, w.lead, "select pulse.project_stage_owner_set(%s,1,null)", (w.project,))
    assert one(api, w, w.lead, "select count(*)::int n from pulse.project_stage_owner where project_id=%s", (w.project,))["n"] == 0


def test_late_work_asks_why_and_waits_on_the_owner_until_they_act(api, worker, owner, team):
    w = team
    planned(api, w)
    t = new_task(api, w, w.editor, title="Edit the walkthrough video", projectId=str(w.project))
    one(api, w, w.editor, "select pulse.project_task_stage(%s,1)", (t,))
    due = date.today() - timedelta(days=3)
    late(owner, w, t, due)
    # B4: reading the projects asks the doer once per due day (it never asks twice), in Pulse's notifications.
    assert one(api, w, w.lead, "select pulse.task_delays_sync() n")["n"] >= 1
    assert one(api, w, w.lead, "select pulse.task_delays_sync() n")["n"] == 0
    d = one(api, w, w.lead, "select id,person_id,due_on,reason from pulse.task_delay where task_id=%s and closed_at is null", (t,))
    assert d["person_id"] == w.editor and d["due_on"] == due and d["reason"] is None
    asked = [n for n in notes(worker, w, w.editor, "task.late") if n["href"] == f"/tasks/{t}"]
    assert len(asked) == 1 and "Say why" in asked[0]["title"]
    # Only the doer answers; a reason is one of the list, Other needs words, a date cannot be in the past.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.task_delay_answer(%s,'more_work',null,null)", (t,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Say why"):
        as_(api, w, w.editor, "select pulse.task_delay_answer(%s,'other',' ',null)", (t,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="later day"):
        as_(api, w, w.editor, "select pulse.task_delay_answer(%s,'more_work',null,%s)", (t, due))
    by = date.today() + timedelta(days=2)
    one(api, w, w.editor, "select pulse.task_delay_answer(%s,'waiting_client','The client has not sent the voice-over',%s)", (t, by))
    row = one(api, w, w.lead, "select reason,note,can_by,answered_at from pulse.task_delay where id=%s", (d["id"],))
    assert row["reason"] == "waiting_client" and row["can_by"] == by and row["answered_at"] is not None
    # B5: the lead hears the answer; a member who is not the stage's owner cannot act, the stage's owner can.
    assert any("waiting on the client" in n["title"] for n in notes(worker, w, w.lead, "task.late"))
    assert one(api, w, w.editor2, "select pulse.task_delay_can_act(%s) ok", (d["id"],))["ok"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.task_delay_act(%s,'chased',null,null,null)", (d["id"],))
    one(api, w, w.lead, "select pulse.project_stage_owner_set(%s,1,%s)", (w.project, w.editor2))
    assert one(api, w, w.editor2, "select pulse.task_delay_can_act(%s) ok", (d["id"],))["ok"] is True
    # Chase: the doer is asked again; escalate: it goes to the person named, who can then give it a new date.
    one(api, w, w.editor2, "select pulse.task_delay_act(%s,'chased',null,null,null)", (d["id"],))
    assert any("asks:" in n["title"] for n in notes(worker, w, w.editor, "task.late"))
    # The chase opens the doer's answer again (the earlier one is kept until the new one); they answer, the owner hears it.
    assert one(api, w, w.lead, "select answered_at,reason from pulse.task_delay where id=%s", (d["id"],)) == {"answered_at": None, "reason": "waiting_client"}
    one(api, w, w.editor, "select pulse.task_delay_answer(%s,'waiting_client','Synthetic: still no voice-over, chased today',%s)", (t, by))
    assert one(api, w, w.lead, "select note,answered_at is not null answered from pulse.task_delay where id=%s", (d["id"],)) == {"note": "Synthetic: still no voice-over, chased today", "answered": True}
    assert any("waiting on the client" in n["title"] for n in notes(worker, w, w.editor2, "task.late"))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="escalate"):
        as_(api, w, w.lead, "select pulse.task_delay_act(%s,'escalated',null,null,%s)", (d["id"], w.lead))
    one(api, w, w.lead, "select pulse.task_delay_act(%s,'escalated',null,'Client voice-over missing',%s)", (d["id"], w.manager))
    assert one(api, w, w.lead, "select action,escalated_to,closed_at from pulse.task_delay where id=%s", (d["id"],)) == {"action": "escalated", "escalated_to": w.manager, "closed_at": None}
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="later day"):
        as_(api, w, w.manager, "select pulse.task_delay_act(%s,'rescheduled',%s,null,null)", (d["id"], due))
    one(api, w, w.manager, "select pulse.task_delay_act(%s,'rescheduled',%s,'After the voice-over',null)", (d["id"], by))
    assert one(api, w, w.lead, "select (due_at at time zone pulse.org_time_zone())::date d from pulse.task where id=%s", (t,))["d"] == by
    assert one(api, w, w.lead, "select closed_at is not null closed,action from pulse.task_delay where id=%s", (d["id"],)) == {"closed": True, "action": "rescheduled"}
    ch = one(api, w, w.lead, "select reason_kind,to_due from pulse.project_date_change where task_id=%s", (t,))
    assert ch == {"reason_kind": "client_delay", "to_due": by}
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="settled"):
        as_(api, w, w.manager, "select pulse.task_delay_act(%s,'chased',null,null,null)", (d["id"],))
    # No longer late: nothing new is asked; finished late work closes its question too.
    assert one(api, w, w.lead, "select pulse.task_delays_sync() n")["n"] == 0
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="not late"):
        as_(api, w, w.editor, "select pulse.task_delay_answer(%s,'more_work',null,null)", (t,))


def test_old_overdue_work_is_not_asked_and_delays_follow_privacy(api, worker, owner, team):
    """Review of 4 Nov 2026: the first run after a deploy does not ask about month-old overdue work, a page read writes
    nothing, and a delay and a stage owner follow 1455's rules: hidden from whoever may not see the task, and never
    escalated to them."""
    w = team
    planned(api, w)
    old = new_task(api, w, w.editor, title="Synthetic month-old task", projectId=str(w.project))
    late(owner, w, old, date.today() - timedelta(days=30))
    t = new_task(api, w, w.editor, title="Synthetic recent late task", projectId=str(w.project))
    late(owner, w, t, date.today() - timedelta(days=2))
    one(api, w, w.lead, "select pulse.task_delays_sync()")
    assert one(api, w, w.lead, "select count(*)::int n from pulse.task_delay where task_id=%s", (old,))["n"] == 0
    assert not [n for n in notes(worker, w, w.editor, "task.late") if n["href"] == f"/tasks/{old}"]
    d = one(api, w, w.lead, "select id from pulse.task_delay where task_id=%s and closed_at is null", (t,))["id"]
    one(api, w, w.lead, "select pulse.project_stage_owner_set(%s,1,%s)", (w.project, w.editor2))
    # The project becomes members-only: someone not on it sees neither its delays nor its stage owners, and is no target.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.project set visibility='members' where id=%s", (w.project,))
    assert one(api, w, w.outsider, "select count(*)::int n from pulse.task_delay where task_id=%s", (t,))["n"] == 0
    assert one(api, w, w.outsider, "select count(*)::int n from pulse.project_stage_owner where project_id=%s", (w.project,))["n"] == 0
    assert one(api, w, w.lead, "select count(*)::int n from pulse.task_delay where task_id=%s", (t,))["n"] == 1
    targets = [r["id"] for r in as_(api, w, w.lead, "select id from pulse.task_delay_targets(%s)", (d,))]
    assert w.manager in targets and w.outsider not in targets
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="cannot open"):
        as_(api, w, w.lead, "select pulse.task_delay_act(%s,'escalated',null,null,%s)", (d, w.outsider))
    assert one(api, w, w.lead, "select pulse.task_delay_act(%s,'escalated',null,null,%s) r", (d, w.manager))["r"]["action"] == "escalated"


def test_another_company_never_sees_the_delays(api, worker, owner, team):
    from helpers import build_world
    w = team
    planned(api, w)
    t = new_task(api, w, w.editor, title="Late synthetic task", projectId=str(w.project))
    late(owner, w, t, date.today() - timedelta(days=2))
    one(api, w, w.lead, "select pulse.task_delays_sync()")
    other = build_world(worker, owner, api)
    with api.transaction():
        set_tenant(api, other.org, other.lead)
        assert api.execute("select count(*)::int n from pulse.task_delay").fetchone()["n"] == 0
        assert api.execute("select count(*)::int n from pulse.project_stage_owner").fetchone()["n"] == 0


@pytest.mark.skipif(os.environ.get("PULSE_AUTH_BROWSER") != "1", reason="browser checks run in CI with PULSE_AUTH_BROWSER=1")
def test_projects_in_stages_in_the_browser(worker, owner, api, team, tmp_path):
    """services/api/test/project-stages-browser-runner.mjs: the lead takes a starter, plans the project, gives a stage its
    owner; a task given in Work lands on a stage; late work is explained by its doer and acted on by the lead, at 390 and
    1440. Screenshots with PULSE_PS_SCREENSHOTS."""
    w = team
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.project set title='Synthetic Riverside launch',status='active' where id=%s", (w.project,))
    # A task given in the project before it had a plan, now 3 days late (its doer is asked why).
    t = new_task(api, w, w.editor, title="Synthetic late edit", projectId=str(w.project))
    late(owner, w, t, date.today() - timedelta(days=3))
    config = conninfo_to_dict(dsn("api"))
    config["database"] = config.pop("dbname")
    env = {**os.environ, "PULSE_CI": "1", "TEST_API_CONFIG": json.dumps(config),
           "TEST_IDS": json.dumps({"project": str(w.project), "lead": str(w.lead), "editor": str(w.editor), "editor2": str(w.editor2),
                                   "editorEmail": w.editor_handle, "headEmail": f"editor2@{w.domain}", "org": str(w.org)})}
    p = subprocess.run(["node", "test/project-stages-browser-runner.mjs"], cwd=Path(__file__).resolve().parents[2] / "services/api", env=env,
                       capture_output=True, text=True, timeout=1800, check=False)
    assert p.returncode == 0, p.stderr[-4000:] + p.stdout[-4000:]
    # What the browser did is in the database: the new task is on a stage, the late one has its reason and a new date.
    made = one(api, w, w.editor, "select phase_key from pulse.task where title='Shoot the synthetic site walkthrough' and project_id=%s", (w.project,))
    assert made and made["phase_key"].startswith("s")
    d = one(api, w, w.manager, "select reason,action,closed_at is not null closed from pulse.task_delay where task_id=%s", (t,))
    assert d == {"reason": "waiting_client", "action": "rescheduled", "closed": True}
    assert one(api, w, w.manager, "select person_id from pulse.project_stage_owner where project_id=%s and stage=2", (w.project,))["person_id"] == w.editor2
