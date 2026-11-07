"""VISIBLE (1065) on real PostgreSQL: the chat list reads its per-chat facts in one call (chat_list_facts,
chat_current_people) and they equal what the per-chat functions they replace give (chat_has for which chats,
chat_current for members, chat_client_facing, connect_chat_label, chat_history_count, wa_native_channel and the
viewer's own chat_member row), for a member and for an admin. Every group, person and message here is synthetic."""

import uuid

from pulse_sdk.db import set_tenant
from test_wa_import import begin, load, msg, world


def compare(api, w, viewer):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        # Times as text: a member's read point can be -infinity (psycopg reads no infinite timestamps).
        rows = api.execute("""select f.channel_id, f.member, f.my_role, f.read_through::text read_through, f.pinned_at::text pinned_at,
              f.members, f.client_facing, f.with_org, f.imported, f.whatsapp, f.client_group, pulse.chat_has(f.channel_id) has,
              (select count(*)::int from pulse.chat_member cm join pulse.person p on p.id = cm.person_id
                where cm.channel_id = f.channel_id and pulse.chat_current(p.id)) members_old,
              pulse.chat_client_facing(f.channel_id) client_facing_old, pulse.connect_chat_label(f.channel_id) with_org_old,
              pulse.chat_history_count(f.channel_id) imported_old, pulse.wa_native_channel(f.channel_id) whatsapp_old,
              (select m.read_through::text from pulse.chat_member m where m.channel_id = f.channel_id and m.person_id = %s) read_through_old
            from pulse.chat_list_facts() f""", (viewer,)).fetchall()
        visible = {r["id"] for r in api.execute("select id from pulse.chat_channel").fetchall()}
        current = {r["id"] for r in api.execute("select pulse.chat_current_people() id").fetchall()}
        expected = {r["id"] for r in api.execute("select p.id from pulse.person p where pulse.chat_current(p.id)").fetchall()}
    # Exactly the chats chat_has lets the viewer's list read: the list reads only these.
    assert {r["channel_id"] for r in rows} == visible and all(r["has"] for r in rows)
    assert current == expected
    for r in rows:
        assert r["members"] == r["members_old"], r
        assert r["client_facing"] == r["client_facing_old"], r
        assert r["with_org"] == r["with_org_old"], r
        assert r["imported"] == r["imported_old"], r
        assert r["whatsapp"] == r["whatsapp_old"], r
        assert r["read_through"] == r["read_through_old"] and r["member"] == (r["read_through_old"] is not None), r
    return {r["channel_id"]: r for r in rows}


def test_chat_list_facts_equal_the_per_chat_functions(worker, owner, api):
    w, people = world(worker, owner, api)
    gone, guest = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.manager))
        worker.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,'Synthetic Leaver','staff','inactive')", (gone, w.org))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Client Person','client')", (guest, w.org))
        pod = worker.execute("insert into pulse.chat_channel(org_id,key,name,kind) values(%s,'synthetic-list-pod','Synthetic pod','pod') returning id", (w.org,)).fetchone()["id"]
        shared = worker.execute("insert into pulse.chat_channel(org_id,key,name,kind) values(%s,'synthetic-list-client','Synthetic client chat','custom') returning id", (w.org,)).fetchone()["id"]
        alone = worker.execute("insert into pulse.chat_channel(org_id,key,name,kind) values(%s,'synthetic-list-other','Synthetic other group','custom') returning id", (w.org,)).fetchone()["id"]
        for channel, person in ((pod, w.editor), (pod, gone), (shared, w.editor), (shared, guest), (alone, w.editor2)):
            worker.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, channel, person))
    b = begin(owner, w, members=[w.editor], participants=people, clientId=str(w.client))
    load(owner, w, b["batchId"], [msg(1, "Synthetic brochure is here"), msg(2, "Thanks", sender="s-number1")])

    member = compare(api, w, w.editor)
    assert member[pod]["members"] == 1                     # the leaver is not a current member
    assert member[shared]["client_facing"] is True and member[pod]["client_facing"] is False
    assert alone not in member                              # not a member, not an admin
    wa = member[uuid.UUID(b["channelId"])]
    assert wa["whatsapp"]["native"] is True and wa["whatsapp"]["guests"] >= 1
    assert wa["client_group"] is True and member[shared]["client_group"] is False   # linked to a client record by the import

    admin = compare(api, w, w.manager)
    assert admin[alone]["member"] is False                 # an admin's list holds the company's groups (moderation)
    assert admin[uuid.UUID(b["channelId"])]["whatsapp"] is not None   # wa_reader: admins read imported groups
