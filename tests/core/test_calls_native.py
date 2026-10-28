"""CALLS-NATIVE (1240): a Pulse call rings the phone like a phone call. A ring goes to every registered device (an
iPhone's VoIP token for CallKit, Android's FCM token) with what a closed phone needs (the call, the caller, voice or
video); a colleague's call rings through quiet hours but not Do not disturb; a finished ring is stopped once on every
device it reached; an AI employee rings through the same path and keeps quiet hours; "Test my ringing" lists my
devices. Synthetic people and tokens only."""
import psycopg
import pytest
from psycopg.types.json import Jsonb
from pulse_sdk.db import set_tenant
from test_agent_coworkers import as_agent, make_agent
from test_notification_outbox import claim, dispatch, finish, owner_tx
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)

ANDROID = "fcm-synthetic-token-EXMP0001234-" + "x" * 40
VOIP = "b" * 64


def _phones(owner, w, person):
    with owner.transaction():
        owner_tx(owner, w)
        a = owner.execute("insert into pulse.native_device(org_id,person_id,name,platform,push_token,created_at) values(%s,%s,'Synthetic Android','android',%s,clock_timestamp()-interval '1 hour') returning id",
                          (w.org, person, ANDROID)).fetchone()["id"]
        i = owner.execute("insert into pulse.native_device(org_id,person_id,name,platform,voip_token,created_at) values(%s,%s,'Synthetic iPhone','ios',%s,clock_timestamp()-interval '1 hour') returning id",
                          (w.org, person, VOIP)).fetchone()["id"]
    return a, i


def _settings(worker, w, person, settings):
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.companion_notification_settings(org_id,person_id,settings) values(%s,%s,%s) on conflict(org_id,person_id) do update set settings=excluded.settings",
                       (w.org, person, Jsonb(settings)))


def _stops(worker, w, channel="native"):
    with worker.transaction():
        set_tenant(worker, w.org)
        return worker.execute("select pulse.call_ring_stops(%s) s", (channel,)).fetchone()["s"]


def _dm(api, w, a, b):
    one(api, w, a, "select pulse.chat_refresh()")
    return one(api, w, a, "select pulse.chat_direct(%s) id", (b,))["id"]


def _ring(worker, w, kind="chat.call"):
    """The phone deliveries claimed now that are of one kind (a ring; a missed call or a chat line may be queued too)."""
    jobs = claim(worker, w, "native")
    with worker.transaction():
        set_tenant(worker, w.org)
        kinds = {r["id"]: r["event_type"] for r in worker.execute("select id,event_type from pulse.notification where id=any(%s)", ([j["notification_id"] for j in jobs],)).fetchall()}
    return [j for j in jobs if kinds.get(j["notification_id"]) == kind]


def test_a_call_rings_every_phone_with_what_a_closed_phone_needs_and_stops_everywhere(api, worker, owner, team):
    w = team
    android, iphone = _phones(owner, w, w.editor2)
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,true,null) id", (_dm(api, w, w.editor, w.editor2),))["id"]
    jobs = _ring(worker, w)
    assert {j["destination_id"] for j in jobs} == {android, iphone}
    payloads = {j["destination_id"]: dispatch(worker, w, j) for j in jobs}
    for p in payloads.values():
        assert p["eventType"] == "chat.call" and p["callId"] == str(call) and p["video"] is True and p["ai"] is False
        assert p["caller"] and p["caller"] in p["title"] and f"call={call}" in p["href"]
    # Android rings by its FCM token; the iPhone by its VoIP token only (CallKit), never an ordinary alert token.
    assert payloads[android]["destination"] == {"token": ANDROID, "platform": "android", "voip": None}
    assert payloads[iphone]["destination"] == {"token": None, "platform": "ios", "voip": VOIP}
    for j in jobs:
        finish(worker, w, j, "accepted")
    assert _stops(worker, w) == []  # Still ringing: nothing to stop.
    # Answered on one device: the ring stops on every device it reached, once (an iPhone's CallKit asks for itself).
    as_(api, w, w.editor2, "select pulse.chat_call_answer(%s)", (call,))
    stops = _stops(worker, w)
    assert [(s["callId"], s["destination"]["token"]) for s in stops] == [(str(call), ANDROID)]
    assert _stops(worker, w) == []


def test_a_colleague_rings_through_quiet_hours_but_not_do_not_disturb(api, worker, owner, team):
    w = team
    _phones(owner, w, w.editor2)
    dm = _dm(api, w, w.editor, w.editor2)
    # Quiet all day (start = end): a colleague's call still rings; an ordinary notice would wait.
    _settings(worker, w, w.editor2, {"quiet": True, "start": "00:00", "end": "00:00", "timezone": "UTC"})
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    jobs = _ring(worker, w)
    assert len(jobs) == 2 and all(dispatch(worker, w, j)["callId"] == str(call) for j in jobs)
    as_(api, w, w.editor, "select pulse.chat_call_leave(%s)", (call,))
    # Do not disturb: the ring is dropped (a ring is now or never, never queued for later).
    _settings(worker, w, w.editor2, {"dnd": True})
    call2 = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (dm,))["id"]
    jobs = _ring(worker, w)
    assert len(jobs) == 2 and all(dispatch(worker, w, j) is None for j in jobs)
    with worker.transaction():
        set_tenant(worker, w.org)
        assert {r["status"] for r in worker.execute("select status from pulse.notification_delivery where id=any(%s)", ([j["id"] for j in jobs],)).fetchall()} == {"suppressed"}
    assert one(api, w, w.editor2, "select (pulse.call_ring_test_targets()->>'ringAllowed')::boolean ok")["ok"] is False
    as_(api, w, w.editor, "select pulse.chat_call_leave(%s)", (call2,))


def test_a_missed_ring_leaves_a_missed_call_and_stops(api, worker, owner, team):
    w = team
    _phones(owner, w, w.editor2)
    call = one(api, w, w.editor, "select pulse.chat_call_start(%s,false,null) id", (_dm(api, w, w.editor, w.editor2),))["id"]
    for j in _ring(worker, w):
        assert dispatch(worker, w, j)
        finish(worker, w, j, "accepted")
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.chat_call_party set invited_at=invited_at-interval '60 seconds' where call_id=%s and state='ringing'", (call,))
        # The server ends unanswered rings itself (call-ring.ts), with no Pulse open anywhere.
        worker.execute("select pulse.chat_call_expire()")
    assert one(api, w, w.editor2, "select pulse.chat_call_view(%s) v", (call,))["v"]["endReason"] == "missed"
    assert [s["callId"] for s in _stops(worker, w)] == [str(call)]
    missed = _ring(worker, w, "chat.missed_call")
    assert missed and all(dispatch(worker, w, j)["eventType"] == "chat.missed_call" for j in missed)


def test_an_ai_employee_rings_the_same_way_and_keeps_quiet_hours(api, worker, owner, team):
    w = team
    agent, _key = make_agent(api, w, "pulse-coordinator-cn")
    _phones(owner, w, w.editor2)
    r = as_agent(api, w, agent, "select pulse.call_ai_ring(%s,%s) r", (w.editor2, "The client EXMP0001234 is waiting on the quote. Can you call them?"))[0]["r"]
    assert r["rang"] is True
    jobs = _ring(worker, w)
    assert jobs and all(dispatch(worker, w, j)["ai"] is True for j in jobs)
    # Answering opens its message: the call is over as answered.
    as_(api, w, w.editor2, "select pulse.chat_call_answer(%s)", (r["callId"],))
    v = one(api, w, w.editor2, "select pulse.chat_call_view(%s) v", (r["callId"],))["v"]
    assert v["state"] == "ended" and v["endReason"] == "completed"
    assert any("waiting on the quote" in m["body"] for m in as_(api, w, w.editor2, "select body from pulse.chat_message where channel_id=%s", (r["channelId"],)))
    # Quiet hours: no ring, the message waits in the conversation.
    _settings(worker, w, w.editor2, {"quiet": True, "start": "00:00", "end": "00:00", "timezone": "UTC"})
    r2 = as_agent(api, w, agent, "select pulse.call_ai_ring(%s,%s) r", (w.editor2, "Second try about the quote."))[0]["r"]
    assert r2 == {"rang": False, "why": "quiet", "channelId": r["channelId"]}
    # Do not disturb as well.
    _settings(worker, w, w.editor2, {"dnd": True})
    assert as_agent(api, w, agent, "select pulse.call_ai_ring(%s,%s) r", (w.editor2, "Third try."))[0]["r"]["rang"] is False


def test_only_an_ai_employee_rings_this_way_and_test_targets_are_mine(api, worker, owner, team):
    w = team
    android, iphone = _phones(owner, w, w.editor2)
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor, "select pulse.call_ai_ring(%s,%s)", (w.editor2, "Pretending to be an AI employee."))
    t = one(api, w, w.editor2, "select pulse.call_ring_test_targets() t")["t"]
    assert t["personId"] == str(w.editor2) and t["ringAllowed"] is True and t["phones"] == 2
    assert {d["id"] for d in t["native"]} == {str(android), str(iphone)}
    assert one(api, w, w.editor, "select pulse.call_ring_test_targets() t")["t"]["native"] == []
    # The API role cannot claim stops (the worker's job) or reach other people's devices.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        as_(api, w, w.editor2, "select pulse.call_ring_stops('native')")
    # A VoIP token is 64 hex characters, nothing else.
    with owner.transaction():
        owner_tx(owner, w)
        with pytest.raises(psycopg.errors.CheckViolation):
            owner.execute("update pulse.native_device set voip_token='not-a-token' where id=%s", (iphone,))
