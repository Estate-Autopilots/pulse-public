"""WL-QUOTE-LIVE (2005, 10 Nov 2026): a salesperson's voice note reaches the AI employee as its transcript, and a
quotation asked for in any listened conversation is drafted and submitted for the listener's approval. Synthetic only."""
import json
import uuid

from pulse_sdk.db import set_tenant
from test_agent_channels import settings, worker_one
from test_agent_coworkers import claim, dispatch, make_agent, owner_sql
from test_tasks_rt1 import one, team  # noqa: F401  (team is a fixture)


def voice(api, w, who, channel, caption=""):
    fid = one(api, w, who, "select pulse.chat_file_add(%s,'Voice message.webm','audio/webm',%s) id", (channel, b"\x1aE\xdf\xa3synthetic"))["id"]
    note = {"id": str(fid), "name": "Voice message.webm", "mime": "audio/webm", "voice": {"seconds": 6, "peaks": [10, 40, 90, 30]}}
    return one(api, w, who, "select pulse.chat_send(%s,%s,null,%s,%s,null) id", (channel, caption, json.dumps([note]), uuid.uuid4()))["id"]


def transcribe(worker, w, message, state, body):
    """What tools/voice-transcribe.py does: claim the queued note, then write what Whisper heard."""
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("update pulse_priv.chat_voice_transcript set state='working',attempts=attempts+1 where message_id=%s and state='queued' returning 1",
                              (message,)).fetchall(), "the note was queued for its transcript"
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse_priv.chat_voice_transcript set state=%s,body=%s,model='large-v3-turbo',done_at=now() where message_id=%s", (state, body, message))


def billing_agent(api, owner, w, username):
    """An AI employee with Billing (the quotation agent's tools), its key issued as the runtime holds it."""
    agent, _ = make_agent(api, w, username)
    owner_sql(owner, w, "update pulse.agent_member set tools=%s where org_id=%s and person_id=%s", (["chats", "billing"], w.org, agent))
    return agent


def events(owner, w, message):
    return owner_sql(owner, w, "select agent_id, event_type, state from pulse.agent_event where subject_id=%s", (message,))


def test_a_voice_note_reaches_the_ai_employee_as_its_transcript(api, worker, owner, team):  # noqa: F811
    w = team
    agent = billing_agent(api, owner, w, "bharata-voice-synthetic")
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    # Before: a voice note had no words, so the AI employee never heard it. Now it waits for its transcript.
    note = voice(api, w, w.manager, dm)
    assert events(owner, w, note) == []
    transcribe(worker, w, note, "done", "Soniba Traders ke liye quotation banao: do 5 kW solar system, transport alag se.")
    [ev] = events(owner, w, note)
    assert ev["agent_id"] == agent and ev["event_type"] == "chat.message" and ev["state"] == "queued"
    [c] = claim(api, w, agent)
    assert c["event"]["subjectId"] == str(note)
    d = dispatch(api, w, agent, c)
    msg = d["context"]["message"]
    assert d["status"] == "dispatched" and msg["voice"] is True
    assert msg["body"] == "🎙 Voice note, transcribed on our server: Soniba Traders ke liye quotation banao: do 5 kW solar system, transport alag se."
    assert d["context"]["recent"][-1]["body"] == msg["body"], "its history reads the transcript too"
    # The same transcript written again (a retry, a Transcript tap) wakes nobody twice.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse_priv.chat_voice_transcript set state='done' where message_id=%s", (note,))
    assert len(events(owner, w, note)) == 1


def test_a_note_with_words_waits_for_its_transcript_and_a_failed_one_still_wakes_it(api, worker, owner, team):  # noqa: F811
    w = team
    agent = billing_agent(api, owner, w, "bharata-voice-two")
    dm = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (agent,))["id"]
    note = voice(api, w, w.manager, dm, "for Putig Farms")
    assert events(owner, w, note) == []
    transcribe(worker, w, note, "failed", None)
    [c] = claim(api, w, agent)
    body = dispatch(api, w, agent, c)["context"]["message"]["body"]
    assert body.startswith("for Putig Farms\n\n🎙 Voice note (it could not be transcribed")
    # A typed message is routed as before (the same routing, now one function).
    typed = one(api, w, w.manager, "select pulse.chat_send(%s,'Same as last time for Putig Farms',null,'[]',%s,null) id", (dm, uuid.uuid4()))["id"]
    assert [e["event_type"] for e in events(owner, w, typed)] == ["chat.message"]


def test_a_voice_note_between_people_is_not_queued_for_an_ai_employee(api, worker, owner, team):  # noqa: F811
    w = team
    people = one(api, w, w.manager, "select pulse.chat_direct(%s) id", (w.editor,))["id"]
    note = voice(api, w, w.manager, people)
    assert owner_sql(owner, w, "select count(*) n from pulse_priv.chat_voice_transcript where message_id=%s", (note,))[0]["n"] == 0
    assert events(owner, w, note) == []


def test_the_quote_rule_hears_hindi_marathi_and_english(api, worker, owner, team):  # noqa: F811
    w = team
    heard = lambda t: owner_sql(owner, w, "select pulse.listen_quote_intent(%s) q", (t,))[0]["q"]
    for t in ["Please send a quote for Mifos Solar, two 5 kW systems", "Can you make the quotation today?", "Give me an estimate with transport",
              "शर्मा जी के लिए कोटेशन बना दो", "पाटील यांना दरपत्रक पाठवा", "त्यांचे अंदाजपत्रक तयार करा", "kotation bhej do"]:
        assert heard(t), t
    for t in ["Our sales quota is done", "Wear a coat to the site", "Meeting moved to Friday", "कोटा पूरा हुआ", None]:
        assert not heard(t), t


def test_listening_hears_a_quote_in_a_general_session_and_asks_for_approval(api, owner, worker, team):  # noqa: F811
    w = team
    agent = billing_agent(api, owner, w, "bharata-listen-quote")
    plain, _ = make_agent(api, w, "notes-listen-plain")
    settings(api, w, w.manager, {"listenOn": True, "listenRetentionDays": 30})

    def session(ai, words):
        sid = one(api, w, w.manager, "select pulse.listen_start(%s,'Synthetic site meeting','general',true) r", (ai,))["r"]["id"]
        one(api, w, w.manager, "select pulse.listen_chunk_add(%s,0,'audio/webm',10000,%s)", (sid, b"RIFF-synthetic"))
        worker_one(worker, w, "select pulse.listen_chunk_claim() j")
        worker_one(worker, w, "select pulse.listen_chunk_done(%s,0,%s::jsonb,null)", (sid, json.dumps([{"s": 0.0, "e": 9.0, "t": words}])))
        one(api, w, w.manager, "select pulse.listen_stop(%s)", (sid,))
        assert worker_one(worker, w, "select pulse.listen_forward() n")["n"] == 1
        ch = owner_sql(owner, w, "select channel_id from pulse.listen_session where id=%s", (sid,))[0]["channel_id"]
        return owner_sql(owner, w, "select body from pulse.chat_message where channel_id=%s and body like '%%Live transcript%%' order by created_at desc limit 1", (ch,))[0]["body"]

    asked = session(agent, "Synthetic client: make the quotation for Desai Agro, three pumps, transport extra.")
    assert "Draft or update the quotation" in asked and "submit it for approval to me" in asked
    calm = session(agent, "Synthetic: the site visit is moved to Monday.")
    assert "React only if something needs doing" in calm and "quotation" not in calm.split("\n\n")[-1]
    # An AI employee without Billing is not asked to make quotations.
    other = session(plain, "Synthetic client: send the quotation tomorrow.")
    assert "React only if something needs doing" in other
