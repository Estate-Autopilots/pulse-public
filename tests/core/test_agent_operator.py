"""AGENT-OPERATOR (2080): the operator view's rules in the database. A click that sends, pays, deletes or approves is
asked every time (needed 'confirm'), whatever the AI employee's level or a kept "Always", and only the person whose
screen it is says yes (never Always; an admin cannot answer it for them). A failed step's trail; the daily review
groups the problems AI employees filed, writes its finding on the first report, folds the rest into it and adds the
lesson to the AI employee's playbook once. Synthetic data only."""
import uuid

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from test_agent_coworkers import agent_one, make_agent, owner_sql
from test_agent_ui_control import ask, helped, pending
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)


def test_send_pay_delete_ask_the_person_every_time(api, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "pip-operator-synthetic")
    helped(api, w, agent, w.editor)
    # Even at the admin level, a risky click is asked, and only the person whose screen it is sees and answers it.
    assert one(api, w, w.manager, "select pulse.agent_ui_level_set(%s,'admin') s", (agent,))["s"]["level"] == "admin"
    r = ask(api, w, agent, w.editor, "element.click", {"target": "b3", "text": "Send to client"})
    assert r["state"] == "asked" and r["needed"] == "confirm" and "asked first" in r["message"]
    mine = pending(api, w, w.editor)["asks"]
    assert [(a["id"], a["mine"], a["canAlways"]) for a in mine] == [(r["id"], True, False)]
    assert pending(api, w, w.manager)["asks"] == [], "an admin does not answer a click on a colleague's screen"
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.manager, "select pulse.agent_ui_decide(%s,'once')", (r["id"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.agent_ui_decide(%s,'always')", (r["id"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, agent, "select pulse.agent_ui_decide(%s,'once')", (r["id"],))
    d = one(api, w, w.editor, "select pulse.agent_ui_decide(%s,'once') d", (r["id"],))["d"]
    assert d["state"] == "sent" and d["decision"] == "once"
    # Once is once: the next risky click asks again; an ordinary click at this level goes at once.
    assert ask(api, w, agent, w.editor, "element.click", {"target": "b9", "text": "Delete line"})["state"] == "asked"
    assert ask(api, w, agent, w.editor, "element.click", {"target": "b4", "text": "Add line"})["state"] == "sent"
    # An admin's "Always" for clicks (at view level, an ordinary click asks first) never covers a risky one.
    one(api, w, w.manager, "select pulse.agent_ui_level_set(%s,'view')", (agent,))
    plain = ask(api, w, agent, w.editor, "element.click", {"target": "b5", "text": "Save draft"})
    assert plain["state"] == "asked" and plain["needed"] == "act"
    assert one(api, w, w.manager, "select pulse.agent_ui_decide(%s,'always') d", (plain["id"],))["d"]["state"] == "sent"
    assert ask(api, w, agent, w.editor, "element.click", {"target": "b6", "text": "Open"})["state"] == "sent"
    risky = ask(api, w, agent, w.editor, "element.click", {"target": "b7", "text": "Pay now"})
    assert risky["state"] == "asked" and risky["needed"] == "confirm"
    # The person may say no.
    assert one(api, w, w.editor, "select pulse.agent_ui_decide(%s,'no') d", (risky["id"],))["d"]["state"] == "refused"
    # Uploads and downloads are act-level actions.
    assert one(api, w, w.editor, "select pulse.agent_ui_action_level('file.upload','{}') l")["l"] == "act"
    assert one(api, w, w.editor, "select pulse.agent_ui_action_level('file.download','{}') l")["l"] == "act"


def test_failed_steps_are_grouped_reviewed_and_teach_the_playbook(api, owner, worker, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "pip-review-synthetic")
    helped(api, w, agent, w.editor)
    one(api, w, w.manager, "select pulse.agent_ui_level_set(%s,'act')", (agent,))
    ok = ask(api, w, agent, w.editor, "sidebar.set", {"open": False})
    one(api, w, w.editor, "select pulse.agent_ui_claim(%s)", (ok["id"],))
    one(api, w, w.editor, "select pulse.agent_ui_done(%s,true,'{}',null)", (ok["id"],))
    bad = ask(api, w, agent, w.editor, "element.click", {"target": "b2", "text": "Add line"})
    one(api, w, w.editor, "select pulse.agent_ui_claim(%s)", (bad["id"],))
    one(api, w, w.editor, "select pulse.agent_ui_done(%s,false,null,%s)", (bad["id"], "Nothing on their screen matches “Add line”"))
    # The trail of its steps before the failed one, for the report (the API role reads it in the person's session).
    trail = one(api, w, w.editor, "select pulse.agent_ui_trail(%s) t", (bad["id"],))["t"]
    assert [(s["kind"], s["status"]) for s in trail] == [("sidebar.set", 200), ("element.click", 500)]
    # Two reports of the same problem by the AI employee (the API files them; written here as the owner), one "again".
    fp = "ab" * 32
    ids = []
    for n in (1, 2):
        rid = uuid.uuid4()
        ids.append(rid)
        owner_sql(owner, w, """insert into pulse.reported_bug (id, org_id, number, person_id, command_id, words, route, fingerprint, errors, trail, agent_action)
            values (%s, %s, %s, %s, %s, 'Pip could not click “Add line” on /erp/new', '/erp/new', %s, %s, %s, %s)""",
                  (rid, w.org, 900 + n, agent, f"op-{uuid.uuid4()}", fp, Jsonb([{"kind": "error", "message": "element.click: Nothing matches"}]), Jsonb(trail), bad["id"]))
    owner_sql(owner, w, "insert into pulse.reported_bug_event (org_id, report_id, kind, value, note) values (%s, %s, 'note', 'again', 'Pip: again')", (w.org, ids[0]))
    # A person's own report on the same screen is not the AI employee's: it is not in the review.
    owner_sql(owner, w, """insert into pulse.reported_bug (org_id, number, person_id, command_id, words, route, fingerprint)
        values (%s, 950, %s, %s, 'Synthetic person report', '/erp/new', %s)""", (w.org, w.editor, f"pr-{uuid.uuid4()}", fp))

    def groups():
        rows = worker.execute("select * from pulse.operator_bug_groups(now() - interval '1 day')").fetchall()
        return [g for g in rows if str(g["org_id"] if isinstance(g, dict) else g[0]) == str(w.org)]
    worker.row_factory = dict_row
    g = groups()
    assert len(g) == 1
    assert g[0]["numbers"] == [901, 902] and g[0]["times"] == 3 and g[0]["first_number"] == 901 and g[0]["reviewed"] is False
    assert g[0]["agent_name"] == "Pip Review Synthetic" and g[0]["route"] == "/erp/new"
    # The review: its finding on the first report, the second folded into it, the lesson in the playbook (once).
    lesson = "On a new quotation, add a line with the button “Add item”, not “Add line”."
    r = worker.execute("select pulse.operator_bug_review(%s,%s,%s) r", (w.org, fp, Jsonb({"cause": "The button is called Add item.", "fix": "Read the screen first.", "lesson": lesson}))).fetchone()["r"]
    assert r["number"] == 901 and r["folded"] == 1 and r["ruleId"]
    again = worker.execute("select pulse.operator_bug_review(%s,%s,%s) r", (w.org, fp, Jsonb({"cause": "x", "fix": "y", "lesson": lesson}))).fetchone()["r"]
    assert again["folded"] == 0 and again.get("ruleId") is None, "the same lesson is kept once"
    g = groups()
    assert len(g) == 1 and g[0]["numbers"] == [901] and g[0]["reviewed"] is True
    rows = owner_sql(owner, w, "select body, source, set_by from pulse.agent_rule where agent_id = %s and retired_at is null", (agent,))
    assert [(x["body"], x["source"], x["set_by"]) for x in rows] == [(lesson, "review", agent)]
    folded = owner_sql(owner, w, "select number, duplicate_of from pulse.reported_bug where id = %s", (ids[1],))[0]
    assert folded["duplicate_of"] == ids[0]
    notes = owner_sql(owner, w, "select kind, value, note from pulse.reported_bug_event where report_id = %s and value = 'review' order by at", (ids[0],))
    assert notes and "Likely cause: The button is called Add item." in notes[0]["note"] and "Playbook: " in notes[0]["note"]
    # The review functions are the worker's only.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.manager, "select pulse.operator_bug_groups(now())")
