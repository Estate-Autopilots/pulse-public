"""FOUNDATIONS (1569): goals for a person, a team and the company, with projects and tasks under them and progress
rolled up, enforced by the database under forced row security. Synthetic tenants only."""
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, new_task, one, team  # noqa: F401  (team is a fixture)

GOAL = """insert into pulse.goal(org_id,level,title,owner_person_id,unit_id,parent_id,target_on,measure_label,start_value,target_value,current_value,created_by)
  values(pulse.current_org(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,pulse.current_viewer()) returning id"""


def goal(api, w, who, level, title, owner=None, unit=None, parent=None, target_on=None, label=None, start=None, target=None, current=None):
    return one(api, w, who, GOAL, (level, title, owner, unit, parent, target_on, label, start, target, current))["id"]


def link(api, w, who, goal_id, task=None, project=None):
    return one(api, w, who, "insert into pulse.goal_link(org_id,goal_id,task_id,project_id,added_by) values(pulse.current_org(),%s,%s,%s,pulse.current_viewer()) returning id",
               (goal_id, task, project))["id"]


def progress(api, w, who, goal_id):
    return one(api, w, who, "select pulse.goal_progress(%s) p", (goal_id,))["p"]


def test_tables_force_row_security_with_a_tenant_policy(worker):
    rows = worker.execute("""select c.relname,c.relrowsecurity,c.relforcerowsecurity,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='tenant_isolation') tenant
      from pg_class c where c.oid in ('pulse.goal'::regclass,'pulse.goal_link'::regclass,'pulse.goal_value'::regclass) order by 1""").fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) for r in rows] == [
        ("goal", True, True, True), ("goal_link", True, True, True), ("goal_value", True, True, True)]


def test_who_sets_and_sees_which_goal(api, worker, team):
    w = team
    # A member sets their own goal; nobody else's, and never the company's.
    mine = goal(api, w, w.editor, "person", "Ship 20 reels this quarter", owner=w.editor)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        goal(api, w, w.editor, "person", "Your goal", owner=w.outsider)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        goal(api, w, w.editor, "company", "Double revenue")
    # The pod head manages the editor and sets a goal for them; the admin sets the company's.
    theirs = goal(api, w, w.editor2, "person", "Learn colour grading", owner=w.editor)
    company = goal(api, w, w.manager, "company", "Sign 12 new clients", label="clients signed", start=0, target=12, current=3)
    # Everyone reads the company goal; a person's goals are the person's, their manager's, HR's and admins'.
    seen = lambda who: {r["id"] for r in as_(api, w, who, "select id from pulse.goal")}  # noqa: E731
    assert seen(w.editor) == {mine, theirs, company}
    assert seen(w.editor2) >= {mine, theirs, company}
    assert seen(w.lead) >= {mine, theirs, company}
    assert seen(w.outsider) == {company}
    # The outsider cannot change what they can read; the editor cannot change the company's goal.
    assert as_(api, w, w.outsider, "update pulse.goal set title='x' where id=%s returning id", (company,)) == []
    assert as_(api, w, w.editor, "update pulse.goal set current_value=12 where id=%s returning id", (company,)) == []
    assert one(api, w, w.editor, "select pulse.goal_can_edit('company',null,null) v")["v"] is False
    assert one(api, w, w.manager, "select pulse.goal_can_edit('company',null,null) v")["v"] is True


def test_team_goals_belong_to_the_teams_heads(api, worker, team):
    w = team
    unit = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.unit(id,org_id,kind,name,head_person_id) values(%s,%s,'team','Synthetic Studio',%s)", (unit, w.org, w.editor2))
    team_goal = goal(api, w, w.editor2, "team", "Studio turnaround under 3 days", unit=unit)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        goal(api, w, w.editor, "team", "Not my team to set", unit=unit)
    assert one(api, w, w.outsider, "select title from pulse.goal where id=%s", (team_goal,))["title"] == "Studio turnaround under 3 days"
    with pytest.raises(psycopg.errors.CheckViolation):
        goal(api, w, w.manager, "team", "A team goal needs its team")


def test_progress_rolls_up_from_tasks_projects_sub_goals_and_measure(api, worker, team):
    w = team
    parent = goal(api, w, w.editor, "person", "Become the studio's fastest editor", owner=w.editor, target_on="2026-01-31")
    child = goal(api, w, w.editor, "person", "Finish the editing course", owner=w.editor, parent=parent)
    t1 = new_task(api, w, w.editor, title="Cut reel one for the goal")
    t2 = new_task(api, w, w.editor, title="Cut reel two for the goal")
    link(api, w, w.editor, child, task=t1)
    link(api, w, w.editor, child, task=t2)
    assert progress(api, w, w.editor, child)["progress"] == 0
    as_(api, w, w.editor, "select pulse.task_move(%s,'done')", (t1,))
    p = progress(api, w, w.editor, child)
    assert (p["tasks"], p["tasksDone"], float(p["progress"]), p["basis"]) == (2, 1, 0.5, "work")
    # The parent counts its sub-goal's progress, and is late: its target date has passed and it is not complete.
    pp = progress(api, w, w.editor, parent)
    assert (pp["subGoals"], float(pp["progress"]), pp["late"]) == (1, 0.5, True)
    # A project under a goal brings its tasks.
    link(api, w, w.editor, parent, project=w.project)
    assert progress(api, w, w.editor, parent)["projects"] == 1
    # A measurable target wins over the work: 3 of 12 from 0 is a quarter; done is complete.
    m = goal(api, w, w.editor, "person", "Publish 12 tutorials", owner=w.editor, label="tutorials", start=0, target=12, current=3)
    assert float(progress(api, w, w.editor, m)["progress"]) == 0.25
    as_(api, w, w.editor, "update pulse.goal set status='done' where id=%s returning id", (m,))
    assert float(progress(api, w, w.editor, m)["progress"]) == 1
    assert one(api, w, w.editor, "select done_at is not null d from pulse.goal where id=%s", (m,))["d"] is True


def test_links_and_loops(api, worker, team):
    w = team
    a = goal(api, w, w.editor, "person", "Goal A", owner=w.editor)
    b = goal(api, w, w.editor, "person", "Goal B", owner=w.editor, parent=a)
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="under itself"):
        as_(api, w, w.editor, "update pulse.goal set parent_id=%s where id=%s returning id", (b, a))
    # A link needs a goal you may change and work you can see; the same task twice is refused.
    t = new_task(api, w, w.editor, title="Linked once")
    link(api, w, w.editor, a, task=t)
    with pytest.raises(psycopg.errors.UniqueViolation):
        link(api, w, w.editor, a, task=t)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        link(api, w, w.outsider, a, task=t)
    with pytest.raises(psycopg.errors.CheckViolation):
        one(api, w, w.editor, "insert into pulse.goal_link(org_id,goal_id,added_by) values(pulse.current_org(),%s,pulse.current_viewer()) returning id", (a,))
    # The outsider cannot see the editor's goal, so not its links either.
    assert as_(api, w, w.outsider, "select id from pulse.goal_link where goal_id=%s", (a,)) == []


# ------------------------------------------------------------------------------------------------ GOALS-2 (1855)
# Kinds, auto-sources, a milestone's checklist and the number's history. The access matrix: who may pick which source,
# who reads a goal's history and auto-filled total, and that nobody writes history by hand.
GOAL2 = """insert into pulse.goal(org_id,level,title,owner_person_id,target_on,measure_label,start_value,target_value,current_value,kind,source,steps,created_by)
  values(pulse.current_org(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,pulse.current_viewer()) returning id"""


def goal2(api, w, who, level, title, owner=None, target_on=None, label=None, start=None, target=None, current=None, kind=None, source="manual", steps=None):
    return one(api, w, who, GOAL2, (level, title, owner, target_on, label, start, target, current, kind, source, Jsonb(steps or [])))["id"]


def _billing_reader(worker, w, who):
    with worker.transaction():
        set_tenant(worker, w.org)
        for perm in ("money.read", "money.amount.read"):
            worker.execute("insert into pulse.money_permission(org_id,person_id,permission) values(%s,%s,%s) on conflict do nothing", (w.org, who, perm))


def test_goal_kinds_access_matrix(api, worker, team):
    w = team
    _billing_reader(worker, w, w.manager)
    denied = psycopg.errors.InsufficientPrivilege
    # Who may fill a goal from Billing (billing readers) and from check-ins (admins, leadership, HR); anyone from "manual".
    matrix = {  # who: (billing, checkins)
        w.manager: (True, True),     # admin who reads Billing
        w.lead: (False, True),       # HR
        w.editor2: (False, False),   # pod head
        w.editor: (False, False),    # member
    }
    for who, (billing, checkins) in matrix.items():
        for source, allowed in (("billing_received", billing), ("clients_paying", billing), ("checkins", checkins), ("manual", True)):
            make = lambda: goal2(api, w, who, "person", f"{source} goal", owner=who, label="x", start=0, target=10, kind="count", source=source)  # noqa: E731
            if allowed:
                assert make()
            else:
                with pytest.raises(denied):
                    make()
    # A goal that fills itself in needs a number to reach.
    with pytest.raises(psycopg.errors.CheckViolation):
        goal2(api, w, w.manager, "company", "No target", source="tasks_done")
    # Changing the source later is checked again: the member cannot switch their goal to Billing.
    mine = goal2(api, w, w.editor, "person", "Make 200 calls", owner=w.editor, label="calls", start=0, target=200, current=10, kind="count")
    with pytest.raises(denied):
        as_(api, w, w.editor, "update pulse.goal set source='billing_received' where id=%s returning id", (mine,))
    # The number's history: written by the database whenever the number moves, read by whoever reads the goal.
    as_(api, w, w.editor, "update pulse.goal set current_value=40 where id=%s returning id", (mine,))
    as_(api, w, w.editor, "update pulse.goal set title='Make 200 sales calls' where id=%s returning id", (mine,))  # not a new value
    history = lambda who: [float(r["value"]) for r in as_(api, w, who, "select value from pulse.goal_value where goal_id=%s order by at", (mine,))]  # noqa: E731
    assert history(w.editor) == [10.0, 40.0]
    assert history(w.editor2) == [10.0, 40.0]   # their pod head
    assert history(w.lead) == [10.0, 40.0]      # HR
    assert history(w.manager) == [10.0, 40.0]   # admin
    assert history(w.outsider) == []            # another pod's member
    with pytest.raises(denied):
        as_(api, w, w.editor, "insert into pulse.goal_value(org_id,goal_id,value) values(pulse.current_org(),%s,999)", (mine,))
    # The auto-filled total follows the goal's own visibility: a company goal's for every staff member; a person's
    # goal's only for those who read that goal.
    company = goal2(api, w, w.manager, "company", "Collect 25 L", label="rupees collected", start=0, target=2500000, kind="money", source="billing_received")
    personal = goal2(api, w, w.manager, "person", "My collections", owner=w.manager, label="rupees collected", start=0, target=500000, kind="money", source="billing_received")
    auto = lambda who, g: one(api, w, who, "select pulse.goal_auto(%s) a", (g,))["a"]  # noqa: E731
    for who in (w.editor, w.editor2, w.lead, w.outsider):
        assert auto(who, company) is not None and auto(who, company)["value"] == 0
    assert auto(w.outsider, personal) is None
    assert auto(w.editor, personal) is None
    assert auto(w.manager, personal)["value"] == 0
    assert progress(api, w, w.editor, company)["current"] == 0


def test_milestones_check_ins_and_done_tasks_fill_progress(api, worker, owner, team):
    w = team
    # A milestone without a number: progress is the share of steps ticked.
    steps = [{"id": "s1", "title": "Book the name", "done": True}, {"id": "s2", "title": "File the forms", "done": False},
             {"id": "s3", "title": "Get the certificate", "done": False}, {"id": "s4", "title": "Open the bank account", "done": True}]
    m = goal2(api, w, w.manager, "company", "Register the company", target_on="2026-12-31", kind="milestone", steps=steps)
    p = progress(api, w, w.editor, m)
    assert (p["basis"], float(p["progress"]), p["steps"], p["stepsDone"]) == ("steps", 0.5, 4, 2)
    # Check-ins: the share of active staff who checked in on the last day anyone did.
    with owner.transaction():
        set_tenant(owner, w.org)
        staff = owner.execute("select count(*) n from pulse.person where org_id=%s and side='staff' and status='active'", (w.org,)).fetchone()["n"]
        for who in (w.editor, w.editor2):
            owner.execute("insert into pulse.attendance_entry(org_id,person_id,checked_in_at,checked_out_at) values(%s,%s,now()-interval '2 hours',now()-interval '1 hour')", (w.org, who))
    c = goal2(api, w, w.manager, "company", "Everyone checks in", label="staff checking in (%)", start=0, target=100, kind="count", source="checkins")
    expected = round(100 * 2 / staff)
    assert float(one(api, w, w.editor, "select pulse.goal_auto(%s) a", (c,))["a"]["value"]) == expected
    assert float(progress(api, w, w.editor, c)["progress"]) == pytest.approx(expected / 100, abs=1e-4)
    # Done tasks under it.
    t1 = new_task(api, w, w.editor, title="Call Lotus Interiors")
    t2 = new_task(api, w, w.editor, title="Call Harbor Builders")
    g = goal2(api, w, w.editor, "person", "Make 2 calls", owner=w.editor, label="calls", start=0, target=2, kind="count", source="tasks_done")
    link(api, w, w.editor, g, task=t1)
    link(api, w, w.editor, g, task=t2)
    as_(api, w, w.editor, "select pulse.task_move(%s,'done')", (t1,))
    assert float(progress(api, w, w.editor, g)["progress"]) == 0.5
