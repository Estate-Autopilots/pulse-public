"""SPEED-5 (2395) on real PostgreSQL: the chat list reads its conversations' own columns through
pulse.chat_list_channels, which applies chat_has's rule once for the list instead of chat_channel's row policy once per
conversation. It returns exactly the rows and columns the row-secured chat_channel gives the API role: a member's own
conversations (groups and direct chats), an admin's every group but not other people's direct chats, nothing for a
client person, a person who left, or a viewer of another company. Every group and person here is synthetic."""

import uuid

from pulse_sdk.db import set_tenant
from test_wa_import import begin, load, msg, world

COLS = "id, org_id, key, name, kind, description, address, photo_at"


def same(api, org, viewer):
    with api.transaction():
        set_tenant(api, org, viewer)
        old = api.execute(f"select {COLS} from pulse.chat_channel order by id").fetchall()
        new = api.execute(f"select {COLS} from pulse.chat_list_channels() order by id").fetchall()
        facts = {r["channel_id"] for r in api.execute("select channel_id from pulse.chat_list_facts()").fetchall()}
    assert new == old, (new, old)
    assert {r["id"] for r in new} == facts                  # the very conversations the list's facts chose
    return {r["id"] for r in new}


def test_chat_list_channels_equal_the_row_secured_channels(worker, owner, api):
    w, people = world(worker, owner, api)
    gone, guest = uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.role_assignment(org_id,person_id,role_key,valid_from) values(%s,%s,'admin','2020-01-01')", (w.org, w.manager))
        worker.execute("insert into pulse.person(id,org_id,display_name,side,status) values(%s,%s,'Synthetic Leaver','staff','inactive')", (gone, w.org))
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Synthetic Client Person','client')", (guest, w.org))
        pod = worker.execute("insert into pulse.chat_channel(org_id,key,name,kind,description) values(%s,'synthetic-cols-pod','Synthetic pod','pod','Pod talk') returning id", (w.org,)).fetchone()["id"]
        shared = worker.execute("insert into pulse.chat_channel(org_id,key,name,kind) values(%s,'synthetic-cols-client','Synthetic client chat','custom') returning id", (w.org,)).fetchone()["id"]
        alone = worker.execute("insert into pulse.chat_channel(org_id,key,name,kind) values(%s,'synthetic-cols-other','Synthetic other group','custom') returning id", (w.org,)).fetchone()["id"]
        for channel, person in ((pod, w.editor), (pod, gone), (shared, w.editor), (shared, guest), (alone, w.editor2)):
            worker.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, channel, person))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        direct = api.execute("select pulse.chat_direct(%s) id", (w.editor2,)).fetchone()["id"]
    b = begin(owner, w, members=[w.editor], participants=people, clientId=str(w.client))
    load(owner, w, b["batchId"], [msg(1, "Synthetic brochure is here")])
    imported = uuid.UUID(b["channelId"])

    editor = same(api, w.org, w.editor)
    assert {pod, shared, direct, imported} <= editor and alone not in editor
    editor2 = same(api, w.org, w.editor2)
    assert {alone, direct} <= editor2 and pod not in editor2
    admin = same(api, w.org, w.manager)
    assert {pod, shared, alone, imported} <= admin and direct not in admin   # moderation: groups, never others' DMs
    assert same(api, w.org, guest) == set()                                  # a client person: chat_has is false
    assert same(api, w.org, gone) == set()                                   # a person who left
    other, _ = world(worker, owner, api)
    assert not same(api, other.org, other.editor) & (editor | admin)        # another company sees none of these
