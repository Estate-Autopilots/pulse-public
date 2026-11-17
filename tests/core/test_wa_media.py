"""WA-MEDIA on real PostgreSQL (1100): what a file of an imported WhatsApp chat shows or says, the figures it carries and
the creative library follow the read rules: a file's facts for whoever may open the file (the chat's members and
admins), a chat's list for its readers, the library and figures across chats for admins and leadership and otherwise
only from chats the viewer reads; search finds files by what they show. Every group, name, number and file here is
synthetic."""

import json

from pulse_sdk.db import set_tenant
from test_wa_import import begin, load, msg, put_file, world


def ids(owner, w, chat, *keys):
    with owner.transaction():
        set_tenant(owner, w.org)
        return [owner.execute("select id from pulse_priv.wa_message where chat_id=%s and import_key=%s", (chat, k)).fetchone()["id"] for k in keys]


def seed(owner, w, chat, sha, photo_msg, reply_msg):
    with owner.transaction():
        set_tenant(owner, w.org)
        owner.execute("""insert into pulse_priv.wa_media (org_id, sha256, kind, class, subclass, alt_text, summary, visible_text, languages, facts,
                           quality_issues, sensitive, confidence, model, version)
                         values (pulse.current_org(), %s, 'image', 'payment_screenshot', 'UPI payment', 'Payment of 15,000 rupees to Synthetic Ads',
                           'Ad funds top-up for the synthetic campaign', 'Paid to Synthetic Ads Private Limited', '{en}',
                           '{"payment": {"amount_inr": 15000, "method": "upi"}}', '{cropped}', '{}', 0.9, 'synthetic', 'v1')""", (sha,))
        owner.execute("""insert into pulse_priv.wa_media_figure (org_id, sha256, chat_id, message_id, client_id, kind, amount, unit, at, stated_date, label,
                           status, method, source)
                         values (pulse.current_org(), %s, %s, %s, %s, 'ad_funds', 15000, 'inr', '2026-10-12T03:31:00Z', true, 'Synthetic top-up',
                           'success', 'upi', 'image')""", (sha, chat, photo_msg, w.client))
        owner.execute("""insert into pulse_priv.wa_creative (org_id, chat_id, message_id, sha256, client_id, sent_at, sender_side, kind, class, headline,
                           series, version_no, versions, status, approvals, changes, client_replies, first_reply_minutes, feedback)
                         values (pulse.current_org(), %s, %s, %s, %s, '2026-10-12T03:31:00Z', 'team', 'image', 'ad_creative', 'Synthetic headline',
                           'series-1', 1, 2, 'approved', 1, 0, 1, 1, array[%s]::uuid[])""", (chat, photo_msg, sha, w.client, reply_msg))


def read(api, w, viewer, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute(sql, args).fetchall()


def test_media_facts_follow_the_file_and_the_chat(worker, owner, api):
    w, people = world(worker, owner, api)
    b = begin(owner, w, members=[w.editor], participants=people)
    photo, _ = put_file(owner, w, b"\xff\xd8synthetic media jpeg")
    m1, m2 = msg(1, "", kind="media", file=photo, fileName="IMG-1.jpg", fileState="attached", mediaType="image"), msg(2, "Approved", sender="s-client1")
    load(owner, w, b["batchId"], [m1, m2])
    photo_msg, reply_msg = ids(owner, w, b["chatId"], m1["key"], m2["key"])
    seed(owner, w, b["chatId"], photo, photo_msg, reply_msg)

    # A member: the chat's list (keyed by the Pulse message), the file's details, search, library and figures.
    rows = read(api, w, w.editor, "select * from pulse.wa_native_media(%s)", (b["channelId"],))
    assert len(rows) == 1 and rows[0]["sha256"] == photo and rows[0]["class"] == "payment_screenshot"
    assert rows[0]["figures"][0]["kind"] == "ad_funds" and float(rows[0]["figures"][0]["amount"]) == 15000
    assert rows[0]["creative"]["status"] == "approved" and rows[0]["quality"] == ["cropped"]
    native = read(api, w, w.editor, "select id from pulse.chat_message where channel_id=%s and import_ref=%s", (b["channelId"], photo_msg))[0]["id"]
    assert rows[0]["message_id"] == native
    about = read(api, w, w.editor, "select pulse.wa_media_read(%s) r", (photo,))[0]["r"]
    assert about["summary"].startswith("Ad funds") and about["text"].startswith("Paid to") and about["facts"]["payment"]["method"] == "upi"
    assert about["figures"][0]["statedDate"] and about["creative"]["versions"] == 2
    hits = read(api, w, w.editor, "select * from pulse.wa_media_search(%s, 8)", (["synthetic ads", "nothing-like-this"],))
    assert [h["message_id"] for h in hits] == [native] and str(hits[0]["channel_id"]) == str(b["channelId"])
    assert read(api, w, w.editor, "select * from pulse.wa_media_search(%s, 8)", (["nothing-like-this"],)) == []
    lib = read(api, w, w.editor, "select pulse.wa_creatives(%s) r", ('{"client": "%s"}' % w.client,))[0]["r"]
    reply_native = read(api, w, w.editor, "select id from pulse.chat_message where import_ref=%s", (reply_msg,))[0]["id"]
    assert len(lib) == 1 and lib[0]["messageId"] == str(native) and lib[0]["feedback"] == [str(reply_native)] and lib[0]["alt"].startswith("Payment")
    figs = read(api, w, w.editor, "select pulse.wa_media_figures(%s) r", ('{"client": "%s", "kind": "ad_funds"}' % w.client,))[0]["r"]
    assert len(figs) == 1 and figs[0]["label"] == "Synthetic top-up" and figs[0]["messageId"] == str(native)
    assert read(api, w, w.editor, "select pulse.wa_media_figures(%s) r", ('{"kind": "invoice"}',))[0]["r"] == []

    # A colleague who is not a member (HR): nothing. Leadership: the library and figures, not the file's own details.
    assert read(api, w, w.editor2, "select * from pulse.wa_native_media(%s)", (b["channelId"],)) == []
    assert read(api, w, w.editor2, "select pulse.wa_media_read(%s) r", (photo,))[0]["r"] is None
    assert read(api, w, w.editor2, "select * from pulse.wa_media_search(%s, 8)", (["synthetic"],)) == []
    assert read(api, w, w.editor2, "select pulse.wa_creatives('{}') r")[0]["r"] == []
    assert read(api, w, w.editor2, "select pulse.wa_media_figures('{}') r")[0]["r"] == []
    assert len(read(api, w, w.lead, "select pulse.wa_creatives('{}') r")[0]["r"]) == 1
    assert len(read(api, w, w.lead, "select pulse.wa_media_figures('{}') r")[0]["r"]) == 1
    assert read(api, w, w.lead, "select pulse.wa_media_read(%s) r", (photo,))[0]["r"] is None
    # An admin who is not a member reads the file as the import's rules allow.
    assert read(api, w, w.manager, "select pulse.wa_media_read(%s) r", (photo,))[0]["r"]["class"] == "payment_screenshot"
    # The tables themselves are closed to the runtime roles.
    for role in (api, worker):
        with role.transaction():
            set_tenant(role, w.org, w.manager)
            role.execute("savepoint s")
            try:
                role.execute("select count(*) from pulse_priv.wa_media")
                raise AssertionError("runtime role read pulse_priv.wa_media")
            except Exception as e:  # noqa: BLE001 - permission denied is the point
                assert "permission denied" in str(e)
                role.execute("rollback to savepoint s")


def test_client_side_person_sees_media_only_when_opted_in(worker, owner, api):
    w, people = world(worker, owner, api)
    b = begin(owner, w, members=[w.editor], participants=people)
    photo, _ = put_file(owner, w, b"\xff\xd8synthetic optin jpeg")
    m1, m2 = msg(1, "", kind="media", file=photo, fileName="IMG-2.jpg", fileState="attached", mediaType="image"), msg(2, "Looks fine", sender="s-client1")
    load(owner, w, b["batchId"], [m1, m2])
    seed(owner, w, b["chatId"], photo, *ids(owner, w, b["chatId"], m1["key"], m2["key"]))
    with owner.transaction():
        set_tenant(owner, w.org)
        client_person = owner.execute("select pulse.wa_import_person(%s) id", (json.dumps({"key": "s-client9", "kind": "client", "name": "Synthetic Client",
                                      "clientId": str(w.client), "basis": "synthetic"}),)).fetchone()["id"]
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, b["channelId"], client_person))
    assert read(api, w, client_person, "select * from pulse.wa_native_media(%s)", (b["channelId"],)) == []
    assert read(api, w, client_person, "select pulse.wa_media_read(%s) r", (photo,))[0]["r"] is None
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.client_optin_set(%s,'opted_in','Synthetic: said yes')", (client_person,))
    assert len(read(api, w, client_person, "select * from pulse.wa_native_media(%s)", (b["channelId"],))) == 1
    assert read(api, w, client_person, "select pulse.wa_media_read(%s) r", (photo,))[0]["r"]["alt"].startswith("Payment")
