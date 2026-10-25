"""CHAT-V4: a conversation marked unread (mine only, cleared again), and the earlier words of an edited message (kept for
the conversation's members, gone with a deleted message). Synthetic tenants only."""
import uuid

import pytest
from test_tasks_rt1 import as_, one, team  # noqa: F401  (team is a fixture)


def _group(api, w, name="V4 desk"):
    return one(api, w, w.editor2, "select pulse.chat_group_create(%s,%s) id", (name, [w.editor]))["id"]


def _send(api, w, who, channel, body):
    return one(api, w, who, "select pulse.chat_send(%s,%s,null,'[]'::jsonb,%s,null) id", (channel, body, str(uuid.uuid4())))["id"]


def _marked(api, w, who, channel):
    return one(api, w, who, "select marked_unread_at is not null m from pulse.chat_member where channel_id=%s and person_id=%s", (channel, who))["m"]


def test_marking_a_chat_unread_is_mine_and_clears(api, team):  # noqa: F811
    w = team
    ch = _group(api, w)
    _send(api, w, w.editor2, ch, "the cover is ready")
    as_(api, w, w.editor, "select pulse.chat_mark_unread(%s,true)", (ch,))
    assert _marked(api, w, w.editor, ch)
    assert not _marked(api, w, w.editor2, ch)
    # Clearing twice is quiet (opening and reading both clear it).
    as_(api, w, w.editor, "select pulse.chat_mark_unread(%s,false)", (ch,))
    as_(api, w, w.editor, "select pulse.chat_mark_unread(%s,false)", (ch,))
    assert not _marked(api, w, w.editor, ch)
    with pytest.raises(Exception, match="conversation unavailable"):
        as_(api, w, w.editor, "select pulse.chat_mark_unread(%s,true)", (str(uuid.uuid4()),))


def test_an_edit_keeps_the_earlier_words_until_the_message_is_deleted(api, team):  # noqa: F811
    w = team
    ch = _group(api, w)
    mid = _send(api, w, w.editor2, ch, "logo 10% bigger")
    as_(api, w, w.editor2, "select pulse.chat_edit(%s,%s)", (mid, "logo 20% bigger"))
    as_(api, w, w.editor2, "select pulse.chat_edit(%s,%s)", (mid, "logo 20% bigger, tagline under it"))
    rows = as_(api, w, w.editor, "select body from pulse.chat_message_revision where message_id=%s order by replaced_at", (mid,))
    assert [r["body"] for r in rows] == ["logo 10% bigger", "logo 20% bigger"]
    as_(api, w, w.editor2, "select pulse.chat_remove(%s,%s)", (mid, "Removed in Chats"))
    assert one(api, w, w.editor, "select count(*)::int n from pulse.chat_message_revision where message_id=%s", (mid,))["n"] == 0
