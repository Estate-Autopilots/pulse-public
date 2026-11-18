"""CHAT-V3: mute, archive, pinned and saved messages, forwarding (files copied into the other chat), comments on a point of
a picture, and approvals answered in the chat. Synthetic tenants only."""
import base64
import uuid

import pytest
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def _group(api, w, name="V3 desk"):
    return one(api, w, w.editor2, "select pulse.chat_group_create(%s,%s) id", (name, [w.editor]))["id"]


def _send(api, w, who, channel, body, attachments="[]", quote=None, parent=None):
    return one(api, w, who, "select pulse.chat_send(%s,%s,%s,%s::jsonb,%s,%s) id", (channel, body, parent, attachments, str(uuid.uuid4()), quote))["id"]


def _picture(api, w, who, channel):
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
    fid = one(api, w, who, "select pulse.chat_file_add(%s,'cover.png','image/png',%s) id", (channel, png))["id"]
    mid = _send(api, w, who, channel, "", f'[{{"id":"{fid}","name":"cover.png","mime":"image/png"}}]')
    return mid, str(fid)


def _bell(api, w, who, channel):
    return one(api, w, who, "select count(*)::int n from pulse.notification where person_id=%s and channel_id=%s", (who, channel))["n"]


def test_a_muted_chat_rings_only_for_replies_to_you(api, team):  # noqa: F811
    w = team
    ch = _group(api, w)
    mine = _send(api, w, w.editor, ch, "my draft")
    as_(api, w, w.editor, "select pulse.chat_mute(%s,'infinity')", (ch,))
    _send(api, w, w.editor2, ch, "an ordinary message")
    assert _bell(api, w, w.editor, ch) == 0
    _send(api, w, w.editor2, ch, "about your draft", quote=mine)
    assert _bell(api, w, w.editor, ch) == 1
    as_(api, w, w.editor, "select pulse.chat_mute(%s,null)", (ch,))
    _send(api, w, w.editor2, ch, "unmuted again")
    assert _bell(api, w, w.editor, ch) == 2
    as_(api, w, w.editor, "select pulse.chat_archive(%s,true)", (ch,))
    assert one(api, w, w.editor, "select archived_at is not null a from pulse.chat_member where channel_id=%s and person_id=%s", (ch, w.editor))["a"]


def test_three_pinned_messages_and_saved_messages_stay_private(api, team):  # noqa: F811
    w = team
    ch = _group(api, w)
    ids = [_send(api, w, w.editor2, ch, f"brief {i}") for i in range(4)]
    for m in ids[:3]:
        as_(api, w, w.editor, "select pulse.chat_pin_message(%s,true)", (m,))
    with pytest.raises(Exception, match="up to 3 messages"):
        as_(api, w, w.editor, "select pulse.chat_pin_message(%s,true)", (ids[3],))
    lines = as_(api, w, w.editor2, "select body from pulse.chat_message where channel_id=%s and kind='event'", (ch,))
    assert [r["body"] for r in lines].count("pinned a message") == 3
    as_(api, w, w.editor2, "select pulse.chat_star_set(%s,true)", (ids[0],))
    assert one(api, w, w.editor2, "select count(*)::int n from pulse.chat_star", ())["n"] == 1
    assert one(api, w, w.editor, "select count(*)::int n from pulse.chat_star", ())["n"] == 0


def test_forwarding_copies_the_file_into_the_other_chat(api, team):  # noqa: F811
    w = team
    a, b = _group(api, w, "Source"), _group(api, w, "Target")
    mid, fid = _picture(api, w, w.editor2, a)
    sent = one(api, w, w.editor2, "select pulse.chat_forward(%s,%s) ids", (mid, [b]))["ids"]
    row = one(api, w, w.editor2, "select channel_id,forwarded,attachments from pulse.chat_message where id=%s", (sent[0],))
    assert str(row["channel_id"]) == str(b) and row["forwarded"] is True
    assert row["attachments"][0]["id"] != fid
    assert one(api, w, w.editor2, "select count(*)::int n from pulse.chat_file_read(%s)", (row["attachments"][0]["id"],))["n"] == 1


def test_a_comment_on_a_picture_and_an_approval_round(api, team):  # noqa: F811
    w = team
    ch = _group(api, w)
    mid, fid = _picture(api, w, w.editor2, ch)
    reply = one(api, w, w.editor, "select pulse.chat_annotate(%s,%s,0.25,0.75,'make the logo bigger',%s) id", (mid, fid, str(uuid.uuid4())))["id"]
    row = one(api, w, w.editor2, "select m.parent_id,a.x,a.y from pulse.chat_message m join pulse.chat_annotation a on a.message_id=m.id where m.id=%s", (reply,))
    assert str(row["parent_id"]) == str(mid) and abs(row["x"] - 0.25) < 1e-6
    as_(api, w, w.editor2, "select pulse.chat_approval_ask(%s)", (mid,))
    with pytest.raises(Exception, match="someone else approves"):
        as_(api, w, w.editor2, "select pulse.chat_approval_decide(%s,'approved',null)", (mid,))
    with pytest.raises(Exception, match="say what to change"):
        as_(api, w, w.editor, "select pulse.chat_approval_decide(%s,'changes','')", (mid,))
    as_(api, w, w.editor, "select pulse.chat_approval_decide(%s,'changes','bigger logo')", (mid,))
    state = one(api, w, w.editor2, "select state,rounds,note from pulse.chat_approval where message_id=%s", (mid,))
    assert (state["state"], state["rounds"], state["note"]) == ("changes", 1, "bigger logo")
    as_(api, w, w.editor2, "select pulse.chat_approval_ask(%s)", (mid,))
    as_(api, w, w.editor, "select pulse.chat_approval_decide(%s,'approved',null)", (mid,))
    assert one(api, w, w.editor2, "select state,rounds from pulse.chat_approval where message_id=%s", (mid,)) == {"state": "approved", "rounds": 1}
