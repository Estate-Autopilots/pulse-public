"""WA-AUDIO on real PostgreSQL (1112): a transcript review set is open to admins, leadership and the assignee of the
set's task, and to no one else; a reviewer hears only the set's clips (whatever chat they come from), saves what was
said (again replaces it) and sees how many others checked a clip; Ctrl+K finds imported voice notes by their
transcript for the chats the viewer reads. Every group, name, number and file here is synthetic."""

import json
import uuid

import pytest
from pulse_sdk.db import set_tenant
from test_wa_import import begin, load, msg, put_file, world

SET = "gold-test"


def read(api, w, viewer, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute(sql, args).fetchall()


def one(api, w, viewer, sql, args=()):
    return read(api, w, viewer, sql, args)[0]["r"]


def save(api, w, viewer, sha, body):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute("select pulse.wa_review_save(%s,%s,%s::jsonb) r", (SET, sha, json.dumps(body))).fetchone()["r"]


def seed(worker, owner, api):
    w, people = world(worker, owner, api)
    b = begin(owner, w, members=[w.editor], participants=people)
    voice, _ = put_file(owner, w, b"OggS synthetic review opus", mime="audio/ogg", kind="voice", meta={"seconds": 4.0})
    m1 = msg(1, "", kind="media", file=voice, fileName="PTT-1.opus", fileState="attached", mediaType="voice")
    load(owner, w, b["batchId"], [m1])
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("""insert into pulse_priv.wa_transcript (org_id, sha256, language, text, segments, model)
                         values (pulse.current_org(), %s, 'hi', 'Synthetic budget pachas hazaar for the Lakeview launch', '[]', 'synthetic')""", (voice,))
        owner.execute("""insert into pulse_priv.wa_transcript_review_item (org_id, set_key, sha256, position, label, kind, duration_s, draft, draft_source, alternatives)
                         values (pulse.current_org(), %s, %s, 0, 'g001', 'voice', 4.0, 'synthetic draft', 'vote of 3 engines', '[{"label": "A", "text": "synthetic other"}]')""",
                      (SET, voice))
    return w, b, voice


def test_review_set_is_for_admins_leadership_and_the_assignee(worker, owner, api):
    w, b, voice = seed(worker, owner, api)

    # A chat member who is neither leadership nor the assignee: no set, no clip, no audio, no saving.
    assert one(api, w, w.editor, "select pulse.wa_review_sets() r") == []
    assert one(api, w, w.editor, "select pulse.wa_review_items(%s) r", (SET,)) is None
    assert one(api, w, w.editor, "select pulse.wa_review_file(%s,%s) r", (SET, voice)) is None
    assert read(api, w, w.editor, "select * from pulse.wa_review_file_parts(%s,%s,0,0)", (SET, voice)) == []
    with pytest.raises(Exception, match="not available to you"):
        save(api, w, w.editor, voice, {"text": "x", "status": "done"})

    # Leadership reviews: the draft and versions, saving (again replaces), progress.
    items = one(api, w, w.lead, "select pulse.wa_review_items(%s) r", (SET,))
    assert [i["label"] for i in items] == ["g001"] and items[0]["draft"] == "synthetic draft" and items[0]["mine"] is None
    assert items[0]["alternatives"][0]["text"] == "synthetic other"
    assert save(api, w, w.lead, voice, {"text": "first try", "status": "done", "languages": ["hi", "en", "xx"], "speakers": 1, "audio": "clear", "seconds": 30})["ok"]
    save(api, w, w.lead, voice, {"text": "synthetic budget 50000", "status": "done", "languages": ["hi", "en"], "speakers": 1, "audio": "noisy", "seconds": 20})
    mine = one(api, w, w.lead, "select pulse.wa_review_items(%s) r", (SET,))[0]["mine"]
    assert mine["text"] == "synthetic budget 50000" and sorted(mine["languages"]) == ["en", "hi"] and mine["audio"] == "noisy" and mine["status"] == "done"
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select seconds from pulse_priv.wa_transcript_review where sha256=%s", (voice,)).fetchone()["seconds"] == 50
    sets = one(api, w, w.lead, "select pulse.wa_review_sets() r")
    assert sets == [{"set": SET, "clips": 1, "seconds": 4, "mine": 1, "reviewed": 1}]
    with pytest.raises(Exception, match="done or skipped"):
        save(api, w, w.lead, voice, {"text": "x", "status": "maybe"})
    with pytest.raises(Exception, match="not in the set"):
        save(api, w, w.lead, "0" * 64, {"text": "x", "status": "done"})

    # HR, not in the chat: nothing, until the set's task is assigned to them; then the clip plays and they review.
    assert one(api, w, w.editor2, "select pulse.wa_review_sets() r") == []
    task = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.task(id,org_id,title,assignee_person_id,status,source_key) values(%s,%s,'Check voice-note transcripts',%s,'open',%s)",
                       (task, w.org, w.editor2, f"wa-transcript-review:{SET}"))
    meta = one(api, w, w.editor2, "select pulse.wa_review_file(%s,%s) r", (SET, voice))
    assert meta["mime"] == "audio/ogg" and meta["size"] == len(b"OggS synthetic review opus")
    parts = read(api, w, w.editor2, "select * from pulse.wa_review_file_parts(%s,%s,0,0)", (SET, voice))
    assert b"".join(bytes(p["data"]) for p in parts) == b"OggS synthetic review opus"
    assert one(api, w, w.editor2, "select pulse.wa_review_items(%s) r", (SET,))[0]["others"] == 1
    save(api, w, w.editor2, voice, {"text": "", "status": "skipped", "audio": "no_speech", "speakers": None, "seconds": "bad"})
    with owner.transaction():
        set_tenant(owner, w.org)
        r = owner.execute("select speakers, seconds from pulse_priv.wa_transcript_review where sha256=%s and reviewer=%s", (voice, w.editor2)).fetchone()
        assert r["speakers"] is None and r["seconds"] == 0
    assert one(api, w, w.lead, "select pulse.wa_review_items(%s) r", (SET,))[0]["others"] == 0      # a skip is not a check
    # The review does not open the chat: the file's own route stays closed to them.
    assert one(api, w, w.editor2, "select pulse.wa_file_open(%s) r", (voice,)) is None
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.task set status='cancelled' where id=%s", (task,))
    assert one(api, w, w.editor2, "select pulse.wa_review_sets() r") == []

    # The tables are closed to the runtime roles.
    for role in (api, worker):
        with role.transaction():
            set_tenant(role, w.org, w.manager)
            role.execute("savepoint s")
            with pytest.raises(Exception, match="permission denied"):
                role.execute("select count(*) from pulse_priv.wa_transcript_review")
            role.execute("rollback to savepoint s")


def test_voice_notes_found_by_transcript_for_chat_readers(worker, owner, api):
    w, b, voice = seed(worker, owner, api)
    hits = read(api, w, w.editor, "select * from pulse.wa_transcript_search(%s, 8)", (["lakeview", "budget"],))
    native = read(api, w, w.editor, "select id from pulse.chat_message where channel_id=%s and attachments->0->>'wa'=%s", (b["channelId"], voice))[0]["id"]
    assert [h["message_id"] for h in hits] == [native] and "budget" in hits[0]["snippet"].lower() and hits[0]["language"] == "hi"
    assert read(api, w, w.editor, "select * from pulse.wa_transcript_search(%s, 8)", (["lakeview", "nothing-like-this"],)) == []
    assert read(api, w, w.editor2, "select * from pulse.wa_transcript_search(%s, 8)", (["lakeview"],)) == []
