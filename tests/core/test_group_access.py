"""GROUP-ACCESS on real PostgreSQL (1098): who reads a company's client group conversations is an organisation setting
(members only by default; members, admins and leadership, and pod heads for their pod's groups; all staff). A reader
who is not a member browses read-only: rows open only for the one conversation a read asks for, writers stay with the
members, nothing notifies them, and "Join to post" makes them a member. DMs, pods, teams, operator chats and groups not
typed Client stay closed whatever the setting; client-side people and AI employees read nothing new. Every person,
group and file here is synthetic."""

import json
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_agent_coworkers import make_agent
from test_wa_import import begin, load, msg, put_file, world


def one(api, w, viewer, sql, args=(), browse=None):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        if browse:
            api.execute("select set_config('pulse.chat_browse', %s, true)", (str(browse),))
        return api.execute(sql, args).fetchone()


def count(api, w, viewer, table, channel, browse=None, col="channel_id"):
    return one(api, w, viewer, f"select count(*) n from pulse.{table} where {col}=%s", (channel,), browse)["n"]


def readers(api, w, viewer, value):
    return one(api, w, viewer, "select pulse.chat_group_access_set(%s) r", (value,))["r"]


def groups(world_fixture):
    """The company: an imported client group (Pod 1), a native client group (Pod 2), a private group typed internal,
    a group nobody typed, a DM, a Finance team channel and an operator chat (both typed Client, adversarially), and the
    people who read or must not read them."""
    worker, owner, api = world_fixture
    w, people = world(worker, owner, api)          # editor: staff; editor2: HR; lead: leadership; manager: admin
    with owner.transaction():
        set_tenant(owner, w.org)
        poc = owner.execute("select pulse.wa_import_person(%s) id", (json.dumps({"key": "s-client1", "kind": "client", "name": "Client Contact",
                            "clientId": str(w.client), "basis": "synthetic"}),)).fetchone()["id"]
    people[1]["person"] = str(poc)
    b = begin(owner, w, members=[w.editor2], participants=people)
    photo, _ = put_file(owner, w, b"\xff\xd8synthetic group access jpeg")
    load(owner, w, b["batchId"], [msg(1, "Synthetic brief for the tower"), msg(2, "Approved, go ahead", sender="s-client1"),
                                  msg(3, "", kind="media", file=photo, fileName="IMG-1.jpg", fileState="attached", mediaType="image", sender="s-number1")])
    g = {"wa": uuid.UUID(b["channelId"]), "photo": photo, "poc": poc}
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        g["native"] = api.execute("select pulse.chat_group_create('Sunrise Heights launch (synthetic)', %s) id", ([w.lead],)).fetchone()["id"]
        g["private"] = api.execute("select pulse.chat_group_create('HR huddle (synthetic)', %s) id", ([w.lead],)).fetchone()["id"]
        g["untyped"] = api.execute("select pulse.chat_group_create('Untyped corner (synthetic)', %s) id", ([w.lead],)).fetchone()["id"]
        g["dm"] = api.execute("select pulse.chat_direct(%s) id", (w.lead,)).fetchone()["id"]
        g["file"] = api.execute("select pulse.chat_file_add(%s,'Brief.txt','text/plain',%s) id", (g["native"], b"Synthetic brief")).fetchone()["id"]
        g["first"] = api.execute("select pulse.chat_send(%s,'Brief attached',null,%s,%s) id",
                                 (g["native"], json.dumps([{"id": str(g["file"]), "name": "Brief.txt"}]), uuid.uuid4())).fetchone()["id"]
        api.execute("select pulse.chat_send(%s,'Private synthetic note',null,'[]',%s)", (g["private"], uuid.uuid4()))
        api.execute("select pulse.chat_send(%s,'Synthetic DM',null,'[]',%s)", (g["dm"], uuid.uuid4()))
    with api.transaction():
        set_tenant(api, w.org, w.manager)          # the hub's types, as an admin sets them
        api.execute("select pulse.chat_group_set(%s, %s)", ([g["wa"]], json.dumps({"kind": "client", "pod": "Pod 1"})))
        api.execute("select pulse.chat_group_set(%s, %s)", ([g["native"]], json.dumps({"kind": "client", "pod": "Pod 2"})))
        api.execute("select pulse.chat_group_set(%s, %s)", ([g["private"]], json.dumps({"kind": "internal"})))
    with owner.transaction():
        set_tenant(owner, w.org)
        for key, name, kind in (("team:finance", "Finance", "team"), (f"operator-agent-chat:{uuid.uuid4()}", "Operator chat", "custom")):
            ch = owner.execute("insert into pulse.chat_channel(org_id,key,name,kind) values(%s,%s,%s,%s) returning id", (w.org, key, name, kind)).fetchone()["id"]
            owner.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, ch, w.editor2))
            owner.execute("insert into pulse.chat_message(org_id,channel_id,author_id,body,client_id) values(%s,%s,%s,'Synthetic closed line',%s)", (w.org, ch, w.editor2, uuid.uuid4()))
            owner.execute("insert into pulse.chat_group_info(org_id,channel_id,kind) values(%s,%s,'client')", (w.org, ch))
            g["team" if kind == "team" else "operator"] = ch
        owner.execute("insert into pulse.chat_member(org_id,channel_id,person_id) values(%s,%s,%s)", (w.org, g["wa"], poc))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.client_optin_set(%s,'opted_in','Synthetic: said yes')", (poc,))
    return w, g


CLOSED = ("private", "untyped", "dm", "team", "operator")


def test_setting_who_changes_it_and_members_only_by_default(worker, owner, api):
    w, g = groups((worker, owner, api))
    assert one(api, w, w.editor, "select pulse.chat_group_readers() r")["r"] == "members"
    # Members only: a colleague who is not a member reads nothing, even asking to browse.
    assert not one(api, w, w.editor, "select pulse.chat_browse(%s) ok", (g["wa"],))["ok"]
    assert count(api, w, w.editor, "chat_message", g["wa"], browse=g["wa"]) == 0
    assert one(api, w, w.editor, "select count(*) n from pulse.chat_client_groups()")["n"] == 0
    # Only an admin or leadership changes it; never staff, HR, an AI employee or a client-side person.
    for who in (w.editor, w.editor2, g["poc"]):
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            readers(api, w, who, "staff")
    agent, _ = make_agent(api, w, "group-reader")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with api.transaction():
            set_tenant(api, w.org, agent)
            api.execute("select set_config('pulse.agent_session','on',true)")
            api.execute("select pulse.chat_group_access_set('staff')")
    with pytest.raises(psycopg.errors.InvalidParameterValue):
        readers(api, w, w.lead, "everyone")
    assert readers(api, w, w.lead, "leaders") == "leaders"            # leadership
    assert readers(api, w, w.manager, "staff") == "staff"             # an admin
    assert readers(api, w, w.manager, "staff") == "staff"             # the same value again records nothing
    with worker.transaction():
        set_tenant(worker, w.org)
        log = worker.execute("""select old_value, new_value, changed_by from pulse.record_change
                                 where entity_type='org' and field='chat_group_readers' order by changed_at, old_value nulls first""").fetchall()
    assert [(r["old_value"], r["new_value"], r["changed_by"]) for r in log] == [("members", "leaders", w.lead), ("leaders", "staff", w.manager)]
    with pytest.raises(psycopg.errors.InsufficientPrivilege):    # nobody writes the table directly
        with api.transaction():
            set_tenant(api, w.org, w.manager)
            api.execute("update pulse.chat_group_access set readers='members'")


def test_leaders_and_pod_heads(worker, owner, api):
    w, g = groups((worker, owner, api))
    with owner.transaction():
        set_tenant(owner, w.org)                    # the editor heads Pod 1 (HR's pod heads)
        owner.execute("insert into pulse.hr_pod(org_id,name,head_id,updated_by) values(%s,'Pod 1',%s,%s)", (w.org, w.editor, w.manager))
    readers(api, w, w.manager, "leaders")
    # Leadership (not an admin, not a member) reads both client groups; the pod head only their pod's.
    for ch in ("wa", "native"):
        assert one(api, w, w.lead, "select pulse.chat_browse(%s) ok", (g[ch],))["ok"]
    assert one(api, w, w.editor, "select pulse.chat_browse(%s) ok", (g["wa"],))["ok"]
    assert not one(api, w, w.editor, "select pulse.chat_browse(%s) ok", (g["native"],))["ok"]
    assert count(api, w, w.editor, "chat_message", g["native"], browse=g["native"]) == 0
    # HR (staff, no leadership role, no pod) reads nothing new.
    for ch in ("wa", "native"):
        assert not one(api, w, w.editor2, "select pulse.chat_browse(%s) ok", (g[ch],))["ok"]
    for ch in CLOSED:
        assert not one(api, w, w.lead, "select pulse.chat_browse(%s) ok", (g[ch],))["ok"], ch


def test_all_staff_browse_read_only_and_scoped(worker, owner, api):
    w, g = groups((worker, owner, api))
    readers(api, w, w.lead, "staff")
    with worker.transaction():
        set_tenant(worker, w.org)
        notes0 = worker.execute("select count(*) n from pulse.notification where person_id=%s", (w.editor,)).fetchone()["n"]
    # The editor (staff, in neither group) reads both client groups when a read asks for that one conversation.
    for ch in ("wa", "native"):
        n = count(api, w, w.editor2, "chat_message", g[ch])      # what a member reads
        assert n >= (3 if ch == "wa" else 1)
        assert one(api, w, w.editor, "select pulse.chat_browse(%s) ok", (g[ch],))["ok"]
        assert count(api, w, w.editor, "chat_message", g[ch], browse=g[ch]) == n
        assert count(api, w, w.editor, "chat_member", g[ch], browse=g[ch]) >= 1
        assert count(api, w, w.editor, "chat_channel", g[ch], browse=g[ch], col="id") == 1
        # Scoped: without asking, or asking for another conversation, the rows stay closed (every other query unchanged).
        assert count(api, w, w.editor, "chat_message", g[ch]) == 0
        assert count(api, w, w.editor, "chat_message", g[ch], browse=g["native" if ch == "wa" else "wa"]) == 0
    assert one(api, w, w.editor, "select count(*) n from pulse.chat_guest where channel_id=%s", (g["wa"],), browse=g["wa"])["n"] == 1
    # One-object reads: the native file, the imported photo, the WhatsApp facts and people, voice state.
    assert one(api, w, w.editor, "select count(*) n from pulse.chat_file_read(%s)", (g["file"],))["n"] == 1
    assert one(api, w, w.editor, "select pulse.wa_file_open(%s) f", (g["photo"],))["f"] is not None
    assert one(api, w, w.editor, "select pulse.wa_native_channel(%s) r", (g["wa"],))["r"]["native"]
    assert len(one(api, w, w.editor, "select pulse.wa_native_people(%s) r", (g["wa"],))["r"]) >= 1
    assert one(api, w, w.editor, "select count(*) n from pulse.chat_voice_state(%s)", (g["wa"],))["n"] == 0
    # Closed whatever the setting: private, untyped, DM, the Finance team, the operator chat.
    for ch in CLOSED:
        assert not one(api, w, w.editor, "select pulse.chat_reads(%s) ok", (g[ch],))["ok"], ch
        assert count(api, w, w.editor, "chat_message", g[ch], browse=g[ch]) == 0, ch
    # Read-only: every writer stays with the members.
    for sql, args in (("select pulse.chat_send(%s,'Synthetic hello',null,'[]',%s)", (g["native"], uuid.uuid4())),
                      ("select pulse.chat_react(%s,'👍')", (g["first"],)),
                      ("select pulse.chat_read(%s, now())", (g["native"],)),
                      ("select pulse.chat_file_add(%s,'x.txt','text/plain',%s)", (g["native"], b"x"))):
        with pytest.raises((psycopg.errors.InsufficientPrivilege, psycopg.errors.InvalidParameterValue)):
            one(api, w, w.editor, sql, args, browse=g["native"])
    # A member writes; the reader is not told (not a member).
    one(api, w, w.editor2, "select pulse.chat_send(%s,'Synthetic update @editor.one',null,'[]',%s) id", (g["native"], uuid.uuid4()))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.notification where person_id=%s", (w.editor,)).fetchone()["n"] == notes0
        assert worker.execute("select count(*) n from pulse.chat_member where person_id=%s and channel_id=any(%s)", (w.editor, [g["wa"], g["native"]])).fetchone()["n"] == 0
    # Chats → Client groups and the groups hub list what the editor reads; the hub's queue and AI tables stay closed.
    listed = {r["id"]: r for r in api_rows(api, w, w.editor, "select * from pulse.chat_client_groups()")}
    assert set(listed) == {g["wa"], g["native"]} and not listed[g["wa"]]["member"] and listed[g["wa"]]["imported"]
    hub = {r["id"]: r for r in api_rows(api, w, w.editor, "select id, member, info from pulse.chat_group_hub()")}
    assert {g["wa"], g["native"]} <= set(hub) and not set(hub) & {g[ch] for ch in CLOSED}
    assert hub[g["native"]]["info"]["kind"] == "client" and not hub[g["native"]]["member"]
    seen = {r["channel_id"] for r in api_rows(api, w, w.editor, "select channel_id from pulse.chat_group_info")}
    assert {g["wa"], g["native"]} <= seen and not seen & {g[ch] for ch in CLOSED}
    # Client-side people and AI employees read nothing new.
    assert set(r["id"] for r in api_rows(api, w, g["poc"], "select * from pulse.chat_client_groups()")) == set()
    for ch in ("native", "private", "team"):
        assert not one(api, w, g["poc"], "select pulse.chat_browse(%s) ok", (g[ch],))["ok"]
        assert count(api, w, g["poc"], "chat_message", g[ch], browse=g[ch]) == 0
    agent, _ = make_agent(api, w, "group-reader")
    with api.transaction():
        set_tenant(api, w.org, agent)
        api.execute("select set_config('pulse.agent_session','on',true)")
        api.execute("select set_config('pulse.chat_browse', %s, true)", (str(g["native"]),))
        assert not api.execute("select pulse.chat_browse(%s) ok", (g["native"],)).fetchone()["ok"]
        assert api.execute("select count(*) n from pulse.chat_message where channel_id=%s", (g["native"],)).fetchone()["n"] == 0
    # Back to members only: closed again.
    readers(api, w, w.manager, "members")
    assert count(api, w, w.editor, "chat_message", g["native"], browse=g["native"]) == 0
    assert one(api, w, w.editor, "select count(*) n from pulse.chat_file_read(%s)", (g["file"],))["n"] == 0
    assert one(api, w, w.editor, "select pulse.wa_file_open(%s) f", (g["photo"],))["f"] is None


def test_join_to_post(worker, owner, api):
    w, g = groups((worker, owner, api))
    with pytest.raises(psycopg.errors.InsufficientPrivilege):          # members only: nothing to join
        one(api, w, w.editor, "select pulse.chat_group_join(%s)", (g["native"],))
    readers(api, w, w.manager, "staff")
    for ch in CLOSED:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            one(api, w, w.editor, "select pulse.chat_group_join(%s)", (g[ch],))
    one(api, w, w.editor, "select pulse.chat_group_join(%s)", (g["wa"],))
    one(api, w, w.editor, "select pulse.chat_group_join(%s)", (g["wa"],))      # again: nothing more
    with worker.transaction():
        set_tenant(worker, w.org)
        m = worker.execute("select read_through, role from pulse.chat_member where channel_id=%s and person_id=%s", (g["wa"], w.editor)).fetchone()
        last = worker.execute("select max(created_at) t from pulse.chat_message where channel_id=%s and kind<>'event'", (g["wa"],)).fetchone()["t"]
        assert m["role"] == "member" and m["read_through"] >= last         # nothing unread on joining
        assert worker.execute("select count(*) n from pulse.chat_message where channel_id=%s and kind='event' and body='joined' and author_id=%s",
                              (g["wa"], w.editor)).fetchone()["n"] == 1
    # A member now: reads without asking, writes, and is told about others' messages.
    assert count(api, w, w.editor, "chat_message", g["wa"]) >= 3
    one(api, w, w.editor, "select pulse.chat_send(%s,'Synthetic reply from the editor',null,'[]',%s) id", (g["wa"], uuid.uuid4()))
    one(api, w, w.editor2, "select pulse.chat_send(%s,'Synthetic answer',null,'[]',%s) id", (g["wa"], uuid.uuid4()))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.notification where person_id=%s and channel_id=%s", (w.editor, g["wa"])).fetchone()["n"] == 1
    assert listed_member(api, w, w.editor, g["wa"])


def api_rows(api, w, viewer, sql, args=()):
    with api.transaction():
        set_tenant(api, w.org, viewer)
        return api.execute(sql, args).fetchall()


def listed_member(api, w, viewer, channel):
    return {r["id"]: r["member"] for r in api_rows(api, w, viewer, "select * from pulse.chat_client_groups()")}.get(channel)
