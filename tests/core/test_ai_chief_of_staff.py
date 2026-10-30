"""AI-AUTONOMY (1350): the Chief of Staff AI employee holds the admin role like a person: only an admin makes it so; it
reads the admin view and acts through Pulse's own functions (create, assign, move work; a direct message to a colleague;
a request on the board), each checked as for an admin; it still never deletes; another AI employee or a person cannot use
its tools; nothing crosses organisations. Synthetic people only."""
import json
import uuid

import psycopg
import pytest
from helpers import build_world
from test_agent_coworkers import agent_one, make_agent, owner_sql
from test_hr_suite import _staff
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def run_of(api, owner, w, agent):
    owner_sql(owner, w, "update pulse.agent_member set listens_to='everyone' where person_id=%s", (agent,))
    dm = owner_sql(owner, w, "select pulse.agent_dm_with(%s,%s) id", (agent, w.manager))[0]["id"]
    as_(api, w, w.manager, "select pulse.chat_send(%s,%s,null,'[]',%s,null)", (dm, f"Sort out the late work (test) {uuid.uuid4()}", uuid.uuid4()))
    [c] = agent_one(api, w, agent, "select pulse.agent_events_claim(5) e")["e"]
    d = agent_one(api, w, agent, "select pulse.agent_dispatch(%s,%s,'quick','test') d", (c["event"]["id"], c["leaseToken"]))["d"]
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',0,0,null) r", (d["runId"],))
    return d["runId"]


def username(owner, w, person):
    return owner_sql(owner, w, "select username from pulse.people_profile where person_id=%s", (person,))[0]["username"]


def act(api, w, agent, run, actions):
    return agent_one(api, w, agent, "select pulse.agent_chief_act(%s,%s::jsonb) r", (run, json.dumps({"actions": actions})))["r"]["results"]


def test_only_an_admin_makes_the_chief_and_only_the_chief_uses_its_tools(api, worker, owner, team):  # noqa: F811
    w = team
    chief, _ = make_agent(api, w, "chief-of-staff-test")
    other, _ = make_agent(api, w, "not-chief-test")
    owner_sql(owner, w, "update pulse.agent_member set tools=array['chats'] where person_id=%s", (other,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.agent_chief_set(%s,true)", (chief,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, chief, "select pulse.agent_chief_set(%s,true) r", (chief,))
    assert one(api, w, w.manager, "select pulse.agent_chief_set(%s,true) c", (chief,))["c"] is True
    assert agent_one(api, w, chief, "select pulse.agent_chief(%s) c", (chief,))["c"] is True
    snap = agent_one(api, w, chief, "select pulse.agent_chief_snapshot() s")["s"]
    assert {"tasks", "attention", "projects", "people", "board", "aiEmployees", "notSignedIn"} <= set(snap)
    assert all("email" not in p and "phone" not in p for p in snap["people"]), "nothing secret about people"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, other, "select pulse.agent_chief_snapshot() s")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.manager, "select pulse.agent_chief_snapshot() s")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        act(api, w, other, run_of(api, owner, w, other), [])
    one(api, w, w.manager, "select pulse.agent_chief_set(%s,false) c", (chief,))
    assert agent_one(api, w, chief, "select pulse.agent_chief(%s) c", (chief,))["c"] is False


def test_the_chief_acts_through_pulses_own_checks_and_never_deletes(api, worker, owner, team):  # noqa: F811
    w = team
    chief, _ = make_agent(api, w, "chief-acts-test")
    one(api, w, w.manager, "select pulse.agent_chief_set(%s,true) c", (chief,))
    run = run_of(api, owner, w, chief)
    ed = username(owner, w, w.editor)
    r = act(api, w, chief, run, [
        {"type": "task.create", "title": "Send the Skyline brochure (test)", "assignee": ed, "dueOn": "2026-11-02", "notes": "Asked by leadership (test)."},
        {"type": "dm", "to": ed, "text": "I gave you the brochure task, due Monday (test)."},
        {"type": "task.update", "taskId": str(uuid.uuid4()), "dueOn": "2026-11-03"},
        {"type": "drop.table", "title": "x"}])
    assert [x["ok"] for x in r] == [True, True, False, False], r
    tid = r[0]["taskId"]
    t = owner_sql(owner, w, "select title, assignee_person_id, due_at::date::text due from pulse.task where id=%s", (tid,))[0]
    assert t["title"] == "Send the Skyline brochure (test)" and t["assignee_person_id"] == w.editor and t["due"] == "2026-11-02"
    assert act(api, w, chief, run, [{"type": "task.update", "taskId": tid, "dueOn": "2026-11-04"}])[0]["ok"] is True
    assert owner_sql(owner, w, "select due_at::date::text d from pulse.task where id=%s", (tid,))[0]["d"] == "2026-11-04"
    dm = owner_sql(owner, w, "select pulse.agent_dm_with(%s,%s) id", (chief, w.editor))[0]["id"]
    assert owner_sql(owner, w, "select count(*)::int n from pulse.chat_message where channel_id=%s and author_id=%s", (dm, chief))[0]["n"] == 1
    # The admin role does not lift the AI guard: no delete, no organisation switch.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, chief, "delete from pulse.task where id=%s returning id", (tid,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, chief, "select pulse.agent_org_policy_set('{\"clientsOn\": true}') r")


def test_the_chief_stays_inside_its_organisation(api, worker, owner, team):  # noqa: F811
    w = team
    chief, _ = make_agent(api, w, "chief-home-test")
    one(api, w, w.manager, "select pulse.agent_chief_set(%s,true) c", (chief,))
    other = build_world(worker, owner, api)
    _staff(worker, other)
    foreign = one(api, other, other.manager, "select pulse.task_save(null,'{\"title\": \"Their work (test)\"}') id")["id"]
    run = run_of(api, owner, w, chief)
    r = act(api, w, chief, run, [{"type": "task.move", "taskId": str(foreign), "status": "done"},
                                 {"type": "dm", "to": "nobody-here-test", "text": "hi"}])
    assert [x["ok"] for x in r] == [False, False]
    assert "Their work (test)" not in str(agent_one(api, w, chief, "select pulse.agent_chief_snapshot() s")["s"])
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, other, other.manager, "select pulse.agent_chief_set(%s,true) c", (chief,))
