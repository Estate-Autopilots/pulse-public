"""AI-AUTONOMY (1351): many task changes as ONE card (Apply all, each change through task_save as the person who decides),
only from an AI employee that runs work; the daily triage makes that job a task of its own once a day. Synthetic only."""
import json
import uuid

import psycopg
import pytest
from test_agent_coworkers import agent_one, make_agent, owner_sql
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def run_of(api, owner, w, agent):
    owner_sql(owner, w, "update pulse.agent_member set listens_to='everyone' where person_id=%s", (agent,))
    dm = owner_sql(owner, w, "select pulse.agent_dm_with(%s,%s) id", (agent, w.manager))[0]["id"]
    as_(api, w, w.manager, "select pulse.chat_send(%s,%s,null,'[]',%s,null)", (dm, f"Triage please (test) {uuid.uuid4()}", uuid.uuid4()))
    [c] = agent_one(api, w, agent, "select pulse.agent_events_claim(5) e")["e"]
    d = agent_one(api, w, agent, "select pulse.agent_dispatch(%s,%s,'quick','test') d", (c["event"]["id"], c["leaseToken"]))["d"]
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',0,0,null) r", (d["runId"],))
    return d["runId"]


def test_one_card_for_many_changes_applied_as_the_person_who_decides(api, worker, owner, team):  # noqa: F811
    w = team
    pm, _ = make_agent(api, w, "pm-batch-test")
    owner_sql(owner, w, "update pulse.agent_member set access='operations', tools=array['chats','tasks','memory'] where person_id=%s", (pm,))
    t1 = one(api, w, w.manager, "select pulse.task_save(null,'{\"title\": \"Unowned brochure (test)\"}') id")["id"]
    t2 = one(api, w, w.manager, "select pulse.task_save(null,'{\"title\": \"Undated reel (test)\"}') id")["id"]
    ed = owner_sql(owner, w, "select username from pulse.people_profile where person_id=%s", (w.editor,))[0]["username"]
    run = run_of(api, owner, w, pm)
    items = [{"taskId": str(t1), "assignee": ed, "dueOn": "2026-11-05", "why": "editor, light load"},
             {"taskId": str(t2), "dueOn": "2026-11-06", "why": "next shoot"},
             {"taskId": str(uuid.uuid4()), "assignee": ed}]
    card = agent_one(api, w, pm, "select pulse.agent_propose_batch(%s,%s::jsonb) r", (run, json.dumps({"title": "Triage (test)", "items": items})))["r"]
    assert card["items"] == 2
    assert agent_one(api, w, pm, "select pulse.agent_propose_batch(%s,%s::jsonb) r", (run, json.dumps({"items": items})))["r"]["id"] == card["id"], "one card a run"
    pr = owner_sql(owner, w, "select kind, state, approver_id from pulse.agent_proposal where id=%s", (card["id"],))[0]
    assert pr["kind"] == "batch" and pr["state"] == "pending"
    other, _ = make_agent(api, w, "not-pm-test")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, other, "select pulse.agent_propose_batch(%s,%s::jsonb) r", (run_of(api, owner, w, other), json.dumps({"items": items})))
    with pytest.raises(psycopg.errors.NoDataFound):
        as_(api, w, w.editor, "select pulse.agent_proposal_decide(%s,'send',null,'button')", (card["id"],))
    r = one(api, w, pr["approver_id"], "select pulse.agent_proposal_decide(%s,'send',null,'button') r", (card["id"],))["r"]
    assert r["state"] == "sent" and r["applied"] == 2 and r["failed"] == 0
    got = owner_sql(owner, w, "select id, assignee_person_id, due_at::date::text due from pulse.task where id in (%s,%s) order by title", (t1, t2))
    by = {x["id"]: x for x in got}
    assert by[t1]["assignee_person_id"] == w.editor and by[t1]["due"] == "2026-11-05" and by[t2]["due"] == "2026-11-06"
    # Deciding again changes nothing.
    assert one(api, w, pr["approver_id"], "select pulse.agent_proposal_decide(%s,'send',null,'button') r", (card["id"],))["r"]["state"] == "sent"


def test_the_daily_triage_is_a_task_of_its_own_once_a_day(api, worker, owner, team):  # noqa: F811
    w = team
    pm, _ = make_agent(api, w, "pm-triage-test")
    owner_sql(owner, w, "update pulse.agent_member set access='operations', tools=array['chats','tasks','memory'] where person_id=%s", (pm,))
    one(api, w, w.manager, "select pulse.task_save(null,'{\"title\": \"Nobody owns this (test)\"}') id")
    assert agent_one(api, w, pm, "select pulse.agent_triage_start() r")["r"] is None, "off until its managers switch it on"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, pm, "select pulse.agent_daily_triage_set(%s,true) r", (pm,))
    one(api, w, w.manager, "select pulse.agent_daily_triage_set(%s,true) r", (pm,))
    hour = owner_sql(owner, w, "select extract(hour from now() at time zone pulse.org_time_zone())::int h")[0]["h"]
    r = agent_one(api, w, pm, "select pulse.agent_triage_start() r")["r"]
    if hour < 9:
        assert r is None
        return
    assert r["tasks"] >= 1 and r["taskId"]
    assert agent_one(api, w, pm, "select pulse.agent_triage_start() r")["r"] is None, "once a day"
    t = owner_sql(owner, w, "select title, assignee_person_id from pulse.task where id=%s", (r["taskId"],))[0]
    assert t["title"].startswith("Daily triage:") and t["assignee_person_id"] == pm
