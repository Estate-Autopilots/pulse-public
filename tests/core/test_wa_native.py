"""WA-NATIVE on real PostgreSQL: an imported WhatsApp group's history becomes ordinary messages of its Pulse chat
(1051). Original time and author are kept, senders Pulse has no person for are guests of the chat, "@Name" and
"@<number>" become Pulse mentions, nothing imported notifies or counts as unread, the sync is idempotent and undoable,
withdrawn batches leave the chat, chat retention never prunes imported history, and the read rules stay: members only,
a client-side person only once opted in. Every group, name, number and file here is synthetic."""

import json
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_wa_import import begin, load, msg, put_file, world


def sync(owner, w, chat):
    with owner.transaction():
        set_tenant(owner, w.org)
        return owner.execute("select pulse.wa_native_sync(%s) r", (chat,)).fetchone()["r"]


def native(api, w, viewer, channel):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute("""select m.id, m.body, m.kind, m.author_id, m.mentions, m.attachments, m.removed_at, m.edited_at, m.created_at,
                                     m.import_ref, g.label guest
                                from pulse.chat_message m left join pulse.chat_guest g on g.id = m.guest_id
                               where m.channel_id = %s order by m.created_at""", (channel,)).fetchall()


def test_history_becomes_the_chat_with_authors_guests_and_mentions(worker, owner, api):
    w, people = world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        poc = owner.execute("select pulse.wa_import_person(%s) id", (json.dumps({"key": "s-client1", "kind": "client", "name": "Client Contact",
                            "clientId": str(w.client), "phone": "+919000000456", "basis": "synthetic"}),)).fetchone()["id"]
    people[1]["person"] = str(poc)
    people[2]["label"] = "Number ending 0123"
    with worker.transaction():
        set_tenant(worker, w.org)
        notes0 = worker.execute("select count(*) n from pulse.notification").fetchone()["n"]
    b = begin(owner, w, members=[w.editor, w.manager], participants=people)
    photo, _ = put_file(owner, w, b"\xff\xd8synthetic native jpeg")
    voice, _ = put_file(owner, w, b"synthetic native opus", mime="audio/ogg", kind="voice", meta={"seconds": 3.2, "peaks": [10, 40, 90, 30]})
    msgs = [msg(1, "Hi @Editor One, brochure attached. @everyone please check"),
            msg(2, "@+91 90000 00456 can you share the cost sheet? cc @+91 90000 00123", sender="s-editor1"),
            msg(3, "Sure @Editor, sending now", sender="s-client1"),
            msg(4, "", kind="media", file=photo, fileName="IMG-1.jpg", fileState="attached", mediaType="image", sender="s-client1"),
            msg(5, "", kind="media", file=voice, fileName="PTT-1.opus", fileState="attached", mediaType="voice", sender="s-number1"),
            msg(6, "", kind="media", fileState="omitted", mediaType="video", sender="s-number1"),
            msg(7, "This message was deleted", kind="deleted", sender="s-number1"),
            msg(8, "Messages and calls are end-to-end encrypted.", kind="system", subtype="encryption", sender=None),
            msg(9, "Editor One added Client Contact", kind="system", subtype="added", sender=None),
            msg(10, "Write to me at someone@example.com", edited=True)]
    msgs[1]["at"] = msgs[0]["at"]  # same minute: the order of the export survives
    load(owner, w, b["batchId"], msgs)   # finishing the load syncs the chat
    rows = native(api, w, w.editor, b["channelId"])
    assert len(rows) == 9                 # the encryption notice is left out
    assert [r["created_at"] for r in rows] == sorted(r["created_at"] for r in rows) and rows[0]["body"].startswith("Hi @editor.one")
    assert rows[0]["mentions"] == [w.editor] and "@everyone" in rows[0]["body"]
    assert rows[1]["author_id"] == w.editor and rows[1]["body"].startswith("@Client Contact can you") and "@Number ending 0123" in rows[1]["body"]
    assert rows[1]["mentions"] == [poc]
    assert rows[2]["author_id"] == poc and rows[2]["body"] == "Sure @editor.one, sending now" and rows[2]["mentions"] == [w.editor]
    att = rows[3]["attachments"][0]
    assert att["id"] == "wa-" + photo and att["mime"] == "image/jpeg" and att["name"] == "IMG-1.jpg"
    assert rows[4]["guest"] == "Number ending 0123" and rows[4]["attachments"][0]["voice"]["peaks"] == [10, 40, 90, 30]
    assert rows[5]["attachments"] == [{"omitted": "video"}]
    assert rows[6]["removed_at"] is not None and rows[6]["body"] == ""
    assert rows[7]["kind"] == "event" and rows[7]["body"] == "Editor One added Client Contact"
    assert rows[8]["edited_at"] is not None and rows[8]["mentions"] == [] and "someone@example.com" in rows[8]["body"]
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.notification").fetchone()["n"] == notes0       # nobody is told
        assert worker.execute("select count(*) n from pulse.chat_message where channel_id=%s and broadcast is not null", (b["channelId"],)).fetchone()["n"] == 0
        reads = worker.execute("select read_through from pulse.chat_member where channel_id=%s", (b["channelId"],)).fetchall()
        assert all(r["read_through"] >= rows[-1]["created_at"] for r in reads)                              # nothing unread
        assert worker.execute("select count(*) n from pulse.chat_member where channel_id=%s and role='admin'", (b["channelId"],)).fetchone()["n"] == 1
    # Idempotent; the status counts; Pulse messages continue the same chat.
    again = sync(owner, w, b["chatId"])
    assert again["added"] == 0 and again["messages"] == 9 and again["skipped"] == 1 and again["guests"] == 1
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        st = api.execute("select pulse.wa_native_status() r").fetchone()["r"]
        assert st["native"] == 1 and st["messages"] == 9 and st["mentionsFound"] >= 5 and st["mentionsPeople"] == 3 and st["mentionsGuests"] == 1
        mark = api.execute("select pulse.wa_native_channel(%s) r", (b["channelId"],)).fetchone()["r"]
        assert mark["native"] and mark["nativeMessages"] == 9 and mark["guests"] == 1
    with api.transaction():
        set_tenant(api, w.org, w.editor)   # the groups hub counts imported messages once, never as unread; files are real files
        hub = api.execute("select messages, unread, files, imported, waiting_since from pulse.chat_group_hub() where id=%s", (b["channelId"],)).fetchone()
        assert (hub["messages"], hub["unread"], hub["files"], hub["imported"]) == (10, 0, 2, 10)
        live = api.execute("select pulse.chat_send(%s,'Live in Pulse',null,'[]',%s) id", (b["channelId"], uuid.uuid4())).fetchone()["id"]
        assert api.execute("select messages from pulse.chat_group_hub() where id=%s", (b["channelId"],)).fetchone()["messages"] == 11
        api.execute("select pulse.chat_react(%s,'👍')", (rows[2]["id"],))
        people_of = api.execute("select pulse.wa_native_people(%s) r", (b["channelId"],)).fetchone()["r"]
        assert {p["kind"] for p in people_of} == {"colleague", "client", "number"} and not next(p for p in people_of if p["kind"] == "client")["member"]
        assert api.execute("select count(*) n from pulse.wa_native_voice(%s)", (b["channelId"],)).fetchone()["n"] == 0
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.notification where message_id=%s", (live,)).fetchone()["n"] == 1   # the live one tells the other member


def test_read_rules_retention_mapping_withdraw_and_undo(worker, owner, api):
    w, people = world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        poc = owner.execute("select pulse.wa_import_person(%s) id", (json.dumps({"key": "s-client1", "kind": "client", "name": "Client Contact",
                            "clientId": str(w.client), "basis": "synthetic"}),)).fetchone()["id"]
    people[1]["person"] = str(poc)
    b = begin(owner, w, members=[w.editor], participants=people)
    old = msg(1, "Synthetic line from long ago")
    old["at"], old["local"] = "2024-02-10T05:00:00Z", "2024-02-10T10:30"
    load(owner, w, b["batchId"], [old, msg(2, "Synthetic recent line", sender="s-number1")])
    assert len(native(api, w, w.editor, b["channelId"])) == 2
    with api.transaction():
        set_tenant(api, w.org, w.editor)    # a guest who wrote last (recently) is who the hub says waits on us
        assert api.execute("select waiting_who from pulse.chat_group_hub() where id=%s", (b["channelId"],)).fetchone()["waiting_who"] == "Number ending 123 (WhatsApp)"
    # A client-side member reads imported messages only once opted in; their own live chat stays readable.
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, b["channelId"], poc))
        joined = worker.execute("select read_through from pulse.chat_member where channel_id=%s and person_id=%s", (b["channelId"], poc)).fetchone()["read_through"]
        assert joined.year == 2026   # joins after the imported history
    assert native(api, w, poc, b["channelId"]) == []
    with api.transaction():
        set_tenant(api, w.org, poc)
        assert not api.execute("select pulse.chat_import_reads() ok").fetchone()["ok"]   # pending
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.client_optin_set(%s,'opted_in','Synthetic: said yes')", (poc,))
    # (a client reads chats through CONNECT seats; here the row rule itself is checked)
    with api.transaction():
        set_tenant(api, w.org, poc)
        assert api.execute("select pulse.chat_import_reads() ok").fetchone()["ok"]
    with api.transaction():
        set_tenant(api, w.org, w.editor2)   # HR, not a member: nothing
        assert api.execute("select count(*) n from pulse.chat_message where channel_id=%s", (b["channelId"],)).fetchone()["n"] == 0
        assert api.execute("select pulse.wa_native_channel(%s) r", (b["channelId"],)).fetchone()["r"] is None
    # Retention keeps imported history (a year and more old).
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("select pulse.chat_prune()")
        assert worker.execute("select count(*) n from pulse.chat_message where channel_id=%s", (b["channelId"],)).fetchone()["n"] == 2
    # A guest mapped to a person later ("Who is this?") takes their messages over at once (1058); un-mapping gives them
    # back to the guest; a sync then finds nothing to move.
    remap = "update pulse_priv.wa_participant set person_id=%s where chat_id=%s and source_key='s-number1'"
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute(remap, (w.editor2, b["chatId"]))
    assert {r["author_id"] for r in native(api, w, w.editor, b["channelId"])} == {w.editor, w.editor2}
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute(remap, (None, b["chatId"]))
    assert [r["guest"] for r in native(api, w, w.editor, b["channelId"])] == [None, "Number ending 123"]
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute(remap, (w.editor2, b["chatId"]))
    assert sync(owner, w, b["chatId"])["moved"] == 0
    assert {r["author_id"] for r in native(api, w, w.editor, b["channelId"])} == {w.editor, w.editor2}
    # A withdrawn batch leaves the chat; undo takes the rest out; a new sync brings it back.
    b2 = begin(owner, w, bundle="d" * 64, participants=people)
    load(owner, w, b2["batchId"], [msg(3, "Synthetic line of a wrong export")])
    assert len(native(api, w, w.editor, b["channelId"])) == 3
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.wa_import_withdraw(%s,'Synthetic: wrong export')", (b2["batchId"],))
    assert len(native(api, w, w.editor, b["channelId"])) == 2
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select pulse.wa_native_undo(%s) r", (b["chatId"],)).fetchone()["r"]["removed"] == 2
    assert native(api, w, w.editor, b["channelId"]) == []
    assert sync(owner, w, b["chatId"])["added"] == 2
    for conn in (api,):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with conn.transaction():
                set_tenant(conn, w.org, w.manager)
                conn.execute("select pulse.wa_native_sync(%s)", (b["chatId"],))
