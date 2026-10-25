"""CHAT-VOICE: calls and voice messages in Chats against row-level security, on a synthetic team. The call state
machine (ring, answer, decline, hang up, missed after 45 s, busy, one call per conversation), signals reaching only
the person they are for, the call's line in the chat as its history, notifications by the policy (an incoming call is
urgent, a missed call and a voice message need you, also in a group), and voice notes' played state."""
import json
import uuid

import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def _dm(api, w, a, b):
    one(api, w, a, "select pulse.chat_refresh()")
    return one(api, w, a, "select pulse.chat_direct(%s) id", (b,))["id"]


def _view(api, w, who, call):
    return one(api, w, who, "select pulse.chat_call_view(%s) v", (call,))["v"]


def _notes(worker, w, person, kind):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select title,priority,quiet,read_at,dismissed_at,href from pulse.notification where person_id=%s and event_type=%s order by created_at", (person, kind)).fetchall()


def _line(worker, w, call):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select m.body,m.kind,m.attachments->0 a from pulse.chat_message m join pulse.chat_call c on c.message_id=m.id where c.id=%s", (call,)).fetchone()


def _age(worker, w, call, seconds):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.chat_call_party set invited_at=invited_at-make_interval(secs=>%s),seen_at=seen_at-make_interval(secs=>%s) where call_id=%s and state='ringing'", (seconds, seconds, call))


def test_a_call_rings_connects_carries_signals_and_ends(api, worker, team):
    w = team
    dm = _dm(api, w, w.editor, w.editor2)
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    v = _view(api, w, w.editor, call)
    assert v["state"] == "ringing" and {p["id"]: p["state"] for p in v["parties"]} == {str(w.editor): "joined", str(w.editor2): "ringing"}
    # The callee hears it at once: an urgent notification that pushes, and the call on their stream.
    ring = _notes(worker, w, w.editor2, "chat.call")
    assert len(ring) == 1 and ring[0]["priority"] == "urgent" and not ring[0]["quiet"] and f"call={call}" in ring[0]["href"]
    events = as_(api, w, w.editor2, "select * from pulse.chat_call_events(0)")
    assert any(e["kind"] == "state" and e["call_id"] == call and e["body"]["state"] == "ringing" for e in events)
    assert _line(worker, w, call)["a"]["state"] == "ringing"
    # Somebody outside the call sees nothing of it and cannot signal into it.
    assert _view(api, w, w.outsider, call) is None
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.chat_call_signal(%s,%s)", (call, Jsonb([{"to": str(w.editor), "kind": "description", "body": {"type": "offer", "sdp": "v=0"}}])))
    # Starting a call where one is open joins it instead.
    assert one(api, w, w.editor2, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"] == call
    v = _view(api, w, w.editor2, call)
    assert v["state"] == "live" and v["answeredAt"]
    assert _notes(worker, w, w.editor2, "chat.call")[0]["dismissed_at"] is not None
    # Signals go to the person named, from the sender, and to nobody else.
    cursor = one(api, w, w.editor2, "select pulse.chat_call_cursor() s")["s"]
    as_(api, w, w.editor, "select pulse.chat_call_signal(%s,%s)", (call, Jsonb([{"to": str(w.editor2), "kind": "description", "body": {"type": "offer", "sdp": "v=0"}},
                                                                                 {"to": str(w.editor2), "kind": "candidate", "body": {"candidate": "candidate:1 1 udp 1 192.0.2.1 9 typ host", "sdpMid": "0"}}])))
    got = [e for e in as_(api, w, w.editor2, "select * from pulse.chat_call_events(%s)", (cursor,)) if e["kind"] == "signal"]
    assert [(e["from_id"], e["body"]["kind"]) for e in got] == [(w.editor, "description"), (w.editor, "candidate")]
    assert not [e for e in as_(api, w, w.editor, "select * from pulse.chat_call_events(0)") if e["kind"] == "signal"]
    # Muting is seen by the others; hanging up ends a two-person call, and the chat keeps it with its length.
    assert one(api, w, w.editor2, "select pulse.chat_call_beat(%s,true,false) ok", (call,))["ok"] is True
    assert next(p for p in _view(api, w, w.editor, call)["parties"] if p["id"] == str(w.editor2))["muted"] is True
    as_(api, w, w.editor, "select pulse.chat_call_leave(%s)", (call,))
    v = _view(api, w, w.editor2, call)
    assert v["state"] == "ended" and v["endReason"] == "completed"
    line = _line(worker, w, call)
    assert line["kind"] == "event" and line["a"]["state"] == "completed" and line["body"].startswith("Voice call · 0:")
    assert one(api, w, w.editor2, "select pulse.chat_call_beat(%s,false,false) ok", (call,))["ok"] is False
    assert _notes(worker, w, w.editor2, "chat.missed_call") == []


def test_missed_declined_cancelled_and_busy(api, worker, team):
    w = team
    dm = _dm(api, w, w.editor, w.editor2)
    # Nobody answers for 45 seconds: a missed call that needs you, and the ring is gone.
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,true,null) id", (dm,))["id"]
    _age(worker, w, call, 50)
    as_(api, w, w.editor, "select pulse.chat_call_expire()")
    v = _view(api, w, w.editor, call)
    assert v["state"] == "ended" and v["endReason"] == "missed"
    missed = _notes(worker, w, w.editor2, "chat.missed_call")
    assert len(missed) == 1 and missed[0]["priority"] == "needs_you" and not missed[0]["quiet"] and missed[0]["title"].startswith("Missed video call from")
    assert all(n["dismissed_at"] for n in _notes(worker, w, w.editor2, "chat.call"))
    assert _line(worker, w, call)["body"] == "Missed video call"
    # Declined: the call ends at once, without a missed call.
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    as_(api, w, w.editor2, "select pulse.chat_call_decline(%s)", (call,))
    assert _view(api, w, w.editor, call)["endReason"] == "declined"
    assert len(_notes(worker, w, w.editor2, "chat.missed_call")) == 1
    # The caller hangs up before an answer: the other person has a missed call.
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    as_(api, w, w.editor, "select pulse.chat_call_leave(%s)", (call,))
    assert _view(api, w, w.editor2, call)["endReason"] == "missed" and len(_notes(worker, w, w.editor2, "chat.missed_call")) == 2
    # Someone already in a call is busy; a person in a call cannot start another.
    lead_dm = _dm(api, w, w.lead, w.editor2)
    live = one(api, w, w.lead, "select pulse.chat_call_start(%s,false,null) id", (lead_dm,))["id"]
    as_(api, w, w.editor2, "select pulse.chat_call_answer(%s)", (live,))
    busy = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    assert _view(api, w, w.editor, busy)["endReason"] == "busy"
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor2, "select pulse.chat_call_start(%s,false,null)", (dm,))
    # Someone whose Pulse stops answering for 30 seconds has left; the call ends.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.chat_call_party set seen_at=now()-interval '40 seconds' where call_id=%s and person_id=%s", (live, w.editor2))
    as_(api, w, w.lead, "select pulse.chat_call_expire()")
    assert _view(api, w, w.lead, live)["state"] == "ended"


def test_group_call_and_adding_someone(api, worker, team):
    w = team
    one(api, w, w.editor, "select pulse.chat_refresh()")
    group = one(api, w, w.editor, "select pulse.chat_group_create('Shoot crew',%s) id", ([w.editor2, w.lead],))["id"]
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,%s) id", (group, [w.editor2]))["id"]
    assert sorted(p["id"] for p in _view(api, w, w.editor, call)["parties"]) == sorted([str(w.editor), str(w.editor2)])
    as_(api, w, w.editor2, "select pulse.chat_call_answer(%s)", (call,))
    # Add someone from the group; a person outside it is not rung.
    as_(api, w, w.editor, "select pulse.chat_call_invite(%s,%s)", (call, [w.lead, w.outsider]))
    states = {p["id"]: p["state"] for p in _view(api, w, w.editor, call)["parties"]}
    assert states[str(w.lead)] == "ringing" and str(w.outsider) not in states
    assert _notes(worker, w, w.lead, "chat.call")[0]["priority"] == "urgent"
    as_(api, w, w.lead, "select pulse.chat_call_answer(%s)", (call,))
    # One leaves, the call goes on; the last two leave, it ends.
    as_(api, w, w.editor, "select pulse.chat_call_leave(%s)", (call,))
    assert _view(api, w, w.lead, call)["state"] == "live"
    as_(api, w, w.lead, "select pulse.chat_call_leave(%s)", (call,))
    assert _view(api, w, w.editor2, call)["state"] == "ended"
    recent = one(api, w, w.editor2, "select pulse.chat_call_recent(10) j")["j"]
    assert recent[0]["id"] == str(call)


def test_voice_message_needs_you_in_a_group_and_played_state(api, worker, team):
    w = team
    one(api, w, w.editor, "select pulse.chat_refresh()")
    group = one(api, w, w.editor, "select pulse.chat_group_create('Voice crew',%s) id", ([w.editor2, w.lead],))["id"]
    fid = one(api, w, w.editor, "select pulse.chat_file_add(%s,'Voice message.webm','audio/webm',%s) id", (group, b"\x1aE\xdf\xa3synthetic"))["id"]
    note = {"id": str(fid), "name": "Voice message.webm", "mime": "audio/webm", "voice": {"seconds": 4, "peaks": [10, 40, 90, 30]}}
    mid = one(api, w, w.editor, "select pulse.chat_send(%s,'',null,%s,%s,null) id", (group, json.dumps([note]), uuid.uuid4()))["id"]
    # In a group a plain message is FYI; a voice message needs you.
    n = _notes(worker, w, w.editor2, "chat.voice")
    assert len(n) == 1 and n[0]["priority"] == "needs_you" and not n[0]["quiet"] and n[0]["title"] == "New voice message in Chats"
    as_(api, w, w.editor, "select pulse.chat_send(%s,'Plain words',null,'[]',%s,null)", (group, uuid.uuid4()))
    assert [x["priority"] for x in _notes(worker, w, w.editor2, "chat.message")] == ["fyi"]
    state = lambda who: {r["message_id"]: r for r in as_(api, w, who, "select * from pulse.chat_voice_state(%s)", (group,))}
    assert state(w.editor2)[mid]["played"] is False and state(w.editor)[mid]["played_by"] == 0
    as_(api, w, w.editor2, "select pulse.chat_voice_played(%s)", (mid,))
    as_(api, w, w.editor2, "select pulse.chat_voice_played(%s)", (mid,))
    as_(api, w, w.editor, "select pulse.chat_voice_played(%s)", (mid,))  # the sender's own play does not count
    assert state(w.editor2)[mid]["played"] is True and state(w.editor)[mid]["played_by"] == 1
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select * from pulse.chat_voice_state(%s)", (group,))
    # Transcript requests queue once (the worker fills them when the server switches transcripts on).
    as_(api, w, w.editor2, "select pulse.chat_voice_transcript_request(%s)", (mid,))
    as_(api, w, w.lead, "select pulse.chat_voice_transcript_request(%s)", (mid,))
    assert state(w.editor)[mid]["transcript_state"] == "queued"
