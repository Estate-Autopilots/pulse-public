"""PM-BUILD-1 (17 Nov 2026; KAZUK-PM-2 phase 1, migration 2262): a delivery plan on clocks. A template keeps every saved
version; a plan's steps count from the clock they name (the plan's start, day 0 when every input is in, going live) and
have no date until it is recorded; recording a clock is refused while its step's inputs are open, and names them; a date
a person set is kept; only a person marks a plan step done; running work is never late. Synthetic tenants only; nothing
is sent."""
from datetime import timedelta

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

# A small company's template in format 3 (generic words; the shape of Estate Autopilots' version 3).
TPL = {
    "format": 3,
    "stages": [{"n": 0, "key": "s0", "label": "Getting ready"}, {"n": 1, "key": "s1", "label": "Making"}, {"n": 2, "key": "s2", "label": "Running"}],
    "packages": [{"key": "full", "label": "Full"}],
    "categories": [{"key": "big", "label": "Big", "units": 1}],
    "bandwidth": {"role": "Lead", "short": "Lead", "healthy": [3, 5], "max": 6},
    "milestones": {"adsLive": "G2"},
    "clocks": [{"key": "start", "label": "Paid", "day": -3}, {"key": "day0", "label": "Ready", "step": "G1"},
               {"key": "live", "label": "Live", "step": "G2"}],
    "windows": [{"key": "claim", "label": "Claim window", "from": "live", "start": 30, "end": 45}],
    "steps": [
        {"id": "A0", "stage": 0, "title": "Paid invoice opens the project", "owner": "System", "type": "auto", "from": "start", "start": 0, "end": 0, "packages": {"full": "yes"}},
        {"id": "I1", "stage": 0, "title": "Brief received", "owner": "Lead", "type": "task", "from": "start", "start": 0, "end": 2, "packages": {"full": "yes"}, "clientInput": True},
        {"id": "I2", "stage": 0, "title": "Access granted", "owner": "Coordinator", "type": "task", "from": "start", "start": 1, "end": 3, "packages": {"full": "yes"}},
        {"id": "G1", "stage": 0, "title": "Ready: every input in", "owner": "Lead", "type": "gate", "from": "start", "start": 3, "end": 3, "after": ["I1", "I2"], "packages": {"full": "yes"}},
        {"id": "M1", "stage": 1, "title": "Make the first set", "owner": "Maker + Lead", "type": "task", "from": "day0", "start": 1, "end": 5, "after": ["G1"], "packages": {"full": "yes"}, "hours": [4, 6]},
        {"id": "S1", "stage": 1, "title": "Set up the channel", "owner": "Lead", "type": "ongoing", "from": "day0", "start": 4, "end": 6, "after": ["M1"], "packages": {"full": "yes"}},
        {"id": "T1", "stage": 1, "title": "Testimonials", "owner": "Maker", "type": "task", "from": "day0", "start": 6, "end": 9, "packages": {"full": "yes"}, "when": "realBuyers"},
        {"id": "G2", "stage": 2, "title": "Live", "owner": "Lead", "type": "milestone", "from": "day0", "start": 6, "end": 8, "after": ["S1"], "gateInputs": ["M1", "S1", "I2"], "packages": {"full": "yes"}},
        {"id": "L1", "stage": 2, "title": "Tell the client", "owner": "Lead", "type": "task", "from": "live", "start": 0, "end": 2, "after": ["G2"], "packages": {"full": "yes"}},
        {"id": "L2", "stage": 2, "title": "Monthly review", "owner": "Lead", "type": "repeating", "from": "live", "start": 7, "end": None, "after": ["G2"], "packages": {"full": "yes"}},
        {"id": "L3", "stage": 2, "title": "Report", "owner": "Lead", "type": "task", "from": "live", "start": 5, "end": 9, "after": ["G2"], "packages": {"full": "yes"}},
    ],
}


def org_today(api, w):
    """The company's own day (its time zone), which is what the plan's clocks use; not the test machine's."""
    return one(api, w, w.lead, "select (now() at time zone pulse.org_time_zone())::date d")["d"]


def ai(api, w, who, sql, args=()):
    """The same statement from an AI employee's request (the API sets pulse.actor_account to agent:<name>)."""
    with api.transaction():
        set_tenant(api, w.org, who)
        api.execute("select set_config('pulse.actor_account','agent:Pip',true)")
        return api.execute(sql, args).fetchall()


def steps(api, w):
    return {r["template_step"]: r for r in as_(api, w, w.lead, """select id,template_step,status,assignee_person_id,role_key,estimate_minutes,work_on,
        (due_at at time zone pulse.org_time_zone())::date due from pulse.task where project_id=%s and template_step is not null and deleted_at is null""", (w.project,))}


def move(api, w, who, task, status):
    return one(api, w, who, "select pulse.task_move(%s,%s) r", (task, status))["r"]


def laid_out(api, w, kickoff):
    one(api, w, w.manager, "select pulse.delivery_template_adopt('clock-test','Clock plan',%s,%s) r", (Jsonb(TPL), w.project))
    one(api, w, w.lead, "select pulse.project_plan_set(%s,'clock-test','full','big',%s,%s) r", (w.project, kickoff, w.lead))
    return steps(api, w)


def test_template_versions_are_kept_and_only_leadership_saves(api, worker, team):
    w = team
    today = org_today(api, w)
    one(api, w, w.manager, "select pulse.delivery_template_adopt('clock-test','Clock plan',%s,%s) r", (Jsonb(TPL), w.project))
    # A plan laid out before the company kept versions.
    one(api, w, w.lead, "select pulse.project_plan_set(%s,'clock-test','full','big',%s,%s) r", (w.project, today, w.lead))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.delivery_template_save('clock-test','Clock plan',%s,'try')", (Jsonb(TPL),))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):  # leadership, but through an AI employee's request
        ai(api, w, w.manager, "select pulse.delivery_template_save('clock-test','Clock plan',%s,'try')", (Jsonb(TPL),))
    bad = {**TPL, "steps": [*TPL["steps"], {**TPL["steps"][1], "id": "X1", "after": ["NOPE"]}]}
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="X1 waits on NOPE"):
        as_(api, w, w.manager, "select pulse.delivery_template_save('clock-test','Clock plan',%s,'bad')", (Jsonb(bad),))
    r = one(api, w, w.manager, "select pulse.delivery_template_save('clock-test','Clock plan v2',%s,'Second version') r", (Jsonb({**TPL, "source": "v2"}),))["r"]
    assert r == {"key": "clock-test", "version": 2}
    rows = as_(api, w, w.manager, "select version,note,definition->>'source' src from pulse.delivery_template_version where key='clock-test' order by version")
    assert [(x["version"], x["src"]) for x in rows] == [(1, None), (2, "v2")]
    assert rows[0]["note"] == "The copy in use before versions were kept"
    cur = one(api, w, w.manager, "select name,definition->>'version' v from pulse.delivery_template where key='clock-test'")
    assert cur == {"name": "Clock plan v2", "v": "2"}
    # The plan stays on the copy it was laid out from; saving again does not move it either.
    one(api, w, w.manager, "select pulse.delivery_template_save('clock-test','Clock plan v3',%s,'Third') r", (Jsonb({**TPL, "source": "v3"}),))
    pl = one(api, w, w.lead, "select template_version,pulse.plan_definition(project_id)->>'source' src from pulse.project_plan where project_id=%s", (w.project,))
    assert pl == {"template_version": 1, "src": None}


def test_clocks_gates_and_only_a_person_finishes(api, worker, owner, team):
    w = team
    today = org_today(api, w)
    kickoff = today - timedelta(days=5)
    s = laid_out(api, w, kickoff)
    # The system's own step and a step with a condition are not cards; the start clock's steps are dated, the rest wait.
    assert "A0" not in s and "T1" not in s
    assert s["I1"]["due"] == kickoff + timedelta(days=2) and s["G1"]["due"] == kickoff + timedelta(days=3)
    assert s["M1"]["due"] is None and s["L1"]["due"] is None
    assert s["M1"]["role_key"] == "Maker" and s["M1"]["estimate_minutes"] == 300 and s["M1"]["assignee_person_id"] is None
    assert s["I1"]["assignee_person_id"] == w.lead
    # Day 0 is refused while its inputs are open, and the refusal names them.
    with pytest.raises(psycopg.errors.CheckViolation, match="Ready can't be recorded yet. Still open: I1 Brief received; I2 Access granted"):
        as_(api, w, w.lead, "select pulse.project_day0_declare(%s,null)", (w.project,))
    # Ticking the gate step by hand is refused the same way.
    with pytest.raises(psycopg.errors.CheckViolation, match="can't be done yet. Still open: I1"):
        move(api, w, w.lead, s["G1"]["id"], "done")
    # An AI employee may start a step but never finish one; a person may.
    ai(api, w, w.lead, "select pulse.task_move(%s,'in_progress')", (s["I1"]["id"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only a person marks a step"):
        ai(api, w, w.lead, "select pulse.task_move(%s,'done')", (s["I1"]["id"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        ai(api, w, w.lead, "select pulse.project_day0_declare(%s,null)", (w.project,))
    # Pulse's "it happened, so it is done" leaves plan steps to a person.
    assert one(api, w, w.lead, "select pulse.task_auto_blocker(%s) b", (s["I1"]["id"],))["b"] == "plan_step"
    move(api, w, w.lead, s["I1"]["id"], "done")
    move(api, w, w.lead, s["I2"]["id"], "done")
    # Someone who does not run the project cannot declare it; the future is refused.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.project_day0_declare(%s,null)", (w.project,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="future"):
        as_(api, w, w.lead, "select pulse.project_day0_declare(%s,%s)", (w.project, today + timedelta(days=1)))
    # A person dated a live step by hand before going live: it keeps that date.
    mine = today + timedelta(days=20)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.task set due_at=(%s::date + time '18:00') at time zone pulse.org_time_zone() where id=%s", (mine, s["L3"]["id"]))
    day0 = today - timedelta(days=1)
    r = one(api, w, w.lead, "select pulse.project_day0_declare(%s,%s) r", (w.project, day0))["r"]
    assert r["clock"] == "day0" and r["dated"] == 3  # M1, S1, G2
    s = steps(api, w)
    assert s["G1"]["status"] == "done"
    assert s["M1"]["due"] == day0 + timedelta(days=5) and s["M1"]["work_on"] == day0 + timedelta(days=1)
    pl = one(api, w, w.lead, "select day0_on,day0_by,live_on from pulse.project_plan where project_id=%s", (w.project,))
    assert pl == {"day0_on": day0, "day0_by": w.lead, "live_on": None}
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="already recorded"):
        as_(api, w, w.lead, "select pulse.project_day0_declare(%s,null)", (w.project,))
    # Going live: refused while the five inputs' kind are open; an ongoing input counts once it is running.
    with pytest.raises(psycopg.errors.CheckViolation, match="Live can't be recorded yet. Still open: M1 Make the first set; S1 Set up the channel"):
        as_(api, w, w.lead, "select pulse.project_live_record(%s,null)", (w.project,))
    move(api, w, w.lead, s["M1"]["id"], "done")
    move(api, w, w.lead, s["S1"]["id"], "in_progress")
    r = one(api, w, w.lead, "select pulse.project_live_record(%s,null) r", (w.project,))["r"]
    assert r["clock"] == "live" and r["dated"] == 2  # L1 and L2; L3 keeps the person's date
    s = steps(api, w)
    assert s["G2"]["status"] == "done" and s["S1"]["status"] == "in_progress"
    assert s["L1"]["due"] == today + timedelta(days=2) and s["L2"]["due"] is None and s["L2"]["work_on"] == today + timedelta(days=7)
    assert s["L3"]["due"] == mine


def test_running_work_is_never_late_and_ticking_records_the_clock(api, worker, owner, team):
    w = team
    today = org_today(api, w)
    kickoff = today - timedelta(days=10)
    s = laid_out(api, w, kickoff)
    for k in ("I1", "I2"):
        move(api, w, w.lead, s[k]["id"], "done")
    # Ticking the gate step done records day 0 for today and dates its steps.
    move(api, w, w.lead, s["G1"]["id"], "done")
    pl = one(api, w, w.lead, "select day0_on,day0_by from pulse.project_plan where project_id=%s", (w.project,))
    assert pl == {"day0_on": today, "day0_by": w.lead}
    assert steps(api, w)["M1"]["due"] == today + timedelta(days=5)
    # Both S1 (running) and M1 (open) fall late; only M1 is asked about.
    move(api, w, w.lead, s["S1"]["id"], "in_progress")
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.task set locked='{}', due_at=now() - interval '2 days' where id in (%s,%s)", (s["S1"]["id"], s["M1"]["id"]))
        owner.execute("update pulse.task set assignee_person_id=%s where id=%s", (w.editor, s["M1"]["id"]))  # a late question goes to a doer
    one(api, w, w.lead, "select pulse.task_delays_sync() n")
    asked = {r["task_id"] for r in as_(api, w, w.lead, "select task_id from pulse.task_delay where project_id=%s and closed_at is null", (w.project,))}
    assert s["M1"]["id"] in asked and s["S1"]["id"] not in asked
    assert one(api, w, w.lead, "select pulse.plan_step_running(%s,'S1','in_progress') r", (w.project,))["r"] is True
