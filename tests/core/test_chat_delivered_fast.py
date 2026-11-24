"""VITALS-SWEEP (23 Nov 2026): every chat list load runs pulse.chat_delivered(). On production it read every message of
every chat the person is in, each with the chat row policy, to learn that nothing was new: 16.4 s for an EA member of
358 chats (112,414 messages), 8.0 s for one of 213; the list itself is 0.2-1 s. 2534 asks each chat for its newest message
from someone else (the newest-first index, stopping at the first) and compares that with what was delivered: same answer.
All people and messages are synthetic."""

import uuid

from pulse_sdk.db import set_tenant
from test_chats import setup


def send(api, channel, body):
    return api.execute(
        "select pulse.chat_send(%s,%s,null,'[]',%s,null) id", (channel, body, uuid.uuid4())
    ).fetchone()["id"]


def delivered(api, channel, person):
    row = api.execute(
        "select delivered_through from pulse.chat_receipt where channel_id=%s and person_id=%s", (channel, person)
    ).fetchone()
    return row["delivered_through"] if row else None


def test_delivered_covers_only_newer_messages_from_others(worker, owner, api):
    w = setup(worker, owner, api)
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        dm = api.execute("select pulse.chat_direct(%s) id", (w.editor2,)).fetchone()["id"]
        quiet = api.execute("select pulse.chat_direct(%s) id", (w.lead,)).fetchone()["id"]
        send(api, dm, "Synthetic hello")
    # editor2 loads the list: the chat with a message from someone else is delivered; nothing else gets a receipt.
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.chat_delivered()")
        first = delivered(api, dm, w.editor2)
        assert first is not None
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        api.execute("select pulse.chat_delivered()")
        assert delivered(api, quiet, w.lead) is None  # no message in it at all
    # editor2's own message is not "new to deliver": the receipt does not move, and no live event is raised again.
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        send(api, dm, "Synthetic own reply")
        events = api.execute("select count(*) n from pulse.chat_event where channel_id=%s", (dm,)).fetchone()["n"]
        api.execute("select pulse.chat_delivered()")
        assert delivered(api, dm, w.editor2) == first
        assert api.execute("select count(*) n from pulse.chat_event where channel_id=%s", (dm,)).fetchone()["n"] == events
    # A newer message from the other person moves it on.
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        send(api, dm, "Synthetic follow-up")
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.chat_delivered()")
        assert delivered(api, dm, w.editor2) > first


def test_delivered_asks_each_chat_for_its_newest_message_only(owner):
    # The slow form scanned every message (exists ... created_at > delivered_through, a join filter the index could not
    # use); the fast form takes the newest message from someone else, newest first, limit 1.
    body = "".join(owner.execute(
        "select pg_get_functiondef('pulse.chat_delivered()'::regprocedure) d"
    ).fetchone()["d"].lower().split())
    assert "orderbym.created_atdesclimit1" in body
    assert "exists(select1fromchat_message" not in body
