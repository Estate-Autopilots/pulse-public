"""CHAT-V5: how far I have read a thread (mine alone, for the Threads inbox); reminders on a message and messages sent
later (mine alone until they ring or go). Synthetic tenants only."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from pulse_sdk.db import set_tenant
from test_tasks_rt1 import as_, notes, one, team  # noqa: F401  (team is a fixture)


def _group(api, w, name="V5 desk", members=None):
    return one(api, w, w.editor2, "select pulse.chat_group_create(%s,%s) id", (name, members or [w.editor]))["id"]


def _send(api, w, who, channel, body, parent=None):
    return one(api, w, who, "select pulse.chat_send(%s,%s,%s,'[]'::jsonb,%s,null) id", (channel, body, parent, str(uuid.uuid4())))["id"]


def test_a_thread_read_is_mine_and_only_for_a_first_message(api, team):  # noqa: F811
    w = team
    ch = _group(api, w)
    root = _send(api, w, w.editor2, ch, "Which cover do we send?")
    reply = _send(api, w, w.editor, ch, "The garden one", parent=root)
    as_(api, w, w.editor2, "select pulse.chat_thread_seen(%s)", (root,))
    as_(api, w, w.editor2, "select pulse.chat_thread_seen(%s)", (root,))   # again: still one row
    assert one(api, w, w.editor2, "select count(*)::int n from pulse.chat_thread_read where root_id=%s", (root,))["n"] == 1
    # Nobody else sees how far I read.
    assert one(api, w, w.editor, "select count(*)::int n from pulse.chat_thread_read where root_id=%s", (root,))["n"] == 0
    with pytest.raises(Exception, match="thread unavailable"):
        as_(api, w, w.editor, "select pulse.chat_thread_seen(%s)", (reply,))
    # Not in the conversation: refused.
    with pytest.raises(Exception, match="message unavailable"):
        as_(api, w, w.outsider, "select pulse.chat_thread_seen(%s)", (root,))


def _past(owner, w, table, row):
    """Make a reminder or a scheduled message due now (the functions only take times ahead)."""
    with owner.transaction():
        set_tenant(owner, w.org)
        col = "due_at" if table == "chat_reminder" else "send_at"
        owner.execute(f"update pulse.{table} set {col}=clock_timestamp()-interval '1 minute' where id=%s", (row,))


def test_a_reminder_is_mine_rings_once_and_marks_the_chat(api, owner, worker, team):  # noqa: F811
    w = team
    ch = _group(api, w)
    mid = _send(api, w, w.editor2, ch, "Send the floor plans to the client")
    soon = datetime.now(timezone.utc) + timedelta(hours=1)
    with pytest.raises(Exception, match="choose a time ahead"):
        as_(api, w, w.editor, "select pulse.chat_remind(%s,%s)", (mid, datetime.now(timezone.utc)))
    first = one(api, w, w.editor, "select pulse.chat_remind(%s,%s) id", (mid, soon))["id"]
    second = one(api, w, w.editor, "select pulse.chat_remind(%s,%s) id", (mid, soon + timedelta(hours=1)))["id"]
    # A new time replaces the old one; only I see my reminders.
    assert [r["id"] for r in as_(api, w, w.editor, "select id from pulse.chat_reminder where cancelled_at is null")] == [second]
    assert as_(api, w, w.editor2, "select id from pulse.chat_reminder") == []
    assert first != second
    with pytest.raises(Exception, match="message unavailable"):
        as_(api, w, w.outsider, "select pulse.chat_remind(%s,%s)", (mid, soon))
    _past(owner, w, "chat_reminder", second)
    # Anyone's request (or the API's timer) delivers what is due in the company, once.
    assert one(api, w, w.editor2, "select pulse.chat_due() n")["n"] == 1
    assert one(api, w, w.editor2, "select pulse.chat_due() n")["n"] == 0
    rang = notes(worker, w, w.editor, "chat.mention")
    assert [n["title"] for n in rang] == ["Reminder: Send the floor plans to the client"]
    assert rang[0]["href"] == f"/chats?channel={ch}&message={mid}"
    assert one(api, w, w.editor, "select marked_unread_at is not null m from pulse.chat_member where channel_id=%s and person_id=%s", (ch, w.editor))["m"]
    # Opening the chat clears the chip.
    as_(api, w, w.editor, "select pulse.chat_reminders_seen(%s)", (ch,))
    assert one(api, w, w.editor, "select seen_at is not null s from pulse.chat_reminder where id=%s", (second,))["s"]


def test_a_scheduled_message_goes_as_its_author_and_can_be_changed_until_then(api, owner, team):  # noqa: F811
    w = team
    ch = _group(api, w)
    later = datetime.now(timezone.utc) + timedelta(days=1)
    sid = one(api, w, w.editor, "select pulse.chat_schedule(%s,%s,'[]'::jsonb,null,null,%s) id", (ch, "Good morning, the shoot is at 10", later))["id"]
    gone = one(api, w, w.editor, "select pulse.chat_schedule(%s,%s,'[]'::jsonb,null,null,%s) id", (ch, "Never mind", later))["id"]
    as_(api, w, w.editor, "select pulse.chat_schedule_cancel(%s,false)", (gone,))
    as_(api, w, w.editor, "select pulse.chat_schedule_edit(%s,%s,null)", (sid, "Good morning, the shoot is at 11"))
    # Not mine to change; nobody else sees it.
    with pytest.raises(Exception, match="already gone or was cancelled"):
        as_(api, w, w.editor2, "select pulse.chat_schedule_edit(%s,%s,null)", (sid, "hijacked"))
    assert as_(api, w, w.editor2, "select id from pulse.chat_scheduled") == []
    with pytest.raises(Exception, match="conversation unavailable"):
        as_(api, w, w.outsider, "select pulse.chat_schedule(%s,'hi','[]'::jsonb,null,null,%s)", (ch, later))
    _past(owner, w, "chat_scheduled", sid)
    _past(owner, w, "chat_scheduled", gone)
    assert one(api, w, w.editor2, "select pulse.chat_due() n")["n"] == 1
    sent = as_(api, w, w.editor2, "select author_id,body from pulse.chat_message where channel_id=%s and body like 'Good morning%%'", (ch,))
    assert [(r["author_id"], r["body"]) for r in sent] == [(w.editor, "Good morning, the shoot is at 11")]
    assert not as_(api, w, w.editor2, "select 1 from pulse.chat_message where body='Never mind'")
    with pytest.raises(Exception, match="already gone or was cancelled"):
        as_(api, w, w.editor, "select pulse.chat_schedule_cancel(%s,false)", (sid,))


def test_a_scheduled_message_whose_author_left_the_group_is_not_sent(api, owner, team):  # noqa: F811
    w = team
    ch = _group(api, w, members=[w.editor, w.lead])
    sid = one(api, w, w.editor, "select pulse.chat_schedule(%s,%s,'[]'::jsonb,null,null,%s) id", (ch, "Later words", datetime.now(timezone.utc) + timedelta(hours=2)))["id"]
    as_(api, w, w.editor, "select pulse.chat_group_leave(%s)", (ch,))
    _past(owner, w, "chat_scheduled", sid)
    as_(api, w, w.editor2, "select pulse.chat_due()")
    row = one(api, w, w.editor, "select failed_at is not null f,error from pulse.chat_scheduled where id=%s", (sid,))
    assert row["f"] and "unavailable" in row["error"]


def _votes(api, w, who, mid):
    return sorted((r["choice"], str(r["person_id"])) for r in as_(api, w, who, "select v.choice,v.person_id from pulse.chat_poll_vote v join pulse.chat_poll p on p.id=v.poll_id where p.message_id=%s", (mid,)))


def test_a_poll_takes_votes_from_members_until_it_is_closed(api, team):  # noqa: F811
    w = team
    ch = _group(api, w, members=[w.editor, w.lead])
    with pytest.raises(Exception, match="give 2 to 10 choices"):
        as_(api, w, w.editor2, "select pulse.chat_poll_create(%s,%s,%s,false,%s)", (ch, "Cover?", ["Garden"], str(uuid.uuid4())))
    with pytest.raises(Exception, match="each choice once"):
        as_(api, w, w.editor2, "select pulse.chat_poll_create(%s,%s,%s,false,%s)", (ch, "Cover?", ["Garden", "garden"], str(uuid.uuid4())))
    key = str(uuid.uuid4())
    mid = one(api, w, w.editor2, "select pulse.chat_poll_create(%s,%s,%s,false,%s) id", (ch, "Which cover?", ["Garden", "Sea view", " "], key))["id"]
    # Sent twice with the same key: one poll.
    assert one(api, w, w.editor2, "select pulse.chat_poll_create(%s,%s,%s,false,%s) id", (ch, "Which cover?", ["Garden", "Sea view"], key))["id"] == mid
    assert one(api, w, w.editor, "select body from pulse.chat_message where id=%s", (mid,))["body"] == "Which cover?"
    assert one(api, w, w.editor, "select options from pulse.chat_poll where message_id=%s", (mid,))["options"] == ["Garden", "Sea view"]
    as_(api, w, w.editor, "select pulse.chat_poll_vote(%s,%s)", (mid, [0]))
    as_(api, w, w.editor, "select pulse.chat_poll_vote(%s,%s)", (mid, [1]))   # changed my mind
    as_(api, w, w.lead, "select pulse.chat_poll_vote(%s,%s)", (mid, [1]))
    with pytest.raises(Exception, match="takes one choice"):
        as_(api, w, w.lead, "select pulse.chat_poll_vote(%s,%s)", (mid, [0, 1]))
    with pytest.raises(Exception, match="choose one of the poll"):
        as_(api, w, w.lead, "select pulse.chat_poll_vote(%s,%s)", (mid, [5]))
    assert _votes(api, w, w.editor2, mid) == sorted([(1, str(w.editor)), (1, str(w.lead))])
    # Outside the group: no vote, nothing to read.
    with pytest.raises(Exception, match="message unavailable"):
        as_(api, w, w.outsider, "select pulse.chat_poll_vote(%s,%s)", (mid, [0]))
    assert _votes(api, w, w.outsider, mid) == []
    # Only the person who asked (or a group admin) closes it; then no more votes, and a line says so.
    with pytest.raises(Exception, match="only the person who asked"):
        as_(api, w, w.editor, "select pulse.chat_poll_close(%s)", (mid,))
    as_(api, w, w.editor2, "select pulse.chat_poll_close(%s)", (mid,))
    with pytest.raises(Exception, match="this poll is closed"):
        as_(api, w, w.lead, "select pulse.chat_poll_vote(%s,%s)", (mid, []))
    line = one(api, w, w.editor, "select body,attachments from pulse.chat_message where channel_id=%s and kind='event' order by created_at desc limit 1", (ch,))
    assert line["body"] == "closed the poll “Which cover?”" and line["attachments"][0]["poll"] == str(mid)


def test_a_multiple_choice_poll_and_taking_a_vote_back(api, team):  # noqa: F811
    w = team
    ch = _group(api, w)
    mid = one(api, w, w.editor2, "select pulse.chat_poll_create(%s,%s,%s,true,%s) id", (ch, "Which days work?", ["Mon", "Tue", "Wed"], str(uuid.uuid4())))["id"]
    as_(api, w, w.editor, "select pulse.chat_poll_vote(%s,%s)", (mid, [0, 2, 2]))
    assert _votes(api, w, w.editor, mid) == [(0, str(w.editor)), (2, str(w.editor))]
    as_(api, w, w.editor, "select pulse.chat_poll_vote(%s,%s)", (mid, []))
    assert _votes(api, w, w.editor, mid) == []
