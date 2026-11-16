"""AGENT-MEMORY (2090, owner P4.1, T4.1.2–4): one role AI employee (a project coordinator) with memory per person.
Twenty scripted conversations from three colleagues (and a leader and a client) go through the real chat functions; the
nightly learning pass reads them; then it is proven that:
- it remembers per person (each colleague's own preferences, habits, work and details, kept privately);
- it shares company facts (once two colleagues said one, or a leader said it in a staff group), also with a new colleague;
- one person's private memory never reaches another person: not on the Knowledge tab, not by reading the table as them,
  not in another person's run, not in a group, not where a client reads;
- client conversations never feed company memory, and secrets, plans and questions are never kept;
- people see, correct and forget what it remembers about them (and in chat: "what do you remember about me",
  "forget everything about me"); learned notes fade when unused.
Synthetic people, places and values only."""
import json
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from test_agent_coworkers import agent_one, ask, claim, dispatch, make_agent, owner_sql
from test_agent_memory import done, open_ai
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

# The twenty conversations: (who, where, what they said). A = editor, B = pod head (editor2), C = a colleague in another
# pod (outsider), L = the leader who owns the AI employee (an admin), K = a client in the client's group.
SCRIPT = [
    ("A", "dm", "Hi! I prefer site visit reports on WhatsApp, not email."),
    ("A", "dm", "I usually review leads before 11 am. I'm handling the Riverside Towers launch (test)."),
    ("A", "dm", "Our office is closed on Sundays."),
    ("A", "dm", "My working hours are 10 am to 7 pm"),
    ("A", "dm", "I prefer site visit reports on WhatsApp, not email."),
    ("A", "dm", "Can you check the brief for tomorrow?"),
    ("A", "dm", "My bank account number is EXMP0001234"),
    ("B", "dm", "I prefer quotations as PDF. Call me Bee"),
    ("B", "dm", "I'm working on the Lakeview Homes campaign (test)"),
    ("B", "dm", "Our office is closed on Sundays"),
    ("B", "dm", "We will move to a new office next month"),
    ("B", "dm", "I prefer site visit reports by email"),
    ("C", "dm", "I like short voice notes for updates"),
    ("C", "dm", "We send invoices on the 1st of every month"),
    ("C", "dm", "I usually work from the Pune office on Fridays"),
    ("L", "team", "We share the weekly report every Monday at 10 am"),
    ("A", "team", "I prefer reports with a one-line summary on top"),
    ("K", "client", "I prefer calls after 6 pm"),
    ("A", "client", "We send invoices on the 1st of every month"),
    ("A", "dm", "I prefer site visit reports by email now"),
]
PRIVATE = {
    "A": ["Prefers site visit reports by email now", "Usually review leads before 11 am", "Handles the Riverside Towers launch (test)",
          "Working hours: 10 am to 7 pm", "Prefers reports with a one-line summary on top"],
    "B": ["Prefers quotations as PDF", "Likes to be called Bee", "Works on the Lakeview Homes campaign (test)", "Prefers site visit reports by email"],
    "C": ["Likes short voice notes for updates", "Usually work from the Pune office on Fridays"],
}
SHARED = ["Our office is closed on Sundays.", "We share the weekly report every Monday at 10 am."]
# Said in the team room (A, B and the leader are in it; C is not): its members see it as that conversation's memory.
IN_TEAM_ROOM = {"Prefers reports with a one-line summary on top"}


def drain(api, w, agent):
    """Close every waiting event as its runtime would (dispatch, then done): the next message starts a clean run."""
    while True:
        claimed = claim(api, w, agent)
        if not claimed:
            return
        for c in claimed:
            d = dispatch(api, w, agent, c)
            if d["status"] == "dispatched":
                done(api, w, agent, d["runId"])


def run_on(api, w, agent, who, channel, text):
    """A new message, then its run (claimed and dispatched): the run id."""
    drain(api, w, agent)
    ask(api, w, who, channel, text)
    [c] = claim(api, w, agent)
    d = dispatch(api, w, agent, c)
    assert d["status"] == "dispatched", d
    return d["runId"]


def given(api, w, agent, run):
    return agent_one(api, w, agent, "select pulse.agent_memory_for(%s) m", (run,))["m"]


@pytest.fixture
def coordinator(api, worker, owner, team):  # noqa: F811
    """The project coordinator with the Memory tool, its direct chats with A, B and C, a staff group and a client's group,
    and the twenty conversations said in them."""
    w = team
    agent, _ = make_agent(api, w, "coordinator-test", title="Project Coordinator (test)")
    open_ai(owner, w, agent, tools=("chats", "tasks", "memory"))
    people = {"A": w.editor, "B": w.editor2, "C": w.outsider, "L": w.manager}
    rooms = {k: one(api, w, people[k], "select pulse.chat_direct(%s) id", (agent,))["id"] for k in "ABC"}
    team_room = one(api, w, w.manager, "select pulse.chat_group_create('Team room (test)',%s) id", ([w.editor, w.editor2],))["id"]
    client_room = one(api, w, w.manager, "select pulse.chat_group_create('Client room (test)',%s) id", ([w.editor],))["id"]
    for g in (team_room, client_room):
        as_(api, w, w.manager, "select pulse.agent_group_member(%s,%s,true)", (g, agent))
    client = uuid.uuid4()
    owner_sql(owner, w, "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Ashby Rook (test client)','client')", (client, w.org))
    owner_sql(owner, w, "insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, client_room, client))
    for who, where, text in SCRIPT:
        if who == "K":
            owner_sql(owner, w, "insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,%s,%s)",
                      (w.org, client_room, client, text, uuid.uuid4()))
            continue
        channel = rooms.get(who) if where == "dm" else team_room if where == "team" else client_room
        ask(api, w, people[who], channel, text)
    drain(api, w, agent)
    w.agent, w.people, w.rooms, w.team_room, w.client_room, w.client = agent, people, rooms, team_room, client_room, client
    return w


def mine(api, w, person):
    return one(api, w, person, "select pulse.agent_memory_mine(%s) m", (w.agent,))["m"]["items"]


def test_twenty_conversations_per_person_memory_shared_company_facts_and_no_leaks(api, worker, owner, coordinator):
    w = coordinator
    A, B, C, L = (w.people[k] for k in "ABCL")
    # The nightly pass, run now by its owner ("Learn now"): counts only.
    r = one(api, w, L, "select pulse.agent_memory_learn(%s,'on_demand') r", (w.agent,))["r"]
    assert r["messages"] == 20 and r["conversations"] == 5 and r["people"] == 5, r
    assert r["replaced"] == 1 and r["shared"] == 2, r
    # Per person: each colleague's own notes, private.
    rows = owner_sql(owner, w, "select about_person_id, body, private, level, seen, retired_why from pulse.agent_memory where agent_id=%s and source='learned'", (w.agent,))
    for k, bodies in PRIVATE.items():
        live = sorted(x["body"] for x in rows if x["about_person_id"] == w.people[k] and x["private"] and not x["retired_why"])
        assert live == sorted(bodies), (k, live)
    assert any(x["body"].startswith("Prefers site visit reports on WhatsApp") and x["seen"] == 2 and x["retired_why"] == "replaced" for x in rows), \
        "said twice, then replaced by the newer preference (kept, retired)"
    assert not any("EXMP0001234" in x["body"] or "bank" in x["body"].lower() for x in rows), "secrets are never kept"
    assert not any("brief" in x["body"].lower() or "new office" in x["body"].lower() for x in rows), "questions and plans are not memory"
    # Company: shared once two colleagues said it (A and B in their own chats), or the leader in a staff group; a fact
    # only C said in a direct chat waits for a second colleague; what A said where the client reads never counts.
    company = owner_sql(owner, w, "select body, state, cardinality(people) n, from_group from pulse.org_memory where retired_at is null order by body")
    assert sorted(x["body"] for x in company if x["state"] == "shared") == sorted(SHARED)
    [invoices] = [x for x in company if x["body"].startswith("We send invoices")]
    assert invoices["state"] == "candidate" and invoices["n"] == 1 and not invoices["from_group"]
    # One conversation's memory: the team room keeps the leader's fact and A's preference; the client room the client's.
    conv = owner_sql(owner, w, "select channel_id, body from pulse.agent_memory where agent_id=%s and level='conversation' and retired_at is null", (w.agent,))
    assert sorted(x["body"] for x in conv if x["channel_id"] == w.team_room) == ["Prefers reports with a one-line summary on top",
                                                                                 "We share the weekly report every Monday at 10 am."]
    assert [x["body"] for x in conv if x["channel_id"] == w.client_room] == ["Prefers calls after 6 pm"]

    # No leaks, as each person sees it: the Knowledge tab and the table itself (row security), for A, B and C.
    for k in "ABC":
        person = w.people[k]
        others = [b for o, bodies in PRIVATE.items() if o != k for b in bodies if b not in PRIVATE[k] and not (k in "AB" and b in IN_TEAM_ROOM)]
        k_view = json.dumps(one(api, w, person, "select pulse.agent_knowledge(%s) k", (w.agent,))["k"])
        assert all(json.dumps(b) in k_view for b in PRIVATE[k]), k
        # Whole JSON strings: B's "… by email" is not A's "… by email now".
        assert not any(json.dumps(b) in k_view for b in others), (k, [b for b in others if json.dumps(b) in k_view])
        assert "We send invoices" not in k_view, "a candidate heard in direct chats is nobody's to read"
        table = [x["body"] for x in as_(api, w, person, "select body from pulse.agent_memory where private")]
        assert sorted(table) == sorted(b for x in rows if x["about_person_id"] == person and x["private"] for b in [x["body"]])
        assert sorted(x["body"] for x in mine(api, w, person) if x["private"]) == sorted(PRIVATE[k])
        if k == "C":
            assert not any(json.dumps(b) in k_view for b in IN_TEAM_ROOM), "not in the team room: none of its memory"
    lv = one(api, w, L, "select pulse.agent_knowledge(%s) k", (w.agent,))["k"]
    assert lv["canCompany"] and lv["waiting"] == 1 and not any(json.dumps(b) in json.dumps(lv) for bodies in PRIVATE.values() for b in bodies if b not in IN_TEAM_ROOM), \
        "even its owner, an admin, reads no one's private notes"
    assert lv["lastPass"]["messages"] == 20 and lv["learns"]
    # The older read (1840) gives no private notes.
    assert agent_one(api, w, w.agent, "select pulse.agent_notes_for(%s) n", (A,))["n"]["about"] == []

    # What each run is given, decided from the run's own message.
    run = run_on(api, w, w.agent, A, w.rooms["A"], "What should I send today?")
    g = given(api, w, w.agent, run)
    assert sorted(g["private"]) == sorted(PRIVATE["A"]) and sorted(g["company"]) == sorted(SHARED) and g["conversation"] == [] and g["direct"]
    done(api, w, w.agent, run)
    run = run_on(api, w, w.agent, B, w.rooms["B"], "Anything for me?")
    g = given(api, w, w.agent, run)
    assert sorted(g["private"]) == sorted(PRIVATE["B"]) and not set(g["private"]) & set(PRIVATE["A"] + PRIVATE["C"])
    done(api, w, w.agent, run)
    run = run_on(api, w, w.agent, A, w.team_room, "@coordinator-test what is due this week?")
    g = given(api, w, w.agent, run)
    assert g["private"] == [] and not g["direct"], "in a group, nobody's private notes"
    assert sorted(x["body"] for x in g["conversation"]) == ["Prefers reports with a one-line summary on top", "We share the weekly report every Monday at 10 am."]
    assert sorted(g["company"]) == sorted(SHARED)
    done(api, w, w.agent, run)
    # A colleague asks it in the client's group: where a client reads, only that conversation's notes.
    run = run_on(api, w, w.agent, A, w.client_room, "@coordinator-test is the brochure ready?")
    g = given(api, w, w.agent, run)
    assert g["clientFacing"] and g["company"] == [] and g["private"] == [] and [x["body"] for x in g["conversation"]] == ["Prefers calls after 6 pm"], \
        "where a client reads: only that conversation's notes"
    done(api, w, w.agent, run)
    # Outside its own run it reads nothing.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        given(api, w, w.agent, run)

    # A new colleague benefits from what it learned from everyone else: the company facts, nobody's private notes.
    new = uuid.uuid4()
    owner_sql(owner, w, "insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'New Joiner (test)','staff')", (new, w.org))
    owner_sql(owner, w, "insert into pulse.people_profile(org_id,person_id,role,evidence,user_no,username) values(%s,%s,'Coordinator','test',31,'newjoiner31')", (w.org, new))
    ndm = one(api, w, new, "select pulse.chat_direct(%s) id", (w.agent,))["id"]
    run = run_on(api, w, w.agent, new, ndm, "Hi, I just joined. How do things work here?")
    g = given(api, w, w.agent, run)
    assert sorted(g["company"]) == sorted(SHARED) and g["private"] == []
    done(api, w, w.agent, run)

    # Learning again finds nothing new; a second colleague saying C's fact shares it.
    r = one(api, w, L, "select pulse.agent_memory_learn(%s,'on_demand') r", (w.agent,))["r"]
    assert r["added"] == 0 and r["shared"] == 0, r
    ask(api, w, A, w.rooms["A"], "We send invoices on the 1st of each month")
    drain(api, w, w.agent)
    r = one(api, w, L, "select pulse.agent_memory_learn(%s,'on_demand') r", (w.agent,))["r"]
    assert r["shared"] == 1, r
    # Only its manager or an admin runs it; never the AI employee itself.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, C, "select pulse.agent_memory_learn(%s,'on_demand')", (w.agent,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        agent_one(api, w, w.agent, "select pulse.agent_memory_learn(%s,'on_demand')", (w.agent,))


def test_people_see_correct_and_forget_and_learned_notes_fade(api, worker, owner, coordinator):
    w = coordinator
    A, B, C, L = (w.people[k] for k in "ABCL")
    one(api, w, L, "select pulse.agent_memory_learn(%s,'on_demand')", (w.agent,))
    # Correct: A fixes their hours; nobody else can change A's notes.
    [hours] = [x for x in mine(api, w, A) if x["body"].startswith("Working hours")]
    assert hours["canChange"] and hours["private"]
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, w, B, "select pulse.agent_memory_correct(%s,%s)", (hours["id"], "Working hours: never (test)"))
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, w, L, "select pulse.agent_memory_forget(%s)", (hours["id"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, L, "select pulse.agent_memory_retire(%s)", (hours["id"],))
    one(api, w, A, "select pulse.agent_memory_correct(%s,%s)", (hours["id"], "Working hours: 9:30 am to 6:30 pm"))
    run = run_on(api, w, w.agent, A, w.rooms["A"], "Plan my day please")
    assert "Working hours: 9:30 am to 6:30 pm" in given(api, w, w.agent, run)["private"]
    done(api, w, w.agent, run)
    # Forget one; a note the manager wrote about A stays (shown, but only the manager changes it).
    [habit] = [x for x in mine(api, w, A) if x["body"].startswith("Usually review leads")]
    one(api, w, A, "select pulse.agent_memory_forget(%s)", (habit["id"],))
    one(api, w, L, "select pulse.agent_note_save(%s,%s)", (w.agent, Jsonb({"body": "Owns the Riverside launch checklist (test)", "aboutPersonId": str(A)})))
    items = mine(api, w, A)
    assert not any(x["body"].startswith("Usually review leads") for x in items)
    [mgr] = [x for x in items if x["source"] == "manager"]
    assert not mgr["canChange"] and mgr["by"] and not mgr["private"]
    with pytest.raises(psycopg.errors.NoDataFound):
        one(api, w, A, "select pulse.agent_memory_forget(%s)", (mgr["id"],))

    # In chat: "what do you remember about me?" lists it in their own direct chat only; "forget everything about me".
    run = run_on(api, w, w.agent, B, w.rooms["B"], "What do you remember about me?")
    rec = agent_one(api, w, w.agent, "select pulse.agent_recall_asker(%s) r", (run,))["r"]
    assert rec["direct"] and sorted(x["body"] for x in rec["items"] if x["private"]) == sorted(PRIVATE["B"])
    done(api, w, w.agent, run)
    run = run_on(api, w, w.agent, A, w.team_room, "@coordinator-test what do you remember about me?")
    rec = agent_one(api, w, w.agent, "select pulse.agent_recall_asker(%s) r", (run,))["r"]
    assert not rec["direct"] and rec["items"] == [] and rec["count"] > 0, "in a group it lists nothing, it says where to look"
    done(api, w, w.agent, run)
    run = run_on(api, w, w.agent, B, w.rooms["B"], "Forget everything about me")
    f = agent_one(api, w, w.agent, "select pulse.agent_forget_asker(%s) r", (run,))["r"]
    done(api, w, w.agent, run)
    assert f["forgotten"] == len(PRIVATE["B"]) and f["kept"] == 0
    assert mine(api, w, B) == []
    shared = owner_sql(owner, w, "select body from pulse.org_memory where state='shared' and retired_at is null")
    assert "Our office is closed on Sundays." in [x["body"] for x in shared], "a shared company fact stays"
    # C forgets everything from the Knowledge tab: the fact only C said goes too.
    assert one(api, w, C, "select pulse.agent_memory_forget_me(%s) r", (w.agent,))["r"]["forgotten"] == len(PRIVATE["C"]) + 1
    assert not owner_sql(owner, w, "select 1 from pulse.org_memory where body like 'We send invoices%%' and retired_at is null")
    # Forgotten stays forgotten: the next pass does not learn the same messages again.
    one(api, w, L, "select pulse.agent_memory_learn(%s,'on_demand')", (w.agent,))
    assert mine(api, w, B) == [] and not [x for x in mine(api, w, C) if x["private"]]

    # Fading: a learned note heard once and unused for 50 days goes; one heard twice lasts 90 days.
    owner_sql(owner, w, "update pulse.agent_memory set created_at=now()-interval '50 days', last_seen_at=now()-interval '50 days', used_at=null, edited_at=null "
                        "where agent_id=%s and source='learned' and retired_at is null and body like 'Handles the Riverside%%'", (w.agent,))
    owner_sql(owner, w, "update pulse.agent_memory set created_at=now()-interval '50 days', last_seen_at=now()-interval '50 days', used_at=null, seen=2 "
                        "where agent_id=%s and source='learned' and retired_at is null and body like 'Prefers reports with%%' and level='person'", (w.agent,))
    r = one(api, w, L, "select pulse.agent_memory_learn(%s,'on_demand') r", (w.agent,))["r"]
    assert r["faded"] == 1, r
    live = [x["body"] for x in mine(api, w, A)]
    assert "Handles the Riverside Towers launch (test)" not in live and "Prefers reports with a one-line summary on top" in live

    # Company memory: leaders add, share and remove; a colleague cannot.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        one(api, w, A, "select pulse.org_memory_save(%s)", (Jsonb({"body": "We open at 9 (test)"}),))
    fid = one(api, w, L, "select pulse.org_memory_save(%s) id", (Jsonb({"body": "Site visits are booked through the front desk (test)"}),))["id"]
    k = one(api, w, A, "select pulse.agent_knowledge(%s) k", (w.agent,))["k"]
    assert any(x["id"] == str(fid) and x["state"] == "shared" and x["source"] == "leader" for x in k["company"])
    one(api, w, L, "select pulse.org_memory_save(%s)", (Jsonb({"id": str(fid), "action": "remove"}),))
    assert not any(x["id"] == str(fid) for x in one(api, w, A, "select pulse.agent_knowledge(%s) k", (w.agent,))["k"]["company"])


def test_nightly_learns_once_a_day_for_ai_employees_with_memory(api, worker, owner, coordinator):
    w = coordinator
    other, _ = make_agent(api, w, "no-memory-test")
    open_ai(owner, w, other, tools=("chats",))
    with worker.transaction():
        worker.execute("select set_config('pulse.org_id',%s,true), set_config('pulse.viewer_id','',true)", (str(w.org),))
        hour = worker.execute("select extract(hour from now() at time zone pulse.org_time_zone())::int h").fetchone()["h"]
    first = api_nightly(api, w)
    second = api_nightly(api, w)
    assert second == 0, "once a day"
    if hour >= 3:
        assert first == 1, "only the AI employee with the Memory tool"
        assert owner_sql(owner, w, "select count(*) n from pulse.agent_memory_pass where reason='nightly'")[0]["n"] == 1
    else:
        assert first == 0, "not before 3 a.m. company time"
    # With a viewer (a person's request), the nightly entry does nothing.
    assert one(api, w, w.manager, "select pulse.agent_memory_nightly() n", ())["n"] == 0


def api_nightly(api, w):
    """The API's nightly loop: the company's context, no viewer."""
    with api.transaction():
        api.execute("select set_config('pulse.org_id',%s,true), set_config('pulse.viewer_id','',true)", (str(w.org),))
        return api.execute("select pulse.agent_memory_nightly() n").fetchone()["n"]
