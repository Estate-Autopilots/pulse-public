"""FOUNDATIONS (1569): goals for a person, a team and the company, with projects and tasks under them and progress
rolled up, enforced by the database under forced row security. Synthetic tenants only."""
import uuid

import psycopg
import pytest
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
      from pg_class c where c.oid in ('pulse.goal'::regclass,'pulse.goal_link'::regclass) order by 1""").fetchall()
    assert [(r["relname"], r["relrowsecurity"], r["relforcerowsecurity"], r["tenant"]) for r in rows] == [
        ("goal", True, True, True), ("goal_link", True, True, True)]


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
