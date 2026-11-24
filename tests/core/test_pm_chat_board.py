"""PM-BUILD-4 (KAZUK-PM-2 phase 3, migration 2520): the chat moves the board. A message a person writes in a project's
group is read for its step and what happened ("M1 first draft done", "access granted, done"), and only its writer gets
one private card; their tap moves the step through the guarded path (only a person, gates refuse), Undo puts it back.
Never a clock (gates and milestones are never a card's step), never an AI, never an imported or a question message.
Back-fill: marking a step done while one's own earlier steps are open asks "Were these finished too?". Synthetic
tenants only; nothing is sent to anyone."""
import copy
import uuid
from datetime import timedelta

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_plan_clocks import TPL, ai, move, org_today, steps
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

# The test company's template plus one step that waits on M1, so a back-fill has something to ask about.
TPL2 = copy.deepcopy(TPL)
TPL2["steps"].append({"id": "M2", "stage": 1, "title": "Polish the moodboard", "owner": "Maker", "type": "task", "from": "start", "start": 1, "end": 4,
                      "after": ["M1"], "packages": {"full": "yes"}})
TPL2["steps"] += [{"id": "P1", "stage": 1, "title": "Draft the shot list", "owner": "Maker", "type": "task", "from": "start", "start": 1, "end": 3, "packages": {"full": "yes"}},
                  {"id": "P2", "stage": 1, "title": "Book the shoot crew", "owner": "Maker", "type": "task", "from": "start", "start": 2, "end": 4, "after": ["P1"], "packages": {"full": "yes"}}]


def plan(api, owner, w):
    today = org_today(api, w)
    one(api, w, w.manager, "select pulse.delivery_template_adopt('chat-test','Chat plan',%s,%s) r", (Jsonb(TPL2), w.project))
    one(api, w, w.lead, "select pulse.project_plan_set(%s,'chat-test','full','big',%s,%s) r", (w.project, today - timedelta(days=1), w.lead))
    s = steps(api, w)
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("update pulse.task set assignee_person_id=%s,owner_id=%s where id = any(%s)", (w.editor, w.editor, [s[k]["id"] for k in ("M1", "M2", "I2")]))
    group = one(api, w, w.lead, "select pulse.chat_group_create('Pilot room',%s) id", ([w.editor],))["id"]
    one(api, w, w.lead, "select pulse.project_chat_link(%s,%s,true) r", (w.project, group))
    return steps(api, w), group


def say(api, w, who, channel, text):
    return one(api, w, who, "select pulse.chat_send(%s,%s,null,'[]',%s,null) id", (channel, text, uuid.uuid4()))["id"]


def cards(api, w, who, channel=None):
    return one(api, w, who, "select pulse.pm_step_cards(%s,null) c", (channel,))["c"]


def answer(api, w, who, card, ans, task=None):
    return one(api, w, who, "select pulse.pm_step_card_answer(%s,%s,%s) r", (card, ans, task))["r"]


def test_a_chat_message_gives_its_writer_one_card_and_their_tap_moves_the_step(api, owner, worker, team):
    w = team
    s, group = plan(api, owner, w)
    msg = say(api, w, w.editor, group, "M1 first draft done, sharing in a bit")
    mine = cards(api, w, w.editor, group)
    assert len(mine) == 1, mine
    c = mine[0]
    assert c["what"] == "round" and c["round"] == "First draft" and c["messageId"] == str(msg)
    assert [x["code"] for x in c["candidates"]] == ["M1"]
    # Nothing moved by itself, and nobody else sees the card (not the lead, not leadership).
    assert steps(api, w)["M1"]["status"] == s["M1"]["status"]
    assert cards(api, w, w.lead) == [] and cards(api, w, w.manager) == []
    assert one(api, w, w.lead, "select count(*)::int n from pulse.step_card")["n"] == 0
    # Only its writer answers it, and only a person (an AI employee's request or a connected AI app is refused).
    with pytest.raises(psycopg.errors.NoDataFound):
        answer(api, w, w.lead, c["id"], "yes")
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only a person"):
        ai(api, w, w.editor, "select pulse.pm_step_card_answer(%s,'yes',null)", (c["id"],))
    r = answer(api, w, w.editor, c["id"], "yes")
    assert r["state"] == "yes" and r["tasks"][0]["to"] == "in_progress"
    assert steps(api, w)["M1"]["status"] == "in_progress"
    assert one(api, w, w.editor, "select round from pulse.pm_step_rounds(%s) where task_id=%s", (w.project, s["M1"]["id"]))["round"] == "First draft"
    ev = one(api, w, w.editor, "select note from pulse.task_event where task_id=%s and kind='step' order by at desc limit 1", (s["M1"]["id"],))
    assert "From the chat" in ev["note"] and "M1 first draft done" in ev["note"]
    # Answered once only; Undo puts the step back for a day.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        answer(api, w, w.editor, c["id"], "no")
    assert answer(api, w, w.editor, c["id"], "undo")["state"] == "undone"
    assert steps(api, w)["M1"]["status"] == s["M1"]["status"]


def test_words_find_the_writers_own_step_and_done_goes_through_the_guard(api, owner, worker, team):
    w = team
    s, group = plan(api, owner, w)
    say(api, w, w.editor, group, "Access granted for the ad account, done")
    c = cards(api, w, w.editor, group)[0]
    assert c["what"] == "done" and [x["code"] for x in c["candidates"]] == ["I2"]
    answer(api, w, w.editor, c["id"], "yes")
    assert steps(api, w)["I2"]["status"] == "done"
    who = one(api, w, w.editor, "select actor_id,note from pulse.task_event where task_id=%s and kind='status' order by at desc limit 1", (s["I2"]["id"],))
    assert who["actor_id"] == w.editor and "From the chat" in who["note"]


def test_never_a_clock_a_guess_a_question_an_ai_or_an_imported_message(api, owner, worker, team):
    w = team
    s, group = plan(api, owner, w)
    # A gate or milestone (Day 0, going live) is never a card's step, even from the person who runs the project.
    say(api, w, w.lead, group, "G1 done, every input is in")
    say(api, w, w.lead, group, "G2 is live now, done")
    assert cards(api, w, w.lead) == []
    # A question or a not-yet says nothing.
    for text in ("is M1 done?", "M1 not done yet", "M1 will be done tomorrow", "M1 looks good"):
        say(api, w, w.editor, group, text)
    assert cards(api, w, w.editor) == []
    # A message sent through an AI session (an AI employee or a person's connected AI app) is never read, if it is sent at all.
    try:
        ai(api, w, w.editor, "select pulse.chat_send(%s,'M1 first draft done',null,'[]',%s,null)", (group, uuid.uuid4()))
    except psycopg.Error:
        pass
    assert cards(api, w, w.editor) == []
    # An imported (WhatsApp history) message is never read.
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id,import_ref) values(%s,%s,%s,'M1 final, delivered',%s,%s)",
                      (w.org, group, w.editor, uuid.uuid4(), uuid.uuid4()))
    assert cards(api, w, w.editor) == []
    # A group not linked to the project is not read.
    other = one(api, w, w.lead, "select pulse.chat_group_create('Coffee room',%s) id", ([w.editor],))["id"]
    say(api, w, w.editor, other, "M1 first draft done")
    assert cards(api, w, w.editor) == []
    # The messages themselves were all written.
    assert one(api, w, w.editor, "select count(*)::int n from pulse.chat_message where channel_id=%s and import_ref is null", (group,))["n"] >= 6


def test_several_matching_steps_ask_which_one(api, owner, worker, team):
    w = team
    s, group = plan(api, owner, w)
    say(api, w, w.editor, group, "M1 and M2 started today")
    c = cards(api, w, w.editor, group)[0]
    assert c["what"] == "started" and {x["code"] for x in c["candidates"]} == {"M1", "M2"}
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="Choose which step"):
        answer(api, w, w.editor, c["id"], "yes")
    answer(api, w, w.editor, c["id"], "yes", s["M2"]["id"])
    after = steps(api, w)
    assert after["M2"]["status"] == "in_progress" and after["M1"]["status"] == s["M1"]["status"]


def test_back_fill_asks_once_about_ones_own_earlier_open_steps(api, owner, worker, team):
    w = team
    s, group = plan(api, owner, w)
    move(api, w, w.editor, s["M2"]["id"], "done")
    c = [x for x in cards(api, w, w.editor) if x["kind"] == "backfill"]
    assert len(c) == 1 and [x["code"] for x in c[0]["candidates"]] == ["M1"], c
    # Marking it done again (reopen, done) asks nothing new.
    move(api, w, w.editor, s["M2"]["id"], "open")
    move(api, w, w.editor, s["M2"]["id"], "done")
    assert len([x for x in cards(api, w, w.editor) if x["kind"] == "backfill"]) == 1
    answer(api, w, w.editor, c[0]["id"], "yes")
    assert steps(api, w)["M1"]["status"] == "done"
    # Someone else closing a step asks the doer nothing.
    assert cards(api, w, w.lead) == []


def test_a_client_wait_starts_when_the_lead_asks_and_ends_when_the_step_is_done(api, owner, worker, team):
    w = team
    s, group = plan(api, owner, w)
    i1 = s["I1"]["id"]  # "Brief received": the client's input
    said = lambda: one(api, w, w.lead, "select count(*)::int n from pulse.chat_message where channel_id=%s", (group,))["n"]
    before = said()
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.project_client_ask(%s,%s,null)", (w.project, [i1]))
    with pytest.raises(psycopg.errors.InsufficientPrivilege, match="Only a person"):
        ai(api, w, w.lead, "select pulse.project_client_ask(%s,%s,null)", (w.project, [i1]))
    # Only client steps open a wait (I2 is the team's); asking twice opens one.
    assert one(api, w, w.lead, "select pulse.project_client_ask(%s,%s,'Brief and floor plans') r", (w.project, [i1, s["I2"]["id"]]))["r"]["asked"] == 1
    assert one(api, w, w.lead, "select pulse.project_client_ask(%s,%s,null) r", (w.project, [i1]))["r"]["asked"] == 0
    wait = one(api, w, w.lead, "select party,until,note,opened_by from pulse.task_wait where task_id=%s", (i1,))
    assert wait["party"] == "client" and wait["until"] is None and wait["opened_by"] == w.lead and wait["note"] == "Brief and floor plans"
    # Nothing was sent to anyone: the group has no new message.
    assert said() == before
    move(api, w, w.lead, i1, "done")
    assert one(api, w, w.lead, "select until is not null closed from pulse.task_wait where task_id=%s", (i1,))["closed"] is True


def test_one_card_per_step_at_a_time(api, owner, worker, team):
    w = team
    s, group = plan(api, owner, w)
    say(api, w, w.editor, group, "M1 first draft done")
    assert [c["kind"] for c in cards(api, w, w.editor)] == ["chat"]
    # Finishing M2 (which waits on M1) asks nothing more about M1: its chat card is still open.
    move(api, w, w.editor, s["M2"]["id"], "done")
    assert [c["kind"] for c in cards(api, w, w.editor)] == ["chat"]
