"""AI-FIX-5 (2483, BC-173): an AI employee that asked one colleague two things in the same direct message (one for the
admin, one for HR) ties each answer to its own question: a reply to one question (quoted, or in its thread) answers that
one, an unquoted message answers the newest waiting one, and the run about an answer reads that question: its asker,
its conversation, and the footer of a follow-up ("For <that asker> …"). Synthetic only."""
import uuid

from test_agent_coworkers import agent_one, make_agent, owner_sql
from test_ai_tools_digest import finish, run_of
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def _username(owner, w, person):
    return owner_sql(owner, w, "select username from pulse.people_profile where person_id=%s", (person,))[0]["username"]


def _name(owner, w, person):
    return owner_sql(owner, w, "select display_name from pulse.person where id=%s", (person,))[0]["display_name"]


def _ask_for(api, owner, w, agent, asker, colleague, text):
    """A run about `asker`'s direct message that asks `colleague` one question, then ends."""
    d, _ = run_of(api, owner, w, agent, asker)
    q = agent_one(api, w, agent, "select pulse.agent_consult_ask(%s,%s,%s,%s) r", (d["runId"], colleague, text, uuid.uuid4()))["r"]
    finish(api, w, agent, d["runId"])
    return q


def _answer(api, w, agent, who, chat, text, quote=None, parent=None):
    """The colleague writes in the direct message; the AI employee's run about it (a consult.answer) starts."""
    mid = one(api, w, who, "select pulse.chat_send(%s,%s,%s,'[]',%s,%s) id", (chat, text, parent, uuid.uuid4(), quote))["id"]
    [c] = agent_one(api, w, agent, "select pulse.agent_events_claim(5) e")["e"]
    assert c["event"]["eventType"] == "consult.answer"
    d = agent_one(api, w, agent, "select pulse.agent_consult_dispatch(%s,%s,'quick','test') d", (c["event"]["id"], c["leaseToken"]))["d"]
    assert d["status"] == "dispatched", d
    return str(mid), d


def _consults(owner, w, *ids):
    rows = owner_sql(owner, w, "select id::text, state, answer_message_id::text a from pulse.agent_consult where id = any(%s::uuid[])", ([str(i) for i in ids],))
    return {r["id"]: (r["state"], r["a"]) for r in rows}


def test_each_answer_reads_its_own_question_and_a_follow_up_names_its_asker(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "per-question-test")
    ed, ed2 = _username(owner, w, w.editor), _username(owner, w, w.editor2)
    admin, hr = _name(owner, w, w.manager), _name(owner, w, w.lead)
    q1 = _ask_for(api, owner, w, agent, w.manager, ed, "When is reel 1 due? (test)")
    q2 = _ask_for(api, owner, w, agent, w.lead, ed, "When is reel 2 due? (test)")
    assert q1["chatId"] == q2["chatId"], "both questions are in the same direct message"
    # The colleague answers the newest first (no quote): that question takes it, as before.
    a1, d = _answer(api, w, agent, w.editor, q1["chatId"], "Reel 2: Monday (test)")
    assert d["context"]["consult"]["id"] == q2["id"] and d["context"]["consult"]["asker"] == hr
    finish(api, w, agent, d["runId"])
    # Then the other one: its run reads the admin's question, not HR's (the newest).
    a2, d = _answer(api, w, agent, w.editor, q1["chatId"], "Reel 1: Friday (test)")
    con = d["context"]["consult"]
    assert (con["id"], con["asker"]) == (q1["id"], admin), "the run reads the question this message answered"
    assert _consults(owner, w, q1["id"], q2["id"]) == {q1["id"]: ("answered", a2), q2["id"]: ("answered", a1)}
    # A follow-up asked in that run is for the admin, in the admin's conversation.
    f = agent_one(api, w, agent, "select pulse.agent_consult_ask(%s,%s,'Can you confirm reel 1 for Friday? (test)',%s) r", (d["runId"], ed2, uuid.uuid4()))["r"]
    body = owner_sql(owner, w, "select body from pulse.chat_message where id=%s", (f["messageId"],))[0]["body"]
    assert f"(For {admin} in a direct message" in body, body
    row = owner_sql(owner, w, "select asker_id, source_channel_id from pulse.agent_consult where id=%s", (f["id"],))[0]
    first = owner_sql(owner, w, "select asker_id, source_channel_id from pulse.agent_consult where id=%s", (q1["id"],))[0]
    assert row == first


def test_a_reply_to_one_question_answers_that_question(api, worker, owner, team):  # noqa: F811
    w = team
    agent, _ = make_agent(api, w, "reply-question-test")
    ed = _username(owner, w, w.editor)
    admin, hr = _name(owner, w, w.manager), _name(owner, w, w.lead)
    q1 = _ask_for(api, owner, w, agent, w.manager, ed, "Is the brochure final? (test)")
    q2 = _ask_for(api, owner, w, agent, w.lead, ed, "Is the 3D walkthrough final? (test)")
    # A quoted reply to the older question answers it; the newer one keeps waiting.
    a1, d = _answer(api, w, agent, w.editor, q1["chatId"], "Yes, final (test)", quote=q1["messageId"])
    assert (d["context"]["consult"]["id"], d["context"]["consult"]["asker"]) == (q1["id"], admin)
    assert _consults(owner, w, q1["id"], q2["id"]) == {q1["id"]: ("answered", a1), q2["id"]: ("open", None)}
    finish(api, w, agent, d["runId"])
    # A correction in that question's thread is still that question's, never the waiting one's.
    a2, d = _answer(api, w, agent, w.editor, q1["chatId"], "Sorry, one more change (test)", parent=q1["messageId"])
    assert d["context"]["consult"]["id"] == q1["id"]
    assert _consults(owner, w, q1["id"], q2["id"]) == {q1["id"]: ("answered", a2), q2["id"]: ("open", None)}
    finish(api, w, agent, d["runId"])
    # A plain message then answers the one still waiting.
    a3, d = _answer(api, w, agent, w.editor, q1["chatId"], "The walkthrough is final too (test)")
    assert (d["context"]["consult"]["id"], d["context"]["consult"]["asker"]) == (q2["id"], hr)
    assert _consults(owner, w, q2["id"])[q2["id"]] == ("answered", a3)
