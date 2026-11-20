"""SPEED-4 (2381) on real PostgreSQL: Ctrl+K's chat-message search reads pulse.chat_message_find, which applies the
message row policies once per conversation instead of once per message. It returns exactly the messages the old
row-secured query returned, newest first: the viewer's own conversations that chat_has lets them read, nothing removed,
imported history only for its readers; nothing for an admin outside the conversation or a client person. Every group,
person and message here is synthetic."""

import uuid

from pulse_sdk.db import set_tenant
from test_wa_import import begin, load, msg, world

# The query search.ts ran before 2381 (row security decides; the viewer must be a member).
OLD = """select msg.id from pulse.chat_message msg join pulse.chat_channel ch on ch.id = msg.channel_id
  join pulse.chat_member m on m.channel_id = msg.channel_id and m.person_id = %s
  where msg.removed_at is null and (msg.body ilike %s or msg.body ilike %s) order by msg.created_at desc limit 50"""
PATS = ["%synthetic office%", "%keys%"]


def found(api, w, viewer):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        old = [r["id"] for r in api.execute(OLD, (viewer, *PATS)).fetchall()]
        new = [r["id"] for r in api.execute("select id from pulse.chat_message_find(%s::text[], 50)", (PATS,)).fetchall()]
        none = api.execute("select count(*) n from pulse.chat_message_find(%s::text[], 50)", ([],)).fetchone()["n"]
    assert new == old, (new, old)
    assert none == 0
    return new


def test_message_search_finds_what_row_security_allowed(worker, owner, api):
    w, people = world(worker, owner, api)
    guest = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.manager))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Client Person','client')", (guest, w.org))
        pod = worker.execute("insert into pulse.chat_channel(org_id,key,name,kind) values(%s,'synthetic-search-pod','Synthetic pod','pod') returning id", (w.org,)).fetchone()["id"]
        alone = worker.execute("insert into pulse.chat_channel(org_id,key,name,kind) values(%s,'synthetic-search-other','Synthetic other group','custom') returning id", (w.org,)).fetchone()["id"]
        for channel, person in ((pod, w.editor), (pod, guest), (alone, w.editor2)):
            worker.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, channel, person))
        ids = {}
        for name, channel, body, minute, removed in (("keys", pod, "Synthetic office keys are at the desk", 1, False),
                                                     ("gone", pod, "Synthetic office plan (removed)", 2, True),
                                                     ("lunch", pod, "Lunch at one?", 3, False),
                                                     ("where", pod, "Where are the KEYS now", 4, False),
                                                     ("secret", alone, "Synthetic office for the other group", 5, False)):
            ids[name] = worker.execute(
                "insert into pulse.chat_message(org_id,channel_id,author_id,client_id,body,created_at,removed_at) values(%s,%s,%s,%s,%s,%s,%s) returning id",
                (w.org, channel, w.editor if channel == pod else w.editor2, uuid.uuid4(), body, f"2026-11-1{minute} 10:00:00+00",
                 f"2026-11-1{minute} 11:00:00+00" if removed else None)).fetchone()["id"]
    # Imported WhatsApp history in a group the editor is a member of (import_ref set: imported_read applies).
    b = begin(owner, w, members=[w.editor], participants=people, clientId=str(w.client))
    load(owner, w, b["batchId"], [msg(1, "Synthetic office brochure is here"), msg(2, "Thanks", sender="s-number1")])

    editor = found(api, w, w.editor)
    assert ids["where"] in editor and ids["keys"] in editor          # both words, any case
    assert ids["gone"] not in editor and ids["lunch"] not in editor   # removed; no word
    assert ids["secret"] not in editor                                 # not their conversation
    assert editor.index(ids["where"]) < editor.index(ids["keys"])     # newest first
    assert len(editor) == 3                                            # + the imported brochure line

    assert found(api, w, w.editor2) == [ids["secret"]]
    assert found(api, w, w.manager) == []                              # an admin outside the conversation: as before
    assert found(api, w, guest) == []                                  # a client person: chat_has is false
