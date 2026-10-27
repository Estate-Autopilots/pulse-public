"""CALLS-V2: what calls measure about themselves and screen sharing, against row-level security, on a synthetic team.
A browser's notes about a call (setup time, the media path, quality at the end, why it failed) are written only by
someone asked to the call, within a per-call budget, numbers and short codes only; a failure before any call exists
(the microphone refused) is the only note without a call. A one-to-one call whose media never connected reads "not
connected" in the chat, whether the note comes before or after the hang-up. Admins and leadership read the summary;
nobody else does. Sharing a screen travels with the beat and is seen by the others."""
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


def _line(worker, w, call):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select m.body,m.attachments->0 a from pulse.chat_message m join pulse.chat_call c on c.message_id=m.id where c.id=%s", (call,)).fetchone()


def _notes(worker, w, call=None, person=None):
    with worker.transaction():
        set_tenant(worker, w.org)
        if call:
            return worker.execute("select * from pulse.chat_call_quality where call_id=%s order by id", (call,)).fetchall()
        return worker.execute("select * from pulse.chat_call_quality where call_id is null and person_id=%s order by id", (person,)).fetchall()


def _live_call(api, w):
    dm = _dm(api, w, w.editor, w.editor2)
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    as_(api, w, w.editor2, "select pulse.chat_call_answer(%s)", (call,))
    return call


def test_notes_come_from_the_call_s_people_and_say_how_it_connected(api, worker, team):
    w = team
    call = _live_call(api, w)
    as_(api, w, w.editor2, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({"kind": "setup", "role": "callee", "video": False, "setupMs": 1840, "mediaMs": 220, "path": "relay-tcp",
                                                                            "rttMs": 95, "peers": 1, "platform": "web", "device": "phone", "network": "cellular", "relayOffered": True, "relayGathered": True})))
    # Anything not a number or a short code is dropped, never stored: no addresses, no candidates.
    as_(api, w, w.editor, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({"kind": "end", "role": "caller", "path": "candidate:1 1 udp 192.0.2.1", "seconds": 64, "lossPct": 1.257,
                                                                           "rttMs": "lots", "reason": "Not A Code!", "network": "wifi"})))
    rows = _notes(worker, w, call)
    assert [(r["kind"], r["role"], r["path"]) for r in rows] == [("setup", "callee", "relay-tcp"), ("end", "caller", None)]
    assert (rows[0]["setup_ms"], rows[0]["media_ms"], rows[0]["device"], rows[0]["network"], rows[0]["relay_gathered"]) == (1840, 220, "phone", "cellular", True)
    assert (rows[1]["seconds"], float(rows[1]["loss_pct"]), rows[1]["rtt_ms"], rows[1]["reason"]) == (64, 1.26, None, None)
    # Somebody not asked to the call writes nothing about it; an unknown kind is refused.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({"kind": "setup", "setupMs": 1})))
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({"kind": "story"})))
    # 1061: no kind at all is invalid too (it reached the insert's not-null rule: a 500; SHIP-3).
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({})))
    # A failure before any call exists has no call; nothing else may go without one.
    as_(api, w, w.outsider, "select pulse.chat_call_note(null,%s)", (Jsonb({"kind": "failure", "reason": "media-denied", "role": "caller", "video": True}),))
    assert [(r["reason"], r["video"]) for r in _notes(worker, w, person=w.outsider)] == [("media-denied", True)]
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.outsider, "select pulse.chat_call_note(null,%s)", (Jsonb({"kind": "setup", "setupMs": 5}),))
    # A person writes at most 40 notes about one call (a stuck browser cannot fill the table).
    for _ in range(45):
        as_(api, w, w.editor, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({"kind": "reconnect", "reconnects": 1})))
    assert len([r for r in _notes(worker, w, call) if r["person_id"] == w.editor]) == 40


def test_a_one_to_one_call_that_never_connected_says_so(api, worker, team):
    w = team
    # The note first, then the hang-up.
    call = _live_call(api, w)
    as_(api, w, w.editor2, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({"kind": "failure", "reason": "no-connect", "relayOffered": False, "relayGathered": False})))
    as_(api, w, w.editor, "select pulse.chat_call_leave(%s)", (call,))
    assert _view(api, w, w.editor, call)["endReason"] == "failed"
    line = _line(worker, w, call)
    assert line["body"] == "Voice call · not connected" and line["a"]["state"] == "failed"
    # The hang-up first, then the note (the browser says it while it closes).
    call = _live_call(api, w)
    as_(api, w, w.editor, "select pulse.chat_call_leave(%s)", (call,))
    assert _view(api, w, w.editor, call)["endReason"] == "completed"
    as_(api, w, w.editor, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({"kind": "failure", "reason": "no-connect"})))
    assert _view(api, w, w.editor2, call)["endReason"] == "failed" and _line(worker, w, call)["a"]["state"] == "failed"
    # A call that connected (somebody said so) stays a call with its length, whatever else was said.
    call = _live_call(api, w)
    as_(api, w, w.editor, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({"kind": "setup", "setupMs": 900, "path": "host"})))
    as_(api, w, w.editor2, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({"kind": "failure", "reason": "no-connect"})))
    as_(api, w, w.editor2, "select pulse.chat_call_leave(%s)", (call,))
    assert _view(api, w, w.editor, call)["endReason"] == "completed" and _line(worker, w, call)["body"].startswith("Voice call · 0:")


def test_the_summary_is_for_admins_and_leadership(api, worker, team):
    w = team
    call = _live_call(api, w)
    for who, ms, path in ((w.editor, 1200, "host"), (w.editor2, 3400, "relay-udp")):
        as_(api, w, who, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({"kind": "setup", "setupMs": ms, "path": path, "platform": "web", "device": "desktop"})))
    as_(api, w, w.editor, "select pulse.chat_call_note(%s,%s)", (call, Jsonb({"kind": "end", "seconds": 30, "rttMs": 80, "lossPct": 2, "reconnects": 1})))
    as_(api, w, w.outsider, "select pulse.chat_call_note(null,%s)", (Jsonb({"kind": "failure", "reason": "media-denied"}),))
    s = one(api, w, w.manager, "select pulse.chat_call_quality_summary(14) s")["s"]
    assert s["calls"] >= 1 and s["answered"] >= 1 and s["connects"] == 2
    assert s["paths"] == {"host": 1, "relay-udp": 1} and s["failures"] == {"media-denied": 1}
    assert s["setupP50"] == 2300 and s["reconnects"] == 1 and s["rttMs"] == 80
    assert s["recent"][0]["reason"] == "media-denied"
    for who in (w.editor, w.editor2, w.outsider):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, who, "select pulse.chat_call_quality_summary(14)")


def test_a_shared_screen_travels_with_the_beat(api, worker, team):
    w = team
    call = _live_call(api, w)
    cursor = one(api, w, w.editor2, "select pulse.chat_call_cursor() s")["s"]
    assert one(api, w, w.editor, "select pulse.chat_call_beat(%s,false,false,true) ok", (call,))["ok"] is True
    me = next(p for p in _view(api, w, w.editor2, call)["parties"] if p["id"] == str(w.editor))
    assert me["screen"] is True and me["video"] is False
    # The others hear it at once (a state event on their stream).
    assert any(e["kind"] == "state" and e["body"]["parties"] for e in as_(api, w, w.editor2, "select * from pulse.chat_call_events(%s)", (cursor,)))
    # The older three-argument beat (an open Pulse from before) leaves the screen as it is.
    assert one(api, w, w.editor, "select pulse.chat_call_beat(%s,true,false) ok", (call,))["ok"] is True
    me = next(p for p in _view(api, w, w.editor2, call)["parties"] if p["id"] == str(w.editor))
    assert me["screen"] is True and me["muted"] is True
    # Someone who has left is never shown sharing.
    as_(api, w, w.editor, "select pulse.chat_call_leave(%s)", (call,))
    me = next(p for p in _view(api, w, w.editor2, call)["parties"] if p["id"] == str(w.editor))
    assert me["screen"] is False


# ---- Recording (1033) -------------------------------------------------------------------------------------------------

def _rec(worker, w, rid):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select * from pulse.chat_call_recording where id=%s", (rid,)).fetchone()


def _rec_line(worker, w, rid):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select m.body,m.kind,m.attachments->0 a from pulse.chat_message m join pulse.chat_call_recording r on r.message_id=m.id where r.id=%s", (rid,)).fetchone()


def test_recording_is_opt_in_seen_by_everyone_and_kept_in_the_chat(api, worker, team):
    w = team
    dm = _dm(api, w, w.editor, w.editor2)
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    # Not before the call is answered; never by someone outside it.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor, "select pulse.chat_call_record_start(%s,'audio/webm')", (call,))
    as_(api, w, w.editor2, "select pulse.chat_call_answer(%s)", (call,))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.outsider, "select pulse.chat_call_record_start(%s,'audio/webm')", (call,))
    assert _view(api, w, w.editor, call)["mayRecord"] is True and _view(api, w, w.editor, call)["recording"] is None
    rid = one(api, w, w.editor, "select pulse.chat_call_record_start(%s,'audio/webm') id", (call,))["id"]
    # One recording at a time.
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        as_(api, w, w.editor2, "select pulse.chat_call_record_start(%s,'audio/webm')", (call,))
    # Everyone in the call sees it at once; the recorder has acknowledged it, the other has not yet.
    theirs, mine = _view(api, w, w.editor2, call)["recording"], _view(api, w, w.editor, call)["recording"]
    assert theirs["id"] == str(rid) and theirs["by"] == str(w.editor) and theirs["acked"] is False and mine["acked"] is True
    as_(api, w, w.editor2, "select pulse.chat_call_record_ack(%s)", (rid,))
    assert _view(api, w, w.editor2, call)["recording"]["acked"] is True
    line = _rec_line(worker, w, rid)
    assert line["kind"] == "event" and line["body"] == "Call recording · recording now" and line["a"]["recordingState"] == "recording"
    # Parts come from the recorder only, in order, and again is harmless.
    for seq, chunk in ((1, b"-part-two"), (0, b"part-one"), (1, b"-part-two")):
        as_(api, w, w.editor, "select pulse.chat_call_record_part(%s,%s,%s)", (rid, seq, chunk))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.chat_call_record_part(%s,2,%s)", (rid, b"not mine"))
    r = _rec(worker, w, rid)
    assert (r["parts"], r["bytes"]) == (2, len(b"part-one-part-two"))
    # Anyone in the call may stop it; what was recorded is kept, its transcript asked for, and (a team call) AI notes.
    as_(api, w, w.editor2, "select pulse.chat_call_record_stop(%s,%s)", (rid, 999))
    r = _rec(worker, w, rid)
    assert r["state"] == "saved" and r["transcript_state"] == "queued" and r["summary_state"] == "queued" and r["seconds"] != 999
    assert _view(api, w, w.editor, call)["recording"] is None
    assert _rec_line(worker, w, rid)["body"].startswith("Call recording · 0:")
    # The last part may still arrive after the stop.
    as_(api, w, w.editor, "select pulse.chat_call_record_part(%s,2,%s)", (rid, b"-tail"))
    # The conversation's members hear it, in order; nobody else does.
    audio = one(api, w, w.editor2, "select mime,bytes from pulse.chat_call_recording_audio(%s)", (rid,))
    assert audio["mime"] == "audio/webm" and bytes(audio["bytes"]) == b"part-one-part-two-tail"
    assert as_(api, w, w.outsider, "select * from pulse.chat_call_recording_audio(%s)", (rid,)) == []
    assert one(api, w, w.outsider, "select pulse.chat_call_recording_view(%s) v", (rid,))["v"] is None
    v = one(api, w, w.editor2, "select pulse.chat_call_recording_view(%s) v", (rid,))["v"]
    assert v["state"] == "saved" and v["canRemove"] is False and len(v["acks"]) == 2 and len(v["people"]) == 2
    # Only the recorder (or an admin) deletes it; the audio goes, the line says so.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.chat_call_record_remove(%s)", (rid,))
    as_(api, w, w.editor, "select pulse.chat_call_record_remove(%s)", (rid,))
    r = _rec(worker, w, rid)
    assert r["state"] == "removed" and r["parts"] == 0 and r["transcript"] is None and r["summary_state"] == "off"
    assert as_(api, w, w.editor2, "select * from pulse.chat_call_recording_audio(%s)", (rid,)) == []
    assert _rec_line(worker, w, rid)["body"] == "Call recording · deleted"


def test_the_call_ending_or_a_silent_browser_closes_a_recording(api, worker, team):
    w = team
    dm = _dm(api, w, w.editor, w.editor2)
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    as_(api, w, w.editor2, "select pulse.chat_call_answer(%s)", (call,))
    rid = one(api, w, w.editor, "select pulse.chat_call_record_start(%s,'audio/ogg') id", (call,))["id"]
    as_(api, w, w.editor, "select pulse.chat_call_record_part(%s,0,%s)", (rid, b"opus"))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.chat_call_recording set started_at=started_at-interval '75 seconds' where id=%s", (rid,))
    as_(api, w, w.editor2, "select pulse.chat_call_leave(%s)", (call,))
    r = _rec(worker, w, rid)
    assert r["state"] == "saved" and r["mime"] == "audio/ogg" and r["stopped_at"] is not None
    # Its length is the time since it started (the recorder's own count never came): not 0:00.
    assert 75 <= r["seconds"] < 120 and _rec_line(worker, w, rid)["body"].startswith("Call recording · 1:"), (r["seconds"], _rec_line(worker, w, rid)["body"])
    # A recording whose browser stopped sending three minutes ago is closed by the expiry (nothing sent: nothing saved).
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    as_(api, w, w.editor2, "select pulse.chat_call_answer(%s)", (call,))
    rid = one(api, w, w.editor2, "select pulse.chat_call_record_start(%s,'audio/webm') id", (call,))["id"]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.chat_call_recording set started_at=started_at-interval '4 minutes' where id=%s", (rid,))
    as_(api, w, w.editor, "select pulse.chat_call_expire()")
    r = _rec(worker, w, rid)
    assert r["state"] == "failed" and r["transcript_state"] == "off" and _rec_line(worker, w, rid)["body"] == "Call recording · nothing was saved"


def test_the_company_policy_decides_recording_and_ai_notes(api, worker, team):
    w = team
    # Admins set it; nobody else.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.chat_call_policy_set(%s)", (Jsonb({"recording": "off"}),))
    assert one(api, w, w.editor, "select pulse.chat_call_policy_get() p")["p"]["aiSummary"] == "staff"
    dm = _dm(api, w, w.editor, w.editor2)
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    as_(api, w, w.editor2, "select pulse.chat_call_answer(%s)", (call,))
    p = one(api, w, w.manager, "select pulse.chat_call_policy_set(%s) p", (Jsonb({"recording": "off", "transcripts": True, "aiSummary": "staff"}),))["p"]
    assert p["recording"] == "off"
    assert _view(api, w, w.editor, call)["mayRecord"] is False
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.chat_call_record_start(%s,'audio/webm')", (call,))
    # Recording on; a call with someone from outside the team (a client) gets a transcript but no AI notes by default.
    one(api, w, w.manager, "select pulse.chat_call_policy_set(%s) p", (Jsonb({"recording": "staff", "transcripts": True, "aiSummary": "staff"}),))
    client = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Client Contact','client')", (client, w.org))
        worker.execute("insert into pulse.chat_call_party(org_id,call_id,person_id,state,joined_at) values(%s,%s,%s,'joined',now())", (w.org, call, client))
    rid = one(api, w, w.editor, "select pulse.chat_call_record_start(%s,'audio/webm') id", (call,))["id"]
    as_(api, w, w.editor, "select pulse.chat_call_record_part(%s,0,%s)", (rid, b"opus"))
    as_(api, w, w.editor, "select pulse.chat_call_record_stop(%s,42)", (rid,))
    r = _rec(worker, w, rid)
    assert (r["transcript_state"], r["summary_state"], r["seconds"]) == ("queued", "off", 42)
    # "all": every recorded call gets notes; transcripts off: neither.
    one(api, w, w.manager, "select pulse.chat_call_policy_set(%s) p", (Jsonb({"recording": "staff", "transcripts": True, "aiSummary": "all"}),))
    rid = one(api, w, w.editor, "select pulse.chat_call_record_start(%s,'audio/webm') id", (call,))["id"]
    as_(api, w, w.editor, "select pulse.chat_call_record_part(%s,0,%s)", (rid, b"opus"))
    as_(api, w, w.editor, "select pulse.chat_call_record_stop(%s,5)", (rid,))
    assert _rec(worker, w, rid)["summary_state"] == "queued"
    one(api, w, w.manager, "select pulse.chat_call_policy_set(%s) p", (Jsonb({"recording": "staff", "transcripts": False, "aiSummary": "all"}),))
    rid = one(api, w, w.editor, "select pulse.chat_call_record_start(%s,'audio/webm') id", (call,))["id"]
    as_(api, w, w.editor, "select pulse.chat_call_record_part(%s,0,%s)", (rid, b"opus"))
    as_(api, w, w.editor, "select pulse.chat_call_record_stop(%s,5)", (rid,))
    assert (_rec(worker, w, rid)["transcript_state"], _rec(worker, w, rid)["summary_state"]) == ("off", "off")


def test_only_the_conversation_s_people_or_a_colleague_are_rung_in(api, worker, team):
    """Client calls (with CLIENT-PORTAL): someone from a client's side rings only the people of the chats shared with
    them, and nobody rings a client into a conversation that is not theirs. Checked on the trigger, whatever version of
    start or invite runs."""
    w = team
    dm = _dm(api, w, w.editor, w.editor2)
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    as_(api, w, w.editor2, "select pulse.chat_call_answer(%s)", (call,))
    # A colleague adds a colleague to a one-to-one call.
    as_(api, w, w.editor, "select pulse.chat_call_invite(%s,%s)", (call, [w.outsider]))
    assert next(p for p in _view(api, w, w.editor, call)["parties"] if p["id"] == str(w.outsider))["state"] == "ringing"
    as_(api, w, w.outsider, "select pulse.chat_call_decline(%s)", (call,))
    client = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Client Contact','client')", (client, w.org))
    # Nobody rings a client into a conversation the client is not in.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("insert into pulse.chat_call_party(org_id,call_id,person_id,state,invited_by) values(%s,%s,%s,'ringing',%s)", (w.org, call, client, w.editor))
    # Someone from a client's side in a one-to-one call cannot pull in anyone else of the company.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.person set side='client' where id=%s", (w.editor2,))
    try:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            as_(api, w, w.editor2, "select pulse.chat_call_invite(%s,%s)", (call, [w.outsider]))
    finally:
        with worker.transaction():
            set_tenant(worker, w.org)
            worker.execute("update pulse.person set side='staff' where id=%s", (w.editor2,))
    # The conversation's own people are always fine (as starting a call rings them).
    as_(api, w, w.editor, "select pulse.chat_call_leave(%s)", (call,))
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    assert next(p for p in _view(api, w, w.editor, call)["parties"] if p["id"] == str(w.editor2))["state"] == "ringing"


def test_ai_notes_are_the_team_s_in_a_chat_with_a_client(api, worker, owner, team):
    """Under "every recorded call", a call in a conversation with a client gets AI notes, but they are the team's: the
    client's contact sees the recording and its transcript (their own words), never AI text no person approved."""
    w = team
    dm = _dm(api, w, w.editor, w.editor2)
    call = _live_call(api, w)
    rid = one(api, w, w.editor, "select pulse.chat_call_record_start(%s,'audio/webm') id", (call,))["id"]
    as_(api, w, w.editor, "select pulse.chat_call_record_part(%s,0,%s)", (rid, b"opus"))
    as_(api, w, w.editor, "select pulse.chat_call_record_stop(%s,30)", (rid,))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("""update pulse.chat_call_recording set transcript_state='done',transcript='We agreed the brochure goes out on Friday.',summary_state='done',
            summary='{"summary":"The brochure goes out Friday.","decisions":[],"actions":[]}' where id=%s""", (rid,))
    # A connected client's contact (a seat) in the conversation.
    client, account = uuid.uuid4(), uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Client Contact','client')", (client, w.org))
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name) values(%s,%s,'Synthetic Client Contact')", (account, f"client.{str(account)[:8]}"))
        conn = owner.execute("insert into pulse_priv.org_connection(a_org,b_account,status) values(%s,%s,'active') returning id", (w.org, account)).fetchone()["id"]
        owner.execute("insert into pulse_priv.connect_seat(connection_id,account_id,seat_org,seat_person) values(%s,%s,%s,%s)", (conn, account, w.org, client))
        owner.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, dm, client))
    team_view = one(api, w, w.editor2, "select pulse.chat_call_recording_view(%s) v", (rid,))["v"]
    assert team_view["summaryState"] == "done" and team_view["summary"]["summary"] == "The brochure goes out Friday."
    client_view = one(api, w, client, "select pulse.chat_call_recording_view(%s) v", (rid,))["v"]
    assert client_view["transcript"].startswith("We agreed") and client_view["summaryState"] == "off" and client_view["summary"] is None and client_view["summaryBy"] is None


def _seat(owner, w, channels):
    """A connected client's contact (a seat of an active connection) in the given conversations."""
    client, account = uuid.uuid4(), uuid.uuid4()
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Client Caller','client')", (client, w.org))
        owner.execute("insert into pulse_priv.pulse_account(id,handle,display_name) values(%s,%s,'Synthetic Client Caller')", (account, f"caller.{str(account)[:8]}"))
        conn = owner.execute("insert into pulse_priv.org_connection(a_org,b_account,status) values(%s,%s,'active') returning id", (w.org, account)).fetchone()["id"]
        owner.execute("insert into pulse_priv.connect_seat(connection_id,account_id,seat_org,seat_person) values(%s,%s,%s,%s)", (conn, account, w.org, client))
        for ch in channels:
            owner.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, ch, client))
    return client


def test_a_client_calls_their_team_and_is_called_by_them(api, worker, owner, team):
    """CLIENT-PORTAL with CALLS-V2: in a chat shared with a client, the team's call rings the client's contact too (1020
    left them out), the contact answers but adds nobody and records nothing, calls their team from that chat, and cannot
    start a call in a conversation that is not theirs."""
    w = team
    shared = _dm(api, w, w.editor, w.editor2)
    client = _seat(owner, w, [shared])
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (shared,))["id"]
    states = {p["id"]: p["state"] for p in _view(api, w, w.editor, call)["parties"]}
    assert states[str(client)] == "ringing" and states[str(w.editor2)] == "ringing"
    as_(api, w, client, "select pulse.chat_call_answer(%s)", (call,))
    v = _view(api, w, client, call)
    assert v["state"] == "live" and v["mayInvite"] is False and v["mayRecord"] is False
    # Ringing someone else of the company into it does nothing (or is refused).
    try:
        as_(api, w, client, "select pulse.chat_call_invite(%s,%s)", (call, [w.outsider]))
    except psycopg.errors.InsufficientPrivilege:
        pass
    assert str(w.outsider) not in {p["id"] for p in _view(api, w, w.editor, call)["parties"]}
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, client, "select pulse.chat_call_record_start(%s,'audio/webm')", (call,))
    as_(api, w, w.editor, "select pulse.chat_call_leave(%s)", (call,))
    as_(api, w, client, "select pulse.chat_call_leave(%s)", (call,))
    assert _view(api, w, w.editor, call)["state"] == "ended"
    # The client calls their team from the shared chat.
    call = one(api, w, client, "select pulse.chat_call_start(%s,true,null) id", (shared,))["id"]
    states = {p["id"]: p["state"] for p in _view(api, w, client, call)["parties"]}
    assert states[str(w.editor)] == "ringing" and states[str(w.editor2)] == "ringing" and states[str(client)] == "joined"
    as_(api, w, client, "select pulse.chat_call_leave(%s)", (call,))
    # Not in a conversation that is not theirs.
    other = _dm(api, w, w.editor, w.outsider)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, client, "select pulse.chat_call_start(%s,false,null)", (other,))
