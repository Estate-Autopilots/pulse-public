"""AGENTS-LIVE (1714): in a company other than the install's (the test world's own organisation), an AI employee is
given a task and is @mentioned in a task's discussion like a colleague. Before, the mention raised "Mention active team
members" (work_comment_add checked staff only) and an AI employee that was off simply vanished from the pickers. Now the
mentioned AI employee is woken on that task, answers there with a comment and changes nothing else of a task that is not
its own; one that is switched off is refused with its name and what to do; activating it (the pop-up's Allow) switches
it on for tasks, and agent_reach lists whom the viewer can call. Synthetic people only."""
import psycopg
import pytest
from test_agent_coworkers import owner_sql
from test_ai_tasks import act, ai, finish, look
from test_tasks_rt1 import new_task, one, team  # noqa: F401  (team is a fixture)


def comment(api, w, who, task, body, mentions):
    return one(api, w, who, "select pulse.work_comment_add(%s,null,%s,%s) c", (task, body, mentions))["c"]


def test_an_ai_employee_is_given_a_task_and_mentioned_in_its_discussion(api, worker, owner, team):  # noqa: F811
    w = team
    doer = ai(api, owner, w, "mira-test")
    helper = ai(api, owner, w, "luna-test")
    # Given a task directly.
    tid = new_task(api, w, w.manager, title="Price the 5 kW rooftop (test)", assigneeId=str(doer))
    assert owner_sql(owner, w, "select assignee_person_id a from pulse.task where id=%s", (tid,))[0]["a"] == doer
    # Mentioned in the task's discussion: no "not active", the mention wakes it on this task.
    comment(api, w, w.manager, tid, "@luna-test what warranty do we offer on panels?", [helper])
    keys = [r["event_key"] for r in owner_sql(owner, w, "select event_key from pulse.agent_event where agent_id=%s and subject_id=%s", (helper, tid))]
    assert len(keys) == 1 and keys[0].startswith(f"task:{tid}:mention:"), keys
    run, ctx = look(api, w, helper)
    assert ctx["cause"] == "mention" and ctx["task"]["title"] == "Price the 5 kW rooftop (test)"
    r = act(api, w, helper, run, {"comment": "Ten years on panels (synthetic).", "status": "done", "plan": ["Check the warranty"]})
    finish(api, w, helper, run)
    assert r["commentId"]
    assert owner_sql(owner, w, "select author_id a, body from pulse.work_comment where id=%s", (r["commentId"],))[0] == {"a": helper, "body": "Ten years on panels (synthetic)."}
    # The task stays its assignee's: status, work record and reviewer untouched by the helper.
    t = owner_sql(owner, w, "select assignee_person_id a, status from pulse.task where id=%s", (tid,))[0]
    assert t == {"a": doer, "status": "open"}
    assert owner_sql(owner, w, "select agent_id from pulse.agent_task_work where task_id=%s", (tid,)) in ([], [{"agent_id": doer}])
    # Switched off: refused with its name, never "not active".
    owner_sql(owner, w, "update pulse.agent_member set disabled_at=now(), paused_reason='synthetic pause' where person_id=%s", (helper,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="switched off"):
        comment(api, w, w.manager, tid, "@luna-test once more", [helper])
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="switched off"):
        new_task(api, w, w.manager, title="Check the inverter (test)", assigneeId=str(helper))
    reach = {x["id"]: x for x in one(api, w, w.manager, "select pulse.agent_reach(null) r")["r"]}
    assert reach[str(helper)]["state"] == "paused" and reach[str(helper)]["canSwitch"] and reach[str(doer)]["canTask"]
    # A plain member may not switch it on; its manager (an admin here) activates it for tasks, then gives it the task.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_power(%s,true)", (helper,))
    a = one(api, w, w.manager, "select pulse.agent_activate(%s,null,'tasks') a", (helper,))["a"]
    assert a["state"] == "on" and a["canTask"]
    new_task(api, w, w.manager, title="Check the inverter (test)", assigneeId=str(helper))
