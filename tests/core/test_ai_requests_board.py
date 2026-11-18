"""AI-AUTONOMY (1233): an AI employee that lacks a tool files a request on the bug and feature board (the same request
adds its vote, not a second item); people upvote and discuss; leadership puts items on the dev agents' queue; a server
dev agent with a service token reads every organisation's queued items, comments and marks them shipped; nothing leaks
between organisations, and nobody else holds a token. Synthetic people only."""
import uuid

import psycopg
import pytest
from helpers import build_world
from psycopg.types.json import Jsonb
from test_agent_coworkers import agent_one, lead, make_agent, owner_sql
from test_hr_suite import _staff
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def run_of(api, owner, w, agent):
    """One finished run of this AI employee (requests are filed inside one of its runs): a direct message, claimed and
    dispatched as its runtime does."""
    owner_sql(owner, w, "update pulse.agent_member set listens_to='everyone' where person_id=%s", (agent,))
    dm = owner_sql(owner, w, "select pulse.agent_dm_with(%s,%s) id", (agent, w.manager))[0]["id"]
    as_(api, w, w.manager, "select pulse.chat_send(%s,%s,null,'[]',%s,null)", (dm, f"Need a hand (test) {uuid.uuid4()}", uuid.uuid4()))
    [c] = agent_one(api, w, agent, "select pulse.agent_events_claim(5) e")["e"]
    d = agent_one(api, w, agent, "select pulse.agent_dispatch(%s,%s,'quick','test') d", (c["event"]["id"], c["leaseToken"]))["d"]
    agent_one(api, w, agent, "select pulse.agent_run_finish(%s,'done',0,0,null) r", (d["runId"],))
    return d["runId"]


def file(api, w, agent, run, **p):
    return agent_one(api, w, agent, "select pulse.agent_request_file(%s,%s) r", (run, Jsonb(p)))["r"]


def token(owner, name="dev-agent-test"):
    with owner.transaction():
        return owner.execute("select pulse.dev_queue_token_issue(%s) t", (name,)).fetchone()["t"]


def test_an_ai_files_what_it_lacks_and_the_same_request_gets_a_vote(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "ops-chief-board")
    other, _ = make_agent(api, w, "hr-ai-board")
    r1 = file(api, w, agent, run_of(api, owner, w, agent), kind="tool_needed", title="Read the leave calendar", details="Asked who is off Friday (test).")
    assert r1["new"] is True and r1["number"] >= 1
    again = file(api, w, other, run_of(api, owner, w, other), kind="tool_needed", title="  read the LEAVE calendar ", details="Me too (test).")
    assert again == {"id": r1["id"], "number": r1["number"], "new": False}
    item = one(api, w, w.editor, "select pulse.board_item(%s) b", (r1["id"],))["b"]
    assert item["votes"] == 2 and item["byAgent"] is True and item["devQueue"] is True and item["kind"] == "tool_needed"
    assert [d["note"] for d in item["discussion"]] == ["Me too (test)."]
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        file(api, w, agent, run_of(api, owner, w, agent), kind="payroll", title="Pay me")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="inside one of your runs"):
        file(api, w, agent, run_of(api, owner, w, other), title="Someone else's run")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.agent_request_file(%s,%s)", (run_of(api, owner, w, agent), Jsonb({"title": "A person is not an AI"})))


def test_people_vote_and_discuss_and_bugs_stay_with_their_reporter_and_leadership(api, worker, owner, team):  # noqa: F811
    w = team
    lead(worker, w, w.lead)
    agent, _ = make_agent(api, w, "board-ai")
    r = file(api, w, agent, run_of(api, owner, w, agent), kind="feature", title="Weekly client digest")
    assert one(api, w, w.editor, "select pulse.board_vote(%s,true) n", (r["id"],))["n"] == 2, "its own vote and the editor's"
    assert one(api, w, w.editor, "select pulse.board_vote(%s,true) n", (r["id"],))["n"] == 2, "one vote per person"
    assert one(api, w, w.editor, "select pulse.board_vote(%s,false) n", (r["id"],))["n"] == 1
    one(api, w, w.editor, "select pulse.board_comment(%s,'Useful for Pod 1 (test)') id", (r["id"],))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        one(api, w, w.editor, "select pulse.board_comment(%s,'') id", (r["id"],))
    rows = one(api, w, w.editor, "select pulse.board_list('all','open','top') b")["b"]
    assert [x["id"] for x in rows] == [str(r["id"])] and rows[0]["comments"] == 1
    # A person's bug report (BUG-REPORT, 1201) is theirs and leadership's, not the whole board's.
    bug = owner_sql(owner, w, """insert into pulse.reported_bug(org_id,number,person_id,command_id,words,route,fingerprint)
        values(%s,99,%s,'cmd-test-0001','The save button spins (test)','/tasks',repeat('a',64)) returning id""", (w.org, w.lead))[0]["id"]
    assert one(api, w, w.editor, "select pulse.board_item(%s) b", (bug,))["b"] is None
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, w, w.editor, "select pulse.board_vote(%s,true) n", (bug,))
    assert one(api, w, w.lead, "select pulse.board_item(%s) b", (bug,))["b"]["kind"] == "bug"
    # Only leadership puts things on the dev agents' queue.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, w.editor, "select pulse.board_queue(%s,true) q", (bug,))
    assert one(api, w, w.lead, "select pulse.board_queue(%s,true) q", (bug,))["q"] is True


def test_the_dev_queue_reads_every_organisation_with_a_token_comments_and_ships(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "queue-ai")
    mine = file(api, w, agent, run_of(api, owner, w, agent), kind="tool_needed", title="Create calendar invites")
    other = build_world(worker, owner, api)
    _staff(worker, other)
    agent2, _ = make_agent(api, other, "queue-ai-2")
    theirs = file(api, other, agent2, run_of(api, owner, other, agent2), kind="bug", title="Task list fails to load")
    tok = token(owner)
    q = lambda sql, args=(): one(api, w, w.editor, sql, args)  # noqa: E731  (any connection; the token decides)
    items = q("select pulse.dev_queue_list(%s,'open',50) l", (tok,))["l"]
    ids = {x["id"] for x in items}
    assert {str(mine["id"]), str(theirs["id"])} <= ids, "every organisation's queued items"
    assert all("errors" not in x for x in items), "the list carries no error details"
    item = q("select pulse.dev_queue_item(%s,%s) i", (tok, theirs["id"]))["i"]
    assert item["title"] == "Task list fails to load" and item["errors"] == []
    q("select pulse.dev_queue_comment(%s,%s,'Reproduced on dev (test)') id", (tok, theirs["id"]))
    s = q("select pulse.dev_queue_status(%s,%s,'fixed','Shipped in the next release (test)','abc1234') s", (tok, theirs["id"]))["s"]
    assert s["status"] == "fixed"
    seen = one(api, other, other.manager, "select pulse.board_item(%s) b", (theirs["id"],))["b"]
    assert seen["status"] == "fixed" and seen["shippedRef"] == "abc1234"
    assert any(d["who"].startswith("Pulse dev agent") and d["note"] == "Reproduced on dev (test)" for d in seen["discussion"])
    # Nothing of one organisation shows in the other's board.
    assert str(mine["id"]) not in {x["id"] for x in one(api, other, other.manager, "select pulse.board_list('all','all','new') b")["b"]}
    # Without a valid token, nothing; a revoked token stops at once; people cannot issue tokens.
    for bad in (None, "pdq_00000000_" + "0" * 64, tok[:-1] + ("0" if tok[-1] != "0" else "1")):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            q("select pulse.dev_queue_list(%s,'open',50) l", (bad,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        q("select pulse.dev_queue_token_issue('mine') t")
    with owner.transaction():
        owner.execute("select pulse.dev_queue_token_revoke(%s)", (tok[4:12],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="revoked"):
        q("select pulse.dev_queue_list(%s,'open',50) l", (tok,))
    # An item that is not on the queue is not the dev agents' to read.
    off = owner_sql(owner, w, """insert into pulse.reported_bug(org_id,number,person_id,command_id,words,route,fingerprint)
        values(%s,77,%s,'cmd-test-0002','Private (test)','/hr',repeat('b',64)) returning id""", (w.org, w.editor))[0]["id"]
    tok2 = token(owner, "dev-agent-test-2")
    with pytest.raises(psycopg.errors.NoDataFound):
        q("select pulse.dev_queue_item(%s,%s) i", (tok2, off))
