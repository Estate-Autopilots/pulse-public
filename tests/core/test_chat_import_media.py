"""CHAT-VOICE-FIX part 3 (migration 2136): a WhatsApp export "with media" brings its photos, voice notes and files beside
the imported messages. Same rules as R47's text: an admin who is a member imports, the conversation's current members
read, nobody else (not a role, not the worker); the same file again is kept once; a withdrawn import hides its files;
a file only joins a media message of a live import in that conversation. Synthetic messages and bytes only."""
import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_chat_history_import import message, run_import, world
from test_tasks_rt1 import team  # noqa: F401  (team is a fixture)

JPEG = b"\xff\xd8\xff\xe0synthetic-photo"


def add(api, w, viewer, channel, key, name="IMG-20261012-WA0001.jpg", mime="image/jpeg", data=JPEG):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute("select pulse.chat_import_file_add(%s,%s,%s,%s,%s) id", (channel, key, name, mime, data)).fetchone()["id"]


def files(api, w, viewer, channel):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        ids = [r["id"] for r in api.execute("select id from pulse.chat_history(%s)", (channel,)).fetchall()]
        return api.execute("select message_id,name,mime,size from pulse.chat_history_files(%s,%s)", (channel, ids)).fetchall()


def read(api, w, viewer, fid):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute("select name,mime,bytes from pulse.chat_history_file_read(%s,false)", (fid,)).fetchone()


def test_imported_media_sits_beside_its_message_for_members_only(worker, owner, api):
    w, group = world(worker, owner, api)
    photo, voice = message(2, "", w.manager, "Pod Manager", "media", 1), message(3, "on my way", w.editor, kind="media", minute=2)
    run_import(api, w, w.manager, group, "c" * 64, [message(1, "Synthetic call sheet", w.editor), photo, voice])
    fid = add(api, w, w.manager, group, photo["key"])
    vid = add(api, w, w.manager, group, voice["key"], "PTT-20261012-WA0002.opus", "audio/ogg", b"OggS synthetic")
    # The same file for the same message again is kept once.
    assert add(api, w, w.manager, group, photo["key"]) == fid
    listed = files(api, w, w.editor, group)
    assert sorted((r["name"], r["mime"]) for r in listed) == [("IMG-20261012-WA0001.jpg", "image/jpeg"), ("PTT-20261012-WA0002.opus", "audio/ogg")]
    assert bytes(read(api, w, w.editor, fid)["bytes"]) == JPEG and read(api, w, w.editor, vid)["mime"] == "audio/ogg"
    # Not a member: nothing, whatever the role (HR is Editor Two, leadership is the Project Lead in this world).
    for outsider in (w.editor2, w.lead):
        assert read(api, w, outsider, fid) is None and files(api, w, outsider, group) == []
    # The worker never reads imported history or its files.
    with pytest.raises(psycopg.errors.InsufficientPrivilege), worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("select count(*) from pulse_priv.chat_import_file")


def test_only_an_importer_adds_files_and_only_to_a_media_message_of_a_live_import(worker, owner, api):
    w, group = world(worker, owner, api)
    text, photo = message(1, "Synthetic call sheet", w.editor), message(2, "", w.manager, "Pod Manager", "media", 1)
    result = run_import(api, w, w.manager, group, "d" * 64, [text, photo])
    # A member who is not an admin cannot add; nor can anything join a text message or a key of no message.
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        add(api, w, w.editor, group, photo["key"])
    for key in (text["key"], "e" * 64):
        with pytest.raises(psycopg.errors.InvalidParameterValue):
            add(api, w, w.manager, group, key)
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        add(api, w, w.manager, group, photo["key"], name="../escape.jpg")
    fid = add(api, w, w.manager, group, photo["key"])
    # A withdrawn import hides its files too (nothing is deleted).
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.chat_import_withdraw(%s,'synthetic withdrawal')", (result["id"],))
    assert read(api, w, w.editor, fid) is None and files(api, w, w.editor, group) == []
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        add(api, w, w.manager, group, photo["key"], name="IMG-2.jpg")
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse_priv.chat_import_file where id=%s", (fid,)).fetchone()["n"] == 1
