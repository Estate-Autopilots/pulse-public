"""AI-FIX (19 Nov 2026, BUG-CENSUS BC-059; migration 2452): "my tasks" asked of an AI employee is answered from all of the
asker's own tasks, not only the ones the AI employee made. While a person is getting help from it (they wrote to it in the
last 30 minutes), pulse.agent_asker_tasks lists that person's own tasks (assignee or owner) and nobody else's; with no
recent message, or for another colleague, it is refused. Its own row security is unchanged. Synthetic people only."""
import psycopg
import pytest
from test_agent_coworkers import agent_one, make_agent
from test_agent_ui_control import helped
from test_tasks_rt1 import new_task, team  # noqa: F401  (team is a fixture)


def asker_tasks(api, w, agent, person, status="open"):
    return agent_one(api, w, agent, "select coalesce(jsonb_agg(j), '[]') v from pulse.agent_asker_tasks(%s,%s,100) j", (person, status))["v"]


def test_an_ai_employee_reads_the_askers_own_tasks_only_while_it_helps_them(api, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "asker-tasks-synthetic")
    # The HR lead gives the editor three tasks; one is finished. The AI employee made none of them.
    given = [new_task(api, w, w.lead, title=f"Synthetic task {i} for the editor", assigneeId=str(w.editor)) for i in range(3)]
    other = new_task(api, w, w.lead, title="Synthetic task for the pod head", assigneeId=str(w.editor2))
    agent_one(api, w, agent, "select 1 v")  # the session works
    seen_by_row_security = agent_one(api, w, agent, "select count(*)::int n from pulse.task where id = any(%s::uuid[])", (given,))["n"]
    assert seen_by_row_security == 0, "the AI employee's own row security does not open them (the reason for this function)"

    # Nobody wrote to it: refused.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        asker_tasks(api, w, agent, w.editor)

    helped(api, w, agent, w.editor, "Synthetic: which of my tasks are pending?")
    open_now = asker_tasks(api, w, agent, w.editor)
    assert sorted(t["id"] for t in open_now) == sorted(str(x) for x in given)
    assert all(t["assigneeId"] == str(w.editor) for t in open_now) and str(other) not in [t["id"] for t in open_now]

    ok = lambda person: agent_one(api, w, agent, "select pulse.agent_asker_ok(%s) v", (person,))["v"]  # noqa: E731
    assert ok(w.editor) is True and ok(w.editor2) is False
    # Another colleague who did not write to it stays closed, and so does a bad status.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        asker_tasks(api, w, agent, w.editor2)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        asker_tasks(api, w, agent, w.editor, "everything")
