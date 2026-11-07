"""CHATS-2 on real PostgreSQL: groups people make, quote replies, edit/delete windows, pins, delivered receipts, task
cards that follow a task into a chat, and presence derived from Pulse data. All people and messages are synthetic."""

import json
import uuid

import psycopg
import pytest
from pulse_sdk.db import set_tenant
from test_chats import setup


def send(api, channel, body, quote=None, attachments="[]"):
    return api.execute(
        "select pulse.chat_send(%s,%s,null,%s,%s,%s) id",
        (channel, body, attachments, uuid.uuid4(), quote),
    ).fetchone()["id"]


def test_groups_people_make_survive_refresh_and_only_admins_change_them(worker, owner, api):
    w = setup(worker, owner, api)
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        group = api.execute(
            "select pulse.chat_group_create('  Launch   crew ',%s) id", ([w.editor2, w.lead],)
        ).fetchone()["id"]
        row = api.execute("select name,kind,created_by from pulse.chat_channel where id=%s", (group,)).fetchone()
        assert row == {"name": "Launch crew", "kind": "custom", "created_by": w.editor}
        roles = {r["person_id"]: r["role"] for r in api.execute("select person_id,role from pulse.chat_member where channel_id=%s", (group,))}
        assert roles == {w.editor: "admin", w.editor2: "member", w.lead: "member"}
        # "created the group" is an event line: it is in the conversation and nobody is notified.
        line = api.execute("select kind,body from pulse.chat_message where channel_id=%s", (group,)).fetchone()
        assert line == {"kind": "event", "body": "created the group “Launch crew”"}
        api.execute("select pulse.chat_refresh()")
        assert api.execute("select count(*) n from pulse.chat_member where channel_id=%s", (group,)).fetchone()["n"] == 3
        api.execute("select pulse.chat_group_photo(%s,'image/png',%s)", (group, b"\x89PNG synthetic"))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.chat_group_members(%s,%s,%s)", (group, [w.manager], [w.lead]))
    with worker.transaction():
        set_tenant(worker, w.org)
        assert worker.execute("select count(*) n from pulse.notification where channel_id=%s", (group,)).fetchone()["n"] == 0
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.chat_group_update(%s,'Taken over','')", (group,))
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert api.execute("select * from pulse.chat_group_photo_read(%s)", (group,)).fetchall() == []
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        assert api.execute("select bytes from pulse.chat_group_photo_read(%s)", (group,)).fetchone()["bytes"] == b"\x89PNG synthetic"
        message = send(api, group, "Synthetic plan for the week")
    with worker.transaction():
        set_tenant(worker, w.org)
        notified = {r["person_id"] for r in worker.execute("select person_id from pulse.notification where message_id=%s", (message,))}
        assert notified == {w.editor, w.manager}
    # The admin leaves: the longest-standing member becomes admin, so the group is never orphaned.
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.chat_group_leave(%s)", (group,))
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        assert api.execute("select role from pulse.chat_member where channel_id=%s and person_id=%s", (group, w.editor2)).fetchone()["role"] == "admin"
        assert api.execute("select pulse.chat_group_admin(%s) ok", (group,)).fetchone()["ok"] is True


def test_quotes_windows_pins_and_receipts(worker, owner, api):
    w = setup(worker, owner, api)
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        dm = api.execute("select pulse.chat_direct(%s) id", (w.editor2,)).fetchone()["id"]
        other = api.execute("select pulse.chat_direct(%s) id", (w.lead,)).fetchone()["id"]
        first = send(api, dm, "Synthetic question?")
        elsewhere = send(api, other, "Synthetic elsewhere")
    with api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.chat_delivered()")
        answer = send(api, dm, "Synthetic answer", quote=first)
        assert api.execute("select quote_id from pulse.chat_message where id=%s", (answer,)).fetchone()["quote_id"] == first
    with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
        set_tenant(api, w.org, w.editor2)
        send(api, dm, "Synthetic cross-quote", quote=elsewhere)
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        n = api.execute("select title,kind from pulse.notification where message_id=%s", (answer,)).fetchone()
        assert n == {"title": "You have a reply in Chats", "kind": "reply"}
        receipt = api.execute("select delivered_through from pulse.chat_receipt where channel_id=%s and person_id=%s", (dm, w.editor2)).fetchone()
        assert receipt is not None
        for _ in range(2):
            api.execute("select pulse.chat_pin(%s,true)", (dm,))
        assert api.execute("select pinned_at is not null p from pulse.chat_member where channel_id=%s and person_id=%s", (dm, w.editor)).fetchone()["p"]
    with api.transaction():
        set_tenant(api, w.org, w.lead)
        assert api.execute("select * from pulse.chat_receipt where channel_id=%s", (dm,)).fetchall() == []
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.chat_message set created_at=now()-interval '16 minutes' where id=%s", (first,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="15 minutes"), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.chat_edit(%s,'Too late')", (first,))
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("update pulse.chat_message set created_at=now()-interval '49 hours' where id=%s", (first,))
    with pytest.raises(psycopg.errors.InvalidParameterValue, match="48 hours"), api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.chat_remove(%s,'Too late')", (first,))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        api.execute("select pulse.chat_react(%s,'🙏')", (answer,))


def test_task_cards_and_updates_follow_a_task_into_its_chat(worker, owner, api):
    w = setup(worker, owner, api)
    task, private, outsider = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Other Pod Person','staff')", (outsider, w.org))
        worker.execute(
            "insert into pulse.task(id,org_id,title,owner_id,assignee_person_id,created_by,status) values(%s,%s,'Synthetic reel cut',%s,%s,%s,'open')",
            (task, w.org, w.editor, w.editor2, w.editor),
        )
        worker.execute(
            "insert into pulse.task(id,org_id,title,owner_id,assignee_person_id,created_by,status) values(%s,%s,'Synthetic private',%s,%s,%s,'open')",
            (private, w.org, outsider, outsider, outsider),
        )
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        dm = api.execute("select pulse.chat_direct(%s) id", (w.editor2,)).fetchone()["id"]
        send(api, dm, "#Synthetic reel cut", attachments=json.dumps([{"task": str(task), "name": "Synthetic reel cut"}]))
        api.execute("select pulse.chat_task_follow_set(%s,%s,true)", (task, dm))
    with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
        set_tenant(api, w.org, w.editor)
        send(api, dm, "#Synthetic private", attachments=json.dumps([{"task": str(private), "name": "Synthetic private"}]))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), api.transaction():
        set_tenant(api, w.org, w.editor2)
        api.execute("select pulse.chat_task_follow_set(%s,%s,true)", (private, dm))
    with worker.transaction():
        set_tenant(worker, w.org, w.editor2)
        worker.execute("update pulse.task set status='in_progress' where id=%s", (task,))
        worker.execute("update pulse.task set title='Synthetic renamed' where id=%s", (task,))
    with api.transaction():
        set_tenant(api, w.org, w.editor)
        lines = api.execute("select author_id,body,attachments from pulse.chat_message where channel_id=%s and kind='event'", (dm,)).fetchall()
        assert len(lines) == 1
        assert lines[0]["author_id"] == w.editor2
        assert lines[0]["body"] == "moved “Synthetic reel cut” to In progress"
        assert lines[0]["attachments"][0]["task"] == str(task)
        assert api.execute("select count(*) n from pulse.notification where channel_id=%s and person_id=%s", (dm, w.editor)).fetchone()["n"] == 0


def test_presence_states_custom_status_and_do_not_disturb(worker, owner, api):
    w = setup(worker, owner, api)
    third = uuid.uuid4()
    with worker.transaction():
        set_tenant(worker, w.org)
        worker.execute("insert into pulse.person(id,org_id,display_name,side) values(%s,%s,'Shoot Person','staff')", (third, w.org))
        today = "(now() at time zone 'Asia/Kolkata')::date"
        worker.execute(f"insert into pulse.attendance_entry(org_id,person_id,work_date,mode) values(%s,%s,{today},'office')", (w.org, w.editor))
        entry = worker.execute(f"insert into pulse.attendance_entry(org_id,person_id,work_date,mode) values(%s,%s,{today},'wfh') returning id", (w.org, w.editor2)).fetchone()["id"]
        worker.execute("insert into pulse.attendance_break(org_id,entry_id,person_id) values(%s,%s,%s)", (w.org, entry, w.editor2))
        worker.execute(f"insert into pulse.attendance_entry(org_id,person_id,work_date,mode) values(%s,%s,{today},'field')", (w.org, third))
        worker.execute(f"insert into pulse.task(id,org_id,title,assignee_person_id,status,deliverable_type,work_on) values(%s,%s,'Synthetic shoot',%s,'open','Video shoot',{today})", (uuid.uuid4(), w.org, third))
        worker.execute(f"insert into pulse.leave_request(org_id,person_id,from_date,to_date,leave_kind,status) values(%s,%s,{today},{today},'sick','approved')", (w.org, w.lead))
        # Yesterday's check-in that nobody closed is not "in the office" today; leave wins.
        worker.execute(f"insert into pulse.attendance_entry(org_id,person_id,work_date,checked_in_at,mode) values(%s,%s,{today}-1,now()-interval '30 hours','office')", (w.org, w.lead))
    with api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.presence_touch()")
        api.execute("select pulse.presence_set('In a client meeting','🤝',now()+interval '1 hour','infinity')")
        states = {r["person_id"]: r for r in api.execute("select * from pulse.presence_of()")}
        assert states[w.editor]["state"] == "office"
        assert states[w.editor2]["state"] == "break"
        assert states[third]["state"] == "shoot"
        assert states[w.lead]["state"] == "leave"
        me = states[w.manager]
        assert (me["state"], me["status_text"], me["status_emoji"], me["dnd"]) == ("active", "In a client meeting", "🤝", True)
        # Colleagues see only the category: no check-in time and no kind of leave.
        assert set(states[w.lead]) == {"person_id", "state", "active_at", "status_text", "status_emoji", "status_until", "dnd"}
        api.execute("select pulse.presence_set(null,null,null,null)")
        assert api.execute("select dnd,status_text from pulse.presence_of(%s)", ([w.manager],)).fetchone() == {"dnd": False, "status_text": None}
        settings = api.execute("select settings from pulse.companion_notification_settings where person_id=%s", (w.manager,)).fetchone()["settings"]
        assert "dnd" not in settings and "snoozedUntil" not in settings
    with pytest.raises(psycopg.errors.InvalidParameterValue), api.transaction():
        set_tenant(api, w.org, w.manager)
        api.execute("select pulse.presence_set(%s,null,null,null)", ("x" * 81,))
