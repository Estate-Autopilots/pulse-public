"""WA-IMPORT on real PostgreSQL: WhatsApp groups loaded from an import bundle become Pulse chats with their whole
history and media. Loading is idempotent (the same bundle adds nothing; an overlapping export adds only new messages),
a file counts only once the SHA-256 of its parts matches, the history is read by the chat's active staff members and
admins only (a client-side person only when a member and opted in), never by a runtime role directly, and a withdrawn
batch is hidden, not deleted. Every group, name, number and file here is synthetic."""

import hashlib
import json
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_chats import setup
from test_tasks_rt1 import team  # noqa: F401  (team is a fixture)

PART = 1048576


def key(*parts):
    return hashlib.sha256("\n".join(map(str, parts)).encode()).hexdigest()


def begin(owner, w, source="grp-synthetic-1", bundle="b" * 64, members=(), participants=(), **extra):
    payload = {"sourceKey": source, "title": "Synthetic Tower · Pune · Oct 2026", "titles": [], "clientId": None,
               "projectId": str(w.project), "timeZone": "Asia/Kolkata", "bundleSha256": bundle, "tool": "wa-import/1",
               "approvalRef": "Synthetic owner go", "runBy": "test", "source": {"exports": 1},
               "members": [str(m) for m in members], "participants": list(participants), **extra}
    with owner.transaction():
        set_tenant(owner, w.org)
        return owner.execute("select pulse.wa_import_begin(%s) r", (json.dumps(payload),)).fetchone()["r"]


def put_file(owner, w, data, mime="image/jpeg", kind="image", meta=None, corrupt=False):
    sha = hashlib.sha256(data).hexdigest()
    parts = [data[i:i + PART] for i in range(0, len(data), PART)] or [b""]
    with owner.transaction():
        set_tenant(owner, w.org)
        done = owner.execute("select pulse.wa_import_file(%s,%s,%s,%s,%s,%s) ok",
                             (sha, len(data), mime, kind, json.dumps(meta or {}), len(parts))).fetchone()["ok"]
        if not done:
            for i, p in enumerate(parts):
                owner.execute("select pulse.wa_import_file_part(%s,%s,%s)", (sha, i, (b"x" + p[1:]) if corrupt and i == 0 else p))
        sealed = owner.execute("select pulse.wa_import_file_seal(%s) ok", (sha,)).fetchone()["ok"]
    return sha, sealed


def msg(n, body, sender="s-editor1", kind="text", **extra):
    return {"key": key("synthetic", n, body), "seq": n, "at": f"2026-10-12T03:{30 + n:02d}:00Z", "local": f"2026-10-12T09:{n:02d}",
            "sender": sender, "kind": kind, "body": body, **extra}


def load(owner, w, batch, messages, stats=None):
    with owner.transaction():
        set_tenant(owner, w.org)
        r = owner.execute("select pulse.wa_import_messages(%s,%s) r", (batch, json.dumps(messages))).fetchone()["r"]
        f = owner.execute("select pulse.wa_import_finish(%s,%s) r", (batch, json.dumps(stats or {}))).fetchone()["r"]
    return r, f


def page(api, w, viewer, chat, **kw):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute("select pulse.wa_messages(%s,%s,%s,%s,%s) r",
                           (chat, kw.get("before"), kw.get("after"), kw.get("around"), kw.get("limit", 80))).fetchone()["r"]


def world(worker, owner, api):
    w = setup(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        for pid, role in ((w.editor2, "hr"), (w.lead, "leadership")):
            worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,%s,'2020-01-01')", (w.org, pid, role))
        w.client = uuid.uuid4()
        worker.execute("insert into pulse.client(id,org_id,display_name) values(%s,%s,'Synthetic Developers')", (w.client, w.org))
    people = [{"key": "s-editor1", "label": "Editor One", "kind": "colleague", "person": str(w.editor)},
              {"key": "s-client1", "label": "Client Contact", "kind": "client", "person": None},
              {"key": "s-number1", "label": "Number ending 123", "raw": "+91 90000 00123", "kind": "number", "person": None}]
    return w, people


def test_load_is_idempotent_and_overlaps_add_only_new(worker, owner, api):
    w, people = world(worker, owner, api)
    with worker.transaction():
        set_tenant(worker, w.org)
        before = {t: worker.execute(f"select count(*) n from pulse.{t}").fetchone()["n"] for t in ("notification", "chat_message")}
    b = begin(owner, w, members=[w.editor, w.manager], participants=people)
    assert not b["done"] and set(b["participants"]) == {"s-editor1", "s-client1", "s-number1"}
    photo, ok = put_file(owner, w, b"\xff\xd8synthetic jpeg bytes")
    assert ok
    first = [msg(1, "Synthetic brief\nline two"), msg(2, "", kind="media", file=photo, fileName="IMG-1.jpg", fileState="attached", mediaType="image"),
             msg(3, "", kind="media", fileState="omitted", mediaType="unknown", sender="s-client1"),
             msg(4, "This message was deleted", kind="deleted", sender="s-number1"),
             msg(5, "Editor One added Client Contact", kind="system", subtype="added", sender=None)]
    r, f = load(owner, w, b["batchId"], first)
    assert (r["added"], r["duplicates"]) == (5, 0) and f["messages"] == 5
    assert f["kinds"] == {"text": 1, "media": 2, "deleted": 1, "system": 1}
    # The same bundle again: the batch is closed and recognised; nothing changes.
    again = begin(owner, w, members=[w.editor], participants=people)
    assert again["done"] and again["batchId"] == b["batchId"] and again["chatId"] == b["chatId"]
    # An overlapping export (a longer one): only the new message is added.
    b2 = begin(owner, w, bundle="c" * 64, participants=people)
    r2, f2 = load(owner, w, b2["batchId"], first + [msg(6, "Approved, go ahead", sender="s-client1")])
    assert (r2["added"], r2["duplicates"]) == (1, 5) and f2["messages"] == 6
    with worker.transaction():
        set_tenant(worker, w.org)
        after = {t: worker.execute(f"select count(*) n from pulse.{t}").fetchone()["n"] for t in ("notification", "chat_message")}
        assert after == before  # no notification, no live chat message
        ch = worker.execute("select kind,key,description from pulse.chat_channel where id=%s", (b["channelId"],)).fetchone()
        assert ch["kind"] == "custom" and ch["key"] == "wa:grp-synthetic-1" and ch["description"] == "Imported from WhatsApp"
        members = {r["person_id"] for r in worker.execute("select person_id from pulse.chat_member where channel_id=%s", (b["channelId"],))}
        assert members == {w.editor, w.manager}
    got = page(api, w, w.editor, b["chatId"])
    assert [m["body"] for m in got["messages"]] == ["Synthetic brief\nline two", "", "", "This message was deleted", "Editor One added Client Contact", "Approved, go ahead"]
    assert got["messages"][1]["file"]["sha256"] == photo and got["messages"][1]["file"]["complete"]
    assert got["messages"][2]["file"]["state"] == "omitted" and got["messages"][4]["participantId"] is None
    assert not got["older"] and not got["newer"]
    # Paging: the newest 2, then the 2 before them, then around the first.
    newest = page(api, w, w.editor, b["chatId"], limit=2)
    assert [m["seq"] for m in newest["messages"]] == [5, 6] and newest["older"] and not newest["newer"]
    older = page(api, w, w.editor, b["chatId"], before=newest["messages"][0]["id"], limit=2)
    assert [m["seq"] for m in older["messages"]] == [3, 4]
    later = page(api, w, w.editor, b["chatId"], after=older["messages"][-1]["id"], limit=2)
    assert [m["seq"] for m in later["messages"]] == [5, 6]
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        chat = api.execute("select pulse.wa_chat(%s) r", (b["chatId"],)).fetchone()["r"]
        assert chat["messages"] == 6 and {p["label"]: p["messages"] for p in chat["participants"]} == {"Editor One": 2, "Client Contact": 2, "Number ending 123": 1}
        assert len(chat["batches"]) == 2 and not chat["canWithdraw"]
        assert "label_raw" not in json.dumps(chat) and "+91" not in json.dumps(chat)
        assert api.execute("select pulse.wa_channel(%s) r", (b["channelId"],)).fetchone()["r"]["messages"] == 6
        mine = api.execute("select pulse.wa_chats(%s) r", (json.dumps({"person": str(w.editor)}),)).fetchone()["r"]
        assert mine["total"] == 1 and mine["chats"][0]["personMessages"] == 2 and mine["chats"][0]["projectId"] == str(w.project)
        assert api.execute("select pulse.wa_chats(%s) r", (json.dumps({"project": str(uuid.uuid4())}),)).fetchone()["r"]["total"] == 0
        assert [h["body"] for h in api.execute("select pulse.wa_search(%s,'approved') r", (b["chatId"],)).fetchone()["r"]] == ["Approved, go ahead"]


def test_files_must_match_their_sha256_and_messages_need_stored_files(worker, owner, api):
    w, people = world(worker, owner, api)
    b = begin(owner, w, members=[w.editor], participants=people)
    big = bytes(range(256)) * 9000  # 2.3 MB: three parts
    sha, ok = put_file(owner, w, big, mime="video/mp4", kind="video", meta={"seconds": 12})
    assert ok
    bad, ok_bad = put_file(owner, w, b"synthetic voice bytes", mime="audio/ogg", kind="voice", corrupt=True)
    assert not ok_bad
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        load(owner, w, b["batchId"], [msg(1, "", kind="media", file=bad, fileName="PTT-1.opus", fileState="attached", mediaType="voice")])
    load(owner, w, b["batchId"], [msg(1, "", kind="media", file=sha, fileName="VID-1.mp4", fileState="attached", mediaType="video")])
    # Declaring a stored file again sends nothing (complete), and its parts cannot be overwritten.
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select pulse.wa_import_file(%s,%s,'video/mp4','video','{}',3) ok", (sha, len(big))).fetchone()["ok"]
        owner.execute("select pulse.wa_import_file_part(%s,0,%s)", (sha, b"overwrite"))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        info = api.execute("select pulse.wa_file_open(%s) r", (sha,)).fetchone()["r"]
        assert info["size"] == len(big) and info["parts"] == 3 and info["name"] == "VID-1.mp4"
        data = b"".join(r["data"] for r in api.execute("select * from pulse.wa_file_parts(%s,0,10)", (sha,)))
        assert hashlib.sha256(data).hexdigest() == sha
        assert api.execute("select pulse.wa_file_open(%s) r", (bad,)).fetchone()["r"] is None
    with api.transaction():
        set_tenant(api, w.org, w.editor2)  # HR, not a member
        assert api.execute("select pulse.wa_file_open(%s) r", (sha,)).fetchone()["r"] is None
        assert api.execute("select count(*) n from pulse.wa_file_parts(%s,0,10)", (sha,)).fetchone()["n"] == 0


def test_readers_are_members_and_admins_never_roles_or_runtime(worker, owner, api, ingest, privacy):
    w, people = world(worker, owner, api)
    b = begin(owner, w, members=[w.editor], participants=people)
    load(owner, w, b["batchId"], [msg(1, "Synthetic member-only line")])
    assert len(page(api, w, w.editor, b["chatId"])["messages"]) == 1      # member
    assert len(page(api, w, w.manager, b["chatId"])["messages"]) == 1     # admin, not a member
    for outsider in (w.editor2, w.lead):                                  # HR and leadership by role: nothing
        assert page(api, w, outsider, b["chatId"]) is None
        with api.transaction():
            set_tenant(api, w.org, outsider)
            assert api.execute("select pulse.wa_chat(%s) r", (b["chatId"],)).fetchone()["r"] is None
            assert api.execute("select pulse.wa_chats('{}') r").fetchone()["r"]["total"] == 0
            assert api.execute("select pulse.wa_import_batches() r").fetchone()["r"] is None
    for conn in (api, worker, ingest, privacy):
        for table in ("wa_chat", "wa_message", "wa_participant", "wa_file_part", "wa_identity", "wa_import_batch"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    set_tenant(conn, w.org)
                    conn.execute(f"select count(*) from pulse_priv.{table}")
    for conn in (worker, ingest, privacy):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with conn.transaction():
                set_tenant(conn, w.org)
                conn.execute("select pulse.wa_messages(%s)", (b["chatId"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org, w.manager)
            api.execute("select pulse.wa_import_begin('{}')")


def test_client_side_people_read_only_when_member_and_opted_in(worker, owner, api):
    w, people = world(worker, owner, api)
    with owner.transaction():
        set_tenant(owner, w.org)
        poc = owner.execute("select pulse.wa_import_person(%s) id", (json.dumps({"key": "s-client1", "kind": "client", "name": "Client Contact",
                            "clientId": str(w.client), "phone": "+919000000123", "assignedTo": str(w.editor), "basis": "title names the client"}),)).fetchone()["id"]
        again = owner.execute("select pulse.wa_import_person(%s) id", (json.dumps({"key": "s-client1", "kind": "client", "name": "Other Name",
                              "clientId": str(w.client)}),)).fetchone()["id"]
        assert again == poc
        p = owner.execute("select side,status,display_name from pulse.person where id=%s", (poc,)).fetchone()
        assert (p["side"], p["status"], p["display_name"]) == ("client", "active", "Client Contact")
        assert owner.execute("select count(*) n from pulse.client_contact where client_id=%s and person_id=%s", (w.client, poc)).fetchone()["n"] == 1
        o = owner.execute("select state,assigned_to,source from pulse.client_contact_optin where person_id=%s", (poc,)).fetchone()
        assert (o["state"], o["assigned_to"], o["source"]) == ("pending", w.editor, "whatsapp_import")
        assert owner.execute("select phone_e164 from pulse_priv.person_private where person_id=%s", (poc,)).fetchone()["phone_e164"] == "+919000000123"
    with pytest.raises(psycopg.errors.InvalidParameterValue):  # a colleague is never made up
        with owner.transaction():
            set_tenant(owner, w.org)
            owner.execute("select pulse.wa_import_person(%s)", (json.dumps({"key": "s-ghost", "kind": "colleague", "name": "Nobody"}),))
    people[1]["person"] = str(poc)
    b = begin(owner, w, members=[w.editor, poc], participants=people)  # a client is never made a member by the import
    load(owner, w, b["batchId"], [msg(1, "Synthetic shared line")])
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.chat_member where channel_id=%s and person_id=%s", (b["channelId"], poc)).fetchone()["n"] == 0
        worker.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, b["channelId"], poc))
    assert page(api, w, poc, b["chatId"]) is None                      # member, still pending
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            api.execute("select pulse.client_optin_set(%s,'opted_in')", (poc,))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.client_optin_set(%s,'opted_in','Synthetic: said yes')", (poc,))
        assert api.execute("select state from pulse.client_contact_optin where person_id=%s", (poc,)).fetchone()["state"] == "opted_in"
    assert len(page(api, w, poc, b["chatId"])["messages"]) == 1          # member and opted in
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.client_optin_set(%s,'revoked')", (poc,))
    assert page(api, w, poc, b["chatId"]) is None


def test_withdrawn_batch_is_hidden_not_deleted(worker, owner, api):
    w, people = world(worker, owner, api)
    b = begin(owner, w, members=[w.editor], participants=people)
    sha, _ = put_file(owner, w, b"synthetic pdf bytes", mime="application/pdf", kind="document")
    load(owner, w, b["batchId"], [msg(1, "Synthetic quotation", kind="media", file=sha, fileName="Quote.pdf", fileState="attached", mediaType="document")])
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            api.execute("select pulse.wa_import_withdraw(%s,'Synthetic reason')", (b["batchId"],))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        assert len(api.execute("select pulse.wa_import_batches() r").fetchone()["r"]) == 1
        api.execute("select pulse.wa_import_withdraw(%s,'Synthetic: wrong group')", (b["batchId"],))
    assert page(api, w, w.editor, b["chatId"])["messages"] == []
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        assert api.execute("select pulse.wa_file_open(%s) r", (sha,)).fetchone()["r"] is None
    with owner.transaction():
        set_tenant(owner, w.org)
        assert owner.execute("select count(*) n from pulse_priv.wa_message where batch_id=%s", (b["batchId"],)).fetchone()["n"] == 1


def test_insights_follow_the_chat_and_leaders_only_read_signals_and_aggregates(worker, owner, api):
    """1016: per-message signals, transcripts and a chat's structure follow pulse.wa_reader; signals across chats and
    aggregates are for admins and leadership (a person reads their own aggregate)."""
    w, people = world(worker, owner, api)
    b = begin(owner, w, members=[w.editor], participants=people)
    voice, _ = put_file(owner, w, b"synthetic opus bytes", mime="audio/ogg", kind="voice", meta={"seconds": 4})
    load(owner, w, b["batchId"], [msg(1, "Synthetic: why are leads still not coming?", sender="s-client1"),
                                  msg(2, "", kind="media", file=voice, fileName="PTT-1.opus", fileState="attached", mediaType="voice")])
    with owner.transaction():
        set_tenant(owner, w.org)
        m1 = owner.execute("select id from pulse_priv.wa_message where chat_id=%s and seq=1", (b["chatId"],)).fetchone()["id"]
        owner.execute("""insert into pulse_priv.wa_message_signal (org_id, message_id, chat_id, intent, topics, sentiment, basis, model)
                         values (%s,%s,%s,'complaint','{leads}',-1,'model','synthetic')""", (w.org, m1, b["chatId"]))
        owner.execute("insert into pulse_priv.wa_transcript (org_id, sha256, language, text, model) values (%s,%s,'en','Synthetic spoken words','synthetic')", (w.org, voice))
        owner.execute("""insert into pulse_priv.wa_chat_stage (org_id, chat_id, stage, first_at, last_at, messages, evidence) values (%s,%s,'leads',now(),now(),1,%s)""", (w.org, b["chatId"], [m1]))
        owner.execute("""insert into pulse_priv.wa_signal (org_id, chat_id, message_id, client_id, kind, score, at, note) values (%s,%s,%s,%s,'complaint',0.8,now(),'synthetic')""",
                      (w.org, b["chatId"], m1, w.client))
        owner.execute("insert into pulse_priv.wa_insight (org_id, subject, subject_id, metrics) values (%s,'client',%s,'{\"churn_risk\": 0.4}'), (%s,'person',%s,'{\"answers\": 3}')",
                      (w.org, w.client, w.org, w.editor))
    with api.transaction():
        set_tenant(api, w.org, w.editor)  # member
        assert api.execute("select pulse.wa_transcript_read(%s) r", (voice,)).fetchone()["r"]["text"] == "Synthetic spoken words"
        ins = api.execute("select pulse.wa_chat_insights(%s) r", (b["chatId"],)).fetchone()["r"]
        assert [s["stage"] for s in ins["stages"]] == ["leads"] and ins["signals"][0]["kind"] == "complaint" and ins["sentiment"][0]["negative"] == 1
        assert api.execute("select pulse.wa_signals('{}') r").fetchone()["r"] is None          # not a leader
        assert api.execute("select pulse.wa_insight('client',%s) r", (w.client,)).fetchone()["r"] is None
        assert api.execute("select pulse.wa_insight('person',%s) r", (w.editor,)).fetchone()["r"]["metrics"]["answers"] == 3  # their own
        spoken = api.execute("select pulse.wa_search(%s,'spoken words') r", (b["chatId"],)).fetchone()["r"]  # 1019: what voice notes say
        assert [(h["transcript"], h["body"]) for h in spoken] == [(True, "Synthetic spoken words")]
        assert [h["transcript"] for h in api.execute("select pulse.wa_search(%s,'leads') r", (b["chatId"],)).fetchone()["r"]] == [False]
    with api.transaction():
        set_tenant(api, w.org, w.lead)  # leadership, not a member
        assert api.execute("select pulse.wa_chat_insights(%s) r", (b["chatId"],)).fetchone()["r"] is None
        assert api.execute("select pulse.wa_transcript_read(%s) r", (voice,)).fetchone()["r"] is None
        assert [s["kind"] for s in api.execute("select pulse.wa_signals('{}') r").fetchone()["r"]] == ["complaint"]
        assert api.execute("select pulse.wa_insight('client',%s) r", (w.client,)).fetchone()["r"]["metrics"]["churn_risk"] == 0.4
    with api.transaction():
        set_tenant(api, w.org, w.editor2)  # HR, not a member
        assert api.execute("select pulse.wa_chat_insights(%s) r", (b["chatId"],)).fetchone()["r"] is None
        assert api.execute("select pulse.wa_signals('{}') r").fetchone()["r"] is None
    for table in ("wa_message_signal", "wa_transcript", "wa_signal", "wa_insight"):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with api.transaction():
                set_tenant(api, w.org, w.manager)
                api.execute(f"select count(*) from pulse_priv.{table}")
