"""TASK-CLEAN (owner, 17 Nov 2026): tasks made by automation do not pile up on a person one by one (2198). A watcher's
items (bug alerts, radar, costs) go under one summary task per watcher; other automation gives a person at most 3 open
top-level tasks, the rest go under its summary task; automation's sub-tasks under a person's task become steps inside it
(nobody on them). People's own tasks, and an AI employee's own task, are never touched. Synthetic tenants only."""
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import team  # noqa: F401  (the fixture)


def made_by(api, w, who, actor, agent=False, **fields):
    with api.transaction():
        set_tenant(api, w.org, who)
        api.execute("select set_config('pulse.actor_account', %s, true)", (actor,))
        if agent:
            api.execute("select set_config('pulse.agent_session', 'on', true)")
        return api.execute("select pulse.task_save(null, %s) id", (Jsonb(fields),)).fetchone()["id"]


def row(api, w, who, tid):
    with api.transaction():
        set_tenant(api, w.org, who)
        return api.execute("""select t.title, t.assignee_person_id, t.owner_id, t.parent_id, t.auto_source, t.auto_digest, t.status,
          p.title parent_title, p.assignee_person_id parent_assignee, p.auto_digest parent_digest
          from pulse.task t left join pulse.task p on p.id = t.parent_id where t.id = %s""", (tid,)).fetchone()


def test_watchers_give_a_person_one_task(api, team):
    w = team
    route = "AC tasks route (AUT-2207) · ac-bug-alerts"
    a = made_by(api, w, w.lead, route, title="Bug radar: screens checked every night", assigneeId=str(w.editor))
    b = made_by(api, w, w.lead, route, title="Bug 2: /dashboard · 1 report", assigneeId=str(w.editor))
    c = made_by(api, w, w.lead, route, title="Bug 3: /leads · 1 report", assigneeId=str(w.editor), parentId=str(a))
    ra, rb, rc = row(api, w, w.lead, a), row(api, w, w.lead, b), row(api, w, w.lead, c)
    # The watcher's first task is the editor's one summary task; the next ones sit under it with nobody on them.
    assert ra["assignee_person_id"] == w.editor and ra["auto_digest"] and ra["auto_source"] == route
    assert rb["assignee_person_id"] is None and rb["owner_id"] is None and rb["parent_id"] == a
    assert rc["assignee_person_id"] is None and rc["parent_id"] == a
    # The caller still finds and moves its own task by id.
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.task_move(%s, 'done')", (b,))
        assert api.execute("select pulse.task_auto_source_name(%s) n", (route,)).fetchone()["n"] == "AC bug alerts"
    assert row(api, w, w.lead, b)["status"] == "done"


def test_other_automation_caps_at_three_top_level_tasks(api, team):
    w = team
    lane = "agent:synthetic.planner"
    ids = [made_by(api, w, w.lead, lane, title=f"Synthetic EXMP0001234 step {i}", assigneeId=str(w.editor)) for i in range(5)]
    rows = [row(api, w, w.lead, t) for t in ids]
    assert [r["assignee_person_id"] for r in rows[:3]] == [w.editor] * 3 and all(r["parent_id"] is None for r in rows[:3])
    assert rows[3]["assignee_person_id"] is None and rows[3]["parent_id"] == rows[4]["parent_id"] and rows[3]["parent_title"] == "synthetic.planner: automatic items"
    # Only one summary task for this automation and person.
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        n = api.execute("select count(*) n from pulse.task where auto_digest and auto_source = %s", (lane,)).fetchone()["n"]
    assert n == 1


def test_automation_sub_tasks_become_steps_of_the_persons_task(api, team):
    w = team
    agent = "agent:synthetic.helper"
    parent = made_by(api, w, w.lead, agent, title="Synthetic EXMP0001234 launch brief", assigneeId=str(w.editor))
    kid = made_by(api, w, w.lead, agent, title="Synthetic EXMP0001234 check the copy", assigneeId=str(w.editor), parentId=str(parent))
    rp, rk = row(api, w, w.lead, parent), row(api, w, w.lead, kid)
    assert rp["assignee_person_id"] == w.editor and rk["parent_id"] == parent and rk["assignee_person_id"] is None


def test_people_and_an_ai_employees_own_task_are_untouched(api, team):
    w = team
    mine = [made_by(api, w, w.lead, "lead@example.test", title=f"Synthetic EXMP0001234 by hand {i}", assigneeId=str(w.editor)) for i in range(5)]
    assert all(row(api, w, w.lead, t)["assignee_person_id"] == w.editor and row(api, w, w.lead, t)["auto_source"] is None for t in mine)
    own = [made_by(api, w, w.editor, "agent:synthetic.self", agent=True, title=f"Synthetic EXMP0001234 my own {i}") for i in range(5)]
    assert all(row(api, w, w.editor, t)["assignee_person_id"] == w.editor for t in own)
    app = [made_by(api, w, w.editor, "app:Claude:editor", title=f"Synthetic EXMP0001234 from my Claude {i}") for i in range(5)]
    assert all(row(api, w, w.editor, t)["assignee_person_id"] == w.editor for t in app)
    # A run a person approved (a meeting import, a backfill) is their own act: never grouped.
    imp = [made_by(api, w, w.lead, "import-tool · approver: Synthetic Owner", title=f"Synthetic EXMP0001234 imported {i}", assigneeId=str(w.editor)) for i in range(5)]
    assert all(row(api, w, w.lead, t)["assignee_person_id"] == w.editor and row(api, w, w.lead, t)["auto_source"] is None for t in imp)
